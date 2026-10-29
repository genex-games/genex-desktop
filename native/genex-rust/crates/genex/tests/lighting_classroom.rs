//! The AAA review's interior target (WP-12, WP-5): a windowed classroom lit only by the sun through
//! its windows and its own ceiling tubes, in physical units, with no fill light faking bounce,
//! drawn on desktop `high` with the documented indoor exposure recipe, settles inside the
//! harness's luminance band: mean luma 90..=130 and at most 15 % of the frame in the darkest of 32
//! bins. The game declares one reflection probe for the room, as the Lighting page asks; the
//! renderer pairs it with a volume (auto rooms) and screen-space GI adds the near bounce.
//!
//! GPU rows (`#[ignore]`d, names contain `metal`):
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex --offline \
//!     --locked --test lighting_classroom -- --ignored metal --nocapture
//!
//! `GENEX_RENDER_EVIDENCE_DIR` receives each capture as a PNG and its `__render` facts as JSON.

use std::path::Path;

use genex::prelude::*;
use genex::present::Presenter;
use genex::render::{Exposure, Fog, Metering, QualityPreset, ReflectionProbe, RenderConfig, SpotLight, Tonemap, units};
use genex::render::{Environment, SkyParams};
use genex::{FIXED_STEP_MS, Runtime, View};

const WORLD: [u32; 2] = [960, 540];
/// The harness's band (`WP-5`, proposed): a playable interior's settled mean luma.
const LUMA_BAND: (f64, f64) = (90.0, 130.0);
/// The most of the frame the darkest of the harness's 32 luma bins may hold.
const DARKEST_BIN_MAX: f64 = 0.15;
/// The harness's histogram (`src/substrate/pixel-stats.ts`): 32 bins over luma 0..=255.
const HISTOGRAM_BINS: f64 = 32.0;
/// The room: 8 m along x, 3 m high, 6 m deep, its window wall at z = 6 facing the sun.
const ROOM: [f32; 3] = [8.0, 3.0, 6.0];
const WALL: f32 = 0.2;
/// Window sill and head heights, and the two openings along x.
const SILL: f32 = 0.9;
const HEAD: f32 = 2.4;
const WINDOWS: [(f32, f32); 2] = [(1.0, 3.2), (4.8, 7.0)];
/// Ceiling tubes: 3000 lm each, a 60° cone down, 4000 K.
const TUBE_LUMENS: f32 = 3000.0;
const TUBE_CONE: f32 = 60.0;
/// The fog recipe's extinction per metre: a dusty room, thin enough to see across.
const FOG_DENSITY: f32 = 0.08;
/// Sim ticks the replay drive steps while paused (the harness's fixed horizon is longer; the
/// count only has to be the same for both runs).
const REPLAY_TICKS: usize = 24;

#[derive(Default)]
struct World;

/// How the room is exposed.
#[derive(Clone, Copy, Debug)]
enum Recipe {
    /// The documented indoor recipe (Grading: centre metering, compensation 0, default `ev_min`).
    Indoor,
    /// Gen3's light facet: average metering, -0.75 EV, a raised `ev_min` of -2.5.
    Gen3,
    /// The indoor recipe on `ultra` with a thin volumetric fog the sun carves shafts from at the
    /// windows (Track B: the determinism check keeps every look feature on).
    Fog,
    /// The same room on `ultra` without the fog, the shafts' reference.
    Clear,
    /// The fog recipe drawn as the plain height fog (`.with_volumetric(false)`): no shafts.
    FlatFog,
}

fn box_at(frame: &mut Frame, min: Vec3, max: Vec3, material: &Material) {
    let centre = (min + max) * 0.5;
    frame.cube_with(Transform::from_translation(centre).with_scale(max - min), material);
}

fn draw_room(frame: &mut Frame) {
    let [x, y, z] = ROOM;
    let plaster = Material::color(Color::rgb(214, 206, 188)).with_roughness(0.9);
    let floor = Material::color(Color::rgb(138, 112, 86)).with_roughness(0.7);
    let ceiling = Material::color(Color::rgb(236, 236, 230)).with_roughness(0.9);
    let desk = Material::color(Color::rgb(170, 132, 92)).with_roughness(0.6);
    let ground = Material::color(Color::rgb(96, 104, 80)).with_roughness(1.0);
    frame.tag("ground");
    box_at(frame, Vec3::new(-40.0, -0.2, -40.0), Vec3::new(48.0, -0.1, 46.0), &ground);
    frame.tag("room");
    box_at(frame, Vec3::new(0.0, -0.1, 0.0), Vec3::new(x, 0.0, z), &floor);
    box_at(frame, Vec3::new(0.0, y, 0.0), Vec3::new(x, y + WALL, z), &ceiling);
    box_at(frame, Vec3::new(-WALL, 0.0, 0.0), Vec3::new(0.0, y, z), &plaster);
    box_at(frame, Vec3::new(x, 0.0, 0.0), Vec3::new(x + WALL, y, z), &plaster);
    box_at(frame, Vec3::new(0.0, 0.0, -WALL), Vec3::new(x, y, 0.0), &plaster);
    // The window wall: below the sills, above the heads, and the piers between the openings.
    box_at(frame, Vec3::new(0.0, 0.0, z), Vec3::new(x, SILL, z + WALL), &plaster);
    box_at(frame, Vec3::new(0.0, HEAD, z), Vec3::new(x, y, z + WALL), &plaster);
    let mut from = 0.0;
    for (start, end) in WINDOWS {
        box_at(frame, Vec3::new(from, SILL, z), Vec3::new(start, HEAD, z + WALL), &plaster);
        from = end;
    }
    box_at(frame, Vec3::new(from, SILL, z), Vec3::new(x, HEAD, z + WALL), &plaster);
    frame.tag("desks");
    for row in 0..2 {
        for column in 0..3 {
            let at = Vec3::new(1.5 + 2.5 * column as f32, 0.0, 1.8 + 2.2 * row as f32);
            box_at(frame, at, at + Vec3::new(1.2, 0.75, 0.6), &desk);
        }
    }
}

fn light_room(frame: &mut Frame) {
    let [x, y, z] = ROOM;
    frame.environment(Environment::Sky(SkyParams::default()));
    // The sun outside the atmosphere, low enough in the south to reach in at the windows.
    frame.sun(Vec3::new(0.25, 0.55, 1.0), Color::WHITE, units::lux(units::reference::SUN_ABOVE_ATMOSPHERE_LUX));
    let [r, g, b] = units::kelvin(4000.0);
    let tube = Color::rgb(r, g, b);
    let intensity = units::spot_lumens(TUBE_LUMENS, TUBE_CONE);
    for row in 0..2 {
        for column in 0..3 {
            let at = Vec3::new(x / 6.0 * (2 * column + 1) as f32, y - 0.05, z / 4.0 * (2 * row + 1) as f32);
            frame.spot_light_with(&SpotLight::new(at, -Vec3::Y, 6.0, tube, intensity).with_cone_degrees(TUBE_CONE * 0.75, TUBE_CONE));
        }
    }
    // The room as the docs ask a game to declare it: one probe over its inside. The renderer adds
    // its irradiance volume.
    frame.reflection_probe(&ReflectionProbe::new(Vec3::ZERO, Vec3::new(x, y, z)).with_capture(Vec3::new(x * 0.5, 1.6, z * 0.5)));
}

/// The fog recipe's fog: uniform in height, so only the light in it varies.
fn room_fog() -> Fog {
    Fog::default().with_density(FOG_DENSITY).with_height(0.0, 0.0)
}

fn runtime(recipe: Recipe) -> Runtime<World> {
    let exposure = match recipe {
        Recipe::Gen3 => Exposure::auto().compensation(-0.75).metering(Metering::Average).range(-2.5, 8.0),
        _ => Exposure::auto().compensation(0.0).metering(Metering::Center),
    };
    let config = RenderConfig::new().tonemap(Tonemap::AgxPunchy).exposure(exposure);
    let config = match recipe {
        Recipe::Indoor | Recipe::Gen3 => config.preset(QualityPreset::High),
        Recipe::Clear => config.preset(QualityPreset::Ultra),
        Recipe::Fog => config.preset(QualityPreset::Ultra).fog(room_fog()),
        Recipe::FlatFog => config.preset(QualityPreset::Ultra).fog(room_fog().with_volumetric(false)),
    };
    let mut game = Game::new(World).title("Classroom").world_size(WORLD[0], WORLD[1]);
    game.render_settings(config);
    game.camera(|_| Camera { fovy: 70.0, ..Camera::look_at(Vec3::new(0.8, 1.6, 0.8), Vec3::new(6.5, 1.1, 5.2)) });
    game.on_draw(|_, frame, _| {
        light_room(frame);
        draw_room(frame);
    });
    let mut runtime = Runtime::new(game).expect("valid registrations");
    runtime.seed(1);
    runtime.start();
    runtime.step(FIXED_STEP_MS);
    runtime
}

/// Mean luma and the darkest bin's share of a BGRA capture, as the harness computes them.
fn luma_stats(bgra: &[u8]) -> (f64, f64) {
    let lumas: Vec<f64> = bgra.as_chunks::<4>().0.iter().map(|p| 0.0722 * f64::from(p[0]) + 0.7152 * f64::from(p[1]) + 0.2126 * f64::from(p[2])).collect();
    let mean = lumas.iter().sum::<f64>() / lumas.len() as f64;
    let darkest = lumas.iter().filter(|luma| **luma * HISTOGRAM_BINS / 256.0 < 1.0).count() as f64 / lumas.len() as f64;
    (mean, darkest)
}

/// A presenter on this machine's GPU, or none (skipped) without one.
fn presenter() -> Option<Presenter> {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    match Presenter::open(WORLD, &[]) {
        Ok(presenter) => Some(presenter),
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(error) => {
            eprintln!("skipped: no WebGPU-core adapter ({error})");
            None
        }
    }
}

/// Writes `bgra` as `name.png` and `render` as `name.json` into `GENEX_RENDER_EVIDENCE_DIR`.
fn evidence(name: &str, bgra: &[u8], render: &serde_json::Value) {
    let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") else { return };
    let dir = Path::new(&dir);
    let _ = std::fs::create_dir_all(dir);
    let rgba: Vec<u8> = bgra.as_chunks::<4>().0.iter().flat_map(|p| [p[2], p[1], p[0], 255]).collect();
    std::fs::write(dir.join(format!("{name}.png")), png(WORLD[0], WORLD[1], &rgba)).expect("evidence");
    std::fs::write(dir.join(format!("{name}.json")), serde_json::to_vec_pretty(render).expect("json")).expect("evidence");
}

fn capture(recipe: Recipe, name: &str) -> Option<(f64, f64, serde_json::Value)> {
    let mut presenter = presenter()?;
    let mut runtime = runtime(recipe);
    presenter.set_capturing(true);
    for _ in 0..4 {
        presenter.draw_view(&mut runtime, View::Game).expect("game view").expect("drawn");
    }
    let bgra = presenter.resilient.capture().expect("capture").bgra().to_vec();
    let render = runtime.state()["__render"].clone();
    evidence(name, &bgra, &render);
    let (mean, darkest) = luma_stats(&bgra);
    eprintln!("{name}: mean luma {mean:.1}, darkest bin {:.1} %, exposure {}", darkest * 100.0, render["exposure"]);
    Some((mean, darkest, render))
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_windowed_classroom_lit_by_its_sun_and_tubes_settles_in_the_luminance_band() {
    let Some((mean, darkest, render)) = capture(Recipe::Indoor, "classroom-high-indoor") else { return };
    assert!((LUMA_BAND.0..=LUMA_BAND.1).contains(&mean), "mean luma {mean:.1} outside {LUMA_BAND:?}");
    assert!(darkest <= DARKEST_BIN_MAX, "{:.1} % of the frame in the darkest bin", darkest * 100.0);
    assert_eq!(render["exposure"]["warnings"], serde_json::json!([]));
    assert!(render["look"]["tags"]["room"]["coverage"].as_f64().is_some_and(|share| share > 0.5), "{}", render["look"]);
}

/// The same room under gen3's exposure (the "before"): the engine names the raised floor.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_classroom_under_gen3_s_exposure_warns_of_its_raised_floor() {
    let Some((_, _, render)) = capture(Recipe::Gen3, "classroom-high-gen3") else { return };
    assert_eq!(render["exposure"]["warnings"], serde_json::json!(["ev-min-raised-with-doorway-adaptation"]));
}

/// The harness's replay row (`native-evidence.ts` `replayRow`) on one fresh run: the game paused
/// on its seed, [`REPLAY_TICKS`] steps, then a settled capture. Between the reload and the capture
/// the window draws Live frames at its own pace, so the two runs the row compares draw different
/// counts: `live_frames` Live frames, spread over the steps.
fn replay_capture(recipe: Recipe, live_frames: usize) -> Option<(Vec<u8>, serde_json::Value)> {
    let mut presenter = presenter()?;
    let mut runtime = runtime(recipe);
    runtime.pause();
    let mut drawn = 0;
    for tick in 0..REPLAY_TICKS {
        while drawn * REPLAY_TICKS < live_frames * (tick + 1) {
            presenter.draw_view(&mut runtime, View::Game).expect("game view").expect("drawn");
            drawn += 1;
        }
        runtime.step(FIXED_STEP_MS);
    }
    // The row reads `state()` before the screenshot, as `replayRow` does.
    let render = runtime.state()["__render"].clone();
    presenter.set_capturing(true);
    presenter.draw_view(&mut runtime, View::Game).expect("game view").expect("drawn");
    Some((presenter.resilient.capture().expect("capture").bgra().to_vec(), render))
}

/// The keys of two `__render` objects whose values differ.
fn differing_keys(a: &serde_json::Value, b: &serde_json::Value) -> Vec<String> {
    let keys = a.as_object().into_iter().chain(b.as_object()).flat_map(|object| object.keys().cloned());
    let mut keys: Vec<String> = keys.filter(|key| a.get(key) != b.get(key)).collect();
    keys.sort_unstable();
    keys.dedup();
    keys
}

/// How many pixels of `a` and `b` differ, and by at most how much in one channel.
fn pixel_difference(a: &[u8], b: &[u8]) -> (usize, u8) {
    let pixels = a.as_chunks::<4>().0.iter().zip(b.as_chunks::<4>().0);
    pixels.fold((0, 0), |(count, most), (p, q)| {
        let delta = p.iter().zip(q).map(|(x, y)| x.abs_diff(*y)).max().unwrap_or(0);
        (count + usize::from(delta > 0), most.max(delta))
    })
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_volumetric_fog_room_on_ultra_replays_to_the_same_pixels_whatever_live_drew_first() {
    let Some((few, few_render)) = replay_capture(Recipe::Fog, 1) else { return };
    let Some((many, many_render)) = replay_capture(Recipe::Fog, 3 * REPLAY_TICKS) else { return };
    evidence("classroom-ultra-fog-replay-a", &few, &few_render);
    evidence("classroom-ultra-fog-replay-b", &many, &many_render);
    eprintln!("__render keys that differ between the runs: {:?}", differing_keys(&few_render, &many_render));
    let (count, most) = pixel_difference(&few, &many);
    if count > 0 {
        let clear = replay_capture(Recipe::Clear, 1).zip(replay_capture(Recipe::Clear, 3 * REPLAY_TICKS));
        let (clear_count, clear_most) = clear.map_or((0, 0), |((a, _), (b, _))| pixel_difference(&a, &b));
        eprintln!("without the fog: {clear_count} differ, by up to {clear_most}");
    }
    assert_eq!((count, most), (0, 0), "the same seed and input drew different pixels: {count} differ, by up to {most}");
}

/// How unevenly `fog` adds light over `clear`: the 95th percentile of the per-pixel luma gain less
/// its median. Plain height fog adds about the same everywhere at one distance; shafts add a lot in
/// the sunlit air and little in the shadowed air.
fn gain_spread(fog: &[u8], clear: &[u8]) -> f64 {
    let luma = |p: &[u8; 4]| 0.0722 * f64::from(p[0]) + 0.7152 * f64::from(p[1]) + 0.2126 * f64::from(p[2]);
    let mut gains: Vec<f64> = fog.as_chunks::<4>().0.iter().zip(clear.as_chunks::<4>().0).map(|(f, c)| luma(f) - luma(c)).collect();
    gains.sort_unstable_by(f64::total_cmp);
    let at = |share: f64| gains[((gains.len() - 1) as f64 * share) as usize];
    at(0.95) - at(0.5)
}

/// A settled capture of `recipe` (BGRA) and its `__render`.
fn shot(recipe: Recipe, name: &str) -> Option<(Vec<u8>, serde_json::Value)> {
    let mut presenter = presenter()?;
    let mut runtime = runtime(recipe);
    presenter.set_capturing(true);
    presenter.draw_view(&mut runtime, View::Game).expect("game view").expect("drawn");
    let bgra = presenter.resilient.capture().expect("capture").bgra().to_vec();
    let render = runtime.state()["__render"].clone();
    evidence(name, &bgra, &render);
    Some((bgra, render))
}

/// The least spread (luma levels) of the shafts' gain over the clear room, and how many times the
/// plain fog's spread it must be.
const SHAFT_SPREAD_MIN: f64 = 8.0;
const SHAFT_OVER_FLAT: f64 = 1.5;

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_fog_room_s_sun_shafts_light_the_air_inside_the_windows() {
    let Some((fog, fog_render)) = shot(Recipe::Fog, "classroom-ultra-fog") else { return };
    let Some((flat, flat_render)) = shot(Recipe::FlatFog, "classroom-ultra-flat-fog") else { return };
    let Some((clear, _)) = shot(Recipe::Clear, "classroom-ultra-clear") else { return };
    let features = |render: &serde_json::Value| render["look"]["features"].clone();
    assert_eq!(features(&fog_render)["volumetric-fog"], true, "{}", features(&fog_render));
    assert_eq!(features(&flat_render)["volumetric-fog"], false, "{}", features(&flat_render));
    assert_eq!(features(&flat_render)["fog"], true);
    let (shafts, plain) = (gain_spread(&fog, &clear), gain_spread(&flat, &clear));
    eprintln!("fog gain spread: volumetric {shafts:.1}, plain {plain:.1} luma levels");
    assert!(shafts >= SHAFT_SPREAD_MIN && shafts >= SHAFT_OVER_FLAT * plain, "no shafts: volumetric {shafts:.1} vs plain {plain:.1}");
}

/// A stored-deflate PNG of `rgba` (`width` x `height`).
fn png(width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
    let crc = |bytes: &[u8]| {
        let mut crc = 0xffff_ffffu32;
        for byte in bytes {
            crc ^= u32::from(*byte);
            for _ in 0..8 {
                crc = if crc & 1 == 1 { 0xedb8_8320 ^ (crc >> 1) } else { crc >> 1 };
            }
        }
        !crc
    };
    let chunk = |out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]| {
        out.extend((data.len() as u32).to_be_bytes());
        let mut body = kind.to_vec();
        body.extend(data);
        out.extend(&body);
        out.extend(crc(&body).to_be_bytes());
    };
    let mut raw = Vec::new();
    for row in rgba.chunks_exact(width as usize * 4) {
        raw.push(0);
        raw.extend(row);
    }
    let (mut a, mut b) = (1u32, 0u32);
    for byte in &raw {
        a = (a + u32::from(*byte)) % 65_521;
        b = (b + a) % 65_521;
    }
    let mut zlib = vec![0x78, 0x01];
    for (at, block) in raw.chunks(65_535).enumerate() {
        let last = (at + 1) * 65_535 >= raw.len();
        zlib.push(u8::from(last));
        zlib.extend((block.len() as u16).to_le_bytes());
        zlib.extend((!(block.len() as u16)).to_le_bytes());
        zlib.extend(block);
    }
    zlib.extend(((b << 16) | a).to_be_bytes());
    let mut out = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    let mut header = Vec::new();
    header.extend(width.to_be_bytes());
    header.extend(height.to_be_bytes());
    header.extend([8, 6, 0, 0, 0]);
    chunk(&mut out, b"IHDR", &header);
    chunk(&mut out, b"IDAT", &zlib);
    chunk(&mut out, b"IEND", &[]);
    out
}
