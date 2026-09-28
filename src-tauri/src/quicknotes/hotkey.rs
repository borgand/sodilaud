// SPDX-License-Identifier: GPL-3.0-or-later

// The Quick Notes global hotkey. The requested hotkey is always saved; the one
// registered is reported separately, so a rejected hotkey is retried on the next
// change and the previous one stays active meanwhile.

use serde::Serialize;
use tauri::AppHandle;
use tauri::Manager;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use super::window;
use super::QuickNotes;
use crate::clipboard::service::{plan_hotkey, HotkeyPlan};

/// Payload-free, serialized with the same names the clipboard settings use.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum QnError {
    WrongWindow,
    HotkeyInvalid,
    HotkeyUnavailable,
    Internal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyStatus {
    /// The hotkey actually registered; empty when none is.
    pub hotkey: String,
    /// The hotkey the user chose, which may differ after an error.
    pub requested: String,
    pub hotkey_error: Option<QnError>,
    pub upgrade_intro: bool,
}

/// Two spellings of one chord, such as `shift+super+KeyN` and `super+shift+KeyN`.
pub fn same_shortcut(a: &str, b: &str) -> bool {
    matches!((a.parse::<Shortcut>(), b.parse::<Shortcut>()), (Ok(a), Ok(b)) if a == b)
}

/// Why `requested` cannot be the Quick Notes hotkey, before asking the system.
pub fn check(requested: &str, taken: &[String]) -> Result<(), QnError> {
    requested
        .parse::<Shortcut>()
        .map_err(|_| QnError::HotkeyInvalid)?;
    if taken.iter().any(|other| same_shortcut(other, requested)) {
        return Err(QnError::HotkeyUnavailable);
    }
    Ok(())
}

/// Hotkeys other Sodilaud features hold, which Quick Notes must not take.
fn taken_hotkeys(app: &AppHandle) -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        app.state::<crate::clipboard::runtime::ClipboardRuntime>()
            .registered_hotkey()
            .into_iter()
            .collect()
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Vec::new()
    }
}

/// Registers `requested` (replacing the registered hotkey on success), saves it
/// as the user's choice, and reports the outcome.
pub fn apply(app: &AppHandle, requested: &str) -> HotkeyStatus {
    let quick_notes = app.state::<QuickNotes>();
    let registered = quick_notes.registered_hotkey();
    let mut hotkey_error = None;
    match plan_hotkey(registered.as_deref(), Some(requested)) {
        HotkeyPlan::Keep | HotkeyPlan::Unregister(_) => {}
        HotkeyPlan::Register {
            new,
            unregister_old,
        } => {
            if unregister_old
                .as_deref()
                .is_some_and(|old| same_shortcut(old, &new))
            {
                quick_notes.set_registered_hotkey(Some(new));
            } else {
                match check(&new, &taken_hotkeys(app))
                    .and_then(|()| register(app, &new, unregister_old.as_deref()))
                {
                    Ok(()) => quick_notes.set_registered_hotkey(Some(new)),
                    Err(error) => hotkey_error = Some(error),
                }
            }
        }
    }
    quick_notes.update(|config| config.hotkey = requested.to_string());
    status(app, hotkey_error)
}

pub fn status(app: &AppHandle, hotkey_error: Option<QnError>) -> HotkeyStatus {
    let quick_notes = app.state::<QuickNotes>();
    let config = quick_notes.config();
    HotkeyStatus {
        hotkey: quick_notes.registered_hotkey().unwrap_or_default(),
        requested: config.hotkey,
        hotkey_error,
        upgrade_intro: config.upgrade_intro,
    }
}

fn register(app: &AppHandle, hotkey: &str, old: Option<&str>) -> Result<(), QnError> {
    let shortcut: Shortcut = hotkey.parse().map_err(|_| QnError::HotkeyInvalid)?;
    app.global_shortcut()
        .on_shortcut(shortcut, |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || window::toggle(&handle));
            }
        })
        .map_err(|_| QnError::HotkeyUnavailable)?;
    if let Some(old) = old.and_then(|old| old.parse::<Shortcut>().ok()) {
        if old != shortcut {
            let _ = app.global_shortcut().unregister(old);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_free_chord() {
        assert_eq!(check("super+shift+KeyN", &[]), Ok(()));
    }

    #[test]
    fn rejects_an_unparseable_chord() {
        assert_eq!(check("super+shift+Nope", &[]), Err(QnError::HotkeyInvalid));
    }

    #[test]
    fn refuses_the_clipboard_hotkey_in_any_spelling() {
        let taken = vec!["super+shift+KeyV".to_string()];
        assert_eq!(
            check("shift+super+KeyV", &taken),
            Err(QnError::HotkeyUnavailable)
        );
        assert_eq!(check("super+shift+KeyN", &taken), Ok(()));
    }
}
