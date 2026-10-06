// SPDX-License-Identifier: GPL-3.0-or-later

//! Installs the Claude Code side of co-editing into a home directory: the
//! `/sodilaud` command, the `sodilaud` skill, and a PreToolUse hook in
//! `settings.json` that sends native edits of co-edited files to the MCP
//! tools. Only on the owner's request, after showing what changes. Every
//! function takes the home directory, so tests never touch the real one.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::hook;

pub(crate) const COMMAND: &str = include_str!("../resources/claude/sodilaud.md");
pub(crate) const SKILL: &str = include_str!("../resources/claude/SKILL.md");
const MATCHER: &str = "Edit|Write|MultiEdit";

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Plan {
    /// What installing would do now, one line each.
    pub(crate) changes: Vec<String>,
    pub(crate) installed: bool,
    /// Some part is there, maybe from an older version.
    pub(crate) present: bool,
}

struct Paths {
    command: PathBuf,
    skill: PathBuf,
    settings: PathBuf,
}

fn paths(home: &Path) -> Paths {
    let claude = home.join(".claude");
    Paths {
        command: claude.join("commands").join("sodilaud.md"),
        skill: claude.join("skills").join("sodilaud").join("SKILL.md"),
        settings: claude.join("settings.json"),
    }
}

fn shown(home: &Path, path: &Path) -> String {
    match path.strip_prefix(home) {
        Ok(relative) => format!("~/{}", relative.to_string_lossy()),
        Err(_) => path.to_string_lossy().into_owned(),
    }
}

pub(crate) fn hook_command(executable: &str) -> String {
    format!("\"{executable}\" {}", hook::FLAG)
}

fn is_ours(hook: &Value) -> bool {
    hook.get("command")
        .and_then(Value::as_str)
        .is_some_and(|command| command.contains(hook::FLAG))
}

/// The settings file, or an empty object when there is none. A file that is
/// not a JSON object is refused, so nothing is overwritten by mistake.
fn read_settings(path: &Path) -> Result<Option<Map<String, Value>>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Could not read {}: {error}", path.display())),
    };
    match serde_json::from_slice(&bytes) {
        Ok(Value::Object(map)) => Ok(Some(map)),
        _ => Err(format!(
            "{} is not a JSON object. Fix it first; nothing was changed.",
            path.display()
        )),
    }
}

fn pre_tool_use(settings: &mut Map<String, Value>) -> Result<&mut Vec<Value>, String> {
    let hooks = settings
        .entry("hooks")
        .or_insert_with(|| Value::Object(Map::new()))
        .as_object_mut()
        .ok_or("\"hooks\" in settings.json is not an object; nothing was changed.")?;
    hooks
        .entry("PreToolUse")
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or_else(|| {
            "\"hooks.PreToolUse\" in settings.json is not a list; nothing was changed.".to_string()
        })
}

/// Takes every Sodilaud hook out of the settings, leaving other hooks alone.
/// Returns whether one was there.
fn strip(settings: &mut Map<String, Value>) -> Result<bool, String> {
    let Some(entries) = settings
        .get_mut("hooks")
        .and_then(Value::as_object_mut)
        .and_then(|hooks| hooks.get_mut("PreToolUse"))
        .and_then(Value::as_array_mut)
    else {
        return Ok(false);
    };
    let mut found = false;
    for entry in entries.iter_mut() {
        if let Some(list) = entry.get_mut("hooks").and_then(Value::as_array_mut) {
            let before = list.len();
            list.retain(|hook| !is_ours(hook));
            found |= list.len() != before;
        }
    }
    entries.retain(|entry| {
        entry
            .get("hooks")
            .and_then(Value::as_array)
            .is_none_or(|list| !list.is_empty())
    });
    Ok(found)
}

fn has_hook(settings: &Map<String, Value>, command: &str) -> bool {
    settings
        .get("hooks")
        .and_then(|hooks| hooks.get("PreToolUse"))
        .and_then(Value::as_array)
        .is_some_and(|entries| {
            entries.iter().any(|entry| {
                entry.get("matcher").and_then(Value::as_str) == Some(MATCHER)
                    && entry
                        .get("hooks")
                        .and_then(Value::as_array)
                        .is_some_and(|list| {
                            list.iter().any(|hook| {
                                hook.get("command").and_then(Value::as_str) == Some(command)
                            })
                        })
            })
        })
}

fn same_contents(path: &Path, contents: &str) -> bool {
    fs::read_to_string(path).is_ok_and(|found| found == contents)
}

/// What installing would change, and whether everything is in place now.
pub(crate) fn plan(home: &Path, executable: &str) -> Result<Plan, String> {
    let paths = paths(home);
    let command = hook_command(executable);
    let settings = read_settings(&paths.settings)?;
    let mut changes = Vec::new();
    for (path, contents, what) in [
        (&paths.command, COMMAND, "the /sodilaud command"),
        (&paths.skill, SKILL, "the sodilaud skill"),
    ] {
        if !path.exists() {
            changes.push(format!("Create {} ({what})", shown(home, path)));
        } else if !same_contents(path, contents) {
            changes.push(format!("Update {} ({what})", shown(home, path)));
        }
    }
    let hooked = settings
        .as_ref()
        .is_some_and(|settings| has_hook(settings, &command));
    if !hooked {
        let file = shown(home, &paths.settings);
        changes.push(match &settings {
            Some(_) => format!(
                "Add a PreToolUse hook for {MATCHER} to {file}, after copying it to settings.json.bak. Other settings and hooks stay as they are"
            ),
            None => format!("Create {file} with a PreToolUse hook for {MATCHER}"),
        });
    }
    let present = paths.command.exists()
        || paths.skill.exists()
        || settings.as_ref().is_some_and(|settings| {
            settings
                .get("hooks")
                .and_then(|hooks| hooks.get("PreToolUse"))
                .and_then(Value::as_array)
                .is_some_and(|entries| {
                    entries.iter().any(|entry| {
                        entry
                            .get("hooks")
                            .and_then(Value::as_array)
                            .is_some_and(|list| list.iter().any(is_ours))
                    })
                })
        });
    Ok(Plan {
        installed: changes.is_empty(),
        changes,
        present,
    })
}

fn write_atomic(path: &Path, contents: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
    }
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4().simple()));
    fs::write(&temporary, contents)
        .map_err(|e| format!("Could not write {}: {e}", path.display()))?;
    fs::rename(&temporary, path).map_err(|e| {
        let _ = fs::remove_file(&temporary);
        format!("Could not write {}: {e}", path.display())
    })
}

fn write_settings(path: &Path, settings: &Map<String, Value>, existed: bool) -> Result<(), String> {
    if existed {
        fs::copy(path, path.with_extension("json.bak"))
            .map_err(|e| format!("Could not back up {}: {e}", path.display()))?;
    }
    let mut bytes = serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    write_atomic(path, &bytes)
}

/// Writes the command and skill and merges the hook into the settings.
/// Installing again updates them in place.
pub(crate) fn install(home: &Path, executable: &str) -> Result<Plan, String> {
    let paths = paths(home);
    let command = hook_command(executable);
    let existing = read_settings(&paths.settings)?;
    let existed = existing.is_some();
    let mut settings = existing.unwrap_or_default();
    if !has_hook(&settings, &command) {
        strip(&mut settings)?;
        pre_tool_use(&mut settings)?.push(json!({
            "matcher": MATCHER,
            "hooks": [{ "type": "command", "command": command }],
        }));
        write_settings(&paths.settings, &settings, existed)?;
    }
    for (path, contents) in [(&paths.command, COMMAND), (&paths.skill, SKILL)] {
        if !same_contents(path, contents) {
            write_atomic(path, contents.as_bytes())?;
        }
    }
    plan(home, executable)
}

/// Removes the command, the skill and the hook, and nothing else.
pub(crate) fn remove(home: &Path, executable: &str) -> Result<Plan, String> {
    let paths = paths(home);
    if let Some(mut settings) = read_settings(&paths.settings)? {
        if strip(&mut settings)? {
            if let Some(hooks) = settings.get_mut("hooks").and_then(Value::as_object_mut) {
                if hooks
                    .get("PreToolUse")
                    .and_then(Value::as_array)
                    .is_some_and(Vec::is_empty)
                {
                    hooks.remove("PreToolUse");
                }
                if hooks.is_empty() {
                    settings.remove("hooks");
                }
            }
            write_settings(&paths.settings, &settings, true)?;
        }
    }
    for path in [&paths.command, &paths.skill] {
        match fs::remove_file(path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                return Err(format!("Could not remove {}: {error}", path.display()))
            }
            _ => {}
        }
    }
    if let Some(folder) = paths.skill.parent() {
        let _ = fs::remove_dir(folder);
    }
    plan(home, executable)
}

fn home() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "Could not find your home folder".to_string())
}

#[tauri::command]
pub(crate) fn coedit_integration_plan() -> Result<Plan, String> {
    plan(&home()?, &crate::mcp::executable()?)
}

#[tauri::command]
pub(crate) fn coedit_integration_install() -> Result<Plan, String> {
    install(&home()?, &crate::mcp::executable()?)
}

#[tauri::command]
pub(crate) fn coedit_integration_remove() -> Result<Plan, String> {
    remove(&home()?, &crate::mcp::executable()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXE: &str = "/Applications/Sodilaud.app/Contents/MacOS/sodilaud";

    fn home() -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "sodilaud-integration-{}",
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(directory.join(".claude")).unwrap();
        directory
    }

    fn settings(home: &Path) -> Value {
        serde_json::from_slice(&fs::read(home.join(".claude/settings.json")).unwrap()).unwrap()
    }

    #[test]
    fn installs_into_an_empty_home_and_reinstalls_without_duplicates() {
        let home = home();
        let before = plan(&home, EXE).unwrap();
        assert!(!before.installed && !before.present);
        assert_eq!(before.changes.len(), 3);
        assert!(before.changes[2].starts_with("Create ~/.claude/settings.json"));
        let after = install(&home, EXE).unwrap();
        assert!(after.installed, "{:?}", after.changes);
        assert_eq!(
            fs::read_to_string(home.join(".claude/commands/sodilaud.md")).unwrap(),
            COMMAND
        );
        assert!(home.join(".claude/skills/sodilaud/SKILL.md").exists());
        assert!(
            !home.join(".claude/settings.json.bak").exists(),
            "nothing to back up"
        );
        let moved = plan(&home, "/elsewhere/sodilaud").unwrap();
        assert!(moved.present && !moved.installed);
        install(&home, "/elsewhere/sodilaud").unwrap();
        let hooks = &settings(&home)["hooks"]["PreToolUse"];
        assert_eq!(hooks.as_array().unwrap().len(), 1);
        assert_eq!(
            hooks[0]["hooks"][0]["command"],
            "\"/elsewhere/sodilaud\" --pretooluse-hook"
        );
        assert_eq!(hooks[0]["matcher"], MATCHER);
    }

    #[test]
    fn keeps_other_settings_and_hooks_in_order_and_backs_up() {
        let home = home();
        let original = r#"{
  "model": "opus",
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "check-bash" }] }
    ],
    "Stop": [{ "hooks": [{ "type": "command", "command": "notify" }] }]
  },
  "zeta": 1,
  "alpha": 2
}"#;
        fs::write(home.join(".claude/settings.json"), original).unwrap();
        install(&home, EXE).unwrap();
        assert_eq!(
            fs::read_to_string(home.join(".claude/settings.json.bak")).unwrap(),
            original
        );
        let merged = settings(&home);
        let keys: Vec<&String> = merged.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["model", "hooks", "zeta", "alpha"]);
        assert_eq!(merged["hooks"]["PreToolUse"].as_array().unwrap().len(), 2);
        assert_eq!(merged["hooks"]["Stop"][0]["hooks"][0]["command"], "notify");
        remove(&home, EXE).unwrap();
        let removed = settings(&home);
        assert_eq!(removed["hooks"]["PreToolUse"].as_array().unwrap().len(), 1);
        assert_eq!(removed["hooks"]["PreToolUse"][0]["matcher"], "Bash");
        assert_eq!(removed["model"], "opus");
        assert!(!home.join(".claude/commands/sodilaud.md").exists());
        assert!(!home.join(".claude/skills/sodilaud").exists());
    }

    #[test]
    fn removing_what_install_created_leaves_no_empty_hooks() {
        let home = home();
        fs::write(home.join(".claude/settings.json"), r#"{"model":"opus"}"#).unwrap();
        install(&home, EXE).unwrap();
        let plan = remove(&home, EXE).unwrap();
        assert!(!plan.installed);
        assert_eq!(settings(&home), json!({ "model": "opus" }));
    }

    #[test]
    fn invalid_settings_are_refused_untouched() {
        let home = home();
        let path = home.join(".claude/settings.json");
        for broken in [
            "{ not json",
            "[]",
            r#"{"hooks": []}"#,
            r#"{"hooks": {"PreToolUse": {}}}"#,
        ] {
            fs::write(&path, broken).unwrap();
            assert!(install(&home, EXE).is_err(), "{broken}");
            assert_eq!(fs::read_to_string(&path).unwrap(), broken);
            assert!(!home.join(".claude/commands/sodilaud.md").exists());
        }
        assert!(
            plan(&home, EXE).is_ok(),
            "a valid object with a bad shape still plans"
        );
    }

    #[test]
    fn bundled_text_names_the_tools_and_uses_no_em_dashes() {
        for text in [COMMAND, SKILL] {
            assert!(!text.contains('\u{2014}'));
            assert!(text.contains("mcp__sodilaud__") || text.contains("apply_edit"));
        }
        assert!(COMMAND.contains("$ARGUMENTS"));
        assert!(SKILL.starts_with("---\nname: sodilaud\n"));
    }
}
