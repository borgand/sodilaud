// SPDX-License-Identifier: GPL-3.0-or-later

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
            hotkey: if is_valid_hotkey(&hotkey) {
                hotkey
            } else {
                DEFAULT_HOTKEY.to_string()
            },
            ..self
        }
    }

    pub fn ttl_ms(&self) -> u64 {
        self.ttl_minutes * 60_000
    }
}

const HOTKEY_MODIFIERS: &[&str] = &["super", "ctrl", "alt", "shift"];
const HOTKEY_NAMED_KEYS: &[&str] = &[
    "Space",
    "Backquote",
    "Minus",
    "Equal",
    "BracketLeft",
    "BracketRight",
    "Semicolon",
    "Quote",
    "Comma",
    "Period",
    "Slash",
    "Backslash",
];

/// Mirrors isValidAccelerator in src/clipboard-settings.js.
fn is_valid_hotkey(hotkey: &str) -> bool {
    let mut parts: Vec<&str> = hotkey.split('+').collect();
    let Some(code) = parts.pop() else {
        return false;
    };
    !parts.is_empty()
        && parts.iter().all(|part| HOTKEY_MODIFIERS.contains(part))
        && parts.iter().any(|part| *part != "shift")
        && is_hotkey_code(code)
}

fn is_hotkey_code(code: &str) -> bool {
    let single =
        |rest: &str, valid: fn(&u8) -> bool| rest.len() == 1 && rest.as_bytes().iter().all(valid);
    if let Some(rest) = code.strip_prefix("Key") {
        return single(rest, u8::is_ascii_uppercase);
    }
    if let Some(rest) = code.strip_prefix("Digit") {
        return single(rest, u8::is_ascii_digit);
    }
    if let Some(rest) = code.strip_prefix('F') {
        return matches!(rest.parse::<u8>(), Ok(1..=12)) && !rest.starts_with('0');
    }
    HOTKEY_NAMED_KEYS.contains(&code)
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
    #[allow(dead_code)] // Constructed only by clipboard commands built for non-macOS targets.
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
        self.reap(now_ms);
    }

    fn reap(&mut self, now_ms: u64) {
        let expired = self.history.reap_expired(now_ms);
        self.discard(expired);
    }

    pub fn list(&mut self, now_ms: u64) -> Vec<ListItem> {
        self.reap(now_ms);
        self.history
            .entries()
            .map(|entry| {
                let value = entry.value.as_str();
                let mask = classify(value);
                let (text, extra_lines) = match (hint(value, &mask), &mask) {
                    (Some(shown), Mask::Partial { .. }) => preview(&shown, PREVIEW_CHARS),
                    (Some(shown), _) => (preview(&shown, PREVIEW_CHARS).0, 0),
                    (None, _) => preview(value, PREVIEW_CHARS),
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

    pub fn reveal(&mut self, id: u64, now_ms: u64) -> Option<Secret> {
        self.reap(now_ms);
        self.history
            .get(id)
            .map(|entry| Zeroizing::new(entry.value.as_str().to_owned()))
    }

    pub fn select(&mut self, id: u64, now_ms: u64) -> bool {
        self.reap(now_ms);
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
        self.reap(now_ms);
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

    fn texts(service: &mut Service<Fake>) -> Vec<String> {
        service.list(0).into_iter().map(|item| item.text).collect()
    }

    #[test]
    fn captures_each_new_copy_once() {
        let fake = Fake::default();
        let mut service = service_with(&fake, 10);
        fake.copy("repo-name");
        service.poll(0);
        service.poll(1);
        assert_eq!(texts(&mut service), ["repo-name"]);
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
        assert!(service.select(id, 0));
        service.poll(0);
        assert_eq!(texts(&mut service), ["b", "a"]);
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
        assert_eq!(texts(&mut service), ["new"]);
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
        assert_eq!(texts(&mut service), ["a", "b"]);
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
        assert!(!service.select(42, 0));
        assert!(service.reveal(42, 0).is_none());
        assert!(fake.0.writes.borrow().is_empty());
    }

    fn expired_entry(fake: &Fake) -> (Service<Fake>, u64) {
        let mut service = service_with(fake, 10);
        fake.copy("expiring-value");
        service.poll(0);
        let id = service.list(0)[0].id;
        (service, id)
    }

    #[test]
    fn select_after_ttl_writes_nothing() {
        let fake = Fake::default();
        let (mut service, id) = expired_entry(&fake);
        fake.copy("something-else");
        assert!(!service.select(id, TTL));
        assert!(fake.0.writes.borrow().is_empty());
        assert_eq!(fake.current().as_deref(), Some("something-else"));
    }

    #[test]
    fn reveal_after_ttl_returns_nothing() {
        let fake = Fake::default();
        let (mut service, id) = expired_entry(&fake);
        assert!(service.reveal(id, TTL).is_none());
        assert_eq!(service.len(), 0);
    }

    #[test]
    fn list_after_ttl_omits_the_entry_and_clears_the_pasteboard() {
        let fake = Fake::default();
        let (mut service, _) = expired_entry(&fake);
        assert!(service.list(TTL).is_empty());
        assert_eq!(fake.current(), None);
        assert_eq!(*fake.0.clears.borrow(), ["expiring-value"]);
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
            service
                .reveal(items[0].id, 31_000)
                .as_deref()
                .map(String::as_str),
            Some("ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8")
        );
    }

    #[test]
    fn env_block_lists_its_masked_first_line_and_extra_lines() {
        let fake = Fake::default();
        let mut service = service_with(&fake, 10);
        fake.copy("DB_PASSWORD=hunter2hunter\nDB_HOST=localhost\nDB_PORT=5432\n");
        service.poll(0);
        let item = &service.list(0)[0];
        assert_eq!(item.text, "DB_PASSWORD=••••");
        assert!(item.masked);
        assert_eq!(item.extra_lines, 2);
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
        assert_eq!(texts(&mut service), ["b"]);
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
        assert_eq!(
            ClipConfig {
                capacity: 99,
                ..ClipConfig::default()
            }
            .normalized()
            .capacity,
            50
        );
        assert_eq!(ClipConfig::default().ttl_ms(), 600_000);
    }

    #[test]
    fn config_rejects_hotkeys_the_settings_ui_would_reject() {
        let hotkey = |value: &str| {
            ClipConfig {
                hotkey: value.into(),
                ..ClipConfig::default()
            }
            .normalized()
            .hotkey
        };
        for invalid in [
            "KeyV",
            "shift+KeyV",
            "super+KeyV+KeyB",
            "meta+KeyV",
            "super+",
            "super+F13",
            "super+super",
            "super+Enter",
        ] {
            assert_eq!(hotkey(invalid), DEFAULT_HOTKEY, "{invalid}");
        }
        for valid in [
            "super+shift+KeyV",
            "ctrl+alt+Digit1",
            "super+F5",
            "alt+F12",
            "ctrl+Backslash",
            "super+Space",
        ] {
            assert_eq!(hotkey(valid), valid);
        }
    }

    #[test]
    fn config_deserializes_camel_case() {
        let config: ClipConfig = serde_json::from_str(
            r#"{"enabled":true,"capacity":5,"ttlMinutes":3,"hotkey":"super+shift+KeyV","autoPaste":true}"#,
        )
        .unwrap();
        assert_eq!(
            (config.capacity, config.ttl_minutes, config.auto_paste),
            (5, 3, true)
        );
    }

    #[test]
    fn revealed_secrets_serialize_as_plain_strings() {
        let secret: Secret = Zeroizing::new("s3cr3t".to_string());
        assert_eq!(serde_json::to_string(&secret).unwrap(), "\"s3cr3t\"");
    }

    #[test]
    fn errors_serialize_without_payload() {
        assert_eq!(
            serde_json::to_string(&ClipError::HotkeyUnavailable).unwrap(),
            "\"HotkeyUnavailable\""
        );
    }
}
