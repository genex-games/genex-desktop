//! In-world text in V1: labels anchored at world positions, projected through the camera into
//! world-target pixels and painted by the HUD (egui) in the overlay stage, so they count as
//! `hud`-tagged draws and read the same in a capture and in Live. Labels behind the camera or
//! outside the view are dropped; the rest come far to near, so nearer labels paint over farther
//! ones, at most [`WORLD_LABELS_MAX`] (the nearest kept). A glyph-atlas world-text pass that
//! depth-tests against the world is a later renderer tier.

use glam::{Mat4, Vec4};

use crate::limits::WORLD_LABELS_MAX;

/// The text size a label gets unless it names one, in points.
pub const LABEL_DEFAULT_SIZE: f32 = 14.0;

/// A label anchored at a world position.
#[derive(Clone, Debug, PartialEq)]
pub struct WorldLabel {
    /// The anchor.
    pub position: [f32; 3],
    /// The text.
    pub text: String,
    /// sRGB colour and alpha.
    pub color: [u8; 4],
    /// Text size in points.
    pub size: f32,
}

impl WorldLabel {
    /// A label of the default size.
    pub fn new(position: [f32; 3], text: impl Into<String>, color: [u8; 4]) -> WorldLabel {
        WorldLabel { position, text: text.into(), color, size: LABEL_DEFAULT_SIZE }
    }
}

/// A label placed in world-target pixels.
#[derive(Clone, Debug, PartialEq)]
pub struct ScreenLabel {
    /// Pixels from the left of the world target.
    pub x: f32,
    /// Pixels from the top.
    pub y: f32,
    /// Depth, 0 at the near plane and 1 at the far one.
    pub depth: f32,
    /// The text.
    pub text: String,
    /// sRGB colour and alpha.
    pub color: [u8; 4],
    /// Text size in points.
    pub size: f32,
}

/// Where `position` lands in a `world_size` target under `view_proj`: `None` behind the camera or
/// outside the view.
pub fn project(view_proj: &Mat4, position: [f32; 3], world_size: (u32, u32)) -> Option<(f32, f32, f32)> {
    let clip = *view_proj * Vec4::new(position[0], position[1], position[2], 1.0);
    if clip.w <= 0.0 {
        return None;
    }
    let ndc = clip.truncate() / clip.w;
    let inside = ndc.x.abs() <= 1.0 && ndc.y.abs() <= 1.0 && (0.0..=1.0).contains(&ndc.z);
    if !inside {
        return None;
    }
    let x = (ndc.x + 1.0) * 0.5 * world_size.0 as f32;
    let y = (1.0 - ndc.y) * 0.5 * world_size.1 as f32;
    Some((x, y, ndc.z))
}

/// Project `labels` (see the module docs). `view_proj` is the 3D camera's, column-major.
pub fn project_labels(labels: &[WorldLabel], view_proj: [f32; 16], world_size: (u32, u32)) -> Vec<ScreenLabel> {
    let matrix = Mat4::from_cols_array(&view_proj);
    let mut placed: Vec<ScreenLabel> = labels
        .iter()
        .filter_map(|label| {
            let (x, y, depth) = project(&matrix, label.position, world_size)?;
            Some(ScreenLabel { x, y, depth, text: label.text.clone(), color: label.color, size: label.size })
        })
        .collect();
    // Far to near for painting; the sort is stable, so equal depths keep the game's order. The
    // farthest beyond the cap are dropped.
    placed.sort_by(|a, b| b.depth.total_cmp(&a.depth));
    let excess = placed.len().saturating_sub(WORLD_LABELS_MAX);
    placed.drain(..excess);
    placed
}
