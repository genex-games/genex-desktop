extends Node
## Genex multiplayer for Godot 4: a client of the Genex relay (protocol 3).
##
## The plugin registers this script as the `GenexMultiplayer` autoload. More instances are
## allowed (split screen, tests): `var mp = preload("res://addons/genex_multiplayer/genex_multiplayer.gd").new()`
## then `add_child(mp)`; the node must be inside the tree (it hosts the heartbeat timer).
##
## Native builds run over the official Colyseus GDExtension (addons/colyseus). Web exports run
## over the TypeScript SDK through window.GenexMultiplayerBridge. Both expose this same API.
##
##   GenexMultiplayer.connected.connect(func(id): print("I am ", id))
##   GenexMultiplayer.join({
##       "url": "wss://relay.genex.games",
##       "game_id": "my-game",
##       "name": "ada",
##       "identity": func(): return await my_identity.embed_token(),   # fresh per join
##   })
##   # fixed 10-20 Hz tick:
##   GenexMultiplayer.set_me({"x": pos.x, "y": pos.y, "q": [q.x, q.y, q.z, q.w]})
##   # every frame:
##   for id in GenexMultiplayer.players(): ...   # remote `state` is smoothed

const P = preload("res://addons/genex_multiplayer/protocol.gd")

# ---- lifecycle ----
## First full state decoded: `players()`, `host_id()` and `is_host()` are valid from here.
signal connected(session_id: String)
## A join was refused (400 bad option, 401 auth, 403 forbidden, 426 protocol) or failed.
signal error(code: int, message: String)
## The socket dropped; the SDK is reconnecting in place (§8). Host simulation must stop.
signal reconnecting(attempt: int, code: int)
## Back in the same seat after the post-reconnect sequence (§8). Re-check is_host().
signal reconnected()
## Terminal: the seat is gone (close code, §11). Join again with a fresh token to play.
signal disconnected(code: int)

# ---- players / shared / host ----
signal player_joined(id: String, state: Dictionary)
signal player_left(id: String)
signal player_changed(id: String, state: Dictionary)
signal player_connection_changed(id: String, connected: bool)
signal shared_changed(key: String, value: Variant)
signal host_changed(host_id: String)

# ---- objects ----
## An object appeared, changed owner, or was reset (epoch). Poll get_object() for its state.
signal object_changed(id: String, owner: String)
signal object_removed(id: String)

# ---- messages ----
## A game event from another client (send()).
signal message(type: String, data: Variant)
## Host only: an input sent with send_input() by `from`.
signal input_received(from: String, data: Variant)
signal chat(message: Dictionary)
signal room_open_changed(open: bool)
## The relay dropped messages over budget. Publish less.
signal rate_dropped(dropped: int)
signal server_restart()

# ---- matchmaking ----
signal queue_update(position: int, size: int)
signal match_state_changed(state: Dictionary)
signal match_started(round_id: int)
signal match_ended(result: Dictionary)
signal match_requeued(reason: String)

var _backend = null


func _ready() -> void:
	# A paused tree (the usual pause menu) must not stop heartbeats, request timeouts, the §8
	# resync deadline or interpolation: a paused host would stay connected and freeze the room.
	process_mode = Node.PROCESS_MODE_ALWAYS


func _process(delta: float) -> void:
	if _backend != null:
		_backend.process(delta)


## Join a room. Options:
##   url: String | urls: Array      relay URL(s) (wss://...). With several, the first is used (TODO: latency pick).
##   game_id: String                the game's slug (must equal the token's `slug`)
##   identity: Callable             returns the embed token (String) or {embedToken}; may be async.
##                                  Called before EVERY join; never cached (§3.2).
##   embed_token: String            a static token (local tests only; tokens expire in ~15 min)
##   name: String                   display-name fallback
##   mode: "play" (default) | "matchmake" | "create" (private lobby) | "join_by_id" (with `code`)
##   pose: bool                     publish x,y,z,yaw,vx,vy,vz,anim as the typed pose (§6.6), default false
##   control_timeout_ms: float      claim/release/destroy timeout, default 5000
##   backend: "auto" | "native" | "web"
##   test_clock_skew_ms: float      TEST ONLY (native): offsets this session's clock origin, as another
##                                  machine's clock would be (the netcode-bench driver's `skew`)
func join(opts: Dictionary) -> void:
	if _backend != null and _backend.is_joined():
		push_warning("genex: join() while already joined; call leave() first")
		return
	var which := str(opts.get("backend", "auto"))
	if which == "web" or (which == "auto" and OS.has_feature("web")):
		_backend = load("res://addons/genex_multiplayer/web_backend.gd").new()
	else:
		_backend = load("res://addons/genex_multiplayer/native_backend.gd").new()
	_backend.node = self
	await _backend.join(opts)


## Leave with consent. `disconnected(4000)` follows.
func leave() -> void:
	if _backend != null:
		_backend.leave()


func backend_name() -> String:
	if _backend == null:
		return ""
	return "web" if _backend.get_script().resource_path.ends_with("web_backend.gd") else "native"


func is_joined() -> bool: return _backend != null and _backend.is_joined()
func is_reconnecting() -> bool: return _backend != null and _backend.is_reconnecting()
func session_id() -> String: return _backend.session_id() if _backend != null else ""
func host_id() -> String: return _backend.host_id() if _backend != null else ""
## Run host simulation only while this is true (§6.3). False while reconnecting.
func is_host() -> bool: return _backend != null and _backend.is_host()

# ---- players ----

## Every seated player, including you: id -> {id, name, uid, team, connected, avatar_url, is_me,
## posed, state, state_raw}. `state` is smoothed for remote players and your last set_me() for you;
## `state_raw` is the latest raw snapshot (use it for game logic). Numbers read back as floats.
func players() -> Dictionary: return _backend.players() if _backend != null else {}
func get_player(id: String): return _backend.get_player(id) if _backend != null else null

## Publish your state (replaced wholesale). Call on a fixed 10-20 Hz tick, never every frame.
func set_me(state: Dictionary) -> bool: return _backend != null and _backend.set_me(state, false)
## Publish a deliberate discontinuity (respawn, teleport): receivers drop history.
func snap_me(state: Dictionary) -> bool: return _backend != null and _backend.set_me(state, true)

# ---- shared ----

func shared_get(key: String, default = null): return _backend.shared_get(key, default) if _backend != null else default
func shared_set(key: String, value) -> bool: return _backend != null and _backend.shared_set(key, value)
func shared_keys() -> Array: return _backend.shared_keys() if _backend != null else []

# ---- objects ----

## Ask for ownership. Returns a request: `var r = await GenexMultiplayer.claim("ball").done`.
## Optimistic: get_object(id).is_mine is true at once and reverts on rejection.
## `host_authority` (host only) displaces an active owner's hold; use it for seeding/resets only.
func claim(id: String, host_authority := false): return _backend.claim(id, host_authority) if _backend != null else null
func release(id: String): return _backend.release(id) if _backend != null else null
## Owner-only removal. Its result's `operation` is "remove".
func destroy(id: String): return _backend.destroy(id) if _backend != null else null
## Owner-only publish of the object's state (a flat Dictionary smooths best).
func object_set(id: String, state: Dictionary) -> bool: return _backend != null and _backend.object_set(id, state, false)
## Owner-only reset/teleport publish: receivers drop history.
func object_snap(id: String, state: Dictionary) -> bool: return _backend != null and _backend.object_set(id, state, true)
## {id, owner, confirmed_owner, is_mine, seq, epoch, state, state_raw} or null.
func get_object(id: String): return _backend.get_object(id) if _backend != null else null
func object_ids() -> Array: return _backend.object_ids() if _backend != null else []

# ---- messages ----

## A game event to every other client (not echoed to you). Not queued while disconnected.
func send(type: String, data = null) -> bool: return _backend != null and _backend.send(type, data)
## An input delivered only to the current host (`input_received` there).
func send_input(data) -> bool: return _backend != null and _backend.send_input(data)
## Chat: render only what arrives on the `chat` signal (your own line comes back too).
func chat_send(text: String) -> bool: return _backend != null and _backend.chat_send(text)
func chat_history() -> Array: return _backend.chat_history() if _backend != null else []
## Host only: close or reopen the room to new matchmaking placements.
func set_room_open(open: bool) -> bool: return _backend != null and _backend.set_room_open(open)

# ---- matches ----

func match_state() -> Dictionary: return _backend.match_state() if _backend != null else {}
func report_eliminated() -> bool: return _backend != null and _backend.report_eliminated()
func report_score(delta := 1.0) -> bool: return _backend != null and _backend.report_score(delta)
func report_finish() -> bool: return _backend != null and _backend.report_finish()

# ---- server clock (§16; only when the relay publishes it) ----

func clock_enabled() -> bool: return _backend != null and _backend.clock_enabled()
## The relay's room clock in ms, or NAN without one.
func server_now() -> float: return _backend.server_now() if _backend != null else NAN
func rtt() -> float: return _backend.rtt() if _backend != null else NAN
func clock_synced() -> bool: return _backend != null and _backend.clock_synced()
## ms until a relay epoch-ms deadline (match startsAt/endsBy), on the server clock once synced.
func time_until_ms(deadline_epoch_ms: float) -> float:
	if _backend != null:
		return _backend.time_until_ms(deadline_epoch_ms)
	return deadline_epoch_ms - Time.get_unix_time_from_system() * 1000.0

## The clock this client stamps `__t` and object `t` with (ms, monotonic). Not wall time.
func now_ms() -> float:
	if _backend != null and _backend.has_method("now_ms"):
		return _backend.now_ms()
	return Time.get_ticks_usec() / 1000.0 + 1.0

# ---- capabilities ----

## Voice (WebRTC mesh, §13) is not available in the Godot client.
func voice_supported() -> bool: return false
func stats() -> Dictionary: return _backend.stats() if _backend != null else {}
