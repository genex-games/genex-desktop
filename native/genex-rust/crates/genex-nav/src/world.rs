//! `Nav`: the navigation world a game's `sim.nav` holds (the runtime owns it, as it owns physics),
//! and `NavMesh`, the baked tiles over one input (NAV-11).
//!
//! A [`NavMesh`] is every non-empty tile over its input's bounds, baked on the calling thread in
//! row order (z, then x) with one height floor, so a bake at load and an offline bake of one
//! input are byte-equal. [`NavMesh::bake`] goes through the process-wide memo
//! ([`crate::memo`]): baking the same input twice in one process hands back the first bake.
//! `.navmesh` bytes ([`NavMesh::to_bytes`]) carry the input's digest, so
//! [`NavMesh::from_bytes_for`] can tell bytes baked from another input and bake afresh, which it
//! reports as [`NavMeshSource::Rebaked`] (`nav-bake-stale` in volatile, written by the runtime):
//!
//! ```text
//! "GXNM" | u16 version | u16 0 | u64 config digest | u64 input digest | u32 tiles
//! per tile: u32 length, then that many bytes of `NavTile::to_bytes`
//! u64 FNV-1a 64 digest of everything before it
//! ```
//!
//! A [`Nav`] holds resident tiles as islands of the ported runtime (stitched at their shared
//! edges on the next update), the area costs and gates, and the obstacles with their carving
//! queue ([`crate::carve`]). Every refused call leaves it exactly as it was. NAV-12 adds the
//! agent, link, body and query calls in `agents_api.rs`.

use std::sync::Arc;

use genex_core::cell::CellId;
use genex_core::digest::fnv1a64;
use genex_core::map::{Map, Set};
use glam::Vec2;

use crate::bake::{bake_tile_on_floor, covering_cells, height_floor};
use crate::carve::{Carving, NAV_BAKE_UNITS_PER_TICK_DEFAULT, NavObstacle};
use crate::config::NavConfig;
use crate::error::NavError;
use crate::ids::NavObstacleId;
use crate::input::{NavArea, NavInput};
use crate::memo::{self, MemoKey};
use crate::runtime::archipelago::{Archipelago, ArchipelagoOptions, SEARCH_NODES_DEFAULT, SEARCHES_PER_TICK_DEFAULT, SearchBudget};
use crate::runtime::coords::{FromAgentRadius, GenexCoords};
use crate::runtime::island::{Island, IslandId};
use crate::runtime::nav_mesh::ValidNavigationMesh;
use crate::runtime::util::Transform;
use crate::tile::NavTile;

/// Tiles one nav (and one mesh) may hold.
pub const NAV_TILES_MAX: usize = 4096;
/// The `.navmesh` format version [`NavMesh::to_bytes`] writes and [`NavMesh::from_bytes`] reads.
pub const NAV_MESH_VERSION: u16 = 1;
/// A* nodes one search expands by default.
pub const NAV_SEARCH_NODES_DEFAULT: u32 = SEARCH_NODES_DEFAULT;
/// Path searches one update runs by default.
pub const NAV_SEARCHES_PER_TICK_DEFAULT: u32 = SEARCHES_PER_TICK_DEFAULT;
/// The four bytes `.navmesh` bytes start with.
const MESH_MAGIC: [u8; 4] = *b"GXNM";
/// Magic, version, padding, config digest, input digest, tile count.
const MESH_HEADER_BYTES: usize = 4 + 2 + 2 + 8 + 8 + 4;
/// The trailing digest.
const MESH_DIGEST_BYTES: usize = 8;

/// Where a [`NavMesh`] came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NavMeshSource {
    /// Baked by this call.
    Baked,
    /// The process-wide memo's earlier bake of the same input and config.
    Memo,
    /// Read from bytes (baked from this input, when read with [`NavMesh::from_bytes_for`]).
    Bytes,
    /// Bytes baked from another input or config, so baked afresh: `nav-bake-stale`.
    Rebaked,
}

impl NavMeshSource {
    /// The volatile code the runtime reports for this source: `nav-bake-stale` for
    /// [`NavMeshSource::Rebaked`], nothing otherwise.
    pub const fn volatile_code(self) -> Option<&'static str> {
        match self {
            NavMeshSource::Rebaked => Some("nav-bake-stale"),
            NavMeshSource::Baked | NavMeshSource::Memo | NavMeshSource::Bytes => None,
        }
    }
}

/// The baked tiles over one input: cheap to clone (the tiles are shared).
#[derive(Clone, Debug)]
pub struct NavMesh {
    tiles: Arc<[NavTile]>,
    config_digest: u64,
    input_digest: u64,
    input: Option<Arc<NavInput>>,
    digest: u64,
    source: NavMeshSource,
}

impl PartialEq for NavMesh {
    /// Equal tiles from equal digests; where the mesh came from does not count.
    fn eq(&self, other: &NavMesh) -> bool {
        self.digest == other.digest && self.tiles == other.tiles
    }
}

impl NavMesh {
    /// Bake every tile over the input's bounds on the calling thread, or take the memo's bake of
    /// the same input and config. Tiles with no ground are left out. Refused
    /// `nav-config-invalid` as [`NavConfig::check`] refuses, `nav-too-large` when the bounds
    /// cover more than [`NAV_TILES_MAX`] tiles (before anything is baked), and as
    /// [`crate::bake::bake_tile`] refuses.
    pub fn bake(input: &NavInput, config: &NavConfig) -> Result<NavMesh, NavError> {
        config.check()?;
        let input_digest = input.digest();
        let key = MemoKey::new(input_digest, config.digest());
        let remembered = memo::global().as_mut().and_then(|memo| memo.get(key));
        let shared = Some(Arc::new(input.clone()));
        if let Some(tiles) = remembered {
            return Ok(NavMesh::assemble(tiles, config.digest(), input_digest, shared, NavMeshSource::Memo));
        }
        let tiles: Arc<[NavTile]> = bake_tiles(input, config)?.into();
        if let Some(memo) = memo::global().as_mut() {
            memo.insert(key, tiles.clone());
        }
        Ok(NavMesh::assemble(tiles, config.digest(), input_digest, shared, NavMeshSource::Baked))
    }

    /// Bake one tile (streamed worlds bake or load per cell). Refused as [`NavMesh::bake`].
    pub fn bake_tile(input: &NavInput, config: &NavConfig, cell: CellId) -> Result<NavTile, NavError> {
        config.check()?;
        crate::bake::bake_tile(input, config.bake_config(), cell)
    }

    /// The mesh `bytes` hold when they were baked from `input` under `config`; otherwise a fresh
    /// bake of `input`, reported [`NavMeshSource::Rebaked`]. Refused as [`NavMesh::from_bytes`]
    /// refuses the bytes, and as [`NavMesh::bake`].
    pub fn from_bytes_for(input: &NavInput, config: &NavConfig, bytes: &[u8]) -> Result<NavMesh, NavError> {
        config.check()?;
        let mut mesh = NavMesh::from_bytes(bytes)?;
        let current = mesh.input_digest == input.digest() && mesh.config_digest == config.digest();
        if current {
            mesh.input = Some(Arc::new(input.clone()));
            return Ok(mesh);
        }
        let mut fresh = NavMesh::bake(input, config)?;
        fresh.source = NavMeshSource::Rebaked;
        Ok(fresh)
    }

    /// Reads `.navmesh` bytes [`NavMesh::to_bytes`] wrote (without their input: a nav holding
    /// only these tiles can avoid but not carve). Refused `nav-tile-invalid`, with nothing
    /// allocated past what the bytes hold: too short, another magic or version, a digest that
    /// does not match, more than [`NAV_TILES_MAX`] tiles, a tile length past the bytes left, a
    /// tile [`NavTile::from_bytes`] refuses, a tile of another config, two tiles at one cell, or
    /// trailing bytes.
    pub fn from_bytes(bytes: &[u8]) -> Result<NavMesh, NavError> {
        if bytes.len() < MESH_HEADER_BYTES + MESH_DIGEST_BYTES {
            return Err(NavError::tile_invalid(format!("{} bytes is shorter than a navmesh header", bytes.len())));
        }
        let (body, tail) = bytes.split_at(bytes.len() - MESH_DIGEST_BYTES);
        if body[..4] != MESH_MAGIC {
            return Err(NavError::tile_invalid("not a navmesh (magic)"));
        }
        let version = u16::from_le_bytes([body[4], body[5]]);
        if version != NAV_MESH_VERSION {
            return Err(NavError::tile_invalid(format!("navmesh format version {version}, this build reads {NAV_MESH_VERSION}")));
        }
        if fnv1a64(body) != u64::from_le_bytes(tail.try_into().expect("eight bytes")) {
            return Err(NavError::tile_invalid("the navmesh's digest does not match its bytes"));
        }
        let config_digest = u64::from_le_bytes(body[8..16].try_into().expect("eight bytes"));
        let input_digest = u64::from_le_bytes(body[16..24].try_into().expect("eight bytes"));
        let count = u32::from_le_bytes(body[24..28].try_into().expect("four bytes")) as usize;
        let tiles = read_tiles(&body[MESH_HEADER_BYTES..], count, config_digest)?;
        Ok(NavMesh::assemble(tiles.into(), config_digest, input_digest, None, NavMeshSource::Bytes))
    }

    /// The mesh as `.navmesh` bytes, digest last.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(MESH_HEADER_BYTES + MESH_DIGEST_BYTES + self.tiles.iter().map(|t| t.memory_bytes() + 128).sum::<usize>());
        out.extend_from_slice(&MESH_MAGIC);
        out.extend_from_slice(&NAV_MESH_VERSION.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&self.config_digest.to_le_bytes());
        out.extend_from_slice(&self.input_digest.to_le_bytes());
        // A mesh holds at most NAV_TILES_MAX tiles, and a tile's bytes stay far below 4 GiB.
        out.extend_from_slice(&(self.tiles.len() as u32).to_le_bytes());
        for tile in self.tiles.iter() {
            let bytes = tile.to_bytes();
            out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
            out.extend_from_slice(&bytes);
        }
        let digest = fnv1a64(&out);
        out.extend_from_slice(&digest.to_le_bytes());
        out
    }

    /// The tiles, in row order (z, then x).
    pub fn tiles(&self) -> &[NavTile] {
        &self.tiles
    }

    /// The FNV-1a 64 digest of the config and input digests and every tile's digest in order.
    pub fn digest(&self) -> u64 {
        self.digest
    }

    /// The digest of the input the tiles were baked from ([`NavInput::digest`]).
    pub fn input_digest(&self) -> u64 {
        self.input_digest
    }

    /// The digest of the config the tiles were baked with ([`NavConfig::digest`]).
    pub fn config_digest(&self) -> u64 {
        self.config_digest
    }

    /// Where the mesh came from.
    pub fn source(&self) -> NavMeshSource {
        self.source
    }

    /// The input the tiles were baked from, when the mesh has it (not for bytes read alone).
    pub fn input(&self) -> Option<&Arc<NavInput>> {
        self.input.as_ref()
    }

    fn assemble(tiles: Arc<[NavTile]>, config_digest: u64, input_digest: u64, input: Option<Arc<NavInput>>, source: NavMeshSource) -> NavMesh {
        let mut bytes = Vec::with_capacity(24 + tiles.len() * 8);
        bytes.extend_from_slice(&config_digest.to_le_bytes());
        bytes.extend_from_slice(&input_digest.to_le_bytes());
        bytes.extend_from_slice(&(tiles.len() as u64).to_le_bytes());
        for tile in tiles.iter() {
            bytes.extend_from_slice(&tile.digest().to_le_bytes());
        }
        NavMesh { digest: fnv1a64(&bytes), tiles, config_digest, input_digest, input, source }
    }
}

/// Every non-empty tile over `input`'s bounds, after a cap check on the count.
fn bake_tiles(input: &NavInput, config: &NavConfig) -> Result<Vec<NavTile>, NavError> {
    let Some((min, max)) = input.bounds() else {
        return Ok(Vec::new());
    };
    let tile = config.tile();
    let span = |low: f32, high: f32| f64::from((high / tile).ceil() - (low / tile).floor()).max(1.0);
    let count = span(min.x, max.x) * span(min.z, max.z);
    if count > NAV_TILES_MAX as f64 {
        return Err(NavError::too_large(format!("the input's bounds cover {count} tiles (max {NAV_TILES_MAX})")));
    }
    let floor = height_floor(input).unwrap_or(0.0);
    let mut tiles = Vec::new();
    for cell in covering_cells(Vec2::new(min.x, min.z), Vec2::new(max.x, max.z), tile) {
        let baked = bake_tile_on_floor(input, config.bake_config(), cell, floor)?;
        if baked.polygon_count() > 0 {
            tiles.push(baked);
        }
    }
    Ok(tiles)
}

/// `count` length-prefixed tiles of `config_digest` from `bytes`, which they must fill exactly.
fn read_tiles(bytes: &[u8], count: usize, config_digest: u64) -> Result<Vec<NavTile>, NavError> {
    if count > NAV_TILES_MAX || count.saturating_mul(4) > bytes.len() {
        return Err(NavError::tile_invalid(format!("{count} tiles (max {NAV_TILES_MAX}) in {} bytes", bytes.len())));
    }
    let mut tiles = Vec::with_capacity(count);
    let mut cells = Set::default();
    let mut at = 0usize;
    for index in 0..count {
        let length = bytes.get(at..at + 4).map(|b| u32::from_le_bytes(b.try_into().expect("four bytes")) as usize);
        let end = length.and_then(|length| (at + 4).checked_add(length)).filter(|&end| end <= bytes.len());
        let Some(end) = end else {
            return Err(NavError::tile_invalid(format!("tile {index} runs past the bytes")));
        };
        let tile = NavTile::from_bytes(&bytes[at + 4..end])?;
        if tile.config_digest() != config_digest || !cells.insert(tile.cell()) {
            return Err(NavError::tile_invalid(format!("tile {index} is of another config or repeats cell {:?}", tile.cell())));
        }
        tiles.push(tile);
        at = end;
    }
    if at != bytes.len() {
        return Err(NavError::tile_invalid(format!("{} bytes after the tiles", bytes.len() - at)));
    }
    Ok(tiles)
}

/// Work one [`Nav::update`] may do, counted in work units, never time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NavBudget {
    /// Path searches per update; agents past it wait their turn.
    pub searches_per_tick: u32,
    /// A* nodes one search expands before it gives up.
    pub search_nodes: u32,
    /// Carving stage units per update (seven rebuild one tile).
    pub bake_units_per_tick: u32,
}

impl Default for NavBudget {
    fn default() -> Self {
        NavBudget {
            searches_per_tick: NAV_SEARCHES_PER_TICK_DEFAULT,
            search_nodes: NAV_SEARCH_NODES_DEFAULT,
            bake_units_per_tick: NAV_BAKE_UNITS_PER_TICK_DEFAULT,
        }
    }
}

/// A resident tile and the island it is, when it has polygons.
#[derive(Clone, Debug)]
pub(crate) struct Resident {
    pub(crate) tile: NavTile,
    pub(crate) island: Option<IslandId>,
}

/// The navigation world: tiles, area costs and gates, obstacles (and, with NAV-12, agents, links
/// and bodies). `Nav::default()` is empty, for the default walker.
pub struct Nav {
    pub(crate) config: NavConfig,
    pub(crate) budget: NavBudget,
    pub(crate) archipelago: Archipelago<GenexCoords>,
    pub(crate) tiles: Map<CellId, Resident>,
    /// Obstacles and their rebuild queue; `None` for a config that cannot bake (nothing can be
    /// added to such a nav).
    pub(crate) carving: Option<Carving>,
    rebuilds_refused: u64,
}

impl Default for Nav {
    fn default() -> Self {
        Nav::new(&NavConfig::default())
    }
}

impl std::fmt::Debug for Nav {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Nav")
            .field("config", &self.config)
            .field("budget", &self.budget)
            .field("tiles", &self.tiles.len())
            .field("obstacles", &self.carving.as_ref().map_or(0, |c| c.obstacles().count()))
            .field("pending_rebuilds", &self.pending_rebuilds())
            .finish_non_exhaustive()
    }
}

impl Nav {
    /// An empty nav for walkers of `config`. A config [`NavConfig::check`] refuses gives a nav
    /// that refuses every tile and obstacle `nav-config-invalid`.
    pub fn new(config: &NavConfig) -> Nav {
        let mut options = ArchipelagoOptions::<GenexCoords>::from_agent_radius(config.radius());
        let budget = NavBudget::default();
        options.budget = SearchBudget { searches_per_tick: budget.searches_per_tick, search_nodes: budget.search_nodes };
        Nav {
            config: config.clone(),
            budget,
            archipelago: Archipelago::new(options),
            tiles: Map::default(),
            carving: Carving::without_input(config.bake_config().clone()).ok(),
            rebuilds_refused: 0,
        }
    }

    /// The same nav with another work budget.
    pub fn with_budget(mut self, budget: NavBudget) -> Nav {
        self.budget = budget;
        self.archipelago.archipelago_options.budget = SearchBudget { searches_per_tick: budget.searches_per_tick, search_nodes: budget.search_nodes };
        self
    }

    /// The walker config.
    pub fn config(&self) -> &NavConfig {
        &self.config
    }

    /// The work budget.
    pub fn budget(&self) -> NavBudget {
        self.budget
    }

    /// The ported runtime underneath (read-only: queries, probes and debug draws).
    pub fn archipelago(&self) -> &Archipelago<GenexCoords> {
        &self.archipelago
    }

    fn carving(&self) -> Result<&Carving, NavError> {
        self.carving.as_ref().ok_or_else(|| NavError::config_invalid("this nav's config cannot bake"))
    }

    fn carving_mut(&mut self) -> Result<&mut Carving, NavError> {
        self.carving.as_mut().ok_or_else(|| NavError::config_invalid("this nav's config cannot bake"))
    }

    /// Make every tile of `mesh` resident, replacing the tiles at its cells; the mesh's input
    /// becomes the one carving rebuilds from. Refused, with nothing changed:
    /// `nav-config-invalid` for a mesh baked with another config (or a nav whose config cannot
    /// bake), `nav-too-large` past [`NAV_TILES_MAX`] resident tiles, `nav-tile-invalid` for a
    /// tile the runtime cannot use.
    pub fn add_mesh(&mut self, mesh: &NavMesh) -> Result<(), NavError> {
        self.carving()?;
        if mesh.config_digest() != self.config.digest() {
            return Err(NavError::config_invalid("the mesh was baked for another walker config"));
        }
        let added = mesh.tiles().iter().filter(|tile| !self.tiles.contains_key(&tile.cell())).count();
        if self.tiles.len() + added > NAV_TILES_MAX {
            return Err(NavError::too_large(format!("{} resident tiles with the mesh (max {NAV_TILES_MAX})", self.tiles.len() + added)));
        }
        let islands = mesh.tiles().iter().map(island_mesh).collect::<Result<Vec<_>, NavError>>()?;
        for (tile, island) in mesh.tiles().iter().zip(islands) {
            self.place(tile.clone(), island);
        }
        let carving = self.carving_mut()?;
        for tile in mesh.tiles() {
            carving.tile_added(tile.cell());
        }
        carving.set_input(mesh.input().cloned());
        Ok(())
    }

    /// Make `tile` resident, replacing the tile at its cell (a streamed cell). Refused as
    /// [`Nav::add_mesh`], with nothing changed.
    pub fn add_tile(&mut self, tile: &NavTile) -> Result<(), NavError> {
        self.carving()?;
        if tile.config_digest() != self.config.digest() {
            return Err(NavError::config_invalid("the tile was baked for another walker config"));
        }
        if !self.tiles.contains_key(&tile.cell()) && self.tiles.len() >= NAV_TILES_MAX {
            return Err(NavError::too_large(format!("more than {NAV_TILES_MAX} resident tiles")));
        }
        let island = island_mesh(tile)?;
        self.place(tile.clone(), island);
        // A replaced tile comes back uncarved: leaving and arriving again queues its carving.
        let carving = self.carving_mut()?;
        carving.tile_removed(tile.cell());
        carving.tile_added(tile.cell());
        Ok(())
    }

    /// Drop the tile at `cell` (a cell streamed out); false when none is resident.
    pub fn remove_tile(&mut self, cell: CellId) -> bool {
        let Some(resident) = self.tiles.shift_remove(&cell) else {
            return false;
        };
        if let Some(island) = resident.island {
            self.archipelago.remove_island(island);
        }
        if let Some(carving) = self.carving.as_mut() {
            carving.tile_removed(cell);
        }
        true
    }

    /// The resident tiles' cells, in the order they became resident.
    pub fn tiles(&self) -> impl Iterator<Item = CellId> + '_ {
        self.tiles.keys().copied()
    }

    /// The resident tile at `cell`.
    pub fn tile(&self, cell: CellId) -> Option<&NavTile> {
        self.tiles.get(&cell).map(|resident| &resident.tile)
    }

    /// How many tiles are resident.
    pub fn tile_count(&self) -> usize {
        self.tiles.len()
    }

    /// The bytes the resident tiles' geometry takes.
    pub fn memory_bytes(&self) -> usize {
        self.tiles.values().map(|resident| resident.tile.memory_bytes()).sum()
    }

    /// The FNV-1a 64 digest of the resident tiles by cell (ascending) and tile digest: equal
    /// for equal tiles however they arrived.
    pub fn digest(&self) -> u64 {
        let mut cells: Vec<(CellId, u64)> = self.tiles.iter().map(|(cell, resident)| (*cell, resident.tile.digest())).collect();
        cells.sort_unstable();
        let mut bytes = Vec::with_capacity(cells.len() * 16);
        for (cell, digest) in cells {
            bytes.extend_from_slice(&cell.x.to_le_bytes());
            bytes.extend_from_slice(&cell.z.to_le_bytes());
            bytes.extend_from_slice(&digest.to_le_bytes());
        }
        fnv1a64(&bytes)
    }

    /// What walking `area` costs per metre for every agent and query (1 by default). Refused
    /// `nav-cost-invalid` for a cost that is not finite and above zero, or the null area.
    pub fn set_area_cost(&mut self, area: NavArea, cost: f32) -> Result<(), NavError> {
        let usable = area != NavArea::NONE && cost.is_finite() && cost > 0.0;
        if !usable {
            return Err(NavError::cost_invalid(format!("a cost of {cost} for area {}: finite, above zero, not the null area", area.raw())));
        }
        self.archipelago.set_type_index_cost(usize::from(area.raw()), cost).map_err(|error| NavError::cost_invalid(error.to_string()))
    }

    /// The cost of `area` per metre (1 unless set).
    pub fn area_cost(&self, area: NavArea) -> f32 {
        self.archipelago.get_type_index_cost(usize::from(area.raw())).unwrap_or(1.0)
    }

    /// Open or shut `area` (a door); agents whose corridor crosses a newly shut area search again
    /// at the next update. False when it already was.
    pub fn set_area_open(&mut self, area: NavArea, open: bool) -> bool {
        self.archipelago.gates_mut().set_area_open(usize::from(area.raw()), open)
    }

    /// Add an obstacle: an avoid disc, or a carving shape whose tiles rebuild over the next
    /// updates. Refused, with nothing changed, as [`Carving::add`] refuses (a carving shape needs
    /// the input of a mesh added with [`Nav::add_mesh`]).
    pub fn add_obstacle(&mut self, obstacle: NavObstacle) -> Result<NavObstacleId, NavError> {
        self.carving_mut()?.add(obstacle)
    }

    /// Move or reshape an obstacle; false for an unknown id or a shape [`Carving::set`] refuses
    /// (nothing changes).
    pub fn move_obstacle(&mut self, obstacle: NavObstacleId, to: NavObstacle) -> bool {
        self.carving.as_mut().is_some_and(|carving| carving.set(obstacle, to).unwrap_or(false))
    }

    /// Remove an obstacle; false for an unknown id.
    pub fn remove_obstacle(&mut self, obstacle: NavObstacleId) -> bool {
        self.carving.as_mut().is_some_and(|carving| carving.remove(obstacle))
    }

    /// The obstacle `id` names, if it is live.
    pub fn obstacle(&self, id: NavObstacleId) -> Option<&NavObstacle> {
        self.carving.as_ref().and_then(|carving| carving.get(id))
    }

    /// Every live obstacle, in the order added.
    pub fn obstacles(&self) -> impl Iterator<Item = (NavObstacleId, &NavObstacle)> + '_ {
        self.carving.iter().flat_map(Carving::obstacles)
    }

    /// Tile rebuilds carving needs before the mesh is current (0: settled).
    pub fn pending_rebuilds(&self) -> usize {
        self.carving.as_ref().map_or(0, Carving::pending)
    }

    /// Carving rebuilds that failed (the old tile stayed), since the nav was made.
    pub fn rebuilds_refused(&self) -> u64 {
        self.rebuilds_refused
    }

    /// One tick: work the carving queue by the budget's stage units and swap in what finished,
    /// then the runtime's update (stitching, and with NAV-12 agents) over `dt` seconds.
    pub fn update(&mut self, dt: f32) {
        let finished = self.carving.as_mut().map(|carving| carving.advance(self.budget.bake_units_per_tick)).unwrap_or_default();
        for rebuilt in finished {
            let swapped = rebuilt.tile.and_then(|tile| island_mesh(&tile).map(|island| (tile, island)));
            match swapped {
                Ok((tile, island)) if self.tiles.contains_key(&rebuilt.cell) => self.place(tile, island),
                Ok(_) => {}
                Err(_) => self.rebuilds_refused += 1,
            }
        }
        self.archipelago.update(dt);
    }

    /// Put `tile` at its cell: its island's mesh replaced in place (keeping the island id), a new
    /// island, or no island for a tile with no polygons.
    fn place(&mut self, tile: NavTile, mesh: Option<Arc<ValidNavigationMesh<GenexCoords>>>) {
        let cell = tile.cell();
        let old = self.tiles.get(&cell).and_then(|resident| resident.island);
        let island = match (old, mesh) {
            (Some(id), Some(mesh)) => {
                if let Some(mut island) = self.archipelago.get_island_mut(id) {
                    island.set_nav_mesh(mesh);
                }
                Some(id)
            }
            (None, Some(mesh)) => Some(self.archipelago.add_island(Island::new(Transform::default(), mesh))),
            (Some(id), None) => {
                self.archipelago.remove_island(id);
                None
            }
            (None, None) => None,
        };
        self.tiles.insert(cell, Resident { tile, island });
    }
}

/// The runtime mesh of `tile`, `None` for a tile with no polygons. Refused `nav-tile-invalid`
/// for a tile the runtime's validation refuses.
fn island_mesh(tile: &NavTile) -> Result<Option<Arc<ValidNavigationMesh<GenexCoords>>>, NavError> {
    if tile.polygon_count() == 0 {
        return Ok(None);
    }
    let mesh = tile.navigation_mesh().validate().map_err(|error| NavError::tile_invalid(format!("tile {:?}: {error}", tile.cell())))?;
    Ok(Some(Arc::new(mesh)))
}
