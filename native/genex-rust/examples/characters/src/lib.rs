//! characters (AN-21): animated characters on the genex facade, in a yard with a block and a
//! ladder. The hero is a simple animator (`play`, `crossfade`, `play_once`, `speed`); the duelist
//! a two-layer graph (locomotion on a `speed` parameter, a slash on the upper body with a `hit`
//! event); the climber a nav agent driven through the documented loop that plays its climb clip
//! between `take_link` and `finish_link`; and 30 walkers. The mannequin GLB is written in code
//! ([`mannequin::glb`]), so no asset file ships and every destination reads the same bytes.
//!
//! The same [`game`] runs natively (`src/main.rs`) and on the web (this library as a wasm-bindgen
//! `cdylib`).

pub mod mannequin;
mod scene;

pub use scene::{ClimbTotals, Clips, HERO_LOOP_TICKS, OBSERVER_EYE, Placed, WALKERS, World, game_camera};

use std::sync::LazyLock;

use genex::prelude::*;

/// The game's name in the shell.
pub const NAME: &str = "characters";
/// The world target size.
pub const WORLD_SIZE: [u32; 2] = [960, 540];
/// The demo the self-test runs by default: watch the yard for ten seconds.
pub const DEFAULT_DEMO: &str = "watch";

/// The game's assets: the mannequin, written once per process.
pub fn assets() -> genex::AssetTable {
    static TABLE: LazyLock<genex::AssetTable> = LazyLock::new(|| {
        let glb: &'static [u8] = Box::leak(mannequin::glb().into_boxed_slice());
        Box::leak(vec![(mannequin::MANNEQUIN, glb)].into_boxed_slice())
    });
    *TABLE
}

/// characters, with every hook registered.
pub fn game() -> Game<World> {
    let mut game = Game::new(World::default()).title("Characters").world_size(WORLD_SIZE[0], WORLD_SIZE[1]);
    scene::wire(&mut game);
    game
}

/// The web entry: hand the game to the web shell when the module is instantiated.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen(start)]
pub fn start() {
    genex_platform_web::install_named(NAME, game(), assets());
}
