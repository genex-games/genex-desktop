//! What the web fetches while playing (game systems STR-14b; gate GR's web streaming finding):
//! natively the asset folder holds every file, so a named group a game requires is resident at
//! once and a pack's cell bodies and terrain tiles are there to read. On the web the shell
//! preloads only the boot and sim groups; this module asks for the rest as the game needs it.
//!
//! - **Each frame**, before the game's ([`WebStream::frame`], the `studio_assets_wanted` export):
//!   the files that arrived since are handed to the sim's source ([`Delivered`]), then the shell
//!   asks the game what it streams ([`crate::GameHandle::stream_wants`]): the named groups it
//!   requires (`sim.stream.required_groups()`) and the cells around its anchors (the active set,
//!   the cells the next commit enters and the prefetch ring). Each group is wanted by name
//!   ([`WebAssets::want_group`]) and each cell's `stream` files by path ([`WebAssets::want`]): its
//!   body `<pack>/cells/<x>_<z>.cell` and its tile `<pack>/terrain/<x>_<z>.r16`. The answer is the
//!   pieces not yet asked for, so a piece is fetched once.
//! - **Arrivals** ([`WebStream::arrived`]) are admitted by their recorded length and digest. A
//!   piece no longer wanted (its cell left first) or never asked for is dropped and admits nothing;
//!   a refused piece is not asked for again this session.
//! - **The frame boundary**: a file reaches the sim's reads only at the next frame, whole (a file
//!   fetched by ranges once every range came), so a tick never sees it change. The module then
//!   keeps one copy, the sim's. A named group's hold therefore ends on the first tick after its
//!   members came, and the group is ready on the tick a native run makes it ready. The lock around
//!   the delivered files is taken only inside one call, never across frames.
//! - **Cells that leave** the set around the anchors drop their files (and any fetch still on its
//!   way), so the module's memory holds the ring around the player, not the world.
//!
//! Nothing in the simulation reads a cell's file by itself: a game reads its pack from its compiled
//! table (`CellPacks::from_table`) or a named group's handles. What this changes is where the
//! files are: in the sim's source while their cell is around the player, as on a native run.
//! `state().volatile.webStream` says so: `{files, bytes, inFlight, cells}`, `cells` the cells
//! around the anchors whose files are all delivered.

use crate::assets::{AssetError, Fetch, WebAssets};
use crate::draw::AssetTable;
use crate::studio::WebSource;
use genex::CellId;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

/// The `state().volatile` key the delivered files are reported under.
pub const STATE_WEB_STREAM: &str = "webStream";
/// A pack's cell bodies and terrain tiles: the folder under the pack and the file ending
/// (genex-stream's `cell_file`, the import's tiles; the host's map writer uses the same spellings).
#[cfg(feature = "streaming")]
const CELL_FILES: [(&str, &str); 2] = [("cells", ".cell"), ("terrain", ".r16")];

/// What the game streams now: the named groups it requires and the cells around its anchors,
/// ascending.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StreamWants {
    /// The `[[asset_group]]` names `sim.stream.require` asked for and not released.
    pub groups: Vec<String>,
    /// The cells around the anchors (`genex::Runtime::streamed_cells`); empty without streaming.
    pub cells: Vec<CellId>,
}

/// What the shell reports beside the files.
#[derive(Debug, Default)]
struct DeliveredFiles {
    files: BTreeMap<String, Arc<[u8]>>,
    in_flight: usize,
    cells: Vec<CellId>,
}

/// The files that arrived while playing, shared by the shell (which delivers them at a frame
/// boundary) and the sim's source (which reads them).
#[derive(Clone, Debug, Default)]
pub struct Delivered {
    inner: Arc<Mutex<DeliveredFiles>>,
}

impl Delivered {
    fn lock(&self) -> MutexGuard<'_, DeliveredFiles> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The delivered bytes of `path`, shared (no copy).
    pub fn get(&self, path: &str) -> Option<Arc<[u8]>> {
        self.lock().files.get(path).cloned()
    }

    fn has(&self, path: &str) -> bool {
        self.lock().files.contains_key(path)
    }

    fn insert(&self, path: String, bytes: Vec<u8>) {
        self.lock().files.insert(path, Arc::from(bytes));
    }

    fn remove(&self, path: &str) {
        self.lock().files.remove(path);
    }

    /// `state().volatile.webStream`: the delivered files and their bytes, the pieces on their way,
    /// and the cells around the anchors whose files are all delivered, as `[x, z]`.
    pub fn receipt(&self) -> Value {
        let delivered = self.lock();
        let bytes: usize = delivered.files.values().map(|bytes| bytes.len()).sum();
        let cells: Vec<Value> = delivered.cells.iter().map(|cell| json!([cell.x, cell.z])).collect();
        json!({ "files": delivered.files.len(), "bytes": bytes, "inFlight": delivered.in_flight, "cells": cells })
    }
}

/// The shell's side of streaming after boot: the plan of the streamed and named files, the pieces
/// asked for, and the files delivered to the sim.
#[derive(Debug)]
pub struct WebStream {
    assets: WebAssets,
    /// Each cell's `stream` files (body, tile), in plan order.
    cell_files: BTreeMap<CellId, Vec<String>>,
    /// The cells whose files are wanted now.
    cells: BTreeSet<CellId>,
    /// Pieces asked for and not arrived.
    in_flight: BTreeSet<(String, u64)>,
    /// Pieces refused on arrival: never asked for again.
    refused: BTreeSet<(String, u64)>,
    /// Files with a piece asked for, not yet delivered.
    pending: BTreeSet<String>,
    delivered: Delivered,
}

/// `studio_boot`'s hand-over: the preloaded files move to the sim's source with their groups and
/// the delivered files it shares with the shell; the shell keeps the plan of the streamed and
/// named files.
pub fn boot(compiled: AssetTable, fetched: WebAssets) -> (WebSource, WebStream) {
    let streaming = fetched.streaming_part();
    let groups = fetched.groups();
    let delivered = Delivered::default();
    let source = WebSource::new(compiled, fetched).with_groups(groups).with_delivered(delivered.clone());
    let cell_files = cell_index(&streaming);
    let stream = WebStream {
        assets: streaming,
        cell_files,
        cells: BTreeSet::new(),
        in_flight: BTreeSet::new(),
        refused: BTreeSet::new(),
        pending: BTreeSet::new(),
        delivered,
    };
    (source, stream)
}

/// The cell `<x>_<z>` a pack file's name ends in, when it is a body or a tile in a `stream` entry.
#[cfg(feature = "streaming")]
fn cell_of(path: &str) -> Option<CellId> {
    let (folder, name) = path.rsplit_once('/')?;
    let folder = folder.rsplit('/').next()?;
    let stem = CELL_FILES.iter().find(|(dir, _)| *dir == folder).and_then(|(_, ending)| name.strip_suffix(ending))?;
    let (x, z) = stem.split_once('_')?;
    Some(CellId { x: x.parse().ok()?, z: z.parse().ok()? })
}

/// Each cell's streamed files in `plan` (only a build with streaming has any to want).
#[cfg(feature = "streaming")]
fn cell_index(plan: &WebAssets) -> BTreeMap<CellId, Vec<String>> {
    let mut index: BTreeMap<CellId, Vec<String>> = BTreeMap::new();
    for asset in plan.planned().iter().filter(|asset| asset.group == genex::AssetGroup::Stream) {
        if let Some(cell) = cell_of(&asset.path) {
            index.entry(cell).or_default().push(asset.path.clone());
        }
    }
    index
}

#[cfg(not(feature = "streaming"))]
fn cell_index(_plan: &WebAssets) -> BTreeMap<CellId, Vec<String>> {
    BTreeMap::new()
}

impl WebStream {
    /// One frame, before the game's tick: deliver what arrived since, then want what the game
    /// streams now; answers the pieces to fetch that were not asked for before.
    pub fn frame(&mut self, wants: &StreamWants) -> Vec<Fetch> {
        self.deliver();
        for group in &wants.groups {
            // A group whose files are all compiled in or preloaded has nothing in the plan to fetch
            // (refused `asset-group-invalid`): the sim already reads it.
            let _ = self.assets.want_group(group);
        }
        self.want_cells(&wants.cells);
        let fresh = self.take_fresh();
        self.note();
        fresh
    }

    /// Admit a piece the shell fetched: only one asked for and still wanted, by its recorded length
    /// and digest. A piece no longer wanted or never asked for is dropped (nothing admitted); a
    /// refused one is not asked for again.
    pub fn arrived(&mut self, path: &str, offset: u64, bytes: Vec<u8>) -> Result<(), AssetError> {
        let piece = (path.to_owned(), offset);
        if !self.in_flight.remove(&piece) {
            return Ok(());
        }
        let admitted = self.assets.arrived(path, offset, bytes);
        if admitted.is_err() {
            self.refused.insert(piece);
        }
        self.note();
        admitted
    }

    /// Drop a streamed or named file (`studio_assets_release`): its bytes, delivered or not, and its
    /// fetches; a preloaded file stays (`asset-group-invalid`).
    pub fn release(&mut self, path: &str) -> Result<(), AssetError> {
        self.assets.release(path)?;
        self.forget(path);
        self.note();
        Ok(())
    }

    /// The delivered files the sim's source reads.
    pub fn delivered(&self) -> Delivered {
        self.delivered.clone()
    }

    /// The frame boundary: every file whose pieces all arrived moves, whole, to the sim's source.
    fn deliver(&mut self) {
        let ready: Vec<String> = self.pending.iter().filter(|path| self.assets.resident(path)).cloned().collect();
        for path in ready {
            self.pending.remove(&path);
            let Some(bytes) = self.assets.resident_bytes(&path) else { continue };
            // The module keeps one copy: the sim's. Only streamed and named files are pending.
            let _ = self.assets.release(&path);
            self.delivered.insert(path, bytes);
        }
    }

    /// Want the files of the cells around the anchors; drop those of the cells that left.
    fn want_cells(&mut self, cells: &[CellId]) {
        let around: BTreeSet<CellId> = cells.iter().copied().filter(|cell| self.cell_files.contains_key(cell)).collect();
        let left: Vec<String> = self.cells.difference(&around).filter_map(|cell| self.cell_files.get(cell)).flatten().cloned().collect();
        for path in left {
            let _ = self.assets.release(&path);
            self.forget(&path);
        }
        let wanted: Vec<String> = around.iter().filter_map(|cell| self.cell_files.get(cell)).flatten().filter(|path| !self.delivered.has(path)).cloned().collect();
        for path in wanted {
            let _ = self.assets.want(&path);
        }
        self.cells = around;
    }

    /// The pieces wanted now that were not asked for before (nor delivered, nor refused).
    fn take_fresh(&mut self) -> Vec<Fetch> {
        let mut fresh = Vec::new();
        for fetch in self.assets.take_wanted() {
            let piece = (fetch.path.clone(), fetch.offset);
            if self.delivered.has(&fetch.path) || self.refused.contains(&piece) || !self.in_flight.insert(piece) {
                continue;
            }
            self.pending.insert(fetch.path.clone());
            fresh.push(fetch);
        }
        fresh
    }

    /// Forget `path` everywhere: delivered, pending, on its way, refused.
    fn forget(&mut self, path: &str) {
        self.delivered.remove(path);
        self.pending.remove(path);
        self.in_flight.retain(|(known, _)| known != path);
        self.refused.retain(|(known, _)| known != path);
    }

    /// Bring the receipt up to date.
    fn note(&self) {
        let resident = |cell: &CellId| self.cell_files.get(cell).is_some_and(|files| files.iter().all(|path| self.delivered.has(path)));
        let cells: Vec<CellId> = self.cells.iter().filter(|cell| resident(cell)).copied().collect();
        let mut delivered = self.delivered.lock();
        delivered.in_flight = self.in_flight.len();
        delivered.cells = cells;
    }
}
