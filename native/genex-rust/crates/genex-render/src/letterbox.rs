//! The letterbox: the world target keeps its aspect inside any window, centred, with black bars.
//! Integer arithmetic, so the same sizes always give the same rectangle on every target.
//! [`present`] draws the world into it, filtered by the ratio. A game whose `[game] fit` is
//! `expand` ([`Fit::Expand`]) fills the window instead: its world stays whole on the letterbox's
//! rectangle and the view grows past it on the window's long side ([`view_rect`]).

use crate::caps::{MAX_WORLD_PX, MIN_WORLD_PX};

/// The window present: the world target filtered into a window's letterbox.
pub mod present;

/// How a game's world fills a window of another aspect (`genex.toml [game] fit`, `Game::fit`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Fit {
    /// The world keeps its size and aspect, centred between black bars.
    #[default]
    Letterbox,
    /// The world is a safe frame: whole, on the letterbox's rectangle, with the view grown on the
    /// window's long side to fill it (more scene at the sides of a wide window, Hor+; above and
    /// below in a tall one). Input, the HUD and captures at the world size see the world as before.
    Expand,
}

impl Fit {
    /// Every fit.
    pub const ALL: [Fit; 2] = [Fit::Letterbox, Fit::Expand];

    /// The wire spelling (`[game] fit`).
    pub const fn as_str(self) -> &'static str {
        match self {
            Fit::Letterbox => "letterbox",
            Fit::Expand => "expand",
        }
    }

    /// The fit `wire` spells, or None for any other text.
    pub fn from_wire(wire: &str) -> Option<Fit> {
        Fit::ALL.into_iter().find(|fit| fit.as_str() == wire)
    }
}

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

/// [`output_for_window`] under `fit`: under [`Fit::Expand`] the window's own pixels at its own
/// aspect (capped alike), so the present leaves no bars; the world size when there is no window
/// yet or a side would be under [`MIN_WORLD_PX`].
pub fn output_for(world: (u32, u32), window: (u32, u32), cap_px: u64, fit: Fit) -> (u32, u32) {
    if fit == Fit::Letterbox {
        return output_for_window(world, window, cap_px);
    }
    let output = output_for_window(window, window, cap_px);
    let usable = output.0 >= MIN_WORLD_PX && output.1 >= MIN_WORLD_PX;
    if usable { output } else { world }
}

/// The rectangle of world pixels an `output`-sized frame shows of a `world` under `fit`: x, y,
/// width, height. The world itself under [`Fit::Letterbox`] and for an output of the world's
/// aspect; under [`Fit::Expand`] the world grown on the output's long side, centred, so the world
/// is whole in every output and sits where the letterbox would put it.
pub fn view_rect(world: (u32, u32), output: (u32, u32), fit: Fit) -> [f32; 4] {
    let (w, h) = (world.0 as f32, world.1 as f32);
    let whole = [0.0, 0.0, w, h];
    let (ow, oh) = (u64::from(output.0), u64::from(output.1));
    let (cross_output, cross_world) = (ow * u64::from(world.1), oh * u64::from(world.0));
    let degenerate = ow == 0 || oh == 0 || world.0 == 0 || world.1 == 0;
    if fit == Fit::Letterbox || degenerate || cross_output == cross_world {
        return whole;
    }
    if cross_output > cross_world {
        // Wider than the world: its height, a wider view.
        let width = h * output.0 as f32 / output.1 as f32;
        return [(w - width) / 2.0, 0.0, width, h];
    }
    let height = w * output.1 as f32 / output.0 as f32;
    [0.0, (h - height) / 2.0, w, height]
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
        // WP-9 flipped 4096x2304 -> 8192x4608: a native target reaches 8192 a side (4096 on the web).
        assert_eq!((w, h), (MAX_WORLD_PX, MAX_WORLD_PX * 9 / 16), "the largest target keeps the aspect");
        assert_eq!(output_for_window(TEMPLATE, (1920, 1080), 0), (1920, 1080), "a cap of 0 is no cap");
    }

    /// Lane EF: under `fit = "expand"` Live draws at the window's own aspect, so the present leaves
    /// no bars, within the same caps; letterbox keeps the world's aspect.
    #[test]
    fn expand_draws_at_the_window_s_aspect_and_letterbox_at_the_world_s() {
        let ultrawide = (2520, 1080);
        let classic = (1440, 1080);
        assert_eq!(output_for(TEMPLATE, ultrawide, DESKTOP_CAP, Fit::Expand), ultrawide, "21:9: the whole window");
        assert_eq!(output_for(TEMPLATE, classic, DESKTOP_CAP, Fit::Expand), classic, "4:3: the whole window");
        assert_eq!(output_for(TEMPLATE, ultrawide, DESKTOP_CAP, Fit::Letterbox), (1920, 1080), "letterbox: bars at the sides");
        assert_eq!(output_for(TEMPLATE, classic, DESKTOP_CAP, Fit::Letterbox), (1440, 810), "letterbox: bars above and below");
        let (w, h) = output_for(TEMPLATE, (5040, 2160), DESKTOP_CAP, Fit::Expand);
        assert!(u64::from(w) * u64::from(h) <= DESKTOP_CAP, "{w}x{h} within the cap");
        assert_eq!(u64::from(w) * 2160 / 5040, u64::from(h), "{w}x{h} keeps the window's aspect");
        assert_eq!(output_for(TEMPLATE, (0, 0), DESKTOP_CAP, Fit::Expand), TEMPLATE, "no window yet: the world");
        assert_eq!(output_for(TEMPLATE, (40, 30), DESKTOP_CAP, Fit::Expand), TEMPLATE, "below the smallest target: the world");
        let (w, h) = output_for(TEMPLATE, (16_000, 4_000), u64::MAX, Fit::Expand);
        assert!(w <= MAX_WORLD_PX && h >= MIN_WORLD_PX, "{w}x{h} within the target limits");
    }

    /// The view an output shows: the world itself under letterbox and at the world's aspect; under
    /// expand the world stays whole and centred and the view grows on the output's long side.
    #[test]
    fn the_expanded_view_keeps_the_world_whole_and_centred() {
        let whole = [0.0, 0.0, 960.0, 540.0];
        assert_eq!(view_rect(TEMPLATE, (1920, 1080), Fit::Expand), whole, "the world's aspect: the world");
        assert_eq!(view_rect(TEMPLATE, (960, 540), Fit::Expand), whole);
        assert_eq!(view_rect(TEMPLATE, (2520, 1080), Fit::Letterbox), whole, "letterbox: always the world");
        assert_eq!(view_rect(TEMPLATE, (2520, 1080), Fit::Expand), [-150.0, 0.0, 1260.0, 540.0], "21:9: wider");
        assert_eq!(view_rect(TEMPLATE, (1440, 1080), Fit::Expand), [0.0, -90.0, 960.0, 720.0], "4:3: taller");
        assert_eq!(view_rect(TEMPLATE, (0, 0), Fit::Expand), whole, "an empty output: the world");
    }

    /// Under expand the world lands where the letterbox would put it: input mapped through the
    /// letterbox (Studio's ring, the desktop window, the web canvas) reads the same world points.
    #[test]
    fn the_expanded_world_sits_on_the_letterbox_rectangle() {
        for window in [(2520, 1080), (1440, 1080), (1920, 1080), (1000, 1000)] {
            let [x, y, width, height] = view_rect(TEMPLATE, window, Fit::Expand);
            let scale = window.0 as f32 / width;
            assert!((window.1 as f32 / height - scale).abs() < 1e-4, "{window:?}: one scale both ways");
            let place = letterbox(window, TEMPLATE);
            assert!((-x * scale - place.x as f32).abs() <= 1.0, "{window:?}: left edge");
            assert!((-y * scale - place.y as f32).abs() <= 1.0, "{window:?}: top edge");
        }
    }

    /// The wire spellings of `[game] fit`, and the default.
    #[test]
    fn fit_reads_its_two_wire_spellings_only() {
        assert_eq!(Fit::default(), Fit::Letterbox);
        for fit in Fit::ALL {
            assert_eq!(Fit::from_wire(fit.as_str()), Some(fit));
        }
        for hostile in ["", "Expand", "stretch", "expand ", "letterbox\0", "fill"] {
            assert_eq!(Fit::from_wire(hostile), None, "{hostile:?}");
        }
    }
}
