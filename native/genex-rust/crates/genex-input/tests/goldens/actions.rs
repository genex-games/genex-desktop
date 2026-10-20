//! Conditions, contexts, chords, hysteresis, the built-in `ui` context, purity and the validation
//! table.

use genex_core::input::{Injection, InputMerger, PadState, TickInput};
use genex_input::binding::{ActionKind, Binding, ChordInput, KeyCode, PadAxis, PadButton, PadFamily, Sign, Stick};
use genex_input::condition::Condition;
use genex_input::error::InputErrorCode;
use genex_input::id::{ActionId, ContextId};
use genex_input::map::{ACTIONS_MAX, ActionMap, Context};
use genex_input::modifier::Modifier;
use genex_input::state::ActionState;
use genex_input::ui::{UI, UiAction};

use crate::{Rig, eval, names};

const PLAY: ContextId = ContextId::new("play");
const VEHICLE: ContextId = ContextId::new("vehicle");
const JUMP: ActionId = ActionId::new("jump");
const HONK: ActionId = ActionId::new("honk");
const CHARGE: ActionId = ActionId::new("charge");
const LIGHT: ActionId = ActionId::new("light");
const REPEAT: ActionId = ActionId::new("repeat");
const USE: ActionId = ActionId::new("use");
const SPECIAL: ActionId = ActionId::new("special");
const FIRE: ActionId = ActionId::new("fire");
const MOVE: ActionId = ActionId::new("move");

fn key(code: &'static str) -> Binding {
    Binding::Key(KeyCode::of(code))
}

fn one(context: Context) -> ActionMap {
    ActionMap::new().context(context)
}

#[test]
fn hold_30_fires_on_held_tick_30_not_29_and_one_shot_fires_once() {
    let map = one(Context::new(PLAY, 0)
        .button(CHARGE, &[key("KeyC")])
        .when(Condition::Hold { ticks: 30, one_shot: false })
        .button(FIRE, &[key("KeyF")])
        .when(Condition::Hold { ticks: 30, one_shot: true }));
    let mut rig = Rig::new(map);
    rig.down(&["KeyC", "KeyF"]);
    assert_eq!(rig.state.held_ticks(CHARGE), 0, "hold tick 0 is the tick it went down");
    let mut charge = Vec::new();
    let mut fire = Vec::new();
    for _ in 1..=40 {
        rig.idle();
        if rig.state.fired(CHARGE) {
            charge.push(rig.state.held_ticks(CHARGE));
        }
        if rig.state.fired(FIRE) {
            fire.push(rig.state.held_ticks(FIRE));
        }
    }
    assert_eq!(charge.first(), Some(&30), "fires first on hold tick 30, not 29");
    assert_eq!(charge.len(), 11, "keeps firing on hold ticks 30..=40 while held");
    assert_eq!(fire, vec![30], "one_shot fires once per press");
    rig.up(&["KeyF"]);
    rig.down(&["KeyF"]);
    for _ in 1..=30 {
        rig.idle();
    }
    assert!(rig.state.fired(FIRE), "a new press arms the one-shot again");
}

#[test]
fn toggle_flips_only_on_a_rising_edge_and_an_injected_tap_flips_it_once() {
    let map = one(Context::new(PLAY, 0).button(LIGHT, &[key("KeyL")]).when(Condition::Toggle));
    let mut rig = Rig::new(map);
    rig.down(&["KeyL"]);
    assert!(rig.state.fired(LIGHT), "the first press turns it on");
    for _ in 0..5 {
        rig.idle();
        assert!(rig.state.fired(LIGHT), "holding does not flip it again");
    }
    rig.up(&["KeyL"]);
    assert!(rig.state.fired(LIGHT), "the release does not flip it");
    rig.tap(&["KeyL"]);
    assert!(!rig.state.fired(LIGHT), "an injected tap flips it off");
    rig.idle();
    rig.idle();
    assert!(!rig.state.fired(LIGHT), "and only once");
    rig.tap(&["KeyL"]);
    assert!(rig.state.fired(LIGHT), "the next tap flips it on");
}

#[test]
fn pulse_24_6_fires_on_hold_ticks_0_24_30_36() {
    let map = one(Context::new(PLAY, 0).button(REPEAT, &[key("KeyR")]).when(Condition::Pulse { first: 24, every: 6 }));
    let mut rig = Rig::new(map);
    let mut fired = Vec::new();
    rig.down(&["KeyR"]);
    for tick in 0..=38 {
        if tick > 0 {
            rig.idle();
        }
        if rig.state.fired(REPEAT) {
            fired.push(rig.state.held_ticks(REPEAT));
        }
    }
    assert_eq!(fired, vec![0, 24, 30, 36]);
}

fn vehicle_map(pass_through: bool) -> ActionMap {
    let vehicle = Context::new(VEHICLE, 10).button(HONK, &[key("Space")]);
    let vehicle = if pass_through { vehicle.pass_through() } else { vehicle };
    ActionMap::new().context(Context::new(PLAY, 0).button(JUMP, &[key("Space")])).context(vehicle)
}

#[test]
fn a_higher_context_consumes_space_unless_it_passes_it_through() {
    let mut rig = Rig::new(vehicle_map(false));
    rig.down(&["Space"]);
    assert!(rig.state.fired(HONK), "vehicle (priority 10) reads Space");
    assert!(!rig.state.fired(JUMP), "and consumes it, so play's jump does not fire");

    let mut rig = Rig::new(vehicle_map(true));
    rig.down(&["Space"]);
    assert!(rig.state.fired(HONK) && rig.state.fired(JUMP), "with pass_through both fire");
}

#[test]
fn a_context_turned_off_reads_nothing_and_enable_applies_next_tick() {
    let map = ActionMap::new()
        .context(Context::new(PLAY, 0).button(JUMP, &[key("Space")]))
        .context(Context::new(VEHICLE, 10).button(HONK, &[key("Space")]).starts_off());
    let mut rig = Rig::new(map);
    assert!(!rig.state.is_on(VEHICLE) && rig.state.is_on(PLAY) && !rig.state.is_on(UI));
    rig.down(&["Space"]);
    assert!(rig.state.fired(JUMP) && !rig.state.fired(HONK));
    rig.state.enable(VEHICLE);
    assert!(!rig.state.is_on(VEHICLE), "enable takes effect on the next tick");
    rig.idle();
    assert!(rig.state.is_on(VEHICLE));
    assert!(rig.state.fired(HONK) && !rig.state.fired(JUMP));
    rig.state.disable(VEHICLE);
    rig.idle();
    assert!(!rig.state.fired(HONK) && rig.state.fired(JUMP));
}

#[test]
fn a_chord_beats_its_plain_key_in_the_same_context() {
    let shift_e = Binding::chord(&[ChordInput::Key(KeyCode::of("ShiftLeft")), ChordInput::Key(KeyCode::of("KeyE"))])
        .expect("a two-input chord");
    let map = one(Context::new(PLAY, 0).button(USE, &[key("KeyE")]).button(SPECIAL, &[shift_e]));
    let mut rig = Rig::new(map);
    rig.down(&["KeyE"]);
    assert!(rig.state.fired(USE) && !rig.state.fired(SPECIAL), "plain E is use");
    rig.up(&["KeyE"]);
    rig.down(&["ShiftLeft"]);
    rig.down(&["KeyE"]);
    assert!(rig.state.fired(SPECIAL), "Shift+E is special");
    assert!(!rig.state.fired(USE), "and the chord takes E from use");
}

#[test]
fn a_trigger_keeps_its_press_between_the_thresholds_and_releases_at_0_60() {
    let right_trigger = PadButton::RightTrigger.index();
    let map = one(Context::new(PLAY, 0).button(FIRE, &[Binding::Pad(PadButton::RightTrigger)]));
    let mut rig = Rig::new(map);
    rig.button(right_trigger, 0.70);
    assert!(!rig.state.down(FIRE), "0.70 from rest is below the 0.75 press");
    rig.button(right_trigger, 0.80);
    assert!(rig.state.down(FIRE) && rig.state.pressed(FIRE), "0.80 presses");
    rig.button(right_trigger, 0.70);
    assert!(rig.state.down(FIRE), "0.70 after 0.80 stays down (release is 0.65)");
    rig.button(right_trigger, 0.60);
    assert!(!rig.state.down(FIRE) && rig.state.released(FIRE), "0.60 releases");
}

#[test]
fn the_built_in_ui_context_holds_eight_actions_and_confirms_on_east_for_nintendo() {
    let map = ActionMap::new();
    assert_eq!(map.contexts().collect::<Vec<_>>(), vec![UI]);
    let actions: Vec<(ActionId, ActionKind)> = map.actions().collect();
    assert_eq!(actions.len(), 8);
    assert_eq!(actions.iter().map(|(id, _)| *id).collect::<Vec<_>>(), UiAction::ALL.to_vec());
    assert!(actions.iter().all(|(_, kind)| *kind == ActionKind::Button));
    assert!(UiAction::ALL.iter().all(|id| id.name().starts_with("ui_")));

    let mut rig = Rig::new(map);
    assert!(!rig.state.is_on(UI), "ui starts off");
    rig.state.enable(UI);
    rig.idle();
    let south = PadButton::South.index();
    let east = PadButton::East.index();
    rig.button(south, 1.0);
    assert!(rig.state.fired(UiAction::ACCEPT) && !rig.state.fired(UiAction::CANCEL), "generic: South confirms");
    rig.button(south, 0.0);

    rig.devices_family = PadFamily::Nintendo;
    rig.button(east, 1.0);
    assert!(rig.state.fired(UiAction::ACCEPT), "Nintendo: East confirms");
    assert!(!rig.state.fired(UiAction::CANCEL));
    rig.button(east, 0.0);
    rig.button(south, 1.0);
    assert!(rig.state.fired(UiAction::CANCEL) && !rig.state.fired(UiAction::ACCEPT), "Nintendo: South goes back");
}

#[test]
fn ui_directions_repeat_and_a_stick_presses_them_past_half_travel() {
    let mut rig = Rig::new(ActionMap::new());
    rig.state.enable(UI);
    rig.idle();
    rig.axes([0.0, -0.45, 0.0, 0.0]);
    assert!(!rig.state.fired(UiAction::UP), "below half travel");
    rig.axes([0.0, -0.6, 0.0, 0.0]);
    assert!(rig.state.fired(UiAction::UP), "past half travel");
    let mut fired = vec![0];
    for hold in 1..=30 {
        rig.idle();
        if rig.state.fired(UiAction::UP) {
            fired.push(hold);
        }
    }
    assert_eq!(fired, vec![0, 24, 30], "Pulse 24/6");
    rig.axes([0.0, -0.45, 0.0, 0.0]);
    assert!(rig.state.down(UiAction::UP), "0.45 stays down above the 0.4 release");
    rig.axes([0.0, -0.3, 0.0, 0.0]);
    assert!(!rig.state.down(UiAction::UP));
}

#[test]
fn unknown_ids_read_false_and_zero_and_are_listed() {
    let mut rig = Rig::new(vehicle_map(false));
    rig.down(&["Space"]);
    let ghost = ActionId::new("ghost");
    assert!(!rig.state.down(ghost) && !rig.state.fired(ghost));
    assert_eq!(rig.state.value(ghost), 0.0);
    assert_eq!(rig.state.axis2(ghost), [0.0, 0.0]);
    assert_eq!(rig.state.unknown_reads(), vec!["ghost"]);
}

/// A scripted 10 000-tick stream: keys, a trigger sweep, sticks and taps.
fn scripted_stream() -> Vec<TickInput> {
    let mut merger = InputMerger::default();
    let mut ticks = Vec::with_capacity(10_000);
    let keys = ["KeyW", "KeyA", "KeyS", "KeyD", "Space", "ShiftLeft", "KeyE", "KeyC"];
    let mut pad = PadState { connected: true, ..PadState::default() };
    // A fixed LCG so the stream is the same on every run and destination.
    let mut seed: u32 = 0x9e37_79b9;
    let mut next = || {
        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        seed >> 8
    };
    for tick in 0..10_000u32 {
        let pick = keys[(next() as usize) % keys.len()].to_owned();
        let mut injection = Injection::default();
        match next() % 4 {
            0 => injection.down.push(pick),
            1 => injection.up.push(pick),
            2 if tick % 7 == 0 => injection.tap.push(pick),
            _ => {}
        }
        let phase = tick as f32 * 0.013;
        pad.axes = [libm_free_wave(phase), libm_free_wave(phase + 0.25), libm_free_wave(phase * 0.5), 0.0];
        pad.buttons[PadButton::RightTrigger.index()] = (tick % 50) as f32 / 49.0;
        pad.buttons[PadButton::South.index()] = f32::from(u8::from(next() % 3 == 0));
        injection.pads.push((0, pad));
        merger.inject(&injection);
        ticks.push(merger.next_tick());
    }
    ticks
}

/// A triangle wave in [-1, 1] (no transcendental, so the stream is the same everywhere).
fn libm_free_wave(phase: f32) -> f32 {
    let t = phase - (phase as i32) as f32;
    if t < 0.5 { 4.0 * t - 1.0 } else { 3.0 - 4.0 * t }
}

fn busy_map() -> ActionMap {
    let shift_e = Binding::chord(&[ChordInput::Key(KeyCode::of("ShiftLeft")), ChordInput::Key(KeyCode::of("KeyE"))])
        .expect("chord");
    ActionMap::new()
        .context(
            Context::new(PLAY, 0)
                .axis2(MOVE, &[Binding::WASD, Binding::Stick(Stick::Left)])
                .button(JUMP, &[key("Space"), Binding::Pad(PadButton::South)])
                .when(Condition::Press)
                .button(USE, &[key("KeyE")])
                .button(SPECIAL, &[shift_e])
                .button(CHARGE, &[key("KeyC")])
                .when(Condition::Hold { ticks: 30, one_shot: true })
                .button(
                    FIRE,
                    &[Binding::Pad(PadButton::RightTrigger), Binding::PadAxis(PadAxis::RightX, Sign::Positive)],
                )
                .when(Condition::Cooldown { ticks: 9 })
                .modify(Modifier::Hysteresis { press: 0.8, release: 0.3 }),
        )
        .context(Context::new(VEHICLE, 10).button(HONK, &[key("Space")]).when(Condition::Pulse { first: 24, every: 6 }))
}

#[test]
fn evaluate_is_pure_over_10_000_scripted_ticks() {
    let stream = scripted_stream();
    let map = busy_map();
    map.validate().expect("busy map validates");
    let run = || {
        let mut state = ActionState::new(&map);
        let mut trace = Vec::with_capacity(stream.len());
        for (at, tick) in stream.iter().enumerate() {
            if at == 2_500 {
                state.disable(VEHICLE);
            }
            if at == 6_000 {
                state.enable(VEHICLE);
            }
            eval(&map, &mut state, tick);
            trace.push(format!("{state:?}"));
        }
        (state, trace)
    };
    let (first, first_trace) = run();
    let (second, second_trace) = run();
    assert_eq!(first, second, "the same stream gives an equal final state");
    assert_eq!(first_trace, second_trace, "and an equal state on every tick");
    assert!(first_trace.windows(2).any(|pair| pair[0] != pair[1]), "the stream actually moves the state");
}

fn refused(map: ActionMap) -> InputErrorCode {
    map.validate().expect_err("the map is refused").code
}

#[test]
fn validation_refuses_one_row_per_code_from_action_invalid_to_map_too_large() {
    let jump = |context: Context| context.button(JUMP, &[key("Space")]);
    let rows: Vec<(InputErrorCode, ActionMap)> = vec![
        (InputErrorCode::ActionInvalid, one(Context::new(PLAY, 0).button(ActionId::new("Jump!"), &[key("Space")]))),
        (InputErrorCode::ActionDuplicate, one(jump(jump(Context::new(PLAY, 0))))),
        (
            InputErrorCode::ContextDuplicate,
            ActionMap::new().context(Context::new(PLAY, 0)).context(Context::new(PLAY, 1)),
        ),
        (InputErrorCode::BindingMismatch, one(Context::new(PLAY, 0).button(JUMP, &[Binding::Stick(Stick::Left)]))),
        (
            InputErrorCode::BindingConflict,
            one(Context::new(PLAY, 0).button(JUMP, &[key("Space")]).button(FIRE, &[key("Space")])),
        ),
        (InputErrorCode::BindingReserved, one(Context::new(PLAY, 0).button(JUMP, &[key("Escape")]))),
        (InputErrorCode::MapTooLarge, too_many_actions()),
    ];
    let expected: Vec<InputErrorCode> = InputErrorCode::ALL[..7].to_vec();
    assert_eq!(rows.iter().map(|(code, _)| *code).collect::<Vec<_>>(), expected, "one row per code, in order");
    for (code, map) in rows {
        assert_eq!(refused(map), code);
    }
    let conflict = one(Context::new(PLAY, 0).button(JUMP, &[key("Space")]).button(FIRE, &[key("Space")]));
    assert_eq!(conflict.validate().expect_err("conflict").clash, Some(JUMP), "a conflict names the holder");
    let ui_escape = ActionMap::new();
    ui_escape.validate().expect("the ui context may read Escape");
    assert_eq!(names(&["a"]), vec!["a".to_owned()]);
}

const MANY: [&str; ACTIONS_MAX] = [
    "a00", "a01", "a02", "a03", "a04", "a05", "a06", "a07", "a08", "a09", "a10", "a11", "a12", "a13", "a14", "a15",
    "a16", "a17", "a18", "a19", "a20", "a21", "a22", "a23", "a24", "a25", "a26", "a27", "a28", "a29", "a30", "a31",
    "a32", "a33", "a34", "a35", "a36", "a37", "a38", "a39", "a40", "a41", "a42", "a43", "a44", "a45", "a46", "a47",
    "a48", "a49", "a50", "a51", "a52", "a53", "a54", "a55", "a56", "a57", "a58", "a59", "a60", "a61", "a62", "a63",
];

/// 64 game actions plus the eight built-in ones.
fn too_many_actions() -> ActionMap {
    let context = MANY.iter().fold(Context::new(PLAY, 0), |context, name| context.button(ActionId::new(name), &[]));
    one(context)
}

const DODGE: ActionId = ActionId::new("dodge");
const BLOCK: ActionId = ActionId::new("block");
const SPRINT: ActionId = ActionId::new("sprint");

#[test]
fn tap_cooldown_and_block_by_count_in_ticks() {
    let map = one(Context::new(PLAY, 0)
        .button(DODGE, &[key("KeyQ")])
        .when(Condition::Tap { max_ticks: 5 })
        .button(FIRE, &[key("KeyF")])
        .when(Condition::Cooldown { ticks: 3 })
        .button(BLOCK, &[key("KeyB")])
        .button(JUMP, &[key("Space")])
        .when(Condition::BlockBy(BLOCK)));
    let mut rig = Rig::new(map);
    rig.down(&["KeyQ"]);
    for _ in 0..4 {
        rig.idle();
    }
    rig.up(&["KeyQ"]);
    assert!(rig.state.fired(DODGE), "a 5-tick press is a tap");
    rig.down(&["KeyQ"]);
    for _ in 0..5 {
        rig.idle();
    }
    rig.up(&["KeyQ"]);
    assert!(!rig.state.fired(DODGE), "a 6-tick press is not");

    rig.down(&["KeyF"]);
    let mut fired = vec![rig.state.fired(FIRE)];
    for _ in 0..7 {
        rig.idle();
        fired.push(rig.state.fired(FIRE));
    }
    assert_eq!(fired, vec![true, false, false, true, false, false, true, false], "cooldown 3");

    rig.down(&["Space", "KeyB"]);
    assert!(rig.state.fired(BLOCK) && !rig.state.fired(JUMP), "block vetoes jump");
    assert!(rig.state.down(JUMP), "the veto is on firing, not on down");
    rig.up(&["KeyB"]);
    assert!(rig.state.fired(JUMP));
}

#[test]
fn slow_press_stretches_tap_windows_and_toggle_mode_latches_a_button() {
    let map = one(Context::new(PLAY, 0)
        .button(DODGE, &[key("KeyQ")])
        .when(Condition::Tap { max_ticks: 4 })
        .button(SPRINT, &[key("ShiftLeft")]));
    let mut rig = Rig::new(map);
    let mut access = rig.map.access().clone();
    access.slow_press_percent = 200;
    access.hold_mode.insert(SPRINT, genex_input::access::HoldMode::Toggle);
    rig.map.set_access(access).expect("in range");
    rig.down(&["KeyQ"]);
    for _ in 0..7 {
        rig.idle();
    }
    rig.up(&["KeyQ"]);
    assert!(rig.state.fired(DODGE), "an 8-tick press is a tap at 200 percent");

    rig.tap(&["ShiftLeft"]);
    for _ in 0..5 {
        rig.idle();
        assert!(rig.state.down(SPRINT), "toggle mode keeps sprint down after a tap");
    }
    rig.tap(&["ShiftLeft"]);
    assert!(!rig.state.down(SPRINT) && rig.state.released(SPRINT), "the next tap lets go");
}

#[test]
fn the_device_follows_the_last_input_and_reports_the_pad_family() {
    use genex_input::state::Device;
    let mut rig = Rig::new(vehicle_map(false));
    assert_eq!(rig.state.device(), Device::KeyboardMouse);
    rig.devices_family = PadFamily::PlayStation;
    rig.button(PadButton::South.index(), 1.0);
    assert_eq!(rig.state.device(), Device::Pad(PadFamily::PlayStation));
    assert_eq!(rig.state.device().as_str(), "pad");
    rig.idle();
    assert_eq!(rig.state.device(), Device::Pad(PadFamily::PlayStation), "holding changes nothing");
    rig.tap(&["KeyW"]);
    assert_eq!(rig.state.device(), Device::KeyboardMouse);
}
