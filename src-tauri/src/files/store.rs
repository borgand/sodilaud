// SPDX-License-Identifier: GPL-3.0-or-later

// The files that were open and the recently opened ones, kept across restarts in
// `files.json` in app config. Only Rust writes it, so the grants restored from it
// are the user's own earlier choices.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::quicknotes::config::Frame;

pub const FILE_NAME: &str = "files.json";
pub const RECENT_LIMIT: usize = 10;

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SavedWindow {
    #[serde(default)]
    pub open: Vec<String>,
    #[serde(default)]
    pub active: Option<String>,
    #[serde(default)]
    pub frame: Option<Frame>,
}

/// `open` is the union of the windows' open files. Releases before multiple
/// windows read only that field, so it is still written.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileLists {
    #[serde(default)]
    pub windows: Vec<SavedWindow>,
    #[serde(default)]
    pub recent: Vec<String>,
    #[serde(default)]
    pub open: Vec<String>,
}

impl FileLists {
    /// Moves `path` to the front of the recent list.
    pub fn opened_recent(&mut self, path: &str) {
        self.recent.retain(|recent| recent != path);
        self.recent.insert(0, path.to_string());
        self.recent.truncate(RECENT_LIMIT);
    }

    pub fn forget_recent(&mut self, path: &str) {
        self.recent.retain(|recent| recent != path);
    }
}

pub fn load(path: &Path) -> FileLists {
    let mut lists: FileLists = fs::read(path)
        .ok()
        .and_then(|contents| serde_json::from_slice(&contents).ok())
        .unwrap_or_default();
    if lists.windows.is_empty() && !lists.open.is_empty() {
        lists.windows = vec![SavedWindow {
            open: lists.open.clone(),
            ..Default::default()
        }];
    }
    lists
}

pub fn save(path: &Path, lists: &FileLists) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "The file list path has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("Could not create the file list directory: {e}"))?;
    let mut written = lists.clone();
    written.open = Vec::new();
    for open in lists.windows.iter().flat_map(|window| &window.open) {
        if !written.open.contains(open) {
            written.open.push(open.clone());
        }
    }
    let contents = serde_json::to_vec_pretty(&written)
        .map_err(|e| format!("Could not serialize the file list: {e}"))?;
    fs::write(path, contents).map_err(|e| format!("Could not write the file list: {e}"))?;
    crate::restrict_to_owner(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recent_files_are_newest_first_without_duplicates_and_capped() {
        let mut lists = FileLists::default();
        for index in 0..12 {
            lists.opened_recent(&format!("/f/{index}.md"));
        }
        lists.opened_recent("/f/5.md");
        assert_eq!(lists.recent.len(), RECENT_LIMIT);
        assert_eq!(lists.recent[0], "/f/5.md");
        assert_eq!(lists.recent[1], "/f/11.md");
        assert_eq!(lists.recent.iter().filter(|p| *p == "/f/5.md").count(), 1);
    }

    #[test]
    fn a_damaged_file_gives_empty_lists() {
        let directory =
            std::env::temp_dir().join(format!("sodilaud-filelists-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join(FILE_NAME);
        fs::write(&path, b"[").unwrap();
        assert_eq!(load(&path), FileLists::default());
        let lists = FileLists {
            windows: vec![SavedWindow {
                open: vec!["/a.md".into()],
                ..Default::default()
            }],
            recent: vec!["/a.md".into()],
            open: vec!["/a.md".into()],
        };
        save(&path, &lists).unwrap();
        assert_eq!(load(&path), lists);
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let directory =
            std::env::temp_dir().join(format!("sodilaud-filelists-{name}-{}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        directory.join(FILE_NAME)
    }

    #[test]
    fn a_file_from_an_older_release_becomes_one_window() {
        let path = scratch("older");
        fs::write(&path, br#"{"open":["/a.md"],"recent":["/a.md"]}"#).unwrap();
        assert_eq!(
            load(&path).windows,
            vec![SavedWindow {
                open: vec!["/a.md".into()],
                ..Default::default()
            }]
        );
    }

    #[test]
    fn the_open_list_is_still_written_for_older_releases() {
        let path = scratch("union");
        let window = |paths: &[&str]| SavedWindow {
            open: paths.iter().map(|p| p.to_string()).collect(),
            ..Default::default()
        };
        let lists = FileLists {
            windows: vec![window(&["/a.md", "/b.md"]), window(&["/c.md", "/a.md"])],
            ..Default::default()
        };
        save(&path, &lists).unwrap();
        let raw: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(raw["open"], serde_json::json!(["/a.md", "/b.md", "/c.md"]));
    }
}
