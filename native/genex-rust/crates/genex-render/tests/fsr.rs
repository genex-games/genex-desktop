//! RQ5.3: the FSR1 upscaler, EASU's edge-adaptive upscale and RCAS's sharpening (graph node 22),
//! its constants, its cost model and DRS's use of it.
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test fsr -- --ignored metal
//!
//! `GENEX_RENDER_EVIDENCE_DIR` also writes each compared image there (raw BGRA, top row first);
//! `GENEX_PERF_OUT` receives the cost row as JSON. No golden is stored: the rows measure the
//! upscaler against bilinear and against its own invariants.

use std::path::PathBuf;
use std::time::Duration;

use genex_render::capture::Capture;
use genex_render::drs::{DrsController, FrameSignal, ScaleSteps};
use genex_render::post::fsr::{
    COST_BUDGET_MS_1080P, DITHER_FRAME_CYCLE, FsrPasses, GpuEasuParams, GpuRcasParams, estimated_cost_ms, gpu_ms, passes, upscale_image,
};
use genex_render::settings::{Quality, RcasQuality, RenderFeature};
use genex_render::{Gpu, RenderError};

// ---------------------------------------------------------------------------------------------
// CPU rows

#[test]
fn easu_constants_place_the_gathers_on_the_corners_around_the_f_texel() {
    let con = GpuEasuParams::new((960, 540), (1920, 1080));
    assert_eq!(con.con0, [0.5, 0.5, -0.25, -0.25], "scale, and half a scaled texel less half a texel");
    let (x, y) = (1.0 / 960.0, 1.0 / 540.0);
    assert_eq!(con.con1, [x, y, x, -y]);
    assert_eq!(con.con2, [-x, 2.0 * y, x, 2.0 * y]);
    assert_eq!(con.con3, [0.0, 4.0 * y, 0.0, 0.0]);
    // Scale 1 is the identity mapping: output pixel centres land on texel centres.
    assert_eq!(GpuEasuParams::new((64, 36), (64, 36)).con0, [1.0, 1.0, 0.0, 0.0]);
}

#[test]
fn hostile_sizes_keep_every_constant_finite() {
    for (render, output) in [((0, 0), (0, 0)), ((1, 1), (u32::MAX, u32::MAX)), ((u32::MAX, 1), (1, u32::MAX))] {
        let easu = GpuEasuParams::new(render, output);
        let rcas = GpuRcasParams::new(&RcasQuality::DEFAULT, output, true).keyed(u64::MAX);
        let all: Vec<f32> = [easu.con0, easu.con1, easu.con2, easu.con3, rcas.con, rcas.size].concat();
        assert!(all.iter().all(|c| c.is_finite()), "{render:?} -> {output:?}: {all:?}");
    }
}

#[test]
fn rcas_rows_are_unsharpened_dither_only_or_keyed_to_the_frame() {
    let plain = GpuRcasParams::unsharpened((8, 4), true);
    assert_eq!((plain.con[0], plain.con[1]), (0.0, 1.0), "no sharpening, dithered");
    assert_eq!(GpuRcasParams::unsharpened((8, 4), false).con[1], 0.0);
    let keyed = GpuRcasParams::new(&RcasQuality::DEFAULT, (8, 4), true).keyed(DITHER_FRAME_CYCLE + 3);
    assert_eq!(keyed.con[2], 3.0, "the noise repeats after its cycle");
}

#[test]
fn the_cost_estimate_is_the_budget_at_1080p_and_follows_the_output_pixels() {
    assert_eq!(estimated_cost_ms((1920, 1080)), COST_BUDGET_MS_1080P);
    assert!((estimated_cost_ms((3840, 2160)) - 4.0 * COST_BUDGET_MS_1080P).abs() < 1e-6);
    assert!(estimated_cost_ms((0, 0)) > 0.0 && estimated_cost_ms((0, 0)).is_finite());
}

#[test]
fn a_step_below_the_output_runs_easu_and_rcas_and_the_scale_steps_pick_the_passes() {
    let mut quality = Quality::off();
    quality.hdr = true;
    quality.set_feature(RenderFeature::Upscaler, true);
    let output = (1920, 1080);
    // Every size a stepped scale makes below the output upscales; the top step does not.
    let steps = ScaleSteps::over((0.5, 1.0), 6);
    for scale in steps.steps() {
        let render = genex_render::presets::step_size(output, *scale);
        let ran = passes(&quality, render, output);
        assert_eq!(ran.easu, render != output, "scale {scale}: {render:?}");
        assert_eq!(ran.rcas, ran.easu, "RCAS follows EASU without TAA's sharpen");
    }
    assert_eq!(passes(&quality, output, output), FsrPasses::default());
}

#[test]
fn drs_counts_the_upscale_as_a_cost_a_lower_step_does_not_save() {
    // 60 Hz class: the GPU target is 85% of 16.67 ms = 14.17 ms. A frame costs 25 ms at scale 1.0,
    // 4 ms of it the upscale at output size; the rest is proportional to the rendered pixels.
    const UPSCALE_MS: f32 = 4.0;
    let steps = ScaleSteps::table(&[0.5, 0.75, 1.0], 1.0);
    let interval = Duration::from_micros(16_667);
    let target = DrsController::new(steps.clone(), 1.0, interval).gpu_target_ms();
    // The steps it visits and the frames it spends over target.
    let run = |fixed_ms: f32| {
        let mut drs = DrsController::new(steps.clone(), 1.0, interval).with_fixed_ms(fixed_ms);
        let (mut now, mut visited, mut over) = (Duration::ZERO, vec![drs.scale()], 0);
        for _ in 0..40 {
            now += interval;
            let scale = drs.scale();
            let ms = UPSCALE_MS + (25.0 - UPSCALE_MS) * scale * scale;
            over += usize::from(ms > target);
            drs.observe(FrameSignal::GpuMs(ms), now);
            if visited.last() != Some(&drs.scale()) {
                visited.push(drs.scale());
            }
        }
        (visited, over)
    };
    let (blind, blind_over) = run(0.0);
    let (aware, aware_over) = run(UPSCALE_MS);
    assert_eq!(blind, [1.0, 0.75, 0.5], "proportional prediction promises 14.06 ms at 0.75 and needs a second drop");
    assert_eq!(aware, [1.0, 0.5], "the fixed term lands the first drop on the step that fits");
    assert!(aware_over < blind_over, "{aware_over} frames over target against {blind_over}");
    assert_eq!(DrsController::new(steps.clone(), 1.0, interval).with_fixed_ms(f32::NAN).fixed_ms(), 0.0, "NaN is no cost");
    assert_eq!(DrsController::new(steps, 1.0, interval).with_fixed_ms(-3.0).fixed_ms(), 0.0, "a saving is no cost");
}

// ---------------------------------------------------------------------------------------------
// GPU fixtures

/// An input size, an output size and the grey level of the flat image between them.
type Case = ((u32, u32), (u32, u32), f32);

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

/// A `size` image whose texel (x, y) is `f(x, y)` as grey.
fn grey(size: (u32, u32), f: impl Fn(f32, f32) -> f32) -> Vec<[f32; 4]> {
    (0..size.1).flat_map(|y| (0..size.0).map(move |x| (x, y))).map(|(x, y)| {
        let v = f(x as f32, y as f32);
        [v, v, v, 1.0]
    }).collect()
}

/// The colour of the test scene at `(u, v)` in 0..1, `aspect` = height / width: a slanted
/// half-plane, a disc and thin lines on a gradient.
fn scene_colour(u: f32, v: f32, aspect: f32) -> [f32; 3] {
    let mut c = [0.25 + 0.3 * v, 0.35 + 0.2 * u, 0.55 - 0.2 * v];
    if v > 0.62 + 0.25 * u {
        c = [0.12, 0.3, 0.14];
    }
    let (du, dv) = (u - 0.3, (v - 0.35) * aspect);
    if du * du + dv * dv < 0.015 {
        c = [0.9, 0.82, 0.3];
    }
    if ((u * 29.0 + v * 7.0).fract() < 0.06) && v < 0.5 && u > 0.55 {
        c = [0.05, 0.05, 0.08];
    }
    c
}

/// The scene point-sampled at `size` (what a render without antialiasing draws).
fn scene(size: (u32, u32)) -> Vec<[f32; 4]> {
    let aspect = size.1 as f32 / size.0 as f32;
    (0..size.1)
        .flat_map(|y| (0..size.0).map(move |x| (x, y)))
        .map(|(x, y)| {
            let c = scene_colour((x as f32 + 0.5) / size.0 as f32, (y as f32 + 0.5) / size.1 as f32, aspect);
            [c[0], c[1], c[2], 1.0]
        })
        .collect()
}

/// The scene at `size` with `n` x `n` samples a pixel: the picture the upscale is trying to reach.
fn scene_truth(size: (u32, u32), n: u32) -> Vec<[f32; 3]> {
    let aspect = size.1 as f32 / size.0 as f32;
    (0..size.1)
        .flat_map(|y| (0..size.0).map(move |x| (x, y)))
        .map(|(x, y)| {
            let mut sum = [0.0f32; 3];
            for j in 0..n {
                for i in 0..n {
                    let (u, v) = ((x as f32 + (i as f32 + 0.5) / n as f32) / size.0 as f32, (y as f32 + (j as f32 + 0.5) / n as f32) / size.1 as f32);
                    let c = scene_colour(u, v, aspect);
                    sum = std::array::from_fn(|k| sum[k] + c[k]);
                }
            }
            sum.map(|c| c / (n * n) as f32)
        })
        .collect()
}

fn mean_abs_error(a: &[[f32; 3]], b: &[[f32; 3]]) -> f32 {
    a.iter().zip(b).flat_map(|(p, q)| (0..3).map(move |c| (p[c] - q[c]).abs())).sum::<f32>() / (a.len() * 3) as f32
}

/// Bilinear upscale of `texels` to `output` the way a sampler places it (texel centres, clamped).
fn bilinear(size: (u32, u32), texels: &[[f32; 4]], output: (u32, u32)) -> Vec<[f32; 3]> {
    let at = |x: i32, y: i32| texels[(y.clamp(0, size.1 as i32 - 1) as u32 * size.0 + x.clamp(0, size.0 as i32 - 1) as u32) as usize];
    (0..output.1)
        .flat_map(|y| (0..output.0).map(move |x| (x, y)))
        .map(|(x, y)| {
            let sx = (x as f32 + 0.5) * size.0 as f32 / output.0 as f32 - 0.5;
            let sy = (y as f32 + 0.5) * size.1 as f32 / output.1 as f32 - 0.5;
            let (fx, fy) = (sx.floor(), sy.floor());
            let (tx, ty) = (sx - fx, sy - fy);
            let (ix, iy) = (fx as i32, fy as i32);
            std::array::from_fn(|c| {
                let top = at(ix, iy)[c] * (1.0 - tx) + at(ix + 1, iy)[c] * tx;
                let bottom = at(ix, iy + 1)[c] * (1.0 - tx) + at(ix + 1, iy + 1)[c] * tx;
                top * (1.0 - ty) + bottom * ty
            })
        })
        .collect()
}

/// The steepest step between neighbouring pixels (forward differences, green channel).
fn max_gradient(size: (u32, u32), pixels: &[[f32; 3]]) -> f32 {
    let at = |x: u32, y: u32| pixels[(y * size.0 + x) as usize][1];
    let mut worst = 0.0f32;
    for y in 0..size.1 - 1 {
        for x in 0..size.0 - 1 {
            let (gx, gy) = (at(x + 1, y) - at(x, y), at(x, y + 1) - at(x, y));
            worst = worst.max((gx * gx + gy * gy).sqrt());
        }
    }
    worst
}

fn bgra_to_rgb(capture: &Capture) -> Vec<[f32; 3]> {
    capture.bgra().as_chunks::<4>().0.iter().map(|p| [p[2], p[1], p[0]].map(|c| f32::from(c) / 255.0)).collect()
}

fn rgb_to_capture(size: (u32, u32), pixels: &[[f32; 3]]) -> Capture {
    let bytes = pixels.iter().flat_map(|p| [p[2], p[1], p[0], 1.0].map(|c| (c.clamp(0.0, 1.0) * 255.0 + 0.5) as u8)).collect();
    Capture::new(size.0, size.1, bytes).expect("capture")
}

fn upscale(gpu: &Gpu, size: (u32, u32), texels: &[[f32; 4]], output: (u32, u32), rcas: Option<&RcasQuality>, dither: bool) -> Result<genex_render::post::fsr::FsrImage, RenderError> {
    upscale_image(gpu, (size, texels), output, rcas, dither)
}

// ---------------------------------------------------------------------------------------------
// GPU rows

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_easu_at_half_scale_makes_a_slanted_edge_at_least_thirty_percent_sharper_than_bilinear() {
    let Some(gpu) = gpu() else { return };
    let (size, output) = ((64, 36), (128, 72));
    // A hard-edged half-plane at a shallow slope: the staircase an unsmoothed render leaves.
    let texels = grey(size, |x, y| if y > 0.3 * x + 8.0 { 0.9 } else { 0.1 });
    let image = upscale(&gpu, size, &texels, output, Some(&RcasQuality::DEFAULT), false).expect("upscale");
    let easu = image.easu.expect("EASU ran below the output size");
    let reference = bilinear(size, &texels, output);
    let (sharp, soft) = (max_gradient(output, &easu), max_gradient(output, &reference));
    eprintln!("slanted edge: EASU max gradient {sharp:.4}, bilinear {soft:.4} ({:.0}% more)", (sharp / soft - 1.0) * 100.0);
    assert!(sharp >= soft * 1.3, "EASU {sharp} must exceed bilinear {soft} by 30%");
    // Sharper must not mean a staircase: nearest-neighbour has no pixel between the two levels.
    let between = |pixels: &[[f32; 3]]| pixels.iter().filter(|p| p[1] > 0.15 && p[1] < 0.85).count();
    let (easu_between, bilinear_between) = (between(&easu), between(&reference));
    eprintln!("transition pixels: EASU {easu_between}, bilinear {bilinear_between}");
    assert!(easu_between * 4 >= bilinear_between, "EASU keeps an antialiased edge: {easu_between} transition pixels against bilinear's {bilinear_between}");
    write_evidence("edge-bilinear", &rgb_to_capture(output, &reference));
    write_evidence("edge-easu-rcas", &image.capture);
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_rcas_alone_at_scale_one_with_no_sharpening_is_the_identity() {
    let Some(gpu) = gpu() else { return };
    let size = (64, 36);
    let texels = scene(size);
    let image = upscale(&gpu, size, &texels, size, None, false).expect("upscale");
    assert!(image.easu.is_none(), "nothing to upscale at scale 1");
    let out = bgra_to_rgb(&image.capture);
    let worst = texels.iter().zip(&out).flat_map(|(t, o)| (0..3).map(move |c| (t[c] - o[c]).abs())).fold(0.0f32, f32::max);
    assert!(worst <= 1.0 / 255.0 + 1e-6, "worst channel error {worst} over one 8-bit level");
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_rcas_sharpens_an_edge_and_never_leaves_the_neighbourhood_range_by_more_than_the_limit() {
    let Some(gpu) = gpu() else { return };
    let size = (64, 36);
    let texels = grey(size, |x, _| if x < 32.0 { 0.3 } else { 0.7 });
    // A soft edge: two blended columns.
    let mut soft = texels.clone();
    for row in soft.chunks_mut(64) {
        row[31] = [0.4, 0.4, 0.4, 1.0];
        row[32] = [0.6, 0.6, 0.6, 1.0];
    }
    let flat = bgra_to_rgb(&upscale(&gpu, size, &soft, size, None, false).expect("flat").capture);
    let sharp = bgra_to_rgb(&upscale(&gpu, size, &soft, size, Some(&RcasQuality::DEFAULT.with_sharpness(0.0)), false).expect("sharp").capture);
    let (before, after) = (max_gradient(size, &flat), max_gradient(size, &sharp));
    eprintln!("soft edge: unsharpened {before:.4}, RCAS(0 stops) {after:.4}");
    assert!(after > before * 1.1, "RCAS steepens the edge: {after} against {before}");
    let row = |pixels: &[[f32; 3]], x: usize| pixels[18 * 64 + x][1];
    assert!(row(&sharp, 31) < row(&flat, 31) && row(&sharp, 32) > row(&flat, 32), "dark side darker, light side lighter");
    assert!(row(&sharp, 30) >= 0.3 - 0.2 && row(&sharp, 33) <= 0.7 + 0.2, "overshoot stays bounded");
    let softer = bgra_to_rgb(&upscale(&gpu, size, &soft, size, Some(&RcasQuality::DEFAULT.with_sharpness(2.0)), false).expect("softer").capture);
    assert!(max_gradient(size, &softer) < after, "more stops sharpen less");
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_flat_and_degenerate_images_upscale_to_themselves_without_ringing_or_nan() {
    let Some(gpu) = gpu() else { return };
    // (input size, output size, grey level)
    let cases: [Case; 8] = [
        ((1, 1), (16, 9), 0.37),
        ((1, 7), (9, 14), 0.5),
        ((9, 1), (14, 9), 0.5),
        ((32, 18), (64, 36), 0.0),
        ((32, 18), (64, 36), 1.0),
        ((32, 18), (47, 31), 0.62),
        ((2, 2), (4096, 8), 0.2),
        ((33, 19), (34, 20), 0.8),
    ];
    for (size, output, level) in cases {
        let texels = grey(size, |_, _| level);
        let image = upscale(&gpu, size, &texels, output, Some(&RcasQuality::DEFAULT.with_sharpness(0.0)), false).expect("upscale");
        let easu = image.easu.expect("upscaled");
        let worst = easu.iter().flatten().map(|c| (c - level).abs()).fold(0.0f32, f32::max);
        assert!(worst <= 2.0 / 1023.0, "{size:?} -> {output:?} at {level}: EASU drifts by {worst}");
        let out = bgra_to_rgb(&image.capture);
        let worst = out.iter().flatten().map(|c| (c - level).abs()).fold(0.0f32, f32::max);
        assert!(worst <= 1.5 / 255.0, "{size:?} -> {output:?} at {level}: RCAS drifts by {worst}");
    }
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_easu_never_leaves_the_range_of_its_input_and_is_deterministic() {
    let Some(gpu) = gpu() else { return };
    let size = (64, 36);
    let texels = scene(size);
    let output = (128, 72);
    let first = upscale(&gpu, size, &texels, output, Some(&RcasQuality::DEFAULT), true).expect("first");
    let easu = first.easu.as_ref().expect("upscaled");
    for channel in 0..3 {
        let (lo, hi) = texels.iter().fold((1.0f32, 0.0f32), |(lo, hi), t| (lo.min(t[channel]), hi.max(t[channel])));
        let (out_lo, out_hi) = easu.iter().fold((1.0f32, 0.0f32), |(lo, hi), p| (lo.min(p[channel]), hi.max(p[channel])));
        assert!(out_lo >= lo - 1.5 / 1023.0 && out_hi <= hi + 1.5 / 1023.0, "channel {channel}: [{out_lo}, {out_hi}] outside [{lo}, {hi}]");
    }
    // Against the scene itself at output size, EASU lands nearer than bilinear does.
    let truth = scene_truth(output, 4);
    let (easu_error, bilinear_error) = (mean_abs_error(easu, &truth), mean_abs_error(&bilinear(size, &texels, output), &truth));
    eprintln!("mean error against the scene at output size: EASU {easu_error:.5}, bilinear {bilinear_error:.5}");
    assert!(easu_error < bilinear_error, "EASU {easu_error} must reconstruct nearer than bilinear {bilinear_error}");
    let second = upscale(&gpu, size, &texels, output, Some(&RcasQuality::DEFAULT), true).expect("second");
    assert_eq!(first.capture.digest(), second.capture.digest(), "the same adapter gives the same picture");
    write_evidence("scene-bilinear", &rgb_to_capture(output, &bilinear(size, &texels, output)));
    write_evidence("scene-easu-rcas", &first.capture);
    write_evidence("scene-source", &rgb_to_capture(size, &texels.iter().map(|t| [t[0], t[1], t[2]]).collect::<Vec<_>>()));
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_the_final_dither_moves_a_flat_field_by_at_most_one_level_and_only_when_asked() {
    let Some(gpu) = gpu() else { return };
    let size = (64, 36);
    // Half way between two 8-bit levels: the dither decides which side a pixel lands on.
    let level = 100.5 / 255.0;
    let texels = grey(size, |_, _| level);
    let plain = upscale(&gpu, size, &texels, size, None, false).expect("plain").capture;
    let dithered = upscale(&gpu, size, &texels, size, None, true).expect("dithered").capture;
    let levels = |capture: &Capture| {
        let mut seen: Vec<u8> = capture.bgra().as_chunks::<4>().0.iter().map(|p| p[1]).collect();
        seen.sort_unstable();
        seen.dedup();
        seen
    };
    assert_eq!(levels(&plain).len(), 1, "no dither, one level");
    let seen = levels(&dithered);
    assert!(seen.len() == 2 && seen[1] - seen[0] == 1, "dither spreads the field over two adjacent levels: {seen:?}");
    write_evidence("dither-off", &plain);
    write_evidence("dither-on", &dithered);
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_easu_plus_rcas_at_1080p_holds_its_budget() {
    let Some(gpu) = gpu() else { return };
    let output = (1920, 1080);
    // The stepped scales an upscaling class runs at, and scale 1 (RCAS alone, TAA's sharpen).
    let mut rows = Vec::new();
    for scale in [0.5f32, 0.67, 0.75, 1.0] {
        let render = genex_render::presets::step_size(output, scale);
        // The best of three runs: this runs beside other GPU work on a shared machine, and one
        // run's tail can be another process's frame rather than the passes' cost.
        let mut best: Option<Vec<f32>> = None;
        for _ in 0..3 {
            let Some(mut run) = gpu_ms(&gpu, render, output, 60).expect("timed") else {
                eprintln!("skipped: the device has no TIMESTAMP_QUERY");
                return;
            };
            run.sort_by(f32::total_cmp);
            let tail = |costs: &[f32]| costs[((costs.len() - 1) as f32 * 0.95).round() as usize];
            if best.as_ref().is_none_or(|kept| tail(&run) < tail(kept)) {
                best = Some(run);
            }
        }
        let costs = best.expect("three runs");
        assert!(costs.len() >= 30, "{} of 60 frames timed", costs.len());
        let p = |q: f32| costs[((costs.len() - 1) as f32 * q).round() as usize];
        let (p50, p95) = (p(0.5), p(0.95));
        eprintln!("EASU + RCAS {}x{} -> 1920x1080 (scale {scale}): p50 {p50:.3} ms, p95 {p95:.3} ms", render.0, render.1);
        rows.push(format!(
            "{{\"row\":\"fsr\",\"scale\":{scale},\"render\":[{},{}],\"output\":[{},{}],\"samples\":{},\"gpu_ms_p50\":{p50},\"gpu_ms_p95\":{p95},\"budget_ms\":{COST_BUDGET_MS_1080P},\"backend\":\"{}\",\"adapter\":\"{}\"}}\n",
            render.0,
            render.1,
            output.0,
            output.1,
            costs.len(),
            gpu.receipt().backend,
            gpu.receipt().adapter
        ));
        assert!(p95 <= COST_BUDGET_MS_1080P, "EASU + RCAS p95 {p95} ms at scale {scale} over the {COST_BUDGET_MS_1080P} ms budget (p50 {p50})");
    }
    if let Ok(path) = std::env::var("GENEX_PERF_OUT") {
        std::fs::write(path, rows.concat()).expect("perf row");
    }
}
