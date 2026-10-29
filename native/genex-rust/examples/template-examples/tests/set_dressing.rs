//! The set-dressing example (`src/game-template-rust/docs/examples/set-dressing`) as a game gets
//! it: its genex.toml admitted, its shell and furniture built meshes, every dressing layer placed
//! from the seed (the same on every reset), its wear within what a desktop draws, and (on the host
//! GPU) a capture of the room and the street per preset with the interior kit's decals:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- \
//!     cargo test -p template-examples --release --offline --locked --test set_dressing -- --ignored metal --nocapture

#[path = "../../../../../src/game-template-rust/docs/examples/set-dressing/src/game.rs"]
mod game;
mod support;

use std::path::Path;

use genex::render::{QualityPreset, RenderConfig};
use genex::{FIXED_STEP_MS, Game, Runtime, View};

use game::World;

const GENEX_TOML: &str = include_str!("../../../../../src/game-template-rust/docs/examples/set-dressing/genex.toml");
/// The interior kit's assets: the decals the wear layers draw.
const KIT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../src/game-template-rust/docs/examples/interior-kit/assets");
const WORLD_SIZE: [u32; 2] = [1280, 720];
/// The decals a desktop preset draws at most: every one of the set's is drawn.
const DESKTOP_DECALS: usize = 64;

fn set() -> Game<World> {
    let mut game = Game::new(World::default()).title("Set dressing").world_size(WORLD_SIZE[0], WORLD_SIZE[1]);
    game::wire(&mut game);
    game.render_settings(game::look(RenderConfig::from_toml(GENEX_TOML).expect("the example's [render] is admitted")));
    game
}

fn started(seed: u32) -> Runtime<World> {
    let mut runtime = Runtime::with_assets(set(), Box::new(support::assets(&support::folder(Path::new(KIT))))).expect("the example installs");
    runtime.seed(seed);
    runtime.start();
    runtime.step(FIXED_STEP_MS * 10.0);
    runtime
}

#[test]
fn every_layer_places_from_the_seed_and_the_set_draws_built_meshes() {
    let mut runtime = started(1);
    let layers = runtime.state()["dressing"]["layers"].clone();
    for layer in ["rubble", "plaster", "papers", "grime", "leaks", "posters", "stains", "lamps", "bollards", "bins", "litter", "street-rubble", "puddles", "cracks", "street-posters", "street-grime"] {
        assert!(layers[layer].as_u64().unwrap_or(0) > 0, "the dressing places {layer}: {layers}");
    }
    assert!(layers["rubble"].as_u64().unwrap_or(0) > 40 && layers["papers"].as_u64().unwrap_or(0) > 40, "dense clutter: {layers}");
    let frame = runtime.frame(View::Game).expect("a frame");
    let tags: Vec<&str> = frame.draws().iter().map(|draw| draw.tag.as_str()).collect();
    for tag in ["shell", "furniture", "rubble", "street", "litter"] {
        assert!(tags.contains(&tag), "the set draws {tag}");
    }
    let shapes: Vec<String> = frame.draws().iter().map(|draw| format!("{:?}", draw.shape)).collect();
    assert!(shapes.iter().all(|shape| !shape.contains("Cube")), "no plain cube anywhere");
    assert!(shapes.iter().any(|shape| shape.contains(genex::MESH_PATH_PREFIX)), "built meshes");
    let decals = frame.decals();
    assert!((30..=DESKTOP_DECALS).contains(&decals.len()), "enough wear to read, within what a desktop draws: {}", decals.len());
    let again = started(9).state()["dressing"].clone();
    assert_eq!(runtime.state()["dressing"], again, "the dressing comes from its own seed, not the run's");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_room_and_the_street_capture_at_low_and_high() {
    let assets = support::assets(&support::folder(Path::new(KIT)));
    let Some(mut presenter) = support::presenter(WORLD_SIZE, assets) else { return };
    let mut runtime = started(1);
    assert!(presenter.install_for(&mut runtime).is_empty());
    for (view, name) in [(View::Game, "set-dressing-room"), (View::Named("street"), "set-dressing-street")] {
        for preset in [QualityPreset::Low, QualityPreset::High] {
            let luma = support::shoot(&mut presenter, &mut runtime, view, preset, name);
            eprintln!("{name} {}: mean luma {luma:.1}", preset.wire());
            assert!((20.0..235.0).contains(&luma), "{name} at {} is neither black nor blown out: {luma}", preset.wire());
        }
    }
    let state = runtime.state();
    assert!(state["__render"].get("missingModels").is_none(), "{:?}", state["__render"]);
}
