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
    /// A comment on a rectangle of table cells holds the cells' text, tabs
    /// between cells and newlines between rows; `from..to` runs from the
    /// top-left cell to the bottom-right one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) cell_text: Option<String>,
    #[serde(default)]
    pub(crate) heading_path: Vec<String>,
    pub(crate) body: String,
    #[serde(default)]
    pub(crate) note: Option<String>,
    /// The root of the thread this comment answers. Always a root, never
    /// another reply.
    #[serde(default)]
    pub(crate) reply_to: Option<String>,
    /// An agent's comment the owner has not opened yet.
    #[serde(default)]
    pub(crate) unread: bool,
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
            cell_text: None,
            heading_path: heading_path(text, from),
            body,
            note: None,
            reply_to,
            unread: author == Author::Agent,
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

    /// The text the comment quotes: its cells' text for a cell rectangle.
    pub(crate) fn quote(&self) -> &str {
        self.cell_text.as_deref().unwrap_or(&self.anchored_text)
    }

    /// Takes `from..to` of `text` as the anchored text, and its cells' text
    /// for a cell rectangle. One whose ends left the table's cells becomes an
    /// ordinary range comment.
    fn set_anchor(&mut self, text: &str, anchored: String) {
        self.anchored_text = anchored;
        if self.cell_text.is_some() {
            self.cell_text = rect_quote(text, self.from, self.to);
        }
    }

    /// The ID of the thread's root: its own for a root.
    pub(crate) fn root_id(&self) -> &str {
        self.reply_to.as_deref().unwrap_or(&self.id)
    }
}

/// The root a comment's thread hangs from, by the ID of any comment in it.
pub(crate) fn thread_root<'a>(all: &'a [Comment], id: &str) -> Option<&'a Comment> {
    let comment = all.iter().find(|c| c.id == id)?;
    let root = comment.root_id();
    all.iter().find(|c| c.id == root)
}

/// The root and every reply, oldest first.
pub(crate) fn thread<'a>(all: &'a [Comment], root: &str) -> Vec<&'a Comment> {
    let mut found: Vec<&Comment> = all.iter().filter(|c| c.root_id() == root).collect();
    found.sort_by_key(|c| (c.reply_to.is_some(), c.created_at));
    found
}

/// A document's comments as they are now, for the window that shows it.
/// Positions are UTF-16 units of the text at `version`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommentsEvent {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) collection_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) note_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) doc_id: Option<String>,
    pub(crate) version: u64,
    pub(crate) comments: Vec<Comment>,
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

struct Cell {
    seg_from: usize,
    seg_to: usize,
    text: String,
}

// The trimmed cells of a table line, with UTF-16 offsets into the line; None
// for a line without an unescaped pipe or a separator row. Matches
// tableLine in src/table-cells.js.
fn row_cells(line: &str) -> Option<Vec<Cell>> {
    if is_separator_row(line) {
        return None;
    }
    let chars: Vec<char> = line.chars().collect();
    let mut units = Vec::with_capacity(chars.len() + 1);
    units.push(0);
    for character in &chars {
        units.push(units.last().unwrap() + character.len_utf16());
    }
    let mut segments = Vec::new();
    let mut start = 0;
    let mut backslashes = 0;
    for (index, &character) in chars.iter().enumerate() {
        if character == '\\' {
            backslashes += 1;
            continue;
        }
        if character == '|' && backslashes % 2 == 0 {
            segments.push((start, index));
            start = index + 1;
        }
        backslashes = 0;
    }
    if segments.is_empty() {
        return None;
    }
    segments.push((start, chars.len()));
    let blank = |(from, to): (usize, usize)| chars[from..to].iter().all(|c| c.is_whitespace());
    if segments.len() > 1 && blank(segments[0]) {
        segments.remove(0);
    }
    if segments.len() > 1 && blank(segments[segments.len() - 1]) {
        segments.pop();
    }
    let padding = |c: char| c == ' ' || c == '\t';
    Some(
        segments
            .into_iter()
            .map(|(seg_from, seg_to)| {
                let (mut from, mut to) = (seg_from, seg_to);
                while from < to && padding(chars[from]) {
                    from += 1;
                }
                while to > from && padding(chars[to - 1]) {
                    to -= 1;
                }
                Cell {
                    seg_from: units[seg_from],
                    seg_to: units[seg_to],
                    text: chars[from..to].iter().collect(),
                }
            })
            .collect(),
    )
}

// A row of `|---|:--:|` cells between outer pipes, as isSeparatorRow in
// src/editor-tables.js reads it.
fn is_separator_row(line: &str) -> bool {
    let chars: Vec<char> = line.chars().collect();
    let Some(first) = chars.iter().position(|c| !c.is_whitespace()) else {
        return false;
    };
    let Some(last) = chars.iter().rposition(|c| *c != ' ' && *c != '\t') else {
        return false;
    };
    if chars[first] != '|' || chars[last] != '|' {
        return false;
    }
    let escaped = |index: usize| {
        chars[..index]
            .iter()
            .rev()
            .take_while(|c| **c == '\\')
            .count()
            % 2
            == 1
    };
    let pipes: Vec<usize> = (first..=last)
        .filter(|&index| chars[index] == '|' && !escaped(index))
        .collect();
    pipes.len() >= 3
        && pipes.windows(2).all(|pair| {
            let cell: String = chars[pair[0] + 1..pair[1]].iter().collect();
            let cell = cell.trim();
            let cell = cell.strip_prefix(':').unwrap_or(cell);
            let cell = cell.strip_suffix(':').unwrap_or(cell);
            cell.len() >= 3 && cell.chars().all(|c| c == '-')
        })
}

/// The cells of the rectangle from the cell holding `from` to the cell
/// holding `to` (UTF-16 offsets), trimmed and with `\|` turned back into `|`:
/// tabs between cells, newlines between rows, separator rows skipped. The
/// same as cellQuote in src/table-cells.js.
pub(crate) fn cell_text(text: &str, from: usize, to: usize) -> String {
    let (from, to) = (from.min(to), from.max(to));
    let mut lines = Vec::new();
    let mut start = 0;
    for line in text.split('\n') {
        // CodeMirror counts a CRLF break as one, so keep `\r` out of the cells.
        lines.push((start, line.strip_suffix('\r').unwrap_or(line)));
        start += changes::utf16_len(line) + 1;
    }
    let line_of = |pos: usize| {
        lines
            .iter()
            .rposition(|(start, _)| *start <= pos)
            .unwrap_or(0)
    };
    let column = |cells: &[Cell], line_start: usize, pos: usize| {
        cells
            .iter()
            .position(|cell| pos >= line_start + cell.seg_from && pos <= line_start + cell.seg_to)
    };
    let (first, last) = (line_of(from), line_of(to));
    let (Some(first_cells), Some(last_cells)) =
        (row_cells(lines[first].1), row_cells(lines[last].1))
    else {
        return String::new();
    };
    let (Some(from_col), Some(to_col)) = (
        column(&first_cells, lines[first].0, from),
        column(&last_cells, lines[last].0, to),
    ) else {
        return String::new();
    };
    let (col_min, col_max) = (from_col.min(to_col), from_col.max(to_col));
    let mut rows = Vec::new();
    for (_, line) in &lines[first..=last] {
        let Some(cells) = row_cells(line) else {
            continue;
        };
        let picked: Vec<String> = cells
            .iter()
            .skip(col_min)
            .take(col_max - col_min + 1)
            .map(|cell| cell.text.replace("\\|", "|"))
            .collect();
        if !picked.is_empty() {
            rows.push(picked.join("\t"));
        }
    }
    rows.join("\n")
}

/// The cells' text for a rectangle comment on `from..to`, or None when its
/// ends no longer fall in table cells and it is an ordinary range comment.
pub(crate) fn rect_quote(text: &str, from: usize, to: usize) -> Option<String> {
    Some(cell_text(text, from, to)).filter(|quote| !quote.is_empty())
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
            comment.set_anchor(text, text[start..end].to_string());
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
            comment.set_anchor(text, anchored);
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

    const TABLE: &str = "x\n| a | b | c |\n|---|---|---|\n| d | e \\| f | g |\n| h | i | j |\n";

    fn cell_comment(text: &str) -> Comment {
        let at = |needle: &str| changes::utf16_of_byte(text, text.find(needle).unwrap());
        let range = (at("b |"), at("j |") + 1);
        let mut comment = Comment::new(
            Author::Owner,
            State::Queued,
            text,
            range,
            "body".into(),
            None,
            1,
        );
        comment.cell_text = Some(cell_text(text, range.0, range.1));
        comment
    }

    #[test]
    fn cell_text_quotes_the_rectangle_not_the_source_span() {
        let comment = cell_comment(TABLE);
        assert_eq!(
            cell_text(TABLE, comment.from, comment.to),
            "b\tc\ne | f\tg\ni\tj"
        );
        assert_eq!(comment.quote(), "b\tc\ne | f\tg\ni\tj");
        assert!(comment.anchored_text.starts_with("b | c |\n|---"));
    }

    #[test]
    fn a_cell_comment_keeps_its_cell_text_current_through_edits() {
        let mut comments = vec![cell_comment(TABLE)];
        let at = changes::utf16_of_byte(TABLE, TABLE.find("e \\|").unwrap());
        let length = changes::utf16_len(TABLE);
        let text = apply(&mut comments, TABLE, json!([at, [0, "Z"], length - at]));
        let quote = comments[0].cell_text.as_deref().unwrap();
        assert!(
            quote == "b\tc\nZe | f\tg\ni\tj" || quote == "b\tc\neZ | f\tg\ni\tj",
            "{quote}"
        );
        assert_eq!(
            comments[0].anchored_text,
            slice(&text, comments[0].from, comments[0].to)
        );
    }

    #[test]
    fn cell_text_counts_utf16_units_through_non_ascii_text() {
        let text = "ü😀\n| a | bé | c |\n|---|---|---|\n| d | 😀 \\| f | g |\n";
        let at = |needle: &str| changes::utf16_of_byte(text, text.find(needle).unwrap());
        assert_eq!(cell_text(text, at("bé"), at("g |") + 1), "bé\tc\n😀 | f\tg");
    }

    #[test]
    fn cell_text_reads_crlf_lines_as_codemirror_does() {
        let text = TABLE.replace('\n', "\r\n");
        let at = |needle: &str| changes::utf16_of_byte(&text, text.find(needle).unwrap());
        assert_eq!(
            cell_text(&text, at("b |"), at("j |") + 1),
            "b\tc\ne | f\tg\ni\tj"
        );
    }

    #[test]
    fn reanchoring_a_cell_comment_refreshes_its_cell_text() {
        let mut comment = cell_comment(TABLE);
        comment.cell_text = Some("stale".into());
        reanchor(&mut comment, &format!("new line\n{TABLE}"));
        assert!(!comment.orphaned);
        assert_eq!(comment.quote(), "b\tc\ne | f\tg\ni\tj");
    }

    #[test]
    fn a_cell_comment_whose_top_row_is_deleted_falls_back_to_its_range() {
        let mut comments = vec![cell_comment(TABLE)];
        let line = changes::utf16_of_byte(TABLE, TABLE.find("| a").unwrap());
        let length = changes::utf16_len(TABLE);
        let text = apply(
            &mut comments,
            TABLE,
            json!([line, [14], length - line - 14]),
        );
        assert!(!text.contains("| a |"));
        assert!(!comments[0].orphaned);
        assert_eq!(comments[0].cell_text, None);
        assert_eq!(comments[0].quote(), comments[0].anchored_text);
        assert!(!comments[0].anchored_text.is_empty());
    }

    #[test]
    fn a_saved_comment_without_cell_text_still_loads() {
        let mut saved = serde_json::to_value(comment("some text", "text")).unwrap();
        saved.as_object_mut().unwrap().remove("cellText");
        let loaded: Comment = serde_json::from_value(saved).unwrap();
        assert_eq!(loaded.cell_text, None);
        assert_eq!(loaded.quote(), "text");
    }

    #[test]
    fn a_comment_without_cells_serializes_without_cell_text() {
        let plain = serde_json::to_value(comment("some text", "text")).unwrap();
        assert!(plain.get("cellText").is_none());
        let cells = serde_json::to_value(cell_comment(TABLE)).unwrap();
        assert_eq!(cells["cellText"], "b\tc\ne | f\tg\ni\tj");
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
