// SPDX-License-Identifier: GPL-3.0-or-later

//! Agents co-editing documents with the owner: which documents an agent is
//! working on, its reads, merged edits and comments, and the owner's comments
//! waiting for it. A document is a note in the open collection or a file open
//! in the main window; both keep their text, comments and merge bases in a
//! `Collab`, so everything here works the same for either.

use std::collections::{BTreeSet, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, RwLock};

use serde::Serialize;
use serde_json::{json, Value};

use super::agent::AGENT_CLIENT;
use super::changes;
use super::collab::{Collab, Update};
use super::comments::{self, Author, Comment, State};
use super::merge::{self, Edit};
use super::registry::{now_ms, Registry};
use crate::files::io;

pub(crate) const FILE_NAME: &str = "coedit.json";
pub(crate) const MAX_EDITS: usize = 50;
pub(crate) const MAX_BODY_CHARS: usize = 2000;
pub(crate) const MAX_NOTE_CHARS: usize = 500;
pub(crate) const DEFAULT_READ_CHARS: usize = 200_000;
const MAX_RECEIPTS: usize = 1000;

/// What both windows show about agents: whether owner comments wait for
/// review, and whether an agent is waiting for comments right now.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CoeditState {
    pub(crate) hold_for_review: bool,
    pub(crate) listening: bool,
}

/// A document as an agent names it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum DocRef {
    Note(String),
    File(PathBuf),
}

impl DocRef {
    /// Exactly one of an absolute `path` or a `noteId`.
    pub(crate) fn parse(path: Option<&str>, note_id: Option<&str>) -> Result<Self, String> {
        match (path, note_id) {
            (Some(path), None) => {
                let requested = Path::new(path);
                if !requested.is_absolute() {
                    return Err(format!(
                        "{path} is not a full path. Give the full path to the file."
                    ));
                }
                let resolved = requested.canonicalize().map_err(|_| {
                    format!(
                        "{} is not open in Sodilaud. Open it with open_document first.",
                        io::file_name(requested)
                    )
                })?;
                Ok(Self::File(resolved))
            }
            (None, Some(id)) if !id.trim().is_empty() => Ok(Self::Note(id.to_string())),
            _ => Err("Give either path (a file open in Sodilaud) or noteId, not both".into()),
        }
    }

    pub(crate) fn json(&self) -> Value {
        match self {
            Self::Note(id) => json!({ "noteId": id }),
            Self::File(path) => json!({ "path": path.to_string_lossy() }),
        }
    }
}

/// A document as a window names it: the collection or the opening it knows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum PageDoc {
    Note {
        collection_id: String,
        note_id: String,
    },
    File {
        path: PathBuf,
        doc_id: String,
    },
}

struct Receipt {
    fingerprint: String,
    result: Value,
}

#[derive(Default)]
pub(crate) struct Coedit {
    /// Files an agent opened, read or commented on, until the owner closes them.
    files: Mutex<BTreeSet<PathBuf>>,
    /// `coedit.json`, which the pre-tool-use hook reads.
    mirror: RwLock<Option<PathBuf>>,
    receipts: Mutex<(HashMap<String, Receipt>, VecDeque<String>)>,
    /// Woken whenever an owner comment is queued for agents.
    queued: Arc<tokio::sync::Notify>,
    listening: AtomicUsize,
    hold: AtomicBool,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Writes the co-edited files for the hook, owner-only: a temporary file
/// renamed over the old one, so the hook never reads half a list.
pub(crate) fn write_mirror(target: &Path, files: &BTreeSet<PathBuf>) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let list: Vec<String> = files
        .iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    let bytes = serde_json::to_vec_pretty(&json!({ "files": list })).map_err(|e| e.to_string())?;
    let temporary = target.with_extension(format!("json.{}.tmp", uuid::Uuid::new_v4().simple()));
    std::fs::write(&temporary, bytes).map_err(|e| e.to_string())?;
    crate::restrict_to_owner(&temporary)?;
    std::fs::rename(&temporary, target).map_err(|e| {
        let _ = std::fs::remove_file(&temporary);
        e.to_string()
    })
}

/// A comment as an agent sees it. Offsets count characters.
fn agent_view(comment: &Comment, text: &str) -> Value {
    json!({
        "id": comment.id,
        "author": comment.author,
        "state": comment.shown_state(),
        "anchoredText": comment.anchored_text,
        "headingPath": comment.heading_path,
        "offset": changes::utf16_to_char(text, comment.from),
        "body": comment.body,
        "note": comment.note,
        "replyTo": comment.reply_to,
        "createdAt": comment.created_at,
    })
}

fn pending_view(doc: &DocRef, comment: &Comment, all: &[Comment], text: &str) -> Value {
    let (before, after) = comments::context(text, comment.from, comment.to);
    let reply_to = comment.reply_to.as_ref().and_then(|id| {
        all.iter()
            .find(|parent| &parent.id == id)
            .map(|parent| json!({ "id": parent.id, "body": parent.body }))
    });
    let mut view = json!({
        "id": comment.id,
        "doc": doc.json(),
        "headingPath": comment.heading_path,
        "anchoredText": comment.anchored_text,
        "contextBefore": before,
        "contextAfter": after,
        "body": comment.body,
        "createdAt": comment.created_at,
    });
    if let Some(reply_to) = reply_to {
        view["replyTo"] = reply_to;
    }
    view
}

/// Resolves a comment and, for an answer to an agent's question, the question.
fn resolve_in(all: &mut [Comment], id: &str, note: Option<String>) -> Option<Comment> {
    let now = now_ms();
    let index = all.iter().position(|c| c.id == id)?;
    let parent = all[index].reply_to.clone();
    if !all[index].is_resolved() {
        all[index].state = State::Resolved;
        all[index].note = note;
        all[index].updated_at = now;
    }
    if let Some(parent) = parent.and_then(|id| all.iter_mut().find(|c| c.id == id)) {
        if !parent.is_resolved() {
            parent.state = State::Resolved;
            parent.updated_at = now;
        }
    }
    Some(all[index].clone())
}

fn find_occurrence(
    text: &str,
    needle: &str,
    occurrence: Option<usize>,
) -> Result<(usize, usize), String> {
    if needle.is_empty() {
        return Err("anchorText must not be empty".into());
    }
    let mut starts = Vec::new();
    let mut from = 0;
    while let Some(index) = text[from..].find(needle) {
        starts.push(from + index);
        from += index
            + text[from + index..]
                .chars()
                .next()
                .map_or(1, char::len_utf8);
    }
    let start = match (occurrence, starts.len()) {
        (_, 0) => {
            return Err("anchorText is not in the document; reread it with read_document".into())
        }
        (None, 1) => starts[0],
        (None, count) => {
            return Err(format!(
                "anchorText occurs {count} times; pass occurrence (1-{count}) to choose one"
            ))
        }
        (Some(n), count) if n >= 1 && n <= count => starts[n - 1],
        (Some(_), count) => return Err(format!("occurrence must be between 1 and {count}")),
    };
    Ok((
        changes::utf16_of_byte(text, start),
        changes::utf16_of_byte(text, start + needle.len()),
    ))
}

impl Registry {
    fn coedit(&self) -> &Coedit {
        &self.coedit
    }

    fn emit_coedit_state(&self) {
        if let Some(sink) = self.sink() {
            sink.coedit_state(&self.coedit_state());
        }
    }

    pub(crate) fn coedit_state(&self) -> CoeditState {
        CoeditState {
            hold_for_review: self.coedit().hold.load(Ordering::SeqCst),
            listening: self.coedit().listening.load(Ordering::SeqCst) > 0,
        }
    }

    pub(crate) fn set_hold_for_review(&self, hold: bool) {
        self.coedit().hold.store(hold, Ordering::SeqCst);
        self.emit_coedit_state();
    }

    /// Where `coedit.json` lives. It starts empty: nothing is co-edited yet.
    pub(crate) fn set_coedit_mirror(&self, target: PathBuf) {
        *self
            .coedit()
            .mirror
            .write()
            .unwrap_or_else(PoisonError::into_inner) = Some(target);
        self.write_coedit_mirror(&lock(&self.coedit().files));
    }

    fn write_coedit_mirror(&self, files: &BTreeSet<PathBuf>) {
        let target = self
            .coedit()
            .mirror
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        if let Some(target) = target {
            if let Err(error) = write_mirror(&target, files) {
                eprintln!("Could not record the co-edited files: {error}");
            }
        }
    }

    /// Empties `coedit.json` as the app quits, so native edits are allowed again.
    pub(crate) fn coedit_clear_mirror(&self) {
        let mut files = lock(&self.coedit().files);
        files.clear();
        self.write_coedit_mirror(&files);
    }

    pub(crate) fn coedit_mark_file(&self, path: &Path) {
        let mut files = lock(&self.coedit().files);
        if files.insert(path.to_path_buf()) {
            self.write_coedit_mirror(&files);
        }
    }

    pub(crate) fn coedit_forget_file(&self, path: &Path) {
        let mut files = lock(&self.coedit().files);
        if files.remove(path) {
            self.write_coedit_mirror(&files);
        }
    }

    fn is_coedited_file(&self, path: &Path) -> bool {
        lock(&self.coedit().files).contains(path)
    }

    pub(crate) fn coedit_queued(&self) -> Arc<tokio::sync::Notify> {
        self.coedit().queued.clone()
    }

    fn wake_listeners(&self) {
        self.coedit().queued.notify_waiters();
    }

    /// Counts an agent waiting for comments until the guard is dropped.
    pub(crate) fn coedit_listen(self: &Arc<Self>) -> ListenGuard {
        self.coedit().listening.fetch_add(1, Ordering::SeqCst);
        self.emit_coedit_state();
        ListenGuard(self.clone())
    }

    /// Runs `action` on a document's text and comments. Comments it changed
    /// are stored and shown; text it changed on a file is broadcast. Note
    /// text must change through `apply_updates` instead.
    fn on_doc<T>(
        &self,
        doc: &DocRef,
        action: impl FnOnce(&mut Collab) -> Result<T, String>,
    ) -> Result<T, String> {
        match doc {
            DocRef::Note(id) => self.with(|workspace| {
                let entry = workspace.entry_mut(id)?;
                let before = entry.collab.comments_rev;
                let result = action(&mut entry.collab)?;
                if entry.collab.comments_rev != before {
                    if let (Some(event), Some(sink)) = (workspace.comments_changed(id), self.sink())
                    {
                        sink.comments(&event);
                    }
                }
                Ok(result)
            }),
            DocRef::File(path) => self.with_file_doc(path, action),
        }
    }

    fn page_doc(&self, doc: &PageDoc) -> Result<DocRef, String> {
        match doc {
            PageDoc::Note {
                collection_id,
                note_id,
            } => {
                self.with(|workspace| workspace.check(collection_id))?;
                Ok(DocRef::Note(note_id.clone()))
            }
            PageDoc::File { path, doc_id } => {
                let open = self
                    .file_doc_ids()
                    .into_iter()
                    .any(|(open, id)| &open == path && &id == doc_id);
                if open {
                    Ok(DocRef::File(path.clone()))
                } else {
                    Err(format!("{} is not open in Sodilaud.", io::file_name(path)))
                }
            }
        }
    }

    fn with_receipt(
        &self,
        request_id: &str,
        fingerprint: String,
        action: impl FnOnce() -> Result<Value, String>,
    ) -> Result<Value, String> {
        let mut receipts = lock(&self.coedit().receipts);
        if let Some(receipt) = receipts.0.get(request_id) {
            if receipt.fingerprint != fingerprint {
                return Err("requestId was already used with different arguments".into());
            }
            return Ok(receipt.result.clone());
        }
        let result = action()?;
        let (map, order) = &mut *receipts;
        map.insert(
            request_id.to_string(),
            Receipt {
                fingerprint,
                result: result.clone(),
            },
        );
        order.push_back(request_id.to_string());
        while order.len() > MAX_RECEIPTS {
            if let Some(oldest) = order.pop_front() {
                map.remove(&oldest);
            }
        }
        Ok(result)
    }

    /// Open files, and notes an agent works on or that have comments.
    pub(crate) fn coedit_list(&self) -> Vec<Value> {
        let pending = |all: &[Comment]| {
            all.iter()
                .filter(|c| c.author == Author::Owner && c.state == State::Queued && !c.orphaned)
                .count()
        };
        let mut found = Vec::new();
        for (path, _) in self.file_doc_ids() {
            let coedited = self.is_coedited_file(&path);
            let _ = self.with_file_doc(&path, |collab| {
                found.push(json!({
                    "path": path.to_string_lossy(),
                    "name": io::file_name(&path),
                    "version": collab.version(),
                    "coEdited": coedited,
                    "pendingComments": pending(&collab.comments),
                }));
                Ok(())
            });
        }
        let _ = self.with(|workspace| {
            for entry in &workspace.notes {
                if entry.collab.co_edited || !entry.collab.comments.is_empty() {
                    found.push(json!({
                        "noteId": entry.note.id,
                        "name": entry.note.title,
                        "version": entry.collab.version(),
                        "coEdited": entry.collab.co_edited,
                        "pendingComments": pending(&entry.collab.comments),
                    }));
                }
            }
            Ok(())
        });
        found
    }

    /// The document's text from `offset` (characters), its headings and the
    /// comments an agent may act on. Remembers the text as a merge base and
    /// marks the document co-edited.
    pub(crate) fn coedit_read(
        &self,
        doc: &DocRef,
        offset: usize,
        limit: usize,
    ) -> Result<Value, String> {
        if let DocRef::File(path) = doc {
            self.coedit_mark_file(path);
        }
        self.on_doc(doc, |collab| {
            collab.co_edited = true;
            let version = collab.snapshot_base();
            let text = collab.text();
            let total = text.chars().count();
            let start = offset.min(total);
            let content: String = text.chars().skip(start).take(limit).collect();
            let end = start + content.chars().count();
            let comments: Vec<Value> = collab
                .comments
                .iter()
                .filter(|c| !c.is_resolved() && c.state != State::Held)
                .map(|c| agent_view(c, text))
                .collect();
            Ok(json!({
                "doc": doc.json(),
                "version": version,
                "content": content,
                "totalLength": total,
                "nextOffset": (end < total).then_some(end),
                "headings": comments::headings(text),
                "comments": comments,
            }))
        })
    }

    /// Merges an agent's edits written against `base_version` into the text
    /// as it is now. Partial success is normal.
    pub(crate) fn coedit_apply(
        &self,
        doc: &DocRef,
        base_version: u64,
        request_id: &str,
        edits: &[Edit],
    ) -> Result<Value, String> {
        if edits.is_empty() || edits.len() > MAX_EDITS {
            return Err(format!("edits must hold 1-{MAX_EDITS} edits"));
        }
        let fingerprint = json!(["apply_edit", doc.json(), base_version, edits]).to_string();
        self.with_receipt(request_id, fingerprint, || {
            let merge_in = |collab: &Collab| -> Result<merge::Outcome, String> {
                let stale = || {
                    format!(
                        "STALE_BASE: version {base_version} is no longer kept; call read_document again and use its version"
                    )
                };
                let base = collab.base(base_version).ok_or_else(stale)?;
                let since = collab.since(base_version).ok_or_else(stale)?;
                Ok(merge::merge(base, collab.text(), &since, edits))
            };
            let agent = |changes| {
                vec![Update {
                    client_id: AGENT_CLIENT.to_string(),
                    changes,
                }]
            };
            let (outcome, version) = match doc {
                DocRef::Note(id) => self.with(|workspace| {
                    let outcome = merge_in(&workspace.entry_mut(id)?.collab)?;
                    if let Some(changes) = outcome.changes.clone() {
                        let event = workspace.apply_updates(id, agent(changes))?;
                        self.emit_doc(&event);
                    }
                    let version = workspace.entry_mut(id)?.collab.version();
                    Ok((outcome, version))
                })?,
                DocRef::File(path) => self.with_file_doc(path, |collab| {
                    let outcome = merge_in(collab)?;
                    if let Some(changes) = outcome.changes.clone() {
                        let updates = agent(changes);
                        let text = collab.apply(&updates)?;
                        collab.commit(text, updates);
                    }
                    Ok((outcome, collab.version()))
                })?,
            };
            Ok(json!({
                "applied": outcome.applied,
                "conflicts": outcome.conflicts,
                "version": version,
            }))
        })
    }

    /// An agent's comment on the `occurrence`-th copy of `anchor_text`.
    pub(crate) fn coedit_add_comment(
        &self,
        doc: &DocRef,
        anchor_text: &str,
        occurrence: Option<usize>,
        body: &str,
        request_id: &str,
    ) -> Result<Value, String> {
        let fingerprint =
            json!(["add_comment", doc.json(), anchor_text, occurrence, body]).to_string();
        self.with_receipt(request_id, fingerprint, || {
            if let DocRef::File(path) = doc {
                self.coedit_mark_file(path);
            }
            self.on_doc(doc, |collab| {
                let range = find_occurrence(collab.text(), anchor_text, occurrence)?;
                let comment = Comment::new(
                    Author::Agent,
                    State::Open,
                    collab.text(),
                    range,
                    body.to_string(),
                    None,
                    now_ms(),
                );
                let view = agent_view(&comment, collab.text());
                collab.co_edited = true;
                collab.comments.push(comment);
                collab.comments_changed();
                Ok(json!({ "comment": view }))
            })
        })
    }

    fn documents(&self) -> Vec<DocRef> {
        let mut docs: Vec<DocRef> = self
            .file_doc_ids()
            .into_iter()
            .map(|(path, _)| DocRef::File(path))
            .collect();
        let _ = self.with(|workspace| {
            docs.extend(
                workspace
                    .notes
                    .iter()
                    .filter(|e| !e.collab.comments.is_empty())
                    .map(|e| DocRef::Note(e.note.id.clone())),
            );
            Ok(())
        });
        docs
    }

    /// Resolves a comment by ID wherever it is, with a note for the owner.
    pub(crate) fn coedit_resolve(&self, id: &str, note: &str) -> Result<Value, String> {
        for doc in self.documents() {
            let resolved = self.on_doc(&doc, |collab| {
                let found = collab.comments.iter().any(|c| c.id == id);
                let resolved = found
                    .then(|| resolve_in(&mut collab.comments, id, Some(note.to_string())))
                    .flatten();
                if resolved.is_some() {
                    collab.comments_changed();
                }
                Ok(resolved.map(|comment| agent_view(&comment, collab.text())))
            });
            if let Ok(Some(view)) = resolved {
                return Ok(json!({ "comment": view }));
            }
        }
        Err(format!(
            "No comment with id `{id}` is in an open document; it may have been deleted"
        ))
    }

    /// Takes the owner's queued comments, oldest first, and marks them sent.
    pub(crate) fn coedit_take_pending(&self, only: Option<&DocRef>) -> Vec<Value> {
        let mut taken: Vec<(i64, Value)> = Vec::new();
        let docs = match only {
            Some(doc) => vec![doc.clone()],
            None => self.documents(),
        };
        for doc in docs {
            let _ = self.on_doc(&doc, |collab| {
                let text = collab.text().to_string();
                let snapshot = collab.comments.clone();
                let mut changed = false;
                for comment in collab.comments.iter_mut().filter(|c| {
                    c.author == Author::Owner && c.state == State::Queued && !c.orphaned
                }) {
                    taken.push((
                        comment.created_at,
                        pending_view(&doc, comment, &snapshot, &text),
                    ));
                    comment.state = State::Sent;
                    comment.updated_at = now_ms();
                    changed = true;
                }
                if changed {
                    collab.comments_changed();
                }
                Ok(())
            });
        }
        taken.sort_by_key(|(created, _)| *created);
        taken.into_iter().map(|(_, view)| view).collect()
    }

    /// Whether `doc` names a document that exists now, for a long poll to
    /// fail fast instead of waiting on nothing.
    pub(crate) fn coedit_check(&self, doc: &DocRef) -> Result<(), String> {
        self.on_doc(doc, |_| Ok(()))
    }

    // The owner's side, from the windows.

    pub(crate) fn comments_get(&self, page: &PageDoc) -> Result<comments::CommentsEvent, String> {
        let doc = self.page_doc(page)?;
        let (version, list) = self.on_doc(&doc, |collab| {
            Ok((collab.version(), collab.comments.clone()))
        })?;
        Ok(comments::CommentsEvent {
            collection_id: match page {
                PageDoc::Note { collection_id, .. } => Some(collection_id.clone()),
                PageDoc::File { .. } => None,
            },
            note_id: match &doc {
                DocRef::Note(id) => Some(id.clone()),
                DocRef::File(_) => None,
            },
            path: match &doc {
                DocRef::File(path) => Some(path.to_string_lossy().into_owned()),
                DocRef::Note(_) => None,
            },
            doc_id: match page {
                PageDoc::File { doc_id, .. } => Some(doc_id.clone()),
                PageDoc::Note { .. } => None,
            },
            version,
            comments: list,
        })
    }

    /// The owner's comment on `from..to` of the text at `version`, or an
    /// answer to an agent's comment, which takes that comment's range.
    pub(crate) fn comment_add(
        &self,
        page: &PageDoc,
        version: u64,
        (from, to): (usize, usize),
        body: &str,
        reply_to: Option<&str>,
    ) -> Result<Comment, String> {
        let body = body.trim();
        if body.is_empty() || body.chars().count() > MAX_BODY_CHARS {
            return Err(format!("A comment needs 1-{MAX_BODY_CHARS} characters"));
        }
        let doc = self.page_doc(page)?;
        let hold = self.coedit().hold.load(Ordering::SeqCst);
        let comment = self.on_doc(&doc, |collab| {
            let range = match reply_to {
                Some(parent) => {
                    let parent = collab
                        .comments
                        .iter()
                        .find(|c| c.id == parent)
                        .ok_or("The comment you are answering is gone")?;
                    if parent.author != Author::Agent || parent.is_resolved() {
                        return Err("Only an open agent comment can be answered".into());
                    }
                    (parent.from, parent.to)
                }
                None => {
                    let since = collab
                        .since(version)
                        .ok_or("The document changed too much; select the text again")?;
                    let (mut start, mut end) = (from, to);
                    for update in &since {
                        let sections = changes::sections(&update.changes)?;
                        start = changes::map_pos_in(&sections, start, 1)?;
                        end = changes::map_pos_in(&sections, end, -1)?;
                    }
                    if end <= start || end > changes::utf16_len(collab.text()) {
                        return Err("The selected text changed; select it again".into());
                    }
                    (start, end)
                }
            };
            let comment = Comment::new(
                Author::Owner,
                if hold { State::Held } else { State::Queued },
                collab.text(),
                range,
                body.to_string(),
                reply_to.map(str::to_string),
                now_ms(),
            );
            collab.comments.push(comment.clone());
            collab.comments_changed();
            Ok(comment)
        })?;
        if comment.state == State::Queued {
            self.wake_listeners();
        }
        Ok(comment)
    }

    fn change_comment(
        &self,
        page: &PageDoc,
        id: &str,
        change: impl FnOnce(&mut Vec<Comment>, usize) -> Result<bool, String>,
    ) -> Result<(), String> {
        let doc = self.page_doc(page)?;
        let wake = self.on_doc(&doc, |collab| {
            let index = collab
                .comments
                .iter()
                .position(|c| c.id == id)
                .ok_or("This comment no longer exists")?;
            let wake = change(&mut collab.comments, index)?;
            collab.comments_changed();
            Ok(wake)
        })?;
        if wake {
            self.wake_listeners();
        }
        Ok(())
    }

    /// Changes the text of an owner comment no agent has taken yet.
    pub(crate) fn comment_edit(&self, page: &PageDoc, id: &str, body: &str) -> Result<(), String> {
        let body = body.trim().to_string();
        if body.is_empty() || body.chars().count() > MAX_BODY_CHARS {
            return Err(format!("A comment needs 1-{MAX_BODY_CHARS} characters"));
        }
        self.change_comment(page, id, |all, index| {
            let comment = &mut all[index];
            if comment.author != Author::Owner
                || !matches!(comment.state, State::Held | State::Queued)
            {
                return Err("An agent already has this comment; it can no longer change".into());
            }
            comment.body = body;
            comment.updated_at = now_ms();
            Ok(false)
        })
    }

    /// Deletes an owner comment no agent has taken yet, or any orphan.
    pub(crate) fn comment_delete(&self, page: &PageDoc, id: &str) -> Result<(), String> {
        self.change_comment(page, id, |all, index| {
            let comment = &all[index];
            let deletable = comment.orphaned
                || comment.is_resolved()
                || (comment.author == Author::Owner
                    && matches!(comment.state, State::Held | State::Queued));
            if !deletable {
                return Err("An agent already has this comment; resolve it instead".into());
            }
            let id = comment.id.clone();
            all.retain(|c| c.id != id && c.reply_to.as_deref() != Some(id.as_str()));
            Ok(false)
        })
    }

    /// The owner resolves a comment: dismisses an agent's, or closes their own.
    pub(crate) fn comment_resolve(&self, page: &PageDoc, id: &str) -> Result<(), String> {
        self.change_comment(page, id, |all, _| {
            resolve_in(all, id, None);
            Ok(false)
        })
    }

    /// Puts a comment an agent took but never resolved back in the queue.
    pub(crate) fn comment_resend(&self, page: &PageDoc, id: &str) -> Result<(), String> {
        self.change_comment(page, id, |all, index| {
            let comment = &mut all[index];
            if comment.author != Author::Owner || comment.state != State::Sent {
                return Err("Only a sent comment can be sent again".into());
            }
            comment.state = State::Queued;
            comment.updated_at = now_ms();
            Ok(true)
        })
    }

    /// Queues every comment held for review in this document.
    pub(crate) fn comments_send_review(&self, page: &PageDoc) -> Result<usize, String> {
        let doc = self.page_doc(page)?;
        let sent = self.on_doc(&doc, |collab| {
            let mut sent = 0;
            for comment in collab
                .comments
                .iter_mut()
                .filter(|c| c.state == State::Held)
            {
                comment.state = State::Queued;
                comment.updated_at = now_ms();
                sent += 1;
            }
            if sent > 0 {
                collab.comments_changed();
            }
            Ok(sent)
        })?;
        if sent > 0 {
            self.wake_listeners();
        }
        Ok(sent)
    }

    pub(crate) fn comments_clear_resolved(&self, page: &PageDoc) -> Result<(), String> {
        let doc = self.page_doc(page)?;
        self.on_doc(&doc, |collab| {
            let before = collab.comments.len();
            collab.comments.retain(|c| !c.is_resolved());
            if collab.comments.len() != before {
                collab.comments_changed();
            }
            Ok(())
        })
    }
}

pub(crate) struct ListenGuard(Arc<Registry>);

impl Drop for ListenGuard {
    fn drop(&mut self) {
        self.0.coedit().listening.fetch_sub(1, Ordering::SeqCst);
        self.0.emit_coedit_state();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::docs::files::tests::TestDisk;
    use crate::docs::registry::tests::{registry_with, Recorder};
    use crate::store::workspace::tests::note;

    fn edit(old: &str, new: &str) -> Edit {
        Edit {
            old_text: old.into(),
            new_text: new.into(),
        }
    }

    fn shared(notes: &[crate::store::workspace::Note]) -> (Arc<Registry>, Arc<Recorder>, String) {
        let (registry, recorder, _, id) = registry_with(notes);
        (Arc::new(registry), recorder, id)
    }

    fn note_text(registry: &Registry, id: &str) -> String {
        registry
            .with(|workspace| Ok(workspace.entry_mut(id)?.collab.text().to_string()))
            .unwrap()
    }

    fn push(registry: &Registry, collection: &str, id: &str, changes: Value) {
        let version = registry
            .with(|workspace| Ok(workspace.entry_mut(id)?.collab.version()))
            .unwrap();
        let pushed = registry
            .push(
                collection,
                id,
                version,
                vec![Update {
                    client_id: "page".into(),
                    changes,
                }],
            )
            .unwrap();
        assert!(pushed.accepted);
    }

    fn page(collection: &str, id: &str) -> PageDoc {
        PageDoc::Note {
            collection_id: collection.into(),
            note_id: id.into(),
        }
    }

    #[cfg(unix)]
    #[test]
    fn the_mirror_is_readable_only_by_the_owner() {
        use std::os::unix::fs::PermissionsExt;
        let directory =
            std::env::temp_dir().join(format!("sodilaud-mirror-{}", uuid::Uuid::new_v4().simple()));
        let target = directory.join(FILE_NAME);
        write_mirror(&target, &BTreeSet::from([PathBuf::from("/a/spec.md")])).unwrap();
        let mode = std::fs::metadata(&target).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn the_acceptance_scenario_loses_nothing() {
        let (registry, recorder, collection) = shared(&[note(
            "a",
            "# Spec\n\nIntro is vague.\n\n## Risks\n\nNone.\n",
            1,
        )]);
        let doc = DocRef::Note("a".into());
        let read = registry.coedit_read(&doc, 0, DEFAULT_READ_CHARS).unwrap();
        let base = read["version"].as_u64().unwrap();
        // The owner types and adds two comments while the agent works.
        push(
            &registry,
            &collection,
            "a",
            json!([8, [0, "Owner line.", ""], 33]),
        );
        let text = note_text(&registry, "a");
        let at = |needle: &str| {
            let start = changes::utf16_of_byte(&text, text.find(needle).unwrap());
            (start, start + changes::utf16_len(needle))
        };
        let version = 1;
        registry
            .comment_add(
                &page(&collection, "a"),
                version,
                at("Owner line."),
                "keep this",
                None,
            )
            .unwrap();
        registry
            .comment_add(
                &page(&collection, "a"),
                version,
                at("None."),
                "list real risks",
                None,
            )
            .unwrap();
        let applied = registry
            .coedit_apply(
                &doc,
                base,
                "r1",
                &[edit("Intro is vague.", "Intro is concrete.")],
            )
            .unwrap();
        assert_eq!(applied["applied"], json!([0]));
        assert_eq!(
            note_text(&registry, "a"),
            "# Spec\n\nOwner line.\nIntro is concrete.\n\n## Risks\n\nNone.\n"
        );
        let pending = registry.coedit_take_pending(None);
        let bodies: Vec<_> = pending.iter().map(|c| c["body"].clone()).collect();
        assert_eq!(bodies, vec![json!("keep this"), json!("list real risks")]);
        assert_eq!(pending[1]["headingPath"], json!(["Spec", "Risks"]));
        assert_eq!(pending[1]["anchoredText"], "None.");
        assert!(registry.coedit_take_pending(None).is_empty(), "taken once");
        let docs = recorder.docs.lock().unwrap();
        assert_eq!(docs.last().unwrap().updates[0].client_id, AGENT_CLIENT);
    }

    #[test]
    fn stale_bases_retries_and_conflicts() {
        let (registry, _, collection) = shared(&[note("a", "one two three", 1)]);
        let doc = DocRef::Note("a".into());
        assert!(registry
            .coedit_apply(&doc, 0, "r0", &[edit("two", "2")])
            .unwrap_err()
            .starts_with("STALE_BASE"));
        registry.coedit_read(&doc, 0, 10).unwrap();
        push(&registry, &collection, "a", json!([5, [0, "X"], 8]));
        let first = registry
            .coedit_apply(&doc, 0, "r1", &[edit("two", "2"), edit("three", "3")])
            .unwrap();
        assert_eq!(first["applied"], json!([1]));
        assert_eq!(first["conflicts"][0]["reason"], "edited_by_owner");
        assert_eq!(first["conflicts"][0]["currentText"], "tXwo");
        let again = registry
            .coedit_apply(&doc, 0, "r1", &[edit("two", "2"), edit("three", "3")])
            .unwrap();
        assert_eq!(again, first, "a retry returns the first result");
        assert_eq!(note_text(&registry, "a"), "one tXwo 3");
        assert!(registry
            .coedit_apply(&doc, 0, "r1", &[edit("one", "1")])
            .is_err());
        assert!(registry.coedit_apply(&doc, 0, "r2", &[]).is_err());
    }

    #[test]
    fn agent_comments_replies_and_resolving() {
        let (registry, _, collection) = shared(&[note("a", "Which db? Which db?", 1)]);
        let doc = DocRef::Note("a".into());
        assert!(registry
            .coedit_add_comment(&doc, "Which db?", None, "Pick one", "c1")
            .unwrap_err()
            .contains("2 times"));
        let added = registry
            .coedit_add_comment(&doc, "Which db?", Some(2), "Pick one", "c1")
            .unwrap();
        let question = added["comment"]["id"].as_str().unwrap().to_string();
        assert_eq!(added["comment"]["offset"], 10);
        assert!(
            registry.coedit_take_pending(None).is_empty(),
            "agent comments never pend"
        );
        let reply = registry
            .comment_add(
                &page(&collection, "a"),
                0,
                (0, 1),
                "Postgres",
                Some(&question),
            )
            .unwrap();
        assert_eq!((reply.from, reply.to), (10, 19));
        let pending = registry.coedit_take_pending(Some(&doc));
        assert_eq!(
            pending[0]["replyTo"],
            json!({ "id": question, "body": "Pick one" })
        );
        let resolved = registry.coedit_resolve(&reply.id, "Used Postgres").unwrap();
        assert_eq!(resolved["comment"]["state"], "resolved");
        let all = registry
            .comments_get(&page(&collection, "a"))
            .unwrap()
            .comments;
        assert!(
            all.iter().all(Comment::is_resolved),
            "the question is resolved too"
        );
        assert!(registry.coedit_resolve("c_missing", "x").is_err());
        assert!(registry
            .comment_add(&page(&collection, "a"), 0, (0, 1), "x", Some(&reply.id))
            .is_err());
    }

    #[test]
    fn hold_for_review_sends_only_on_request_and_owner_rules_apply() {
        let (registry, recorder, collection) = shared(&[note("a", "alpha beta", 1)]);
        let doc = page(&collection, "a");
        registry.set_hold_for_review(true);
        let held = registry
            .comment_add(&doc, 0, (0, 5), "first", None)
            .unwrap();
        assert_eq!(held.state, State::Held);
        assert!(registry.coedit_take_pending(None).is_empty());
        registry
            .comment_edit(&doc, &held.id, "first, edited")
            .unwrap();
        assert_eq!(registry.comments_send_review(&doc).unwrap(), 1);
        let pending = registry.coedit_take_pending(None);
        assert_eq!(pending[0]["body"], "first, edited");
        assert!(registry.comment_edit(&doc, &held.id, "late").is_err());
        assert!(registry.comment_delete(&doc, &held.id).is_err());
        registry.comment_resend(&doc, &held.id).unwrap();
        assert_eq!(registry.coedit_take_pending(None).len(), 1);
        registry.comment_resolve(&doc, &held.id).unwrap();
        registry.comments_clear_resolved(&doc).unwrap();
        assert!(registry.comments_get(&doc).unwrap().comments.is_empty());
        assert!(registry
            .comment_add(&page("old", "a"), 0, (0, 5), "x", None)
            .is_err());
        assert!(registry.comment_add(&doc, 0, (0, 5), "  ", None).is_err());
        assert!(
            recorder
                .coedit
                .lock()
                .unwrap()
                .last()
                .unwrap()
                .hold_for_review
        );
    }

    #[test]
    fn a_selection_made_before_other_edits_is_mapped_forward() {
        let (registry, _, collection) = shared(&[note("a", "alpha beta", 1)]);
        push(&registry, &collection, "a", json!([[0, ">> "], 10]));
        let comment = registry
            .comment_add(&page(&collection, "a"), 0, (6, 10), "b", None)
            .unwrap();
        assert_eq!(comment.anchored_text, "beta");
        push(&registry, &collection, "a", json!([3, [10]]));
        assert!(registry
            .comment_add(&page(&collection, "a"), 1, (6, 10), "b", None)
            .is_err());
    }

    #[test]
    fn files_are_co_edited_through_the_same_operations() {
        let directory =
            std::env::temp_dir().join(format!("sodilaud-coedit-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory
            .join("spec.md")
            .canonicalize()
            .unwrap_or(directory.join("spec.md"));
        std::fs::write(&path, "# Spec\nTBD\n").unwrap();
        let path = path.canonicalize().unwrap();
        let registry = Arc::new(Registry::default());
        let recorder = Arc::new(Recorder::default());
        registry.set_sink(recorder.clone());
        let mirror = directory.join("app").join(FILE_NAME);
        registry.set_coedit_mirror(mirror.clone());
        let doc_id = registry.file_open(&path, &TestDisk).unwrap().doc_id;
        let doc = DocRef::parse(path.to_str(), None).unwrap();
        assert!(DocRef::parse(Some("spec.md"), None).is_err());
        assert!(DocRef::parse(path.to_str(), Some("a")).is_err());
        let read = registry.coedit_read(&doc, 0, 4).unwrap();
        assert_eq!(read["content"], "# Sp");
        assert_eq!(read["nextOffset"], 4);
        assert_eq!(read["headings"][0]["text"], "Spec");
        let listed: Value = serde_json::from_slice(&std::fs::read(&mirror).unwrap()).unwrap();
        assert_eq!(listed["files"], json!([path.to_string_lossy()]));
        let applied = registry
            .coedit_apply(&doc, 0, "f1", &[edit("TBD", "Ship it.")])
            .unwrap();
        assert_eq!(applied["version"], 1);
        assert_eq!(
            registry.file_open(&path, &TestDisk).unwrap().text,
            "# Spec\nShip it.\n"
        );
        let page = PageDoc::File {
            path: path.clone(),
            doc_id: doc_id.clone(),
        };
        registry
            .comment_add(&page, 1, (7, 11), "why", None)
            .unwrap();
        let list = registry.coedit_list();
        assert_eq!(list[0]["pendingComments"], 1);
        assert_eq!(list[0]["coEdited"], true);
        assert!(registry
            .comments_get(&PageDoc::File {
                path: path.clone(),
                doc_id: "other".into()
            })
            .is_err());
        registry.file_close(&path, &TestDisk).unwrap();
        let listed: Value = serde_json::from_slice(&std::fs::read(&mirror).unwrap()).unwrap();
        assert_eq!(listed["files"], json!([]));
    }

    #[tokio::test]
    async fn a_listener_is_woken_by_a_queued_comment() {
        let (registry, recorder, collection) = shared(&[note("a", "alpha", 1)]);
        let queued = registry.coedit_queued();
        let waiting = queued.notified();
        tokio::pin!(waiting);
        waiting.as_mut().enable();
        let guard = registry.coedit_listen();
        registry
            .comment_add(&page(&collection, "a"), 0, (0, 5), "go", None)
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1), waiting)
            .await
            .expect("woken");
        drop(guard);
        let states: Vec<bool> = recorder
            .coedit
            .lock()
            .unwrap()
            .iter()
            .map(|s| s.listening)
            .collect();
        assert_eq!(states, vec![true, false]);
    }
}
