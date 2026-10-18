//! Renderer pass 2, B.8 (T-05): TAA upscaling at output size. The jitter cycle and the texture
//! LOD bias follow the upscale ratio (FSR2's `ceil(8 · (display / render)²)` phases and
//! `log2(render / display) − 1`), and the resolve accumulates the render-size samples into an
//! output-size history through a Lanczos-weighted reconstruction, so a frame drawn at 0.67 of the
//! output keeps the output's detail instead of the render size's.
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test taau -- --ignored metal
//!
//! `GENEX_RENDER_EVIDENCE_DIR` receives the sharpness row's images as raw RGBA8 (`<name>-WxH.rgba`);
//! `GENEX_PERF_OUT` receives the cost row as JSON.

use genex_render::Gpu;
use genex_render::post::taa::{GpuTaaParams, TaaFrameImage, TaaImage, taa_resolve_images};
use genex_render::post::taau::{COST_RESOLVES_PER_SAMPLE, GpuTaauParams, TaauFrameImage, jitter_phases, offset_px, taau_gpu_ms, taau_resolve_images, texture_lod_bias, upscales};
use genex_render::settings::{JitterCycle, RenderSettings, TaaQuality};

/// The output size of the image rows and the render size two thirds of it (DRS 0.67).
const OUTPUT: (u32, u32) = (192, 108);
const RENDER: (u32, u32) = (128, 72);
/// The foreground and background radiance (pre-exposed, display range).
const FG: [f32; 3] = [0.9, 0.7, 0.3];
const BG: [f32; 3] = [0.08, 0.12, 0.2];
/// Device depth (reverse-Z) of the scene: one plane.
const DEPTH: f32 = 0.5;
/// The acceptance: the upscaled frame's sharpness within 10% of the native frame's (plan §5, B.8).
const SHARPNESS_TOLERANCE: f32 = 0.10;
/// The cost budget at 4K output (plan §5, B.8: <= 0.6 ms at 4K).
const TAAU_BUDGET_MS_4K: f32 = 0.6;
/// 4K output and its render size at DRS 0.67.
const OUTPUT_4K: (u32, u32) = (3840, 2160);
const RENDER_4K: (u32, u32) = (2573, 1447);
/// The still shimmer this row holds the upscale to once settled, on near-Nyquist binary detail
/// (every pixel an edge): 0.33% measured. Plan §7's AAA rubric asks at most 0.10% and native TAA
/// shows 0.0001% here: the gap is open (wp-B.8.md), so this bound guards against a regression only.
const STILL_FLICKER_MAX: f32 = 0.004;
/// The pan row's speed, output pixels a frame.
const PAN_SPEED: f32 = 0.37;
/// Frames the cost row times.
const COST_FRAMES: u32 = 30;

// ---------------------------------------------------------------------------------------------
// Scene: fine detail in output pixels

/// Slanted stripes with a period of 3.2 output pixels (2.1 render pixels at 0.67, just above the
/// render size's Nyquist limit), a coarser checker and a ring: detail only an upscale that keeps
/// the jittered samples at output size recovers. `x`, `y` in output pixels.
fn detail(x: f32, y: f32) -> bool {
    let along = x * libm::cosf(0.4) + y * libm::sinf(0.4);
    let stripes = (along / 3.2).rem_euclid(1.0) < 0.5;
    let checker = ((x / 9.0).floor() + (y / 9.0).floor()) as i32 % 2 == 0;
    let (dx, dy) = (x - OUTPUT.0 as f32 * 0.5, y - OUTPUT.1 as f32 * 0.5);
    let ring = (libm::sqrtf(dx * dx + dy * dy) / 2.5).rem_euclid(1.0) < 0.5;
    if dx.abs() < 30.0 && dy.abs() < 30.0 { ring } else { stripes ^ checker }
}

fn shade(fg: bool) -> [f32; 4] {
    let c = if fg { FG } else { BG };
    [c[0], c[1], c[2], 1.0]
}

/// A frame of `detail` at `size`, each pixel showing the scene at its centre moved by `-jitter`
/// (pixels of `size`, y down: the renderer's clip-space jitter moves the geometry by +jitter),
/// scaled into output pixels, the scene moved left by `shift` output pixels.
fn panned(size: (u32, u32), jitter: [f32; 2], shift: f32) -> Vec<[f32; 4]> {
    let (sx, sy) = (OUTPUT.0 as f32 / size.0 as f32, OUTPUT.1 as f32 / size.1 as f32);
    (0..size.1).flat_map(|y| (0..size.0).map(move |x| (x, y))).map(|(x, y)| shade(detail((x as f32 + 0.5 - jitter[0]) * sx + shift, (y as f32 + 0.5 - jitter[1]) * sy))).collect()
}

fn reverse_z(mut row: GpuTaaParams) -> GpuTaaParams {
    row.counts[2] = 1;
    row
}

/// The native frame: TAA at output size, settled over its jitter cycle (high's eight).
fn native(gpu: &Gpu) -> TaaImage {
    native_panned(gpu, u64::from(JitterCycle::Eight.frames()), 0.0)
}

/// The motion (NDC, current − previous) of a scene moving left by `speed` output pixels a frame.
fn pan_motion(size: (u32, u32), speed: f32) -> Vec<[f32; 2]> {
    if speed == 0.0 {
        return Vec::new();
    }
    vec![[-2.0 * speed / OUTPUT.0 as f32, 0.0]; (size.0 * size.1) as usize]
}

/// The native frame after `count` frames of a pan at `speed` output pixels a frame.
fn native_panned(gpu: &Gpu, count: u64, speed: f32) -> TaaImage {
    native_sequence(gpu, count, speed).pop().expect("frames")
}

/// Every native frame of `count` frames of a pan at `speed` output pixels a frame.
fn native_sequence(gpu: &Gpu, count: u64, speed: f32) -> Vec<TaaImage> {
    let cycle = JitterCycle::Eight;
    let frames: Vec<TaaFrameImage> = (0..count)
        .map(|i| {
            let jitter = genex_render::jitter::offset_px(i, cycle);
            let prev = if i == 0 { jitter } else { genex_render::jitter::offset_px(i - 1, cycle) };
            let mut config = RenderSettings::off().frame_config(OUTPUT, 1.0, i, i == 0);
            config.jitter = jitter;
            let row = reverse_z(GpuTaaParams::new(&TaaQuality::DEFAULT, &config, prev, 1.0));
            TaaFrameImage {
                scene: panned(OUTPUT, jitter, speed * i as f32),
                depth: vec![DEPTH; (OUTPUT.0 * OUTPUT.1) as usize],
                motion: pan_motion(OUTPUT, speed),
                reactive: Vec::new(),
                row,
            }
        })
        .collect();
    taa_resolve_images(gpu, OUTPUT, &frames).expect("resolved")
}

/// The upscaled sequence from 0.67: `count` frames of the TAAU jitter, a still camera.
fn upscaled_frames(count: u64) -> Vec<TaauFrameImage> {
    upscaled_panned(count, 0.0)
}

/// The upscaled sequence from 0.67 of a pan at `speed` output pixels a frame.
fn upscaled_panned(count: u64, speed: f32) -> Vec<TaauFrameImage> {
    let phases = jitter_phases(RENDER, OUTPUT);
    (0..count)
        .map(|i| {
            let jitter = offset_px(i, phases);
            let prev = if i == 0 { jitter } else { offset_px(i - 1, phases) };
            let mut config = RenderSettings::off().frame_config(OUTPUT, RENDER.0 as f32 / OUTPUT.0 as f32, i, i == 0);
            config.render_size = RENDER;
            config.jitter = jitter;
            let mut row = GpuTaauParams::new(&TaaQuality::DEFAULT, &config, prev, 1.0);
            row.counts[2] = 1;
            TaauFrameImage {
                scene: panned(RENDER, jitter, speed * i as f32),
                depth: vec![DEPTH; (RENDER.0 * RENDER.1) as usize],
                motion: pan_motion(RENDER, speed),
                reactive: Vec::new(),
                row,
            }
        })
        .collect()
}

fn luma(t: &[f32; 4]) -> f32 {
    0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2]
}

/// The mean absolute 4-neighbour Laplacian of the image's luma over its interior: the sharpness
/// the acceptance compares (plan §5, B.8: "within 10% (Laplacian)").
fn laplacian(image: &TaaImage) -> f32 {
    let (w, h) = image.size;
    let at = |x: u32, y: u32| luma(&image.texels[(y * w + x) as usize]);
    let mut sum = 0.0f64;
    let mut count = 0u32;
    for y in 2..h - 2 {
        for x in 2..w - 2 {
            let l = 4.0 * at(x, y) - at(x - 1, y) - at(x + 1, y) - at(x, y - 1) - at(x, y + 1);
            sum += f64::from(l.abs());
            count += 1;
        }
    }
    (sum / f64::from(count)) as f32
}

fn evidence(name: &str, image: &TaaImage) {
    let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") else {
        return;
    };
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

// ---------------------------------------------------------------------------------------------
// CPU rows

#[test]
fn the_jitter_cycle_grows_with_the_square_of_the_upscale_ratio() {
    // FSR2's phase count, ceil(8 · (display / render)²), by width.
    assert_eq!(jitter_phases((1280, 720), (1920, 1080)), 18, "1.5x");
    assert_eq!(jitter_phases(RENDER_4K, OUTPUT_4K), 18, "4K at 0.67");
    assert_eq!(jitter_phases((960, 540), (1920, 1080)), 32, "2x");
    assert_eq!(jitter_phases((1920, 1080), (1920, 1080)), 8, "no upscale keeps eight");
    assert_eq!(jitter_phases((0, 0), (1920, 1080)), jitter_phases((1, 1), (1920, 1080)), "a zero size reads as one pixel");
}

#[test]
fn every_phase_of_the_cycle_is_its_own_and_stays_inside_the_pixel() {
    for phases in [8, 18, 32] {
        let first: Vec<[f32; 2]> = (0..u64::from(phases)).map(|i| offset_px(i, phases)).collect();
        let second: Vec<[f32; 2]> = (u64::from(phases)..2 * u64::from(phases)).map(|i| offset_px(i, phases)).collect();
        assert_eq!(first, second, "{phases} repeats");
        assert!(first.iter().flatten().all(|axis| (-0.5..0.5).contains(axis)), "{first:?}");
        let mut distinct = first.clone();
        distinct.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        distinct.dedup();
        assert_eq!(distinct.len(), phases as usize, "every phase is its own");
    }
    assert_eq!(offset_px(0, 8), genex_render::jitter::offset_px(0, JitterCycle::Eight), "eight phases are TAA's cycle");
}

#[test]
fn the_texture_lod_bias_is_the_ratio_minus_one() {
    let scale = 2.0 / 3.0;
    assert!((texture_lod_bias(scale) - (libm::log2f(scale) - 1.0)).abs() < 1e-6, "{}", texture_lod_bias(scale));
    assert!((texture_lod_bias(1.0) + 1.0).abs() < 1e-6);
    assert_eq!(texture_lod_bias(0.1), genex_render::settings::TAA_LOD_BIAS_MIN, "held at the floor");
}

#[test]
fn the_upscale_runs_only_below_the_output_size() {
    assert!(upscales((1280, 720), (1920, 1080)));
    assert!(!upscales((1920, 1080), (1920, 1080)), "scale 1 keeps TAA at its own size");
}

#[test]
fn the_taau_shaders_validate_against_webgpu_core_and_emit_everywhere() {
    let source = genex_render::post::taau::TAAU;
    let module = naga::front::wgsl::parse_str(source).unwrap_or_else(|error| panic!("{}", error.emit_to_string(source)));
    let info = naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::empty()).validate(&module).unwrap_or_else(|error| panic!("{error:?}"));
    let hlsl_options = naga::back::hlsl::Options { shader_model: naga::back::hlsl::ShaderModel::V5_1, ..Default::default() };
    let mut hlsl = String::new();
    naga::back::hlsl::Writer::new(&mut hlsl, &hlsl_options, &naga::back::hlsl::PipelineOptions::default()).write(&module, &info, None).expect("HLSL SM 5.1");
    let msl_options = naga::back::msl::Options { lang_version: (2, 4), ..Default::default() };
    naga::back::msl::write_string(&module, &info, &msl_options, &naga::back::msl::PipelineOptions::default()).expect("MSL 2.4");
    let spv_options = naga::back::spv::Options { lang_version: (1, 3), ..Default::default() };
    naga::back::spv::write_vec(&module, &info, &spv_options, None).expect("SPIR-V 1.3");
    // Two fragment passes (no storage textures, no compute): it fits WebGPU core and phones.
    let mut entries: Vec<&str> = module.entry_points.iter().map(|entry| entry.name.as_str()).collect();
    entries.sort_unstable();
    assert_eq!(entries, ["fs_taau", "fs_taau_convert", "vs_taau"]);
    assert!(module.entry_points.iter().all(|entry| entry.stage != naga::ShaderStage::Compute));
}

/// The uniform's Rust row and its WGSL struct have one size (no padding drift between them).
#[test]
fn the_row_matches_the_wgsl_struct() {
    let module = naga::front::wgsl::parse_str(genex_render::post::taau::TAAU).expect("parsed");
    let mut layouter = naga::proc::Layouter::default();
    layouter.update(module.to_ctx()).expect("layout");
    let (handle, _) = module.types.iter().find(|(_, ty)| ty.name.as_deref() == Some("TaauParams")).expect("TaauParams declared");
    assert_eq!(layouter[handle].size as usize, size_of::<GpuTaauParams>());
}

// ---------------------------------------------------------------------------------------------
// GPU rows

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
        Err(error) if require => {
            panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}")
        }
        Err(error) => {
            eprintln!("skipped: no WebGPU-core adapter ({error})");
            None
        }
    }
}

/// The acceptance row (plan §5, B.8): a still frame drawn at 0.67 of the output and upscaled keeps
/// the native frame's sharpness within 10%. Red at head: TAA at render size and EASU reached 0.70
/// of the native Laplacian.
#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_a_still_frame_upscaled_from_two_thirds_keeps_native_sharpness() {
    let Some((_rows, gpu)) = gpu() else { return };
    let native = native(&gpu);
    let phases = jitter_phases(RENDER, OUTPUT);
    let images = taau_resolve_images(&gpu, RENDER, OUTPUT, &upscaled_frames(u64::from(phases) * 2)).expect("upscaled");
    let upscaled = images.last().expect("frames");
    assert_eq!(upscaled.size, OUTPUT, "the history is at output size");
    evidence("native", &native);
    evidence("upscaled", upscaled);
    let (n, u) = (laplacian(&native), laplacian(upscaled));
    let ratio = u / n;
    eprintln!("Laplacian: native {n:.4}, upscaled from 0.67 {u:.4}, ratio {ratio:.3}");
    assert!((ratio - 1.0).abs() <= SHARPNESS_TOLERANCE, "upscaled sharpness {ratio:.3} of native");
    // And it shows the scene, not ringing: close to native per pixel.
    let mae: f32 = native.texels.iter().zip(&upscaled.texels).map(|(a, b)| (luma(a) - luma(b)).abs()).sum::<f32>() / native.texels.len() as f32;
    let reference = supersampled(0.0);
    eprintln!("mean luma error against native {mae:.4}; against the scene: native {:.4}, upscaled {:.4}", mean_error(&native, &reference), mean_error(upscaled, &reference));
    assert!(mae < 0.08, "mean luma error {mae}");
}

/// A slow pan (a third of an output pixel a frame, the creeping camera of the motion paths) keeps
/// the native pan's sharpness within the same 10%: the history is resampled every frame, and a
/// soft resample would blur what the jitter built (the AAA rubric's pan sharpness row).
#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_a_slow_pan_upscaled_from_two_thirds_keeps_native_sharpness() {
    let Some((_rows, gpu)) = gpu() else { return };
    let count = 48;
    let native = native_panned(&gpu, count, PAN_SPEED);
    let images = taau_resolve_images(&gpu, RENDER, OUTPUT, &upscaled_panned(count, PAN_SPEED)).expect("upscaled");
    let upscaled = images.last().expect("frames");
    evidence("pan-native", &native);
    evidence("pan-upscaled", upscaled);
    let (n, u) = (laplacian(&native), laplacian(upscaled));
    let ratio = u / n;
    // The Laplacian also rises with noise: the error against the supersampled scene says whether
    // the sharpness is the scene's.
    let reference = supersampled(PAN_SPEED * (count - 1) as f32);
    let (native_error, upscaled_error) = (mean_error(&native, &reference), mean_error(upscaled, &reference));
    eprintln!("pan Laplacian: native {n:.4}, upscaled from 0.67 {u:.4}, ratio {ratio:.3}; error against the scene: native {native_error:.4}, upscaled {upscaled_error:.4}");
    assert!(ratio >= 1.0 - SHARPNESS_TOLERANCE, "panned upscaled sharpness {ratio:.3} of native");
    assert!(upscaled_error <= native_error * (1.0 + SHARPNESS_TOLERANCE), "the pan's sharpness is the scene's, not noise: {upscaled_error} against {native_error}");
}

/// The scene moved left by `shift` output pixels, averaged over a 6x6 grid in each output pixel.
fn supersampled(shift: f32) -> TaaImage {
    let n = 6;
    let texels = (0..OUTPUT.1)
        .flat_map(|y| (0..OUTPUT.0).map(move |x| (x, y)))
        .map(|(x, y)| {
            let mut sum = [0.0f32; 4];
            for (i, j) in (0..n).flat_map(|i| (0..n).map(move |j| (i, j))) {
                let c = shade(detail(x as f32 + (i as f32 + 0.5) / n as f32 + shift, y as f32 + (j as f32 + 0.5) / n as f32));
                for k in 0..4 {
                    sum[k] += c[k] / (n * n) as f32;
                }
            }
            sum
        })
        .collect();
    TaaImage { size: OUTPUT, texels }
}

/// The mean absolute luma error of `image` against `reference` over the interior.
fn mean_error(image: &TaaImage, reference: &TaaImage) -> f32 {
    let (w, h) = image.size;
    let mut sum = 0.0f64;
    let mut count = 0u32;
    for y in 2..h - 2 {
        for x in 2..w - 2 {
            let at = (y * w + x) as usize;
            sum += f64::from((luma(&image.texels[at]) - luma(&reference.texels[at])).abs());
            count += 1;
        }
    }
    (sum / f64::from(count)) as f32
}

/// The share of pixels whose luma moves by more than three 8-bit levels from one frame to the next
/// over `images` (the AAA rubric's still shimmer measure).
fn flicker_share(images: &[TaaImage]) -> f32 {
    let encode = |v: f32| {
        let v = v.clamp(0.0, 1.0);
        255.0 * if v <= 0.003_130_8 { v * 12.92 } else { 1.055 * libm::powf(v, 1.0 / 2.4) - 0.055 }
    };
    let mut flickered = 0usize;
    let mut total = 0usize;
    for pair in images.windows(2) {
        for (a, b) in pair[0].texels.iter().zip(&pair[1].texels) {
            total += 1;
            if (encode(luma(a)) - encode(luma(b))).abs() > 3.0 {
                flickered += 1;
            }
        }
    }
    flickered as f32 / total.max(1) as f32
}

/// A still camera's upscaled frames hold steady once settled (within [`STILL_FLICKER_MAX`]; the AAA
/// rubric's 0.10% is open for the upscale).
#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_a_still_upscaled_frame_holds_steady_once_settled() {
    let Some((_rows, gpu)) = gpu() else { return };
    let phases = u64::from(jitter_phases(RENDER, OUTPUT));
    let images = taau_resolve_images(&gpu, RENDER, OUTPUT, &upscaled_frames(phases * 16)).expect("upscaled");
    for window in 0..8 {
        let at = (phases * 2 * window) as usize;
        eprintln!("frames {at}..: {:.4}%", flicker_share(&images[at..at + (phases * 2) as usize]) * 100.0);
    }
    let settled = &images[(phases * 12) as usize..];
    let share = flicker_share(settled);
    let native = native_sequence(&gpu, 72, 0.0);
    let native_share = flicker_share(&native[36..]);
    eprintln!("still flicker over {} settled frames: {:.4}% (native TAA {:.4}%)", settled.len(), share * 100.0, native_share * 100.0);
    assert!(share <= STILL_FLICKER_MAX, "{:.4}% of pixels flicker", share * 100.0);
}

/// A moving square over a still background (output pixels): its left edge at `x0`.
fn square(x: f32, y: f32, x0: f32) -> bool {
    (x0..x0 + 40.0).contains(&x) && (34.0..74.0).contains(&y)
}

/// The square's frame at render size, its depth (closer in front) and motion (`speed` output pixels
/// a frame to the right, on the square's pixels only).
fn square_frame(jitter: [f32; 2], x0: f32, speed: f32) -> TaauFrameImage {
    let (sx, sy) = (OUTPUT.0 as f32 / RENDER.0 as f32, OUTPUT.1 as f32 / RENDER.1 as f32);
    let hits: Vec<bool> =
        (0..RENDER.1).flat_map(|y| (0..RENDER.0).map(move |x| (x, y))).map(|(x, y)| square((x as f32 + 0.5 - jitter[0]) * sx, (y as f32 + 0.5 - jitter[1]) * sy, x0)).collect();
    let motion = hits.iter().map(|&fg| if fg { [2.0 * speed / OUTPUT.0 as f32, 0.0] } else { [0.0, 0.0] }).collect();
    let mut config = RenderSettings::off().frame_config(OUTPUT, RENDER.0 as f32 / OUTPUT.0 as f32, 0, false);
    config.render_size = RENDER;
    config.jitter = jitter;
    let mut row = GpuTaauParams::new(&TaaQuality::DEFAULT, &config, jitter, 1.0);
    row.counts[2] = 1;
    TaauFrameImage { scene: hits.iter().map(|&fg| shade(fg)).collect(), depth: hits.iter().map(|&fg| if fg { 0.5 } else { 0.2 }).collect(), motion, reactive: Vec::new(), row }
}

/// What a moving object leaves behind takes the background at once (the convert's disocclusion
/// test), so it leaves no trail: after one frame of motion at 6 output pixels a frame, at most the
/// edge's own pixels differ from the background.
#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_a_moving_square_leaves_no_trail_behind_it() {
    let Some((_rows, gpu)) = gpu() else { return };
    let phases = jitter_phases(RENDER, OUTPUT);
    let speed = 6.0;
    let still = 36u64;
    let frames: Vec<TaauFrameImage> = (0..still + 2)
        .map(|i| {
            let moved = i.saturating_sub(still - 1) as f32 * speed;
            let mut frame = square_frame(offset_px(i, phases), 60.0 + moved, if i >= still { speed } else { 0.0 });
            if i == 0 {
                frame.row.counts[1] = 1;
            }
            frame
        })
        .collect();
    let images = taau_resolve_images(&gpu, RENDER, OUTPUT, &frames).expect("upscaled");
    let last = images.last().expect("frames");
    evidence("square-trail", last);
    let x0 = 60.0 + 2.0 * speed;
    let bg = luma(&shade(false));
    // Pixels the square covered before it moved and no longer covers, a pixel clear of its edge.
    let trail = (36..72u32).flat_map(|y| (61..(x0 as u32 - 1)).map(move |x| (x, y))).filter(|&(x, y)| (luma(&last.texels[(y * OUTPUT.0 + x) as usize]) - bg).abs() > 0.05).count();
    eprintln!("trail pixels: {trail}");
    assert_eq!(trail, 0, "pixels of trail behind the square");
}

/// Two runs of one sequence give the same bytes (captures are deterministic).
#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_two_runs_of_one_upscaled_sequence_give_identical_bytes() {
    let Some((_rows, gpu)) = gpu() else { return };
    let frames = upscaled_frames(6);
    let a = taau_resolve_images(&gpu, RENDER, OUTPUT, &frames).expect("first");
    let b = taau_resolve_images(&gpu, RENDER, OUTPUT, &frames).expect("second");
    assert_eq!(a, b);
}

/// A reset takes the current frame whole: the first frame is the Lanczos reconstruction of its
/// samples, no history (nothing black or stale leaks in).
#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_the_first_frame_after_a_reset_is_the_current_frame_alone() {
    let Some((_rows, gpu)) = gpu() else { return };
    let images = taau_resolve_images(&gpu, RENDER, OUTPUT, &upscaled_frames(1)).expect("upscaled");
    let first = &images[0];
    let darkest = first.texels.iter().map(luma).fold(f32::INFINITY, f32::min);
    let brightest = first.texels.iter().map(luma).fold(0.0f32, f32::max);
    let (bg, fg) = (luma(&shade(false)), luma(&shade(true)));
    assert!(darkest >= bg - 0.02 && brightest <= fg + 0.02, "inside the scene's range: {darkest}..{brightest}");
}

/// The cost row (plan §5, B.8): <= 0.6 ms at 4K output from 0.67.
#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_taau_at_4k_holds_its_budget() {
    let Some((_rows, gpu)) = gpu() else { return };
    let Some(mut costs) = taau_gpu_ms(&gpu, RENDER_4K, OUTPUT_4K, COST_FRAMES).expect("timed") else {
        eprintln!("skipped: no timestamp queries");
        return;
    };
    costs.sort_by(f32::total_cmp);
    let median = costs[costs.len() / 2];
    let p95 = costs[(costs.len() * 95 / 100).min(costs.len() - 1)];
    let least = costs[0];
    eprintln!("TAAU 4K from 0.67: median {median:.3} ms, p95 {p95:.3} ms, least {least:.3} ms ({COST_RESOLVES_PER_SAMPLE} resolves a sample)");
    if let Ok(path) = std::env::var("GENEX_PERF_OUT") {
        let json = format!(
            "{{\"row\":\"taau-4k\",\"render\":[{},{}],\"output\":[{},{}],\"median_ms\":{median},\"p95_ms\":{p95},\"budget_ms\":{TAAU_BUDGET_MS_4K}}}\n",
            RENDER_4K.0, RENDER_4K.1, OUTPUT_4K.0, OUTPUT_4K.1
        );
        std::fs::write(path, json).expect("perf out");
    }
    assert!(median <= TAAU_BUDGET_MS_4K, "TAAU at 4K: {median:.3} ms");
}

fn median_of(costs: Option<Vec<f32>>) -> Option<f32> {
    let mut costs = costs?;
    costs.sort_by(f32::total_cmp);
    costs.get(costs.len() / 2).copied()
}

/// What the upscale replaces at 4K from 0.67, for the record (no assertion): TAA at render size and
/// EASU + RCAS to the output, the path DRS on `high` and `ultra` runs without it.
#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_the_replaced_path_at_4k_for_the_record() {
    let Some((_rows, gpu)) = gpu() else { return };
    let taa = median_of(genex_render::post::taa::taa_gpu_ms(&gpu, RENDER_4K, COST_FRAMES).expect("timed"));
    let fsr = median_of(genex_render::post::fsr::gpu_ms(&gpu, RENDER_4K, OUTPUT_4K, COST_FRAMES).expect("timed"));
    let taau = median_of(taau_gpu_ms(&gpu, RENDER_4K, OUTPUT_4K, COST_FRAMES).expect("timed"));
    eprintln!("4K from 0.67: TAA at render size {taa:?} ms + EASU/RCAS {fsr:?} ms, against TAAU {taau:?} ms");
}
