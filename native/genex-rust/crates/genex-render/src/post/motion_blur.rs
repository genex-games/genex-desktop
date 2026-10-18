//! Motion blur (renderer pass 2, A.9 / prior-art A7.3): the HDR scene blurred along each pixel's
//! motion over the shutter's share of the frame, after TAA (graph node 17) and depth of field and
//! before `post-hdr` (node 18), so its samples are never fed back into TAA's history and bloom and
//! the exposure see the blurred scene (Unreal's and Unity's order: TAA, depth of field, motion
//! blur, bloom).
//!
//! A look switch, off by default ([`MotionBlur`], `Look::motion_blur`): the shutter as a fraction
//! of the frame (0.5 is film's 180 degrees). It reads the prepass's motion (NDC current − previous,
//! the camera's own motion where nothing was drawn: [`crate::motion`]) and the depth, so it runs
//! only on frames that wrote motion. Two tiers ([`MotionBlurTier`], `Quality::motion_blur`):
//!
//! - [`MotionBlurTier::Reconstruction`] (desktop and web `high` and `ultra`): a port of
//!   keijiro/KinoMotion's reconstruction filter (MIT; McGuire, Hennessy, Bukowski and Osman, "A
//!   Reconstruction Filter for Plausible Motion Blur", I3D 2012, the oracle G3D implements). The
//!   longest velocity of each tile (a tile spans the largest blur radius, [`tile_px`]) and of its
//!   3x3 neighbourhood; a gather along that velocity and the pixel's own whose samples are split
//!   into foreground and background by depth, so a moving object smears over a still background
//!   and a still object in front of a moving background stays sharp. Three passes: a compute
//!   reduction of 16x16 blocks in workgroup memory that also packs each pixel's velocity and
//!   distance into one word ([`PACKED_FORMAT`]), the tiles' neighbourhood, the gather.
//! - [`MotionBlurTier::Direct`] (`low`, `medium` and phones above `low`): Bevy 0.20.0's single
//!   pass (`motion_blur.wesl`, MIT OR Apache-2.0): samples along the pixel's own velocity, a
//!   nearer sample kept only when its own motion could have reached the pixel. It does not spread
//!   a moving object past its silhouette. One pass.
//! - [`MotionBlurTier::Off`]: phones of the `low` tier (the plan's "off on mobile-low").
//!
//! Both tiers read whole texels at sample offsets fixed relative to the pixel, with no per-pixel
//! noise on them and nothing keyed to the frame (KinoMotion and Bevy jitter each pixel's samples):
//! a fixed filter moves with the content, so a steady pan draws a steady blur, and a sample's
//! colour is the texel whose depth and velocity weighed it. A still camera draws the scene
//! unchanged (a tile whose longest velocity is under [`RECONSTRUCTION_MIN_PX`], a pixel moving
//! under [`DIRECT_MIN_PX`], passes through bit for bit). Velocities are clamped to the largest radius
//! ([`MAX_BLUR_HEIGHT_SHARE`] of the render height). The node adds no binding to the forward stage.
//! A settled capture draws without it unless its shot asks ([`frame_settings`]).

use glam::Mat4;
use wgpu::{BindGroup, Buffer, BufferUsages, ComputePipeline, Device, Queue, RenderPipeline, Texture, TextureFormat, TextureUsages, TextureView};

use crate::compile::Compiled;
use crate::error::RenderError;
use crate::settings::Quality;
use crate::tables::buffer;
use crate::target_pool::TargetDesc;

/// Whether the node can run (its rows and modules have landed).
pub const LANDED: bool = true;

/// The largest blur radius (half an exposure vector), as a share of the render height
/// (KinoMotion's default of 3.5%: 38 px at 1080p).
pub const MAX_BLUR_HEIGHT_SHARE: f32 = 0.035;
/// Tiles are whole multiples of this many render pixels: the side of a block, the compute
/// reduction's workgroup.
pub const TILE_UNIT_PX: u32 = 16;
/// The reconstruction's sample pairs at most, a pixel apart up to this many pixels of blur each way
/// (KinoMotion's medium quality: 20 samples, two pixels apart). Eight keeps a fast camera turn at
/// 1080p within the 0.5 ms budget on an M4 Max (ten took 0.53-0.59 ms on a loaded host).
pub const RECONSTRUCTION_PAIRS: f32 = 8.0;
/// The tile velocity (render pixels) below which the reconstruction passes the scene through
/// (KinoMotion's early exit).
pub const RECONSTRUCTION_MIN_PX: f32 = 2.0;
/// The direct tier's samples on each side of the pixel at most, a pixel apart up to this many
/// pixels of blur each way.
pub const DIRECT_SAMPLES: f32 = 6.0;
/// The velocity (render pixels) below which the direct tier passes a pixel through (Bevy's
/// "moved less than a pixel").
pub const DIRECT_MIN_PX: f32 = 1.0;

/// The 16x16 blocks' format (xy a velocity in render pixels; a core storage format).
pub const BLOCKS_FORMAT: TextureFormat = TextureFormat::Rgba16Float;
/// Each pixel's speed (20 bits) and log view distance (12 bits), one word: the reconstruction
/// reads one texel a sample for both (a core storage format); a sample needs no direction.
pub const PACKED_FORMAT: TextureFormat = TextureFormat::R32Uint;
/// The neighbourhood maximum's format (a velocity in render pixels).
pub const TILES_FORMAT: TextureFormat = TextureFormat::Rg16Float;
/// The packed speed and distance's pool label.
pub const PACKED_LABEL: &str = "motion blur packed";
/// The 16x16 blocks' pool label.
pub const BLOCKS_LABEL: &str = "motion blur blocks";
/// The neighbourhood maximum's pool label.
pub const NEIGHBOUR_LABEL: &str = "motion blur neighbour";
/// The node's own output when the caller has no free render-size target.
pub const OUTPUT_LABEL: &str = "motion blur output";
/// Every pool label the node may hold (released when it does not run).
pub const LABELS: [&str; 4] = [PACKED_LABEL, BLOCKS_LABEL, NEIGHBOUR_LABEL, OUTPUT_LABEL];
const USAGE: TextureUsages = TextureUsages::RENDER_ATTACHMENT.union(TextureUsages::TEXTURE_BINDING);

/// The look's motion blur: the shutter open for `shutter` of each frame (off by default).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MotionBlur {
    /// Whether the frame blurs by motion at all.
    pub enabled: bool,
    /// The share of the frame the shutter is open, `0..=1` (0.5, film's 180-degree shutter, is the
    /// default; 0 blurs nothing).
    pub shutter: f32,
}

/// The default shutter (180 degrees).
pub const DEFAULT_SHUTTER: f32 = 0.5;
/// The longest shutter: the whole frame (a longer one would blur farther than anything moved).
pub const SHUTTER_MAX: f32 = 1.0;

impl MotionBlur {
    /// No motion blur (the default look).
    pub const OFF: MotionBlur = MotionBlur { enabled: false, shutter: DEFAULT_SHUTTER };

    /// Motion blur with the shutter open for `shutter` of each frame.
    pub const fn shutter(shutter: f32) -> MotionBlur {
        MotionBlur { enabled: true, shutter }
    }

    /// Each knob held to its range (a value that is not a number takes the default).
    pub fn held(self) -> MotionBlur {
        let shutter = if self.shutter.is_nan() { DEFAULT_SHUTTER } else { self.shutter.clamp(0.0, SHUTTER_MAX) };
        MotionBlur { enabled: self.enabled, shutter }
    }
}

impl Default for MotionBlur {
    fn default() -> Self {
        MotionBlur::OFF
    }
}

/// The blur a preset draws with (`Quality::motion_blur`).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum MotionBlurTier {
    /// No motion blur, whatever the look asks (phones of the low tier).
    Off,
    /// Bevy's single pass along the pixel's own velocity (low, medium and phones).
    Direct,
    /// KinoMotion's tiled reconstruction filter (desktop and web high and ultra).
    Reconstruction,
}

impl MotionBlurTier {
    /// The render passes the node records.
    pub const fn passes(self) -> u32 {
        match self {
            MotionBlurTier::Off => 0,
            MotionBlurTier::Direct => 1,
            // blocks (compute), neighbourhood, reconstruction
            MotionBlurTier::Reconstruction => 3,
        }
    }

    /// The tier's spelling.
    pub const fn as_str(self) -> &'static str {
        match self {
            MotionBlurTier::Off => "off",
            MotionBlurTier::Direct => "direct",
            MotionBlurTier::Reconstruction => "reconstruction",
        }
    }
}

/// What kind of frame asks for motion blur.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MotionBlurFrame {
    /// A Live frame: the look decides.
    Live,
    /// A settled capture: drawn without motion blur unless the shot asks (`shot_asks`).
    Settled {
        /// Whether the shot asked for the look's motion blur.
        shot_asks: bool,
    },
}

/// What the node draws a frame with.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MotionBlurFrameSettings {
    /// The look's motion blur, held to its ranges.
    pub settings: MotionBlur,
    /// The tier (never [`MotionBlurTier::Off`]).
    pub tier: MotionBlurTier,
}

/// Whether motion blur runs on a frame of the HDR scene (`hdr`) drawn with `quality` whose
/// prepass wrote motion (`motion`), and how. None: the look's switch is off, the shutter is shut,
/// the preset's tier is off, the scene is the legacy LDR one, the frame has no motion, or a settled
/// capture whose shot did not ask for it.
pub fn frame_settings(look: &MotionBlur, quality: &Quality, hdr: bool, motion: bool, frame: MotionBlurFrame) -> Option<MotionBlurFrameSettings> {
    let settings = look.held();
    let asked = match frame {
        MotionBlurFrame::Live => true,
        MotionBlurFrame::Settled { shot_asks } => shot_asks,
    };
    let tier = quality.motion_blur;
    let drawn = settings.enabled && settings.shutter > 0.0 && tier != MotionBlurTier::Off;
    (LANDED && drawn && hdr && motion && asked).then_some(MotionBlurFrameSettings { settings, tier })
}

/// The largest blur radius (half an exposure vector) at a render `height`, render pixels.
pub fn max_radius_px(height: u32) -> f32 {
    (MAX_BLUR_HEIGHT_SHARE * height.max(1) as f32).max(1.0)
}

/// The tile side at a render `height`: the largest radius rounded up to whole [`TILE_UNIT_PX`], so
/// a tile's 3x3 neighbourhood reaches every pixel a velocity can blur.
pub fn tile_px(height: u32) -> u32 {
    (max_radius_px(height).ceil() as u32).div_ceil(TILE_UNIT_PX).max(1) * TILE_UNIT_PX
}

/// Every pooled target of `tier` at `render` size; `output` adds the node's own output in
/// `output_format`.
pub fn targets(render: (u32, u32), tier: MotionBlurTier, output: Option<TextureFormat>) -> Vec<TargetDesc> {
    let (w, h) = (render.0.max(1), render.1.max(1));
    let tile = tile_px(h);
    let target = |label, format, size| TargetDesc { label, format, usage: USAGE, samples: 1, size, mips: 1, srgb_view: false };
    let mut all = Vec::new();
    if tier == MotionBlurTier::Reconstruction {
        let blocks = (w.div_ceil(TILE_UNIT_PX), h.div_ceil(TILE_UNIT_PX));
        all.push(TargetDesc { usage: TextureUsages::STORAGE_BINDING | TextureUsages::TEXTURE_BINDING, ..target(PACKED_LABEL, PACKED_FORMAT, (w, h)) });
        all.push(TargetDesc { usage: TextureUsages::STORAGE_BINDING | TextureUsages::TEXTURE_BINDING, ..target(BLOCKS_LABEL, BLOCKS_FORMAT, blocks) });
        all.push(target(NEIGHBOUR_LABEL, TILES_FORMAT, (w.div_ceil(tile), h.div_ceil(tile))));
    }
    if let Some(format) = output {
        // A capture or a test reads it back.
        all.push(TargetDesc { usage: USAGE | TextureUsages::COPY_SRC, ..target(OUTPUT_LABEL, format, (w, h)) });
    }
    all
}

/// The node's bytes at `render` size (the pool's ledger entries).
pub fn target_bytes(render: (u32, u32), tier: MotionBlurTier, output: Option<TextureFormat>) -> u64 {
    targets(render, tier, output).iter().map(TargetDesc::bytes).sum()
}

/// The view distance at depth-buffer value `z` through `proj` is `|x + y z| / |z' + w z|` with
/// these four (`MotionBlurParams::depth`): `d = B / (A - C z)` for a perspective projection whose
/// depth row is `A z_view + B` and w row `C z_view`, `d = (B - z) / A` for an orthographic one.
pub fn depth_row(proj: Mat4) -> [f32; 4] {
    let (a, b, c) = (proj.z_axis.z, proj.w_axis.z, proj.z_axis.w);
    let perspective = c != 0.0 && proj.w_axis.w == 0.0;
    if perspective { [b, 0.0, a, -c] } else { [b, -1.0, a, 0.0] }
}

/// The node's uniform (`MotionBlurParams` in shaders/post/motion_blur_common.wgsl).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, bytemuck::Pod, bytemuck::Zeroable)]
pub struct GpuMotionBlurParams {
    /// xy: NDC motion to half the exposure vector in render pixels (y flipped to point down);
    /// z: the largest blur radius; w: its reciprocal.
    pub velocity: [f32; 4],
    /// xy: the render size; z: the tile side; w: sixteenth texels per tile side.
    pub size: [f32; 4],
    /// The view distance's terms ([`depth_row`]).
    pub depth: [f32; 4],
    /// x: the reconstruction's sample pairs at most; y: the direct tier's samples per side at most; z, w: the
    /// pass-through velocities ([`RECONSTRUCTION_MIN_PX`], [`DIRECT_MIN_PX`]).
    pub samples: [f32; 4],
}

impl GpuMotionBlurParams {
    /// The row for `frame` at `render` size through `proj`.
    pub fn new(frame: &MotionBlurFrameSettings, proj: Mat4, render: (u32, u32)) -> GpuMotionBlurParams {
        let (w, h) = (render.0.max(1), render.1.max(1));
        let shutter = frame.settings.held().shutter;
        // NDC spans 2 per screen side, and half the exposure vector is the radius: a quarter.
        let scale = 0.25 * shutter;
        let radius = max_radius_px(h);
        let tile = tile_px(h);
        GpuMotionBlurParams {
            velocity: [scale * w as f32, -scale * h as f32, radius, 1.0 / radius],
            size: [w as f32, h as f32, tile as f32, (tile / TILE_UNIT_PX) as f32],
            depth: depth_row(proj),
            samples: [RECONSTRUCTION_PAIRS, DIRECT_SAMPLES, RECONSTRUCTION_MIN_PX, DIRECT_MIN_PX],
        }
    }
}

/// The shared chunk: the row, the motion read, the fullscreen triangle and the noise.
const COMMON: &str = crate::shaders::minify::shipped_wgsl!(include_str!("../../shaders/post/motion_blur_common.wgsl"));
/// The depth read of a single-sampled depth.
const DEPTH_SINGLE: &str = crate::shaders::minify::shipped_wgsl!(include_str!("../../shaders/post/motion_blur_depth.wgsl"));
/// The depth read of sample 0 of a multisampled depth.
const DEPTH_MULTI: &str = crate::shaders::minify::shipped_wgsl!(include_str!("../../shaders/post/motion_blur_depth_ms.wgsl"));
/// The view distance and the packed speed (after a depth chunk).
const PACK: &str = crate::shaders::minify::shipped_wgsl!(include_str!("../../shaders/post/motion_blur_pack.wgsl"));
/// The block reduction and the tiles' neighbourhood maximum.
const TILES: &str = crate::shaders::minify::shipped_wgsl!(include_str!("../../shaders/post/motion_blur_tiles.wgsl"));
/// The reconstruction and the direct blur (after a depth chunk).
const BLUR: &str = crate::shaders::minify::shipped_wgsl!(include_str!("../../shaders/post/motion_blur.wgsl"));

/// The depth chunk for a depth of `samples` per pixel.
fn depth_chunk(samples: u32) -> &'static str {
    if samples > 1 { DEPTH_MULTI } else { DEPTH_SINGLE }
}

/// The tiles module for a depth of `samples` per pixel.
pub fn tiles_source(samples: u32) -> String {
    format!("{COMMON}\n{}\n{PACK}\n{TILES}", depth_chunk(samples))
}

/// The blur module for a depth of `samples` per pixel.
pub fn blur_source(samples: u32) -> String {
    format!("{COMMON}\n{}\n{PACK}\n{BLUR}", depth_chunk(samples))
}

/// Every module the node compiles, named (the validation and emission rows).
pub fn sources() -> Vec<(String, String)> {
    [1, 4].into_iter().flat_map(|samples| [(format!("motion blur tiles {samples}x"), tiles_source(samples)), (format!("motion blur {samples}x"), blur_source(samples))]).collect()
}

/// A pooled target and its view.
struct Held {
    texture: Texture,
    view: TextureView,
}

impl Held {
    fn pooled(target: &crate::target_pool::PooledTarget) -> Held {
        Held { texture: target.texture().clone(), view: target.view().clone() }
    }
}

/// The targets of one tier at one size.
struct Targets {
    render: (u32, u32),
    tier: MotionBlurTier,
    /// The reconstruction's packed speed and distance, blocks and neighbourhood.
    tiles: Option<[Held; 3]>,
    output: Option<Held>,
}

/// The blur pipelines of one depth sample count and output format.
struct Pipelines {
    reconstruct: Compiled<RenderPipeline>,
    direct: Compiled<RenderPipeline>,
}

/// Timestamp writes of a cost row.
#[derive(Clone, Copy, Debug)]
pub enum MotionBlurTimestamps<'a> {
    /// The index stamped at the first pass's beginning and the one stamped at the last pass's end
    /// (a row batching nodes stamps the first node's beginning and the last node's end).
    Span(&'a wgpu::QuerySet, Option<u32>, Option<u32>),
    /// Every pass `i` stamped at its beginning (`2 i`) and end (`2 i + 1`): the per-pass breakdown.
    PerPass(&'a wgpu::QuerySet),
}

/// What [`MotionBlurNode::encode`] reads and writes this frame.
pub struct MotionBlurInput<'a> {
    /// The HDR scene at render size (TAA's resolve or depth of field's output).
    pub scene: &'a TextureView,
    /// The prepass's motion at render size ([`crate::motion::MOTION_FORMAT`]).
    pub motion: &'a TextureView,
    /// The scene's depth at render size.
    pub depth: &'a TextureView,
    /// The depth's samples per pixel (sample 0 is read).
    pub depth_samples: u32,
    /// Where the blurred scene goes (render size, `output_format`), or None for the node's own
    /// [`OUTPUT_LABEL`] target. Never the scene it reads.
    pub output: Option<(&'a TextureView, TextureFormat)>,
    /// The render size.
    pub render: (u32, u32),
    /// The projection the depth was drawn with (its jitter does not matter).
    pub proj: Mat4,
    /// The frame's settings ([`frame_settings`]).
    pub frame: MotionBlurFrameSettings,
}

/// The motion-blur node (after depth of field, before graph node 18). Its targets come from the
/// target pool ([`MotionBlurNode::acquire`]); it keeps no history.
pub struct MotionBlurNode {
    blur_modules: [wgpu::ShaderModule; 2],
    /// The block reduction per depth sample count.
    blocks: [Compiled<ComputePipeline>; 2],
    neighbour: Compiled<RenderPipeline>,
    pipelines: Vec<((u32, TextureFormat), Pipelines)>,
    params: Buffer,
    targets: Option<Targets>,
}

/// A fullscreen pipeline of `entry` in `module` writing `format`.
fn fullscreen(device: &Device, module: &wgpu::ShaderModule, entry: &str, format: TextureFormat) -> Compiled<RenderPipeline> {
    crate::compile::render_pipeline(device, &wgpu::RenderPipelineDescriptor {
        label: Some(entry),
        layout: None,
        vertex: wgpu::VertexState { module, entry_point: Some("vs_motion_blur"), compilation_options: Default::default(), buffers: &[] },
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        fragment: Some(wgpu::FragmentState {
            module,
            entry_point: Some(entry),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState { format, blend: None, write_mask: wgpu::ColorWrites::ALL })],
        }),
        multiview_mask: None,
        cache: None,
    })
}

fn texture_entry(binding: u32, view: &TextureView) -> wgpu::BindGroupEntry<'_> {
    wgpu::BindGroupEntry { binding, resource: wgpu::BindingResource::TextureView(view) }
}

/// A pass's timestamp writes: the query set and index at its beginning, and at its end.
type PassStamps<'a> = (Option<(&'a wgpu::QuerySet, u32)>, Option<(&'a wgpu::QuerySet, u32)>);

/// One fullscreen pass of `pipeline` with `group` into `target`, stamped where `stamps` say.
fn pass(encoder: &mut wgpu::CommandEncoder, label: &str, pipeline: &RenderPipeline, group: &BindGroup, target: &TextureView, stamps: PassStamps<'_>) {
    let attachment = wgpu::RenderPassColorAttachment {
        view: target,
        depth_slice: None,
        resolve_target: None,
        ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store },
    };
    let timestamp_writes = match stamps {
        (None, None) => None,
        (begin, end) => begin.or(end).map(|(set, _)| wgpu::RenderPassTimestampWrites {
            query_set: set,
            beginning_of_pass_write_index: begin.map(|(_, index)| index),
            end_of_pass_write_index: end.map(|(_, index)| index),
        }),
    };
    let descriptor = wgpu::RenderPassDescriptor { label: Some(label), color_attachments: &[Some(attachment)], timestamp_writes, ..Default::default() };
    let mut pass = encoder.begin_render_pass(&descriptor);
    pass.set_pipeline(pipeline);
    pass.set_bind_group(0, group, &[]);
    pass.draw(0..3, 0..1);
}

/// The block reduction: one workgroup per 16x16 block of `blocks`, stamped where `stamps` say.
fn compute(encoder: &mut wgpu::CommandEncoder, pipeline: &ComputePipeline, group: &BindGroup, blocks: (u32, u32), stamps: PassStamps<'_>) {
    let timestamp_writes = match stamps {
        (None, None) => None,
        (begin, end) => begin.or(end).map(|(set, _)| wgpu::ComputePassTimestampWrites {
            query_set: set,
            beginning_of_pass_write_index: begin.map(|(_, index)| index),
            end_of_pass_write_index: end.map(|(_, index)| index),
        }),
    };
    let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("motion blur blocks"), timestamp_writes });
    pass.set_pipeline(pipeline);
    pass.set_bind_group(0, group, &[]);
    pass.dispatch_workgroups(blocks.0, blocks.1, 1);
}

/// The index of `samples` in the node's module pair.
const fn sample_slot(samples: u32) -> usize {
    if samples > 1 { 1 } else { 0 }
}

impl MotionBlurNode {
    /// The node, its tile pipelines compiled; the blurs come with the first frame of each depth
    /// sample count and output format.
    pub fn new(device: &Device) -> Result<MotionBlurNode, RenderError> {
        let tiles = [crate::shaders::module(device, "motion blur tiles", &tiles_source(1))?, crate::shaders::module(device, "motion blur tiles ms", &tiles_source(4))?];
        let reduction = |module: &wgpu::ShaderModule| {
            crate::compile::compute_pipeline(device, &wgpu::ComputePipelineDescriptor {
                label: Some("cs_mb_blocks"),
                layout: None,
                module,
                entry_point: Some("cs_mb_blocks"),
                compilation_options: Default::default(),
                cache: None,
            })
        };
        let blur_modules = [crate::shaders::module(device, "motion blur", &blur_source(1))?, crate::shaders::module(device, "motion blur ms", &blur_source(4))?];
        Ok(MotionBlurNode {
            blocks: [reduction(&tiles[0]), reduction(&tiles[1])],
            neighbour: fullscreen(device, &tiles[0], "fs_mb_neighbour", TILES_FORMAT),
            blur_modules,
            pipelines: Vec::new(),
            params: buffer(device, "motion blur params", size_of::<GpuMotionBlurParams>() as u64, BufferUsages::UNIFORM | BufferUsages::COPY_DST)?,
            targets: None,
        })
    }

    /// Take the targets of `tier` for a `render`-sized frame from `pool`; `output` also takes the
    /// node's own output in that format (frames whose caller has no free render-size target).
    pub fn acquire(&mut self, device: &Device, pool: &mut crate::target_pool::TargetPool, render: (u32, u32), tier: MotionBlurTier, output: Option<TextureFormat>) -> Result<(), RenderError> {
        let descs = targets(render, tier, output);
        let mut held = Vec::with_capacity(descs.len());
        for desc in &descs {
            held.push(Held::pooled(pool.acquire(device, *desc)?));
        }
        if tier != MotionBlurTier::Reconstruction {
            for label in [PACKED_LABEL, BLOCKS_LABEL, NEIGHBOUR_LABEL] {
                pool.release(label);
            }
        }
        if output.is_none() {
            pool.release(OUTPUT_LABEL);
        }
        let mut held = held.into_iter();
        let mut next = || held.next().ok_or_else(|| crate::readback::capture_failed("motion blur targets"));
        let tiles = if tier == MotionBlurTier::Reconstruction { Some([next()?, next()?, next()?]) } else { None };
        let output = if output.is_some() { Some(next()?) } else { None };
        self.targets = Some(Targets { render, tier, tiles, output });
        Ok(())
    }

    /// Give the targets back to `pool` (the node does not run).
    pub fn release(&mut self, pool: &mut crate::target_pool::TargetPool) {
        for label in LABELS {
            pool.release(label);
        }
        self.targets = None;
    }

    /// The node's own output (None unless [`MotionBlurNode::acquire`] took it).
    pub fn output_view(&self) -> Option<&TextureView> {
        self.targets.as_ref()?.output.as_ref().map(|held| &held.view)
    }

    /// The node's own output texture (a readback's source).
    pub fn output_texture(&self) -> Option<&Texture> {
        self.targets.as_ref()?.output.as_ref().map(|held| &held.texture)
    }

    /// The blur pipelines for a depth of `samples` writing `format`.
    fn pipelines(&mut self, device: &Device, samples: u32, format: TextureFormat) -> &Pipelines {
        let key = (sample_slot(samples) as u32, format);
        let index = match self.pipelines.iter().position(|(held, _)| *held == key) {
            Some(index) => index,
            None => {
                let module = &self.blur_modules[sample_slot(samples)];
                let made = Pipelines { reconstruct: fullscreen(device, module, "fs_mb_reconstruct", format), direct: fullscreen(device, module, "fs_mb_direct", format) };
                self.pipelines.push((key, made));
                self.pipelines.len() - 1
            }
        };
        &self.pipelines[index].1
    }

    /// Record the node's passes for `input`; the passes recorded (0 when no targets of this size
    /// and tier were acquired, or the tier is off). `timestamps` stamp as [`MotionBlurTimestamps`]
    /// says.
    pub fn encode(&mut self, device: &Device, queue: &Queue, encoder: &mut wgpu::CommandEncoder, input: MotionBlurInput<'_>, timestamps: Option<MotionBlurTimestamps<'_>>) -> u32 {
        let render = (input.render.0.max(1), input.render.1.max(1));
        let tier = input.frame.tier;
        if tier == MotionBlurTier::Off || self.targets.as_ref().is_none_or(|targets| targets.render != render || targets.tier != tier) {
            return 0;
        }
        let output_format = match input.output {
            Some((_, format)) => format,
            None => match self.targets.as_ref().and_then(|targets| targets.output.as_ref()) {
                Some(held) => held.texture.format(),
                None => return 0,
            },
        };
        let row = GpuMotionBlurParams::new(&input.frame, input.proj, render);
        queue.write_buffer(&self.params, 0, bytemuck::bytes_of(&row));
        let (reconstruct, direct) = {
            let pipelines = self.pipelines(device, input.depth_samples, output_format);
            (pipelines.reconstruct.clone(), pipelines.direct.clone())
        };
        let targets = self.targets.as_ref().expect("checked above");
        let output = input.output.map_or_else(|| &targets.output.as_ref().expect("checked above").view, |(view, _)| view);
        let passes = tier.passes();
        let mut index = 0u32;
        let mut stamps = || {
            let stamped = match timestamps {
                None => (None, None),
                Some(MotionBlurTimestamps::Span(set, begin, end)) => {
                    (begin.filter(|_| index == 0).map(|begin| (set, begin)), end.filter(|_| index + 1 == passes).map(|end| (set, end)))
                }
                Some(MotionBlurTimestamps::PerPass(set)) => (Some((set, 2 * index)), Some((set, 2 * index + 1))),
            };
            index += 1;
            stamped
        };
        let group = |label: &str, pipeline: &RenderPipeline, entries: &[wgpu::BindGroupEntry<'_>]| {
            device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some(label), layout: &pipeline.get_bind_group_layout(0), entries })
        };
        let params = crate::tables::entry(0, &self.params);
        match &targets.tiles {
            Some([packed, blocks, neighbour]) => {
                let reduction = &self.blocks[sample_slot(input.depth_samples)];
                let layout = reduction.get_bind_group_layout(0);
                let entries = [params.clone(), texture_entry(1, input.motion), texture_entry(2, input.depth), texture_entry(6, &blocks.view), texture_entry(7, &packed.view)];
                let bind = device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("motion blur blocks"), layout: &layout, entries: &entries });
                compute(encoder, reduction, &bind, (blocks.texture.width(), blocks.texture.height()), stamps());
                let bind = group("motion blur neighbour", &self.neighbour, &[params.clone(), texture_entry(3, &blocks.view)]);
                pass(encoder, "motion blur neighbour", &self.neighbour, &bind, &neighbour.view, stamps());
                let entries = [params, texture_entry(1, input.motion), texture_entry(3, &neighbour.view), texture_entry(4, input.scene), texture_entry(7, &packed.view)];
                let bind = group("motion blur reconstruct", &reconstruct, &entries);
                pass(encoder, "motion blur reconstruct", &reconstruct, &bind, output, stamps());
            }
            None => {
                let entries = [params, texture_entry(1, input.motion), texture_entry(2, input.depth), texture_entry(4, input.scene)];
                let bind = group("motion blur direct", &direct, &entries);
                pass(encoder, "motion blur direct", &direct, &bind, output, stamps());
            }
        }
        passes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tile_spans_the_largest_radius_in_whole_sixteen_pixel_units() {
        assert_eq!(tile_px(1080), 48);
        assert_eq!(tile_px(1440), 64);
        assert_eq!(tile_px(2160), 80);
        assert_eq!(tile_px(0), 16);
        for height in [1, 270, 283, 563, 1080, 1440, 2160] {
            assert!(tile_px(height) as f32 >= max_radius_px(height), "{height}");
        }
    }

    #[test]
    fn the_depth_row_gives_the_view_distance_of_either_projection() {
        let distance = |row: [f32; 4], z: f32| (row[0] + row[1] * z).abs() / (row[2] + row[3] * z).abs().max(1e-30);
        let proj = glam::camera::rh::proj::directx::perspective_infinite_reverse(1.0, 1.5, 0.1);
        let row = depth_row(proj);
        for d in [0.2f32, 1.0, 7.5, 300.0] {
            let z = 0.1 / d;
            assert!((distance(row, z) - d).abs() < 1e-3 * d, "{d}");
        }
        let ortho = glam::camera::rh::proj::directx::orthographic(-1.0, 1.0, -1.0, 1.0, 0.5, 50.0);
        let row = depth_row(ortho);
        for d in [0.5f32, 10.0, 49.0] {
            let clip = ortho * glam::Vec4::new(0.0, 0.0, -d, 1.0);
            assert!((distance(row, clip.z / clip.w) - d).abs() < 1e-3 * d, "ortho {d}");
        }
    }
}
