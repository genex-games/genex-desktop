//! Menus and saves: the entry file of `docs/examples/menus-saves`, a complete game folder's `src/`
//! you can copy whole. The courtyard, its menus and its save slots are `game.rs`.

mod game;

use game::World;
use genex::prelude::*;

fn main() {
    let mut game = Game::new(World::default()).title("Menus and saves").world_size(960, 540).fit(Fit::Expand);
    game::wire(&mut game);
    // ── FACET WIRING ── two lines per facet, nothing else: #[path = "facets/<slug>.rs"] mod <slug>; and <slug>::wire(&mut game);
    // ── END FACET WIRING ──
    genex::install(game);
}
