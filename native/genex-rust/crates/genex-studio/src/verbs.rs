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
//! The dev flavour's `profile` verb (game systems PROF-4) checks its argument
//! ([`wire::parse_profile`]) and hands the game a typed request ([`StudioGame::profile`],
//! `unavailable` by default); a `trace` answer is written by the studio into the run's
//! `state/profile/trace-<seq>.json` with its size and digest, as captures are.
//! The dev flavour's `saves` and `uiSettings` verbs (G6 UIS-16) check their arguments as the host
//! does (`shared/game-saves.ts`: [`parse_saves`], [`parse_ui_settings`]; anything else refuses
//! `bad-argument` and the game is never asked) and hand the game a typed request
//! ([`StudioGame::saves`], [`StudioGame::ui_settings`], `unavailable` by default).
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
    PROTOCOL_VERSION as PROTOCOL_V2, ProfileRequest, QualityPreset, Receipt, RenderFeature, RenderSettingsAnswer, RenderSettingsChange,
    RenderSettingsRefusal, RenderStatus, SafeArea, SettingsArgError, SettingsSource, SurfaceArgs, parse_release,
    parse_profile, parse_render_settings, parse_surface, ring_point_to_world,
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
    /// Run one bake the game registered (dev flavour; NAV-14 and LOD-23 serve it).
    pub const BAKE_ASSETS: &'static str = wire::OP_BAKE_ASSETS;
    /// Swap changed asset files in a running dev game (dev flavour; [`StudioGame::reload_assets`]).
    pub const RELOAD_ASSETS: &'static str = wire::OP_RELOAD_ASSETS;
    /// Read the game's frame profile (dev flavour; PROF-5 serves it, `unavailable` until then).
    pub const PROFILE: &'static str = wire::OP_PROFILE;
    /// List, read, write, save, load or delete the game's save slots (dev flavour, UIS-16).
    pub const SAVES: &'static str = "saves";
    /// A session layer over the gameplay UI's settings (dev flavour, UIS-16).
    pub const UI_SETTINGS: &'static str = "uiSettings";
    /// The game-data ops only a native run serves (UIS-16): the web flavour, which an export
    /// serves too, answers each `unknown-op` and never lists it.
    pub const GAME_DATA: [&'static str; 2] = [Op::SAVES, Op::UI_SETTINGS];
    /// The asset tools a native run (only the dev flavour links the studio natively) knows (a game
    /// that does not serve one answers `unavailable`); the web flavour, which an export serves too,
    /// answers them `unknown-op` and never lists them (CONTRACT.md).
    pub const ASSET_TOOLS: [&'static str; 2] = [Op::BAKE_ASSETS, Op::RELOAD_ASSETS];
    /// Every op only a native run serves on top of [`Op::ALL`] (the dev flavour: an export never
    /// links the studio natively): the asset tools, then `profile`. The web flavour, which an
    /// export serves too, answers each `unknown-op` and never lists it.
    pub const DEV_TOOLS: [&'static str; 3] = [Op::BAKE_ASSETS, Op::RELOAD_ASSETS, Op::PROFILE];
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
    /// A verb the game knows but this build cannot serve yet ([`Op::ASSET_TOOLS`] before their
    /// runtime lands); the spelling `renderSettings` shares.
    pub const UNAVAILABLE: &'static str = RenderSettingsRefusal::Unavailable.wire();
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
/// Trace files a run keeps under `state/profile/`: the host copies each when its answer arrives and
/// never deletes in `state/` while the game runs, so the game drops the oldest (as captures).
pub const TRACES_KEPT: u32 = 8;
/// The folder under the state root traces go in, and a trace file's name around its sequence number.
const PROFILE_DIR: &str = "profile";
const TRACE_PREFIX: &str = "trace-";
const TRACE_EXTENSION: &str = ".json";
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

/// What a game answers a `profile` request with ([`StudioGame::profile`]).
#[derive(Clone, Debug, PartialEq)]
pub enum ProfileAnswer {
    /// The answer as is: the summary, the `ProfileReport` v2, or the arm's `{mode}`.
    Value(Value),
    /// A trace's Chrome trace JSON, which the studio writes into `state/profile/` and answers with
    /// its sequence number, size and digest.
    Trace(Vec<u8>),
}

/// The most files one `reloadAssets` names (`NATIVE_RELOAD_FILES_MAX`); a longer list is refused
/// `bad-argument` before any file is looked at.
pub const RELOAD_FILES_MAX: usize = 256;
/// A `reloadAssets` digest's spelling: FNV-1a 64 as 16 lowercase hex digits.
const RELOAD_DIGEST_HEX_DIGITS: usize = 16;

/// Why `reloadAssets` refused one file (its answer's `refused[].code`, `ReloadRefusal`). Wire
/// values: never rename one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReloadRefusal {
    /// The path breaks the asset-path rule (refused by the studio; the game never reads it).
    UnsafePath,
    /// The bytes the game's source serves now do not have the digest the host named.
    DigestMismatch,
    /// Nothing is there.
    Missing,
}

impl ReloadRefusal {
    /// Every refusal, in the host's order.
    pub const ALL: [ReloadRefusal; 3] = [ReloadRefusal::UnsafePath, ReloadRefusal::DigestMismatch, ReloadRefusal::Missing];

    /// The wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            ReloadRefusal::UnsafePath => "unsafe-path",
            ReloadRefusal::DigestMismatch => "digest-mismatch",
            ReloadRefusal::Missing => "missing",
        }
    }
}

/// One file a `reloadAssets` names: its asset path and the FNV-1a 64 of the new bytes the host
/// wrote there.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReloadFile {
    /// The `/`-separated path under `assets/`.
    pub path: String,
    /// The FNV-1a 64 of its new bytes.
    pub digest: u64,
}

/// What a game did with the files of a `reloadAssets` ([`StudioGame::reload_assets`]).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ReloadOutcome {
    /// The paths dropped from the renderer to be read again, in request order.
    pub reloaded: Vec<String>,
    /// The paths left as they were, with why.
    pub refused: Vec<(String, ReloadRefusal)>,
    /// Reloads not finished yet (a frame has not loaded them); a settled capture waits for 0.
    pub pending: u32,
}

/// 16 lowercase hex digits as a u64.
fn reload_digest(text: &str) -> Option<u64> {
    let hex = text.len() == RELOAD_DIGEST_HEX_DIGITS && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if !hex {
        return None;
    }
    u64::from_str_radix(text, 16).ok()
}

/// A `reloadAssets` argument: `{files: [{path, digest}]}`, at most [`RELOAD_FILES_MAX`] files, each
/// path a string and each digest 16 lowercase hex digits, in request order. A path's safety is
/// not judged here (the studio refuses an unsafe one per file); unknown members are ignored.
pub fn parse_reload(arg: &Value) -> Result<Vec<ReloadFile>, wire::BadField> {
    if !matches!(arg, Value::Object(_)) {
        return Err(wire::BadField("arg"));
    }
    let Some(files @ Value::Array(_)) = arg.get("files") else { return Err(wire::BadField("files")) };
    if files.items().len() > RELOAD_FILES_MAX {
        return Err(wire::BadField("files"));
    }
    files
        .items()
        .iter()
        .map(|file| {
            let (Some(Value::String(_)), Some(Value::String(_))) = (file.get("path"), file.get("digest")) else {
                return Err(wire::BadField("files"));
            };
            let digest = reload_digest(file["digest"].as_str()).ok_or(wire::BadField("digest"))?;
            Ok(ReloadFile { path: file["path"].as_str().to_owned(), digest })
        })
        .collect()
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
    /// `reloadAssets`: re-read each of `files` (every path already under the asset-path rule) from
    /// the game's source, refuse one that is missing or whose bytes are not its digest, drop what
    /// the renderer holds of the rest and draw again, answering what is still pending. A game still
    /// applying an earlier reload answers `busy`; one that does not serve the verb `unavailable`.
    fn reload_assets(&mut self, _files: &[ReloadFile]) -> Result<ReloadOutcome, &'static str> {
        Err(VerbRefusal::UNAVAILABLE)
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
    /// Draw the next captures with what `lens` asks of the look's depth of field and motion blur
    /// (`capture`'s `lens` argument, renderer pass 2 A.9), or with neither again (the default).
    /// Answers whether the game can: one without render settings refuses an ask (`bad-argument`).
    fn set_capture_lens(&mut self, lens: CaptureLens) -> bool {
        lens == CaptureLens::default()
    }
    /// `profile` (dev flavour): answer `request` (checked: a known action, frames clamped, `arm`
    /// with a mode), or refuse it with a wire code. A game that serves no profiles answers
    /// `unavailable`. Display only: nothing a tick computes depends on what this answers.
    fn profile(&mut self, _request: &ProfileRequest) -> Result<ProfileAnswer, &'static str> {
        Err(VerbRefusal::UNAVAILABLE)
    }
    /// `saves` (dev flavour, UIS-16): serve `request` (checked by [`parse_saves`]) between ticks
    /// and answer its result, or refuse it with a wire code (`save-*`). A load answers once it
    /// applied. A game that serves no saves answers `unavailable`.
    fn saves(&mut self, _request: &SavesRequest) -> Result<Value, &'static str> {
        Err(VerbRefusal::UNAVAILABLE)
    }
    /// `uiSettings` (dev flavour, UIS-16): apply `change` (checked by [`parse_ui_settings`]) as the
    /// session layer from the next tick and answer the layer in force, or refuse it with a wire
    /// code (`text-locale-unknown`, `bad-argument`). A game that serves none answers `unavailable`.
    fn ui_settings(&mut self, _change: &UiSettingsChange) -> Result<Value, &'static str> {
        Err(VerbRefusal::UNAVAILABLE)
    }
}

/// The longest slot name a `saves` call names (`SAVE_SLOT_NAME_MAX`, genex-save's `SLOT_NAME_MAX`).
pub const SAVE_SLOT_NAME_MAX: usize = 32;
/// The most characters a slot's label holds (`SAVE_LABEL_CHARS_MAX`).
pub const SAVE_LABEL_CHARS_MAX: usize = 64;
/// The most bytes of JSON an envelope a `saves` call carries or answers
/// (`NATIVE_SAVES_ENVELOPE_MAX_BYTES`: a 1 MiB line, less room for its own members).
pub const SAVES_ENVELOPE_MAX_BYTES: usize = 1024 * 1024 - 4 * 1024;
/// The longest locale tag (`UI_LOCALE_TAG_CHARS_MAX`).
pub const UI_LOCALE_TAG_CHARS_MAX: usize = 35;
/// The smallest UI scale and text size (`UI_SCALE_MIN`).
pub const UI_SCALE_MIN: f64 = 0.5;
/// The largest UI scale and text size (`UI_SCALE_MAX`).
pub const UI_SCALE_MAX: f64 = 3.0;
/// The largest safe-area inset, in world pixels (`UI_SAFE_AREA_MAX_PX`).
pub const UI_SAFE_AREA_MAX_PX: f64 = 4096.0;

/// What a `saves` call does (`SaveOp`). Wire values: never rename one.
#[derive(Clone, Copy, Debug)]
pub struct SaveOp;

impl SaveOp {
    /// The slots, their bytes and the quota.
    pub const LIST: &'static str = "list";
    /// One slot's envelope, or `{tooLarge, bytes, digest}`.
    pub const READ: &'static str = "read";
    /// Seed a slot with a fixture envelope.
    pub const WRITE: &'static str = "write";
    /// Save the running game into a slot.
    pub const SAVE: &'static str = "save";
    /// Load a slot, answered once applied.
    pub const LOAD: &'static str = "load";
    /// Delete a slot.
    pub const DELETE: &'static str = "delete";
}

/// A checked `saves` argument ([`parse_saves`]).
#[derive(Clone, Debug, PartialEq)]
pub enum SavesRequest {
    /// `{op: "list"}`.
    List,
    /// `{op: "read", slot}`.
    Read(String),
    /// `{op: "write", slot, envelope}`: the envelope as JSON bytes.
    Write(String, Vec<u8>),
    /// `{op: "save", slot, label?}`.
    Save(String, String),
    /// `{op: "load", slot}`.
    Load(String),
    /// `{op: "delete", slot}`.
    Delete(String),
}

/// Whether `slot` has a slot name's shape: lowercase letters, digits and dashes, not starting
/// with a dash, at most [`SAVE_SLOT_NAME_MAX`] bytes (the game refuses reserved names itself).
fn is_slot_name(slot: &str) -> bool {
    let shaped = slot.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    shaped && slot.len() <= SAVE_SLOT_NAME_MAX && !slot.is_empty() && !slot.starts_with('-')
}

/// `saves`' argument checked as `checkSavesArg` checks it: a known op, a slot name of a safe shape,
/// a label within its cap, a `write`'s envelope an object a line can carry; unknown members are
/// ignored.
pub fn parse_saves(arg: &Value) -> Result<SavesRequest, wire::BadField> {
    if !matches!(arg, Value::Object(_)) {
        return Err(wire::BadField("arg"));
    }
    let Some(Value::String(_)) = arg.get("op") else { return Err(wire::BadField("op")) };
    let op = arg["op"].as_str();
    if op == SaveOp::LIST {
        return Ok(SavesRequest::List);
    }
    let slot = match arg.get("slot") {
        Some(Value::String(_)) if is_slot_name(arg["slot"].as_str()) => arg["slot"].as_str().to_owned(),
        _ => return Err(wire::BadField("slot")),
    };
    match op {
        SaveOp::READ => Ok(SavesRequest::Read(slot)),
        SaveOp::LOAD => Ok(SavesRequest::Load(slot)),
        SaveOp::DELETE => Ok(SavesRequest::Delete(slot)),
        SaveOp::SAVE => match arg.get("label") {
            None => Ok(SavesRequest::Save(slot, String::new())),
            Some(Value::String(_)) if arg["label"].as_str().chars().count() <= SAVE_LABEL_CHARS_MAX => Ok(SavesRequest::Save(slot, arg["label"].as_str().to_owned())),
            Some(_) => Err(wire::BadField("label")),
        },
        SaveOp::WRITE => {
            let Some(envelope @ Value::Object(_)) = arg.get("envelope") else { return Err(wire::BadField("envelope")) };
            let bytes = envelope.dump();
            if bytes.len() > SAVES_ENVELOPE_MAX_BYTES {
                return Err(wire::BadField("envelope"));
            }
            Ok(SavesRequest::Write(slot, bytes))
        }
        _ => Err(wire::BadField("op")),
    }
}

/// One member of a `uiSettings` change: left out (kept), null (the game's own back), or a value.
#[derive(Clone, Debug, Default, PartialEq)]
pub enum UiMember<T> {
    /// Left out: the layer keeps what it had.
    #[default]
    Keep,
    /// `null`: the game's own value again.
    Reset,
    /// A new value.
    Set(T),
}

/// A checked `uiSettings` argument ([`parse_ui_settings`]): no member at all reads the layer.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct UiSettingsChange {
    /// A locale tag (the game refuses one it does not offer).
    pub locale: UiMember<String>,
    /// A UI scale in [`UI_SCALE_MIN`]..=[`UI_SCALE_MAX`].
    pub scale: UiMember<f64>,
    /// Safe-area insets `[left, top, right, bottom]` in world pixels.
    pub safe_area: UiMember<[f64; 4]>,
    /// A text size multiplier in [`UI_SCALE_MIN`]..=[`UI_SCALE_MAX`].
    pub text_size: UiMember<f64>,
}

/// Whether `tag` has a locale tag's shape: a 2 to 8 letter language subtag, then subtags of 1 to
/// 8 letters or digits joined by `-` or `_`, at most [`UI_LOCALE_TAG_CHARS_MAX`].
fn is_locale_tag(tag: &str) -> bool {
    let mut parts = tag.split(['-', '_']);
    let language = parts.next().unwrap_or_default();
    let first = (2..=8).contains(&language.len()) && language.bytes().all(|b| b.is_ascii_alphabetic());
    let rest = parts.all(|part| (1..=8).contains(&part.len()) && part.bytes().all(|b| b.is_ascii_alphanumeric()));
    tag.len() <= UI_LOCALE_TAG_CHARS_MAX && first && rest
}

/// A finite number within `range`.
fn number_within(value: &Value, range: std::ops::RangeInclusive<f64>) -> Option<f64> {
    let Value::Number(n) = value else { return None };
    (n.is_finite() && range.contains(n)).then_some(*n)
}

/// One `uiSettings` member: absent keeps, null resets, else `read` checks it.
fn ui_member<T>(arg: &Value, key: &'static str, read: impl Fn(&Value) -> Option<T>) -> Result<UiMember<T>, wire::BadField> {
    match arg.get(key) {
        None => Ok(UiMember::Keep),
        Some(Value::Null) => Ok(UiMember::Reset),
        Some(value) => read(value).map(UiMember::Set).ok_or(wire::BadField(key)),
    }
}

/// `uiSettings`' argument checked as `checkUiSettingsArg` checks it: none (or null) reads the
/// layer; otherwise each member given is null or in its shape and range.
pub fn parse_ui_settings(arg: &Value) -> Result<UiSettingsChange, wire::BadField> {
    if arg.is_null() {
        return Ok(UiSettingsChange::default());
    }
    if !matches!(arg, Value::Object(_)) {
        return Err(wire::BadField("arg"));
    }
    let scale_range = UI_SCALE_MIN..=UI_SCALE_MAX;
    let locale = ui_member(arg, "locale", |value| matches!(value, Value::String(_)).then(|| value.as_str()).filter(|tag| is_locale_tag(tag)).map(str::to_owned))?;
    let scale = ui_member(arg, "scale", |value| number_within(value, scale_range.clone()))?;
    let text_size = ui_member(arg, "textSize", |value| number_within(value, scale_range.clone()))?;
    let safe_area = ui_member(arg, "safeArea", |value| {
        let insets: Vec<f64> = value.items().iter().filter_map(|inset| number_within(inset, 0.0..=UI_SAFE_AREA_MAX_PX)).collect();
        let whole = matches!(value, Value::Array(_)) && value.items().len() == 4;
        whole.then(|| <[f64; 4]>::try_from(insets).ok()).flatten()
    })?;
    Ok(UiSettingsChange { locale, scale, safe_area, text_size })
}

/// What `capture`'s `lens` argument asks of the look (`NativeCaptureLens`): neither by default.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CaptureLens {
    /// `depthOfField`: draw the look's depth of field.
    pub depth_of_field: bool,
    /// `motionBlur`: draw the look's motion blur.
    pub motion_blur: bool,
}

/// `capture`'s `lens` argument (`{depthOfField?, motionBlur?}`, booleans): the default when absent
/// or null, `Err` for anything else (a string, a number, a switch that is not a boolean).
fn capture_lens(arg: &Value) -> Result<CaptureLens, ()> {
    let lens = match arg {
        Value::Object(_) => arg.get(wire::CAPTURE_LENS).unwrap_or(&Value::Null),
        _ => &Value::Null,
    };
    if lens.is_null() {
        return Ok(CaptureLens::default());
    }
    if !matches!(lens, Value::Object(_)) {
        return Err(());
    }
    let switch = |key: &str| match lens.get(key) {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Bool(on)) => Ok(*on),
        Some(_) => Err(()),
    };
    Ok(CaptureLens { depth_of_field: switch(wire::LENS_DEPTH_OF_FIELD)?, motion_blur: switch(wire::LENS_MOTION_BLUR)? })
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
    /// Traces written under `state/profile/`.
    traces: u32,
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
            traces: 0,
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
        if self.files {
            ops.extend(Op::DEV_TOOLS);
            ops.extend(Op::GAME_DATA);
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
            Op::BAKE_ASSETS => refuse(VerbRefusal::UNAVAILABLE),
            Op::RELOAD_ASSETS => Studio::reload_assets(game, arg),
            Op::PROFILE => self.profile(game, arg),
            Op::SAVES => Studio::saves(game, arg),
            Op::UI_SETTINGS => Studio::ui_settings(game, arg),
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

    /// `reloadAssets`: the argument checked here and every unsafe path refused here (the game
    /// never reads one), the rest the game's to re-read; refusals in request order.
    fn reload_assets<G: StudioGame>(game: &mut G, arg: &Value) -> Answer {
        let Ok(files) = parse_reload(arg) else { return refuse(VerbRefusal::BAD_ARGUMENT) };
        if game.busy() {
            return refuse(VerbRefusal::BUSY);
        }
        let (safe, unsafe_paths): (Vec<ReloadFile>, Vec<ReloadFile>) = files.into_iter().partition(|file| paths::is_safe_asset_path(&file.path));
        let outcome = match game.reload_assets(&safe) {
            Ok(outcome) => outcome,
            Err(code) => return refuse(code),
        };
        let unsafe_refusals = unsafe_paths.into_iter().map(|file| (file.path, ReloadRefusal::UnsafePath));
        let mut refused = Value::array();
        for (path, code) in unsafe_refusals.chain(outcome.refused) {
            refused.push(object([("path", Value::from(path)), ("code", Value::from(code.wire()))]));
        }
        Answer::Result(object([("reloaded", names(outcome.reloaded)), ("refused", refused), ("pending", Value::from(outcome.pending))]))
    }

    /// `saves`: the argument checked here, the slots the game's; refused while it ticks or draws.
    fn saves<G: StudioGame>(game: &mut G, arg: &Value) -> Answer {
        let Ok(request) = parse_saves(arg) else { return refuse(VerbRefusal::BAD_ARGUMENT) };
        if game.busy() {
            return refuse(VerbRefusal::BUSY);
        }
        match game.saves(&request) {
            Ok(result) => Answer::Result(result),
            Err(code) => refuse(code),
        }
    }

    /// `uiSettings`: the argument checked here, the layer the game's.
    fn ui_settings<G: StudioGame>(game: &mut G, arg: &Value) -> Answer {
        let Ok(change) = parse_ui_settings(arg) else { return refuse(VerbRefusal::BAD_ARGUMENT) };
        match game.ui_settings(&change) {
            Ok(result) => Answer::Result(result),
            Err(code) => refuse(code),
        }
    }

    /// `profile`: the argument checked here, the answer the game's; a trace is written here.
    fn profile<G: StudioGame>(&mut self, game: &mut G, arg: &Value) -> Answer {
        let Ok(request) = parse_profile(arg) else { return refuse(VerbRefusal::BAD_ARGUMENT) };
        let folder = self.profile_folder();
        // A trace with nowhere to go is refused before the game builds it.
        if request.action == wire::ProfileAction::Trace && folder.is_empty() {
            return refuse(VerbRefusal::NO_STATE_DIR);
        }
        match game.profile(&request) {
            Ok(ProfileAnswer::Value(value)) => Answer::Result(value),
            Ok(ProfileAnswer::Trace(bytes)) => self.trace_file(&folder, &bytes),
            Err(code) => refuse(code),
        }
    }

    /// `<state>/profile/`, beside `captures/`; "" where captures have nowhere to go either.
    fn profile_folder(&self) -> String {
        let captures = paths::capture_folder(&self.save_root);
        if captures.is_empty() {
            return String::new();
        }
        // `capture_folder` ends in the platform's separator (one ASCII byte); the trace folder does too.
        let separator = &captures[captures.len() - 1..];
        format!("{}{PROFILE_DIR}{separator}", self.save_root)
    }

    /// Write a trace into `<state>/profile/trace-<seq>.json` and answer its seq, size and digest;
    /// a failed write takes no sequence number and answers `no-state-dir`.
    fn trace_file(&mut self, folder: &str, bytes: &[u8]) -> Answer {
        let seq = self.traces + 1;
        let path = |n: u32| format!("{folder}{TRACE_PREFIX}{n}{TRACE_EXTENSION}");
        if fs::create_dir_all(folder).is_err() || fs::write(path(seq), bytes).is_err() {
            return refuse(VerbRefusal::NO_STATE_DIR);
        }
        self.traces = seq;
        if seq > TRACES_KEPT {
            // Already gone is fine: the host never deletes there, and nothing else reads it.
            let _ = fs::remove_file(path(seq - TRACES_KEPT));
        }
        Answer::Result(object([
            ("seq", Value::from(seq)),
            ("bytes", Value::from(bytes.len() as f64)),
            ("digest", Value::from(hex64(fnv1a64(bytes)))),
        ]))
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
        let Ok(lens) = capture_lens(arg) else { return refuse(VerbRefusal::BAD_ARGUMENT) };
        if matches!(camera, Value::String(_)) && !self.place(game, camera.as_str()) {
            return refuse(VerbRefusal::UNKNOWN_CAMERA);
        }
        if !game.set_capture_size(size) {
            return refuse(VerbRefusal::BAD_ARGUMENT);
        }
        if !game.set_capture_lens(lens) {
            game.set_capture_size(None);
            return refuse(VerbRefusal::BAD_ARGUMENT);
        }
        let answer = self.capture_drawn(game);
        game.set_capture_size(None);
        game.set_capture_lens(CaptureLens::default());
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
