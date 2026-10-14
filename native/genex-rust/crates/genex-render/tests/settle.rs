//! RQ1.5: settled captures (K re-renders of one Sim state on a capture-owned history) and the Live
//! history reset rules. RQ5.4: K is the jitter cycle with TAA or temporal AO drawn, the re-renders
//! walk the cycle from index 0, TAA keeps a capture-owned history, and a capture is independent of
//! Live's history, of Live's scale step and of where the sun was at the last capture.
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test settle -- --ignored metal
//!
//! `GENEX_RENDER_EVIDENCE_DIR` receives the compared frames (raw BGRA, `<name>.bgra`, with the size
//! in the row); `GENEX_PERF_OUT` receives the settled-capture latency rows as JSON lines (appended).

use std::path::PathBuf;
use std::time::Duration;

use genex_render::capture::Capture;
use genex_render::immediate::ImmediateFrame;
use genex_render::scene::{CameraDesc, translation};
use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
use genex_render::jitter::offset_px;
use genex_render::presets::preset_quality;
use genex_render::settings::{AntiAliasing, AoResolution, Environment, ExposureMode, JitterCycle, Look, Quality, QualityPreset, SceneFormat, TaaQuality};
use genex_render::settle::{
    AUTO_EXPOSURE_SETTLE_FRAMES, FrameHistory, GRADED_EXPOSURE_SETTLE_FRAMES, HistoryKey, HistoryReset, HistorySet, LiveFrame, LiveHistory, SETTLE_FRAMES_MAX, SettleFrame, SettleHooks,
    SettlePlan, TaaHistories, camera_cut, settle_frames, settle_plan,
};
use genex_render::{CullPath, FrameRenderer, Gpu, RenderOptions};

const WIDTH: u32 = 128;
const HEIGHT: u32 = 72;
/// A settled capture lands on the converged Live exposure within this mean 8-bit level (the
/// frame-keyed dither moves single pixels by one level).
const CONVERGED_MEAN_LEVELS: f64 = 0.75;
/// Auto exposure on a bright scene moves the picture by more than this mean level from exposure 1.
const EXPOSED_MEAN_LEVELS: f64 = 8.0;
/// A settled capture at K = 1 may take at most this many times a plain render and readback.
const SETTLE_LATENCY_RATIO_MAX: f64 = 2.0;
/// Timed repetitions of each kind of capture (the median is compared).
const LATENCY_RUNS: usize = 15;

// ---------------------------------------------------------------------------------------------
// CPU rows

fn hdr_quality() -> Quality {
    let mut quality = Quality::off();
    quality.hdr = true;
    quality.tonemap = true;
    quality.exposure = true;
    quality
}

/// Auto exposure adapting `speed` EV per second both ways.
fn auto_look(speed: f32) -> Look {
    let mut look = Look::default();
    look.exposure = ExposureMode::Auto;
    look.adaptation_up = speed;
    look.adaptation_down = speed;
    look
}

#[test]
fn a_capture_settles_twice_with_auto_exposure_on_the_hdr_path_and_once_otherwise() {
    let (hdr, off) = (hdr_quality(), Quality::off());
    assert_eq!(settle_frames(&hdr, &auto_look(3.0), true), AUTO_EXPOSURE_SETTLE_FRAMES);
    assert_eq!(settle_frames(&hdr, &Look::default(), true), 1, "manual exposure has no history");
    assert_eq!(settle_frames(&hdr, &auto_look(3.0), false), 1, "an LDR session never meters");
    assert_eq!(settle_frames(&off, &auto_look(3.0), true), 1, "the legacy renderer never meters");
    let mut switched_off = hdr;
    switched_off.exposure = false;
    assert_eq!(settle_frames(&switched_off, &auto_look(3.0), true), 1, "the exposure switch off is exposure 1");
}

/// The class the temporal rows draw on (its high and ultra presets keep AO's history and ask for
/// TAA).
const DESKTOP: DeviceClass = DeviceClass::new(FormFactor::Desktop, PerformanceTier::Ultra);

/// [`hdr_quality`] with high's GTAO, which keeps its own history.
fn temporal_ao_quality() -> Quality {
    let mut quality = hdr_quality();
    quality.prepass = true;
    quality.ao = preset_quality(QualityPreset::High, DESKTOP).ao;
    assert!(quality.ao.temporal && quality.ao.resolution != AoResolution::Off);
    quality
}

#[test]
fn a_capture_settles_one_whole_jitter_cycle_with_temporal_ao_or_taa_drawn() {
    let high = preset_quality(QualityPreset::High, DESKTOP);
    assert!(high.ao.temporal && high.anti_aliasing.temporal(), "high keeps AO's history and asks for TAA");
    let cycle = high.taa.jitter_cycle.frames();
    assert_eq!(cycle, 8);
    assert_eq!(settle_frames(&high, &Look::default(), true), cycle, "one whole jitter cycle");
    assert_eq!(settle_frames(&high, &auto_look(3.0), true), cycle, "auto exposure settles inside the cycle");
    let mut sixteen = high;
    sixteen.taa = TaaQuality::DEFAULT.with_jitter_cycle(JitterCycle::Sixteen);
    assert_eq!(settle_frames(&sixteen, &Look::default(), true), 16, "the ultra cycle");
    // AO that keeps no history, or draws nothing, adds no re-render.
    let medium = preset_quality(QualityPreset::Medium, DESKTOP);
    assert!(!medium.ao.temporal);
    assert_eq!(settle_frames(&medium, &Look::default(), true), 1);
    let mut no_strength = Look::default();
    no_strength.ao_intensity = 0.0;
    let ao_only = temporal_ao_quality();
    assert_eq!(settle_frames(&ao_only, &no_strength, true), 1, "AO at no strength is not drawn");
    assert_eq!(settle_frames(&ao_only, &Look::default(), true), cycle, "temporal AO alone walks the cycle");
    // TAA alone counts once this build draws it, and only on the HDR scene it resolves.
    let mut taa_only = hdr_quality();
    taa_only.anti_aliasing = AntiAliasing::Taa;
    let drawn = genex_render::graph::feature_drawn(&taa_only, genex_render::settings::RenderFeature::Taa);
    assert_eq!(settle_frames(&taa_only, &Look::default(), true), if drawn { cycle } else { 1 }, "TAA drawn: {drawn}");
    assert_eq!(settle_frames(&taa_only, &Look::default(), false), 1, "an LDR session draws no TAA");
}

#[test]
fn the_settle_plan_names_the_history_a_capture_includes() {
    let high = preset_quality(QualityPreset::High, DESKTOP);
    let plan = settle_plan(&high, &auto_look(3.0), true);
    let taa = genex_render::graph::feature_drawn(&high, genex_render::settings::RenderFeature::Taa);
    assert_eq!(plan, SettlePlan { frames: 8, auto_exposure: true, taa, temporal_ao: true, jitter_cycle: Some(JitterCycle::Eight) });
    let plain = settle_plan(&hdr_quality(), &Look::default(), true);
    assert_eq!(plain, SettlePlan { frames: 1, auto_exposure: false, taa: false, temporal_ao: false, jitter_cycle: None }, "nothing temporal");
    let metered = settle_plan(&hdr_quality(), &auto_look(3.0), true);
    assert_eq!((metered.frames, metered.auto_exposure, metered.jitter_cycle), (AUTO_EXPOSURE_SETTLE_FRAMES, true, None));
    assert!(SettlePlan::history_reset(), "every capture starts its history over");
}

#[test]
fn a_settled_capture_walks_every_jitter_position_once_from_index_zero() {
    for cycle in JitterCycle::ALL {
        let mut quality = temporal_ao_quality();
        quality.taa = TaaQuality::DEFAULT.with_jitter_cycle(cycle);
        let count = settle_frames(&quality, &Look::default(), true);
        assert_eq!(count, cycle.frames());
        let mut frame = SettleFrame::first(count);
        let mut offsets = Vec::new();
        loop {
            let history = FrameHistory::settled(frame);
            offsets.push(offset_px(history.frame_index, cycle));
            if frame.is_last() {
                break;
            }
            frame = frame.next();
        }
        assert_eq!(offsets[0], offset_px(0, cycle), "the first re-render is the reset's position");
        let mut distinct = offsets.clone();
        distinct.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        distinct.dedup();
        assert_eq!(distinct.len() as u32, cycle.frames(), "every position of the {} cycle, once", cycle.frames());
    }
}

#[test]
fn settle_frames_count_from_zero_and_the_last_one_is_read_back() {
    let first = SettleFrame::first(3);
    assert_eq!(first, SettleFrame { index: 0, count: 3 });
    assert!(!first.is_last());
    let last = first.next().next();
    assert!(last.is_last() && last.index == 2);
    assert_eq!(last.next(), last, "never past the last re-render");
    assert_eq!(SettleFrame::first(0).count, 1, "at least one re-render");
    assert_eq!(SettleFrame::first(1000).count, SETTLE_FRAMES_MAX);
    let settled = FrameHistory::settled(SettleFrame { index: 1, count: 2 });
    assert_eq!((settled.set, settled.frame_index, settled.ticks), (HistorySet::Capture, 1, 0));
    let fresh = FrameHistory::settled(SettleFrame::first(2));
    assert!(fresh.history_reset() && fresh.reset == Some(HistoryReset::Capture), "{fresh:?}");
}

fn key(output: (u32, u32), render: (u32, u32), quality: Quality) -> HistoryKey {
    HistoryKey { output, render, quality }
}

fn live<'a>(tick: u64, camera: &'a CameraDesc, key: HistoryKey) -> LiveFrame<'a> {
    LiveFrame { tick: Some(tick), paced_ticks: None, key, camera, cut: false }
}

// RQ5 review flipped this row: the frame index counted rendered sim ticks (3 after a same-tick
// redraw, 7 after a paced frame of 4), so a device drawing every second tick walked only the odd
// jitter positions. It counts drawn frames now; ticks stay what adaptation moves by.
#[test]
fn live_history_counts_drawn_frames_and_a_same_tick_redraw_adapts_by_none() {
    let camera = CameraDesc::look_at([0.0, 2.0, 6.0], [0.0, 0.0, 0.0]);
    let k = key((128, 72), (128, 72), hdr_quality());
    let mut history = LiveHistory::default();
    let first = history.step(live(10, &camera, k));
    assert_eq!((first.frame_index, first.ticks, first.reset), (0, 1, None), "a first frame has no history");
    assert!(first.history_reset());
    let next = history.step(live(12, &camera, k));
    assert_eq!((next.frame_index, next.ticks), (1, 2), "two ticks ran in one drawn frame");
    let again = history.step(live(12, &camera, k));
    assert_eq!((again.frame_index, again.ticks), (2, 0), "the same tick drawn again does not adapt");
    assert_eq!(history.frame_index(), 3);
    let paced = history.step(LiveFrame { paced_ticks: Some(4), ..live(13, &camera, k) });
    assert_eq!((paced.frame_index, paced.ticks), (3, 4), "a paced shell's count wins for adaptation");
    assert_eq!(history.frame_index(), 4);
}

// RQ5 review: a phone under thermal load (or a throttled tab) draws every second 60 Hz tick. Keyed
// to ticks, its jitter took Halton indices 1, 3, 5, 7 only: x offsets 0, +0.25, +0.125, +0.375 px,
// half the pixel with a +0.19 px bias. Keyed to drawn frames it walks the whole cycle.
#[test]
fn a_device_drawing_every_second_tick_walks_every_jitter_position_with_no_bias() {
    let camera = CameraDesc::look_at([0.0, 2.0, 6.0], [0.0, 0.0, 0.0]);
    let k = key((128, 72), (128, 72), hdr_quality());
    for cadence in [2u32, 3] {
        let mut history = LiveHistory::default();
        let offsets: Vec<[f32; 2]> = (0..8u64)
            .map(|frame| {
                let drawn = history.step(LiveFrame { paced_ticks: Some(cadence), ..live(frame * u64::from(cadence), &camera, k) });
                offset_px(drawn.frame_index, JitterCycle::Eight)
            })
            .collect();
        let mut distinct = offsets.clone();
        distinct.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        distinct.dedup();
        assert_eq!(distinct.len(), 8, "cadence {cadence}: every position of the cycle once");
        for axis in 0..2 {
            let mean = offsets.iter().map(|offset| offset[axis]).sum::<f32>() / 8.0;
            assert!(mean.abs() < 0.07, "cadence {cadence}: axis {axis} mean {mean} is near the pixel centre");
        }
    }
}

#[test]
fn live_history_starts_over_on_each_reset_rule() {
    let camera = CameraDesc::look_at([0.0, 2.0, 6.0], [0.0, 0.0, 0.0]);
    let base = key((128, 72), (128, 72), hdr_quality());
    let mut demoted = hdr_quality();
    demoted.exposure_input_divisor = demoted.exposure_input_divisor.saturating_mul(2).max(2);
    let mut switched = hdr_quality();
    switched.fog = !switched.fog;
    // RQ5 review flipped (named in the log): a change of resource knobs only (a demotion's) keeps
    // every history; a pipeline-shaping change still starts it over.
    let mut kept = LiveHistory::default();
    kept.step(live(1, &camera, base));
    assert_eq!(kept.step(live(2, &camera, key((128, 72), (128, 72), demoted))).reset, None, "a resource-only change keeps history");
    let cases = [
        (key((256, 144), (256, 144), hdr_quality()), HistoryReset::Resize),
        (key((128, 72), (96, 54), hdr_quality()), HistoryReset::ScaleStep),
        (key((128, 72), (128, 72), switched), HistoryReset::Settings),
    ];
    for (changed, reason) in cases {
        let mut history = LiveHistory::default();
        history.step(live(1, &camera, base));
        history.step(live(2, &camera, base));
        let reset = history.step(live(3, &camera, changed));
        assert_eq!((reset.reset, reset.frame_index), (Some(reason), 0), "{reason:?}");
        assert_eq!(history.step(live(4, &camera, changed)).frame_index, 1, "{reason:?}: history runs on from the reset");
    }
    let mut history = LiveHistory::default();
    history.step(live(5, &camera, base));
    let rewound = history.step(live(2, &camera, base));
    assert_eq!(rewound.reset, Some(HistoryReset::Rewind));
    let cut = history.step(LiveFrame { cut: true, ..live(3, &camera, base) });
    assert_eq!(cut.reset, Some(HistoryReset::CameraCut), "an explicit cut");
    history.reset(HistoryReset::DeviceRecreated);
    assert_eq!(history.step(live(4, &camera, base)).reset, Some(HistoryReset::DeviceRecreated));
    assert_eq!(history.step(live(5, &camera, base)).reset, None, "a reset is consumed by one frame");
}

#[test]
fn exposure_snaps_only_on_a_new_shot_or_timeline() {
    for reason in [HistoryReset::CameraCut, HistoryReset::DeviceRecreated, HistoryReset::Rewind, HistoryReset::Capture] {
        assert!(reason.resets_exposure(), "{reason:?}");
    }
    for reason in [HistoryReset::Resize, HistoryReset::ScaleStep, HistoryReset::Settings] {
        assert!(!reason.resets_exposure(), "{reason:?}: the same scene keeps adapting smoothly");
    }
}

#[test]
fn a_camera_jump_is_a_cut_and_smooth_motion_is_not() {
    let camera = CameraDesc::look_at([0.0, 2.0, 6.0], [0.0, 0.0, 0.0]);
    let smooth = CameraDesc::look_at([0.1, 2.0, 5.9], [0.0, 0.0, 0.0]);
    assert!(!camera_cut(&camera, &smooth), "a small step");
    assert!(!camera_cut(&camera, &camera), "standing still");
    let teleport = CameraDesc::look_at([30.0, 2.0, 6.0], [30.0, 0.0, 0.0]);
    assert!(camera_cut(&camera, &teleport), "the eye jumped farther than half its reach");
    let turned = CameraDesc::look_at([0.0, 2.0, 6.0], [6.0, 2.0, 6.0]);
    assert!(camera_cut(&camera, &turned), "the view turned 90 degrees");
    assert!(camera_cut(&camera, &camera.orthographic(4.0)), "the projection changed kind");
    let zoomed = CameraDesc { fovy_degrees: 80.0, ..camera };
    assert!(camera_cut(&camera, &zoomed), "the field of view jumped");
    let k = key((128, 72), (128, 72), hdr_quality());
    let mut history = LiveHistory::default();
    history.step(live(1, &camera, k));
    history.step(live(2, &smooth, k));
    assert_eq!(history.step(live(3, &teleport, k)).reset, Some(HistoryReset::CameraCut));
}

// ---------------------------------------------------------------------------------------------
// GPU fixtures

fn gpu() -> Option<Gpu> {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    match Gpu::headless() {
        Ok(gpu) => {
            if require {
                assert_eq!(gpu.receipt().backend, "metal", "GENEX_REQUIRE_METAL=1 but the adapter is not Metal");
            }
            Some(gpu)
        }
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(error) => {
            eprintln!("skipped: no WebGPU-core adapter ({error})");
            None
        }
    }
}

fn write_evidence(name: &str, capture: &Capture) {
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        let dir = PathBuf::from(dir);
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join(format!("{name}.bgra")), capture.bgra()).expect("evidence");
    }
}

/// A renderer drawing the HDR path with `look`.
fn hdr_renderer(gpu: &Gpu, look: Look) -> FrameRenderer {
    let mut renderer = FrameRenderer::new(gpu, WIDTH, HEIGHT, RenderOptions::default()).expect("renderer");
    let part1 = renderer.renderer_mut();
    part1.set_scene_format(SceneFormat::Rgba16Float);
    part1.set_quality(&hdr_quality());
    part1.set_look(look);
    renderer
}

/// A white floor filling the view, a red cube and a blue sphere under a sun of `sun` intensity, at
/// `tick`. No clear colour shows: the clear is written at the CPU's pre-exposure, which auto
/// exposure does not reach (an open renderer seam), so a visible background would feed the
/// metering back into itself.
fn scene(sun: f32, tick: u64) -> ImmediateFrame {
    scene_seen(CameraDesc::look_at([0.0, 7.0, 1.5], [0.0, 0.0, 0.0]), sun, tick)
}

/// [`scene`] seen through `camera`.
fn scene_seen(camera: CameraDesc, sun: f32, tick: u64) -> ImmediateFrame {
    let mut frame = ImmediateFrame::new(camera, [40, 50, 70, 255]);
    frame.lighting_mut().sun_intensity = sun;
    frame.cube(translation(1.2, 0.5, 0.0), [220, 40, 50, 255]);
    frame.sphere([-1.0, 0.6, 1.0], 0.6, [60, 110, 230, 255]);
    frame.cube(genex_render::scene::scaled([0.0, -0.1, 0.0], [12.0, 0.2, 10.0]), [235, 235, 235, 255]);
    frame.set_tick(tick);
    frame
}

/// A Live frame of `frame`, read back.
fn live_frame(renderer: &mut FrameRenderer, gpu: &Gpu, frame: &ImmediateFrame) -> Capture {
    renderer.render(gpu, frame, CullPath::Gpu, None).expect("live frame");
    renderer.capture(gpu).expect("capture")
}

/// A settled capture of `frame`, K from the renderer.
fn settled(renderer: &mut FrameRenderer, gpu: &Gpu, frame: &ImmediateFrame) -> Capture {
    let frames = renderer.settle_frames();
    renderer.render_settled(gpu, frame, CullPath::Gpu, None, frames).expect("settled capture");
    renderer.capture(gpu).expect("capture")
}

/// The mean 8-bit level over every colour channel.
fn mean_level(capture: &Capture) -> f64 {
    let bytes = capture.bgra();
    let sum: u64 = bytes.chunks(4).map(|px| u64::from(px[0]) + u64::from(px[1]) + u64::from(px[2])).sum();
    sum as f64 / (bytes.len() / 4 * 3) as f64
}

// ---------------------------------------------------------------------------------------------
// GPU rows

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_settled_capture_with_auto_exposure_lands_on_the_converged_live_exposure() {
    let Some(gpu) = gpu() else { return };
    // One EV per tick: Live converges within a few frames.
    let look = auto_look(60.0);
    let mut live = hdr_renderer(&gpu, look);
    let mut converged = None;
    for tick in 1..=40 {
        converged = Some(live_frame(&mut live, &gpu, &scene(12.0, tick)));
    }
    let converged = converged.expect("Live frames");
    let mut fixed = hdr_renderer(&gpu, Look::default());
    let unexposed = live_frame(&mut fixed, &gpu, &scene(12.0, 1));
    let mut capture = hdr_renderer(&gpu, look);
    assert_eq!(capture.settle_frames(), AUTO_EXPOSURE_SETTLE_FRAMES);
    let shot = settled(&mut capture, &gpu, &scene(12.0, 1));
    write_evidence("settle-converged-live", &converged);
    write_evidence("settle-exposure-1", &unexposed);
    write_evidence("settle-settled", &shot);
    let (shot_mean, live_mean, fixed_mean) = (mean_level(&shot), mean_level(&converged), mean_level(&unexposed));
    assert!(
        (live_mean - fixed_mean).abs() > EXPOSED_MEAN_LEVELS,
        "the scene is bright enough for auto exposure to move it: live {live_mean:.2}, exposure 1 {fixed_mean:.2}"
    );
    assert!(
        (shot_mean - live_mean).abs() <= CONVERGED_MEAN_LEVELS,
        "the settled capture ({shot_mean:.2}) lands on the converged Live exposure ({live_mean:.2}), not exposure 1 ({fixed_mean:.2})"
    );
    let history = capture.last_history().expect("a frame was drawn");
    assert_eq!(history.set, HistorySet::Capture);
    let last = SettleFrame { index: AUTO_EXPOSURE_SETTLE_FRAMES - 1, count: AUTO_EXPOSURE_SETTLE_FRAMES };
    assert_eq!(history.settle, Some(last), "the read-back frame is the last re-render");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_two_settled_captures_are_byte_identical_after_100_live_frames_of_another_scene() {
    let Some(gpu) = gpu() else { return };
    let look = auto_look(3.0);
    let mut renderer = hdr_renderer(&gpu, look);
    let first = settled(&mut renderer, &gpu, &scene(10.0, 7));
    for tick in 1..=100 {
        renderer.render(&gpu, &scene(0.4, tick), CullPath::Gpu, None).expect("live frame of a dark scene");
    }
    let second = settled(&mut renderer, &gpu, &scene(10.0, 7));
    assert_eq!(first.digest(), second.digest(), "Live history between the captures does not reach them");
    let mut fresh = hdr_renderer(&gpu, look);
    let cold = settled(&mut fresh, &gpu, &scene(10.0, 7));
    assert_eq!(cold.digest(), first.digest(), "a cold renderer captures the same picture");
    write_evidence("settle-twice", &second);
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_capture_leaves_the_next_live_frame_as_it_would_be_on_an_adapting_scene() {
    let Some(gpu) = gpu() else { return };
    // A tenth of an EV per tick: a dark-to-bright jump is still adapting several frames later.
    let look = auto_look(6.0);
    let (mut with_capture, mut without) = (hdr_renderer(&gpu, look), hdr_renderer(&gpu, look));
    for renderer in [&mut with_capture, &mut without] {
        for tick in 1..=10 {
            renderer.render(&gpu, &scene(0.4, tick), CullPath::Gpu, None).expect("dark");
        }
        for tick in 11..=15 {
            renderer.render(&gpu, &scene(12.0, tick), CullPath::Gpu, None).expect("bright");
        }
    }
    let shot = settled(&mut with_capture, &gpu, &scene(12.0, 15));
    let index = with_capture.frame_index();
    assert_eq!(index, without.frame_index(), "a capture does not move Live's frame index");
    let after = live_frame(&mut with_capture, &gpu, &scene(12.0, 16));
    let plain = live_frame(&mut without, &gpu, &scene(12.0, 16));
    write_evidence("settle-live-after-capture", &after);
    write_evidence("settle-live-without-capture", &plain);
    assert_eq!(after.digest(), plain.digest(), "Live frame 16 is the same with and without the capture");
    let history = with_capture.last_history().expect("a Live frame");
    assert_eq!((history.set, history.settle), (HistorySet::Live, None));
    // A hundred ticks later Live has converged (a frame's metering reaches the next frame).
    without.render(&gpu, &scene(12.0, 119), CullPath::Gpu, None).expect("converging");
    let later = live_frame(&mut without, &gpu, &scene(12.0, 120));
    let (plain_mean, later_mean) = (mean_level(&plain), mean_level(&later));
    assert!((later_mean - plain_mean).abs() > EXPOSED_MEAN_LEVELS, "the scene was still adapting at frame 16: {plain_mean:.2} then {later_mean:.2}");
    assert!((mean_level(&shot) - mean_level(&later)).abs() <= CONVERGED_MEAN_LEVELS, "the capture shows the settled exposure");
}

/// Print `row` and append it to `GENEX_PERF_OUT` when set.
fn perf_row(row: &str) {
    use std::io::Write;
    eprintln!("{row}");
    if let Ok(path) = std::env::var("GENEX_PERF_OUT") {
        let mut file = std::fs::OpenOptions::new().create(true).append(true).open(path).expect("perf file");
        writeln!(file, "{row}").expect("perf row");
    }
}

/// The median of `runs` timings of `work`.
fn median(runs: usize, mut work: impl FnMut()) -> Duration {
    let mut times: Vec<Duration> = (0..runs)
        .map(|_| {
            #[allow(clippy::disallowed_types, reason = "a latency row times the host")]
            let start = std::time::Instant::now();
            work();
            start.elapsed()
        })
        .collect();
    times.sort();
    times[runs / 2]
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_settled_capture_at_k_1_costs_at_most_twice_a_plain_capture() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = hdr_renderer(&gpu, Look::default());
    assert_eq!(renderer.settle_frames(), 1, "manual exposure: one re-render");
    let frame = scene(6.0, 3);
    // Warm both paths (pipelines, targets).
    live_frame(&mut renderer, &gpu, &frame);
    settled(&mut renderer, &gpu, &frame);
    let plain = median(LATENCY_RUNS, || {
        live_frame(&mut renderer, &gpu, &frame);
    });
    let settle = median(LATENCY_RUNS, || {
        settled(&mut renderer, &gpu, &frame);
    });
    let ratio = settle.as_secs_f64() / plain.as_secs_f64().max(1e-9);
    let row = format!(
        "{{\"row\":\"settled-capture-latency\",\"k\":1,\"plainMs\":{:.3},\"settledMs\":{:.3},\"ratio\":{ratio:.3}}}",
        plain.as_secs_f64() * 1000.0,
        settle.as_secs_f64() * 1000.0
    );
    perf_row(&row);
    assert!(ratio <= SETTLE_LATENCY_RATIO_MAX, "a settled capture at K = 1 took {ratio:.2}x a plain one");
}

/// The scene from another camera: the floor, the cube and the sphere seen low from the side.
fn scene_from_the_side(tick: u64) -> ImmediateFrame {
    scene_seen(CameraDesc::look_at([5.0, 1.6, 3.5], [0.0, 0.4, 0.0]), 10.0, tick)
}

/// RQ4 review (contract 3): on the high preset AO keeps its own history (temporal, frame-keyed
/// noise), and a settled capture starts it over (FrameRenderer resets it with the capture's
/// history): a settled capture after Live frames from another camera is byte-identical to the same
/// capture from a fresh renderer.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_settled_capture_on_the_high_preset_starts_ao_history_over() {
    use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
    use genex_render::presets::preset_quality;
    use genex_render::settings::QualityPreset;
    let Some(gpu) = gpu() else { return };
    let class = DeviceClass::new(FormFactor::Desktop, PerformanceTier::Ultra);
    let quality = preset_quality(QualityPreset::High, class);
    assert!(quality.ao.temporal, "high's AO keeps its own history");
    let high_renderer = || {
        let options = RenderOptions { msaa: genex_render::renderer::landed_samples(quality.anti_aliasing) > 1 };
        let mut renderer = FrameRenderer::new(&gpu, WIDTH, HEIGHT, options).expect("renderer");
        let part1 = renderer.renderer_mut();
        part1.set_scene_format(SceneFormat::Rgba16Float);
        part1.set_device_class(class);
        part1.set_quality(&quality);
        renderer
    };
    let mut warmed = high_renderer();
    for tick in 1..=12 {
        warmed.render(&gpu, &scene(10.0, tick), CullPath::Gpu, None).expect("live frame");
    }
    let after_live = settled(&mut warmed, &gpu, &scene_from_the_side(7));
    let mut fresh = high_renderer();
    let cold = settled(&mut fresh, &gpu, &scene_from_the_side(7));
    write_evidence("settle-ao-after-live", &after_live);
    write_evidence("settle-ao-cold", &cold);
    let differing = after_live.bgra().chunks(4).zip(cold.bgra().chunks(4)).filter(|(a, b)| a != b).count();
    assert_eq!(after_live.digest(), cold.digest(), "Live AO history reaches the settled capture in {differing} pixels");
}

// ---------------------------------------------------------------------------------------------
// RQ5.4: temporal settle

/// A settled capture at K = 8 and 1280x720 takes at most this (acceptance, on the M4 Max).
const SETTLE_K8_720P_MS_MAX: f64 = 150.0;
/// Timed settled captures of the 720p row (the median is compared).
const K8_RUNS: usize = 7;
/// Live frames the history-independence rows draw before their capture.
const LIVE_FRAMES: u64 = 100;

/// A renderer drawing `preset` on [`DESKTOP`] at `size`, the HDR scene, with `look`.
fn preset_renderer(gpu: &Gpu, preset: QualityPreset, look: Look, size: (u32, u32)) -> FrameRenderer {
    let quality = preset_quality(preset, DESKTOP);
    let options = RenderOptions { msaa: genex_render::renderer::landed_samples(quality.anti_aliasing) > 1 };
    let mut renderer = FrameRenderer::new(gpu, size.0, size.1, options).expect("renderer");
    let part1 = renderer.renderer_mut();
    part1.set_scene_format(SceneFormat::Rgba16Float);
    part1.set_device_class(DESKTOP);
    part1.set_quality(&quality);
    part1.set_look(look);
    renderer
}

/// The high preset (TAA asked for, GTAO with its own history) under auto exposure.
fn temporal_renderer(gpu: &Gpu) -> FrameRenderer {
    preset_renderer(gpu, QualityPreset::High, auto_look(3.0), (WIDTH, HEIGHT))
}

/// A frame of the scene seen from a camera circling it at `tick`, the sun at `sun`: Live's
/// history of another shot.
fn circling(tick: u64, sun: f32) -> ImmediateFrame {
    let angle = tick as f32 * 0.05;
    let eye = [6.0 * libm::sinf(angle), 2.5, 6.0 * libm::cosf(angle)];
    scene_seen(CameraDesc::look_at(eye, [0.0, 0.3, 0.0]), sun, tick)
}

/// The differing pixels of two captures.
fn differing(a: &Capture, b: &Capture) -> usize {
    a.bgra().chunks(4).zip(b.bgra().chunks(4)).filter(|(p, q)| p != q).count()
}

/// The red-first row of RQ5.4: with TAA asked for, GTAO keeping its own history and auto
/// exposure, a settled capture walks one whole jitter cycle on its own history, so two captures
/// of one state after different Live histories (and a cold renderer's) are byte-identical.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_with_taa_gtao_and_auto_exposure_settled_captures_after_different_live_histories_are_byte_identical() {
    let Some(gpu) = gpu() else { return };
    let (mut circled, mut dark) = (temporal_renderer(&gpu), temporal_renderer(&gpu));
    let quality = *circled.renderer().quality();
    assert!(quality.ao.temporal && quality.anti_aliasing.temporal() && quality.hdr, "{quality:?}");
    let k = quality.taa.jitter_cycle.frames();
    assert_eq!(circled.settle_frames(), k, "K is the jitter cycle");
    for tick in 1..=LIVE_FRAMES {
        circled.render(&gpu, &circling(tick, 12.0), CullPath::Gpu, None).expect("Live frame circling");
    }
    for tick in 1..=37 {
        dark.render(&gpu, &scene(0.4, tick), CullPath::Gpu, None).expect("Live frame of a dark scene");
    }
    let index = circled.frame_index();
    let shot = settled(&mut circled, &gpu, &scene_from_the_side(7));
    assert_eq!(circled.frame_index(), index, "the capture leaves Live's frame index alone");
    let history = circled.last_history().expect("a frame was drawn");
    assert_eq!((history.set, history.settle), (HistorySet::Capture, Some(SettleFrame { index: k - 1, count: k })), "the read-back frame is the last of K");
    let other = settled(&mut dark, &gpu, &scene_from_the_side(7));
    let cold = settled(&mut temporal_renderer(&gpu), &gpu, &scene_from_the_side(7));
    write_evidence("rq5.4-settled-after-circling", &shot);
    write_evidence("rq5.4-settled-after-dark", &other);
    write_evidence("rq5.4-settled-cold", &cold);
    assert_eq!(shot.digest(), other.digest(), "Live histories reach the capture in {} pixels", differing(&shot, &other));
    assert_eq!(shot.digest(), cold.digest(), "a cold renderer differs in {} pixels", differing(&shot, &cold));
    // More Live frames, then the same capture again.
    for tick in LIVE_FRAMES + 1..=LIVE_FRAMES + 20 {
        circled.render(&gpu, &circling(tick, 3.0), CullPath::Gpu, None).expect("Live frame circling");
    }
    let again = settled(&mut circled, &gpu, &scene_from_the_side(7));
    assert_eq!(again.digest(), shot.digest(), "a later capture of one state is the same picture");
    // The cycle is not idle: one re-render (AO without history) is another picture.
    let mut single = temporal_renderer(&gpu);
    single.render_settled(&gpu, &scene_from_the_side(7), CullPath::Gpu, None, 1).expect("one re-render");
    let one = single.capture(&gpu).expect("capture");
    write_evidence("rq5.4-settled-k1", &one);
    assert!(differing(&one, &shot) > 0, "K re-renders accumulate history one re-render does not");
}

// RQ5 review: AO's history was one per renderer (and a capture left the far cascades' cadence
// mid-way), so a capture's re-renders from another camera became Live's AO history and Live's next
// frame differed from the same frame without the capture. Live's history is put aside and taken
// back; the cascades all redraw after a capture.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_on_the_high_preset_a_capture_from_another_camera_leaves_the_next_live_frame_unchanged() {
    let Some(gpu) = gpu() else { return };
    let (mut with_capture, mut without) = (temporal_renderer(&gpu), temporal_renderer(&gpu));
    let quality = *with_capture.renderer().quality();
    assert!(quality.ao.temporal && quality.anti_aliasing.temporal(), "{quality:?}");
    for renderer in [&mut with_capture, &mut without] {
        for tick in 1..=12 {
            renderer.render(&gpu, &circling(tick, 10.0), CullPath::Gpu, None).expect("Live frame circling");
        }
    }
    let _ = settled(&mut with_capture, &gpu, &scene_from_the_side(7));
    for tick in 13..=14 {
        let after = live_frame(&mut with_capture, &gpu, &circling(tick, 10.0));
        let plain = live_frame(&mut without, &gpu, &circling(tick, 10.0));
        write_evidence(&format!("rq5-review-live-{tick}-after-capture"), &after);
        write_evidence(&format!("rq5-review-live-{tick}-without-capture"), &plain);
        assert_eq!(after.digest(), plain.digest(), "Live frame {tick} differs in {} pixels after the capture", differing(&after, &plain));
    }
}

/// Every temporal feature on ultra (TAA with sharpening asked for, full-resolution GTAO with its
/// history, PCSS, auto exposure): a capture after a hundred Live frames of another shot is the
/// cold renderer's picture, re-rendered over the preset's whole jitter cycle.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_on_ultra_a_settled_capture_after_live_frames_equals_a_cold_one() {
    let Some(gpu) = gpu() else { return };
    let ultra = || preset_renderer(&gpu, QualityPreset::Ultra, auto_look(3.0), (WIDTH, HEIGHT));
    let mut warmed = ultra();
    let quality = *warmed.renderer().quality();
    assert!(quality.ao.temporal && quality.anti_aliasing == AntiAliasing::TaaSharpen, "{quality:?}");
    assert_eq!(warmed.settle_frames(), quality.taa.jitter_cycle.frames());
    for tick in 1..=LIVE_FRAMES {
        warmed.render(&gpu, &circling(tick, 12.0), CullPath::Gpu, None).expect("Live frame circling");
    }
    let after_live = settled(&mut warmed, &gpu, &scene_from_the_side(7));
    let cold = settled(&mut ultra(), &gpu, &scene_from_the_side(7));
    write_evidence("rq5.4-ultra-after-live", &after_live);
    write_evidence("rq5.4-ultra-cold", &cold);
    assert_eq!(after_live.digest(), cold.digest(), "Live history reaches the ultra capture in {} pixels", differing(&after_live, &cold));
}

/// A settled capture at one scale step is the same picture whatever step Live drew at before it:
/// a hundred Live frames at the largest step or at the smallest leave nothing in it. The caller
/// hands the capture its step (here the nominal one); that a capture is drawn at the nominal step
/// whatever dynamic resolution holds Live at is the presenter's, held by genex's
/// `metal_a_capture_draws_the_nominal_step_whatever_step_dynamic_resolution_holds_live_at`
/// (RQ5 review: this row's old name claimed that property).
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_settled_capture_at_one_step_is_the_same_after_live_at_the_maximum_or_the_minimum_step() {
    let Some(gpu) = gpu() else { return };
    let nominal = preset_quality(QualityPreset::High, DESKTOP).render_scale;
    let (maximum, minimum) = (1.0_f32, 0.5_f32);
    let after_live_at = |scale: f32| {
        let mut renderer = temporal_renderer(&gpu);
        renderer.renderer_mut().set_render_scale(scale);
        for tick in 1..=LIVE_FRAMES {
            renderer.render(&gpu, &circling(tick, 10.0), CullPath::Gpu, None).expect("Live frame at a scale step");
        }
        let live_size = renderer.renderer().render_size();
        renderer.renderer_mut().set_render_scale(nominal);
        let shot = settled(&mut renderer, &gpu, &scene(10.0, 7));
        (live_size, renderer.renderer().render_size(), shot)
    };
    let (max_live, max_capture, at_max) = after_live_at(maximum);
    let (min_live, min_capture, at_min) = after_live_at(minimum);
    assert_ne!(max_live, min_live, "Live drew at two different steps");
    assert_eq!(max_capture, min_capture, "both captures draw at the nominal step");
    write_evidence("rq5.4-scale-after-max-step", &at_max);
    write_evidence("rq5.4-scale-after-min-step", &at_min);
    assert_eq!(at_max.digest(), at_min.digest(), "Live's scale step reaches the capture in {} pixels", differing(&at_max, &at_min));
}

/// A capture bakes the environment whole for its own sun: a sun moved between two captures (with
/// or without Live frames between them, the time-sliced rebake unfinished) gives the cold bake.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_sun_moved_between_captures_gives_the_cold_bake_environment() {
    let Some(gpu) = gpu() else { return };
    let sky_renderer = || {
        let mut renderer = temporal_renderer(&gpu);
        renderer.renderer_mut().set_environment(&Environment::sky());
        renderer
    };
    let quality = preset_quality(QualityPreset::High, DESKTOP);
    assert!(quality.environment.ibl && quality.environment.sky, "high bakes the sky into IBL");
    let under = |elevation: f32, tick: u64| {
        let mut frame = circling(tick, 6.0);
        let e = elevation.to_radians();
        frame.lighting_mut().sun_dir = [0.3 * libm::cosf(e), libm::sinf(e), -libm::cosf(e)];
        frame
    };
    let cold = settled(&mut sky_renderer(), &gpu, &under(55.0, 3));
    // Captures only: the sun moved by one capture.
    let mut captures = sky_renderer();
    let low = settled(&mut captures, &gpu, &under(20.0, 3));
    let moved = settled(&mut captures, &gpu, &under(55.0, 3));
    assert!(differing(&low, &moved) > 0, "the sun's move changes the picture");
    // Live frames under a sun swinging up between the captures (rebakes in flight).
    let mut live = sky_renderer();
    settled(&mut live, &gpu, &under(20.0, 3));
    for tick in 1..=40 {
        live.render(&gpu, &under(20.0 + tick as f32, tick), CullPath::Gpu, None).expect("Live frame under a moving sun");
    }
    let after_live = settled(&mut live, &gpu, &under(55.0, 3));
    write_evidence("rq5.4-sun-cold", &cold);
    write_evidence("rq5.4-sun-moved", &moved);
    write_evidence("rq5.4-sun-moved-after-live", &after_live);
    assert_eq!(moved.digest(), cold.digest(), "the moved sun's capture differs from the cold bake in {} pixels", differing(&moved, &cold));
    assert_eq!(after_live.digest(), cold.digest(), "Live's rebakes reach the capture in {} pixels", differing(&after_live, &cold));
}

/// An uninitialised scene and depth at `size`: the TAA history rows read only what the resolve
/// reports, never its pixels.
fn taa_inputs(gpu: &Gpu, size: (u32, u32)) -> (wgpu::TextureView, wgpu::TextureView) {
    let texture = |format, usage| {
        gpu.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("settle taa input"),
            size: wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage,
            view_formats: &[],
        })
    };
    let scene = texture(wgpu::TextureFormat::Rgba16Float, wgpu::TextureUsages::TEXTURE_BINDING);
    let depth = texture(wgpu::TextureFormat::Depth32Float, wgpu::TextureUsages::TEXTURE_BINDING);
    (scene.create_view(&Default::default()), depth.create_view(&Default::default()))
}

/// Resolve one frame at `frame_index` on `set`'s TAA history; whether it started history over.
fn resolve(gpu: &Gpu, taa: &mut TaaHistories, set: HistorySet, inputs: &(wgpu::TextureView, wgpu::TextureView), frame_index: u64) -> bool {
    use genex_render::post::taa::{GpuTaaParams, TaaInput};
    let size = (32, 24);
    let config = genex_render::settings::RenderSettings::off().frame_config(size, 1.0, frame_index, frame_index == 0);
    let row = GpuTaaParams::new(&TaaQuality::DEFAULT, &config, [0.0; 2], 1.0);
    let node = taa.node(gpu, set).expect("the set's node");
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("settle taa") });
    let input = TaaInput { scene: &inputs.0, depth: &inputs.1, motion: None, reactive: None, render: size, row };
    let reset = node.encode(&gpu.device, &gpu.queue, &mut encoder, input).reset;
    gpu.queue.submit([encoder.finish()]);
    reset
}

/// TAA's histories: a capture's own history starts over on every capture, never reads or resets
/// Live's, and Live's starts over only by the reset rules.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_taa_keeps_a_capture_owned_history_beside_live() {
    let Some(gpu) = gpu() else { return };
    let inputs = taa_inputs(&gpu, (32, 24));
    let mut taa = TaaHistories::new(&gpu).expect("taa histories");
    assert_eq!(taa.history_bytes(), 0, "nothing held before a resolve");
    assert!(resolve(&gpu, &mut taa, HistorySet::Live, &inputs, 0), "Live's first frame starts over");
    for index in 1..5 {
        assert!(!resolve(&gpu, &mut taa, HistorySet::Live, &inputs, index), "Live accumulates");
    }
    let live_bytes = taa.history_bytes();
    assert!(live_bytes > 0);
    for capture in 0..2 {
        taa.settle_reset(&gpu, HistorySet::Capture, HistoryReset::Capture).expect("capture reset");
        assert!(resolve(&gpu, &mut taa, HistorySet::Capture, &inputs, 0), "capture {capture} starts over");
        for index in 1..8 {
            assert!(!resolve(&gpu, &mut taa, HistorySet::Capture, &inputs, index), "capture {capture} accumulates its cycle");
        }
    }
    assert_eq!(taa.history_bytes(), 2 * live_bytes, "the capture's history is its own pair");
    assert!(!resolve(&gpu, &mut taa, HistorySet::Live, &inputs, 5), "Live resumes its history after captures");
    // Every reset rule starts Live over; an exposure change is not a reset. RQ5 review flipped
    // ScaleStep (named in the log): a dynamic-resolution step reprojects the history in uv.
    for reason in [HistoryReset::CameraCut, HistoryReset::Resize, HistoryReset::Settings, HistoryReset::DeviceRecreated, HistoryReset::Rewind] {
        taa.settle_reset(&gpu, HistorySet::Live, reason).expect("live reset");
        assert!(resolve(&gpu, &mut taa, HistorySet::Live, &inputs, 6), "{reason:?} starts Live over");
        assert!(!resolve(&gpu, &mut taa, HistorySet::Live, &inputs, 7), "{reason:?}: then it accumulates");
    }
    taa.settle_reset(&gpu, HistorySet::Live, HistoryReset::ScaleStep).expect("a scale step");
    assert!(!resolve(&gpu, &mut taa, HistorySet::Live, &inputs, 8), "a scale step keeps Live's history");
    taa.release_capture();
    assert_eq!(taa.history_bytes(), live_bytes, "a released capture history gives its bytes back");
}

/// Acceptance: a settled capture at K = 8 (the high preset under auto exposure, read back) at
/// 1280x720 within [`SETTLE_K8_720P_MS_MAX`].
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_settled_capture_at_k_8_and_720p_takes_at_most_150_ms() {
    let Some(gpu) = gpu() else { return };
    let size = (1280, 720);
    let mut renderer = preset_renderer(&gpu, QualityPreset::High, auto_look(3.0), size);
    let k = renderer.settle_frames();
    assert_eq!(k, 8);
    let frame = scene_from_the_side(7);
    // Warm the pipelines, the targets and the environment.
    settled(&mut renderer, &gpu, &frame);
    let settle = median(K8_RUNS, || {
        settled(&mut renderer, &gpu, &frame);
    });
    let plain = median(K8_RUNS, || {
        live_frame(&mut renderer, &gpu, &frame);
    });
    let ms = settle.as_secs_f64() * 1000.0;
    let row = format!(
        "{{\"row\":\"settled-capture-latency\",\"k\":{k},\"width\":{},\"height\":{},\"preset\":\"high\",\"plainMs\":{:.3},\"settledMs\":{ms:.3},\"budgetMs\":{SETTLE_K8_720P_MS_MAX},\"adapter\":\"{}\"}}",
        size.0,
        size.1,
        plain.as_secs_f64() * 1000.0,
        gpu.receipt().adapter
    );
    perf_row(&row);
    assert!(ms <= SETTLE_K8_720P_MS_MAX, "a settled capture at K = {k} took {ms:.1} ms at 1280x720");
}

// ---------------------------------------------------------------------------------------------
// RQ5 review: settled TAA captures of one tick once differed in 1-2 pixels by one level in about
// one showcase run in three under concurrent GPU load (root cause not found). This row renders the
// same settled capture repeatedly on the high preset (TAA, temporal GTAO, auto exposure) while
// another device draws a heavy load on its own thread, and asserts one digest.

/// Settled captures the stress row takes under load.
const STRESS_CAPTURES: usize = 12;
/// The load device's frame: a full-screen fragment loop of this many dependent steps per pixel.
const STRESS_LOAD_STEPS: u32 = 4096;

const STRESS_LOAD_WGSL: &str = "
@vertex
fn vs(@builtin(vertex_index) vertex: u32) -> @builtin(position) vec4<f32> {
    let x = f32((vertex << 1u) & 2u) * 2.0 - 1.0;
    let y = f32(vertex & 2u) * 2.0 - 1.0;
    return vec4<f32>(x, y, 0.0, 1.0);
}

@fragment
fn fs(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    var a = position.xy * 0.001;
    for (var i = 0u; i < STEPS; i = i + 1u) {
        a = fract(a * 1.7 + vec2<f32>(0.3, 0.7));
    }
    return vec4<f32>(a, 0.0, 1.0);
}
";

/// Draw heavy full-screen frames on a device of its own until `stop` is set.
fn gpu_load(stop: std::sync::Arc<std::sync::atomic::AtomicBool>) {
    let Ok(gpu) = Gpu::headless() else { return };
    let source = STRESS_LOAD_WGSL.replace("STEPS", &format!("{STRESS_LOAD_STEPS}u"));
    let module = gpu.device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("stress load"), source: wgpu::ShaderSource::Wgsl(source.into()) });
    let format = wgpu::TextureFormat::Rgba8Unorm;
    let pipeline = gpu.device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("stress load"),
        layout: None,
        vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[] },
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs"), compilation_options: Default::default(), targets: &[Some(format.into())] }),
        multiview_mask: None,
        cache: None,
    });
    let target = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("stress load"),
        size: wgpu::Extent3d { width: 1920, height: 1080, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    });
    let view = target.create_view(&Default::default());
    while !stop.load(std::sync::atomic::Ordering::Relaxed) {
        let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("stress load") });
        {
            let attachment = wgpu::RenderPassColorAttachment { view: &view, depth_slice: None, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store } };
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor { label: Some("stress load"), color_attachments: &[Some(attachment)], ..Default::default() });
            pass.set_pipeline(&pipeline);
            pass.draw(0..3, 0..1);
        }
        gpu.queue.submit([encoder.finish()]);
        let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
    }
}

/// Whether the stress rows run (`GENEX_RENDER_STRESS=1`): their load would slow the suite's timing
/// rows that run beside them, so they run on their own.
fn stress_asked() -> bool {
    std::env::var("GENEX_RENDER_STRESS").is_ok_and(|value| value == "1")
}

/// Run alone: `GENEX_RENDER_STRESS=1 ... --test settle -- --ignored metal_settled_taa_captures`.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_settled_taa_captures_of_one_tick_keep_one_digest_under_a_parallel_gpu_load() {
    if !stress_asked() {
        eprintln!("skipped: GENEX_RENDER_STRESS=1 runs it alone");
        return;
    }
    let Some(gpu) = gpu() else { return };
    let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let load = std::thread::spawn({
        let stop = std::sync::Arc::clone(&stop);
        move || gpu_load(stop)
    });
    let mut renderer = temporal_renderer(&gpu);
    let mut digests = Vec::with_capacity(STRESS_CAPTURES);
    let mut first = None;
    for capture in 0..STRESS_CAPTURES {
        for tick in 1..=3 {
            renderer.render(&gpu, &circling(tick + capture as u64 * 3, 12.0), CullPath::Gpu, None).expect("Live frame");
        }
        let shot = settled(&mut renderer, &gpu, &scene_from_the_side(7));
        let differs = first.as_ref().map_or(0, |first| differing(first, &shot));
        digests.push((shot.digest(), differs));
        first.get_or_insert(shot);
    }
    stop.store(true, std::sync::atomic::Ordering::Relaxed);
    let _ = load.join();
    let distinct: std::collections::BTreeSet<u64> = digests.iter().map(|(digest, _)| *digest).collect();
    assert_eq!(distinct.len(), 1, "settled captures of one tick under load: {digests:?}");
}

// ---------------------------------------------------------------------------------------------
// RQ5 review: auto exposure's settle count was raised from 2 to 3 to pass the showcase look row,
// with the first metering's error unexplained. This row measures it: a capture of a scene far
// from the look's initial exposure (a dim, mostly shadowed yard), on each HDR scene format, at
// K = 1..=4 against the converged K = 16.

/// A dim scene with large dark regions: a low sun, dark materials, deep shadow under a roof.
fn dim_yard(tick: u64) -> ImmediateFrame {
    let mut frame = ImmediateFrame::new(CameraDesc::look_at([0.0, 4.0, 7.0], [0.0, 0.0, 0.0]), [10, 12, 16, 255]);
    frame.lighting_mut().sun_intensity = 0.6;
    frame.lighting_mut().sun_dir = [0.2, 0.25, 0.4];
    frame.cube(genex_render::scene::scaled([0.0, -0.1, 0.0], [14.0, 0.2, 14.0]), [60, 55, 50, 255]);
    frame.cube(genex_render::scene::scaled([0.0, 2.0, 0.0], [6.0, 0.2, 6.0]), [40, 40, 45, 255]);
    frame.cube(translation(1.5, 0.5, 0.0), [120, 30, 30, 255]);
    frame.sphere([-1.5, 0.6, 1.0], 0.6, [30, 60, 140, 255]);
    frame.set_tick(tick);
    frame
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_auto_exposure_captures_converge_by_the_settle_count_on_every_hdr_scene_format() {
    let Some(gpu) = gpu() else { return };
    let mut rows = Vec::new();
    let mut failures = Vec::new();
    for format in [SceneFormat::Rgba16Float, SceneFormat::Rg11b10Ufloat] {
        let capture_at = |k: u32| {
            let mut renderer = hdr_renderer(&gpu, auto_look(3.0));
            renderer.renderer_mut().set_scene_format(format);
            renderer.render_settled(&gpu, &dim_yard(5), CullPath::Gpu, None, k).expect("settled");
            mean_level(&renderer.capture(&gpu).expect("capture"))
        };
        let converged = capture_at(16);
        let means: Vec<f64> = (1..=4).map(capture_at).collect();
        rows.push(format!("{format:?}: K=1..4 {means:.3?}, K=16 {converged:.3}"));
        let settled = means[AUTO_EXPOSURE_SETTLE_FRAMES as usize - 1];
        if (settled - converged).abs() > CONVERGED_MEAN_LEVELS {
            failures.push(format!("{format:?}: K={AUTO_EXPOSURE_SETTLE_FRAMES} {settled:.3} against K=16 {converged:.3}"));
        }
    }
    eprintln!("{}", rows.join("\n"));
    assert!(failures.is_empty(), "{failures:?} ({rows:?})");
}

/// An `hdr`-stage grade the way a game writes one: a shadow lift added to pre-exposed radiance, which
/// is not exposure-invariant (the showcase's grade lifts its shadows this way).
const LIFT_V2: &str = "
@fragment
fn fs_post(in: GxPostInV2) -> @location(0) vec4<f32> {
    let scene = textureSampleLevel(gx_scene, gx_sampler, gx_scene_uv(in.position), 0.0).rgb;
    return vec4<f32>(scene + vec3<f32>(LIFT), 1.0);
}
";

// RQ5 review root cause: a pass that changes the HDR scene before it is metered with constants in
// pre-exposed units makes the first metering of a far-off picture wrong; the renderer's own
// metering is exact (the row above). Such a frame settles with one more re-render. Measured on the
// dim yard (mean levels at K = 1, 2, 3, 4, 16): a lift of 0.002 85.8 / 99.49 / 99.49 against 99.49;
// 0.005 67.6 / 99.17 / 99.98 against 99.99; 0.01 needs K = 4 (95.9 at 3). The showcase's grade
// lands at K = 3 (within 0.03 EV of K = 16).
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_grade_before_metering_settles_with_one_more_re_render() {
    let Some(gpu) = gpu() else { return };
    let capture_at = |k: u32, lift: f32| {
        let mut renderer = hdr_renderer(&gpu, auto_look(3.0));
        let source = LIFT_V2.replace("LIFT", &format!("{lift:?}"));
        let pass = renderer.add_post_pass_api(&gpu, genex_render::abi::ABI_V2, genex_render::extension::PostStage::Hdr, &source, &[], &[]).expect("a v2 hdr post");
        let mut frame = dim_yard(5);
        frame.post_pass(pass);
        renderer.render_settled(&gpu, &frame, CullPath::Gpu, None, k).expect("settled");
        mean_level(&renderer.capture(&gpu).expect("capture"))
    };
    let renderer = hdr_renderer(&gpu, auto_look(3.0));
    assert_eq!((renderer.settle_frames(), renderer.settle_frames_graded(true)), (AUTO_EXPOSURE_SETTLE_FRAMES, GRADED_EXPOSURE_SETTLE_FRAMES));
    let lift = 0.002;
    let converged = capture_at(16, lift);
    let (plain, graded) = (capture_at(AUTO_EXPOSURE_SETTLE_FRAMES, lift), capture_at(GRADED_EXPOSURE_SETTLE_FRAMES, lift));
    eprintln!("graded: K={AUTO_EXPOSURE_SETTLE_FRAMES} {plain:.3}, K={GRADED_EXPOSURE_SETTLE_FRAMES} {graded:.3}, K=16 {converged:.3}");
    assert!((plain - converged).abs() > CONVERGED_MEAN_LEVELS, "the lift moves the first metering: {plain:.3} against {converged:.3}");
    assert!((graded - converged).abs() <= CONVERGED_MEAN_LEVELS, "one more re-render lands: {graded:.3} against {converged:.3}");
}

/// A part-1 scene handed to the frame renderer as it stands (pass-1 gate: the bench and stress
/// captures drew through `Renderer::render`, which runs no exposure node, so they were never
/// exposed): the frame keeps its camera, clear colour, lights and draws and counts one world draw
/// per scene draw.
#[test]
fn a_scene_becomes_a_frame_with_its_camera_lights_and_draws() {
    let camera = CameraDesc::look_at([0.0, 2.0, 6.0], [0.0, 0.0, 0.0]);
    let mut built = ImmediateFrame::new(camera, [10, 20, 30, 255]);
    built.cube(translation(0.0, 0.5, 0.0), [200, 120, 60, 255]).cube(translation(2.0, 0.5, 0.0), [60, 120, 200, 255]);
    built.lighting_mut().sun_intensity = 2.0;
    let scene = built.scene().clone();
    let frame = ImmediateFrame::from_scene(scene.clone());
    assert_eq!(frame.scene(), &scene);
    assert_eq!(frame.draw_calls(), 2);
    assert_eq!(frame.tags(), [(String::from(genex_render::immediate::WORLD_TAG), 2)]);
}

/// The look of the every-feature fixture's courtyard: auto exposure and fog whose in-scatter is the
/// sky's.
fn foggy_look() -> Look {
    let mut look = auto_look(3.0);
    look.fog.density = 0.02;
    look.fog.height_falloff = 0.3;
    look.bloom_intensity = 0.06;
    look
}

/// Pass-1 fix (gate round 1, extensibility): Level-2 v2 sources read the frame's fog row from the
/// frame facts, which were written before the frame's plan from the fog backdrop the last frame
/// left. The first frame after the environment came (a renderer warmed off the frame thread drew
/// its frame under the flat colour) handed a v2 material the flat backdrop's fog while the world
/// pass drew the sky's; auto exposure metered that re-render, so a settled capture moved by one
/// level across the frame. A frame's v2 sources read the fog its own world pass draws.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_v2_sources_read_the_fog_their_frame_draws_on_the_first_frame_under_the_sky() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = preset_renderer(&gpu, QualityPreset::Medium, foggy_look(), (WIDTH, HEIGHT));
    renderer.render(&gpu, &scene_from_the_side(1), CullPath::Gpu, None).expect("a frame under the flat colour");
    let flat = renderer.renderer().frame_fog();
    renderer.renderer_mut().set_environment(&Environment::sky());
    renderer.render(&gpu, &scene_from_the_side(2), CullPath::Gpu, None).expect("the first frame under the sky");
    let drawn = renderer.renderer().frame_fog();
    assert_ne!(flat, drawn, "the flat backdrop tints the fog row; the sky's does not");
    assert_eq!(renderer.material_frame_facts().fog, drawn, "v2 sources read the last frame's fog backdrop");
}
