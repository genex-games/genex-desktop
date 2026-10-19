//! [`CellId`]: one square cell of the world's ground plane, the one key streaming and navigation
//! share. Cells sit on a grid anchored at world (0, 0); a nav tile grid's size divides the stream
//! cell size, so a stream cell holds whole nav tiles.

use serde::{Deserialize, Serialize};

/// A grid cell by its integer coordinates on the ground plane: `x` along world X, `z` along world
/// Z. It orders by `x`, then `z`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct CellId {
    /// The cell's column along world X.
    pub x: i32,
    /// The cell's row along world Z.
    pub z: i32,
}

impl CellId {
    /// The cell at column `x`, row `z`.
    pub const fn new(x: i32, z: i32) -> CellId {
        CellId { x, z }
    }
}
