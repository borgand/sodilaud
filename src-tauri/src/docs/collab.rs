// SPDX-License-Identifier: GPL-3.0-or-later

//! The text half of a document every editor edits through the
//! `@codemirror/collab` protocol: the text, its version, and the recent
//! updates a client that fell behind pulls to catch up. Notes and files both
//! keep one.

use std::collections::VecDeque;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::changes;

/// Updates kept per document for clients that fell behind. An older client reloads.
pub(crate) const HISTORY: usize = 1000;

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
}

impl Collab {
    pub(crate) fn new(text: String) -> Self {
        Self {
            text,
            version: 0,
            updates: VecDeque::new(),
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
