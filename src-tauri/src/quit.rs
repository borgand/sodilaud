// SPDX-License-Identifier: GPL-3.0-or-later

// Quitting asks every window that registered a quit handler to save first, and
// exits only when all of them report success. A failure in any window cancels the
// quit and that window shows why. A window that never registered (its page did
// not load) has nothing to wait for.

use std::collections::BTreeSet;
use std::sync::{Mutex, PoisonError};

use tauri::{AppHandle, Emitter, Manager, Window};

use crate::quicknotes::{self, QuickNotes};

pub const QUIT_REQUESTED_EVENT: &str = "sodilaud-quit-requested";
/// Tells every window that saved for a quit that the app keeps running after all.
pub const QUIT_CANCELLED_EVENT: &str = "sodilaud-quit-cancelled";

#[derive(Debug, PartialEq, Eq)]
pub enum Begin {
    ExitNow,
    Ask(Vec<String>),
}

#[derive(Debug, PartialEq, Eq)]
pub enum QuitStep {
    Wait,
    Exit,
    Cancel,
}

#[derive(Default)]
pub struct QuitCoordinator {
    registered: BTreeSet<String>,
    pending: Option<BTreeSet<String>>,
}

impl QuitCoordinator {
    pub fn registered(&self) -> Vec<String> {
        self.registered.iter().cloned().collect()
    }

    pub fn register(&mut self, label: &str) {
        self.registered.insert(label.to_string());
    }

    /// Starts a quit, or re-asks the windows that have not answered yet when one
    /// is already under way (a second Cmd+Q retries a window that stalled).
    pub fn begin(&mut self) -> Begin {
        let pending = self.pending.get_or_insert_with(|| self.registered.clone());
        if pending.is_empty() {
            self.pending = None;
            Begin::ExitNow
        } else {
            Begin::Ask(pending.iter().cloned().collect())
        }
    }

    pub fn report(&mut self, label: &str, ok: bool) -> QuitStep {
        let Some(pending) = self.pending.as_mut() else {
            return QuitStep::Wait;
        };
        if !pending.contains(label) {
            return QuitStep::Wait;
        }
        if !ok {
            self.pending = None;
            return QuitStep::Cancel;
        }
        pending.remove(label);
        if pending.is_empty() {
            self.pending = None;
            QuitStep::Exit
        } else {
            QuitStep::Wait
        }
    }
}

#[derive(Default)]
pub struct QuitState(Mutex<QuitCoordinator>);

impl QuitState {
    fn with<T>(&self, action: impl FnOnce(&mut QuitCoordinator) -> T) -> T {
        action(&mut self.0.lock().unwrap_or_else(PoisonError::into_inner))
    }
}

/// Every quit starts here: the tray, Cmd+Q, and on Windows and Linux closing the
/// main window. The clipboard history is wiped first, whatever the saves do.
pub fn request(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        app.state::<crate::clipboard::runtime::ClipboardRuntime>()
            .shutdown();
        crate::clipboard::popup::destroy(app);
    }
    match app.state::<QuitState>().with(QuitCoordinator::begin) {
        Begin::ExitNow => exit(app),
        Begin::Ask(labels) => {
            for label in labels {
                let _ = app.emit_to(label.as_str(), QUIT_REQUESTED_EVENT, ());
            }
        }
    }
}

/// Remembers which windows were showing, so the next launch restores them.
fn exit(app: &AppHandle) {
    let visible = |label: &str| {
        app.get_webview_window(label)
            .and_then(|window| window.is_visible().ok())
            .unwrap_or(false)
    };
    let windows = quicknotes::config::WindowsAtQuit {
        main: visible(quicknotes::window::MAIN_LABEL),
        quicknotes: visible(quicknotes::window::LABEL),
    };
    if let Some(quick_notes) = app.try_state::<QuickNotes>() {
        quick_notes.update(|config| config.windows_at_quit = Some(windows));
    }
    app.exit(0);
}

/// Until a window calls this, a quit does not wait for it.
#[tauri::command]
pub fn quit_handler_ready(window: Window) {
    let label = window.label().to_string();
    window
        .state::<QuitState>()
        .with(|coordinator| coordinator.register(&label));
}

/// A window finished its quit-time save, successfully or not.
#[tauri::command]
pub fn quit_window_done(window: Window, ok: bool) {
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    let (step, windows) = app
        .state::<QuitState>()
        .with(|coordinator| (coordinator.report(&label, ok), coordinator.registered()));
    match step {
        QuitStep::Exit => exit(&app),
        QuitStep::Cancel => {
            for window in windows {
                let _ = app.emit_to(window.as_str(), QUIT_CANCELLED_EVENT, ());
            }
            // The panel reports its error itself, but only a visible panel can.
            if label == quicknotes::window::LABEL {
                let handle = app.clone();
                let _ = app.run_on_main_thread(move || quicknotes::window::show(&handle, None));
            }
        }
        QuitStep::Wait => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_windows(labels: &[&str]) -> QuitCoordinator {
        let mut coordinator = QuitCoordinator::default();
        for label in labels {
            coordinator.register(label);
        }
        coordinator
    }

    #[test]
    fn with_no_registered_window_the_app_exits_at_once() {
        assert_eq!(QuitCoordinator::default().begin(), Begin::ExitNow);
    }

    #[test]
    fn exits_once_every_window_saved() {
        let mut coordinator = with_windows(&["main", "quicknotes"]);
        assert_eq!(
            coordinator.begin(),
            Begin::Ask(vec!["main".into(), "quicknotes".into()])
        );
        assert_eq!(coordinator.report("quicknotes", true), QuitStep::Wait);
        assert_eq!(coordinator.report("main", true), QuitStep::Exit);
    }

    #[test]
    fn one_failed_save_cancels_and_late_answers_are_ignored() {
        let mut coordinator = with_windows(&["main", "quicknotes"]);
        coordinator.begin();
        assert_eq!(coordinator.report("quicknotes", false), QuitStep::Cancel);
        assert_eq!(coordinator.report("main", true), QuitStep::Wait);
        assert_eq!(
            coordinator.begin(),
            Begin::Ask(vec!["main".into(), "quicknotes".into()])
        );
    }

    #[test]
    fn answers_from_unknown_windows_or_outside_a_quit_are_ignored() {
        let mut coordinator = with_windows(&["quicknotes"]);
        assert_eq!(coordinator.report("quicknotes", true), QuitStep::Wait);
        coordinator.begin();
        assert_eq!(coordinator.report("clipboard", true), QuitStep::Wait);
        assert_eq!(coordinator.report("quicknotes", true), QuitStep::Exit);
    }

    #[test]
    fn a_repeated_request_asks_only_the_windows_still_saving() {
        let mut coordinator = with_windows(&["main", "quicknotes"]);
        coordinator.begin();
        coordinator.report("main", true);
        assert_eq!(coordinator.begin(), Begin::Ask(vec!["quicknotes".into()]));
    }
}
