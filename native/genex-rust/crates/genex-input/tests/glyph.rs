//! Prompt glyphs (IN-10): SDL3 face labels per pad family, DOM key labels, and the display-only
//! keyboard layout override. A glyph is a label and a shape; it never feeds back into evaluation.

use genex_core::input::{Injection, InputMerger, PadState, TickInput};
use genex_input::binding::{Binding, ChordInput, KeyCode, PadAxis, PadButton, PadFamily, Sign, Stick};
use genex_input::glyph::{
    Glyph, GlyphShape, KEY_LABEL_BYTES_MAX, KEY_LABELS_MAX, KeyLabels, action_glyph, binding_glyph, hint, key_label,
    pad_label,
};
use genex_input::id::{ActionId, ContextId, ControlId};
use genex_input::map::{ActionMap, Context};
use genex_input::state::{ActionState, Device, evaluate};

const PLAY: ContextId = ContextId::new("play");
const MOVE: ActionId = ActionId::new("move");
const JUMP: ActionId = ActionId::new("jump");
const FIRE: ActionId = ActionId::new("fire");
const TURN: ActionId = ActionId::new("turn");
const LEAN: ActionId = ActionId::new("lean");
const INTERACT: ActionId = ActionId::new("interact");
const BLINK: ActionId = ActionId::new("blink");
const TAP: ControlId = ControlId::new("tap");

fn key(code: &'static str) -> Binding {
    Binding::Key(KeyCode::of(code))
}

fn game() -> ActionMap {
    let map = ActionMap::new().context(
        Context::new(PLAY, 0)
            .axis2(MOVE, &[Binding::WASD, Binding::Stick(Stick::Left)])
            .button(JUMP, &[key("Space"), Binding::Pad(PadButton::South)])
            .button(FIRE, &[key("Mouse1"), Binding::Pad(PadButton::RightTrigger)])
            .axis1(TURN, &[Binding::Keys2 { negative: KeyCode::of("KeyQ"), positive: KeyCode::of("KeyE") }])
            .axis1(LEAN, &[Binding::PadAxis(PadAxis::RightX, Sign::Negative)])
            .button(
                INTERACT,
                &[Binding::chord(&[ChordInput::Key(KeyCode::of("ShiftLeft")), ChordInput::Key(KeyCode::of("KeyF"))])
                    .expect("a two-key chord")],
            )
            .button(BLINK, &[Binding::Touch(TAP)]),
    );
    map.validate().expect("the game map validates");
    map
}

fn tick(merger: &mut InputMerger, injection: Injection) -> TickInput {
    merger.inject(&injection);
    merger.next_tick()
}

#[test]
fn pad_south_reads_the_family_face_label() {
    let rows = [
        (PadFamily::Xbox, "A"),
        (PadFamily::PlayStation, "Cross"),
        (PadFamily::Nintendo, "B"),
        (PadFamily::Steam, "A"),
        (PadFamily::Generic, "South"),
    ];
    for (family, label) in rows {
        assert_eq!(pad_label(PadButton::South, family), label, "{family:?}");
        let glyph = binding_glyph(&Binding::Pad(PadButton::South), family, &KeyLabels::new());
        assert_eq!(
            glyph,
            Glyph { label: label.to_owned(), shape: GlyphShape::FaceButton, device: Device::Pad(family) }
        );
    }
}

#[test]
fn every_face_button_follows_sdl3_face_styles() {
    // SDL_GetGamepadButtonLabelForFaceStyle: ABXY for Xbox and Steam, Sony shapes, BAYX for Nintendo.
    let faces = [PadButton::South, PadButton::East, PadButton::West, PadButton::North];
    let table = [
        (PadFamily::Xbox, ["A", "B", "X", "Y"]),
        (PadFamily::Steam, ["A", "B", "X", "Y"]),
        (PadFamily::PlayStation, ["Cross", "Circle", "Square", "Triangle"]),
        (PadFamily::Nintendo, ["B", "A", "Y", "X"]),
        (PadFamily::Generic, ["South", "East", "West", "North"]),
    ];
    for (family, labels) in table {
        let got: Vec<&str> = faces.iter().map(|button| pad_label(*button, family)).collect();
        assert_eq!(got, labels, "{family:?}");
    }
    assert_eq!(pad_label(PadButton::LeftShoulder, PadFamily::PlayStation), "L1");
    assert_eq!(pad_label(PadButton::RightTrigger, PadFamily::Xbox), "RT");
    assert_eq!(pad_label(PadButton::LeftTrigger, PadFamily::Nintendo), "ZL");
}

#[test]
fn keys_mouse_and_composites_read_short_labels() {
    let none = KeyLabels::new();
    assert_eq!(key_label(KeyCode::of("KeyW"), &none), "W");
    assert_eq!(key_label(KeyCode::of("Digit7"), &none), "7");
    assert_eq!(key_label(KeyCode::of("Space"), &none), "Space");
    assert_eq!(key_label(KeyCode::of("ShiftLeft"), &none), "Shift");
    assert_eq!(key_label(KeyCode::of("Mouse1"), &none), "LMB");

    let mouse = binding_glyph(&key("Mouse1"), PadFamily::Generic, &none);
    assert_eq!((mouse.label.as_str(), mouse.shape, mouse.device), ("LMB", GlyphShape::Mouse, Device::KeyboardMouse));
    let wasd = binding_glyph(&Binding::WASD, PadFamily::Generic, &none);
    assert_eq!((wasd.label.as_str(), wasd.shape), ("WASD", GlyphShape::Key));
    assert_eq!(binding_glyph(&Binding::ARROWS, PadFamily::Generic, &none).label, "Arrows");
    let turn = binding_glyph(&game().bindings(TURN)[0], PadFamily::Generic, &none);
    assert_eq!(turn.label, "Q/E");
    let chord = binding_glyph(&game().bindings(INTERACT)[0], PadFamily::Generic, &none);
    assert_eq!((chord.label.as_str(), chord.shape), ("Shift+F", GlyphShape::Chord));
    let stick = binding_glyph(&Binding::Stick(Stick::Left), PadFamily::Xbox, &none);
    assert_eq!(
        (stick.label.as_str(), stick.shape, stick.device),
        ("Left Stick", GlyphShape::Stick, Device::Pad(PadFamily::Xbox))
    );
    let half = binding_glyph(&Binding::PadAxis(PadAxis::LeftY, Sign::Negative), PadFamily::Generic, &none);
    assert_eq!(half.label, "Left Stick Up");
    let touch = binding_glyph(&Binding::Touch(TAP), PadFamily::Generic, &none);
    assert_eq!((touch.label.as_str(), touch.shape, touch.device), ("tap", GlyphShape::Touch, Device::Touch));
}

#[test]
fn an_azerty_label_map_shows_z_for_key_w_and_never_changes_the_action_state() {
    let azerty = KeyLabels::from_pairs([("KeyW", "z"), ("KeyA", "q"), ("KeyQ", "a"), ("KeyZ", "w")]);
    assert_eq!(azerty.len(), 4);
    assert_eq!(key_label(KeyCode::of("KeyW"), &azerty), "Z");
    assert_eq!(binding_glyph(&Binding::WASD, PadFamily::Generic, &azerty).label, "ZQSD");

    // The same tick rows evaluate to the same state whatever labels are shown, because labels
    // never reach `evaluate`: glyphs read the map, never write it.
    let map = game();
    let digest = map.digest();
    let run = |labels: &KeyLabels| {
        let mut merger = InputMerger::default();
        let mut state = ActionState::new(&map);
        let mut glyphs = Vec::new();
        let presses = [vec!["KeyW".to_owned()], vec![], vec!["Space".to_owned()], vec![]];
        for down in presses {
            let up = state_keys_up(&down);
            let tick = tick(&mut merger, Injection { down, up, ..Injection::default() });
            evaluate(&map, &mut state, &tick);
            glyphs.push(action_glyph(&map, MOVE, state.device(), labels));
        }
        (state, glyphs)
    };
    let (plain, plain_glyphs) = run(&KeyLabels::new());
    let (shown, shown_glyphs) = run(&azerty);
    assert_eq!(plain, shown, "labels change no action state");
    assert_eq!(map.digest(), digest, "labels change no binding");
    assert_eq!(plain_glyphs[0].label, "WASD");
    assert_eq!(shown_glyphs[0].label, "ZQSD");
}

/// Every key a row does not hold is released, so each row reads as the whole keyboard.
fn state_keys_up(down: &[String]) -> Vec<String> {
    ["KeyW", "Space"].iter().filter(|key| !down.iter().any(|held| held == *key)).map(|key| (*key).to_owned()).collect()
}

#[test]
fn hostile_label_rows_are_dropped_and_the_rest_apply() {
    let long = "x".repeat(KEY_LABEL_BYTES_MAX + 1);
    let labels = KeyLabels::from_pairs([
        ("KeyW", "z"),
        ("keyw", "y"),
        ("w", "y"),
        ("", "y"),
        ("KeyE", ""),
        ("KeyR", long.as_str()),
        ("KeyT", "\u{0}"),
        ("KeyY", "a\nb"),
        ("Key\u{0}", "y"),
        ("KeyU", "\u{202e}x"),
    ]);
    assert_eq!(labels.len(), 1, "only the canonical, short, printable row stays");
    assert_eq!(labels.dropped(), 9);
    assert_eq!(key_label(KeyCode::of("KeyE"), &labels), "E", "a dropped row falls back to the table");

    let many: Vec<(String, String)> = (0..KEY_LABELS_MAX + 40).map(|at| (format!("F{at}"), "x".to_owned())).collect();
    let capped = KeyLabels::from_pairs(many.iter().map(|(code, label)| (code.as_str(), label.as_str())));
    assert!(capped.len() <= KEY_LABELS_MAX);
    assert_eq!(capped.len() + capped.dropped(), KEY_LABELS_MAX + 40);
}

#[test]
fn an_action_glyph_follows_the_device_in_use() {
    let map = game();
    let none = KeyLabels::new();
    assert_eq!(action_glyph(&map, JUMP, Device::KeyboardMouse, &none).label, "Space");
    assert_eq!(action_glyph(&map, JUMP, Device::Pad(PadFamily::PlayStation), &none).label, "Cross");
    assert_eq!(action_glyph(&map, JUMP, Device::Pad(PadFamily::Nintendo), &none).label, "B");
    assert_eq!(action_glyph(&map, FIRE, Device::Pad(PadFamily::Xbox), &none).label, "RT");
    assert_eq!(action_glyph(&map, BLINK, Device::Touch, &none).label, "tap");
    // No binding for the device: the first binding stands in, on its own device.
    let fallback = action_glyph(&map, TURN, Device::Pad(PadFamily::Xbox), &none);
    assert_eq!((fallback.label.as_str(), fallback.device), ("Q/E", Device::KeyboardMouse));
    let unknown = action_glyph(&map, ActionId::new("jmup"), Device::KeyboardMouse, &none);
    assert_eq!((unknown.label.as_str(), unknown.shape), ("Unbound", GlyphShape::Key));

    assert_eq!(hint(&map, JUMP, PadFamily::PlayStation, &none), "Space · Cross");
    assert_eq!(hint(&map, LEAN, PadFamily::Xbox, &none), "Right Stick Left");
    assert_eq!(hint(&map, ActionId::new("jmup"), PadFamily::Xbox, &none), "");
}

#[test]
fn labels_are_letters_and_shapes_never_platform_names() {
    let trademarks = ["xbox", "playstation", "nintendo", "steam", "switch", "sony", "microsoft", "valve"];
    for family in PadFamily::ALL {
        for button in PadButton::ALL {
            let label = pad_label(*button, *family).to_ascii_lowercase();
            assert!(!label.is_empty(), "{family:?} {button:?} has a label");
            assert!(trademarks.iter().all(|name| !label.contains(name)), "{family:?} {button:?} reads {label:?}");
            assert!(label.chars().all(|c| c.is_ascii_graphic() || c == ' '), "{label:?} is plain ASCII");
        }
    }
}

#[test]
fn a_pad_family_on_the_tick_does_not_reach_the_glyph_unless_the_device_names_it() {
    // The family comes from the device tracker (Devices.family), so a glyph built from a state
    // that only saw the keyboard keeps keyboard labels even with a PlayStation pad connected.
    let map = game();
    let mut merger = InputMerger::default();
    let mut state = ActionState::new(&map);
    let pad = PadState { connected: true, ..PadState::default() };
    let tick =
        tick(&mut merger, Injection { pads: vec![(0, pad)], down: vec!["Space".to_owned()], ..Injection::default() });
    evaluate(&map, &mut state, &tick);
    assert_eq!(state.device(), Device::KeyboardMouse);
    assert_eq!(action_glyph(&map, JUMP, state.device(), &KeyLabels::new()).label, "Space");
}
