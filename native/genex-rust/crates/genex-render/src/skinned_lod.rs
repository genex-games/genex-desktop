//! Skinned levels of detail (game systems AN-25): a skinned mesh's simplified levels and the level
//! each skinned draw skins.
//!
//! A level is a skinned mesh of its own: the vertices its triangles use, in first-use order, with
//! their `JOINTS_0`/`WEIGHTS_0` rows kept, and one part per part of the base mesh (so each part
//! keeps its material). Every level poses with the base mesh's palette, so a draw names one palette
//! whatever level it skins.
//!
//! The choice is the cull's own. A draw's rows measure from the posed sphere of its base mesh, the
//! chain's errors over the base radius ([`crate::mesh::batch_lod`]), and [`pick_level`] asks
//! [`crate::mesh::lod_row_keep`] (the CPU twin of `gx_cull_lod_fade`, expression for expression)
//! which batches would keep the draw. Outside the fade band one level is kept whole and only it is
//! skinned (by compute near, by the vertex path far, game systems AN-18). Inside the band the two
//! levels the cull crossfades are both skinned by compute and drawn through the LOD-03 fade
//! batches, so a dolly through a switch never pops.

use crate::layout::GpuSkinVertex;
use crate::mesh::{LOD_MAX_LEVELS, LodChain, MeshData, batch_lod, fade_batch_lod, lod_row_keep};
use crate::skin::{SkinId, SkinPart};

/// One simplified level of a skinned mesh: a skinned mesh of its own over the base's skeleton.
#[derive(Clone, Debug, PartialEq)]
pub struct SkinnedLevel {
    /// Its vertices (each a vertex of the base mesh) and its triangles over them.
    pub mesh: MeshData,
    /// Each vertex's joints and weights: the base vertex's row, unchanged.
    pub skin: Vec<GpuSkinVertex>,
    /// One part per part of the base mesh, in the same order and with the same material.
    pub parts: Vec<SkinPart>,
    /// Its object-space error (the largest of its parts'), never below the finer level's.
    pub error: f32,
}

/// The levels a library holds for a skinned mesh: each level's skin and the chain's errors.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SkinLods {
    /// The levels, finer to coarser (level 1 first; level 0 is the base mesh).
    pub levels: Vec<SkinId>,
    /// Their errors, for [`batch_lod`] and [`pick_level`].
    pub errors: Vec<f32>,
}

impl SkinLods {
    /// The skin that draws `level` of `base` (0, or a level past the chain: the base itself).
    pub fn skin(&self, base: SkinId, level: u32) -> SkinId {
        let at = (level as usize).checked_sub(1);
        at.and_then(|at| self.levels.get(at)).copied().unwrap_or(base)
    }
}

/// What a skinned draw skins this frame: one level whole, or in the fade band the two levels the
/// cull crossfades (`finer` fading out while `finer + 1` fades in).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SkinnedPick {
    /// One level (0 the base mesh), drawn whole.
    Whole(u32),
    /// Levels `finer` and `finer + 1`, drawn through the fade batches.
    Band {
        /// The finer of the two.
        finer: u32,
    },
}

impl SkinnedPick {
    /// The base mesh whole: every draw of a skin without levels.
    pub const BASE: SkinnedPick = SkinnedPick::Whole(0);

    /// The levels skinned, finer first.
    pub fn levels(self) -> std::ops::RangeInclusive<u32> {
        match self {
            SkinnedPick::Whole(level) => level..=level,
            SkinnedPick::Band { finer } => finer..=finer + 1,
        }
    }

    /// Whether the draw crossfades two levels.
    pub fn is_band(self) -> bool {
        matches!(self, SkinnedPick::Band { .. })
    }

    /// The LOD row (`GpuBatch::lod`) of the batch drawing `level` of this pick, over a chain of
    /// `errors` on a base mesh of bounding radius `radius`: `[0; 3]` (kept whole, the CPU chose)
    /// outside the band, the level's fade batch inside it (the cull computes each row's share),
    /// tagged as planned ([`crate::mesh::LOD_PLANNED_TAG`]: no shadow view casts a level the
    /// band did not skin).
    pub fn batch_lod(self, level: u32, errors: &[f32], radius: f32) -> [u32; 3] {
        if !self.is_band() {
            return [0; 3];
        }
        let [tag, low, high] = fade_batch_lod(level, errors, radius);
        [tag | crate::mesh::LOD_PLANNED_TAG, low, high]
    }
}

/// The levels of a skinned mesh (`mesh`, its `skin` rows and `parts`) from one chain per part,
/// each chain's indices naming the mesh's vertices inside its part. No levels when a part has no
/// chain, a level's part would be empty or an index leaves its part: the mesh then draws whole.
/// The mesh keeps as many levels as its shortest chain (at most [`LOD_MAX_LEVELS`]).
pub fn skinned_levels(mesh: &MeshData, skin: &[GpuSkinVertex], parts: &[SkinPart], chains: &[Option<LodChain>]) -> Vec<SkinnedLevel> {
    let usable = !parts.is_empty() && chains.len() == parts.len() && skin.len() == mesh.vertices.len();
    let Some(chains) = chains.iter().map(Option::as_ref).collect::<Option<Vec<&LodChain>>>().filter(|_| usable) else { return Vec::new() };
    // A skinned band is planned for the camera and cast as it draws (lane FQ): a chain's casters'
    // levels (lane FR) are never drawn, so they are left out.
    let camera: Vec<LodChain> = chains.iter().map(|chain| LodChain { levels: chain.levels[(chain.casters as usize).min(chain.levels.len())..].to_vec(), casters: 0 }).collect();
    let chains: Vec<&LodChain> = camera.iter().collect();
    let count = chains.iter().map(|chain| chain.levels.len()).min().unwrap_or(0).min(LOD_MAX_LEVELS as usize);
    let mut levels: Vec<SkinnedLevel> = Vec::with_capacity(count);
    for at in 0..count {
        let floor = levels.last().map_or(0.0, |finer| finer.error);
        let Some(level) = one_level(mesh, skin, parts, &chains, at, floor) else { return Vec::new() };
        levels.push(level);
    }
    levels
}

/// Level `at` of every part, compacted part after part; `None` when a part is empty there, is not
/// whole triangles or names a vertex outside itself.
fn one_level(mesh: &MeshData, skin: &[GpuSkinVertex], parts: &[SkinPart], chains: &[&LodChain], at: usize, floor: f32) -> Option<SkinnedLevel> {
    let mut level = SkinnedLevel { mesh: MeshData::default(), skin: Vec::new(), parts: Vec::with_capacity(parts.len()), error: floor };
    for (part, chain) in parts.iter().zip(chains) {
        let source = &chain.levels[at];
        let whole = !source.indices.is_empty() && source.indices.len().is_multiple_of(3);
        let range = part.first_vertex..part.first_vertex + part.vertex_count;
        let inside = source.indices.iter().all(|index| range.contains(index) && (*index as usize) < mesh.vertices.len());
        if !(whole && inside) {
            return None;
        }
        let first_vertex = level.mesh.vertices.len() as u32;
        let first_index = level.mesh.indices.len() as u32;
        let mut remap = std::collections::BTreeMap::new();
        for &index in &source.indices {
            let local = *remap.entry(index).or_insert_with(|| {
                level.mesh.vertices.push(mesh.vertices[index as usize]);
                level.skin.push(skin[index as usize]);
                level.mesh.vertices.len() as u32 - 1
            });
            level.mesh.indices.push(local);
        }
        let vertex_count = level.mesh.vertices.len() as u32 - first_vertex;
        level.parts.push(SkinPart { first_vertex, vertex_count, first_index, index_count: source.indices.len() as u32, material: part.material });
        level.error = level.error.max(source.error);
    }
    Some(level)
}

/// The LOD inputs of one skinned draw: its rows' world sphere and LOD origin, its bias, the cull's
/// LOD view (eye xyz, pixels a world unit at distance 1) and the frame's fade band.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SkinnedLodInput {
    /// The rows' world sphere (`GpuInstance::bounds`).
    pub bounds: [f32; 4],
    /// The sphere the levels measure from (`GpuLodRow::origin`).
    pub origin: [f32; 4],
    /// The row's bias (`GpuLodRow::bias`).
    pub bias: f32,
    /// The cull's LOD view (`GpuCullViews::lod`).
    pub view: [f32; 4],
    /// The fade band (`GpuCullViews::lod_params[1]`), 0 for hard switches.
    pub band: f32,
}

/// The levels the cull keeps for a draw of a chain of `errors` on a base mesh of bounding radius
/// `radius` under `input`: the level whose plain batch keeps it whole, else the two levels whose
/// fade batches keep it. No levels (or levels off) is the base mesh whole.
pub fn pick_level(errors: &[f32], radius: f32, input: &SkinnedLodInput) -> SkinnedPick {
    let levels = errors.len().min(LOD_MAX_LEVELS as usize) as u32;
    if levels == 0 {
        return SkinnedPick::BASE;
    }
    let keeps = |lod: [u32; 3]| lod_row_keep(lod, input.bounds, input.origin, input.view, input.bias, input.band);
    if let Some(level) = (0..=levels).find(|level| keeps(batch_lod(*level, errors, radius)).is_some()) {
        return SkinnedPick::Whole(level);
    }
    // In the band the finer level's fade batch keeps it fading out (a positive fade).
    match (0..levels).find(|level| keeps(fade_batch_lod(*level, errors, radius)).is_some_and(|fade| fade > 0.0)) {
        Some(finer) => SkinnedPick::Band { finer },
        None => SkinnedPick::BASE,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mesh::{LodLevel, Vertex};

    fn strip(quads: u32) -> (MeshData, Vec<GpuSkinVertex>) {
        let mut mesh = MeshData::default();
        for q in 0..=quads {
            for side in 0..2 {
                mesh.vertices.push(Vertex { position: [side as f32, q as f32, 0.0], ..Vertex::default() });
            }
        }
        for q in 0..quads {
            let at = q * 2;
            mesh.indices.extend([at, at + 1, at + 2, at + 1, at + 3, at + 2]);
        }
        let skin = (0..mesh.vertices.len()).map(|v| GpuSkinVertex { joints: [v as u32 % 2, 0, 0, 0], weights: [1.0, 0.0, 0.0, 0.0] }).collect();
        (mesh, skin)
    }

    #[test]
    fn a_level_keeps_only_the_vertices_its_triangles_use_with_their_skin_rows() {
        let (mesh, skin) = strip(4);
        let parts = [SkinPart::whole(&mesh)];
        let chain = LodChain { casters: 0, levels: vec![LodLevel { indices: vec![0, 1, 8, 1, 9, 8], error: 0.5 }] };
        let levels = skinned_levels(&mesh, &skin, &parts, &[Some(chain)]);
        assert_eq!(levels.len(), 1);
        assert_eq!(levels[0].mesh.vertices.len(), 4);
        assert_eq!(levels[0].mesh.indices, [0, 1, 2, 1, 3, 2]);
        assert_eq!(levels[0].skin, [skin[0], skin[1], skin[8], skin[9]]);
        assert_eq!(levels[0].parts[0], SkinPart { first_vertex: 0, vertex_count: 4, first_index: 0, index_count: 6, material: None });
    }

    #[test]
    fn a_part_without_a_chain_or_a_level_leaving_its_part_gives_no_levels() {
        let (mesh, skin) = strip(2);
        let parts = [SkinPart { first_vertex: 0, vertex_count: 4, first_index: 0, index_count: 6, material: Some(0) }];
        assert!(skinned_levels(&mesh, &skin, &parts, &[None]).is_empty());
        let leaving = LodChain { casters: 0, levels: vec![LodLevel { indices: vec![0, 1, 5], error: 0.1 }] };
        assert!(skinned_levels(&mesh, &skin, &parts, &[Some(leaving)]).is_empty());
    }

    /// Every level a pick skins is one the cull keeps (whole outside the band, through its fade
    /// batch inside it), and a hard switch never bands.
    #[test]
    fn the_pick_is_the_culls_keep_rule() {
        let errors = [0.01, 0.04, 0.16];
        let view = [0.0, 0.0, 0.0, 540.0 / libm::tanf(30.0f32.to_radians())];
        let mut seen_band = false;
        for band in [0.0, 0.2] {
            for step in 0..400 {
                let bounds = [0.0, 0.0, -(step as f32) * 0.5 - 0.1, 1.0];
                let input = SkinnedLodInput { bounds, origin: bounds, bias: 1.0, view, band };
                let pick = pick_level(&errors, 1.0, &input);
                seen_band |= pick.is_band();
                assert!(band > 0.0 || !pick.is_band(), "a hard switch never bands");
                for level in pick.levels() {
                    let kept = lod_row_keep(pick.batch_lod(level, &errors, 1.0), bounds, bounds, view, 1.0, band);
                    assert!(kept.is_some(), "band {band} step {step} level {level}: {pick:?}");
                }
            }
        }
        assert!(seen_band, "the dolly crosses a band");
    }
}
