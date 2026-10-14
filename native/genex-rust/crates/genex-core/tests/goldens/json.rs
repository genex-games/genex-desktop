//! `json.h`: the reader (syntax, depth, escapes, numbers) and the writer (number form, quoting).

use crate::support::{from_hex, golden, hex, real, same, text};
use genex_core::json::{self, ParseError, Value, format_number, quote};

fn error_name(parsed: &Result<Value, ParseError>) -> &'static str {
    match parsed {
        Ok(_) => "none",
        Err(ParseError::Syntax) => "syntax",
        Err(ParseError::TooDeep) => "too-deep",
    }
}

#[test]
fn parses_and_dumps_as_the_cpp() {
    let cases = golden!("json");
    for case in cases["parse"].items() {
        let parsed = json::parse(&text(&case["text"]));
        let context = format!("parse {:?}", case["text"]);
        same(&Value::from(error_name(&parsed)), &case["error"], &context);
        let dump = parsed.unwrap_or_default().dump();
        same(&hex(&dump), &case["dump"], &context);
    }
    for case in cases["depthLimits"].items() {
        let parsed = json::parse_with_depth(&text(&case["text"]), case["maxDepth"].as_f64() as usize);
        same(&Value::from(error_name(&parsed)), &case["error"], &format!("depth {:?}", case["text"]));
    }
}

#[test]
fn numbers_take_the_same_shortest_form() {
    let cases = golden!("json");
    assert!(cases["numbers"].items().len() > 900, "the generated numbers are in the golden");
    for case in cases["numbers"].items() {
        let value = real(&case["bits"]);
        same(&Value::from(format_number(value)), &case["text"], &format!("number {value:e} ({:?})", case["bits"]));
    }
}

#[test]
fn quoting_escapes_the_same_bytes() {
    let cases = golden!("json");
    for case in cases["quote"].items() {
        let bytes = from_hex(case["hex"].as_str());
        same(&hex(&quote(&bytes)), &case["quoted"], &format!("quote {}", case["hex"].as_str()));
    }
}

#[test]
fn building_replaces_in_place_and_reads_like_the_cpp() {
    let mut value = Value::object();
    value.set("b", Value::from(1));
    value.set("a", Value::from("x"));
    value.set("b", Value::from(2));
    let mut list = Value::array();
    list.push(Value::from(true));
    list.push(Value::Null);
    value.set("list", list);
    assert_eq!(value.dump(), br#"{"b":2,"a":"x","list":[true,null]}"#);
    assert_eq!(Value::from("text").as_f64_or(9.0), 9.0);
    assert_eq!(Value::from(3).as_str(), "");
    assert!(Value::from(3)["missing"].is_null());
    let mut null = Value::Null;
    null.set("k", Value::from(1));
    assert_eq!(null.dump(), br#"{"k":1}"#);
}

#[test]
fn serde_values_convert_member_for_member() {
    let serde: serde_json::Value = serde_json::json!({"b": 1, "a": [0.1, true, null, "é"], "n": {"x": -2.5}});
    let value = Value::from(&serde);
    assert_eq!(value.dump(), "{\"b\":1,\"a\":[0.1,true,null,\"é\"],\"n\":{\"x\":-2.5}}".as_bytes());
}
