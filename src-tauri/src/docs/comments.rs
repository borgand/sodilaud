// SPDX-License-Identifier: GPL-3.0-or-later

//! Comments anchored to a range of a document's text. A range is kept in
//! UTF-16 units, as the editor counts, and follows every update the way the
//! editor's own decorations do. When its text is gone it is searched for
//! again; a comment that cannot be placed is kept as an orphan, never dropped.

use serde::{Deserialize, Serialize};

use super::changes::{self, Section};
use super::merge;

pub(crate) const CONTEXT_LINES: usize = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Author {
    Owner,
    Agent,
}

/// Owner comments go `held` (hold for review) or `queued`, then `sent` once an
/// agent took them, then `resolved`. Agent comments are `open` until resolved.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum State {
    Held,
    Queued,
    Sent,
    Open,
    Resolved,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Comment {
    pub(crate) id: String,
    pub(crate) author: Author,
    pub(crate) state: State,
    /// Its text could not be found. It keeps its state so it can be placed
    /// again, but it reaches no agent while it is an orphan.
    #[serde(default)]
    pub(crate) orphaned: bool,
    pub(crate) from: usize,
    pub(crate) to: usize,
    pub(crate) anchored_text: String,
    #[serde(default)]
    pub(crate) heading_path: Vec<String>,
    pub(crate) body: String,
    #[serde(default)]
    pub(crate) note: Option<String>,
    #[serde(default)]
    pub(crate) reply_to: Option<String>,
    pub(crate) created_at: i64,
    pub(crate) updated_at: i64,
}

impl Comment {
    pub(crate) fn new(
        author: Author,
        state: State,
        text: &str,
        (from, to): (usize, usize),
        body: String,
        reply_to: Option<String>,
        now: i64,
    ) -> Self {
        Self {
            id: format!("c_{}", uuid::Uuid::new_v4().simple()),
            author,
            state,
            orphaned: false,
            from,
            to,
            anchored_text: slice(text, from, to),
            heading_path: heading_path(text, from),
            body,
            note: None,
            reply_to,
            created_at: now,
            updated_at: now,
        }
    }

    /// The state an agent or the page sees: an orphan shows as `orphaned`
    /// until it is resolved.
    pub(crate) fn shown_state(&self) -> &'static str {
        match (self.orphaned, self.state) {
            (_, State::Resolved) => "resolved",
            (true, _) => "orphaned",
            (_, State::Held) => "held",
            (_, State::Queued) => "queued",
            (_, State::Sent) => "sent",
            (_, State::Open) => "open",
        }
    }

    pub(crate) fn is_resolved(&self) -> bool {
        self.state == State::Resolved
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct Heading {
    pub(crate) level: usize,
    pub(crate) text: String,
    /// In characters, as MCP counts.
    pub(crate) offset: usize,
}

pub(crate) fn slice(text: &str, from: usize, to: usize) -> String {
    match (
        changes::byte_at_utf16(text, from),
        changes::byte_at_utf16(text, to),
    ) {
        (Some(start), Some(end)) if start <= end => text[start..end].to_string(),
        _ => String::new(),
    }
}

fn is_fence(line: &str) -> bool {
    let trimmed = line.trim_start_matches(' ');
    line.len() - trimmed.len() <= 3 && (trimmed.starts_with("```") || trimmed.starts_with("~~~"))
}

fn atx(line: &str) -> Option<(usize, String)> {
    let trimmed = line.trim_start_matches(' ');
    if line.len() - trimmed.len() > 3 {
        return None;
    }
    let level = trimmed.len() - trimmed.trim_start_matches('#').len();
    let rest = &trimmed[level..];
    if !(1..=6).contains(&level) || !(rest.is_empty() || rest.starts_with([' ', '\t'])) {
        return None;
    }
    let text = rest.trim();
    let text = text.trim_end_matches('#');
    let text = if text.is_empty() || text.ends_with([' ', '\t']) {
        text.trim()
    } else {
        rest.trim()
    };
    Some((level, text.to_string()))
}

/// ATX headings outside fenced code, with byte offsets of their lines.
fn heading_lines(text: &str) -> Vec<(usize, usize, String)> {
    let mut found = Vec::new();
    let mut fenced = false;
    let mut offset = 0;
    for line in text.split('\n') {
        if is_fence(line) {
            fenced = !fenced;
        } else if !fenced {
            if let Some((level, title)) = atx(line) {
                found.push((offset, level, title));
            }
        }
        offset += line.len() + 1;
    }
    found
}

pub(crate) fn headings(text: &str) -> Vec<Heading> {
    heading_lines(text)
        .into_iter()
        .map(|(byte, level, text_)| Heading {
            level,
            offset: text[..byte].chars().count(),
            text: text_,
        })
        .collect()
}

/// The headings a UTF-16 position sits under, outermost first.
pub(crate) fn heading_path(text: &str, position: usize) -> Vec<String> {
    let byte = changes::byte_at_utf16(text, position).unwrap_or(text.len());
    let mut path: Vec<(usize, String)> = Vec::new();
    for (offset, level, title) in heading_lines(text) {
        if offset > byte {
            break;
        }
        path.retain(|(outer, _)| *outer < level);
        path.push((level, title));
    }
    path.into_iter().map(|(_, title)| title).collect()
}

/// Up to two lines before a range and two lines after it, each including the
/// rest of the range's own first and last line.
pub(crate) fn context(text: &str, from: usize, to: usize) -> (String, String) {
    let start = changes::byte_at_utf16(text, from).unwrap_or(0);
    let end = changes::byte_at_utf16(text, to)
        .unwrap_or(text.len())
        .max(start);
    let mut before_start = text[..start].rfind('\n').map_or(0, |i| i + 1);
    for _ in 0..CONTEXT_LINES {
        if before_start == 0 {
            break;
        }
        before_start = text[..before_start - 1].rfind('\n').map_or(0, |i| i + 1);
    }
    let mut after_end = text[end..].find('\n').map_or(text.len(), |i| end + i);
    for _ in 0..CONTEXT_LINES {
        if after_end >= text.len() {
            break;
        }
        after_end = text[after_end + 1..]
            .find('\n')
            .map_or(text.len(), |i| after_end + 1 + i);
    }
    (
        text[before_start..start].to_string(),
        text[end..after_end].to_string(),
    )
}

/// The byte range of the section under the comment's innermost heading, or
/// the whole text when it has none or the heading is gone.
fn section_of(text: &str, path: &[String]) -> (usize, usize) {
    let Some(title) = path.last() else {
        return (0, text.len());
    };
    let lines = heading_lines(text);
    let Some(index) = lines.iter().position(|(_, _, found)| found == title) else {
        return (0, text.len());
    };
    let (start, level, _) = lines[index];
    let end = lines[index + 1..]
        .iter()
        .find(|(_, other, _)| *other <= level)
        .map_or(text.len(), |(offset, _, _)| offset.saturating_sub(1));
    (start, end.max(start))
}

/// Places a comment in `text` again: where it was if its text is still
/// there, else at the nearest copy of its text, else at a close match in its
/// section. Otherwise it becomes an orphan.
pub(crate) fn reanchor(comment: &mut Comment, text: &str) {
    if !comment.anchored_text.is_empty()
        && slice(text, comment.from, comment.to) == comment.anchored_text
    {
        comment.orphaned = false;
        return;
    }
    let wanted = comment.anchored_text.clone();
    let hint =
        changes::byte_at_utf16(text, comment.from.min(changes::utf16_len(text))).unwrap_or(0);
    let nearest = (!wanted.is_empty())
        .then(|| {
            text.match_indices(wanted.as_str())
                .map(|(index, _)| index)
                .min_by_key(|index| index.abs_diff(hint))
        })
        .flatten();
    let found = nearest
        .map(|start| (start, start + wanted.len()))
        .or_else(|| {
            let (start, end) = section_of(text, &comment.heading_path);
            merge::fuzzy(&text[start..end], &wanted)
                .ok()
                .map(|(from, to)| (start + from, start + to))
        });
    match found {
        Some((start, end)) => {
            comment.from = changes::utf16_of_byte(text, start);
            comment.to = changes::utf16_of_byte(text, end);
            comment.anchored_text = text[start..end].to_string();
            comment.orphaned = false;
        }
        None => {
            let length = changes::utf16_len(text);
            comment.from = comment.from.min(length);
            comment.to = comment.from;
            comment.orphaned = true;
        }
    }
}

/// Carries every placed comment through one update. A range that collapsed
/// is placed again; any other range takes the text now inside it.
pub(crate) fn map_through(comments: &mut [Comment], updates: &[Vec<Section>], text: &str) -> bool {
    let mut changed = false;
    for comment in comments.iter_mut().filter(|c| !c.orphaned) {
        let (mut from, mut to) = (comment.from, comment.to);
        for sections in updates {
            from = changes::map_pos_in(sections, from, 1).unwrap_or(from);
            to = changes::map_pos_in(sections, to, -1).unwrap_or(to);
        }
        if to <= from {
            comment.from = from;
            comment.to = from;
            reanchor(comment, text);
            changed = true;
            continue;
        }
        let anchored = slice(text, from, to);
        if (from, to) != (comment.from, comment.to) || anchored != comment.anchored_text {
            comment.from = from;
            comment.to = to;
            comment.anchored_text = anchored;
            changed = true;
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn comment(text: &str, anchored: &str) -> Comment {
        let start = text.find(anchored).unwrap();
        let from = changes::utf16_of_byte(text, start);
        Comment::new(
            Author::Owner,
            State::Queued,
            text,
            (from, from + changes::utf16_len(anchored)),
            "body".into(),
            None,
            1,
        )
    }

    fn apply(comments: &mut [Comment], text: &str, set: serde_json::Value) -> String {
        let next = changes::apply(text, &set).unwrap();
        map_through(comments, &[changes::sections(&set).unwrap()], &next);
        next
    }

    #[test]
    fn finds_headings_outside_code_and_the_path_above_a_position() {
        let text = "# Spec\n\n## Goals\nfast\n```\n# not\n```\n### Detail ##\nx\n## Risks\ny\n";
        let found = headings(text);
        let titles: Vec<_> = found.iter().map(|h| (h.level, h.text.as_str())).collect();
        assert_eq!(
            titles,
            vec![(1, "Spec"), (2, "Goals"), (3, "Detail"), (2, "Risks")]
        );
        assert_eq!(found[1].offset, 8);
        let at = |needle: &str| changes::utf16_of_byte(text, text.find(needle).unwrap());
        assert_eq!(
            heading_path(text, at("x\n")),
            vec!["Spec", "Goals", "Detail"]
        );
        assert_eq!(heading_path(text, at("y\n")), vec!["Spec", "Risks"]);
        assert!(heading_path(text, 0).first().is_some_and(|t| t == "Spec"));
        assert_eq!(atx("#hashtag"), None);
    }

    #[test]
    fn context_is_two_lines_each_side() {
        let text = "1\n2\n3\nab target cd\n4\n5\n6";
        let from = text.find("target").unwrap();
        let (before, after) = context(text, from, from + 6);
        assert_eq!(before, "2\n3\nab ");
        assert_eq!(after, " cd\n4\n5");
        assert_eq!(context("x", 0, 1), (String::new(), String::new()));
    }

    #[test]
    fn a_comment_follows_edits_around_and_inside_it() {
        let text = "intro\nthe vague part\noutro";
        let mut comments = vec![comment(text, "vague part")];
        let text = apply(&mut comments, text, json!([[0, "new "], 26]));
        assert_eq!(slice(&text, comments[0].from, comments[0].to), "vague part");
        let at = comments[0].from;
        let text = apply(&mut comments, &text, json!([at + 5, [0, "ish"], 25 - at]));
        assert_eq!(comments[0].anchored_text, "vagueish part");
        let at = comments[0].from;
        let text = apply(&mut comments, &text, json!([at, [0, "["], 33 - at]));
        assert_eq!(
            comments[0].anchored_text, "vagueish part",
            "typing at the start stays out"
        );
        assert!(text.contains("[vagueish"));
    }

    #[test]
    fn an_exact_rewrite_carries_the_comment_to_the_new_text() {
        let text = "keep\nold sentence\nkeep";
        let mut comments = vec![comment(text, "old sentence")];
        let (from, to) = (comments[0].from, comments[0].to);
        apply(
            &mut comments,
            text,
            json!([from, [to - from, "a much better sentence"], 5]),
        );
        assert_eq!(comments[0].anchored_text, "a much better sentence");
        assert!(!comments[0].orphaned);
    }

    #[test]
    fn a_deleted_range_is_found_again_or_orphaned() {
        let text = "# A\nphrase here\n# B\nother\n";
        let mut comments = vec![comment(text, "phrase here")];
        // The whole line is removed and the same words reappear under B.
        let text = apply(
            &mut comments,
            text,
            json!([4, [12], 4, [0, "phrase here", ""], 6]),
        );
        assert_eq!(
            slice(&text, comments[0].from, comments[0].to),
            "phrase here"
        );
        assert!(!comments[0].orphaned);
        let from = changes::utf16_of_byte(&text, text.find("phrase").unwrap());
        let length = changes::utf16_len(&text);
        apply(
            &mut comments,
            &text,
            json!([from, [12], length - from - 12]),
        );
        assert!(comments[0].orphaned);
        assert_eq!(comments[0].shown_state(), "orphaned");
        assert_eq!(
            comments[0].anchored_text, "phrase here",
            "the snippet is kept"
        );
    }

    #[test]
    fn reanchoring_after_an_outside_change_prefers_the_nearest_copy_then_a_close_match() {
        let mut found = comment("# Plan\nship it\n", "ship it");
        reanchor(&mut found, "# Plan\nnew line\nship it\n");
        assert_eq!((found.from, found.to, found.orphaned), (16, 23, false));
        let mut near = comment(
            "# Plan\nThe build must finish in ten minutes.\n",
            "The build must finish in ten minutes.",
        );
        reanchor(
            &mut near,
            "# Plan\nThe build must finish in ten minutes!\n# Other\n",
        );
        assert!(!near.orphaned);
        assert_eq!(near.anchored_text, "The build must finish in ten minutes!");
        let mut gone = comment("# Plan\nship it\n", "ship it");
        reanchor(&mut gone, "# Plan\nnothing alike\n");
        assert!(gone.orphaned);
    }
}
