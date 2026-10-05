// SPDX-License-Identifier: GPL-3.0-or-later

// Markdown and text files edited in the main window. The main window can only
// touch files the user chose (see `grants`), reads and writes them without
// reformatting (see `io`), and hears about outside edits (see `watch`).

pub mod commands;
pub mod grants;
pub mod io;
pub mod store;
pub mod watch;

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::thread;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::docs::commands::SharedRegistry;
use crate::docs::files::Disk;
use grants::Grants;
use store::FileLists;
use watch::Watcher;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum FileErrorCode {
    NotGranted,
    NotFound,
    NotUtf8,
    TooLarge,
    WrongWindow,
    NotOpen,
    Io,
}

/// What went wrong, in words the main window shows as they are.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct FileError {
    pub code: FileErrorCode,
    pub message: String,
}

impl FileError {
    fn new(code: FileErrorCode, message: String) -> Self {
        Self { code, message }
    }

    pub fn not_open(path: &Path) -> Self {
        Self::new(
            FileErrorCode::NotOpen,
            format!("{} is not open in Sodilaud.", io::file_name(path)),
        )
    }

    pub fn other(message: String) -> Self {
        Self::new(FileErrorCode::Io, message)
    }

    pub fn not_granted(path: &Path) -> Self {
        Self::new(
            FileErrorCode::NotGranted,
            format!(
                "{} was not opened in Sodilaud. Open it again with Open File.",
                io::file_name(path)
            ),
        )
    }

    pub fn not_found(path: &Path) -> Self {
        Self::new(
            FileErrorCode::NotFound,
            format!("{} is no longer on disk.", io::file_name(path)),
        )
    }

    pub fn not_utf8() -> Self {
        Self::new(
            FileErrorCode::NotUtf8,
            "Sodilaud opens UTF-8 text only, and this file uses another encoding.".to_string(),
        )
    }

    pub fn too_large(path: &Path) -> Self {
        Self::new(
            FileErrorCode::TooLarge,
            format!(
                "{} is larger than 10 MB, which Sodilaud does not open.",
                io::file_name(path)
            ),
        )
    }

    pub fn wrong_window() -> Self {
        Self::new(
            FileErrorCode::WrongWindow,
            "Files open only in the main window.".to_string(),
        )
    }

    pub fn io(path: &Path, error: &std::io::Error) -> Self {
        if error.kind() == std::io::ErrorKind::NotFound {
            return Self::not_found(path);
        }
        Self::new(
            FileErrorCode::Io,
            format!("{}: {error}", io::file_name(path)),
        )
    }
}

pub struct Files {
    lists_path: Option<PathBuf>,
    grants: Mutex<Grants>,
    lists: Mutex<FileLists>,
    watcher: Mutex<Watcher>,
    /// Files handed over from outside that the page has not taken yet.
    pending: Mutex<Vec<String>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Files {
    /// Restores the open and recent lists, and the grants for them.
    fn load(app: &AppHandle) -> Self {
        let lists_path = app
            .path()
            .app_config_dir()
            .ok()
            .map(|directory| directory.join(store::FILE_NAME));
        let lists = lists_path.as_deref().map(store::load).unwrap_or_default();
        let mut grants = Grants::default();
        for path in lists.open.iter().chain(&lists.recent) {
            let _ = grants.grant(Path::new(path));
        }
        Self {
            lists_path,
            grants: Mutex::new(grants),
            lists: Mutex::new(lists),
            watcher: Mutex::new(Watcher::default()),
            pending: Mutex::new(Vec::new()),
        }
    }

    pub fn grant(&self, path: &Path) -> Result<PathBuf, FileError> {
        lock(&self.grants).grant(path)
    }

    pub fn require(&self, path: &str) -> Result<PathBuf, FileError> {
        lock(&self.grants).require(Path::new(path))
    }

    pub fn lists(&self) -> FileLists {
        lock(&self.lists).clone()
    }

    pub fn update_lists(&self, change: impl FnOnce(&mut FileLists)) {
        let snapshot = {
            let mut lists = lock(&self.lists);
            change(&mut lists);
            lists.clone()
        };
        if let Some(path) = &self.lists_path {
            if let Err(error) = store::save(path, &snapshot) {
                eprintln!("{error}");
            }
        }
    }

    pub fn watch(&self, paths: Vec<PathBuf>) {
        lock(&self.watcher).set(paths);
    }

    pub fn record(&self, path: &Path, hash: &str) {
        lock(&self.watcher).record(path, hash);
    }

    /// Writes and records the write under the watcher's lock, so a poll can never
    /// see Sodilaud's own write before it is known.
    pub fn write(
        &self,
        path: &Path,
        text: &str,
        line_ending: io::LineEnding,
        bom: bool,
    ) -> Result<String, FileError> {
        let mut watcher = lock(&self.watcher);
        let hash = io::write_atomic(path, text, line_ending, bom)?;
        watcher.record(path, &hash);
        Ok(hash)
    }

    pub fn take_pending(&self) -> Vec<String> {
        std::mem::take(&mut *lock(&self.pending))
    }
}

impl Disk for Files {
    fn read(&self, path: &Path) -> Result<Vec<u8>, FileError> {
        let bytes = io::read_bytes(path)?;
        self.record(path, &io::hash(&bytes));
        Ok(bytes)
    }

    fn write(
        &self,
        path: &Path,
        text: &str,
        line_ending: io::LineEnding,
        bom: bool,
    ) -> Result<String, FileError> {
        Files::write(self, path, text, line_ending, bom)
    }
}

/// Called from setup, after the registry: restores the file lists, watches
/// the open files for outside edits and autosaves them.
pub fn start(app: &AppHandle) {
    app.manage(Files::load(app));
    let registry = app.state::<SharedRegistry>().inner().clone();
    let watching = app.clone();
    let watched = registry.clone();
    thread::spawn(move || loop {
        thread::sleep(watch::INTERVAL);
        let files = watching.state::<Files>();
        let changes = lock(&files.watcher).poll();
        for change in changes {
            let removed = change.kind == watch::ChangeKind::Removed;
            watched.file_changed_on_disk(Path::new(&change.path), removed, &*files);
        }
    });
    let saving = app.clone();
    thread::spawn(move || loop {
        let path = registry.file_next_due();
        // A failure reaches the page as a `file-doc-saved` event.
        let _ = registry.file_save(&path, &*saving.state::<Files>());
    });
}

/// Files handed to Sodilaud from outside (Finder, or a launch with file
/// arguments): grant them, show the main window and tell it to take them. At
/// launch the page may not be listening yet; it takes pending files when it
/// starts too.
pub fn open_from_system(app: &AppHandle, paths: Vec<PathBuf>) {
    let Some(files) = app.try_state::<Files>() else {
        return;
    };
    let granted: Vec<String> = paths
        .iter()
        .filter_map(|path| files.grant(path).ok())
        .map(|path| path.to_string_lossy().to_string())
        .collect();
    if granted.is_empty() {
        return;
    }
    lock(&files.pending).extend(granted);
    crate::quicknotes::window::show_main(app, None);
    let _ = app.emit_to(
        crate::quicknotes::window::MAIN_LABEL,
        commands::OPEN_REQUEST_EVENT,
        (),
    );
}

/// The files named on a command line, skipping flags and the program itself.
/// macOS hands files over as events instead.
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub fn paths_from_args<I: IntoIterator<Item = String>>(args: I) -> Vec<PathBuf> {
    args.into_iter()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .map(PathBuf::from)
        .filter(|path| {
            matches!(
                path.extension()
                    .and_then(|ext| ext.to_str())
                    .map(str::to_ascii_lowercase)
                    .as_deref(),
                Some("md" | "markdown" | "txt")
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::paths_from_args;
    use std::path::PathBuf;

    #[test]
    fn a_second_launch_passes_only_its_text_files() {
        let args = [
            "sodilaud",
            "--flag",
            "/home/u/Notes.MD",
            "/home/u/photo.png",
            "readme.txt",
        ]
        .map(String::from);
        assert_eq!(
            paths_from_args(args),
            vec![
                PathBuf::from("/home/u/Notes.MD"),
                PathBuf::from("readme.txt")
            ]
        );
    }
}
