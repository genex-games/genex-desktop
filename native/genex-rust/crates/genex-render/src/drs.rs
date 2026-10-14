//! Dynamic resolution (plan §2.6): a pure controller over a class's discrete scale steps, fed a
//! typed [`FrameSignal`] and an injected time. It reads no clock and keeps no GPU state, so a
//! given measurement sequence always answers the same steps.
//!
//! - With [`FrameSignal::GpuMs`] (timestamp queries) the GPU target is [`GPU_TARGET_FRACTION`] of
//!   the class's frame interval. [`DROP_AFTER_FRAMES`] frames over target drop the scale to the
//!   highest step whose pixel-proportional cost fits; [`RISE_AFTER_FRAMES`] frames under
//!   [`CALM_FRACTION`] of the target raise it one step, and only when the next step is predicted
//!   to fit. A rise that is undone within [`RISE_AFTER_FRAMES`] doubles the calm needed for the
//!   next one, so a slow oscillation cannot flap.
//! - With [`FrameSignal::IntervalOnly`] (Safari, or no timestamps) there is no GPU target: the
//!   scale drops only on missed vsyncs (an interval over [`MISSED_INTERVAL_FACTOR`] × the class
//!   interval, [`MISSES_TO_DROP`] in the last [`MISS_WINDOW_FRAMES`]) and climbs back toward the
//!   nominal step, never above it, by timed probes whose wait doubles after a failed probe.
//! - After [`DEMOTE_AFTER`] at the minimum step over target the preset's resource knobs step down
//!   one preset ([`DrsController::demotion`], applied with [`demote_quality`]); after
//!   [`PROMOTE_AFTER`] of headroom they step back up. A demotion never changes the sample count
//!   or the pipeline key set.
//! - A frame's fixed cost ([`DrsController::with_fixed_ms`]: the FSR1 passes run at output size)
//!   is not scaled by a step's pixel ratio, so a drop never promises a saving the upscale keeps.
//! - Measurements of the [`SETTLE_FRAMES`] frames after any change are ignored: they were
//!   rendered before it (frames in flight, the timing ring's latency).
//!
//! - Under sustained thermal load ([`DrsController::set_thermal`]) a class with a sustained rate
//!   (mobile-mid: 30 fps) holds that rate's interval instead; it returns to the class's rate only
//!   after [`THERMAL_RECOVER_AFTER`] without thermal load, so a device near its limit does not
//!   flap between the two.
//!
//! Each step is its own exact target size (bucketed to [`SCALE_QUANTUM`]), never a sub-rectangle
//! of a larger one: a class's steps are its table's ([`ScaleSteps::table`]). DRS never applies to
//! captures: they render at [`DrsController::capture_step`].

use std::time::Duration;

use crate::device_class::DeviceClass;
use crate::presets::{class_defaults, preset_quality};
use crate::settings::{AoResolution, Quality, QualityPreset};

/// Most discrete scale steps over a class's range.
pub const MAX_SCALE_STEPS: usize = 6;
/// Scales are whole multiples of this, so a step's target size is a stable pool key.
pub const SCALE_QUANTUM: f32 = 1.0 / 32.0;
/// The GPU target as a fraction of the class's frame interval (timestamps only).
pub const GPU_TARGET_FRACTION: f32 = 0.85;
/// Consecutive frames over the GPU target that drop the scale.
pub const DROP_AFTER_FRAMES: u32 = 2;
/// Consecutive calm frames that raise the scale one step.
pub const RISE_AFTER_FRAMES: u32 = 30;
/// The most calm frames a rise ever waits for after failed rises.
pub const RISE_BACKOFF_MAX_FRAMES: u32 = 240;
/// A frame is calm under this fraction of the GPU target.
pub const CALM_FRACTION: f32 = 0.75;
/// A rise needs the next step's predicted cost under this fraction of the GPU target.
pub const RISE_PREDICTED_FRACTION: f32 = 0.9;
/// Measurements ignored after a change: they were rendered before it.
pub const SETTLE_FRAMES: u32 = 2;
/// An interval over this multiple of the class interval missed a vsync.
pub const MISSED_INTERVAL_FACTOR: f32 = 1.5;
/// Frames the missed-vsync count looks back over.
pub const MISS_WINDOW_FRAMES: u32 = 8;
/// Missed vsyncs within the window that drop the scale.
pub const MISSES_TO_DROP: u32 = 2;
/// Calm before the first interval-only probe toward the nominal step.
pub const PROBE_AFTER: Duration = Duration::from_secs(2);
/// The longest wait between interval-only probes after failed ones.
pub const PROBE_BACKOFF_MAX: Duration = Duration::from_secs(32);
/// Frames a probe must hold without dropping to count as a success.
pub const PROBE_WINDOW_FRAMES: u32 = 30;
/// Time at the minimum step over target that demotes the preset one step.
pub const DEMOTE_AFTER: Duration = Duration::from_secs(5);
/// Time of headroom that re-promotes it one step.
pub const PROMOTE_AFTER: Duration = Duration::from_secs(20);
/// Headroom with timestamps: GPU time under this fraction of the target.
pub const PROMOTE_BELOW_FRACTION: f32 = 0.5;
/// Most preset steps a controller demotes (ultra to low).
pub const MAX_DEMOTION: u8 = 3;
/// Time without thermal load before a class held at its sustained rate returns to its own.
pub const THERMAL_RECOVER_AFTER: Duration = Duration::from_secs(10);

/// What the controller is told about one frame.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum FrameSignal {
    /// GPU time from timestamp queries, in milliseconds.
    GpuMs(f32),
    /// No timestamps (Safari, or the feature absent): only the display interval, in milliseconds.
    IntervalOnly(f32),
}

/// The signal for a frame: [`FrameSignal::GpuMs`] only from timestamp queries (a submit-latency
/// estimate includes queueing, so it never drives the GPU target), the display interval otherwise.
pub fn frame_signal(timestamp_gpu_ms: Option<f32>, display_interval_ms: f32) -> FrameSignal {
    match timestamp_gpu_ms {
        Some(ms) => FrameSignal::GpuMs(ms),
        None => FrameSignal::IntervalOnly(display_interval_ms),
    }
}

/// A class's discrete render scales, lowest first: each is an exact target size, never a
/// sub-rectangle of a larger one.
#[derive(Clone, Debug, PartialEq)]
pub struct ScaleSteps {
    steps: Vec<f32>,
}

fn quantize(scale: f32) -> f32 {
    (scale / SCALE_QUANTUM).round() * SCALE_QUANTUM
}

impl ScaleSteps {
    /// Up to [`MAX_SCALE_STEPS`] evenly spaced steps over `(lowest, highest)`, each a whole
    /// number of [`SCALE_QUANTUM`]s inside the range (a range narrower than one quantum is one
    /// step).
    pub fn over(range: (f32, f32), count: usize) -> ScaleSteps {
        let (lowest, highest) = (range.0.min(range.1), range.0.max(range.1));
        let floor = (lowest / SCALE_QUANTUM).ceil() * SCALE_QUANTUM;
        let ceiling = (highest / SCALE_QUANTUM).floor() * SCALE_QUANTUM;
        let count = count.clamp(1, MAX_SCALE_STEPS);
        if count == 1 || floor >= ceiling {
            return ScaleSteps { steps: vec![quantize(highest).max(SCALE_QUANTUM)] };
        }
        let span = ceiling - floor;
        let mut steps: Vec<f32> =
            (0..count).map(|step| quantize(floor + span * step as f32 / (count - 1) as f32).clamp(floor, ceiling)).collect();
        steps.dedup();
        ScaleSteps { steps }
    }

    /// [`ScaleSteps::over`] with `nominal` (quantized, inside the range) as one of the steps: it
    /// replaces the step nearest it.
    pub fn with_nominal(range: (f32, f32), count: usize, nominal: f32) -> ScaleSteps {
        let mut steps = ScaleSteps::over(range, count);
        let lowest = steps.steps[0];
        let highest = steps.steps[steps.steps.len() - 1];
        let nominal = quantize(nominal).clamp(lowest, highest);
        let nearest = steps.nearest(nominal);
        steps.steps[nearest] = nominal;
        steps.steps.sort_by(f32::total_cmp);
        steps.steps.dedup();
        steps
    }

    /// A class table's `steps` (lowest first), each bucketed to [`SCALE_QUANTUM`], with `nominal`
    /// (bucketed too) among them: added when the table does not hold it, so a game's or the
    /// person's scale outside the table widens it. At most [`MAX_SCALE_STEPS`] plus the nominal.
    pub fn table(steps: &[f32], nominal: f32) -> ScaleSteps {
        let mut steps: Vec<f32> = steps.iter().take(MAX_SCALE_STEPS).map(|scale| quantize(*scale).max(SCALE_QUANTUM)).collect();
        steps.push(quantize(nominal).max(SCALE_QUANTUM));
        steps.sort_by(f32::total_cmp);
        steps.dedup();
        ScaleSteps { steps }
    }

    /// The steps no higher than `ceiling` (the lowest step at least, so never empty).
    pub fn up_to(&self, ceiling: f32) -> ScaleSteps {
        let mut steps: Vec<f32> = self.steps.iter().copied().filter(|scale| *scale <= ceiling).collect();
        if steps.is_empty() {
            steps.push(self.steps[0]);
        }
        ScaleSteps { steps }
    }

    /// The scales, lowest first.
    pub fn steps(&self) -> &[f32] {
        &self.steps
    }

    /// The step nearest `scale`.
    pub fn nearest(&self, scale: f32) -> usize {
        let distance = |index: usize| (self.steps[index] - scale).abs();
        (0..self.steps.len()).min_by(|a, b| distance(*a).total_cmp(&distance(*b))).unwrap_or(0)
    }
}

/// Which kind of signal the controller last read (a change of kind restarts its measurements).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SignalKind {
    Gpu,
    Interval,
}

/// An interval-only probe in progress: the step it left and the frames it has held.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Probe {
    from: usize,
    frames: u32,
}

/// What the controller has measured since its last change.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct Measurements {
    /// Frames still to ignore.
    settle: u32,
    /// Consecutive frames over the GPU target, and their summed time.
    over_frames: u32,
    over_ms: f32,
    /// Consecutive calm frames.
    calm_frames: u32,
    /// The last [`MISS_WINDOW_FRAMES`] frames' missed vsyncs, newest in bit 0.
    misses: u32,
    /// Interval-only: calm (no missed vsync) since.
    calm_since: Option<Duration>,
    /// At the minimum step over target since.
    overload_since: Option<Duration>,
    /// With headroom since.
    headroom_since: Option<Duration>,
}

/// The controller.
#[derive(Clone, Debug, PartialEq)]
pub struct DrsController {
    steps: ScaleSteps,
    current: usize,
    nominal: usize,
    frame_interval: Duration,
    max_demotion: u8,
    demotion: u8,
    kind: Option<SignalKind>,
    measured: Measurements,
    /// Calm frames the next rise needs (doubles after a rise that was undone).
    calm_needed: u32,
    /// Frames since the last rise, until it has held [`RISE_AFTER_FRAMES`].
    since_rise: Option<u32>,
    probe: Option<Probe>,
    probe_wait: Duration,
    /// The class's sustained-load interval, if it has one.
    sustained_interval: Option<Duration>,
    /// Holding the sustained interval: since when without thermal load (None while loaded).
    thermal: Option<Option<Duration>>,
    /// Milliseconds of a frame below scale 1 that do not follow the render step (the upscaler's
    /// passes run at output size).
    fixed_ms: f32,
    /// Milliseconds of a frame at scale 1 that do not follow the render step (no upscale runs
    /// there; RCAS alone under TAA's sharpen does).
    fixed_at_one_ms: f32,
}

impl DrsController {
    /// A controller over `steps` starting at the step nearest `nominal`, for a class whose frame
    /// interval is `frame_interval`.
    pub fn new(steps: ScaleSteps, nominal: f32, frame_interval: Duration) -> DrsController {
        let current = steps.nearest(nominal);
        DrsController {
            steps,
            current,
            nominal: current,
            frame_interval,
            max_demotion: MAX_DEMOTION,
            demotion: 0,
            kind: None,
            measured: Measurements::default(),
            calm_needed: RISE_AFTER_FRAMES,
            since_rise: None,
            probe: None,
            probe_wait: PROBE_AFTER,
            sustained_interval: None,
            thermal: None,
            fixed_ms: 0.0,
            fixed_at_one_ms: 0.0,
        }
    }

    /// The controller of `class` (plan §2.4's table): its table's steps ([`ScaleSteps::table`])
    /// with its nominal scale among them, its target frame rate and its sustained rate.
    pub fn for_class(class: DeviceClass) -> DrsController {
        let defaults = class_defaults(class);
        let steps = ScaleSteps::table(defaults.drs_steps, defaults.nominal_scale);
        let interval = Duration::from_secs(1) / defaults.target_fps.max(1);
        DrsController::new(steps, defaults.nominal_scale, interval).with_sustained_fps(defaults.sustained_fps)
    }

    /// The controller holding `fps` under sustained thermal load ([`DrsController::set_thermal`]);
    /// None (or a rate not below the class's) never changes the interval.
    pub fn with_sustained_fps(mut self, fps: Option<u32>) -> DrsController {
        let interval = fps.filter(|fps| *fps > 0).map(|fps| Duration::from_secs(1) / fps);
        self.sustained_interval = interval.filter(|interval| *interval > self.frame_interval);
        self
    }

    /// Whether the platform reports sustained thermal load at `now` (an injected time). Load holds
    /// the class's sustained rate at once; its own rate comes back after [`THERMAL_RECOVER_AFTER`]
    /// without load. A switch starts the measurements over. Answers whether the interval changed.
    pub fn set_thermal(&mut self, loaded: bool, now: Duration) -> bool {
        if self.sustained_interval.is_none() {
            return false;
        }
        let holding = self.thermal.is_some();
        if loaded {
            self.thermal = Some(None);
            if !holding {
                self.reset();
            }
            return !holding;
        }
        let Some(cool) = self.thermal.as_mut() else { return false };
        let since = *cool.get_or_insert(now);
        if now.saturating_sub(since) < THERMAL_RECOVER_AFTER {
            return false;
        }
        self.thermal = None;
        self.reset();
        true
    }

    /// Whether the controller holds the class's sustained rate.
    pub fn sustained(&self) -> bool {
        self.thermal.is_some()
    }

    /// The controller demoting at most `levels` preset steps (a preset's index above `low`).
    pub fn with_max_demotion(mut self, levels: u8) -> DrsController {
        self.max_demotion = levels;
        self.demotion = self.demotion.min(levels);
        self
    }

    /// The controller counting `ms` of every frame as a cost no step changes: the FSR1 passes
    /// run at output size ([`crate::post::fsr::estimated_cost_ms`]), so a drop does not save
    /// them. Predictions scale only the rest. A NaN or negative `ms` is no cost.
    pub fn with_fixed_ms(mut self, ms: f32) -> DrsController {
        let ms = if ms.is_finite() { ms.max(0.0) } else { 0.0 };
        (self.fixed_ms, self.fixed_at_one_ms) = (ms, ms);
        self
    }

    /// The controller counting `below_one` ms of every frame drawn below scale 1 and `at_one` ms of
    /// a frame at scale 1 as costs no step changes (RQ5 review): FSR1's EASU and RCAS run at output
    /// size only below scale 1 ([`crate::post::fsr::passes`]), so the first drop from 1 adds them
    /// and a rise to 1 saves them. A NaN or negative cost is none.
    pub fn with_upscale_ms(mut self, below_one: f32, at_one: f32) -> DrsController {
        let held = |ms: f32| if ms.is_finite() { ms.max(0.0) } else { 0.0 };
        (self.fixed_ms, self.fixed_at_one_ms) = (held(below_one), held(at_one));
        self
    }

    /// The milliseconds no step changes below scale 1 ([`DrsController::with_fixed_ms`],
    /// [`DrsController::with_upscale_ms`]).
    pub fn fixed_ms(&self) -> f32 {
        self.fixed_ms
    }

    /// The fixed milliseconds of a frame drawn at `scale`.
    fn fixed_at(&self, scale: f32) -> f32 {
        if scale < 1.0 { self.fixed_ms } else { self.fixed_at_one_ms }
    }

    /// Take one frame's `signal` at `now` (an injected time); answers the step to render the next
    /// frame at. A signal that is not a finite, non-negative time is ignored.
    pub fn observe(&mut self, signal: FrameSignal, now: Duration) -> usize {
        let (kind, ms) = match signal {
            FrameSignal::GpuMs(ms) => (SignalKind::Gpu, ms),
            FrameSignal::IntervalOnly(ms) => (SignalKind::Interval, ms),
        };
        if !ms.is_finite() || ms < 0.0 {
            return self.current;
        }
        if self.kind != Some(kind) {
            self.kind = Some(kind);
            self.reset();
        }
        if self.measured.settle > 0 {
            self.measured.settle -= 1;
            return self.current;
        }
        match kind {
            SignalKind::Gpu => self.observe_gpu(ms, now),
            SignalKind::Interval => self.observe_interval(ms, now),
        }
        self.current
    }

    /// Forget every measurement (resize, device re-creation, a pipeline change): the step and the
    /// demotion are kept.
    pub fn reset(&mut self) {
        self.measured = Measurements { settle: SETTLE_FRAMES, ..Measurements::default() };
        self.since_rise = None;
        self.probe = None;
    }

    /// The current step's index.
    pub fn step(&self) -> usize {
        self.current
    }

    /// The current render scale.
    pub fn scale(&self) -> f32 {
        self.steps.steps()[self.current]
    }

    /// The class's steps.
    pub fn steps(&self) -> &ScaleSteps {
        &self.steps
    }

    /// The nominal step's index.
    pub fn nominal_step(&self) -> usize {
        self.nominal
    }

    /// The step a capture renders at: always the nominal one (DRS never applies to captures).
    pub fn capture_step(&self) -> usize {
        self.nominal
    }

    /// The scale a capture renders at.
    pub fn capture_scale(&self) -> f32 {
        self.steps.steps()[self.nominal]
    }

    /// Preset steps the resource knobs are demoted by (0 = the chosen preset).
    pub fn demotion(&self) -> u8 {
        self.demotion
    }

    /// The frame interval held now: the class's, or its sustained rate's under thermal load.
    pub fn frame_interval(&self) -> Duration {
        match (self.thermal, self.sustained_interval) {
            (Some(_), Some(sustained)) => sustained,
            _ => self.frame_interval,
        }
    }

    /// The GPU target in milliseconds (with timestamps).
    pub fn gpu_target_ms(&self) -> f32 {
        self.interval_ms() * GPU_TARGET_FRACTION
    }

    fn interval_ms(&self) -> f32 {
        self.frame_interval().as_secs_f32() * 1000.0
    }

    /// The cost of `ms` at the current step, predicted at `step`: proportional to pixels, except
    /// the fixed part ([`DrsController::with_upscale_ms`]), which is the current scale's in `ms`
    /// and the predicted step's after it (the upscale starts below 1 and stops at 1).
    fn predicted_ms(&self, ms: f32, step: usize) -> f32 {
        let next = self.steps.steps()[step];
        let ratio = next / self.scale();
        let fixed = self.fixed_at(self.scale()).min(ms);
        self.fixed_at(next) + (ms - fixed) * ratio * ratio
    }

    fn observe_gpu(&mut self, ms: f32, now: Duration) {
        let target = self.gpu_target_ms();
        if self.track_demotion(ms > target, ms < target * PROMOTE_BELOW_FRACTION, now) {
            return;
        }
        if let Some(frames) = self.since_rise.as_mut() {
            *frames += 1;
            if *frames >= RISE_AFTER_FRAMES {
                self.since_rise = None;
                self.calm_needed = RISE_AFTER_FRAMES;
            }
        }
        if ms > target {
            self.measured.calm_frames = 0;
            self.measured.over_frames += 1;
            self.measured.over_ms += ms;
            if self.measured.over_frames >= DROP_AFTER_FRAMES {
                self.drop_for(self.measured.over_ms / self.measured.over_frames as f32, target);
            }
            return;
        }
        self.measured.over_frames = 0;
        self.measured.over_ms = 0.0;
        self.measured.calm_frames = if ms < target * CALM_FRACTION { self.measured.calm_frames + 1 } else { 0 };
        let next = self.current + 1;
        let fits = next < self.steps.steps().len() && self.predicted_ms(ms, next) <= target * RISE_PREDICTED_FRACTION;
        if self.measured.calm_frames >= self.calm_needed && fits {
            self.change_step(next);
            self.since_rise = Some(0);
        }
    }

    /// Drop to the highest lower step whose predicted cost of `ms` fits `target` (the minimum
    /// when none does).
    fn drop_for(&mut self, ms: f32, target: f32) {
        if self.current == 0 {
            self.measured.over_frames = 0;
            self.measured.over_ms = 0.0;
            return;
        }
        if self.since_rise.take().is_some() {
            self.calm_needed = (self.calm_needed * 2).min(RISE_BACKOFF_MAX_FRAMES);
        }
        let step = (0..self.current).rev().find(|step| self.predicted_ms(ms, *step) <= target).unwrap_or(0);
        self.change_step(step);
    }

    fn observe_interval(&mut self, ms: f32, now: Duration) {
        let missed = ms > self.interval_ms() * MISSED_INTERVAL_FACTOR;
        let window = (1u32 << MISS_WINDOW_FRAMES) - 1;
        self.measured.misses = ((self.measured.misses << 1) | u32::from(missed)) & window;
        let sustained = self.measured.misses.count_ones() >= MISSES_TO_DROP;
        let headroom = !missed && self.current >= self.nominal;
        if self.track_demotion(sustained, headroom, now) {
            return;
        }
        if let Some(probe) = self.probe.as_mut() {
            probe.frames += 1;
            let from = probe.from;
            if sustained {
                self.probe = None;
                self.probe_wait = (self.probe_wait * 2).min(PROBE_BACKOFF_MAX);
                self.change_step(from);
                return;
            }
            if probe.frames >= PROBE_WINDOW_FRAMES {
                self.probe = None;
                self.probe_wait = PROBE_AFTER;
            }
        }
        if sustained && self.current > 0 {
            self.probe = None;
            self.change_step(self.current - 1);
            return;
        }
        if missed {
            self.measured.calm_since = None;
            return;
        }
        let since = *self.measured.calm_since.get_or_insert(now);
        let due = now.saturating_sub(since) >= self.probe_wait;
        if due && self.probe.is_none() && self.current < self.nominal {
            self.probe = Some(Probe { from: self.current, frames: 0 });
            self.change_step(self.current + 1);
        }
    }

    /// Demote after [`DEMOTE_AFTER`] at the minimum step `over` target; re-promote after
    /// [`PROMOTE_AFTER`] with `headroom`. Answers whether the demotion changed.
    fn track_demotion(&mut self, over: bool, headroom: bool, now: Duration) -> bool {
        if self.current == 0 && over {
            let since = *self.measured.overload_since.get_or_insert(now);
            if now.saturating_sub(since) >= DEMOTE_AFTER && self.demotion < self.max_demotion {
                self.demotion += 1;
                self.reset();
                return true;
            }
        } else {
            self.measured.overload_since = None;
        }
        if !(headroom && self.demotion > 0) {
            self.measured.headroom_since = None;
            return false;
        }
        let since = *self.measured.headroom_since.get_or_insert(now);
        if now.saturating_sub(since) < PROMOTE_AFTER {
            return false;
        }
        self.demotion -= 1;
        self.reset();
        true
    }

    fn change_step(&mut self, step: usize) {
        self.current = step.min(self.steps.steps().len() - 1);
        let kept = (self.measured.overload_since, self.measured.headroom_since);
        self.measured = Measurements { settle: SETTLE_FRAMES, ..Measurements::default() };
        (self.measured.overload_since, self.measured.headroom_since) = kept;
    }
}

/// The cheaper of two sizes where 0 means "not used": a demotion never turns a used size off.
fn min_used<T: Ord + Copy + Default>(current: T, lower: T) -> T {
    if lower == T::default() { current } else { current.min(lower) }
}

fn ao_rank(resolution: AoResolution) -> u8 {
    match resolution {
        AoResolution::Off => 0,
        AoResolution::Half => 1,
        _ => 2,
    }
}

/// `current` with each **resource** knob (plan §2.5) stepped to `lower`'s where that is cheaper:
/// shadow cascades, map size and far cadence, bloom, AO resolution, the IBL cubes with their rebake
/// cadence and sun threshold, the sky LUT and cadence, the exposure input, the light cap and tile,
/// shadowed spots. Pipeline knobs (the sample count, filters, formats, feature pipelines) and the
/// render scale (DRS's) are `current`'s, so the result has `current`'s pipeline key; no knob is
/// ever raised.
pub fn demote_quality(current: &Quality, lower: &Quality) -> Quality {
    let mut quality = *current;
    quality.exposure_input_divisor = current.exposure_input_divisor.max(lower.exposure_input_divisor);
    quality.shadows.enabled = current.shadows.enabled && lower.shadows.enabled;
    quality.shadows.cascades = min_used(current.shadows.cascades, lower.shadows.cascades).max(1);
    quality.shadows.map_size = min_used(current.shadows.map_size, lower.shadows.map_size);
    quality.shadows.far_cadence = current.shadows.far_cadence.max(lower.shadows.far_cadence);
    quality.bloom.enabled = current.bloom.enabled && lower.bloom.enabled;
    quality.bloom.mips = min_used(current.bloom.mips, lower.bloom.mips);
    quality.bloom.half_res = current.bloom.half_res || lower.bloom.half_res;
    if ao_rank(lower.ao.resolution) < ao_rank(current.ao.resolution) {
        quality.ao.resolution = lower.ao.resolution;
    }
    quality.environment.cube_size = min_used(current.environment.cube_size, lower.environment.cube_size);
    quality.environment.hdri_cube_size = min_used(current.environment.hdri_cube_size, lower.environment.hdri_cube_size);
    quality.environment.rebake_cadence = current.environment.rebake_cadence.max(lower.environment.rebake_cadence);
    quality.environment.sun_rebake_tenths = current.environment.sun_rebake_tenths.max(lower.environment.sun_rebake_tenths);
    quality.environment.sky_lut = (
        min_used(current.environment.sky_lut.0, lower.environment.sky_lut.0),
        min_used(current.environment.sky_lut.1, lower.environment.sky_lut.1),
    );
    quality.environment.sky_cadence = current.environment.sky_cadence.max(lower.environment.sky_cadence);
    quality.lights.cap = min_used(current.lights.cap, lower.lights.cap);
    if current.lights.tile_px != 0 {
        quality.lights.tile_px = current.lights.tile_px.max(lower.lights.tile_px);
    }
    quality.lights.shadowed_spots = current.lights.shadowed_spots.min(lower.lights.shadowed_spots);
    debug_assert!(current.resource_change_only(&quality), "a demotion changed a pipeline knob");
    quality
}

/// `current` (resolved from `preset` on `class`) demoted `levels` preset steps: its resource knobs
/// stepped toward the lower preset's ([`demote_quality`]). `low` has no lower preset.
pub fn demoted_quality(current: &Quality, preset: QualityPreset, class: DeviceClass, levels: u8) -> Quality {
    let index = QualityPreset::ALL.iter().position(|candidate| *candidate == preset).unwrap_or(0);
    let lower = QualityPreset::ALL[index.saturating_sub(usize::from(levels))];
    if lower == preset {
        return *current;
    }
    demote_quality(current, &preset_quality(lower, class))
}
