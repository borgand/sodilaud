// SPDX-License-Identifier: GPL-3.0-or-later

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

    #[allow(dead_code)] // clippy::len_without_is_empty requires this alongside len().
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
        evicted.reverse();
        evicted
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    const TTL: u64 = 10_000;

    fn texts(history: &History<String>) -> Vec<&str> {
        history
            .entries()
            .map(|entry| entry.value.as_str())
            .collect()
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
        let make = |text: &str| Tracked {
            text: text.into(),
            drops: drops.clone(),
        };
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
