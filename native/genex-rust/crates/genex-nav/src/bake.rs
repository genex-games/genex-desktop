//! The tiled bake: one Recast build per tile of a grid anchored at world (0, 0), each over the
//! tile plus a border, so tiles baked apart meet edge to edge.
//!
//! Tile (x, z) covers world x in `[x * tile, (x + 1) * tile]` and z likewise, `tile` metres a
//! side ([`BakeConfig::tile`]), so stream cells of the same size or a multiple line up with it.
//! A tile's build follows Recast's `Sample_TileMesh::buildTileMesh` (recastnavigation, Zlib; the
//! steps only, written over the port in [`crate::recast`]):
//! - the heightfield spans the tile plus `border = ceil(radius / cell) + 3` cells on each side,
//!   and the tile's input is gathered over that whole region ([`NavInput::tile`], NAV-3);
//! - triangles steeper than the slope become [`crate::NavArea::NONE`], the rest keep their area; spans
//!   are rasterized, filtered, compacted, eroded by the walker radius and marked by the area
//!   volumes, then partitioned into watershed regions with the border cells kept out;
//! - the contours, polygon mesh and detail mesh then stop at the tile's edge, so the erosion that
//!   would pull an unbordered tile back from its edge (a crack of one radius on each side)
//!   happens in the border instead, and both neighbours reach the shared edge.
//!
//! Polygon corners are written in metres from the tile's own corner, and a corner on the tile's
//! edge is written as exactly that edge, so both neighbours put a shared edge at the same x or z.
//! Every tile of one input quantizes heights from the same floor, the input's lowest point
//! ([`height_floor`]), as Recast's tiled sample does with the mesh's bounds: tiles that counted
//! cells from their own lowest points would round a height on a cell boundary differently and
//! disagree by a cell along their shared edge. Everything runs on the calling thread in input
//! order with libm math: one input and config give the same bytes on every destination.

use genex_core::cell::CellId;
use genex_core::digest::fnv1a64;
use glam::{UVec3, Vec2, Vec3, Vec3A};

use crate::error::NavError;
use crate::input::{NavInput, TileInput, tile_region};
use crate::recast::{
    AreaType, BuildContoursFlags, ConvexVolume, DetailNavmesh, Heightfield, PolygonNavmesh, PolygonNavmeshError, RecastError, Spans,
    TriMesh,
};
use crate::tile::{DetailPart, NAV_TILE_POLYGON_VERTICES_MAX, NavTile, TileMesh};

/// Cells one tile may have along a side.
pub const NAV_TILE_CELLS_MAX: u32 = 1024;
/// The smallest cell size, in metres.
pub const NAV_CELL_SIZE_MIN: f32 = 0.05;
/// The smallest cell height, in metres.
pub const NAV_CELL_HEIGHT_MIN: f32 = 0.02;
/// The most voxels the walker's height, climb or radius may span (Recast stores span heights in
/// a byte).
const WALKER_VOXELS_MAX: f32 = 255.0;
/// Extra cells around a tile beyond the walker radius (Recast's `walkableRadius + 3`).
const BORDER_PADDING_CELLS: u16 = 3;
/// How far a tile edge may sit from a whole number of cells, as a fraction of the tile.
const TILE_CELL_TOLERANCE: f32 = 1.0e-4;
/// Recast ignores a detail sample distance below this many cells and samples nothing.
const DETAIL_SAMPLE_CELLS_MIN: f32 = 0.9;

/// How a navmesh is baked for one walker: its body in metres, the voxel sizes and the tile edge,
/// and Recast's region, contour and detail settings.
#[derive(Clone, Debug, PartialEq)]
pub struct BakeConfig {
    /// The walker's radius, in metres.
    pub radius: f32,
    /// The walker's height, in metres.
    pub height: f32,
    /// The highest step the walker climbs, in metres.
    pub climb: f32,
    /// The steepest ground the walker stands on, in degrees (0, 90).
    pub slope_degrees: f32,
    /// The voxel size along x and z, in metres (at least [`NAV_CELL_SIZE_MIN`]).
    pub cell_size: f32,
    /// The voxel size along y, in metres (at least [`NAV_CELL_HEIGHT_MIN`]).
    pub cell_height: f32,
    /// The tile edge, in metres: a whole number of cells, at most [`NAV_TILE_CELLS_MAX`].
    pub tile: f32,
    /// Regions smaller than this many cells squared are dropped.
    pub min_region_cells: u16,
    /// Regions smaller than this many cells squared merge into a neighbour when they can.
    pub merge_region_cells: u16,
    /// The longest contour edge along the mesh border, in metres (0: no limit).
    pub max_edge_length: f32,
    /// How far a simplified contour may stray from the raw one, in cells.
    pub max_simplification_error: f32,
    /// The detail mesh's height sampling step, in cells (below 0.9: no extra samples).
    pub detail_sample_cells: f32,
    /// How far the detail mesh may stray from the heightfield, in cell heights.
    pub detail_max_error_cells: f32,
}

impl Default for BakeConfig {
    fn default() -> Self {
        BakeConfig::walker(0.4, 1.8)
    }
}

impl BakeConfig {
    /// A config for a walker `radius` wide and `height` tall: climb 0.4 m, slope 45°, cells
    /// 0.2 m by 0.1 m, 32 m tiles, and Recast's sample settings for the rest.
    pub fn walker(radius: f32, height: f32) -> BakeConfig {
        BakeConfig {
            radius,
            height,
            climb: 0.4,
            slope_degrees: 45.0,
            cell_size: 0.2,
            cell_height: 0.1,
            tile: 32.0,
            min_region_cells: 8,
            merge_region_cells: 20,
            max_edge_length: 12.0,
            max_simplification_error: 1.3,
            detail_sample_cells: 6.0,
            detail_max_error_cells: 1.0,
        }
    }

    /// Refused `nav-config-invalid`: a size, climb or setting that is not finite, a radius,
    /// height or tile that is not positive, cells below [`NAV_CELL_SIZE_MIN`] or
    /// [`NAV_CELL_HEIGHT_MIN`], a slope outside (0, 90) degrees, a walker more than 255 voxels
    /// tall, wide or climbing, or a tile that is not a whole number of cells or is over
    /// [`NAV_TILE_CELLS_MAX`] of them.
    pub fn check(&self) -> Result<(), NavError> {
        let numbers = [
            self.radius,
            self.height,
            self.climb,
            self.slope_degrees,
            self.cell_size,
            self.cell_height,
            self.tile,
            self.max_edge_length,
            self.max_simplification_error,
            self.detail_sample_cells,
            self.detail_max_error_cells,
        ];
        if numbers.iter().any(|n| !n.is_finite()) {
            return Err(NavError::config_invalid("every bake setting must be finite"));
        }
        let body_usable = self.radius > 0.0 && self.height > 0.0 && self.climb >= 0.0;
        let cells_usable = self.cell_size >= NAV_CELL_SIZE_MIN && self.cell_height >= NAV_CELL_HEIGHT_MIN;
        let settings_usable = self.max_edge_length >= 0.0 && self.max_simplification_error >= 0.0 && self.detail_max_error_cells >= 0.0;
        if !(body_usable && cells_usable && settings_usable) {
            return Err(NavError::config_invalid(format!(
                "radius {} and height {} positive, climb {} not negative, cells at least {NAV_CELL_SIZE_MIN} by {NAV_CELL_HEIGHT_MIN} m, settings not negative",
                self.radius, self.height, self.climb
            )));
        }
        if !(self.slope_degrees > 0.0 && self.slope_degrees < 90.0) {
            return Err(NavError::config_invalid(format!("a walkable slope of {}°, between 0 and 90", self.slope_degrees)));
        }
        let voxels = [self.radius / self.cell_size, self.height / self.cell_height, self.climb / self.cell_height];
        if voxels.iter().any(|&v| v.ceil() > WALKER_VOXELS_MAX) {
            return Err(NavError::config_invalid("the walker spans more than 255 voxels"));
        }
        self.checked_tile_cells().map(|_| ())
    }

    fn checked_tile_cells(&self) -> Result<u16, NavError> {
        let cells = (self.tile / self.cell_size).round();
        let whole = (cells * self.cell_size - self.tile).abs() <= TILE_CELL_TOLERANCE * self.tile;
        let usable = self.tile > 0.0 && cells >= 1.0 && cells <= NAV_TILE_CELLS_MAX as f32 && whole;
        if !usable {
            return Err(NavError::config_invalid(format!(
                "a {} m tile at {} m cells: a whole number of cells, 1 to {NAV_TILE_CELLS_MAX}",
                self.tile, self.cell_size
            )));
        }
        // `usable` holds the count to 1..=NAV_TILE_CELLS_MAX, which fits a u16.
        Ok(cells as u16)
    }

    /// Cells along a tile's side (the config must pass [`BakeConfig::check`]).
    pub fn tile_cells(&self) -> u16 {
        self.checked_tile_cells().unwrap_or(0)
    }

    /// The walker radius in cells, rounded up (Recast's `walkableRadius`).
    pub fn radius_cells(&self) -> u16 {
        (self.radius / self.cell_size).ceil() as u16
    }

    /// Cells of border a tile's build adds on each side: the radius in cells plus 3.
    pub fn border_cells(&self) -> u16 {
        self.radius_cells() + BORDER_PADDING_CELLS
    }

    /// The FNV-1a 64 digest of every setting (floats by their bits), which each tile records.
    pub fn digest(&self) -> u64 {
        let mut bytes = Vec::with_capacity(64);
        let floats = [
            self.radius,
            self.height,
            self.climb,
            self.slope_degrees,
            self.cell_size,
            self.cell_height,
            self.tile,
            self.max_edge_length,
            self.max_simplification_error,
            self.detail_sample_cells,
            self.detail_max_error_cells,
        ];
        for value in floats {
            bytes.extend_from_slice(&value.to_bits().to_le_bytes());
        }
        bytes.extend_from_slice(&self.min_region_cells.to_le_bytes());
        bytes.extend_from_slice(&self.merge_region_cells.to_le_bytes());
        fnv1a64(&bytes)
    }
}

/// The cells of every tile the x/z box `min..=max` touches, row by row (z, then x).
pub fn covering_cells(min: Vec2, max: Vec2, tile: f32) -> Vec<CellId> {
    let usable = min.is_finite() && max.is_finite() && min.cmple(max).all() && tile.is_finite() && tile > 0.0;
    if !usable {
        return Vec::new();
    }
    let first = (min / tile).floor();
    let last = (max / tile).ceil() - Vec2::ONE;
    let (x0, z0) = (first.x as i32, first.y as i32);
    let (x1, z1) = ((last.x as i32).max(x0), (last.y as i32).max(z0));
    (z0..=z1).flat_map(|z| (x0..=x1).map(move |x| CellId::new(x, z))).collect()
}

/// The height every tile of `input` counts cells from: the lowest point of its bounds
/// ([`NavInput::bounds`]; a full terrain scan, so a caller baking many tiles takes it once and
/// passes it to [`bake_tile_on_floor`]). `None` for an empty input.
pub fn height_floor(input: &NavInput) -> Option<f32> {
    input.bounds().map(|(min, _)| min.y)
}

/// Bake the tile at `cell`, heights counted from [`height_floor`]. Refused `nav-config-invalid`
/// for a config [`BakeConfig::check`] refuses, as [`NavInput::tile`] refuses, `nav-too-large`
/// when Recast runs out of span layers, regions, vertices or polygons, and `nav-input-invalid`
/// for geometry Recast cannot outline. A tile with no walkable ground is a tile with no polygons.
pub fn bake_tile(input: &NavInput, config: &BakeConfig, cell: CellId) -> Result<NavTile, NavError> {
    config.check()?;
    let floor = height_floor(input).unwrap_or(0.0);
    bake_tile_on_floor(input, config, cell, floor)
}

/// [`bake_tile`] with heights counted from `floor` (the input's [`height_floor`], taken once
/// for many tiles). Neighbours meet only when baked on the same floor; a floor above a triangle
/// of the tile is lowered to it for that tile. Refused as [`bake_tile`], and `nav-input-invalid`
/// for a floor that is not finite.
pub fn bake_tile_on_floor(input: &NavInput, config: &BakeConfig, cell: CellId, floor: f32) -> Result<NavTile, NavError> {
    config.check()?;
    bake(input, config, cell, config.border_cells(), floor)
}

/// [`bake_tile`] with `border_cells` of border instead of the config's. Only for diagnostics: a
/// border under [`BakeConfig::border_cells`] erodes the mesh back from the tile's edge, and a
/// border of 0 is the plain per-tile build whose neighbours crack apart.
pub fn bake_tile_with_border(input: &NavInput, config: &BakeConfig, cell: CellId, border_cells: u16) -> Result<NavTile, NavError> {
    config.check()?;
    let floor = height_floor(input).unwrap_or(0.0);
    bake(input, config, cell, border_cells, floor)
}

fn bake(input: &NavInput, config: &BakeConfig, cell: CellId, border_cells: u16, floor: f32) -> Result<NavTile, NavError> {
    if !floor.is_finite() {
        return Err(NavError::input_invalid(format!("a height floor of {floor}")));
    }
    let tile_cells = config.tile_cells();
    let border = f32::from(border_cells) * config.cell_size;
    let (min, max) = tile_region([cell.x, cell.z], config.tile, border)?;
    let mut window = input.tile(min, max)?;
    window.clear_steep(config.slope_degrees)?;
    let input_digest = window_digest(&window, input, floor);
    let Some((low, high)) = height_range(&window, floor) else {
        return NavTile::new(cell, config.digest(), input_digest, TileMesh::default());
    };
    let corner = Vec2::new(cell.x as f32 * config.tile, cell.z as f32 * config.tile);
    let span = f32::from(tile_cells + 2 * border_cells) * config.cell_size;
    let heightfield = Heightfield {
        width: tile_cells + 2 * border_cells,
        height: tile_cells + 2 * border_cells,
        aabb: crate::recast::Aabb3d { min: Vec3::new(min.x, low, min.y), max: Vec3::new(min.x + span, high, min.y + span) },
        cell_size: config.cell_size,
        cell_height: config.cell_height,
        spans: vec![None; usize::from(tile_cells + 2 * border_cells).pow(2)],
        allocated_spans: Spans::default(),
    };
    let volumes: Vec<ConvexVolume> = window.volumes.iter().map(|&i| convex_volume(&input.volumes()[i])).collect();
    let (poly, detail) = run_recast(heightfield, &trimesh(&window), &volumes, config, border_cells).map_err(recast_refusal)?;
    let mesh = tile_mesh(&poly, &detail, corner, config, tile_cells);
    NavTile::new(cell, config.digest(), input_digest, mesh)
}

/// The Recast stages of one tile, as `Sample_TileMesh::buildTileMesh` runs them.
fn run_recast(
    mut heightfield: Heightfield,
    trimesh: &TriMesh,
    volumes: &[ConvexVolume],
    config: &BakeConfig,
    border_cells: u16,
) -> Result<(PolygonNavmesh, DetailNavmesh), RecastError> {
    let walkable_height = (config.height / config.cell_height).ceil() as u16;
    let walkable_climb = (config.climb / config.cell_height).floor() as u16;
    heightfield.rasterize_triangles(trimesh, walkable_climb)?;
    heightfield.filter_low_hanging_walkable_obstacles(walkable_climb);
    heightfield.filter_ledge_spans(walkable_height, walkable_climb);
    heightfield.filter_walkable_low_height_spans(walkable_height);
    let mut compact = heightfield.into_compact(walkable_height, walkable_climb)?;
    compact.erode_walkable_area(config.radius_cells());
    for volume in volumes {
        compact.mark_convex_poly_area(volume);
    }
    compact.build_distance_field();
    let min_area = config.min_region_cells.saturating_mul(config.min_region_cells);
    let merge_area = config.merge_region_cells.saturating_mul(config.merge_region_cells);
    compact.build_regions(border_cells, min_area, merge_area)?;
    let max_edge_cells = (config.max_edge_length / config.cell_size).round().min(f32::from(u16::MAX)) as u16;
    let contours = compact.build_contours(config.max_simplification_error, max_edge_cells, BuildContoursFlags::default());
    let poly = contours.into_polygon_mesh(NAV_TILE_POLYGON_VERTICES_MAX as u16)?;
    let sample_distance = if config.detail_sample_cells < DETAIL_SAMPLE_CELLS_MIN { 0.0 } else { config.cell_size * config.detail_sample_cells };
    let detail = DetailNavmesh::new(&poly, &compact, sample_distance, config.cell_height * config.detail_max_error_cells)?;
    Ok((poly, detail))
}

/// A stage's refusal as a navigation refusal: an outline Recast cannot triangulate or a triangle
/// it cannot rasterize is the input's; running out of layers, regions or indices is size.
fn recast_refusal(error: RecastError) -> NavError {
    match error {
        RecastError::PolygonMesh(PolygonNavmeshError::InvalidContour) | RecastError::Rasterization(_) => {
            NavError::input_invalid(format!("Recast cannot cut this input: {error}"))
        }
        _ => NavError::too_large(format!("the tile is too large for Recast: {error}")),
    }
}

/// The floor (lowered to the window's lowest corner if that is below it) and the window's
/// highest corner; `None` without triangles.
fn height_range(window: &TileInput, floor: f32) -> Option<(f32, f32)> {
    let corners = window.triangles.iter().flatten();
    let (low, high) = corners.fold((f32::INFINITY, f32::NEG_INFINITY), |(low, high), v| (low.min(v.y), high.max(v.y)));
    if low > high {
        return None;
    }
    Some((floor.min(low), high.max(floor)))
}

/// The window's triangles as Recast's input, each triangle's area as its Recast area.
fn trimesh(window: &TileInput) -> TriMesh {
    let vertices: Vec<Vec3A> = window.triangles.iter().flatten().map(|&v| Vec3A::from(v)).collect();
    let indices = (0..window.triangles.len() as u32).map(|t| UVec3::new(3 * t, 3 * t + 1, 3 * t + 2)).collect();
    let area_types = window.areas.iter().map(|area| AreaType(area.raw())).collect();
    TriMesh { vertices, indices, area_types }
}

fn convex_volume(volume: &crate::input::AreaVolume) -> ConvexVolume {
    let (min_y, max_y) = volume.heights();
    ConvexVolume { vertices: volume.outline().to_vec(), min_y, max_y, area: AreaType(volume.area().raw()) }
}

/// The FNV-1a 64 digest of a tile's input window: the height floor, its triangles (by their
/// bits), their areas after the slope rule, and the volumes it marks.
fn window_digest(window: &TileInput, input: &NavInput, floor: f32) -> u64 {
    let mut bytes = Vec::with_capacity(window.triangles.len() * 37 + 16);
    bytes.extend_from_slice(&floor.to_bits().to_le_bytes());
    bytes.extend_from_slice(&(window.triangles.len() as u64).to_le_bytes());
    for (triangle, area) in window.triangles.iter().zip(&window.areas) {
        for value in triangle.iter().flat_map(|v| v.to_array()) {
            bytes.extend_from_slice(&value.to_bits().to_le_bytes());
        }
        bytes.push(area.raw());
    }
    for &index in &window.volumes {
        let volume = &input.volumes()[index];
        let (min_y, max_y) = volume.heights();
        bytes.push(volume.area().raw());
        for value in volume.outline().iter().flat_map(|p| p.to_array()).chain([min_y, max_y]) {
            bytes.extend_from_slice(&value.to_bits().to_le_bytes());
        }
    }
    fnv1a64(&bytes)
}

/// One cell coordinate of the tile in metres: an edge cell is the tile's edge exactly.
fn tile_coordinate(start: f32, cells: u16, tile_cells: u16, config: &BakeConfig) -> f32 {
    if cells == tile_cells {
        return start + config.tile;
    }
    start + f32::from(cells) * config.cell_size
}

/// Recast's polygon and detail meshes as a tile mesh in metres.
fn tile_mesh(poly: &PolygonNavmesh, detail: &DetailNavmesh, corner: Vec2, config: &BakeConfig, tile_cells: u16) -> TileMesh {
    let vertices = poly
        .vertices
        .iter()
        .map(|v| {
            let x = tile_coordinate(corner.x, v.x, tile_cells, config);
            let z = tile_coordinate(corner.y, v.z, tile_cells, config);
            Vec3::new(x, poly.aabb.min.y + f32::from(v.y) * poly.cell_height, z)
        })
        .collect();
    let corners = usize::from(poly.max_vertices_per_polygon);
    let polygons = poly
        .polygons
        .chunks_exact(corners)
        .map(|polygon| polygon.iter().copied().take_while(|&i| i != PolygonNavmesh::NO_INDEX).collect())
        .collect();
    let areas = poly.areas.iter().map(|area| area.0).collect();
    let detail_parts = detail
        .meshes
        .iter()
        .map(|m| DetailPart {
            base_vertex: m.base_vertex_index,
            vertex_count: m.vertex_count,
            base_triangle: m.base_triangle_index,
            triangle_count: m.triangle_count,
        })
        .collect();
    TileMesh { vertices, polygons, areas, detail_parts, detail_vertices: detail.vertices.clone(), detail_triangles: detail.triangles.clone() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn covering_cells_follow_the_grid_anchored_at_the_origin() {
        let cells = covering_cells(Vec2::new(-1.0, 0.0), Vec2::new(33.0, 31.0), 32.0);
        assert_eq!(cells, vec![CellId::new(-1, 0), CellId::new(0, 0), CellId::new(1, 0)]);
        assert_eq!(covering_cells(Vec2::ZERO, Vec2::splat(64.0), 32.0).len(), 4, "an edge on a tile line takes no extra tile");
        assert!(covering_cells(Vec2::ONE, Vec2::ZERO, 32.0).is_empty());
    }

    #[test]
    fn the_border_is_the_radius_in_cells_plus_three() {
        let config = BakeConfig::walker(0.5, 2.0);
        assert_eq!(config.radius_cells(), 3);
        assert_eq!(config.border_cells(), 6);
        assert_eq!(config.tile_cells(), 160);
    }

    #[test]
    fn a_config_that_cannot_bake_is_refused() {
        let base = BakeConfig::default();
        let bad = [
            BakeConfig { radius: 0.0, ..base.clone() },
            BakeConfig { cell_size: 0.01, ..base.clone() },
            BakeConfig { cell_height: f32::NAN, ..base.clone() },
            BakeConfig { slope_degrees: 90.0, ..base.clone() },
            BakeConfig { tile: 32.1, ..base.clone() },
            BakeConfig { tile: 1000.0, ..base.clone() },
            BakeConfig { height: 100.0, ..base.clone() },
        ];
        for config in bad {
            let refused = config.check().expect_err("refused");
            assert_eq!(refused.code, crate::error::NavErrorCode::ConfigInvalid, "{config:?}");
        }
        assert!(base.check().is_ok());
    }
}
