//! Dynamic-resolution steps (renderer pass 2, RC-10): a step reallocated every render-size target
//! on the frame dynamic resolution chose because it was already over budget (on an M4 Max at
//! 1440p high and ultra that frame took 1.3-1.7 ms more to reach GPU idle than its neighbours,
//! measured by the timing row here), and the replaced set was a memory peak no ledger saw. The
//! pool now keeps the target a step change replaced as its label's spare on desktop
//! (`TargetPolicy::spares`), counted in the ledger, and releases it once the scale settles.
//!
//! The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test drs_steps -- --ignored metal --nocapture

use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
use genex_render::immediate::ImmediateFrame;
use genex_render::presets::preset_quality;
use genex_render::scene::{CameraDesc, scaled, translation};
use genex_render::settings::{QualityPreset, SceneFormat};
use genex_render::target_pool::{SPARE_BYTES_MAX, SPARE_IDLE_FRAMES, TargetDesc, TargetPolicy, TargetPool};
use genex_render::{CullPath, FrameRenderer, Gpu, RenderOptions};

/// The output the rows draw at: 1440p (D7's desktop-high budget output).
const OUTPUT: (u32, u32) = (2560, 1440);
const WARM_FRAMES: u64 = 30;
/// The two steps dynamic resolution oscillates between.
const STEPS: [f32; 2] = [1.0, 0.875];
/// Frames held at each step, and the round trips drawn.
const HOLD_FRAMES: u64 = 4;
const ROUND_TRIPS: u64 = 8;

/// Textures by label, as a step held them.
type Held = Vec<(&'static str, wgpu::Texture)>;

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

/// A sunlit floor and nine cubes.
fn scene(tick: u64) -> ImmediateFrame {
    let mut frame = ImmediateFrame::new(CameraDesc::look_at([0.0, 2.0, 6.0], [0.0, 0.5, 0.0]), [40, 50, 70, 255]);
    frame.cube(scaled([0.0, -0.1, 0.0], [12.0, 0.2, 10.0]), [180, 180, 180, 255]);
    for i in 0..9u8 {
        let x = f32::from(i % 3) * 1.6 - 1.6;
        let z = f32::from(i / 3) * 1.6 - 1.6;
        frame.cube(translation(x, 0.5, z), [200, 120 + i * 10, 90, 255]);
    }
    frame.set_tick(tick);
    frame
}

/// A desktop-ultra renderer at `preset`, HDR, drawn [`WARM_FRAMES`] Live frames at scale 1.
fn warmed(gpu: &Gpu, preset: QualityPreset) -> (FrameRenderer, u64) {
    let class = DeviceClass::new(FormFactor::Desktop, PerformanceTier::Ultra);
    let quality = preset_quality(preset, class);
    let options = RenderOptions { msaa: genex_render::renderer::landed_samples(quality.anti_aliasing) > 1 };
    let mut frames = FrameRenderer::new(gpu, OUTPUT.0, OUTPUT.1, options).expect("renderer");
    let part1 = frames.renderer_mut();
    part1.set_scene_format(SceneFormat::Rgba16Float);
    part1.set_device_class(class);
    part1.set_quality(&quality);
    for tick in 0..WARM_FRAMES {
        frames.render(gpu, &scene(tick), CullPath::Gpu, None).expect("frame");
    }
    (frames, WARM_FRAMES)
}

/// Every pooled texture, by label.
fn textures(frames: &FrameRenderer) -> Held {
    frames.renderer().targets().targets().iter().map(|target| (target.desc().label, target.texture().clone())).collect()
}

/// What one oscillation drew.
#[derive(Default)]
struct Oscillation {
    /// Per step frame: the pool's bytes after it.
    bytes: Vec<u64>,
    /// Per step, the textures held on each visit.
    held: [Vec<Held>; 2],
    /// CPU encode times (steady frames, step frames), ms.
    cpu: (Vec<f64>, Vec<f64>),
    /// Frame to GPU idle times (steady frames, step frames), ms.
    idle: (Vec<f64>, Vec<f64>),
    /// The last frame's digest.
    digest: u64,
}

/// Oscillate `frames` between [`STEPS`] for [`ROUND_TRIPS`], [`HOLD_FRAMES`] frames a step, from
/// `tick`.
#[allow(clippy::disallowed_types, reason = "the timing record reads the wall clock; no picture depends on it")]
fn oscillate(gpu: &Gpu, frames: &mut FrameRenderer, mut tick: u64) -> Oscillation {
    let mut drawn = Oscillation::default();
    for _ in 0..ROUND_TRIPS {
        for (at, scale) in STEPS.into_iter().enumerate() {
            frames.renderer_mut().set_render_scale(scale);
            for frame in 0..HOLD_FRAMES {
                let start = std::time::Instant::now();
                frames.render(gpu, &scene(tick), CullPath::Gpu, None).expect("frame");
                let encoded = start.elapsed().as_secs_f64() * 1000.0;
                let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
                let drained = start.elapsed().as_secs_f64() * 1000.0;
                tick += 1;
                if frame == 0 {
                    drawn.bytes.push(frames.renderer().targets().ledger().total());
                    drawn.held[at].push(textures(frames));
                    drawn.cpu.1.push(encoded);
                    drawn.idle.1.push(drained);
                } else {
                    drawn.cpu.0.push(encoded);
                    drawn.idle.0.push(drained);
                }
            }
        }
    }
    drawn.digest = frames.capture(gpu).expect("capture").digest();
    drawn
}

fn median(values: &[f64]) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    sorted[sorted.len() / 2]
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_an_oscillating_drs_swaps_each_steps_targets_back_instead_of_allocating_them_again() {
    let Some(gpu) = gpu() else { return };
    for preset in [QualityPreset::High, QualityPreset::Ultra] {
        let (mut frames, tick) = warmed(&gpu, preset);
        let single = frames.renderer().targets().ledger().total();
        let drawn = oscillate(&gpu, &mut frames, tick);
        eprintln!("{preset:?}: one step's set {single} bytes; pool bytes at each step frame {:?}; last frame {}", drawn.bytes, drawn.digest);
        // From the second visit on, each step holds the textures it held on its first.
        for (at, visits) in drawn.held.iter().enumerate() {
            for (visit, held) in visits.iter().enumerate().skip(1) {
                let again: Vec<&str> = held.iter().filter(|target| !visits[0].contains(target)).map(|(label, _)| *label).collect();
                assert!(again.is_empty(), "{preset:?}: step {} visit {visit} allocated {again:?} again", STEPS[at]);
            }
        }
        // Both steps' sets are in the ledger while the scale oscillates.
        let both = drawn.bytes.last().copied().unwrap_or_default();
        assert!(both > single, "{preset:?}: the ledger counts the spare step ({both} vs {single})");
        assert!(both - single <= SPARE_BYTES_MAX, "{preset:?}: spares stay within their cap");
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_spares_are_released_once_the_scale_settles_and_the_ledger_is_one_set_again() {
    let Some(gpu) = gpu() else { return };
    let (mut frames, tick) = warmed(&gpu, QualityPreset::High);
    let single = frames.renderer().targets().ledger().total();
    oscillate(&gpu, &mut frames, tick);
    assert!(frames.renderer().targets().spare_bytes() > 0, "the oscillation keeps spares");
    frames.renderer_mut().set_render_scale(STEPS[1]);
    let settled = tick + ROUND_TRIPS * HOLD_FRAMES * 2;
    for at in 0..=u64::from(SPARE_IDLE_FRAMES) {
        frames.render(&gpu, &scene(settled + at), CullPath::Gpu, None).expect("frame");
    }
    let pool = frames.renderer().targets();
    assert_eq!(pool.spare_bytes(), 0, "every spare is released after {SPARE_IDLE_FRAMES} frames at one step");
    assert!(pool.ledger().total() < single, "the ledger holds the lower step's set alone ({} vs {single})", pool.ledger().total());
}

/// The timing record (not an assertion: a shared machine's timings vary): the median CPU encode
/// and frame-to-GPU-idle times of steady and step frames, after the first round trip.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_record_the_cost_of_a_step_frame() {
    let Some(gpu) = gpu() else { return };
    for preset in [QualityPreset::High, QualityPreset::Ultra] {
        let (mut frames, tick) = warmed(&gpu, preset);
        let drawn = oscillate(&gpu, &mut frames, tick);
        let later = |values: &[f64]| values[2..].to_vec();
        eprintln!(
            "{preset:?} {}x{}: CPU steady {:.3} ms, step {:.3} ms; to GPU idle steady {:.3} ms, step {:.3} ms (max {:.3})",
            OUTPUT.0,
            OUTPUT.1,
            median(&drawn.cpu.0),
            median(&later(&drawn.cpu.1)),
            median(&drawn.idle.0),
            median(&later(&drawn.idle.1)),
            later(&drawn.idle.1).iter().copied().fold(0.0, f64::max),
        );
    }
}

// ---------------------------------------------------------------------------------------------
// The pool alone

fn desc(label: &'static str, size: (u32, u32)) -> TargetDesc {
    TargetDesc { label, format: wgpu::TextureFormat::Rgba16Float, usage: wgpu::TextureUsages::RENDER_ATTACHMENT, samples: 1, size, mips: 1, srgb_view: false }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_pool_keeps_a_spare_only_for_a_render_size_change_under_a_spare_policy() {
    let Some(gpu) = gpu() else { return };
    let device = &gpu.device;
    let (a, b) = ((640, 360), (560, 315));
    // A frame at render size `size` acquiring `desc` at it.
    let frame = |pool: &mut TargetPool, size: (u32, u32), desc: TargetDesc| {
        pool.note_render_size(size);
        pool.acquire(device, TargetDesc { size, ..desc }).expect("acquired");
    };
    // No spares (phones, the web): every step allocates and the ledger holds one target.
    let mut flat = TargetPool::with_policy(TargetPolicy::new(None, false));
    for size in [a, b, a, b] {
        frame(&mut flat, size, desc("scene", size));
    }
    assert_eq!((flat.allocations(), flat.spare_bytes()), (4, 0));
    assert_eq!(flat.ledger().total(), desc("scene", b).bytes());
    // Spares: the second visit of each step swaps.
    let spares = TargetPolicy::new(None, false).with_spares(true);
    let mut pool = TargetPool::with_policy(spares);
    for size in [a, b, a, b, a] {
        frame(&mut pool, size, desc("scene", size));
    }
    assert_eq!(pool.allocations(), 2, "two steps, two textures");
    assert_eq!(pool.ledger().total(), desc("scene", a).bytes() + desc("scene", b).bytes(), "the spare is in the ledger");
    // A size change at the same render size (a quality knob) keeps no spare: the budget model's
    // count holds at once.
    pool.drop_spares();
    frame(&mut pool, a, desc("ao", (320, 180)));
    frame(&mut pool, a, desc("ao", a));
    assert_eq!(pool.spare_bytes(), 0, "a quality change keeps no spare");
    // Another format is not a step even on a step frame: the old target goes.
    let other = TargetDesc { format: wgpu::TextureFormat::Rgba8Unorm, ..desc("scene", a) };
    frame(&mut pool, b, other);
    assert_eq!(pool.spare_bytes(), 0, "a format change keeps no spare");
    assert_eq!(pool.ledger().total(), TargetDesc { size: b, ..other }.bytes() + desc("ao", a).bytes());
    // A step that draws without a target releases it into the spare; the next step drawing it
    // swaps it back, and `drop_spares` lets every spare go.
    pool.note_render_size(a);
    pool.release("scene");
    assert!(pool.get("scene").is_none());
    assert!(pool.spare_bytes() > 0, "the released target is the spare");
    let before = pool.allocations();
    frame(&mut pool, b, other);
    assert_eq!(pool.allocations(), before, "the step drawing it again swaps it back");
    pool.drop_spares();
    pool.note_render_size(b);
    pool.release("scene");
    pool.release("ao");
    assert_eq!((pool.spare_bytes(), pool.ledger().total()), (0, 0), "a release on a frame at the same size frees at once");
    // A spare that would pass the cap is not kept.
    let huge = |size| TargetDesc { format: wgpu::TextureFormat::Rgba32Float, ..desc("huge", size) };
    assert!(huge((8192, 4608)).bytes() > SPARE_BYTES_MAX);
    let mut capped = TargetPool::with_policy(spares);
    frame(&mut capped, (8192, 4608), huge((8192, 4608)));
    frame(&mut capped, (8192, 4096), huge((8192, 4096)));
    assert_eq!(capped.spare_bytes(), 0, "over the cap");
}

#[test]
fn a_spare_policy_is_off_unless_asked_and_desktop_devices_ask_for_it() {
    assert!(!TargetPolicy::new(Some(true), false).spares(), "off by default");
    assert!(TargetPolicy::new(None, false).with_spares(true).spares());
    const { assert!(SPARE_IDLE_FRAMES > genex_render::drs::RISE_BACKOFF_MAX_FRAMES, "an oscillation's longest wait keeps its spare") };
}
