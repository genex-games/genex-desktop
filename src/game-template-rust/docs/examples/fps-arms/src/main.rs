//! The first-person arms kit's example: the entry file of `docs/examples/fps-arms`, a complete
//! game folder's `src/` you can copy whole. `game.rs` owns the player, the camera, the range and
//! the HUD; `rifle.rs` rules the rifle and `viewmodel.rs` shows it with the kit
//! (`assets/kits/fps-arms.glb`). The rifle's rules run before the view model reads them.

mod game;

use game::World;
use genex::prelude::*;

fn main() {
    let mut game = Game::new(World::default()).title("FPS arms").world_size(960, 540).fit(Fit::Expand);
    game::wire(&mut game);
    // ── FACET WIRING ── two lines per facet, nothing else: #[path = "facets/<slug>.rs"] mod <slug>; and <slug>::wire(&mut game);
    #[path = "facets/rifle.rs"] mod rifle;
    rifle::wire(&mut game);
    #[path = "facets/viewmodel.rs"] mod viewmodel;
    viewmodel::wire(&mut game);
    // ── END FACET WIRING ──
    genex::install(game);
}
