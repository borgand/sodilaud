// SPDX-License-Identifier: GPL-3.0-or-later

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::Manager;
#[cfg(target_os = "macos")]
use tauri::{
    menu::{Menu, MenuItem},
    AppHandle, Emitter, Wry,
};

mod clipboard;
mod docs;
mod files;
mod mcp;
mod platform;
mod quicknotes;
mod quit;
mod store;
mod workspace;
pub use mcp::run_mcp_stdio;

pub(crate) const PREFERENCES_FILE_NAME: &str = "sodilaud-preferences.json";

#[cfg(target_os = "macos")]
const NATIVE_ABOUT_MENU_ID: &str = "sodilaud-native-about";
#[cfg(target_os = "macos")]
const NATIVE_QUIT_MENU_ID: &str = "sodilaud-native-quit";
#[cfg(target_os = "macos")]
const OPEN_ABOUT_EVENT: &str = "sodilaud-open-about";

#[derive(serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppPreferences {
    pub(crate) last_workspace: Option<String>,
}

pub(crate) fn read_preferences(path: &Path) -> Result<Option<AppPreferences>, String> {
    match fs::read(path) {
        Ok(contents) => serde_json::from_slice(&contents)
            .map(Some)
            .map_err(|e| format!("Could not parse native preferences: {e}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Could not read native preferences: {error}")),
    }
}

pub(crate) fn write_preferences(path: &Path, preferences: &AppPreferences) -> Result<(), String> {
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

pub(crate) fn preferences_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|directory| directory.join(PREFERENCES_FILE_NAME))
        .map_err(|e| format!("Could not resolve native preferences directory: {e}"))
}

/// Restrict a file to its owner. SQLite creates databases 0644 minus umask, which
/// leaves note content readable by every local user; a clipboard history must not be.
pub(crate) fn restrict_to_owner(path: &Path) -> Result<(), String> {
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
fn show_alert_dialog(title: String, message: String) {
    rfd::MessageDialog::new()
        .set_title(&title)
        .set_description(&message)
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
}

#[cfg(target_os = "macos")]
fn macos_menu(app: &AppHandle<Wry>) -> tauri::Result<Menu<Wry>> {
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

    let quit_position = app_menu.items()?.iter().position(|item| {
        matches!(item, tauri::menu::MenuItemKind::Predefined(predefined)
            if predefined.text().is_ok_and(|text| text.starts_with("Quit")))
    });
    if let Some(position) = quit_position {
        app_menu.remove_at(position)?;
        let quit = MenuItem::with_id(
            app,
            NATIVE_QUIT_MENU_ID,
            format!("Quit {}", app.package_info().name),
            true,
            Some("CmdOrCtrl+Q"),
        )?;
        app_menu.insert(&quit, position)?;
    }

    Ok(menu)
}

#[cfg(target_os = "macos")]
fn handle_macos_menu_event(app: &AppHandle<Wry>, event: tauri::menu::MenuEvent) {
    if event.id() == NATIVE_QUIT_MENU_ID {
        // Cmd+Q in the popup hides only the popup.
        if app
            .state::<clipboard::runtime::ClipboardRuntime>()
            .popup_open()
        {
            clipboard::popup::hide(app);
        } else {
            quit::request(app);
        }
        return;
    }

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

fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    #[cfg(target_os = "macos")]
    clipboard::popup::on_window_event(window, event);
    quicknotes::window::on_window_event(window, event);
    if window.label() == quicknotes::window::MAIN_LABEL {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            // The main window is never destroyed: closing it hides it (macOS keeps
            // running in the tray) or quits after every window has saved.
            api.prevent_close();
            #[cfg(target_os = "macos")]
            clipboard::tray::hide_main(window.app_handle());
            #[cfg(not(target_os = "macos"))]
            quit::request(window.app_handle());
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run(context: tauri::Context<tauri::Wry>) {
    let builder = tauri::Builder::default()
        .manage(mcp::McpState::default())
        .manage(workspace::Workspaces::default())
        .manage(docs::commands::SharedRegistry::default())
        .manage(docs::commands::StartupState::default())
        .manage(quit::QuitState::default());
    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(macos_menu)
        .on_menu_event(handle_macos_menu_event)
        .manage(clipboard::runtime::ClipboardRuntime::default());

    // Registered first, as the plugin requires: a second launch hands its files
    // to this instance and exits.
    #[cfg(not(target_os = "macos"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
        let paths = files::paths_from_args(args)
            .into_iter()
            .map(|path| std::path::Path::new(&cwd).join(path))
            .collect();
        files::open_from_system(app, paths);
    }));

    builder
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .on_window_event(on_window_event)
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
            save_file_native,
            import_file_native,
            select_db_file,
            show_alert_dialog,
            docs::commands::notes_boot,
            docs::commands::notes_import_local,
            docs::commands::notes_connect,
            docs::commands::notes_disconnect,
            docs::commands::notes_sync_structure,
            docs::commands::notes_trash,
            docs::commands::notes_restore,
            docs::commands::notes_empty_trash,
            docs::commands::notes_vacuum,
            docs::commands::doc_push,
            docs::commands::doc_pull,
            mcp::get_mcp_connection_info,
            mcp::start_mcp_server,
            mcp::set_mcp_permissions,
            mcp::stop_mcp_server,
            clipboard::commands::clip_list,
            clipboard::commands::clip_reveal,
            clipboard::commands::clip_select,
            clipboard::commands::clip_delete,
            clipboard::commands::clip_close,
            clipboard::commands::clip_shown,
            clipboard::commands::clip_hidden,
            clipboard::commands::clip_start_drag,
            clipboard::commands::clip_set_config,
            clipboard::commands::clip_set_theme,
            quit::quit_handler_ready,
            quit::quit_window_done,
            clipboard::commands::open_accessibility_settings,
            quicknotes::commands::qn_close,
            quicknotes::commands::qn_start_drag,
            quicknotes::commands::qn_get_config,
            quicknotes::commands::qn_set_hotkey,
            quicknotes::commands::qn_dismiss_intro,
            quicknotes::commands::qn_show,
            quicknotes::commands::show_main_window,
            files::commands::file_open_dialog,
            files::commands::file_save_as_dialog,
            files::commands::file_read,
            files::commands::file_write,
            files::commands::file_lists,
            files::commands::file_set_open,
            files::commands::file_take_pending,
            files::commands::file_forget_recent,
            files::commands::file_confirm_discard
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            clipboard::tray::install(app.handle())?;
            // Without a notes collection the rest of the app still works; the
            // Quick Notes page reports the failure when it asks for one.
            if let Err(error) = docs::commands::start(app.handle()) {
                eprintln!("Could not open the notes collection: {error}");
            }
            quicknotes::start(app.handle());
            files::start(app.handle());
            quicknotes::restore_windows(app.handle());
            // Windows and Linux pass "Open With" files as arguments at launch.
            #[cfg(not(target_os = "macos"))]
            files::open_from_system(app.handle(), files::paths_from_args(std::env::args()));
            Ok(())
        })
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| match event {
            // Tauri asks this when the last window is gone, which only happens if a
            // window was destroyed from outside; save through every window first.
            tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } => {
                api.prevent_exit();
                quit::request(app);
            }
            // Logout and the Dock's Quit terminate without an ExitRequested, so
            // wipe here too; shutdown is idempotent.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Exit => {
                app.state::<clipboard::runtime::ClipboardRuntime>()
                    .shutdown();
                clipboard::popup::destroy(app);
            }
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => clipboard::tray::show_main(app),
            // Finder's "Open With" and double-clicks, at launch or later.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Opened { urls } => files::open_from_system(
                app,
                urls.iter()
                    .filter_map(|url| url.to_file_path().ok())
                    .collect(),
            ),
            // Tauri has unregistered the label by now, so a popup re-enabled while
            // the old one was being destroyed can be created.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Destroyed,
                ..
            } if label == clipboard::commands::POPUP_LABEL => clipboard::popup::on_destroyed(app),
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::workspace::tests::temporary_db_path;

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
    fn native_preferences_are_owner_readable_only() {
        let path = temporary_db_path("preferences-mode").with_extension("json");
        write_preferences(&path, &AppPreferences::default()).expect("preferences should save");
        #[cfg(unix)]
        assert_eq!(mode_of(&path), 0o600);
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
}
