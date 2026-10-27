//! A lit interior room: the entry file of `docs/examples/interior-room`, a complete game folder's
//! `src/` you can copy whole. The room itself is `game.rs`.

mod game;

use game::World;
use genex::prelude::*;

fn main() {
    let mut game = Game::new(World::default()).title("Interior room").world_size(960, 540).fit(Fit::Expand);
    game::wire(&mut game);
    // ── FACET WIRING ── two lines per facet, nothing else: #[path = "facets/<slug>.rs"] mod <slug>; and <slug>::wire(&mut game);
    // ── END FACET WIRING ──
    genex::install(game);
}
