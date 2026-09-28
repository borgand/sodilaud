// SPDX-License-Identifier: GPL-3.0-or-later

use tauri::{AppHandle, Manager, Window};

use super::hotkey::{self, HotkeyStatus, QnError};
use super::window::{self, LABEL};
use super::QuickNotes;

fn require_panel(window: &Window) -> Result<(), QnError> {
    if window.label() == LABEL {
        Ok(())
    } else {
        Err(QnError::WrongWindow)
    }
}

/// Window calls need the main thread; this runs `action` inline when already there.
fn on_main(app: &AppHandle, action: impl FnOnce(&AppHandle) + Send + 'static) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || action(&handle));
}

/// The panel's close button and Cmd+W.
#[tauri::command]
pub fn qn_close(window: Window) -> Result<(), QnError> {
    require_panel(&window)?;
    on_main(window.app_handle(), window::hide);
    Ok(())
}

/// Lets the panel's header move it without granting it any window permission.
#[tauri::command]
pub fn qn_start_drag(window: Window) -> Result<(), QnError> {
    require_panel(&window)?;
    window.start_dragging().map_err(|_| QnError::Internal)
}

#[tauri::command]
pub fn qn_get_config(app: AppHandle) -> HotkeyStatus {
    hotkey::status(&app, None)
}

#[tauri::command]
pub fn qn_set_hotkey(app: AppHandle, hotkey: String) -> HotkeyStatus {
    let status = hotkey::apply(&app, &hotkey);
    crate::quicknotes::refresh_tray(&app);
    status
}

/// The start page's banner was dismissed or acted on; it never shows again.
#[tauri::command]
pub fn qn_dismiss_intro(app: AppHandle) {
    app.state::<QuickNotes>()
        .update(|config| config.upgrade_intro = false);
}

/// Shows the panel from the main window, optionally selecting a note by title.
#[tauri::command]
pub fn qn_show(app: AppHandle, focus_note_title: Option<String>) {
    on_main(&app, move |app| window::show(app, focus_note_title));
}

/// Shows the main window from the panel, optionally opening one of its sections.
#[tauri::command]
pub fn show_main_window(app: AppHandle, section: Option<String>) {
    let section = section.filter(|name| matches!(name.as_str(), "help" | "settings"));
    on_main(&app, move |app| window::show_main(app, section));
}
