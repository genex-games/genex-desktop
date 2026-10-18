//! Lake water (renderer pass 2, B.3; prior-art B3, with T-01 step 3): a flat water rectangle drawn
//! by its own pipeline after the opaque scene, over the screen inputs of A.6.
//!
//! - **Refraction** ([`WaterInput::opaque`]): the opaque copy (node 14a) sampled through the
//!   ripples' offset, growing from nothing at the shoreline over [`REFRACT_RAMP_M`] of path, and
//!   kept straight where the offset would land on something in front of the water. Without the
//!   copy (phones, MSAA presets, the legacy scene) the pass blends over the scene, premultiplied,
//!   unrefracted ([`WaterPath::Blended`]).
//! - **Colour** ([`transmittance`], [`opacity`]): Beer-Lambert absorption over the path the view
//!   ray travels under water (the scene depth's bed distance minus the surface's), filled by the
//!   water body's in-scattered sky and sun light (the ideas of bevy-aqua-fft's colour model and
//!   bevy_water's deep and shallow colours, both MIT OR Apache-2.0; no source copied).
//! - **Shore foam** ([`shore_foam`]): foam where the water under the surface is shallower than the
//!   material's width, broken up by a value noise (the idea of GodotOceanWaves' foam, MIT).
//! - **Reflections** ([`reflection_source`], [`reflect`]): Schlick's Fresnel ([`fresnel`], F0 0.02)
//!   mixes in the screen's reflection where the SSR helper's march hits, read from the previous
//!   frame's colour pyramid at the hit's reprojected point and re-exposed (desktop and web `high`
//!   and `ultra`), and the reflection probes over the water with the sky layer filling what they
//!   leave elsewhere and on every other class (phones never march: plan B.3, "no SSR on phones").
//! - **TAA's key** ([`WaterNode::draw_motion`], `fs_water_motion`): after the colour pass the
//!   surface writes its own motion and depth into the motion prepass's targets (reactive 0), so
//!   TAA reprojects a water pixel by the water's motion rather than the bed's and keeps its
//!   history (the lake was a blended mesh TAA marked reactive: T-01 step 3).
//!
//! The pipeline has its own layout (group 0 the renderer's frame uniforms, group 1 the water's: a
//! uniform, four sampled textures and the reflection's uniform), so it spends none of the forward
//! stage's sixteen sampled textures (plan section 2, D1). Its budget is [`WATER_MS_MAX`] at a
//! 1080p render.

use bytemuck::{Pod, Zeroable};
use wgpu::{BindGroup, BindGroupLayout, Buffer, Device, Queue, RenderPass, RenderPipeline, Sampler, TextureFormat, TextureView};

use crate::compile::Compiled;
use crate::device_class::{DeviceClass, FormFactor};
use crate::error::RenderError;
use crate::screen_inputs::ScreenInputs;
use crate::settings::Quality;

pub mod reflect;

/// The water's shader: the common structs, the clip position, the SSR helper, the water, then its
/// reflection ([`reflect`]).
pub const WATER: &str = crate::shaders::minify::shipped_wgsl!(concat!(
    include_str!("../shaders/common.wgsl"),
    include_str!("../shaders/clip_position.wgsl"),
    include_str!("../shaders/screen/ssr_march.wgsl"),
    include_str!("../shaders/water/water.wgsl"),
    include_str!("../shaders/water/water_reflect.wgsl")
));
/// The vertex entry point (six vertices: the rectangle's two triangles).
pub const VERTEX_ENTRY: &str = "vs_water";
/// The colour pass's fragment entry point.
pub const FRAGMENT_ENTRY: &str = "fs_water";
/// The motion key's fragment entry point (the motion prepass's targets).
pub const MOTION_FRAGMENT_ENTRY: &str = "fs_water_motion";
/// Vertices a water rectangle draws.
pub const VERTICES: u32 = 6;

/// The water's budget at a 1080p render, ms (plan B.3).
pub const WATER_MS_MAX: f32 = 1.0;
/// Schlick's reflectance of water at normal incidence (`GX_WATER_F0`).
pub const F0: f32 = 0.02;
/// The path over which the refraction's offset grows to its full size, m (`GX_WATER_REFRACT_RAMP_M`).
pub const REFRACT_RAMP_M: f32 = 2.0;
/// The sampled textures the water's own group binds (opaque copy, depth, environment, history).
pub const SAMPLED_TEXTURES: u32 = 4;
/// The storage buffers it binds.
pub const STORAGE_BUFFERS: u32 = 0;

/// How a lake looks: its absorption, scattering, foam and surface.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WaterMaterial {
    /// Beer-Lambert absorption per metre, linear rgb (red absorbed fastest for fresh water).
    pub absorption: [f32; 3],
    /// The water body's in-scattered albedo, linear rgb (its green-blue body colour).
    pub scatter: [f32; 3],
    /// How wide the shore foam reaches, metres of water under the surface (0: none).
    pub foam_width: f32,
    /// The refraction's largest offset, a fraction of the screen.
    pub refraction: f32,
    /// The reflection's perceptual roughness.
    pub roughness: f32,
    /// How far the ripples tilt the normal (0: a mirror).
    pub ripple: f32,
}

impl WaterMaterial {
    /// A clear temperate lake: red gone within a few metres, blue-green under the surface.
    pub const LAKE: WaterMaterial = WaterMaterial { absorption: [0.45, 0.09, 0.06], scatter: [0.02, 0.09, 0.08], foam_width: 0.12, refraction: 0.02, roughness: 0.08, ripple: 0.08 };
}

impl Default for WaterMaterial {
    fn default() -> Self {
        WaterMaterial::LAKE
    }
}

/// A water rectangle: its centre (y the water level) and its half extents along x and z, metres.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WaterBody {
    /// The rectangle's centre, its y the water level.
    pub centre: [f32; 3],
    /// Half its size along x and z.
    pub half_extent: [f32; 2],
    /// How it looks.
    pub material: WaterMaterial,
}

/// How the colour pass composes with the scene.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WaterPath {
    /// Opaque over the opaque copy, refracted.
    Refracted,
    /// Premultiplied over the scene, unrefracted (no opaque copy this frame).
    Blended,
}

/// Where the water's reflection comes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReflectionSource {
    /// The SSR helper's march over the previous frame's colour, the environment where it misses.
    ScreenThenEnvironment,
    /// The reflection probes over the water, the environment's sky layer filling what they leave.
    Environment,
}

/// The screen inputs the water asks a frame for (`screen_inputs::frame_inputs` intersects them
/// with what the preset allows).
pub const fn asked_inputs() -> ScreenInputs {
    ScreenInputs::WATER
}

/// The colour pass's composition under the frame's `inputs`.
pub const fn path(inputs: ScreenInputs) -> WaterPath {
    if inputs.opaque_copy { WaterPath::Refracted } else { WaterPath::Blended }
}

/// Where a frame drawn at `quality` on `class` with `inputs` reflects from: the screen on desktop
/// and web classes whose frame holds the history pyramid, the environment on phones always.
pub fn reflection_source(quality: &Quality, class: DeviceClass, inputs: ScreenInputs) -> ReflectionSource {
    let marches = class.form != FormFactor::Mobile && quality.screen_inputs.history_pyramid && inputs.history_pyramid;
    if marches { ReflectionSource::ScreenThenEnvironment } else { ReflectionSource::Environment }
}

/// Beer-Lambert transmittance over `path` metres of water (`gx_water_transmittance`).
pub fn transmittance(absorption: [f32; 3], path: f32) -> [f32; 3] {
    absorption.map(|a| libm::expf(-a * path))
}

/// The share of the scene behind the water it hides (`opacity` in `fs_water`): one minus the mean
/// transmittance.
pub fn opacity(absorption: [f32; 3], path: f32) -> f32 {
    let t = transmittance(absorption, path);
    1.0 - (t[0] + t[1] + t[2]) / 3.0
}

/// Schlick's Fresnel of water at `cos_theta` between the view and the normal (`gx_water_fresnel`).
pub fn fresnel(cos_theta: f32) -> f32 {
    let m = 1.0 - cos_theta.clamp(0.0, 1.0);
    let m2 = m * m;
    F0 + (1.0 - F0) * m2 * m2 * m
}

fn smoothstep(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// The shore foam's cover at `depth_below` metres of water under the surface, `width` its width
/// and `noise` (0..1) its breakup (`gx_water_shore_foam`).
pub fn shore_foam(depth_below: f32, width: f32, noise: f32) -> f32 {
    if width <= 0.0 {
        return 0.0;
    }
    let shallow = 1.0 - smoothstep(0.0, width, depth_below);
    (shallow * (0.55 + 0.9 * noise) - 0.25).clamp(0.0, 1.0)
}

/// The refraction's offset scale at `path` metres of water (0 at the shoreline, 1 from
/// [`REFRACT_RAMP_M`]).
pub fn refraction_ramp(path: f32) -> f32 {
    (path / REFRACT_RAMP_M).clamp(0.0, 1.0)
}

/// The water's uniform row (`Water` in shaders/water/water.wgsl).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuWater {
    /// The projection the scene depth was drawn with, column-major.
    pub proj: [f32; 16],
    /// Last frame's unjittered view-projection, column-major (this frame's after a reset).
    pub prev_view_proj: [f32; 16],
    /// xyz: the rectangle's centre; w: 0.
    pub centre: [f32; 4],
    /// xy: half extents along x and z; zw: 0.
    pub half_extent: [f32; 4],
    /// rgb: absorption per metre; w: the refraction's largest uv offset.
    pub absorption: [f32; 4],
    /// rgb: in-scattered albedo; w: the shore foam's width, m.
    pub scatter: [f32; 4],
    /// x: roughness; y: ripple strength; z: time, s; w: the environment cube's mip count.
    pub surface: [f32; 4],
    /// xy: the render size; zw: its reciprocal.
    pub viewport: [f32; 4],
    /// x: refracting (opaque copy bound); y: marching screen reflections; z: depth reversed.
    pub flags: [u32; 4],
}

/// What one frame's water row is made of.
#[derive(Clone, Copy, Debug)]
pub struct WaterFrame {
    /// The body drawn.
    pub body: WaterBody,
    /// The camera's projection (unjittered).
    pub proj: glam::Mat4,
    /// Last frame's unjittered view-projection (this frame's after a history reset).
    pub prev_view_proj: glam::Mat4,
    /// The render size.
    pub render: (u32, u32),
    /// The water's clock, seconds (the simulation's, so a capture is the same every time).
    pub time: f32,
    /// The environment cube's mip count.
    pub env_mips: u32,
    /// How the colour pass composes.
    pub path: WaterPath,
    /// Where it reflects from.
    pub reflection: ReflectionSource,
    /// Whether depth is reversed (the HDR path).
    pub depth_reversed: bool,
}

impl GpuWater {
    /// The row for `frame`.
    pub fn new(frame: &WaterFrame) -> GpuWater {
        let body = &frame.body;
        let m = &body.material;
        let (w, h) = (frame.render.0.max(1) as f32, frame.render.1.max(1) as f32);
        GpuWater {
            proj: frame.proj.to_cols_array(),
            prev_view_proj: frame.prev_view_proj.to_cols_array(),
            centre: [body.centre[0], body.centre[1], body.centre[2], 0.0],
            half_extent: [body.half_extent[0], body.half_extent[1], 0.0, 0.0],
            absorption: [m.absorption[0], m.absorption[1], m.absorption[2], m.refraction],
            scatter: [m.scatter[0], m.scatter[1], m.scatter[2], m.foam_width],
            surface: [m.roughness, m.ripple, frame.time, frame.env_mips as f32],
            viewport: [w, h, 1.0 / w, 1.0 / h],
            flags: [u32::from(frame.path == WaterPath::Refracted), u32::from(frame.reflection == ReflectionSource::ScreenThenEnvironment), u32::from(frame.depth_reversed), 0],
        }
    }
}

/// The targets the water draws into: the scene colour (its format), the world depth (its format)
/// and, for the motion key, the motion prepass's three colour targets.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WaterFormats {
    /// The scene colour's format.
    pub colour: TextureFormat,
    /// The depth attachment's format.
    pub depth: TextureFormat,
    /// Whether depth is reversed (`Greater` tests).
    pub depth_reversed: bool,
    /// Whether the colour pass writes depth: false where the world pass shares the sampled
    /// prepass depth (immediate-mode GPUs at 1x), whose water depth the motion pass writes.
    pub colour_writes_depth: bool,
}

/// What the water's group binds.
pub struct WaterInput<'a> {
    /// The renderer's frame uniforms (`FrameUniforms`).
    pub frame: &'a Buffer,
    /// The opaque copy, when the frame made one.
    pub opaque: Option<&'a TextureView>,
    /// The scene depth without the water (the prepass's).
    pub depth: &'a TextureView,
    /// The environment cube array (layer 0 the sky).
    pub env: &'a TextureView,
    /// The previous frame's colour pyramid, when the frame holds one.
    pub history: Option<&'a TextureView>,
}

/// The water node: its layout, pipelines, uniform and neutral inputs.
pub struct WaterNode {
    layout: BindGroupLayout,
    frame_layout: BindGroupLayout,
    colour: Compiled<RenderPipeline>,
    motion: Compiled<RenderPipeline>,
    uniform: Buffer,
    reflect: Buffer,
    sampler: Sampler,
    neutral: TextureView,
    groups: Option<(BindGroup, BindGroup)>,
}

fn texture_entry(binding: u32, sample_type: wgpu::TextureSampleType, dimension: wgpu::TextureViewDimension) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Texture { sample_type, view_dimension: dimension, multisampled: false },
        count: None,
    }
}

fn uniform_entry(binding: u32, visibility: wgpu::ShaderStages) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry { binding, visibility, ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }, count: None }
}

fn water_layout(device: &Device) -> BindGroupLayout {
    let float = wgpu::TextureSampleType::Float { filterable: true };
    let d2 = wgpu::TextureViewDimension::D2;
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("water group"),
        entries: &[
            uniform_entry(0, wgpu::ShaderStages::VERTEX_FRAGMENT),
            texture_entry(1, float, d2),
            texture_entry(2, wgpu::TextureSampleType::Depth, d2),
            texture_entry(3, float, wgpu::TextureViewDimension::CubeArray),
            texture_entry(4, float, d2),
            wgpu::BindGroupLayoutEntry { binding: 5, visibility: wgpu::ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
            uniform_entry(6, wgpu::ShaderStages::FRAGMENT),
        ],
    })
}

fn depth_compare(reversed: bool) -> wgpu::CompareFunction {
    if reversed { wgpu::CompareFunction::Greater } else { wgpu::CompareFunction::Less }
}

/// Premultiplied over: the refracted path writes alpha 1, so it replaces what is behind.
const PREMULTIPLIED: wgpu::BlendState = wgpu::BlendState {
    color: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha, operation: wgpu::BlendOperation::Add },
    alpha: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha, operation: wgpu::BlendOperation::Add },
};

fn pipeline(device: &Device, layout: &wgpu::PipelineLayout, module: &wgpu::ShaderModule, formats: WaterFormats, motion: bool) -> Compiled<RenderPipeline> {
    let colour_targets = [Some(wgpu::ColorTargetState { format: formats.colour, blend: Some(PREMULTIPLIED), write_mask: wgpu::ColorWrites::ALL })];
    let [normals, motion_format, reactive] = crate::motion::TARGET_FORMATS;
    let motion_targets = [
        Some(wgpu::ColorTargetState { format: normals, blend: None, write_mask: wgpu::ColorWrites::empty() }),
        Some(wgpu::ColorTargetState { format: motion_format, blend: None, write_mask: wgpu::ColorWrites::ALL }),
        Some(wgpu::ColorTargetState { format: reactive, blend: None, write_mask: wgpu::ColorWrites::ALL }),
    ];
    let (label, entry, targets): (&str, &str, &[Option<wgpu::ColorTargetState>]) =
        if motion { ("water motion", MOTION_FRAGMENT_ENTRY, &motion_targets) } else { ("water", FRAGMENT_ENTRY, &colour_targets) };
    let writes_depth = motion || formats.colour_writes_depth;
    crate::compile::render_pipeline(
        device,
        &wgpu::RenderPipelineDescriptor {
            label: Some(label),
            layout: Some(layout),
            vertex: wgpu::VertexState { module, entry_point: Some(VERTEX_ENTRY), compilation_options: Default::default(), buffers: &[] },
            primitive: wgpu::PrimitiveState { cull_mode: None, ..Default::default() },
            depth_stencil: Some(wgpu::DepthStencilState {
                format: formats.depth,
                depth_write_enabled: Some(writes_depth),
                depth_compare: Some(depth_compare(formats.depth_reversed)),
                stencil: Default::default(),
                bias: Default::default(),
            }),
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState { module, entry_point: Some(entry), compilation_options: Default::default(), targets }),
            multiview_mask: None,
            cache: None,
        },
    )
}

impl WaterNode {
    /// The node for `formats` (its two pipelines compile on the compile pool).
    pub fn new(device: &Device, formats: WaterFormats) -> Result<WaterNode, RenderError> {
        let module = crate::shaders::module(device, "water", WATER)?;
        let layout = water_layout(device);
        let frame_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("water frame"), entries: &[uniform_entry(0, wgpu::ShaderStages::VERTEX_FRAGMENT)] });
        let pipeline_layout = crate::tables::pipeline_layout(device, "water", &[&frame_layout, &layout]);
        let colour = pipeline(device, &pipeline_layout, &module, formats, false);
        let motion = pipeline(device, &pipeline_layout, &module, formats, true);
        let uniform = crate::tables::buffer(device, "water row", size_of::<GpuWater>() as u64, wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST)?;
        let reflect = wgpu::util::DeviceExt::create_buffer_init(
            device,
            &wgpu::util::BufferInitDescriptor { label: Some("water reflect"), contents: bytemuck::bytes_of(&reflect::GpuWaterReflect::NONE), usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST },
        );
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("water sampler"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Linear,
            ..Default::default()
        });
        let neutral = device
            .create_texture(&wgpu::TextureDescriptor {
                label: Some("water neutral"),
                size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: TextureFormat::Rgba16Float,
                usage: wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            })
            .create_view(&wgpu::TextureViewDescriptor::default());
        Ok(WaterNode { layout, frame_layout, colour, motion, uniform, reflect, sampler, neutral, groups: None })
    }

    /// Write this frame's reflection row ([`reflect::GpuWaterReflect::new`]: the reprojection to
    /// the colour pyramid, its exposure ratio and the probes over the water). A node never given
    /// one draws with [`reflect::GpuWaterReflect::NONE`].
    pub fn set_reflection(&self, queue: &Queue, row: &reflect::GpuWaterReflect) {
        queue.write_buffer(&self.reflect, 0, bytemuck::bytes_of(row));
    }

    /// Write `row` and bind `input` for this frame's draws.
    pub fn prepare(&mut self, device: &Device, queue: &Queue, row: &GpuWater, input: &WaterInput<'_>) {
        queue.write_buffer(&self.uniform, 0, bytemuck::bytes_of(row));
        let frame = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("water frame"),
            layout: &self.frame_layout,
            entries: &[wgpu::BindGroupEntry { binding: 0, resource: input.frame.as_entire_binding() }],
        });
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("water group"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: self.uniform.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(input.opaque.unwrap_or(&self.neutral)) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(input.depth) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(input.env) },
                wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::TextureView(input.history.unwrap_or(&self.neutral)) },
                wgpu::BindGroupEntry { binding: 5, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                wgpu::BindGroupEntry { binding: 6, resource: self.reflect.as_entire_binding() },
            ],
        });
        self.groups = Some((frame, group));
    }

    /// Draw the surface's colour into a pass over the scene colour and the world depth (after the
    /// opaque scene and the opaque copy, before the other transparent draws).
    pub fn draw_colour(&self, pass: &mut RenderPass<'_>) {
        self.draw(pass, &self.colour);
    }

    /// Draw the surface's motion key into a pass over the motion prepass's three targets and the
    /// prepass depth (after [`WaterNode::draw_colour`], before TAA's resolve).
    pub fn draw_motion(&self, pass: &mut RenderPass<'_>) {
        self.draw(pass, &self.motion);
    }

    /// Record the motion key as its own pass: the motion prepass's `targets` (normals, motion,
    /// reactive: [`crate::motion::TARGET_FORMATS`]) and the prepass `depth`, all loaded and kept, so
    /// the surface's motion and depth replace the bed's under it before TAA's resolve (graph node
    /// 17) reads them.
    pub fn encode_motion(&self, encoder: &mut wgpu::CommandEncoder, targets: [&TextureView; 3], depth: &TextureView) {
        let keep = wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store };
        let attachments = targets.map(|view| Some(wgpu::RenderPassColorAttachment { view, depth_slice: None, resolve_target: None, ops: keep }));
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("water motion"),
            color_attachments: &attachments,
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment { view: depth, depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store }), stencil_ops: None }),
            ..Default::default()
        });
        self.draw_motion(&mut pass);
    }

    fn draw(&self, pass: &mut RenderPass<'_>, pipeline: &Compiled<RenderPipeline>) {
        let Some((frame, group)) = &self.groups else { return };
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, frame, &[]);
        pass.set_bind_group(1, group, &[]);
        pass.draw(0..VERTICES, 0..1);
    }
}
