//! Hi-Z screen-space reflections (renderer pass 2 B.9; prior-art A3 step 2): what a smooth surface
//! reflects of the screen, handed to the forward pass at binding 30, where the probes take over as
//! the screen's confidence fades.
//!
//! - **The nearest-depth Hi-Z** ([`hiz_reduce`]): graph node 8's build ([`crate::hiz::HizNode`])
//!   run with the opposite reduction, so each texel holds the *nearest* depth of its region (a ray
//!   may skip a region whose nearest surface it passes in front of). Half the render size down to
//!   1 x 1, `r32float`, pooled as [`HIZ_LABEL`].
//! - **The trace** ([`SSR_TRACE`], `shaders/screen/ssr_trace.wgsl`, half size): Godot 4.7.2's
//!   `screen_space_reflection.glsl` (MIT): Hi-Z tracing with parametric t, the geometric-normal
//!   bias, FidelityFX SSSR's hit validation, the screen-margin and distance fades; the reflected
//!   colour is last frame's colour pyramid (A.6) at the hit's reprojected point, at the mip the
//!   roughness cone spans. Godot's push constants are a uniform ([`GpuSsrParams`]) and its `r8`
//!   mip-level image (no core storage format) is gone: the trace samples that mip itself.
//! - **The resolve** ([`SSR_RESOLVE`]): Godot's bilateral upsample to the render size, its tone map
//!   undone. The result ([`REFLECTIONS_LABEL`], `rgba16float`) is the forward pass's
//!   `screen_reflections` at [`crate::screen_inputs::FRAME_REFLECTIONS_BINDING`] (owner decision D1:
//!   the forward stage's 16th sampled texture of 16): rgb the radiance times the confidence, a the
//!   confidence.
//! - **The hand-over** ([`SSR_APPLY`], `gx_ssr_apply`; [`apply`] is the twin): the probe or sky
//!   radiance times one minus the confidence plus the screen's, so where both agree the sum does
//!   not change with the confidence: no seam.
//!
//! On desktop `high` and `ultra` ([`SsrQuality`], `Quality::ssr`) with TAA (the colour pyramid is
//! TAA's output) on the HDR scene; off on phones, the web and every lower preset. [`twin`] is the
//! CPU twin of the trace and the resolve, texel for texel.

use glam::{Mat4, Vec2, Vec3, Vec4};
use wgpu::{BindGroup, BindGroupLayout, Buffer, BufferUsages, CommandEncoder, ComputePipeline, Device, Queue, Sampler, Texture, TextureFormat, TextureUsages, TextureView};

use crate::compile::Compiled;
use crate::error::{RenderCode, RenderError};
use crate::hiz::{HizInput, HizNode, HizReduce};
use crate::screen_inputs::ScreenInputs;
use crate::settings::Quality;
use crate::tables::{buffer, pipeline_layout};
use crate::target_pool::TargetDesc;

/// The parameters chunk both passes include.
pub const SSR_PARAMS: &str = include_str!("../shaders/screen/ssr_params.wgsl");
/// The trace pass (half the render size).
pub const SSR_TRACE: &str = crate::shaders::minify::shipped_wgsl!(concat!(
    include_str!("../shaders/effects.wgsl"),
    include_str!("../shaders/screen/normal_roughness_unpack.wgsl"),
    include_str!("../shaders/screen/ssr_params.wgsl"),
    include_str!("../shaders/screen/ssr_trace.wgsl")
));
/// The resolve pass (the render size).
pub const SSR_RESOLVE: &str = crate::shaders::minify::shipped_wgsl!(concat!(
    include_str!("../shaders/effects.wgsl"),
    include_str!("../shaders/screen/normal_roughness_unpack.wgsl"),
    include_str!("../shaders/screen/ssr_params.wgsl"),
    include_str!("../shaders/screen/ssr_resolve.wgsl")
));
/// The forward pass's hand-over chunk (`gx_ssr_apply`), no bindings of its own.
pub const SSR_APPLY: &str = include_str!("../shaders/screen/ssr_apply.wgsl");
/// The trace's entry point.
pub const TRACE_ENTRY: &str = "cs_ssr_trace";
/// The resolve's entry point.
pub const RESOLVE_ENTRY: &str = "cs_ssr_resolve";
/// Both passes' workgroup side (8 x 8 invocations).
pub const SSR_WORKGROUP: u32 = 8;

/// The nearest-depth Hi-Z's pool label.
pub const HIZ_LABEL: &str = "ssr hi-z";
/// The half-size trace's pool label.
pub const TRACE_LABEL: &str = "ssr trace";
/// The resolved reflections' pool label (binding 30's texture).
pub const REFLECTIONS_LABEL: &str = "screen reflections";
/// The trace's format: core storage, filterable.
pub const TRACE_FORMAT: TextureFormat = TextureFormat::Rgba16Float;
/// The usages of the trace and the reflections: written as storage, read as textures.
pub const SSR_USAGE: TextureUsages = TextureUsages::STORAGE_BINDING.union(TextureUsages::TEXTURE_BINDING);

/// The plan's cost at desktop `high` (half-size trace, Hi-Z, resolve), in milliseconds.
pub const SSR_MS_MAX_HIGH: f32 = 1.0;
/// The plan's cost at desktop `ultra`, in milliseconds.
pub const SSR_MS_MAX_ULTRA: f32 = 1.5;

/// Hi-Z steps a ray takes at `high` (Godot's default is 64).
pub const STEPS_HIGH: u32 = 48;
/// Hi-Z steps a ray takes at `ultra`.
pub const STEPS_ULTRA: u32 = 64;
/// How far behind a surface a ray still counts as hitting it, in view units (Godot's 0.2).
pub const DEPTH_TOLERANCE: f32 = 0.2;
/// The perceptual roughness from which nothing is traced (Godot's 0.7): the probes reflect it.
pub const ROUGHNESS_CUTOFF: f32 = 0.7;
/// The ray's screen length (uv units) from which a reflection fades out, by a smoothstep to nothing
/// at a full-screen ray. Godot's `pow(1 - len, 2)` halves a reflection that crosses a third of the
/// screen (a street's length from a wet road to a sign), and a smaller exponent meets zero at an
/// infinite slope, a visible edge (measured: a 0.10 confidence step between neighbouring pixels).
pub const FADE_START: f32 = 0.4;
/// The fade-in exponent over the ray's screen length (Godot's default 0.15).
pub const CURVE_FADE_IN: f32 = 0.15;

/// The reflections' quality: whether they run and how many Hi-Z steps a ray takes. A resource
/// knob (a uniform), the passes are the same at every setting.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct SsrQuality {
    /// Whether the reflections run.
    pub enabled: bool,
    /// Hi-Z steps per ray.
    pub steps: u32,
}

impl SsrQuality {
    /// No screen reflections (the probes and the sky reflect everything).
    pub const OFF: SsrQuality = SsrQuality { enabled: false, steps: 0 };
    /// Desktop `high`.
    pub const HIGH: SsrQuality = SsrQuality { enabled: true, steps: STEPS_HIGH };
    /// Desktop `ultra`.
    pub const ULTRA: SsrQuality = SsrQuality { enabled: true, steps: STEPS_ULTRA };

    /// The screen inputs the reflections ask for (A.6): the colour pyramid and the prepass's
    /// normal and roughness; none when off.
    pub const fn asks(self) -> ScreenInputs {
        if self.enabled { ScreenInputs::SSR } else { ScreenInputs::NONE }
    }
}

/// Whether a frame traces reflections: the knob is on and the inputs it reads are there (the HDR
/// scene with TAA, A.6's [`crate::screen_inputs::frame_inputs`]).
pub fn frame_ssr(quality: &Quality, hdr: bool) -> bool {
    let inputs = crate::screen_inputs::frame_inputs(quality, hdr, quality.ssr.asks());
    quality.ssr.enabled && inputs.history_pyramid && inputs.normal_roughness
}

/// The trace's size: half the render size, the nearest-depth Hi-Z's finest level.
pub const fn trace_size(render: (u32, u32)) -> (u32, u32) {
    crate::hiz::base_size(render)
}

/// The reduction that keeps the *nearest* depth of a frame drawn with `depth_reversed` (the cull's
/// [`crate::hiz::reduction`] keeps the farthest).
pub const fn hiz_reduce(depth_reversed: bool) -> HizReduce {
    if depth_reversed { HizReduce::Max } else { HizReduce::Min }
}

/// The targets the reflections hold at `render` size: the nearest-depth Hi-Z, the half-size trace
/// and the resolved reflections.
pub fn targets(render: (u32, u32)) -> Vec<TargetDesc> {
    let size = (render.0.max(1), render.1.max(1));
    let hiz = TargetDesc { label: HIZ_LABEL, ..crate::hiz::target(size) };
    let trace = TargetDesc { label: TRACE_LABEL, format: TRACE_FORMAT, usage: SSR_USAGE, samples: 1, size: trace_size(size), mips: 1, srgb_view: false };
    let format = crate::screen_inputs::REFLECTIONS_FORMAT;
    let reflections = TargetDesc { label: REFLECTIONS_LABEL, format, usage: SSR_USAGE, samples: 1, size, mips: 1, srgb_view: false };
    vec![hiz, trace, reflections]
}

/// The bytes [`targets`] hold (the ledger's rows for them).
pub fn target_bytes(render: (u32, u32)) -> u64 {
    targets(render).iter().map(TargetDesc::bytes).sum()
}

/// The CPU twin of `gx_ssr_apply`: prefiltered radiance `env` with screen texel `screen`
/// (premultiplied radiance, confidence) laid over.
pub fn apply(env: Vec3, screen: Vec4) -> Vec3 {
    let confidence = screen.w.clamp(0.0, 1.0);
    env * (1.0 - confidence) + screen.truncate().max(Vec3::ZERO)
}

// ---------------------------------------------------------------------------------------------
// Parameters

/// `SsrParams` (shaders/screen/ssr_params.wgsl): the camera, sizes and knobs of one frame.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, bytemuck::Pod, bytemuck::Zeroable)]
pub struct GpuSsrParams {
    /// The projection (jitter-free).
    pub proj: [[f32; 4]; 4],
    /// Its inverse.
    pub inv_proj: [[f32; 4]; 4],
    /// World to view.
    pub view: [[f32; 4]; 4],
    /// This frame's NDC to last frame's clip space.
    pub reprojection: [[f32; 4]; 4],
    /// Trace size, render size.
    pub size: [u32; 4],
    /// Steps, Hi-Z mips, reverse-Z, orthographic.
    pub knobs: [u32; 4],
    /// Depth tolerance, fade-out start, curve fade-in, roughness cutoff.
    pub tune: [f32; 4],
    /// The colour pyramid's last mip, radiance scale, unused, unused.
    pub extra: [f32; 4],
}

/// The camera and frame facts one trace needs.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SsrCamera {
    /// The jitter-free projection.
    pub proj: Mat4,
    /// World to view.
    pub view: Mat4,
    /// This frame's jitter-free view-projection.
    pub view_proj: Mat4,
    /// Last frame's jitter-free view-projection (this frame's on a history reset).
    pub prev_view_proj: Mat4,
    /// The depth convention.
    pub reversed: bool,
    /// An orthographic projection.
    pub orthographic: bool,
}

/// One frame's parameters at `render` size, reading a colour pyramid of `pyramid_mips` mips whose
/// colour is scaled by `radiance_scale` (last frame's exposure to this frame's; 1 when equal).
pub fn params(camera: &SsrCamera, quality: SsrQuality, render: (u32, u32), pyramid_mips: u32, radiance_scale: f32) -> GpuSsrParams {
    let trace = trace_size(render);
    let reprojection = camera.prev_view_proj * camera.view_proj.inverse();
    GpuSsrParams {
        proj: camera.proj.to_cols_array_2d(),
        inv_proj: camera.proj.inverse().to_cols_array_2d(),
        view: camera.view.to_cols_array_2d(),
        reprojection: reprojection.to_cols_array_2d(),
        size: [trace.0, trace.1, render.0, render.1],
        knobs: [quality.steps, crate::hiz::mip_count(trace), u32::from(camera.reversed), u32::from(camera.orthographic)],
        tune: [DEPTH_TOLERANCE, FADE_START, CURVE_FADE_IN, ROUGHNESS_CUTOFF],
        extra: [pyramid_mips.saturating_sub(1) as f32, radiance_scale, 0.0, 0.0],
    }
}

// ---------------------------------------------------------------------------------------------
// The node

/// What one frame's reflections read and write.
#[derive(Clone, Copy, Debug)]
pub struct SsrInput<'a> {
    /// The prepass depth (`Depth32Float`, single-sampled) at `render` size.
    pub depth: &'a TextureView,
    /// The prepass's normal and roughness (A.6) at `render` size.
    pub normal_roughness: &'a TextureView,
    /// Last frame's colour pyramid (A.6), every mip.
    pub history: &'a TextureView,
    /// The nearest-depth Hi-Z: a texture of [`targets`]' first row.
    pub hiz: &'a Texture,
    /// The trace: a texture of [`targets`]' second row.
    pub trace: &'a Texture,
    /// The reflections: a texture of [`targets`]' third row (binding 30's).
    pub reflections: &'a Texture,
    /// The render size.
    pub render: (u32, u32),
    /// The frame's parameters ([`params`]).
    pub params: GpuSsrParams,
    /// The depth convention (the Hi-Z keeps the nearest under it).
    pub reversed: bool,
}

/// What the cached bind groups were made for.
struct SsrKey {
    depth: TextureView,
    normal_roughness: TextureView,
    history: TextureView,
    hiz: Texture,
    trace: Texture,
    reflections: Texture,
}

impl SsrKey {
    fn of(input: &SsrInput<'_>) -> SsrKey {
        SsrKey {
            depth: input.depth.clone(),
            normal_roughness: input.normal_roughness.clone(),
            history: input.history.clone(),
            hiz: input.hiz.clone(),
            trace: input.trace.clone(),
            reflections: input.reflections.clone(),
        }
    }

    fn matches(&self, input: &SsrInput<'_>) -> bool {
        self.depth == *input.depth
            && self.normal_roughness == *input.normal_roughness
            && self.history == *input.history
            && self.hiz == *input.hiz
            && self.trace == *input.trace
            && self.reflections == *input.reflections
    }
}

/// The passes' timestamp writes (a cost row): the query set and the indices stamped at the trace's
/// beginning and the resolve's end (the Hi-Z build has its own row, `hiz::hiz_gpu_ms`).
#[derive(Clone, Copy, Debug)]
pub struct SsrStamps<'a> {
    /// The query set.
    pub set: &'a wgpu::QuerySet,
    /// Stamped at the trace's beginning.
    pub begin: Option<u32>,
    /// Stamped at the resolve's end.
    pub end: Option<u32>,
}

/// The reflections' passes (graph node 14b): the nearest-depth Hi-Z build, the trace and the
/// resolve, with their parameters and the bind groups of the current input.
pub struct SsrNode {
    hiz: HizNode,
    trace_layout: BindGroupLayout,
    resolve_layout: BindGroupLayout,
    trace: Compiled<ComputePipeline>,
    resolve: Compiled<ComputePipeline>,
    params: Buffer,
    sampler: Sampler,
    cached: Option<(SsrKey, [BindGroup; 2])>,
}

fn compute_entry(binding: u32, ty: wgpu::BindingType) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry { binding, visibility: wgpu::ShaderStages::COMPUTE, ty, count: None }
}

fn texture_entry(binding: u32, sample_type: wgpu::TextureSampleType) -> wgpu::BindGroupLayoutEntry {
    compute_entry(binding, wgpu::BindingType::Texture { sample_type, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false })
}

/// The entries both passes share: parameters, Hi-Z, depth, normal and roughness (0..=3), and the
/// `rgba16float` output at `out`.
fn shared_entries(out: u32) -> [wgpu::BindGroupLayoutEntry; 5] {
    let unfiltered = wgpu::TextureSampleType::Float { filterable: false };
    let size = wgpu::BufferSize::new(size_of::<GpuSsrParams>() as u64);
    let params = wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: size };
    let storage = wgpu::BindingType::StorageTexture { access: wgpu::StorageTextureAccess::WriteOnly, format: TRACE_FORMAT, view_dimension: wgpu::TextureViewDimension::D2 };
    [
        compute_entry(0, params),
        texture_entry(1, unfiltered),
        texture_entry(2, wgpu::TextureSampleType::Depth),
        texture_entry(3, unfiltered),
        compute_entry(out, storage),
    ]
}

/// The bind group entries both passes share ([`shared_entries`]'s), writing `target` at `out`.
fn shared_group_entries<'a>(params: &'a Buffer, hiz: &'a TextureView, input: &SsrInput<'a>, out: u32, target: &'a TextureView) -> Vec<wgpu::BindGroupEntry<'a>> {
    let view = wgpu::BindingResource::TextureView;
    vec![
        wgpu::BindGroupEntry { binding: 0, resource: params.as_entire_binding() },
        wgpu::BindGroupEntry { binding: 1, resource: view(hiz) },
        wgpu::BindGroupEntry { binding: 2, resource: view(input.depth) },
        wgpu::BindGroupEntry { binding: 3, resource: view(input.normal_roughness) },
        wgpu::BindGroupEntry { binding: out, resource: view(target) },
    ]
}

fn pipeline(device: &Device, layout: &BindGroupLayout, module: &wgpu::ShaderModule, entry: &str) -> Compiled<ComputePipeline> {
    crate::compile::compute_pipeline(device, &wgpu::ComputePipelineDescriptor {
        label: Some(entry),
        layout: Some(&pipeline_layout(device, entry, &[layout])),
        module,
        entry_point: Some(entry),
        compilation_options: Default::default(),
        cache: None,
    })
}

/// Targets that are not [`targets`]`(render)`'s rows.
fn check_targets(input: &SsrInput<'_>) -> Result<(), RenderError> {
    let rows = targets(input.render);
    let fits = |texture: &Texture, row: &TargetDesc| {
        let size = texture.size();
        (size.width, size.height) == row.size && texture.format() == row.format && texture.mip_level_count() == row.mips && texture.usage().contains(row.usage)
    };
    if fits(input.hiz, &rows[0]) && fits(input.trace, &rows[1]) && fits(input.reflections, &rows[2]) {
        return Ok(());
    }
    Err(RenderError::refused(RenderCode::TextureInvalid, format!("ssr targets that are not a {}x{} render's", input.render.0, input.render.1)))
}

impl SsrNode {
    /// The passes' pipelines, parameters and sampler.
    pub fn new(device: &Device) -> Result<SsrNode, RenderError> {
        let trace_module = crate::shaders::module(device, "ssr trace", SSR_TRACE)?;
        let resolve_module = crate::shaders::module(device, "ssr resolve", SSR_RESOLVE)?;
        let filtered = wgpu::TextureSampleType::Float { filterable: true };
        let mut trace_entries = shared_entries(6).to_vec();
        trace_entries.push(texture_entry(4, filtered));
        trace_entries.push(compute_entry(5, wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering)));
        let mut resolve_entries = shared_entries(5).to_vec();
        resolve_entries.push(texture_entry(4, wgpu::TextureSampleType::Float { filterable: false }));
        let trace_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("ssr trace"), entries: &trace_entries });
        let resolve_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("ssr resolve"), entries: &resolve_entries });
        let params = buffer(device, "ssr params", size_of::<GpuSsrParams>() as u64, BufferUsages::UNIFORM | BufferUsages::COPY_DST)?;
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("ssr history"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Linear,
            ..Default::default()
        });
        Ok(SsrNode {
            hiz: HizNode::new(device)?,
            trace: pipeline(device, &trace_layout, &trace_module, TRACE_ENTRY),
            resolve: pipeline(device, &resolve_layout, &resolve_module, RESOLVE_ENTRY),
            trace_layout,
            resolve_layout,
            params,
            sampler,
            cached: None,
        })
    }

    /// Record one frame's reflections: the nearest-depth Hi-Z, the trace and the resolve, three
    /// compute passes. Refused `texture-invalid` when a target is not [`targets`]`(render)`'s.
    pub fn encode(&mut self, device: &Device, queue: &Queue, encoder: &mut CommandEncoder, input: SsrInput<'_>, stamps: Option<SsrStamps<'_>>) -> Result<(), RenderError> {
        check_targets(&input)?;
        let hiz = HizInput { depth: input.depth, pyramid: input.hiz, render: input.render, reduce: hiz_reduce(input.reversed) };
        self.hiz.encode(device, queue, encoder, hiz)?;
        queue.write_buffer(&self.params, 0, bytemuck::bytes_of(&input.params));
        self.prepare(device, &input);
        let Some((_, groups)) = self.cached.as_ref() else { return Ok(()) };
        let trace = trace_size(input.render);
        let stamp = |index: Option<u32>, at_end: bool| {
            stamps.zip(index).map(|(s, index)| wgpu::ComputePassTimestampWrites {
                query_set: s.set,
                beginning_of_pass_write_index: (!at_end).then_some(index),
                end_of_pass_write_index: at_end.then_some(index),
            })
        };
        let timestamp_writes = stamp(stamps.and_then(|s| s.begin), false);
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("ssr trace"), timestamp_writes });
        pass.set_pipeline(&self.trace);
        pass.set_bind_group(0, &groups[0], &[]);
        pass.dispatch_workgroups(trace.0.div_ceil(SSR_WORKGROUP), trace.1.div_ceil(SSR_WORKGROUP), 1);
        drop(pass);
        let timestamp_writes = stamp(stamps.and_then(|s| s.end), true);
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("ssr resolve"), timestamp_writes });
        pass.set_pipeline(&self.resolve);
        pass.set_bind_group(0, &groups[1], &[]);
        pass.dispatch_workgroups(input.render.0.div_ceil(SSR_WORKGROUP), input.render.1.div_ceil(SSR_WORKGROUP), 1);
        Ok(())
    }

    /// Drop the cached bind groups (and the views and targets they hold).
    pub fn release(&mut self) {
        self.cached = None;
        self.hiz.release();
    }

    fn prepare(&mut self, device: &Device, input: &SsrInput<'_>) {
        if self.cached.as_ref().is_some_and(|(key, _)| key.matches(input)) {
            return;
        }
        let hiz = input.hiz.create_view(&Default::default());
        let trace = input.trace.create_view(&Default::default());
        let reflections = input.reflections.create_view(&Default::default());
        let view = wgpu::BindingResource::TextureView;
        let mut trace_entries = shared_group_entries(&self.params, &hiz, input, 6, &trace);
        trace_entries.push(wgpu::BindGroupEntry { binding: 4, resource: view(input.history) });
        trace_entries.push(wgpu::BindGroupEntry { binding: 5, resource: wgpu::BindingResource::Sampler(&self.sampler) });
        let mut resolve_entries = shared_group_entries(&self.params, &hiz, input, 5, &reflections);
        resolve_entries.push(wgpu::BindGroupEntry { binding: 4, resource: view(&trace) });
        let groups = [
            device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("ssr trace"), layout: &self.trace_layout, entries: &trace_entries }),
            device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("ssr resolve"), layout: &self.resolve_layout, entries: &resolve_entries }),
        ];
        self.cached = Some((SsrKey::of(input), groups));
    }
}

// ---------------------------------------------------------------------------------------------
// The passes on a supplied screen (tests, cost rows)

/// One mip of a supplied colour pyramid: its size and its texels, row by row.
pub type HistoryMip = ((u32, u32), Vec<[f32; 4]>);

/// A screen to trace: the render size, the device depth and A.6's packed normal and roughness per
/// render pixel, the colour pyramid's mips and the frame's parameters.
#[derive(Clone, Debug)]
pub struct SsrBench {
    /// The render size.
    pub render: (u32, u32),
    /// Device depth per pixel, row by row.
    pub depths: Vec<f32>,
    /// A.6's `rgba8unorm` normal and roughness texel per pixel, row by row.
    pub surface: Vec<[u8; 4]>,
    /// The colour pyramid: each mip's size and texels (stored as `rgba16float`).
    pub history: Vec<HistoryMip>,
    /// The parameters ([`params`]).
    pub params: GpuSsrParams,
    /// The depth convention.
    pub reversed: bool,
}

/// What [`ssr_run`] read back: the half-size trace and the resolved reflections, row by row.
#[derive(Clone, Debug, PartialEq)]
pub struct SsrBenchOut {
    /// The trace's texels.
    pub trace: Vec<[f32; 4]>,
    /// The reflections' texels (binding 30's).
    pub reflections: Vec<[f32; 4]>,
}

/// The bench's textures.
struct BenchTextures {
    depth: TextureView,
    normal_roughness: TextureView,
    history: TextureView,
    hiz: Texture,
    trace: Texture,
    reflections: Texture,
}

fn bench_texture(device: &Device, row: &TargetDesc, extra: TextureUsages) -> Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some(row.label),
        size: wgpu::Extent3d { width: row.size.0, height: row.size.1, depth_or_array_layers: 1 },
        mip_level_count: row.mips,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: row.format,
        usage: row.usage | extra,
        view_formats: &[],
    })
}

fn upload(gpu: &crate::Gpu, texture: &Texture, mip: u32, size: (u32, u32), bytes: &[u8], texel: u32) {
    let extent = wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 };
    let layout = wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(size.0 * texel), rows_per_image: Some(size.1) };
    let at = wgpu::TexelCopyTextureInfo { texture, mip_level: mip, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All };
    gpu.queue.write_texture(at, bytes, layout, extent);
}

fn bench_textures(gpu: &crate::Gpu, bench: &SsrBench) -> Result<BenchTextures, RenderError> {
    let device = &gpu.device;
    let depth = crate::hiz::DepthUpload::new(device)?.run(gpu, bench.render, &bench.depths)?;
    let nr_row = TargetDesc { label: "ssr bench normal roughness", format: crate::screen_inputs::NORMAL_ROUGHNESS_FORMAT, usage: TextureUsages::TEXTURE_BINDING, samples: 1, size: bench.render, mips: 1, srgb_view: false };
    let normal_roughness = bench_texture(device, &nr_row, TextureUsages::COPY_DST);
    upload(gpu, &normal_roughness, 0, bench.render, bytemuck::cast_slice(&bench.surface), 4);
    let first = bench.history.first().map_or((1, 1), |(size, _)| *size);
    let history_row = TargetDesc { label: "ssr bench history", format: crate::screen_inputs::PYRAMID_FORMAT, usage: TextureUsages::TEXTURE_BINDING, samples: 1, size: first, mips: bench.history.len() as u32, srgb_view: false };
    let history = bench_texture(device, &history_row, TextureUsages::COPY_DST);
    for (mip, (size, texels)) in bench.history.iter().enumerate() {
        let halves: Vec<u16> = texels.iter().flat_map(|t| t.map(crate::post::tonemap::f32_to_f16)).collect();
        upload(gpu, &history, mip as u32, *size, bytemuck::cast_slice(&halves), 8);
    }
    let rows = targets(bench.render);
    Ok(BenchTextures {
        depth: depth.create_view(&Default::default()),
        normal_roughness: normal_roughness.create_view(&Default::default()),
        history: history.create_view(&Default::default()),
        hiz: bench_texture(device, &rows[0], TextureUsages::empty()),
        trace: bench_texture(device, &rows[1], TextureUsages::COPY_SRC),
        reflections: bench_texture(device, &rows[2], TextureUsages::COPY_SRC),
    })
}

fn bench_input<'a>(bench: &SsrBench, textures: &'a BenchTextures) -> SsrInput<'a> {
    SsrInput {
        depth: &textures.depth,
        normal_roughness: &textures.normal_roughness,
        history: &textures.history,
        hiz: &textures.hiz,
        trace: &textures.trace,
        reflections: &textures.reflections,
        render: bench.render,
        params: bench.params,
        reversed: bench.reversed,
    }
}

/// An `rgba16float` texture read back as f32 texels, row by row.
fn read_rgba16f(gpu: &crate::Gpu, texture: &Texture) -> Result<Vec<[f32; 4]>, RenderError> {
    let size = texture.size();
    let padded = (size.width * 8).div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let bytes = u64::from(padded) * u64::from(size.height);
    let staging = buffer(&gpu.device, "ssr readback", bytes, BufferUsages::MAP_READ | BufferUsages::COPY_DST)?;
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("ssr readback") });
    encoder.copy_texture_to_buffer(
        texture.as_image_copy(),
        wgpu::TexelCopyBufferInfo { buffer: &staging, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(padded), rows_per_image: Some(size.height) } },
        wgpu::Extent3d { width: size.width, height: size.height, depth_or_array_layers: 1 },
    );
    gpu.queue.submit([encoder.finish()]);
    let data = crate::readback::map_read_blocking(gpu, &staging, bytes)?;
    let texel = |at: usize| std::array::from_fn(|c| crate::post::tonemap::f16_to_f32(u16::from_le_bytes([data[at + c * 2], data[at + c * 2 + 1]])));
    Ok((0..size.height).flat_map(|y| (0..size.width).map(move |x| (y * padded + x * 8) as usize)).map(texel).collect())
}

/// The trace and the reflections [`SsrNode`] makes of `bench`, read back. The way to check the
/// passes on the GPU without a frame.
pub fn ssr_run(gpu: &crate::Gpu, bench: &SsrBench) -> Result<SsrBenchOut, RenderError> {
    let textures = bench_textures(gpu, bench)?;
    let mut node = SsrNode::new(&gpu.device)?;
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("ssr bench") });
    node.encode(&gpu.device, &gpu.queue, &mut encoder, bench_input(bench, &textures), None)?;
    gpu.queue.submit([encoder.finish()]);
    Ok(SsrBenchOut { trace: read_rgba16f(gpu, &textures.trace)?, reflections: read_rgba16f(gpu, &textures.reflections)? })
}

/// Runs a cost sample records back to back (a lone run after an idle wait pays the GPU's wake-up).
pub const COST_RUNS_PER_SAMPLE: u32 = 16;

/// The GPU milliseconds of the node over `bench` (the Hi-Z build, the trace and the resolve), one
/// per sample of `samples`, each the mean of [`COST_RUNS_PER_SAMPLE`] runs recorded back to back
/// (stamped from the first trace's beginning to the last resolve's end, so the first run's Hi-Z
/// build is outside the span); None without `TIMESTAMP_QUERY`.
pub fn ssr_gpu_ms(gpu: &crate::Gpu, bench: &SsrBench, samples: u32) -> Result<Option<Vec<f32>>, RenderError> {
    let device = &gpu.device;
    if !device.features().contains(wgpu::Features::TIMESTAMP_QUERY) {
        return Ok(None);
    }
    let textures = bench_textures(gpu, bench)?;
    let mut node = SsrNode::new(device)?;
    let set = device.create_query_set(&wgpu::QuerySetDescriptor { label: Some("ssr cost"), ty: wgpu::QueryType::Timestamp, count: 2 });
    let resolve = buffer(device, "ssr cost resolve", 16, BufferUsages::QUERY_RESOLVE | BufferUsages::COPY_SRC)?;
    let period = gpu.queue.get_timestamp_period();
    let mut costs = Vec::with_capacity(samples as usize);
    for _ in 0..samples {
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("ssr cost") });
        for run in 0..COST_RUNS_PER_SAMPLE {
            let stamps = SsrStamps { set: &set, begin: (run == 0).then_some(0), end: (run + 1 == COST_RUNS_PER_SAMPLE).then_some(1) };
            node.encode(device, &gpu.queue, &mut encoder, bench_input(bench, &textures), Some(stamps))?;
        }
        gpu.queue.submit([encoder.finish()]);
        device.poll(wgpu::PollType::wait_indefinitely()).map_err(|error| crate::readback::capture_failed(format!("poll: {error}")))?;
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("ssr cost resolve") });
        encoder.resolve_query_set(&set, 0..2, &resolve, 0);
        gpu.queue.submit([encoder.finish()]);
        let staging = crate::readback::stage_buffer(gpu, &resolve, 0, 16)?;
        let data = crate::readback::map_read_blocking(gpu, &staging, 16)?;
        let ticks: [u64; 2] = std::array::from_fn(|i| u64::from_le_bytes(data[i * 8..i * 8 + 8].try_into().expect("8 bytes")));
        if let Some(ms) = crate::timing::span_ms(ticks[0], ticks[1], period) {
            costs.push(ms / COST_RUNS_PER_SAMPLE as f32);
        }
    }
    Ok(Some(costs))
}

// ---------------------------------------------------------------------------------------------
// The CPU twin

pub mod twin {
    //! The CPU twin of the trace and the resolve, texel for texel (f32, the shaders' order).

    use super::{GpuSsrParams, Mat4, Vec2, Vec3, Vec4};
    use crate::hiz::HizLevel;

    const LUMA: Vec3 = Vec3::new(0.2126, 0.7152, 0.0722);
    const FAR: f32 = 1e30;
    const DEPTH_FACTOR: f32 = 2048.0;
    const NORMAL_FACTOR: f32 = 32.0;
    const ROUGHNESS_FACTOR: f32 = 16.0;

    /// One mip of the colour pyramid as the twin reads it: its size and texels, row by row.
    pub type Mip = ((u32, u32), Vec<Vec4>);

    /// One frame's screen as the passes read it.
    #[derive(Clone, Debug)]
    pub struct Screen<'a> {
        /// The parameters.
        pub params: &'a GpuSsrParams,
        /// The nearest-depth Hi-Z, every level.
        pub hiz: &'a [HizLevel],
        /// Device depth per render pixel, row by row.
        pub depth: &'a [f32],
        /// The world normal and perceptual roughness per render pixel (as unpacked from A.6's
        /// texel), row by row.
        pub surface: &'a [Vec4],
        /// The colour pyramid: each mip's size and rgba texels, row by row.
        pub history: &'a [Mip],
    }

    struct Ray {
        t: f32,
        t_max: f32,
        origin: Vec3,
        dir: Vec3,
        reflected: Vec3,
    }

    fn mat(m: &[[f32; 4]; 4]) -> Mat4 {
        Mat4::from_cols_array_2d(m)
    }

    fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
        let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
        t * t * (3.0 - 2.0 * t)
    }

    fn step_of(dir: Vec2) -> Vec2 {
        Vec2::new(if dir.x < 0.0 { -1.0 } else { 1.0 }, if dir.y < 0.0 { -1.0 } else { 1.0 })
    }

    impl Screen<'_> {
        fn reversed(&self) -> bool {
            self.params.knobs[2] == 1
        }

        fn z(&self, depth: f32) -> f32 {
            if self.reversed() { depth } else { 1.0 - depth }
        }

        fn trace_size(&self) -> Vec2 {
            Vec2::new(self.params.size[0] as f32, self.params.size[1] as f32)
        }

        fn cells(&self, level: i32) -> Vec2 {
            let (w, h) = (self.params.size[0] as i32, self.params.size[1] as i32);
            Vec2::new((w >> level).max(1) as f32, (h >> level).max(1) as f32)
        }

        fn hiz_z(&self, cell: (i32, i32), level: i32) -> f32 {
            let mip = &self.hiz[level as usize];
            let x = cell.0.clamp(0, mip.size.0 as i32 - 1) as u32;
            let y = cell.1.clamp(0, mip.size.1 as i32 - 1) as u32;
            self.z(mip.at(x, y))
        }

        fn view_pos(&self, screen: Vec3) -> Vec3 {
            let p = mat(&self.params.inv_proj) * Vec4::new(screen.x * 2.0 - 1.0, 1.0 - screen.y * 2.0, self.z(screen.z), 1.0);
            p.truncate() / p.w
        }

        fn linearize(&self, z: f32) -> f32 {
            if z <= 0.0 {
                return -FAR;
            }
            let p = mat(&self.params.inv_proj) * Vec4::new(0.0, 0.0, self.z(z), 1.0);
            p.z / p.w
        }

        fn screen_pos(&self, pos: Vec3) -> Vec3 {
            let clip = mat(&self.params.proj) * pos.extend(1.0);
            let ndc = clip.truncate() / clip.w;
            Vec3::new(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5, self.z(ndc.z))
        }

        fn geometric_normal(&self, pixel: (i32, i32), z_c: f32, view_c: Vec3) -> Vec3 {
            let (x, y) = pixel;
            let h = Vec4::new(self.hiz_z((x - 1, y), 0), self.hiz_z((x - 2, y), 0), self.hiz_z((x + 1, y), 0), self.hiz_z((x + 2, y), 0));
            let v = Vec4::new(self.hiz_z((x, y - 1), 0), self.hiz_z((x, y - 2), 0), self.hiz_z((x, y + 1), 0), self.hiz_z((x, y + 2), 0));
            let he = ((2.0 * Vec2::new(h.x, h.z) - Vec2::new(h.y, h.w)) - Vec2::splat(z_c)).abs();
            let ve = ((2.0 * Vec2::new(v.x, v.z) - Vec2::new(v.y, v.w)) - Vec2::splat(z_c)).abs();
            let h_sign = if he.x < he.y { -1.0 } else { 1.0 };
            let v_sign = if ve.x < ve.y { -1.0 } else { 1.0 };
            let h_z = if h_sign < 0.0 { h.x } else { h.z };
            let v_z = if v_sign < 0.0 { v.x } else { v.z };
            let size = self.trace_size();
            let p = Vec2::new(x as f32 + 0.5, y as f32 + 0.5);
            let view_h = self.view_pos(((p + Vec2::new(h_sign, 0.0)) / size).extend(h_z));
            let view_v = self.view_pos(((p + Vec2::new(0.0, v_sign)) / size).extend(v_z));
            (v_sign * (view_v - view_c)).cross(h_sign * (view_h - view_c))
        }

        fn render(&self) -> (i32, i32) {
            (self.params.size[2] as i32, self.params.size[3] as i32)
        }

        fn full_index(&self, at: (i32, i32)) -> usize {
            let (w, h) = self.render();
            (at.1.clamp(0, h - 1) * w + at.0.clamp(0, w - 1)) as usize
        }

        /// The surface of the nearest of the four render pixels trace texel `pixel` covers.
        fn surface_at(&self, pixel: (i32, i32)) -> Vec4 {
            let mut best = self.full_index((pixel.0 * 2, pixel.1 * 2));
            let mut best_z = self.z(self.depth[best]);
            for i in 1..4 {
                let at = self.full_index((pixel.0 * 2 + (i & 1), pixel.1 * 2 + (i >> 1)));
                let z = self.z(self.depth[at]);
                if z > best_z {
                    best = at;
                    best_z = z;
                }
            }
            self.surface[best]
        }

        fn view_normal(&self, n: Vec3) -> Vec3 {
            (mat(&self.params.view) * n.extend(0.0)).truncate().normalize()
        }

        fn edge_t(origin: Vec2, dir: Vec2, cell: Vec2, step: Vec2, cells: Vec2) -> f32 {
            let next = cell + step.clamp(Vec2::ZERO, Vec2::ONE);
            let pos = next / cells + step * 0.000001;
            let t = (pos - origin) / dir;
            t.x.min(t.y)
        }

        fn ray(&self, pixel: (i32, i32), surface: Vec4) -> Ray {
            let size = self.trace_size();
            let mut screen = Vec3::new((pixel.0 as f32 + 0.5) / size.x, (pixel.1 as f32 + 0.5) / size.y, self.hiz_z(pixel, 0));
            let mut pos = self.view_pos(screen);
            let normal = self.view_normal(surface.truncate());
            let geom = self.geometric_normal(pixel, screen.z, pos).normalize();
            pos += geom * (1.0 - libm::powf(normal.dot(geom).clamp(0.0, 1.0), 8.0));
            screen = self.screen_pos(pos);
            let view_dir = if self.params.knobs[3] == 1 { Vec3::new(0.0, 0.0, -1.0) } else { pos.normalize() };
            let mut ray_dir = reflect(view_dir, normal).normalize();
            if ray_dir.dot(geom) < 0.0 {
                ray_dir = reflect(ray_dir, geom).normalize();
            }
            let mut end = pos + ray_dir;
            if end.z > 0.0 {
                end -= ray_dir / ray_dir.z * (end.z + 0.00001);
            }
            let screen_end = self.screen_pos(end);
            let dir = (screen_end - screen) / (screen_end.z - screen.z).abs();
            let t0 = (Vec2::ZERO - screen.truncate()) / dir.truncate();
            let t1 = (Vec2::ONE - screen.truncate()) / dir.truncate();
            let t2 = t0.max(t1);
            let step = step_of(dir.truncate());
            let t = Self::edge_t(screen.truncate(), dir.truncate(), (screen.truncate() * size).floor(), step, size);
            Ray { t, t_max: t2.x.min(t2.y), origin: screen, dir, reflected: ray_dir }
        }

        fn walk(&self, ray: &Ray) -> f32 {
            let facing_camera = ray.dir.z >= 0.0;
            let step = step_of(ray.dir.truncate());
            let mips = self.params.knobs[1] as i32;
            let (mut t, mut level, mut left) = (ray.t, 0i32, self.params.knobs[0] as i32);
            while level >= 0 && left > 0 && t < ray.t_max {
                let at = ray.origin + ray.dir * t;
                let cells = self.cells(level);
                let cell = (at.truncate() * cells).floor();
                let cell_z = self.hiz_z((cell.x as i32, cell.y as i32), level);
                let depth_t = (cell_z - ray.origin.z) * ray.dir.z;
                let edge_t = Self::edge_t(ray.origin.truncate(), ray.dir.truncate(), cell, step, cells);
                let mut hit = if facing_camera { t <= depth_t } else { depth_t <= edge_t };
                let mut offset = if hit { -1 } else { 1 };
                if level == 0 && (self.linearize(cell_z) - self.linearize(at.z)) > self.params.tune[0] {
                    hit = false;
                    offset = 0;
                }
                if !hit {
                    t = edge_t;
                } else if !facing_camera {
                    t = t.max(depth_t);
                }
                level = (level + offset).min(mips - 1);
                left -= 1;
            }
            t
        }

        fn validity(&self, ray: &Ray, t: f32, reprojected: Vec2) -> f32 {
            let size = self.trace_size();
            let at = ray.origin + ray.dir * t;
            let hit_pixel = ((at.x * size.x) as i32, (at.y * size.y) as i32);
            let hit_z = self.hiz_z(hit_pixel, 0);
            if t >= ray.t_max || hit_z == 0.0 {
                return 0.0;
            }
            let mut validity = 1.0;
            let travelled = (ray.dir.truncate() * t).abs();
            if travelled.x < 2.0 / size.x && travelled.y < 2.0 / size.y {
                let hit_normal = self.view_normal(self.surface_at(hit_pixel).truncate());
                if ray.reflected.dot(hit_normal) >= 0.0 {
                    validity = 0.0;
                }
            }
            let delta = (self.view_pos(at) - self.view_pos(Vec3::new(at.x, at.y, hit_z))).length();
            let confidence = 1.0 - smoothstep(0.0, self.params.tune[0], delta);
            validity *= (confidence * confidence).clamp(0.0, 1.0);
            let rp = reprojected * size;
            let margin = (size.x + size.y) * 0.05;
            let toward = Vec2::new(if rp.x < size.x * 0.5 { rp.x } else { size.x - rp.x }, if rp.y < size.y * 0.5 { rp.y } else { size.y - rp.y });
            let margin_blend = smoothstep(0.0, margin * margin, toward.x * toward.y);
            let ray_len = (ray.dir.truncate() * t).length();
            let fade_in_exp = self.params.tune[2];
            let fade_in = if fade_in_exp == 0.0 { 1.0 } else { libm::powf(ray_len.clamp(0.0, 1.0), fade_in_exp) };
            let fade_out = 1.0 - smoothstep(self.params.tune[1], 1.0, ray_len);
            let fade = if fade_in * fade_out > 0.999 { 1.0 } else { fade_in * fade_out };
            validity * fade * margin_blend
        }

        fn mip(&self, roughness: f32, ray_len: f32) -> f32 {
            let mut mip = 0.0;
            if roughness > 0.001 {
                let cone_angle = roughness.min(0.999) * core::f32::consts::PI * 0.5;
                let a = 2.0 * libm::tanf(cone_angle) * ray_len;
                let h = ray_len;
                let blur_radius = (a * ((a * a + 4.0 * h * h).sqrt() - a)) / (4.0 * h).max(1e-8);
                let size = self.trace_size();
                mip = libm::log2f(blur_radius * size.x.max(size.y) / 16.0 + 1.0).clamp(0.0, self.params.extra[0]);
            }
            mip * libm::powf((1.25 - ray_len).clamp(0.0, 1.0), 0.2)
        }

        fn reproject(&self, at: Vec3) -> Vec2 {
            let clip = mat(&self.params.reprojection) * Vec4::new(at.x * 2.0 - 1.0, 1.0 - at.y * 2.0, self.z(at.z), 1.0);
            let ndc = clip.truncate().truncate() / clip.w;
            Vec2::new(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5)
        }

        /// The colour pyramid at `uv`, trilinear with clamp-to-edge (the trace's sampler).
        pub fn sample_history(&self, uv: Vec2, mip: f32) -> Vec4 {
            let last = self.history.len().saturating_sub(1);
            let lower = (mip.floor().max(0.0) as usize).min(last);
            let upper = (lower + 1).min(last);
            let f = mip - lower as f32;
            let a = bilinear(&self.history[lower], uv);
            if f <= 0.0 || upper == lower {
                return a;
            }
            a.lerp(bilinear(&self.history[upper], uv), f)
        }

        /// The trace's texel at `pixel`: rgb the tone-mapped colour times the validity, a the validity.
        pub fn trace(&self, pixel: (i32, i32)) -> Vec4 {
            let z = self.hiz_z(pixel, 0);
            let surface = self.surface_at(pixel);
            if z == 0.0 || surface.w >= self.params.tune[3] {
                return Vec4::ZERO;
            }
            let ray = self.ray(pixel, surface);
            let t = self.walk(&ray);
            let at = ray.origin + ray.dir * t;
            let reprojected = self.reproject(at);
            let validity = self.validity(&ray, t, reprojected);
            if validity.is_nan() || validity <= 0.0 {
                return Vec4::ZERO;
            }
            let mip = self.mip(surface.w, (ray.dir.truncate() * t).length());
            let radiance = self.sample_history(reprojected, mip).truncate() * self.params.extra[1];
            let color = radiance.extend(1.0) * validity;
            let rgb = color.truncate() / (1.0 + color.truncate().dot(LUMA));
            rgb.extend(color.w)
        }

        /// Every trace texel, row by row.
        pub fn trace_all(&self) -> Vec<Vec4> {
            let (w, h) = (self.params.size[0] as i32, self.params.size[1] as i32);
            (0..h).flat_map(|y| (0..w).map(move |x| (x, y))).map(|p| self.trace(p)).collect()
        }

        /// The resolve's texel at render pixel `pixel` from the trace's texels `traced`.
        pub fn resolve(&self, traced: &[Vec4], pixel: (i32, i32)) -> Vec4 {
            let index = self.full_index(pixel);
            let depth = self.depth[index];
            let sky = if self.reversed() { 0.0 } else { 1.0 };
            if depth == sky {
                return Vec4::ZERO;
            }
            let surface = self.surface[index];
            let w = Vec2::new(((pixel.0 as f32 + 0.5) * 0.5).fract(), ((pixel.1 as f32 + 0.5) * 0.5).fract());
            let base = ((pixel.0 - 1) / 2, (pixel.1 - 1) / 2);
            let corners = [(0, 0, w.x * w.y), (1, 0, (1.0 - w.x) * w.y), (0, 1, w.x * (1.0 - w.y)), (1, 1, (1.0 - w.x) * (1.0 - w.y))];
            let (mut sum, mut total) = (Vec4::ZERO, 0.0);
            for (dx, dy, bilinear) in corners {
                let (cell, weight) = self.resolve_sample(depth, surface, (base.0 + dx, base.1 + dy));
                let weight = weight * bilinear;
                let c = traced[(cell.1 * self.params.size[0] as i32 + cell.0) as usize];
                let rgb = c.truncate() / (1.0 - c.truncate().dot(LUMA)).max(1e-4);
                sum += rgb.extend(c.w) * weight;
                total += weight;
            }
            if total > 0.0 { sum / total } else { Vec4::ZERO }
        }

        fn resolve_sample(&self, depth: f32, surface: Vec4, at: (i32, i32)) -> ((i32, i32), f32) {
            let (w, h) = (self.params.size[0] as i32, self.params.size[1] as i32);
            let cell = (at.0.clamp(0, w - 1), at.1.clamp(0, h - 1));
            let sample_depth = self.hiz[0].at(cell.0 as u32, cell.1 as u32);
            let (rw, rh) = self.render();
            let sample = self.surface[((cell.1 * 2).min(rh - 1) * rw + (cell.0 * 2).min(rw - 1)) as usize];
            let weight_depth = libm::expf(-(depth - sample_depth).abs() * DEPTH_FACTOR);
            let weight_normal = libm::expf(-(1.0 - surface.truncate().dot(sample.truncate())).clamp(0.0, 1.0) * NORMAL_FACTOR);
            let weight_roughness = libm::expf(-(surface.w - sample.w).abs() * ROUGHNESS_FACTOR);
            (cell, weight_depth * weight_normal * weight_roughness)
        }
    }

    fn reflect(d: Vec3, n: Vec3) -> Vec3 {
        d - 2.0 * n.dot(d) * n
    }

    fn bilinear(level: &Mip, uv: Vec2) -> Vec4 {
        let ((w, h), texels) = level;
        let p = uv * Vec2::new(*w as f32, *h as f32) - Vec2::splat(0.5);
        let base = p.floor();
        let f = p - base;
        let at = |x: f32, y: f32| {
            let xi = (x as i32).clamp(0, *w as i32 - 1) as u32;
            let yi = (y as i32).clamp(0, *h as i32 - 1) as u32;
            texels[(yi * w + xi) as usize]
        };
        let top = at(base.x, base.y).lerp(at(base.x + 1.0, base.y), f.x);
        let bottom = at(base.x, base.y + 1.0).lerp(at(base.x + 1.0, base.y + 1.0), f.x);
        top.lerp(bottom, f.y)
    }
}
