// SPDX-License-Identifier: GPL-3.0-or-later

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
        general()
            .types()
            .is_some_and(|types| types.iter().any(|kind| kind.to_string() == OWN_MARKER))
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
        let types = NSArray::from_slice(&[text_type, &markers[0], &markers[1], &markers[2]]);
        // SAFETY: owner nil is allowed; types are valid pasteboard type strings.
        unsafe { pasteboard.addTypes_owner(&types, None) };
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "overwrites the real macOS clipboard; run with --ignored"]
    fn round_trip_marks_and_clears_own_writes() {
        let pasteboard = MacPasteboard;
        assert!(pasteboard.write_text("sodilaud-clipboard-test"));
        assert!(pasteboard.is_own_write());
        assert_eq!(
            pasteboard.read_text().as_deref().map(String::as_str),
            Some("sodilaud-clipboard-test")
        );
        assert!(!pasteboard.clear_if_equals("something else"));
        assert!(pasteboard.clear_if_equals("sodilaud-clipboard-test"));
        assert!(pasteboard.read_text().is_none());
    }
}
