//! A third-person character: the entry file of `docs/examples/third-person`, a complete game
//! folder's `src/` you can copy whole. The hero, its rig, the orbit camera and the yard are
//! `game.rs`.

mod game;

use game::World;
use genex::prelude::*;

fn main() {
    let mut game = Game::new(World::default()).title("Third person").world_size(960, 540).fit(Fit::Expand);
    game::wire(&mut game);
    // ── FACET WIRING ── two lines per facet, nothing else: #[path = "facets/<slug>.rs"] mod <slug>; and <slug>::wire(&mut game);
    // ── END FACET WIRING ──
    genex::install(game);
}
