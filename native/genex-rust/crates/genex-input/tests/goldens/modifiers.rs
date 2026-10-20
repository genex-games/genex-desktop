//! Dead zones, curves and the player's stick settings, through the action state.

use genex_input::access::Access;
use genex_input::binding::{Binding, PadAxis, Sign, Stick};
use genex_input::id::{ActionId, ContextId};
use genex_input::map::{ActionMap, Context};
use genex_input::modifier::{DeadZoneKind, Modifier, axial, radial};

use crate::Rig;

const PLAY: ContextId = ContextId::new("play");
const MOVE: ActionId = ActionId::new("move");
const LOOK: ActionId = ActionId::new("look");
const STEER: ActionId = ActionId::new("steer");

fn close(a: [f32; 2], b: [f32; 2]) -> bool {
    (a[0] - b[0]).abs() < 1e-6 && (a[1] - b[1]).abs() < 1e-6
}

fn length(v: [f32; 2]) -> f32 {
    (v[0] * v[0] + v[1] * v[1]).sqrt()
}

fn stick_map() -> ActionMap {
    ActionMap::new().context(
        Context::new(PLAY, 0)
            .axis2(MOVE, &[Binding::Stick(Stick::Left), Binding::WASD])
            .axis2(LOOK, &[Binding::Stick(Stick::Right)]),
    )
}

#[test]
fn the_default_radial_dead_zone_is_godots_get_vector_at_0_15() {
    let mut rig = Rig::new(stick_map());
    rig.axes([0.12, 0.0, 0.0, 0.0]);
    assert_eq!(rig.state.axis2(MOVE), [0.0, 0.0], "(0.12, 0) is inside the dead zone");
    assert!(!rig.state.down(MOVE), "and does not actuate");
    rig.axes([0.575, 0.0, 0.0, 0.0]);
    assert!(close(rig.state.axis2(MOVE), [0.5, 0.0]), "(0.575, 0) maps to (0.5, 0): {:?}", rig.state.axis2(MOVE));
    rig.axes([0.9, 0.9, 0.0, 0.0]);
    let full = rig.state.axis2(MOVE);
    assert!((length(full) - 1.0).abs() < 1e-6, "(0.9, 0.9) is normalized to length 1: {full:?}");
    assert!((full[0] - full[1]).abs() < 1e-7, "keeping its direction");
}

#[test]
fn radial_and_axial_match_their_ported_formulas() {
    assert_eq!(radial([0.12, 0.0], 0.15, 1.0), [0.0, 0.0]);
    assert!(close(radial([0.575, 0.0], 0.15, 1.0), [0.5, 0.0]));
    assert!(close(radial([0.0, -0.575], 0.15, 1.0), [0.0, -0.5]));
    assert!(close(radial([3.0, 4.0], 0.15, 1.0), [0.6, 0.8]));
    assert_eq!(axial(0.1, 0.15, 1.0), 0.0);
    assert!((axial(-0.575, 0.15, 1.0) + 0.5).abs() < 1e-6);
    assert_eq!(axial(0.95, 0.15, 0.9), 1.0);
}

#[test]
fn wasd_diagonals_are_normalized_and_the_stronger_binding_wins() {
    let mut rig = Rig::new(stick_map());
    rig.down(&["KeyW", "KeyD"]);
    let diagonal = rig.state.axis2(MOVE);
    assert!((length(diagonal) - 1.0).abs() < 1e-6, "W+D has length 1: {diagonal:?}");
    assert!(diagonal[0] > 0.0 && diagonal[1] < 0.0, "up is y negative, right is x positive");
    rig.up(&["KeyW", "KeyD"]);
    rig.axes([0.4, 0.0, 0.0, 0.0]);
    let small = rig.state.axis2(MOVE);
    rig.down(&["KeyA"]);
    assert_eq!(rig.state.axis2(MOVE), [-1.0, 0.0], "a full key press beats a small stick tilt: {small:?}");
}

#[test]
fn access_dead_zone_invert_and_swap_apply_to_sticks() {
    let mut rig = Rig::new(stick_map());
    let mut access = Access { stick_dead_zone: [0.3, 0.15], invert_y: [false, true], ..Access::default() };
    rig.map.set_access(access.clone()).expect("in range");
    rig.axes([0.25, 0.0, 0.0, 0.5]);
    assert_eq!(rig.state.axis2(MOVE), [0.0, 0.0], "0.25 is inside the player's 0.3 left dead zone");
    let look = rig.state.axis2(LOOK);
    assert!(look[1] < 0.0, "the right stick's y is inverted: {look:?}");

    access.swap_sticks = true;
    access.invert_y = [false, false];
    rig.map.set_access(access).expect("in range");
    rig.axes([0.0, 0.0, 0.9, 0.0]);
    let swapped = rig.state.axis2(MOVE);
    let physical_right = (0.9 - 0.15) / 0.85;
    assert!(
        close(swapped, [physical_right, 0.0]),
        "swapped, move reads the physical right stick with that stick's dead zone: {swapped:?}"
    );
    assert_eq!(rig.state.axis2(LOOK), [0.0, 0.0]);
}

#[test]
fn action_modifiers_run_in_order_and_replace_the_default_dead_zone() {
    let map = ActionMap::new().context(
        Context::new(PLAY, 0)
            .axis2(MOVE, &[Binding::Stick(Stick::Left)])
            .modify(Modifier::DeadZone { kind: DeadZoneKind::Axial, lower: 0.05, upper: 1.0 })
            .modify(Modifier::Negate { x: true, y: false })
            .modify(Modifier::Swizzle)
            .axis1(STEER, &[Binding::PadAxis(PadAxis::RightX, Sign::Positive)])
            .modify(Modifier::Curve { exponent: 2.0 })
            .modify(Modifier::Scale { x: 2.0, y: 1.0 }),
    );
    let mut rig = Rig::new(map);
    rig.axes([0.1, 0.0, 0.5, 0.0]);
    let moved = rig.state.axis2(MOVE);
    let expected_x = -(0.1 - 0.05) / 0.95;
    assert!(close(moved, [0.0, expected_x]), "axial 0.05 then negate x then swizzle: {moved:?}");
    let steer = rig.state.value(STEER);
    let raw = (0.5 - 0.15) / 0.85;
    assert!((steer - 2.0 * raw * raw).abs() < 1e-6, "default half-axis dead zone, curve 2, scale 2: {steer}");
}

#[test]
fn a_modifier_that_cannot_work_is_refused() {
    let bad = |modifier: Modifier| {
        ActionMap::new()
            .context(Context::new(PLAY, 0).axis2(MOVE, &[Binding::Stick(Stick::Left)]).modify(modifier))
            .validate()
            .expect_err("refused")
            .code
    };
    use genex_input::error::InputErrorCode::ActionInvalid;
    assert_eq!(bad(Modifier::DeadZone { kind: DeadZoneKind::Radial, lower: 0.5, upper: 0.4 }), ActionInvalid);
    assert_eq!(bad(Modifier::Hysteresis { press: 0.3, release: 0.6 }), ActionInvalid);
    assert_eq!(bad(Modifier::Curve { exponent: f32::NAN }), ActionInvalid);
    assert_eq!(bad(Modifier::Scale { x: f32::INFINITY, y: 1.0 }), ActionInvalid);
}
