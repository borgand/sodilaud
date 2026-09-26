// SPDX-License-Identifier: GPL-3.0-or-later

// The popup window is created once and then only shown and hidden. These are the
// decisions behind that, kept free of AppKit so they are tested on every platform.

use super::service::is_css_hex_color;

/// Each show and hide carries a fresh token, echoed back by the page's `clip_shown`
/// and `clip_hidden`, so a late answer to an earlier show or hide is ignored.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum PopupState {
    #[default]
    Hidden,
    /// Transparent and click-through, waiting for the page to paint its emptied
    /// DOM before the panel is ordered out.
    Hiding(u64),
    /// Ordered in but transparent and click-through while the page renders the list.
    Showing(u64),
    Shown(u64),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToggleAction {
    /// The window is missing (creation failed earlier): create it, then show.
    Create,
    Show,
    Hide,
}

/// `usable` is false when the window is missing or being destroyed.
pub fn toggle_action(usable: bool, state: PopupState) -> ToggleAction {
    match (usable, is_open(state)) {
        (false, _) => ToggleAction::Create,
        (true, false) => ToggleAction::Show,
        (true, true) => ToggleAction::Hide,
    }
}

/// Showing or shown: the only states in which the page may read or act on
/// entries, and the only ones a hide has work to do in.
pub fn is_open(state: PopupState) -> bool {
    matches!(state, PopupState::Showing(_) | PopupState::Shown(_))
}

/// The page painted the list for exactly the show still pending.
pub fn accepts_shown(state: PopupState, token: u64) -> bool {
    state == PopupState::Showing(token)
}

/// The page painted its emptied DOM for exactly the hide still pending (or that
/// hide's timeout fired).
pub fn accepts_hidden(state: PopupState, token: u64) -> bool {
    state == PopupState::Hiding(token)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CreatePlan {
    Reuse,
    Create,
    /// The old window is still being torn down under the same label; create the
    /// new one once its `Destroyed` event has removed it.
    AfterDestroy,
}

pub fn create_plan(exists: bool, destroying: bool) -> CreatePlan {
    match (exists, destroying) {
        (true, false) => CreatePlan::Reuse,
        (true, true) => CreatePlan::AfterDestroy,
        (false, _) => CreatePlan::Create,
    }
}

// Evaluated in the popup page; see `attach` in src/clipboard.js. Before the page
// has loaded, wry runs them at navigation commit, so a show leaves its token behind.
pub fn show_script(token: u64) -> String {
    format!("window.__sodilaudClip ? window.__sodilaudClip.show({token}) : (window.__sodilaudClipPending = {token})")
}

pub fn hide_script(token: u64) -> String {
    format!("window.__sodilaudClip ? window.__sodilaudClip.hide({token}) : (window.__sodilaudClipPending = false)")
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

    const T: u64 = 7;

    #[test]
    fn toggle_shows_a_closed_popup_and_hides_an_open_one() {
        assert_eq!(toggle_action(true, PopupState::Hidden), ToggleAction::Show);
        assert_eq!(
            toggle_action(true, PopupState::Hiding(T)),
            ToggleAction::Show
        );
        assert_eq!(
            toggle_action(true, PopupState::Showing(T)),
            ToggleAction::Hide
        );
        assert_eq!(
            toggle_action(true, PopupState::Shown(T)),
            ToggleAction::Hide
        );
    }

    #[test]
    fn toggle_creates_only_when_the_window_is_unusable() {
        for state in [
            PopupState::Hidden,
            PopupState::Hiding(T),
            PopupState::Showing(T),
            PopupState::Shown(T),
        ] {
            assert_eq!(toggle_action(false, state), ToggleAction::Create);
        }
    }

    #[test]
    fn entries_are_reachable_only_while_showing_or_shown() {
        assert!(is_open(PopupState::Showing(T)));
        assert!(is_open(PopupState::Shown(T)));
        assert!(!is_open(PopupState::Hidden));
        assert!(!is_open(PopupState::Hiding(T)));
    }

    #[test]
    fn readiness_is_accepted_only_for_the_pending_show() {
        assert!(accepts_shown(PopupState::Showing(T), T));
        assert!(!accepts_shown(PopupState::Showing(T + 1), T));
        assert!(!accepts_shown(PopupState::Hidden, T));
        assert!(!accepts_shown(PopupState::Hiding(T), T));
        assert!(!accepts_shown(PopupState::Shown(T), T));
    }

    #[test]
    fn hidden_ack_is_accepted_only_for_the_pending_hide() {
        assert!(accepts_hidden(PopupState::Hiding(T), T));
        assert!(!accepts_hidden(PopupState::Hiding(T + 1), T));
        assert!(!accepts_hidden(PopupState::Showing(T), T));
        assert!(!accepts_hidden(PopupState::Hidden, T));
    }

    #[test]
    fn a_window_being_destroyed_is_replaced_only_after_it_is_gone() {
        assert_eq!(create_plan(true, false), CreatePlan::Reuse);
        assert_eq!(create_plan(true, true), CreatePlan::AfterDestroy);
        assert_eq!(create_plan(false, true), CreatePlan::Create);
        assert_eq!(create_plan(false, false), CreatePlan::Create);
    }

    #[test]
    fn scripts_carry_the_token() {
        assert!(show_script(42).contains("show(42)"));
        assert!(show_script(42).contains("__sodilaudClipPending = 42"));
        assert!(hide_script(42).contains("hide(42)"));
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
