//! Input actions on the facade (G6 input, IN-11): `game.input`, `ctx.actions`, the tick order
//! (merge, HUD focus gating, evaluate, hooks), `state().__input`, the install refusals, the
//! player's bindings file and what a seed keeps.

use genex::actions::{Access, ActionId, ActionMap, Binding, Condition, Context, ContextId, HoldMode, UI, UiAction};
use genex::prelude::*;
use genex::{FIXED_STEP_MS, InstallErrorCode, Runtime};

const PLAY: ContextId = ContextId::new("play");
const JUMP: ActionId = ActionId::new("jump");
const AIM: ActionId = ActionId::new("aim");
const BINDINGS_FILE: &str = "genex-input.json";

#[derive(Default)]
struct World {
    jumps: u32,
    fired: u32,
    aim_ticks: u32,
    trail: Vec<u32>,
    name: String,
    clicks: u32,
}

fn play_map() -> ActionMap {
    ActionMap::new().context(
        Context::new(PLAY, 0).button(JUMP, &[Key::KeyJ.into(), Key::Space.into()]).button(AIM, &[Key::KeyA.into()]),
    )
}

fn jump_game() -> Game<World> {
    let mut game = Game::new(World::default()).world_size(400, 300);
    game.input(play_map());
    game.on_update(|sim, ctx| {
        if ctx.actions.pressed(JUMP) {
            sim.world.jumps += 1;
        }
        if ctx.actions.fired(JUMP) {
            sim.world.fired += 1;
        }
        if ctx.actions.down(AIM) {
            sim.world.aim_ticks += 1;
        }
        sim.world.trail.push(sim.world.jumps * 1000 + sim.world.aim_ticks);
    });
    game.probe("jumps", |sim| json!({ "jumps": sim.world.jumps, "aim": sim.world.aim_ticks, "trail": sim.world.trail }));
    game
}

fn runtime(game: Game<World>) -> Runtime<World> {
    Runtime::new(game).expect("a consistent game installs")
}

/// A fresh, empty folder standing in for a Studio run's `state/`.
fn state_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("genex-actions-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("a temp folder");
    dir
}

fn state_dir_str(dir: &std::path::Path) -> String {
    let mut text = dir.to_str().expect("a UTF-8 temp path").to_owned();
    if !text.ends_with('/') {
        text.push('/');
    }
    text
}

fn input_key(rt: &Runtime<World>) -> Value {
    rt.state()["__input"].clone()
}

#[test]
fn an_injected_tap_fires_jump_on_exactly_one_tick_even_in_a_three_tick_step() {
    let mut rt = runtime(jump_game());
    rt.seed(1);
    rt.inject(Input::key_tap(Key::KeyJ));
    rt.step(FIXED_STEP_MS * 3.0);
    assert_eq!((rt.sim().world.jumps, rt.sim().world.fired), (1, 1), "one tap is one press and one firing");
    rt.step(FIXED_STEP_MS * 3.0);
    assert_eq!(rt.sim().world.jumps, 1, "no later tick presses it again");
}

#[test]
fn while_a_hud_text_field_has_focus_space_does_not_fire_jump() {
    let mut game = jump_game();
    game.on_ui(|sim, ui, _ctx| {
        ui.text_edit_singleline(&mut sim.world.name);
    });
    let mut rt = runtime(game);
    rt.seed(1);
    rt.step(FIXED_STEP_MS);
    rt.inject(Input::key_tap(Key::Space));
    rt.step(FIXED_STEP_MS);
    assert_eq!(rt.sim().world.jumps, 1, "nothing focused: Space is jump");
    // The field sits inside the HUD margin (R-25): aim at its centre.
    let field = rt.hud_widgets().into_iter().next().expect("the text field");
    let [x, y] = field.center_fraction([400, 300]);
    rt.inject(Input::pointer(x, y));
    rt.step(FIXED_STEP_MS);
    rt.inject(Input::click_at(x, y));
    rt.step(FIXED_STEP_MS * 2.0);
    assert!(rt.keyboard_wanted(), "the field has focus");
    rt.inject(Input::key_tap(Key::Space));
    rt.step(FIXED_STEP_MS * 2.0);
    assert_eq!(rt.sim().world.jumps, 1, "the focused field takes Space; jump does not fire");
}

#[test]
fn a_hostile_bindings_file_in_the_runs_state_leaves_the_defaults_and_sets_the_refusal() {
    let deep = format!("{}{}", "[".repeat(40), "]".repeat(40));
    let oversize = format!(r#"{{"format":"genex-input/1","bindings":{{}},"access":{{}},"pad":"{}"}}"#, "x".repeat(70_000));
    let cases: [(&str, &[u8], &str); 6] = [
        ("garbage", b"{not json", "input-bindings-invalid"),
        ("wrong-format", br#"{"format":"genex-input/9","bindings":{}}"#, "input-bindings-invalid"),
        ("duplicate", br#"{"format":"genex-input/1","format":"genex-input/1","bindings":{}}"#, "input-bindings-invalid"),
        ("deep", deep.as_bytes(), "input-bindings-invalid"),
        ("oversize", oversize.as_bytes(), "input-bindings-invalid"),
        ("reserved", br#"{"format":"genex-input/1","bindings":{"jump":["key:Escape"]}}"#, "input-binding-reserved"),
    ];
    for (name, bytes, code) in cases {
        let dir = state_dir(&format!("hostile-{name}"));
        std::fs::write(dir.join(BINDINGS_FILE), bytes).expect("write the hostile file");
        let mut rt = runtime(jump_game());
        let defaults = input_key(&rt)["bindings"].clone();
        rt.use_studio_saves(&state_dir_str(&dir));
        let key = input_key(&rt);
        assert_eq!(key["refusal"]["code"], json!(code), "{name}: the refusal names why");
        assert_eq!(key["bindings"], defaults, "{name}: the defaults stay");
        rt.inject(Input::key_tap(Key::KeyJ));
        rt.step(FIXED_STEP_MS * 2.0);
        assert_eq!(rt.sim().world.jumps, 1, "{name}: KeyJ still jumps");
        let on_disk = std::fs::read(dir.join(BINDINGS_FILE)).expect("the file is still there");
        assert_eq!(on_disk, bytes, "{name}: the hostile file is never rewritten");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// The player's file: jump moved to KeyK and aim set to toggle.
fn rebound_blob() -> Vec<u8> {
    let mut map = play_map();
    map.rebind(JUMP, 0, Key::KeyK.into()).expect("KeyK is free");
    let mut access = Access::default();
    access.hold_mode.insert(AIM, HoldMode::Toggle);
    map.set_access(access).expect("valid settings");
    map.to_blob()
}

#[test]
fn seed_turns_a_toggle_latch_off_and_keeps_a_rebind() {
    let dir = state_dir("seed-latch");
    std::fs::write(dir.join(BINDINGS_FILE), rebound_blob()).expect("write the player's file");
    let mut rt = runtime(jump_game());
    rt.use_studio_saves(&state_dir_str(&dir));
    assert_eq!(input_key(&rt)["refusal"], Value::Null);
    rt.seed(1);
    rt.inject(Input::key_tap(Key::KeyA));
    rt.step(FIXED_STEP_MS * 10.0);
    assert!(rt.sim().world.aim_ticks >= 9, "a tap latches aim on in toggle mode");
    rt.seed(1);
    rt.step(FIXED_STEP_MS * 10.0);
    assert_eq!(rt.sim().world.aim_ticks, 0, "the seed let go of the latch");
    rt.inject(Input::key_tap(Key::KeyK));
    rt.step(FIXED_STEP_MS);
    assert_eq!(rt.sim().world.jumps, 1, "the rebind survives the seed");
    rt.inject(Input::key_tap(Key::KeyJ));
    rt.step(FIXED_STEP_MS);
    assert_eq!(rt.sim().world.jumps, 1, "KeyJ was moved off jump");
    let _ = std::fs::remove_dir_all(&dir);
}

fn scripted(rt: &mut Runtime<World>) -> (String, Value) {
    for (key, ticks) in [(Key::KeyK, 3.0), (Key::KeyA, 5.0), (Key::Space, 2.0), (Key::KeyA, 4.0)] {
        rt.inject(Input::key_tap(key));
        rt.step(FIXED_STEP_MS * ticks);
    }
    (rt.checksum(), rt.state()["jumps"].clone())
}

#[test]
fn seed_two_then_seed_one_equals_a_fresh_seed_one_under_the_same_digest() {
    let dir = state_dir("seed-equal");
    std::fs::write(dir.join(BINDINGS_FILE), rebound_blob()).expect("write the player's file");
    let saves = state_dir_str(&dir);
    let mut fresh = runtime(jump_game());
    fresh.use_studio_saves(&saves);
    fresh.seed(1);
    let expected = scripted(&mut fresh);
    let mut reused = runtime(jump_game());
    reused.use_studio_saves(&saves);
    reused.seed(2);
    scripted(&mut reused);
    reused.seed(1);
    assert_eq!(scripted(&mut reused), expected);
    assert_eq!(input_key(&reused)["bindings"], input_key(&fresh)["bindings"], "the same digest");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn reading_an_unknown_action_lists_it_in_unknown_reads() {
    let mut game = jump_game();
    game.on_update(|sim, ctx| {
        if ctx.actions.down(ActionId::new("jmup")) {
            sim.world.jumps += 100;
        }
    });
    let mut rt = runtime(game);
    rt.step(FIXED_STEP_MS);
    assert_eq!(input_key(&rt)["unknownReads"], json!(["jmup"]));
    assert_eq!(rt.sim().world.jumps, 0, "an unknown id reads false");
}

#[test]
fn install_refuses_a_probe_named_input_a_second_map_and_an_invalid_one() {
    let mut probe = jump_game();
    probe.probe("__input", |_| json!(0));
    assert_eq!(Runtime::new(probe).err().map(|e| e.code()), Some(InstallErrorCode::ReservedProbe));
    let mut second = jump_game();
    second.input(play_map());
    assert_eq!(Runtime::new(second).err().map(|e| e.code()), Some(InstallErrorCode::DuplicateInput));
    let mut invalid = Game::new(World::default());
    invalid.input(ActionMap::new().context(Context::new(PLAY, 0).button(ActionId::new("Jump!"), &[Key::KeyJ.into()])));
    assert_eq!(Runtime::new(invalid).err().map(|e| e.code()), Some(InstallErrorCode::InputInvalid));
    let mut double_touch = jump_game();
    double_touch.touch_controls(genex::actions::TouchControls::new());
    double_touch.touch_controls(genex::actions::TouchControls::new());
    assert_eq!(Runtime::new(double_touch).err().map(|e| e.code()), Some(InstallErrorCode::DuplicateTouchControls));
}

#[test]
fn without_game_input_state_has_no_input_key_and_ctx_actions_read_nothing() {
    let mut game = Game::new(World::default());
    game.on_update(|sim, ctx| {
        if ctx.actions.down(UiAction::ACCEPT) {
            sim.world.jumps += 1;
        }
    });
    let mut rt = runtime(game);
    rt.inject(Input::key_down(Key::Enter));
    rt.step(FIXED_STEP_MS * 3.0);
    assert!(rt.state().get("__input").is_none());
    assert_eq!(rt.sim().world.jumps, 0, "nothing is evaluated without game.input");
}

#[test]
fn state_input_shows_the_digest_device_contexts_down_and_hints() {
    let mut rt = runtime(jump_game());
    rt.inject(Input::key_down(Key::KeyA));
    rt.step(FIXED_STEP_MS);
    let key = input_key(&rt);
    assert_eq!(key["device"], json!("keyboard"));
    assert_eq!(key["contexts"], json!(["play"]), "ui starts off");
    assert_eq!(key["down"], json!(["aim"]));
    assert_eq!(key["hints"]["jump"], json!("J"));
    assert!(key["bindings"].as_str().is_some_and(|hex| hex.len() == 16));
}

#[test]
fn the_ui_context_hands_its_actions_to_the_hud_as_navigation() {
    let mut game = Game::new(World::default()).world_size(400, 300);
    game.input(play_map());
    game.on_update(|_sim, ctx| {
        if !ctx.actions.is_on(UI) {
            ctx.actions.enable(UI);
        }
    });
    game.on_ui(|sim, ui, _ctx| {
        let _ = ui.button("First");
        if ui.button("Second").clicked() {
            sim.world.clicks += 1;
        }
    });
    let mut rt = runtime(game);
    rt.step(FIXED_STEP_MS * 2.0);
    let pad = |button: usize, value: f32| {
        let mut buttons = vec![0.0; 17];
        buttons[button] = value;
        pad_injection(&buttons)
    };
    // RB (ui_next) focuses First, then d-pad down (ui_down) moves to Second; South (ui_accept)
    // clicks it.
    for button in [5, 13] {
        rt.inject(pad(button, 1.0));
        rt.step(FIXED_STEP_MS);
        rt.inject(pad(button, 0.0));
        rt.step(FIXED_STEP_MS);
    }
    let focused: Vec<String> = rt.hud_widgets().into_iter().filter(|w| w.focused).map(|w| w.label).collect();
    assert_eq!(focused, ["Second"]);
    rt.inject(pad(0, 1.0));
    rt.step(FIXED_STEP_MS);
    rt.inject(pad(0, 0.0));
    rt.step(FIXED_STEP_MS * 2.0);
    assert_eq!(rt.sim().world.clicks, 1, "ui_accept clicked the focused button");
}

/// One injected standard pad at index 0 with these button values (the `input` verb's JSON).
fn pad_injection(buttons: &[f32]) -> Input {
    let list: Vec<String> = buttons.iter().map(|value| value.to_string()).collect();
    let text = format!(r#"{{"pads":[{{"index":0,"buttons":[{}]}}]}}"#, list.join(","));
    let arg = genex_core::json::parse(text.as_bytes()).expect("JSON");
    Input::from_injection(genex_core::input::parse_injection(&arg))
}

#[test]
fn a_hold_condition_counts_ticks_never_time() {
    let mut game = Game::new(World::default());
    game.input(ActionMap::new().context(Context::new(PLAY, 0).button(JUMP, &[Binding::key("KeyH").expect("a key")]).when(Condition::Hold { ticks: 30, one_shot: true })));
    game.on_update(|sim, ctx| {
        if ctx.actions.fired(JUMP) {
            sim.world.fired += 1;
        }
    });
    let mut rt = runtime(game);
    rt.inject(Input::key_down(Key::KeyH));
    rt.step(FIXED_STEP_MS * 29.0);
    assert_eq!(rt.sim().world.fired, 0);
    rt.step(FIXED_STEP_MS * 5.0);
    assert_eq!(rt.sim().world.fired, 1, "fires once, on the 30th held tick");
}

/// 56 game actions in seven contexts plus the built-in `ui` context's eight: `ACTIONS_MAX`.
fn full_map() -> ActionMap {
    const CONTEXTS: [&str; 7] = ["c0", "c1", "c2", "c3", "c4", "c5", "c6"];
    const NAMES: [&str; 56] = [
        "a00", "a01", "a02", "a03", "a04", "a05", "a06", "a07", "a10", "a11", "a12", "a13", "a14", "a15", "a16", "a17", "a20", "a21", "a22",
        "a23", "a24", "a25", "a26", "a27", "a30", "a31", "a32", "a33", "a34", "a35", "a36", "a37", "a40", "a41", "a42", "a43", "a44", "a45",
        "a46", "a47", "a50", "a51", "a52", "a53", "a54", "a55", "a56", "a57", "a60", "a61", "a62", "a63", "a64", "a65", "a66", "a67",
    ];
    const KEYS: [Key; 8] = [Key::KeyQ, Key::KeyW, Key::KeyE, Key::KeyR, Key::KeyT, Key::KeyY, Key::KeyU, Key::KeyI];
    let mut map = ActionMap::new();
    for (at, context) in CONTEXTS.iter().enumerate() {
        let mut built = Context::new(ContextId::new(context), at as i8);
        for (slot, name) in NAMES[at * 8..at * 8 + 8].iter().enumerate() {
            built = built.button(ActionId::new(name), &[KEYS[slot].into()]).pass_through();
        }
        map = map.context(built);
    }
    map
}

/// The quiet-machine budget row's measurement (`input.actions` <= 20 us per tick for 64
/// actions): ticks with and without `game.input`, the difference per tick. Advisory in a lane;
/// run with `--release -- --ignored --nocapture`.
#[test]
#[ignore = "a timing row: run on a quiet machine with --release"]
#[allow(clippy::disallowed_types, reason = "the budget row measures the wall clock on purpose")]
fn input_actions_cost_per_tick_for_64_actions() {
    const TICKS: u32 = 6000;
    let run = |with_input: bool| {
        let mut game = Game::new(World::default());
        if with_input {
            game.input(full_map());
        }
        game.on_update(|sim, ctx| sim.world.jumps += u32::from(ctx.actions.down(ActionId::new("a00"))));
        let mut rt = runtime(game);
        let start = std::time::Instant::now();
        for tick in 0..TICKS {
            if tick % 30 == 0 {
                rt.inject(Input::key_tap(Key::KeyQ).and(Input::key_down(Key::KeyW)));
            }
            rt.step(FIXED_STEP_MS);
        }
        start.elapsed().as_secs_f64() * 1e6 / f64::from(TICKS)
    };
    let best = |with_input| (0..5).map(|_| run(with_input)).fold(f64::INFINITY, f64::min);
    let (with, without) = (best(true), best(false));
    println!("input.actions: {:.2} us/tick with 64 actions ({with:.2} with, {without:.2} without)", with - without);
}
