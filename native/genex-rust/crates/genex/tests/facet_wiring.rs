//! The entry file's union-merged `// FACET WIRING` block: one `#[path] mod` line and one
//! `wire(&mut game)` line per facet, both inside the block, so a line-based union merge of two
//! facet workers (and its dedupe of identical lines) yields a compiling entry file.

use genex::Runtime;
use genex::prelude::*;

#[derive(Default)]
/// The entry file's world; facets reach it as `super::World`.
struct World {
    purchases: u32,
}

fn build() -> Game<World> {
    let mut game = Game::new(World::default()).title("Facets");
    // ── FACET WIRING ── two lines per facet, nothing else
    #[path = "facets/fishing.rs"] mod fishing;
    #[path = "facets/shop.rs"] mod shop;
    fishing::wire(&mut game);
    shop::wire(&mut game);
    // ── END FACET WIRING ──
    game
}

#[test]
fn facets_wired_from_the_block_keep_private_state_reset_on_seed() {
    let mut rt = Runtime::new(build()).expect("two facets install");
    rt.seed(1);
    rt.inject(Input::key_tap(Key::Space).and(Input::key_tap(Key::KeyB)));
    rt.step(50.0);
    assert_eq!(rt.probes()["fishing"], json!({ "casts": 1 }));
    assert_eq!(rt.probes()["shop"], json!({ "coins": 9 }));
    assert_eq!(rt.sim().world.purchases, 1);
    rt.seed(1);
    assert_eq!(rt.probes()["fishing"], json!({ "casts": 0 }));
    assert_eq!(rt.probes()["shop"], json!({ "coins": 10 }));
}

#[test]
#[should_panic(expected = "facet state")]
fn reading_an_unregistered_facet_state_names_the_fix() {
    struct Unregistered;
    let sim_game = Game::new(World::default());
    let mut rt = Runtime::new(sim_game).expect("installs");
    rt.seed(1);
    let _ = rt.sim().facets.get::<Unregistered>();
}
