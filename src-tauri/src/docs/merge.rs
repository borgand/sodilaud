// SPDX-License-Identifier: GPL-3.0-or-later

//! Applies an agent's edits, written against the text it read, to the text
//! as it is now. Each `oldText` is found in that base text, then its range is
//! carried through every update made since. The owner wins: a range any of
//! those updates touched is handed back as a conflict, never overwritten.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use similar::TextDiff;

use super::changes::{self, Section};
use super::collab::Update;

/// How alike a window of lines must be to `oldText` to count as a fuzzy match.
const FUZZY_SIMILARITY: f32 = 0.9;
/// Longer `oldText`s are matched exactly or not at all.
const FUZZY_MAX_CHARS: usize = 20_000;
const FUZZY_BUDGET: Duration = Duration::from_millis(800);

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct Edit {
    /// Text copied from the content read at baseVersion. It must identify one place.
    pub(crate) old_text: String,
    /// The text to put there instead.
    pub(crate) new_text: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Reason {
    NotFound,
    Ambiguous,
    EditedByOwner,
    OverlapsEdit,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Conflict {
    pub(crate) index: usize,
    pub(crate) reason: Reason,
    /// The edit's region as it is now, so the agent can retry without rereading.
    pub(crate) current_text: String,
}

#[derive(Debug, PartialEq)]
pub(crate) struct Outcome {
    pub(crate) applied: Vec<usize>,
    pub(crate) conflicts: Vec<Conflict>,
    /// One change set over the current text with every applied edit.
    pub(crate) changes: Option<Value>,
}

fn utf16_range(text: &str, from: usize, to: usize) -> (usize, usize) {
    (
        changes::utf16_of_byte(text, from),
        changes::utf16_of_byte(text, to),
    )
}

fn slice_utf16(text: &str, from: usize, to: usize) -> String {
    match (
        changes::byte_at_utf16(text, from),
        changes::byte_at_utf16(text, to),
    ) {
        (Some(start), Some(end)) if start <= end => text[start..end].to_string(),
        _ => String::new(),
    }
}

/// Byte ranges where `needle` occurs, overlapping ones included, stopping at two.
fn exact(haystack: &str, needle: &str) -> Vec<(usize, usize)> {
    let mut found = Vec::new();
    let mut start = 0;
    while let Some(index) = haystack[start..].find(needle) {
        let at = start + index;
        found.push((at, at + needle.len()));
        if found.len() == 2 {
            break;
        }
        start = at + haystack[at..].chars().next().map_or(1, char::len_utf8);
    }
    found
}

/// Byte ranges matching `needle` with any run of whitespace standing for any other.
fn whitespace_tolerant(haystack: &str, needle: &str) -> Vec<(usize, usize)> {
    let tokens: Vec<&str> = needle.split_whitespace().collect();
    let Some(first) = tokens.first() else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for (start, _) in haystack.match_indices(first) {
        let mut end = start + first.len();
        let matched = tokens[1..].iter().all(|token| {
            let rest = &haystack[end..];
            let gap = rest.len() - rest.trim_start().len();
            if gap == 0 || !rest[gap..].starts_with(token) {
                return false;
            }
            end += gap + token.len();
            true
        });
        if !matched {
            continue;
        }
        let mut from = start;
        if needle.starts_with(char::is_whitespace) {
            from = haystack[..from].trim_end().len();
        }
        if needle.ends_with(char::is_whitespace) {
            let rest = &haystack[end..];
            end += rest.len() - rest.trim_start().len();
        }
        if !found.contains(&(from, end)) {
            found.push((from, end));
        }
        if found.len() == 2 {
            break;
        }
    }
    found
}

/// The window of whole lines most like `needle`, if it is alike enough and
/// no other window that does not overlap it is as alike.
fn fuzzy(haystack: &str, needle: &str) -> Result<(usize, usize), Reason> {
    let wanted = needle.strip_suffix('\n').unwrap_or(needle);
    if wanted.trim().is_empty() || wanted.chars().count() > FUZZY_MAX_CHARS {
        return Err(Reason::NotFound);
    }
    let mut starts = vec![0];
    starts.extend(haystack.match_indices('\n').map(|(index, _)| index + 1));
    let line_end = |line: usize| {
        starts
            .get(line + 1)
            .map_or(haystack.len(), |&next| next - 1)
    };
    let count = wanted.split('\n').count();
    let deadline = Instant::now() + FUZZY_BUDGET;
    let wanted_chars = wanted.chars().count() as f32;
    let mut scored: Vec<(f32, usize, usize)> = Vec::new();
    for size in [count, count + 1, count.saturating_sub(1)] {
        if size == 0 || size > starts.len() {
            continue;
        }
        for first in 0..=(starts.len() - size) {
            if Instant::now() > deadline {
                return Err(Reason::NotFound);
            }
            let (from, to) = (starts[first], line_end(first + size - 1));
            let window = &haystack[from..to];
            let length = window.chars().count() as f32;
            if (length - wanted_chars).abs() > 0.2 * length.max(wanted_chars) {
                continue;
            }
            let ratio = TextDiff::configure()
                .deadline(deadline)
                .diff_chars(wanted, window)
                .ratio();
            if ratio >= FUZZY_SIMILARITY {
                scored.push((ratio, from, to));
            }
        }
    }
    let best = scored
        .iter()
        .copied()
        .max_by(|a, b| a.0.total_cmp(&b.0))
        .ok_or(Reason::NotFound)?;
    let rival = scored
        .iter()
        .any(|&(ratio, from, to)| ratio == best.0 && (to <= best.1 || from >= best.2));
    if rival {
        return Err(Reason::Ambiguous);
    }
    let mut end = best.2;
    if needle.ends_with('\n') && end < haystack.len() {
        end += 1;
    }
    Ok((best.1, end))
}

/// Where `old` is in `base`, in UTF-16 units: an exact unique match, else a
/// unique match that ignores how whitespace is laid out, else a unique window
/// of lines at least 90% alike.
pub(crate) fn locate(base: &str, old: &str) -> Result<(usize, usize), Reason> {
    if old.is_empty() {
        return Err(Reason::NotFound);
    }
    let found = match exact(base, old).as_slice() {
        [one] => Ok(*one),
        [_, _, ..] => Err(Reason::Ambiguous),
        [] => match whitespace_tolerant(base, old).as_slice() {
            [one] => Ok(*one),
            [_, _, ..] => Err(Reason::Ambiguous),
            [] => fuzzy(base, old),
        },
    }?;
    Ok(utf16_range(base, found.0, found.1))
}

/// Applies `edits`, whose `oldText`s come from `base`, to `current`, which is
/// `base` after `since`. Returns which edits applied, which did not and why,
/// and the change set that applies them.
pub(crate) fn merge(base: &str, current: &str, since: &[Update], edits: &[Edit]) -> Outcome {
    let mut sections = Vec::with_capacity(since.len());
    for update in since {
        match changes::sections(&update.changes) {
            Ok(found) => sections.push(found),
            Err(_) => {
                return Outcome {
                    applied: Vec::new(),
                    conflicts: Vec::new(),
                    changes: None,
                }
            }
        }
    }
    let mut conflicts = Vec::new();
    let mut accepted: Vec<(usize, usize, usize)> = Vec::new();
    for (index, edit) in edits.iter().enumerate() {
        let (mut from, mut to) = match locate(base, &edit.old_text) {
            Ok(range) => range,
            Err(reason) => {
                conflicts.push(Conflict {
                    index,
                    reason,
                    current_text: String::new(),
                });
                continue;
            }
        };
        let mut touched = false;
        for update in &sections {
            if !touched && touched_by(update, from, to) {
                touched = true;
            }
            let (assoc_from, assoc_to) = if touched { (-1, 1) } else { (1, -1) };
            from = changes::map_pos_in(update, from, assoc_from).unwrap_or(from);
            to = changes::map_pos_in(update, to, assoc_to).unwrap_or(to);
        }
        if touched {
            conflicts.push(Conflict {
                index,
                reason: Reason::EditedByOwner,
                current_text: slice_utf16(current, from, to.max(from)),
            });
            continue;
        }
        if accepted.iter().any(|&(_, a, b)| a < to && from < b) {
            conflicts.push(Conflict {
                index,
                reason: Reason::OverlapsEdit,
                current_text: slice_utf16(current, from, to),
            });
            continue;
        }
        accepted.push((index, from, to));
    }
    let mut applied: Vec<usize> = accepted.iter().map(|&(index, _, _)| index).collect();
    applied.sort_unstable();
    accepted.sort_by_key(|&(_, from, _)| from);
    let changes = (!accepted.is_empty()).then(|| {
        let replacements: Vec<(usize, usize, &str)> = accepted
            .iter()
            .map(|&(index, from, to)| (from, to, edits[index].new_text.as_str()))
            .collect();
        changes::from_replacements(changes::utf16_len(current), &replacements)
    });
    Outcome {
        applied,
        conflicts,
        changes,
    }
}

fn touched_by(update: &[Section], from: usize, to: usize) -> bool {
    update.iter().any(|section| {
        if section.from == section.to {
            from < section.from && section.from < to
        } else {
            section.from < to && section.to > from
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn edit(old: &str, new: &str) -> Edit {
        Edit {
            old_text: old.into(),
            new_text: new.into(),
        }
    }

    fn owner(changes: Value) -> Update {
        Update {
            client_id: "page".into(),
            changes,
        }
    }

    fn run(base: &str, since: &[Update], edits: &[Edit]) -> (String, Outcome) {
        let mut current = base.to_string();
        for update in since {
            current = changes::apply(&current, &update.changes).unwrap();
        }
        let outcome = merge(base, &current, since, edits);
        let merged = match &outcome.changes {
            Some(set) => changes::apply(&current, set).unwrap(),
            None => current,
        };
        (merged, outcome)
    }

    #[test]
    fn locates_exactly_then_ignoring_whitespace_then_fuzzily() {
        let base = "# Title\n\nThe quick brown fox.\nJumps over the lazy dog.\n";
        assert_eq!(locate(base, "quick brown"), Ok((13, 24)));
        assert_eq!(locate(base, "o"), Err(Reason::Ambiguous));
        assert_eq!(locate(base, "missing"), Err(Reason::NotFound));
        assert_eq!(locate(base, ""), Err(Reason::NotFound));
        let (from, to) = locate(base, "The  quick\nbrown fox.").unwrap();
        assert_eq!(&base[from..to], "The quick brown fox.");
        let (from, to) = locate(base, "The quick brown cat.\nJumps over the lazy dog.").unwrap();
        assert_eq!(
            &base[from..to],
            "The quick brown fox.\nJumps over the lazy dog."
        );
        assert_eq!(
            locate(
                "the same long line here\nother\nthe same long line here\n",
                "the same long lime here"
            ),
            Err(Reason::Ambiguous)
        );
        // 😀 is two UTF-16 units.
        assert_eq!(locate("😀 hi", "hi"), Ok((3, 5)));
    }

    #[test]
    fn an_edit_lands_where_its_text_moved() {
        let base = "alpha\nbeta\ngamma\n";
        let typed = owner(json!([[0, "new ", ""], 17]));
        let (merged, outcome) = run(base, &[typed], &[edit("gamma", "GAMMA")]);
        assert_eq!(merged, "new \nalpha\nbeta\nGAMMA\n");
        assert_eq!(outcome.applied, vec![0]);
        assert!(outcome.conflicts.is_empty());
    }

    #[test]
    fn the_owner_wins_inside_an_edit_but_not_beside_it() {
        let base = "one two three";
        let inside = owner(json!([5, [0, "X"], 8]));
        let (merged, outcome) = run(base, &[inside], &[edit("two", "2")]);
        assert_eq!(merged, "one tXwo three");
        assert_eq!(
            outcome.conflicts,
            vec![Conflict {
                index: 0,
                reason: Reason::EditedByOwner,
                current_text: "tXwo".into()
            }]
        );
        let edges = [
            owner(json!([4, [0, "<"], 9])),
            owner(json!([8, [0, ">"], 6])),
        ];
        let (merged, outcome) = run(base, &edges, &[edit("two", "2")]);
        assert_eq!(merged, "one <2> three");
        assert_eq!(outcome.applied, vec![0]);
    }

    #[test]
    fn overlapping_edits_apply_once_and_partial_success_is_normal() {
        let base = "a b c d";
        let (merged, outcome) = run(
            base,
            &[],
            &[
                edit("b c", "BC"),
                edit("c d", "CD"),
                edit("zzz", ""),
                edit("a", "A"),
            ],
        );
        assert_eq!(merged, "A BC d");
        assert_eq!(outcome.applied, vec![0, 3]);
        let reasons: Vec<_> = outcome.conflicts.iter().map(|c| c.reason).collect();
        assert_eq!(reasons, vec![Reason::OverlapsEdit, Reason::NotFound]);
    }

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

    /// Random owner typing around and inside random agent hunks: an applied
    /// hunk replaces exactly the text it was located at, and nothing the owner
    /// typed is lost.
    #[test]
    fn random_owner_edits_never_lose_owner_text() {
        let words = [
            "alpha", "beta", "gamma", "délta", "😀", "zeta", "eta", "theta",
        ];
        let mut random = Lcg(99);
        for round in 0..1500 {
            let base: String = (0..(4 + random.next(8)))
                .map(|i| format!("{}{} ", words[random.next(words.len())], i))
                .collect::<String>()
                + "\n";
            let base_tokens: Vec<&str> = base.split(' ').filter(|t| !t.trim().is_empty()).collect();
            let mut edits = Vec::new();
            for _ in 0..(1 + random.next(3)) {
                let token = base_tokens[random.next(base_tokens.len())];
                if base.matches(token).count() == 1 {
                    edits.push(edit(token, &format!("[{round}]")));
                }
            }
            let mut current = base.clone();
            let mut since = Vec::new();
            let mut inserted = Vec::new();
            for step in 0..random.next(5) {
                let units: Vec<usize> = current
                    .char_indices()
                    .map(|(i, _)| changes::utf16_of_byte(&current, i))
                    .chain(std::iter::once(changes::utf16_len(&current)))
                    .collect();
                let at = units[random.next(units.len())];
                let marker = format!("~{step}~");
                let set = changes::from_replacements(
                    changes::utf16_len(&current),
                    &[(at, at, marker.as_str())],
                );
                current = changes::apply(&current, &set).unwrap();
                since.push(owner(set));
                inserted.push(marker);
            }
            let outcome = merge(&base, &current, &since, &edits);
            let merged = match &outcome.changes {
                Some(set) => changes::apply(&current, set).unwrap(),
                None => current.clone(),
            };
            for marker in &inserted {
                assert!(merged.contains(marker), "{base:?} {current:?} {merged:?}");
            }
            for conflict in &outcome.conflicts {
                if conflict.reason == Reason::EditedByOwner {
                    assert!(merged.contains(&conflict.current_text));
                    assert!(current.contains(&conflict.current_text));
                }
            }
            let mut expected = current.clone();
            let mut applied: Vec<(usize, usize, &str)> = Vec::new();
            for index in &outcome.applied {
                let old = edits[*index].old_text.as_str();
                let found = current.find(old).expect("an applied hunk was untouched");
                let from = changes::utf16_of_byte(&current, found);
                applied.push((
                    from,
                    from + changes::utf16_len(old),
                    edits[*index].new_text.as_str(),
                ));
            }
            applied.sort_by_key(|r| r.0);
            if !applied.is_empty() {
                expected = changes::apply(
                    &current,
                    &changes::from_replacements(changes::utf16_len(&current), &applied),
                )
                .unwrap();
            }
            assert_eq!(merged, expected, "{base:?} {current:?}");
        }
    }
}
