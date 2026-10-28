//! The crowd example (`src/game-template-rust/docs/examples/crowd`) as a game gets it: 120 walkers
//! on a baked nav mesh keep arriving at the stalls without sticking, the same seed walks the same
//! crowd, a missing walker GLB draws blocks, and (on the host GPU) captures over the square, at
//! eye level in a gate and with the nav mesh and paths drawn:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p template-examples \
//!     --release --offline --locked --test crowd -- --ignored metal --nocapture
//!
//! The walker is the characters example's mannequin, whose `Idle` and `Walk` clips the example names.

#[path = "../../../../../src/game-template-rust/docs/examples/crowd/src/game.rs"]
mod game;
mod support;

use genex::render::{QualityPreset, RenderConfig};
use genex::{FIXED_STEP_MS, Game, Runtime, View};

use game::World;

const GENEX_TOML: &str = include_str!("../../../../../src/game-template-rust/docs/examples/crowd/genex.toml");
const WORLD_SIZE: [u32; 2] = [1280, 720];

fn crowd() -> Game<World> {
    let mut game = Game::new(World::default()).title("Crowd").world_size(WORLD_SIZE[0], WORLD_SIZE[1]);
    game::wire(&mut game);
    game.render_settings(RenderConfig::from_toml(GENEX_TOML).expect("the example's [render] is admitted"));
    game
}

fn assets(walker: bool) -> genex::AssetTable {
    let glb = if walker { vec![("characters/walker.glb", characters_game::mannequin::glb())] } else { Vec::new() };
    support::assets(&glb)
}

fn started(walker: bool, seed: u32) -> Runtime<World> {
    let mut runtime = Runtime::with_assets(crowd(), Box::new(assets(walker))).expect("the example installs");
    runtime.seed(seed);
    runtime.start();
    runtime.step(FIXED_STEP_MS * 30.0);
    runtime
}

#[test]
fn the_square_its_trees_and_every_walker_draw_animated_or_as_blocks() {
    for walker in [true, false] {
        let mut runtime = started(walker, 1);
        let frame = runtime.frame(View::Game).expect("a frame");
        let tags: Vec<&str> = frame.draws().iter().map(|draw| draw.tag.as_str()).collect();
        for tag in ["square", "trees", "crowd"] {
            assert!(tags.contains(&tag), "the example draws {tag} (glb: {walker})");
        }
        let crowd = runtime.state()["crowd"].clone();
        assert_eq!(crowd["walkers"], game::WALKERS);
        assert_eq!(crowd["animated"], if walker { game::WALKERS } else { 0 }, "{crowd}");
    }
}

#[test]
fn over_half_a_minute_the_crowd_keeps_arriving_at_the_stalls_and_none_sticks() {
    let mut runtime = started(true, 1);
    runtime.step(FIXED_STEP_MS * 1800.0);
    let crowd = runtime.state()["crowd"].clone();
    eprintln!("crowd after 30 s: {crowd}");
    // A few walkers are still in the jam at a stall corner at 30 s (seed 1: 3 of 120); none stands still.
    assert!(crowd["arrivedOnce"].as_u64() >= Some(110), "nearly every walker arrived at least once: {crowd}");
    assert!(crowd["arrivals"].as_u64() >= Some(240), "the crowd keeps moving between stalls: {crowd}");
    assert_eq!(crowd["stuck"], 0, "no walker stood stuck for two seconds: {crowd}");
}

#[test]
fn the_same_seed_walks_the_same_crowd() {
    let walk = |seed| {
        let mut runtime = started(true, seed);
        runtime.step(FIXED_STEP_MS * 300.0);
        runtime.state()["nav"]["digest"].clone()
    };
    let first = walk(1);
    assert!(!first.is_null(), "the nav probe carries an agents digest");
    assert_eq!(first, walk(1), "seed 1 twice walks the same crowd");
    assert_ne!(first, walk(2), "another seed sends it elsewhere");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_crowd_captures_over_the_square_in_the_gate_and_on_the_nav_mesh() {
    let Some(mut presenter) = support::presenter(WORLD_SIZE, assets(true)) else { return };
    let mut runtime = started(true, 1);
    assert!(presenter.install_for(&mut runtime).is_empty());
    runtime.step(FIXED_STEP_MS * 300.0);
    for preset in [QualityPreset::Low, QualityPreset::High] {
        for (view, name) in [(View::Game, "crowd"), (View::Named("street"), "crowd-street"), (View::Named("nav"), "crowd-nav")] {
            let luma = support::shoot(&mut presenter, &mut runtime, view, preset, name);
            eprintln!("{name} {}: mean luma {luma:.1}", preset.wire());
            assert!((20.0..235.0).contains(&luma), "{name} at {} is neither black nor blown out: {luma}", preset.wire());
        }
    }
    let state = runtime.state();
    assert!(state["__render"].get("missingModels").is_none(), "{:?}", state["__render"]);
}
