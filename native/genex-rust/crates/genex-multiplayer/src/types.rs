//! Engine-neutral types shared by the native and web sessions. Their serde shape (camelCase,
//! events tagged by `type`) is also the JSON the web bridge returns (BRIDGE.md).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;

use crate::msgpack::CodecError;
use crate::stamp::StateError;

/// Which room to enter (§3.5).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum RoomTarget {
    /// `joinOrCreate('play')`: the plain relay room. The default.
    #[default]
    Play,
    /// Search through the matchmaking queue, then take the reserved match seat (§9.2).
    Queue,
    /// `create('match')`: a private lobby; its room id is the invite code.
    CreatePrivate,
    /// `joinById(code)`: join a friend's private lobby.
    JoinById(String),
}

/// Session options. The identity (a fresh embed token per join) is passed separately.
#[derive(Debug, Clone)]
pub struct ConnectOptions {
    /// Relay URLs (`ws://` / `wss://`). One is used as is; with several the lowest-latency one is
    /// chosen (native) and kept for the whole session. An invite URL overrides selection: pass it alone.
    pub endpoints: Vec<String>,
    /// The game's slug. Must equal the token's `slug` claim.
    pub game_id: String,
    /// Display-name fallback (the token's verified name wins).
    pub name: Option<String>,
    pub room: RoomTarget,
    /// Rate ceiling for `set_me` / `set_object` (per object): faster calls are coalesced. Call
    /// them from your own fixed 10–20 Hz tick (§6.1); 30 (the default) is the relay's state lane.
    pub publish_hz: f64,
    /// Client timeout for control requests (§7.2), clamped to 60 s. Default 5000.
    pub control_timeout_ms: f64,
    /// Publish the typed pose (§6.6) from `set_pose`. Experimental, off by default.
    pub pose: bool,
    /// Extra join options (ignored by the relay unless it knows them). The relay refuses the
    /// server-owned names (§3.4); `protocol` is always this crate's and cannot be overridden.
    pub options: serde_json::Map<String, Value>,
}

impl ConnectOptions {
    pub fn new(endpoint: impl Into<String>, game_id: impl Into<String>) -> Self {
        ConnectOptions {
            endpoints: vec![endpoint.into()],
            game_id: game_id.into(),
            name: None,
            room: RoomTarget::Play,
            publish_hz: 30.0,
            control_timeout_ms: crate::protocol::CONTROL_TIMEOUT_MS,
            pose: false,
            options: serde_json::Map::new(),
        }
    }

    pub fn name(mut self, name: impl Into<String>) -> Self {
        self.name = Some(name.into());
        self
    }

    pub fn room(mut self, room: RoomTarget) -> Self {
        self.room = room;
        self
    }
}

/// One seated player, as this client sees it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PlayerView {
    /// Session id (changes on every reload; key persistent things by `uid`).
    pub id: String,
    pub name: String,
    /// Stable per-game player id (§3.3). Opaque.
    pub uid: String,
    /// Team index, or -1.
    pub team: i32,
    /// `false` while the seat is held by reconnection grace.
    pub connected: bool,
    pub avatar_url: String,
    /// Game state with `__t` removed: interpolated for remote players, your last local publish for
    /// yourself. A posed player has its pose keys merged over its data.
    pub state: Value,
    /// The latest raw state (for game logic: hit tests, pickups), never smoothed.
    pub state_raw: Value,
    pub epoch: f64,
    pub is_me: bool,
    /// The player publishes the typed pose (§6.6).
    pub posed: bool,
}

/// One shared object (§7).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ObjectView {
    pub id: String,
    /// Owner session id; `None` when unowned.
    pub owner: Option<String>,
    /// +1 on every owner change.
    pub seq: f64,
    /// +1 on every `snap_object` (hard reset).
    pub epoch: f64,
    /// Interpolated state for remote-owned objects, your last publish for objects you own,
    /// `null` before the first publish.
    pub state: Value,
    pub state_raw: Value,
}

/// The answer to a claim / release / destroy (§7.2). `reason` is the relay's string, or
/// `timeout` / `disconnected` for requests the client settled itself.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlResult {
    pub request_id: String,
    /// `claim`, `release` or `remove` (a destroy).
    pub operation: String,
    pub id: String,
    pub accepted: bool,
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub sequence: f64,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<f64>,
}

/// A chat line as the relay stamped it (§12). `at` is relay epoch ms.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatMessage {
    pub id: f64,
    pub from: String,
    pub name: String,
    pub text: String,
    pub at: f64,
}

/// Everything a session reports, drained once per frame by `poll()`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Event {
    /// Seated in a play or match room.
    Joined {
        session_id: String,
    },
    /// The join was refused (§3.4). 426 = this build speaks an unsupported protocol: never retry.
    JoinFailed {
        code: i32,
        message: String,
    },
    PlayerJoined {
        id: String,
    },
    PlayerLeft {
        id: String,
    },
    HostChanged {
        host: Option<String>,
    },
    SharedChanged {
        key: String,
    },
    /// An object appeared or changed owner.
    ObjectChanged {
        id: String,
        owner: Option<String>,
    },
    ObjectRemoved {
        id: String,
    },
    ControlResult(ControlResult),
    /// A game event from another client (§5.4).
    Message {
        kind: String,
        data: Value,
    },
    /// An input forwarded to you as host (§6.4).
    Input {
        from: String,
        data: Value,
    },
    RoomOpen {
        open: bool,
    },
    Chat(ChatMessage),
    /// The relay dropped this many of your messages for rate (§5.1): publish less.
    RateDrop {
        dropped: f64,
    },
    /// The relay is about to restart (§14): flush anything you persist.
    ServerRestart,
    MatchStart {
        round_id: f64,
    },
    MatchEnded {
        data: Value,
    },
    MatchRequeue {
        reason: Option<String>,
    },
    /// Matchmaking queue position (§9.2).
    Queue {
        position: f64,
        size: f64,
    },
    /// A seat reservation arrived; the session is moving into its match room.
    Seated,
    /// The socket dropped; the SDK is reconnecting (§8).
    Reconnecting {
        code: i32,
    },
    /// The post-reconnect sequence finished.
    Reconnected,
    /// Terminal (§11). Playing again needs a new session with a fresh token.
    Disconnected {
        code: i32,
        reason: String,
    },
    Warning {
        message: String,
    },
}

/// Why a connect did not end seated (the payload of [`Event::JoinFailed`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JoinFailure {
    /// The matchmaking error code (§3.4; 426 = never retry), a close code, or 0 (local failure).
    pub code: i32,
    pub message: String,
}

impl fmt::Display for JoinFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "join failed ({}): {}", self.code, self.message)
    }
}

impl std::error::Error for JoinFailure {}

/// Errors a session call can return.
#[derive(Debug, Clone, PartialEq)]
pub enum Error {
    /// The socket is not open; the message was dropped, not queued (§8).
    NotConnected,
    /// A reserved or invalid game event type (§5.4).
    ReservedType(String),
    /// A write to an object this session does not own.
    NotOwner(String),
    /// A payload the relay would drop (size, shape, key rules).
    InvalidPayload(String),
    State(StateError),
    Codec(CodecError),
    /// The identity provider could not supply a token.
    Identity(String),
    /// A JS bridge failure (web).
    Bridge(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::NotConnected => write!(f, "not connected: message dropped"),
            Error::ReservedType(t) => write!(f, "`{t}` is a reserved message type"),
            Error::NotOwner(id) => write!(f, "this session does not own object `{id}`"),
            Error::InvalidPayload(m) => write!(f, "invalid payload: {m}"),
            Error::State(e) => write!(f, "{e}"),
            Error::Codec(e) => write!(f, "{e}"),
            Error::Identity(m) => write!(f, "identity: {m}"),
            Error::Bridge(m) => write!(f, "bridge: {m}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<StateError> for Error {
    fn from(e: StateError) -> Self {
        Error::State(e)
    }
}

impl From<CodecError> for Error {
    fn from(e: CodecError) -> Self {
        Error::Codec(e)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn events_use_the_bridge_json_shape() {
        let e = Event::PlayerJoined { id: "abc".into() };
        assert_eq!(
            serde_json::to_value(&e).unwrap(),
            json!({"type": "playerJoined", "id": "abc"})
        );
        let j: Event = serde_json::from_value(json!({"type": "joined", "sessionId": "s1"})).unwrap();
        assert_eq!(
            j,
            Event::Joined {
                session_id: "s1".into()
            }
        );
        let r: Event = serde_json::from_value(json!({
            "type": "controlResult", "requestId": "r1", "operation": "claim", "id": "ball",
            "accepted": true, "owner": "s1", "sequence": 1, "reason": "accepted"
        }))
        .unwrap();
        assert!(matches!(r, Event::ControlResult(ControlResult { accepted: true, .. })));
        assert_eq!(
            serde_json::to_value(Event::Reconnected).unwrap(),
            json!({"type": "reconnected"})
        );
    }
}
