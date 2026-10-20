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
//!
//! **The fade band (game systems LOD-01).** [`lod_band`] (WGSL `gx_lod_band`) widens the switch
//! into a stateless band: while a level's projected error is within the last `beta` of the
//! threshold it fades in and the finer level fades out, both within the threshold. A level's
//! batch gets a fade twin ([`fade_batch_lod`], [`LOD_FADE_TAG`]) and [`lod_band_keep`] keeps each
//! (instance, level) pair in exactly one of them, with the slot's signed fade value. A band of 0
//! is today's hard switch bit for bit. The cull keeps by [`lod_row_keep`] (LOD-03): the band
//! measured from the instance's LOD row (its origin and bias, LOD-02, [`crate::lod_rows`]).

use glam::{Mat3, Mat4};

/// The key of the LOD object in a glTF primitive's `extras` (never an extension).
pub const LODS_EXTRAS_KEY: &str = "genex_lods";
/// The `genex_lods` schema version this build reads; any other is ignored with a typed fault.
pub const LOD_SCHEMA_VERSION: u32 = 1;
/// Most levels past the primitive's own triangles (the WGSL select reads them as a `vec4`).
pub const LOD_MAX_LEVELS: u32 = 4;
/// The fewest triangles a GLB needs before the import step simplifies it.
pub const LOD_MIN_TRIANGLES: u32 = 512;
/// [`select_lod`] and [`lod_band`] in WGSL (`gx_lod_select`, `gx_lod_band`), for the cull to include.
pub const LOD_SELECT_WGSL: &str = include_str!("../shaders/geometry/lod_select.wgsl");
/// The error a drawn level may show, in output pixels.
pub const LOD_THRESHOLD_PX: f32 = 1.0;
/// The output height a plan's LOD view assumes until the renderer gives it its own
/// ([`crate::scene::FramePlan::set_lod_height`]).
pub const LOD_NOMINAL_HEIGHT: u32 = 1080;
/// The bit of a batch's LOD tag marking a batch that draws one level of a chain.
const LOD_TAG: u32 = 1 << 31;
/// The bit of a batch's LOD tag marking a fade batch: the twin of a level's batch that holds the
/// instances fading in or out of that level ([`fade_batch_lod`], [`lod_band_keep`]).
pub const LOD_FADE_TAG: u32 = 1 << 30;
/// The fade value of an instance drawn whole (the per-slot fade table's convention).
const WHOLE: f32 = 1.0;
/// A band's share is a whole number of these steps (`gx_lod_band` spells it out as 1024.0): exact
/// products decide it, so the CPU and every GPU agree ([`lod_band`]).
const LOD_FADE_STEPS: f32 = 1024.0;
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

/// The levels an instance draws under a fade band ([`lod_band`]): `level` is the one
/// [`select_lod`] picks (with the bias), drawn with `share` of its pixels. A share of 1 is the
/// level whole; below 1, level `level - 1` (finer, and within the threshold too) draws the
/// other `1 - share`, fading out while `level` fades in.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LodBand {
    /// The coarsest level within the threshold (0 the mesh itself).
    pub level: u32,
    /// Its share of the instance's pixels, in [0, 1].
    pub share: f32,
}

impl LodBand {
    /// The mesh itself, whole: the answer to every input that is not a usable band.
    pub const MESH: LodBand = LodBand { level: 0, share: WHOLE };
}

/// Whether `value` is above zero (false for NaN).
fn positive(value: f32) -> bool {
    value > 0.0
}

/// Whether a bias and a band can be used: a finite positive bias, a band in [0, 1].
fn band_inputs_usable(bias: f32, beta: f32) -> bool {
    positive(bias) && bias <= f32::MAX && (0.0..=1.0).contains(&beta)
}

/// The fade band (game systems LOD-01; kansei's stateless crossfade): the level [`select_lod`]
/// picks with each error scaled by `bias` (2 holds every level twice as far), and while its
/// projected error is within the last `beta` of the threshold (`(1 - beta) * threshold <
/// error_px <= threshold`), the share it draws, `(budget - error_px) / (beta * budget)` rounded
/// down to a 1024th, rising from 0 to 1 with distance. Both levels drawn in a band fit the
/// threshold, so a band costs overdraw, never a visible error. A `beta` of 0 is [`select_lod`]
/// bit for bit; a distance that is not positive, a bias that is not finite and positive or a band
/// outside [0, 1] (NaN included) draw the mesh itself whole. Every decision is a comparison of
/// correctly rounded two-operand products, the expressions those of `gx_lod_band`.
pub fn lod_band(errors: &[f32], distance: f32, pixels_per_unit: f32, threshold_px: f32, bias: f32, beta: f32) -> LodBand {
    if !positive(distance) || !band_inputs_usable(bias, beta) {
        return LodBand::MESH;
    }
    let budget = threshold_px * distance;
    // One two-operand product per error: a GPU compiler may hoist `pixels_per_unit * bias` out of
    // the loop (Metal does), so the twins both do. A bias of 1 leaves `error * pixels_per_unit`.
    let scale = pixels_per_unit * bias;
    let (mut level, mut fit) = (0, 0.0);
    for (at, error) in errors.iter().take(LOD_MAX_LEVELS as usize).enumerate() {
        let projected = error * scale;
        if projected <= budget {
            (level, fit) = (at as u32 + 1, projected);
        }
    }
    // An infinite budget (an infinite distance) leaves no band: the coarsest level is whole.
    let whole = level == 0 || budget > f32::MAX || fit <= (1.0 - beta) * budget;
    if whole {
        return LodBand { level, share: WHOLE };
    }
    let steps = band_steps(budget - fit, beta * budget);
    if steps >= LOD_FADE_STEPS {
        return LodBand { level, share: WHOLE };
    }
    LodBand { level, share: steps * (1.0 / LOD_FADE_STEPS) }
}

/// The share `fade / width` (both positive) in whole steps of `1 / LOD_FADE_STEPS`, rounded down:
/// the most steps with `steps * width <= fade * LOD_FADE_STEPS`, two correctly rounded products.
/// The division only guesses (a GPU's is not correctly rounded: Metal's fast math is a reciprocal
/// 1 ULP off), and the guess is within one step of the answer, which the comparisons then fix,
/// so every GPU lands on the CPU's step. `gx_lod_band` writes the same expressions.
fn band_steps(fade: f32, width: f32) -> f32 {
    let scaled = fade * LOD_FADE_STEPS;
    let mut steps = (fade / width * LOD_FADE_STEPS).floor().clamp(0.0, LOD_FADE_STEPS);
    let next = steps + 1.0;
    if steps < LOD_FADE_STEPS && next * width <= scaled {
        steps = next;
    }
    if steps > 0.0 && steps * width > scaled {
        steps -= 1.0;
    }
    steps
}

/// The LOD row of the fade twin of level `level`'s batch: [`batch_lod`] with [`LOD_FADE_TAG`].
pub fn fade_batch_lod(level: u32, errors: &[f32], radius: f32) -> [u32; 3] {
    let [tag, low, high] = batch_lod(level, errors, radius);
    [tag | LOD_FADE_TAG, low, high]
}

/// A chain's errors scaled by an instance's radius (its row's `bounds`), the chain's length and
/// the distance from the camera to the sphere `origin` its levels are measured from (the bounds
/// themselves unless its LOD row names another, game systems LOD-02): what [`lod_keeps`] and
/// [`lod_row_keep`] measure.
fn instance_chain(lod: [u32; 3], bounds: [f32; 4], origin: [f32; 4], view: [f32; 4]) -> ([f32; 4], usize, f32) {
    let levels = ((lod[0] >> LOD_LEVELS_SHIFT) & LOD_LEVEL_MASK).min(LOD_MAX_LEVELS) as usize;
    let halves = [lod[1] & 0xFFFF, lod[1] >> 16, lod[2] & 0xFFFF, lod[2] >> 16];
    let errors = halves.map(|bits| f16_value(bits as u16) * bounds[3]);
    let offset = [origin[0] - view[0], origin[1] - view[1], origin[2] - view[2]];
    let distance = (offset[0] * offset[0] + offset[1] * offset[1] + offset[2] * offset[2]).sqrt() - origin[3];
    (errors, levels, distance)
}

/// An instance's band from the camera; levels off (`view.w` not positive) or a radius that is
/// not positive draw the mesh itself whole.
fn instance_band(lod: [u32; 3], bounds: [f32; 4], origin: [f32; 4], view: [f32; 4], bias: f32, beta: f32) -> LodBand {
    if !positive(view[3]) || !positive(bounds[3]) {
        return LodBand::MESH;
    }
    let (errors, levels, distance) = instance_chain(lod, bounds, origin, view);
    lod_band(&errors[..levels], distance, view[3], 1.0, bias, beta)
}

/// [`lod_keeps`] under a fade band of `beta` with the row's `bias`: whether the cull keeps an
/// instance in a batch, and the fade value its slot gets (kansei's signed convention). A batch
/// without levels keeps every instance whole (1). A level's batch keeps the instances whole at
/// that level; its fade twin ([`LOD_FADE_TAG`]) keeps those fading in to it (`-share`: draw the
/// pixels whose dither threshold is at least `1 - share`) or out of it to the next coarser level
/// (`1 - share`: draw those below it), so each (instance, level) pair is kept by one batch and
/// every pixel by one of the two levels. Measured from the instance's own bounds
/// ([`lod_row_keep`] with them as the origin).
pub fn lod_band_keep(lod: [u32; 3], bounds: [f32; 4], view: [f32; 4], bias: f32, beta: f32) -> Option<f32> {
    lod_row_keep(lod, bounds, bounds, view, bias, beta)
}

/// [`lod_band_keep`] with the distance measured from the world sphere `origin` of the instance's
/// LOD row (game systems LOD-02: one sphere for every part of a compound model), its errors still
/// scaled by its own `bounds`' radius. The cull's keep rule (`gx_cull_lod_fade` in
/// `shaders/cull.wgsl`, expression for expression; game systems LOD-03).
pub fn lod_row_keep(lod: [u32; 3], bounds: [f32; 4], origin: [f32; 4], view: [f32; 4], bias: f32, beta: f32) -> Option<f32> {
    if lod[0] & LOD_TAG == 0 {
        return Some(WHOLE);
    }
    let level = lod[0] & LOD_LEVEL_MASK;
    let fade = lod[0] & LOD_FADE_TAG != 0;
    let band = instance_band(lod, bounds, origin, view, bias, beta);
    if band.share >= WHOLE {
        return (!fade && level == band.level).then_some(WHOLE);
    }
    if !fade {
        return None;
    }
    if level == band.level {
        return Some(-band.share);
    }
    (level + 1 == band.level).then_some(WHOLE - band.share)
}

/// [`lod_row_keep`] with the instance's far field (game systems LOD-18): whether the cull keeps
/// it in a batch, with its slot's `[fade, grow]`. A copy nearer than its far rule's start keeps
/// [`lod_row_keep`]'s answer, grow 1. A thinned one (past the start) is dropped by every whole
/// batch and drawn by its fade batches only: the level it is whole at with the far share as its
/// fade, or its two crossfading levels with their fades times the far share; a share of 0 drops
/// it everywhere. The cull's twin is `gx_cull_lod_fade` in `shaders/cull.wgsl`.
pub fn lod_row_keep_far(lod: [u32; 3], bounds: [f32; 4], origin: [f32; 4], view: [f32; 4], (bias, beta): (f32, f32), far: crate::lod_rows::FarField) -> Option<[f32; 2]> {
    if !far.thinned {
        return lod_row_keep(lod, bounds, origin, view, bias, beta).map(|fade| [fade, WHOLE]);
    }
    let fade_batch = lod[0] & LOD_TAG != 0 && lod[0] & LOD_FADE_TAG != 0;
    if !fade_batch || far.share.is_nan() || far.share <= 0.0 {
        return None;
    }
    let level = lod[0] & LOD_LEVEL_MASK;
    let band = instance_band(lod, bounds, origin, view, bias, beta);
    let fade = if band.share >= WHOLE {
        (level == band.level).then_some(far.share)
    } else if level == band.level {
        Some(-band.share * far.share)
    } else {
        (level + 1 == band.level).then_some((WHOLE - band.share) * far.share)
    };
    fade.map(|fade| [fade, far.grow])
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
/// [`select_lod`] gives that level, seen from the camera's distance to the bounding sphere, and a
/// fade batch ([`LOD_FADE_TAG`]) none (no band here: [`lod_band_keep`] with a band of 0, for a
/// positive radius). A6.9's keep rule, kept as the reference [`lod_row_keep`] with a band of 0
/// is held to (the cull keeps by [`lod_row_keep`] since LOD-03); unlike it, a radius that is not
/// positive here scales every error to 0 and picks the coarsest level.
pub fn lod_keeps(lod: [u32; 3], bounds: [f32; 4], view: [f32; 4]) -> bool {
    if lod[0] & LOD_TAG == 0 {
        return true;
    }
    // A fade batch draws only inside a band, and this rule has none (`lod_band_keep` does).
    if lod[0] & LOD_FADE_TAG != 0 {
        return false;
    }
    let level = lod[0] & LOD_LEVEL_MASK;
    // Not positive (NaN included): levels are off, as `!(lod.w > 0.0)` in the cull.
    if !positive(view[3]) {
        return level == 0;
    }
    let (errors, levels, distance) = instance_chain(lod, bounds, bounds, view);
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
