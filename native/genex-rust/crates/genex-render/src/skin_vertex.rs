//! Vertex-shader skinning for mid and far characters (game systems AN-18): the per-draw switch
//! from compute skinning. A far skinned draw skins in the vertex stage of the world pass, the
//! prepass (with its motion) and the sun casters, from the library's bind-pose vertices, its skin
//! rows and its palette: it allocates no skinned output, no skinned slots and no previous skinned
//! vertices. Near draws keep compute skinning, whose output several passes draw.
//!
//! Which draws take the path is [`vertex_skinned_draws`]: under [`SkinVertexPolicy::Auto`] a draw
//! whose skinned sphere covers fewer than [`SKIN_VERTEX_BELOW_PX`] at the nominal output height
//! (LOD's screen-size metric, [`crate::scene::screen_height_px`]) and whose every part is plain
//! opaque, unless it shares its skinning job with another draw (one pose of a crowd, lane CP):
//! that job skins once by compute and its draws are rows of one GPU-culled instanced batch. Masked,
//! double-sided and transparent parts keep compute skinning.
//!
//! The GPU side is two vertex-stage storage tables (the binding ledger's AN-18 row): the library's
//! skin rows and this frame's vertex skin table ([`SkinVertexFrame`]: each part's record, then the
//! palettes). The forward fragment stage takes no new binding.

use std::collections::BTreeMap;

use bytemuck::{Pod, Zeroable};

use crate::instance::instance_row;
use crate::motion::DrawId;
use crate::scene::{DrawVariant, FramePlan, MeshId, MeshLibrary, Scene, SkinnedDraw, pose_owners, screen_height_px};
use crate::skinned_lod::SkinnedPick;
use crate::skin::skinned_bounds;

/// The world pass's entry module: the forward module's sources (`shaders::FORWARD`), the shared
/// chunk and the world entry (`vs_skin_vertex`, shaded by `fs_main`).
pub const SKIN_VERTEX: &str = crate::shaders::minify::shipped_wgsl!(concat!(
    include_str!("../shaders/common.wgsl"),
    include_str!("../shaders/clip_position.wgsl"),
    include_str!("../shaders/effects.wgsl"),
    include_str!("../shaders/forward_env.wgsl"),
    include_str!("../shaders/pbr.wgsl"),
    include_str!("../shaders/lighting/surface.wgsl"),
    include_str!("../shaders/lighting/decals.wgsl"),
    include_str!("../shaders/screen/ssr_apply.wgsl"),
    include_str!("../shaders/lighting/ambient.wgsl"),
    include_str!("../shaders/lighting/sun.wgsl"),
    include_str!("../shaders/lighting/subsurface.wgsl"),
    include_str!("../shaders/lighting/local_lights.wgsl"),
    include_str!("../shaders/lighting/fog.wgsl"),
    include_str!("../shaders/lighting/output.wgsl"),
    include_str!("../shaders/forward_effects.wgsl"),
    include_str!("../shaders/alpha_mask.wgsl"),
    include_str!("../shaders/forward.wgsl"),
    include_str!("../shaders/screen/normal_roughness_unpack.wgsl"),
    include_str!("../shaders/screen/normal_roughness.wgsl"),
    include_str!("../shaders/screen/ssr_surface.wgsl"),
    include_str!("../shaders/skin_vertex.wgsl"),
    include_str!("../shaders/skin_vertex_forward.wgsl")
));

/// The prepass's entry module: the prepass module's sources (`shaders::PREPASS`), the shared
/// chunk and the depth/normal and motion entries.
pub const SKIN_VERTEX_PREPASS: &str = crate::shaders::minify::shipped_wgsl!(concat!(
    include_str!("../shaders/common.wgsl"),
    include_str!("../shaders/clip_position.wgsl"),
    include_str!("../shaders/effects.wgsl"),
    include_str!("../shaders/alpha_mask.wgsl"),
    include_str!("../shaders/screen/normal_roughness_unpack.wgsl"),
    include_str!("../shaders/screen/normal_roughness.wgsl"),
    include_str!("../shaders/prepass_motion.wgsl"),
    include_str!("../shaders/prepass.wgsl"),
    include_str!("../shaders/skin_vertex.wgsl"),
    include_str!("../shaders/skin_vertex_prepass.wgsl")
));

/// The sun casters' entry module: the shadow module's sources (`shaders::SHADOW`), the shared
/// chunk and the caster entry.
pub const SKIN_VERTEX_SHADOW: &str = crate::shaders::minify::shipped_wgsl!(concat!(
    include_str!("../shaders/common.wgsl"),
    include_str!("../shaders/shadow_caster.wgsl"),
    include_str!("../shaders/alpha_mask.wgsl"),
    include_str!("../shaders/shadow.wgsl"),
    include_str!("../shaders/skin_vertex.wgsl"),
    include_str!("../shaders/skin_vertex_shadow.wgsl")
));

/// The world pass's entry points (vertex, fragment).
pub const FORWARD_ENTRIES: (&str, &str) = ("vs_skin_vertex", "fs_main");
/// The prepass's entry points.
pub const PREPASS_ENTRIES: (&str, &str) = ("vs_skin_vertex_prepass", "fs_prepass");
/// The motion prepass's entry points.
pub const MOTION_ENTRIES: (&str, &str) = ("vs_skin_vertex_motion", "fs_prepass_motion");
/// The sun casters' vertex entry point.
pub const SHADOW_VERTEX_ENTRY: &str = "vs_skin_vertex_shadow";
/// The tables' group in the world and caster pipelines.
pub const SKIN_VERTEX_GROUP: u32 = 2;
/// The tables' group in the prepass pipelines (group 2 is the motion node's).
pub const SKIN_VERTEX_PREPASS_GROUP: u32 = 3;

/// Under [`SkinVertexPolicy::Auto`], a draw whose skinned sphere covers fewer pixels than this at
/// the nominal output height skins in the vertex stage: AN-17's full-rate band (240 px) and up stay
/// on compute skinning, its half, quarter and eighth bands (mid and far) take this path.
pub const SKIN_VERTEX_BELOW_PX: f32 = 240.0;

/// Matrices in one part's record (`GX_SKIN_VERTEX_RECORD`).
pub const RECORD_MATRICES: usize = 4;

/// `motion::MOTION_FLAG_NO_HISTORY`, the record's flags word (prepass.wgsl `GX_MOTION_NO_HISTORY`).
const FLAG_NO_HISTORY: u32 = 1;

/// Which skinned draws skin in the vertex stage.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum SkinVertexPolicy {
    /// Plain opaque draws under [`SKIN_VERTEX_BELOW_PX`] (the default).
    #[default]
    Auto,
    /// None: every draw is compute skinned (as before AN-18).
    Compute,
    /// Every plain opaque draw, whatever its size (tests and the golden row).
    Vertex,
}

/// What the last frame skinned (game systems AN-23): its skinned instances by compute and in the
/// vertex stage, and the compute cap they were held to (None: a renderer with no device class).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SkinnedInstances {
    /// Instances skinned by the compute pass.
    pub compute: u32,
    /// Instances skinned in the vertex stage.
    pub vertex: u32,
    /// The class's compute cap ([`crate::presets::skinned_compute_instances_max`]).
    pub compute_max: Option<u32>,
}

impl SkinnedInstances {
    /// The counts of a frame of `draws` skinned draws whose vertex-stage flags are `vertex` (empty:
    /// none), held to `compute_max`.
    pub fn of(draws: usize, vertex: &[bool], compute_max: Option<u32>) -> SkinnedInstances {
        let on_vertex = vertex.iter().filter(|flag| **flag).count();
        let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
        SkinnedInstances { compute: count(draws - on_vertex), vertex: count(on_vertex), compute_max }
    }
}

/// One part's record in the vertex skin table (`GxSkinVertexDraw`): model, normal matrix, last
/// frame's model, then the words (palette base, last frame's palette base, skin-row offset,
/// material; flags).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuSkinVertexRecord {
    /// Model matrix, column-major.
    pub model: [f32; 16],
    /// Inverse-transpose of the model matrix.
    pub normal: [f32; 16],
    /// Last frame's model matrix (this frame's without history).
    pub prev_model: [f32; 16],
    /// x: palette base, y: last frame's palette base, z: skin-row offset, w: material row (as
    /// bits); then x: flags; the rest 0.
    pub words: [u32; 16],
}

/// One direct draw of the path: a part's index range over the library's vertices, its record
/// named by the instance index.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SkinVertexDraw {
    /// The part's first index in the library's index buffer.
    pub first_index: u32,
    /// Its index count.
    pub index_count: u32,
    /// The library's base vertex of its mesh.
    pub base_vertex: i32,
    /// Its record in the vertex skin table (the draw's instance index).
    pub record: u32,
}

/// A frame of the path: its direct draws and the vertex skin table (the records, then the
/// palettes, in matrices).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SkinVertexFrame {
    /// The direct draws, in record order.
    pub draws: Vec<SkinVertexDraw>,
    /// The table: [`RECORD_MATRICES`] per draw, then this frame's and last frame's palettes.
    pub table: Vec<[f32; 16]>,
}

impl SkinVertexFrame {
    /// The table's bytes (0 for a frame with no draw on the path).
    pub fn bytes(&self) -> u64 {
        (self.table.len() * size_of::<[f32; 16]>()) as u64
    }
}

/// What a draw drew last frame, for its motion: its model and its palette.
#[derive(Clone, Debug, PartialEq)]
struct Drawn {
    model: [f32; 16],
    joints: Vec<[f32; 16]>,
}

/// A vertex-skinned draw's palettes in the table: this frame's base, last frame's base and last
/// frame's model (None without history).
type DrawPalettes = (u32, u32, Option<[f32; 16]>);

/// Whose history a vertex-skinned draw reads: its id, or, without one, its mesh (as compute
/// skinning's motion keys an id-less row by its mesh and draw order).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum HistoryScope {
    Id(DrawId),
    Mesh(MeshId),
}

/// The path's history: each draw's last model and palette, by (id, ordinal among that id's
/// vertex-skinned draws) or, for a draw with no id, by (mesh, ordinal among that mesh's id-less
/// skinned draws on either path, so a draw keeps its key when it changes path). A new draw has
/// none (its motion is the camera's alone and TAA takes its current sample).
#[derive(Clone, Debug, Default)]
pub struct SkinVertexHistory {
    last: BTreeMap<(HistoryScope, u32), Drawn>,
}

impl SkinVertexHistory {
    /// Forget every draw (a history reset).
    pub fn forget(&mut self) {
        self.last.clear();
    }
}

/// Whether every part of `draw` is plain opaque (the path's pipelines are the plain ones).
fn plain_opaque(draw: &SkinnedDraw) -> bool {
    (0..draw.skin.part_count() as usize).all(|part| {
        let material = draw.part_material(part);
        !material.is_transparent() && material.draw_variant() == DrawVariant::PLAIN
    })
}

/// The world sphere (centre, radius) of `draw` posed, or None for a mesh not in `library`.
fn draw_sphere(draw: &SkinnedDraw, library: &MeshLibrary) -> Option<[f32; 4]> {
    let entry = library.entry(draw.skin.mesh())?;
    let (center, radius) = skinned_bounds(entry.center, entry.radius, &draw.joints);
    Some(instance_row(&draw.model, center, radius, 0).bounds)
}

/// Which of `scene`'s skinned draws skin in the vertex stage under `policy`, one flag per draw
/// (empty: none). A draw naming a mesh outside `library` keeps compute skinning (the plan refuses
/// it there).
pub fn vertex_skinned_draws(scene: &Scene, library: &MeshLibrary, policy: SkinVertexPolicy) -> Vec<bool> {
    vertex_skinned_draws_within(scene, library, policy, u32::MAX, &[])
}

/// [`vertex_skinned_draws`] for draws skinning the levels `picks` gives them (empty: each its
/// base; [`crate::scene::skinned_levels`]), held to a class's compute cap (game systems AN-23,
/// [`crate::presets::skinned_compute_instances_max`]).
///
/// Under [`SkinVertexPolicy::Auto`] a draw that shares its skinning job with another (the same
/// skin and level posed by a bit-identical palette, AN-16b) stays on compute whatever its size: the
/// job skins once and every sharer is a row of the GPU-culled instanced batch, in the prepass, the
/// world pass and each cascade (lane CP). The cap counts jobs, not draws: when more than
/// `compute_max` jobs would run, the jobs smallest on screen (by their largest draw) of those whose
/// every draw can take the path (plain opaque, not crossfading) leave it, ties going to the later
/// job, until `compute_max` remain; masked, double-sided, transparent and crossfading draws stay
/// on compute past the cap. The other policies ignore sharing and the cap (they are the tests' and
/// goldens' explicit choices).
pub fn vertex_skinned_draws_within(scene: &Scene, library: &MeshLibrary, policy: SkinVertexPolicy, compute_max: u32, picks: &[SkinnedPick]) -> Vec<bool> {
    if policy == SkinVertexPolicy::Compute || scene.skinned.is_empty() {
        return Vec::new();
    }
    let flags = if policy == SkinVertexPolicy::Vertex {
        scene.skinned.iter().map(|draw| plain_opaque(draw) && library.entry(draw.skin.mesh()).is_some()).collect()
    } else {
        auto_flags(scene, library, compute_max, picks)
    };
    if flags.iter().any(|flag| *flag) { flags } else { Vec::new() }
}

/// [`SkinVertexPolicy::Auto`]'s flags (see [`vertex_skinned_draws_within`]).
fn auto_flags(scene: &Scene, library: &MeshLibrary, compute_max: u32, picks: &[SkinnedPick]) -> Vec<bool> {
    let pick_of = |at: usize| picks.get(at).copied().unwrap_or(SkinnedPick::BASE);
    let owners = pose_owners(scene, |at| Some(pick_of(at)));
    let mut sharers = vec![0u32; owners.len()];
    for owner in &owners {
        sharers[*owner] += 1;
    }
    let pixels: Vec<Option<f32>> = scene.skinned.iter().map(|draw| draw_sphere(draw, library).map(|sphere| screen_height_px(&scene.camera, sphere))).collect();
    let plain: Vec<bool> = scene.skinned.iter().map(plain_opaque).collect();
    let small = |at: usize| pixels[at].is_some_and(|px| px < SKIN_VERTEX_BELOW_PX);
    let mut flags: Vec<bool> = (0..owners.len()).map(|at| plain[at] && sharers[owners[at]] < 2 && small(at)).collect();
    let movable = |at: usize| plain[at] && pixels[at].is_some() && !pick_of(at).is_band();
    hold_compute_cap(&owners, &pixels, movable, &mut flags, compute_max);
    flags
}

/// A skinning job on compute: the largest of its draws on screen, and whether every one of its
/// draws can take the vertex path.
#[derive(Clone, Copy)]
struct Job {
    pixels: f32,
    movable: bool,
}

/// Move the jobs smallest on screen whose every draw is `movable` to the vertex stage until at
/// most `compute_max` jobs (draws by their `owners`) stay on compute (AN-23, counted in jobs).
fn hold_compute_cap(owners: &[usize], pixels: &[Option<f32>], movable: impl Fn(usize) -> bool, flags: &mut [bool], compute_max: u32) {
    let mut jobs: Vec<Option<Job>> = vec![None; owners.len()];
    for (at, owner) in owners.iter().enumerate().filter(|(at, _)| !flags[*at]) {
        let job = jobs[*owner].get_or_insert(Job { pixels: f32::NEG_INFINITY, movable: true });
        job.pixels = job.pixels.max(pixels[at].unwrap_or(f32::INFINITY));
        job.movable &= movable(at);
    }
    let running = jobs.iter().flatten().count();
    let over = running.saturating_sub(usize::try_from(compute_max).unwrap_or(usize::MAX));
    if over == 0 {
        return;
    }
    let mut candidates: Vec<(f32, usize)> = jobs.iter().enumerate().filter_map(|(owner, job)| job.filter(|job| job.movable).map(|job| (job.pixels, owner))).collect();
    candidates.sort_by(|a, b| a.0.total_cmp(&b.0).then(b.1.cmp(&a.1)));
    let mut leaving = vec![false; owners.len()];
    for (_, owner) in candidates.into_iter().take(over) {
        leaving[owner] = true;
    }
    for (at, owner) in owners.iter().enumerate() {
        if leaving[*owner] {
            flags[at] = true;
        }
    }
}

/// The record of a part of `draw` (its material row `material`), its palette at `joint_base` and
/// last frame's at `prev_joint_base` with `prev_model` (equal to this frame's without history).
fn record(draw: &SkinnedDraw, skin_offset: u32, material: u32, palettes: (u32, u32), prev: Option<[f32; 16]>) -> [[f32; 16]; RECORD_MATRICES] {
    let row = instance_row(&draw.model, [0.0; 3], 0.0, material);
    let mut words = [0u32; 16];
    words[0] = palettes.0;
    words[1] = palettes.1;
    words[2] = skin_offset;
    words[3] = material;
    words[4] = if prev.is_some() { 0 } else { FLAG_NO_HISTORY };
    [row.model, row.normal, prev.unwrap_or(row.model), bytemuck::cast(words)]
}

/// This frame's path for `plan`'s vertex-skinned parts over `scene` and `library`, with each
/// identified draw's motion from `history`, which then holds this frame's draws.
pub fn build_frame(scene: &Scene, library: &MeshLibrary, plan: &FramePlan, history: &mut SkinVertexHistory) -> SkinVertexFrame {
    if plan.vertex_skinned.is_empty() {
        history.forget();
        return SkinVertexFrame::default();
    }
    let records = plan.vertex_skinned.len() * RECORD_MATRICES;
    let mut frame = SkinVertexFrame { draws: Vec::with_capacity(plan.vertex_skinned.len()), table: vec![[0.0; 16]; records] };
    let mut seen: BTreeMap<DrawId, u32> = BTreeMap::new();
    let mesh_ordinals = id_less_ordinals(scene);
    let mut now: BTreeMap<(HistoryScope, u32), Drawn> = BTreeMap::new();
    // Each draw's palettes (this frame's, last frame's): appended once per draw.
    let mut palettes: Vec<Option<DrawPalettes>> = vec![None; scene.skinned.len()];
    for (at, part) in plan.vertex_skinned.iter().enumerate() {
        let Some(draw) = scene.skinned.get(part.draw as usize) else { continue };
        // The level the plan picked (game systems AN-25): its geometry, the draw's palette.
        let Some(entry) = library.entry(part.skin.mesh()) else { continue };
        let Some(skin_part) = library.skin_parts(part.skin).get(part.part as usize) else { continue };
        let (joint_base, prev_joint_base, prev_model) = *palettes[part.draw as usize].get_or_insert_with(|| {
            let joint_base = frame.table.len() as u32;
            frame.table.extend_from_slice(&draw.joints);
            let key = match draw.id {
                Some(id) => {
                    let ordinal = seen.entry(id).or_insert(0);
                    *ordinal += 1;
                    Some((HistoryScope::Id(id), *ordinal - 1))
                }
                None => mesh_ordinals.get(part.draw as usize).map(|ordinal| (HistoryScope::Mesh(draw.skin.mesh()), *ordinal)),
            };
            let before = key.and_then(|key| history.last.get(&key)).filter(|drawn| drawn.joints.len() == draw.joints.len());
            let (prev_joint_base, prev_model) = match before {
                Some(drawn) => {
                    let base = frame.table.len() as u32;
                    frame.table.extend_from_slice(&drawn.joints);
                    (base, Some(drawn.model))
                }
                None => (joint_base, None),
            };
            if let Some(key) = key {
                now.insert(key, Drawn { model: draw.model, joints: draw.joints.clone() });
            }
            (joint_base, prev_joint_base, prev_model)
        });
        // The skin row of library vertex v is `skin_base + (v - base_vertex)`: the offset wraps.
        let skin_offset = part.skin.skin_base.wrapping_sub(entry.base_vertex as u32);
        let matrices = record(draw, skin_offset, part.material, (joint_base, prev_joint_base), prev_model);
        frame.table[at * RECORD_MATRICES..(at + 1) * RECORD_MATRICES].copy_from_slice(&matrices);
        frame.draws.push(SkinVertexDraw { first_index: entry.first_index + skin_part.first_index, index_count: skin_part.index_count, base_vertex: entry.base_vertex, record: at as u32 });
    }
    history.last = now;
    frame
}

/// Each skinned draw's ordinal among the id-less skinned draws of its mesh, in draw order (0 for a
/// draw with an id, which keys its history by the id instead).
fn id_less_ordinals(scene: &Scene) -> Vec<u32> {
    let mut counts: BTreeMap<MeshId, u32> = BTreeMap::new();
    let ordinal = |draw: &SkinnedDraw| {
        if draw.id.is_some() {
            return 0;
        }
        let count = counts.entry(draw.skin.mesh()).or_insert(0);
        *count += 1;
        *count - 1
    };
    scene.skinned.iter().map(ordinal).collect()
}

/// The skinned bytes compute skinning holds for `vertices` skinned vertices on a motion frame:
/// the output, last frame's copy and the slots (AN-16b's exact need).
pub fn compute_skinned_bytes(vertices: u64) -> u64 {
    vertices * crate::tables::VERTEX_STRIDE * 2 + vertices * 4
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_record_is_four_matrices_of_the_table() {
        assert_eq!(size_of::<GpuSkinVertexRecord>(), RECORD_MATRICES * size_of::<[f32; 16]>());
    }
}
