// SPDX-License-Identifier: GPL-3.0-or-later

pub const PREVIEW_CHARS: usize = 80;
const DOTS: &str = "••••";
const SHORT_SECRET_CHARS: usize = 12;
const SECRET_NAMES: &[&str] = &["KEY", "TOKEN", "SECRET", "PASS", "PWD", "AUTH"];
const KNOWN_PREFIXES: &[(&str, usize)] = &[
    ("github_pat_", 40),
    ("ghp_", 20),
    ("gho_", 20),
    ("ghu_", 20),
    ("ghs_", 20),
    ("ghr_", 20),
    ("glpat-", 20),
    ("sk-ant-", 20),
    ("sk-proj-", 20),
    ("sk-", 20),
    ("xoxa-", 15),
    ("xoxb-", 15),
    ("xoxp-", 15),
    ("xoxr-", 15),
    ("xoxs-", 15),
    ("AIza", 30),
    ("npm_", 30),
    ("pypi-", 30),
    ("hvs.", 20),
    ("dop_v1_", 40),
    ("SG.", 30),
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Mask {
    None,
    /// `prefix` is how many bytes of the trimmed value may show before the dots:
    /// a token's known prefix, or the ordinary text in front of the first secret.
    Full {
        prefix: usize,
    },
    Partial {
        start: usize,
        end: usize,
    },
}

pub fn classify(value: &str) -> Mask {
    let trimmed = value.trim();
    const KEY_HEADER: &str = "PRIVATE KEY-----";
    if trimmed.contains("-----BEGIN") {
        if let Some(at) = trimmed.find(KEY_HEADER) {
            return Mask::Full {
                prefix: lead(trimmed, at + KEY_HEADER.len()),
            };
        }
    }
    if let Some(prefix) = known_token(trimmed) {
        return Mask::Full { prefix };
    }
    let embedded = trimmed
        .split_whitespace()
        .map(|word| word.trim_matches(|c| matches!(c, '"' | '\'' | ',' | ';')))
        .find(|word| known_token(word).is_some());
    if let Some(word) = embedded {
        let at = word.as_ptr() as usize - trimmed.as_ptr() as usize;
        return Mask::Full {
            prefix: lead(trimmed, at),
        };
    }
    if trimmed.lines().count() > 1 {
        return classify_lines(value);
    }
    if let Some((start, end)) = url_password(value).or_else(|| secret_assignment(value)) {
        return Mask::Partial { start, end };
    }
    if looks_random(trimmed) {
        return Mask::Full { prefix: 0 };
    }
    Mask::None
}

/// The preview shows only the first line, so that line gets the single-line
/// partial mask; a secret-named assignment further down masks everything.
fn classify_lines(value: &str) -> Mask {
    let mut offset = 0;
    let mut first = None;
    for line in value.split_inclusive('\n') {
        let line_start = offset;
        offset += line.len();
        if line.trim().is_empty() {
            continue;
        }
        if first.is_none() {
            first = Some((line_start, line));
        } else if secret_assignment(line).is_some() {
            let trimmed = value.trim();
            let skipped = value.len() - value.trim_start().len();
            return Mask::Full {
                prefix: lead(trimmed, line_start - skipped),
            };
        }
    }
    let Some((line_start, line)) = first else {
        return Mask::None;
    };
    match url_password(line).or_else(|| secret_assignment(line)) {
        Some((start, end)) => Mask::Partial {
            start: line_start + start,
            end: line_start + end,
        },
        None => Mask::None,
    }
}

/// Byte length of the ordinary text in front of a secret that starts at `secret_at`:
/// it stops at the end of the first line and before any secret on that line.
fn lead(trimmed: &str, secret_at: usize) -> usize {
    let first_line = trimmed.find('\n').unwrap_or(trimmed.len());
    let line = &trimmed[..first_line];
    let inline = url_password(line).or_else(|| secret_assignment(line));
    let end = inline.map_or(first_line, |(start, _)| start).min(secret_at);
    trimmed[..end].trim_end_matches(['\r', '\n']).len()
}

pub fn hint(value: &str, mask: &Mask) -> Option<String> {
    match *mask {
        Mask::None => None,
        Mask::Full { prefix } => {
            let secret = value.trim();
            let count = secret.chars().count();
            if count < SHORT_SECRET_CHARS {
                return Some(format!("•••••••• ({count})"));
            }
            let tail: String = secret.chars().skip(count - 4).collect();
            let suffix = format!("{DOTS}{tail} ({count})");
            let mut head = secret.get(..prefix).unwrap_or("").to_string();
            if head.contains(['\n', '\r']) || count < head.chars().count() + 8 {
                head.clear();
            }
            let line_break = secret
                .get(prefix..)
                .is_some_and(|rest| rest.starts_with(['\n', '\r']));
            if !head.is_empty() && line_break {
                head.push(' ');
            }
            let room = PREVIEW_CHARS - suffix.chars().count();
            if head.chars().count() > room {
                head = head.chars().take(room - 1).collect();
                head.push('…');
            }
            Some(format!("{head}{suffix}"))
        }
        Mask::Partial { start, end } => Some(format!(
            "{}{DOTS}{}",
            value.get(..start).unwrap_or(""),
            value.get(end..).unwrap_or("")
        )),
    }
}

pub fn preview(value: &str, max_chars: usize) -> (String, usize) {
    let trimmed = value.trim();
    let mut lines = trimmed.lines();
    let first = lines.next().unwrap_or("").trim();
    let extra = lines.count();
    let display: String = first
        .chars()
        .take(max_chars + 1)
        .map(display_char)
        .collect();
    if display.chars().count() <= max_chars {
        return (display, extra);
    }
    let mut cut: String = display.chars().take(max_chars.saturating_sub(1)).collect();
    cut.push('…');
    (cut, extra)
}

fn display_char(c: char) -> char {
    match c {
        '\t' => '⇥',
        '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{200E}' | '\u{200F}' => '�',
        c if c.is_control() => '�',
        c => c,
    }
}

fn known_token(word: &str) -> Option<usize> {
    let body_ok = |body: &str| {
        !body.is_empty()
            && body
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    for (prefix, min_len) in KNOWN_PREFIXES {
        if let Some(body) = word.strip_prefix(prefix) {
            if word.len() >= *min_len && body_ok(body) {
                return Some(prefix.len());
            }
        }
    }
    if (word.starts_with("AKIA") || word.starts_with("ASIA"))
        && word.len() == 20
        && word
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
    {
        return Some(4);
    }
    let segments: Vec<&str> = word.split('.').collect();
    let base64url = |s: &str| {
        !s.is_empty()
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '='))
    };
    if word.starts_with("eyJ")
        && word.len() >= 30
        && segments.len() == 3
        && segments.iter().all(|s| base64url(s))
    {
        return Some(3);
    }
    None
}

fn url_password(value: &str) -> Option<(usize, usize)> {
    let scheme_end = value.find("://")? + 3;
    let rest = &value[scheme_end..];
    let authority_len = rest
        .find(|c: char| matches!(c, '/' | '?' | '#') || c.is_whitespace())
        .unwrap_or(rest.len());
    let authority = &rest[..authority_len];
    let at = authority.rfind('@')?;
    let colon = authority[..at].find(':')?;
    let start = scheme_end + colon + 1;
    let end = scheme_end + at;
    (end > start).then_some((start, end))
}

fn secret_assignment(value: &str) -> Option<(usize, usize)> {
    let separator = value.find(['=', ':'])?;
    let name = value[..separator]
        .trim_start_matches(|c: char| matches!(c, '{' | ',') || c.is_whitespace());
    let name = name.trim();
    let name = name.strip_prefix("export ").unwrap_or(name).trim();
    let name = strip_quotes(name);
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
    {
        return None;
    }
    let upper = name.to_ascii_uppercase();
    if !SECRET_NAMES.iter().any(|secret| upper.contains(secret)) {
        return None;
    }
    let after = &value[separator + 1..];
    let mut start = separator + 1 + (after.len() - after.trim_start().len());
    let mut end = value.trim_end().len();
    let bytes = value.as_bytes();
    let quoted_end = value
        .trim_end_matches(|c: char| matches!(c, ',' | '}') || c.is_whitespace())
        .len();
    if quoted_end >= start + 2
        && matches!(bytes[start], b'"' | b'\'')
        && bytes[quoted_end - 1] == bytes[start]
    {
        start += 1;
        end = quoted_end - 1;
    }
    (end > start).then_some((start, end))
}

fn strip_quotes(name: &str) -> &str {
    for quote in ['"', '\''] {
        if let Some(inner) = name
            .strip_prefix(quote)
            .and_then(|rest| rest.strip_suffix(quote))
        {
            return inner;
        }
    }
    name
}

fn looks_random(value: &str) -> bool {
    if value.is_empty() || value.chars().any(char::is_whitespace) {
        return false;
    }
    if value.contains("://") || is_email(value) || is_identifier_like(value) {
        return false;
    }
    // `NAME=value` with a harmless name was already judged by secret_assignment.
    if let Some((name, _)) = value.split_once('=') {
        if !name.is_empty() && is_identifier_like(name) {
            return false;
        }
    }
    let length = value.chars().count();
    if length >= 16 {
        let hex_like = value.chars().any(|c| c.is_ascii_digit())
            && value.chars().all(|c| c.is_ascii_hexdigit() || c == '-');
        return hex_like || shannon_entropy(value) >= 3.5;
    }
    length >= 8 && character_classes(value) >= 3
}

fn is_email(value: &str) -> bool {
    let mut parts = value.split('@');
    match (parts.next(), parts.next(), parts.next()) {
        (Some(local), Some(domain), None) => {
            !local.is_empty() && domain.contains('.') && !domain.starts_with('.')
        }
        _ => false,
    }
}

fn is_identifier_like(value: &str) -> bool {
    value
        .split(['-', '_', '.', '/'])
        .filter(|piece| !piece.is_empty())
        .all(|piece| {
            piece.chars().all(char::is_alphabetic) || piece.chars().all(|c| c.is_ascii_digit())
        })
}

fn character_classes(value: &str) -> usize {
    let lower = value.chars().any(|c| c.is_lowercase());
    let upper = value.chars().any(|c| c.is_uppercase());
    let digit = value.chars().any(|c| c.is_ascii_digit());
    let symbol = value.chars().any(|c| !c.is_alphanumeric());
    [lower, upper, digit, symbol]
        .into_iter()
        .filter(|x| *x)
        .count()
}

fn shannon_entropy(value: &str) -> f64 {
    let mut counts = std::collections::HashMap::new();
    let mut total = 0.0;
    for c in value.chars() {
        *counts.entry(c).or_insert(0.0) += 1.0;
        total += 1.0;
    }
    counts
        .values()
        .map(|count: &f64| {
            let p = count / total;
            -p * p.log2()
        })
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn masked(value: &str) -> bool {
        classify(value) != Mask::None
    }

    #[test]
    fn known_tokens_are_fully_masked_with_their_prefix() {
        let cases = [
            ("ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8", "ghp_"),
            (
                "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
                "github_pat_",
            ),
            ("glpat-abcdefghijklmnopqrst", "glpat-"),
            ("sk-ant-api03-abcdefghijklmnopqrstuv", "sk-ant-"),
            ("sk-proj-abcdefghijklmnopqrstuv", "sk-proj-"),
            ("sk-abcdefghijklmnopqrstuvwx", "sk-"),
            ("xoxb-123456789012-abcdefghij", "xoxb-"),
            ("AKIAIOSFODNN7EXAMPLE", "AKIA"),
            ("ASIAIOSFODNN7EXAMPLE", "ASIA"),
            ("AIzaSyA1234567890abcdefghijklmnopqrs", "AIza"),
            ("npm_abcdefghijklmnopqrstuvwxyz0123456789", "npm_"),
            ("hvs.CAESIabcdefghijklmnop", "hvs."),
        ];
        for (value, prefix) in cases {
            assert_eq!(
                classify(value),
                Mask::Full {
                    prefix: prefix.len()
                },
                "{value}"
            );
        }
    }

    #[test]
    fn jwt_and_private_keys_are_masked() {
        assert!(masked("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"));
        assert_eq!(
            classify("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n"),
            Mask::Full {
                prefix: "-----BEGIN OPENSSH PRIVATE KEY-----".len()
            }
        );
    }

    #[test]
    fn token_inside_text_masks_the_whole_entry_after_its_leading_text() {
        let value = "curl -H \"Authorization: Bearer ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8\"";
        assert_eq!(
            classify(value),
            Mask::Full {
                prefix: value.find("ghp_").unwrap()
            }
        );
    }

    #[test]
    fn near_misses_are_not_known_tokens() {
        assert_eq!(classify("ghp"), Mask::None);
        assert_eq!(classify("sk-learn"), Mask::None);
        assert_eq!(classify("AKIA-docs"), Mask::None);
    }

    #[test]
    fn url_credentials_mask_only_the_password() {
        let value = "postgres://app:s3cr3tpw@db.internal:5432/main";
        let Mask::Partial { start, end } = classify(value) else {
            panic!("expected partial")
        };
        assert_eq!(&value[start..end], "s3cr3tpw");
        assert_eq!(classify("https://example.com/path?q=1"), Mask::None);
        assert_eq!(classify("https://user@example.com/"), Mask::None);
    }

    #[test]
    fn secret_named_assignments_mask_only_the_value() {
        let cases = [
            ("API_KEY=abc123def", "abc123def"),
            ("export GH_TOKEN=\"tok_value_1\"", "tok_value_1"),
            ("password: hunter2", "hunter2"),
            ("DB_PASSWORD='x y z'", "x y z"),
            ("Authorization: Bearer abc", "Bearer abc"),
        ];
        for (value, secret) in cases {
            let Mask::Partial { start, end } = classify(value) else {
                panic!("{value}")
            };
            assert_eq!(&value[start..end], secret, "{value}");
        }
        assert_eq!(classify("LOG_LEVEL=debug"), Mask::None);
        assert_eq!(classify("API_KEY="), Mask::None);
    }

    fn partial(value: &str) -> &str {
        let Mask::Partial { start, end } = classify(value) else {
            panic!("expected partial: {value:?}")
        };
        &value[start..end]
    }

    #[test]
    fn env_block_masks_the_visible_first_line() {
        let value = "DB_PASSWORD=hunter2hunter\nDB_HOST=localhost\nDB_PORT=5432\n";
        assert_eq!(partial(value), "hunter2hunter");
        let url = "\n  postgres://app:s3cr3tpw@db/main\nsecond line";
        assert_eq!(partial(url), "s3cr3tpw");
    }

    #[test]
    fn env_block_with_a_later_secret_is_fully_masked() {
        assert_eq!(
            classify("DB_HOST=localhost\nDB_PORT=5432\nDB_PASSWORD=hunter2hunter"),
            Mask::Full {
                prefix: "DB_HOST=localhost".len()
            }
        );
    }

    #[test]
    fn json_style_assignments_mask_only_the_value() {
        assert_eq!(partial(r#"{"password": "x"}"#), "x");
        assert_eq!(partial(r#""api_key": "abc","#), "abc");
        assert_eq!(partial(r#"  , "token":"t0k3n" }"#), "t0k3n");
    }

    #[test]
    fn ordinary_multi_line_text_stays_visible() {
        assert_eq!(classify("hello\nworld"), Mask::None);
        assert_eq!(classify("fn main() {\n    run();\n}"), Mask::None);
    }

    #[test]
    fn random_looking_values_are_masked() {
        for value in [
            "550e8400-e29b-41d4-a716-446655440000",
            "9f86d081884c7d659a2feaa0c55ad015",
            "dGhpcyBpcyBhIHNlY3JldCB2YWx1ZQ==",
            "Zq8vR2mXw4LpT9sKj3Nb",
            "Hunter2!x",
            "Tr0ub4dor&3",
        ] {
            assert!(masked(value), "{value}");
        }
    }

    #[test]
    fn ordinary_values_stay_visible() {
        for value in [
            "sodilaud-infra",
            "DATABASE_URL",
            "src/main.js",
            "feat/add-search",
            "v1.2.3",
            "2026-09-25",
            "10.0.0.1",
            "user@example.com",
            "getUserAccountSettingsHandler",
            "aaaaaaaaaaaaaaaaaaaaaaaa",
            "hello world, this is a sentence",
            "a1b2c3d4",
            "",
        ] {
            assert_eq!(classify(value), Mask::None, "{value}");
        }
    }

    #[test]
    fn hints_expose_at_most_prefix_and_four_characters() {
        assert_eq!(
            hint(
                "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
                &classify("ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8")
            )
            .unwrap(),
            "ghp_••••Q7r8 (40)"
        );
        assert_eq!(
            hint("Zq8vR2mXw4LpT9sKj3Nb", &Mask::Full { prefix: 0 }).unwrap(),
            "••••j3Nb (20)"
        );
        assert_eq!(
            hint("Hunter2!x", &Mask::Full { prefix: 0 }).unwrap(),
            "•••••••• (9)"
        );
        let url = "postgres://app:s3cr3tpw@db";
        assert_eq!(hint(url, &classify(url)).unwrap(), "postgres://app:••••@db");
        assert_eq!(hint("plain", &Mask::None), None);
    }

    fn shown(value: &str) -> String {
        hint(value, &classify(value)).unwrap()
    }

    #[test]
    fn hints_show_the_text_in_front_of_an_embedded_secret() {
        let note = "## Start writing\n- Create a scratchpad with `Cmd/Ctrl+N`.\nAPI_TOKEN=fas32faw03lasdk3j5";
        let count = note.chars().count();
        assert_eq!(shown(note), format!("## Start writing ••••k3j5 ({count})"));
        let curl = "curl -H \"Authorization: Bearer ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8\"";
        assert_eq!(
            shown(curl),
            "curl -H \"Authorization: Bearer ••••7r8\" (72)"
        );
        let key = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----";
        assert!(shown(key).starts_with("-----BEGIN OPENSSH PRIVATE KEY----- ••••"));
    }

    #[test]
    fn hints_stop_at_a_secret_on_the_first_line() {
        let value = "API_KEY=abc123def\nnotes\nDB_PASSWORD=hunter2hunter";
        assert!(shown(value).starts_with("API_KEY=••••"), "{}", shown(value));
        let url = "postgres://app:s3cr3tpw@db ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
        assert!(
            shown(url).starts_with("postgres://app:••••"),
            "{}",
            shown(url)
        );
    }

    #[test]
    fn long_leading_text_is_cut_so_the_dots_and_tail_stay_visible() {
        let value = format!("{}\nAPI_TOKEN=fas32faw03lasdk3j5", "word ".repeat(20));
        let hint = shown(&value);
        assert!(hint.chars().count() <= PREVIEW_CHARS, "{hint}");
        assert!(hint.contains("…••••k3j5 ("), "{hint}");
        assert_eq!(preview(&hint, PREVIEW_CHARS).0, hint);
    }

    #[test]
    fn leading_text_is_dropped_when_fewer_than_four_characters_would_stay_hidden() {
        assert_eq!(
            hint("abcd efgh", &Mask::Full { prefix: 5 }).unwrap(),
            "•••••••• (9)"
        );
        assert_eq!(
            hint("abcdef ghijklm", &Mask::Full { prefix: 7 }).unwrap(),
            "••••jklm (14)"
        );
    }

    #[test]
    fn hint_never_leaks_more_than_four_secret_characters() {
        let secrets = [
            "Zq8vR2mXw4LpT9sKj3Nb",
            "9f86d081884c7d659a2feaa0c55ad015",
            "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
        ];
        let embedded = [
            (
                "see ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8 here",
                "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
            ),
            (
                "# Notes\nsome text\nAPI_TOKEN=fas32faw03lasdk3j5",
                "fas32faw03lasdk3j5",
            ),
            (
                "API_KEY=abc123defghi\nDB_PASSWORD=hunter2hunter",
                "abc123defghi",
            ),
        ];
        for (value, secret) in embedded {
            let shown = shown(value);
            let leaked = (5..=secret.len()).any(|n| {
                secret
                    .as_bytes()
                    .windows(n)
                    .any(|w| shown.contains(std::str::from_utf8(w).unwrap()))
            });
            assert!(!leaked, "{value:?} -> {shown}");
        }
        for secret in secrets {
            let mask = classify(secret);
            let Mask::Full { prefix } = mask else {
                panic!("{secret}")
            };
            let shown = hint(secret, &mask).unwrap();
            let body = &secret[prefix..];
            let leaked = (5..=body.len()).any(|n| {
                body.as_bytes()
                    .windows(n)
                    .any(|w| shown.contains(std::str::from_utf8(w).unwrap()))
            });
            assert!(!leaked, "{secret} -> {shown}");
        }
    }

    #[test]
    fn preview_truncates_and_counts_extra_lines() {
        assert_eq!(preview("one\ntwo\nthree", 50), ("one".to_string(), 2));
        assert_eq!(preview("a\tb", 50), ("a⇥b".to_string(), 0));
        let long = "x".repeat(60);
        let (text, extra) = preview(&long, 50);
        assert_eq!((text.chars().count(), extra), (50, 0));
        assert!(text.ends_with('…'));
        assert_eq!(preview("  \n  padded  \n", 50), ("padded".to_string(), 0));
        let (text, extra) = preview(&format!("{}\nsecond", "y".repeat(65_536)), 50);
        assert_eq!((text.chars().count(), extra), (50, 1));
        assert_eq!(preview(&"z".repeat(50), 50).0, "z".repeat(50));
    }

    #[test]
    fn preview_and_hint_are_char_safe() {
        let emoji = "👍🏽".repeat(40);
        let (text, _) = preview(&emoji, 50);
        assert!(text.chars().count() <= 50);
        for value in [
            "é",
            "ééééééééééééééééééé",
            "パスワード=秘密の値です",
            "user:pässwörd@host",
            "a://b:é@c",
        ] {
            let mask = classify(value);
            let _ = hint(value, &mask);
            let _ = preview(value, 50);
        }
    }

    #[test]
    fn bidi_controls_are_neutralized() {
        let (text, _) = preview("abc\u{202E}fed\u{2066}x", 50);
        assert!(!text.contains('\u{202E}') && !text.contains('\u{2066}'));
        assert!(text.contains('�'));
    }
}
