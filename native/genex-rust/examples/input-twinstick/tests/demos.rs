//! input-twinstick's demos, headless (IN-14): every demo drives the game through real input and
//! its answer and checksum are the same on a second run and equal the goldens in
//! `tests/goldens/demos.json` (written with `GENEX_INPUT_TWINSTICK_BLESS=1`, which also rewrites
//! the `replay` demo's recorded session, `replay/session-600.track`).
//!
//! Every runtime saves into its own temporary folder (`use_studio_saves`, as a Studio run does), so
//! the `rebind` demo's `genex-input.json` never reaches the person's real save folder and never
//! leaks into another row.

use std::path::{Path, PathBuf};

use genex::{FIXED_STEP_MS, Input, Key, Runtime, Value, json};
use input_twinstick_game::{
    AIM_STICK_AT, DEMOS, MOVE_STICK_AT, REBIND_DASH, REPLAY_TRACK, WORLD_SIZE, World, bottom_left, bottom_right, game,
};

/// The seed every row runs.
const SEED: u32 = 1;
/// The recorded session's seed and length.
const REPLAY_SEED: u32 = 7;
const REPLAY_TICKS: u64 = 600;

fn bless() -> bool {
    std::env::var("GENEX_INPUT_TWINSTICK_BLESS").is_ok_and(|v| v == "1")
}

/// A fresh temporary save folder for one runtime.
fn saves_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("genex-input-twinstick-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("a temp folder");
    dir
}

fn runtime_in(dir: &Path) -> Runtime<World> {
    let mut runtime = Runtime::new(game()).expect("input-twinstick installs");
    runtime.use_studio_saves(&format!("{}/", dir.display()));
    runtime.seed(SEED);
    runtime
}

fn demo(name: &str) -> (Value, Value) {
    let dir = saves_dir(&format!("demo-{name}"));
    let mut runtime = runtime_in(&dir);
    let answer = runtime.demo(name).expect("the demo exists");
    let checksum = runtime.state()["checksum"].clone();
    let _ = std::fs::remove_dir_all(&dir);
    (answer, checksum)
}

#[test]
fn play_walks_aims_at_the_pointer_fires_and_dashes_on_keyboard_and_mouse() {
    let (answer, _) = demo("play");
    assert!(answer["ship"][0].as_f64().unwrap_or(0.0) > 1.0, "D walked right: {answer}");
    assert!(answer["shotsFired"].as_u64().unwrap_or(0) >= 2, "the held mouse button fired: {answer}");
    assert_eq!(answer["dashes"], json!(1), "Space dashed once: {answer}");
    assert!(answer["aim"][0].as_f64().unwrap_or(0.0) > 0.0, "the pointer right of the ship turned the aim right: {answer}");
}

#[test]
fn rebind_walks_the_pause_menu_to_rebind_dash_and_j_dashes_instead_of_space() {
    let (answer, _) = demo("rebind");
    assert_eq!(answer["found"], json!(true), "Tab reached the widget labelled {REBIND_DASH}: {answer}");
    assert_eq!(answer["dashLabel"], json!("J"), "the dash prompt reads the new key: {answer}");
    assert_eq!(answer["paused"], json!(false), "Escape closed the menu");
    assert_eq!(answer["spaceDashed"], json!(false), "Space no longer dashes: {answer}");
    assert_eq!(answer["jDashed"], json!(true), "J dashes: {answer}");
}

#[test]
fn the_rebind_is_saved_and_kept_when_the_game_is_seeded_again() {
    let dir = saves_dir("reseed");
    let mut runtime = runtime_in(&dir);
    let defaults = runtime.state()["__input"]["bindings"].clone();
    runtime.demo("rebind").expect("the demo exists");
    let written = std::fs::read_to_string(dir.join("genex-input.json")).expect("the rebind is saved as genex-input.json");
    assert!(written.contains("key:KeyJ"), "{written}");
    let rebound = runtime.state()["__input"]["bindings"].clone();
    assert_ne!(rebound, defaults, "the bindings digest moved");
    runtime.seed(2);
    assert_eq!(runtime.state()["__input"]["bindings"], rebound, "a new seed keeps the player's bindings");
    assert!(runtime.start());
    runtime.step(FIXED_STEP_MS * 3.0);
    runtime.inject(Input::key_tap(Key::KeyJ));
    runtime.step(FIXED_STEP_MS * 2.0);
    assert_eq!(runtime.sim().world.dashes, 1, "J dashes after the seed");
    // A fresh runtime on the same saves reads the file back.
    let fresh = runtime_in(&dir);
    assert_eq!(fresh.state()["__input"]["bindings"], rebound, "the next launch reads genex-input.json");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn pad_glyphs_an_injected_playstation_pad_turns_the_dash_prompt_to_cross() {
    let (answer, _) = demo("pad_glyphs");
    assert_eq!(answer["keyboardDash"], json!("Space"), "before the pad the prompt is the keyboard's: {answer}");
    assert_eq!(answer["device"], json!("pad"), "{answer}");
    assert_eq!(answer["dash"], json!("Cross"), "{answer}");
    assert_eq!(answer["dashes"], json!(1), "Cross dashed: {answer}");
}

#[test]
fn touch_the_floating_stick_walks_the_button_dashes_and_the_aim_stick_fires() {
    let (answer, _) = demo("touch");
    assert_eq!(answer["device"], json!("touch"), "{answer}");
    assert!(answer["ship"][0].as_f64().unwrap_or(0.0) > 0.5, "the move stick pushed right walked right: {answer}");
    assert_eq!(answer["dashes"], json!(1), "the Dash button dashed: {answer}");
    assert!(answer["shotsFired"].as_u64().unwrap_or(0) >= 2, "the aim stick pushed up fired: {answer}");
    assert!(answer["aim"][1].as_f64().unwrap_or(0.0) < -0.9, "aiming up the screen: {answer}");
}

/// The recorded session's tick `t`: keys, the pointer and the mouse button, and fingers on the
/// touch controls.
fn session(t: u64) -> Option<Input> {
    let walk = bottom_left(MOVE_STICK_AT, WORLD_SIZE);
    let aim = bottom_right(AIM_STICK_AT, WORLD_SIZE);
    match t {
        10 => Some(Input::key_down(Key::KeyD).and(Input::key_down(Key::KeyW))),
        70 => Some(Input::key_up(Key::KeyD).and(Input::pointer(0.2, 0.7)).and(Input::key_down(Key::Mouse1))),
        150 => Some(Input::key_up(Key::KeyW).and(Input::key_up(Key::Mouse1)).and(Input::key_tap(Key::Space))),
        200 => Some(Input::touch_start(1, walk[0], walk[1])),
        201 => Some(Input::touch_move(1, walk[0] - 50.0, walk[1] + 20.0)),
        260 => Some(Input::touch_end(1, walk[0] - 50.0, walk[1] + 20.0).and(Input::touch_start(2, aim[0] + 45.0, aim[1]))),
        330 => Some(Input::touch_end(2, aim[0] + 45.0, aim[1])),
        400 => Some(Input::key_tap(Key::KeyP)),
        430 => Some(Input::key_tap(Key::Escape)),
        450 => Some(Input::key_down(Key::KeyA).and(Input::pointer(0.9, 0.2)).and(Input::key_down(Key::Mouse1))),
        560 => Some(Input::key_up(Key::KeyA).and(Input::key_up(Key::Mouse1))),
        _ => None,
    }
}

/// The recorded run: the session played live from `REPLAY_SEED`.
fn recorded() -> Runtime<World> {
    let dir = saves_dir("recorded");
    let mut runtime = runtime_in(&dir);
    runtime.seed(REPLAY_SEED);
    for t in 0..REPLAY_TICKS {
        if let Some(input) = session(t) {
            runtime.inject(input);
        }
        runtime.step(FIXED_STEP_MS);
    }
    let _ = std::fs::remove_dir_all(&dir);
    runtime
}

fn track_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("replay/session-600.track")
}

#[test]
fn replay_plays_the_recorded_600_ticks_back_to_an_equal_checksum() {
    let live = recorded();
    let track = live.journal().track().expect("game.input keeps a journal");
    assert_eq!(track.ticks(), REPLAY_TICKS);
    assert!(track.complete());
    if bless() {
        std::fs::write(track_path(), track.encode()).expect("the session written");
        return;
    }
    assert_eq!(track.encode(), REPLAY_TRACK, "the committed session is the live run's journal (rebless with GENEX_INPUT_TWINSTICK_BLESS=1)");
    let world = &live.sim().world;
    assert!(world.shots_fired >= 10 && world.dashes >= 1, "the session moved the arena: {:?}", live.state()["arena"]);
    let dir = saves_dir("replayed");
    let mut replayed = runtime_in(&dir);
    let answer = replayed.demo("replay").expect("the demo exists");
    assert_eq!(answer["ticks"], json!(REPLAY_TICKS), "{answer}");
    assert_eq!(replayed.checksum(), live.checksum(), "the replay ends on the recorded run's checksum");
    assert_eq!(answer["arena"], live.state()["arena"]);
    let _ = std::fs::remove_dir_all(&dir);
}

fn goldens_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/goldens/demos.json")
}

#[test]
fn every_demo_replays_with_the_same_answer_and_the_golden_checksum() {
    let mut found = json!({});
    for name in DEMOS {
        let (answer, checksum) = demo(name);
        let (again, checksum_again) = demo(name);
        assert_eq!((&answer, &checksum), (&again, &checksum_again), "{name}: a second run differs");
        found[name] = json!({ "checksum": checksum, "answer": answer });
    }
    let path = goldens_path();
    if bless() {
        std::fs::write(&path, format!("{found:#}\n")).expect("goldens written");
    }
    let text = std::fs::read_to_string(&path).expect("goldens exist");
    let goldens: Value = text.parse().expect("goldens parse");
    for name in DEMOS {
        assert_eq!(found[name]["checksum"], goldens[name]["checksum"], "{name}: checksum differs from the golden");
    }
    // The answers compare as written: parsing the file back may round an f32's last digit.
    assert_eq!(format!("{found:#}\n"), text, "an answer differs from the goldens");
}
