// SPDX-License-Identifier: GPL-3.0-or-later

// Popup commands check the calling window as well as relying on the capability,
// so a future capability edit cannot hand entries to the main window.

use tauri::{AppHandle, Window};

#[cfg(target_os = "macos")]
use tauri::Manager;

use super::service::{ClipConfig, ClipError, ClipListing, Secret};

pub const POPUP_LABEL: &str = "clipboard";

#[cfg(target_os = "macos")]
use super::runtime::{ClipboardRuntime, ConfigStatus};

// Stands in for the real, macOS-only status on other platforms so the command
// signature below does not need to change per platform.
#[cfg(not(target_os = "macos"))]
#[derive(serde::Serialize)]
#[allow(dead_code)] // Never constructed: the feature does not build here.
pub struct ConfigStatus;

fn require_popup(window: &Window) -> Result<(), ClipError> {
    if window.label() == POPUP_LABEL {
        Ok(())
    } else {
        Err(ClipError::WrongWindow)
    }
}

#[tauri::command]
pub fn clip_list(window: Window) -> Result<ClipListing, ClipError> {
    require_popup(&window)?;
    #[cfg(target_os = "macos")]
    {
        Ok(window.state::<ClipboardRuntime>().listing())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(ClipError::Unsupported)
    }
}

#[tauri::command]
/// Returns the entry's own zeroizing copy, so nothing outlives serialization here.
pub fn clip_reveal(window: Window, id: u64) -> Result<Secret, ClipError> {
    require_popup(&window)?;
    #[cfg(target_os = "macos")]
    {
        window
            .state::<ClipboardRuntime>()
            .reveal(id)
            .ok_or(ClipError::Disabled)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = id;
        Err(ClipError::Unsupported)
    }
}

#[tauri::command]
pub fn clip_select(window: Window, id: u64) -> Result<bool, ClipError> {
    require_popup(&window)?;
    #[cfg(target_os = "macos")]
    {
        let runtime = window.state::<ClipboardRuntime>();
        let picked = runtime.select(id);
        if picked {
            runtime.request_paste_on_close();
            super::popup::close(window.app_handle());
        }
        Ok(picked)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = id;
        Err(ClipError::Unsupported)
    }
}

#[tauri::command]
pub fn clip_delete(window: Window, id: u64) -> Result<bool, ClipError> {
    require_popup(&window)?;
    #[cfg(target_os = "macos")]
    {
        Ok(window.state::<ClipboardRuntime>().delete(id))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = id;
        Err(ClipError::Unsupported)
    }
}

#[tauri::command]
pub fn clip_set_config(app: AppHandle, config: ClipConfig) -> Result<ConfigStatus, ClipError> {
    #[cfg(target_os = "macos")]
    {
        Ok(app.state::<ClipboardRuntime>().apply_config(&app, config))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, config);
        Err(ClipError::Unsupported)
    }
}

#[tauri::command]
pub fn hide_main_window(app: AppHandle) -> bool {
    #[cfg(target_os = "macos")]
    {
        super::tray::hide_main(&app);
        true
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        false
    }
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    #[cfg(target_os = "macos")]
    app.state::<ClipboardRuntime>().shutdown();
    app.exit(0);
}

#[tauri::command]
pub fn quit_handler_ready(app: AppHandle) {
    #[cfg(target_os = "macos")]
    app.state::<ClipboardRuntime>().mark_quit_handler_ready();
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

#[tauri::command]
pub fn open_accessibility_settings(app: AppHandle) -> Result<(), ClipError> {
    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_opener::OpenerExt;
        app.opener()
            .open_url(
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
                None::<&str>,
            )
            .map_err(|_| ClipError::Internal)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err(ClipError::Unsupported)
    }
}
