//! Motion vectors (plan §2.2 node 7; RQ5). RQ5.0 landed the contract: the `rg16float` motion
//! target the prepass writes ([`target`]), the previous-model table that sits parallel to the
//! instance table ([`crate::layout::GpuPrevModel`], one row per instance row, so `GpuInstance`
//! and the published v1 `GxInstance` never grow), its flags, and the draw ids a game names with
//! `frame.id(key)` ([`DrawId`]). RQ5.1 fills it:
//!
//! - **Row identity** ([`MotionRow`], built by the plan): a row the game named with an id is
//!   keyed by the id and its ordinal within the id (skinned rows count apart), else by its mesh,
//!   its kind (opaque, transparent, skinned) and its ordinal within its batch.
//! - **Matching** ([`MotionHistory::apply`]): a row whose key was drawn last frame takes that
//!   frame's model matrix. An unmatched row, an ordinal match whose bounds jumped
//!   ([`jumped`]: an id-less instance removed or reordered shifts the ordinals after it), or a
//!   row with a non-finite transform keeps its current model (zero object motion) and sets
//!   [`MOTION_FLAG_NO_HISTORY`], so TAA takes the current sample there instead of smearing.
//!   Id matches are trusted (a game teleporting an id'd object calls a camera cut).
//! - **Skinned rows**: the skinned output is double-buffered ([`crate::skin`]'s `SkinnedPair`);
//!   a matched skinned row of the same mesh reads last frame's skinned vertex at its previous
//!   base (`PrevModel.flags.y`, [`NO_PREV_VERTICES`] for none) under last frame's model.
//! - **The pass** (`vs_prepass_motion`/`fs_prepass_motion` in shaders/prepass.wgsl,
//!   [`MotionNode`]): the prepass's draws into three targets, the normals, the motion
//!   ([`MOTION_FORMAT`], NDC current − previous of the unjittered clip positions, so the jitter is
//!   removed) and TAA's reactive mask (1 where a row has no history). Rasterization is jittered
//!   through `gx_clip_position` exactly as the scene's, so depth stays `Equal`-compatible.
//! - **The background** (renderer pass 2, P2-0.8b T-03; [`MotionNode::background_pipeline`],
//!   shaders/motion_background.wgsl): after the geometry, one full-screen triangle at the far plane
//!   tested `Equal` against the cleared depth writes the camera's own motion where nothing was
//!   drawn ([`GpuMotionFrame::reproject`] at device depth far), so the sky, its sun disc and the
//!   fog horizon reproject with a turning camera instead of reading zero.
//! - **Custom draws** (P2-0.8b T-04, LG-05; [`CustomMotion`]): a Level-2 custom draw is keyed by
//!   its draw id and ordinal within it, else by its mesh and ordinal, and matched against last
//!   frame's custom draws as instance rows are; the prepass draws it from last frame's model
//!   ([`crate::prepass::GpuPrepassDraw::prev_model`]) and an unmatched one takes the current sample.
//!
//! A camera cut, or any [`crate::settle::HistoryReset`], resets the history
//! ([`MotionStep::reset`]): every row has no history and the previous camera is the current one.
//!
//! The frame path (RQ5.6, `renderer.rs`) runs it whenever TAA resolves or a Level-2/Level-3
//! extension declares the `motion` input: a [`MotionHistory`] per history set (Live's and a
//! capture's own), the motion pipelines beside the prepass's, last frame's skinned vertices copied
//! out of the skinned table before this frame skins, and the jitter in `FrameUniforms::jitter`. A
//! frame writing motion draws every batch on the instance path (the meshlet draws have no motion
//! variant). [`motion_images`] and [`motion_gpu_ms`] run the node on its own (tests/motion.rs).

use crate::compile::Compiled;
use std::collections::BTreeMap;

use bytemuck::{Pod, Zeroable};
use glam::{Mat4, Vec3, Vec4};
use wgpu::{BindGroupLayout, Buffer, BufferUsages, Device, Queue, RenderPipeline, ShaderModule, ShaderStages, Texture, TextureFormat, TextureUsages, TextureView};

use crate::error::RenderError;
use crate::gpu::Gpu;
use crate::layout::{GpuInstance, GpuPassView, GpuPrevModel};
use crate::readback::{capture_failed, map_read_blocking};
use crate::scene::{FramePlan, MeshId, MeshLibrary, Scene};
use crate::skin::{SkinBuffers, SkinPass, SkinnedPair};
use crate::tables::{VERTEX_STRIDE, aligned, buffer, entry, pipeline_layout, storage, uniform};
use crate::target_pool::TargetDesc;

/// Whether the prepass writes motion and the graph lists the motion target: true since RQ5.6,
/// when the renderer's frame path draws through [`MotionNode`] (module docs).
pub const LANDED: bool = true;
/// The motion target's format: NDC motion (current − previous, jitter removed), fragment-written.
pub const MOTION_FORMAT: TextureFormat = TextureFormat::Rg16Float;
/// The motion target's usages.
pub const MOTION_USAGE: TextureUsages = TextureUsages::RENDER_ATTACHMENT.union(TextureUsages::TEXTURE_BINDING);
/// The motion target's pool label.
pub const MOTION_LABEL: &str = "motion";
/// Bytes of one motion texel (two halves).
pub const MOTION_TEXEL_BYTES: u64 = 4;

/// Flag bit of a previous-model row (`PrevModel.flags.x`): the row has no usable history (no
/// match last frame, or a match that jumped), so its pixels are reactive and TAA uses the current
/// sample there.
pub const MOTION_FLAG_NO_HISTORY: u32 = 1;
/// Flag bit: the row was matched by its draw id (else by mesh ordinal, or not at all).
pub const MOTION_FLAG_MATCHED_BY_ID: u32 = 1 << 1;
/// Flag bit: the row's previous model is its current one and it has no previous skinned vertices
/// (a still instance, or one without history), so the motion pass takes its world position as
/// last frame's instead of transforming the vertex again (RQ5 review: most of a scene's instances
/// do not move, and the second transform was the motion prepass's vertex cost).
pub const MOTION_FLAG_STILL: u32 = 1 << 2;
/// `PrevModel.flags.y` of a row without last frame's skinned vertices (a static row, or a skinned
/// row with no skinned match): the vertex's current model-space position stands in.
pub const NO_PREV_VERTICES: u32 = u32::MAX;
/// An ordinal match jumped when its bounds' centre moved more than this many radii (the larger of
/// the two frames') in one frame: a removed or reordered id-less instance shifts the ordinals
/// after it by at least one spacing, which for instances that do not overlap is two radii.
pub const JUMP_RADII: f32 = 1.0;
/// An ordinal match jumped when its bounds' radius changed by more than this factor.
pub const JUMP_SCALE: f32 = 2.0;

/// The prepass's motion vertex entry point (the opaque batches through the camera view).
pub const VERTEX_ENTRY: &str = "vs_prepass_motion";
/// The prepass's motion vertex entry point for a world stage's custom geometry (camera motion only).
pub const DRAW_VERTEX_ENTRY: &str = "vs_prepass_draw_motion";
/// The prepass's motion fragment entry point.
pub const FRAGMENT_ENTRY: &str = "fs_prepass_motion";
/// The background-motion module (T-03): the camera's motion where no geometry was drawn.
pub const BACKGROUND_MOTION: &str = crate::shaders::minify::shipped_wgsl!(include_str!("../shaders/motion_background.wgsl"));
/// Its vertex entry point (one full-screen triangle at the far plane).
pub const BACKGROUND_VERTEX_ENTRY: &str = "vs_background_motion";
/// Its fragment entry point (the motion target alone).
pub const BACKGROUND_FRAGMENT_ENTRY: &str = "fs_background_motion";
/// The motion prepass's colour targets, in location order: the normals, the motion and TAA's
/// reactive mask.
pub const TARGET_FORMATS: [TextureFormat; 3] = [crate::prepass::NORMALS_FORMAT, MOTION_FORMAT, crate::post::taa::REACTIVE_FORMAT];
/// The motion target's location among [`TARGET_FORMATS`] (the normals share its format).
pub const MOTION_LOCATION: u32 = 1;

/// The WGSL mirror of [`GpuPrevModel`] (`PrevModel`): the shader that reads the previous-model
/// table (shaders/prepass.wgsl) declares it, and tests/layout.rs holds both to one size.
pub const PREV_MODEL_WGSL: &str = "
// Mirrors `layout::GpuPrevModel`: one row per instance-table row, at the same index.
struct PrevModel {
    // Last frame's model matrix (this frame's when the row has no history).
    model: mat4x4<f32>,
    // x: MOTION_FLAG_* bits; y: the first of last frame's skinned vertices (NO_PREV_VERTICES:
    // none); z: the first of this frame's skinned vertices; w: reserved (0).
    flags: vec4<u32>,
}
";

/// The motion target at `render` size.
pub fn target(render: (u32, u32)) -> TargetDesc {
    let size = (render.0.max(1), render.1.max(1));
    TargetDesc { label: MOTION_LABEL, format: MOTION_FORMAT, usage: MOTION_USAGE, samples: 1, size, mips: 1, srgb_view: false }
}

/// The motion target's bytes at `render` size, for the budget ledger.
pub fn bytes(render: (u32, u32)) -> u64 {
    u64::from(render.0.max(1)) * u64::from(render.1.max(1)) * MOTION_TEXEL_BYTES
}

/// The previous-model rows of `plan`, one per instance row once [`MotionHistory::apply`] matched
/// them, else none (the table then holds no rows and nothing is uploaded).
pub fn prev_model_rows(plan: &FramePlan) -> Vec<GpuPrevModel> {
    plan.prev_models.clone()
}

/// A draw's identity across frames, named by the game with `frame.id(key)`: the FNV-1a 64 of a
/// string key's UTF-8 bytes, or an integer key itself. No hasher seed and no word size, so one
/// key names one id on every destination, in Live and in captures.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct DrawId(u64);

impl DrawId {
    /// The id of a string key.
    pub const fn from_key(key: &str) -> DrawId {
        DrawId(genex_core::digest::fnv1a64(key.as_bytes()))
    }

    /// The id's value.
    pub const fn get(self) -> u64 {
        self.0
    }
}

impl From<u64> for DrawId {
    fn from(key: u64) -> DrawId {
        DrawId(key)
    }
}

impl From<u32> for DrawId {
    fn from(key: u32) -> DrawId {
        DrawId(u64::from(key))
    }
}

impl From<&str> for DrawId {
    fn from(key: &str) -> DrawId {
        DrawId::from_key(key)
    }
}

impl From<&String> for DrawId {
    fn from(key: &String) -> DrawId {
        DrawId::from_key(key)
    }
}

// ---------------------------------------------------------------------------------------------
// Row identity and matching

/// What kind of row an id-less draw makes: ordinals count within the mesh's opaque batch, its
/// transparent draws, or its skinned draws.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum RowKind {
    /// An opaque library-mesh draw (a row of its mesh's batch).
    Opaque,
    /// A transparent library-mesh draw.
    Transparent,
    /// A skinned draw.
    Skinned,
}

/// Where a row's ordinal counts.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum MotionScope {
    /// Draws under a game's draw id (skinned ones count apart: their previous vertices differ).
    Id {
        /// The id.
        id: DrawId,
        /// Whether the draw is skinned.
        skinned: bool,
    },
    /// Draws without an id: the mesh and the kind of row.
    Mesh {
        /// The mesh.
        mesh: MeshId,
        /// The kind of row.
        kind: RowKind,
    },
}

/// A row's identity across frames: its scope and its ordinal within it, in draw order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct MotionKey {
    /// Where the ordinal counts.
    pub scope: MotionScope,
    /// The row's place among its scope's rows this frame, in draw order.
    pub ordinal: u32,
}

/// One instance row's identity and its skinned vertices ([`FramePlan::motion`], row for row).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MotionRow {
    /// Its identity.
    pub key: MotionKey,
    /// Its mesh (a skinned draw's bind-pose mesh).
    pub mesh: MeshId,
    /// A skinned row's first vertex in this frame's skinned output.
    pub skinned_base: Option<u32>,
}

/// Counts ordinals while a plan is built: an id-less scope's count in a table indexed by its mesh
/// and kind, an id's in a map (pass-1 gate perf finding 4: a map entry per row cost bench-city's
/// 64k instances milliseconds a frame).
#[derive(Default)]
pub(crate) struct MotionKeys {
    by_mesh: Vec<[u32; ROW_KINDS]>,
    by_id: BTreeMap<(DrawId, bool), u32>,
}

/// The kinds of row ([`RowKind`]).
const ROW_KINDS: usize = 3;

impl RowKind {
    /// Its column in [`MotionKeys`]'s table.
    const fn column(self) -> usize {
        match self {
            RowKind::Opaque => 0,
            RowKind::Transparent => 1,
            RowKind::Skinned => 2,
        }
    }
}

impl MotionKeys {
    /// The next row of a draw with `id` (or none) of `mesh` and `kind`.
    pub(crate) fn row(&mut self, id: Option<DrawId>, mesh: MeshId, kind: RowKind, skinned_base: Option<u32>) -> MotionRow {
        let (scope, next) = match id {
            Some(id) => {
                let skinned = kind == RowKind::Skinned;
                (MotionScope::Id { id, skinned }, self.by_id.entry((id, skinned)).or_insert(0))
            }
            None => {
                let at = mesh.raw() as usize;
                if self.by_mesh.len() <= at {
                    self.by_mesh.resize(at + 1, [0; ROW_KINDS]);
                }
                (MotionScope::Mesh { mesh, kind }, &mut self.by_mesh[at][kind.column()])
            }
        };
        let ordinal = *next;
        *next += 1;
        MotionRow { key: MotionKey { scope, ordinal }, mesh, skinned_base }
    }
}

/// Whether an ordinal match moved too far to be the same object: its world bounds' centre moved
/// more than [`JUMP_RADII`] radii, or its radius changed by more than [`JUMP_SCALE`].
pub fn jumped(prev: [f32; 4], now: [f32; 4]) -> bool {
    let moved = Vec3::new(now[0], now[1], now[2]).distance(Vec3::new(prev[0], prev[1], prev[2]));
    let reach = prev[3].max(now[3]);
    let rescaled = now[3] > prev[3] * JUMP_SCALE || prev[3] > now[3] * JUMP_SCALE;
    // A NaN distance or radius compares as nothing: count it as a jump (no history).
    let within = moved.partial_cmp(&(JUMP_RADII * reach)).is_some_and(|order| order.is_le());
    !within || rescaled
}

/// What the motion pass's frame row needs besides the plan.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct MotionStep {
    /// This frame's jitter in NDC (`jitter::offset_ndc`), what `gx_clip_position` adds.
    pub jitter_ndc: [f32; 2],
    /// The history starts over (a camera cut or any other [`crate::settle::HistoryReset`]).
    pub reset: bool,
    /// Whether last frame's skinned output is still bound as the previous vertices.
    pub prev_vertices: bool,
}

/// The motion pass's frame row (`MotionFrame` in shaders/prepass.wgsl, group 2 binding 0).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuMotionFrame {
    /// Last frame's unjittered projection × view, column-major (this frame's after a reset).
    pub prev_view_proj: [f32; 16],
    /// xy: this frame's jitter in NDC (y up); zw: reserved (0).
    pub jitter: [f32; 4],
    /// Last frame's unjittered projection × view times this frame's inverse
    /// ([`crate::post::taa::reprojection`]): an unjittered NDC position (x, y, device depth) to
    /// last frame's clip space. The background's motion reads it at the far plane (T-03).
    pub reproject: [f32; 16],
}

/// Last frame's row of one key.
#[derive(Clone, Copy, Debug, PartialEq)]
struct PrevRow {
    model: [f32; 16],
    bounds: [f32; 4],
    mesh: MeshId,
    skinned_base: Option<u32>,
}

/// Last frame's rows and camera: what this frame's rows are matched against. The rows are kept in
/// last frame's plan order: a row whose key sits at its own index (a scene drawn as last frame) is
/// matched there, and only another row looks its key up, in a sorted index made for that frame
/// (pass-1 gate perf finding 4: a map of every row rebuilt each frame cost bench-city's 64k
/// instances milliseconds).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MotionHistory {
    rows: Vec<(MotionKey, PrevRow)>,
    /// The frame before last's rows' allocation, empty: this frame's rows are written into it.
    spare: Vec<(MotionKey, PrevRow)>,
    view_proj: Option<[f32; 16]>,
}

/// Last frame's rows by key: their packed keys and indices sorted by key, made on the first row
/// that is not at its own index.
struct RowIndex<'a> {
    rows: &'a [(MotionKey, PrevRow)],
    sorted: Option<Vec<(u128, u32)>>,
}

/// `key` as one integer, distinct for distinct keys: the scope's variant, its id or mesh, its
/// kind or skinned flag, then the ordinal. The row index sorts and searches these instead of the
/// keys themselves (GE fix r2: sorting the frontier's rows by `MotionKey`, through their indices,
/// was a fifth of a frame's CPU draw), and a sorted search finds the same row either way.
pub(crate) fn packed(key: &MotionKey) -> u128 {
    let (variant, id, flag) = match key.scope {
        MotionScope::Id { id, skinned } => (0u128, u128::from(id.0), u128::from(skinned)),
        MotionScope::Mesh { mesh, kind } => (1u128, u128::from(mesh.packed()), kind.column() as u128),
    };
    (variant << 98) | (id << 34) | (flag << 32) | u128::from(key.ordinal)
}

impl<'a> RowIndex<'a> {
    /// Last frame's row of `key` (a plan's keys are unique: an ordinal counts within its scope),
    /// looked for first at plan index `at`.
    fn get(&mut self, at: usize, key: &MotionKey) -> Option<&'a PrevRow> {
        let rows = self.rows;
        if let Some((held, prev)) = rows.get(at)
            && held == key
        {
            return Some(prev);
        }
        let sorted = self.sorted.get_or_insert_with(|| {
            let mut sorted: Vec<(u128, u32)> = rows.iter().enumerate().map(|(at, (key, _))| (packed(key), at as u32)).collect();
            sorted.sort_unstable_by_key(|(key, _)| *key);
            sorted
        });
        let wanted = packed(key);
        let found = sorted.binary_search_by_key(&wanted, |(key, _)| *key).ok()?;
        Some(&rows[sorted[found].1 as usize].1)
    }
}

impl MotionHistory {
    /// No history: the first frame's rows all have none.
    pub fn new() -> MotionHistory {
        MotionHistory::default()
    }

    /// Forget every row and the camera.
    pub fn reset(&mut self) {
        self.rows.clear();
        self.view_proj = None;
    }

    /// Rows remembered from the last frame.
    pub fn len(&self) -> usize {
        self.rows.len()
    }

    /// Whether no row is remembered.
    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    /// Match `plan`'s rows against last frame's, fill its previous-model table
    /// ([`FramePlan::prev_models`]) and remember this frame's rows; answer the frame row.
    pub fn apply(&mut self, plan: &mut FramePlan, step: MotionStep) -> GpuMotionFrame {
        if step.reset {
            self.reset();
        }
        let prev_view_proj = self.view_proj.unwrap_or(plan.frame.view_proj);
        let mut index = RowIndex { rows: &self.rows, sorted: None };
        plan.prev_models = plan
            .instances
            .iter()
            .zip(&plan.motion)
            .enumerate()
            .map(|(at, (row, motion))| prev_row(index.get(at, &motion.key), row, motion, step.prev_vertices))
            .collect();
        let mut rows = std::mem::take(&mut self.spare);
        rows.extend(
            plan.instances
                .iter()
                .zip(&plan.motion)
                .map(|(row, motion)| (motion.key, PrevRow { model: row.model, bounds: row.bounds, mesh: motion.mesh, skinned_base: motion.skinned_base })),
        );
        self.spare = std::mem::replace(&mut self.rows, rows);
        self.spare.clear();
        self.view_proj = Some(plan.frame.view_proj);
        let reproject = crate::post::taa::reprojection(&prev_view_proj, &plan.frame.view_proj);
        GpuMotionFrame { prev_view_proj, jitter: [step.jitter_ndc[0], step.jitter_ndc[1], 0.0, 0.0], reproject }
    }
}

/// The previous-model row of `row` given last frame's row of its key (`prev`): last frame's model
/// when its key matched usably, else its own with [`MOTION_FLAG_NO_HISTORY`].
fn prev_row(prev: Option<&PrevRow>, row: &GpuInstance, motion: &MotionRow, prev_vertices: bool) -> GpuPrevModel {
    let current_base = motion.skinned_base.unwrap_or(0);
    let none = GpuPrevModel { model: row.model, flags: [MOTION_FLAG_NO_HISTORY | MOTION_FLAG_STILL, NO_PREV_VERTICES, current_base, 0] };
    let Some(prev) = prev else { return none };
    let by_id = matches!(motion.key.scope, MotionScope::Id { .. });
    let finite = row.model.iter().chain(&prev.model).all(|v| v.is_finite());
    if !finite || (!by_id && jumped(prev.bounds, row.bounds)) {
        return none;
    }
    let same_vertices = prev_vertices && prev.mesh == motion.mesh && motion.skinned_base.is_some();
    let prev_base = prev.skinned_base.filter(|_| same_vertices).unwrap_or(NO_PREV_VERTICES);
    let matched = if by_id { MOTION_FLAG_MATCHED_BY_ID } else { 0 };
    let still = if prev.model == row.model && prev_base == NO_PREV_VERTICES { MOTION_FLAG_STILL } else { 0 };
    GpuPrevModel { model: prev.model, flags: [matched | still, prev_base, current_base, 0] }
}

// ---------------------------------------------------------------------------------------------
// Custom draws (renderer pass 2, P2-0.8b: T-04, LG-05)

/// Where a custom draw's ordinal counts: under the game's draw id, else among the id-less custom
/// draws of its mesh.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
enum CustomScope {
    Id(DrawId),
    Mesh(MeshId),
}

/// One custom draw of this frame as [`CustomMotion::apply`] matches it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CustomRow {
    /// The draw id current when it was drawn (`frame.id(key)`), if any.
    pub id: Option<DrawId>,
    /// Its mesh.
    pub mesh: MeshId,
    /// Its model matrix, column-major.
    pub model: [f32; 16],
    /// Its world bounding sphere (centre, radius), as an instance row's `bounds`.
    pub bounds: [f32; 4],
}

/// A custom draw's last-frame transform: last frame's model when its key matched usably, else its
/// own with `history` false (TAA then takes the current sample, as for an unmatched instance row).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CustomPrev {
    /// Last frame's model matrix (this frame's without history).
    pub model: [f32; 16],
    /// Whether the draw was matched (an unmatched one writes the no-history flag).
    pub history: bool,
}

/// Last frame's custom draws by key, and the simulated seconds that frame showed: what a frame's
/// Level-2 custom draws are matched against (T-04). Keys follow [`MotionHistory`]'s rules: a draw
/// under a draw id is its id and ordinal within it (an id match is trusted, the game's teleport is
/// a camera cut), an id-less one its mesh and ordinal (an ordinal match whose bounds [`jumped`] or
/// a non-finite transform has no history). A settled capture re-drawing one frame matches it
/// against itself: still, at no time step.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CustomMotion {
    rows: BTreeMap<(CustomScope, u32), ([f32; 16], [f32; 4])>,
    seconds: Option<f32>,
}

impl CustomMotion {
    /// No history: the first frame's draws all have none.
    pub fn new() -> CustomMotion {
        CustomMotion::default()
    }

    /// Forget every draw and the time.
    pub fn reset(&mut self) {
        self.rows.clear();
        self.seconds = None;
    }

    /// Match `draws` (this frame's, in draw order) against last frame's and remember them;
    /// answers each draw's previous transform and last frame's simulated seconds (`seconds`, this
    /// frame's, on the first frame).
    pub fn apply(&mut self, draws: &[CustomRow], seconds: f32) -> (Vec<CustomPrev>, f32) {
        let mut ordinals: BTreeMap<CustomScope, u32> = BTreeMap::new();
        let mut rows = BTreeMap::new();
        let prevs = draws
            .iter()
            .map(|draw| {
                let scope = draw.id.map_or(CustomScope::Mesh(draw.mesh), CustomScope::Id);
                let next = ordinals.entry(scope).or_insert(0);
                let key = (scope, *next);
                *next += 1;
                rows.insert(key, (draw.model, draw.bounds));
                custom_prev(self.rows.get(&key), draw, matches!(scope, CustomScope::Id(_)))
            })
            .collect();
        self.rows = rows;
        let prev_seconds = self.seconds.filter(|held| held.is_finite()).unwrap_or(seconds);
        self.seconds = Some(seconds);
        (prevs, prev_seconds)
    }
}

/// The previous transform of `draw` given last frame's row of its key (`prev`: model, bounds).
fn custom_prev(prev: Option<&([f32; 16], [f32; 4])>, draw: &CustomRow, by_id: bool) -> CustomPrev {
    let none = CustomPrev { model: draw.model, history: false };
    let Some((model, bounds)) = prev else { return none };
    let finite = draw.model.iter().chain(model).all(|v| v.is_finite());
    if !finite || (!by_id && jumped(*bounds, draw.bounds)) {
        return none;
    }
    CustomPrev { model: *model, history: true }
}

/// The NDC position of `world` under `view_proj` (column-major, unjittered): the CPU twin of the
/// motion pass's divide.
pub fn ndc(view_proj: &[f32; 16], world: [f32; 3]) -> [f32; 2] {
    let clip = Mat4::from_cols_array(view_proj) * Vec4::new(world[0], world[1], world[2], 1.0);
    [clip.x / clip.w, clip.y / clip.w]
}

/// The motion the pass writes for a point at `world` now and `prev_world` last frame: NDC now −
/// NDC then (the CPU reference of `fs_prepass_motion`).
pub fn motion_of(view_proj: &[f32; 16], prev_view_proj: &[f32; 16], world: [f32; 3], prev_world: [f32; 3]) -> [f32; 2] {
    let (now, then) = (ndc(view_proj, world), ndc(prev_view_proj, prev_world));
    [now[0] - then[0], now[1] - then[1]]
}

// ---------------------------------------------------------------------------------------------
// The pass

/// The motion prepass's group 2 (the frame row, the previous-model table and last frame's skinned
/// vertices) and its pipelines; the renderer passes its own frame and pass-view layouts, so the
/// forward pass's frame group binds unchanged.
pub struct MotionNode {
    layout: BindGroupLayout,
    /// The meshlet motion prepass's group 3: the frame row and the previous-model table only.
    meshlet_layout: BindGroupLayout,
    frame: Buffer,
    /// Bound as the previous vertices or models when a frame has none.
    empty: Buffer,
}

impl MotionNode {
    /// The node, its group layout and its frame row.
    pub fn new(device: &Device) -> Result<MotionNode, RenderError> {
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("motion"),
            entries: &[uniform(0, false, ShaderStages::VERTEX), storage(1, true, ShaderStages::VERTEX), storage(2, true, ShaderStages::VERTEX)],
        });
        // Beside the frame group's three and the meshlet group's four vertex storage buffers, one
        // more keeps the meshlet motion prepass within WebGPU core's eight per stage.
        let meshlet_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("meshlet motion"),
            entries: &[uniform(0, false, ShaderStages::VERTEX), storage(1, true, ShaderStages::VERTEX)],
        });
        let frame = buffer(device, "motion frame", size_of::<GpuMotionFrame>() as u64, BufferUsages::UNIFORM | BufferUsages::COPY_DST)?;
        let empty = buffer(device, "motion empty", aligned(0), BufferUsages::STORAGE)?;
        Ok(MotionNode { layout, meshlet_layout, frame, empty })
    }

    /// The meshlet motion prepass's group 3 layout (`meshlet_motion_frame`, `meshlet_prev_models`
    /// in shaders/meshlet_draw.wgsl; RQ5.6).
    pub fn meshlet_layout(&self) -> &BindGroupLayout {
        &self.meshlet_layout
    }

    /// The meshlet motion prepass's group 3 over the frame's previous-model table.
    pub fn meshlet_group(&self, device: &Device, prev_models: &Buffer) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("meshlet motion"),
            layout: &self.meshlet_layout,
            entries: &[entry(0, &self.frame), entry(1, prev_models)],
        })
    }

    /// Group 2's layout (`motion_frame`, `prev_models`, `prev_skinned`).
    pub fn layout(&self) -> &BindGroupLayout {
        &self.layout
    }

    /// Queue this frame's row.
    pub fn write(&self, queue: &Queue, row: &GpuMotionFrame) {
        queue.write_buffer(&self.frame, 0, bytemuck::bytes_of(row));
    }

    /// Group 2 over the frame's previous-model table and last frame's skinned vertices (none: an
    /// empty table, read by no row).
    pub fn group(&self, device: &Device, prev_models: &Buffer, prev_vertices: Option<&Buffer>) -> wgpu::BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("motion"),
            layout: &self.layout,
            entries: &[entry(0, &self.frame), entry(1, prev_models), entry(2, prev_vertices.unwrap_or(&self.empty))],
        })
    }

    /// A motion prepass pipeline drawing `vertex` of `module` (the prepass module) with the mesh
    /// `buffers`, over `groups` (the frame's and the pass view's, or the custom-geometry row's)
    /// and group 2, into [`TARGET_FORMATS`] and a depth of `reversed` convention.
    pub fn pipeline(&self, device: &Device, module: &ShaderModule, vertex: &str, buffers: &[Option<wgpu::VertexBufferLayout<'_>>], groups: [&BindGroupLayout; 2], reversed: bool) -> Compiled<RenderPipeline> {
        let layout = pipeline_layout(device, vertex, &[groups[0], groups[1], &self.layout]);
        let targets = TARGET_FORMATS.map(|format| Some(wgpu::ColorTargetState { format, blend: None, write_mask: wgpu::ColorWrites::ALL }));
        crate::compile::render_pipeline(device, &wgpu::RenderPipelineDescriptor {
            label: Some(vertex),
            layout: Some(&layout),
            vertex: wgpu::VertexState { module, entry_point: Some(vertex), compilation_options: Default::default(), buffers },
            primitive: wgpu::PrimitiveState { cull_mode: Some(wgpu::Face::Back), ..Default::default() },
            depth_stencil: Some(depth_state(reversed)),
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState { module, entry_point: Some(FRAGMENT_ENTRY), compilation_options: Default::default(), targets: &targets }),
            multiview_mask: None,
            cache: None,
        })
    }

    /// The prepass's surface twin's pipeline (lane FR, `shaders::PREPASS_SURFACE`): `vertex` and
    /// `fragment` of `module` over `groups` and this node's group 2, into the three prepass
    /// targets ([`TARGET_FORMATS`]) and A.6's normal and roughness at location 3, culled and
    /// depth-tested as [`MotionNode::pipeline`]'s, the module's overrides set to `constants`.
    #[allow(clippy::too_many_arguments, reason = "a pipeline's module, entries, buffers, groups, depth and constants")]
    pub fn surface_pipeline(
        &self,
        device: &Device,
        module: &ShaderModule,
        (vertex, fragment): (&str, &str),
        buffers: &[Option<wgpu::VertexBufferLayout<'_>>],
        groups: [&BindGroupLayout; 2],
        reversed: bool,
        constants: &[(&str, f64)],
    ) -> Compiled<RenderPipeline> {
        let layout = pipeline_layout(device, vertex, &[groups[0], groups[1], &self.layout]);
        let targets = surface_targets();
        let options = wgpu::PipelineCompilationOptions { constants, ..Default::default() };
        crate::compile::render_pipeline(device, &wgpu::RenderPipelineDescriptor {
            label: Some(vertex),
            layout: Some(&layout),
            vertex: wgpu::VertexState { module, entry_point: Some(vertex), compilation_options: options.clone(), buffers },
            primitive: wgpu::PrimitiveState { cull_mode: Some(wgpu::Face::Back), ..Default::default() },
            depth_stencil: Some(depth_state(reversed)),
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState { module, entry_point: Some(fragment), compilation_options: options, targets: &targets }),
            multiview_mask: None,
            cache: None,
        })
    }

    /// The background-motion pipeline (T-03) for a motion prepass of `reversed` depth: group 0 is
    /// this node's group (its frame row), the three prepass targets with the motion alone written,
    /// the depth tested `Equal` against the far plane and never written.
    pub fn background_pipeline(&self, device: &Device, reversed: bool) -> Result<Compiled<RenderPipeline>, RenderError> {
        let module = crate::shaders::module(device, "background motion", BACKGROUND_MOTION)?;
        let layout = pipeline_layout(device, "background motion", &[&self.layout]);
        let targets = background_targets();
        let constants = [("GX_DEPTH_REVERSED", f64::from(u8::from(reversed)))];
        let depth = wgpu::DepthStencilState {
            format: crate::renderer::DEPTH_FORMAT,
            depth_write_enabled: Some(false),
            depth_compare: Some(wgpu::CompareFunction::Equal),
            stencil: wgpu::StencilState::default(),
            bias: wgpu::DepthBiasState::default(),
        };
        let options = wgpu::PipelineCompilationOptions { constants: &constants, ..Default::default() };
        Ok(crate::compile::render_pipeline(device, &wgpu::RenderPipelineDescriptor {
            label: Some(BACKGROUND_VERTEX_ENTRY),
            layout: Some(&layout),
            vertex: wgpu::VertexState { module: &module, entry_point: Some(BACKGROUND_VERTEX_ENTRY), compilation_options: options.clone(), buffers: &[] },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: Some(depth),
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some(BACKGROUND_FRAGMENT_ENTRY), compilation_options: options, targets: &targets }),
            multiview_mask: None,
            cache: None,
        }))
    }

    /// Draw the background's motion into `pass` (a motion prepass, after its geometry) with
    /// `pipeline` ([`MotionNode::background_pipeline`]) and this frame's `group`
    /// ([`MotionNode::group`]): binds it at group 0.
    pub fn draw_background(pass: &mut wgpu::RenderPass<'_>, pipeline: &RenderPipeline, group: &wgpu::BindGroup) {
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, group, &[]);
        pass.draw(0..3, 0..1);
    }
}

/// The background-motion pipeline's colour targets: the prepass's three, with the motion alone
/// written (the fragment stage outputs nothing else, and WebGPU refuses a written target without
/// an output at its location).
pub fn background_targets() -> [Option<wgpu::ColorTargetState>; 3] {
    // By location, never by format: the normals are Rg16Float like the motion.
    let mut location = 0;
    TARGET_FORMATS.map(|format| {
        let write_mask = if location == MOTION_LOCATION { wgpu::ColorWrites::ALL } else { wgpu::ColorWrites::empty() };
        location += 1;
        Some(wgpu::ColorTargetState { format, blend: None, write_mask })
    })
}

/// The prepass's targets on a frame that writes the reflections' surface texel (lane FR): the
/// three of [`TARGET_FORMATS`] and A.6's normal and roughness, every channel written.
pub fn surface_targets() -> [Option<wgpu::ColorTargetState>; 4] {
    let [normals, motion, reactive] = TARGET_FORMATS;
    [normals, motion, reactive, crate::screen_inputs::NORMAL_ROUGHNESS_FORMAT].map(|format| Some(wgpu::ColorTargetState { format, blend: None, write_mask: wgpu::ColorWrites::ALL }))
}

/// The prepass's depth test: written, `Less` (standard Z) or `Greater` (reverse-Z).
fn depth_state(reversed: bool) -> wgpu::DepthStencilState {
    wgpu::DepthStencilState {
        format: crate::renderer::DEPTH_FORMAT,
        depth_write_enabled: Some(true),
        depth_compare: Some(crate::renderer::depth_compare(true, reversed)),
        stencil: wgpu::StencilState::default(),
        bias: wgpu::DepthBiasState::default(),
    }
}

const MESH_ATTRIBUTES: [wgpu::VertexAttribute; 4] = wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x3, 2 => Float32x2, 3 => Float32x4];
const SLOT_ATTRIBUTES: [wgpu::VertexAttribute; 1] = wgpu::vertex_attr_array![4 => Uint32];

/// The mesh vertex stream and the per-vertex slot stream (the forward pass's).
fn mesh_buffers() -> [Option<wgpu::VertexBufferLayout<'static>>; 2] {
    [
        Some(wgpu::VertexBufferLayout { array_stride: VERTEX_STRIDE, step_mode: wgpu::VertexStepMode::Vertex, attributes: &MESH_ATTRIBUTES }),
        Some(wgpu::VertexBufferLayout { array_stride: 4, step_mode: wgpu::VertexStepMode::Vertex, attributes: &SLOT_ATTRIBUTES }),
    ]
}

// ---------------------------------------------------------------------------------------------
// The node on its own: a frame sequence drawn through the motion prepass, read back

/// One frame of a [`motion_images`] sequence.
#[derive(Clone, Debug)]
pub struct MotionFrameInput {
    /// What is drawn (its opaque rows reach the prepass).
    pub scene: Scene,
    /// The frame's jitter in render pixels (x right, y down), `jitter::offset_px`.
    pub jitter_px: [f32; 2],
    /// The history starts over at this frame.
    pub reset: bool,
}

/// One frame's prepass targets read back, row by row from the top.
#[derive(Clone, Debug, PartialEq)]
pub struct MotionImage {
    /// Width and height.
    pub size: (u32, u32),
    /// NDC motion (current − previous, jitter removed).
    pub motion: Vec<[f32; 2]>,
    /// The reactive mask the prepass wrote (1: no history).
    pub reactive: Vec<f32>,
    /// Device depth.
    pub depth: Vec<f32>,
    /// The frame's unjittered projection × view.
    pub view_proj: [f32; 16],
    /// The frame row the pass drew with.
    pub frame: GpuMotionFrame,
    /// The previous-model rows the pass drew with.
    pub prev_models: Vec<GpuPrevModel>,
}

/// The motion prepass's GPU milliseconds per pass at one size, and the plain prepass's over the
/// same draws (the depth/normal pass it extends), one per sample.
#[derive(Clone, Debug, PartialEq)]
pub struct MotionCost {
    /// The plain prepass (depth and normals).
    pub prepass: Vec<f32>,
    /// The motion prepass (depth, normals, motion and reactive).
    pub motion: Vec<f32>,
}

/// Passes per cost sample: recorded back to back in one submission, so the GPU runs at a frame's
/// clocks rather than idling between samples.
pub const COST_PASSES_PER_SAMPLE: u32 = 16;

/// The prepass's targets at one size.
struct BenchTargets {
    depth: Texture,
    normals: TextureView,
    motion: Texture,
    reactive: Texture,
}

impl BenchTargets {
    fn new(device: &Device, size: (u32, u32)) -> BenchTargets {
        let make = |label, format, extra| {
            device.create_texture(&wgpu::TextureDescriptor {
                label: Some(label),
                size: wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage: TextureUsages::RENDER_ATTACHMENT | extra,
                view_formats: &[],
            })
        };
        let normals = make("motion bench normals", crate::prepass::NORMALS_FORMAT, TextureUsages::empty());
        BenchTargets {
            depth: make("motion bench depth", crate::renderer::DEPTH_FORMAT, TextureUsages::COPY_SRC),
            normals: normals.create_view(&Default::default()),
            motion: make("motion bench motion", MOTION_FORMAT, TextureUsages::COPY_SRC),
            reactive: make("motion bench reactive", crate::post::taa::REACTIVE_FORMAT, TextureUsages::COPY_SRC),
        }
    }
}

/// One frame's tables and bind groups.
struct BenchFrame {
    groups: [wgpu::BindGroup; 3],
    plan: FramePlan,
    row: GpuMotionFrame,
    skinned_slots: Option<Buffer>,
}

/// The motion prepass and the plain prepass over one library's meshes, drawn the way the
/// renderer's CPU path draws them (identity visible list, one draw per batch).
struct Bench {
    reversed: bool,
    size: (u32, u32),
    frame_layout: BindGroupLayout,
    pass_layout: BindGroupLayout,
    node: MotionNode,
    motion: Compiled<RenderPipeline>,
    /// The background's motion after the geometry (T-03).
    background: Compiled<RenderPipeline>,
    prepass: Compiled<RenderPipeline>,
    vertices: Buffer,
    slots: Buffer,
    indices: Buffer,
    skin_rows: Buffer,
    pass_view: Buffer,
    skin: SkinPass,
    skinned: SkinnedPair,
    history: MotionHistory,
    targets: BenchTargets,
}

fn upload(gpu: &Gpu, label: &str, bytes: &[u8], usage: BufferUsages) -> Result<Buffer, RenderError> {
    let made = buffer(&gpu.device, label, aligned(bytes.len() as u64), usage | BufferUsages::COPY_DST)?;
    gpu.queue.write_buffer(&made, 0, bytes);
    Ok(made)
}

impl Bench {
    fn new(gpu: &Gpu, library: &MeshLibrary, size: (u32, u32), reversed: bool) -> Result<Bench, RenderError> {
        let device = &gpu.device;
        let vertex = ShaderStages::VERTEX;
        let frame_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("motion bench frame"),
            entries: &[uniform(0, false, ShaderStages::VERTEX_FRAGMENT), storage(1, true, vertex), storage(3, true, vertex), storage(4, true, vertex)],
        });
        let pass_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("motion bench pass"), entries: &[uniform(0, false, vertex)] });
        let node = MotionNode::new(device)?;
        let module = crate::shaders::module(device, "prepass", crate::shaders::PREPASS)?;
        let buffers = mesh_buffers();
        let motion = node.pipeline(device, &module, VERTEX_ENTRY, &buffers, [&frame_layout, &pass_layout], reversed);
        let prepass = plain_prepass(device, &module, &buffers, [&frame_layout, &pass_layout], reversed);
        let background = node.background_pipeline(device, reversed)?;
        let mesh_usage = BufferUsages::VERTEX | BufferUsages::STORAGE;
        let pass_view = GpuPassView { view: 0, direct: 0, base: 0, slot_offset: 0 };
        Ok(Bench {
            reversed,
            size,
            vertices: upload(gpu, "motion bench vertices", bytemuck::cast_slice(library.vertices()), mesh_usage)?,
            slots: upload(gpu, "motion bench slots", bytemuck::cast_slice(library.slots()), BufferUsages::VERTEX)?,
            indices: upload(gpu, "motion bench indices", bytemuck::cast_slice(library.indices()), BufferUsages::INDEX)?,
            skin_rows: upload(gpu, "motion bench skin", bytemuck::cast_slice(library.skin()), BufferUsages::STORAGE)?,
            pass_view: upload(gpu, "motion bench pass view", bytemuck::bytes_of(&pass_view), BufferUsages::UNIFORM)?,
            frame_layout,
            pass_layout,
            node,
            motion,
            background,
            prepass,
            skin: SkinPass::new(device)?,
            skinned: SkinnedPair::new(),
            history: MotionHistory::new(),
            targets: BenchTargets::new(device, size),
        })
    }

    /// Plan `input`, match it against the history, skin it into the pair and make its groups.
    fn frame(&mut self, gpu: &Gpu, library: &MeshLibrary, input: &MotionFrameInput) -> Result<BenchFrame, RenderError> {
        let device = &gpu.device;
        let aspect = self.size.0 as f32 / self.size.1.max(1) as f32;
        let mut plan = FramePlan::build_depth(&input.scene, library, aspect, false, self.reversed)?;
        if input.reset {
            self.skinned.forget();
        }
        let skinned_bytes = u64::from(plan.skinned_vertices) * VERTEX_STRIDE;
        self.skinned.begin(device, skinned_bytes, BufferUsages::STORAGE | BufferUsages::VERTEX)?;
        let step = MotionStep { jitter_ndc: crate::jitter::offset_ndc(input.jitter_px, self.size), reset: input.reset, prev_vertices: self.skinned.previous().is_some() };
        let row = self.history.apply(&mut plan, step);
        self.node.write(&gpu.queue, &row);
        let skinned_slots = self.skin(gpu, &plan)?;
        let storage_usage = BufferUsages::STORAGE;
        let visible: Vec<u32> = (0..plan.opaque_instances).collect();
        let frame = upload(gpu, "motion bench frame", bytemuck::bytes_of(&plan.frame), BufferUsages::UNIFORM)?;
        let instances = upload(gpu, "motion bench instances", bytemuck::cast_slice(&plan.instances), storage_usage)?;
        let visible = upload(gpu, "motion bench visible", bytemuck::cast_slice(&visible), storage_usage)?;
        let slot_base = upload(gpu, "motion bench slot base", bytemuck::cast_slice(&plan.slot_base), storage_usage)?;
        let prev_models = upload(gpu, "motion bench previous models", bytemuck::cast_slice(&plan.prev_models), storage_usage)?;
        let frame_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("motion bench frame"),
            layout: &self.frame_layout,
            entries: &[entry(0, &frame), entry(1, &instances), entry(3, &visible), entry(4, &slot_base)],
        });
        let pass_group = device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("motion bench pass"), layout: &self.pass_layout, entries: &[entry(0, &self.pass_view)] });
        let motion_group = self.node.group(device, &prev_models, self.skinned.previous());
        Ok(BenchFrame { groups: [frame_group, pass_group, motion_group], plan, row, skinned_slots })
    }

    /// Skin `plan`'s draws into the pair's current buffer; answer the skinned slot stream.
    fn skin(&self, gpu: &Gpu, plan: &FramePlan) -> Result<Option<Buffer>, RenderError> {
        let (Some(most), Some(output)) = (plan.skin_jobs.iter().map(|job| job.count).max(), self.skinned.current()) else { return Ok(None) };
        let device = &gpu.device;
        let slots = buffer(device, "motion bench skinned slots", aligned(u64::from(plan.skinned_vertices) * 4), BufferUsages::STORAGE | BufferUsages::VERTEX)?;
        let joints = upload(gpu, "motion bench joints", bytemuck::cast_slice(&plan.joints), BufferUsages::STORAGE)?;
        let jobs = upload(gpu, "motion bench skin jobs", bytemuck::cast_slice(&plan.skin_jobs), BufferUsages::STORAGE)?;
        let buffers = SkinBuffers { source: &self.vertices, skin: &self.skin_rows, joints: &joints, jobs: &jobs, output, output_slots: &slots };
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("motion bench skin") });
        self.skin.encode(device, &mut encoder, &buffers, plan.skin_jobs.len() as u32, most);
        gpu.queue.submit([encoder.finish()]);
        Ok(Some(slots))
    }

    /// Record one prepass over `frame`: the motion variant into all three targets, or the plain
    /// one into the normals.
    fn encode(&self, encoder: &mut wgpu::CommandEncoder, frame: &BenchFrame, with_motion: bool, stamps: Option<wgpu::RenderPassTimestampWrites<'_>>) {
        let clear = wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store };
        let attachment = |view| Some(wgpu::RenderPassColorAttachment { view, depth_slice: None, resolve_target: None, ops: clear });
        let motion_view = self.targets.motion.create_view(&Default::default());
        let reactive_view = self.targets.reactive.create_view(&Default::default());
        let depth_view = self.targets.depth.create_view(&Default::default());
        let colors = match with_motion {
            true => vec![attachment(&self.targets.normals), attachment(&motion_view), attachment(&reactive_view)],
            false => vec![attachment(&self.targets.normals)],
        };
        let depth_clear = if self.reversed { 0.0 } else { 1.0 };
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("motion bench prepass"),
            color_attachments: &colors,
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: &depth_view,
                depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(depth_clear), store: wgpu::StoreOp::Store }),
                stencil_ops: None,
            }),
            timestamp_writes: stamps,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        pass.set_pipeline(if with_motion { &self.motion } else { &self.prepass });
        pass.set_index_buffer(self.indices.slice(..), wgpu::IndexFormat::Uint32);
        pass.set_bind_group(0, &frame.groups[0], &[]);
        pass.set_bind_group(1, &frame.groups[1], &[]);
        if with_motion {
            pass.set_bind_group(2, &frame.groups[2], &[]);
        }
        for (b, batch) in frame.plan.batches.iter().enumerate() {
            let skinned = b >= frame.plan.static_batches as usize;
            let streams = match (skinned, self.skinned.current(), frame.skinned_slots.as_ref()) {
                (false, _, _) => (&self.vertices, &self.slots),
                (true, Some(vertices), Some(slots)) => (vertices, slots),
                _ => continue,
            };
            pass.set_vertex_buffer(0, streams.0.slice(..));
            pass.set_vertex_buffer(1, streams.1.slice(..));
            pass.draw_indexed(batch.first_index..batch.first_index + batch.index_count, batch.base_vertex, 0..batch.instance_count);
        }
        if with_motion {
            MotionNode::draw_background(&mut pass, &self.background, &frame.groups[2]);
        }
    }

    fn read(&self, gpu: &Gpu, frame: &BenchFrame) -> Result<MotionImage, RenderError> {
        let size = self.size;
        let motion = read_texture(gpu, &self.targets.motion, size, 4, wgpu::TextureAspect::All)?;
        let reactive = read_texture(gpu, &self.targets.reactive, size, 1, wgpu::TextureAspect::All)?;
        let depth = read_texture(gpu, &self.targets.depth, size, 4, wgpu::TextureAspect::DepthOnly)?;
        let half = |at: usize| crate::post::tonemap::f16_to_f32(u16::from_le_bytes([motion[at], motion[at + 1]]));
        Ok(MotionImage {
            size,
            motion: (0..motion.len() / 4).map(|i| [half(i * 4), half(i * 4 + 2)]).collect(),
            reactive: reactive.iter().map(|&r| f32::from(r) / 255.0).collect(),
            depth: depth.as_chunks::<4>().0.iter().map(|d| f32::from_le_bytes(*d)).collect(),
            view_proj: frame.plan.frame.view_proj,
            frame: frame.row,
            prev_models: frame.plan.prev_models.clone(),
        })
    }
}

/// The plain depth/normal prepass (`vs_prepass`/`fs_prepass`) over the same groups: the cost the
/// motion variant is compared with.
fn plain_prepass(device: &Device, module: &ShaderModule, buffers: &[Option<wgpu::VertexBufferLayout<'_>>], groups: [&BindGroupLayout; 2], reversed: bool) -> Compiled<RenderPipeline> {
    let layout = pipeline_layout(device, "motion bench plain prepass", &groups);
    let targets = [Some(wgpu::ColorTargetState { format: crate::prepass::NORMALS_FORMAT, blend: None, write_mask: wgpu::ColorWrites::ALL })];
    crate::compile::render_pipeline(device, &wgpu::RenderPipelineDescriptor {
        label: Some("motion bench plain prepass"),
        layout: Some(&layout),
        vertex: wgpu::VertexState { module, entry_point: Some("vs_prepass"), compilation_options: Default::default(), buffers },
        primitive: wgpu::PrimitiveState { cull_mode: Some(wgpu::Face::Back), ..Default::default() },
        depth_stencil: Some(depth_state(reversed)),
        multisample: wgpu::MultisampleState::default(),
        fragment: Some(wgpu::FragmentState { module, entry_point: Some("fs_prepass"), compilation_options: Default::default(), targets: &targets }),
        multiview_mask: None,
        cache: None,
    })
}

/// A texture's texels row by row, the row padding removed.
fn read_texture(gpu: &Gpu, texture: &Texture, size: (u32, u32), texel_bytes: u32, aspect: wgpu::TextureAspect) -> Result<Vec<u8>, RenderError> {
    let (width, height) = size;
    let row = width * texel_bytes;
    let padded = row.div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let bytes = u64::from(padded) * u64::from(height);
    let staging = buffer(&gpu.device, "motion readback", bytes, BufferUsages::MAP_READ | BufferUsages::COPY_DST)?;
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("motion readback") });
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo { texture, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect },
        wgpu::TexelCopyBufferInfo { buffer: &staging, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(padded), rows_per_image: Some(height) } },
        wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
    );
    gpu.queue.submit([encoder.finish()]);
    let data = map_read_blocking(gpu, &staging, bytes)?;
    Ok(data.chunks_exact(padded as usize).flat_map(|line| line[..row as usize].iter().copied()).collect())
}

/// Draw `frames` one after another through the motion prepass at `size` (standard or `reversed`
/// depth) on one history and one skinned pair, reading each frame's targets back: the way to check
/// the motion vectors, the matching and the skinned previous positions on the GPU. The first
/// frame has no history.
pub fn motion_images(gpu: &Gpu, library: &MeshLibrary, size: (u32, u32), reversed: bool, frames: &[MotionFrameInput]) -> Result<Vec<MotionImage>, RenderError> {
    crate::capture::check_capture_size(size.0, size.1)?;
    let mut bench = Bench::new(gpu, library, size, reversed)?;
    let mut images = Vec::with_capacity(frames.len());
    for input in frames {
        let frame = bench.frame(gpu, library, input)?;
        let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("motion image") });
        bench.encode(&mut encoder, &frame, true, None);
        gpu.queue.submit([encoder.finish()]);
        images.push(bench.read(gpu, &frame)?);
    }
    Ok(images)
}

/// The GPU milliseconds of the plain prepass and of the motion prepass over `scene` at `size`
/// (reverse-Z), one per sample of `samples`, from timestamps around [`COST_PASSES_PER_SAMPLE`]
/// passes each, interleaved; None without `TIMESTAMP_QUERY`. The motion cost row (RQ5.1: the
/// motion pass adds at most 0.1 ms over the prepass at 1080p).
pub fn motion_gpu_ms(gpu: &Gpu, library: &MeshLibrary, scene: &Scene, size: (u32, u32), samples: u32) -> Result<Option<MotionCost>, RenderError> {
    let device = &gpu.device;
    if !device.features().contains(wgpu::Features::TIMESTAMP_QUERY) {
        return Ok(None);
    }
    let mut bench = Bench::new(gpu, library, size, true)?;
    let input = MotionFrameInput { scene: scene.clone(), jitter_px: [0.0; 2], reset: false };
    // The second frame matches the first: every row has history, as in a running game.
    let _ = bench.frame(gpu, library, &input)?;
    let frame = bench.frame(gpu, library, &input)?;
    let query_set = device.create_query_set(&wgpu::QuerySetDescriptor { label: Some("motion cost"), ty: wgpu::QueryType::Timestamp, count: 2 });
    let resolve = buffer(device, "motion cost resolve", 16, BufferUsages::QUERY_RESOLVE | BufferUsages::COPY_SRC)?;
    let period = gpu.queue.get_timestamp_period();
    let mut cost = MotionCost { prepass: Vec::new(), motion: Vec::new() };
    for _ in 0..samples {
        for with_motion in [false, true] {
            let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("motion cost") });
            for k in 0..COST_PASSES_PER_SAMPLE {
                let (begin, end) = ((k == 0).then_some(0), (k + 1 == COST_PASSES_PER_SAMPLE).then_some(1));
                let stamps = (begin.is_some() || end.is_some()).then_some(wgpu::RenderPassTimestampWrites { query_set: &query_set, beginning_of_pass_write_index: begin, end_of_pass_write_index: end });
                bench.encode(&mut encoder, &frame, with_motion, stamps);
            }
            gpu.queue.submit([encoder.finish()]);
            // Resolved in a later submission, after the passes': Metal resolves counter samples
            // without waiting for the passes that write them (timing.rs).
            device.poll(wgpu::PollType::wait_indefinitely()).map_err(|error| capture_failed(format!("poll: {error}")))?;
            let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("motion cost resolve") });
            encoder.resolve_query_set(&query_set, 0..2, &resolve, 0);
            gpu.queue.submit([encoder.finish()]);
            let staging = crate::readback::stage_buffer(gpu, &resolve, 0, 16)?;
            let data = map_read_blocking(gpu, &staging, 16)?;
            let ticks: [u64; 2] = std::array::from_fn(|i| u64::from_le_bytes(data[i * 8..i * 8 + 8].try_into().unwrap_or([0; 8])));
            let Some(ms) = crate::timing::span_ms(ticks[0], ticks[1], period) else { continue };
            let per_pass = ms / COST_PASSES_PER_SAMPLE as f32;
            if with_motion { cost.motion.push(per_pass) } else { cost.prepass.push(per_pass) }
        }
    }
    Ok(Some(cost))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_motion_target_is_rg16float_at_render_size() {
        let desc = target((640, 360));
        assert_eq!((desc.format, desc.size, desc.samples), (TextureFormat::Rg16Float, (640, 360), 1));
        assert_eq!(target((0, 0)).size, (1, 1));
        assert_eq!(bytes((640, 360)), 640 * 360 * 4);
    }

    #[test]
    fn string_and_integer_keys_name_stable_ids() {
        assert_eq!(DrawId::from("").get(), 0xcbf2_9ce4_8422_2325, "FNV-1a's offset basis");
        assert_eq!(DrawId::from(&"deer".to_owned()), DrawId::from_key("deer"));
        assert_eq!(DrawId::from(9u32).get(), 9);
        assert_ne!(MOTION_FLAG_NO_HISTORY, MOTION_FLAG_MATCHED_BY_ID);
    }

    #[test]
    fn ordinals_count_per_id_and_per_mesh_batch() {
        let mut keys = MotionKeys::default();
        let deer = Some(DrawId::from("deer"));
        let rows = [
            keys.row(None, MeshId::CUBE, RowKind::Opaque, None),
            keys.row(deer, MeshId::CUBE, RowKind::Opaque, None),
            keys.row(None, MeshId::CUBE, RowKind::Opaque, None),
            keys.row(deer, MeshId::SPHERE, RowKind::Transparent, None),
            keys.row(None, MeshId::CUBE, RowKind::Transparent, None),
            keys.row(deer, MeshId::CUBE, RowKind::Skinned, Some(0)),
        ];
        let ordinals: Vec<u32> = rows.iter().map(|row| row.key.ordinal).collect();
        assert_eq!(ordinals, [0, 0, 1, 1, 0, 0], "an id's opaque and transparent rows share one count; skinned rows count apart");
    }

    #[test]
    fn a_jump_is_a_move_past_the_radius_or_a_rescale() {
        assert!(!jumped([0.0, 0.0, 0.0, 1.0], [0.9, 0.0, 0.0, 1.0]));
        assert!(jumped([0.0, 0.0, 0.0, 1.0], [1.1, 0.0, 0.0, 1.0]));
        assert!(jumped([0.0, 0.0, 0.0, 1.0], [0.0, 0.0, 0.0, 2.5]));
        assert!(jumped([0.0, 0.0, 0.0, 1.0], [f32::NAN, 0.0, 0.0, 1.0]), "a NaN bound has no history");
    }
}
