//! Foliage (renderer pass 2 A.8): GPU-generated grass blades on the terrain, swaying in the shared
//! wind and lit through the forward chunks with the light the sun sends through a blade.
//!
//! - **Where blades grow** ([`GrassLayer`]): a terrain layer may carry grass (`TerrainLayer::grass`),
//!   so a meadow grows wherever the control map paints a grassy layer, thinning where it blends into
//!   bare ground. Nothing is uploaded per blade: a blade is a pure function of its grid cell.
//! - **One candidate per cell** (after greggman/sedon's cell hashing and inkwell-webgpu-grass's
//!   two-level cull: ideas only, no code; rewritten for determinism): the world is cut into square cells
//!   ([`GrassGrid`]) of one blade at the quality's densest layer; every per-blade random (jitter,
//!   yaw, height, which layer, the keep threshold) is hashed from the cell's **global** index, so
//!   the field never swims as the camera moves. A camera-centred square of tiles of
//!   [`GRASS_TILE_SIDE`]² cells is generated every frame by one compute workgroup per tile:
//!   whole tiles past the radius or outside the camera's frustum are skipped, survivors are
//!   compacted by a workgroup prefix sum into the tile's own region (no atomics: the drawn list is
//!   a pure function of the camera, as every renderer cull is), one workgroup scans the tile counts,
//!   and a last pass packs the region indices for one indirect draw ([`plan`] is its CPU twin).
//! - **No pops**: a blade is kept while its hashed threshold is under the cell's probability (the
//!   layers' density times the cell's area times the quality's share times the distance falloff),
//!   and grows from nothing across [`GRASS_FADE_BAND`] of the cell's probability before the
//!   falloff, so as the camera moves blades rise and sink continuously instead of appearing (by the
//!   falloff's change over the band, the same near the camera and at the radius's end). Far blades thin out and widen to keep
//!   the cover ([`GrassQuality::radius`]).
//! - **The blade** (`shaders/foliage/grass_core.wgsl`; shape after jadedbay/bevy_procedural_grass's
//!   Bezier blade and 2Retr0/GodotGrass's rounded normals, ideas only, no code): a strip of
//!   [`GrassQuality::segments`] segments and a tip, bent by the shared wind ([`crate::wind`])
//!   evaluated at this frame's time and at last frame's, so the prepass writes the sway's own
//!   motion and TAA reprojects it. It draws in the prepass (AO, contact shadows, the sun mask and
//!   TAA see it), in the world pass with `Equal` depth like every built-in surface, and on desktop
//!   `high` and `ultra` into the nearest cascade.
//! - **Light through a blade** (diffuse transmission after Bevy 0.20 `pbr_functions.wesl`, the
//!   idea only): a second Lambert lobe about the back of the blade, shadowed by the same
//!   visibility as its front, so a low sun behind the meadow lights it gold.
//!
//! Grass adds no binding to the forward stage: it draws through its own pipelines over the forward
//! frame group, the pass view and its own group ([`gpu`]). Meshes a game instances (bushes, rocks,
//! flowers) are placed on the terrain by [`scatter`] with the same cell hashing.

/// The grass's GPU resources, compute passes and draws.
pub mod gpu;
/// Procedural scatter of instances on the terrain (A4.9): CPU, deterministic, at loading points.
pub mod scatter;

use crate::error::{RenderCode, RenderError};
use crate::terrain::TerrainDesc;

/// Cells per side of one generation tile: a tile is one 256-lane workgroup.
pub const GRASS_TILE_SIDE: u32 = 16;
/// Cells (blade candidates) per tile.
pub const GRASS_TILE_CELLS: u32 = GRASS_TILE_SIDE * GRASS_TILE_SIDE;
/// The most tiles across the generated square: 64 x 64 tiles, about a million candidates.
pub const GRASS_TILES_SIDE_MAX: u32 = 64;
/// The narrowest cell (metres): at most about 156 blades per square metre.
pub const GRASS_CELL_MIN: f32 = 0.08;
/// The widest cell (metres).
pub const GRASS_CELL_MAX: f32 = 2.0;
/// The share of a cell's probability (before the distance falloff) over which a kept blade grows
/// from nothing to its height.
pub const GRASS_FADE_BAND: f32 = 0.15;
/// Where the full density ends, as a share of the radius.
pub const GRASS_NEAR_SHARE: f32 = 0.3;
/// Where the far fade starts, as a share of the radius.
pub const GRASS_FAR_SHARE: f32 = 0.8;
/// The density kept at the far fade's start (blades are widened by its inverse square root).
pub const GRASS_FAR_DENSITY: f32 = 0.3;
/// The most segments a blade bends over (its strip has two vertices a segment and a tip).
pub const GRASS_SEGMENTS_MAX: u32 = 7;
/// The tallest blade (metres): the packed height's range.
pub const GRASS_HEIGHT_MAX: f32 = 2.0;
/// The widest blade at its root (metres).
pub const GRASS_WIDTH_MAX: f32 = 0.2;
/// How far a blade's root sinks under the terrain's bilinear height (metres), so a coarser drawn
/// level of the terrain never shows its foot.
pub const GRASS_ROOT_SINK: f32 = 0.03;
/// The budget ledger's label for the grass's buffers.
pub const GRASS_LEDGER_LABEL: &str = "grass";

/// The hash salts of a cell's randoms (one hash each).
mod salt {
    pub const JITTER_X: u32 = 0;
    pub const JITTER_Z: u32 = 1;
    pub const KEEP: u32 = 2;
    pub const YAW: u32 = 3;
    pub const TALL: u32 = 4;
    pub const LAYER: u32 = 5;
    pub const KIND: u32 = 6;
}

/// What grows on one terrain layer: blades per square metre and their shape and colours (linear).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GrassLayer {
    /// Blades per square metre where the layer covers the ground alone (0: none).
    pub density: f32,
    /// The shortest and tallest blade (metres, up to [`GRASS_HEIGHT_MAX`]).
    pub height: [f32; 2],
    /// The narrowest and widest blade at its root (metres, up to [`GRASS_WIDTH_MAX`]).
    pub width: [f32; 2],
    /// The colour at the blade's foot (linear).
    pub root: [f32; 3],
    /// The colour at its tip (linear).
    pub tip: [f32; 3],
    /// The tip colour of dry blades (linear).
    pub dry: [f32; 3],
    /// The share of blades with dry tips (0..1).
    pub dry_share: f32,
    /// The colour of a flower on a blade's tip (linear).
    pub flower: [f32; 3],
    /// The share of blades that flower (0..1).
    pub flower_share: f32,
    /// How much of the light reaching a blade's back passes through it (0..1).
    pub transmission: f32,
}

impl GrassLayer {
    /// A meadow of `density` blades per square metre, `height` metres tall at most, in
    /// green: a dark foot, a green tip, a fifth of the tips dry, no flowers.
    pub const fn meadow(density: f32, height: f32) -> GrassLayer {
        GrassLayer {
            density,
            height: [height * 0.35, height],
            width: [0.02, 0.04],
            root: [0.025, 0.05, 0.012],
            tip: [0.09, 0.16, 0.03],
            dry: [0.30, 0.22, 0.07],
            dry_share: 0.2,
            flower: [0.85, 0.80, 0.72],
            flower_share: 0.0,
            transmission: 0.6,
        }
    }

    /// Whether every number is usable: finite, the ranges ordered and within their caps.
    pub fn usable(&self) -> bool {
        let finite = [self.density, self.height[0], self.height[1], self.width[0], self.width[1], self.dry_share, self.flower_share, self.transmission]
            .iter()
            .chain(self.root.iter().chain(&self.tip).chain(&self.dry).chain(&self.flower))
            .all(|v| v.is_finite() && *v >= 0.0);
        let ordered = self.height[0] <= self.height[1] && self.width[0] <= self.width[1];
        let capped = self.height[1] <= GRASS_HEIGHT_MAX && self.width[1] <= GRASS_WIDTH_MAX && self.dry_share <= 1.0 && self.flower_share <= 1.0;
        finite && ordered && capped && self.transmission <= 1.0
    }
}

/// How a quality draws grass. A resource knob: it changes uniforms and buffer sizes, never a
/// pipeline.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GrassQuality {
    /// The share of the layers' density drawn near the camera (0: no grass).
    pub density: f32,
    /// How far from the camera blades grow (metres).
    pub radius: f32,
    /// Segments a blade bends over (0: no grass; at most [`GRASS_SEGMENTS_MAX`]).
    pub segments: u32,
    /// Whether blades cast into the nearest sun cascade.
    pub casts: bool,
}

impl GrassQuality {
    /// No grass (the legacy renderer, `low`, the low phones).
    pub const OFF: GrassQuality = GrassQuality { density: 0.0, radius: 0.0, segments: 0, casts: false };
    /// Desktop and web `medium`: three in five blades, 32 m, three segments, no casting.
    pub const MEDIUM: GrassQuality = GrassQuality { density: 0.6, radius: 32.0, segments: 3, casts: false };
    /// Desktop and web `high`: every blade, 44 m, five segments, casting into the nearest cascade.
    pub const HIGH: GrassQuality = GrassQuality { density: 1.0, radius: 44.0, segments: 5, casts: true };
    /// Desktop and web `ultra`: every blade, 60 m, six segments, casting.
    pub const ULTRA: GrassQuality = GrassQuality { density: 1.0, radius: 60.0, segments: 6, casts: true };
    /// The high phones at `high` and `ultra`: a capped density (a third of the blades, 22 m, three
    /// segments, no casting): alpha-free geometry, but overdraw is a tile GPU's cost.
    pub const MOBILE: GrassQuality = GrassQuality { density: 0.35, radius: 22.0, segments: 3, casts: false };

    /// Whether this quality draws grass.
    pub fn drawn(&self) -> bool {
        self.density > 0.0 && self.radius > 0.0 && self.segments > 0
    }

    /// The strip's vertices per blade: two a segment and the tip.
    pub fn blade_vertices(&self) -> u32 {
        2 * self.segments.min(GRASS_SEGMENTS_MAX) + 1
    }
}

/// The densest grass `desc` grows (blades per square metre), 0 without grass.
pub fn densest(desc: &TerrainDesc) -> f32 {
    desc.layers.iter().filter_map(|layer| layer.grass).map(|grass| grass.density).fold(0.0, f32::max)
}

/// Refuse grass a terrain cannot grow (`mesh-invalid`): a layer's numbers out of range.
pub fn check(desc: &TerrainDesc) -> Result<(), RenderError> {
    match desc.layers.iter().position(|layer| layer.grass.is_some_and(|grass| !grass.usable())) {
        Some(bad) => Err(RenderError::refused(RenderCode::MeshInvalid, format!("terrain layer {bad}: grass out of range"))),
        None => Ok(()),
    }
}

/// The cell grid a frame generates: the cell size, the first cell of the camera-centred square and
/// its tiles a side.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GrassGrid {
    /// The cell's side (metres), as f32 bits (so the grid is `Eq`).
    pub cell_bits: u32,
    /// The global index of the square's first cell (x, z).
    pub origin: [i32; 2],
    /// Tiles a side of the square.
    pub tiles: u32,
}

impl GrassGrid {
    /// The cell's side in metres.
    pub fn cell(&self) -> f32 {
        f32::from_bits(self.cell_bits)
    }

    /// Tiles in the square.
    pub fn tile_count(&self) -> u32 {
        self.tiles * self.tiles
    }
}

/// The cell side for the densest grass `densest` (blades per square metre) at `quality`: one
/// candidate per blade at the densest layer, widened until the square of tiles over the quality's
/// radius fits [`GRASS_TILES_SIDE_MAX`].
pub fn cell_side(densest: f32, quality: &GrassQuality) -> f32 {
    let blades = (densest * quality.density).max(1e-6);
    let mut cell = (1.0 / blades.sqrt()).clamp(GRASS_CELL_MIN, GRASS_CELL_MAX);
    let span = 2.0 * quality.radius;
    let fits = |cell: f32| tiles_across(span, cell) <= GRASS_TILES_SIDE_MAX;
    while !fits(cell) && cell < GRASS_CELL_MAX {
        cell = (cell * 1.125).min(GRASS_CELL_MAX);
    }
    cell
}

/// Tiles across a square `span` metres wide of `cell`-metre cells (one more, as the square is
/// snapped to whole tiles).
fn tiles_across(span: f32, cell: f32) -> u32 {
    let tile = cell * GRASS_TILE_SIDE as f32;
    (span / tile).ceil() as u32 + 1
}

/// The grid a camera at `camera` generates for `densest` grass at `quality`: a square of whole
/// tiles around the camera, its first cell a multiple of the tile side (so tiles hold the same
/// cells wherever the camera is).
pub fn grid(densest: f32, quality: &GrassQuality, camera: [f32; 3]) -> GrassGrid {
    let cell = cell_side(densest, quality);
    let tiles = tiles_across(2.0 * quality.radius, cell).min(GRASS_TILES_SIDE_MAX);
    let side = GRASS_TILE_SIDE as i32;
    let half = (tiles as i32 * side) / 2;
    let first = |at: f32| {
        let centre = libm::floorf(at / cell) as i32;
        (centre - half).div_euclid(side) * side
    };
    GrassGrid { cell_bits: cell.to_bits(), origin: [first(camera[0]), first(camera[2])], tiles }
}

/// lowbias32 (Chris Wellons, public domain) over a cell and a salt: the same bits on every GPU.
pub fn hash(x: i32, z: i32, salt: u32) -> u32 {
    let mut h = (x as u32).wrapping_mul(0x8da6_b343) ^ (z as u32).wrapping_mul(0xd816_3841) ^ salt.wrapping_mul(0xcb1a_b31f);
    h ^= h >> 16;
    h = h.wrapping_mul(0x7feb_352d);
    h ^= h >> 15;
    h = h.wrapping_mul(0x846c_a68b);
    h ^= h >> 16;
    h
}

/// A cell's random in 0..1 for `salt` (24 bits, exact in f32).
pub fn unit(x: i32, z: i32, salt: u32) -> f32 {
    (hash(x, z, salt) >> 8) as f32 / 16_777_216.0
}

/// How much of the near density survives at `distance` from the camera within `radius`: 1 up to
/// [`GRASS_NEAR_SHARE`] of the radius, down to [`GRASS_FAR_DENSITY`] at [`GRASS_FAR_SHARE`],
/// then to 0 at the radius. Continuous, so a moving camera never pops a blade.
pub fn distance_share(distance: f32, radius: f32) -> f32 {
    let t = distance / radius.max(1e-3);
    if t <= GRASS_NEAR_SHARE {
        return 1.0;
    }
    if t <= GRASS_FAR_SHARE {
        let k = (t - GRASS_NEAR_SHARE) / (GRASS_FAR_SHARE - GRASS_NEAR_SHARE);
        return 1.0 + (GRASS_FAR_DENSITY - 1.0) * k;
    }
    let k = ((t - GRASS_FAR_SHARE) / (1.0 - GRASS_FAR_SHARE)).min(1.0);
    GRASS_FAR_DENSITY * (1.0 - k)
}

/// The kinds a blade's tip comes in.
pub mod kind {
    /// A green tip.
    pub const GREEN: u32 = 0;
    /// A dry tip.
    pub const DRY: u32 = 1;
    /// A flower on the tip.
    pub const FLOWER: u32 = 2;
}

/// One kept blade: its root, yaw, faded height and width scale, layer and kind (the record the
/// compute pass writes, [`Blade::pack`]).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Blade {
    /// The root (world), sunk [`GRASS_ROOT_SINK`] under the ground.
    pub root: [f32; 3],
    /// 0..255: the yaw in 256ths of a turn.
    pub yaw: u32,
    /// The terrain layer it grows from.
    pub layer: u32,
    /// [`kind`].
    pub kind: u32,
    /// 0..63: how far the blade has grown in (63 whole).
    pub grown: u32,
    /// 0..4095: its height in 4095ths of [`GRASS_HEIGHT_MAX`].
    pub height: u32,
}

impl Blade {
    /// The 16-byte record: root xyz as f32 bits, then yaw (8 bits), layer (4), kind (2), grown (6)
    /// and height (12).
    pub fn pack(&self) -> [u32; 4] {
        let packed = self.yaw | (self.layer << 8) | (self.kind << 12) | (self.grown << 14) | (self.height << 20);
        [self.root[0].to_bits(), self.root[1].to_bits(), self.root[2].to_bits(), packed]
    }
}

/// The grass of one terrain as the generation reads it: each layer's grass (None: bare).
pub struct GrassField<'a> {
    desc: &'a TerrainDesc,
    words: Vec<u32>,
}

impl<'a> GrassField<'a> {
    /// The field of `desc`.
    pub fn new(desc: &'a TerrainDesc) -> GrassField<'a> {
        GrassField { desc, words: desc.control_words() }
    }

    /// The control word of sample (x, z), clamped onto the grid.
    fn word(&self, x: u32, z: u32) -> u32 {
        let (w, d) = self.desc.heights.samples();
        self.words[(z.min(d - 1) * w + x.min(w - 1)) as usize]
    }

    /// The layer density of `layer` (0 for a bare layer or one past the terrain's).
    fn density(&self, layer: u32) -> f32 {
        self.desc.layers.get(layer as usize).and_then(|layer| layer.grass).map_or(0.0, |grass| grass.density)
    }

    /// The weighted layers at world (`x`, `z`): the four control texels around it, each texel's base
    /// and overlay, as (layer, weight) in a fixed order (the GPU's `gx_grass_layers`).
    pub fn layers_at(&self, x: f32, z: f32) -> [(u32, f32); 8] {
        let heights = &self.desc.heights;
        let (w, d) = heights.samples();
        let origin = heights.origin();
        let px = ((x - origin[0]) / heights.spacing()).clamp(0.0, (w - 1) as f32);
        let pz = ((z - origin[1]) / heights.spacing()).clamp(0.0, (d - 1) as f32);
        let (cx, cz) = (libm::floorf(px), libm::floorf(pz));
        let (fx, fz) = (px - cx, pz - cz);
        let (ix, iz) = (cx as u32, cz as u32);
        let layers = self.desc.layers.len().max(1) as u32;
        let mut out = [(0, 0.0); 8];
        for c in 0..4u32 {
            let (ox, oz) = (c & 1, c >> 1);
            let word = self.word(ix + ox, iz + oz);
            let ax = if ox == 1 { fx } else { 1.0 - fx };
            let az = if oz == 1 { fz } else { 1.0 - fz };
            let weight = ax * az;
            let overlay = ((word >> 10) & 0xff) as f32 / 255.0;
            out[(2 * c) as usize] = ((word & 31).min(layers - 1), weight * (1.0 - overlay));
            out[(2 * c + 1) as usize] = (((word >> 5) & 31).min(layers - 1), weight * overlay);
        }
        out
    }

    /// The blades per square metre at world (`x`, `z`) and the layer a hashed `pick` (0..1) of
    /// them grows from.
    pub fn density_at(&self, x: f32, z: f32, pick: f32) -> (f32, u32) {
        let layers = self.layers_at(x, z);
        let total: f32 = layers.iter().map(|(layer, weight)| weight * self.density(*layer)).sum();
        let target = pick * total;
        let mut run = 0.0;
        let mut chosen = layers[0].0;
        for (layer, weight) in layers {
            let share = weight * self.density(layer);
            if share <= 0.0 {
                continue;
            }
            chosen = layer;
            run += share;
            if target < run {
                break;
            }
        }
        (total, chosen)
    }

    /// The blade of global cell (`x`, `z`) on `grid` at `quality` for a camera at `camera`, or None
    /// where none grows (off the terrain, past the radius, bare ground, its threshold above the
    /// cell's probability). The compute pass's CPU twin, frustum aside.
    pub fn blade(&self, grid: &GrassGrid, quality: &GrassQuality, camera: [f32; 3], (x, z): (i32, i32)) -> Option<Blade> {
        let cell = grid.cell();
        let wx = (x as f32 + unit(x, z, salt::JITTER_X)) * cell;
        let wz = (z as f32 + unit(x, z, salt::JITTER_Z)) * cell;
        let heights = &self.desc.heights;
        let (w, d) = heights.samples();
        let origin = heights.origin();
        let span = [(w - 1) as f32 * heights.spacing(), (d - 1) as f32 * heights.spacing()];
        let inside = wx >= origin[0] && wz >= origin[1] && wx <= origin[0] + span[0] && wz <= origin[1] + span[1];
        if !inside {
            return None;
        }
        let ground = heights.height(wx, wz);
        let (dx, dy, dz) = (wx - camera[0], ground - camera[1], wz - camera[2]);
        let distance = libm::sqrtf(dx * dx + dy * dy + dz * dz);
        let (density, layer) = self.density_at(wx, wz, unit(x, z, salt::LAYER));
        let base = density * cell * cell * quality.density;
        let probability = (base * distance_share(distance, quality.radius)).min(1.0);
        let threshold = unit(x, z, salt::KEEP);
        if threshold >= probability {
            return None;
        }
        let grown = ((probability - threshold) / (GRASS_FADE_BAND * base.max(1e-6))).min(1.0);
        let grass = self.desc.layers[layer as usize].grass?;
        let tall = unit(x, z, salt::TALL);
        let full = grass.height[0] + (grass.height[1] - grass.height[0]) * tall;
        let height = ((full * grown / GRASS_HEIGHT_MAX).min(1.0) * 4095.0 + 0.5) as u32;
        let roll = unit(x, z, salt::KIND);
        let kind = if roll < grass.flower_share {
            kind::FLOWER
        } else if roll < grass.flower_share + grass.dry_share {
            kind::DRY
        } else {
            kind::GREEN
        };
        Some(Blade {
            root: [wx, ground - GRASS_ROOT_SINK, wz],
            yaw: hash(x, z, salt::YAW) >> 24,
            layer,
            kind,
            grown: (grown * 63.0 + 0.5) as u32,
            height,
        })
    }
}

/// A sphere of `radius` at `p` against inward `planes` (the cull's test).
fn sphere_in(planes: &[[f32; 4]; 6], p: [f32; 3], radius: f32) -> bool {
    planes.iter().all(|plane| plane[0] * p[0] + plane[1] * p[1] + plane[2] * p[2] + plane[3] >= -radius)
}

/// Whether tile (`tx`, `tz`) of `grid` may hold a drawn blade: its box (the terrain's height range
/// plus the tallest blade) within the radius and the camera's frustum.
pub fn tile_visible(grid: &GrassGrid, quality: &GrassQuality, camera: [f32; 3], planes: &[[f32; 4]; 6], heights: [f32; 2], (tx, tz): (u32, u32)) -> bool {
    let cell = grid.cell();
    let tile = cell * GRASS_TILE_SIDE as f32;
    let min = [(grid.origin[0] as f32) * cell + tx as f32 * tile, (grid.origin[1] as f32) * cell + tz as f32 * tile];
    let low = heights[0] - GRASS_ROOT_SINK;
    let high = heights[1] + GRASS_HEIGHT_MAX;
    let centre = [min[0] + tile * 0.5, (low + high) * 0.5, min[1] + tile * 0.5];
    let half = [tile * 0.5, (high - low) * 0.5, tile * 0.5];
    let nearest = [(camera[0] - centre[0]).abs() - half[0], (camera[2] - centre[2]).abs() - half[2]];
    let (ax, az) = (nearest[0].max(0.0), nearest[1].max(0.0));
    let reach = libm::sqrtf(ax * ax + az * az);
    if reach > quality.radius {
        return false;
    }
    planes.iter().all(|plane| {
        let extent = plane[0].abs() * half[0] + plane[1].abs() * half[1] + plane[2].abs() * half[2];
        plane[0] * centre[0] + plane[1] * centre[1] + plane[2] * centre[2] + plane[3] >= -extent
    })
}

/// One frame's generated grass, the compute passes' CPU twin: each tile's kept blades in cell
/// order (rows of cells, x fastest), tiles in row order.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct GrassPlan {
    /// Each drawn blade: its tile and its slot in the tile's region, then the blade.
    pub blades: Vec<(u32, u32, Blade)>,
    /// Tiles the cull kept.
    pub tiles_drawn: u32,
}

/// The CPU twin of a frame's generation over `field` for a camera at `camera` with frustum
/// `planes`: what the GPU's packed list holds, in its order.
pub fn plan(field: &GrassField<'_>, quality: &GrassQuality, camera: [f32; 3], planes: &[[f32; 4]; 6]) -> GrassPlan {
    let mut out = GrassPlan::default();
    if !quality.drawn() {
        return out;
    }
    let densest = densest(field.desc);
    if densest <= 0.0 {
        return out;
    }
    let grid = grid(densest, quality, camera);
    let (min, step) = field.desc.heights.quantization();
    let range = [min, min + 65535.0 * step];
    for tz in 0..grid.tiles {
        for tx in 0..grid.tiles {
            if !tile_visible(&grid, quality, camera, planes, range, (tx, tz)) {
                continue;
            }
            out.tiles_drawn += 1;
            let tile = tz * grid.tiles + tx;
            let mut slot = 0;
            for lane in 0..GRASS_TILE_CELLS {
                let x = grid.origin[0] + (tx * GRASS_TILE_SIDE + lane % GRASS_TILE_SIDE) as i32;
                let z = grid.origin[1] + (tz * GRASS_TILE_SIDE + lane / GRASS_TILE_SIDE) as i32;
                let Some(blade) = field.blade(&grid, quality, camera, (x, z)) else { continue };
                let tall = blade.height as f32 / 4095.0 * GRASS_HEIGHT_MAX;
                if !sphere_in(planes, [blade.root[0], blade.root[1] + tall * 0.5, blade.root[2]], tall * 0.5 + GRASS_WIDTH_MAX) {
                    continue;
                }
                out.blades.push((tile, slot, blade));
                slot += 1;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_distance_share_is_continuous_and_ends_at_the_radius() {
        let radius = 40.0;
        let mut last = distance_share(0.0, radius);
        assert_eq!(last, 1.0);
        for k in 1..=4000 {
            let share = distance_share(k as f32 * 0.0125, radius);
            assert!((share - last).abs() < 0.002, "a step of {} at {} m", share - last, k as f32 * 0.0125);
            assert!(share <= last, "never grows with distance");
            last = share;
        }
        assert_eq!(distance_share(radius, radius), 0.0);
        assert_eq!(distance_share(radius * 2.0, radius), 0.0);
    }

    #[test]
    fn a_blade_packs_into_its_record() {
        let blade = Blade { root: [1.5, -2.0, 3.25], yaw: 255, layer: 15, kind: kind::FLOWER, grown: 63, height: 4095 };
        let [x, y, z, w] = blade.pack();
        assert_eq!([f32::from_bits(x), f32::from_bits(y), f32::from_bits(z)], blade.root);
        assert_eq!((w & 0xff, (w >> 8) & 15, (w >> 12) & 3, (w >> 14) & 63, w >> 20), (255, 15, 2, 63, 4095));
    }

    #[test]
    fn the_grid_keeps_its_cells_where_the_camera_moves() {
        let quality = GrassQuality::HIGH;
        let a = grid(40.0, &quality, [0.3, 1.0, -2.0]);
        let b = grid(40.0, &quality, [6.9, 1.0, -2.0]);
        assert_eq!(a.cell_bits, b.cell_bits);
        let side = GRASS_TILE_SIDE as i32;
        assert_eq!((a.origin[0] % side, b.origin[0] % side), (0, 0), "tiles start on whole tiles");
        assert!(a.tiles <= GRASS_TILES_SIDE_MAX);
        let span = a.tiles as f32 * GRASS_TILE_SIDE as f32 * a.cell();
        assert!(span >= 2.0 * quality.radius, "the square covers the radius: {span} m");
    }

    #[test]
    fn the_cell_widens_until_the_square_fits() {
        let quality = GrassQuality { radius: 200.0, ..GrassQuality::ULTRA };
        let cell = cell_side(150.0, &quality);
        assert!(tiles_across(400.0, cell) <= GRASS_TILES_SIDE_MAX, "{cell}");
        assert_eq!(cell_side(1.0, &GrassQuality::HIGH), 1.0, "a sparse layer keeps a metre a blade");
    }
}
