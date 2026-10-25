extends RefCounted
## Genex relay protocol 3 as GDScript constants.
##
## A port of packages/multiplayer/src/protocol.ts. The normative spec is
## packages/multiplayer/PROTOCOL.md; section numbers (§) below refer to it.

# §2 versioning
const PROTOCOL_VERSION := 3

# §3.5 room types
const ROOM_PLAY := "play"
const ROOM_QUEUE := "queue"
const ROOM_MATCH := "match"

# §3.4 join refusal codes
const JOIN_BAD_OPTION := 400
const JOIN_AUTH_REQUIRED := 401
const JOIN_FORBIDDEN := 403
const JOIN_PROTOCOL_UNSUPPORTED := 426

# §5.2 client -> relay
const MSG_STATE := "state"
const MSG_STATE_SNAP := "__state:snap"
const MSG_SHARED := "shared"
const MSG_CLAIM := "claim"
const MSG_RELEASE := "release"
const MSG_DESTROY := "destroy"
const MSG_OBJECT := "obj"
const MSG_OBJECT_SNAP := "__object:snap"
const MSG_INPUT := "__input"
const MSG_ROOM_OPEN := "__room:open"
const MSG_CHAT := "__chat"
const MSG_CHAT_HISTORY_REQUEST := "__chat:history:request"
const MSG_MATCH_ELIMINATED := "match:eliminated"
const MSG_MATCH_SCORE := "match:score"
const MSG_MATCH_FINISH := "match:finish"
const MSG_POSE := "__pose"
const MSG_POSE_SNAP := "__pose:snap"

# §5.3 relay -> client
const SRV_OBJECT_RESULT := "__object:result"
const SRV_INPUT := "__input"
const SRV_ROOM_OPEN := "__room:open"
const SRV_CHAT := "__chat"
const SRV_CHAT_HISTORY := "__chat:history"
const SRV_RATE_DROP := "rate:drop"
const SRV_SERVER_RESTART := "server:restart"
const SRV_MATCH_START := "match:start"
const SRV_MATCH_ENDED := "match:ended"
const SRV_MATCH_REQUEUE := "match:requeue"
const SRV_QUEUE := "queue"
const SRV_SEAT := "seat"

# §5.4 reserved game-event names
const RESERVED_EVENT_PREFIXES := ["__", "match:", "server:", "rate:"]
const RESERVED_EVENT_TYPES := ["state", "shared", "claim", "release", "destroy", "obj", "queue", "seat"]
const RESERVED_SHARED_PREFIX := "__"
const SEND_TIME_KEY := "__t"

# §11 close codes
const CLOSE_GOING_AWAY := 1001
const CLOSE_NO_STATUS := 1005
const CLOSE_ABNORMAL := 1006
const CLOSE_MAY_TRY_RECONNECT := 4010
const CLOSE_NORMAL := 1000
const CLOSE_CONSENTED := 4000
const CLOSE_SERVER_SHUTDOWN := 4001
const CLOSE_WITH_ERROR := 4002
const CLOSE_FAILED_TO_RECONNECT := 4003
const CLOSE_REVOKED := 4401
const CLOSE_SUPERSEDED := 4409

# §5 limits (sizes are UTF-16 units at the relay; keeping UTF-8 bytes under them is always safe)
const MAX_NAME_CHARS := 64
const MAX_STATE_BYTES := 16 * 1024
const MAX_SHARED_KEY_CHARS := 256
const MAX_SHARED_VALUE_BYTES := 64 * 1024
const MAX_OBJECT_ID_CHARS := 128
const MAX_OBJECT_STATE_BYTES := 64 * 1024
const MAX_REQUEST_ID_CHARS := 96
const MAX_EVENT_BYTES := 16 * 1024
const MAX_EVENT_TYPE_CHARS := 128
const MAX_CHAT_CHARS := 500
const MAX_ANIM_CHARS := 64
const MAX_POSE_ABS := 1e9
const INT32_MIN := -2147483648
const INT32_MAX := 2147483647

# §8 reconnection settings, in the Godot binding's snake_case keys
const RECONNECTION := {
	"enabled": true,
	"min_uptime_ms": 0,
	"delay_ms": 125,
	"min_delay_ms": 100,
	"max_delay_ms": 4000,
	"max_retries": 9,
	"max_enqueued_messages": 0,
}
const FIRST_STATE_TIMEOUT_MS := 2000.0
const CONTROL_TIMEOUT_MS := 5000.0
const CONTROL_TIMEOUT_MAX_MS := 60000.0

# §6.6 typed pose
const POSE_KEYS := ["x", "y", "z", "yaw", "vx", "vy", "vz", "anim"]
const POSE_NUMERIC_KEYS := ["x", "y", "z", "yaw", "vx", "vy", "vz"]

# §10 interpolation
const INTERP_RATIO := 1.5
const INTERP_JITTER_SAFETY := 1.25
const INTERP_MIN_MS := 90.0
const INTERP_MAX_MS := 300.0
const INTERP_DEFAULT_MS := 100.0
const INTERP_EASE := 0.1
const CLOCK_WINDOW := 80
const CLOCK_WINDOW_MS := 5000.0
const CLOCK_WINDOW_MAX := 4096
const INTERVAL_WINDOW := 30
const MIN_GAP_MS := 5.0
const MAX_GAP_MS := 2000.0
const HISTORY_MS := 1500.0
const MAX_EXTRAP_MS := 250.0
const ROT_EXTRAP_MS := 150.0
const SMOOTH_TAU_POS_MS := 30.0
const SMOOTH_TAU_ROT_MS := 70.0
const POISON_GUARD_MS := 2000.0
const REBASE_AFTER_GAP_MS := 1000.0
const MAX_DT_MS := 250.0

# §16 server clock
const HEARTBEAT_HZ := 10.0
const MIN_HEARTBEAT_HZ := 5.0
const MAX_HEARTBEAT_HZ := 20.0
const HEARTBEAT_DITHER := 0.15
const WARMUP_ACKS := 30


static func is_reserved_event_type(type: String) -> bool:
	if RESERVED_EVENT_TYPES.has(type):
		return true
	for prefix in RESERVED_EVENT_PREFIXES:
		if type.begins_with(prefix):
			return true
	return false


## Close codes after which the seat is gone (§11).
static func is_terminal_close(code: int) -> bool:
	return not (code == CLOSE_GOING_AWAY or code == CLOSE_NO_STATUS or code == CLOSE_ABNORMAL or code == CLOSE_MAY_TRY_RECONNECT)
