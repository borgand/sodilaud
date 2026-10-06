// SPDX-License-Identifier: GPL-3.0-or-later

//! Comments on files, kept in app data rather than beside the file, one JSON
//! file per commented file, named by a hash of its path. The path is kept
//! inside too, so a file is never handed comments that belong to another.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::docs::comments::Comment;

pub(crate) const DIRECTORY: &str = "comments";

#[derive(Serialize, Deserialize)]
struct Stored {
    path: String,
    comments: Vec<Comment>,
}

pub(crate) fn file_for(directory: &Path, path: &Path) -> PathBuf {
    let digest = Sha256::digest(path.to_string_lossy().as_bytes());
    let name: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    directory.join(format!("{name}.json"))
}

/// The comments stored for `path`, or none when there are none or they cannot be read.
pub(crate) fn load(directory: &Path, path: &Path) -> Vec<Comment> {
    fs::read(file_for(directory, path))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Stored>(&bytes).ok())
        .filter(|stored| Path::new(&stored.path) == path)
        .map(|stored| stored.comments)
        .unwrap_or_default()
}

/// Writes the comments for `path` atomically and owner-only. No comments
/// removes the file.
pub(crate) fn save(directory: &Path, path: &Path, comments: &[Comment]) -> Result<(), String> {
    let target = file_for(directory, path);
    if comments.is_empty() {
        return match fs::remove_file(&target) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                Err(format!("Could not remove saved comments: {error}"))
            }
            _ => Ok(()),
        };
    }
    fs::create_dir_all(directory)
        .map_err(|e| format!("Could not create the comments folder: {e}"))?;
    let stored = Stored {
        path: path.to_string_lossy().into_owned(),
        comments: comments.to_vec(),
    };
    let bytes = serde_json::to_vec_pretty(&stored).map_err(|e| e.to_string())?;
    let temporary = target.with_extension(format!("json.{}.tmp", uuid::Uuid::new_v4().simple()));
    fs::write(&temporary, bytes).map_err(|e| format!("Could not save comments: {e}"))?;
    crate::restrict_to_owner(&temporary)?;
    fs::rename(&temporary, &target).map_err(|e| {
        let _ = fs::remove_file(&temporary);
        format!("Could not save comments: {e}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::docs::comments::{Author, State};

    fn scratch(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("sodilaud-comments-{name}-{nanos}"))
    }

    #[test]
    fn round_trips_by_path_and_removes_an_empty_list() {
        let directory = scratch("round-trip");
        let path = Path::new("/notes/spec.md");
        let comment = Comment::new(
            Author::Owner,
            State::Held,
            "abc",
            (0, 2),
            "b".into(),
            None,
            1,
        );
        save(&directory, path, std::slice::from_ref(&comment)).unwrap();
        assert_eq!(load(&directory, path), vec![comment]);
        assert!(load(&directory, Path::new("/notes/other.md")).is_empty());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(file_for(&directory, path))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        save(&directory, path, &[]).unwrap();
        assert!(!file_for(&directory, path).exists());
        save(&directory, path, &[]).unwrap();
    }

    #[test]
    fn a_damaged_or_foreign_file_gives_no_comments() {
        let directory = scratch("damaged");
        let path = Path::new("/notes/spec.md");
        fs::create_dir_all(&directory).unwrap();
        fs::write(file_for(&directory, path), b"{").unwrap();
        assert!(load(&directory, path).is_empty());
        fs::write(
            file_for(&directory, path),
            br#"{"path":"/elsewhere.md","comments":[]}"#,
        )
        .unwrap();
        assert!(load(&directory, path).is_empty());
    }
}
