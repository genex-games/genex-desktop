//! Streaming in the tick: the sim set decided from sim state, cell builders merged in cell order
//! inside the commit slot, and the commit hooks colliders and nav islands plug into (STR-9).
//!
//! The rules (game systems plan, section 3.2 of the streaming design):
//! - The sim set is a pure function of the seed, the anchors over ticks, the registration and the
//!   builders' output. Thread count, IO timing, device class and budgets never change it.
//! - One commit slot per tick, at its very start: anchors set during tick T take effect at T+1.
//!   Leaving cells are processed descending (hooks in reverse registration order), then entering
//!   cells ascending (hooks in registration order), so a hook's arena (Rapier's slots) reuses the
//!   same handles on every run.
//! - Builders run on the job pool (inline on the web) at `Sim` priority for the cells the next
//!   commit enters and `Prefetch` priority for the ring past the radius. What they record,
//!   `state().assets` paths included, is merged in cell order inside the commit slot.
//! - A build that is late holds the frame, never the commit: the tick waits, counted in
//!   `state().volatile.__stream.stalls`. A wait is capped ([`STREAM_HOLD_MAX_MS`]) so a held
//!   `step(ms)` answers before the host's call timeout; past it the tick does not run (nothing
//!   changed) and `stream-hold-timeout` is reported. Live waits a slice per frame. Once a hold
//!   passes [`STREAM_HOLD_OVERLAY_MS`] the runtime says so (`Runtime::stream_loading`); no shell
//!   draws a loading look from it yet.
//!
//! Ideas from Unreal's World Partition "Block on Slow Streaming" (proprietary; no code).

use std::any::TypeId;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use genex_core::cell::CellId;
use genex_core::json::Value as CoreValue;
use genex_render::jobs::{Job, Pool, Priority};
use genex_stream::grid::{self, Grid, SimCells};
use genex_stream::snapshot::{STREAM_KEPT_MAX, StreamSnapshot};
use glam::{Vec2, Vec3};

use crate::gfx::Assets;
use crate::sim::Sim;
use crate::stream_groups::GroupCatalog;
use crate::stream::{
    CellContent, CellPart, ContentBuild, STREAM_CELL_COLLIDERS_MAX, STREAM_CELL_INSTANCES_MAX, STREAM_CELL_THINGS_MAX, StreamError, StreamErrorCode,
    Streaming,
};

/// How long a hold lasts before Live shows the loading look, in milliseconds.
pub const STREAM_HOLD_OVERLAY_MS: f64 = 250.0;
/// The longest one hold waits, in milliseconds: under the host's 10 s call timeout, so a held
/// `step(ms)` still answers.
pub const STREAM_HOLD_MAX_MS: f64 = 6000.0;
/// How long Live waits on a held commit in one frame before it draws again, in milliseconds.
pub const STREAM_HOLD_LIVE_SLICE_MS: f64 = 8.0;
/// How long the frame thread sleeps between looks at a held build.
const HOLD_POLL: std::time::Duration = std::time::Duration::from_micros(250);
/// The longest anchor name, in characters.
const ANCHOR_NAME_MAX_CHARS: usize = 64;
/// Cell refusals kept for `state().volatile.__stream.refused` (the newest).
const REFUSALS_KEPT: usize = 32;

/// A cell that entered the sim set at this tick's commit: the things its builders added (each
/// builder's in build order, builders in registration order) and their parts.
pub struct EnteredCell {
    cell: CellId,
    contents: Vec<ContentBuild>,
    refused: Option<StreamErrorCode>,
}

impl std::fmt::Debug for EnteredCell {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let things: usize = self.contents.iter().map(|content| content.count).sum();
        f.debug_struct("EnteredCell").field("cell", &self.cell).field("things", &things).field("refused", &self.refused).finish()
    }
}

impl EnteredCell {
    /// The cell.
    pub fn cell(&self) -> CellId {
        self.cell
    }

    /// The things of type `T` every builder of `T` added, builders in registration order, each
    /// builder's things in build order.
    pub fn things<T: 'static>(&self) -> impl Iterator<Item = &T> + '_ {
        let of_t = self.contents.iter().filter(|content| content.type_id == TypeId::of::<T>());
        of_t.filter_map(|content| content.things.downcast_ref::<Vec<T>>()).flatten()
    }

    /// The parts of type `P` the builders attached, in registration then build order.
    pub fn parts<P: CellPart>(&self) -> impl Iterator<Item = &P> + '_ {
        self.contents.iter().flat_map(|content| content.parts.iter()).filter_map(|part| (part.as_ref() as &dyn std::any::Any).downcast_ref::<P>())
    }

    /// Why the cell entered empty: its builders passed a cap together (`stream-invalid`), so
    /// nothing of theirs was committed.
    pub fn refused(&self) -> Option<StreamErrorCode> {
        self.refused
    }
}

/// A hook the commit slot calls for every cell it moves: streamed colliders (STR-10), nav
/// islands (STR-11) and restores (STR-12) plug in here. Register one with `game.stream_commit`.
pub trait StreamCommit<W> {
    /// `cell` leaves the sim set: called descending, hooks in reverse registration order, before
    /// `on_update` reads `sim.stream.left()`.
    fn leave(&self, sim: &mut Sim<W>, cell: CellId);

    /// `cell` enters the sim set: called ascending, hooks in registration order, before
    /// `on_update` reads `sim.stream.entered()` (which is empty while the hooks run).
    fn enter(&self, sim: &mut Sim<W>, cell: &EnteredCell);
}

/// The sim's view of streaming (`sim.stream`): anchors, kept cells, the active cells and what the
/// last commit moved. Empty, and every call refused `stream-not-registered`, without
/// `game.streaming`.
#[derive(Debug, Default)]
pub struct StreamState {
    cells: Option<SimCells>,
    max_anchors: usize,
    anchors: BTreeMap<String, CellId>,
    kept: BTreeSet<CellId>,
    /// A restored active set the next commit starts from instead of the current one (STR-12).
    restored: Option<BTreeSet<CellId>>,
    /// A slot load's rebuild the next commit reports from: what it entered and the set before it.
    carried: Option<Carried>,
    entered: Vec<EnteredCell>,
    left: Vec<CellId>,
    /// The streamed terrain tiles (STR-23).
    terrain: Option<crate::TerrainTiles>,
    /// The named asset groups required (STR-29, `stream_groups.rs`).
    groups: crate::stream_groups::GroupSet,
}

/// The cells a slot load's rebuild entered ahead of the tick's commit ([`StreamTick::rebuild_restored`]),
/// and the active set before it: the commit reports `entered` and `left` against that set, so the
/// update hooks see the lists a commit straight from it would give.
#[derive(Debug, Default)]
struct Carried {
    before: BTreeSet<CellId>,
    entered: Vec<EnteredCell>,
}

impl StreamState {
    /// The state a seed starts from: no anchors, nothing active.
    pub(crate) fn fresh(streaming: Option<&Streaming>) -> StreamState {
        let cells = streaming.and_then(|s| Grid::new(s.cell_size()).and_then(|grid| SimCells::new(grid, s.radii())).ok());
        let terrain = streaming.and_then(Streaming::tiles).cloned();
        StreamState { cells, max_anchors: streaming.map_or(0, Streaming::max_anchors), terrain, ..StreamState::default() }
    }

    /// Whether the game registered `game.streaming`.
    pub fn registered(&self) -> bool {
        self.cells.is_some()
    }

    /// Require the named asset group `group` (`[[asset_group]]` in genex.toml): its ticket, ready
    /// [`crate::STREAM_GROUP_PREFETCH_TICKS`] ticks from now ([`StreamState::ready`]). Requiring a
    /// group already required gives its ticket again. Works without `game.streaming`. Refuses
    /// `stream-unknown-group` for a group the build does not declare (before the build's groups are
    /// known, the next commit refuses the ticket instead: [`StreamState::group_refusal`]) and
    /// `stream-invalid` past [`crate::STREAM_GROUPS_REQUIRED_MAX`] groups; a refusal changes nothing.
    pub fn require(&mut self, group: &str) -> Result<crate::StreamTicket, StreamError> {
        self.groups.require(group)
    }

    /// The handles of `ticket`'s group (its members' bytes and models) from the tick it is ready
    /// on, the same on every destination; None before, and after `release_group`.
    pub fn ready(&self, ticket: crate::StreamTicket) -> Option<crate::GroupHandles> {
        self.groups.ready(ticket)
    }

    /// Why `ticket` will never be ready: `stream-unknown-group` for a group the build does not
    /// declare, required before the build's groups were known (the first require of a run).
    pub fn group_refusal(&self, ticket: crate::StreamTicket) -> Option<StreamErrorCode> {
        self.groups.refusal(ticket)
    }

    /// Let the named group `group` go (nothing when it is not required): its ticket answers None
    /// from now on, and requiring it again gives equal handles.
    pub fn release_group(&mut self, group: &str) {
        self.groups.release(group);
    }

    /// The named groups required and not released, ascending (what a shell fetches).
    pub fn required_groups(&self) -> impl Iterator<Item = &str> + '_ {
        self.groups.required()
    }

    /// Place the anchor `name` (the player, a vehicle) at `at` (world x, y, z; y is ignored); it
    /// takes effect at the next tick's commit. Refuses `stream-not-registered`, `stream-invalid`
    /// (an empty or overlong name, a point that is not finite), `stream-out-of-world` and
    /// `stream-too-many-anchors` (a new name past the registration's `anchors`); a refusal changes
    /// nothing.
    pub fn set_anchor(&mut self, name: &str, at: Vec3) -> Result<(), StreamError> {
        let Some(cells) = &self.cells else {
            return Err(not_registered());
        };
        let valid_name = !name.trim().is_empty() && name.chars().count() <= ANCHOR_NAME_MAX_CHARS && !name.chars().any(char::is_control);
        if !valid_name {
            return Err(StreamError::new(StreamErrorCode::Invalid, format!("anchor name {name:?}")));
        }
        let cell = cells.grid().cell_of(Vec2::new(at.x, at.z))?;
        if !self.anchors.contains_key(name) && self.anchors.len() >= self.max_anchors {
            return Err(StreamError::new(StreamErrorCode::TooManyAnchors, format!("{} anchors held (max {})", self.anchors.len(), self.max_anchors)));
        }
        self.anchors.insert(name.to_owned(), cell);
        Ok(())
    }

    /// Remove the anchor `name` (nothing when it is not held); takes effect at the next commit.
    pub fn clear_anchor(&mut self, name: &str) {
        self.anchors.remove(name);
    }

    /// The anchors' cells, by name.
    pub fn anchors(&self) -> impl Iterator<Item = (&str, CellId)> + '_ {
        self.anchors.iter().map(|(name, cell)| (name.as_str(), *cell))
    }

    /// Keep `cell` in the sim set wherever the anchors go (a cell the game changed and still
    /// simulates); it takes effect at the next tick's commit and holds until [`StreamState::release`]
    /// or a reseed. Refuses `stream-not-registered`, `stream-out-of-world` and `stream-invalid`
    /// (a new cell past the 64 kept, `STREAM_KEPT_MAX` in genex-stream); a refusal changes nothing.
    pub fn keep(&mut self, cell: CellId) -> Result<(), StreamError> {
        let Some(cells) = &self.cells else {
            return Err(not_registered());
        };
        if !cells.grid().contains(cell) {
            return Err(StreamError::new(StreamErrorCode::OutOfWorld, format!("cell ({}, {})", cell.x, cell.z)));
        }
        if !self.kept.contains(&cell) && self.kept.len() >= STREAM_KEPT_MAX {
            return Err(StreamError::new(StreamErrorCode::Invalid, format!("{} cells kept (max {STREAM_KEPT_MAX})", self.kept.len())));
        }
        self.kept.insert(cell);
        Ok(())
    }

    /// Stop keeping `cell` (nothing when it is not kept): from the next commit it stays only while
    /// an anchor is within the sim radius plus hysteresis.
    pub fn release(&mut self, cell: CellId) {
        self.kept.remove(&cell);
    }

    /// The kept cells, ascending.
    pub fn kept(&self) -> impl Iterator<Item = CellId> + '_ {
        self.kept.iter().copied()
    }

    /// The streaming state a save holds (`null` without `game.streaming`): the anchors, the kept
    /// cells and the active cells (the ones the next commit starts from). Cell content is not in
    /// it: a restore rebuilds it.
    pub fn snapshot(&self) -> serde_json::Value {
        let Some(cells) = &self.cells else { return serde_json::Value::Null };
        let active = self.restored.as_ref().unwrap_or(cells.active()).clone();
        let snapshot = StreamSnapshot { anchors: self.anchors.clone(), kept: self.kept.clone(), active };
        serde_json::Value::from(&snapshot.to_value(cells.grid()))
    }

    /// Restore a [`StreamState::snapshot`]: its anchors and kept cells now, and its active cells as
    /// the base of the next tick's commit, which leaves the cells it does not hold (descending)
    /// and enters the ones it does (ascending) through the commit hooks, so streamed colliders and
    /// nav islands are rebuilt in canonical order (owner call S5). Two restores of one snapshot
    /// replay equal; a scene of static colliders and kinematic characters replays equal to the run
    /// that never restored, a scene with dynamic bodies need not (Rapier's arena generations,
    /// contacts and sleep state are not saved). Refuses `stream-not-registered` and
    /// `stream-snapshot-invalid` (another version or cell size, a field missing or of the wrong
    /// kind, a cell outside the world, more anchors, kept or active cells than this registration
    /// holds); a refusal changes nothing.
    pub fn restore(&mut self, snapshot: &serde_json::Value) -> Result<(), StreamError> {
        let Some(cells) = &self.cells else {
            return Err(not_registered());
        };
        let restored = StreamSnapshot::from_value(&CoreValue::from(snapshot), cells.grid(), cells.radii(), self.max_anchors)?;
        self.anchors = restored.anchors;
        self.kept = restored.kept;
        self.restored = Some(restored.active);
        Ok(())
    }

    /// The active cells, ascending.
    pub fn active(&self) -> impl Iterator<Item = CellId> + '_ {
        self.cells.iter().flat_map(|cells| cells.active().iter().copied())
    }

    /// Whether `cell` is active.
    pub fn is_active(&self, cell: CellId) -> bool {
        self.cells.as_ref().is_some_and(|cells| cells.active().contains(&cell))
    }

    /// The ground's height at world (`x`, `z`) on the streamed terrain tiles (STR-23), a tile's
    /// `Terrain::height` bit for bit: procedural tiles anywhere in the world, authored ones only
    /// inside a sim-active cell. None without tiles or outside them.
    pub fn ground(&self, x: f32, z: f32) -> Option<f32> {
        let cells = self.cells.as_ref()?;
        self.terrain.as_ref()?.ground(x, z, cells.grid().cell_size(), |cell| self.is_active(cell))
    }

    /// The cells that entered at this tick's commit, ascending.
    pub fn entered(&self) -> &[EnteredCell] {
        &self.entered
    }

    /// The cells that left at this tick's commit, descending.
    pub fn left(&self) -> &[CellId] {
        &self.left
    }

    fn anchor_cells(&self) -> Vec<CellId> {
        self.anchors.values().copied().collect()
    }

    /// The sim set the next commit makes from the anchors and kept cells held now (and a restored
    /// active set, when there is one), and what it moves.
    fn next(&self) -> Option<(BTreeSet<CellId>, grid::CellDiff)> {
        let cells = self.cells.as_ref()?;
        let base = self.restored.as_ref().unwrap_or(cells.active());
        // The anchors were checked when they were set, so this never refuses; a refusal would keep
        // the set as it is.
        let mut next = grid::wanted_sim(cells.grid(), &self.anchor_cells(), cells.radii(), base).unwrap_or_else(|_| base.clone());
        next.extend(self.kept.iter().copied());
        let moved = grid::diff(cells.active(), &next);
        Some((next, moved))
    }
}

/// Report a commit that follows a slot load's rebuild against the set before the load: `entered`
/// is every cell of `next` that set lacked (the rebuild's and the commit's, ascending) and `left`
/// every cell of it `next` lacks (descending), as a commit straight from it would list them.
fn report_from(stream: &mut StreamState, carried: Carried, next: &BTreeSet<CellId>) {
    let Carried { before, entered } = carried;
    let mut all: Vec<EnteredCell> = entered.into_iter().filter(|cell| next.contains(&cell.cell)).collect();
    all.append(&mut stream.entered);
    all.retain(|cell| !before.contains(&cell.cell));
    all.sort_by_key(|cell| cell.cell);
    stream.entered = all;
    stream.left = grid::diff(&before, next).left;
}

fn not_registered() -> StreamError {
    StreamError::new(StreamErrorCode::NotRegistered, "the game has no game.streaming")
}

/// How long a tick may still wait on held builds.
#[derive(Clone, Copy, Debug)]
pub(crate) struct HoldBudget {
    left_ms: f64,
}

impl HoldBudget {
    /// The budget of one `step(ms)` call.
    pub(crate) fn step() -> HoldBudget {
        HoldBudget { left_ms: STREAM_HOLD_MAX_MS }
    }

    /// The budget of one Live frame.
    pub(crate) fn live() -> HoldBudget {
        HoldBudget { left_ms: STREAM_HOLD_LIVE_SLICE_MS }
    }
}

/// The commit did not run: a build it needs is still building.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Held;

/// What a cell's build job comes to: every builder's output, or the cap it passed.
type CellOutcome = Result<Vec<ContentBuild>, StreamError>;

/// The pool builds go to.
enum Workers {
    Global,
    Own(Arc<Pool>),
}

impl Workers {
    fn pool(&self) -> &Pool {
        match self {
            Workers::Global => Pool::global(),
            Workers::Own(pool) => pool,
        }
    }
}

/// The clock a hold is measured with, in milliseconds.
pub(crate) type HoldClock = Box<dyn FnMut() -> f64>;

/// The process's monotonic clock (the web never waits: its builds run inline).
#[allow(clippy::disallowed_types, reason = "host glue: a hold is timed on the wall clock; the simulation never sees it")]
fn wall_clock() -> HoldClock {
    #[cfg(not(target_arch = "wasm32"))]
    {
        let start = std::time::Instant::now();
        Box::new(move || start.elapsed().as_secs_f64() * 1000.0)
    }
    #[cfg(target_arch = "wasm32")]
    {
        Box::new(|| 0.0)
    }
}

/// The runtime's streaming engine: the builds in flight, the builders and the counters
/// `state().volatile.__stream` reports. Display and scheduling state only: nothing here reaches the
/// simulation except through the commit slot, in canonical order.
pub(crate) struct StreamTick {
    contents: Vec<CellContent>,
    cell_size: f32,
    seed: u32,
    workers: Workers,
    builds: BTreeMap<CellId, Job<CellOutcome>>,
    clock: HoldClock,
    stalls: u64,
    held_ms: f64,
    /// Whether the last commit was held, and how long that hold has lasted.
    holding: bool,
    holding_ms: f64,
    timeouts: u64,
    refused: Vec<(CellId, StreamErrorCode)>,
    /// The build's named groups, read once from the asset index (STR-29).
    catalog: Option<Arc<GroupCatalog>>,
}

impl StreamTick {
    pub(crate) fn new(streaming: Option<&Streaming>, contents: &[CellContent]) -> StreamTick {
        StreamTick {
            contents: if streaming.is_some() { contents.to_vec() } else { Vec::new() },
            cell_size: streaming.map_or(0.0, Streaming::cell_size),
            seed: 0,
            workers: Workers::Global,
            builds: BTreeMap::new(),
            clock: wall_clock(),
            stalls: 0,
            held_ms: 0.0,
            holding: false,
            holding_ms: 0.0,
            timeouts: 0,
            refused: Vec::new(),
            catalog: None,
        }
    }

    /// Hand `sim.stream` the build's named groups, read once from `assets`' index the first time a
    /// game requires a group, then kept for later seeds and loads (STR-29).
    fn attach_groups<W>(&mut self, sim: &mut Sim<W>, assets: &Assets) {
        let catalog = self.catalog.get_or_insert_with(|| Arc::new(GroupCatalog::read(assets)));
        sim.stream.groups.attach(Arc::clone(catalog));
    }

    /// Run builds on `pool` from now on (tests and tools: a thread count to compare).
    pub(crate) fn use_pool(&mut self, pool: Arc<Pool>) {
        self.cancel_all();
        self.workers = Workers::Own(pool);
    }

    /// Measure holds with `clock` from now on (tests: a fake clock).
    pub(crate) fn use_clock(&mut self, clock: HoldClock) {
        self.clock = clock;
    }

    /// A new seed: every build is dropped (builds read the seed) and the counters restart.
    pub(crate) fn reset(&mut self, seed: u32) {
        self.cancel_all();
        self.seed = seed;
        self.stalls = 0;
        self.held_ms = 0.0;
        self.holding = false;
        self.holding_ms = 0.0;
        self.timeouts = 0;
        self.refused.clear();
    }

    /// Whether a hold has lasted past [`STREAM_HOLD_OVERLAY_MS`] (what a shell's loading look would
    /// read; none reads it yet).
    pub(crate) fn loading(&self) -> bool {
        self.holding_ms >= STREAM_HOLD_OVERLAY_MS
    }

    fn cancel_all(&mut self) {
        for job in std::mem::take(&mut self.builds).into_values() {
            job.cancel();
        }
    }

    /// Start `cell`'s build at `priority` unless it is built or building.
    fn ensure(&mut self, cell: CellId, priority: Priority) {
        if self.builds.contains_key(&cell) {
            return;
        }
        let contents = self.contents.clone();
        let (seed, cell_size) = (self.seed, self.cell_size);
        let job = self.workers.pool().spawn(priority, move || build_cell(&contents, cell, seed, cell_size));
        self.builds.insert(cell, job);
    }

    /// The commit slot, at the start of a tick: move the sim set to the anchors, waiting (within
    /// `budget`) for the builds of the cells it enters. `Err(Held)` when they are still building:
    /// nothing changed and the tick must not run.
    pub(crate) fn commit<W>(
        &mut self,
        sim: &mut Sim<W>,
        hooks: &[Box<dyn StreamCommit<W>>],
        assets: &Assets,
        budget: &mut HoldBudget,
    ) -> Result<(), Held> {
        // A seed or load after the groups were read gets them again with no read.
        let known_here = self.catalog.is_some() && !sim.stream.groups.attached();
        if known_here || sim.stream.groups.wants_catalog() {
            self.attach_groups(sim, assets);
        }
        // A named group due now whose members are not all resident holds the tick, as a late
        // cell build does: nothing changed, and the tick runs once they arrive (STR-29).
        if !sim.stream.groups.due_resident(assets) {
            if !self.holding {
                self.holding = true;
                self.stalls += 1;
            }
            return Err(Held);
        }
        self.commit_cells(sim, hooks, assets, budget)?;
        self.end_hold();
        sim.stream.groups.commit(assets);
        Ok(())
    }

    /// The cells' part of the commit slot ([`StreamTick::commit`]).
    fn commit_cells<W>(
        &mut self,
        sim: &mut Sim<W>,
        hooks: &[Box<dyn StreamCommit<W>>],
        assets: &Assets,
        budget: &mut HoldBudget,
    ) -> Result<(), Held> {
        if !crate::stream::STREAMING_BUILT {
            return Ok(());
        }
        let Some((next, moved)) = sim.stream.next() else { return Ok(()) };
        for cell in &moved.entered {
            self.ensure(*cell, Priority::Sim);
        }
        self.wait(&moved.entered, budget)?;
        sim.stream.entered.clear();
        sim.stream.left.clear();
        for cell in &moved.left {
            for hook in hooks.iter().rev() {
                hook.leave(sim, *cell);
            }
            if let Some(job) = self.builds.remove(cell) {
                job.cancel();
            }
        }
        sim.stream.left = moved.left;
        sim.stream.restored = None;
        let carried = sim.stream.carried.take().map(|carried| (carried, next.clone()));
        if let Some(cells) = sim.stream.cells.as_mut() {
            cells.replace(next);
        }
        let entered: Vec<EnteredCell> = moved.entered.iter().map(|cell| self.take_entered(*cell, assets)).collect();
        for cell in &entered {
            for hook in hooks {
                hook.enter(sim, cell);
            }
        }
        sim.stream.entered = entered;
        if let Some((carried, next)) = carried {
            report_from(&mut sim.stream, carried, &next);
        }
        Ok(())
    }

    /// A slot load's rebuild, before the tick's commit: enter exactly the restored active set
    /// through the commit hooks (waiting, within `budget`, for its builds), so the world a probe
    /// reads is the one the slot was saved from and the load's checksum self-check can run. The
    /// commit that follows moves the set to the anchors and reports `entered` and `left` against
    /// the set before the load. `Ok(false)` with nothing to rebuild; `Err(Held)`, with nothing
    /// changed, while a build is still building.
    pub(crate) fn rebuild_restored<W>(
        &mut self,
        sim: &mut Sim<W>,
        hooks: &[Box<dyn StreamCommit<W>>],
        assets: &Assets,
        budget: &mut HoldBudget,
    ) -> Result<bool, Held> {
        if !crate::stream::STREAMING_BUILT {
            return Ok(false);
        }
        let Some(restored) = sim.stream.restored.clone() else { return Ok(false) };
        let Some(before) = sim.stream.cells.as_ref().map(|cells| cells.active().clone()) else { return Ok(false) };
        let moved = grid::diff(&before, &restored);
        for cell in &moved.entered {
            self.ensure(*cell, Priority::Sim);
        }
        self.wait(&moved.entered, budget)?;
        sim.stream.entered.clear();
        sim.stream.left.clear();
        for cell in &moved.left {
            for hook in hooks.iter().rev() {
                hook.leave(sim, *cell);
            }
            if let Some(job) = self.builds.remove(cell) {
                job.cancel();
            }
        }
        if let Some(cells) = sim.stream.cells.as_mut() {
            cells.replace(restored);
        }
        sim.stream.restored = None;
        let entered: Vec<EnteredCell> = moved.entered.iter().map(|cell| self.take_entered(*cell, assets)).collect();
        for cell in &entered {
            for hook in hooks {
                hook.enter(sim, cell);
            }
        }
        // Scene queries (a probe's ray down to the ground) see the rebuilt colliders, as the step
        // that ended the saved tick left them; Rapier refreshes them only in a step otherwise.
        #[cfg(feature = "physics")]
        sim.physics.detect_collisions(&(), &());
        sim.stream.carried = Some(Carried { before, entered });
        Ok(true)
    }

    /// Wait until every cell of `cells` is built, within `budget` (a `step(ms)` call's is
    /// [`STREAM_HOLD_MAX_MS`], so each call answers in time). A hold counts one stall when it starts
    /// and reports `stream-hold-timeout` once it has lasted past [`STREAM_HOLD_MAX_MS`].
    fn wait(&mut self, cells: &[CellId], budget: &mut HoldBudget) -> Result<(), Held> {
        let built = |builds: &BTreeMap<CellId, Job<CellOutcome>>| cells.iter().all(|cell| builds.get(cell).is_some_and(Job::is_ready));
        if built(&self.builds) {
            self.end_hold();
            return Ok(());
        }
        if !self.holding {
            self.holding = true;
            self.stalls += 1;
        }
        let start = (self.clock)();
        let mut waited = 0.0;
        let ready = loop {
            if built(&self.builds) {
                break true;
            }
            waited = (self.clock)() - start;
            if waited >= budget.left_ms {
                break false;
            }
            std::thread::sleep(HOLD_POLL);
        };
        let crossed_cap = self.holding_ms < STREAM_HOLD_MAX_MS && self.holding_ms + waited >= STREAM_HOLD_MAX_MS;
        self.held_ms += waited;
        budget.left_ms = (budget.left_ms - waited).max(0.0);
        if ready {
            self.end_hold();
            return Ok(());
        }
        self.holding_ms += waited;
        if crossed_cap {
            self.timeouts += 1;
        }
        Err(Held)
    }

    fn end_hold(&mut self) {
        self.holding = false;
        self.holding_ms = 0.0;
    }

    /// The finished build of an entering cell, its model paths recorded in cell order (a refused
    /// cell enters empty and records nothing).
    fn take_entered(&mut self, cell: CellId, assets: &Assets) -> EnteredCell {
        let outcome = match self.builds.remove(&cell).map(Job::into_result) {
            Some(Ok(outcome)) => outcome,
            Some(Err(error)) => panic!("the cell builder for ({}, {}) failed: {error}", cell.x, cell.z),
            None => unreachable!("an entering cell's build was started before the wait"),
        };
        match outcome {
            Ok(contents) => {
                for path in contents.iter().flat_map(|content| content.models.iter()) {
                    let _ = assets.model(path);
                }
                EnteredCell { cell, contents, refused: None }
            }
            Err(error) => {
                if self.refused.len() == REFUSALS_KEPT {
                    self.refused.remove(0);
                }
                self.refused.push((cell, error.code));
                EnteredCell { cell, contents: Vec::new(), refused: Some(error.code) }
            }
        }
    }

    /// After the tick's hooks: start the builds the next commit enters (`Sim`) and the prefetch
    /// ring (`Prefetch`), and drop builds no longer wanted.
    pub(crate) fn prefetch<W>(&mut self, sim: &Sim<W>) {
        if !crate::stream::STREAMING_BUILT {
            return;
        }
        let Some((_, moved)) = sim.stream.next() else { return };
        let Some(cells) = sim.stream.cells.as_ref() else { return };
        let ring = cells.prefetch(&sim.stream.anchor_cells()).unwrap_or_default();
        for cell in &moved.entered {
            self.ensure(*cell, Priority::Sim);
        }
        for cell in &ring {
            self.ensure(*cell, Priority::Prefetch);
        }
        let wanted: BTreeSet<CellId> = moved.entered.iter().chain(&ring).copied().collect();
        let stale: Vec<CellId> = self.builds.keys().filter(|cell| !wanted.contains(cell)).copied().collect();
        for cell in stale {
            if let Some(job) = self.builds.remove(&cell) {
                job.cancel();
            }
        }
    }

    /// `state().volatile.__stream`: `{stalls, heldMs, inFlight, timeouts, refused: [{cell: [x, z],
    /// code}]}`, plus `timeout: "stream-hold-timeout"` while a hold is past its cap.
    pub(crate) fn volatile_value(&self) -> CoreValue {
        let in_flight = self.builds.values().filter(|job| !job.is_ready()).count();
        let refused = self.refused.iter().map(|(cell, code)| {
            let mut entry = CoreValue::object();
            entry.set("cell", CoreValue::Array(vec![CoreValue::from(i64::from(cell.x)), CoreValue::from(i64::from(cell.z))]));
            entry.set("code", CoreValue::from(code.wire()));
            entry
        });
        let mut value = CoreValue::object();
        value.set("stalls", CoreValue::from(self.stalls));
        value.set("heldMs", CoreValue::from(self.held_ms));
        value.set("inFlight", CoreValue::from(in_flight as u64));
        value.set("timeouts", CoreValue::from(self.timeouts));
        value.set("refused", CoreValue::Array(refused.collect()));
        if self.holding_ms >= STREAM_HOLD_MAX_MS {
            value.set("timeout", CoreValue::from(StreamErrorCode::HoldTimeout.wire()));
        }
        value
    }
}

/// Run every builder on `cell` (on a worker) and check the cell's caps: past one, the cell is
/// refused `stream-invalid` and none of its builders' output is kept.
fn build_cell(contents: &[CellContent], cell: CellId, seed: u32, cell_size: f32) -> CellOutcome {
    let built: Vec<ContentBuild> = contents.iter().map(|content| (content.run)(cell, seed, cell_size)).collect();
    let things: usize = built.iter().map(|content| content.count).sum();
    let parts = built.iter().flat_map(|content| content.parts.iter());
    let (colliders, instances) = parts.fold((0_u64, 0_u64), |(c, i), part| (c + u64::from(part.colliders()), i + u64::from(part.instances())));
    let over =
        things > STREAM_CELL_THINGS_MAX || colliders > u64::from(STREAM_CELL_COLLIDERS_MAX) || instances > u64::from(STREAM_CELL_INSTANCES_MAX);
    if over {
        return Err(StreamError::new(
            StreamErrorCode::Invalid,
            format!(
                "cell ({}, {}): {things} things, {colliders} colliders, {instances} instances \
                 (max {STREAM_CELL_THINGS_MAX}, {STREAM_CELL_COLLIDERS_MAX}, {STREAM_CELL_INSTANCES_MAX})",
                cell.x, cell.z
            ),
        ));
    }
    Ok(built)
}
