//! The terrain's pipelines and draws (renderer pass 2 A.7; `crate::terrain`): a built-in pipeline
//! of its own over the forward frame group, the pass view and the terrain group (group 2), drawn
//! in three of the frame's nodes:
//!
//! - **Shadows (node 6)**: each drawn cascade's casters, the camera's selection culled by the
//!   cascade's frustum (`vs_terrain_shadow`, the casters' bias and pancaking as every caster's).
//! - **Prepass (node 7)**: the depth and the per-pixel normal, with the camera's motion on frames
//!   writing motion (the motion node's group at group 3), so AO, contact shadows, the sun mask, TAA
//!   and the Hi-Z see the ground.
//! - **Opaque (node 12)**: the splat surface lit like every built-in surface, after the opaque
//!   batches; it tests `Equal` against the prepass depth where the world pass reuses it, as the
//!   batches do.
//!
//! A frame without a terrain draws, compiles and costs what it did before.

use wgpu::{RenderPass, RenderPipeline, TextureFormat};

use super::{FramePrep, FramePrepass, Renderer, ScenePath, SurfaceKey, depth_state, shader, surface_constants};
use crate::compile::Compiled;
use crate::error::RenderError;
use crate::gpu::Gpu;
use crate::settings::ShadowFormat;
use crate::shadow::{CasterSpec, caster_pipeline};
use crate::tables::pipeline_layout;
use crate::terrain::gpu::{
    DETILE_CONSTANT, FORWARD_ENTRIES, MOTION_ENTRIES, PREPASS_ENTRIES, SHADOW_VERTEX_ENTRY, TERRAIN, TERRAIN_MOTION_GROUP, TERRAIN_SHADOW, TerrainGpu,
};
use crate::terrain::{TerrainDesc, TerrainFrame, TerrainQuality};

/// What the world pass's terrain pipeline is made for.
#[derive(Clone, Copy, Debug, PartialEq)]
struct WorldKey {
    format: TextureFormat,
    reversed: bool,
    samples: u32,
    surface: SurfaceKey,
    /// Whether the world pass tests `Equal` against the prepass depth (which holds the terrain).
    equal: bool,
    detile: bool,
}

/// What the prepass's terrain pipeline is made for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PrepassKey {
    reversed: bool,
    motion: bool,
}

/// The terrain's pipelines, made on the first frame that draws each (dropped with the terrain).
#[derive(Default)]
pub(super) struct TerrainPipelines {
    /// The detail asked over the quality's ([`Renderer::set_terrain_detail`]).
    detail: Option<f32>,
    world: Option<(WorldKey, Compiled<RenderPipeline>)>,
    prepass: Option<(PrepassKey, Compiled<RenderPipeline>)>,
    /// The casters into `depth32float` and `depth16unorm` maps.
    casters: Option<[Compiled<RenderPipeline>; 2]>,
}

/// What the last frame drew of the terrain.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TerrainStats {
    /// Rows the selection picked (before any view's cull).
    pub selected: u32,
    /// Rows the camera's view drew.
    pub camera_rows: u32,
    /// Rows every view drew (the camera's and each drawn cascade's).
    pub rows: u32,
    /// Levels of detail the terrain has.
    pub lods: u32,
}

/// The parts of a terrain pipeline its passes choose.
struct TerrainSpec<'a> {
    label: &'a str,
    module: &'a wgpu::ShaderModule,
    entries: (&'a str, &'a str),
    layout: &'a wgpu::PipelineLayout,
    targets: &'a [Option<wgpu::ColorTargetState>],
    depth: wgpu::DepthStencilState,
    samples: u32,
    constants: &'a [(&'a str, f64)],
}

fn terrain_pipeline(device: &wgpu::Device, spec: &TerrainSpec<'_>) -> Compiled<RenderPipeline> {
    let options = wgpu::PipelineCompilationOptions { constants: spec.constants, ..Default::default() };
    crate::compile::render_pipeline(device, &wgpu::RenderPipelineDescriptor {
        label: Some(spec.label),
        layout: Some(spec.layout),
        vertex: wgpu::VertexState { module: spec.module, entry_point: Some(spec.entries.0), compilation_options: options.clone(), buffers: &[] },
        primitive: wgpu::PrimitiveState { cull_mode: Some(wgpu::Face::Back), ..Default::default() },
        depth_stencil: Some(spec.depth.clone()),
        multisample: wgpu::MultisampleState { count: spec.samples, ..Default::default() },
        fragment: Some(wgpu::FragmentState { module: spec.module, entry_point: Some(spec.entries.1), compilation_options: options, targets: spec.targets }),
        multiview_mask: None,
        cache: None,
    })
}

impl Renderer {
    /// Draw `terrain` from the next frame on (None: no terrain), its layers' textures already
    /// added ([`Renderer::add_texture`]). `version` names it: the same version is kept as it is.
    /// Refused `mesh-invalid` for a height field, control map, layer or grass it cannot draw. The
    /// grass its layers carry (A.8) comes and goes with it.
    pub fn set_terrain(&mut self, gpu: &Gpu, terrain: Option<(&TerrainDesc, u64)>) -> Result<(), RenderError> {
        let detail = self.terrain_pipelines.detail;
        let Some((desc, version)) = terrain else {
            self.terrain = None;
            self.terrain_pipelines = TerrainPipelines { detail, ..TerrainPipelines::default() };
            return self.set_grass(None);
        };
        if self.terrain.as_ref().is_some_and(|held| held.version() == version) {
            return Ok(());
        }
        let quality = self.terrain_quality();
        self.terrain = Some(TerrainGpu::new(&gpu.device, &gpu.queue, desc, quality, version)?);
        self.terrain_pipelines = TerrainPipelines { detail, ..TerrainPipelines::default() };
        self.set_grass(Some(desc))
    }

    /// How far the terrain's finest level reaches, as a multiple (at least 1) of the least
    /// crack-free range, over the quality's (None: the quality's, `TerrainQuality::of`). A large
    /// detail draws the whole view at the finest level: a reference without levels of detail.
    pub fn set_terrain_detail(&mut self, detail: Option<f32>) {
        self.terrain_pipelines.detail = detail;
    }

    /// The terrain quality frames draw with: the quality's, with the asked detail.
    fn terrain_quality(&self) -> TerrainQuality {
        let quality = TerrainQuality::of(&self.quality);
        TerrainQuality { detail: self.terrain_pipelines.detail.unwrap_or(quality.detail), ..quality }
    }

    /// The version of the terrain drawn (None: no terrain).
    pub fn terrain_version(&self) -> Option<u64> {
        self.terrain.as_ref().map(TerrainGpu::version)
    }

    /// What the last frame drew of the terrain (None: no terrain).
    pub fn terrain_stats(&self) -> Option<TerrainStats> {
        let terrain = self.terrain.as_ref()?;
        let frame: &TerrainFrame = terrain.frame();
        let camera_rows = frame.views.first().map_or(0, |view| view[1] + view[3]);
        Some(TerrainStats { selected: frame.selected, camera_rows, rows: frame.rows.len() as u32, lods: terrain.tree().lods() })
    }

    /// The last frame's terrain rows per view (None: no terrain).
    pub fn terrain_frame(&self) -> Option<&TerrainFrame> {
        self.terrain.as_ref().map(TerrainGpu::frame)
    }

    /// The bytes the terrain holds on the GPU (0: none).
    pub(super) fn terrain_bytes(&self) -> u64 {
        self.terrain.as_ref().map_or(0, TerrainGpu::bytes)
    }

    /// This frame's terrain rows (the camera's view, then each drawn cascade's) and the pipelines
    /// `path` and the frame's `prepass` (motion when `motion`) draw them with.
    pub(super) fn prepare_terrain(&mut self, plan: &crate::scene::FramePlan, path: &ScenePath, prepass: Option<&FramePrepass>, motion: bool) -> Result<(), RenderError> {
        let quality = self.terrain_quality();
        let Some(terrain) = self.terrain.as_mut() else { return Ok(()) };
        terrain.set_quality(&self.queue, quality);
        terrain.set_render_size(&self.queue, self.targets.render_size);
        let camera = [plan.frame.camera_pos[0], plan.frame.camera_pos[1], plan.frame.camera_pos[2]];
        let views = 1 + plan.cascades_drawn();
        terrain.prepare(&self.device, &self.queue, camera, &plan.cull_views.planes[..views])?;
        let detile = terrain.quality().detile;
        let surface = self.surface_key(path.hdr);
        let world = WorldKey { format: path.format, reversed: path.depth_reversed, samples: self.samples, surface, equal: prepass.is_some_and(|prepass| prepass.equal), detile };
        if self.terrain_pipelines.world.as_ref().is_none_or(|(made, _)| *made != world) {
            let pipeline = self.terrain_world_pipeline(&world)?;
            self.terrain_pipelines.world = Some((world, pipeline));
        }
        if prepass.is_some() {
            let key = PrepassKey { reversed: path.depth_reversed, motion };
            if self.terrain_pipelines.prepass.as_ref().is_none_or(|(made, _)| *made != key) {
                let pipeline = self.terrain_prepass_pipeline(key)?;
                self.terrain_pipelines.prepass = Some((key, pipeline));
            }
        }
        if plan.cascades.is_some() && self.terrain_pipelines.casters.is_none() {
            let caster = |format: ShadowFormat| self.terrain_caster_pipeline(format.texture_format());
            self.terrain_pipelines.casters = Some([caster(ShadowFormat::Depth32)?, caster(ShadowFormat::Depth16)?]);
        }
        Ok(())
    }

    fn terrain_layout(&self) -> Result<&wgpu::BindGroupLayout, RenderError> {
        self.terrain.as_ref().map(TerrainGpu::layout).ok_or_else(|| RenderError::refused(crate::error::RenderCode::MeshInvalid, "terrain: none held".to_owned()))
    }

    fn terrain_world_pipeline(&self, key: &WorldKey) -> Result<Compiled<RenderPipeline>, RenderError> {
        let module = shader(&self.device, "terrain", TERRAIN)?;
        let layout = pipeline_layout(&self.device, "terrain", &[&self.layouts.frame, &self.layouts.pass, self.terrain_layout()?]);
        let mut constants = surface_constants(key.reversed, key.format, key.surface).to_vec();
        constants.push((DETILE_CONSTANT, f64::from(u8::from(key.detile))));
        let writes = [Some(wgpu::ColorTargetState { format: key.format, blend: None, write_mask: wgpu::ColorWrites::ALL })];
        let equal = wgpu::DepthStencilState { depth_compare: Some(wgpu::CompareFunction::Equal), ..depth_state(false, key.reversed) };
        Ok(terrain_pipeline(&self.device, &TerrainSpec {
            label: "terrain",
            module: &module,
            entries: FORWARD_ENTRIES,
            layout: &layout,
            targets: &writes,
            depth: if key.equal { equal } else { depth_state(true, key.reversed) },
            samples: if key.equal { 1 } else { key.samples },
            constants: &constants,
        }))
    }

    fn terrain_prepass_pipeline(&self, key: PrepassKey) -> Result<Compiled<RenderPipeline>, RenderError> {
        let module = shader(&self.device, "terrain", TERRAIN)?;
        let terrain = self.terrain_layout()?;
        let motion = self.motion_node.as_ref().filter(|_| key.motion);
        let layout = match motion {
            Some(node) => pipeline_layout(&self.device, "terrain motion", &[&self.layouts.frame, &self.layouts.pass, terrain, node.layout()]),
            None => pipeline_layout(&self.device, "terrain prepass", &[&self.layouts.frame, &self.layouts.pass, terrain]),
        };
        let normals = [Some(wgpu::ColorTargetState { format: crate::prepass::NORMALS_FORMAT, blend: None, write_mask: wgpu::ColorWrites::ALL })];
        let all = crate::motion::TARGET_FORMATS.map(|format| Some(wgpu::ColorTargetState { format, blend: None, write_mask: wgpu::ColorWrites::ALL }));
        Ok(terrain_pipeline(&self.device, &TerrainSpec {
            label: if motion.is_some() { "terrain motion" } else { "terrain prepass" },
            module: &module,
            entries: if motion.is_some() { MOTION_ENTRIES } else { PREPASS_ENTRIES },
            layout: &layout,
            targets: if motion.is_some() { &all } else { &normals },
            depth: depth_state(true, key.reversed),
            samples: 1,
            constants: &[],
        }))
    }

    fn terrain_caster_pipeline(&self, format: TextureFormat) -> Result<Compiled<RenderPipeline>, RenderError> {
        let module = shader(&self.device, "terrain shadow", TERRAIN_SHADOW)?;
        let layout = pipeline_layout(&self.device, "terrain shadow", &[&self.layouts.shadow, &self.layouts.pass, self.terrain_layout()?]);
        let spec = CasterSpec { label: "terrain shadow", module: &module, vertex: SHADOW_VERTEX_ENTRY, buffers: &[], layout: &layout, format, depth: self.casters };
        Ok(caster_pipeline(&self.device, &spec))
    }

    /// The terrain's casters into cascade `cascade`'s map (`pass`, its groups not yet bound).
    pub(super) fn draw_terrain_casters(&self, pass: &mut RenderPass<'_>, prep: &FramePrep, cascade: usize) -> u32 {
        let (Some(terrain), Some(casters)) = (self.terrain.as_ref(), self.terrain_pipelines.casters.as_ref()) else { return 0 };
        let view = 1 + cascade as u32;
        let at = usize::from(self.shadow_desc.format == ShadowFormat::Depth16.texture_format());
        pass.set_pipeline(&casters[at]);
        pass.set_bind_group(0, &prep.groups.shadow, &[]);
        pass.set_bind_group(1, &prep.groups.pass, &[(u64::from(view) * crate::tables::PASS_VIEW_STRIDE) as u32]);
        terrain.draw(pass, view as usize)
    }

    /// The terrain's depth and normals (and motion: `motion` the motion node's group) into the
    /// prepass (`pass`); the library's index buffer is bound again after it.
    pub(super) fn draw_terrain_prepass(&self, pass: &mut RenderPass<'_>, prep: &FramePrep, motion: Option<&wgpu::BindGroup>) -> u32 {
        let (Some(terrain), Some((key, pipeline))) = (self.terrain.as_ref(), self.terrain_pipelines.prepass.as_ref()) else { return 0 };
        if key.motion != motion.is_some() {
            return 0;
        }
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &prep.groups.frame, &[]);
        pass.set_bind_group(1, &prep.groups.pass, &[0]);
        if let Some(group) = motion {
            pass.set_bind_group(TERRAIN_MOTION_GROUP, group, &[]);
        }
        let draws = terrain.draw(pass, 0);
        pass.set_index_buffer(self.meshes.indices.slice(..), wgpu::IndexFormat::Uint32);
        draws
    }

    /// The terrain's surface in the world pass (`pass`) with the frame's `frame` and `pass_views`
    /// groups; the library's index buffer is bound again after it.
    pub(super) fn draw_terrain(&self, pass: &mut RenderPass<'_>, frame: &wgpu::BindGroup, pass_views: &wgpu::BindGroup) -> u32 {
        let (Some(terrain), Some((_, pipeline))) = (self.terrain.as_ref(), self.terrain_pipelines.world.as_ref()) else { return 0 };
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, frame, &[]);
        pass.set_bind_group(1, pass_views, &[0]);
        let draws = terrain.draw(pass, 0);
        pass.set_index_buffer(self.meshes.indices.slice(..), wgpu::IndexFormat::Uint32);
        draws
    }
}
