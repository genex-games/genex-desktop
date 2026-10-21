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
//! Host glue, not simulation: it reads the wall clock to pace live frames and time them, which
//! the lane's game rules refuse in game code. TODO(M2.4): the windowed desktop shell (a Studio run
//! without `GENEX_HEADLESS` opens a window) and `front`/`visible` on it.
#![allow(
    clippy::disallowed_types,
    reason = "host glue (dev flavour only): live pacing and frame timings read the wall clock; the simulation never sees it"
)]

mod live;
mod pace;

use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::gfx::AssetTable;
use crate::input::Input;
use crate::render::{CaptureRender, DeviceClass, RenderAnswer, RenderChange, RenderStatus, ScoreLevel, requested_spelling, spelled_features};
use crate::runtime::{Runtime, View};
use genex_core::clock::FpsMeter;
use genex_core::json::Value;
use genex_core::paths::process_env;
use genex_core::protocol::{BootProgress, BootStage};
use genex_core::session::{AudioLevel, FrameTiming, StepResult, Timings};
use genex_render::{GpuCounters, RenderCode, RenderError};
use genex_studio::verbs::{
    ReloadFile, ReloadOutcome, ReloadRefusal, SpelledAnswer, SpelledChange, capture_provenance_value, render_answer_value, render_status_value,
    spell_change,
};
use genex_studio::wire::{self, Backend, GpuRefusal, NativeEnhanced, Receipt, RenderSettingsChange, RenderSettingsRefusal, SurfaceArgs};
use genex_studio::{
    CaptureFault, FatalReason, Injection, Pixels, ReadyInfo, RingFault, Studio, StudioGame, Transport,
    from_environment, report_panics,
};
use crate::present::{Presenter, ReloadMiss};
use crate::profile::EngineScope;
use genex_profile::GpuTimeSource;
use genex_studio::verbs::ProfileAnswer;
use genex_studio::wire::{GpuTimingMode, ProfileAction, ProfileRequest};
use live::{Live, Presented};
use pace::{DueFrame, StudioPace};

/// One live frame at 60 Hz.
const FRAME: Duration = Duration::from_micros(16_667);
/// While a Live frame waits for the GPU, the loop looks again this soon to send it.
const LIVE_SEND_POLL: Duration = Duration::from_millis(1);
/// While the boot's warm-up compiles, how often Live is told how far it is (each also gives the
/// ready deadline again, up to the host's cap).
const BOOT_PROGRESS_EVERY: Duration = Duration::from_millis(100);
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
    /// The audio device Studio Live opens with its first ring (AU-8): a headless studio run, which
    /// never makes a ring, never opens one.
    audio: crate::audio::Device,
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
    receipt.reload_assets_api = Some(wire::RELOAD_ASSETS_API_VERSION);
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

/// The destination a desktop run's profile reports and crash records name.
fn destination() -> &'static str {
    if cfg!(target_os = "macos") {
        "mac"
    } else if cfg!(windows) {
        "windows"
    } else {
        "linux"
    }
}

/// A profile answer's JSON bytes as the studio's value; `unavailable` before the recorder started.
fn profile_value(json: Option<Vec<u8>>) -> Result<ProfileAnswer, &'static str> {
    let json = json.ok_or(genex_studio::VerbRefusal::UNAVAILABLE)?;
    let value = genex_core::json::parse(&json).map_err(|_| genex_studio::VerbRefusal::UNAVAILABLE)?;
    Ok(ProfileAnswer::Value(value))
}

/// A reload miss in the wire's vocabulary.
fn reload_refusal(miss: ReloadMiss) -> ReloadRefusal {
    match miss {
        ReloadMiss::Missing => ReloadRefusal::Missing,
        ReloadMiss::DigestMismatch => ReloadRefusal::DigestMismatch,
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
        }
    }

    /// One live frame: the ticks its paced time is worth, then a draw when the world moved; the
    /// timings keep the frame's wall-clock interval. The frame is one profiler frame (PROF-5): its
    /// `frame` scope holds the ticks and the draw, the GPU time that landed is attached and, while
    /// per-node timing is armed, the frame's graph steps are bracketed.
    fn live_frame(&mut self, frame: DueFrame) {
        self.fps.frame(self.born.elapsed().as_secs_f64() * 1000.0);
        let armed = self.game.profiling().armed().then(|| self.game.profiling().frame_index());
        self.presenter.set_node_frame(armed);
        let scope = crate::profile::engine_scope(EngineScope::Frame);
        let ticked_from = Instant::now();
        let ticks = self.game.advance_live(frame.fed_ms);
        let ticked = Instant::now();
        if ticks > 0 {
            let _draw = crate::profile::engine_scope(EngineScope::Draw);
            self.render();
        }
        drop(scope);
        let update_ms = (ticked - ticked_from).as_secs_f64() * 1000.0;
        self.timing.record(frame.interval_ms, update_ms, ticked.elapsed().as_secs_f64() * 1000.0);
        self.close_profile_frame(frame.interval_ms);
        if self.audio.is_open() {
            self.game.note_audio_device(true, self.audio.fault());
        }
    }

    /// Close the profiler's frame: the GPU time the settings last measured and the per-node samples
    /// that landed.
    fn close_profile_frame(&mut self, interval_ms: f64) {
        let source = if self.presenter.gpu().device.features().contains(wgpu::Features::TIMESTAMP_QUERY) {
            GpuTimeSource::Timestamps
        } else {
            GpuTimeSource::None
        };
        let gpu_ms = self.game.render().borrow().status().gpu_ms;
        let samples = self.presenter.take_node_samples();
        let profiling = self.game.profiling();
        profiling.set_gpu_source(source);
        profiling.record_nodes(&samples);
        let index = profiling.frame_index();
        profiling.new_frame(interval_ms, gpu_ms.map(|ms| (index, f64::from(ms))));
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
    fn set_capture_size(&mut self, size: Option<[u32; 2]>) -> bool {
        self.presenter.set_capture_size(size.map(|[width, height]| (width, height)));
        true
    }
    fn set_capture_lens(&mut self, lens: genex_studio::CaptureLens) -> bool {
        self.presenter.set_capture_lens(crate::render::CaptureLens { depth_of_field: lens.depth_of_field, motion_blur: lens.motion_blur });
        true
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
    /// `audio({muted})`: the game's device output (the meter still reads the mix).
    fn set_muted(&mut self, muted: bool) {
        self.game.set_output_muted(muted);
    }
    /// `audioLevel`: the game's own mix, the last 2048 frames before the mute.
    fn audio_level(&self) -> AudioLevel {
        let level = self.game.audio_level();
        AudioLevel { rms: level.rms, centroid: level.centroid }
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
        // Live's HUD is tessellated for the new ring from the next frame on.
        self.presenter.set_window_size((ring.width, ring.height));
        self.live.make_ring(&self.presenter, ring)?;
        // Live is the run a person sees and hears while embedded: its first ring opens the device.
        self.audio.open_for(self.game);
        Ok(())
    }
    fn release_slot(&mut self, generation: u32, slot: u32) {
        self.live.release(generation, slot);
    }
    /// `profile` (PROF-5): the summary, a report of the last frames (with the hitches kept and,
    /// while armed, each frame's GPU nodes), arming per-node GPU timing, or a Chrome trace the
    /// studio writes into `state/profile/`.
    fn profile(&mut self, request: &ProfileRequest) -> Result<ProfileAnswer, &'static str> {
        let class = self.game.render().borrow().status().device_class.wire();
        let frames = request.frames as usize;
        let profiling = self.game.profiling();
        match request.action {
            ProfileAction::Summary => profile_value(profiling.summary_json()),
            ProfileAction::Report => profile_value(profiling.report_json(frames, destination(), &class)),
            ProfileAction::Arm => {
                let nodes = request.mode == Some(GpuTimingMode::Nodes);
                profiling.arm(nodes);
                let mode = if nodes { GpuTimingMode::Nodes } else { GpuTimingMode::Frame };
                let mut answer = Value::object();
                answer.set("mode", Value::from(mode.wire()));
                Ok(ProfileAnswer::Value(answer))
            }
            ProfileAction::Trace => profiling.trace_json(frames, destination(), &class).map(ProfileAnswer::Trace).ok_or(genex_studio::VerbRefusal::UNAVAILABLE),
        }
    }
    /// `reloadAssets` (C-18): the files whose new bytes match are dropped from the presenter and
    /// the frame is drawn again at once, running or paused, so the next capture (settled or not)
    /// is drawn wholly from the new bytes; `busy` while an earlier reload is still pending (a lost
    /// device kept it from loading).
    fn reload_assets(&mut self, files: &[ReloadFile]) -> Result<ReloadOutcome, &'static str> {
        if self.presenter.reload_pending() > 0 {
            return Err(genex_studio::VerbRefusal::BUSY);
        }
        let asked: Vec<(&str, u64)> = files.iter().map(|file| (file.path.as_str(), file.digest)).collect();
        let answers = self.presenter.reload_assets(&asked);
        let mut outcome = ReloadOutcome::default();
        for (file, answer) in files.iter().zip(answers) {
            match answer {
                Ok(()) => outcome.reloaded.push(file.path.clone()),
                Err(miss) => outcome.refused.push((file.path.clone(), reload_refusal(miss))),
            }
        }
        if !outcome.reloaded.is_empty() {
            self.render();
        }
        outcome.pending = self.presenter.reload_pending();
        Ok(outcome)
    }
}

/// The live loop: serve the studio, re-create a lost device, run the frame when its deadline came
/// ([`StudioPace`]: absolute 60 Hz deadlines, whole frames fed to the clock), hand it to Live
/// (sent once the GPU finished it, without waiting: the loop looks again every millisecond while
/// one is in flight), and wait for the next deadline, waking for the studio's next request;
/// returns once `quit` or the studio's end of file asked the game to close.
fn run<W: Default + 'static>(studio: &mut Studio, link: &Transport, game: &mut StudioRun<'_, W>) {
    let mut pace = StudioPace::new(FRAME);
    loop {
        studio.serve(link, game);
        if studio.closing() {
            return;
        }
        if game.presenter.resilient.is_lost() && game.recover() {
            studio.device_restored(link);
        }
        if let Some(frame) = pace.due(Instant::now()) {
            game.live_frame(frame);
        }
        if game.live.present(&mut game.presenter, game.visible) == Presented::Gone {
            studio.end_ring();
        }
        let wait = pace.wait(Instant::now());
        link.wait(if game.live.in_flight() { wait.min(LIVE_SEND_POLL) } else { wait });
    }
}

/// The studio run over `runtime` on an opened `presenter`: its custom passes registered (a
/// refused one stays out of every frame and is listed with its code), then its first frame;
/// `starting` tells the studio each boot step finished and where the boot is (owner decision D11:
/// the pipelines n of m while the warm-up compiles them, then the first frame).
fn studio_run<'a, W: Default + 'static>(
    runtime: &'a mut Runtime<W>,
    mut presenter: Presenter,
    live: Live,
    starting: &dyn Fn(BootProgress),
) -> StudioRun<'a, W> {
    let compiled_before = genex_render::compile::compile_tally();
    let compiling = || {
        let tally = genex_render::compile::compile_tally().since(compiled_before);
        BootProgress::counted(BootStage::Pipelines, tally.finished as u64, tally.submitted as u64)
    };
    // The first frame's pipelines compile on another thread while the passes install here (a boot
    // under load used to spend both one after the other before `ready`, pass-1 gate).
    starting(BootProgress::at(BootStage::Assets));
    presenter.warm_boot(runtime);
    starting(compiling());
    let refused = crate::gpu::host::install(runtime, &mut presenter.passes, presenter.resilient.gpu());
    starting(compiling());
    // Live shows how far the compiles are while the warm-up runs, instead of one long wait.
    while presenter.boot_warming() {
        std::thread::sleep(BOOT_PROGRESS_EVERY);
        starting(compiling());
    }
    starting(BootProgress::at(BootStage::Frame));
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
        audio: crate::audio::Device::default(),
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
    // Live profiles by default (scopes on, owner call P1); crash records name this build.
    runtime.profiling().start(true);
    crate::crash::set_identity(destination(), true, &format!("genex-rust/{}/headless", os_name()), u64::from(wire::CONTRACT_VERSION_V2));
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
    let starting = |progress: BootProgress| {
        studio.starting_at(&link, progress);
    };
    starting(BootProgress::at(BootStage::Device));
    boot_render(runtime, &presenter, env(REFERENCE_CLASS_ENV).as_deref());
    starting(BootProgress::at(BootStage::Device));
    let mut game = studio_run(runtime, presenter, Live::from_env(&env), &starting);
    let info = game.ready_info();
    studio.announce_ready(&link, &info);
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

    /// One whole live frame, as the loop's pace feeds it.
    fn one_frame() -> DueFrame {
        let ms = FRAME.as_secs_f64() * 1000.0;
        DueFrame { interval_ms: ms, fed_ms: ms }
    }

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
        Some(studio_run(runtime, presenter, Live::from_env(&|_| None), &|_| {}))
    }

    fn call<W: Default + 'static>(studio: &mut Studio, run: &mut StudioRun<'static, W>, op: &str, arg: &str) -> json::Value {
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

    /// Owner decision D11: a studio boot names its stages and counts the warm-up's pipelines n of
    /// m, so Live shows real progress instead of one long wait. Other rows compile alongside on the
    /// shared pool, so the counts are read as bounds.
    #[test]
    #[ignore = "needs the host GPU: run with --ignored metal"]
    fn metal_a_studio_boot_names_its_stages_and_counts_its_pipelines() {
        let Some(mut presenter) = presenter(required()) else { return };
        presenter.set_off_thread_changes(true);
        let runtime = Box::leak(Box::new(Runtime::new(game(Projection::Perspective, 6.0)).expect("installs")));
        let seen = std::cell::RefCell::new(Vec::new());
        let _run = studio_run(runtime, presenter, Live::from_env(&|_| None), &|progress| seen.borrow_mut().push(progress));
        let seen = seen.into_inner();
        let mut stages: Vec<BootStage> = Vec::new();
        for progress in &seen {
            if !stages.contains(&progress.stage) {
                stages.push(progress.stage);
            }
        }
        assert_eq!(stages, [BootStage::Assets, BootStage::Pipelines, BootStage::Frame], "{seen:?}");
        let counted: Vec<(u64, u64)> = seen.iter().filter_map(|progress| progress.done.zip(progress.total)).collect();
        let (done, total) = counted.last().copied().expect("the pipelines were counted");
        assert!(total > 0, "the warm-up handed its pipelines to the pool: {seen:?}");
        assert!(counted.iter().all(|(done, total)| done <= total), "never more done than asked: {counted:?}");
        assert!(done > 0, "the compiles were seen finishing: {counted:?}");
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
            run.live_frame(one_frame());
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
        run.live_frame(one_frame());
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
        run.live_frame(one_frame());
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
            run.live_frame(one_frame());
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

    /// PROF-5: Live frames are profiler frames; `profile` answers the summary, arms per-node GPU
    /// timing (a report then lists each frame's graph steps) and writes a trace into
    /// `state/profile/trace-1.json` whose digest it answers.
    #[test]
    #[ignore = "needs the host GPU: run with --ignored metal"]
    fn metal_profile_summary_nodes_and_trace_through_the_verb() {
        use genex_core::digest::{fnv1a64, hex64};
        let Some(mut run) = run_of(game(Projection::Perspective, 6.0)) else { return };
        run.game.profiling().start(true);
        let dir = scratch("profile");
        // A run's save root ends in its separator (`GENEX_STATE_DIR`), as the trace folder expects.
        let mut studio = Studio::native(&format!("{}/", dir.to_str().expect("utf-8 path")));
        studio.mark_ready();
        for _ in 0..130 {
            run.live_frame(one_frame());
        }
        let state = call(&mut studio, &mut run, "state", "{}");
        let profile = &state["result"]["volatile"]["profile"];
        assert_eq!(profile["on"], json::Value::Bool(true), "{profile:?}");
        assert!(profile["cpu"]["p50"].as_f64() > 0.0, "{profile:?}");
        let top: Vec<&str> = profile["top"].items().iter().map(|row| row["scope"].as_str()).collect();
        assert!(top.contains(&"frame") || top.contains(&"tick"), "{top:?}");
        let summary = call(&mut studio, &mut run, "profile", r#"{"action":"summary"}"#);
        assert_eq!(summary["result"]["v"].as_f64(), 1.0, "{summary:?}");
        let armed = call(&mut studio, &mut run, "profile", r#"{"action":"arm","mode":"nodes"}"#);
        assert_eq!(armed["result"]["mode"].as_str(), "nodes", "{armed:?}");
        let offers = run.presenter.gpu().device.features().contains(wgpu::Features::TIMESTAMP_QUERY);
        for _ in 0..12 {
            run.live_frame(one_frame());
            let _ = run.presenter.gpu().device.poll(wgpu::PollType::wait_indefinitely());
        }
        let report = call(&mut studio, &mut run, "profile", r#"{"action":"report","frames":12}"#);
        assert_eq!(report["result"]["v"].as_f64(), 2.0, "{report:?}");
        let nodes: Vec<&str> = report["result"]["frames"].items().iter().flat_map(|frame| frame["gpu"].items().iter().map(|node| node["node"].as_str())).collect();
        eprintln!("prof5 report: {} frames, gpu nodes {:?}, timestamps offered {offers}", report["result"]["frames"].items().len(), nodes);
        assert_eq!(report["result"]["frames"].items().len(), 12, "the report's window");
        assert!(report["result"]["frames"].items().iter().all(|frame| frame["gpuMs"].as_f64() > 0.0 || !offers), "each frame's GPU time: {report:?}");
        let armed_summary = call(&mut studio, &mut run, "profile", r#"{"action":"summary"}"#);
        assert_eq!(armed_summary["result"]["nodes"].as_str(), "armed", "{armed_summary:?}");
        // The immediate frame's graph steps are bracketed on a device that offers timestamps.
        assert!(!nodes.is_empty() || !offers, "armed nodes land in the report");
        let trace = call(&mut studio, &mut run, "profile", r#"{"action":"trace","frames":12}"#);
        assert_eq!(trace["result"]["seq"].as_f64(), 1.0, "{trace:?}");
        let written = std::fs::read(dir.join("profile").join("trace-1.json")).expect("state/profile/trace-1.json");
        assert_eq!(trace["result"]["digest"].as_str(), hex64(fnv1a64(&written)), "the answered digest is the file's");
        assert!(serde_json::from_slice::<serde_json::Value>(&written).is_ok(), "a Chrome trace is JSON");
    }

    /// C-18: `reloadAssets` through the verb swaps a changed texture into the running game and the
    /// capture in the same tick shows only the new bytes; a stale digest, a missing file and an
    /// unsafe path are refused per file; a reload still pending behind a lost device answers `busy`.
    #[test]
    #[ignore = "needs the host GPU: run with --ignored metal"]
    fn metal_reload_assets_swaps_a_changed_texture_into_the_next_capture() {
        use genex_core::digest::{fnv1a64, hex64};
        let png = |rgb: [u8; 3]| {
            let mut image = Vec::new();
            {
                let mut encoder = png_writer(&mut image);
                encoder.write(rgb);
            }
            image
        };
        let dir = scratch("reload");
        let assets = dir.join("assets");
        std::fs::create_dir_all(assets.join("textures")).expect("assets folder");
        let bark = assets.join("textures").join("bark.png");
        std::fs::write(&bark, png([220, 30, 30])).expect("red bark");
        let mut game = Game::new(World::default()).world_size(96, 64);
        game.camera(|_| Camera::look_at(vec3(0.0, 0.0, 1.6), Vec3::ZERO));
        game.on_draw(|_, frame, _| {
            frame.cube_with(Transform::IDENTITY, &Material::color(Color::WHITE).with_base_texture("textures/bark.png"));
        });
        let presenter = match Presenter::open_with_root([96, 64], &[], Some(assets.clone())) {
            Ok(presenter) => presenter,
            Err(error) if required() => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
            Err(_) => return,
        };
        let runtime = Box::leak(Box::new(Runtime::new(game).expect("installs")));
        let mut run = studio_run(runtime, presenter, Live::from_env(&|_| None), &|_| {});
        let mut studio = studio(&dir.join("state"));
        call(&mut studio, &mut run, "pause", "{}");
        let red = call(&mut studio, &mut run, "capture", "{}");
        let blue = png([30, 30, 220]);
        std::fs::write(&bark, &blue).expect("blue bark");
        let digest = hex64(fnv1a64(&blue));
        let arg = format!(
            r#"{{"files":[{{"path":"textures/bark.png","digest":"{digest}"}},{{"path":"textures/bark.png","digest":"0000000000000000"}},{{"path":"textures/none.png","digest":"{digest}"}},{{"path":"../bark.png","digest":"{digest}"}}]}}"#
        );
        let reloaded = call(&mut studio, &mut run, "reloadAssets", &arg);
        assert_eq!(reloaded["ok"], json::Value::Bool(true), "{reloaded:?}");
        let result = &reloaded["result"];
        let paths: Vec<&str> = result["reloaded"].items().iter().map(json::Value::as_str).collect();
        assert_eq!(paths, ["textures/bark.png"]);
        let refused: Vec<(&str, &str)> = result["refused"].items().iter().map(|r| (r["path"].as_str(), r["code"].as_str())).collect();
        assert_eq!(refused, [("../bark.png", "unsafe-path"), ("textures/bark.png", "digest-mismatch"), ("textures/none.png", "missing")]);
        assert_eq!(result["pending"].as_f64(), 0.0, "drawn at once, paused or not");
        let swapped = call(&mut studio, &mut run, "capture", "{}");
        assert_ne!(swapped["result"]["digest"], red["result"]["digest"], "the next capture shows the new bytes: {swapped:?}");
        // The same capture as a fresh run on the blue bark: nothing of the red one is left.
        let fresh_dir = scratch("reload-fresh");
        let fresh_assets = fresh_dir.join("assets");
        std::fs::create_dir_all(fresh_assets.join("textures")).expect("assets folder");
        std::fs::write(fresh_assets.join("textures").join("bark.png"), &blue).expect("blue bark");
        let mut fresh_game = Game::new(World::default()).world_size(96, 64);
        fresh_game.camera(|_| Camera::look_at(vec3(0.0, 0.0, 1.6), Vec3::ZERO));
        fresh_game.on_draw(|_, frame, _| {
            frame.cube_with(Transform::IDENTITY, &Material::color(Color::WHITE).with_base_texture("textures/bark.png"));
        });
        let fresh_presenter = Presenter::open_with_root([96, 64], &[], Some(fresh_assets)).expect("a second presenter");
        let fresh_runtime = Box::leak(Box::new(Runtime::new(fresh_game).expect("installs")));
        let mut fresh = studio_run(fresh_runtime, fresh_presenter, Live::from_env(&|_| None), &|_| {});
        let mut fresh_studio = self::studio(&fresh_dir.join("state"));
        call(&mut fresh_studio, &mut fresh, "pause", "{}");
        let expected = call(&mut fresh_studio, &mut fresh, "capture", "{}");
        assert_eq!(swapped["result"]["digest"], expected["result"]["digest"], "not a mix of old and new");
        // Behind a lost device the reload stays pending, and another answers busy until it loads.
        run.presenter.resilient.force_device_loss();
        let lost = call(&mut studio, &mut run, "reloadAssets", &format!(r#"{{"files":[{{"path":"textures/bark.png","digest":"{digest}"}}]}}"#));
        assert_eq!(lost["result"]["pending"].as_f64(), 1.0, "{lost:?}");
        let busy = call(&mut studio, &mut run, "reloadAssets", &format!(r#"{{"files":[{{"path":"textures/bark.png","digest":"{digest}"}}]}}"#));
        assert_eq!(busy["error"].as_str(), "busy", "{busy:?}");
        assert!(run.recover(), "the device is re-created");
        let after = call(&mut studio, &mut run, "capture", "{}");
        assert_eq!(after["result"]["digest"], expected["result"]["digest"], "{after:?}");
        let again = call(&mut studio, &mut run, "reloadAssets", &format!(r#"{{"files":[{{"path":"textures/bark.png","digest":"{digest}"}}]}}"#));
        assert_eq!(again["ok"], json::Value::Bool(true), "pending again 0 after the recovery's frame: {again:?}");
    }

    /// A one-colour 8 x 8 PNG writer (stored deflate) for the reload row.
    struct PngWriter<'a> {
        out: &'a mut Vec<u8>,
    }

    fn png_writer(out: &mut Vec<u8>) -> PngWriter<'_> {
        PngWriter { out }
    }

    impl PngWriter<'_> {
        fn write(&mut self, rgb: [u8; 3]) {
            const SIDE: u32 = 8;
            let crc = |bytes: &[u8]| {
                let mut crc = 0xffff_ffffu32;
                for byte in bytes {
                    crc ^= u32::from(*byte);
                    for _ in 0..8 {
                        crc = if crc & 1 == 1 { 0xedb8_8320 ^ (crc >> 1) } else { crc >> 1 };
                    }
                }
                !crc
            };
            let row: Vec<u8> = std::iter::once(0).chain([rgb[0], rgb[1], rgb[2], 255].repeat(SIDE as usize)).collect();
            let raw = row.repeat(SIDE as usize);
            let (mut a, mut b) = (1u32, 0u32);
            for byte in &raw {
                a = (a + u32::from(*byte)) % 65_521;
                b = (b + a) % 65_521;
            }
            let mut zlib = vec![0x78, 0x01, 1];
            zlib.extend((raw.len() as u16).to_le_bytes());
            zlib.extend((!(raw.len() as u16)).to_le_bytes());
            zlib.extend(&raw);
            zlib.extend(((b << 16) | a).to_be_bytes());
            let mut header = Vec::new();
            header.extend(SIDE.to_be_bytes());
            header.extend(SIDE.to_be_bytes());
            header.extend([8, 6, 0, 0, 0]);
            self.out.extend([0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
            for (kind, data) in [(b"IHDR", header), (b"IDAT", zlib), (b"IEND", Vec::new())] {
                self.out.extend((data.len() as u32).to_be_bytes());
                let mut body = kind.to_vec();
                body.extend(&data);
                self.out.extend(&body);
                self.out.extend(crc(&body).to_be_bytes());
            }
        }
    }

    /// AU-7: `audioLevel` answers the Rust game's own mix (the tone it plays), not the silence
    /// genex-studio's default answers; `audio({muted})` silences only the device, so the level
    /// still reads the mix.
    #[test]
    #[ignore = "needs the host GPU: run with --ignored metal"]
    fn metal_audio_level_answers_the_games_mix_and_a_mute_leaves_it() {
        let assets: AssetTable = Box::leak(Box::new([("sfx/tone.wav", crate::audio::test_tone_wav())]));
        #[derive(Default)]
        struct Tone {
            sound: Option<crate::audio::Sound>,
            played: bool,
        }
        let mut game = Game::new(Tone::default()).world_size(96, 64);
        game.on_reset(|sim, _, _, gfx| sim.world.sound = Some(gfx.sound("sfx/tone.wav")));
        game.on_update(|sim, ctx| {
            if let Some(sound) = sim.world.sound.as_ref().filter(|_| !sim.world.played) {
                ctx.audio.play(sound);
            }
            sim.world.played = true;
        });
        let Some(presenter) = presenter(required()) else { return };
        let runtime = Box::leak(Box::new(Runtime::with_assets(game, Box::new(assets)).expect("installs")));
        let mut run = studio_run(runtime, presenter, Live::from_env(&|_| None), &|_| {});
        let mut studio = studio(&scratch("audio"));
        call(&mut studio, &mut run, "seed", r#"{"seed":1}"#);
        call(&mut studio, &mut run, "step", r#"{"ms":167}"#);
        let level = call(&mut studio, &mut run, "audioLevel", "{}");
        let rms = level["result"]["rms"].as_f64();
        assert!((rms - 0.0886).abs() < 0.005, "the tone's level, not silence: {level:?}");
        let muted = call(&mut studio, &mut run, "audio", r#"{"muted":true}"#);
        assert_eq!(muted["result"]["muted"], json::Value::Bool(true), "{muted:?}");
        call(&mut studio, &mut run, "step", r#"{"ms":17}"#);
        let after = call(&mut studio, &mut run, "audioLevel", "{}");
        assert!(after["result"]["rms"].as_f64() > 0.05, "the meter reads the mix under the mute: {after:?}");
        let state = call(&mut studio, &mut run, "state", "{}");
        assert_eq!(state["result"]["volatile"]["audio"]["device"]["muted"], json::Value::Bool(true), "{state:?}");
    }
}
