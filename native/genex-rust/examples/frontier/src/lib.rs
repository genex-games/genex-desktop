//! The cross-area acceptance scene `frontier` (EP-X1): a 2 x 2 km valley streamed in 64 m cells
//! round a rider who leaves a frontier town and comes back. Procedural terrain tiles with
//! colliders; huts, a watchtower, waystones and rock fields from a C-28 placement file; offline
//! nav islands for the town's cells through `StreamNav`; 20 mannequin agents driven by nav through
//! the documented loop with root motion, one of them over a ladder link; a door on a rigid node
//! clip; an impostor forest with a far field. See [`world`] for the ground and content and
//! [`town`] for the rules.
//!
//! The same [`game`] runs natively (`src/main.rs`) and on the web (this library as a wasm-bindgen
//! `cdylib`).

mod island_table;
pub mod mannequin;
mod pack_table;
pub mod props;
pub mod town;
pub mod world;

use std::sync::LazyLock;

use genex::prelude::*;
pub use town::{AGENTS, OBSERVER, RIDE_TICKS, Saved, Totals, World, restore, save};

/// The game's name in the shell.
pub const NAME: &str = "frontier";
/// The world target size.
pub const WORLD_SIZE: [u32; 2] = [960, 540];

/// The models (written in code once, the same bytes on every destination) and the offline nav
/// islands, as an asset table.
pub fn assets() -> genex::AssetTable {
    static TABLE: LazyLock<genex::AssetTable> = LazyLock::new(|| {
        let mut rows: Vec<(&'static str, &'static [u8])> = props::PROPS
            .iter()
            .map(|path| {
                let bytes: &'static [u8] = Box::leak(props::glb(path).unwrap_or_default().into_boxed_slice());
                (*path, bytes)
            })
            .collect();
        rows.push((mannequin::MANNEQUIN, Box::leak(mannequin::glb().into_boxed_slice())));
        Box::leak(rows.into_boxed_slice())
    });
    *TABLE
}

/// The frontier, with every hook registered.
pub fn game() -> Game<World> {
    game_salted(0)
}

/// The frontier whose agents pick other spots (`salt` added to each pick) until a restore: the save
/// row's run with another history.
pub fn game_salted(salt: u32) -> Game<World> {
    let mut game = Game::new(World::default()).title("Frontier").world_size(WORLD_SIZE[0], WORLD_SIZE[1]);
    town::wire(&mut game, salt);
    game
}

/// The web entry: hand the game to the web shell when the module is instantiated.
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen(start)]
pub fn start() {
    genex_platform_web::install_named(NAME, game(), assets());
}
