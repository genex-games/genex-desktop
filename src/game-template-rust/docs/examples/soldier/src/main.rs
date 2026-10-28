//! The soldier kit's example: the entry file of `docs/examples/soldier`, a complete game folder's
//! `src/` you can copy whole. `game.rs` plays a scripted remote soldier's replicated state and frames
//! it close; `soldier.rs` animates the kit (`assets/kits/soldier.glb`) from that state alone.

mod game;

use game::World;
use genex::prelude::*;

fn main() {
    let mut game = Game::new(World::default()).title("Soldier kit").world_size(960, 540).fit(Fit::Expand);
    game::wire(&mut game);
    // ── FACET WIRING ── two lines per facet, nothing else: #[path = "facets/<slug>.rs"] mod <slug>; and <slug>::wire(&mut game);
    #[path = "facets/soldier.rs"] mod soldier;
    soldier::wire(&mut game);
    // ── END FACET WIRING ──
    genex::install(game);
}
