//! Gather depth of field (renderer pass 2, A.9 / prior-art A7.2): the HDR scene blurred by each
//! pixel's circle of confusion, after TAA (graph node 17) and before `post-hdr` (node 18), so its
//! gather is never fed back into TAA's history and bloom and the exposure see the blurred scene
//! (Filament's order: TAA, DoF, bloom, grading, upscale).
//!
//! A look switch, off by default ([`DepthOfField`], `Look::depth_of_field`): a thin lens focused at
//! [`DepthOfField::focus_distance`] with an f-number, over a 24 mm sensor whose focal length the
//! projection's field of view gives. The circle of confusion is a madd on the depth buffer
//! ([`CocParams`], Filament's derivation: `coc(z) = K (1 - S / d)` with `1/d` affine in reverse-Z
//! depth), negative in front of the focus plane and positive behind it, clamped to the tier's
//! radius ([`DofTier::max_coc`]). Two tiers ([`DofTier`], `Quality::dof`):
//!
//! - [`DofTier::Ring`] (desktop and web `high` and `ultra`): a port of Filament v1.77.3's
//!   `materials/dof` (Apache-2.0; Jimenez 2014 and Abadie's "Life of a Bokeh" 2018). A
//!   half-resolution colour with the CoC in its alpha and three mips; 16 px min/max CoC tiles,
//!   (two reductions) dilated by two tiles; a ring gather with separate foreground (two layers) and background
//!   (ring-occlusion merge) buckets and a fast path for constant-CoC tiles; McGuire's 3x3 median;
//!   a full-resolution combine. Ten fragment passes.
//! - [`DofTier::Circular`] (`low`, `medium` and every phone): Godot 4.7.2's raster circular bokeh
//!   (`bokeh_dof_raster.glsl`, MIT, after Tuxedo Labs 2018): one golden-angle gather at half
//!   resolution whose loop is capped at the tier's radius and at the tile's own largest CoC, then
//!   Godot's composite with a CoC-aware upsample. Six passes (the downsample and the tiles are
//!   the ring tier's).
//!
//! Neither tier draws noise (the ring gather drops Filament's jitter of its centre), so a still
//! camera draws the same blur every frame and a steady pan a steady one (TAA cannot resolve noise
//! drawn after it; the prior art's still-camera row). In-focus tiles pass the scene through
//! unchanged.
//! The render size need not be a multiple of 16: the half-resolution targets are padded up to
//! whole tiles and every read past the render size is clamped to its edge.
//!
//! The node reads the HDR scene and the depth (single-sampled, or sample 0 of a multisampled
//! depth on frames without the prepass) and writes into a target the caller names (the 1x scene
//! when TAA's output is the input, else [`OUTPUT_LABEL`] from the pool). It adds no binding to the
//! forward stage. A settled capture draws without it unless its shot asks ([`frame_settings`]).

use glam::Mat4;
use wgpu::{BindGroup, Buffer, BufferUsages, Device, Queue, RenderPipeline, Sampler, Texture, TextureFormat, TextureUsages, TextureView};

use crate::compile::Compiled;
use crate::error::RenderError;
use crate::settings::Quality;
use crate::tables::buffer;
use crate::target_pool::TargetDesc;

/// Whether the node can run (its rows and modules have landed).
pub const LANDED: bool = true;

/// The sensor height the focal length is derived from, metres (a full-frame 24 mm sensor:
/// Filament's `FCamera::SENSOR_SIZE`).
pub const SENSOR_HEIGHT_M: f32 = 0.024;
/// Below this CoC radius (full-resolution pixels) a pixel is in focus (Filament's
/// `MAX_IN_FOCUS_COC`).
pub const MAX_IN_FOCUS_COC: f32 = 1.0;
/// The CoC tile side, full-resolution pixels (Filament's `tileSize`).
pub const TILE_PX: u32 = 16;
/// Mip levels of the ring tier's half-resolution colour (Filament's `maxMipLevels`).
pub const RING_MIPS: u32 = 4;
/// The ring tier's largest CoC radius, full-resolution pixels (Filament's desktop
/// `DOF_DEFAULT_MAX_COC`; its two dilate rounds of 16 px tiles reach it).
pub const RING_MAX_COC_PX: f32 = 32.0;
/// The ring tier's rings per field (Filament's desktop `DOF_DEFAULT_RING_COUNT`: 81 samples).
pub const RING_COUNT: f32 = 5.0;
/// The circular tier's largest CoC radius, full-resolution pixels (Filament's mobile default).
pub const CIRCULAR_MAX_COC_PX: f32 = 24.0;
/// The most samples the circular gather takes (Godot's radius step is chosen per pixel so its
/// spiral reaches the tile's largest CoC in this many: one pixel apart up to an 11 px reach).
pub const CIRCULAR_SAMPLES: f32 = 64.0;

/// The half-resolution colour (rgb the scene, a the CoC radius in full-resolution pixels).
pub const COLOUR_FORMAT: TextureFormat = TextureFormat::Rgba16Float;
/// The min/max CoC tiles.
pub const TILES_FORMAT: TextureFormat = TextureFormat::Rg16Float;
/// The gather's and the median's output (rgb premultiplied colour, a its coverage; the circular
/// tier's a is the gathered CoC).
pub const GATHER_FORMAT: TextureFormat = TextureFormat::Rgba16Float;
/// The half-resolution colour's pool label.
pub const COLOUR_LABEL: &str = "dof colour";
/// The quarter tiles' pool label (4x4 half-resolution texels each).
pub const QUARTER_TILES_LABEL: &str = "dof tiles quarter";
/// The CoC tiles' pool label.
pub const TILES_LABEL: &str = "dof tiles";
/// The dilated tiles' pool label.
pub const DILATED_LABEL: &str = "dof tiles dilated";
/// The gather's pool label.
pub const GATHER_LABEL: &str = "dof gather";
/// The median's pool label (ring tier).
pub const MEDIAN_LABEL: &str = "dof median";
/// The node's own output when the caller has no free render-size target (frames without TAA).
pub const OUTPUT_LABEL: &str = "dof output";
/// Every pool label the node may hold (released when it does not run).
pub const LABELS: [&str; 7] = [COLOUR_LABEL, QUARTER_TILES_LABEL, TILES_LABEL, DILATED_LABEL, GATHER_LABEL, MEDIAN_LABEL, OUTPUT_LABEL];
const USAGE: TextureUsages = TextureUsages::RENDER_ATTACHMENT.union(TextureUsages::TEXTURE_BINDING);

/// The look's depth of field: a thin lens focused at `focus_distance` (off by default).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DepthOfField {
    /// Whether the frame blurs by depth at all.
    pub enabled: bool,
    /// The distance in focus, world units (metres) along the view axis.
    pub focus_distance: f32,
    /// The aperture's f-number: smaller blurs more (f/1.4 a portrait lens, f/16 nearly everything
    /// sharp).
    pub f_stop: f32,
    /// An artistic scale on the physical circle of confusion (1 is the thin lens).
    pub coc_scale: f32,
}

/// The default focus distance, metres.
pub const DEFAULT_FOCUS_DISTANCE: f32 = 10.0;
/// The default f-number.
pub const DEFAULT_F_STOP: f32 = 2.8;
/// The nearest focus distance, metres.
pub const FOCUS_DISTANCE_MIN: f32 = 0.05;
/// The farthest focus distance, metres.
pub const FOCUS_DISTANCE_MAX: f32 = 10_000.0;
/// The f-number range.
pub const F_STOP_RANGE: (f32, f32) = (0.7, 64.0);
/// The largest artistic CoC scale.
pub const COC_SCALE_MAX: f32 = 8.0;

impl DepthOfField {
    /// No depth of field (the default look).
    pub const OFF: DepthOfField = DepthOfField { enabled: false, focus_distance: DEFAULT_FOCUS_DISTANCE, f_stop: DEFAULT_F_STOP, coc_scale: 1.0 };

    /// Depth of field focused at `focus_distance` metres through an aperture of `f_stop`.
    pub const fn focused(focus_distance: f32, f_stop: f32) -> DepthOfField {
        DepthOfField { enabled: true, focus_distance, f_stop, coc_scale: 1.0 }
    }

    /// The settings with the artistic CoC `scale`.
    pub const fn with_coc_scale(mut self, scale: f32) -> DepthOfField {
        self.coc_scale = scale;
        self
    }

    /// Each knob held to its range (a value that is not a number takes the default).
    pub fn held(self) -> DepthOfField {
        let hold = |value: f32, default: f32, min: f32, max: f32| if value.is_nan() { default } else { value.clamp(min, max) };
        DepthOfField {
            enabled: self.enabled,
            focus_distance: hold(self.focus_distance, DEFAULT_FOCUS_DISTANCE, FOCUS_DISTANCE_MIN, FOCUS_DISTANCE_MAX),
            f_stop: hold(self.f_stop, DEFAULT_F_STOP, F_STOP_RANGE.0, F_STOP_RANGE.1),
            coc_scale: hold(self.coc_scale, 1.0, 0.0, COC_SCALE_MAX),
        }
    }
}

impl Default for DepthOfField {
    fn default() -> Self {
        DepthOfField::OFF
    }
}

/// The gather a preset draws with (`Quality::dof`).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DofTier {
    /// Godot's circular golden-angle gather at half resolution (low, medium and phones).
    Circular,
    /// Filament's ring gather with foreground and background fields, a median and a combine
    /// (desktop and web high and ultra).
    Ring,
}

impl DofTier {
    /// The largest CoC radius the tier draws, full-resolution pixels.
    pub const fn max_coc(self) -> f32 {
        match self {
            DofTier::Circular => CIRCULAR_MAX_COC_PX,
            DofTier::Ring => RING_MAX_COC_PX,
        }
    }

    /// The colour's mip levels.
    pub const fn mips(self) -> u32 {
        match self {
            DofTier::Circular => 1,
            DofTier::Ring => RING_MIPS,
        }
    }

    /// The render passes the node records.
    pub const fn passes(self) -> u32 {
        match self {
            // downsample, quarter tiles, tiles, dilate, gather, composite
            DofTier::Circular => 6,
            // downsample, three mips, quarter tiles, tiles, dilate, gather, median, combine
            DofTier::Ring => 7 + RING_MIPS - 1,
        }
    }

    /// The tier's spelling.
    pub const fn as_str(self) -> &'static str {
        match self {
            DofTier::Circular => "circular",
            DofTier::Ring => "ring",
        }
    }
}

/// What kind of frame asks for depth of field.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DofFrame {
    /// A Live frame: the look decides.
    Live,
    /// A settled capture: drawn without depth of field unless the shot asks (`shot_asks`).
    Settled {
        /// Whether the shot asked for the look's depth of field.
        shot_asks: bool,
    },
}

/// What the node draws a frame with.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DofFrameSettings {
    /// The look's depth of field, held to its ranges.
    pub settings: DepthOfField,
    /// The tier.
    pub tier: DofTier,
}

/// Whether depth of field runs on a frame of the HDR scene (`hdr`) drawn with `quality` through
/// `proj` with `look`, and how. None: the look's switch is off, the scene is the legacy LDR one,
/// the projection is orthographic (no lens), the aperture blurs nothing, or a settled capture
/// whose shot did not ask for it.
pub fn frame_settings(look: &DepthOfField, quality: &Quality, hdr: bool, proj: Mat4, frame: DofFrame) -> Option<DofFrameSettings> {
    let settings = look.held();
    let asked = match frame {
        DofFrame::Live => true,
        DofFrame::Settled { shot_asks } => shot_asks,
    };
    let lens = is_perspective(proj) && settings.coc_scale > 0.0;
    (LANDED && settings.enabled && hdr && asked && lens).then_some(DofFrameSettings { settings, tier: quality.dof })
}

/// Whether `proj` is a perspective projection (clip w from view z).
pub fn is_perspective(proj: Mat4) -> bool {
    proj.z_axis.w != 0.0 && proj.w_axis.w == 0.0
}

/// The circle of confusion as a madd on the depth buffer: `diameter(depth) = depth * scale + bias`
/// in full-resolution pixels (Filament's `cocParams`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CocParams {
    /// The CoC diameter per unit of depth-buffer value.
    pub scale: f32,
    /// The CoC diameter at depth-buffer value 0 (reverse-Z: infinitely far).
    pub bias: f32,
}

impl CocParams {
    /// The madd for `settings` through `proj` at a render `height` in pixels. With `A` and `B` the
    /// projection's depth row and `C` its w row, `1/d = (A - C * depth) / B`, so
    /// `coc = K (1 - S / d) = (K S C / B) depth + K (1 - S A / B)`, where `K` is the thin lens's CoC
    /// on the sensor (`A f / (S - f)`, `A = f / N`) in pixels (`height / sensor`) times the scale.
    pub fn new(settings: &DepthOfField, proj: Mat4, height: u32) -> CocParams {
        let focal = 0.5 * SENSOR_HEIGHT_M * proj.y_axis.y;
        let focus = settings.focus_distance.max(focal * 1.01);
        let aperture = focal / settings.f_stop;
        let k = settings.coc_scale * (height.max(1) as f32 / SENSOR_HEIGHT_M) * (aperture * focal / (focus - focal));
        let (a, b, c) = (proj.z_axis.z, proj.w_axis.z, proj.z_axis.w);
        if b == 0.0 {
            return CocParams { scale: 0.0, bias: 0.0 };
        }
        CocParams { scale: k * focus * c / b, bias: k * (1.0 - focus * a / b) }
    }

    /// The signed CoC radius, full-resolution pixels, at depth-buffer value `depth`, clamped to
    /// `max` and zero in focus (the shaders' `dof_coc`).
    pub fn radius(&self, depth: f32, max: f32) -> f32 {
        let radius = ((depth * self.scale + self.bias) * 0.5).clamp(-max, max);
        if radius.abs() < MAX_IN_FOCUS_COC { 0.0 } else { radius }
    }
}

/// The half-resolution size for a `render`-sized frame: whole 16 px tiles, halved.
pub fn half_size(render: (u32, u32)) -> (u32, u32) {
    let tiles = tiles_size(render);
    (tiles.0 * TILE_PX / 2, tiles.1 * TILE_PX / 2)
}

/// The CoC tiles covering a `render`-sized frame.
pub fn tiles_size(render: (u32, u32)) -> (u32, u32) {
    (render.0.max(1).div_ceil(TILE_PX), render.1.max(1).div_ceil(TILE_PX))
}

/// Every pooled target of `tier` at `render` size; `output` adds the node's own output in
/// `output_format`.
pub fn targets(render: (u32, u32), tier: DofTier, output: Option<TextureFormat>) -> Vec<TargetDesc> {
    let half = half_size(render);
    let tiles = tiles_size(render);
    let target = |label, format, size, mips| TargetDesc { label, format, usage: USAGE, samples: 1, size, mips, srgb_view: false };
    let mut all = vec![
        target(COLOUR_LABEL, COLOUR_FORMAT, half, tier.mips()),
        target(QUARTER_TILES_LABEL, TILES_FORMAT, (tiles.0 * 2, tiles.1 * 2), 1),
        target(TILES_LABEL, TILES_FORMAT, tiles, 1),
        target(DILATED_LABEL, TILES_FORMAT, tiles, 1),
        target(GATHER_LABEL, GATHER_FORMAT, half, 1),
    ];
    if tier == DofTier::Ring {
        all.push(target(MEDIAN_LABEL, GATHER_FORMAT, half, 1));
    }
    if let Some(format) = output {
        // A capture or a test reads it back.
        all.push(TargetDesc { usage: USAGE | TextureUsages::COPY_SRC, ..target(OUTPUT_LABEL, format, (render.0.max(1), render.1.max(1)), 1) });
    }
    all
}

/// The node's bytes at `render` size (the pool's ledger entries).
pub fn target_bytes(render: (u32, u32), tier: DofTier, output: Option<TextureFormat>) -> u64 {
    targets(render, tier, output).iter().map(TargetDesc::bytes).sum()
}

/// The node's uniform (`DofParams` in shaders/post/dof_common.wgsl).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, bytemuck::Pod, bytemuck::Zeroable)]
pub struct GpuDofParams {
    /// x, y: the CoC diameter's madd ([`CocParams`]); z: the most negative (foreground) radius;
    /// w: the largest (background) radius.
    pub coc: [f32; 4],
    /// xy: the render size; zw: 1 / the half-resolution size.
    pub size: [f32; 4],
    /// xy: full-resolution pixels to half-resolution uv; z: full to half-resolution pixels (0.5);
    /// w: the circular gather's most samples.
    pub scale: [f32; 4],
    /// The ring gather's rings: foreground, background, fast tiles; w: reserved.
    pub rings: [f32; 4],
}

impl GpuDofParams {
    /// The row for `frame` at `render` size through `proj`.
    pub fn new(frame: &DofFrameSettings, proj: Mat4, render: (u32, u32)) -> GpuDofParams {
        let coc = CocParams::new(&frame.settings, proj, render.1);
        let max = frame.tier.max_coc();
        let half = half_size(render);
        let (hw, hh) = (half.0 as f32, half.1 as f32);
        GpuDofParams {
            coc: [coc.scale, coc.bias, -max, max],
            size: [render.0.max(1) as f32, render.1.max(1) as f32, 1.0 / hw, 1.0 / hh],
            scale: [0.5 / hw, 0.5 / hh, 0.5, CIRCULAR_SAMPLES],
            rings: [RING_COUNT, RING_COUNT, RING_COUNT, 0.0],
        }
    }
}

/// The shared chunk: the row, the fullscreen triangle and the CoC helpers.
const COMMON: &str = crate::shaders::minify::shipped_wgsl!(include_str!("../../shaders/post/dof_common.wgsl"));
/// The depth read of a single-sampled depth.
const DEPTH_SINGLE: &str = crate::shaders::minify::shipped_wgsl!(include_str!("../../shaders/post/dof_depth.wgsl"));
/// The depth read of sample 0 of a multisampled depth.
const DEPTH_MULTI: &str = crate::shaders::minify::shipped_wgsl!(include_str!("../../shaders/post/dof_depth_ms.wgsl"));
/// The downsample, mip, tile and dilate passes (after a depth chunk).
const PREPARE: &str = crate::shaders::minify::shipped_wgsl!(include_str!("../../shaders/post/dof_prepare.wgsl"));
/// The ring gather and the median (Filament).
const RING: &str = crate::shaders::minify::shipped_wgsl!(include_str!("../../shaders/post/dof_ring.wgsl"));
/// The circular gather (Godot).
const CIRCULAR: &str = crate::shaders::minify::shipped_wgsl!(include_str!("../../shaders/post/dof_circular.wgsl"));
/// The ring combine and the circular composite (after a depth chunk).
const COMBINE: &str = crate::shaders::minify::shipped_wgsl!(include_str!("../../shaders/post/dof_combine.wgsl"));

/// The depth chunk for a depth of `samples` per pixel.
fn depth_chunk(samples: u32) -> &'static str {
    if samples > 1 { DEPTH_MULTI } else { DEPTH_SINGLE }
}

/// The prepare module (downsample, mips, tiles, dilate) for a depth of `samples` per pixel.
pub fn prepare_source(samples: u32) -> String {
    format!("{COMMON}\n{}\n{PREPARE}", depth_chunk(samples))
}

/// The gather module (the ring gather and median, and the circular gather).
pub fn gather_source() -> String {
    format!("{COMMON}\n{RING}\n{CIRCULAR}")
}

/// The combine module for a depth of `samples` per pixel.
pub fn combine_source(samples: u32) -> String {
    format!("{COMMON}\n{}\n{COMBINE}", depth_chunk(samples))
}

/// Every module the node compiles, named (the validation and emission rows).
pub fn sources() -> Vec<(String, String)> {
    let mut all = Vec::new();
    for samples in [1, 4] {
        all.push((format!("dof prepare {samples}x"), prepare_source(samples)));
        all.push((format!("dof combine {samples}x"), combine_source(samples)));
    }
    all.push(("dof gather".to_owned(), gather_source()));
    all
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
    tier: DofTier,
    colour: Held,
    /// One view per mip of the colour (render targets and the mip passes' sources).
    colour_mips: Vec<TextureView>,
    quarter: Held,
    tiles: Held,
    dilated: Held,
    gather: Held,
    median: Option<Held>,
    output: Option<Held>,
}

/// The pipelines of one depth sample count and output format.
struct Pipelines {
    downsample: Compiled<RenderPipeline>,
    composite: Compiled<RenderPipeline>,
    combine: Compiled<RenderPipeline>,
}

/// Timestamp writes of a cost row.
#[derive(Clone, Copy, Debug)]
pub enum DofTimestamps<'a> {
    /// The index stamped at the first pass's beginning and the one stamped at the last pass's end
    /// (a row batching nodes stamps the first node's beginning and the last node's end).
    Span(&'a wgpu::QuerySet, Option<u32>, Option<u32>),
    /// Every pass `i` stamped at its beginning (`2 i`) and end (`2 i + 1`): the per-pass breakdown.
    PerPass(&'a wgpu::QuerySet),
}

/// What [`DofNode::encode`] reads and writes this frame.
pub struct DofInput<'a> {
    /// The HDR scene at render size (TAA's resolve, or the resolved scene).
    pub scene: &'a TextureView,
    /// The scene's depth at render size.
    pub depth: &'a TextureView,
    /// The depth's samples per pixel (sample 0 is read).
    pub depth_samples: u32,
    /// Where the blurred scene goes (render size, `output_format`), or None for the node's own
    /// [`OUTPUT_LABEL`] target.
    pub output: Option<(&'a TextureView, TextureFormat)>,
    /// The render size.
    pub render: (u32, u32),
    /// The projection the depth was drawn with (its jitter does not matter).
    pub proj: Mat4,
    /// The frame's settings ([`frame_settings`]).
    pub frame: DofFrameSettings,
}

/// The depth-of-field node (between graph nodes 17 and 18). Its targets come from the target
/// pool ([`DofNode::acquire`]); it keeps no history.
pub struct DofNode {
    prepare_modules: [wgpu::ShaderModule; 2],
    combine_modules: [wgpu::ShaderModule; 2],
    mip: Compiled<RenderPipeline>,
    quarter: Compiled<RenderPipeline>,
    tiles: Compiled<RenderPipeline>,
    dilate: Compiled<RenderPipeline>,
    ring: Compiled<RenderPipeline>,
    median: Compiled<RenderPipeline>,
    circular: Compiled<RenderPipeline>,
    pipelines: Vec<((u32, TextureFormat), Pipelines)>,
    nearest: Sampler,
    linear: Sampler,
    params: Buffer,
    targets: Option<Targets>,
}

/// A fullscreen pipeline of `entry` in `module` writing `format`.
fn fullscreen(device: &Device, module: &wgpu::ShaderModule, entry: &str, format: TextureFormat) -> Compiled<RenderPipeline> {
    crate::compile::render_pipeline(device, &wgpu::RenderPipelineDescriptor {
        label: Some(entry),
        layout: None,
        vertex: wgpu::VertexState { module, entry_point: Some("vs_dof"), compilation_options: Default::default(), buffers: &[] },
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

fn sampler_entry(binding: u32, sampler: &Sampler) -> wgpu::BindGroupEntry<'_> {
    wgpu::BindGroupEntry { binding, resource: wgpu::BindingResource::Sampler(sampler) }
}

/// A pass's timestamp writes: the query set and index at its beginning, and at its end.
type PassStamps<'a> = (Option<(&'a wgpu::QuerySet, u32)>, Option<(&'a wgpu::QuerySet, u32)>);

/// One fullscreen pass of `pipeline` with `group` into `target`, stamped at its beginning and
/// end where `stamps` say.
fn pass(encoder: &mut wgpu::CommandEncoder, label: &str, pipeline: &RenderPipeline, group: &BindGroup, target: &TextureView, stamps: PassStamps<'_>) {
    let attachment = wgpu::RenderPassColorAttachment {
        view: target,
        depth_slice: None,
        resolve_target: None,
        ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store },
    };
    let timestamp_writes = match stamps {
        (None, None) => None,
        (begin, end) => Some(wgpu::RenderPassTimestampWrites {
            query_set: begin.or(end).map(|(set, _)| set).expect("one stamp"),
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

/// The index of `samples` in the node's module pairs.
const fn sample_slot(samples: u32) -> usize {
    if samples > 1 { 1 } else { 0 }
}

impl DofNode {
    /// The node, its sample-count independent pipelines compiled; the downsample and combine come
    /// with the first frame of each depth sample count and output format.
    pub fn new(device: &Device) -> Result<DofNode, RenderError> {
        let prepare_modules = [crate::shaders::module(device, "dof prepare", &prepare_source(1))?, crate::shaders::module(device, "dof prepare ms", &prepare_source(4))?];
        let combine_modules = [crate::shaders::module(device, "dof combine", &combine_source(1))?, crate::shaders::module(device, "dof combine ms", &combine_source(4))?];
        let gather = crate::shaders::module(device, "dof gather", &gather_source())?;
        let prepare = &prepare_modules[0];
        let sampler = |label, filter| {
            device.create_sampler(&wgpu::SamplerDescriptor {
                label: Some(label),
                mag_filter: filter,
                min_filter: filter,
                mipmap_filter: wgpu::MipmapFilterMode::Nearest,
                ..Default::default()
            })
        };
        Ok(DofNode {
            mip: fullscreen(device, prepare, "fs_dof_mip", COLOUR_FORMAT),
            quarter: fullscreen(device, prepare, "fs_dof_tiles_quarter", TILES_FORMAT),
            tiles: fullscreen(device, prepare, "fs_dof_tiles", TILES_FORMAT),
            dilate: fullscreen(device, prepare, "fs_dof_dilate", TILES_FORMAT),
            ring: fullscreen(device, &gather, "fs_dof_ring", GATHER_FORMAT),
            median: fullscreen(device, &gather, "fs_dof_median", GATHER_FORMAT),
            circular: fullscreen(device, &gather, "fs_dof_circular", GATHER_FORMAT),
            prepare_modules,
            combine_modules,
            pipelines: Vec::new(),
            nearest: sampler("dof nearest", wgpu::FilterMode::Nearest),
            linear: sampler("dof linear", wgpu::FilterMode::Linear),
            params: buffer(device, "dof params", size_of::<GpuDofParams>() as u64, BufferUsages::UNIFORM | BufferUsages::COPY_DST)?,
            targets: None,
        })
    }

    /// Take the targets of `tier` for a `render`-sized frame from `pool`; `output` also takes the
    /// node's own output in that format (frames whose caller has no free render-size target).
    pub fn acquire(&mut self, device: &Device, pool: &mut crate::target_pool::TargetPool, render: (u32, u32), tier: DofTier, output: Option<TextureFormat>) -> Result<(), RenderError> {
        let descs = targets(render, tier, output);
        let mut held = Vec::with_capacity(descs.len());
        for desc in &descs {
            held.push(Held::pooled(pool.acquire(device, *desc)?));
        }
        if tier == DofTier::Circular {
            pool.release(MEDIAN_LABEL);
        }
        if output.is_none() {
            pool.release(OUTPUT_LABEL);
        }
        let mut held = held.into_iter();
        let mut next = || held.next().ok_or_else(|| crate::readback::capture_failed("dof targets"));
        let colour = next()?;
        let colour_mips = (0..tier.mips())
            .map(|level| colour.texture.create_view(&wgpu::TextureViewDescriptor { base_mip_level: level, mip_level_count: Some(1), ..Default::default() }))
            .collect();
        let (quarter, tiles, dilated, gather) = (next()?, next()?, next()?, next()?);
        let median = if tier == DofTier::Ring { Some(next()?) } else { None };
        let output = if output.is_some() { Some(next()?) } else { None };
        self.targets = Some(Targets { render, tier, colour, colour_mips, quarter, tiles, dilated, gather, median, output });
        Ok(())
    }

    /// Give the targets back to `pool` (the node does not run).
    pub fn release(&mut self, pool: &mut crate::target_pool::TargetPool) {
        for label in LABELS {
            pool.release(label);
        }
        self.targets = None;
    }

    /// The node's own output (None unless [`DofNode::acquire`] took it).
    pub fn output_view(&self) -> Option<&TextureView> {
        self.targets.as_ref()?.output.as_ref().map(|held| &held.view)
    }

    /// The node's own output texture (a readback's source).
    pub fn output_texture(&self) -> Option<&Texture> {
        self.targets.as_ref()?.output.as_ref().map(|held| &held.texture)
    }

    /// The downsample, composite and combine pipelines for a depth of `samples` writing `format`.
    fn pipelines(&mut self, device: &Device, samples: u32, format: TextureFormat) -> &Pipelines {
        let key = (sample_slot(samples) as u32, format);
        let index = match self.pipelines.iter().position(|(held, _)| *held == key) {
            Some(index) => index,
            None => {
                let (prepare, combine) = (&self.prepare_modules[sample_slot(samples)], &self.combine_modules[sample_slot(samples)]);
                let made = Pipelines {
                    downsample: fullscreen(device, prepare, "fs_dof_downsample", COLOUR_FORMAT),
                    composite: fullscreen(device, combine, "fs_dof_composite", format),
                    combine: fullscreen(device, combine, "fs_dof_combine", format),
                };
                self.pipelines.push((key, made));
                self.pipelines.len() - 1
            }
        };
        &self.pipelines[index].1
    }

    /// Record the node's passes for `input`; the passes recorded (0 when no targets of this size
    /// and tier were acquired). `timestamps` stamp the first pass's beginning and the last's end.
    pub fn encode(&mut self, device: &Device, queue: &Queue, encoder: &mut wgpu::CommandEncoder, input: DofInput<'_>, timestamps: Option<DofTimestamps<'_>>) -> u32 {
        let render = (input.render.0.max(1), input.render.1.max(1));
        let tier = input.frame.tier;
        if self.targets.as_ref().is_none_or(|targets| targets.render != render || targets.tier != tier) {
            return 0;
        }
        let output_format = match input.output {
            Some((_, format)) => format,
            None => match self.targets.as_ref().and_then(|targets| targets.output.as_ref()) {
                Some(held) => held.texture.format(),
                None => return 0,
            },
        };
        let row = GpuDofParams::new(&input.frame, input.proj, render);
        queue.write_buffer(&self.params, 0, bytemuck::bytes_of(&row));
        let samples = input.depth_samples;
        let (downsample, composite, combine) = {
            let pipelines = self.pipelines(device, samples, output_format);
            (pipelines.downsample.clone(), pipelines.composite.clone(), pipelines.combine.clone())
        };
        let targets = self.targets.as_ref().expect("checked above");
        let output = input.output.map_or_else(|| &targets.output.as_ref().expect("checked above").view, |(view, _)| view);
        let passes = tier.passes();
        let mut index = 0u32;
        let mut stamps = || {
            let stamped = match timestamps {
                None => (None, None),
                Some(DofTimestamps::Span(set, begin, end)) => {
                    (begin.filter(|_| index == 0).map(|begin| (set, begin)), end.filter(|_| index + 1 == passes).map(|end| (set, end)))
                }
                Some(DofTimestamps::PerPass(set)) => (Some((set, 2 * index)), Some((set, 2 * index + 1))),
            };
            index += 1;
            stamped
        };
        let group = |label: &str, pipeline: &RenderPipeline, entries: &[wgpu::BindGroupEntry<'_>]| {
            device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some(label), layout: &pipeline.get_bind_group_layout(0), entries })
        };
        let params = crate::tables::entry(0, &self.params);
        // 1. Downsample: the scene and the CoC at half resolution.
        let bind = group("dof downsample", &downsample, &[params.clone(), texture_entry(1, input.scene), texture_entry(2, input.depth)]);
        pass(encoder, "dof downsample", &downsample, &bind, &targets.colour_mips[0], stamps());
        // 2. Mips (ring tier).
        for level in 1..tier.mips() as usize {
            let bind = group("dof mip", &self.mip, &[texture_entry(4, &targets.colour_mips[level - 1])]);
            pass(encoder, "dof mip", &self.mip, &bind, &targets.colour_mips[level], stamps());
        }
        // 3. The CoC tiles and their dilation.
        let bind = group("dof tiles quarter", &self.quarter, &[texture_entry(4, &targets.colour_mips[0]), sampler_entry(6, &self.nearest)]);
        pass(encoder, "dof tiles quarter", &self.quarter, &bind, &targets.quarter.view, stamps());
        let bind = group("dof tiles", &self.tiles, &[texture_entry(5, &targets.quarter.view)]);
        pass(encoder, "dof tiles", &self.tiles, &bind, &targets.tiles.view, stamps());
        let bind = group("dof dilate", &self.dilate, &[texture_entry(5, &targets.tiles.view)]);
        pass(encoder, "dof dilate", &self.dilate, &bind, &targets.dilated.view, stamps());
        match tier {
            DofTier::Ring => {
                let median = targets.median.as_ref().expect("the ring tier's median");
                let entries = [params.clone(), texture_entry(3, &targets.colour.view), texture_entry(5, &targets.dilated.view), sampler_entry(6, &self.nearest), sampler_entry(7, &self.linear)];
                let bind = group("dof ring", &self.ring, &entries);
                pass(encoder, "dof ring", &self.ring, &bind, &targets.gather.view, stamps());
                let bind = group("dof median", &self.median, &[texture_entry(5, &targets.dilated.view), texture_entry(8, &targets.gather.view)]);
                pass(encoder, "dof median", &self.median, &bind, &median.view, stamps());
                let entries = [params, texture_entry(1, input.scene), texture_entry(5, &targets.dilated.view), texture_entry(8, &median.view), sampler_entry(7, &self.linear)];
                let bind = group("dof combine", &combine, &entries);
                pass(encoder, "dof combine", &combine, &bind, output, stamps());
            }
            DofTier::Circular => {
                let entries = [params.clone(), texture_entry(3, &targets.colour.view), texture_entry(5, &targets.dilated.view), sampler_entry(6, &self.nearest)];
                let bind = group("dof circular", &self.circular, &entries);
                pass(encoder, "dof circular", &self.circular, &bind, &targets.gather.view, stamps());
                let entries = [params, texture_entry(1, input.scene), texture_entry(2, input.depth), texture_entry(5, &targets.dilated.view), texture_entry(8, &targets.gather.view)];
                let bind = group("dof composite", &composite, &entries);
                pass(encoder, "dof composite", &composite, &bind, output, stamps());
            }
        }
        passes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn proj() -> Mat4 {
        glam::camera::rh::proj::directx::perspective_infinite_reverse(60f32.to_radians(), 16.0 / 9.0, 0.1)
    }

    #[test]
    fn the_coc_is_zero_at_the_focus_distance_negative_before_it_and_positive_behind() {
        let settings = DepthOfField::focused(2.0, 2.8);
        let coc = CocParams::new(&settings, proj(), 1080);
        // Reverse-Z infinite: depth = near / d.
        let depth = |d: f32| 0.1 / d;
        assert!((coc.scale * depth(2.0) + coc.bias).abs() < 1e-4);
        assert!(coc.scale * depth(1.0) + coc.bias < 0.0, "nearer than the focus: foreground");
        assert!(coc.scale * depth(8.0) + coc.bias > 0.0, "farther: background");
        assert!((coc.bias - (coc.scale * 0.0 + coc.bias)).abs() < 1e-6);
        assert_eq!(coc.radius(depth(2.0), 32.0), 0.0);
        assert_eq!(coc.radius(0.0, 1.0), 1.0, "the sky clamps to the tier's radius");
    }

    #[test]
    fn the_padded_half_size_holds_whole_sixteen_pixel_tiles() {
        assert_eq!(half_size((1920, 1080)), (960, 544));
        assert_eq!(tiles_size((1920, 1080)), (120, 68));
        assert_eq!(half_size((1000, 563)), (504, 288));
        assert_eq!(half_size((0, 0)), (8, 8));
    }
}
