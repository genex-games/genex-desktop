//! The HUD overlay stage: the last thing drawn into the world target before a capture reads it or
//! `present` letterboxes it, after the 2D primitives and the post passes. The painter is egui's
//! (genex-hud's `HudPainter`, which owns the font atlas and the egui-wgpu renderer); the renderer
//! only owns the stage, so the same frame reaches a capture, Live's ring and a window alike.
//!
//! Each primitive the painter draws counts as one `hud`-tagged logical draw
//! ([`crate::immediate::HUD_TAG`]); in-world text in V1 is egui labels projected from world
//! positions ([`crate::world_text`]), painted here too. A glyph-atlas world-text pass is a later
//! tier.
//!
//! The facade's studio presenter wraps `genex_hud::HudPainter::draw` (with the frame's
//! `HudPaint`) as an [`OverlayPainter`]; genex-render does not depend on egui.

use wgpu::{CommandEncoder, TextureView};

use crate::gpu::Gpu;

/// Paints the HUD over the world target.
pub trait OverlayPainter {
    /// Record the HUD over `target` (load it, never clear it) of `size` pixels in `encoder`;
    /// answers how many primitives it drew (the frame's `hud`-tagged draws).
    fn paint(&mut self, gpu: &Gpu, encoder: &mut CommandEncoder, target: &TextureView, size: [u32; 2]) -> u32;
}

/// Run `painter` over `target` in `encoder`; answers its primitive count.
pub fn paint_overlay(painter: &mut dyn OverlayPainter, gpu: &Gpu, encoder: &mut CommandEncoder, target: &TextureView, size: [u32; 2]) -> u32 {
    painter.paint(gpu, encoder, target, size)
}
