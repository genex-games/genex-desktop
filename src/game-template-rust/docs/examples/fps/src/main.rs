//! An FPS facet set: the entry file of `docs/examples/fps`, a complete game folder's `src/` you can
//! copy whole. `game.rs` owns the player, the camera, the hall and the HUD; each facet adds one
//! part and is wired in the block below, in the order their updates must run (the weapon's shot
//! before the enemy reads it).

mod game;

use game::World;
use genex::prelude::*;

fn main() {
    let mut game = Game::new(World::default()).title("FPS").world_size(960, 540).fit(Fit::Expand);
    game::wire(&mut game);
    // ── FACET WIRING ── two lines per facet, nothing else: #[path = "facets/<slug>.rs"] mod <slug>; and <slug>::wire(&mut game);
    #[path = "facets/viewmodel.rs"] mod viewmodel;
    viewmodel::wire(&mut game);
    #[path = "facets/weapon.rs"] mod weapon;
    weapon::wire(&mut game);
    #[path = "facets/enemy.rs"] mod enemy;
    enemy::wire(&mut game);
    // ── END FACET WIRING ──
    genex::install(game);
}
