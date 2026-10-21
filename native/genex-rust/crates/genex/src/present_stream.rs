//! The presenter's streamed view set (game systems STR-16): the cells within the view radius of the
//! drawn camera, their builds, the residency of the models they draw, the reads and the uploads.
//! Display state only: it never enters the simulation or the checksum.
//!
//! Each drawn frame of a game that registered `game.streaming`, with no game call:
//! - the wanted cells are the world cells within the registration's view radius of the camera's
//!   ground point (`genex_stream::grid::view_cells`), ascending;
//! - a wanted cell's builders run again on the job pool at `Visible` priority (they are pure, so
//!   the view build equals the sim's) and the view keeps only what they draw (`CellBuild::model`);
//! - each model a built cell draws takes a `View` reference in the residency policy
//!   (`genex_stream::Residency`, the cesium-native port); loads start under the class's in-flight
//!   cap and only when they fit the content pool, nearest cell first;
//! - a started load reads the model's bytes through the async source ([`StreamView::set_source`];
//!   without one the presenter's own source answers at once, as the web's inline jobs do);
//! - with an async source, a model the asset index lists with levels of detail loads its coarsest
//!   level first, read by range, as a stand-in it draws until the whole model is resident
//!   (STR-19, `present_stream/meshes.rs`): the stand-in is the whole model's residency parent and
//!   `forbid_holes` keeps it, so a cell never draws neither;
//! - read models are decoded and uploaded on the frame thread under the class's finish budget in
//!   milliseconds and its soft upload budget in bytes ([`ViewLimits`]): a load starts only when the
//!   frame's time so far plus the dearest load seen fits the budget, and the first always goes, so
//!   nothing starves;
//! - the policy then evicts unreferenced models, oldest release first, while the pool is over; an
//!   evicted model's meshes leave the renderer's arena.
//! - a built cell's retained groups (`CellBuild::group`, STR-20, `present_stream/groups.rs`) are
//!   drawn while the cell stays wanted, a model group once its model is resident; a cell leaving
//!   the view drops them, so their rows stop uploading.
//!
//! What is drawn: every model of a built, wanted cell that is resident (else its resident
//! stand-in), and the missing-asset checker for a model that was refused (listed in
//! `missing_models`). A model with nothing resident draws nothing and is never listed: the checker
//! means a refusal, never a wait.
//!
//! The game's own `frame.model` draws keep the presenter's synchronous load; only cell content
//! streams. A model's resident bytes are its GLB's bytes (the index's file size when it lists the
//! model); the textures a GLB embeds are not freed when it is evicted (no texture removal through
//! the device-loss replay yet).
//! Ideas from Stride's `StreamingManager` (MIT; no code taken): a per-frame residency pass over
//! what the camera wants, finished under a frame budget.

mod drain;
mod groups;

pub use drain::{DrainClock, DrainReport, DrainStep, Drain, STREAM_DRAIN_MAX_MS, STREAM_DRAIN_POLL, drain_blocking};
#[cfg(not(target_arch = "wasm32"))]
pub use drain::WallDrainClock;
mod meshes;
mod textures;

use std::collections::{BTreeMap, VecDeque};
use std::sync::Arc;

use genex_core::cell::CellId;
use genex_core::json::Value as CoreValue;
use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier, TargetOs};
use genex_render::jobs::{Job, Pool, Priority};
use genex_render::presets::{STREAM_POOL_DESKTOP_BYTES, STREAM_POOL_PHONE_BYTES, STREAM_POOL_WEB_UNKNOWN_BYTES, stream_budget};
use genex_render::timing::Clock;
use genex_render::RenderError;
use genex_stream::grid::{Grid, view_cells};
use genex_stream::{EntryState, Requester, Residency, ResidencyClock, ResidencyLimits, ResidencyStats, Want};
use glam::{Vec2, Vec3};

use crate::camera::Camera;
use crate::frame::{Color, Frame};
use crate::gfx::Model;
use crate::group::InstanceGroup;
use crate::present::{AssetCache, ModelSource, Uploads};
use crate::runtime::Runtime;
use crate::stream::{CellContent, CellModel, Streaming};
use crate::stream_source::{AsyncSource, StreamBytes, StreamRequest};
use groups::{CellGroups, ViewGroup};
use meshes::CoarsePlan;

/// The most models one cell may draw; a cell past it is refused and draws nothing.
pub const STREAM_VIEW_CELL_MODELS_MAX: usize = 1024;
/// What a model is expected to hold before its bytes were ever read: the pool reserves this much
/// for a load it starts (the asset index's sizes replace it in STR-19).
pub const STREAM_VIEW_MODEL_ESTIMATE_BYTES: u64 = 1024 * 1024;
/// Loads in flight on a desktop, by tier: ultra, high, mid, low (design-STREAM 3.3).
pub const STREAM_LOADS_DESKTOP: [u32; 4] = [16, 12, 8, 6];
/// Loads in flight on a phone, by tier: high (and ultra), mid, low.
pub const STREAM_LOADS_PHONE: [u32; 3] = [6, 4, 3];
/// Loads in flight in a browser (the web shell's `ASSET_FETCHES`).
pub const STREAM_LOADS_WEB: u32 = 6;
/// Pixels per world unit the load priority reads (nearer cells first; only the order matters).
const PRIORITY_PIXELS_PER_UNIT: f32 = 1000.0;
/// The tag the view set's draws count under (`state().__render.tags`).
const STREAM_TAG: &str = "stream";
/// The height the cell overlay is drawn at.
const OVERLAY_Y: f32 = 0.0;

/// What the view set reads of a game each frame: its registration, its cell builders and the seed.
pub(crate) struct ViewInputs {
    cell_size: f32,
    view_metres: f32,
    contents: Vec<CellContent>,
    seed: u32,
}

impl ViewInputs {
    pub(crate) fn new(streaming: &Streaming, contents: &[CellContent], seed: u32) -> ViewInputs {
        ViewInputs { cell_size: streaming.cell_size(), view_metres: streaming.view_metres(), contents: contents.to_vec(), seed }
    }
}

/// The view set's per-class limits: the residency policy's (pool, loads in flight) and the frame
/// thread's (finish milliseconds, upload bytes).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ViewLimits {
    /// The content pool, the in-flight cap and the drain's time limit.
    pub residency: ResidencyLimits,
    /// Milliseconds of decoding and uploading per frame.
    pub finish_ms: f64,
    /// Read bytes uploaded per frame (soft: one larger load goes alone).
    pub upload_bytes: u64,
    /// What the pool reserves for a model whose bytes were never read
    /// ([`STREAM_VIEW_MODEL_ESTIMATE_BYTES`] by default).
    pub estimate_bytes: u64,
}

impl ViewLimits {
    /// The limits of `class` on `os`: the pool row of its tier (a browser's at most the pool a
    /// browser that hides its memory gets), its loads in flight, finish and upload budgets.
    pub fn for_class(class: DeviceClass, os: TargetOs) -> ViewLimits {
        let budget = stream_budget(class, os);
        let (pool, loads) = if class.form == FormFactor::Mobile {
            (STREAM_POOL_PHONE_BYTES[phone_row(class.tier)], STREAM_LOADS_PHONE[phone_row(class.tier)])
        } else {
            (STREAM_POOL_DESKTOP_BYTES[desktop_row(class.tier)], STREAM_LOADS_DESKTOP[desktop_row(class.tier)])
        };
        let (pool, loads) = if os == TargetOs::Web { (pool.min(STREAM_POOL_WEB_UNKNOWN_BYTES), loads.min(STREAM_LOADS_WEB)) } else { (pool, loads) };
        ViewLimits {
            residency: ResidencyLimits { forbid_holes: true, ..ResidencyLimits::new(pool, loads) },
            finish_ms: budget.finish_ms,
            upload_bytes: budget.upload_bytes,
            estimate_bytes: STREAM_VIEW_MODEL_ESTIMATE_BYTES,
        }
    }

    /// The same limits with a content pool of `bytes` (a test, a phone told to shed memory).
    pub fn with_pool(self, bytes: u64) -> ViewLimits {
        ViewLimits { residency: ResidencyLimits { pool_bytes: bytes, ..self.residency }, ..self }
    }

    /// The same limits reserving `bytes` for a model never read.
    pub fn with_estimate(self, bytes: u64) -> ViewLimits {
        ViewLimits { estimate_bytes: bytes, ..self }
    }
}

const fn desktop_row(tier: PerformanceTier) -> usize {
    match tier {
        PerformanceTier::Ultra => 0,
        PerformanceTier::High => 1,
        PerformanceTier::Mid => 2,
        _ => 3,
    }
}

const fn phone_row(tier: PerformanceTier) -> usize {
    match tier {
        PerformanceTier::Ultra | PerformanceTier::High => 0,
        PerformanceTier::Mid => 1,
        _ => 2,
    }
}

/// What the view set holds and did in the last frame (`state().volatile.__stream.view`,
/// [`ViewStats::volatile_value`]).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ViewStats {
    /// The residency policy's counts (resident bytes, in flight, queued, evicted, refused).
    pub residency: ResidencyStats,
    /// Cells within the view radius.
    pub cells_wanted: u32,
    /// Of those, cells built (their draws known).
    pub cells_built: u32,
    /// Cells refused for drawing more than [`STREAM_VIEW_CELL_MODELS_MAX`] models, since the start.
    pub cells_refused: u64,
    /// Models decoded and uploaded in the last frame.
    pub finished: u32,
    /// Milliseconds the last frame spent on them, by the presenter's clock.
    pub finish_ms: f64,
    /// Read bytes the last frame uploaded.
    pub upload_bytes: u64,
    /// Model draws and model groups of built cells left out of the last frame because the model
    /// was loading.
    pub loading_draws: u32,
    /// Retained groups of built cells the last frame drew (STR-20).
    pub groups: u32,
    /// Their instances together.
    pub group_instances: u64,
    /// How the last settled capture's drain ended (STR-25).
    pub drain: DrainReport,
    /// Drains that ran out of time since the start.
    pub drain_timeouts: u64,
}

impl ViewStats {
    /// `state().volatile.__stream.view`: `{residentBytes, heldBytes, inFlight, queued, evicted,
    /// refused, cells, cellsBuilt, cellsRefused, finished, finishMs, uploadBytes, loading, groups,
    /// groupInstances, drainPasses, drainMs, drainTimeouts}`, plus `timeout:
    /// "stream-drain-timeout"` while the last drain ran out of time. Display only, never in the
    /// checksum.
    pub fn volatile_value(&self) -> CoreValue {
        let r = &self.residency;
        let mut value = CoreValue::object();
        for (key, number) in [
            ("residentBytes", r.resident_bytes),
            ("heldBytes", r.held_bytes),
            ("inFlight", u64::from(r.in_flight)),
            ("queued", u64::from(r.queued)),
            ("evicted", r.evicted),
            ("refused", u64::from(r.refused)),
            ("cells", u64::from(self.cells_wanted)),
            ("cellsBuilt", u64::from(self.cells_built)),
            ("cellsRefused", self.cells_refused),
            ("finished", u64::from(self.finished)),
            ("uploadBytes", self.upload_bytes),
            ("loading", u64::from(self.loading_draws)),
            ("groups", u64::from(self.groups)),
            ("groupInstances", self.group_instances),
            ("drainPasses", u64::from(self.drain.passes)),
            ("drainTimeouts", self.drain_timeouts),
        ] {
            value.set(key, CoreValue::from(number));
        }
        value.set("finishMs", CoreValue::from(self.finish_ms));
        value.set("drainMs", CoreValue::from(self.drain.ms));
        if self.drain.timed_out {
            value.set("timeout", CoreValue::from(genex_stream::StreamErrorCode::DrainTimeout.wire()));
        }
        value
    }
}

/// What a frame's update works with: the presenter's cache, sources, uploads, clock and log.
pub struct ViewIo<'a> {
    /// Where loaded models are kept by path (and where the draw finds them).
    pub assets: &'a mut AssetCache,
    /// The presenter's source: a model's sidecars, and the bytes when no async source is set.
    pub source: &'a dyn ModelSource,
    /// The renderer the models go to.
    pub uploads: &'a mut dyn Uploads,
    /// The frame clock the finish budget is measured with.
    pub clock: &'a Clock,
    /// Where refusals are reported.
    pub log: &'a mut dyn FnMut(&str),
}

/// What a cell's view build draws: its models and its groups, in build order.
type CellView = (Vec<CellModel>, Vec<InstanceGroup>);

/// A cell of the view set: building, built (its models; its groups are in [`CellGroups`]) or
/// refused.
enum ViewCell {
    Building(Job<Result<CellView, usize>>),
    Built(Vec<ViewModel>),
    Refused,
}

/// One model draw of a built cell: the draw, its residency key (None for a missing model, which
/// draws the checker) and its coarse stand-in while it holds one (STR-19, `meshes.rs`).
struct ViewModel {
    draw: CellModel,
    key: Option<u32>,
    coarse: Option<CoarseDraw>,
}

/// A whole model's coarse stand-in, held (a `View` reference) until the whole model is resident.
struct CoarseDraw {
    key: u32,
    model: Model,
}

/// A read that came back and waits for the frame thread: the model's key and its bytes, or why
/// not.
type Answered = (u32, Result<StreamBytes, String>);

/// The residency key bit of a coarse stand-in (the rest is its whole model's key).
const COARSE_BIT: u32 = 1 << 31;
/// What a stand-in is kept under in the presenter's cache: its model's path and this suffix.
const COARSE_SUFFIX: &str = ".coarse";

/// A coarse read in flight: its plan and the pieces that came back.
struct CoarseRead {
    plan: CoarsePlan,
    pieces: Vec<Option<StreamBytes>>,
}

/// The presenter's streamed view set (module doc).
pub struct StreamView {
    limits: ViewLimits,
    residency: Residency<u32>,
    cells: BTreeMap<CellId, ViewCell>,
    /// The built cells' retained groups (STR-20, `groups.rs`).
    groups: CellGroups,
    /// Model paths by key, and keys by path.
    paths: Vec<Arc<str>>,
    keys: BTreeMap<Arc<str>, u32>,
    /// The bytes a model held when it was last resident (the estimate for its next load).
    sizes: BTreeMap<u32, u64>,
    source: Option<Box<dyn AsyncSource>>,
    /// Reads in flight: the key, and the piece of its coarse read (None: a whole file).
    reads: BTreeMap<StreamRequest, (u32, Option<usize>)>,
    /// Coarse reads in flight, by stand-in key.
    coarse_reads: BTreeMap<u32, CoarseRead>,
    /// The asset index's coarse plans by path, once read (only with an async source).
    plans: Option<BTreeMap<String, CoarsePlan>>,
    answered: VecDeque<Answered>,
    pool: Option<Arc<Pool>>,
    seed: Option<u32>,
    /// The registration's cell side, once a frame read it (the overlay's squares).
    cell_size: Option<f32>,
    /// The dearest finish seen, in milliseconds: what the next one is expected to cost.
    dearest_ms: f64,
    cells_refused: u64,
    /// The last drain, and the drains that ran out of time (STR-25).
    drain: DrainReport,
    drain_timeouts: u64,
    last: ViewStats,
}

impl std::fmt::Debug for StreamView {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StreamView").field("cells", &self.cells.len()).field("stats", &self.stats()).finish()
    }
}

impl StreamView {
    /// An empty view set under `limits`.
    pub fn new(limits: ViewLimits) -> StreamView {
        StreamView {
            limits,
            residency: Residency::new(limits.residency),
            cells: BTreeMap::new(),
            groups: CellGroups::default(),
            paths: Vec::new(),
            keys: BTreeMap::new(),
            sizes: BTreeMap::new(),
            source: None,
            reads: BTreeMap::new(),
            coarse_reads: BTreeMap::new(),
            plans: None,
            answered: VecDeque::new(),
            pool: None,
            seed: None,
            cell_size: None,
            dearest_ms: 0.0,
            cells_refused: 0,
            drain: DrainReport::default(),
            drain_timeouts: 0,
            last: ViewStats::default(),
        }
    }

    /// The limits in force.
    pub fn limits(&self) -> ViewLimits {
        self.limits
    }

    /// New limits (a class change, memory pressure): the next frame's drain enforces a smaller pool.
    pub fn set_limits(&mut self, limits: ViewLimits) {
        self.limits = limits;
        self.residency.set_limits(limits.residency);
    }

    /// Read models through `source` from now on (natively `StreamFiles`, on the web the page's
    /// fetches); reads in flight on the previous source are dropped and their loads fail.
    pub fn set_source(&mut self, source: Box<dyn AsyncSource>) {
        let keys: std::collections::BTreeSet<u32> = std::mem::take(&mut self.reads).into_values().map(|(key, _)| key).collect();
        for key in keys {
            self.residency.fail(key);
        }
        self.coarse_reads.clear();
        self.source = Some(source);
    }

    /// Run cell builds on `pool` instead of the process pool (tests and tools).
    pub fn use_pool(&mut self, pool: Arc<Pool>) {
        self.pool = Some(pool);
    }

    /// What the view set holds now, with the last frame's work.
    pub fn stats(&self) -> ViewStats {
        let built = self.cells.values().filter(|cell| !matches!(cell, ViewCell::Building(_))).count();
        ViewStats {
            residency: self.residency.stats(),
            cells_built: built as u32,
            cells_refused: self.cells_refused,
            drain: self.drain,
            drain_timeouts: self.drain_timeouts,
            ..self.last
        }
    }

    /// Whether a settled capture may be drawn (STR-25, `drain.rs`): no cell building, no read in
    /// flight or waiting to be finished, no load the policy could still start, and nothing a built
    /// cell draws still loading.
    pub fn settled(&self) -> bool {
        let building = self.cells.values().any(|cell| matches!(cell, ViewCell::Building(_)));
        let reading = !self.reads.is_empty() || !self.coarse_reads.is_empty() || !self.answered.is_empty();
        let residency = self.residency.stats();
        // A queued load the pool has no room for stays queued: as settled as the view gets.
        let startable = residency.queued > residency.waiting_for_room;
        if building || reading || startable || residency.in_flight > 0 {
            return false;
        }
        let loading = |key: u32| matches!(self.residency.state(key), Some(EntryState::Loading));
        let models_loading = self.cells.values().any(|cell| match cell {
            ViewCell::Built(models) => models.iter().filter_map(|entry| entry.key).any(loading),
            ViewCell::Building(_) | ViewCell::Refused => false,
        });
        !models_loading && !self.groups.any_waiting(loading)
    }

    /// Record how a settled capture's drain ended: `volatile.__stream.view` names its passes and
    /// milliseconds, and `timeout` while it ran out of time (STR-25).
    pub fn note_drain(&mut self, report: DrainReport) {
        self.drain = report;
        if report.timed_out {
            self.drain_timeouts += 1;
        }
    }

    /// One frame of the view set for `runtime` seen from `camera` (module doc). Nothing without
    /// `game.streaming`. A lost device stops the frame (`device-lost`): the load it was finishing
    /// waits for the next frame.
    pub fn update<W>(&mut self, runtime: &Runtime<W>, camera: &Camera, io: ViewIo<'_>) -> Result<(), RenderError> {
        let Some(inputs) = runtime.stream_view() else { return Ok(()) };
        if self.seed != Some(inputs.seed) {
            self.forget_cells();
            self.seed = Some(inputs.seed);
        }
        self.cell_size = Some(inputs.cell_size);
        let ground = Vec2::new(camera.position.x, camera.position.z);
        let wanted = wanted_cells(&inputs, ground);
        self.last = ViewStats { cells_wanted: wanted.len() as u32, ..ViewStats::default() };
        self.read_plans(io.source);
        self.follow(&wanted, &inputs);
        self.take_builds(ground, inputs.cell_size);
        self.start_reads(io.source);
        self.take_answers();
        let ViewIo { assets, source, uploads, clock, log } = io;
        self.finish(assets, source, uploads, clock, log)?;
        self.let_stand_ins_go();
        self.evict(assets, uploads, clock, log);
        Ok(())
    }

    /// Append the frame's view-set draws to `frame` (module doc), and the cell overlay when the
    /// frame asked for it ([`Frame::cells_debug`]).
    pub fn draw_into(&mut self, frame: &mut Frame) {
        let mut loading = 0u32;
        let mut drew_any = false;
        for cell in self.cells.values() {
            let ViewCell::Built(models) = cell else { continue };
            for entry in models {
                let Some(model) = self.drawn_model(entry) else {
                    loading += 1;
                    continue;
                };
                if !drew_any {
                    frame.tag(STREAM_TAG);
                    drew_any = true;
                }
                frame.model(model, entry.draw.transform);
            }
        }
        let residency = &self.residency;
        let groups = self.groups.draw_into(frame, |key| matches!(residency.state(key), None | Some(EntryState::Resident | EntryState::Refused)));
        if groups.groups > 0 && !drew_any {
            frame.tag(STREAM_TAG);
        }
        self.last.loading_draws = loading + groups.loading;
        self.last.groups = groups.groups;
        self.last.group_instances = groups.instances;
        if frame.wants_cells_debug() {
            self.draw_overlay(frame);
        }
    }

    /// What a model draw draws this frame: the whole model when resident or refused (the
    /// checker), else its coarse stand-in when that is resident, else nothing (it loads).
    fn drawn_model<'a>(&self, entry: &'a ViewModel) -> Option<&'a Model> {
        let Some(key) = entry.key else { return Some(&entry.draw.model) };
        match self.residency.state(key) {
            None | Some(EntryState::Resident | EntryState::Refused) => Some(&entry.draw.model),
            Some(EntryState::Queued | EntryState::Loading) => {
                let coarse = entry.coarse.as_ref()?;
                (self.residency.state(coarse.key) == Some(EntryState::Resident)).then_some(&coarse.model)
            }
        }
    }

    /// Read the asset index's coarse plans once, when reads go through an async source (an
    /// inline source reads a whole model at once, so a coarse read would only cost more).
    fn read_plans(&mut self, source: &dyn ModelSource) {
        if self.plans.is_some() || self.source.is_none() {
            return;
        }
        let plans = source.model_bytes(meshes::ASSET_INDEX_FILE).map(|index| meshes::coarse_plans(&index)).unwrap_or_default();
        self.plans = Some(plans.into_iter().collect());
    }

    /// Whole models now resident give back their stand-ins' references.
    fn let_stand_ins_go(&mut self) {
        let residency = &mut self.residency;
        for cell in self.cells.values_mut() {
            let ViewCell::Built(models) = cell else { continue };
            for entry in models.iter_mut() {
                let whole = entry.key.is_some_and(|key| residency.state(key) == Some(EntryState::Resident));
                if whole && let Some(coarse) = entry.coarse.take() {
                    residency.release(coarse.key, Requester::View);
                }
            }
        }
    }

    /// Follow the wanted cells: a cell that left gives back its models' references and its build;
    /// a new one starts building.
    fn follow(&mut self, wanted: &[CellId], inputs: &ViewInputs) {
        let gone: Vec<CellId> = self.cells.keys().filter(|cell| wanted.binary_search(cell).is_err()).copied().collect();
        for cell in gone {
            self.drop_cell(cell);
        }
        for cell in wanted {
            if self.cells.contains_key(cell) {
                continue;
            }
            let (contents, seed, cell_size, at) = (inputs.contents.clone(), inputs.seed, inputs.cell_size, *cell);
            let pool: &Pool = match &self.pool {
                Some(pool) => pool,
                None => Pool::global(),
            };
            let job = pool.spawn(Priority::Visible, move || build_view(&contents, at, seed, cell_size));
            self.cells.insert(*cell, ViewCell::Building(job));
        }
    }

    /// Cells whose build finished: their models take a `View` reference each, nearer cells sooner.
    fn take_builds(&mut self, ground: Vec2, cell_size: f32) {
        let ready: Vec<CellId> =
            self.cells.iter().filter_map(|(cell, view)| matches!(view, ViewCell::Building(job) if job.is_ready()).then_some(*cell)).collect();
        for cell in ready {
            let Some(ViewCell::Building(job)) = self.cells.remove(&cell) else { continue };
            let (models, groups) = match job.into_result() {
                Ok(Ok(view)) => view,
                Ok(Err(_)) | Err(_) => {
                    self.cells_refused += 1;
                    self.cells.insert(cell, ViewCell::Refused);
                    continue;
                }
            };
            let priority_px = cell_priority(cell, ground, cell_size);
            let keyed = models.into_iter().map(|draw| self.request_model(draw, priority_px)).collect();
            let keyed_groups = groups.into_iter().map(|group| self.request_group(group, priority_px)).collect();
            self.groups.insert(cell, keyed_groups);
            self.cells.insert(cell, ViewCell::Built(keyed));
        }
    }

    /// A built cell's model draw takes a `View` reference on its model and, when the index plans
    /// a coarse read of it and the model is not resident, on its stand-in too (the whole model's
    /// parent, so `forbid_holes` keeps the stand-in until the whole model arrives).
    fn request_model(&mut self, draw: CellModel, priority_px: f32) -> ViewModel {
        let Some(path) = draw.model.path().map(str::to_owned) else { return ViewModel { draw, key: None, coarse: None } };
        let key = self.key_of(&path);
        let plan = self.plans.as_ref().and_then(|plans| plans.get(&path)).cloned();
        let resident = self.residency.state(key) == Some(EntryState::Resident);
        let estimate = self.sizes.get(&key).copied().or(plan.as_ref().map(|plan| plan.file_bytes)).unwrap_or(self.limits.estimate_bytes);
        let mut want = Want::new(priority_px, estimate);
        let coarse = match plan {
            Some(plan) if !resident => {
                let coarse_key = key | COARSE_BIT;
                self.residency.request(coarse_key, Requester::View, Want::new(priority_px, plan.bytes));
                want = want.under(coarse_key);
                Some(CoarseDraw { key: coarse_key, model: Model::unrecorded(&format!("{path}{COARSE_SUFFIX}")) })
            }
            _ => None,
        };
        self.residency.request(key, Requester::View, want);
        ViewModel { draw, key: Some(key), coarse }
    }

    /// A built cell's model group takes a `View` reference on its model (STR-20); cubes and spheres
    /// never wait.
    fn request_group(&mut self, group: InstanceGroup, priority_px: f32) -> ViewGroup {
        let Some(path) = groups::model_path(&group).map(str::to_owned) else { return ViewGroup { group, key: None } };
        let key = self.key_of(&path);
        let estimate = self.sizes.get(&key).copied().unwrap_or(self.limits.estimate_bytes);
        self.residency.request(key, Requester::View, Want::new(priority_px, estimate));
        ViewGroup { group, key: Some(key) }
    }

    /// Start the loads the policy lets go: an async read each (a coarse stand-in's by its ranges),
    /// or the presenter's source at once.
    fn start_reads(&mut self, inline: &dyn ModelSource) {
        for key in self.residency.start_loads() {
            let path = Arc::clone(&self.paths[(key & !COARSE_BIT) as usize]);
            let Some(source) = self.source.as_mut() else {
                self.answered.push_back((key, inline_bytes(inline, &path)));
                continue;
            };
            let plan = (key & COARSE_BIT != 0).then(|| self.plans.as_ref().and_then(|plans| plans.get(&*path)).cloned()).flatten();
            match plan {
                Some(plan) => {
                    for (piece, range) in plan.ranges.iter().enumerate() {
                        let request = source.request(&path, Some(range.clone()), Priority::Visible);
                        self.reads.insert(request, (key, Some(piece)));
                    }
                    let pieces = vec![None; plan.ranges.len()];
                    self.coarse_reads.insert(key, CoarseRead { plan, pieces });
                }
                None => {
                    let request = source.request(&path, None, Priority::Visible);
                    self.reads.insert(request, (key, None));
                }
            }
        }
    }

    /// The async source's answers, in the order the reads finished; a coarse read is answered once
    /// its last piece came, as the stand-in its pieces make.
    fn take_answers(&mut self) {
        let Some(source) = self.source.as_mut() else { return };
        for (request, answer) in source.poll() {
            let Some((key, piece)) = self.reads.remove(&request) else { continue };
            let answer = answer.map_err(|error| error.to_string());
            let Some(piece) = piece else {
                self.answered.push_back((key, answer));
                continue;
            };
            let Some(read) = self.coarse_reads.get_mut(&key) else { continue };
            match answer {
                Ok(bytes) => read.pieces[piece] = Some(bytes),
                Err(detail) => {
                    self.coarse_reads.remove(&key);
                    self.reads.retain(|_, (pending, _)| *pending != key);
                    self.answered.push_back((key, Err(detail)));
                    continue;
                }
            }
            if read.pieces.iter().all(Option::is_some) {
                let Some(read) = self.coarse_reads.remove(&key) else { continue };
                self.answered.push_back((key, stand_in_of(&read)));
            }
        }
    }

    /// Decode and upload read models under the frame's budgets (module doc).
    fn finish(
        &mut self,
        assets: &mut AssetCache,
        source: &dyn ModelSource,
        uploads: &mut dyn Uploads,
        clock: &Clock,
        log: &mut dyn FnMut(&str),
    ) -> Result<(), RenderError> {
        let started = now_ms(clock);
        let (mut spent, mut bytes, mut finished) = (0.0, 0u64, 0u32);
        while let Some((key, answer)) = self.answered.pop_front() {
            let size = answer.as_ref().map_or(0, |read| read.len() as u64);
            let fits_time = spent + self.dearest_ms <= self.limits.finish_ms;
            let fits_bytes = bytes.saturating_add(size) <= self.limits.upload_bytes;
            if finished > 0 && !(fits_time && fits_bytes) {
                self.answered.push_front((key, answer));
                break;
            }
            let before = now_ms(clock);
            if let Err(error) = self.finish_one(key, &answer, assets, source, uploads, log) {
                self.answered.push_front((key, answer));
                return Err(error);
            }
            let cost = now_ms(clock) - before;
            self.dearest_ms = self.dearest_ms.max(cost);
            spent = now_ms(clock) - started;
            bytes = bytes.saturating_add(size);
            finished += 1;
        }
        self.last.finished = finished;
        self.last.finish_ms = spent;
        self.last.upload_bytes = bytes;
        Ok(())
    }

    /// Decode and upload one read model into the cache: resident with its bytes, or refused (its
    /// draws then show the checker).
    fn finish_one(
        &mut self,
        key: u32,
        answer: &Result<StreamBytes, String>,
        assets: &mut AssetCache,
        source: &dyn ModelSource,
        uploads: &mut dyn Uploads,
        log: &mut dyn FnMut(&str),
    ) -> Result<(), RenderError> {
        let path = self.cache_path(key);
        let loaded = match answer {
            Ok(bytes) => {
                let read = ReadModel { path: &path, bytes, rest: source };
                crate::present::load_model(&path, &read, uploads, log)?
            }
            Err(detail) => {
                log(&format!("model {path:?} could not be read: {detail}; drawing the missing-asset checker"));
                None
            }
        };
        match loaded {
            Some(model) => {
                let bytes = answer.as_ref().map_or(0, |read| read.len() as u64);
                assets.put_model(&path, Some(model));
                self.sizes.insert(key, bytes);
                self.residency.finish(key, bytes);
            }
            None => {
                assets.put_model(&path, None);
                self.residency.fail(key);
            }
        }
        Ok(())
    }

    /// Evict what the pool cannot keep: each evicted model leaves the cache and its meshes the
    /// renderer's arena (a refused removal is logged; the policy has let the model go either way).
    fn evict(&mut self, assets: &mut AssetCache, uploads: &mut dyn Uploads, clock: &Clock, log: &mut dyn FnMut(&str)) {
        let mut residency_clock = FrameClock(clock);
        for key in self.residency.drain(&mut residency_clock) {
            let path = self.cache_path(key);
            let Some(model) = assets.take_model(&path) else { continue };
            for part in model.parts {
                if let Err(error) = uploads.remove_mesh(part.mesh) {
                    log(&format!("model {path:?}: its mesh was not removed: {error}"));
                }
            }
        }
    }

    /// A cell left the view: its build is cancelled and its models' references go back.
    fn drop_cell(&mut self, cell: CellId) {
        match self.cells.remove(&cell) {
            Some(ViewCell::Building(job)) => {
                job.cancel();
            }
            Some(ViewCell::Built(models)) => {
                for entry in models {
                    let keys = entry.key.into_iter().chain(entry.coarse.map(|coarse| coarse.key));
                    for key in keys {
                        self.residency.release(key, Requester::View);
                    }
                }
            }
            Some(ViewCell::Refused) | None => {}
        }
        for key in self.groups.remove(cell) {
            self.residency.release(key, Requester::View);
        }
    }

    /// A new seed: every cell is dropped (builds read the seed); resident models stay until evicted.
    fn forget_cells(&mut self) {
        let cells: Vec<CellId> = self.cells.keys().copied().collect();
        for cell in cells {
            self.drop_cell(cell);
        }
    }

    /// What `key` is kept under in the presenter's cache: its path, a stand-in's with
    /// [`COARSE_SUFFIX`].
    fn cache_path(&self, key: u32) -> Arc<str> {
        let path = &self.paths[(key & !COARSE_BIT) as usize];
        if key & COARSE_BIT == 0 {
            return Arc::clone(path);
        }
        Arc::from(format!("{path}{COARSE_SUFFIX}"))
    }

    fn key_of(&mut self, path: &str) -> u32 {
        if let Some(key) = self.keys.get(path) {
            return *key;
        }
        let key = self.paths.len() as u32;
        let path: Arc<str> = Arc::from(path);
        self.paths.push(Arc::clone(&path));
        self.keys.insert(path, key);
        key
    }

    /// Each wanted cell's outline, one batch per state ([`Frame::cells_debug`]).
    fn draw_overlay(&self, frame: &mut Frame) {
        let Some(cell_size) = self.cell_size else { return };
        let mut batches: [(Color, Vec<Vec3>); 4] =
            [(Color::GREEN, Vec::new()), (Color::rgb(240, 200, 40), Vec::new()), (Color::rgb(140, 140, 140), Vec::new()), (Color::RED, Vec::new())];
        for (cell, view) in &self.cells {
            let batch = match view {
                ViewCell::Building(_) => 2,
                ViewCell::Refused => 3,
                ViewCell::Built(models) => self.built_state(models),
            };
            batches[batch].1.extend(outline(*cell, cell_size));
        }
        frame.tag(STREAM_TAG);
        for (color, points) in &batches {
            if !points.is_empty() {
                frame.lines(points, *color);
            }
        }
    }

    /// The overlay batch of a built cell: drawn (0), loading (1) or refused (3).
    fn built_state(&self, models: &[ViewModel]) -> usize {
        let states = models.iter().map(|entry| entry.key.and_then(|key| self.residency.state(key)));
        let mut batch = 0;
        for state in states {
            match state {
                None | Some(EntryState::Refused) => return 3,
                Some(EntryState::Queued | EntryState::Loading) => batch = 1,
                Some(EntryState::Resident) => {}
            }
        }
        batch
    }
}

/// The world cells within the view radius of `ground`, ascending (none when the registration's
/// grid or radius is refused, which install already refused).
fn wanted_cells(inputs: &ViewInputs, ground: Vec2) -> Vec<CellId> {
    let Ok(grid) = Grid::new(inputs.cell_size) else { return Vec::new() };
    let Ok(view) = view_cells(&grid, ground, inputs.view_metres, inputs.view_metres) else { return Vec::new() };
    let mut cells: Vec<CellId> = view.detail.into_iter().chain(view.far).filter(|cell| grid.contains(*cell)).collect();
    cells.sort_unstable();
    cells
}

/// Run every builder on `cell` (on a worker) and keep what it draws, in registration then build
/// order; past [`STREAM_VIEW_CELL_MODELS_MAX`] models, or groups past the cell's instance cap, the
/// cell is refused (the count it reached).
fn build_view(contents: &[CellContent], cell: CellId, seed: u32, cell_size: f32) -> Result<CellView, usize> {
    let (mut models, mut groups) = (Vec::new(), Vec::new());
    for content in contents {
        let build = (content.run)(cell, seed, cell_size);
        models.extend(build.views);
        groups.extend(build.groups);
    }
    if models.len() > STREAM_VIEW_CELL_MODELS_MAX {
        return Err(models.len());
    }
    if groups::over_cap(&groups) {
        return Err(groups.iter().map(InstanceGroup::len).sum());
    }
    Ok((models, groups))
}

/// The load priority of a cell's models: the screen-space error of a cell-sized error at the
/// distance from `ground` to the cell's centre (nearer is higher).
fn cell_priority(cell: CellId, ground: Vec2, cell_size: f32) -> f32 {
    let centre = Vec2::new((cell.x as f32 + 0.5) * cell_size, (cell.z as f32 + 0.5) * cell_size);
    genex_stream::residency::screen_space_error_px(cell_size, centre.distance(ground).max(f32::MIN_POSITIVE), PRIORITY_PIXELS_PER_UNIT)
}

/// The stand-in a finished coarse read makes ([`meshes::coarse_stand_in`]).
fn stand_in_of(read: &CoarseRead) -> Result<StreamBytes, String> {
    let pieces: Vec<(std::ops::Range<u64>, &[u8])> =
        read.plan.ranges.iter().cloned().zip(&read.pieces).filter_map(|(range, bytes)| Some((range, &**bytes.as_ref()?))).collect();
    meshes::coarse_stand_in(&pieces, read.plan.file_bytes).map(|glb| StreamBytes::Read(Arc::from(glb))).map_err(|refused| refused.0)
}

/// A model's bytes from the presenter's own source, read at once (no async source set).
fn inline_bytes(source: &dyn ModelSource, path: &str) -> Result<StreamBytes, String> {
    if let Some(bytes) = source.static_bytes(path) {
        return Ok(StreamBytes::Static(bytes));
    }
    match source.model_bytes(path) {
        Some(bytes) => Ok(StreamBytes::Read(Arc::from(bytes))),
        None => Err("not in the game's assets".to_owned()),
    }
}

/// A cell's outline as segment pairs on the ground.
fn outline(cell: CellId, cell_size: f32) -> [Vec3; 8] {
    let (x0, z0) = (cell.x as f32 * cell_size, cell.z as f32 * cell_size);
    let (x1, z1) = (x0 + cell_size, z0 + cell_size);
    let corner = |x: f32, z: f32| Vec3::new(x, OVERLAY_Y, z);
    [corner(x0, z0), corner(x1, z0), corner(x1, z0), corner(x1, z1), corner(x1, z1), corner(x0, z1), corner(x0, z1), corner(x0, z0)]
}

/// Milliseconds on the presenter's clock.
fn now_ms(clock: &Clock) -> f64 {
    clock().as_secs_f64() * 1000.0
}

/// The presenter's clock as the residency drain reads it.
struct FrameClock<'a>(&'a Clock);

impl ResidencyClock for FrameClock<'_> {
    fn now_ms(&mut self) -> f64 {
        now_ms(self.0)
    }
}

/// A read model as the presenter's loader reads it: its own bytes, everything else (sidecars) from
/// the presenter's source.
struct ReadModel<'a> {
    path: &'a str,
    bytes: &'a StreamBytes,
    rest: &'a dyn ModelSource,
}

impl ModelSource for ReadModel<'_> {
    fn model_bytes(&self, path: &str) -> Option<Vec<u8>> {
        if path == self.path {
            return Some(self.bytes.to_vec());
        }
        self.rest.model_bytes(path)
    }

    fn has_asset(&self, path: &str) -> bool {
        path == self.path || self.rest.has_asset(path)
    }

    fn static_bytes(&self, path: &str) -> Option<&'static [u8]> {
        if path != self.path {
            return self.rest.static_bytes(path);
        }
        match self.bytes {
            StreamBytes::Static(bytes) => Some(bytes),
            StreamBytes::Read(_) => None,
        }
    }
}
