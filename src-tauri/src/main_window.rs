// SPDX-License-Identifier: GPL-3.0-or-later

// The main windows: the editor windows labelled `main`, `main-2`, ...

use tauri::{AppHandle, Emitter, Manager};

use crate::files::commands::OPEN_REQUEST_EVENT;

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
