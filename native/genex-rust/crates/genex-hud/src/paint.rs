//! Painting a [`HudPaint`] with egui-wgpu over a target the runtime owns: the world target a
//! capture reads, or the frame a window presents. The same code runs on every backend, the
//! browser's WebGPU included.

use crate::hud::HudPaint;

/// The smallest and largest pixels per point a display may ask for; a ratio outside them is a
/// broken report, not a screen.
const MIN_PIXELS_PER_POINT: f32 = 0.25;
const MAX_PIXELS_PER_POINT: f32 = 8.0;
/// What a display that reports nothing usable gets: one device pixel per world pixel.
const FALLBACK_PIXELS_PER_POINT: f32 = 1.0;

/// egui's pixels per point for a display with device pixel ratio `dpr` (plan "HiDPI and pacing":
/// `pixels_per_point = dpr`), bounded; a non-finite or non-positive ratio reads as 1. Captures
/// paint at 1: they are taken at the logical world size.
pub fn pixels_per_point(dpr: f64) -> f32 {
    let usable = dpr.is_finite() && dpr > 0.0;
    if !usable {
        return FALLBACK_PIXELS_PER_POINT;
    }
    (dpr as f32).clamp(MIN_PIXELS_PER_POINT, MAX_PIXELS_PER_POINT)
}

/// Draws the HUD with egui-wgpu. One painter per [`crate::Hud`]: it keeps the textures (the font
/// atlas first) that the HUD's paints upload as deltas, so a second painter would miss them.
pub struct HudPainter {
    renderer: egui_wgpu::Renderer,
}

impl HudPainter {
    /// A painter for targets of `format`. Output is predictable (no dithering, filtering done in
    /// the shader) so a capture digest does not depend on the GPU's sampler.
    pub fn new(device: &wgpu::Device, format: wgpu::TextureFormat) -> HudPainter {
        HudPainter { renderer: egui_wgpu::Renderer::new(device, format, egui_wgpu::RendererOptions::PREDICTABLE) }
    }

    /// Upload `paint`'s texture changes and record its primitives over `target` (loaded, never
    /// cleared) in `encoder`, for a target of `size_in_pixels`. Answers how many primitives were
    /// drawn: the frame counts them as `hud`-tagged draws. One draw per submit: egui-wgpu keeps
    /// one screen-size uniform, so a second target needs the first encoder submitted.
    pub fn draw(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        encoder: &mut wgpu::CommandEncoder,
        target: &wgpu::TextureView,
        size_in_pixels: [u32; 2],
        paint: &mut HudPaint,
    ) -> usize {
        let mut delta = std::mem::take(&mut paint.textures_delta);
        // Each texture's deltas apply in order; textures are independent of one another.
        #[expect(clippy::iter_over_hash_type)]
        for (id, images) in &delta.set {
            for image in images {
                self.renderer.update_texture(device, queue, *id, image);
            }
        }
        let screen = egui_wgpu::ScreenDescriptor { size_in_pixels, pixels_per_point: paint.pixels_per_point };
        let callbacks = self.renderer.update_buffers(device, queue, encoder, &paint.primitives, &screen);
        if !callbacks.is_empty() {
            // Paint callbacks' own uploads go ahead of the HUD's draw.
            queue.submit(callbacks);
        }
        let mut pass = encoder
            .begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("genex-hud"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: target,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
                })],
                ..wgpu::RenderPassDescriptor::default()
            })
            .forget_lifetime();
        self.renderer.render(&mut pass, &paint.primitives, &screen);
        drop(pass);
        for id in &delta.free {
            self.renderer.free_texture(id);
        }
        // Applied: epaint asserts a delta is handled before it drops.
        delta.clear();
        paint.primitives.len()
    }
}

impl std::fmt::Debug for HudPainter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HudPainter").finish_non_exhaustive()
    }
}
