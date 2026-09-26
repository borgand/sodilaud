// SPDX-License-Identifier: GPL-3.0-or-later

// The popup window is created once and then only shown and hidden. These are the
// decisions behind that, kept free of AppKit so they are tested on every platform.

use super::service::is_css_hex_color;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum PopupState {
    #[default]
    Hidden,
    /// Ordered in but fully transparent while the page renders the list.
    Showing,
    Shown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToggleAction {
    /// The window is missing (creation failed earlier): create it, then show.
    Create,
    Show,
    Hide,
}

pub fn toggle_action(exists: bool, state: PopupState) -> ToggleAction {
    match (exists, state) {
        (false, _) => ToggleAction::Create,
        (true, PopupState::Hidden) => ToggleAction::Show,
        (true, PopupState::Showing | PopupState::Shown) => ToggleAction::Hide,
    }
}

/// The page's readiness signal makes the panel visible only for the show that is
/// still pending, never after a hide overtook it.
pub fn accepts_shown(state: PopupState) -> bool {
    state == PopupState::Showing
}

/// A hide does its work (forget the page, restore focus, paste) only once.
pub fn needs_hide(state: PopupState) -> bool {
    state != PopupState::Hidden
}

const DEFAULT_BACKGROUND: (u8, u8, u8, u8) = (0x1e, 0x1e, 0x20, 0xff);

/// The native window colour behind the page, from the theme's background when it
/// is a valid hex colour, otherwise the popup's dark default.
pub fn window_background(background: Option<&str>) -> (u8, u8, u8, u8) {
    background
        .filter(|value| is_css_hex_color(value))
        .and_then(parse_hex)
        .unwrap_or(DEFAULT_BACKGROUND)
}

fn parse_hex(value: &str) -> Option<(u8, u8, u8, u8)> {
    let digits = value.strip_prefix('#')?;
    let channel = |index: usize, width: usize| {
        let part = digits.get(index * width..(index + 1) * width)?;
        let parsed = u8::from_str_radix(part, 16).ok()?;
        Some(if width == 1 { parsed * 17 } else { parsed })
    };
    let width = if digits.len() == 3 { 1 } else { 2 };
    let alpha = if digits.len() == 8 {
        channel(3, 2)?
    } else {
        0xff
    };
    Some((
        channel(0, width)?,
        channel(1, width)?,
        channel(2, width)?,
        alpha,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toggle_shows_a_hidden_popup_and_hides_a_visible_or_pending_one() {
        assert_eq!(toggle_action(true, PopupState::Hidden), ToggleAction::Show);
        assert_eq!(toggle_action(true, PopupState::Showing), ToggleAction::Hide);
        assert_eq!(toggle_action(true, PopupState::Shown), ToggleAction::Hide);
    }

    #[test]
    fn toggle_creates_only_when_the_window_is_missing() {
        for state in [PopupState::Hidden, PopupState::Showing, PopupState::Shown] {
            assert_eq!(toggle_action(false, state), ToggleAction::Create);
        }
    }

    #[test]
    fn readiness_is_accepted_only_for_a_pending_show() {
        assert!(accepts_shown(PopupState::Showing));
        assert!(!accepts_shown(PopupState::Hidden));
        assert!(!accepts_shown(PopupState::Shown));
    }

    #[test]
    fn hide_work_runs_once() {
        assert!(!needs_hide(PopupState::Hidden));
        assert!(needs_hide(PopupState::Showing));
        assert!(needs_hide(PopupState::Shown));
    }

    #[test]
    fn window_background_follows_a_valid_theme_colour() {
        assert_eq!(window_background(Some("#101820")), (0x10, 0x18, 0x20, 0xff));
        assert_eq!(window_background(Some("#fff")), (0xff, 0xff, 0xff, 0xff));
        assert_eq!(
            window_background(Some("#10182080")),
            (0x10, 0x18, 0x20, 0x80)
        );
    }

    #[test]
    fn window_background_falls_back_to_the_dark_default() {
        assert_eq!(window_background(None), DEFAULT_BACKGROUND);
        assert_eq!(window_background(Some("red")), DEFAULT_BACKGROUND);
        assert_eq!(window_background(Some("#12345")), DEFAULT_BACKGROUND);
    }
}
