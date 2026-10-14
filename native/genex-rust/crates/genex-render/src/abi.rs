//! The published GPU ABI (plan §2.1 principle 4, §2.9): what game code binds, frozen per API
//! version, apart from the renderer's internal structs.
//!
//! - **v1 frame:** [`GxFrameV1`] is the byte layout `GpuFrame` had when custom passes shipped
//!   (`GxFrame` in [`crate::custom_pass::TABLES_WGSL`]). v1 custom passes bind a [`CompatFrame`]
//!   uniform buffer refreshed every frame instead of the renderer's own frame uniforms, so
//!   `GpuFrame` may change from RQ1 on while every v1 pass keeps reading these bytes.
//! - **rows:** [`GxInstanceV1`] and [`GxMaterialV1`] *are* the renderer's instance and material
//!   rows, frozen forever: new per-row data goes into parallel tables indexed by the same row.
//!   tests/abi.rs and tests/layout.rs hold all three to their sizes and to naga's layout of the
//!   published WGSL.
//! - **inputs:** [`RenderInputs`] is what a Level-3 pass asks the frame graph to produce for it.
//! - **v2 (RQ1.0):** [`GxFrameV2`] (the whole frame: matrices incl. previous and inverse, jitter,
//!   pre-exposure, depth convention, sizes, time, sun, fog, cascades), [`GxDrawV2`], [`GxPostV2`],
//!   [`GxEnvSh`] and [`GxMaterialExt`], and the reserved v2 bind-group map
//!   ([`MATERIAL_V2_BINDINGS`], [`POST_V2_BINDINGS`]): group 0 the renderer's, group 1 the draw,
//!   group 2 the game's ([`GAME_GROUP`]: one uniform, up to [`GAME_TEXTURES_MAX`] textures and
//!   [`GAME_SAMPLERS_MAX`] samplers from asset handles), group 3 reserved for later APIs. Every
//!   binding exists from RQ1.0 on; one whose producer has not landed is bound to a 1x1 neutral
//!   resource ([`NeutralInputs`]), so a v2 source written today keeps working as tiers land. The
//!   v2 layout may still gain bindings inside the reserved map until RX.5 freezes it for release.
//!
//! A version never changes once released.

use crate::compile::Compiled;
use std::mem::offset_of;

use bytemuck::{Pod, Zeroable};
use wgpu::{BindGroupLayoutEntry, BindingType, Buffer, BufferUsages, CommandEncoder, Device, Queue, ShaderStages};

use crate::layout::{GpuFrame, GpuInstance, GpuLight, GpuMaterial, SHADOW_CASCADES};

/// The bind-layout version of the v1 custom-pass tables and the v1 extension preludes.
pub const ABI_V1: u32 = 1;
/// The bind-layout version of the v2 preludes, tables and group map (RQ1).
pub const ABI_V2: u32 = 2;
/// The highest WGSL extension API served (`gfx.material`, `gfx.post_pass`), recorded in the
/// capability receipt (`extensionApi`). Equal to the host's `NATIVE_EXTENSION_API_VERSION`.
pub const EXTENSION_API_VERSION: u32 = ABI_V2;
/// Every extension API served, ascending (the receipt's `extensionApis`): v1 sources keep loading.
pub const EXTENSION_APIS: [u32; 2] = [ABI_V1, ABI_V2];
/// The highest custom-pass API served (`customPassApi`): genex-studio's `CUSTOM_PASS_API_VERSION`
/// and the host's `NATIVE_CUSTOM_PASS_API_VERSION`.
pub const CUSTOM_PASS_API_VERSION: u32 = ABI_V2;
/// Every custom-pass API served, ascending (`customPassApis`).
pub const CUSTOM_PASS_APIS: [u32; 2] = [ABI_V1, ABI_V2];
/// The custom-pass stage ids in vocabulary order (the host's `CustomPassStage`): stages are
/// appended, never renamed, and every one is served. `post-hdr` (API v2) runs after TAA's place and
/// before bloom and the tonemap, on the linear HDR scene at render size (graph node 18);
/// `after-prepass` (API v2, RQ4) runs after the depth/normal prepass and before AO and the world
/// pass, reading the prepass's depth and normals (graph node 9).
pub const CUSTOM_PASS_STAGES: [&str; 6] = ["before-cull", "after-opaque", "after-transparent", "post", "post-hdr", "after-prepass"];
/// Bytes of [`GxFrameV1`] (`GxFrame` in the v1 tables).
pub const GX_FRAME_V1_BYTES: u64 = 416;
/// Bytes of [`GxInstanceV1`] (`GxInstance`).
pub const GX_INSTANCE_V1_BYTES: u64 = 160;
/// Bytes of [`GxMaterialV1`] (`GxMaterial`).
pub const GX_MATERIAL_V1_BYTES: u64 = 48;
/// Cascades the v1 frame carries (`cascade_view_proj`), whatever the renderer draws.
pub const GX_FRAME_V1_CASCADES: usize = 2;

/// An instance row as v1 game code reads it: the renderer's row, frozen.
pub type GxInstanceV1 = GpuInstance;
/// A material row as v1 game code reads it: the renderer's row, frozen.
pub type GxMaterialV1 = GpuMaterial;

const _: () = assert!(size_of::<GxFrameV1>() as u64 == GX_FRAME_V1_BYTES);
const _: () = assert!(size_of::<GxInstanceV1>() as u64 == GX_INSTANCE_V1_BYTES);
const _: () = assert!(size_of::<GxMaterialV1>() as u64 == GX_MATERIAL_V1_BYTES);
// `CompatFrame::refresh` copies the v1 prefix of the renderer's frame uniforms (tests/abi.rs
// holds the bytes equal); RQ1 remaps it, or switches to `CompatFrame::write`, when `GpuFrame` changes.
const _: () = assert!(size_of::<GpuFrame>() >= size_of::<GxFrameV1>());
const _: () = assert!(SHADOW_CASCADES == GX_FRAME_V1_CASCADES);

/// The v1 frame uniforms (`GxFrame` in the v1 custom-pass tables): today's `GpuFrame` bytes.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GxFrameV1 {
    /// Projection × view, column-major.
    pub view_proj: [f32; 16],
    /// Camera position (xyz).
    pub camera_pos: [f32; 4],
    /// Unit view direction (xyz).
    pub camera_forward: [f32; 4],
    /// Direction towards the sun (xyz, unit).
    pub sun_dir: [f32; 4],
    /// Sun radiance (linear rgb, intensity folded in).
    pub sun_color: [f32; 4],
    /// Ambient radiance (linear rgb).
    pub ambient: [f32; 4],
    /// Inward frustum planes: left, right, bottom, top, near, far.
    pub planes: [[f32; 4]; 6],
    /// Light projection × view of each of the two cascades, column-major.
    pub cascade_view_proj: [[f32; 16]; GX_FRAME_V1_CASCADES],
    /// x, y: where cascades 0 and 1 end in view depth; z: 0 (unused in v1); w: 1 when the sun
    /// casts shadows.
    pub cascade_splits: [f32; 4],
    /// x: depth bias; y, z: normal offsets; w: one shadow texel in uv.
    pub shadow_params: [f32; 4],
    /// x: point lights; y: batches; z: cull views; w: visible-list rows per view.
    pub counts: [u32; 4],
}

/// The 16-byte row of `cascade_splits` in the frame (`z` is the renderer's pre-exposure lane,
/// which v1 reads as 0).
const CASCADE_SPLITS_ROW: u32 = 23;
/// The 16-byte row of `sun_dir` in the frame (`w` is the sun's angular radius since RQ3, which v1
/// documents as unused and reads as 0).
const SUN_DIR_ROW: u32 = 6;

impl GxFrameV1 {
    /// The v1 frame of the renderer's frame uniforms (field for field, with the lanes the renderer
    /// grew into read as v1's unused 0: the pre-exposure `cascade_splits.z` and the sun's angular
    /// radius `sun_dir.w`).
    pub fn from_frame(frame: &GpuFrame) -> GxFrameV1 {
        let [x, y, z, _] = frame.sun_dir;
        GxFrameV1 {
            view_proj: frame.view_proj,
            camera_pos: frame.camera_pos,
            camera_forward: frame.camera_forward,
            sun_dir: [x, y, z, 0.0],
            sun_color: frame.sun_color,
            ambient: frame.ambient,
            planes: frame.planes,
            cascade_view_proj: frame.cascade_view_proj,
            cascade_splits: [frame.cascade_splits[0], frame.cascade_splits[1], 0.0, frame.cascade_splits[3]],
            shadow_params: frame.shadow_params,
            counts: frame.counts,
        }
    }

    /// Its bytes, as the compat buffer holds them.
    pub fn as_bytes(&self) -> &[u8] {
        bytemuck::bytes_of(self)
    }
}

/// The compute shader that refreshes the compat buffer from the renderer's frame uniforms on the
/// GPU: a copy of the v1 prefix (26 rows of 16 bytes), so nothing waits on the CPU-side frame,
/// with the lanes the renderer grew into zeroed (the pre-exposure `cascade_splits.z`, row 23, and
/// the sun's angular radius `sun_dir.w`, row 6): v1 reads them as their unused 0, as
/// [`GxFrameV1::from_frame`] does.
pub const COMPAT_FRAME_V1_WGSL: &str = "// genex compat frame v1: GpuFrame prefix -> GxFrameV1.
@group(0) @binding(0) var<uniform> gx_source: array<vec4<u32>, 26>;
@group(0) @binding(1) var<storage, read_write> gx_frame_v1: array<vec4<u32>, 26>;

@compute @workgroup_size(26)
fn gx_compat_frame(@builtin(local_invocation_index) row: u32) {
    var copied = gx_source[row];
    if row == 23u {
        copied.z = 0u;
    }
    if row == 6u {
        copied.w = 0u;
    }
    gx_frame_v1[row] = copied;
}
";
// The shader above zeroes rows 23 and 6: the frame's `cascade_splits` and `sun_dir`.
const _: () = assert!(offset_of!(GpuFrame, cascade_splits) == CASCADE_SPLITS_ROW as usize * 16);
const _: () = assert!(offset_of!(GpuFrame, sun_dir) == SUN_DIR_ROW as usize * 16);

/// Rows of 16 bytes [`COMPAT_FRAME_V1_WGSL`] copies.
const COMPAT_ROWS: u64 = GX_FRAME_V1_BYTES / 16;
const _: () = assert!(COMPAT_ROWS * 16 == GX_FRAME_V1_BYTES);

/// The compat uniform buffer v1 consumers bind instead of the renderer's frame uniforms, and the
/// pass that refreshes it each frame.
#[derive(Debug)]
pub struct CompatFrame {
    buffer: Buffer,
    layout: wgpu::BindGroupLayout,
    pipeline: Compiled<wgpu::ComputePipeline>,
}

fn compat_entry(binding: u32, ty: wgpu::BufferBindingType) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::Buffer { ty, has_dynamic_offset: false, min_binding_size: wgpu::BufferSize::new(GX_FRAME_V1_BYTES) },
        count: None,
    }
}

impl CompatFrame {
    /// The v1 frame buffer on `device` (a uniform, a storage target of the refresh and a copy
    /// destination) and its refresh pipeline.
    pub fn new(device: &Device) -> CompatFrame {
        let buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("gx frame v1"),
            size: GX_FRAME_V1_BYTES,
            usage: BufferUsages::UNIFORM | BufferUsages::STORAGE | BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("gx frame v1 refresh"),
            entries: &[
                compat_entry(0, wgpu::BufferBindingType::Uniform),
                compat_entry(1, wgpu::BufferBindingType::Storage { read_only: false }),
            ],
        });
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("gx frame v1 refresh"),
            source: wgpu::ShaderSource::Wgsl(COMPAT_FRAME_V1_WGSL.into()),
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("gx frame v1 refresh"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipeline = crate::compile::compute_pipeline(device, &wgpu::ComputePipelineDescriptor {
            label: Some("gx frame v1 refresh"),
            layout: Some(&pipeline_layout),
            module: &module,
            entry_point: Some("gx_compat_frame"),
            compilation_options: Default::default(),
            cache: None,
        });
        CompatFrame { buffer, layout, pipeline }
    }

    /// The buffer v1 bind groups take (binding size [`GX_FRAME_V1_BYTES`]).
    pub fn buffer(&self) -> &Buffer {
        &self.buffer
    }

    /// Write this frame's v1 bytes from the renderer's CPU-side frame.
    pub fn write(&self, queue: &Queue, frame: &GpuFrame) {
        queue.write_buffer(&self.buffer, 0, GxFrameV1::from_frame(frame).as_bytes());
    }

    /// Record the refresh from `frame_uniforms` (the renderer's frame uniforms, written for this
    /// frame) into `encoder`: work submitted after it reads this frame's v1 bytes.
    pub fn refresh(&self, device: &Device, encoder: &mut CommandEncoder, frame_uniforms: &Buffer) {
        let binding = |binding, buffer| wgpu::BindGroupEntry {
            binding,
            resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding { buffer, offset: 0, size: wgpu::BufferSize::new(GX_FRAME_V1_BYTES) }),
        };
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("gx frame v1 refresh"),
            layout: &self.layout,
            entries: &[binding(0, frame_uniforms), binding(1, &self.buffer)],
        });
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("gx frame v1 refresh"), timestamp_writes: None });
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(1, 1, 1);
    }
}

/// What a Level-3 pass asks the frame graph to produce for it (`GpuPass::inputs`): a set of
/// inputs, empty by default. The graph enables each input's producer (the prepass for depth,
/// normals and motion, the environment bake, the HDR scene target) when a pass declares it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct RenderInputs(u32);

impl RenderInputs {
    /// Nothing beyond the v1 tables.
    pub const NONE: RenderInputs = RenderInputs(0);
    /// The scene depth (sampleable, render size).
    pub const DEPTH: RenderInputs = RenderInputs(1);
    /// Octahedral view normals (`rg16float`).
    pub const NORMALS: RenderInputs = RenderInputs(1 << 1);
    /// Screen-space motion vectors (`rg16float`).
    pub const MOTION: RenderInputs = RenderInputs(1 << 2);
    /// The environment: specular cube, SH9 irradiance and the BRDF LUT.
    pub const ENVIRONMENT: RenderInputs = RenderInputs(1 << 3);
    /// The linear HDR scene colour before tonemapping.
    pub const HDR_SCENE: RenderInputs = RenderInputs(1 << 4);
    /// Every input.
    pub const ALL: RenderInputs = RenderInputs(0b1_1111);

    const NAMED: [(RenderInputs, &'static str); 5] = [
        (RenderInputs::DEPTH, "depth"),
        (RenderInputs::NORMALS, "normals"),
        (RenderInputs::MOTION, "motion"),
        (RenderInputs::ENVIRONMENT, "environment"),
        (RenderInputs::HDR_SCENE, "hdr-scene"),
    ];

    /// Whether no input is asked for.
    pub const fn is_empty(self) -> bool {
        self.0 == 0
    }

    /// Whether every input of `other` is asked for.
    pub const fn contains(self, other: RenderInputs) -> bool {
        self.0 & other.0 == other.0
    }

    /// Both sets.
    pub const fn union(self, other: RenderInputs) -> RenderInputs {
        RenderInputs(self.0 | other.0)
    }

    /// The single inputs asked for, in [`RenderInputs::ALL`]'s order.
    pub fn iter(self) -> impl Iterator<Item = RenderInputs> {
        RenderInputs::NAMED.into_iter().map(|(input, _)| input).filter(move |input| self.contains(*input))
    }

    /// The wire spelling of a single input (the receipt's `renderInputs`); `""` for a set.
    pub fn wire(self) -> &'static str {
        RenderInputs::NAMED.iter().find(|(input, _)| *input == self).map_or("", |(_, name)| name)
    }
}

impl std::ops::BitOr for RenderInputs {
    type Output = RenderInputs;

    fn bitor(self, other: RenderInputs) -> RenderInputs {
        self.union(other)
    }
}

// ---------------------------------------------------------------------------------------------
// v2 (RQ1.0)

/// Cascades the v2 frame carries (the most any preset draws, plan goal 3).
pub const GX_FRAME_V2_CASCADES: usize = 4;
/// Bytes of [`GxFrameV2`] (`GxFrameV2` in `shaders/common.wgsl`).
pub const GX_FRAME_V2_BYTES: u64 = 1008;
/// Where [`GxFrameV2::pre_exposure`] sits: the renderer copies the previous frame's exposure from
/// the GPU exposure buffer (`layout::GpuExposureState::exposure`, offset 0) to here with
/// `copy_buffer_to_buffer`, so no CPU ever reads it back.
pub const GX_FRAME_V2_PRE_EXPOSURE_OFFSET: u64 = offset_of!(GxFrameV2, pre_exposure) as u64;
const _: () = assert!(size_of::<GxFrameV2>() as u64 == GX_FRAME_V2_BYTES);
const _: () = assert!(GX_FRAME_V2_PRE_EXPOSURE_OFFSET.is_multiple_of(wgpu::COPY_BUFFER_ALIGNMENT));

/// The v2 frame uniforms (`GxFrameV2`): what v2 materials (`frame`), v2 post passes (`gx_frame`)
/// and v2 custom passes read. Its chunk-compatible members (`camera_pos` .. `counts`) carry the
/// meaning of the renderer's own frame, so the forward lighting chunks compile against it; the
/// rest is new in v2. Projections are jittered when TAA is on and reversed when
/// `depth_reversed` is 1; `unjittered_view_proj` and `prev_view_proj` feed motion vectors.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GxFrameV2 {
    /// World → view, column-major.
    pub view: [f32; 16],
    /// View → clip (jittered, reversed on the HDR path), column-major.
    pub proj: [f32; 16],
    /// `proj × view`.
    pub view_proj: [f32; 16],
    /// The inverse of `view_proj` (jittered under TAA, as the depth, normals and motion inputs are
    /// drawn): clip (and depth) back to world.
    pub inv_view_proj: [f32; 16],
    /// Last frame's unjittered `view_proj` (this frame's on a history reset).
    pub prev_view_proj: [f32; 16],
    /// This frame's `view_proj` without jitter.
    pub unjittered_view_proj: [f32; 16],
    /// Camera position (xyz).
    pub camera_pos: [f32; 4],
    /// Unit view direction (xyz).
    pub camera_forward: [f32; 4],
    /// Direction towards the sun (xyz, unit); w: its angular radius in radians.
    pub sun_dir: [f32; 4],
    /// Sun radiance (linear rgb, intensity folded in, relative scene units).
    pub sun_color: [f32; 4],
    /// Ambient radiance (linear rgb).
    pub ambient: [f32; 4],
    /// Inward frustum planes: left, right, bottom, top, near, far.
    pub planes: [[f32; 4]; 6],
    /// Light projection × view of each cascade, column-major (unused rows: identity).
    pub cascade_view_proj: [[f32; 16]; GX_FRAME_V2_CASCADES],
    /// The forward chunks' cascade facts: x, y where cascades 0 and 1 end; w 1 when the sun casts
    /// shadows.
    pub cascade_splits: [f32; 4],
    /// x: depth bias; y, z: normal offsets of cascades 0 and 1; w: one shadow texel in uv.
    pub shadow_params: [f32; 4],
    /// The view depth where each of cascades 0..3 ends (RQ3's cascades).
    pub cascade_ends: [f32; 4],
    /// The normal offset of each of cascades 0..3, world units.
    pub cascade_offsets: [f32; 4],
    /// x: point lights in the light table; y: cascades drawn; z: spot lights; w: reserved.
    pub counts: [u32; 4],
    /// Fog's in-scatter tint (linear rgb) and density (a); 0 density: no fog.
    pub fog_color: [f32; 4],
    /// x: height falloff; y: base height; z: start distance; w: largest opacity.
    pub fog_params: [f32; 4],
    /// This frame's sub-pixel jitter in clip units (0 without TAA).
    pub jitter: [f32; 2],
    /// Last frame's jitter in clip units (this frame's after a history reset).
    pub prev_jitter: [f32; 2],
    /// The scene's size in pixels (output × render scale).
    pub render_size: [f32; 2],
    /// The world target's size in pixels.
    pub output_size: [f32; 2],
    /// The exposure the scene is written with (the previous frame's): every scene writer
    /// multiplies radiance by it, so HDR targets hold exposed values that fit fp16. 1 on the
    /// legacy path.
    pub pre_exposure: f32,
    /// `1 / pre_exposure`.
    pub inv_pre_exposure: f32,
    /// The look's EV compensation.
    pub ev_compensation: f32,
    /// Simulated seconds.
    pub time: f32,
    /// Simulated seconds of one tick.
    pub delta_time: f32,
    /// The near plane's distance.
    pub near: f32,
    /// The far plane's distance (0: infinite).
    pub far: f32,
    /// Frames drawn since the last history reset (temporal sequences key to it).
    pub frame_index: u32,
    /// 1 when depth is reversed (`Greater`, cleared to 0: the HDR path), 0 for standard Z.
    pub depth_reversed: u32,
    /// 1 when the scene target is the legacy LDR world (sRGB-encoded `Bgra8Unorm`: the off path
    /// or an LDR-degraded frame), 0 for the linear pre-exposed HDR scene.
    pub scene_ldr: u32,
    /// The re-render's index within a settled capture (0 in Live).
    pub settle_index: u32,
    /// 1 on a frame whose temporal history starts over.
    pub history_reset: u32,
}

const IDENTITY: [f32; 16] = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];

impl GxFrameV2 {
    /// The v2 frame of the renderer's frame uniforms on the legacy path: the shared members copied
    /// (every drawn cascade's matrix, end and normal offset; identity rows past them), identity
    /// matrices for what the legacy frame does not hold, standard Z, the LDR scene and an exposure
    /// of 1.
    pub fn from_frame(frame: &GpuFrame) -> GxFrameV2 {
        let drawn = (frame.shadow_counts[0] as usize).min(GX_FRAME_V2_CASCADES);
        let mut cascades = [IDENTITY; GX_FRAME_V2_CASCADES];
        cascades[..drawn].copy_from_slice(&frame.cascade_matrices[..drawn]);
        let splits = frame.cascade_splits;
        GxFrameV2 {
            view: IDENTITY,
            proj: IDENTITY,
            view_proj: frame.view_proj,
            inv_view_proj: IDENTITY,
            prev_view_proj: frame.view_proj,
            unjittered_view_proj: frame.view_proj,
            camera_pos: frame.camera_pos,
            camera_forward: frame.camera_forward,
            sun_dir: frame.sun_dir,
            sun_color: frame.sun_color,
            ambient: frame.ambient,
            planes: frame.planes,
            cascade_view_proj: cascades,
            cascade_splits: splits,
            shadow_params: frame.shadow_params,
            cascade_ends: frame.cascade_ends,
            cascade_offsets: frame.cascade_offsets,
            counts: [frame.counts[0], drawn as u32, 0, 0],
            pre_exposure: 1.0,
            inv_pre_exposure: 1.0,
            scene_ldr: 1,
            ..GxFrameV2::default()
        }
    }

    /// Its bytes, as the uniform buffer holds them.
    pub fn as_bytes(&self) -> &[u8] {
        bytemuck::bytes_of(self)
    }
}

/// One v2 custom draw (`GxDrawV2`, group 1): its matrices this and last frame, its tint and
/// per-draw parameters.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GxDrawV2 {
    /// Model matrix, column-major.
    pub model: [f32; 16],
    /// Inverse-transpose of the model matrix (normals).
    pub normal: [f32; 16],
    /// Last frame's model matrix (motion vectors; this frame's on a history reset).
    pub prev_model: [f32; 16],
    /// The draw's tint, linear rgb and alpha (v1's was sRGB-encoded).
    pub tint: [f32; 4],
    /// x: simulated seconds; y: the draw's index in the frame; z, w: reserved.
    pub params: [f32; 4],
}

/// A v2 post pass's own uniforms (`GxPostV2`): the sizes it reads and writes at and the frame
/// facts it needs most. Everything else is in `gx_frame`.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GxPostV2 {
    /// The size of `gx_scene` in pixels (render size at stage `hdr`, output size at `ldr`).
    pub render_size: [f32; 2],
    /// The world target's size in pixels.
    pub output_size: [f32; 2],
    /// One pixel of `gx_scene` in uv.
    pub texel: [f32; 2],
    /// This frame's jitter in clip units (0 without TAA): the depth, normals and motion a post pass
    /// reads were drawn with it, though the scene it reads is TAA's resolve. A point projected
    /// through `gx_frame.unjittered_view_proj` reads them at its uv + `jitter * (0.5, -0.5)`.
    pub jitter: [f32; 2],
    /// Simulated seconds.
    pub time: f32,
    /// The pass's index in the frame.
    pub pass_index: u32,
    /// Frames drawn since the last history reset.
    pub frame_index: u32,
    /// 1 when depth is reversed.
    pub depth_reversed: u32,
    /// The exposure `gx_scene` was written with (1 at stage `ldr`).
    pub pre_exposure: f32,
    /// 1 at stage `hdr` (linear, pre-exposed scene), 0 at stage `ldr` (display-ready frame).
    pub stage_hdr: u32,
    /// Reserved.
    pub reserved0: u32,
    /// Reserved.
    pub reserved1: u32,
}

/// The environment's diffuse irradiance as 9 spherical-harmonic coefficients (`GxEnvSh`; rgb, a
/// unused). All zero until the environment bake lands (RQ2).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GxEnvSh {
    /// L0, L1 (3), L2 (5).
    pub coefficients: [[f32; 4]; 9],
}

/// A material row's v2 extension, parallel to the frozen material table (`GxMaterialExt`).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GxMaterialExt {
    /// Emissive radiance (linear rgb, scene units); a: reserved.
    pub emissive: [f32; 4],
    /// Reserved for later material inputs.
    pub params: [f32; 4],
}

/// A v2 struct's Rust layout and the WGSL struct it mirrors, member for member.
#[derive(Clone, Copy, Debug)]
pub struct V2Struct {
    /// The WGSL struct of the same layout.
    pub wgsl: &'static str,
    /// A [`crate::shaders::SHADERS`] entry that declares it.
    pub shader: &'static str,
    /// `size_of` the Rust struct.
    pub rust_size: usize,
    /// `align_of` the Rust struct.
    pub rust_align: usize,
    /// Each member's name and byte offset, in order (the WGSL member names).
    pub fields: &'static [(&'static str, usize)],
}

macro_rules! fields {
    ($ty:ty: $($field:ident),+ $(,)?) => {
        &[$((stringify!($field), offset_of!($ty, $field))),+]
    };
}

/// Every v2 struct and the WGSL struct it mirrors (tests/layout.rs holds each to naga's layout).
pub const V2_STRUCTS: &[V2Struct] = &[
    V2Struct {
        wgsl: "GxFrameV2",
        shader: "material-v2-sample",
        rust_size: size_of::<GxFrameV2>(),
        rust_align: align_of::<GxFrameV2>(),
        fields: fields!(GxFrameV2: view, proj, view_proj, inv_view_proj, prev_view_proj, unjittered_view_proj, camera_pos,
            camera_forward, sun_dir, sun_color, ambient, planes, cascade_view_proj, cascade_splits, shadow_params, cascade_ends,
            cascade_offsets, counts, fog_color, fog_params, jitter, prev_jitter, render_size, output_size, pre_exposure,
            inv_pre_exposure, ev_compensation, time, delta_time, near, far, frame_index, depth_reversed, scene_ldr,
            settle_index, history_reset),
    },
    V2Struct {
        wgsl: "GxDrawV2",
        shader: "material-v2-sample",
        rust_size: size_of::<GxDrawV2>(),
        rust_align: align_of::<GxDrawV2>(),
        fields: fields!(GxDrawV2: model, normal, prev_model, tint, params),
    },
    V2Struct {
        wgsl: "GxPostV2",
        shader: "post-v2-sample",
        rust_size: size_of::<GxPostV2>(),
        rust_align: align_of::<GxPostV2>(),
        fields: fields!(GxPostV2: render_size, output_size, texel, jitter, time, pass_index, frame_index, depth_reversed,
            pre_exposure, stage_hdr, reserved0, reserved1),
    },
    V2Struct {
        wgsl: "GxEnvSh",
        shader: "material-v2-sample",
        rust_size: size_of::<GxEnvSh>(),
        rust_align: align_of::<GxEnvSh>(),
        fields: fields!(GxEnvSh: coefficients),
    },
    V2Struct {
        wgsl: "GxMaterialExt",
        shader: "material-v2-sample",
        rust_size: size_of::<GxMaterialExt>(),
        rust_align: align_of::<GxMaterialExt>(),
        fields: fields!(GxMaterialExt: emissive, params),
    },
];

/// What one binding of the v2 map holds (WebGPU core binding types only: no binding arrays, no
/// storage textures in material or post stages).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum BindingKind {
    /// A uniform buffer.
    Uniform,
    /// A read-only storage buffer.
    Storage,
    /// `texture_2d<f32>` (filterable float).
    Texture2d,
    /// `texture_2d_array<f32>`.
    Texture2dArray,
    /// `texture_cube<f32>`.
    TextureCube,
    /// `texture_3d<f32>`.
    Texture3d,
    /// `texture_depth_2d`.
    Depth2d,
    /// `texture_depth_2d_array`.
    DepthArray,
    /// A filtering `sampler`.
    Sampler,
    /// A non-filtering `sampler` (point reads, depth).
    NonFilteringSampler,
    /// A `sampler_comparison`.
    ComparisonSampler,
}

impl BindingKind {
    /// The kind as WGSL declares it: a sampler's filtering is the layout's, not the shader's.
    pub const fn as_declared(self) -> BindingKind {
        match self {
            BindingKind::NonFilteringSampler => BindingKind::Sampler,
            other => other,
        }
    }

    /// The layout's binding type for this kind (`dynamic` for a per-draw uniform, `bytes` its
    /// smallest binding size).
    pub fn binding_type(self, dynamic: bool, bytes: u64) -> BindingType {
        use wgpu::{BufferBindingType, SamplerBindingType, TextureSampleType, TextureViewDimension};
        let texture = |sample_type, view_dimension| BindingType::Texture { sample_type, view_dimension, multisampled: false };
        let float = TextureSampleType::Float { filterable: true };
        let buffer = |ty| BindingType::Buffer { ty, has_dynamic_offset: dynamic, min_binding_size: wgpu::BufferSize::new(bytes) };
        match self {
            BindingKind::Uniform => buffer(BufferBindingType::Uniform),
            BindingKind::Storage => buffer(BufferBindingType::Storage { read_only: true }),
            BindingKind::Texture2d => texture(float, TextureViewDimension::D2),
            BindingKind::Texture2dArray => texture(float, TextureViewDimension::D2Array),
            BindingKind::TextureCube => texture(float, TextureViewDimension::Cube),
            BindingKind::Texture3d => texture(float, TextureViewDimension::D3),
            BindingKind::Depth2d => texture(TextureSampleType::Depth, TextureViewDimension::D2),
            BindingKind::DepthArray => texture(TextureSampleType::Depth, TextureViewDimension::D2Array),
            BindingKind::Sampler => BindingType::Sampler(SamplerBindingType::Filtering),
            BindingKind::NonFilteringSampler => BindingType::Sampler(SamplerBindingType::NonFiltering),
            BindingKind::ComparisonSampler => BindingType::Sampler(SamplerBindingType::Comparison),
        }
    }
}

/// What a 1x1 neutral resource holds until a binding's producer lands.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Neutral {
    /// Zero (black, no light, no motion; zeroed buffers).
    Zero,
    /// One (white: no occlusion, a full material layer).
    One,
    /// No in-scatter and full transmittance (aerial perspective: rgb 0, a 1).
    Clear,
    /// The split-sum BRDF LUT's identity (scale 1, bias 0: specular = F0).
    BrdfIdentity,
    /// Depth at the far plane (1 under standard Z, 0 reversed; the shadow array: lit).
    FarDepth,
    /// A sampler (nothing to fill).
    Sampler,
}

/// One binding of the v2 map.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct V2Binding {
    /// The bind group (0 renderer, 1 draw; 2 is the game's, 3 reserved).
    pub group: u32,
    /// The binding index.
    pub binding: u32,
    /// The WGSL name the prelude declares it under.
    pub name: &'static str,
    /// What it binds.
    pub kind: BindingKind,
    /// The stages that see it.
    pub visibility: ShaderStages,
    /// The smallest binding size of a buffer (a uniform's struct, one storage row); 0 otherwise.
    pub bytes: u64,
    /// Whether a uniform is bound at a dynamic offset (per draw).
    pub dynamic: bool,
    /// The frame input whose producer fills it ([`RenderInputs::NONE`]: the renderer always does).
    pub input: RenderInputs,
    /// What it holds until its producer lands.
    pub neutral: Neutral,
}

const FRAGMENT: ShaderStages = ShaderStages::FRAGMENT;
const BOTH: ShaderStages = ShaderStages::VERTEX_FRAGMENT;

const fn bind(group: u32, binding: u32, name: &'static str, kind: BindingKind, visibility: ShaderStages, neutral: Neutral) -> V2Binding {
    V2Binding { group, binding, name, kind, visibility, bytes: 0, dynamic: false, input: RenderInputs::NONE, neutral }
}

const fn buffer(group: u32, binding: u32, name: &'static str, kind: BindingKind, visibility: ShaderStages, bytes: usize) -> V2Binding {
    V2Binding { bytes: bytes as u64, ..bind(group, binding, name, kind, visibility, Neutral::Zero) }
}

const fn fed_by(row: V2Binding, input: RenderInputs) -> V2Binding {
    V2Binding { input, ..row }
}

/// The game's bind group in v2 materials and post passes: one uniform at binding 0, then up to
/// [`GAME_TEXTURES_MAX`] `texture_2d<f32>` and [`GAME_SAMPLERS_MAX`] samplers (asset handles).
pub const GAME_GROUP: u32 = 2;
/// Textures a v2 source may bind in [`GAME_GROUP`].
pub const GAME_TEXTURES_MAX: u32 = 4;
/// Samplers a v2 source may bind in [`GAME_GROUP`].
pub const GAME_SAMPLERS_MAX: u32 = 2;
/// Uniform buffers a v2 source may bind in [`GAME_GROUP`].
pub const GAME_UNIFORMS_MAX: u32 = 1;
/// Sampled textures a Level-2 v2 stage binds at most (groups 0-2), of core's 16.
pub const L2_V2_SAMPLED_TEXTURES_MAX: u32 = 12;
/// Samplers a Level-2 v2 stage binds at most, core's 16.
pub const L2_V2_SAMPLERS_MAX: u32 = 16;
/// Storage buffers a Level-2 v2 stage binds at most, core's 8.
pub const L2_V2_STORAGE_BUFFERS_MAX: u32 = 8;
/// Sampled textures the renderer's own forward fragment stage binds at most (its material arrays
/// included), of core's 16.
pub const FORWARD_FRAGMENT_TEXTURES_MAX: u32 = 14;
/// Texture arrays the forward pass may bind beyond group 0's two (the six material texture size
/// classes, `layout::FRAME_MATERIAL_CLASS_BINDINGS`); the slot a seventh would have taken went to
/// the v2 map's contact-shadow mask (RQ4 review).
pub const FORWARD_EXTRA_MATERIAL_ARRAYS_MAX: u32 = 6;

/// The v2 material map (`gfx.material` at api 2; `shaders/part2/material_v2.wgsl`). Group 0
/// carries the names the forward lighting chunks read, so `gx_shade_pbr` is the renderer's own
/// shading; group 1 is the draw.
pub const MATERIAL_V2_BINDINGS: &[V2Binding] = &[
    buffer(0, 0, "frame", BindingKind::Uniform, BOTH, size_of::<GxFrameV2>()),
    buffer(0, 1, "lights", BindingKind::Storage, FRAGMENT, size_of::<GpuLight>()),
    buffer(0, 2, "materials", BindingKind::Storage, FRAGMENT, size_of::<GpuMaterial>()),
    buffer(0, 3, "material_ext", BindingKind::Storage, FRAGMENT, size_of::<GxMaterialExt>()),
    bind(0, 4, "color_textures", BindingKind::Texture2dArray, FRAGMENT, Neutral::One),
    bind(0, 5, "data_textures", BindingKind::Texture2dArray, FRAGMENT, Neutral::One),
    bind(0, 6, "texture_sampler", BindingKind::Sampler, FRAGMENT, Neutral::Sampler),
    bind(0, 7, "shadow_map", BindingKind::DepthArray, FRAGMENT, Neutral::FarDepth),
    bind(0, 8, "shadow_sampler", BindingKind::ComparisonSampler, FRAGMENT, Neutral::Sampler),
    fed_by(bind(0, 9, "env_specular", BindingKind::TextureCube, FRAGMENT, Neutral::Zero), RenderInputs::ENVIRONMENT),
    fed_by(buffer(0, 10, "env_sh", BindingKind::Uniform, FRAGMENT, size_of::<GxEnvSh>()), RenderInputs::ENVIRONMENT),
    fed_by(bind(0, 11, "brdf_lut", BindingKind::Texture2d, FRAGMENT, Neutral::BrdfIdentity), RenderInputs::ENVIRONMENT),
    bind(0, 12, "env_sampler", BindingKind::Sampler, FRAGMENT, Neutral::Sampler),
    bind(0, 13, "ao_map", BindingKind::Texture2d, FRAGMENT, Neutral::One),
    bind(0, 14, "aerial_perspective", BindingKind::Texture3d, FRAGMENT, Neutral::Clear),
    bind(0, 15, "point_sampler", BindingKind::NonFilteringSampler, FRAGMENT, Neutral::Sampler),
    buffer(0, 16, "light_tiles", BindingKind::Storage, FRAGMENT, size_of::<u32>()),
    buffer(0, 17, "light_zbins", BindingKind::Storage, FRAGMENT, size_of::<u32>()),
    buffer(0, 18, "light_ext", BindingKind::Storage, FRAGMENT, size_of::<[f32; 4]>()),
    // The sun's contact-shadow mask (RQ4 review; render size, 1 = unshadowed): appended, so a
    // source that does not declare it builds against the map as before.
    bind(0, 19, "contact_shadow_mask", BindingKind::Texture2d, FRAGMENT, Neutral::One),
    V2Binding { dynamic: true, ..buffer(1, 0, "gx_draw", BindingKind::Uniform, BOTH, size_of::<GxDrawV2>()) },
];

/// The v2 post-pass map (`gfx.post_pass` at api 2; `shaders/part2/post_v2.wgsl`). Group 1 is
/// reserved (empty) for passes.
pub const POST_V2_BINDINGS: &[V2Binding] = &[
    fed_by(bind(0, 0, "gx_scene", BindingKind::Texture2d, FRAGMENT, Neutral::Zero), RenderInputs::HDR_SCENE),
    bind(0, 1, "gx_sampler", BindingKind::Sampler, FRAGMENT, Neutral::Sampler),
    buffer(0, 2, "gx_post", BindingKind::Uniform, FRAGMENT, size_of::<GxPostV2>()),
    buffer(0, 3, "gx_frame", BindingKind::Uniform, FRAGMENT, size_of::<GxFrameV2>()),
    fed_by(bind(0, 4, "gx_depth", BindingKind::Depth2d, FRAGMENT, Neutral::FarDepth), RenderInputs::DEPTH),
    fed_by(bind(0, 5, "gx_normals", BindingKind::Texture2d, FRAGMENT, Neutral::Zero), RenderInputs::NORMALS),
    fed_by(bind(0, 6, "gx_motion", BindingKind::Texture2d, FRAGMENT, Neutral::Zero), RenderInputs::MOTION),
    bind(0, 7, "gx_ao", BindingKind::Texture2d, FRAGMENT, Neutral::One),
    fed_by(bind(0, 8, "gx_env_specular", BindingKind::TextureCube, FRAGMENT, Neutral::Zero), RenderInputs::ENVIRONMENT),
    fed_by(buffer(0, 9, "gx_env_sh", BindingKind::Uniform, FRAGMENT, size_of::<GxEnvSh>()), RenderInputs::ENVIRONMENT),
    bind(0, 10, "gx_point_sampler", BindingKind::NonFilteringSampler, FRAGMENT, Neutral::Sampler),
];

/// The frame inputs the bindings named in `used` need produced (a v2 source's naga module decides
/// which bindings it uses; the graph enables those producers).
pub fn inputs_for(table: &[V2Binding], used: &[&str]) -> RenderInputs {
    table.iter().filter(|row| used.contains(&row.name)).fold(RenderInputs::NONE, |inputs, row| inputs.union(row.input))
}

/// The layout entries of `group` of a v2 map, in binding order.
pub fn layout_entries(table: &[V2Binding], group: u32) -> Vec<BindGroupLayoutEntry> {
    table
        .iter()
        .filter(|row| row.group == group)
        .map(|row| BindGroupLayoutEntry { binding: row.binding, visibility: row.visibility, ty: row.kind.binding_type(row.dynamic, row.bytes), count: None })
        .collect()
}

/// Bindings of one shader stage by WebGPU's per-stage limit classes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct StageCounts {
    /// Uniform buffers.
    pub uniform_buffers: u32,
    /// Storage buffers.
    pub storage_buffers: u32,
    /// Sampled textures.
    pub sampled_textures: u32,
    /// Samplers.
    pub samplers: u32,
}

impl StageCounts {
    /// Count one binding of `kind`.
    pub fn add(&mut self, kind: BindingKind) {
        match kind {
            BindingKind::Uniform => self.uniform_buffers += 1,
            BindingKind::Storage => self.storage_buffers += 1,
            BindingKind::Sampler | BindingKind::NonFilteringSampler | BindingKind::ComparisonSampler => self.samplers += 1,
            _ => self.sampled_textures += 1,
        }
    }

    /// The counts of every row of a v2 map (each visible to the fragment stage).
    pub fn of(table: &[V2Binding]) -> StageCounts {
        let mut counts = StageCounts::default();
        for row in table {
            counts.add(row.kind);
        }
        counts
    }

    /// The counts with the game's group at its largest added.
    pub fn with_game_group(self) -> StageCounts {
        StageCounts {
            uniform_buffers: self.uniform_buffers + GAME_UNIFORMS_MAX,
            sampled_textures: self.sampled_textures + GAME_TEXTURES_MAX,
            samplers: self.samplers + GAME_SAMPLERS_MAX,
            ..self
        }
    }
}

/// The 1x1 neutral resources bound in place of inputs whose producer has not landed (or is off
/// this frame), one per kind and value, created once per device.
#[derive(Debug)]
pub struct NeutralInputs {
    zero_2d: wgpu::TextureView,
    one_2d: wgpu::TextureView,
    brdf_2d: wgpu::TextureView,
    one_array: wgpu::TextureView,
    zero_cube: wgpu::TextureView,
    clear_3d: wgpu::TextureView,
    far_depth: [wgpu::TextureView; 2],
    shadow_array: wgpu::TextureView,
    filtering: wgpu::Sampler,
    non_filtering: wgpu::Sampler,
    comparison: wgpu::Sampler,
    uniform: Buffer,
    storage: Buffer,
}

/// Neutral texels as rgba8unorm.
const TEXEL_ZERO: [u8; 4] = [0, 0, 0, 0];
const TEXEL_ONE: [u8; 4] = [255, 255, 255, 255];
const TEXEL_CLEAR: [u8; 4] = [0, 0, 0, 255];
const TEXEL_BRDF: [u8; 4] = [255, 0, 0, 255];
/// Bytes of a neutral buffer: every row's smallest binding fits (the largest is the frame).
const NEUTRAL_BUFFER_BYTES: u64 = GX_FRAME_V2_BYTES;
const _: () = assert!(size_of::<GxEnvSh>() as u64 <= NEUTRAL_BUFFER_BYTES && size_of::<GxDrawV2>() as u64 <= NEUTRAL_BUFFER_BYTES);

fn neutral_texture(device: &Device, queue: &Queue, dimension: wgpu::TextureViewDimension, texel: [u8; 4]) -> wgpu::TextureView {
    let (layers, tex_dimension) = match dimension {
        wgpu::TextureViewDimension::Cube => (6, wgpu::TextureDimension::D2),
        wgpu::TextureViewDimension::D3 => (1, wgpu::TextureDimension::D3),
        _ => (1, wgpu::TextureDimension::D2),
    };
    let size = wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: layers };
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("gx neutral input"),
        size,
        mip_level_count: 1,
        sample_count: 1,
        dimension: tex_dimension,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    let texels: Vec<u8> = std::iter::repeat_n(texel, layers as usize).flatten().collect();
    queue.write_texture(
        texture.as_image_copy(),
        &texels,
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(4), rows_per_image: Some(1) },
        size,
    );
    texture.create_view(&wgpu::TextureViewDescriptor { dimension: Some(dimension), ..Default::default() })
}

/// A 1x1 `Depth32Float` texture (`layers` layers) cleared to `depth`, viewed as `dimension`.
fn neutral_depth(device: &Device, encoder: &mut CommandEncoder, depth: f32, dimension: wgpu::TextureViewDimension) -> wgpu::TextureView {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("gx neutral depth"),
        size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Depth32Float,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    });
    let target = texture.create_view(&wgpu::TextureViewDescriptor { dimension: Some(wgpu::TextureViewDimension::D2), ..Default::default() });
    encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: Some("gx neutral depth clear"),
        color_attachments: &[],
        depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
            view: &target,
            depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(depth), store: wgpu::StoreOp::Store }),
            stencil_ops: None,
        }),
        timestamp_writes: None,
        occlusion_query_set: None,
        multiview_mask: None,
    });
    texture.create_view(&wgpu::TextureViewDescriptor { dimension: Some(dimension), ..Default::default() })
}

fn neutral_sampler(device: &Device, filter: wgpu::FilterMode, compare: Option<wgpu::CompareFunction>) -> wgpu::Sampler {
    device.create_sampler(&wgpu::SamplerDescriptor {
        label: Some("gx neutral sampler"),
        mag_filter: filter,
        min_filter: filter,
        compare,
        ..Default::default()
    })
}

impl NeutralInputs {
    /// The neutral resources on `device` (their texels written and depths cleared on `queue`).
    pub fn new(device: &Device, queue: &Queue) -> NeutralInputs {
        use wgpu::TextureViewDimension as Dim;
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("gx neutral inputs") });
        let far_depth = [neutral_depth(device, &mut encoder, 1.0, Dim::D2), neutral_depth(device, &mut encoder, 0.0, Dim::D2)];
        let shadow_array = neutral_depth(device, &mut encoder, 1.0, Dim::D2Array);
        queue.submit([encoder.finish()]);
        let zeroed = |usage: BufferUsages| {
            device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("gx neutral buffer"),
                size: NEUTRAL_BUFFER_BYTES,
                usage: usage | BufferUsages::COPY_DST,
                mapped_at_creation: false,
            })
        };
        NeutralInputs {
            zero_2d: neutral_texture(device, queue, Dim::D2, TEXEL_ZERO),
            one_2d: neutral_texture(device, queue, Dim::D2, TEXEL_ONE),
            brdf_2d: neutral_texture(device, queue, Dim::D2, TEXEL_BRDF),
            one_array: neutral_texture(device, queue, Dim::D2Array, TEXEL_ONE),
            zero_cube: neutral_texture(device, queue, Dim::Cube, TEXEL_ZERO),
            clear_3d: neutral_texture(device, queue, Dim::D3, TEXEL_CLEAR),
            far_depth,
            shadow_array,
            filtering: neutral_sampler(device, wgpu::FilterMode::Linear, None),
            non_filtering: neutral_sampler(device, wgpu::FilterMode::Nearest, None),
            comparison: neutral_sampler(device, wgpu::FilterMode::Linear, Some(wgpu::CompareFunction::LessEqual)),
            uniform: zeroed(BufferUsages::UNIFORM),
            storage: zeroed(BufferUsages::STORAGE),
        }
    }

    /// The neutral resource of `row` (`depth_reversed` picks which far plane a depth input holds).
    pub fn resource(&self, row: &V2Binding, depth_reversed: bool) -> wgpu::BindingResource<'_> {
        use wgpu::BindingResource as R;
        let view = R::TextureView;
        match row.kind {
            BindingKind::Uniform | BindingKind::Storage => {
                let buffer = if row.kind == BindingKind::Uniform { &self.uniform } else { &self.storage };
                R::Buffer(wgpu::BufferBinding { buffer, offset: 0, size: wgpu::BufferSize::new(row.bytes) })
            }
            BindingKind::Texture2d => match row.neutral {
                Neutral::One => view(&self.one_2d),
                Neutral::BrdfIdentity => view(&self.brdf_2d),
                _ => view(&self.zero_2d),
            },
            BindingKind::Texture2dArray => view(&self.one_array),
            BindingKind::TextureCube => view(&self.zero_cube),
            BindingKind::Texture3d => view(&self.clear_3d),
            BindingKind::Depth2d => view(&self.far_depth[usize::from(depth_reversed)]),
            BindingKind::DepthArray => view(&self.shadow_array),
            BindingKind::Sampler => R::Sampler(&self.filtering),
            BindingKind::NonFilteringSampler => R::Sampler(&self.non_filtering),
            BindingKind::ComparisonSampler => R::Sampler(&self.comparison),
        }
    }

    /// A bind group of `group` of `table` holding only neutral resources (standard Z).
    pub fn bind_group(&self, device: &Device, table: &[V2Binding], group: u32, layout: &wgpu::BindGroupLayout) -> wgpu::BindGroup {
        let entries: Vec<wgpu::BindGroupEntry<'_>> = table
            .iter()
            .filter(|row| row.group == group)
            .map(|row| wgpu::BindGroupEntry { binding: row.binding, resource: self.resource(row, false) })
            .collect();
        device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("gx neutral inputs"), layout, entries: &entries })
    }
}
