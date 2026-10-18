// SPDX-License-Identifier: GPL-3.0-or-later

// Markdown and text files edited in the main window. The main window can only
// touch files the user chose (see `grants`), reads and writes them without
// reformatting (see `io`), and hears about outside edits (see `watch`).

pub mod commands;
pub mod grants;
pub mod io;
pub mod store;
pub mod watch;
pub mod windows;

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::thread;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::docs::commands::SharedRegistry;
use crate::docs::files::{Disk, Due};
use grants::Grants;
use store::FileLists;
use watch::Watcher;
use windows::WindowSet;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum FileErrorCode {
    NotGranted,
    NotFound,
    NotUtf8,
    TooLarge,
    WrongWindow,
    NotOpen,
    Unsupported,
    OpenElsewhere,
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

    pub fn does_not_exist(path: &Path) -> Self {
        Self::new(
            FileErrorCode::NotFound,
            format!("{} does not exist.", path.display()),
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

    pub fn not_absolute(path: &Path) -> Self {
        Self::new(
            FileErrorCode::Unsupported,
            format!(
                "{} is not a full path. Give the full path to the file.",
                path.display()
            ),
        )
    }

    pub fn not_text(path: &Path) -> Self {
        Self::new(
            FileErrorCode::Unsupported,
            format!(
                "{} is not a Markdown or text file. Sodilaud opens .md, .markdown and .txt files.",
                io::file_name(path)
            ),
        )
    }

    pub fn outside_folder(relative: &str) -> Self {
        Self::new(
            FileErrorCode::Unsupported,
            format!("{relative} is not in this document's folder or below it."),
        )
    }

    pub fn open_elsewhere(path: &Path) -> Self {
        Self::new(
            FileErrorCode::OpenElsewhere,
            format!("{} is open in another window.", io::file_name(path)),
        )
    }

    pub fn owned_elsewhere(path: &Path) -> Self {
        Self::new(
            FileErrorCode::Unsupported,
            format!(
                "{} is open in another window. Close it there first.",
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

pub struct Lists {
    pub windows: WindowSet,
    pub recent: Vec<String>,
}

impl Lists {
    /// Moves `path` to the front of the recent list.
    pub fn opened_recent(&mut self, path: &str) {
        self.recent.retain(|recent| recent != path);
        self.recent.insert(0, path.to_string());
        self.recent.truncate(store::RECENT_LIMIT);
    }

    pub fn forget_recent(&mut self, path: &str) {
        self.recent.retain(|recent| recent != path);
    }
}

/// A file handed to one window that its page has not taken yet. `view` is
/// the scroll and selection a moved file carries.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PendingOpen {
    pub path: String,
    pub view: Option<serde_json::Value>,
}

pub struct Files {
    lists_path: Option<PathBuf>,
    grants: Mutex<Grants>,
    lists: Mutex<Lists>,
    watcher: Mutex<Watcher>,
    /// Per window label.
    pending: Mutex<HashMap<String, Vec<PendingOpen>>>,
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
        let saved = lists_path.as_deref().map(store::load).unwrap_or_default();
        let lists = Lists {
            windows: WindowSet::from_saved(saved.windows),
            recent: saved.recent,
        };
        let mut grants = Grants::default();
        for path in lists.windows.all_open().iter().chain(&lists.recent) {
            let _ = grants.grant(Path::new(path));
        }
        Self::new(lists_path, grants, lists)
    }

    fn new(lists_path: Option<PathBuf>, grants: Grants, lists: Lists) -> Self {
        Self {
            lists_path,
            grants: Mutex::new(grants),
            lists: Mutex::new(lists),
            watcher: Mutex::new(Watcher::default()),
            pending: Mutex::new(HashMap::new()),
        }
    }

    #[cfg(test)]
    fn for_test() -> Self {
        let lists = Lists {
            windows: WindowSet::from_saved(vec![]),
            recent: Vec::new(),
        };
        Self::new(None, Grants::default(), lists)
    }

    pub fn grant(&self, path: &Path) -> Result<PathBuf, FileError> {
        lock(&self.grants).grant(path)
    }

    pub fn require(&self, path: &str) -> Result<PathBuf, FileError> {
        lock(&self.grants).require(Path::new(path))
    }

    pub fn read<T>(&self, f: impl FnOnce(&Lists) -> T) -> T {
        f(&lock(&self.lists))
    }

    /// Changes the lists, saves them and watches every window's open files.
    pub fn update<T>(&self, f: impl FnOnce(&mut Lists) -> T) -> T {
        let (result, snapshot, open) = {
            let mut lists = lock(&self.lists);
            let result = f(&mut lists);
            let snapshot = FileLists {
                windows: lists.windows.saved(),
                recent: lists.recent.clone(),
                open: Vec::new(),
            };
            (result, snapshot, lists.windows.all_open())
        };
        if let Some(path) = &self.lists_path {
            if let Err(error) = store::save(path, &snapshot) {
                eprintln!("{error}");
            }
        }
        self.watch(open.into_iter().map(PathBuf::from).collect());
        result
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

    pub fn queue(&self, label: &str, entries: Vec<PendingOpen>) {
        lock(&self.pending)
            .entry(label.to_string())
            .or_default()
            .extend(entries);
    }

    pub fn take_pending(&self, label: &str) -> Vec<PendingOpen> {
        lock(&self.pending).remove(label).unwrap_or_default()
    }

    #[allow(dead_code)]
    pub fn drop_pending(&self, label: &str) {
        lock(&self.pending).remove(label);
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
    if let Ok(directory) = app.path().app_data_dir() {
        registry.set_comment_dir(directory.join(crate::store::comments::DIRECTORY));
        registry.set_coedit_mirror(directory.join(crate::docs::coedit::FILE_NAME));
    }
    let saving = app.clone();
    thread::spawn(move || loop {
        match registry.file_next_due() {
            // A failure reaches the page as a `file-doc-saved` event.
            Due::Save(path) => {
                let _ = registry.file_save(&path, &*saving.state::<Files>());
            }
            Due::Comments(path) => registry.file_save_comments(&path),
        }
    });
}

/// Files handed to Sodilaud from outside (Finder, or a launch with file
/// arguments): grant them, show the window that has each one open (or the
/// focused window) and tell it to take them. At launch the page may not be
/// listening yet; it takes pending files when it starts too.
pub fn open_from_system(app: &AppHandle, paths: Vec<PathBuf>) {
    let Some(files) = app.try_state::<Files>() else {
        return;
    };
    let granted: Vec<String> = paths
        .iter()
        .filter_map(|path| files.grant(path).ok())
        .map(|path| path.to_string_lossy().to_string())
        .collect();
    present_pending(app, &files, granted);
}

pub fn present_pending(app: &AppHandle, files: &Files, granted: Vec<String>) {
    if granted.is_empty() {
        return;
    }
    let groups = files.read(|lists| lists.windows.route(&granted));
    for (label, paths) in groups {
        let entries = paths
            .into_iter()
            .map(|path| PendingOpen { path, view: None })
            .collect();
        files.queue(&label, entries);
        crate::main_window::present(app, &label);
    }
}

fn is_text_file(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|ext| ext.to_str())
            .map(str::to_ascii_lowercase)
            .as_deref(),
        Some("md" | "markdown" | "txt")
    )
}

/// Checks a file an agent asks the main window to open, with the file editor's
/// rules: a full path to an existing UTF-8 text file within the size limit, whose
/// real name (after symbolic links) has a text extension. Returns that real path
/// and its size in bytes.
pub fn agent_document(path: &str) -> Result<(PathBuf, u64), FileError> {
    let requested = Path::new(path);
    if !requested.is_absolute() {
        return Err(FileError::not_absolute(requested));
    }
    if !is_text_file(requested) {
        return Err(FileError::not_text(requested));
    }
    let resolved = requested.canonicalize().map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            FileError::does_not_exist(requested)
        } else {
            FileError::io(requested, &error)
        }
    })?;
    if resolved.is_file() && !is_text_file(&resolved) {
        return Err(FileError::not_text(requested));
    }
    let bytes = io::read_bytes(&resolved)?;
    io::decode_normalized(&bytes)?;
    Ok((resolved, bytes.len() as u64))
}

/// Checks a file a link in `from` names by a relative path, such as one
/// chapter of a review book linking the next. The target must be a plain
/// relative path, resolve (after symbolic links) to `from`'s folder or below,
/// and pass the agent rules. `from` is a canonical, granted path.
pub fn sibling_document(from: &Path, relative: &str) -> Result<(PathBuf, u64), FileError> {
    let requested = Path::new(relative);
    let plain = !relative.is_empty()
        && !relative.contains(['\\', ':'])
        && requested
            .components()
            .all(|part| matches!(part, Component::Normal(_) | Component::CurDir));
    if !plain {
        return Err(FileError::outside_folder(relative));
    }
    let folder = from
        .parent()
        .ok_or_else(|| FileError::outside_folder(relative))?;
    let target = folder.join(requested);
    let (resolved, bytes) = agent_document(&target.to_string_lossy())?;
    if !resolved.starts_with(folder) {
        return Err(FileError::outside_folder(relative));
    }
    Ok((resolved, bytes))
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpenedDocument {
    pub path: String,
    pub name: String,
    pub bytes: u64,
}

/// Opens a file an agent named, the way Finder's "Open With" does: grants that
/// one file, then shows it in the window that has it open, or the focused one.
/// Opening an open file switches to it.
pub fn open_for_agent(app: &AppHandle, path: &str) -> Result<OpenedDocument, FileError> {
    let (resolved, bytes) = agent_document(path)?;
    let files = app
        .try_state::<Files>()
        .ok_or_else(|| FileError::not_granted(&resolved))?;
    let granted = files.grant(&resolved)?;
    let opened = OpenedDocument {
        path: granted.to_string_lossy().to_string(),
        name: io::file_name(&granted),
        bytes,
    };
    let handle = app.clone();
    let pending = opened.path.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(files) = handle.try_state::<Files>() {
            present_pending(&handle, &files, vec![pending]);
        }
    });
    Ok(opened)
}

/// The files named on a command line, skipping flags and the program itself.
/// macOS hands files over as events instead.
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub fn paths_from_args<I: IntoIterator<Item = String>>(args: I) -> Vec<PathBuf> {
    args.into_iter()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .map(PathBuf::from)
        .filter(|path| is_text_file(path))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{
        agent_document, paths_from_args, sibling_document, FileError, FileErrorCode, Files,
        PendingOpen,
    };
    use crate::files::store::RECENT_LIMIT;
    use serde_json::json;
    use std::fs;
    use std::path::{Path, PathBuf};

    #[test]
    fn pending_opens_are_kept_per_window() {
        let files = Files::for_test();
        files.queue(
            "main",
            vec![PendingOpen {
                path: "/a.md".into(),
                view: None,
            }],
        );
        files.queue(
            "main-2",
            vec![PendingOpen {
                path: "/b.md".into(),
                view: Some(json!({"top": 3})),
            }],
        );
        assert_eq!(files.take_pending("main-2")[0].path, "/b.md");
        assert!(files.take_pending("main-2").is_empty());
        assert_eq!(files.take_pending("main").len(), 1);
    }

    #[test]
    fn recent_files_are_newest_first_without_duplicates_and_capped() {
        let files = Files::for_test();
        files.update(|lists| {
            for index in 0..12 {
                lists.opened_recent(&format!("/f/{index}.md"));
            }
            lists.opened_recent("/f/5.md");
        });
        let recent = files.read(|lists| lists.recent.clone());
        assert_eq!(recent.len(), RECENT_LIMIT);
        assert_eq!(recent[0], "/f/5.md");
        assert_eq!(recent[1], "/f/11.md");
        assert_eq!(recent.iter().filter(|p| *p == "/f/5.md").count(), 1);
    }

    #[test]
    fn an_open_elsewhere_error_names_the_file() {
        let error = FileError::open_elsewhere(Path::new("/d/plan.md"));
        assert_eq!(error.code, FileErrorCode::OpenElsewhere);
        assert_eq!(error.message, "plan.md is open in another window.");
        assert_eq!(
            FileError::owned_elsewhere(Path::new("/d/plan.md")).message,
            "plan.md is open in another window. Close it there first."
        );
    }

    fn scratch(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("sodilaud-agent-{name}-{nanos}"));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    fn code(path: &std::path::Path) -> FileErrorCode {
        agent_document(path.to_str().unwrap()).unwrap_err().code
    }

    #[test]
    fn an_agent_opens_an_existing_absolute_text_file() {
        let directory = scratch("open");
        let note = directory.join("Plan.MD");
        fs::write(&note, "# Plan\n").unwrap();
        let (path, bytes) = agent_document(note.to_str().unwrap()).unwrap();
        assert_eq!(path, note.canonicalize().unwrap());
        assert_eq!(bytes, 7);
        let text = directory.join("todo.txt");
        fs::write(&text, "").unwrap();
        assert!(agent_document(text.to_str().unwrap()).is_ok());
    }

    #[test]
    fn an_agent_cannot_open_relative_missing_or_other_files() {
        let directory = scratch("refuse");
        let relative = agent_document("Plan.md").unwrap_err();
        assert_eq!(relative.code, FileErrorCode::Unsupported);
        assert!(relative.message.contains("full path"));
        let missing = agent_document(directory.join("missing.md").to_str().unwrap()).unwrap_err();
        assert_eq!(missing.code, FileErrorCode::NotFound);
        assert!(
            missing.message.contains("does not exist"),
            "{}",
            missing.message
        );
        assert_eq!(
            code(&directory.join("missing.json")),
            FileErrorCode::Unsupported
        );
        let json = directory.join("data.json");
        fs::write(&json, "{}").unwrap();
        assert_eq!(code(&json), FileErrorCode::Unsupported);
        fs::create_dir(directory.join("folder.md")).unwrap();
        assert_eq!(code(&directory.join("folder.md")), FileErrorCode::NotFound);
        let latin = directory.join("latin.md");
        fs::write(&latin, b"caf\xE9").unwrap();
        assert_eq!(code(&latin), FileErrorCode::NotUtf8);
        #[cfg(unix)]
        {
            let link = directory.join("link.md");
            std::os::unix::fs::symlink(&json, &link).unwrap();
            assert_eq!(code(&link), FileErrorCode::Unsupported);
        }
    }

    #[test]
    fn a_link_opens_a_text_file_in_the_same_folder_or_below() {
        let directory = scratch("sibling").canonicalize().unwrap();
        let from = directory.join("00-overview.md");
        fs::write(&from, "# Overview\n").unwrap();
        fs::write(directory.join("01-tools.md"), "# Tools\n").unwrap();
        fs::create_dir(directory.join("notes")).unwrap();
        fs::write(directory.join("notes/a b.txt"), "text").unwrap();

        let (path, bytes) = sibling_document(&from, "01-tools.md").unwrap();
        assert_eq!(path, directory.join("01-tools.md"));
        assert_eq!(bytes, 8);
        assert_eq!(
            sibling_document(&from, "./notes/a b.txt").unwrap().0,
            directory.join("notes/a b.txt")
        );
    }

    #[test]
    fn a_link_cannot_leave_the_folder_or_open_other_files() {
        let root = scratch("sibling-refuse").canonicalize().unwrap();
        let directory = root.join("book");
        fs::create_dir(&directory).unwrap();
        let from = directory.join("00-overview.md");
        fs::write(&from, "# Overview\n").unwrap();
        fs::write(root.join("secret.md"), "secret").unwrap();
        fs::write(directory.join("data.json"), "{}").unwrap();

        let refused = |relative: &str| sibling_document(&from, relative).unwrap_err().code;
        for relative in [
            "../secret.md",
            "notes/../../secret.md",
            "/etc/hosts.md",
            "",
            "C:secret.md",
            "a\\..\\secret.md",
        ] {
            assert_eq!(refused(relative), FileErrorCode::Unsupported, "{relative}");
        }
        let absolute = root.join("secret.md");
        assert_eq!(
            refused(absolute.to_str().unwrap()),
            FileErrorCode::Unsupported
        );
        assert_eq!(refused("missing.md"), FileErrorCode::NotFound);
        assert_eq!(refused("data.json"), FileErrorCode::Unsupported);
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("secret.md"), directory.join("escape.md"))
                .unwrap();
            assert_eq!(refused("escape.md"), FileErrorCode::Unsupported);
            std::os::unix::fs::symlink(&root, directory.join("up")).unwrap();
            assert_eq!(refused("up/secret.md"), FileErrorCode::Unsupported);
        }
    }

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
