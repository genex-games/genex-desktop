//! `input.h`: key names, committed text, triggers, the `input` argument parser and the per-tick
//! merge of real and injected input.

use crate::support::{
    float_bits, golden, hex, real, real32, same, string_list, strings, text, text_str, vec2, vec2_of,
};
use genex_core::input::{
    FrameSample, Injection, InputMerger, MAX_PADS, PAD_BUTTONS, PadState, PadStates, Pads, TickInput, Vec2,
    append_text, canonical_key, parse_injection, trigger_value,
};
use genex_core::json::{self, Value};

/// The pads of a tick as the driver writes them: state, then the buttons down and on an edge.
pub fn pads_of(pads: &Pads) -> Value {
    let mut out = Value::array();
    for (p, state) in pads.states().iter().enumerate() {
        let index = p as i32;
        let mut pad = Value::object();
        pad.set("connected", Value::from(state.connected));
        let (mut down, mut pressed, mut released) = (Value::array(), Value::array(), Value::array());
        for b in 0..PAD_BUTTONS as i32 {
            if pads.down(index, b) {
                down.push(Value::from(b));
            }
            if pads.pressed(index, b) {
                pressed.push(Value::from(b));
            }
            if pads.released(index, b) {
                released.push(Value::from(b));
            }
        }
        pad.set("buttons", floats(&state.buttons));
        pad.set("axes", floats(&state.axes));
        pad.set("down", down);
        pad.set("pressed", pressed);
        pad.set("released", released);
        out.push(pad);
    }
    out
}

fn floats(values: &[f32]) -> Value {
    let mut out = Value::array();
    for value in values {
        out.push(float_bits(*value));
    }
    out
}

/// Queries with hostile pad and button indices, as the driver makes them.
fn hostile_pad_queries(pads: &Pads) -> Value {
    let mut out = Value::array();
    for pad in [-1, 0, 3, 4, 99] {
        for index in [-1, 0, 16, 17, 99] {
            out.push(Value::from(pads.down(pad, index)));
            out.push(Value::from(pads.pressed(pad, index)));
            out.push(Value::from(pads.released(pad, index)));
            out.push(float_bits(pads.value(pad, index)));
            out.push(float_bits(pads.axis(pad, index)));
        }
        out.push(Value::from(pads.connected(pad)));
    }
    out.push(Value::from(pads.count()));
    out
}

/// A tick as the driver writes it, asking `queries` of its keys.
pub fn tick_of(tick: &TickInput, queries: &[String]) -> Value {
    let mut out = Value::object();
    out.set("held", strings(tick.keys.held()));
    let (mut down, mut pressed, mut released) = (Value::array(), Value::array(), Value::array());
    for key in queries {
        if tick.keys.down(key) {
            down.push(Value::from(key.as_str()));
        }
        if tick.keys.pressed(key) {
            pressed.push(Value::from(key.as_str()));
        }
        if tick.keys.released(key) {
            released.push(Value::from(key.as_str()));
        }
    }
    out.set("down", down);
    out.set("pressed", pressed);
    out.set("released", released);
    out.set("look", vec2(tick.look));
    out.set("wheel", vec2(tick.wheel));
    out.set("pointer", vec2(tick.pointer));
    out.set("pointerLock", Value::from(tick.pointer_lock));
    out.set("text", hex(tick.text.as_bytes()));
    out.set("pads", pads_of(&tick.pads));
    out.set("hostilePads", hostile_pad_queries(&tick.pads));
    out
}

fn injection_of(injection: &Injection) -> Value {
    let mut out = Value::object();
    out.set("down", strings(&injection.down));
    out.set("up", strings(&injection.up));
    out.set("tap", strings(&injection.tap));
    out.set("look", vec2(injection.look));
    out.set("wheel", vec2(injection.wheel));
    out.set("hasPointer", Value::from(injection.pointer.is_some()));
    out.set("pointer", vec2(injection.pointer.unwrap_or_default()));
    let mut pads = Value::array();
    for (index, state) in &injection.pads {
        let mut pad = Value::object();
        pad.set("index", Value::from(*index as i32));
        pad.set("connected", Value::from(state.connected));
        pad.set("buttons", floats(&state.buttons));
        pad.set("axes", floats(&state.axes));
        pads.push(pad);
    }
    out.set("pads", pads);
    out.set("text", hex(&injection.text));
    out.set("ignored", Value::from(injection.ignored));
    out
}

/// A scenario step's injection: parsed from `inject`, then raw fields set directly, as code may.
pub fn injection_from(step: &Value) -> Injection {
    let mut injection = parse_injection(&step["inject"]);
    if let Some(raw) = step.get("rawText") {
        injection.text = text(raw);
    }
    if let Some(raw) = step.get("rawDown") {
        injection.down = string_list(raw);
    }
    if let Some(raw) = step.get("rawUp") {
        injection.up = string_list(raw);
    }
    if let Some(raw) = step.get("rawTap") {
        injection.tap = string_list(raw);
    }
    injection
}

fn pad_states_of(list: &Value) -> PadStates {
    let mut pads: PadStates = Default::default();
    for pad in list.items() {
        let state = &mut pads[pad["index"].as_f64() as usize];
        *state = PadState { connected: pad["connected"].as_bool_or(true), ..PadState::default() };
        for (slot, value) in state.buttons.iter_mut().zip(pad["buttons"].items()) {
            *slot = real32(value);
        }
        for (slot, value) in state.axes.iter_mut().zip(pad["axes"].items()) {
            *slot = real32(value);
        }
    }
    pads
}

/// A scenario's real frame sample.
pub fn sample_of(frame: &Value) -> FrameSample {
    FrameSample {
        held: string_list(&frame["held"]),
        pressed: string_list(&frame["pressed"]),
        released: string_list(&frame["released"]),
        look: vec2_of(&frame["look"], Vec2::default()),
        wheel: vec2_of(&frame["wheel"], Vec2::default()),
        pointer: vec2_of(&frame["pointer"], Vec2 { x: 0.5, y: 0.5 }),
        pointer_lock: frame["pointerLock"].as_bool(),
        pads: pad_states_of(&frame["pads"]),
        text: text(&frame["text"]),
    }
}

#[test]
fn key_names_canonicalize_the_same() {
    let cases = golden!("input");
    for case in cases["canonical"].items() {
        let key = canonical_key(text(&case["name"]));
        same(&Value::from(key), &case["key"], &format!("canonical {:?}", case["name"]));
    }
}

#[test]
fn committed_text_keeps_the_same_bytes() {
    let cases = golden!("input");
    let mut ran = 0;
    for case in cases["appendText"].items() {
        // `into` is a Rust String, always UTF-8: the C++ row that starts from an invalid byte has
        // no Rust spelling.
        let Ok(mut into) = String::from_utf8(text(&case["into"])) else { continue };
        append_text(&mut into, &text(&case["text"]));
        same(&hex(into.as_bytes()), &case["result"], &format!("appendText {:?}", case["text"]));
        ran += 1;
    }
    assert_eq!(ran + 1, cases["appendText"].items().len(), "exactly one row starts from invalid UTF-8");
}

#[test]
fn triggers_read_the_same_value() {
    let cases = golden!("input");
    for case in cases["triggers"].items() {
        let value = trigger_value(
            case["down"].as_bool(),
            case["axisCount"].as_f64() as i32,
            case["axis"].as_f64() as i32,
            real(&case["reading"]) as f32,
        );
        same(&float_bits(value), &case["value"], &format!("trigger {case:?}"));
    }
}

#[test]
fn input_arguments_parse_the_same() {
    let cases = golden!("input");
    for case in cases["parse"].items() {
        let arg = json::parse(text_str(&case["arg"]).as_bytes()).unwrap_or_default();
        same(&injection_of(&parse_injection(&arg)), &case["injection"], &format!("parse {:?}", case["arg"]));
    }
}

#[test]
fn merged_ticks_match_step_for_step() {
    let cases = golden!("input");
    for scene in cases["merges"].items() {
        let mut merger = InputMerger::default();
        let queries = string_list(&scene["keys"]);
        let mut results = Value::array();
        for step in scene["steps"].items() {
            let result = if step.get("inject").is_some() {
                merger.inject(&injection_from(step));
                Value::Null
            } else if let Some(frame) = step.get("sample") {
                merger.sample(&sample_of(frame));
                Value::Null
            } else if step.get("next").is_some() {
                tick_of(&merger.next_tick(), &queries)
            } else if step.get("held").is_some() {
                strings(&merger.held())
            } else {
                merger.clear();
                Value::Null
            };
            results.push(result);
        }
        for (i, (got, want)) in results.items().iter().zip(scene["results"].items()).enumerate() {
            same(got, want, &format!("merge {:?} step {i}: {:?}", scene["name"], scene["steps"].items()[i]));
        }
        assert_eq!(results.items().len(), scene["results"].items().len());
    }
}

#[test]
fn a_pad_index_past_the_table_reads_disconnected() {
    let pads = Pads::default();
    assert_eq!(MAX_PADS, 4);
    assert!(!pads.connected(4) && !pads.down(-1, 0) && pads.axis(0, 99) == 0.0);
}
