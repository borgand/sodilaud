// SPDX-License-Identifier: GPL-3.0-or-later

// A small `.gitignore` matcher for the folder tree. It reads the files from the
// git top (or the root, outside a repository) down to the listed folder and
// answers whether one path is hidden. Pure apart from reading those files.

use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
enum Token {
    Literal(char),
    AnyRun,
    AnyOne,
    Class {
        negated: bool,
        ranges: Vec<(char, char)>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Segment {
    DoubleStar,
    Glob(Vec<Token>),
}

#[derive(Debug, Clone)]
struct Pattern {
    base: PathBuf,
    segments: Vec<Segment>,
    negated: bool,
    folders_only: bool,
}

#[derive(Debug, Default, Clone)]
pub struct IgnoreSet {
    patterns: Vec<Pattern>,
}

impl IgnoreSet {
    /// `.gitignore` files from the git top (nearest ancestor of `root`, root included, containing `.git`)
    /// or from `root` when there is none, down to `folder` (inclusive). Missing files are skipped.
    pub fn for_folder(root: &Path, folder: &Path) -> IgnoreSet {
        let top = root
            .ancestors()
            .find(|candidate| candidate.join(".git").exists())
            .unwrap_or(root);
        let mut set = IgnoreSet::default();
        let Ok(below) = folder.strip_prefix(top) else {
            return set;
        };
        let mut current = top.to_path_buf();
        let mut chain = vec![current.clone()];
        for component in below.components() {
            current.push(component);
            chain.push(current.clone());
        }
        for directory in chain {
            if let Ok(contents) = fs::read_to_string(directory.join(".gitignore")) {
                set.add(&directory, &contents);
            }
        }
        set
    }

    /// Parses one `.gitignore` whose folder is `base`.
    pub fn add(&mut self, base: &Path, contents: &str) {
        for line in contents.lines() {
            if let Some(pattern) = parse_line(base, line) {
                self.patterns.push(pattern);
            }
        }
    }

    /// `path` is absolute; `is_dir` says whether it is a folder. Later patterns win; a folder ignored
    /// on the way down from the git top ignores everything below it.
    pub fn is_ignored(&self, path: &Path, is_dir: bool) -> bool {
        let Some(top) = self
            .patterns
            .iter()
            .map(|pattern| &pattern.base)
            .filter(|base| path.starts_with(base))
            .min_by_key(|base| base.components().count())
        else {
            return false;
        };
        let Ok(below) = path.strip_prefix(top) else {
            return false;
        };
        let mut ancestor = top.to_path_buf();
        let mut components = below.components().peekable();
        while let Some(component) = components.next() {
            ancestor.push(component);
            if components.peek().is_none() {
                break;
            }
            if self.decide(&ancestor, true) {
                return true;
            }
        }
        self.decide(path, is_dir)
    }

    fn decide(&self, path: &Path, is_dir: bool) -> bool {
        let mut ignored = false;
        for pattern in &self.patterns {
            if pattern.folders_only && !is_dir {
                continue;
            }
            let Ok(relative) = path.strip_prefix(&pattern.base) else {
                continue;
            };
            let names: Vec<String> = relative
                .components()
                .map(|component| component.as_os_str().to_string_lossy().into_owned())
                .collect();
            if !names.is_empty() && match_segments(&pattern.segments, &names) {
                ignored = !pattern.negated;
            }
        }
        ignored
    }
}

fn parse_line(base: &Path, line: &str) -> Option<Pattern> {
    let mut text = line.to_string();
    while text.ends_with(' ') && !text.ends_with("\\ ") {
        text.pop();
    }
    if text.is_empty() || text.starts_with('#') {
        return None;
    }
    let negated = text.starts_with('!');
    if negated {
        text.remove(0);
    }
    let folders_only = text.ends_with('/');
    if folders_only {
        text.pop();
    }
    let leading_slash = text.starts_with('/');
    let parts: Vec<&str> = text.split('/').filter(|part| !part.is_empty()).collect();
    if parts.is_empty() {
        return None;
    }
    let anchored = leading_slash || parts.len() > 1;
    let mut segments = Vec::new();
    if !anchored {
        segments.push(Segment::DoubleStar);
    }
    for part in parts {
        segments.push(if part == "**" {
            Segment::DoubleStar
        } else {
            Segment::Glob(compile(part))
        });
    }
    Some(Pattern {
        base: base.to_path_buf(),
        segments,
        negated,
        folders_only,
    })
}

fn compile(text: &str) -> Vec<Token> {
    let chars: Vec<char> = text.chars().collect();
    let mut tokens = Vec::new();
    let mut index = 0;
    while index < chars.len() {
        match chars[index] {
            '\\' if index + 1 < chars.len() => {
                index += 1;
                tokens.push(Token::Literal(chars[index]));
            }
            '*' => {
                if tokens.last() != Some(&Token::AnyRun) {
                    tokens.push(Token::AnyRun);
                }
            }
            '?' => tokens.push(Token::AnyOne),
            '[' => match parse_class(&chars, index) {
                Some((token, next)) => {
                    tokens.push(token);
                    index = next;
                }
                None => tokens.push(Token::Literal('[')),
            },
            other => tokens.push(Token::Literal(other)),
        }
        index += 1;
    }
    tokens
}

/// Returns the class and the index of its closing bracket.
fn parse_class(chars: &[char], open: usize) -> Option<(Token, usize)> {
    let mut index = open + 1;
    let negated = matches!(chars.get(index), Some('!' | '^'));
    if negated {
        index += 1;
    }
    let mut ranges = Vec::new();
    let first = index;
    while let Some(&current) = chars.get(index) {
        if current == ']' && index > first {
            return Some((Token::Class { negated, ranges }, index));
        }
        if chars.get(index + 1) == Some(&'-') && chars.get(index + 2).is_some_and(|c| *c != ']') {
            ranges.push((current, chars[index + 2]));
            index += 3;
        } else {
            ranges.push((current, current));
            index += 1;
        }
    }
    None
}

fn match_segments(segments: &[Segment], names: &[String]) -> bool {
    match segments.split_first() {
        None => names.is_empty(),
        Some((Segment::DoubleStar, [])) => !names.is_empty(),
        Some((Segment::DoubleStar, rest)) => {
            (0..=names.len()).any(|skip| match_segments(rest, &names[skip..]))
        }
        Some((Segment::Glob(tokens), rest)) => match names.split_first() {
            Some((name, remaining)) => {
                let chars: Vec<char> = name.chars().collect();
                match_tokens(tokens, &chars) && match_segments(rest, remaining)
            }
            None => false,
        },
    }
}

fn match_tokens(tokens: &[Token], chars: &[char]) -> bool {
    match tokens.split_first() {
        None => chars.is_empty(),
        Some((Token::AnyRun, rest)) => {
            (0..=chars.len()).any(|skip| match_tokens(rest, &chars[skip..]))
        }
        Some((token, rest)) => match chars.split_first() {
            Some((&character, remaining)) => {
                let fits = match token {
                    Token::Literal(expected) => *expected == character,
                    Token::AnyOne => true,
                    Token::Class { negated, ranges } => {
                        ranges
                            .iter()
                            .any(|(low, high)| (*low..=*high).contains(&character))
                            != *negated
                    }
                    Token::AnyRun => unreachable!(),
                };
                fits && match_tokens(rest, remaining)
            }
            None => false,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!("sodilaud-ignore-{name}-{nanos}"));
        fs::create_dir_all(&directory).unwrap();
        directory.canonicalize().unwrap()
    }

    fn set(contents: &str) -> IgnoreSet {
        let mut set = IgnoreSet::default();
        set.add(Path::new("/r"), contents);
        set
    }

    fn file(set: &IgnoreSet, path: &str) -> bool {
        set.is_ignored(Path::new(path), false)
    }

    fn folder(set: &IgnoreSet, path: &str) -> bool {
        set.is_ignored(Path::new(path), true)
    }

    #[test]
    fn a_plain_name_matches_at_any_depth() {
        let set = set("build");
        assert!(folder(&set, "/r/build"));
        assert!(folder(&set, "/r/a/build"));
        assert!(file(&set, "/r/a/build"));
        assert!(!file(&set, "/r/a/builds"));
    }

    #[test]
    fn a_trailing_slash_matches_folders_only() {
        let set = set("out/");
        assert!(folder(&set, "/r/out"));
        assert!(!file(&set, "/r/out"));
        assert!(file(&set, "/r/out/a.md"));
    }

    #[test]
    fn a_leading_or_middle_slash_anchors_to_the_base() {
        let set = set("/top.md\ndocs/gen\n");
        assert!(file(&set, "/r/top.md"));
        assert!(!file(&set, "/r/a/top.md"));
        assert!(folder(&set, "/r/docs/gen"));
        assert!(!folder(&set, "/r/x/docs/gen"));
    }

    #[test]
    fn wildcards_and_classes() {
        let set = set("*.tmp.md\ndraft?.md\n[ab].md\n[!c].txt\n");
        assert!(file(&set, "/r/x.tmp.md"));
        assert!(!file(&set, "/r/x.md"));
        assert!(file(&set, "/r/draft1.md"));
        assert!(!file(&set, "/r/draft.md"));
        assert!(!file(&set, "/r/draft12.md"));
        assert!(file(&set, "/r/a.md"));
        assert!(file(&set, "/r/b.md"));
        assert!(!file(&set, "/r/c.md"));
        assert!(file(&set, "/r/d.txt"));
        assert!(!file(&set, "/r/c.txt"));
    }

    #[test]
    fn double_star_forms() {
        let set = set("**/cache\nlogs/**\na/**/b.md\n");
        assert!(folder(&set, "/r/cache"));
        assert!(folder(&set, "/r/x/y/cache"));
        assert!(file(&set, "/r/logs/one.md"));
        assert!(file(&set, "/r/logs/deep/one.md"));
        assert!(!folder(&set, "/r/logs"));
        assert!(file(&set, "/r/a/b.md"));
        assert!(file(&set, "/r/a/x/y/b.md"));
        assert!(!file(&set, "/r/b.md"));
    }

    #[test]
    fn negation_reincludes_unless_a_parent_folder_is_ignored() {
        let set = set("*.md\n!keep.md\n");
        assert!(file(&set, "/r/other.md"));
        assert!(!file(&set, "/r/keep.md"));
        let set = self::set("gen/\n!gen/keep.md\n");
        assert!(file(&set, "/r/gen/keep.md"));
    }

    #[test]
    fn comments_blank_lines_escapes_and_trailing_spaces() {
        let set = set("# x\n\n\\#hash.md\n\\!bang.md\nname.md   \n");
        assert!(file(&set, "/r/#hash.md"));
        assert!(file(&set, "/r/!bang.md"));
        assert!(file(&set, "/r/name.md"));
        assert!(!file(&set, "/r/x"));
        assert!(!file(&set, "/r/hash.md"));
    }

    #[test]
    fn the_git_top_gitignore_applies_to_a_subfolder_root() {
        let repo = scratch("top");
        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::create_dir_all(repo.join("docs")).unwrap();
        fs::write(repo.join(".gitignore"), "*.log.md\n").unwrap();
        let docs = repo.join("docs");
        let set = IgnoreSet::for_folder(&docs, &docs);
        assert!(set.is_ignored(&docs.join("a.log.md"), false));
        assert!(!set.is_ignored(&docs.join("a.md"), false));
    }

    #[test]
    fn without_git_only_files_from_the_root_down_apply() {
        let parent = scratch("nogit");
        let root = parent.join("r");
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(parent.join(".gitignore"), "*.md\n").unwrap();
        fs::write(root.join("sub/.gitignore"), "*.txt\n").unwrap();
        let sub = root.join("sub");
        let set = IgnoreSet::for_folder(&root, &sub);
        assert!(!set.is_ignored(&sub.join("a.md"), false));
        assert!(set.is_ignored(&sub.join("a.txt"), false));
    }
}
