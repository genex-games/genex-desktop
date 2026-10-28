//! Froxel volumetric fog and sun shafts (renderer pass 2 A.5; plan's prior art A5a): the height fog
//! as a lit volume over the view frustum, so the sun's shadows carve shafts out of it and local
//! lights glow in it, on desktop and web `high` and `ultra` ([`crate::settings::EnvironmentQuality::froxel_fog`]).
//!
//! Ported from Godot Engine 4.7.2's `volumetric_fog_process.glsl` (MIT; THIRD-PARTY-NOTICES.md),
//! structured after Wronski 2014 and Hillaire 2015 (`shaders/sky/froxel_fog.wgsl` lists the
//! deviations). Graph node 11 runs it after the sky's aerial perspective, in one compute pass of two
//! dispatches:
//!
//! - **inject** (4 x 4 x 4 workgroups, one thread a froxel): the fog's extinction across the slice
//!   (the fog chunk's closed form, so an unshadowed volume is exactly the analytic fog) and the light
//!   it scatters towards the camera (the chunk's in-scatter with the sun's lobe shadowed by its
//!   cascades, plus the binned local lights), blended with last frame's volume at the same world
//!   point ([`HISTORY_WEIGHT`], sampled at a Halton jitter inside the froxel, [`HALTON`]);
//! - **integrate** (8 x 8, one thread a column): front to back, each slice adding `(T_before -
//!   T_after) × light` with the transmittance held to the fog's `max_opacity`, and the aerial volume
//!   folded in behind the fog at each slice's centre.
//!
//! The result is an air volume in the aerial perspective's split layout and slice mapping
//! ([`crate::fog::AIR_HALVES`], [`crate::fog::aerial_slice_distance`]), bound in its place at the
//! forward pass's `aerial_perspective` slot (b17, 0 new forward bindings): its in-scatter's alpha 1
//! says the height fog is in it, so the forward pass, the Level-2 v2 prelude and the particles skip
//! the analytic fog (`gx_air_holds_fog`). Transparents and particles are fogged by the same lookup.
//! The sky background keeps its analytic fog: the volume's far slices are the same fog, so the
//! horizon is one colour on geometry and on the sky.
//!
//! History: one per renderer, keyed to the frame's history set and frame index. A frame that does
//! not follow the last one (index 0 of a reset, a settled capture's re-render, a cut, a history-set
//! switch) starts over: no history, every froxel sampled at its centre, so a settled capture is the
//! same bytes every time.

use bytemuck::{Pod, Zeroable};
use wgpu::{BindGroupLayout, BindGroupLayoutEntry, BindingType, Buffer, ComputePipeline, Device, Queue, Sampler, ShaderStages, Texture, TextureView};

use crate::compile::Compiled;
use crate::error::RenderError;
use crate::fog::GpuFog;
use crate::graph::PassCounters;
use crate::settings::{Fog, Quality};

/// Whether graph node 11 runs the froxel fog where the quality and the look ask for it.
pub const LANDED: bool = true;

/// The froxel fog's shader: the common structs, the fog row, the fog chunk (its closed form and
/// in-scatter, the air volumes' slice mapping and lookup) and the two kernels.
pub const FROXEL_FOG: &str = crate::shaders::minify::shipped_wgsl!(concat!(
    include_str!("../shaders/common.wgsl"),
    include_str!("../shaders/effects.wgsl"),
    include_str!("../shaders/lighting/fog.wgsl"),
    include_str!("../shaders/sky/froxel_fog.wgsl")
));
/// The inject kernel's entry point.
pub const INJECT_ENTRY: &str = "cs_froxel_inject";
/// The integrate kernel's entry point.
pub const INTEGRATE_ENTRY: &str = "cs_froxel_integrate";

/// The volumes' format: `rgba16float`, write-only storage in compute (core).
pub const FROXEL_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba16Float;
/// Bytes of one texel.
const TEXEL_BYTES: u64 = 8;
/// The inject kernel's workgroup side (4 x 4 x 4).
const INJECT_GROUP: u32 = 4;
/// The integrate kernel's workgroup side (8 x 8 x 1).
const INTEGRATE_GROUP: u32 = 8;

/// How much of last frame's volume a froxel keeps where it reprojects (Godot's
/// `volumetric_fog_temporal_reprojection_amount` default 0.9).
pub const HISTORY_WEIGHT: f32 = 0.9;

/// The jitter inside a froxel per frame (Godot's `halton_map`: Halton bases 2, 3 and 5), cycled
/// by the frame index.
pub const HALTON: [[f32; 3]; 16] = [
    [0.5, 0.333_333_33, 0.2],
    [0.25, 0.666_666_7, 0.4],
    [0.75, 0.111_111_11, 0.6],
    [0.125, 0.444_444_44, 0.8],
    [0.625, 0.777_777_8, 0.04],
    [0.375, 0.222_222_22, 0.24],
    [0.875, 0.555_555_6, 0.44],
    [0.0625, 0.888_888_9, 0.64],
    [0.5625, 0.037_037_04, 0.84],
    [0.3125, 0.370_370_37, 0.08],
    [0.8125, 0.703_703_7, 0.28],
    [0.1875, 0.148_148_15, 0.48],
    [0.6875, 0.481_481_5, 0.68],
    [0.4375, 0.814_814_8, 0.88],
    [0.9375, 0.259_259_26, 0.12],
    [0.031_25, 0.592_592_6, 0.32],
];
/// A froxel's centre: the sample of a frame without history.
const CENTRE: [f32; 3] = [0.5; 3];

/// The froxel grid: froxels across and down the screen and slices along the rays.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct FroxelGrid {
    /// Froxels across.
    pub width: u16,
    /// Froxels down.
    pub height: u16,
    /// Slices along each ray (the air volumes' slice mapping, out to `fog::AERIAL_RANGE`).
    pub slices: u16,
}

/// `high`'s grid (plan A.5: at most 0.8 ms): 14.5 MB, so desktop-high's default with its texture
/// arrays stays within its 512 MiB at 1440p (128 x 72 took it 2.8 MB over).
pub const HIGH_GRID: FroxelGrid = FroxelGrid { width: 112, height: 63, slices: 64 };
/// `ultra`'s grid (plan A.5: 160 x 90 x 64 at most 1.2 ms).
pub const ULTRA_GRID: FroxelGrid = FroxelGrid { width: 160, height: 90, slices: 64 };

impl FroxelGrid {
    /// Froxels in the grid.
    pub const fn froxels(self) -> u64 {
        self.width as u64 * self.height as u64 * self.slices as u64
    }

    /// Bytes the fog holds: two injected volumes (this frame's and the history) and the result,
    /// whose two halves are the in-scatter and the transmittance.
    pub const fn bytes(self) -> u64 {
        self.froxels() * TEXEL_BYTES * (2 + crate::fog::AIR_HALVES as u64)
    }
}

/// The grid the froxel fog draws for `fog` under `quality`: the quality's (its fog switch on), the
/// look's fog on and volumetric. None keeps the analytic fog.
pub fn runs(fog: &Fog, quality: &Quality) -> Option<FroxelGrid> {
    let wanted = LANDED && quality.fog && fog.is_on() && fog.volumetric;
    quality.environment.froxel_fog.filter(|_| wanted)
}

/// Slice `k` of `slices`' stretch of its ray, world units (`froxel_slice_bounds`): from the
/// previous slice's centre (the camera for the first) to its own, so the integrated texel `k` holds
/// the air up to slice `k`'s centre, where the air lookup reads it.
pub fn slice_bounds(k: u32, slices: u32) -> (f32, f32) {
    let centre = |k: u32| crate::fog::aerial_slice_distance((k as f32 + 0.5) / slices as f32);
    let end = centre(k);
    if k == 0 { (0.0, end) } else { (centre(k - 1), end) }
}

/// One column's scan (the integrate kernel's CPU twin): `texels` are its injected froxels front to
/// back (rgb light per unit length, a extinction), `slices` long; returns each slice's (in-scatter,
/// fog transmittance) up to its centre, the transmittance held at `1 - max_opacity`.
pub fn integrate_column(texels: &[[f32; 4]], max_opacity: f32) -> Vec<([f32; 3], f32)> {
    let slices = texels.len() as u32;
    let floor = 1.0 - max_opacity.clamp(0.0, 1.0);
    let mut transmittance = 1.0_f32;
    let mut inscatter = [0.0_f32; 3];
    let mut out = Vec::with_capacity(texels.len());
    for (k, texel) in (0..slices).zip(texels) {
        let (start, end) = slice_bounds(k, slices);
        let after = (transmittance * libm::expf(-texel[3] * (end - start))).max(floor).min(transmittance);
        if texel[3] > 1e-7 {
            for c in 0..3 {
                inscatter[c] += (transmittance - after) * texel[c] / texel[3];
            }
        }
        transmittance = after;
        out.push((inscatter, transmittance));
    }
    out
}

/// The froxel fog's uniform (`FroxelParams` in `shaders/sky/froxel_fog.wgsl`).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuFroxelParams {
    /// The camera's inverse view-projection (column-major).
    pub inv_view_proj: [f32; 16],
    /// Last frame's view-projection (the history's camera).
    pub prev_view_proj: [f32; 16],
    /// xyz: the camera; w: the history's weight (0: no history).
    pub camera: [f32; 4],
    /// xyz: last frame's camera; w: the NDC depth of the near plane (1 under reverse-Z, else 0).
    pub prev_camera: [f32; 4],
    /// x, y, z: froxels across, down and slices; w: 1 when the frame's lights are binned.
    pub grid: [u32; 4],
    /// xyz: this frame's jitter inside a froxel (0..1); w: the first irradiance volume's row in
    /// the probes' table ([`FroxelFrame::rooms`]).
    pub jitter: [f32; 4],
    /// x, y: the render size in pixels; z: 1 when the environment lights the scene; w: the
    /// irradiance volumes' rows the inject reads from there (0: none).
    pub screen: [f32; 4],
    /// The fog row's colour lane (`GpuFog::color`).
    pub fog_color: [f32; 4],
    /// The fog row's parameter lane (`GpuFog::params`).
    pub fog_params: [f32; 4],
}

/// What the froxel fog reads from the renderer: the frame's uniforms and tables, the sun's shadow
/// array, the environment's probe cube array (layer 0 the sky) and the aerial volume node 11 wrote.
#[derive(Clone, Copy, Debug)]
pub struct FroxelInputs<'a> {
    /// The forward pass's `FrameUniforms` (the sun, the cascades).
    pub frame_uniforms: &'a Buffer,
    /// The shadow depth array (cascades, then the spot atlas).
    pub shadow_array: &'a TextureView,
    /// The shadow comparison sampler.
    pub shadow_sampler: &'a Sampler,
    /// The local-light table.
    pub lights: &'a Buffer,
    /// The local lights' extension rows.
    pub light_ext: &'a Buffer,
    /// The light-bin table (header, z-bins, tile masks).
    pub light_bins: &'a Buffer,
    /// The environment's probe cube array (`env_probes`, layer 0 the sky).
    pub env_probes: &'a TextureView,
    /// The environment's filtering sampler (also the history's and the aerial volume's).
    pub env_sampler: &'a Sampler,
    /// The aerial-perspective volume this frame (a one-texel neutral volume where none ran).
    pub aerial: &'a TextureView,
    /// The probes' and irradiance volumes' rows (`probes::ENV_PROBE_ROWS`): inside a room's
    /// volume the fog takes what its cells see instead of the horizon (AAA push P3).
    pub rooms: &'a Buffer,
    /// The irradiance volumes' atlas (`irradiance::ENV_IRRADIANCE`).
    pub room_cells: &'a TextureView,
}

/// What the froxel fog knows about one frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FroxelFrame {
    /// The camera's view-projection (unjittered; reversed under reverse-Z), column-major.
    pub view_proj: [f32; 16],
    /// The camera's position.
    pub camera: [f32; 3],
    /// The render size in pixels.
    pub render_size: (u32, u32),
    /// The frame index (frames since the history's reset; a settled capture's re-render index).
    pub frame_index: u64,
    /// The history set the frame draws on (Live, a settled capture), as an index.
    pub history_set: u32,
    /// Whether the frame starts its history set over.
    pub reset: bool,
    /// Whether camera views draw reverse-Z.
    pub depth_reversed: bool,
    /// Whether the environment (a sky or a map) lights the scene.
    pub environment_lights: bool,
    /// Whether the frame's lights are binned (the quality's `clustered`).
    pub binned: bool,
    /// The fog row the frame draws with.
    pub fog: GpuFog,
    /// The irradiance volumes' rows in the probes' table: the first and how many (they follow
    /// the reflection probes'; (0, 0): none, the horizon lights the fog everywhere).
    pub rooms: (u32, u32),
}

/// The frame the history holds.
#[derive(Clone, Copy, Debug, PartialEq)]
struct History {
    set: u32,
    frame_index: u64,
    view_proj: [f32; 16],
    camera: [f32; 3],
    /// The injected volume it lives in.
    slot: usize,
}

/// The weight and jitter `frame` draws with after `held`: the history's and a Halton step where it
/// follows the held frame, none and the froxel's centre where it starts over.
fn temporal(held: Option<&History>, frame: &FroxelFrame) -> (f32, [f32; 3]) {
    let follows = held.is_some_and(|history| history.set == frame.history_set && history.frame_index.wrapping_add(1) == frame.frame_index);
    if frame.reset || !follows {
        return (0.0, CENTRE);
    }
    (HISTORY_WEIGHT, HALTON[(frame.frame_index % HALTON.len() as u64) as usize])
}

/// The froxel fog's GPU state: the grid's volumes and both kernels.
#[derive(Debug)]
pub struct FroxelFog {
    grid: FroxelGrid,
    injected: [TextureView; 2],
    output: Texture,
    output_view: TextureView,
    params: Buffer,
    inject_layout: BindGroupLayout,
    integrate_layout: BindGroupLayout,
    inject: Compiled<ComputePipeline>,
    integrate: Compiled<ComputePipeline>,
    history: Option<History>,
}

fn volume(device: &Device, label: &str, (width, height, depth): (u32, u32, u32), copy: bool) -> Texture {
    let copy_usage = if copy { wgpu::TextureUsages::COPY_SRC } else { wgpu::TextureUsages::empty() };
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width, height, depth_or_array_layers: depth },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D3,
        format: FROXEL_FORMAT,
        usage: wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING | copy_usage,
        view_formats: &[],
    })
}

fn texture_resource(view: &TextureView) -> wgpu::BindingResource<'_> {
    wgpu::BindingResource::TextureView(view)
}

fn view_3d(texture: &Texture) -> TextureView {
    texture.create_view(&wgpu::TextureViewDescriptor { dimension: Some(wgpu::TextureViewDimension::D3), ..Default::default() })
}

fn entry(binding: u32, ty: BindingType) -> BindGroupLayoutEntry {
    BindGroupLayoutEntry { binding, visibility: ShaderStages::COMPUTE, ty, count: None }
}

fn uniform() -> BindingType {
    BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }
}

fn storage_read() -> BindingType {
    BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only: true }, has_dynamic_offset: false, min_binding_size: None }
}

fn sampled(view_dimension: wgpu::TextureViewDimension, sample_type: wgpu::TextureSampleType) -> BindingType {
    BindingType::Texture { sample_type, view_dimension, multisampled: false }
}

fn filterable_3d() -> BindingType {
    sampled(wgpu::TextureViewDimension::D3, wgpu::TextureSampleType::Float { filterable: true })
}

fn storage_3d() -> BindingType {
    BindingType::StorageTexture { access: wgpu::StorageTextureAccess::WriteOnly, format: FROXEL_FORMAT, view_dimension: wgpu::TextureViewDimension::D3 }
}

/// The inject kernel's bindings (`froxel_fog.wgsl` 0-10).
fn inject_entries() -> [BindGroupLayoutEntry; 13] {
    [
        entry(0, uniform()),
        entry(1, uniform()),
        entry(2, sampled(wgpu::TextureViewDimension::D2Array, wgpu::TextureSampleType::Depth)),
        entry(3, BindingType::Sampler(wgpu::SamplerBindingType::Comparison)),
        entry(4, storage_read()),
        entry(5, storage_read()),
        entry(6, storage_read()),
        entry(7, sampled(wgpu::TextureViewDimension::CubeArray, wgpu::TextureSampleType::Float { filterable: true })),
        entry(8, BindingType::Sampler(wgpu::SamplerBindingType::Filtering)),
        entry(9, filterable_3d()),
        entry(10, storage_3d()),
        entry(14, storage_read()),
        entry(15, filterable_3d()),
    ]
}

/// The integrate kernel's bindings (`froxel_fog.wgsl` 1, 8, 11-13).
fn integrate_entries() -> [BindGroupLayoutEntry; 5] {
    [entry(1, uniform()), entry(8, BindingType::Sampler(wgpu::SamplerBindingType::Filtering)), entry(11, filterable_3d()), entry(12, filterable_3d()), entry(13, storage_3d())]
}

fn pipeline(device: &Device, label: &str, layout: &BindGroupLayout, entry_point: &str) -> Result<Compiled<ComputePipeline>, RenderError> {
    let module = crate::shaders::module(device, label, FROXEL_FOG)?;
    let pipeline_layout = crate::tables::pipeline_layout(device, label, &[layout]);
    Ok(crate::compile::compute_pipeline(device, &wgpu::ComputePipelineDescriptor {
        label: Some(label),
        layout: Some(&pipeline_layout),
        module: &module,
        entry_point: Some(entry_point),
        compilation_options: Default::default(),
        cache: None,
    }))
}

impl FroxelFog {
    /// The volumes of `grid` and both kernels on `device`.
    pub fn new(device: &Device, grid: FroxelGrid) -> Result<FroxelFog, RenderError> {
        let size = (u32::from(grid.width), u32::from(grid.height), u32::from(grid.slices));
        let injected = [volume(device, "froxel fog injected 0", size, false), volume(device, "froxel fog injected 1", size, false)];
        let output = volume(device, "froxel fog", (size.0, size.1, size.2 * crate::fog::AIR_HALVES), true);
        let inject_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("froxel inject"), entries: &inject_entries() });
        let integrate_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("froxel integrate"), entries: &integrate_entries() });
        Ok(FroxelFog {
            grid,
            injected: injected.each_ref().map(view_3d),
            output_view: view_3d(&output),
            output,
            params: crate::tables::buffer(device, "froxel fog", size_of::<GpuFroxelParams>() as u64, wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST)?,
            inject: pipeline(device, "froxel inject", &inject_layout, INJECT_ENTRY)?,
            integrate: pipeline(device, "froxel integrate", &integrate_layout, INTEGRATE_ENTRY)?,
            inject_layout,
            integrate_layout,
            history: None,
        })
    }

    /// The grid it was made for.
    pub fn grid(&self) -> FroxelGrid {
        self.grid
    }

    /// The result: an air volume in the split layout (`fog::AIR_HALVES`), bound in the aerial
    /// perspective's place.
    pub fn view(&self) -> &TextureView {
        &self.output_view
    }

    /// The result's texture (tests read it back).
    pub fn texture(&self) -> &Texture {
        &self.output
    }

    /// Bytes its volumes hold.
    pub fn bytes(&self) -> u64 {
        self.grid.bytes()
    }

    /// Forget the history: the next frame starts over.
    pub fn reset_history(&mut self) {
        self.history = None;
    }

    /// The uniform of `frame` with history weight `weight` and jitter `jitter`.
    fn params(&self, frame: &FroxelFrame, weight: f32, jitter: [f32; 3]) -> GpuFroxelParams {
        let view_proj = glam::Mat4::from_cols_array(&frame.view_proj);
        let held = self.history.as_ref().filter(|_| weight > 0.0);
        let near = if frame.depth_reversed { 1.0 } else { 0.0 };
        let [x, y, z] = frame.camera;
        let prev = held.map_or(frame.camera, |history| history.camera);
        GpuFroxelParams {
            inv_view_proj: view_proj.inverse().to_cols_array(),
            prev_view_proj: held.map_or(frame.view_proj, |history| history.view_proj),
            camera: [x, y, z, weight],
            prev_camera: [prev[0], prev[1], prev[2], near],
            grid: [u32::from(self.grid.width), u32::from(self.grid.height), u32::from(self.grid.slices), u32::from(frame.binned)],
            jitter: [jitter[0], jitter[1], jitter[2], frame.rooms.0 as f32],
            screen: [frame.render_size.0 as f32, frame.render_size.1 as f32, if frame.environment_lights { 1.0 } else { 0.0 }, frame.rooms.1 as f32],
            fog_color: frame.fog.color,
            fog_params: frame.fog.params,
        }
    }

    /// Record the fog for `frame` into `encoder`: one compute pass, the inject then the integrate
    /// dispatch. The history moves on to this frame.
    pub fn encode(&mut self, device: &Device, queue: &Queue, encoder: &mut wgpu::CommandEncoder, inputs: &FroxelInputs<'_>, frame: &FroxelFrame) -> PassCounters {
        self.encode_timed(device, queue, encoder, (inputs, frame), None)
    }

    /// [`FroxelFog::encode`] with the pass timestamped by `timestamp_writes` (the cost rows).
    pub fn encode_timed(
        &mut self,
        device: &Device,
        queue: &Queue,
        encoder: &mut wgpu::CommandEncoder,
        (inputs, frame): (&FroxelInputs<'_>, &FroxelFrame),
        timestamp_writes: Option<wgpu::ComputePassTimestampWrites<'_>>,
    ) -> PassCounters {
        let (weight, jitter) = temporal(self.history.as_ref(), frame);
        queue.write_buffer(&self.params, 0, bytemuck::bytes_of(&self.params(frame, weight, jitter)));
        let slot = self.history.map_or(0, |history| 1 - history.slot);
        let inject = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("froxel inject"),
            layout: &self.inject_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: inputs.frame_uniforms.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: self.params.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: texture_resource(inputs.shadow_array) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::Sampler(inputs.shadow_sampler) },
                wgpu::BindGroupEntry { binding: 4, resource: inputs.lights.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 5, resource: inputs.light_ext.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 6, resource: inputs.light_bins.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 7, resource: texture_resource(inputs.env_probes) },
                wgpu::BindGroupEntry { binding: 8, resource: wgpu::BindingResource::Sampler(inputs.env_sampler) },
                wgpu::BindGroupEntry { binding: 9, resource: texture_resource(&self.injected[1 - slot]) },
                wgpu::BindGroupEntry { binding: 10, resource: texture_resource(&self.injected[slot]) },
                wgpu::BindGroupEntry { binding: 14, resource: inputs.rooms.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 15, resource: texture_resource(inputs.room_cells) },
            ],
        });
        let integrate = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("froxel integrate"),
            layout: &self.integrate_layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 1, resource: self.params.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 8, resource: wgpu::BindingResource::Sampler(inputs.env_sampler) },
                wgpu::BindGroupEntry { binding: 11, resource: texture_resource(&self.injected[slot]) },
                wgpu::BindGroupEntry { binding: 12, resource: texture_resource(inputs.aerial) },
                wgpu::BindGroupEntry { binding: 13, resource: texture_resource(&self.output_view) },
            ],
        });
        let (width, height, slices) = (u32::from(self.grid.width), u32::from(self.grid.height), u32::from(self.grid.slices));
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("froxel fog"), timestamp_writes });
        pass.set_pipeline(&self.inject);
        pass.set_bind_group(0, &inject, &[]);
        pass.dispatch_workgroups(width.div_ceil(INJECT_GROUP), height.div_ceil(INJECT_GROUP), slices.div_ceil(INJECT_GROUP));
        pass.set_pipeline(&self.integrate);
        pass.set_bind_group(0, &integrate, &[]);
        pass.dispatch_workgroups(width.div_ceil(INTEGRATE_GROUP), height.div_ceil(INTEGRATE_GROUP), 1);
        drop(pass);
        self.history = Some(History { set: frame.history_set, frame_index: frame.frame_index, view_proj: frame.view_proj, camera: frame.camera, slot });
        PassCounters { compute: 1, ..PassCounters::default() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::{EnvironmentQuality, RenderFeature};

    fn frame(index: u64) -> FroxelFrame {
        FroxelFrame {
            view_proj: glam::Mat4::IDENTITY.to_cols_array(),
            camera: [0.0; 3],
            render_size: (1920, 1080),
            frame_index: index,
            history_set: 0,
            reset: false,
            depth_reversed: true,
            environment_lights: true,
            binned: true,
            fog: GpuFog::default(),
            rooms: (0, 0),
        }
    }

    fn held(index: u64, set: u32) -> History {
        History { set, frame_index: index, view_proj: [0.0; 16], camera: [0.0; 3], slot: 0 }
    }

    #[test]
    fn only_a_frame_that_follows_the_held_one_reads_the_history_and_jitters() {
        assert_eq!(temporal(None, &frame(5)), (0.0, CENTRE), "nothing held");
        assert_eq!(temporal(Some(&held(4, 0)), &frame(5)), (HISTORY_WEIGHT, HALTON[5]));
        assert_eq!(temporal(Some(&held(4, 0)), &frame(4)), (0.0, CENTRE), "the same index again (a settled re-render or a paused frame)");
        assert_eq!(temporal(Some(&held(9, 0)), &frame(0)), (0.0, CENTRE), "index 0 starts over");
        assert_eq!(temporal(Some(&held(4, 1)), &frame(5)), (0.0, CENTRE), "another history set");
        assert_eq!(temporal(Some(&held(4, 0)), &FroxelFrame { reset: true, ..frame(5) }), (0.0, CENTRE), "a reset");
    }

    #[test]
    fn the_halton_jitter_stays_inside_the_froxel() {
        for step in HALTON {
            assert!(step.iter().all(|c| (0.0..1.0).contains(c)), "{step:?}");
        }
    }

    #[test]
    fn the_slices_tile_the_ray_from_the_camera_to_the_last_centre() {
        let slices = 64;
        assert_eq!(slice_bounds(0, slices).0, 0.0);
        for k in 1..slices {
            assert_eq!(slice_bounds(k, slices).0, slice_bounds(k - 1, slices).1, "slice {k} starts where {} ends", k - 1);
            assert!(slice_bounds(k, slices).1 > slice_bounds(k, slices).0);
        }
        let last = slice_bounds(slices - 1, slices).1;
        assert!(last > 0.8 * crate::fog::AERIAL_RANGE && last < crate::fog::AERIAL_RANGE, "{last}");
        // Shafts are near: the first sixteen slices end inside 40 m.
        assert!(slice_bounds(15, slices).1 < 40.0, "{}", slice_bounds(15, slices).1);
    }

    #[test]
    fn an_unshadowed_column_scans_to_the_analytic_fog() {
        // Uniform fog of density 0.05 lit by one in-scatter radiance: each texel holds σL and σ.
        let (sigma, light) = (0.05_f32, [0.8_f32, 0.9, 1.1]);
        let texels = vec![[light[0] * sigma, light[1] * sigma, light[2] * sigma, sigma]; 64];
        for max_opacity in [1.0, 0.6] {
            let scanned = integrate_column(&texels, max_opacity);
            for (k, (inscatter, transmittance)) in scanned.iter().enumerate() {
                let distance = slice_bounds(k as u32, 64).1;
                let opacity = (1.0 - libm::expf(-sigma * distance)).min(max_opacity);
                assert!((transmittance - (1.0 - opacity)).abs() < 1e-4, "slice {k}: {transmittance} vs {}", 1.0 - opacity);
                for c in 0..3 {
                    assert!((inscatter[c] - light[c] * opacity).abs() < 1e-4, "slice {k} channel {c}");
                }
            }
        }
    }

    #[test]
    fn a_dark_slice_only_removes_light_behind_it() {
        // Lit fog with one slice in shadow (no light) at slice 10: less in-scatter from slice 10 on,
        // the transmittance unchanged.
        let sigma = 0.05_f32;
        let lit = vec![[sigma, sigma, sigma, sigma]; 64];
        let mut shaded = lit.clone();
        shaded[10] = [0.0, 0.0, 0.0, sigma];
        let (a, b) = (integrate_column(&lit, 1.0), integrate_column(&shaded, 1.0));
        assert_eq!(a[9], b[9]);
        assert!(b[10].0[0] < a[10].0[0] && (a[10].1 - b[10].1).abs() < 1e-7);
    }

    #[test]
    fn the_fog_draws_as_a_volume_only_on_froxel_qualities_with_the_look_s_fog_on() {
        let mut quality = Quality::off();
        quality.set_feature(RenderFeature::Fog, true);
        quality.environment = EnvironmentQuality { froxel_fog: Some(HIGH_GRID), ..quality.environment };
        let fog = Fog::default().with_density(0.02);
        assert_eq!(runs(&fog, &quality), Some(HIGH_GRID));
        assert_eq!(runs(&Fog::default(), &quality), None, "no density");
        assert_eq!(runs(&fog.with_volumetric(false), &quality), None, "the look asks for the analytic fog");
        quality.set_feature(RenderFeature::Fog, false);
        assert_eq!(runs(&fog, &quality), None, "the quality's fog off");
    }

    #[test]
    fn the_grids_hold_three_volumes_and_ultra_is_the_plan_s_grid() {
        assert_eq!((ULTRA_GRID.width, ULTRA_GRID.height, ULTRA_GRID.slices), (160, 90, 64));
        assert_eq!(ULTRA_GRID.bytes(), 160 * 90 * 64 * 8 * 4);
        assert!(HIGH_GRID.froxels() < ULTRA_GRID.froxels());
    }
}
