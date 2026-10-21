//! menus-saves (G6 UIS-18): a coin-collecting courtyard built to show the gameplay UI and save
//! slots end to end. The title menu (Continue, New game, Load game, Settings), the pause menu
//! (Resume, Inventory, Save, Load, Settings, Quit to title behind a dialog), the facade settings
//! menu with a Game tab of its own, an inventory grid, save and load slot lists over an autosave
//! ring, and toasts for every slot event. All of it moves by pad or keys, and every word comes
//! from `assets/lang/<locale>.ftl` through `genex::ui::tr` (English, French, and `xx-pseudo`,
//! which pads and brackets every string so overflow shows in a capture).
//!
//! The same [`game`] runs natively (`src/main.rs`) and on the web (this library as a wasm-bindgen
//! `cdylib`).

mod menus;
mod world;

#[cfg(test)]
mod parity;

pub use world::{BAG_SLOTS, HEALTH_MAX, Item, SLOT_NAMES, Screen, World, menus_probe, new_world, world_probe};

use genex::prelude::*;
use genex::saves::SaveConfig;
use genex::settings::{SettingDef, SettingValue, SettingsConfig, SettingsTab};

/// The game's name in the shell.
pub const NAME: &str = "menus-saves";
/// The world target size (landscape, as the desktop and web play it).
pub const WORLD_SIZE: [u32; 2] = [1280, 720];
/// A phone held upright, in world pixels: the portrait variant the safe-area captures use.
pub const PORTRAIT_SIZE: [u32; 2] = [390, 844];
/// The locales offered; the first is the fallback.
pub const LOCALES: [&str; 2] = ["en", "fr"];
/// The save format this build writes.
pub const SAVE_SCHEMA: u32 = 1;
/// Ticks between autosaves (one minute of play at 60 ticks a second).
pub const AUTOSAVE_TICKS: u64 = 3600;
/// Autosave slots in the ring (`autosave-0`, `autosave-1`).
pub const AUTOSAVE_RING: u8 = 2;

/// The text files, compiled in: the boot group `game.ui` reads.
pub const ASSETS: genex::AssetTable =
    &[("lang/en.ftl", include_bytes!("../assets/lang/en.ftl")), ("lang/fr.ftl", include_bytes!("../assets/lang/fr.ftl"))];

/// menus-saves at its landscape world size, with every hook registered.
pub fn game() -> Game<World> {
    game_sized(WORLD_SIZE)
}

/// menus-saves at `size` (the portrait captures use [`PORTRAIT_SIZE`]); the layout follows the
/// world's size and the safe area.
pub fn game_sized(size: [u32; 2]) -> Game<World> {
    let mut game = Game::new(World::default()).title("Menus and saves").world_size(size[0], size[1]).background(Color::rgb(24, 28, 38));
    game.ui(UiConfig::new().locales(&LOCALES).pseudo_locale(true));
    game.saves(SaveConfig::schema(SAVE_SCHEMA).autosave(AUTOSAVE_TICKS, AUTOSAVE_RING));
    game.save_world();
    game.settings(game_options());
    world::wire(&mut game, size);
    menus::wire(&mut game);
    game
}

/// The Game tab: how many hints the HUD shows and whether coins sparkle, with a Veteran preset.
fn game_options() -> SettingsConfig {
    SettingsConfig::new()
        .option(SettingsTab::Game, SettingDef::choice("hints", "settings-hints", &["hints-off", "hints-some", "hints-all"], 2))
        .option(SettingsTab::Game, SettingDef::toggle("coin_sparkle", "settings-coin-sparkle", true))
        .preset(SettingsTab::Game, "veteran", &[("hints", SettingValue::Choice(0)), ("coin_sparkle", SettingValue::Bool(false))])
}

/// The web entry: hand the game to the web shell when the module is instantiated (never in this
/// crate's own unit tests, which run as a plain wasm32 libtest binary).
#[cfg(all(target_arch = "wasm32", not(test)))]
#[wasm_bindgen::prelude::wasm_bindgen(start)]
pub fn start() {
    genex_platform_web::install_named(NAME, game(), ASSETS);
}
