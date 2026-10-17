//! The letterbox: the world target keeps its aspect inside any window, centred, with black bars.
//! Integer arithmetic, so the same sizes always give the same rectangle on every target.
//! [`present`] draws the world into it, filtered by the ratio.

use crate::caps::{MAX_WORLD_PX, MIN_WORLD_PX};

/// The window present: the world target filtered into a window's letterbox.
pub mod present;

/// A rectangle of window pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Viewport {
    /// Left edge.
    pub x: u32,
    /// Top edge.
    pub y: u32,
    /// Width.
    pub width: u32,
    /// Height.
    pub height: u32,
}

/// Where a `world` sized image goes inside a `window`: the largest aspect-preserving fit, centred.
pub fn letterbox(window: (u32, u32), world: (u32, u32)) -> Viewport {
    let (ww, wh) = (u64::from(window.0), u64::from(window.1));
    let (w, h) = (u64::from(world.0), u64::from(world.1));
    if ww == 0 || wh == 0 || w == 0 || h == 0 {
        return Viewport { x: 0, y: 0, width: 0, height: 0 };
    }
    // Width-limited when the window is relatively narrower than the world.
    let (width, height) = if ww * h <= wh * w { (ww, ww * h / w) } else { (wh * w / h, wh) };
    // Both fit in u32: each is at most the window's own side.
    let narrow = |v: u64| u32::try_from(v).unwrap_or(u32::MAX);
    Viewport { x: narrow((ww - width) / 2), y: narrow((wh - height) / 2), width: narrow(width), height: narrow(height) }
}

/// The output size Live draws a `world`-sized game at in a `window` (renderer pass 2, P2-0.9 step
/// B; findings F1/RC-03): the letterbox's own pixels, so the window present copies them texel for
/// texel, scaled down with the letterbox's aspect while they are more than `cap_px` pixels (the
/// class's reference resolution; 0 is no cap) or a side is over [`MAX_WORLD_PX`]. The world size
/// when there is no letterbox yet or a side would be under [`MIN_WORLD_PX`] (the present then
/// filters the world down). `world_size` stays the logical size: input, the HUD's points and the
/// default capture size.
pub fn output_for_window(world: (u32, u32), window: (u32, u32), cap_px: u64) -> (u32, u32) {
    let view = letterbox(window, world);
    let (vw, vh) = (u64::from(view.width), u64::from(view.height));
    if vw == 0 || vh == 0 {
        return world;
    }
    // Integer arithmetic, as the letterbox's: the widest side whose height keeps the aspect and
    // whose pixels stay within the cap (w * w * vh / vw <= cap).
    let capped = if cap_px > 0 && vw * vh > cap_px { (cap_px.saturating_mul(vw) / vh).isqrt() } else { vw };
    let max = u64::from(MAX_WORLD_PX);
    let width = capped.min(vw).min(max).min(max * vw / vh);
    let height = width * vh / vw;
    let narrow = |v: u64| u32::try_from(v).unwrap_or(MAX_WORLD_PX);
    let (w, h) = (narrow(width), narrow(height));
    if w < MIN_WORLD_PX || h < MIN_WORLD_PX {
        return world;
    }
    (w, h)
}

/// A window point in world pixels, or `None` when it falls on a bar.
pub fn window_to_world(window: (u32, u32), world: (u32, u32), point: (f32, f32)) -> Option<(f32, f32)> {
    let view = letterbox(window, world);
    let (x, y) = (point.0 - view.x as f32, point.1 - view.y as f32);
    let inside = x >= 0.0 && y >= 0.0 && x < view.width as f32 && y < view.height as f32;
    if !inside {
        return None;
    }
    Some((x * world.0 as f32 / view.width as f32, y * world.1 as f32 / view.height as f32))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The template's world, and the reference resolutions' pixels the cap is given in.
    const TEMPLATE: (u32, u32) = (960, 540);
    const DESKTOP_CAP: u64 = 2560 * 1440;
    const LAPTOP_CAP: u64 = 1920 * 1080;

    /// Renderer pass 2, P2-0.9 step B (F1/RC-03): Live renders at the letterbox's own pixels, so
    /// a 960x540 game in a 1920x1080 window is drawn at 1920x1080, never at 960x540 stretched.
    #[test]
    fn live_output_is_the_letterbox_s_own_pixels_under_the_cap() {
        assert_eq!(output_for_window(TEMPLATE, (1920, 1080), DESKTOP_CAP), (1920, 1080));
        assert_eq!(output_for_window(TEMPLATE, (2560, 1440), DESKTOP_CAP), (2560, 1440));
        assert_eq!(output_for_window(TEMPLATE, (2000, 1080), DESKTOP_CAP), (1920, 1080), "a wider window: bars at the sides");
        assert_eq!(output_for_window(TEMPLATE, (480, 270), DESKTOP_CAP), (480, 270), "a smaller ring renders fewer pixels");
        assert_eq!(output_for_window((1280, 720), (1280, 720), DESKTOP_CAP), (1280, 720), "a window of the world's size");
    }

    /// Over the class's reference pixels the output keeps the letterbox's aspect at the cap; the
    /// window present upscales the rest.
    #[test]
    fn a_window_over_the_cap_renders_at_the_cap_with_the_world_s_aspect() {
        let (w, h) = output_for_window(TEMPLATE, (3840, 2160), DESKTOP_CAP);
        assert!(u64::from(w) * u64::from(h) <= DESKTOP_CAP, "{w}x{h} within the cap");
        assert_eq!((w, h), (2560, 1440));
        let (w, h) = output_for_window(TEMPLATE, (3840, 2160), LAPTOP_CAP);
        assert_eq!((w, h), (1920, 1080));
        let (w, h) = output_for_window((1000, 1000), (3000, 3000), LAPTOP_CAP);
        assert!(u64::from(w) * u64::from(h) <= LAPTOP_CAP && w == h, "{w}x{h} square within the cap");
    }

    /// Hostile sizes: an empty window or world, a window too small to draw at the world's aspect,
    /// and no cap at all each answer a size within the world target's limits.
    #[test]
    fn odd_windows_answer_a_size_within_the_world_target_s_limits() {
        assert_eq!(output_for_window(TEMPLATE, (0, 0), DESKTOP_CAP), TEMPLATE, "no window yet: the world");
        assert_eq!(output_for_window(TEMPLATE, (1920, 0), DESKTOP_CAP), TEMPLATE);
        assert_eq!(output_for_window(TEMPLATE, (80, 45), DESKTOP_CAP), TEMPLATE, "below the smallest target: the world");
        let (w, h) = output_for_window(TEMPLATE, (16_000, 9_000), u64::MAX);
        assert!(w <= MAX_WORLD_PX && h <= MAX_WORLD_PX && w >= MIN_WORLD_PX && h >= MIN_WORLD_PX, "{w}x{h}");
        assert_eq!((w, h), (4096, 2304), "the largest target keeps the aspect");
        assert_eq!(output_for_window(TEMPLATE, (1920, 1080), 0), (1920, 1080), "a cap of 0 is no cap");
    }
}
