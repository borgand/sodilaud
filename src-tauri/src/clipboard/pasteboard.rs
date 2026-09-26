// SPDX-License-Identifier: GPL-3.0-or-later

use objc2::rc::autoreleasepool;
use objc2_app_kit::{NSPasteboard, NSPasteboardContentsOptions, NSPasteboardTypeString};
use objc2_foundation::{
    NSArray, NSRange, NSString, NSStringEncodingConversionOptions, NSUInteger, NSUTF8StringEncoding,
};
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

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

/// Copies the UTF-8 bytes straight into a locked, zeroized buffer. `to_str` is
/// avoided because `UTF8String` is NULL for strings with unpaired surrogates.
fn nsstring_to_secret(string: &NSString) -> Option<Secret> {
    let units = string.length();
    let expected = string.lengthOfBytesUsingEncoding(NSUTF8StringEncoding);
    // A length of 0 for a non-empty string means it has no UTF-8 form.
    if (expected == 0 && units > 0) || expected > MAX_VALUE_BYTES {
        return None;
    }
    if expected == 0 {
        return Some(Secret::new(String::new()));
    }
    let mut bytes = Zeroizing::new(Vec::<u8>::with_capacity(expected));
    lock_memory(bytes.as_ptr(), bytes.capacity());
    let mut used: NSUInteger = 0;
    let mut remaining = NSRange::new(0, 0);
    // SAFETY: the buffer has `expected` writable bytes, and `used` and `remaining`
    // are valid, writable locals.
    let complete = unsafe {
        string.getBytes_maxLength_usedLength_encoding_options_range_remainingRange(
            bytes.as_mut_ptr().cast(),
            expected,
            &mut used,
            NSUTF8StringEncoding,
            NSStringEncodingConversionOptions(0),
            NSRange::new(0, units),
            &mut remaining,
        )
    };
    if !complete || used > expected || remaining.length != 0 {
        return None;
    }
    // SAFETY: AppKit initialized the first `used` bytes, and `used <= capacity`.
    unsafe { bytes.set_len(used) };
    match String::from_utf8(std::mem::take(&mut *bytes)) {
        Ok(text) => Some(Secret::new(text)),
        Err(error) => {
            drop(Zeroizing::new(error.into_bytes()));
            None
        }
    }
}

impl Pasteboard for MacPasteboard {
    fn change_count(&self) -> i64 {
        autoreleasepool(|_| general().changeCount() as i64)
    }

    fn is_own_write(&self) -> bool {
        autoreleasepool(|_| {
            general()
                .types()
                .is_some_and(|types| types.iter().any(|kind| kind.to_string() == OWN_MARKER))
        })
    }

    fn read_text(&self) -> Option<Secret> {
        autoreleasepool(|_| {
            // SAFETY: NSPasteboardTypeString is an immutable AppKit constant.
            let string = general().stringForType(unsafe { NSPasteboardTypeString })?;
            nsstring_to_secret(&string)
        })
    }

    fn write_text(&self, value: &str) -> bool {
        autoreleasepool(|_| {
            let pasteboard = general();
            // CurrentHostOnly keeps the value off Universal Clipboard.
            pasteboard
                .prepareForNewContentsWithOptions(NSPasteboardContentsOptions::CurrentHostOnly);
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
        })
    }

    fn clear_if_equals(&self, value: &str) -> bool {
        autoreleasepool(|_| {
            let Some(current) = self.read_text() else {
                return false;
            };
            let equal: bool = current.as_bytes().ct_eq(value.as_bytes()).into();
            if equal {
                general().clearContents();
            }
            equal
        })
    }
}

#[cfg(test)]
mod tests {
    use std::ptr::NonNull;

    use super::*;

    #[test]
    fn unpaired_surrogate_is_rejected() {
        let units: [u16; 2] = [0x61, 0xD800];
        // SAFETY: `units` is a live array of two UTF-16 code units.
        let string =
            unsafe { NSString::stringWithCharacters_length(NonNull::from(&units).cast(), 2) };
        assert!(nsstring_to_secret(&string).is_none());
    }

    #[test]
    fn non_ascii_text_round_trips() {
        let secret = nsstring_to_secret(&NSString::from_str("pässwörd👍"));
        assert_eq!(secret.as_deref().map(String::as_str), Some("pässwörd👍"));
    }

    #[test]
    fn text_over_the_limit_is_rejected() {
        let at_limit = "a".repeat(MAX_VALUE_BYTES);
        let secret = nsstring_to_secret(&NSString::from_str(&at_limit));
        assert_eq!(
            secret.as_deref().map(String::as_str),
            Some(at_limit.as_str())
        );
        let over = "a".repeat(MAX_VALUE_BYTES + 1);
        assert!(nsstring_to_secret(&NSString::from_str(&over)).is_none());
    }

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
