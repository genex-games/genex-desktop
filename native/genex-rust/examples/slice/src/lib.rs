//! The vertical slice (EP-V1): a procedural world streamed in 16 m cells round a walker (3 x 3
//! cells simulated), each cell bringing its colliders and a real genex-nav island through the
//! stream commit, one animated character driven by nav through the documented loop with root
//! motion, and villagers that freeze off the mesh when their cell streams out and walk on when it
//! streams back.
//!
//! The same [`game`] runs natively (`src/main.rs`) and on the web (this library as a wasm-bindgen
//! `cdylib`).

mod slice;

pub use slice::{CELL, FAR, HOME, OBSERVER, Rock, SliceTotals, VILLAGERS, WORLD_CELLS, World, cell_of, nav_config, rocks_of};

use genex::prelude::*;

/// The game's name in the shell.
pub const NAME: &str = "slice";
/// The world target size.
pub const WORLD_SIZE: [u32; 2] = [960, 540];

/// The slice's one asset, compiled in: its web build has no `assets/` folder to read at run time.
pub const ASSETS: genex::AssetTable = &[("walker.glb", include_bytes!("../assets/walker.glb"))];

/// The slice, with every hook registered.
pub fn game() -> Game<World> {
    let mut game = Game::new(World::default()).title("Vertical slice").world_size(WORLD_SIZE[0], WORLD_SIZE[1]);
    slice::wire(&mut game);
    game
}

/// The web entry: hand the game to the web shell when the module is instantiated.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen(start)]
pub fn start() {
    genex_platform_web::install_named(NAME, game(), ASSETS);
}
