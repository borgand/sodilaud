// SPDX-License-Identifier: GPL-3.0-or-later

// Whether agent access is on and which functions it allows, kept across restarts
// in `mcp.json` in app config. Only Rust reads and writes it.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

pub const FILE_NAME: &str = "mcp.json";

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct McpConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub permissions: BTreeMap<String, bool>,
    /// Owner comments wait for Send review instead of going to agents at once.
    #[serde(default, rename = "holdForReview")]
    pub hold_for_review: bool,
}

pub fn load(path: &Path) -> McpConfig {
    fs::read(path)
        .ok()
        .and_then(|contents| serde_json::from_slice(&contents).ok())
        .unwrap_or_default()
}

pub fn save(path: &Path, config: &McpConfig) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "The agent access settings path has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("Could not create the agent access settings directory: {e}"))?;
    let contents = serde_json::to_vec_pretty(config)
        .map_err(|e| format!("Could not serialize the agent access settings: {e}"))?;
    fs::write(path, contents)
        .map_err(|e| format!("Could not save the agent access settings: {e}"))?;
    crate::restrict_to_owner(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("sodilaud-mcp-config-{name}-{nanos}"));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    fn a_missing_or_damaged_file_gives_defaults() {
        let path = scratch("defaults").join(FILE_NAME);
        assert_eq!(load(&path), McpConfig::default());
        fs::write(&path, b"{").unwrap();
        assert_eq!(load(&path), McpConfig::default());
    }

    #[test]
    fn saves_and_loads_owner_only() {
        let path = scratch("round-trip").join("nested").join(FILE_NAME);
        let config = McpConfig {
            enabled: true,
            permissions: [("create_note".to_string(), true)].into(),
            hold_for_review: true,
        };
        save(&path, &config).unwrap();
        assert_eq!(load(&path), config);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
}
