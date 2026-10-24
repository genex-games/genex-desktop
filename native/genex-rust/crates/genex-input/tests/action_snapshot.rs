//! Action state snapshot and restore (release R-26; the save section R-25 wires): a restore of a
//! snapshot taken mid-hold, mid-toggle, mid-cooldown and with a context switch queued continues
//! exactly as the uninterrupted run, a snapshot survives JSON text, and a hostile snapshot is
//! refused with a typed code and restores nothing.

use genex_core::input::{Injection, InputMerger, PadState, TickInput};
use genex_input::binding::{Binding, KeyCode, PadButton, Stick};
use genex_input::condition::Condition;
use genex_input::error::InputErrorCode;
use genex_input::id::{ActionId, ContextId};
use genex_input::map::{ActionMap, Context};
use genex_input::state::{ACTIONS_SNAPSHOT_FORMAT, ActionState, evaluate};
use serde_json::{Value, json};

const PLAY: ContextId = ContextId::new("play");
const MENU: ContextId = ContextId::new("menu");
const MOVE: ActionId = ActionId::new("move");
const CHARGE: ActionId = ActionId::new("charge");
const LIGHT: ActionId = ActionId::new("light");
const SHOOT: ActionId = ActionId::new("shoot");
const BACK: ActionId = ActionId::new("back");
/// The tick a snapshot is taken on: Charge is half held, Light toggled on, Shoot cooling down.
const SNAPSHOT_TICK: usize = 37;
/// How long the scripted run is.
const RUN_TICKS: usize = 120;

fn key(code: &'static str) -> Binding {
    Binding::Key(KeyCode::of(code))
}

fn map() -> ActionMap {
    let map = ActionMap::new()
        .context(
            Context::new(PLAY, 0)
                .axis2(MOVE, &[Binding::WASD, Binding::Stick(Stick::Left)])
                .button(CHARGE, &[key("KeyC")])
                .when(Condition::Hold { ticks: 20, one_shot: true })
                .button(LIGHT, &[key("KeyL")])
                .when(Condition::Toggle)
                .button(SHOOT, &[key("Space"), Binding::Pad(PadButton::RightTrigger)])
                .when(Condition::Cooldown { ticks: 12 }),
        )
        .context(Context::new(MENU, 10).starts_off().button(BACK, &[key("Backspace")]));
    map.validate().expect("the map validates");
    map
}

/// The scripted input of tick `at`: keys held across the snapshot tick, a toggle, a cooldown, a
/// pad stick and a context switch requested just before the snapshot.
fn injection(at: usize) -> Injection {
    let mut injection = Injection::default();
    match at {
        5 => injection.down = vec!["KeyC".to_owned(), "KeyD".to_owned()],
        10 => injection.tap = vec!["KeyL".to_owned()],
        30 => injection.down = vec!["Space".to_owned()],
        50 => injection.up = vec!["KeyC".to_owned(), "Space".to_owned()],
        60 => injection.pads = vec![(0, pad_left([0.6, -0.3]))],
        70 => injection.tap = vec!["KeyL".to_owned()],
        80 => injection.pads = vec![(0, pad_left([0.0, 0.0]))],
        90 => injection.down = vec!["Space".to_owned()],
        _ => {}
    }
    injection
}

fn pad_left(stick: [f32; 2]) -> PadState {
    let mut pad = PadState { connected: true, ..PadState::default() };
    pad.axes[0] = stick[0];
    pad.axes[1] = stick[1];
    pad
}

fn ticks() -> Vec<TickInput> {
    let mut merger = InputMerger::default();
    (0..RUN_TICKS)
        .map(|at| {
            merger.inject(&injection(at));
            merger.next_tick()
        })
        .collect()
}

/// What a game reads from the state after a tick.
fn reads(state: &ActionState) -> Value {
    let row = |action: ActionId| json!([state.down(action), state.pressed(action), state.fired(action), state.held_ticks(action)]);
    json!({
        "move": state.axis2(MOVE),
        "charge": row(CHARGE),
        "light": row(LIGHT),
        "shoot": row(SHOOT),
        "back": row(BACK),
        "menu": state.is_on(MENU),
        "device": state.device().as_str(),
        "ticks": state.ticks(),
    })
}

/// One run: evaluate every tick, and at `SNAPSHOT_TICK` switch on the menu context (applied next
/// tick) and hand the state to `at_snapshot`, which may replace it.
fn run(map: &ActionMap, ticks: &[TickInput], mut at_snapshot: impl FnMut(&ActionState) -> ActionState) -> Vec<Value> {
    let mut state = ActionState::new(map);
    let mut rows = Vec::with_capacity(ticks.len());
    for (at, tick) in ticks.iter().enumerate() {
        evaluate(map, &mut state, tick);
        rows.push(reads(&state));
        if at == SNAPSHOT_TICK {
            state.enable(MENU);
            state = at_snapshot(&state);
        }
    }
    rows
}

#[test]
fn a_restored_snapshot_continues_exactly_as_the_uninterrupted_run() {
    let map = map();
    let ticks = ticks();
    let straight = run(&map, &ticks, Clone::clone);
    let at = &straight[SNAPSHOT_TICK];
    assert_eq!(at["charge"], json!([true, false, false, 32]), "Charge is held past its hold tick: {at}");
    assert_eq!(at["menu"], json!(false), "the menu context starts off");
    assert_eq!(at["light"][2], json!(true), "Light is toggled on");
    let mut snapshots = Vec::new();
    let restored = run(&map, &ticks, |state| {
        let snapshot = state.snapshot();
        // Through JSON text, as a save file carries it.
        let text = serde_json::to_string(&snapshot).expect("a snapshot is JSON");
        let back: Value = serde_json::from_str(&text).expect("JSON text reads back");
        snapshots.push(snapshot);
        ActionState::restore(&map, &back).expect("a snapshot of the same map restores")
    });
    assert_eq!(restored, straight, "every read after the restore equals the uninterrupted run");
    assert!(straight[SNAPSHOT_TICK + 1]["menu"] == json!(true), "the queued context switch survived the restore");
    let snapshot = &snapshots[0];
    assert_eq!(snapshot["format"], json!(ACTIONS_SNAPSHOT_FORMAT));
    let again = ActionState::restore(&map, snapshot).expect("restores").snapshot();
    assert_eq!(&again, snapshot, "snapshot(restore(s)) == s");
}

#[test]
fn a_hostile_snapshot_is_refused_with_a_typed_code_and_restores_nothing() {
    let map = map();
    let ticks = ticks();
    let mut good = Value::Null;
    run(&map, &ticks, |state| {
        good = state.snapshot();
        state.clone()
    });
    let edit = |change: &dyn Fn(&mut Value)| {
        let mut snapshot = good.clone();
        change(&mut snapshot);
        snapshot
    };
    let other_map = ActionMap::new().context(Context::new(PLAY, 0).button(CHARGE, &[key("KeyC")]));
    let invalid = InputErrorCode::TrackInvalid;
    let mismatch = InputErrorCode::TrackMismatch;
    let rows: Vec<(&str, Value, &ActionMap, InputErrorCode)> = vec![
        ("not an object", json!([1, 2]), &map, invalid),
        ("another format", edit(&|s| s["format"] = json!("genex-actions/2")), &map, invalid),
        ("another map", good.clone(), &other_map, mismatch),
        ("a reordered action", edit(&|s| s["slots"].as_array_mut().expect("slots").swap(0, 1)), &map, mismatch),
        ("a context missing", edit(&|s| s["on"] = json!([true])), &map, mismatch),
        ("a context that is not a bool", edit(&|s| s["on"][0] = json!(1)), &map, invalid),
        ("a value no f32 holds", edit(&|s| s["slots"][0]["value"][0] = json!(0.1)), &map, invalid),
        ("a non-finite value", edit(&|s| s["slots"][0]["value"][0] = json!("NaN")), &map, invalid),
        ("a negative hold", edit(&|s| s["slots"][1]["held"] = json!(-1)), &map, invalid),
        ("a hold past u32", edit(&|s| s["slots"][1]["held"] = json!(u64::MAX)), &map, invalid),
        ("condition memory cut short", edit(&|s| s["slots"][1]["memory"] = json!([])), &map, invalid),
        ("a wait past u16", edit(&|s| s["slots"][1]["memory"][0][1] = json!(70_000)), &map, invalid),
        ("an unknown device", edit(&|s| s["device"] = json!("joystick")), &map, invalid),
        ("an unknown family", edit(&|s| s["family"] = json!("dreamcast")), &map, invalid),
        ("a switch of an unknown context", edit(&|s| s["requests"] = json!([["cutscene", true]])), &map, invalid),
        ("no tick count", edit(&|s| s["ticks"] = Value::Null), &map, invalid),
    ];
    for (what, snapshot, against, code) in rows {
        let refused = ActionState::restore(against, &snapshot).expect_err(what);
        assert_eq!(refused.code, code, "{what}: {refused:?}");
    }
    // The good snapshot still restores after every refusal: a refusal changes nothing.
    assert!(ActionState::restore(&map, &good).is_ok());
}
