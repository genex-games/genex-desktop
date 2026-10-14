//! The Hi-Z pyramid build (R2.2, `genex_render::hiz`). Every row checks one property the occlusion
//! cull relies on: a screen pixel `p` reads mip `k` at `min(p >> (k + 1), size_k - 1)` (a shift and
//! a clamp, no division), and that texel must hold the farthest depth of every pixel that reads it,
//! so a meshlet is never culled by a nearer depth than the one really there (conservative) and the
//! texel is no farther than that (tight). The expected pyramid is computed here by brute force over
//! the pixels, independently of the build's footprint fold. CPU rows hold the CPU reference to it;
//! real-GPU rows (`#[ignore]`d, every name contains `metal`) hold the GPU build to both:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked -- --ignored metal
//!
//! With `GENEX_HIZ_CAPTURE_DIR` set, the GPU row writes every mip of the odd-size pyramid there as
//! `.ppm` evidence; with `GENEX_PERF_OUT`, the cost row writes its JSON there.

use std::path::PathBuf;
use std::sync::Mutex;

use genex_render::Gpu;
use genex_render::budget::{BudgetInput, BudgetKind, ledger};
use genex_render::hiz::{self, HizFrame, HizLevel, HizReduce};
use genex_render::settings::{Quality, SceneFormat};

/// The odd size the work package names: both edges fold a leftover row or column at mip 0.
const ODD: (u32, u32) = (127, 73);
/// Sizes whose chains reach a 1-texel edge before the other, or start there.
const EDGE_SIZES: [(u32, u32); 9] = [(1, 1), (2, 1), (1, 7), (3, 3), (5, 2), (64, 64), (129, 1), (2, 255), (33, 17)];
/// The plan's Hi-Z budget at 1080p (R2.2 acceptance).
const BUDGET_MS: f32 = 0.15;
const COST_SAMPLES: u32 = 60;

/// A deterministic depth image in 0..1 (xorshift; exact in f32), with some texels at both planes.
fn depth_image((width, height): (u32, u32), seed: u32) -> Vec<f32> {
    let mut state = seed.max(1);
    (0..width * height)
        .map(|index| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            match index % 97 {
                0 => 0.0,
                1 => 1.0,
                _ => (state >> 8) as f32 / (1u32 << 24) as f32,
            }
        })
        .collect()
}

fn farther(reduce: HizReduce, a: f32, b: f32) -> f32 {
    reduce.reduce([a, b, a, b])
}

/// The pyramid the cull needs, by brute force: every mip texel is the farthest depth of the pixels
/// whose shift-and-clamp lookup lands on it.
fn expected(reduce: HizReduce, render: (u32, u32), depths: &[f32]) -> Vec<HizLevel> {
    let base = hiz::base_size(render);
    let empty = match reduce {
        HizReduce::Max => f32::NEG_INFINITY,
        _ => f32::INFINITY,
    };
    (0..hiz::mip_count(base))
        .map(|mip| {
            let size = hiz::level_size(base, mip);
            let mut texels = vec![empty; (size.0 * size.1) as usize];
            for py in 0..render.1 {
                for px in 0..render.0 {
                    let tx = (px >> (mip + 1)).min(size.0 - 1);
                    let ty = (py >> (mip + 1)).min(size.1 - 1);
                    let at = (ty * size.0 + tx) as usize;
                    texels[at] = farther(reduce, texels[at], depths[(py * render.0 + px) as usize]);
                }
            }
            HizLevel { size, texels }
        })
        .collect()
}

/// `actual` equals `wanted` bit for bit, mip by mip; the message names the first texel that differs.
fn assert_pyramid(what: &str, actual: &[HizLevel], wanted: &[HizLevel]) {
    assert_eq!(actual.len(), wanted.len(), "{what}: mips");
    for (mip, (got, want)) in actual.iter().zip(wanted).enumerate() {
        assert_eq!(got.size, want.size, "{what}: mip {mip} size");
        let first = got.texels.iter().zip(&want.texels).position(|(a, b)| a.to_bits() != b.to_bits());
        if let Some(at) = first {
            let (x, y) = (at as u32 % got.size.0, at as u32 / got.size.0);
            panic!("{what}: mip {mip} ({}x{}) texel ({x}, {y}) holds {} where its pixels' farthest depth is {}", got.size.0, got.size.1, got.texels[at], want.texels[at]);
        }
    }
}

/// No pixel's depth is farther than the texel its lookup reads, at any mip (the cull's guarantee).
fn assert_conservative(what: &str, reduce: HizReduce, render: (u32, u32), depths: &[f32], pyramid: &[HizLevel]) {
    for (mip, level) in pyramid.iter().enumerate() {
        for py in 0..render.1 {
            for px in 0..render.0 {
                let texel = level.at((px >> (mip + 1)).min(level.size.0 - 1), (py >> (mip + 1)).min(level.size.1 - 1));
                let depth = depths[(py * render.0 + px) as usize];
                assert_eq!(farther(reduce, texel, depth), texel, "{what}: pixel ({px}, {py}) depth {depth} is beyond mip {mip}'s {texel}");
            }
        }
    }
}

// --- CPU rows ---

#[test]
fn the_cpu_reference_keeps_the_farthest_depth_every_pixel_maps_to_at_odd_sizes() {
    for reduce in [HizReduce::Max, HizReduce::Min] {
        for (index, render) in std::iter::once(ODD).chain(EDGE_SIZES).enumerate() {
            let depths = depth_image(render, 7 + index as u32);
            let reference = hiz::reference(reduce, render, &depths).expect("reference");
            let what = format!("{reduce:?} {}x{}", render.0, render.1);
            assert_eq!(reference.len() as u32, hiz::mip_count(hiz::base_size(render)), "{what}: a full chain to 1 x 1");
            assert_conservative(&what, reduce, render, &depths, &reference);
            assert_pyramid(&what, &reference, &expected(reduce, render, &depths));
        }
    }
}

#[test]
fn the_cpu_reference_refuses_a_depth_image_of_the_wrong_size() {
    assert!(hiz::reference(HizReduce::Max, (4, 4), &[0.5; 15]).is_err());
    assert!(hiz::reference(HizReduce::Max, (0, 4), &[]).is_err());
}

#[test]
fn the_pyramid_holds_exactly_the_bytes_the_budget_registers_for_it() {
    let mut quality = Quality::off();
    quality.occlusion = true;
    for output in [(1920, 1080), (1280, 720), (127, 73), (1, 1)] {
        let input = BudgetInput::new(output, 1.0, SceneFormat::Rgba16Float, false);
        let registered: u64 = ledger(&quality, &input).entries().iter().filter(|e| e.kind == BudgetKind::Target && e.label == hiz::HIZ_LABEL).map(|e| e.bytes).sum();
        let base = hiz::base_size(output);
        let held: u64 = (0..hiz::mip_count(base)).map(|mip| hiz::level_size(base, mip)).map(|(w, h)| u64::from(w) * u64::from(h) * 4).sum();
        assert_eq!(held, registered, "{output:?}: the r32float chain's texels");
        // The pool's own estimate (a quarter per mip) never undercounts the chain it holds.
        assert!(hiz::target(output).bytes() >= held, "{output:?}");
    }
}

// --- GPU rows ---

/// Held by every GPU row: the cost row never shares the GPU with this file's other builds.
static GPU_ROWS: Mutex<()> = Mutex::new(());

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

/// Every mip as a grey `.ppm` (the farthest depth white), nearest-upscaled to the render size.
fn write_capture(name: &str, render: (u32, u32), pyramid: &[HizLevel]) {
    let Ok(dir) = std::env::var("GENEX_HIZ_CAPTURE_DIR") else { return };
    let dir = PathBuf::from(dir);
    std::fs::create_dir_all(&dir).expect("capture folder");
    for (mip, level) in pyramid.iter().enumerate() {
        let mut bytes = format!("P6\n{} {}\n255\n", render.0, render.1).into_bytes();
        for y in 0..render.1 {
            for x in 0..render.0 {
                let texel = level.at((x >> (mip + 1)).min(level.size.0 - 1), (y >> (mip + 1)).min(level.size.1 - 1));
                let grey = (texel.clamp(0.0, 1.0) * 255.0).round() as u8;
                bytes.extend([grey; 3]);
            }
        }
        std::fs::write(dir.join(format!("{name}-mip{mip}.ppm")), bytes).expect("capture written");
    }
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_hiz_build_matches_the_brute_force_pyramid_bit_for_bit_at_odd_sizes() {
    let _gpu_rows = GPU_ROWS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let Some(gpu) = gpu() else { return };
    // One node for every frame, so a frame whose size or convention changes rebuilds what it caches.
    let mut frames = Vec::new();
    for reduce in [HizReduce::Max, HizReduce::Min] {
        for (index, render) in std::iter::once(ODD).chain(EDGE_SIZES).enumerate() {
            frames.push(HizFrame { render, depths: depth_image(render, 31 + index as u32), reduce });
        }
    }
    // The same input twice in a row: the cached bind groups give the same pyramid.
    frames.push(frames[0].clone());
    let pyramids = hiz::hiz_pyramids(&gpu, &frames).expect("pyramids");
    assert_eq!(pyramids.len(), frames.len());
    for (frame, pyramid) in frames.iter().zip(&pyramids) {
        let what = format!("GPU {:?} {}x{}", frame.reduce, frame.render.0, frame.render.1);
        assert_conservative(&what, frame.reduce, frame.render, &frame.depths, pyramid);
        assert_pyramid(&what, pyramid, &expected(frame.reduce, frame.render, &frame.depths));
        assert_pyramid(&format!("{what} against the CPU reference"), pyramid, &hiz::reference(frame.reduce, frame.render, &frame.depths).expect("reference"));
    }
    write_capture("hiz-127x73-max", ODD, &pyramids[0]);
    write_capture("hiz-127x73-min", ODD, &pyramids[EDGE_SIZES.len() + 1]);
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_hiz_build_costs_within_its_budget_at_1080p() {
    let _gpu_rows = GPU_ROWS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let Some(gpu) = gpu() else { return };
    let render = (1920, 1080);
    let Some(mut costs) = hiz::hiz_gpu_ms(&gpu, render, COST_SAMPLES).expect("cost") else {
        eprintln!("skipped: no TIMESTAMP_QUERY");
        return;
    };
    assert!(!costs.is_empty(), "every sample resolved");
    costs.sort_by(f32::total_cmp);
    let p50 = costs[costs.len() / 2];
    let p95 = costs[(costs.len() * 95 / 100).min(costs.len() - 1)];
    eprintln!("hi-z build 1080p: p50 {p50:.4} ms, p95 {p95:.4} ms (budget {BUDGET_MS} ms)");
    if let Ok(path) = std::env::var("GENEX_PERF_OUT") {
        let report = serde_json::json!({
            "row": "hiz-cost", "adapter": gpu.receipt().adapter, "backend": gpu.receipt().backend, "samples": COST_SAMPLES,
            "builds_per_sample": hiz::COST_BUILDS_PER_SAMPLE, "render": [render.0, render.1], "mips": hiz::mip_count(hiz::base_size(render)),
            "p50_ms": p50, "p95_ms": p95, "budget_ms": BUDGET_MS,
            // R2 review: the run judges on p95. The p95 verdict is the record's; the test gates
            // p50 only (a shared machine's tail), and a p95 over budget is logged as missed.
            "within_budget": p95 <= BUDGET_MS, "within_budget_p50": p50 <= BUDGET_MS, "gate": "p50",
        });
        std::fs::write(path, serde_json::to_string_pretty(&report).expect("json")).expect("perf written");
    }
    assert!(p50 <= BUDGET_MS, "the Hi-Z build costs {p50} ms at 1080p, over {BUDGET_MS} ms");
}
