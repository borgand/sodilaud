// SPDX-License-Identifier: GPL-3.0-or-later

// Quick Notes: the notes collection in a floating panel, one hotkey away. The
// panel's page (notes.html) owns the notes; this module owns the window, its
// hotkey and its geometry.

pub mod commands;
pub mod config;
pub mod hotkey;
pub mod window;

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};

use tauri::{AppHandle, Manager};

use config::QuickNotesConfig;

pub struct QuickNotes {
    path: Option<PathBuf>,
    config: Mutex<QuickNotesConfig>,
    /// The hotkey actually registered; `None` when none is.
    registered: Mutex<Option<String>>,
    geometry_generation: AtomicU64,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl QuickNotes {
    /// Reads the saved config, and writes it back at once when it is new so that
    /// only the first launch after an upgrade counts as one.
    pub fn load(app: &AppHandle) -> Self {
        let directory = app.path().app_config_dir().ok();
        let path = directory.as_ref().map(|dir| dir.join(config::FILE_NAME));
        let existing = path.as_deref().and_then(config::load);
        let is_new = existing.is_none();
        let earlier_release_ran = directory
            .as_ref()
            .is_some_and(|dir| dir.join(crate::PREFERENCES_FILE_NAME).is_file());
        let quick_notes = Self {
            path,
            config: Mutex::new(config::initial(existing, earlier_release_ran)),
            registered: Mutex::new(None),
            geometry_generation: AtomicU64::new(0),
        };
        if is_new {
            quick_notes.persist();
        }
        quick_notes
    }

    pub fn config(&self) -> QuickNotesConfig {
        lock(&self.config).clone()
    }

    pub fn update(&self, change: impl FnOnce(&mut QuickNotesConfig)) {
        change(&mut lock(&self.config));
        self.persist();
    }

    fn persist(&self) {
        let Some(path) = &self.path else {
            return;
        };
        let snapshot = self.config();
        if let Err(error) = config::save(path, &snapshot) {
            eprintln!("{error}");
        }
    }

    pub fn registered_hotkey(&self) -> Option<String> {
        lock(&self.registered).clone()
    }

    fn set_registered_hotkey(&self, hotkey: Option<String>) {
        *lock(&self.registered) = hotkey;
    }

    /// A new generation for a geometry change; only the latest one is saved.
    fn next_geometry_generation(&self) -> u64 {
        self.geometry_generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn is_latest_geometry(&self, generation: u64) -> bool {
        self.geometry_generation.load(Ordering::SeqCst) == generation
    }
}

/// Called from setup: loads the config, builds the hidden panel and registers the
/// saved hotkey. Must run on the main thread.
pub fn start(app: &AppHandle) {
    app.manage(QuickNotes::load(app));
    window::ensure_created(app);
    let requested = app.state::<QuickNotes>().config().hotkey;
    let status = hotkey::apply(app, &requested);
    if let Some(error) = status.hotkey_error {
        eprintln!("The Quick Notes hotkey {requested} could not be registered: {error:?}");
    }
    refresh_tray(app);
}

/// Shows the registered hotkey next to the tray's Quick Notes item.
pub fn refresh_tray(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    crate::clipboard::tray::refresh_quick_notes(
        app,
        app.state::<QuickNotes>().registered_hotkey().as_deref(),
    );
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Shows the windows that were showing at the last quit. The first launch, or a
/// quit with both hidden, shows the main window so a launch always shows something.
pub fn restore_windows(app: &AppHandle) {
    let saved = app.state::<QuickNotes>().config().windows_at_quit;
    let (main, panel) = startup_windows(saved);
    if panel {
        window::show(app, None);
    }
    if main {
        window::show_main(app, None);
    } else {
        #[cfg(target_os = "macos")]
        crate::clipboard::tray::hide_main(app);
    }
}

/// Which of (main, Quick Notes) to show at launch.
pub fn startup_windows(saved: Option<config::WindowsAtQuit>) -> (bool, bool) {
    match saved {
        None => (true, false),
        Some(windows) => (windows.main || !windows.quicknotes, windows.quicknotes),
    }
}

#[cfg(test)]
mod tests {
    use super::config::WindowsAtQuit;
    use super::startup_windows;

    #[test]
    fn launch_restores_the_windows_that_were_showing() {
        let saved = |main, quicknotes| Some(WindowsAtQuit { main, quicknotes });
        assert_eq!(startup_windows(None), (true, false));
        assert_eq!(startup_windows(saved(true, true)), (true, true));
        assert_eq!(startup_windows(saved(false, true)), (false, true));
        assert_eq!(startup_windows(saved(true, false)), (true, false));
        assert_eq!(startup_windows(saved(false, false)), (true, false));
    }
}
