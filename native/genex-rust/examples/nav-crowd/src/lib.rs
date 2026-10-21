//! nav-crowd (NAV-17): 200 agents walk between the stalls of a walled market on a 128 m terrain.
//! The market has two floors joined by a stair ramp and a ladder link, a drop from the upper
//! floor, an east gate that shuts on a timer (a door area), a player body pushed round a loop and
//! a crate carved into the mesh at tick 600. Every agent is a character capsule moved through the
//! documented nav loop (`sim.nav.update`, the desired velocity, `Character::drive`,
//! `nav.set_position`); there is no nav driver. The `crowd` eye draws the nav debug overlay.
//!
//! The same [`game`] runs natively (`src/main.rs`) and on the web (this library as a wasm-bindgen
//! `cdylib`).

mod crowd;

pub use crowd::{
    AGENTS, CRATE_TICK, CROWD_EYE, CrowdTotals, DOOR_PERIOD_TICKS, STALL_TICKS, World, overlay_camera,
};

use genex::prelude::*;

/// The game's name in the shell.
pub const NAME: &str = "nav-crowd";
/// The world target size.
pub const WORLD_SIZE: [u32; 2] = [960, 540];

/// nav-crowd, with every hook registered.
pub fn game() -> Game<World> {
    let mut game = Game::new(World::default()).title("Nav crowd").world_size(WORLD_SIZE[0], WORLD_SIZE[1]);
    crowd::wire(&mut game);
    game
}

/// The web entry: hand the game to the web shell when the module is instantiated.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen(start)]
pub fn start() {
    genex_platform_web::install_named(NAME, game(), &[]);
}
