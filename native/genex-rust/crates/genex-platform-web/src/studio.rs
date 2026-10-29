//! The studio verbs over a [`GameHandle`]: genex-studio's [`StudioGame`] for a facade runtime and a
//! [`Painter`] that draws a view. The web shell answers `window.__studio` through
//! `genex_studio::Studio::web()` with it (the `{id:null, ok, op, result}` envelope the C++ web
//! build's `webCall` answers, the shared ops only), so a Rust web page has the C++ page's shapes:
//! `step` with `steppedFrames` and `drawCalls`, `seed` with the seed, `demo` as `{ok, demo,
//! result}` or `{ok:false, available}`, `input` counting unknown keys in `ignored`, named cameras
//! and eyes. Plain Rust, so the shapes are tested natively; the pond's native `studio` feature
//! uses the same input and JSON bridges.
//!
//! [`Screen`] is the web shell's painter: genex's shared presenter (the one native runs draw with),
//! the custom passes refused at install, the frame meter `state().fps` reads and the last frame's
//! GPU counters, so `state()` answers `fps`, per-tag triangles, `volatile.customPasses`,
//! `volatile.gpu` and `volatile.render` as a native studio run does; it also answers
//! `renderSettings` and draws captures on the game's pinned capture profile (RQ0.7).

use crate::assets::WebAssets;
use crate::web_stream::{Delivered, STATE_WEB_STREAM};
use crate::draw::{AssetSource as _, AssetTable};
use crate::handle::GameHandle;
use genex::present::{ModelSource, Presenter};
use genex::{AssetError, AssetErrorCode, AssetGroup, AssetGroups, AssetSource};
use std::sync::Arc;
use genex::render::{RenderAnswer, RenderChange, RenderStatus, requested_spelling, spelled_features};
use genex::{Input, Key};
use genex_core::clock::FpsMeter;
use genex_core::json::{self, Value};
use genex_core::session::{AudioLevel, StepResult};
use genex_render::{GpuCounters, RenderCode};
use genex_studio::verbs::{SpelledAnswer, SpelledChange, capture_provenance_value, render_answer_value, render_status_value, spell_change};
use genex_studio::wire::{self, RenderSettingsChange, RenderSettingsRefusal};
use genex_studio::{CaptureFault, Injection, Op, Pixels, StudioGame};

/// A web build's assets for the sim's reads and the presenter's models: the table compiled into
/// the module first, then the staged files the shell fetched and admitted before `studio_boot`
/// (shared, so both read one copy). A reset reads them by the native rule (`gfx.assets().bytes`:
/// boot and sim groups only, `not-preloaded` for the rest), so the same seed gives the same
/// checksum on the web as on a desktop.
#[derive(Clone)]
pub struct WebSource {
    compiled: AssetTable,
    fetched: Arc<WebAssets>,
    groups: AssetGroups,
    delivered: Delivered,
}

impl WebSource {
    /// The compiled table, then the fetched files.
    pub fn new(compiled: AssetTable, fetched: WebAssets) -> WebSource {
        WebSource { compiled, fetched: Arc::new(fetched), groups: AssetGroups::default(), delivered: Delivered::default() }
    }

    /// These assets with the groups the build recorded for them.
    pub fn with_groups(mut self, groups: AssetGroups) -> WebSource {
        self.groups = groups;
        self
    }

    /// These assets, then the streamed and named files the shell delivers while playing
    /// (`crate::web_stream`), shared with it.
    pub fn with_delivered(mut self, delivered: Delivered) -> WebSource {
        self.delivered = delivered;
        self
    }

    /// The bytes of `path`: the compiled table first, then the fetched files (as
    /// [`crate::assets::Layered`] serves them).
    fn bytes(&self, path: &str) -> Option<&[u8]> {
        self.compiled.asset(path).or_else(|| self.fetched.get(path))
    }

    /// The bytes of `path` from any layer, the delivered files last; `missing` when none has it.
    fn shared(&self, path: &str) -> Result<Arc<[u8]>, AssetError> {
        if let Some(bytes) = self.bytes(path) {
            return Ok(Arc::from(bytes));
        }
        self.delivered.get(path).ok_or_else(|| AssetError::new(AssetErrorCode::Missing, format!("{path} was not fetched")))
    }
}

impl AssetSource for WebSource {
    fn read(&self, path: &str) -> Result<Arc<[u8]>, AssetError> {
        self.shared(path)
    }

    fn size(&self, path: &str) -> Result<u64, AssetError> {
        if let Some(bytes) = self.bytes(path) {
            return Ok(bytes.len() as u64);
        }
        self.shared(path).map(|bytes| bytes.len() as u64)
    }

    fn group(&self, path: &str) -> AssetGroup {
        self.groups.of(path)
    }
}

impl ModelSource for WebSource {
    fn model_bytes(&self, path: &str) -> Option<Vec<u8>> {
        self.shared(path).ok().map(|bytes| bytes.to_vec())
    }

    /// The compiled table's bytes (they come first): a fetched file is not the program's for its
    /// whole life, so its decoded upload is kept.
    fn static_bytes(&self, path: &str) -> Option<&'static [u8]> {
        self.compiled.iter().find(|(known, _)| *known == path).map(|(_, bytes)| *bytes)
    }
}

/// The page verbs that only read: answering one changes nothing the next frame shows.
const READ_ONLY_VERBS: [&str; 4] = [Op::STATE, Op::CAMERAS, Op::EYES, Op::DEMOS];

/// Whether page verb `op` with `arg` can change what the next frame shows (a view placed, a step
/// or a demo run, input, the settings changed), so the shell draws that frame even without a tick.
/// A read (`state`, `cameras`, `eyes`, `demos`, a `renderSettings` without `set`) cannot; redrawing
/// for one put an extra frame one display refresh after the last every time Live's stage polled
/// `state()`. An op this list does not know is taken to change the picture.
pub fn verb_changes_frame(op: &str, arg: &Value) -> bool {
    if op == Op::RENDER_SETTINGS {
        return arg.get("set").is_some();
    }
    !READ_ONLY_VERBS.contains(&op)
}

/// The volatile keys a painter adds to `state()`, and the meter's key.
const STATE_FPS: &str = "fps";
const STATE_VOLATILE: &str = "volatile";

/// genex-core's JSON value for a facade (serde) value; the facade's JSON always re-parses.
pub fn core_value(value: &genex::Value) -> Value {
    json::parse(value.to_string().as_bytes()).unwrap_or(Value::Null)
}

/// The facade's input for one key list; names the facade has no key for are dropped (the parser
/// already counted the names it could not read in `ignored`).
fn keys(names: &[String], make: fn(Key) -> Input) -> Input {
    names.iter().filter_map(|name| Key::from_code(name)).map(make).fold(Input::default(), Input::and)
}

/// The facade's input for a parsed `input` verb: keys, look, wheel, pointer and committed text.
pub fn injection_input(injection: &Injection) -> Input {
    let mut input = keys(&injection.down, Input::key_down)
        .and(keys(&injection.up, Input::key_up))
        .and(keys(&injection.tap, Input::key_tap))
        .and(Input::look(injection.look.x, injection.look.y))
        .and(Input::wheel(injection.wheel.x, injection.wheel.y));
    if let Some(pointer) = injection.pointer {
        input = input.and(Input::pointer(pointer.x, pointer.y));
    }
    if let Ok(text) = std::str::from_utf8(&injection.text) {
        input = input.and(Input::text(text));
    }
    input
}

/// What draws a view of the game where the shell shows it; answers the draw calls it made.
pub trait Painter {
    /// Draw `view` (a camera or eye name; None for the game's own).
    fn paint(&mut self, game: &mut dyn GameHandle, view: Option<&str>) -> u32;
    /// The shell's live frame rate (`state().fps`); 0 without a meter.
    fn fps(&self) -> f64 {
        0.0
    }
    /// The meter starts over (a new seed).
    fn reset_meter(&mut self) {}
    /// What the painter adds under `state().volatile` (custom passes, GPU counters).
    fn volatile(&mut self, _game: &mut dyn GameHandle) -> Vec<(&'static str, Value)> {
        Vec::new()
    }
    /// Draw `view` as a capture (the game's pinned capture settings); by default as [`Painter::paint`].
    fn paint_capture(&mut self, game: &mut dyn GameHandle, view: Option<&str>) -> u32 {
        self.paint(game, view)
    }
    /// The capture reply's `render` provenance; None without render settings.
    fn capture_provenance(&self) -> Option<Value> {
        None
    }
    /// `renderSettings` (see `StudioGame::render_settings`); `unavailable` by default.
    fn render_settings(&mut self, _change: Option<&RenderSettingsChange>) -> Result<Value, RenderSettingsRefusal> {
        Err(RenderSettingsRefusal::Unavailable)
    }
}

/// A painter held while a capture is in flight: a verb that would draw (`seed`, `step`, `demo`,
/// `debugCamera`) leaves the world target to the capture, which reads it back, and answers the last
/// frame's draw calls; everything else is the inner painter's. The shell marks the frame stale, so
/// the next animation frame after the capture draws what the verb changed (RX review: a `step`
/// during a capture's settle or readback drew Live into the target the capture read and rebuilt the
/// renderer for Live's samples).
pub struct Held<'a, P: Painter> {
    inner: &'a mut P,
    last_draws: u32,
}

impl<'a, P: Painter> Held<'a, P> {
    /// `inner` held, answering `last_draws` for a draw it does not make.
    pub fn new(inner: &'a mut P, last_draws: u32) -> Held<'a, P> {
        Held { inner, last_draws }
    }
}

impl<P: Painter> Painter for Held<'_, P> {
    fn paint(&mut self, _game: &mut dyn GameHandle, _view: Option<&str>) -> u32 {
        self.last_draws
    }
    fn fps(&self) -> f64 {
        self.inner.fps()
    }
    fn reset_meter(&mut self) {
        self.inner.reset_meter();
    }
    fn volatile(&mut self, game: &mut dyn GameHandle) -> Vec<(&'static str, Value)> {
        self.inner.volatile(game)
    }
    fn paint_capture(&mut self, _game: &mut dyn GameHandle, _view: Option<&str>) -> u32 {
        self.last_draws
    }
    fn capture_provenance(&self) -> Option<Value> {
        self.inner.capture_provenance()
    }
    fn render_settings(&mut self, change: Option<&RenderSettingsChange>) -> Result<Value, RenderSettingsRefusal> {
        self.inner.render_settings(change)
    }
}

/// The `renderSettings` answer on the wire.
fn answer_value(answer: &RenderAnswer) -> Option<Value> {
    let (class, detected) = (answer.device_class.wire(), answer.detected_class.wire());
    let requested = requested_spelling(answer.requested);
    let features = spelled_features(&answer.features);
    render_answer_value(&SpelledAnswer {
        preset: answer.preset.wire(),
        requested,
        class: &class,
        detected: &detected,
        features: &features,
        render_scale_lock: answer.render_scale_lock.map(f64::from),
        frame_budget_ms: answer.frame_budget_ms.map(f64::from),
        scale: f64::from(answer.scale),
    })
}

/// `state().volatile.render` on the wire.
fn status_value(status: &RenderStatus) -> Option<Value> {
    let degraded: Vec<(&str, Option<String>)> = status.degraded.iter().map(|d| (d.reason.wire(), d.subject.clone())).collect();
    render_status_value(
        &status.device_class.wire(),
        status.preset.wire(),
        f64::from(status.scale),
        &spelled_features(&status.features),
        &degraded,
        status.gpu_ms.map(f64::from),
        status.cpu_ms.map(f64::from),
    )
}

/// The verb's change in the facade's types; a spelling the facade lacks is refused typed.
fn facade_change(change: &RenderSettingsChange) -> Result<RenderChange, RenderSettingsRefusal> {
    let SpelledChange { preset, device_class, features, reset_features, render_scale_lock, frame_budget_ms, look } = spell_change(change);
    let frame_budget_ms = frame_budget_ms.map(|budget| budget.map(|ms| ms as f32));
    let refused = |refusal: genex::render::RenderRefusal| RenderSettingsRefusal::from_wire(refusal.wire()).unwrap_or(RenderSettingsRefusal::Unavailable);
    let look = look.map(|keys| keys.map(|json| RenderChange::look_from_json(&json)).transpose()).transpose().map_err(refused)?;
    RenderChange::from_spellings(preset, device_class, &features, render_scale_lock)
        .map(|change| RenderChange { reset_features, frame_budget_ms, look, ..change })
        .map_err(refused)
}

/// The web shell's painter: genex's shared presenter with the game's passes, the passes refused at
/// install, the frame meter and the last frame's GPU counters (module docs).
pub struct Screen {
    /// The shared presenter the frame is drawn with.
    pub presenter: Presenter,
    install_refused: Vec<(String, RenderCode)>,
    fps: FpsMeter,
    /// The meter's clock: the shown frames' intervals summed (the page hands each one over).
    clock_ms: f64,
    gpu: Option<GpuCounters>,
    /// The files the shell delivered while playing, reported as `volatile.webStream`.
    pub delivered: Option<Delivered>,
}

impl Screen {
    /// A screen drawing through `presenter`.
    pub fn new(presenter: Presenter) -> Screen {
        Screen { presenter, install_refused: Vec::new(), fps: FpsMeter::default(), clock_ms: 0.0, gpu: None, delivered: None }
    }

    /// Register `game`'s custom GPU passes on the presenter (the web's `studio_boot`): a refused
    /// pass stays out of every frame and is listed in `volatile.customPasses` with its code.
    pub fn install(&mut self, game: &mut dyn GameHandle) {
        for (name, error) in game.install_passes(&mut self.presenter) {
            log::warn!("genex web: {error}");
            self.install_refused.push((name, error.code()));
        }
    }

    /// One frame shown `frame_ms` after the one before: what `state().fps` counts.
    pub fn shown(&mut self, frame_ms: f64) {
        self.clock_ms += frame_ms.max(0.0);
        self.fps.frame(self.clock_ms);
    }

    /// What the last drawn frame encoded; None before one was drawn or after one failed.
    pub fn gpu_counters(&self) -> Option<GpuCounters> {
        self.gpu
    }

    /// `volatile.customPasses`: each pass the game registered, in order, with what stopped it;
    /// None for a game without passes.
    fn custom_passes(&self, game: &mut dyn GameHandle) -> Option<Value> {
        let registered = game.gpu_passes();
        if registered.is_empty() {
            return None;
        }
        let mut list = Value::array();
        for (name, stage, code) in self.presenter.pass_statuses(registered, &self.install_refused) {
            list.push(wire::custom_pass_status(&name, stage.wire(), code.map(RenderCode::wire)));
        }
        Some(list)
    }
}

/// `volatile.gpu`: the encoder's draws, compute dispatches and render passes for the last frame.
fn gpu_value(gpu: GpuCounters) -> Value {
    let mut value = Value::object();
    value.set("encoderDraws", Value::from(gpu.encoder_draws));
    value.set("dispatches", Value::from(gpu.dispatches));
    value.set("passes", Value::from(gpu.passes));
    value
}

impl Painter for Screen {
    fn paint(&mut self, game: &mut dyn GameHandle, view: Option<&str>) -> u32 {
        let drawn = game.draw(&mut self.presenter, view);
        // A pass stopped in this frame: its code is in `volatile.customPasses`; the log says why.
        for refusal in self.presenter.take_pass_refusals() {
            log::warn!("genex web: {refusal}");
        }
        match drawn {
            None => 0,
            Some(Ok(drawn)) => {
                self.gpu = Some(drawn.gpu);
                drawn.draw_calls
            }
            Some(Err(error)) => {
                // Nothing was drawn: no draw calls to report.
                log::error!("genex web: render failed: {error}");
                self.gpu = None;
                0
            }
        }
    }

    fn fps(&self) -> f64 {
        self.fps.fps()
    }

    fn reset_meter(&mut self) {
        self.fps.reset();
    }

    fn volatile(&mut self, game: &mut dyn GameHandle) -> Vec<(&'static str, Value)> {
        let mut extra = Vec::new();
        if let Some(passes) = self.custom_passes(game) {
            extra.push((wire::STATE_CUSTOM_PASSES, passes));
        }
        if let Some(gpu) = self.gpu {
            extra.push((wire::STATE_GPU, gpu_value(gpu)));
        }
        if let Some(delivered) = &self.delivered {
            extra.push((STATE_WEB_STREAM, core_value(&delivered.receipt())));
        }
        if let Some(render) = self.presenter.render_settings().and_then(|handle| status_value(&handle.borrow().status())) {
            extra.push((wire::STATE_RENDER, render));
        }
        extra
    }

    fn paint_capture(&mut self, game: &mut dyn GameHandle, view: Option<&str>) -> u32 {
        self.presenter.set_capturing(true);
        let draws = self.paint(game, view);
        self.presenter.set_capturing(false);
        draws
    }

    fn capture_provenance(&self) -> Option<Value> {
        let render = self.presenter.capture_render()?;
        let class = render.device_class.wire();
        capture_provenance_value(render.preset.wire(), &class, render.source.wire(), f64::from(render.scale), render.settle_frames, render.history_reset)
    }

    fn render_settings(&mut self, change: Option<&RenderSettingsChange>) -> Result<Value, RenderSettingsRefusal> {
        let handle = self.presenter.render_settings().cloned().ok_or(RenderSettingsRefusal::Unavailable)?;
        let answer = match change {
            Some(change) => {
                let change = facade_change(change)?;
                handle.borrow_mut().apply(&change)
            }
            None => handle.borrow().answer(),
        };
        answer_value(&answer).ok_or(RenderSettingsRefusal::Unavailable)
    }
}

/// A game handle as genex-studio's [`StudioGame`]: the view and the last frame's draw count live
/// with the shell, the drawing with its [`Painter`].
pub struct HandleGame<'a, P: Painter> {
    /// The facade runtime.
    pub game: &'a mut dyn GameHandle,
    /// What draws a view.
    pub painter: &'a mut P,
    /// The named camera or eye drawn from; None for the game's own.
    pub view: &'a mut Option<String>,
    /// Draw calls the last frame made.
    pub draws: &'a mut u32,
}

impl<P: Painter> HandleGame<'_, P> {
    fn has_view(&self, name: &str) -> bool {
        self.game.cameras().iter().chain(self.game.eyes().iter()).any(|known| known == name)
    }
}

impl<P: Painter> StudioGame for HandleGame<'_, P> {
    fn seed(&mut self, seed: u32) {
        self.painter.reset_meter();
        self.game.seed(seed);
    }
    fn start(&mut self) -> bool {
        self.game.start()
    }
    fn pause(&mut self) -> bool {
        self.game.pause()
    }
    fn step(&mut self, ms: f64) -> StepResult {
        let step = self.game.step(ms);
        StepResult { ticks: step.ticks, frame: step.frame, simulated_ms: step.simulated_ms }
    }
    fn state(&mut self, camera: &str) -> Value {
        let mut state = core_value(&self.game.state());
        state.set("camera", Value::from(camera));
        let fps = self.painter.fps();
        state.set(STATE_FPS, Value::from(fps));
        let mut volatile = state[STATE_VOLATILE].clone();
        volatile.set(STATE_FPS, Value::from(fps));
        for (key, value) in self.painter.volatile(self.game) {
            volatile.set(key, value);
        }
        state.set(STATE_VOLATILE, volatile);
        state
    }
    fn inject(&mut self, injection: &Injection) -> Vec<String> {
        self.game.inject(injection_input(injection))
    }
    fn view(&mut self, name: Option<&str>) -> bool {
        if name.is_some_and(|name| !self.has_view(name)) {
            return false;
        }
        *self.view = name.map(str::to_owned);
        true
    }
    fn cameras(&self) -> Vec<String> {
        self.game.cameras()
    }
    fn eyes(&self) -> Vec<String> {
        self.game.eyes()
    }
    fn demos(&self) -> Vec<String> {
        self.game.demos()
    }
    fn run_demo(&mut self, name: &str) -> Value {
        self.game.demo(name).map_or(Value::Null, |result| core_value(&result))
    }
    fn render(&mut self) {
        *self.draws = self.painter.paint(self.game, self.view.as_deref());
    }
    fn draw_calls(&self) -> u32 {
        *self.draws
    }
    fn world_size(&self) -> [u32; 2] {
        self.game.world_size()
    }
    /// The web flavour describes a capture and the shell reads the pixels back itself.
    fn capture(&mut self) -> Result<Pixels, CaptureFault> {
        Err(CaptureFault::Readback)
    }
    fn render_for_capture(&mut self) {
        *self.draws = self.painter.paint_capture(self.game, self.view.as_deref());
    }
    fn capture_provenance(&self) -> Option<Value> {
        self.painter.capture_provenance()
    }
    fn render_settings(&mut self, change: Option<&RenderSettingsChange>) -> Result<Value, RenderSettingsRefusal> {
        self.painter.render_settings(change)
    }
    /// `audio({muted})`: the game's device output (the meter still reads the mix).
    fn set_muted(&mut self, muted: bool) {
        self.game.set_output_muted(muted);
    }
    /// `audioLevel` (and the page's `audio()` probe): the game's own mix, before the mute.
    fn audio_level(&self) -> AudioLevel {
        let level = self.game.audio_level();
        AudioLevel { rms: level.rms, centroid: level.centroid }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use genex::{AssetFiles, AssetTable, Game, Runtime, json};
    use genex_core::digest::{fnv1a64, hex64};

    const LEVEL: &[u8] = br#"{"enemies": 3, "spawn": [1.5, 0.0, -2.0]}"#;

    #[derive(Default)]
    struct World {
        enemies: i64,
        outcome: Vec<String>,
    }

    /// The fetched set a page admits for `files`, by the build's asset map (version 1).
    fn fetched(files: &[(&str, &[u8])]) -> WebAssets {
        let entries: Vec<String> = files
            .iter()
            .map(|(path, bytes)| format!(r#"{{"path":"{path}","bytes":{},"fnv1a64":"{}"}}"#, bytes.len(), hex64(fnv1a64(bytes))))
            .collect();
        let map = format!(r#"{{"version":1,"files":[{}]}}"#, entries.join(","));
        let mut assets = WebAssets::plan(map.as_bytes()).expect("a well-formed map");
        for (path, bytes) in files {
            assets.admit(path, bytes.to_vec()).expect("admitted");
        }
        assets
    }

    /// A game whose reset parses the level JSON, then counts it up each tick.
    fn level_game() -> Game<World> {
        let mut game = Game::new(World::default()).world_size(64, 64);
        game.on_reset(|sim, _, _, gfx| {
            let bytes = gfx.assets().bytes("levels/one.json").expect("the level reads at reset");
            let level = bytes.json().expect("JSON");
            sim.world.enemies = level["enemies"].as_i64().unwrap_or(-1);
        });
        game.on_update(|sim, ctx| sim.world.enemies += i64::from(ctx.rng.below(3)));
        game.probe("enemies", |sim| json!(sim.world.enemies));
        game
    }

    fn checksum_after(source: Box<dyn AssetSource>) -> String {
        let mut runtime = Runtime::with_assets(level_game(), source).expect("valid game");
        runtime.step(1000.0);
        runtime.checksum()
    }

    /// A game that parses JSON at reset gets one checksum from a desktop's asset folder, a compiled
    /// table and the web's fetched set.
    #[test]
    fn a_level_parsed_at_reset_gives_one_checksum_on_desktop_and_the_web() {
        let dir = std::env::temp_dir().join(format!("genex-web-source-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("assets/levels")).expect("assets folder");
        std::fs::write(dir.join("assets/levels/one.json"), LEVEL).expect("level");
        let table: AssetTable = &[("levels/one.json", LEVEL)];
        let desktop = checksum_after(Box::new(AssetFiles::new(&[], Some(dir.join("assets")))));
        let compiled = checksum_after(Box::new(table));
        let web = checksum_after(Box::new(WebSource::new(&[], fetched(&[("levels/one.json", LEVEL)]))));
        assert_eq!(desktop, compiled);
        assert_eq!(desktop, web);
        let none = checksum_after_without_level();
        assert_ne!(desktop, none, "the level moved the checksum: the read happened on the first seed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn checksum_after_without_level() -> String {
        let mut game = Game::new(World::default()).world_size(64, 64);
        game.on_update(|sim, ctx| sim.world.enemies += i64::from(ctx.rng.below(3)));
        game.probe("enemies", |sim| json!(sim.world.enemies));
        let mut runtime = Runtime::new(game).expect("valid game");
        runtime.step(1000.0);
        runtime.checksum()
    }

    /// The web refuses a streamed asset at reset exactly as a desktop does, and the compiled table
    /// comes before the fetched files.
    #[test]
    fn the_web_source_keeps_the_native_read_rules() {
        let groups = AssetGroups::default().with("cells/a.json", AssetGroup::Stream);
        let set = fetched(&[("cells/a.json", b"{}"), ("levels/one.json", b"fetched")]);
        let compiled: AssetTable = &[("levels/one.json", LEVEL)];
        let web = WebSource::new(compiled, set).with_groups(groups.clone());
        let desktop = AssetFiles::new(&[("cells/a.json", b"{}"), ("levels/one.json", LEVEL)], None).with_groups(groups);
        let paths = ["cells/a.json", "levels/one.json", "nope.json", "../x.json"];
        let outcome = |source: Box<dyn AssetSource>| {
            let mut game = Game::new(World::default()).world_size(64, 64);
            game.on_reset(move |sim, _, _, gfx| {
                for path in paths {
                    let answer = gfx.assets().bytes(path);
                    sim.world.outcome.push(answer.map_or_else(|error| error.code().wire().to_owned(), |bytes| format!("{} bytes", bytes.len())));
                }
            });
            Runtime::with_assets(game, source).expect("valid game").sim().world.outcome.clone()
        };
        let expected = ["not-preloaded".to_owned(), format!("{} bytes", LEVEL.len()), "missing".to_owned(), "unsafe-path".to_owned()];
        assert_eq!(outcome(Box::new(web.clone())), expected, "the web");
        assert_eq!(outcome(Box::new(desktop)), expected, "a desktop");
        assert_eq!(web.model_bytes("cells/a.json"), Some(b"{}".to_vec()), "the presenter draws from the same set");
        assert_eq!(web.static_bytes("levels/one.json"), Some(LEVEL), "the compiled table is the program's");
    }
}
