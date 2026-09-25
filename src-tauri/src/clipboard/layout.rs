// SPDX-License-Identifier: GPL-3.0-or-later

pub const WIDTH: f64 = 440.0;
const HEADER: f64 = 40.0;
const FOOTER: f64 = 30.0;
const ROW: f64 = 34.0;
const MAX_VISIBLE_ROWS: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

pub fn popup_height(rows: usize) -> f64 {
    HEADER + FOOTER + ROW * rows.clamp(1, MAX_VISIBLE_ROWS) as f64
}

/// `screen` is an AppKit frame (bottom-left origin on the primary screen); the
/// result is a top-left logical position as Tauri expects.
pub fn popup_origin(screen: Rect, primary_height: f64, width: f64) -> (f64, f64) {
    let x = screen.x + (screen.width - width) / 2.0;
    let top = primary_height - (screen.y + screen.height);
    (x, top + screen.height / 3.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn popup_is_centered_at_one_third_of_the_primary_screen() {
        let screen = Rect {
            x: 0.0,
            y: 0.0,
            width: 1440.0,
            height: 900.0,
        };
        assert_eq!(popup_origin(screen, 900.0, WIDTH), (500.0, 300.0));
    }

    #[test]
    fn popup_uses_the_focused_screen_in_appkit_coordinates() {
        // A 1920x1080 screen to the right of a 1440x900 primary, bottoms aligned.
        let screen = Rect {
            x: 1440.0,
            y: 0.0,
            width: 1920.0,
            height: 1080.0,
        };
        assert_eq!(
            popup_origin(screen, 900.0, WIDTH),
            (1440.0 + 740.0, -180.0 + 360.0)
        );
    }

    #[test]
    fn height_fits_rows_between_one_and_ten() {
        assert_eq!(popup_height(0), popup_height(1));
        assert!(popup_height(10) > popup_height(3));
        assert_eq!(popup_height(25), popup_height(10));
    }
}
