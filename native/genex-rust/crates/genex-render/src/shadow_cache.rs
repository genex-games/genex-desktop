//! Cached static shadows plus a dynamic overlay (renderer pass 2, B.6; prior-art B5b; the idea of
//! Godot's positional shadow cache, MIT, no code). A Live frame's shadow layer (each sun cascade,
//! and the spot atlas layer) keeps a copy of its **static** casters' depth: on a frame whose layer
//! matrix and static casters are the cached ones, the layer is that copy (one depth
//! `copy_texture_to_texture`) with only the **dynamic** casters drawn over it, instead of every
//! caster again.
//!
//! - **Static** is a library batch, plain or a draw variant (no skinning, no levels of detail,
//!   whose level follows the camera, no far rule, whose thinning follows it too), whose rows
//!   (model matrix and material, row for row) stood still for [`STILL_FRAMES`] frames. Every other
//!   caster is the overlay: skinned, moving and swaying (model wind) batches, a batch with levels or rows a far rule
//!   thins, the LOD crossfade's fade twins (game systems LOD-05: they cast through the faded
//!   casters over the copy), the terrain's and the grass's casters.
//! - A layer's **key** is its matrix (and cull view), the map's shape and the static set, which
//!   changes when a cached caster moves, comes or goes. A layer whose key is its cache's reuses
//!   the cache; one whose key is last frame's but not its cache's **rebuilds** it (statics into
//!   the cache layer, the copy, the overlay); one whose key changed since last frame (a cascade
//!   following a moving camera) draws whole, so a layer that changes every frame never pays for
//!   a copy it cannot reuse. So a caster that starts moving leaves the cache on the frame it
//!   moves (no cached layer holds it from then on) and never leaves a stale shadow; it joins again
//!   after standing still for [`STILL_FRAMES`] frames.
//! - Depth is order-free (the nearest wins), so a cached layer holds exactly the depth a full draw
//!   writes: the cache changes cost, never the picture.
//! - A layer no overlay caster reaches (its cull view holds none) whose map already holds its
//!   static casters alone is **held**: no pass and no copy ([`LayerUse::Hold`]). A layer reuses
//!   its cache only when its static casters outweigh the copy
//!   ([`CACHE_PAYS_TRIANGLES_PER_BYTE`]); a light one draws whole.
//! - Only Live frames cache: a settled capture's re-renders, the CPU reference path and the
//!   meshlet path draw every caster as before ([`LayerUse::Draw`]).
//! - Not covered yet: a material whose row index stays while its content changes is not seen as
//!   a change.
//!
//! A sun cascade follows the camera (its map moves by whole texels), so a cascade reuses its cache
//! while the camera stands still or moves inside a texel; the spot layer's matrices stand still
//! with their lights, so it reuses its cache however the camera moves (Godot caches only its
//! positional shadows for the same reason).

use std::collections::BTreeMap;
use std::ops::Range;

use wgpu::{Device, Texture, TextureView};

use crate::cull::in_frustum;
use crate::layout::{GpuInstance, MAX_CASCADES};
use crate::scene::FramePlan;
use crate::shadow::{CascadeDraws, ShadowMapDesc};

/// Frames a batch's rows stand still before its casters join the cache: a caster that stops for
/// a moment does not rebuild every layer twice.
pub const STILL_FRAMES: u32 = 8;
/// Shadow layers a frame draws at most: every cascade, then the spot atlas layer.
pub const CACHE_LAYERS_MAX: usize = MAX_CASCADES + 1;
/// A reused layer costs a copy (its bytes read and written) and a load (read again) instead of
/// drawing its cached casters: it pays above this many cached triangles per byte of the layer.
/// Estimated from the B.6 cost row on an M4 Max: a 2048 px `depth32float` layer (16 MiB) breaks
/// even near 300 thousand depth-only triangles.
pub const CACHE_PAYS_TRIANGLES_PER_BYTE: f64 = 0.02;
/// How much wider than its bounding sphere an overlay row counts when it is tested against a
/// layer's cull view: a share of its radius, and at least this many world units.
const REACH_MARGIN_SHARE: f32 = 0.01;
/// The largest shadow array a cache array mirrors: the desktop high preset's three 2048 px
/// cascades and the spot atlas layer (`depth32float`). Bigger maps (ultra's 4096 px) and phones
/// (owner decision D16: a feature that cannot fit is off on phones) keep no array: their layers
/// are only held or drawn whole, which costs no memory.
pub const CACHE_ARRAY_MAX_BYTES: u64 = 64 << 20;
/// The renderer's held-resource ledger label of the cache array (`Renderer::buffer_ledger`).
pub const SHADOW_CACHE_LEDGER_LABEL: &str = "static shadow cache";
const REACH_MARGIN_MIN: f32 = 0.01;

/// How a frame draws one shadow layer.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum LayerUse {
    /// Every caster into the layer, as without a cache.
    #[default]
    Draw,
    /// The static casters into the cache layer, the cache copied into the map, the overlay over it.
    Rebuild,
    /// The cache copied into the map, the overlay over it.
    Reuse,
    /// Nothing: the map already holds the static casters and no other caster reaches the layer.
    Hold,
}

/// A frame's cache plan ([`ShadowCache::plan`]): which batches are cached and how each layer draws.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CachePlan {
    /// By batch: whether its casters are in the cache (else they are the overlay's).
    cached: Vec<bool>,
    /// By layer: cascades first, then the spot atlas layer.
    layers: [LayerUse; CACHE_LAYERS_MAX],
    /// By layer: whether a caster the cache does not hold reaches it (its overlay draws).
    reached: [bool; CACHE_LAYERS_MAX],
}

impl CachePlan {
    /// How layer `layer` (cascade `c` is layer `c`, the spot atlas the one after the cascades) draws.
    pub fn layer(&self, layer: usize) -> LayerUse {
        self.layers.get(layer).copied().unwrap_or_default()
    }

    /// Whether a caster the cache does not hold reaches layer `layer` (its overlay pass draws).
    pub fn reached(&self, layer: usize) -> bool {
        self.reached.get(layer).copied().unwrap_or(true)
    }

    /// Whether batch `batch`'s casters are in the cache.
    pub fn cached(&self, batch: u32) -> bool {
        self.cached.get(batch as usize).copied().unwrap_or(false)
    }

    /// The runs of `range`'s batches that are cached (`cached`) or the overlay's (`!cached`), in order.
    pub fn runs(&self, range: Range<u32>, cached: bool) -> Vec<Range<u32>> {
        let mut runs: Vec<Range<u32>> = Vec::new();
        for batch in range.filter(|batch| self.cached(*batch) == cached) {
            match runs.last_mut() {
                Some(run) if run.end == batch => run.end += 1,
                _ => runs.push(batch..batch + 1),
            }
        }
        runs
    }

    /// Layers drawn from the cache or held this frame.
    pub fn cached_layers(&self) -> u32 {
        self.layers.iter().filter(|layer| **layer != LayerUse::Draw).count() as u32
    }

    /// Whether a layer reads the cache array this frame (rebuilt or reused).
    pub fn reads_cache(&self) -> bool {
        self.layers.iter().any(|layer| matches!(layer, LayerUse::Rebuild | LayerUse::Reuse))
    }
}

/// A batch's identity across frames: its mesh (first index, index count, base vertex) and its
/// group (0 plain, 1 + the variant's place among the frame's variant runs).
type BatchKey = [u32; 4];

/// What a batch's rows were last frame and for how many frames they stood still.
#[derive(Clone, Copy, Debug)]
struct Still {
    rows: u64,
    frames: u32,
    seen: u64,
}

/// One layer's keys across frames: what its cache holds, what it drew last frame and, when its
/// map holds one key's static casters alone (no overlay was drawn into it), that key.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct LayerKeys {
    cached: Option<u64>,
    last: Option<u64>,
    map: Option<u64>,
    /// The key the cache's worth was weighed for, and whether it pays.
    weighed: Option<u64>,
    pays: bool,
}

/// The bounds of a frame's overlay rows (the batches the cache does not hold).
struct Overlay(Vec<[f32; 4]>);

impl Overlay {
    fn of(plan: &FramePlan, cached: &[bool]) -> Overlay {
        let mut bounds = Vec::new();
        for (b, batch) in plan.batches.iter().enumerate().filter(|(b, _)| !cached.get(*b).copied().unwrap_or(false)) {
            // A mesh's level batches share its rows: count them once.
            if b > 0 && batch.lod[0] != 0 && plan.batches[b - 1].first_row == batch.first_row {
                continue;
            }
            let first = batch.first_row as usize;
            bounds.extend(plan.instances.get(first..first + batch.instance_count as usize).unwrap_or(&[]).iter().map(|row| row.bounds));
        }
        Overlay(bounds)
    }

    /// Whether an overlay row lies in the cull view `planes`, its sphere widened by
    /// [`REACH_MARGIN_SHARE`] and [`REACH_MARGIN_MIN`]: the GPU cull rounds differently at a plane,
    /// and a row it keeps that this test misses would leave its shadow in a held map.
    fn reaches(&self, planes: &[[f32; 4]; 6]) -> bool {
        self.0.iter().any(|[x, y, z, r]| in_frustum(planes, [*x, *y, *z, r * (1.0 + REACH_MARGIN_SHARE) + REACH_MARGIN_MIN]))
    }
}

/// The cache across frames: each batch's stillness and each layer's keys.
#[derive(Debug)]
pub struct ShadowCache {
    enabled: bool,
    batches: BTreeMap<BatchKey, Still>,
    layers: [LayerKeys; CACHE_LAYERS_MAX],
    frame: u64,
}

impl Default for ShadowCache {
    fn default() -> Self {
        ShadowCache { enabled: true, batches: BTreeMap::new(), layers: [LayerKeys::default(); CACHE_LAYERS_MAX], frame: 0 }
    }
}

impl ShadowCache {
    /// Switch the cache on or off (on by default, on every class); off draws every caster every
    /// frame, as before B.6.
    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
        if !enabled {
            self.reset();
        }
    }

    /// Whether the cache is on.
    pub fn enabled(&self) -> bool {
        self.enabled
    }

    /// Forget every layer's cache and every batch's stillness (new maps, a history reset).
    pub fn reset(&mut self) {
        self.batches.clear();
        self.layers = [LayerKeys::default(); CACHE_LAYERS_MAX];
    }

    /// Plan `plan`'s shadow layers: `draws` the cascades the frame redraws, `desc` the maps' shape,
    /// `live` false on a settled capture's re-renders (every layer draws and the cache starts over),
    /// `ground` when a terrain (and its grass) draws casters into every cascade: the overlay then
    /// reaches every cascade; `array` when the renderer may hold a cache array (else a layer is
    /// only held or drawn whole).
    pub fn plan(&mut self, plan: &FramePlan, draws: &CascadeDraws, desc: ShadowMapDesc, live: bool, (ground, array): (bool, bool)) -> CachePlan {
        self.frame += 1;
        if !self.enabled || !live {
            self.reset();
            return CachePlan::default();
        }
        let cached = self.cached_batches(plan);
        let statics = statics_key(plan, &cached);
        let mut out = CachePlan { cached, layers: [LayerUse::Draw; CACHE_LAYERS_MAX], reached: [true; CACHE_LAYERS_MAX] };
        let Some(statics) = statics else {
            self.layers = [LayerKeys::default(); CACHE_LAYERS_MAX];
            return out;
        };
        let overlay = Overlay::of(plan, &out.cached);
        let cascades = plan.cascades_drawn();
        for c in (0..cascades).filter(|c| draws.draws(*c)) {
            let view = plan.cascades.as_ref().map(|set| set.view_proj[c]).unwrap_or_default();
            let planes = plan.cull_views.planes[1 + c];
            let key = layer_key(statics, desc, &[(c as u32, view, planes)]);
            out.reached[c] = ground || overlay.reaches(&planes);
            let pays = || array && pays(plan, &out.cached, &[planes], desc);
            out.layers[c] = self.use_layer(c, key, out.reached[c], pays);
        }
        if !plan.spot_shadows.is_empty() {
            let spots: Vec<_> = plan.spot_shadows.iter().map(|spot| (spot.slot, spot.view_proj, spot.planes)).collect();
            out.reached[cascades] = plan.spot_shadows.iter().any(|spot| overlay.reaches(&spot.planes));
            let views: Vec<_> = plan.spot_shadows.iter().map(|spot| spot.planes).collect();
            let pays = || array && pays(plan, &out.cached, &views, desc);
            out.layers[cascades] = self.use_layer(cascades, layer_key(statics, desc, &spots), out.reached[cascades], pays);
        }
        // A layer the frame does not draw keeps its keys only while its cascade is held.
        for layer in (cascades + usize::from(!plan.spot_shadows.is_empty()))..CACHE_LAYERS_MAX {
            self.layers[layer] = LayerKeys::default();
        }
        out
    }

    /// How layer `layer` draws for `key`, `overlay` whether a caster the cache does not hold
    /// reaches it: held when its map already holds `key`'s statics alone and nothing else reaches
    /// it; else from the cache when its cache holds `key`; rebuilt when `key` was last frame's too
    /// and its static casters outweigh the copies (`pays`, asked once per key); else drawn whole.
    fn use_layer(&mut self, layer: usize, key: u64, overlay: bool, pays: impl FnOnce() -> bool) -> LayerUse {
        let keys = &mut self.layers[layer];
        let last = keys.last.replace(key);
        let held = keys.map == Some(key);
        // After this frame the map holds `key`'s statics alone exactly when no overlay reaches it.
        keys.map = (!overlay).then_some(key);
        if held && !overlay {
            return LayerUse::Hold;
        }
        if keys.cached == Some(key) {
            return LayerUse::Reuse;
        }
        if last != Some(key) {
            return LayerUse::Draw;
        }
        if keys.weighed != Some(key) {
            keys.weighed = Some(key);
            keys.pays = pays();
        }
        if !keys.pays {
            return LayerUse::Draw;
        }
        keys.cached = Some(key);
        LayerUse::Rebuild
    }

    /// Each batch of `plan`: whether it is a cacheable library batch whose rows stood still for
    /// [`STILL_FRAMES`] frames (the count updated here, batches gone forgotten).
    fn cached_batches(&mut self, plan: &FramePlan) -> Vec<bool> {
        let frame = self.frame;
        let groups = batch_groups(plan);
        let cached = plan
            .batches
            .iter()
            .enumerate()
            .map(|(b, batch)| {
                let Some(group) = groups[b] else { return false };
                let first = batch.first_row as usize;
                let batch_rows = plan.instances.get(first..first + batch.instance_count as usize).unwrap_or(&[]);
                // Model wind: a swaying row casts a moving shadow every frame.
                let swaying = batch_rows.iter().any(|row| row.wind != [0; 3]);
                if batch.lod[0] != 0 || swaying || far_ruled(plan, batch) {
                    return false;
                }
                let key = [batch.first_index, batch.index_count, batch.base_vertex as u32, group];
                let rows = rows_key(batch_rows);
                let still = self.batches.entry(key).or_insert(Still { rows, frames: 0, seen: frame });
                still.frames = if still.rows == rows && still.seen + 1 >= frame { still.frames.saturating_add(1) } else { 0 };
                still.rows = rows;
                still.seen = frame;
                still.frames > STILL_FRAMES
            })
            .collect();
        self.batches.retain(|_, still| still.seen == frame);
        cached
    }
}

/// Whether `batch` draws rows a far rule thins (game systems LOD-18): the camera's cull drops and
/// fades its copies wherever the camera goes, so its casters are the overlay's (LOD-05).
fn far_ruled(plan: &FramePlan, batch: &crate::layout::GpuBatch) -> bool {
    let first = batch.first_row as usize;
    plan.lod_rows.get(first..first + batch.instance_count as usize).unwrap_or(&[]).iter().any(|row| row.far_rule != crate::lod_rows::FAR_RULE_NONE)
}

/// By batch of `plan`: its group when it draws from the library (0 plain, 1 + its variant run),
/// `None` for a skinned batch.
fn batch_groups(plan: &FramePlan) -> Vec<Option<u32>> {
    let mut groups = vec![None; plan.batches.len()];
    for b in 0..plan.static_batches.min(plan.batches.len() as u32) {
        groups[b as usize] = Some(0);
    }
    for (v, run) in plan.variants.iter().enumerate() {
        for b in run.batches.start..run.skinned_from.min(plan.batches.len() as u32) {
            groups[b as usize] = Some(1 + v as u32);
        }
    }
    groups
}

/// Whether caching a layer of `desc`'s maps drawn through `views` pays: its cached casters'
/// triangles in those views outweigh the copy and the load a reuse costs
/// ([`CACHE_PAYS_TRIANGLES_PER_BYTE`] of the layer's bytes).
fn pays(plan: &FramePlan, cached: &[bool], views: &[[[f32; 4]; 6]], desc: ShadowMapDesc) -> bool {
    let layer_bytes = desc.bytes() / u64::from(desc.layers.max(1));
    let worth = (layer_bytes as f64 * CACHE_PAYS_TRIANGLES_PER_BYTE) as u64;
    let mut triangles = 0u64;
    for (batch, _) in plan.batches.iter().zip(cached).filter(|(_, cached)| **cached) {
        let first = batch.first_row as usize;
        let rows = plan.instances.get(first..first + batch.instance_count as usize).unwrap_or(&[]);
        for planes in views {
            triangles += rows.iter().filter(|row| in_frustum(planes, row.bounds)).count() as u64 * u64::from(batch.index_count / 3);
        }
        if triangles >= worth {
            return true;
        }
    }
    false
}

/// FNV-1a over 32-bit words: cheap, stable on every target.
#[derive(Clone, Copy)]
struct Fnv(u64);

impl Fnv {
    const START: Fnv = Fnv(0xcbf2_9ce4_8422_2325);
    const PRIME: u64 = 0x0000_0100_0000_01b3;

    fn word(self, word: u32) -> Fnv {
        Fnv((self.0 ^ u64::from(word)).wrapping_mul(Fnv::PRIME))
    }

    fn floats(self, values: &[f32]) -> Fnv {
        values.iter().fold(self, |hash, value| hash.word(value.to_bits()))
    }
}

/// The key of a batch's rows: each row's model matrix and material, and their count.
fn rows_key(rows: &[GpuInstance]) -> u64 {
    rows.iter().fold(Fnv::START.word(rows.len() as u32), |hash, row| hash.floats(&row.model).word(row.material)).0
}

/// The key of the frame's static casters (every cached batch's mesh and rows), `None` when no
/// batch is cached.
fn statics_key(plan: &FramePlan, cached: &[bool]) -> Option<u64> {
    let mut hash = Fnv::START;
    let mut any = false;
    for (batch, _) in plan.batches.iter().zip(cached).filter(|(_, cached)| **cached) {
        any = true;
        let first = batch.first_row as usize;
        let rows = rows_key(plan.instances.get(first..first + batch.instance_count as usize).unwrap_or(&[]));
        hash = hash.word(batch.first_index).word(batch.index_count).word(batch.base_vertex as u32).word(rows as u32).word((rows >> 32) as u32);
    }
    any.then_some(hash.0)
}

/// One view a layer is drawn through: its slot, view-projection and cull planes.
type LayerView = (u32, [f32; 16], [[f32; 4]; 6]);

/// The key of a layer drawn through `views` (slot, view-projection, cull planes) over the static
/// casters `statics` into maps of `desc`.
fn layer_key(statics: u64, desc: ShadowMapDesc, views: &[LayerView]) -> u64 {
    let hash = Fnv(statics).word(desc.side).word(desc.layers).word(u32::from(desc.format == wgpu::TextureFormat::Depth16Unorm)).word(views.len() as u32);
    views.iter().fold(hash, |hash, (slot, view_proj, planes)| hash.word(*slot).floats(view_proj).floats(planes.as_flattened())).0
}

/// The renderer's cache: the plan across frames, this frame's plan and the depth array it draws.
#[derive(Default)]
pub(crate) struct ShadowCacheState {
    pub(crate) cache: ShadowCache,
    pub(crate) plan: CachePlan,
    pub(crate) maps: Option<CacheMaps>,
}

impl ShadowCacheState {
    /// Plan the frame's layers ([`ShadowCache::plan`]; `live` false on a settled capture, the CPU
    /// reference path and the meshlet path; `ground` when a terrain draws casters into every
    /// cascade; `array` when a cache array may be held) and hold a cache array of `desc`'s shape
    /// while a layer draws from it.
    pub(crate) fn prepare(&mut self, device: &Device, plan: &FramePlan, draws: &CascadeDraws, desc: ShadowMapDesc, (live, ground, array): (bool, bool, bool)) {
        if !array {
            self.maps = None;
        }
        self.plan = self.cache.plan(plan, draws, desc, live, (ground, array));
        if !self.plan.reads_cache() {
            return;
        }
        if self.maps.as_ref().is_none_or(|maps| maps.desc != desc) {
            self.maps = Some(CacheMaps::new(device, desc));
            // A new array holds nothing yet: every cached layer draws its statics into it, and a
            // layer drawn whole this frame has no cache to come back to.
            for (layer, keys) in self.plan.layers.iter_mut().zip(&mut self.cache.layers) {
                match layer {
                    LayerUse::Reuse => *layer = LayerUse::Rebuild,
                    LayerUse::Draw | LayerUse::Hold => keys.cached = None,
                    LayerUse::Rebuild => {}
                }
            }
        }
    }

    /// How layer `layer` draws, with the cache array when it reads it (`Draw` when it would read an
    /// array the renderer does not hold).
    pub(crate) fn layer(&self, layer: usize) -> (LayerUse, Option<&CacheMaps>) {
        let used = self.plan.layer(layer);
        let maps = self.maps.as_ref().filter(|maps| (layer as u32) < maps.desc.layers);
        match (used, maps) {
            (LayerUse::Rebuild | LayerUse::Reuse, None) => (LayerUse::Draw, None),
            _ => (used, maps),
        }
    }

    /// Bytes the cache array holds (0 before a frame cached a layer).
    pub fn bytes(&self) -> u64 {
        self.maps.as_ref().map_or(0, |maps| maps.desc.bytes())
    }
}

/// The cache's depth array: the shadow maps' shape, a view per layer to draw the statics into.
pub(crate) struct CacheMaps {
    pub(crate) desc: ShadowMapDesc,
    pub(crate) texture: Texture,
    pub(crate) layers: Vec<TextureView>,
}

impl CacheMaps {
    /// A cache for maps of `desc`.
    pub(crate) fn new(device: &Device, desc: ShadowMapDesc) -> CacheMaps {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("shadow cache"),
            size: wgpu::Extent3d { width: desc.side, height: desc.side, depth_or_array_layers: desc.layers },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: desc.format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let layers = (0..desc.layers)
            .map(|layer| {
                texture.create_view(&wgpu::TextureViewDescriptor {
                    dimension: Some(wgpu::TextureViewDimension::D2),
                    base_array_layer: layer,
                    array_layer_count: Some(1),
                    ..Default::default()
                })
            })
            .collect();
        CacheMaps { desc, texture, layers }
    }
}

/// Copy layer `layer` of the cache into the same layer of the shadow maps `target` (whole layer:
/// WebGPU copies a depth texture only by whole subresource).
pub(crate) fn copy_layer(encoder: &mut wgpu::CommandEncoder, cache: &CacheMaps, target: &Texture, layer: u32) {
    let at = |texture| wgpu::TexelCopyTextureInfo { texture, mip_level: 0, origin: wgpu::Origin3d { x: 0, y: 0, z: layer }, aspect: wgpu::TextureAspect::All };
    let size = wgpu::Extent3d { width: cache.desc.side, height: cache.desc.side, depth_or_array_layers: 1 };
    encoder.copy_texture_to_texture(at(&cache.texture), at(target), size);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan_with(cached: &[bool]) -> CachePlan {
        CachePlan { cached: cached.to_vec(), layers: [LayerUse::Draw; CACHE_LAYERS_MAX], reached: [true; CACHE_LAYERS_MAX] }
    }

    #[test]
    fn runs_split_a_range_into_cached_and_overlay_batches_in_order() {
        let plan = plan_with(&[true, true, false, true, false, false]);
        assert_eq!(plan.runs(0..6, true), vec![0..2, 3..4]);
        assert_eq!(plan.runs(0..6, false), vec![2..3, 4..6]);
        assert_eq!(plan.runs(1..4, true), vec![1..2, 3..4]);
        // A batch past the plan's is the overlay's.
        assert_eq!(plan.runs(5..8, false), vec![5..8]);
    }

    #[test]
    fn rows_key_changes_when_a_row_moves_or_changes_material_or_count() {
        let row = GpuInstance { model: glam::Mat4::IDENTITY.to_cols_array(), ..GpuInstance::default() };
        let mut moved = row;
        moved.model[12] = 0.001;
        let mut other = row;
        other.material = 1;
        let base = rows_key(&[row, row]);
        assert_eq!(base, rows_key(&[row, row]));
        assert_ne!(base, rows_key(&[row, moved]));
        assert_ne!(base, rows_key(&[row, other]));
        assert_ne!(base, rows_key(&[row]));
    }
}
