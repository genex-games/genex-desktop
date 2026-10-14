//! HiDPI and pacing (plan "HiDPI and pacing"). The world target is drawn at the logical world size
//! × min(dpr, 2) ([`render_scale`], [`physical_world_size`]) and captures are taken at the logical
//! world size ([`capture_logical`]), so a capture's digest does not depend on the display. egui's
//! `pixels_per_point` is the dpr (genex-hud's `pixels_per_point`). Surfaces present `Fifo`
//! ([`present_mode`]); the simulation steps at a fixed 60 Hz on genex-core's [`FrameClock`], and
//! a display faster than that repeats the last frame ([`FramePacer`]).
//!
//! # Frame pacing (RQ0.12)
//!
//! The frame graph runs at the sim rate, never at the display's: [`FrameGate`] renders a display
//! frame only when it carries a sim tick (or is the first, or was made stale by something other
//! than the sim: a studio verb, a resize, a new surface), and every other frame is a repeat that
//! re-presents the last world target (a blit, or nothing at all where the platform keeps the last
//! picture, as a WebGPU canvas does). A 120 or 144 Hz display therefore runs the graph once per
//! tick, as a 60 Hz one does.
//!
//! Temporal state is keyed to ticks, never to refreshes: the gate's index ([`FrameGate::frame_index`],
//! rendered sim ticks since the last history reset) advances by the ticks a rendered frame ran, and
//! an adaptation that moves a fixed share per tick (auto exposure, TAA and AO history weights) moves
//! [`tick_blend`]`(rate, ticks)` on a rendered frame, so it lands on the same value at 30, 60, 120 or
//! 144 Hz. Phones ask the display for [`MOBILE_PREFERRED_HZ`].

use genex_core::clock::FrameClock;
use wgpu::PresentMode;

use crate::caps::MAX_WORLD_PX;
use crate::limits::RENDER_SCALE_MAX;

/// The factor the world target is drawn at for a display of `dpr`: min(dpr, 2), never below 1
/// (captures are logical, so drawing smaller would only lose detail); a NaN, infinite or
/// non-positive report reads as 1.
pub fn render_scale(dpr: f64) -> f32 {
    if !dpr.is_finite() || dpr <= 1.0 {
        return 1.0;
    }
    (dpr as f32).min(RENDER_SCALE_MAX)
}

/// The world target's size in device pixels for a `logical` world on a display of `dpr`, each
/// side at most [`MAX_WORLD_PX`].
pub fn physical_world_size(logical: (u32, u32), dpr: f64) -> (u32, u32) {
    let scale = render_scale(dpr);
    let side = |n: u32| ((n as f32 * scale).round() as u32).clamp(1, MAX_WORLD_PX);
    (side(logical.0), side(logical.1))
}

/// The present mode a surface is configured with: `Fifo` (vsync, guaranteed by WebGPU), or
/// `AutoVsync` if a surface does not list it.
pub fn present_mode(supported: &[PresentMode]) -> PresentMode {
    if supported.contains(&PresentMode::Fifo) { PresentMode::Fifo } else { PresentMode::AutoVsync }
}

/// What one displayed frame does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PacedFrame {
    /// Simulation ticks to run before drawing.
    pub ticks: u32,
    /// No tick ran: the frame shows the last simulated state again.
    pub repeat: bool,
}

/// Turns display frames into fixed 60 Hz simulation ticks.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct FramePacer {
    clock: FrameClock,
}

impl FramePacer {
    /// A display frame of `frame_ms` (the wall time since the last one, measured by the shell).
    pub fn display_frame(&mut self, frame_ms: f64) -> PacedFrame {
        let ticks = self.clock.advance(frame_ms);
        PacedFrame { ticks, repeat: ticks == 0 }
    }

    /// Forget the carried remainder (a seed, a start or a resume).
    pub fn reset(&mut self) {
        self.clock.reset();
    }
}

/// The display rate the phone shells ask for (iOS's display-link frame-rate range, Android's
/// `ANativeWindow_setFrameRate`): the sim's tick rate, so a 90 or 120 Hz panel does not refresh
/// twice per tick on a battery.
pub const MOBILE_PREFERRED_HZ: f32 = 60.0;

/// The share of the remaining distance an adaptation that moves `rate_per_tick` of it each tick
/// covers over `ticks` ticks: `1 - (1 - rate)^ticks`, so applying it once on a frame that ran
/// `ticks` ticks lands where `ticks` per-tick steps would. 0 for no tick (a repeat frame moves
/// nothing) and for a rate that is not a finite positive number; 1 for a finite rate of 1 or more. The power is
/// IEEE multiplications only (square and multiply), so it is the same on every destination.
pub fn tick_blend(rate_per_tick: f32, ticks: u32) -> f32 {
    if ticks == 0 || !rate_per_tick.is_finite() || rate_per_tick <= 0.0 {
        return 0.0;
    }
    if rate_per_tick >= 1.0 {
        return 1.0;
    }
    // One tick moves exactly the rate (no round trip through 1 - rate).
    if ticks == 1 {
        return rate_per_tick;
    }
    let mut keep = 1.0_f32;
    let mut base = 1.0 - rate_per_tick;
    let mut exponent = ticks;
    while exponent > 0 && keep > 0.0 {
        if exponent & 1 == 1 {
            keep *= base;
        }
        base *= base;
        exponent >>= 1;
    }
    1.0 - keep
}

/// What a shell does with one display frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrameAction {
    /// Run the frame graph into the world target, then present it.
    Render,
    /// Encode no graph node: show the last world target again (re-present it, or leave the
    /// platform's last picture where it keeps one).
    Repeat,
}

/// Display frames that ran the graph and frames that repeated the last one
/// (`state().volatile.render.frames`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FrameTally {
    /// Frames that ran the frame graph.
    pub rendered: u64,
    /// Frames that showed the last world target again.
    pub repeated: u64,
}

/// Decides each display frame (module docs): render only for a frame that carries a sim tick, the
/// first frame, or a stale one; count both kinds; keep the frame index.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FrameGate {
    drawn: bool,
    stale: bool,
    tally: FrameTally,
    frame_index: u64,
}

impl FrameGate {
    /// The display frame that ran `ticks` sim ticks: [`FrameAction::Render`] advances the frame
    /// index by `ticks` (a stale or first frame re-renders the current tick and keeps it).
    pub fn frame(&mut self, ticks: u32) -> FrameAction {
        if ticks == 0 && self.drawn && !self.stale {
            self.tally.repeated += 1;
            return FrameAction::Repeat;
        }
        self.drawn = true;
        self.stale = false;
        self.tally.rendered += 1;
        self.frame_index = self.frame_index.saturating_add(u64::from(ticks));
        FrameAction::Render
    }

    /// The next frame renders even without a tick: something other than the sim changed what it
    /// shows (a studio verb, a resize, input the HUD reads).
    pub fn mark_stale(&mut self) {
        self.stale = true;
    }

    /// Temporal history starts over (a camera cut, a new device or surface, a seed): the frame
    /// index returns to 0 and the next frame renders.
    pub fn reset_history(&mut self) {
        self.frame_index = 0;
        self.drawn = false;
    }

    /// Rendered sim ticks since the last history reset (`volatile.render.frames`). Temporal
    /// sequences (TAA jitter, AO and shadow noise) key to the renderer's history index instead,
    /// which counts drawn frames ([`crate::settle::LiveHistory`]).
    pub fn frame_index(&self) -> u64 {
        self.frame_index
    }

    /// Frames rendered and repeated so far.
    pub fn tally(&self) -> FrameTally {
        self.tally
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub use native::capture_logical;

#[cfg(not(target_arch = "wasm32"))]
mod native {
    use wgpu::{BufferUsages, TextureUsages};

    use crate::caps::check_texture;
    use crate::capture::{Capture, check_capture_size};
    use crate::error::RenderError;
    use crate::gpu::Gpu;
    use crate::readback::map_read_blocking;
    use crate::renderer::{Renderer, WORLD_FORMAT, shader};
    use crate::tables::{buffer, entry, pipeline_layout, uniform};

    /// `DownsampleParams`: physical texels per logical pixel, and the physical size.
    #[repr(C)]
    #[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
    struct GpuDownsample {
        scale: [f32; 4],
    }

    /// Read `renderer`'s world target back at the `logical` world size: each logical pixel the
    /// area-weighted mean of the physical texels it covers (exact for flat colour). A world target
    /// already at the logical size is read as it is.
    pub fn capture_logical(renderer: &Renderer, gpu: &Gpu, logical: (u32, u32)) -> Result<Capture, RenderError> {
        let (width, height) = logical;
        if renderer.size() == logical {
            return renderer.capture(gpu);
        }
        check_capture_size(width, height)?;
        check_texture(width, height, 4)?;
        let device = &gpu.device;
        let (physical_w, physical_h) = renderer.size();
        let target = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("logical capture"),
            size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: WORLD_FORMAT,
            usage: TextureUsages::RENDER_ATTACHMENT | TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let view = target.create_view(&Default::default());
        let params = GpuDownsample {
            scale: [physical_w as f32 / width as f32, physical_h as f32 / height as f32, physical_w as f32, physical_h as f32],
        };
        let params_buffer = buffer(device, "downsample", size_of::<GpuDownsample>() as u64, BufferUsages::UNIFORM | BufferUsages::COPY_DST)?;
        gpu.queue.write_buffer(&params_buffer, 0, bytemuck::bytes_of(&params));
        let texture = wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: false }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false },
            count: None,
        };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("downsample"),
            entries: &[texture, uniform(1, false, wgpu::ShaderStages::FRAGMENT)],
        });
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("downsample"),
            layout: &layout,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(renderer.world_view()) }, entry(1, &params_buffer)],
        });
        let module = shader(device, "downsample", crate::shaders::DOWNSAMPLE)?;
        let targets = [Some(wgpu::ColorTargetState { format: WORLD_FORMAT, blend: None, write_mask: wgpu::ColorWrites::ALL })];
        let pipeline = crate::compile::render_pipeline(device, &wgpu::RenderPipelineDescriptor {
            label: Some("downsample"),
            layout: Some(&pipeline_layout(device, "downsample", &[&layout])),
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_downsample"), compilation_options: Default::default(), buffers: &[] },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs_downsample"), compilation_options: Default::default(), targets: &targets }),
            multiview_mask: None,
            cache: None,
        });
        let padded = (width * 4).div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let staging = buffer(device, "logical capture", u64::from(padded) * u64::from(height), BufferUsages::MAP_READ | BufferUsages::COPY_DST)?;
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("logical capture") });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("downsample"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
                })],
                ..Default::default()
            });
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.draw(0..3, 0..1);
        }
        encoder.copy_texture_to_buffer(
            target.as_image_copy(),
            wgpu::TexelCopyBufferInfo { buffer: &staging, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(padded), rows_per_image: Some(height) } },
            wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        );
        gpu.queue.submit([encoder.finish()]);
        let data = map_read_blocking(gpu, &staging, u64::from(padded) * u64::from(height))?;
        Capture::from_padded_rows(width, height, padded, &data)
    }
}
