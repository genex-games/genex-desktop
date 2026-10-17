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
use crate::gfx::Gfx;
use crate::input::{Input, Merger, TickInput};
use crate::map::Set;
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

/// The keys `state()` owns; a probe may never use one as its name.
pub const RUNTIME_KEYS: [&str; 17] = [
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
}

impl InstallErrorCode {
    /// Every code, in declaration order.
    pub const ALL: [InstallErrorCode; 10] = [
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
}

impl<W: Default + 'static> Runtime<W> {
    /// Check the registrations and seed [`DEFAULT_SEED`].
    pub fn new(mut game: Game<W>) -> Result<Runtime<W>, InstallError> {
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
            gfx: Gfx::new(game.world_size, saves, game.wgsl.clone()),
            hud: Hud::new(),
            clock: FrameClock::default(),
            tally: Tally::default(),
            render: Rc::new(RefCell::new(RenderControl::new(game.render.clone(), (game.world_size[0], game.world_size[1])))),
        };
        let mut runtime = Runtime { game, core };
        runtime.seed(DEFAULT_SEED);
        Ok(runtime)
    }

    /// Rebuild the simulation on `seed` from defaults, run the reset hooks in order, pause and
    /// clear held and pending input.
    pub fn seed(&mut self, seed: u32) {
        let core = &mut self.core;
        core.sim = fresh_sim(W::default(), &self.game);
        core.seed = seed;
        core.tick = 0;
        core.running = false;
        core.clock.reset();
        core.merger = Merger::default();
        core.pointer_lock = false;
        core.hud.reset();
        core.gfx.assets().clear();
        core.gfx.clear_extensions();
        let mut rng = Pcg32::seeded(u64::from(seed));
        for hook in &self.game.resets {
            hook(&mut core.sim, seed, &mut rng, &core.gfx);
        }
        core.rng.set(rng);
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

    /// Run [`step_ticks`]`(ms)` ticks, running or not.
    pub fn step(&mut self, ms: f64) -> StepResult {
        step(&self.game, &mut self.core, ms)
    }

    /// Live play: run the whole ticks one rendered frame of `frame_ms` is worth (none while
    /// paused), carrying the remainder on genex-core's [`FrameClock`]; a frame counts at most
    /// 250 ms, which is 15 ticks.
    pub fn advance_live(&mut self, frame_ms: f64) -> u32 {
        if !self.core.running {
            return 0;
        }
        let ticks = self.core.clock.advance(frame_ms);
        for _ in 0..ticks {
            tick(&self.game, &mut self.core);
        }
        ticks
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
    }

    /// The simulation, read-only.
    pub fn sim(&self) -> &Sim<W> {
        &self.core.sim
    }

    /// The simulation, mutably (for shells and tests; game code never gets this).
    pub fn sim_mut(&mut self) -> &mut Sim<W> {
        &mut self.core.sim
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
        state
    }

    /// `state().hud`: `{items, crosshair, flash}`, the widgets the last tick's UI drew by label.
    fn hud_value(&self) -> CoreValue {
        let summary = self.core.hud.summary();
        let items: Vec<CoreValue> = summary.items.into_iter().map(CoreValue::from).collect();
        let mut hud = CoreValue::object();
        hud.set("items", CoreValue::Array(items));
        hud.set("crosshair", CoreValue::Bool(summary.crosshair));
        hud.set("flash", CoreValue::from(f64::from(summary.flash)));
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

    /// The last frame's tally as `__render`: `{drawCalls, triangles, tags: {tag: {drawCalls,
    /// triangles}}, exact: false}` (`studio.cpp` `tallyJson`), plus `missingModels` (the model
    /// paths drawn as the magenta checker) only when there are some.
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
        self.core.tally = Tally { draw_calls, triangles: 0, tags, missing_models: Vec::new() };
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

/// The saves of this process: the run's `state/` under the studio, else the destination's root
/// for the game's `save_name` or the build's identity.
fn saves_of(save_name: Option<&str>) -> Saves {
    Saves::for_process(save_name.unwrap_or(""), "", BUILD_IDENTITY)
}

fn fresh_sim<W>(world: W, game: &Game<W>) -> Sim<W> {
    Sim { world, physics: fresh_physics(), facets: FacetState::fresh(&game.facets) }
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
    let ticks = step_ticks(ms);
    for _ in 0..ticks {
        tick(game, core);
    }
    StepResult { ticks, frame: core.tick, simulated_ms: simulated_ms(core.tick) }
}

/// One fixed tick: update hooks, UI hooks, then one physics step.
fn tick<W>(game: &Game<W>, core: &mut Core<W>) {
    let input = core.merger.next_tick(game.world_size);
    core.pointer_lock = input.pointer_lock;
    // A HUD widget with the keyboard's focus (Tab to a settings switch, a tapped text field) takes
    // the keys from the update hooks until Escape or a click elsewhere; the HUD itself still gets
    // them below. Mouse buttons (and so touch 0) stay the game's.
    let taken = genex_hud::keys_taken(core.hud.context()).then(|| input.keys.mouse_buttons_only());
    let text = if taken.is_some() { "" } else { input.text.as_str() };
    let ctx = Ctx {
        keys: taken.as_ref().unwrap_or(&input.keys),
        touches: &input.touches,
        pads: &input.pads,
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
    };
    for hook in &game.updates {
        hook(&mut core.sim, &ctx);
    }
    if !game.uis.is_empty() {
        let sim = &mut core.sim;
        let panel = crate::render::PanelScope::enter(&core.render);
        core.hud.run(game.world_size, simulated_ms(core.tick) / 1000.0, &hud_input(&input), |ui| {
            for hook in &game.uis {
                hook(sim, ui, &ctx);
            }
        });
        drop(panel);
        // The person's panel choice is kept per device, outside the simulation.
        core.render.borrow_mut().save(core.gfx.saves());
    }
    #[cfg(feature = "physics")]
    core.sim.physics.step();
    core.tick += 1;
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
    }
}

fn validate<W>(game: &Game<W>) -> Result<(), InstallError> {
    check_world_size(game.world_size)?;
    check_single(&game.cameras, InstallErrorCode::DuplicateCamera, "a second camera needs .camera_override()")?;
    check_single(&game.players, InstallErrorCode::DuplicatePlayer, "a second player needs .player_override()")?;
    check_probes(game)?;
    let cameras = game.named_cameras.iter().map(|c| c.name.as_str());
    check_names(cameras, InstallErrorCode::DuplicateCameraName, &[DEFAULT_CAMERA])?;
    check_names(game.eyes.iter().map(|c| c.name.as_str()), InstallErrorCode::DuplicateEye, &[])?;
    check_names(game.demos.iter().map(|c| c.name.as_str()), InstallErrorCode::DuplicateDemo, &[])?;
    let mut facets = Set::default();
    for facet in &game.facets {
        if !facets.insert(facet.type_id) {
            return Err(InstallError::new(InstallErrorCode::DuplicateFacetState, facet.type_name));
        }
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
