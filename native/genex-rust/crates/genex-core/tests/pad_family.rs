//! The gamepad family: the SDL `controller_list.h` VID/PID table, the web `Gamepad.id` parser, the
//! optional `family` on the input wire and on `PadState`, and how a family survives the merge of
//! real and injected pads. The family is display-only: it names the face labels, never a reading.

use genex_core::input::{FrameSample, InputMerger, PadButton, PadState, PadStates, parse_injection};
use genex_core::json::{self, Value};
use genex_core::pad_family::{PadFamily, family_from_web_id, pad_family};

fn arg(text: &str) -> Value {
    json::parse(text.as_bytes()).expect("JSON")
}

fn real_pad(family: PadFamily, south: f32) -> PadStates {
    let mut pads = PadStates::default();
    pads[0] = PadState { connected: true, family, ..PadState::default() };
    pads[0].buttons[PadButton::A as usize] = south;
    pads
}

/// Characterization (written before the field existed): a connected injected pad over a real pad
/// merges buttons at the larger value and axes at the larger magnitude, slot by slot.
#[test]
fn an_injected_pad_merges_over_a_real_pad_by_value_and_magnitude() {
    let mut merger = InputMerger::default();
    let mut real = real_pad(PadFamily::Generic, 0.25);
    real[0].axes[0] = -0.75;
    real[0].axes[1] = 0.1;
    merger.sample(&FrameSample { pads: real, ..FrameSample::default() });
    merger.inject(&parse_injection(&arg(
        r#"{"actions":[{"type":"gamepad","index":0,"buttons":[0.5,1],"axes":[0.5,-0.5]}]}"#,
    )));
    let tick = merger.next_tick();
    let pad = tick.pads.states()[0];
    assert!(pad.connected);
    assert_eq!(pad.buttons[0], 0.5);
    assert_eq!(pad.buttons[1], 1.0);
    assert_eq!(pad.axes[0], -0.75);
    assert_eq!(pad.axes[1], -0.5);
    assert!(!tick.pads.connected(1));
}

/// New behaviour: an injected family reaches the tick.
#[test]
fn an_injected_family_reaches_the_tick() {
    let mut merger = InputMerger::default();
    merger.inject(&parse_injection(&arg(
        r#"{"actions":[{"type":"gamepad","index":0,"buttons":[],"axes":[],"family":"playstation"}]}"#,
    )));
    let tick = merger.next_tick();
    assert_eq!(tick.pads.family(0), PadFamily::PlayStation);
    assert_eq!(tick.pads.family(1), PadFamily::Generic, "an empty slot is generic");
    assert_eq!(tick.pads.family(-1), PadFamily::Generic);
    assert_eq!(tick.pads.family(9), PadFamily::Generic);
}

#[test]
fn the_pads_list_of_the_input_verb_carries_a_family_too() {
    let injection = parse_injection(&arg(r#"{"pads":[{"index":2,"family":"nintendo"}]}"#));
    assert_eq!(injection.pads.len(), 1);
    assert_eq!(injection.pads[0].0, 2);
    assert_eq!(injection.pads[0].1.family, PadFamily::Nintendo);
}

#[test]
fn every_wire_family_round_trips_and_an_unknown_one_is_generic() {
    for &family in PadFamily::ALL {
        assert_eq!(PadFamily::from_wire(family.as_str()), Some(family));
        let text = format!(r#"{{"pads":[{{"index":0,"family":"{}"}}]}}"#, family.as_str());
        assert_eq!(parse_injection(&arg(&text)).pads[0].1.family, family);
    }
    let unknown = [r#""PS5""#, r#""""#, "7", "null", r#"{"a":1}"#, r#""PlayStation""#, r#""xbox ""#];
    for family in unknown {
        let text = format!(r#"{{"pads":[{{"index":0,"family":{family}}}]}}"#);
        let injection = parse_injection(&arg(&text));
        assert_eq!(injection.pads[0].1.family, PadFamily::Generic, "{family}");
        assert!(injection.pads[0].1.connected, "an unknown family still connects the pad: {family}");
    }
    assert_eq!(PadFamily::from_wire("PlayStation"), None, "spellings are exact");
    let long = format!(r#"{{"pads":[{{"index":0,"family":"{}"}}]}}"#, "x".repeat(1024));
    assert_eq!(parse_injection(&arg(&long)).pads[0].1.family, PadFamily::Generic);
}

#[test]
fn a_named_injected_family_wins_over_the_real_pad_and_a_generic_one_does_not() {
    let mut merger = InputMerger::default();
    merger.sample(&FrameSample { pads: real_pad(PadFamily::Xbox, 0.0), ..FrameSample::default() });
    assert_eq!(merger.next_tick().pads.family(0), PadFamily::Xbox, "the real pad's family");
    merger.inject(&parse_injection(&arg(r#"{"pads":[{"index":0,"buttons":[1]}]}"#)));
    assert_eq!(merger.next_tick().pads.family(0), PadFamily::Xbox, "a generic injection keeps the real family");
    merger.inject(&parse_injection(&arg(r#"{"pads":[{"index":0,"family":"steam"}]}"#)));
    assert_eq!(merger.next_tick().pads.family(0), PadFamily::Steam);
    merger.inject(&parse_injection(&arg(r#"{"pads":[{"index":0,"connected":false,"family":"steam"}]}"#)));
    assert_eq!(merger.next_tick().pads.family(0), PadFamily::Xbox, "a disconnected injection names nothing");
}

#[test]
fn a_family_never_changes_a_reading() {
    let readings = |family: &str| {
        let mut merger = InputMerger::default();
        let text = format!(
            r#"{{"actions":[{{"type":"gamepad","index":0,"buttons":[1,0,0.75],"axes":[0.5],"family":"{family}"}}]}}"#
        );
        merger.inject(&parse_injection(&arg(&text)));
        let tick = merger.next_tick();
        let pad = tick.pads.states()[0];
        (pad.connected, pad.buttons, pad.axes, tick.pads.pressed(0, PadButton::A))
    };
    let generic = readings("generic");
    for &family in PadFamily::ALL {
        assert_eq!(readings(family.as_str()), generic, "{}", family.as_str());
    }
}

#[test]
fn known_vendor_and_product_ids_name_their_family() {
    let known = [
        (0x054c, 0x0ce6, PadFamily::PlayStation), // DualSense
        (0x054c, 0x05c4, PadFamily::PlayStation), // DualShock 4
        (0x054c, 0x0268, PadFamily::PlayStation), // DualShock 3
        (0x054c, 0x0df2, PadFamily::PlayStation), // DualSense Edge
        (0x045e, 0x0b13, PadFamily::Xbox),        // Xbox Series
        (0x045e, 0x028e, PadFamily::Xbox),        // Xbox 360
        (0x045e, 0x0b00, PadFamily::Xbox),        // Elite Series 2
        (0x057e, 0x2009, PadFamily::Nintendo),    // Switch Pro
        (0x057e, 0x2006, PadFamily::Nintendo),    // Joy-Con left
        (0x057e, 0x2069, PadFamily::Nintendo),    // Switch 2 Pro
        (0x28de, 0x1205, PadFamily::Steam),       // Steam Deck
        (0x28de, 0x1102, PadFamily::Steam),       // Steam Controller
        (0x1234, 0x5678, PadFamily::Generic),
        (0x2dc8, 0x6000, PadFamily::Generic), // 8BitDo keeps SDL's own type: no family
        (0x28de, 0x11ff, PadFamily::Generic), // SDL's unknown non-Steam controller
        (0x0000, 0x0000, PadFamily::Generic),
        (0xffff, 0xffff, PadFamily::Generic),
    ];
    for (vid, pid, family) in known {
        assert_eq!(pad_family(vid, pid), family, "{vid:04x}:{pid:04x}");
    }
}

#[test]
fn a_pair_listed_twice_takes_its_first_row_as_sdl_does() {
    // 0f0d:00ed is listed as an XInput PS4 pad before its Xbox One minidump row.
    assert_eq!(pad_family(0x0f0d, 0x00ed), PadFamily::PlayStation);
    // 1430:070b is listed as an Xbox 360 pad before its Xbox One row: Xbox either way.
    assert_eq!(pad_family(0x1430, 0x070b), PadFamily::Xbox);
}

#[test]
fn web_gamepad_ids_of_each_browser_name_their_family() {
    let ids = [
        ("DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)", PadFamily::PlayStation),
        ("Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)", PadFamily::Xbox),
        ("Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)", PadFamily::Nintendo),
        ("Steam Deck (Vendor: 28de Product: 1205)", PadFamily::Steam),
        ("Unknown Gamepad (Vendor: 1234 Product: 5678)", PadFamily::Generic),
        ("054c-0ce6-DualSense Wireless Controller", PadFamily::PlayStation),
        ("45e-b13-Xbox Wireless Controller", PadFamily::Xbox),
        ("57e-2009-Pro Controller", PadFamily::Nintendo),
        ("Xbox 360 Controller (XInput STANDARD GAMEPAD)", PadFamily::Xbox),
        // Safari names no VID/PID.
        ("DualSense Wireless Controller Extended Gamepad", PadFamily::Generic),
    ];
    for (id, family) in ids {
        assert_eq!(family_from_web_id(id), family, "{id}");
    }
}

#[test]
fn hostile_web_ids_are_generic_and_never_panic() {
    let huge = format!("Vendor: 054c Product: 0ce6 {}", "x".repeat(10 * 1024));
    let hostile = [
        String::new(),
        huge,
        "Vendor: zz4c Product: 0ce6".to_owned(),
        "Vendor: 054c".to_owned(),
        "Vendor: 054c Product:".to_owned(),
        "Vendor: 054c Product: ".to_owned(),
        "Vendor: 054c Product: 0c".to_owned(),
        "Vendor: 054c\0 Product: 0ce6".to_owned(),
        "054c\0-0ce6-DualSense".to_owned(),
        "054c-".to_owned(),
        "-0ce6-x".to_owned(),
        "054c0-0ce6-x".to_owned(),
        "g54c-0ce6-x".to_owned(),
        "Vendor: 0054c Product: 0ce6".to_owned(),
        "Vendor: \u{0660}54c Product: 0ce6".to_owned(),
        "Vendor: ".to_owned(),
        "\u{1F3AE}\u{1F3AE}\u{1F3AE}-".to_owned(),
        "-".to_owned(),
        "Product: 0ce6 Vendor: 054c".to_owned(),
    ];
    for id in &hostile {
        assert_eq!(family_from_web_id(id), PadFamily::Generic, "{:?}", id.get(..id.len().min(40)));
    }
}

#[test]
fn pad_state_stays_copy_and_generic_by_default() {
    fn copy<T: Copy>(value: T) -> T {
        value
    }
    let pad = copy(PadState::default());
    assert_eq!(pad.family, PadFamily::Generic);
    assert_eq!(PadFamily::default(), PadFamily::Generic);
}

/// IN-5 web intake: the web shell sends each pad's `Gamepad.id` in the `input` verb's `pads`; a
/// pad without a `family` takes the family its id names.
#[test]
fn a_web_pad_id_names_the_family_when_no_family_is_given() {
    let rows = [
        (r#"{"index":0,"id":"DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)"}"#, PadFamily::PlayStation),
        (r#"{"index":0,"id":"45e-b13-Xbox Wireless Controller"}"#, PadFamily::Xbox),
        (r#"{"index":0,"id":"Xbox 360 Controller (XInput STANDARD GAMEPAD)"}"#, PadFamily::Xbox),
        (r#"{"index":0,"id":"DualSense Wireless Controller Extended Gamepad"}"#, PadFamily::Generic),
        (r#"{"index":0,"id":""}"#, PadFamily::Generic),
        (r#"{"index":0,"id":7}"#, PadFamily::Generic),
        (r#"{"index":0,"id":"\u0000054c-0ce6-x"}"#, PadFamily::Generic),
        // An explicit family wins over the id, and an unknown family stays generic.
        (r#"{"index":0,"family":"nintendo","id":"054c-0ce6-DualSense"}"#, PadFamily::Nintendo),
        (r#"{"index":0,"family":"PS5","id":"054c-0ce6-DualSense"}"#, PadFamily::Generic),
    ];
    for (pad, family) in rows {
        let injection = parse_injection(&arg(&format!(r#"{{"pads":[{pad}]}}"#)));
        assert_eq!(injection.pads[0].1.family, family, "{pad}");
    }
    let action = r#"{"actions":[{"type":"gamepad","index":1,"buttons":[],"axes":[],"id":"57e-2009-Pro Controller"}]}"#;
    let mut merger = InputMerger::default();
    merger.inject(&parse_injection(&arg(action)));
    assert_eq!(merger.next_tick().pads.family(1), PadFamily::Nintendo);
}
