//! Contract v2's `touch` input (`PreviewTouchAction`: start, move and end with a uint32 id, in
//! world pixels) through `parse_injection` and the merger: each finger's phase on the tick after
//! its actions arrived, a start and end before one tick as a tap, hostile actions counted in
//! `ignored` and changing nothing, and `seed` (`clear`) forgetting every finger.

use genex_core::input::{InputMerger, MAX_TOUCHES, TouchPhase, TouchPoint, parse_injection};
use genex_core::json::{self, Value};

fn arg(text: &str) -> Value {
    json::parse(text.as_bytes()).expect("JSON")
}

fn touch(phase: &str, id: u32, x: f64, y: f64) -> String {
    format!(r#"{{"type":"touch","phase":"{phase}","id":{id},"x":{x},"y":{y}}}"#)
}

fn actions(list: &[String]) -> Value {
    arg(&format!(r#"{{"actions":[{}]}}"#, list.join(",")))
}

fn point(id: u32, x: f32, y: f32, phase: TouchPhase) -> TouchPoint {
    TouchPoint { id, x, y, phase }
}

#[test]
fn a_finger_begins_is_held_moves_and_ends_one_tick_after_its_actions() {
    let mut merger = InputMerger::default();
    merger.inject(&parse_injection(&actions(&[touch("start", 7, 10.0, 20.0)])));
    assert_eq!(merger.next_tick().touches, [point(7, 10.0, 20.0, TouchPhase::Began)]);
    assert_eq!(merger.next_tick().touches, [point(7, 10.0, 20.0, TouchPhase::Held)]);
    merger.inject(&parse_injection(&actions(&[touch("move", 7, 30.5, 40.0)])));
    assert_eq!(merger.next_tick().touches, [point(7, 30.5, 40.0, TouchPhase::Held)]);
    merger.inject(&parse_injection(&actions(&[touch("end", 7, 31.0, 41.0)])));
    assert_eq!(merger.next_tick().touches, [point(7, 31.0, 41.0, TouchPhase::Ended)]);
    assert_eq!(merger.next_tick().touches, []);
}

#[test]
fn a_start_and_end_before_one_tick_is_a_tap_and_fingers_are_listed_by_id() {
    let mut merger = InputMerger::default();
    let both = [touch("start", 2, 5.0, 5.0), touch("start", 1, 1.0, 1.0), touch("end", 2, 6.0, 6.0)];
    merger.inject(&parse_injection(&actions(&both)));
    assert_eq!(
        merger.next_tick().touches,
        [point(1, 1.0, 1.0, TouchPhase::Began), point(2, 6.0, 6.0, TouchPhase::Tapped)]
    );
}

#[test]
fn hostile_touches_are_ignored_and_change_nothing() {
    let hostile = [
        r#"{"type":"touch","phase":"hover","id":1,"x":1,"y":1}"#,
        r#"{"type":"touch","phase":"start","id":-1,"x":1,"y":1}"#,
        r#"{"type":"touch","phase":"start","id":1.5,"x":1,"y":1}"#,
        r#"{"type":"touch","phase":"start","id":4294967296,"x":1,"y":1}"#,
        r#"{"type":"touch","phase":"start","id":"1","x":1,"y":1}"#,
        r#"{"type":"touch","phase":"start","id":1,"x":"1","y":1}"#,
        r#"{"type":"touch","phase":"start","id":1,"y":1}"#,
        r#"{"type":"touch","id":1,"x":1,"y":1}"#,
    ];
    let list: Vec<String> = hostile.iter().map(|s| (*s).to_owned()).collect();
    let injection = parse_injection(&actions(&list));
    assert_eq!(injection.ignored, hostile.len() as u32);
    assert!(injection.touches.is_empty());
    let mut merger = InputMerger::default();
    merger.inject(&injection);
    assert_eq!(merger.next_tick().touches, []);
    // A move or end for a finger that never started changes nothing.
    merger.inject(&parse_injection(&actions(&[touch("move", 3, 1.0, 1.0), touch("end", 4, 1.0, 1.0)])));
    assert_eq!(merger.next_tick().touches, []);
}

#[test]
fn at_most_max_touches_fingers_are_down_and_seed_forgets_them() {
    let mut merger = InputMerger::default();
    let many: Vec<String> = (0..MAX_TOUCHES as u32 + 3).map(|id| touch("start", id, 1.0, 1.0)).collect();
    merger.inject(&parse_injection(&actions(&many)));
    assert_eq!(merger.next_tick().touches.len(), MAX_TOUCHES);
    merger.clear();
    assert_eq!(merger.next_tick().touches, []);
}
