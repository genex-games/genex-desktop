//! Settled captures and the history reset rules (RQ1.5, plan §2.7).
//!
//! # Two history sets
//!
//! Every node that carries state from one frame to the next (auto exposure today; sky LUTs, the IBL
//! bake, Hi-Z and visibility, AO and TAA history in later tiers) keeps it per [`HistorySet`]:
//! **Live**, which the player sees and which runs on across frames, and **Capture**, which a
//! capture owns. A capture never reads or writes Live's history, so Live neither resets nor pops
//! when the harness captures, and a capture is a pure function of (state, camera, pinned
//! settings, adapter, build) whatever Live drew before it.
//!
//! One exception is shared, not per set: the environment bake (the IBL cubes, SH9 and the sky's
//! LUTs, RQ2). A capture bakes it whole for its exact environment and sun, and Live binds that
//! bake afterwards: a Live frame after a capture can show a newer environment bake (a sun moved
//! by less than the rebake threshold, a rebake that had not finished) than the same Live sequence
//! without the capture. Captures stay reproducible; only Live's environment can be a refresh ahead.
//!
//! # Settled capture
//!
//! A capture re-renders the held frame (one Sim state) K times ([`settle_frames`]) on the Capture
//! set, with frame indices `0..K`: the set starts from its initial state ([`SettleHooks::settle_reset`]
//! with [`HistoryReset::Capture`]), every node that derives state over many frames brings it up to
//! date before each re-render ([`SettleHooks::settle_sync`]), exposure adapts instantly, and the
//! caller draws at the nominal dynamic-resolution step with the pinned profile. The last re-render
//! is the picture read back. K ([`settle_plan`], RQ5.4) is:
//! - the jitter cycle ([`crate::settings::TaaQuality::jitter_cycle`]: 8, or 16) when TAA is drawn
//!   on the HDR scene or AO keeps its own history: the re-renders walk every jitter position once
//!   from index 0 (the reset's), so TAA and AO accumulate one whole cycle and the frame-keyed
//!   noise (AO, PCSS, cascade dither) takes the same values on every capture;
//! - else [`AUTO_EXPOSURE_SETTLE_FRAMES`] with auto exposure on the HDR path (the exposure a frame
//!   meters reaches the picture on the next frame), [`GRADED_EXPOSURE_SETTLE_FRAMES`] when a
//!   game's `post-hdr` pass changes the scene before it is metered;
//! - else 1.
//!
//! What a capture's picture includes ([`SettlePlan`], the provenance's `settleFrames` and
//! `historyReset: true`): only its own K re-renders. Exposure ([`ExposureHistories`]) and TAA
//! ([`TaaHistories`]), motion and skinned history keep a history per set, so Live's are never
//! read, reset or advanced. AO draws on one set of targets: a capture starts its history over at
//! its first re-render, having put Live's aside, and Live's next frame takes it back
//! (`AoNode::stash_live`, RQ5 review), so Live's next frame is the one it would have drawn
//! without the capture. The sun's cascades all redraw on the Live frame after a capture (a far
//! cascade's cadence would keep a map the capture's camera drew). The environment bake is shared
//! as above. Dynamic resolution's step is Live's: the caller draws a capture at the nominal step,
//! so a scale step changes no capture.
//!
//! # Live history resets
//!
//! Live's frame index counts the frames drawn since its last reset, one per drawn frame whatever
//! sim ticks it ran (RQ5 review: keyed to ticks, a device rendering every second tick of the 60 Hz
//! sim walked only the odd Halton positions, a jitter covering half the pixel with a +0.19 px
//! bias). Adaptation (auto exposure) moves by the frame's ticks instead. It starts over on a
//! camera cut (explicit, or a jump [`camera_cut`] calls one), a resize, a dynamic-resolution step,
//! a pipeline-shaping quality change (a change of resource knobs only keeps every history), a
//! rewound tick (a reset or a load), and device re-creation (a re-created renderer starts with an
//! empty history). An exposure (look) change does not reset history: the pre-exposure ratio
//! carries it. Each node decides what a reason means for it: auto exposure snaps only on a new
//! shot or timeline ([`HistoryReset::resets_exposure`]) and keeps adapting smoothly through a
//! resize, a scale step or a quality change; TAA and the motion rows ride through a scale step
//! (`post::taa::resets_history`: the history is read in uv, so a new render size reprojects it).

//! # Level-3 passes
//!
//! `PassFrame::settle()`, `frame_index()` and `history_reset()` tell a custom pass which set and
//! which re-render it encodes. `encode` may run K times for one tick, so it must be a function of
//! (tick, sim, settle index), never of how many times it ran.

use crate::error::RenderError;
use crate::gpu::Gpu;
use crate::graph::feature_drawn;
use crate::post::ao::AoSettings;
use crate::post::exposure::{ExposureHistory, ExposurePass};
use crate::post::taa::{TaaNode, resets_history};
use crate::scene::CameraDesc;
use crate::settings::{ExposureMode, JitterCycle, Look, Quality, RenderFeature};

/// The most re-renders one settled capture runs (`CAPTURE_SETTLE_FRAMES_MAX` on the wire).
pub const SETTLE_FRAMES_MAX: u32 = 16;
/// Re-renders a capture needs with auto exposure on the HDR path: the first meters the scene
/// (instantly) at the look's initial exposure and the second is drawn with that. The metering is
/// exposure-invariant (it divides the pre-exposure back out): a dim yard far from the initial
/// exposure lands within 0.003 levels of the converged K = 16 picture at K = 2 on `rgba16float`
/// (0.53 on `rg11b10ufloat`, whose 6-bit mantissa quantizes the dark tail).
pub const AUTO_EXPOSURE_SETTLE_FRAMES: u32 = 2;
/// [`AUTO_EXPOSURE_SETTLE_FRAMES`] when a game's pass changes the HDR scene before it is metered
/// (a Level-3 `post-hdr` pass: a grade): such a pass applies its constants (a shadow lift, a
/// flare, a bright-pass threshold) to pre-exposed radiance, which is not exposure-invariant, so
/// the first metering of a picture exposed far from the final one is off and one more re-render
/// meters it again near the final exposure (RQ5 review root cause: the showcase's grade put K = 2
/// 0.17 to 0.52 EV dark on every non-temporal preset, K = 3 within 0.03 EV of K = 16).
pub const GRADED_EXPOSURE_SETTLE_FRAMES: u32 = 3;
/// A camera whose eye moves farther than this share of its distance to the target in one rendered
/// frame is a cut.
pub const CAMERA_CUT_DISTANCE_RATIO: f32 = 0.5;
/// A camera whose view direction turns by more than this in one rendered frame is a cut.
pub const CAMERA_CUT_ANGLE_DEGREES: f32 = 30.0;
/// A change of the vertical field of view beyond this (degrees) in one rendered frame is a cut.
pub const CAMERA_CUT_FOV_DEGREES: f32 = 10.0;

/// Which history a frame draws on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum HistorySet {
    /// The player's frames: history runs on from frame to frame.
    Live,
    /// A capture's re-renders: history starts from the initial state on every capture.
    Capture,
}

/// Why a history starts over.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum HistoryReset {
    /// The camera cut (asked for by the frame, or a jump [`camera_cut`] calls one).
    CameraCut,
    /// The world target's size changed.
    Resize,
    /// The scene's render size changed (a dynamic-resolution step or a new render scale).
    ScaleStep,
    /// A pipeline-shaping quality knob changed (a preset, a feature switch).
    Settings,
    /// The device was re-created (the renderer is new).
    DeviceRecreated,
    /// The sim's tick went backwards (a reset, a seed, a load).
    Rewind,
    /// A settled capture begins (the Capture set only).
    Capture,
}

impl HistoryReset {
    /// Whether auto exposure adapts at once after this reset: a new shot or timeline (a cut, a
    /// rewind, a new device, a capture). A resize, a scale step or a quality change shows the same
    /// scene, so Live's exposure keeps adapting smoothly instead of popping.
    pub fn resets_exposure(self) -> bool {
        matches!(self, HistoryReset::CameraCut | HistoryReset::DeviceRecreated | HistoryReset::Rewind | HistoryReset::Capture)
    }
}

/// One re-render of a settled capture.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct SettleFrame {
    /// This re-render's index, `0..count`.
    pub index: u32,
    /// Re-renders in all (K).
    pub count: u32,
}

impl SettleFrame {
    /// The first of `count` re-renders (at least one, at most [`SETTLE_FRAMES_MAX`]).
    pub fn first(count: u32) -> SettleFrame {
        SettleFrame { index: 0, count: count.clamp(1, SETTLE_FRAMES_MAX) }
    }

    /// Whether this is the re-render the capture reads back.
    pub fn is_last(&self) -> bool {
        self.index + 1 >= self.count
    }

    /// The re-render after this one (the last one stays the last).
    pub fn next(self) -> SettleFrame {
        SettleFrame { index: (self.index + 1).min(self.count.saturating_sub(1)), ..self }
    }
}

/// What a node with history does for the settle rules. Every node that keeps state across frames
/// implements it, so captures and resets reach it through one path.
pub trait SettleHooks {
    /// History set `set` starts over for `reason`: the next frame drawn on it has no history. The
    /// Capture set returns to its initial state, so every capture starts from the same one.
    fn settle_reset(&mut self, gpu: &Gpu, set: HistorySet, reason: HistoryReset) -> Result<(), RenderError>;

    /// Before re-render `frame` of a settled capture: bring what the node derives over many frames
    /// up to date at once (a synchronous sky LUT or IBL bake, a Hi-Z rebuild). Default: nothing.
    fn settle_sync(&mut self, _gpu: &Gpu, _frame: SettleFrame) -> Result<(), RenderError> {
        Ok(())
    }
}

/// What a settled capture re-renders for: the history its picture includes (the capture row's
/// provenance documents it as `settleFrames` = [`SettlePlan::frames`] and `historyReset: true`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct SettlePlan {
    /// Re-renders in all (K), at most [`SETTLE_FRAMES_MAX`].
    pub frames: u32,
    /// Auto exposure meters each re-render instantly on the capture's own history.
    pub auto_exposure: bool,
    /// TAA resolves each re-render on the capture's own history ([`TaaHistories`]).
    pub taa: bool,
    /// AO blends its own history over the re-renders, started over at the first.
    pub temporal_ao: bool,
    /// The jitter cycle the re-renders walk from index 0 (TAA's positions, the frame-keyed
    /// noise), when TAA or temporal AO is drawn.
    pub jitter_cycle: Option<JitterCycle>,
}

impl SettlePlan {
    /// Whether a capture's history starts over (always: the provenance's `historyReset`).
    pub const fn history_reset() -> bool {
        true
    }
}

/// What a settled capture re-renders for under `quality` and `look` when the scene can draw HDR
/// (`hdr_scene`: the session's scene format is HDR and nothing keeps frames LDR). TAA counts where
/// this build draws it ([`feature_drawn`]) on the HDR scene; AO where it draws with strength and
/// keeps its own history.
pub fn settle_plan(quality: &Quality, look: &Look, hdr_scene: bool) -> SettlePlan {
    settle_plan_graded(quality, look, hdr_scene, false)
}

/// [`settle_plan`] for a frame whose game passes change the HDR scene before it is metered
/// (`graded`: a Level-3 `post-hdr` pass runs): auto exposure then takes
/// [`GRADED_EXPOSURE_SETTLE_FRAMES`].
pub fn settle_plan_graded(quality: &Quality, look: &Look, hdr_scene: bool, graded: bool) -> SettlePlan {
    let hdr = hdr_scene && quality.hdr;
    let auto_exposure = hdr && quality.exposure && look.exposure == ExposureMode::Auto;
    let taa = hdr && feature_drawn(quality, RenderFeature::Taa);
    let ao_drawn = feature_drawn(quality, RenderFeature::Ao) && AoSettings::new(look, &quality.ao).is_some();
    let temporal_ao = ao_drawn && quality.ao.temporal;
    let jitter_cycle = (taa || temporal_ao).then_some(quality.taa.jitter_cycle);
    let metered = if graded { GRADED_EXPOSURE_SETTLE_FRAMES } else { AUTO_EXPOSURE_SETTLE_FRAMES };
    let frames = match (jitter_cycle, auto_exposure) {
        (Some(cycle), _) => cycle.frames().max(metered),
        (None, true) => metered,
        (None, false) => 1,
    };
    SettlePlan { frames: frames.min(SETTLE_FRAMES_MAX), auto_exposure, taa, temporal_ao, jitter_cycle }
}

/// Re-renders a settled capture needs ([`settle_plan`]'s K): the jitter cycle with TAA or temporal
/// AO drawn, [`AUTO_EXPOSURE_SETTLE_FRAMES`] with auto exposure on the HDR path, else 1.
pub fn settle_frames(quality: &Quality, look: &Look, hdr_scene: bool) -> u32 {
    settle_plan(quality, look, hdr_scene).frames
}

/// What a frame draws with that history depends on: a change resets Live's history.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HistoryKey {
    /// The world target's size.
    pub output: (u32, u32),
    /// The scene's render size (the scale step).
    pub render: (u32, u32),
    /// The quality.
    pub quality: Quality,
}

impl HistoryKey {
    /// Why history resets going from `self` to `next` (the first rule that applies), if it does.
    /// A quality change of resource knobs only (a dynamic-resolution demotion, a budget step) keeps
    /// every history (RQ5 review): each node whose own resources it remakes starts itself over
    /// (AO's targets, the shadow maps' key, the environment bake's size).
    pub fn reset_to(&self, next: &HistoryKey) -> Option<HistoryReset> {
        if self.output != next.output {
            return Some(HistoryReset::Resize);
        }
        if self.render != next.render {
            return Some(HistoryReset::ScaleStep);
        }
        (!self.quality.resource_change_only(&next.quality)).then_some(HistoryReset::Settings)
    }
}

fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn length(v: [f32; 3]) -> f32 {
    libm::sqrtf(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
}

/// Whether moving the camera from `previous` to `next` in one rendered frame is a cut: the eye
/// jumps farther than [`CAMERA_CUT_DISTANCE_RATIO`] of its distance to the target, the view turns
/// by more than [`CAMERA_CUT_ANGLE_DEGREES`], the field of view changes by more than
/// [`CAMERA_CUT_FOV_DEGREES`], or the projection changes kind.
pub fn camera_cut(previous: &CameraDesc, next: &CameraDesc) -> bool {
    if previous.ortho_height.is_some() != next.ortho_height.is_some() {
        return true;
    }
    if (previous.fovy_degrees - next.fovy_degrees).abs() > CAMERA_CUT_FOV_DEGREES {
        return true;
    }
    let (before, after) = (sub(previous.target, previous.eye), sub(next.target, next.eye));
    let reach = length(before).max(f32::MIN_POSITIVE);
    if length(sub(next.eye, previous.eye)) > reach * CAMERA_CUT_DISTANCE_RATIO {
        return true;
    }
    let lengths = reach * length(after).max(f32::MIN_POSITIVE);
    let cosine = (before[0] * after[0] + before[1] * after[1] + before[2] * after[2]) / lengths;
    cosine < libm::cosf(CAMERA_CUT_ANGLE_DEGREES.to_radians())
}

/// Where one frame sits in its history.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FrameHistory {
    /// The set it draws on.
    pub set: HistorySet,
    /// Frames drawn on the set since its last reset, before this one (a capture: its settle
    /// index). Temporal sequences (dither, jitter, noise, TAA's accumulation) key to it.
    pub frame_index: u64,
    /// Sim ticks this frame advances history by (what adaptation moves by; 0 in a capture).
    pub ticks: u32,
    /// Why the history started over at this frame, if it did.
    pub reset: Option<HistoryReset>,
    /// The re-render of a settled capture this frame is (None in Live).
    pub settle: Option<SettleFrame>,
}

impl FrameHistory {
    /// Whether the frame draws with no history (its index is 0).
    pub fn history_reset(&self) -> bool {
        self.frame_index == 0
    }

    /// The re-render of a settled capture: its index from an empty Capture history.
    pub fn settled(frame: SettleFrame) -> FrameHistory {
        let reset = (frame.index == 0).then_some(HistoryReset::Capture);
        FrameHistory { set: HistorySet::Capture, frame_index: u64::from(frame.index), ticks: 0, reset, settle: Some(frame) }
    }
}

/// What one Live frame tells its history.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LiveFrame<'a> {
    /// The sim tick the frame shows, when the caller knows it.
    pub tick: Option<u64>,
    /// The ticks a paced shell says the frame ran (overrides the tick difference).
    pub paced_ticks: Option<u32>,
    /// What the frame draws with.
    pub key: HistoryKey,
    /// Its camera.
    pub camera: &'a CameraDesc,
    /// Whether the frame asks for a camera cut.
    pub cut: bool,
}

/// Live's history: the frame index and what the last frame drew with.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct LiveHistory {
    /// Frames drawn since the last reset, after the last frame.
    frames: u64,
    last_tick: Option<u64>,
    key: Option<HistoryKey>,
    camera: Option<CameraDesc>,
    pending: Option<HistoryReset>,
}

impl LiveHistory {
    /// Start over at the next frame for `reason` (an explicit cut, a new surface).
    pub fn reset(&mut self, reason: HistoryReset) {
        self.pending = Some(reason);
    }

    /// Frames drawn since the last reset, after the last frame.
    pub fn frame_index(&self) -> u64 {
        self.frames
    }

    /// The ticks `frame` advances by: a paced shell's count, else the tick difference (0 for the
    /// same tick drawn again), else one per frame.
    fn ticks_of(&self, frame: &LiveFrame<'_>) -> u32 {
        if let Some(ticks) = frame.paced_ticks {
            return ticks;
        }
        match (frame.tick, self.last_tick) {
            (Some(tick), Some(last)) => u32::try_from(tick.saturating_sub(last)).unwrap_or(u32::MAX),
            _ => 1,
        }
    }

    /// Why `frame` starts history over, if it does (the first rule that applies).
    fn reset_of(&self, frame: &LiveFrame<'_>) -> Option<HistoryReset> {
        if let Some(reason) = self.pending {
            return Some(reason);
        }
        if frame.cut {
            return Some(HistoryReset::CameraCut);
        }
        let rewound = matches!((frame.tick, self.last_tick), (Some(tick), Some(last)) if tick < last);
        if rewound {
            return Some(HistoryReset::Rewind);
        }
        if let Some(reason) = self.key.as_ref().and_then(|key| key.reset_to(&frame.key)) {
            return Some(reason);
        }
        self.camera.as_ref().filter(|camera| camera_cut(camera, frame.camera)).map(|_| HistoryReset::CameraCut)
    }

    /// Draw `frame` on Live's history: where it sits, after any reset it causes.
    pub fn step(&mut self, frame: LiveFrame<'_>) -> FrameHistory {
        let reset = self.reset_of(&frame);
        let ticks = self.ticks_of(&frame);
        if reset.is_some() {
            self.frames = 0;
        }
        let history = FrameHistory { set: HistorySet::Live, frame_index: self.frames, ticks, reset, settle: None };
        self.frames = self.frames.saturating_add(1);
        self.last_tick = frame.tick.or(self.last_tick);
        self.key = Some(frame.key);
        self.camera = Some(*frame.camera);
        self.pending = None;
        history
    }
}

/// The exposure node's histories: Live's and a capture's own, with the node's pipelines.
pub(crate) struct ExposureHistories {
    pub(crate) pass: ExposurePass,
    pub(crate) live: ExposureHistory,
    pub(crate) capture: ExposureHistory,
    /// The look a fresh history starts from.
    look: Look,
}

impl ExposureHistories {
    /// The pipelines and both histories, starting from `look`.
    pub(crate) fn new(gpu: &Gpu, look: &Look) -> Result<ExposureHistories, RenderError> {
        let (device, queue) = (&gpu.device, &gpu.queue);
        Ok(ExposureHistories {
            pass: ExposurePass::new(device)?,
            live: ExposureHistory::new(device, queue, look)?,
            capture: ExposureHistory::new(device, queue, look)?,
            look: *look,
        })
    }

    /// The look a reset history starts from from now on.
    pub(crate) fn set_look(&mut self, look: &Look) {
        self.look = *look;
    }

    /// The pipelines and `set`'s history.
    pub(crate) fn parts(&mut self, set: HistorySet) -> (&ExposurePass, &mut ExposureHistory) {
        match set {
            HistorySet::Live => (&self.pass, &mut self.live),
            HistorySet::Capture => (&self.pass, &mut self.capture),
        }
    }
}

impl SettleHooks for ExposureHistories {
    fn settle_reset(&mut self, gpu: &Gpu, set: HistorySet, reason: HistoryReset) -> Result<(), RenderError> {
        match set {
            HistorySet::Live if !reason.resets_exposure() => {}
            // Live keeps its exposure and adapts at once on its next metered frame.
            HistorySet::Live => self.live.reset(),
            // A capture starts from the look's initial state, never from the last capture's.
            HistorySet::Capture => self.capture = ExposureHistory::new(&gpu.device, &gpu.queue, &self.look)?,
        }
        Ok(())
    }
}

/// TAA's histories (graph node 17): Live's and a capture's own, so a settled capture resolves its
/// jitter cycle from an empty history and never reads, resets or advances Live's. The capture's
/// node is made at the first capture and kept until [`TaaHistories::release_capture`] (a class
/// whose budget cannot hold a second history pair releases it after each capture).
pub struct TaaHistories {
    live: TaaNode,
    capture: Option<TaaNode>,
}

impl TaaHistories {
    /// Live's node; the capture's waits for the first capture.
    pub fn new(gpu: &Gpu) -> Result<TaaHistories, RenderError> {
        TaaHistories::on_device(&gpu.device, &gpu.queue)
    }

    /// [`TaaHistories::new`] on the renderer's device: histories it can copy a resolve out of
    /// (into the 1x scene, for `post-hdr` passes).
    pub(crate) fn on_device(device: &wgpu::Device, queue: &wgpu::Queue) -> Result<TaaHistories, RenderError> {
        Ok(TaaHistories { live: TaaNode::with_usage(device, queue, wgpu::TextureUsages::COPY_SRC)?, capture: None })
    }

    /// [`TaaHistories::node`] on the renderer's device.
    pub(crate) fn node_on(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, set: HistorySet) -> Result<&mut TaaNode, RenderError> {
        if set == HistorySet::Live {
            return Ok(&mut self.live);
        }
        if self.capture.is_none() {
            self.capture = Some(TaaNode::with_usage(device, queue, wgpu::TextureUsages::COPY_SRC)?);
        }
        Ok(self.capture.as_mut().expect("made above"))
    }

    /// `set`'s history texture of `slot` (None before its first resolve).
    pub(crate) fn written_texture(&self, set: HistorySet, slot: usize) -> Option<&wgpu::Texture> {
        match set {
            HistorySet::Live => self.live.slot_texture(slot),
            HistorySet::Capture => self.capture.as_ref()?.slot_texture(slot),
        }
    }

    /// Start `set`'s history over (the next resolve takes the current sample whole).
    pub(crate) fn reset_set(&mut self, set: HistorySet) {
        match set {
            HistorySet::Live => self.live.reset(),
            HistorySet::Capture => {
                if let Some(capture) = self.capture.as_mut() {
                    capture.reset();
                }
            }
        }
    }

    /// `set`'s node (the capture's made on first use, starting from an empty history).
    pub fn node(&mut self, gpu: &Gpu, set: HistorySet) -> Result<&mut TaaNode, RenderError> {
        match set {
            HistorySet::Live => Ok(&mut self.live),
            HistorySet::Capture => self.capture_node(gpu),
        }
    }

    fn capture_node(&mut self, gpu: &Gpu) -> Result<&mut TaaNode, RenderError> {
        self.node_on(&gpu.device, &gpu.queue, HistorySet::Capture)
    }

    /// Drop the capture's history pair (its bytes go back to the budget); the next capture makes
    /// it again.
    pub fn release_capture(&mut self) {
        self.capture = None;
    }

    /// The bytes both history pairs hold now (the ledger's TAA row).
    pub fn history_bytes(&self) -> u64 {
        self.live.history_bytes() + self.capture.as_ref().map_or(0, TaaNode::history_bytes)
    }
}

impl SettleHooks for TaaHistories {
    fn settle_reset(&mut self, gpu: &Gpu, set: HistorySet, reason: HistoryReset) -> Result<(), RenderError> {
        match set {
            HistorySet::Live if resets_history(reason) => self.live.reset(),
            HistorySet::Live => {}
            // Every capture resolves from an empty history, never from the last capture's.
            HistorySet::Capture => self.capture_node(gpu)?.reset(),
        }
        Ok(())
    }
}
