//! The look recipes: the entry file of `docs/examples/looks`, a game folder's `src/` you can copy
//! whole. The recipes are `looks.rs` (copy your scene's two functions); `game.rs` is a greybox
//! stage that shows one of them. Change `SCENE` to see another.

mod game;
mod looks;

use game::World;
use genex::prelude::*;
use genex::render::RenderConfig;
use looks::Scene;

/// The recipe this build shows.
const SCENE: Scene = Scene::InteriorDay;

fn main() {
    let mut game = Game::new(World::default()).title("Looks").world_size(960, 540).fit(Fit::Expand);
    game.render_settings(SCENE.look(RenderConfig::from_build()));
    game::wire(&mut game, SCENE);
    // ── FACET WIRING ── two lines per facet, nothing else: #[path = "facets/<slug>.rs"] mod <slug>; and <slug>::wire(&mut game);
    // ── END FACET WIRING ──
    genex::install(game);
}
