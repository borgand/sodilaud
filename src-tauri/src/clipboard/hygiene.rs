// SPDX-License-Identifier: GPL-3.0-or-later

/// Panic messages for string slicing include the string itself, so a panic raised
/// from this module must not reach the default hook, which prints to stderr.
pub fn is_clipboard_location(file: &str) -> bool {
    let normalized = file.replace('\\', "/");
    let absolute = concat!(env!("CARGO_MANIFEST_DIR"), "/src/clipboard/").replace('\\', "/");
    normalized.starts_with("src/clipboard/") || normalized.starts_with(&absolute)
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
    let mut spec = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
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
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: `limit` is a valid rlimit for both calls.
    unsafe {
        if libc::getrlimit(libc::RLIMIT_CORE, &mut limit) == 0 {
            limit.rlim_cur = 0;
            libc::setrlimit(libc::RLIMIT_CORE, &limit);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panic_filter_matches_clipboard_files() {
        assert!(is_clipboard_location("src/clipboard/detect.rs"));
        assert!(is_clipboard_location("src\\clipboard\\service.rs"));
        assert!(!is_clipboard_location("src/mcp.rs"));
        assert!(!is_clipboard_location(
            "/Users/x/.cargo/registry/src/tauri/lib.rs"
        ));
        assert!(!is_clipboard_location(
            "/Users/x/.cargo/registry/src/foo/src/clipboard/lib.rs"
        ));
        assert!(is_clipboard_location(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/src/clipboard/detect.rs"
        )));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn monotonic_clock_advances() {
        let first = now_ms();
        std::thread::sleep(std::time::Duration::from_millis(20));
        assert!(now_ms() >= first + 15);
    }
}
