//! Screen inputs and the SSR helper (renderer pass 2 A.6; prior-art A3 step 1): what Stage B's
//! lake water (B.3) and Hi-Z screen-space reflections (B.9) read from the screen, and the shared
//! ray march they trace it with.
//!
//! - **The march helper** ([`SSR_MARCH`], `shaders/screen/ssr_march.wgsl`): `gx_ssr_march_run`
//!   marches a ray through a depth texture the caller hands it and returns the first surface it
//!   passes behind (Bevy 0.20.0's `ssr/raymarch.wesl`, Tomasz Stachowiak, MIT OR Apache-2.0: a
//!   linear march over the pixels the ray crosses, bisection and a secant step, bilinear and
//!   nearest depth taps). A chunk, not a pass: any shader that includes it after `common.wgsl`
//!   can call it (water's own fragment, a Level-2 material, B.9's fallback). [`march`] is its CPU
//!   twin, step for step.
//! - **The opaque copy** ([`encode_opaque_copy`], graph node 14a): the HDR scene after the opaque
//!   batches, the sky and the Level-2 materials (node 14), copied whole before the transparent
//!   draws (node 15), so water refracts and reflects the scene behind it without reading the
//!   target it draws into. One `copy_texture_to_texture` of the scene's own format at render size
//!   ([`OPAQUE_COPY_MS_MAX`]), on single-sampled frames only (TAA's, or anti-aliasing off).
//! - **The previous frame's colour pyramid** ([`PyramidNode`], `history_pyramid.wgsl`, after TAA,
//!   node 17): TAA's resolved output (the next frame's "previous frame") halved [`PYRAMID_MIPS_MAX`]
//!   times with a smooth five-tap tent, so a rough reflection reads one filtered tap at the mip its
//!   cone spans. One compute pass, a dispatch a mip. It needs TAA: without it a consumer reads the
//!   opaque copy.
//! - **The prepass's normal and roughness** ([`NORMAL_ROUGHNESS_FORMAT`],
//!   `normal_roughness.wgsl`): the normal-mapped world normal (two 12-bit octahedral coordinates in
//!   rgb) and the perceptual roughness (a), one `rgba8unorm` texel a pixel, written by the prepass
//!   on SSR presets beside its vertex normals ([`pack_normal_roughness`] is the twin).
//! - **The depth and its Hi-Z**: the prepass depth and graph node 8's pyramid as they are; B.9
//!   builds its own chain of the closest depth (node 8 keeps the farthest).
//! - **The screen reflections' slot** ([`FRAME_REFLECTIONS_BINDING`]): forward frame-group binding
//!   30 (rgb reflected radiance, a confidence), the forward stage's 16th sampled texture of 16
//!   (owner decision D1), reserved here and bound by B.9.
//!
//! The inputs run on desktop and web `high` and `ultra` ([`ScreenInputs`], `Quality::screen_inputs`)
//! and only for a consumer that asks for them ([`frame_inputs`]: plan principle 3, pay for what
//! you use). Every target is pooled under its own label, so the budget ledger counts it. The node
//! adds no binding to the forward stage until B.9 binds the reflections at 30.

use wgpu::{BindGroup, CommandEncoder, ComputePipeline, Device, Sampler, Texture, TextureFormat, TextureUsages, TextureView};

use crate::compile::Compiled;
use crate::error::{RenderCode, RenderError};
use crate::settings::Quality;
use crate::target_pool::TargetDesc;

/// The march helper chunk (include after `common.wgsl`, which holds `gx_view_distance`).
pub const SSR_MARCH: &str = include_str!("../shaders/screen/ssr_march.wgsl");
/// The normal and roughness packing chunk with its readers' half (include after `effects.wgsl`).
pub const NORMAL_ROUGHNESS: &str = concat!(include_str!("../shaders/screen/normal_roughness_unpack.wgsl"), include_str!("../shaders/screen/normal_roughness.wgsl"));
/// The readers' half alone: the unpacking a pass that only reads the texel includes (B.9).
pub const NORMAL_ROUGHNESS_UNPACK: &str = include_str!("../shaders/screen/normal_roughness_unpack.wgsl");
/// The colour pyramid's pass.
pub const HISTORY_PYRAMID: &str = crate::shaders::minify::shipped_wgsl!(include_str!("../shaders/screen/history_pyramid.wgsl"));
/// The pyramid's compute entry point (one dispatch a mip).
pub const PYRAMID_ENTRY: &str = "cs_pyramid";
/// The pyramid's compute workgroup side (8 x 8 invocations, a texel each).
pub const PYRAMID_WORKGROUP: u32 = 8;

/// The opaque copy's budget at a 1080p render (TIER-AB plan A.6).
pub const OPAQUE_COPY_MS_MAX: f32 = 0.1;
/// The most mips of the colour pyramid (half the render size down to a 64th of it).
pub const PYRAMID_MIPS_MAX: u32 = 6;
/// The colour pyramid's format (TAA's history format: HDR, filterable, renderable in core).
pub const PYRAMID_FORMAT: TextureFormat = TextureFormat::Rgba16Float;
/// The prepass's normal and roughness format on SSR presets.
pub const NORMAL_ROUGHNESS_FORMAT: TextureFormat = TextureFormat::Rgba8Unorm;
/// The screen reflections' format: rgb reflected radiance (pre-exposed), a the confidence.
pub const REFLECTIONS_FORMAT: TextureFormat = TextureFormat::Rgba16Float;
/// The forward frame group's slot for the screen reflections, as (binding, WGSL name): reserved
/// for B.9 (the stage's 16th sampled texture; binding 31 is the LOD crossfade's fade table).
pub const FRAME_REFLECTIONS_BINDING: (u32, &str) = (30, "screen_reflections");

/// The opaque copy's pool label (its budget-ledger row).
pub const OPAQUE_LABEL: &str = "opaque copy";
/// The colour pyramid's pool label.
pub const PYRAMID_LABEL: &str = "history pyramid";
/// The prepass normal and roughness target's pool label.
pub const NORMAL_ROUGHNESS_LABEL: &str = "prepass normal roughness";
/// Every pool label the inputs may hold (released when nothing asks).
pub const LABELS: [&str; 3] = [OPAQUE_LABEL, PYRAMID_LABEL, NORMAL_ROUGHNESS_LABEL];

/// The opaque copy's usages: copied into, sampled by its consumers.
pub const OPAQUE_USAGE: TextureUsages = TextureUsages::COPY_DST.union(TextureUsages::TEXTURE_BINDING);
/// The colour pyramid's usages: each mip written as storage (`rgba16float` is a core storage
/// format), then sampled by the next and by consumers.
pub const PYRAMID_USAGE: TextureUsages = TextureUsages::STORAGE_BINDING.union(TextureUsages::TEXTURE_BINDING);
/// The normal and roughness target's usages: a prepass colour attachment, then loaded.
pub const NORMAL_ROUGHNESS_USAGE: TextureUsages = TextureUsages::RENDER_ATTACHMENT.union(TextureUsages::TEXTURE_BINDING);

/// Which screen inputs a preset allows (`Quality::screen_inputs`) or a frame's consumers ask for.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct ScreenInputs {
    /// The opaque scene copied before the transparent draws (node 14a).
    pub opaque_copy: bool,
    /// The previous frame's colour pyramid built from TAA's output (after node 17).
    pub history_pyramid: bool,
    /// The prepass's normal-mapped normal and roughness (node 7, a second colour target).
    pub normal_roughness: bool,
}

impl ScreenInputs {
    /// None of them.
    pub const NONE: ScreenInputs = ScreenInputs { opaque_copy: false, history_pyramid: false, normal_roughness: false };
    /// All of them (desktop and web `high` and `ultra`).
    pub const ALL: ScreenInputs = ScreenInputs { opaque_copy: true, history_pyramid: true, normal_roughness: true };
    /// What lake water reads (B.3): the opaque copy and the previous frame's colour.
    pub const WATER: ScreenInputs = ScreenInputs { opaque_copy: true, history_pyramid: true, normal_roughness: false };
    /// What the Hi-Z screen-space reflections read (B.9): the prepass's normal and roughness and
    /// the previous frame's colour.
    pub const SSR: ScreenInputs = ScreenInputs { opaque_copy: false, history_pyramid: true, normal_roughness: true };

    /// Whether none is on.
    pub const fn is_empty(self) -> bool {
        !(self.opaque_copy || self.history_pyramid || self.normal_roughness)
    }

    /// The inputs on in both.
    pub const fn intersection(self, other: ScreenInputs) -> ScreenInputs {
        ScreenInputs {
            opaque_copy: self.opaque_copy && other.opaque_copy,
            history_pyramid: self.history_pyramid && other.history_pyramid,
            normal_roughness: self.normal_roughness && other.normal_roughness,
        }
    }

    /// The inputs on in either.
    pub const fn union(self, other: ScreenInputs) -> ScreenInputs {
        ScreenInputs {
            opaque_copy: self.opaque_copy || other.opaque_copy,
            history_pyramid: self.history_pyramid || other.history_pyramid,
            normal_roughness: self.normal_roughness || other.normal_roughness,
        }
    }

    /// The inputs' stable spellings (timings, ledger rows), in a fixed order.
    pub fn wires(self) -> Vec<&'static str> {
        [(self.opaque_copy, OPAQUE_LABEL), (self.history_pyramid, PYRAMID_LABEL), (self.normal_roughness, NORMAL_ROUGHNESS_LABEL)]
            .into_iter()
            .filter_map(|(on, label)| on.then_some(label))
            .collect()
    }
}

/// The inputs a frame produces: what its consumers `asked` that the preset allows, none on the
/// legacy LDR scene, no colour pyramid without TAA (its source is TAA's output) and no opaque copy
/// of a multisampled world pass (the copy would need the samples resolved mid-pass and kept).
pub fn frame_inputs(quality: &Quality, hdr: bool, asked: ScreenInputs) -> ScreenInputs {
    if !hdr {
        return ScreenInputs::NONE;
    }
    let inputs = quality.screen_inputs.intersection(asked);
    ScreenInputs {
        opaque_copy: inputs.opaque_copy && quality.anti_aliasing.samples() == 1,
        history_pyramid: inputs.history_pyramid && quality.anti_aliasing.temporal(),
        ..inputs
    }
}

/// The colour pyramid's mip 0 size: half the render size, at least 1 x 1.
pub const fn pyramid_size(render: (u32, u32)) -> (u32, u32) {
    crate::hiz::base_size(render)
}

/// The colour pyramid's mips at `render` size: down to 1 x 1, at most [`PYRAMID_MIPS_MAX`].
pub const fn pyramid_mips(render: (u32, u32)) -> u32 {
    let full = crate::hiz::mip_count(pyramid_size(render));
    if full < PYRAMID_MIPS_MAX { full } else { PYRAMID_MIPS_MAX }
}

/// The targets `inputs` hold at `render` size, the opaque copy in the scene's `scene_format`.
pub fn targets(render: (u32, u32), scene_format: TextureFormat, inputs: ScreenInputs) -> Vec<TargetDesc> {
    let size = (render.0.max(1), render.1.max(1));
    let mut out = Vec::new();
    if inputs.opaque_copy {
        out.push(TargetDesc { label: OPAQUE_LABEL, format: scene_format, usage: OPAQUE_USAGE, samples: 1, size, mips: 1, srgb_view: false });
    }
    if inputs.history_pyramid {
        out.push(TargetDesc { label: PYRAMID_LABEL, format: PYRAMID_FORMAT, usage: PYRAMID_USAGE, samples: 1, size: pyramid_size(size), mips: pyramid_mips(size), srgb_view: false });
    }
    if inputs.normal_roughness {
        out.push(TargetDesc { label: NORMAL_ROUGHNESS_LABEL, format: NORMAL_ROUGHNESS_FORMAT, usage: NORMAL_ROUGHNESS_USAGE, samples: 1, size, mips: 1, srgb_view: false });
    }
    out
}

/// The bytes [`targets`] hold (the ledger's rows for them).
pub fn target_bytes(render: (u32, u32), scene_format: TextureFormat, inputs: ScreenInputs) -> u64 {
    targets(render, scene_format, inputs).iter().map(TargetDesc::bytes).sum()
}

// ---------------------------------------------------------------------------------------------
// The opaque copy

/// Record the opaque copy: `scene` (the HDR scene after node 14, single-sampled, `COPY_SRC`)
/// copied whole into `opaque` (a texture of [`targets`]' opaque row). Refused `texture-invalid`
/// when the two differ in size, format or samples.
pub fn encode_opaque_copy(encoder: &mut CommandEncoder, scene: &Texture, opaque: &Texture) -> Result<(), RenderError> {
    let fits = scene.size() == opaque.size() && scene.format() == opaque.format() && scene.sample_count() == 1 && opaque.sample_count() == 1;
    if !fits {
        let (from, to) = (scene.size(), opaque.size());
        let detail = format!("an opaque copy of a {}x{} {:?} scene into a {}x{} {:?} target", from.width, from.height, scene.format(), to.width, to.height, opaque.format());
        return Err(RenderError::refused(RenderCode::TextureInvalid, detail));
    }
    encoder.copy_texture_to_texture(scene.as_image_copy(), opaque.as_image_copy(), scene.size());
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// The colour pyramid

/// What one pyramid build reads and writes.
#[derive(Clone, Copy, Debug)]
pub struct PyramidInput<'a> {
    /// TAA's resolved output at render size (filterable).
    pub source: &'a TextureView,
    /// The pyramid: a texture of [`targets`]' pyramid row for `render`.
    pub pyramid: &'a Texture,
    /// The render size (the source's).
    pub render: (u32, u32),
}

/// A build's timestamp writes: the query set, the index stamped at the first pass's beginning and
/// the one stamped at the last pass's end.
#[derive(Clone, Copy, Debug)]
pub struct PyramidStamps<'a> {
    /// The query set.
    pub set: &'a wgpu::QuerySet,
    /// The first pass's beginning.
    pub begin: Option<u32>,
    /// The last pass's end.
    pub end: Option<u32>,
}

/// The cached bind groups' inputs.
struct PyramidKey {
    source: TextureView,
    pyramid: Texture,
}

/// One mip's dispatch: its bind group and its size in texels.
struct PyramidLevel {
    group: BindGroup,
    size: (u32, u32),
}

/// The colour pyramid's build: its pipeline, sampler and each mip's dispatch for the current input.
pub struct PyramidNode {
    pipeline: Compiled<ComputePipeline>,
    sampler: Sampler,
    cached: Option<(PyramidKey, Vec<PyramidLevel>)>,
}

impl PyramidNode {
    /// The build's pipeline and sampler.
    pub fn new(device: &Device) -> Result<PyramidNode, RenderError> {
        let module = crate::shaders::module(device, "history pyramid", HISTORY_PYRAMID)?;
        let pipeline = crate::compile::compute_pipeline(device, &wgpu::ComputePipelineDescriptor {
            label: Some("history pyramid"),
            layout: None,
            module: &module,
            entry_point: Some(PYRAMID_ENTRY),
            compilation_options: Default::default(),
            cache: None,
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("history pyramid"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        Ok(PyramidNode { pipeline, sampler, cached: None })
    }

    /// Record the build of `input`'s pyramid: one compute pass, one dispatch a mip. Refused
    /// `texture-invalid` when the pyramid is not [`targets`]' pyramid row for `render`.
    pub fn encode(&mut self, device: &Device, encoder: &mut CommandEncoder, input: PyramidInput<'_>, stamps: Option<PyramidStamps<'_>>) -> Result<(), RenderError> {
        check_pyramid(&input)?;
        let fresh = self.cached.as_ref().is_none_or(|(key, _)| key.source != *input.source || key.pyramid != *input.pyramid);
        if fresh {
            let levels = self.levels(device, &input);
            self.cached = Some((PyramidKey { source: input.source.clone(), pyramid: input.pyramid.clone() }, levels));
        }
        let Some((_, levels)) = self.cached.as_ref() else { return Ok(()) };
        let timestamp_writes = stamps
            .filter(|stamps| stamps.begin.is_some() || stamps.end.is_some())
            .map(|stamps| wgpu::ComputePassTimestampWrites { query_set: stamps.set, beginning_of_pass_write_index: stamps.begin, end_of_pass_write_index: stamps.end });
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("history pyramid"), timestamp_writes });
        pass.set_pipeline(&self.pipeline);
        for level in levels {
            pass.set_bind_group(0, &level.group, &[]);
            pass.dispatch_workgroups(level.size.0.div_ceil(PYRAMID_WORKGROUP), level.size.1.div_ceil(PYRAMID_WORKGROUP), 1);
        }
        Ok(())
    }

    /// Each mip's bind group (its source: TAA's output for mip 0, the mip above otherwise; its
    /// storage view) and size.
    fn levels(&self, device: &Device, input: &PyramidInput<'_>) -> Vec<PyramidLevel> {
        let layout = self.pipeline.get_bind_group_layout(0);
        let mip_view = |mip: u32| input.pyramid.create_view(&wgpu::TextureViewDescriptor { label: Some("history pyramid mip"), base_mip_level: mip, mip_level_count: Some(1), ..Default::default() });
        let mips = input.pyramid.mip_level_count();
        let views: Vec<TextureView> = (0..mips).map(mip_view).collect();
        let base = pyramid_size(input.render);
        views
            .iter()
            .enumerate()
            .map(|(mip, dest)| {
                let source = if mip == 0 { input.source } else { &views[mip - 1] };
                let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("history pyramid"),
                    layout: &layout,
                    entries: &[
                        wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(source) },
                        wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                        wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(dest) },
                    ],
                });
                PyramidLevel { group, size: crate::hiz::level_size(base, mip as u32) }
            })
            .collect()
    }
}

/// A pyramid that is not [`targets`]' pyramid row for the input's render size.
fn check_pyramid(input: &PyramidInput<'_>) -> Result<(), RenderError> {
    let size = input.pyramid.size();
    let fits = (size.width, size.height) == pyramid_size(input.render)
        && input.pyramid.mip_level_count() == pyramid_mips(input.render)
        && input.pyramid.format() == PYRAMID_FORMAT
        && input.pyramid.usage().contains(PYRAMID_USAGE);
    if fits {
        return Ok(());
    }
    let detail = format!("a {}x{} pyramid of {} mips for a {}x{} render", size.width, size.height, input.pyramid.mip_level_count(), input.render.0, input.render.1);
    Err(RenderError::refused(RenderCode::TextureInvalid, detail))
}

// ---------------------------------------------------------------------------------------------
// CPU twins

/// The CPU twin of `gx_pack_normal_roughness`: the `rgba8unorm` texel holding unit normal `n` and
/// perceptual roughness `roughness`.
pub fn pack_normal_roughness(n: [f32; 3], roughness: f32) -> [u8; 4] {
    let e = crate::prepass::oct_encode(n).map(|c| ((c * 0.5 + 0.5).clamp(0.0, 1.0) * NORMAL_CODE_MAX).round_ties_even() as u32);
    let [x, y] = e;
    let r = x >> 4;
    let g = ((x & 15) << 4) | (y >> 8);
    let b = y & 255;
    [r as u8, g as u8, b as u8, (roughness.clamp(0.0, 1.0) * 255.0).round_ties_even() as u8]
}

/// `GX_NR_CODE_MAX`: the largest 12-bit code.
const NORMAL_CODE_MAX: f32 = 4095.0;

/// The CPU twin of `gx_unpack_normal` and `gx_unpack_roughness`.
pub fn unpack_normal_roughness(texel: [u8; 4]) -> ([f32; 3], f32) {
    let [r, g, b, a] = texel.map(u32::from);
    let q = [(r << 4) | (g >> 4), ((g & 15) << 8) | b];
    let e = q.map(|c| c as f32 / NORMAL_CODE_MAX * 2.0 - 1.0);
    (crate::prepass::oct_decode(e), a as f32 / 255.0)
}

/// The CPU twin of the pyramid's first mip: `source` (`size`, rgba row by row) filtered as
/// `fs_pyramid` filters it into [`pyramid_size`]`(size)` (bilinear taps, clamped to the edge).
pub fn pyramid_reference(size: (u32, u32), source: &[[f32; 4]]) -> Vec<[f32; 4]> {
    let dest = pyramid_size(size);
    let (w, h) = (size.0 as f32, size.1 as f32);
    let texel = [1.0 / w, 1.0 / h];
    let rest = (1.0 - PYRAMID_CENTRE) * 0.25;
    let mut out = Vec::with_capacity((dest.0 * dest.1) as usize);
    for y in 0..dest.1 {
        for x in 0..dest.0 {
            let uv = [(x as f32 + 0.5) * 2.0 / w, (y as f32 + 0.5) * 2.0 / h];
            let tap = |dx: f32, dy: f32| bilinear(size, source, [uv[0] + dx * texel[0], uv[1] + dy * texel[1]]);
            let centre = tap(0.0, 0.0);
            let corners = [tap(-1.0, -1.0), tap(1.0, -1.0), tap(-1.0, 1.0), tap(1.0, 1.0)];
            out.push(std::array::from_fn(|c| centre[c] * PYRAMID_CENTRE + (corners[0][c] + corners[1][c] + corners[2][c] + corners[3][c]) * rest));
        }
    }
    out
}

/// `GX_PYRAMID_CENTRE`: the centre tap's weight.
const PYRAMID_CENTRE: f32 = 0.5;

/// A bilinear, clamp-to-edge sample of `source` (`size`, row by row) at `uv`.
fn bilinear(size: (u32, u32), source: &[[f32; 4]], uv: [f32; 2]) -> [f32; 4] {
    let coord = [uv[0] * size.0 as f32 - 0.5, uv[1] * size.1 as f32 - 0.5];
    let base = coord.map(f32::floor);
    let f = [coord[0] - base[0], coord[1] - base[1]];
    let at = |dx: i64, dy: i64| {
        let x = (base[0] as i64 + dx).clamp(0, i64::from(size.0) - 1) as usize;
        let y = (base[1] as i64 + dy).clamp(0, i64::from(size.1) - 1) as usize;
        source[y * size.0 as usize + x]
    };
    let (a, b, c, d) = (at(0, 0), at(1, 0), at(0, 1), at(1, 1));
    std::array::from_fn(|i| {
        let top = a[i] * (1.0 - f[0]) + b[i] * f[0];
        let bottom = c[i] * (1.0 - f[0]) + d[i] * f[0];
        top * (1.0 - f[1]) + bottom * f[1]
    })
}

/// The march helper's CPU twin (`shaders/screen/ssr_march.wgsl`), step for step in f32.
pub mod march {
    use glam::{Mat4, Vec3, Vec4};

    /// `GX_SSR_FAR`: the view distance standing for the sky.
    pub const FAR: f32 = 1e30;

    /// A depth image: `size` and its depth-buffer values row by row.
    #[derive(Clone, Debug)]
    pub struct DepthImage {
        /// Width and height.
        pub size: (u32, u32),
        /// The values, row by row.
        pub texels: Vec<f32>,
    }

    /// `GxSsrMarch`.
    #[derive(Clone, Copy, Debug, PartialEq)]
    pub struct SsrMarch {
        /// NDC of the ray's start (clipped to the frustum).
        pub start: Vec3,
        /// NDC of its end.
        pub end: Vec3,
        /// The most linear samples.
        pub linear_steps: u32,
        /// 1 or 2.
        pub exponent: u32,
        /// Bisection steps after the first hit.
        pub bisection_steps: u32,
        /// One secant step after the bisection.
        pub secant: bool,
        /// The first sample's offset in 0..1 of a step (1: none).
        pub jitter: f32,
        /// March past surfaces the ray goes deeper behind than `thickness`.
        pub behind_surfaces: bool,
        /// Nearest depth taps only.
        pub sloppy: bool,
        /// Depth texels' assumed thickness (world units).
        pub thickness: f32,
        /// The projection the depth was drawn with.
        pub proj: Mat4,
        /// Reverse-Z.
        pub reversed: bool,
    }

    /// `GxSsrHit`.
    #[derive(Clone, Copy, Debug, PartialEq)]
    pub struct SsrHit {
        /// Whether the ray passed behind a surface within its thickness.
        pub hit: bool,
        /// The hit's share of the ray, or the furthest share a miss travelled.
        pub t: f32,
        /// The screen uv at `t`.
        pub uv: [f32; 2],
        /// How far behind the surface the hit lies (world units).
        pub penetration: f32,
        /// That as a share of the thickness.
        pub penetration_share: f32,
    }

    /// `gx_ssr_march_new`.
    pub fn new(start: Vec3, proj: Mat4, reversed: bool) -> SsrMarch {
        SsrMarch { start, end: start, linear_steps: 4, exponent: 1, bisection_steps: 0, secant: false, jitter: 1.0, behind_surfaces: false, sloppy: false, thickness: 1.0, proj, reversed }
    }

    /// WGSL's `sign` (0 for 0).
    fn sign(v: f32) -> f32 {
        if v > 0.0 {
            1.0
        } else if v < 0.0 {
            -1.0
        } else {
            0.0
        }
    }

    /// WGSL's `mix`.
    fn mix(a: f32, b: f32, t: f32) -> f32 {
        a * (1.0 - t) + b * t
    }

    /// `gx_ssr_edge_reach`.
    fn edge_reach(offset: Vec3, delta: Vec3, none: f32) -> Vec3 {
        let axis = |o: f32, d: f32| if d == 0.0 { none } else { o / d };
        Vec3::new(axis(offset.x, delta.x), axis(offset.y, delta.y), axis(offset.z, delta.z))
    }

    /// `gx_ssr_march_clip`.
    fn clip(march: SsrMarch, dir: Vec4, infinite: bool) -> SsrMarch {
        let mut end = march.start.extend(1.0) + dir;
        let flip = if end.w >= 0.0 { 1.0 } else { -1.0 };
        end /= flip * end.w.abs().max(W_FLOOR);
        let mut delta = end.truncate() - march.start;
        let near_edge = Vec3::select(delta.cmplt(Vec3::ZERO), Vec3::ONE, Vec3::new(-1.0, -1.0, 0.0));
        let to_near = edge_reach(near_edge - march.start, delta, -FAR);
        let start = march.start + delta * 0f32.max(to_near.x.max(to_near.y));
        delta = end.truncate() - start;
        let far_edge = Vec3::select(delta.cmpge(Vec3::ZERO), Vec3::ONE, Vec3::new(-1.0, -1.0, 0.0));
        let to_far = edge_reach(far_edge - start, delta, FAR);
        let reach = to_far.x.min(to_far.y).min(to_far.z);
        let scale = if infinite { reach } else { reach.min(1.0) };
        SsrMarch { start, end: start + delta * scale, ..march }
    }

    /// `GX_SSR_W_FLOOR`.
    const W_FLOOR: f32 = 1e-10;
    /// `GX_SSR_DEPTH_BIAS`.
    const DEPTH_BIAS: f32 = 0.000002;
    /// `GX_SSR_SECANT_GAIN`.
    const SECANT_GAIN: f32 = 0.9;
    /// `GX_SSR_MIN_STEPS`.
    const MIN_STEPS: i32 = 2;

    /// `gx_ssr_march_to`.
    pub fn to(march: SsrMarch, end: Vec3) -> SsrMarch {
        clip(march, (end - march.start).extend(0.0) * sign(end.z), false)
    }

    /// `gx_ssr_march_toward`.
    pub fn toward(march: SsrMarch, dir: Vec4) -> SsrMarch {
        clip(march, dir, true)
    }

    /// `gx_ssr_march_world`.
    pub fn world(view_proj: Mat4, proj: Mat4, reversed: bool, origin: Vec3, direction: Vec3) -> SsrMarch {
        let start = view_proj * origin.extend(1.0);
        toward(new(start.truncate() / start.w, proj, reversed), view_proj * direction.extend(0.0))
    }

    /// `gx_ssr_uv`.
    fn uv(ndc: Vec3) -> [f32; 2] {
        [ndc.x * 0.5 + 0.5, ndc.y * -0.5 + 0.5]
    }

    /// `gx_ssr_depth_texel`.
    fn texel(depth: &DepthImage, x: i64, y: i64) -> f32 {
        let x = x.clamp(0, i64::from(depth.size.0) - 1) as usize;
        let y = y.clamp(0, i64::from(depth.size.1) - 1) as usize;
        depth.texels[y * depth.size.0 as usize + x]
    }

    /// `gx_ssr_depth_nearest`.
    fn nearest(depth: &DepthImage, uv: [f32; 2], size: [f32; 2]) -> f32 {
        texel(depth, (uv[0] * size[0]).floor() as i64, (uv[1] * size[1]).floor() as i64)
    }

    /// `gx_ssr_depth_bilinear`.
    fn bilinear(depth: &DepthImage, uv: [f32; 2], size: [f32; 2]) -> f32 {
        let coord = [uv[0] * size[0] - 0.5, uv[1] * size[1] - 0.5];
        let base = coord.map(f32::floor);
        let f = [coord[0] - base[0], coord[1] - base[1]];
        let (x, y) = (base[0] as i64, base[1] as i64);
        let top = mix(texel(depth, x, y), texel(depth, x + 1, y), f[0]);
        let bottom = mix(texel(depth, x, y + 1), texel(depth, x + 1, y + 1), f[0]);
        mix(top, bottom, f[1])
    }

    /// `gx_view_distance` (common.wgsl).
    pub fn view_distance(proj: Mat4, depth: f32) -> f32 {
        if proj.col(3).w == 1.0 {
            return (proj.col(3).z - depth) / proj.col(2).z;
        }
        proj.col(3).z / (depth + proj.col(2).z)
    }

    /// `gx_ssr_distance`.
    fn distance(march: &SsrMarch, value: f32) -> f32 {
        let sky = if march.reversed { value <= 0.0 } else { value >= 1.0 };
        if sky {
            return FAR;
        }
        view_distance(march.proj, value).min(FAR)
    }

    /// `GxSsrSample`.
    #[derive(Clone, Copy, Debug)]
    struct Sample {
        distance: f32,
        valid: bool,
        penetration: f32,
    }

    impl Sample {
        const NONE: Sample = Sample { distance: 0.0, valid: false, penetration: 0.0 };

        /// `gx_ssr_behind`.
        fn behind(self) -> bool {
            self.distance < 0.0 && self.valid
        }
    }

    /// `gx_ssr_sample`.
    fn sample(depth: &DepthImage, march: &SsrMarch, size: [f32; 2], point: Vec3) -> Sample {
        let uv = uv(point);
        let ray = distance(march, point.z);
        let nearest = distance(march, nearest(depth, uv, size));
        let (far, near) = if march.sloppy {
            (nearest, nearest)
        } else {
            let smooth_surface = distance(march, bilinear(depth, uv, size));
            (smooth_surface.max(nearest), smooth_surface.min(nearest))
        };
        let penetration = ray - near;
        let valid = !march.behind_surfaces || penetration < march.thickness;
        Sample { distance: far * (1.0 + DEPTH_BIAS) - ray, valid, penetration }
    }

    /// `gx_ssr_step_t`.
    fn step_t(march: &SsrMarch, step: f32, steps: f32) -> f32 {
        let along = (step + march.jitter) / steps;
        let mut t = along;
        for _ in 1..march.exponent {
            t *= along;
        }
        t
    }

    /// `gx_ssr_march_run`.
    pub fn run(depth: &DepthImage, march: &SsrMarch) -> SsrHit {
        let size = [depth.size.0 as f32, depth.size.1 as f32];
        let start_uv = uv(march.start);
        let end_uv = uv(march.end);
        let span = [(end_uv[0] - start_uv[0]) * size[0], (end_uv[1] - start_uv[1]) * size[1]];
        let span_px = (span[0] * span[0] + span[1] * span[1]).sqrt();
        let steps = MIN_STEPS.max((march.linear_steps as i32).min(span_px.floor() as i32));
        let dir = march.end - march.start;
        let at = |t: f32| march.start + dir * t;

        let (mut min_t, mut max_t) = (0.0f32, 1.0f32);
        let (mut min_s, mut max_s) = (Sample::NONE, Sample::NONE);
        let mut intersected = false;
        for step in 0..steps {
            let t = step_t(march, step as f32, steps as f32);
            let s = sample(depth, march, size, at(t));
            if s.behind() {
                max_t = t;
                max_s = s;
                intersected = true;
                break;
            }
            min_t = t;
            min_s = s;
        }
        let miss_t = min_t;
        let mut hit_t = min_t;
        let mut hit_s = max_s;

        if intersected {
            for _ in 0..march.bisection_steps {
                let mid_t = (min_t + max_t) * 0.5;
                let s = sample(depth, march, size, at(mid_t));
                if s.behind() {
                    max_t = mid_t;
                    max_s = s;
                } else {
                    min_t = mid_t;
                    min_s = s;
                }
            }
            hit_t = max_t;
            hit_s = max_s;
            if march.secant {
                let mid_t = mix(min_t, max_t, min_s.distance / (min_s.distance - max_s.distance));
                let s = sample(depth, march, size, at(mid_t));
                if s.distance.abs() < min_s.distance * SECANT_GAIN && s.valid {
                    hit_t = mid_t;
                    hit_s = s;
                }
            }
        }

        let lerp_uv = |t: f32| [mix(start_uv[0], end_uv[0], t), mix(start_uv[1], end_uv[1], t)];
        if intersected && hit_s.penetration < march.thickness && hit_s.distance < march.thickness {
            return SsrHit { hit: true, t: hit_t, uv: lerp_uv(hit_t), penetration: hit_s.penetration, penetration_share: hit_s.penetration / march.thickness };
        }
        SsrHit { hit: false, t: miss_t, uv: lerp_uv(miss_t), penetration: 0.0, penetration_share: 0.0 }
    }
}
