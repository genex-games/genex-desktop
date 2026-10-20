//! NAV-11 through the facade (new behaviour: `sim.nav` was an empty stub).
//!
//! - `game.navigation(cfg)` makes every seed rebuild `sim.nav` for that walker; a reset bakes a
//!   mesh into it and carving runs in the tick. Seed, reset with another seed, seed again: the
//!   nav probe is the same both times.
//! - A stream cell size that is not a whole number of nav tiles refuses `streaming-invalid`.
//! - Without physics, `NavInput::with_colliders` does not compile (a trybuild case, run by
//!   `cargo test -p genex --no-default-features --test nav`).

use genex::nav::{Nav, NavArea, NavConfig, NavInput, NavMesh, NavObstacle};
use genex::prelude::*;
use genex::{CellBuild, CellId, CellInputs, InstallErrorCode, Runtime, Streaming};
use serde_json::json;

#[derive(Default)]
struct World {
    crate_dropped: bool,
}

fn walker() -> NavConfig {
    NavConfig::walker(0.4, 1.8).with_tile(8.0)
}

/// A corridor 24 m by 3 m, and at tick 30 a crate dropped across it.
fn corridor_game() -> Game<World> {
    let mut game = Game::new(World::default());
    game.navigation(walker());
    game.on_reset(|sim, _, _, _| {
        assert_eq!(sim.nav.tile_count(), 0, "every seed starts from an empty nav");
        assert_eq!(sim.nav.config(), &walker(), "for the registered walker");
        let vertices = [vec3(0.0, 0.0, 0.0), vec3(24.0, 0.0, 0.0), vec3(24.0, 0.0, 3.0), vec3(0.0, 0.0, 3.0)];
        let input = NavInput::new().with_triangles(&vertices, &[0, 2, 1, 0, 3, 2], NavArea::WALK).expect("the corridor");
        let mesh = NavMesh::bake(&input, &walker()).expect("the mesh");
        sim.nav.add_mesh(&mesh).expect("the tiles");
    });
    game.on_update(|sim, ctx| {
        if ctx.tick == 30 && !sim.world.crate_dropped {
            let crate_box = Mat4::from_scale_rotation_translation(vec3(1.0, 1.0, 4.0), Quat::IDENTITY, vec3(8.0, 0.5, 1.5));
            sim.nav.add_obstacle(NavObstacle::CarveBox { transform: crate_box }).expect("the crate");
            sim.world.crate_dropped = true;
        }
        sim.nav.update(ctx.dt);
    });
    game.probe("nav", |sim| {
        json!({
            "tiles": sim.nav.tile_count(),
            "digest": format!("{:016x}", sim.nav.digest()),
            "pending": sim.nav.pending_rebuilds(),
            "obstacles": sim.nav.obstacles().count(),
        })
    });
    game
}

fn nav_probe(runtime: &Runtime<World>) -> serde_json::Value {
    runtime.probes()["nav"].clone()
}

/// Seed, run 60 ticks (the crate drops at 30 and settles), and read the probe at reset and at
/// the end.
fn run(runtime: &mut Runtime<World>, seed: u32) -> (serde_json::Value, serde_json::Value) {
    runtime.seed(seed);
    let at_reset = nav_probe(runtime);
    for _ in 0..60 {
        runtime.step(1000.0 / 60.0);
    }
    (at_reset, nav_probe(runtime))
}

#[test]
fn seed_reset_seed_gives_equal_nav_probes() {
    let mut runtime = Runtime::new(corridor_game()).expect("installs");
    assert!(runtime.start(), "the runtime runs");
    let first = run(&mut runtime, 1);
    assert_eq!(first.0["tiles"], json!(3));
    assert_eq!((first.0["pending"].clone(), first.0["obstacles"].clone()), (json!(0), json!(0)));
    assert_eq!(first.1["obstacles"], json!(1), "the crate dropped ({:?})", first.1);
    assert_eq!(first.1["pending"], json!(0), "and its two tiles settled within 30 ticks");
    assert_ne!(first.0["digest"], first.1["digest"], "the carved tiles changed");
    let other = run(&mut runtime, 2);
    assert_eq!(other.0, first.0, "a reset with another seed rebuilds the same nav here");
    let again = run(&mut runtime, 1);
    assert_eq!(again, first, "seed 1 again: equal probes at reset and after the crate");
}

#[test]
fn a_game_without_navigation_has_an_empty_default_nav() {
    let mut runtime = Runtime::new(Game::new(World::default())).expect("installs");
    runtime.seed(1);
    let nav: &Nav = &runtime.sim().nav;
    assert_eq!((nav.tile_count(), nav.pending_rebuilds()), (0, 0));
    assert_eq!(nav.config(), &NavConfig::default());
}

#[test]
fn a_stream_cell_that_splits_nav_tiles_refuses_streaming_invalid() {
    let refused = |cell: f32, tile: f32| {
        let mut game = Game::new(World::default());
        game.streaming(Streaming::grid(cell));
        game.cell_content(|_: CellId, _: &CellInputs| CellBuild::<u32>::default());
        game.navigation(NavConfig::walker(0.4, 1.8).with_tile(tile));
        Runtime::new(game).err().map(|error| error.code())
    };
    assert_eq!(refused(64.0, 16.0), None, "four tiles a cell");
    assert_eq!(refused(32.0, 32.0), None, "one tile a cell");
    assert_eq!(refused(40.0, 16.0), Some(InstallErrorCode::StreamingInvalid), "two and a half tiles a cell");
    assert_eq!(refused(32.0, 64.0), Some(InstallErrorCode::StreamingInvalid), "a tile larger than a cell");
}

#[cfg(not(feature = "physics"))]
#[test]
fn with_colliders_does_not_compile_without_physics() {
    let cases = trybuild::TestCases::new();
    cases.compile_fail("tests/ui/no_physics/nav_colliders_without_physics.rs");
}
