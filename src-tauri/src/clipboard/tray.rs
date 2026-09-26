// SPDX-License-Identifier: GPL-3.0-or-later

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{ActivationPolicy, AppHandle, Emitter, Manager, Wry};

use super::layout::tray_glyph;
use super::popup;
use super::runtime::ClipboardRuntime;

pub const QUIT_REQUESTED_EVENT: &str = "sodilaud-quit-requested";
const TRAY_ID: &str = "sodilaud";
const SHOW_ID: &str = "tray-show";
const HISTORY_ID: &str = "tray-history";
const CLEAR_ID: &str = "tray-clear";
const QUIT_ID: &str = "tray-quit";

pub struct TrayItems {
    history: MenuItem<Wry>,
    clear: MenuItem<Wry>,
}

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, SHOW_ID, "Show Sodilaud", true, None::<&str>)?;
    let history = MenuItem::with_id(app, HISTORY_ID, "Clipboard History…", false, None::<&str>)?;
    let clear = MenuItem::with_id(
        app,
        CLEAR_ID,
        "Clear Clipboard History",
        false,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, QUIT_ID, "Quit Sodilaud", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show, &history, &clear, &separator, &quit])?;
    let (rgba, width, height) = tray_glyph();
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(Image::new_owned(rgba, width, height))
        .icon_as_template(true)
        .tooltip("Sodilaud")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            SHOW_ID => show_main(app),
            HISTORY_ID => popup::toggle(app),
            CLEAR_ID => app.state::<ClipboardRuntime>().clear(),
            QUIT_ID => request_quit(app),
            _ => {}
        })
        .build(app)?;
    app.manage(TrayItems { history, clear });
    Ok(())
}

/// `hotkey` is the registered one, so the menu never advertises a dead shortcut.
pub fn refresh(app: &AppHandle, enabled: bool, hotkey: Option<&str>) {
    let Some(items) = app.try_state::<TrayItems>() else {
        return;
    };
    let _ = items.history.set_enabled(enabled);
    let _ = items.clear.set_enabled(enabled);
    let label = match hotkey {
        Some(hotkey) if enabled => format!("Clipboard History…  {}", hotkey_label(hotkey)),
        _ => "Clipboard History…".to_string(),
    };
    let _ = items.history.set_text(label);
}

fn hotkey_label(hotkey: &str) -> String {
    hotkey
        .split('+')
        .map(|part| match part.to_ascii_lowercase().as_str() {
            "super" | "cmd" | "command" => "⌘".to_string(),
            "shift" => "⇧".to_string(),
            "alt" | "option" => "⌥".to_string(),
            "ctrl" | "control" => "⌃".to_string(),
            _ => part
                .trim_start_matches("Key")
                .trim_start_matches("Digit")
                .to_string(),
        })
        .collect()
}

pub fn show_main(app: &AppHandle) {
    let _ = app.set_activation_policy(ActivationPolicy::Regular);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn hide_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    let _ = app.set_activation_policy(ActivationPolicy::Accessory);
}

/// Wipes first: the history must not outlive a quit request, whatever the note
/// flush does. Without a registered JS quit listener there is nothing to flush
/// through, so quit directly as a plain Cmd+Q would.
pub fn request_quit(app: &AppHandle) {
    let runtime = app.state::<ClipboardRuntime>();
    runtime.shutdown();
    popup::close(app);
    if !runtime.quit_handler_ready() {
        app.exit(0);
        return;
    }
    show_main(app);
    let _ = app.emit_to("main", QUIT_REQUESTED_EVENT, ());
}
