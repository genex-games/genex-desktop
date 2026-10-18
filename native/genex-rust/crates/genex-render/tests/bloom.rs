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
use genex_render::post::bloom::{BloomImage, BloomSettings, CHAIN_MIPS, CHAIN_RESOLUTION, COST_CHAINS_PER_SAMPLE, bloom_chain_image, bloom_chain_image_msaa, bloom_gpu_ms};
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

fn chain(resolution: u16) -> BloomQuality {
    let mut quality = Quality::off().bloom;
    quality.enabled = true;
    quality.resolution = resolution;
    quality
}

fn settings(intensity: f32, spread: f32) -> BloomSettings {
    BloomSettings::new(&Look::default().with_bloom(intensity, 0.0, spread), &chain(CHAIN_RESOLUTION)).expect("bloom on")
}

#[test]
fn bloom_is_drawn_only_when_on_with_a_resolution_and_intensity() {
    let look = Look::default();
    assert_eq!(BloomSettings::new(&look, &Quality::off().bloom), None, "the off preset draws no bloom");
    assert_eq!(BloomSettings::new(&look, &chain(0)), None, "no resolution, no chain");
    assert_eq!(BloomSettings::new(&look.with_bloom(0.0, 0.0, 1.0), &chain(CHAIN_RESOLUTION)), None, "intensity 0 composites nothing");
    let on = BloomSettings::new(&look, &chain(CHAIN_RESOLUTION)).expect("on");
    assert_eq!((on.intensity, on.threshold, on.radius, on.quality.resolution), (0.04, 0.0, 1.0, CHAIN_RESOLUTION), "threshold-free, energy-conserving default");
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
    let settings = settings(1.0, 1.0);
    // A block centred on (32, 32): a texel corner on every mip of the half-resolution chain, so
    // the spread must mirror exactly about it.
    let block = image(size, 0.0, |x, y| if (31.0..33.0).contains(&x) && (31.0..33.0).contains(&y) { [1.0; 3] } else { [0.0; 3] });
    let BloomImage { size: (w, h), texels: bloom } = bloom_chain_image(&gpu, &settings, size, size, &block).expect("chain");
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
    let BloomImage { size: (w, _), texels: bloom } = bloom_chain_image(&gpu, &settings, size, size, &texel).expect("chain");
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
    // P2-0.13 flipped (was 5, 6 and 7 mips): the chain's depth is fixed; its spread's weights
    // must keep the energy as the mip counts did.
    for spread in [0.5, 1.0, 2.0] {
        let bloom = bloom_chain_image(&gpu, &settings(1.0, spread), size, size, &scene).expect("chain").texels;
        let bloom_mean = mean_luma(&bloom);
        let drift = (bloom_mean / scene_mean - 1.0).abs();
        assert!(drift < ENERGY_TOLERANCE, "spread {spread}: bloom mean {bloom_mean} against the scene's {scene_mean} ({:.2}%)", drift * 100.0);
        // The lerp at any intensity keeps the frame's energy: (1 - t) E + t E'.
        for t in [0.04f64, 0.3, 1.0] {
            let composite = (1.0 - t) * scene_mean + t * bloom_mean;
            assert!((composite / scene_mean - 1.0).abs() < ENERGY_TOLERANCE, "spread {spread} at {t}");
        }
    }
    // Karis's weight takes energy from a lone firefly on purpose: it must not flicker the glow.
    let firefly = image(size, 0.0, |x, y| if x as u32 == 140 && y as u32 == 100 { [5000.0; 3] } else { [0.0; 3] });
    let bloom = bloom_chain_image(&gpu, &settings(1.0, 1.0), size, size, &firefly).expect("chain").texels;
    assert!(mean_luma(&bloom) < mean_luma(&firefly) * 0.25, "a firefly's bloom is held down");
    assert!(bloom.iter().all(|t| t.iter().all(|c| c.is_finite())), "no inf or NaN in the chain");
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_the_msaa_first_downsample_blooms_a_flat_field_into_itself() {
    let Some(gpu) = gpu() else { return };
    // The desktop MSAA path: the chain reads the samples the tonemap resolves in its own pass.
    // P2-0.13 flipped (was 1 and 5 mips): the chain at twice the scene's size (a bilinear 2x2) and
    // at four times it (a 4K output's, the area filter), each spread.
    let color = [0.75, 0.5, 0.25, 1.0];
    for (resolution, top) in [(CHAIN_RESOLUTION, (32, 18)), (9, (16, 9))] {
        for spread in [1.0, 3.0] {
            let settings = BloomSettings::new(&Look::default().with_bloom(1.0, 0.0, spread), &chain(resolution)).expect("bloom on");
            let bloom = bloom_chain_image_msaa(&gpu, &settings, (64, 36), 4, color).expect("msaa chain");
            assert_eq!(bloom.size, top);
            for texel in &bloom.texels {
                for c in 0..3 {
                    assert!((f64::from(texel[c]) - color[c]).abs() < 2e-3, "a {top:?} chain, spread {spread}: {texel:?} against {color:?}");
                }
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
fn metal_bloom_at_1080p_holds_its_budget() {
    let Some(gpu) = gpu() else { return };
    let render = (1920, 1080);
    let ultra = preset_quality(QualityPreset::Ultra, DeviceClass::ALL[0]);
    assert_eq!(genex_render::post::bloom::chain_sizes(render, &ultra.bloom).len(), usize::from(CHAIN_MIPS), "ultra draws the full chain");
    let settings = BloomSettings::new(&Look::default(), &ultra.bloom).expect("ultra draws bloom");
    let Some(mut costs) = bloom_gpu_ms(&gpu, &settings, render, render, COST_FRAMES).expect("timed") else {
        eprintln!("skipped: the device has no TIMESTAMP_QUERY");
        return;
    };
    assert!(costs.len() as u32 >= COST_FRAMES / 2, "{} of {COST_FRAMES} frames timed", costs.len());
    costs.sort_by(f32::total_cmp);
    let p = |q: f32| costs[((costs.len() - 1) as f32 * q).round() as usize];
    let (p50, p95) = (p(0.5), p(0.95));
    if let Ok(path) = std::env::var("GENEX_PERF_OUT") {
        let row = format!(
            "{{\"row\":\"bloom\",\"render\":[{},{}],\"mips\":{CHAIN_MIPS},\"resolution\":{},\"samples\":{},\"chains_per_sample\":{COST_CHAINS_PER_SAMPLE},\"gpu_ms_p50\":{p50},\"gpu_ms_p95\":{p95},\"budget_ms\":{BLOOM_BUDGET_MS},\"backend\":\"{}\",\"adapter\":\"{}\"}}\n",
            render.0,
            render.1,
            settings.quality.resolution,
            costs.len(),
            gpu.receipt().backend,
            gpu.receipt().adapter
        );
        std::fs::write(path, row).expect("perf row");
    }
    eprintln!("bloom 1080p: p50 {p50:.3} ms, p95 {p95:.3} ms (mean of {COST_CHAINS_PER_SAMPLE} chains a sample)");
    assert!(p50 <= BLOOM_BUDGET_MS, "bloom p50 {p50} ms over the {BLOOM_BUDGET_MS} ms budget");
}

// ---------------------------------------------------------------------------------------------
// Renderer pass 2, P2-0.13 (P5, P6): the chain is sized from the output, not the render size, and
// keeps one mip count on every preset; spread is per-mip weights, the tent stays at one texel.

/// How far a halo's width may move across presets and DRS steps (the WP's acceptance).
const HALO_TOLERANCE: f64 = 0.05;
/// How far a spread may move the bloom image's energy from spread 1's.
const SPREAD_ENERGY_TOLERANCE: f64 = 0.005;
/// The bloom budget at every D7 output (plan §2.5 and D7), GPU ms.
const BLOOM_OUTPUT_BUDGET_MS: f32 = 0.4;

/// Desktop presets that draw bloom and every class's presets, each resolved for `class`.
fn bloom_presets(class: DeviceClass) -> Vec<(QualityPreset, BloomQuality)> {
    [QualityPreset::Low, QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra]
        .into_iter()
        .map(|preset| (preset, preset_quality(preset, class).bloom))
        .filter(|(_, bloom)| BloomSettings::new(&Look::default(), bloom).is_some())
        .collect()
}

#[test]
fn the_chain_is_sized_from_the_output_with_one_mip_count_on_every_preset() {
    for output in [(1280, 720), (1920, 1080), (2560, 1440), (3840, 2160)] {
        for class in DeviceClass::ALL {
            let presets = bloom_presets(class);
            let Some((_, first)) = presets.first() else { continue };
            let chain = genex_render::post::bloom::chain_sizes(output, first);
            for (preset, bloom) in &presets {
                assert_eq!(genex_render::post::bloom::chain_sizes(output, bloom), chain, "{} {preset:?} at {output:?}: the same chain as every other preset", class.wire());
            }
            let top = chain[0];
            assert!(top.1 <= 540 && top.1 <= output.1 / 2, "{} at {output:?}: the chain's top {top:?} is at most min(h / 2, 540) rows", class.wire());
            let aspect = |(w, h): (u32, u32)| f64::from(w) / f64::from(h);
            assert!((aspect(top) / aspect(output) - 1.0).abs() < 0.01, "{} at {output:?}: the top {top:?} keeps the output's aspect", class.wire());
        }
    }
}

#[test]
fn spread_is_per_mip_weights_that_keep_the_energy() {
    let n = 7;
    let equal = genex_render::post::bloom::mip_weights(1.0, n);
    assert_eq!(equal.len(), n);
    assert!(equal.iter().all(|w| (w - 1.0 / n as f32).abs() < 1e-6), "spread 1 weighs every mip alike: {equal:?}");
    for spread in [0.25, 0.5, 1.4, 2.0, 4.0] {
        let weights = genex_render::post::bloom::mip_weights(spread, n);
        let sum: f32 = weights.iter().sum();
        assert!((sum - 1.0).abs() < 1e-5, "spread {spread}: the weights sum to 1 ({sum})");
        let rising = weights.windows(2).all(|pair| if spread > 1.0 { pair[1] > pair[0] } else { pair[1] < pair[0] });
        assert!(rising, "spread {spread}: a wider spread weighs the wider mips more ({weights:?})");
    }
}

#[test]
fn the_budget_ledger_counts_the_output_sized_chain_at_every_drs_step() {
    use genex_render::budget::{BudgetInput, ledger};
    use genex_render::settings::SceneFormat;
    let output = (1920, 1080);
    let ultra = preset_quality(QualityPreset::Ultra, DeviceClass::ALL[0]);
    let bytes = |scale: f32| {
        let input = BudgetInput::new(output, scale, SceneFormat::Rgba16Float, false);
        ledger(&ultra, &input).entries().iter().filter(|entry| entry.label == "bloom").map(|entry| entry.bytes).sum::<u64>()
    };
    let chain = genex_render::post::bloom::chain_bytes(output, &ultra.bloom);
    for scale in [1.0, 0.75, 0.6] {
        assert_eq!(bytes(scale), chain, "scale {scale}: the ledger holds the chain the renderer allocates");
    }
}

/// A `size` scene holding a small round emitter of fixed size and place on the screen: a Gaussian
/// `sigma` output pixels wide at uv `centre`, `peak` radiance, sampled at each scene texel's centre
/// (so every render size holds the same picture).
fn screen_emitter(render: (u32, u32), output: (u32, u32), centre: (f64, f64), sigma: f64, peak: f32) -> Vec<[f32; 4]> {
    let to_output = (f64::from(output.0) / f64::from(render.0), f64::from(output.1) / f64::from(render.1));
    image(render, 0.0, |x, y| {
        let (ox, oy) = (f64::from(x) * to_output.0, f64::from(y) * to_output.1);
        let (cx, cy) = (centre.0 * f64::from(output.0), centre.1 * f64::from(output.1));
        let v = peak * libm::exp(-(sq(ox - cx) + sq(oy - cy)) / (2.0 * sq(sigma))) as f32;
        [v, v, v]
    })
}

/// A bloom image's halo around uv `centre`, in output pixels: the full width at half maximum of
/// its horizontal profile through the centre (bilinear), and the radius holding half its energy.
#[derive(Clone, Copy, Debug)]
struct Halo {
    fwhm: f64,
    r50: f64,
}

fn halo(image: &BloomImage, output: (u32, u32), centre: (f64, f64)) -> Halo {
    let (w, h) = image.size;
    let px = (f64::from(output.0) / f64::from(w), f64::from(output.1) / f64::from(h));
    let at = |x: f64, y: f64| {
        // Bilinear between texel centres, clamped at the edge.
        let (fx, fy) = ((x - 0.5).clamp(0.0, f64::from(w - 1)), (y - 0.5).clamp(0.0, f64::from(h - 1)));
        let (x0, y0) = (fx.floor() as u32, fy.floor() as u32);
        let (x1, y1) = ((x0 + 1).min(w - 1), (y0 + 1).min(h - 1));
        let (tx, ty) = (fx - f64::from(x0), fy - f64::from(y0));
        let t = |x: u32, y: u32| luma(&image.texels[(y * w + x) as usize]);
        (t(x0, y0) * (1.0 - tx) + t(x1, y0) * tx) * (1.0 - ty) + (t(x0, y1) * (1.0 - tx) + t(x1, y1) * tx) * ty
    };
    let (cx, cy) = (centre.0 * f64::from(w), centre.1 * f64::from(h));
    let peak = at(cx, cy);
    let step = 0.01;
    let edge = |dir: f64| {
        let mut d = 0.0;
        while at(cx + dir * d, cy) > peak * 0.5 && d < f64::from(w) {
            d += step;
        }
        d
    };
    let fwhm = (edge(1.0) + edge(-1.0)) * px.0;
    let mut texels: Vec<(f64, f64)> = (0..h)
        .flat_map(|y| (0..w).map(move |x| (x, y)))
        .map(|(x, y)| {
            let (dx, dy) = ((f64::from(x) + 0.5 - cx) * px.0, (f64::from(y) + 0.5 - cy) * px.1);
            ((sq(dx) + sq(dy)).sqrt(), luma(&image.texels[(y * w + x) as usize]))
        })
        .collect();
    texels.sort_by(|a, b| a.0.total_cmp(&b.0));
    let total: f64 = texels.iter().map(|(_, v)| v).sum();
    let mut held = 0.0;
    let r50 = texels.iter().find(|(_, v)| {
        held += v;
        held >= total * 0.5
    });
    Halo { fwhm, r50: r50.map_or(0.0, |(r, _)| *r) }
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_a_point_emitters_halo_is_as_wide_on_every_preset_and_drs_step() {
    let Some(gpu) = gpu() else { return };
    let centre = (0.41, 0.47);
    let mut report = String::new();
    let mut failures = Vec::new();
    for (class, output, scales) in [
        (DeviceClass::ALL[0], (1920, 1080), [1.0, 0.6]),
        (DeviceClass::ALL[1], (2560, 1440), [1.0, 0.6]),
        (DeviceClass::ALL[4], (2532, 1170), [0.75, 0.6]),
    ] {
        let mut reference: Option<Halo> = None;
        for (preset, quality) in bloom_presets(class).into_iter().rev() {
            let settings = BloomSettings::new(&Look::default(), &quality).expect("bloom on");
            for scale in scales {
                let render = genex_render::presets::step_size(output, scale);
                let scene = screen_emitter(render, output, centre, 2.0, 20.0);
                let image = bloom_chain_image(&gpu, &settings, render, output, &scene).expect("chain");
                let measured = halo(&image, output, centre);
                let base = *reference.get_or_insert(measured);
                let (dw, dr) = (measured.fwhm / base.fwhm - 1.0, measured.r50 / base.r50 - 1.0);
                let line = format!("{} {preset:?} scale {scale} render {render:?}: fwhm {:.2} px ({:+.1}%), r50 {:.1} px ({:+.1}%)", class.wire(), measured.fwhm, dw * 100.0, measured.r50, dr * 100.0);
                report.push_str(&line);
                report.push('\n');
                if dw.abs() > HALO_TOLERANCE || dr.abs() > HALO_TOLERANCE {
                    failures.push(line);
                }
            }
        }
    }
    eprintln!("{report}");
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(PathBuf::from(dir).join("halo-widths.txt"), &report).expect("evidence");
    }
    assert!(failures.is_empty(), "halo wider or narrower than the class's first preset at scale 1 by more than {}%:\n{}", HALO_TOLERANCE * 100.0, failures.join("\n"));
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_a_wide_spread_glows_smoothly_without_a_lattice() {
    let Some(gpu) = gpu() else { return };
    let size = (512, 512);
    let centre = (0.5 + 0.3 / 512.0, 0.5 + 0.7 / 512.0);
    let high = preset_quality(QualityPreset::High, DeviceClass::ALL[0]);
    let scene = screen_emitter(size, size, centre, 1.0, 20.0);
    for spread in [2.0, 3.0, 4.0] {
        let settings = BloomSettings::new(&Look::default().with_bloom(1.0, 0.0, spread), &high.bloom).expect("bloom on");
        let image = bloom_chain_image(&gpu, &settings, size, size, &scene).expect("chain");
        let (w, h) = image.size;
        let (cx, cy) = (centre.0 * f64::from(w), centre.1 * f64::from(h));
        let at = |x: f64, y: f64| {
            let (ix, iy) = ((x.floor() as u32).min(w - 1), (y.floor() as u32).min(h - 1));
            luma(&image.texels[(iy * w + ix) as usize])
        };
        // Walking out from the emitter along each of eight directions, the glow never rises again
        // (a sparse tent rings: each mip's copies sit its tap spacing apart).
        let mut rises = 0;
        let mut worst = 0.0f64;
        for k in 0..8 {
            let angle = f64::from(k) * std::f64::consts::FRAC_PI_4;
            let (dx, dy) = (angle.cos(), angle.sin());
            let mut last = at(cx, cy);
            for step in 1..200 {
                let r = f64::from(step) * 0.5;
                let v = at(cx + dx * r, cy + dy * r);
                if v > last * 1.02 + 1e-9 {
                    rises += 1;
                    worst = worst.max(v / last - 1.0);
                }
                last = v;
            }
        }
        assert_eq!(rises, 0, "spread {spread}: the glow rises {rises} times walking outwards (worst +{:.1}%)", worst * 100.0);
        // Round: at each radius the diagonal holds what the axis holds.
        for r in [6.0, 12.0, 24.0, 48.0] {
            let axis = (at(cx + r, cy) + at(cx - r, cy) + at(cx, cy + r) + at(cx, cy - r)) / 4.0;
            let d = r * std::f64::consts::FRAC_1_SQRT_2;
            let diagonal = (at(cx + d, cy + d) + at(cx - d, cy + d) + at(cx + d, cy - d) + at(cx - d, cy - d)) / 4.0;
            assert!((diagonal / axis - 1.0).abs() < 0.2, "spread {spread} at {r} texels: diagonal {diagonal} against axis {axis} (a star)");
        }
    }
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_spread_widens_the_halo_and_keeps_the_energy() {
    let Some(gpu) = gpu() else { return };
    let size = (512, 512);
    let centre = (0.5, 0.5);
    let high = preset_quality(QualityPreset::High, DeviceClass::ALL[0]);
    // A soft lamp: no lone texel for Karis's weight to hold down.
    let scene = screen_emitter(size, size, centre, 6.0, 2.0);
    let scene_mean = mean_luma(&scene);
    let measure = |spread: f32| {
        let settings = BloomSettings::new(&Look::default().with_bloom(1.0, 0.0, spread), &high.bloom).expect("bloom on");
        let image = bloom_chain_image(&gpu, &settings, size, size, &scene).expect("chain");
        (halo(&image, size, centre), mean_luma(&image.texels) / scene_mean)
    };
    // Karis's weight holds a bright lamp's energy down alike at every spread; the spread itself
    // moves none of it.
    let (_, reference) = measure(1.0);
    let mut last = 0.0;
    let mut report = String::new();
    for spread in [0.25, 0.5, 1.0, 1.4, 2.0, 4.0] {
        let (measured, energy) = measure(spread);
        let line = format!("spread {spread}: fwhm {:.2} px, r50 {:.2} px, energy {energy:.4}", measured.fwhm, measured.r50);
        eprintln!("{line}");
        report.push_str(&line);
        report.push('\n');
        assert!(measured.r50 > last, "spread {spread}: r50 {} not wider than the narrower spread's {last}", measured.r50);
        last = measured.r50;
        assert!((energy / reference - 1.0).abs() < SPREAD_ENERGY_TOLERANCE, "spread {spread}: energy {energy:.4} against {reference:.4} at spread 1");
    }
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(PathBuf::from(dir).join("spread-widths.txt"), &report).expect("evidence");
    }
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_bloom_holds_its_budget_at_every_output_and_drs_step() {
    let Some(gpu) = gpu() else { return };
    let ultra = preset_quality(QualityPreset::Ultra, DeviceClass::ALL[0]);
    let settings = BloomSettings::new(&Look::default(), &ultra.bloom).expect("ultra draws bloom");
    let mut report = String::new();
    let mut over = Vec::new();
    for (output, scale) in [((1920, 1080), 1.0), ((1920, 1080), 0.6), ((2560, 1440), 1.0), ((3840, 2160), 1.0), ((3840, 2160), 0.6)] {
        let render = genex_render::presets::step_size(output, scale);
        let Some(mut costs) = bloom_gpu_ms(&gpu, &settings, render, output, COST_FRAMES).expect("timed") else {
            eprintln!("skipped: the device has no TIMESTAMP_QUERY");
            return;
        };
        costs.sort_by(f32::total_cmp);
        let p = |q: f32| costs[((costs.len() - 1) as f32 * q).round() as usize];
        let line = format!("output {output:?} render {render:?}: p50 {:.3} ms, p95 {:.3} ms, min {:.3} ms", p(0.5), p(0.95), p(0.0));
        report.push_str(&line);
        report.push('\n');
        if p(0.5) > BLOOM_OUTPUT_BUDGET_MS {
            over.push(line);
        }
    }
    eprintln!("{report}");
    if let Ok(path) = std::env::var("GENEX_PERF_OUT") {
        std::fs::write(format!("{path}.outputs.txt"), &report).expect("perf rows");
    }
    assert!(over.is_empty(), "bloom over {BLOOM_OUTPUT_BUDGET_MS} ms:\n{}", over.join("\n"));
}
