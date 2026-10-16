//! The verbs, ported from the C++ template's `studio.cpp`: the request envelope (byte for byte
//! what genex-core's golden-checked `Dispatcher` answers), every v1 op against a [`StudioGame`],
//! the capture file contract and the `ready` event; contract v2's `ready` (protocol 2 and the
//! capability receipt) and `state()` (`lifecycle`, `safeArea`); an embedded run's ring ops
//! (`surface`, `release`, `frames.h`'s semantics), served only by a game that can embed; and
//! `renderSettings`, which every flavour serves and a game answers through
//! [`StudioGame::render_settings`] (typed `unavailable` for a game without render settings).
//! A capture is drawn through [`StudioGame::render_for_capture`] (the game's pinned capture
//! settings, settled: K re-renders of the held frame on a capture-owned history, so Live's
//! history never resets) and its reply carries their `render` provenance
//! ([`StudioGame::capture_provenance`]: preset, class, source, scale, `settleFrames`,
//! `historyReset`, `exposure`).
//! [`spell_change`], [`render_answer_value`], [`render_status_value`] and
//! [`capture_provenance_value`] carry the renderer's values across by their wire spellings, so a
//! game's runtime (native or web) never re-declares the wire's shapes.

use std::fs;

use genex_core::clock::FIXED_STEP_MS;
use genex_core::digest::{fnv1a64, hex64};
use genex_core::input::{Injection, parse_injection};
use genex_core::json::Value as JsonValue;
use genex_core::json::{self, ParseError, Value};
use genex_core::paths;
use genex_core::protocol::{self, Answer, Event, MAX_DEPTH, NextLine, PROTOCOL_VERSION, Refusal};
use genex_core::session::{AudioLevel, CONTRACT_VERSION, StepResult, Timings};

use crate::transport::Transport;
use crate::wire::{
    self, CONTRACT_VERSION_V2, CaptureExposure, CaptureProvenance, Degrade, DegradeReason, DeviceClass, Lifecycle,
    PROTOCOL_VERSION as PROTOCOL_V2, QualityPreset, Receipt, RenderFeature, RenderSettingsAnswer, RenderSettingsChange,
    RenderSettingsRefusal, RenderStatus, SafeArea, SettingsArgError, SettingsSource, SurfaceArgs, parse_release,
    parse_render_settings, parse_surface, ring_point_to_world,
};

/// The ops this runtime answers. Wire values shared with the host: never rename one.
#[derive(Clone, Copy, Debug)]
pub struct Op;

impl Op {
    /// Reset the world on a seed and pause.
    pub const SEED: &'static str = "seed";
    /// Resume live play.
    pub const START: &'static str = "start";
    /// Freeze live play.
    pub const PAUSE: &'static str = "pause";
    /// Run `ms` of simulation, running or not.
    pub const STEP: &'static str = "step";
    /// The `state()` snapshot.
    pub const STATE: &'static str = "state";
    /// Inject input for the next tick.
    pub const INPUT: &'static str = "input";
    /// Draw and read the frame back.
    pub const CAPTURE: &'static str = "capture";
    /// Place a named camera or eye.
    pub const DEBUG_CAMERA: &'static str = "debugCamera";
    /// The named cameras.
    pub const CAMERAS: &'static str = "cameras";
    /// The player eyes.
    pub const EYES: &'static str = "eyes";
    /// The demo names.
    pub const DEMOS: &'static str = "demos";
    /// Run one demo.
    pub const DEMO: &'static str = "demo";
    /// Mute or unmute.
    pub const AUDIO: &'static str = "audio";
    /// The mixed output's level (native only).
    pub const AUDIO_LEVEL: &'static str = "audioLevel";
    /// Frame timings (native only).
    pub const TIMING: &'static str = "timing";
    /// End the game with exit 0 (native only).
    pub const QUIT: &'static str = "quit";
    /// Raise the window (native only).
    pub const FRONT: &'static str = "front";
    /// Show or hide a window run (native only).
    pub const VISIBLE: &'static str = "visible";
    /// Make the embedded run's ring of shared surfaces (a game that can embed only).
    pub const SURFACE: &'static str = wire::OP_SURFACE;
    /// Give a ring slot back to the game (a game that can embed only).
    pub const RELEASE: &'static str = wire::OP_RELEASE;
    /// Read or change the renderer's quality (every flavour; `unavailable` until a game serves it).
    pub const RENDER_SETTINGS: &'static str = wire::OP_RENDER_SETTINGS;
    /// The ops only a game that can embed in Live serves; any other answers them `unknown-op`
    /// and never lists them, which the host reads as a game made before embedding.
    pub const EMBEDDING: [&'static str; 2] = [Op::SURFACE, Op::RELEASE];
    /// The ops every build serves, the web export's whole set: `studio.cpp`'s, in the order it
    /// registers them, then `renderSettings`, which no C++ game has.
    pub const SHARED: [&'static str; 14] = [
        Op::SEED,
        Op::START,
        Op::PAUSE,
        Op::STEP,
        Op::STATE,
        Op::INPUT,
        Op::CAPTURE,
        Op::DEBUG_CAMERA,
        Op::CAMERAS,
        Op::EYES,
        Op::DEMOS,
        Op::DEMO,
        Op::AUDIO,
        Op::RENDER_SETTINGS,
    ];
    /// Every op a native run serves ([`Op::SHARED`], then `registerNativeVerbs`' five), in the
    /// order `studio.cpp` registers them.
    pub const ALL: [&'static str; 19] = [
        Op::SEED,
        Op::START,
        Op::PAUSE,
        Op::STEP,
        Op::STATE,
        Op::INPUT,
        Op::CAPTURE,
        Op::DEBUG_CAMERA,
        Op::CAMERAS,
        Op::EYES,
        Op::DEMOS,
        Op::DEMO,
        Op::AUDIO,
        Op::RENDER_SETTINGS,
        Op::AUDIO_LEVEL,
        Op::TIMING,
        Op::QUIT,
        Op::FRONT,
        Op::VISIBLE,
    ];
}

/// Why a verb was refused (`{ok:false, error}`). Wire values: never rename one.
#[derive(Clone, Copy, Debug)]
pub struct VerbRefusal;

impl VerbRefusal {
    /// `capture` named a camera the game does not have.
    pub const UNKNOWN_CAMERA: &'static str = "unknown-camera";
    /// `seed` or `step` while the game ticks or draws.
    pub const BUSY: &'static str = "busy";
    /// No trustworthy `GENEX_STATE_DIR`: captures have nowhere to go.
    pub const NO_STATE_DIR: &'static str = "no-state-dir";
    /// The frame could not be read back or written.
    pub const CAPTURE_FAILED: &'static str = "capture-failed";
    /// The frame is larger than the host takes (`NATIVE_CAPTURE_MAX_PX` a side): nothing is
    /// written. The host's own refusal for an oversize capture, `NativeRefusal.CaptureTooLarge`.
    pub const CAPTURE_TOO_LARGE: &'static str = "capture-too-large";
    /// A call before the game began: the web build's refusal (`{id:null, ok:false, op:null}`, as
    /// `webCall` answers). A native run never sends it: lines that arrive before `ready` stay
    /// queued and are answered after it, as v1's transport does.
    pub const STARTING: &'static str = "starting";
    /// A `surface` or `release` argument outside its shape: nothing was made or freed. Also a
    /// `capture` `size` outside its shape or a game that draws its world size only: nothing drawn.
    pub const BAD_ARGUMENT: &'static str = "bad-argument";
    /// A `surface` generation no newer than the last one asked for.
    pub const STALE_GENERATION: &'static str = "stale-generation";
    /// No frames service to send to: not an embedded run, or not this run's service.
    pub const NO_FRAMES_SERVICE: &'static str = "no-frames-service";
    /// The ring's surfaces or their GPU bindings could not be made; no ring until the next `surface`.
    pub const SURFACE_FAILED: &'static str = "surface-failed";
}

/// Why a game could not make the ring `surface` asked for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RingFault {
    /// No frames service (not an embedded run, or the name is not this run's).
    NoService,
    /// The surfaces or their GPU bindings could not be made.
    Failed,
}

/// Why a native game is about to exit abnormally (`fatal.reason`).
#[derive(Clone, Copy, Debug)]
pub struct FatalReason;

impl FatalReason {
    /// The window (or the GPU surface) did not open.
    pub const WINDOW_FAILED: &'static str = "window-failed";
    /// A panic.
    pub const TERMINATE: &'static str = "terminate";
}

/// The pixel layout of a capture file (`NATIVE_CAPTURE_FORMAT`). Wire value.
pub const CAPTURE_FORMAT: &str = "bgra8";
/// Capture files a run keeps: the host reads each when its answer arrives and never deletes in
/// `state/` while the game runs, so the game drops the oldest. Eight, not one: a capture still
/// being read is never the one removed.
pub const CAPTURES_KEPT: u32 = 8;
/// The longest side a capture may have (`NATIVE_CAPTURE_MAX_PX`).
pub const CAPTURE_MAX_PX: u32 = 4096;
/// The most bytes one capture file may hold (`NATIVE_CAPTURE_MAX_BYTES`).
pub const CAPTURE_MAX_BYTES: u64 = CAPTURE_MAX_PX as u64 * CAPTURE_MAX_PX as u64 * 4;
/// The camera name that gives the view back to the game.
pub const DEFAULT_CAMERA: &str = "default";
/// The value range `seed(n)` takes, as JavaScript's `n >>> 0` does.
const SEED_RANGE: f64 = 4_294_967_296.0;
/// `audioLevel` reports rms to four decimals and the centroid in whole hertz.
const RMS_SCALE: f64 = 10_000.0;
/// Timings are reported to a microsecond.
const TIMING_SCALE: f64 = 1000.0;

/// A frame read back for a capture: BGRA, top row first, opaque.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pixels {
    /// Width in pixels.
    pub width: u32,
    /// Height in pixels.
    pub height: u32,
    /// `width * height * 4` bytes.
    pub bgra: Vec<u8>,
}

/// Why a game could not read its frame back.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaptureFault {
    /// The readback failed (`capture-failed`).
    Readback,
    /// The frame was not drawn, so there is nothing current to read: the renderer's typed code
    /// (`device-lost` while the device is re-created, `upload-budget`, `mesh-invalid`, ...), which
    /// the `capture` verb answers as is.
    Refused(&'static str),
}

/// What the studio drives: the runtime behind a game (the facade's `Runtime`, a shell, a test
/// double). Every method runs on the thread that serves the studio, between frames.
pub trait StudioGame {
    /// Rebuild the world on `seed` (meters and HUD reset too), paused, input cleared.
    fn seed(&mut self, seed: u32);
    /// Resume live play; answers `running`.
    fn start(&mut self) -> bool;
    /// Freeze live play; answers `running` (false).
    fn pause(&mut self) -> bool;
    /// Run `max(1, round(ms / step))` ticks, running or not.
    fn step(&mut self, ms: f64) -> StepResult;
    /// One tick, in milliseconds: what `step` without an argument runs.
    fn step_ms(&self) -> f64 {
        FIXED_STEP_MS
    }
    /// The `state()` snapshot, reporting `camera` as the active view.
    fn state(&mut self, camera: &str) -> Value;
    /// Apply injected input for the next tick; answers the keys now held.
    fn inject(&mut self, injection: &Injection) -> Vec<String>;
    /// Draw from the named camera or eye, or the game's own view for None; false (and nothing
    /// changed) for a name the game does not have.
    fn view(&mut self, name: Option<&str>) -> bool;
    /// The named observer cameras, in registration order.
    fn cameras(&self) -> Vec<String> {
        Vec::new()
    }
    /// The player eyes, in registration order.
    fn eyes(&self) -> Vec<String> {
        Vec::new()
    }
    /// The demos, in registration order.
    fn demos(&self) -> Vec<String> {
        Vec::new()
    }
    /// Run demo `name` (one of [`StudioGame::demos`]); answers what its checks read.
    fn run_demo(&mut self, _name: &str) -> Value {
        Value::Null
    }
    /// Draw the frame now, where it can be shown.
    fn render(&mut self);
    /// Draw calls the last frame made.
    fn draw_calls(&self) -> u32 {
        0
    }
    /// The fixed world target's size.
    fn world_size(&self) -> [u32; 2];
    /// The frame just drawn, read back.
    fn capture(&mut self) -> Result<Pixels, CaptureFault>;
    /// Whether the game is inside a tick or a draw: `seed` and `step` are refused `busy` then.
    fn busy(&self) -> bool {
        false
    }
    /// Mute or unmute the master volume.
    fn set_muted(&mut self, _muted: bool) {}
    /// The mixed output's level.
    fn audio_level(&self) -> AudioLevel {
        AudioLevel::default()
    }
    /// Frame timings.
    fn timings(&self) -> Timings {
        Timings::default()
    }
    /// Raise the window; false for a headless run.
    fn front(&mut self) -> bool {
        false
    }
    /// Show or hide a window run; answers whether it is shown.
    fn set_visible(&mut self, visible: bool) -> bool {
        visible
    }
    /// `quit` arrived: close the window after this frame.
    fn request_quit(&mut self) {}
    /// Whether this build can embed in Live (a Mac headless dev build): only then are `surface`
    /// and `release` served.
    fn embeddable(&self) -> bool {
        false
    }
    /// Replace the ring with `ring`'s (fresh slots, none held); its first frame goes out at the
    /// next present.
    fn make_ring(&mut self, _ring: &SurfaceArgs) -> Result<(), RingFault> {
        Err(RingFault::NoService)
    }
    /// The studio gave slot `slot` of the current ring generation back.
    fn release_slot(&mut self, _generation: u32, _slot: u32) {}
    /// Where the app is in its life (`state().lifecycle` for a protocol 2 game).
    fn lifecycle(&self) -> Lifecycle {
        Lifecycle::Resumed
    }
    /// The screen's safe-area insets (`state().safeArea` for a protocol 2 game).
    fn safe_area(&self) -> SafeArea {
        SafeArea::default()
    }
    /// `renderSettings`: apply `change` (None reads) and answer the settings in force
    /// (`wire::RenderSettingsAnswer::to_value`), or the typed refusal. A game that does not serve
    /// the verb answers `unavailable`, and its receipt does not advertise `renderSettingsApi`.
    fn render_settings(&mut self, _change: Option<&RenderSettingsChange>) -> Result<Value, RenderSettingsRefusal> {
        Err(RenderSettingsRefusal::Unavailable)
    }
    /// Draw the frame `capture` reads: a game with render settings draws its pinned capture
    /// profile (no person override, no dynamic resolution) as a settled capture, K re-renders on
    /// a capture-owned history that leave Live's history as it was; by default the Live frame.
    fn render_for_capture(&mut self) {
        self.render();
    }
    /// The capture reply's `render` provenance ([`capture_provenance_value`]); None for a game
    /// without render settings, whose reply has no `render` member.
    fn capture_provenance(&self) -> Option<Value> {
        None
    }
    /// Draw the next captures at `size` (`capture`'s `size` argument: the 4K/1440p plan), or at
    /// the world size again (None). Answers whether the game can: one that draws its world size
    /// only refuses a size (`bad-argument`).
    fn set_capture_size(&mut self, size: Option<[u32; 2]>) -> bool {
        size.is_none()
    }
}

/// `capture`'s `size` argument (`{width, height}`, whole pixels within the world target's limits
/// and [`CAPTURE_MAX_PX`]): `Ok(None)` when absent or null, `Err` for anything else (a string, a
/// fraction, a side out of range, a missing side).
fn capture_size(arg: &Value) -> Result<Option<[u32; 2]>, ()> {
    let size = match arg {
        Value::Object(_) => arg.get("size").unwrap_or(&Value::Null),
        _ => &Value::Null,
    };
    if size.is_null() {
        return Ok(None);
    }
    let side = |key: &str| -> Result<u32, ()> {
        let Some(Value::Number(n)) = size.get(key) else { return Err(()) };
        let whole = n.fract() == 0.0 && *n >= f64::from(protocol::MIN_WORLD_PX) && *n <= f64::from(CAPTURE_MAX_PX);
        if whole { Ok(*n as u32) } else { Err(()) }
    };
    Ok(Some([side("width")?, side("height")?]))
}

/// A `renderSettings` change by its wire spellings (what a game's runtime reads it in).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SpelledChange {
    /// The preset (`auto` included); `Some(None)` gives the game's and the person's choice back.
    pub preset: Option<Option<&'static str>>,
    /// `Some(Some(class))` emulates a class, `Some(None)` gives the probed class back.
    pub device_class: Option<Option<&'static str>>,
    /// Feature switches, in order.
    pub features: Vec<(&'static str, bool)>,
    /// Whether the switches the verb set earlier are given back first.
    pub reset_features: bool,
    /// `Some(Some(scale))` holds the render scale, `Some(None)` releases it.
    pub render_scale_lock: Option<Option<f64>>,
    /// `Some(Some(ms))` is the frame time dynamic resolution holds, `Some(None)` gives the class's back.
    pub frame_budget_ms: Option<Option<f64>>,
}

/// `change` by its wire spellings.
pub fn spell_change(change: &RenderSettingsChange) -> SpelledChange {
    SpelledChange {
        preset: change.preset.map(|preset| preset.map(QualityPreset::wire)),
        device_class: change.device_class.map(|class| class.map(DeviceClass::wire)),
        features: change.features.iter().map(|(feature, on)| (feature.wire(), *on)).collect(),
        reset_features: change.reset_features,
        render_scale_lock: change.render_scale_lock,
        frame_budget_ms: change.frame_budget_ms,
    }
}

fn spelled_features(features: &[(&str, bool)]) -> Option<Vec<(RenderFeature, bool)>> {
    features.iter().map(|(name, on)| RenderFeature::from_wire(name).map(|feature| (feature, *on))).collect()
}

/// The settings in force as a game's runtime spells them (the `renderSettings` answer).
#[derive(Clone, Debug, PartialEq)]
pub struct SpelledAnswer<'a> {
    /// The effective preset.
    pub preset: &'a str,
    /// What was asked for (`auto` follows the class).
    pub requested: &'a str,
    /// The class in force.
    pub class: &'a str,
    /// What the probe found.
    pub detected: &'a str,
    /// The switches in force.
    pub features: &'a [(&'a str, bool)],
    /// The held render scale, if any.
    pub render_scale_lock: Option<f64>,
    /// The frame time dynamic resolution holds for the verb, if any.
    pub frame_budget_ms: Option<f64>,
    /// The last frame's render scale.
    pub scale: f64,
}

/// The settings a game spells, as the `renderSettings` answer; None when a spelling is outside
/// the wire's vocabulary (a runtime ahead of this contract).
pub fn render_answer_value(spelled: &SpelledAnswer<'_>) -> Option<Value> {
    let answer = RenderSettingsAnswer {
        preset: QualityPreset::from_wire(spelled.preset)?,
        requested: QualityPreset::from_wire(spelled.requested)?,
        device_class: DeviceClass::from_wire(spelled.class)?,
        detected_class: DeviceClass::from_wire(spelled.detected)?,
        features: spelled_features(spelled.features)?,
        render_scale_lock: spelled.render_scale_lock,
        frame_budget_ms: spelled.frame_budget_ms,
        scale: spelled.scale,
    };
    Some(answer.to_value())
}

/// What a game's renderer runs with, as `state().volatile.render`; None when a spelling is
/// outside the wire's vocabulary. `degraded` pairs a reason with what it concerns.
pub fn render_status_value(
    class: &str,
    preset: &str,
    scale: f64,
    features: &[(&str, bool)],
    degraded: &[(&str, Option<String>)],
    gpu_ms: Option<f64>,
    cpu_ms: Option<f64>,
) -> Option<Value> {
    let degraded = degraded
        .iter()
        .map(|(reason, subject)| Some(Degrade { reason: DegradeReason::from_wire(reason)?, subject: subject.clone() }))
        .collect::<Option<Vec<Degrade>>>()?;
    let status = RenderStatus {
        device_class: DeviceClass::from_wire(class)?,
        preset: QualityPreset::from_wire(preset)?,
        scale,
        features: spelled_features(features)?,
        degraded,
        gpu_ms,
        cpu_ms,
        frames: None,
    };
    Some(status.to_value())
}

/// A capture's pinned settings, as its reply's `render` provenance: the re-renders it settled
/// over (`settleFrames`, 1..=`CAPTURE_SETTLE_FRAMES_MAX`), whether its history started empty
/// (always, on the capture's own history) and its exposure (instant: no adaptation history);
/// None when a spelling is outside the wire's vocabulary.
pub fn capture_provenance_value(preset: &str, class: &str, source: &str, scale: f64, settle_frames: u32, history_reset: bool) -> Option<Value> {
    let provenance = CaptureProvenance {
        preset: QualityPreset::from_wire(preset)?,
        device_class: DeviceClass::from_wire(class)?,
        settings_source: SettingsSource::from_wire(source)?,
        scale,
        settle_frames,
        history_reset,
        exposure: CaptureExposure::Instant,
    };
    Some(provenance.to_value())
}

/// What one `serve` pass did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Served {
    /// Lines answered.
    pub answered: usize,
    /// The studio closed the connection: the game should close and exit 0.
    pub ended: bool,
}

/// What `ready` says about the build.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReadyInfo {
    /// The build's name (`genex-rust/<os>/<mode>`).
    pub build: String,
    /// The graphics path (`NativeBackend`; a diagnostic, the host's gate decides).
    pub backend_api: String,
    /// The GPU's name, when known.
    pub device: Option<String>,
    /// The world target's size.
    pub size: [u32; 2],
    /// The seed the game began on.
    pub seed: u32,
    /// The capability receipt: a contract v2 game states protocol 2 and carries it; None keeps
    /// the protocol 1 `ready`.
    pub receipt: Option<Receipt>,
}

/// The studio's side of one game: the envelope, the verbs and what they keep between calls.
#[derive(Clone, Debug)]
pub struct Studio {
    /// The save root captures go under, ending in its separator; "" for none.
    save_root: String,
    /// Captures are files (a native run); the web shell reads the canvas instead.
    files: bool,
    /// The ops this flavour serves: [`Op::ALL`] natively, [`Op::SHARED`] on the web.
    ops: &'static [&'static str],
    ready: bool,
    closing: bool,
    captures: u32,
    camera: String,
    muted: bool,
    /// The protocol `ready` stated: 1, or 2 with the receipt.
    protocol: u32,
    /// The newest ring generation asked for, made or not.
    asked_generation: u32,
    /// The ring made last, while one is open.
    ring: Option<SurfaceArgs>,
}

/// `{id, ok:false, op, error, available?}` as a line.
fn refusal_line(id: &Value, op: &Value, error: &str, available: Option<Vec<String>>) -> Vec<u8> {
    let mut reply = Value::object();
    reply.set("id", id.clone());
    reply.set("ok", Value::Bool(false));
    reply.set("op", op.clone());
    reply.set("error", Value::from(error));
    if let Some(available) = available {
        let mut ops = Value::array();
        for name in available {
            ops.push(Value::from(name));
        }
        reply.set("available", ops);
    }
    reply.dump()
}

/// `{id, ok:true, op, result}` as a line.
fn result_line(id: &Value, op: &Value, result: Value) -> Vec<u8> {
    let mut reply = Value::object();
    reply.set("id", id.clone());
    reply.set("ok", Value::Bool(true));
    reply.set("op", op.clone());
    reply.set("result", result);
    reply.dump()
}

/// `n` as JavaScript's `n >>> 0` reads it: truncated, wrapped into 0..2^32-1; NaN and infinities are 0.
fn seed_of(n: f64) -> u32 {
    if !n.is_finite() {
        return 0;
    }
    let mut wrapped = n.trunc() % SEED_RANGE;
    if wrapped < 0.0 {
        wrapped += SEED_RANGE;
    }
    // In [0, 2^32) after the wrap.
    wrapped as u32
}

/// An argument given as `{key: value}` or as the bare value.
fn argument<'a>(arg: &'a Value, key: &str) -> &'a Value {
    if matches!(arg, Value::Object(_)) { &arg[key] } else { arg }
}

fn names(list: impl IntoIterator<Item = String>) -> Value {
    let mut out = Value::array();
    for name in list {
        out.push(Value::from(name));
    }
    out
}

fn object(members: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    let mut out = Value::object();
    for (key, value) in members {
        out.set(key, value);
    }
    out
}

/// `{ok:false, available}`: what `debugCamera` and `demo` answer for a name the game lacks.
fn unavailable(available: Value) -> Answer {
    Answer::Result(object([("ok", Value::Bool(false)), ("available", available)]))
}

fn sorted(ops: &[&str]) -> Vec<String> {
    let mut available: Vec<String> = ops.iter().map(|name| (*name).to_owned()).collect();
    available.sort();
    available
}

/// Where a world of `world` pixels lands in a `ring` (scaled to fit, centred): x, y, width, height.
fn letterbox(world: [u32; 2], ring: &SurfaceArgs) -> [f64; 4] {
    let (ring_w, ring_h) = (f64::from(ring.width), f64::from(ring.height));
    let (world_w, world_h) = (f64::from(world[0]), f64::from(world[1]));
    if world_w <= 0.0 || world_h <= 0.0 {
        return [0.0, 0.0, 0.0, 0.0];
    }
    let scale = (ring_w / world_w).min(ring_h / world_h);
    let (width, height) = (world_w * scale, world_h * scale);
    [(ring_w - width) / 2.0, (ring_h - height) / 2.0, width, height]
}

/// A position along `extent` from `origin` as a fraction in [0, 1]; no number reads as the middle.
fn fraction(value: &Value, origin: f64, extent: f64) -> f64 {
    let number = match value {
        Value::Number(number) if number.is_finite() => *number,
        _ => return 0.5,
    };
    if extent > 0.0 { ((number - origin) / extent).clamp(0.0, 1.0) } else { 0.5 }
}

/// One position Live gave in ring pixels (`px: true`), with `px` gone: a touch in world pixels
/// (`wire::ring_point_to_world`), anything else as fractions of the letterboxed frame.
fn in_frame(position: &Value, ring: &SurfaceArgs, world: [u32; 2]) -> Value {
    if !matches!(position, Value::Object(_)) || !position["px"].as_bool() {
        return position.clone();
    }
    let touch = position["type"].as_str() == wire::INPUT_TOUCH;
    let [x, y, width, height] = letterbox(world, ring);
    let number = |key: &str| position[key].as_f64_or(f64::NAN);
    let world_point =
        ring_point_to_world((number("x"), number("y")), (ring.width, ring.height), (world[0], world[1]));
    let mut mapped = Value::object();
    for (key, value) in position.members() {
        match key.as_slice() {
            b"px" => {}
            b"x" if touch => _ = mapped.set("x", Value::from(world_point.0)),
            b"y" if touch => _ = mapped.set("y", Value::from(world_point.1)),
            b"x" => _ = mapped.set("x", Value::from(fraction(value, x, width))),
            b"y" => _ = mapped.set("y", Value::from(fraction(value, y, height))),
            _ => _ = mapped.set(key.clone(), value.clone()),
        }
    }
    mapped
}

/// An `input` argument with every position Live gave in ring pixels mapped into the frame
/// (`frames.h` `ringInput`).
fn ring_input(arg: &Value, ring: &SurfaceArgs, world: [u32; 2]) -> JsonValue {
    if !matches!(arg, Value::Object(_)) {
        return arg.clone();
    }
    let mut mapped = Value::object();
    for (key, value) in arg.members() {
        match key.as_slice() {
            b"pointer" => _ = mapped.set(key.clone(), in_frame(value, ring, world)),
            b"actions" if matches!(value, Value::Array(_)) => {
                let mut actions = Value::array();
                for action in value.items() {
                    actions.push(in_frame(action, ring, world));
                }
                mapped.set(key.clone(), actions);
            }
            _ => _ = mapped.set(key.clone(), value.clone()),
        }
    }
    mapped
}

fn refuse(error: &str) -> Answer {
    Answer::Refused(error.to_owned())
}

fn rounded(value: f64, scale: f64) -> f64 {
    (value * scale).round() / scale
}

impl Studio {
    fn new(save_root: String, files: bool, ops: &'static [&'static str]) -> Studio {
        Studio {
            save_root,
            files,
            ops,
            ready: false,
            closing: false,
            captures: 0,
            camera: DEFAULT_CAMERA.to_owned(),
            muted: false,
            protocol: PROTOCOL_VERSION,
            asked_generation: 0,
            ring: None,
        }
    }

    /// A native run's studio: captures are written under `save_root` (the run's `state/`, ending
    /// in its separator; "" or an untrustworthy root refuses them `no-state-dir`).
    pub fn native(save_root: &str) -> Studio {
        Studio::new(save_root.to_owned(), true, &Op::ALL)
    }

    /// A native run's studio over the process environment's `GENEX_STATE_DIR`.
    pub fn for_run(env: &dyn Fn(&str) -> Option<String>) -> Studio {
        let identity = paths::GameIdentity { name: "", bundle_id: "" };
        let root = paths::save_root(paths::Destination::GenexRun, env, identity).unwrap_or_default();
        Studio::native(&root)
    }

    /// The web build's studio: the shared ops only; a capture describes the frame and the shell
    /// reads the canvas.
    pub fn web() -> Studio {
        Studio::new(String::new(), false, &Op::SHARED)
    }

    /// The ops this studio serves, in registration order.
    pub fn ops(&self) -> &'static [&'static str] {
        self.ops
    }

    /// The game began: verbs are answered from now on. Before, [`Studio::serve`] leaves the
    /// studio's lines queued and [`Studio::handle`] answers the web build's `starting`.
    pub fn mark_ready(&mut self) {
        self.ready = true;
    }

    /// Send `ready` ([`Studio::ready_line`] with the transport's nonce) and begin answering
    /// verbs as the protocol it states; false when the studio is gone.
    pub fn announce_ready(&mut self, link: &Transport, info: &ReadyInfo) -> bool {
        self.mark_ready();
        self.set_protocol(if info.receipt.is_some() { PROTOCOL_V2 } else { PROTOCOL_VERSION });
        link.send(&Studio::ready_line(link.nonce(), info))
    }

    /// The `ready` event line: the nonce, the protocol, the build, the backend, the frame and the
    /// seed; with a receipt, protocol 2, contract v2, `backend` naming the receipt's backend and
    /// adapter, and the `receipt` itself (`wire::ready_fields`).
    pub fn ready_line(nonce: &str, info: &ReadyInfo) -> Vec<u8> {
        let device = info.device.as_deref().map_or(Value::Null, Value::from);
        let size = object([("width", Value::from(info.size[0])), ("height", Value::from(info.size[1]))]);
        let mut fields = Value::object();
        fields.set("nonce", Value::from(nonce));
        fields.set("protocol", Value::from(PROTOCOL_VERSION));
        fields.set("contractVersion", Value::from(CONTRACT_VERSION));
        fields.set("build", Value::from(info.build.as_str()));
        fields.set("backend", object([("api", Value::from(info.backend_api.as_str())), ("device", device)]));
        fields.set("size", size);
        fields.set("seed", Value::from(info.seed));
        if let Some(receipt) = &info.receipt {
            for (key, value) in wire::ready_fields(receipt) {
                fields.set(key, value);
            }
        }
        protocol::event(Event::READY, &fields)
    }

    /// Answer as protocol `version` speaks (1, or 2: `state()` carries `lifecycle` and
    /// `safeArea`). [`Studio::announce_ready`] sets it from the receipt.
    pub fn set_protocol(&mut self, version: u32) {
        self.protocol = version;
    }

    /// The protocol this studio answers as.
    pub fn protocol(&self) -> u32 {
        self.protocol
    }

    /// The open ring Live takes frames from, if any.
    pub fn ring(&self) -> Option<&SurfaceArgs> {
        self.ring.as_ref()
    }

    /// Forget the ring (the frames service is gone, or the game is closing).
    pub fn end_ring(&mut self) {
        self.ring = None;
    }

    /// The game re-created its lost GPU device: Live's ring went with the old one, so it is
    /// forgotten here (a `release` of its slots finds nothing) and the studio is told, which
    /// announces a new generation with the next `surface`.
    pub fn device_restored(&mut self, link: &Transport) -> bool {
        self.ring = None;
        link.send(&protocol::event(Event::DEVICE_RESTORED, &Value::object()))
    }

    /// Before `ready`: tell the studio a boot step finished and the game is still starting (it
    /// gives the ready deadline again from here, up to its cap). Nothing once ready: answers
    /// whether it was sent.
    pub fn still_starting(&self, link: &Transport) -> bool {
        !self.ready && link.send(&protocol::event(Event::STARTING, &Value::object()))
    }

    /// [`Studio::still_starting`] naming where the boot is (`{stage, done?, total?}`), which Live
    /// shows while it waits (owner decision D11). Nothing once ready: answers whether it was sent.
    pub fn starting_at(&self, link: &Transport, progress: protocol::BootProgress) -> bool {
        !self.ready && link.send(&protocol::event(Event::STARTING, &progress.fields()))
    }

    /// Tell the studio the game is about to exit abnormally.
    pub fn send_fatal(link: &Transport, reason: &str) -> bool {
        link.send(&protocol::event(Event::FATAL, &object([("reason", Value::from(reason))])))
    }

    /// Whether `quit` or the studio's end of file asked the game to close (exit 0).
    pub fn closing(&self) -> bool {
        self.closing
    }

    /// The active camera's name.
    pub fn camera(&self) -> &str {
        &self.camera
    }

    /// Answer everything the transport queued, in order; the studio's end sets [`Studio::closing`].
    /// Before `ready` nothing is taken: the requests wait in the queue and are answered, in order,
    /// by the first pass after [`Studio::announce_ready`] (v1's transport, `studio.cpp`).
    pub fn serve<G: StudioGame>(&mut self, link: &Transport, game: &mut G) -> Served {
        let mut served = Served::default();
        if !self.ready {
            return served;
        }
        for item in link.take() {
            match item {
                NextLine::Line(line) => {
                    link.send(&self.handle(game, &line));
                    served.answered += 1;
                }
                NextLine::TooLong => {
                    link.send(&self.line_too_long());
                    served.answered += 1;
                }
                NextLine::End => served.ended = true,
            }
        }
        if served.ended {
            self.closing = true;
        }
        served
    }

    /// The reply line to a request the framing dropped for its length.
    pub fn line_too_long(&self) -> Vec<u8> {
        refusal_line(&Value::Null, &Value::Null, Refusal::LINE_TOO_LONG, None)
    }

    /// The reply line (no newline) to one request line.
    pub fn handle<G: StudioGame>(&mut self, game: &mut G, line: &[u8]) -> Vec<u8> {
        if !self.ready {
            // `webCall` before `begun`: the call is not parsed, so neither id nor op is echoed.
            return refusal_line(&Value::Null, &Value::Null, VerbRefusal::STARTING, None);
        }
        let request = match json::parse_with_depth(line, MAX_DEPTH) {
            Ok(request) => request,
            Err(error) => {
                let why = if error == ParseError::TooDeep { Refusal::TOO_DEEP } else { Refusal::BAD_JSON };
                return refusal_line(&Value::Null, &Value::Null, why, None);
            }
        };
        if !matches!(request, Value::Object(_)) {
            return refusal_line(&Value::Null, &Value::Null, Refusal::NOT_AN_OBJECT, None);
        }
        let op = &request["op"];
        let named = if matches!(op, Value::String(_)) { op.clone() } else { Value::Null };
        let Some(id) = request.get("id").filter(|id| matches!(id, Value::Number(_) | Value::String(_))) else {
            return refusal_line(&Value::Null, &named, Refusal::MISSING_ID, None);
        };
        let served = self.served(game);
        let known = served.iter().find(|name| name.as_bytes() == op.as_bytes() && matches!(op, Value::String(_)));
        let Some(&op_name) = known else {
            return refusal_line(id, &named, Refusal::UNKNOWN_OP, Some(sorted(&served)));
        };
        match self.answer(game, op_name, &request["arg"]) {
            Answer::Result(result) => result_line(id, &named, result),
            Answer::Refused(error) => refusal_line(id, &named, &error, None),
        }
    }

    /// The web transport's call (`webCall` over genex-core's `Dispatcher::call`): one op and its
    /// argument, answered `{id:null, ok, op, result}` or `{id:null, ok:false, op, error,
    /// available?}`; before the game began, `starting` with `op:null`.
    pub fn call<G: StudioGame>(&mut self, game: &mut G, op: &str, arg: &Value) -> Vec<u8> {
        if !self.ready {
            return refusal_line(&Value::Null, &Value::Null, VerbRefusal::STARTING, None);
        }
        let named = Value::from(op);
        let served = self.served(game);
        let Some(&op_name) = served.iter().find(|name| **name == op) else {
            return refusal_line(&Value::Null, &named, Refusal::UNKNOWN_OP, Some(sorted(&served)));
        };
        match self.answer(game, op_name, arg) {
            Answer::Result(result) => result_line(&Value::Null, &named, result),
            Answer::Refused(error) => refusal_line(&Value::Null, &named, &error, None),
        }
    }

    /// The ops this flavour serves to `game`: the embedding ops only natively, to a game that can
    /// embed.
    fn served<G: StudioGame>(&self, game: &G) -> Vec<&'static str> {
        let mut ops = self.ops.to_vec();
        if self.files && game.embeddable() {
            ops.extend(Op::EMBEDDING);
        }
        ops
    }

    fn answer<G: StudioGame>(&mut self, game: &mut G, op: &str, arg: &Value) -> Answer {
        match op {
            Op::SEED => self.seed(game, arg),
            Op::START => Answer::Result(object([("running", Value::from(game.start()))])),
            Op::PAUSE => Answer::Result(object([("running", Value::from(game.pause()))])),
            Op::STEP => Studio::step(game, arg),
            Op::STATE => self.state(game),
            Op::INPUT => self.input(game, arg),
            Op::SURFACE => self.surface(game, arg),
            Op::RELEASE => self.release(game, arg),
            Op::CAPTURE => self.capture(game, arg),
            Op::DEBUG_CAMERA => self.debug_camera(game, arg),
            Op::CAMERAS => Answer::Result(object([("cameras", names(self.camera_names(game)))])),
            Op::EYES => Answer::Result(object([("eyes", names(game.eyes()))])),
            Op::DEMOS => Answer::Result(object([("demos", names(game.demos()))])),
            Op::DEMO => Studio::demo(game, arg),
            Op::AUDIO => self.audio(game, arg),
            Op::AUDIO_LEVEL => Studio::audio_level(game),
            Op::TIMING => Studio::timing(game),
            Op::QUIT => self.quit(game),
            Op::FRONT => Answer::Result(object([("fronted", Value::from(game.front()))])),
            Op::VISIBLE => {
                let visible = game.set_visible(argument(arg, "visible").as_bool_or(true));
                Answer::Result(object([("visible", Value::from(visible))]))
            }
            Op::RENDER_SETTINGS => Studio::render_settings(game, arg),
            // `handle` routes only the ops in this flavour's set here.
            _ => refuse(Refusal::UNKNOWN_OP),
        }
    }

    /// `renderSettings`: the argument checked here, the settings the game's.
    fn render_settings<G: StudioGame>(game: &mut G, arg: &Value) -> Answer {
        let change = match parse_render_settings(arg) {
            Ok(change) => change,
            Err(SettingsArgError::Refused(refusal)) => return refuse(refusal.wire()),
            Err(SettingsArgError::Bad(_)) => return refuse(VerbRefusal::BAD_ARGUMENT),
        };
        match game.render_settings(change.as_ref()) {
            Ok(answer) => Answer::Result(answer),
            Err(refusal) => refuse(refusal.wire()),
        }
    }

    fn camera_names<G: StudioGame>(&self, game: &G) -> Vec<String> {
        let mut list = vec![DEFAULT_CAMERA.to_owned()];
        list.extend(game.cameras());
        list
    }

    /// Place a named camera or eye ("default" or "" gives the view back); false for an unknown name.
    fn place<G: StudioGame>(&mut self, game: &mut G, name: &str) -> bool {
        if name.is_empty() || name == DEFAULT_CAMERA {
            game.view(None);
            DEFAULT_CAMERA.clone_into(&mut self.camera);
            return true;
        }
        if !game.view(Some(name)) {
            return false;
        }
        name.clone_into(&mut self.camera);
        true
    }

    fn seed<G: StudioGame>(&mut self, game: &mut G, arg: &Value) -> Answer {
        if game.busy() {
            return refuse(VerbRefusal::BUSY);
        }
        let seed = seed_of(argument(arg, "seed").as_f64_or(0.0));
        game.seed(seed);
        game.render();
        Answer::Result(object([("seed", Value::from(seed)), ("paused", Value::Bool(true))]))
    }

    fn step<G: StudioGame>(game: &mut G, arg: &Value) -> Answer {
        if game.busy() {
            return refuse(VerbRefusal::BUSY);
        }
        let step = game.step(argument(arg, "ms").as_f64_or(game.step_ms()));
        game.render();
        Answer::Result(object([
            ("frame", Value::from(step.frame)),
            ("simulatedMs", Value::from(step.simulated_ms)),
            ("steppedFrames", Value::from(step.ticks)),
            ("drawCalls", Value::from(game.draw_calls())),
        ]))
    }

    fn state<G: StudioGame>(&self, game: &mut G) -> Answer {
        let mut state = game.state(&self.camera);
        if self.protocol == PROTOCOL_V2 && matches!(state, Value::Object(_)) {
            state.set("contractVersion", Value::from(CONTRACT_VERSION_V2));
            wire::set_state_v2(&mut state, game.lifecycle(), game.safe_area());
        }
        Answer::Result(state)
    }

    fn input<G: StudioGame>(&self, game: &mut G, arg: &Value) -> Answer {
        // With a ring, Live gives positions in ring pixels (`frames::input`).
        let mapped = self.ring.map(|ring| ring_input(arg, &ring, game.world_size()));
        let injection = parse_injection(mapped.as_ref().unwrap_or(arg));
        let held = game.inject(&injection);
        Answer::Result(object([("held", names(held)), ("ignored", Value::from(injection.ignored))]))
    }

    /// `surface`: a new generation replaces the ring (`frames.h` `Ring::surface`).
    fn surface<G: StudioGame>(&mut self, game: &mut G, arg: &Value) -> Answer {
        let Ok(ring) = parse_surface(arg) else { return refuse(VerbRefusal::BAD_ARGUMENT) };
        if ring.generation <= self.asked_generation {
            return refuse(VerbRefusal::STALE_GENERATION);
        }
        self.asked_generation = ring.generation;
        self.ring = None;
        match game.make_ring(&ring) {
            Ok(()) => {}
            Err(RingFault::NoService) => return refuse(VerbRefusal::NO_FRAMES_SERVICE),
            Err(RingFault::Failed) => return refuse(VerbRefusal::SURFACE_FAILED),
        }
        self.ring = Some(ring);
        Answer::Result(object([
            ("generation", Value::from(ring.generation)),
            ("width", Value::from(ring.width)),
            ("height", Value::from(ring.height)),
            ("slots", Value::from(ring.slots)),
        ]))
    }

    /// `release`: a slot of the current generation goes back to the game; any other is ignored.
    fn release<G: StudioGame>(&mut self, game: &mut G, arg: &Value) -> Answer {
        let Ok(release) = parse_release(arg) else { return refuse(VerbRefusal::BAD_ARGUMENT) };
        let current = self.ring.is_some_and(|ring| ring.generation == release.generation && release.slot < ring.slots);
        if current {
            game.release_slot(release.generation, release.slot);
        }
        Answer::Result(Value::object())
    }

    fn debug_camera<G: StudioGame>(&mut self, game: &mut G, arg: &Value) -> Answer {
        let name = argument(arg, "camera").as_str().to_owned();
        if !self.place(game, &name) {
            return unavailable(names(self.camera_names(game)));
        }
        game.render();
        Answer::Result(object([("ok", Value::Bool(true)), ("camera", Value::from(self.camera.as_str()))]))
    }

    fn demo<G: StudioGame>(game: &mut G, arg: &Value) -> Answer {
        let name = argument(arg, "name").as_str().to_owned();
        if !game.demos().contains(&name) {
            return unavailable(names(game.demos()));
        }
        game.pause();
        let outcome = game.run_demo(&name);
        game.pause(); // a demo ends paused, whatever it did
        game.render();
        Answer::Result(object([("ok", Value::Bool(true)), ("demo", Value::from(name)), ("result", outcome)]))
    }

    fn audio<G: StudioGame>(&mut self, game: &mut G, arg: &Value) -> Answer {
        self.muted = argument(arg, "muted").as_bool_or(self.muted);
        game.set_muted(self.muted);
        Answer::Result(object([("muted", Value::from(self.muted))]))
    }

    fn audio_level<G: StudioGame>(game: &G) -> Answer {
        let level = game.audio_level();
        Answer::Result(object([
            ("rms", Value::from(rounded(level.rms, RMS_SCALE))),
            ("centroid", Value::from(level.centroid.round())),
        ]))
    }

    fn timing<G: StudioGame>(game: &G) -> Answer {
        let timings = game.timings();
        Answer::Result(object([
            ("frameMs", Value::from(rounded(timings.frame_ms, TIMING_SCALE))),
            ("updateMs", Value::from(rounded(timings.update_ms, TIMING_SCALE))),
            ("drawMs", Value::from(rounded(timings.draw_ms, TIMING_SCALE))),
            ("frames", Value::from(timings.frames)),
        ]))
    }

    /// Answer, then end the loop after this frame; the process exits 0.
    fn quit<G: StudioGame>(&mut self, game: &mut G) -> Answer {
        self.closing = true;
        game.request_quit();
        Answer::Result(object([("quitting", Value::Bool(true))]))
    }

    /// Draw the frame (from `camera` when one is named) and describe it; a native run writes the file.
    fn capture<G: StudioGame>(&mut self, game: &mut G, arg: &Value) -> Answer {
        let camera = argument(arg, "camera");
        let Ok(size) = capture_size(arg) else { return refuse(VerbRefusal::BAD_ARGUMENT) };
        if matches!(camera, Value::String(_)) && !self.place(game, camera.as_str()) {
            return refuse(VerbRefusal::UNKNOWN_CAMERA);
        }
        if !game.set_capture_size(size) {
            return refuse(VerbRefusal::BAD_ARGUMENT);
        }
        let answer = self.capture_drawn(game);
        game.set_capture_size(None);
        answer
    }

    /// `capture` once its arguments are taken: draw, describe, write the file.
    fn capture_drawn<G: StudioGame>(&mut self, game: &mut G) -> Answer {
        game.render_for_capture();
        let [width, height] = game.world_size();
        let mut result = object([
            ("width", Value::from(width)),
            ("height", Value::from(height)),
            ("camera", Value::from(self.camera.as_str())),
            ("drawCalls", Value::from(game.draw_calls())),
        ]);
        if let Some(provenance) = game.capture_provenance() {
            result.set(wire::STATE_RENDER, provenance);
        }
        if !self.files {
            return Answer::Result(result);
        }
        self.capture_file(game, result)
    }

    /// Read the frame back into `<state>/captures/<seq>.bgra`; add its seq, size, format and
    /// digest. A refused capture writes nothing and takes no sequence number.
    fn capture_file<G: StudioGame>(&mut self, game: &mut G, mut result: Value) -> Answer {
        let folder = paths::capture_folder(&self.save_root);
        if folder.is_empty() {
            return refuse(VerbRefusal::NO_STATE_DIR);
        }
        let pixels = match game.capture() {
            Ok(pixels) => pixels,
            Err(CaptureFault::Refused(code)) => return refuse(code),
            Err(CaptureFault::Readback) => return refuse(VerbRefusal::CAPTURE_FAILED),
        };
        if pixels.width > CAPTURE_MAX_PX || pixels.height > CAPTURE_MAX_PX {
            return refuse(VerbRefusal::CAPTURE_TOO_LARGE);
        }
        let expected = u64::from(pixels.width) * u64::from(pixels.height) * 4;
        let whole = expected > 0 && pixels.bgra.len() as u64 == expected;
        if !whole || fs::create_dir_all(&folder).is_err() {
            return refuse(VerbRefusal::CAPTURE_FAILED);
        }
        let seq = self.captures + 1;
        if fs::write(paths::capture_path(&self.save_root, seq), &pixels.bgra).is_err() {
            return refuse(VerbRefusal::CAPTURE_FAILED);
        }
        self.captures = seq;
        if seq > CAPTURES_KEPT {
            // Already gone is fine: the host never deletes there, and nothing else reads it.
            let _ = fs::remove_file(paths::capture_path(&self.save_root, seq - CAPTURES_KEPT));
        }
        result.set("seq", Value::from(seq));
        result.set("width", Value::from(pixels.width));
        result.set("height", Value::from(pixels.height));
        result.set("format", Value::from(CAPTURE_FORMAT));
        result.set("digest", Value::from(hex64(fnv1a64(&pixels.bgra))));
        Answer::Result(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_capture_s_provenance_names_the_re_renders_it_settled_over() {
        let settled = capture_provenance_value("high", "desktop-high", "reference-class", 1.0, 2, true).expect("known spellings");
        assert_eq!(settled["settleFrames"].as_f64(), 2.0);
        assert_eq!(settled["historyReset"], Value::Bool(true));
        assert_eq!(settled["exposure"].as_str(), "instant");
        assert_eq!(settled["preset"].as_str(), "high");
        let bounds = |frames| capture_provenance_value("low", "mobile-mid", "verb", 0.5, frames, true).expect("known spellings")["settleFrames"].as_f64();
        assert_eq!(bounds(0), 1.0, "at least one re-render");
        assert_eq!(bounds(1000), f64::from(wire::CAPTURE_SETTLE_FRAMES_MAX), "at most the wire's cap");
        assert!(capture_provenance_value("epic", "desktop-high", "verb", 1.0, 1, true).is_none(), "an unknown preset has no provenance");
    }
}
