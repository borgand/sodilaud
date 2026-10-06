// SPDX-License-Identifier: GPL-3.0-or-later

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{State, Window};

use super::io::{self, LineEnding};
use super::store::FileLists;
use super::{FileError, Files};
use crate::docs::commands::SharedRegistry;
use crate::docs::files::{FileOpened, FileSaved, Resolve};
use crate::docs::registry::{Pulled, Pushed, Update};
use crate::quicknotes::window::MAIN_LABEL;

pub const OPEN_REQUEST_EVENT: &str = "file-open-request";
const TEXT_EXTENSIONS: &[&str] = &["md", "markdown", "txt"];

fn require_main(window: &Window) -> Result<(), FileError> {
    if window.label() == MAIN_LABEL {
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
pub struct Lists {
    open: Vec<String>,
    recent: Vec<RecentFile>,
}

fn lists_view(lists: FileLists) -> Lists {
    Lists {
        open: lists.open,
        recent: lists
            .recent
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
    require_main(&window)?;
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
    require_main(&window)?;
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
    // A document open at that path would otherwise autosave over this write.
    registry.file_discard(&path);
    let hash = files.write(&path, &text, line_ending, bom)?;
    let path_text = path.to_string_lossy().to_string();
    files.update_lists(|lists| lists.opened(&path_text));
    Ok(Some(Saved {
        name: io::file_name(&path),
        path: path_text,
        hash,
    }))
}

/// Opens a granted file in the registry: from the dialog, the recent list,
/// Finder, or at start-up.
#[tauri::command]
pub fn file_doc_open(
    window: Window,
    files: State<'_, Files>,
    registry: State<'_, SharedRegistry>,
    path: String,
) -> Result<FileOpened, FileError> {
    require_main(&window)?;
    let path = files.require(&path)?;
    let opened = registry.file_open(&path, &*files)?;
    files.update_lists(|lists| lists.opened(&opened.path));
    Ok(opened)
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
    require_main(&window)?;
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
    require_main(&window)?;
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
    require_main(&window)?;
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
    require_main(&window)?;
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
    require_main(&window)?;
    registry.file_resolve(&files.require(&path)?, keep, &*files)
}

#[tauri::command]
pub fn file_lists(window: Window, files: State<'_, Files>) -> Result<Lists, FileError> {
    require_main(&window)?;
    Ok(lists_view(files.lists()))
}

/// The files open in the main window, in sidebar order. Only granted paths are
/// kept, and they are the ones watched for outside edits.
#[tauri::command]
pub fn file_set_open(
    window: Window,
    files: State<'_, Files>,
    paths: Vec<String>,
) -> Result<(), FileError> {
    require_main(&window)?;
    let granted: Vec<PathBuf> = paths
        .iter()
        .filter_map(|path| files.require(path).ok())
        .collect();
    let open = granted
        .iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect();
    files.update_lists(|lists| lists.open = open);
    files.watch(granted);
    Ok(())
}

/// Files handed over from Finder or a launch argument, already granted.
#[tauri::command]
pub fn file_take_pending(
    window: Window,
    files: State<'_, Files>,
) -> Result<Vec<String>, FileError> {
    require_main(&window)?;
    Ok(files.take_pending())
}

#[tauri::command]
pub fn file_forget_recent(
    window: Window,
    files: State<'_, Files>,
    path: String,
) -> Result<(), FileError> {
    require_main(&window)?;
    files.update_lists(|lists| lists.forget_recent(&path));
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
    require_main(&window)?;
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
