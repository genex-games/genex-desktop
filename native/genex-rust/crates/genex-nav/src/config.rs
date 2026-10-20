//! `NavConfig`: the walker's radius, height, climb, slope, cell and tile sizes (NAV-11). It is
//! what `game.navigation(cfg)` registers and what every bake, tile and carve reads; the Recast
//! settings beneath it are [`BakeConfig`]'s.

use genex_core::cell::CellId;
use glam::Vec3;

use crate::bake::BakeConfig;
use crate::error::NavError;

/// How far a stream cell may sit from a whole number of nav tiles, as a fraction of the cell.
const STREAM_CELL_TOLERANCE: f32 = 1.0e-4;

/// How agents walk and how the nav is baked for them. Tiles sit on a grid of
/// [`NavConfig::tile`]-metre squares anchored at world (0, 0), keyed by [`CellId`].
#[derive(Clone, Debug, Default, PartialEq)]
pub struct NavConfig {
    bake: BakeConfig,
}

impl NavConfig {
    /// A walker `radius` wide and `height` tall: climb 0.4 m, slope 45°, cells 0.2 m by 0.1 m and
    /// 32 m tiles ([`BakeConfig::walker`]).
    pub fn walker(radius: f32, height: f32) -> NavConfig {
        NavConfig { bake: BakeConfig::walker(radius, height) }
    }

    /// A config over Recast settings already written out.
    pub fn from_bake(bake: BakeConfig) -> NavConfig {
        NavConfig { bake }
    }

    /// The highest step the walker climbs, in metres.
    pub fn with_climb(mut self, metres: f32) -> NavConfig {
        self.bake.climb = metres;
        self
    }

    /// The steepest ground the walker stands on, in degrees (0, 90).
    pub fn with_slope(mut self, degrees: f32) -> NavConfig {
        self.bake.slope_degrees = degrees;
        self
    }

    /// The voxel size: `cell` along x and z (at least 0.05 m), `height` along y (at least
    /// 0.02 m). Smaller is finer and slower to bake.
    pub fn with_cells(mut self, cell: f32, height: f32) -> NavConfig {
        self.bake.cell_size = cell;
        self.bake.cell_height = height;
        self
    }

    /// The tile edge in metres: a whole number of cells. A streamed world's cell size is a
    /// whole number of tiles ([`NavConfig::divides_stream_cell`]).
    pub fn with_tile(mut self, metres: f32) -> NavConfig {
        self.bake.tile = metres;
        self
    }

    /// The walker's radius, in metres.
    pub fn radius(&self) -> f32 {
        self.bake.radius
    }

    /// The walker's height, in metres.
    pub fn height(&self) -> f32 {
        self.bake.height
    }

    /// The highest step, in metres.
    pub fn climb(&self) -> f32 {
        self.bake.climb
    }

    /// The steepest walkable slope, in degrees.
    pub fn slope(&self) -> f32 {
        self.bake.slope_degrees
    }

    /// The tile edge, in metres.
    pub fn tile(&self) -> f32 {
        self.bake.tile
    }

    /// The Recast settings a bake runs with.
    pub fn bake_config(&self) -> &BakeConfig {
        &self.bake
    }

    /// Refused `nav-config-invalid` as [`BakeConfig::check`] refuses.
    pub fn check(&self) -> Result<(), NavError> {
        self.bake.check()
    }

    /// The digest every tile baked with this config records.
    pub fn digest(&self) -> u64 {
        self.bake.digest()
    }

    /// The tile holding `point` (its x and z), on the grid anchored at world (0, 0).
    pub fn tile_of(&self, point: Vec3) -> CellId {
        let at = |v: f32| (v / self.bake.tile).floor() as i32;
        CellId::new(at(point.x), at(point.z))
    }

    /// Whether a stream cell of `cell_size` metres holds a whole number of tiles (at least one),
    /// so every stream cell's nav is whole tiles. A positive, finite tile is assumed
    /// ([`NavConfig::check`]).
    pub fn divides_stream_cell(&self, cell_size: f32) -> bool {
        let tile = self.bake.tile;
        let usable = cell_size.is_finite() && tile.is_finite() && tile > 0.0 && cell_size >= tile;
        if !usable {
            return false;
        }
        let tiles = (cell_size / tile).round();
        (tiles * tile - cell_size).abs() <= STREAM_CELL_TOLERANCE * cell_size
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_cells_must_hold_whole_tiles() {
        let config = NavConfig::walker(0.4, 1.8).with_tile(16.0);
        assert!(config.divides_stream_cell(16.0));
        assert!(config.divides_stream_cell(64.0));
        assert!(!config.divides_stream_cell(24.0));
        assert!(!config.divides_stream_cell(8.0), "a cell smaller than a tile");
        assert!(!config.divides_stream_cell(f32::NAN));
    }

    #[test]
    fn tiles_sit_on_a_grid_anchored_at_the_origin() {
        let config = NavConfig::walker(0.4, 1.8).with_tile(8.0);
        assert_eq!(config.tile_of(Vec3::new(0.0, 5.0, 0.0)), CellId::new(0, 0));
        assert_eq!(config.tile_of(Vec3::new(-0.1, 0.0, 8.0)), CellId::new(-1, 1));
        assert_eq!(config.tile_of(Vec3::new(15.99, 0.0, -8.01)), CellId::new(1, -2));
    }
}
