//! input-twinstick's controls as a play script and a player meet them (IN-14): the Controls panel
//! driven by its AccessKit label through `hud.items` (what an in-app agent's play script clicks),
//! the touch controls shown only once a finger touches the screen, and the
//! keyboard layout's key labels changing prompts only.

use std::path::{Path, PathBuf};

use genex::{FIXED_STEP_MS, Input, Key, Map, Runtime, json};
use input_twinstick_game::{REBIND_DASH, WORLD_SIZE, World, game};

fn saves_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("genex-input-twinstick-controls-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("a temp folder");
    dir
}

fn runtime_in(dir: &Path) -> Runtime<World> {
    let mut runtime = Runtime::new(game()).expect("input-twinstick installs");
    runtime.use_studio_saves(&format!("{}/", dir.display()));
    runtime.seed(1);
    assert!(runtime.start());
    runtime
}

fn steps(runtime: &mut Runtime<World>, ticks: u32) {
    for _ in 0..ticks {
        runtime.step(FIXED_STEP_MS);
    }
}

#[test]
fn a_play_script_clicks_rebind_dash_by_its_label_and_j_dashes() {
    let dir = saves_dir("label");
    let mut runtime = runtime_in(&dir);
    steps(&mut runtime, 2);
    runtime.inject(Input::key_tap(Key::KeyP));
    steps(&mut runtime, 3);
    let items = runtime.state()["hud"]["items"].clone();
    assert!(items.as_array().is_some_and(|items| items.iter().any(|item| item == REBIND_DASH)), "{items}");
    let widget = runtime.hud_widgets().into_iter().find(|w| w.label == REBIND_DASH).expect("the panel's dash row");
    let [x, y] = widget.center_fraction(WORLD_SIZE);
    runtime.inject(Input::pointer(x, y));
    steps(&mut runtime, 1);
    runtime.inject(Input::click_at(x, y));
    steps(&mut runtime, 2);
    runtime.inject(Input::key_tap(Key::KeyJ));
    steps(&mut runtime, 2);
    let written = std::fs::read_to_string(dir.join("genex-input.json")).expect("saved");
    assert!(written.contains("key:KeyJ"), "{written}");
    runtime.inject(Input::key_tap(Key::KeyP));
    steps(&mut runtime, 3);
    assert!(!runtime.sim().world.paused);
    runtime.inject(Input::key_tap(Key::KeyJ));
    steps(&mut runtime, 2);
    assert_eq!(runtime.sim().world.dashes, 1, "J dashes");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_touch_controls_show_only_once_a_finger_touches_the_screen() {
    let dir = saves_dir("touch");
    let mut runtime = runtime_in(&dir);
    steps(&mut runtime, 2);
    assert_eq!(runtime.state()["__input"]["touchControls"]["shown"], json!(false), "hidden on keyboard and mouse");
    runtime.inject(Input::touch_start(5, 480.0, 270.0));
    steps(&mut runtime, 1);
    assert_eq!(runtime.state()["__input"]["device"], json!("touch"));
    assert_eq!(runtime.state()["__input"]["touchControls"]["shown"], json!(true), "shown once a finger touched");
    let items = runtime.state()["hud"]["items"].clone();
    assert!(items.as_array().is_some_and(|items| items.iter().any(|item| item == "Dash")), "{items}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn key_labels_change_the_prompts_and_never_the_checksum_outside_studio() {
    let mut runtime = Runtime::new(game()).expect("installs");
    // Not a Studio run, so labels apply: the process saves are only read (nothing is rebound).
    runtime.seed(1);
    assert!(runtime.start());
    steps(&mut runtime, 3);
    let checksum = runtime.checksum();
    let mut labels = Map::default();
    labels.insert("Space".to_owned(), "Leertaste".to_owned());
    runtime.set_key_labels(&labels);
    steps(&mut runtime, 1);
    assert_eq!(runtime.sim().world.shown.dash, "Leertaste");
    let mut plain = Runtime::new(game()).expect("installs");
    plain.seed(1);
    assert!(plain.start());
    steps(&mut plain, 4);
    assert_eq!(plain.sim().world.shown.dash, "Space");
    assert_eq!(runtime.checksum(), plain.checksum(), "labels are display only");
    assert_ne!(checksum, String::new());
}
