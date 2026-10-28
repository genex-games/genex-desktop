//! The menus-saves example (`src/game-template-rust/docs/examples/menus-saves`) as a game gets it,
//! driven the way a check drives it, by clicking widgets at the rects `state().hud.widgets` gives:
//! New game from the title, Escape and the HUD's Pause into the pause menu, a save into a slot, a
//! load of it that restores the run with a matching checksum, Continue from the title, and the quit
//! confirm; and (on the host GPU) captures of the title, the HUD, the pause menu and the save list:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p template-examples \
//!     --release --offline --locked --test menus_saves -- --ignored metal --nocapture

#[path = "../../../../../src/game-template-rust/docs/examples/menus-saves/src/game.rs"]
mod game;
mod support;

use genex::render::{QualityPreset, RenderConfig};
use genex::{FIXED_STEP_MS, Game, Input, Key, Runtime, Value, View};

use game::World;

const GENEX_TOML: &str = include_str!("../../../../../src/game-template-rust/docs/examples/menus-saves/genex.toml");
const WORLD_SIZE: [u32; 2] = [1280, 720];

fn menus_saves() -> Game<World> {
    let mut game = Game::new(World::default()).title("Menus and saves").world_size(WORLD_SIZE[0], WORLD_SIZE[1]);
    game::wire(&mut game);
    game.render_settings(RenderConfig::from_toml(GENEX_TOML).expect("the example's [render] is admitted"));
    game
}

/// A fresh, empty folder standing in for a Studio run's `state/`.
fn state_dir(name: &str) -> String {
    let dir = std::env::temp_dir().join(format!("template-menus-saves-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("a temp folder");
    format!("{}/", dir.to_str().expect("a UTF-8 temp path"))
}

fn started(name: &str) -> Runtime<World> {
    let mut runtime = Runtime::with_assets(menus_saves(), Box::new(support::assets(&[]))).expect("the example installs");
    runtime.use_studio_saves(&state_dir(name));
    runtime.seed(1);
    runtime.start();
    runtime.step(FIXED_STEP_MS * 2.0);
    runtime
}

fn screen(runtime: &Runtime<World>) -> String {
    runtime.state()["volatile"]["menus"]["screen"].as_str().unwrap_or_default().to_owned()
}

/// Click the widget whose key (or, for a plain button, label) is `name`, and let two ticks pass.
fn click(runtime: &mut Runtime<World>, name: &str) {
    let state = runtime.state();
    let widgets = state["hud"]["widgets"].as_array().cloned().unwrap_or_default();
    let named = |widget: &&Value| widget["key"].as_str() == Some(name) || widget["label"].as_str() == Some(name);
    let widget = widgets.iter().find(named).unwrap_or_else(|| panic!("no widget {name} among {widgets:?}"));
    let rect: Vec<f32> = widget["rect"].as_array().into_iter().flatten().filter_map(Value::as_f64).map(|v| v as f32).collect();
    let (x, y) = ((rect[0] + rect[2]) * 0.5 / WORLD_SIZE[0] as f32, (rect[1] + rect[3]) * 0.5 / WORLD_SIZE[1] as f32);
    runtime.inject(Input::click_at(x, y));
    runtime.step(FIXED_STEP_MS * 2.0);
}

fn tap(runtime: &mut Runtime<World>, key: Key) {
    runtime.inject(Input::key_tap(key));
    runtime.step(FIXED_STEP_MS * 2.0);
}

/// From the title: New game, then a few steps right so the run differs from a fresh one.
fn play(runtime: &mut Runtime<World>) {
    assert_eq!(screen(runtime), "title");
    click(runtime, "title.new");
    assert_eq!(screen(runtime), "playing");
    for _ in 0..3 {
        tap(runtime, Key::ArrowRight);
        tap(runtime, Key::ArrowDown);
    }
    runtime.step(FIXED_STEP_MS * 120.0);
}

#[test]
fn new_game_plays_and_escape_or_the_hud_button_pauses_and_resume_goes_back() {
    let mut runtime = started("pause");
    play(&mut runtime);
    let world = runtime.state()["world"].clone();
    assert_eq!(world["player"], genex::json!([3, 3]), "the arrows walked the player: {world}");
    assert_eq!(world["hp"], 98, "health drains while playing: {world}");
    tap(&mut runtime, Key::Escape);
    assert_eq!(screen(&runtime), "pause", "Escape pauses, and the same press does not pick Resume");
    runtime.step(FIXED_STEP_MS * 120.0);
    assert_eq!(runtime.state()["world"]["hp"], 98, "nothing drains in the pause menu");
    click(&mut runtime, "pause.resume");
    assert_eq!(screen(&runtime), "playing");
    click(&mut runtime, "Pause");
    assert_eq!(screen(&runtime), "pause", "the HUD's Pause button is the phone's way in");
}

#[test]
fn a_saved_slot_loads_back_the_run_with_a_matching_checksum_and_continue_finds_it() {
    let mut runtime = started("slots");
    play(&mut runtime);
    let saved = runtime.state()["world"].clone();
    tap(&mut runtime, Key::Escape);
    click(&mut runtime, "pause.save");
    assert_eq!(screen(&runtime), "save-slots");
    click(&mut runtime, "slots.slot-1");
    runtime.step(FIXED_STEP_MS * 2.0);
    assert_eq!(screen(&runtime), "playing", "a save lands back in play");
    let events = runtime.state()["volatile"]["saves"].clone();
    assert_eq!(events["lastSave"]["slot"], "slot-1", "{events}");
    tap(&mut runtime, Key::ArrowLeft);
    runtime.step(FIXED_STEP_MS * 120.0);
    assert_ne!(runtime.state()["world"], saved, "the run went on past the save");
    tap(&mut runtime, Key::Escape);
    click(&mut runtime, "pause.load");
    click(&mut runtime, "slots.slot-1");
    runtime.step(FIXED_STEP_MS);
    let loaded = runtime.state();
    assert_eq!(screen(&runtime), "playing", "a load lands in play");
    assert_eq!(loaded["volatile"]["saves"]["lastLoad"]["checksumMatch"], true, "{}", loaded["volatile"]["saves"]);
    assert_eq!(loaded["world"]["player"], saved["player"], "the load put the player back");
    assert_eq!(loaded["world"]["coins"], saved["coins"]);
    // Quit to the title, then Continue loads the newest slot.
    tap(&mut runtime, Key::Escape);
    click(&mut runtime, "pause.title");
    click(&mut runtime, "quit.yes");
    assert_eq!(screen(&runtime), "title");
    click(&mut runtime, "title.continue");
    runtime.step(FIXED_STEP_MS);
    assert_eq!(screen(&runtime), "playing");
    assert_eq!(runtime.state()["world"]["player"], saved["player"], "Continue loaded slot-1");
}

#[test]
fn quit_to_title_asks_first_and_stay_keeps_the_run() {
    let mut runtime = started("quit");
    play(&mut runtime);
    tap(&mut runtime, Key::Escape);
    click(&mut runtime, "pause.title");
    assert_eq!(runtime.state()["volatile"]["menus"]["quitting"], true);
    click(&mut runtime, "quit.no");
    assert_eq!(screen(&runtime), "pause");
    assert_eq!(runtime.state()["volatile"]["menus"]["quitting"], false);
    assert_ne!(runtime.state()["world"]["played"], 0, "the run is kept");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_title_the_hud_the_pause_menu_and_the_save_list_capture() {
    let Some(mut presenter) = support::presenter(WORLD_SIZE, support::assets(&[])) else { return };
    let mut runtime = started("metal");
    assert!(presenter.install_for(&mut runtime).is_empty());
    support::shoot(&mut presenter, &mut runtime, View::Game, QualityPreset::High, "menus-title");
    play(&mut runtime);
    support::shoot(&mut presenter, &mut runtime, View::Game, QualityPreset::High, "menus-hud");
    tap(&mut runtime, Key::Escape);
    support::shoot(&mut presenter, &mut runtime, View::Game, QualityPreset::High, "menus-pause");
    click(&mut runtime, "pause.title");
    support::shoot(&mut presenter, &mut runtime, View::Game, QualityPreset::High, "menus-quit");
    tap(&mut runtime, Key::Escape);
    click(&mut runtime, "pause.save");
    let luma = support::shoot(&mut presenter, &mut runtime, View::Game, QualityPreset::Low, "menus-save-list");
    assert!((10.0..235.0).contains(&luma), "the save list is neither black nor blown out: {luma}");
}
