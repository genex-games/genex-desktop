//! Import-time LODs (renderer pass 2, A6.9): the `genex_lods` extras the Studio's import step
//! writes on a GLB primitive (`src/substrate/asset-import/lods.ts`), read and validated here, merged
//! level by level across a part's primitives, and the level a draw takes ([`select_lod`], and its
//! WGSL twin [`LOD_SELECT_WGSL`]).
//!
//! A primitive's levels are triangle lists over its own vertices, coarser and coarser, each with
//! the object-space error the simplifier reported. A part (one material's primitives merged into
//! one mesh) gets a chain only when every one of its primitives brought valid levels: level k is
//! every primitive's level k rebased into the part, its error the largest of theirs scaled by
//! each primitive's node. A set that fails is dropped with a typed [`LodFault`] and the mesh
//! draws whole.
//!
//! **Drawing (A6.9 runtime).** A part's chain rides on [`crate::mesh::GlbPart`] into the mesh
//! library ([`crate::scene::ModelPart`]), which keeps each level as a mesh of its own (its used
//! vertices only, so each level has its own vertex slot). A frame plans one batch per level of a
//! drawn mesh, every batch holding all of the mesh's instances; the batch's LOD row
//! ([`batch_lod`]: its level, the chain's length and the errors relative to the mesh's bounding
//! radius) lets the cull keep an instance only in the batch of the level [`select_lod`] picks for
//! it, seen from the camera ([`lod_keeps`], `gx_cull_lod_keeps` in `shaders/cull.wgsl`). Every
//! view (the shadow cascades and spots too) draws an instance at the camera's level, so an
//! object never shadows itself with another shape.

use glam::{Mat3, Mat4};

/// The key of the LOD object in a glTF primitive's `extras` (never an extension).
pub const LODS_EXTRAS_KEY: &str = "genex_lods";
/// The `genex_lods` schema version this build reads; any other is ignored with a typed fault.
pub const LOD_SCHEMA_VERSION: u32 = 1;
/// Most levels past the primitive's own triangles (the WGSL select reads them as a `vec4`).
pub const LOD_MAX_LEVELS: u32 = 4;
/// The fewest triangles a GLB needs before the import step simplifies it.
pub const LOD_MIN_TRIANGLES: u32 = 512;
/// [`select_lod`] in WGSL (`gx_lod_select`), for the cull to include.
pub const LOD_SELECT_WGSL: &str = include_str!("../shaders/geometry/lod_select.wgsl");
/// The error a drawn level may show, in output pixels.
pub const LOD_THRESHOLD_PX: f32 = 1.0;
/// The output height a plan's LOD view assumes until the renderer gives it its own
/// ([`crate::scene::FramePlan::set_lod_height`]).
pub const LOD_NOMINAL_HEIGHT: u32 = 1080;
/// The bit of a batch's LOD tag marking a batch that draws one level of a chain.
const LOD_TAG: u32 = 1 << 31;
/// The tag's bits holding the batch's level (0 the mesh itself).
const LOD_LEVEL_MASK: u32 = 0xF;
/// Where the chain's length (levels past the mesh) sits in the tag.
const LOD_LEVELS_SHIFT: u32 = 4;

/// The members of the `genex_lods` extras object (wire spellings).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum LodExtrasKey {
    /// The schema version ([`LOD_SCHEMA_VERSION`]).
    Version,
    /// The bufferView of every level's triangle list: little-endian `u32` primitive vertex indices.
    Indices,
    /// The levels, coarser and coarser ([`LodLevelKey`] each).
    Levels,
}

impl LodExtrasKey {
    /// Every key, in the schema's order.
    pub const ALL: [LodExtrasKey; 3] = [LodExtrasKey::Version, LodExtrasKey::Indices, LodExtrasKey::Levels];

    /// The wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            LodExtrasKey::Version => "version",
            LodExtrasKey::Indices => "indices",
            LodExtrasKey::Levels => "levels",
        }
    }
}

/// The members of one level (wire spellings).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum LodLevelKey {
    /// Its first index in the view.
    First,
    /// Its index count (whole triangles).
    Count,
    /// Its simplification error, an object-space distance.
    Error,
}

impl LodLevelKey {
    /// Every key, in the schema's order.
    pub const ALL: [LodLevelKey; 3] = [LodLevelKey::First, LodLevelKey::Count, LodLevelKey::Error];

    /// The wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            LodLevelKey::First => "first",
            LodLevelKey::Count => "count",
            LodLevelKey::Error => "error",
        }
    }
}

/// Why a primitive's `genex_lods` is refused (typed; the mesh then draws whole).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum LodFault {
    /// Another schema version, or extras that are not an object.
    UnknownVersion,
    /// More than [`LOD_MAX_LEVELS`] levels.
    OverLimit,
    /// A view that is missing, outside the buffer or not whole words, or a level past its view.
    RangeOutOfBounds,
    /// An index past the primitive's vertices.
    VertexOutOfMesh,
    /// A level that is not whole triangles, finer than the one before, or with an error that is
    /// not finite, negative or smaller than the one before.
    NotCoarser,
}

impl LodFault {
    /// Every fault, in the schema's order.
    pub const ALL: [LodFault; 5] = [LodFault::UnknownVersion, LodFault::OverLimit, LodFault::RangeOutOfBounds, LodFault::VertexOutOfMesh, LodFault::NotCoarser];

    /// The wire spelling (the typed warning).
    pub const fn wire(self) -> &'static str {
        match self {
            LodFault::UnknownVersion => "lods-unknown-version",
            LodFault::OverLimit => "lods-over-limit",
            LodFault::RangeOutOfBounds => "lods-range-out-of-bounds",
            LodFault::VertexOutOfMesh => "lods-vertex-out-of-mesh",
            LodFault::NotCoarser => "lods-not-coarser",
        }
    }
}

/// A primitive whose `genex_lods` were refused: the part then has no chain. `fault.wire()` is the
/// typed warning.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LodWarning {
    /// The primitive's place among the part's primitives.
    pub primitive: usize,
    /// Why the extras were refused.
    pub fault: LodFault,
}

/// One simplified level of a part.
#[derive(Clone, Debug, PartialEq)]
pub struct LodLevel {
    /// Its triangle list over the part's vertices.
    pub indices: Vec<u32>,
    /// Its object-space error in the part's (placed) space.
    pub error: f32,
}

/// A part's levels, coarser and coarser (level 0, the mesh itself, is not among them).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LodChain {
    /// The levels.
    pub levels: Vec<LodLevel>,
}

impl LodChain {
    /// The levels' errors, for [`select_lod`].
    pub fn errors(&self) -> Vec<f32> {
        self.levels.iter().map(|level| level.error).collect()
    }
}

/// The level to draw: 0 for the mesh itself, `k` for `errors[k - 1]`'s level, the coarsest whose
/// error seen at `distance` (with `pixels_per_unit` pixels a world unit at distance 1: the viewport
/// height over twice the tangent of half the vertical field of view) is at most `threshold_px`.
/// Compared as `error * pixels_per_unit <= threshold_px * distance`, two correctly rounded products,
/// exactly as `gx_lod_select` does; a distance that is not positive (or NaN) draws the mesh itself.
pub fn select_lod(errors: &[f32], distance: f32, pixels_per_unit: f32, threshold_px: f32) -> u32 {
    if distance.is_nan() || distance <= 0.0 {
        return 0;
    }
    let budget = threshold_px * distance;
    let mut picked = 0;
    for (level, error) in errors.iter().take(LOD_MAX_LEVELS as usize).enumerate() {
        if error * pixels_per_unit <= budget {
            picked = level as u32 + 1;
        }
    }
    picked
}

/// The LOD row (`GpuBatch::lod`) of a batch drawing level `level` (0 the mesh itself) of a chain
/// whose levels have `errors` (object space, at most [`LOD_MAX_LEVELS`]) on a mesh of bounding
/// radius `radius`: x the tag (the batch's level and the chain's length), y and z the errors
/// over the radius as two half-float pairs, so the cull scales them by each instance's world
/// radius. `[0; 3]` is a batch of a mesh without levels.
pub fn batch_lod(level: u32, errors: &[f32], radius: f32) -> [u32; 3] {
    let levels = errors.len().min(LOD_MAX_LEVELS as usize);
    let relative = |at: usize| errors.get(at).filter(|_| at < levels).map_or(0.0, |error| if radius > 0.0 { error / radius } else { 0.0 });
    let pair = |at: usize| u32::from(f16_bits(relative(at))) | (u32::from(f16_bits(relative(at + 1))) << 16);
    [LOD_TAG | (levels as u32) << LOD_LEVELS_SHIFT | (level & LOD_LEVEL_MASK), pair(0), pair(2)]
}

/// Whether the cull keeps an instance of world bounds `bounds` in a batch with LOD row `lod`
/// under the frame's LOD `view` (camera position xyz; w the output's pixels a world unit at
/// distance 1 over [`LOD_THRESHOLD_PX`], 0 when levels are off, as under an orthographic camera):
/// a batch without levels keeps every instance, a level's batch only the instances
/// [`select_lod`] gives that level, seen from the camera's distance to the bounding sphere. The
/// cull's `gx_cull_lod_keeps`, expression for expression.
pub fn lod_keeps(lod: [u32; 3], bounds: [f32; 4], view: [f32; 4]) -> bool {
    if lod[0] & LOD_TAG == 0 {
        return true;
    }
    let level = lod[0] & LOD_LEVEL_MASK;
    // Not positive (NaN included): levels are off, as `!(lod.w > 0.0)` in the cull.
    if view[3].partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater) {
        return level == 0;
    }
    let levels = ((lod[0] >> LOD_LEVELS_SHIFT) & LOD_LEVEL_MASK).min(LOD_MAX_LEVELS) as usize;
    let halves = [lod[1] & 0xFFFF, lod[1] >> 16, lod[2] & 0xFFFF, lod[2] >> 16];
    let errors = halves.map(|bits| f16_value(bits as u16) * bounds[3]);
    let offset = [bounds[0] - view[0], bounds[1] - view[1], bounds[2] - view[2]];
    let distance = (offset[0] * offset[0] + offset[1] * offset[1] + offset[2] * offset[2]).sqrt() - bounds[3];
    select_lod(&errors[..levels], distance, view[3], 1.0) == level
}

/// `value` as IEEE half-float bits, rounded to the nearest (ties to even); past the largest
/// half it is the largest, below the smallest subnormal 0. Only non-negative finite values are
/// stored (relative errors).
fn f16_bits(value: f32) -> u16 {
    if value.is_nan() || value <= 0.0 {
        return 0;
    }
    const MAX_HALF: u16 = 0x7BFF;
    let bits = value.to_bits();
    let exponent = ((bits >> 23) & 0xFF) as i32 - 127 + 15;
    let mantissa = bits & 0x7F_FFFF;
    if exponent >= 0x1F {
        return MAX_HALF;
    }
    // A normal half keeps 10 of the 23 mantissa bits; a subnormal fewer, the implicit one shifted in.
    let (base, shift, full) = if exponent > 0 { ((exponent as u32) << 10, 13, mantissa) } else { (0, (14 - exponent) as u32, mantissa | 0x80_0000) };
    if shift > 24 {
        return 0;
    }
    let kept = full >> shift;
    let rest = full & ((1 << shift) - 1);
    let half = 1 << (shift - 1);
    let round_up = rest > half || (rest == half && kept & 1 == 1);
    // A carry out of the mantissa moves into the exponent, as the format means it to.
    (base + kept + u32::from(round_up)).min(u32::from(MAX_HALF)) as u16
}

/// The value of IEEE half-float `bits` (exact).
fn f16_value(bits: u16) -> f32 {
    let exponent = u32::from((bits >> 10) & 0x1F);
    let mantissa = u32::from(bits & 0x3FF);
    let sign = if bits & 0x8000 != 0 { -1.0 } else { 1.0 };
    let magnitude = match exponent {
        0 => mantissa as f32 * (1.0 / (1u32 << 24) as f32),
        0x1F if mantissa == 0 => f32::INFINITY,
        0x1F => f32::NAN,
        _ => f32::from_bits(((exponent + 127 - 15) << 23) | (mantissa << 13)),
    };
    sign * magnitude
}

/// What one primitive's `extras.genex_lods` gave.
pub(crate) enum PrimitiveLods {
    /// No such member.
    Absent,
    /// Levels that passed validation, over the primitive's own vertices.
    Valid(Vec<LodLevel>),
    /// Levels refused.
    Refused(LodFault),
}

/// A level entry's numbers: first, count, error.
fn level_entry(value: &gltf::json::Value) -> Option<(usize, usize, f32)> {
    let first = usize::try_from(value.get(LodLevelKey::First.wire())?.as_u64()?).ok()?;
    let count = usize::try_from(value.get(LodLevelKey::Count.wire())?.as_u64()?).ok()?;
    let error = value.get(LodLevelKey::Error.wire())?.as_f64()? as f32;
    Some((first, count, error))
}

/// The indices view's words.
fn view_words(gltf: &gltf::Gltf, blob: Option<&[u8]>, extras: &gltf::json::Value) -> Result<Vec<u32>, LodFault> {
    let at = extras.get(LodExtrasKey::Indices.wire()).and_then(gltf::json::Value::as_u64).ok_or(LodFault::RangeOutOfBounds)?;
    let view = usize::try_from(at).ok().and_then(|at| gltf.views().nth(at)).ok_or(LodFault::RangeOutOfBounds)?;
    let range = view.offset()..view.offset().saturating_add(view.length());
    let bytes = blob.and_then(|blob| blob.get(range)).ok_or(LodFault::RangeOutOfBounds)?;
    if !bytes.len().is_multiple_of(4) {
        return Err(LodFault::RangeOutOfBounds);
    }
    Ok(bytes.as_chunks::<4>().0.iter().map(|word| u32::from_le_bytes(*word)).collect())
}

/// One level checked against the one before it and the primitive's vertex count.
fn check_level(level: &LodLevel, previous: Option<&LodLevel>, vertex_count: u32) -> Result<(), LodFault> {
    let whole = !level.indices.is_empty() && level.indices.len().is_multiple_of(3);
    let error_ok = level.error.is_finite() && level.error >= previous.map_or(0.0, |p| p.error);
    let coarser = previous.is_none_or(|p| level.indices.len() <= p.indices.len());
    if !(whole && error_ok && coarser) {
        return Err(LodFault::NotCoarser);
    }
    if level.indices.iter().any(|&index| index >= vertex_count) {
        return Err(LodFault::VertexOutOfMesh);
    }
    Ok(())
}

/// The levels an extras member names, every number checked.
fn decode(gltf: &gltf::Gltf, blob: Option<&[u8]>, extras: &gltf::json::Value, vertex_count: u32) -> Result<Vec<LodLevel>, LodFault> {
    let version = extras.get(LodExtrasKey::Version.wire()).and_then(gltf::json::Value::as_u64);
    if !extras.is_object() || version != Some(u64::from(LOD_SCHEMA_VERSION)) {
        return Err(LodFault::UnknownVersion);
    }
    let entries = extras.get(LodExtrasKey::Levels.wire()).and_then(gltf::json::Value::as_array).ok_or(LodFault::RangeOutOfBounds)?;
    if entries.len() > LOD_MAX_LEVELS as usize {
        return Err(LodFault::OverLimit);
    }
    let words = view_words(gltf, blob, extras)?;
    let mut levels: Vec<LodLevel> = Vec::with_capacity(entries.len());
    for entry in entries {
        let (first, count, error) = level_entry(entry).ok_or(LodFault::RangeOutOfBounds)?;
        let indices = first.checked_add(count).and_then(|end| words.get(first..end)).ok_or(LodFault::RangeOutOfBounds)?;
        let level = LodLevel { indices: indices.to_vec(), error };
        check_level(&level, levels.last(), vertex_count)?;
        levels.push(level);
    }
    Ok(levels)
}

/// Read and validate a primitive's `genex_lods` against its `vertex_count` vertices. Extras that
/// are not an object, or have no such member, are not ours ([`PrimitiveLods::Absent`]).
pub(crate) fn read_lod_extras(gltf: &gltf::Gltf, primitive: &gltf::Primitive<'_>, blob: Option<&[u8]>, vertex_count: u32) -> PrimitiveLods {
    let Some(raw) = primitive.extras() else { return PrimitiveLods::Absent };
    let Ok(value) = gltf::json::deserialize::from_str::<gltf::json::Value>(raw.get()) else { return PrimitiveLods::Absent };
    let Some(extras) = value.get(LODS_EXTRAS_KEY) else { return PrimitiveLods::Absent };
    match decode(gltf, blob, extras, vertex_count) {
        Ok(levels) => PrimitiveLods::Valid(levels),
        Err(fault) => PrimitiveLods::Refused(fault),
    }
}

/// How much a node's matrix can stretch a distance: its linear part's longest axis.
fn largest_scale(world: Mat4) -> f32 {
    let linear = Mat3::from_mat4(world);
    [linear.x_axis.length(), linear.y_axis.length(), linear.z_axis.length()].into_iter().fold(0.0_f32, f32::max)
}

/// A part's primitives' levels gathered into its chain.
#[derive(Default)]
pub(crate) struct LodMerge {
    levels: Vec<LodLevel>,
    /// Every primitive visited so far had valid levels.
    complete: bool,
    started: bool,
    visited: usize,
    warnings: Vec<LodWarning>,
}

impl LodMerge {
    /// One primitive's levels, placed by `world`, its vertices starting at `base` in the part.
    pub(crate) fn visit(&mut self, found: PrimitiveLods, world: Mat4, base: u32) {
        if !self.started {
            (self.started, self.complete) = (true, true);
        }
        match found {
            PrimitiveLods::Absent => self.complete = false,
            PrimitiveLods::Refused(fault) => {
                self.complete = false;
                log::warn!("glb lods: primitive {} refused ({}); the mesh draws whole", self.visited, fault.wire());
                self.warnings.push(LodWarning { primitive: self.visited, fault });
            }
            PrimitiveLods::Valid(levels) => self.append(levels, largest_scale(world), base),
        }
        self.visited += 1;
    }

    /// Level k of the part gains the primitive's level k; the part keeps as many levels as its
    /// shortest primitive chain.
    fn append(&mut self, levels: Vec<LodLevel>, scale: f32, base: u32) {
        let first = self.visited == 0;
        if !first {
            self.levels.truncate(levels.len());
        }
        for (at, level) in levels.into_iter().enumerate() {
            let rebased = level.indices.iter().map(|index| base + index);
            let error = level.error * scale;
            match self.levels.get_mut(at) {
                Some(merged) => {
                    merged.indices.extend(rebased);
                    merged.error = merged.error.max(error);
                }
                None if first => self.levels.push(LodLevel { indices: rebased.collect(), error }),
                None => {}
            }
        }
    }

    /// The part's chain when every primitive had levels, with the warnings of those refused.
    pub(crate) fn finish(self) -> (Option<LodChain>, Vec<LodWarning>) {
        let usable = self.complete && !self.levels.is_empty();
        (usable.then_some(LodChain { levels: self.levels }), self.warnings)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every half-float bit pattern that is a finite non-negative value comes back from its value,
    /// and values between two halves round to the nearer (ties to the even one).
    #[test]
    fn half_floats_round_trip_and_round_to_the_nearest() {
        for bits in 0..0x7C00u16 {
            assert_eq!(f16_bits(f16_value(bits)), bits, "{bits:#06x}");
        }
        let one = f16_value(0x3C00);
        let next = f16_value(0x3C01);
        assert_eq!(f16_bits((one + next) / 2.0), 0x3C00, "a tie goes to the even half");
        assert_eq!(f16_bits(one + (next - one) * 0.75), 0x3C01);
        assert_eq!(f16_bits(1.0e9), 0x7BFF, "past the largest half: the largest");
        assert_eq!(f16_bits(-1.0), 0);
        assert_eq!(f16_bits(f32::NAN), 0);
        assert_eq!(f16_bits(1.0e-12), 0);
    }

    /// A batch without levels keeps everything; a level's batch keeps an instance only at the
    /// level its distance picks, and every instance is kept by exactly one of its mesh's batches.
    #[test]
    fn each_instance_is_kept_by_exactly_one_level_of_its_chain() {
        let errors = [0.01, 0.04, 0.16];
        let rows: Vec<[u32; 3]> = (0..=errors.len() as u32).map(|level| batch_lod(level, &errors, 1.0)).collect();
        let view = [0.0, 0.0, 0.0, 540.0 / libm::tanf(30.0f32.to_radians())];
        let mut seen = [0usize; 4];
        for step in 0..400 {
            let bounds = [0.0, 0.0, -(step as f32) * 0.5 - 0.1, 1.0];
            assert!(lod_keeps([0; 3], bounds, view), "no levels: always kept");
            let kept: Vec<usize> = rows.iter().enumerate().filter(|(_, row)| lod_keeps(**row, bounds, view)).map(|(level, _)| level).collect();
            assert_eq!(kept.len(), 1, "at {:?}: {kept:?}", bounds);
            seen[kept[0]] += 1;
        }
        assert!(seen.iter().all(|count| *count > 0), "every level is drawn somewhere: {seen:?}");
        let off = [0.0, 0.0, 0.0, 0.0];
        assert!(lod_keeps(rows[0], [0.0, 0.0, -500.0, 1.0], off) && !lod_keeps(rows[3], [0.0, 0.0, -500.0, 1.0], off), "levels off: the mesh itself");
    }
}
