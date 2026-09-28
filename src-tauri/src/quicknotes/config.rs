// SPDX-License-Identifier: GPL-3.0-or-later

// Quick Notes settings and window state, kept in app config so the hotkey can be
// registered and the windows restored before any page loads. Pure apart from
// `load` and `save`.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

pub const FILE_NAME: &str = "quicknotes.json";
pub const DEFAULT_WIDTH: f64 = 720.0;
pub const DEFAULT_HEIGHT: f64 = 520.0;
/// Below this much of its area on some screen, a restored panel is moved back.
const MIN_VISIBLE_FRACTION: f64 = 0.6;
const MIN_SIDE: f64 = 100.0;

#[cfg(target_os = "macos")]
pub const DEFAULT_HOTKEY: &str = "super+shift+KeyN";
#[cfg(not(target_os = "macos"))]
pub const DEFAULT_HOTKEY: &str = "ctrl+shift+KeyN";

/// A window or screen rectangle in physical pixels, origin top-left.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Frame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Frame {
    fn area(&self) -> f64 {
        self.width.max(0.0) * self.height.max(0.0)
    }

    fn overlap(&self, other: &Frame) -> f64 {
        let width = (self.x + self.width).min(other.x + other.width) - self.x.max(other.x);
        let height = (self.y + self.height).min(other.y + other.height) - self.y.max(other.y);
        width.max(0.0) * height.max(0.0)
    }

    fn is_usable(&self) -> bool {
        [self.x, self.y, self.width, self.height]
            .iter()
            .all(|value| value.is_finite())
            && self.width >= MIN_SIDE
            && self.height >= MIN_SIDE
    }
}

/// A monitor's work area and its scale factor.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Screen {
    pub frame: Frame,
    pub scale: f64,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct WindowsAtQuit {
    pub main: bool,
    pub quicknotes: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuickNotesConfig {
    #[serde(default = "default_hotkey")]
    pub hotkey: String,
    #[serde(default)]
    pub frame: Option<Frame>,
    #[serde(default)]
    pub windows_at_quit: Option<WindowsAtQuit>,
    /// Set once, on the first launch after upgrading from a release without
    /// Quick Notes, until the user dismisses the start page's banner.
    #[serde(default)]
    pub upgrade_intro: bool,
}

fn default_hotkey() -> String {
    DEFAULT_HOTKEY.to_string()
}

impl Default for QuickNotesConfig {
    fn default() -> Self {
        Self {
            hotkey: default_hotkey(),
            frame: None,
            windows_at_quit: None,
            upgrade_intro: false,
        }
    }
}

/// Reads the config, or `None` if there is no file yet. A file that cannot be
/// read or parsed gives the defaults, so a damaged file never blocks start-up.
pub fn load(path: &Path) -> Option<QuickNotesConfig> {
    match fs::read(path) {
        Ok(contents) => Some(serde_json::from_slice(&contents).unwrap_or_else(|error| {
            eprintln!("Quick Notes settings are unreadable, using defaults: {error}");
            QuickNotesConfig::default()
        })),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            eprintln!("Could not read Quick Notes settings, using defaults: {error}");
            Some(QuickNotesConfig::default())
        }
    }
}

pub fn save(path: &Path, config: &QuickNotesConfig) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Quick Notes settings path has no parent directory".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|e| format!("Could not create the Quick Notes settings directory: {e}"))?;
    let contents = serde_json::to_vec_pretty(config)
        .map_err(|e| format!("Could not serialize Quick Notes settings: {e}"))?;
    fs::write(path, contents).map_err(|e| format!("Could not write Quick Notes settings: {e}"))?;
    crate::restrict_to_owner(path)
}

/// The config to start with. With no config file yet, the user is upgrading if an
/// earlier release already wrote its preferences file.
pub fn initial(existing: Option<QuickNotesConfig>, earlier_release_ran: bool) -> QuickNotesConfig {
    existing.unwrap_or_else(|| QuickNotesConfig {
        upgrade_intro: earlier_release_ran,
        ..QuickNotesConfig::default()
    })
}

/// Where to put the panel: the saved frame if enough of it is on some screen,
/// otherwise the same size (up to the screen's) centered on `pointer`'s screen.
/// Without a usable saved frame, the default size is centered there.
pub fn clamp_frame(saved: Option<Frame>, screens: &[Screen], pointer: &Screen) -> Frame {
    let centered = |width: f64, height: f64| {
        let width = width.min(pointer.frame.width);
        let height = height.min(pointer.frame.height);
        Frame {
            x: pointer.frame.x + (pointer.frame.width - width) / 2.0,
            y: pointer.frame.y + (pointer.frame.height - height) / 2.0,
            width,
            height,
        }
    };
    let Some(frame) = saved.filter(Frame::is_usable) else {
        return centered(DEFAULT_WIDTH * pointer.scale, DEFAULT_HEIGHT * pointer.scale);
    };
    let best_visible = screens
        .iter()
        .map(|screen| frame.overlap(&screen.frame))
        .fold(0.0, f64::max);
    if best_visible >= frame.area() * MIN_VISIBLE_FRACTION {
        frame
    } else {
        centered(frame.width, frame.height)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn screen(x: f64, y: f64, width: f64, height: f64, scale: f64) -> Screen {
        Screen {
            frame: Frame {
                x,
                y,
                width,
                height,
            },
            scale,
        }
    }

    fn temp_path(name: &str) -> std::path::PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("sodilaud-qn-{name}-{nanos}")).join(FILE_NAME)
    }

    #[test]
    fn saves_and_loads_the_config() {
        let path = temp_path("roundtrip");
        let config = QuickNotesConfig {
            hotkey: "super+alt+KeyQ".into(),
            frame: Some(Frame {
                x: 10.0,
                y: 20.0,
                width: 800.0,
                height: 600.0,
            }),
            windows_at_quit: Some(WindowsAtQuit {
                main: false,
                quicknotes: true,
            }),
            upgrade_intro: true,
        };
        save(&path, &config).unwrap();
        assert_eq!(load(&path), Some(config));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn a_missing_file_is_none_and_a_corrupt_one_gives_defaults() {
        let path = temp_path("corrupt");
        assert_eq!(load(&path), None);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"{ not json").unwrap();
        assert_eq!(load(&path), Some(QuickNotesConfig::default()));
    }

    #[test]
    fn an_older_file_without_new_fields_keeps_its_hotkey() {
        let parsed: QuickNotesConfig =
            serde_json::from_str(r#"{ "hotkey": "super+alt+KeyN" }"#).unwrap();
        assert_eq!(parsed.hotkey, "super+alt+KeyN");
        assert_eq!(parsed.frame, None);
        assert!(!parsed.upgrade_intro);
    }

    #[test]
    fn the_upgrade_intro_is_only_for_users_of_an_earlier_release() {
        assert!(initial(None, true).upgrade_intro);
        assert!(!initial(None, false).upgrade_intro);
        let dismissed = QuickNotesConfig::default();
        assert!(!initial(Some(dismissed), true).upgrade_intro);
    }

    #[test]
    fn without_a_saved_frame_the_default_size_is_centered_on_the_pointer_screen() {
        let pointer = screen(1440.0, 0.0, 2560.0, 1440.0, 2.0);
        let frame = clamp_frame(None, &[pointer], &pointer);
        assert_eq!(
            frame,
            Frame {
                x: 1440.0 + (2560.0 - 1440.0) / 2.0,
                y: (1440.0 - 1040.0) / 2.0,
                width: 1440.0,
                height: 1040.0,
            }
        );
    }

    #[test]
    fn a_mostly_visible_frame_is_kept() {
        let main = screen(0.0, 0.0, 1440.0, 900.0, 1.0);
        let saved = Frame {
            x: 1000.0,
            y: 100.0,
            width: 600.0,
            height: 400.0,
        };
        // 440 of 600 px wide is on screen: 73%.
        assert_eq!(clamp_frame(Some(saved), &[main], &main), saved);
    }

    #[test]
    fn a_frame_on_an_unplugged_monitor_moves_to_the_pointer_screen() {
        let main = screen(0.0, 0.0, 1440.0, 900.0, 1.0);
        let saved = Frame {
            x: 3000.0,
            y: 200.0,
            width: 700.0,
            height: 500.0,
        };
        assert_eq!(
            clamp_frame(Some(saved), &[main], &main),
            Frame {
                x: 370.0,
                y: 200.0,
                width: 700.0,
                height: 500.0,
            }
        );
    }

    #[test]
    fn a_frame_larger_than_the_screen_is_shrunk_to_fit() {
        let small = screen(0.0, 0.0, 1024.0, 768.0, 1.0);
        let saved = Frame {
            x: -5000.0,
            y: 0.0,
            width: 2000.0,
            height: 1500.0,
        };
        assert_eq!(
            clamp_frame(Some(saved), &[small], &small),
            Frame {
                x: 0.0,
                y: 0.0,
                width: 1024.0,
                height: 768.0,
            }
        );
    }

    #[test]
    fn a_degenerate_saved_frame_falls_back_to_the_default() {
        let main = screen(0.0, 0.0, 1440.0, 900.0, 1.0);
        for saved in [
            Frame {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 0.0,
            },
            Frame {
                x: f64::NAN,
                y: 0.0,
                width: 700.0,
                height: 500.0,
            },
        ] {
            let frame = clamp_frame(Some(saved), &[main], &main);
            assert_eq!((frame.width, frame.height), (DEFAULT_WIDTH, DEFAULT_HEIGHT));
        }
    }
}
