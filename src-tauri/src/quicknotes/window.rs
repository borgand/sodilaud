// SPDX-License-Identifier: GPL-3.0-or-later

// The panel window is created once at start-up, hidden, and never destroyed: its
// page keeps autosaving and answering agent requests while it is off screen. On
// macOS it is a non-activating floating panel, so showing it neither brings
// Sodilaud to the front nor changes the Cmd-Tab order. Elsewhere it is an
// ordinary always-on-top window.

use std::thread;
use std::time::Duration;

use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

use super::config::{clamp_frame, Frame, Screen, DEFAULT_HEIGHT, DEFAULT_WIDTH};
use super::QuickNotes;

pub const LABEL: &str = "quicknotes";
pub const MAIN_LABEL: &str = "main";
pub const FOCUS_NOTE_EVENT: &str = "quicknotes-focus-note";
pub const OPEN_SECTION_EVENT: &str = "sodilaud-open-section";
const GEOMETRY_SAVE_DELAY: Duration = Duration::from_millis(300);
const MIN_WIDTH: f64 = 420.0;
const MIN_HEIGHT: f64 = 320.0;

#[derive(Clone, serde::Serialize)]
struct FocusNote {
    title: String,
}

/// Builds the hidden panel unless it exists. Must run on the main thread.
pub fn ensure_created(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(window) = app.get_webview_window(LABEL) {
        return Some(window);
    }
    let window = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("notes.html".into()))
        .title("Quick Notes")
        .decorations(false)
        .always_on_top(true)
        .resizable(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .inner_size(DEFAULT_WIDTH, DEFAULT_HEIGHT)
        .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
        // Keeps WebKit from suspending the page while the panel is hidden, so
        // autosave timers and agent writes still run.
        .background_throttling(BackgroundThrottlingPolicy::Disabled)
        .visible(false)
        .build()
        .map_err(|error| eprintln!("Could not create the Quick Notes window: {error}"))
        .ok()?;
    #[cfg(target_os = "macos")]
    if let Err(refusal) = crate::platform::panel::make_floating_panel(
        &window,
        crate::platform::panel::PanelStyle::Floating,
    ) {
        eprintln!("Quick Notes opens as an ordinary window: {refusal:?}");
    }
    Some(window)
}

pub fn is_visible(app: &AppHandle) -> bool {
    app.get_webview_window(LABEL)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
}

/// Must run on the main thread.
pub fn toggle(app: &AppHandle) {
    if is_visible(app) {
        hide(app);
    } else {
        show(app, None);
    }
}

/// Shows the panel where it was, back on a visible screen if needed, and asks the
/// page to select the note titled `focus_note` when one is given.
pub fn show(app: &AppHandle, focus_note: Option<String>) {
    let Some(window) = ensure_created(app) else {
        return;
    };
    let saved = app.state::<QuickNotes>().config().frame;
    if let Some(frame) = placement(&window, saved) {
        let _ = window.set_size(PhysicalSize::new(frame.width, frame.height));
        let _ = window.set_position(PhysicalPosition::new(frame.x, frame.y));
    }
    present(&window);
    if let Some(title) = focus_note {
        let _ = window.emit_to(LABEL, FOCUS_NOTE_EVENT, FocusNote { title });
    }
}

#[cfg(target_os = "macos")]
fn present(window: &WebviewWindow) {
    if !crate::platform::panel::order_front_key(window) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(not(target_os = "macos"))]
fn present(window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

pub fn hide(app: &AppHandle) {
    let Some(window) = app.get_webview_window(LABEL) else {
        return;
    };
    #[cfg(target_os = "macos")]
    crate::platform::panel::order_out(&window);
    let _ = window.hide();
}

fn placement(window: &WebviewWindow, saved: Option<Frame>) -> Option<Frame> {
    let screens: Vec<Screen> = window
        .available_monitors()
        .ok()?
        .iter()
        .map(|monitor| {
            let area = monitor.work_area();
            Screen {
                frame: Frame {
                    x: f64::from(area.position.x),
                    y: f64::from(area.position.y),
                    width: f64::from(area.size.width),
                    height: f64::from(area.size.height),
                },
                scale: monitor.scale_factor(),
            }
        })
        .collect();
    let pointer = window
        .cursor_position()
        .ok()
        .and_then(|cursor| {
            screens.iter().copied().find(|screen| {
                let frame = screen.frame;
                cursor.x >= frame.x
                    && cursor.x < frame.x + frame.width
                    && cursor.y >= frame.y
                    && cursor.y < frame.y + frame.height
            })
        })
        .or_else(|| screens.first().copied())?;
    Some(clamp_frame(saved, &screens, &pointer))
}

/// Saves the frame once moving or resizing has paused.
fn schedule_geometry_save(window: &tauri::Window) {
    let app = window.app_handle().clone();
    let generation = app.state::<QuickNotes>().next_geometry_generation();
    thread::spawn(move || {
        thread::sleep(GEOMETRY_SAVE_DELAY);
        let quick_notes = app.state::<QuickNotes>();
        if !quick_notes.is_latest_geometry(generation) {
            return;
        }
        let Some(window) = app.get_webview_window(LABEL) else {
            return;
        };
        if !window.is_visible().unwrap_or(false) {
            return;
        }
        let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) else {
            return;
        };
        let frame = Frame {
            x: f64::from(position.x),
            y: f64::from(position.y),
            width: f64::from(size.width),
            height: f64::from(size.height),
        };
        quick_notes.update(|config| config.frame = Some(frame));
    });
}

pub fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    if window.label() != LABEL {
        return;
    }
    match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => schedule_geometry_save(window),
        // Cmd+W and the like: keep the one panel window and hide it instead.
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            hide(window.app_handle());
        }
        _ => {}
    }
}

/// Shows the main window, and opens `section` of it ("help" or "settings").
pub fn show_main(app: &AppHandle, section: Option<String>) {
    #[cfg(target_os = "macos")]
    crate::clipboard::tray::show_main(app);
    #[cfg(not(target_os = "macos"))]
    if let Some(window) = app.get_webview_window(MAIN_LABEL) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    if let Some(section) = section {
        let _ = app.emit_to(MAIN_LABEL, OPEN_SECTION_EVENT, section);
    }
}
