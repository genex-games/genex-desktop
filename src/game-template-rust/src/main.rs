//! The game's entry. The starter in `game.rs` only proves the pipeline: a floor and one turning
//! block under the physical sky, and a gear button for the graphics settings, so the very first
//! frame shows something drawn. Replace it with the game in the brief, and keep two things:
//! `genex::install(game)` at the end of `main`, and the FACET WIRING block, where every other
//! facet adds exactly its two lines.

mod game;

use game::World;
use genex::prelude::*;

fn main() {
    let mut game = Game::new(World::default()).title("__GAME_TITLE__").world_size(960, 540);
    game::wire(&mut game);
    // ── FACET WIRING ── two lines per facet, nothing else: #[path = "facets/<slug>.rs"] mod <slug>; and <slug>::wire(&mut game);
    // ── END FACET WIRING ──
    genex::install(game);
}
