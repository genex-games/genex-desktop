//! `genex::saves`: save slots (G6 saves, UIS-9) over genex-save. A game registers
//! `game.saves(SaveConfig::schema(n))` and what each slot holds (`game.save_world()` for its whole
//! world through serde, `game.save_section(name, save, load)` for anything else); a hook asks
//! `ctx.slots()` to save, load or delete a slot.
//!
//! - A save is a read hook: it is written at the end of the tick that asked for it, after physics,
//!   and never moves the checksum. The envelope carries the state checksum of the tick it holds.
//! - A load is restored before the next tick: a fresh `Sim` is built beside the running one, the
//!   reset hooks run with the slot's seed, then `genex.nav` (when `game.navigation` is registered)
//!   and the game's sections restore in registration order, and the tick and rng are set. Only
//!   then is the new `Sim` swapped in, so a refusal at any step leaves the running game untouched.
//!   The checksum is recomputed and compared with the saved one (`lastLoad.checksumMatch`); a
//!   difference is the volatile issue `save-restore-diverged`, and the load still applies. A
//!   streamed world's comparison waits for its slot cells to be rebuilt (`cells_rebuilt`).
//! - `genex.stream` (when `game.streaming` is registered) holds `sim.stream.snapshot()`: the
//!   anchors, kept cells and active cells. A load restores it after `genex.nav`; before the next
//!   tick's commit the runtime rebuilds the slot's active cells through the commit hooks
//!   (`StreamTick::rebuild_restored`) and the commit moves them to the anchors (STR-12, owner call S5).
//! - Without `game.saves`, `state()` and every checksum are what they were: the slot calls refuse
//!   `save-not-configured` and nothing is read or written.

use std::cell::Cell;
use std::fmt;
use std::rc::Rc;

use genex_core::json::Value as CoreValue;
use genex_core::paths::{self, Destination};
use genex_core::saves::{MAX_TOTAL_SAVE_BYTES, Saves, mirror};
use genex_core::session;
use genex_save::driver::{BodyRead, SlotDriver, SlotStore, Snapshot, Step};
use genex_save::index::SlotIndex;
use genex_save::migrate::{BUILTIN_SECTION_PREFIX, Migrations};
use serde_json::{Map, Value, json};

use crate::game::Game;
use crate::gfx::Gfx;
use crate::rng::Pcg32;
use crate::runtime::InstallErrorCode;
use crate::sim::Sim;

pub use genex_save::autosave::AutosaveRing;
pub use genex_save::driver::{SAVE_LOAD_HOLD_MAX_MS, SLOTS_DEFAULT, SLOTS_MAX, SlotEvent, SlotOp};
pub use genex_save::envelope::{Envelope, LABEL_CHARS_MAX, SECTION_NAME_MAX, SECTIONS_MAX, decode};
pub use genex_save::error::{SAVE_RESTORE_DIVERGED, SaveError, SaveErrorCode};
pub use genex_save::index::{SlotInfo, SlotState};
pub use genex_save::migrate::MIGRATION_STEPS_MAX;
pub use genex_save::slot::{AUTOSAVE_RING_MAX, SLOT_NAME_MAX, SlotName};

/// The built-in section holding `sim.nav` (NAV-12's snapshot), written while `game.navigation` is
/// registered.
pub const NAV_SECTION: &str = "genex.nav";
/// The built-in section holding `sim.stream` (STR-12's snapshot), written while `game.streaming`
/// is registered.
pub const STREAM_SECTION: &str = "genex.stream";
/// The section `game.save_world` registers.
pub const WORLD_SECTION: &str = "world";
/// The save calls the reference's saves page teaches, as the facade vocabulary's `saves` block
/// pins them.
pub const SAVE_CALLS: [&str; 16] = [
    "game.saves",
    "SaveConfig::schema",
    ".migrate",
    ".autosave",
    ".autosave_on_suspend",
    ".slots_max",
    "game.save_section",
    "game.save_world",
    "ctx.slots",
    "slots.list",
    "slots.get",
    "slots.save",
    "slots.load",
    "slots.delete",
    "slots.events",
    "slots.busy",
];
/// The locale a slot records until gameplay UI (UIS-10) names the running one.
const SAVE_LOCALE: &str = "en";
/// Built-in sections a slot may hold beside the game's (`genex.nav` and `genex.stream`), counted
/// against [`SECTIONS_MAX`] at install.
const BUILTIN_SECTIONS_MAX: usize = 2;
/// Simulated ticks a second (genex-core's `FIXED_STEP_MS` is 1000/60): a slot's play time.
const TICKS_PER_SECOND: u64 = 60;
/// How far the web's hold clock moves each time it is read: the facade has no monotonic clock on
/// the web, and a holding frame reads it once.
#[cfg(target_arch = "wasm32")]
const WEB_HOLD_FRAME_MS: u64 = 17;
/// `state().volatile`'s saves key.
const VOLATILE_SAVES_KEY: &str = "saves";
/// `volatile.saves.store` for files on disk.
const STORE_FILES: &str = "files";
/// `volatile.saves.store` for the web shell's IndexedDB mirror.
const STORE_INDEXEDDB: &str = "indexeddb";

/// One migration step, shared so every driver a seed builds takes the same closure.
type SharedStep = Rc<dyn Fn(Value) -> Result<Value, String>>;
type SaveHook<W> = Box<dyn Fn(&Sim<W>) -> Result<Value, String>>;
type LoadHook<W> = Box<dyn Fn(&mut Sim<W>, &Value, &Gfx) -> Result<(), String>>;

/// What `game.saves` registers: the schema, its migrations, the autosave ring and the slot cap.
pub struct SaveConfig {
    schema: u32,
    steps: Vec<(u32, SharedStep)>,
    autosave: Option<(u64, u8)>,
    autosave_on_suspend: bool,
    slots_max: usize,
}

impl SaveConfig {
    /// Saves at schema `version` (at least 1). Slots of an older schema migrate on load.
    pub fn schema(version: u32) -> SaveConfig {
        SaveConfig { schema: version, steps: Vec::new(), autosave: None, autosave_on_suspend: true, slots_max: SLOTS_DEFAULT }
    }

    /// One migration step `from` -> `from + 1`, over a slot's game sections (an object of section
    /// name to value).
    pub fn migrate(mut self, from: u32, step: impl Fn(Value) -> Result<Value, String> + 'static) -> SaveConfig {
        self.steps.push((from, Rc::new(step)));
        self
    }

    /// An autosave every `every_ticks` simulated ticks into a ring of `ring` slots (1 to
    /// [`AUTOSAVE_RING_MAX`]), named `autosave-0` and on.
    pub fn autosave(mut self, every_ticks: u64, ring: u8) -> SaveConfig {
        self.autosave = Some((every_ticks, ring));
        self
    }

    /// Whether a suspend or close writes the ring's oldest slot (default true).
    pub fn autosave_on_suspend(mut self, on: bool) -> SaveConfig {
        self.autosave_on_suspend = on;
        self
    }

    /// At most `slots` named slots (1 to [`SLOTS_MAX`], default [`SLOTS_DEFAULT`]); autosaves are
    /// not counted.
    pub fn slots_max(mut self, slots: usize) -> SaveConfig {
        self.slots_max = slots;
        self
    }

    fn migrations(&self) -> Migrations {
        self.steps.iter().fold(Migrations::new(self.schema), |chain, (from, step)| {
            let step = Rc::clone(step);
            chain.step(*from, move |sections| step(sections))
        })
    }

    /// The slot driver of the game saved as `game`, or why the configuration is refused.
    fn driver(&self, game: &str) -> Result<SlotDriver, String> {
        let migrations = self.migrations();
        migrations.check().map_err(|problem| format!("{problem:?}"))?;
        let mut driver = SlotDriver::new(game, migrations).with_autosave_on_suspend(self.autosave_on_suspend);
        if let Some((every_ticks, ring)) = self.autosave {
            let ring = AutosaveRing::new(every_ticks, ring)
                .ok_or_else(|| format!("autosave every {every_ticks} ticks into {ring} slots (1 to {AUTOSAVE_RING_MAX})"))?;
            driver = driver.with_autosave(ring);
        }
        driver.with_slots_max(self.slots_max)
    }
}

impl fmt::Debug for SaveConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let steps: Vec<u32> = self.steps.iter().map(|(from, _)| *from).collect();
        f.debug_struct("SaveConfig")
            .field("schema", &self.schema)
            .field("steps", &steps)
            .field("autosave", &self.autosave)
            .field("autosave_on_suspend", &self.autosave_on_suspend)
            .field("slots_max", &self.slots_max)
            .finish()
    }
}

/// `game.saves` (the `G6Setup` field): install refuses more than one.
#[derive(Debug, Default)]
pub(crate) struct Setup {
    configs: Vec<SaveConfig>,
}

/// One named section of every slot.
struct Section<W> {
    name: String,
    save: SaveHook<W>,
    load: LoadHook<W>,
}

/// The game's sections in registration order (a `Game` field, generic over the world).
pub(crate) struct Sections<W> {
    list: Vec<Section<W>>,
    /// `W::default`, taken where the world is known to have one: the world a restore resets from.
    fresh: Option<fn() -> W>,
}

impl<W> Default for Sections<W> {
    fn default() -> Sections<W> {
        Sections { list: Vec::new(), fresh: None }
    }
}

impl<W: Default + 'static> Game<W> {
    /// Save slots at `config`'s schema: `ctx.slots()` saves, loads and deletes them. Registered
    /// once; `install` refuses a second (`duplicate-saves`) or an invalid schema chain, autosave
    /// ring or slot cap (`save-schema-invalid`).
    pub fn saves(&mut self, config: SaveConfig) -> &mut Self {
        self.g6.saves.configs.push(config);
        self.save_sections.fresh = Some(W::default);
        self
    }

    /// A named section of every slot. `save` is a read hook (it never moves the checksum); `load`
    /// runs on the restored `Sim` after the reset hooks, in registration order, and an `Err`
    /// refuses the load (`save-section-invalid`) with the running game untouched. `install`
    /// refuses a `genex.` name (`save-section-reserved`) or a repeated one
    /// (`duplicate-save-section`).
    pub fn save_section<S, L>(&mut self, name: &str, save: S, load: L) -> &mut Self
    where
        S: Fn(&Sim<W>) -> Value + 'static,
        L: Fn(&mut Sim<W>, &Value, &Gfx) -> Result<(), String> + 'static,
    {
        self.save_sections.list.push(Section {
            name: name.to_owned(),
            save: Box::new(move |sim| Ok(save(sim))),
            load: Box::new(load),
        });
        self.save_sections.fresh = Some(W::default);
        self
    }
}

impl<W: Default + serde::Serialize + serde::de::DeserializeOwned + 'static> Game<W> {
    /// The whole world as the section `world`, through serde (the common case). Physics bodies,
    /// facet state and anything outside `sim.world` need their own sections.
    pub fn save_world(&mut self) -> &mut Self {
        self.save_sections.list.push(Section {
            name: WORLD_SECTION.to_owned(),
            save: Box::new(|sim| serde_json::to_value(&sim.world).map_err(|error| error.to_string())),
            load: Box::new(|sim, value, _gfx| {
                sim.world = W::deserialize(value).map_err(|error| error.to_string())?;
                Ok(())
            }),
        });
        self.save_sections.fresh = Some(W::default);
        self
    }
}

/// Why `install` refuses the game's save registrations: the code and what it is about.
pub(crate) fn check<W>(game: &Game<W>) -> Result<(), (InstallErrorCode, String)> {
    let configs = &game.g6.saves.configs;
    if configs.len() > 1 {
        return Err((InstallErrorCode::DuplicateSaves, "game.saves is registered once".to_owned()));
    }
    if let Some(config) = configs.first() {
        config.driver(save_name(game)).map_err(|detail| (InstallErrorCode::SaveSchemaInvalid, detail))?;
    }
    let sections = &game.save_sections.list;
    if sections.len() + BUILTIN_SECTIONS_MAX > SECTIONS_MAX {
        let detail = format!("a slot holds at most {} game sections", SECTIONS_MAX - BUILTIN_SECTIONS_MAX);
        return Err((InstallErrorCode::SaveSchemaInvalid, detail));
    }
    let mut seen = std::collections::BTreeSet::new();
    for section in sections {
        let name = section.name.as_str();
        if name.starts_with(BUILTIN_SECTION_PREFIX) {
            let detail = format!("{name}: {BUILTIN_SECTION_PREFIX}* sections are the runtime's");
            return Err((InstallErrorCode::SaveSectionReserved, detail));
        }
        if !section_name_ok(name) {
            return Err((InstallErrorCode::InvalidName, format!("save section {name:?}")));
        }
        if !seen.insert(name) {
            return Err((InstallErrorCode::DuplicateSaveSection, name.to_owned()));
        }
    }
    Ok(())
}

/// The name the game's slots are saved under: `Game::saves_name`, for any world.
fn save_name<W>(game: &Game<W>) -> &str {
    game.save_name.as_deref().unwrap_or(&game.title)
}

/// Whether genex-save's envelope takes `name` as a section name: one rule, asked of the codec
/// itself (it refuses a bad name before it writes anything).
fn section_name_ok(name: &str) -> bool {
    let mut sections = Map::new();
    sections.insert(name.to_owned(), Value::Null);
    let probe = Envelope {
        schema: 1,
        game: String::new(),
        tick: 0,
        seed: 0,
        rng: [0, 0],
        state_checksum: 0,
        sections,
        meta: genex_save::envelope::SaveMeta {
            label: String::new(),
            play_ms: 0,
            saved_at_ms: None,
            locale: String::new(),
            build: String::new(),
        },
    };
    genex_save::envelope::encode(&probe).is_ok()
}

/// The runtime's slots (the `G6` field): built from the game's `SaveConfig` at the first tick
/// after each seed, and again when a shell moves the save root.
pub(crate) struct State {
    driver: Option<SlotDriver>,
    /// The save root the driver's index was read from.
    root: Option<String>,
    /// The saves the driver writes through, for `volatile.saves`.
    saves: Option<Saves>,
    /// Milliseconds on the hold clock (a load waiting for its body).
    clock: Box<dyn FnMut() -> u64>,
    /// A streamed world's load swapped in, its self-check waiting for the restored cells to be
    /// rebuilt ([`cells_rebuilt`]).
    awaiting_cells: bool,
}

impl Default for State {
    fn default() -> State {
        State { driver: None, root: None, saves: None, clock: hold_clock(), awaiting_cells: false }
    }
}

impl fmt::Debug for State {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("State").field("driver", &self.driver).field("root", &self.root).finish_non_exhaustive()
    }
}

/// The process's monotonic clock in milliseconds, for a load's hold only (never the simulation).
#[allow(clippy::disallowed_types, reason = "host glue: a load's hold is timed on the wall clock; the simulation never sees it")]
fn hold_clock() -> Box<dyn FnMut() -> u64> {
    #[cfg(not(target_arch = "wasm32"))]
    {
        let start = std::time::Instant::now();
        Box::new(move || u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX))
    }
    #[cfg(target_arch = "wasm32")]
    {
        let mut frames = 0_u64;
        Box::new(move || {
            frames += 1;
            frames * WEB_HOLD_FRAME_MS
        })
    }
}

/// The wall clock a slot shows as its date, in milliseconds since 1970: None in a Genex run, so
/// no check ever reads a date, and on the web (no clock in the facade yet).
#[allow(clippy::disallowed_types, reason = "display only: a slot's date never reaches the simulation")]
fn saved_at_ms() -> Option<u64> {
    if paths::destination_of(&paths::process_env) == Destination::GenexRun {
        return None;
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let since = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?;
        u64::try_from(since.as_millis()).ok()
    }
    #[cfg(target_arch = "wasm32")]
    {
        None
    }
}

impl State {
    /// A new seed: nothing is pending, and the index is read again at the next tick.
    pub(crate) fn reset(&mut self, _setup: &Setup) {
        self.driver = None;
        self.root = None;
    }

    /// Time a load's hold on `clock` (milliseconds) instead of the process clock (tests).
    pub(crate) fn use_clock(&mut self, clock: Box<dyn FnMut() -> u64>) {
        self.clock = clock;
    }

    /// `ctx.slots()` for this tick.
    pub(crate) fn slots(&self) -> Slots<'_> {
        Slots { driver: self.driver.as_ref() }
    }

    /// Build the driver for `saves` unless it was built for that root already.
    fn ensure(&mut self, config: &SaveConfig, game: &str, saves: &Saves) {
        let root = saves.root();
        if self.driver.is_some() && self.root.as_deref() == root {
            return;
        }
        // Install checked the configuration; a refusal here keeps the game without slots.
        let Ok(mut driver) = config.driver(game) else { return };
        driver.refresh(&Store(saves));
        self.driver = Some(driver);
        self.root = root.map(str::to_owned);
        self.saves = Some(saves.clone());
    }

    /// `state().volatile.saves`, while `game.saves` is registered: display only, never in the
    /// checksum, the same shape on every destination.
    pub(crate) fn volatile_key(&self, setup: &Setup, state: &mut CoreValue) {
        if setup.configs.is_empty() {
            return;
        }
        let mut volatile = state[session::VOLATILE_KEY].clone();
        volatile.set(VOLATILE_SAVES_KEY, CoreValue::from(&self.volatile_value()));
        state.set(session::VOLATILE_KEY, volatile);
    }

    fn volatile_value(&self) -> Value {
        let saves = self.saves.as_ref();
        let mirrored = saves.is_some_and(Saves::is_mirrored);
        let status = if mirrored { mirror::status() } else { mirror::MirrorStatus::default() };
        let files: usize = saves.map_or(0, |saves| SlotIndex::FOLDERS.iter().map(|folder| saves.list(folder).len()).sum());
        let driver = self.driver.as_ref();
        let slots: Vec<Value> = driver.map_or(&[][..], SlotDriver::list).iter().map(slot_value).collect();
        let last_save = driver.and_then(SlotDriver::last_save).map_or(Value::Null, |last| {
            json!({ "slot": last.slot.as_str(), "tick": last.tick, "bytes": last.bytes })
        });
        let last_load = driver.and_then(SlotDriver::last_load).map_or(Value::Null, |last| {
            json!({ "slot": last.slot.as_str(), "tick": last.tick, "checksumMatch": last.checksum_match })
        });
        let issues: &[&str] = driver.map_or(&[], SlotDriver::issues);
        json!({
            "store": if mirrored { STORE_INDEXEDDB } else { STORE_FILES },
            "files": files,
            "bytes": saves.map_or(0, Saves::bytes_used),
            "quota": MAX_TOTAL_SAVE_BYTES,
            // The web shell asks for persistent storage with UIS-12; files on disk persist.
            "persistent": !mirrored,
            "pending": status.pending,
            "inFlight": status.in_flight,
            "lazy": status.lazy,
            "error": status.error.map_or(Value::Null, |error| Value::from(error.wire())),
            "slots": slots,
            "lastSave": last_save,
            "lastLoad": last_load,
            "issues": issues,
        })
    }
}

fn slot_value(info: &SlotInfo) -> Value {
    json!({
        "name": info.name.as_str(),
        "label": info.label,
        "schema": info.schema,
        "tick": info.tick,
        "playMs": info.play_ms,
        "bytes": info.bytes,
        "autosave": info.autosave,
        "state": info.state.wire(),
        "savedAtMs": info.saved_at_ms,
    })
}

/// `ctx.slots()`: the game's save slots as of this tick's start. A save is written after this
/// tick, a load restored before the next one, a delete removed after this tick; each finishes as
/// a [`SlotEvent`] in [`Slots::events`] of a later tick. Without `game.saves` the list is empty
/// and every call refuses `save-not-configured`.
#[derive(Clone, Copy, Debug)]
pub struct Slots<'a> {
    driver: Option<&'a SlotDriver>,
}

impl<'a> Slots<'a> {
    /// Every slot, named and autosave, sorted by name.
    pub fn list(&self) -> &'a [SlotInfo] {
        self.driver.map_or(&[], SlotDriver::list)
    }

    /// The slot named `slot`.
    pub fn get(&self, slot: &str) -> Option<&'a SlotInfo> {
        self.driver?.get(slot)
    }

    /// Queue a save of `slot` labelled `label` (at most [`LABEL_CHARS_MAX`] characters). Refuses
    /// `save-slot-invalid`, `save-busy` and `save-slots-full`.
    pub fn save(&self, slot: &str, label: &str) -> Result<(), SaveError> {
        self.configured()?.request_save(slot, label)
    }

    /// Queue a load of `slot` (a named slot or `autosave-<n>`). Refuses `save-slot-invalid`,
    /// `save-busy`, `save-slot-missing`, `save-newer` and `save-corrupt`.
    pub fn load(&self, slot: &str) -> Result<(), SaveError> {
        self.configured()?.request_load(slot)
    }

    /// Queue a delete of `slot`. Refuses `save-slot-invalid`, `save-busy` and `save-slot-missing`.
    pub fn delete(&self, slot: &str) -> Result<(), SaveError> {
        self.configured()?.request_delete(slot)
    }

    /// The slot operations that finished since the last tick.
    pub fn events(&self) -> &'a [SlotEvent] {
        self.driver.map_or(&[], SlotDriver::events)
    }

    /// Whether a load is queued or waiting for its body (saves and deletes then refuse
    /// `save-busy`).
    pub fn busy(&self) -> bool {
        self.driver.is_some_and(SlotDriver::busy)
    }

    fn configured(&self) -> Result<&'a SlotDriver, SaveError> {
        self.driver.ok_or_else(|| SaveError::new(SaveErrorCode::NotConfigured, "the game registers no game.saves"))
    }
}

/// genex-core's saves as genex-save's slot store (files on disk, or the web mirror).
struct Store<'a>(&'a Saves);

impl SlotStore for Store<'_> {
    fn list(&self, folder: &str) -> Vec<String> {
        self.0.list(folder)
    }

    fn read_meta(&self, file: &str) -> Option<Vec<u8>> {
        self.0.load(file)
    }

    fn read(&mut self, file: &str) -> BodyRead {
        if let Some(bytes) = self.0.load(file) {
            return BodyRead::Ready(bytes);
        }
        // On the web a lazy body the mirror knows is asked of the shell; anything else is gone.
        let lazy = self.0.is_mirrored() && mirror::is_lazy_name(file) && mirror::request(file);
        if lazy { BodyRead::Pending } else { BodyRead::Missing }
    }

    fn write(&mut self, file: &str, bytes: &[u8]) -> Result<(), SaveError> {
        self.0.save_checked(file, bytes).map_err(SaveError::from)
    }

    fn remove(&mut self, file: &str) -> bool {
        self.0.remove(file)
    }

    fn bytes_used(&self) -> u64 {
        self.0.bytes_used()
    }
}

/// What a restore may replace: the running game's simulation, seed, tick and rng.
pub(crate) struct Running<'a, W> {
    /// The running simulation.
    pub(crate) sim: &'a mut Sim<W>,
    /// The seed it was reset on.
    pub(crate) seed: &'a mut u32,
    /// Ticks since that seed.
    pub(crate) tick: &'a mut u64,
    /// The tick rng.
    pub(crate) rng: &'a Cell<Pcg32>,
    /// What reset and load hooks read through.
    pub(crate) gfx: &'a Gfx,
}

/// What the runtime does before a tick, after [`swap_in`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Swap {
    /// Run the tick.
    Run,
    /// Run no tick this frame: a load waits for its body.
    Hold,
    /// A load replaced the running game: the HUD, streaming and the journal start over.
    Restored,
}

/// Before a tick: publish the slot events that finished, and restore a load the last tick asked
/// for (or hold while its body is not resident).
pub(crate) fn swap_in<W>(game: &Game<W>, state: &mut State, running: Running<'_, W>) -> Swap {
    let Some(config) = game.g6.saves.configs.first() else { return Swap::Run };
    state.ensure(config, save_name(game), running.gfx.saves());
    let now = (state.clock)();
    let Some(driver) = state.driver.as_mut() else { return Swap::Run };
    match driver.begin_tick(&mut Store(running.gfx.saves()), now) {
        Step::Run => Swap::Run,
        Step::Hold => Swap::Hold,
        Step::Restore(restore) => {
            let result = restore_into(game, restore.envelope, running);
            let restored = result.is_ok();
            // A streamed world's checksum is compared once its cells are rebuilt: the probes may
            // read streamed colliders or the active set, which the slot does not hold.
            if restored && game.stream_registration().is_some() {
                state.awaiting_cells = true;
            } else {
                driver.restored(result);
            }
            if restored { Swap::Restored } else { Swap::Run }
        }
    }
}

/// Whether a streamed world's load waits for its cells to be rebuilt before its self-check.
pub(crate) fn awaiting_cells(state: &State) -> bool {
    state.awaiting_cells
}

/// A streamed world's load has its cells rebuilt (the slot's active set entered through the
/// commit hooks): recompute the checksum and compare it with the saved one (`lastLoad`, and
/// `save-restore-diverged` when they differ). Nothing without such a load.
pub(crate) fn cells_rebuilt<W>(game: &Game<W>, state: &mut State, sim: &Sim<W>, seed: u32, tick: u64) {
    if !std::mem::take(&mut state.awaiting_cells) {
        return;
    }
    if let Some(driver) = state.driver.as_mut() {
        driver.restored(Ok(checksum_of(game, sim, seed, tick)));
    }
}

/// Rebuild the slot's game beside the running one and swap it in: the recomputed state checksum,
/// or why it was refused with nothing replaced.
fn restore_into<W>(game: &Game<W>, envelope: Envelope, running: Running<'_, W>) -> Result<u64, SaveError> {
    let seed = u32::try_from(envelope.seed).map_err(|_| SaveError::corrupt(format!("seed {} is not a u32", envelope.seed)))?;
    let fresh = game.save_sections.fresh.ok_or_else(|| SaveError::new(SaveErrorCode::NotConfigured, "no game.saves"))?;
    let mut sim = crate::runtime::fresh_sim(fresh(), game);
    let gfx = running.gfx;
    // As a seed does: the reset hooks ask for their assets and extensions again.
    gfx.assets().clear();
    gfx.clear_extensions();
    let mut rng = Pcg32::seeded(u64::from(seed));
    gfx.assets().set_at_reset(true);
    for hook in &game.resets {
        hook(&mut sim, seed, &mut rng, gfx);
    }
    gfx.assets().set_at_reset(false);
    restore_sections(game, &mut sim, &envelope.sections, gfx)?;
    let checksum = checksum_of(game, &sim, seed, envelope.tick);
    *running.sim = sim;
    *running.seed = seed;
    *running.tick = envelope.tick;
    running.rng.set(Pcg32::from_parts(envelope.rng));
    Ok(checksum)
}

/// The built-in sections, then the game's in registration order, onto the fresh `sim`.
fn restore_sections<W>(game: &Game<W>, sim: &mut Sim<W>, sections: &Map<String, Value>, gfx: &Gfx) -> Result<(), SaveError> {
    if game.nav_config().is_some() {
        let snapshot = CoreValue::from(section(sections, NAV_SECTION)?);
        sim.nav.restore(&snapshot).map_err(|error| SaveError::section_invalid(format!("{NAV_SECTION}: {error}")))?;
    }
    if game.stream_registration().is_some() {
        let snapshot = section(sections, STREAM_SECTION)?;
        sim.stream.restore(snapshot).map_err(|error| SaveError::section_invalid(format!("{STREAM_SECTION}: {}", error.detail)))?;
    }
    for entry in &game.save_sections.list {
        let value = section(sections, &entry.name)?;
        (entry.load)(sim, value, gfx).map_err(|detail| SaveError::section_invalid(format!("{}: {detail}", entry.name)))?;
    }
    Ok(())
}

fn section<'a>(sections: &'a Map<String, Value>, name: &str) -> Result<&'a Value, SaveError> {
    sections.get(name).ok_or_else(|| SaveError::new(SaveErrorCode::SectionMissing, format!("the slot has no section {name}")))
}

/// What a save reads at the end of a tick.
pub(crate) struct SaveView<'a, W> {
    /// The simulation after the tick.
    pub(crate) sim: &'a Sim<W>,
    /// The seed it was reset on.
    pub(crate) seed: u32,
    /// The tick the simulation is at now (the one the slot holds).
    pub(crate) tick: u64,
    /// The tick rng.
    pub(crate) rng: &'a Cell<Pcg32>,
    /// Where the slots are written.
    pub(crate) gfx: &'a Gfx,
}

/// At the end of a tick: run the deletes and saves it asked for, then a due autosave.
pub(crate) fn end_of_tick<W>(game: &Game<W>, state: &mut State, view: &SaveView<'_, W>) {
    let Some(config) = game.g6.saves.configs.first() else { return };
    state.ensure(config, save_name(game), view.gfx.saves());
    let Some(driver) = state.driver.as_mut() else { return };
    driver.end_tick(&mut Store(view.gfx.saves()), view.tick, &mut || snapshot(game, view));
}

/// Between ticks, as the app is suspended or closed: write the autosave ring's oldest slot now
/// (UIS-12), read hooks only, so it is safe out of the tick. None without `game.saves`, without an
/// autosave ring, or with `autosave_on_suspend(false)`.
pub(crate) fn suspend_save<W>(game: &Game<W>, state: &mut State, view: &SaveView<'_, W>) -> Option<Result<SlotInfo, SaveError>> {
    let config = game.g6.saves.configs.first()?;
    state.ensure(config, save_name(game), view.gfx.saves());
    let driver = state.driver.as_mut()?;
    driver.suspend_save(&mut Store(view.gfx.saves()), &mut || snapshot(game, view))
}

/// The running game as a slot reads it: read hooks only, so the checksum never moves.
fn snapshot<W>(game: &Game<W>, view: &SaveView<'_, W>) -> Result<Snapshot, SaveError> {
    let mut sections = Map::new();
    if game.nav_config().is_some() {
        sections.insert(NAV_SECTION.to_owned(), Value::from(&view.sim.nav.snapshot()));
    }
    if game.stream_registration().is_some() {
        sections.insert(STREAM_SECTION.to_owned(), view.sim.stream.snapshot());
    }
    for entry in &game.save_sections.list {
        let value = (entry.save)(view.sim).map_err(|detail| SaveError::section_invalid(format!("{}: {detail}", entry.name)))?;
        sections.insert(entry.name.clone(), value);
    }
    Ok(Snapshot {
        tick: view.tick,
        seed: u64::from(view.seed),
        rng: view.rng.get().parts(),
        state_checksum: checksum_of(game, view.sim, view.seed, view.tick),
        play_ms: view.tick.saturating_mul(1000) / TICKS_PER_SECOND,
        saved_at_ms: saved_at_ms(),
        locale: SAVE_LOCALE.to_owned(),
        build: env!("CARGO_PKG_VERSION").to_owned(),
        sections,
    })
}

/// `Runtime::checksum` of `sim` at (`seed`, `tick`), as a number.
fn checksum_of<W>(game: &Game<W>, sim: &Sim<W>, seed: u32, tick: u64) -> u64 {
    let probes = game.probes.iter().filter(|probe| !probe.volatile);
    let leaves: Map<String, Value> = probes.map(|probe| (probe.name.clone(), (probe.hook)(sim))).collect();
    let hex = session::checksum(seed, tick, &CoreValue::from(&Value::Object(leaves)));
    u64::from_str_radix(&hex, 16).unwrap_or_default()
}

/// The most bytes of JSON one envelope a host call carries (a `write`) or answers (a `read`):
/// `NATIVE_SAVES_ENVELOPE_MAX_BYTES` in `shared/game-saves.ts` (a 1 MiB line, less room for its
/// own members).
pub const HOST_ENVELOPE_MAX_BYTES: usize = 1024 * 1024 - 4 * 1024;

/// One Studio `saves` call (UIS-16, the dev flavour's `saves` verb), its argument already checked
/// by genex-studio: what the host asks of the game's slots between ticks.
#[derive(Clone, Debug, PartialEq)]
pub enum HostSavesCall {
    /// `{slots, bytes, quota}`.
    List,
    /// One slot's envelope as stored (its canonical document), or `{tooLarge, bytes, digest}`
    /// past [`HOST_ENVELOPE_MAX_BYTES`].
    Read(String),
    /// Seed a named slot with an envelope document (JSON bytes): refused with its code, and
    /// nothing written, unless it decodes as a save of this game that its migrations take.
    Write(String, Vec<u8>),
    /// Save the running game into a named slot now, with a label.
    Save(String, String),
    /// Load a slot now: answered once applied, `{tick, checksum, checksumMatch}`.
    Load(String),
    /// Delete a slot now.
    Delete(String),
}

/// What a host call did: its answer, and whether a load replaced the running game (the runtime
/// then starts the HUD, streaming and the journal over, as after a tick's restore).
pub(crate) struct HostAnswer {
    pub(crate) value: Value,
    pub(crate) restored: bool,
}

fn not_configured() -> SaveError {
    SaveError::new(SaveErrorCode::NotConfigured, "the game registers no game.saves")
}

/// Serve a Studio `saves` call between ticks (UIS-16): the same driver, store and checks as
/// `ctx.slots()`, run at once instead of at the tick's end (a save, a delete) or the next tick's
/// start (a load).
pub(crate) fn host_call<W>(game: &Game<W>, state: &mut State, running: Running<'_, W>, call: HostSavesCall) -> Result<HostAnswer, SaveError> {
    let config = game.g6.saves.configs.first().ok_or_else(not_configured)?;
    let saves = running.gfx.saves().clone();
    state.ensure(config, save_name(game), &saves);
    let driver = state.driver.as_mut().ok_or_else(not_configured)?;
    driver.refresh(&Store(&saves));
    let plain = |value: Value| Ok(HostAnswer { value, restored: false });
    match call {
        HostSavesCall::List => {
            let slots: Vec<Value> = driver.list().iter().map(slot_value).collect();
            plain(json!({ "slots": slots, "bytes": saves.bytes_used(), "quota": MAX_TOTAL_SAVE_BYTES }))
        }
        HostSavesCall::Read(slot) => plain(read_envelope(driver, &saves, &slot)?),
        HostSavesCall::Write(slot, document) => {
            let info = write_envelope(game, config, driver, &saves, &slot, document)?;
            plain(slot_value(&info))
        }
        HostSavesCall::Save(slot, label) => {
            driver.request_save(&slot, &label)?;
            let info = run_queued(game, driver, &saves, &running, &slot)?;
            plain(slot_value(&info))
        }
        HostSavesCall::Delete(slot) => {
            driver.request_delete(&slot)?;
            run_queued(game, driver, &saves, &running, &slot)?;
            plain(json!({ "deleted": slot }))
        }
        HostSavesCall::Load(slot) => {
            driver.request_load(&slot)?;
            load_now(game, state, running, &slot)
        }
    }
}

/// A slot's stored envelope, decoded and checked, as its canonical document.
fn read_envelope(driver: &SlotDriver, saves: &Saves, slot: &str) -> Result<Value, SaveError> {
    let slot = SlotName::lookup(slot)?;
    if driver.get(slot.as_str()).is_none() {
        return Err(SaveError::new(SaveErrorCode::SlotMissing, format!("no slot {slot}")));
    }
    let body = saves.load(&slot.body_file()).ok_or_else(|| SaveError::new(SaveErrorCode::SlotMissing, format!("{slot}'s body is gone")))?;
    decode(&body)?;
    let document = genex_save::codec::unpack(&body)?;
    if document.len() > HOST_ENVELOPE_MAX_BYTES {
        let digest = genex_core::digest::hex64(genex_core::digest::fnv1a64(&document));
        return Ok(json!({ "tooLarge": true, "bytes": document.len(), "digest": digest }));
    }
    serde_json::from_slice(&document).map_err(|error| SaveError::corrupt(format!("not JSON: {error}")))
}

/// Seed a named slot with `document` once it decodes as a save of this game that the schema's
/// migrations take: the body, then its sidecar; refused with its code, nothing written, otherwise.
fn write_envelope<W>(game: &Game<W>, config: &SaveConfig, driver: &mut SlotDriver, saves: &Saves, slot: &str, document: Vec<u8>) -> Result<SlotInfo, SaveError> {
    let slot = SlotName::new(slot)?;
    if document.len() > HOST_ENVELOPE_MAX_BYTES {
        return Err(SaveError::new(SaveErrorCode::TooLarge, format!("{} bytes of envelope (max {HOST_ENVELOPE_MAX_BYTES})", document.len())));
    }
    let body = genex_save::codec::pack(document)?;
    let envelope = decode(&body)?;
    if envelope.game != save_name(game) {
        return Err(SaveError::corrupt(format!("the envelope was saved by {:?}", envelope.game)));
    }
    let meta = genex_save::index::SlotMeta::for_body(&slot, &envelope, &body);
    config.migrations().migrate(envelope)?;
    let mut store = Store(saves);
    store.write(&slot.body_file(), &body)?;
    if let Err(error) = store.write(&slot.meta_file(), &meta.to_bytes()) {
        store.remove(&slot.body_file());
        return Err(error);
    }
    driver.refresh(&store);
    driver.get(slot.as_str()).cloned().ok_or_else(|| SaveError::corrupt(format!("{slot} was written and is not listed")))
}

/// Run the save or delete just queued now, as a tick's end would (the running game read through
/// read hooks only), and answer the slot as listed after it, or why it refused.
fn run_queued<W>(game: &Game<W>, driver: &mut SlotDriver, saves: &Saves, running: &Running<'_, W>, slot: &str) -> Result<SlotInfo, SaveError> {
    let view = SaveView { sim: &*running.sim, seed: *running.seed, tick: *running.tick, rng: running.rng, gfx: running.gfx };
    driver.end_tick(&mut Store(saves), view.tick, &mut || snapshot(game, &view));
    // The event is published at the next tick's start; begin it now (nothing is pending).
    let Step::Run = driver.begin_tick(&mut Store(saves), 0) else { return Err(SaveError::new(SaveErrorCode::Busy, "a load is pending")) };
    let event = driver.events().iter().rev().find(|event| event.slot.as_str() == slot);
    let result = event.map(|event| event.result.clone());
    result.unwrap_or_else(|| Err(SaveError::new(SaveErrorCode::Busy, format!("{slot} was not written"))))
}

/// Restore the load just queued now: the slot's game swapped in, answered `{tick, checksum,
/// checksumMatch}`, or the load's refusal with the running game untouched.
fn load_now<W>(game: &Game<W>, state: &mut State, running: Running<'_, W>, slot: &str) -> Result<HostAnswer, SaveError> {
    let saves = running.gfx.saves().clone();
    if let Some(driver) = state.driver.as_mut() {
        // A tick's end turns the queued load into the pending one; nothing else is queued.
        let view = SaveView { sim: &*running.sim, seed: *running.seed, tick: *running.tick, rng: running.rng, gfx: running.gfx };
        driver.end_tick(&mut Store(&saves), view.tick, &mut || snapshot(game, &view));
    }
    let Running { sim, seed, tick, rng, gfx } = running;
    let swap = swap_in(game, state, Running { sim: &mut *sim, seed: &mut *seed, tick: &mut *tick, rng, gfx });
    let driver = state.driver.as_ref().ok_or_else(not_configured)?;
    if swap != Swap::Restored {
        let refused = driver.events().iter().rev().find(|event| event.op == SlotOp::Load && event.slot.as_str() == slot);
        let error = refused.and_then(|event| event.result.clone().err());
        return Err(error.unwrap_or_else(|| SaveError::new(SaveErrorCode::LoadTimeout, format!("{slot}'s body did not arrive"))));
    }
    Ok(HostAnswer { value: load_answer(game, state, sim, *seed, *tick), restored: true })
}

/// A host load's answer, `{tick, checksum, checksumMatch}`: `checksumMatch` is null while a
/// streamed world's cells are still building (its self-check then runs at the next tick).
pub(crate) fn load_answer<W>(game: &Game<W>, state: &State, sim: &Sim<W>, seed: u32, tick: u64) -> Value {
    let checksum = genex_core::digest::hex64(checksum_of(game, sim, seed, tick));
    let last = state.driver.as_ref().and_then(SlotDriver::last_load);
    let checksum_match = if state.awaiting_cells { Value::Null } else { Value::Bool(last.is_some_and(|last| last.checksum_match)) };
    json!({ "tick": tick, "checksum": checksum, "checksumMatch": checksum_match })
}
