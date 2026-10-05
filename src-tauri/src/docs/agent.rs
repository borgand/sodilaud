// SPDX-License-Identifier: GPL-3.0-or-later

//! MCP write operations on the registry. Arguments were validated for shape by
//! the MCP layer; this checks them against the live collection, applies them,
//! and remembers each result by `requestId` so a retry never applies twice.

use serde_json::{json, Value};

use super::changes;
use super::registry::{
    insert_below_pinned, new_entry, now_ms, trash_note_in, trash_summary, DocUpdates, FolderEntry,
    Receipt, Registry, Update, Workspace,
};
use crate::store::workspace::{Folder, Note};

const MAX_RECEIPTS: usize = 1000;
const RESERVED_FOLDER_NAMES: [&str; 2] = ["pinned", "top level"];

pub(crate) const AGENT_CLIENT: &str = "agent";

pub(crate) const OPERATIONS: [&str; 8] = [
    "create_note",
    "create_folder",
    "append_to_note",
    "rename_note",
    "move_note",
    "rename_folder",
    "delete_note",
    "delete_folder",
];

fn text<'a>(args: &'a Value, field: &str) -> &'a str {
    args[field].as_str().unwrap_or_default()
}

pub(crate) fn normalize_folder_name(name: &str) -> String {
    name.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn folder_name_available(workspace: &Workspace, name: &str, excluded: Option<&str>) -> bool {
    let wanted = name.to_lowercase();
    !wanted.is_empty()
        && !RESERVED_FOLDER_NAMES.contains(&wanted.as_str())
        && !workspace.folders.iter().any(|f| {
            Some(f.folder.id.as_str()) != excluded && f.folder.name.to_lowercase() == wanted
        })
}

fn metadata(note: &Note) -> Value {
    let mut value = serde_json::to_value(note).unwrap_or_default();
    if let Some(object) = value.as_object_mut() {
        object.remove("content");
    }
    value
}

impl Registry {
    pub(crate) fn agent_write(&self, operation: &str, args: &Value) -> Result<Value, String> {
        if !OPERATIONS.contains(&operation) {
            return Err("Unknown write operation".into());
        }
        let collection_id = text(args, "collectionId").to_string();
        let request_id = text(args, "requestId").to_string();
        let fingerprint = json!([
            operation,
            args["noteId"],
            args["title"],
            args["name"],
            args["content"],
            args["folderId"],
            args["expectedRevision"],
        ])
        .to_string();

        self.with(|workspace| {
            workspace.check(&collection_id)?;
            if let Some(receipt) = workspace.receipts.get(&request_id) {
                if receipt.fingerprint != fingerprint {
                    return Err("requestId was already used with different arguments".into());
                }
                return Ok(receipt.result.clone());
            }
            if workspace.receipts.len() >= MAX_RECEIPTS {
                return Err("Write limit reached for this collection session; reopen the collection to start a new session".into());
            }
            let mut doc_event = None;
            let mut result = apply(workspace, operation, args, &mut doc_event)?;
            result["ok"] = json!(true);
            result["collectionId"] = json!(collection_id);
            result["requestId"] = json!(request_id);
            workspace.receipts.insert(
                request_id.clone(),
                Receipt {
                    fingerprint: fingerprint.clone(),
                    result: result.clone(),
                },
            );
            // Text first, so an open editor applies the change before the
            // sidebar reports the new version.
            if let Some(event) = doc_event {
                self.emit_doc(&event);
            }
            self.changed(workspace);
            Ok(result)
        })
    }
}

fn apply(
    workspace: &mut Workspace,
    operation: &str,
    args: &Value,
    doc_event: &mut Option<DocUpdates>,
) -> Result<Value, String> {
    let expected = text(args, "expectedRevision");
    let folder_exists =
        |workspace: &Workspace, id: &str| workspace.folders.iter().any(|f| f.folder.id == id);
    match operation {
        "create_note" => {
            let folder_id = args["folderId"].as_str().map(str::to_string);
            if let Some(id) = &folder_id {
                if !folder_exists(workspace, id) {
                    return Err("Destination folder does not exist".into());
                }
            }
            let note = Note {
                id: format!("note_{}", uuid::Uuid::new_v4()),
                title: text(args, "title").trim().to_string(),
                content: changes::normalize_newlines(text(args, "content")).into_owned(),
                updated_at: now_ms(),
                is_title_locked: true,
                is_pinned: false,
                folder_id,
            };
            let mut draft = workspace.draft();
            let rev = draft.rev();
            insert_below_pinned(&mut draft.notes, new_entry(note.clone(), rev));
            workspace.commit(draft)?;
            Ok(json!({ "note": note }))
        }
        "create_folder" => {
            let name = normalize_folder_name(text(args, "name"));
            if !folder_name_available(workspace, &name, None) {
                return Err("Folder name is reserved or already exists".into());
            }
            let folder = Folder {
                id: format!("folder_{}", uuid::Uuid::new_v4()),
                name,
            };
            let mut draft = workspace.draft();
            let rev = draft.rev();
            draft.folders.push(FolderEntry {
                folder: folder.clone(),
                rev,
            });
            workspace.commit(draft)?;
            Ok(json!({ "folder": folder }))
        }
        "rename_folder" | "delete_folder" => {
            let id = text(args, "folderId");
            let current = workspace
                .folders
                .iter()
                .find(|f| f.folder.id == id)
                .ok_or("Folder no longer exists; write will not be repeated")?;
            if current.rev.to_string() != expected {
                return Err(if operation == "delete_folder" {
                    "Revision conflict: reread the target before deleting".into()
                } else {
                    "Revision conflict: reread with list_folders before editing".into()
                });
            }
            let mut draft = workspace.draft();
            if operation == "delete_folder" {
                if draft
                    .notes
                    .iter()
                    .any(|e| e.note.folder_id.as_deref() == Some(id))
                {
                    return Err("Folder is not empty; move its notes before deleting it".into());
                }
                draft.folders.retain(|f| f.folder.id != id);
                workspace.commit(draft)?;
                return Ok(json!({ "folderId": id }));
            }
            let name = normalize_folder_name(text(args, "name"));
            if !folder_name_available(workspace, &name, Some(id)) {
                return Err("Folder name is reserved or already exists".into());
            }
            let rev = draft.rev();
            let folder = draft
                .folders
                .iter_mut()
                .find(|f| f.folder.id == id)
                .ok_or("Folder no longer exists")?;
            folder.folder.name = name;
            folder.rev = rev;
            let saved = folder.folder.clone();
            workspace.commit(draft)?;
            Ok(json!({ "folder": saved, "revision": rev.to_string() }))
        }
        _ => {
            let id = text(args, "noteId");
            let current = workspace
                .notes
                .iter()
                .find(|e| e.note.id == id)
                .ok_or("Note no longer exists; write will not be repeated")?;
            if current.rev.to_string() != expected {
                return Err(if operation == "delete_note" {
                    "Revision conflict: reread the target before deleting".into()
                } else {
                    "Revision conflict: reread with get_note before editing".into()
                });
            }
            match operation {
                "delete_note" => {
                    let mut draft = workspace.draft();
                    let entry = trash_note_in(&mut draft, id)?;
                    workspace.commit(draft)?;
                    Ok(json!({ "trash": trash_summary(&entry) }))
                }
                "append_to_note" => {
                    let addition = changes::normalize_newlines(text(args, "content"));
                    let update = Update {
                        client_id: AGENT_CLIENT.into(),
                        changes: changes::append(current.collab.text(), &addition),
                    };
                    let event = workspace.apply_updates(id, vec![update])?;
                    let entry = workspace
                        .notes
                        .iter()
                        .find(|e| e.note.id == id)
                        .ok_or("Note no longer exists")?;
                    let result =
                        json!({ "note": metadata(&entry.note), "revision": entry.rev.to_string() });
                    *doc_event = Some(event);
                    Ok(result)
                }
                _ => {
                    let destination = if operation == "move_note" {
                        let folder_id = args["folderId"].as_str();
                        if let Some(folder_id) = folder_id {
                            if !folder_exists(workspace, folder_id) {
                                return Err("Destination folder does not exist".into());
                            }
                        }
                        Some(folder_id.map(str::to_string))
                    } else {
                        None
                    };
                    let mut draft = workspace.draft();
                    let rev = draft.rev();
                    let entry = draft
                        .notes
                        .iter_mut()
                        .find(|e| e.note.id == id)
                        .ok_or("Note no longer exists")?;
                    match destination {
                        Some(folder_id) => entry.note.folder_id = folder_id,
                        None => {
                            entry.note.title = text(args, "title").trim().to_string();
                            entry.note.is_title_locked = true;
                        }
                    }
                    entry.note.updated_at = now_ms().max(entry.note.updated_at + 1);
                    entry.rev = rev;
                    let saved = entry.note.clone();
                    workspace.commit(draft)?;
                    Ok(json!({ "note": metadata(&saved), "revision": rev.to_string() }))
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::docs::registry::tests::registry_with;
    use crate::store::workspace::tests::note;

    fn rev(registry: &Registry, id: &str) -> String {
        registry
            .state()
            .unwrap()
            .notes
            .iter()
            .find(|n| n.note.id == id)
            .unwrap()
            .rev
            .to_string()
    }

    #[test]
    fn append_reaches_open_editors_as_an_update_and_retries_do_not_repeat() {
        let (registry, recorder, path, id) = registry_with(&[note("a", "start", 1)]);
        let args = json!({"collectionId": id, "requestId": "r1", "noteId": "a",
            "expectedRevision": rev(&registry, "a"), "content": "\r\nmore"});
        let first = registry.agent_write("append_to_note", &args).unwrap();
        let again = registry.agent_write("append_to_note", &args).unwrap();
        assert_eq!(first, again);
        assert_eq!(first["ok"], true);
        assert!(first["note"].get("content").is_none());
        let state = registry.state().unwrap();
        assert_eq!(state.notes[0].note.content, "start\nmore");
        assert_eq!(state.notes[0].version, 1);
        let docs = recorder.docs.lock().unwrap();
        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0].updates[0].client_id, AGENT_CLIENT);
        let mut changed = args.clone();
        changed["content"] = json!("other");
        drop(docs);
        assert!(registry
            .agent_write("append_to_note", &changed)
            .unwrap_err()
            .contains("different arguments"));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn a_stale_revision_is_a_conflict() {
        let (registry, _, path, id) = registry_with(&[note("a", "x", 1)]);
        let stale = rev(&registry, "a");
        registry
            .push(
                &id,
                "a",
                0,
                vec![super::Update {
                    client_id: "editor".into(),
                    changes: json!([1, [0, "y"]]),
                }],
            )
            .unwrap();
        for operation in ["append_to_note", "rename_note", "move_note", "delete_note"] {
            let args = json!({"collectionId": id, "requestId": operation, "noteId": "a",
                "expectedRevision": stale, "content": "z", "title": "T", "folderId": null});
            let error = registry.agent_write(operation, &args).unwrap_err();
            assert!(error.contains("Revision conflict"), "{operation}: {error}");
        }
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn creates_renames_moves_and_deletes() {
        let (registry, _, path, id) = registry_with(&[note("a", "x", 1)]);
        let call = |operation: &str, args: Value| {
            let mut args = args;
            args["collectionId"] = json!(id);
            args["requestId"] = json!(uuid::Uuid::new_v4().to_string());
            registry.agent_write(operation, &args)
        };
        let folder = call("create_folder", json!({"name": "  Work "})).unwrap();
        let folder_id = folder["folder"]["id"].as_str().unwrap().to_string();
        assert!(call("create_folder", json!({"name": "work"})).is_err());
        assert!(call("create_folder", json!({"name": "Pinned"})).is_err());

        let created = call(
            "create_note",
            json!({"title": " Plan ", "content": "c", "folderId": folder_id}),
        )
        .unwrap();
        assert_eq!(created["note"]["title"], "Plan");
        assert_eq!(created["note"]["isTitleLocked"], true);
        assert!(call("create_note", json!({"title": "x", "folderId": "missing"})).is_err());

        let renamed = call(
            "rename_note",
            json!({"noteId": "a", "expectedRevision": rev(&registry, "a"), "title": "Named"}),
        )
        .unwrap();
        assert_eq!(renamed["note"]["title"], "Named");
        assert_eq!(renamed["revision"], json!(rev(&registry, "a")));
        call(
            "move_note",
            json!({"noteId": "a", "expectedRevision": rev(&registry, "a"), "folderId": folder_id}),
        )
        .unwrap();

        let folder_rev = registry.state().unwrap().folders[0].rev.to_string();
        let blocked = call(
            "delete_folder",
            json!({"folderId": folder_id, "expectedRevision": folder_rev}),
        );
        assert!(blocked.unwrap_err().contains("not empty"));
        call(
            "rename_folder",
            json!({"folderId": folder_id, "expectedRevision": folder_rev, "name": "Projects"}),
        )
        .unwrap();
        assert_eq!(registry.state().unwrap().folders[0].name, "Projects");

        let deleted = call(
            "delete_note",
            json!({"noteId": "a", "expectedRevision": rev(&registry, "a")}),
        )
        .unwrap();
        assert_eq!(deleted["trash"]["noteId"], "a");
        assert_eq!(registry.state().unwrap().trash.len(), 1);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn a_write_for_another_collection_is_rejected() {
        let (registry, _, path, _) = registry_with(&[note("a", "x", 1)]);
        let args = json!({"collectionId": "old", "requestId": "r", "name": "F"});
        assert!(registry
            .agent_write("create_folder", &args)
            .unwrap_err()
            .contains("Collection changed"));
        std::fs::remove_file(path).unwrap();
    }
}
