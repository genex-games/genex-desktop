//! Determinism rules the facade owns: libm-backed math, an insertion-ordered map with a fixed
//! hasher, scalar glam (so GPU structs never rely on glam alignment) and one glam in the build.

use genex::math;
use genex::{Map, Pcg32, Set};
use std::process::Command;

#[test]
fn math_is_libm_and_matches_reference_values() {
    let cases: [(&str, f32, f32); 8] = [
        ("sin", math::sin(1.0), 0.841_470_96),
        ("cos", math::cos(1.0), 0.540_302_3),
        ("tan", math::tan(0.5), 0.546_302_5),
        ("atan2", math::atan2(1.0, -1.0), 2.356_194_5),
        ("exp", math::exp(1.0), core::f32::consts::E),
        ("ln", math::ln(10.0), core::f32::consts::LN_10),
        ("pow", math::pow(2.0, 0.5), core::f32::consts::SQRT_2),
        ("sqrt", math::sqrt(2.0), core::f32::consts::SQRT_2),
    ];
    for (name, got, want) in cases {
        assert!((got - want).abs() <= 1.0e-6, "{name}: {got} != {want}");
        assert_eq!(got.to_bits(), reference(name).to_bits(), "{name} is libm's bit pattern");
    }
}

fn reference(name: &str) -> f32 {
    match name {
        "sin" => libm::sinf(1.0),
        "cos" => libm::cosf(1.0),
        "tan" => libm::tanf(0.5),
        "atan2" => libm::atan2f(1.0, -1.0),
        "exp" => libm::expf(1.0),
        "ln" => libm::logf(10.0),
        "pow" => libm::powf(2.0, 0.5),
        _ => libm::sqrtf(2.0),
    }
}

#[test]
fn map_and_set_iterate_in_insertion_order() {
    let mut map: Map<&str, u32> = Map::default();
    for (i, key) in ["zeta", "alpha", "mid"].into_iter().enumerate() {
        map.insert(key, i as u32);
    }
    assert_eq!(map.keys().copied().collect::<Vec<_>>(), ["zeta", "alpha", "mid"]);
    let set: Set<u32> = [9, 1, 5].into_iter().collect();
    assert_eq!(set.iter().copied().collect::<Vec<_>>(), [9, 1, 5]);
}

#[test]
fn pcg32_matches_the_reference_stream() {
    // pcg32_srandom_r(42, 54) from O'Neill's pcg32-demo, the C++ template's Rng.
    let mut rng = Pcg32::new(42, 54);
    let first: Vec<u32> = (0..6).map(|_| rng.next_u32()).collect();
    assert_eq!(first, [0xa15c_02b7, 0x7b47_f409, 0xba1d_3330, 0x83d2_f293, 0xbfa4_784b, 0xcbed_606e]);
    let mut rng = Pcg32::seeded(7);
    for _ in 0..1000 {
        let unit = rng.unit();
        assert!((0.0..1.0).contains(&unit));
        assert!((-3..=3).contains(&rng.range_i32(3, -3)));
    }
}

#[test]
fn the_rng_names_models_reach_for_draw_the_same_stream() {
    // Bodycam B7: generated games call `rng.f32()` and `rng.range(a, b)`.
    let (mut by_alias, mut by_name) = (Pcg32::seeded(11), Pcg32::seeded(11));
    for _ in 0..100 {
        assert_eq!(by_alias.f32().to_bits(), by_name.unit().to_bits());
        assert_eq!(by_alias.range(-2.0, 3.0).to_bits(), by_name.range_f32(-2.0, 3.0).to_bits());
    }
    #[derive(Default)]
    struct Drift {
        x: f32,
    }
    let run = |alias: bool| {
        let mut game = genex::Game::new(Drift::default());
        if alias {
            game.on_update(|sim, ctx| sim.world.x += ctx.rng.f32() + ctx.rng.range(-2.0, 3.0));
        } else {
            game.on_update(|sim, ctx| sim.world.x += ctx.rng.unit() + ctx.rng.range_f32(-2.0, 3.0));
        }
        let mut runtime = genex::Runtime::new(game).expect("a game");
        runtime.seed(5);
        runtime.step(500.0);
        runtime.checksum()
    };
    assert_eq!(run(true), run(false), "ctx.rng.f32 and range are unit and range_f32");
}

#[test]
fn glam_is_scalar_so_gpu_structs_cannot_rely_on_its_alignment() {
    assert_eq!(core::mem::align_of::<glam::Vec4>(), 4);
    assert_eq!(core::mem::align_of::<glam::Mat4>(), 4);
    assert_eq!(core::mem::align_of::<glam::Quat>(), 4);
    assert_eq!(core::mem::size_of::<glam::Vec3>(), 12);
    let cols = genex::Transform::IDENTITY.to_cols_array();
    assert_eq!(cols, glam::Mat4::IDENTITY.to_cols_array());
}

/// `Cargo.lock` lists every optional dependency of every package, so nalgebra 0.35's never-enabled
/// `convert-glam030..032` bring glam 0.30-0.32 into the lock text; the acceptance rule is about
/// what is built: exactly one glam (0.33.x) in the feature-resolved graph for every target.
#[test]
fn the_built_graph_has_one_glam() {
    let manifest = concat!(env!("CARGO_MANIFEST_DIR"), "/../../Cargo.toml");
    let output = Command::new(env!("CARGO"))
        .args(["tree", "--offline", "--locked", "--workspace", "--target", "all", "--edges", "normal,build"])
        .args(["--prefix", "none", "--format", "{p}", "--manifest-path", manifest])
        .output()
        .expect("cargo tree runs");
    assert!(output.status.success(), "cargo tree: {}", String::from_utf8_lossy(&output.stderr));
    let tree = String::from_utf8(output.stdout).expect("utf-8");
    // `{p}` prints "glam v0.33.12" and a "(*)" suffix on repeats; keep the name and version.
    let mut glams: Vec<&str> = tree.lines().filter(|line| line.starts_with("glam v")).map(package).collect();
    glams.sort_unstable();
    glams.dedup();
    assert_eq!(glams.len(), 1, "glam versions built: {glams:?}");
    assert!(glams[0].starts_with("glam v0.33."), "{}", glams[0]);
}

fn package(line: &str) -> &str {
    line.split(" (").next().unwrap_or(line)
}

/// SF-1a: a game that parses a JSON level at reset (`gfx.assets().bytes`) and then draws from the
/// tick rng has one checksum, pinned here, on every target that runs this file (aarch64, x86_64,
/// wasm32), whichever shell's source served the bytes. The same game without the read differs, so
/// the read reached the first seed.
#[test]
fn a_level_read_at_reset_has_one_pinned_checksum() {
    use genex::prelude::*;
    use genex::{AssetTable, Runtime};
    const LEVEL: &[u8] = br#"{"enemies": 3, "spawn": [1.5, 0.0, -2.0]}"#;
    const TABLE: AssetTable = &[("levels/one.json", LEVEL)];
    #[derive(Default)]
    struct World {
        enemies: i64,
    }
    let game = |read: bool| {
        let mut game = Game::new(World::default()).world_size(64, 64);
        if read {
            game.on_reset(|sim, _, _, gfx| {
                let bytes = gfx.assets().bytes("levels/one.json").expect("the level reads at reset");
                let level = bytes.json().expect("JSON");
                sim.world.enemies = level["enemies"].as_i64().unwrap_or(-1);
            });
        }
        game.on_update(|sim, ctx| sim.world.enemies += i64::from(ctx.rng.below(3)));
        game.probe("enemies", |sim| json!(sim.world.enemies));
        game
    };
    let checksum = |read: bool| {
        let mut runtime = Runtime::with_assets(game(read), Box::new(TABLE)).expect("valid game");
        runtime.step(1000.0);
        runtime.checksum()
    };
    assert_eq!(checksum(true), "1e656e333231f976");
    assert_ne!(checksum(true), checksum(false));
}
