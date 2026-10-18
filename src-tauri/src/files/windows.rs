// SPDX-License-Identifier: GPL-3.0-or-later

// The main windows and which one has which file open. Pure bookkeeping: no
// windows are created here. A path belongs to at most one window.

// Nothing outside the tests uses the set until the files module adopts it.
#![allow(dead_code)]

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
        });
        self.focus.insert(0, label.clone());
        label
    }

    pub fn remove(&mut self, label: &str) -> Vec<String> {
        if self.windows.len() < 2 {
            return Vec::new();
        }
        let Some(index) = self.windows.iter().position(|w| w.label == label) else {
            return Vec::new();
        };
        self.focus.retain(|l| l != label);
        self.windows.remove(index).open
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

    pub fn claim(&mut self, label: &str, path: &str) -> Claim {
        match self.owner(path) {
            Some(owner) if owner == label => Claim::Mine,
            Some(owner) => Claim::Elsewhere(owner),
            None => {
                if let Some(entry) = self.entry_mut(label) {
                    entry.open.push(path.to_string());
                }
                Claim::Mine
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

    pub fn route(&mut self, paths: &[String]) -> Vec<(String, Vec<String>)> {
        let mut groups: Vec<(String, Vec<String>)> = Vec::new();
        for path in paths {
            let label = match self.owner(path) {
                Some(owner) => owner,
                None => {
                    let target = self.target();
                    self.claim(&target, path);
                    target
                }
            };
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

    pub fn saved(&self) -> Vec<SavedWindow> {
        self.windows
            .iter()
            .map(|w| SavedWindow {
                open: w.open.clone(),
                active: w.active.clone(),
                frame: w.frame,
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
        assert!(set.remove("main").is_empty());
        assert_eq!(set.labels(), ["main"]);
    }

    #[test]
    fn a_path_belongs_to_one_window() {
        let mut set = WindowSet::from_saved(vec![saved(&["/a.md"]), saved(&[])]);
        assert_eq!(
            set.claim("main-2", "/a.md"),
            Claim::Elsewhere("main".into())
        );
        assert_eq!(set.claim("main-2", "/b.md"), Claim::Mine);
        assert_eq!(set.owner("/b.md").as_deref(), Some("main-2"));
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
        assert_eq!(set.owner("/new.md").as_deref(), Some("main-2"));
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
}
