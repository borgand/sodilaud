// SPDX-License-Identifier: GPL-3.0-or-later

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, PoisonError};

use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication, NSWorkspace};
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use super::hygiene::{disable_core_dumps, now_ms, silence_clipboard_panics};
use super::pasteboard::MacPasteboard;
use super::popup;
use super::popup_state::{needs_hide, PopupState};
use super::service::{
    plan_hotkey, ClipConfig, ClipError, ClipListing, HotkeyPlan, PopupTheme, Secret, Service,
};
use super::watcher::{self, SharedService, Watcher};

pub const STOPPED_EVENT: &str = "clipboard-history-stopped";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigStatus {
    pub enabled: bool,
    /// The hotkey actually registered; empty when none is.
    pub hotkey: String,
    pub hotkey_error: Option<ClipError>,
    pub accessibility_trusted: bool,
}

#[derive(Default)]
pub struct ClipboardRuntime {
    service: SharedService,
    watcher: Mutex<Option<Watcher>>,
    config: Mutex<ClipConfig>,
    registered: Mutex<Option<String>>,
    frontmost_pid: Mutex<Option<i32>>,
    paste_on_close: AtomicBool,
    popup: Mutex<PopupState>,
    quit_handler_ready: AtomicBool,
    /// The main window's colours for the popup, memory only. Never persisted.
    theme: Mutex<PopupTheme>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl ClipboardRuntime {
    pub fn config(&self) -> ClipConfig {
        lock(&self.config).clone()
    }

    pub fn apply_config(&self, app: &AppHandle, requested: ClipConfig) -> ConfigStatus {
        let requested = requested.normalized();
        let mut registered = lock(&self.registered);
        let mut hotkey_error = None;

        let wanted = requested.enabled.then_some(requested.hotkey.as_str());
        match plan_hotkey(registered.as_deref(), wanted) {
            HotkeyPlan::Keep => {}
            HotkeyPlan::Register {
                new,
                unregister_old,
            } => {
                if unregister_old
                    .as_deref()
                    .is_some_and(|old| same_shortcut(old, &new))
                {
                    *registered = Some(new);
                } else {
                    match register_hotkey(app, &new, unregister_old.as_deref()) {
                        Ok(()) => *registered = Some(new),
                        Err(error) => hotkey_error = Some(error),
                    }
                }
            }
            HotkeyPlan::Unregister(old) => {
                unregister_hotkey(app, &old);
                *registered = None;
            }
        }

        if requested.enabled {
            self.start_or_update(app, &requested);
        } else {
            self.stop(app);
        }

        *lock(&self.config) = requested.clone();
        super::tray::refresh(app, requested.enabled, registered.as_deref());
        ConfigStatus {
            enabled: requested.enabled,
            hotkey: registered.clone().unwrap_or_default(),
            hotkey_error,
            accessibility_trusted: accessibility_trusted(),
        }
    }

    fn start_or_update(&self, app: &AppHandle, config: &ClipConfig) {
        let mut service = lock(&self.service);
        match service.as_mut() {
            Some(active) => active.set_limits(config.capacity, config.ttl_ms(), now_ms()),
            None => {
                silence_clipboard_panics();
                disable_core_dumps();
                *service = Some(Service::new(
                    MacPasteboard,
                    config.capacity,
                    config.ttl_ms(),
                ));
                drop(service);
                let emitter = app.clone();
                let on_panic = move || {
                    let _ = emitter.emit_to("main", STOPPED_EVENT, ());
                };
                *lock(&self.watcher) = Some(watcher::spawn(on_panic, self.service.clone()));
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || {
                    popup::ensure_created(&handle);
                });
            }
        }
    }

    fn stop(&self, app: &AppHandle) {
        self.halt();
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || popup::destroy(&handle));
    }

    fn halt(&self) {
        lock(&self.watcher).take();
        lock(&self.service).take();
    }

    pub fn listing(&self) -> ClipListing {
        let ttl_minutes = self.config().ttl_minutes;
        let items = lock(&self.service)
            .as_mut()
            .map(|service| service.list(now_ms()))
            .unwrap_or_default();
        ClipListing {
            ttl_minutes,
            items,
            theme: self.theme(),
        }
    }

    pub fn theme(&self) -> PopupTheme {
        lock(&self.theme).clone()
    }

    pub fn set_theme(&self, theme: PopupTheme) {
        *lock(&self.theme) = theme.validated();
    }

    pub fn reveal(&self, id: u64) -> Option<Secret> {
        lock(&self.service).as_mut()?.reveal(id, now_ms())
    }

    pub fn select(&self, id: u64) -> bool {
        lock(&self.service)
            .as_mut()
            .is_some_and(|service| service.select(id, now_ms()))
    }

    pub fn delete(&self, id: u64) -> bool {
        lock(&self.service)
            .as_mut()
            .is_some_and(|service| service.delete(id))
    }

    pub fn clear(&self) {
        if let Some(service) = lock(&self.service).as_mut() {
            service.wipe();
        }
    }

    pub fn len(&self) -> usize {
        lock(&self.service).as_ref().map_or(0, Service::len)
    }

    pub fn remember_frontmost(&self) {
        *lock(&self.frontmost_pid) = frontmost_pid();
    }

    pub fn forget_frontmost(&self) {
        lock(&self.frontmost_pid).take();
    }

    pub fn popup_state(&self) -> PopupState {
        *lock(&self.popup)
    }

    /// Returns the previous state.
    pub fn set_popup_state(&self, state: PopupState) -> PopupState {
        std::mem::replace(&mut *lock(&self.popup), state)
    }

    /// Showing or shown: the page may be asked for entries.
    pub fn popup_open(&self) -> bool {
        needs_hide(self.popup_state())
    }

    /// Returns the pid a paste may target: the remembered app, if it is another
    /// process. It is reactivated only if Sodilaud became frontmost meanwhile; the
    /// panel normally leaves it frontmost, and activating it anyway would pull it
    /// in front of an app the user clicked to dismiss the popup.
    pub fn restore_frontmost(&self) -> Option<i32> {
        let pid = lock(&self.frontmost_pid).take()?;
        if pid == own_pid() {
            return None;
        }
        if should_reactivate(frontmost_pid(), own_pid()) {
            let app = NSRunningApplication::runningApplicationWithProcessIdentifier(pid)?;
            #[allow(deprecated)]
            let activated =
                app.activateWithOptions(NSApplicationActivationOptions::ActivateIgnoringOtherApps);
            if !activated {
                return None;
            }
        }
        Some(pid)
    }

    pub fn request_paste_on_close(&self) {
        let wanted = self.config().auto_paste && accessibility_trusted();
        self.paste_on_close.store(wanted, Ordering::SeqCst);
    }

    pub fn take_paste_on_close(&self) -> bool {
        self.paste_on_close.swap(false, Ordering::SeqCst)
    }

    pub fn mark_quit_handler_ready(&self) {
        self.quit_handler_ready.store(true, Ordering::SeqCst);
    }

    pub fn quit_handler_ready(&self) -> bool {
        self.quit_handler_ready.load(Ordering::SeqCst)
    }

    /// Called on quit: stop polling, wipe, clear the pasteboard if it holds an entry.
    pub fn shutdown(&self) {
        self.halt();
    }
}

pub fn frontmost_pid() -> Option<i32> {
    NSWorkspace::sharedWorkspace()
        .frontmostApplication()
        .map(|app| app.processIdentifier())
}

pub fn own_pid() -> i32 {
    std::process::id() as i32
}

/// Cmd+V goes only to the app focus was restored to, checked right before posting,
/// so a secret can never land in Sodilaud's own editor or an unrelated app.
pub fn should_paste(target: i32, frontmost: Option<i32>, own: i32) -> bool {
    target != own && frontmost == Some(target)
}

/// On popup close, give focus back only if Sodilaud holds it (the popup fell back
/// to activating the app). Any other frontmost app is where the user wants to be.
pub fn should_reactivate(frontmost: Option<i32>, own: i32) -> bool {
    frontmost == Some(own)
}

fn register_hotkey(app: &AppHandle, hotkey: &str, old: Option<&str>) -> Result<(), ClipError> {
    let shortcut: Shortcut = hotkey.parse().map_err(|_| ClipError::HotkeyInvalid)?;
    app.global_shortcut()
        .on_shortcut(shortcut, |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                // Carbon delivers hotkeys on the main run loop today; this keeps
                // toggle() on the main thread even if that changes (inline if already there).
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || popup::toggle(&handle));
            }
        })
        .map_err(|_| ClipError::HotkeyUnavailable)?;
    if let Some(old) = old.and_then(|old| old.parse::<Shortcut>().ok()) {
        if old != shortcut {
            let _ = app.global_shortcut().unregister(old);
        }
    }
    Ok(())
}

/// Two spellings of one chord, such as `shift+super+KeyV` and `super+shift+KeyV`.
fn same_shortcut(a: &str, b: &str) -> bool {
    matches!((a.parse::<Shortcut>(), b.parse::<Shortcut>()), (Ok(a), Ok(b)) if a == b)
}

fn unregister_hotkey(app: &AppHandle, hotkey: &str) {
    if let Ok(shortcut) = hotkey.parse::<Shortcut>() {
        let _ = app.global_shortcut().unregister(shortcut);
    }
}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
}

pub fn accessibility_trusted() -> bool {
    // SAFETY: AXIsProcessTrusted takes no arguments and only reads process state.
    unsafe { AXIsProcessTrusted() }
}

#[cfg(test)]
mod tests {
    use super::{should_paste, should_reactivate};

    const OWN: i32 = 100;
    const TARGET: i32 = 200;

    #[test]
    fn pastes_only_into_the_restored_app_while_it_is_frontmost() {
        assert!(should_paste(TARGET, Some(TARGET), OWN));
    }

    #[test]
    fn does_not_paste_when_another_app_is_frontmost() {
        assert!(!should_paste(TARGET, Some(300), OWN));
        assert!(!should_paste(TARGET, Some(OWN), OWN));
        assert!(!should_paste(TARGET, None, OWN));
    }

    #[test]
    fn never_pastes_into_sodilaud_itself() {
        assert!(!should_paste(OWN, Some(OWN), OWN));
    }

    #[test]
    fn reactivates_only_when_sodilaud_took_frontmost() {
        assert!(should_reactivate(Some(OWN), OWN));
    }

    #[test]
    fn leaves_activation_alone_when_another_app_is_frontmost() {
        assert!(!should_reactivate(Some(TARGET), OWN));
        assert!(!should_reactivate(None, OWN));
    }
}
