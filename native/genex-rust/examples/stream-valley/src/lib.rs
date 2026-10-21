//! stream-valley (STR-26a): a 4 x 4 km world of 64 m cells streamed around an anchor that drives
//! the ring road. The terrain is procedural; the villages, waystones, centre tower and rock fields
//! come from the cell pack the host's C-28 compiler made of `world/valley.cells.json`; the forests
//! are scattered per cell. See [`valley`] for the rules.
//!
//! The same [`game`] runs natively (`src/main.rs`) and on the web (this library as a wasm-bindgen
//! `cdylib`).

mod pack_table;
pub mod props;
pub mod valley;

use std::sync::LazyLock;

use genex::prelude::*;
pub use valley::{World, packs};

/// The game's name in the shell.
pub const NAME: &str = "stream-valley";
/// The world target size.
pub const WORLD_SIZE: [u32; 2] = [960, 540];

/// The props as an asset table (written in code once, the same bytes on every destination).
pub fn assets() -> genex::AssetTable {
    static TABLE: LazyLock<genex::AssetTable> = LazyLock::new(|| {
        let rows: Vec<(&'static str, &'static [u8])> = props::PROPS
            .iter()
            .map(|path| {
                let bytes: &'static [u8] = Box::leak(props::glb(path).unwrap_or_default().into_boxed_slice());
                (*path, bytes)
            })
            .collect();
        Box::leak(rows.into_boxed_slice())
    });
    *TABLE
}

/// stream-valley, with every hook registered.
pub fn game() -> Game<World> {
    let mut game = Game::new(World::default()).title("Stream valley").world_size(WORLD_SIZE[0], WORLD_SIZE[1]);
    valley::wire(&mut game);
    game
}

/// The web entry: hand the game to the web shell when the module is instantiated.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen(start)]
pub fn start() {
    genex_platform_web::install_named(NAME, game(), assets());
}
