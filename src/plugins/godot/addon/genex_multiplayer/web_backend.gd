extends RefCounted
## Web backend: drives the TypeScript SDK through `window.GenexMultiplayerBridge`, which the
## exported page must load (see sdks/godot/README.md, "Web export"). Token handling, latency
## selection, reconnection, interpolation and the server clock all stay in TypeScript, so a web
## export behaves exactly like a JS game.
##
## The bridge contract is sdks/rust/BRIDGE.md, the same one the Rust web feature uses. In short:
## `open(optsJson)` returns a numeric handle at once; every other call takes that handle first;
## only JSON text, numbers and booleans cross; `drainEventsJson(handle)` returns, once per frame,
## everything that happened since the last call. Calls go through JavaScriptBridge.eval with
## JSON-quoted arguments (a JavaScriptObject method named `connect` would collide with Godot's
## Object.connect).
##
## Identity: the bridge reads the player's embed token from @genex-ai/embed-sdk on the page, fresh
## for every join. The `identity` / `embed_token` join options are native-only and ignored here.

const Util = preload("res://addons/genex_multiplayer/util.gd")
const Req = preload("res://addons/genex_multiplayer/request.gd")
const BRIDGE := "window.GenexMultiplayerBridge"

var node: Node
var _h := 0 # the bridge handle; 0 = none
var _queue_mode := false
var _pending := {}
var _req_counter := 0
var _joined := false
var _reconnecting := false
var _chat: Array = []
var _match := {}
var _frame_players = null # this frame's players, read at most once per drain


static func available() -> bool:
	return OS.has_feature("web") and bool(JavaScriptBridge.eval("typeof %s === 'object' && %s !== null" % [BRIDGE, BRIDGE], true))


func _call(method: String, args: Array = []):
	var parts := PackedStringArray()
	for a in args:
		parts.append(JSON.stringify(a)) # a JS literal of the argument
	return JavaScriptBridge.eval("%s[%s](%s)" % [BRIDGE, JSON.stringify(method), ", ".join(parts)], true)


## A call on this session's handle. Nothing to call before join() or after the handle is gone.
func _hcall(method: String, args: Array = []):
	if _h == 0:
		return null
	return _call(method, [_h] + args)


func _hcall_json(method: String, args: Array = []):
	var r = _hcall(method, args)
	if not (r is String):
		return null
	var json := JSON.new()
	return json.data if json.parse(r) == OK else null


func _fail(message: String) -> void:
	node.emit_signal("error", 0, message)
	node.emit_signal("disconnected", 0)


func join(opts: Dictionary) -> void:
	if not available():
		_fail("genex: window.GenexMultiplayerBridge is missing; load @genex-ai/multiplayer's bridge.global.js in the export's Head Include")
		return
	var game_id := str(opts.get("game_id", ""))
	if game_id == "":
		_fail("genex: game_id is required")
		return
	var room = "play"
	match str(opts.get("mode", "play")):
		"play": room = "play"
		"matchmake": room = "queue"
		"create": room = "private"
		"join_by_id": room = {"joinById": str(opts.get("code", ""))}
		var other:
			_fail("genex: unknown mode '%s'" % other)
			return
	_queue_mode = room is String and room == "queue"
	var urls: Array = []
	if opts.get("urls") is Array:
		for u in opts["urls"]:
			urls.append(str(u))
	elif opts.has("url"):
		urls.append(str(opts["url"]))
	var o := {"gameId": game_id, "room": room, "urls": urls, "pose": bool(opts.get("pose", false)), "protocol": 3}
	if opts.has("name"):
		o["name"] = str(opts["name"])
	if opts.has("control_timeout_ms"):
		o["controlTimeoutMs"] = float(opts["control_timeout_ms"])
	if opts.get("options") is Dictionary:
		o["options"] = Util.sanitize(opts["options"])
	var h = _call("open", [JSON.stringify(o)])
	if not (h is int or h is float) or int(h) <= 0:
		_fail("genex: the bridge refused the join options (see the browser console)")
		return
	_h = int(h)


func leave() -> void:
	_hcall("leave")


func process(_delta: float) -> void:
	if _h == 0:
		return
	var events = _hcall_json("drainEventsJson")
	_frame_players = null
	if not (events is Array):
		return
	for e in events:
		if e is Dictionary:
			_dispatch(e)


func _dispatch(e: Dictionary) -> void:
	match str(e.get("type", "")):
		"joined":
			_joined = true
			_reconnecting = false
			node.emit_signal("connected", str(e.get("sessionId", "")))
		"joinFailed":
			node.emit_signal("error", int(e.get("code", 0)), str(e.get("message", "")))
			_end(int(e.get("code", 0)))
		"playerJoined": node.emit_signal("player_joined", str(e.get("id", "")), _state_of(str(e.get("id", ""))))
		"playerChanged": node.emit_signal("player_changed", str(e.get("id", "")), _state_of(str(e.get("id", ""))))
		"playerConnection": node.emit_signal("player_connection_changed", str(e.get("id", "")), _ok(e.get("connected")))
		"playerLeft": node.emit_signal("player_left", str(e.get("id", "")))
		"hostChanged": node.emit_signal("host_changed", _str_or_empty(e.get("host")))
		"sharedChanged": node.emit_signal("shared_changed", str(e.get("key", "")), e.get("value"))
		"objectChanged": node.emit_signal("object_changed", str(e.get("id", "")), _str_or_empty(e.get("owner")))
		"objectRemoved": node.emit_signal("object_removed", str(e.get("id", "")))
		"controlResult":
			var req = _pending.get(str(e.get("requestId", "")))
			if req != null:
				_pending.erase(req.request_id)
				var r := e.duplicate()
				r.erase("type")
				if r.get("owner") == null:
					r["owner"] = ""
				req.settle(r)
		"message": node.emit_signal("message", str(e.get("kind", "")), e.get("data"))
		"input": node.emit_signal("input_received", str(e.get("from", "")), e.get("data"))
		"chat":
			var m := {"id": int(e.get("id", 0)), "from": str(e.get("from", "")), "name": str(e.get("name", "")),
				"text": str(e.get("text", "")), "at": float(e.get("at", 0.0))}
			_chat.append(m)
			node.emit_signal("chat", m)
		"roomOpen": node.emit_signal("room_open_changed", _ok(e.get("open")))
		"rateDrop": node.emit_signal("rate_dropped", int(e.get("dropped", 0)))
		"serverRestart": node.emit_signal("server_restart")
		"matchState":
			_match = _dict(e.get("state"))
			node.emit_signal("match_state_changed", _match)
		"matchStart": node.emit_signal("match_started", int(e.get("roundId", 0)))
		"matchEnded": node.emit_signal("match_ended", _dict(e.get("data")))
		"matchRequeue": node.emit_signal("match_requeued", _str_or_empty(e.get("reason")))
		"queue": node.emit_signal("queue_update", int(e.get("position", 0)), int(e.get("size", 0)))
		"reconnecting":
			_reconnecting = true
			node.emit_signal("reconnecting", int(e.get("attempt", 0)), int(e.get("code", 0)))
		"reconnected":
			_reconnecting = false
			node.emit_signal("reconnected")
		"disconnected": _end(int(e.get("code", 0)))
		"warning": push_warning(str(e.get("message", "")))


## Terminal: settle what is pending, forget the handle, then tell the game.
func _end(code: int) -> void:
	_joined = false
	_reconnecting = false
	for req in _pending.values():
		req.settle({"requestId": req.request_id, "operation": req.operation, "id": req.object_id, "accepted": false,
			"owner": "", "sequence": 0, "reason": "disconnected"})
	_pending.clear()
	_h = 0
	node.emit_signal("disconnected", code)


## A bridge write's answer. JavaScriptBridge.eval hands a JS boolean back as an int.
static func _ok(v) -> bool:
	return (v is bool and v) or ((v is int or v is float) and v != 0)


static func _dict(v) -> Dictionary:
	return v if v is Dictionary else {}


static func _str_or_empty(v) -> String:
	return "" if v == null else str(v)


func _session() -> Dictionary:
	return _dict(_hcall_json("sessionJson"))


func session_id() -> String: return str(_session().get("sessionId", ""))
func host_id() -> String: return _str_or_empty(_session().get("hostId"))
func is_host() -> bool: return _ok(_session().get("isHost"))
func is_joined() -> bool: return _joined
func is_reconnecting() -> bool: return _reconnecting


func _players_raw() -> Array:
	if _frame_players == null:
		var raw = _hcall_json("playersJson")
		_frame_players = raw if raw is Array else []
	return _frame_players


func _state_of(id: String) -> Dictionary:
	for p in _players_raw():
		if p is Dictionary and str(p.get("id", "")) == id:
			return _dict(p.get("state"))
	return {}


func players() -> Dictionary:
	var out := {}
	var raw = _hcall_json("playersJson")
	if raw is Array:
		for p in raw:
			if p is Dictionary:
				var v := _player_view(p)
				out[v.id] = v
	return out


func get_player(id: String):
	return players().get(id)


static func _player_view(d: Dictionary) -> Dictionary:
	return {"id": str(d.get("id", "")), "name": str(d.get("name", "")), "uid": str(d.get("uid", "")),
		"team": int(d.get("team", -1)), "connected": _ok(d.get("connected")),
		"avatar_url": str(d.get("avatarUrl", "")), "is_me": _ok(d.get("isMe")), "posed": _ok(d.get("posed")),
		"state": _dict(d.get("state")), "state_raw": _dict(d.get("stateRaw"))}


func shared_get(key: String, default = null):
	var s = _hcall_json("sharedJson")
	return s.get(key, default) if s is Dictionary else default


func shared_keys() -> Array:
	var s = _hcall_json("sharedJson")
	return s.keys() if s is Dictionary else []


func shared_set(key: String, value) -> bool:
	return _ok(_hcall("setShared", [key, JSON.stringify(Util.sanitize(value))]))


func _objects() -> Dictionary:
	var out := {}
	var raw = _hcall_json("objectsJson")
	if raw is Array:
		for o in raw:
			if o is Dictionary:
				out[str(o.get("id", ""))] = o
	return out


func get_object(id: String):
	var all := _objects()
	if not all.has(id):
		return null
	var o: Dictionary = all[id]
	var owner := _str_or_empty(o.get("owner"))
	return {"id": id, "owner": owner, "confirmed_owner": owner,
		"is_mine": _ok(o.get("isMine")), "seq": int(o.get("seq", 0)), "epoch": int(o.get("epoch", 0)),
		"state": _dict(o.get("state")), "state_raw": _dict(o.get("stateRaw"))}


func object_ids() -> Array:
	return _objects().keys()


func _control(method: String, operation: String, id: String) -> Req:
	var req := Req.new()
	_req_counter += 1
	req.request_id = "gdw-%d" % _req_counter
	req.operation = operation
	req.object_id = id
	if _h == 0:
		req.settle({"requestId": req.request_id, "operation": operation, "id": id, "accepted": false,
			"owner": "", "sequence": 0, "reason": "disconnected"})
		return req
	_pending[req.request_id] = req
	_hcall(method, [id, req.request_id])
	return req


## Not optimistic on web: `is_mine` turns true when the relay accepts the claim.
func claim(id: String, host_authority := false) -> Req:
	return _control("claimAsHost" if host_authority else "claim", "claim", id)


func release(id: String) -> Req:
	return _control("release", "release", id)


func destroy(id: String) -> Req:
	return _control("destroy", "remove", id)


func set_me(state: Dictionary, snap := false) -> bool:
	return _ok(_hcall("snapMe" if snap else "setMe", [JSON.stringify(Util.sanitize(state))]))


func object_set(id: String, d: Dictionary, snap := false) -> bool:
	return _ok(_hcall("snapObject" if snap else "setObject", [id, JSON.stringify(Util.sanitize(d))]))


func send(type: String, data = null) -> bool:
	return _ok(_hcall("send", [type, JSON.stringify(Util.sanitize(data))]))


func send_input(data) -> bool:
	return _ok(_hcall("sendInput", [JSON.stringify(Util.sanitize(data))]))


func chat_send(text: String) -> bool:
	return _ok(_hcall("chatSend", [text]))


func chat_history() -> Array:
	return _chat.duplicate()


func set_room_open(open: bool) -> bool:
	return _ok(_hcall("setRoomOpen", [open]))


func report_eliminated() -> bool:
	return _ok(_hcall("reportEliminated"))


func report_score(delta := 1.0) -> bool:
	return _ok(_hcall("reportScore", [delta]))


func report_finish() -> bool:
	return _ok(_hcall("reportFinish"))


func match_state() -> Dictionary:
	return _match


func clock_enabled() -> bool:
	var v = _hcall("serverNow")
	return (v is float or v is int) and is_finite(float(v))


func server_now() -> float:
	var v = _hcall("serverNow")
	return float(v) if (v is float or v is int) else NAN


func rtt() -> float:
	var v = _session().get("rtt")
	return float(v) if (v is float or v is int) else NAN


func clock_synced() -> bool:
	return _ok(_session().get("clockSynced"))


func clock_origin() -> float:
	return float(_session().get("clockOrigin", 0.0))


func time_until_ms(deadline_epoch_ms: float) -> float:
	var v = _hcall("timeUntil", [deadline_epoch_ms])
	return float(v) if (v is float or v is int) else deadline_epoch_ms - Time.get_unix_time_from_system() * 1000.0


func stats() -> Dictionary:
	return {"backend": "web", "pending_requests": _pending.size(), "handle": _h}
