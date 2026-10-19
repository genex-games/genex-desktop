//! Bake input: triangle soups, placed meshes and boxes, one terrain, convex area volumes and
//! optional bounds, checked once when added, then gathered one tile at a time.
//!
//! Every `add_*` call checks its whole argument before it changes anything, so a refused call
//! (`nav-input-invalid`, `nav-too-large`) leaves the input exactly as it was. The `with_*` forms
//! are the same calls for a builder chain.
//!
//! A bake never sees the whole world at once. [`NavInput::tile`] gathers the input of one tile
//! region (the tile plus its border, [`tile_region`]):
//! - soup triangles whose precomputed x/z bounds overlap the region, in input order (Recast's
//!   rasterizer clips them to the tile, so a triangle that only touches the region is taken);
//! - the terrain triangulated over the cells under the region only ([`terrain_cells`],
//!   [`triangulate_cells`]), from the terrain's own samples, never re-sampled, so a 2049² field
//!   is never triangulated whole;
//! - the area volumes whose outline bounds overlap the region.
//!
//! Recast's rules come with it: [`TileInput::clear_steep`] is `rcClearUnwalkableTriangles` (a
//! triangle is walkable when the y of its unit normal `(v1 - v0) × (v2 - v0)` is above
//! `cos(slope)`), and [`AreaVolume`] is rerecast's `ConvexVolume` (MIT OR Apache-2.0; the rules,
//! no code copied): a convex outline in x/z between two heights whose inside the bake marks with
//! its area. The terrain's triangles follow the same winding, so its ground faces up.
//!
//! The terrain arrives through [`TerrainHeights`], which the facade implements over
//! genex-render's `Heightfield` (`Terrain::heights`) without copying it; [`HeightGrid`] is a plain
//! grid for games and tests without a renderer terrain. A mesh read from assets arrives as SF-1a's
//! `ModelTriangles` positions and indices through [`NavInput::add_mesh`].

use std::fmt::Debug;
use std::ops::Range;
use std::sync::Arc;

use glam::{Mat4, Vec2, Vec3, Vec3Swizzles};

use crate::error::NavError;

/// Soup triangles one input may hold (meshes, boxes and soups together; the terrain is gathered
/// per tile and never counts).
pub const NAV_INPUT_TRIANGLES_MAX: usize = 4_194_304;
/// Area volumes one input may hold.
pub const NAV_AREA_VOLUMES_MAX: usize = 1024;
/// Points one area volume's outline may have (DetourTileCache's `DT_MAX_CONVEXVOL_PTS`).
pub const NAV_AREA_OUTLINE_POINTS_MAX: usize = 12;
/// Samples a terrain may have along one side (eight times the 2049² terrains games use).
pub const NAV_TERRAIN_SAMPLES_MAX: u32 = 16_385;

/// An area of the navmesh: what walking it costs and whether a filter can shut it. Recast keeps
/// one area per span and the bake one per polygon (six bits, as Detour stores them).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct NavArea(u8);

impl NavArea {
    /// Not walkable: too steep, or cut out by a volume (Recast's `RC_NULL_AREA`).
    pub const NONE: NavArea = NavArea(0);
    /// Ground (cost 1).
    pub const WALK: NavArea = NavArea(1);
    /// A road (cost 0.8 by default).
    pub const ROAD: NavArea = NavArea(2);
    /// Grass (cost 1.5 by default).
    pub const GRASS: NavArea = NavArea(3);
    /// Shallow water (cost 4 by default).
    pub const WATER: NavArea = NavArea(4);
    /// A door (cost 1), shut by a filter.
    pub const DOOR: NavArea = NavArea(5);
    /// The first game-defined area.
    const CUSTOM_FIRST: u8 = 8;
    /// The last game-defined area (63 is Recast's default walkable area, kept free).
    const CUSTOM_LAST: u8 = 62;

    /// A game-defined area, `8..=62`.
    pub const fn custom(index: u8) -> Option<NavArea> {
        if index >= NavArea::CUSTOM_FIRST && index <= NavArea::CUSTOM_LAST { Some(NavArea(index)) } else { None }
    }

    /// The raw number, for bakes, probes and saves.
    pub const fn raw(self) -> u8 {
        self.0
    }
}

/// A terrain's height samples: a regular grid of `samples` (x, z) starting at `origin` (world x,
/// z of sample 0, 0), `spacing` metres apart. The facade implements it over genex-render's
/// `Heightfield`, so the bake reads the heights the terrain draws with.
pub trait TerrainHeights: Debug + Send + Sync {
    /// Samples per side (x, z).
    fn samples(&self) -> (u32, u32);
    /// World x, z of sample (0, 0).
    fn origin(&self) -> [f32; 2];
    /// Metres between samples.
    fn spacing(&self) -> f32;
    /// The height of sample (`x`, `z`), both inside [`TerrainHeights::samples`].
    fn sample(&self, x: u32, z: u32) -> f32;
}

/// A plain height grid, row-major with x fastest.
#[derive(Clone, Debug, PartialEq)]
pub struct HeightGrid {
    samples: (u32, u32),
    origin: [f32; 2],
    spacing: f32,
    heights: Vec<f32>,
}

impl HeightGrid {
    /// A grid of `heights`. Refused `nav-input-invalid`: fewer than 2 or more than
    /// [`NAV_TERRAIN_SAMPLES_MAX`] samples a side, a spacing that is not positive and finite, a
    /// non-finite origin, a height count other than the sample count, or a non-finite height.
    pub fn new(samples: (u32, u32), origin: [f32; 2], spacing: f32, heights: Vec<f32>) -> Result<HeightGrid, NavError> {
        check_grid(samples, origin, spacing)?;
        let expected = samples.0 as usize * samples.1 as usize;
        if heights.len() != expected {
            return Err(NavError::input_invalid(format!("{} heights for {} x {} samples", heights.len(), samples.0, samples.1)));
        }
        if let Some(bad) = heights.iter().position(|h| !h.is_finite()) {
            return Err(NavError::input_invalid(format!("height {bad} is not finite")));
        }
        Ok(HeightGrid { samples, origin, spacing, heights })
    }

    /// The grid of `height(x, z)` at every sample, x and z computed as genex-render's
    /// `Heightfield::from_fn` computes them.
    pub fn from_fn(samples: (u32, u32), origin: [f32; 2], spacing: f32, height: impl Fn(f32, f32) -> f32) -> Result<HeightGrid, NavError> {
        check_grid(samples, origin, spacing)?;
        let mut heights = Vec::with_capacity(samples.0 as usize * samples.1 as usize);
        for z in 0..samples.1 {
            for x in 0..samples.0 {
                heights.push(height(origin[0] + x as f32 * spacing, origin[1] + z as f32 * spacing));
            }
        }
        HeightGrid::new(samples, origin, spacing, heights)
    }
}

impl TerrainHeights for HeightGrid {
    fn samples(&self) -> (u32, u32) {
        self.samples
    }

    fn origin(&self) -> [f32; 2] {
        self.origin
    }

    fn spacing(&self) -> f32 {
        self.spacing
    }

    fn sample(&self, x: u32, z: u32) -> f32 {
        let x = x.min(self.samples.0 - 1) as usize;
        let z = z.min(self.samples.1 - 1) as usize;
        self.heights[z * self.samples.0 as usize + x]
    }
}

/// A grid shape a terrain may have.
fn check_grid(samples: (u32, u32), origin: [f32; 2], spacing: f32) -> Result<(), NavError> {
    let side = 2..=NAV_TERRAIN_SAMPLES_MAX;
    if !side.contains(&samples.0) || !side.contains(&samples.1) {
        return Err(NavError::input_invalid(format!("{} x {} samples, each side 2 to {NAV_TERRAIN_SAMPLES_MAX}", samples.0, samples.1)));
    }
    let usable_spacing = spacing.is_finite() && spacing > 0.0;
    if !usable_spacing || !origin.iter().all(|v| v.is_finite()) {
        return Err(NavError::input_invalid(format!("spacing {spacing} and origin {origin:?} must be finite, the spacing positive")));
    }
    Ok(())
}

/// The cells (`x` across, `z` down) of a terrain under a region; cell (x, z) spans samples x..=x+1
/// and z..=z+1.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TerrainCells {
    /// Cells across.
    pub x: Range<u32>,
    /// Cells down.
    pub z: Range<u32>,
}

/// The terrain cells that overlap the x/z region `min..=max` (empty ranges when none do).
pub fn terrain_cells(terrain: &dyn TerrainHeights, min: Vec2, max: Vec2) -> TerrainCells {
    let (across, down) = terrain.samples();
    let [ox, oz] = terrain.origin();
    let spacing = terrain.spacing();
    let axis = |low: f32, high: f32, origin: f32, cells: u32| -> Range<u32> {
        let first = ((low - origin) / spacing).floor().clamp(0.0, cells as f32) as u32;
        let end = ((high - origin) / spacing).ceil().clamp(0.0, cells as f32) as u32;
        first..end.max(first)
    };
    TerrainCells { x: axis(min.x, max.x, ox, across.saturating_sub(1)), z: axis(min.y, max.y, oz, down.saturating_sub(1)) }
}

/// The triangles of `cells`, row by row (z), then cell by cell (x), two per cell facing up in
/// Recast's winding: (x, z), (x, z+1), (x+1, z), then (x+1, z), (x, z+1), (x+1, z+1). Refused
/// `nav-input-invalid` when a height it reads is not finite.
pub fn triangulate_cells(terrain: &dyn TerrainHeights, cells: &TerrainCells) -> Result<Vec<[Vec3; 3]>, NavError> {
    let [ox, oz] = terrain.origin();
    let spacing = terrain.spacing();
    let count = cells.x.len() * cells.z.len() * 2;
    let mut triangles = Vec::with_capacity(count);
    let corner = |x: u32, z: u32| -> Result<Vec3, NavError> {
        let height = terrain.sample(x, z);
        if !height.is_finite() {
            return Err(NavError::input_invalid(format!("terrain height at sample ({x}, {z}) is not finite")));
        }
        Ok(Vec3::new(ox + x as f32 * spacing, height, oz + z as f32 * spacing))
    };
    for z in cells.z.clone() {
        // Each row reads its two sample rows once, left to right.
        let mut near = corner(cells.x.start, z)?;
        let mut far = corner(cells.x.start, z + 1)?;
        for x in cells.x.clone() {
            let (near_next, far_next) = (corner(x + 1, z)?, corner(x + 1, z + 1)?);
            triangles.push([near, far, near_next]);
            triangles.push([near_next, far, far_next]);
            (near, far) = (near_next, far_next);
        }
    }
    Ok(triangles)
}

/// The x/z region of tile `cell` on the grid anchored at world (0, 0) with `tile` metre tiles,
/// grown by `border` metres on every side (Recast bakes a tile with a border so neighbours meet).
/// Refused `nav-input-invalid`: a tile size that is not positive and finite, a border that is not
/// finite and non-negative, or a cell so far out its region is not finite.
pub fn tile_region(cell: [i32; 2], tile: f32, border: f32) -> Result<(Vec2, Vec2), NavError> {
    let usable = tile.is_finite() && tile > 0.0 && border.is_finite() && border >= 0.0;
    if !usable {
        return Err(NavError::input_invalid(format!("tile {tile} m must be positive and border {border} m non-negative, both finite")));
    }
    let start = Vec2::new(cell[0] as f32 * tile, cell[1] as f32 * tile);
    let (min, max) = (start - Vec2::splat(border), start + Vec2::splat(tile + border));
    if !(min.is_finite() && max.is_finite()) {
        return Err(NavError::input_invalid(format!("tile {cell:?} is outside the finite world")));
    }
    Ok((min, max))
}

/// A vertical prism whose inside the bake marks with an area: a convex outline in x/z between
/// two heights (rerecast's `ConvexVolume`).
#[derive(Clone, Debug, PartialEq)]
pub struct AreaVolume {
    outline: Vec<Vec2>,
    min_y: f32,
    max_y: f32,
    area: NavArea,
    bounds: (Vec2, Vec2),
}

impl AreaVolume {
    /// A volume of `outline` (x, z) from `min_y` to `max_y`. Refused `nav-input-invalid`: fewer
    /// than 3 or more than [`NAV_AREA_OUTLINE_POINTS_MAX`] points, a non-finite point or height,
    /// `min_y` above `max_y`, or an outline that is not a convex polygon (either winding; no
    /// repeated or collinear points, never crossing itself).
    pub fn new(outline: &[Vec2], min_y: f32, max_y: f32, area: NavArea) -> Result<AreaVolume, NavError> {
        if !(3..=NAV_AREA_OUTLINE_POINTS_MAX).contains(&outline.len()) {
            return Err(NavError::input_invalid(format!("an area outline of {} points, 3 to {NAV_AREA_OUTLINE_POINTS_MAX}", outline.len())));
        }
        if let Some(bad) = outline.iter().position(|p| !p.is_finite()) {
            return Err(NavError::input_invalid(format!("outline point {bad} is not finite")));
        }
        let heights_usable = min_y.is_finite() && max_y.is_finite() && min_y <= max_y;
        if !heights_usable {
            return Err(NavError::input_invalid(format!("an area volume from {min_y} to {max_y} m: finite, min_y at or below max_y")));
        }
        if !is_convex(outline) {
            return Err(NavError::input_invalid("an area outline that is not a convex polygon"));
        }
        let min = outline.iter().copied().fold(Vec2::INFINITY, Vec2::min);
        let max = outline.iter().copied().fold(Vec2::NEG_INFINITY, Vec2::max);
        Ok(AreaVolume { outline: outline.to_vec(), min_y, max_y, area, bounds: (min, max) })
    }

    /// The area it marks.
    pub fn area(&self) -> NavArea {
        self.area
    }

    /// Its outline (x, z).
    pub fn outline(&self) -> &[Vec2] {
        &self.outline
    }

    /// Its heights, low then high.
    pub fn heights(&self) -> (f32, f32) {
        (self.min_y, self.max_y)
    }

    /// `point` lies inside the prism: within the heights and inside the outline (Recast's
    /// `pointInPoly`, the even-odd crossing test, boundaries as Recast takes them).
    pub fn contains(&self, point: Vec3) -> bool {
        if point.y < self.min_y || point.y > self.max_y {
            return false;
        }
        let (x, z) = (point.x, point.z);
        let mut inside = false;
        let mut j = self.outline.len() - 1;
        for (i, a) in self.outline.iter().enumerate() {
            let b = self.outline[j];
            let crosses = (a.y > z) != (b.y > z) && x < (b.x - a.x) * (z - a.y) / (b.y - a.y) + a.x;
            if crosses {
                inside = !inside;
            }
            j = i;
        }
        inside
    }

    fn overlaps(&self, min: Vec2, max: Vec2) -> bool {
        overlaps(self.bounds, (min, max))
    }
}

/// Every edge has all other points strictly on one side, the same side for every edge: convex,
/// simple, and with no repeated or collinear points.
fn is_convex(outline: &[Vec2]) -> bool {
    let count = outline.len();
    let mut turn = 0.0f32;
    for i in 0..count {
        let (a, b) = (outline[i], outline[(i + 1) % count]);
        for (k, p) in outline.iter().enumerate() {
            if k == i || k == (i + 1) % count {
                continue;
            }
            let side = (b - a).perp_dot(*p - a);
            if side == 0.0 || !side.is_finite() || side * turn < 0.0 {
                return false;
            }
            turn = side;
        }
    }
    true
}

/// Two closed x/z boxes overlap (touching counts).
fn overlaps(a: (Vec2, Vec2), b: (Vec2, Vec2)) -> bool {
    a.0.x <= b.1.x && b.0.x <= a.1.x && a.0.y <= b.1.y && b.0.y <= a.1.y
}

/// The terrain of an input and the area its ground takes.
#[derive(Clone, Debug)]
struct TerrainInput {
    heights: Arc<dyn TerrainHeights>,
    area: NavArea,
}

impl PartialEq for TerrainInput {
    /// The same terrain object with the same area: a terrain is shared, never compared sample by
    /// sample.
    fn eq(&self, other: &TerrainInput) -> bool {
        Arc::ptr_eq(&self.heights, &other.heights) && self.area == other.area
    }
}

/// The geometry a navmesh is cut from. Nothing is baked here: a bake gathers it tile by tile.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct NavInput {
    vertices: Vec<Vec3>,
    indices: Vec<u32>,
    areas: Vec<NavArea>,
    /// Per triangle: its x/z bounds, min then max (the per-tile pick reads only these).
    triangle_bounds: Vec<(Vec2, Vec2)>,
    terrain: Option<TerrainInput>,
    volumes: Vec<AreaVolume>,
    bounds: Option<(Vec3, Vec3)>,
}

/// One tile's input: triangles with their areas, and the area volumes that overlap the tile.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TileInput {
    /// Triangles: soup triangles in input order, then the terrain window row by row.
    pub triangles: Vec<[Vec3; 3]>,
    /// One area per triangle.
    pub areas: Vec<NavArea>,
    /// Indices into [`NavInput::volumes`] of the volumes overlapping the tile, in order.
    pub volumes: Vec<usize>,
}

impl TileInput {
    /// Recast's `rcClearUnwalkableTriangles`: every triangle whose unit normal
    /// `(v1 - v0) × (v2 - v0)` has a y at or below `cos(max_slope_degrees)` (too steep, facing
    /// down or degenerate) becomes [`NavArea::NONE`]. Refused `nav-input-invalid` for a slope
    /// outside (0, 90] degrees.
    pub fn clear_steep(&mut self, max_slope_degrees: f32) -> Result<(), NavError> {
        let usable = max_slope_degrees > 0.0 && max_slope_degrees <= 90.0;
        if !usable {
            return Err(NavError::input_invalid(format!("a walkable slope of {max_slope_degrees}°, above 0 and at most 90")));
        }
        // glam's `from_angle` runs libm's sincos (scalar-math + libm), so the threshold has the
        // same bits on every destination; `f32::cos` is the platform's.
        let threshold = Vec2::from_angle(max_slope_degrees.to_radians()).x;
        for (triangle, area) in self.triangles.iter().zip(self.areas.iter_mut()) {
            let normal = (triangle[1] - triangle[0]).cross(triangle[2] - triangle[0]);
            let length = normal.length();
            let walkable = length > 0.0 && normal.y / length > threshold;
            if !walkable {
                *area = NavArea::NONE;
            }
        }
        Ok(())
    }
}

impl NavInput {
    /// An empty input.
    pub fn new() -> NavInput {
        NavInput::default()
    }

    /// Soup triangles held (meshes, boxes and soups; not the terrain).
    pub fn triangle_count(&self) -> usize {
        self.areas.len()
    }

    /// The area volumes, in the order added.
    pub fn volumes(&self) -> &[AreaVolume] {
        &self.volumes
    }

    /// The terrain, when one is set.
    pub fn terrain(&self) -> Option<&dyn TerrainHeights> {
        self.terrain.as_ref().map(|terrain| terrain.heights.as_ref())
    }

    /// The box a bake cuts within: the set bounds, or the input's own (soups, the terrain's
    /// extent and heights it would read, and the volumes); `None` for an empty input.
    pub fn bounds(&self) -> Option<(Vec3, Vec3)> {
        if self.bounds.is_some() {
            return self.bounds;
        }
        let mut points: Vec<Vec3> = self.vertices_used().collect();
        for volume in &self.volumes {
            points.push(volume.bounds.0.extend(volume.min_y).xzy());
            points.push(volume.bounds.1.extend(volume.max_y).xzy());
        }
        let mut bounds = points.iter().fold(None, |acc: Option<(Vec3, Vec3)>, p| Some(acc.map_or((*p, *p), |(min, max)| (min.min(*p), max.max(*p)))));
        if let Some(terrain) = &self.terrain {
            let heights = terrain.heights.as_ref();
            let (across, down) = heights.samples();
            let [ox, oz] = heights.origin();
            let far = Vec2::new(ox + (across - 1) as f32 * heights.spacing(), oz + (down - 1) as f32 * heights.spacing());
            let (low, high) = height_range(heights);
            let (min, max) = (Vec3::new(ox, low, oz), Vec3::new(far.x, high, far.y));
            bounds = Some(bounds.map_or((min, max), |(a, b)| (a.min(min), b.max(max))));
        }
        bounds
    }

    fn vertices_used(&self) -> impl Iterator<Item = Vec3> + '_ {
        self.indices.iter().map(|&i| self.vertices[i as usize])
    }

    /// Add a triangle soup in world space: `indices` into `vertices`, three per triangle.
    /// Refused `nav-too-large` when the input would hold more than [`NAV_INPUT_TRIANGLES_MAX`]
    /// triangles (checked before anything is read), `nav-input-invalid` for an index count that
    /// is not a multiple of 3, a non-finite vertex or an index past the vertices.
    pub fn add_triangles(&mut self, vertices: &[Vec3], indices: &[u32], area: NavArea) -> Result<(), NavError> {
        self.add_placed(vertices, indices, None, area)
    }

    /// Add a mesh (SF-1a's `ModelTriangles` positions and indices) placed by `transform`.
    /// Refused as [`NavInput::add_triangles`], and `nav-input-invalid` for a non-finite
    /// transform or a placed corner that is not finite.
    pub fn add_mesh(&mut self, positions: &[Vec3], indices: &[u32], transform: Mat4, area: NavArea) -> Result<(), NavError> {
        if !transform.is_finite() {
            return Err(NavError::input_invalid("a mesh placement that is not finite"));
        }
        self.add_placed(positions, indices, Some(transform), area)
    }

    /// Add a unit cube (-0.5..0.5 on each axis) placed by `transform`: 12 triangles facing out,
    /// so a bake walks on its top. Refused `nav-input-invalid` for a non-finite transform.
    pub fn add_box(&mut self, transform: Mat4, area: NavArea) -> Result<(), NavError> {
        if !transform.is_finite() {
            return Err(NavError::input_invalid("a box placement that is not finite"));
        }
        let corners: Vec<Vec3> = (0..8u32).map(|k| Vec3::new(half(k & 1), half(k & 2), half(k & 4))).collect();
        self.add_placed(&corners, &BOX_INDICES, Some(transform), area)
    }

    /// Set the terrain whose ground the bake walks. Refused `nav-input-invalid`: a second
    /// terrain, or a grid [`HeightGrid::new`] would refuse by its shape.
    pub fn add_terrain(&mut self, terrain: Arc<dyn TerrainHeights>, area: NavArea) -> Result<(), NavError> {
        if self.terrain.is_some() {
            return Err(NavError::input_invalid("the input already has a terrain"));
        }
        check_grid(terrain.samples(), terrain.origin(), terrain.spacing())?;
        self.terrain = Some(TerrainInput { heights: terrain, area });
        Ok(())
    }

    /// Mark everything inside a vertical prism with `area`. Refused as [`AreaVolume::new`], and
    /// `nav-too-large` past [`NAV_AREA_VOLUMES_MAX`] volumes.
    pub fn add_area_volume(&mut self, outline: &[Vec2], min_y: f32, max_y: f32, area: NavArea) -> Result<(), NavError> {
        if self.volumes.len() >= NAV_AREA_VOLUMES_MAX {
            return Err(NavError::too_large(format!("more than {NAV_AREA_VOLUMES_MAX} area volumes")));
        }
        let volume = AreaVolume::new(outline, min_y, max_y, area)?;
        self.volumes.push(volume);
        Ok(())
    }

    /// Cut nothing outside the box `min..=max`. Refused `nav-input-invalid` for a non-finite
    /// corner or a `min` above `max` on any axis.
    pub fn set_bounds(&mut self, min: Vec3, max: Vec3) -> Result<(), NavError> {
        let usable = min.is_finite() && max.is_finite() && min.cmple(max).all();
        if !usable {
            return Err(NavError::input_invalid(format!("bounds {min} to {max}: finite, min at or below max")));
        }
        self.bounds = Some((min, max));
        Ok(())
    }

    /// [`NavInput::add_triangles`] in a builder chain.
    pub fn with_triangles(mut self, vertices: &[Vec3], indices: &[u32], area: NavArea) -> Result<NavInput, NavError> {
        self.add_triangles(vertices, indices, area).map(|()| self)
    }

    /// [`NavInput::add_mesh`] in a builder chain.
    pub fn with_mesh(mut self, positions: &[Vec3], indices: &[u32], transform: Mat4, area: NavArea) -> Result<NavInput, NavError> {
        self.add_mesh(positions, indices, transform, area).map(|()| self)
    }

    /// [`NavInput::add_box`] in a builder chain.
    pub fn with_box(mut self, transform: Mat4, area: NavArea) -> Result<NavInput, NavError> {
        self.add_box(transform, area).map(|()| self)
    }

    /// [`NavInput::add_terrain`] in a builder chain.
    pub fn with_terrain(mut self, terrain: Arc<dyn TerrainHeights>, area: NavArea) -> Result<NavInput, NavError> {
        self.add_terrain(terrain, area).map(|()| self)
    }

    /// [`NavInput::add_area_volume`] in a builder chain.
    pub fn with_area_volume(mut self, outline: &[Vec2], min_y: f32, max_y: f32, area: NavArea) -> Result<NavInput, NavError> {
        self.add_area_volume(outline, min_y, max_y, area).map(|()| self)
    }

    /// [`NavInput::set_bounds`] in a builder chain.
    pub fn with_bounds(mut self, min: Vec3, max: Vec3) -> Result<NavInput, NavError> {
        self.set_bounds(min, max).map(|()| self)
    }

    /// Check a soup whole, then append it, placed by `transform` when there is one.
    fn add_placed(&mut self, vertices: &[Vec3], indices: &[u32], transform: Option<Mat4>, area: NavArea) -> Result<(), NavError> {
        if !indices.len().is_multiple_of(3) {
            return Err(NavError::input_invalid(format!("{} indices, not three per triangle", indices.len())));
        }
        let triangles = indices.len() / 3;
        if triangles > NAV_INPUT_TRIANGLES_MAX - self.triangle_count() {
            return Err(NavError::too_large(format!("{} triangles with the {} held, over {NAV_INPUT_TRIANGLES_MAX}", triangles, self.triangle_count())));
        }
        let place = |v: Vec3| transform.map_or(v, |m| m.transform_point3(v));
        if let Some(bad) = vertices.iter().position(|v| !place(*v).is_finite()) {
            return Err(NavError::input_invalid(format!("vertex {bad} is not finite")));
        }
        if let Some(bad) = indices.iter().position(|&i| i as usize >= vertices.len()) {
            return Err(NavError::input_invalid(format!("index {bad} is past the {} vertices", vertices.len())));
        }
        let base = self.vertices.len();
        if base + vertices.len() > u32::MAX as usize {
            return Err(NavError::too_large("more vertices than 32-bit indices reach"));
        }
        // A mirroring placement turns the winding over; swapping two corners turns it back, so
        // what faced up still does.
        let mirrored = transform.is_some_and(|m| m.determinant() < 0.0);
        self.vertices.extend(vertices.iter().map(|v| place(*v)));
        self.indices.reserve(indices.len());
        self.areas.reserve(triangles);
        self.triangle_bounds.reserve(triangles);
        for triangle in indices.as_chunks::<3>().0 {
            let corners = if mirrored { [triangle[0], triangle[2], triangle[1]] } else { [triangle[0], triangle[1], triangle[2]] };
            let points = corners.map(|i| self.vertices[base + i as usize]);
            let min = points[0].min(points[1]).min(points[2]);
            let max = points[0].max(points[1]).max(points[2]);
            self.indices.extend(corners.map(|i| base as u32 + i));
            self.areas.push(area);
            self.triangle_bounds.push((min.xz(), max.xz()));
        }
        Ok(())
    }

    /// Gather the input of the x/z region `min..=max` (a tile and its border, [`tile_region`]),
    /// within the input's bounds when set. Refused `nav-input-invalid` for a region that is not
    /// finite or has `min` past `max`, or a terrain height that is not finite.
    pub fn tile(&self, min: Vec2, max: Vec2) -> Result<TileInput, NavError> {
        let usable = min.is_finite() && max.is_finite() && min.cmple(max).all();
        if !usable {
            return Err(NavError::input_invalid(format!("a tile region {min} to {max}: finite, min at or below max")));
        }
        let (min, max, heights) = match self.bounds {
            Some((low, high)) => (min.max(low.xz()), max.min(high.xz()), low.y..=high.y),
            None => (min, max, f32::NEG_INFINITY..=f32::INFINITY),
        };
        let mut tile = TileInput::default();
        if min.cmpgt(max).any() {
            return Ok(tile);
        }
        for (index, bounds) in self.triangle_bounds.iter().enumerate() {
            if !overlaps(*bounds, (min, max)) {
                continue;
            }
            let corners = [0, 1, 2].map(|k| self.vertices[self.indices[index * 3 + k] as usize]);
            let below = corners.iter().all(|v| v.y < *heights.start());
            let above = corners.iter().all(|v| v.y > *heights.end());
            if below || above {
                continue;
            }
            tile.triangles.push(corners);
            tile.areas.push(self.areas[index]);
        }
        if let Some(terrain) = &self.terrain {
            let cells = terrain_cells(terrain.heights.as_ref(), min, max);
            let ground = triangulate_cells(terrain.heights.as_ref(), &cells)?;
            let kept = ground.into_iter().filter(|t| !(t.iter().all(|v| v.y < *heights.start()) || t.iter().all(|v| v.y > *heights.end())));
            for triangle in kept {
                tile.triangles.push(triangle);
                tile.areas.push(terrain.area);
            }
        }
        tile.volumes = self.volumes.iter().enumerate().filter(|(_, volume)| volume.overlaps(min, max)).map(|(index, _)| index).collect();
        Ok(tile)
    }
}

/// The lowest and highest sample of a terrain (a full scan, only for its bounds).
fn height_range(heights: &dyn TerrainHeights) -> (f32, f32) {
    let (across, down) = heights.samples();
    let mut range = (f32::INFINITY, f32::NEG_INFINITY);
    for z in 0..down {
        for x in 0..across {
            let h = heights.sample(x, z);
            range = (range.0.min(h), range.1.max(h));
        }
    }
    range
}

/// -0.5 or 0.5: a unit cube corner's coordinate from one bit of its index.
fn half(bit: u32) -> f32 {
    if bit == 0 { -0.5 } else { 0.5 }
}

/// The unit cube's 12 triangles over corners indexed x + 2y + 4z, facing out in Recast's
/// winding ((v1 - v0) × (v2 - v0) points out).
const BOX_INDICES: [u32; 36] = [
    // Top (y = 0.5): up.
    2, 6, 3, 3, 6, 7, //
    // Bottom (y = -0.5): down.
    0, 1, 4, 1, 5, 4, //
    // x = -0.5.
    0, 4, 2, 2, 4, 6, //
    // x = 0.5.
    1, 3, 5, 3, 7, 5, //
    // z = -0.5.
    0, 2, 1, 1, 2, 3, //
    // z = 0.5.
    4, 5, 6, 5, 7, 6,
];
