// SPDX-License-Identifier: GPL-3.0-or-later

// The main windows: the editor windows labelled `main`, `main-2`, ...

use std::path::Path;

use serde::Serialize;
use tauri::{
    AppHandle, CloseRequestApi, Emitter, Manager, PhysicalPosition, PhysicalSize, State,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window,
};

use crate::docs::commands::SharedRegistry;
use crate::files::commands::{require_main, OPEN_REQUEST_EVENT};
use crate::files::windows::{is_main_label, WindowSet};
use crate::files::{io, FileError, Files, PendingOpen};
use crate::quicknotes::config::{clamp_frame, Frame, Screen};

/// Asks one main window's page to save its files before it closes.
pub const CLOSE_REQUESTED_EVENT: &str = "main-window-close-requested";
/// The most view state a moved file carries, as JSON.
pub const VIEW_LIMIT: usize = 65_536;
const DEFAULT_WIDTH: f64 = 960.0;
const DEFAULT_HEIGHT: f64 = 680.0;
/// How far right and down a new window opens from the one it came from.
const CASCADE: f64 = 28.0;

/// The main windows that exist right now.
pub fn labels(app: &AppHandle) -> Vec<String> {
    app.webview_windows()
        .into_keys()
        .filter(|label| is_main_label(label))
        .collect()
}

/// Sends an event to every main window, and to no other.
pub fn emit_all<S: Serialize + Clone>(app: &AppHandle, event: &str, payload: S) {
    for label in labels(app) {
        let _ = app.emit_to(label.as_str(), event, payload.clone());
    }
}

pub fn show(app: &AppHandle, label: &str) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Shows the window and tells its page to take the files queued for it.
pub fn present(app: &AppHandle, label: &str) {
    show(app, label);
    let _ = app.emit_to(label, OPEN_REQUEST_EVENT, ());
}

/// Shows the main window an app-wide action belongs to: the one focused last.
pub fn show_target(app: &AppHandle) -> Option<String> {
    let label = app
        .try_state::<Files>()?
        .read(|lists| lists.windows.target());
    app.get_webview_window(&label)?;
    show(app, &label);
    Some(label)
}

/// Hides every main window, leaving Sodilaud in the menu bar.
#[cfg(target_os = "macos")]
pub fn hide_all(app: &AppHandle) {
    for label in labels(app) {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.hide();
        }
    }
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
}

/// Closing the last main window: macOS keeps running in the menu bar, the other
/// platforms quit once every window has saved.
fn close_last(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    hide_all(app);
    #[cfg(not(target_os = "macos"))]
    crate::quit::request(app);
}

/// A main window is never closed by the system: the last one keeps today's
/// behavior, any other first saves through its page, which then answers with
/// `main_window_close_done`.
pub fn on_close_requested(window: &Window, api: &CloseRequestApi) {
    api.prevent_close();
    let app = window.app_handle();
    let label = window.label();
    let last = app
        .try_state::<Files>()
        .is_none_or(|files| files.read(|lists| is_last(&lists.windows, label)));
    if last {
        close_last(app);
    } else if !crate::quit::is_registered(app, label) {
        close(window);
    } else {
        let _ = app.emit_to(label, CLOSE_REQUESTED_EVENT, ());
    }
}

/// What closing a window leaves to do. It is decided against the set, in one
/// update, so two windows closing together cannot both pass as "not the last
/// one": a destroyed window stays a live webview until its Destroyed event.
#[derive(Debug, PartialEq)]
enum Closing {
    /// The window left the set already.
    Gone,
    /// It is the last window, which stays.
    Last,
    /// It left the set with these open files.
    Removed(Vec<String>),
}

fn begin_close(set: &mut WindowSet, label: &str) -> Closing {
    if set.entry(label).is_none() {
        return Closing::Gone;
    }
    set.remove(label).map_or(Closing::Last, Closing::Removed)
}

fn is_last(set: &WindowSet, label: &str) -> bool {
    set.entry(label).is_some() && set.labels().len() < 2
}

/// Forgets the window's files and destroys it, or closes the last window as
/// before when the others went away meanwhile.
fn close(window: &Window) {
    let app = window.app_handle();
    let label = window.label();
    let Some(files) = app.try_state::<Files>() else {
        close_last(app);
        return;
    };
    let paths = match files.update(|lists| begin_close(&mut lists.windows, label)) {
        Closing::Gone => return,
        Closing::Last => {
            close_last(app);
            return;
        }
        Closing::Removed(paths) => paths,
    };
    if let Some(registry) = app.try_state::<SharedRegistry>() {
        for path in paths {
            if let Err(error) = registry.file_close(Path::new(&path), &*files) {
                eprintln!("Could not close {path}: {}", error.message);
            }
        }
    }
    let orphaned = files.take_pending(label);
    crate::files::present_pending(app, &files, orphaned.into_iter().map(|p| p.path).collect());
    crate::quit::forget_window(app, label);
    let _ = window.destroy();
}

/// The page saved its files for a close (`ok`), or kept the window open.
#[tauri::command]
pub fn main_window_close_done(window: Window, ok: bool) {
    if ok && is_main_label(window.label()) {
        close(&window);
    }
}

/// Builds a main window. `frame` is in physical pixels: the outer position and
/// the inner size, which is what `set_size` takes back.
pub fn create(
    app: &AppHandle,
    label: &str,
    frame: Option<Frame>,
    visible: bool,
) -> Option<WebviewWindow> {
    let window = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title("Sodilaud")
        .inner_size(DEFAULT_WIDTH, DEFAULT_HEIGHT)
        .visible(false)
        .build()
        .map_err(|error| eprintln!("Could not create a Sodilaud window: {error}"))
        .ok()?;
    if let Some(frame) = frame {
        place(&window, frame);
    }
    if visible {
        let _ = window.show();
    }
    Some(window)
}

fn place(window: &WebviewWindow, frame: Frame) {
    let _ = window.set_size(PhysicalSize::new(frame.width, frame.height));
    let _ = window.set_position(PhysicalPosition::new(frame.x, frame.y));
}

fn frame_of(window: &WebviewWindow) -> Option<Frame> {
    let (position, size) = (window.outer_position().ok()?, window.inner_size().ok()?);
    Some(Frame {
        x: f64::from(position.x),
        y: f64::from(position.y),
        width: f64::from(size.width),
        height: f64::from(size.height),
    })
}

/// The source window's size, moved right and down so both stay visible.
pub fn cascade_from(source: &WebviewWindow) -> Option<Frame> {
    let frame = frame_of(source)?;
    let offset = CASCADE * source.scale_factor().unwrap_or(1.0);
    Some(Frame {
        x: frame.x + offset,
        y: frame.y + offset,
        ..frame
    })
}

/// Work areas, the primary screen first.
fn screens(app: &AppHandle) -> Vec<Screen> {
    let primary = app.primary_monitor().ok().flatten();
    let mut monitors = app.available_monitors().unwrap_or_default();
    if let Some(primary) = primary {
        if let Some(index) = monitors
            .iter()
            .position(|monitor| monitor.position() == primary.position())
        {
            monitors.swap(0, index);
        }
    }
    monitors
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
        .collect()
}

/// Each window in the set with its saved frame, moved back onto a screen when
/// too little of it is visible. Without a known screen the frame is kept.
fn placements(set: &WindowSet, screens: &[Screen]) -> Vec<(String, Option<Frame>)> {
    set.labels()
        .into_iter()
        .map(|label| {
            let saved = set.entry(&label).and_then(|entry| entry.frame);
            let frame = match (saved, screens.first()) {
                (Some(frame), Some(pointer)) => Some(clamp_frame(Some(frame), screens, pointer)),
                (frame, _) => frame,
            };
            (label, frame)
        })
        .collect()
}

/// Gives every saved window a live window at launch: the first one exists
/// already and gets its frame, the others are created. Outside opens are routed
/// to any window in the set, so none may be left without one. Runs after
/// `files::start`, on the main thread.
pub fn restore(app: &AppHandle, visible: bool) {
    let Some(files) = app.try_state::<Files>() else {
        return;
    };
    let placed = files.read(|lists| placements(&lists.windows, &screens(app)));
    for (label, frame) in placed {
        match app.get_webview_window(&label) {
            Some(window) => {
                if let Some(frame) = frame {
                    place(&window, frame);
                }
            }
            None => {
                if create(app, &label, frame, false).is_none() {
                    abandon(app, &files, &label);
                }
            }
        }
    }
    if visible {
        for label in labels(app) {
            if let Some(window) = app.get_webview_window(&label) {
                let _ = window.show();
            }
        }
        show_target(app);
    }
}

/// Remembers where each main window is, for the next launch.
pub fn record_frames(app: &AppHandle) {
    let Some(files) = app.try_state::<Files>() else {
        return;
    };
    let frames: Vec<(String, Frame)> = labels(app)
        .into_iter()
        .filter_map(|label| {
            let frame = frame_of(&app.get_webview_window(&label)?)?;
            Some((label, frame))
        })
        .collect();
    files.update(|lists| {
        for (label, frame) in frames {
            lists.windows.set_frame(&label, frame);
        }
    });
}

pub fn limited_view(view: Option<serde_json::Value>) -> Option<serde_json::Value> {
    view.filter(|view| serde_json::to_string(view).is_ok_and(|text| text.len() <= VIEW_LIMIT))
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WindowSummary {
    pub label: String,
    pub number: usize,
    pub title: String,
}

/// The windows other than `except`, for the Move to Window menu.
pub fn summaries(set: &WindowSet, except: &str) -> Vec<WindowSummary> {
    set.labels()
        .into_iter()
        .filter(|label| label != except)
        .filter_map(|label| {
            let entry = set.entry(&label)?;
            let shown = entry.active.as_ref().or(entry.open.first());
            Some(WindowSummary {
                number: set.number(&label)?,
                title: shown.map_or_else(
                    || "Start Page".to_string(),
                    |path| io::file_name(Path::new(path)),
                ),
                label,
            })
        })
        .collect()
}

/// A window that could not be built leaves the set. Its open files join the
/// focused window's open list, which that page reopens when it loads, and the
/// files queued for it go to another window.
fn abandon(app: &AppHandle, files: &Files, label: &str) {
    files.update(|lists| lists.windows.fold_into_target(label));
    let orphaned = files.take_pending(label);
    crate::files::present_pending(app, files, orphaned.into_iter().map(|p| p.path).collect());
}

/// Adds a window to the set and builds it next to `source`. A window that
/// cannot be built leaves the set again, so nothing is routed to it.
fn open_new(app: &AppHandle, files: &Files, source: &WebviewWindow) -> Result<String, FileError> {
    let label = files.update(|lists| lists.windows.add());
    if create(app, &label, cascade_from(source), true).is_none() {
        abandon(app, files, &label);
        return Err(FileError::other("Could not open a new window.".to_string()));
    }
    show(app, &label);
    Ok(label)
}

/// New Window: an empty window showing the start page.
#[tauri::command]
pub async fn main_window_new(app: AppHandle, window: WebviewWindow) -> Result<String, FileError> {
    require_main(window.label())?;
    let files = app.state::<Files>();
    open_new(&app, &files, &window)
}

/// Hands an open file, with its view state, to another window (`to`) or to a
/// new one. The registry document stays open, so the target takes it as it is.
/// Returns the target window's label.
#[tauri::command]
pub async fn main_window_move_file(
    app: AppHandle,
    window: WebviewWindow,
    path: String,
    to: Option<String>,
    view: Option<serde_json::Value>,
) -> Result<String, FileError> {
    require_main(window.label())?;
    let files = app.state::<Files>();
    let registry = app.state::<SharedRegistry>();
    let path = files.require(&path)?;
    let path_text = path.to_string_lossy().to_string();
    let source = window.label().to_string();
    let owned_here = |files: &Files| {
        files
            .read(|lists| lists.windows.owner(&path_text))
            .as_deref()
            == Some(source.as_str())
    };
    let is_open = registry
        .file_doc_ids()
        .iter()
        .any(|(open, _)| *open == path);
    if !is_open || !owned_here(&files) {
        return Err(FileError::not_open(&path));
    }
    let target = match to {
        Some(to) => {
            let known = files.read(|lists| lists.windows.entry(&to).is_some());
            if to == source || !known || app.get_webview_window(&to).is_none() {
                return Err(FileError::other("That window is closed.".to_string()));
            }
            to
        }
        None => open_new(&app, &files, &window)?,
    };
    files.update(|lists| {
        if lists.windows.owner(&path_text).as_deref() != Some(source.as_str()) {
            return Err(FileError::not_open(&path));
        }
        lists
            .windows
            .move_to(&path_text, &target)
            .map_err(FileError::other)
    })?;
    files.queue(
        &target,
        vec![PendingOpen {
            path: path_text,
            view: limited_view(view),
        }],
    );
    present(&app, &target);
    Ok(target)
}

/// The other main windows, for this window's Move to Window menu.
#[tauri::command]
pub fn main_window_list(
    window: tauri::Window,
    files: State<'_, Files>,
) -> Result<Vec<WindowSummary>, FileError> {
    require_main(window.label())?;
    Ok(files.read(|lists| summaries(&lists.windows, window.label())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::store::SavedWindow;
    use crate::files::windows::WindowSet;
    use crate::quicknotes::config::{Frame, Screen};
    use serde_json::json;

    fn saved(open: &[&str], active: Option<&str>) -> SavedWindow {
        SavedWindow {
            open: open.iter().map(|p| p.to_string()).collect(),
            active: active.map(str::to_string),
            frame: None,
            ..Default::default()
        }
    }

    #[test]
    fn other_windows_are_listed_by_number_and_file() {
        let set = WindowSet::from_saved(vec![
            saved(&["/d/a.md"], Some("/d/a.md")),
            saved(&[], None),
            saved(&["/d/b.md", "/d/c.md"], None),
        ]);
        let listed = summaries(&set, "main");
        assert_eq!(
            listed
                .iter()
                .map(|w| (w.label.as_str(), w.number, w.title.as_str()))
                .collect::<Vec<_>>(),
            vec![("main-2", 2, "Start Page"), ("main-3", 3, "b.md")]
        );
        assert_eq!(summaries(&set, "main-3")[0].title, "a.md");
    }

    #[test]
    fn a_large_view_state_is_dropped() {
        assert_eq!(
            limited_view(Some(json!({"top": 1}))),
            Some(json!({"top": 1}))
        );
        assert_eq!(
            limited_view(Some(json!({"x": "a".repeat(VIEW_LIMIT)}))),
            None
        );
        assert_eq!(limited_view(None), None);
    }

    fn frame(x: f64, y: f64, width: f64, height: f64) -> Frame {
        Frame {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn every_saved_window_is_placed_and_kept_on_screen() {
        let mut windows = vec![
            saved(&["/d/a.md"], None),
            saved(&[], None),
            saved(&[], None),
        ];
        windows[0].frame = Some(frame(100.0, 100.0, 960.0, 680.0));
        windows[1].frame = Some(frame(9000.0, 9000.0, 960.0, 680.0));
        let set = WindowSet::from_saved(windows);
        let screen = Screen {
            frame: frame(0.0, 0.0, 1920.0, 1080.0),
            scale: 1.0,
        };
        let placed = placements(&set, &[screen]);
        assert_eq!(
            placed
                .iter()
                .map(|(label, _)| label.as_str())
                .collect::<Vec<_>>(),
            set.labels(),
            "routing may target any window in the set, so each needs a live window"
        );
        assert_eq!(placed[0].1, Some(frame(100.0, 100.0, 960.0, 680.0)));
        assert_eq!(placed[1].1, Some(frame(480.0, 200.0, 960.0, 680.0)));
        assert_eq!(placed[2].1, None);
        assert_eq!(
            placements(&set, &[])[1].1,
            Some(frame(9000.0, 9000.0, 960.0, 680.0))
        );
    }

    #[test]
    fn two_windows_closing_together_leave_one() {
        let mut set =
            WindowSet::from_saved(vec![saved(&["/d/a.md"], None), saved(&["/d/b.md"], None)]);
        assert!(!is_last(&set, "main"));
        assert!(!is_last(&set, "main-2"));
        assert_eq!(
            begin_close(&mut set, "main"),
            Closing::Removed(vec!["/d/a.md".to_string()])
        );
        assert_eq!(
            begin_close(&mut set, "main-2"),
            Closing::Last,
            "the second close must not destroy the only window left"
        );
        assert_eq!(set.labels(), ["main-2"]);
        assert!(is_last(&set, "main-2"));
        assert_eq!(begin_close(&mut set, "main"), Closing::Gone);
        assert!(!is_last(&set, "main"));
    }
}
