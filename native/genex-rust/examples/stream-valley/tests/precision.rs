//! STR-26b: precision at ±8 km (owner calls S11 and G4: the world extent is capped at 8 km and has
//! no floating origin, so the far corner must still draw as the origin does).
//!
//! The valley's props (a hut, the tower, a waystone, rocks and a row of pines) stand on a rippled
//! ground patch under the low sun, drawn at the origin and again moved whole to (+8 km, +8 km) and
//! (-8 km, -8 km), the camera moved with them. The ground's macro variation is off: it is a
//! brightness noise anchored to the world (no two places alike, by design), so at -8 km it lit the
//! patch 6 to 9 LSB brighter than at the origin, which is not a precision difference. The camera
//! creeps 4 mm a tick. On the host GPU (`--ignored metal`), settled 1440p captures at desktop-high
//! of ticks 60 to 63 are taken twice per corner:
//! - with the sun's shadows off, compared with the origin's of the same tick: swimming vertices
//!   show as pixels whose largest channel differs by more than [`LSB_TOLERANCE`], and their share
//!   stays under [`SWIM_SHARE_MAX`]. Shadows are left out of this one because the cascades snap to
//!   texels fixed in the world, so at another place an edge may fall one texel over, still and
//!   stable; the record keeps that share too;
//! - with every feature on, tick against tick: a TAA history that slips, a shadow map that
//!   shimmers or a sky that swims changes more pixels than the camera's creep does, so each
//!   offset's change stays within [`TEMPORAL_RATIO_MAX`] of the origin's.
//!
//! The PNGs, 1:1 crops of the hut's edge and the shadow line, each corner's change from tick 60 to
//! 61, and the record are written to `GENEX_PRECISION_OUT` (default
//! `.studio-dev/evidence/rust-renderer/captures/stream-valley-precision`).
//!
//! ```text
//! GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p stream-valley \
//!   --release --offline --test precision -- --ignored metal --nocapture
//! ```
//!
//! `GENEX_PRECISION_OFF=ao,fog` switches those render features off for every corner, to find
//! which pass a difference comes from; the record names them.

use std::path::PathBuf;

use genex::math::{self, Vec3, vec2, vec3};
use genex::present::{Presenter, STREAM_DRAIN_MAX_MS, WallDrainClock, drain_blocking};
use genex::render::{DeviceClass, Environment, RenderChange, RenderFeature};
use genex::{Camera, Color, FIXED_STEP_MS, Frame, Game, Model, Runtime, Terrain, TerrainLayer, TerrainLook, Transform, View, json};
use stream_valley_game::props::{HUT, PINE, ROCK, STONE, TOWER};
use stream_valley_game::{WORLD_SIZE, assets};

/// How far the far corners are, metres on x and on z (S11's 8 km cap).
const FAR: f32 = 8000.0;
/// The ticks captured.
const TICKS: [u64; 4] = [60, 61, 62, 63];
/// The capture size: desktop-high's 1440p, compared 1:1.
const CAPTURE: (u32, u32) = (2560, 1440);
/// A pixel counts as different when its largest channel differs by more than this.
const LSB_TOLERANCE: u8 = 8;
/// The share of pixels an offset capture may differ in from the origin's.
const SWIM_SHARE_MAX: f64 = 0.001;
/// An offset's tick-to-tick change may be at most this times the origin's (plus a few pixels).
const TEMPORAL_RATIO_MAX: f64 = 1.25;
/// Pixels of slack on the temporal ratio, for a change of a handful of pixels.
const TEMPORAL_SLACK: usize = 64;
/// How far the camera creeps a tick, metres.
const CREEP: f32 = 0.004;
/// The ground patch: samples a side and their spacing.
const GROUND_SAMPLES: u32 = 129;
const GROUND_SPACING: f32 = 1.0;
/// The 1:1 crops: (name, left, top) of a 384 px square in the 1440p capture.
const CROPS: [(&str, u32, u32); 2] = [("hut", 1088, 520), ("shadow", 1088, 860)];
const CROP: u32 = 384;
const SKY: Color = Color::rgb(150, 180, 215);
const MEADOW: Color = Color::rgb(86, 120, 58);
/// Towards the sun, as the valley draws it.
const SUN_TOWARDS: Vec3 = Vec3::new(-0.5, 0.6, -0.6);

/// The scene, moved whole by `offset`.
#[derive(Debug, Default)]
struct Corner {
    offset: Vec3,
    tick: u64,
    models: Vec<(Model, Vec3, f32)>,
    ground: Option<Terrain>,
}

/// The patch's ground at local (`x`, `z`).
fn ground(x: f32, z: f32) -> f32 {
    0.6 * math::sin(x / 7.0) * math::cos(z / 9.0)
}

/// The props in local metres: (path, where, scale).
const PLACED: [(&str, [f32; 3], f32); 9] = [
    (HUT, [0.0, 0.0, 0.0], 1.0),
    (TOWER, [9.0, 0.0, 7.0], 0.6),
    (STONE, [-4.0, 0.0, -5.0], 1.0),
    (ROCK, [3.0, 0.0, -6.0], 1.0),
    (ROCK, [-7.0, 0.0, 3.0], 0.8),
    (PINE, [-10.0, 0.0, 9.0], 1.0),
    (PINE, [-5.0, 0.0, 12.0], 1.2),
    (PINE, [0.0, 0.0, 14.0], 0.9),
    (PINE, [5.0, 0.0, 12.0], 1.1),
];

fn corner_game(offset: Vec3) -> Game<Corner> {
    let mut game = Game::new(Corner::default()).title("Stream valley precision").world_size(WORLD_SIZE[0], WORLD_SIZE[1]);
    game.on_reset(move |sim, _, _, gfx| {
        let half = (GROUND_SAMPLES - 1) as f32 * GROUND_SPACING * 0.5;
        let origin = vec2(offset.x - half, offset.z - half);
        let terrain = Terrain::from_fn([GROUND_SAMPLES, GROUND_SAMPLES], origin, GROUND_SPACING, move |x, z| offset.y + ground(x - offset.x, z - offset.z)).expect("a patch");
        let layered = terrain.with_layers(vec![TerrainLayer::flat(MEADOW).with_roughness(0.95)]).expect("one layer");
        sim.world.ground = Some(layered.with_look(TerrainLook { macro_variation: 0.0, ..TerrainLook::default() }));
        sim.world.models = PLACED.iter().map(|(path, at, scale)| (gfx.assets().model(path), Vec3::from_array(*at), *scale)).collect();
        sim.world.offset = offset;
    });
    game.on_update(|sim, ctx| sim.world.tick = ctx.tick + 1);
    game.camera(|sim| {
        let world = &sim.world;
        let creep = Vec3::X * CREEP * world.tick as f32;
        Camera::look_at(world.offset + vec3(-16.0, 7.0, -18.0) + creep, world.offset + vec3(0.0, 1.5, 0.0) + creep)
    });
    game.on_draw(|sim, frame: &mut Frame, _| {
        let world = &sim.world;
        frame.clear(SKY).ambient(Color::rgb(170, 190, 220), 0.3).sun(SUN_TOWARDS, Color::WHITE, 3.0);
        frame.environment(Environment::sky());
        if let Some(terrain) = &world.ground {
            frame.terrain(terrain);
        }
        for (model, at, scale) in &world.models {
            let local = vec3(at.x, ground(at.x, at.z), at.z);
            frame.model(model, Transform::from_translation(world.offset + local).with_scale(Vec3::splat(*scale)));
        }
    });
    game
}

fn out_dir() -> PathBuf {
    let evidence = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../.studio-dev/evidence/rust-renderer/captures/stream-valley-precision");
    let dir = std::env::var_os("GENEX_PRECISION_OUT").map_or(evidence, PathBuf::from);
    std::fs::create_dir_all(&dir).expect("the captures folder");
    dir
}

fn write_png(path: &PathBuf, bgra: &[u8], size: [u32; 2]) {
    let rgba: Vec<u8> = bgra.chunks(4).flat_map(|p| [p[2], p[1], p[0], 255]).collect();
    image::save_buffer(path, &rgba, size[0], size[1], image::ExtendedColorType::Rgba8).expect("png written");
}

/// A `CROP`-square of `bgra` (`width` wide) at (`left`, `top`).
fn crop(bgra: &[u8], width: u32, left: u32, top: u32) -> Vec<u8> {
    (top..top + CROP).flat_map(|y| {
        let row = ((y * width + left) * 4) as usize;
        bgra[row..row + (CROP * 4) as usize].iter().copied()
    }).collect()
}

/// Pixels whose largest channel differs by more than [`LSB_TOLERANCE`], and the largest difference.
fn differ(a: &[u8], b: &[u8]) -> (usize, u8) {
    a.chunks(4).zip(b.chunks(4)).fold((0, 0), |(count, max), (p, q)| {
        let d = p[..3].iter().zip(&q[..3]).map(|(x, y)| x.abs_diff(*y)).max().unwrap_or(0);
        (count + usize::from(d > LSB_TOLERANCE), max.max(d))
    })
}

/// Where `a` differs from `b` (BGRA): red past [`LSB_TOLERANCE`], `b` dimmed elsewhere.
fn diff_mask(a: &[u8], b: &[u8]) -> Vec<u8> {
    a.chunks(4)
        .zip(b.chunks(4))
        .flat_map(|(p, q)| {
            let d = p[..3].iter().zip(&q[..3]).map(|(x, y)| x.abs_diff(*y)).max().unwrap_or(0);
            if d > LSB_TOLERANCE { [0, 0, 255, 255] } else { [q[0] / 4, q[1] / 4, q[2] / 4, 255] }
        })
        .collect()
}

/// The features `GENEX_PRECISION_OFF` switches off (comma-separated wire names).
fn switched_off() -> Vec<RenderFeature> {
    let names = std::env::var("GENEX_PRECISION_OFF").unwrap_or_default();
    names.split(',').filter(|name| !name.is_empty()).map(|name| RenderFeature::from_wire(name).unwrap_or_else(|| panic!("no render feature `{name}`"))).collect()
}

/// Settled captures of [`TICKS`] for the scene moved by `offset`, on a fresh presenter, with
/// `off` and the `GENEX_PRECISION_OFF` features switched off.
fn shoot(offset: Vec3, off: &[RenderFeature]) -> Vec<Vec<u8>> {
    let mut presenter = Presenter::open(WORLD_SIZE, assets()).expect("a WebGPU-core adapter");
    let mut runtime = Runtime::with_assets(corner_game(offset), Box::new(assets())).expect("installs");
    runtime.seed(1);
    assert!(runtime.start());
    assert!(presenter.install_for(&mut runtime).is_empty());
    presenter.set_capturing(true);
    presenter.set_capture_size(Some(CAPTURE));
    presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("drawn");
    let settings = presenter.render_settings().expect("the game's settings attached");
    let features = switched_off().into_iter().chain(off.iter().copied()).map(|feature| (feature, false)).collect();
    settings.borrow_mut().apply(&RenderChange { device_class: Some(DeviceClass::from_wire("desktop-high")), features, ..RenderChange::default() });
    let mut shots = Vec::new();
    let mut tick = 0;
    for at in TICKS {
        while tick < at {
            runtime.step(FIXED_STEP_MS);
            tick += 1;
        }
        let report = drain_blocking(&mut WallDrainClock::default(), STREAM_DRAIN_MAX_MS, || presenter.drain_pass(&mut runtime, View::Game)).expect("drained");
        presenter.note_drain(report);
        presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("drawn");
        let capture = presenter.resilient.capture().expect("capture");
        assert_eq!((capture.width(), capture.height()), CAPTURE);
        shots.push(capture.bgra().to_vec());
    }
    assert_eq!(presenter.failure(), None);
    shots
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_far_corners_draw_as_the_origin_does() {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    if let Err(error) = Presenter::open(WORLD_SIZE, assets()) {
        assert!(!require, "GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}");
        return eprintln!("skipped: no WebGPU-core adapter ({error})");
    }
    let dir = out_dir();
    let size = [CAPTURE.0, CAPTURE.1];
    let pixels = (CAPTURE.0 * CAPTURE.1) as usize;
    let corners = [("origin", Vec3::ZERO), ("plus-8km", vec3(FAR, 0.0, FAR)), ("minus-8km", vec3(-FAR, 0.0, -FAR))];
    let shots: Vec<(&str, Vec<Vec<u8>>)> = corners.iter().map(|(name, offset)| (*name, shoot(*offset, &[]))).collect();
    let still: Vec<Vec<Vec<u8>>> = corners.iter().map(|(_, offset)| shoot(*offset, &[RenderFeature::Shadows])).collect();
    for (name, frames) in &shots {
        write_png(&dir.join(format!("precision-{name}-{}.png", TICKS[0])), &frames[0], size);
        // Where the tick after changed the picture: the camera's creep, and any shimmer.
        write_png(&dir.join(format!("precision-{name}-tick-diff.png")), &diff_mask(&frames[1], &frames[0]), size);
        for (crop_name, left, top) in CROPS {
            write_png(&dir.join(format!("precision-{name}-{crop_name}-crop.png")), &crop(&frames[0], CAPTURE.0, left, top), [CROP, CROP]);
        }
    }
    let origin = &shots[0].1;
    let temporal = |frames: &[Vec<u8>]| -> Vec<usize> { frames.windows(2).map(|pair| differ(&pair[0], &pair[1]).0).collect() };
    let origin_temporal = temporal(origin);
    let mut rows = Vec::new();
    let mut failures = Vec::new();
    for ((name, frames), unshadowed) in shots[1..].iter().zip(&still[1..]) {
        let against: Vec<(usize, u8)> = frames.iter().zip(origin).map(|(shot, base)| differ(shot, base)).collect();
        let swim: Vec<(usize, u8)> = unshadowed.iter().zip(&still[0]).map(|(shot, base)| differ(shot, base)).collect();
        write_png(&dir.join(format!("precision-{name}-diff.png")), &diff_mask(&frames[0], &origin[0]), size);
        write_png(&dir.join(format!("precision-{name}-unshadowed-diff.png")), &diff_mask(&unshadowed[0], &still[0][0]), size);
        let changes = temporal(frames);
        for (at, (count, _)) in TICKS.iter().zip(&swim) {
            let share = *count as f64 / pixels as f64;
            if share > SWIM_SHARE_MAX {
                failures.push(format!("{name} tick {at}: {count} pixels ({:.4}%) differ from the origin's without shadows", share * 100.0));
            }
        }
        for ((own, base), at) in changes.iter().zip(&origin_temporal).zip(&TICKS[1..]) {
            let limit = (*base as f64 * TEMPORAL_RATIO_MAX) as usize + TEMPORAL_SLACK;
            if *own > limit {
                failures.push(format!("{name} tick {at}: {own} pixels changed from the tick before, the origin {base}"));
            }
        }
        rows.push(json!({
            "corner": name,
            "swimAgainstOrigin": swim.iter().zip(TICKS).map(|((count, max), at)| json!({ "tick": at, "pixels": count, "maxLsb": max })).collect::<Vec<_>>(),
            "againstOriginWithShadows": against.iter().zip(TICKS).map(|((count, max), at)| json!({ "tick": at, "pixels": count, "maxLsb": max })).collect::<Vec<_>>(),
            "tickToTick": changes,
        }));
    }
    let record = json!({
        "capture": [CAPTURE.0, CAPTURE.1],
        "class": "desktop-high",
        "featuresOff": switched_off().iter().map(|feature| feature.wire()).collect::<Vec<_>>(),
        "lsbTolerance": LSB_TOLERANCE,
        "swimShareMax": SWIM_SHARE_MAX,
        "originTickToTick": origin_temporal,
        "corners": rows,
        "passed": failures.is_empty(),
        "failures": failures,
    });
    std::fs::write(dir.join("precision.json"), format!("{record:#}\n")).expect("the record writes");
    println!("{record:#}");
    assert!(failures.is_empty(), "the far corners do not draw as the origin does: {failures:?}");
}
