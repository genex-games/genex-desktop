//! The dev flavour's studio mode (cargo feature `studio`; an export is built without it and never
//! links genex-studio). When the studio starts a game (descriptor 3 and `GENEX_STUDIO_NONCE`),
//! [`crate::install`] serves genex-studio's verbs over the game's [`Runtime`] here, headless,
//! rendering on the host GPU: `ready` (protocol 2 with the capability receipt), every v1 op,
//! captures written as `state/captures/<seq>.bgra`, and on a Mac the embedded run's ring
//! (`surface`, `release`, Live's frames through genex-frames); `quit` and the studio's end of file
//! end the game with exit 0, a panic sends `fatal`.
//!
//! The GPU's typed refusals reach the host as codes, never as stderr prose: a device below WebGPU
//! core ends the run with `fatal` `gpu-unsupported` (a declared native feature the device lacks,
//! `native-feature-missing`); `capture` answers the code of a frame that could not be drawn
//! (`device-lost` while the device is re-created between requests, an upload or mesh refusal)
//! instead of reading back a stale picture; and `state().volatile.customPasses` lists each custom
//! GPU pass with the code that stopped it (`gpu-pass-invalid`).
//!
//! Render settings (RQ0.7): `renderSettings` reads and changes the game's Live settings for this
//! session (a preset, feature switches, a class to emulate, a scale lock), `state().volatile.render`
//! reports what Live frames run with (class, preset, scale, switches, degraded reasons, GPU and CPU
//! ms), and `capture` draws the pinned capture profile as a settled capture (K re-renders on the
//! renderer's capture-owned history, RQ1.5; Live's history is left where it was, and the Live
//! picture is drawn again at the same tick afterwards) and names it in its reply's `render`
//! provenance (`settleFrames` is the K drawn). At boot the device is probed and, when no hint is cached in the saves, calibrated
//! once; the host may name the adapter's reference class in `GENEX_RENDER_REFERENCE_CLASS`. A
//! settings change is warmed off the loop (`Presenter::set_off_thread_changes`): Live keeps the
//! settings it drew until the new renderer is ready, so the loop answers every verb and heartbeat
//! while the game box compiles the new configuration's shaders cold.
//!
//! Play-time AI (genex-ai): `ready` declares `capabilities.ai` for a game that called `game.ai(..)`;
//! when the studio took it (`GENEX_STUDIO_AI=1`) the game's AI is connected, its lines go out
//! before each reply and after each live frame, and `ai.reply` / `ai.delta` reach `ctx.ai`.
//!
//! Host glue, not simulation: it reads the wall clock to pace live frames and time them, which
//! the lane's game rules refuse in game code. TODO(M2.4): the windowed desktop shell (a Studio run
//! without `GENEX_HEADLESS` opens a window) and `front`/`visible` on it.
#![allow(
    clippy::disallowed_types,
    reason = "host glue (dev flavour only): live pacing and frame timings read the wall clock; the simulation never sees it"
)]

mod live;

use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::gfx::AssetTable;
use crate::input::Input;
use crate::render::{CaptureRender, DeviceClass, RenderAnswer, RenderChange, RenderStatus, ScoreLevel, requested_spelling, spelled_features};
use crate::runtime::{Runtime, View};
use genex_core::clock::FpsMeter;
use genex_core::json::Value;
use genex_core::paths::process_env;
use genex_core::session::{FrameTiming, StepResult, Timings};
use genex_render::{GpuCounters, RenderCode, RenderError};
use genex_studio::verbs::{SpelledAnswer, SpelledChange, capture_provenance_value, render_answer_value, render_status_value, spell_change};
use genex_studio::wire::{self, Backend, GpuRefusal, NativeEnhanced, Receipt, RenderSettingsChange, RenderSettingsRefusal, SurfaceArgs};
use genex_studio::{
    CaptureFault, FatalReason, Injection, Pixels, ReadyInfo, RingFault, Studio, StudioGame, Transport,
    from_environment, report_panics,
};
use crate::present::Presenter;
use live::{Live, Presented};

/// One live frame at 60 Hz.
const FRAME: Duration = Duration::from_micros(16_667);
/// The graphics path `ready` names when the adapter's backend is not a WebGPU-core one.
const BACKEND_UNKNOWN: &str = "unknown";
/// Exit code when the GPU or the world target could not be opened.
const EXIT_NO_GPU: i32 = 1;
/// The class the host recorded for this adapter, which captures are drawn as (`DeviceClass`).
const REFERENCE_CLASS_ENV: &str = "GENEX_RENDER_REFERENCE_CLASS";

/// The game behind the studio: its runtime, the renderer, the view and the meters.
struct StudioRun<'a, W> {
    game: &'a mut Runtime<W>,
    presenter: Presenter,
    live: Live,
    /// The named camera or eye drawn from; None for the game's own.
    view: Option<String>,
    draws: u32,
    /// What the GPU encoded for the last frame drawn; None before one was, or after one failed.
    gpu: Option<GpuCounters>,
    visible: bool,
    timing: FrameTiming,
    fps: FpsMeter,
    born: Instant,
    /// Custom passes refused at install, by name, with the code that refused each.
    install_refused: Vec<(String, RenderCode)>,
}

/// The receipt `ready` carries: the renderer's backend, adapter and offered native-enhanced
/// features in the wire's spelling, and the frame inputs this build really produces for v2 sources
/// (`custom_pass::PRODUCED_INPUTS`: a declared input outside it reads a neutral value); None (a
/// protocol 1 `ready`) for a backend the wire lacks.
fn receipt_of(gpu: &genex_render::Gpu) -> Option<Receipt> {
    let facts = gpu.receipt();
    let backend = Backend::from_wire(facts.backend)?;
    let features = facts.native_enhanced.iter().filter_map(|name| NativeEnhanced::from_wire(name)).collect();
    let mut receipt = Receipt::new(backend, facts.adapter.clone(), features);
    receipt.render_settings_api = Some(wire::RENDER_SETTINGS_API_VERSION);
    receipt.render_inputs = produced_inputs();
    Some(receipt)
}

/// The receipt's `renderInputs`: what this build produces, in the wire's spelling.
fn produced_inputs() -> Vec<wire::RenderInput> {
    genex_render::custom_pass::PRODUCED_INPUTS.iter().filter_map(|input| wire::RenderInput::from_wire(input.wire())).collect()
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

/// A capture's `render` provenance on the wire.
fn provenance_value(render: &CaptureRender) -> Option<Value> {
    let class = render.device_class.wire();
    capture_provenance_value(render.preset.wire(), &class, render.source.wire(), f64::from(render.scale), render.settle_frames, render.history_reset)
}

/// The verb's change in the facade's types; a spelling the facade lacks is refused typed.
fn facade_change(change: &RenderSettingsChange) -> Result<RenderChange, RenderSettingsRefusal> {
    let SpelledChange { preset, device_class, features, reset_features, render_scale_lock, frame_budget_ms } = spell_change(change);
    let frame_budget_ms = frame_budget_ms.map(|budget| budget.map(|ms| ms as f32));
    RenderChange::from_spellings(preset, device_class, &features, render_scale_lock)
        .map(|change| RenderChange { reset_features, frame_budget_ms, ..change })
        .map_err(|refusal| RenderSettingsRefusal::from_wire(refusal.wire()).unwrap_or(RenderSettingsRefusal::Unavailable))
}

/// `volatile.gpu`: the encoder's draws, compute dispatches and render passes for the last frame.
fn gpu_value(gpu: GpuCounters) -> Value {
    let mut value = Value::object();
    value.set("encoderDraws", Value::from(gpu.encoder_draws));
    value.set("dispatches", Value::from(gpu.dispatches));
    value.set("passes", Value::from(gpu.passes));
    value
}

fn os_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(windows) {
        "windows"
    } else {
        "linux"
    }
}

/// The `fatal` reason a run that could not open its renderer ends with: the typed GPU refusal when
/// the device is below the floor or lacks a declared feature, `window-failed` for anything else.
fn fatal_reason(error: &RenderError) -> &'static str {
    match error.code() {
        RenderCode::GpuUnsupported => GpuRefusal::GpuUnsupported.wire(),
        RenderCode::NativeFeatureMissing => GpuRefusal::NativeFeatureMissing.wire(),
        _ => FatalReason::WINDOW_FAILED,
    }
}

/// What `capture` answers for a frame that could not be drawn, or a readback that failed.
fn capture_fault(error: &RenderError) -> CaptureFault {
    match error.code() {
        RenderCode::CaptureFailed => CaptureFault::Readback,
        code => CaptureFault::Refused(code.wire()),
    }
}

impl<W: Default + 'static> StudioRun<'_, W> {
    /// Whether the game has a named camera or eye called `name`.
    fn has_view(&self, name: &str) -> bool {
        self.game.cameras().iter().chain(self.game.eyes().iter()).any(|known| known == name)
    }

    fn view_of<'n>(&self, name: Option<&'n str>) -> View<'n> {
        match name {
            None => View::Game,
            Some(name) if self.game.cameras().iter().any(|camera| camera == name) => View::Named(name),
            Some(name) => View::Eye(name),
        }
    }

    fn ready_info(&self) -> ReadyInfo {
        let gpu = self.presenter.gpu();
        let receipt = receipt_of(gpu);
        let backend_api = receipt.as_ref().map_or(BACKEND_UNKNOWN, |r| r.backend.wire()).to_owned();
        ReadyInfo {
            build: format!("genex-rust/{}/headless", os_name()),
            backend_api,
            device: Some(gpu.receipt().adapter.clone()),
            size: self.game.world_size(),
            seed: self.game.seed_value(),
            receipt,
            ai: self.game.uses_ai(),
        }
    }

    /// One live frame of `interval_ms`: its ticks, then a draw when the world moved.
    fn live_frame(&mut self, interval_ms: f64) {
        self.fps.frame(self.born.elapsed().as_secs_f64() * 1000.0);
        let ticked_from = Instant::now();
        let ticks = self.game.advance_live(interval_ms);
        let ticked = Instant::now();
        if ticks > 0 {
            self.render();
        }
        let update_ms = (ticked - ticked_from).as_secs_f64() * 1000.0;
        self.timing.record(interval_ms, update_ms, ticked.elapsed().as_secs_f64() * 1000.0);
    }

    /// After a device loss, between the studio's requests: a new device, every mesh replayed, the
    /// game's passes rebuilt, Live's sender let go (its ring was made on the old device) and the
    /// frame drawn again. Answers whether the device was re-created; the caller then tells the
    /// studio, which announces a new ring generation, so no slot of the old one is ever reused.
    fn recover(&mut self) -> bool {
        match self.presenter.recover_for(self.game) {
            Ok(false) => false,
            Ok(true) => {
                self.live.device_changed();
                self.render();
                true
            }
            Err(error) => {
                eprintln!("genex: the GPU device is not back yet: {error}");
                false
            }
        }
    }

    /// `volatile.customPasses`: each pass the game registered, in order, with what stopped it.
    fn custom_passes(&mut self) -> Option<Value> {
        let registered = self.game.gpu_passes();
        if registered.is_empty() {
            return None;
        }
        let mut list = Value::array();
        for (name, stage) in registered {
            let installed = self.install_refused.iter().find(|(refused, _)| *refused == name).map(|(_, code)| *code);
            let refusal = installed.or_else(|| self.presenter.passes.refusal_of(&name));
            list.push(wire::custom_pass_status(&name, stage.wire(), refusal.map(RenderCode::wire)));
        }
        Some(list)
    }
}

impl<W: Default + 'static> StudioGame for StudioRun<'_, W> {
    fn seed(&mut self, seed: u32) {
        self.fps.reset();
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
        let mut state = self.game.state_value(camera, self.fps.fps());
        let passes = self.custom_passes();
        let render = status_value(&self.game.render().borrow().status());
        if passes.is_none() && self.gpu.is_none() && render.is_none() {
            return state;
        }
        let mut volatile = state["volatile"].clone();
        if let Some(passes) = passes {
            volatile.set(wire::STATE_CUSTOM_PASSES, passes);
        }
        if let Some(gpu) = self.gpu {
            volatile.set(wire::STATE_GPU, gpu_value(gpu));
        }
        if let Some(render) = render {
            volatile.set(wire::STATE_RENDER, render);
        }
        state.set("volatile", volatile);
        state
    }
    fn inject(&mut self, injection: &Injection) -> Vec<String> {
        self.game.inject(Input::from_injection(injection.clone()))
    }
    fn view(&mut self, name: Option<&str>) -> bool {
        if name.is_some_and(|name| !self.has_view(name)) {
            return false;
        }
        self.view = name.map(str::to_owned);
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
        self.game.demo(name).map_or(Value::Null, |result| Value::from(&result))
    }
    fn render(&mut self) {
        let name = self.view.clone();
        let view = self.view_of(name.as_deref());
        let Some(drawn) = self.presenter.draw_view(self.game, view) else { return };
        match drawn {
            Ok(drawn) => {
                self.draws = drawn.draw_calls;
                self.gpu = Some(drawn.gpu);
            }
            Err(error) => {
                // Nothing was drawn: no draw calls to report, and `capture` answers the code.
                self.draws = 0;
                self.gpu = None;
                eprintln!("genex: render failed: {error}");
            }
        }
        // A pass stopped in this frame: its code is in `volatile.customPasses`; the log says why.
        for refusal in self.presenter.take_pass_refusals() {
            eprintln!("genex: {refusal}");
        }
        self.live.changed();
    }
    fn draw_calls(&self) -> u32 {
        self.draws
    }
    fn world_size(&self) -> [u32; 2] {
        self.game.world_size()
    }
    fn capture(&mut self) -> Result<Pixels, CaptureFault> {
        if let Some(error) = self.presenter.failure() {
            return Err(capture_fault(error));
        }
        let capture = self.presenter.resilient.capture().map_err(|error| capture_fault(&error));
        // Live shows the Live settings again, not the pinned profile the capture was drawn with.
        if !self.presenter.last_draw_is_live() {
            self.render();
        }
        let capture = capture?;
        Ok(Pixels { width: capture.width(), height: capture.height(), bgra: capture.bgra().to_vec() })
    }
    fn render_for_capture(&mut self) {
        self.presenter.set_capturing(true);
        self.render();
        self.presenter.set_capturing(false);
    }
    fn capture_provenance(&self) -> Option<Value> {
        provenance_value(&self.presenter.capture_render()?)
    }
    fn render_settings(&mut self, change: Option<&RenderSettingsChange>) -> Result<Value, RenderSettingsRefusal> {
        let handle = self.game.render();
        let answer = match change {
            Some(change) => {
                let change = facade_change(change)?;
                handle.borrow_mut().apply(&change)
            }
            None => handle.borrow().answer(),
        };
        answer_value(&answer).ok_or(RenderSettingsRefusal::Unavailable)
    }
    fn timings(&self) -> Timings {
        self.timing.timings()
    }
    fn set_visible(&mut self, visible: bool) -> bool {
        self.visible = visible;
        if visible {
            self.live.changed();
        }
        visible
    }
    fn embeddable(&self) -> bool {
        cfg!(target_os = "macos")
    }
    fn make_ring(&mut self, ring: &SurfaceArgs) -> Result<(), RingFault> {
        self.live.make_ring(&self.presenter, ring)
    }
    fn take_ai_op(&mut self, op: &str, arg: &Value) -> Option<bool> {
        // The studio's argument, already parsed under the protocol's line and depth caps, read
        // again as the JSON genex-ai takes; bytes that are not JSON text are no argument.
        let arg: serde_json::Value = serde_json::from_slice(&arg.dump()).ok()?;
        self.game.ai().take_studio_op(op, &arg).ok()
    }
    fn take_ai_lines(&mut self) -> Vec<String> {
        self.game.ai().take_lines()
    }
    fn release_slot(&mut self, generation: u32, slot: u32) {
        self.live.release(generation, slot);
    }
}

/// The live loop: serve the studio, re-create a lost device, run the frame, send it to Live, pace
/// to 60 Hz waking for the studio's next request; returns once `quit` or the studio's end of file
/// asked the game to close.
fn run<W: Default + 'static>(studio: &mut Studio, link: &Transport, game: &mut StudioRun<'_, W>) {
    let mut last: Option<Instant> = None;
    loop {
        let start = Instant::now();
        studio.serve(link, game);
        if studio.closing() {
            return;
        }
        if game.presenter.resilient.is_lost() && game.recover() {
            studio.device_restored(link);
        }
        let interval = last.map_or(0.0, |at| (start - at).as_secs_f64() * 1000.0);
        last = Some(start);
        game.live_frame(interval);
        // Lines the live ticks printed go out now; a request's own go out before its reply.
        studio.flush_ai(link, game);
        if game.live.present(&mut game.presenter, game.visible) == Presented::Gone {
            studio.end_ring();
        }
        link.wait(FRAME.saturating_sub(start.elapsed()));
    }
}

/// The studio run over `runtime` on an opened `presenter`: its custom passes registered (a
/// refused one stays out of every frame and is listed with its code), then its first frame;
/// `starting` tells the studio each boot step finished.
fn studio_run<'a, W: Default + 'static>(
    runtime: &'a mut Runtime<W>,
    mut presenter: Presenter,
    live: Live,
    starting: &dyn Fn(),
) -> StudioRun<'a, W> {
    // The first frame's pipelines compile on another thread while the passes install here (a boot
    // under load used to spend both one after the other before `ready`, pass-1 gate).
    presenter.warm_boot(runtime);
    starting();
    let refused = crate::gpu::host::install(runtime, &mut presenter.passes, presenter.resilient.gpu());
    starting();
    let install_refused = refused
        .into_iter()
        .map(|(name, error)| {
            eprintln!("genex: {error}");
            (name, error.code())
        })
        .collect();
    let mut game = StudioRun {
        game: runtime,
        presenter,
        live,
        view: None,
        draws: 0,
        gpu: None,
        visible: true,
        timing: FrameTiming::default(),
        fps: FpsMeter::default(),
        born: Instant::now(),
        install_refused,
    };
    // The first frame, then live play: what the game is at `ready`, as the C++ runtime begins.
    game.game.start();
    game.render();
    game
}

/// Serve the studio when it started the game: answers the exit code, or None (having opened and
/// adopted nothing) when there is no studio, so the caller runs the game its own way.
pub(crate) fn serve<W: Default + 'static>(runtime: &mut Runtime<W>, assets: AssetTable) -> Option<i32> {
    let env = |name: &str| process_env(name);
    let link = Arc::new(from_environment(&env)?);
    report_panics(Arc::clone(&link));
    let mut studio = Studio::for_run(&env);
    let mut presenter = match Presenter::open(runtime.world_size(), assets) {
        Ok(presenter) => presenter,
        Err(error) => {
            eprintln!("genex: {error}");
            Studio::send_fatal(&link, fatal_reason(&error));
            return Some(EXIT_NO_GPU);
        }
    };
    // A settings change (the person's panel, the verb, a capture's pinned profile) is warmed off
    // the loop, which keeps answering the studio and drawing Live (pass-1 gate).
    presenter.set_off_thread_changes(true);
    // Each finished boot step gives the studio's ready deadline again (contract v2 `starting`): a
    // heavy game under load keeps its start while every step progresses (pass-1 gate).
    let starting = || {
        studio.still_starting(&link);
    };
    starting();
    boot_render(runtime, &presenter, env(REFERENCE_CLASS_ENV).as_deref());
    starting();
    let mut game = studio_run(runtime, presenter, Live::from_env(&env), &starting);
    let info = game.ready_info();
    studio.announce_ready(&link, &info);
    if studio.takes_ai() {
        game.game.ai().connect();
    }
    run(&mut studio, &link, &mut game);
    game.live.close();
    Some(0)
}

/// Probe the game's render settings with the presenter's device: the host's reference class
/// (captures), this device's saved choice, and the calibration hint (cached in the saves, else
/// measured once now, at most `CALIBRATION_GPU_BUDGET_MS` of GPU time; Live only).
fn boot_render<W: Default + 'static>(runtime: &mut Runtime<W>, presenter: &Presenter, reference: Option<&str>) {
    runtime.render().borrow_mut().set_reference_class(reference.and_then(DeviceClass::from_wire));
    let facts = presenter.gpu().device_facts().clone();
    if runtime.boot_render(facts.clone(), None).is_some() || !facts.can_calibrate() {
        return;
    }
    match genex_render::device_class::calibrate_blocking(presenter.gpu()) {
        Ok(Some(calibration)) => {
            runtime.boot_render(facts, Some(ScoreLevel::quantize(calibration.score(), None)));
        }
        Ok(None) => {}
        Err(error) => eprintln!("genex: calibration skipped: {error}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use genex_render::UnsupportedReason;

    #[test]
    fn a_renderer_that_cannot_open_ends_the_run_with_its_typed_gpu_code() {
        let unsupported = RenderError::GpuUnsupported { reason: UnsupportedReason::NoAdapter, detail: "no adapter".to_owned() };
        assert_eq!(fatal_reason(&unsupported), "gpu-unsupported");
        let missing = RenderError::refused(RenderCode::NativeFeatureMissing, "subgroup");
        assert_eq!(fatal_reason(&missing), "native-feature-missing");
        let failed = RenderError::refused(RenderCode::DeviceFailed, "the device request failed");
        assert_eq!(fatal_reason(&failed), FatalReason::WINDOW_FAILED);
    }

    #[test]
    fn a_frame_that_was_not_drawn_refuses_capture_with_its_code() {
        let lost = RenderError::refused(RenderCode::DeviceLost, "lost");
        assert_eq!(capture_fault(&lost), CaptureFault::Refused("device-lost"));
        let budget = RenderError::refused(RenderCode::UploadBudget, "too much");
        assert_eq!(capture_fault(&budget), CaptureFault::Refused("upload-budget"));
        let readback = RenderError::refused(RenderCode::CaptureFailed, "map failed");
        assert_eq!(capture_fault(&readback), CaptureFault::Readback);
    }

    #[test]
    fn the_receipt_lists_the_environment_among_the_inputs_this_build_produces() {
        let spelled: Vec<&str> = produced_inputs().iter().map(|input| input.wire()).collect();
        // RQ5.6 flipped (was depth, normals, environment): the prepass writes motion too.
        assert_eq!(
            spelled,
            ["depth", "normals", "motion", "environment"],
            "RQ2 produces the environment, the RQ4.5 prepass depth and normals, RQ5.6 its motion"
        );
    }
}

/// GPU rows: the presenter on the host GPU (Metal on the Mac), driven through genex-studio's own
/// verb handling in-process. Run with `cargo test -p genex --features studio -- --ignored metal`
/// (`GENEX_REQUIRE_METAL=1` makes a missing adapter a failure).
#[cfg(test)]
mod metal {
    use super::*;
    use crate::gpu::{GpuError, GpuPass, GpuPassCtx, PassSetup, PassStage};
    use crate::prelude::*;
    use genex_core::json;

    #[derive(Default)]
    struct World {
        shop: bool,
    }

    /// A pass whose rebuild refuses: what a broken custom pass looks like to the studio.
    struct Broken;

    impl GpuPass<World> for Broken {
        fn rebuild(&mut self, _setup: &mut PassSetup<'_>) -> Result<(), GpuError> {
            Err(GpuError::refused(crate::gpu::GpuCode::GpuPassInvalid, "the test's pass refuses its rebuild"))
        }
        fn run(&mut self, _ctx: &mut GpuPassCtx<'_, '_, World>) {}
    }

    fn game(projection: Projection, distance: f32) -> Game<World> {
        let mut game = Game::new(World::default()).world_size(96, 64).background(Color::rgb(8, 8, 16));
        game.on_update(|sim, ctx| {
            if ctx.keys.pressed(Key::KeyH) {
                sim.world.shop = !sim.world.shop;
            }
        });
        game.on_ui(|sim, ui, _| {
            if sim.world.shop {
                let _ = ui.button("Shop");
            }
        });
        game.camera(move |_| Camera { projection, fovy: 4.0, ..Camera::look_at(vec3(0.0, 0.0, distance), Vec3::ZERO) });
        game.on_draw(|_, frame, _| {
            frame.tag("marker").cube(Transform::from_xyz(0.0, 0.0, 0.0), Color::RED);
        });
        game
    }

    fn presenter(require: bool) -> Option<Presenter> {
        match Presenter::open([96, 64], &[]) {
            Ok(presenter) => Some(presenter),
            Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
            Err(error) => {
                eprintln!("skipped: no WebGPU-core adapter ({error})");
                None
            }
        }
    }

    fn required() -> bool {
        std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|value| value == "1")
    }

    /// One studio run of `game` in-process: its runtime is leaked so the run can borrow it.
    fn run_of(game: Game<World>) -> Option<StudioRun<'static, World>> {
        let presenter = presenter(required())?;
        let runtime = Box::leak(Box::new(Runtime::new(game).expect("installs")));
        Some(studio_run(runtime, presenter, Live::from_env(&|_| None), &|| {}))
    }

    fn call(studio: &mut Studio, run: &mut StudioRun<'static, World>, op: &str, arg: &str) -> json::Value {
        let line = studio.call(run, op, &json::parse(arg.as_bytes()).expect("arg"));
        json::parse(&line).expect("a reply line")
    }

    fn studio(save_root: &std::path::Path) -> Studio {
        let mut studio = Studio::native(save_root.to_str().expect("utf-8 path"));
        studio.mark_ready();
        studio
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("genex-studio-metal-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("scratch");
        dir
    }

    #[test]
    #[ignore = "needs the host GPU: run with --ignored metal"]
    fn metal_a_lost_device_answers_device_lost_then_the_same_picture_after_recovery() {
        let Some(mut run) = run_of(game(Projection::Perspective, 6.0)) else { return };
        let mut studio = studio(&scratch("loss"));
        let before = call(&mut studio, &mut run, "capture", "{}");
        assert_eq!(before["ok"], json::Value::Bool(true), "{before:?}");
        run.presenter.resilient.force_device_loss();
        let lost = call(&mut studio, &mut run, "capture", "{}");
        assert_eq!(lost["ok"], json::Value::Bool(false));
        assert_eq!(lost["error"].as_str(), "device-lost");
        assert!(run.recover(), "the device is re-created");
        let after = call(&mut studio, &mut run, "capture", "{}");
        assert_eq!(after["ok"], json::Value::Bool(true), "{after:?}");
        assert_eq!(after["result"]["digest"], before["result"]["digest"], "the replayed frame is the same picture");
    }

    #[test]
    #[ignore = "needs the host GPU: run with --ignored metal"]
    fn metal_a_labelled_widget_is_in_hud_items_and_in_the_capture() {
        let Some(mut run) = run_of(game(Projection::Perspective, 6.0)) else { return };
        let mut studio = studio(&scratch("hud"));
        let plain = call(&mut studio, &mut run, "capture", "{}");
        let items = call(&mut studio, &mut run, "state", "{}")["result"]["hud"]["items"].clone();
        assert!(items.items().is_empty(), "{items:?}");
        call(&mut studio, &mut run, "input", r#"{"actions":[{"type":"down","keys":["KeyH"]}]}"#);
        call(&mut studio, &mut run, "step", "{}");
        let state = call(&mut studio, &mut run, "state", "{}");
        let labels: Vec<&str> = state["result"]["hud"]["items"].items().iter().map(json::Value::as_str).collect();
        assert_eq!(labels, ["Shop"], "{state:?}");
        let shown = call(&mut studio, &mut run, "capture", "{}");
        assert_eq!(shown["ok"], json::Value::Bool(true), "{shown:?}");
        assert_ne!(shown["result"]["digest"], plain["result"]["digest"], "the HUD is painted into the capture");
    }

    #[test]
    #[ignore = "needs the host GPU: run with --ignored metal"]
    fn metal_a_game_that_uses_ai_declares_it_prints_its_lines_and_takes_the_studios_answers() {
        let mut ai_game = game(Projection::Perspective, 6.0);
        ai_game.ai(crate::ai::AiOptions::default());
        ai_game.on_update(|_, ctx| {
            if ctx.tick == 0 {
                ctx.ai.hello();
            }
        });
        let Some(mut run) = run_of(ai_game) else { return };
        assert!(run.ready_info().ai, "ready declares capabilities.ai");
        run.game.ai().connect();
        run.game.seed(1);
        run.game.step(16.0);
        let lines = run.take_ai_lines();
        assert_eq!(lines.len(), 1);
        let line: serde_json::Value = serde_json::from_str(&lines[0]).expect("a line");
        assert_eq!((line["event"].as_str(), line["op"].as_str()), (Some("ai"), Some("hello")));
        let reply = format!(r#"{{"rid":{},"reply":{{"v":1,"on":true}}}}"#, line["rid"]);
        let reply = json::parse(reply.as_bytes()).expect("arg");
        assert_eq!(run.take_ai_op("ai.reply", &reply), Some(true));
        assert!(run.game.ai().status().on);
        assert_eq!(run.take_ai_op("ai.reply", &json::parse(br#"{"reply":{}}"#).expect("arg")), None, "no rid: refused");
        let plain = run_of(game(Projection::Perspective, 6.0)).expect("a second run on the same adapter");
        assert!(!plain.ready_info().ai, "a game without AI declares none");
    }

    /// `game` with `config` and AO and TAA switched off on the reference class: nothing temporal
    /// is drawn unless `config` asks (high's temporal GTAO and TAA settle a capture over a whole
    /// jitter cycle; RQ5.6 added TAA, named in the log).
    fn without_ao(mut game: Game<World>, config: crate::render::RenderConfig) -> Game<World> {
        use crate::render::{ClassOverride, REFERENCE_CLASS, RenderFeature};
        let no_ao = ClassOverride { switches: vec![(RenderFeature::Ao, false), (RenderFeature::Taa, false)], ..ClassOverride::default() };
        game.render_settings(config.class(REFERENCE_CLASS, no_ao));
        game
    }

    /// The BGRA bytes of a capture of the cube seen from `distance` (AO off: its accumulated
    /// shading moves the cube's edge pixels across the background threshold).
    fn shot(projection: Projection, distance: f32) -> Option<Vec<u8>> {
        let mut run = run_of(without_ao(game(projection, distance), crate::render::RenderConfig::new()))?;
        let dir = scratch(&format!("ortho-{distance}"));
        let mut studio = studio(&dir);
        let shot = call(&mut studio, &mut run, "capture", "{}");
        let seq = shot["result"]["seq"].as_f64_or(0.0);
        Some(std::fs::read(dir.join("captures").join(format!("{seq}.bgra"))).expect("the capture file"))
    }

    /// Pixels of a capture that are not the background (the orthographic shot's corner, which the
    /// cube never reaches, within the tonemap's one-level dither): how big the cube is drawn.
    fn covered(projection: Projection, distance: f32) -> Option<usize> {
        let corner = shot(Projection::Orthographic, 6.0)?;
        let background = [corner[0], corner[1], corner[2]];
        let differs = |px: &[u8]| px[..3].iter().zip(background).any(|(a, b)| a.abs_diff(b) > 2);
        Some(shot(projection, distance)?.chunks(4).filter(|px| differs(px)).count())
    }

    #[test]
    #[ignore = "needs the host GPU: run with --ignored metal"]
    fn metal_an_orthographic_camera_keeps_an_objects_size_with_distance() {
        let (Some(near), Some(far)) = (covered(Projection::Orthographic, 6.0), covered(Projection::Orthographic, 30.0)) else { return };
        assert!(near > 0, "the cube is drawn");
        assert_eq!(near, far, "orthographic: the cube covers the same pixels at any distance");
        let (Some(near), Some(far)) = (covered(Projection::Perspective, 6.0), covered(Projection::Perspective, 30.0)) else { return };
        assert!(far < near, "perspective: farther is smaller ({far} < {near})");
    }

    #[test]
    #[ignore = "needs the host GPU: run with --ignored metal"]
    fn metal_render_settings_set_low_then_get_answers_low_and_volatile_render_names_it() {
        let Some(mut run) = run_of(game(Projection::Perspective, 6.0)) else { return };
        let mut studio = studio(&scratch("render-settings"));
        let set = call(&mut studio, &mut run, "renderSettings", r#"{"set":{"preset":"low"}}"#);
        assert_eq!(set["ok"], json::Value::Bool(true), "{set:?}");
        assert_eq!(set["result"]["preset"].as_str(), "low");
        let get = call(&mut studio, &mut run, "renderSettings", "{}");
        assert_eq!(get["result"]["preset"].as_str(), "low", "{get:?}");
        assert_eq!(get["result"]["requested"].as_str(), "low");
        run.render();
        let state = call(&mut studio, &mut run, "state", "{}");
        let render = &state["result"]["volatile"][wire::STATE_RENDER];
        assert_eq!(render["preset"].as_str(), "low", "{state:?}");
        assert_eq!(render["deviceClass"].as_str(), get["result"]["deviceClass"].as_str());
        let refused = call(&mut studio, &mut run, "renderSettings", r#"{"set":{"preset":"epic"}}"#);
        assert_eq!(refused["error"].as_str(), "unknown-preset", "{refused:?}");
        let emulated = call(&mut studio, &mut run, "renderSettings", r#"{"set":{"deviceClass":"mobile-mid","preset":"auto"}}"#);
        assert_eq!(emulated["result"]["deviceClass"].as_str(), "mobile-mid");
        assert_eq!(emulated["result"]["preset"].as_str(), "low", "mobile-mid's own preset");
    }

    #[test]
    #[ignore = "needs the host GPU: run with --ignored metal"]
    fn metal_a_capture_names_its_pinned_settings_and_live_frames_report_gpu_ms() {
        let Some(mut run) = run_of(game(Projection::Perspective, 6.0)) else { return };
        let mut studio = studio(&scratch("provenance"));
        let shot = call(&mut studio, &mut run, "capture", "{}");
        let render = &shot["result"][wire::STATE_RENDER];
        assert_eq!(render["deviceClass"].as_str(), "desktop-high", "{shot:?}");
        assert_eq!(render["settingsSource"].as_str(), "reference-class");
        assert_eq!(render["historyReset"], json::Value::Bool(true));
        assert_eq!(render["exposure"].as_str(), "instant");
        for _ in 0..12 {
            run.live_frame(FRAME.as_secs_f64() * 1000.0);
            run.render();
            let _ = run.presenter.gpu().device.poll(wgpu::PollType::wait_indefinitely());
        }
        let state = call(&mut studio, &mut run, "state", "{}");
        let status = &state["result"]["volatile"][wire::STATE_RENDER];
        let offers = run.presenter.gpu().device.features().contains(wgpu::Features::TIMESTAMP_QUERY);
        assert_eq!(matches!(status["gpuMs"], json::Value::Number(_)), offers, "{status:?}");
        assert!(matches!(status["cpuMs"], json::Value::Number(_)), "{status:?}");
        let emulate = call(&mut studio, &mut run, "renderSettings", r#"{"set":{"deviceClass":"mobile-mid"}}"#);
        assert_eq!(emulate["ok"], json::Value::Bool(true));
        let phone = call(&mut studio, &mut run, "capture", "{}");
        assert_eq!(phone["result"][wire::STATE_RENDER]["settingsSource"].as_str(), "verb", "{phone:?}");
        assert_ne!(phone["result"]["digest"], shot["result"]["digest"], "captured as a phone: a smaller render scale");
    }

    /// An API v1 pass inside the world that draws nothing: enough to keep frames on the LDR scene.
    struct V1InWorld;

    impl GpuPass<World> for V1InWorld {
        fn rebuild(&mut self, _setup: &mut PassSetup<'_>) -> Result<(), GpuError> {
            Ok(())
        }
        fn run(&mut self, _ctx: &mut GpuPassCtx<'_, '_, World>) {}
    }

    /// The scene path of the presenter's last frame.
    fn last_scene(run: &StudioRun<'static, World>) -> genex_render::renderer::ScenePath {
        run.presenter.resilient.renderer().renderer().last_scene().expect("a frame was drawn")
    }

    #[test]
    #[ignore = "needs the host GPU: run with --ignored metal"]
    fn metal_live_frames_and_captures_draw_the_hdr_scene_with_the_game_s_look() {
        use genex_render::settings::Tonemapper;
        let Some(mut run) = run_of(game(Projection::Perspective, 6.0)) else { return };
        let mut studio = studio(&scratch("hdr-live"));
        run.live_frame(FRAME.as_secs_f64() * 1000.0);
        run.render();
        let live = last_scene(&run);
        assert!(live.hdr && live.depth_reversed, "a facade game draws the HDR scene: {live:?}");
        assert_eq!(live.tonemapper, Tonemapper::KhronosNeutral, "the default look");
        let status = run.presenter.render_settings().expect("attached").borrow().status();
        assert!(status.degraded.iter().all(|d| d.reason.wire() != "custom-pass-v1-in-world"), "{:?}", status.degraded);
        let shot = call(&mut studio, &mut run, "capture", "{}");
        assert_eq!(shot["ok"], json::Value::Bool(true), "{shot:?}");
        assert!(last_scene(&run).hdr, "captures draw the HDR scene too");
    }

    #[test]
    #[ignore = "needs the host GPU: run with --ignored metal"]
    fn metal_a_v1_in_world_pass_keeps_frames_ldr_and_live_lists_why() {
        use crate::render::DegradeReason;
        let mut halo = game(Projection::Perspective, 6.0);
        halo.gpu_pass("halo", PassStage::AfterOpaque, V1InWorld);
        let Some(mut run) = run_of(halo) else { return };
        let mut studio = studio(&scratch("hdr-v1"));
        run.live_frame(FRAME.as_secs_f64() * 1000.0);
        run.render();
        let live = last_scene(&run);
        assert!(!live.hdr && !live.depth_reversed, "a v1 in-world pass keeps the legacy scene: {live:?}");
        assert_eq!(live.ldr_reason, Some(genex_render::LdrReason::CustomPassV1InWorld));
        let status = run.presenter.render_settings().expect("attached").borrow().status();
        assert!(status.degraded.iter().any(|d| d.reason == DegradeReason::CustomPassV1InWorld), "{:?}", status.degraded);
        let shot = call(&mut studio, &mut run, "capture", "{}");
        assert_eq!(shot["ok"], json::Value::Bool(true), "the frame still draws: {shot:?}");
    }

    #[test]
    #[ignore = "needs the host GPU: run with --ignored metal"]
    fn metal_a_settled_capture_names_its_re_renders_and_leaves_live_history_alone() {
        use crate::render::{Exposure, RenderConfig};
        let Some(mut run) = run_of(game(Projection::Perspective, 6.0)) else { return };
        let mut studio = studio(&scratch("settle"));
        let cycle = call(&mut studio, &mut run, "capture", "{}");
        assert_eq!(cycle["result"][wire::STATE_RENDER]["settleFrames"].as_f64(), 8.0, "high's temporal GTAO: one jitter cycle {cycle:?}");
        let Some(mut run) = run_of(without_ao(game(Projection::Perspective, 6.0), RenderConfig::new())) else { return };
        let plain = call(&mut studio, &mut run, "capture", "{}");
        assert_eq!(plain["result"][wire::STATE_RENDER]["settleFrames"].as_f64(), 1.0, "nothing temporal: one re-render {plain:?}");
        // Auto exposure (the game's look) on the HDR scene: the capture meters, then draws with
        // what it metered.
        let Some(mut run) = run_of(without_ao(game(Projection::Perspective, 6.0), RenderConfig::new().exposure(Exposure::auto()))) else { return };
        let first = call(&mut studio, &mut run, "capture", "{}");
        let render = &first["result"][wire::STATE_RENDER];
        // RQ5 review flipped 3 -> 2 (named in the log): the metering is exact, so a game with no
        // `post-hdr` pass meters once and draws (a `post-hdr` grade re-meters: 3).
        assert_eq!(render["settleFrames"].as_f64(), 2.0, "meter, draw: {first:?}");
        assert_eq!(render["historyReset"], json::Value::Bool(true));
        assert_eq!(render["exposure"].as_str(), "instant");
        for _ in 0..30 {
            run.live_frame(FRAME.as_secs_f64() * 1000.0);
        }
        let index = run.presenter.resilient.renderer().frame_index();
        assert!(index > 0, "Live frames advanced Live's history");
        let second = call(&mut studio, &mut run, "capture", "{}");
        assert_eq!(second["result"]["digest"], first["result"]["digest"], "Live frames between captures do not reach them");
        assert_eq!(run.presenter.resilient.renderer().frame_index(), index, "a capture leaves Live's history where it was");
    }

    #[test]
    #[ignore = "needs the host GPU: run with --ignored metal"]
    fn metal_a_refused_custom_pass_is_listed_with_its_code_and_the_frame_goes_on() {
        let mut broken = game(Projection::Perspective, 6.0);
        broken.gpu_pass("broken", PassStage::Post, Broken);
        let Some(mut run) = run_of(broken) else { return };
        let mut studio = studio(&scratch("pass"));
        let state = call(&mut studio, &mut run, "state", "{}");
        let passes = &state["result"]["volatile"][wire::STATE_CUSTOM_PASSES];
        let expected = wire::custom_pass_status("broken", "post", Some("gpu-pass-invalid"));
        assert_eq!(passes.items(), [expected], "{state:?}");
        let shot = call(&mut studio, &mut run, "capture", "{}");
        assert_eq!(shot["ok"], json::Value::Bool(true), "{shot:?}");
    }
}
