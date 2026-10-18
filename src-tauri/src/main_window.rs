// SPDX-License-Identifier: GPL-3.0-or-later

// The main windows: the editor windows labelled `main`, `main-2`, ...

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::files::commands::OPEN_REQUEST_EVENT;
use crate::files::windows::is_main_label;
use crate::files::Files;

/// The main windows that exist right now.
pub fn labels(app: &AppHandle) -> Vec<String> {
    app.webview_windows()
        .into_keys()
        .filter(|label| is_main_label(label))
        .collect()
}

/// Sends an event to every main window, and to no other.
pub fn emit_all<S: Serialize + Clone>(app: &AppHandle, event: &str, payload: S) {
    for label in labels(app) {
        let _ = app.emit_to(label.as_str(), event, payload.clone());
    }
}

pub fn show(app: &AppHandle, label: &str) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Shows the window and tells its page to take the files queued for it.
pub fn present(app: &AppHandle, label: &str) {
    show(app, label);
    let _ = app.emit_to(label, OPEN_REQUEST_EVENT, ());
}

/// Shows the main window an app-wide action belongs to: the one focused last.
pub fn show_target(app: &AppHandle) -> Option<String> {
    let label = app
        .try_state::<Files>()?
        .read(|lists| lists.windows.target());
    app.get_webview_window(&label)?;
    show(app, &label);
    Some(label)
}

/// Hides every main window, leaving Sodilaud in the menu bar.
#[cfg(target_os = "macos")]
pub fn hide_all(app: &AppHandle) {
    for label in labels(app) {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.hide();
        }
    }
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
}
