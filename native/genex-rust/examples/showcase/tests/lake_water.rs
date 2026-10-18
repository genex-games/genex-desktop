//! Renderer pass 2 B.3 on the showcase: the Lakeside lake is the renderer's water (`frame.water`),
//! drawn in the golden-wide, shore and dock shots at golden hour and the golden-wide shot at night,
//! as Studio's capture draws them at `high` (the HUD hidden).
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p showcase --release \
//!     --offline --locked --test lake_water -- --ignored metal --test-threads=1 --nocapture
//!
//! They write `lake-<shot>-<time>.png` into `GENEX_SHOWCASE_OUT` (default
//! `.studio-dev/evidence/rust-renderer/captures/latest`).

mod support;

use genex::math::{Vec3, vec3};
use genex::present::Presenter;
use genex::render::{PresetChoice, RenderChange};
use genex::{Camera, FIXED_STEP_MS, Input, Key, Runtime, View};
use genex_render::capture::Capture;
use genex_render::settings::QualityPreset;
use showcase_game::layout::{LAKE_CENTER, LAKE_RADII, WATER_LEVEL, height, lake_radius};
use support::{SHOT_TICK, gpu, out_dir, write_png};

/// The world target's aspect (1280x720).
const ASPECT: f32 = 16.0 / 9.0;
/// The shots the lake is looked at in, and N taps from the golden hour (1: the moonlit night).
const SHOTS: [(&str, u32, &str); 4] = [("golden-wide", 0, "dusk"), ("shore", 0, "dusk"), ("dock", 0, "dusk"), ("golden-wide", 1, "night")];
/// Thicker than any segment of the fisher's line (and thinner than his rod), m.
const LINE_SEGMENT_MAX_M: f32 = 0.03;
/// Lake points sampled per side of the lake's bounds for the water mask.
const MASK_SAMPLES: u32 = 160;
/// The shots the forest-lake row looks at the water in: the near water at golden hour and at night.
const FOREST_SHOTS: [(&str, u32, &str); 3] = [("dock", 0, "dusk"), ("shore", 0, "dusk"), ("shore", 1, "night")];
/// The most of a shot's lake pixels that may read turquoise (`teal`): a forest lake's humic water
/// is olive to tea-brown and dark where deep; only a reflected blue sky is blue (look fix WATER:
/// the dock shot had 21% of its near water turquoise at golden hour, the shore 50% at night).
const TEAL_SHARE_MAX: f64 = 0.02;
/// Below this many pixels a shot does not show the lake.
const WATER_PIXELS_MIN: usize = 2_000;

fn settled(shot: &str, n_taps: u32) -> Option<Capture> {
    let mut presenter = Presenter::open(showcase_game::showcase::WORLD_SIZE, showcase_game::assets()).ok()?;
    let _ = showcase_game::assets();
    let mut runtime = Runtime::new(showcase_game::game()).expect("the lakeside installs");
    runtime.seed(1);
    runtime.start();
    runtime.inject(Input::key_tap(Key::KeyH));
    for _ in 0..n_taps {
        runtime.inject(Input::key_tap(Key::KeyN));
        runtime.step(FIXED_STEP_MS);
    }
    runtime.step(f64::from(SHOT_TICK - n_taps) * FIXED_STEP_MS);
    assert!(presenter.install_for(&mut runtime).is_empty(), "every pass installs");
    presenter.set_capturing(true);
    // The first draw attaches the game's settings; the shot is drawn again at `high`.
    presenter.draw_view(&mut runtime, View::Named(shot)).expect("a view").expect("drawn");
    let change = RenderChange { preset: Some(Some(PresetChoice::Preset(QualityPreset::High))), ..RenderChange::default() };
    presenter.render_settings().expect("the game's settings attached").borrow_mut().apply(&change);
    presenter.draw_view(&mut runtime, View::Named(shot)).expect("a view").expect("drawn");
    Some(presenter.resilient.capture().expect("capture"))
}

/// Where `point` lands on `camera`'s 1280x720 picture (0..1, y down), if in front of it.
fn on_picture(camera: &Camera, point: Vec3) -> Option<(f32, f32)> {
    let forward = (camera.target - camera.position).normalize();
    let right = forward.cross(Vec3::Y).normalize();
    let up = right.cross(forward);
    let dir = point - camera.position;
    let depth = dir.dot(forward);
    if depth <= 0.0 {
        return None;
    }
    let half = genex::math::tan(camera.fovy.to_radians() * 0.5);
    let (x, y) = (dir.dot(right) / depth / (half * ASPECT), dir.dot(up) / depth / half);
    ((-1.0..=1.0).contains(&x) && (-1.0..=1.0).contains(&y)).then_some(((x + 1.0) * 0.5, (1.0 - y) * 0.5))
}

/// The pixels of `capture` where the lake's open water (inside the shoreline, its bed under the
/// level) lies on `camera`'s picture: an outline from sampled lake points, not occlusion-tested.
fn water_mask(capture: &Capture, camera: &Camera) -> Vec<bool> {
    let (w, h) = (capture.width() as usize, capture.height() as usize);
    let mut mask = vec![false; w * h];
    let reach = LAKE_RADII * 1.35;
    for i in 0..=MASK_SAMPLES {
        for j in 0..=MASK_SAMPLES {
            let x = LAKE_CENTER.x - reach.x + 2.0 * reach.x * i as f32 / MASK_SAMPLES as f32;
            let z = LAKE_CENTER.y - reach.y + 2.0 * reach.y * j as f32 / MASK_SAMPLES as f32;
            if lake_radius(x, z) > 0.95 || height(x, z) >= WATER_LEVEL - 0.05 {
                continue;
            }
            if let Some((u, v)) = on_picture(camera, vec3(x, WATER_LEVEL, z)) {
                let (px, py) = (((u * w as f32) as usize).min(w - 1), ((v * h as f32) as usize).min(h - 1));
                mask[py * w + px] = true;
            }
        }
    }
    mask
}

/// Every pixel of `capture` whose view ray meets the lake's open water (inside the shoreline, its
/// bed under the level) on `camera`'s picture: dense where [`water_mask`] samples lake points, so
/// the near water counts by its share of the picture. Not occlusion-tested.
fn water_pixels(capture: &Capture, camera: &Camera) -> Vec<bool> {
    let (w, h) = (capture.width() as usize, capture.height() as usize);
    let forward = (camera.target - camera.position).normalize();
    let right = forward.cross(Vec3::Y).normalize();
    let up = right.cross(forward);
    let half = genex::math::tan(camera.fovy.to_radians() * 0.5);
    let mut mask = vec![false; w * h];
    for (i, kept) in mask.iter_mut().enumerate() {
        let x = ((i % w) as f32 + 0.5) / w as f32 * 2.0 - 1.0;
        let y = 1.0 - ((i / w) as f32 + 0.5) / h as f32 * 2.0;
        let dir = forward + right * (x * half * ASPECT) + up * (y * half);
        if dir.y >= -1e-4 {
            continue;
        }
        let hit = camera.position + dir * ((WATER_LEVEL - camera.position.y) / dir.y);
        *kept = lake_radius(hit.x, hit.z) <= 0.95 && height(hit.x, hit.z) < WATER_LEVEL - 0.05;
    }
    mask
}

/// Mean BGRA-decoded sRGB of the masked pixels.
fn masked_mean(capture: &Capture, mask: &[bool]) -> [f64; 3] {
    let mut sum = [0.0; 3];
    let mut n = 0.0_f64;
    for (p, kept) in capture.bgra().chunks(4).zip(mask) {
        if *kept {
            sum = [sum[0] + f64::from(p[2]), sum[1] + f64::from(p[1]), sum[2] + f64::from(p[0])];
            n += 1.0;
        }
    }
    sum.map(|s| s / n.max(1.0))
}

/// Look fix WATER (2026-10-18): the fisher's line over the lake is geometry, never an immediate
/// line. An immediate line writes no depth, so the water drew over it and refracted it from the
/// opaque copy (a saturated zigzag across the lake at night, a dark squiggle at dusk), it was
/// unlit (bright at night) and a one-pixel line list has no anti-aliasing (D22). As thin cylinders
/// it is in the prepass's depth (the water neither covers nor refracts it), lit by the scene, and
/// at least about a pixel wide, so TAA resolves it as a smooth thread.
#[test]
fn the_fishers_line_is_lit_geometry_the_water_sees_not_an_immediate_line() {
    use genex::Shape;
    use genex_render::motion::DrawId;
    let _ = showcase_game::assets();
    let mut runtime = Runtime::new(showcase_game::game()).expect("the lakeside installs");
    runtime.seed(1);
    runtime.start();
    runtime.step(60.0 * FIXED_STEP_MS);
    let fisher = DrawId::from_key("fisher");
    for shot in showcase_game::world::named_shots() {
        let frame = runtime.frame(View::Named(shot.name)).expect("its frame");
        let ours: Vec<_> = frame.draws().iter().filter(|draw| draw.id == Some(fisher)).collect();
        assert!(!ours.is_empty(), "{}: the fisher is drawn", shot.name);
        let lines = ours.iter().filter(|draw| matches!(draw.shape, Shape::Line { .. })).count();
        assert_eq!(lines, 0, "{}: the fisher's line is no immediate line", shot.name);
        // The rod is 36 mm across; the line's segments are the thinner models.
        let segments = ours.iter().filter(|draw| matches!(&draw.shape, Shape::Model { transform, .. } if transform.scale.x < LINE_SEGMENT_MAX_M)).count();
        // Far away a line is not seen (its segments are left out); the dock shot looks at it.
        let near = shot.name == "dock";
        assert!(!near || segments >= 4, "{}: the line hangs in segments of geometry ({segments})", shot.name);
    }
}

/// Whether an sRGB pixel reads turquoise: a hue between green-cyan and cyan (150-195 degrees),
/// saturated (above 0.25) and not black (value above 0.12).
fn teal(rgb: [u8; 3]) -> bool {
    let [r, g, b] = rgb.map(|c| f32::from(c) / 255.0);
    let (hi, lo) = (r.max(g).max(b), r.min(g).min(b));
    if hi <= 0.12 || hi - lo <= 0.25 * hi {
        return false;
    }
    let chroma = hi - lo;
    let hue = if hi == r {
        60.0 * ((g - b) / chroma).rem_euclid(6.0)
    } else if hi == g {
        60.0 * ((b - r) / chroma + 2.0)
    } else {
        60.0 * ((r - g) / chroma + 4.0)
    };
    (150.0..=195.0).contains(&hue)
}

/// Look fix WATER (2026-10-18): the Lakeside's lake reads as a forest lake, not a tropical pool:
/// in the dock and shore shots at golden hour and on the shore at night at most `TEAL_SHARE_MAX` of
/// the lake's pixels are turquoise. The water's body was lit by the flat ambient (constant, far
/// brighter than the moonlit sky the scene is lit by) and its absorption and scatter were teal.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_lakeside_lake_reads_as_a_forest_lake_by_day_and_night() {
    if gpu().is_none() {
        return;
    }
    let dir = out_dir();
    let mut problems = Vec::new();
    for (shot, taps, time) in FOREST_SHOTS {
        let camera = showcase_game::world::named_shots().find(|s| s.name == shot).expect("the shot").camera();
        let capture = settled(shot, taps).expect("a presenter");
        write_png(&dir.join(format!("forest-lake-{shot}-{time}.png")), &capture);
        let mask = water_pixels(&capture, &camera);
        let (mut lake, mut turquoise) = (0_usize, 0_usize);
        for (p, kept) in capture.bgra().chunks(4).zip(&mask) {
            if *kept {
                lake += 1;
                turquoise += usize::from(teal([p[2], p[1], p[0]]));
            }
        }
        let share = turquoise as f64 / lake.max(1) as f64;
        println!("forest lake {shot} {time}: {turquoise} of {lake} lake pixels turquoise ({:.2}%)", share * 100.0);
        if share > TEAL_SHARE_MAX {
            problems.push(format!("{shot} {time}: {:.2}% of the lake is turquoise", share * 100.0));
        }
    }
    assert!(problems.is_empty(), "{problems:#?}");
}

/// Each shot draws the lake (the renderer's water) where the lake lies, a finite picture with the
/// lake's pixels neither black nor clipped, and records its colour (the PNGs are looked at).
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_lakeside_lake_is_the_renderers_water_in_its_shots() {
    if gpu().is_none() {
        return;
    }
    let dir = out_dir();
    for (shot, taps, time) in SHOTS {
        let camera = showcase_game::world::named_shots().find(|s| s.name == shot).expect("the shot").camera();
        let capture = settled(shot, taps).expect("a presenter");
        write_png(&dir.join(format!("lake-{shot}-{time}.png")), &capture);
        let mask = water_mask(&capture, &camera);
        let pixels = mask.iter().filter(|kept| **kept).count();
        let mean = masked_mean(&capture, &mask);
        println!("lake {shot} {time}: {pixels} lake sample pixels, mean sRGB {:.1} {:.1} {:.1}", mean[0], mean[1], mean[2]);
        if shot != "dock" {
            assert!(pixels >= WATER_PIXELS_MIN / 10, "{shot}: the lake is in the shot ({pixels} sampled pixels)");
        }
        let luma = 0.2126 * mean[0] + 0.7152 * mean[1] + 0.0722 * mean[2];
        assert!(luma > 2.0 && luma < 250.0, "{shot} {time}: the lake is neither black nor clipped ({luma:.1})");
    }
}
