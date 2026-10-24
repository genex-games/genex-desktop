//! The headless reference runtime: registration checks, seed, fixed-tick stepping, the input
//! merge, read-only views (state, probes, frames, cameras) and demos, with no window or GPU.
//!
//! The platform shells and the verb transport (`studio.rs`, behind `genex::install`) drive a game
//! through this type. Every rule a C++ game shares runs on genex-core's golden-checked port: the
//! clock ([`FrameClock`], `step_ticks`), the rng (PCG32), the input merge (keys, pointer, pads,
//! text, touches), the `state()` snapshot and its checksum (genex-core's JSON writer, so a probe's
//! `1e-7` dumps as the C++ `1e-07` and equal leaves hash equal on both stacks), and saves. The UI
//! hooks run inside the tick on genex-hud's [`Hud`] (one egui pass per tick, input from the merged
//! tick input and the simulated clock): it records the widgets for `state().hud.items` and keeps
//! what they drew for the presenter, which paints it into the world target before a capture or a
//! Live frame reads it.
//!
//! The runtime also owns the game's render settings ([`crate::render::RenderControl`]): the
//! presenter draws through them, and the UI hooks reach them through
//! [`crate::render::settings_panel`]. The person's choice there is saved per device after the tick
//! and never enters the simulation, so it never moves the checksum.

use crate::camera::Camera;
use crate::ctx::{Ctx, CtxRng, Key};
use crate::frame::Frame;
use crate::game::{Game, Single};
use crate::gfx::{AssetSource, Gfx};
use crate::actions::{InputError, InputErrorCode, InputTrack, TrackAnchor};
use crate::input::{Input, Merger, TickInput};
use crate::map::Set;
use crate::present::{AssetIssue, TextureFact};
use crate::rng::Pcg32;
use crate::sim::{FacetState, Sim};
use genex_core::clock::FrameClock;
use genex_core::json::Value as CoreValue;
use genex_core::paths::{self, ANDROID_DATA_KEY, Destination, GameIdentity};
use genex_core::protocol::{MAX_WORLD_PX, MIN_WORLD_PX};
use genex_core::saves::Saves;
use genex_core::session::{self, SessionView, StateExtras};
use genex_hud::{Hud, HudInput, HudPaint};
use serde_json::{Map as JsonMap, Value};
use crate::render::{DeviceFacts, RenderControl, RenderHandle, ScoreLevel};
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::collections::VecDeque;
use std::fmt;

/// One simulation tick, in milliseconds (genex-core's).
pub const FIXED_STEP_MS: f64 = genex_core::clock::FIXED_STEP_MS;
const FIXED_STEP_SECONDS: f32 = 1.0 / 60.0;
/// The most ticks one `step(ms)` runs: ten minutes of simulation (genex-core's).
pub const MAX_STEP_TICKS: u32 = genex_core::clock::MAX_STEP_TICKS;
/// The seed a game starts on before anyone calls `seed` (genex-core's).
pub const DEFAULT_SEED: u32 = session::DEFAULT_SEED;
/// The longest probe, camera, eye or demo name, in characters.
const MAX_NAME_CHARS: usize = 64;
/// The camera name that gives the view back to the game.
const DEFAULT_CAMERA: &str = "default";
/// `state().__render`'s list of the models drawn as the missing-asset checker.
const MISSING_MODELS_KEY: &str = "missingModels";
/// `state().__render`'s models drawn whole because a level-of-detail option was refused (LOD-07).
const LOD_REFUSED_KEY: &str = "lodRefused";
/// `state().__render`'s textures the last frame bound, by path (C-11).
const TEXTURES_KEY: &str = "textures";
/// `state().__render`'s asset issues of the last frame (C-11).
const ASSET_ISSUES_KEY: &str = "assetIssues";
/// `state().volatile`'s streaming counters, while streaming is registered (STR-9): the runtime
/// key's name, so no volatile probe can take it.
const STREAM_VOLATILE_KEY: &str = "__stream";
/// The game's name and bundle id as the build lane names them (`GENEX_GAME_NAME`,
/// `GENEX_BUNDLE_ID` at compile time, as the C++ lane's `-D` defines); an exported app saves
/// under them unless the game set its own `save_name`.
const BUILD_IDENTITY: GameIdentity<'static> = GameIdentity {
    name: match option_env!("GENEX_GAME_NAME") {
        Some(name) => name,
        None => "",
    },
    bundle_id: match option_env!("GENEX_BUNDLE_ID") {
        Some(id) => id,
        None => "",
    },
};

/// The format tag of [`Runtime::input_snapshot`].
const INPUT_SNAPSHOT_FORMAT: &str = "genex-input-snapshot/1";

/// The keys `state()` owns; a probe may never use one as its name.
pub const RUNTIME_KEYS: [&str; 20] = [
    "version",
    "contractVersion",
    "seed",
    "frame",
    "simulatedMs",
    "running",
    "fps",
    "held",
    "pointerLock",
    "hud",
    "camera",
    "error",
    "player",
    "volatile",
    "__render",
    // Display only, and only while streaming is registered: never in the checksum.
    "__stream",
    // Display only, and only while `game.input` is registered: never in the checksum.
    "__input",
    // Display only, and only while the build links networking or `game.net` is registered (MP-4a).
    "__net",
    "assets",
    "checksum",
];

/// The ticks `step(ms)` runs: `max(1, round(ms / FIXED_STEP_MS))`, capped at [`MAX_STEP_TICKS`];
/// NaN and negative spans run one tick (genex-core's `step_ticks`).
pub fn step_ticks(ms: f64) -> u32 {
    genex_core::clock::step_ticks(ms, FIXED_STEP_MS)
}

/// Why `install` refused a game.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum InstallErrorCode {
    /// A second `camera` without `.camera_override()`.
    DuplicateCamera,
    /// A second `player` without `.player_override()`.
    DuplicatePlayer,
    /// Two probes (volatile or not) share a name.
    DuplicateProbe,
    /// A probe uses a key `state()` owns.
    ReservedProbe,
    /// Two named cameras share a name.
    DuplicateCameraName,
    /// Two eyes share a name.
    DuplicateEye,
    /// Two demos share a name.
    DuplicateDemo,
    /// An empty, overlong, control-character or reserved name.
    InvalidName,
    /// `facet_state::<T>()` registered twice for one `T`.
    DuplicateFacetState,
    /// A world size side outside `64..=4096` (genex-core's `MIN_WORLD_PX..=MAX_WORLD_PX`).
    InvalidWorldSize,
    /// A second `game.streaming`.
    DuplicateStreaming,
    /// A streaming registration outside its caps: a cell size outside
    /// `STREAM_CELL_SIZE_MIN..=STREAM_CELL_SIZE_MAX`, radii or an anchor count past theirs, or a
    /// sim set past `STREAM_SIM_BYTES_MAX` at the cell caps.
    StreamingInvalid,
    /// A second `game.input`.
    DuplicateInput,
    /// An action map genex-input refuses (an id, a binding, a cap), or touch controls outside the
    /// world, past their caps or bound to no action.
    InputInvalid,
    /// A second `game.touch_controls`.
    DuplicateTouchControls,
    /// A second `game.audio`.
    DuplicateAudio,
    /// More than `REVERB_ZONES_MAX` (16) reverb zones in `game.audio`.
    AudioZoneLimit,
    /// A save schema of 0, a migration chain with a gap or a step at or above the schema, an
    /// autosave ring or slot cap outside its range, or more game sections than a slot holds.
    SaveSchemaInvalid,
    /// A save section named `genex.*` (the runtime's built-in sections).
    SaveSectionReserved,
    /// Two save sections share a name (`game.save_world` is the section `world`).
    DuplicateSaveSection,
    /// A second `game.saves`.
    DuplicateSaves,
    /// A second `game.ui`.
    DuplicateUi,
    /// A `game.ui` locale that is not BCP-47, or a font named for a locale it does not list.
    UiLocaleInvalid,
    /// A second `game.net`.
    DuplicateNet,
    /// A `game.net` config outside its caps: a publish rate outside `1..=NET_PUBLISH_HZ_MAX`,
    /// more than 6 decimals, or a smoothing delay outside `1..=30` ticks.
    NetConfigInvalid,
    /// A second `game.settings`, a game option off the Game tab or with a reserved prefix, or a
    /// preset that does not fit its tab's options.
    SettingsInvalid,
    /// `game.navigation` or `game.nav_bake` in a game built with `[nav] enabled = false` (release
    /// R-1): the build links no navigation.
    NavDisabled,
    /// `game.streaming` in a game built with `[streaming] enabled = false` (release R-1): the build
    /// links no streaming.
    StreamingDisabled,
}

impl InstallErrorCode {
    /// Every code, in declaration order.
    pub const ALL: [InstallErrorCode; 28] = [
        InstallErrorCode::DuplicateCamera,
        InstallErrorCode::DuplicatePlayer,
        InstallErrorCode::DuplicateProbe,
        InstallErrorCode::ReservedProbe,
        InstallErrorCode::DuplicateCameraName,
        InstallErrorCode::DuplicateEye,
        InstallErrorCode::DuplicateDemo,
        InstallErrorCode::InvalidName,
        InstallErrorCode::DuplicateFacetState,
        InstallErrorCode::InvalidWorldSize,
        InstallErrorCode::DuplicateStreaming,
        InstallErrorCode::StreamingInvalid,
        InstallErrorCode::DuplicateInput,
        InstallErrorCode::InputInvalid,
        InstallErrorCode::DuplicateTouchControls,
        InstallErrorCode::DuplicateAudio,
        InstallErrorCode::AudioZoneLimit,
        InstallErrorCode::SaveSchemaInvalid,
        InstallErrorCode::SaveSectionReserved,
        InstallErrorCode::DuplicateSaveSection,
        InstallErrorCode::DuplicateSaves,
        InstallErrorCode::DuplicateUi,
        InstallErrorCode::UiLocaleInvalid,
        InstallErrorCode::DuplicateNet,
        InstallErrorCode::NetConfigInvalid,
        InstallErrorCode::SettingsInvalid,
        InstallErrorCode::NavDisabled,
        InstallErrorCode::StreamingDisabled,
    ];

    /// The typed code's wire spelling.
    pub const fn as_str(self) -> &'static str {
        match self {
            InstallErrorCode::DuplicateCamera => "duplicate-camera",
            InstallErrorCode::DuplicatePlayer => "duplicate-player",
            InstallErrorCode::DuplicateProbe => "duplicate-probe",
            InstallErrorCode::ReservedProbe => "reserved-probe",
            InstallErrorCode::DuplicateCameraName => "duplicate-camera-name",
            InstallErrorCode::DuplicateEye => "duplicate-eye",
            InstallErrorCode::DuplicateDemo => "duplicate-demo",
            InstallErrorCode::InvalidName => "invalid-name",
            InstallErrorCode::DuplicateFacetState => "duplicate-facet-state",
            InstallErrorCode::InvalidWorldSize => "invalid-world-size",
            InstallErrorCode::DuplicateStreaming => "duplicate-streaming",
            InstallErrorCode::StreamingInvalid => "streaming-invalid",
            InstallErrorCode::DuplicateInput => "duplicate-input",
            InstallErrorCode::InputInvalid => "input-invalid",
            InstallErrorCode::DuplicateTouchControls => "duplicate-touch-controls",
            InstallErrorCode::DuplicateAudio => "duplicate-audio",
            InstallErrorCode::AudioZoneLimit => "audio-zone-limit",
            InstallErrorCode::SaveSchemaInvalid => "save-schema-invalid",
            InstallErrorCode::SaveSectionReserved => "save-section-reserved",
            InstallErrorCode::DuplicateSaveSection => "duplicate-save-section",
            InstallErrorCode::DuplicateSaves => "duplicate-saves",
            InstallErrorCode::DuplicateUi => "duplicate-ui",
            InstallErrorCode::UiLocaleInvalid => "ui-locale-invalid",
            InstallErrorCode::DuplicateNet => "duplicate-net",
            InstallErrorCode::NetConfigInvalid => "net-config-invalid",
            InstallErrorCode::SettingsInvalid => "settings-invalid",
            InstallErrorCode::NavDisabled => "nav-disabled",
            InstallErrorCode::StreamingDisabled => "streaming-disabled",
        }
    }
}

/// A refused registration: the typed code and what it is about.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InstallError {
    code: InstallErrorCode,
    detail: String,
}

impl InstallError {
    fn new(code: InstallErrorCode, detail: impl Into<String>) -> InstallError {
        InstallError { code, detail: detail.into() }
    }

    /// The typed code.
    pub fn code(&self) -> InstallErrorCode {
        self.code
    }
}

impl fmt::Display for InstallError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.detail)
    }
}

impl std::error::Error for InstallError {}

/// A demo, camera or eye name the game does not have, with the ones it does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnknownName {
    /// The names that exist.
    pub available: Vec<String>,
}

impl fmt::Display for UnknownName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "unknown name; available: {}", self.available.join(", "))
    }
}

impl std::error::Error for UnknownName {}

/// Which camera a frame is drawn from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum View<'a> {
    /// The game's own camera (or [`Camera::DEFAULT`]).
    Game,
    /// A named observer camera; `"default"` is the game's own.
    Named(&'a str),
    /// A player eye.
    Eye(&'a str),
}

/// What a step did.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StepResult {
    /// Ticks run.
    pub ticks: u32,
    /// The tick count after the step (`state().frame`).
    pub frame: u64,
    /// Simulated time after the step, in milliseconds.
    pub simulated_ms: f64,
}

/// What the last drawn frame counted (`state().__render`): logical tagged draws, and the
/// triangles a renderer reported for them.
#[derive(Clone, Debug, Default, PartialEq)]
struct Tally {
    draw_calls: u32,
    triangles: u32,
    /// Per tag, in first-draw order: draws and triangles.
    tags: Vec<(String, u32, u32)>,
    /// Models the renderer drew as the missing-asset checker, in first-draw order.
    missing_models: Vec<String>,
    /// The textures the renderer bound, one per path in first-bound order (C-11).
    textures: Vec<TextureFact>,
    /// What those textures tell an agent to fix (C-11).
    asset_issues: Vec<AssetIssue>,
    /// Models drawn whole because a level-of-detail option was refused (LOD-07).
    lod_refused: Vec<crate::present::LodRefused>,
}

/// The simulation and clock state the hooks run against.
struct Core<W> {
    sim: Sim<W>,
    seed: u32,
    tick: u64,
    running: bool,
    rng: Cell<Pcg32>,
    merger: Merger,
    pointer_lock: bool,
    gfx: Gfx,
    hud: Hud,
    clock: FrameClock,
    tally: Tally,
    /// The render settings (display state: nothing the checksum reads).
    render: crate::render::RenderHandle,
    /// The G6 areas' runtime state (UIS-0): every hook a no-op until its area lands.
    g6: crate::g6::G6,
    /// The streaming engine (STR-9): builds in flight and the hold counters; idle without
    /// `game.streaming`.
    stream: crate::stream_tick::StreamTick,
    /// Recorded tick rows a replay runs instead of the merger's (IN-12).
    rows: VecDeque<genex_core::input::TickInput>,
}

/// A game behind its registrations: what platform shells and the verb transport drive.
pub struct Runtime<W> {
    game: Game<W>,
    core: Core<W>,
}

/// What a demo drives the simulation through. Only demos get one, so `advance` is unreachable
/// from update, UI and draw hooks.
pub struct DemoDriver<'a, W> {
    game: &'a Game<W>,
    core: &'a mut Core<W>,
}

impl<W> DemoDriver<'_, W> {
    /// The simulation, read-only.
    pub fn sim(&self) -> &Sim<W> {
        &self.core.sim
    }

    /// The simulation, for a demo that sets up state directly.
    pub fn sim_mut(&mut self) -> &mut Sim<W> {
        &mut self.core.sim
    }

    /// Inject input exactly as the `input` verb does; answers the keys now held.
    pub fn inject(&mut self, input: Input) -> Vec<String> {
        self.core.merger.inject(input)
    }

    /// Save `bytes` as `file` in the game's save folder, as `ctx.save` does.
    pub fn save(&self, file: &str, bytes: &[u8]) -> bool {
        self.core.gfx.saves().save(file, bytes)
    }

    /// Run the simulation `ms` forward exactly as `step(ms)` does.
    pub fn advance_ms(&mut self, ms: u32) -> StepResult {
        step(self.game, self.core, f64::from(ms))
    }

    /// Scripted remote players for the loopback room (MP-4a): joins, states, messages, claims,
    /// latency, reconnects and closes, deterministic from the seed and the script. Outside the
    /// loopback room every call does nothing and is counted in `__net.scriptIgnored`.
    pub fn net(&mut self) -> crate::net::NetScript<'_> {
        self.core.g6.net.script()
    }
}

impl<W: Default> DemoDriver<'_, W> {
    /// Replay a recorded input track exactly as `Runtime::replay` does (IN-12).
    pub fn replay(&mut self, track: &InputTrack) -> Result<StepResult, InputError> {
        replay(self.game, self.core, track)
    }
}

impl<W: Default + 'static> Runtime<W> {
    /// Check the registrations and seed [`DEFAULT_SEED`], with no assets to read (a test's or a
    /// tool's runtime): every [`crate::Assets::bytes`] answers `missing`.
    pub fn new(game: Game<W>) -> Result<Runtime<W>, InstallError> {
        Runtime::with_assets(game, Box::new(crate::gfx::NO_ASSETS))
    }

    /// Check the registrations, attach the asset `source` the reset hooks read through
    /// (`gfx.assets().bytes`, `.triangles`), then seed [`DEFAULT_SEED`]: the first reset already
    /// reads, on every shell.
    pub fn with_assets(mut game: Game<W>, source: Box<dyn AssetSource>) -> Result<Runtime<W>, InstallError> {
        validate(&game)?;
        let world = std::mem::take(&mut game.initial);
        let saves = saves_of(game.save_name.as_deref());
        // RC-09: a Vulkan device keeps its pipeline cache with the game's saves.
        genex_render::compile::keep_pipeline_caches_in(Some(saves.clone()));
        let core = Core {
            sim: fresh_sim(world, &game),
            seed: DEFAULT_SEED,
            tick: 0,
            running: false,
            rng: Cell::new(Pcg32::seeded(u64::from(DEFAULT_SEED))),
            merger: Merger::default(),
            pointer_lock: false,
            gfx: Gfx::new(game.world_size, saves, game.wgsl.clone(), source),
            hud: Hud::new(),
            clock: FrameClock::default(),
            tally: Tally::default(),
            render: Rc::new(RefCell::new(RenderControl::new(game.render.clone(), (game.world_size[0], game.world_size[1])))),
            g6: crate::g6::G6::default(),
            stream: crate::stream_tick::StreamTick::new(game.stream_registration(), &game.cell_contents),
            rows: VecDeque::new(),
        };
        let mut runtime = Runtime { game, core };
        // The player's bindings are read once, before the first seed (IN-11).
        runtime.core.g6.input.install(&runtime.game.g6.input, runtime.core.gfx.saves(), studio_run());
        runtime.core.g6.input.set_touch(runtime.game.g6.touch.layout());
        // And the person's UI layer (locale), which a Genex run ignores (UIS-10).
        runtime.core.g6.ui.rebase(&runtime.game.g6.ui, runtime.core.gfx.saves(), studio_run());
        // Then the settings menu's (UIS-11), which routes the person's volumes and UI layer.
        runtime.core.g6.settings_rebase(&runtime.game.g6, runtime.core.gfx.saves(), studio_run());
        // The net backend the build links; a run Studio serves is always the loopback room (MP-4a).
        runtime.core.g6.net = crate::net::State::install(&runtime.game.g6.net, studio_run());
        runtime.seed(DEFAULT_SEED);
        Ok(runtime)
    }

    /// Rebuild the simulation on `seed` from defaults, run the reset hooks in order, pause and
    /// clear held and pending input.
    pub fn seed(&mut self, seed: u32) {
        seed_core(&self.game, &mut self.core, seed);
    }

    /// Render with `class`'s physical voice pool (a shell, at boot): the run is re-seeded on its
    /// seed so the sounds are handed to the new pool. It never changes the logical state.
    #[doc(hidden)]
    pub fn set_audio_pool(&mut self, class: crate::audio::PoolClass) {
        self.core.g6.audio.set_class(class);
        self.seed(self.core.seed);
    }

    /// Run streamed cell builds on `pool` instead of the process pool (tests and tools comparing
    /// thread counts; `Pool::inline()` is the web's). Builds in flight are dropped.
    #[doc(hidden)]
    pub fn use_stream_pool(&mut self, pool: std::sync::Arc<genex_render::jobs::Pool>) {
        self.core.stream.use_pool(pool);
        self.core.stream.prefetch(&self.core.sim);
    }

    /// Measure streaming holds with `clock` (milliseconds) instead of the process clock (tests).
    #[doc(hidden)]
    pub fn use_stream_clock(&mut self, clock: Box<dyn FnMut() -> f64>) {
        self.core.stream.use_clock(clock);
    }

    /// Replay a recorded input track (IN-12): the track's bindings come into force, a track from
    /// the seed seeds its seed first (one from a snapshot needs the input and the world restored
    /// at its first tick), then each recorded row runs one tick in place of the merger's input.
    /// The same (seed, bindings, rows) give the same checksum on every tick. Refuses
    /// `input-track-mismatch` for another contract, world size or bindings, or without
    /// `game.input`.
    #[doc(hidden)]
    pub fn replay(&mut self, track: &InputTrack) -> Result<StepResult, InputError> {
        replay(&self.game, &mut self.core, track)
    }
}

impl<W> Runtime<W> {
    /// Resume live play; answers `running`. The live clock starts from a whole tick, as the C++
    /// `Session::start` does.
    pub fn start(&mut self) -> bool {
        self.core.running = true;
        self.core.clock.reset();
        true
    }

    /// Freeze live play; answers `running` (false).
    pub fn pause(&mut self) -> bool {
        self.core.running = false;
        false
    }

    /// Whether live play is running.
    pub fn running(&self) -> bool {
        self.core.running
    }

    /// Whether a streaming commit has been held past `STREAM_HOLD_OVERLAY_MS`: what a shell's
    /// loading look over the last frame would read (no shell paints one yet). Display only.
    pub fn stream_loading(&self) -> bool {
        self.core.stream.loading()
    }

    /// The cells the simulation streams around its anchors now (active, entering at the next
    /// commit, and the prefetch ring), ascending: what a shell that fetches a pack's cell bodies and
    /// terrain tiles while playing asks for (the web's). Empty without `game.streaming`. Display and
    /// scheduling only: it never changes the simulation.
    pub fn streamed_cells(&self) -> Vec<genex_core::cell::CellId> {
        self.core.sim.stream.around()
    }

    /// What the presenter's streamed view set reads (STR-16): the registration, the cell builders
    /// and the seed; None without `game.streaming`.
    pub(crate) fn stream_view(&self) -> Option<crate::present_stream::ViewInputs> {
        let streaming = self.game.stream_registration()?;
        Some(crate::present_stream::ViewInputs::new(streaming, &self.game.cell_contents, self.core.seed))
    }

    /// Run [`step_ticks`]`(ms)` ticks, running or not. A streaming commit held past
    /// `STREAM_HOLD_MAX_MS` in total ends the step early (`ticks` says how many ran).
    pub fn step(&mut self, ms: f64) -> StepResult {
        step(&self.game, &mut self.core, ms)
    }

    /// Live play: run the whole ticks one rendered frame of `frame_ms` is worth (none while
    /// paused), carrying the remainder on genex-core's [`FrameClock`]; a frame counts at most
    /// 250 ms, which is 15 ticks.
    pub fn advance_live(&mut self, frame_ms: f64) -> u32 {
        // Every shell frame moves the net along, paused or not, so a seat stays alive; what it
        // brings lands in the next tick's frame (MP-4a).
        self.core.g6.net.pump();
        if !self.core.running {
            return 0;
        }
        let due = self.core.clock.advance(frame_ms);
        // A held commit waits a slice of the frame; the ticks it could not run are dropped, so a
        // hold slows Live down instead of bursting after it.
        let mut hold = crate::stream_tick::HoldBudget::live();
        (0..due).take_while(|_| tick(&self.game, &mut self.core, &mut hold)).count() as u32
    }

    /// Inject input for the next tick; answers the keys now held.
    pub fn inject(&mut self, input: Input) -> Vec<String> {
        self.core.merger.inject(input)
    }

    /// Real input a platform shell sampled for the frame about to run (genex-core's merge: edges
    /// on the frame's first tick, look only while the pointer is locked, echoes of injected look
    /// dropped). A Studio run samples none: it reads only the host's `input` op.
    pub fn sample_input(&mut self, sample: &genex_core::input::FrameSample) {
        self.core.merger.sample(sample);
    }

    /// Held keys, canonical and sorted.
    pub fn held(&self) -> Vec<String> {
        self.core.merger.held()
    }

    /// The game's render settings (shared with the presenter that draws it).
    pub fn render(&self) -> RenderHandle {
        Rc::clone(&self.core.render)
    }

    /// Probe the render settings with the device's `facts`: this device's saved choice and its
    /// cached calibration hint are read from the saves (`calibration`, a fresh measurement, wins
    /// and is saved). Answers the hint in use.
    pub fn boot_render(&mut self, facts: DeviceFacts, calibration: Option<ScoreLevel>) -> Option<ScoreLevel> {
        let mut control = self.core.render.borrow_mut();
        control.probe(facts.clone(), None);
        let cached = control.load_saved(self.core.gfx.saves());
        let level = calibration.or(cached);
        control.probe(facts, level);
        if let Some(fresh) = calibration.filter(|fresh| Some(*fresh) != cached) {
            control.remember_calibration(fresh);
            control.save(self.core.gfx.saves());
        }
        level
    }

    /// The game's save folder.
    pub fn saves(&self) -> &Saves {
        self.core.gfx.saves()
    }

    /// Rebase the saves onto an Android activity's internal data folder (`internal_data_path`),
    /// which no process variable carries: the Android shell calls this before the first tick. A
    /// folder that is not absolute leaves the game with no save root, never one the environment
    /// names.
    pub fn use_android_data(&mut self, internal_data_path: &str) {
        let env = |name: &str| (name == ANDROID_DATA_KEY).then(|| internal_data_path.to_owned());
        let game = paths::identity_of(self.game.save_name.as_deref().unwrap_or(""), "", BUILD_IDENTITY);
        self.core.gfx.set_saves(Saves::for_destination(Destination::Android, &env, game));
        self.core.g6.input.rebase(&self.game.g6.input, self.core.gfx.saves(), studio_run());
        self.core.g6.ui.rebase(&self.game.g6.ui, self.core.gfx.saves(), studio_run());
        self.core.g6.settings_rebase(&self.game.g6, self.core.gfx.saves(), studio_run());
        let tick = self.core.tick;
        restart_journal(&self.game, &mut self.core, tick);
    }

    /// Rebase the saves onto a Studio run's `state/` folder (`state_dir`, absolute, ending in its
    /// separator) and read the player's bindings from there, as a run the studio started would
    /// (key labels ignored). For tests and tools that stand in for a Genex run.
    #[doc(hidden)]
    pub fn use_studio_saves(&mut self, state_dir: &str) {
        let env = |name: &str| (name == paths::STATE_DIR_ENV).then(|| state_dir.to_owned());
        let game = paths::identity_of(self.game.save_name.as_deref().unwrap_or(""), "", BUILD_IDENTITY);
        self.core.gfx.set_saves(Saves::for_destination(Destination::GenexRun, &env, game));
        self.core.g6.input.rebase(&self.game.g6.input, self.core.gfx.saves(), true);
        self.core.g6.ui.rebase(&self.game.g6.ui, self.core.gfx.saves(), true);
        self.core.g6.settings_rebase(&self.game.g6, self.core.gfx.saves(), true);
        let tick = self.core.tick;
        restart_journal(&self.game, &mut self.core, tick);
    }

    /// Serve a Studio `saves` call between ticks (UIS-16, the dev flavour's `saves` verb): list,
    /// read, write, save, load or delete a slot at once, through the same driver as `ctx.slots()`.
    /// A load answers once applied, and the HUD, streaming and the journal start over as after a
    /// tick's restore. Refused with the slot code (`save-not-configured` without `game.saves`).
    #[doc(hidden)]
    pub fn host_saves(&mut self, call: crate::saves::HostSavesCall) -> Result<serde_json::Value, crate::saves::SaveError> {
        let core = &mut self.core;
        let running = crate::saves::Running {
            sim: &mut core.sim,
            seed: &mut core.seed,
            tick: &mut core.tick,
            rng: &core.rng,
            gfx: &core.gfx,
            input: &mut core.g6.input,
        };
        let answer = crate::saves::host_call(&self.game, &mut core.g6.saves, running, call)?;
        if !answer.restored {
            return Ok(answer.value);
        }
        restored(&self.game, core);
        // A streamed world answers once its cells are rebuilt and checked (null while they build).
        if crate::saves::awaiting_cells(&core.g6.saves) {
            rebuild_loaded_cells(&self.game, core, &mut crate::stream_tick::HoldBudget::step());
            return Ok(crate::saves::load_answer(&self.game, &core.g6.saves, &core.sim, core.seed, core.tick));
        }
        Ok(answer.value)
    }

    /// The app is being suspended or closed (a phone's background, a desktop window's close, a web
    /// page hidden): write the autosave ring's oldest slot now, between ticks, through read hooks
    /// only (UIS-12). None when the game registers no autosave ring or turned
    /// `autosave_on_suspend` off; on the web the shell flushes the mirror next.
    #[doc(hidden)]
    pub fn suspend_save(&mut self) -> Option<Result<crate::saves::SlotInfo, crate::saves::SaveError>> {
        let core = &mut self.core;
        let view =
            crate::saves::SaveView { sim: &core.sim, seed: core.seed, tick: core.tick, rng: &core.rng, gfx: &core.gfx, input: &core.g6.input };
        crate::saves::suspend_save(&self.game, &mut core.g6.saves, &view)
    }

    /// The nav bakes the game registered (`game.nav_bake`), in registration order: what a dev
    /// build's receipt advertises for `bakeAssets` (NAV-14).
    #[doc(hidden)]
    pub fn nav_bakes(&self) -> Vec<String> {
        self.game.nav_bakes.names()
    }

    /// Run the nav bake `name` (`bakeAssets {kind: nav, name}`, NAV-14): its input built as a reset
    /// builds one and baked with `game.navigation`'s config, as `.navmesh` bytes. None for a name
    /// the game did not register; refused as `NavMesh::bake` refuses, or `nav-config-invalid`
    /// without `game.navigation`. Display and build glue: the simulation is untouched.
    #[doc(hidden)]
    pub fn bake_nav(&mut self, name: &str) -> Option<Result<Vec<u8>, crate::nav::NavError>> {
        crate::nav_bake::bake(&self.game, &self.core.gfx, name)
    }

    /// The impostor atlases the game registered (`game.impostor_bake`, LOD-23): each model's bake
    /// name at every class row, with the model and the row, in registration order. The hooks run
    /// as a reset runs them (asset reads allowed); the simulation is untouched.
    #[doc(hidden)]
    pub fn impostor_bakes(&self) -> Vec<(String, crate::Model, genex_render::impostor::ImpostorClass)> {
        crate::lod::impostor_bakes(&self.game.impostor_bakes, &self.core.gfx)
    }

    /// Rebase the saves onto the web's in-memory mirror (`genex_core::saves::mirror`), as a web
    /// page's are: for tests and tools that stand in for one off wasm32.
    #[doc(hidden)]
    pub fn use_web_saves(&mut self) {
        let game = paths::identity_of(self.game.save_name.as_deref().unwrap_or(""), "", BUILD_IDENTITY);
        self.core.gfx.set_saves(Saves::for_destination(Destination::Web, &|_| None, game));
    }

    /// Time a load's hold for a lazy body on `clock` (milliseconds) instead of the process clock
    /// (tests of `save-load-timeout`).
    #[doc(hidden)]
    pub fn use_saves_clock(&mut self, clock: Box<dyn FnMut() -> u64>) {
        self.core.g6.saves.use_clock(clock);
    }

    /// The simulation, read-only.
    pub fn sim(&self) -> &Sim<W> {
        &self.core.sim
    }

    /// The simulation, mutably (for shells and tests; game code never gets this).
    pub fn sim_mut(&mut self) -> &mut Sim<W> {
        &mut self.core.sim
    }

    /// The frame recorder a shell starts and closes frames on (`state().volatile.profile`, the
    /// dev `profile` verb): host glue, never in the checksum (PROF-5).
    #[doc(hidden)]
    pub fn profiling(&mut self) -> &mut crate::profile::State {
        &mut self.core.g6.profile
    }

    /// The current seed.
    pub fn seed_value(&self) -> u32 {
        self.core.seed
    }

    /// Ticks since the last seed.
    pub fn tick(&self) -> u64 {
        self.core.tick
    }

    /// The game's title.
    pub fn title(&self) -> &str {
        &self.game.title
    }

    /// The fixed world target size, in pixels.
    pub fn world_size(&self) -> [u32; 2] {
        self.game.world_size
    }

    /// How the world fills a window of another aspect ([`Game::fit`](crate::Game::fit)).
    pub fn fit(&self) -> crate::Fit {
        self.game.fit
    }

    /// The save folder name the game chose, if any.
    pub fn save_name(&self) -> Option<&str> {
        self.game.save_name.as_deref()
    }

    /// The game's probe leaves except the volatile ones, in registration order.
    pub fn probes(&self) -> JsonMap<String, Value> {
        self.probe_leaves(false)
    }

    /// FNV-1a 64 (hex) of the seed, the tick and the non-volatile probes, dumped by genex-core's
    /// port of the C++ JSON writer (`session::checksum`): equal leaves hash equal on both stacks.
    pub fn checksum(&self) -> String {
        session::checksum(self.core.seed, self.core.tick, &self.core_probes())
    }

    /// The `state()` verb's answer: runtime keys first, then the probes. The runtime keys are
    /// genex-core's snapshot; the game's probe leaves stay exactly as its hooks returned them.
    pub fn state(&self) -> Value {
        let mut state = Value::from(&self.state_value(DEFAULT_CAMERA, 0.0));
        let Some(object) = state.as_object_mut() else { return state };
        object.extend(self.probes());
        if let Some(volatile) = object.get_mut(session::VOLATILE_KEY).and_then(Value::as_object_mut) {
            volatile.extend(self.probe_leaves(true));
        }
        state
    }

    /// The characters the game made in its resets (`gfx.character`), whose rigs imported: the
    /// presenter skins them at the boot, so the renderer compiles every skinned variant before a
    /// frame draws one (game systems R-20, EP-X1).
    pub(crate) fn character_paths(&self) -> Vec<String> {
        self.core.gfx.assets().character_paths()
    }

    /// `state()` as genex-core's snapshot (`session::snapshot_view`): `camera` the active view,
    /// `fps` the shell's live rate, the volatile probes under `volatile` beside `fps`.
    pub fn state_value(&self, camera: &str, fps: f64) -> CoreValue {
        let core = &self.core;
        let held = core.merger.held();
        let view = SessionView {
            seed: core.seed,
            tick: core.tick,
            simulated_ms: simulated_ms(core.tick),
            running: core.running,
            held: &held,
            pointer_lock: core.pointer_lock,
        };
        let player = self.game.players.last().map_or(Value::Null, |p| (p.hook)(&core.sim));
        let assets: Vec<CoreValue> = core.gfx.assets().requested().into_iter().map(CoreValue::from).collect();
        let extras = StateExtras {
            fps,
            camera: camera.to_owned(),
            probes: self.core_probes(),
            hud: self.hud_value(),
            render: self.render_value(),
            assets: CoreValue::Array(assets),
            error: String::new(),
            player: CoreValue::from(&player),
        };
        let mut state = session::snapshot_view(&view, &extras);
        let mut volatile = state["volatile"].clone();
        if let Some(rows) = core.gfx.extension_rows() {
            volatile.set(crate::extend::VOLATILE_EXTENSIONS_KEY, CoreValue::from(&rows));
        }
        for (name, value) in self.probe_leaves(true) {
            volatile.set(name, CoreValue::from(&value));
        }
        state.set(session::VOLATILE_KEY, volatile);
        if self.game.stream_registration().is_some() {
            let active = core.sim.stream.active().collect();
            state.set(crate::stream::RUNTIME_KEY, crate::stream::runtime_value(&active));
            let mut volatile = state[session::VOLATILE_KEY].clone();
            volatile.set(STREAM_VOLATILE_KEY, core.stream.volatile_value());
            state.set(session::VOLATILE_KEY, volatile);
        }
        core.g6.runtime_keys(&self.game.g6, &mut state);
        if let Some(audio) = core.g6.audio.volatile_value() {
            let mut volatile = state[session::VOLATILE_KEY].clone();
            volatile.set(crate::audio::VOLATILE_AUDIO_KEY, audio);
            state.set(session::VOLATILE_KEY, volatile);
        }
        if let Some(ui) = core.g6.ui.volatile_value(&self.game.g6.ui) {
            let mut volatile = state[session::VOLATILE_KEY].clone();
            volatile.set(crate::ui::VOLATILE_UI_KEY, ui);
            state.set(session::VOLATILE_KEY, volatile);
        }
        if core.g6.input.registered() {
            let mut input = state[crate::actions::RUNTIME_KEY].clone();
            input.set("journal", CoreValue::from(&core.g6.journal.runtime_value()));
            let device = core.g6.input.ctx().device();
            if let Some(touch) = core.g6.touch.runtime_value(&self.game.g6.touch, device) {
                input.set("touchControls", CoreValue::from(&touch));
            }
            state.set(crate::actions::RUNTIME_KEY, input);
        }
        state
    }

    /// `state().hud`: `{items, crosshair, flash, widgets, focus}`: the widgets the last tick's UI
    /// drew by label, then each with its role, key, rect and focus (UIS-10), and the focused one's
    /// key (else its label, else null).
    fn hud_value(&self) -> CoreValue {
        let summary = self.core.hud.summary();
        let items: Vec<CoreValue> = summary.items.into_iter().map(CoreValue::from).collect();
        let mut hud = CoreValue::object();
        hud.set("items", CoreValue::Array(items));
        hud.set("crosshair", CoreValue::Bool(summary.crosshair));
        hud.set("flash", CoreValue::from(f64::from(summary.flash)));
        let widgets = self.core.hud.widgets();
        hud.set("widgets", CoreValue::Array(widgets.iter().map(widget_value).collect()));
        let focused = widgets.iter().find(|widget| widget.focused);
        let focus = focused.map(|widget| widget.key.as_deref().unwrap_or(&widget.label));
        hud.set("focus", focus.map_or(CoreValue::Null, CoreValue::from));
        hud
    }

    /// What the HUD paints over the next drawn frame, tessellated at `pixels_per_point` device
    /// pixels per world pixel (1 for the world target a capture reads). Display only: no later
    /// tick sees it.
    pub fn hud_paint(&mut self, pixels_per_point: f32) -> HudPaint {
        self.core.hud.paint(pixels_per_point)
    }

    /// The widgets the last tick's UI drew, with their world-pixel rects (where a play script or
    /// a test aims an injected click). Display state: nothing the checksum reads.
    pub fn hud_widgets(&self) -> Vec<genex_hud::HudWidget> {
        self.core.hud.widgets().to_vec()
    }

    /// Whether the HUD wants a soft keyboard: a text field had egui's focus after the last tick.
    /// A phone shell raises its keyboard while this holds. Display only: it moves no checksum.
    pub fn keyboard_wanted(&self) -> bool {
        genex_hud::keyboard_wanted(self.core.hud.context())
    }

    /// Queue a Studio session's UI layer (`uiSettings`: locale, scale, safe area, reduced
    /// motion), applied at the next tick boundary and kept across seeds (UIS-10). Refused
    /// `bad-argument` without `game.ui` or out of range, `text-locale-unknown` for a locale the
    /// game does not offer.
    pub fn ui_session(&mut self, session: crate::ui::UiSession) -> Result<(), crate::ui::UiSessionCode> {
        self.core.g6.ui.queue_session(&self.game.g6.ui, session)
    }

    /// The OS locale a shell read (`sys-locale`), below the person's choice; a Genex run ignores
    /// it (UIS-10).
    pub fn set_os_locale(&mut self, tag: Option<&str>) {
        self.core.g6.ui.set_os_locale(&self.game.g6.ui, tag);
    }

    /// The safe area a phone shell reports, `[left, top, right, bottom]` in world pixels, for
    /// `genex::ui::safe_area`; a Genex run ignores it (UIS-10).
    pub fn set_ui_safe_area(&mut self, insets: [f32; 4]) {
        self.core.g6.ui.set_shell_safe_area(insets);
    }

    /// The output's logical size, which picks `UiScale::Auto`'s phone or desktop scale in an
    /// export (UIS-10).
    pub fn set_ui_output_size(&mut self, size: [f32; 2]) {
        self.core.g6.ui.set_output(genex_ui::settings::scale::OutputClass::of(size));
    }

    /// Replace where `game.ui`'s navigation buttons come from (the INPUT seam, UIS-10): by
    /// default `genex::ui::default_buttons`.
    #[doc(hidden)]
    pub fn set_ui_nav_source(&mut self, source: crate::ui::UiNavSource) {
        self.core.g6.ui.set_nav_source(source);
    }

    /// The input journal since the seed or the last input restore (IN-12): host glue for crash
    /// records and replays. Empty without `game.input`.
    #[doc(hidden)]
    pub fn journal(&self) -> crate::actions::InputJournalView<'_> {
        self.core.g6.journal.view()
    }

    /// The keyboard layout's labels by DOM code (a shell's layout map): they change prompts and
    /// `state().__input.hints` only, never what an action reads or a checksum. Ignored in a Studio
    /// run, so judged runs read the same prompts.
    #[doc(hidden)]
    pub fn set_key_labels(&mut self, labels: &crate::Map<String, String>) {
        let pairs = labels.iter().map(|(code, label)| (code.as_str(), label.as_str()));
        self.core.g6.input.set_labels(genex_input::glyph::KeyLabels::from_pairs(pairs));
    }

    /// The input state between ticks (a save's `input` section, IN-12): every action's latches,
    /// values and condition memory, the contexts, the pad family and the fingers on touch
    /// controls. `Value::Null` without `game.input`.
    #[doc(hidden)]
    pub fn input_snapshot(&self) -> Value {
        let input = &self.core.g6.input;
        if !input.registered() {
            return Value::Null;
        }
        serde_json::json!({
            "format": INPUT_SNAPSHOT_FORMAT,
            "tick": self.core.tick,
            "actions": input.action_state().snapshot(),
            "family": input.family().as_str(),
            "touch": self.core.g6.touch.snapshot(),
        })
    }

    /// Put back an [`Runtime::input_snapshot`] of the same action map and touch layout, all or
    /// nothing, and journal from here (a snapshot-anchored track). The world, the tick and the
    /// rest of a save are the caller's (the saves area restores them).
    #[doc(hidden)]
    pub fn input_restore(&mut self, snapshot: &Value) -> Result<(), InputError> {
        let invalid = |detail: &str| InputError::new(InputErrorCode::TrackInvalid, format!("input snapshot: {detail}"));
        let core = &mut self.core;
        if !core.g6.input.registered() {
            return Err(InputError::new(InputErrorCode::TrackMismatch, "the game has no game.input"));
        }
        if snapshot["format"].as_str() != Some(INPUT_SNAPSHOT_FORMAT) {
            return Err(invalid("not a genex-input-snapshot/1 snapshot"));
        }
        let actions = genex_input::state::ActionState::restore(core.g6.input.map(), &snapshot["actions"])?;
        let family = snapshot["family"].as_str().and_then(crate::actions::PadFamily::from_wire).ok_or_else(|| invalid("an unknown pad family"))?;
        let touch = &snapshot["touch"];
        if !touch.is_null() {
            core.g6.touch.restore(&self.game.g6.touch, touch)?;
        }
        core.g6.input.restore(actions, family);
        core.g6.journal.anchor(core.tick);
        Ok(())
    }

    /// The last frame's tally as `__render`: `{drawCalls, triangles, tags: {tag: {drawCalls,
    /// triangles}}, exact: false}` (`studio.cpp` `tallyJson`), plus `missingModels` (the model
    /// paths drawn as the magenta checker), `textures` (`{path: {kind, family}}`) and
    /// `assetIssues` (`[{path, code}]`), each only when there are some.
    /// The queue a shell's audio device drains (`genex_audio::AudioOutput::open`): once asked
    /// for, every tick's rendered block is pushed to it. Only a run a person sees asks.
    #[doc(hidden)]
    pub fn audio_output(&mut self) -> crate::audio::SinkQueue {
        self.core.g6.audio.output()
    }

    /// The pool class audio renders with.
    #[doc(hidden)]
    pub fn audio_pool(&self) -> crate::audio::PoolClass {
        self.core.g6.audio.class()
    }

    /// Run the net on a fresh `mode` backend from the next tick on, `sim.net` back to no frame
    /// (tests: a loopback room without the `net-loopback` feature; MP-4a).
    #[doc(hidden)]
    pub fn set_net_mode(&mut self, mode: crate::net::NetMode) {
        self.core.g6.net = crate::net::State::with_mode(mode, &self.game.g6.net.config());
        self.core.sim.net = self.core.g6.net.fresh(&self.game.g6.net);
    }

    /// Run the net on `backend` from the next tick on, `sim.net` back to no frame (tests: a
    /// recorded session, a counting stand-in).
    #[doc(hidden)]
    pub fn set_net_backend(&mut self, backend: Box<dyn genex_net::backend::NetBackend>) {
        self.core.g6.net.set_backend(backend);
        self.core.sim.net = self.core.g6.net.fresh(&self.game.g6.net);
    }

    /// Which backend the net runs on.
    #[doc(hidden)]
    pub fn net_mode(&self) -> crate::net::NetMode {
        self.core.g6.net.mode()
    }

    /// How many times the net was pumped (every `advance_live`, paused or not).
    #[doc(hidden)]
    pub fn net_pumps(&self) -> u64 {
        self.core.g6.net.pumps()
    }

    /// `audio({muted})` and a phone's audio gate: silence the device output; the mix, the meter
    /// and the simulation go on.
    #[doc(hidden)]
    pub fn set_output_muted(&mut self, muted: bool) {
        self.core.g6.audio.set_muted(muted);
    }

    /// Whether the device output is muted.
    #[doc(hidden)]
    pub fn output_muted(&self) -> bool {
        self.core.g6.audio.muted()
    }

    /// `audioLevel`: the level of the last 2048 frames mixed, before the mute; silence for a game
    /// that uses no audio.
    #[doc(hidden)]
    pub fn audio_level(&self) -> crate::audio::AudioLevel {
        self.core.g6.audio.level()
    }

    /// The person's volumes (the settings menu's Audio tab), outside the simulation.
    #[doc(hidden)]
    pub fn set_audio_settings(&mut self, settings: crate::audio::AudioSettings) {
        self.core.g6.audio.set_settings(settings);
    }

    /// The person's volumes.
    #[doc(hidden)]
    pub fn audio_settings(&self) -> crate::audio::AudioSettings {
        self.core.g6.audio.settings()
    }

    /// What a shell's audio device reported (`volatile.audio.device`): open, and its last fault.
    #[doc(hidden)]
    pub fn note_audio_device(&mut self, open: bool, fault: Option<crate::audio::DeviceFault>) {
        self.core.g6.audio.note_device(open, fault);
    }

    /// genex-audio's logical-state hash (0 for a game that uses no audio): the same for the same
    /// seed, input and ticks on every destination and pool class. Display only, never checksummed.
    #[doc(hidden)]
    pub fn audio_logical_hash(&self) -> u64 {
        self.core.g6.audio.logical_hash()
    }

    fn render_value(&self) -> CoreValue {
        let tally = &self.core.tally;
        let mut tags = CoreValue::object();
        for (tag, draws, triangles) in &tally.tags {
            let mut entry = CoreValue::object();
            entry.set("drawCalls", CoreValue::from(*draws));
            entry.set("triangles", CoreValue::from(*triangles));
            tags.set(tag.as_str(), entry);
        }
        let mut render = CoreValue::object();
        render.set("drawCalls", CoreValue::from(tally.draw_calls));
        render.set("triangles", CoreValue::from(tally.triangles));
        render.set("tags", tags);
        render.set("exact", CoreValue::Bool(false));
        if !tally.missing_models.is_empty() {
            let missing = tally.missing_models.iter().map(|path| CoreValue::from(path.as_str())).collect();
            render.set(MISSING_MODELS_KEY, CoreValue::Array(missing));
        }
        if !tally.lod_refused.is_empty() {
            let refused = tally.lod_refused.iter().map(|refused| {
                let mut entry = CoreValue::object();
                entry.set("model", CoreValue::from(refused.model.as_str()));
                entry.set("code", CoreValue::from(refused.code.wire()));
                entry
            });
            render.set(LOD_REFUSED_KEY, CoreValue::Array(refused.collect()));
        }
        if !tally.textures.is_empty() {
            let mut textures = CoreValue::object();
            for fact in &tally.textures {
                let mut entry = CoreValue::object();
                entry.set("kind", CoreValue::from(fact.usage()));
                entry.set("family", CoreValue::from(fact.origin.wire()));
                textures.set(fact.path.as_str(), entry);
            }
            render.set(TEXTURES_KEY, textures);
        }
        let issue = |path: &str, code: &str| {
            let mut entry = CoreValue::object();
            entry.set("path", CoreValue::from(path));
            entry.set("code", CoreValue::from(code));
            entry
        };
        let mut issues: Vec<CoreValue> = tally.asset_issues.iter().map(|asset| issue(&asset.path, asset.code.wire())).collect();
        // game.ui's text files (UIS-10): a missing file, a key a locale lacks, a broken entry.
        issues.extend(self.core.g6.ui.file_issues().iter().map(|(path, code)| issue(path, code)));
        if !issues.is_empty() {
            render.set(ASSET_ISSUES_KEY, CoreValue::Array(issues));
        }
        render
    }

    /// The renderer's triangle count for the frame last drawn: the total and per tag.
    pub fn note_triangles(&mut self, total: u32, by_tag: &[(String, u32)]) {
        let tally = &mut self.core.tally;
        tally.triangles = total;
        for (tag, _, triangles) in &mut tally.tags {
            *triangles = by_tag.iter().find(|(name, _)| name == tag).map_or(0, |(_, count)| *count);
        }
    }

    /// The models the renderer drew as the missing-asset checker in the frame last drawn (not in
    /// the game's assets, or refused): `state().__render.missingModels`, absent when empty.
    pub fn note_missing_models(&mut self, paths: &[String]) {
        self.core.tally.missing_models = paths.to_vec();
    }

    /// The models the frame last drawn drew whole because a level-of-detail option was refused
    /// (LOD-07): `state().__render.lodRefused` (`[{model, code}]`), absent when empty.
    pub fn note_lod_refused(&mut self, refused: &[crate::present::LodRefused]) {
        self.core.tally.lod_refused = refused.to_vec();
    }

    /// The textures the renderer bound in the frame last drawn and the issues they raise (C-11):
    /// `state().__render.textures` and `.assetIssues`, each absent when empty. Display only.
    pub fn note_texture_facts(&mut self, textures: &[TextureFact], issues: &[AssetIssue]) {
        self.core.tally.textures = textures.to_vec();
        self.core.tally.asset_issues = issues.to_vec();
    }

    fn core_probes(&self) -> CoreValue {
        CoreValue::from(&Value::Object(self.probes()))
    }

    /// The camera a view resolves to, or `None` for an unknown name.
    pub fn camera(&self, view: View<'_>) -> Option<Camera> {
        let sim = &self.core.sim;
        match view {
            View::Game => Some(self.game.cameras.last().map_or(Camera::DEFAULT, |c| (c.hook)(sim))),
            View::Named(DEFAULT_CAMERA) => self.camera(View::Game),
            View::Named(name) => self.game.named_cameras.iter().find(|c| c.name == name).map(|c| (c.hook)(sim)),
            View::Eye(name) => self.game.eyes.iter().find(|c| c.name == name).map(|c| (c.hook)(sim)),
        }
    }

    /// Run the draw hooks from a view's camera and record the frame's tally for `state()`;
    /// `None` for an unknown camera name.
    pub fn frame(&mut self, view: View<'_>) -> Option<Frame> {
        let camera = self.camera(view)?;
        let mut frame = Frame::new(self.game.background);
        for hook in &self.game.draws {
            hook(&self.core.sim, &mut frame, &camera);
        }
        let mut tags = frame.tags().iter().map(|(tag, count)| (tag.clone(), *count, 0)).collect();
        // Each custom GPU pass is one logical draw of every frame (M2.19).
        let custom = crate::gpu::tally(&self.game.gpu_passes, &mut tags);
        let draw_calls = frame.draw_calls() + custom;
        self.core.tally = Tally { draw_calls, triangles: 0, tags, ..Tally::default() };
        Some(frame)
    }

    /// The custom GPU passes, the simulation they read and the tick the frame shows (M2.19: what
    /// `genex::gpu`'s host glue binds for the renderer).
    pub(crate) fn gpu_pass_parts(&mut self) -> (&mut [crate::gpu::GpuPassEntry<W>], &Sim<W>, u64) {
        (&mut self.game.gpu_passes, &self.core.sim, self.core.tick)
    }

    /// Named observer cameras, in registration order.
    pub fn cameras(&self) -> Vec<String> {
        self.game.named_cameras.iter().map(|c| c.name.clone()).collect()
    }

    /// Player eyes, in registration order.
    pub fn eyes(&self) -> Vec<String> {
        self.game.eyes.iter().map(|c| c.name.clone()).collect()
    }

    /// Demo names, in registration order.
    pub fn demos(&self) -> Vec<String> {
        self.game.demos.iter().map(|d| d.name.clone()).collect()
    }

    /// Run a demo; the runtime is paused after it.
    pub fn demo(&mut self, name: &str) -> Result<Value, UnknownName> {
        let Some(demo) = self.game.demos.iter().find(|d| d.name == name) else {
            return Err(UnknownName { available: self.demos() });
        };
        let mut driver = DemoDriver { game: &self.game, core: &mut self.core };
        let result = (demo.hook)(&mut driver);
        self.core.running = false;
        Ok(result)
    }

    fn probe_leaves(&self, volatile: bool) -> JsonMap<String, Value> {
        let probes = self.game.probes.iter().filter(|p| p.volatile == volatile);
        probes.map(|p| (p.name.clone(), (p.hook)(&self.core.sim))).collect()
    }
}

/// Hand an installed game to the platform shell: the studio's verbs when the studio started it
/// (descriptor 3 and a nonce, the dev flavour's `studio` feature), else on a desktop the winit
/// shell (a window, or headless by `--headless` / `GENEX_HEADLESS=1`). A web build's `genex` is
/// genex-platform-web, whose own `install` hands the game to the page, and the phones' shells
/// call their own; built for those without them, the facade draws one frame and returns.
#[cfg_attr(
    any(target_os = "macos", target_os = "windows", target_os = "linux"),
    allow(unused_mut, reason = "only the shells without a run loop here draw the frame themselves")
)]
pub(crate) fn run<W: Default + 'static>(mut runtime: Runtime<W>, assets: crate::AssetTable) {
    #[cfg(all(feature = "studio", not(target_arch = "wasm32")))]
    if let Some(code) = crate::studio::serve(&mut runtime, assets) {
        std::process::exit(code);
    }
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    crate::desktop::run(runtime, assets);
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        let _ = assets;
        let _ = runtime.frame(View::Game);
    }
}

/// `genex::install_with_assets`: check the game, attach this destination's asset source (the
/// compiled `assets` first, then natively `assets/` beside the executable by real path) before the
/// first seed, then hand the runtime to the platform shell.
pub(crate) fn install<W: Default + 'static>(game: Game<W>, assets: crate::AssetTable) {
    let runtime = Runtime::with_assets(game, native_source(assets)).unwrap_or_else(|error| panic!("genex::install: {error}"));
    run(runtime, assets);
}

/// The sim's asset source on this destination: the compiled table, then the asset folder.
#[cfg(not(target_arch = "wasm32"))]
fn native_source(assets: crate::AssetTable) -> Box<dyn AssetSource> {
    Box::new(crate::present_files::AssetFiles::for_process(assets))
}

/// A wasm32 build without the web shell reads its compiled table only.
#[cfg(target_arch = "wasm32")]
fn native_source(assets: crate::AssetTable) -> Box<dyn AssetSource> {
    Box::new(assets)
}

/// The saves of this process: the run's `state/` under the studio, else the destination's root
/// for the game's `save_name` or the build's identity.
fn saves_of(save_name: Option<&str>) -> Saves {
    Saves::for_process(save_name.unwrap_or(""), "", BUILD_IDENTITY)
}

/// `Runtime::replay` and `DemoDriver::replay` on the game's state.
fn replay<W: Default>(game: &Game<W>, core: &mut Core<W>, track: &InputTrack) -> Result<StepResult, InputError> {
    let mismatch = |detail: &str| InputError::new(InputErrorCode::TrackMismatch, detail.to_owned());
    let Some(defaults) = game.g6.input.map() else { return Err(mismatch("the game has no game.input")) };
    let header = track.header();
    if header.contract != session::CONTRACT_VERSION || header.world != game.world_size {
        return Err(mismatch("the track was recorded for another contract or world size"));
    }
    let mut map = defaults.clone();
    if !header.bindings.is_empty() {
        map.apply_blob(&header.bindings)?;
    }
    if map.digest() != header.bindings_digest {
        return Err(mismatch("the track's bindings do not match its digest"));
    }
    let anchored_here = track.anchor() == TrackAnchor::Snapshot && track.start_tick() == core.tick;
    if track.anchor() == TrackAnchor::Snapshot && !anchored_here {
        return Err(mismatch("a snapshot track replays from its first tick, after the input and world restore"));
    }
    // The run's bindings for the replay; not the player's file, so nothing is written.
    core.g6.input.set_map(map);
    if track.anchor() == TrackAnchor::Seed {
        seed_core(game, core, header.seed);
    }
    core.rows = track.inputs().map(|(_, row)| row).collect();
    let mut hold = crate::stream_tick::HoldBudget::step();
    let due = core.rows.len();
    let ticks = (0..due).take_while(|_| tick(game, core, &mut hold)).count() as u32;
    core.rows.clear();
    Ok(StepResult { ticks, frame: core.tick, simulated_ms: simulated_ms(core.tick) })
}

/// `seed` on the game's state: defaults, reset hooks in order, paused, input cleared.
fn seed_core<W: Default>(game: &Game<W>, core: &mut Core<W>, seed: u32) {
    core.sim = fresh_sim(W::default(), game);
    core.seed = seed;
    core.tick = 0;
    core.running = false;
    core.clock.reset();
    core.merger = Merger::default();
    core.rows.clear();
    core.pointer_lock = false;
    core.hud.reset();
    core.g6.reset(&game.g6);
    core.sim.net = core.g6.net.fresh(&game.g6.net);
    core.g6.crash.seeded(seed);
    start_journal(game, core);
    core.gfx.assets().clear();
    core.gfx.clear_extensions();
    core.stream.reset(seed);
    let mut rng = Pcg32::seeded(u64::from(seed));
    core.gfx.assets().set_at_reset(true);
    // The UI's text and fonts are boot assets, read in the reset window like the hooks' (UIS-10).
    core.g6.ui.load(&game.g6.ui, core.gfx.assets());
    apply_locale_fonts(core);
    for hook in &game.resets {
        hook(&mut core.sim, seed, &mut rng, &core.gfx);
    }
    core.gfx.assets().set_at_reset(false);
    core.g6.audio.sync(&game.g6.audio, core.gfx.audio_bank());
    core.rng.set(rng);
    // Anchors a reset placed take effect at the first tick's commit: start its builds now.
    core.stream.prefetch(&core.sim);
}

/// With `game.input`, journal the run from tick 0 under the seed and the player's bindings.
fn start_journal<W>(game: &Game<W>, core: &mut Core<W>) {
    restart_journal(game, core, 0);
}

/// Journal from tick `tick` under the bindings in force now (the file stays empty while they are
/// the game's own): from the seed at tick 0, else anchored at `tick`.
fn restart_journal<W>(game: &Game<W>, core: &mut Core<W>, tick: u64) {
    let Some(defaults) = game.g6.input.map() else { return };
    let map = core.g6.input.map();
    let digest = map.digest();
    let bindings = if digest == defaults.digest() { Vec::new() } else { map.to_blob() };
    let header = genex_input::track::TrackHeader {
        seed: core.seed,
        contract: session::CONTRACT_VERSION,
        world: game.world_size,
        bindings_digest: digest,
        bindings,
    };
    core.g6.journal.start(header, tick);
}

/// Whether the studio started this process (a Genex run): its key labels are ignored.
fn studio_run() -> bool {
    paths::destination_of(&paths::process_env) == Destination::GenexRun
}

/// The simulation a seed (or a load, UIS-9) starts from, before the reset hooks.
pub(crate) fn fresh_sim<W>(world: W, game: &Game<W>) -> Sim<W> {
    Sim {
        world,
        physics: fresh_physics(),
        facets: FacetState::fresh(&game.facets),
        nav: crate::nav::fresh(game.nav_config()),
        stream: crate::stream_tick::StreamState::fresh(game.stream_registration()),
        net: crate::net::Net::fresh(crate::net::build_mode(studio_run()), &game.g6.net.config()),
    }
}

/// An empty physics world stepping at the fixed tick.
#[cfg(feature = "physics")]
fn fresh_physics() -> crate::PhysicsWorld {
    let mut physics = crate::PhysicsWorld::default();
    physics.integration_parameters.dt = FIXED_STEP_SECONDS;
    physics
}

/// A game built without physics: its empty stand-in.
#[cfg(not(feature = "physics"))]
fn fresh_physics() -> crate::PhysicsWorld {
    crate::PhysicsWorld
}

fn simulated_ms(tick: u64) -> f64 {
    // Ticks stay far below 2^52, where u64 -> f64 is exact.
    tick as f64 * FIXED_STEP_MS
}

fn step<W>(game: &Game<W>, core: &mut Core<W>, ms: f64) -> StepResult {
    let mut hold = crate::stream_tick::HoldBudget::step();
    let ticks = (0..step_ticks(ms)).take_while(|_| tick(game, core, &mut hold)).count() as u32;
    StepResult { ticks, frame: core.tick, simulated_ms: simulated_ms(core.tick) }
}

/// One fixed tick: the streaming commit slot (STR-9), then update hooks, UI hooks and one physics
/// step. The G6 areas' hooks (UIS-0) run in INPUT's order: merge (a replay's recorded row instead
/// of the merger's), HUD focus gating, touch controls, device tracker and evaluate, journal, then
/// the net cut, the update and UI hooks, physics and the net flush, inside `g6_tick_begin` and
/// `g6_tick_end`. False, with nothing changed, when the commit is held past `hold` waiting on a
/// cell build.
fn tick<W>(game: &Game<W>, core: &mut Core<W>, hold: &mut crate::stream_tick::HoldBudget) -> bool {
    // A load the last tick asked for swaps in first (UIS-9); one whose body is not resident holds.
    let running = crate::saves::Running {
        sim: &mut core.sim,
        seed: &mut core.seed,
        tick: &mut core.tick,
        rng: &core.rng,
        gfx: &core.gfx,
        input: &mut core.g6.input,
    };
    match crate::saves::swap_in(game, &mut core.g6.saves, running) {
        crate::saves::Swap::Hold => return false,
        crate::saves::Swap::Restored => restored(game, core),
        crate::saves::Swap::Run => {}
    }
    // A streamed world's load rebuilds the slot's cells before its self-check and the commit.
    if !rebuild_loaded_cells(game, core, hold) {
        return false;
    }
    // Then, so a held commit leaves the tick untouched: no input consumed, no hook run.
    if core.stream.commit(&mut core.sim, &game.stream_commits, core.gfx.assets(), hold).is_err() {
        return false;
    }
    core.g6.tick_begin(&game.g6, core.tick);
    // A Studio session's UI layer queued since the last tick applies now (UIS-10).
    core.g6.ui.begin_tick(&game.g6.ui);
    apply_locale_fonts(core);
    let input = match core.rows.pop_front() {
        Some(row) => TickInput::from_core(row, game.world_size),
        None => core.merger.next_tick(game.world_size),
    };
    core.pointer_lock = input.pointer_lock;
    // A HUD widget with the keyboard's focus (Tab to a settings switch, a tapped text field) takes
    // the keys from the update hooks and the actions until Escape or a click elsewhere; the HUD
    // itself still gets them below. Mouse buttons (and so touch 0) stay the game's.
    let keys_taken = genex_hud::keys_taken(core.hud.context());
    let taken = keys_taken.then(|| input.keys.mouse_buttons_only());
    let text = if taken.is_some() { "" } else { input.text.as_str() };
    // With game.ui the pad buttons and stick navigation consumes are the focused widget's too.
    let gated_pads = (keys_taken && game.g6.ui.registered()).then(|| crate::ctx::Pads::from_core(core.g6.ui.gated_pads(&input.core.pads)));
    let (touch, free) = core.g6.touch.step(&game.g6.touch, game.world_size, &input);
    core.g6.input.evaluate(&input.core, keys_taken, &touch, free);
    core.g6.journal.record(core.tick, &input.core);
    core.g6.net.cut(&game.g6.net, &mut core.sim.net, core.tick);
    // The HUD runs for UI hooks, and for touch controls (painted, and items a script can aim at).
    let hud_runs = !game.uis.is_empty() || game.g6.touch.layout().is_some();
    let controls = if hud_runs { core.g6.input.enter_panel(&input.core) } else { None };
    let ctx = Ctx {
        keys: taken.as_ref().unwrap_or(&input.keys),
        touches: &input.touches,
        pads: gated_pads.as_ref().unwrap_or(&input.pads),
        pointer: input.pointer,
        look: input.look,
        wheel: input.wheel,
        pointer_lock: input.pointer_lock,
        text,
        rng: CtxRng::new(&core.rng),
        dt: FIXED_STEP_SECONDS,
        tick: core.tick,
        world_size: game.world_size,
        saves: core.gfx.saves(),
        actions: core.g6.input.ctx(),
        audio: core.g6.audio.ctx(),
        slots: core.g6.saves.slots(),
    };
    // `tr` and the person layer reach the update and UI hooks through the UI scope (UIS-10).
    let ui_scope = core.g6.ui.enter(&game.g6.ui);
    // And the person's settings, which the settings menu changes (UIS-11).
    let settings_scope = core.g6.settings.enter();
    for hook in &game.updates {
        hook(&mut core.sim, &ctx);
    }
    if hud_runs {
        let mut hud = hud_input(&input);
        if let Some(navigation) = core.g6.input.hud_navigation() {
            // The `ui` actions are the HUD's navigation keys now; a focused text field keeps the
            // raw keys it edits with.
            if !keys_taken {
                hud.pressed_keys = crate::actions::without_nav_keys(&hud.pressed_keys);
            }
            hud.extra_events = navigation;
        } else if game.g6.ui.registered() {
            // game.ui's navigation source (pads and keys, repeated on ticks) replaces the raw
            // navigation keys; a focused text field keeps them and navigates by pad only.
            let text_field = genex_hud::keyboard_wanted(core.hud.context());
            if !text_field {
                hud.pressed_keys = crate::actions::without_nav_keys(&hud.pressed_keys);
            }
            hud.extra_events = core.g6.ui.navigation(input.core.pads.states(), &input.keys.held, !text_field);
        }
        if game.g6.ui.registered() {
            hud.ui_scale = core.g6.ui.scale(&game.g6.ui);
        }
        let shown = crate::actions_touch::State::shown(&game.g6.touch, ctx.actions.device());
        let (sim, touch) = (&mut core.sim, &core.g6.touch);
        let panel = crate::render::PanelScope::enter(&core.render);
        // The hooks draw inside the safe area plus a margin, at the person's text size (R-25);
        // touch controls keep the whole world.
        let layout = core.g6.ui.hooks_layout(&game.g6.ui);
        core.hud.run(game.world_size, simulated_ms(core.tick) / 1000.0, &hud, |ui| {
            layout.show(ui, |ui| {
                for hook in &game.uis {
                    hook(sim, ui, &ctx);
                }
            });
            if shown {
                touch.paint(&game.g6.touch, game.world_size, ui);
            }
        });
        drop(panel);
        core.g6.ui.note_key_issues(&genex_ui::keyed::ui_issues(core.hud.context()));
        let digest = core.g6.input.map().digest();
        core.g6.input.leave_panel(controls);
        if core.g6.input.map().digest() != digest {
            // The rest of the run evaluates with the new bindings: journal it from the next tick.
            restart_journal(game, core, core.tick + 1);
        }
        // The person's panel choices are kept per device, outside the simulation.
        core.render.borrow_mut().save(core.gfx.saves());
        core.g6.input.save_if_changed(core.gfx.saves());
    }
    core.g6.ui.leave(ui_scope);
    // The menu's changes route outside the Sim (audio buses now, the UI layer from the next tick).
    core.g6.settings_leave(&game.g6, settings_scope, core.gfx.saves());
    core.g6.ui.note_pads(&input.core.pads);
    #[cfg(feature = "physics")]
    core.sim.physics.step();
    core.g6.net.flush(&game.g6.net, &mut core.sim.net, core.tick);
    core.stream.prefetch(&core.sim);
    // Audio after physics (occlusion sees this tick's bodies), with the game's own camera as the
    // ears, before `g6_tick_end` writes a pending save (AU-7).
    let camera = || Some(game.cameras.last().map_or(Camera::DEFAULT, |c| (c.hook)(&core.sim)));
    core.g6.audio.step(camera, &core.sim);
    core.g6.tick_end(&game.g6, core.tick);
    core.tick += 1;
    let view =
        crate::saves::SaveView { sim: &core.sim, seed: core.seed, tick: core.tick, rng: &core.rng, gfx: &core.gfx, input: &core.g6.input };
    crate::saves::end_of_tick(game, &mut core.g6.saves, &view);
    true
}

/// The HUD's fallback fonts for a locale `game.ui` just switched to (UIS-10); a refused font
/// leaves the text fonts and is reported as `text-font-missing`.
fn apply_locale_fonts<W>(core: &mut Core<W>) {
    let Some(fonts) = core.g6.ui.take_fonts() else { return };
    if let Err(refusal) = core.hud.set_locale_fonts(&fonts) {
        core.g6.ui.font_refused(&format!("{refusal:?}"));
    }
}

/// After a load swapped in (UIS-9): the HUD's memory, the streaming engine and the journal start
/// over from the restored tick, as a seed's do.
fn restored<W>(game: &Game<W>, core: &mut Core<W>) {
    core.hud.reset();
    core.stream.reset(core.seed);
    core.stream.prefetch(&core.sim);
    restart_journal(game, core, core.tick);
}

/// After a streamed world's slot load: enter the slot's active cells through the commit hooks
/// (within `hold`), then run the load's checksum self-check. False while their builds are still
/// building (the tick must not run); true otherwise, or without such a load.
fn rebuild_loaded_cells<W>(game: &Game<W>, core: &mut Core<W>, hold: &mut crate::stream_tick::HoldBudget) -> bool {
    if !crate::saves::awaiting_cells(&core.g6.saves) {
        return true;
    }
    match core.stream.rebuild_restored(&mut core.sim, &game.stream_commits, core.gfx.assets(), hold) {
        Err(crate::stream_tick::Held) => false,
        Ok(_) => {
            crate::saves::cells_rebuilt(game, &mut core.g6.saves, &core.sim, core.seed, core.tick);
            true
        }
    }
}

/// One `state().hud.widgets` entry: `{role, label, key, rect, focused}` (key null when unkeyed).
fn widget_value(widget: &genex_hud::HudWidget) -> CoreValue {
    let mut entry = CoreValue::object();
    entry.set("role", CoreValue::from(widget.role.as_str()));
    entry.set("label", CoreValue::from(widget.label.chars().take(genex_hud::MAX_ITEM_NAME).collect::<String>()));
    entry.set("key", widget.key.as_deref().map_or(CoreValue::Null, CoreValue::from));
    entry.set("rect", CoreValue::Array(widget.rect.iter().map(|side| CoreValue::from(f64::from(*side))).collect()));
    entry.set("focused", CoreValue::Bool(widget.focused));
    entry
}

/// What the HUD reads from one tick's merged input: the pointer as a fraction of the world,
/// Mouse1's edges, the wheel, the committed text and the keys pressed on the tick.
fn hud_input(input: &TickInput) -> HudInput {
    let mouse = Key::Mouse1.code();
    HudInput {
        pointer: [input.pointer.x, input.pointer.y],
        primary_pressed: input.keys.pressed_code(mouse),
        primary_released: input.keys.released.iter().any(|k| k == mouse),
        wheel: [input.wheel.x, input.wheel.y],
        text: input.text.clone(),
        pressed_keys: input.keys.pressed.clone(),
        ..HudInput::default()
    }
}

/// `install`'s input checks: one map and one layout, each one genex-input accepts.
fn check_input<W>(game: &Game<W>) -> Result<(), InstallError> {
    let (input, touch) = (&game.g6.input, &game.g6.touch);
    if input.count() > 1 {
        return Err(InstallError::new(InstallErrorCode::DuplicateInput, "game.input is registered once"));
    }
    if touch.count() > 1 {
        return Err(InstallError::new(InstallErrorCode::DuplicateTouchControls, "game.touch_controls is registered once"));
    }
    let refused = |error: InputError| InstallError::new(InstallErrorCode::InputInvalid, error.to_string());
    if let Some(map) = input.map() {
        map.validate().map_err(refused)?;
    }
    if let Some(layout) = touch.layout() {
        layout.validate(game.world_size).map_err(refused)?;
        if let Some(map) = input.map() {
            layout.check_bindings(map).map_err(refused)?;
        }
    }
    Ok(())
}

fn check_audio<W>(game: &Game<W>) -> Result<(), InstallError> {
    let audio = &game.g6.audio;
    if audio.count() > 1 {
        return Err(InstallError::new(InstallErrorCode::DuplicateAudio, "game.audio is registered once"));
    }
    let zones = audio.setup().map_or(0, |setup| setup.zones.len());
    if zones > crate::audio::REVERB_ZONES_MAX {
        let detail = format!("{zones} reverb zones; at most {}", crate::audio::REVERB_ZONES_MAX);
        return Err(InstallError::new(InstallErrorCode::AudioZoneLimit, detail));
    }
    Ok(())
}

fn validate<W>(game: &Game<W>) -> Result<(), InstallError> {
    check_world_size(game.world_size)?;
    check_switches(game)?;
    check_single(&game.cameras, InstallErrorCode::DuplicateCamera, "a second camera needs .camera_override()")?;
    check_single(&game.players, InstallErrorCode::DuplicatePlayer, "a second player needs .player_override()")?;
    check_probes(game)?;
    let cameras = game.named_cameras.iter().map(|c| c.name.as_str());
    check_names(cameras, InstallErrorCode::DuplicateCameraName, &[DEFAULT_CAMERA])?;
    check_names(game.eyes.iter().map(|c| c.name.as_str()), InstallErrorCode::DuplicateEye, &[])?;
    check_names(game.demos.iter().map(|c| c.name.as_str()), InstallErrorCode::DuplicateDemo, &[])?;
    check_streaming(&game.streaming, &game.cell_contents, game.nav_config())?;
    check_input(game)?;
    check_audio(game)?;
    crate::saves::check(game).map_err(|(code, detail)| InstallError::new(code, detail))?;
    crate::nav_bake::check(game).map_err(|(code, detail)| InstallError::new(code, detail))?;
    crate::ui::check(&game.g6.ui).map_err(|(code, detail)| InstallError::new(code, detail))?;
    crate::settings::check(&game.g6).map_err(|(code, detail)| InstallError::new(code, detail))?;
    game.g6.net.check().map_err(|(code, detail)| InstallError::new(code, detail))?;
    let mut facets = Set::default();
    for facet in &game.facets {
        if !facets.insert(facet.type_id) {
            return Err(InstallError::new(InstallErrorCode::DuplicateFacetState, facet.type_name));
        }
    }
    Ok(())
}

/// A registration of a system the game's genex.toml switched off (release R-1): refused, so a
/// switch never silently drops what the game asked for. The detail names the key to turn on.
fn check_switches<W>(game: &Game<W>) -> Result<(), InstallError> {
    let wants_nav = game.navigation.is_some() || !game.nav_bakes.is_empty();
    if wants_nav && !crate::nav::NAV_BUILT {
        return Err(InstallError::new(InstallErrorCode::NavDisabled, "game.navigation and game.nav_bake need [nav] enabled = true"));
    }
    if !game.streaming.is_empty() && !crate::stream::STREAMING_BUILT {
        return Err(InstallError::new(InstallErrorCode::StreamingDisabled, "game.streaming needs [streaming] enabled = true"));
    }
    Ok(())
}

fn check_world_size(size: [u32; 2]) -> Result<(), InstallError> {
    if size.iter().all(|side| (MIN_WORLD_PX..=MAX_WORLD_PX).contains(side)) {
        return Ok(());
    }
    let detail = format!("{}x{} ({MIN_WORLD_PX}..={MAX_WORLD_PX})", size[0], size[1]);
    Err(InstallError::new(InstallErrorCode::InvalidWorldSize, detail))
}

fn check_streaming(
    registrations: &[crate::stream::Streaming],
    contents: &[crate::stream::CellContent],
    navigation: Option<&crate::nav::NavConfig>,
) -> Result<(), InstallError> {
    if registrations.len() > 1 {
        return Err(InstallError::new(InstallErrorCode::DuplicateStreaming, "game.streaming is registered once"));
    }
    // A stream cell holds whole nav tiles, so a cell's nav is its own tiles (NAV-11).
    let split_tiles = registrations.iter().zip(navigation).find(|(streaming, nav)| !nav.divides_stream_cell(streaming.cell_size()));
    if let Some((streaming, nav)) = split_tiles {
        let detail = format!("the stream cell size {} is not a whole number of {} m nav tiles", streaming.cell_size(), nav.tile());
        return Err(InstallError::new(InstallErrorCode::StreamingInvalid, detail));
    }
    let thing_bytes = contents.iter().map(|content| content.thing_bytes).max().unwrap_or(0);
    match registrations.iter().find_map(|streaming| streaming.refusal(thing_bytes)) {
        Some(detail) => Err(InstallError::new(InstallErrorCode::StreamingInvalid, detail)),
        None => Ok(()),
    }
}

fn check_single<F>(registrations: &[Single<F>], code: InstallErrorCode, detail: &str) -> Result<(), InstallError> {
    if registrations.iter().skip(1).all(|r| r.overrides) {
        return Ok(());
    }
    Err(InstallError::new(code, detail))
}

fn check_probes<W>(game: &Game<W>) -> Result<(), InstallError> {
    let names = game.probes.iter().map(|p| p.name.as_str());
    check_names(names, InstallErrorCode::DuplicateProbe, &[])?;
    match game.probes.iter().find(|p| RUNTIME_KEYS.contains(&p.name.as_str())) {
        Some(probe) => Err(InstallError::new(InstallErrorCode::ReservedProbe, format!("{} is a state() key", probe.name))),
        None => Ok(()),
    }
}

fn check_names<'a>(
    names: impl Iterator<Item = &'a str>,
    duplicate: InstallErrorCode,
    reserved: &[&str],
) -> Result<(), InstallError> {
    let mut seen = Set::default();
    for name in names {
        if !valid_name(name) || reserved.contains(&name) {
            return Err(InstallError::new(InstallErrorCode::InvalidName, format!("{name:?}")));
        }
        if !seen.insert(name) {
            return Err(InstallError::new(duplicate, name.to_owned()));
        }
    }
    Ok(())
}

fn valid_name(name: &str) -> bool {
    let length = name.chars().count();
    !name.trim().is_empty() && length <= MAX_NAME_CHARS && !name.chars().any(char::is_control)
}
