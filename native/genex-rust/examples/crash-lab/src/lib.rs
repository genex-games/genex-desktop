//! crash-lab (G6 PROFILE, PROF-9): a lab that profiles itself and crashes on purpose. A ring of
//! movers sweeps the floor under two game scopes (`lab.update`, `lab.sweep`) and reports two
//! counters (`lab.movers`, `lab.charge`) into `state().volatile.profile`; hold F (Overload) and the
//! lab charges more movers. Two demos crash it: `panic_at_300` holds Overload and runs past tick
//! 300, where the update hook panics, and `wasm_trap` traps with `unreachable` on the web. A crash
//! record names the seed and the tick, and the input journal's tail replays the run to the same
//! panic (tests/crashes.rs).
//!
//! The same [`game`] runs natively (`src/main.rs`) and on the web (this library as a wasm-bindgen
//! `cdylib`).

mod demos;
mod lab;

pub use demos::DEMOS;
pub use lab::{
    CHARGE, LAB, MOVERS, OVERLOAD, OVERLOAD_KEY, PANIC_MESSAGE, PANIC_TICK, SCOPE_SWEEP, SCOPE_UPDATE, World, action_map, camera, lab_probe,
};

use genex::prelude::*;

/// The game's name in the shell.
pub const NAME: &str = "crash-lab";
/// The world target size.
pub const WORLD_SIZE: [u32; 2] = [960, 540];

/// crash-lab, with every hook registered.
pub fn game() -> Game<World> {
    let mut game = Game::new(World::fresh()).title("Crash lab").world_size(WORLD_SIZE[0], WORLD_SIZE[1]);
    game.input(action_map());
    game.on_reset(lab::reset);
    game.on_update(lab::update);
    game.on_draw(lab::draw);
    game.camera(|_| camera());
    game.probe("lab", lab_probe);
    demos::wire(&mut game);
    game
}

/// The web entry: hand the game to the web shell when the module is instantiated.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen(start)]
pub fn start() {
    genex_platform_web::install_named(NAME, game(), &[]);
}
