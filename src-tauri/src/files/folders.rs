// SPDX-License-Identifier: GPL-3.0-or-later

// One level of a folder the user added to the sidebar: the sub-folders and the
// Markdown and text files in it, minus hidden and ignored entries. Listing
// never leaves the root, even through a symbolic link.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Serialize;

use super::ignore::IgnoreSet;
use super::{FileError, TEXT_EXTENSIONS};

pub const LIST_LIMIT: usize = 2000;
pub const SCAN_LIMIT: usize = 20000;
pub const FOLDER_WATCH_LIMIT: usize = 128;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    Folder,
    File,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FolderEntry {
    pub name: String,
    pub path: String,
    pub kind: EntryKind,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FolderListing {
    pub path: String,
    pub entries: Vec<FolderEntry>,
    pub truncated: bool,
}

fn hidden(name: &str) -> bool {
    name.starts_with('.') || name == "node_modules"
}

fn shown_type(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
        .is_some_and(|ext| TEXT_EXTENSIONS.contains(&ext.as_str()))
}

/// `root` and `folder` are canonical; `folder` is `root` or below it.
pub fn list(root: &Path, folder: &Path) -> Result<FolderListing, FileError> {
    list_within(root, folder, SCAN_LIMIT, LIST_LIMIT)
}

fn list_within(
    root: &Path,
    folder: &Path,
    scan_limit: usize,
    list_limit: usize,
) -> Result<FolderListing, FileError> {
    if !folder.is_dir() {
        return Err(FileError::not_found(folder));
    }
    let reader = fs::read_dir(folder).map_err(|error| FileError::io(folder, &error))?;
    let ignore = IgnoreSet::for_folder(root, folder);
    let mut entries = Vec::new();
    let mut truncated = false;
    for (scanned, entry) in reader.enumerate() {
        if scanned == scan_limit {
            truncated = true;
            break;
        }
        let Ok(entry) = entry else { continue };
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if hidden(&name) {
            continue;
        }
        let path = folder.join(&name);
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        let is_dir = metadata.is_dir();
        if !is_dir && !(metadata.is_file() && shown_type(&path)) {
            continue;
        }
        let is_link = entry.file_type().is_ok_and(|kind| kind.is_symlink());
        if is_link && !path.canonicalize().is_ok_and(|real| real.starts_with(root)) {
            continue;
        }
        if ignore.is_ignored(&path, is_dir) {
            continue;
        }
        entries.push(FolderEntry {
            path: path.to_string_lossy().into_owned(),
            kind: if is_dir {
                EntryKind::Folder
            } else {
                EntryKind::File
            },
            name,
        });
    }
    entries.sort_by_cached_key(|entry| {
        (
            entry.kind == EntryKind::File,
            entry.name.to_lowercase(),
            entry.name.clone(),
        )
    });
    if entries.len() > list_limit {
        entries.truncate(list_limit);
        truncated = true;
    }
    Ok(FolderListing {
        path: folder.to_string_lossy().into_owned(),
        entries,
        truncated,
    })
}

struct Watched {
    root: PathBuf,
    folder: PathBuf,
    modified: Option<SystemTime>,
    /// `None` while the folder cannot be listed.
    listing: Option<FolderListing>,
}

impl Watched {
    fn new(root: PathBuf, folder: PathBuf) -> Self {
        let mut watched = Self {
            root,
            folder,
            modified: None,
            listing: None,
        };
        watched.read();
        watched
    }

    fn read(&mut self) {
        self.modified = fs::metadata(&self.folder)
            .and_then(|metadata| metadata.modified())
            .ok();
        self.listing = list(&self.root, &self.folder).ok();
    }
}

/// Polls the watched folders for changes the sidebar would show. A folder whose modification time is
/// unchanged is not listed again.
#[derive(Default)]
pub struct FolderWatcher {
    watched: Vec<Watched>,
}

impl FolderWatcher {
    /// Watches exactly `folders` ((root, folder) pairs), keeping state of those already watched.
    pub fn set(&mut self, folders: Vec<(PathBuf, PathBuf)>) {
        let mut previous = std::mem::take(&mut self.watched);
        for (root, folder) in folders {
            if self
                .watched
                .iter()
                .any(|watched| watched.root == root && watched.folder == folder)
            {
                continue;
            }
            let kept = previous
                .iter()
                .position(|watched| watched.root == root && watched.folder == folder);
            self.watched.push(match kept {
                Some(index) => previous.swap_remove(index),
                None => Watched::new(root, folder),
            });
        }
    }

    #[cfg(test)]
    pub fn folders(&self) -> Vec<String> {
        self.watched
            .iter()
            .map(|watched| watched.folder.to_string_lossy().into_owned())
            .collect()
    }

    /// Folders whose visible listing changed since the last poll; each change reported once.
    pub fn poll(&mut self) -> Vec<String> {
        let mut changed = Vec::new();
        for watched in &mut self.watched {
            let modified = fs::metadata(&watched.folder)
                .and_then(|metadata| metadata.modified())
                .ok();
            if modified.is_some() && modified == watched.modified {
                continue;
            }
            let before = watched.listing.take();
            watched.read();
            if watched.listing != before {
                changed.push(watched.folder.to_string_lossy().into_owned());
            }
        }
        changed
    }
}

/// Whether `path` (canonical) would be shown by `list` of its parent: under `root`, no component
/// below `root` hidden or `node_modules`, a shown file type, not ignored.
pub fn is_listed(root: &Path, path: &Path) -> bool {
    let Ok(below) = path.strip_prefix(root) else {
        return false;
    };
    let visible = below.components().all(|component| {
        component
            .as_os_str()
            .to_str()
            .is_some_and(|name| !hidden(name))
    });
    if below.as_os_str().is_empty() || !visible || !shown_type(path) {
        return false;
    }
    let Some(parent) = path.parent() else {
        return false;
    };
    !IgnoreSet::for_folder(root, parent).is_ignored(path, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::FileErrorCode;

    fn scratch(name: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("sodilaud-folders-{name}-{nanos}"));
        fs::create_dir_all(&directory).unwrap();
        directory.canonicalize().unwrap()
    }

    fn names(listing: &FolderListing) -> Vec<&str> {
        listing
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect()
    }

    #[test]
    fn lists_folders_then_shown_files_by_name() {
        let root = scratch("order");
        for folder in ["B", "a"] {
            fs::create_dir(root.join(folder)).unwrap();
        }
        for file in ["c.MD", "b.txt", "x.csv", "y.tsv", "z.markdown", "img.png"] {
            fs::write(root.join(file), "").unwrap();
        }
        let listing = list(&root, &root).unwrap();
        assert_eq!(
            names(&listing),
            ["a", "B", "b.txt", "c.MD", "x.csv", "y.tsv", "z.markdown"]
        );
        assert_eq!(listing.entries[0].kind, EntryKind::Folder);
        assert_eq!(listing.entries[1].kind, EntryKind::Folder);
        assert_eq!(listing.entries[2].kind, EntryKind::File);
        assert_eq!(
            listing.entries[2].path,
            root.join("b.txt").to_string_lossy()
        );
        assert!(!listing.truncated);
    }

    #[test]
    fn hides_dot_entries_node_modules_and_ignored() {
        let root = scratch("hidden");
        for folder in [".git", "node_modules", "empty"] {
            fs::create_dir(root.join(folder)).unwrap();
        }
        fs::write(root.join(".hidden.md"), "").unwrap();
        fs::write(root.join("ignored.md"), "").unwrap();
        fs::write(root.join(".gitignore"), "ignored.md\n").unwrap();
        let listing = list(&root, &root).unwrap();
        assert_eq!(names(&listing), ["empty"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_symbolic_link_out_of_the_root_is_not_listed() {
        use std::os::unix::fs::symlink;
        let base = scratch("links");
        let root = base.join("r");
        let outside = base.join("outside");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("o.md"), "").unwrap();
        fs::write(root.join("a.md"), "").unwrap();
        symlink(outside.join("o.md"), root.join("link.md")).unwrap();
        symlink(&outside, root.join("linkdir")).unwrap();
        symlink(root.join("a.md"), root.join("inner.md")).unwrap();
        let listing = list(&root, &root).unwrap();
        assert_eq!(names(&listing), ["a.md", "inner.md"]);
    }

    #[test]
    fn a_huge_folder_stops_reading_and_says_so() {
        let root = scratch("huge");
        for index in 0..=LIST_LIMIT {
            fs::write(root.join(format!("f{index}.md")), "").unwrap();
        }
        let listing = list(&root, &root).unwrap();
        assert_eq!(listing.entries.len(), LIST_LIMIT);
        assert!(listing.truncated);

        let small = scratch("small");
        for index in 0..3 {
            fs::write(small.join(format!("f{index}.md")), "").unwrap();
        }
        assert!(!list(&small, &small).unwrap().truncated);
    }

    #[test]
    fn reading_stops_at_the_scan_limit() {
        let root = scratch("scan");
        for index in 0..5 {
            fs::write(root.join(format!("f{index}.md")), "").unwrap();
        }
        let listing = list_within(&root, &root, 3, LIST_LIMIT).unwrap();
        assert_eq!(listing.entries.len(), 3);
        assert!(listing.truncated);
        assert!(!list_within(&root, &root, 5, LIST_LIMIT).unwrap().truncated);
    }

    #[test]
    fn is_listed_matches_the_listing_filter() {
        let root = scratch("listed");
        fs::write(root.join(".gitignore"), "ignored.md\n").unwrap();
        assert!(is_listed(&root, &root.join("a/b.md")));
        assert!(!is_listed(&root, &root.join(".x/b.md")));
        assert!(!is_listed(&root, &root.join("node_modules/b.md")));
        assert!(!is_listed(&root, &root.join("ignored.md")));
        assert!(!is_listed(&root, &root.join("p.png")));
        assert!(!is_listed(&root, Path::new("/elsewhere/b.md")));
    }

    #[test]
    fn a_missing_folder_is_not_found() {
        let root = scratch("missing");
        let error = list(&root, &root.join("gone")).unwrap_err();
        assert_eq!(error.code, FileErrorCode::NotFound);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_to_a_folder_inside_the_root_is_kept() {
        use std::os::unix::fs::symlink;
        let root = scratch("innerlink");
        fs::create_dir(root.join("real")).unwrap();
        symlink(root.join("real"), root.join("alias")).unwrap();
        let listing = list(&root, &root).unwrap();
        assert_eq!(names(&listing), ["alias", "real"]);
        assert_eq!(listing.entries[0].kind, EntryKind::Folder);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_loop_is_listed_once_without_recursion() {
        use std::os::unix::fs::symlink;
        let base = scratch("loop");
        let root = base.join("r");
        fs::create_dir_all(&root).unwrap();
        symlink(&root, root.join("loop")).unwrap();
        let listing = list(&root, &root).unwrap();
        assert_eq!(names(&listing), ["loop"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_file_name_that_is_not_utf8_is_skipped() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;
        let root = scratch("nonutf8");
        if fs::write(root.join(OsStr::from_bytes(b"bad\xff.md")), "").is_err() {
            return; // the file system (APFS) refuses such names
        }
        fs::write(root.join("ok.md"), "").unwrap();
        let listing = list(&root, &root).unwrap();
        assert_eq!(names(&listing), ["ok.md"]);
    }

    fn bump(folder: &Path, seconds: u64) {
        let handle = fs::File::open(folder).unwrap();
        handle
            .set_modified(SystemTime::now() + std::time::Duration::from_secs(seconds))
            .unwrap();
    }

    #[test]
    fn the_folder_watcher_reports_a_visible_change_once() {
        let root = scratch("watch");
        let mut watcher = FolderWatcher::default();
        watcher.set(vec![(root.clone(), root.clone())]);
        assert!(watcher.poll().is_empty());
        fs::write(root.join("new.md"), "").unwrap();
        bump(&root, 5);
        assert_eq!(watcher.poll(), [root.to_string_lossy().into_owned()]);
        assert!(watcher.poll().is_empty());
    }

    #[test]
    fn an_invisible_change_is_not_reported() {
        let root = scratch("invisible");
        let mut watcher = FolderWatcher::default();
        watcher.set(vec![(root.clone(), root.clone())]);
        fs::write(root.join(".hidden.md"), "").unwrap();
        fs::write(root.join("p.png"), "").unwrap();
        bump(&root, 5);
        assert!(watcher.poll().is_empty());
    }

    #[test]
    fn a_removed_folder_is_reported_once() {
        let root = scratch("removed");
        let sub = root.join("sub");
        fs::create_dir(&sub).unwrap();
        let mut watcher = FolderWatcher::default();
        watcher.set(vec![(root.clone(), sub.clone())]);
        fs::remove_dir(&sub).unwrap();
        assert_eq!(watcher.poll(), [sub.to_string_lossy().into_owned()]);
        assert!(watcher.poll().is_empty());
    }

    #[test]
    fn setting_again_keeps_the_state_of_folders_still_watched() {
        let root = scratch("keep");
        let mut watcher = FolderWatcher::default();
        watcher.set(vec![(root.clone(), root.clone())]);
        fs::write(root.join("new.md"), "").unwrap();
        bump(&root, 5);
        watcher.set(vec![(root.clone(), root.clone())]);
        assert_eq!(watcher.poll().len(), 1);
    }
}
