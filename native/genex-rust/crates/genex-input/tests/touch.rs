//! Touch controls (IN-8): sticks (fixed and floating), buttons and a d-pad laid out in world
//! pixels, one finger per control, `Binding::Touch` and the virtual pad, the hostile layout table,
//! and the snapshot round trip. Every row is new behaviour: before IN-8 nothing turned a finger
//! into a control value. Rows feed `TickInput` touches the way genex-core's merger reports them
//! (one point per finger per tick), and one row goes through the merger itself.

use genex_core::input::{Injection, InputMerger, TickInput, TouchAction, TouchPhase, TouchPoint, TouchStep};
use genex_input::binding::{Binding, PadButton, Stick};
use genex_input::error::InputErrorCode;
use genex_input::id::{ActionId, ContextId, ControlId};
use genex_input::map::{ActionMap, Context};
use genex_input::state::{ActionState, Device, Devices, evaluate_with};
use genex_input::touch::{
    Anchor, ControlKind, PadTarget, ShowWhen, StickMode, TOUCH_CONTROLS_MAX, TouchControls, TouchFrame, TouchState,
    evaluate_touch, evaluate_touch_from,
};

const WORLD: [u32; 2] = [1280, 720];
const MOVE_STICK: ControlId = ControlId::new("move");
const JUMP_BUTTON: ControlId = ControlId::new("jump");
const DPAD: ControlId = ControlId::new("dpad");
const PLAY: ContextId = ContextId::new("play");
const MOVE: ActionId = ActionId::new("move");
const JUMP: ActionId = ActionId::new("jump");

/// The move stick's centre: 160 px from the left, 160 px up from the bottom.
const STICK_CENTRE: [f32; 2] = [160.0, 560.0];
/// The jump button's centre: 120 px from the right, 120 px up from the bottom.
const JUMP_CENTRE: [f32; 2] = [1160.0, 600.0];
/// The d-pad's centre: 120 px from the right, 120 px down from the top.
const DPAD_CENTRE: [f32; 2] = [1160.0, 120.0];

fn layout(mode: StickMode) -> TouchControls {
    TouchControls::new()
        .stick(MOVE_STICK, Anchor::BottomLeft([160.0, 160.0]), 80.0, mode)
        .button(JUMP_BUTTON, "Jump", Anchor::BottomRight([120.0, 120.0]), 60.0)
        .dpad(DPAD, Anchor::TopRight([120.0, 120.0]), 160.0)
}

fn point(id: u32, at: [f32; 2], phase: TouchPhase) -> TouchPoint {
    TouchPoint { id, x: at[0], y: at[1], phase }
}

fn tick(points: &[TouchPoint]) -> TickInput {
    TickInput { touches: points.to_vec(), ..TickInput::default() }
}

fn offset(at: [f32; 2], by: [f32; 2]) -> [f32; 2] {
    [at[0] + by[0], at[1] + by[1]]
}

/// A layout, its state, stepped one tick at a time.
struct Pad {
    controls: TouchControls,
    state: TouchState,
}

impl Pad {
    fn new(controls: TouchControls) -> Pad {
        controls.validate(WORLD).expect("the layout validates");
        let state = TouchState::new(&controls);
        Pad { controls, state }
    }

    fn step(&mut self, points: &[TouchPoint]) -> TouchFrame {
        evaluate_touch(&self.controls, WORLD, &mut self.state, &tick(points))
    }
}

#[test]
fn finger_3_at_the_stick_centre_moving_40_px_at_radius_80_reads_half_right() {
    for mode in [StickMode::Fixed, StickMode::Floating] {
        let mut pad = Pad::new(layout(mode));
        let frame = pad.step(&[point(3, STICK_CENTRE, TouchPhase::Began)]);
        assert_eq!(frame.value(MOVE_STICK), [0.0, 0.0], "{mode:?}: a finger on the centre reads 0");
        assert_eq!(pad.state.finger(MOVE_STICK), Some(3), "{mode:?}: finger 3 holds the stick");
        let frame = pad.step(&[point(3, offset(STICK_CENTRE, [40.0, 0.0]), TouchPhase::Held)]);
        assert_eq!(frame.value(MOVE_STICK), [0.5, 0.0], "{mode:?}: +40 px at radius 80 is half right");
        let frame = pad.step(&[point(3, offset(STICK_CENTRE, [400.0, 0.0]), TouchPhase::Held)]);
        assert_eq!(frame.value(MOVE_STICK), [1.0, 0.0], "{mode:?}: past the rim clamps to length 1");
        let frame = pad.step(&[point(3, offset(STICK_CENTRE, [0.0, -40.0]), TouchPhase::Held)]);
        assert_eq!(frame.value(MOVE_STICK), [0.0, -0.5], "{mode:?}: up is negative y, as on a pad");
    }
}

#[test]
fn a_floating_stick_centres_where_the_finger_lands_and_a_fixed_one_needs_its_circle() {
    let start = offset(STICK_CENTRE, [100.0, 30.0]);
    let mut floating = Pad::new(layout(StickMode::Floating));
    floating.step(&[point(1, start, TouchPhase::Began)]);
    assert_eq!(floating.state.finger(MOVE_STICK), Some(1), "inside the floating zone, outside the base");
    let frame = floating.step(&[point(1, offset(start, [-40.0, 0.0]), TouchPhase::Held)]);
    assert_eq!(frame.value(MOVE_STICK), [-0.5, 0.0], "the base sits where the finger landed");
    assert_eq!(floating.state.origin(MOVE_STICK), Some(start));

    let mut fixed = Pad::new(layout(StickMode::Fixed));
    let frame = fixed.step(&[point(1, start, TouchPhase::Began)]);
    assert_eq!(fixed.state.finger(MOVE_STICK), None, "outside a fixed stick's circle nothing is held");
    assert_eq!(frame.free(&tick(&[point(1, start, TouchPhase::Began)])).count(), 1, "the finger stays free");
}

#[test]
fn a_second_finger_in_the_same_zone_is_ignored_and_stays_free() {
    let mut pad = Pad::new(layout(StickMode::Fixed));
    pad.step(&[point(3, STICK_CENTRE, TouchPhase::Began)]);
    let second = offset(STICK_CENTRE, [-30.0, 0.0]);
    let points = [point(3, offset(STICK_CENTRE, [40.0, 0.0]), TouchPhase::Held), point(4, second, TouchPhase::Began)];
    let frame = pad.step(&points);
    assert_eq!(pad.state.finger(MOVE_STICK), Some(3), "the first finger keeps the stick");
    assert_eq!(frame.value(MOVE_STICK), [0.5, 0.0], "the second finger does not move it");
    let free: Vec<u32> = frame.free(&tick(&points)).map(|touch| touch.id).collect();
    assert_eq!(free, vec![4], "the ignored finger is left to the game");
    // The first finger lifts; the second, which started before, does not take the stick over.
    let frame = pad.step(&[point(3, STICK_CENTRE, TouchPhase::Ended), point(4, second, TouchPhase::Held)]);
    assert_eq!(pad.state.finger(MOVE_STICK), None);
    assert_eq!(frame.value(MOVE_STICK), [0.0, 0.0]);
}

#[test]
fn one_finger_holds_one_control_and_two_fingers_hold_two() {
    let mut pad = Pad::new(layout(StickMode::Fixed));
    let frame = pad.step(&[point(1, STICK_CENTRE, TouchPhase::Began), point(2, JUMP_CENTRE, TouchPhase::Began)]);
    assert_eq!(pad.state.finger(MOVE_STICK), Some(1));
    assert_eq!(pad.state.finger(JUMP_BUTTON), Some(2));
    assert_eq!(frame.value(JUMP_BUTTON), [1.0, 0.0]);
    // Sliding the stick finger onto the jump button never presses it: a finger holds one control.
    let frame = pad.step(&[point(1, JUMP_CENTRE, TouchPhase::Held), point(2, JUMP_CENTRE, TouchPhase::Ended)]);
    assert_eq!(frame.value(JUMP_BUTTON), [0.0, 0.0], "the jump finger lifted");
    let [x, y] = frame.value(MOVE_STICK);
    assert!(x > 0.99 && y > 0.0, "the stick finger still drives the stick: ({x}, {y})");
    assert!(((x * x + y * y) - 1.0).abs() < 1e-6, "clamped to length 1");
}

#[test]
fn a_tapped_finger_on_jump_gives_exactly_one_press() {
    let controls = layout(StickMode::Fixed);
    let map = ActionMap::new().context(
        Context::new(PLAY, 0).axis2(MOVE, &[Binding::Touch(MOVE_STICK)]).button(JUMP, &[Binding::Touch(JUMP_BUTTON)]),
    );
    map.validate().expect("the map validates");
    controls.check_bindings(&map).expect("the touch bindings name declared controls");
    let mut pad = Pad::new(controls);
    let mut actions = ActionState::new(&map);
    let mut presses = 0;
    let mut downs = 0;
    for step in 0..10 {
        let points = if step == 2 { vec![point(7, JUMP_CENTRE, TouchPhase::Tapped)] } else { Vec::new() };
        let frame = pad.step(&points);
        let input = tick(&points);
        evaluate_with(&map, &mut actions, &input, &Devices { touch: frame.values(), ..Devices::default() });
        presses += usize::from(actions.pressed(JUMP));
        downs += usize::from(actions.down(JUMP));
    }
    assert_eq!(presses, 1, "a tap is one press");
    assert_eq!(downs, 1, "held for the tap's one tick");
    assert_eq!(pad.state.finger(JUMP_BUTTON), None, "a tap holds nothing afterwards");
    assert_eq!(actions.device(), Device::Touch);
}

#[test]
fn the_dpad_reads_eight_directions_with_a_dead_centre() {
    let mut pad = Pad::new(layout(StickMode::Fixed));
    let rows: [([f32; 2], [f32; 2]); 5] = [
        ([0.0, 0.0], [0.0, 0.0]),
        ([10.0, -5.0], [0.0, 0.0]),
        ([60.0, 0.0], [1.0, 0.0]),
        ([0.0, -60.0], [0.0, -1.0]),
        ([-60.0, 60.0], [-core::f32::consts::FRAC_1_SQRT_2, core::f32::consts::FRAC_1_SQRT_2]),
    ];
    pad.step(&[point(5, DPAD_CENTRE, TouchPhase::Began)]);
    for (by, want) in rows {
        let frame = pad.step(&[point(5, offset(DPAD_CENTRE, by), TouchPhase::Held)]);
        assert_eq!(frame.value(DPAD), want, "d-pad at {by:?}");
    }
}

#[test]
fn an_end_or_a_lost_finger_resets_the_control() {
    let mut pad = Pad::new(layout(StickMode::Fixed));
    pad.step(&[point(3, STICK_CENTRE, TouchPhase::Began), point(4, JUMP_CENTRE, TouchPhase::Began)]);
    pad.step(&[point(3, offset(STICK_CENTRE, [40.0, 0.0]), TouchPhase::Held), point(4, JUMP_CENTRE, TouchPhase::Held)]);
    // Finger 3 ends; finger 4 is simply gone (lost, no end) on the same tick.
    let frame = pad.step(&[point(3, offset(STICK_CENTRE, [40.0, 0.0]), TouchPhase::Ended)]);
    assert_eq!(frame.value(MOVE_STICK), [0.0, 0.0], "an end resets the stick on its tick");
    assert_eq!(frame.value(JUMP_BUTTON), [0.0, 0.0], "a lost finger resets the button");
    assert_eq!(pad.state.finger(MOVE_STICK), None);
    assert_eq!(pad.state.finger(JUMP_BUTTON), None);
    // A reused id that begins again starts a new touch, not the old one.
    pad.step(&[point(3, STICK_CENTRE, TouchPhase::Began)]);
    let frame = pad.step(&[point(3, JUMP_CENTRE, TouchPhase::Began)]);
    assert_eq!(pad.state.finger(MOVE_STICK), None, "the re-begun id let go of the stick");
    assert_eq!(pad.state.finger(JUMP_BUTTON), Some(3));
    assert_eq!(frame.value(JUMP_BUTTON), [1.0, 0.0]);
}

/// A scripted session over every control: taps, holds, drags, a lost finger.
fn script() -> Vec<Vec<TouchPoint>> {
    let mut rows = Vec::new();
    for step in 0..120u32 {
        let t = step as f32;
        let mut points = Vec::new();
        if (5..60).contains(&step) {
            let phase = if step == 5 { TouchPhase::Began } else { TouchPhase::Held };
            points.push(point(1, offset(STICK_CENTRE, [t - 5.0, (t * 0.5) - 10.0]), phase));
        }
        if step == 60 {
            points.push(point(1, STICK_CENTRE, TouchPhase::Ended));
        }
        if step % 17 == 3 {
            points.push(point(2, JUMP_CENTRE, TouchPhase::Tapped));
        }
        if (70..100).contains(&step) {
            let phase = if step == 70 { TouchPhase::Began } else { TouchPhase::Held };
            points.push(point(9, offset(DPAD_CENTRE, [60.0 - t, 30.0]), phase));
        }
        rows.push(points);
    }
    rows
}

#[test]
fn evaluation_is_identical_with_show_never_and_always() {
    let mut never = Pad::new(layout(StickMode::Floating).show(ShowWhen::Never));
    let mut always = Pad::new(layout(StickMode::Floating).show(ShowWhen::Always));
    for points in script() {
        assert_eq!(never.step(&points), always.step(&points));
    }
    assert_eq!(never.state, always.state);
    assert!(!never.controls.visible(Device::Touch));
    assert!(always.controls.visible(Device::KeyboardMouse));
    let auto = layout(StickMode::Fixed);
    assert_eq!(auto.show_when(), ShowWhen::Touch, "shown after a touch by default");
    assert!(auto.visible(Device::Touch) && !auto.visible(Device::KeyboardMouse));
}

#[test]
fn touch_state_round_trips_through_snapshot_and_restore() {
    let rows = script();
    for cut in [0, 6, 30, 75, 119] {
        let mut straight = Pad::new(layout(StickMode::Floating));
        let mut frames = Vec::new();
        for points in &rows {
            frames.push(straight.step(points));
        }
        let mut first = Pad::new(layout(StickMode::Floating));
        for points in &rows[..cut] {
            first.step(points);
        }
        let snapshot = first.state.snapshot();
        let text = serde_json::to_string(&snapshot).expect("a snapshot is JSON");
        let value: serde_json::Value = serde_json::from_str(&text).expect("it parses back");
        let mut resumed = Pad::new(layout(StickMode::Floating));
        resumed.state = TouchState::restore(&resumed.controls, &value).expect("its own snapshot restores");
        assert_eq!(resumed.state, first.state, "cut {cut}: the restored state equals the saved one");
        for (at, points) in rows.iter().enumerate().skip(cut) {
            assert_eq!(resumed.step(points), frames[at], "cut {cut}, tick {at}");
        }
    }
}

#[test]
fn a_hostile_snapshot_is_refused_and_nothing_is_restored() {
    let controls = layout(StickMode::Fixed);
    let good = TouchState::new(&controls).snapshot();
    let mut rows: Vec<(&str, serde_json::Value)> = vec![
        ("not an object", serde_json::json!([1, 2])),
        ("another format", serde_json::json!({"format": "genex-touch/2", "controls": []})),
        ("missing controls", serde_json::json!({"format": "genex-touch/1"})),
        ("too few controls", serde_json::json!({"format": "genex-touch/1", "controls": []})),
    ];
    let mut renamed = good.clone();
    renamed["controls"][0]["id"] = serde_json::json!("other");
    rows.push(("a renamed control", renamed));
    let mut bad_finger = good.clone();
    bad_finger["controls"][0]["finger"] = serde_json::json!(-1);
    rows.push(("a negative finger", bad_finger));
    let mut huge_finger = good.clone();
    huge_finger["controls"][0]["finger"] = serde_json::json!(5_000_000_000u64);
    rows.push(("a finger past u32", huge_finger));
    let mut bad_origin = good.clone();
    bad_origin["controls"][0]["origin"] = serde_json::json!(["x", 1.0]);
    rows.push(("a non-numeric origin", bad_origin));
    let mut short_origin = good.clone();
    short_origin["controls"][0]["origin"] = serde_json::json!([1.0]);
    rows.push(("a one-number origin", short_origin));
    let mut shared = good.clone();
    shared["controls"][0]["finger"] = serde_json::json!(4);
    shared["controls"][1]["finger"] = serde_json::json!(4);
    rows.push(("one finger on two controls", shared));
    for (name, value) in rows {
        let refused = TouchState::restore(&controls, &value).expect_err(name);
        assert_eq!(refused.code, InputErrorCode::TouchControlsInvalid, "{name}");
    }
    assert_eq!(TouchState::restore(&controls, &good), Ok(TouchState::new(&controls)));
}

#[test]
fn hostile_layouts_refuse_touch_controls_invalid() {
    let base = || TouchControls::new().button(JUMP_BUTTON, "Jump", Anchor::BottomRight([120.0, 120.0]), 60.0);
    let mut thirteen = TouchControls::new();
    for (index, name) in ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m"].into_iter().enumerate() {
        let x = 40.0 + 90.0 * index as f32;
        thirteen = thirteen.button(ControlId::new(name), name, Anchor::At([x, 360.0]), 40.0);
    }
    let long_label = "x".repeat(200);
    let rows: Vec<(&str, TouchControls)> = vec![
        ("overlap", base().button(ControlId::new("fire"), "Fire", Anchor::BottomRight([150.0, 120.0]), 60.0)),
        ("outside the world", base().stick(MOVE_STICK, Anchor::At([20.0, 360.0]), 80.0, StickMode::Fixed)),
        ("a floating zone outside the world", base().stick(MOVE_STICK, Anchor::BottomLeft([100.0, 100.0]), 80.0, StickMode::Floating)),
        ("13 controls", thirteen),
        ("radius 0", base().button(ControlId::new("fire"), "Fire", Anchor::At([400.0, 360.0]), 0.0)),
        ("negative radius", base().button(ControlId::new("fire"), "Fire", Anchor::At([400.0, 360.0]), -5.0)),
        ("NaN radius", base().button(ControlId::new("fire"), "Fire", Anchor::At([400.0, 360.0]), f32::NAN)),
        ("NaN anchor", base().button(ControlId::new("fire"), "Fire", Anchor::At([f32::NAN, 360.0]), 40.0)),
        ("infinite anchor", base().dpad(DPAD, Anchor::TopLeft([f32::INFINITY, 100.0]), 100.0)),
        ("duplicate id", base().button(JUMP_BUTTON, "Again", Anchor::At([400.0, 360.0]), 40.0)),
        ("bad id", base().button(ControlId::new("Fire!"), "Fire", Anchor::At([400.0, 360.0]), 40.0)),
        ("long label", base().button(ControlId::new("fire"), &long_label, Anchor::At([400.0, 360.0]), 40.0)),
        ("control character in label", base().button(ControlId::new("fire"), "Fi\u{0}re", Anchor::At([400.0, 360.0]), 40.0)),
        ("empty label", base().button(ControlId::new("fire"), "", Anchor::At([400.0, 360.0]), 40.0)),
        ("pad target before a control", TouchControls::new().on_pad(PadTarget::Dpad)),
        ("a stick on a pad button", base().stick(MOVE_STICK, Anchor::At([300.0, 360.0]), 80.0, StickMode::Fixed).on_pad(PadTarget::Button(PadButton::South))),
        ("a button on a pad stick", base().on_pad(PadTarget::Stick(Stick::Left))),
        ("two controls on one pad input", base().on_pad(PadTarget::Button(PadButton::South)).button(ControlId::new("fire"), "Fire", Anchor::At([400.0, 360.0]), 40.0).on_pad(PadTarget::Button(PadButton::South))),
    ];
    for (name, controls) in rows {
        let refused = controls.validate(WORLD).expect_err(name);
        assert_eq!(refused.code, InputErrorCode::TouchControlsInvalid, "{name}: {}", refused.detail);
    }
    assert_eq!(layout(StickMode::Fixed).validate([0, 720]).map_err(|e| e.code), Err(InputErrorCode::TouchControlsInvalid), "an empty world");
    assert!(layout(StickMode::Fixed).validate(WORLD).is_ok());
    assert!(TouchControls::new().validate(WORLD).is_ok(), "no controls is a valid layout");
    assert_eq!(TOUCH_CONTROLS_MAX, 12);
}

#[test]
fn touch_bindings_must_name_a_declared_control_of_a_fitting_kind() {
    let controls = layout(StickMode::Fixed);
    let unknown = ActionMap::new().context(Context::new(PLAY, 0).button(JUMP, &[Binding::Touch(ControlId::new("fire"))]));
    assert_eq!(controls.check_bindings(&unknown).map_err(|e| e.code), Err(InputErrorCode::TouchControlsInvalid));
    let stick_on_button = ActionMap::new().context(Context::new(PLAY, 0).button(JUMP, &[Binding::Touch(MOVE_STICK)]));
    assert_eq!(controls.check_bindings(&stick_on_button).map_err(|e| e.code), Err(InputErrorCode::BindingMismatch));
    let button_on_axis2 = ActionMap::new().context(Context::new(PLAY, 0).axis2(MOVE, &[Binding::Touch(JUMP_BUTTON)]));
    assert_eq!(controls.check_bindings(&button_on_axis2).map_err(|e| e.code), Err(InputErrorCode::BindingMismatch));
    let fine = ActionMap::new()
        .context(Context::new(PLAY, 0).axis2(MOVE, &[Binding::WASD, Binding::Touch(MOVE_STICK), Binding::Touch(DPAD)]));
    assert!(controls.check_bindings(&fine).is_ok());
}

#[test]
fn controls_with_a_pad_target_drive_a_virtual_pad() {
    let controls = TouchControls::new()
        .stick(MOVE_STICK, Anchor::BottomLeft([160.0, 160.0]), 80.0, StickMode::Fixed)
        .on_pad(PadTarget::Stick(Stick::Left))
        .button(JUMP_BUTTON, "Jump", Anchor::BottomRight([120.0, 120.0]), 60.0)
        .on_pad(PadTarget::Button(PadButton::South))
        .dpad(DPAD, Anchor::TopRight([120.0, 120.0]), 160.0)
        .on_pad(PadTarget::Dpad);
    assert!(matches!(controls.controls()[0].kind, ControlKind::Stick(StickMode::Fixed)));
    let mut pad = Pad::new(controls);
    let frame = pad.step(&[]);
    let idle = frame.virtual_pad().expect("a layout with pad targets has a virtual pad");
    assert!(idle.connected, "the virtual pad is connected while the layout is registered");
    assert!(idle.buttons.iter().chain(&idle.axes).all(|value| *value == 0.0), "and reads neutral at rest");
    pad.step(&[point(1, STICK_CENTRE, TouchPhase::Began), point(2, JUMP_CENTRE, TouchPhase::Began), point(3, DPAD_CENTRE, TouchPhase::Began)]);
    let frame = pad.step(&[
        point(1, offset(STICK_CENTRE, [40.0, -20.0]), TouchPhase::Held),
        point(2, JUMP_CENTRE, TouchPhase::Held),
        point(3, offset(DPAD_CENTRE, [0.0, 60.0]), TouchPhase::Held),
    ]);
    let virtual_pad = frame.virtual_pad().expect("virtual pad");
    assert_eq!(virtual_pad.axes[0..2], [0.5, -0.25], "the stick is the left stick");
    assert_eq!(virtual_pad.buttons[PadButton::South.index()], 1.0, "jump is South");
    assert_eq!(virtual_pad.buttons[PadButton::DpadDown.index()], 1.0, "the d-pad presses its buttons");
    assert_eq!(virtual_pad.buttons[PadButton::DpadUp.index()], 0.0);
    // A layout without pad targets has no virtual pad.
    let mut plain = Pad::new(layout(StickMode::Fixed));
    assert_eq!(plain.step(&[]).virtual_pad(), None);
}

#[test]
fn the_merger_drives_a_control_end_to_end() {
    let mut merger = InputMerger::default();
    let mut pad = Pad::new(layout(StickMode::Fixed));
    let action = |id: u32, step: TouchStep, at: [f32; 2]| TouchAction { id, step, x: at[0], y: at[1] };
    let steps = [
        vec![action(3, TouchStep::Start, STICK_CENTRE)],
        vec![action(3, TouchStep::Move, offset(STICK_CENTRE, [40.0, 0.0]))],
        vec![],
        vec![action(3, TouchStep::End, offset(STICK_CENTRE, [40.0, 0.0]))],
    ];
    let mut values = Vec::new();
    for touches in steps {
        merger.inject(&Injection { touches, ..Injection::default() });
        let input = merger.next_tick();
        values.push(evaluate_touch(&pad.controls, WORLD, &mut pad.state, &input).value(MOVE_STICK));
    }
    assert_eq!(values, vec![[0.0, 0.0], [0.5, 0.0], [0.5, 0.0], [0.0, 0.0]]);
}

#[test]
fn zones_are_world_rects_for_the_painter_and_accesskit() {
    let controls = layout(StickMode::Floating);
    let zones: Vec<(ControlId, [f32; 4])> =
        controls.controls().iter().map(|control| (control.id, control.zone(WORLD))).collect();
    assert_eq!(
        zones,
        vec![
            (MOVE_STICK, [0.0, 400.0, 320.0, 720.0]),
            (JUMP_BUTTON, [1100.0, 540.0, 1220.0, 660.0]),
            (DPAD, [1080.0, 40.0, 1240.0, 200.0]),
        ],
        "a floating stick's zone is twice its radius; a button's is its circle's box; a d-pad's its square"
    );
    assert_eq!(controls.controls()[1].label, "Jump");
    assert_eq!(controls.controls()[0].label, "move", "a stick is labelled by its id");
}

// ---- the desktop mouse (release R-26) -------------------------------------------------------------

/// The finger the desktop shell emulates from Mouse1 (the facade's touch 0).
const MOUSE_FINGER: u32 = 0;

#[test]
fn the_mouse_finger_presses_no_hidden_control_and_stays_free() {
    // Red before R-26: a desktop click in a corner pressed the invisible Jump button.
    for show in [ShowWhen::Touch, ShowWhen::Never] {
        let controls = layout(StickMode::Floating).show(show);
        let mut state = TouchState::new(&controls);
        for phase in [TouchPhase::Began, TouchPhase::Held, TouchPhase::Ended] {
            let tick = tick(&[point(MOUSE_FINGER, JUMP_CENTRE, phase)]);
            let frame = evaluate_touch_from(&controls, WORLD, &mut state, &tick, Some(MOUSE_FINGER));
            assert_eq!(frame.value(JUMP_BUTTON), [0.0, 0.0], "{show:?} {phase:?}: the hidden button is not pressed");
            assert!(!frame.claimed(MOUSE_FINGER), "{show:?} {phase:?}: the click stays the game's");
            assert_eq!(state.finger(JUMP_BUTTON), None, "{show:?} {phase:?}");
        }
        let tapped = tick(&[point(MOUSE_FINGER, JUMP_CENTRE, TouchPhase::Tapped)]);
        let frame = evaluate_touch_from(&controls, WORLD, &mut state, &tapped, Some(MOUSE_FINGER));
        assert_eq!(frame.value(JUMP_BUTTON), [0.0, 0.0], "{show:?}: a click (one-tick tap) is not a press either");
        assert_eq!(frame.free(&tapped).count(), 1, "{show:?}");
    }
}

#[test]
fn the_mouse_finger_presses_an_always_shown_control_and_real_fingers_press_every_layout() {
    let controls = layout(StickMode::Floating).show(ShowWhen::Always);
    let mut state = TouchState::new(&controls);
    let began = tick(&[point(MOUSE_FINGER, JUMP_CENTRE, TouchPhase::Began)]);
    let frame = evaluate_touch_from(&controls, WORLD, &mut state, &began, Some(MOUSE_FINGER));
    assert_eq!(frame.value(JUMP_BUTTON), [1.0, 0.0], "a click on a control the player sees presses it");
    assert!(frame.claimed(MOUSE_FINGER));
    for show in [ShowWhen::Touch, ShowWhen::Never, ShowWhen::Always] {
        let controls = layout(StickMode::Floating).show(show);
        let mut state = TouchState::new(&controls);
        // A real finger 0 (no Mouse1 emulation on the tick) is a finger like any other.
        let frame = evaluate_touch_from(&controls, WORLD, &mut state, &began, None);
        assert_eq!(frame.value(JUMP_BUTTON), [1.0, 0.0], "{show:?}");
        let mut plain = TouchState::new(&controls);
        assert_eq!(evaluate_touch(&controls, WORLD, &mut plain, &began), frame, "{show:?}: evaluate_touch has no mouse finger");
    }
}

#[test]
fn a_mouse_finger_that_was_refused_does_not_take_a_control_it_slides_onto_later() {
    let controls = layout(StickMode::Fixed).show(ShowWhen::Touch);
    let mut state = TouchState::new(&controls);
    let rows = [
        point(MOUSE_FINGER, [640.0, 360.0], TouchPhase::Began),
        point(MOUSE_FINGER, STICK_CENTRE, TouchPhase::Held),
        point(MOUSE_FINGER, offset(STICK_CENTRE, [40.0, 0.0]), TouchPhase::Held),
    ];
    for row in rows {
        let frame = evaluate_touch_from(&controls, WORLD, &mut state, &tick(&[row]), Some(MOUSE_FINGER));
        assert_eq!(frame.value(MOVE_STICK), [0.0, 0.0]);
    }
}

#[test]
fn touching_is_true_only_while_a_finger_is_down() {
    let controls = layout(StickMode::Floating);
    let mut state = TouchState::new(&controls);
    let away = [640.0, 360.0];
    let rows: [(&[TouchPoint], bool); 4] = [
        (&[], false),
        (&[point(4, away, TouchPhase::Began)], true),
        (&[point(4, away, TouchPhase::Held)], true),
        (&[point(4, away, TouchPhase::Ended)], false),
    ];
    for (points, touching) in rows {
        assert_eq!(evaluate_touch(&controls, WORLD, &mut state, &tick(points)).touching(), touching, "{points:?}");
    }
}

#[test]
fn a_label_names_the_last_stick_or_dpad_and_misuse_is_refused() {
    let controls = TouchControls::new()
        .stick(MOVE_STICK, Anchor::BottomLeft([160.0, 160.0]), 80.0, StickMode::Floating)
        .label("Move")
        .dpad(DPAD, Anchor::TopRight([120.0, 120.0]), 160.0);
    controls.validate(WORLD).expect("a labelled layout validates");
    let labels: Vec<(&str, bool)> = controls.controls().iter().map(|c| (c.label.as_str(), c.shows_label)).collect();
    assert_eq!(labels, [("Move", true), ("dpad", false)], "an unlabelled d-pad keeps its id as its AccessKit name only");
    let early = TouchControls::new().label("Move");
    assert_eq!(early.validate(WORLD).map_err(|e| e.code), Err(InputErrorCode::TouchControlsInvalid));
    let long = TouchControls::new().stick(MOVE_STICK, Anchor::BottomLeft([160.0, 160.0]), 80.0, StickMode::Fixed).label(&"m".repeat(33));
    assert_eq!(long.validate(WORLD).map_err(|e| e.code), Err(InputErrorCode::TouchControlsInvalid));
}
