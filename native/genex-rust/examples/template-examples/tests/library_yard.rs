//! The library-yard example (`src/game-template-rust/docs/examples/library-yard`) as a game gets
//! it: without the library entries it draws its stand-ins and names each missing entry; with them
//! (a folder laid out as a game's `assets/`, staged by `scripts/library/build-library.ts stage`)
//! every entry reads and, on the host GPU, the yard is captured:
//!
//!   node scripts/library/build-library.ts stage <assets> --only <the yard's ids>
//!   GENEX_REQUIRE_METAL=1 GENEX_EXAMPLES_ASSETS=<assets> node scripts/toolchains/rust-env.ts -- \
//!     cargo test -p template-examples --release --offline --locked --test library_yard -- --ignored metal --nocapture

#[path = "../../../../../src/game-template-rust/docs/examples/library-yard/src/game.rs"]
mod game;
mod support;

use genex::render::{QualityPreset, RenderConfig};
use genex::{FIXED_STEP_MS, Game, Runtime, View};

use game::World;

const GENEX_TOML: &str = include_str!("../../../../../src/game-template-rust/docs/examples/library-yard/genex.toml");
const WORLD_SIZE: [u32; 2] = [1600, 900];
/// Every entry the yard reads.
const ENTRIES: [&str; 7] = [game::ASPHALT, game::BRICK, game::SNOW, game::BENCH, game::BARREL, game::CRATE, game::SKY];

fn yard() -> Game<World> {
    let mut game = Game::new(World::default()).title("Library yard").world_size(WORLD_SIZE[0], WORLD_SIZE[1]);
    game::wire(&mut game);
    game.render_settings(RenderConfig::from_toml(GENEX_TOML).expect("the example's [render] is admitted"));
    game
}

fn started(assets: genex::AssetTable) -> Runtime<World> {
    let mut runtime = Runtime::with_assets(yard(), Box::new(assets)).expect("the example installs");
    runtime.seed(1);
    runtime.start();
    runtime.step(FIXED_STEP_MS * 10.0);
    runtime
}

#[test]
fn without_the_library_entries_the_yard_draws_its_stand_ins_and_names_each_missing_entry() {
    let mut runtime = started(&[]);
    let missing = runtime.state()["library"]["missing"].clone();
    assert_eq!(missing, genex::json!(ENTRIES), "every entry refused missing");
    let frame = runtime.frame(View::Game).expect("a frame");
    let tags: Vec<&str> = frame.draws().iter().map(|draw| draw.tag.as_str()).collect();
    for tag in ["ground", "wall", "props"] {
        assert!(tags.contains(&tag), "the yard draws {tag}");
    }
}

#[test]
#[ignore = "needs the staged library entries and a GPU: run with --ignored metal"]
fn metal_the_yard_reads_every_library_entry_and_captures_at_low_and_high() {
    let assets = support::assets(&[]);
    let mut runtime = started(assets);
    let missing = runtime.state()["library"]["missing"].clone();
    assert_eq!(missing, genex::json!([]), "GENEX_EXAMPLES_ASSETS holds every entry the yard reads");
    let Some(mut presenter) = support::presenter(WORLD_SIZE, assets) else { return };
    assert!(presenter.install_for(&mut runtime).is_empty());
    for preset in [QualityPreset::Low, QualityPreset::High] {
        let luma = support::shoot(&mut presenter, &mut runtime, View::Game, preset, "library-yard");
        eprintln!("library-yard {}: mean luma {luma:.1}", preset.wire());
        assert!((20.0..235.0).contains(&luma), "the yard at {} is neither black nor blown out: {luma}", preset.wire());
    }
    let state = runtime.state();
    assert!(state["__render"].get("missingModels").is_none(), "{:?}", state["__render"]);
}
