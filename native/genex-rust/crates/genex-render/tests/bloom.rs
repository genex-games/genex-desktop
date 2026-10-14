//! RQ4.2: threshold-free, energy-conserving bloom on the pre-exposed scene. The dual-filter chain
//! (Karis-weighted first downsample, 13-tap downsamples, additive tent upsamples) and its composite
//! in the tonemap, `mix(scene, bloom, intensity)`.
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test bloom -- --ignored metal
//!
//! Goldens live in `tests/fixtures/render-goldens/bloom/<name>.bgra` (raw BGRA, top row first,
//! 128x72); `GENEX_RENDER_GOLDEN_UPDATE=1` rewrites them instead. `GENEX_RENDER_EVIDENCE_DIR` also
//! writes each compared frame there; `GENEX_PERF_OUT` receives the bloom cost row as JSON.

use std::path::{Path, PathBuf};

use genex_render::Gpu;
use genex_render::capture::Capture;
use genex_render::device_class::DeviceClass;
use genex_render::post::bloom::{BloomImage, BloomSettings, COST_CHAINS_PER_SAMPLE, MIPS_MAX, bloom_chain_image, bloom_chain_image_msaa, bloom_gpu_ms};
use genex_render::post::tonemap::{bloom_image, tonemap_image};
use genex_render::presets::preset_quality;
use genex_render::settings::{BloomQuality, Look, Quality, QualityPreset, Tonemapper};

const WIDTH: u32 = 128;
const HEIGHT: u32 = 72;
/// A golden pixel may differ by this much per channel (another Apple GPU family rounds differently).
const GOLDEN_CHANNEL_TOLERANCE: u8 = 2;
/// Pixels allowed beyond the channel tolerance, of 9216.
const GOLDEN_OUTLIER_PIXELS: usize = 46;
/// How far the bloom image's mean radiance may move from the scene's (the energy row).
const ENERGY_TOLERANCE: f64 = 0.02;
/// The bloom budget at 1080p with 7 mips (plan §2.5), GPU ms.
const BLOOM_BUDGET_MS: f32 = 0.4;
/// Frames the cost row times.
const COST_FRAMES: u32 = 60;

// ---------------------------------------------------------------------------------------------
// CPU rows

fn chain(mips: u8, half_res: bool) -> BloomQuality {
    let mut quality = Quality::off().bloom;
    quality.enabled = true;
    quality.mips = mips;
    quality.half_res = half_res;
    quality
}

fn settings(intensity: f32, mips: u8) -> BloomSettings {
    BloomSettings::new(&Look::default().with_bloom(intensity, 0.0, 1.0), &chain(mips, true)).expect("bloom on")
}

#[test]
fn bloom_is_drawn_only_when_on_with_mips_and_intensity() {
    let look = Look::default();
    assert_eq!(BloomSettings::new(&look, &Quality::off().bloom), None, "the off preset draws no bloom");
    assert_eq!(BloomSettings::new(&look, &chain(0, true)), None, "no mips, no chain");
    assert_eq!(BloomSettings::new(&look.with_bloom(0.0, 0.0, 1.0), &chain(5, true)), None, "intensity 0 composites nothing");
    let on = BloomSettings::new(&look, &chain(6, true)).expect("on");
    assert_eq!((on.intensity, on.threshold, on.radius, on.quality.mips), (0.04, 0.0, 1.0, 6), "threshold-free, energy-conserving default");
    for preset in [QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra] {
        let quality = preset_quality(preset, DeviceClass::ALL[0]);
        assert!(BloomSettings::new(&look, &quality.bloom).is_some(), "{preset:?} draws bloom");
    }
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

fn goldens_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/render-goldens/bloom")
}

fn write_evidence(name: &str, capture: &Capture) {
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        let dir = PathBuf::from(dir);
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join(format!("{name}.bgra")), capture.bgra()).expect("evidence");
    }
}

/// Compare `capture` with the golden `name`, or rewrite it under `GENEX_RENDER_GOLDEN_UPDATE=1`.
fn check_golden(name: &str, capture: &Capture) {
    assert_eq!((capture.width(), capture.height()), (WIDTH, HEIGHT));
    write_evidence(name, capture);
    let path = goldens_dir().join(format!("{name}.bgra"));
    if std::env::var("GENEX_RENDER_GOLDEN_UPDATE").is_ok_and(|v| v == "1") {
        std::fs::create_dir_all(goldens_dir()).expect("goldens folder");
        std::fs::write(&path, capture.bgra()).expect("golden written");
        return;
    }
    let golden = std::fs::read(&path).unwrap_or_else(|error| panic!("golden {path:?} missing ({error}); render it with GENEX_RENDER_GOLDEN_UPDATE=1"));
    assert_eq!(golden.len(), capture.bgra().len());
    let mut outliers = 0;
    let mut worst = 0u8;
    for (a, b) in golden.chunks(4).zip(capture.bgra().chunks(4)) {
        let diff = a.iter().zip(b).map(|(p, q)| p.abs_diff(*q)).max().unwrap_or(0);
        worst = worst.max(diff);
        outliers += usize::from(diff > GOLDEN_CHANNEL_TOLERANCE);
    }
    assert!(outliers <= GOLDEN_OUTLIER_PIXELS, "{name}: {outliers} pixels differ from the golden by more than {GOLDEN_CHANNEL_TOLERANCE} (worst {worst})");
}

fn sq<T: std::ops::Mul<Output = T> + Copy>(v: T) -> T {
    v * v
}

fn luma(texel: &[f32; 4]) -> f64 {
    0.2126 * f64::from(texel[0]) + 0.7152 * f64::from(texel[1]) + 0.0722 * f64::from(texel[2])
}

fn mean_luma(texels: &[[f32; 4]]) -> f64 {
    texels.iter().map(luma).sum::<f64>() / texels.len() as f64
}

/// A `size` image: `background` everywhere plus `f(x, y)` (pixel centres).
fn image(size: (u32, u32), background: f32, f: impl Fn(f32, f32) -> [f32; 3]) -> Vec<[f32; 4]> {
    (0..size.1)
        .flat_map(|y| (0..size.0).map(move |x| (x, y)))
        .map(|(x, y)| {
            let add = f(x as f32 + 0.5, y as f32 + 0.5);
            [background + add[0], background + add[1], background + add[2], 1.0]
        })
        .collect()
}

/// The emitter scene: a dark room with a warm emissive panel, a small cool lamp and a lit floor
/// ramp, in pre-exposed radiance.
fn emitter_scene() -> Vec<[f32; 4]> {
    image((WIDTH, HEIGHT), 0.02, |x, y| {
        let panel = (40.0..56.0).contains(&x) && (20.0..44.0).contains(&y);
        let lamp = sq(x - 96.0) + sq(y - 30.0) < 9.0;
        let floor = if y > 56.0 { (y - 56.0) / 16.0 * 0.3 } else { 0.0 };
        if panel {
            [24.0, 14.0, 5.0]
        } else if lamp {
            [6.0, 9.0, 16.0]
        } else {
            [floor, floor * 0.9, floor * 0.8]
        }
    })
}

// ---------------------------------------------------------------------------------------------
// GPU rows

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_a_single_bright_texel_spreads_symmetrically() {
    let Some(gpu) = gpu() else { return };
    let size = (64, 64);
    let settings = settings(1.0, 5);
    // A block centred on (32, 32): a texel corner on every mip of the half-resolution chain, so
    // the spread must mirror exactly about it.
    let block = image(size, 0.0, |x, y| if (31.0..33.0).contains(&x) && (31.0..33.0).contains(&y) { [1.0; 3] } else { [0.0; 3] });
    let BloomImage { size: (w, h), texels: bloom } = bloom_chain_image(&gpu, &settings, size, &block).expect("chain");
    assert_eq!((w, h), (32, 32));
    let at = |x: u32, y: u32| luma(&bloom[(y * w + x) as usize]);
    let peak = at(15, 15);
    assert!(peak > 0.0, "the block blooms");
    for y in 0..h {
        for x in 0..w {
            let v = at(x, y);
            for mirror in [at(w - 1 - x, y), at(x, h - 1 - y), at(y, x)] {
                assert!((v - mirror).abs() <= peak * 1e-3, "({x}, {y}): {v} against its mirror {mirror}");
            }
        }
    }
    assert!(at(15, 8) > 0.0 && at(15, 8) < at(15, 12), "it spreads and falls off");

    // One texel off the grid, far from the edges (the smallest mips spread towards the frame's
    // centre where the edge clamps them): the spread's centroid stays on the texel and it is round.
    let size = (512, 512);
    let texel = image(size, 0.0, |x, y| if x as u32 == 229 && y as u32 == 277 { [1.0; 3] } else { [0.0; 3] });
    let BloomImage { size: (w, _), texels: bloom } = bloom_chain_image(&gpu, &settings, size, &texel).expect("chain");
    let total: f64 = bloom.iter().map(luma).sum();
    let moment = |axis: fn(u32, u32) -> f64| bloom.iter().enumerate().map(|(i, t)| luma(t) * axis(i as u32 % w, i as u32 / w)).sum::<f64>() / total;
    // Chain texel centres in full-resolution pixels.
    let (cx, cy) = (moment(|x, _| (f64::from(x) + 0.5) * 2.0), moment(|_, y| (f64::from(y) + 0.5) * 2.0));
    assert!((cx - 229.5).abs() < 0.5 && (cy - 277.5).abs() < 0.5, "centroid ({cx}, {cy}) on the texel (229.5, 277.5)");
    let spread_x = moment(|x, _| sq((f64::from(x) + 0.5) * 2.0 - 229.5));
    let spread_y = moment(|_, y| sq((f64::from(y) + 0.5) * 2.0 - 277.5));
    assert!((spread_x / spread_y - 1.0).abs() < 0.05, "round: {spread_x} against {spread_y}");
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_scene_plus_bloom_in_lerp_mode_conserves_energy_within_two_percent() {
    let Some(gpu) = gpu() else { return };
    // A soft lamp, a broad warm glow and a dim ramp: smooth emitters, no lone firefly texel, away
    // from the frame's edge (glow carried past the edge leaves the frame, as off-screen light never
    // enters it).
    let size = (256, 256);
    let scene = image(size, 0.05, |x, y| {
        let lamp = 4.0 * libm::expf(-(sq(x - 128.0) + sq(y - 120.0)) / (2.0 * 36.0));
        let glow = 1.5 * libm::expf(-(sq(x - 100.0) + sq(y - 150.0)) / (2.0 * 100.0));
        let ramp = 0.2 * x / 256.0;
        [lamp + glow + ramp, lamp * 0.8 + glow * 0.6 + ramp, lamp * 0.6 + glow * 0.3 + ramp]
    });
    let scene_mean = mean_luma(&scene);
    for mips in [5, 6, MIPS_MAX] {
        let bloom = bloom_chain_image(&gpu, &settings(1.0, mips), size, &scene).expect("chain").texels;
        let bloom_mean = mean_luma(&bloom);
        let drift = (bloom_mean / scene_mean - 1.0).abs();
        assert!(drift < ENERGY_TOLERANCE, "{mips} mips: bloom mean {bloom_mean} against the scene's {scene_mean} ({:.2}%)", drift * 100.0);
        // The lerp at any intensity keeps the frame's energy: (1 - t) E + t E'.
        for t in [0.04f64, 0.3, 1.0] {
            let composite = (1.0 - t) * scene_mean + t * bloom_mean;
            assert!((composite / scene_mean - 1.0).abs() < ENERGY_TOLERANCE, "{mips} mips at {t}");
        }
    }
    // Karis's weight takes energy from a lone firefly on purpose: it must not flicker the glow.
    let firefly = image(size, 0.0, |x, y| if x as u32 == 140 && y as u32 == 100 { [5000.0; 3] } else { [0.0; 3] });
    let bloom = bloom_chain_image(&gpu, &settings(1.0, 6), size, &firefly).expect("chain").texels;
    assert!(mean_luma(&bloom) < mean_luma(&firefly) * 0.25, "a firefly's bloom is held down");
    assert!(bloom.iter().all(|t| t.iter().all(|c| c.is_finite())), "no inf or NaN in the chain");
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_the_msaa_first_downsample_blooms_a_flat_field_into_itself() {
    let Some(gpu) = gpu() else { return };
    // The desktop MSAA path: the chain reads the samples the tonemap resolves in its own pass.
    let color = [0.75, 0.5, 0.25, 1.0];
    for mips in [1, 5] {
        let bloom = bloom_chain_image_msaa(&gpu, &settings(1.0, mips), (64, 36), 4, color).expect("msaa chain");
        assert_eq!(bloom.size, (32, 18));
        for texel in &bloom.texels {
            for c in 0..3 {
                assert!((f64::from(texel[c]) - color[c]).abs() < 2e-3, "{mips} mips: {texel:?} against {color:?}");
            }
        }
    }
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_bloom_off_is_the_bloom_free_picture_byte_for_byte() {
    let Some(gpu) = gpu() else { return };
    let scene = emitter_scene();
    for tonemapper in [Tonemapper::KhronosNeutral, Tonemapper::Agx, Tonemapper::Aces] {
        let plain = tonemap_image(&gpu, tonemapper, WIDTH, HEIGHT, &scene, true).expect("tonemap");
        let off = bloom_image(&gpu, tonemapper, (WIDTH, HEIGHT), &scene, None, true).expect("bloom off");
        assert_eq!(off.bgra(), plain.bgra(), "{tonemapper:?}: bloom off is the RQ3 HDR picture");
    }
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_an_emitter_blooms_into_its_dark_surroundings_golden() {
    let Some(gpu) = gpu() else { return };
    let scene = emitter_scene();
    let high = preset_quality(QualityPreset::High, DeviceClass::ALL[0]);
    let settings = BloomSettings::new(&Look::default(), &high.bloom).expect("high draws bloom");
    let plain = bloom_image(&gpu, Tonemapper::KhronosNeutral, (WIDTH, HEIGHT), &scene, None, false).expect("plain");
    let bloomed = bloom_image(&gpu, Tonemapper::KhronosNeutral, (WIDTH, HEIGHT), &scene, Some(settings), false).expect("bloom");
    write_evidence("emitter-off", &plain);
    let px = |capture: &Capture, x: u32, y: u32| {
        let i = ((y * WIDTH + x) * 4) as usize;
        u32::from(capture.bgra()[i]) + u32::from(capture.bgra()[i + 1]) + u32::from(capture.bgra()[i + 2])
    };
    // Beside the panel the dark wall glows; far from every emitter it barely moves.
    assert!(px(&bloomed, 60, 32) > px(&plain, 60, 32) + 6, "the panel's glow reaches the wall beside it");
    assert!(px(&bloomed, 36, 50) > px(&plain, 36, 50), "and below-left of it");
    let near = px(&bloomed, 60, 32) - px(&plain, 60, 32);
    let far = px(&bloomed, 4, 4).saturating_sub(px(&plain, 4, 4));
    assert!(far * 3 < near, "the glow falls off with distance: {far} in the far corner against {near} beside the panel");
    // Energy-conserving: the panel's own pixels give up what the glow takes.
    assert!(px(&bloomed, 48, 32) <= px(&plain, 48, 32), "the panel's core does not brighten");
    check_golden("emitter", &bloomed);
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_a_stylistic_threshold_spreads_only_what_is_above_it_and_keeps_the_rest() {
    let Some(gpu) = gpu() else { return };
    let scene = emitter_scene();
    let high = preset_quality(QualityPreset::High, DeviceClass::ALL[0]);
    // A strong look: half the over-threshold radiance spreads (the panel and the lamp are far above
    // the threshold, the floor ramp and the wall below it).
    let look = Look::default().with_bloom(0.5, 1.0, 1.0);
    let settings = BloomSettings::new(&look, &high.bloom).expect("bloom on");
    let plain = bloom_image(&gpu, Tonemapper::KhronosNeutral, (WIDTH, HEIGHT), &scene, None, false).expect("plain");
    let bloomed = bloom_image(&gpu, Tonemapper::KhronosNeutral, (WIDTH, HEIGHT), &scene, Some(settings), false).expect("bloom");
    write_evidence("threshold", &bloomed);
    let px = |capture: &Capture, x: u32, y: u32| {
        let i = ((y * WIDTH + x) * 4) as usize;
        u32::from(capture.bgra()[i]) + u32::from(capture.bgra()[i + 1]) + u32::from(capture.bgra()[i + 2])
    };
    // Below the threshold nothing is taken away: the lit floor and the dark wall keep their light
    // (a lerp towards a chain that holds only the over-threshold part would halve them).
    for (x, y) in [(8, 70), (120, 70), (64, 68), (4, 4), (120, 60)] {
        assert!(px(&bloomed, x, y) >= px(&plain, x, y), "({x}, {y}) darkened: {} against {}", px(&bloomed, x, y), px(&plain, x, y));
    }
    // Above it the glow spreads onto the wall beside the panel, and the panel's core gives it up.
    assert!(px(&bloomed, 60, 32) > px(&plain, 60, 32) + 6, "the panel's glow reaches the wall beside it");
    assert!(px(&bloomed, 48, 32) <= px(&plain, 48, 32), "the panel's core does not brighten");
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_bloom_seven_mips_at_1080p_holds_its_budget() {
    let Some(gpu) = gpu() else { return };
    let render = (1920, 1080);
    let ultra = preset_quality(QualityPreset::Ultra, DeviceClass::ALL[0]);
    assert_eq!(ultra.bloom.mips, MIPS_MAX, "ultra draws the full chain");
    let settings = BloomSettings::new(&Look::default(), &ultra.bloom).expect("ultra draws bloom");
    let Some(mut costs) = bloom_gpu_ms(&gpu, &settings, render, COST_FRAMES).expect("timed") else {
        eprintln!("skipped: the device has no TIMESTAMP_QUERY");
        return;
    };
    assert!(costs.len() as u32 >= COST_FRAMES / 2, "{} of {COST_FRAMES} frames timed", costs.len());
    costs.sort_by(f32::total_cmp);
    let p = |q: f32| costs[((costs.len() - 1) as f32 * q).round() as usize];
    let (p50, p95) = (p(0.5), p(0.95));
    if let Ok(path) = std::env::var("GENEX_PERF_OUT") {
        let row = format!(
            "{{\"row\":\"bloom\",\"render\":[{},{}],\"mips\":{},\"half_res\":{},\"samples\":{},\"chains_per_sample\":{COST_CHAINS_PER_SAMPLE},\"gpu_ms_p50\":{p50},\"gpu_ms_p95\":{p95},\"budget_ms\":{BLOOM_BUDGET_MS},\"backend\":\"{}\",\"adapter\":\"{}\"}}\n",
            render.0,
            render.1,
            settings.quality.mips,
            settings.quality.half_res,
            costs.len(),
            gpu.receipt().backend,
            gpu.receipt().adapter
        );
        std::fs::write(path, row).expect("perf row");
    }
    eprintln!("bloom 7 mips 1080p: p50 {p50:.3} ms, p95 {p95:.3} ms (mean of {COST_CHAINS_PER_SAMPLE} chains a sample)");
    assert!(p50 <= BLOOM_BUDGET_MS, "bloom p50 {p50} ms over the {BLOOM_BUDGET_MS} ms budget");
}
