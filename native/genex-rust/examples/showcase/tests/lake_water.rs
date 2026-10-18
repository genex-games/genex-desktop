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
/// Lake points sampled per side of the lake's bounds for the water mask.
const MASK_SAMPLES: u32 = 160;
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
