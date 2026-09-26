# Clipboard History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An opt-in, macOS-only, RAM-only clipboard history with a hotkey popup, fixed TTL, secret masking, and a menu-bar icon, without letting any clipboard value reach disk, logs, localStorage, or MCP.

**Architecture:** A Rust `clipboard` module owns the history (`Zeroizing<String>` values) and the pasteboard. The pure parts (store, detection, service, geometry, tray glyph) compile on every platform and are unit-tested in CI. The macOS parts (pasteboard, watcher, popup, tray, lifecycle) are `#[cfg(target_os = "macos")]`. A separate `clipboard` webview window with its own capability file renders the popup and can call only four `clip_*` commands plus `core:window:allow-destroy`. The main window configures the feature through `clip_set_config` and never sees entries.

**Tech Stack:** Tauri 2.11, Rust (`zeroize`, `objc2` 0.6, `objc2-app-kit`/`objc2-foundation` 0.3, `core-graphics` 0.25, `libc`, `tauri-plugin-global-shortcut` 2), vanilla ES modules, `node --test` with jsdom.

**Spec:** `docs/superpowers/specs/2026-09-25-clipboard-history-design.md`

## Global Constraints

- Clipboard values never reach disk, localStorage, the workspace DB, logs (stdout/stderr), the MCP snapshot, or the network.
- macOS only. On Windows and Linux the feature is not built, the settings section is hidden, there is no tray, and closing the window quits as today.
- Defaults: disabled; capacity 10 (range 1-50); TTL 10 min (range 1-120); hotkey `super+shift+KeyV` (shown as `⌘⇧V`); auto-paste off.
- TTL is fixed from the first copy. Re-copy and picking never extend it.
- Values larger than 64 KiB (`65536` bytes UTF-8) are not captured.
- Popup: horizontally centered, top edge at 1/3 of `NSScreen.mainScreen` height, width 440 logical px.
- Every `.rs` and `.js` file starts with `// SPDX-License-Identifier: GPL-3.0-or-later`.
- No logging macros (`println!`, `eprintln!`, `print!`, `eprint!`, `dbg!`, `log::`) anywhere under `src-tauri/src/clipboard/`. No `console`, `localStorage`, `sessionStorage`, `indexedDB`, `fetch`, or `import` in `src/clipboard.js`.
- Commit messages: `type(clipboard): description`, ending with `Co-Authored-By: Claude Code <noreply@anthropic.com>`.
- CI runs on Ubuntu, so every task that touches macOS code must also pass `cargo clippy --locked --all-targets -- -D warnings` and `cargo test --locked` **locally on macOS**.
- Branch: `feat/clipboard-history`. Do not push.

## Review Focus

1. **Multibyte, emoji, and bidi-control text** (`é`, `👍🏽`, U+202E): previews and hints must never panic on a char boundary, and bidi controls must not reorder the popup row. Pinned in Task 2 (`preview_and_hint_are_char_safe`, `bidi_controls_are_neutralized`).
2. **Re-copying a value already in history** must not clear the user's fresh system clipboard, even though the duplicate value is dropped. Pinned in Task 3 (`recopy_moves_to_top_without_clearing_pasteboard`).
3. **Laptop sleep across the TTL**: Rust's `Instant` stops during sleep on macOS, so an entry could outlive its TTL by hours. The clock must use `CLOCK_MONOTONIC`, which counts sleep on Darwin. Pinned in Task 4 (`monotonic_clock_advances`) and in the manual checklist (Task 9).
4. **Corrupted or out-of-range stored settings** (`"capacity": "lots"`, `-5`, `9999`, broken JSON): these must clamp to defaults without breaking startup. Pinned in Task 3 (`config_normalizes_out_of_range`) and Task 8 (`normalizes corrupt stored settings`).
5. **A panic inside clipboard code** can print the offending string to stderr (for example, "byte index 5 is not a char boundary … of `<value>`"). A panic hook must silence panics raised from `src/clipboard/`. Pinned in Task 4 (`panic_filter_matches_clipboard_files`).

## File Structure

| File | Responsibility |
|---|---|
| `src-tauri/src/clipboard/mod.rs` | Module wiring and `cfg` gates |
| `src-tauri/src/clipboard/store.rs` | Generic ordered history: capacity, dedupe, TTL, removal (pure) |
| `src-tauri/src/clipboard/detect.rs` | `classify`, `hint`, `preview` (pure) |
| `src-tauri/src/clipboard/service.rs` | `Pasteboard` trait, `Service`, `ClipConfig`, `ListItem`, `ClipError` (pure) |
| `src-tauri/src/clipboard/layout.rs` | Popup geometry and tray glyph bitmap (pure) |
| `src-tauri/src/clipboard/pasteboard.rs` | macOS `NSPasteboard` implementation of `Pasteboard` |
| `src-tauri/src/clipboard/hygiene.rs` | macOS `mlock`, core-dump limit, monotonic clock, panic silencing |
| `src-tauri/src/clipboard/watcher.rs` | macOS polling thread |
| `src-tauri/src/clipboard/runtime.rs` | macOS `ClipboardRuntime` state: config, service, watcher, hotkey, focus |
| `src-tauri/src/clipboard/popup.rs` | macOS popup window, focus restore, auto-paste |
| `src-tauri/src/clipboard/tray.rs` | macOS tray icon and menu, main-window hide and show, quit request |
| `src-tauri/src/clipboard/commands.rs` | Tauri commands (all platforms; non-macOS returns `Unsupported`) |
| `src-tauri/capabilities/clipboard.json` | Capability for the `clipboard` window |
| `src/clipboard.html`, `src/clipboard.css`, `src/clipboard.js` | Popup page |
| `src/clipboard-settings.js` | Settings model: defaults, normalize, load and save, accelerator helpers (pure) |
| `src/clipboard-settings-ui.js` | Settings section and modal wiring for the main window |
| `test/clipboard-*.test.js` | JS tests and guard tests |
| `docs/clipboard-history.md` | User doc and manual macOS checklist |

---

### Task 1: History store

**Files:**
- Modify: `src-tauri/Cargo.toml` (add `zeroize`)
- Create: `src-tauri/src/clipboard/mod.rs`
- Create: `src-tauri/src/clipboard/store.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod clipboard;` next to `mod mcp;`)

**Interfaces:**
- Produces: `clipboard::store::{History<V>, Entry<V>}` with
  `History::new(capacity: usize, ttl_ms: u64)`, `push(&mut self, V, now_ms: u64) -> Vec<V>` (returns evicted values only), `get(u64) -> Option<&Entry<V>>`, `remove(u64) -> Option<V>`, `reap_expired(now_ms) -> Vec<V>`, `set_limits(capacity, ttl_ms) -> Vec<V>`, `clear() -> Vec<V>`, `entries() -> impl Iterator<Item=&Entry<V>>` (newest first), `len()`, `is_empty()`, `remaining_ms(&Entry<V>, now_ms) -> u64`. `Entry { id: u64, value: V, copied_at_ms: u64 }`. `V: AsRef<str>`.

- [ ] **Step 1: Add the dependency and module skeleton**

In `src-tauri/Cargo.toml` `[dependencies]` add:
```toml
zeroize = "1"
```

Create `src-tauri/src/clipboard/mod.rs`:
```rust
// SPDX-License-Identifier: GPL-3.0-or-later

// Clipboard history. Values live only in this module's memory: they must never be
// logged, persisted, or passed to the MCP snapshot.

pub mod store;
```

In `src-tauri/src/lib.rs`, add `mod clipboard;` beside the existing `mod mcp;` declaration.

- [ ] **Step 2: Write the failing tests**

Create `src-tauri/src/clipboard/store.rs` containing only the test module first:
```rust
// SPDX-License-Identifier: GPL-3.0-or-later

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    const TTL: u64 = 10_000;

    fn texts(history: &History<String>) -> Vec<&str> {
        history.entries().map(|entry| entry.value.as_str()).collect()
    }

    struct Tracked {
        text: String,
        drops: Rc<RefCell<Vec<String>>>,
    }

    impl AsRef<str> for Tracked {
        fn as_ref(&self) -> &str {
            &self.text
        }
    }

    impl Drop for Tracked {
        fn drop(&mut self) {
            self.drops.borrow_mut().push(self.text.clone());
        }
    }

    #[test]
    fn newest_entry_comes_first() {
        let mut history = History::new(10, TTL);
        history.push("a".to_string(), 0);
        history.push("b".to_string(), 1);
        assert_eq!(texts(&history), ["b", "a"]);
    }

    #[test]
    fn capacity_evicts_and_returns_the_oldest() {
        let mut history = History::new(2, TTL);
        history.push("a".to_string(), 0);
        history.push("b".to_string(), 1);
        let evicted = history.push("c".to_string(), 2);
        assert_eq!(evicted, ["a"]);
        assert_eq!(texts(&history), ["c", "b"]);
    }

    #[test]
    fn recopy_moves_to_top_and_keeps_id_and_copy_time() {
        let mut history = History::new(10, TTL);
        history.push("a".to_string(), 0);
        let id = history.entries().next().unwrap().id;
        history.push("b".to_string(), 1);
        let evicted = history.push("a".to_string(), 500);
        assert!(evicted.is_empty());
        assert_eq!(texts(&history), ["a", "b"]);
        let top = history.entries().next().unwrap();
        assert_eq!((top.id, top.copied_at_ms), (id, 0));
    }

    #[test]
    fn duplicate_value_is_dropped_inside_push() {
        let drops = Rc::new(RefCell::new(Vec::new()));
        let make = |text: &str| Tracked { text: text.into(), drops: drops.clone() };
        let mut history = History::new(10, TTL);
        history.push(make("a"), 0);
        history.push(make("a"), 1);
        assert_eq!(*drops.borrow(), ["a"]);
        assert_eq!(history.len(), 1);
    }

    #[test]
    fn reap_expires_exactly_at_ttl_from_copy_time() {
        let mut history = History::new(10, TTL);
        history.push("old".to_string(), 0);
        history.push("new".to_string(), 5_000);
        assert!(history.reap_expired(TTL - 1).is_empty());
        assert_eq!(history.reap_expired(TTL), ["old"]);
        assert_eq!(texts(&history), ["new"]);
    }

    #[test]
    fn remaining_ms_counts_down_and_saturates() {
        let mut history = History::new(10, TTL);
        history.push("a".to_string(), 1_000);
        let entry = history.entries().next().unwrap();
        assert_eq!(history.remaining_ms(entry, 1_000), TTL);
        assert_eq!(history.remaining_ms(entry, 50_000), 0);
    }

    #[test]
    fn remove_returns_value_and_ignores_unknown_ids() {
        let mut history = History::new(10, TTL);
        history.push("a".to_string(), 0);
        let id = history.entries().next().unwrap().id;
        assert_eq!(history.remove(id + 99), None);
        assert_eq!(history.remove(id).as_deref(), Some("a"));
        assert!(history.is_empty());
    }

    #[test]
    fn lowering_capacity_evicts_oldest() {
        let mut history = History::new(3, TTL);
        for (index, text) in ["a", "b", "c"].iter().enumerate() {
            history.push(text.to_string(), index as u64);
        }
        assert_eq!(history.set_limits(1, TTL), ["b", "a"]);
        assert_eq!(texts(&history), ["c"]);
    }

    #[test]
    fn ttl_change_applies_to_existing_entries() {
        let mut history = History::new(10, TTL);
        history.push("a".to_string(), 0);
        history.set_limits(10, 1_000);
        assert_eq!(history.reap_expired(1_000), ["a"]);
    }

    #[test]
    fn clear_returns_everything() {
        let mut history = History::new(10, TTL);
        history.push("a".to_string(), 0);
        history.push("b".to_string(), 1);
        assert_eq!(history.clear(), ["b", "a"]);
        assert!(history.is_empty());
    }

    #[test]
    fn ids_are_unique_and_fit_in_a_javascript_number() {
        let mut history = History::new(10, TTL);
        history.push("a".to_string(), 0);
        history.push("b".to_string(), 1);
        let ids: Vec<u64> = history.entries().map(|entry| entry.id).collect();
        assert_ne!(ids[0], ids[1]);
        assert!(ids.iter().all(|id| *id < (1 << 53)));
    }
}
```
Also add `pub mod store;` in `mod.rs` (done in Step 1).

- [ ] **Step 3: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml clipboard::store`
Expected: compile errors, `cannot find type History`.

- [ ] **Step 4: Implement the store above the test module**

```rust
use std::collections::VecDeque;

pub struct Entry<V> {
    pub id: u64,
    pub value: V,
    pub copied_at_ms: u64,
}

/// Newest-first history. Every method that removes values hands them back so the
/// caller can clear the system clipboard before the values drop (and wipe).
pub struct History<V> {
    entries: VecDeque<Entry<V>>,
    capacity: usize,
    ttl_ms: u64,
    next_id: u64,
}

impl<V: AsRef<str>> History<V> {
    pub fn new(capacity: usize, ttl_ms: u64) -> Self {
        Self {
            entries: VecDeque::new(),
            capacity: capacity.max(1),
            ttl_ms,
            next_id: 1,
        }
    }

    pub fn entries(&self) -> impl Iterator<Item = &Entry<V>> {
        self.entries.iter()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn remaining_ms(&self, entry: &Entry<V>, now_ms: u64) -> u64 {
        entry
            .copied_at_ms
            .saturating_add(self.ttl_ms)
            .saturating_sub(now_ms)
    }

    /// A value already present moves to the top with its original id and copy
    /// time; the duplicate is dropped here, never returned, because the system
    /// clipboard still legitimately holds it.
    pub fn push(&mut self, value: V, now_ms: u64) -> Vec<V> {
        if let Some(index) = self
            .entries
            .iter()
            .position(|entry| entry.value.as_ref() == value.as_ref())
        {
            if let Some(existing) = self.entries.remove(index) {
                self.entries.push_front(existing);
            }
            return Vec::new();
        }
        let id = self.next_id;
        self.next_id += 1;
        self.entries.push_front(Entry {
            id,
            value,
            copied_at_ms: now_ms,
        });
        self.evict_overflow()
    }

    pub fn get(&self, id: u64) -> Option<&Entry<V>> {
        self.entries.iter().find(|entry| entry.id == id)
    }

    pub fn remove(&mut self, id: u64) -> Option<V> {
        let index = self.entries.iter().position(|entry| entry.id == id)?;
        self.entries.remove(index).map(|entry| entry.value)
    }

    pub fn reap_expired(&mut self, now_ms: u64) -> Vec<V> {
        let ttl_ms = self.ttl_ms;
        let mut expired = Vec::new();
        let mut kept = VecDeque::with_capacity(self.entries.len());
        for entry in self.entries.drain(..) {
            if now_ms >= entry.copied_at_ms.saturating_add(ttl_ms) {
                expired.push(entry.value);
            } else {
                kept.push_back(entry);
            }
        }
        self.entries = kept;
        expired
    }

    pub fn set_limits(&mut self, capacity: usize, ttl_ms: u64) -> Vec<V> {
        self.capacity = capacity.max(1);
        self.ttl_ms = ttl_ms;
        self.evict_overflow()
    }

    pub fn clear(&mut self) -> Vec<V> {
        self.entries.drain(..).map(|entry| entry.value).collect()
    }

    fn evict_overflow(&mut self) -> Vec<V> {
        let mut evicted = Vec::new();
        while self.entries.len() > self.capacity {
            if let Some(entry) = self.entries.pop_back() {
                evicted.push(entry.value);
            }
        }
        evicted
    }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml clipboard::store`
Expected: 11 passed. Also run `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`. If dead-code warnings fire because nothing uses `History` yet, add `#![allow(dead_code)]` at the top of `clipboard/mod.rs` with the comment `// Removed once the runtime wires the module in (Task 5).` and remove it in Task 5.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/src/clipboard
git commit -m "feat(clipboard): add in-memory history store with TTL and dedupe"
```

---

### Task 2: Secret detection, hints, and previews

**Files:**
- Create: `src-tauri/src/clipboard/detect.rs`
- Modify: `src-tauri/src/clipboard/mod.rs` (add `pub mod detect;`)

**Interfaces:**
- Produces: `detect::Mask { None, Full { prefix: usize }, Partial { start: usize, end: usize } }` (byte offsets, always on char boundaries; `Full.prefix` is relative to `value.trim()`); `detect::classify(&str) -> Mask`; `detect::hint(&str, &Mask) -> Option<String>` (`None` for `Mask::None`); `detect::preview(&str, max_chars: usize) -> (String, usize)` (single display line, extra line count); `detect::PREVIEW_CHARS: usize = 50`.

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/clipboard/detect.rs` with the test module:
```rust
// SPDX-License-Identifier: GPL-3.0-or-later

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
            ("github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz", "github_pat_"),
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
            assert_eq!(classify(value), Mask::Full { prefix: prefix.len() }, "{value}");
        }
    }

    #[test]
    fn jwt_and_private_keys_are_masked() {
        assert!(masked("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"));
        assert_eq!(
            classify("-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n"),
            Mask::Full { prefix: 0 }
        );
    }

    #[test]
    fn token_inside_text_masks_the_whole_entry() {
        assert_eq!(
            classify("curl -H \"Authorization: Bearer ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8\""),
            Mask::Full { prefix: 0 }
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
        let Mask::Partial { start, end } = classify(value) else { panic!("expected partial") };
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
            let Mask::Partial { start, end } = classify(value) else { panic!("{value}") };
            assert_eq!(&value[start..end], secret, "{value}");
        }
        assert_eq!(classify("LOG_LEVEL=debug"), Mask::None);
        assert_eq!(classify("API_KEY="), Mask::None);
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
            hint("ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8", &classify("ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8")).unwrap(),
            "ghp_••••Q7r8 (40)"
        );
        assert_eq!(hint("Zq8vR2mXw4LpT9sKj3Nb", &Mask::Full { prefix: 0 }).unwrap(), "••••j3Nb (20)");
        assert_eq!(hint("Hunter2!x", &Mask::Full { prefix: 0 }).unwrap(), "•••••••• (9)");
        let url = "postgres://app:s3cr3tpw@db";
        assert_eq!(hint(url, &classify(url)).unwrap(), "postgres://app:••••@db");
        assert_eq!(hint("plain", &Mask::None), None);
    }

    #[test]
    fn hint_never_leaks_more_than_four_secret_characters() {
        let secrets = [
            "Zq8vR2mXw4LpT9sKj3Nb",
            "9f86d081884c7d659a2feaa0c55ad015",
            "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
        ];
        for secret in secrets {
            let mask = classify(secret);
            let Mask::Full { prefix } = mask else { panic!("{secret}") };
            let shown = hint(secret, &mask).unwrap();
            let body = &secret[prefix..];
            let leaked = (5..=body.len()).any(|n| body.as_bytes().windows(n).any(|w| shown.contains(std::str::from_utf8(w).unwrap())));
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
    }

    #[test]
    fn preview_and_hint_are_char_safe() {
        let emoji = "👍🏽".repeat(40);
        let (text, _) = preview(&emoji, 50);
        assert!(text.chars().count() <= 50);
        for value in ["é", "ééééééééééééééééééé", "パスワード=秘密の値です", "user:pässwörd@host", "a://b:é@c"] {
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
```
Add `pub mod detect;` to `clipboard/mod.rs`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml clipboard::detect`
Expected: compile errors, `cannot find type Mask`.

- [ ] **Step 3: Implement detection above the test module**

```rust
pub const PREVIEW_CHARS: usize = 50;
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
    Full { prefix: usize },
    Partial { start: usize, end: usize },
}

pub fn classify(value: &str) -> Mask {
    if value.contains("-----BEGIN") && value.contains("PRIVATE KEY-----") {
        return Mask::Full { prefix: 0 };
    }
    let trimmed = value.trim();
    if let Some(prefix) = known_token(trimmed) {
        return Mask::Full { prefix };
    }
    let embedded = value
        .split_whitespace()
        .map(|word| word.trim_matches(|c| matches!(c, '"' | '\'' | ',' | ';')))
        .any(|word| known_token(word).is_some());
    if embedded {
        return Mask::Full { prefix: 0 };
    }
    if trimmed.lines().count() > 1 {
        return Mask::None;
    }
    if let Some((start, end)) = url_password(value).or_else(|| secret_assignment(value)) {
        return Mask::Partial { start, end };
    }
    if looks_random(trimmed) {
        return Mask::Full { prefix: 0 };
    }
    Mask::None
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
            let head = secret.get(..prefix).unwrap_or("");
            Some(format!("{head}{DOTS}{tail} ({count})"))
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
    let display: String = first.chars().map(display_char).collect();
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
            && s
                .chars()
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
    let name = value[..separator].trim();
    let name = name.strip_prefix("export ").unwrap_or(name).trim();
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
    if end >= start + 2
        && matches!(bytes[start], b'"' | b'\'')
        && bytes[end - 1] == bytes[start]
    {
        start += 1;
        end -= 1;
    }
    (end > start).then_some((start, end))
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
    [lower, upper, digit, symbol].into_iter().filter(|x| *x).count()
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml clipboard::detect`
Expected: all pass. If a case in `random_looking_values_are_masked` or `ordinary_values_stay_visible` fails, it is a rule bug, not a test bug. Fix the rule and keep the spec's bias: when in doubt, mask. The only case you may change is `Zq8vR2mXw4LpT9sKj3Nb`, and only if its entropy is under 3.5. In that case replace it with another 20-character mixed-case alphanumeric value that clears the threshold.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/clipboard
git commit -m "feat(clipboard): detect secrets and build masked hints and previews"
```

---

### Task 3: Service, config, and pasteboard abstraction

**Files:**
- Create: `src-tauri/src/clipboard/service.rs`
- Modify: `src-tauri/src/clipboard/mod.rs` (add `pub mod service;`)

**Interfaces:**
- Consumes: `store::History`, `detect::{classify, hint, preview, PREVIEW_CHARS, Mask}`.
- Produces:
  - `service::Secret = zeroize::Zeroizing<String>`, `MAX_VALUE_BYTES: usize = 65536`
  - `trait Pasteboard { fn change_count(&self) -> i64; fn is_own_write(&self) -> bool; fn read_text(&self) -> Option<Secret>; fn write_text(&self, value: &str) -> bool; fn clear_if_equals(&self, value: &str) -> bool; }`
  - `struct ClipConfig { enabled: bool, capacity: usize, ttl_minutes: u64, hotkey: String, auto_paste: bool }` (serde `camelCase`, `Deserialize + Serialize + Clone + PartialEq + Debug`), `ClipConfig::normalized(self) -> Self`, `ClipConfig::ttl_ms(&self) -> u64`, `impl Default`
  - `struct ListItem { id: u64, text: String, masked: bool, seconds_left: u64, extra_lines: usize }` (`Serialize`, camelCase)
  - `struct ClipListing { ttl_minutes: u64, items: Vec<ListItem> }` (`Serialize`, camelCase)
  - `enum ClipError { Unsupported, Disabled, WrongWindow, HotkeyInvalid, HotkeyUnavailable, Internal }` (`Serialize`, serializes as the variant name string)
  - `Service<P: Pasteboard>` with `new(P, capacity, ttl_ms)`, `poll(&mut self, now_ms)`, `list(&self, now_ms) -> Vec<ListItem>`, `reveal(&self, id) -> Option<Secret>`, `select(&mut self, id) -> bool`, `delete(&mut self, id) -> bool`, `set_limits(&mut self, capacity, ttl_ms, now_ms)`, `wipe(&mut self)`, `len(&self) -> usize`. `Drop` calls `wipe`.

- [ ] **Step 1: Add the serde-derived config tests and service tests**

Create `src-tauri/src/clipboard/service.rs` with the test module:
```rust
// SPDX-License-Identifier: GPL-3.0-or-later

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::rc::Rc;

    #[derive(Default)]
    struct FakeState {
        count: Cell<i64>,
        text: RefCell<Option<String>>,
        own: Cell<bool>,
        writes: RefCell<Vec<String>>,
        clears: RefCell<Vec<String>>,
    }

    #[derive(Clone, Default)]
    struct Fake(Rc<FakeState>);

    impl Fake {
        fn copy(&self, text: &str) {
            *self.0.text.borrow_mut() = Some(text.to_string());
            self.0.own.set(false);
            self.0.count.set(self.0.count.get() + 1);
        }
        fn current(&self) -> Option<String> {
            self.0.text.borrow().clone()
        }
    }

    impl Pasteboard for Fake {
        fn change_count(&self) -> i64 {
            self.0.count.get()
        }
        fn is_own_write(&self) -> bool {
            self.0.own.get()
        }
        fn read_text(&self) -> Option<Secret> {
            self.0.text.borrow().clone().map(Secret::new)
        }
        fn write_text(&self, value: &str) -> bool {
            *self.0.text.borrow_mut() = Some(value.to_string());
            self.0.own.set(true);
            self.0.count.set(self.0.count.get() + 1);
            self.0.writes.borrow_mut().push(value.to_string());
            true
        }
        fn clear_if_equals(&self, value: &str) -> bool {
            if self.0.text.borrow().as_deref() != Some(value) {
                return false;
            }
            *self.0.text.borrow_mut() = None;
            self.0.count.set(self.0.count.get() + 1);
            self.0.clears.borrow_mut().push(value.to_string());
            true
        }
    }

    const TTL: u64 = 60_000;

    fn service_with(fake: &Fake, capacity: usize) -> Service<Fake> {
        Service::new(fake.clone(), capacity, TTL)
    }

    fn texts(service: &Service<Fake>) -> Vec<String> {
        service.list(0).into_iter().map(|item| item.text).collect()
    }

    #[test]
    fn captures_each_new_copy_once() {
        let fake = Fake::default();
        let mut service = service_with(&fake, 10);
        fake.copy("repo-name");
        service.poll(0);
        service.poll(1);
        assert_eq!(texts(&service), ["repo-name"]);
    }

    #[test]
    fn ignores_what_was_on_the_clipboard_before_enabling() {
        let fake = Fake::default();
        fake.copy("before");
        let mut service = service_with(&fake, 10);
        service.poll(0);
        assert_eq!(service.len(), 0);
    }

    #[test]
    fn ignores_empty_whitespace_and_oversized_values() {
        let fake = Fake::default();
        let mut service = service_with(&fake, 10);
        for value in ["", "   \n\t", &"x".repeat(MAX_VALUE_BYTES + 1)] {
            fake.copy(value);
            service.poll(0);
        }
        assert_eq!(service.len(), 0);
        fake.copy(&"y".repeat(MAX_VALUE_BYTES));
        service.poll(0);
        assert_eq!(service.len(), 1);
    }

    #[test]
    fn own_writes_are_not_recaptured() {
        let fake = Fake::default();
        let mut service = service_with(&fake, 10);
        fake.copy("a");
        service.poll(0);
        fake.copy("b");
        service.poll(0);
        let id = service.list(0).last().unwrap().id;
        assert!(service.select(id));
        service.poll(0);
        assert_eq!(texts(&service), ["b", "a"]);
        assert_eq!(fake.current().as_deref(), Some("a"));
    }

    #[test]
    fn expiry_clears_the_pasteboard_only_when_it_still_holds_the_value() {
        let fake = Fake::default();
        let mut service = service_with(&fake, 10);
        fake.copy("old");
        service.poll(0);
        fake.copy("new");
        service.poll(30_000);
        service.poll(TTL);
        assert_eq!(texts(&service), ["new"]);
        assert!(fake.0.clears.borrow().is_empty());
        service.poll(30_000 + TTL);
        assert_eq!(service.len(), 0);
        assert_eq!(*fake.0.clears.borrow(), ["new"]);
        assert_eq!(fake.current(), None);
    }

    #[test]
    fn recopy_moves_to_top_without_clearing_pasteboard() {
        let fake = Fake::default();
        let mut service = service_with(&fake, 10);
        fake.copy("a");
        service.poll(0);
        fake.copy("b");
        service.poll(0);
        fake.copy("a");
        service.poll(0);
        assert_eq!(texts(&service), ["a", "b"]);
        assert_eq!(fake.current().as_deref(), Some("a"));
        assert!(fake.0.clears.borrow().is_empty());
    }

    #[test]
    fn delete_removes_and_clears_matching_pasteboard() {
        let fake = Fake::default();
        let mut service = service_with(&fake, 10);
        fake.copy("secret-token-value");
        service.poll(0);
        let id = service.list(0)[0].id;
        assert!(service.delete(id));
        assert!(!service.delete(id));
        assert_eq!(service.len(), 0);
        assert_eq!(fake.current(), None);
    }

    #[test]
    fn unknown_ids_are_no_ops() {
        let fake = Fake::default();
        let mut service = service_with(&fake, 10);
        assert!(!service.select(42));
        assert!(service.reveal(42).is_none());
        assert!(fake.0.writes.borrow().is_empty());
    }

    #[test]
    fn list_masks_secrets_and_reports_time_left() {
        let fake = Fake::default();
        let mut service = service_with(&fake, 10);
        fake.copy("sodilaud-infra");
        service.poll(0);
        fake.copy("ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8");
        service.poll(1_000);
        let items = service.list(31_000);
        assert_eq!(items[0].text, "ghp_••••Q7r8 (40)");
        assert!(items[0].masked);
        assert_eq!(items[0].seconds_left, 30);
        assert_eq!(items[1].text, "sodilaud-infra");
        assert!(!items[1].masked);
        assert_eq!(
            service.reveal(items[0].id).as_deref().map(String::as_str),
            Some("ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8")
        );
    }

    #[test]
    fn lowering_limits_evicts_and_expires_with_clearing() {
        let fake = Fake::default();
        let mut service = service_with(&fake, 10);
        fake.copy("a");
        service.poll(0);
        fake.copy("b");
        service.poll(0);
        service.set_limits(1, 1_000, 500);
        assert_eq!(texts(&service), ["b"]);
        service.set_limits(1, 100, 500);
        assert_eq!(service.len(), 0);
        assert_eq!(*fake.0.clears.borrow(), ["b"]);
    }

    #[test]
    fn wipe_and_drop_clear_everything() {
        let fake = Fake::default();
        let mut service = service_with(&fake, 10);
        fake.copy("a");
        service.poll(0);
        service.wipe();
        assert_eq!(service.len(), 0);
        assert_eq!(fake.current(), None);

        fake.copy("b");
        service.poll(0);
        drop(service);
        assert_eq!(fake.current(), None);
    }

    #[test]
    fn config_normalizes_out_of_range() {
        let config = ClipConfig {
            enabled: true,
            capacity: 0,
            ttl_minutes: 9_999,
            hotkey: "  ".into(),
            auto_paste: false,
        }
        .normalized();
        assert_eq!((config.capacity, config.ttl_minutes), (1, 120));
        assert_eq!(config.hotkey, ClipConfig::default().hotkey);
        assert_eq!(ClipConfig { capacity: 99, ..ClipConfig::default() }.normalized().capacity, 50);
        assert_eq!(ClipConfig::default().ttl_ms(), 600_000);
    }

    #[test]
    fn config_deserializes_camel_case() {
        let config: ClipConfig = serde_json::from_str(
            r#"{"enabled":true,"capacity":5,"ttlMinutes":3,"hotkey":"super+shift+KeyV","autoPaste":true}"#,
        )
        .unwrap();
        assert_eq!((config.capacity, config.ttl_minutes, config.auto_paste), (5, 3, true));
    }

    #[test]
    fn errors_serialize_without_payload() {
        assert_eq!(serde_json::to_string(&ClipError::HotkeyUnavailable).unwrap(), "\"HotkeyUnavailable\"");
    }
}
```
Add `pub mod service;` to `mod.rs`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml clipboard::service`
Expected: compile errors, `cannot find trait Pasteboard`.

- [ ] **Step 3: Implement the service above the test module**

```rust
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use super::detect::{classify, hint, preview, Mask, PREVIEW_CHARS};
use super::store::History;

pub type Secret = Zeroizing<String>;

pub const MAX_VALUE_BYTES: usize = 64 * 1024;
pub const MIN_CAPACITY: usize = 1;
pub const MAX_CAPACITY: usize = 50;
pub const MIN_TTL_MINUTES: u64 = 1;
pub const MAX_TTL_MINUTES: u64 = 120;
pub const DEFAULT_HOTKEY: &str = "super+shift+KeyV";

pub trait Pasteboard {
    fn change_count(&self) -> i64;
    /// True when the current pasteboard contents were written by Sodilaud.
    fn is_own_write(&self) -> bool;
    /// `None` for non-text contents and for text over `MAX_VALUE_BYTES`.
    fn read_text(&self) -> Option<Secret>;
    fn write_text(&self, value: &str) -> bool;
    fn clear_if_equals(&self, value: &str) -> bool;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipConfig {
    pub enabled: bool,
    pub capacity: usize,
    pub ttl_minutes: u64,
    pub hotkey: String,
    pub auto_paste: bool,
}

impl Default for ClipConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            capacity: 10,
            ttl_minutes: 10,
            hotkey: DEFAULT_HOTKEY.to_string(),
            auto_paste: false,
        }
    }
}

impl ClipConfig {
    pub fn normalized(self) -> Self {
        let hotkey = self.hotkey.trim().to_string();
        Self {
            capacity: self.capacity.clamp(MIN_CAPACITY, MAX_CAPACITY),
            ttl_minutes: self.ttl_minutes.clamp(MIN_TTL_MINUTES, MAX_TTL_MINUTES),
            hotkey: if hotkey.is_empty() { DEFAULT_HOTKEY.to_string() } else { hotkey },
            ..self
        }
    }

    pub fn ttl_ms(&self) -> u64 {
        self.ttl_minutes * 60_000
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListItem {
    pub id: u64,
    pub text: String,
    pub masked: bool,
    pub seconds_left: u64,
    pub extra_lines: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipListing {
    pub ttl_minutes: u64,
    pub items: Vec<ListItem>,
}

/// Payload-free so an error can never carry a clipboard value to the webview.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ClipError {
    Unsupported,
    Disabled,
    WrongWindow,
    HotkeyInvalid,
    HotkeyUnavailable,
    Internal,
}

pub struct Service<P: Pasteboard> {
    history: History<Secret>,
    pasteboard: P,
    last_change: i64,
}

impl<P: Pasteboard> Service<P> {
    pub fn new(pasteboard: P, capacity: usize, ttl_ms: u64) -> Self {
        let last_change = pasteboard.change_count();
        Self {
            history: History::new(capacity, ttl_ms),
            pasteboard,
            last_change,
        }
    }

    pub fn len(&self) -> usize {
        self.history.len()
    }

    pub fn poll(&mut self, now_ms: u64) {
        let change = self.pasteboard.change_count();
        if change != self.last_change {
            self.last_change = change;
            if !self.pasteboard.is_own_write() {
                if let Some(text) = self.pasteboard.read_text() {
                    if text.len() <= MAX_VALUE_BYTES && !text.trim().is_empty() {
                        let evicted = self.history.push(text, now_ms);
                        self.discard(evicted);
                    }
                }
            }
        }
        let expired = self.history.reap_expired(now_ms);
        self.discard(expired);
    }

    pub fn list(&self, now_ms: u64) -> Vec<ListItem> {
        self.history
            .entries()
            .map(|entry| {
                let value = entry.value.as_str();
                let mask = classify(value);
                let (text, extra_lines) = match hint(value, &mask) {
                    Some(shown) => (preview(&shown, PREVIEW_CHARS).0, 0),
                    None => preview(value, PREVIEW_CHARS),
                };
                ListItem {
                    id: entry.id,
                    text,
                    masked: mask != Mask::None,
                    seconds_left: self.history.remaining_ms(entry, now_ms).div_ceil(1000),
                    extra_lines,
                }
            })
            .collect()
    }

    pub fn reveal(&self, id: u64) -> Option<Secret> {
        self.history
            .get(id)
            .map(|entry| Zeroizing::new(entry.value.as_str().to_owned()))
    }

    pub fn select(&mut self, id: u64) -> bool {
        let Some(entry) = self.history.get(id) else {
            return false;
        };
        let written = self.pasteboard.write_text(entry.value.as_str());
        self.last_change = self.pasteboard.change_count();
        written
    }

    pub fn delete(&mut self, id: u64) -> bool {
        match self.history.remove(id) {
            Some(value) => {
                self.pasteboard.clear_if_equals(&value);
                true
            }
            None => false,
        }
    }

    pub fn set_limits(&mut self, capacity: usize, ttl_ms: u64, now_ms: u64) {
        let evicted = self.history.set_limits(capacity, ttl_ms);
        self.discard(evicted);
        let expired = self.history.reap_expired(now_ms);
        self.discard(expired);
    }

    pub fn wipe(&mut self) {
        let all = self.history.clear();
        self.discard(all);
    }

    fn discard(&self, values: Vec<Secret>) {
        for value in values {
            self.pasteboard.clear_if_equals(&value);
        }
    }
}

impl<P: Pasteboard> Drop for Service<P> {
    fn drop(&mut self) {
        self.wipe();
    }
}
```
Note: `seconds_left` rounds up, so a fresh 60 s entry shows `60` and one with 29,001 ms left shows `30`. The test at `31_000` with TTL 60,000 and copy at 1,000 has exactly 30,000 ms left, which gives `30`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --manifest-path src-tauri/Cargo.toml clipboard::`
Expected: all store, detect, and service tests pass. Also run clippy with `-D warnings`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/clipboard
git commit -m "feat(clipboard): add history service with pasteboard clearing and config"
```

---

### Task 4: macOS pasteboard, memory hygiene, and watcher thread

**Files:**
- Modify: `src-tauri/Cargo.toml` (macOS target dependencies)
- Create: `src-tauri/src/clipboard/pasteboard.rs`, `hygiene.rs`, `watcher.rs`
- Modify: `src-tauri/src/clipboard/mod.rs`

**Interfaces:**
- Consumes: `service::{Pasteboard, Secret, Service, MAX_VALUE_BYTES}`.
- Produces (macOS only):
  - `pasteboard::MacPasteboard` (unit struct, `impl Pasteboard + Send`)
  - `hygiene::{now_ms() -> u64, lock_memory(ptr: *const u8, len: usize), disable_core_dumps(), silence_clipboard_panics(), is_clipboard_location(file: &str) -> bool}`
  - `watcher::{Watcher, SharedService = Arc<Mutex<Option<Service<MacPasteboard>>>>, spawn(on_panic: impl Fn() + Send + 'static, service: SharedService) -> Watcher}`. Dropping a `Watcher` stops and joins the thread.
  - `hygiene::is_clipboard_location` compiles on every platform (tested in CI). Everything else in these three files is macOS only.

- [ ] **Step 1: Add macOS dependencies**

Append to `src-tauri/Cargo.toml`:
```toml
[target.'cfg(target_os = "macos")'.dependencies]
tauri = { version = "2", features = ["tray-icon"] }
tauri-plugin-global-shortcut = "2"
objc2 = "0.6"
objc2-foundation = { version = "0.3", features = ["NSString", "NSArray", "NSGeometry"] }
objc2-app-kit = { version = "0.3", features = ["NSPasteboard", "NSWorkspace", "NSRunningApplication", "NSScreen", "NSApplication", "NSResponder"] }
core-graphics = "0.25"
libc = "0.2"
```
The `tray-icon` feature is macOS-only on purpose: on Linux it would need `libayatana-appindicator` in CI.

Run: `cargo build --locked --manifest-path src-tauri/Cargo.toml` (drop `--locked` for this first build so the lockfile updates, then commit `Cargo.lock`).

- [ ] **Step 2: Write the failing tests**

Create `src-tauri/src/clipboard/hygiene.rs`:
```rust
// SPDX-License-Identifier: GPL-3.0-or-later

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panic_filter_matches_clipboard_files() {
        assert!(is_clipboard_location("src/clipboard/detect.rs"));
        assert!(is_clipboard_location("src\\clipboard\\service.rs"));
        assert!(!is_clipboard_location("src/mcp.rs"));
        assert!(!is_clipboard_location("/Users/x/.cargo/registry/src/tauri/lib.rs"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn monotonic_clock_advances() {
        let first = now_ms();
        std::thread::sleep(std::time::Duration::from_millis(20));
        assert!(now_ms() >= first + 15);
    }
}
```

Create `src-tauri/src/clipboard/pasteboard.rs` with an ignored round-trip test that touches the real pasteboard. It runs only on demand, because it overwrites your clipboard:
```rust
// SPDX-License-Identifier: GPL-3.0-or-later

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "overwrites the real macOS clipboard; run with --ignored"]
    fn round_trip_marks_and_clears_own_writes() {
        let pasteboard = MacPasteboard;
        assert!(pasteboard.write_text("sodilaud-clipboard-test"));
        assert!(pasteboard.is_own_write());
        assert_eq!(pasteboard.read_text().as_deref().map(String::as_str), Some("sodilaud-clipboard-test"));
        assert!(!pasteboard.clear_if_equals("something else"));
        assert!(pasteboard.clear_if_equals("sodilaud-clipboard-test"));
        assert!(pasteboard.read_text().is_none());
    }
}
```

Update `mod.rs`:
```rust
// SPDX-License-Identifier: GPL-3.0-or-later

// Clipboard history. Values live only in this module's memory: they must never be
// logged, persisted, or passed to the MCP snapshot.

pub mod detect;
pub mod hygiene;
pub mod service;
pub mod store;

#[cfg(target_os = "macos")]
pub mod pasteboard;
#[cfg(target_os = "macos")]
pub mod watcher;
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml clipboard::hygiene`
Expected: compile errors, `cannot find function is_clipboard_location`.

- [ ] **Step 4: Implement `hygiene.rs`** (above its tests)

```rust
/// Panic messages for string slicing include the string itself, so a panic raised
/// from this module must not reach the default hook, which prints to stderr.
pub fn is_clipboard_location(file: &str) -> bool {
    let normalized = file.replace('\\', "/");
    normalized.contains("src/clipboard/")
}

#[cfg(target_os = "macos")]
pub fn silence_clipboard_panics() {
    use std::sync::Once;
    static INSTALL: Once = Once::new();
    INSTALL.call_once(|| {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let from_clipboard = info
                .location()
                .is_some_and(|location| is_clipboard_location(location.file()));
            if !from_clipboard {
                previous(info);
            }
        }));
    });
}

/// Darwin's CLOCK_MONOTONIC keeps counting while the machine sleeps, unlike
/// `Instant`, so a TTL cannot be outlived by closing the lid.
#[cfg(target_os = "macos")]
pub fn now_ms() -> u64 {
    let mut spec = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    // SAFETY: `spec` is a valid, writable timespec.
    unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut spec) };
    (spec.tv_sec as u64) * 1000 + (spec.tv_nsec as u64) / 1_000_000
}

/// Best effort: keeps a value's pages out of swap. Failure is ignored because
/// macOS encrypts swap anyway.
#[cfg(target_os = "macos")]
pub fn lock_memory(ptr: *const u8, len: usize) {
    if len == 0 {
        return;
    }
    // SAFETY: the range is a live allocation owned by the caller.
    unsafe { libc::mlock(ptr.cast(), len) };
}

/// Lowers only the soft limit, for the rest of the process lifetime.
#[cfg(target_os = "macos")]
pub fn disable_core_dumps() {
    let mut limit = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
    // SAFETY: `limit` is a valid rlimit for both calls.
    unsafe {
        if libc::getrlimit(libc::RLIMIT_CORE, &mut limit) == 0 {
            limit.rlim_cur = 0;
            libc::setrlimit(libc::RLIMIT_CORE, &limit);
        }
    }
}
```
Change `pub mod hygiene;` in `mod.rs` so that `lock_memory`, `now_ms`, `disable_core_dumps`, and `silence_clipboard_panics` are the `cfg`-gated items. The module itself stays cross-platform so the filter test runs in CI.

- [ ] **Step 5: Implement `pasteboard.rs`** (above its tests)

```rust
use objc2::rc::autoreleasepool;
use objc2_app_kit::{NSPasteboard, NSPasteboardContentsOptions, NSPasteboardTypeString};
use objc2_foundation::{NSArray, NSString};
use subtle::ConstantTimeEq;

use super::hygiene::lock_memory;
use super::service::{Pasteboard, Secret, MAX_VALUE_BYTES};

const OWN_MARKER: &str = "io.github.borgand.sodilaud.clip";
// nspasteboard.org conventions: clipboard managers skip concealed and transient data.
const CONCEALED: &str = "org.nspasteboard.ConcealedType";
const TRANSIENT: &str = "org.nspasteboard.TransientType";

/// The general pasteboard is fetched per call; AppKit hands back a shared instance.
pub struct MacPasteboard;

fn general() -> objc2::rc::Retained<NSPasteboard> {
    NSPasteboard::generalPasteboard()
}

impl Pasteboard for MacPasteboard {
    fn change_count(&self) -> i64 {
        general().changeCount() as i64
    }

    fn is_own_write(&self) -> bool {
        general().types().is_some_and(|types| {
            types.iter().any(|kind| kind.to_string() == OWN_MARKER)
        })
    }

    fn read_text(&self) -> Option<Secret> {
        autoreleasepool(|pool| {
            // SAFETY: NSPasteboardTypeString is an immutable AppKit constant.
            let string = general().stringForType(unsafe { NSPasteboardTypeString })?;
            // SAFETY: the borrowed str does not outlive `pool`.
            let text = unsafe { string.to_str(pool) };
            if text.len() > MAX_VALUE_BYTES {
                return None;
            }
            let mut owned = String::with_capacity(text.len());
            owned.push_str(text);
            lock_memory(owned.as_ptr(), owned.capacity());
            Some(Secret::new(owned))
        })
    }

    fn write_text(&self, value: &str) -> bool {
        let pasteboard = general();
        // CurrentHostOnly keeps the value off Universal Clipboard.
        pasteboard.prepareForNewContentsWithOptions(NSPasteboardContentsOptions::CurrentHostOnly);
        let markers = [CONCEALED, TRANSIENT, OWN_MARKER].map(NSString::from_str);
        // SAFETY: NSPasteboardTypeString is an immutable AppKit constant.
        let text_type = unsafe { NSPasteboardTypeString };
        let mut types = vec![text_type.copy()];
        types.extend(markers.iter().map(|marker| marker.copy()));
        // SAFETY: owner nil is allowed; types are valid pasteboard type strings.
        unsafe { pasteboard.addTypes_owner(&NSArray::from_retained_slice(&types), None) };
        let written = pasteboard.setString_forType(&NSString::from_str(value), text_type);
        for marker in &markers {
            pasteboard.setString_forType(&NSString::from_str(""), marker);
        }
        written
    }

    fn clear_if_equals(&self, value: &str) -> bool {
        let Some(current) = self.read_text() else {
            return false;
        };
        let equal: bool = current.as_bytes().ct_eq(value.as_bytes()).into();
        if equal {
            general().clearContents();
        }
        equal
    }
}
```
These signatures follow `objc2-app-kit` 0.3.2. If the compiler reports that a call is (or isn't) `unsafe`, or that a method takes a different receiver or argument type, follow the compiler and https://docs.rs/objc2-app-kit/0.3.2. Keep the behavior as written: current-host-only, the three marker types, a constant-time compare, and never logging.

- [ ] **Step 6: Implement `watcher.rs`**

```rust
// SPDX-License-Identifier: GPL-3.0-or-later

use std::panic::{self, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use super::hygiene::now_ms;
use super::pasteboard::MacPasteboard;
use super::service::Service;

pub type SharedService = Arc<Mutex<Option<Service<MacPasteboard>>>>;

const POLL_INTERVAL: Duration = Duration::from_millis(250);

pub struct Watcher {
    stop: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

/// Polls the pasteboard every 250 ms. A panic wipes the history (dropping the
/// service wipes and clears the pasteboard) and then calls `on_panic`.
pub fn spawn(on_panic: impl Fn() + Send + 'static, service: SharedService) -> Watcher {
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = stop.clone();
    let handle = thread::Builder::new()
        .name("clipboard-watcher".into())
        .spawn(move || {
            let outcome = panic::catch_unwind(AssertUnwindSafe(|| {
                while !thread_stop.load(Ordering::Relaxed) {
                    if let Some(active) = service
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .as_mut()
                    {
                        active.poll(now_ms());
                    }
                    thread::sleep(POLL_INTERVAL);
                }
            }));
            if outcome.is_err() {
                service.lock().unwrap_or_else(PoisonError::into_inner).take();
                on_panic();
            }
        })
        .ok();
    Watcher { stop, handle }
}

impl Drop for Watcher {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}
```

- [ ] **Step 7: Run tests**

Run on macOS:
```bash
cargo test --manifest-path src-tauri/Cargo.toml clipboard::
cargo test --manifest-path src-tauri/Cargo.toml clipboard::pasteboard -- --ignored
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```
Expected: all pass. The ignored round-trip test passes and leaves your clipboard empty.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/clipboard
git commit -m "feat(clipboard): read and write the macOS pasteboard and poll it in a watcher"
```

---

### Task 5: Runtime, commands, capabilities, and guard tests

**Files:**
- Create: `src-tauri/src/clipboard/runtime.rs` (macOS), `src-tauri/src/clipboard/commands.rs`
- Create: `src-tauri/capabilities/clipboard.json`
- Modify: `src-tauri/src/clipboard/mod.rs`, `src-tauri/src/lib.rs` (`run`), `src-tauri/build.rs`, `src-tauri/capabilities/default.json`
- Modify: `test/command-permissions.test.js`
- Create: `test/clipboard-boundary.test.js`

**Interfaces:**
- Consumes: `Service`, `MacPasteboard`, `watcher::{spawn, Watcher, SharedService}`, `hygiene::*`, `ClipConfig`, `ClipListing`, `ClipError`.
- Produces:
  - `runtime::ClipboardRuntime` (`Default`, managed state) with `apply_config(&self, app: &AppHandle, requested: ClipConfig) -> ConfigStatus`, `listing(&self) -> ClipListing`, `reveal(&self, id) -> Option<Secret>`, `select(&self, id) -> bool`, `delete(&self, id) -> bool`, `clear(&self)`, `len(&self) -> usize`, `config(&self) -> ClipConfig`, `shutdown(&self)`
  - `runtime::ConfigStatus { enabled: bool, hotkey: String, hotkey_error: Option<ClipError>, accessibility_trusted: bool }` (`Serialize`, camelCase)
  - `runtime::STOPPED_EVENT = "clipboard-history-stopped"`
  - Commands: `clip_list(window) -> Result<ClipListing, ClipError>`, `clip_reveal(window, id: u64) -> Result<String, ClipError>`, `clip_select(window, id: u64) -> Result<bool, ClipError>`, `clip_delete(window, id: u64) -> Result<bool, ClipError>`, `clip_set_config(app, config: ClipConfig) -> Result<ConfigStatus, ClipError>`
  - In this task, hotkey registration is a stub that returns `Ok(())`. Task 6 replaces it.

- [ ] **Step 1: Write the failing guard tests**

Replace `test/command-permissions.test.js` with:
```js
// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const POPUP_COMMANDS = ["clip_list", "clip_reveal", "clip_select", "clip_delete"];

async function capabilities() {
  const files = await readdir("src-tauri/capabilities");
  return Promise.all(files.filter(f => f.endsWith(".json")).map(async f =>
    JSON.parse(await readFile(`src-tauri/capabilities/${f}`, "utf8"))));
}

test("every registered command is declared and permissioned", async () => {
  const [lib, build, caps] = await Promise.all([
    readFile("src-tauri/src/lib.rs", "utf8"),
    readFile("src-tauri/build.rs", "utf8"),
    capabilities()
  ]);
  const handlerList = lib.match(/generate_handler!\[([^\]]*)\]/)?.[1] ?? "";
  const registered = handlerList
    .split(",")
    .map((entry) => entry.trim().split("::").pop())
    .filter(Boolean);
  assert.ok(registered.length >= 20, `expected the handler list to parse, got ${registered.length}`);

  const granted = new Set(caps.flatMap(cap => cap.permissions));
  for (const command of registered) {
    assert.ok(build.includes(`"${command}"`), `build.rs must declare ${command}`);
    assert.ok(granted.has(`allow-${command.replaceAll("_", "-")}`), `some capability must grant ${command}`);
  }
});

test("popup commands are granted only to the clipboard window", async () => {
  const caps = await capabilities();
  const main = caps.find(cap => cap.identifier === "default");
  const popup = caps.find(cap => cap.identifier === "clipboard");
  assert.deepEqual(main.windows, ["main"]);
  assert.deepEqual(popup.windows, ["clipboard"]);
  for (const command of POPUP_COMMANDS) {
    assert.ok(!main.permissions.includes(`allow-${command.replaceAll("_", "-")}`), `main must not grant ${command}`);
  }
  assert.deepEqual(
    [...popup.permissions].sort(),
    ["allow-clip-delete", "allow-clip-list", "allow-clip-reveal", "allow-clip-select", "core:window:allow-destroy"]
  );
  assert.ok(main.permissions.includes("allow-clip-set-config"));
});
```

Create `test/clipboard-boundary.test.js`:
```js
// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const RUST_DIR = "src-tauri/src/clipboard";

async function rustSources() {
  const files = (await readdir(RUST_DIR)).filter(f => f.endsWith(".rs"));
  return Promise.all(files.map(async f => [f, await readFile(`${RUST_DIR}/${f}`, "utf8")]));
}

test("clipboard Rust code never logs", async () => {
  for (const [file, source] of await rustSources()) {
    assert.doesNotMatch(source, /\b(?:e?println!|e?print!|dbg!|log::|tracing::)/, `${file} must not log`);
  }
});

test("MCP code does not reach the clipboard module", async () => {
  const mcp = await readFile("src-tauri/src/mcp.rs", "utf8");
  assert.doesNotMatch(mcp, /clipboard::/);
});

test("only the popup page calls popup commands", async () => {
  const files = (await readdir("src")).filter(f => f.endsWith(".js") && f !== "clipboard.js");
  for (const file of files) {
    const source = await readFile(`src/${file}`, "utf8");
    const calls = source.match(/["'`]clip_[a-z_]+["'`]/g) ?? [];
    for (const call of calls) {
      assert.equal(call.slice(1, -1), "clip_set_config", `${file} must not call ${call}`);
    }
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/command-permissions.test.js test/clipboard-boundary.test.js`
Expected: FAIL. `clipboard` capability not found, and `allow-clip-set-config` is missing.

- [ ] **Step 3: Implement `runtime.rs`**

```rust
// SPDX-License-Identifier: GPL-3.0-or-later

use std::sync::{Mutex, PoisonError};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::hygiene::{disable_core_dumps, now_ms, silence_clipboard_panics};
use super::pasteboard::MacPasteboard;
use super::service::{ClipConfig, ClipError, ClipListing, Secret, Service};
use super::watcher::{self, SharedService, Watcher};

pub const STOPPED_EVENT: &str = "clipboard-history-stopped";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigStatus {
    pub enabled: bool,
    pub hotkey: String,
    pub hotkey_error: Option<ClipError>,
    pub accessibility_trusted: bool,
}

#[derive(Default)]
pub struct ClipboardRuntime {
    service: SharedService,
    watcher: Mutex<Option<Watcher>>,
    config: Mutex<ClipConfig>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl ClipboardRuntime {
    pub fn config(&self) -> ClipConfig {
        lock(&self.config).clone()
    }

    pub fn apply_config(&self, app: &AppHandle, requested: ClipConfig) -> ConfigStatus {
        let requested = requested.normalized();
        let previous = self.config();
        let mut applied = requested.clone();
        let mut hotkey_error = None;

        if requested.enabled {
            let old = previous.enabled.then_some(previous.hotkey.as_str());
            if old != Some(requested.hotkey.as_str()) {
                if let Err(error) = register_hotkey(app, &requested.hotkey, old) {
                    hotkey_error = Some(error);
                    applied.hotkey = previous.hotkey.clone();
                }
            }
            self.start_or_update(app, &applied);
        } else {
            if previous.enabled {
                unregister_hotkey(app, &previous.hotkey);
            }
            self.stop();
        }

        *lock(&self.config) = applied.clone();
        ConfigStatus {
            enabled: applied.enabled,
            hotkey: applied.hotkey,
            hotkey_error,
            accessibility_trusted: accessibility_trusted(),
        }
    }

    fn start_or_update(&self, app: &AppHandle, config: &ClipConfig) {
        let mut service = lock(&self.service);
        match service.as_mut() {
            Some(active) => active.set_limits(config.capacity, config.ttl_ms(), now_ms()),
            None => {
                silence_clipboard_panics();
                disable_core_dumps();
                *service = Some(Service::new(MacPasteboard, config.capacity, config.ttl_ms()));
                drop(service);
                let app = app.clone();
                let on_panic = move || {
                    let _ = app.emit_to("main", STOPPED_EVENT, ());
                };
                *lock(&self.watcher) = Some(watcher::spawn(on_panic, self.service.clone()));
            }
        }
    }

    fn stop(&self) {
        lock(&self.watcher).take();
        lock(&self.service).take();
    }

    pub fn listing(&self) -> ClipListing {
        let ttl_minutes = self.config().ttl_minutes;
        let items = lock(&self.service)
            .as_ref()
            .map(|service| service.list(now_ms()))
            .unwrap_or_default();
        ClipListing { ttl_minutes, items }
    }

    pub fn reveal(&self, id: u64) -> Option<Secret> {
        lock(&self.service).as_ref()?.reveal(id)
    }

    pub fn select(&self, id: u64) -> bool {
        lock(&self.service).as_mut().is_some_and(|service| service.select(id))
    }

    pub fn delete(&self, id: u64) -> bool {
        lock(&self.service).as_mut().is_some_and(|service| service.delete(id))
    }

    pub fn clear(&self) {
        if let Some(service) = lock(&self.service).as_mut() {
            service.wipe();
        }
    }

    pub fn len(&self) -> usize {
        lock(&self.service).as_ref().map_or(0, Service::len)
    }

    /// Called on quit: stop polling, wipe, clear the pasteboard if it holds an entry.
    pub fn shutdown(&self) {
        self.stop();
    }
}

// Replaced in Task 6.
fn register_hotkey(_app: &AppHandle, _hotkey: &str, _old: Option<&str>) -> Result<(), ClipError> {
    Ok(())
}

// Replaced in Task 6.
fn unregister_hotkey(_app: &AppHandle, _hotkey: &str) {}

// Replaced in Task 6.
fn accessibility_trusted() -> bool {
    false
}

```

- [ ] **Step 4: Implement `commands.rs`**

```rust
// SPDX-License-Identifier: GPL-3.0-or-later

// Popup commands check the calling window as well as relying on the capability,
// so a future capability edit cannot hand entries to the main window.

use tauri::{AppHandle, Window};

#[cfg(target_os = "macos")]
use tauri::Manager;

use super::service::{ClipConfig, ClipError, ClipListing};

pub const POPUP_LABEL: &str = "clipboard";

#[cfg(target_os = "macos")]
use super::runtime::{ClipboardRuntime, ConfigStatus};

#[cfg(not(target_os = "macos"))]
#[derive(serde::Serialize)]
pub struct ConfigStatus;

fn require_popup(window: &Window) -> Result<(), ClipError> {
    if window.label() == POPUP_LABEL {
        Ok(())
    } else {
        Err(ClipError::WrongWindow)
    }
}

#[tauri::command]
pub fn clip_list(window: Window) -> Result<ClipListing, ClipError> {
    require_popup(&window)?;
    #[cfg(target_os = "macos")]
    return Ok(window.state::<ClipboardRuntime>().listing());
    #[cfg(not(target_os = "macos"))]
    Err(ClipError::Unsupported)
}

#[tauri::command]
pub fn clip_reveal(window: Window, id: u64) -> Result<String, ClipError> {
    require_popup(&window)?;
    #[cfg(target_os = "macos")]
    return window
        .state::<ClipboardRuntime>()
        .reveal(id)
        .map(|secret| secret.as_str().to_owned())
        .ok_or(ClipError::Disabled);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = id;
        Err(ClipError::Unsupported)
    }
}

#[tauri::command]
pub fn clip_select(window: Window, id: u64) -> Result<bool, ClipError> {
    require_popup(&window)?;
    #[cfg(target_os = "macos")]
    return Ok(window.state::<ClipboardRuntime>().select(id));
    #[cfg(not(target_os = "macos"))]
    {
        let _ = id;
        Err(ClipError::Unsupported)
    }
}

#[tauri::command]
pub fn clip_delete(window: Window, id: u64) -> Result<bool, ClipError> {
    require_popup(&window)?;
    #[cfg(target_os = "macos")]
    return Ok(window.state::<ClipboardRuntime>().delete(id));
    #[cfg(not(target_os = "macos"))]
    {
        let _ = id;
        Err(ClipError::Unsupported)
    }
}

#[tauri::command]
pub fn clip_set_config(app: AppHandle, config: ClipConfig) -> Result<ConfigStatus, ClipError> {
    #[cfg(target_os = "macos")]
    return Ok(app.state::<ClipboardRuntime>().apply_config(&app, config));
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, config);
        Err(ClipError::Unsupported)
    }
}
```
Update `mod.rs` to add `pub mod commands;` (all platforms) and `#[cfg(target_os = "macos")] pub mod runtime;`. Remove any `#![allow(dead_code)]` left over from Task 1.

- [ ] **Step 5: Register everything**

`src-tauri/src/lib.rs` `run()`:
```rust
    let builder = tauri::Builder::default()
        .manage(mcp::McpState::default())
        .manage(workspace::Workspaces::default());
    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(macos_menu)
        .on_menu_event(handle_macos_menu_event)
        .manage(clipboard::runtime::ClipboardRuntime::default());
```
Append to `generate_handler![...]`:
```rust
            mcp::stop_mcp_server,
            clipboard::commands::clip_list,
            clipboard::commands::clip_reveal,
            clipboard::commands::clip_select,
            clipboard::commands::clip_delete,
            clipboard::commands::clip_set_config
```
`src-tauri/build.rs`: append `"clip_list", "clip_reveal", "clip_select", "clip_delete", "clip_set_config",` to the commands list.

`src-tauri/capabilities/default.json`: add `"allow-clip-set-config"` to `permissions`.

Create `src-tauri/capabilities/clipboard.json`:
```json
{
  "$schema": "../gen/schemas/desktop-schema.json",
  "identifier": "clipboard",
  "description": "Clipboard history popup. The only window that can read entries. core:window:allow-destroy lets Esc and the close button dismiss it.",
  "windows": ["clipboard"],
  "platforms": ["macOS"],
  "permissions": [
    "allow-clip-list",
    "allow-clip-reveal",
    "allow-clip-select",
    "allow-clip-delete",
    "core:window:allow-destroy"
  ]
}
```

- [ ] **Step 6: Run all checks**

```bash
npm run check
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```
Expected: all pass on macOS. The egress check stays green because no URLs or network APIs were added.

- [ ] **Step 7: Commit**

```bash
git add src-tauri test
git commit -m "feat(clipboard): expose history commands to an isolated popup capability"
```

---

### Task 6: Popup window, hotkey, focus restore, and auto-paste

**Files:**
- Create: `src-tauri/src/clipboard/layout.rs` (all platforms), `src-tauri/src/clipboard/popup.rs` (macOS)
- Modify: `src-tauri/src/clipboard/runtime.rs` (real hotkey, accessibility, focus, and paste state), `src-tauri/src/clipboard/commands.rs` (`clip_select` closes the popup), `src-tauri/src/clipboard/mod.rs`, `src-tauri/src/lib.rs` (plugin plus window events)
- Create: `src/clipboard.html`, `src/clipboard.css`, `src/clipboard.js`
- Modify: `package.json` (`check:js` adds `src/clipboard.js`)
- Create: `test/clipboard-popup.test.js`
- Modify: `test/clipboard-boundary.test.js` (popup page rules)

**Interfaces:**
- Consumes: `ClipboardRuntime`, `POPUP_LABEL`.
- Produces:
  - `layout::{WIDTH: f64 = 440.0, Rect { x, y, width, height: f64 }, popup_height(rows: usize) -> f64, popup_origin(screen: Rect, primary_height: f64, width: f64) -> (f64, f64)}`
  - `popup::{toggle(app: &AppHandle), close(app: &AppHandle), on_window_event(window: &tauri::Window, event: &tauri::WindowEvent)}`
  - `ClipboardRuntime::{remember_frontmost(&self), restore_frontmost(&self), request_paste_on_close(&self), take_paste_on_close(&self) -> bool}`
  - JS: `src/clipboard.js` exports `formatRemaining(seconds)`, `slotKey(index)`, `createPopup({ document, invoke, close })` returning `{ refresh, onKey, state }`.

- [ ] **Step 1: Write the failing Rust geometry tests**

Create `src-tauri/src/clipboard/layout.rs`:
```rust
// SPDX-License-Identifier: GPL-3.0-or-later

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn popup_is_centered_at_one_third_of_the_primary_screen() {
        let screen = Rect { x: 0.0, y: 0.0, width: 1440.0, height: 900.0 };
        assert_eq!(popup_origin(screen, 900.0, WIDTH), (500.0, 300.0));
    }

    #[test]
    fn popup_uses_the_focused_screen_in_appkit_coordinates() {
        // A 1920x1080 screen to the right of a 1440x900 primary, bottoms aligned.
        let screen = Rect { x: 1440.0, y: 0.0, width: 1920.0, height: 1080.0 };
        assert_eq!(popup_origin(screen, 900.0, WIDTH), (1440.0 + 740.0, -180.0 + 360.0));
    }

    #[test]
    fn height_fits_rows_between_one_and_ten() {
        assert_eq!(popup_height(0), popup_height(1));
        assert!(popup_height(10) > popup_height(3));
        assert_eq!(popup_height(25), popup_height(10));
    }
}
```
Add `pub mod layout;` to `mod.rs`.

- [ ] **Step 2: Write the failing popup JS tests**

Create `test/clipboard-popup.test.js`:
```js
// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { createPopup, formatRemaining, slotKey } from "../src/clipboard.js";

const LISTING = {
  ttlMinutes: 10,
  items: [
    { id: 7, text: "sodilaud-infra", masked: false, secondsLeft: 540, extraLines: 0 },
    { id: 9, text: "ghp_••••Q7r8 (40)", masked: true, secondsLeft: 45, extraLines: 0 },
    { id: 11, text: "first line", masked: false, secondsLeft: 120, extraLines: 3 }
  ]
};

async function setup(listing = LISTING) {
  const html = await readFile("src/clipboard.html", "utf8");
  const dom = new JSDOM(html);
  const calls = [];
  let closed = 0;
  const invoke = async (command, args) => {
    calls.push({ command, args });
    if (command === "clip_list") return structuredClone(listing);
    if (command === "clip_reveal") return "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
    return true;
  };
  const popup = createPopup({ document: dom.window.document, invoke, close: () => { closed += 1; } });
  await popup.refresh();
  const key = (k) => popup.onKey(new dom.window.KeyboardEvent("keydown", { key: k }));
  return { dom, doc: dom.window.document, calls, popup, key, closed: () => closed };
}

test("formats time left and slot keys", () => {
  assert.equal(formatRemaining(540), "9m");
  assert.equal(formatRemaining(59), "59s");
  assert.deepEqual([0, 8, 9, 10].map(slotKey), ["1", "9", "0", ""]);
});

test("renders rows with slot numbers, masks, and time left", async () => {
  const { doc } = await setup();
  const rows = [...doc.querySelectorAll(".clip-row")];
  assert.equal(rows.length, 3);
  assert.equal(rows[0].querySelector(".clip-slot").textContent, "1");
  assert.equal(rows[1].querySelector(".clip-text").textContent, "ghp_••••Q7r8 (40)");
  assert.ok(rows[1].querySelector(".clip-reveal"));
  assert.equal(rows[0].querySelector(".clip-reveal"), null);
  assert.ok(rows[1].classList.contains("clip-expiring"));
  assert.match(rows[2].textContent, /\+3/);
  assert.equal(doc.getElementById("clip-ttl").textContent, "10 min TTL");
});

test("digit keys pick by slot", async () => {
  const { calls, key } = await setup();
  await key("2");
  assert.deepEqual(calls.at(-1), { command: "clip_select", args: { id: 9 } });
});

test("arrows and Enter pick the focused row", async () => {
  const { calls, key } = await setup();
  await key("ArrowDown");
  await key("ArrowDown");
  await key("Enter");
  assert.deepEqual(calls.at(-1), { command: "clip_select", args: { id: 11 } });
});

test("Space reveals and re-masks a masked row", async () => {
  const { doc, key } = await setup();
  await key("ArrowDown");
  await key(" ");
  assert.match(doc.querySelectorAll(".clip-row")[1].querySelector(".clip-text").textContent, /^ghp_A1b2/);
  await key(" ");
  assert.equal(doc.querySelectorAll(".clip-row")[1].querySelector(".clip-text").textContent, "ghp_••••Q7r8 (40)");
});

test("Backspace deletes the focused row", async () => {
  const { calls, key } = await setup();
  await key("Backspace");
  assert.ok(calls.some(c => c.command === "clip_delete" && c.args.id === 7));
});

test("Escape closes", async () => {
  const { key, closed } = await setup();
  await key("Escape");
  assert.equal(closed(), 1);
});

test("empty history shows the TTL hint", async () => {
  const { doc } = await setup({ ttlMinutes: 10, items: [] });
  const empty = doc.getElementById("clip-empty");
  assert.equal(empty.hidden, false);
  assert.equal(empty.textContent, "Nothing copied yet. Entries expire after 10 min.");
});

test("values render as text, never markup", async () => {
  const { doc } = await setup({ ttlMinutes: 10, items: [{ id: 1, text: "<img src=x onerror=alert(1)>", masked: false, secondsLeft: 60, extraLines: 0 }] });
  assert.equal(doc.querySelector("img"), null);
});
```

Append to `test/clipboard-boundary.test.js`:
```js
test("popup page keeps values out of storage, logs, and the network", async () => {
  const source = await readFile("src/clipboard.js", "utf8");
  assert.doesNotMatch(source, /^\s*import\b/m);
  assert.doesNotMatch(source, /\b(?:localStorage|sessionStorage|indexedDB|console|fetch|XMLHttpRequest|innerHTML|outerHTML|insertAdjacentHTML)\b/);
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cargo test --manifest-path src-tauri/Cargo.toml clipboard::layout
node --test test/clipboard-popup.test.js test/clipboard-boundary.test.js
```
Expected: FAIL. `popup_origin` is missing and `src/clipboard.js` does not exist.

- [ ] **Step 4: Implement `layout.rs`** (above its tests)

```rust
pub const WIDTH: f64 = 440.0;
const HEADER: f64 = 40.0;
const FOOTER: f64 = 30.0;
const ROW: f64 = 34.0;
const MAX_VISIBLE_ROWS: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

pub fn popup_height(rows: usize) -> f64 {
    HEADER + FOOTER + ROW * rows.clamp(1, MAX_VISIBLE_ROWS) as f64
}

/// `screen` is an AppKit frame (bottom-left origin on the primary screen); the
/// result is a top-left logical position as Tauri expects.
pub fn popup_origin(screen: Rect, primary_height: f64, width: f64) -> (f64, f64) {
    let x = screen.x + (screen.width - width) / 2.0;
    let top = primary_height - (screen.y + screen.height);
    (x, top + screen.height / 3.0)
}
```

- [ ] **Step 5: Implement the popup page**

`src/clipboard.html`:
```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Clipboard</title>
  <link rel="stylesheet" href="clipboard.css">
  <script type="module" src="clipboard.js"></script>
</head>
<body>
  <div class="clip-popup" role="dialog" aria-labelledby="clip-title">
    <header class="clip-header">
      <h1 id="clip-title">Clipboard</h1>
      <span id="clip-ttl" class="clip-ttl"></span>
      <button type="button" id="clip-close" class="clip-icon" aria-label="Close">×</button>
    </header>
    <ol id="clip-list" class="clip-list" role="listbox" aria-label="Clipboard history"></ol>
    <p id="clip-empty" class="clip-empty" hidden></p>
    <footer class="clip-footer">1-9,0 paste · ↑↓ Enter · Space reveal · ⌫ delete · Esc close</footer>
  </div>
</body>
</html>
```

`src/clipboard.css`:
```css
:root { color-scheme: light dark; --bg: #fbfbfb; --fg: #1d1d1f; --muted: #6e6e73; --line: #e2e2e5; --focus: #dbe7ff; }
@media (prefers-color-scheme: dark) { :root { --bg: #1e1e20; --fg: #f2f2f5; --muted: #a1a1a6; --line: #333338; --focus: #2c3a55; } }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--fg); font: 13px -apple-system, BlinkMacSystemFont, sans-serif; overflow: hidden; user-select: none; }
.clip-popup { display: flex; flex-direction: column; height: 100%; }
.clip-header { display: flex; align-items: center; gap: 8px; height: 40px; padding: 0 12px; border-bottom: 1px solid var(--line); }
.clip-header h1 { flex: 1; margin: 0; font-size: 13px; font-weight: 600; }
.clip-ttl, .clip-footer, .clip-time { color: var(--muted); }
.clip-list { flex: 1; margin: 0; padding: 0; list-style: none; overflow-y: auto; }
.clip-row { display: flex; align-items: center; gap: 8px; min-height: 34px; padding: 4px 12px; cursor: pointer; }
.clip-row.clip-focused { background: var(--focus); }
.clip-row.clip-expiring { opacity: 0.55; }
.clip-slot { width: 1.2em; color: var(--muted); font-variant-numeric: tabular-nums; }
.clip-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, Menlo, monospace; }
.clip-row.clip-revealed .clip-text { white-space: pre-wrap; word-break: break-all; max-height: 5.6em; overflow-y: auto; }
.clip-extra { color: var(--muted); }
.clip-icon { border: 0; background: none; color: var(--muted); cursor: pointer; font-size: 14px; padding: 2px 4px; }
.clip-icon:hover { color: var(--fg); }
.clip-empty { margin: 16px 12px; color: var(--muted); }
.clip-footer { height: 30px; line-height: 30px; padding: 0 12px; border-top: 1px solid var(--line); font-size: 11px; }
```

`src/clipboard.js`:
```js
// SPDX-License-Identifier: GPL-3.0-or-later

// Standalone popup page: no imports and no storage. Values arrive masked from
// Rust; plaintext is fetched only on reveal and dies with this window.

const REFRESH_MS = 1000;
const EXPIRING_SECONDS = 60;

export function formatRemaining(seconds) {
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m` : `${seconds}s`;
}

export function slotKey(index) {
  if (index < 9) return String(index + 1);
  return index === 9 ? "0" : "";
}

export function createPopup({ document, invoke, close }) {
  const list = document.getElementById("clip-list");
  const empty = document.getElementById("clip-empty");
  const ttl = document.getElementById("clip-ttl");
  let items = [];
  let focused = 0;
  const revealed = new Map();

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function render() {
    const rows = items.map((item, index) => {
      const row = element("li", "clip-row");
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(index === focused));
      if (index === focused) row.classList.add("clip-focused");
      if (item.secondsLeft < EXPIRING_SECONDS) row.classList.add("clip-expiring");
      const plain = revealed.get(item.id);
      if (plain !== undefined) row.classList.add("clip-revealed");
      row.append(element("span", "clip-slot", slotKey(index)));
      row.append(element("span", "clip-text", plain ?? item.text));
      if (item.extraLines > 0 && plain === undefined) row.append(element("span", "clip-extra", `+${item.extraLines}`));
      if (item.masked) {
        const eye = element("button", "clip-icon clip-reveal", plain === undefined ? "👁" : "◡");
        eye.type = "button";
        eye.setAttribute("aria-label", plain === undefined ? "Reveal" : "Hide");
        eye.addEventListener("click", (event) => { event.stopPropagation(); focused = index; toggleReveal(index); });
        row.append(eye);
      }
      row.append(element("span", "clip-time", formatRemaining(item.secondsLeft)));
      const trash = element("button", "clip-icon clip-trash", "🗑");
      trash.type = "button";
      trash.setAttribute("aria-label", "Delete");
      trash.addEventListener("click", (event) => { event.stopPropagation(); remove(index); });
      row.append(trash);
      row.addEventListener("click", () => pick(index));
      return row;
    });
    list.replaceChildren(...rows);
    empty.hidden = items.length > 0;
  }

  async function refresh() {
    try {
      const listing = await invoke("clip_list");
      items = listing.items;
      ttl.textContent = `${listing.ttlMinutes} min TTL`;
      empty.textContent = `Nothing copied yet. Entries expire after ${listing.ttlMinutes} min.`;
    } catch {
      items = [];
    }
    for (const id of [...revealed.keys()]) {
      if (!items.some((item) => item.id === id)) revealed.delete(id);
    }
    focused = Math.min(focused, Math.max(items.length - 1, 0));
    render();
  }

  async function pick(index) {
    const item = items[index];
    if (item) await invoke("clip_select", { id: item.id }).catch(() => refresh());
  }

  async function toggleReveal(index) {
    const item = items[index];
    if (!item?.masked) return;
    if (revealed.has(item.id)) {
      revealed.delete(item.id);
    } else {
      try {
        revealed.set(item.id, await invoke("clip_reveal", { id: item.id }));
      } catch {
        await refresh();
        return;
      }
    }
    render();
  }

  async function remove(index) {
    const item = items[index];
    if (!item) return;
    revealed.delete(item.id);
    await invoke("clip_delete", { id: item.id }).catch(() => {});
    await refresh();
  }

  async function onKey(event) {
    const slot = event.key === "0" ? 9 : Number.parseInt(event.key, 10) - 1;
    if (/^[0-9]$/.test(event.key)) return pick(slot);
    switch (event.key) {
      case "ArrowDown": focused = Math.min(focused + 1, Math.max(items.length - 1, 0)); render(); break;
      case "ArrowUp": focused = Math.max(focused - 1, 0); render(); break;
      case "Enter": return pick(focused);
      case " ": event.preventDefault?.(); return toggleReveal(focused);
      case "Backspace": case "Delete": return remove(focused);
      case "Escape": return close();
      default: break;
    }
  }

  document.addEventListener("keydown", onKey);
  document.getElementById("clip-close")?.addEventListener("click", () => close());
  return { refresh, onKey, state: () => ({ items, focused, revealed }) };
}

if (globalThis.window?.__TAURI__) {
  const tauri = window.__TAURI__;
  const popup = createPopup({
    document,
    invoke: tauri.core.invoke,
    close: () => tauri.window.getCurrentWindow().destroy()
  });
  popup.refresh();
  setInterval(popup.refresh, REFRESH_MS);
}
```
Add `&& node --check src/clipboard.js` to the `check:js` script in `package.json`.

- [ ] **Step 6: Run the JS and geometry tests**

```bash
node --test test/clipboard-popup.test.js test/clipboard-boundary.test.js
cargo test --manifest-path src-tauri/Cargo.toml clipboard::layout
```
Expected: PASS.

- [ ] **Step 7: Implement `popup.rs` and the real hotkey, accessibility, and focus code**

`src-tauri/src/clipboard/popup.rs`:
```rust
// SPDX-License-Identifier: GPL-3.0-or-later

use std::thread;
use std::time::Duration;

use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation};
use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
use objc2::MainThreadMarker;
use objc2_app_kit::{NSApplication, NSScreen};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use super::commands::POPUP_LABEL;
use super::layout::{popup_height, popup_origin, Rect, WIDTH};
use super::runtime::ClipboardRuntime;

const PASTE_DELAY: Duration = Duration::from_millis(120);
const KEY_V: u16 = 9;

pub fn toggle(app: &AppHandle) {
    if app.get_webview_window(POPUP_LABEL).is_some() {
        close(app);
        return;
    }
    let Some(mtm) = MainThreadMarker::new() else {
        return;
    };
    let runtime = app.state::<ClipboardRuntime>();
    runtime.remember_frontmost();
    let (screen, primary_height) = focused_screen(mtm);
    let (x, y) = popup_origin(screen, primary_height, WIDTH);
    let built = WebviewWindowBuilder::new(app, POPUP_LABEL, WebviewUrl::App("clipboard.html".into()))
        .title("Clipboard")
        .decorations(false)
        .always_on_top(true)
        .resizable(false)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .inner_size(WIDTH, popup_height(runtime.len()))
        .position(x, y)
        .focused(true)
        .build();
    if let Ok(window) = built {
        #[allow(deprecated)]
        NSApplication::sharedApplication(mtm).activateIgnoringOtherApps(true);
        let _ = window.set_focus();
    }
}

pub fn close(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(POPUP_LABEL) {
        let _ = window.destroy();
    }
}

pub fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    if window.label() != POPUP_LABEL {
        return;
    }
    let app = window.app_handle();
    match event {
        WindowEvent::Focused(false) => close(app),
        WindowEvent::Destroyed => {
            let runtime = app.state::<ClipboardRuntime>();
            runtime.restore_frontmost();
            if runtime.take_paste_on_close() {
                thread::spawn(|| {
                    thread::sleep(PASTE_DELAY);
                    post_command_v();
                });
            }
        }
        _ => {}
    }
}

fn focused_screen(mtm: MainThreadMarker) -> (Rect, f64) {
    let to_rect = |screen: &NSScreen| {
        let frame = screen.frame();
        Rect { x: frame.origin.x, y: frame.origin.y, width: frame.size.width, height: frame.size.height }
    };
    let screens = NSScreen::screens(mtm);
    let primary = screens.firstObject().map(|s| to_rect(&s));
    let focused = NSScreen::mainScreen(mtm).map(|s| to_rect(&s));
    let fallback = Rect { x: 0.0, y: 0.0, width: 1440.0, height: 900.0 };
    let primary = primary.unwrap_or(fallback);
    (focused.unwrap_or(primary), primary.height)
}

fn post_command_v() {
    let Ok(source) = CGEventSource::new(CGEventSourceStateID::HIDSystemState) else {
        return;
    };
    for key_down in [true, false] {
        if let Ok(event) = CGEvent::new_keyboard_event(source.clone(), KEY_V, key_down) {
            event.set_flags(CGEventFlags::CGEventFlagCommand);
            event.post(CGEventTapLocation::HID);
        }
    }
}
```

In `runtime.rs`, add these fields to `ClipboardRuntime`:
```rust
    frontmost_pid: Mutex<Option<i32>>,
    paste_on_close: std::sync::atomic::AtomicBool,
```
Add these methods:
```rust
    pub fn remember_frontmost(&self) {
        let pid = NSWorkspace::sharedWorkspace()
            .frontmostApplication()
            .map(|app| app.processIdentifier());
        *lock(&self.frontmost_pid) = pid;
    }

    pub fn restore_frontmost(&self) {
        let Some(pid) = lock(&self.frontmost_pid).take() else {
            return;
        };
        if let Some(app) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid) {
            #[allow(deprecated)]
            app.activateWithOptions(NSApplicationActivationOptions::ActivateIgnoringOtherApps);
        }
    }

    pub fn request_paste_on_close(&self) {
        let wanted = self.config().auto_paste && accessibility_trusted();
        self.paste_on_close.store(wanted, Ordering::SeqCst);
    }

    pub fn take_paste_on_close(&self) -> bool {
        self.paste_on_close.swap(false, Ordering::SeqCst)
    }
```
Replace the three stubs:
```rust
fn register_hotkey(app: &AppHandle, hotkey: &str, old: Option<&str>) -> Result<(), ClipError> {
    let shortcut: Shortcut = hotkey.parse().map_err(|_| ClipError::HotkeyInvalid)?;
    app.global_shortcut()
        .on_shortcut(shortcut, |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                popup::toggle(app);
            }
        })
        .map_err(|_| ClipError::HotkeyUnavailable)?;
    if let Some(old) = old.and_then(|old| old.parse::<Shortcut>().ok()) {
        if old != shortcut {
            let _ = app.global_shortcut().unregister(old);
        }
    }
    Ok(())
}

fn unregister_hotkey(app: &AppHandle, hotkey: &str) {
    if let Ok(shortcut) = hotkey.parse::<Shortcut>() {
        let _ = app.global_shortcut().unregister(shortcut);
    }
}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
}

pub fn accessibility_trusted() -> bool {
    // SAFETY: AXIsProcessTrusted takes no arguments and only reads process state.
    unsafe { AXIsProcessTrusted() }
}
```
with these imports:
```rust
use std::sync::atomic::Ordering;
use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication, NSWorkspace};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use super::popup;
```
In `stop()`, also call `popup::close` when the history is disabled. Give `stop` an `app: &AppHandle` parameter from `apply_config`. `shutdown(&self)` keeps no app parameter and does not touch windows.

In `commands.rs`, `clip_select` on macOS becomes:
```rust
    #[cfg(target_os = "macos")]
    {
        let runtime = window.state::<ClipboardRuntime>();
        let picked = runtime.select(id);
        if picked {
            runtime.request_paste_on_close();
            super::popup::close(window.app_handle());
        }
        return Ok(picked);
    }
```

In `mod.rs`, add `#[cfg(target_os = "macos")] pub mod popup;`.

In `lib.rs`, extend the macOS builder block:
```rust
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .on_window_event(clipboard::popup::on_window_event)
```

- [ ] **Step 8: Build and check on macOS**

```bash
npm run check
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```
Expected: PASS. Fix any `objc2` or `core-graphics` signature mismatches the compiler reports, keeping the behavior the same.

- [ ] **Step 9: Smoke test by hand**

1. Run `npm run tauri dev`. In the devtools console of the main window, run `await window.__TAURI__.core.invoke("clip_set_config", { config: { enabled: true, capacity: 10, ttlMinutes: 10, hotkey: "super+shift+KeyV", autoPaste: false } })`.
2. Copy two values in another app, press ⌘⇧V, press 2, then press ⌘V in that app. Expected: the popup appears at the top third, closes, focus returns to the app, and the second value pastes.

- [ ] **Step 10: Commit**

```bash
git add package.json src src-tauri test
git commit -m "feat(clipboard): open a hotkey popup to pick, reveal, and delete entries"
```

---

### Task 7: Tray icon, hide-on-close, and quit flow

**Files:**
- Create: `src-tauri/src/clipboard/tray.rs` (macOS)
- Modify: `src-tauri/src/clipboard/layout.rs` (tray glyph), `src-tauri/src/clipboard/runtime.rs` (tray refresh), `src-tauri/src/clipboard/commands.rs` (`hide_main_window`, `quit_app`, `open_accessibility_settings`)
- Modify: `src-tauri/src/lib.rs` (setup, quit menu item, run events, handler list), `src-tauri/build.rs`, `src-tauri/capabilities/default.json`
- Modify: `src/main.js` (`registerCloseHandler`, new `registerQuitHandler`)
- Create: `test/clipboard-lifecycle.test.js`

**Interfaces:**
- Produces:
  - `layout::tray_glyph() -> (Vec<u8>, u32, u32)` (RGBA, black plus alpha only)
  - `tray::{install(app: &AppHandle) -> tauri::Result<()>, refresh(app: &AppHandle, config: &ClipConfig), show_main(app), hide_main(app), request_quit(app), QUIT_REQUESTED_EVENT = "sodilaud-quit-requested"}`
  - Commands (all platforms): `hide_main_window(app) -> bool` (`false` off macOS), `quit_app(app)`, `open_accessibility_settings(app) -> Result<(), ClipError>`
  - JS: the close handler calls `invoke("hide_main_window")` after a successful flush and destroys the window only when that returns falsy. `registerQuitHandler()` listens for `sodilaud-quit-requested`.

- [ ] **Step 1: Write the failing tests**

Add to `layout.rs` tests:
```rust
    #[test]
    fn tray_glyph_is_a_monochrome_template() {
        let (rgba, width, height) = tray_glyph();
        assert_eq!(rgba.len(), (width * height * 4) as usize);
        assert!(rgba.chunks(4).all(|px| px[0] == 0 && px[1] == 0 && px[2] == 0));
        assert!(rgba.chunks(4).any(|px| px[3] == 255));
    }
```

Create `test/clipboard-lifecycle.test.js`:
```js
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { bootApp, settle } from "./helpers/app-harness.js";

test("closing hides the window when Rust keeps the app in the menu bar", async () => {
  let closeHandler;
  let destroyed = false;
  const app = await bootApp({
    handlers: { hide_main_window: () => true },
    windowApi: { getCurrentWindow: () => ({
      onCloseRequested: async handler => { closeHandler = handler; },
      destroy: async () => { destroyed = true; }
    }) }
  });
  await closeHandler({ preventDefault() {} });
  assert.equal(destroyed, false);
  assert.ok(app.invocations.some(i => i.command === "hide_main_window"));
  await closeHandler({ preventDefault() {} });
  assert.equal(app.invocations.filter(i => i.command === "hide_main_window").length, 2);
});

test("quit request flushes, then asks Rust to quit", async () => {
  const app = await bootApp({ instance: 2 });
  await app.emit("sodilaud-quit-requested");
  await settle();
  assert.ok(app.invocations.some(i => i.command === "quit_app"));
});
```
The existing `test/mcp-close.test.js` covers the destroy path: its harness returns `null` for `hide_main_window`.

- [ ] **Step 2: Run tests to verify they fail**

```bash
cargo test --manifest-path src-tauri/Cargo.toml clipboard::layout
node --test test/clipboard-lifecycle.test.js
```
Expected: FAIL. `tray_glyph` is missing, and `hide_main_window` and `quit_app` are never invoked.

- [ ] **Step 3: Implement the glyph** in `layout.rs`

```rust
// 18x18 clipboard outline, doubled to 36x36 for Retina menu bars.
const GLYPH: [&str; 18] = [
    "                  ",
    "      ######      ",
    "   ####    ####   ",
    "   #  ######  #   ",
    "   #          #   ",
    "   #  ######  #   ",
    "   #          #   ",
    "   #  ######  #   ",
    "   #          #   ",
    "   #  ####    #   ",
    "   #          #   ",
    "   #          #   ",
    "   #          #   ",
    "   #          #   ",
    "   #          #   ",
    "   ############   ",
    "                  ",
    "                  ",
];

pub fn tray_glyph() -> (Vec<u8>, u32, u32) {
    const SCALE: usize = 2;
    let size = GLYPH.len() * SCALE;
    let mut rgba = vec![0u8; size * size * 4];
    for (row, line) in GLYPH.iter().enumerate() {
        for (col, cell) in line.bytes().enumerate() {
            if cell != b'#' {
                continue;
            }
            for dy in 0..SCALE {
                for dx in 0..SCALE {
                    let index = ((row * SCALE + dy) * size + col * SCALE + dx) * 4;
                    rgba[index + 3] = 255;
                }
            }
        }
    }
    (rgba, size as u32, size as u32)
}
```

- [ ] **Step 4: Implement `tray.rs`**

```rust
// SPDX-License-Identifier: GPL-3.0-or-later

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{ActivationPolicy, AppHandle, Emitter, Manager, Wry};

use super::layout::tray_glyph;
use super::popup;
use super::runtime::ClipboardRuntime;
use super::service::ClipConfig;

pub const QUIT_REQUESTED_EVENT: &str = "sodilaud-quit-requested";
const TRAY_ID: &str = "sodilaud";
const SHOW_ID: &str = "tray-show";
const HISTORY_ID: &str = "tray-history";
const CLEAR_ID: &str = "tray-clear";
const QUIT_ID: &str = "tray-quit";

pub struct TrayItems {
    history: MenuItem<Wry>,
    clear: MenuItem<Wry>,
}

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, SHOW_ID, "Show Sodilaud", true, None::<&str>)?;
    let history = MenuItem::with_id(app, HISTORY_ID, "Clipboard History…", false, None::<&str>)?;
    let clear = MenuItem::with_id(app, CLEAR_ID, "Clear Clipboard History", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, QUIT_ID, "Quit Sodilaud", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show, &history, &clear, &separator, &quit])?;
    let (rgba, width, height) = tray_glyph();
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(Image::new_owned(rgba, width, height))
        .icon_as_template(true)
        .tooltip("Sodilaud")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            SHOW_ID => show_main(app),
            HISTORY_ID => popup::toggle(app),
            CLEAR_ID => app.state::<ClipboardRuntime>().clear(),
            QUIT_ID => request_quit(app),
            _ => {}
        })
        .build(app)?;
    app.manage(TrayItems { history, clear });
    Ok(())
}

pub fn refresh(app: &AppHandle, config: &ClipConfig) {
    let Some(items) = app.try_state::<TrayItems>() else {
        return;
    };
    let _ = items.history.set_enabled(config.enabled);
    let _ = items.clear.set_enabled(config.enabled);
    let label = if config.enabled {
        format!("Clipboard History…  {}", hotkey_label(&config.hotkey))
    } else {
        "Clipboard History…".to_string()
    };
    let _ = items.history.set_text(label);
}

fn hotkey_label(hotkey: &str) -> String {
    hotkey
        .split('+')
        .map(|part| match part.to_ascii_lowercase().as_str() {
            "super" | "cmd" | "command" => "⌘".to_string(),
            "shift" => "⇧".to_string(),
            "alt" | "option" => "⌥".to_string(),
            "ctrl" | "control" => "⌃".to_string(),
            _ => part.trim_start_matches("Key").trim_start_matches("Digit").to_string(),
        })
        .collect()
}

pub fn show_main(app: &AppHandle) {
    let _ = app.set_activation_policy(ActivationPolicy::Regular);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn hide_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    let _ = app.set_activation_policy(ActivationPolicy::Accessory);
}

pub fn request_quit(app: &AppHandle) {
    show_main(app);
    let _ = app.emit_to("main", QUIT_REQUESTED_EVENT, ());
}
```
`request_quit` shows the main window so a failed flush can report its error to the user.

In `runtime.rs`, call `super::tray::refresh(app, &applied);` at the end of `apply_config`, and add `#[cfg(target_os = "macos")] pub mod tray;` to `mod.rs`.

- [ ] **Step 5: Lifecycle commands** (append to `commands.rs`)

```rust
#[tauri::command]
pub fn hide_main_window(app: AppHandle) -> bool {
    #[cfg(target_os = "macos")]
    {
        super::tray::hide_main(&app);
        true
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        false
    }
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    #[cfg(target_os = "macos")]
    app.state::<ClipboardRuntime>().shutdown();
    app.exit(0);
}

#[tauri::command]
pub fn open_accessibility_settings(app: AppHandle) -> Result<(), ClipError> {
    #[cfg(target_os = "macos")]
    {
        use tauri_plugin_opener::OpenerExt;
        return app
            .opener()
            .open_url("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility", None::<&str>)
            .map_err(|_| ClipError::Internal);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err(ClipError::Unsupported)
    }
}
```
Register all three in `generate_handler!`, add them to `build.rs`, and add `allow-hide-main-window`, `allow-quit-app`, and `allow-open-accessibility-settings` to `default.json`.

- [ ] **Step 6: Replace the macOS Quit menu item and handle run events** in `lib.rs`

In `macos_menu`, after the About replacement, add:
```rust
    let quit_position = app_menu.items()?.iter().position(|item| {
        matches!(item, tauri::menu::MenuItemKind::Predefined(predefined)
            if predefined.text().is_ok_and(|text| text.starts_with("Quit")))
    });
    if let Some(position) = quit_position {
        app_menu.remove_at(position)?;
        let quit = MenuItem::with_id(
            app,
            NATIVE_QUIT_MENU_ID,
            format!("Quit {}", app.package_info().name),
            true,
            Some("CmdOrCtrl+Q"),
        )?;
        app_menu.insert(&quit, position)?;
    }
```
Define `const NATIVE_QUIT_MENU_ID: &str = "sodilaud-native-quit";` next to `NATIVE_ABOUT_MENU_ID`. In `handle_macos_menu_event`, before the About check, add:
```rust
    if event.id() == NATIVE_QUIT_MENU_ID {
        // Cmd+Q in the popup closes only the popup.
        if app.get_webview_window(clipboard::commands::POPUP_LABEL).is_some() {
            clipboard::popup::close(app.app_handle());
        } else {
            clipboard::tray::request_quit(app.app_handle());
        }
        return;
    }
```
(`handle_macos_menu_event` is generic over `R: Runtime`. Make it and `macos_menu` concrete on `tauri::Wry`, or get an `AppHandle<Wry>` some other way; the tray and popup functions take `&AppHandle` with the default runtime.)

Change the end of `run()` from `.run(context)` to:
```rust
        .setup(|_app| {
            #[cfg(target_os = "macos")]
            clipboard::tray::install(_app.handle())?;
            Ok(())
        })
        .build(context)
        .expect("error while building tauri application")
        .run(|_app, _event| {
            #[cfg(target_os = "macos")]
            match _event {
                tauri::RunEvent::ExitRequested { code: None, api, .. } => {
                    // System-initiated quit (logout, Dock menu): flush first, then quit_app.
                    // Without a main window nobody can flush, so let the exit through.
                    if _app.get_webview_window("main").is_some() {
                        api.prevent_exit();
                        clipboard::tray::request_quit(_app);
                    } else {
                        _app.state::<clipboard::runtime::ClipboardRuntime>().shutdown();
                    }
                }
                tauri::RunEvent::Reopen { .. } => clipboard::tray::show_main(_app),
                _ => {}
            }
        });
```
`app.exit(0)` from `quit_app` arrives as `ExitRequested { code: Some(0) }` and is allowed through.

- [ ] **Step 7: Frontend close and quit handlers** in `src/main.js`

In `registerCloseHandler`, replace the block from `isClosing = true;` through the `destroy` try/catch with:
```js
      try {
        if (await invoke("hide_main_window")) {
          isClosePending = false;
          return;
        }
      } catch (error) {
        console.error("Failed to hide Sodilaud", error);
      }

      isClosing = true;
      try {
        await appWindow.destroy();
      } catch (error) {
        isClosing = false;
        isClosePending = false;
        console.error("Failed to close Sodilaud after saving", error);
        showNotification("Could not close Sodilaud");
      }
```
Add after `registerCloseHandler`:
```js
async function registerQuitHandler() {
  const listen = window.__TAURI__?.event?.listen;
  if (typeof listen !== "function") return;

  try {
    await listen("sodilaud-quit-requested", async () => {
      await dbSaveQueue;
      const saved = await flushPendingSaves();
      if (!saved) {
        setSaveFailedState();
        showNotification("Could not save the latest changes; quit cancelled");
        return;
      }
      await invoke("quit_app");
    });
  } catch (error) {
    console.error("Failed to register the quit handler", error);
  }
}
```
Call `await registerQuitHandler();` in `init()` right after `await registerCloseHandler();`.

- [ ] **Step 8: Run all checks**

```bash
npm run check
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```
Expected: PASS, including the existing `mcp-close`, `native-about-menu`, and `help-menu` tests. If `native-about-menu.test.js` inspects `macos_menu` text, update its expectations to include the Quit replacement, and keep its About assertions.

- [ ] **Step 9: Smoke test by hand**

1. Run `npm run tauri dev`, then close the window. Expected: the Dock icon disappears and the menu-bar icon stays.
2. Choose Show Sodilaud from the tray. Expected: the window and Dock icon come back.
3. Choose Quit from the tray, then relaunch and press ⌘Q in the main window. Expected: the app exits both times.

- [ ] **Step 10: Commit**

```bash
git add src src-tauri test
git commit -m "feat(clipboard): keep Sodilaud in the menu bar and quit through a flush"
```

---

### Task 8: Settings UI

**Files:**
- Create: `src/clipboard-settings.js`, `src/clipboard-settings-ui.js`
- Modify: `src/index.html` (dropdown section plus modal), `src/main.js` (import plus setup call), `src/styles.css` (hotkey button styling only if the existing classes are not enough), `package.json` (`check:js`)
- Modify: `test/helpers/app-harness.js` (`platform` option)
- Create: `test/clipboard-settings.test.js`, `test/clipboard-settings-ui.test.js`

**Interfaces:**
- Consumes: commands `clip_set_config(config) -> { enabled, hotkey, hotkeyError, accessibilityTrusted }`, `open_accessibility_settings()`, event `clipboard-history-stopped`.
- Produces:
  - `clipboard-settings.js`: `CLIPBOARD_SETTINGS_KEY = "clipboardHistory.settings"`, `DEFAULT_CLIPBOARD_SETTINGS`, `normalizeClipboardSettings(value)`, `loadClipboardSettings(storage)`, `saveClipboardSettings(storage, settings)`, `acceleratorFromKeyEvent(event) -> string | null`, `formatAccelerator(accelerator) -> string`, `isMacPlatform(navigator) -> boolean`
  - `clipboard-settings-ui.js`: `setupClipboardHistory({ document, invoke, listen, storage, notify, isMac }) -> Promise<void>`

- [ ] **Step 1: Write the failing model tests**

`test/clipboard-settings.test.js`:
```js
// SPDX-License-Identifier: GPL-3.0-or-later
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLIPBOARD_SETTINGS_KEY, DEFAULT_CLIPBOARD_SETTINGS, acceleratorFromKeyEvent, formatAccelerator,
  isMacPlatform, loadClipboardSettings, normalizeClipboardSettings, saveClipboardSettings
} from "../src/clipboard-settings.js";

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return { getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), map };
}

test("defaults match the spec", () => {
  assert.deepEqual(DEFAULT_CLIPBOARD_SETTINGS, { enabled: false, capacity: 10, ttlMinutes: 10, hotkey: "super+shift+KeyV", autoPaste: false });
});

test("normalizes corrupt stored settings", () => {
  assert.deepEqual(normalizeClipboardSettings({ enabled: "yes", capacity: "lots", ttlMinutes: -5, hotkey: 42, autoPaste: 1 }), DEFAULT_CLIPBOARD_SETTINGS);
  assert.equal(normalizeClipboardSettings({ capacity: 9999 }).capacity, 50);
  assert.equal(normalizeClipboardSettings({ ttlMinutes: 0 }).ttlMinutes, 1);
  assert.equal(normalizeClipboardSettings({ capacity: 7.6 }).capacity, 8);
  assert.deepEqual(loadClipboardSettings(memoryStorage({ [CLIPBOARD_SETTINGS_KEY]: "{not json" })), DEFAULT_CLIPBOARD_SETTINGS);
  assert.deepEqual(loadClipboardSettings(memoryStorage()), DEFAULT_CLIPBOARD_SETTINGS);
});

test("saves only the settings fields", () => {
  const storage = memoryStorage();
  saveClipboardSettings(storage, { ...DEFAULT_CLIPBOARD_SETTINGS, enabled: true, extra: "value" });
  assert.deepEqual(Object.keys(JSON.parse(storage.map.get(CLIPBOARD_SETTINGS_KEY))).sort(), ["autoPaste", "capacity", "enabled", "hotkey", "ttlMinutes"]);
});

test("captures accelerators that include a non-Shift modifier", () => {
  assert.equal(acceleratorFromKeyEvent({ metaKey: true, shiftKey: true, code: "KeyV" }), "super+shift+KeyV");
  assert.equal(acceleratorFromKeyEvent({ ctrlKey: true, altKey: true, code: "Digit1" }), "ctrl+alt+Digit1");
  assert.equal(acceleratorFromKeyEvent({ shiftKey: true, code: "KeyV" }), null);
  assert.equal(acceleratorFromKeyEvent({ metaKey: true, code: "ShiftLeft" }), null);
  assert.equal(acceleratorFromKeyEvent({ metaKey: true, code: "F5" }), "super+F5");
});

test("formats accelerators with macOS symbols", () => {
  assert.equal(formatAccelerator("super+shift+KeyV"), "⌘⇧V");
  assert.equal(formatAccelerator("ctrl+alt+Digit1"), "⌃⌥1");
});

test("detects macOS", () => {
  assert.equal(isMacPlatform({ platform: "MacIntel" }), true);
  assert.equal(isMacPlatform({ platform: "Linux x86_64" }), false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/clipboard-settings.test.js`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement `src/clipboard-settings.js`**

```js
// SPDX-License-Identifier: GPL-3.0-or-later

// Settings only. Clipboard values never pass through this module.

export const CLIPBOARD_SETTINGS_KEY = "clipboardHistory.settings";
export const DEFAULT_CLIPBOARD_SETTINGS = Object.freeze({
  enabled: false,
  capacity: 10,
  ttlMinutes: 10,
  hotkey: "super+shift+KeyV",
  autoPaste: false
});

const LIMITS = { capacity: [1, 50], ttlMinutes: [1, 120] };
const KEY_CODE = /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-2])|Space|Backquote|Minus|Equal|BracketLeft|BracketRight|Semicolon|Quote|Comma|Period|Slash|Backslash)$/;
const MODIFIERS = ["super", "ctrl", "alt", "shift"];

function clampInteger(value, [min, max], fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function isValidAccelerator(value) {
  if (typeof value !== "string") return false;
  const parts = value.split("+");
  const code = parts.pop();
  return KEY_CODE.test(code ?? "")
    && parts.length > 0
    && parts.every(p => MODIFIERS.includes(p))
    && parts.some(p => p !== "shift");
}

export function normalizeClipboardSettings(value) {
  const input = value && typeof value === "object" ? value : {};
  const defaults = DEFAULT_CLIPBOARD_SETTINGS;
  return {
    enabled: input.enabled === true,
    capacity: clampInteger(input.capacity, LIMITS.capacity, defaults.capacity),
    ttlMinutes: clampInteger(input.ttlMinutes, LIMITS.ttlMinutes, defaults.ttlMinutes),
    hotkey: isValidAccelerator(input.hotkey) ? input.hotkey : defaults.hotkey,
    autoPaste: input.autoPaste === true
  };
}

export function loadClipboardSettings(storage) {
  try {
    return normalizeClipboardSettings(JSON.parse(storage.getItem(CLIPBOARD_SETTINGS_KEY) ?? "null"));
  } catch {
    return { ...DEFAULT_CLIPBOARD_SETTINGS };
  }
}

export function saveClipboardSettings(storage, settings) {
  storage.setItem(CLIPBOARD_SETTINGS_KEY, JSON.stringify(normalizeClipboardSettings(settings)));
}

export function acceleratorFromKeyEvent(event) {
  if (!KEY_CODE.test(event.code ?? "")) return null;
  const parts = [];
  if (event.metaKey) parts.push("super");
  if (event.ctrlKey) parts.push("ctrl");
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  if (!parts.some(p => p !== "shift")) return null;
  return [...parts, event.code].join("+");
}

const SYMBOLS = { super: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧" };

export function formatAccelerator(accelerator) {
  const parts = accelerator.split("+");
  const code = parts.pop() ?? "";
  const ordered = ["ctrl", "alt", "super", "shift"].filter(m => parts.includes(m)).map(m => SYMBOLS[m]);
  return ordered.join("") + code.replace(/^Key|^Digit/, "");
}

export function isMacPlatform(navigatorLike) {
  const platform = navigatorLike?.userAgentData?.platform || navigatorLike?.platform || navigatorLike?.userAgent || "";
  return /mac/i.test(platform);
}
```
The symbol order is ⌃⌥⌘⇧, matching the spec's `⌘⇧V`.

- [ ] **Step 4: Run model tests to verify they pass**

Run: `node --test test/clipboard-settings.test.js`
Expected: PASS.

- [ ] **Step 5: Add the markup**

In `src/index.html`, insert this after the `agent-access-menu-section` block and its following divider:
```html
              <div class="dropdown-section" id="clipboard-history-menu-section" hidden>
                <div class="dropdown-section-title">Clipboard history</div>
                <div class="view-setting-row">
                  <span class="view-setting-label">Clipboard history</span>
                  <button class="view-setting-toggle" id="clipboard-history-toggle-btn" type="button" aria-label="Toggle clipboard history" aria-pressed="false">Off</button>
                </div>
                <button class="dropdown-item" id="clipboard-settings-btn" aria-haspopup="dialog">Clipboard settings</button>
              </div>
              <div class="dropdown-divider" id="clipboard-history-menu-divider" hidden></div>
```
Before `mcp-config-modal-backdrop`, add the modal. It reuses the help-modal classes:
```html
  <div class="help-modal-backdrop" id="clipboard-settings-modal-backdrop" style="display: none;" aria-hidden="true">
    <div class="help-modal" id="clipboard-settings-modal" role="dialog" aria-modal="true" aria-labelledby="clipboard-settings-heading">
      <div class="help-modal-header">
        <h3 id="clipboard-settings-heading">Clipboard history</h3>
        <button class="close-help-btn" id="close-clipboard-settings-btn" title="Close (Escape)" aria-label="Close clipboard settings">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
        </button>
      </div>
      <div class="help-modal-body">
        <p>Keeps your recent text copies in memory only, never on disk. Entries are wiped when they expire, when you delete them, and when Sodilaud quits. Copies over 64 KiB are not kept.</p>
        <div class="view-setting-row">
          <label class="view-setting-label" for="clipboard-capacity-input">History size</label>
          <input id="clipboard-capacity-input" type="number" min="1" max="50" step="1" />
        </div>
        <div class="view-setting-row">
          <label class="view-setting-label" for="clipboard-ttl-input">Expire after (minutes)</label>
          <input id="clipboard-ttl-input" type="number" min="1" max="120" step="1" />
        </div>
        <div class="view-setting-row">
          <span class="view-setting-label">Hotkey</span>
          <button class="view-setting-toggle" id="clipboard-hotkey-btn" type="button" aria-label="Change clipboard history hotkey">⌘⇧V</button>
          <button class="view-setting-btn" id="clipboard-hotkey-reset-btn" type="button" title="Reset hotkey" aria-label="Reset hotkey">↺</button>
        </div>
        <div class="view-setting-row">
          <span class="view-setting-label">Paste automatically after picking</span>
          <button class="view-setting-toggle" id="clipboard-autopaste-toggle-btn" type="button" aria-label="Toggle automatic paste" aria-pressed="false">Off</button>
        </div>
        <div class="view-setting-row" id="clipboard-accessibility-row" hidden>
          <span class="view-setting-label">Grant Accessibility in System Settings, then restart Sodilaud. Until then, picks are copied only.</span>
          <button class="dropdown-item" id="clipboard-accessibility-open-btn" type="button">Open</button>
        </div>
        <p id="clipboard-settings-status" role="status" aria-live="polite"></p>
      </div>
    </div>
  </div>
```

- [ ] **Step 6: Write the failing UI tests**

In `test/helpers/app-harness.js`, add a `platform` option. Add it to the `bootApp` destructuring (`platform`) and, before the `import` of `main.js`, add:
```js
  if (platform) {
    Object.defineProperty(dom.window.navigator, "platform", { value: platform, configurable: true });
  }
```

`test/clipboard-settings-ui.test.js`:
```js
// SPDX-License-Identifier: GPL-3.0-or-later
import assert from "node:assert/strict";
import test from "node:test";
import { bootApp, settle } from "./helpers/app-harness.js";

const ok = (config) => ({ enabled: config.enabled, hotkey: config.hotkey, hotkeyError: null, accessibilityTrusted: false });

test("macOS shows the section, pushes stored settings at startup, and toggles", async () => {
  const app = await bootApp({
    platform: "MacIntel",
    storage: { "clipboardHistory.settings": { enabled: false, capacity: 99, ttlMinutes: 5, hotkey: "super+shift+KeyV", autoPaste: false } },
    handlers: { clip_set_config: ({ config }) => ok(config) }
  });
  const doc = app.dom.window.document;
  assert.equal(doc.getElementById("clipboard-history-menu-section").hidden, false);
  const startup = app.invocations.find(i => i.command === "clip_set_config");
  assert.deepEqual(startup.args.config, { enabled: false, capacity: 50, ttlMinutes: 5, hotkey: "super+shift+KeyV", autoPaste: false });

  app.click("clipboard-history-toggle-btn");
  await settle();
  assert.equal(app.invocations.findLast(i => i.command === "clip_set_config").args.config.enabled, true);
  assert.equal(JSON.parse(app.storage.getItem("clipboardHistory.settings")).enabled, true);
  assert.equal(doc.getElementById("clipboard-history-toggle-btn").getAttribute("aria-pressed"), "true");
});

test("a rejected hotkey keeps the previous one and shows an error", async () => {
  const app = await bootApp({
    instance: 2,
    platform: "MacIntel",
    storage: { "clipboardHistory.settings": { enabled: true, capacity: 10, ttlMinutes: 10, hotkey: "super+shift+KeyV", autoPaste: false } },
    handlers: { clip_set_config: ({ config }) => config.hotkey === "super+KeyB"
      ? { enabled: true, hotkey: "super+shift+KeyV", hotkeyError: "HotkeyUnavailable", accessibilityTrusted: false }
      : ok(config) }
  });
  const { document, KeyboardEvent } = app.dom.window;
  app.click("clipboard-settings-btn");
  app.click("clipboard-hotkey-btn");
  document.getElementById("clipboard-hotkey-btn").dispatchEvent(new KeyboardEvent("keydown", { metaKey: true, code: "KeyB", key: "b", bubbles: true }));
  await settle();
  assert.equal(JSON.parse(app.storage.getItem("clipboardHistory.settings")).hotkey, "super+shift+KeyV");
  assert.equal(document.getElementById("clipboard-hotkey-btn").textContent, "⌘⇧V");
  assert.match(document.getElementById("clipboard-settings-status").textContent, /already in use/i);
});

test("auto-paste without Accessibility shows the grant row", async () => {
  const app = await bootApp({
    instance: 3,
    platform: "MacIntel",
    handlers: { clip_set_config: ({ config }) => ok(config) }
  });
  app.click("clipboard-settings-btn");
  app.click("clipboard-autopaste-toggle-btn");
  await settle();
  assert.equal(app.dom.window.document.getElementById("clipboard-accessibility-row").hidden, false);
  app.click("clipboard-accessibility-open-btn");
  await settle();
  assert.ok(app.invocations.some(i => i.command === "open_accessibility_settings"));
});

test("an unexpected stop turns the feature off and says so", async () => {
  const app = await bootApp({
    instance: 4,
    platform: "MacIntel",
    storage: { "clipboardHistory.settings": { enabled: true, capacity: 10, ttlMinutes: 10, hotkey: "super+shift+KeyV", autoPaste: false } },
    handlers: { clip_set_config: ({ config }) => ok(config) }
  });
  await app.emit("clipboard-history-stopped");
  await settle();
  assert.equal(JSON.parse(app.storage.getItem("clipboardHistory.settings")).enabled, false);
  assert.match(app.dom.window.document.getElementById("clipboard-settings-status").textContent, /stopped unexpectedly/i);
});

test("other platforms hide the section and never call clipboard commands", async () => {
  const app = await bootApp({ instance: 5, platform: "Linux x86_64" });
  assert.equal(app.dom.window.document.getElementById("clipboard-history-menu-section").hidden, true);
  assert.ok(!app.invocations.some(i => i.command === "clip_set_config"));
});
```
These tests boot the app more than once in one file, which is what the harness's `instance` option is for. If the harness comment ("give every start-up scenario its own test file") proves true for these scenarios, split them into `test/clipboard-settings-ui-*.test.js` files.

- [ ] **Step 7: Run to verify they fail**

Run: `node --test test/clipboard-settings-ui.test.js`
Expected: FAIL. The section stays hidden and `clip_set_config` is never invoked.

- [ ] **Step 8: Implement `src/clipboard-settings-ui.js`**

```js
// SPDX-License-Identifier: GPL-3.0-or-later

import {
  DEFAULT_CLIPBOARD_SETTINGS, acceleratorFromKeyEvent, formatAccelerator,
  loadClipboardSettings, normalizeClipboardSettings, saveClipboardSettings
} from "./clipboard-settings.js";

const STOPPED_EVENT = "clipboard-history-stopped";
const HOTKEY_MESSAGES = {
  HotkeyInvalid: "That shortcut is not supported. The previous hotkey is still active.",
  HotkeyUnavailable: "That shortcut is already in use. The previous hotkey is still active."
};

export async function setupClipboardHistory({ document, invoke, listen, storage, notify, isMac }) {
  if (!isMac) return;
  const $ = (id) => document.getElementById(id);
  $("clipboard-history-menu-section").hidden = false;
  $("clipboard-history-menu-divider").hidden = false;

  let settings = loadClipboardSettings(storage);
  let accessibilityTrusted = false;
  let capturing = false;

  function setStatus(text) {
    $("clipboard-settings-status").textContent = text;
  }

  function render() {
    const toggle = $("clipboard-history-toggle-btn");
    toggle.textContent = settings.enabled ? "On" : "Off";
    toggle.setAttribute("aria-pressed", String(settings.enabled));
    $("clipboard-capacity-input").value = String(settings.capacity);
    $("clipboard-ttl-input").value = String(settings.ttlMinutes);
    $("clipboard-hotkey-btn").textContent = capturing ? "Press a shortcut…" : formatAccelerator(settings.hotkey);
    const autoPaste = $("clipboard-autopaste-toggle-btn");
    autoPaste.textContent = settings.autoPaste ? "On" : "Off";
    autoPaste.setAttribute("aria-pressed", String(settings.autoPaste));
    $("clipboard-accessibility-row").hidden = !(settings.autoPaste && !accessibilityTrusted);
  }

  async function apply(next) {
    const requested = normalizeClipboardSettings(next);
    try {
      const status = await invoke("clip_set_config", { config: requested });
      accessibilityTrusted = status?.accessibilityTrusted === true;
      settings = { ...requested, hotkey: status?.hotkey ?? requested.hotkey };
      setStatus(status?.hotkeyError ? HOTKEY_MESSAGES[status.hotkeyError] ?? HOTKEY_MESSAGES.HotkeyInvalid : "");
    } catch {
      settings = { ...requested, enabled: false };
      setStatus("Clipboard history could not be started.");
    }
    saveClipboardSettings(storage, settings);
    render();
  }

  $("clipboard-history-toggle-btn").addEventListener("click", () => apply({ ...settings, enabled: !settings.enabled }));
  $("clipboard-settings-btn").addEventListener("click", () => {
    const backdrop = $("clipboard-settings-modal-backdrop");
    backdrop.style.display = "flex";
    backdrop.setAttribute("aria-hidden", "false");
    render();
  });
  $("close-clipboard-settings-btn").addEventListener("click", () => {
    const backdrop = $("clipboard-settings-modal-backdrop");
    backdrop.style.display = "none";
    backdrop.setAttribute("aria-hidden", "true");
    capturing = false;
  });
  $("clipboard-capacity-input").addEventListener("change", (e) => apply({ ...settings, capacity: Number(e.target.value) }));
  $("clipboard-ttl-input").addEventListener("change", (e) => apply({ ...settings, ttlMinutes: Number(e.target.value) }));
  $("clipboard-hotkey-btn").addEventListener("click", () => { capturing = true; render(); });
  $("clipboard-hotkey-btn").addEventListener("keydown", (event) => {
    if (!capturing) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") { capturing = false; render(); return; }
    const accelerator = acceleratorFromKeyEvent(event);
    if (!accelerator) return;
    capturing = false;
    apply({ ...settings, hotkey: accelerator });
  });
  $("clipboard-hotkey-reset-btn").addEventListener("click", () => apply({ ...settings, hotkey: DEFAULT_CLIPBOARD_SETTINGS.hotkey }));
  $("clipboard-autopaste-toggle-btn").addEventListener("click", () => apply({ ...settings, autoPaste: !settings.autoPaste }));
  $("clipboard-accessibility-open-btn").addEventListener("click", () => invoke("open_accessibility_settings").catch(() => {}));

  if (typeof listen === "function") {
    await listen(STOPPED_EVENT, async () => {
      await apply({ ...settings, enabled: false });
      setStatus("Clipboard history stopped unexpectedly and was cleared.");
      notify?.("Clipboard history stopped unexpectedly");
    });
  }

  await apply(settings);
}
```
In `src/main.js`, add these imports:
```js
import { setupClipboardHistory } from "./clipboard-settings-ui.js";
import { isMacPlatform } from "./clipboard-settings.js";
```
In `init()`, after `await registerQuitHandler();`, add:
```js
  await setupClipboardHistory({
    document,
    invoke,
    listen: window.__TAURI__?.event?.listen,
    storage: localStorage,
    notify: showNotification,
    isMac: Boolean(window.__TAURI__) && isMacPlatform(navigator)
  });
```
In the harness, `window.__TAURI__` is set, so `isMac` follows the test's `platform`.

Add `&& node --check src/clipboard-settings.js && node --check src/clipboard-settings-ui.js` to `check:js`.

- [ ] **Step 9: Run all checks**

```bash
npm run check
```
Expected: PASS, including every existing test. The guard in `clipboard-boundary.test.js` confirms that `clipboard-settings-ui.js` calls only `clip_set_config`.

- [ ] **Step 10: Commit**

```bash
git add package.json src test
git commit -m "feat(clipboard): add clipboard history settings to the Sodilaud menu"
```

---

### Task 9: Documentation and manual checklist

**Files:**
- Create: `docs/clipboard-history.md`
- Modify: `README.md` (Features; Storage and privacy; Keyboard shortcuts), `SECURITY.md`, `RELEASE_NOTES.md`, `docs/mcp.md` (one line: clipboard history never enters the snapshot)

- [ ] **Step 1: Write `docs/clipboard-history.md`**

Content, in this order:
1. **What it does.** A two-paragraph summary.
2. **Settings table.** Copy it from the spec.
3. **Privacy guarantees.** RAM-only storage; wipe triggers; system clipboard clearing; current-host-only and concealed markers; the MCP boundary.
4. **Known residue.** The spec's list, verbatim.
5. **Manual macOS checklist.** A `- [ ]` list covering every item below:
   - Enable, copy three values in another app, and press ⌘⇧V. The popup appears centered at the top third of the focused screen. Repeat on a second monitor.
   - Press 1-3 and Enter to pick, then paste with ⌘V. Focus returns to the previous app.
   - Re-copy an existing value. It moves to the top, and its time left is unchanged.
   - Set the TTL to 1 min, copy a value, and wait. The row disappears, and `pbpaste` prints nothing.
   - Copy `ghp_…`, a JWT, `postgres://u:p@h`, and `API_KEY=x`. Each is masked; Space and the eye icon reveal it, and reopening the popup masks it again.
   - Trash a row. `pbpaste` prints nothing if that value was on the clipboard.
   - Lower the size to 1. The oldest entries go.
   - Disable the feature. The hotkey does nothing and the history is gone after re-enabling.
   - Auto-paste without Accessibility falls back to copy-only and shows the grant row. With Accessibility granted and Sodilaud restarted, a pick pastes immediately.
   - The tray shows Show, Clipboard History…, Clear, and Quit. Close the window: the Dock icon is gone and the tray icon stays. Quit exits. Pressing ⌘Q while the popup is open closes only the popup.
   - Set the TTL to 1 min, copy a value, sleep the Mac for 2 min, and wake it. The entry is gone within a second.
   - Picked values do not appear on an iPhone through Universal Clipboard, and a third-party clipboard manager ignores them.
   - Canary check: copy `sodilaud-canary-<random>`, use the popup, then quit. Then run:
     `grep -r "sodilaud-canary" ~/Library/Application\ Support/io.github.borgand.sodilaud ~/Library/WebKit ~/Library/Caches 2>/dev/null` and search your workspace `.db` file. Expected: no matches.
   - On Windows or Linux (if available), the settings section is absent and closing the window quits.

- [ ] **Step 2: Update README, SECURITY, RELEASE_NOTES, and mcp.md**

- **README Features:** add the bullet "Optional macOS clipboard history: in-memory only, expiring entries, secret masking, and a hotkey popup".
- **README Storage and privacy:** add a paragraph saying clipboard history lives only in process memory, is never written to storage, workspace files, or agents, and link `docs/clipboard-history.md`.
- **README Keyboard shortcuts:** add `⌘⇧V` (configurable) for the clipboard history popup.
- **SECURITY.md:** add a "Clipboard history" section with the trust boundary (popup-only capability; the main window can only configure; never MCP), the known residue list, and the note that auto-paste needs Accessibility, which lets Sodilaud send keystrokes.
- **RELEASE_NOTES.md:** add a new top section, "Unreleased: Clipboard history (macOS)", with 3-5 bullets in the existing style.
- **docs/mcp.md:** add one line in the privacy boundary section saying clipboard history is not part of the snapshot.

Run `npm run check:egress`. The docs are not scanned, but confirm the check stays green.

- [ ] **Step 3: Commit**

```bash
git add README.md SECURITY.md RELEASE_NOTES.md docs
git commit -m "docs(clipboard): document clipboard history, its privacy boundary, and a manual checklist"
```

---

### Task 10: Full verification, security review, and PR preparation

**Files:**
- Modify: whatever the review findings require
- Create (not committed): `<scratchpad>/pr-body.md`

- [ ] **Step 1: Run the full CI suite locally on macOS**

```bash
npm ci --ignore-scripts
npm run check
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --locked --manifest-path src-tauri/Cargo.toml
cargo test --locked --manifest-path src-tauri/Cargo.toml clipboard::pasteboard -- --ignored
```
Expected: all green. Paste the output summary into the PR body.

- [ ] **Step 2: Cross-platform sanity check**

Run `cargo check --locked --manifest-path src-tauri/Cargo.toml --target x86_64-unknown-linux-gnu` if that target is installed (`rustup target list --installed`). If it isn't, say so in the PR body and rely on CI. Either way, read every `#[cfg(not(target_os = "macos"))]` branch once to confirm it compiles in principle: no unused-variable warnings, correct return types.

- [ ] **Step 3: Security review**

Dispatch the `security-reviewer` agent on `git diff main...feat/clipboard-history`, with this focus:
- Can any clipboard value reach disk, logs, localStorage, the DB, MCP, or the network?
- Is the capability isolation correct?
- Can the main window reach entries?
- Are the pasteboard markers correct?
- Is the panic-hook silencing sound?
- Can a webview script trigger auto-paste?

Fix every finding with its own commit (`fix(clipboard): …`), or write a justification for the PR body. Re-run Step 1 after the fixes.

- [ ] **Step 4: Review the whole diff yourself**

Run `git diff main...feat/clipboard-history --stat` and read the full diff. Look for leftover stubs ("Replaced in Task 6"), `#![allow(dead_code)]`, and anything outside the spec's scope.

- [ ] **Step 5: Write the PR title and body**

Title: `feat(clipboard): in-memory clipboard history for macOS`

Body (`pr-body.md` in the scratchpad):
- Summary (3 bullets)
- Spec and plan links
- Privacy design (capability isolation; masked-by-default IPC; wipe triggers)
- Test evidence: the Step 1 output summary
- Security review: findings and their resolutions
- Manual checklist: copied from `docs/clipboard-history.md`, unchecked, for the owner to run
- Note: stacked on `chore/rebrand-sodilaud`; rebase onto `main` after that merges

- [ ] **Step 6: Hand off**

Report the branch name, the commit list (`git log --oneline main..feat/clipboard-history`), the path to `pr-body.md`, and the command the owner runs: `git push -u origin feat/clipboard-history`. Do not push.
