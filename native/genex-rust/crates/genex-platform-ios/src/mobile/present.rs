//! Presenting inside the safe area. The world image is letterboxed inside the safe rectangle, not
//! the whole window, so no notch, punch hole or home indicator covers the game; outside it the
//! screen is black. One [`Presentation`] answers both where the image is drawn and which world
//! pixel a finger is on, so what is seen and what is touched never disagree.
//!
//! [`SafePresenter`] draws it through genex's presenter (the world upscaled into the letterbox, the
//! HUD painted over it at the screen's pixels), which letterboxes into a whole target, so with
//! insets the shell presents into an offscreen texture of the safe rectangle's size and copies it
//! into the surface at the rectangle's origin, after clearing the surface black. A surface that
//! cannot be a copy destination is presented whole, and its presentation has no insets.

use crate::mobile::safe_area::SafeArea;
use genex_render::letterbox::{Viewport, letterbox};
use genex::present::Presenter;
use genex_render::Gpu;

/// Where the game goes in one window: the safe rectangle and the letterbox inside it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Presentation {
    window: (u32, u32),
    safe: Viewport,
    world: (u32, u32),
}

impl Presentation {
    /// The presentation of a `world` sized image in a `window` with `insets`.
    pub fn new(window: (u32, u32), insets: SafeArea, world: (u32, u32)) -> Presentation {
        let (x, y, width, height) = insets.rect(window);
        Presentation { window, safe: Viewport { x, y, width, height }, world }
    }

    /// The safe rectangle, in window pixels.
    pub fn safe_rect(&self) -> Viewport {
        self.safe
    }

    /// The world size presented.
    pub fn world(&self) -> (u32, u32) {
        self.world
    }

    /// Whether the safe rectangle leaves part of the window out (the offscreen copy is needed).
    pub fn is_inset(&self) -> bool {
        self.safe != Viewport { x: 0, y: 0, width: self.window.0, height: self.window.1 }
    }

    /// Where the world image is drawn, in window pixels: the letterbox inside the safe rectangle.
    pub fn viewport(&self) -> Viewport {
        let inner = letterbox((self.safe.width, self.safe.height), self.world);
        Viewport { x: self.safe.x + inner.x, y: self.safe.y + inner.y, width: inner.width, height: inner.height }
    }

    /// A window point in world pixels, or `None` when it falls on a bar or outside the safe area.
    pub fn to_world(&self, point: (f32, f32)) -> Option<(f32, f32)> {
        let view = self.viewport();
        let (x, y) = (point.0 - view.x as f32, point.1 - view.y as f32);
        let inside = x >= 0.0 && y >= 0.0 && x < view.width as f32 && y < view.height as f32;
        inside.then(|| self.scale(view, (x, y)))
    }

    /// A window point in world pixels, held to the world's edges (a finger dragged onto a bar).
    pub fn to_world_clamped(&self, point: (f32, f32)) -> (f32, f32) {
        let view = self.viewport();
        let x = (point.0 - view.x as f32).clamp(0.0, view.width as f32);
        let y = (point.1 - view.y as f32).clamp(0.0, view.height as f32);
        self.scale(view, (x, y))
    }

    fn scale(&self, view: Viewport, (x, y): (f32, f32)) -> (f32, f32) {
        if view.width == 0 || view.height == 0 {
            return (0.0, 0.0);
        }
        (x * self.world.0 as f32 / view.width as f32, y * self.world.1 as f32 / view.height as f32)
    }
}

/// The offscreen safe-rectangle target, kept while its size and format last.
struct SafeTarget {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    size: (u32, u32),
    format: wgpu::TextureFormat,
}

/// Presents the world target into a surface texture as a [`Presentation`] says.
#[derive(Default)]
pub struct SafePresenter {
    target: Option<SafeTarget>,
}

impl SafePresenter {
    /// Present the world target and the HUD into `surface` (its texture, created with `COPY_DST`
    /// whenever `presentation` is inset).
    pub fn present(&mut self, presenter: &mut Presenter, surface: &wgpu::Texture, format: wgpu::TextureFormat, presentation: &Presentation) {
        let surface_view = surface.create_view(&wgpu::TextureViewDescriptor::default());
        let safe = presentation.safe_rect();
        if !presentation.is_inset() || safe.width == 0 || safe.height == 0 {
            presenter.present(&surface_view, format, (surface.width(), surface.height()));
            return;
        }
        let target = self.target_for(presenter.gpu(), (safe.width, safe.height), format);
        presenter.present(&target.view, format, target.size);
        let gpu = presenter.gpu();
        let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("safe-area") });
        clear_black(&mut encoder, &surface_view);
        encoder.copy_texture_to_texture(
            target.texture.as_image_copy(),
            wgpu::TexelCopyTextureInfo {
                texture: surface,
                mip_level: 0,
                origin: wgpu::Origin3d { x: safe.x, y: safe.y, z: 0 },
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::Extent3d { width: safe.width, height: safe.height, depth_or_array_layers: 1 },
        );
        gpu.queue.submit([encoder.finish()]);
    }

    fn target_for(&mut self, gpu: &Gpu, size: (u32, u32), format: wgpu::TextureFormat) -> &SafeTarget {
        let current = self.target.as_ref().is_some_and(|target| target.size == size && target.format == format);
        if !current {
            let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
                label: Some("safe-area target"),
                size: wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
                view_formats: &[],
            });
            let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
            self.target = Some(SafeTarget { texture, view, size, format });
        }
        self.target.as_ref().expect("the safe-area target was just made")
    }
}

/// A pass that only clears `view` black.
fn clear_black(encoder: &mut wgpu::CommandEncoder, view: &wgpu::TextureView) {
    encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("safe-area clear"),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view,
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
        })],
        depth_stencil_attachment: None,
        timestamp_writes: None,
        occlusion_query_set: None,
        multiview_mask: None,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const WORLD: (u32, u32) = (960, 540);
    /// iPhone 15 landscape: 2556x1179 with the notch and home indicator insets.
    const IPHONE: (u32, u32) = (2556, 1179);
    const IPHONE_INSETS: SafeArea = SafeArea { top: 0, left: 177, bottom: 63, right: 177 };

    #[test]
    fn the_world_is_letterboxed_inside_the_safe_rectangle_not_the_window() {
        let presentation = Presentation::new(IPHONE, IPHONE_INSETS, WORLD);
        assert!(presentation.is_inset());
        assert_eq!(presentation.safe_rect(), Viewport { x: 177, y: 0, width: 2202, height: 1116 });
        // 960x540 in 2202x1116 is height-limited: 1984x1116, centred 109 px in from the safe edge.
        assert_eq!(presentation.viewport(), Viewport { x: 286, y: 0, width: 1984, height: 1116 });
        let portrait = Presentation::new((1179, 2556), SafeArea { bottom: 102, ..SafeArea::default() }, WORLD);
        assert!(portrait.is_inset(), "a home indicator alone still insets the image");
        let whole = Presentation::new(IPHONE, SafeArea::default(), WORLD);
        assert!(!whole.is_inset());
        assert_eq!(whole.viewport(), letterbox(IPHONE, WORLD));
    }

    #[test]
    fn a_finger_maps_through_the_same_viewport_the_image_is_drawn_in() {
        let presentation = Presentation::new(IPHONE, IPHONE_INSETS, WORLD);
        assert_eq!(presentation.to_world((286.0 + 992.0, 558.0)), Some((480.0, 270.0)));
        // Under the notch, and on the home indicator band: no world pixel.
        assert_eq!(presentation.to_world((100.0, 500.0)), None);
        assert_eq!(presentation.to_world((1278.0, 1150.0)), None);
        // Dragged onto the notch, a finger holds the world's left edge.
        assert_eq!(presentation.to_world_clamped((100.0, 558.0)), (0.0, 270.0));
        assert_eq!(presentation.to_world_clamped((5000.0, 5000.0)), (960.0, 540.0));
    }

    #[test]
    fn an_empty_window_maps_nothing_and_never_divides_by_zero() {
        let presentation = Presentation::new((0, 0), IPHONE_INSETS, WORLD);
        assert_eq!(presentation.viewport(), Viewport { x: 0, y: 0, width: 0, height: 0 });
        assert_eq!(presentation.to_world((0.0, 0.0)), None);
        assert_eq!(presentation.to_world_clamped((10.0, 10.0)), (0.0, 0.0));
    }
}
