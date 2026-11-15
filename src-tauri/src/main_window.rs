// SPDX-License-Identifier: GPL-3.0-or-later

// The main windows: the editor windows labelled `main`, `main-2`, ...

use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, CloseRequestApi, Emitter, Manager, PhysicalPosition, PhysicalSize, State,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder, Window,
};

#[cfg(target_os = "macos")]
use tauri::TitleBarStyle;

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
/// Where the traffic lights sit in the overlay title bar, as in tauri.conf.json.
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_X: f64 = 16.0;
#[cfg(target_os = "macos")]
const TRAFFIC_LIGHT_Y: f64 = 20.0;

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

/// The title bar text: the app name, then the window's name when it has one.
pub fn title_for(name: Option<&str>) -> String {
    name.map_or_else(
        || "Sodilaud".to_string(),
        |name| format!("Sodilaud - {name}"),
    )
}

/// Shows the window's name, if any, in its title bar.
fn apply_title(app: &AppHandle, files: &Files, label: &str) {
    let name = files.read(|lists| lists.windows.name_of(label));
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.set_title(&title_for(name.as_deref()));
    }
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

/// On macOS the toolbar row is the title bar: the page draws over a hidden
/// title, with the traffic lights centred in its 44px row. Matches the `main`
/// window in tauri.conf.json.
#[cfg(target_os = "macos")]
fn overlay_title_bar<R: tauri::Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'_, R, M>,
) -> WebviewWindowBuilder<'_, R, M> {
    builder
        .title_bar_style(TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(
            TRAFFIC_LIGHT_X,
            TRAFFIC_LIGHT_Y,
        ))
}

/// Builds a main window. `frame` is in physical pixels: the outer position and
/// the inner size, which is what `set_size` takes back.
pub fn create(
    app: &AppHandle,
    label: &str,
    frame: Option<Frame>,
    visible: bool,
) -> Option<WebviewWindow> {
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title("Sodilaud")
        .inner_size(DEFAULT_WIDTH, DEFAULT_HEIGHT)
        .visible(false);
    #[cfg(target_os = "macos")]
    let builder = overlay_title_bar(builder);
    let window = builder
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
    for label in labels(app) {
        apply_title(app, &files, &label);
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
            let title = match &entry.name {
                Some(name) => name.clone(),
                None => shown.map_or_else(
                    || "Start Page".to_string(),
                    |path| io::file_name(Path::new(path)),
                ),
            };
            Some(WindowSummary {
                number: set.number(&label)?,
                title,
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

/// The window named `name`, built now when there is none yet. A new window
/// opens next to the focused one. Runs on the main thread.
pub fn open_named(app: &AppHandle, files: &Files, name: &str) -> Result<String, FileError> {
    let source = files.read(|lists| lists.windows.target());
    let (label, added) = files
        .update(|lists| lists.windows.find_or_add_named(name))
        .map_err(FileError::other)?;
    if !added {
        return Ok(label);
    }
    let frame = app
        .get_webview_window(&source)
        .and_then(|window| cascade_from(&window));
    if create(app, &label, frame, true).is_none() {
        abandon(app, files, &label);
        return Err(FileError::other("Could not open a new window.".to_string()));
    }
    apply_title(app, files, &label);
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

#[derive(Deserialize, Debug)]
pub struct MovedFile {
    pub path: String,
    #[serde(default)]
    pub view: Option<serde_json::Value>,
}

/// Hands open files, with their view state, to another window (`to`) or to
/// one new window. Every file must be open here, or none moves. The registry
/// documents stay open, so the target takes them as they are. The target opens
/// them in the given order and shows the last. Returns the target's label.
#[tauri::command]
pub async fn main_window_move_files(
    app: AppHandle,
    window: WebviewWindow,
    moved: Vec<MovedFile>,
    to: Option<String>,
) -> Result<String, FileError> {
    require_main(window.label())?;
    if moved.is_empty() {
        return Err(FileError::other("No files to move.".to_string()));
    }
    let files = app.state::<Files>();
    let registry = app.state::<SharedRegistry>();
    let source = window.label().to_string();
    let open_docs = registry.file_doc_ids();
    let mut entries = Vec::with_capacity(moved.len());
    for file in moved {
        let path = files.require(&file.path)?;
        let path_text = path.to_string_lossy().to_string();
        let is_open = open_docs.iter().any(|(open, _)| *open == path);
        let owned_here = files
            .read(|lists| lists.windows.owner(&path_text))
            .as_deref()
            == Some(source.as_str());
        if !is_open || !owned_here {
            return Err(FileError::not_open(&path));
        }
        if !entries
            .iter()
            .any(|entry: &PendingOpen| entry.path == path_text)
        {
            entries.push(PendingOpen {
                path: path_text,
                view: limited_view(file.view),
            });
        }
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
    let paths: Vec<String> = entries.iter().map(|entry| entry.path.clone()).collect();
    files
        .update(|lists| lists.windows.move_all(&paths, &source, &target))
        .map_err(FileError::other)?;
    files.queue(&target, entries);
    present(&app, &target);
    Ok(target)
}

/// This window's name, if it has one.
#[tauri::command]
pub fn main_window_name(
    window: tauri::Window,
    files: State<'_, Files>,
) -> Result<Option<String>, FileError> {
    require_main(window.label())?;
    Ok(files.read(|lists| lists.windows.name_of(window.label())))
}

/// Names this window, or clears its name with an empty `name`. Returns the
/// name it now has.
#[tauri::command]
pub fn main_window_set_name(
    app: AppHandle,
    window: tauri::Window,
    files: State<'_, Files>,
    name: String,
) -> Result<Option<String>, FileError> {
    require_main(window.label())?;
    let label = window.label();
    let named = files
        .update(|lists| lists.windows.set_name(label, Some(&name)))
        .map_err(FileError::other)?;
    apply_title(&app, &files, label);
    Ok(named)
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
    fn a_named_window_is_listed_by_its_name() {
        let mut set = WindowSet::from_saved(vec![saved(&[], None), saved(&["/d/b.md"], None)]);
        set.set_name("main-2", Some("Review feat/x")).unwrap();
        assert_eq!(summaries(&set, "main")[0].title, "Review feat/x");
        assert_eq!(title_for(Some("Book")), "Sodilaud - Book");
        assert_eq!(title_for(None), "Sodilaud");
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
