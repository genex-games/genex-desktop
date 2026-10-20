//! Streamed nav islands (STR-11): each sim cell of a streamed world brings its nav tiles as an
//! island, added to the [`Nav`] in the stream commit when the cell enters the sim set and removed
//! when it leaves. genex-stream's `StreamNav` trait is the slot; [`StreamedNav`] is genex-nav's
//! side of it (the facade, which sees both crates, joins them).
//!
//! An island comes from an offline bake: the cell's `.navmesh` bytes ([`NavIsland::from_bytes`],
//! what `bakeAssets` kind `nav` writes), read on the cell's build worker; on the web this is the
//! only path. [`NavIsland::bake_cell`] bakes a cell's tiles on the calling thread, for a native
//! build worker only, never inside a frame.
//!
//! [`NavIslands`] is the ledger of which tiles each cell brought. A cell's tiles go in in island
//! order and come out in reverse, so a cell that leaves and enters again takes the same runtime
//! slots back, and the nav replays the same whatever order the builds finished in. Agents standing
//! on a cell that leaves go `off-mesh` and freeze (their path is dropped with the island); when the
//! cell enters again they search again at the next update and walk on toward the same target.

use std::collections::BTreeMap;

use genex_core::cell::CellId;
use genex_core::digest::{fnv1a64, fnv1a64_from};

use crate::config::NavConfig;
use crate::error::NavError;
use crate::input::NavInput;
use crate::tile::NavTile;
use crate::world::{Nav, NavMesh};

/// One sim cell's nav tiles, as its build carries them.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct NavIsland {
    tiles: Vec<NavTile>,
}

impl NavIsland {
    /// An island of these tiles, in the order given.
    pub fn from_tiles(tiles: Vec<NavTile>) -> NavIsland {
        NavIsland { tiles }
    }

    /// The island an offline bake wrote: `.navmesh` bytes ([`NavMesh::to_bytes`]) of the cell's
    /// tiles. Refused as [`NavMesh::from_bytes`] refuses.
    pub fn from_bytes(bytes: &[u8]) -> Result<NavIsland, NavError> {
        Ok(NavIsland { tiles: NavMesh::from_bytes(bytes)?.tiles().to_vec() })
    }

    /// Bake the tiles of the stream cell `cell` (of `cell_size` metres, a whole number of
    /// `config` tiles a side) from `input`, row by row, leaving out tiles with no ground. On the
    /// calling thread: a native cell build worker only, never a frame (the web reads
    /// [`NavIsland::from_bytes`]). Refused `nav-config-invalid` for a cell size that is not a
    /// whole number of tiles, and as [`NavMesh::bake_tile`] refuses.
    pub fn bake_cell(input: &NavInput, config: &NavConfig, cell: CellId, cell_size: f32) -> Result<NavIsland, NavError> {
        if !config.divides_stream_cell(cell_size) {
            return Err(NavError::config_invalid(format!("a {cell_size} m cell is not a whole number of {} m tiles", config.tile())));
        }
        let per_side = (cell_size / config.tile()).round() as i32;
        let mut tiles = Vec::new();
        for z in 0..per_side {
            for x in 0..per_side {
                let tile_cell = CellId { x: cell.x * per_side + x, z: cell.z * per_side + z };
                let tile = NavMesh::bake_tile(input, config, tile_cell)?;
                if tile.polygon_count() > 0 {
                    tiles.push(tile);
                }
            }
        }
        Ok(NavIsland { tiles })
    }

    /// The tiles, in the order they go in.
    pub fn tiles(&self) -> &[NavTile] {
        &self.tiles
    }

    /// The island as `.navmesh`-style bytes for its tiles alone (what an offline bake stores).
    pub fn to_bytes(&self, config: &NavConfig) -> Vec<u8> {
        let mesh_bytes = |tiles: &[NavTile]| {
            let mut out = Vec::new();
            out.extend_from_slice(b"GXNM");
            out.extend_from_slice(&crate::world::NAV_MESH_VERSION.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(&config.digest().to_le_bytes());
            out.extend_from_slice(&0u64.to_le_bytes());
            out.extend_from_slice(&(tiles.len() as u32).to_le_bytes());
            for tile in tiles {
                let bytes = tile.to_bytes();
                out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
                out.extend_from_slice(&bytes);
            }
            let digest = fnv1a64(&out);
            out.extend_from_slice(&digest.to_le_bytes());
            out
        };
        mesh_bytes(&self.tiles)
    }
}

/// Which tiles each streamed cell brought into a nav. It lives with the nav it fills (a reseed
/// starts both fresh), and only the commit slot changes it.
#[derive(Clone, Debug, Default)]
pub struct NavIslands {
    cells: BTreeMap<CellId, Vec<CellId>>,
}

impl NavIslands {
    /// `cell` enters with `island`: its tiles go into `nav` in island order (a cell already in
    /// leaves first). Returns how many tiles came in. Refused, with nothing added:
    /// `nav-tile-invalid` for a tile another streamed cell holds or two tiles at one place, and as
    /// [`Nav::add_tile`] refuses.
    pub fn enter(&mut self, nav: &mut Nav, cell: CellId, island: &NavIsland) -> Result<usize, NavError> {
        self.leave(nav, cell);
        let mut seen = genex_core::map::Set::default();
        for tile in island.tiles() {
            let held = self.cells.values().any(|tiles| tiles.contains(&tile.cell()));
            if held || !seen.insert(tile.cell()) {
                return Err(NavError::tile_invalid(format!("cell {cell:?} brings tile {:?}, which is already streamed in", tile.cell())));
            }
        }
        let mut added = Vec::with_capacity(island.tiles().len());
        for tile in island.tiles() {
            if let Err(refused) = nav.add_tile(tile) {
                for tile_cell in added.iter().rev() {
                    nav.remove_tile(*tile_cell);
                }
                return Err(refused);
            }
            added.push(tile.cell());
        }
        let count = added.len();
        self.cells.insert(cell, added);
        Ok(count)
    }

    /// `cell` leaves: its tiles come out of `nav` in reverse island order. Returns how many were
    /// removed (0 when the cell is not in).
    pub fn leave(&mut self, nav: &mut Nav, cell: CellId) -> usize {
        let Some(tiles) = self.cells.remove(&cell) else { return 0 };
        tiles.iter().rev().filter(|tile_cell| nav.remove_tile(**tile_cell)).count()
    }

    /// Every cell leaves, descending: the nav keeps only the tiles the game added itself.
    pub fn clear(&mut self, nav: &mut Nav) {
        let cells: Vec<CellId> = self.cells.keys().rev().copied().collect();
        for cell in cells {
            self.leave(nav, cell);
        }
    }

    /// The streamed cells whose islands are in, ascending.
    pub fn cells(&self) -> impl Iterator<Item = CellId> + '_ {
        self.cells.keys().copied()
    }

    /// The tiles `cell` brought, in island order (empty when it is not in).
    pub fn tiles(&self, cell: CellId) -> &[CellId] {
        self.cells.get(&cell).map_or(&[], Vec::as_slice)
    }

    /// FNV-1a 64 of the streamed islands: cells ascending, each cell's tiles in order with their
    /// tile digests as resident in `nav`.
    pub fn digest(&self, nav: &Nav) -> u64 {
        let mut hash = fnv1a64(&(self.cells.len() as u64).to_le_bytes());
        for (cell, tiles) in &self.cells {
            hash = fnv1a64_from(&cell.x.to_le_bytes(), hash);
            hash = fnv1a64_from(&cell.z.to_le_bytes(), hash);
            for tile_cell in tiles {
                let digest = nav.tile(*tile_cell).map_or(0, NavTile::digest);
                hash = fnv1a64_from(&digest.to_le_bytes(), hash);
            }
        }
        hash
    }
}

/// A nav and its island ledger together: genex-nav's side of genex-stream's `StreamNav` slot
/// (`island_leave`, `island_enter`), which the facade's commit hook drives.
#[derive(Debug)]
pub struct StreamedNav<'a> {
    /// The nav the islands go into.
    pub nav: &'a mut Nav,
    /// Which tiles each cell brought.
    pub islands: &'a mut NavIslands,
}

impl StreamedNav<'_> {
    /// `cell` leaves: see [`NavIslands::leave`].
    pub fn island_leave(&mut self, cell: CellId) -> usize {
        self.islands.leave(self.nav, cell)
    }

    /// `cell` enters: see [`NavIslands::enter`]; a refused island adds nothing and counts 0.
    pub fn island_enter(&mut self, cell: CellId, island: &NavIsland) -> usize {
        self.islands.enter(self.nav, cell, island).unwrap_or(0)
    }
}
