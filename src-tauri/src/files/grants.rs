// SPDX-License-Identifier: GPL-3.0-or-later

// The files the main window may read and write. Only a native dialog, Finder's
// "Open With", or a file the user opened in an earlier session adds to it, so a
// script in the webview cannot name an arbitrary path. Paths are compared after
// resolving `..` and symbolic links.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use super::FileError;

/// The canonical form of `path`; for a file that does not exist yet, its
/// canonical parent directory joined with its name.
pub fn canonical(path: &Path) -> Result<PathBuf, FileError> {
    if let Ok(resolved) = path.canonicalize() {
        return Ok(resolved);
    }
    let name = path.file_name().ok_or_else(|| FileError::not_found(path))?;
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| FileError::not_found(path))?;
    let parent = parent
        .canonicalize()
        .map_err(|_| FileError::not_found(path))?;
    Ok(parent.join(name))
}

#[derive(Default)]
pub struct Grants(HashSet<PathBuf>);

impl Grants {
    pub fn grant(&mut self, path: &Path) -> Result<PathBuf, FileError> {
        let resolved = canonical(path)?;
        self.0.insert(resolved.clone());
        Ok(resolved)
    }

    pub fn require(&self, path: &Path) -> Result<PathBuf, FileError> {
        let resolved = canonical(path).map_err(|_| FileError::not_granted(path))?;
        if self.0.contains(&resolved) {
            Ok(resolved)
        } else {
            Err(FileError::not_granted(path))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::FileErrorCode;
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("sodilaud-grants-{name}-{nanos}"));
        fs::create_dir_all(&directory).unwrap();
        directory.canonicalize().unwrap()
    }

    #[test]
    fn only_a_granted_file_is_allowed() {
        let directory = scratch("basic");
        let chosen = directory.join("chosen.md");
        let other = directory.join("other.md");
        fs::write(&chosen, "a").unwrap();
        fs::write(&other, "b").unwrap();
        let mut grants = Grants::default();
        grants.grant(&chosen).unwrap();
        assert_eq!(grants.require(&chosen).unwrap(), chosen);
        assert_eq!(
            grants.require(&other).unwrap_err().code,
            FileErrorCode::NotGranted
        );
    }

    #[test]
    fn dot_dot_cannot_reach_an_ungranted_file() {
        let directory = scratch("dotdot");
        fs::create_dir_all(directory.join("sub")).unwrap();
        let chosen = directory.join("sub/chosen.md");
        fs::write(&chosen, "a").unwrap();
        fs::write(directory.join("secret.md"), "s").unwrap();
        let mut grants = Grants::default();
        grants.grant(&chosen).unwrap();
        assert!(grants.require(&directory.join("sub/../sub/chosen.md")).is_ok());
        assert_eq!(
            grants
                .require(&directory.join("sub/../secret.md"))
                .unwrap_err()
                .code,
            FileErrorCode::NotGranted
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symbolic_link_to_an_ungranted_file_is_refused() {
        let directory = scratch("symlink");
        let chosen = directory.join("chosen.md");
        let secret = directory.join("secret.md");
        fs::write(&chosen, "a").unwrap();
        fs::write(&secret, "s").unwrap();
        let link = directory.join("link.md");
        std::os::unix::fs::symlink(&secret, &link).unwrap();
        let mut grants = Grants::default();
        grants.grant(&chosen).unwrap();
        assert_eq!(
            grants.require(&link).unwrap_err().code,
            FileErrorCode::NotGranted
        );
    }

    #[test]
    fn a_file_saved_under_a_new_name_can_be_granted_before_it_exists() {
        let directory = scratch("new");
        let fresh = directory.join("fresh.md");
        let mut grants = Grants::default();
        grants.grant(&fresh).unwrap();
        fs::write(&fresh, "x").unwrap();
        assert!(grants.require(&fresh).is_ok());
    }
}
