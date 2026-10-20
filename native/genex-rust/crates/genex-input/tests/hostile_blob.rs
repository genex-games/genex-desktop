//! Hostile bindings files (IN-2): every row is refused whole, the map keeps its bindings and
//! settings bit for bit, and nothing else happens (the crate does no file I/O).

use genex_input::binding::{Binding, KeyCode, PadButton, Stick};
use genex_input::blob::BINDINGS_BLOB_BYTES_MAX;
use genex_input::error::InputErrorCode;
use genex_input::id::{ActionId, ContextId};
use genex_input::map::{ActionMap, Context};

const PLAY: ContextId = ContextId::new("play");
const MOVE: ActionId = ActionId::new("move");
const JUMP: ActionId = ActionId::new("jump");
const FIRE: ActionId = ActionId::new("fire");

fn game() -> ActionMap {
    let map = ActionMap::new().context(
        Context::new(PLAY, 0)
            .axis2(MOVE, &[Binding::WASD, Binding::Stick(Stick::Left)])
            .button(JUMP, &[Binding::Key(KeyCode::of("Space")), Binding::Pad(PadButton::South)])
            .button(FIRE, &[Binding::Key(KeyCode::of("KeyF"))]),
    );
    map.validate().expect("valid");
    map
}

/// A well-formed file around `bindings` and `access` members.
fn file(bindings: &str, access: &str) -> Vec<u8> {
    format!(r#"{{"format":"genex-input/1","bindings":{{{bindings}}},"access":{{{access}}}}}"#).into_bytes()
}

fn nested(depth: usize) -> Vec<u8> {
    let open = "[".repeat(depth);
    let close = "]".repeat(depth);
    format!(r#"{{"format":"genex-input/1","bindings":{{}},"access":{{}},"x":{open}{close}}}"#).into_bytes()
}

fn many_actions(count: usize) -> Vec<u8> {
    let rows: Vec<String> = (0..count).map(|at| format!(r#""a{at}":[]"#)).collect();
    file(&rows.join(","), "")
}

fn rows() -> Vec<(&'static str, Vec<u8>, InputErrorCode)> {
    use InputErrorCode::{AccessInvalid, BindingConflict, BindingMismatch, BindingReserved, BindingsInvalid};
    let mut over = file(r#""jump":["key:KeyJ"]"#, "");
    over.truncate(over.len() - 1);
    over.extend(std::iter::repeat_n(b' ', BINDINGS_BLOB_BYTES_MAX));
    over.push(b'}');
    vec![
        ("over 64 KiB", over, BindingsInvalid),
        ("not JSON", b"{\"format\":\"genex-input/1\",".to_vec(), BindingsInvalid),
        ("not an object", b"[1,2,3]".to_vec(), BindingsInvalid),
        (
            "format genex-input/2",
            br#"{"format":"genex-input/2","bindings":{"jump":["key:KeyJ"]}}"#.to_vec(),
            BindingsInvalid,
        ),
        ("no format", br#"{"bindings":{"jump":["key:KeyJ"]}}"#.to_vec(), BindingsInvalid),
        ("unknown member", br#"{"format":"genex-input/1","run":"rm -rf"}"#.to_vec(), BindingsInvalid),
        ("nesting over 8", nested(8), BindingsInvalid),
        ("10 000 actions", many_actions(10_000), BindingsInvalid),
        ("65 actions", many_actions(65), BindingsInvalid),
        ("name with /", file(r#""ju/mp":["key:KeyJ"]"#, ""), BindingsInvalid),
        ("name with NUL", file(r#""ju\u0000mp":["key:KeyJ"]"#, ""), BindingsInvalid),
        ("name of 200 bytes", file(&format!(r#""{}":["key:KeyJ"]"#, "a".repeat(200)), ""), BindingsInvalid),
        ("unknown binding kind", file(r#""jump":["laser:eyes"]"#, ""), BindingsInvalid),
        ("binding not a string", file(r#""jump":[7]"#, ""), BindingsInvalid),
        ("key not canonical", file(r#""jump":["key:j"]"#, ""), BindingsInvalid),
        ("nine bindings", file(&format!(r#""jump":[{}]"#, nine_keys()), ""), BindingsInvalid),
        ("kind mismatch", file(r#""jump":["stick:left"]"#, ""), BindingMismatch),
        ("conflict", file(r#""jump":["key:KeyF"]"#, ""), BindingConflict),
        ("reserved binding", file(r#""jump":["key:Escape"]"#, ""), BindingReserved),
        ("NaN", file("", r#""triggerPress":NaN"#), BindingsInvalid),
        ("dead zone a string", file("", r#""stickDeadZone":["0.1",0.1]"#), BindingsInvalid),
        ("negative dead zone", file("", r#""stickDeadZone":[-0.1,0.15]"#), AccessInvalid),
        ("dead zone 2.0", file("", r#""stickDeadZone":[0.15,2.0]"#), AccessInvalid),
        ("release at press", file("", r#""triggerPress":0.6,"triggerRelease":0.6"#), AccessInvalid),
        ("release above press", file("", r#""triggerPress":0.5,"triggerRelease":0.7"#), AccessInvalid),
        ("slow press 1000", file("", r#""slowPressPercent":1000"#), AccessInvalid),
        ("slow press fractional", file("", r#""slowPressPercent":150.5"#), BindingsInvalid),
        ("toggle on an axis", file("", r#""holdMode":{"move":"toggle"}"#), AccessInvalid),
        ("unknown hold mode", file("", r#""holdMode":{"jump":"sometimes"}"#), BindingsInvalid),
        ("duplicate keys", file(r#""jump":["key:KeyJ"],"jump":["key:KeyK"]"#, ""), BindingsInvalid),
        ("duplicate top keys", br#"{"format":"genex-input/1","format":"genex-input/1"}"#.to_vec(), BindingsInvalid),
        ("lone surrogate", file(r#""jump":["key:\ud800"]"#, ""), BindingsInvalid),
        (
            "invalid UTF-8",
            b"{\"format\":\"genex-input/1\",\"bindings\":{\"jump\":[\"key:\xff\"]}}".to_vec(),
            BindingsInvalid,
        ),
        ("trailing bytes", [file("", ""), b"{}".to_vec()].concat(), BindingsInvalid),
    ]
}

fn nine_keys() -> String {
    let keys: Vec<String> = (1..=9).map(|digit| format!(r#""key:Digit{digit}""#)).collect();
    keys.join(",")
}

#[test]
fn every_hostile_file_is_refused_whole_and_the_map_keeps_its_defaults() {
    for (name, bytes, code) in rows() {
        let mut map = game();
        map.rebind(JUMP, 0, Binding::Key(KeyCode::of("KeyJ"))).expect("a player rebind first");
        let before = map.clone();
        let digest = map.digest();
        let refused = map.apply_blob(&bytes).expect_err(name);
        assert_eq!(refused.code, code, "{name}: {}", refused.detail);
        assert_eq!(map, before, "{name}: the map is unchanged");
        assert_eq!(map.digest(), digest, "{name}: so is its digest");
    }
}

#[test]
fn a_file_at_the_nesting_limit_and_the_size_limit_still_applies() {
    let mut map = game();
    map.apply_blob(&nested(5)).expect_err("an unknown member is still refused");
    let mut padded = file(r#""jump":["key:KeyJ"]"#, "");
    let room = BINDINGS_BLOB_BYTES_MAX - padded.len();
    padded.truncate(padded.len() - 1);
    padded.extend(std::iter::repeat_n(b' ', room));
    padded.push(b'}');
    assert_eq!(padded.len(), BINDINGS_BLOB_BYTES_MAX);
    map.apply_blob(&padded).expect("exactly 64 KiB applies");
    assert_eq!(map.bindings(JUMP), &[Binding::Key(KeyCode::of("KeyJ"))]);
    let deepest = file("", r#""holdMode":{}"#);
    map.apply_blob(&deepest).expect("the file's own nesting applies");
    assert_eq!(map.bindings(JUMP), game().bindings(JUMP), "a file without a jump row resets jump to the game's");
}

#[test]
fn the_parser_itself_refuses_depth_repeats_and_lone_surrogates() {
    let deep = file(&format!(r#""jump":{}"key:KeyJ"{}"#, "[".repeat(7), "]".repeat(7)), "");
    let rows: [(&str, Vec<u8>, &str); 5] = [
        ("depth", deep, "nested deeper than 8"),
        ("repeat", file(r#""jump":["key:KeyJ"],"jump":["key:KeyK"]"#, ""), "a key is repeated"),
        ("leading surrogate", file(r#""jump":["key:\ud800"]"#, ""), "hex escape"),
        ("trailing surrogate", file(r#""jump":["key:\udc00x"]"#, ""), "surrogate"),
        ("size", vec![b' '; BINDINGS_BLOB_BYTES_MAX + 1], "at most 65536"),
    ];
    for (name, bytes, reason) in rows {
        let refused = game().apply_blob(&bytes).expect_err(name);
        assert!(refused.detail.contains(reason), "{name}: {}", refused.detail);
    }
    let shallow = file(&format!(r#""jump":{}"key:KeyJ"{}"#, "[".repeat(6), "]".repeat(6)), "");
    let refused = game().apply_blob(&shallow).expect_err("depth 8 parses, then the row shape is refused");
    assert!(refused.detail.contains("not a string"), "{}", refused.detail);
}
