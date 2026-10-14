//! The safe area: the part of the screen no notch, Dynamic Island, punch hole or home indicator
//! covers, as insets in physical pixels. On iOS winit reports it as the window's inner rectangle
//! inside its outer one; on Android it is the activity's content rectangle (winit's
//! `content_rect`) inside the window, widened by the display cutout the NativeActivity JNI bridge
//! reads. The shell presents the game inside it ([`crate::mobile::present`]).

/// Insets from each edge, in physical pixels.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SafeArea {
    /// From the top edge.
    pub top: u32,
    /// From the left edge.
    pub left: u32,
    /// From the bottom edge.
    pub bottom: u32,
    /// From the right edge.
    pub right: u32,
}

impl SafeArea {
    /// The insets of an `inner` rectangle at `inner_origin` inside an `outer` size (clamped, so a
    /// platform that reports an inner rectangle larger than the outer one gives zero insets).
    pub fn from_inner(outer: (u32, u32), inner_origin: (i32, i32), inner: (u32, u32)) -> SafeArea {
        let left = u32::try_from(inner_origin.0).unwrap_or(0).min(outer.0);
        let top = u32::try_from(inner_origin.1).unwrap_or(0).min(outer.1);
        SafeArea {
            top,
            left,
            right: outer.0.saturating_sub(left).saturating_sub(inner.0),
            bottom: outer.1.saturating_sub(top).saturating_sub(inner.1),
        }
    }

    /// The larger inset of `self` and `other` on each edge (content rect and display cutout).
    pub fn max(self, other: SafeArea) -> SafeArea {
        SafeArea {
            top: self.top.max(other.top),
            left: self.left.max(other.left),
            bottom: self.bottom.max(other.bottom),
            right: self.right.max(other.right),
        }
    }

    /// Whether no edge is inset.
    pub fn is_empty(&self) -> bool {
        *self == SafeArea::default()
    }

    /// The safe rectangle of a `window` as (x, y, width, height).
    pub fn rect(&self, window: (u32, u32)) -> (u32, u32, u32, u32) {
        let width = window.0.saturating_sub(self.left).saturating_sub(self.right);
        let height = window.1.saturating_sub(self.top).saturating_sub(self.bottom);
        (self.left.min(window.0), self.top.min(window.1), width, height)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_landscape_notch_and_home_indicator_become_insets() {
        // iPhone 15 landscape: 2556x1179, safe rect at (177, 0) of 2202x1116.
        let area = SafeArea::from_inner((2556, 1179), (177, 0), (2202, 1116));
        assert_eq!(area, SafeArea { top: 0, left: 177, bottom: 63, right: 177 });
        assert_eq!(area.rect((2556, 1179)), (177, 0, 2202, 1116));
    }

    #[test]
    fn a_content_rect_and_a_cutout_become_insets() {
        // A punch-hole phone in landscape: 2400x1080, content at (110, 0) of 2180x1080.
        let area = SafeArea::from_inner((2400, 1080), (110, 0), (2180, 1080));
        assert_eq!(area, SafeArea { top: 0, left: 110, bottom: 0, right: 110 });
        assert_eq!(area.rect((2400, 1080)), (110, 0, 2180, 1080));
        assert_eq!(area.max(SafeArea { top: 5, ..SafeArea::default() }), SafeArea { top: 5, left: 110, bottom: 0, right: 110 });
        assert!(!area.is_empty());
        assert!(SafeArea::default().is_empty());
    }

    #[test]
    fn nonsense_reports_clamp_to_the_window() {
        let area = SafeArea::from_inner((100, 100), (-5, 200), (500, 500));
        assert_eq!(area, SafeArea { top: 100, left: 0, bottom: 0, right: 0 });
        assert_eq!(area.rect((100, 100)), (0, 100, 100, 0));
    }
}
