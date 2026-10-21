//! Vertex-shader skinning's pipelines and draws (game systems AN-18; `crate::skin_vertex`): the
//! far skinned parts drawn directly from the library's bind-pose vertices, each part one direct
//! draw whose instance index names its record in the vertex skin table, in three nodes:
//!
//! - **Shadows (node 6)**: into every drawn cascade, the casters' bias and pancaking.
//! - **Prepass (node 7)**: depth and normals, with motion from last frame's palette on frames
//!   writing motion (the motion node's group at group 2, the tables at group 3).
//! - **Opaque (node 12)**: shaded by the forward fragment, `Equal` against the prepass depth where
//!   the world pass reuses it.
//!
//! A frame with no part on the path compiles, allocates and costs nothing here.

use wgpu::{BindGroup, BindGroupLayout, Buffer, BufferUsages, RenderPass, RenderPipeline, TextureFormat};

use super::{FramePrep, FramePrepass, PipelineSpec, Renderer, ScenePath, SurfaceKey, depth_state, mesh_buffers_layout, render_pipeline, render_pipeline_with, shader, surface_constants};
use crate::compile::Compiled;
use crate::error::RenderError;
use crate::settings::ShadowFormat;
use crate::settle::HistorySet;
use crate::shadow::{CASTER_CONSTANT_BIAS, CASTER_SLOPE_BIAS, CasterDepth, DEPTH16_UNIT};
use crate::skin_vertex::{
    FORWARD_ENTRIES, MOTION_ENTRIES, PREPASS_ENTRIES, SHADOW_VERTEX_ENTRY, SKIN_VERTEX, SKIN_VERTEX_GROUP, SKIN_VERTEX_PREPASS, SKIN_VERTEX_PREPASS_GROUP, SKIN_VERTEX_SHADOW, SkinVertexFrame, SkinVertexHistory, SkinVertexPolicy,
};
use crate::tables::{buffer, entry, pipeline_layout, storage};

/// The vertex skin table's first size: it grows by powers of two from here.
const TABLE_MIN_BYTES: u64 = 4096;
/// The vertex skin table's ledger label.
pub const SKIN_VERTEX_LEDGER_LABEL: &str = "vertex skin table";

/// What the world pass's pipeline is made for.
#[derive(Clone, Copy, Debug, PartialEq)]
struct WorldKey {
    format: TextureFormat,
    reversed: bool,
    samples: u32,
    surface: SurfaceKey,
    /// Whether the world pass tests `Equal` against the prepass depth (which holds these draws).
    equal: bool,
}

/// What the prepass's pipeline is made for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PrepassKey {
    reversed: bool,
    motion: bool,
}

/// The path's GPU state: the tables' layout, an empty group for the prepass's group 2 on frames
/// without motion, the table and its group, this frame's draws and the pipelines (each made on the
/// first frame that draws it).
#[derive(Default)]
pub(super) struct SkinVertexGpu {
    /// Which draws take the path.
    pub(super) policy: SkinVertexPolicy,
    /// What the last frame skinned on each path, and its compute cap (AN-23).
    pub(super) instances: crate::skin_vertex::SkinnedInstances,
    /// Live's and a settled capture's history (their motion).
    history: [SkinVertexHistory; 2],
    layouts: Option<(BindGroupLayout, BindGroupLayout, BindGroup)>,
    table: Option<Buffer>,
    /// The tables' group, and the skin-row and table buffers it was made over.
    group: Option<(BindGroup, Buffer, Buffer)>,
    draws: Vec<crate::skin_vertex::SkinVertexDraw>,
    world: Option<(WorldKey, Compiled<RenderPipeline>)>,
    prepass: Option<(PrepassKey, Compiled<RenderPipeline>)>,
    /// The casters into `depth32float` and `depth16unorm` maps.
    casters: Option<[Compiled<RenderPipeline>; 2]>,
}

impl SkinVertexGpu {
    /// The bytes the table holds (0: none).
    pub(super) fn bytes(&self) -> u64 {
        self.table.as_ref().map_or(0, Buffer::size)
    }

    /// Forget every draw's history (a reset of history set `set`, or both with None).
    pub(super) fn forget(&mut self, set: Option<HistorySet>) {
        match set {
            Some(set) => self.history[history_at(set)].forget(),
            None => self.history.iter_mut().for_each(SkinVertexHistory::forget),
        }
    }
}

fn history_at(set: HistorySet) -> usize {
    usize::from(set != HistorySet::Live)
}

/// The tables' layout at any group: the skin rows and the vertex skin table, vertex stage only.
fn tables_layout(device: &wgpu::Device) -> BindGroupLayout {
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("vertex skin tables"),
        entries: &[storage(0, true, wgpu::ShaderStages::VERTEX), storage(1, true, wgpu::ShaderStages::VERTEX)],
    })
}

impl Renderer {
    /// Which skinned draws skin in the vertex stage from the next frame on (game systems AN-18;
    /// [`SkinVertexPolicy::Auto`] by default).
    pub fn set_skin_vertex_policy(&mut self, policy: SkinVertexPolicy) {
        self.skin_vertex.policy = policy;
    }

    /// The direct draws the last frame skinned in the vertex stage.
    pub fn last_vertex_skinned_draws(&self) -> usize {
        self.skin_vertex.draws.len()
    }

    /// The skinned instances the last frame skinned by compute and in the vertex stage, and the
    /// device class's compute cap it held them to (game systems AN-23).
    pub fn last_skinned_instances(&self) -> crate::skin_vertex::SkinnedInstances {
        self.skin_vertex.instances
    }

    /// The most skinned instances a frame skins by compute on this renderer's device class
    /// ([`crate::presets::skinned_compute_instances_max`]); None (no cap) before a class is set.
    pub fn skinned_compute_max(&self) -> Option<u32> {
        self.class.map(|class| crate::presets::skinned_compute_instances_max(class, crate::device_class::TargetOs::current()))
    }

    /// This frame's vertex skin table for `plan` over `scene` (its history set `set`, from scratch
    /// on a `reset`), uploaded, and its group made.
    pub(super) fn prepare_skin_vertex_frame(&mut self, scene: &crate::scene::Scene, plan: &crate::scene::FramePlan, set: HistorySet, reset: bool) -> Result<(), RenderError> {
        if reset {
            self.skin_vertex.forget(Some(set));
        }
        let history = &mut self.skin_vertex.history[history_at(set)];
        let SkinVertexFrame { draws, table } = crate::skin_vertex::build_frame(scene, &self.library, plan, history);
        self.skin_vertex.draws = draws;
        if self.skin_vertex.draws.is_empty() {
            return Ok(());
        }
        let bytes: &[u8] = bytemuck::cast_slice(&table);
        let held = self.skin_vertex.table.as_ref().map_or(0, Buffer::size);
        if held < bytes.len() as u64 {
            let size = (bytes.len() as u64).next_power_of_two().max(TABLE_MIN_BYTES);
            self.skin_vertex.table = Some(buffer(&self.device, SKIN_VERTEX_LEDGER_LABEL, size, BufferUsages::STORAGE | BufferUsages::COPY_DST)?);
        }
        let Some(table) = self.skin_vertex.table.clone() else { return Ok(()) };
        self.queue.write_buffer(&table, 0, bytes);
        if self.skin_vertex.layouts.is_none() {
            let empty = self.device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("vertex skin empty"), entries: &[] });
            let empty_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("vertex skin empty"), layout: &empty, entries: &[] });
            self.skin_vertex.layouts = Some((tables_layout(&self.device), empty, empty_group));
        }
        let skin = self.meshes.skin.clone();
        let made_over = |(_, rows, held): &(BindGroup, Buffer, Buffer)| *rows == skin && *held == table;
        if !self.skin_vertex.group.as_ref().is_some_and(made_over) {
            let Some((layout, _, _)) = self.skin_vertex.layouts.as_ref() else { return Ok(()) };
            let group = self.device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("vertex skin tables"), layout, entries: &[entry(0, &skin), entry(1, &table)] });
            self.skin_vertex.group = Some((group, skin, table));
        }
        Ok(())
    }

    /// The pipelines `path` and the frame's `prepass` (motion when `motion`) draw this frame's
    /// vertex-skinned parts with.
    pub(super) fn prepare_skin_vertex(&mut self, plan: &crate::scene::FramePlan, path: &ScenePath, prepass: Option<&FramePrepass>, motion: bool) -> Result<(), RenderError> {
        if self.skin_vertex.draws.is_empty() {
            return Ok(());
        }
        let surface = self.surface_key(path.hdr);
        let world = WorldKey { format: path.format, reversed: path.depth_reversed, samples: self.samples, surface, equal: prepass.is_some_and(|prepass| prepass.equal) };
        if self.skin_vertex.world.as_ref().is_none_or(|(made, _)| *made != world) {
            let pipeline = self.skin_vertex_world_pipeline(&world)?;
            self.skin_vertex.world = Some((world, pipeline));
        }
        if prepass.is_some() {
            let key = PrepassKey { reversed: path.depth_reversed, motion };
            if self.skin_vertex.prepass.as_ref().is_none_or(|(made, _)| *made != key) {
                let pipeline = self.skin_vertex_prepass_pipeline(key)?;
                self.skin_vertex.prepass = Some((key, pipeline));
            }
        }
        if plan.cascades.is_some() && self.skin_vertex.casters.is_none() {
            let caster = |format: ShadowFormat| self.skin_vertex_caster_pipeline(format.texture_format());
            self.skin_vertex.casters = Some([caster(ShadowFormat::Depth32)?, caster(ShadowFormat::Depth16)?]);
        }
        Ok(())
    }

    fn skin_vertex_layouts(&self) -> Result<&(BindGroupLayout, BindGroupLayout, BindGroup), RenderError> {
        self.skin_vertex.layouts.as_ref().ok_or_else(|| RenderError::refused(crate::error::RenderCode::MeshInvalid, "vertex skinning: no tables".to_owned()))
    }

    fn skin_vertex_world_pipeline(&self, key: &WorldKey) -> Result<Compiled<RenderPipeline>, RenderError> {
        let module = shader(&self.device, "skin vertex", SKIN_VERTEX)?;
        let (tables, _, _) = self.skin_vertex_layouts()?;
        let layout = pipeline_layout(&self.device, "skin vertex", &[&self.layouts.frame, &self.layouts.pass, tables]);
        let equal = wgpu::DepthStencilState { depth_compare: Some(wgpu::CompareFunction::Equal), ..depth_state(false, key.reversed) };
        let meshes = mesh_buffers_layout();
        let spec = PipelineSpec {
            label: "skin vertex",
            module: &module,
            vertex: FORWARD_ENTRIES.0,
            fragment: Some(FORWARD_ENTRIES.1),
            buffers: &meshes,
            topology: wgpu::PrimitiveTopology::TriangleList,
            depth: Some(if key.equal { equal } else { depth_state(true, key.reversed) }),
            format: key.format,
            blend: None,
            samples: if key.equal { 1 } else { key.samples },
            layout: &layout,
        };
        Ok(render_pipeline_with(&self.device, &spec, &surface_constants(key.reversed, key.format, key.surface)))
    }

    fn skin_vertex_prepass_pipeline(&self, key: PrepassKey) -> Result<Compiled<RenderPipeline>, RenderError> {
        let module = shader(&self.device, "skin vertex prepass", SKIN_VERTEX_PREPASS)?;
        let (tables, empty, _) = self.skin_vertex_layouts()?;
        let meshes = mesh_buffers_layout();
        let motion = self.motion_node.as_ref().filter(|_| key.motion);
        let Some(node) = motion else {
            let layout = pipeline_layout(&self.device, "skin vertex prepass", &[&self.layouts.frame, &self.layouts.pass, empty, tables]);
            let spec = PipelineSpec {
                label: "skin vertex prepass",
                module: &module,
                vertex: PREPASS_ENTRIES.0,
                fragment: Some(PREPASS_ENTRIES.1),
                buffers: &meshes,
                topology: wgpu::PrimitiveTopology::TriangleList,
                depth: Some(depth_state(true, key.reversed)),
                format: crate::prepass::NORMALS_FORMAT,
                blend: None,
                samples: 1,
                layout: &layout,
            };
            return Ok(render_pipeline(&self.device, &spec));
        };
        let layout = pipeline_layout(&self.device, "skin vertex motion", &[&self.layouts.frame, &self.layouts.pass, node.layout(), tables]);
        let targets = crate::motion::TARGET_FORMATS.map(|format| Some(wgpu::ColorTargetState { format, blend: None, write_mask: wgpu::ColorWrites::ALL }));
        Ok(crate::compile::render_pipeline(&self.device, &wgpu::RenderPipelineDescriptor {
            label: Some("skin vertex motion"),
            layout: Some(&layout),
            vertex: wgpu::VertexState { module: &module, entry_point: Some(MOTION_ENTRIES.0), compilation_options: Default::default(), buffers: &meshes },
            primitive: wgpu::PrimitiveState { cull_mode: Some(wgpu::Face::Back), ..Default::default() },
            depth_stencil: Some(depth_state(true, key.reversed)),
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some(MOTION_ENTRIES.1), compilation_options: Default::default(), targets: &targets }),
            multiview_mask: None,
            cache: None,
        }))
    }

    /// The casters' pipeline into a `format` map: depth only, back faces culled, the casters' bias
    /// (`shadow::caster_pipeline`'s).
    fn skin_vertex_caster_pipeline(&self, format: TextureFormat) -> Result<Compiled<RenderPipeline>, RenderError> {
        let module = shader(&self.device, "skin vertex shadow", SKIN_VERTEX_SHADOW)?;
        let (tables, _, _) = self.skin_vertex_layouts()?;
        let layout = pipeline_layout(&self.device, "skin vertex shadow", &[&self.layouts.shadow, &self.layouts.pass, tables]);
        let unclipped = self.casters == CasterDepth::Unclipped;
        let unit = if format == TextureFormat::Depth16Unorm { DEPTH16_UNIT } else { 0.0 };
        let constants = [
            ("GX_UNCLIPPED_DEPTH", f64::from(u8::from(unclipped))),
            ("GX_SHADOW_DEPTH_UNIT", unit),
            ("GX_SHADOW_BIAS_CONSTANT", f64::from(CASTER_CONSTANT_BIAS)),
            ("GX_SHADOW_BIAS_SLOPE", f64::from(CASTER_SLOPE_BIAS)),
        ];
        let options = wgpu::PipelineCompilationOptions { constants: &constants, ..Default::default() };
        // A fragment that writes its depth gets no hardware bias: `fs_shadow_caster` applies it.
        let bias = if unclipped { wgpu::DepthBiasState { constant: CASTER_CONSTANT_BIAS, slope_scale: CASTER_SLOPE_BIAS, clamp: 0.0 } } else { wgpu::DepthBiasState::default() };
        let fragment = (!unclipped).then(|| wgpu::FragmentState { module: &module, entry_point: Some("fs_shadow_caster"), compilation_options: options.clone(), targets: &[] });
        let meshes = mesh_buffers_layout();
        Ok(crate::compile::render_pipeline(&self.device, &wgpu::RenderPipelineDescriptor {
            label: Some("skin vertex shadow"),
            layout: Some(&layout),
            vertex: wgpu::VertexState { module: &module, entry_point: Some(SHADOW_VERTEX_ENTRY), compilation_options: options, buffers: &meshes },
            primitive: wgpu::PrimitiveState { cull_mode: Some(wgpu::Face::Back), unclipped_depth: unclipped, ..Default::default() },
            depth_stencil: Some(wgpu::DepthStencilState {
                format,
                depth_write_enabled: Some(true),
                depth_compare: Some(wgpu::CompareFunction::Less),
                stencil: wgpu::StencilState::default(),
                bias,
            }),
            multisample: wgpu::MultisampleState::default(),
            fragment,
            multiview_mask: None,
            cache: None,
        }))
    }

    /// The direct draws, their library buffers bound on `pass` (its pipeline and groups set).
    fn draw_skin_vertex_parts(&self, pass: &mut RenderPass<'_>) -> u32 {
        pass.set_vertex_buffer(0, self.meshes.vertices.slice(..));
        pass.set_vertex_buffer(1, self.meshes.slots.slice(..));
        pass.set_index_buffer(self.meshes.indices.slice(..), wgpu::IndexFormat::Uint32);
        for draw in &self.skin_vertex.draws {
            pass.draw_indexed(draw.first_index..draw.first_index + draw.index_count, draw.base_vertex, draw.record..draw.record + 1);
        }
        self.skin_vertex.draws.len() as u32
    }

    fn skin_vertex_group(&self) -> Option<&BindGroup> {
        self.skin_vertex.group.as_ref().map(|(group, _, _)| group).filter(|_| !self.skin_vertex.draws.is_empty())
    }

    /// The parts' casters into cascade `cascade`'s map (`pass`).
    pub(super) fn draw_skin_vertex_casters(&self, pass: &mut RenderPass<'_>, prep: &FramePrep, cascade: usize) -> u32 {
        let (Some(group), Some(casters)) = (self.skin_vertex_group(), self.skin_vertex.casters.as_ref()) else { return 0 };
        let view = 1 + cascade as u32;
        let at = usize::from(self.shadow_desc.format == ShadowFormat::Depth16.texture_format());
        pass.set_pipeline(&casters[at]);
        pass.set_bind_group(0, &prep.groups.shadow, &[]);
        pass.set_bind_group(1, &prep.groups.pass, &[(u64::from(view) * crate::tables::PASS_VIEW_STRIDE) as u32]);
        pass.set_bind_group(SKIN_VERTEX_GROUP, group, &[]);
        self.draw_skin_vertex_parts(pass)
    }

    /// The parts' depth and normals (and motion: `motion` the motion node's group) into the
    /// prepass (`pass`).
    pub(super) fn draw_skin_vertex_prepass(&self, pass: &mut RenderPass<'_>, prep: &FramePrep, motion: Option<&BindGroup>) -> u32 {
        let (Some(group), Some((key, pipeline)), Some((_, _, empty))) = (self.skin_vertex_group(), self.skin_vertex.prepass.as_ref(), self.skin_vertex.layouts.as_ref()) else { return 0 };
        if key.motion != motion.is_some() {
            return 0;
        }
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &prep.groups.frame, &[]);
        pass.set_bind_group(1, &prep.groups.pass, &[0]);
        pass.set_bind_group(2, motion.unwrap_or(empty), &[]);
        pass.set_bind_group(SKIN_VERTEX_PREPASS_GROUP, group, &[]);
        self.draw_skin_vertex_parts(pass)
    }

    /// The parts in the world pass (`pass`) with the frame's `frame` and `pass_views` groups.
    pub(super) fn draw_skin_vertex(&self, pass: &mut RenderPass<'_>, frame: &BindGroup, pass_views: &BindGroup) -> u32 {
        let (Some(group), Some((_, pipeline))) = (self.skin_vertex_group(), self.skin_vertex.world.as_ref()) else { return 0 };
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, frame, &[]);
        pass.set_bind_group(1, pass_views, &[0]);
        pass.set_bind_group(SKIN_VERTEX_GROUP, group, &[]);
        self.draw_skin_vertex_parts(pass)
    }
}
