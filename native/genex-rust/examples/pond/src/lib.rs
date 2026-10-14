//! The pond sample (M0a.7): cast a bobber with Space (or a tap), wait for a bite, buy bait with
//! the score in the egui shop. Floaters drift on the water under Rapier with a buoyancy force, the
//! pond rim is a GLB model, and every bite plays a splash through the device-less mixer.
//!
//! The same [`game`] runs natively (`src/main.rs`, with the spike-only `--self-test <ticks>`
//! mode) and on the web (this library as a wasm-bindgen `cdylib`, booted by
//! `native/genex-rust/web/shell.html`).

mod pond;

pub use pond::{BITE_WAIT_TICKS, CAMERA_EYE, STARTING_BAIT, World};

use genex::prelude::*;

/// The game's name in the self-test record and the shell.
pub const NAME: &str = "pond";
/// The world target size.
pub const WORLD_SIZE: [u32; 2] = [960, 540];
/// The demo the self-test runs by default (the plan's `cast`).
pub const DEFAULT_DEMO: &str = "cast";

/// The pond's assets, compiled in: its web build has no `assets/` folder to read at run time.
pub const ASSETS: genex_platform_web::AssetTable = &[
    ("pond.glb", include_bytes!("../assets/pond.glb")),
    ("water.glb", include_bytes!("../assets/water.glb")),
];

/// The pond, with every hook registered.
pub fn game() -> Game<World> {
    let mut game = Game::new(World::default()).title("Pond").world_size(WORLD_SIZE[0], WORLD_SIZE[1]);
    pond::wire(&mut game);
    game
}

/// The web entry: hand the pond to the web shell when the module is instantiated.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen(start)]
pub fn start() {
    genex_platform_web::install_named(NAME, game(), ASSETS);
}
