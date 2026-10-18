// SPDX-License-Identifier: GPL-3.0-or-later

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager, State, Window};

use super::folders::FolderListing;
use super::io::{self, LineEnding};
use super::windows::{is_main_label, Claim};
use super::{FileError, Files, FolderRoot, OpenedDocument, PendingOpen};
use crate::docs::commands::SharedRegistry;
use crate::docs::files::{FileOpened, FileSaved, Resolve};
use crate::docs::registry::{Pulled, Pushed, Update};

pub const OPEN_REQUEST_EVENT: &str = "file-open-request";
const TEXT_EXTENSIONS: &[&str] = &["md", "markdown", "txt"];

pub(crate) fn require_main(label: &str) -> Result<(), FileError> {
    if is_main_label(label) {
        Ok(())
    } else {
        Err(FileError::wrong_window())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    path: String,
    name: String,
    hash: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentFile {
    path: String,
    name: String,
    exists: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListsView {
    open: Vec<String>,
    recent: Vec<RecentFile>,
    folders: Vec<FolderRoot>,
    expanded: Vec<String>,
}

fn lists_view(
    open: Vec<String>,
    recent: Vec<String>,
    folders: Vec<String>,
    expanded: Vec<String>,
) -> ListsView {
    ListsView {
        open,
        folders: folders.iter().map(|root| FolderRoot::new(root)).collect(),
        expanded,
        recent: recent
            .into_iter()
            .map(|path| RecentFile {
                name: io::file_name(Path::new(&path)),
                exists: Path::new(&path).is_file(),
                path,
            })
            .collect(),
    }
}

/// Open File: the native dialog. The page opens the chosen file with
/// `file_doc_open`.
#[tauri::command]
pub fn file_open_dialog(
    window: Window,
    files: State<'_, Files>,
) -> Result<Option<String>, FileError> {
    require_main(window.label())?;
    let Some(chosen) = rfd::FileDialog::new()
        .set_title("Open File")
        .add_filter("Markdown and text", TEXT_EXTENSIONS)
        .add_filter("All files", &["*"])
        .pick_file()
    else {
        return Ok(None);
    };
    let path = files.grant(&chosen)?;
    Ok(Some(path.to_string_lossy().to_string()))
}

/// Save As, and the first save of a new file. The page then opens the new
/// file with `file_doc_open`.
#[tauri::command]
pub fn file_save_as_dialog(
    window: Window,
    files: State<'_, Files>,
    registry: State<'_, SharedRegistry>,
    text: String,
    suggested_name: String,
    line_ending: LineEnding,
    bom: bool,
) -> Result<Option<Saved>, FileError> {
    require_main(window.label())?;
    let Some(chosen) = rfd::FileDialog::new()
        .set_title("Save As")
        .set_file_name(&suggested_name)
        .add_filter("Markdown", &["md"])
        .add_filter("Text", &["txt"])
        .save_file()
    else {
        return Ok(None);
    };
    let path: PathBuf = files.grant(&chosen)?;
    let path_text = path.to_string_lossy().to_string();
    let label = window.label();
    let owner = files.read(|lists| lists.windows.owner(&path_text));
    if owner.is_some_and(|owner| owner != label) {
        return Err(FileError::owned_elsewhere(&chosen));
    }
    // A document open at that path would otherwise autosave over this write.
    registry.file_discard(&path);
    let hash = files.write(&path, &text, line_ending, bom)?;
    // An unknown window surfaces when the page opens the saved file.
    files.update(|lists| {
        lists.opened_recent(&path_text);
        lists.windows.claim(label, &path_text);
    });
    Ok(Some(Saved {
        name: io::file_name(&path),
        path: path_text,
        hash,
    }))
}

/// Opens a granted file in the registry: from the dialog, the recent list,
/// Finder, or at start-up. A file another window has open is not opened here:
/// that window is brought forward and shows it instead.
#[tauri::command]
pub fn file_doc_open(
    app: AppHandle,
    window: Window,
    files: State<'_, Files>,
    registry: State<'_, SharedRegistry>,
    path: String,
) -> Result<FileOpened, FileError> {
    require_main(window.label())?;
    let path = files.require(&path)?;
    let path_text = path.to_string_lossy().to_string();
    let label = window.label();
    let (claim, was_open) = files.update(|lists| {
        let was_open = lists.windows.owner(&path_text).is_some();
        (lists.windows.claim(label, &path_text), was_open)
    });
    match claim {
        None => return Err(FileError::wrong_window()),
        Some(Claim::Elsewhere(owner)) => {
            files.queue(
                &owner,
                vec![PendingOpen {
                    path: path_text,
                    view: None,
                }],
            );
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || crate::main_window::present(&handle, &owner));
            return Err(FileError::open_elsewhere(&path));
        }
        Some(Claim::Mine) => {}
    }
    let opened = match registry.file_open(&path, &*files) {
        Ok(opened) => opened,
        Err(error) => {
            if !was_open {
                files.update(|lists| release(lists, label, &path_text));
            }
            return Err(error);
        }
    };
    files.update(|lists| lists.opened_recent(&opened.path));
    Ok(opened)
}

/// Takes back a claim for a file that then failed to open, so it neither
/// reopens at the next launch nor sends other windows here.
fn release(lists: &mut super::Lists, label: &str, path: &str) {
    let Some(entry) = lists.windows.entry(label) else {
        return;
    };
    let open = entry
        .open
        .iter()
        .filter(|open| *open != path)
        .cloned()
        .collect();
    let active = entry.active.clone();
    lists.windows.set_open(label, open, active);
}

/// Grants the file a link in the open document `from_path` names by a relative
/// path, when it lies in that document's folder or below. The page then opens
/// the returned path like any other granted file.
#[tauri::command]
pub fn file_doc_open_sibling(
    window: Window,
    files: State<'_, Files>,
    from_path: String,
    relative: String,
) -> Result<OpenedDocument, FileError> {
    require_main(window.label())?;
    let from = files.require(&from_path)?;
    let (resolved, bytes) = super::sibling_document(&from, &relative)?;
    let granted = files.grant(&resolved)?;
    Ok(OpenedDocument {
        name: io::file_name(&granted),
        path: granted.to_string_lossy().to_string(),
        bytes,
    })
}

#[tauri::command]
pub fn file_doc_push(
    window: Window,
    files: State<'_, Files>,
    registry: State<'_, SharedRegistry>,
    path: String,
    doc_id: String,
    version: u64,
    updates: Vec<Update>,
) -> Result<Pushed, FileError> {
    require_main(window.label())?;
    registry.file_push(&files.require(&path)?, &doc_id, version, updates)
}

#[tauri::command]
pub fn file_doc_pull(
    window: Window,
    files: State<'_, Files>,
    registry: State<'_, SharedRegistry>,
    path: String,
    doc_id: String,
    since: u64,
) -> Result<Pulled, FileError> {
    require_main(window.label())?;
    registry.file_pull(&files.require(&path)?, &doc_id, since)
}

/// Writes a pending save, then closes the file in the registry.
#[tauri::command]
pub fn file_doc_close(
    window: Window,
    files: State<'_, Files>,
    registry: State<'_, SharedRegistry>,
    path: String,
) -> Result<(), FileError> {
    require_main(window.label())?;
    registry.file_close(&files.require(&path)?, &*files)
}

/// Saves now: Cmd+S, Try again, and a quit.
#[tauri::command]
pub fn file_doc_save(
    window: Window,
    files: State<'_, Files>,
    registry: State<'_, SharedRegistry>,
    path: String,
) -> Result<FileSaved, FileError> {
    require_main(window.label())?;
    registry.file_save(&files.require(&path)?, &*files)
}

/// Reload or Keep mine, after a file changed on disk while it had unsaved edits.
#[tauri::command]
pub fn file_doc_resolve(
    window: Window,
    files: State<'_, Files>,
    registry: State<'_, SharedRegistry>,
    path: String,
    keep: Resolve,
) -> Result<(), FileError> {
    require_main(window.label())?;
    registry.file_resolve(&files.require(&path)?, keep, &*files)
}

/// This window's open files and folders, and the recent files.
#[tauri::command]
pub fn file_lists(window: Window, files: State<'_, Files>) -> Result<ListsView, FileError> {
    require_main(window.label())?;
    let (entry, recent) = files.read(|lists| {
        let entry = lists
            .windows
            .entry(window.label())
            .map(|entry| {
                (
                    entry.open.clone(),
                    entry.folders.clone(),
                    entry.expanded.clone(),
                )
            })
            .unwrap_or_default();
        (entry, lists.recent.clone())
    });
    let (open, folders, expanded) = entry;
    Ok(lists_view(open, recent, folders, expanded))
}

/// Adds `root` (canonical) to the window's sidebar, expanded. A root the
/// window already shows is returned as it is.
fn add_root(files: &Files, label: &str, root: &Path) -> Result<FolderRoot, FileError> {
    let root = root.to_string_lossy().to_string();
    let known = files.update(|lists| {
        lists.windows.add_folder(label, &root);
        lists.windows.entry(label).is_some()
    });
    if !known {
        return Err(FileError::wrong_window());
    }
    Ok(FolderRoot::new(&root))
}

/// Open Folder: the native folder picker. The chosen folder becomes a root of
/// this window.
#[tauri::command]
pub fn folder_open_dialog(
    window: Window,
    files: State<'_, Files>,
) -> Result<Option<FolderRoot>, FileError> {
    require_main(window.label())?;
    let Some(chosen) = rfd::FileDialog::new()
        .set_title("Open Folder")
        .pick_folder()
    else {
        return Ok(None);
    };
    let root = chosen
        .canonicalize()
        .map_err(|error| FileError::io(&chosen, &error))?;
    add_root(&files, window.label(), &root).map(Some)
}

/// Show Folder in Sidebar: the folder of a file open in this window becomes
/// a root of it.
#[tauri::command]
pub fn folder_browse(
    window: Window,
    files: State<'_, Files>,
    path: String,
) -> Result<FolderRoot, FileError> {
    require_main(window.label())?;
    let file = files.require(&path)?;
    let file_text = file.to_string_lossy().to_string();
    let label = window.label();
    if files
        .read(|lists| lists.windows.owner(&file_text))
        .as_deref()
        != Some(label)
    {
        return Err(FileError::not_open(&file));
    }
    let root = file.parent().ok_or_else(|| FileError::not_open(&file))?;
    add_root(&files, label, root)
}

#[tauri::command]
pub fn folder_remove(
    window: Window,
    files: State<'_, Files>,
    path: String,
) -> Result<(), FileError> {
    require_main(window.label())?;
    files.update(|lists| lists.windows.remove_folder(window.label(), &path));
    Ok(())
}

/// Async, and listed on a blocking thread: a large folder never stalls the main thread.
#[tauri::command]
pub async fn folder_list(
    window: Window,
    app: AppHandle,
    path: String,
) -> Result<FolderListing, FileError> {
    require_main(window.label())?;
    let label = window.label().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        super::folder_listing(&app.state::<Files>(), &label, &path)
    })
    .await
    .map_err(|error| FileError::other(format!("Could not list the folder: {error}")))?
}

/// The folders expanded in this window's sidebar. Only folders in one of its
/// roots are kept, in their canonical form, and watched.
#[tauri::command]
pub fn folder_set_expanded(
    window: Window,
    files: State<'_, Files>,
    paths: Vec<String>,
) -> Result<(), FileError> {
    require_main(window.label())?;
    let label = window.label();
    let expanded = super::expandable_folders(&files, label, &paths);
    files.update(|lists| lists.windows.set_expanded(label, expanded));
    Ok(())
}

/// Grants a file shown in this window's folder tree. The page then opens it
/// with `file_doc_open`.
#[tauri::command]
pub fn folder_open_file(
    window: Window,
    files: State<'_, Files>,
    path: String,
) -> Result<OpenedDocument, FileError> {
    require_main(window.label())?;
    super::folder_file(&files, window.label(), &path)
}

/// The files open in this window, in sidebar order, and the one shown. Only
/// granted paths not open in another window are kept. Every window's open
/// files are watched for outside edits.
#[tauri::command]
pub fn file_set_open(
    window: Window,
    files: State<'_, Files>,
    paths: Vec<String>,
    active: Option<String>,
) -> Result<(), FileError> {
    require_main(window.label())?;
    let granted = |path: &String| {
        files
            .require(path)
            .ok()
            .map(|path| path.to_string_lossy().to_string())
    };
    let open = paths.iter().filter_map(granted).collect();
    let active = active.as_ref().and_then(granted);
    files.update(|lists| lists.windows.set_open(window.label(), open, active));
    Ok(())
}

/// Files handed to this window from Finder, a launch argument, an agent or
/// another window, already granted.
#[tauri::command]
pub fn file_take_pending(
    window: Window,
    files: State<'_, Files>,
) -> Result<Vec<PendingOpen>, FileError> {
    require_main(window.label())?;
    Ok(files.take_pending(window.label()))
}

#[tauri::command]
pub fn file_forget_recent(
    window: Window,
    files: State<'_, Files>,
    path: String,
) -> Result<(), FileError> {
    require_main(window.label())?;
    files.update(|lists| lists.forget_recent(&path));
    Ok(())
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DiscardChoice {
    Save,
    Discard,
    Cancel,
}

/// Asks what to do with an unsaved new file that is being closed.
#[tauri::command]
pub fn file_confirm_discard(window: Window, name: String) -> Result<DiscardChoice, FileError> {
    require_main(window.label())?;
    const SAVE: &str = "Save…";
    const DISCARD: &str = "Don't Save";
    const CANCEL: &str = "Cancel";
    let choice = rfd::MessageDialog::new()
        .set_title("Save changes?")
        .set_description(format!(
            "{name} has not been saved. Save it before closing?"
        ))
        .set_buttons(rfd::MessageButtons::YesNoCancelCustom(
            SAVE.to_string(),
            DISCARD.to_string(),
            CANCEL.to_string(),
        ))
        .show();
    Ok(match choice {
        rfd::MessageDialogResult::Custom(label) if label == SAVE => DiscardChoice::Save,
        rfd::MessageDialogResult::Custom(label) if label == DISCARD => DiscardChoice::Discard,
        rfd::MessageDialogResult::Yes => DiscardChoice::Save,
        rfd::MessageDialogResult::No => DiscardChoice::Discard,
        _ => DiscardChoice::Cancel,
    })
}
