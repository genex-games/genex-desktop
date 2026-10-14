//! The letterbox: the world target keeps its aspect inside any window, centred, with black bars.
//! Integer arithmetic, so the same sizes always give the same rectangle on every target.

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
