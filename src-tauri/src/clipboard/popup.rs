// SPDX-License-Identifier: GPL-3.0-or-later

// The popup is one hidden panel created when the feature is enabled and then only
// shown and hidden. wry activates the app whenever it creates a webview, so a
// webview created per hotkey press would move Sodilaud to the front of Cmd-Tab and
// bring its main window along. Instead of being destroyed, the page is emptied on
// every hide.

use std::thread;
use std::time::Duration;

use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use objc2::MainThreadMarker;
use objc2_app_kit::NSScreen;
use tauri::window::Color;
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

use super::commands::POPUP_LABEL;
use super::layout::{popup_height, popup_origin, Rect, WIDTH};
use super::panel;
use super::popup_state::{
    accepts_shown, needs_hide, toggle_action, window_background, PopupState, ToggleAction,
};
use super::runtime::{frontmost_pid, own_pid, should_paste, ClipboardRuntime};

const PASTE_DELAY: Duration = Duration::from_millis(120);
const KEY_V: u16 = 9;

// Evaluated in the popup page; see `attach` in src/clipboard.js. Before the page
// has loaded, wry runs them at navigation commit, so they leave a flag instead.
const SHOW_SCRIPT: &str =
    "window.__sodilaudClip ? window.__sodilaudClip.show() : (window.__sodilaudClipPending = true)";
const HIDE_SCRIPT: &str =
    "window.__sodilaudClip ? window.__sodilaudClip.hide() : (window.__sodilaudClipPending = false)";

/// Creates the hidden popup panel unless it exists. Called when the feature is
/// enabled (including at launch), when the user is in Sodilaud anyway, because
/// wry activates the app here. Must run on the main thread.
pub fn ensure_created(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(window) = app.get_webview_window(POPUP_LABEL) {
        return Some(window);
    }
    let theme = app.state::<ClipboardRuntime>().theme();
    let (red, green, blue, alpha) = window_background(theme.background.as_deref());
    let window =
        WebviewWindowBuilder::new(app, POPUP_LABEL, WebviewUrl::App("clipboard.html".into()))
            .title("Clipboard")
            .decorations(false)
            .always_on_top(true)
            .resizable(false)
            .skip_taskbar(true)
            .visible_on_all_workspaces(true)
            .content_protected(true)
            .inner_size(WIDTH, popup_height(0))
            .background_color(Color(red, green, blue, alpha))
            .visible(false)
            .build()
            .ok()?;
    let converted = panel::make_floating_panel(&window);
    // The clipboard panic hook hides this message, but in a debug build the panic
    // still stops the app, so a refused swap cannot hide behind the fallback.
    debug_assert!(converted.is_ok(), "popup panel refused: {converted:?}");
    Some(window)
}

/// Must run on the main thread: it reads `NSScreen` and orders the panel.
pub fn toggle(app: &AppHandle) {
    let state = app.state::<ClipboardRuntime>().popup_state();
    let exists = app.get_webview_window(POPUP_LABEL).is_some();
    match toggle_action(exists, state) {
        ToggleAction::Hide => hide(app),
        // Creating here is only a fallback for a failed creation at enable time.
        ToggleAction::Show | ToggleAction::Create => show(app),
    }
}

/// Moves the panel to its fixed spot and orders it in fully transparent, so
/// WebKit paints, then asks the page to fetch and render the list. The page calls
/// `clip_shown` once that is painted, and only then does `present` make it visible.
fn show(app: &AppHandle) {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let runtime = app.state::<ClipboardRuntime>();
    if !runtime.config().enabled {
        return;
    }
    runtime.remember_frontmost();
    let Some(window) = ensure_created(app) else {
        runtime.forget_frontmost();
        return;
    };
    let (screen, primary_height) = focused_screen(mtm);
    let (x, y) = popup_origin(screen, primary_height, WIDTH);
    let _ = window.set_size(LogicalSize::new(WIDTH, popup_height(runtime.len())));
    let _ = window.set_position(LogicalPosition::new(x, y));
    runtime.set_popup_state(PopupState::Showing);
    panel::order_front_transparent(&window);
    let _ = window.eval(SHOW_SCRIPT);
}

/// The page has rendered and painted the list for the pending show.
pub fn present(app: &AppHandle) {
    let runtime = app.state::<ClipboardRuntime>();
    if !accepts_shown(runtime.popup_state()) {
        return;
    }
    let Some(window) = app.get_webview_window(POPUP_LABEL) else {
        return;
    };
    runtime.set_popup_state(PopupState::Shown);
    if !panel::present(&window) {
        // An ordinary window cannot take keys without activating the app; the hide
        // path hands focus back because Sodilaud is then frontmost.
        let _ = window.set_focus();
    }
}

/// Every way the popup closes ends here. The page forgets its list, revealed
/// values, and refresh timer before the panel is ordered out.
pub fn hide(app: &AppHandle) {
    let runtime = app.state::<ClipboardRuntime>();
    if !needs_hide(runtime.set_popup_state(PopupState::Hidden)) {
        runtime.take_paste_on_close();
        return;
    }
    if let Some(window) = app.get_webview_window(POPUP_LABEL) {
        let _ = window.eval(HIDE_SCRIPT);
        panel::order_out(&window);
    }
    let restored = runtime.restore_frontmost();
    if let (true, Some(target)) = (runtime.take_paste_on_close(), restored) {
        thread::spawn(move || {
            thread::sleep(PASTE_DELAY);
            if should_paste(target, frontmost_pid(), own_pid()) {
                post_command_v();
            }
        });
    }
}

/// On disable and quit: hide (which empties the page), then destroy the window.
pub fn destroy(app: &AppHandle) {
    hide(app);
    if let Some(window) = app.get_webview_window(POPUP_LABEL) {
        panel::restore_window_class(&window);
        let _ = window.destroy();
    }
}

pub fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    if window.label() != POPUP_LABEL {
        return;
    }
    let app = window.app_handle();
    match event {
        WindowEvent::Focused(false) | WindowEvent::Destroyed => hide(app),
        // Cmd+W and the like: keep the one popup window and hide it instead.
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            hide(app);
        }
        _ => {}
    }
}

fn focused_screen(mtm: MainThreadMarker) -> (Rect, f64) {
    let to_rect = |screen: &NSScreen| {
        let frame = screen.frame();
        Rect {
            x: frame.origin.x,
            y: frame.origin.y,
            width: frame.size.width,
            height: frame.size.height,
        }
    };
    let screens = NSScreen::screens(mtm);
    let primary = screens.firstObject().map(|s| to_rect(&s));
    let focused = NSScreen::mainScreen(mtm).map(|s| to_rect(&s));
    let fallback = Rect {
        x: 0.0,
        y: 0.0,
        width: 1440.0,
        height: 900.0,
    };
    let primary = primary.unwrap_or(fallback);
    (focused.unwrap_or(primary), primary.height)
}

fn post_command_v() {
    let Ok(source) = CGEventSource::new(CGEventSourceStateID::HIDSystemState) else {
        return;
    };
    for key_down in [true, false] {
        if let Ok(event) = CGEvent::new_keyboard_event(source.clone(), KEY_V, key_down) {
            event.set_flags(CGEventFlags::CGEventFlagCommand);
            event.post(CGEventTapLocation::HID);
        }
    }
}
