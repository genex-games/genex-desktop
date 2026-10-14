//! Rotation and the world-size policy (Q5, decided for V1 in M2.12c): a game has one
//! `world_size`, letterboxed inside the safe area in either orientation. A rotation is a resize:
//! the shell re-reads the safe area, re-presents and keeps mapping fingers through the same
//! [`Presentation`], so the game never sees its world change size. [`RotationWatch`] notices
//! the orientation flip for the lifecycle log, and [`world_fill`] records how much of the safe
//! rectangle the world covers in each orientation, the evidence an iPhone run
//! needs to tell whether per-orientation sizes are worth offering later.

use crate::mobile::present::Presentation;

/// Which way the window is held.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Orientation {
    /// Taller than wide.
    Portrait,
    /// Wider than tall (a square window counts as landscape).
    Landscape,
}

impl Orientation {
    /// The orientation of a window `size`, or `None` for an empty one (a window being torn down).
    pub fn of(size: (u32, u32)) -> Option<Orientation> {
        if size.0 == 0 || size.1 == 0 {
            return None;
        }
        Some(if size.1 > size.0 { Orientation::Portrait } else { Orientation::Landscape })
    }

    /// The wire spelling (the lifecycle log).
    pub const fn wire(self) -> &'static str {
        match self {
            Orientation::Portrait => "portrait",
            Orientation::Landscape => "landscape",
        }
    }
}

/// The window's orientation over time.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RotationWatch {
    current: Option<Orientation>,
    rotations: u32,
}

impl RotationWatch {
    /// A new window size; answers the new orientation when the window rotated (never for the first
    /// size, nor for an empty one).
    pub fn observe(&mut self, size: (u32, u32)) -> Option<Orientation> {
        let now = Orientation::of(size)?;
        let before = self.current.replace(now)?;
        if before == now {
            return None;
        }
        self.rotations += 1;
        Some(now)
    }

    /// The orientation last seen.
    pub fn current(&self) -> Option<Orientation> {
        self.current
    }

    /// How many times the window rotated.
    pub fn rotations(&self) -> u32 {
        self.rotations
    }
}

/// The share of the safe rectangle the letterboxed world covers, 0 to 1 (0 for an empty window).
pub fn world_fill(presentation: &Presentation) -> f32 {
    let safe = presentation.safe_rect();
    let area = u64::from(safe.width) * u64::from(safe.height);
    if area == 0 {
        return 0.0;
    }
    let view = presentation.viewport();
    (u64::from(view.width) * u64::from(view.height)) as f32 / area as f32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mobile::safe_area::SafeArea;

    const WORLD: (u32, u32) = (960, 540);
    /// iPhone 15: 1179x2556 portrait (Dynamic Island, home indicator), landscape the other way.
    const PORTRAIT: (u32, u32) = (1179, 2556);
    const PORTRAIT_INSETS: SafeArea = SafeArea { top: 177, left: 0, bottom: 102, right: 0 };
    const LANDSCAPE: (u32, u32) = (2556, 1179);
    const LANDSCAPE_INSETS: SafeArea = SafeArea { top: 0, left: 177, bottom: 63, right: 177 };

    #[test]
    fn the_orientation_follows_the_window_shape() {
        assert_eq!(Orientation::of(PORTRAIT), Some(Orientation::Portrait));
        assert_eq!(Orientation::of(LANDSCAPE), Some(Orientation::Landscape));
        assert_eq!(Orientation::of((800, 800)), Some(Orientation::Landscape));
        assert_eq!(Orientation::of((0, 800)), None);
        assert_eq!(Orientation::Portrait.wire(), "portrait");
    }

    #[test]
    fn a_rotation_is_reported_once_per_flip_and_never_for_the_first_size() {
        let mut watch = RotationWatch::default();
        assert_eq!(watch.observe(PORTRAIT), None);
        assert_eq!(watch.observe((1179, 2400)), None, "a resize in the same orientation");
        assert_eq!(watch.observe((0, 0)), None);
        assert_eq!(watch.observe(LANDSCAPE), Some(Orientation::Landscape));
        assert_eq!(watch.observe(PORTRAIT), Some(Orientation::Portrait));
        assert_eq!(watch.rotations(), 2);
        assert_eq!(watch.current(), Some(Orientation::Portrait));
    }

    #[test]
    fn one_world_size_is_letterboxed_in_both_orientations_and_fingers_map_the_same() {
        let portrait = Presentation::new(PORTRAIT, PORTRAIT_INSETS, WORLD);
        let landscape = Presentation::new(LANDSCAPE, LANDSCAPE_INSETS, WORLD);
        assert_eq!(portrait.world(), landscape.world(), "the game's world never changes size");
        for presentation in [portrait, landscape] {
            let view = presentation.viewport();
            let centre = (view.x as f32 + view.width as f32 / 2.0, view.y as f32 + view.height as f32 / 2.0);
            let (x, y) = presentation.to_world(centre).expect("inside");
            assert!((x - 480.0).abs() < 1.0 && (y - 270.0).abs() < 1.0, "centre maps to the world's centre: {x},{y}");
        }
        // Landscape: 1984x1116 of the 2202x1116 safe rectangle; portrait: 1179x663 of 1179x2277.
        assert!((world_fill(&landscape) - 0.901).abs() < 0.001, "{}", world_fill(&landscape));
        assert!((world_fill(&portrait) - 0.291).abs() < 0.001, "{}", world_fill(&portrait));
        assert_eq!(world_fill(&Presentation::new((0, 0), SafeArea::default(), WORLD)), 0.0);
    }
}
