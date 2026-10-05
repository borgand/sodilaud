// SPDX-License-Identifier: GPL-3.0-or-later

//! Files open in the main window. Each is a `Collab` document like a note, so
//! the editor is a collab client and Rust owns the text. Rust autosaves it in
//! the file's own line ending and byte-order mark, and merges an edit made
//! outside Sodilaud into it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use serde::Serialize;

use super::collab::{Collab, Pulled, Pushed, Update};
use super::registry::Registry;
use crate::files::io::{self, LineEnding};
use crate::files::{FileError, FileErrorCode};

pub(crate) const SAVE_DELAY: Duration = Duration::from_millis(400);

/// Reads and writes files; the app's version tells the watcher about every
/// read and write, so they are not reported back as outside edits.
pub(crate) trait Disk {
    fn read(&self, path: &Path) -> Result<Vec<u8>, FileError>;
    fn write(
        &self,
        path: &Path,
        text: &str,
        line_ending: LineEnding,
        bom: bool,
    ) -> Result<String, FileError>;
}

/// Why a file is not autosaved: it changed on disk while it had unsaved
/// edits that could not be merged, or it is gone.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum External {
    Conflict,
    Removed,
}

struct SaveState {
    saved_version: u64,
    due: Option<Instant>,
    error: Option<String>,
}

pub(crate) struct FileDoc {
    pub(crate) collab: Collab,
    line_ending: LineEnding,
    bom: bool,
    /// The text last read from or written to disk: the base of a merge.
    synced: String,
    disk_hash: String,
    save: SaveState,
    external: Option<External>,
}

impl FileDoc {
    fn opened(&self, path: &Path) -> FileOpened {
        FileOpened {
            path: path.to_string_lossy().into_owned(),
            name: io::file_name(path),
            text: self.collab.text().to_string(),
            version: self.collab.version(),
            line_ending: self.line_ending,
            bom: self.bom,
            saved_version: self.save.saved_version,
            external: self.external,
        }
    }

    fn saved(&self, path: &Path) -> FileSaved {
        FileSaved {
            path: path.to_string_lossy().into_owned(),
            version: self.save.saved_version,
            hash: Some(self.disk_hash.clone()),
            error: self.save.error.clone(),
        }
    }
}

#[derive(Default)]
pub(crate) struct FileDocs {
    docs: Mutex<HashMap<PathBuf, FileDoc>>,
    /// Held for every write and every look at the disk, so one file is never
    /// written twice at once and an outside edit is never read mid-write.
    writing: Mutex<()>,
    wake: Condvar,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileOpened {
    pub(crate) path: String,
    pub(crate) name: String,
    pub(crate) text: String,
    pub(crate) version: u64,
    pub(crate) line_ending: LineEnding,
    pub(crate) bom: bool,
    pub(crate) saved_version: u64,
    pub(crate) external: Option<External>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileDocUpdates {
    pub(crate) path: String,
    /// The version the first update applies to.
    pub(crate) from: u64,
    pub(crate) updates: Vec<Update>,
    pub(crate) version: u64,
}

/// The file on disk now matches `version`, or the write failed with `error`.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileSaved {
    pub(crate) path: String,
    pub(crate) version: u64,
    pub(crate) hash: Option<String>,
    pub(crate) error: Option<String>,
}

/// What an outside edit did to an open file.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ExternalKind {
    /// Disk and the document agree again: the edit was applied, or a
    /// conflict was resolved.
    Applied,
    /// The edit was merged with unsaved changes, which will be saved.
    Merged,
    Conflict,
    Removed,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileExternal {
    pub(crate) path: String,
    pub(crate) kind: ExternalKind,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Registry {
    fn file_docs(&self) -> MutexGuard<'_, HashMap<PathBuf, FileDoc>> {
        lock(&self.files.docs)
    }

    fn emit_file_doc(&self, path: &Path, from: u64, updates: Vec<Update>, version: u64) {
        if let Some(sink) = self.sink() {
            sink.file_doc(&FileDocUpdates {
                path: path.to_string_lossy().into_owned(),
                from,
                updates,
                version,
            });
        }
    }

    fn emit_saved(&self, saved: &FileSaved) {
        if let Some(sink) = self.sink() {
            sink.file_saved(saved);
        }
    }

    /// Reads `path` into the registry, or returns the document already open.
    pub(crate) fn file_open(&self, path: &Path, disk: &dyn Disk) -> Result<FileOpened, FileError> {
        if let Some(doc) = self.file_docs().get(path) {
            return Ok(doc.opened(path));
        }
        let _writing = lock(&self.files.writing);
        let bytes = disk.read(path)?;
        let (text, line_ending, bom) = io::decode_normalized(&bytes)?;
        let mut docs = self.file_docs();
        let doc = docs.entry(path.to_path_buf()).or_insert_with(|| FileDoc {
            collab: Collab::new(text.clone()),
            line_ending,
            bom,
            synced: text,
            disk_hash: io::hash(&bytes),
            save: SaveState {
                saved_version: 0,
                due: None,
                error: None,
            },
            external: None,
        });
        Ok(doc.opened(path))
    }

    pub(crate) fn file_push(
        &self,
        path: &Path,
        version: u64,
        updates: Vec<Update>,
    ) -> Result<Pushed, FileError> {
        let mut docs = self.file_docs();
        let doc = docs
            .get_mut(path)
            .ok_or_else(|| FileError::not_open(path))?;
        let current = doc.collab.version();
        if version != current {
            return Ok(Pushed {
                accepted: false,
                version: current,
            });
        }
        if updates.is_empty() {
            return Ok(Pushed {
                accepted: true,
                version,
            });
        }
        let text = doc.collab.apply(&updates).map_err(FileError::other)?;
        let from = doc.collab.commit(text, updates.clone());
        let version = doc.collab.version();
        doc.save.due = Some(Instant::now() + SAVE_DELAY);
        self.emit_file_doc(path, from, updates, version);
        self.files.wake.notify_all();
        Ok(Pushed {
            accepted: true,
            version,
        })
    }

    pub(crate) fn file_pull(&self, path: &Path, since: u64) -> Result<Pulled, FileError> {
        let docs = self.file_docs();
        let doc = docs.get(path).ok_or_else(|| FileError::not_open(path))?;
        doc.collab.pull(since).map_err(FileError::other)
    }

    /// Writes the document now if it has changes disk does not, unless it
    /// changed on disk or is gone.
    pub(crate) fn file_save(&self, path: &Path, disk: &dyn Disk) -> Result<FileSaved, FileError> {
        let _writing = lock(&self.files.writing);
        let (text, version, line_ending, bom) = {
            let mut docs = self.file_docs();
            let doc = docs
                .get_mut(path)
                .ok_or_else(|| FileError::not_open(path))?;
            doc.save.due = None;
            if doc.external.is_some() || doc.collab.version() == doc.save.saved_version {
                return Ok(doc.saved(path));
            }
            (
                doc.collab.text().to_string(),
                doc.collab.version(),
                doc.line_ending,
                doc.bom,
            )
        };
        let written = disk.write(path, &text, line_ending, bom);
        let mut docs = self.file_docs();
        let Some(doc) = docs.get_mut(path) else {
            return written.map(|hash| FileSaved {
                path: path.to_string_lossy().into_owned(),
                version,
                hash: Some(hash),
                error: None,
            });
        };
        match written {
            Ok(hash) => {
                doc.save.saved_version = version;
                doc.save.error = None;
                doc.synced = text;
                doc.disk_hash = hash;
                let saved = doc.saved(path);
                self.emit_saved(&saved);
                Ok(saved)
            }
            Err(error) => {
                doc.save.error = Some(error.message.clone());
                self.emit_saved(&FileSaved {
                    hash: None,
                    ..doc.saved(path)
                });
                Err(error)
            }
        }
    }

    /// Writes a pending save, then forgets the document.
    pub(crate) fn file_close(&self, path: &Path, disk: &dyn Disk) -> Result<(), FileError> {
        match self.file_save(path, disk) {
            Err(error) if error.code != FileErrorCode::NotOpen => return Err(error),
            _ => {}
        }
        self.file_docs().remove(path);
        Ok(())
    }

    /// Forgets the document without writing it: its file was just replaced
    /// by Save As from another document.
    pub(crate) fn file_discard(&self, path: &Path) {
        self.file_docs().remove(path);
    }

    /// The document whose autosave is due at `now`, the earliest first.
    pub(crate) fn file_due(&self, now: Instant) -> Option<PathBuf> {
        self.file_docs()
            .iter()
            .filter(|(_, doc)| doc.external.is_none())
            .filter_map(|(path, doc)| doc.save.due.map(|due| (due, path)))
            .filter(|(due, _)| *due <= now)
            .min_by_key(|(due, _)| *due)
            .map(|(_, path)| path.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::docs::registry::tests::Recorder;
    use serde_json::json;
    use std::fs;
    use std::sync::Arc;

    pub(crate) struct TestDisk;

    impl Disk for TestDisk {
        fn read(&self, path: &Path) -> Result<Vec<u8>, FileError> {
            io::read_bytes(path)
        }
        fn write(
            &self,
            path: &Path,
            text: &str,
            line_ending: LineEnding,
            bom: bool,
        ) -> Result<String, FileError> {
            io::write_atomic(path, text, line_ending, bom)
        }
    }

    fn scratch(name: &str, contents: &[u8]) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("sodilaud-filedocs-{name}-{nanos}"));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("file.md");
        fs::write(&path, contents).unwrap();
        path
    }

    fn registry() -> (Registry, Arc<Recorder>) {
        let registry = Registry::default();
        let recorder = Arc::new(Recorder::default());
        registry.set_sink(recorder.clone());
        (registry, recorder)
    }

    fn update(changes: serde_json::Value) -> Update {
        Update {
            client_id: "page".into(),
            changes,
        }
    }

    #[test]
    fn opening_normalizes_line_endings_and_never_writes() {
        let path = scratch("open", b"a\r\nb\r\nc\n");
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        let (registry, _) = registry();
        let opened = registry.file_open(&path, &TestDisk).unwrap();
        assert_eq!(opened.text, "a\nb\nc\n");
        assert_eq!(opened.line_ending, LineEnding::Crlf, "the majority ending");
        assert_eq!((opened.version, opened.saved_version), (0, 0));
        assert_eq!(opened.external, None);
        assert_eq!(opened.name, "file.md");
        assert_eq!(fs::read(&path).unwrap(), b"a\r\nb\r\nc\n");
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), modified);
    }

    #[test]
    fn a_push_is_applied_broadcast_and_scheduled_for_saving() {
        let path = scratch("push", b"hello");
        let (registry, recorder) = registry();
        registry.file_open(&path, &TestDisk).unwrap();
        let pushed = registry
            .file_push(&path, 0, vec![update(json!([5, [0, "!"]]))])
            .unwrap();
        assert_eq!(
            pushed,
            Pushed {
                accepted: true,
                version: 1
            }
        );
        let events = recorder.file_docs.lock().unwrap().clone();
        assert_eq!(events.len(), 1);
        assert_eq!((events[0].from, events[0].version), (0, 1));
        assert_eq!(events[0].path, path.to_string_lossy());
        assert_eq!(
            registry.file_due(Instant::now()),
            None,
            "not before the delay"
        );
        assert_eq!(
            registry.file_due(Instant::now() + SAVE_DELAY + Duration::from_millis(5)),
            Some(path.clone())
        );
        let stale = registry
            .file_push(&path, 0, vec![update(json!([[6, "x"]]))])
            .unwrap();
        assert!(!stale.accepted);
        assert_eq!(
            registry.file_pull(&path, 0).unwrap(),
            Pulled::Updates(vec![update(json!([5, [0, "!"]]))])
        );
        assert!(registry
            .file_push(&path, 1, vec![update(json!([9]))])
            .is_err());
    }

    #[test]
    fn opening_twice_returns_the_live_document_and_close_drops_it() {
        let path = scratch("twice", b"one");
        let (registry, _) = registry();
        registry.file_open(&path, &TestDisk).unwrap();
        registry
            .file_push(&path, 0, vec![update(json!([3, [0, " two"]]))])
            .unwrap();
        let again = registry.file_open(&path, &TestDisk).unwrap();
        assert_eq!((again.text.as_str(), again.version), ("one two", 1));
        registry.file_close(&path, &TestDisk).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"one two", "close flushes");
        let error = registry.file_push(&path, 1, vec![]).unwrap_err();
        assert_eq!(error.code, FileErrorCode::NotOpen);
    }

    #[test]
    fn discarding_drops_a_document_without_writing() {
        let path = scratch("discard", b"keep");
        let (registry, _) = registry();
        registry.file_open(&path, &TestDisk).unwrap();
        registry
            .file_push(&path, 0, vec![update(json!([[4, "lost"]]))])
            .unwrap();
        registry.file_discard(&path);
        assert_eq!(fs::read(&path).unwrap(), b"keep");
        assert!(registry.file_pull(&path, 0).is_err());
    }
}
