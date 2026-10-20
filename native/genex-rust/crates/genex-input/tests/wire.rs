//! The multiplayer action wire (IN-13): `ActionState::to_wire` packs one tick of a player's actions
//! for genex-multiplayer's `send_to_host`, and the host reads it back with
//! `RemoteActions::from_wire` against the same map. The crate does no networking.

use genex_core::input::{PadState, PadStates, TickInput, Vec2};
use genex_input::binding::{Binding, KeyCode, PadButton, Stick};
use genex_input::error::InputErrorCode;
use genex_input::id::{ActionId, ContextId};
use genex_input::map::{ACTIONS_MAX, ActionMap, Context};
use genex_input::state::{ActionState, evaluate};
use genex_input::wire::{RemoteActions, WIRE_BYTES_MAX, WIRE_TICK_MAX, shape_digest, wire_len};
use serde_json::{Value, json};

/// Seven pass-through contexts of eight actions each, plus the built-in `ui` context's eight:
/// exactly `ACTIONS_MAX`, with sticks, keys, the wheel and mouse look all read every tick.
fn full_map() -> ActionMap {
    let contexts = ["c0", "c1", "c2", "c3", "c4", "c5", "c6"];
    let mut map = ActionMap::new();
    for (at, name) in contexts.into_iter().enumerate() {
        let id = |suffix: &str| ActionId::new(Box::leak(format!("{name}_{suffix}").into_boxed_str()));
        let context = Context::new(ContextId::new(name), at as i8)
            .axis2(id("move"), &[Binding::Stick(Stick::Left)])
            .axis2(id("aim"), &[Binding::Stick(Stick::Right)])
            .button(id("jump"), &[Binding::Pad(PadButton::South)])
            .axis2(id("look"), &[Binding::Look])
            .axis1(id("turn"), &[Binding::Keys2 { negative: KeyCode::of("KeyQ"), positive: KeyCode::of("KeyE") }])
            .button(id("use"), &[Binding::Key(KeyCode::of("Space"))])
            .axis2(id("walk"), &[Binding::WASD])
            .axis1(id("zoom"), &[Binding::Wheel])
            .pass_through();
        map = map.context(context);
    }
    map.validate().expect("the 64-action map validates");
    assert_eq!(map.actions().count(), ACTIONS_MAX);
    map
}

fn keys(held: &[&str], pressed: &[&str]) -> genex_core::input::Keys {
    let owned = |names: &[&str]| names.iter().map(|name| (*name).to_owned()).collect::<Vec<_>>();
    let mut keys = genex_core::input::Keys::default();
    keys.assign(owned(held), owned(pressed), Vec::new());
    keys
}

fn busy_tick() -> TickInput {
    let mut pad = PadState { connected: true, ..PadState::default() };
    pad.axes = [0.3, -0.8, -0.55, 0.25];
    pad.buttons[PadButton::South.index()] = 1.0;
    let mut now: PadStates = Default::default();
    now[0] = pad;
    let mut tick = TickInput {
        keys: keys(&["KeyW", "KeyD", "KeyE", "Space"], &["Space"]),
        look: Vec2 { x: 12.5, y: -3.25 },
        wheel: Vec2 { x: 0.0, y: 3.0 },
        ..TickInput::default()
    };
    tick.pads.assign(now, Default::default());
    tick
}

fn evaluated(map: &ActionMap, ticks: &[TickInput]) -> ActionState {
    let mut state = ActionState::new(map);
    for tick in ticks {
        evaluate(map, &mut state, tick);
    }
    state
}

#[test]
fn sixty_four_actions_encode_under_wire_bytes_max_and_round_trip_with_i16_axes() {
    // new behaviour
    let map = full_map();
    let state = evaluated(&map, &[TickInput::default(), busy_tick()]);
    let wire = state.to_wire(&map);
    let bytes = serde_json::to_vec(&wire).expect("serializes");
    println!("a 64-action wire after a busy tick: {} bytes", bytes.len());
    assert!(bytes.len() <= WIRE_BYTES_MAX, "{} bytes", bytes.len());
    const { assert!(WIRE_BYTES_MAX <= 16 * 1024, "the MP contract allows 16 KiB") };
    assert_eq!(wire_len(&wire), Some(bytes.len()));

    let remote = RemoteActions::from_wire(&map, &wire).expect("the host reads it");
    assert_eq!(remote.tick(), state.ticks());
    for (action, _) in map.actions() {
        assert_eq!(remote.down(action), state.down(action), "{action:?} down");
        assert_eq!(remote.pressed(action), state.pressed(action), "{action:?} pressed");
        assert_eq!(remote.released(action), state.released(action), "{action:?} released");
        assert_eq!(remote.fired(action), state.fired(action), "{action:?} fired");
        let [x, y] = state.axis2(action);
        let [rx, ry] = remote.axis2(action);
        for (sent, got) in [(x, rx), (y, ry)] {
            let step = if sent.abs() > 1.0 { 1.0 / 32.0 } else { 0.5 / 32767.0 };
            assert!((sent - got).abs() <= step + f32::EPSILON, "{action:?}: {sent} came back {got}");
        }
    }
    let move0 = ActionId::new("c0_move");
    assert!(remote.down(move0));
    assert!(remote.pressed(ActionId::new("c3_use")), "Space went down on this tick");
    assert_eq!(remote.axis2(ActionId::new("c6_look")), [12.5, -3.25], "pixel look survives in sixteenths");
    assert_eq!(remote.value(ActionId::new("c2_zoom")), 3.0);

    // Decoding and encoding again gives the same bytes: the quantized form is a fixed point.
    let again = ActionState::from_wire(&map, &wire).expect("the same wire");
    assert_eq!(again, remote);
    assert_eq!(serde_json::to_vec(&state.to_wire(&map)).expect("serializes"), bytes, "deterministic");
}

#[test]
fn the_largest_wire_a_full_map_can_send_still_fits() {
    // The most components a valid map has: the eight `ui` buttons plus 56 2D axes.
    let mut widest = Context::new(ContextId::new("wide"), 0);
    for at in 0..ACTIONS_MAX - 8 {
        widest = widest.axis2(ActionId::new(Box::leak(format!("axis_{at}").into_boxed_str())), &[]);
    }
    let map = ActionMap::new().context(widest);
    map.validate().expect("56 unbound 2D axes validate");
    let components: usize = map.actions().map(|(_, kind)| if kind.as_str() == "axis2" { 2 } else { 1 }).sum();
    let mut axes = vec![json!(-32768); components];
    // Button and unit slots are Q15, so their widest value is -32767.
    axes[0] = json!(-32767);
    let wire = json!({
        "v": 1,
        "t": WIRE_TICK_MAX,
        "s": format!("{:016x}", shape_digest(&map)),
        "d": "ffffffffffffffff",
        "p": "ffffffffffffffff",
        "r": "0000000000000000",
        "f": "ffffffffffffffff",
        "w": format!("{:032x}", (1u128 << components) - 2),
        "a": axes,
    });
    let bytes = serde_json::to_vec(&wire).expect("serializes");
    println!("the widest legal 64-action wire: {} bytes", bytes.len());
    assert!(bytes.len() <= WIRE_BYTES_MAX, "{} bytes over {WIRE_BYTES_MAX}", bytes.len());
    assert_eq!(components, 2 * ACTIONS_MAX - 8);
    let remote = RemoteActions::from_wire(&map, &wire).expect("the widest legal wire is read");
    assert_eq!(remote.tick(), WIRE_TICK_MAX);
}

/// A legal wire for `full_map` after `busy_tick`, as a mutable object.
fn legal(map: &ActionMap) -> serde_json::Map<String, Value> {
    let state = evaluated(map, &[TickInput::default(), busy_tick()]);
    match state.to_wire(map) {
        Value::Object(object) => object,
        other => panic!("a wire is an object, got {other}"),
    }
}

fn with(map: &ActionMap, member: &str, value: Value) -> Value {
    let mut object = legal(map);
    object.insert(member.to_owned(), value);
    Value::Object(object)
}

#[test]
fn hostile_wires_are_refused_input_wire_invalid_with_no_state_change() {
    let map = full_map();
    let small = ActionMap::new().context(
        Context::new(ContextId::new("play"), 0).button(ActionId::new("jump"), &[Binding::Key(KeyCode::of("Space"))]),
    );
    small.validate().expect("valid");
    let components = legal(&map)["a"].as_array().map_or(0, Vec::len);
    let without = |member: &str| {
        let mut object = legal(&map);
        object.remove(member);
        Value::Object(object)
    };
    let rows: Vec<(&str, Value)> = vec![
        ("oversize: 10 000 axes", with(&map, "a", json!(vec![0; 10_000]))),
        ("oversize: a 20 KiB member", with(&map, "x", json!("y".repeat(20 * 1024)))),
        ("not an object", json!([1, 2, 3])),
        ("null", Value::Null),
        ("missing member", without("d")),
        ("unknown member", with(&map, "z", json!(0))),
        ("format 2", with(&map, "v", json!(2))),
        ("negative tick", with(&map, "t", json!(-1))),
        ("fractional tick", with(&map, "t", json!(1.5))),
        ("tick past 2^53", with(&map, "t", json!(WIRE_TICK_MAX + 1))),
        ("tick as a string", with(&map, "t", json!("12"))),
        ("NaN as text", with(&map, "a", json!(vec!["NaN"; components]))),
        ("fractional axis", with(&map, "a", json!(vec![0.5; components]))),
        ("huge axis", with(&map, "a", json!(vec![1e40; components]))),
        ("axis past i16", with(&map, "a", json!(vec![40_000; components]))),
        ("Q15 slot at -32768", with(&map, "a", json!(vec![-32768; components]))),
        ("null axis", with(&map, "a", json!(vec![Value::Null; components]))),
        ("one axis short", with(&map, "a", json!(vec![0; components - 1]))),
        ("over ACTIONS_MAX components", with(&map, "a", json!(vec![0; 2 * ACTIONS_MAX + 1]))),
        ("over ACTIONS_MAX bits", with(&map, "d", json!("1ffffffffffffffff"))),
        ("short mask", with(&map, "d", json!("ff"))),
        ("upper-case hex", with(&map, "d", json!("FFFFFFFFFFFFFFFF"))),
        ("non-hex mask", with(&map, "f", json!("zzzzzzzzzzzzzzzz"))),
        ("mask as a number", with(&map, "d", json!(255))),
        ("pressed but not down", with(&map, "d", json!("0000000000000000"))),
        ("released while down", with(&map, "r", json!("ffffffffffffffff"))),
        ("wide bit past the components", with(&map, "w", json!(format!("{:032x}", 1u128 << 127)))),
        ("another map's shape", with(&map, "s", json!(format!("{:016x}", shape_digest(&small))))),
        ("shape not hex", with(&map, "s", json!("not-a-digest-123"))),
    ];
    let accepted = legal(&map);
    let mut remote = RemoteActions::from_wire(&map, &Value::Object(accepted)).expect("legal");
    let before = remote.clone();
    for (name, wire) in rows {
        let refused = RemoteActions::from_wire(&map, &wire).expect_err(name);
        assert_eq!(refused.code, InputErrorCode::WireInvalid, "{name}: {refused}");
        let refused = remote.accept(&map, &wire).expect_err(name);
        assert_eq!(refused.code, InputErrorCode::WireInvalid, "{name}");
        assert_eq!(remote, before, "{name}: a refusal changes nothing");
    }

    // A small map's bits past its own actions name ids it does not declare.
    let small_wire = evaluated(&small, &[TickInput::default()]).to_wire(&small);
    let mut object = match small_wire {
        Value::Object(object) => object,
        other => panic!("an object, got {other}"),
    };
    object.insert("d".to_owned(), json!("8000000000000000"));
    let refused = RemoteActions::from_wire(&small, &Value::Object(object)).expect_err("unknown ids");
    assert_eq!(refused.code, InputErrorCode::WireInvalid);
}

#[test]
fn raw_bytes_are_capped_before_they_are_parsed() {
    let map = full_map();
    let good = serde_json::to_vec(&Value::Object(legal(&map))).expect("serializes");
    RemoteActions::from_wire_bytes(&map, &good).expect("legal bytes");
    let mut trailing = good.clone();
    trailing.extend_from_slice(b" {}");
    let mut padded = good.clone();
    padded.splice(1..1, std::iter::repeat_n(b' ', WIRE_BYTES_MAX));
    let rows: Vec<(&str, Vec<u8>)> = vec![
        ("over the cap", padded),
        ("trailing bytes", trailing),
        ("invalid UTF-8", vec![b'{', 0xff, b'}']),
        ("empty", Vec::new()),
        ("deep nesting", "[".repeat(1000).into_bytes()),
    ];
    for (name, bytes) in rows {
        let refused = RemoteActions::from_wire_bytes(&map, &bytes).expect_err(name);
        assert_eq!(refused.code, InputErrorCode::WireInvalid, "{name}");
    }
}

#[test]
fn a_state_built_for_another_map_encodes_nothing_down_and_records_no_unknown_reads() {
    let map = full_map();
    let other = ActionMap::new();
    let state = evaluated(&other, &[busy_tick()]);
    let wire = state.to_wire(&map);
    assert!(state.unknown_reads().is_empty(), "encoding is not a game read");
    let remote = RemoteActions::from_wire(&map, &wire).expect("a legal wire for map");
    assert!(map.actions().all(|(action, _)| !remote.down(action)));

    let fresh = RemoteActions::new(&map);
    assert_eq!(fresh.tick(), 0);
    assert!(!fresh.down(ActionId::new("c0_jump")));
    assert!(!fresh.down(ActionId::new("nope")), "an unknown id reads false");
    assert_eq!(fresh.axis2(ActionId::new("nope")), [0.0, 0.0]);
}
