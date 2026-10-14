//! The desktop platform's input contract past the keyboard: Mouse1 emulates one touch, gamepads
//! map onto the standard order, a Studio run never opens gilrs, and pointer lock is reported.

use genex_core::input::{MAX_PADS, PAD_AXES, PAD_BUTTONS, PadAxis, PadButton, PadStates};
use genex_platform_desktop::gilrs::{Axis, Button};
use genex_platform_desktop::winit::event::{ElementState, MouseButton};
use genex_platform_desktop::{
    GamepadPolicy, Gamepads, InputSampler, Letterbox, MAX_TOUCH_STEPS, MOUSE_TOUCH_ID, PadEvent, PadSlots, SampledTouch,
    ShellMode, TouchPhase, standard_axis, standard_button,
};

const WORLD: [u32; 2] = [320, 240];

fn view() -> Letterbox {
    Letterbox::fit([640.0, 480.0], WORLD)
}

fn touch(phase: TouchPhase, at: [f32; 2]) -> SampledTouch {
    SampledTouch { id: MOUSE_TOUCH_ID, phase, at }
}

fn index(constant: i32) -> usize {
    usize::try_from(constant).expect("a standard index")
}

#[test]
fn mouse1_produces_one_touch_id_through_start_move_and_end() {
    let mut sampler = InputSampler::default();
    sampler.cursor_moved([320.0, 240.0]);
    sampler.mouse_button(MouseButton::Left, ElementState::Pressed);
    assert_eq!(sampler.take(view()).touches, [touch(TouchPhase::Start, [0.5, 0.5])]);
    sampler.cursor_moved([160.0, 120.0]);
    sampler.cursor_moved([64.0, 48.0]);
    assert_eq!(sampler.take(view()).touches, [touch(TouchPhase::Move, [0.1, 0.1])], "moves coalesce per frame");
    assert!(sampler.take(view()).touches.is_empty(), "no movement, no step");
    sampler.cursor_moved([640.0, 480.0]);
    sampler.mouse_button(MouseButton::Left, ElementState::Released);
    assert_eq!(sampler.take(view()).touches, [touch(TouchPhase::End, [1.0, 1.0])], "the end carries the last position");
    sampler.mouse_button(MouseButton::Left, ElementState::Pressed);
    let again = sampler.take(view()).touches;
    assert_eq!(again.iter().map(|t| t.id).collect::<Vec<_>>(), [MOUSE_TOUCH_ID], "the next press reuses the one id");
}

#[test]
fn a_click_faster_than_a_frame_starts_and_ends_in_that_frame() {
    let mut sampler = InputSampler::default();
    sampler.mouse_button(MouseButton::Left, ElementState::Pressed);
    sampler.mouse_button(MouseButton::Left, ElementState::Released);
    let sample = sampler.take(view());
    assert_eq!(
        sample.touches,
        [touch(TouchPhase::Start, [0.5, 0.5]), touch(TouchPhase::End, [0.5, 0.5])],
        "the cursor never moved: the centre, as the pointer"
    );
    assert_eq!(sample.pressed, ["Mouse1"], "the button is still sampled as a key too");
}

#[test]
fn other_buttons_and_repeated_presses_make_no_touch() {
    let mut sampler = InputSampler::default();
    sampler.mouse_button(MouseButton::Right, ElementState::Pressed);
    sampler.mouse_button(MouseButton::Middle, ElementState::Pressed);
    sampler.mouse_button(MouseButton::Left, ElementState::Released);
    assert!(sampler.take(view()).touches.is_empty(), "a release without a press ends nothing");
    sampler.mouse_button(MouseButton::Left, ElementState::Pressed);
    sampler.mouse_button(MouseButton::Left, ElementState::Pressed);
    assert_eq!(sampler.take(view()).touches.len(), 1, "a repeated press is one start");
}

#[test]
fn losing_focus_ends_the_emulated_touch() {
    let mut sampler = InputSampler::default();
    sampler.cursor_moved([100.0, 100.0]);
    sampler.mouse_button(MouseButton::Left, ElementState::Pressed);
    sampler.take(view());
    sampler.focus_lost();
    let ended = sampler.take(view()).touches;
    assert_eq!(ended.iter().map(|t| t.phase).collect::<Vec<_>>(), [TouchPhase::End]);
    sampler.mouse_button(MouseButton::Left, ElementState::Released);
    assert!(sampler.take(view()).touches.is_empty(), "the late release ends nothing twice");
}

/// Hostile stream: a flood of clicks within one frame is capped, and every step stays in 0..1.
#[test]
fn a_flood_of_clicks_is_capped_per_frame() {
    let mut sampler = InputSampler::default();
    sampler.cursor_moved([f32::NAN, -5000.0]);
    for _ in 0..MAX_TOUCH_STEPS * 4 {
        sampler.mouse_button(MouseButton::Left, ElementState::Pressed);
        sampler.mouse_button(MouseButton::Left, ElementState::Released);
    }
    let touches = sampler.take(view()).touches;
    assert_eq!(touches.len(), MAX_TOUCH_STEPS);
    assert!(touches.iter().all(|t| t.at.iter().all(|v| (0.0..=1.0).contains(v))), "{touches:?}");
}

#[test]
fn touch_phases_use_the_wire_spellings() {
    let wires: Vec<_> = TouchPhase::ALL.iter().map(|phase| phase.as_str()).collect();
    assert_eq!(wires, ["start", "move", "end"]);
}

/// Every standard-order button index is the target of exactly one gilrs button.
#[test]
fn the_gamepad_button_table_covers_the_standard_order_exactly_once() {
    let gilrs_buttons = [
        Button::South,
        Button::East,
        Button::North,
        Button::West,
        Button::C,
        Button::Z,
        Button::LeftTrigger,
        Button::LeftTrigger2,
        Button::RightTrigger,
        Button::RightTrigger2,
        Button::Select,
        Button::Start,
        Button::Mode,
        Button::LeftThumb,
        Button::RightThumb,
        Button::DPadUp,
        Button::DPadDown,
        Button::DPadLeft,
        Button::DPadRight,
        Button::Unknown,
    ];
    let mut hits = [0; PAD_BUTTONS];
    for button in gilrs_buttons {
        if let Some(slot) = standard_button(button) {
            hits[slot] += 1;
        }
    }
    assert_eq!(hits, [1; PAD_BUTTONS], "standard indexes 0..{PAD_BUTTONS}");
    let named = [
        (Button::South, PadButton::A),
        (Button::East, PadButton::B),
        (Button::West, PadButton::X),
        (Button::North, PadButton::Y),
        (Button::LeftTrigger, PadButton::LEFT_BUMPER),
        (Button::RightTrigger, PadButton::RIGHT_BUMPER),
        (Button::LeftTrigger2, PadButton::LEFT_TRIGGER),
        (Button::RightTrigger2, PadButton::RIGHT_TRIGGER),
        (Button::Select, PadButton::BACK),
        (Button::Start, PadButton::START),
        (Button::LeftThumb, PadButton::LEFT_STICK),
        (Button::RightThumb, PadButton::RIGHT_STICK),
        (Button::DPadUp, PadButton::UP),
        (Button::DPadDown, PadButton::DOWN),
        (Button::DPadLeft, PadButton::LEFT),
        (Button::DPadRight, PadButton::RIGHT),
        (Button::Mode, PadButton::HOME),
    ];
    for (button, standard) in named {
        assert_eq!(standard_button(button), Some(index(standard)), "{button:?}");
    }
}

#[test]
fn the_gamepad_axis_table_covers_the_standard_order_exactly_once() {
    let gilrs_axes = [
        Axis::LeftStickX,
        Axis::LeftStickY,
        Axis::LeftZ,
        Axis::RightStickX,
        Axis::RightStickY,
        Axis::RightZ,
        Axis::DPadX,
        Axis::DPadY,
        Axis::Unknown,
    ];
    let mut hits = [0; PAD_AXES];
    for axis in gilrs_axes {
        if let Some((slot, _)) = standard_axis(axis) {
            hits[slot] += 1;
        }
    }
    assert_eq!(hits, [1; PAD_AXES]);
    assert_eq!(standard_axis(Axis::LeftStickX), Some((index(PadAxis::LEFT_X), 1.0)));
    assert_eq!(standard_axis(Axis::LeftStickY), Some((index(PadAxis::LEFT_Y), -1.0)), "gilrs y is up, the standard's down");
    assert_eq!(standard_axis(Axis::RightStickX), Some((index(PadAxis::RIGHT_X), 1.0)));
    assert_eq!(standard_axis(Axis::RightStickY), Some((index(PadAxis::RIGHT_Y), -1.0)));
}

#[test]
fn pad_events_fill_slots_in_connection_order() {
    let mut slots = PadSlots::default();
    slots.apply(40, PadEvent::Connected);
    slots.apply(7, PadEvent::Button(Button::South, 1.0));
    slots.apply(40, PadEvent::Axis(Axis::LeftStickY, 0.5));
    slots.apply(40, PadEvent::Axis(Axis::DPadX, -1.0));
    let states = slots.states();
    assert!(states[0].connected && states[1].connected && !states[2].connected);
    assert_eq!(states[0].axes[index(PadAxis::LEFT_Y)], -0.5);
    assert_eq!(states[0].buttons[index(PadButton::LEFT)], 1.0, "a d-pad axis drives the d-pad buttons");
    assert_eq!(states[1].buttons[index(PadButton::A)], 1.0, "an unseen pad takes the next slot");
    slots.apply(40, PadEvent::Disconnected);
    assert_eq!(slots.states()[0], Default::default(), "a disconnect clears its slot");
    slots.apply(41, PadEvent::Connected);
    assert!(slots.states()[0].connected, "a freed slot is reused");
}

/// Hostile values and more pads than slots: values stay in range and extra pads are ignored.
#[test]
fn hostile_pad_values_are_clamped_and_extra_pads_ignored() {
    let mut slots = PadSlots::default();
    let rows = [(f32::NAN, 0.0), (7.0, 1.0), (-3.0, 0.0), (0.25, 0.25)];
    for (value, expected) in rows {
        slots.apply(0, PadEvent::Button(Button::RightTrigger2, value));
        assert_eq!(slots.states()[0].buttons[index(PadButton::RIGHT_TRIGGER)], expected, "{value}");
    }
    slots.apply(0, PadEvent::Axis(Axis::RightStickX, f32::INFINITY));
    assert_eq!(slots.states()[0].axes[index(PadAxis::RIGHT_X)], 0.0, "a non-finite axis reads as rest");
    let before = slots.states();
    slots.apply(0, PadEvent::Button(Button::Unknown, 1.0));
    slots.apply(0, PadEvent::Axis(Axis::LeftZ, 1.0));
    assert_eq!(slots.states(), before, "elements outside the standard order change nothing");
    for id in 1..=(MAX_PADS + 3) {
        slots.apply(100 + id, PadEvent::Connected);
    }
    let states = slots.states();
    assert!(states.iter().all(|pad| pad.connected));
    slots.apply(100 + MAX_PADS + 3, PadEvent::Button(Button::South, 1.0));
    assert_eq!(slots.states(), states, "a pad past the last slot is ignored");
}

/// A Studio run reads pads only from the host's `input` op: gilrs is never opened.
#[test]
fn gilrs_is_off_under_studio_and_headless() {
    let rows = [
        (ShellMode::Windowed, false, GamepadPolicy::Gilrs),
        (ShellMode::Windowed, true, GamepadPolicy::Off),
        (ShellMode::Headless, false, GamepadPolicy::Off),
        (ShellMode::Headless, true, GamepadPolicy::Off),
    ];
    for (mode, studio, policy) in rows {
        assert_eq!(GamepadPolicy::for_run(mode, studio), policy, "{mode:?} studio={studio}");
    }
    let mut pads = Gamepads::open(GamepadPolicy::Off);
    assert!(!pads.is_open());
    assert_eq!(pads.poll(), PadStates::default());
}

#[test]
fn pointer_lock_is_reported_in_the_sample() {
    let mut sampler = InputSampler::default();
    assert!(!sampler.take(view()).pointer_lock);
    sampler.set_pointer_lock(true);
    assert!(sampler.take(view()).pointer_lock);
    sampler.focus_lost();
    assert!(!sampler.take(view()).pointer_lock, "focus loss releases the lock");
}
