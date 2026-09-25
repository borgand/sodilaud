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
                service
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .take();
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
