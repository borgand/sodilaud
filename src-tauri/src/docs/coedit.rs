// SPDX-License-Identifier: GPL-3.0-or-later

//! Agents co-editing documents with the owner: which documents an agent is
//! working on, its reads, merged edits and comments, and the owner's comments
//! waiting for it.

use std::path::Path;

use serde::Serialize;

use super::registry::Registry;

/// What both windows show about agents: whether owner comments wait for
/// review, and whether an agent is waiting for comments right now.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CoeditState {
    pub(crate) hold_for_review: bool,
    pub(crate) listening: bool,
}

impl Registry {
    pub(crate) fn coedit_forget_file(&self, _path: &Path) {}
}
