// SPDX-License-Identifier: GPL-3.0-or-later

use std::sync::{Mutex, PoisonError};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::hygiene::{disable_core_dumps, now_ms, silence_clipboard_panics};
use super::pasteboard::MacPasteboard;
use super::service::{ClipConfig, ClipError, ClipListing, Secret, Service};
use super::watcher::{self, SharedService, Watcher};

pub const STOPPED_EVENT: &str = "clipboard-history-stopped";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigStatus {
    pub enabled: bool,
    pub hotkey: String,
    pub hotkey_error: Option<ClipError>,
    pub accessibility_trusted: bool,
}

#[derive(Default)]
pub struct ClipboardRuntime {
    service: SharedService,
    watcher: Mutex<Option<Watcher>>,
    config: Mutex<ClipConfig>,
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
        let previous = self.config();
        let mut applied = requested.clone();
        let mut hotkey_error = None;

        if requested.enabled {
            let old = previous.enabled.then_some(previous.hotkey.as_str());
            if old != Some(requested.hotkey.as_str()) {
                if let Err(error) = register_hotkey(app, &requested.hotkey, old) {
                    hotkey_error = Some(error);
                    applied.hotkey = previous.hotkey.clone();
                }
            }
            self.start_or_update(app, &applied);
        } else {
            if previous.enabled {
                unregister_hotkey(app, &previous.hotkey);
            }
            self.stop();
        }

        *lock(&self.config) = applied.clone();
        ConfigStatus {
            enabled: applied.enabled,
            hotkey: applied.hotkey,
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
                let app = app.clone();
                let on_panic = move || {
                    let _ = app.emit_to("main", STOPPED_EVENT, ());
                };
                *lock(&self.watcher) = Some(watcher::spawn(on_panic, self.service.clone()));
            }
        }
    }

    fn stop(&self) {
        lock(&self.watcher).take();
        lock(&self.service).take();
    }

    pub fn listing(&self) -> ClipListing {
        let ttl_minutes = self.config().ttl_minutes;
        let items = lock(&self.service)
            .as_ref()
            .map(|service| service.list(now_ms()))
            .unwrap_or_default();
        ClipListing { ttl_minutes, items }
    }

    pub fn reveal(&self, id: u64) -> Option<Secret> {
        lock(&self.service).as_ref()?.reveal(id)
    }

    pub fn select(&self, id: u64) -> bool {
        lock(&self.service)
            .as_mut()
            .is_some_and(|service| service.select(id))
    }

    pub fn delete(&self, id: u64) -> bool {
        lock(&self.service)
            .as_mut()
            .is_some_and(|service| service.delete(id))
    }

    #[allow(dead_code)] // Used from Task 7 (tray "Clear" menu item).
    pub fn clear(&self) {
        if let Some(service) = lock(&self.service).as_mut() {
            service.wipe();
        }
    }

    #[allow(dead_code)] // Used from Task 6 (popup height depends on entry count).
    pub fn len(&self) -> usize {
        lock(&self.service).as_ref().map_or(0, Service::len)
    }

    /// Called on quit: stop polling, wipe, clear the pasteboard if it holds an entry.
    #[allow(dead_code)] // Used from Task 7 (quit flow).
    pub fn shutdown(&self) {
        self.stop();
    }
}

// Replaced in Task 6.
fn register_hotkey(_app: &AppHandle, _hotkey: &str, _old: Option<&str>) -> Result<(), ClipError> {
    Ok(())
}

// Replaced in Task 6.
fn unregister_hotkey(_app: &AppHandle, _hotkey: &str) {}

// Replaced in Task 6.
fn accessibility_trusted() -> bool {
    false
}
