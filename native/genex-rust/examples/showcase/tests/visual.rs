//! Visual rows of the pass-1 gate (2026-10-11) on the bench and stress scenes, drawn through the
//! renderer as `perf_matrix`'s final captures draw them: each compares a region of a capture with
//! a reference drawn without the feature at fault, so a defect fails by its own measure.
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p showcase \
//!     --release --offline --locked --test visual -- --ignored metal --nocapture
//!
//! PNGs go to `GENEX_VISUAL_OUT` (default `pass1-gate/visual-rows` in the evidence folder).
mod support;

use std::path::PathBuf;

use genex_render::capture::Capture;
use genex_render::device_class::{DeviceClass, classify};
use genex_render::presets::{preset_quality, scene_format};
use genex_render::settings::{AoResolution, ExposureMode, Look, Quality, QualityPreset, Tonemapper};
use genex::math::Vec3;
use genex_render::{CullPath, Gpu, RenderOptions};
use showcase_game::bench::SceneId;
use showcase_game::stress::{self, StressId};

/// The evidence folder of these rows.
fn out_dir() -> PathBuf {
    let dir = std::env::var_os("GENEX_VISUAL_OUT").map_or_else(|| support::evidence_dir("pass1-gate/visual-rows"), PathBuf::from);
    std::fs::create_dir_all(&dir).expect("the captures folder");
    dir
}

/// The lakeside's look, as `perf_matrix` draws every HDR profile with it.
fn lakeside_look() -> Look {
    let mut look = Look::default();
    look.tonemapper = Tonemapper::KhronosNeutral;
    look.exposure = ExposureMode::Auto;
    look.ev_compensation = showcase_game::showcase::LOOK_EV_COMPENSATION;
    look
}

/// Bench scene `id` at `frame` drawn with `quality` on `class`, settled as `perf_matrix`'s final
/// captures settle (frame indices 0..K of the settle plan).
fn bench_capture(gpu: &Gpu, class: DeviceClass, id: SceneId, frame: u32, quality: &Quality) -> Capture {
    let options = RenderOptions { msaa: genex_render::renderer::landed_samples(quality.anti_aliasing) > 1 };
    let (mut renderer, scene) = support::bench_stage_with(gpu, id, support::SIZE, options);
    let rg11b10 = renderer.device_features().contains(wgpu::Features::RG11B10UFLOAT_RENDERABLE);
    renderer.set_quality(quality);
    renderer.set_scene_format(scene_format(class, rg11b10));
    renderer.set_look(lakeside_look());
    renderer.set_device_class(class);
    let settle = genex_render::settle::settle_frames(quality, renderer.look(), true);
    for step in 0..settle {
        renderer.set_frame_index(u64::from(step));
        renderer.render(gpu, &scene.scene(frame), CullPath::Gpu).expect("frame");
    }
    renderer.capture(gpu).expect("capture")
}

/// The Rec. 709 luma (0..255) of the pixel at (x, y).
fn luma(capture: &Capture, x: u32, y: u32) -> f64 {
    let i = ((y * capture.width() + x) * 4) as usize;
    let p = capture.bgra();
    0.0722 * f64::from(p[i]) + 0.7152 * f64::from(p[i + 1]) + 0.2126 * f64::from(p[i + 2])
}

/// A capture region: x, y, width, height.
type Region = [u32; 4];

/// The mean absolute luma difference of `a` and `b` over `region`.
fn mean_difference(a: &Capture, b: &Capture, region: Region) -> f64 {
    let [x0, y0, w, h] = region;
    let total: f64 = (y0..y0 + h).flat_map(|y| (x0..x0 + w).map(move |x| (x, y))).map(|(x, y)| (luma(a, x, y) - luma(b, x, y)).abs()).sum();
    total / f64::from(w * h)
}

/// The mean absolute difference of each pixel's luma from its four neighbours' mean over `region`:
/// the high-frequency energy a stipple adds.
fn speckle(capture: &Capture, region: Region) -> f64 {
    let [x0, y0, w, h] = region;
    let mut total = 0.0;
    for y in y0 + 1..y0 + h - 1 {
        for x in x0 + 1..x0 + w - 1 {
            let around = (luma(capture, x - 1, y) + luma(capture, x + 1, y) + luma(capture, x, y - 1) + luma(capture, x, y + 1)) / 4.0;
            total += (luma(capture, x, y) - around).abs();
        }
    }
    total / f64::from((w - 2) * (h - 2))
}

/// bench-outdoor's meadow shot: the lake's far side, where the transparent water sheet lies a
/// hand's breadth over the shallow lake bed (gate finding 01's crop).
const MEADOW_FAR_WATER: Region = [1000, 380, 270, 120];
/// How far the water may differ from the same preset without contact shadows, in luma levels.
const WATER_CONTACT_DIFFERENCE_MAX: f64 = 1.0;
/// How much more speckle the water may carry than without contact shadows.
const WATER_SPECKLE_EXCESS_MAX: f64 = 0.01;

/// Gate finding 01: "far-cascade PCSS shadows draw a blocky stipple on the meadow water at high
/// and ultra". The stipple was the screen-space contact shadow of the opaque lake bed under the
/// transparent water: the mask holds the opaque surface behind a blended one, as the AO map does,
/// so a blended surface must not take it. The water then matches the preset without contact
/// shadows, its sun shadows (the trees') kept.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_transparent_water_takes_no_contact_shadow_of_the_lake_bed_under_it() {
    let Some(gpu) = support::gpu() else { return };
    let class = classify(gpu.device_facts());
    let dir = out_dir();
    let mut problems = Vec::new();
    for preset in [QualityPreset::High, QualityPreset::Ultra] {
        let quality = preset_quality(preset, class);
        let mut without = quality;
        without.contact_shadows = false;
        let drawn = bench_capture(&gpu, class, SceneId::Outdoor, 0, &quality);
        let reference = bench_capture(&gpu, class, SceneId::Outdoor, 0, &without);
        support::write_png(&dir.join(format!("meadow-water-{}.png", preset.wire())), &drawn);
        support::write_png(&dir.join(format!("meadow-water-{}-no-contact.png", preset.wire())), &reference);
        let difference = mean_difference(&drawn, &reference, MEADOW_FAR_WATER);
        let excess = speckle(&drawn, MEADOW_FAR_WATER) - speckle(&reference, MEADOW_FAR_WATER);
        eprintln!("{}: water differs {difference:.3} levels, speckle excess {excess:.4}", preset.wire());
        if difference > WATER_CONTACT_DIFFERENCE_MAX || excess > WATER_SPECKLE_EXCESS_MAX {
            problems.push(format!("{}: the water differs {difference:.3} levels and carries {excess:.4} more speckle than without contact shadows", preset.wire()));
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
}


/// The mean of each channel (r, g, b) of `capture`, 0..255.
fn mean_rgb(capture: &Capture) -> [f64; 3] {
    let mut sum = [0.0; 3];
    for p in capture.bgra().chunks(4) {
        sum[0] += f64::from(p[2]);
        sum[1] += f64::from(p[1]);
        sum[2] += f64::from(p[0]);
    }
    let pixels = (capture.bgra().len() / 4) as f64;
    sum.map(|channel| channel / pixels)
}

/// The least share of `off`'s red-to-green and blue-to-green ratios a preset keeps: the forest's
/// browns and blue-grey shade may not collapse into one green (gate: 3/36/6 against off's 24/45/27).
const FOREST_HUE_SHARE_MIN: f64 = 0.5;
/// The least share of `off`'s mean luma a preset keeps (gate: 26.7 against 39.1).
const FOREST_LUMA_SHARE_MIN: f64 = 0.8;

/// Gate finding 07: stress-forest under every feature preset was near-black, monochrome green
/// against off. Drawn as a game draws it (auto exposure metered), each preset keeps the forest's
/// colours and at least most of off's brightness.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_stress_forest_keeps_its_colours_and_light_at_every_preset() {
    let Some(gpu) = support::gpu() else { return };
    let class = classify(gpu.device_facts());
    let dir = out_dir();
    let load = |meshes: &mut support::OnGpu<'_>| stress::load(StressId::Forest, meshes).expect("the forest loads").scene(0);
    let off = support::game_capture(&gpu, class, None, &lakeside_look(), &load);
    support::write_png(&dir.join("stress-forest-off.png"), &off);
    let [r, g, b] = mean_rgb(&off);
    let off_luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let mut problems = Vec::new();
    for preset in [QualityPreset::Low, QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra] {
        let capture = support::game_capture(&gpu, class, Some(&preset_quality(preset, class)), &lakeside_look(), &load);
        support::write_png(&dir.join(format!("stress-forest-{}.png", preset.wire())), &capture);
        let [pr, pg, pb] = mean_rgb(&capture);
        let luma = 0.2126 * pr + 0.7152 * pg + 0.0722 * pb;
        let hue = [(pr / pg) / (r / g), (pb / pg) / (b / g)];
        eprintln!("{}: mean rgb [{pr:.1}, {pg:.1}, {pb:.1}] (off [{r:.1}, {g:.1}, {b:.1}]), luma {luma:.1} (off {off_luma:.1})", preset.wire());
        if hue.iter().any(|share| *share < FOREST_HUE_SHARE_MIN) || luma < FOREST_LUMA_SHARE_MIN * off_luma {
            problems.push(format!("{}: mean rgb [{pr:.1}, {pg:.1}, {pb:.1}] luma {luma:.1} against off's [{r:.1}, {g:.1}, {b:.1}] {off_luma:.1}", preset.wire()));
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
}

/// The stress forest's open ground in front of the trunks (the frame's lower part, clear of
/// trunks and canopy), and its bottom rows, where the horizon search's samples run off screen.
const FOREST_GROUND: Region = [300, 560, 600, 140];
const FOREST_BOTTOM_EDGE: Region = [0, 716, 1280, 4];
/// The most open flat ground's luma may vary (standard deviation, 0..255 levels) at any AO preset,
/// and the most any bottom-edge pixel may sit below the ground's mean. Gate finding 03: medium's
/// AO drew a mottle (sd 1.84, against high's 0.97 and low's 0.21) and dark dots along the bottom
/// edge (down to 120 against a mean of 153).
const FOREST_GROUND_SPREAD_MAX: f64 = 0.8;
const FOREST_EDGE_DIP_MAX: f64 = 4.0;
/// The open ground left of the first trunk, at the trunk's own distance and clear of its base
/// (pass-1 fix gate, visual RED 01): medium drew a dotted streak of false occlusion running left
/// from the trunk's base across it (14.5% of its pixels more than 3 levels under its median),
/// higher up than [`FOREST_GROUND`] reads. A fold of the rolling ground crosses it, which a
/// converged estimate darkens too, so it is read against one ([`converged_ao`]).
const FOREST_MID_GROUND: Region = [0, 480, 150, 90];
/// Levels under the converged estimate that make a pixel a dot of false occlusion, and the share
/// of such dots the mid ground may hold at any AO preset.
const FALSE_OCCLUSION_LEVELS: f64 = 3.0;
const FOREST_MID_FALSE_OCCLUSION_SHARE_MAX: f64 = 0.01;
/// The converged estimate's slices and steps per slice, at full resolution without history.
const CONVERGED_SLICES: u8 = 16;
const CONVERGED_STEPS: u8 = 8;

/// The mean, standard deviation and least luma (0..255) of `capture` over `region`.
fn luma_stats(capture: &Capture, region: Region) -> (f64, f64, f64) {
    let [x0, y0, w, h] = region;
    let lumas: Vec<f64> = (y0..y0 + h).flat_map(|y| (x0..x0 + w).map(move |x| (x, y))).map(|(x, y)| luma(capture, x, y)).collect();
    let mean = lumas.iter().sum::<f64>() / lumas.len() as f64;
    let spread = (lumas.iter().map(|l| (l - mean) * (l - mean)).sum::<f64>() / lumas.len() as f64).sqrt();
    (mean, spread, lumas.iter().copied().fold(f64::MAX, f64::min))
}

/// `quality` with its AO converged: full resolution, [`CONVERGED_SLICES`] x [`CONVERGED_STEPS`],
/// no history (each pixel measures the hemisphere on its own), every other feature unchanged.
fn converged_ao(quality: &Quality) -> Quality {
    let mut converged = *quality;
    converged.ao.resolution = AoResolution::Full;
    converged.ao.slices = CONVERGED_SLICES;
    converged.ao.steps = CONVERGED_STEPS;
    converged.ao.temporal = false;
    converged
}

/// The share of `capture`'s pixels in `region` more than [`FALSE_OCCLUSION_LEVELS`] darker than
/// `reference`'s: the dots false occlusion darkens.
fn false_occlusion_share(capture: &Capture, reference: &Capture, region: Region) -> f64 {
    let [x0, y0, w, h] = region;
    let darker = (y0..y0 + h).flat_map(|y| (x0..x0 + w).map(move |x| (x, y))).filter(|&(x, y)| luma(reference, x, y) - luma(capture, x, y) > FALSE_OCCLUSION_LEVELS).count();
    darker as f64 / f64::from(w * h)
}

/// Gate finding 03: at the look's default AO intensity, medium's AO (one slice, half resolution,
/// no history) drew blocky false occlusion over the stress forest's open flat ground and dark dots
/// along the bottom edge. At every AO preset the ground reads flat (luma standard deviation at most
/// [`FOREST_GROUND_SPREAD_MAX`]) and the bottom edge carries no dots (no pixel more than
/// [`FOREST_EDGE_DIP_MAX`] levels under the ground's mean), and the mid ground beside the first
/// trunk carries no dots of false occlusion (at most [`FOREST_MID_FALSE_OCCLUSION_SHARE_MAX`] of
/// its pixels darker than the converged estimate's by [`FALSE_OCCLUSION_LEVELS`]).
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_stress_forests_open_ground_reads_flat_at_every_ao_preset() {
    let Some(gpu) = support::gpu() else { return };
    let class = classify(gpu.device_facts());
    let dir = out_dir();
    let load = |meshes: &mut support::OnGpu<'_>| stress::load(StressId::Forest, meshes).expect("the forest loads").scene(0);
    let mut problems = Vec::new();
    for preset in [QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra] {
        let quality = preset_quality(preset, class);
        let capture = support::game_capture(&gpu, class, Some(&quality), &lakeside_look(), &load);
        let converged = support::game_capture(&gpu, class, Some(&converged_ao(&quality)), &lakeside_look(), &load);
        support::write_png(&dir.join(format!("forest-ground-{}.png", preset.wire())), &capture);
        support::write_png(&dir.join(format!("forest-ground-{}-converged-ao.png", preset.wire())), &converged);
        let (mean, spread, _) = luma_stats(&capture, FOREST_GROUND);
        let (_, _, edge_least) = luma_stats(&capture, FOREST_BOTTOM_EDGE);
        let false_occlusion = false_occlusion_share(&capture, &converged, FOREST_MID_GROUND);
        eprintln!(
            "{}: ground luma mean {mean:.1}, standard deviation {spread:.2}; bottom edge least {edge_least:.0}; mid ground false occlusion {:.2}%",
            preset.wire(),
            false_occlusion * 100.0
        );
        if spread > FOREST_GROUND_SPREAD_MAX || mean - edge_least > FOREST_EDGE_DIP_MAX {
            problems.push(format!("{}: ground luma sd {spread:.2}, bottom edge down to {edge_least:.0} against {mean:.1}", preset.wire()));
        }
        if false_occlusion > FOREST_MID_FALSE_OCCLUSION_SHARE_MAX {
            problems.push(format!("{}: mid ground {:.2}% of pixels darker than the converged AO's", preset.wire(), false_occlusion * 100.0));
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
}

/// Live frames each shimmer row draws, and the last ones it compares (each with the next).
const SHIMMER_FRAMES: u32 = 48;
const SHIMMER_COMPARED: u32 = 12;
/// How far the camera creeps sideways each frame, in pixels at [`SHIMMER_DEPTH`] metres: slow
/// enough that the picture itself barely moves, so what changes from frame to frame is what the
/// camera's motion stirs (shadow cascades refitting, foliage aliasing), not the motion.
const SHIMMER_STEP_PX: f32 = 0.02;
const SHIMMER_DEPTH: f32 = 20.0;
/// The luma change (0..255) above which a pixel counts as flickering between two frames: past the
/// tonemap's frame-keyed dither (half a level).
const FLICKER_LEVELS: f64 = 3.0;
/// The most a creeping camera may add to the share of pixels flickering between frames over the
/// still camera's (TAA's own edge noise at high and ultra, about 0.4%). Measured on the M4 Max:
/// +0.05% to +0.17%; the cascades fitted without texel snapping (a control) add +0.20% at low.
const SHIMMER_ADDED_SHARE_MAX: f64 = 0.005;

/// The most pixels that may flicker between consecutive Live frames of a still camera (pass-1 gate
/// finding 05: TAA's edges flickered on 1.28% at high and 1.51% at ultra, MSAA's on none; gate
/// finding 04 after that fix: 0.356% and 0.420%, the still lake's reactive shore and the trees
/// standing in it, grass tufts and far tree tops against the sky). TAA leaves some sub-pixel
/// grass and silhouette noise under a still camera; measured after the finding 04 fix (still
/// transparents accumulate, still pixels average over twice as many frames): 0.086% and 0.103%.
const STILL_FLICKER_SHARE_MAX: f64 = 0.0015;

/// The share of pixels whose luma changes by more than [`FLICKER_LEVELS`] between two captures.
fn flicker_share(a: &Capture, b: &Capture) -> f64 {
    let la = |p: &[u8]| 0.0722 * f64::from(p[0]) + 0.7152 * f64::from(p[1]) + 0.2126 * f64::from(p[2]);
    let pairs = a.bgra().chunks(4).zip(b.bgra().chunks(4));
    let flickering = pairs.filter(|(p, q)| (la(p) - la(q)).abs() > FLICKER_LEVELS).count();
    flickering as f64 / (a.bgra().len() / 4) as f64
}

/// Live frames of bench-outdoor under `quality` with the camera creeping `step` world units
/// sideways a frame: the mean flicker share between consecutive frames at the end of the run.
fn creeping_flicker(gpu: &Gpu, class: DeviceClass, quality: &Quality, step: f32) -> (f64, Capture) {
    use genex_render::FrameRenderer;
    use genex_render::immediate::ImmediateFrame;
    let options = RenderOptions { msaa: genex_render::renderer::landed_samples(quality.anti_aliasing) > 1 };
    let mut frames = FrameRenderer::new(gpu, support::SIZE[0], support::SIZE[1], options).expect("frame renderer");
    let loaded = showcase_game::bench::load(SceneId::Outdoor, &mut support::OnGpu { renderer: frames.renderer_mut(), gpu }).expect("the scene loads");
    let renderer = frames.renderer_mut();
    let rg11b10 = renderer.device_features().contains(wgpu::Features::RG11B10UFLOAT_RENDERABLE);
    renderer.set_quality(quality);
    renderer.set_scene_format(scene_format(class, rg11b10));
    renderer.set_look(lakeside_look());
    renderer.set_device_class(class);
    let base = loaded.scene(0);
    let forward = Vec3::from(base.camera.target) - Vec3::from(base.camera.eye);
    let side = forward.cross(Vec3::Y).normalize();
    let mut kept = Vec::new();
    for k in 0..SHIMMER_FRAMES {
        let mut drawn = base.clone();
        let offset = side * step * k as f32;
        drawn.camera.eye = (Vec3::from(drawn.camera.eye) + offset).to_array();
        drawn.camera.target = (Vec3::from(drawn.camera.target) + offset).to_array();
        let mut frame = ImmediateFrame::from_scene(drawn);
        frame.set_tick(u64::from(k));
        frames.render(gpu, &frame, CullPath::Gpu, None).expect("a Live frame");
        if k >= SHIMMER_FRAMES - SHIMMER_COMPARED {
            kept.push(frames.capture(gpu).expect("capture"));
        }
    }
    let pairs = kept.len() - 1;
    let share = (0..pairs).map(|i| flicker_share(&kept[i], &kept[i + 1])).sum::<f64>() / pairs as f64;
    (share, flicker_map(&kept))
}

/// Where `frames` flicker: the last frame, with every pixel that flickers between any two
/// consecutive frames painted magenta (the evidence that locates a flicker share).
fn flicker_map(frames: &[Capture]) -> Capture {
    let la = |p: &[u8]| 0.0722 * f64::from(p[0]) + 0.7152 * f64::from(p[1]) + 0.2126 * f64::from(p[2]);
    let last = frames.last().expect("a frame");
    let mut bgra = last.bgra().to_vec();
    for pair in frames.windows(2) {
        for (i, (p, q)) in pair[0].bgra().chunks(4).zip(pair[1].bgra().chunks(4)).enumerate() {
            if (la(p) - la(q)).abs() > FLICKER_LEVELS {
                bgra[i * 4..i * 4 + 4].copy_from_slice(&[255, 0, 255, 255]);
            }
        }
    }
    Capture::new(last.width(), last.height(), bgra).expect("a capture of the same size")
}

/// Gate visual finding: camera-motion shimmer of shadows and foliage was not proven. bench-outdoor
/// (trees, rocks, their shadows over the meadow) drawn Live while the camera creeps sideways by a
/// fiftieth of a pixel a frame: the share of pixels flickering from frame to frame stays within
/// half a percent of the still camera's, and the still camera's within [`STILL_FLICKER_SHARE_MAX`],
/// at every preset. Each run writes where the pixels flicker (`shimmer-*.png`, magenta).
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_creeping_camera_leaves_shadows_and_foliage_steady_at_every_preset() {
    let Some(gpu) = support::gpu() else { return };
    let class = classify(gpu.device_facts());
    let probe = support::bench_stage_with(&gpu, SceneId::Outdoor, [8, 8], RenderOptions::default()).1.scene(0);
    let pixel_at_depth = 2.0 * SHIMMER_DEPTH * genex::math::tan(probe.camera.fovy_degrees.to_radians() * 0.5) / support::SIZE[1] as f32;
    let step = SHIMMER_STEP_PX * pixel_at_depth;
    let mut problems = Vec::new();
    let mut rows = Vec::new();
    for preset in [QualityPreset::Low, QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra] {
        let quality = preset_quality(preset, class);
        let (still, still_map) = creeping_flicker(&gpu, class, &quality, 0.0);
        let (creeping, creeping_map) = creeping_flicker(&gpu, class, &quality, step);
        support::write_png(&out_dir().join(format!("shimmer-still-{}.png", preset.wire())), &still_map);
        support::write_png(&out_dir().join(format!("shimmer-creeping-{}.png", preset.wire())), &creeping_map);
        let added = creeping - still;
        rows.push(format!("{{\"preset\": \"{}\", \"stillShare\": {still:.5}, \"creepingShare\": {creeping:.5}}}", preset.wire()));
        eprintln!("{}: {:.3}% of pixels flicker still, {:.3}% creeping", preset.wire(), still * 100.0, creeping * 100.0);
        if still > STILL_FLICKER_SHARE_MAX {
            problems.push(format!("{}: {:.3}% of pixels flicker under a still camera", preset.wire(), still * 100.0));
        }
        if added > SHIMMER_ADDED_SHARE_MAX {
            problems.push(format!("{}: a creeping camera makes {:.3}% more pixels flicker ({:.3}% -> {:.3}%)", preset.wire(), added * 100.0, still * 100.0, creeping * 100.0));
        }
    }
    let record = format!("{{\"stepPx\": {SHIMMER_STEP_PX}, \"depth\": {SHIMMER_DEPTH}, \"flickerLevels\": {FLICKER_LEVELS}, \"rows\": [{}]}}\n", rows.join(", "));
    std::fs::write(out_dir().join("shimmer.json"), record).expect("record");
    assert!(problems.is_empty(), "{problems:#?}");
}

/// bench-materials' front shot: the walking blue figure in the foreground, its sun shadow falling
/// up and to the right over the floor from its feet.
const FIGURE: Region = [200, 420, 300, 300];
/// The figure's legs and feet: its pixels in the region's rows from here down.
const FIGURE_FEET_FROM_ROW: u32 = 600;
/// A pixel is the blue figure's when its blue exceeds its red by this much and its green by half of it.
const FIGURE_BLUE_OVER_RED: i32 = 60;
/// A floor pixel is in the sun's shadow when it reads below this share of its luma with sun shadows off.
const SHADOWED_RATIO: f64 = 0.6;
/// How close to the figure's legs and feet a shadowed floor pixel counts as their shadow, pixels.
const FIGURE_CONTACT_REACH: f64 = 12.0;
/// The least share of `high`'s leg shadow (the shadowed floor pixels within
/// [`FIGURE_CONTACT_REACH`] of the legs) every preset and phone class keeps. Gate finding 01: at
/// desktop `low` the shadow stood about 30 px off the feet and kept 9% of it (32 pixels against
/// 366), the legs washed out of 8 cm shadow texels; mobile-mid and mobile-low kept a third.
const FIGURE_CONTACT_SHARE_MIN: f64 = 0.6;

/// Whether the pixel at `(x, y)` is the blue figure's.
fn figure_pixel(capture: &Capture, x: u32, y: u32) -> bool {
    let i = ((y * capture.width() + x) * 4) as usize;
    let p = capture.bgra();
    let (b, g, r) = (i32::from(p[i]), i32::from(p[i + 1]), i32::from(p[i + 2]));
    b - r >= FIGURE_BLUE_OVER_RED && b - g >= FIGURE_BLUE_OVER_RED / 2
}

/// The figure's leg shadow in `capture`: the floor pixels of [`FIGURE`] within
/// [`FIGURE_CONTACT_REACH`] of its legs and feet that the sun's shadow darkens below
/// [`SHADOWED_RATIO`] of `reference` (the same drawing with sun shadows off).
fn figure_leg_shadow(capture: &Capture, reference: &Capture) -> usize {
    let [x0, y0, w, h] = FIGURE;
    let pixels: Vec<(u32, u32)> = (y0..y0 + h).flat_map(|y| (x0..x0 + w).map(move |x| (x, y))).collect();
    let feet: Vec<(u32, u32)> = pixels.iter().copied().filter(|&(x, y)| y >= FIGURE_FEET_FROM_ROW && figure_pixel(reference, x, y)).collect();
    assert!(feet.len() > 200, "the figure's legs cover {} pixels", feet.len());
    let near_feet = |(x, y): (u32, u32)| feet.iter().any(|&(fx, fy)| f64::from(x.abs_diff(fx)).hypot(f64::from(y.abs_diff(fy))) <= FIGURE_CONTACT_REACH);
    pixels
        .into_iter()
        .filter(|&(x, y)| !figure_pixel(reference, x, y) && luma(capture, x, y) < SHADOWED_RATIO * luma(reference, x, y))
        .filter(|&at| near_feet(at))
        .count()
}

/// Gate finding 01: at desktop `low` the bench figure's sun shadow stood about 30 px off its feet
/// (and the template block's off its base). At every preset and phone class the shadow starts at
/// the figure's legs as `high`'s does, against the same drawing with sun shadows off.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_bench_figures_shadow_starts_at_its_feet_at_every_preset_and_phone_class() {
    use genex_render::device_class::{FormFactor, PerformanceTier};
    use genex_render::presets::class_defaults;
    let Some(gpu) = support::gpu() else { return };
    let desktop = classify(gpu.device_facts());
    let mobile = |tier| DeviceClass::new(FormFactor::Mobile, tier);
    let mut drawn: Vec<(String, DeviceClass, Quality)> =
        [QualityPreset::High, QualityPreset::Low, QualityPreset::Medium, QualityPreset::Ultra].map(|preset| (String::from(preset.wire()), desktop, preset_quality(preset, desktop))).into();
    for class in [mobile(PerformanceTier::High), mobile(PerformanceTier::Mid), mobile(PerformanceTier::Low)] {
        drawn.push((class.wire(), class, preset_quality(class_defaults(class).preset, class)));
    }
    let mut legs = Vec::new();
    for (label, class, quality) in drawn {
        let mut unshadowed = quality;
        unshadowed.shadows.enabled = false;
        unshadowed.contact_shadows = false;
        let capture = bench_capture(&gpu, class, SceneId::Materials, 0, &quality);
        let reference = bench_capture(&gpu, class, SceneId::Materials, 0, &unshadowed);
        support::write_png(&out_dir().join(format!("figure-contact-{label}.png")), &capture);
        support::write_png(&out_dir().join(format!("figure-contact-{label}-unshadowed.png")), &reference);
        let shadow = figure_leg_shadow(&capture, &reference);
        eprintln!("{label}: {shadow} shadowed pixels at the figure's legs");
        legs.push((label, shadow));
    }
    let high = legs[0].1 as f64;
    let problems: Vec<String> = legs
        .iter()
        .filter(|(_, shadow)| (*shadow as f64) < high * FIGURE_CONTACT_SHARE_MIN)
        .map(|(label, shadow)| format!("{label}: {shadow} shadowed pixels at the figure's legs against high's {high}"))
        .collect();
    assert!(problems.is_empty(), "{problems:#?}");
}
