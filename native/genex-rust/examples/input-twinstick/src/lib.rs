//! input-twinstick (G6 input, IN-14): a twin-stick arena shooter that reads only input actions.
//! Walk with WASD, the arrows, the left stick or the floating touch stick; aim with the mouse
//! pointer, the right stick or the touch aim stick (pushed, it fires); fire with the left mouse
//! button or the right trigger; dash with Space, the pad's bottom face button or the touch Dash
//! button; P, Escape, Start or the touch Pause button open the pause menu, whose Controls panel
//! rebinds any of them (saved as `genex-input.json`, kept across seeds). Prompts follow the device
//! in use ("Space", "Cross"), and the `replay` demo plays back a recorded session.
//!
//! The same [`game`] runs natively (`src/main.rs`) and on the web (this library as a wasm-bindgen
//! `cdylib`).

mod arena;
mod controls;
mod demos;
mod menu;

pub use arena::{ARENA_HALF, HP_START, Shot, Shown, World, arena_probe, camera, pointer_on_floor, prompts_probe};
pub use controls::{
    AIM, AIM_STICK, AIM_STICK_AT, DASH, DASH_BUTTON, DASH_BUTTON_AT, DASH_COOLDOWN_TICKS, FIRE, MOVE, MOVE_STICK, MOVE_STICK_AT, PAUSE,
    PAUSE_BUTTON, PLAY, SYSTEM, action_map, bottom_left, bottom_right, touch_layout,
};
pub use demos::{DEMOS, REBIND_DASH, REPLAY_TRACK, pad};

use genex::prelude::*;

/// The game's name in the shell.
pub const NAME: &str = "input-twinstick";
/// The world target size.
pub const WORLD_SIZE: [u32; 2] = [960, 540];

/// input-twinstick, with every hook registered.
pub fn game() -> Game<World> {
    let mut game = Game::new(World::fresh()).title("Input twinstick").world_size(WORLD_SIZE[0], WORLD_SIZE[1]);
    game.input(action_map());
    game.touch_controls(touch_layout());
    game.on_reset(arena::reset);
    game.on_update(arena::update);
    game.on_ui(menu::hud);
    game.on_draw(arena::draw);
    game.camera(|_| camera());
    game.probe("arena", arena_probe);
    game.probe_volatile("prompts", prompts_probe);
    demos::wire(&mut game);
    game
}

/// The web entry: hand the game to the web shell when the module is instantiated.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen(start)]
pub fn start() {
    genex_platform_web::install_named(NAME, game(), &[]);
}
