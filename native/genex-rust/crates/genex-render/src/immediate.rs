//! Counted immediate primitives and the frame they make (M2.6).
//!
//! An [`ImmediateFrame`] records one rendered frame: 3D primitives (`cube`, `sphere`, `line`,
//! meshes, instanced meshes) into the part-1 [`Scene`]; 2D primitives (`rect`, `sprite`,
//! `line2d`) through the current [`Camera2d`]; custom-material draws, particle emitters and post
//! passes. A [`FrameRenderer`] draws it through the frame graph ([`crate::graph`]): the part-1
//! renderer's nodes (the world pass with custom materials and particles inside it, depth-tested),
//! then node 23 (the 2D quads, the post passes, Level-3 `post` passes) and node 24 (the HUD
//! overlay), all into the world target a capture reads.
//!
//! A shell paced by display refreshes draws through [`FrameRenderer::render_paced`] (RQ0.12,
//! [`crate::pacing`]): the graph runs only on frames that carry a sim tick, a repeat frame encodes
//! no node and re-presents the last world target ([`FrameRenderer::present_repeat`]); adaptation
//! moves by the ticks a frame ran.
//!
//! Temporal history (RQ1.5, [`crate::settle`]): Live frames draw on Live's history, whose frame
//! index counts drawn frames and starts over by the reset rules; a settled capture
//! ([`FrameRenderer::render_settled`], or [`FrameRenderer::begin_settle`] around a caller's own
//! re-renders) draws K re-renders on a capture-owned history, so Live never resets or pops when
//! something captures. The exposure node (graph node 20) is drawn here with the history of the
//! frame's set: it meters the resolved HDR scene before the tonemap and its exposure reaches the
//! next frame's frame uniforms (`FRAME_PRE_EXPOSURE_OFFSET`) before the scene passes.
//!
//! The HDR path (RQ1): a frame draws the HDR scene when the quality asks for it, the session's
//! scene format is HDR and nothing in the frame keeps it on the legacy scene (a v1 material,
//! [`FrameRenderer::ldr_reason`], or a v1 in-world custom pass, the stage's `ldr_reason`). Before
//! each frame the in-world pipelines (custom materials, particles, `hdr`-stage post passes) follow
//! what it draws ([`FrameRenderer::pipeline_facts`]); `hdr`-stage post passes and Level-3
//! `post-hdr` passes run on the HDR scene at graph node 18, before exposure and the tonemap, and
//! the `ldr` ones in node 23. On the legacy scene both run in node 23 over the world target.
//!
//! # The draw counter and `volatile.gpu` (for M3)
//!
//! `drawCalls` and `__render.tags` are **logical tagged draws**: every primitive call, instanced
//! call, custom draw, emitter and post pass is one draw under the tag current when it was made
//! ([`ImmediateFrame::tag`], default [`WORLD_TAG`]); every primitive the HUD paints is one draw
//! under [`HUD_TAG`]. They are counted on the CPU before any culling, so the cull path, GPU
//! culling, batching and the backend never change them, and they are the same on every
//! destination: checks and the judge compare them.
//!
//! What the GPU actually encoded ([`GpuCounters`]: draw calls, compute dispatches, passes) goes
//! under `volatile.gpu` and is never compared: one multi-draw covers every opaque batch of a
//! view, every 2D quad is one batched draw, shadows add passes, and the backend may emulate a
//! multi-draw as a loop.

use crate::compile::Compiled;
use wgpu::{BindGroupLayout, Buffer, BufferUsages, Features, RenderPipeline, ShaderStages};

use crate::camera2d::Camera2d;
use crate::custom_pass::{CUSTOM_TAG, CustomStage, NoCustom, PassStage, PipelineFacts, PrepassViews, StageFrame};
use crate::capture::Capture;
use crate::caps::UploadBudget;
use crate::error::{RenderCode, RenderError};
use crate::extension::{
    CustomDraw, CustomMaterialId, CustomMaterials, EnvironmentViews, ExtensionContext, FrameFacts, GpuCustomDraw, GpuPost, PostFrame, PostPassId,
    PostPasses, PostStage,
};
use crate::gpu::Gpu;
use crate::graph::{FrameEncoder, FrameNodes, NodeId};
use crate::layout::{GpuStructLayout, NO_TEXTURE};
use crate::limits::{IMMEDIATE_QUADS_MAX, check_count};
use crate::overlay::{OverlayPainter, paint_overlay};
use crate::pacing::{FrameAction, FrameGate, FrameTally};
use crate::particles::{EmitterDesc, EmitterId, GpuEmitter, GpuParticle, GpuParticleShape, GpuSortStep, ParticleAtlas, ParticleAtlasId, ParticlePass};
use crate::post::exposure::{ExposureHistory, ExposureInput, ExposurePass, ExposureSource, exposure_source};
use crate::prepass::ExtensionDemand;
use crate::renderer::{FRAME_PRE_EXPOSURE_OFFSET, RenderOptions, Renderer, ScenePath, StagePrepass, WORLD_FORMAT, WorldNodes, WorldPass, WorldStage, shader};
use crate::settings::{LdrReason, Look, Quality};
use crate::settle::{ExposureHistories, FrameHistory, HistoryKey, HistoryReset, HistorySet, LiveFrame, LiveHistory, SettleFrame, SettleHooks};
use crate::scene::{CameraDesc, Lighting, LineVertex, Material, MeshId, Scene, scaled};
use crate::skin::{SkinId, SkinnedMeshData, SkinnedModel};
use crate::tables::{CullPath, buffer, entry, pipeline_layout, uniform};
use crate::texture::{TextureData, TextureId, TextureKind};
use crate::mesh::MeshData;
use crate::meshlet::MeshletSet;

/// The tag draws carry before a frame names one.
pub const WORLD_TAG: &str = "world";
/// The tag every HUD primitive counts under.
pub const HUD_TAG: &str = "hud";

/// Counts logical draws per tag, in first-use order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DrawCounter {
    current: String,
    tags: Vec<(String, u32)>,
}

impl Default for DrawCounter {
    fn default() -> Self {
        DrawCounter { current: WORLD_TAG.to_owned(), tags: Vec::new() }
    }
}

impl DrawCounter {
    /// Count the following draws under `name`.
    pub fn tag(&mut self, name: &str) {
        name.clone_into(&mut self.current);
    }

    /// One draw under the current tag.
    pub fn count(&mut self) {
        let current = self.current.clone();
        self.add(&current, 1);
    }

    /// `n` draws under `tag` (nothing for 0).
    pub fn add(&mut self, tag: &str, n: u32) {
        if n == 0 {
            return;
        }
        match self.tags.iter_mut().find(|(name, _)| name == tag) {
            Some((_, count)) => *count += n,
            None => self.tags.push((tag.to_owned(), n)),
        }
    }

    /// Every draw counted.
    pub fn total(&self) -> u32 {
        self.tags.iter().map(|(_, n)| n).sum()
    }

    /// Draws per tag, in first-use order.
    pub fn tags(&self) -> &[(String, u32)] {
        &self.tags
    }
}

/// A rectangle in 2D world units (pixels under [`Camera2d::SCREEN`]): top-left corner and size.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Rect2d {
    /// Left.
    pub x: f32,
    /// Top.
    pub y: f32,
    /// Width.
    pub w: f32,
    /// Height.
    pub h: f32,
}

impl Rect2d {
    /// A rectangle.
    pub const fn new(x: f32, y: f32, w: f32, h: f32) -> Rect2d {
        Rect2d { x, y, w, h }
    }
}

/// One 2D quad's vertex (`vs_quad`'s input).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, bytemuck::Pod, bytemuck::Zeroable)]
pub struct GpuQuadVertex {
    /// World-target pixels (the 2D camera already applied).
    pub position: [f32; 2],
    /// Texture coordinates in the sprite's layer.
    pub uv: [f32; 2],
    /// sRGB colour and alpha, 0..1.
    pub color: [f32; 4],
    /// Colour-array layer, or `NO_TEXTURE`.
    pub layer: u32,
    /// Padding to 16 bytes.
    pub pad: [u32; 3],
}

/// The 2D pass's uniforms (`Quad2dUniforms`).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, bytemuck::Pod, bytemuck::Zeroable)]
pub struct GpuQuad2d {
    /// World-target pixels → clip space, column-major.
    pub view_proj: [f32; 16],
}

/// The part-2 GPU structs and the WGSL structs they mirror (sizes held equal to naga's in
/// tests/golden_part2.rs).
pub const PART2_GPU_STRUCTS: &[GpuStructLayout] = &[
    GpuStructLayout { wgsl: "Quad2dUniforms", rust_size: size_of::<GpuQuad2d>(), rust_align: align_of::<GpuQuad2d>() },
    GpuStructLayout { wgsl: "GxDraw", rust_size: size_of::<GpuCustomDraw>(), rust_align: align_of::<GpuCustomDraw>() },
    GpuStructLayout { wgsl: "GxPost", rust_size: size_of::<GpuPost>(), rust_align: align_of::<GpuPost>() },
    GpuStructLayout { wgsl: "Emitter", rust_size: size_of::<GpuEmitter>(), rust_align: align_of::<GpuEmitter>() },
    GpuStructLayout { wgsl: "Particle", rust_size: size_of::<GpuParticle>(), rust_align: align_of::<GpuParticle>() },
    GpuStructLayout { wgsl: "ParticleShape", rust_size: size_of::<GpuParticleShape>(), rust_align: align_of::<GpuParticleShape>() },
    GpuStructLayout { wgsl: "SortStep", rust_size: size_of::<GpuSortStep>(), rust_align: align_of::<GpuSortStep>() },
];

/// Vertices of one quad: two triangles.
const QUAD_VERTICES: usize = 6;
const QUAD_ATTRIBUTES: [wgpu::VertexAttribute; 4] = wgpu::vertex_attr_array![0 => Float32x2, 1 => Float32x2, 2 => Float32x4, 3 => Uint32];

fn srgb(color: [u8; 4]) -> [f32; 4] {
    color.map(|c| f32::from(c) / 255.0)
}

/// One frame's draws (see the module docs).
#[derive(Clone, Debug, PartialEq)]
pub struct ImmediateFrame {
    counter: DrawCounter,
    scene: Scene,
    camera2d: Camera2d,
    quads: Vec<[GpuQuadVertex; QUAD_VERTICES]>,
    custom: Vec<CustomDraw>,
    particles: Vec<(EmitterId, u64)>,
    post: Vec<PostPassId>,
    seconds: f32,
    /// The sim tick the frame shows (Live history counts the ticks between frames).
    tick: Option<u64>,
    /// The frame asks Live's temporal history to start over.
    camera_cut: bool,
}

impl ImmediateFrame {
    /// An empty frame through `camera`, cleared to the sRGB colour `clear`.
    pub fn new(camera: CameraDesc, clear: [u8; 4]) -> ImmediateFrame {
        ImmediateFrame {
            counter: DrawCounter::default(),
            scene: Scene::new(camera, clear),
            camera2d: Camera2d::SCREEN,
            quads: Vec::new(),
            custom: Vec::new(),
            particles: Vec::new(),
            post: Vec::new(),
            seconds: 0.0,
            tick: None,
            camera_cut: false,
        }
    }

    /// A frame of a part-1 `scene` as it stands (its camera, clear colour, lighting and draws),
    /// counted as one draw per scene draw under [`WORLD_TAG`]: what a renderer harness hands
    /// [`FrameRenderer`] to draw a scene as a game's frames are drawn (auto exposure metered,
    /// captures settled).
    pub fn from_scene(scene: Scene) -> ImmediateFrame {
        let mut frame = ImmediateFrame::new(scene.camera, scene.clear);
        frame.counter.add(WORLD_TAG, (scene.mesh_instances() + scene.skinned.len()) as u32);
        frame.scene = scene;
        frame
    }

    /// Count the following draws under `name` (`state().__render.tags`).
    pub fn tag(&mut self, name: &str) -> &mut Self {
        self.counter.tag(name);
        self
    }

    /// The frame's lights.
    pub fn lighting_mut(&mut self) -> &mut Lighting {
        &mut self.scene.lighting
    }

    /// The simulated time extensions read (`gx_draw.params.x`, `gx_post.params.x`), in seconds:
    /// the tick's, never the wall clock's.
    pub fn set_seconds(&mut self, seconds: f32) -> &mut Self {
        self.seconds = seconds;
        self
    }

    /// The sim tick the frame shows: Live's history advances by the ticks since the last Live
    /// frame (none for the same tick drawn again), and a tick that went backwards starts it over.
    /// Unset, every Live frame counts as one tick.
    pub fn set_tick(&mut self, tick: u64) -> &mut Self {
        self.tick = Some(tick);
        self
    }

    /// The sim tick the frame shows, if set.
    pub fn tick(&self) -> Option<u64> {
        self.tick
    }

    /// The frame's level-of-detail crossfade band ([`crate::scene::Scene::lod_band`]; game systems
    /// LOD-06: the presenter passes its quality's `lod.fade_band`, 0 draws hard switches).
    pub fn set_lod_band(&mut self, band: f32) -> &mut Self {
        self.scene.lod_band = band;
        self
    }

    /// How the following draws choose their levels (game systems LOD-02, LOD-07): the
    /// compound sphere their parts measure from and their bias ([`crate::scene::Scene::set_lod`]).
    pub fn set_lod(&mut self, lod: crate::lod_rows::DrawLod) -> &mut Self {
        self.scene.set_lod(lod);
        self
    }

    /// The far rule `rule` as the following draws name it ([`crate::scene::Scene::far_rule`],
    /// game systems LOD-19).
    pub fn far_rule(&mut self, rule: crate::lod_rows::GpuFarRule) -> u32 {
        self.scene.far_rule(rule)
    }

    /// The draw id the following draws carry (`frame.id(key)` in the facade), or none: under TAA
    /// a moving object keeps its motion history by its id while other draws come and go
    /// ([`Scene::set_id`]).
    pub fn id(&mut self, id: Option<crate::motion::DrawId>) -> &mut Self {
        self.scene.set_id(id);
        self
    }

    /// Start Live's temporal history over at this frame (a camera cut: TAA, AO and exposure
    /// history from the last shot would smear into this one). A camera jump past
    /// [`crate::settle::camera_cut`]'s thresholds is a cut without asking.
    pub fn camera_cut(&mut self) -> &mut Self {
        self.camera_cut = true;
        self
    }

    /// Draw `mesh` under `model` with `material`.
    pub fn mesh(&mut self, mesh: MeshId, model: [f32; 16], material: Material) -> &mut Self {
        self.scene.draw(mesh, model, material);
        self.counter.count();
        self
    }

    /// Draw `mesh` once per model: one logical draw.
    pub fn instanced(&mut self, mesh: MeshId, models: &[[f32; 16]], color: [u8; 4]) -> &mut Self {
        self.scene.draw_instanced(mesh, models, Material::color(color));
        self.counter.count();
        self
    }

    /// Draw a skinned mesh posed by `joints`.
    pub fn skinned(&mut self, skin: SkinId, model: [f32; 16], joints: Vec<[f32; 16]>, material: Material) -> &mut Self {
        self.scene.draw_skinned(skin, model, joints, material);
        self.counter.count();
        self
    }

    /// Draw a skinned mesh posed by `joints`, each part with its own material
    /// ([`Scene::draw_skinned_parts`], game systems AN-17).
    pub fn skinned_parts(&mut self, skin: SkinId, model: [f32; 16], joints: Vec<[f32; 16]>, materials: Vec<Material>) -> &mut Self {
        self.scene.draw_skinned_parts(skin, model, joints, materials);
        self.counter.count();
        self
    }

    /// Draw the unit cube under `model`.
    pub fn cube(&mut self, model: [f32; 16], color: [u8; 4]) -> &mut Self {
        self.mesh(MeshId::CUBE, model, Material::color(color))
    }

    /// Draw a sphere.
    pub fn sphere(&mut self, center: [f32; 3], radius: f32, color: [u8; 4]) -> &mut Self {
        self.mesh(MeshId::SPHERE, scaled(center, [radius; 3]), Material::color(color))
    }

    /// Draw a 3D line segment.
    pub fn line(&mut self, from: [f32; 3], to: [f32; 3], color: [u8; 4]) -> &mut Self {
        self.scene.line(from, to, color);
        self.counter.count();
        self
    }

    /// Draw `vertices` as 3D line segments ([`Scene::lines`]): one logical draw, none when there
    /// is no segment.
    pub fn lines(&mut self, vertices: &[LineVertex]) -> &mut Self {
        if vertices.len() >= 2 {
            self.scene.lines(vertices);
            self.counter.count();
        }
        self
    }

    /// Draw the following 2D primitives through `camera`.
    pub fn camera2d(&mut self, camera: Camera2d) -> &mut Self {
        self.camera2d = camera;
        self
    }

    fn quad(&mut self, corners: [[f32; 2]; 4], uv: [f32; 4], color: [u8; 4], layer: u32) -> &mut Self {
        let [u0, v0, u1, v1] = uv;
        let uvs = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
        let vertex = |i: usize| GpuQuadVertex {
            position: self.camera2d.world_to_screen(corners[i]),
            uv: uvs[i],
            color: srgb(color),
            layer,
            pad: [0; 3],
        };
        self.quads.push([vertex(0), vertex(1), vertex(2), vertex(0), vertex(2), vertex(3)]);
        self.counter.count();
        self
    }

    /// Fill a 2D rectangle.
    pub fn rect(&mut self, rect: Rect2d, color: [u8; 4]) -> &mut Self {
        let Rect2d { x, y, w, h } = rect;
        self.quad([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], [0.0, 0.0, 1.0, 1.0], color, NO_TEXTURE)
    }

    /// Draw a colour texture into `dest`, tinted by `tint`.
    pub fn sprite(&mut self, texture: TextureId, dest: Rect2d, tint: [u8; 4]) -> &mut Self {
        self.sprite_region(texture, [0.0, 0.0, 1.0, 1.0], dest, 0.0, tint)
    }

    /// Draw the `source` uv rectangle (u0, v0, u1, v1) of a colour texture into `dest`, rotated
    /// about its centre by `rotation_degrees`, from whichever size class texture quality placed it
    /// in. A data texture draws untextured.
    pub fn sprite_region(&mut self, texture: TextureId, source: [f32; 4], dest: Rect2d, rotation_degrees: f32, tint: [u8; 4]) -> &mut Self {
        let Rect2d { x, y, w, h } = dest;
        let (cx, cy) = (x + w * 0.5, y + h * 0.5);
        let radians = rotation_degrees.to_radians();
        let (sin, cos) = (libm::sinf(radians), libm::cosf(radians));
        let turn = |px: f32, py: f32| {
            let (dx, dy) = (px - cx, py - cy);
            [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos]
        };
        let corners = [turn(x, y), turn(x + w, y), turn(x + w, y + h), turn(x, y + h)];
        // Quads sample the colour arrays of every size class (the reference carries the class;
        // class 0 is the bare layer).
        let layer = if texture.kind().array() == TextureKind::Color { texture.reference() } else { NO_TEXTURE };
        self.quad(corners, source, tint, layer)
    }

    /// Draw a 2D line `thickness` wide.
    pub fn line2d(&mut self, from: [f32; 2], to: [f32; 2], thickness: f32, color: [u8; 4]) -> &mut Self {
        let (dx, dy) = (to[0] - from[0], to[1] - from[1]);
        let length = (dx * dx + dy * dy).sqrt();
        let (nx, ny) = if length > 0.0 { (-dy / length * thickness * 0.5, dx / length * thickness * 0.5) } else { (0.0, 0.0) };
        let corners = [[from[0] + nx, from[1] + ny], [to[0] + nx, to[1] + ny], [to[0] - nx, to[1] - ny], [from[0] - nx, from[1] - ny]];
        self.quad(corners, [0.0, 0.0, 1.0, 1.0], color, NO_TEXTURE)
    }

    /// Draw `mesh` with a custom material, tinted `tint`, under the current draw id
    /// ([`ImmediateFrame::id`]): its motion history follows the id (T-04).
    pub fn custom(&mut self, mesh: MeshId, model: [f32; 16], material: CustomMaterialId, tint: [u8; 4]) -> &mut Self {
        self.custom.push(CustomDraw { id: self.scene.id(), mesh, model, material, tint });
        self.counter.count();
        self
    }

    /// Draw `emitter`'s particles as they are at `tick`.
    pub fn particles(&mut self, emitter: EmitterId, tick: u64) -> &mut Self {
        self.particles.push((emitter, tick));
        self.counter.count();
        self
    }

    /// Run `pass` over the frame, after the 2D primitives and before the HUD (in call order).
    pub fn post_pass(&mut self, pass: PostPassId) -> &mut Self {
        self.post.push(pass);
        self.counter.count();
        self
    }

    /// Draw `water` over the opaque scene this frame (renderer pass 2 B.3, graph node 16a), or
    /// none.
    pub fn set_water(&mut self, water: Option<crate::scene::SceneWater>) -> &mut Self {
        self.scene.water = water;
        self
    }

    /// The 3D scene so far.
    pub fn scene(&self) -> &Scene {
        &self.scene
    }

    /// Draw a retained instance group (renderer pass 2 A.0b) with `material`: one logical draw.
    pub fn group(&mut self, group: &crate::retained::InstanceGroup, material: Material) -> &mut Self {
        self.scene.draw_group_with(group, material);
        self.counter.count();
        self
    }

    /// The custom-material draws so far, in call order.
    pub fn custom_draws(&self) -> &[CustomDraw] {
        &self.custom
    }

    /// 2D quads so far.
    pub fn quads(&self) -> usize {
        self.quads.len()
    }

    /// Logical draws so far (`drawCalls`, before the HUD).
    pub fn draw_calls(&self) -> u32 {
        self.counter.total()
    }

    /// Draws per tag so far, in first-use order.
    pub fn tags(&self) -> &[(String, u32)] {
        self.counter.tags()
    }

    /// Refuse a frame above the per-frame caps before anything reaches the GPU.
    pub fn check_caps(&self) -> Result<(), RenderError> {
        check_count("2D quads in a frame", self.quads.len(), IMMEDIATE_QUADS_MAX, RenderCode::UploadBudget)
    }

    fn quad_bytes(&self) -> u64 {
        (self.quads.len() * QUAD_VERTICES * size_of::<GpuQuadVertex>()) as u64
    }
}

/// What the GPU encoded for a frame: `state().volatile.gpu`, never compared (module docs).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct GpuCounters {
    /// Draw calls recorded (a multi-draw is one; a backend may still loop it).
    pub encoder_draws: u32,
    /// Compute dispatches (skinning, culling, particles).
    pub dispatches: u32,
    /// Render passes (shadow cascades, the world, the upscale below scale 1, 2D, post passes, the
    /// HUD).
    pub passes: u32,
}

impl GpuCounters {
    /// The `volatile.gpu` object: `{"encoderDraws","dispatches","passes"}`.
    pub fn to_json(&self) -> String {
        format!(r#"{{"encoderDraws":{},"dispatches":{},"passes":{}}}"#, self.encoder_draws, self.dispatches, self.passes)
    }
}

/// What a rendered frame reports.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FrameReport {
    /// Logical draws, the HUD's included (`drawCalls`).
    pub draw_calls: u32,
    /// Logical draws per tag, in first-use order, `hud` last if it painted.
    pub tags: Vec<(String, u32)>,
    /// What the GPU encoded (`volatile.gpu`).
    pub gpu: GpuCounters,
}

/// Blending over the frame while keeping the target's alpha (1), so captures stay opaque.
const BLEND_OVER: wgpu::BlendState = wgpu::BlendState {
    color: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::SrcAlpha, dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha, operation: wgpu::BlendOperation::Add },
    alpha: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::Zero, dst_factor: wgpu::BlendFactor::One, operation: wgpu::BlendOperation::Add },
};

/// A colour texture array the quad fragment samples at `binding` (a larger size class's).
fn quad_array(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: ShaderStages::FRAGMENT,
        ty: wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: true },
            view_dimension: wgpu::TextureViewDimension::D2Array,
            multisampled: false,
        },
        count: None,
    }
}

/// The 2D quad batch: one draw for every rect, sprite and 2D line of a frame.
struct QuadPass {
    pipeline: Compiled<RenderPipeline>,
    layout: BindGroupLayout,
    uniforms: Buffer,
    vertices: Option<Buffer>,
}

impl QuadPass {
    fn new(device: &wgpu::Device) -> Result<QuadPass, RenderError> {
        let fragment = ShaderStages::FRAGMENT;
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("quads"),
            entries: &[
                uniform(0, false, ShaderStages::VERTEX),
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: fragment,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2Array,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry { binding: 2, visibility: fragment, ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering), count: None },
                quad_array(3),
                quad_array(4),
                quad_array(5),
            ],
        });
        let module = shader(device, "immediate 2d", crate::shaders::IMMEDIATE_2D)?;
        let buffers = [Some(wgpu::VertexBufferLayout { array_stride: size_of::<GpuQuadVertex>() as u64, step_mode: wgpu::VertexStepMode::Vertex, attributes: &QUAD_ATTRIBUTES })];
        let targets = [Some(wgpu::ColorTargetState { format: WORLD_FORMAT, blend: Some(BLEND_OVER), write_mask: wgpu::ColorWrites::ALL })];
        let pipeline = crate::compile::render_pipeline(device, &wgpu::RenderPipelineDescriptor {
            label: Some("immediate 2d"),
            layout: Some(&pipeline_layout(device, "immediate 2d", &[&layout])),
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_quad"), compilation_options: Default::default(), buffers: &buffers },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs_quad"), compilation_options: Default::default(), targets: &targets }),
            multiview_mask: None,
            cache: None,
        });
        let uniforms = buffer(device, "quads", size_of::<GpuQuad2d>() as u64, BufferUsages::UNIFORM | BufferUsages::COPY_DST)?;
        Ok(QuadPass { pipeline, layout, uniforms, vertices: None })
    }

    /// Draw `quads` over the world target in one draw; answers the draws encoded (0 or 1).
    fn encode(&mut self, gpu: &Gpu, encoder: &mut wgpu::CommandEncoder, renderer: &Renderer, quads: &[[GpuQuadVertex; QUAD_VERTICES]]) -> Result<u32, RenderError> {
        if quads.is_empty() {
            return Ok(0);
        }
        let device = &gpu.device;
        let bytes: &[u8] = bytemuck::cast_slice(quads);
        if self.vertices.as_ref().is_none_or(|b| b.size() < bytes.len() as u64) {
            self.vertices = Some(buffer(device, "quads", (bytes.len() as u64).next_power_of_two(), BufferUsages::VERTEX | BufferUsages::COPY_DST)?);
        }
        let Some(vertices) = &self.vertices else { return Ok(0) };
        gpu.queue.write_buffer(vertices, 0, bytes);
        // 2D coordinates are the game's logical world pixels at any output size (renderer pass 2,
        // P2-0.9 step B): a Live frame drawn at the window's pixels scales them, never moves them.
        // Under `fit = "expand"` the frame shows the world grown to its aspect, the world centred.
        let view_proj = Camera2d::SCREEN.view_proj_over(renderer.view_rect());
        gpu.queue.write_buffer(&self.uniforms, 0, bytemuck::bytes_of(&GpuQuad2d { view_proj }));
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("quads"),
            layout: &self.layout,
            entries: &[
                entry(0, &self.uniforms),
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(renderer.color_texture_view()) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(renderer.texture_sampler()) },
                wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::TextureView(renderer.color_slot_view(1)) },
                wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::TextureView(renderer.color_slot_view(2)) },
                wgpu::BindGroupEntry { binding: 5, resource: wgpu::BindingResource::TextureView(renderer.color_slot_view(3)) },
            ],
        });
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("immediate 2d"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: renderer.world_view(),
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Load, store: wgpu::StoreOp::Store },
            })],
            ..Default::default()
        });
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.set_vertex_buffer(0, vertices.slice(..bytes.len() as u64));
        pass.draw(0..(quads.len() * QUAD_VERTICES) as u32, 0..1);
        Ok(1)
    }
}

/// The part-2 work inside the world pass: custom materials (opaque) and particles (blended), then
/// the custom passes of each stage (M2.19).
struct Part2Stage<'a> {
    device: &'a wgpu::Device,
    queue: &'a wgpu::Queue,
    materials: &'a mut CustomMaterials,
    particles: &'a mut ParticlePass,
    custom: &'a mut dyn CustomStage,
    /// The auto exposure the frame's history holds, for the frame uniforms' pre-exposure lane.
    pre_exposure: Option<Buffer>,
}

impl WorldStage for Part2Stage<'_> {
    fn before_cull(&mut self, encoder: &mut wgpu::CommandEncoder, world: &WorldPass<'_>) {
        // After the frame uniforms' upload (the tables node), before every pass that reads them:
        // an HDR scene is written with the exposure the history adapted to.
        if let Some(exposure) = self.pre_exposure.as_ref().filter(|_| world.hdr) {
            encoder.copy_buffer_to_buffer(exposure, 0, world.frame_uniforms, FRAME_PRE_EXPOSURE_OFFSET, PRE_EXPOSURE_BYTES);
        }
        // `before-cull` passes run on their own encoders, each submitted at once, and so does the
        // v1/v2 frame refresh ahead of them: the frame so far (the timer's begin pass, the exposure
        // copy above) is submitted first, as nodes 9, 18 and 23 do before their encoder stages.
        // Otherwise the refresh read the CPU's pre-exposure (1.0 under auto exposure) and the
        // passes ran before the frame's timer (renderer pass 2, RC-02).
        if self.custom.runs(PassStage::BeforeCull) {
            let fresh = self.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("frame") });
            let so_far = std::mem::replace(encoder, fresh);
            self.queue.submit([so_far.finish()]);
        }
        self.custom.before_cull(encoder, world);
    }

    fn before_world(&mut self, encoder: &mut wgpu::CommandEncoder, world: &WorldPass<'_>) {
        self.materials.bind_frame(self.device, encoder, world);
        self.particles.encode(self.device, encoder, world);
        self.custom.before_world(encoder, world);
    }

    fn opaque(&self, pass: &mut wgpu::RenderPass<'_>, world: &WorldPass<'_>) {
        self.materials.draw(pass, world);
        self.custom.opaque(pass, world);
    }

    fn blended(&self, pass: &mut wgpu::RenderPass<'_>, world: &WorldPass<'_>) {
        self.particles.draw(pass);
        self.custom.blended(pass, world);
    }

    fn reactive_draws(&self) -> bool {
        self.particles.draws() || self.custom.reactive_draws()
    }

    fn reactive(&self, pass: &mut wgpu::RenderPass<'_>, node: &crate::post::taa::ReactiveNode) {
        self.particles.draw_reactive(pass, node);
        // The Level-3 passes' coverage last: their pipelines set everything they bind.
        self.custom.reactive(pass, node);
    }

    fn pre_exposure_source(&self) -> Option<&Buffer> {
        self.pre_exposure.as_ref()
    }
}

/// One [`ImmediateFrame`] through the frame graph: the part-1 nodes with the part-2 stage, plus
/// node 23 (2D quads, v1 post passes, Level-3 `post` passes) and node 24 (the HUD).
struct FrameNodesOf<'a> {
    world: WorldNodes<'a>,
    stage: Part2Stage<'a>,
    gpu: &'a Gpu,
    frame: &'a ImmediateFrame,
    quads: &'a mut QuadPass,
    posts: &'a mut PostPasses,
    overlay: Option<&'a mut dyn OverlayPainter>,
    quad_draws: u32,
    hud: Option<u32>,
    /// The exposure node's work this frame, taken when it is encoded.
    exposure: Option<ExposureFrame<'a>>,
    /// Whether the frame holds `hdr`-stage post passes.
    hdr_posts: bool,
    /// The frame's index in its history (what post passes read).
    frame_index: u64,
    /// The v2 frame bytes v2 post passes bind (refreshed in the world pass's `before_world`).
    frame_v2: Option<Buffer>,
    /// The environment v2 sources bind this frame (the renderer's, handed over again after graph
    /// node 11 baked it).
    environment: Option<EnvironmentViews>,
    /// The depth/normal prepass's targets once graph node 9 handed them over (v2 post passes bind
    /// them as `gx_depth` and `gx_normals`).
    prepass: Option<PrepassViews>,
    /// The prepass's motion once graph node 9 handed it over (v2 post passes bind it as
    /// `gx_motion`; RQ5.6).
    motion: Option<wgpu::TextureView>,
}

/// One frame of the exposure node: its pipelines, the history of the frame's set and what it
/// meters with.
struct ExposureFrame<'a> {
    pass: &'a ExposurePass,
    history: &'a mut ExposureHistory,
    look: Look,
    quality: Quality,
    /// Ticks the frame advances adaptation by.
    ticks: u32,
    /// Adapt at once (a settled capture).
    instant: bool,
    /// How many times faster than the look it adapts (a Live frame at a room's doorway).
    boost: f32,
}

impl FrameNodesOf<'_> {
    /// After graph node 11: hand the environment it baked (a new cube the frame it lands) to the v2
    /// materials, the v2 post passes and the Level-3 stage, so they light with what the forward
    /// pass binds (RQ2.5).
    fn hand_environment(&mut self) {
        let views = self.world.renderer().environment_views();
        if views == self.environment {
            return;
        }
        self.stage.materials.set_environment(views.clone());
        if let Some(views) = &views {
            self.stage.custom.environment(views);
        }
        self.environment = views;
    }

    /// Node 9: hand the prepass's targets to the Level-3 stage (running its `after-prepass` passes,
    /// each on its own encoder, so the frame so far is submitted ahead of them) and keep them for
    /// the v2 post passes.
    fn hand_prepass(&mut self, frame: &mut FrameEncoder) {
        let Some(views) = self.world.prepass_views() else { return };
        if self.stage.custom.runs(PassStage::AfterPrepass) {
            frame.submit();
        }
        // The motion first: the `after-prepass` passes bind it as `gx_motion` too.
        self.motion = self.world.prepass_motion();
        if let Some(motion) = &self.motion {
            self.stage.custom.prepass_motion(motion);
        }
        self.stage.custom.after_prepass(&views);
        // Soft and colliding particles read the opaque scene's depth (renderer pass 2 A.11).
        self.stage.particles.set_scene_depth(Some(views.depth.clone()));
        self.prepass = Some(views);
    }

    /// Node 15a, ahead of the reactive coverage: the Level-3 in-world passes' own motion
    /// (`PassFrame::motion_draws`) over the prepass's, against (and into) the prepass depth, so
    /// TAA reprojects what they move (renderer pass 2, B.7).
    fn encode_pass_motion(&mut self, frame: &mut FrameEncoder) {
        let (Some(motion), Some(prepass)) = (&self.motion, &self.prepass) else { return };
        if self.stage.custom.temporal_motion(frame.encoder(), motion, &prepass.depth) {
            frame.count_render_passes(1);
        }
    }

    /// What this frame's post passes bind beside the base frame: the v2 frame bytes, the
    /// environment, the prepass's depth, normals and motion.
    fn post_frame_inputs(&self) -> (Option<Buffer>, Option<EnvironmentViews>, Option<PrepassViews>, Option<wgpu::TextureView>) {
        (self.frame_v2.clone(), self.environment.clone(), self.prepass.clone(), self.motion.clone())
    }

    /// Node 20: meter the resolved HDR scene into the history (nothing on the legacy path, or
    /// when the frame holds no exposure work).
    fn encode_exposure(&mut self, frame: &mut FrameEncoder) {
        let Some(exposure) = self.exposure.take() else { return };
        let Some(scene) = self.world.resolved_hdr_scene(frame) else { return };
        let input = ExposureInput {
            scene: &scene,
            scene_size: self.world.renderer().hdr_scene_size(),
            look: &exposure.look,
            quality: &exposure.quality,
            ticks: exposure.ticks,
            instant: exposure.instant,
            boost: exposure.boost,
            timestamp_writes: None,
        };
        let ran = exposure.pass.encode(&self.gpu.device, &self.gpu.queue, frame.encoder(), exposure.history, input);
        if ran == crate::post::exposure::ExposureRun::Metered {
            frame.count_compute_passes(1);
        }
    }

    /// What this frame's post passes read beside their target, without the v2 frame bytes (the
    /// caller lends [`FrameNodesOf::frame_v2`]).
    fn post_frame(&self) -> PostFrame<'static> {
        let scene = self.world.scene();
        let renderer = self.world.renderer();
        PostFrame {
            frame_index: self.frame_index,
            depth_reversed: scene.depth_reversed,
            pre_exposure: scene.pre_exposure,
            jitter: renderer.frame_jitter_ndc(),
            ..PostFrame::new(renderer.size(), self.frame.seconds)
        }
    }

    /// Node 18 on the HDR scene: the Level-3 `post-hdr` passes (each on its own encoder, so the
    /// frame so far is submitted ahead of them), then the `hdr`-stage post passes, over the
    /// resolved scene at render size.
    fn encode_post_hdr(&mut self, frame: &mut FrameEncoder) {
        let Some((texture, view)) = self.world.resolved_hdr_target(frame) else { return };
        if self.stage.custom.runs(PassStage::PostHdr) {
            frame.submit();
            self.stage.custom.post_hdr(texture, view);
        }
        if self.hdr_posts {
            let (frame_v2, environment, prepass, motion) = self.post_frame_inputs();
            let post = post_inputs(self.post_frame(), frame_v2.as_ref(), environment.as_ref(), prepass.as_ref(), motion.as_ref());
            self.posts.encode_stage(self.gpu, frame.encoder(), (texture, view), &self.frame.post, PostStage::Hdr, &post);
            frame.count_render_passes(1);
        }
    }

    /// Node 23: on the legacy LDR scene the Level-3 `post-hdr` passes first (the scene is the world
    /// target), then the 2D quads and the post passes on the frame's encoder (on the HDR scene only
    /// the `ldr`-stage ones: node 18 ran the rest), then the Level-3 `post` passes. Level-3 passes
    /// submit their own encoders, so the frame so far is submitted ahead of them.
    fn encode_post(&mut self, frame: &mut FrameEncoder) -> Result<(), RenderError> {
        let renderer = self.world.renderer();
        let hdr = self.world.scene().hdr;
        if !hdr && self.stage.custom.runs(PassStage::PostHdr) {
            frame.submit();
            self.stage.custom.post_hdr(renderer.world_texture(), renderer.world_view());
        }
        self.quad_draws = self.quads.encode(self.gpu, frame.encoder(), renderer, &self.frame.quads)?;
        frame.count_render_passes(self.quad_draws);
        let world = (renderer.world_texture(), renderer.world_view());
        if hdr {
            let (frame_v2, environment, prepass, motion) = self.post_frame_inputs();
            let post = post_inputs(self.post_frame(), frame_v2.as_ref(), environment.as_ref(), prepass.as_ref(), motion.as_ref());
            self.posts.encode_stage(self.gpu, frame.encoder(), world, &self.frame.post, PostStage::Ldr, &post);
        } else {
            let (frame_v2, environment, prepass, motion) = self.post_frame_inputs();
            let post = post_inputs(self.post_frame(), frame_v2.as_ref(), environment.as_ref(), prepass.as_ref(), motion.as_ref());
            self.posts.encode_all(self.gpu, frame.encoder(), world, &self.frame.post, &post);
        }
        frame.count_render_passes(self.frame.post.len() as u32);
        frame.submit();
        self.stage.custom.after_world(renderer.world_texture(), renderer.world_view());
        Ok(())
    }

    /// Node 24: the HUD over the world target.
    fn encode_hud(&mut self, frame: &mut FrameEncoder) {
        let Some(painter) = self.overlay.as_deref_mut() else { return };
        let renderer = self.world.renderer();
        let (width, height) = renderer.size();
        self.hud = Some(paint_overlay(painter, self.gpu, frame.encoder(), renderer.world_view(), [width, height]));
        frame.count_render_passes(1);
    }
}

impl FrameNodes for FrameNodesOf<'_> {
    fn enabled(&self, id: NodeId) -> bool {
        match id {
            NodeId::PostHdr => self.world.scene().hdr && (self.hdr_posts || self.stage.custom.runs(PassStage::PostHdr)),
            // Node 9 hands the prepass's targets over whenever the prepass runs: its `after-prepass`
            // passes run there, and the later stages and v2 post passes bind them.
            NodeId::AfterPrepass => self.world.prepass_runs(),
            NodeId::Exposure => self.exposure.is_some(),
            NodeId::Post => true,
            NodeId::Hud => self.overlay.is_some(),
            _ => self.world.enabled(id),
        }
    }

    fn encode(&mut self, id: NodeId, frame: &mut FrameEncoder) -> Result<(), RenderError> {
        match id {
            NodeId::PostHdr => {
                self.encode_post_hdr(frame);
                Ok(())
            }
            NodeId::AfterPrepass => {
                self.hand_prepass(frame);
                Ok(())
            }
            NodeId::Exposure => {
                self.encode_exposure(frame);
                Ok(())
            }
            NodeId::Post => self.encode_post(frame),
            NodeId::Hud => {
                self.encode_hud(frame);
                Ok(())
            }
            NodeId::Environment => {
                self.world.encode(id, frame, &mut self.stage);
                self.hand_environment();
                Ok(())
            }
            NodeId::Reactive => {
                self.encode_pass_motion(frame);
                self.world.encode(id, frame, &mut self.stage);
                Ok(())
            }
            _ => {
                self.world.encode(id, frame, &mut self.stage);
                Ok(())
            }
        }
    }

    fn before_world(&mut self, _rows: &[NodeId], frame: &mut FrameEncoder) -> Result<(), RenderError> {
        self.world.before_world(frame, &mut self.stage);
        Ok(())
    }

    fn begin_world<'e>(&mut self, rows: &[NodeId], encoder: &'e mut wgpu::CommandEncoder) -> wgpu::RenderPass<'e> {
        self.world.begin_world(rows, encoder)
    }

    fn encode_in_pass(&mut self, id: NodeId, pass: &mut wgpu::RenderPass<'_>) {
        self.world.encode_in_pass(id, pass, &self.stage);
    }
}

/// `base` with the inputs v2 post passes bind: the v2 frame bytes, the renderer's environment and
/// the prepass's depth, normals and motion (each None: its neutral resource).
fn post_inputs<'a>(
    base: PostFrame<'static>,
    frame: Option<&'a Buffer>,
    environment: Option<&'a EnvironmentViews>,
    prepass: Option<&'a PrepassViews>,
    motion: Option<&'a wgpu::TextureView>,
) -> PostFrame<'a> {
    PostFrame {
        frame,
        environment,
        depth: prepass.map(|views| &views.depth),
        normals: prepass.map(|views| &views.normals),
        motion,
        ..base
    }
}

/// What Level-2 v2 sources read about a frame of `frame` at `history` drawing `scene`: the
/// renderer's sizes, the frame's camera, its history, the scene's depth convention and exposure.
fn v2_frame_facts(renderer: &Renderer, frame: &ImmediateFrame, history: &FrameHistory, scene: &ScenePath, ev_compensation: f32) -> FrameFacts {
    FrameFacts {
        frame_index: history.frame_index,
        history_reset: history.history_reset(),
        depth_reversed: scene.depth_reversed,
        scene_ldr: !scene.hdr,
        pre_exposure: scene.pre_exposure,
        ev_compensation,
        settle_index: history.settle.map_or(0, |settle| settle.index),
        fog: renderer.frame_fog_for(scene, frame.scene().clear),
        ..FrameFacts::new(renderer.size(), renderer.render_size())
    }
    .with_camera(frame.scene().camera)
}

/// The exposure node's work for a frame at `history`: the node's set (Live or the capture's),
/// with instant adaptation in a capture. None before the node exists, on frames that cannot draw
/// HDR, or with the exposure switch off.
fn exposure_frame<'a>(node: &'a mut Option<ExposureHistories>, renderer: &Renderer, history: &FrameHistory, boost: f32) -> Option<ExposureFrame<'a>> {
    let (quality, look) = (*renderer.quality(), *renderer.look());
    let runs = quality.hdr && quality.exposure && renderer.hdr_scene_format() != WORLD_FORMAT;
    let node = node.as_mut().filter(|_| runs)?;
    node.set_look(&look);
    let (pass, history_buffers) = node.parts(history.set);
    let instant = history.set == HistorySet::Capture;
    Some(ExposureFrame { pass, history: history_buffers, look, quality, ticks: history.ticks, instant, boost })
}

/// The buffer the frame's pre-exposure is copied from under auto exposure (a fixed exposure is
/// written by the renderer itself).
fn auto_pre_exposure(work: &ExposureFrame<'_>) -> Option<Buffer> {
    let auto = exposure_source(&work.look, &work.quality) == ExposureSource::Auto;
    auto.then(|| work.history.pre_exposure_buffer().clone())
}

/// Draws [`ImmediateFrame`]s: the part-1 [`Renderer`] plus the 2D batch, custom materials, post
/// passes, particles and the HUD stage, with the extension context the game declared.
pub struct FrameRenderer {
    /// Boxed: the renderer is about 42 KB, and a debug build copies it through every `?` and
    /// move between here and the presenter, which overflowed a 2 MiB test thread.
    renderer: Box<Renderer>,
    context: ExtensionContext,
    quads: QuadPass,
    materials: CustomMaterials,
    posts: PostPasses,
    particles: ParticlePass,
    /// Display frames rendered and repeated (RQ0.12).
    gate: FrameGate,
    /// Frame-graph nodes encoded since this renderer was made: the probe that a repeat frame
    /// encodes none.
    nodes_encoded: u64,
    /// Live's temporal history: the frame index and the reset rules (RQ1.5).
    live: LiveHistory,
    /// The next re-render of the settled capture in progress (None: Live frames).
    settle: Option<SettleFrame>,
    /// Where the last frame drawn sat in its history.
    last_history: Option<FrameHistory>,
    /// The ticks the paced frame being drawn ran ([`FrameRenderer::render_paced`]).
    paced_ticks: Option<u32>,
    /// The exposure node with Live's and the capture's histories, made on the first frame that
    /// meters (graph node 20).
    exposure: Option<ExposureHistories>,
    /// Auto exposure's quick adjustment at a declared room's doorway (Live frames).
    room_adaptation: crate::post::exposure::RoomAdaptation,
    /// Settled captures begun since this renderer was made.
    settled: u32,
}

/// Bytes of the exposure copied into the frame uniforms' pre-exposure lane.
const PRE_EXPOSURE_BYTES: u64 = 4;

impl FrameRenderer {
    /// A renderer for a game that declares no native-enhanced feature (WebGPU core).
    pub fn new(gpu: &Gpu, width: u32, height: u32, options: RenderOptions) -> Result<FrameRenderer, RenderError> {
        FrameRenderer::with_native_features(gpu, width, height, options, Features::empty())
    }

    /// A renderer for a game that declares `declared` (`[gpu] native_features`): refused
    /// `native-feature-missing` when `gpu`'s device was not opened with every one of them.
    pub fn with_native_features(gpu: &Gpu, width: u32, height: u32, options: RenderOptions, declared: Features) -> Result<FrameRenderer, RenderError> {
        let context = ExtensionContext::for_gpu(gpu, declared);
        context.check_device()?;
        let renderer = Box::new(Renderer::with_options(gpu, width, height, options)?);
        let samples = renderer.sample_count();
        let device = &gpu.device;
        Ok(FrameRenderer {
            quads: QuadPass::new(device)?,
            materials: CustomMaterials::new(device, context, samples),
            posts: PostPasses::new(device, context)?,
            particles: ParticlePass::new(gpu, samples)?,
            context,
            renderer,
            gate: FrameGate::default(),
            nodes_encoded: 0,
            settled: 0,
            live: LiveHistory::default(),
            settle: None,
            last_history: None,
            paced_ticks: None,
            exposure: None,
            room_adaptation: crate::post::exposure::RoomAdaptation::default(),
        })
    }

    /// The part-1 renderer (its world target, capture and present).
    pub fn renderer(&self) -> &Renderer {
        &self.renderer
    }

    /// The part-1 renderer, mutably (present).
    pub fn renderer_mut(&mut self) -> &mut Renderer {
        &mut self.renderer
    }

    /// The native-enhanced features the game declared.
    pub fn declared_features(&self) -> Features {
        self.context.declared()
    }

    /// Add a mesh.
    pub fn add_mesh(&mut self, gpu: &Gpu, mesh: MeshData) -> Result<MeshId, RenderError> {
        self.renderer.add_mesh(gpu, mesh)
    }

    /// Add every part of one model, uploading the library once ([`Renderer::add_meshes`]).
    pub fn add_meshes(&mut self, gpu: &Gpu, meshes: Vec<MeshData>) -> Result<Vec<MeshId>, RenderError> {
        self.renderer.add_meshes(gpu, meshes)
    }

    /// Add every part of one model with the meshlets each brought ([`Renderer::add_meshes_with_meshlets`]).
    pub fn add_meshes_with_meshlets(&mut self, gpu: &Gpu, parts: Vec<(MeshData, Option<MeshletSet>)>) -> Result<Vec<MeshId>, RenderError> {
        self.renderer.add_meshes_with_meshlets(gpu, parts)
    }

    /// Add every part of one model with its meshlets and levels of detail
    /// ([`Renderer::add_model_parts`], renderer pass 2 A6.9).
    pub fn add_model_parts(&mut self, gpu: &Gpu, parts: Vec<crate::scene::ModelPart>) -> Result<Vec<MeshId>, RenderError> {
        self.renderer.add_model_parts(gpu, parts)
    }

    /// Add a skinned mesh.
    pub fn add_skinned_mesh(&mut self, gpu: &Gpu, data: &SkinnedMeshData) -> Result<SkinId, RenderError> {
        self.renderer.add_skinned_mesh(gpu, data)
    }

    /// Add a skinned GLB's mesh with its parts ([`Renderer::add_skinned_model`], game systems AN-17).
    pub fn add_skinned_model(&mut self, gpu: &Gpu, model: &SkinnedModel) -> Result<SkinId, RenderError> {
        self.renderer.add_skinned_model(gpu, model)
    }

    /// Add a texture.
    pub fn add_texture(&mut self, gpu: &Gpu, data: &TextureData, kind: TextureKind) -> Result<TextureId, RenderError> {
        self.renderer.add_texture(gpu, data, kind)
    }

    /// Add a compressed texture in the renderer's family ([`Renderer::add_compressed_texture`],
    /// renderer pass 2 A6.4).
    pub fn add_compressed_texture(&mut self, gpu: &Gpu, texture: &crate::texture::CompressedTexture, kind: TextureKind) -> Result<TextureId, RenderError> {
        self.renderer.add_compressed_texture(gpu, texture, kind)
    }

    /// Admit a custom material (`Material::custom(wgsl, uniforms)`); `uniforms` are its block's
    /// bytes (empty when it declares none).
    pub fn add_material(&mut self, gpu: &Gpu, wgsl: &str, uniforms: &[u8]) -> Result<CustomMaterialId, RenderError> {
        self.materials.add(gpu, wgsl, uniforms)
    }

    /// Replace a custom material's uniforms.
    pub fn set_material_uniforms(&mut self, gpu: &Gpu, material: CustomMaterialId, uniforms: &[u8]) -> Result<(), RenderError> {
        self.materials.set_uniforms(gpu, material, uniforms)
    }

    /// Admit a custom material at extension API `api` with its uniform bytes and, at API v2, the
    /// game's textures in binding order (`[[wgsl]] api`).
    pub fn add_material_api(&mut self, gpu: &Gpu, api: u32, wgsl: &str, uniforms: &[u8], textures: &[TextureData]) -> Result<CustomMaterialId, RenderError> {
        self.materials.add_api(gpu, api, wgsl, uniforms, textures)
    }

    /// Admit a post pass (`post_pass(wgsl)`).
    pub fn add_post_pass(&mut self, gpu: &Gpu, wgsl: &str, uniforms: &[u8]) -> Result<PostPassId, RenderError> {
        self.posts.add(gpu, wgsl, uniforms)
    }

    /// Admit a post pass at extension API `api` for `stage` (`hdr` takes API v2) with its uniform
    /// bytes and game textures.
    pub fn add_post_pass_api(
        &mut self,
        gpu: &Gpu,
        api: u32,
        stage: PostStage,
        wgsl: &str,
        uniforms: &[u8],
        textures: &[TextureData],
    ) -> Result<PostPassId, RenderError> {
        self.posts.add_api(gpu, api, stage, wgsl, uniforms, textures)
    }

    /// The last frame's Level-2 material draws: (draws issued, pipeline binds) (renderer pass 2
    /// A.0, LG-20).
    pub fn custom_material_draws(&self) -> (u32, u32) {
        (self.materials.frame_draws(), self.materials.frame_pipeline_binds())
    }

    /// The draw calls the last frame's Level-2 material draws took (renderer pass 2 A.0, LG-20
    /// step 3: one instanced call per run of a v2 (material, mesh) pair).
    pub fn custom_material_draw_calls(&self) -> u32 {
        self.materials.frame_draw_calls()
    }

    /// Bytes the frame holds on the GPU beside the mesh library: the renderer's pooled targets,
    /// the post passes' scratch copies, the meshlet path's tables and working buffers (0 on the
    /// instance path) and the material texture arrays as allocated. What a memory budget is
    /// checked against.
    pub fn held_bytes(&self) -> u64 {
        let targets = self.renderer.targets().ledger().total().saturating_add(self.posts.scratch_bytes());
        let temporal = self.renderer.temporal_bytes();
        targets.saturating_add(self.renderer.meshlet_bytes()).saturating_add(self.renderer.texture_bytes()).saturating_add(temporal)
    }

    /// What the last frame's Level-2 v2 sources read about it ([`FrameFacts`]: sizes, camera,
    /// history, scene and exposure).
    pub fn material_frame_facts(&self) -> FrameFacts {
        self.materials.frame_facts()
    }

    /// Why frames that ask for HDR draw on the legacy LDR scene because of what this renderer
    /// holds: a v1 custom material (`material-v1-in-hdr`). A frame's custom stage may add its own
    /// (a v1 in-world pass).
    pub fn ldr_reason(&self) -> Option<LdrReason> {
        self.materials.ldr_reason()
    }

    /// The pipeline facts the next frame's world pass draws with when its custom stage gives
    /// `stage_reason` to stay LDR: what in-world pipelines (Level-3 passes included) are built
    /// against before it.
    pub fn pipeline_facts(&self, stage_reason: Option<LdrReason>) -> PipelineFacts {
        let scene = self.renderer.next_scene(self.ldr_reason().or(stage_reason));
        PipelineFacts::for_scene(&scene, self.renderer.sample_count())
    }

    /// Build the in-world pipelines this renderer holds (materials, particles, `hdr`-stage post
    /// passes) against `facts` when they moved.
    fn follow_scene(&mut self, gpu: &Gpu, facts: PipelineFacts) -> Result<(), RenderError> {
        self.materials.set_pipeline_facts(gpu, facts)?;
        // HDR scenes draw reversed depth; the legacy LDR scene standard Z.
        self.materials.set_sun_shadows(self.renderer.sun_shadow_constants(facts.depth_reversed));
        self.materials.set_ao_gi(self.renderer.ao_gi(facts.depth_reversed));
        self.posts.set_pipeline_facts(gpu, facts)?;
        self.particles.set_scene(&gpu.device, facts.scene_format, facts.depth_reversed);
        Ok(())
    }

    /// Add a particle emitter.
    pub fn add_emitter(&mut self, gpu: &Gpu, desc: EmitterDesc) -> Result<EmitterId, RenderError> {
        self.particles.add(gpu, desc)
    }

    /// Add a flipbook atlas emitters can name ([`crate::particles::Flipbook`]).
    pub fn add_particle_atlas(&mut self, gpu: &Gpu, atlas: &ParticleAtlas) -> Result<ParticleAtlasId, RenderError> {
        self.particles.add_atlas(gpu, atlas)
    }

    /// Draw at most `cap` particles a frame ([`crate::particles::particle_cap`] of the device's
    /// class; every n-th slot past it). Desktop's cap until set.
    pub fn set_particle_cap(&mut self, cap: u32) {
        self.particles.set_cap(cap);
    }

    /// The emitter's description.
    pub fn emitter(&self, id: EmitterId) -> Option<EmitterDesc> {
        self.particles.desc(id)
    }

    /// Bytes the particle rows hold on the GPU.
    pub fn particle_bytes(&self) -> u64 {
        self.particles.bytes()
    }

    /// Custom materials, post passes and emitters held.
    pub fn extension_counts(&self) -> (usize, usize, usize) {
        (self.materials.len(), self.posts.len(), self.particles.len())
    }

    /// Draw `frame` into the world target, then the HUD through `overlay`. A refusal (caps,
    /// unknown ids, the upload budget) comes before the world pass, so the target keeps the
    /// previous frame.
    pub fn render(&mut self, gpu: &Gpu, frame: &ImmediateFrame, path: CullPath, overlay: Option<&mut dyn OverlayPainter>) -> Result<FrameReport, RenderError> {
        self.render_with(gpu, frame, path, overlay, &mut NoCustom)
    }

    /// [`FrameRenderer::render`] with `custom`'s passes (M2.19): compute before the cull, draws in
    /// the world pass, post work after the post passes and before the HUD; each counts one
    /// logical draw under [`CUSTOM_TAG`]. One run of the frame graph: the world, 2D and post-pass
    /// work share a submission, the Level-3 `post` passes and the HUD follow.
    pub fn render_with(
        &mut self,
        gpu: &Gpu,
        frame: &ImmediateFrame,
        path: CullPath,
        overlay: Option<&mut dyn OverlayPainter>,
        custom: &mut dyn CustomStage,
    ) -> Result<FrameReport, RenderError> {
        frame.check_caps()?;
        self.posts.check(&frame.post)?;
        let (history, live) = self.next_history(frame);
        let hdr_posts = frame.post.iter().any(|id| self.posts.stage(*id) == Some(PostStage::Hdr));
        // Node 18's readers need the resolved 1x scene (desktop MSAA fuses it into the tonemap otherwise).
        self.renderer.set_hdr_scene_readers(hdr_posts || custom.runs(PassStage::PostHdr));
        let stage_reason = self.ldr_reason().or(custom.ldr_reason());
        // Level-2 and Level-3 v2 sources read the frame's own history, scene and look.
        let scene = self.renderer.next_scene(stage_reason);
        let look = self.renderer.look();
        let ev_compensation = if scene.hdr && self.renderer.quality().exposure { look.ev_compensation } else { 0.0 };
        self.materials.set_frame_facts(v2_frame_facts(&self.renderer, frame, &history, &scene, ev_compensation));
        self.materials.keep_frame_v2(frame.post.iter().any(|id| self.posts.api(*id) == Some(crate::abi::ABI_V2)));
        custom.begin_frame(&StageFrame { history, ev_compensation, camera: frame.scene().camera });
        // The environment as it stands (graph node 11 hands over a new bake when it lands): the
        // frames that bake nothing, or whose node 11 does not run, bind what the forward pass binds.
        let environment = self.renderer.environment_views();
        self.materials.set_environment(environment.clone());
        if let Some(views) = &environment {
            custom.environment(views);
        }
        // Part-2 uploads have a budget of their own beside the part-1 tables' (TODO(M7.0): one
        // budget for the whole frame; the facade draws through FrameRenderer since the M2 review).
        let mut budget = UploadBudget::new();
        budget.charge(frame.quad_bytes())?;
        budget.charge(self.materials.prepare(gpu, &frame.custom, frame.seconds, self.renderer.library())?)?;
        budget.charge(self.particles.prepare(gpu, &frame.particles)?)?;
        self.start_history(gpu, &history)?;
        // A dynamic-resolution step restarts the index but keeps these (RC-05).
        if history.drops_history() {
            self.renderer.reset_shadow_history();
            self.renderer.reset_ao_history();
            if self.settle.is_none() {
                // A camera cut starts the meshlet visibility over too: pass 1 draws nothing of
                // the last shot. A capture's reset is its own and never drops Live's.
                self.renderer.reset_meshlet_history();
            }
        }
        self.renderer.set_frame_index(history.frame_index);
        // A dynamic-resolution step restarts the index but keeps TAA's and the motion history.
        self.renderer.set_temporal_kept(history.reset.is_some_and(|reason| !crate::post::taa::resets_history(reason)));
        self.renderer.set_history_set(history.set);
        self.ensure_exposure(gpu)?;
        self.follow_scene(gpu, self.pipeline_facts(stage_reason))?;
        // Inputs drive producers: what the frame's Level-3 passes and the Level-2 v2 sources it
        // draws read decides whether the prepass runs, whatever the preset's own consumers say.
        // Soft and colliding particles read the scene's depth where the quality lets the prepass run
        // (renderer pass 2 A.11).
        let particle_inputs = self.particles.inputs_of(&frame.particles, self.renderer.quality().prepass);
        let extension_inputs = self.materials.inputs_of(&frame.custom) | self.posts.inputs_of(&frame.post) | particle_inputs;
        let demand = ExtensionDemand { extension_inputs, ..custom.prepass_demand() };
        let stage_prepass = StagePrepass { demand, draws: self.materials.prepass_draws() };
        // The terrain's grass sways in the shared wind at the tick's simulated seconds (A.8).
        self.renderer.set_foliage_seconds(frame.seconds);
        let prep = self.renderer.begin_frame_prepass(frame.scene(), path, stage_reason, stage_prepass)?;
        // TAA's reactive coverage marks the billboards too (graph node 15a).
        if let Some((node, reversed)) = self.renderer.reactive_node() {
            self.particles.ensure_reactive(&gpu.device, node, reversed)?;
        }
        // A Live frame whose camera crossed into or out of a declared room adapts faster.
        let lighting = &frame.scene().lighting;
        let rooms = crate::post::exposure::rooms_around(frame.scene().camera.eye, &lighting.irradiance_volumes, &lighting.reflection_probes);
        let doorway = history.set == HistorySet::Live && self.renderer.look().doorway_adaptation;
        let boost = if doorway { self.room_adaptation.step(rooms, history.ticks) } else { 1.0 };
        let exposure = exposure_frame(&mut self.exposure, &self.renderer, &history, boost);
        let pre_exposure = exposure.as_ref().and_then(|work| auto_pre_exposure(work));
        let frame_v2 = self.materials.frame_v2().cloned();
        let mut encoder = FrameEncoder::new(&gpu.device, &gpu.queue, "frame");
        let mut nodes = FrameNodesOf {
            world: self.renderer.world_nodes(&prep),
            stage: Part2Stage { device: &gpu.device, queue: &gpu.queue, materials: &mut self.materials, particles: &mut self.particles, custom: &mut *custom, pre_exposure },
            gpu,
            frame,
            quads: &mut self.quads,
            posts: &mut self.posts,
            // The painter's own lifetime is shortened to the frame's.
            overlay: overlay.map(|painter| -> &mut dyn OverlayPainter { painter }),
            quad_draws: 0,
            hud: None,
            exposure,
            hdr_posts,
            frame_index: history.frame_index,
            frame_v2,
            environment,
            prepass: None,
            motion: None,
        };
        // Bracketed per graph step while per-node GPU timing is armed (PROF-5); a capture never is.
        let ran = self.renderer.run_timed_frame(&mut nodes, &mut encoder);
        let (quad_draws, hud) = (nodes.quad_draws, nodes.hud);
        let done = nodes.world.finish();
        self.renderer.end_frame(prep, done);
        let steps = ran?;
        self.commit_history(history, live);
        let encoded: usize = steps.iter().map(|step| step.nodes().len()).sum();
        self.nodes_encoded = self.nodes_encoded.saturating_add(encoded as u64);
        Ok(self.report(frame, path, quad_draws, custom.custom_draws(), hud))
    }

    /// Where the next frame sits in its history: the settle re-render in progress, or Live's next
    /// frame with the reset it causes. Nothing moves yet: [`FrameRenderer::start_history`] hands
    /// the reset to every node with history once the frame is admitted, and Live's history moves
    /// only once the frame is drawn ([`FrameRenderer::commit_history`]).
    fn next_history(&mut self, frame: &ImmediateFrame) -> (FrameHistory, LiveHistory) {
        let paced_ticks = self.paced_ticks.take();
        if let Some(settle) = self.settle {
            return (FrameHistory::settled(settle), self.live);
        }
        let key = HistoryKey { output: self.renderer.size(), render: self.renderer.render_size(), quality: *self.renderer.quality() };
        let mut live = self.live;
        let history = live.step(LiveFrame { tick: frame.tick, paced_ticks, key, camera: &frame.scene.camera, cut: frame.camera_cut });
        (history, live)
    }

    /// Bring every node with history to `history`: synced to the settle re-render in progress, or
    /// reset with Live's history.
    fn start_history(&mut self, gpu: &Gpu, history: &FrameHistory) -> Result<(), RenderError> {
        if let Some(settle) = self.settle {
            for node in self.exposure.iter_mut() {
                node.settle_sync(gpu, settle)?;
            }
            return Ok(());
        }
        if let Some(reason) = history.reset {
            for node in self.exposure.iter_mut() {
                node.settle_reset(gpu, HistorySet::Live, reason)?;
            }
            self.renderer.reset_temporal_history(HistorySet::Live, reason);
        }
        Ok(())
    }

    /// Keep where a drawn frame sat: Live's history moves on, or the settle advances.
    fn commit_history(&mut self, history: FrameHistory, live: LiveHistory) {
        match self.settle {
            Some(settle) => self.settle = Some(settle.next()),
            None => self.live = live,
        }
        self.last_history = Some(history);
    }

    /// Make the exposure node the first time a frame meters (auto exposure on the HDR path).
    fn ensure_exposure(&mut self, gpu: &Gpu) -> Result<(), RenderError> {
        let meters = self.hdr_session() && exposure_source(self.renderer.look(), self.renderer.quality()) == ExposureSource::Auto;
        if self.exposure.is_none() && meters {
            self.exposure = Some(ExposureHistories::new(gpu, self.renderer.look())?);
        }
        Ok(())
    }

    /// Whether frames can draw the HDR path: the session's scene format is HDR and the quality
    /// asks for it.
    fn hdr_session(&self) -> bool {
        self.renderer.quality().hdr && self.renderer.hdr_scene_format() != WORLD_FORMAT
    }

    /// One display frame that ran `ticks` sim ticks (RQ0.12, [`crate::pacing`]): a frame with a
    /// tick (or the first, or a stale one) runs the graph like [`FrameRenderer::render`] and
    /// answers its report, advancing [`FrameRenderer::frame_index`] by `ticks`; a repeat frame
    /// encodes nothing and answers None, and the shell shows the last world target again
    /// ([`FrameRenderer::present_repeat`]).
    pub fn render_paced(
        &mut self,
        gpu: &Gpu,
        ticks: u32,
        frame: &ImmediateFrame,
        path: CullPath,
        overlay: Option<&mut dyn OverlayPainter>,
    ) -> Result<Option<FrameReport>, RenderError> {
        self.render_paced_with(gpu, ticks, frame, path, overlay, &mut NoCustom)
    }

    /// [`FrameRenderer::render_paced`] with `custom`'s passes ([`FrameRenderer::render_with`]).
    pub fn render_paced_with(
        &mut self,
        gpu: &Gpu,
        ticks: u32,
        frame: &ImmediateFrame,
        path: CullPath,
        overlay: Option<&mut dyn OverlayPainter>,
        custom: &mut dyn CustomStage,
    ) -> Result<Option<FrameReport>, RenderError> {
        match self.gate.frame(ticks) {
            FrameAction::Repeat => Ok(None),
            FrameAction::Render => {
                self.paced_ticks = Some(ticks);
                let drawn = self.render_with(gpu, frame, path, overlay, custom);
                // A refused frame leaves no count behind for the next one.
                self.paced_ticks = None;
                drawn.map(Some)
            }
        }
    }

    /// Show the last world target again on a repeat frame: letterbox it into `target` (a window
    /// surface's view of `format`, `window` pixels) through the window present, no graph node.
    pub fn present_repeat(&mut self, gpu: &Gpu, target: &wgpu::TextureView, format: wgpu::TextureFormat, window: (u32, u32)) {
        self.renderer.present(gpu, target, format, window);
    }

    /// The next paced frame renders even without a tick (a verb, a resize, input the HUD reads).
    pub fn mark_stale(&mut self) {
        self.gate.mark_stale();
    }

    /// Live's temporal history starts over at the next frame for `reason` (a camera cut, a new
    /// surface): its frame index returns to 0, every node with history resets its Live set, and
    /// the next paced frame renders. Resizes, scale steps, quality changes and rewound ticks are
    /// noticed without asking ([`crate::settle`]).
    pub fn reset_history(&mut self, reason: HistoryReset) {
        self.gate.reset_history();
        self.live.reset(reason);
    }

    /// Live's frames drawn since its last history reset, after the last Live frame. A
    /// settled capture does not move it.
    pub fn frame_index(&self) -> u64 {
        self.live.frame_index()
    }

    /// Where the last frame drawn sat in its history (None before the first).
    pub fn last_history(&self) -> Option<FrameHistory> {
        self.last_history
    }

    /// Re-renders a settled capture needs with the renderer's current quality and look
    /// ([`crate::settle::settle_frames`]).
    pub fn settle_frames(&self) -> u32 {
        self.settle_frames_graded(false)
    }

    /// [`FrameRenderer::settle_frames`] for a frame whose game passes change the HDR scene before
    /// it is metered (`graded`: a Level-3 `post-hdr` pass runs; [`crate::settle::settle_plan_graded`]).
    pub fn settle_frames_graded(&self, graded: bool) -> u32 {
        let frames = crate::settle::settle_plan_graded(self.renderer.quality(), self.renderer.look(), self.hdr_session(), graded).frames;
        // TAA upscaling settles over its own (longer) jitter cycle below scale 1 (B.8), within the
        // wire's cap (18 phases at 0.67 settle 16).
        frames.max(self.renderer.upscale_settle_frames().min(crate::settle::SETTLE_FRAMES_MAX))
    }

    /// Draw the next frames as the `frames` re-renders of a settled capture of one Sim state, on
    /// the capture's own history (reset to its initial state now), until
    /// [`FrameRenderer::end_settle`]. For a caller that draws each re-render itself (the
    /// presenter, whose Level-3 passes run once per re-render); [`FrameRenderer::render_settled`]
    /// does all of it.
    pub fn begin_settle(&mut self, gpu: &Gpu, frames: u32) -> Result<(), RenderError> {
        // The nodes first: a refused reset leaves the renderer drawing Live frames.
        for node in self.exposure.iter_mut() {
            node.settle_reset(gpu, HistorySet::Capture, HistoryReset::Capture)?;
        }
        self.renderer.reset_temporal_history(HistorySet::Capture, HistoryReset::Capture);
        self.renderer.begin_capture_history();
        self.settle = Some(SettleFrame::first(frames));
        self.settled = self.settled.saturating_add(1);
        // A settled capture bakes its environment whole on every re-render (never a time slice),
        // so it is the same picture however many Live frames came before it.
        self.renderer.set_environment_settle(true);
        Ok(())
    }

    /// Draw Live frames again: Live's history resumes where it was.
    pub fn end_settle(&mut self) {
        self.settle = None;
        self.renderer.set_environment_settle(false);
        self.renderer.set_history_set(HistorySet::Live);
        self.renderer.end_capture_history();
        if self.renderer.tight_budget() {
            self.renderer.release_capture_history();
        }
    }

    /// The settle re-render the next frame draws (None: a Live frame).
    pub fn settling(&self) -> Option<SettleFrame> {
        self.settle
    }

    /// A settled capture of `frame`: `frames` re-renders (at least one) on the capture's own
    /// history, the HUD through `overlay` on the last; the world target then holds the picture a
    /// capture reads back. Live's history is untouched.
    pub fn render_settled(
        &mut self,
        gpu: &Gpu,
        frame: &ImmediateFrame,
        path: CullPath,
        overlay: Option<&mut dyn OverlayPainter>,
        frames: u32,
    ) -> Result<FrameReport, RenderError> {
        self.begin_settle(gpu, frames)?;
        let drawn = self.settle_all(gpu, frame, path, overlay);
        self.end_settle();
        drawn
    }

    fn settle_all(&mut self, gpu: &Gpu, frame: &ImmediateFrame, path: CullPath, overlay: Option<&mut dyn OverlayPainter>) -> Result<FrameReport, RenderError> {
        while self.settle.is_some_and(|settle| !settle.is_last()) {
            self.render(gpu, frame, path, None)?;
        }
        self.render(gpu, frame, path, overlay)
    }

    /// Paced display frames rendered and repeated (`volatile.render.frames`).
    pub fn tally(&self) -> FrameTally {
        self.gate.tally()
    }

    /// Frame-graph nodes encoded since this renderer was made (every frame, paced or not).
    pub fn nodes_encoded(&self) -> u64 {
        self.nodes_encoded
    }

    /// Settled captures begun since this renderer was made (a renderer that drew one has the
    /// capture path's pipelines).
    pub fn settled_captures(&self) -> u32 {
        self.settled
    }

    fn report(&self, frame: &ImmediateFrame, path: CullPath, quad_draws: u32, custom: u32, hud: Option<u32>) -> FrameReport {
        let mut counter = frame.counter.clone();
        counter.add(CUSTOM_TAG, custom);
        counter.add(HUD_TAG, hud.unwrap_or(0));
        let stats = self.renderer.last_stats();
        let lines = u32::from(!frame.scene.lines.is_empty());
        let (custom, emitters, posts) = (self.materials.frame_draws(), self.particles.frame_draws(), frame.post.len() as u32);
        let culled_on_gpu = path == CullPath::Gpu && stats.batches > 0;
        let gpu = GpuCounters {
            encoder_draws: stats.multi_draws + stats.direct_opaque_draws + stats.transparent_draws + lines + custom + emitters + quad_draws + posts + hud.unwrap_or(0),
            dispatches: u32::from(stats.skin_jobs > 0) + u32::from(culled_on_gpu) + emitters,
            // The renderer's own passes: the shadow cascades, the world pass and, below scale 1,
            // the upscale.
            passes: stats.render_passes + quad_draws + posts + custom + u32::from(hud.is_some()),
        };
        FrameReport { draw_calls: counter.total(), tags: counter.tags().to_vec(), gpu }
    }

    /// Read the world target back (native; BGRA, top row first).
    #[cfg(not(target_arch = "wasm32"))]
    pub fn capture(&self, gpu: &Gpu) -> Result<Capture, RenderError> {
        self.renderer.capture(gpu)
    }

    /// [`FrameRenderer::capture`] as a future (the web).
    pub async fn capture_async(&self, gpu: &Gpu) -> Result<Capture, RenderError> {
        self.renderer.capture_async(gpu).await
    }
}
