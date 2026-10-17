//! The window present (renderer pass 2, P2-0.9 step A; findings F1/RC-03): the world target
//! letterboxed into a window's target, filtered by the ratio between the letterbox and the world
//! ([`PresentFilter`]). A letterbox larger than the world is upscaled with the renderer's own FSR1
//! EASU + RCAS (AMD FidelityFX FSR 1.0, MIT, already in [`crate::post::fsr`]), a smaller one is
//! filtered with a Catmull-Rom kernel widened to the ratio (`blit.wgsl`), and only a letterbox of
//! the world's own size is copied texel for texel. Captures read the world target, never a
//! window, so none of this reaches a digest.
//!
//! A HUD painted over the window ([`WindowPresent::present`]'s overlay) is painted after the
//! upscale, at the letterbox's own pixels, onto a letterbox-sized image that the final pass copies
//! into the window: egui's pixels then sit on the window's grid, not on the world's stretched one.

use wgpu::{BindGroup, BindGroupLayout, Buffer, BufferUsages, CommandEncoder, Device, PipelineLayout, RenderPipeline, ShaderModule, Texture, TextureFormat, TextureUsages, TextureView};

use super::{Viewport, letterbox};
use crate::compile::Compiled;
use crate::error::RenderError;
use crate::gpu::Gpu;
use crate::layout::GpuBlitParams;
use crate::overlay::OverlayPainter;
use crate::post::fsr::{FsrNode, FsrPass, FsrPasses, INTERMEDIATE_FORMAT};
use crate::renderer::WORLD_FORMAT;
use crate::settings::RcasQuality;

/// How the present fills the letterbox from the world target.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PresentFilter {
    /// Texel for texel: the letterbox is the world's own size.
    Copy,
    /// FSR1 EASU then RCAS: the letterbox is at least the world's size on both sides.
    Upscale,
    /// Catmull-Rom, its footprint widened to the ratio: the letterbox is smaller on a side.
    Downscale,
}

/// The filter a `view`-sized letterbox of a `world`-sized image takes; None for an empty one.
pub fn present_filter(view: Viewport, world: (u32, u32)) -> Option<PresentFilter> {
    let empty = view.width == 0 || view.height == 0 || world.0 == 0 || world.1 == 0;
    if empty {
        return None;
    }
    if (view.width, view.height) == world {
        return Some(PresentFilter::Copy);
    }
    let larger = view.width >= world.0 && view.height >= world.1;
    Some(if larger { PresentFilter::Upscale } else { PresentFilter::Downscale })
}

/// The letterbox-sized image's usages: RCAS and the overlay draw into it, the final pass reads it,
/// a copy fills it when no filter runs.
const STAGED_USAGE: TextureUsages = TextureUsages::RENDER_ATTACHMENT.union(TextureUsages::TEXTURE_BINDING).union(TextureUsages::COPY_DST);
/// EASU's image's usages.
const EASU_USAGE: TextureUsages = TextureUsages::RENDER_ATTACHMENT.union(TextureUsages::TEXTURE_BINDING);

/// What one blit draws: the fragment entry point for a filter, decoding for an sRGB window.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BlitKind {
    /// `fs_blit`: texel for texel.
    Copy,
    /// `fs_catmull_rom`: filtered down.
    CatmullRom,
}

impl BlitKind {
    fn entry(self, format: TextureFormat) -> &'static str {
        match (self, format.is_srgb()) {
            (BlitKind::Copy, false) => "fs_blit",
            (BlitKind::Copy, true) => "fs_blit_decode",
            (BlitKind::CatmullRom, false) => "fs_catmull_rom",
            (BlitKind::CatmullRom, true) => "fs_catmull_rom_decode",
        }
    }
}

/// Where one blit draws: a target of `format`, the rest of it cleared black.
#[derive(Clone, Copy)]
struct BlitTarget<'a> {
    view: &'a TextureView,
    format: TextureFormat,
    /// The rectangle drawn, in the target's pixels.
    rect: Viewport,
}

/// The letterbox-sized images, kept while the letterbox keeps its size.
struct Images {
    size: (u32, u32),
    /// EASU's output ([`INTERMEDIATE_FORMAT`]), made when an upscale first needs it.
    easu: Option<(Texture, TextureView)>,
    /// What RCAS, a filter or a copy writes and the overlay paints over ([`WORLD_FORMAT`]), made
    /// when the final pass first needs it.
    staged: Option<(Texture, TextureView)>,
}

impl Images {
    fn new(size: (u32, u32)) -> Images {
        Images { size, easu: None, staged: None }
    }
}

fn image(device: &Device, label: &str, size: (u32, u32), format: TextureFormat, usage: TextureUsages) -> (Texture, TextureView) {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage,
        view_formats: &[],
    });
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    (texture, view)
}

/// The device-bound half: modules, layouts, pipelines, uniforms and images.
struct State {
    module: ShaderModule,
    layout: BindGroupLayout,
    pipeline_layout: PipelineLayout,
    blits: Vec<((BlitKind, TextureFormat), Compiled<RenderPipeline>)>,
    /// The first blit's uniform (the world into the letterbox or the staged image) and the final
    /// copy's: separate buffers, as both are written before the one submission that reads them.
    params: [Buffer; 2],
    fsr: FsrNode,
    images: Option<Images>,
    /// The world view the bind groups below read, and the generation FSR1's groups are keyed to.
    world: Option<TextureView>,
    generation: u64,
}

/// Presents a world target into windows (one per renderer device): see the module notes.
#[derive(Default)]
pub struct WindowPresent {
    state: Option<State>,
}

impl std::fmt::Debug for WindowPresent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WindowPresent").field("made", &self.state.is_some()).finish_non_exhaustive()
    }
}

/// One present: what [`WindowPresent::present`] was handed.
pub struct PresentInto<'a> {
    /// The world target and its size.
    pub world: (&'a TextureView, (u32, u32)),
    /// The window's target.
    pub target: &'a TextureView,
    /// The window target's format.
    pub format: TextureFormat,
    /// The window's size in pixels.
    pub window: (u32, u32),
}

impl State {
    fn new(device: &Device) -> Result<State, RenderError> {
        let texture = wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: false },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        };
        let uniform = crate::tables::uniform(1, false, wgpu::ShaderStages::FRAGMENT);
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("window present"), entries: &[texture, uniform] });
        let size = size_of::<GpuBlitParams>() as u64;
        let usage = BufferUsages::UNIFORM | BufferUsages::COPY_DST;
        Ok(State {
            module: crate::shaders::module(device, "window present", crate::shaders::BLIT)?,
            pipeline_layout: crate::tables::pipeline_layout(device, "window present", &[&layout]),
            layout,
            blits: Vec::new(),
            params: [crate::tables::buffer(device, "window present params", size, usage)?, crate::tables::buffer(device, "window present copy params", size, usage)?],
            fsr: FsrNode::new(device)?,
            images: None,
            world: None,
            generation: 0,
        })
    }

    fn blit_pipeline(&mut self, device: &Device, kind: BlitKind, format: TextureFormat) -> Compiled<RenderPipeline> {
        if let Some((_, pipeline)) = self.blits.iter().find(|(key, _)| *key == (kind, format)) {
            return pipeline.clone();
        }
        let pipeline = crate::compile::render_pipeline(device, &wgpu::RenderPipelineDescriptor {
            label: Some("window present"),
            layout: Some(&self.pipeline_layout),
            vertex: wgpu::VertexState { module: &self.module, entry_point: Some("vs_blit"), compilation_options: Default::default(), buffers: &[] },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &self.module,
                entry_point: Some(kind.entry(format)),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState { format, blend: None, write_mask: wgpu::ColorWrites::ALL })],
            }),
            multiview_mask: None,
            cache: None,
        });
        self.blits.push(((kind, format), pipeline.clone()));
        pipeline
    }

    /// The images for a `size` letterbox (a new size drops the old ones).
    fn images(&mut self, size: (u32, u32)) -> &mut Images {
        if self.images.as_ref().is_none_or(|images| images.size != size) {
            self.images = Some(Images::new(size));
            self.generation += 1;
        }
        self.images.as_mut().expect("the images were just made")
    }

    fn easu_view(&mut self, device: &Device, size: (u32, u32)) -> TextureView {
        let images = self.images(size);
        images.easu.get_or_insert_with(|| image(device, "window present easu", size, INTERMEDIATE_FORMAT, EASU_USAGE)).1.clone()
    }

    fn staged(&mut self, device: &Device, size: (u32, u32)) -> (Texture, TextureView) {
        let images = self.images(size);
        images.staged.get_or_insert_with(|| image(device, "window present staged", size, WORLD_FORMAT, STAGED_USAGE)).clone()
    }

    /// Note the world view this present reads: a new one (a rebuilt renderer) re-keys FSR1's groups.
    fn note_world(&mut self, world: &TextureView) {
        if self.world.as_ref() != Some(world) {
            self.world = Some(world.clone());
            self.generation += 1;
        }
    }

    fn group(&self, device: &Device, source: &TextureView, params: usize) -> BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("window present"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(source) },
                wgpu::BindGroupEntry { binding: 1, resource: self.params[params].as_entire_binding() },
            ],
        })
    }

    /// One blit pass of `source` (a view and its size) into `target`, with uniform `params`.
    fn blit(&mut self, gpu: &Gpu, encoder: &mut CommandEncoder, kind: BlitKind, source: (&TextureView, (u32, u32)), target: BlitTarget<'_>, params: usize) {
        let BlitTarget { view: target, format, rect } = target;
        let row = GpuBlitParams {
            viewport: [rect.x as f32, rect.y as f32, rect.width as f32, rect.height as f32],
            world: [source.1.0 as f32, source.1.1 as f32, 0.0, 0.0],
        };
        gpu.queue.write_buffer(&self.params[params], 0, bytemuck::bytes_of(&row));
        let pipeline = self.blit_pipeline(&gpu.device, kind, format);
        let group = self.group(&gpu.device, source.0, params);
        let mut pass = clear_pass(encoder, "window present", target);
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.set_viewport(rect.x as f32, rect.y as f32, rect.width as f32, rect.height as f32, 0.0, 1.0);
        pass.set_scissor_rect(rect.x, rect.y, rect.width, rect.height);
        pass.draw(0..3, 0..1);
    }

    /// FSR1 from the world into `target` (letterbox-sized, `format`): EASU into its own image,
    /// then RCAS at the default sharpness, no dither (the world target carries the frame's).
    fn upscale(&mut self, gpu: &Gpu, encoder: &mut CommandEncoder, world: (&TextureView, (u32, u32)), target: &TextureView, format: TextureFormat, size: (u32, u32)) {
        let easu = self.easu_view(&gpu.device, size);
        let pass = FsrPass {
            passes: FsrPasses { easu: true, rcas: true },
            input: world.0,
            easu: &easu,
            target,
            format,
            render_size: world.1,
            output_size: size,
            rcas: Some(&RcasQuality::DEFAULT),
            dither: false,
            frame_index: 0,
            generation: self.generation,
        };
        self.fsr.encode(&gpu.device, &gpu.queue, encoder, &pass);
    }
}

/// A render pass over `target` that clears it black first.
fn clear_pass<'a>(encoder: &'a mut CommandEncoder, label: &'a str, target: &'a TextureView) -> wgpu::RenderPass<'a> {
    encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some(label),
        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
            view: target,
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
        })],
        ..Default::default()
    })
}

impl WindowPresent {
    /// Present `into.world` into `into.target`'s letterbox, the bars black, and paint `overlay`
    /// over the letterbox after the filter at its own pixels. Answers the overlay's draws (0
    /// without one). A device that cannot make the present's resources presents nothing.
    pub fn present(&mut self, gpu: &Gpu, into: &PresentInto<'_>, overlay: Option<&mut dyn OverlayPainter>) -> u32 {
        if self.state.is_none() {
            match State::new(&gpu.device) {
                Ok(state) => self.state = Some(state),
                Err(error) => {
                    eprintln!("genex-render: no window present: {error}");
                    return 0;
                }
            }
        }
        let Some(state) = self.state.as_mut() else { return 0 };
        state.note_world(into.world.0);
        let view = letterbox(into.window, into.world.1);
        let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("window present") });
        let Some(filter) = present_filter(view, into.world.1) else {
            drop(clear_pass(&mut encoder, "window present", into.target));
            gpu.queue.submit([encoder.finish()]);
            return 0;
        };
        let size = (view.width, view.height);
        let whole = Viewport { x: 0, y: 0, width: view.width, height: view.height };
        let window = BlitTarget { view: into.target, format: into.format, rect: view };
        let direct = overlay.is_none() && size == into.window && !into.format.is_srgb();
        let drawn = match (filter, overlay) {
            // One pass straight into the window: a copy or a filter down, or an upscale whose
            // letterbox is the whole UNORM window (RCAS writes encoded values where it draws).
            (PresentFilter::Copy, None) => {
                state.blit(gpu, &mut encoder, BlitKind::Copy, into.world, window, 0);
                0
            }
            (PresentFilter::Downscale, None) => {
                state.blit(gpu, &mut encoder, BlitKind::CatmullRom, into.world, window, 0);
                0
            }
            (PresentFilter::Upscale, None) if direct => {
                state.upscale(gpu, &mut encoder, into.world, into.target, into.format, size);
                0
            }
            (filter, overlay) => {
                let (staged_texture, staged) = state.staged(&gpu.device, size);
                match filter {
                    PresentFilter::Copy => encoder.copy_texture_to_texture(
                        into.world.0.texture().as_image_copy(),
                        staged_texture.as_image_copy(),
                        wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 },
                    ),
                    PresentFilter::Downscale => state.blit(gpu, &mut encoder, BlitKind::CatmullRom, into.world, BlitTarget { view: &staged, format: WORLD_FORMAT, rect: whole }, 0),
                    PresentFilter::Upscale => state.upscale(gpu, &mut encoder, into.world, &staged, WORLD_FORMAT, size),
                }
                let drawn = overlay.map_or(0, |overlay| overlay.paint(gpu, &mut encoder, &staged, [size.0, size.1]));
                state.blit(gpu, &mut encoder, BlitKind::Copy, (&staged, size), window, 1);
                drawn
            }
        };
        gpu.queue.submit([encoder.finish()]);
        drawn
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view(width: u32, height: u32) -> Viewport {
        Viewport { x: 0, y: 0, width, height }
    }

    #[test]
    fn the_filter_follows_the_letterbox_against_the_world() {
        let world = (960, 540);
        let rows = [
            (view(960, 540), Some(PresentFilter::Copy)),
            (view(1920, 1080), Some(PresentFilter::Upscale)),
            (view(2400, 1350), Some(PresentFilter::Upscale)),
            (view(961, 540), Some(PresentFilter::Upscale)),
            (view(480, 270), Some(PresentFilter::Downscale)),
            (view(959, 540), Some(PresentFilter::Downscale)),
            (view(0, 540), None),
            (view(960, 0), None),
        ];
        for (letterbox, expected) in rows {
            assert_eq!(present_filter(letterbox, world), expected, "{letterbox:?}");
        }
        assert_eq!(present_filter(view(64, 64), (0, 64)), None, "an empty world presents nothing");
    }
}
