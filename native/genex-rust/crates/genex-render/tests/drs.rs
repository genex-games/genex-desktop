//! The dynamic-resolution controller (plan §2.6, RQ0.5): scripted measurement sequences with an
//! injected clock, no sleeps and no GPU. Every row drives `DrsController::observe` frame by frame
//! and reads the step it answers.

use std::time::Duration;

use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
use genex_render::drs::{
    DEMOTE_AFTER, DrsController, FrameSignal, MAX_SCALE_STEPS, PROMOTE_AFTER, RISE_AFTER_FRAMES, SCALE_QUANTUM, ScaleSteps,
    THERMAL_RECOVER_AFTER, demote_quality, frame_signal,
};
use genex_render::presets::class_defaults;
use genex_render::settings::{AntiAliasing, AoResolution, Quality, ShadowFilter, Upscaler};

const DESKTOP_MID: DeviceClass = DeviceClass::new(FormFactor::Desktop, PerformanceTier::Mid);
const MOBILE_HIGH: DeviceClass = DeviceClass::new(FormFactor::Mobile, PerformanceTier::High);
/// The GPU cost of a frame at scale 1.0 and load 1.0: under the 75% calm line of a 60 Hz class.
const BASE_GPU_MS: f32 = 10.0;

/// A simulated clock: one frame of a 60 Hz class per tick.
struct Sim {
    drs: DrsController,
    frame: u32,
    trace: Vec<usize>,
}

impl Sim {
    fn new(drs: DrsController) -> Sim {
        Sim { drs, frame: 0, trace: Vec::new() }
    }

    fn now(&self) -> Duration {
        Duration::from_micros(16_667) * self.frame
    }

    /// One frame whose GPU cost is the scripted load at the current scale (cost ∝ pixels).
    fn gpu_frame(&mut self, load: f32) -> f32 {
        let scale = self.drs.scale();
        let ms = BASE_GPU_MS * load * scale * scale;
        self.signal(FrameSignal::GpuMs(ms));
        ms
    }

    fn signal(&mut self, signal: FrameSignal) -> usize {
        self.frame += 1;
        let step = self.drs.observe(signal, self.now());
        self.trace.push(step);
        step
    }

    /// Frame indices at which the step changed.
    fn changes(&self) -> Vec<usize> {
        self.trace.windows(2).enumerate().filter(|(_, pair)| pair[0] != pair[1]).map(|(index, _)| index + 1).collect()
    }
}

fn top_step(drs: &DrsController) -> usize {
    drs.steps().steps().len() - 1
}

#[test]
fn class_steps_are_bucketed_to_thirty_seconds_inside_the_range_and_include_the_nominal_scale() {
    for class in DeviceClass::ALL {
        let drs = DrsController::for_class(class);
        let steps = drs.steps().steps();
        assert!(!steps.is_empty() && steps.len() <= MAX_SCALE_STEPS, "{}: {steps:?}", class.wire());
        assert!(steps.windows(2).all(|pair| pair[0] < pair[1]), "{}: ascending, no duplicates: {steps:?}", class.wire());
        for scale in steps {
            let buckets = scale / SCALE_QUANTUM;
            assert_eq!(buckets, buckets.round(), "{}: {scale} is a whole number of 1/32 buckets", class.wire());
        }
        let nominal = drs.steps().steps()[drs.nominal_step()];
        assert_eq!(drs.step(), drs.nominal_step(), "{} starts at its nominal step", class.wire());
        assert!(drs.gpu_target_ms() > 0.0);
        let _ = nominal;
    }
    let steps = ScaleSteps::over((0.6, 1.0), MAX_SCALE_STEPS);
    let (lowest, highest) = (steps.steps()[0], steps.steps()[steps.steps().len() - 1]);
    assert!(lowest >= 0.6 && highest <= 1.0, "clamped to the class range: {:?}", steps.steps());
    let with_nominal = ScaleSteps::with_nominal((0.6, 0.85), MAX_SCALE_STEPS, 0.75);
    assert!(with_nominal.steps().contains(&0.75), "the nominal scale is a step: {:?}", with_nominal.steps());
}

#[test]
fn a_2x_load_step_lowers_the_scale_within_3_frames_and_holds_the_target() {
    let mut sim = Sim::new(DrsController::for_class(DESKTOP_MID));
    let target = sim.drs.gpu_target_ms();
    for _ in 0..60 {
        sim.gpu_frame(1.0);
    }
    assert_eq!(sim.drs.step(), top_step(&sim.drs), "a calm load at the top step stays there");
    let before = sim.drs.step();
    let mut lowered_at = None;
    for frame in 1..=3 {
        sim.gpu_frame(2.0);
        if sim.drs.step() < before && lowered_at.is_none() {
            lowered_at = Some(frame);
        }
    }
    assert!(lowered_at.is_some(), "a 2x load lowers the scale within 3 frames: trace {:?}", sim.trace);
    for _ in 0..30 {
        sim.gpu_frame(2.0);
    }
    let held = sim.drs.step();
    for frame in 0..300 {
        let ms = sim.gpu_frame(2.0);
        assert!(ms <= target, "frame {frame}: {ms} ms over the {target} ms target at scale {}", sim.drs.scale());
    }
    assert_eq!(sim.drs.step(), held, "the scale holds once the target is met");
    assert!(sim.drs.step() > 0, "a 2x load does not fall to the minimum step");
}

#[test]
fn recovery_raises_the_scale_only_after_30_calm_frames() {
    let mut sim = Sim::new(DrsController::for_class(DESKTOP_MID));
    for _ in 0..60 {
        sim.gpu_frame(2.0);
    }
    let lowered = sim.drs.step();
    assert!(lowered < top_step(&sim.drs));
    for frame in 1..RISE_AFTER_FRAMES {
        sim.gpu_frame(1.0);
        assert_eq!(sim.drs.step(), lowered, "calm frame {frame} of {RISE_AFTER_FRAMES} does not raise the scale");
    }
    sim.gpu_frame(1.0);
    assert_eq!(sim.drs.step(), lowered + 1, "the 30th calm frame raises the scale one step");
    for _ in 0..600 {
        sim.gpu_frame(1.0);
    }
    assert_eq!(sim.drs.step(), top_step(&sim.drs), "a calm load climbs back to the top step");
}

#[test]
fn oscillating_load_does_not_flap_more_than_once_per_30_frames() {
    // A fast square wave (10 heavy, 10 light) and a noisy load around the target.
    let fast = |frame: u32| if (frame / 10).is_multiple_of(2) { 2.0f32 } else { 1.0 };
    let noisy = |frame: u32| if frame.is_multiple_of(2) { 1.55f32 } else { 1.25 };
    // A slow wave (40 heavy, 40 light): a rise that fails backs the next rise off.
    let slow = |frame: u32| if (frame / 40).is_multiple_of(2) { 2.0f32 } else { 1.0 };
    for (name, load) in [("fast", &fast as &dyn Fn(u32) -> f32), ("noisy", &noisy), ("slow", &slow)] {
        let mut sim = Sim::new(DrsController::for_class(DESKTOP_MID));
        for frame in 0..1200 {
            sim.gpu_frame(load(frame));
        }
        let changes = sim.changes();
        if name != "slow" {
            for pair in changes.windows(2) {
                assert!(pair[1] - pair[0] >= 30, "{name}: changes at frames {} and {} are under 30 frames apart", pair[0], pair[1]);
            }
        }
        assert!(changes.len() <= 4, "{name}: {} step changes over 1200 frames: {changes:?}", changes.len());
    }
}

#[test]
fn minimum_scale_overload_demotes_the_preset_after_5_simulated_seconds_and_calm_re_promotes_after_20() {
    let mut sim = Sim::new(DrsController::for_class(DESKTOP_MID));
    let mut at_minimum_since = None;
    let mut demoted_at = None;
    while sim.frame < 60 * 30 {
        sim.gpu_frame(10.0);
        if sim.drs.step() == 0 && at_minimum_since.is_none() {
            at_minimum_since = Some(sim.now());
        }
        if sim.drs.demotion() == 1 && demoted_at.is_none() {
            demoted_at = Some(sim.now());
            break;
        }
    }
    let (since, demoted) = (at_minimum_since.expect("reaches the minimum step"), demoted_at.expect("demotes the preset"));
    let held = demoted - since;
    assert!(held >= DEMOTE_AFTER, "demoted after only {held:?} at the minimum step");
    assert!(held <= DEMOTE_AFTER + Duration::from_millis(100), "demoted {held:?} after reaching the minimum step");
    for _ in 0..60 * 6 {
        sim.gpu_frame(10.0);
    }
    assert_eq!(sim.drs.demotion(), 2, "another 5 s of overload demotes again");
    let calm_from = sim.now();
    let mut promoted_at = None;
    while sim.frame < 60 * 120 {
        sim.gpu_frame(0.2);
        if sim.drs.demotion() == 1 {
            promoted_at = Some(sim.now());
            break;
        }
    }
    let promoted = promoted_at.expect("calm re-promotes") - calm_from;
    assert!(promoted >= PROMOTE_AFTER, "re-promoted after only {promoted:?} under 50%");
    assert!(promoted <= PROMOTE_AFTER + Duration::from_millis(100), "re-promoted {promoted:?} after calm began");
}

#[test]
fn the_controller_is_deterministic_for_a_given_measurement_sequence() {
    let run = || {
        let mut sim = Sim::new(DrsController::for_class(MOBILE_HIGH));
        let mut demotions = Vec::new();
        for frame in 0..3000u32 {
            let load = 0.6 + (frame.wrapping_mul(2_654_435_761) >> 28) as f32 * 0.17;
            sim.gpu_frame(load);
            demotions.push(sim.drs.demotion());
        }
        (sim.trace, demotions)
    };
    assert_eq!(run(), run());
}

#[test]
fn captures_render_at_the_nominal_step_whatever_the_controller_did() {
    let mut sim = Sim::new(DrsController::for_class(DESKTOP_MID));
    for _ in 0..60 {
        sim.gpu_frame(3.0);
    }
    assert_ne!(sim.drs.step(), sim.drs.nominal_step());
    assert_eq!(sim.drs.capture_step(), sim.drs.nominal_step(), "DRS never applies to captures");
    assert_eq!(sim.drs.capture_scale(), sim.drs.steps().steps()[sim.drs.nominal_step()]);
}

#[test]
fn an_interval_only_sequence_pinned_at_16_7_ms_holds_the_nominal_step() {
    for class in [MOBILE_HIGH, DESKTOP_MID] {
        let mut sim = Sim::new(DrsController::for_class(class));
        let nominal = sim.drs.nominal_step();
        // Ten simulated minutes of a vsync-locked display that never says how busy the GPU is.
        for frame in 0..36_000 {
            let step = sim.signal(FrameSignal::IntervalOnly(16.7));
            assert_eq!(step, nominal, "{}: frame {frame} left the nominal step", class.wire());
        }
        assert_eq!(sim.drs.demotion(), 0);
    }
}

#[test]
fn interval_only_drops_on_missed_vsyncs_and_probes_back_up_with_hysteresis() {
    let mut sim = Sim::new(DrsController::for_class(MOBILE_HIGH));
    let nominal = sim.drs.nominal_step();
    // One hitch is not a trend.
    sim.signal(FrameSignal::IntervalOnly(33.4));
    for _ in 0..20 {
        sim.signal(FrameSignal::IntervalOnly(16.7));
    }
    assert_eq!(sim.drs.step(), nominal, "a single missed vsync does not drop the scale");
    // Sustained misses drop it within a few frames.
    for _ in 0..4 {
        sim.signal(FrameSignal::IntervalOnly(33.4));
    }
    assert!(sim.drs.step() < nominal, "sustained missed vsyncs drop the scale: {:?}", sim.trace);
    let dropped = sim.drs.step();
    // Calm frames: a timed probe raises the scale back toward the nominal step, never above it.
    let calm_from = sim.now();
    while sim.drs.step() == dropped && sim.frame < 60 * 60 {
        sim.signal(FrameSignal::IntervalOnly(16.7));
    }
    let probed = sim.now() - calm_from;
    assert_eq!(sim.drs.step(), dropped + 1, "a probe moves one step");
    assert!(probed >= Duration::from_secs(1), "the probe waits for calm ({probed:?})");
    // The probe misses vsync: it reverts, and the next probe waits longer (hysteresis).
    for _ in 0..4 {
        sim.signal(FrameSignal::IntervalOnly(33.4));
    }
    assert_eq!(sim.drs.step(), dropped, "a failed probe reverts");
    let calm_from = sim.now();
    while sim.drs.step() == dropped && sim.frame < 60 * 120 {
        sim.signal(FrameSignal::IntervalOnly(16.7));
    }
    let second = sim.now() - calm_from;
    assert!(second > probed, "after a failed probe the next waits longer ({second:?} vs {probed:?})");
    for _ in 0..60 * 120 {
        sim.signal(FrameSignal::IntervalOnly(16.7));
    }
    assert_eq!(sim.drs.step(), nominal, "calm interval-only frames return to the nominal step and stop there");
}

#[test]
fn a_frame_signal_is_gpu_ms_only_with_timestamps() {
    assert_eq!(frame_signal(Some(7.5), 16.7), FrameSignal::GpuMs(7.5));
    assert_eq!(frame_signal(None, 16.7), FrameSignal::IntervalOnly(16.7));
}

#[test]
fn a_runtime_demotion_never_changes_the_sample_count_or_pipeline_keys() {
    let mut high = Quality::off();
    high.anti_aliasing = AntiAliasing::Taa;
    high.upscaler = Upscaler::Fsr1;
    high.shadows.cascades = 4;
    high.shadows.map_size = 2048;
    high.shadows.filter = ShadowFilter::Pcss;
    high.bloom.enabled = true;
    high.bloom.resolution = genex_render::post::bloom::CHAIN_RESOLUTION;
    high.ao.resolution = AoResolution::Full;
    high.ao.slices = 3;
    high.ao.temporal = true;
    high.environment.ibl = true;
    high.environment.cube_size = 256;
    high.lights.cap = 1024;
    high.lights.shadowed_spots = 4;
    // The lower preset differs in pipeline knobs too (MSAA, PCF, no IBL): those must not follow.
    let mut low = Quality::off();
    low.shadows.cascades = 1;
    low.shadows.map_size = 1024;
    low.bloom.enabled = false;
    low.ao.resolution = AoResolution::Off;
    low.lights.cap = 64;
    for lower in [low, Quality::off()] {
        let demoted = demote_quality(&high, &lower);
        assert_eq!(demoted.pipeline_key(), high.pipeline_key(), "a demotion keeps every pipeline knob");
        assert_eq!(demoted.anti_aliasing.samples(), high.anti_aliasing.samples(), "a demotion keeps the sample count");
        assert!(high.resource_change_only(&demoted));
        assert!(demoted.shadows.cascades <= high.shadows.cascades && demoted.shadows.cascades >= 1);
        assert!(demoted.shadows.map_size <= high.shadows.map_size && demoted.shadows.map_size > 0);
        assert!(demoted.lights.cap <= high.lights.cap);
        assert!(demoted.environment.cube_size > 0, "IBL stays on, so its cube keeps a size");
        assert_eq!(demoted.render_scale, high.render_scale, "the scale is DRS's, not the demotion's");
    }
    let demoted = demote_quality(&high, &low);
    assert_eq!((demoted.shadows.cascades, demoted.shadows.map_size, demoted.lights.cap), (1, 1024, 64));
    assert!(!demoted.bloom.enabled && demoted.ao.resolution == AoResolution::Off);
    // A demotion never raises a knob the person turned down.
    let mut person = high;
    person.bloom.enabled = false;
    person.shadows.map_size = 512;
    let mut medium = low;
    medium.bloom.enabled = true;
    medium.shadows.map_size = 1536;
    let demoted = demote_quality(&person, &medium);
    assert!(!demoted.bloom.enabled && demoted.shadows.map_size == 512);
}

#[test]
fn a_class_runs_its_own_table_s_steps_bucketed_with_its_nominal_scale() {
    let bucket = |scale: f32| (scale / SCALE_QUANTUM).round() * SCALE_QUANTUM;
    for class in DeviceClass::ALL {
        let defaults = class_defaults(class);
        let drs = DrsController::for_class(class);
        let mut table: Vec<f32> = defaults.drs_steps.iter().map(|scale| bucket(*scale)).collect();
        table.dedup();
        assert_eq!(drs.steps().steps(), table.as_slice(), "{} runs its table", class.wire());
        assert_eq!(drs.scale(), bucket(defaults.nominal_scale), "{} starts at its nominal scale", class.wire());
    }
    let widened = ScaleSteps::table(&[0.6, 0.75, 0.85], 1.0);
    assert_eq!(widened.steps(), &[bucket(0.6), 0.75, bucket(0.85), 1.0], "a nominal scale outside the table is added");
}

#[test]
fn thermal_load_holds_mobile_mid_at_30_fps_and_its_own_rate_returns_only_after_a_cool_spell() {
    let mobile_mid = DeviceClass::new(FormFactor::Mobile, PerformanceTier::Mid);
    let mut drs = DrsController::for_class(mobile_mid);
    let own = drs.frame_interval();
    assert_eq!(own, Duration::from_secs(1) / 60);
    let at = |seconds: u64| Duration::from_secs(seconds);
    assert!(drs.set_thermal(true, at(1)), "load switches to the sustained rate at once");
    assert_eq!(drs.frame_interval(), Duration::from_secs(1) / 30);
    assert!(drs.sustained());
    assert!(!drs.set_thermal(false, at(2)), "one cool reading is not enough");
    assert!(!drs.set_thermal(true, at(5)), "load again restarts the cool spell");
    assert!(!drs.set_thermal(false, at(6)));
    assert!(!drs.set_thermal(false, at(6) + THERMAL_RECOVER_AFTER - Duration::from_millis(1)));
    assert!(drs.set_thermal(false, at(6) + THERMAL_RECOVER_AFTER), "a full cool spell gives the class's rate back");
    assert_eq!(drs.frame_interval(), own);
    // A 30 fps frame interval is no missed vsync while the sustained rate is held.
    let mut held = DrsController::for_class(mobile_mid);
    held.set_thermal(true, Duration::ZERO);
    let nominal = held.step();
    for frame in 0..120u32 {
        held.observe(FrameSignal::IntervalOnly(33.3), Duration::from_micros(33_333) * frame);
    }
    assert_eq!(held.step(), nominal, "33 ms frames hold the step at 30 fps");
    let mut desktop = DrsController::for_class(DESKTOP_MID);
    assert!(!desktop.set_thermal(true, Duration::ZERO), "a class without a sustained rate keeps its own");
    assert_eq!(desktop.frame_interval(), Duration::from_secs(1) / 60);
}
