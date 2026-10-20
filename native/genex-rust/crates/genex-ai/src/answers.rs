//! The studio's answers, read as hostile input: every field is checked for its type and range
//! before anything in the game changes, and an answer outside its shape is a typed failure, never
//! a panic and never a value the game sees. The shapes are main's (`AiBridgeAnswers` in
//! `src/shared/game-ai-bridge.ts`); fields a reader does not know are ignored, so an addition on
//! the studio's side never breaks a game.

use serde_json::Value;

use crate::json::utf16_len;
use crate::wire::{AiDoor, AiErrorCode, AiGrantStatus, AiProvenance, AiSource, GAME_AI_WIRE_VERSION, is_id};

/// The longest `planResetsAt` a grant view keeps, in UTF-16 units (an ISO date is 24).
const MAX_RESETS_AT_CHARS: usize = 64;
/// The most a plan's share of its window can be, in percent.
const MAX_PERCENT: f64 = 100.0;

/// A call's answer, read.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum CallAnswer {
    /// An answer and where it came from.
    Answered { value: Value, source: AiSource, provenance: AiProvenance, cached: bool },
    /// Why there is none, and how long to wait when the code says to.
    Refused { code: AiErrorCode, retry_after_ms: Option<u64> },
}

/// The grant a game may see: no account, no model id, no price list.
#[derive(Clone, Debug, PartialEq)]
pub struct AiGrant {
    /// The grant's id, which every call carries.
    pub id: String,
    /// Where it stands.
    pub status: AiGrantStatus,
    /// The door its answers come through.
    pub door: AiDoor,
    /// Spent through it, in USD micros (one Genex credit is 10 000).
    pub spent_micros: u64,
    /// On a plan: the share of its current window used, 0-100.
    pub plan_used_percent: Option<f64>,
    /// On a plan: when its window resets (ISO).
    pub plan_resets_at: Option<String>,
}

/// A grant asked about or asked for: the view, or why there is none.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct GrantAnswer {
    pub view: Option<AiGrant>,
    pub code: Option<AiErrorCode>,
}

fn version_ok(reply: &Value) -> bool {
    reply.get("v").and_then(Value::as_u64) == Some(u64::from(GAME_AI_WIRE_VERSION))
}

fn member<T>(reply: &Value, key: &str, read: fn(&str) -> Option<T>) -> Option<T> {
    reply.get(key).and_then(Value::as_str).and_then(read)
}

/// A wait in whole milliseconds: a finite number from 0 (rounded up), or none.
fn wait_ms(value: Option<&Value>) -> Option<u64> {
    let ms = value?.as_f64().filter(|ms| ms.is_finite() && *ms >= 0.0)?;
    Some(ms.ceil().min(u64::MAX as f64) as u64)
}

/// A call's answer for the call that carried `ticket` (`AiCallAnswer`). Anything outside the shape
/// (another ticket, an unknown source, no value) is the studio failing the call: `provider`.
pub(crate) fn call_answer(reply: &Value, ticket: &str) -> CallAnswer {
    let broken = CallAnswer::Refused { code: AiErrorCode::Provider, retry_after_ms: None };
    let ours = version_ok(reply) && reply.get("ticket").and_then(Value::as_str) == Some(ticket);
    if !ours {
        return broken;
    }
    match reply.get("ok") {
        Some(Value::Bool(true)) => {
            let source = member(reply, "source", AiSource::from_wire);
            let provenance = member(reply, "provenance", AiProvenance::from_wire);
            let cached = reply.get("cached").and_then(Value::as_bool).unwrap_or(false);
            match (reply.get("value"), source, provenance) {
                (Some(value), Some(source), Some(provenance)) => {
                    CallAnswer::Answered { value: value.clone(), source, provenance, cached }
                }
                _ => broken,
            }
        }
        Some(Value::Bool(false)) => {
            let code = member(reply, "code", AiErrorCode::from_wire).unwrap_or(AiErrorCode::Provider);
            CallAnswer::Refused { code, retry_after_ms: wait_ms(reply.get("retryAfterMs")) }
        }
        _ => broken,
    }
}

/// `hello`'s answer: whether AI runs for this game here. Anything else reads as off.
pub(crate) fn hello_answer(reply: &Value) -> bool {
    version_ok(reply) && reply.get("on") == Some(&Value::Bool(true))
}

/// `doors`' answer: on or off, and on which door. Anything else reads as off.
pub(crate) fn doors_answer(reply: &Value) -> (bool, Option<AiDoor>) {
    let on = reply.get("on") == Some(&Value::Bool(true));
    let door = member(reply, "door", AiDoor::from_wire);
    if on { (true, door) } else { (false, None) }
}

fn optional_percent(value: Option<&Value>) -> Result<Option<f64>, ()> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value.as_f64().filter(|percent| (0.0..=MAX_PERCENT).contains(percent)).map(Some).ok_or(()),
    }
}

fn optional_date(value: Option<&Value>) -> Result<Option<String>, ()> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) if utf16_len(text) <= MAX_RESETS_AT_CHARS => Ok(Some(text.clone())),
        Some(_) => Err(()),
    }
}

/// A grant view, or None when any field is outside its shape (an id no call could carry included).
fn grant_view(view: &Value) -> Option<AiGrant> {
    let id = view.get("id").and_then(Value::as_str).filter(|id| is_id(id))?;
    let status = member(view, "status", AiGrantStatus::from_wire)?;
    let door = member(view, "door", AiDoor::from_wire)?;
    let spent = view.get("spentMicros").and_then(Value::as_f64).filter(|spent| spent.is_finite() && *spent >= 0.0)?;
    let plan_used_percent = optional_percent(view.get("planUsedPercent")).ok()?;
    let plan_resets_at = optional_date(view.get("planResetsAt")).ok()?;
    Some(AiGrant {
        id: id.to_owned(),
        status,
        door,
        spent_micros: spent.ceil() as u64,
        plan_used_percent,
        plan_resets_at,
    })
}

/// A grant asked about or asked for (`AiGrantAnswer`). A view outside its shape is no view.
pub(crate) fn grant_answer(reply: &Value) -> GrantAnswer {
    let view = reply.get("view").filter(|view| !view.is_null()).and_then(grant_view);
    let code = member(reply, "code", AiErrorCode::from_wire);
    GrantAnswer { view, code }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const TICKET: &str = "rstk-00000001-00000001";

    fn ok_answer() -> Value {
        json!({"v": 1, "ok": true, "ticket": TICKET, "value": {"move": "left"}, "source": "tape", "provenance": "replay", "latencyMs": 3, "cached": false})
    }

    #[test]
    fn a_call_answer_outside_its_shape_is_the_studio_failing_the_call() {
        let provider = CallAnswer::Refused { code: AiErrorCode::Provider, retry_after_ms: None };
        let mut rows: Vec<(&str, Value)> = vec![
            ("not an object", json!("ok")),
            ("null", Value::Null),
            ("no version", json!({"ok": true, "ticket": TICKET, "value": 1, "source": "tape", "provenance": "replay"})),
            (
                "another version",
                json!({"v": 2, "ok": true, "ticket": TICKET, "value": 1, "source": "tape", "provenance": "replay"}),
            ),
            (
                "another ticket",
                json!({"v": 1, "ok": true, "ticket": "rstk-00000001-00000002", "value": 1, "source": "tape", "provenance": "replay"}),
            ),
            (
                "ok as text",
                json!({"v": 1, "ok": "true", "ticket": TICKET, "value": 1, "source": "tape", "provenance": "replay"}),
            ),
            ("no value", json!({"v": 1, "ok": true, "ticket": TICKET, "source": "tape", "provenance": "replay"})),
            (
                "unknown source",
                json!({"v": 1, "ok": true, "ticket": TICKET, "value": 1, "source": "openai", "provenance": "replay"}),
            ),
            (
                "unknown provenance",
                json!({"v": 1, "ok": true, "ticket": TICKET, "value": 1, "source": "tape", "provenance": "trusted"}),
            ),
            (
                "source of the wrong type",
                json!({"v": 1, "ok": true, "ticket": TICKET, "value": 1, "source": 3, "provenance": "replay"}),
            ),
        ];
        let mut cased = ok_answer();
        cased["source"] = json!("Tape");
        rows.push(("a source in another case", cased));
        for (why, reply) in rows {
            assert_eq!(call_answer(&reply, TICKET), provider, "{why}");
        }
    }

    #[test]
    fn a_refusal_keeps_its_code_and_a_sane_wait() {
        let refusal = |code: Value, wait: Value| json!({"v": 1, "ok": false, "ticket": TICKET, "code": code, "retryAfterMs": wait});
        let rows: [(Value, CallAnswer); 6] = [
            (
                refusal(json!("waiting_for_plan"), json!(60_000)),
                CallAnswer::Refused { code: AiErrorCode::WaitingForPlan, retry_after_ms: Some(60_000) },
            ),
            (
                refusal(json!("timeout"), Value::Null),
                CallAnswer::Refused { code: AiErrorCode::Timeout, retry_after_ms: None },
            ),
            (
                refusal(json!("grant_rate_limited"), json!(-5)),
                CallAnswer::Refused { code: AiErrorCode::RateLimited, retry_after_ms: None },
            ),
            (
                refusal(json!("grant_rate_limited"), json!(1.2)),
                CallAnswer::Refused { code: AiErrorCode::RateLimited, retry_after_ms: Some(2) },
            ),
            (
                refusal(json!("made_up"), Value::Null),
                CallAnswer::Refused { code: AiErrorCode::Provider, retry_after_ms: None },
            ),
            (
                refusal(json!(7), json!("soon")),
                CallAnswer::Refused { code: AiErrorCode::Provider, retry_after_ms: None },
            ),
        ];
        for (reply, read) in rows {
            assert_eq!(call_answer(&reply, TICKET), read, "{reply}");
        }
        assert!(matches!(
            call_answer(&ok_answer(), TICKET),
            CallAnswer::Answered { source: AiSource::Tape, provenance: AiProvenance::Replay, .. }
        ));
    }

    #[test]
    fn a_grant_view_outside_its_shape_is_no_grant() {
        let view = json!({"id": "grant-0001", "status": "active", "door": "local", "spentMicros": 12.5, "planUsedPercent": null, "planResetsAt": null});
        let read = grant_answer(&json!({"view": view, "code": null}));
        assert_eq!(read.view.as_ref().map(|grant| (grant.id.as_str(), grant.spent_micros)), Some(("grant-0001", 13)));
        let broken: [(&str, Value); 8] = [
            ("an id no call could carry", json!("g 1")),
            ("a short id", json!("g1")),
            ("a status of the wrong type", json!(1)),
            ("negative spend", json!(-1)),
            ("a percent over 100", json!(101)),
            ("a date that is not text", json!(3)),
            ("an unknown door", json!("their-key")),
            ("an unknown status", json!("forever")),
        ];
        let keys = ["id", "id", "status", "spentMicros", "planUsedPercent", "planResetsAt", "door", "status"];
        for ((why, bad), key) in broken.into_iter().zip(keys) {
            let mut view = view.clone();
            view[key] = bad;
            assert_eq!(grant_answer(&json!({"view": view, "code": null})).view, None, "{why}");
        }
        let refused = grant_answer(&json!({"view": null, "code": "consent_required"}));
        assert_eq!(refused, GrantAnswer { view: None, code: Some(AiErrorCode::ConsentRequired) });
    }

    #[test]
    fn hello_and_doors_read_anything_unclear_as_off() {
        assert!(hello_answer(&json!({"v": 1, "on": true})));
        assert!(!hello_answer(&json!({"v": 1, "on": "yes"})));
        assert!(!hello_answer(&json!({"on": true})));
        assert_eq!(doors_answer(&json!({"on": true, "door": "local"})), (true, Some(AiDoor::Local)));
        assert_eq!(doors_answer(&json!({"on": false, "door": "local"})), (false, None));
        assert_eq!(doors_answer(&json!({"on": true, "door": "mystery"})), (true, None));
        assert_eq!(doors_answer(&json!([])), (false, None));
    }
}
