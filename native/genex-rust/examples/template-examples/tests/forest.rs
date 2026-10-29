//! The forest example (`src/game-template-rust/docs/examples/forest`) as a game gets it: every
//! stand of the winter grove and the summer forest grows and draws, with no asset file, the same
//! seed places the same plants, and (on the host GPU) captures of both areas close up, at the
//! hero birch's bark and wide over the far stands, plus two captures a second apart that the wind
//! tells apart:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p template-examples \
//!     --release --offline --locked --test forest -- --ignored metal --nocapture

#[path = "../../../../../src/game-template-rust/docs/examples/forest/src/game.rs"]
mod game;
mod support;

use genex::render::{QualityPreset, RenderConfig};
use genex::{FIXED_STEP_MS, Game, Runtime, View};

use game::World;

const GENEX_TOML: &str = include_str!("../../../../../src/game-template-rust/docs/examples/forest/genex.toml");
const WORLD_SIZE: [u32; 2] = [1600, 900];
/// The tags every frame draws: each stand and the heroes (the terrain is no tagged draw).
const TAGS: [&str; 13] = ["winter-birch", "dead-birch", "winter-shrub", "straw", "winter-spruce", "oak", "maple", "pine", "willow", "shrub", "grass", "summer-spruce", "heroes"];

fn forest() -> Game<World> {
    let mut game = Game::new(World::default()).title("Forest").world_size(WORLD_SIZE[0], WORLD_SIZE[1]);
    game::wire(&mut game);
    game.render_settings(RenderConfig::from_toml(GENEX_TOML).expect("the example's [render] is admitted"));
    game
}

fn started(seed: u32) -> Runtime<World> {
    let mut runtime = Runtime::with_assets(forest(), Box::new(support::assets(&[]))).expect("the example installs");
    runtime.seed(seed);
    runtime.start();
    runtime.step(FIXED_STEP_MS * 10.0);
    runtime
}

#[test]
fn every_stand_grows_and_draws_without_an_asset_file() {
    let mut runtime = started(1);
    let frame = runtime.frame(View::Game).expect("a frame");
    let tags: Vec<&str> = frame.draws().iter().map(|draw| draw.tag.as_str()).collect();
    for tag in TAGS {
        assert!(tags.contains(&tag), "the example draws {tag}");
    }
    let forest = runtime.state()["forest"].clone();
    eprintln!("forest: {forest}");
    assert_eq!(forest["heroes"], 2);
    assert!(forest["plants"].as_u64() > Some(1500), "a dense forest: {forest}");
    assert!(forest["byTag"]["winter-birch"].as_u64() > Some(15), "a grove of birches: {forest}");
    assert!(forest["byTag"]["grass"].as_u64() > Some(500), "ground cover: {forest}");
}

#[test]
fn the_same_seed_places_the_same_forest() {
    let placed = |seed| started(seed).state()["forest"].clone();
    assert_eq!(placed(1), placed(1));
    assert_ne!(placed(1)["firstAt"], placed(2)["firstAt"], "another seed scatters another forest");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_grove_and_the_forest_capture_close_wide_and_in_the_wind() {
    let Some(mut presenter) = support::presenter(WORLD_SIZE, support::assets(&[])) else { return };
    let mut runtime = started(1);
    assert!(presenter.install_for(&mut runtime).is_empty());
    runtime.step(FIXED_STEP_MS * 120.0);
    let views = [
        (View::Game, "forest-grove"),
        (View::Named("grove-bark"), "forest-grove-bark"),
        (View::Named("grove-wide"), "forest-grove-wide"),
        (View::Named("summer"), "forest-summer"),
        (View::Named("summer-wide"), "forest-summer-wide"),
    ];
    for preset in [QualityPreset::High, QualityPreset::Low] {
        for (view, name) in views {
            let luma = support::shoot(&mut presenter, &mut runtime, view, preset, name);
            eprintln!("{name} {}: mean luma {luma:.1}", preset.wire());
            assert!((20.0..235.0).contains(&luma), "{name} at {} is neither black nor blown out: {luma}", preset.wire());
        }
    }
    // The wind: the summer forest a second later is not the same picture.
    let before = shot(&mut presenter, &mut runtime, View::Named("summer"), "forest-summer-wind-a");
    runtime.step(FIXED_STEP_MS * 60.0);
    let after = shot(&mut presenter, &mut runtime, View::Named("summer"), "forest-summer-wind-b");
    let moved = before.iter().zip(&after).filter(|(a, b)| a.abs_diff(**b) > 12).count() as f32 / before.len() as f32;
    eprintln!("wind: {:.1}% of channels moved by more than 12 in a second", moved * 100.0);
    assert!(moved > 0.01, "the leaves and branches move in the wind: {moved}");
    let state = runtime.state();
    let render = &state["__render"];
    assert!(render.get("missingModels").is_none(), "{render:?}");
    assert!(render.get("lodRefused").is_none(), "{render:?}");
}

/// A settled capture of `view` at High, written as `<name>-high.png`; answers its BGRA texels.
fn shot(presenter: &mut genex::present::Presenter, runtime: &mut Runtime<World>, view: View<'_>, name: &str) -> Vec<u8> {
    support::shoot(presenter, runtime, view, QualityPreset::High, name);
    let capture = presenter.resilient.capture().expect("capture");
    capture.bgra().to_vec()
}
