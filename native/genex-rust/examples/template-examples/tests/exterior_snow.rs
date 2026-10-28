//! The exterior-snow example (`src/game-template-rust/docs/examples/exterior-snow`) as a game gets
//! it: its genex.toml admitted, its ground one Terrain of two packed layers, its props snowed by
//! material, heavy snow falling in two camera-following layers, and (on the host GPU) a capture
//! per preset from each camera:
//!
//!   GENEX_REQUIRE_METAL=1 [GENEX_EXAMPLES_ASSETS=<assets>] node scripts/toolchains/rust-env.ts -- \
//!     cargo test -p template-examples --release --offline --locked --test exterior_snow -- --ignored metal --nocapture
//!
//! Without `GENEX_EXAMPLES_ASSETS` the GPU row packs its two Terrain layers from a generated
//! height field (base colour with height in alpha, and normal, roughness and occlusion), the layout
//! `cc0__terrain_layer` writes from a CC0 scan.

#[path = "../../../../../src/game-template-rust/docs/examples/exterior-snow/src/game.rs"]
mod game;
mod support;

use genex::render::{QualityPreset, RenderConfig};
use genex::{FIXED_STEP_MS, Game, Runtime, Shape, View};

use game::World;

const GENEX_TOML: &str = include_str!("../../../../../src/game-template-rust/docs/examples/exterior-snow/genex.toml");
const WORLD_SIZE: [u32; 2] = [1280, 720];

fn yard() -> Game<World> {
    let mut game = Game::new(World::default()).title("Exterior snow").world_size(WORLD_SIZE[0], WORLD_SIZE[1]);
    game::wire(&mut game);
    game.render_settings(game::look(RenderConfig::from_toml(GENEX_TOML).expect("the example's [render] is admitted")));
    game
}

fn started(assets: genex::AssetTable) -> Runtime<World> {
    let mut runtime = Runtime::with_assets(yard(), Box::new(assets)).expect("the example installs");
    runtime.seed(1);
    runtime.start();
    runtime.step(FIXED_STEP_MS * 30.0);
    runtime
}

#[test]
fn the_ground_is_one_terrain_of_two_packed_layers() {
    let mut runtime = started(support::assets(&[]));
    let frame = runtime.frame(View::Game).expect("a frame");
    let terrain = frame.drawn_terrain().expect("the yard's ground is a Terrain");
    let layers: Vec<(Option<&str>, Option<&str>)> = terrain.layers().iter().map(|layer| (layer.albedo(), layer.data())).collect();
    assert_eq!(layers, vec![(Some("terrain/snow_albedo.png"), Some("terrain/snow_data.png")), (Some("terrain/slush_albedo.png"), Some("terrain/slush_data.png"))]);
    let slab = frame.draws().iter().any(|draw| matches!(&draw.shape, Shape::Cube { transform, .. } if transform.scale.x > 20.0));
    assert!(!slab, "no cube stands in for the ground");
}

#[test]
fn heavy_snow_falls_in_two_layers_and_covers_every_prop_by_material() {
    let mut runtime = started(support::assets(&[]));
    let frame = runtime.frame(View::Game).expect("a frame");
    assert_eq!(frame.drawn_particles().len(), 2, "the near and far layers");
    let cover = frame.world_cover().expect("the weather lays its cover");
    assert_eq!(cover.amount(), 1.0, "ten minutes of heavy snow cover the yard");
    let props: Vec<_> = frame.draws().iter().filter(|draw| draw.tag == "props").collect();
    assert!(props.len() >= 30, "{} prop draws", props.len());
    // The bench's slats carry their own cover; the window keeps the weather off.
    let own: Vec<f32> = props
        .iter()
        .filter_map(|draw| match &draw.shape {
            Shape::Cube { material, .. } => material.cover().map(|c| c.amount()),
            _ => None,
        })
        .collect();
    assert!(own.contains(&0.9), "the bench's own snow");
    assert!(own.contains(&0.0), "the window's Cover::none()");
    // No snow slab: nothing white and flat is laid on a prop.
    let white_slab = props.iter().any(|draw| match &draw.shape {
        Shape::Cube { transform, material, .. } => transform.scale.y < 0.06 && material.base_color.r > 200 && material.base_color.g > 200,
        _ => false,
    });
    assert!(!white_slab, "snow on props is the material's cover, never a white box");
}

#[test]
fn the_probe_reports_the_cover_and_the_terrain() {
    let mut runtime = started(support::assets(&[]));
    runtime.step(FIXED_STEP_MS);
    let yard = &runtime.state()["yard"];
    assert_eq!(yard["terrain"].as_bool(), Some(true));
    assert_eq!(yard["cover"].as_f64(), Some(1.0));
}

/// A `side`-square packed Terrain layer from a height field `h(u, v)` in 0..1 and its colour
/// `albedo(h)`: (base colour with height in alpha, normal xy with roughness and occlusion), as
/// PNG files.
fn packed_layer(side: u32, h: impl Fn(f32, f32) -> f32, albedo: impl Fn(f32) -> [u8; 3], roughness: u8, bump: f32) -> (Vec<u8>, Vec<u8>) {
    let at = |x: i64, y: i64| {
        let (x, y) = (x.rem_euclid(i64::from(side)) as f32, y.rem_euclid(i64::from(side)) as f32);
        h(x / side as f32, y / side as f32)
    };
    let mut color = Vec::new();
    let mut data = Vec::new();
    for y in 0..i64::from(side) {
        for x in 0..i64::from(side) {
            let height = at(x, y);
            let [r, g, b] = albedo(height);
            color.extend_from_slice(&[r, g, b, (height * 255.0) as u8]);
            let (dx, dy) = ((at(x + 1, y) - at(x - 1, y)) * bump, (at(x, y + 1) - at(x, y - 1)) * bump);
            let n = genex::math::Vec3::new(-dx, -dy, 1.0).normalize();
            let occlusion = (180.0 + 75.0 * height) as u8;
            data.extend_from_slice(&[((n.x * 0.5 + 0.5) * 255.0) as u8, ((n.y * 0.5 + 0.5) * 255.0) as u8, roughness, occlusion]);
        }
    }
    let png = |rgba: Vec<u8>| {
        let mut bytes = Vec::new();
        let encoder = image::codecs::png::PngEncoder::new(&mut bytes);
        image::ImageEncoder::write_image(encoder, &rgba, side, side, image::ExtendedColorType::Rgba8).expect("png");
        bytes
    };
    (png(color), png(data))
}

/// Value noise on a 16-cell lattice, tiling over the unit square.
fn noise(u: f32, v: f32, cells: u32) -> f32 {
    let hash = |x: u32, y: u32| {
        let mut h = (x % cells).wrapping_mul(0x27d4_eb2d) ^ (y % cells).wrapping_mul(0x1656_67b1);
        h = (h ^ (h >> 15)).wrapping_mul(0x85eb_ca6b);
        (h ^ (h >> 13)) as f32 / u32::MAX as f32
    };
    let (x, y) = (u * cells as f32, v * cells as f32);
    let (i, j) = (x.floor() as u32, y.floor() as u32);
    let (fx, fy) = (x - x.floor(), y - y.floor());
    let (sx, sy) = (fx * fx * (3.0 - 2.0 * fx), fy * fy * (3.0 - 2.0 * fy));
    let top = hash(i, j) + (hash(i + 1, j) - hash(i, j)) * sx;
    let bottom = hash(i, j + 1) + (hash(i + 1, j + 1) - hash(i, j + 1)) * sx;
    top + (bottom - top) * sy
}

/// The two layers the yard names, generated: wind-rippled snow and trodden slush.
fn generated_layers() -> Vec<(&'static str, Vec<u8>)> {
    let snow_height = |u: f32, v: f32| 0.55 * noise(u, v, 8) + 0.3 * noise(u, v, 32) + 0.15 * noise(u, v, 64);
    let (snow_albedo, snow_data) = packed_layer(256, snow_height, |h| [(222.0 + 20.0 * h) as u8, (228.0 + 18.0 * h) as u8, (236.0 + 16.0 * h) as u8], 150, 6.0);
    let slush_height = |u: f32, v: f32| 0.6 * noise(u, v, 16) + 0.4 * noise(u, v, 64);
    let (slush_albedo, slush_data) = packed_layer(256, slush_height, |h| [(80.0 + 70.0 * h) as u8, (78.0 + 66.0 * h) as u8, (74.0 + 62.0 * h) as u8], 110, 10.0);
    vec![
        ("terrain/snow_albedo.png", snow_albedo),
        ("terrain/snow_data.png", snow_data),
        ("terrain/slush_albedo.png", slush_albedo),
        ("terrain/slush_data.png", slush_data),
    ]
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_yard_captures_at_low_and_high_from_each_camera() {
    let extra = if std::env::var_os("GENEX_EXAMPLES_ASSETS").is_some() { Vec::new() } else { generated_layers() };
    let Some(mut presenter) = support::presenter(WORLD_SIZE, support::assets(&extra)) else { return };
    let mut runtime = started(support::assets(&extra));
    assert!(presenter.install_for(&mut runtime).is_empty());
    for (view, name) in [(View::Game, "exterior-snow"), (View::Named("bench"), "exterior-snow-bench"), (View::Named("overview"), "exterior-snow-overview")] {
        for preset in [QualityPreset::Low, QualityPreset::High] {
            let luma = support::shoot(&mut presenter, &mut runtime, view, preset, name);
            eprintln!("{name} {}: mean luma {luma:.1}", preset.wire());
            assert!((40.0..245.0).contains(&luma), "{name} at {} is neither black nor blown out: {luma}", preset.wire());
        }
    }
}
