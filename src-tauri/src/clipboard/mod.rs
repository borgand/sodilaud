// SPDX-License-Identifier: GPL-3.0-or-later

// Clipboard history. Values live only in this module's memory: they must never be
// logged, persisted, or passed to the MCP snapshot.

// The pure core is tested on every platform but only wired into the app on macOS.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]
#![allow(dead_code)] // Removed in Task 5 once the runtime uses the module.

pub mod detect;
pub mod store;
