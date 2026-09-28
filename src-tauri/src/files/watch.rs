// SPDX-License-Identifier: GPL-3.0-or-later

// Notices when an open file changes on disk. Only a handful of files are ever
// open, so a once-a-second look at their size and modification time is cheap and
// needs no platform watcher. A change is read and hashed; Sodilaud's own writes
// are recognized by hash and not reported.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::Serialize;

use super::io;

pub const CHANGED_EVENT: &str = "file-changed";
pub const INTERVAL: Duration = Duration::from_secs(1);

#[derive(Clone, Debug, PartialEq, Eq)]
struct Stamp {
    modified: Option<SystemTime>,
    len: u64,
}

#[derive(Clone, Debug)]
struct Seen {
    stamp: Option<Stamp>,
    hash: Option<String>,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChangeKind {
    Modified,
    Removed,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct Change {
    pub path: String,
    pub kind: ChangeKind,
}

fn stamp(path: &Path) -> Option<Stamp> {
    fs::metadata(path).ok().map(|metadata| Stamp {
        modified: metadata.modified().ok(),
        len: metadata.len(),
    })
}

/// Whether content with `current` hash is news, given the last hash Sodilaud read
/// or wrote.
pub fn should_report(last_known: Option<&str>, current: &str) -> bool {
    last_known != Some(current)
}

#[derive(Default)]
pub struct Watcher {
    files: HashMap<PathBuf, Seen>,
}

impl Watcher {
    /// Watches exactly `paths`, keeping what is known about those already watched.
    pub fn set(&mut self, paths: Vec<PathBuf>) {
        let mut next = HashMap::new();
        for path in paths {
            let seen = self.files.remove(&path).unwrap_or_else(|| Seen {
                stamp: stamp(&path),
                hash: fs::read(&path).ok().map(|bytes| io::hash(&bytes)),
            });
            next.insert(path, seen);
        }
        self.files = next;
    }

    /// Sodilaud read or wrote `path` with content `hash`.
    pub fn record(&mut self, path: &Path, hash: &str) {
        if let Some(seen) = self.files.get_mut(path) {
            seen.stamp = stamp(path);
            seen.hash = Some(hash.to_string());
        }
    }

    /// One look at every watched file.
    pub fn poll(&mut self) -> Vec<Change> {
        let mut changes = Vec::new();
        for (path, seen) in &mut self.files {
            let current = stamp(path);
            if current == seen.stamp {
                continue;
            }
            let was_present = seen.stamp.is_some();
            seen.stamp = current.clone();
            let Some(current) = current else {
                if was_present {
                    seen.hash = None;
                    changes.push(Change {
                        path: path.to_string_lossy().to_string(),
                        kind: ChangeKind::Removed,
                    });
                }
                continue;
            };
            if current.len > io::MAX_BYTES {
                continue;
            }
            let Ok(bytes) = fs::read(path) else {
                continue;
            };
            let hash = io::hash(&bytes);
            if should_report(seen.hash.as_deref(), &hash) {
                seen.hash = Some(hash);
                changes.push(Change {
                    path: path.to_string_lossy().to_string(),
                    kind: ChangeKind::Modified,
                });
            }
        }
        changes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("sodilaud-watch-{name}-{nanos}"));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    fn only_new_content_is_news() {
        assert!(should_report(None, "a"));
        assert!(should_report(Some("a"), "b"));
        assert!(!should_report(Some("a"), "a"));
    }

    #[test]
    fn reports_an_outside_edit_and_a_removal_but_not_our_own_write() {
        let path = scratch("changes").join("watched.md");
        fs::write(&path, "one").unwrap();
        let mut watcher = Watcher::default();
        watcher.set(vec![path.clone()]);
        assert!(watcher.poll().is_empty());

        let ours = io::write_atomic(&path, "ours, longer", io::LineEnding::Lf, false).unwrap();
        watcher.record(&path, &ours);
        assert!(
            watcher.poll().is_empty(),
            "Sodilaud's own write is not reported"
        );

        fs::write(&path, "theirs, a different length").unwrap();
        assert_eq!(
            watcher.poll(),
            vec![Change {
                path: path.to_string_lossy().to_string(),
                kind: ChangeKind::Modified
            }]
        );
        assert!(watcher.poll().is_empty(), "each change is reported once");

        fs::remove_file(&path).unwrap();
        assert_eq!(watcher.poll()[0].kind, ChangeKind::Removed);
        assert!(watcher.poll().is_empty());
    }

    #[test]
    fn a_touch_without_a_content_change_is_not_reported() {
        let path = scratch("touch").join("same.md");
        fs::write(&path, "same").unwrap();
        let mut watcher = Watcher::default();
        watcher.set(vec![path.clone()]);
        fs::write(&path, "same").unwrap();
        let file = fs::File::options().write(true).open(&path).unwrap();
        file.set_modified(SystemTime::now() + Duration::from_secs(5))
            .unwrap();
        assert!(watcher.poll().is_empty());
    }
}
