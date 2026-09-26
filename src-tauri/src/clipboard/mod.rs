// SPDX-License-Identifier: GPL-3.0-or-later

// Clipboard history. Values live only in this module's memory: they must never be
// logged, persisted, or passed to the MCP snapshot.

// The pure core is tested on every platform but only wired into the app on macOS.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

pub mod commands;
pub mod detect;
pub mod hygiene;
pub mod layout;
pub mod service;
pub mod store;

#[cfg(target_os = "macos")]
pub mod panel;
#[cfg(target_os = "macos")]
pub mod pasteboard;
#[cfg(target_os = "macos")]
pub mod popup;
#[cfg(target_os = "macos")]
pub mod runtime;
#[cfg(target_os = "macos")]
pub mod tray;
#[cfg(target_os = "macos")]
pub mod watcher;
