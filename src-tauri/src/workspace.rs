// SPDX-License-Identifier: GPL-3.0-or-later
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

/// The database files the workspace commands may open. Only a native dialog
/// choice or the native preference file adds to it, so a script in the
/// webview cannot name an arbitrary file for SQLite to create or overwrite.
#[derive(Default)]
pub(crate) struct Workspaces(Mutex<HashSet<PathBuf>>);

impl Workspaces {
    pub(crate) fn authorize(&self, path: PathBuf) -> Result<(), String> {
        self.paths()?.insert(path);
        Ok(())
    }

    pub(crate) fn require(&self, db_path: &str) -> Result<(), String> {
        if self.paths()?.contains(Path::new(db_path)) {
            Ok(())
        } else {
            Err(
                "This workspace was not chosen in Sodilaud. Open it again from the Sodilaud menu."
                    .to_string(),
            )
        }
    }

    fn paths(&self) -> Result<MutexGuard<'_, HashSet<PathBuf>>, String> {
        self.0
            .lock()
            .map_err(|_| "Workspace state is poisoned".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::Workspaces;

    #[test]
    fn a_path_the_user_never_chose_is_rejected() {
        let workspaces = Workspaces::default();
        let outside = std::env::temp_dir().join("sodilaud-not-authorized.sqlite");
        assert!(workspaces.require(&outside.to_string_lossy()).is_err());
    }

    #[test]
    fn a_chosen_path_is_accepted_and_others_stay_rejected() {
        let workspaces = Workspaces::default();
        let chosen = std::env::temp_dir().join("sodilaud-chosen.sqlite");
        workspaces
            .authorize(chosen.clone())
            .expect("authorizing should succeed");
        assert!(workspaces.require(&chosen.to_string_lossy()).is_ok());
        let sibling = chosen.with_file_name("sodilaud-sibling.sqlite");
        assert!(workspaces.require(&sibling.to_string_lossy()).is_err());
    }
}
