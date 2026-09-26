// SPDX-License-Identifier: GPL-3.0-or-later

// The popup is one hidden panel created when the feature is enabled and then only
// shown and hidden. wry activates the app whenever it creates a webview, so a
// webview created per hotkey press would move Sodilaud to the front of Cmd-Tab and
// bring its main window along. Instead of being destroyed, the page is emptied on
// every hide, and the panel leaves the screen only after that empty page painted.

use std::thread;
use std::time::Duration;

use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use objc2::MainThreadMarker;
use objc2_app_kit::NSScreen;
use tauri::utils::config::BackgroundThrottlingPolicy;
use tauri::window::Color;
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

use super::commands::POPUP_LABEL;
use super::layout::{popup_height, popup_origin, Rect, WIDTH};
use super::panel;
use super::popup_state::{
    accepts_hidden, accepts_shown, create_plan, hide_script, is_open, show_script, toggle_action,
    window_background, CreatePlan, PopupState, ToggleAction,
};
use super::runtime::{frontmost_pid, own_pid, should_paste, ClipboardRuntime};

const PASTE_DELAY: Duration = Duration::from_millis(120);
const KEY_V: u16 = 9;
/// How long a hide waits for the page to report its emptied DOM painted before
/// ordering the (already transparent) panel out anyway.
const HIDE_TIMEOUT: Duration = Duration::from_millis(300);
/// How long a show waits for the page to report the list painted before giving up
/// and hiding again, so the popup fails closed rather than showing unverified pixels.
const SHOW_TIMEOUT: Duration = Duration::from_millis(2000);

/// Creates the hidden popup panel unless it exists. Called when the feature is
/// enabled (including at launch), when the user is in Sodilaud anyway, because
/// wry activates the app here. Must run on the main thread.
pub fn ensure_created(app: &AppHandle) -> Option<WebviewWindow> {
    let runtime = app.state::<ClipboardRuntime>();
    let existing = app.get_webview_window(POPUP_LABEL);
    match create_plan(existing.is_some(), runtime.popup_destroying()) {
        CreatePlan::Reuse => return existing,
        CreatePlan::AfterDestroy => {
            runtime.defer_popup_creation(true);
            return None;
        }
        CreatePlan::Create => runtime.set_popup_destroying(false),
    }
    let (red, green, blue, alpha) = window_background(runtime.theme().background.as_deref());
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
            // Keeps WebKit from suspending the page while the panel is transparent
            // or ordered out, so hide and show are handled at once (macOS 14+).
            .background_throttling(BackgroundThrottlingPolicy::Disabled)
            .visible(false)
            .build()
            .ok()?;
    let converted = panel::make_floating_panel(&window);
    // The clipboard panic hook hides this message, but in a debug build the panic
    // still stops the app, so a refused swap cannot hide behind the fallback.
    debug_assert!(converted.is_ok(), "popup panel refused: {converted:?}");
    Some(window)
}

/// The old window's `Destroyed` has been processed and its label is free: create
/// the new one if the feature was re-enabled meanwhile.
pub fn on_destroyed(app: &AppHandle) {
    let runtime = app.state::<ClipboardRuntime>();
    runtime.set_popup_destroying(false);
    if runtime.take_deferred_popup_creation() && runtime.config().enabled {
        ensure_created(app);
    }
}

fn usable_window(app: &AppHandle) -> Option<WebviewWindow> {
    if app.state::<ClipboardRuntime>().popup_destroying() {
        return None;
    }
    app.get_webview_window(POPUP_LABEL)
}

/// Must run on the main thread: it reads `NSScreen` and orders the panel.
pub fn toggle(app: &AppHandle) {
    let state = app.state::<ClipboardRuntime>().popup_state();
    match toggle_action(usable_window(app).is_some(), state) {
        ToggleAction::Hide => hide(app),
        // Creating here is only a fallback for a failed creation at enable time.
        ToggleAction::Show | ToggleAction::Create => show(app),
    }
}

/// Moves the panel to its fixed spot and orders it in transparent and
/// click-through, so WebKit paints, then asks the page to fetch and render the
/// list. Only the page's `clip_shown` for this show's token makes it visible.
fn show(app: &AppHandle) {
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let runtime = app.state::<ClipboardRuntime>();
    if !runtime.config().enabled {
        return;
    }
    // A hide this show overtook never finishes, so its paste must not fire later.
    runtime.take_paste_on_close();
    runtime.remember_frontmost();
    let Some(window) = ensure_created(app) else {
        runtime.forget_frontmost();
        return;
    };
    let (screen, primary_height) = focused_screen(mtm);
    let (x, y) = popup_origin(screen, primary_height, WIDTH);
    let _ = window.set_size(LogicalSize::new(WIDTH, popup_height(runtime.len())));
    let _ = window.set_position(LogicalPosition::new(x, y));
    let token = runtime.next_popup_token();
    runtime.set_popup_state(PopupState::Showing(token));
    panel::order_front_transparent(&window);
    let _ = window.eval(show_script(token));
    after(app, SHOW_TIMEOUT, move |app| {
        if accepts_shown(app.state::<ClipboardRuntime>().popup_state(), token) {
            hide(app);
        }
    });
}

/// The page has rendered and painted the list for show `token`.
pub fn present(app: &AppHandle, token: u64) {
    let runtime = app.state::<ClipboardRuntime>();
    if !accepts_shown(runtime.popup_state(), token) {
        return;
    }
    let Some(window) = usable_window(app) else {
        return;
    };
    runtime.set_popup_state(PopupState::Shown(token));
    if !panel::present(&window) {
        // An ordinary window cannot take keys without activating the app; the hide
        // path hands focus back because Sodilaud is then frontmost.
        let _ = window.set_focus();
    }
}

/// Every way the popup closes starts here. The panel turns transparent and
/// click-through at once and the page is told to forget its list, revealed
/// values, and refresh timer; `finish_hide` orders it out once the page reports
/// the emptied DOM painted, or after `HIDE_TIMEOUT`.
pub fn hide(app: &AppHandle) {
    let runtime = app.state::<ClipboardRuntime>();
    if !is_open(runtime.popup_state()) {
        return;
    }
    let token = runtime.next_popup_token();
    runtime.set_popup_state(PopupState::Hiding(token));
    let Some(window) = app.get_webview_window(POPUP_LABEL) else {
        finish_hide(app, token);
        return;
    };
    panel::conceal(&window);
    let _ = window.eval(hide_script(token));
    after(app, HIDE_TIMEOUT, move |app| finish_hide(app, token));
}

/// Orders the panel out for hide `token`, then restores focus and pastes.
pub fn finish_hide(app: &AppHandle, token: u64) {
    let runtime = app.state::<ClipboardRuntime>();
    if !accepts_hidden(runtime.popup_state(), token) {
        return;
    }
    runtime.set_popup_state(PopupState::Hidden);
    // Taken before ordering out: resigning key there can re-enter `hide`.
    let paste = runtime.take_paste_on_close();
    if let Some(window) = app.get_webview_window(POPUP_LABEL) {
        panel::order_out(&window);
    }
    let restored = runtime.restore_frontmost();
    if let (true, Some(target)) = (paste, restored) {
        thread::spawn(move || {
            thread::sleep(PASTE_DELAY);
            if should_paste(target, frontmost_pid(), own_pid()) {
                post_command_v();
            }
        });
    }
}

/// On disable and quit: hide at once (the page is emptied and the window then
/// destroyed, so there is nothing to wait for), then destroy the window.
pub fn destroy(app: &AppHandle) {
    let runtime = app.state::<ClipboardRuntime>();
    hide(app);
    if let PopupState::Hiding(token) = runtime.popup_state() {
        finish_hide(app, token);
    }
    runtime.defer_popup_creation(false);
    if let Some(window) = usable_window(app) {
        panel::restore_window_class(&window);
        if window.destroy().is_ok() {
            runtime.set_popup_destroying(true);
        }
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

/// Runs `action` on the main thread after `delay`.
fn after(app: &AppHandle, delay: Duration, action: impl FnOnce(&AppHandle) + Send + 'static) {
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(delay);
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || action(&handle));
    });
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
