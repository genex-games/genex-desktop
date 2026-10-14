//! Where the world frame sits in the window: scaled to fit, centred, bars on the long side. A port
//! of the C++ runtime's `letterbox()` and the sampler's `fraction()`.

/// The world frame's rectangle inside the window, in window pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Letterbox {
    /// Left edge.
    pub x: f32,
    /// Top edge.
    pub y: f32,
    /// Width.
    pub width: f32,
    /// Height.
    pub height: f32,
}

impl Letterbox {
    /// Fit a `world` frame into a `window` of that many pixels; a degenerate window scales 1:1.
    pub fn fit(window: [f32; 2], world: [u32; 2]) -> Letterbox {
        let [world_w, world_h] = [world[0] as f32, world[1] as f32];
        let scale = (window[0] / world_w).min(window[1] / world_h);
        let scale = if scale > 0.0 && scale.is_finite() { scale } else { 1.0 };
        let [width, height] = [world_w * scale, world_h * scale];
        Letterbox { x: (window[0] - width) / 2.0, y: (window[1] - height) / 2.0, width, height }
    }

    /// A window position as a fraction of the world frame, clamped to it; anything degenerate
    /// (NaN, an empty frame) reads as the centre.
    pub fn fraction(&self, position: [f32; 2]) -> [f32; 2] {
        [fraction(position[0], self.x, self.width), fraction(position[1], self.y, self.height)]
    }
}

fn fraction(value: f32, origin: f32, extent: f32) -> f32 {
    if extent.is_nan() || extent <= 0.0 {
        return 0.5;
    }
    let share = (value - origin) / extent;
    if share.is_nan() { 0.5 } else { share.clamp(0.0, 1.0) }
}
