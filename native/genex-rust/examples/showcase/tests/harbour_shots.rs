//! Harbour Street's five fixed shots (renderer pass 2, A.13 blockout) captured on the host GPU (Metal
//! on the Mac) the way the Studio captures them: genex's presenter on its own device with the
//! game's look (AgX punchy, auto exposure, the damp air's fog, bloom), a settled capture at tick 600
//! (ten seconds after seed 1). Each shot is drawn twice to one digest, written as
//! `harbour-<shot>.png`, held to a sane exposure (not black, not blown), and its digest to the
//! committed per-adapter row (`GENEX_RENDER_GOLDEN_UPDATE=1` rewrites this adapter's row). The scene
//! draws its fetched CC0 scans where the asset cache holds them (`GENEX_SHOWCASE_FETCHED=0` draws
//! its untextured stand-ins); each is its own picture with its own row.
//!
//! The rows are `#[ignore]`d and named `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p showcase --release \
//!     --offline --locked --test harbour_shots -- --ignored metal --nocapture
//!
//! `GENEX_SHOWCASE_OUT` names the folder (default `.studio-dev/evidence/rust-renderer/captures/latest`).

mod support;

use genex::{FIXED_STEP_MS, Runtime, View};
use genex_render::capture::Capture;
use showcase_game::harbour::{SHOTS, WORLD_SIZE, World};
use showcase_game::{harbour_assets, harbour_game};
use support::{SHOT_TICK, gpu, out_dir, percentile, write_png};

/// A shot is exposed when its mean encoded luma (0..255) lies in this range and no more than this
/// share of its pixels clip to white.
const EXPOSED_LUMA: std::ops::RangeInclusive<f64> = 30.0..=200.0;
const CLIPPED_LUMA: f64 = 250.0;
/// Dusk is keyed low: no shot's mean encoded luma above this (G0 look, 2026-10-14: lit and exposed
/// as daylight, every shot sat at 124-130, middle grey, with a midday-blue sky).
const DUSK_MEAN_LUMA_MAX: f64 = 100.0;
const CLIPPED_SHARE_MAX: f64 = 0.02;
/// The window-shafts shot looks at the sun's patches on the café floor: its brightest 1% stands
/// at least this many times over its median (no patch, no shafts).
const SHAFT_CONTRAST_MIN: f64 = 1.8;

/// Harbour Street at tick 600 of seed 1.
fn harbour_at_shot_tick() -> Runtime<World> {
    let mut runtime = Runtime::new(harbour_game()).expect("installs");
    runtime.seed(1);
    runtime.start();
    runtime.step(f64::from(SHOT_TICK) * FIXED_STEP_MS);
    runtime
}

/// `name` at tick 600 captured the way the Studio captures it, or None without a GPU.
fn studio_shot(name: &str) -> Option<Capture> {
    use genex::present::Presenter;
    let mut presenter = Presenter::open(WORLD_SIZE, harbour_assets()).ok()?;
    let mut runtime = harbour_at_shot_tick();
    let refused = presenter.install_for(&mut runtime);
    assert!(refused.is_empty(), "{refused:?}");
    presenter.set_capturing(true);
    presenter.draw_view(&mut runtime, View::Named(name)).expect("a view").expect("drawn");
    let path = presenter.resilient.renderer().renderer().last_scene().expect("a frame");
    assert!(path.hdr, "{name}: the Studio draws the HDR scene: {path:?}");
    Some(presenter.resilient.capture().expect("capture"))
}

/// Encoded luma (BT.709, 0..255) of every pixel of `capture`, ascending.
fn lumas(capture: &Capture) -> Vec<f64> {
    let mut lumas: Vec<f64> = capture.bgra().chunks(4).map(|p| 0.2126 * f64::from(p[2]) + 0.7152 * f64::from(p[1]) + 0.0722 * f64::from(p[0])).collect();
    lumas.sort_by(f64::total_cmp);
    lumas
}

/// The committed per-adapter digests of the shots (fetched and procedural rows).
fn check_digests(digests: &[(&str, String)]) {
    let Some(adapter) = gpu().map(|gpu| gpu.receipt().adapter.clone()) else { return };
    let fetched = harbour_assets().iter().any(|(name, _)| name.starts_with("fetched/"));
    let adapter = format!("{adapter} ({})", if fetched { "fetched" } else { "procedural" });
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/render-goldens/harbour-street/studio-digests.json");
    let read = std::fs::read_to_string(&path).ok().and_then(|text| text.parse::<genex::Value>().ok());
    let mut golden = read.unwrap_or_else(|| genex::json!({}));
    let mut shots = genex::json!({});
    for (name, digest) in digests {
        shots[*name] = genex::json!(digest);
    }
    if std::env::var("GENEX_RENDER_GOLDEN_UPDATE").is_ok_and(|v| v == "1") {
        golden[&adapter] = shots;
        std::fs::create_dir_all(path.parent().expect("a folder")).expect("goldens folder");
        std::fs::write(&path, format!("{golden:#}\n")).expect("golden written");
        return;
    }
    match golden.get(&adapter) {
        Some(expected) => assert_eq!(expected, &shots, "Harbour Street's digests on {adapter} changed: name them and rewrite with GENEX_RENDER_GOLDEN_UPDATE=1"),
        None => eprintln!("skipped: no committed Harbour Street digests for {adapter}"),
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_every_harbour_shot_is_drawn_the_same_twice_exposed_and_written_as_a_png() {
    if gpu().is_none() {
        return;
    }
    let dir = out_dir();
    let mut digests = Vec::new();
    let mut failures = Vec::new();
    for shot in SHOTS {
        let Some(capture) = studio_shot(shot.name) else { return };
        let again = studio_shot(shot.name).expect("a second presenter");
        write_png(&dir.join(format!("harbour-{}.png", shot.name)), &capture);
        assert_eq!(again.digest(), capture.digest(), "{}: two settled captures of one tick differ", shot.name);
        let lumas = lumas(&capture);
        let mean = lumas.iter().sum::<f64>() / lumas.len() as f64;
        let clipped = lumas.iter().filter(|luma| **luma >= CLIPPED_LUMA).count() as f64 / lumas.len() as f64;
        let (median, top) = (percentile(&lumas, 0.5), percentile(&lumas, 0.99));
        println!("{}: mean luma {mean:.1}, clipped {:.2}%, median {median:.1}, p99 {top:.1}", shot.name, clipped * 100.0);
        if !EXPOSED_LUMA.contains(&mean) {
            failures.push(format!("{}: mean luma {mean:.1} outside {EXPOSED_LUMA:?}", shot.name));
        }
        if mean > DUSK_MEAN_LUMA_MAX {
            failures.push(format!("{}: mean luma {mean:.1} over dusk's {DUSK_MEAN_LUMA_MAX}", shot.name));
        }
        if clipped > CLIPPED_SHARE_MAX {
            failures.push(format!("{}: {:.2}% of the pixels clip", shot.name, clipped * 100.0));
        }
        if shot.name == "window-shafts" && top < SHAFT_CONTRAST_MIN * median {
            failures.push(format!("window-shafts: p99 {top:.1} under {SHAFT_CONTRAST_MIN}x the median {median:.1}: no sun patch"));
        }
        digests.push((shot.name, format!("{:016x}", capture.digest())));
    }
    let listed: Vec<String> = digests.iter().map(|(name, digest)| format!("\"{name}\": \"{digest}\"")).collect();
    let record = format!("{{\"tick\": {SHOT_TICK}, \"path\": \"presenter capture\", \"digests\": {{{}}}}}\n", listed.join(", "));
    std::fs::write(dir.join("harbour-digests.json"), &record).expect("digests");
    println!("{record}");
    assert!(failures.is_empty(), "{} exposure checks failed:\n{}", failures.len(), failures.join("\n"));
    check_digests(&digests);
}

/// Plan A.4's acceptance on Harbour Street: the white rug beside the café's red brick takes at
/// least this many times the chroma it has under the sky's SH9 alone. The café is lit by warm
/// lamps, so the rug's colour is first white-balanced by its own far end (its strip farthest from
/// the brick, under the same lamps): what is left is the colour the brick bounces onto it.
const RUG_BLEED_RATIO_MIN: f64 = 2.0;

/// Chroma of linear `rgb`: its spread over its largest channel (0 for a grey).
fn chroma(rgb: [f64; 3]) -> f64 {
    let (max, min) = (rgb.iter().copied().fold(f64::MIN, f64::max), rgb.iter().copied().fold(f64::MAX, f64::min));
    (max - min) / max.max(1e-9)
}

/// The mean linear colour of `capture` where the floor strip `x` (world) by the rug's depth lands
/// for `view_proj` (points off screen skipped).
fn rug_strip(capture: &Capture, view_proj: genex::math::Mat4, x: (f32, f32)) -> [f64; 3] {
    use showcase_game::street::BLEED_FLOOR;
    let (width, height) = (capture.width(), capture.height());
    let (min, max) = (BLEED_FLOOR.min, BLEED_FLOOR.max);
    let mut sum = [0.0_f64; 3];
    let mut count = 0.0;
    for i in 0..8 {
        for j in 0..16 {
            let point = genex::math::vec3(x.0 + (x.1 - x.0) * (i as f32 + 0.5) / 8.0, max.y, min.z + (max.z - min.z) * (j as f32 + 0.5) / 16.0);
            let clip = view_proj * point.extend(1.0);
            let ndc = clip.truncate() / clip.w;
            let (px, py) = (((ndc.x + 1.0) * 0.5 * width as f32) as i64, ((1.0 - ndc.y) * 0.5 * height as f32) as i64);
            if clip.w <= 0.0 || !(0..i64::from(width)).contains(&px) || !(0..i64::from(height)).contains(&py) {
                continue;
            }
            let at = ((py as u32 * width + px as u32) * 4) as usize;
            let bgra = &capture.bgra()[at..at + 4];
            for (c, value) in sum.iter_mut().zip([bgra[2], bgra[1], bgra[0]]) {
                *c += f64::from(genex_render::texture::srgb_to_linear(value));
            }
            count += 1.0;
        }
    }
    assert!(count > 0.0, "the rug is in the café's shot");
    sum.map(|c| c / count)
}

#[test]
#[ignore = "real GPU: run with --ignored metal"]
fn metal_the_cafe_rug_beside_the_red_brick_takes_its_colour() {
    // The café's shot at tick 600 drawn through the frame renderer (settled, the untextured
    // stand-ins) at desktop high, with the café's irradiance volume and with none baked; the rug's
    // strip nearest the brick white-balanced by its strip farthest from it.
    use genex_platform_web::{MeshCache, to_scene};
    use genex_render::device_class::DeviceClass;
    use genex_render::presets::preset_quality;
    use genex_render::settings::{Look, QualityPreset};
    use showcase_game::street::BLEED_FLOOR;
    let Some(gpu) = gpu() else { return };
    let mut runtime = harbour_at_shot_tick();
    let camera = runtime.camera(View::Named("cafe")).expect("the café's camera");
    let frame = runtime.frame(View::Named("cafe")).expect("the café's frame");
    let class = DeviceClass::from_wire("desktop-high").expect("class");
    let with = preset_quality(QualityPreset::High, class);
    let mut without = with;
    without.environment.irradiance_volumes = 0;
    let (near, far) = ((BLEED_FLOOR.min.x, BLEED_FLOOR.min.x + 0.8), (BLEED_FLOOR.max.x - 0.8, BLEED_FLOOR.max.x));
    let mut bleeds = Vec::new();
    for (name, quality) in [("sh9", without), ("volume", with)] {
        let capture = support::game_capture(&gpu, class, Some(&quality), &Look::default(), &|on| {
            let mut meshes = MeshCache::default();
            meshes.load(&frame, harbour_assets(), |mesh| on.renderer.add_mesh(on.gpu, mesh));
            on.renderer.set_environment(&frame.declared_environment().cloned().unwrap_or(genex_render::settings::Environment::Color));
            to_scene(&frame, &camera, &meshes)
        });
        write_png(&out_dir().join(format!("harbour-cafe-rug-{name}.png")), &capture);
        let view_proj = to_scene(&frame, &camera, &MeshCache::default()).camera.view_proj(capture.width() as f32 / capture.height() as f32);
        let (by_brick, far_end) = (rug_strip(&capture, view_proj, near), rug_strip(&capture, view_proj, far));
        let balanced: [f64; 3] = std::array::from_fn(|c| by_brick[c] / far_end[c].max(1e-9));
        println!("{name}: the rug by the brick {by_brick:?}, at its far end {far_end:?}, balanced {balanced:?} (chroma {:.4})", chroma(balanced));
        bleeds.push(balanced);
    }
    let ratio = chroma(bleeds[1]) / chroma(bleeds[0]).max(1e-9);
    println!("{{\"row\":\"harbour-cafe-rug-bleed\",\"adapter\":\"{}\",\"sh9Chroma\":{:.5},\"volumeChroma\":{:.5},\"ratio\":{ratio:.3}}}", gpu.receipt().adapter, chroma(bleeds[0]), chroma(bleeds[1]));
    let red = |rgb: [f64; 3]| rgb[0] / (rgb[0] + rgb[1] + rgb[2]);
    assert!(red(bleeds[1]) > red(bleeds[0]), "the rug turns toward the brick's red by it: {:?} -> {:?}", bleeds[0], bleeds[1]);
    assert!(ratio >= RUG_BLEED_RATIO_MIN, "the rug's chroma by the red brick is {ratio:.2}x the SH9's (at least {RUG_BLEED_RATIO_MIN}x)");
}
