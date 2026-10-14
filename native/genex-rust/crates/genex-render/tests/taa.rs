//! RQ5.2: TAA's resolve. Halton jitter keyed to the frame index, accumulation
//! `max(1 / (n + 1), alpha_min)` after a reset, YCoCg variance clipping, depth disocclusion, motion
//! reprojection, the reactive mask, the exposure ratio, the texture LOD bias and determinism,
//! checked on the resolve node itself with synthetic jittered scenes (the scene-level rows,
//! through the renderer, land with the node's graph wiring).
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test taa -- --ignored metal
//!
//! The texture LOD bias row draws `shaders/lighting/surface.wgsl` itself over a mip-coded texture
//! (both its class and its class-0 sampling paths), so the bias a scaled scene samples with under
//! TAA is checked without the renderer.
//!
//! The settled static scene's golden lives in `tests/fixtures/render-goldens/taa/static-settled.bgra`
//! (raw sRGB BGRA, 64x48, top row first); `GENEX_RENDER_GOLDEN_UPDATE=1` rewrites it instead.
//! `GENEX_RENDER_EVIDENCE_DIR` receives each row's frames as raw RGBA8 (`<name>.rgba`, with the
//! size in the name); `GENEX_PERF_OUT` receives the TAA cost row as JSON.

use genex_render::Gpu;
use genex_render::jitter::offset_px;
use genex_render::post::taa::{
    COST_RESOLVES_PER_SAMPLE, FILTER_FALLOFF, GpuTaaParams, IDENTITY, REACTIVE, REACTIVE_PARTICLES, TaaFlags, TaaFrameImage, TaaImage, accumulation_weight, reprojection,
    taa_gpu_ms, taa_resolve_images,
};
use genex_render::settings::{JitterCycle, RenderSettings, TaaQuality};

const SIZE: (u32, u32) = (64, 48);
/// The jitter cycle the rows settle over.
const CYCLE: JitterCycle = JitterCycle::Eight;
/// The foreground and background radiance (pre-exposed, display range).
const FG: [f32; 3] = [0.9, 0.7, 0.3];
const BG: [f32; 3] = [0.08, 0.12, 0.2];
/// Device depth (reverse-Z) of the foreground and the background.
const FG_DEPTH: f32 = 0.5;
const BG_DEPTH: f32 = 0.2;
/// The TAA budget at 1080p (plan §2.5), GPU ms.
const TAA_BUDGET_MS: f32 = 0.3;
/// Frames the cost row times.
const COST_FRAMES: u32 = 60;

// ---------------------------------------------------------------------------------------------
// Scenes

/// Slanted stripes (period 7 px, 0.3 rad): an edge in most rows, so aliasing shows everywhere.
fn stripes(x: f32, y: f32) -> bool {
    let along = x * libm::cosf(0.3) + y * libm::sinf(0.3);
    (along / 7.0).rem_euclid(1.0) < 0.5
}

fn shade(fg: bool) -> [f32; 4] {
    let c = if fg { FG } else { BG };
    [c[0], c[1], c[2], 1.0]
}

/// A frame of `inside` point-sampled at each pixel centre moved by `jitter` (render pixels, y
/// down), with its depth.
fn sample(inside: &dyn Fn(f32, f32) -> bool, jitter: [f32; 2]) -> (Vec<[f32; 4]>, Vec<f32>) {
    let (w, h) = SIZE;
    let hits: Vec<bool> = (0..h).flat_map(|y| (0..w).map(move |x| (x, y))).map(|(x, y)| inside(x as f32 + 0.5 + jitter[0], y as f32 + 0.5 + jitter[1])).collect();
    (hits.iter().map(|&fg| shade(fg)).collect(), hits.iter().map(|&fg| if fg { FG_DEPTH } else { BG_DEPTH }).collect())
}

/// The mean of `inside`'s shade over an `n` x `n` grid in every pixel (the supersampled reference).
fn supersampled(inside: &dyn Fn(f32, f32) -> bool, n: u32) -> Vec<[f32; 4]> {
    let (w, h) = SIZE;
    (0..h)
        .flat_map(|y| (0..w).map(move |x| (x, y)))
        .map(|(x, y)| {
            let mut sum = [0.0f32; 4];
            for (i, j) in (0..n).flat_map(|i| (0..n).map(move |j| (i, j))) {
                let s = shade(inside(x as f32 + (i as f32 + 0.5) / n as f32, y as f32 + (j as f32 + 0.5) / n as f32));
                for c in 0..4 {
                    sum[c] += s[c];
                }
            }
            sum.map(|v| v / (n * n) as f32)
        })
        .collect()
}

/// The mean of the first `count` jittered frames (what an equal-weight accumulation reaches while
/// `1 / (n + 1)` is above the floor).
fn jittered_mean(inside: &dyn Fn(f32, f32) -> bool, count: u64) -> Vec<[f32; 4]> {
    let frames: Vec<Vec<[f32; 4]>> = (0..count).map(|i| sample(inside, offset_px(i, CYCLE)).0).collect();
    (0..frames[0].len()).map(|p| std::array::from_fn(|c| frames.iter().map(|f| f[p][c]).sum::<f32>() / count as f32)).collect()
}

/// The mean of the frames of one jitter cycle (what an equal-weight accumulation converges to).
fn cycle_mean(inside: &dyn Fn(f32, f32) -> bool) -> Vec<[f32; 4]> {
    jittered_mean(inside, u64::from(CYCLE.frames()))
}

fn row(frame_index: u64, reset: bool, jitter: [f32; 2], prev_jitter: [f32; 2]) -> GpuTaaParams {
    let mut config = RenderSettings::off().frame_config(SIZE, 1.0, frame_index, reset);
    config.jitter = jitter;
    let mut row = GpuTaaParams::new(&TaaQuality::DEFAULT, &config, prev_jitter, 1.0);
    row.counts[2] = 1; // reverse-Z, as the HDR path draws
    row
}

/// One jitter cycle of a static `inside`, from a reset.
fn static_cycle(inside: &dyn Fn(f32, f32) -> bool, flags: TaaFlags) -> Vec<TaaFrameImage> {
    (0..u64::from(CYCLE.frames()))
        .map(|i| {
            let jitter = offset_px(i, CYCLE);
            let prev = if i == 0 { jitter } else { offset_px(i - 1, CYCLE) };
            let (scene, depth) = sample(inside, jitter);
            TaaFrameImage { scene, depth, motion: Vec::new(), reactive: Vec::new(), row: row(i, i == 0, jitter, prev).with_flags(flags) }
        })
        .collect()
}

fn idx(x: u32, y: u32) -> usize {
    (y * SIZE.0 + x) as usize
}

fn rgb_error(a: &[f32; 4], b: &[f32; 4]) -> f32 {
    (0..3).map(|c| (a[c] - b[c]).abs()).sum::<f32>() / 3.0
}

/// The mean error of `image` against `reference` over the pixels `reference` shows partly covered.
fn edge_mae(image: &[[f32; 4]], reference: &[[f32; 4]]) -> f32 {
    let edges: Vec<usize> = (0..reference.len()).filter(|&p| rgb_error(&reference[p], &shade(true)) > 0.01 && rgb_error(&reference[p], &shade(false)) > 0.01).collect();
    assert!(edges.len() > 100, "the scene has edges: {}", edges.len());
    edges.iter().map(|&p| rgb_error(&image[p], &reference[p])).sum::<f32>() / edges.len() as f32
}

fn evidence(name: &str, image: &TaaImage) {
    let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") else { return };
    let _ = std::fs::create_dir_all(&dir);
    let encode = |v: f32| {
        let v = v.clamp(0.0, 1.0);
        let s = if v <= 0.003_130_8 { v * 12.92 } else { 1.055 * libm::powf(v, 1.0 / 2.4) - 0.055 };
        (s * 255.0).round() as u8
    };
    let bytes: Vec<u8> = image.texels.iter().flat_map(|t| [encode(t[0]), encode(t[1]), encode(t[2]), 255]).collect();
    let path = std::path::Path::new(&dir).join(format!("{name}-{}x{}.rgba", image.size.0, image.size.1));
    std::fs::write(path, bytes).expect("evidence");
}

fn evidence_texels(name: &str, texels: &[[f32; 4]]) {
    evidence(name, &TaaImage { size: SIZE, texels: texels.to_vec() });
}

// ---------------------------------------------------------------------------------------------
// CPU rows

#[test]
fn a_reset_takes_one_frame_and_a_cycle_averages_evenly_before_the_floor() {
    let k = u64::from(CYCLE.frames());
    let weights: Vec<f32> = (0..k).map(|n| accumulation_weight(n, TaaQuality::DEFAULT.alpha_min)).collect();
    // Weight 1 / (n + 1) gives each of the cycle's frames the same share: an exact box average.
    let mut shares = vec![0.0f64; k as usize];
    for (n, w) in weights.iter().enumerate() {
        for share in shares.iter_mut().take(n) {
            *share *= 1.0 - f64::from(*w);
        }
        shares[n] = f64::from(*w);
    }
    assert!(shares.iter().all(|s| (s - 1.0 / k as f64).abs() < 1e-6), "{shares:?}");
}

#[test]
fn the_reactive_shaders_validate_against_webgpu_core_and_emit_everywhere() {
    for (name, source) in [("taa-reactive", REACTIVE), ("taa-reactive-particles", REACTIVE_PARTICLES)] {
        let module = naga::front::wgsl::parse_str(source).unwrap_or_else(|error| panic!("{name}: {}", error.emit_to_string(source)));
        let info = naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::empty())
            .validate(&module)
            .unwrap_or_else(|error| panic!("{name}: {error:?}"));
        let hlsl_options = naga::back::hlsl::Options { shader_model: naga::back::hlsl::ShaderModel::V5_1, ..Default::default() };
        let mut hlsl = String::new();
        naga::back::hlsl::Writer::new(&mut hlsl, &hlsl_options, &naga::back::hlsl::PipelineOptions::default())
            .write(&module, &info, None)
            .unwrap_or_else(|error| panic!("{name} HLSL SM 5.1: {error:?}"));
        let msl_options = naga::back::msl::Options { lang_version: (2, 4), ..Default::default() };
        naga::back::msl::write_string(&module, &info, &msl_options, &naga::back::msl::PipelineOptions::default()).unwrap_or_else(|error| panic!("{name} MSL 2.4: {error:?}"));
        let spv_options = naga::back::spv::Options { lang_version: (1, 3), ..Default::default() };
        naga::back::spv::write_vec(&module, &info, &spv_options, None).unwrap_or_else(|error| panic!("{name} SPIR-V 1.3: {error:?}"));
        let entries: Vec<&str> = module.entry_points.iter().map(|entry| entry.name.as_str()).collect();
        assert!(entries.len() >= 2, "{name}: {entries:?}");
    }
}

// ---------------------------------------------------------------------------------------------
// GPU rows

/// The GPU rows run one at a time, so the cost row times the resolve alone on the GPU.
static GPU_ROWS: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn gpu() -> Option<(std::sync::MutexGuard<'static, ()>, Gpu)> {
    let lock = GPU_ROWS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    match Gpu::headless() {
        Ok(gpu) => {
            if require {
                assert_eq!(gpu.receipt().backend, "metal", "GENEX_REQUIRE_METAL=1 but the adapter is not Metal");
            }
            Some((lock, gpu))
        }
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(error) => {
            eprintln!("skipped: no WebGPU-core adapter ({error})");
            None
        }
    }
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_a_static_scene_settles_to_the_supersampled_reference_in_one_jitter_cycle() {
    let Some((_rows, gpu)) = gpu() else { return };
    let frames = static_cycle(&stripes, TaaFlags::CLIP);
    let images = taa_resolve_images(&gpu, SIZE, &frames).expect("resolved");
    let settled = &images.last().expect("a cycle").texels;
    let mean = cycle_mean(&stripes);
    let reference = supersampled(&stripes, 16);
    let aliased = &frames.last().expect("a cycle").scene;
    evidence("static-aliased", &TaaImage { size: SIZE, texels: aliased.clone() });
    evidence("static-settled", images.last().expect("a cycle"));
    evidence_texels("static-reference-16x", &reference);
    let to_mean = edge_mae(settled, &mean);
    let to_reference = edge_mae(settled, &reference);
    let aliased_error = edge_mae(aliased, &reference);
    eprintln!("edge MAE: settled vs cycle mean {to_mean:.5}, settled vs 16x {to_reference:.5}, aliased vs 16x {aliased_error:.5}");
    assert!(to_mean < 2.0 / 255.0, "one cycle accumulates every jittered frame evenly with clipping on: {to_mean}");
    assert!(to_reference * 3.0 < aliased_error, "the settled edges are far closer to 16x supersampling than one frame: {to_reference} vs {aliased_error}");
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_a_reset_takes_the_current_sample_whole() {
    let Some((_rows, gpu)) = gpu() else { return };
    let mut frames = static_cycle(&stripes, TaaFlags::CLIP);
    let jitter = offset_px(0, CYCLE);
    let shifted = |x: f32, y: f32| stripes(x + 3.0, y);
    let (scene, depth) = sample(&shifted, jitter);
    frames.push(TaaFrameImage { scene: scene.clone(), depth, motion: Vec::new(), reactive: Vec::new(), row: row(0, true, jitter, jitter) });
    let images = taa_resolve_images(&gpu, SIZE, &frames).expect("resolved");
    let after = &images.last().expect("frames").texels;
    let worst = (0..after.len()).map(|p| rgb_error(&after[p], &scene[p])).fold(0.0f32, f32::max);
    assert!(worst < 1e-3, "a reset frame shows the current sample: worst {worst}");
}

/// A square of `half` px centred at `cx` over the static stripes' lower half (a separate region).
fn square(cx: f32, half: f32) -> impl Fn(f32, f32) -> bool {
    move |x: f32, y: f32| (x - cx).abs() < half && (y - 14.0).abs() < half
}

/// The stripes below row 28, plus `object` above it.
fn with_object(object: &dyn Fn(f32, f32) -> bool) -> impl Fn(f32, f32) -> bool + '_ {
    move |x: f32, y: f32| if y < 28.0 { object(x, y) } else { stripes(x, y) }
}

fn object_depth(depth: &mut [f32], object: &dyn Fn(f32, f32) -> bool) {
    for y in 0..SIZE.1 {
        for x in 0..SIZE.0 {
            if (y as f32) < 28.0 {
                depth[idx(x, y)] = if object(x as f32 + 0.5, y as f32 + 0.5) { FG_DEPTH } else { 0.0 };
            }
        }
    }
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_a_fast_moving_object_leaves_no_trail_beyond_two_pixels_after_one_frame() {
    let Some((_rows, gpu)) = gpu() else { return };
    let (before, after) = (square(16.0, 6.0), square(40.0, 6.0));
    let k = u64::from(CYCLE.frames());
    let mut frames: Vec<TaaFrameImage> = (0..k)
        .map(|i| {
            let jitter = offset_px(i, CYCLE);
            let (scene, mut depth) = sample(&with_object(&before), jitter);
            object_depth(&mut depth, &before);
            TaaFrameImage { scene, depth, motion: Vec::new(), reactive: Vec::new(), row: row(i, i == 0, jitter, if i == 0 { jitter } else { offset_px(i - 1, CYCLE) }) }
        })
        .collect();
    // The object jumps 24 px right; its pixels carry that motion, the background none.
    let jitter = offset_px(k, CYCLE);
    let (scene, mut depth) = sample(&with_object(&after), jitter);
    object_depth(&mut depth, &after);
    let motion: Vec<[f32; 2]> = (0..SIZE.1)
        .flat_map(|y| (0..SIZE.0).map(move |x| (x, y)))
        .map(|(x, y)| if (y as f32) < 28.0 && after(x as f32 + 0.5, y as f32 + 0.5) { [2.0 * 24.0 / SIZE.0 as f32, 0.0] } else { [0.0, 0.0] })
        .collect();
    frames.push(TaaFrameImage { scene: scene.clone(), depth, motion, reactive: Vec::new(), row: row(k, false, jitter, offset_px(k - 1, CYCLE)) });
    let images = taa_resolve_images(&gpu, SIZE, &frames).expect("resolved");
    let out = &images.last().expect("frames").texels;
    evidence("ghost-after-one-frame", images.last().expect("frames"));
    // Where the object was and no longer is (beyond 2 px of where it is now), the background shows.
    let near_now = |x: f32, y: f32| (x - 40.0).abs() < 8.0 && (y - 14.0).abs() < 8.0;
    let trail: Vec<(u32, u32)> = (0..28)
        .flat_map(|y| (0..SIZE.0).map(move |x| (x, y)))
        .filter(|&(x, y)| !near_now(x as f32 + 0.5, y as f32 + 0.5) && rgb_error(&out[idx(x, y)], &shade(false)) > 0.02)
        .collect();
    assert!(trail.is_empty(), "{} trail pixels, first {:?}", trail.len(), trail.first());
    // The static stripes below keep their accumulated (anti-aliased) edges through the move.
    let settled = edge_mae(&out[idx(0, 30)..], &jittered_mean(&stripes, k + 1)[idx(0, 30)..]);
    assert!(settled < 4.0 / 255.0, "static edges stay settled: {settled}");
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_a_reactive_transparent_quad_over_a_static_background_leaves_no_smear() {
    let Some((_rows, gpu)) = gpu() else { return };
    // A tinted quad, blended over the stripes, moves 3 px a frame without motion vectors (as
    // transparents draw): only the reactive mask tells TAA to take the current sample.
    let quad = |i: u64, x: f32, y: f32| (x - (12.0 + 3.0 * i as f32)).abs() < 5.0 && (y - 24.0).abs() < 5.0;
    let tint = |c: [f32; 4]| [c[0] * 0.5 + 0.4, c[1] * 0.5, c[2] * 0.5 + 0.2, 1.0];
    let run = |reactive_on: bool| {
        let k = u64::from(CYCLE.frames()) + 1;
        let frames: Vec<TaaFrameImage> = (0..k)
            .map(|i| {
                let jitter = offset_px(i, CYCLE);
                let (mut scene, depth) = sample(&stripes, jitter);
                let mut reactive = vec![0.0; scene.len()];
                for y in 0..SIZE.1 {
                    for x in 0..SIZE.0 {
                        if quad(i, x as f32 + 0.5 + jitter[0], y as f32 + 0.5 + jitter[1]) {
                            scene[idx(x, y)] = tint(scene[idx(x, y)]);
                            reactive[idx(x, y)] = 1.0;
                        }
                    }
                }
                let reactive = if reactive_on { reactive } else { Vec::new() };
                TaaFrameImage { scene, depth, motion: Vec::new(), reactive, row: row(i, i == 0, jitter, if i == 0 { jitter } else { offset_px(i - 1, CYCLE) }) }
            })
            .collect();
        let last = frames.last().expect("frames").scene.clone();
        (taa_resolve_images(&gpu, SIZE, &frames).expect("resolved"), last)
    };
    let (with_mask, current) = run(true);
    let (without_mask, _) = run(false);
    let i = u64::from(CYCLE.frames());
    let inside: Vec<usize> = (0..SIZE.1).flat_map(|y| (0..SIZE.0).map(move |x| (x, y))).filter(|&(x, y)| quad(i, x as f32 + 0.5, y as f32 + 0.5) && quad(i, x as f32 - 0.5, y as f32 + 0.5) && quad(i, x as f32 + 1.5, y as f32 + 0.5)).map(|(x, y)| idx(x, y)).collect();
    let masked = &with_mask.last().expect("frames").texels;
    let unmasked = &without_mask.last().expect("frames").texels;
    evidence("reactive-quad-masked", with_mask.last().expect("frames"));
    evidence("reactive-quad-unmasked", without_mask.last().expect("frames"));
    // RQ5 review flipped (named in the log): a reactive pixel takes the current frame filtered
    // around its unjittered centre (it took the raw jittered texel, so a transparent silhouette
    // moved by the jitter every frame).
    let filtered = unjittered_filter(&current, offset_px(i, CYCLE));
    let worst = inside.iter().map(|&p| rgb_error(&masked[p], &filtered[p])).fold(0.0f32, f32::max);
    assert!(worst < 2e-3, "the reactive quad shows its current frame, unjittered: worst {worst}");
    let smear = inside.iter().map(|&p| rgb_error(&unmasked[p], &current[p])).sum::<f32>() / inside.len() as f32;
    assert!(smear > 0.01, "without the mask the moving quad would smear (mean {smear}): the mask is what holds it");
    // Away from the quad's path the background stays accumulated.
    let settled = edge_mae(&masked[idx(0, 34)..], &jittered_mean(&stripes, i + 1)[idx(0, 34)..]);
    assert!(settled < 4.0 / 255.0, "static edges stay settled: {settled}");
}

/// `image` filtered around each pixel's unjittered centre as the resolve filters a rejected pixel:
/// the 3x3 neighbourhood (clamped at the borders) weighed `exp(-k d²)` at `d` = offset − `jitter`.
fn unjittered_filter(image: &[[f32; 4]], jitter: [f32; 2]) -> Vec<[f32; 4]> {
    let (w, h) = (SIZE.0 as i32, SIZE.1 as i32);
    (0..h)
        .flat_map(|y| (0..w).map(move |x| (x, y)))
        .map(|(x, y)| {
            let (mut sum, mut total) = ([0.0f32; 3], 0.0f32);
            for (ox, oy) in (-1..=1).flat_map(|oy| (-1..=1).map(move |ox| (ox, oy))) {
                let at = image[((y + oy).clamp(0, h - 1) * w + (x + ox).clamp(0, w - 1)) as usize];
                let d = [ox as f32 - jitter[0], oy as f32 - jitter[1]];
                let weight = libm::expf(-FILTER_FALLOFF * (d[0] * d[0] + d[1] * d[1]));
                (0..3).for_each(|c| sum[c] += at[c] * weight);
                total += weight;
            }
            [sum[0] / total, sum[1] / total, sum[2] / total, 1.0]
        })
        .collect()
}

// RQ5 review flipped this row (named in the log): a rejected pixel took the raw jittered texel, so
// a disoccluded region aliased and wobbled by the jitter; it takes the current frame filtered
// around the unjittered centre now (the checker shows filtered, with no trace of the panel).
#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_a_disoccluded_pixel_takes_the_current_frame_even_inside_the_colour_box() {
    let Some((_rows, gpu)) = gpu() else { return };
    // A grey panel (in front) covers a checker; then it is gone. The checker's neighbourhood box
    // contains the panel's grey, so clipping alone would keep it: depth must reject it.
    let checker = |x: u32, y: u32| if (x + y).is_multiple_of(2) { [1.0, 1.0, 1.0, 1.0] } else { [0.0, 0.0, 0.0, 1.0] };
    let texels = (SIZE.0 * SIZE.1) as usize;
    let panel = TaaFrameImage { scene: vec![[0.5, 0.5, 0.5, 1.0]; texels], depth: vec![FG_DEPTH; texels], motion: Vec::new(), reactive: Vec::new(), row: row(0, true, [0.0; 2], [0.0; 2]) };
    let mut frames = vec![panel.clone(), TaaFrameImage { row: row(1, false, [0.0; 2], [0.0; 2]), ..panel }];
    let behind: Vec<[f32; 4]> = (0..SIZE.1).flat_map(|y| (0..SIZE.0).map(move |x| checker(x, y))).collect();
    let jitter = [0.25, -0.125];
    frames.push(TaaFrameImage { scene: behind.clone(), depth: vec![BG_DEPTH * 0.25; texels], motion: Vec::new(), reactive: Vec::new(), row: row(2, false, jitter, [0.0; 2]) });
    let images = taa_resolve_images(&gpu, SIZE, &frames).expect("resolved");
    let out = &images.last().expect("frames").texels;
    let filtered = unjittered_filter(&behind, jitter);
    let worst = (0..texels).map(|p| rgb_error(&out[p], &filtered[p])).fold(0.0f32, f32::max);
    assert!(worst < 2e-3, "the revealed checker shows at once, filtered around its unjittered centre: worst {worst}");
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_an_exposure_change_rescales_history_instead_of_lagging_or_resetting() {
    let Some((_rows, gpu)) = gpu() else { return };
    let texels = (SIZE.0 * SIZE.1) as usize;
    let flat = |v: f32| vec![[v, v * 0.8, v * 0.6, 1.0]; texels];
    let mut frames: Vec<TaaFrameImage> =
        (0..8).map(|i| TaaFrameImage { scene: flat(0.2), depth: vec![FG_DEPTH; texels], motion: Vec::new(), reactive: Vec::new(), row: row(i, i == 0, [0.0; 2], [0.0; 2]).with_flags(TaaFlags::NONE) }).collect();
    // Exposure doubles: the scene is written twice as bright, and history is rescaled by 2.
    // Clipping off: a flat field's colour box would hide a missing rescale.
    let mut doubled = row(8, false, [0.0; 2], [0.0; 2]).with_flags(TaaFlags::NONE);
    doubled.params[1] = 2.0;
    frames.push(TaaFrameImage { scene: flat(0.4), depth: vec![FG_DEPTH; texels], motion: Vec::new(), reactive: Vec::new(), row: doubled });
    let images = taa_resolve_images(&gpu, SIZE, &frames).expect("resolved");
    let out = &images.last().expect("frames").texels;
    let worst = out.iter().map(|t| rgb_error(t, &[0.4, 0.32, 0.24, 1.0])).fold(0.0f32, f32::max);
    assert!(worst < 1e-3, "no lag after the exposure step: worst {worst}");
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_a_static_camera_pan_reprojects_history_by_its_motion() {
    let Some((_rows, gpu)) = gpu() else { return };
    // The camera pans 2 px left a frame: the stripes move right by 2 px, motion everywhere.
    let k = u64::from(CYCLE.frames());
    let shift = 2.0;
    let motion = vec![[2.0 * shift / SIZE.0 as f32, 0.0]; (SIZE.0 * SIZE.1) as usize];
    let frames: Vec<TaaFrameImage> = (0..k * 2)
        .map(|i| {
            let jitter = offset_px(i, CYCLE);
            let moved = move |x: f32, y: f32| stripes(x - shift * i as f32, y);
            let (scene, depth) = sample(&moved, jitter);
            let motion = if i == 0 { Vec::new() } else { motion.clone() };
            TaaFrameImage { scene, depth, motion, reactive: Vec::new(), row: row(i, i == 0, jitter, if i == 0 { jitter } else { offset_px(i - 1, CYCLE) }) }
        })
        .collect();
    let images = taa_resolve_images(&gpu, SIZE, &frames).expect("resolved");
    let last = k * 2 - 1;
    let moved = move |x: f32, y: f32| stripes(x - shift * last as f32, y);
    let reference = supersampled(&moved, 16);
    let out = &images.last().expect("frames").texels;
    evidence("pan-settled", images.last().expect("frames"));
    // Away from the left edge, where history scrolls in from off-screen.
    let interior = |p: usize| (p as u32 % SIZE.0) >= 4;
    let keep = |image: &[[f32; 4]]| -> Vec<[f32; 4]> { image.iter().enumerate().map(|(p, t)| if interior(p) { *t } else { reference[p] }).collect() };
    let settled = edge_mae(&keep(out), &reference);
    let aliased = edge_mae(&keep(&frames.last().expect("frames").scene), &reference);
    eprintln!("pan edge MAE: settled {settled:.5}, aliased {aliased:.5}");
    assert!(settled * 2.0 < aliased, "reprojected history still anti-aliases a panning view: {settled} vs {aliased}");
}

// ---------------------------------------------------------------------------------------------
// A moving camera over a ground plane (RQ5 review): the disocclusion test compared the history's
// depth key with this frame's, so a camera dollying or turning threw the history of every static
// surface near it away (a 6 m/s dolly rejected the ground within about 2 m, a 4°/frame pan the
// screen's sides). The camera's reprojection predicts last frame's key instead.

/// The ground camera's eye height and pitch below the horizon (a third-person camera), and the
/// vertical fields of view of a normal and a wide lens.
const GROUND_EYE_HEIGHT: f32 = 1.2;
const GROUND_PITCH_DEGREES: f32 = 25.0;
const GROUND_FOV_DEGREES: f32 = 60.0;
const WIDE_FOV_DEGREES: f32 = 90.0;
/// The ground rows' render size: a 1080p frame's angular row pitch at a quarter of its side would
/// widen the 3x3 depth range past what a camera's motion changes, so the rows draw larger.
const GROUND: (u32, u32) = (640, 360);
/// The most of the ground a moving camera may reject (where last frame saw it on screen).
const MOVING_REJECTED_MAX: f32 = 0.03;

/// A reverse-Z camera at `eye` looking `yaw` degrees left of -z, pitched down, with a vertical
/// field of view of `fov` degrees: its view_proj.
fn ground_camera(eye: glam::Vec3, yaw_degrees: f32, fov: f32) -> glam::Mat4 {
    let (yaw, pitch) = (yaw_degrees.to_radians(), -GROUND_PITCH_DEGREES.to_radians());
    let forward = glam::Vec3::new(-libm::sinf(yaw) * libm::cosf(pitch), libm::sinf(pitch), -libm::cosf(yaw) * libm::cosf(pitch));
    let view = glam::camera::rh::view::look_to_mat4(eye, forward, glam::Vec3::Y);
    let aspect = GROUND.0 as f32 / GROUND.1 as f32;
    glam::camera::rh::proj::directx::perspective_infinite_reverse(fov.to_radians(), aspect, 0.1) * view
}

/// The point of the ground plane y = 0 seen at pixel centre (x, y) of `view_proj`, if any.
fn ground_hit(view_proj: glam::Mat4, x: f32, y: f32) -> Option<glam::Vec3> {
    let inverse = view_proj.inverse();
    let ndc = glam::Vec2::new(x / GROUND.0 as f32 * 2.0 - 1.0, 1.0 - y / GROUND.1 as f32 * 2.0);
    let near = inverse.project_point3(glam::Vec3::new(ndc.x, ndc.y, 1.0));
    let farther = inverse.project_point3(glam::Vec3::new(ndc.x, ndc.y, 0.01));
    let direction = (farther - near).normalize();
    (direction.y < -1e-4).then(|| near + direction * (-near.y / direction.y))
}

/// One frame of the ground seen by `view_proj` in a flat `colour` (sky depth 0, no motion); with
/// `prev`, each ground pixel's motion from where last frame saw it. Answers the frame and, per
/// pixel, whether last frame saw its ground point on screen.
fn ground_frame(view_proj: glam::Mat4, prev: Option<glam::Mat4>, colour: [f32; 4], row: GpuTaaParams) -> (TaaFrameImage, Vec<bool>) {
    let texels = (GROUND.0 * GROUND.1) as usize;
    let (mut depth, mut motion, mut tracked) = (vec![0.0; texels], vec![[0.0f32; 2]; texels], vec![false; texels]);
    for (y, x) in (0..GROUND.1).flat_map(|y| (0..GROUND.0).map(move |x| (y, x))) {
        let Some(point) = ground_hit(view_proj, x as f32 + 0.5, y as f32 + 0.5) else { continue };
        let now = view_proj.project_point3(point);
        let at = (y * GROUND.0 + x) as usize;
        depth[at] = now.z;
        let Some(prev) = prev else { continue };
        let then = prev.project_point3(point);
        motion[at] = [now.x - then.x, now.y - then.y];
        tracked[at] = then.x.abs() < 1.0 && then.y.abs() < 1.0 && then.z > 0.0;
    }
    let motion = if prev.is_some() { motion } else { Vec::new() };
    (TaaFrameImage { scene: vec![colour; texels], depth, motion, reactive: Vec::new(), row }, tracked)
}

/// The share of the ground last frame saw on screen that the resolve rejects when the camera moves
/// from `from` to `to` (history red, the current frame green, clipping off: an accepted pixel
/// blends both, a rejected one is all green), with the camera's reprojection or without it.
fn rejected_share(gpu: &Gpu, from: glam::Mat4, to: glam::Mat4, reprojected: bool) -> f32 {
    let (first, _) = ground_frame(from, None, [1.0, 0.0, 0.0, 1.0], row(0, true, [0.0; 2], [0.0; 2]).with_flags(TaaFlags::NONE));
    let reproject = if reprojected { reprojection(&from.to_cols_array(), &to.to_cols_array()) } else { IDENTITY };
    let second_row = row(1, false, [0.0; 2], [0.0; 2]).with_flags(TaaFlags::NONE).with_reproject(reproject);
    let (second, tracked) = ground_frame(to, Some(from), [0.0, 1.0, 0.0, 1.0], second_row);
    let images = taa_resolve_images(gpu, GROUND, &[first, second]).expect("resolved");
    let out = &images.last().expect("frames").texels;
    let ground: Vec<usize> = (0..tracked.len()).filter(|&p| tracked[p]).collect();
    assert!(ground.len() > 20_000, "the ground fills the lower screen: {}", ground.len());
    ground.iter().filter(|&&p| out[p][0] < 0.05).count() as f32 / ground.len() as f32
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_a_dollying_camera_keeps_the_history_of_the_ground_it_moves_over() {
    let Some((_rows, gpu)) = gpu() else { return };
    // 6 m/s (a sprint) and 20 m/s (a vehicle) at 60 fps.
    for step in [0.1f32, 0.333] {
        let from = ground_camera(glam::Vec3::new(0.0, GROUND_EYE_HEIGHT, 0.0), 0.0, GROUND_FOV_DEGREES);
        let to = ground_camera(glam::Vec3::new(0.0, GROUND_EYE_HEIGHT, -step), 0.0, GROUND_FOV_DEGREES);
        let unprojected = rejected_share(&gpu, from, to, false);
        let reprojected = rejected_share(&gpu, from, to, true);
        eprintln!("dolly {step} m/frame: rejected {unprojected:.3} by current keys, {reprojected:.3} with the reprojection");
        assert!(unprojected > 0.1, "the scene exercises the bug: {unprojected}");
        assert!(reprojected < MOVING_REJECTED_MAX, "{step} m/frame: {reprojected} of the ground rejected");
    }
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_a_turning_camera_keeps_the_history_of_the_ground_at_the_screen_sides() {
    let Some((_rows, gpu)) = gpu() else { return };
    let eye = glam::Vec3::new(0.0, GROUND_EYE_HEIGHT, 0.0);
    let (from, to) = (ground_camera(eye, 0.0, WIDE_FOV_DEGREES), ground_camera(eye, 4.0, WIDE_FOV_DEGREES));
    let unprojected = rejected_share(&gpu, from, to, false);
    let reprojected = rejected_share(&gpu, from, to, true);
    eprintln!("pan 4 deg/frame: rejected {unprojected:.3} by current keys, {reprojected:.3} with the reprojection");
    assert!(unprojected > 0.03, "the scene exercises the bug: {unprojected}");
    assert!(reprojected < MOVING_REJECTED_MAX, "{reprojected} of the ground rejected");
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_two_runs_of_one_sequence_give_identical_bytes() {
    let Some((_rows, gpu)) = gpu() else { return };
    let frames = static_cycle(&stripes, TaaFlags::CLIP);
    let first = taa_resolve_images(&gpu, SIZE, &frames).expect("resolved");
    let second = taa_resolve_images(&gpu, SIZE, &frames).expect("resolved");
    assert_eq!(first, second);
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_taa_at_1080p_holds_its_budget() {
    let Some((_rows, gpu)) = gpu() else { return };
    let render = (1920, 1080);
    let Some(mut costs) = taa_gpu_ms(&gpu, render, COST_FRAMES).expect("timed") else {
        eprintln!("skipped: the device has no TIMESTAMP_QUERY");
        return;
    };
    assert!(costs.len() as u32 >= COST_FRAMES / 2, "{} of {COST_FRAMES} frames timed", costs.len());
    costs.sort_by(f32::total_cmp);
    let p = |q: f32| costs[((costs.len() - 1) as f32 * q).round() as usize];
    let (p50, p95) = (p(0.5), p(0.95));
    if let Ok(path) = std::env::var("GENEX_PERF_OUT") {
        let row = format!(
            "{{\"row\":\"taa\",\"render\":[{},{}],\"samples\":{},\"resolves_per_sample\":{COST_RESOLVES_PER_SAMPLE},\"gpu_ms_p50\":{p50},\"gpu_ms_p95\":{p95},\"budget_ms\":{TAA_BUDGET_MS},\"backend\":\"{}\",\"adapter\":\"{}\"}}\n",
            render.0,
            render.1,
            costs.len(),
            gpu.receipt().backend,
            gpu.receipt().adapter
        );
        std::fs::write(path, row).expect("perf row");
    }
    eprintln!("taa 1080p: p50 {p50:.3} ms, p95 {p95:.3} ms (mean of {COST_RESOLVES_PER_SAMPLE} resolves a sample)");
    assert!(p50 <= TAA_BUDGET_MS, "taa p50 {p50} ms over the {TAA_BUDGET_MS} ms budget");
}

// ---------------------------------------------------------------------------------------------
// The reactive coverage (node 15a)

fn layout_entry(binding: u32, ty: wgpu::BindingType) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry { binding, visibility: wgpu::ShaderStages::VERTEX_FRAGMENT, ty, count: None }
}

fn storage() -> wgpu::BindingType {
    wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only: true }, has_dynamic_offset: false, min_binding_size: None }
}

fn uniform() -> wgpu::BindingType {
    wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None }
}

/// The mask a 32x32 frame gets from one particle (identity camera, NDC centre, size 1, alpha
/// 0.8) drawn by the particle coverage pipeline over a depth cleared to `scene_depth`
/// (reverse-Z), read back as bytes.
fn particle_mask(gpu: &Gpu, scene_depth: f32) -> Vec<u8> {
    use genex_render::post::taa::{GpuReactiveJitter, REACTIVE_FORMAT, ReactiveEntry, ReactiveNode};
    let device = &gpu.device;
    let size = 32u32;
    let frame_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("frame"), entries: &[layout_entry(0, uniform())] });
    let particle_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("particles"), entries: &[layout_entry(0, storage())] });
    let node = ReactiveNode::new(device).expect("reactive node");
    let pipeline = node.pipeline(device, ReactiveEntry::Particles, [&frame_layout, &particle_layout], &[], true).expect("particle coverage pipeline");
    let mut frame = vec![0u8; size_of::<genex_render::layout::GpuFrame>()];
    let identity: [f32; 16] = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];
    frame[..64].copy_from_slice(bytemuck::cast_slice(&identity));
    frame[80..96].copy_from_slice(bytemuck::cast_slice(&[0.0f32, 0.0, -1.0, 0.0]));
    let frame_buffer = wgpu::util::DeviceExt::create_buffer_init(device, &wgpu::util::BufferInitDescriptor { label: Some("frame"), contents: &frame, usage: wgpu::BufferUsages::UNIFORM });
    let particle: [f32; 8] = [0.0, 0.0, 0.5, 1.0, 1.0, 1.0, 1.0, 0.8];
    let particles = wgpu::util::DeviceExt::create_buffer_init(device, &wgpu::util::BufferInitDescriptor { label: Some("particle"), contents: bytemuck::cast_slice(&particle), usage: wgpu::BufferUsages::STORAGE });
    let frame_group = device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &frame_layout, entries: &[wgpu::BindGroupEntry { binding: 0, resource: frame_buffer.as_entire_binding() }] });
    let particle_group = device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &particle_layout, entries: &[wgpu::BindGroupEntry { binding: 0, resource: particles.as_entire_binding() }] });
    node.write(&gpu.queue, GpuReactiveJitter::new([0.0, 0.0], (size, size)));
    let target = |format, usage| {
        device.create_texture(&wgpu::TextureDescriptor {
            label: None,
            size: wgpu::Extent3d { width: size, height: size, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format,
            usage,
            view_formats: &[],
        })
    };
    let mask = target(REACTIVE_FORMAT, wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC);
    let depth = target(wgpu::TextureFormat::Depth32Float, wgpu::TextureUsages::RENDER_ATTACHMENT);
    let (mask_view, depth_view) = (mask.create_view(&Default::default()), depth.create_view(&Default::default()));
    let staging = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: 256 * u64::from(size), usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
    let mut encoder = device.create_command_encoder(&Default::default());
    {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("reactive"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &mask_view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store },
            })],
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: &depth_view,
                depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(scene_depth), store: wgpu::StoreOp::Discard }),
                stencil_ops: None,
            }),
            ..Default::default()
        });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &frame_group, &[]);
        pass.set_bind_group(1, &particle_group, &[]);
        pass.set_bind_group(2, node.jitter_group(), &[]);
        pass.draw(0..6, 0..1);
    }
    encoder.copy_texture_to_buffer(
        mask.as_image_copy(),
        wgpu::TexelCopyBufferInfo { buffer: &staging, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(256), rows_per_image: Some(size) } },
        wgpu::Extent3d { width: size, height: size, depth_or_array_layers: 1 },
    );
    gpu.queue.submit([encoder.finish()]);
    staging.slice(..).map_async(wgpu::MapMode::Read, |result| result.expect("mapped"));
    device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
    let data = staging.slice(..).get_mapped_range().expect("mapped range").to_vec();
    (0..size).flat_map(|y| (0..size).map(move |x| (x, y))).map(|(x, y)| data[(y * 256 + x) as usize]).collect()
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_a_particle_marks_its_soft_dot_in_the_reactive_mask_unless_hidden() {
    let Some((_rows, gpu)) = gpu() else { return };
    let mask = particle_mask(&gpu, 0.0);
    let at = |x: usize, y: usize| mask[y * 32 + x];
    assert!((200..=206).contains(&at(16, 16)), "the dot's centre carries the particle's alpha 0.8: {}", at(16, 16));
    assert_eq!((at(2, 2), at(30, 16), at(16, 30)), (0, 0, 0), "outside the billboard nothing is reactive");
    assert_eq!(at(9, 9), 0, "the billboard's corner fades out (a round dot)");
    let hidden = particle_mask(&gpu, 1.0);
    assert!(hidden.iter().all(|&v| v == 0), "a particle behind the scene's depth marks nothing");
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_the_mesh_coverage_pipeline_builds_against_the_world_pass_bindings() {
    use genex_render::post::taa::{ReactiveEntry, ReactiveNode};
    let Some((_rows, gpu)) = gpu() else { return };
    let device = &gpu.device;
    let frame_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("frame"),
        entries: &[layout_entry(0, uniform()), layout_entry(1, storage()), layout_entry(3, storage()), layout_entry(4, storage())],
    });
    let pass_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("pass view"), entries: &[layout_entry(0, uniform())] });
    let node = ReactiveNode::new(device).expect("reactive node");
    let position = [wgpu::VertexAttribute { format: wgpu::VertexFormat::Float32x3, offset: 0, shader_location: 0 }];
    let slot = [wgpu::VertexAttribute { format: wgpu::VertexFormat::Uint32, offset: 0, shader_location: 4 }];
    let buffers = [
        Some(wgpu::VertexBufferLayout { array_stride: 12, step_mode: wgpu::VertexStepMode::Vertex, attributes: &position }),
        Some(wgpu::VertexBufferLayout { array_stride: 4, step_mode: wgpu::VertexStepMode::Instance, attributes: &slot }),
    ];
    let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    for reversed in [true, false] {
        node.pipeline(device, ReactiveEntry::Mesh, [&frame_layout, &pass_layout], &buffers, reversed).expect("mesh coverage pipeline");
    }
    let error = pollster::block_on(scope.pop());
    assert!(error.is_none(), "{error:?}");
}

// ---------------------------------------------------------------------------------------------
// The settled golden

/// The settled static scene's golden (`taa/static-settled.bgra`, raw sRGB BGRA of the 64x48
/// resolve, top row first); `GENEX_RENDER_GOLDEN_UPDATE=1` rewrites it instead.
fn golden_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/render-goldens/taa/static-settled.bgra")
}

/// A golden pixel may differ by this much per channel (another Apple GPU family rounds differently).
const GOLDEN_CHANNEL_TOLERANCE: u8 = 2;
/// Pixels allowed beyond the channel tolerance, of 3072 (0.5%).
const GOLDEN_OUTLIER_PIXELS: usize = 15;

fn srgb_byte(v: f32) -> u8 {
    let v = v.clamp(0.0, 1.0);
    let s = if v <= 0.003_130_8 { v * 12.92 } else { 1.055 * libm::powf(v, 1.0 / 2.4) - 0.055 };
    (s * 255.0).round() as u8
}

fn bgra(image: &TaaImage) -> Vec<u8> {
    image.texels.iter().flat_map(|t| [srgb_byte(t[2]), srgb_byte(t[1]), srgb_byte(t[0]), 255]).collect()
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_the_settled_static_scene_matches_its_golden() {
    let Some((_rows, gpu)) = gpu() else { return };
    let frames = static_cycle(&stripes, TaaFlags::CLIP);
    let images = taa_resolve_images(&gpu, SIZE, &frames).expect("resolved");
    let settled = bgra(images.last().expect("a cycle"));
    let path = golden_path();
    if std::env::var("GENEX_RENDER_GOLDEN_UPDATE").is_ok_and(|v| v == "1") {
        std::fs::create_dir_all(path.parent().expect("golden folder")).expect("goldens folder");
        std::fs::write(&path, &settled).expect("golden written");
        return;
    }
    let golden = std::fs::read(&path).unwrap_or_else(|error| panic!("golden {path:?} missing ({error}); render it with GENEX_RENDER_GOLDEN_UPDATE=1"));
    assert_eq!(golden.len(), settled.len());
    let (mut outliers, mut worst) = (0usize, 0u8);
    for (a, b) in golden.chunks(4).zip(settled.chunks(4)) {
        let diff = a.iter().zip(b).map(|(p, q)| p.abs_diff(*q)).max().unwrap_or(0);
        worst = worst.max(diff);
        outliers += usize::from(diff > GOLDEN_CHANNEL_TOLERANCE);
    }
    assert!(outliers <= GOLDEN_OUTLIER_PIXELS, "taa/static-settled: {outliers} pixels differ by more than {GOLDEN_CHANNEL_TOLERANCE} (worst {worst})");
}

// ---------------------------------------------------------------------------------------------
// The texture LOD bias (shaders/lighting/surface.wgsl)

/// The output side at render scale 1 and the side the same view renders at scale 2/3.
const LOD_FULL: u32 = 96;
const LOD_SCALED: u32 = 64;
/// The mip-coded texture's side (mips 0..=8) and how many times the view repeats it.
const LOD_TEXTURE: u32 = 256;
const LOD_REPEATS: f32 = 3.0;
/// Mip `k` stores `k * LOD_CODE` in red, so the sampled red decodes the (trilinear) LOD.
const LOD_CODE: u8 = 24;
/// How far two LODs may differ and still sample the same detail.
const LOD_TOLERANCE: f32 = 0.15;

/// The material inputs `gx_surface` reads (the forward pass's names) and a full-screen fragment
/// returning the surface's albedo: the material's base texture through `surface.wgsl` as the
/// forward pass samples it. `gx_class_texel` stands in for the forward pass's class lookup with
/// the class-0 arrays.
const LOD_PRELUDE: &str = "
override GX_SCENE_HDR: bool = false;
@group(0) @binding(0) var<storage, read> materials: array<Material>;
@group(0) @binding(1) var color_textures: texture_2d_array<f32>;
@group(0) @binding(2) var data_textures: texture_2d_array<f32>;
@group(0) @binding(3) var texture_sampler: sampler;

fn gx_class_texel(color: bool, reference: u32, uv: vec2<f32>, uv_dx: vec2<f32>, uv_dy: vec2<f32>) -> vec4<f32> {
    if reference == NO_TEXTURE {
        return vec4<f32>(0.0);
    }
    if color {
        return textureSampleGrad(color_textures, texture_sampler, uv, i32(reference & GX_TEXTURE_LAYER_MASK), uv_dx, uv_dy);
    }
    return textureSampleGrad(data_textures, texture_sampler, uv, i32(reference & GX_TEXTURE_LAYER_MASK), uv_dx, uv_dy);
}
";

const LOD_ENTRY: &str = "
struct LodParams {
    // x: the view's side in pixels; y: how many times it repeats the texture.
    view: vec4<f32>,
}
@group(0) @binding(4) var<uniform> lod_params: LodParams;

@vertex
fn vs_lod(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    return vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
}

@fragment
fn fs_lod(@builtin(position) clip: vec4<f32>) -> @location(0) vec4<f32> {
    let uv = clip.xy / lod_params.view.x * lod_params.view.y;
    let s = gx_surface(vec3<f32>(0.0), vec3<f32>(0.0, 0.0, 1.0), uv, vec4<f32>(1.0, 0.0, 0.0, 1.0), 0u);
    return vec4<f32>(s.albedo, 1.0);
}
";

fn surface_chunk() -> &'static str {
    genex_render::shaders::LIGHTING_CHUNKS.iter().find(|(name, _)| *name == "surface").expect("the surface chunk").1
}

/// A one-layer `rgba8unorm` array of `LOD_TEXTURE` with every mip flat at its code.
fn mip_coded_array(gpu: &Gpu) -> wgpu::TextureView {
    let mips = LOD_TEXTURE.ilog2() + 1;
    let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("lod mips"),
        size: wgpu::Extent3d { width: LOD_TEXTURE, height: LOD_TEXTURE, depth_or_array_layers: 1 },
        mip_level_count: mips,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    for mip in 0..mips {
        let side = LOD_TEXTURE >> mip;
        let code = u8::try_from(mip).expect("few mips") * LOD_CODE;
        let bytes: Vec<u8> = (0..side * side).flat_map(|_| [code, 0, 0, 255]).collect();
        gpu.queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: &texture, mip_level: mip, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            &bytes,
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(side * 4), rows_per_image: Some(side) },
            wgpu::Extent3d { width: side, height: side, depth_or_array_layers: 1 },
        );
    }
    texture.create_view(&wgpu::TextureViewDescriptor { dimension: Some(wgpu::TextureViewDimension::D2Array), ..Default::default() })
}

/// The mean LOD the surface samples its base texture at when a `side` view repeats it
/// `LOD_REPEATS` times, with the pipeline's `GX_TEXTURE_LOD_BIAS` = `bias` and
/// `GX_TEXTURE_CLASSES` = `classes`.
fn sampled_lod(gpu: &Gpu, side: u32, bias: f32, classes: bool) -> f32 {
    let device = &gpu.device;
    let source = format!("{}{LOD_PRELUDE}{}{LOD_ENTRY}", include_str!("../shaders/common.wgsl"), surface_chunk());
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("lod"), source: wgpu::ShaderSource::Wgsl(source.into()) });
    let fragment = |binding, ty| wgpu::BindGroupLayoutEntry { binding, visibility: wgpu::ShaderStages::FRAGMENT, ty, count: None };
    let array = wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2Array, multisampled: false };
    let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("lod"),
        entries: &[
            fragment(0, storage()),
            fragment(1, array),
            fragment(2, array),
            fragment(3, wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering)),
            fragment(4, uniform()),
        ],
    });
    let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: Some("lod"), bind_group_layouts: &[Some(&layout)], immediate_size: 0 });
    let constants = [("GX_TEXTURE_LOD_BIAS", f64::from(bias)), ("GX_TEXTURE_CLASSES", f64::from(u8::from(classes)))];
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("lod"),
        layout: Some(&pipeline_layout),
        vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_lod"), compilation_options: Default::default(), buffers: &[] },
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        fragment: Some(wgpu::FragmentState {
            module: &module,
            entry_point: Some("fs_lod"),
            compilation_options: wgpu::PipelineCompilationOptions { constants: &constants, ..Default::default() },
            targets: &[Some(wgpu::ColorTargetState { format: wgpu::TextureFormat::Rgba8Unorm, blend: None, write_mask: wgpu::ColorWrites::ALL })],
        }),
        multiview_mask: None,
        cache: None,
    });
    let no_texture = genex_render::layout::NO_TEXTURE;
    let material = genex_render::layout::GpuMaterial { base_color: [1.0; 4], params: [0.0, 1.0, 0.0, 1.0], textures: [0, no_texture, no_texture, no_texture] };
    let init = |label, contents: &[u8], usage| wgpu::util::DeviceExt::create_buffer_init(device, &wgpu::util::BufferInitDescriptor { label: Some(label), contents, usage });
    let materials = init("lod material", bytemuck::bytes_of(&material), wgpu::BufferUsages::STORAGE);
    let params = init("lod params", bytemuck::cast_slice(&[side as f32, LOD_REPEATS, 0.0, 0.0]), wgpu::BufferUsages::UNIFORM);
    let mips = mip_coded_array(gpu);
    let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
        label: Some("lod"),
        address_mode_u: wgpu::AddressMode::Repeat,
        address_mode_v: wgpu::AddressMode::Repeat,
        mag_filter: wgpu::FilterMode::Linear,
        min_filter: wgpu::FilterMode::Linear,
        mipmap_filter: wgpu::MipmapFilterMode::Linear,
        ..Default::default()
    });
    let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("lod"),
        layout: &layout,
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: materials.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&mips) },
            wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&mips) },
            wgpu::BindGroupEntry { binding: 3, resource: wgpu::BindingResource::Sampler(&sampler) },
            wgpu::BindGroupEntry { binding: 4, resource: params.as_entire_binding() },
        ],
    });
    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("lod target"),
        size: wgpu::Extent3d { width: side, height: side, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = target.create_view(&Default::default());
    let row_bytes = (side * 4).div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let staging = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: u64::from(row_bytes * side), usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
    let mut encoder = device.create_command_encoder(&Default::default());
    {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("lod"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
            })],
            ..Default::default()
        });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.draw(0..3, 0..1);
    }
    encoder.copy_texture_to_buffer(
        target.as_image_copy(),
        wgpu::TexelCopyBufferInfo { buffer: &staging, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row_bytes), rows_per_image: Some(side) } },
        wgpu::Extent3d { width: side, height: side, depth_or_array_layers: 1 },
    );
    gpu.queue.submit([encoder.finish()]);
    staging.slice(..).map_async(wgpu::MapMode::Read, |result| result.expect("mapped"));
    device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
    let data = staging.slice(..).get_mapped_range().expect("mapped range").to_vec();
    let reds: Vec<f32> = (0..side).flat_map(|y| (0..side).map(move |x| (x, y))).map(|(x, y)| f32::from(data[(y * row_bytes + x * 4) as usize])).collect();
    reds.iter().sum::<f32>() / reds.len() as f32 / f32::from(LOD_CODE)
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_texture_detail_at_scale_two_thirds_under_taa_matches_scale_one() {
    let Some((_rows, gpu)) = gpu() else { return };
    let taa = TaaQuality::DEFAULT;
    let scale = LOD_SCALED as f32 / LOD_FULL as f32;
    for classes in [false, true] {
        let full = sampled_lod(&gpu, LOD_FULL, taa.texture_lod_bias(1.0), classes);
        let scaled = sampled_lod(&gpu, LOD_SCALED, taa.texture_lod_bias(scale), classes);
        let unbiased = sampled_lod(&gpu, LOD_SCALED, 0.0, classes);
        let natural = libm::log2f(LOD_TEXTURE as f32 * LOD_REPEATS / LOD_SCALED as f32);
        eprintln!("classes {classes}: LOD at scale 1 {full:.3}, at 2/3 with the TAA bias {scaled:.3}, at 2/3 unbiased {unbiased:.3} (natural {natural:.3})");
        assert!((unbiased - natural).abs() < LOD_TOLERANCE, "the probe reads the hardware's LOD: {unbiased} vs {natural}");
        assert!((scaled - full).abs() < LOD_TOLERANCE, "classes {classes}: scale 2/3 under TAA samples the detail scale 1 does: {scaled} vs {full}");
        assert!(unbiased - full > 0.5, "classes {classes}: without the bias scale 2/3 would sample a blurrier mip: {unbiased} vs {full}");
    }
}
