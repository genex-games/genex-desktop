//! What JavaScript hands the binding, read into the core's types. Commands, queries and the world
//! description arrive in their JSON forms and are read by the core itself (§7.3, §13, §4); this
//! module reads only the inputs the core has no JSON form for: a network state (§9.2), the keys of
//! a bulk import (§19.1, whose data arrives as a flat f32 array), a `bodies()` filter (§9.1) and the
//! static world (§6.5), which arrives as flat f64 arrays so every value reaches §17.7's float32
//! check bit for bit.
//!
//! A malformed input gives `BadCommand` (a value of the wrong JSON type, a wrong array length, a
//! missing or unknown field), as the command JSON form does.

use genex_physics::{NetBodyState, PhysicsError, PhysicsFailure, StaticWorld};
use serde_json::{Map, Value};

/// The fields of a network state, all required.
const NET_FIELDS: [&str; 5] = ["p", "q", "v", "w", "sleeping"];

fn bad<T>(detail: impl Into<String>) -> Result<T, PhysicsFailure> {
    Err(PhysicsFailure::new(PhysicsError::BadCommand, detail))
}

/// `text` as JSON; text the wrapper did not write (never expected) gives `BadCommand`.
pub(crate) fn json(text: &str) -> Result<Value, PhysicsFailure> {
    serde_json::from_str(text).or_else(|_| bad("the input is not JSON"))
}

fn numbers<const N: usize>(map: &Map<String, Value>, name: &str) -> Result<[f64; N], PhysicsFailure> {
    let Some(items) = map.get(name).and_then(Value::as_array) else { return bad(format!("{name} is not an array")) };
    let values: Option<Vec<f64>> = items.iter().map(Value::as_f64).collect();
    let Some(values) = values else { return bad(format!("{name} holds a value that is not a number")) };
    <[f64; N]>::try_from(values).or_else(|_| bad(format!("{name} needs {N} numbers")))
}

/// A network state `{ p, q, v, w, sleeping }` (§9.2).
pub(crate) fn net_state(text: &str) -> Result<NetBodyState, PhysicsFailure> {
    let value = json(text)?;
    let Some(map) = value.as_object() else { return bad("a network state is an object") };
    if let Some(name) = map.keys().find(|name| !NET_FIELDS.contains(&name.as_str())) {
        return bad(format!("unknown field {name}"));
    }
    let Some(sleeping) = map.get("sleeping").and_then(Value::as_bool) else { return bad("sleeping is not a boolean") };
    Ok(NetBodyState { p: numbers(map, "p")?, q: numbers(map, "q")?, v: numbers(map, "v")?, w: numbers(map, "w")?, sleeping })
}

/// The keys of an `importStates` (§19.1): a JSON array of strings.
pub(crate) fn keys(text: &str) -> Result<Vec<String>, PhysicsFailure> {
    serde_json::from_str(text).or_else(|_| bad("keys is not an array of strings"))
}

/// The `kinds` of a `bodies()` filter: a JSON array of strings.
pub(crate) fn kinds(text: &str) -> Result<Vec<String>, PhysicsFailure> {
    serde_json::from_str(text).or_else(|_| bad("kinds is not an array of strings"))
}

/// Rows of `lengths[i]` values each, cut from `values`; the lengths must add up to its length.
fn rows(lengths: &[u32], values: &[f64]) -> Result<Vec<Vec<f64>>, PhysicsFailure> {
    let mut rest = values;
    let mut out = Vec::with_capacity(lengths.len());
    for &length in lengths {
        let Some((row, tail)) = rest.split_at_checked(length as usize) else { return bad("static rows run past their values") };
        out.push(row.to_vec());
        rest = tail;
    }
    if !rest.is_empty() {
        return bad("static values left over after their rows");
    }
    Ok(out)
}

/// The static world from its flat form: each list's row lengths, then all its values in order.
pub(crate) fn static_world(box_lengths: &[u32], boxes: &[f64], ramp_lengths: &[u32], ramps: &[f64]) -> Result<StaticWorld, PhysicsFailure> {
    Ok(StaticWorld { boxes: rows(box_lengths, boxes)?, ramps: rows(ramp_lengths, ramps)? })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code<T: std::fmt::Debug>(result: Result<T, PhysicsFailure>) -> PhysicsError {
        result.expect_err("refused").code
    }

    #[test]
    fn a_network_state_reads_every_field_and_refuses_any_other_shape() {
        let good = r#"{"p":[1,2,3],"q":[0,0,0,1],"v":[0,0,0],"w":[0,0,0],"sleeping":true}"#;
        let state = net_state(good).expect("reads");
        assert_eq!((state.p, state.q, state.sleeping), ([1.0, 2.0, 3.0], [0.0, 0.0, 0.0, 1.0], true));
        let hostile = [
            "[]",
            "null",
            r#"{"p":[1,2],"q":[0,0,0,1],"v":[0,0,0],"w":[0,0,0],"sleeping":true}"#,
            r#"{"p":[1,2,"3"],"q":[0,0,0,1],"v":[0,0,0],"w":[0,0,0],"sleeping":true}"#,
            r#"{"p":[1,2,3],"q":[0,0,0,1],"v":[0,0,0],"w":[0,0,0],"sleeping":1}"#,
            r#"{"p":[1,2,3],"q":[0,0,0,1],"v":[0,0,0],"w":[0,0,0]}"#,
            r#"{"p":[1,2,3],"q":[0,0,0,1],"v":[0,0,0],"w":[0,0,0],"sleeping":true,"x":1}"#,
            "not json",
        ];
        for text in hostile {
            assert_eq!(code(net_state(text)), PhysicsError::BadCommand, "{text}");
        }
    }

    #[test]
    fn static_rows_are_cut_by_their_lengths_and_a_mismatch_is_refused() {
        let world = static_world(&[6, 6], &[0.0; 12], &[9], &[1.0; 9]).expect("cut");
        assert_eq!((world.boxes.len(), world.ramps.len(), world.ramps[0].len()), (2, 1, 9));
        let short = static_world(&[6], &[0.0; 5], &[], &[]);
        let long = static_world(&[6], &[0.0; 7], &[], &[]);
        assert_eq!((code(short), code(long)), (PhysicsError::BadCommand, PhysicsError::BadCommand));
        let ragged = static_world(&[5, 7], &[0.0; 12], &[], &[]).expect("lengths are the core's to judge");
        assert_eq!(ragged.boxes.iter().map(Vec::len).collect::<Vec<_>>(), vec![5, 7]);
    }

    #[test]
    fn import_keys_are_an_array_of_strings() {
        assert_eq!(keys(r#"["a","b"]"#).expect("reads"), vec!["a".to_string(), "b".to_string()]);
        for text in ["[1]", r#""a""#, "null", "{}", "not json"] {
            assert_eq!(code(keys(text)), PhysicsError::BadCommand, "{text}");
        }
    }

    #[test]
    fn kinds_are_an_array_of_strings() {
        assert_eq!(kinds(r#"["crate","prop"]"#).expect("reads"), vec!["crate".to_string(), "prop".to_string()]);
        assert_eq!(code(kinds("[1]")), PhysicsError::BadCommand);
        assert_eq!(code(kinds(r#""crate""#)), PhysicsError::BadCommand);
    }
}
