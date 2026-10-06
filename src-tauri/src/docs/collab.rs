// SPDX-License-Identifier: GPL-3.0-or-later

//! The text half of a document every editor edits through the
//! `@codemirror/collab` protocol: the text, its version, and the recent
//! updates a client that fell behind pulls to catch up. Notes and files both
//! keep one.

use std::collections::VecDeque;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::changes;
use super::comments::{self, Comment};

/// Updates kept per document for clients that fell behind. An older client reloads.
pub(crate) const HISTORY: usize = 1000;
/// Texts kept per document for agents' edits to be merged against.
pub(crate) const BASES: usize = 8;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct Update {
    #[serde(rename = "clientID")]
    pub(crate) client_id: String,
    pub(crate) changes: Value,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Pushed {
    pub(crate) accepted: bool,
    pub(crate) version: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Pulled {
    Updates(Vec<Update>),
    Reload { text: String, version: u64 },
}

#[derive(Clone, Debug)]
pub(crate) struct Collab {
    text: String,
    version: u64,
    updates: VecDeque<Update>,
    /// Comments on this text, mapped through every update.
    pub(crate) comments: Vec<Comment>,
    /// Grows whenever a comment changes, so the owner knows to save and show them.
    pub(crate) comments_rev: u64,
    /// Texts an agent read, by version: what its edits are written against.
    bases: VecDeque<(u64, String)>,
    /// An agent read or commented on this document since it was opened.
    pub(crate) co_edited: bool,
}

impl Collab {
    pub(crate) fn new(text: String) -> Self {
        Self {
            text,
            version: 0,
            updates: VecDeque::new(),
            comments: Vec::new(),
            comments_rev: 0,
            bases: VecDeque::new(),
            co_edited: false,
        }
    }

    /// Takes stored comments and places each in the current text.
    pub(crate) fn load_comments(&mut self, mut loaded: Vec<Comment>) {
        for comment in &mut loaded {
            if !comment.is_resolved() {
                comments::reanchor(comment, &self.text);
            }
        }
        self.comments = loaded;
        self.comments_rev += 1;
    }

    pub(crate) fn comments_changed(&mut self) {
        self.comments_rev += 1;
    }

    /// Remembers the current text as a merge base and returns its version.
    pub(crate) fn snapshot_base(&mut self) -> u64 {
        if self.bases.back().map(|(version, _)| *version) != Some(self.version) {
            self.bases.push_back((self.version, self.text.clone()));
            while self.bases.len() > BASES {
                self.bases.pop_front();
            }
        }
        self.version
    }

    pub(crate) fn base(&self, version: u64) -> Option<&str> {
        self.bases
            .iter()
            .find(|(found, _)| *found == version)
            .map(|(_, text)| text.as_str())
    }

    /// The updates since `version`, or `None` when they are no longer kept.
    pub(crate) fn since(&self, version: u64) -> Option<Vec<Update>> {
        match self.pull(version) {
            Ok(Pulled::Updates(updates)) => Some(updates),
            _ => None,
        }
    }

    pub(crate) fn text(&self) -> &str {
        &self.text
    }

    pub(crate) fn version(&self) -> u64 {
        self.version
    }

    /// The text after `updates`, leaving the document as it is, so the caller
    /// can persist the result before it calls `commit`.
    pub(crate) fn apply(&self, updates: &[Update]) -> Result<String, String> {
        let mut text = self.text.clone();
        for update in updates {
            text = changes::apply(&text, &update.changes)?;
        }
        Ok(text)
    }

    /// Makes `text`, the result of `apply(&updates)`, current. Returns the
    /// version the first update applies to.
    pub(crate) fn commit(&mut self, text: String, updates: Vec<Update>) -> u64 {
        let from = self.version;
        if !self.comments.is_empty() {
            let sections: Vec<_> = updates
                .iter()
                .filter_map(|update| changes::sections(&update.changes).ok())
                .collect();
            if comments::map_through(&mut self.comments, &sections, &text) {
                self.comments_rev += 1;
            }
        }
        self.text = text;
        self.version += updates.len() as u64;
        self.updates.extend(updates);
        while self.updates.len() > HISTORY {
            self.updates.pop_front();
        }
        from
    }

    /// Replaces the whole text as one update from `client_id`, changing only
    /// what differs. Returns the version it applies to and the update, or
    /// `None` when the text is already `text`.
    pub(crate) fn replace(&mut self, client_id: &str, text: &str) -> Option<(u64, Vec<Update>)> {
        if self.text == text {
            return None;
        }
        let updates = vec![Update {
            client_id: client_id.to_string(),
            changes: changes::diff(&self.text, text),
        }];
        let from = self.commit(text.to_string(), updates.clone());
        Some((from, updates))
    }

    pub(crate) fn pull(&self, since: u64) -> Result<Pulled, String> {
        if since > self.version {
            return Err("The client is ahead of the registry; reload the document".into());
        }
        let behind = (self.version - since) as usize;
        if behind <= self.updates.len() {
            let skip = self.updates.len() - behind;
            Ok(Pulled::Updates(
                self.updates.iter().skip(skip).cloned().collect(),
            ))
        } else {
            Ok(Pulled::Reload {
                text: self.text.clone(),
                version: self.version,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::docs::changes;
    use serde_json::json;

    fn update(client: &str, changes: Value) -> Update {
        Update {
            client_id: client.into(),
            changes,
        }
    }

    #[test]
    fn apply_previews_and_commit_advances_the_version() {
        let mut collab = Collab::new("ab".into());
        let updates = vec![update("c", json!([2, [0, "c"]]))];
        let text = collab.apply(&updates).unwrap();
        assert_eq!(text, "abc");
        assert_eq!((collab.text(), collab.version()), ("ab", 0));
        assert_eq!(collab.commit(text, updates.clone()), 0);
        assert_eq!((collab.text(), collab.version()), ("abc", 1));
        assert_eq!(collab.pull(0).unwrap(), Pulled::Updates(updates));
        assert_eq!(collab.pull(1).unwrap(), Pulled::Updates(vec![]));
        assert!(collab.pull(2).is_err());
        assert!(collab.apply(&[update("c", json!([9]))]).is_err());
    }

    #[test]
    fn replacing_the_text_sends_a_minimal_update() {
        let mut collab = Collab::new("one\ntwo\n".into());
        assert_eq!(collab.replace("disk", "one\ntwo\n"), None);
        let (from, updates) = collab.replace("disk", "one\n2\n").unwrap();
        assert_eq!(from, 0);
        assert_eq!(updates, vec![update("disk", json!([4, [3, "2"], 1]))]);
        assert_eq!((collab.text(), collab.version()), ("one\n2\n", 1));
    }

    #[test]
    fn keeps_eight_bases_and_maps_comments_on_every_commit() {
        use crate::docs::comments::{Author, Comment, State};
        let mut collab = Collab::new("hello world".into());
        let comment = Comment::new(
            Author::Owner,
            State::Queued,
            collab.text(),
            (6, 11),
            "b".into(),
            None,
            0,
        );
        collab.load_comments(vec![comment]);
        assert_eq!(collab.snapshot_base(), 0);
        let rev = collab.comments_rev;
        let updates = vec![update("c", json!([[0, ">> "], 11]))];
        let text = collab.apply(&updates).unwrap();
        collab.commit(text, updates);
        assert!(collab.comments_rev > rev);
        assert_eq!((collab.comments[0].from, collab.comments[0].to), (9, 14));
        assert_eq!(collab.base(0), Some("hello world"));
        assert_eq!(collab.since(0).unwrap().len(), 1);
        for _ in 0..10 {
            let updates = vec![update("c", changes::append(collab.text(), "!"))];
            let text = collab.apply(&updates).unwrap();
            collab.commit(text, updates);
            collab.snapshot_base();
        }
        assert_eq!(collab.base(0), None, "only the last eight are kept");
        assert!(collab.base(collab.version()).is_some());
    }

    #[test]
    fn a_client_older_than_the_history_reloads() {
        let mut collab = Collab::new(String::new());
        for _ in 0..(HISTORY + 1) {
            let updates = vec![update("c", changes::append(collab.text(), "x"))];
            let text = collab.apply(&updates).unwrap();
            collab.commit(text, updates);
        }
        assert_eq!(
            collab.pull(0).unwrap(),
            Pulled::Reload {
                text: "x".repeat(HISTORY + 1),
                version: HISTORY as u64 + 1
            }
        );
        assert!(matches!(collab.pull(1).unwrap(), Pulled::Updates(u) if u.len() == HISTORY));
    }
}
