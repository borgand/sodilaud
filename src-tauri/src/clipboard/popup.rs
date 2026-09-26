// SPDX-License-Identifier: GPL-3.0-or-later

use std::thread;
use std::time::Duration;

use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use objc2::MainThreadMarker;
use objc2_app_kit::NSScreen;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use super::commands::POPUP_LABEL;
use super::layout::{popup_height, popup_origin, Rect, WIDTH};
use super::panel;
use super::runtime::{frontmost_pid, own_pid, should_paste, ClipboardRuntime};

const PASTE_DELAY: Duration = Duration::from_millis(120);
const KEY_V: u16 = 9;

/// Must run on the main thread: it reads `NSScreen` and creates the window.
pub fn toggle(app: &AppHandle) {
    if app.get_webview_window(POPUP_LABEL).is_some() {
        close(app);
        return;
    }
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let runtime = app.state::<ClipboardRuntime>();
    runtime.remember_frontmost();
    let (screen, primary_height) = focused_screen(mtm);
    let (x, y) = popup_origin(screen, primary_height, WIDTH);
    let built =
        WebviewWindowBuilder::new(app, POPUP_LABEL, WebviewUrl::App("clipboard.html".into()))
            .title("Clipboard")
            .decorations(false)
            .always_on_top(true)
            .resizable(false)
            .skip_taskbar(true)
            .visible_on_all_workspaces(true)
            .content_protected(true)
            .inner_size(WIDTH, popup_height(runtime.len()))
            .position(x, y)
            .visible(false)
            .build();
    let Ok(window) = built else {
        return;
    };
    if panel::make_floating_panel(&window) {
        panel::show_panel(&window);
    } else {
        // An ordinary window cannot take keys without activating the app; the close
        // path hands focus back because Sodilaud is then frontmost.
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn close(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(POPUP_LABEL) {
        let _ = window.destroy();
    }
}

pub fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    if window.label() != POPUP_LABEL {
        return;
    }
    let app = window.app_handle();
    match event {
        WindowEvent::Focused(false) => close(app),
        WindowEvent::Destroyed => {
            let runtime = app.state::<ClipboardRuntime>();
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
