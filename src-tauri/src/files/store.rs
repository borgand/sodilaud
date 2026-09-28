// SPDX-License-Identifier: GPL-3.0-or-later

// The files that were open and the recently opened ones, kept across restarts in
// `files.json` in app config. Only Rust writes it, so the grants restored from it
// are the user's own earlier choices.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

pub const FILE_NAME: &str = "files.json";
pub const RECENT_LIMIT: usize = 10;

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileLists {
    #[serde(default)]
    pub open: Vec<String>,
    #[serde(default)]
    pub recent: Vec<String>,
}

impl FileLists {
    /// Moves `path` to the front of the recent list and adds it to the open list.
    pub fn opened(&mut self, path: &str) {
        self.recent.retain(|recent| recent != path);
        self.recent.insert(0, path.to_string());
        self.recent.truncate(RECENT_LIMIT);
        if !self.open.iter().any(|open| open == path) {
            self.open.push(path.to_string());
        }
    }

    pub fn forget_recent(&mut self, path: &str) {
        self.recent.retain(|recent| recent != path);
    }
}

pub fn load(path: &Path) -> FileLists {
    fs::read(path)
        .ok()
        .and_then(|contents| serde_json::from_slice(&contents).ok())
        .unwrap_or_default()
}

pub fn save(path: &Path, lists: &FileLists) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "The file list path has no parent directory".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("Could not create the file list directory: {e}"))?;
    let contents =
        serde_json::to_vec_pretty(lists).map_err(|e| format!("Could not serialize the file list: {e}"))?;
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
            lists.opened(&format!("/f/{index}.md"));
        }
        lists.opened("/f/5.md");
        assert_eq!(lists.recent.len(), RECENT_LIMIT);
        assert_eq!(lists.recent[0], "/f/5.md");
        assert_eq!(lists.recent[1], "/f/11.md");
        assert_eq!(lists.recent.iter().filter(|p| *p == "/f/5.md").count(), 1);
        assert_eq!(lists.open.len(), 12);
    }

    #[test]
    fn a_damaged_file_gives_empty_lists() {
        let directory = std::env::temp_dir().join(format!(
            "sodilaud-filelists-{}",
            std::process::id()
        ));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join(FILE_NAME);
        fs::write(&path, b"[").unwrap();
        assert_eq!(load(&path), FileLists::default());
        let lists = FileLists {
            open: vec!["/a.md".into()],
            recent: vec!["/a.md".into()],
        };
        save(&path, &lists).unwrap();
        assert_eq!(load(&path), lists);
    }
}
