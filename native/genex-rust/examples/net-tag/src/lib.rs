//! net-tag (multiplayer MP-6a): two teams chase one tag across a walled arena. The game follows
//! the net page's feel rules: nothing touches the network until the player picks Play online
//! (Bots stays offline), you move yourself locally on the input tick, remote players draw their
//! smoothed `state()` while every gameplay rule reads `state_raw()`, the host alone writes the
//! shared `teams` and `score` keys, the tag is written only after an accepted claim (and the new
//! host re-claims it from its last raw state when the host leaves), and a round plays only while
//! two players are connected.
//!
//! The same [`game`] runs natively (`src/main.rs`) and on the web (this library as a wasm-bindgen
//! `cdylib`).

mod tag;
mod teams;

pub use tag::{
    ARENA_HALF, DEMOS, MIN_PLAYERS, Mode, Phase, SHARED_SCORE, SHARED_TEAMS, TAG_OBJECT, TAG_RADIUS, World, tag_probe,
};
pub use teams::{BLUE, RED, reconcile};

use genex::prelude::*;

/// The game's name in the shell.
pub const NAME: &str = "net-tag";
/// The world target size.
pub const WORLD_SIZE: [u32; 2] = [960, 540];

/// net-tag, with every hook registered.
pub fn game() -> Game<World> {
    let mut game = Game::new(World::default()).title("Net tag").world_size(WORLD_SIZE[0], WORLD_SIZE[1]);
    tag::wire(&mut game);
    game
}

/// The web entry: hand the game to the web shell when the module is instantiated.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen(start)]
pub fn start() {
    genex_platform_web::install_named(NAME, game(), &[]);
}
