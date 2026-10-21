//! The input journal, replay and the input snapshot on the facade (G6 input, IN-12): a recorded
//! run replays to the same state on a fresh runtime, an input restore then the same ticks equals
//! the uninterrupted run, and the journal stays within its cap.

use genex::actions::{
    ActionId, ActionMap, Anchor, Binding, Condition, ContextId, ControlId, InputErrorCode, InputTrack, JOURNAL_BYTES_MAX, TouchControls,
};
use genex::prelude::*;
use genex::{FIXED_STEP_MS, Runtime};

const PLAY: ContextId = ContextId::new("play");
const JUMP: ActionId = ActionId::new("jump");
const MOVE: ActionId = ActionId::new("move");
const AIM: ActionId = ActionId::new("aim");
const DASH: ActionId = ActionId::new("dash");
const PAD_BUTTON: ControlId = ControlId::new("pad_jump");
const WORLD: [u32; 2] = [320, 240];

#[derive(Clone, Default, PartialEq, Debug)]
struct World {
    jumps: u32,
    x: f32,
    y: f32,
    aim: u32,
    dashes: u32,
    text: String,
    trail: Vec<(u64, u32, u32)>,
}

fn map() -> ActionMap {
    let play = genex::actions::Context::new(PLAY, 0)
        .button(JUMP, &[Key::Space.into(), Binding::Pad(genex::actions::PadButton::South), Binding::Touch(PAD_BUTTON)])
        .axis2(MOVE, &[Binding::WASD, Binding::Stick(genex::actions::Stick::Left)])
        .button(AIM, &[Key::KeyE.into()])
        .when(Condition::Toggle)
        .button(DASH, &[Key::ShiftLeft.into()])
        .when(Condition::Cooldown { ticks: 20 });
    ActionMap::new().context(play)
}

fn game() -> Game<World> {
    let mut game = Game::new(World::default()).world_size(WORLD[0], WORLD[1]);
    game.input(map());
    game.touch_controls(TouchControls::new().button(PAD_BUTTON, "Jump", Anchor::BottomRight([40.0, 40.0]), 30.0));
    game.on_update(|sim, ctx| {
        let w = &mut sim.world;
        if ctx.actions.pressed(JUMP) {
            w.jumps += 1;
        }
        let step = ctx.actions.axis2(MOVE);
        w.x += step.x;
        w.y += step.y;
        if ctx.actions.fired(AIM) {
            w.aim += 1;
        }
        if ctx.actions.fired(DASH) {
            w.dashes += 1;
        }
        w.text.push_str(ctx.text);
        if ctx.tick % 60 == 0 {
            let position = (w.x * 1000.0) as i32 as u32 ^ ((w.y * 1000.0) as i32 as u32).rotate_left(16);
            w.trail.push((ctx.tick, w.jumps * 7919 + w.aim * 31 + w.dashes, position));
        }
    });
    game.probe("world", |sim| {
        let w = &sim.world;
        json!({ "jumps": w.jumps, "x": w.x, "y": w.y, "aim": w.aim, "dashes": w.dashes, "text": w.text, "trail": w.trail })
    });
    game
}

fn runtime() -> Runtime<World> {
    Runtime::new(game()).expect("a consistent game installs")
}

fn pad(buttons: &[(usize, f32)], axes: [f32; 4]) -> Input {
    let mut values = vec![0.0f32; 17];
    for (at, value) in buttons {
        values[*at] = *value;
    }
    let list = |values: &[f32]| values.iter().map(f32::to_string).collect::<Vec<_>>().join(",");
    let text = format!(r#"{{"pads":[{{"index":0,"buttons":[{}],"axes":[{}]}}]}}"#, list(&values), list(&axes));
    let arg = genex_core::json::parse(text.as_bytes()).expect("JSON");
    Input::from_injection(genex_core::input::parse_injection(&arg))
}

/// Tick `t`'s scripted input, if any: keys, pads, touches and text over a minute, with nothing
/// held at 1 800 ticks (where the snapshot row cuts).
fn scripted(t: u64) -> Option<Input> {
    match t % 600 {
        5 => Some(Input::key_tap(Key::Space)),
        20 => Some(Input::key_down(Key::KeyD)),
        80 => Some(Input::key_up(Key::KeyD).and(Input::key_tap(Key::KeyE))),
        100 => Some(pad(&[(0, 1.0)], [0.6, -0.3, 0.0, 0.0])),
        130 => Some(pad(&[], [0.0, 0.0, 0.0, 0.0])),
        150 => Some(Input::touch_start(2, 280.0, 200.0)),
        160 => Some(Input::touch_end(2, 280.0, 200.0)),
        200 => Some(Input::text("hi")),
        220 => Some(Input::key_down(Key::ShiftLeft)),
        300 => Some(Input::key_up(Key::ShiftLeft)),
        310 => Some(Input::key_tap(Key::KeyE)),
        400 => Some(Input::click_at(0.2, 0.2)),
        _ => None,
    }
}

fn run_script(rt: &mut Runtime<World>, from: u64, to: u64) {
    for t in from..to {
        if let Some(input) = scripted(t) {
            rt.inject(input);
        }
        rt.step(FIXED_STEP_MS);
    }
}

#[test]
fn a_recorded_run_of_3600_ticks_replays_to_the_same_state_every_60_ticks() {
    let mut recorded = runtime();
    recorded.seed(9);
    run_script(&mut recorded, 0, 3600);
    let track = recorded.journal().track().expect("game.input keeps a journal");
    assert!(track.complete());
    assert_eq!(track.ticks(), 3600);
    let bytes = track.encode();
    let decoded = InputTrack::decode(&bytes).expect("the track reads back");
    let mut replayed = runtime();
    replayed.seed(1);
    let step = replayed.replay(&decoded).expect("the track matches the game");
    assert_eq!(step.ticks, 3600);
    assert_eq!(replayed.state()["world"]["trail"], recorded.state()["world"]["trail"], "every 60th tick agrees");
    assert_eq!(replayed.checksum(), recorded.checksum());
    assert_eq!(replayed.sim().world, recorded.sim().world);
    assert!(recorded.sim().world.jumps >= 12 && !recorded.sim().world.text.is_empty(), "the script moved the world");
}

#[test]
fn a_demo_replays_a_track_like_the_runtime() {
    let mut recorded = runtime();
    recorded.seed(3);
    run_script(&mut recorded, 0, 600);
    let track = recorded.journal().track().expect("a journal");
    let expected = recorded.checksum();
    let mut game = game();
    game.demo("replay", move |demo| {
        demo.replay(&track).expect("the track matches");
        json!(null)
    });
    let mut rt = Runtime::new(game).expect("installs");
    rt.demo("replay").expect("the demo exists");
    assert_eq!(rt.checksum(), expected);
}

#[test]
fn a_track_for_another_world_or_bindings_is_refused_with_nothing_run() {
    let mut recorded = runtime();
    run_script(&mut recorded, 0, 60);
    let track = recorded.journal().track().expect("a journal");
    let mut other = Game::new(World::default()).world_size(640, 480);
    other.input(map());
    let mut rt = Runtime::new(other).expect("installs");
    let before = rt.checksum();
    let refused = rt.replay(&track).expect_err("another world size");
    assert_eq!(refused.code, InputErrorCode::TrackMismatch);
    assert_eq!(rt.checksum(), before, "nothing ran");
    let mut bare = Runtime::new(Game::new(World::default()).world_size(WORLD[0], WORLD[1])).expect("installs");
    assert_eq!(bare.replay(&track).map_err(|e| e.code).err(), Some(InputErrorCode::TrackMismatch), "no game.input");
}

/// Where the snapshot row cuts: nothing held, aim's toggle latched on (since tick 80 of the
/// minute), and the next 300 ticks touch, type, dash and toggle again.
const CUT: u64 = 1940;
const AFTER: u64 = CUT + 300;

#[test]
fn an_input_restore_then_the_same_ticks_equals_the_uninterrupted_run() {
    let mut whole = runtime();
    whole.seed(5);
    run_script(&mut whole, 0, AFTER);
    let mut cut = runtime();
    cut.seed(5);
    run_script(&mut cut, 0, CUT);
    let snapshot = cut.input_snapshot();
    let slots = snapshot["actions"]["slots"].as_array().expect("action rows");
    let aim = slots.iter().find(|row| row["id"] == json!("aim")).expect("aim's row");
    assert_eq!(aim["memory"][0][0], json!(true), "aim's toggle is latched at the cut");
    let world = cut.sim().world.clone();
    run_script(&mut cut, CUT, AFTER);
    cut.input_restore(&snapshot).expect("the same map and layout");
    // The world and the tick are the saves area's to restore; the trail reads the tick, so it is
    // left out of the comparison.
    cut.sim_mut().world = world;
    run_script(&mut cut, CUT, AFTER);
    let (got, want) = (&cut.sim().world, &whole.sim().world);
    assert_eq!((got.jumps, got.x, got.y, got.aim, got.dashes, &got.text), (want.jumps, want.x, want.y, want.aim, want.dashes, &want.text));
}

#[test]
fn a_hostile_input_snapshot_is_refused_and_changes_nothing() {
    let mut rt = runtime();
    run_script(&mut rt, 0, 90);
    let good = rt.input_snapshot();
    let before = (rt.input_snapshot(), rt.checksum());
    let mut wrong_format = good.clone();
    wrong_format["format"] = json!("genex-input-snapshot/9");
    let mut bad_slot = good.clone();
    bad_slot["actions"]["slots"][0]["held"] = json!(-4);
    let mut nan_value = good.clone();
    nan_value["actions"]["slots"][1]["value"][0] = json!(0.1);
    let mut other_map = good.clone();
    other_map["actions"]["slots"][0]["id"] = json!("jmup");
    let mut bad_touch = good.clone();
    bad_touch["touch"] = json!({ "format": "genex-touch/1", "controls": [] });
    for (name, hostile) in [("format", wrong_format), ("slot", bad_slot), ("value", nan_value), ("map", other_map), ("touch", bad_touch), ("null", Value::Null)] {
        assert!(rt.input_restore(&hostile).is_err(), "{name} is refused");
        assert_eq!((rt.input_snapshot(), rt.checksum()), before, "{name}: nothing changed");
    }
}

#[test]
fn the_journal_stays_within_its_cap_over_a_scripted_half_hour() {
    let mut rt = runtime();
    // 30 minutes at 60 Hz.
    run_script(&mut rt, 0, 108_000);
    let view = rt.journal().view();
    let track = rt.journal().track().expect("a journal");
    assert!(track.encode().len() <= JOURNAL_BYTES_MAX, "{} bytes", track.encode().len());
    assert!(view.bytes as usize <= JOURNAL_BYTES_MAX);
    assert_eq!(rt.state()["__input"]["journal"]["ticks"], json!(view.ticks));
    let tail = rt.journal().track_within(24 * 1024).expect("a tail");
    assert!(tail.encode().len() <= 24 * 1024, "a crash record's tail fits 24 KiB");
}
