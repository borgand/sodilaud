// SPDX-License-Identifier: GPL-3.0-or-later

// Markdown and text files edited in the main window. The main window can only
// touch files the user chose (see `grants`), reads and writes them without
// reformatting (see `io`), and hears about outside edits (see `watch`).

pub mod commands;
pub mod drafts;
pub mod folders;
pub mod grants;
pub mod ignore;
pub mod io;
pub mod store;
pub mod watch;
pub mod windows;

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::thread;

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Manager};

use crate::docs::commands::SharedRegistry;
use crate::docs::files::{Disk, Due};
use folders::{FolderListing, FolderWatcher, FOLDER_WATCH_LIMIT};
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
                "{} is not a Markdown or text file. Sodilaud opens .md, .markdown, .txt, .csv and .tsv files.",
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

    pub fn not_in_folder(path: &Path) -> Self {
        Self::new(
            FileErrorCode::NotGranted,
            format!(
                "{} is not in a folder shown in this window.",
                io::file_name(path)
            ),
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
            "Files open only in a main window.".to_string(),
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
    folder_watcher: Mutex<FolderWatcher>,
    /// Per window label.
    pending: Mutex<HashMap<String, Vec<PendingOpen>>>,
    /// Where agents' drafts are kept; none when app data has no folder.
    drafts_dir: Option<PathBuf>,
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
        let drafts_dir = app
            .path()
            .app_data_dir()
            .ok()
            .map(|directory| directory.join(drafts::DIRECTORY));
        Self::new(lists_path, grants, lists, drafts_dir)
    }

    /// A draft is kept until it is saved or discarded, so every draft on disk
    /// stays granted across restarts.
    fn new(
        lists_path: Option<PathBuf>,
        mut grants: Grants,
        lists: Lists,
        drafts_dir: Option<PathBuf>,
    ) -> Self {
        for draft in drafts_dir.as_deref().map(drafts::list).unwrap_or_default() {
            let _ = grants.grant(Path::new(&draft.path));
        }
        let mut folder_watcher = FolderWatcher::default();
        folder_watcher.set(watched_folders(&lists.windows));
        Self {
            lists_path,
            grants: Mutex::new(grants),
            lists: Mutex::new(lists),
            watcher: Mutex::new(Watcher::default()),
            folder_watcher: Mutex::new(folder_watcher),
            pending: Mutex::new(HashMap::new()),
            drafts_dir,
        }
    }

    #[cfg(test)]
    fn for_test() -> Self {
        Self::for_test_with_drafts(None)
    }

    #[cfg(test)]
    fn for_test_with_drafts(drafts_dir: Option<PathBuf>) -> Self {
        let lists = Lists {
            windows: WindowSet::from_saved(vec![]),
            recent: Vec::new(),
        };
        Self::new(None, Grants::default(), lists, drafts_dir)
    }

    pub fn drafts_dir(&self) -> Option<&Path> {
        self.drafts_dir.as_deref()
    }

    pub fn is_draft(&self, path: &Path) -> bool {
        self.drafts_dir
            .as_deref()
            .is_some_and(|dir| drafts::is_draft(dir, path))
    }

    pub fn drafts(&self) -> Vec<drafts::Draft> {
        self.drafts_dir
            .as_deref()
            .map(drafts::list)
            .unwrap_or_default()
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

    /// Changes the lists, saves them and watches every window's open files
    /// and shown folders.
    pub fn update<T>(&self, f: impl FnOnce(&mut Lists) -> T) -> T {
        let (result, snapshot, open, folders) = {
            let mut lists = lock(&self.lists);
            let result = f(&mut lists);
            let snapshot = FileLists {
                windows: lists.windows.saved(),
                recent: lists.recent.clone(),
                open: Vec::new(),
            };
            let folders = watched_folders(&lists.windows);
            (result, snapshot, lists.windows.all_open(), folders)
        };
        if let Some(path) = &self.lists_path {
            if let Err(error) = store::save(path, &snapshot) {
                eprintln!("{error}");
            }
        }
        self.watch(open.into_iter().map(PathBuf::from).collect());
        lock(&self.folder_watcher).set(folders);
        result
    }

    #[cfg(test)]
    fn watched_folders(&self) -> Vec<String> {
        lock(&self.folder_watcher).folders()
    }

    /// The canonical `path` and the root of `label`'s that contains it (the
    /// longest such root). A path that leaves every root, through `..` or a
    /// symbolic link, is refused.
    pub fn in_folder(&self, label: &str, path: &str) -> Result<(PathBuf, PathBuf), FileError> {
        let requested = Path::new(path);
        let roots = self.read(|lists| lists.windows.folders(label));
        let containing = |path: &Path| {
            roots
                .iter()
                .map(PathBuf::from)
                .filter(|root| path.starts_with(root))
                .max_by_key(|root| root.components().count())
        };
        if !requested.is_absolute() {
            return Err(FileError::not_in_folder(requested));
        }
        match requested.canonicalize() {
            Ok(canonical) => match containing(&canonical) {
                Some(root) => Ok((root, canonical)),
                None => Err(FileError::not_in_folder(requested)),
            },
            Err(_) => {
                let plain = requested
                    .components()
                    .all(|part| matches!(part, Component::RootDir | Component::Normal(_)));
                // Where the missing path would be is decided by its nearest existing ancestor, so a
                // link out of the root does not tell what exists on the other side.
                let inside = requested.ancestors().skip(1).find_map(|ancestor| {
                    let real = ancestor.canonicalize().ok()?;
                    let rest = requested.strip_prefix(ancestor).ok()?;
                    Some(containing(&real.join(rest)).is_some())
                }) == Some(true);
                if plain && inside {
                    Err(FileError::not_found(requested))
                } else {
                    Err(FileError::not_in_folder(requested))
                }
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

    pub fn queue(&self, label: &str, entries: Vec<PendingOpen>) {
        lock(&self.pending)
            .entry(label.to_string())
            .or_default()
            .extend(entries);
    }

    pub fn take_pending(&self, label: &str) -> Vec<PendingOpen> {
        lock(&self.pending).remove(label).unwrap_or_default()
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

/// Every window's watched folders, each with the longest root that contains it.
fn watched_folders(windows: &WindowSet) -> Vec<(PathBuf, PathBuf)> {
    let roots: Vec<PathBuf> = windows
        .labels()
        .iter()
        .flat_map(|label| windows.folders(label))
        .map(PathBuf::from)
        .collect();
    windows
        .watched_folders(FOLDER_WATCH_LIMIT)
        .into_iter()
        .map(PathBuf::from)
        .filter_map(|folder| {
            let root = roots
                .iter()
                .filter(|root| folder.starts_with(root))
                .max_by_key(|root| root.components().count())?
                .clone();
            Some((root, folder))
        })
        .collect()
}

/// One level of a folder shown in `label`. A symbolic link is listed as the
/// folder it resolves to, so a link loop cannot grow the tree.
pub(crate) fn folder_listing(
    files: &Files,
    label: &str,
    path: &str,
) -> Result<FolderListing, FileError> {
    let (root, folder) = files.in_folder(label, path)?;
    if !folders::is_shown_folder(&root, &folder) {
        return Err(FileError::not_in_folder(Path::new(path)));
    }
    folders::list(&root, &folder)
}

/// The canonical form of each of `paths` that is a folder the tree of `label`
/// shows. Anything else is dropped, so it never takes a watch slot.
pub(crate) fn expandable_folders(files: &Files, label: &str, paths: &[String]) -> Vec<String> {
    paths
        .iter()
        .filter_map(|path| files.in_folder(label, path).ok())
        .filter(|(root, folder)| folder.is_dir() && folders::is_shown_folder(root, folder))
        .map(|(_, folder)| folder.to_string_lossy().to_string())
        .collect()
}

/// Grants a file the tree of `label` shows, with the agent rules for the
/// file itself. Anything the tree does not show is refused.
pub(crate) fn folder_file(
    files: &Files,
    label: &str,
    path: &str,
) -> Result<OpenedDocument, FileError> {
    let (root, file) = files.in_folder(label, path)?;
    if !is_text_file(&file) {
        return Err(FileError::not_text(Path::new(path)));
    }
    if !folders::is_listed(&root, &file) {
        return Err(FileError::not_in_folder(Path::new(path)));
    }
    let (resolved, bytes) = agent_document(&file.to_string_lossy())?;
    let granted = files.grant(&resolved)?;
    Ok(OpenedDocument {
        path: granted.to_string_lossy().to_string(),
        name: io::file_name(&granted),
        bytes,
    })
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
        // Listing runs without the lock, so a command that sets the watched folders never waits
        // for a scan.
        let mut polled = lock(&files.folder_watcher).take();
        let folders = polled.poll();
        lock(&files.folder_watcher).restore(polled);
        if !folders.is_empty() {
            let handle = watching.clone();
            let _ = watching.run_on_main_thread(move || {
                for path in folders {
                    crate::main_window::emit_all(&handle, FOLDER_EVENT, json!({ "path": path }));
                }
            });
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

pub const FOLDER_EVENT: &str = "folder-changed";

/// A folder shown at the top level of a window's sidebar.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FolderRoot {
    pub path: String,
    pub name: String,
}

impl FolderRoot {
    pub fn new(path: &str) -> Self {
        Self {
            path: path.to_string(),
            name: io::file_name(Path::new(path)),
        }
    }
}

pub const TEXT_EXTENSIONS: &[&str] = &["md", "markdown", "txt", "csv", "tsv"];

fn is_text_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
        .is_some_and(|ext| TEXT_EXTENSIONS.contains(&ext.as_str()))
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

/// Puts an agent's Markdown into a new draft (or finds the one an identical
/// retry made), grants it and shows it like `open_for_agent`.
pub fn open_draft_for_agent(
    app: &AppHandle,
    request_id: &str,
    title: &str,
    content: &str,
) -> Result<OpenedDocument, FileError> {
    let files = app
        .try_state::<Files>()
        .ok_or_else(|| FileError::other("Drafts need the Sodilaud app.".to_string()))?;
    let dir = files.drafts_dir().ok_or_else(|| {
        FileError::other("Sodilaud has no app data folder to keep drafts in.".to_string())
    })?;
    let draft = match drafts::create(dir, request_id, title, content) {
        Ok(drafts::Created::New(draft) | drafts::Created::Existing(draft)) => draft,
        Err(message) => return Err(FileError::new(FileErrorCode::Unsupported, message)),
    };
    let granted = files.grant(Path::new(&draft.path))?;
    let bytes = std::fs::metadata(&granted)
        .map_err(|error| FileError::io(&granted, &error))?
        .len();
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
        agent_document, expandable_folders, folder_file, folder_listing, paths_from_args,
        sibling_document, FileError, FileErrorCode, Files, PendingOpen,
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
    fn csv_and_tsv_files_are_text_files() {
        let directory = scratch("data");
        let csv = directory.join("data.CSV");
        let tsv = directory.join("t.tsv");
        fs::write(&csv, "a,b\n").unwrap();
        fs::write(&tsv, "a\tb\n").unwrap();
        assert!(agent_document(csv.to_str().unwrap()).is_ok());
        assert!(agent_document(tsv.to_str().unwrap()).is_ok());
        let args = ["sodilaud", "/a.csv", "/b.json"].map(String::from);
        assert_eq!(paths_from_args(args), [PathBuf::from("/a.csv")]);
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

    fn add_root(files: &Files, label: &str, root: &Path) {
        files.update(|lists| lists.windows.add_folder(label, root.to_str().unwrap()));
    }

    fn text(path: &Path) -> &str {
        path.to_str().unwrap()
    }

    #[test]
    fn a_path_in_a_root_of_this_window_is_accepted() {
        let root = scratch("in-folder").canonicalize().unwrap();
        fs::create_dir_all(root.join("a")).unwrap();
        fs::write(root.join("a/b.md"), "").unwrap();
        let files = Files::for_test();
        add_root(&files, "main", &root);
        let file = root.join("a/b.md");
        assert_eq!(
            files.in_folder("main", text(&file)).unwrap(),
            (root.clone(), file.clone())
        );
        add_root(&files, "main", &root.join("a"));
        assert_eq!(
            files.in_folder("main", text(&file)).unwrap(),
            (root.join("a"), file.clone()),
            "the longest root wins"
        );
        assert_eq!(
            files.in_folder("main", text(&root)).unwrap(),
            (root.clone(), root.clone())
        );
    }

    #[test]
    fn a_path_outside_or_in_another_windows_root_is_refused() {
        let base = scratch("not-in-folder").canonicalize().unwrap();
        let (r, r2) = (base.join("r"), base.join("r2"));
        fs::create_dir_all(&r).unwrap();
        fs::create_dir_all(&r2).unwrap();
        fs::write(r2.join("x.md"), "").unwrap();
        fs::write(base.join("secret.md"), "").unwrap();
        let files = Files::for_test();
        files.update(|lists| lists.windows.add());
        add_root(&files, "main", &r);
        add_root(&files, "main-2", &r2);
        let refused = |path: &str| files.in_folder("main", path).unwrap_err();
        let other = refused(text(&r2.join("x.md")));
        assert_eq!(other.code, FileErrorCode::NotGranted);
        assert_eq!(
            other.message,
            "x.md is not in a folder shown in this window."
        );
        let up = format!("{}/../secret.md", r.display());
        assert_eq!(refused(&up).code, FileErrorCode::NotGranted);
        assert_eq!(
            refused(&format!("{}/../gone.md", r.display())).code,
            FileErrorCode::NotGranted
        );
        assert_eq!(refused("relative.md").code, FileErrorCode::NotGranted);
        assert_eq!(
            refused(text(&r.join("gone.md"))).code,
            FileErrorCode::NotFound
        );
        assert!(files.in_folder("main-2", text(&r2.join("x.md"))).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn a_symbolic_link_out_of_a_root_is_refused() {
        let base = scratch("folder-escape").canonicalize().unwrap();
        let (r, outside) = (base.join("r"), base.join("outside"));
        fs::create_dir_all(&r).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("x.md"), "").unwrap();
        std::os::unix::fs::symlink(&outside, r.join("escape")).unwrap();
        let files = Files::for_test();
        add_root(&files, "main", &r);
        let escape = r.join("escape");
        assert_eq!(
            files
                .in_folder("main", text(&escape.join("x.md")))
                .unwrap_err()
                .code,
            FileErrorCode::NotGranted
        );
        assert_eq!(
            folder_listing(&files, "main", text(&escape))
                .unwrap_err()
                .code,
            FileErrorCode::NotGranted
        );
        assert_eq!(
            folder_file(&files, "main", text(&escape.join("x.md")))
                .unwrap_err()
                .code,
            FileErrorCode::NotGranted
        );
        assert!(files.require(text(&outside.join("x.md"))).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn expanding_a_link_loop_lists_the_real_folder() {
        let r = scratch("folder-loop").canonicalize().unwrap();
        std::os::unix::fs::symlink(&r, r.join("loop")).unwrap();
        let files = Files::for_test();
        add_root(&files, "main", &r);
        let listing = folder_listing(&files, "main", text(&r.join("loop/loop/loop"))).unwrap();
        assert_eq!(listing.path, text(&r));
        assert_eq!(listing.entries.len(), 1);
        assert_eq!(listing.entries[0].path, text(&r.join("loop")));
    }

    #[cfg(unix)]
    #[test]
    fn a_missing_path_through_a_link_out_of_a_root_is_not_granted() {
        let base = scratch("folder-oracle").canonicalize().unwrap();
        let (r, outside) = (base.join("r"), base.join("outside"));
        fs::create_dir_all(&r).unwrap();
        fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, r.join("escape")).unwrap();
        let files = Files::for_test();
        add_root(&files, "main", &r);
        for path in [r.join("escape/gone.md"), r.join("escape/gone/deeper.md")] {
            assert_eq!(
                files.in_folder("main", text(&path)).unwrap_err().code,
                FileErrorCode::NotGranted,
                "{}",
                path.display()
            );
        }
        assert_eq!(
            files
                .in_folder("main", text(&r.join("gone/deeper.md")))
                .unwrap_err()
                .code,
            FileErrorCode::NotFound
        );
    }

    #[test]
    fn a_folder_the_tree_does_not_show_is_refused() {
        let r = scratch("folder-hidden").canonicalize().unwrap();
        fs::write(r.join(".gitignore"), "build/\n").unwrap();
        for folder in [
            ".git/objects",
            "node_modules/x",
            "build/sub",
            "shown/.cache",
        ] {
            fs::create_dir_all(r.join(folder)).unwrap();
        }
        let files = Files::for_test();
        add_root(&files, "main", &r);
        assert!(folder_listing(&files, "main", text(&r)).is_ok());
        assert!(folder_listing(&files, "main", text(&r.join("shown"))).is_ok());
        for folder in [
            ".git",
            ".git/objects",
            "node_modules",
            "node_modules/x",
            "build",
            "build/sub",
            "shown/.cache",
        ] {
            assert_eq!(
                folder_listing(&files, "main", text(&r.join(folder)))
                    .unwrap_err()
                    .code,
                FileErrorCode::NotGranted,
                "{folder}"
            );
        }
        let requested = [".git", "node_modules/x", "build", "shown/.cache", "shown"]
            .map(|folder| text(&r.join(folder)).to_string());
        assert_eq!(
            expandable_folders(&files, "main", &requested),
            [text(&r.join("shown"))]
        );
    }

    #[test]
    fn only_folders_are_kept_expanded() {
        let r = scratch("folder-expand").canonicalize().unwrap();
        fs::create_dir(r.join("a")).unwrap();
        fs::write(r.join("b.md"), "").unwrap();
        let files = Files::for_test();
        add_root(&files, "main", &r);
        let requested = [r.clone(), r.join("a"), r.join("b.md"), r.join("gone")]
            .map(|path| text(&path).to_string());
        assert_eq!(
            expandable_folders(&files, "main", &requested),
            [text(&r).to_string(), text(&r.join("a")).to_string()]
        );
    }

    #[test]
    fn a_missing_root_lists_as_not_found() {
        let base = scratch("folder-gone").canonicalize().unwrap();
        let r = base.join("r");
        fs::create_dir_all(&r).unwrap();
        let files = Files::for_test();
        add_root(&files, "main", &r);
        fs::remove_dir(&r).unwrap();
        assert_eq!(
            folder_listing(&files, "main", text(&r)).unwrap_err().code,
            FileErrorCode::NotFound
        );
    }

    #[test]
    fn updating_the_lists_watches_roots_and_expanded_folders() {
        let r = scratch("folder-watch").canonicalize().unwrap();
        fs::create_dir_all(r.join("a")).unwrap();
        let files = Files::for_test();
        add_root(&files, "main", &r);
        assert_eq!(files.watched_folders(), [text(&r)]);
        files.update(|lists| {
            lists
                .windows
                .set_expanded("main", vec![text(&r).into(), text(&r.join("a")).into()])
        });
        assert_eq!(
            files.watched_folders(),
            [text(&r).to_string(), text(&r.join("a")).to_string()]
        );
        files.update(|lists| lists.windows.remove_folder("main", text(&r)));
        assert!(files.watched_folders().is_empty());
    }

    #[test]
    fn closing_a_window_unwatches_its_folders() {
        let r = scratch("folder-close").canonicalize().unwrap();
        let files = Files::for_test();
        let label = files.update(|lists| lists.windows.add());
        add_root(&files, &label, &r);
        assert_eq!(files.watched_folders(), [text(&r)]);
        files.update(|lists| lists.windows.remove(&label));
        assert!(files.watched_folders().is_empty());
    }

    #[test]
    fn a_file_shown_in_the_tree_is_granted_when_opened() {
        let r = scratch("folder-open").canonicalize().unwrap();
        fs::write(r.join(".gitignore"), "ignored.md\n").unwrap();
        fs::write(r.join("a.md"), "# A\n").unwrap();
        for name in ["ignored.md", ".x.md", "p.png"] {
            fs::write(r.join(name), "").unwrap();
        }
        fs::create_dir(r.join("node_modules")).unwrap();
        fs::write(r.join("node_modules/n.md"), "").unwrap();
        let files = Files::for_test();
        add_root(&files, "main", &r);

        let opened = folder_file(&files, "main", text(&r.join("a.md"))).unwrap();
        assert_eq!(opened.path, text(&r.join("a.md")));
        assert_eq!(opened.name, "a.md");
        assert_eq!(opened.bytes, 4);
        assert!(files.require(text(&r.join("a.md"))).is_ok());

        for (name, code) in [
            ("ignored.md", FileErrorCode::NotGranted),
            (".x.md", FileErrorCode::NotGranted),
            ("node_modules/n.md", FileErrorCode::NotGranted),
            ("p.png", FileErrorCode::Unsupported),
        ] {
            let path = r.join(name);
            assert_eq!(
                folder_file(&files, "main", text(&path)).unwrap_err().code,
                code,
                "{name}"
            );
            assert!(files.require(text(&path)).is_err(), "{name}");
        }
        assert_eq!(
            folder_file(&files, "main-2", text(&r.join("a.md")))
                .unwrap_err()
                .code,
            FileErrorCode::NotGranted
        );
    }

    #[test]
    fn drafts_on_disk_are_granted_at_load() {
        let base = scratch("drafts-load").canonicalize().unwrap();
        let dir = base.join(super::drafts::DIRECTORY);
        let draft = match super::drafts::create(&dir, "r", "Plan", "# Plan\n").unwrap() {
            super::drafts::Created::New(draft) => draft,
            super::drafts::Created::Existing(_) => panic!("a new draft"),
        };
        let outside = base.join("outside.md");
        fs::write(&outside, "").unwrap();
        let files = Files::for_test_with_drafts(Some(dir));
        assert_eq!(
            files.require(&draft.path).unwrap(),
            PathBuf::from(&draft.path)
        );
        assert!(files.is_draft(Path::new(&draft.path)));
        assert!(!files.is_draft(&outside));
        assert!(files.require(text(&outside)).is_err());
        assert!(!Files::for_test().is_draft(Path::new(&draft.path)));
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
