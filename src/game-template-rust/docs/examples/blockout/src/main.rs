//! The blockout: the entry file of `docs/examples/blockout`, a game folder's `src/` you can copy
//! whole. `plan.rs` is the level plan as data; `game.rs` builds the greybox, the cameras and the
//! `level` probe from it.

mod game;
mod plan;

use game::World;
use genex::prelude::*;

fn main() {
    let mut game = Game::new(World).title("Blockout").world_size(960, 540).fit(Fit::Expand);
    game::wire(&mut game, &plan::PLAN);
    // ── FACET WIRING ── two lines per facet, nothing else: #[path = "facets/<slug>.rs"] mod <slug>; and <slug>::wire(&mut game);
    // ── END FACET WIRING ──
    genex::install(game);
}
