// SPDX-License-Identifier: GPL-3.0-or-later

// The main windows and which one has which file open. Pure bookkeeping: no
// windows are created here. A path belongs to at most one window.

use std::path::Path;

use super::store::SavedWindow;
use crate::quicknotes::config::Frame;

pub const MAIN_LABEL: &str = "main";

pub fn is_main_label(label: &str) -> bool {
    label == MAIN_LABEL
        || label
            .strip_prefix("main-")
            .is_some_and(|number| !number.is_empty() && number.bytes().all(|b| b.is_ascii_digit()))
}

fn label_for(number: u32) -> String {
    if number == 1 {
        MAIN_LABEL.to_string()
    } else {
        format!("{MAIN_LABEL}-{number}")
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct WindowEntry {
    pub label: String,
    pub open: Vec<String>,
    pub active: Option<String>,
    pub frame: Option<Frame>,
    pub folders: Vec<String>,
    pub expanded: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Claim {
    Mine,
    Elsewhere(String),
}

pub struct WindowSet {
    windows: Vec<WindowEntry>,
    /// Labels, most recently focused first.
    focus: Vec<String>,
    /// The number the next added window gets; never reused in a session.
    next: u32,
}

impl WindowSet {
    pub fn from_saved(saved: Vec<SavedWindow>) -> Self {
        let saved = if saved.is_empty() {
            vec![SavedWindow::default()]
        } else {
            saved
        };
        let windows: Vec<WindowEntry> = saved
            .into_iter()
            .enumerate()
            .map(|(index, window)| WindowEntry {
                label: label_for(index as u32 + 1),
                open: window.open,
                active: window.active,
                frame: window.frame,
                folders: window.folders,
                expanded: window.expanded,
            })
            .collect();
        let mut set = Self {
            focus: windows.iter().map(|w| w.label.clone()).collect(),
            next: windows.len() as u32 + 1,
            windows,
        };
        // Hand-edited or damaged files may list a path twice.
        for label in set.labels() {
            if let Some(entry) = set.entry(&label) {
                let (open, active) = (entry.open.clone(), entry.active.clone());
                set.set_open(&label, open, active);
            }
        }
        set
    }

    pub fn labels(&self) -> Vec<String> {
        self.windows.iter().map(|w| w.label.clone()).collect()
    }

    pub fn entry(&self, label: &str) -> Option<&WindowEntry> {
        self.windows.iter().find(|w| w.label == label)
    }

    fn entry_mut(&mut self, label: &str) -> Option<&mut WindowEntry> {
        self.windows.iter_mut().find(|w| w.label == label)
    }

    pub fn number(&self, label: &str) -> Option<usize> {
        self.windows
            .iter()
            .position(|w| w.label == label)
            .map(|index| index + 1)
    }

    pub fn add(&mut self) -> String {
        let label = label_for(self.next);
        self.next += 1;
        self.windows.push(WindowEntry {
            label: label.clone(),
            open: Vec::new(),
            active: None,
            frame: None,
            folders: Vec::new(),
            expanded: Vec::new(),
        });
        self.focus.insert(0, label.clone());
        label
    }

    /// Removes a window and returns its open files, or `None` when the window
    /// is unknown or is the last one, which always stays.
    pub fn remove(&mut self, label: &str) -> Option<Vec<String>> {
        if self.windows.len() < 2 {
            return None;
        }
        let index = self.windows.iter().position(|w| w.label == label)?;
        self.focus.retain(|l| l != label);
        Some(self.windows.remove(index).open)
    }

    /// Removes a window and hands its open files to the focused window that
    /// remains. Returns that window, or `None` when nothing was removed.
    pub fn fold_into_target(&mut self, label: &str) -> Option<String> {
        let (folders, expanded) = self
            .entry(label)
            .map(|entry| (entry.folders.clone(), entry.expanded.clone()))?;
        let open = self.remove(label)?;
        let target = self.target();
        for path in open {
            self.claim(&target, &path);
        }
        if let Some(entry) = self.entry_mut(&target) {
            for root in folders {
                if !entry.folders.contains(&root) {
                    entry.folders.push(root);
                }
            }
            for folder in expanded {
                if !entry.expanded.contains(&folder) {
                    entry.expanded.push(folder);
                }
            }
        }
        Some(target)
    }

    pub fn focused(&mut self, label: &str) {
        if self.entry(label).is_none() {
            return;
        }
        self.focus.retain(|l| l != label);
        self.focus.insert(0, label.to_string());
    }

    pub fn target(&self) -> String {
        self.focus
            .first()
            .cloned()
            .unwrap_or_else(|| MAIN_LABEL.to_string())
    }

    pub fn owner(&self, path: &str) -> Option<String> {
        self.windows
            .iter()
            .find(|w| w.open.iter().any(|open| open == path))
            .map(|w| w.label.clone())
    }

    /// `None` when `label` is not a window in the set.
    pub fn claim(&mut self, label: &str, path: &str) -> Option<Claim> {
        match self.owner(path) {
            Some(owner) if owner == label => Some(Claim::Mine),
            Some(owner) => Some(Claim::Elsewhere(owner)),
            None => {
                self.entry_mut(label)?.open.push(path.to_string());
                Some(Claim::Mine)
            }
        }
    }

    pub fn set_open(&mut self, label: &str, paths: Vec<String>, active: Option<String>) {
        if self.entry(label).is_none() {
            return;
        }
        let mut kept: Vec<String> = Vec::new();
        for path in paths {
            let owned_elsewhere = self.owner(&path).is_some_and(|owner| owner != label);
            if !owned_elsewhere && !kept.contains(&path) {
                kept.push(path);
            }
        }
        let active = active.filter(|path| kept.contains(path));
        if let Some(entry) = self.entry_mut(label) {
            entry.open = kept;
            entry.active = active;
        }
    }

    pub fn move_to(&mut self, path: &str, to: &str) -> Result<(), String> {
        if self.entry(to).is_none() {
            return Err("That window is closed.".to_string());
        }
        for entry in &mut self.windows {
            if entry.label != to {
                entry.open.retain(|open| open != path);
                if entry.active.as_deref() == Some(path) {
                    entry.active = None;
                }
            }
        }
        if let Some(entry) = self.entry_mut(to) {
            if !entry.open.iter().any(|open| open == path) {
                entry.open.push(path.to_string());
            }
            entry.active = Some(path.to_string());
        }
        Ok(())
    }

    /// Groups `paths` by the window that should show them: the owner, or the
    /// focused window. Nothing is claimed; the window claims a file when its
    /// page opens it, so a file that fails to open is never left owned.
    pub fn route(&self, paths: &[String]) -> Vec<(String, Vec<String>)> {
        let mut groups: Vec<(String, Vec<String>)> = Vec::new();
        for path in paths {
            let label = self.owner(path).unwrap_or_else(|| self.target());
            match groups.iter_mut().find(|(group, _)| *group == label) {
                Some((_, group)) => group.push(path.clone()),
                None => groups.push((label, vec![path.clone()])),
            }
        }
        groups
    }

    pub fn all_open(&self) -> Vec<String> {
        self.windows.iter().flat_map(|w| w.open.clone()).collect()
    }

    pub fn set_frame(&mut self, label: &str, frame: Frame) {
        if let Some(entry) = self.entry_mut(label) {
            entry.frame = Some(frame);
        }
    }

    // The folder allows below are removed when the folder commands land.
    /// Appends `root` (canonical) and expands it; false when the window is unknown or already has it.
    #[allow(dead_code)]
    pub fn add_folder(&mut self, label: &str, root: &str) -> bool {
        let Some(entry) = self.entry_mut(label) else {
            return false;
        };
        if entry.folders.iter().any(|folder| folder == root) {
            return false;
        }
        entry.folders.push(root.to_string());
        if !entry.expanded.iter().any(|folder| folder == root) {
            entry.expanded.push(root.to_string());
        }
        true
    }

    /// Removes the root and every expanded path under it.
    #[allow(dead_code)]
    pub fn remove_folder(&mut self, label: &str, root: &str) {
        if let Some(entry) = self.entry_mut(label) {
            entry.folders.retain(|folder| folder != root);
            entry
                .expanded
                .retain(|folder| !Path::new(folder).starts_with(root));
        }
    }

    #[allow(dead_code)]
    pub fn folders(&self, label: &str) -> Vec<String> {
        self.entry(label)
            .map(|entry| entry.folders.clone())
            .unwrap_or_default()
    }

    /// Keeps only paths equal to or below one of the window's roots (component-wise prefix), without
    /// duplicates, in the given order.
    #[allow(dead_code)]
    pub fn set_expanded(&mut self, label: &str, paths: Vec<String>) {
        let Some(entry) = self.entry_mut(label) else {
            return;
        };
        let mut kept: Vec<String> = Vec::new();
        for path in paths {
            let inside = entry
                .folders
                .iter()
                .any(|root| Path::new(&path).starts_with(root));
            if inside && !kept.contains(&path) {
                kept.push(path);
            }
        }
        entry.expanded = kept;
    }

    /// Roots then expanded folders of every window, window order, without duplicates, at most `limit`.
    #[allow(dead_code)]
    pub fn watched_folders(&self, limit: usize) -> Vec<String> {
        let mut watched: Vec<String> = Vec::new();
        for entry in &self.windows {
            for folder in entry.folders.iter().chain(&entry.expanded) {
                if !watched.contains(folder) {
                    watched.push(folder.clone());
                }
            }
        }
        watched.truncate(limit);
        watched
    }

    pub fn saved(&self) -> Vec<SavedWindow> {
        self.windows
            .iter()
            .map(|w| SavedWindow {
                open: w.open.clone(),
                active: w.active.clone(),
                frame: w.frame,
                folders: w.folders.clone(),
                expanded: w.expanded.clone(),
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn saved(paths: &[&str]) -> SavedWindow {
        SavedWindow {
            open: paths.iter().map(|p| p.to_string()).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn main_labels_are_main_and_numbered() {
        for ok in ["main", "main-2", "main-15"] {
            assert!(is_main_label(ok));
        }
        for no in [
            "quicknotes",
            "clipboard",
            "main-",
            "main-x",
            "main2",
            "mainly",
        ] {
            assert!(!is_main_label(no));
        }
    }

    #[test]
    fn saved_windows_map_onto_main_then_numbered_labels() {
        let set = WindowSet::from_saved(vec![saved(&["/a.md"]), saved(&[]), saved(&["/b.md"])]);
        assert_eq!(set.labels(), ["main", "main-2", "main-3"]);
        assert_eq!(set.target(), "main");
        assert_eq!(WindowSet::from_saved(vec![]).labels(), ["main"]);
    }

    #[test]
    fn added_windows_never_reuse_a_label_and_take_focus() {
        let mut set = WindowSet::from_saved(vec![]);
        let second = set.add();
        assert_eq!(second, "main-2");
        assert_eq!(set.target(), "main-2");
        set.remove("main-2");
        assert_eq!(set.add(), "main-3");
    }

    #[test]
    fn the_last_window_cannot_be_removed() {
        let mut set = WindowSet::from_saved(vec![saved(&["/a.md"])]);
        assert_eq!(set.remove("main"), None);
        assert_eq!(set.labels(), ["main"]);
    }

    #[test]
    fn a_window_folded_away_hands_its_files_to_the_focused_one() {
        let mut set = WindowSet::from_saved(vec![
            saved(&["/a.md"]),
            saved(&["/b.md", "/c.md"]),
            saved(&["/d.md"]),
        ]);
        set.focused("main-3");
        set.focused("main-2");
        assert_eq!(set.fold_into_target("main-2").as_deref(), Some("main-3"));
        assert_eq!(set.labels(), ["main", "main-3"]);
        assert_eq!(
            set.entry("main-3").unwrap().open,
            ["/d.md", "/b.md", "/c.md"]
        );
        assert_eq!(set.owner("/b.md").as_deref(), Some("main-3"));
        assert_eq!(set.fold_into_target("main-9"), None);
        set.fold_into_target("main-3");
        assert_eq!(set.fold_into_target("main"), None, "the last window stays");
        assert_eq!(set.entry("main").unwrap().open.len(), 4);
    }

    #[test]
    fn a_path_belongs_to_one_window() {
        let mut set = WindowSet::from_saved(vec![saved(&["/a.md"]), saved(&[])]);
        assert_eq!(
            set.claim("main-2", "/a.md"),
            Some(Claim::Elsewhere("main".into()))
        );
        assert_eq!(set.claim("main-2", "/b.md"), Some(Claim::Mine));
        assert_eq!(set.owner("/b.md").as_deref(), Some("main-2"));
        assert_eq!(set.claim("main-9", "/c.md"), None);
        assert_eq!(set.owner("/c.md"), None);
    }

    #[test]
    fn moving_keeps_exactly_one_owner() {
        let mut set = WindowSet::from_saved(vec![saved(&["/a.md", "/b.md"]), saved(&[])]);
        set.move_to("/a.md", "main-2").unwrap();
        assert_eq!(set.entry("main").unwrap().open, ["/b.md"]);
        assert_eq!(set.entry("main-2").unwrap().open, ["/a.md"]);
        assert_eq!(
            set.entry("main-2").unwrap().active.as_deref(),
            Some("/a.md")
        );
        assert_eq!(
            set.move_to("/b.md", "main-9").unwrap_err(),
            "That window is closed."
        );
    }

    #[test]
    fn a_stale_open_list_cannot_take_back_a_moved_file() {
        let mut set = WindowSet::from_saved(vec![saved(&["/a.md", "/b.md"]), saved(&[])]);
        set.move_to("/a.md", "main-2").unwrap();
        set.set_open(
            "main",
            vec!["/a.md".into(), "/b.md".into()],
            Some("/a.md".into()),
        );
        assert_eq!(set.entry("main").unwrap().open, ["/b.md"]);
        assert_eq!(set.entry("main").unwrap().active, None);
    }

    #[test]
    fn outside_opens_go_to_the_owner_or_the_focused_window() {
        let mut set = WindowSet::from_saved(vec![saved(&["/a.md"]), saved(&[])]);
        set.focused("main-2");
        assert_eq!(
            set.route(&["/a.md".into(), "/new.md".into()]),
            vec![
                ("main".to_string(), vec!["/a.md".to_string()]),
                ("main-2".to_string(), vec!["/new.md".to_string()])
            ]
        );
        assert_eq!(set.owner("/new.md"), None, "claimed only once it opens");
    }

    #[test]
    fn a_removed_window_receives_no_routed_opens() {
        let mut set = WindowSet::from_saved(vec![saved(&["/a.md"]), saved(&["/b.md"])]);
        set.focused("main-2");
        set.remove("main-2");
        let routed = set.route(&["/a.md".into(), "/b.md".into(), "/new.md".into()]);
        assert!(routed.iter().all(|(label, _)| label == "main"));
    }

    #[test]
    fn saved_keeps_window_order_and_frames() {
        let mut set = WindowSet::from_saved(vec![saved(&["/a.md"]), saved(&["/b.md"])]);
        let frame = Frame {
            x: 10.0,
            y: 20.0,
            width: 960.0,
            height: 680.0,
        };
        set.set_frame("main-2", frame);
        set.set_open("main", vec!["/a.md".into()], Some("/a.md".into()));
        let out = set.saved();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].open, ["/a.md"]);
        assert_eq!(out[0].active.as_deref(), Some("/a.md"));
        assert_eq!(out[0].frame, None);
        assert_eq!(out[1].open, ["/b.md"]);
        assert_eq!(out[1].frame, Some(frame));
    }

    #[test]
    fn each_window_keeps_its_own_folders() {
        let mut set = WindowSet::from_saved(vec![saved(&[]), saved(&[])]);
        assert!(set.add_folder("main", "/r"));
        assert!(set.add_folder("main-2", "/r"));
        assert!(!set.add_folder("main", "/r"));
        assert!(!set.add_folder("main-9", "/r"));
        assert_eq!(set.folders("main"), ["/r"]);
        assert_eq!(set.entry("main").unwrap().expanded, ["/r"]);
    }

    #[test]
    fn expanded_folders_must_lie_in_a_root() {
        let mut set = WindowSet::from_saved(vec![saved(&[])]);
        set.add_folder("main", "/r");
        set.set_expanded(
            "main",
            vec![
                "/r/a".into(),
                "/elsewhere".into(),
                "/r/a".into(),
                "/rx".into(),
            ],
        );
        assert_eq!(set.entry("main").unwrap().expanded, ["/r/a"]);
    }

    #[test]
    fn removing_a_root_drops_its_expanded_folders() {
        let mut set = WindowSet::from_saved(vec![saved(&[])]);
        set.add_folder("main", "/r");
        set.add_folder("main", "/s");
        set.set_expanded("main", vec!["/r".into(), "/r/a".into(), "/s".into()]);
        set.remove_folder("main", "/r");
        assert_eq!(set.folders("main"), ["/s"]);
        assert_eq!(set.entry("main").unwrap().expanded, ["/s"]);
    }

    #[test]
    fn watched_folders_are_the_union_capped() {
        let mut set = WindowSet::from_saved(vec![saved(&[]), saved(&[])]);
        set.add_folder("main", "/r");
        set.add_folder("main-2", "/r");
        set.set_expanded("main", vec!["/r".into(), "/r/a".into()]);
        set.set_expanded("main-2", vec!["/r".into(), "/r/b".into()]);
        assert_eq!(set.watched_folders(2), ["/r", "/r/a"]);
        assert_eq!(set.watched_folders(10), ["/r", "/r/a", "/r/b"]);
    }

    #[test]
    fn a_failed_window_hands_its_folders_on() {
        let mut set = WindowSet::from_saved(vec![saved(&[]), saved(&[])]);
        set.add_folder("main", "/r");
        set.add_folder("main-2", "/r");
        set.add_folder("main-2", "/s");
        set.set_expanded("main-2", vec!["/s/x".into()]);
        set.focused("main");
        assert_eq!(set.fold_into_target("main-2").as_deref(), Some("main"));
        let main = set.entry("main").unwrap();
        assert_eq!(main.folders, ["/r", "/s"]);
        assert_eq!(main.expanded, ["/r", "/s/x"]);
    }

    #[test]
    fn folders_survive_saving() {
        let mut set = WindowSet::from_saved(vec![saved(&[])]);
        set.add_folder("main", "/r");
        set.set_expanded("main", vec!["/r/a".into()]);
        let out = set.saved();
        assert_eq!(out[0].folders, ["/r"]);
        assert_eq!(out[0].expanded, ["/r/a"]);
        let again = WindowSet::from_saved(out);
        assert_eq!(again.folders("main"), ["/r"]);
    }
}
