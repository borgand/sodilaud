// SPDX-License-Identifier: GPL-3.0-or-later

// Popup commands check the calling window as well as relying on the capability,
// so a future capability edit cannot hand entries to the main window.

use tauri::{AppHandle, Window};

#[cfg(target_os = "macos")]
use tauri::Manager;

use super::service::{ClipConfig, ClipError, ClipListing};

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
pub fn clip_reveal(window: Window, id: u64) -> Result<String, ClipError> {
    require_popup(&window)?;
    #[cfg(target_os = "macos")]
    {
        window
            .state::<ClipboardRuntime>()
            .reveal(id)
            .map(|secret| secret.as_str().to_owned())
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
        Ok(window.state::<ClipboardRuntime>().select(id))
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
