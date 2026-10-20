//! The impostor draw (game systems LOD-14): a port of kansei's `impostor.wgsl` (Siroko/kansei,
//! MIT) inside the world pass, through the grass's pattern: pipelines of its own over the forward
//! frame group, the pass view and the impostor group (group 2), adding no binding to the forward
//! pipelines.
//!
//! - **Opaque**: each placed impostor is a camera-facing quad over its species' bounds
//!   ([`IMPOSTOR_DRAW`], `vs_impostor`), blending the three frames nearest the view direction
//!   with one parallax step to their stored depth (off on the phone sizes,
//!   `GX_IMPOSTOR_PARALLAX`), lit through the forward chunks from its atlases' surface
//!   attributes. `Equal` against the prepass depth where the world pass reuses it.
//! - **Prepass and motion prepass**: its depth and world normal; under motion, the reconstructed
//!   surface point reprojected by the camera (an impostor stands still: the quad turning to face
//!   the camera is not motion).
//! - **Depth** ([`writes_depth`], `GX_IMPOSTOR_DEPTH` in the design): on desktop high and ultra
//!   the `_depth` entries write the reconstructed surface's depth (`frag_depth`), so an impostor
//!   meets other geometry as its mesh would. Below, the quad's flat depth (a plane through the
//!   bounds' centre) keeps early depth testing, which tile GPUs depend on.
//! - **Fade**: an instance's fade (kansei's signed convention, [`GpuImpostorInstance::fade`]) cuts
//!   whole pixels with the meshes' dither, so a mesh level fading into its impostor covers each
//!   pixel once. LOD-15 feeds it from the cull's fade slots.
//!
//! The forward frame group holds all of WebGPU core's 16 sampled textures in the fragment stage,
//! so the impostor pipelines bind group 0 as the frame group without the material texture arrays
//! (the impostor reads its material from its atlases): `renderer::impostor_frame_layout_entries`.
//! Shadows are not cast here: LOD-15 casts the coarsest mesh where the camera draws the impostor
//! (option A).

use bytemuck::{Pod, Zeroable};
use wgpu::{BindGroup, BindGroupLayout, BindGroupLayoutEntry, Buffer, BufferUsages, Device, Queue, RenderPass, RenderPipeline, ShaderStages, TextureFormat};

use super::bake::{ATLAS_FORMAT, ImpostorAtlases};
use super::{GpuImpostor, ImpostorClass, ImpostorSpec};
use crate::compile::Compiled;
use crate::error::RenderError;

/// The impostor's world, prepass and motion entry points: the forward module's sources (the list
/// of `shaders::FORWARD`), then the draw's own (so an impostor shades through the same chunks as
/// a built-in surface; decals do not project onto impostors).
pub const IMPOSTOR_DRAW: &str = crate::shaders::minify::shipped_wgsl!(concat!(
    include_str!("../../shaders/common.wgsl"),
    include_str!("../../shaders/clip_position.wgsl"),
    include_str!("../../shaders/effects.wgsl"),
    include_str!("../../shaders/forward_env.wgsl"),
    include_str!("../../shaders/pbr.wgsl"),
    include_str!("../../shaders/lighting/surface.wgsl"),
    include_str!("../../shaders/lighting/decals.wgsl"),
    include_str!("../../shaders/screen/ssr_apply.wgsl"),
    include_str!("../../shaders/lighting/ambient.wgsl"),
    include_str!("../../shaders/lighting/sun.wgsl"),
    include_str!("../../shaders/lighting/subsurface.wgsl"),
    include_str!("../../shaders/lighting/local_lights.wgsl"),
    include_str!("../../shaders/lighting/fog.wgsl"),
    include_str!("../../shaders/lighting/output.wgsl"),
    include_str!("../../shaders/forward_effects.wgsl"),
    include_str!("../../shaders/alpha_mask.wgsl"),
    include_str!("../../shaders/forward.wgsl"),
    include_str!("../../shaders/impostor/draw.wgsl")
));

/// The world pass's vertex entry point.
pub const VERTEX_ENTRY: &str = "vs_impostor";
/// The motion prepass's vertex entry point.
pub const MOTION_VERTEX_ENTRY: &str = "vs_impostor_motion";
/// The world pass's fragment entry points: flat depth, then the reconstructed surface's.
pub const FORWARD_FRAGMENT: [&str; 2] = ["fs_impostor", "fs_impostor_depth"];
/// The prepass's fragment entry points: flat depth, then the reconstructed surface's.
pub const PREPASS_FRAGMENT: [&str; 2] = ["fs_impostor_prepass", "fs_impostor_prepass_depth"];
/// The motion prepass's fragment entry points: flat depth, then the reconstructed surface's.
pub const MOTION_FRAGMENT: [&str; 2] = ["fs_impostor_motion", "fs_impostor_motion_depth"];
/// The impostor group's index in every impostor pipeline.
pub const IMPOSTOR_GROUP: u32 = 2;
/// The motion node's group's index in the impostor's motion prepass.
pub const IMPOSTOR_MOTION_GROUP: u32 = 3;
/// The species rows one draw addresses (`GX_IMPOSTOR_SPECIES_MAX`): every class's cap fits.
pub const IMPOSTOR_SPECIES_MAX: usize = 16;
/// The ledger label of the placed impostors' tables (species rows and instances).
pub const IMPOSTOR_DRAW_LEDGER_LABEL: &str = "impostor/draw";
/// Vertices of an impostor's quad (a strip).
const QUAD_VERTICES: u32 = 4;
/// The instance table's first size, in rows (it doubles as instances are added).
const INSTANCE_ROWS_MIN: u64 = 64;

/// Whether `class` writes the reconstructed surface's depth (`frag_depth`): desktop high and
/// ultra only. Below, the quad's flat depth keeps early depth testing (tile GPUs, the web's
/// medium).
pub const fn writes_depth(class: ImpostorClass) -> bool {
    matches!(class, ImpostorClass::Ultra | ImpostorClass::High)
}

/// The class whose sizes `spec` is (None for a spec no class has).
pub fn class_of(spec: &ImpostorSpec) -> Option<ImpostorClass> {
    ImpostorClass::ALL.into_iter().find(|class| class.spec() == *spec)
}

/// One placed impostor: species `species` (its row in [`super::bake::ImpostorStage::species`],
/// its atlas layer) at `model`, fading by `fade` (1 whole).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ImpostorInstance {
    /// Object to world, column-major.
    pub model: [f32; 16],
    /// The species' row.
    pub species: u32,
    /// The LOD fade: 1 whole; in (0, 1) fading out, keeping that share of pixels; in (-1, 0)
    /// fading in, keeping the share the matching fade-out leaves (`gx_lod_fade_keeps`).
    pub fade: f32,
}

impl ImpostorInstance {
    /// A whole impostor of species `species` at `model`.
    pub fn new(model: [f32; 16], species: u32) -> ImpostorInstance {
        ImpostorInstance { model, species, fade: 1.0 }
    }
}

/// `GxImpostorInstance` in draw.wgsl (144 bytes).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuImpostorInstance {
    /// Object to world, column-major.
    pub model: [f32; 16],
    /// World to object (the eye in the object's space; normals by its transpose).
    pub inverse: [f32; 16],
    /// The species' row.
    pub species: u32,
    /// The LOD fade (1 whole).
    pub fade: f32,
    /// Padding to 16 bytes.
    pub pad: [u32; 2],
}

impl GpuImpostorInstance {
    /// The row of `instance`; None when its model has no inverse or is not finite (an instance
    /// that cannot be drawn is skipped, never drawn inside out).
    pub fn of(instance: &ImpostorInstance) -> Option<GpuImpostorInstance> {
        let model = glam::Mat4::from_cols_array(&instance.model);
        let determinant = model.determinant();
        if !model.is_finite() || !determinant.is_normal() {
            return None;
        }
        let fade = if instance.fade.is_finite() { instance.fade.clamp(-1.0, 1.0) } else { 1.0 };
        Some(GpuImpostorInstance { model: instance.model, inverse: model.inverse().to_cols_array(), species: instance.species, fade, pad: [0; 2] })
    }
}

/// The impostor group's layout (group 2 of every impostor pipeline): the species rows (uniform,
/// vertex and fragment), the instances (storage, vertex only), the three atlas arrays and their
/// sampler (fragment). Its fragment stage adds no storage buffer.
pub fn impostor_layout_entries() -> Vec<BindGroupLayoutEntry> {
    let atlas = |binding| BindGroupLayoutEntry {
        binding,
        visibility: ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: true },
            view_dimension: wgpu::TextureViewDimension::D2Array,
            multisampled: false,
        },
        count: None,
    };
    vec![
        crate::tables::uniform(0, false, ShaderStages::VERTEX_FRAGMENT),
        crate::tables::storage(1, true, ShaderStages::VERTEX),
        atlas(2),
        atlas(3),
        atlas(4),
        BindGroupLayoutEntry { binding: 5, visibility: ShaderStages::FRAGMENT, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
    ]
}

/// What the world pass's impostor pipeline is made for.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WorldKey {
    /// The scene target's format.
    pub format: TextureFormat,
    /// Reversed depth.
    pub reversed: bool,
    /// The world pass's samples.
    pub samples: u32,
    /// Whether the world pass tests `Equal` against the prepass depth.
    pub equal: bool,
    /// Whether the fragments write the reconstructed surface's depth.
    pub depth: bool,
    /// Whether a frame takes its parallax step.
    pub parallax: bool,
}

/// What the prepass's impostor pipeline is made for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PrepassKey {
    /// Reversed depth.
    pub reversed: bool,
    /// The motion prepass.
    pub motion: bool,
    /// Whether the fragments write the reconstructed surface's depth.
    pub depth: bool,
    /// Whether a frame takes its parallax step.
    pub parallax: bool,
}

/// The layouts and constants an impostor pipeline is made with (the renderer's).
pub struct PipelineInputs<'a> {
    /// Group 0: the forward frame group without the material arrays.
    pub frame: &'a BindGroupLayout,
    /// Group 1: the pass view.
    pub pass: &'a BindGroupLayout,
    /// Group 3 of the motion prepass: the motion node's.
    pub motion: Option<&'a BindGroupLayout>,
    /// The forward surface's override constants (the world pass only).
    pub constants: &'a [(&'a str, f64)],
    /// The depth state the pipeline tests and writes with.
    pub depth: wgpu::DepthStencilState,
}

/// The impostors placed this frame, their tables and group, and the pipelines that draw them.
pub struct ImpostorDraw {
    layout: BindGroupLayout,
    species: Buffer,
    instances: Option<Buffer>,
    sampler: wgpu::Sampler,
    group: Option<BindGroup>,
    /// The atlas arrays the group binds (a new bake's arrays rebuild it).
    bound: Option<wgpu::Texture>,
    rows: Vec<GpuImpostorInstance>,
    /// Rows changed since the last upload.
    dirty: bool,
    world: Option<(WorldKey, Compiled<RenderPipeline>)>,
    prepass: Option<(PrepassKey, Compiled<RenderPipeline>)>,
}

impl ImpostorDraw {
    /// The group layout, the species table and the atlas sampler on `device`.
    pub fn new(device: &Device) -> Result<ImpostorDraw, RenderError> {
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("impostor"), entries: &impostor_layout_entries() });
        let species = crate::tables::buffer(device, "impostor species", (IMPOSTOR_SPECIES_MAX * size_of::<GpuImpostor>()) as u64, BufferUsages::UNIFORM | BufferUsages::COPY_DST)?;
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("impostor atlas"),
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::MipmapFilterMode::Linear,
            ..Default::default()
        });
        Ok(ImpostorDraw { layout, species, instances: None, sampler, group: None, bound: None, rows: Vec::new(), dirty: false, world: None, prepass: None })
    }

    /// The impostor group's layout.
    pub fn layout(&self) -> &BindGroupLayout {
        &self.layout
    }

    /// Place `instances` (replacing the ones placed before). Returns how many can be drawn (an
    /// instance whose model has no inverse, or whose species is past
    /// [`IMPOSTOR_SPECIES_MAX`], is skipped).
    pub fn set_instances(&mut self, instances: &[ImpostorInstance]) -> usize {
        let rows: Vec<GpuImpostorInstance> = instances.iter().filter(|instance| (instance.species as usize) < IMPOSTOR_SPECIES_MAX).filter_map(GpuImpostorInstance::of).collect();
        if rows != self.rows {
            self.rows = rows;
            self.dirty = true;
        }
        self.rows.len()
    }

    /// The rows placed.
    pub fn rows(&self) -> &[GpuImpostorInstance] {
        &self.rows
    }

    /// Whether a frame draws impostors: some are placed and a species was baked.
    pub fn active(&self, species: &[GpuImpostor]) -> bool {
        !self.rows.is_empty() && !species.is_empty()
    }

    /// Upload the species rows and the instances, and bind `atlases` (rebuilding the group when
    /// the arrays or the instance table were replaced).
    pub fn prepare(&mut self, device: &Device, queue: &Queue, atlases: &ImpostorAtlases, species: &[GpuImpostor]) -> Result<(), RenderError> {
        let mut rows = [GpuImpostor::default(); IMPOSTOR_SPECIES_MAX];
        for (row, baked) in rows.iter_mut().zip(species) {
            *row = *baked;
        }
        queue.write_buffer(&self.species, 0, bytemuck::cast_slice(&rows));
        let needed = (self.rows.len().max(1) * size_of::<GpuImpostorInstance>()) as u64;
        if self.instances.as_ref().is_none_or(|buffer| buffer.size() < needed) {
            let size = needed.next_power_of_two().max(INSTANCE_ROWS_MIN * size_of::<GpuImpostorInstance>() as u64);
            self.instances = Some(crate::tables::buffer(device, "impostor instances", size, BufferUsages::STORAGE | BufferUsages::COPY_DST)?);
            self.group = None;
            self.dirty = true;
        }
        let Some(instances) = self.instances.as_ref() else { return Ok(()) };
        if self.dirty && !self.rows.is_empty() {
            queue.write_buffer(instances, 0, bytemuck::cast_slice(&self.rows));
            self.dirty = false;
        }
        if self.bound.as_ref() != Some(&atlases.textures[0]) {
            self.group = None;
        }
        if self.group.is_none() {
            let views: Vec<wgpu::TextureView> = atlases
                .textures
                .iter()
                .map(|texture| texture.create_view(&wgpu::TextureViewDescriptor { format: Some(ATLAS_FORMAT), dimension: Some(wgpu::TextureViewDimension::D2Array), ..Default::default() }))
                .collect();
            self.group = Some(device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("impostor"),
                layout: &self.layout,
                entries: &[
                    crate::tables::entry(0, &self.species),
                    crate::tables::entry(1, instances),
                    wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&views[0]) },
                    wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(&views[1]) },
                    wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::TextureView(&views[2]) },
                    wgpu::BindGroupEntry { binding: 5, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                ],
            }));
            self.bound = Some(atlases.textures[0].clone());
        }
        Ok(())
    }

    /// Make the world pass's pipeline for `key` unless it is made.
    pub fn ensure_world(&mut self, device: &Device, key: WorldKey, inputs: &PipelineInputs<'_>) -> Result<(), RenderError> {
        if self.world.as_ref().is_none_or(|(made, _)| *made != key) {
            let pipeline = self.world_pipeline(device, &key, inputs)?;
            self.world = Some((key, pipeline));
        }
        Ok(())
    }

    /// Make the prepass's pipeline for `key` unless it is made.
    pub fn ensure_prepass(&mut self, device: &Device, key: PrepassKey, inputs: &PipelineInputs<'_>) -> Result<(), RenderError> {
        if self.prepass.as_ref().is_none_or(|(made, _)| *made != key) {
            let pipeline = self.prepass_pipeline(device, key, inputs)?;
            self.prepass = Some((key, pipeline));
        }
        Ok(())
    }

    /// The world pass's pipeline key made last.
    pub fn world_key(&self) -> Option<WorldKey> {
        self.world.as_ref().map(|(key, _)| *key)
    }

    /// The prepass's pipeline key made last.
    pub fn prepass_key(&self) -> Option<PrepassKey> {
        self.prepass.as_ref().map(|(key, _)| *key)
    }

    fn world_pipeline(&self, device: &Device, key: &WorldKey, inputs: &PipelineInputs<'_>) -> Result<Compiled<RenderPipeline>, RenderError> {
        let module = crate::shaders::module(device, "impostor", IMPOSTOR_DRAW)?;
        let layout = crate::tables::pipeline_layout(device, "impostor", &[inputs.frame, inputs.pass, &self.layout]);
        let mut constants = inputs.constants.to_vec();
        constants.push(("GX_IMPOSTOR_PARALLAX", f64::from(u8::from(key.parallax))));
        let targets = [Some(wgpu::ColorTargetState { format: key.format, blend: None, write_mask: wgpu::ColorWrites::ALL })];
        let spec = Spec {
            label: "impostor",
            module: &module,
            entries: (VERTEX_ENTRY, FORWARD_FRAGMENT[usize::from(key.depth)]),
            layout: &layout,
            targets: &targets,
            depth: inputs.depth.clone(),
            samples: if key.equal { 1 } else { key.samples },
            constants: &constants,
        };
        Ok(pipeline(device, &spec))
    }

    fn prepass_pipeline(&self, device: &Device, key: PrepassKey, inputs: &PipelineInputs<'_>) -> Result<Compiled<RenderPipeline>, RenderError> {
        let module = crate::shaders::module(device, "impostor", IMPOSTOR_DRAW)?;
        let motion = inputs.motion.filter(|_| key.motion);
        let layout = match motion {
            Some(node) => crate::tables::pipeline_layout(device, "impostor motion", &[inputs.frame, inputs.pass, &self.layout, node]),
            None => crate::tables::pipeline_layout(device, "impostor prepass", &[inputs.frame, inputs.pass, &self.layout]),
        };
        let normals = [Some(wgpu::ColorTargetState { format: crate::prepass::NORMALS_FORMAT, blend: None, write_mask: wgpu::ColorWrites::ALL })];
        let all = crate::motion::TARGET_FORMATS.map(|format| Some(wgpu::ColorTargetState { format, blend: None, write_mask: wgpu::ColorWrites::ALL }));
        let at = usize::from(key.depth);
        let constants = [("GX_IMPOSTOR_PARALLAX", f64::from(u8::from(key.parallax)))];
        let spec = Spec {
            label: if motion.is_some() { "impostor motion" } else { "impostor prepass" },
            module: &module,
            entries: if motion.is_some() { (MOTION_VERTEX_ENTRY, MOTION_FRAGMENT[at]) } else { (VERTEX_ENTRY, PREPASS_FRAGMENT[at]) },
            layout: &layout,
            targets: if motion.is_some() { &all } else { &normals },
            depth: inputs.depth.clone(),
            samples: 1,
            constants: &constants,
        };
        Ok(pipeline(device, &spec))
    }

    /// The placed impostors in the world pass (`pass`, groups 0 and 1 bound by the caller with
    /// the impostor frame group and the pass view). Returns the draws recorded.
    pub fn draw(&self, pass: &mut RenderPass<'_>) -> u32 {
        let (Some(group), Some((_, pipeline))) = (self.group.as_ref(), self.world.as_ref()) else { return 0 };
        self.record(pass, pipeline, group)
    }

    /// The placed impostors in the prepass (`motion`: the motion prepass, its group bound by the
    /// caller at [`IMPOSTOR_MOTION_GROUP`]). Returns the draws recorded.
    pub fn draw_prepass(&self, pass: &mut RenderPass<'_>, motion: bool) -> u32 {
        let (Some(group), Some((key, pipeline))) = (self.group.as_ref(), self.prepass.as_ref()) else { return 0 };
        if key.motion != motion {
            return 0;
        }
        self.record(pass, pipeline, group)
    }

    fn record(&self, pass: &mut RenderPass<'_>, pipeline: &RenderPipeline, group: &BindGroup) -> u32 {
        if self.rows.is_empty() {
            return 0;
        }
        pass.set_pipeline(pipeline);
        pass.set_bind_group(IMPOSTOR_GROUP, group, &[]);
        pass.draw(0..QUAD_VERTICES, 0..self.rows.len() as u32);
        1
    }

    /// The bytes the impostor tables hold on the GPU.
    pub fn bytes(&self) -> u64 {
        self.species.size() + self.instances.as_ref().map_or(0, Buffer::size)
    }
}

/// The parts of an impostor pipeline its passes choose.
struct Spec<'a> {
    label: &'a str,
    module: &'a wgpu::ShaderModule,
    entries: (&'a str, &'a str),
    layout: &'a wgpu::PipelineLayout,
    targets: &'a [Option<wgpu::ColorTargetState>],
    depth: wgpu::DepthStencilState,
    samples: u32,
    constants: &'a [(&'a str, f64)],
}

/// The quad: a strip, one face (it always faces the camera).
const QUAD_PRIMITIVE: wgpu::PrimitiveState =
    wgpu::PrimitiveState { topology: wgpu::PrimitiveTopology::TriangleStrip, strip_index_format: None, front_face: wgpu::FrontFace::Ccw, cull_mode: None, unclipped_depth: false, polygon_mode: wgpu::PolygonMode::Fill, conservative: false };

fn pipeline(device: &Device, spec: &Spec<'_>) -> Compiled<RenderPipeline> {
    let options = wgpu::PipelineCompilationOptions { constants: spec.constants, ..Default::default() };
    crate::compile::render_pipeline(device, &wgpu::RenderPipelineDescriptor {
        label: Some(spec.label),
        layout: Some(spec.layout),
        vertex: wgpu::VertexState { module: spec.module, entry_point: Some(spec.entries.0), compilation_options: options.clone(), buffers: &[] },
        primitive: QUAD_PRIMITIVE,
        depth_stencil: Some(spec.depth.clone()),
        multisample: wgpu::MultisampleState { count: spec.samples, ..Default::default() },
        fragment: Some(wgpu::FragmentState { module: spec.module, entry_point: Some(spec.entries.1), compilation_options: options, targets: spec.targets }),
        multiview_mask: None,
        cache: None,
    })
}
