//! Genex relay protocol 3 constants: a port of `packages/multiplayer/src/protocol.ts`.
//!
//! `packages/multiplayer/PROTOCOL.md` is normative; section numbers (§) refer to it. When this
//! file and `protocol.ts` disagree, `protocol.ts` is what the relay runs: fix this file.

/// The protocol this crate speaks, sent as the `protocol` join option (§2).
pub const PROTOCOL_VERSION: u32 = 3;

/// Colyseus room types (§3.5). Games are isolated by the `gameId` filter, not by room type.
pub mod room_type {
    pub const PLAY: &str = "play";
    pub const QUEUE: &str = "queue";
    pub const MATCH: &str = "match";
}

/// Join refusal codes (§3.4): the matchmaking error's `code`.
pub mod join_error {
    pub const BAD_OPTION: i32 = 400;
    pub const AUTH_REQUIRED: i32 = 401;
    pub const FORBIDDEN: i32 = 403;
    /// Unsupported protocol. Never retry; the game needs an update.
    pub const PROTOCOL_UNSUPPORTED: i32 = 426;
}

/// Client → relay message types (§5.2).
pub mod client_message {
    pub const STATE: &str = "state";
    pub const STATE_SNAP: &str = "__state:snap";
    pub const SHARED: &str = "shared";
    pub const CLAIM: &str = "claim";
    pub const RELEASE: &str = "release";
    pub const DESTROY: &str = "destroy";
    pub const OBJECT: &str = "obj";
    pub const OBJECT_SNAP: &str = "__object:snap";
    pub const INPUT: &str = "__input";
    pub const ROOM_OPEN: &str = "__room:open";
    pub const CHAT: &str = "__chat";
    pub const CHAT_HISTORY_REQUEST: &str = "__chat:history:request";
    pub const MATCH_ELIMINATED: &str = "match:eliminated";
    pub const MATCH_SCORE: &str = "match:score";
    pub const MATCH_FINISH: &str = "match:finish";
    pub const POSE: &str = "__pose";
    pub const POSE_SNAP: &str = "__pose:snap";
}

/// Relay → client message types (§5.3).
pub mod server_message {
    pub const OBJECT_RESULT: &str = "__object:result";
    pub const INPUT: &str = "__input";
    pub const ROOM_OPEN: &str = "__room:open";
    pub const CHAT: &str = "__chat";
    pub const CHAT_HISTORY: &str = "__chat:history";
    pub const VOICE_ICE: &str = "__voice:ice";
    pub const VOICE_SIGNAL: &str = "__voice:signal";
    pub const VOICE_REJECTED: &str = "__voice:rejected";
    pub const RATE_DROP: &str = "rate:drop";
    pub const SERVER_RESTART: &str = "server:restart";
    pub const MATCH_START: &str = "match:start";
    pub const MATCH_ENDED: &str = "match:ended";
    pub const MATCH_REQUEUE: &str = "match:requeue";
    pub const QUEUE: &str = "queue";
    pub const SEAT: &str = "seat";
}

/// Prefixes a game event may not use (§5.4).
pub const RESERVED_EVENT_PREFIXES: [&str; 4] = ["__", "match:", "server:", "rate:"];
/// Exact names a game event may not use (§5.4).
pub const RESERVED_EVENT_TYPES: [&str; 8] = ["state", "shared", "claim", "release", "destroy", "obj", "queue", "seat"];

/// Whether `kind` belongs to the relay rather than the game (§5.4).
pub fn is_reserved_event_type(kind: &str) -> bool {
    RESERVED_EVENT_TYPES.contains(&kind) || RESERVED_EVENT_PREFIXES.iter().any(|p| kind.starts_with(p))
}

/// Whether `kind` may be sent as a game event: 1..=128 UTF-16 units and not reserved.
pub fn is_sendable_event_type(kind: &str) -> bool {
    let units = kind.encode_utf16().count();
    units > 0 && units <= limits::MAX_EVENT_TYPE_CHARS && !is_reserved_event_type(kind)
}

/// Shared-map keys with this prefix are refused from clients (§5.2).
pub const RESERVED_SHARED_PREFIX: &str = "__";
/// The key a sender stamps into its own `PlayerState.data` JSON: its send clock in ms (§6.1).
pub const SEND_TIME_KEY: &str = "__t";

/// WebSocket close codes (§11).
pub mod close_code {
    pub const GOING_AWAY: i32 = 1001;
    pub const NO_STATUS: i32 = 1005;
    pub const ABNORMAL: i32 = 1006;
    pub const MAY_TRY_RECONNECT: i32 = 4010;
    pub const NORMAL: i32 = 1000;
    pub const CONSENTED: i32 = 4000;
    pub const SERVER_SHUTDOWN: i32 = 4001;
    pub const WITH_ERROR: i32 = 4002;
    pub const FAILED_TO_RECONNECT: i32 = 4003;
    pub const REVOKED: i32 = 4401;
    pub const SUPERSEDED: i32 = 4409;

    /// Codes the SDK reconnects from (§8, §11). Everything else is terminal.
    pub fn is_reconnectable(code: i32) -> bool {
        matches!(code, GOING_AWAY | NO_STATUS | ABNORMAL | MAY_TRY_RECONNECT)
    }
}

/// Size and count limits (§5). Sizes are JavaScript string lengths (UTF-16 code units); keeping
/// the UTF-8 byte length under a limit always stays within it.
pub mod limits {
    pub const ROOM_MAX_CLIENTS: usize = 64;
    pub const MAX_NAME_CHARS: usize = 64;
    pub const MAX_STATE_BYTES: usize = 16 * 1024;
    pub const MAX_SHARED_KEY_CHARS: usize = 256;
    pub const MAX_SHARED_VALUE_BYTES: usize = 64 * 1024;
    pub const MAX_SHARED_KEYS: usize = 256;
    pub const MAX_OBJECT_ID_CHARS: usize = 128;
    pub const MAX_OBJECT_STATE_BYTES: usize = 64 * 1024;
    pub const MAX_OBJECTS: usize = 128;
    pub const MAX_REQUEST_ID_CHARS: usize = 96;
    pub const MAX_EVENT_BYTES: usize = 16 * 1024;
    pub const MAX_EVENT_TYPE_CHARS: usize = 128;
    pub const MAX_JSON_DEPTH: usize = 32;
    pub const MAX_JSON_NODES: usize = 4096;
    pub const MAX_CHAT_CHARS: usize = 500;
    pub const MAX_ANIM_CHARS: usize = 64;
    pub const MAX_POSE_ABS: f64 = 1e9;
}

/// The reconnection settings every client applies (§8, `ClientReconnection` in protocol.ts).
pub mod reconnection {
    pub const ENABLED: bool = true;
    pub const MIN_UPTIME_MS: i32 = 0;
    pub const DELAY_MS: i32 = 125;
    pub const MIN_DELAY_MS: i32 = 100;
    pub const MAX_DELAY_MS: i32 = 4000;
    pub const MAX_RETRIES: i32 = 9;
    pub const MAX_ENQUEUED_MESSAGES: i32 = 0;
    /// After the SDK reports reconnected, wait at most this for the first state decode.
    pub const FIRST_STATE_TIMEOUT_MS: f64 = 2000.0;
}

/// Control request client timeouts (§7.2).
pub const CONTROL_TIMEOUT_MS: f64 = 5000.0;
pub const CONTROL_TIMEOUT_MAX_MS: f64 = 60_000.0;

/// §10 interpolation defaults (`Interpolation` in protocol.ts).
pub mod interpolation {
    pub const RATIO: f64 = 1.5;
    pub const JITTER_SAFETY: f64 = 1.25;
    pub const MIN_MS: f64 = 90.0;
    pub const MAX_MS: f64 = 300.0;
    pub const DEFAULT_MS: f64 = 100.0;
    pub const EASE: f64 = 0.1;
    pub const CLOCK_WINDOW: usize = 80;
    pub const CLOCK_WINDOW_MS: f64 = 5000.0;
    pub const CLOCK_WINDOW_MAX: usize = 4096;
    pub const INTERVAL_WINDOW: usize = 30;
    pub const MIN_GAP_MS: f64 = 5.0;
    pub const MAX_GAP_MS: f64 = 2000.0;
    pub const HISTORY_MS: f64 = 1500.0;
    pub const MAX_EXTRAP_MS: f64 = 250.0;
    pub const ROT_EXTRAP_MS: f64 = 150.0;
    pub const SMOOTH_TAU_POS_MS: f64 = 30.0;
    pub const SMOOTH_TAU_ROT_MS: f64 = 70.0;
    pub const POISON_GUARD_MS: f64 = 2000.0;
    pub const REBASE_AFTER_GAP_MS: f64 = 1000.0;
    pub const MAX_HOST_TICK_DT_MS: f64 = 250.0;
    /// The jitter term applies once a stream holds this many (arrival − send) values.
    pub const JITTER_MIN_SAMPLES: usize = 8;
}

/// §16 server clock heartbeat (`ClockSync` in protocol.ts).
pub mod clock_sync {
    pub const HEARTBEAT_HZ: f64 = 10.0;
    pub const MIN_HEARTBEAT_HZ: f64 = 5.0;
    pub const MAX_HEARTBEAT_HZ: f64 = 20.0;
    pub const HEARTBEAT_DITHER: f64 = 0.15;
    pub const WARMUP_ACKS: i32 = 30;
}

/// The `PlayerState` pose keys, in schema order (§6.6).
pub const POSE_KEYS: [&str; 8] = ["x", "y", "z", "yaw", "vx", "vy", "vz", "anim"];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserved_event_types() {
        assert!(is_reserved_event_type("claim"));
        assert!(is_reserved_event_type("__anything"));
        assert!(is_reserved_event_type("match:score"));
        assert!(!is_reserved_event_type("boom"));
        assert!(!is_sendable_event_type(""));
        assert!(is_sendable_event_type("goal"));
        assert!(!is_sendable_event_type(&"x".repeat(129)));
    }

    #[test]
    fn reconnect_backoff_lands_inside_the_grace() {
        // The C core waits clamp(min, max, (1 << n) * delay) before attempt n = 1..=max_retries
        // (room.c: retry_count is incremented before the delay is computed). §8: the last attempt
        // lands inside the relay's 30 s grace, at the TypeScript SDK's ~23.75 s.
        let total: i32 = (1..=reconnection::MAX_RETRIES)
            .map(|n| ((1 << n) * reconnection::DELAY_MS).clamp(reconnection::MIN_DELAY_MS, reconnection::MAX_DELAY_MS))
            .sum();
        assert_eq!(total, 23_750);
    }
}
