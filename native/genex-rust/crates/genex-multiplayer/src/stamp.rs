//! Sender-clock stamping of player state (§6.1) and the local monotonic clock it uses.

use serde_json::{Map, Value};
use std::fmt;

use crate::protocol::{limits, SEND_TIME_KEY};

/// Milliseconds on this process's monotonic clock, starting at 1 so a stamp is never exactly 0
/// (an object stamp of 0 is reserved, §7.3). Every message this crate sends uses this clock.
#[cfg(not(target_arch = "wasm32"))]
pub fn local_now_ms() -> f64 {
    use std::sync::OnceLock;
    use std::time::Instant;
    static ORIGIN: OnceLock<Instant> = OnceLock::new();
    let origin = *ORIGIN.get_or_init(Instant::now);
    origin.elapsed().as_secs_f64() * 1000.0 + 1.0 + f64::from_bits(SKEW_BITS.load(std::sync::atomic::Ordering::Relaxed))
}

#[cfg(not(target_arch = "wasm32"))]
static SKEW_BITS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// TEST SEAM (the conformance driver's `skew`): offset this process's clock origin by `ms`, as a
/// machine with a different `performance.now()` origin would have. Set it before connecting; it
/// shifts every stamp and timer of the process. Never use it in a game.
#[cfg(not(target_arch = "wasm32"))]
#[doc(hidden)]
pub fn set_clock_skew_for_tests(ms: f64) {
    SKEW_BITS.store(ms.to_bits(), std::sync::atomic::Ordering::Relaxed);
}

/// On wasm32 the TypeScript SDK owns every stamp; this is only a fallback for callers.
#[cfg(target_arch = "wasm32")]
pub fn local_now_ms() -> f64 {
    js_now_ms()
}

#[cfg(all(target_arch = "wasm32", feature = "web"))]
fn js_now_ms() -> f64 {
    js_sys::Date::now()
}

#[cfg(all(target_arch = "wasm32", not(feature = "web")))]
fn js_now_ms() -> f64 {
    1.0
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StateError {
    /// Player state must be a JSON object.
    NotAnObject,
    /// The stamped JSON text is over the relay's 16 KiB limit.
    TooLarge(usize),
}

impl fmt::Display for StateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StateError::NotAnObject => write!(f, "player state must be a JSON object"),
            StateError::TooLarge(n) => {
                write!(
                    f,
                    "player state is {n} bytes once stamped, over the {} limit",
                    limits::MAX_STATE_BYTES
                )
            }
        }
    }
}

impl std::error::Error for StateError {}

/// A stamped state ready for the wire, plus whether the game tried to use the reserved key.
#[derive(Debug, Clone, PartialEq)]
pub struct Stamped {
    pub text: String,
    /// The game's own state carried a `__t` key, which the stamp replaced (SHOULD warn, §6.1).
    pub overwrote_reserved_key: bool,
}

/// Stamp `state` with the sender clock `t` (ms) under `__t` and serialize it as JSON text (§6.1).
pub fn stamp_state(state: &Value, t: f64) -> Result<Stamped, StateError> {
    let Value::Object(map) = state else {
        return Err(StateError::NotAnObject);
    };
    let mut map = map.clone();
    let overwrote_reserved_key = map.contains_key(SEND_TIME_KEY);
    map.insert(SEND_TIME_KEY.to_string(), Value::from(t));
    let text = Value::Object(map).to_string();
    if text.len() > limits::MAX_STATE_BYTES {
        return Err(StateError::TooLarge(text.len()));
    }
    Ok(Stamped {
        text,
        overwrote_reserved_key,
    })
}

/// Parse a stored `PlayerState.data` text into the game-visible state (with `__t` removed) and
/// the sender's stamp. Unparseable or non-object text reads as `{}`; a missing or non-finite
/// `__t` reads as no stamp (not an interpolation sample, §10).
pub fn parse_player_data(text: &str) -> (Map<String, Value>, Option<f64>) {
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(mut map)) => {
            let t = map
                .remove(SEND_TIME_KEY)
                .and_then(|v| v.as_f64())
                .filter(|t| t.is_finite());
            (map, t)
        }
        _ => (Map::new(), None),
    }
}

/// Parse a JSON-text field (`ObjectState.d`, a `shared` value). Empty or invalid text reads as `None`.
pub fn parse_json_text(text: &str) -> Option<Value> {
    if text.is_empty() {
        return None;
    }
    serde_json::from_str(text).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn stamps_and_strips_the_send_clock() {
        let s = stamp_state(&json!({"x": 1.5, "name": "ada"}), 1234.5).unwrap();
        assert!(!s.overwrote_reserved_key);
        let (state, t) = parse_player_data(&s.text);
        assert_eq!(t, Some(1234.5));
        assert_eq!(Value::Object(state), json!({"x": 1.5, "name": "ada"}));
    }

    #[test]
    fn reserved_key_is_replaced_and_reported() {
        let s = stamp_state(&json!({"__t": "mine"}), 9.0).unwrap();
        assert!(s.overwrote_reserved_key);
        assert_eq!(parse_player_data(&s.text).1, Some(9.0));
    }

    #[test]
    fn refuses_non_objects_and_oversized_state() {
        assert_eq!(stamp_state(&json!([1, 2]), 1.0), Err(StateError::NotAnObject));
        let big = json!({"blob": "x".repeat(17_000)});
        assert!(matches!(stamp_state(&big, 1.0), Err(StateError::TooLarge(_))));
    }

    #[test]
    fn unstamped_or_garbage_data() {
        assert_eq!(parse_player_data("{}"), (Map::new(), None));
        assert_eq!(parse_player_data("not json"), (Map::new(), None));
        let (state, t) = parse_player_data(r#"{"a":1,"__t":"x"}"#);
        assert_eq!(t, None);
        assert_eq!(Value::Object(state), json!({"a": 1}));
    }

    #[test]
    fn local_clock_never_reads_zero() {
        let a = local_now_ms();
        let b = local_now_ms();
        assert!(a >= 1.0 && b >= a);
    }
}
