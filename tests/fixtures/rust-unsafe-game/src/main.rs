//! A trusted game's entry: the template's, with a game module that reads raw memory.

mod game;

use game::World;
use genex::prelude::*;

fn main() {
    let mut game = Game::new(World::default()).title("Unsafe Pond").world_size(960, 540);
    game::wire(&mut game);
    // ── FACET WIRING ── two lines per facet, nothing else: #[path = "facets/<slug>.rs"] mod <slug>; and <slug>::wire(&mut game);
    // ── END FACET WIRING ──
    genex::install(game);
}
