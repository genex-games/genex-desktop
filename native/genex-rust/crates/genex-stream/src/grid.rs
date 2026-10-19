//! The cell grid and the wanted sets: sim, prefetch, view and detail radii with hysteresis.
//!
//! The world is a square of side `2 * STREAM_WORLD_EXTENT_MAX` around the origin, cut into square
//! cells anchored at world (0, 0) (genex-core's [`CellId`], ordered by `x`, then `z`: the canonical
//! order). A point is inside the world when `-extent <= x < extent` and the same for `z`.
//!
//! The sim set is a pure function of the anchor cells, the radii and the previous sim set: a cell
//! enters when it is within `radius` cells of an anchor (Chebyshev distance, so the set around one
//! anchor is a `(2r + 1)²` square) and leaves only once it is farther than `radius + hysteresis`
//! from every anchor, so an anchor walking along a cell border does not flap. Cells outside the
//! world are never wanted. A diff lists entered cells ascending and left cells descending, the
//! order the commit slot processes them in. The view set is display state: cells whose nearest
//! point is within the view radius of the camera, split at the detail radius.
//!
//! Ideas from Minecraft's simulation distance versus render distance and Unreal's World Partition
//! loading ranges (both proprietary; no code). Everything here is integer cell math, plus one
//! `floor` of an IEEE division per point, so it gives the same cells on every destination.

use std::collections::BTreeSet;

use genex_core::cell::CellId;
use glam::Vec2;

use crate::error::{StreamError, StreamErrorCode};

/// The smallest cell side, in metres.
pub const STREAM_CELL_SIZE_MIN: f32 = 8.0;
/// The largest cell side, in metres.
pub const STREAM_CELL_SIZE_MAX: f32 = 1024.0;
/// The largest sim radius, in cells.
pub const STREAM_SIM_RADIUS_MAX: u32 = 8;
/// The widest hysteresis or prefetch ring, in cells (each).
pub const STREAM_RING_MAX: u32 = 4;
/// The most anchors a sim set follows at once.
pub const STREAM_ANCHORS_MAX: usize = 8;
/// How far from the origin an anchor may stand on either axis, in metres (f32 keeps about 1 mm at
/// 8 km; a floating origin is later work).
pub const STREAM_WORLD_EXTENT_MAX: f32 = 8192.0;
/// The largest view radius, in cells of the grid.
pub const STREAM_VIEW_CELLS_MAX: u32 = 64;

/// A world grid of square cells: the cell side and the range of cells inside the world.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Grid {
    cell_size: f32,
    lo: i32,
    hi: i32,
}

impl Grid {
    /// A grid of `cell_size`-metre cells, within
    /// [`STREAM_CELL_SIZE_MIN`]..=[`STREAM_CELL_SIZE_MAX`]; others (NaN among them) refuse
    /// `stream-invalid`.
    pub fn new(cell_size: f32) -> Result<Grid, StreamError> {
        if !(STREAM_CELL_SIZE_MIN..=STREAM_CELL_SIZE_MAX).contains(&cell_size) {
            return Err(StreamError::new(
                StreamErrorCode::Invalid,
                format!("cell size {cell_size} m is outside {STREAM_CELL_SIZE_MIN}..={STREAM_CELL_SIZE_MAX}"),
            ));
        }
        let lo = (-STREAM_WORLD_EXTENT_MAX / cell_size).floor() as i32;
        let hi = (STREAM_WORLD_EXTENT_MAX / cell_size).ceil() as i32 - 1;
        Ok(Grid { cell_size, lo, hi })
    }

    /// The cell side, in metres.
    pub fn cell_size(&self) -> f32 {
        self.cell_size
    }

    /// The first and last cells inside the world (both inclusive, on both axes).
    pub fn world_cells(&self) -> (CellId, CellId) {
        (CellId::new(self.lo, self.lo), CellId::new(self.hi, self.hi))
    }

    /// Whether `cell` is inside the world.
    pub fn contains(&self, cell: CellId) -> bool {
        (self.lo..=self.hi).contains(&cell.x) && (self.lo..=self.hi).contains(&cell.z)
    }

    /// The cell holding the ground point `at` (world x, world z). A point that is not finite
    /// refuses `stream-invalid`; one outside the world refuses `stream-out-of-world`.
    pub fn cell_of(&self, at: Vec2) -> Result<CellId, StreamError> {
        if !at.is_finite() {
            return Err(StreamError::new(StreamErrorCode::Invalid, format!("anchor ({}, {}) is not finite", at.x, at.y)));
        }
        let inside = |v: f32| (-STREAM_WORLD_EXTENT_MAX..STREAM_WORLD_EXTENT_MAX).contains(&v);
        if !(inside(at.x) && inside(at.y)) {
            return Err(StreamError::new(
                StreamErrorCode::OutOfWorld,
                format!("anchor ({}, {}) is past the world extent {STREAM_WORLD_EXTENT_MAX} m", at.x, at.y),
            ));
        }
        Ok(self.cell_unchecked(at))
    }

    /// The cell's corners (min, max) in metres, as (x, z).
    pub fn bounds(&self, cell: CellId) -> (Vec2, Vec2) {
        let min = Vec2::new(cell.x as f32 * self.cell_size, cell.z as f32 * self.cell_size);
        (min, min + Vec2::splat(self.cell_size))
    }

    /// The cell holding a finite point, clamped to the range an `i32` holds.
    fn cell_unchecked(&self, at: Vec2) -> CellId {
        CellId::new((at.x / self.cell_size).floor() as i32, (at.y / self.cell_size).floor() as i32)
    }

    /// Refuses an anchor cell outside the world.
    fn check_anchor(&self, anchor: CellId) -> Result<(), StreamError> {
        if self.contains(anchor) {
            return Ok(());
        }
        Err(StreamError::new(
            StreamErrorCode::OutOfWorld,
            format!("anchor cell ({}, {}) is outside the world cells {}..={}", anchor.x, anchor.z, self.lo, self.hi),
        ))
    }

    /// The cells of the square of `reach` cells around `centre`, cut to the world, ascending.
    fn square(&self, centre: CellId, reach: u32) -> impl Iterator<Item = CellId> + use<> {
        let reach = i64::from(reach);
        let clip = |v: i32, d: i64| (i64::from(v) + d).clamp(i64::from(self.lo), i64::from(self.hi)) as i32;
        let (x0, x1, z0, z1) = (clip(centre.x, -reach), clip(centre.x, reach), clip(centre.z, -reach), clip(centre.z, reach));
        (x0..=x1).flat_map(move |x| (z0..=z1).map(move |z| CellId::new(x, z)))
    }
}

/// The sim radii, in cells.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SimRadii {
    /// Cells within this many cells of an anchor are simulated (at most
    /// [`STREAM_SIM_RADIUS_MAX`]).
    pub radius: u32,
    /// A cell leaves the sim set only past `radius + hysteresis` (at most [`STREAM_RING_MAX`]).
    pub hysteresis: u32,
    /// The ring past `radius` built ahead so a commit rarely waits (at most [`STREAM_RING_MAX`]).
    pub prefetch: u32,
}

impl SimRadii {
    /// Refuses radii over their caps with `stream-invalid`.
    pub fn check(&self) -> Result<(), StreamError> {
        let fits = self.radius <= STREAM_SIM_RADIUS_MAX && self.hysteresis <= STREAM_RING_MAX && self.prefetch <= STREAM_RING_MAX;
        if fits {
            return Ok(());
        }
        Err(StreamError::new(
            StreamErrorCode::Invalid,
            format!(
                "radius {} (max {STREAM_SIM_RADIUS_MAX}), hysteresis {} and prefetch {} (max {STREAM_RING_MAX} each)",
                self.radius, self.hysteresis, self.prefetch
            ),
        ))
    }
}

impl Default for SimRadii {
    /// Sim radius 1, hysteresis 1, prefetch 1.
    fn default() -> SimRadii {
        SimRadii { radius: 1, hysteresis: 1, prefetch: 1 }
    }
}

/// Refuses radii over their caps, too many anchors or an anchor outside the world.
fn check_inputs(grid: &Grid, anchors: &[CellId], radii: SimRadii) -> Result<(), StreamError> {
    radii.check()?;
    if anchors.len() > STREAM_ANCHORS_MAX {
        return Err(StreamError::new(
            StreamErrorCode::TooManyAnchors,
            format!("{} anchors (max {STREAM_ANCHORS_MAX})", anchors.len()),
        ));
    }
    anchors.iter().try_for_each(|anchor| grid.check_anchor(*anchor))
}

/// Chebyshev distance in cells from `cell` to its nearest anchor (`u64::MAX` with none).
fn nearest_anchor(anchors: &[CellId], cell: CellId) -> u64 {
    let axis = |a: i32, b: i32| (i64::from(a) - i64::from(b)).unsigned_abs();
    anchors.iter().map(|a| axis(a.x, cell.x).max(axis(a.z, cell.z))).min().unwrap_or(u64::MAX)
}

/// The cells within `reach` of any anchor, inside the world.
fn within(grid: &Grid, anchors: &[CellId], reach: u32) -> BTreeSet<CellId> {
    anchors.iter().flat_map(|anchor| grid.square(*anchor, reach)).collect()
}

/// The sim set after `previous`: every world cell within `radii.radius` of an anchor, plus every
/// cell of `previous` still within `radii.radius + radii.hysteresis` of one. Refuses radii over
/// their caps (`stream-invalid`), more than [`STREAM_ANCHORS_MAX`] anchors
/// (`stream-too-many-anchors`) and an anchor outside the world (`stream-out-of-world`).
pub fn wanted_sim(grid: &Grid, anchors: &[CellId], radii: SimRadii, previous: &BTreeSet<CellId>) -> Result<BTreeSet<CellId>, StreamError> {
    check_inputs(grid, anchors, radii)?;
    let keep = u64::from(radii.radius + radii.hysteresis);
    let mut wanted = within(grid, anchors, radii.radius);
    wanted.extend(previous.iter().filter(|cell| grid.contains(**cell) && nearest_anchor(anchors, **cell) <= keep));
    Ok(wanted)
}

/// The cells to build ahead: within `radii.radius + radii.prefetch` of an anchor, inside the world
/// and not in `active`, ascending. Refuses as [`wanted_sim`] does.
pub fn prefetch_ring(grid: &Grid, anchors: &[CellId], radii: SimRadii, active: &BTreeSet<CellId>) -> Result<Vec<CellId>, StreamError> {
    check_inputs(grid, anchors, radii)?;
    Ok(within(grid, anchors, radii.radius + radii.prefetch).difference(active).copied().collect())
}

/// What changed between two sets: entered cells ascending, left cells descending.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CellDiff {
    /// Cells in the new set and not the old, ascending.
    pub entered: Vec<CellId>,
    /// Cells in the old set and not the new, descending.
    pub left: Vec<CellId>,
}

/// The diff from `previous` to `next`, in canonical order.
pub fn diff(previous: &BTreeSet<CellId>, next: &BTreeSet<CellId>) -> CellDiff {
    let mut left: Vec<CellId> = previous.difference(next).copied().collect();
    left.reverse();
    CellDiff { entered: next.difference(previous).copied().collect(), left }
}

/// A sim set that follows its anchors: [`wanted_sim`] against the set it holds, and the diff.
#[derive(Clone, Debug, PartialEq)]
pub struct SimCells {
    grid: Grid,
    radii: SimRadii,
    active: BTreeSet<CellId>,
}

impl SimCells {
    /// An empty sim set on `grid`; radii over their caps refuse `stream-invalid`.
    pub fn new(grid: Grid, radii: SimRadii) -> Result<SimCells, StreamError> {
        radii.check()?;
        Ok(SimCells { grid, radii, active: BTreeSet::new() })
    }

    /// The grid.
    pub fn grid(&self) -> &Grid {
        &self.grid
    }

    /// The radii.
    pub fn radii(&self) -> SimRadii {
        self.radii
    }

    /// The active cells, ascending.
    pub fn active(&self) -> &BTreeSet<CellId> {
        &self.active
    }

    /// Moves the set to the anchors and returns what entered and left. A refusal (as
    /// [`wanted_sim`]) changes nothing.
    pub fn update(&mut self, anchors: &[CellId]) -> Result<CellDiff, StreamError> {
        let next = wanted_sim(&self.grid, anchors, self.radii, &self.active)?;
        let moved = diff(&self.active, &next);
        self.active = next;
        Ok(moved)
    }

    /// The cells to build ahead of the current set (see [`prefetch_ring`]).
    pub fn prefetch(&self, anchors: &[CellId]) -> Result<Vec<CellId>, StreamError> {
        prefetch_ring(&self.grid, anchors, self.radii, &self.active)
    }

    /// Empties the set (a reset); every active cell is returned as left, descending.
    pub fn clear(&mut self) -> CellDiff {
        let moved = diff(&self.active, &BTreeSet::new());
        self.active.clear();
        moved
    }
}

/// The view set of one camera: cells drawn at full detail and cells drawn past the detail radius
/// (their HLOD), each ascending. Display state only.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ViewCells {
    /// Cells whose nearest point is within the detail radius.
    pub detail: Vec<CellId>,
    /// Cells past the detail radius and within the view radius.
    pub far: Vec<CellId>,
}

/// The world cells within `radius` metres of the ground point `camera` (by each cell's nearest
/// point), split at `detail` metres. The camera may stand outside the world; refuses
/// `stream-invalid` for a camera or radius that is not finite, a negative radius, a detail radius
/// past the view radius, or a view radius past [`STREAM_VIEW_CELLS_MAX`] cells.
pub fn view_cells(grid: &Grid, camera: Vec2, radius: f32, detail: f32) -> Result<ViewCells, StreamError> {
    let cap = grid.cell_size * STREAM_VIEW_CELLS_MAX as f32;
    let valid = camera.is_finite() && (0.0..=cap).contains(&radius) && (0.0..=radius).contains(&detail);
    if !valid {
        return Err(StreamError::new(
            StreamErrorCode::Invalid,
            format!("view of ({}, {}) radius {radius} m, detail {detail} m (max {cap} m)", camera.x, camera.y),
        ));
    }
    let reach = (radius / grid.cell_size) as u32 + 2;
    let centre = CellId::new(clamp_cell(camera.x / grid.cell_size), clamp_cell(camera.y / grid.cell_size));
    let mut view = ViewCells::default();
    for cell in grid.square(centre, reach) {
        let (min, max) = grid.bounds(cell);
        let gap = Vec2::new((min.x - camera.x).max(camera.x - max.x).max(0.0), (min.y - camera.y).max(camera.y - max.y).max(0.0));
        let d2 = gap.length_squared();
        if d2 <= detail * detail {
            view.detail.push(cell);
        } else if d2 <= radius * radius {
            view.far.push(cell);
        }
    }
    Ok(view)
}

/// `floor(v)` as a cell coordinate, held to a range far outside any world so the square around it
/// cannot overflow.
fn clamp_cell(v: f32) -> i32 {
    const FAR: f32 = 1_000_000.0;
    v.floor().clamp(-FAR, FAR) as i32
}
