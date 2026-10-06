// SPDX-License-Identifier: GPL-3.0-or-later

//! CodeMirror 6 change sets as JSON, applied to Rust strings.
//!
//! A change set covers the whole document: a number keeps that many UTF-16
//! units, `[n]` deletes `n`, and `[n, line, line...]` replaces `n` with the
//! lines joined by `\n`. CM6 counts UTF-16 units, Rust strings are UTF-8 and
//! MCP offsets count characters. This module is the only place that converts.

use std::borrow::Cow;
use std::time::Duration;

use serde_json::Value;
use similar::{DiffTag, TextDiff, TextDiffConfig};

/// How long a diff may search for the smallest change before it settles for a
/// larger, still correct one.
const DIFF_TIMEOUT: Duration = Duration::from_millis(100);

/// CM6 splits a document on `\r\n`, `\r` and `\n` and keeps only `\n`, so text
/// entering the registry does the same or offsets would disagree.
pub(crate) fn normalize_newlines(text: &str) -> Cow<'_, str> {
    if text.contains('\r') {
        Cow::Owned(text.replace("\r\n", "\n").replace('\r', "\n"))
    } else {
        Cow::Borrowed(text)
    }
}

pub(crate) fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// The byte index of a UTF-16 offset, or `None` when it lies past the end or
/// inside a surrogate pair.
pub(crate) fn byte_at_utf16(text: &str, offset: usize) -> Option<usize> {
    let mut units = 0;
    for (index, character) in text.char_indices() {
        if units == offset {
            return Some(index);
        }
        units += character.len_utf16();
        if units > offset {
            return None;
        }
    }
    (units == offset).then_some(text.len())
}

/// Applies a change set to `text`. The change set must span exactly the
/// document, and every position must fall on a character boundary.
pub(crate) fn apply(text: &str, changes: &Value) -> Result<String, String> {
    let parts = changes.as_array().ok_or("A change set must be an array")?;
    let mut result = String::with_capacity(text.len());
    let mut rest = text;
    for part in parts {
        let (length, insert) = match part {
            Value::Number(length) => (length.as_u64(), None),
            Value::Array(items) => {
                let length = items.first().and_then(Value::as_u64);
                let lines = items[1.min(items.len())..]
                    .iter()
                    .map(|line| match line.as_str() {
                        Some(line) if !line.contains(['\n', '\r']) => Ok(line),
                        _ => Err("A change set line must be a string without line breaks"),
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                (length, Some(lines))
            }
            _ => return Err("A change set part must be a number or an array".into()),
        };
        let length = usize::try_from(length.ok_or("A change set length must be a number")?)
            .map_err(|_| "A change set length is too large")?;
        let end =
            byte_at_utf16(rest, length).ok_or("A change set does not match the document length")?;
        match insert {
            None => result.push_str(&rest[..end]),
            Some(lines) if lines.is_empty() => {}
            Some(lines) => result.push_str(&lines.join("\n")),
        }
        rest = &rest[end..];
    }
    if !rest.is_empty() {
        return Err("A change set does not match the document length".into());
    }
    Ok(result)
}

/// A changed run of a change set, in UTF-16 units of the document before it:
/// `from..to` was replaced by `insert` units of new text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Section {
    pub(crate) from: usize,
    pub(crate) to: usize,
    pub(crate) insert: usize,
}

/// The changed runs of a change set, in order. Kept runs are left out.
pub(crate) fn sections(changes: &Value) -> Result<Vec<Section>, String> {
    let parts = changes.as_array().ok_or("A change set must be an array")?;
    let mut sections: Vec<Section> = Vec::new();
    let mut position = 0;
    for part in parts {
        match part {
            Value::Number(length) => {
                position += length
                    .as_u64()
                    .ok_or("A change set length must be a number")?
                    as usize;
            }
            Value::Array(items) => {
                let length = items
                    .first()
                    .and_then(Value::as_u64)
                    .ok_or("A change set length must be a number")?
                    as usize;
                let lines = &items[1.min(items.len())..];
                let insert = if lines.is_empty() {
                    0
                } else {
                    lines
                        .iter()
                        .map(|line| line.as_str().map(utf16_len).unwrap_or(0))
                        .sum::<usize>()
                        + lines.len()
                        - 1
                };
                let section = Section {
                    from: position,
                    to: position + length,
                    insert,
                };
                match sections.last_mut() {
                    Some(last) if last.to == section.from => {
                        last.to = section.to;
                        last.insert += section.insert;
                    }
                    _ => sections.push(section),
                }
                position += length;
            }
            _ => return Err("A change set part must be a number or an array".into()),
        }
    }
    Ok(sections)
}

/// Where `pos` lands after `changes`, as CodeMirror's `ChangeDesc.mapPos`
/// puts it, so Rust and the editor agree on every comment anchor. A position
/// at the start of a replaced run stays at the start of its replacement; one
/// inside goes to its start (`assoc < 0`) or past it; a position where text
/// was only inserted goes past it unless `assoc < 0`.
#[cfg(test)]
pub(crate) fn map_pos(changes: &Value, pos: usize, assoc: i8) -> Result<usize, String> {
    map_pos_in(&sections(changes)?, pos, assoc)
}

pub(crate) fn map_pos_in(sections: &[Section], pos: usize, assoc: i8) -> Result<usize, String> {
    let (mut pos_a, mut pos_b) = (0, 0);
    for section in sections {
        if pos < section.from {
            return Ok(pos_b + (pos - pos_a));
        }
        pos_b += section.from - pos_a;
        pos_a = section.from;
        let length = section.to - section.from;
        if section.to > pos || (section.to == pos && assoc < 0 && length == 0) {
            return Ok(if pos == pos_a || assoc < 0 {
                pos_b
            } else {
                pos_b + section.insert
            });
        }
        pos_b += section.insert;
        pos_a = section.to;
    }
    Ok(pos_b + (pos - pos_a))
}

/// Whether `changes` deleted any of `from..to` or inserted text strictly
/// inside it. Text inserted right at either end leaves the range alone.
#[cfg(test)]
pub(crate) fn touches(changes: &Value, from: usize, to: usize) -> Result<bool, String> {
    Ok(touches_in(&sections(changes)?, from, to))
}

pub(crate) fn touches_in(sections: &[Section], from: usize, to: usize) -> bool {
    sections.iter().any(|section| {
        if section.from == section.to {
            from < section.from && section.from < to
        } else {
            section.from < to && section.to > from
        }
    })
}

/// The UTF-16 offset of byte index `byte`, which must be a character boundary.
pub(crate) fn utf16_of_byte(text: &str, byte: usize) -> usize {
    utf16_len(&text[..byte])
}

/// The number of characters before UTF-16 offset `units`.
pub(crate) fn utf16_to_char(text: &str, units: usize) -> usize {
    let mut seen = 0;
    let mut count = 0;
    for character in text.chars() {
        if seen >= units {
            break;
        }
        seen += character.len_utf16();
        count += 1;
    }
    count
}

fn lines(text: &str) -> Vec<Value> {
    text.split('\n').map(Value::from).collect()
}

/// Inserts `addition` at the end of a document of `document` text.
pub(crate) fn append(document: &str, addition: &str) -> Value {
    let length = utf16_len(document);
    let mut insert = vec![Value::from(0)];
    insert.extend(lines(addition));
    let mut parts = Vec::new();
    if length > 0 {
        parts.push(Value::from(length));
    }
    parts.push(Value::Array(insert));
    Value::Array(parts)
}

/// Builds a change set from kept, deleted and inserted runs, merging
/// neighbouring runs of the same kind.
#[derive(Default)]
struct Builder {
    parts: Vec<Value>,
    kept: usize,
    deleted: usize,
    inserted: String,
    changing: bool,
}

impl Builder {
    fn keep(&mut self, text: &str) {
        self.end_change();
        self.kept += utf16_len(text);
    }

    fn delete(&mut self, text: &str) {
        self.end_keep();
        self.changing = true;
        self.deleted += utf16_len(text);
    }

    fn insert(&mut self, text: &str) {
        self.end_keep();
        self.changing = true;
        self.inserted.push_str(text);
    }

    fn end_keep(&mut self) {
        if self.kept > 0 {
            self.parts.push(Value::from(self.kept));
            self.kept = 0;
        }
    }

    fn end_change(&mut self) {
        if !self.changing {
            return;
        }
        let mut part = vec![Value::from(self.deleted)];
        if !self.inserted.is_empty() {
            part.extend(lines(&self.inserted));
        }
        self.parts.push(Value::Array(part));
        self.deleted = 0;
        self.inserted.clear();
        self.changing = false;
    }

    fn finish(mut self) -> Value {
        self.end_change();
        self.end_keep();
        Value::Array(self.parts)
    }

    /// Feeds a diff in. A replaced run of lines is diffed again by
    /// character, so an edit inside a line keeps the rest of it.
    fn feed(&mut self, diff: &TextDiff<'_, '_, str>, by_line: bool) {
        let old = |index: usize| diff.old_slice(index).unwrap_or_default();
        let new = |index: usize| diff.new_slice(index).unwrap_or_default();
        for op in diff.ops() {
            let (tag, old_range, new_range) = op.as_tag_tuple();
            match tag {
                DiffTag::Equal => old_range.for_each(|i| self.keep(old(i))),
                DiffTag::Delete => old_range.for_each(|i| self.delete(old(i))),
                DiffTag::Insert => new_range.for_each(|i| self.insert(new(i))),
                DiffTag::Replace if by_line => {
                    let before: String = old_range.map(old).collect();
                    let after: String = new_range.map(new).collect();
                    let inner = config().diff_chars(before.as_str(), after.as_str());
                    self.feed(&inner, false);
                }
                DiffTag::Replace => {
                    old_range.for_each(|i| self.delete(old(i)));
                    new_range.for_each(|i| self.insert(new(i)));
                }
            }
        }
    }
}

fn config() -> TextDiffConfig {
    let mut config = TextDiff::configure();
    config.timeout(DIFF_TIMEOUT);
    config
}

/// A change set that turns `old` into `new` while keeping every unchanged
/// line and character, so cursors and undo history in an open editor survive
/// a whole-text replacement.
pub(crate) fn diff(old: &str, new: &str) -> Value {
    let mut builder = Builder::default();
    builder.feed(&config().diff_lines(old, new), true);
    builder.finish()
}

/// A change set over a document of `length` UTF-16 units that replaces each
/// `from..to` with its text. The ranges must be sorted and must not overlap.
pub(crate) fn from_replacements(length: usize, replacements: &[(usize, usize, &str)]) -> Value {
    let mut parts = Vec::new();
    let mut position = 0;
    for &(from, to, text) in replacements {
        if from > position {
            parts.push(Value::from(from - position));
        }
        let mut part = vec![Value::from(to - from)];
        if !text.is_empty() {
            part.extend(lines(text));
        }
        parts.push(Value::Array(part));
        position = to;
    }
    if length > position {
        parts.push(Value::from(length - position));
    }
    Value::Array(parts)
}

/// Replaces the whole of `document` with `replacement`.
#[cfg(test)]
pub(crate) fn replace_all(document: &str, replacement: &str) -> Value {
    let length = utf16_len(document);
    if length == 0 && replacement.is_empty() {
        return Value::Array(Vec::new());
    }
    let mut part = vec![Value::from(length)];
    if !replacement.is_empty() {
        part.extend(lines(replacement));
    }
    Value::Array(vec![Value::Array(part)])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keeps_deletes_and_replaces_by_utf16_units() {
        assert_eq!(apply("hello", &json!([5])).unwrap(), "hello");
        assert_eq!(apply("hello", &json!([1, [3], 1])).unwrap(), "ho");
        assert_eq!(
            apply("hello", &json!([5, [0, "", "world"]])).unwrap(),
            "hello\nworld"
        );
        // 😀 is two UTF-16 units and four UTF-8 bytes.
        assert_eq!(apply("a😀b", &json!([1, [2, "õ"], 1])).unwrap(), "aõb");
        assert_eq!(apply("", &json!([])).unwrap(), "");
    }

    #[test]
    fn rejects_change_sets_that_do_not_fit_the_document() {
        assert!(apply("abc", &json!([2])).is_err(), "too short");
        assert!(apply("abc", &json!([4])).is_err(), "too long");
        assert!(
            apply("a😀", &json!([2, 1])).is_err(),
            "inside a surrogate pair"
        );
        assert!(
            apply("abc", &json!([[3, "a\nb"]])).is_err(),
            "line with a break"
        );
        assert!(apply("abc", &json!({"len": 3})).is_err());
        assert!(apply("abc", &json!(["x"])).is_err());
    }

    #[test]
    fn builds_appends_and_replacements() {
        for document in ["", "x", "a😀\nb"] {
            for addition in ["", "tail", "\n- item\n", "ž😀"] {
                let changed = apply(document, &append(document, addition)).unwrap();
                assert_eq!(changed, format!("{document}{addition}"));
                let replaced = apply(document, &replace_all(document, addition)).unwrap();
                assert_eq!(replaced, addition);
            }
        }
    }

    #[test]
    fn a_diff_keeps_unchanged_lines_as_kept_parts() {
        let old = "first line\nmiddle\nlast line\n";
        let new = "first line\nmiddle edited\nlast line\n";
        let set = diff(old, new);
        assert_eq!(set, json!([17, [0, " edited"], 11]));
        assert_eq!(apply(old, &set).unwrap(), new);
        assert_eq!(diff("", ""), json!([]));
        assert_eq!(diff("same", "same"), json!([4]));
        assert_eq!(apply("", &diff("", "a\nb")).unwrap(), "a\nb");
        assert_eq!(apply("a\nb", &diff("a\nb", "")).unwrap(), "");
    }

    #[test]
    fn maps_positions_as_codemirror_does() {
        // "abcdef": replace "cd" (2..4) with "XYZ".
        let replace = json!([2, [2, "XYZ"], 2]);
        assert_eq!(map_pos(&replace, 1, 1).unwrap(), 1);
        assert_eq!(
            map_pos(&replace, 2, 1).unwrap(),
            2,
            "start of a replacement stays"
        );
        assert_eq!(map_pos(&replace, 2, -1).unwrap(), 2);
        assert_eq!(
            map_pos(&replace, 3, -1).unwrap(),
            2,
            "inside goes to the start"
        );
        assert_eq!(map_pos(&replace, 3, 1).unwrap(), 5, "or past the insertion");
        assert_eq!(map_pos(&replace, 4, -1).unwrap(), 5, "the end is past it");
        assert_eq!(map_pos(&replace, 6, 1).unwrap(), 7);
        // Insert "XY" at 3.
        let insert = json!([3, [0, "XY"], 3]);
        assert_eq!(map_pos(&insert, 3, -1).unwrap(), 3);
        assert_eq!(map_pos(&insert, 3, 1).unwrap(), 5);
        assert_eq!(map_pos(&insert, 2, 1).unwrap(), 2);
        // An insertion over a line break counts the break.
        assert_eq!(map_pos(&json!([[0, "a", "b"], 2]), 0, 1).unwrap(), 3);
        // A deletion collapses everything inside it.
        let delete = json!([1, [3], 2]);
        assert_eq!(map_pos(&delete, 2, 1).unwrap(), 1);
        assert_eq!(map_pos(&delete, 4, 1).unwrap(), 1);
        assert_eq!(map_pos(&delete, 5, 1).unwrap(), 2);
    }

    #[test]
    fn neighbouring_runs_form_one_section() {
        assert_eq!(
            sections(&json!([1, [2], [0, "xy"], 3])).unwrap(),
            vec![Section {
                from: 1,
                to: 3,
                insert: 2
            }]
        );
    }

    #[test]
    fn touching_means_deleting_inside_or_inserting_strictly_inside() {
        let insert_at = |at: usize| json!([at, [0, "x"], 10 - at]);
        assert!(!touches(&insert_at(2), 2, 5).unwrap(), "at the start");
        assert!(!touches(&insert_at(5), 2, 5).unwrap(), "at the end");
        assert!(touches(&insert_at(3), 2, 5).unwrap());
        assert!(
            touches(&json!([4, [2], 4]), 2, 5).unwrap(),
            "overlapping deletion"
        );
        assert!(
            touches(&json!([2, [3, "abc"], 5]), 2, 5).unwrap(),
            "exact replacement"
        );
        assert!(!touches(&json!([5, [2], 3]), 2, 5).unwrap(), "after");
        assert!(!touches(&json!([[2], 8]), 2, 5).unwrap(), "before");
    }

    #[test]
    fn converts_between_bytes_characters_and_utf16() {
        let text = "a😀õb";
        assert_eq!(utf16_of_byte(text, 5), 3);
        assert_eq!(utf16_to_char(text, 3), 2);
        assert_eq!(utf16_to_char(text, 99), 4);
    }

    #[test]
    fn mapped_kept_characters_stay_on_the_same_character() {
        let alphabet = ['a', 'õ', '😀', '\n', ' '];
        let mut random = Lcg(23);
        for _ in 0..1000 {
            let old: String = (0..random.next(20))
                .map(|_| alphabet[random.next(alphabet.len())])
                .collect();
            let mut new: Vec<char> = old.chars().collect();
            for _ in 0..random.next(4) {
                let at = random.next(new.len() + 1);
                if random.next(2) == 0 && at < new.len() {
                    new.remove(at);
                } else {
                    new.insert(at, alphabet[random.next(alphabet.len())]);
                }
            }
            let new: String = new.into_iter().collect();
            let set = diff(&old, &new);
            let kept: Vec<(usize, usize)> = {
                let sections = sections(&set).unwrap();
                let mut units = 0;
                old.chars()
                    .filter_map(|character| {
                        let start = units;
                        units += character.len_utf16();
                        let changed = sections
                            .iter()
                            .any(|s| s.from < start + character.len_utf16() && s.to > start);
                        (!changed).then_some((start, character.len_utf16()))
                    })
                    .collect()
            };
            let new_units: Vec<u16> = new.encode_utf16().collect();
            let old_units: Vec<u16> = old.encode_utf16().collect();
            for (start, length) in kept {
                let mapped = map_pos(&set, start, 1).unwrap();
                assert_eq!(
                    &new_units[mapped..mapped + length],
                    &old_units[start..start + length],
                    "{old:?} -> {new:?} at {start}"
                );
            }
        }
    }

    #[test]
    fn normalizes_every_line_break_to_a_newline() {
        assert_eq!(normalize_newlines("a\r\nb\rc\nd"), "a\nb\nc\nd");
        assert!(matches!(normalize_newlines("plain\n"), Cow::Borrowed(_)));
    }

    /// A small deterministic generator, so the property test needs no crate.
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self, bound: usize) -> usize {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            ((self.0 >> 33) as usize) % bound.max(1)
        }
    }

    #[test]
    fn random_diffs_rebuild_the_new_text() {
        let alphabet = ['a', 'õ', '😀', '\n', 'ž', ' ', '𝄞'];
        let mut random = Lcg(11);
        for _ in 0..2000 {
            let old: String = (0..random.next(30))
                .map(|_| alphabet[random.next(alphabet.len())])
                .collect();
            let mut new: Vec<char> = old.chars().collect();
            for _ in 0..random.next(4) {
                let at = random.next(new.len() + 1);
                if random.next(2) == 0 && at < new.len() {
                    new.remove(at);
                } else {
                    new.insert(at, alphabet[random.next(alphabet.len())]);
                }
            }
            let new: String = new.into_iter().collect();
            assert_eq!(
                apply(&old, &diff(&old, &new)).unwrap(),
                new,
                "{old:?} -> {new:?}"
            );
        }
    }

    #[test]
    fn random_edits_match_a_utf16_reference() {
        let alphabet = ['a', 'õ', '😀', '\n', 'ž', ' ', '𝄞'];
        let mut random = Lcg(7);
        for _ in 0..2000 {
            let document: String = (0..random.next(12))
                .map(|_| alphabet[random.next(alphabet.len())])
                .collect();
            let units: Vec<u16> = document.encode_utf16().collect();
            // Pick boundaries on character starts, as CM6 would.
            let starts: Vec<usize> = document
                .chars()
                .scan(0, |offset, character| {
                    let start = *offset;
                    *offset += character.len_utf16();
                    Some(start)
                })
                .chain(std::iter::once(units.len()))
                .collect();
            let from = starts[random.next(starts.len())];
            let later: Vec<usize> = starts
                .iter()
                .copied()
                .filter(|&start| start >= from)
                .collect();
            let to = later[random.next(later.len())];
            let insert: String = (0..random.next(4))
                .map(|_| alphabet[random.next(alphabet.len())])
                .collect();

            let mut parts = Vec::new();
            if from > 0 {
                parts.push(json!(from));
            }
            let mut replace = vec![json!(to - from)];
            if !insert.is_empty() {
                replace.extend(insert.split('\n').map(|line| json!(line)));
            }
            parts.push(Value::Array(replace));
            if units.len() > to {
                parts.push(json!(units.len() - to));
            }

            let mut expected = units[..from].to_vec();
            expected.extend(insert.encode_utf16());
            expected.extend_from_slice(&units[to..]);
            let applied = apply(&document, &Value::Array(parts)).unwrap();
            assert_eq!(applied, String::from_utf16(&expected).unwrap());
            assert_eq!(utf16_len(&applied), expected.len());
        }
    }
}
