// SPDX-License-Identifier: GPL-3.0-or-later

//! The notes collection, owned by Rust. Every window and the MCP server are
//! clients: the page sends versioned text changes (the `@codemirror/collab`
//! protocol) and structural edits, and the registry broadcasts the result.
//!
//! Every change is written to SQLite before it is committed in memory, so a
//! failed write leaves both unchanged and the caller can simply retry.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, RwLock};

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use super::changes;
use super::collab::Collab;
#[cfg(test)]
use super::collab::HISTORY;
pub(crate) use super::collab::{Pulled, Pushed, Update};
use super::files::{FileDocUpdates, FileDocs, FileExternal, FileSaved};
use crate::store::workspace::{self as store, Folder, Note, TrashEntry};

pub(crate) const UNTITLED: &str = "Untitled Scratchpad";
const TITLE_UNITS: usize = 30;
const LOCAL_COLLECTION_NAME: &str = "Local notes";

/// A note and its text. `note.content` mirrors `collab.text()`; only
/// `Workspace::apply_updates` changes either.
#[derive(Clone, Debug)]
pub(crate) struct Entry {
    pub(crate) note: Note,
    pub(crate) rev: u64,
    pub(crate) collab: Collab,
}

#[derive(Clone, Debug)]
pub(crate) struct FolderEntry {
    pub(crate) folder: Folder,
    pub(crate) rev: u64,
}

pub(crate) struct Workspace {
    pub(crate) id: String,
    pub(crate) path: PathBuf,
    pub(crate) is_default: bool,
    conn: rusqlite::Connection,
    pub(crate) notes: Vec<Entry>,
    pub(crate) folders: Vec<FolderEntry>,
    pub(crate) trash: Vec<TrashEntry>,
    next_rev: u64,
    pub(crate) receipts: HashMap<String, Receipt>,
}

pub(crate) struct Receipt {
    pub(crate) fingerprint: String,
    pub(crate) result: Value,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NoteState {
    #[serde(flatten)]
    pub(crate) note: Note,
    pub(crate) version: u64,
    pub(crate) rev: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub(crate) struct FolderState {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) rev: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct State {
    pub(crate) collection_id: String,
    pub(crate) name: String,
    pub(crate) path: String,
    pub(crate) is_default: bool,
    pub(crate) notes: Vec<NoteState>,
    pub(crate) folders: Vec<FolderState>,
    pub(crate) trash: Vec<TrashEntry>,
    /// Grows with every state the registry hands out, across workspaces, so a
    /// client can tell a late event from a newer one.
    pub(crate) seq: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DocUpdates {
    pub(crate) collection_id: String,
    pub(crate) note_id: String,
    /// The version the first update applies to.
    pub(crate) from: u64,
    pub(crate) updates: Vec<Update>,
    pub(crate) version: u64,
    pub(crate) title: String,
    pub(crate) updated_at: i64,
    pub(crate) rev: u64,
}

/// Where registry changes go: every webview in the app, or a test recorder.
pub(crate) trait Sink: Send + Sync {
    fn changed(&self, state: &State);
    fn doc(&self, updates: &DocUpdates);
    fn file_doc(&self, _updates: &FileDocUpdates) {}
    fn file_saved(&self, _saved: &FileSaved) {}
    fn file_external(&self, _external: &FileExternal) {}
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StructureNote {
    pub(crate) id: String,
    pub(crate) title: Option<String>,
    pub(crate) is_title_locked: Option<bool>,
    pub(crate) is_pinned: Option<bool>,
    #[serde(default, deserialize_with = "present")]
    pub(crate) folder_id: Option<Option<String>>,
    /// Read only for a note the registry does not have yet.
    pub(crate) content: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct StructureFolder {
    pub(crate) id: String,
    pub(crate) name: Option<String>,
}

/// The sidebar as the page last arranged it. Notes and folders carry only the
/// fields the page changed. Anything the registry has that is not listed was
/// created concurrently, by an agent, and is kept.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Structure {
    pub(crate) collection_id: String,
    pub(crate) notes: Vec<StructureNote>,
    pub(crate) folders: Vec<StructureFolder>,
    #[serde(default)]
    pub(crate) deleted_folder_ids: Vec<String>,
}

/// Tells an absent field (`None`) from an explicit `null` (`Some(None)`).
fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalCollection {
    #[serde(default)]
    pub(crate) notes: Vec<Note>,
    #[serde(default)]
    pub(crate) folders: Vec<Folder>,
    #[serde(default)]
    pub(crate) trash: Vec<TrashEntry>,
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or_default()
}

/// The title the editor shows until the user names a note: its first line
/// without heading marks, at most 30 UTF-16 units, as `notes.js` has always done.
pub(crate) fn auto_title(content: &str) -> String {
    let first = content.trim().split('\n').next().unwrap_or("");
    let hashes = first.len() - first.trim_start_matches('#').len();
    let after = &first[hashes..];
    let first = if hashes > 0 && after.starts_with(char::is_whitespace) {
        after.trim_start()
    } else {
        first
    };
    let mut units = 0;
    let title: String = first
        .trim()
        .chars()
        .take_while(|character| {
            units += character.len_utf16();
            units <= TITLE_UNITS
        })
        .collect();
    if title.is_empty() {
        UNTITLED.to_string()
    } else {
        title
    }
}

fn blank_note() -> Note {
    Note {
        id: format!("note_{}", uuid::Uuid::new_v4()),
        title: UNTITLED.into(),
        content: String::new(),
        updated_at: now_ms(),
        is_title_locked: false,
        is_pinned: false,
        folder_id: None,
    }
}

pub(crate) fn new_entry(note: Note, rev: u64) -> Entry {
    Entry {
        collab: Collab::new(note.content.clone()),
        note,
        rev,
    }
}

/// Pinned notes first, each group in its existing order.
fn pinned_first(notes: &mut Vec<Entry>) {
    let (pinned, rest): (Vec<_>, Vec<_>) = notes.drain(..).partition(|e| e.note.is_pinned);
    notes.extend(pinned);
    notes.extend(rest);
}

pub(crate) fn insert_below_pinned(notes: &mut Vec<Entry>, entry: Entry) {
    let index = notes
        .iter()
        .position(|existing| !existing.note.is_pinned)
        .unwrap_or(notes.len());
    notes.insert(index, entry);
}

fn clear_missing_folders(notes: &mut [Entry], folders: &[FolderEntry]) {
    let ids: HashSet<&str> = folders.iter().map(|f| f.folder.id.as_str()).collect();
    for entry in notes {
        if entry
            .note
            .folder_id
            .as_deref()
            .is_some_and(|id| !ids.contains(id))
        {
            entry.note.folder_id = None;
        }
    }
}

pub(crate) fn trash_summary(entry: &TrashEntry) -> Value {
    serde_json::json!({
        "id": entry.id,
        "noteId": entry.note.id,
        "title": entry.note.title,
        "deletedAt": entry.deleted_at,
        "folderId": entry.note.folder_id,
        "folderName": entry.folder_name,
    })
}

/// A copy of the parts of a workspace a change edits, written to disk before it
/// replaces the live copy.
pub(crate) struct Draft {
    pub(crate) notes: Vec<Entry>,
    pub(crate) folders: Vec<FolderEntry>,
    pub(crate) trash: Vec<TrashEntry>,
    pub(crate) next_rev: u64,
}

impl Draft {
    pub(crate) fn rev(&mut self) -> u64 {
        self.next_rev += 1;
        self.next_rev
    }
}

impl Workspace {
    fn open(path: &Path, is_default: bool) -> Result<Self, String> {
        let conn = store::open(path)?;
        let loaded = store::load(&conn)?;
        let mut next_rev = 0;
        let mut rev = || {
            next_rev += 1;
            next_rev
        };
        let folders: Vec<FolderEntry> = loaded
            .folders
            .into_iter()
            .map(|folder| FolderEntry { folder, rev: rev() })
            .collect();
        let mut notes: Vec<Entry> = loaded
            .notes
            .into_iter()
            .map(|mut note| {
                note.content = changes::normalize_newlines(&note.content).into_owned();
                new_entry(note, rev())
            })
            .collect();
        clear_missing_folders(&mut notes, &folders);
        pinned_first(&mut notes);
        Ok(Self {
            id: uuid::Uuid::new_v4().to_string(),
            path: path.to_path_buf(),
            is_default,
            conn,
            notes,
            folders,
            trash: loaded.trash,
            next_rev,
            receipts: HashMap::new(),
        })
    }

    pub(crate) fn name(&self) -> String {
        if self.is_default {
            return LOCAL_COLLECTION_NAME.into();
        }
        self.path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Sodilaud workspace".into())
    }

    pub(crate) fn state(&self) -> State {
        State {
            collection_id: self.id.clone(),
            name: self.name(),
            path: self.path.to_string_lossy().into_owned(),
            is_default: self.is_default,
            notes: self
                .notes
                .iter()
                .map(|e| NoteState {
                    note: e.note.clone(),
                    version: e.collab.version(),
                    rev: e.rev,
                })
                .collect(),
            folders: self
                .folders
                .iter()
                .map(|f| FolderState {
                    id: f.folder.id.clone(),
                    name: f.folder.name.clone(),
                    rev: f.rev,
                })
                .collect(),
            trash: self.trash.clone(),
            seq: 0,
        }
    }

    pub(crate) fn local_imported(&self) -> Result<bool, String> {
        Ok(store::meta(&self.conn, store::LOCAL_IMPORTED_KEY)?.is_some())
    }

    pub(crate) fn check(&self, collection_id: &str) -> Result<(), String> {
        if self.id == collection_id {
            Ok(())
        } else {
            Err("Collection changed; reload the current collection before writing".into())
        }
    }

    pub(crate) fn draft(&self) -> Draft {
        Draft {
            notes: self.notes.clone(),
            folders: self.folders.clone(),
            trash: self.trash.clone(),
            next_rev: self.next_rev,
        }
    }

    /// Writes the whole draft, then makes it the live collection.
    pub(crate) fn commit(&mut self, mut draft: Draft) -> Result<(), String> {
        clear_missing_folders(&mut draft.notes, &draft.folders);
        pinned_first(&mut draft.notes);
        let notes: Vec<&Note> = draft.notes.iter().map(|e| &e.note).collect();
        let folders: Vec<Folder> = draft.folders.iter().map(|f| f.folder.clone()).collect();
        store::save_all(&mut self.conn, &notes, &folders, &draft.trash)
            .map_err(|error| format!("Could not save the workspace: {error}"))?;
        self.notes = draft.notes;
        self.folders = draft.folders;
        self.trash = draft.trash;
        self.next_rev = draft.next_rev;
        Ok(())
    }

    fn position(&self, note_id: &str) -> Result<usize, String> {
        self.notes
            .iter()
            .position(|e| e.note.id == note_id)
            .ok_or_else(|| format!("No note exists with id `{note_id}`"))
    }

    /// Applies text updates at the note's current version, writes the note and
    /// returns what the other clients need to catch up.
    pub(crate) fn apply_updates(
        &mut self,
        note_id: &str,
        updates: Vec<Update>,
    ) -> Result<DocUpdates, String> {
        let index = self.position(note_id)?;
        let current = &self.notes[index];
        let text = current.collab.apply(&updates)?;
        let mut note = current.note.clone();
        note.content = text.clone();
        note.updated_at = now_ms().max(current.note.updated_at + 1);
        if !note.is_title_locked {
            note.title = auto_title(&note.content);
        }
        store::save_note(&self.conn, &note, index)
            .map_err(|error| format!("Could not save the note: {error}"))?;

        self.next_rev += 1;
        let rev = self.next_rev;
        let entry = &mut self.notes[index];
        entry.note = note;
        entry.rev = rev;
        let from = entry.collab.commit(text, updates.clone());
        Ok(DocUpdates {
            collection_id: self.id.clone(),
            note_id: note_id.to_string(),
            from,
            updates,
            version: entry.collab.version(),
            title: entry.note.title.clone(),
            updated_at: entry.note.updated_at,
            rev,
        })
    }
}

pub(crate) struct Registry {
    workspace: Mutex<Option<Workspace>>,
    /// Files open in the main window, independent of the open workspace.
    pub(crate) files: FileDocs,
    sink: RwLock<Option<Arc<dyn Sink>>>,
    seq: AtomicU64,
}

impl Default for Registry {
    fn default() -> Self {
        Self {
            workspace: Mutex::new(None),
            files: FileDocs::default(),
            sink: RwLock::new(None),
            seq: AtomicU64::new(0),
        }
    }
}

impl Registry {
    pub(crate) fn set_sink(&self, sink: Arc<dyn Sink>) {
        *self.sink.write().unwrap_or_else(PoisonError::into_inner) = Some(sink);
    }

    pub(super) fn sink(&self) -> Option<Arc<dyn Sink>> {
        self.sink
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn lock(&self) -> MutexGuard<'_, Option<Workspace>> {
        self.workspace
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Runs `action` on the open workspace. Events are sent while the lock is
    /// held, so every client sees them in the order they happened.
    pub(crate) fn with<T>(
        &self,
        action: impl FnOnce(&mut Workspace) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut guard = self.lock();
        let workspace = guard.as_mut().ok_or("No workspace is open")?;
        action(workspace)
    }

    fn stamped(&self, workspace: &Workspace) -> State {
        let mut state = workspace.state();
        state.seq = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        state
    }

    pub(crate) fn changed(&self, workspace: &Workspace) {
        if let Some(sink) = self.sink() {
            sink.changed(&self.stamped(workspace));
        }
    }

    /// Runs a structural change and broadcasts the new collection.
    pub(crate) fn mutate<T>(
        &self,
        collection_id: &str,
        action: impl FnOnce(&mut Workspace) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut guard = self.lock();
        let workspace = guard.as_mut().ok_or("No workspace is open")?;
        workspace.check(collection_id)?;
        let result = action(workspace)?;
        self.changed(workspace);
        Ok(result)
    }

    pub(crate) fn open(&self, path: &Path, is_default: bool) -> Result<State, String> {
        let workspace = Workspace::open(path, is_default)?;
        let mut guard = self.lock();
        let state = self.stamped(&workspace);
        *guard = Some(workspace);
        if let Some(sink) = self.sink() {
            sink.changed(&state);
        }
        Ok(state)
    }

    /// Opens a workspace the user chose. A new, empty file starts as a copy of
    /// the collection that is open now, as connecting always has.
    pub(crate) fn connect(&self, path: &Path) -> Result<State, String> {
        {
            let guard = self.lock();
            let mut conn = store::open(path)?;
            let loaded = store::load(&conn)?;
            let empty =
                loaded.notes.is_empty() && loaded.folders.is_empty() && loaded.trash.is_empty();
            if let (true, Some(current)) = (empty, guard.as_ref()) {
                let notes: Vec<&Note> = current.notes.iter().map(|e| &e.note).collect();
                let folders: Vec<Folder> =
                    current.folders.iter().map(|f| f.folder.clone()).collect();
                store::save_all(&mut conn, &notes, &folders, &[])?;
            }
        }
        self.open(path, false)
    }

    pub(crate) fn state(&self) -> Result<State, String> {
        self.with(|workspace| Ok(self.stamped(workspace)))
    }

    pub(crate) fn is_open_at(&self, path: &Path) -> bool {
        self.lock()
            .as_ref()
            .is_some_and(|workspace| workspace.path == path)
    }

    /// Copies the localStorage collection into the default workspace once.
    /// Notes created there in the meantime (by an agent before the page
    /// loaded) are kept after the imported ones.
    pub(crate) fn import_local(
        &self,
        default_path: &Path,
        local: LocalCollection,
    ) -> Result<bool, String> {
        let mut guard = self.lock();
        let active = guard
            .as_mut()
            .filter(|workspace| workspace.path == default_path);
        let mut separate;
        let conn = match active {
            Some(workspace) => &mut workspace.conn,
            None => {
                separate = store::open(default_path)?;
                &mut separate
            }
        };
        if store::meta(conn, store::LOCAL_IMPORTED_KEY)?.is_some() {
            return Ok(false);
        }
        let existing = store::load(conn)?;
        let imported_ids: HashSet<String> = local.notes.iter().map(|n| n.id.clone()).collect();
        let mut folders = local.folders;
        for folder in existing.folders {
            if !folders.iter().any(|f| f.id == folder.id) {
                folders.push(folder);
            }
        }
        let folder_ids: HashSet<String> = folders.iter().map(|f| f.id.clone()).collect();
        let mut notes: Vec<Note> = local
            .notes
            .into_iter()
            .chain(
                existing
                    .notes
                    .into_iter()
                    .filter(|note| !imported_ids.contains(&note.id)),
            )
            .collect();
        for note in &mut notes {
            note.content = changes::normalize_newlines(&note.content).into_owned();
            if note
                .folder_id
                .as_ref()
                .is_some_and(|id| !folder_ids.contains(id))
            {
                note.folder_id = None;
            }
        }
        let mut trash = local.trash;
        for entry in existing.trash {
            if !trash.iter().any(|t| t.id == entry.id) {
                trash.push(entry);
            }
        }
        let refs: Vec<&Note> = notes.iter().collect();
        store::save_all_with_meta(
            conn,
            &refs,
            &folders,
            &trash,
            store::LOCAL_IMPORTED_KEY,
            "1",
        )?;
        let reopen = guard
            .as_ref()
            .is_some_and(|workspace| workspace.path == default_path);
        drop(guard);
        if reopen {
            self.open(default_path, true)?;
        }
        Ok(true)
    }

    pub(crate) fn push(
        &self,
        collection_id: &str,
        note_id: &str,
        version: u64,
        updates: Vec<Update>,
    ) -> Result<Pushed, String> {
        let mut guard = self.lock();
        let workspace = guard.as_mut().ok_or("No workspace is open")?;
        workspace.check(collection_id)?;
        let current = workspace.notes[workspace.position(note_id)?]
            .collab
            .version();
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
        let event = workspace.apply_updates(note_id, updates)?;
        let version = event.version;
        if let Some(sink) = self.sink() {
            sink.doc(&event);
        }
        Ok(Pushed {
            accepted: true,
            version,
        })
    }

    /// Emits a text change the registry made itself (an agent's append).
    pub(crate) fn emit_doc(&self, event: &DocUpdates) {
        if let Some(sink) = self.sink() {
            sink.doc(event);
        }
    }

    pub(crate) fn pull(
        &self,
        collection_id: &str,
        note_id: &str,
        since: u64,
    ) -> Result<Pulled, String> {
        self.with(|workspace| {
            workspace.check(collection_id)?;
            workspace.notes[workspace.position(note_id)?]
                .collab
                .pull(since)
        })
    }

    /// Returns the collection after the change, which the page applies once
    /// its own writes have settled.
    pub(crate) fn sync_structure(&self, structure: Structure) -> Result<State, String> {
        self.mutate(&structure.collection_id.clone(), |workspace| {
            let mut draft = workspace.draft();
            apply_structure(&mut draft, structure);
            workspace.commit(draft)?;
            Ok(self.stamped(workspace))
        })
    }

    pub(crate) fn trash_note(&self, collection_id: &str, note_id: &str) -> Result<Value, String> {
        self.mutate(collection_id, |workspace| {
            let mut draft = workspace.draft();
            let entry = trash_note_in(&mut draft, note_id)?;
            let summary = trash_summary(&entry);
            workspace.commit(draft)?;
            Ok(summary)
        })
    }

    pub(crate) fn restore_trash(
        &self,
        collection_id: &str,
        trash_id: &str,
    ) -> Result<String, String> {
        self.mutate(collection_id, |workspace| {
            let mut draft = workspace.draft();
            let index = draft
                .trash
                .iter()
                .position(|entry| entry.id == trash_id)
                .ok_or("This note is no longer in the trash")?;
            let entry = draft.trash.remove(index);
            if draft.notes.iter().any(|e| e.note.id == entry.note.id) {
                return Err(
                    "A note with this ID already exists; restore cannot overwrite it".into(),
                );
            }
            let mut note = entry.note;
            note.content = changes::normalize_newlines(&note.content).into_owned();
            note.updated_at = now_ms().max(note.updated_at + 1);
            let id = note.id.clone();
            let rev = draft.rev();
            insert_below_pinned(&mut draft.notes, new_entry(note, rev));
            workspace.commit(draft)?;
            Ok(id)
        })
    }

    pub(crate) fn empty_trash(&self, collection_id: &str, ids: Vec<String>) -> Result<(), String> {
        self.mutate(collection_id, |workspace| {
            let selected: HashSet<String> = ids.into_iter().collect();
            let mut draft = workspace.draft();
            draft.trash.retain(|entry| !selected.contains(&entry.id));
            workspace.commit(draft)
        })
    }

    pub(crate) fn vacuum(&self) -> Result<(), String> {
        let path = self.with(|workspace| Ok(workspace.path.clone()))?;
        store::vacuum(&path)
    }
}

/// Moves a note to the trash. The collection is never left without a note, so
/// removing the last one adds an empty scratchpad.
pub(crate) fn trash_note_in(draft: &mut Draft, note_id: &str) -> Result<TrashEntry, String> {
    let index = draft
        .notes
        .iter()
        .position(|e| e.note.id == note_id)
        .ok_or_else(|| format!("No note exists with id `{note_id}`"))?;
    let removed = draft.notes.remove(index);
    let entry = TrashEntry {
        id: uuid::Uuid::new_v4().to_string(),
        folder_name: removed.note.folder_id.as_deref().and_then(|id| {
            draft
                .folders
                .iter()
                .find(|f| f.folder.id == id)
                .map(|f| f.folder.name.clone())
        }),
        note: removed.note,
        deleted_at: now_ms(),
    };
    draft.trash.push(entry.clone());
    if draft.notes.is_empty() {
        let rev = draft.rev();
        draft.notes.push(new_entry(blank_note(), rev));
    }
    Ok(entry)
}

fn apply_structure(draft: &mut Draft, structure: Structure) {
    let deleted: HashSet<&str> = structure
        .deleted_folder_ids
        .iter()
        .map(String::as_str)
        .collect();
    let mut folders = Vec::with_capacity(structure.folders.len());
    let mut listed = HashSet::new();
    for proposed in &structure.folders {
        let id = proposed.id.trim();
        if id.is_empty() || deleted.contains(id) || !listed.insert(id.to_string()) {
            continue;
        }
        let name = proposed
            .name
            .as_deref()
            .map(|name| name.split_whitespace().collect::<Vec<_>>().join(" "))
            .filter(|name| !name.is_empty());
        match draft.folders.iter().find(|f| f.folder.id == id) {
            Some(existing) => {
                let mut existing = existing.clone();
                if let Some(name) = name.filter(|name| *name != existing.folder.name) {
                    existing.folder.name = name;
                    existing.rev = draft.rev();
                }
                folders.push(existing);
            }
            None => {
                if let Some(name) = name {
                    let rev = draft.rev();
                    folders.push(FolderEntry {
                        folder: Folder {
                            id: id.to_string(),
                            name,
                        },
                        rev,
                    });
                }
            }
        }
    }
    keep_unlisted(
        &draft.folders,
        &mut folders,
        |f| &f.folder.id,
        |id| !listed.contains(id) && !deleted.contains(id),
    );
    draft.folders = folders;

    let trashed: HashSet<String> = draft.trash.iter().map(|t| t.note.id.clone()).collect();
    let mut notes = Vec::with_capacity(structure.notes.len());
    let mut listed = HashSet::new();
    for proposed in structure.notes {
        if proposed.id.trim().is_empty() || !listed.insert(proposed.id.clone()) {
            continue;
        }
        let existing = draft
            .notes
            .iter()
            .find(|e| e.note.id == proposed.id)
            .cloned();
        let (mut entry, is_new) = match existing {
            Some(entry) => (entry, false),
            // A note the page still lists after an agent trashed it stays trashed.
            None if trashed.contains(&proposed.id) => continue,
            None => {
                let content =
                    changes::normalize_newlines(proposed.content.as_deref().unwrap_or(""))
                        .into_owned();
                let note = Note {
                    id: proposed.id.clone(),
                    title: auto_title(&content),
                    content,
                    updated_at: now_ms(),
                    is_title_locked: false,
                    is_pinned: false,
                    folder_id: None,
                };
                (new_entry(note, 0), true)
            }
        };
        let before = entry.note.clone();
        let note = &mut entry.note;
        if let Some(locked) = proposed.is_title_locked {
            note.is_title_locked = locked;
        }
        if let Some(title) = proposed.title {
            let title = title.trim();
            note.title = if title.is_empty() {
                UNTITLED.into()
            } else {
                title.to_string()
            };
        }
        if !note.is_title_locked && proposed.content.is_none() && !is_new {
            note.title = auto_title(&note.content);
        }
        if let Some(pinned) = proposed.is_pinned {
            note.is_pinned = pinned;
        }
        if let Some(folder_id) = proposed.folder_id {
            note.folder_id = folder_id;
        }
        if is_new || *note != before {
            if !is_new {
                note.updated_at = now_ms().max(before.updated_at + 1);
            }
            entry.rev = draft.rev();
        }
        notes.push(entry);
    }
    keep_unlisted(
        &draft.notes,
        &mut notes,
        |e| &e.note.id,
        |id| !listed.contains(id),
    );
    draft.notes = notes;
}

/// Puts items the page did not list back near where they were.
fn keep_unlisted<T: Clone>(
    previous: &[T],
    next: &mut Vec<T>,
    id: impl Fn(&T) -> &String,
    unlisted: impl Fn(&str) -> bool,
) {
    for (index, item) in previous.iter().enumerate() {
        if unlisted(id(item)) {
            next.insert(index.min(next.len()), item.clone());
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::store::workspace::tests::{note, temporary_db_path};
    use serde_json::json;

    #[derive(Default)]
    pub(crate) struct Recorder {
        pub(crate) changed: Mutex<Vec<State>>,
        pub(crate) docs: Mutex<Vec<DocUpdates>>,
        pub(crate) file_docs: Mutex<Vec<FileDocUpdates>>,
        pub(crate) saved: Mutex<Vec<FileSaved>>,
        pub(crate) external: Mutex<Vec<FileExternal>>,
    }

    impl Sink for Recorder {
        fn changed(&self, state: &State) {
            self.changed.lock().unwrap().push(state.clone());
        }
        fn doc(&self, updates: &DocUpdates) {
            self.docs.lock().unwrap().push(updates.clone());
        }
        fn file_doc(&self, updates: &FileDocUpdates) {
            self.file_docs.lock().unwrap().push(updates.clone());
        }
        fn file_saved(&self, saved: &FileSaved) {
            self.saved.lock().unwrap().push(saved.clone());
        }
        fn file_external(&self, external: &FileExternal) {
            self.external.lock().unwrap().push(external.clone());
        }
    }

    pub(crate) fn registry_with(notes: &[Note]) -> (Registry, Arc<Recorder>, PathBuf, String) {
        let path = temporary_db_path("registry");
        let mut conn = store::open(&path).unwrap();
        let refs: Vec<&Note> = notes.iter().collect();
        store::save_all(&mut conn, &refs, &[], &[]).unwrap();
        drop(conn);
        let registry = Registry::default();
        let recorder = Arc::new(Recorder::default());
        registry.set_sink(recorder.clone());
        let id = registry.open(&path, false).unwrap().collection_id;
        (registry, recorder, path, id)
    }

    fn update(client: &str, changes: Value) -> Update {
        Update {
            client_id: client.into(),
            changes,
        }
    }

    fn reloaded(path: &Path) -> Vec<Note> {
        store::load(&store::open(path).unwrap()).unwrap().notes
    }

    fn content(registry: &Registry, id: &str) -> String {
        registry
            .state()
            .unwrap()
            .notes
            .into_iter()
            .find(|n| n.note.id == id)
            .unwrap()
            .note
            .content
    }

    #[test]
    fn titles_follow_the_first_line_until_locked() {
        assert_eq!(auto_title("# Plan\nbody"), "Plan");
        assert_eq!(auto_title("  \n\nfirst"), "first");
        assert_eq!(auto_title("#hashtag"), "#hashtag");
        assert_eq!(auto_title(""), UNTITLED);
        assert_eq!(auto_title(&"x".repeat(40)).len(), 30);
        // 😀 takes two of the 30 units and is never split.
        assert_eq!(auto_title(&"😀".repeat(20)).chars().count(), 15);
    }

    #[test]
    fn a_push_at_the_current_version_is_applied_saved_and_broadcast() {
        let (registry, recorder, path, id) = registry_with(&[note("a", "hello", 1)]);
        let pushed = registry
            .push(&id, "a", 0, vec![update("c1", json!([5, [0, " world"]]))])
            .unwrap();
        assert_eq!(
            pushed,
            Pushed {
                accepted: true,
                version: 1
            }
        );
        assert_eq!(content(&registry, "a"), "hello world");
        assert_eq!(reloaded(&path)[0].content, "hello world");
        assert_eq!(reloaded(&path)[0].title, "hello world");
        let docs = recorder.docs.lock().unwrap();
        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0].from, 0);
        assert_eq!(docs[0].version, 1);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn a_stale_push_is_rejected_and_the_client_catches_up_by_pulling() {
        let (registry, _, path, id) = registry_with(&[note("a", "ab", 1)]);
        registry
            .push(&id, "a", 0, vec![update("c1", json!([2, [0, "c"]]))])
            .unwrap();
        let stale = registry
            .push(&id, "a", 0, vec![update("c2", json!([[0, "z"], 2]))])
            .unwrap();
        assert_eq!(
            stale,
            Pushed {
                accepted: false,
                version: 1
            }
        );
        assert_eq!(content(&registry, "a"), "abc");
        assert_eq!(
            registry.pull(&id, "a", 0).unwrap(),
            Pulled::Updates(vec![update("c1", json!([2, [0, "c"]]))])
        );
        assert_eq!(registry.pull(&id, "a", 1).unwrap(), Pulled::Updates(vec![]));
        assert!(registry.pull(&id, "a", 2).is_err());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn an_invalid_update_changes_nothing() {
        let (registry, recorder, path, id) = registry_with(&[note("a", "ab", 1)]);
        let result = registry.push(
            &id,
            "a",
            0,
            vec![update("c1", json!([2, [0, "c"]])), update("c1", json!([2]))],
        );
        assert!(result.is_err());
        assert_eq!(content(&registry, "a"), "ab");
        assert_eq!(registry.pull(&id, "a", 0).unwrap(), Pulled::Updates(vec![]));
        assert!(recorder.docs.lock().unwrap().is_empty());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn a_client_older_than_the_history_reloads() {
        let (registry, _, path, id) = registry_with(&[note("a", "", 1)]);
        for version in 0..(HISTORY as u64 + 2) {
            let text = content(&registry, "a");
            registry
                .push(
                    &id,
                    "a",
                    version,
                    vec![update("c", changes::append(&text, "x"))],
                )
                .unwrap();
        }
        match registry.pull(&id, "a", 0).unwrap() {
            Pulled::Reload { text, version } => {
                assert_eq!(text.len(), HISTORY + 2);
                assert_eq!(version, HISTORY as u64 + 2);
            }
            other => panic!("expected a reload, got {other:?}"),
        }
        assert!(
            matches!(registry.pull(&id, "a", 2).unwrap(), Pulled::Updates(u) if u.len() == HISTORY)
        );
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn a_locked_title_survives_edits() {
        let mut locked = note("a", "text", 1);
        locked.is_title_locked = true;
        locked.title = "Mine".into();
        let (registry, _, path, id) = registry_with(&[locked]);
        registry
            .push(&id, "a", 0, vec![update("c", json!([[4, "# Other"]]))])
            .unwrap();
        assert_eq!(registry.state().unwrap().notes[0].note.title, "Mine");
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn a_collection_switch_rejects_writes_for_the_old_one() {
        let (registry, _, path, _) = registry_with(&[note("a", "x", 1)]);
        assert!(registry.push("stale", "a", 0, vec![]).is_err());
        assert!(registry.trash_note("stale", "a").is_err());
        std::fs::remove_file(path).unwrap();
    }

    fn structure(id: &str, notes: Value, folders: Value, deleted: Value) -> Structure {
        serde_json::from_value(json!({
            "collectionId": id, "notes": notes, "folders": folders, "deletedFolderIds": deleted
        }))
        .unwrap()
    }

    fn ids(registry: &Registry) -> Vec<String> {
        registry
            .state()
            .unwrap()
            .notes
            .into_iter()
            .map(|n| n.note.id)
            .collect()
    }

    #[test]
    fn structure_sync_reorders_patches_and_creates() {
        let (registry, recorder, path, id) =
            registry_with(&[note("a", "one", 1), note("b", "two", 2)]);
        registry
            .sync_structure(structure(
                &id,
                json!([
                    {"id": "new", "content": "# Fresh\r\nbody"},
                    {"id": "b", "isPinned": true},
                    {"id": "a", "title": " Named ", "isTitleLocked": true, "folderId": "work"}
                ]),
                json!([{"id": "work", "name": "  Work  stuff "}]),
                json!([]),
            ))
            .unwrap();
        let state = registry.state().unwrap();
        assert_eq!(ids(&registry), ["b", "new", "a"], "pinned notes come first");
        let new = &state.notes[1].note;
        assert_eq!(
            (new.title.as_str(), new.content.as_str()),
            ("Fresh", "# Fresh\nbody")
        );
        let a = &state.notes[2].note;
        assert_eq!(
            (a.title.as_str(), a.folder_id.as_deref()),
            ("Named", Some("work"))
        );
        assert_eq!(state.folders[0].name, "Work stuff");
        assert_eq!(recorder.changed.lock().unwrap().len(), 2);
        let saved = reloaded(&path);
        assert_eq!(
            saved.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(),
            ["b", "new", "a"]
        );
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn structure_sync_keeps_what_an_agent_added_meanwhile() {
        let (registry, _, path, id) =
            registry_with(&[note("a", "", 1), note("agent", "", 2), note("b", "", 3)]);
        registry
            .sync_structure(structure(
                &id,
                json!([{"id": "b"}, {"id": "a"}]),
                json!([]),
                json!([]),
            ))
            .unwrap();
        assert_eq!(ids(&registry), ["b", "agent", "a"]);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn structure_sync_does_not_resurrect_a_trashed_note_or_keep_a_deleted_folder() {
        let (registry, _, path, id) = registry_with(&[note("a", "", 1), note("b", "", 2)]);
        registry
            .sync_structure(structure(
                &id,
                json!([{"id": "a", "folderId": "f"}, {"id": "b"}]),
                json!([{"id": "f", "name": "F"}]),
                json!([]),
            ))
            .unwrap();
        registry.trash_note(&id, "b").unwrap();
        registry
            .sync_structure(structure(
                &id,
                json!([{"id": "a"}, {"id": "b", "content": "stale"}]),
                json!([]),
                json!(["f"]),
            ))
            .unwrap();
        let state = registry.state().unwrap();
        assert_eq!(ids(&registry), ["a"]);
        assert!(state.folders.is_empty());
        assert_eq!(
            state.notes[0].note.folder_id, None,
            "notes leave a deleted folder"
        );
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn trashing_the_last_note_leaves_an_empty_scratchpad_and_restore_brings_it_back() {
        let (registry, _, path, id) = registry_with(&[note("a", "keep", 1)]);
        let summary = registry.trash_note(&id, "a").unwrap();
        let state = registry.state().unwrap();
        assert_eq!(state.notes.len(), 1);
        assert_eq!(state.notes[0].note.title, UNTITLED);
        assert_eq!(state.trash[0].note.content, "keep");
        let trash_id = summary["id"].as_str().unwrap();
        assert_eq!(registry.restore_trash(&id, trash_id).unwrap(), "a");
        assert!(registry.restore_trash(&id, trash_id).is_err());
        let state = registry.state().unwrap();
        assert_eq!(state.notes.len(), 2);
        assert!(state.trash.is_empty());
        registry.trash_note(&id, "a").unwrap();
        let trash_ids = registry
            .state()
            .unwrap()
            .trash
            .into_iter()
            .map(|t| t.id)
            .collect();
        registry.empty_trash(&id, trash_ids).unwrap();
        assert!(registry.state().unwrap().trash.is_empty());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn a_failed_write_leaves_memory_unchanged() {
        let (registry, recorder, path, id) = registry_with(&[note("a", "x", 1)]);
        registry
            .with(|workspace| {
                workspace
                    .conn
                    .execute_batch("DROP TABLE notes; CREATE TABLE notes (id TEXT)")
                    .map_err(|e| e.to_string())
            })
            .unwrap();
        assert!(registry
            .push(&id, "a", 0, vec![update("c", json!([1, [0, "y"]]))])
            .is_err());
        assert!(registry.trash_note(&id, "a").is_err());
        let state = registry.state().unwrap();
        assert_eq!(state.notes[0].note.content, "x");
        assert_eq!(state.notes[0].version, 0);
        assert!(state.trash.is_empty());
        assert!(recorder.docs.lock().unwrap().is_empty());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn local_import_runs_once_and_keeps_notes_created_before_it() {
        let path = temporary_db_path("default");
        let registry = Registry::default();
        let state = registry.open(&path, true).unwrap();
        assert_eq!(state.name, "Local notes");
        let agent = registry.with(|workspace| {
            let mut draft = workspace.draft();
            let rev = draft.rev();
            insert_below_pinned(&mut draft.notes, new_entry(note("agent", "early", 1), rev));
            workspace.commit(draft)
        });
        agent.unwrap();
        let local = LocalCollection {
            notes: vec![note("l1", "from\r\nlocal", 1)],
            folders: vec![Folder {
                id: "f".into(),
                name: "F".into(),
            }],
            trash: vec![],
        };
        assert!(registry.import_local(&path, local).unwrap());
        assert_eq!(ids(&registry), ["l1", "agent"]);
        assert_eq!(content(&registry, "l1"), "from\nlocal");
        assert!(!registry
            .import_local(&path, LocalCollection::default())
            .unwrap());
        assert_eq!(ids(&registry), ["l1", "agent"]);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn importing_while_another_workspace_is_open_writes_the_default_file() {
        let (registry, _, other, _) = registry_with(&[note("w", "", 1)]);
        let default = temporary_db_path("default-closed");
        let local = LocalCollection {
            notes: vec![note("l1", "x", 1)],
            ..Default::default()
        };
        assert!(registry.import_local(&default, local).unwrap());
        assert_eq!(ids(&registry), ["w"]);
        assert_eq!(reloaded(&default)[0].id, "l1");
        std::fs::remove_file(other).unwrap();
        std::fs::remove_file(default).unwrap();
    }

    #[test]
    fn connecting_an_empty_file_copies_the_open_collection() {
        let (registry, _, path, _) = registry_with(&[note("a", "carry", 1)]);
        let fresh = temporary_db_path("fresh");
        let state = registry.connect(&fresh).unwrap();
        assert!(!state.is_default);
        assert_eq!(state.notes[0].note.content, "carry");
        let (other_registry, _, other, _) = registry_with(&[note("z", "", 1)]);
        drop(other_registry);
        assert_eq!(registry.connect(&other).unwrap().notes[0].note.id, "z");
        for file in [path, fresh, other] {
            std::fs::remove_file(file).unwrap();
        }
    }
}
