//! The tick's write queue: coalesced states at the publish rate, claims, messages and chat,
//! checked before they leave.
//!
//! `set_me` and `set_object` keep the latest value per id and leave on publish ticks
//! (`tick % (60 / publish_hz) == 0`); `snap_*`, requests, messages and chat leave on their own
//! tick. Numbers are rounded to the configured decimals when they leave, so the published value is
//! the value a journal records for me.

use std::collections::BTreeMap;
use std::io;

use glam::{Quat, Vec3};
use serde_json::{Number, Value};

use crate::frame::NetPose;
use crate::ids::NetTicket;
use crate::vocab::{NET_TICK_HZ, NetError, NetErrorCode, limits};

/// A session step the game asked for, in call order.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum NetSession {
    /// Join the game's shared room.
    Connect,
    /// Search through the `[net].matchmaking` preset.
    Matchmake,
    /// Open a private lobby.
    CreatePrivate,
    /// Join a friend's private lobby by its code.
    JoinPrivate(String),
    /// Leave the queue or the match seat.
    Cancel,
    /// Leave on purpose: no auto-reconnect.
    Leave,
}

/// An object request; its answer arrives as a `Control` event with the ticket.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum NetRequest {
    /// Ask to own an object (a confirmed claim).
    Claim {
        /// The request's ticket.
        ticket: NetTicket,
        /// The object.
        id: String,
        /// The host's seed, reset or adoption form.
        as_host: bool,
    },
    /// Give an owned object up.
    Release {
        /// The request's ticket.
        ticket: NetTicket,
        /// The object.
        id: String,
    },
    /// Remove an owned object.
    Remove {
        /// The request's ticket.
        ticket: NetTicket,
        /// The object.
        id: String,
    },
}

/// A matchmade round's report.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum MatchReport {
    /// I am out.
    Eliminated,
    /// My score changed by this much.
    Score(i64),
    /// I finished.
    Finished,
}

/// A state leaving this tick: the value (already rounded), an optional pose, and whether it is a
/// snap (a discontinuity: teleport, respawn).
#[derive(Clone, Debug, PartialEq)]
pub struct StateWrite {
    /// The state.
    pub state: Value,
    /// The pose, for the posed stream.
    pub pose: Option<NetPose>,
    /// Whether the receiver reseeds instead of gliding.
    pub snap: bool,
}

/// A game message to every other player.
#[derive(Clone, Debug, PartialEq)]
pub struct NetMessage {
    /// The message type (never reserved).
    pub kind: String,
    /// The payload.
    pub payload: Value,
}

/// Everything one tick sends, handed to the backend after the tick.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct NetWrites {
    /// The tick the writes were made in.
    pub tick: u64,
    /// Session steps, in call order.
    pub session: Vec<NetSession>,
    /// My state, on a publish tick or a snap.
    pub me: Option<StateWrite>,
    /// Owned objects' states leaving this tick, in id order.
    pub objects: Vec<(String, StateWrite)>,
    /// Object requests, in call order.
    pub requests: Vec<NetRequest>,
    /// Shared keys set this tick, in call order (host only).
    pub shared: Vec<(String, Value)>,
    /// Messages, in call order.
    pub messages: Vec<NetMessage>,
    /// Inputs for the host, in call order.
    pub host_inputs: Vec<Value>,
    /// Chat lines, in call order.
    pub chat: Vec<String>,
    /// The room's new open flag (host only; the last call wins).
    pub room_open: Option<bool>,
    /// Round reports, in call order.
    pub reports: Vec<MatchReport>,
}

impl NetWrites {
    /// How many writes leave this tick (what the Off backend counts and drops).
    pub fn len(&self) -> usize {
        self.session.len()
            + usize::from(self.me.is_some())
            + self.objects.len()
            + self.requests.len()
            + self.shared.len()
            + self.messages.len()
            + self.host_inputs.len()
            + self.chat.len()
            + usize::from(self.room_open.is_some())
            + self.reports.len()
    }

    /// Whether nothing leaves this tick.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// The queue one tick fills: coalesced states persist until a publish tick, the rest leave at
/// the end of the tick they were made in.
#[derive(Clone, Debug, Default)]
pub struct WriteQueue {
    me: Option<StateWrite>,
    objects: BTreeMap<String, StateWrite>,
    tick: NetWrites,
}

impl WriteQueue {
    /// Coalesce my state: the latest call before a publish tick wins.
    pub fn set_me(&mut self, state: Value, pose: Option<NetPose>) {
        let snap = self.me.as_ref().is_some_and(|pending| pending.snap);
        self.me = Some(StateWrite { state, pose, snap });
    }

    /// My state leaves this tick, replacing anything coalesced.
    pub fn snap_me(&mut self, state: Value, pose: Option<NetPose>) {
        self.me = Some(StateWrite { state, pose, snap: true });
    }

    /// Coalesce an object's state: the latest call before a publish tick wins.
    pub fn set_object(&mut self, id: &str, state: Value) {
        let snap = self.objects.get(id).is_some_and(|pending| pending.snap);
        self.objects.insert(id.to_owned(), StateWrite { state, pose: None, snap });
    }

    /// An object's state leaves this tick, replacing anything coalesced.
    pub fn snap_object(&mut self, id: &str, state: Value) {
        self.objects.insert(id.to_owned(), StateWrite { state, pose: None, snap: true });
    }

    /// Drop an object's coalesced state (it was released or removed).
    pub fn forget_object(&mut self, id: &str) {
        self.objects.remove(id);
    }

    /// The writes that leave at the end of this tick, whatever the publish rate.
    pub fn now(&mut self) -> &mut NetWrites {
        &mut self.tick
    }

    /// Hand the tick's writes over: on a publish tick (`tick % (60 / publish_hz) == 0`) the
    /// coalesced states too, snaps always; every number rounded to `decimals`.
    pub fn flush(&mut self, tick: u64, publish_hz: u32, decimals: u32) -> NetWrites {
        let interval = u64::from((NET_TICK_HZ / publish_hz.max(1)).max(1));
        let publish = tick.is_multiple_of(interval);
        let mut writes = std::mem::take(&mut self.tick);
        writes.tick = tick;
        let me_leaves = self.me.as_ref().is_some_and(|me| publish || me.snap);
        if me_leaves {
            writes.me = self.me.take().map(|me| round_write(me, decimals));
        }
        let leaving: Vec<String> = self.objects.iter().filter(|(_, write)| publish || write.snap).map(|(id, _)| id.clone()).collect();
        for id in leaving {
            if let Some(write) = self.objects.remove(&id) {
                writes.objects.push((id, round_write(write, decimals)));
            }
        }
        writes
    }

    /// Forget everything queued (a reseed).
    pub fn clear(&mut self) {
        *self = WriteQueue::default();
    }
}

fn round_write(write: StateWrite, decimals: u32) -> StateWrite {
    StateWrite { state: round_value(write.state, decimals), pose: write.pose.map(|pose| round_pose(pose, decimals)), snap: write.snap }
}

/// 10^digits for the digits a game may keep, computed by exact multiplication (no `powi`).
fn scale(decimals: u32) -> f64 {
    (0..decimals).fold(1.0, |acc, _| acc * 10.0)
}

fn round_number(number: f64, decimals: u32) -> f64 {
    let factor = scale(decimals);
    (number * factor).round() / factor
}

/// Round every non-integer number in `value` to `decimals` digits (integers stay exact).
pub fn round_value(value: Value, decimals: u32) -> Value {
    match value {
        Value::Number(number) if number.is_f64() => {
            let rounded = round_number(number.as_f64().unwrap_or(0.0), decimals);
            Number::from_f64(rounded).map_or(Value::Null, Value::Number)
        }
        Value::Array(items) => Value::Array(items.into_iter().map(|item| round_value(item, decimals)).collect()),
        Value::Object(members) => Value::Object(members.into_iter().map(|(key, item)| (key, round_value(item, decimals))).collect()),
        other => other,
    }
}

fn round_pose(pose: NetPose, decimals: u32) -> NetPose {
    let r = |x: f32| round_number(f64::from(x), decimals) as f32;
    NetPose {
        position: Vec3::new(r(pose.position.x), r(pose.position.y), r(pose.position.z)),
        rotation: Quat::from_xyzw(r(pose.rotation.x), r(pose.rotation.y), r(pose.rotation.z), r(pose.rotation.w)),
    }
}

/// Counts the bytes a value serializes to without keeping them.
struct ByteCount(usize);

impl io::Write for ByteCount {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0 += buf.len();
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// The bytes `value` serializes to as JSON.
pub fn json_len(value: &Value) -> usize {
    let mut count = ByteCount(0);
    // Writing a `Value` to a sink that never fails cannot fail.
    let _ = serde_json::to_writer(&mut count, value);
    count.0
}

/// Depth and node count of a value, stopping as soon as either cap is passed.
fn within_shape(value: &Value, depth: usize, nodes: &mut usize) -> bool {
    *nodes += 1;
    if depth > limits::MAX_JSON_DEPTH || *nodes > limits::MAX_JSON_NODES {
        return false;
    }
    match value {
        Value::Array(items) => items.iter().all(|item| within_shape(item, depth + 1, nodes)),
        Value::Object(members) => members.values().all(|item| within_shape(item, depth + 1, nodes)),
        _ => true,
    }
}

/// A JSON payload the relay accepts: within its depth and node caps and `max_bytes` long.
pub fn check_payload(value: &Value, max_bytes: usize, what: &str) -> Result<(), NetError> {
    let mut nodes = 0;
    if !within_shape(value, 1, &mut nodes) {
        let detail = format!("{what} nests deeper than {} or holds more than {} nodes", limits::MAX_JSON_DEPTH, limits::MAX_JSON_NODES);
        return Err(NetError::new(NetErrorCode::StateInvalid, detail));
    }
    let bytes = json_len(value);
    if bytes > max_bytes {
        return Err(NetError::new(NetErrorCode::MessageTooLarge, format!("{what} is {bytes} bytes; the cap is {max_bytes}")));
    }
    Ok(())
}

/// A state the relay accepts: a JSON object (a NaN or infinity cannot be held by a `Value`: it
/// already reads `null`), within the shape caps and `max_bytes`, with a finite pose.
pub fn check_state(state: &Value, pose: Option<&NetPose>, max_bytes: usize) -> Result<(), NetError> {
    if !state.is_object() {
        return Err(NetError::new(NetErrorCode::StateInvalid, "a state must be a JSON object"));
    }
    if pose.is_some_and(|pose| !pose.is_finite()) {
        return Err(NetError::new(NetErrorCode::StateInvalid, "a pose holds a non-finite number"));
    }
    check_payload(state, max_bytes, "the state")
}
