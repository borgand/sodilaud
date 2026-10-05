// SPDX-License-Identifier: GPL-3.0-or-later

//! Files open in the main window. Each is a `Collab` document like a note, so
//! the editor is a collab client and Rust owns the text. Rust autosaves it in
//! the file's own line ending and byte-order mark, and merges an edit made
//! outside Sodilaud into it.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::collab::{Collab, Pulled, Pushed, Update};
use super::registry::Registry;
use crate::files::io::{self, LineEnding};
use crate::files::{FileError, FileErrorCode};

pub(crate) const SAVE_DELAY: Duration = Duration::from_millis(400);
/// The client ID of changes that came from the file on disk.
pub(crate) const DISK_CLIENT: &str = "disk";

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

/// The owner's answer to a conflict: take the file on disk, or save theirs over it.
#[derive(Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Resolve {
    Disk,
    Mine,
}

/// A line-based 3-way merge, or `None` when both sides changed the same lines.
pub(crate) fn merge(base: &str, mine: &str, theirs: &str) -> Option<String> {
    diffy::merge(base, mine, theirs).ok()
}

struct SaveState {
    saved_version: u64,
    due: Option<Instant>,
    error: Option<String>,
}

pub(crate) struct FileDoc {
    /// Tells this opening of the file from an earlier one at the same path,
    /// whose version numbers start over.
    id: String,
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
            doc_id: self.id.clone(),
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
            doc_id: self.id.clone(),
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
    pub(crate) doc_id: String,
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
    pub(crate) doc_id: String,
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
    pub(crate) doc_id: String,
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
    pub(crate) doc_id: String,
    pub(crate) path: String,
    pub(crate) kind: ExternalKind,
}

/// The document open at `path`, if it is still the opening the client knows.
fn current<'a>(
    docs: &'a mut HashMap<PathBuf, FileDoc>,
    path: &Path,
    doc_id: &str,
) -> Result<&'a mut FileDoc, FileError> {
    docs.get_mut(path)
        .filter(|doc| doc.id == doc_id)
        .ok_or_else(|| FileError::not_open(path))
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The earliest autosave that may run, skipping files that changed on disk.
fn earliest_due(docs: &HashMap<PathBuf, FileDoc>) -> Option<(Instant, PathBuf)> {
    docs.iter()
        .filter(|(_, doc)| doc.external.is_none())
        .filter_map(|(path, doc)| doc.save.due.map(|due| (due, path)))
        .min_by_key(|(due, _)| *due)
        .map(|(due, path)| (due, path.clone()))
}

impl Registry {
    fn file_docs(&self) -> MutexGuard<'_, HashMap<PathBuf, FileDoc>> {
        lock(&self.files.docs)
    }

    fn emit_file_doc(&self, path: &Path, doc: &FileDoc, from: u64, updates: Vec<Update>) {
        if let Some(sink) = self.sink() {
            sink.file_doc(&FileDocUpdates {
                doc_id: doc.id.clone(),
                version: doc.collab.version(),
                path: path.to_string_lossy().into_owned(),
                from,
                updates,
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
            id: uuid::Uuid::new_v4().to_string(),
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
        doc_id: &str,
        version: u64,
        updates: Vec<Update>,
    ) -> Result<Pushed, FileError> {
        let mut docs = self.file_docs();
        let doc = current(&mut docs, path, doc_id)?;
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
        self.emit_file_doc(path, doc, from, updates);
        self.files.wake.notify_all();
        Ok(Pushed {
            accepted: true,
            version,
        })
    }

    pub(crate) fn file_pull(
        &self,
        path: &Path,
        doc_id: &str,
        since: u64,
    ) -> Result<Pulled, FileError> {
        let mut docs = self.file_docs();
        let doc = current(&mut docs, path, doc_id)?;
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
                doc_id: String::new(),
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

    fn emit_external(&self, path: &Path, doc: &FileDoc, kind: ExternalKind) {
        if let Some(sink) = self.sink() {
            sink.file_external(&FileExternal {
                doc_id: doc.id.clone(),
                path: path.to_string_lossy().into_owned(),
                kind,
            });
        }
    }

    /// Makes `text`, which `bytes` on disk hold, the document's text: disk
    /// and document agree again.
    fn take_disk(&self, path: &Path, doc: &mut FileDoc, bytes: &[u8], text: String) {
        if let Some((from, updates)) = doc.collab.replace(DISK_CLIENT, &text) {
            self.emit_file_doc(path, doc, from, updates);
        }
        doc.synced = text;
        doc.disk_hash = io::hash(bytes);
        doc.external = None;
        doc.save = SaveState {
            saved_version: doc.collab.version(),
            due: None,
            error: None,
        };
        self.emit_saved(&doc.saved(path));
        self.emit_external(path, doc, ExternalKind::Applied);
    }

    /// The watcher saw `path` change on disk. Sodilaud's own writes are
    /// recognized by their hash. A file without unsaved changes takes the new
    /// text; otherwise the change is merged with them, or, when both changed
    /// the same lines, the owner's text is kept and they are asked.
    pub(crate) fn file_changed_on_disk(&self, path: &Path, removed: bool, disk: &dyn Disk) {
        let _writing = lock(&self.files.writing);
        if removed {
            if let Some(doc) = self.file_docs().get_mut(path) {
                doc.external = Some(External::Removed);
                self.emit_external(path, doc, ExternalKind::Removed);
            }
            return;
        }
        let Ok(bytes) = disk.read(path) else {
            return;
        };
        let mut docs = self.file_docs();
        let Some(doc) = docs.get_mut(path) else {
            return;
        };
        if io::hash(&bytes) == doc.disk_hash {
            if doc.external == Some(External::Removed) {
                doc.external = None;
                if doc.collab.version() > doc.save.saved_version {
                    doc.save.due = Some(Instant::now() + SAVE_DELAY);
                    self.files.wake.notify_all();
                }
                self.emit_external(path, doc, ExternalKind::Applied);
            }
            return;
        }
        let Ok((theirs, line_ending, bom)) = io::decode_normalized(&bytes) else {
            doc.external = Some(External::Conflict);
            self.emit_external(path, doc, ExternalKind::Conflict);
            return;
        };
        doc.line_ending = line_ending;
        doc.bom = bom;
        let mine = doc.collab.text().to_string();
        let merged = if mine == doc.synced {
            Some(theirs.clone())
        } else {
            merge(&doc.synced, &mine, &theirs)
        };
        match merged {
            Some(merged) if merged == theirs => self.take_disk(path, doc, &bytes, theirs),
            Some(merged) => {
                if let Some((from, updates)) = doc.collab.replace(DISK_CLIENT, &merged) {
                    self.emit_file_doc(path, doc, from, updates);
                }
                doc.synced = theirs;
                doc.disk_hash = io::hash(&bytes);
                doc.external = None;
                doc.save.due = Some(Instant::now() + SAVE_DELAY);
                self.files.wake.notify_all();
                self.emit_external(path, doc, ExternalKind::Merged);
            }
            None => {
                doc.synced = theirs;
                doc.disk_hash = io::hash(&bytes);
                doc.external = Some(External::Conflict);
                self.emit_external(path, doc, ExternalKind::Conflict);
            }
        }
    }

    /// Ends a conflict: Reload takes the file on disk, Keep mine saves the
    /// document over it.
    pub(crate) fn file_resolve(
        &self,
        path: &Path,
        keep: Resolve,
        disk: &dyn Disk,
    ) -> Result<(), FileError> {
        match keep {
            Resolve::Disk => {
                let _writing = lock(&self.files.writing);
                let bytes = disk.read(path)?;
                let (text, line_ending, bom) = io::decode_normalized(&bytes)?;
                let mut docs = self.file_docs();
                let doc = docs
                    .get_mut(path)
                    .ok_or_else(|| FileError::not_open(path))?;
                doc.line_ending = line_ending;
                doc.bom = bom;
                self.take_disk(path, doc, &bytes, text);
                Ok(())
            }
            Resolve::Mine => {
                {
                    let mut docs = self.file_docs();
                    let doc = docs
                        .get_mut(path)
                        .ok_or_else(|| FileError::not_open(path))?;
                    doc.external = None;
                    self.emit_external(path, doc, ExternalKind::Applied);
                }
                self.file_save(path, disk).map(|_| ())
            }
        }
    }

    /// Writes every pending save, as a quit does. Returns the failures.
    pub(crate) fn file_flush_all(&self, disk: &dyn Disk) -> Vec<FileError> {
        let paths: Vec<PathBuf> = self.file_docs().keys().cloned().collect();
        paths
            .iter()
            .filter_map(|path| self.file_save(path, disk).err())
            .filter(|error| error.code != FileErrorCode::NotOpen)
            .collect()
    }

    /// Blocks until an autosave is due and returns its document.
    pub(crate) fn file_next_due(&self) -> PathBuf {
        let mut docs = self.file_docs();
        loop {
            let now = Instant::now();
            docs = match earliest_due(&docs) {
                Some((due, path)) if due <= now => return path,
                Some((due, _)) => {
                    self.files
                        .wake
                        .wait_timeout(docs, due - now)
                        .unwrap_or_else(PoisonError::into_inner)
                        .0
                }
                None => self
                    .files
                    .wake
                    .wait(docs)
                    .unwrap_or_else(PoisonError::into_inner),
            };
        }
    }

    #[cfg(test)]
    fn file_due(&self, now: Instant) -> Option<PathBuf> {
        earliest_due(&self.file_docs())
            .filter(|(due, _)| *due <= now)
            .map(|(_, path)| path)
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

    fn id(registry: &Registry, path: &Path) -> String {
        registry.file_open(path, &TestDisk).unwrap().doc_id
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
            .file_push(
                &path,
                &id(&registry, &path),
                0,
                vec![update(json!([5, [0, "!"]]))],
            )
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
            .file_push(
                &path,
                &id(&registry, &path),
                0,
                vec![update(json!([[6, "x"]]))],
            )
            .unwrap();
        assert!(!stale.accepted);
        assert_eq!(
            registry.file_pull(&path, &id(&registry, &path), 0).unwrap(),
            Pulled::Updates(vec![update(json!([5, [0, "!"]]))])
        );
        assert!(registry
            .file_push(&path, &id(&registry, &path), 1, vec![update(json!([9]))])
            .is_err());
    }

    #[test]
    fn opening_twice_returns_the_live_document_and_close_drops_it() {
        let path = scratch("twice", b"one");
        let (registry, _) = registry();
        registry.file_open(&path, &TestDisk).unwrap();
        registry
            .file_push(
                &path,
                &id(&registry, &path),
                0,
                vec![update(json!([3, [0, " two"]]))],
            )
            .unwrap();
        let again = registry.file_open(&path, &TestDisk).unwrap();
        assert_eq!((again.text.as_str(), again.version), ("one two", 1));
        registry.file_close(&path, &TestDisk).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"one two", "close flushes");
        let error = registry
            .file_push(&path, &again.doc_id, 1, vec![])
            .unwrap_err();
        assert_eq!(error.code, FileErrorCode::NotOpen);
    }

    struct FailingDisk;

    impl Disk for FailingDisk {
        fn read(&self, path: &Path) -> Result<Vec<u8>, FileError> {
            io::read_bytes(path)
        }
        fn write(&self, _: &Path, _: &str, _: LineEnding, _: bool) -> Result<String, FileError> {
            Err(FileError::other("disk full".into()))
        }
    }

    /// Types into the document while the write is under way.
    struct TypingDisk<'a>(&'a Registry);

    impl Disk for TypingDisk<'_> {
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
            let version = self.0.file_open(path, &TestDisk).unwrap().version;
            let length = crate::docs::changes::utf16_len(text);
            self.0
                .file_push(
                    path,
                    &self.0.file_open(path, &TestDisk).unwrap().doc_id,
                    version,
                    vec![update(json!([length, [0, "+"]]))],
                )
                .unwrap();
            io::write_atomic(path, text, line_ending, bom)
        }
    }

    #[test]
    fn a_save_writes_the_file_in_its_own_line_ending_and_bom() {
        let path = scratch("save", b"\xEF\xBB\xBFone\r\ntwo\r\n");
        let (registry, recorder) = registry();
        registry.file_open(&path, &TestDisk).unwrap();
        registry
            .file_push(
                &path,
                &id(&registry, &path),
                0,
                vec![update(json!([8, [0, "3😀"]]))],
            )
            .unwrap();
        let saved = registry.file_save(&path, &TestDisk).unwrap();
        assert_eq!(saved.version, 1);
        assert_eq!(saved.error, None);
        assert_eq!(
            fs::read(&path).unwrap(),
            "\u{FEFF}one\r\ntwo\r\n3😀".as_bytes()
        );
        assert_eq!(recorder.saved.lock().unwrap().clone(), vec![saved]);
        assert_eq!(registry.file_due(Instant::now() + SAVE_DELAY * 2), None);
        let again = registry.file_save(&path, &TestDisk).unwrap();
        assert_eq!(again.version, 1, "a clean document is not written again");
        assert_eq!(recorder.saved.lock().unwrap().len(), 1);
    }

    #[test]
    fn typing_during_a_write_keeps_the_document_dirty() {
        let path = scratch("typing", b"a");
        let (registry, _) = registry();
        registry.file_open(&path, &TestDisk).unwrap();
        registry
            .file_push(
                &path,
                &id(&registry, &path),
                0,
                vec![update(json!([1, [0, "b"]]))],
            )
            .unwrap();
        let saved = registry.file_save(&path, &TypingDisk(&registry)).unwrap();
        assert_eq!(saved.version, 1);
        assert_eq!(fs::read(&path).unwrap(), b"ab");
        assert!(registry.file_due(Instant::now() + SAVE_DELAY * 2).is_some());
        assert_eq!(registry.file_save(&path, &TestDisk).unwrap().version, 2);
        assert_eq!(fs::read(&path).unwrap(), b"ab+");
    }

    #[test]
    fn a_failed_write_is_reported_and_the_document_stays_dirty() {
        let path = scratch("fail", b"x");
        let (registry, recorder) = registry();
        registry.file_open(&path, &TestDisk).unwrap();
        registry
            .file_push(
                &path,
                &id(&registry, &path),
                0,
                vec![update(json!([1, [0, "y"]]))],
            )
            .unwrap();
        let error = registry.file_save(&path, &FailingDisk).unwrap_err();
        assert_eq!(error.message, "disk full");
        let event = recorder.saved.lock().unwrap()[0].clone();
        assert_eq!(
            (event.version, event.error.as_deref()),
            (0, Some("disk full"))
        );
        assert_eq!(
            registry.file_open(&path, &TestDisk).unwrap().saved_version,
            0
        );
        assert!(
            registry.file_close(&path, &FailingDisk).is_err(),
            "close keeps unsaved text"
        );
        assert_eq!(registry.file_flush_all(&FailingDisk).len(), 1);
        assert!(registry.file_flush_all(&TestDisk).is_empty());
        assert_eq!(fs::read(&path).unwrap(), b"xy");
    }

    #[test]
    fn the_saver_wakes_when_a_save_comes_due() {
        let path = scratch("wake", b"");
        let registry = Arc::new(registry().0);
        registry.file_open(&path, &TestDisk).unwrap();
        let waiting = {
            let registry = registry.clone();
            std::thread::spawn(move || registry.file_next_due())
        };
        std::thread::sleep(Duration::from_millis(20));
        let pushed_at = Instant::now();
        registry
            .file_push(
                &path,
                &id(&registry, &path),
                0,
                vec![update(json!([[0, "z"]]))],
            )
            .unwrap();
        assert_eq!(waiting.join().unwrap(), path);
        assert!(pushed_at.elapsed() >= SAVE_DELAY);
    }

    fn text(registry: &Registry, path: &Path) -> String {
        registry.file_open(path, &TestDisk).unwrap().text
    }

    fn kinds(recorder: &Recorder) -> Vec<ExternalKind> {
        recorder
            .external
            .lock()
            .unwrap()
            .iter()
            .map(|event| event.kind)
            .collect()
    }

    #[test]
    fn an_outside_edit_to_a_clean_file_is_applied_as_a_minimal_update() {
        let path = scratch("clean", b"one\ntwo\n");
        let (registry, recorder) = registry();
        registry.file_open(&path, &TestDisk).unwrap();
        fs::write(&path, b"one\ntwo\nthree\n").unwrap();
        registry.file_changed_on_disk(&path, false, &TestDisk);
        assert_eq!(text(&registry, &path), "one\ntwo\nthree\n");
        let events = recorder.file_docs.lock().unwrap().clone();
        assert_eq!(events[0].updates[0].client_id, DISK_CLIENT);
        assert_eq!(events[0].updates[0].changes, json!([8, [0, "three", ""]]));
        assert_eq!(recorder.saved.lock().unwrap()[0].version, 1, "disk matches");
        assert_eq!(kinds(&recorder), vec![ExternalKind::Applied]);
        assert_eq!(registry.file_due(Instant::now() + SAVE_DELAY * 2), None);
    }

    #[test]
    fn our_own_save_is_not_an_outside_edit() {
        let path = scratch("own", b"a");
        let (registry, recorder) = registry();
        registry.file_open(&path, &TestDisk).unwrap();
        registry
            .file_push(
                &path,
                &id(&registry, &path),
                0,
                vec![update(json!([1, [0, "b"]]))],
            )
            .unwrap();
        registry.file_save(&path, &TestDisk).unwrap();
        registry.file_changed_on_disk(&path, false, &TestDisk);
        assert_eq!(recorder.file_docs.lock().unwrap().len(), 1);
        assert!(recorder.external.lock().unwrap().is_empty());
    }

    #[test]
    fn an_outside_edit_away_from_unsaved_typing_is_merged_and_saved() {
        let path = scratch("merge", b"one\ntwo\nthree\n");
        let (registry, recorder) = registry();
        registry.file_open(&path, &TestDisk).unwrap();
        registry
            .file_push(
                &path,
                &id(&registry, &path),
                0,
                vec![update(json!([[3, "ONE"], 11]))],
            )
            .unwrap();
        fs::write(&path, b"one\ntwo\nTHREE\n").unwrap();
        registry.file_changed_on_disk(&path, false, &TestDisk);
        assert_eq!(text(&registry, &path), "ONE\ntwo\nTHREE\n");
        assert_eq!(kinds(&recorder), vec![ExternalKind::Merged]);
        assert_eq!(
            recorder.file_docs.lock().unwrap()[1].updates[0].changes,
            json!([8, [5, "THREE"], 1])
        );
        let path_due = registry.file_due(Instant::now() + SAVE_DELAY * 2);
        assert_eq!(path_due.as_deref(), Some(path.as_path()));
        registry.file_save(&path, &TestDisk).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"ONE\ntwo\nTHREE\n");
    }

    #[test]
    fn a_crlf_file_with_astral_text_merges_and_saves_byte_for_byte() {
        let path = scratch("crlf", "a😀\r\nb\r\nc\r\n".as_bytes());
        let (registry, _) = registry();
        registry.file_open(&path, &TestDisk).unwrap();
        registry
            .file_push(
                &path,
                &id(&registry, &path),
                0,
                vec![update(json!([3, [0, "𝄞"], 5]))],
            )
            .unwrap();
        fs::write(&path, "a😀\r\nb\r\nc ž\r\n".as_bytes()).unwrap();
        registry.file_changed_on_disk(&path, false, &TestDisk);
        registry.file_save(&path, &TestDisk).unwrap();
        assert_eq!(fs::read(&path).unwrap(), "a😀𝄞\r\nb\r\nc ž\r\n".as_bytes());
    }

    #[test]
    fn overlapping_edits_keep_mine_until_the_owner_chooses() {
        let path = scratch("conflict", b"one\ntwo\n");
        let (registry, recorder) = registry();
        registry.file_open(&path, &TestDisk).unwrap();
        registry
            .file_push(
                &path,
                &id(&registry, &path),
                0,
                vec![update(json!([4, [3, "mine"], 1]))],
            )
            .unwrap();
        fs::write(&path, b"one\ntheirs\n").unwrap();
        registry.file_changed_on_disk(&path, false, &TestDisk);
        assert_eq!(text(&registry, &path), "one\nmine\n");
        assert_eq!(kinds(&recorder), vec![ExternalKind::Conflict]);
        let opened = registry.file_open(&path, &TestDisk).unwrap();
        assert_eq!(opened.external, Some(External::Conflict));
        assert_eq!(registry.file_due(Instant::now() + SAVE_DELAY * 2), None);
        registry.file_save(&path, &TestDisk).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"one\ntheirs\n", "not autosaved");

        registry
            .file_resolve(&path, Resolve::Mine, &TestDisk)
            .unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"one\nmine\n");
        assert_eq!(registry.file_open(&path, &TestDisk).unwrap().external, None);

        fs::write(&path, b"one\nlater\n").unwrap();
        registry
            .file_push(
                &path,
                &id(&registry, &path),
                1,
                vec![update(json!([4, [4, "again"], 1]))],
            )
            .unwrap();
        registry.file_changed_on_disk(&path, false, &TestDisk);
        registry
            .file_resolve(&path, Resolve::Disk, &TestDisk)
            .unwrap();
        let opened = registry.file_open(&path, &TestDisk).unwrap();
        assert_eq!(opened.text, "one\nlater\n");
        assert_eq!(opened.saved_version, opened.version);
        assert_eq!(opened.external, None);
    }

    #[test]
    fn a_removed_file_is_not_saved_until_it_comes_back() {
        let path = scratch("removed", b"here");
        let (registry, recorder) = registry();
        registry.file_open(&path, &TestDisk).unwrap();
        fs::remove_file(&path).unwrap();
        registry.file_changed_on_disk(&path, true, &TestDisk);
        registry
            .file_push(
                &path,
                &id(&registry, &path),
                0,
                vec![update(json!([4, [0, "!"]]))],
            )
            .unwrap();
        registry.file_save(&path, &TestDisk).unwrap();
        assert!(!path.exists());
        assert_eq!(kinds(&recorder), vec![ExternalKind::Removed]);
        fs::write(&path, b"here").unwrap();
        registry.file_changed_on_disk(&path, false, &TestDisk);
        assert_eq!(text(&registry, &path), "here!");
        assert_eq!(registry.file_open(&path, &TestDisk).unwrap().external, None);
    }

    #[test]
    fn a_reopened_file_refuses_the_old_document_and_tells_events_apart() {
        let path = scratch("reopen", b"a");
        let (registry, recorder) = registry();
        let old = registry.file_open(&path, &TestDisk).unwrap().doc_id;
        registry
            .file_push(&path, &old, 0, vec![update(json!([1, [0, "b"]]))])
            .unwrap();
        registry.file_discard(&path);
        let new = registry.file_open(&path, &TestDisk).unwrap().doc_id;
        assert_ne!(old, new);
        let error = registry
            .file_push(&path, &old, 0, vec![update(json!([1, [0, "c"]]))])
            .unwrap_err();
        assert_eq!(error.code, FileErrorCode::NotOpen);
        assert_eq!(
            registry.file_pull(&path, &old, 0).unwrap_err().code,
            FileErrorCode::NotOpen
        );
        assert_eq!(recorder.file_docs.lock().unwrap()[0].doc_id, old);
    }

    #[test]
    fn discarding_drops_a_document_without_writing() {
        let path = scratch("discard", b"keep");
        let (registry, _) = registry();
        registry.file_open(&path, &TestDisk).unwrap();
        registry
            .file_push(
                &path,
                &id(&registry, &path),
                0,
                vec![update(json!([[4, "lost"]]))],
            )
            .unwrap();
        let doc_id = id(&registry, &path);
        registry.file_discard(&path);
        assert_eq!(fs::read(&path).unwrap(), b"keep");
        assert!(registry.file_pull(&path, &doc_id, 0).is_err());
    }
}
