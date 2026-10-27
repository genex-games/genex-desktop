//! The interior-room example (`src/game-template-rust/docs/examples/interior-room`) as a game gets
//! it: its genex.toml admitted, every part drawn with a probe and a volume per room, and (on the
//! host GPU) a capture per preset:
//!
//!   GENEX_REQUIRE_METAL=1 GENEX_EXAMPLES_ASSETS=<assets> node scripts/toolchains/rust-env.ts -- \
//!     cargo test -p template-examples --release --offline --locked --test interior_room -- --ignored metal --nocapture

#[path = "../../../../../src/game-template-rust/docs/examples/interior-room/src/game.rs"]
mod game;
mod support;

use genex::render::{QualityPreset, RenderConfig};
use genex::{FIXED_STEP_MS, Game, Runtime, View};

use game::World;

const GENEX_TOML: &str = include_str!("../../../../../src/game-template-rust/docs/examples/interior-room/genex.toml");
const WORLD_SIZE: [u32; 2] = [1280, 720];

/// The example as its `main.rs` builds it, with its genex.toml's `[render]` as a lane build reads it.
fn room() -> Game<World> {
    let mut game = Game::new(World::default()).title("Interior room").world_size(WORLD_SIZE[0], WORLD_SIZE[1]);
    game::wire(&mut game);
    game.render_settings(game::look(RenderConfig::from_toml(GENEX_TOML).expect("the example's [render] is admitted")));
    game
}

fn started() -> Runtime<World> {
    let mut runtime = Runtime::with_assets(room(), Box::new(support::assets(&[]))).expect("the example installs");
    runtime.seed(1);
    runtime.start();
    runtime.step(FIXED_STEP_MS * 30.0);
    runtime
}

#[test]
fn the_room_draws_its_shell_furniture_and_lamps_with_a_probe_and_volume_per_room() {
    let mut runtime = started();
    let frame = runtime.frame(View::Game).expect("a frame");
    let tags: Vec<&str> = frame.draws().iter().map(|draw| draw.tag.as_str()).collect();
    for tag in ["outside", "shell", "furniture", "lamps"] {
        assert!(tags.contains(&tag), "the room draws {tag}");
    }
    assert_eq!(frame.decals().len(), 5, "grime under both sills, a poster, a puddle and a stain");
}

#[test]
fn the_flickering_tube_drops_out_and_comes_back() {
    let mut runtime = started();
    let mut seen = std::collections::BTreeSet::new();
    for _ in 0..200 {
        runtime.step(FIXED_STEP_MS);
        seen.insert(runtime.state()["room"]["flicker"].as_bool());
    }
    assert_eq!(seen.len(), 2, "the tube is both on and off over 200 ticks: {seen:?}");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_room_captures_at_low_and_high_from_each_camera() {
    let Some(mut presenter) = support::presenter(WORLD_SIZE, support::assets(&[])) else { return };
    let mut runtime = started();
    assert!(presenter.install_for(&mut runtime).is_empty());
    for (view, name) in [(View::Game, "interior-room"), (View::Named("windows"), "interior-windows"), (View::Named("door"), "interior-door")] {
        for preset in [QualityPreset::Low, QualityPreset::High] {
            let luma = support::shoot(&mut presenter, &mut runtime, view, preset, name);
            eprintln!("{name} {}: mean luma {luma:.1}", preset.wire());
            assert!((20.0..235.0).contains(&luma), "{name} at {} is neither black nor blown out: {luma}", preset.wire());
        }
    }
    let state = runtime.state();
    assert!(state["__render"].get("missingModels").is_none(), "{:?}", state["__render"]);
}
