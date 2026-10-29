//! World streaming on the facade: the registration a game makes once (`game.streaming`), the cell
//! builders (`game.cell_content`), what a builder reads ([`CellInputs`]) and makes ([`CellBuild`]),
//! and the display-only runtime key `__stream`.
//!
//! The sim set (`sim.stream`), the commit slot and the commit hooks live in `stream_tick.rs`
//! (STR-9); the view set is STR-16's. `__stream` is never in the checksum (it hashes the seed, the
//! tick and the game's probes), so a game probe named `stream` keeps working.

use std::any::{Any, TypeId};
use std::cell::RefCell;
use std::collections::BTreeSet;
use std::sync::Arc;

use genex_core::cell::CellId;
use genex_core::digest::{fnv1a64, fnv1a64_from, hex64};
use genex_core::json::Value as CoreValue;
use genex_stream::grid::SimRadii;
use glam::Vec2;

use crate::frame::Transform;
use crate::gfx::Model;
use crate::group::InstanceGroup;
use crate::rng::Pcg32;
use crate::terrain::{Scatter, Terrain};

pub use genex_stream::grid::{STREAM_ANCHORS_MAX, STREAM_RING_MAX, STREAM_SIM_RADIUS_MAX, STREAM_VIEW_CELLS_MAX, STREAM_WORLD_EXTENT_MAX};
pub use genex_stream::{StreamError, StreamErrorCode, StreamTicket};

/// The smallest cell side, in metres.
pub const STREAM_CELL_SIZE_MIN: f32 = 8.0;
/// The largest cell side, in metres.
pub const STREAM_CELL_SIZE_MAX: f32 = 1024.0;
/// The most things one cell's builders may add together (more refuse the cell `stream-invalid`).
pub const STREAM_CELL_THINGS_MAX: usize = 256;
/// The most colliders one cell's parts may carry together.
pub const STREAM_CELL_COLLIDERS_MAX: u32 = 64;
/// The most group instances one cell's parts may carry together.
pub const STREAM_CELL_INSTANCES_MAX: u32 = 4096;
/// The one sim CPU cap: the most bytes the sim set's cells may hold at their caps, checked once
/// at registration (`streaming-invalid`) and the same on every device.
pub const STREAM_SIM_BYTES_MAX: u64 = 128 * 1024 * 1024;
/// The bytes the sim cap counts for one collider at its cap.
const COLLIDER_BYTES: u64 = 1024;
/// The bytes the sim cap counts for one group instance at its cap.
const INSTANCE_BYTES: u64 = 64;
/// The view radius a registration draws without `view_radius`, in cells.
pub const STREAM_VIEW_RADIUS_DEFAULT_CELLS: f32 = 4.0;
/// Whether this build streams worlds (the facade's `streaming` feature; `[streaming] enabled =
/// false` in a game's genex.toml leaves it out, release R-1). Without it `install` refuses
/// `game.streaming` `streaming-disabled`, and the commit slot, the cell builds, the saved section
/// and the presenter's view set compile to nothing; `sim.stream` stays an unregistered sim set.
pub(crate) const STREAMING_BUILT: bool = cfg!(feature = "streaming");
/// The `state()` key streaming adds while it is registered (display only).
pub(crate) const RUNTIME_KEY: &str = "__stream";

/// How a game streams its world: a grid of square cells, the sim radii and how many anchors it
/// follows. Register it once with `game.streaming`.
#[derive(Clone, Debug, PartialEq)]
pub struct Streaming {
    cell_size: f32,
    radii: SimRadii,
    anchors: usize,
    view_radius: Option<f32>,
    /// The streamed terrain tiles (STR-23).
    terrain: Option<crate::TerrainTiles>,
}

impl Streaming {
    /// A grid of `cell_size`-metre cells anchored at world (0, 0), within
    /// [`STREAM_CELL_SIZE_MIN`]..=[`STREAM_CELL_SIZE_MAX`] (`install` refuses others
    /// `streaming-invalid`): sim radius 1, hysteresis 1, prefetch 1, one anchor.
    pub fn grid(cell_size: f32) -> Streaming {
        Streaming { cell_size, radii: SimRadii::default(), anchors: 1, view_radius: None, terrain: None }
    }

    /// Cells within `cells` of an anchor are simulated (at most [`STREAM_SIM_RADIUS_MAX`]).
    pub fn sim_radius(mut self, cells: u32) -> Streaming {
        self.radii.radius = cells;
        self
    }

    /// A cell leaves the sim set only past `sim_radius + cells` (at most [`STREAM_RING_MAX`]), so
    /// an anchor walking along a border does not flap.
    pub fn hysteresis(mut self, cells: u32) -> Streaming {
        self.radii.hysteresis = cells;
        self
    }

    /// The ring past the sim radius built ahead, so a commit rarely waits (at most
    /// [`STREAM_RING_MAX`]).
    pub fn prefetch(mut self, cells: u32) -> Streaming {
        self.radii.prefetch = cells;
        self
    }

    /// The most anchors `sim.stream.set_anchor` may hold at once (1..=[`STREAM_ANCHORS_MAX`]).
    pub fn anchors(mut self, count: usize) -> Streaming {
        self.anchors = count;
        self
    }

    /// Cells within `metres` of the drawn camera are drawn (display only, never the checksum):
    /// at most [`STREAM_VIEW_CELLS_MAX`] cells; [`STREAM_VIEW_RADIUS_DEFAULT_CELLS`] cells without it.
    pub fn view_radius(mut self, metres: f32) -> Streaming {
        self.view_radius = Some(metres);
        self
    }

    /// Stream `tiles`, one per cell (STR-23): `sim.stream.ground` reads them. With physics,
    /// `game.cell_content(tiles.colliders_content(cell))` beside `game.stream_colliders()` streams
    /// each sim-active tile's collider.
    pub fn terrain(mut self, tiles: crate::TerrainTiles) -> Streaming {
        self.terrain = Some(tiles);
        self
    }

    /// The streamed terrain tiles, when registered.
    pub(crate) fn tiles(&self) -> Option<&crate::TerrainTiles> {
        self.terrain.as_ref()
    }

    /// The cell side, in metres.
    pub fn cell_size(&self) -> f32 {
        self.cell_size
    }

    /// The view radius in metres (the default when none was given).
    pub(crate) fn view_metres(&self) -> f32 {
        self.view_radius.unwrap_or(self.cell_size * STREAM_VIEW_RADIUS_DEFAULT_CELLS)
    }

    /// The sim radii.
    pub(crate) fn radii(&self) -> SimRadii {
        self.radii
    }

    /// The most anchors.
    pub(crate) fn max_anchors(&self) -> usize {
        self.anchors
    }

    /// Why `install` refuses it, if it does: a cell size outside the caps (NaN never is inside),
    /// radii over theirs, an anchor count outside 1..=8, or a sim set whose cells at their caps
    /// would pass [`STREAM_SIM_BYTES_MAX`] (`thing_bytes` is the largest thing type a cell builder
    /// adds).
    pub(crate) fn refusal(&self, thing_bytes: usize) -> Option<String> {
        if !(STREAM_CELL_SIZE_MIN..=STREAM_CELL_SIZE_MAX).contains(&self.cell_size) {
            return Some(format!("cell size {} ({STREAM_CELL_SIZE_MIN}..={STREAM_CELL_SIZE_MAX})", self.cell_size));
        }
        if let Err(error) = self.radii.check() {
            return Some(error.detail);
        }
        if !(1..=STREAM_ANCHORS_MAX).contains(&self.anchors) {
            return Some(format!("{} anchors (1..={STREAM_ANCHORS_MAX})", self.anchors));
        }
        let view_cap = self.cell_size * STREAM_VIEW_CELLS_MAX as f32;
        if !(0.0..=view_cap).contains(&self.view_metres()) {
            return Some(format!("view radius {} m (0..={view_cap})", self.view_metres()));
        }
        let bytes = self.sim_bytes(thing_bytes);
        (bytes > STREAM_SIM_BYTES_MAX).then(|| format!("the sim set holds up to {bytes} bytes at its caps (max {STREAM_SIM_BYTES_MAX})"))
    }

    /// The most bytes the sim set's cells hold at their caps: every anchor's square out to the
    /// wider of the hysteresis and prefetch rings, each cell at its thing, collider and instance
    /// caps. Device class never enters it.
    pub(crate) fn sim_bytes(&self, thing_bytes: usize) -> u64 {
        let reach = u64::from(self.radii.radius + self.radii.hysteresis.max(self.radii.prefetch));
        let cells = self.anchors as u64 * (2 * reach + 1).pow(2);
        let things = STREAM_CELL_THINGS_MAX as u64 * thing_bytes.max(1) as u64;
        let per_cell = things + u64::from(STREAM_CELL_COLLIDERS_MAX) * COLLIDER_BYTES + u64::from(STREAM_CELL_INSTANCES_MAX) * INSTANCE_BYTES;
        cells * per_cell
    }
}

/// What a cell builder reads about the cell it builds. It runs on a worker thread (inline on the
/// web), so everything here is a pure function of the seed and the cell.
#[derive(Debug)]
pub struct CellInputs {
    cell: CellId,
    seed: u32,
    cell_size: f32,
    models: RefCell<Vec<String>>,
}

impl CellInputs {
    pub(crate) fn new(cell: CellId, seed: u32, cell_size: f32) -> CellInputs {
        CellInputs { cell, seed, cell_size, models: RefCell::new(Vec::new()) }
    }

    /// The cell being built.
    pub fn cell(&self) -> CellId {
        self.cell
    }

    /// The seed the simulation runs on.
    pub fn seed(&self) -> u32 {
        self.seed
    }

    /// The cell's corners (min, max) in metres, as (x, z).
    pub fn bounds(&self) -> (Vec2, Vec2) {
        let min = Vec2::new(self.cell.x as f32 * self.cell_size, self.cell.z as f32 * self.cell_size);
        (min, min + Vec2::splat(self.cell_size))
    }

    /// A generator for this cell only (the seed and the cell hashed): the same on every
    /// destination and thread count.
    pub fn rng(&self) -> Pcg32 {
        let mut hash = fnv1a64(&self.seed.to_le_bytes());
        hash = fnv1a64_from(&self.cell.x.to_le_bytes(), hash);
        hash = fnv1a64_from(&self.cell.z.to_le_bytes(), hash);
        Pcg32::seeded(hash)
    }

    /// A model at `assets/<path>` for this cell (a missing model for a path that is not a plain
    /// relative path). The commit slot lists its path in `state().assets` in cell order.
    pub fn model(&self, path: &str) -> Model {
        let model = Model::unrecorded(path);
        if let Some(path) = model.path() {
            self.models.borrow_mut().push(path.to_owned());
        }
        model
    }

    /// `rule`'s instances on `terrain` within this cell's bounds (STR-20): `Terrain::scatter` is
    /// place-deterministic, so the cells' scatters together are the scatter of their union and
    /// neighbouring cells meet exactly. Hand them to [`CellBuild::group`].
    pub fn scatter(&self, terrain: &Terrain, rule: &Scatter) -> Vec<Transform> {
        let (min, max) = self.bounds();
        terrain.scatter(rule, min, max)
    }

    fn take_models(&self) -> Vec<String> {
        self.models.take()
    }
}

/// Something a cell carries besides its things, for a commit hook to pick up (streamed colliders,
/// a nav island's source, a group). It counts toward the cell's collider and instance caps.
pub trait CellPart: Any + Send + Sync {
    /// The colliders it holds.
    fn colliders(&self) -> u32 {
        0
    }

    /// The group instances it holds.
    fn instances(&self) -> u32 {
        0
    }
}

/// What a cell builder makes of a cell: things of the game's own type `T`, in build order, and
/// parts for the commit hooks.
pub struct CellBuild<T> {
    things: Vec<T>,
    parts: Vec<Box<dyn CellPart>>,
    models: Vec<CellModel>,
    groups: Vec<InstanceGroup>,
}

impl<T> Default for CellBuild<T> {
    fn default() -> Self {
        CellBuild { things: Vec::new(), parts: Vec::new(), models: Vec::new(), groups: Vec::new() }
    }
}

/// One model a cell draws while it is in the view set (`CellBuild::model`): display only.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct CellModel {
    pub model: Model,
    pub transform: Transform,
}

impl<T: std::fmt::Debug> std::fmt::Debug for CellBuild<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CellBuild")
            .field("things", &self.things)
            .field("parts", &self.parts.len())
            .field("models", &self.models.len())
            .field("groups", &self.groups.len())
            .finish()
    }
}

impl<T> CellBuild<T> {
    /// Add a thing the cell holds; `sim.stream.entered()` lists it when the cell enters.
    pub fn thing(mut self, thing: T) -> CellBuild<T> {
        self.things.push(thing);
        self
    }

    /// Add a part a commit hook picks up when the cell enters.
    pub fn part(mut self, part: impl CellPart) -> CellBuild<T> {
        self.parts.push(Box::new(part));
        self
    }

    /// Draw `model` at `transform` while the cell is within the view radius of the drawn camera
    /// (display only: the presenter streams it in, and nothing draws while it loads).
    pub fn model(mut self, model: &Model, transform: Transform) -> CellBuild<T> {
        self.models.push(CellModel { model: model.clone(), transform });
        self
    }

    /// Draw `group` (rocks, a forest's trees: [`CellInputs::scatter`] places them) while the cell is
    /// within the view radius of the drawn camera (display only, STR-20). Its rows upload once and
    /// stop when the cell leaves the view; a model group draws once its model is resident. A cell
    /// whose groups hold more than [`STREAM_CELL_INSTANCES_MAX`] instances together draws nothing.
    pub fn group(mut self, group: InstanceGroup) -> CellBuild<T> {
        self.groups.push(group);
        self
    }

    /// The things, in the order they were added.
    pub fn things(&self) -> &[T] {
        &self.things
    }
}

/// One builder's output for one cell, its things type-erased.
pub(crate) struct ContentBuild {
    pub type_id: TypeId,
    pub things: Box<dyn Any + Send + Sync>,
    pub count: usize,
    pub parts: Vec<Box<dyn CellPart>>,
    pub models: Vec<String>,
    /// What the cell draws in the view set, in build order.
    pub views: Vec<CellModel>,
    /// The groups the cell draws in the view set, in build order (STR-20).
    pub groups: Vec<InstanceGroup>,
}

type Runner = dyn Fn(CellId, u32, f32) -> ContentBuild + Send + Sync;

/// One `game.cell_content` registration: its builder, callable from a worker.
#[derive(Clone)]
pub(crate) struct CellContent {
    pub run: Arc<Runner>,
    /// `size_of::<T>()`, for the sim cap.
    pub thing_bytes: usize,
}

impl CellContent {
    pub(crate) fn new<T: Send + Sync + 'static, F>(builder: F) -> CellContent
    where
        F: Fn(CellId, &CellInputs) -> CellBuild<T> + Send + Sync + 'static,
    {
        let run = move |cell: CellId, seed: u32, cell_size: f32| {
            let inputs = CellInputs::new(cell, seed, cell_size);
            let build = builder(cell, &inputs);
            ContentBuild {
                type_id: TypeId::of::<T>(),
                count: build.things.len(),
                things: Box::new(build.things),
                parts: build.parts,
                models: inputs.take_models(),
                views: build.models,
                groups: build.groups,
            }
        };
        CellContent { run: Arc::new(run), thing_bytes: std::mem::size_of::<T>() }
    }
}

/// `state().__stream`: `{active, cells}`, the active cell count and the FNV-1a 64 of the active
/// cells ascending (each `x` then `z` as little-endian i32).
pub(crate) fn runtime_value(active: &BTreeSet<CellId>) -> CoreValue {
    let bytes: Vec<u8> = active.iter().flat_map(|cell| cell.x.to_le_bytes().into_iter().chain(cell.z.to_le_bytes())).collect();
    let mut value = CoreValue::object();
    value.set("active", CoreValue::from(active.len() as u64));
    value.set("cells", CoreValue::from(hex64(fnv1a64(&bytes)).as_str()));
    value
}

#[cfg(feature = "physics")]
impl CellPart for genex_stream::physics::CellColliders {
    fn colliders(&self) -> u32 {
        u32::try_from(self.len()).unwrap_or(u32::MAX)
    }
}

/// The commit hook that streams `CellColliders` parts into `sim.physics`, its ledger in facet state.
#[cfg(feature = "physics")]
pub(crate) struct ColliderCommit;

#[cfg(feature = "physics")]
impl<W> crate::stream_tick::StreamCommit<W> for ColliderCommit {
    fn leave(&self, sim: &mut crate::Sim<W>, cell: CellId) {
        sim.facets.get_mut::<genex_stream::physics::StreamColliders>().leave(&mut sim.physics, cell);
    }

    fn enter(&self, sim: &mut crate::Sim<W>, cell: &crate::EnteredCell) {
        let colliders = cell.parts::<genex_stream::physics::CellColliders>().flat_map(genex_stream::physics::CellColliders::iter);
        sim.facets.get_mut::<genex_stream::physics::StreamColliders>().enter(&mut sim.physics, cell.cell(), colliders);
    }
}
