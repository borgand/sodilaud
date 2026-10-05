// SPDX-License-Identifier: GPL-3.0-or-later

//! `sodilaud --pretooluse-hook`: a Claude Code PreToolUse hook. Claude Code
//! sends the tool call as JSON on stdin; when its `file_path` is a file an
//! agent co-edits in Sodilaud (listed in `coedit.json`), the hook refuses the
//! native edit and points at the MCP tools. Anything unexpected lets the edit
//! through: a broken hook must never stop the agent.

use std::io::Read;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::docs::coedit;

pub const FLAG: &str = "--pretooluse-hook";
pub(crate) const MESSAGE: &str = "This file is co-edited in Sodilaud. Use mcp__sodilaud__read_document and mcp__sodilaud__apply_edit.";
/// Claude Code reads a PreToolUse exit code of 2 as "block, and show stderr to the model".
const BLOCK: i32 = 2;

/// Ways the hook input can name a file: as given, and with symbolic links
/// resolved, or its folder resolved for a file that does not exist yet.
fn candidates(path: &Path) -> Vec<PathBuf> {
    let mut found = vec![path.to_path_buf()];
    if let Ok(resolved) = path.canonicalize() {
        found.push(resolved);
    } else if let (Some(parent), Some(name)) = (path.parent(), path.file_name()) {
        if let Ok(parent) = parent.canonicalize() {
            found.push(parent.join(name));
        }
    }
    found
}

/// The message to block with, or `None` to allow the tool call.
pub(crate) fn decide(input: &str, list: &Path) -> Option<&'static str> {
    let call: Value = serde_json::from_str(input).ok()?;
    let file = call.get("tool_input")?.get("file_path")?.as_str()?;
    let mut path = PathBuf::from(file);
    if path.is_relative() {
        path = Path::new(call.get("cwd")?.as_str()?).join(path);
    }
    let listed: Value = serde_json::from_slice(&std::fs::read(list).ok()?).ok()?;
    let files: Vec<&str> = listed
        .get("files")?
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
        .collect();
    candidates(&path)
        .iter()
        .any(|candidate| files.iter().any(|file| Path::new(file) == candidate))
        .then_some(MESSAGE)
}

/// Runs the hook and returns the process exit code.
pub fn run_pretooluse_hook(identifier: &str) -> i32 {
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        return 0;
    }
    let Some(data) = dirs::data_dir() else {
        return 0;
    };
    match decide(&input, &data.join(identifier).join(coedit::FILE_NAME)) {
        Some(message) => {
            eprintln!("{message}");
            BLOCK
        }
        None => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::BTreeSet;

    fn scratch() -> PathBuf {
        let directory =
            std::env::temp_dir().join(format!("sodilaud-hook-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&directory).unwrap();
        directory.canonicalize().unwrap()
    }

    fn call(path: &str, cwd: &str) -> String {
        json!({ "tool_name": "Edit", "cwd": cwd, "tool_input": { "file_path": path, "old_string": "a" } })
            .to_string()
    }

    #[test]
    fn blocks_only_co_edited_files_however_they_are_named() {
        let directory = scratch();
        let spec = directory.join("spec.md");
        std::fs::write(&spec, "x").unwrap();
        let list = directory.join(coedit::FILE_NAME);
        coedit::write_mirror(&list, &BTreeSet::from([spec.clone()])).unwrap();
        let cwd = directory.to_str().unwrap();
        assert_eq!(
            decide(&call(spec.to_str().unwrap(), "/"), &list),
            Some(MESSAGE)
        );
        assert_eq!(decide(&call("spec.md", cwd), &list), Some(MESSAGE));
        assert_eq!(decide(&call("./spec.md", cwd), &list), Some(MESSAGE));
        assert_eq!(decide(&call("other.md", cwd), &list), None);
        #[cfg(unix)]
        {
            let link = directory.join("link.md");
            std::os::unix::fs::symlink(&spec, &link).unwrap();
            assert_eq!(
                decide(&call(link.to_str().unwrap(), "/"), &list),
                Some(MESSAGE)
            );
        }
    }

    #[test]
    fn anything_unexpected_allows_the_edit() {
        let directory = scratch();
        let list = directory.join(coedit::FILE_NAME);
        let spec = directory.join("spec.md");
        let edit = call(spec.to_str().unwrap(), "/");
        assert_eq!(decide(&edit, &list), None, "no list");
        std::fs::write(&list, b"{").unwrap();
        assert_eq!(decide(&edit, &list), None, "damaged list");
        std::fs::write(&list, br#"{"files": "nope"}"#).unwrap();
        assert_eq!(decide(&edit, &list), None, "wrong shape");
        coedit::write_mirror(&list, &BTreeSet::from([spec.clone()])).unwrap();
        assert_eq!(decide("not json", &list), None);
        assert_eq!(decide(r#"{"tool_input":{}}"#, &list), None, "no file_path");
        assert_eq!(
            decide(r#"{"tool_input":{"file_path":"spec.md"}}"#, &list),
            None,
            "relative without cwd"
        );
        assert_eq!(decide(r#"{"tool_input":{"file_path":7}}"#, &list), None);
    }
}
