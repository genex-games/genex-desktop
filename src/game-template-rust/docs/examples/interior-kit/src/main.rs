//! A school corridor and classroom built from the interior kit: the entry file of
//! `docs/examples/interior-kit`, a complete game folder's `src/` you can copy whole. The level is
//! `game.rs`; the kit's pieces, sheets and decals are `assets/kit/`.

mod game;

use game::World;
use genex::prelude::*;

fn main() {
    let mut game = Game::new(World::default()).title("Interior kit").world_size(960, 540).fit(Fit::Expand);
    game::wire(&mut game);
    // ── FACET WIRING ── two lines per facet, nothing else: #[path = "facets/<slug>.rs"] mod <slug>; and <slug>::wire(&mut game);
    // ── END FACET WIRING ──
    genex::install(game);
}
