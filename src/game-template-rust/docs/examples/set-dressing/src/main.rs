//! A dressed room and street: the entry file of `docs/examples/set-dressing`, a complete game
//! folder's `src/` you can copy whole. The set itself is `game.rs`.

mod game;

use game::World;
use genex::prelude::*;

fn main() {
    let mut game = Game::new(World::default()).title("Set dressing").world_size(960, 540).fit(Fit::Expand);
    game::wire(&mut game);
    // ── FACET WIRING ── two lines per facet, nothing else: #[path = "facets/<slug>.rs"] mod <slug>; and <slug>::wire(&mut game);
    // ── END FACET WIRING ──
    genex::install(game);
}
