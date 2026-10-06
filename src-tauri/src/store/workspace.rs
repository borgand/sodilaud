// SPDX-License-Identifier: GPL-3.0-or-later

//! SQLite storage for a notes workspace. The registry in `docs` owns the live
//! collection; this module only reads and writes rows.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::docs::comments::Comment;
use crate::restrict_to_owner;

/// Created in the app data directory and used whenever no other workspace is
/// connected. It replaced the webview's localStorage collection in 0.11.
pub(crate) const DEFAULT_FILE_NAME: &str = "default.sqlite";

/// Set once the localStorage collection has been copied into the default
/// workspace, so the import never runs twice.
pub(crate) const LOCAL_IMPORTED_KEY: &str = "local_imported";

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Note {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) content: String,
    pub(crate) updated_at: i64,
    pub(crate) is_title_locked: bool,
    #[serde(default)]
    pub(crate) is_pinned: bool,
    #[serde(default)]
    pub(crate) folder_id: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub(crate) struct Folder {
    pub(crate) id: String,
    pub(crate) name: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrashEntry {
    pub(crate) id: String,
    pub(crate) note: Note,
    pub(crate) deleted_at: i64,
    pub(crate) folder_name: Option<String>,
}

pub(crate) struct Loaded {
    pub(crate) notes: Vec<Note>,
    pub(crate) folders: Vec<Folder>,
    pub(crate) trash: Vec<TrashEntry>,
}

pub(crate) fn default_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(DEFAULT_FILE_NAME)
}

/// Opens a workspace owner-only with `secure_delete` on, so replaced and deleted
/// note bodies are overwritten instead of lingering in free pages. That makes
/// bulk saves slower, which is deliberate for a store that may hold secrets.
pub(crate) fn open(path: &Path) -> Result<rusqlite::Connection, String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Could not create the workspace directory: {e}"))?;
    }
    let conn = rusqlite::Connection::open(path).map_err(|e| e.to_string())?;
    restrict_to_owner(path)?;
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut sibling = path.as_os_str().to_owned();
        sibling.push(suffix);
        let sibling = PathBuf::from(sibling);
        if sibling.exists() {
            restrict_to_owner(&sibling)?;
        }
    }
    conn.pragma_update(None, "secure_delete", "ON")
        .map_err(|e| format!("Could not enable secure_delete: {e}"))?;
    ensure_schema(&conn)?;
    Ok(conn)
}

/// Drops free pages that predate `secure_delete`. `VACUUM` cannot run inside a
/// transaction, so it runs on a fresh connection.
pub(crate) fn vacuum(path: &Path) -> Result<(), String> {
    open(path)?
        .execute_batch("VACUUM")
        .map_err(|e| format!("Could not reclaim workspace space: {e}"))
}

fn has_column(conn: &rusqlite::Connection, table: &str, column: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name = ?2)",
        rusqlite::params![table, column],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

fn ensure_schema(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS trash (id TEXT PRIMARY KEY, entry TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS notes (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            updatedAt INTEGER NOT NULL,
            isTitleLocked INTEGER NOT NULL,
            isPinned INTEGER NOT NULL DEFAULT 0,
            folderId TEXT,
            sortOrder INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS folders (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            sortOrder INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS comments (
            id TEXT PRIMARY KEY,
            noteId TEXT NOT NULL,
            data TEXT NOT NULL
         );
         CREATE INDEX IF NOT EXISTS comments_note ON comments (noteId);",
    )
    .map_err(|e| e.to_string())?;
    for (column, definition) in [
        ("sortOrder", "sortOrder INTEGER NOT NULL DEFAULT 0"),
        ("isPinned", "isPinned INTEGER NOT NULL DEFAULT 0"),
        ("folderId", "folderId TEXT"),
    ] {
        if !has_column(conn, "notes", column)? {
            conn.execute(&format!("ALTER TABLE notes ADD COLUMN {definition}"), [])
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub(crate) fn load(conn: &rusqlite::Connection) -> Result<Loaded, String> {
    let mut statement = conn
        .prepare(
            "SELECT id, title, content, updatedAt, isTitleLocked, isPinned, folderId
             FROM notes ORDER BY sortOrder ASC, updatedAt DESC",
        )
        .map_err(|e| e.to_string())?;
    let notes = statement
        .query_map([], |row| {
            Ok(Note {
                id: row.get(0)?,
                title: row.get(1)?,
                content: row.get(2)?,
                updated_at: row.get(3)?,
                is_title_locked: row.get::<_, i64>(4)? != 0,
                is_pinned: row.get::<_, i64>(5)? != 0,
                folder_id: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let mut statement = conn
        .prepare("SELECT id, name FROM folders ORDER BY sortOrder ASC, name COLLATE NOCASE ASC")
        .map_err(|e| e.to_string())?;
    let folders = statement
        .query_map([], |row| {
            Ok(Folder {
                id: row.get(0)?,
                name: row.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;

    let mut statement = conn
        .prepare("SELECT entry FROM trash ORDER BY rowid")
        .map_err(|e| e.to_string())?;
    let trash = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .map(|row| {
            serde_json::from_str(&row.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect::<Result<Vec<TrashEntry>, String>>()?;

    Ok(Loaded {
        notes,
        folders,
        trash,
    })
}

fn insert_note(
    statement: &mut rusqlite::Statement<'_>,
    note: &Note,
    sort_order: usize,
) -> Result<(), String> {
    statement
        .execute(rusqlite::params![
            note.id,
            note.title,
            note.content,
            note.updated_at,
            note.is_title_locked as i64,
            note.is_pinned as i64,
            note.folder_id,
            sort_order as i64,
        ])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Replaces every note, folder and trash entry in one transaction. A note must
/// never be committed pointing at a folder absent from this workspace.
pub(crate) fn save_all(
    conn: &mut rusqlite::Connection,
    notes: &[&Note],
    folders: &[Folder],
    trash: &[TrashEntry],
) -> Result<(), String> {
    let transaction = conn.transaction().map_err(|e| e.to_string())?;
    write_all(&transaction, notes, folders, trash)?;
    transaction.commit().map_err(|e| e.to_string())
}

fn write_all(
    transaction: &rusqlite::Transaction<'_>,
    notes: &[&Note],
    folders: &[Folder],
    trash: &[TrashEntry],
) -> Result<(), String> {
    let folder_ids: std::collections::HashSet<&str> =
        folders.iter().map(|folder| folder.id.as_str()).collect();
    if let Some(note) = notes.iter().find(|note| {
        note.folder_id
            .as_deref()
            .is_some_and(|id| !folder_ids.contains(id))
    }) {
        return Err(format!("Note {} references a missing folder", note.id));
    }
    transaction
        .execute_batch("DELETE FROM notes; DELETE FROM folders; DELETE FROM trash;")
        .map_err(|e| e.to_string())?;
    let mut statement = transaction
        .prepare("INSERT INTO folders (id, name, sortOrder) VALUES (?1, ?2, ?3)")
        .map_err(|e| e.to_string())?;
    for (sort_order, folder) in folders.iter().enumerate() {
        statement
            .execute(rusqlite::params![folder.id, folder.name, sort_order as i64])
            .map_err(|e| e.to_string())?;
    }
    let mut statement = transaction
        .prepare(
            "INSERT INTO notes (
                id, title, content, updatedAt, isTitleLocked, isPinned, folderId, sortOrder
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        )
        .map_err(|e| e.to_string())?;
    for (sort_order, note) in notes.iter().enumerate() {
        insert_note(&mut statement, note, sort_order)?;
    }
    let mut statement = transaction
        .prepare("INSERT INTO trash (id, entry) VALUES (?1, ?2)")
        .map_err(|e| e.to_string())?;
    for entry in trash {
        let json = serde_json::to_string(entry).map_err(|e| e.to_string())?;
        statement
            .execute(rusqlite::params![entry.id, json])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Writes one note's row, for content edits that leave the structure alone.
pub(crate) fn save_note(
    conn: &rusqlite::Connection,
    note: &Note,
    sort_order: usize,
) -> Result<(), String> {
    let mut statement = conn
        .prepare_cached(
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
        )
        .map_err(|e| e.to_string())?;
    insert_note(&mut statement, note, sort_order)
}

/// Every note's comments, by note ID. A row that cannot be read is skipped.
pub(crate) fn load_comments(
    conn: &rusqlite::Connection,
    note_id: Option<&str>,
) -> Result<HashMap<String, Vec<Comment>>, String> {
    let mut statement = conn
        .prepare("SELECT noteId, data FROM comments WHERE ?1 IS NULL OR noteId = ?1 ORDER BY rowid")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([note_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut found: HashMap<String, Vec<Comment>> = HashMap::new();
    for row in rows {
        let (note, data) = row.map_err(|e| e.to_string())?;
        if let Ok(comment) = serde_json::from_str(&data) {
            found.entry(note).or_default().push(comment);
        }
    }
    Ok(found)
}

/// Replaces one note's comments.
pub(crate) fn save_note_comments(
    conn: &mut rusqlite::Connection,
    note_id: &str,
    comments: &[Comment],
) -> Result<(), String> {
    let transaction = conn.transaction().map_err(|e| e.to_string())?;
    transaction
        .execute("DELETE FROM comments WHERE noteId = ?1", [note_id])
        .map_err(|e| e.to_string())?;
    for comment in comments {
        let data = serde_json::to_string(comment).map_err(|e| e.to_string())?;
        transaction
            .execute(
                "INSERT INTO comments (id, noteId, data) VALUES (?1, ?2, ?3)",
                rusqlite::params![comment.id, note_id, data],
            )
            .map_err(|e| e.to_string())?;
    }
    transaction.commit().map_err(|e| e.to_string())
}

pub(crate) fn delete_note_comments(
    conn: &rusqlite::Connection,
    note_ids: &[String],
) -> Result<(), String> {
    for note_id in note_ids {
        conn.execute("DELETE FROM comments WHERE noteId = ?1", [note_id])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(crate) fn meta(conn: &rusqlite::Connection, key: &str) -> Result<Option<String>, String> {
    match conn.query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| {
        row.get(0)
    }) {
        Ok(value) => Ok(Some(value)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn set_meta_in(
    transaction: &rusqlite::Transaction<'_>,
    key: &str,
    value: &str,
) -> Result<(), String> {
    transaction
        .execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [key, value],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Replaces the whole collection and records `key`, both or neither.
pub(crate) fn save_all_with_meta(
    conn: &mut rusqlite::Connection,
    notes: &[&Note],
    folders: &[Folder],
    trash: &[TrashEntry],
    key: &str,
    value: &str,
) -> Result<(), String> {
    let transaction = conn.transaction().map_err(|e| e.to_string())?;
    write_all(&transaction, notes, folders, trash)?;
    set_meta_in(&transaction, key, value)?;
    transaction.commit().map_err(|e| e.to_string())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    pub(crate) fn temporary_db_path(test_name: &str) -> PathBuf {
        // Tests run in parallel and the clock is too coarse to tell them apart.
        static COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after the Unix epoch")
            .as_nanos();
        let count = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        std::env::temp_dir().join(format!(
            "sodilaud-{test_name}-{}-{unique}-{count}.sqlite",
            std::process::id()
        ))
    }

    pub(crate) fn note(id: &str, content: &str, updated_at: i64) -> Note {
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

    fn save(
        path: &Path,
        notes: &[Note],
        folders: &[Folder],
        trash: &[TrashEntry],
    ) -> Result<(), String> {
        let refs: Vec<&Note> = notes.iter().collect();
        save_all(&mut open(path)?, &refs, folders, trash)
    }

    fn loaded(path: &Path) -> Loaded {
        load(&open(path).unwrap()).unwrap()
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
    fn comments_round_trip_per_note_and_survive_a_full_save() {
        use crate::docs::comments::{Author, State};
        let path = temporary_db_path("comments");
        save(&path, &[note("a", "text", 1)], &[], &[]).unwrap();
        let mut conn = open(&path).unwrap();
        let comment = Comment::new(
            Author::Agent,
            State::Open,
            "text",
            (0, 2),
            "q".into(),
            None,
            1,
        );
        save_note_comments(&mut conn, "a", std::slice::from_ref(&comment)).unwrap();
        let refs = [note("a", "text!", 2)];
        let refs: Vec<&Note> = refs.iter().collect();
        save_all(&mut conn, &refs, &[], &[]).unwrap();
        assert_eq!(
            load_comments(&conn, None).unwrap()["a"],
            vec![comment.clone()]
        );
        assert_eq!(load_comments(&conn, Some("a")).unwrap().len(), 1);
        assert!(load_comments(&conn, Some("b")).unwrap().is_empty());
        delete_note_comments(&conn, &["a".into()]).unwrap();
        assert!(load_comments(&conn, None).unwrap().is_empty());
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn a_workspace_file_is_owner_readable_only() {
        let path = temporary_db_path("modes");
        save(&path, &[note("a", "secret", 1)], &[], &[]).expect("workspace should save");
        #[cfg(unix)]
        assert_eq!(
            mode_of(&path),
            0o600,
            "the workspace must not be group or world readable"
        );
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn secure_delete_is_enabled_on_the_workspace() {
        let path = temporary_db_path("secure-delete");
        let conn = open(&path).expect("workspace should open");
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
        let bulky: Vec<Note> = (0..200)
            .map(|index| note(&index.to_string(), &"x".repeat(4096), index))
            .collect();
        save(&path, &bulky, &[], &[]).expect("bulk save should succeed");
        save(&path, &[note("kept", "small", 1)], &[], &[]).expect("shrinking save should succeed");
        let before = std::fs::metadata(&path).unwrap().len();
        vacuum(&path).expect("vacuum should succeed");
        let after = std::fs::metadata(&path).unwrap().len();
        assert!(after < before, "expected {after} < {before}");
        assert_eq!(loaded(&path).notes[0].id, "kept");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn saves_the_complete_workspace_in_sidebar_order() {
        let path = temporary_db_path("ordered-workspace");
        save(
            &path,
            &[note("older", "left", 1), note("newer", "right", 2)],
            &[],
            &[],
        )
        .unwrap();
        save_note(
            &open(&path).unwrap(),
            &note("newer", "edited in secondary pane", 3),
            1,
        )
        .expect("one note should save independently");
        let notes = loaded(&path).notes;
        assert_eq!(notes[0].id, "older");
        assert_eq!(notes[1].content, "edited in secondary pane");

        let mut pinned = notes[1].clone();
        pinned.is_pinned = true;
        save(&path, &[pinned, notes[0].clone()], &[], &[]).unwrap();
        let notes = loaded(&path).notes;
        assert_eq!(notes.len(), 2);
        assert_eq!(notes[0].id, "newer");
        assert!(notes[0].is_pinned);
        assert_eq!(notes[1].id, "older");
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn saves_folders_and_note_assignments_in_sidebar_order() {
        let path = temporary_db_path("folder-workspace");
        let mut assigned = note("assigned", "in work", 1);
        assigned.folder_id = Some("work".to_string());
        save(
            &path,
            &[assigned],
            &[folder("work", "Work"), folder("personal", "Personal")],
            &[],
        )
        .unwrap();
        let state = loaded(&path);
        assert_eq!(state.folders[0].id, "work");
        assert_eq!(state.folders[1].name, "Personal");
        assert_eq!(state.notes[0].folder_id.as_deref(), Some("work"));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn a_failed_save_rolls_back_notes_folders_and_trash() {
        let path = temporary_db_path("atomic-workspace");
        let mut original = note("original", "keep me", 1);
        original.folder_id = Some("original-folder".to_string());
        let entry = TrashEntry {
            id: "trash-one".into(),
            note: note("gone", "recover the full body", 1),
            deleted_at: 2,
            folder_name: None,
        };
        save(
            &path,
            &[original],
            &[folder("original-folder", "Original")],
            std::slice::from_ref(&entry),
        )
        .unwrap();

        assert!(save(
            &path,
            &[note("replacement", "must roll back", 2)],
            &[folder("duplicate", "One"), folder("duplicate", "Two")],
            &[],
        )
        .is_err());
        assert!(save(&path, &[], &[], &[entry.clone(), entry.clone()]).is_err());
        let mut orphan = note("orphan", "must not save", 3);
        orphan.folder_id = Some("missing".into());
        assert!(save(&path, &[orphan], &[], &[]).is_err());

        let state = loaded(&path);
        assert_eq!(state.notes.len(), 1);
        assert_eq!(state.notes[0].content, "keep me");
        assert_eq!(state.folders[0].name, "Original");
        assert_eq!(state.trash, vec![entry]);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn meta_is_recorded_only_with_a_successful_save() {
        let path = temporary_db_path("meta");
        let mut conn = open(&path).unwrap();
        let mut orphan = note("orphan", "x", 1);
        orphan.folder_id = Some("missing".into());
        assert!(save_all_with_meta(&mut conn, &[&orphan], &[], &[], "flag", "1").is_err());
        assert_eq!(meta(&conn, "flag").unwrap(), None);
        save_all_with_meta(&mut conn, &[&note("a", "x", 1)], &[], &[], "flag", "1").unwrap();
        assert_eq!(meta(&conn, "flag").unwrap().as_deref(), Some("1"));
        drop(conn);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn migrates_existing_databases_without_ordering_columns() {
        let path = temporary_db_path("migration");
        let connection = rusqlite::Connection::open(&path).unwrap();
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
            .unwrap();
        drop(connection);

        let conn = open(&path).expect("legacy schema should migrate");
        assert!(load(&conn).unwrap().notes.is_empty());
        for column in ["sortOrder", "isPinned", "folderId"] {
            assert!(
                has_column(&conn, "notes", column).unwrap(),
                "{column} should exist"
            );
        }
        assert_eq!(meta(&conn, "anything").unwrap(), None);
        drop(conn);
        std::fs::remove_file(path).unwrap();
    }
}
