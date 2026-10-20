//! The vocabularies (NetMode, NetStatus, NetOffline, NetErrorCode, NetControl, NetClose,
//! MatchStatus, NetWarning), each with `ALL` and its exact wire spelling, the caps a game sees, the
//! protocol limits the write queue checks, and the refusal a write returns.
//!
//! The reserved message names and the size limits are the relay protocol's (PROTOCOL.md §5),
//! restated here (the crate links genex-multiplayer only under `relay`), and `tests/writes.rs`
//! holds them equal to the vendored crate's own table.

use std::fmt;

/// The relay's seat cap: at most this many players in a room, me included.
pub const NET_PLAYERS_MAX: usize = 64;
/// The relay's object cap: a claim of a new object past it refuses `net-object-cap`.
pub const NET_OBJECTS_MAX: usize = 128;
/// The default publish rate of `set_me` and `set_object` (coalesced, latest wins).
pub const NET_PUBLISH_HZ_DEFAULT: u32 = 15;
/// The highest publish rate a game may choose (the relay's state lane).
pub const NET_PUBLISH_HZ_MAX: u32 = 30;
/// The tick rate the publish interval divides (the runtime's fixed 60 Hz step).
pub const NET_TICK_HZ: u32 = 60;
/// The default digits numbers are rounded to at flush.
pub const NET_DECIMALS_DEFAULT: u32 = 3;
/// The most digits a game may keep at flush.
pub const NET_DECIMALS_MAX: u32 = 6;
/// The default sim-time smoothing delay, in ticks.
pub const NET_INTERP_DELAY_TICKS_DEFAULT: u32 = 6;
/// The longest sim-time smoothing delay, in ticks.
pub const NET_INTERP_DELAY_TICKS_MAX: u32 = 30;
/// Events one frame carries; the rest carry into the next tick, in order.
pub const NET_EVENTS_PER_TICK_MAX: usize = 1024;
/// The longest chat line, in UTF-16 units (the relay's §12 cap).
pub const NET_CHAT_CHARS_MAX: usize = 500;
/// The net journal's byte cap on a desktop.
pub const NET_JOURNAL_BYTES_DESKTOP: usize = 16 << 20;
/// The net journal's byte cap on a phone or the web.
pub const NET_JOURNAL_BYTES_PHONE: usize = 4 << 20;
/// The longest private lobby code a game may join.
pub const NET_CODE_CHARS_MAX: usize = 64;

/// The relay protocol's limits (PROTOCOL.md §5), held equal to genex-multiplayer's `limits`.
pub mod limits {
    /// A player's state, as JSON bytes.
    pub const MAX_STATE_BYTES: usize = 16 * 1024;
    /// A shared-map key, in UTF-16 units.
    pub const MAX_SHARED_KEY_CHARS: usize = 256;
    /// A shared-map value, as JSON bytes.
    pub const MAX_SHARED_VALUE_BYTES: usize = 64 * 1024;
    /// Keys in the shared map.
    pub const MAX_SHARED_KEYS: usize = 256;
    /// An object id, in UTF-16 units.
    pub const MAX_OBJECT_ID_CHARS: usize = 128;
    /// An object's state, as JSON bytes.
    pub const MAX_OBJECT_STATE_BYTES: usize = 64 * 1024;
    /// A game event's payload, as JSON bytes.
    pub const MAX_EVENT_BYTES: usize = 16 * 1024;
    /// A game event's type, in UTF-16 units.
    pub const MAX_EVENT_TYPE_CHARS: usize = 128;
    /// The deepest JSON nesting the relay accepts.
    pub const MAX_JSON_DEPTH: usize = 32;
    /// The most JSON nodes one value may hold.
    pub const MAX_JSON_NODES: usize = 4096;
}

/// Prefixes a game event may not use (PROTOCOL.md §5.4).
pub const RESERVED_EVENT_PREFIXES: [&str; 4] = ["__", "match:", "server:", "rate:"];
/// Exact names a game event may not use (PROTOCOL.md §5.4).
pub const RESERVED_EVENT_TYPES: [&str; 8] = ["state", "shared", "claim", "release", "destroy", "obj", "queue", "seat"];
/// Shared-map keys with this prefix belong to the relay (PROTOCOL.md §5.2).
pub const RESERVED_SHARED_PREFIX: &str = "__";

/// Whether `kind` belongs to the relay rather than the game (PROTOCOL.md §5.4).
pub fn is_reserved_event_type(kind: &str) -> bool {
    RESERVED_EVENT_TYPES.contains(&kind) || RESERVED_EVENT_PREFIXES.iter().any(|prefix| kind.starts_with(prefix))
}

/// The JavaScript length of a string (UTF-16 units), the unit every relay text cap counts in.
pub fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// Declares a wire vocabulary: the enum, `ALL` in declaration order, `wire()` and `from_wire()`.
macro_rules! vocabulary {
    ($(#[$meta:meta])* $name:ident { $($(#[$vmeta:meta])* $variant:ident => $wire:literal,)+ }) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
        #[non_exhaustive]
        pub enum $name {
            $($(#[$vmeta])* $variant,)+
        }

        impl $name {
            /// Every value, in declaration order.
            pub const ALL: &'static [$name] = &[$($name::$variant,)+];

            /// The exact wire spelling.
            pub const fn wire(self) -> &'static str {
                match self {
                    $($name::$variant => $wire,)+
                }
            }

            /// The value a wire spelling names, if any.
            pub fn from_wire(wire: &str) -> Option<$name> {
                match wire {
                    $($wire => Some($name::$variant),)+
                    _ => None,
                }
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(self.wire())
            }
        }
    };
}

vocabulary! {
    /// Which backend the build chose. Game code never chooses it.
    NetMode {
        /// No `[net]` table: the API compiles, nothing connects.
        Off => "off",
        /// Studio Live, captures, judges, demos and tests: an in-process room.
        Loopback => "loopback",
        /// Exports and the web draft: the relay.
        Relay => "relay",
        /// A journal fed back (tests).
        Replay => "replay",
    }
}

vocabulary! {
    /// Where the seat stands.
    NetStatus {
        /// Not connected; `offline_reason` says why.
        Offline => "offline",
        /// A connect is on its way.
        Connecting => "connecting",
        /// In the matchmaking queue.
        Searching => "searching",
        /// Seated in a match room, waiting for players.
        Waiting => "waiting",
        /// Seated and playing.
        Joined => "joined",
        /// The socket dropped; the client is reconnecting.
        Reconnecting => "reconnecting",
        /// Terminal: playing again needs a new connect.
        Closed => "closed",
    }
}

vocabulary! {
    /// Why the status is offline or closed before any connect.
    NetOffline {
        /// The game was built without `[net]`.
        Disabled => "net-disabled",
        /// A native export without the game's slug baked in.
        NoSlug => "net-no-slug",
        /// A web page without the edge's identity.
        NoIdentity => "net-no-identity",
        /// A destination with no network client.
        Unsupported => "net-unsupported",
        /// Studio's local-test page.
        LocalTest => "net-local-test",
    }
}

vocabulary! {
    /// Why a write was refused locally, against the frame this tick read.
    NetErrorCode {
        /// The seat is not joined.
        NotJoined => "net-not-joined",
        /// A host-only write from a player who is not the host.
        NotHost => "net-not-host",
        /// A write to an object another player owns, or nobody owns.
        NotOwner => "net-not-owner",
        /// A message type the relay owns (`claim`, `__x`, `match:*`, ...), or an empty one.
        MessageReserved => "net-message-reserved",
        /// A payload, state, key or type over the relay's size cap.
        MessageTooLarge => "net-message-too-large",
        /// A state that is not a JSON object, holds a non-finite number, or nests too deep.
        StateInvalid => "net-state-invalid",
        /// A claim of a new object past `NET_OBJECTS_MAX`.
        ObjectCap => "net-object-cap",
        /// A chat line over `NET_CHAT_CHARS_MAX`.
        ChatTooLong => "net-chat-too-long",
        /// A private lobby code that is not 1..=64 of `[A-Za-z0-9_-]`.
        CodeInvalid => "net-code-invalid",
    }
}

vocabulary! {
    /// The relay's answer to a claim, release or remove (PROTOCOL.md §7.2), 1:1.
    NetControl {
        /// Done.
        Accepted => "accepted",
        /// A claim of an object this player already owns.
        AlreadyOwner => "already-owner",
        /// Refused for now; the event carries `retry_at_tick`.
        Held => "held",
        /// A host-only request from a player who is not the host.
        NotHost => "not-host",
        /// A release or remove of an object another player owns.
        NotOwner => "not-owner",
        /// The host holds authority over the object.
        HostAuthority => "host-authority",
        /// Too many requests.
        RateLimited => "rate-limited",
        /// No such object.
        UnknownObject => "unknown-object",
        /// The client settled it itself: disconnected or timed out.
        Offline => "offline",
    }
}

vocabulary! {
    /// Why the seat closed (PROTOCOL.md §11 terminal codes, 1:1, plus a deliberate leave).
    NetClose {
        /// 1000: a normal close.
        Normal => "normal",
        /// 4000: the relay accepted a consented leave.
        Consented => "consented",
        /// 4001: the relay shut down.
        ServerShutdown => "server-shutdown",
        /// 4002: the relay closed with an error.
        ServerError => "server-error",
        /// 4003: every reconnect attempt failed.
        ReconnectFailed => "reconnect-failed",
        /// 4401: the identity was revoked.
        Revoked => "revoked",
        /// 4409: the same identity took the seat from another client.
        Replaced => "replaced",
        /// Any other terminal close code (the relay's own error codes).
        Other => "other",
        /// The game called `leave()`: no auto-reconnect.
        Left => "left",
    }
}

impl NetClose {
    /// The WebSocket close code, for the closes the relay sends one for.
    pub const fn code(self) -> Option<i32> {
        match self {
            NetClose::Normal => Some(1000),
            NetClose::Consented => Some(4000),
            NetClose::ServerShutdown => Some(4001),
            NetClose::ServerError => Some(4002),
            NetClose::ReconnectFailed => Some(4003),
            NetClose::Revoked => Some(4401),
            NetClose::Replaced => Some(4409),
            NetClose::Other | NetClose::Left => None,
        }
    }
}

vocabulary! {
    /// Where a matchmade seat stands (PROTOCOL.md §9).
    MatchStatus {
        /// In the queue.
        Searching => "searching",
        /// Seated, waiting for the minimum.
        Waiting => "waiting",
        /// The round is about to start.
        Countdown => "countdown",
        /// The round runs.
        Playing => "playing",
        /// The round ended.
        Ended => "ended",
    }
}

vocabulary! {
    /// Something the game may want to know that refused nothing this tick.
    NetWarning {
        /// The relay dropped messages for rate: publish less.
        RateLimited => "rate-limited",
        /// A queued object write lost its ownership before it left.
        UnownedWrite => "unowned-write",
        /// More than `NET_EVENTS_PER_TICK_MAX` events arrived; the rest come next tick.
        EventsDeferred => "events-deferred",
        /// The journal reached its byte cap and dropped whole oldest ticks.
        JournalTrimmed => "journal-trimmed",
        /// The platform could not turn Nagle off (Windows).
        NodelayUnavailable => "nodelay-unavailable",
    }
}

/// A write refused locally: the code and what was wrong, for a person to read. Nothing was queued.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NetError {
    code: NetErrorCode,
    detail: String,
}

impl NetError {
    /// A refusal with `code`.
    pub fn new(code: NetErrorCode, detail: impl Into<String>) -> NetError {
        NetError { code, detail: detail.into() }
    }

    /// What was refused.
    pub fn code(&self) -> NetErrorCode {
        self.code
    }

    /// The detail (values, limits), never matched on.
    pub fn detail(&self) -> &str {
        &self.detail
    }
}

impl fmt::Display for NetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.wire(), self.detail)
    }
}

impl std::error::Error for NetError {}
