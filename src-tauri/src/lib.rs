// SPDX-License-Identifier: GPL-3.0-or-later

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::Manager;
#[cfg(target_os = "macos")]
use tauri::{
    menu::{Menu, MenuItem},
    AppHandle, Emitter, Runtime,
};

mod clipboard;
mod mcp;
mod workspace;
pub use mcp::run_mcp_stdio;

const PREFERENCES_FILE_NAME: &str = "sodilaud-preferences.json";

#[cfg(target_os = "macos")]
const NATIVE_ABOUT_MENU_ID: &str = "sodilaud-native-about";
#[cfg(target_os = "macos")]
const OPEN_ABOUT_EVENT: &str = "sodilaud-open-about";

#[derive(serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AppPreferences {
    last_workspace: Option<String>,
}

fn read_preferences(path: &Path) -> Result<Option<AppPreferences>, String> {
    match fs::read(path) {
        Ok(contents) => serde_json::from_slice(&contents)
            .map(Some)
            .map_err(|e| format!("Could not parse native preferences: {e}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Could not read native preferences: {error}")),
    }
}

fn write_preferences(path: &Path, preferences: &AppPreferences) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Native preferences path has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("Could not create native preferences directory: {e}"))?;
    let contents = serde_json::to_vec_pretty(preferences)
        .map_err(|e| format!("Could not serialize native preferences: {e}"))?;
    fs::write(path, contents).map_err(|e| format!("Could not write native preferences: {e}"))?;
    restrict_to_owner(path)
}

fn load_workspace_preference_from(
    path: &Path,
    legacy_path: Option<String>,
) -> Result<Option<String>, String> {
    if let Some(preferences) = read_preferences(path)? {
        return Ok(preferences.last_workspace);
    }

    // The legacy value comes from the webview, so it may only name a workspace
    // that already exists; it must never become a way to create a file.
    let migrated_path = legacy_path.filter(|value| !value.is_empty() && Path::new(value).is_file());
    write_preferences(
        path,
        &AppPreferences {
            last_workspace: migrated_path.clone(),
        },
    )?;
    Ok(migrated_path)
}

fn preferences_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join(PREFERENCES_FILE_NAME))
        .map_err(|e| format!("Could not resolve native preferences directory: {e}"))
}

#[tauri::command]
fn load_workspace_preference(
    app: tauri::AppHandle,
    workspaces: tauri::State<'_, workspace::Workspaces>,
    legacy_path: Option<String>,
) -> Result<Option<String>, String> {
    let restored = load_workspace_preference_from(&preferences_path(&app)?, legacy_path)?;
    if let Some(path) = &restored {
        workspaces.authorize(PathBuf::from(path))?;
    }
    Ok(restored)
}

#[tauri::command]
fn set_last_workspace(
    app: tauri::AppHandle,
    workspaces: tauri::State<'_, workspace::Workspaces>,
    db_path: Option<String>,
) -> Result<(), String> {
    if let Some(path) = &db_path {
        workspaces.require(path)?;
    }
    write_preferences(
        &preferences_path(&app)?,
        &AppPreferences {
            last_workspace: db_path,
        },
    )
}

// Note struct representation matching frontend note
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Note {
    id: String,
    title: String,
    content: String,
    updated_at: i64,
    is_title_locked: bool,
    #[serde(default)]
    is_pinned: bool,
    #[serde(default)]
    folder_id: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub(crate) struct Folder {
    id: String,
    name: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrashEntry {
    id: String,
    note: Note,
    deleted_at: i64,
    folder_name: Option<String>,
}

/// Restrict a file to its owner. SQLite creates databases 0644 minus umask, which
/// leaves note content readable by every local user; a clipboard history must not be.
fn restrict_to_owner(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("Could not restrict permissions on {}: {e}", path.display()))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// Opens a workspace owner-only with `secure_delete` on, so replaced and deleted
/// note bodies are overwritten instead of lingering in free pages. That makes
/// bulk saves slower, which is deliberate for a store that may hold secrets.
fn open_workspace_db(db_path: &str) -> Result<rusqlite::Connection, String> {
    let conn = rusqlite::Connection::open(db_path).map_err(|e| e.to_string())?;
    let path = Path::new(db_path);
    restrict_to_owner(path)?;
    for suffix in ["-wal", "-shm", "-journal"] {
        let sibling = PathBuf::from(format!("{db_path}{suffix}"));
        if sibling.exists() {
            restrict_to_owner(&sibling)?;
        }
    }
    conn.pragma_update(None, "secure_delete", "ON")
        .map_err(|e| format!("Could not enable secure_delete: {e}"))?;
    ensure_workspace_schema(&conn)?;
    Ok(conn)
}

/// Drops free pages that predate `secure_delete`. `VACUUM` cannot run inside a
/// transaction, so it runs on a fresh connection.
fn vacuum_workspace_at(db_path: &str) -> Result<(), String> {
    open_workspace_db(db_path)?
        .execute_batch("VACUUM")
        .map_err(|e| format!("Could not reclaim workspace space: {e}"))
}

fn ensure_workspace_schema(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS trash (id TEXT PRIMARY KEY, entry TEXT NOT NULL)",
        [],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS notes (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            updatedAt INTEGER NOT NULL,
            isTitleLocked INTEGER NOT NULL,
            isPinned INTEGER NOT NULL DEFAULT 0,
            folderId TEXT,
            sortOrder INTEGER NOT NULL DEFAULT 0
        )",
        [],
    )
    .map_err(|e| e.to_string())?;

    let has_sort_order: bool = conn
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM pragma_table_info('notes') WHERE name = 'sortOrder'
            )",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    if !has_sort_order {
        conn.execute(
            "ALTER TABLE notes ADD COLUMN sortOrder INTEGER NOT NULL DEFAULT 0",
            [],
        )
        .map_err(|e| e.to_string())?;
    }

    let has_is_pinned: bool = conn
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM pragma_table_info('notes') WHERE name = 'isPinned'
            )",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    if !has_is_pinned {
        conn.execute(
            "ALTER TABLE notes ADD COLUMN isPinned INTEGER NOT NULL DEFAULT 0",
            [],
        )
        .map_err(|e| e.to_string())?;
    }

    let has_folder_id: bool = conn
        .query_row(
            "SELECT EXISTS(
                SELECT 1 FROM pragma_table_info('notes') WHERE name = 'folderId'
            )",
            [],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;

    if !has_folder_id {
        conn.execute("ALTER TABLE notes ADD COLUMN folderId TEXT", [])
            .map_err(|e| e.to_string())?;
    }

    conn.execute(
        "CREATE TABLE IF NOT EXISTS folders (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            sortOrder INTEGER NOT NULL DEFAULT 0
        )",
        [],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn save_file_native(content: String, default_name: String) -> Result<String, String> {
    let file_path = rfd::FileDialog::new()
        .set_file_name(&default_name)
        .add_filter("Markdown", &["md"])
        .save_file();

    if let Some(path) = file_path {
        let mut file = File::create(&path).map_err(|e| e.to_string())?;
        file.write_all(content.as_bytes())
            .map_err(|e| e.to_string())?;
        Ok(path.to_string_lossy().to_string())
    } else {
        Err("Cancelled".to_string())
    }
}

#[derive(serde::Serialize)]
struct ImportedFile {
    title: String,
    content: String,
}

#[tauri::command]
fn import_file_native() -> Result<Option<ImportedFile>, String> {
    let file_path = rfd::FileDialog::new().pick_file();

    if let Some(path) = file_path {
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("Imported Note")
            .to_string();

        let title = if let Some(idx) = name.rfind('.') {
            if idx > 0 {
                name[..idx].to_string()
            } else {
                name.clone()
            }
        } else {
            name.clone()
        };

        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => {
                rfd::MessageDialog::new()
                    .set_title("Unsupported File Format")
                    .set_description(format!(
                        "The file \"{}\" could not be opened because it is not a valid text file.\n\nOnly text-encoded files (Markdown, source code, config files, plain text) can be imported into Sodilaud.",
                        name
                    ))
                    .set_buttons(rfd::MessageButtons::Ok)
                    .show();
                return Ok(None);
            }
        };
        Ok(Some(ImportedFile { title, content }))
    } else {
        Ok(None)
    }
}

// Database commands
#[tauri::command]
fn select_db_file(
    workspaces: tauri::State<'_, workspace::Workspaces>,
) -> Result<Option<String>, String> {
    const OPEN_EXISTING: &str = "Open Existing Workspace";
    const CREATE_NEW: &str = "Create New Workspace";
    const CANCEL: &str = "Cancel";

    let choice = rfd::MessageDialog::new()
        .set_title("Choose a Sodilaud Workspace")
        .set_description("Open an existing Sodilaud workspace, or create a new one.")
        .set_buttons(rfd::MessageButtons::YesNoCancelCustom(
            OPEN_EXISTING.to_string(),
            CREATE_NEW.to_string(),
            CANCEL.to_string(),
        ))
        .show();

    let file_path = match choice {
        rfd::MessageDialogResult::Custom(action) if action == OPEN_EXISTING => {
            rfd::FileDialog::new()
                .set_title("Open Sodilaud Workspace")
                .add_filter("Sodilaud Workspace", &["db", "sqlite"])
                .pick_file()
        }
        rfd::MessageDialogResult::Custom(action) if action == CREATE_NEW => rfd::FileDialog::new()
            .set_title("Create Sodilaud Workspace")
            .set_file_name("sodilaud.db")
            .add_filter("Sodilaud Workspace", &["db", "sqlite"])
            .save_file(),
        // These fallbacks preserve the intended behavior on any native backend
        // that reports standard results for custom-labeled buttons.
        rfd::MessageDialogResult::Yes => rfd::FileDialog::new()
            .set_title("Open Sodilaud Workspace")
            .add_filter("Sodilaud Workspace", &["db", "sqlite"])
            .pick_file(),
        rfd::MessageDialogResult::No => rfd::FileDialog::new()
            .set_title("Create Sodilaud Workspace")
            .set_file_name("sodilaud.db")
            .add_filter("Sodilaud Workspace", &["db", "sqlite"])
            .save_file(),
        _ => None,
    };

    let Some(path) = file_path else {
        return Ok(None);
    };
    let chosen = path.to_string_lossy().to_string();
    workspaces.authorize(PathBuf::from(&chosen))?;
    Ok(Some(chosen))
}

fn load_db_notes_at(db_path: String) -> Result<Vec<Note>, String> {
    let conn = open_workspace_db(&db_path)?;

    let mut stmt = conn
        .prepare(
            "SELECT id, title, content, updatedAt, isTitleLocked, isPinned, folderId
             FROM notes
             ORDER BY sortOrder ASC, updatedAt DESC",
        )
        .map_err(|e| e.to_string())?;

    let note_iter = stmt
        .query_map([], |row| {
            let is_title_locked_int: i32 = row.get(4)?;
            let is_pinned_int: i32 = row.get(5)?;
            Ok(Note {
                id: row.get(0)?,
                title: row.get(1)?,
                content: row.get(2)?,
                updated_at: row.get(3)?,
                is_title_locked: is_title_locked_int != 0,
                is_pinned: is_pinned_int != 0,
                folder_id: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut notes = Vec::new();
    for note in note_iter {
        notes.push(note.map_err(|e| e.to_string())?);
    }
    Ok(notes)
}

fn save_note_db_at(db_path: String, note: Note, sort_order: i64) -> Result<(), String> {
    let conn = open_workspace_db(&db_path)?;

    conn.execute(
        "INSERT INTO notes (
            id, title, content, updatedAt, isTitleLocked, isPinned, folderId, sortOrder
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            content = excluded.content,
            updatedAt = excluded.updatedAt,
            isTitleLocked = excluded.isTitleLocked,
            isPinned = excluded.isPinned,
            folderId = excluded.folderId,
            sortOrder = excluded.sortOrder",
        rusqlite::params![
            note.id,
            note.title,
            note.content,
            note.updated_at,
            if note.is_title_locked { 1 } else { 0 },
            if note.is_pinned { 1 } else { 0 },
            note.folder_id,
            sort_order,
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

fn save_notes_db_at(db_path: String, notes: Vec<Note>) -> Result<(), String> {
    let mut conn = open_workspace_db(&db_path)?;

    let transaction = conn.transaction().map_err(|e| e.to_string())?;
    transaction
        .execute("DELETE FROM notes", [])
        .map_err(|e| e.to_string())?;

    {
        let mut statement = transaction
            .prepare(
                "INSERT INTO notes (
                    id, title, content, updatedAt, isTitleLocked, isPinned, folderId, sortOrder
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )
            .map_err(|e| e.to_string())?;

        for (sort_order, note) in notes.into_iter().enumerate() {
            statement
                .execute(rusqlite::params![
                    note.id,
                    note.title,
                    note.content,
                    note.updated_at,
                    if note.is_title_locked { 1 } else { 0 },
                    if note.is_pinned { 1 } else { 0 },
                    note.folder_id,
                    sort_order as i64,
                ])
                .map_err(|e| e.to_string())?;
        }
    }

    transaction.commit().map_err(|e| e.to_string())?;
    Ok(())
}

fn load_db_folders_at(db_path: String) -> Result<Vec<Folder>, String> {
    let conn = open_workspace_db(&db_path)?;

    let mut stmt = conn
        .prepare("SELECT id, name FROM folders ORDER BY sortOrder ASC, name COLLATE NOCASE ASC")
        .map_err(|e| e.to_string())?;
    let folder_iter = stmt
        .query_map([], |row| {
            Ok(Folder {
                id: row.get(0)?,
                name: row.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut folders = Vec::new();
    for folder in folder_iter {
        folders.push(folder.map_err(|e| e.to_string())?);
    }
    Ok(folders)
}

fn load_db_trash_at(db_path: String) -> Result<Vec<TrashEntry>, String> {
    let conn = open_workspace_db(&db_path)?;
    let mut stmt = conn
        .prepare("SELECT entry FROM trash ORDER BY rowid")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.map(|row| {
        serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
    })
    .collect()
}

fn save_folders_db_at(db_path: String, folders: Vec<Folder>) -> Result<(), String> {
    let mut conn = open_workspace_db(&db_path)?;

    let transaction = conn.transaction().map_err(|e| e.to_string())?;
    transaction
        .execute("DELETE FROM folders", [])
        .map_err(|e| e.to_string())?;

    {
        let mut statement = transaction
            .prepare("INSERT INTO folders (id, name, sortOrder) VALUES (?1, ?2, ?3)")
            .map_err(|e| e.to_string())?;
        for (sort_order, folder) in folders.into_iter().enumerate() {
            statement
                .execute(rusqlite::params![folder.id, folder.name, sort_order as i64])
                .map_err(|e| e.to_string())?;
        }
    }

    transaction.commit().map_err(|e| e.to_string())?;
    Ok(())
}

fn save_workspace_db_at(
    db_path: String,
    notes: Vec<Note>,
    folders: Vec<Folder>,
    trash: Option<Vec<TrashEntry>>,
) -> Result<(), String> {
    // Validate the complete replacement before opening a transaction. A note
    // must never be committed pointing at a folder absent from this workspace.
    let folder_ids: std::collections::HashSet<&str> =
        folders.iter().map(|folder| folder.id.as_str()).collect();
    for note in &notes {
        if let Some(folder_id) = note.folder_id.as_deref() {
            if !folder_ids.contains(folder_id) {
                return Err(format!(
                    "Note {} references missing folder {}",
                    note.id, folder_id
                ));
            }
        }
    }
    let mut conn = open_workspace_db(&db_path)?;

    let transaction = conn.transaction().map_err(|e| e.to_string())?;
    transaction
        .execute("DELETE FROM notes", [])
        .map_err(|e| e.to_string())?;
    transaction
        .execute("DELETE FROM folders", [])
        .map_err(|e| e.to_string())?;

    {
        let mut statement = transaction
            .prepare("INSERT INTO folders (id, name, sortOrder) VALUES (?1, ?2, ?3)")
            .map_err(|e| e.to_string())?;
        for (sort_order, folder) in folders.into_iter().enumerate() {
            statement
                .execute(rusqlite::params![folder.id, folder.name, sort_order as i64])
                .map_err(|e| e.to_string())?;
        }
    }

    {
        let mut statement = transaction
            .prepare(
                "INSERT INTO notes (
                    id, title, content, updatedAt, isTitleLocked, isPinned, folderId, sortOrder
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )
            .map_err(|e| e.to_string())?;
        for (sort_order, note) in notes.into_iter().enumerate() {
            statement
                .execute(rusqlite::params![
                    note.id,
                    note.title,
                    note.content,
                    note.updated_at,
                    if note.is_title_locked { 1 } else { 0 },
                    if note.is_pinned { 1 } else { 0 },
                    note.folder_id,
                    sort_order as i64,
                ])
                .map_err(|e| e.to_string())?;
        }
    }

    if let Some(entries) = trash {
        transaction
            .execute("DELETE FROM trash", [])
            .map_err(|e| e.to_string())?;
        let mut stmt = transaction
            .prepare("INSERT INTO trash (id, entry) VALUES (?1, ?2)")
            .map_err(|e| e.to_string())?;
        for entry in entries {
            let json = serde_json::to_string(&entry).map_err(|e| e.to_string())?;
            stmt.execute(rusqlite::params![entry.id, json])
                .map_err(|e| e.to_string())?;
        }
    }

    transaction.commit().map_err(|e| e.to_string())?;
    Ok(())
}

// The webview names the workspace it is showing, but only a path that the user
// chose in a native dialog, or that native preferences restored, is opened.
#[tauri::command]
fn load_db_notes(
    workspaces: tauri::State<'_, workspace::Workspaces>,
    db_path: String,
) -> Result<Vec<Note>, String> {
    workspaces.require(&db_path)?;
    load_db_notes_at(db_path)
}

#[tauri::command]
fn save_note_db(
    workspaces: tauri::State<'_, workspace::Workspaces>,
    db_path: String,
    note: Note,
    sort_order: i64,
) -> Result<(), String> {
    workspaces.require(&db_path)?;
    save_note_db_at(db_path, note, sort_order)
}

#[tauri::command]
fn save_notes_db(
    workspaces: tauri::State<'_, workspace::Workspaces>,
    db_path: String,
    notes: Vec<Note>,
) -> Result<(), String> {
    workspaces.require(&db_path)?;
    save_notes_db_at(db_path, notes)
}

#[tauri::command]
fn load_db_folders(
    workspaces: tauri::State<'_, workspace::Workspaces>,
    db_path: String,
) -> Result<Vec<Folder>, String> {
    workspaces.require(&db_path)?;
    load_db_folders_at(db_path)
}

#[tauri::command]
fn load_db_trash(
    workspaces: tauri::State<'_, workspace::Workspaces>,
    db_path: String,
) -> Result<Vec<TrashEntry>, String> {
    workspaces.require(&db_path)?;
    load_db_trash_at(db_path)
}

#[tauri::command]
fn save_folders_db(
    workspaces: tauri::State<'_, workspace::Workspaces>,
    db_path: String,
    folders: Vec<Folder>,
) -> Result<(), String> {
    workspaces.require(&db_path)?;
    save_folders_db_at(db_path, folders)
}

#[tauri::command]
fn save_workspace_db(
    workspaces: tauri::State<'_, workspace::Workspaces>,
    db_path: String,
    notes: Vec<Note>,
    folders: Vec<Folder>,
    trash: Option<Vec<TrashEntry>>,
) -> Result<(), String> {
    workspaces.require(&db_path)?;
    save_workspace_db_at(db_path, notes, folders, trash)
}

// A top-level navigation is a request the CSP does not see, so the main window
// may only ever show the bundled app.
fn is_app_url(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => match url.host_str() {
            Some("tauri.localhost") => true,
            // `tauri dev` serves the frontend from the CLI's built-in loopback server.
            Some("localhost" | "127.0.0.1") => cfg!(debug_assertions),
            _ => false,
        },
        "about" => url.path() == "blank",
        _ => false,
    }
}

fn external_link(url: &str) -> Result<tauri::Url, String> {
    if url.len() > 2048 {
        return Err("Link is too long to open".to_string());
    }
    let parsed = tauri::Url::parse(url).map_err(|_| "Unsupported link".to_string())?;
    if !matches!(parsed.scheme(), "https" | "http" | "mailto") {
        return Err("Unsupported link".to_string());
    }
    Ok(parsed)
}

// The opener plugin has no JS permission, so a renderer script cannot reach the
// network through the system browser without the user seeing the destination.
#[tauri::command]
fn confirm_and_open_url(app: tauri::AppHandle, url: String) -> Result<bool, String> {
    use tauri_plugin_opener::OpenerExt;

    let parsed = external_link(&url)?;
    let destination = parsed.host_str().unwrap_or(parsed.path()).to_string();
    let proceed = rfd::MessageDialog::new()
        .set_title("Open external link")
        .set_description(format!(
            "{parsed}\n\nThis opens {destination} in your default app. It, not Sodilaud, makes the request."
        ))
        .set_buttons(rfd::MessageButtons::YesNo)
        .show()
        == rfd::MessageDialogResult::Yes;
    if proceed {
        app.opener()
            .open_url(parsed.as_str(), None::<&str>)
            .map_err(|e| e.to_string())?;
    }
    Ok(proceed)
}

#[tauri::command]
fn vacuum_workspace(
    workspaces: tauri::State<'_, workspace::Workspaces>,
    db_path: String,
) -> Result<(), String> {
    workspaces.require(&db_path)?;
    vacuum_workspace_at(&db_path)
}

#[tauri::command]
fn show_alert_dialog(title: String, message: String) {
    rfd::MessageDialog::new()
        .set_title(&title)
        .set_description(&message)
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
}

#[cfg(target_os = "macos")]
fn macos_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    let app_menu = menu
        .items()?
        .into_iter()
        .next()
        .and_then(|item| item.as_submenu().cloned())
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Tauri's default macOS application menu is missing",
            )
        })?;

    // Tauri's first application-menu item is a predefined About command that
    // opens the system metadata panel. Replace only that item so the standard
    // Services, Hide, and Quit behavior remains intact.
    app_menu.remove_at(0)?.ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Tauri's default macOS About menu item is missing",
        )
    })?;
    let about = MenuItem::with_id(
        app,
        NATIVE_ABOUT_MENU_ID,
        format!("About {}", app.package_info().name),
        true,
        None::<&str>,
    )?;
    app_menu.insert(&about, 0)?;

    Ok(menu)
}

#[cfg(target_os = "macos")]
fn handle_macos_menu_event<R: Runtime>(app: &AppHandle<R>, event: tauri::menu::MenuEvent) {
    if event.id() != NATIVE_ABOUT_MENU_ID {
        return;
    }

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        if let Err(error) = window.emit(OPEN_ABOUT_EVENT, ()) {
            eprintln!("Could not open the Sodilaud About panel: {error}");
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run(context: tauri::Context<tauri::Wry>) {
    let builder = tauri::Builder::default()
        .manage(mcp::McpState::default())
        .manage(workspace::Workspaces::default());
    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(macos_menu)
        .on_menu_event(handle_macos_menu_event)
        .manage(clipboard::runtime::ClipboardRuntime::default())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .on_window_event(clipboard::popup::on_window_event);

    builder
        // Only confirm_and_open_url uses the opener, from Rust; the webview has
        // no opener permission.
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("navigation-guard")
                .on_navigation(|_webview, url| is_app_url(url))
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            confirm_and_open_url,
            load_workspace_preference,
            set_last_workspace,
            save_file_native,
            import_file_native,
            select_db_file,
            vacuum_workspace,
            load_db_notes,
            load_db_folders,
            load_db_trash,
            save_note_db,
            save_notes_db,
            save_folders_db,
            save_workspace_db,
            show_alert_dialog,
            mcp::update_mcp_snapshot,
            mcp::update_mcp_note,
            mcp::get_mcp_connection_info,
            mcp::start_mcp_server,
            mcp::set_mcp_permissions,
            mcp::complete_mcp_write,
            mcp::stop_mcp_server,
            clipboard::commands::clip_list,
            clipboard::commands::clip_reveal,
            clipboard::commands::clip_select,
            clipboard::commands::clip_delete,
            clipboard::commands::clip_set_config
        ])
        .run(context)
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_db_path(test_name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after the Unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!(
            "sodilaud-{test_name}-{}-{unique}.sqlite",
            std::process::id()
        ))
    }

    fn note(id: &str, content: &str, updated_at: i64) -> Note {
        Note {
            id: id.to_string(),
            title: format!("Note {id}"),
            content: content.to_string(),
            updated_at,
            is_title_locked: false,
            is_pinned: false,
            folder_id: None,
        }
    }

    fn folder(id: &str, name: &str) -> Folder {
        Folder {
            id: id.to_string(),
            name: name.to_string(),
        }
    }

    #[test]
    fn migrates_legacy_workspace_once_and_respects_an_explicit_disconnect() {
        let path = temporary_db_path("native-preferences").with_extension("json");
        let legacy_file = temporary_db_path("legacy-workspace");
        std::fs::write(&legacy_file, b"").expect("legacy workspace should be creatable");
        let legacy_path = legacy_file.to_string_lossy().into_owned();

        let migrated = load_workspace_preference_from(&path, Some(legacy_path.clone()))
            .expect("legacy preference should migrate");
        assert_eq!(migrated, Some(legacy_path));
        std::fs::remove_file(legacy_file).expect("legacy workspace should be removable");

        write_preferences(
            &path,
            &AppPreferences {
                last_workspace: None,
            },
        )
        .expect("disconnect should be persisted");

        let stale_legacy = load_workspace_preference_from(
            &path,
            Some("/tmp/stale-origin-workspace.db".to_string()),
        )
        .expect("native preference should take precedence");
        assert_eq!(stale_legacy, None);

        std::fs::remove_file(path).expect("temporary preferences should be removable");
    }

    #[cfg(unix)]
    fn mode_of(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .expect("file should exist")
            .permissions()
            .mode()
            & 0o777
    }

    #[test]
    fn a_workspace_file_is_owner_readable_only() {
        let path = temporary_db_path("modes");
        let db_path = path.to_string_lossy().into_owned();
        save_notes_db_at(db_path, vec![note("a", "secret", 1)]).expect("workspace should save");
        #[cfg(unix)]
        assert_eq!(
            mode_of(&path),
            0o600,
            "the workspace must not be group or world readable"
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn native_preferences_are_owner_readable_only() {
        let path = temporary_db_path("preferences-mode").with_extension("json");
        write_preferences(&path, &AppPreferences::default()).expect("preferences should save");
        #[cfg(unix)]
        assert_eq!(mode_of(&path), 0o600);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn secure_delete_is_enabled_on_the_workspace() {
        let path = temporary_db_path("secure-delete");
        let conn = open_workspace_db(&path.to_string_lossy()).expect("workspace should open");
        let on: i64 = conn
            .query_row("PRAGMA secure_delete", [], |row| row.get(0))
            .expect("the pragma should be readable");
        assert_eq!(on, 1, "superseded note bodies must be overwritten");
        drop(conn);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn reclaiming_a_workspace_drops_free_pages() {
        let path = temporary_db_path("reclaim");
        let db_path = path.to_string_lossy().into_owned();
        let bulky: Vec<Note> = (0..200)
            .map(|index| note(&index.to_string(), &"x".repeat(4096), index))
            .collect();
        save_notes_db_at(db_path.clone(), bulky).expect("bulk save should succeed");
        save_notes_db_at(db_path.clone(), vec![note("kept", "small", 1)])
            .expect("shrinking save should succeed");
        let before = std::fs::metadata(&path).unwrap().len();
        vacuum_workspace_at(&db_path).expect("vacuum should succeed");
        let after = std::fs::metadata(&path).unwrap().len();
        assert!(after < before, "expected {after} < {before}");
        assert_eq!(load_db_notes_at(db_path).unwrap()[0].id, "kept");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_debug_build_may_show_the_cli_dev_server_but_a_release_build_may_not() {
        let dev_server = tauri::Url::parse("http://localhost:1430/").unwrap();
        assert_eq!(is_app_url(&dev_server), cfg!(debug_assertions));
        let loopback = tauri::Url::parse("http://127.0.0.1:1430/").unwrap();
        assert_eq!(is_app_url(&loopback), cfg!(debug_assertions));
        let other_host = tauri::Url::parse("http://localhost.evil.example/").unwrap();
        assert!(!is_app_url(&other_host));
    }

    #[test]
    fn the_window_may_only_navigate_within_the_bundled_app() {
        for allowed in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/index.html",
            "https://tauri.localhost/",
            "about:blank",
        ] {
            let url = tauri::Url::parse(allowed).unwrap();
            assert!(is_app_url(&url), "{allowed} should be allowed");
        }
        for rejected in [
            "https://example.com/",
            "http://tauri.localhost.evil.example/",
            "tauri://evil/",
            "data:text/html,<p>hi</p>",
            "file:///etc/passwd",
        ] {
            let url = tauri::Url::parse(rejected).unwrap();
            assert!(!is_app_url(&url), "{rejected} should be rejected");
        }
    }

    #[test]
    fn only_web_and_mail_links_may_leave_the_app() {
        for allowed in [
            "https://example.com/docs",
            "http://example.com",
            "mailto:someone@example.com",
        ] {
            assert!(
                external_link(allowed).is_ok(),
                "{allowed} should be allowed"
            );
        }
        for rejected in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "smb://host/share",
            "not a url",
        ] {
            assert!(
                external_link(rejected).is_err(),
                "{rejected} should be rejected"
            );
        }
        let long = format!("https://example.com/{}", "a".repeat(2048));
        assert!(external_link(&long).is_err());
    }

    #[test]
    fn a_legacy_preference_naming_a_missing_file_is_not_migrated() {
        let path = temporary_db_path("missing-legacy").with_extension("json");
        let missing = temporary_db_path("never-created");

        let migrated =
            load_workspace_preference_from(&path, Some(missing.to_string_lossy().into_owned()))
                .expect("migration should complete");
        assert_eq!(migrated, None);
        assert!(!missing.exists());

        std::fs::remove_file(path).expect("temporary preferences should be removable");
    }

    #[test]
    fn saves_the_complete_workspace_in_sidebar_order() {
        let path = temporary_db_path("ordered-workspace");
        let db_path = path.to_string_lossy().into_owned();

        save_notes_db_at(
            db_path.clone(),
            vec![note("older", "left", 1), note("newer", "right", 2)],
        )
        .expect("workspace should save");

        save_note_db_at(
            db_path.clone(),
            note("newer", "edited in secondary pane", 3),
            1,
        )
        .expect("secondary note should save independently");

        let loaded = load_db_notes_at(db_path.clone()).expect("workspace should load");
        assert_eq!(loaded[0].id, "older");
        assert_eq!(loaded[1].content, "edited in secondary pane");

        let mut pinned_note = loaded[1].clone();
        pinned_note.is_pinned = true;
        let reordered = vec![pinned_note, loaded[0].clone()];
        save_notes_db_at(db_path.clone(), reordered.clone()).expect("workspace should resave");

        let loaded = load_db_notes_at(db_path).expect("workspace should load");
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].id, "newer");
        assert_eq!(loaded[0].content, "edited in secondary pane");
        assert!(loaded[0].is_pinned);
        assert_eq!(loaded[1].id, "older");

        std::fs::remove_file(path).expect("temporary database should be removable");
    }

    #[test]
    fn saves_folders_and_note_assignments_in_sidebar_order() {
        let path = temporary_db_path("folder-workspace");
        let db_path = path.to_string_lossy().into_owned();
        let folders = vec![folder("work", "Work"), folder("personal", "Personal")];
        save_folders_db_at(db_path.clone(), folders).expect("folders should save");

        let mut assigned = note("assigned", "in work", 1);
        assigned.folder_id = Some("work".to_string());
        save_notes_db_at(db_path.clone(), vec![assigned]).expect("assigned note should save");

        let loaded_folders = load_db_folders_at(db_path.clone()).expect("folders should load");
        let loaded_notes = load_db_notes_at(db_path.clone()).expect("notes should load");
        assert_eq!(loaded_folders[0].id, "work");
        assert_eq!(loaded_folders[1].name, "Personal");
        assert_eq!(loaded_notes[0].folder_id.as_deref(), Some("work"));

        std::fs::remove_file(path).expect("temporary database should be removable");
    }

    #[test]
    fn trash_deletion_and_restore_are_atomic_and_survive_other_saves() {
        let path = temporary_db_path("trash-workspace");
        let db_path = path.to_string_lossy().into_owned();
        let original = note("original", "recover the full body", 1);
        let entry = TrashEntry {
            id: "trash-one".into(),
            note: original.clone(),
            deleted_at: 2,
            folder_name: None,
        };
        save_workspace_db_at(
            db_path.clone(),
            vec![original.clone()],
            vec![],
            Some(vec![]),
        )
        .unwrap();
        // A duplicate recovery ID fails after the active rows have been replaced;
        // the entire transaction must roll back, retaining the live note.
        assert!(save_workspace_db_at(
            db_path.clone(),
            vec![],
            vec![],
            Some(vec![entry.clone(), entry.clone()])
        )
        .is_err());
        assert_eq!(
            load_db_notes_at(db_path.clone()).unwrap()[0].content,
            original.content
        );
        assert!(load_db_trash_at(db_path.clone()).unwrap().is_empty());
        save_workspace_db_at(db_path.clone(), vec![], vec![], Some(vec![entry.clone()])).unwrap();
        assert!(load_db_notes_at(db_path.clone()).unwrap().is_empty());
        assert_eq!(
            load_db_trash_at(db_path.clone()).unwrap()[0].note.content,
            original.content
        );
        save_workspace_db_at(
            db_path.clone(),
            vec![note("other", "typed", 3)],
            vec![],
            None,
        )
        .unwrap();
        assert_eq!(load_db_trash_at(db_path.clone()).unwrap().len(), 1);
        // An invalid restored folder cannot remove the recovery entry.
        let mut invalid = original.clone();
        invalid.folder_id = Some("missing".into());
        assert!(
            save_workspace_db_at(db_path.clone(), vec![invalid], vec![], Some(vec![])).is_err()
        );
        assert_eq!(load_db_trash_at(db_path.clone()).unwrap().len(), 1);
        save_workspace_db_at(
            db_path.clone(),
            vec![original.clone()],
            vec![],
            Some(vec![]),
        )
        .unwrap();
        assert_eq!(
            load_db_notes_at(db_path.clone()).unwrap()[0].id,
            original.id
        );
        assert!(load_db_trash_at(db_path.clone()).unwrap().is_empty());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn workspace_structure_save_is_atomic() {
        let path = temporary_db_path("atomic-workspace");
        let db_path = path.to_string_lossy().into_owned();
        let mut original_note = note("original", "keep me", 1);
        original_note.folder_id = Some("original-folder".to_string());
        save_workspace_db_at(
            db_path.clone(),
            vec![original_note],
            vec![folder("original-folder", "Original")],
            None,
        )
        .expect("initial workspace should save");

        let failed = save_workspace_db_at(
            db_path.clone(),
            vec![note("replacement", "must roll back", 2)],
            vec![folder("duplicate", "One"), folder("duplicate", "Two")],
            None,
        );
        assert!(failed.is_err());

        let mut orphan = note("orphan", "must not save", 3);
        orphan.folder_id = Some("missing".into());
        assert!(save_workspace_db_at(db_path.clone(), vec![orphan], vec![], None).is_err());

        let loaded_notes = load_db_notes_at(db_path.clone()).expect("original notes should remain");
        let loaded_folders =
            load_db_folders_at(db_path.clone()).expect("original folders should remain");
        assert_eq!(loaded_notes.len(), 1);
        assert_eq!(loaded_notes[0].id, "original");
        assert_eq!(loaded_notes[0].content, "keep me");
        assert_eq!(loaded_folders.len(), 1);
        assert_eq!(loaded_folders[0].name, "Original");

        std::fs::remove_file(path).expect("temporary database should be removable");
    }

    #[test]
    fn migrates_existing_databases_without_ordering_columns() {
        let path = temporary_db_path("migration");
        let db_path = path.to_string_lossy().into_owned();
        let connection = rusqlite::Connection::open(&db_path).expect("database should open");
        connection
            .execute(
                "CREATE TABLE notes (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    content TEXT NOT NULL,
                    updatedAt INTEGER NOT NULL,
                    isTitleLocked INTEGER NOT NULL
                )",
                [],
            )
            .expect("legacy schema should be created");
        drop(connection);

        let loaded = load_db_notes_at(db_path).expect("legacy schema should migrate");
        assert!(loaded.is_empty());

        let connection = rusqlite::Connection::open(&path).expect("database should reopen");
        let has_sort_order: bool = connection
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM pragma_table_info('notes') WHERE name = 'sortOrder'
                )",
                [],
                |row| row.get(0),
            )
            .expect("migration should be queryable");
        assert!(has_sort_order);
        let has_is_pinned: bool = connection
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM pragma_table_info('notes') WHERE name = 'isPinned'
                )",
                [],
                |row| row.get(0),
            )
            .expect("pin migration should be queryable");
        assert!(has_is_pinned);
        let has_folder_id: bool = connection
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM pragma_table_info('notes') WHERE name = 'folderId'
                )",
                [],
                |row| row.get(0),
            )
            .expect("folder migration should be queryable");
        assert!(has_folder_id);
        let has_folders_table: bool = connection
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'folders'
                )",
                [],
                |row| row.get(0),
            )
            .expect("folders table should be queryable");
        assert!(has_folders_table);
        drop(connection);

        std::fs::remove_file(path).expect("temporary database should be removable");
    }
}
