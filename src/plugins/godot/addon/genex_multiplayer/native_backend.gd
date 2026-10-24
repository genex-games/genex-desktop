extends RefCounted
## Native backend: Genex protocol 3 over the official Colyseus GDExtension (addons/colyseus).
## Owned by the GenexMultiplayer node, which it emits signals through. Section numbers (§)
## refer to packages/multiplayer/PROTOCOL.md.

const P = preload("res://addons/genex_multiplayer/protocol.gd")
const C = preload("res://addons/colyseus/colyseus.gd")
const Schema = preload("res://addons/genex_multiplayer/schema.gd")
const Interp = preload("res://addons/genex_multiplayer/interpolation.gd")
const Req = preload("res://addons/genex_multiplayer/request.gd")
const Util = preload("res://addons/genex_multiplayer/util.gd")

const SERVER_OWNED_OPTIONS := ["clients", "preset", "winCondition", "config", "matchmade"]
const QUEUE_RETRY_MAX := 8

var node: Node # the GenexMultiplayer node: signal sink, timer host

var _opts := {}
var _mode := "play"
var _client = null
var _room = null
var _queue_room = null
var _graveyard: Array = [] # rooms released next frame, never inside their own callback
var _sid := ""
var _host := ""
var _joined := false
var _closed := true
var _leaving := false
var _requeuing := false
var _queue_attempts := 0
var _from_seat := false # the current room came from a §9.2 seat reservation and has not joined yet

# §8 reconnection bookkeeping
var _reconnecting := false
var _host_ready := false
var _awaiting_resync := false
var _resync_deadline := 0.0
var _drop_at := 0.0
var _attempt := 0
# Stalled-attempt watchdog (see _unstick_reconnect): attempts this outage ended, and when.
var _stall_kicks := 0
var _stall_ref := 0.0

# mirrors of the decoded state
var _players := {} # sid -> mirror Dictionary
var _objects := {} # id -> mirror Dictionary
var _view_owner := {} # id -> owner as this client sees it (optimistic while a claim is in flight)
var _shared := {} # key -> parsed value
var _shared_text := {} # key -> JSON text last seen
var _match := {}
var _match_text := ""
var _clock_origin := 0.0

var _local_state = null # my last published state (rendered for myself, §6.1)
var _local_objects := {} # objects I own -> my last publish
var _smooth := {} # stream key -> smoothed output
var _interp := Interp.new()

var _pending := {} # requestId -> Req
var _req_counter := 0
var _req_prefix := ""

var _chat: Array = []
var _chat_ids := {}

var _pose_mode := false
var _pose_mem := {}
var _last_data_text := ""

var _hb_timer: Timer = null
var _clock_synced := false
var _dropped_sends := 0
var _warned := {}
var _last_rate_warn := -1e9
## Test-only clock-origin offset (ms), read once at join from the `test_clock_skew_ms` option. The
## netcode-bench driver uses it to model another machine's clock; it is 0 in a game.
var _clock_skew_ms := 0.0


## The sender clock (§6.1): monotonic, fractional, never exactly 0. Stamps `__t`, object `t`
## and pose `t`, and is the local clock of interpolation.
func now_ms() -> float:
	return Time.get_ticks_usec() / 1000.0 + 1.0 + _clock_skew_ms


# =============================================================================
# Connection
# =============================================================================

func join(opts: Dictionary) -> void:
	_opts = opts
	_mode = str(opts.get("mode", "play"))
	_pose_mode = bool(opts.get("pose", false))
	var skew = opts.get("test_clock_skew_ms", 0.0)
	_clock_skew_ms = float(skew) if Interp._is_num(skew) else 0.0
	var url := _pick_url(opts)
	if url == "":
		node.emit_signal("error", 0, "genex: no relay url (pass url or urls)")
		return
	if str(opts.get("game_id", "")) == "":
		node.emit_signal("error", 0, "genex: game_id is required")
		return
	_closed = false
	_client = C.Client.new(url)
	_keep_polling_when_paused()
	if not _mode in ["play", "create", "join_by_id", "matchmake"]:
		node.emit_signal("error", 0, "genex: unknown mode '%s'" % _mode)
		return
	if _mode == "matchmake":
		await _search()
		return
	# The identity provider may be slow (an HTTP refresh, a device-code wait): leave() can run
	# meanwhile, and a seat taken after it would be a connected ghost that can win host (§6.3).
	var join_opts: Dictionary = await _join_options()
	if _closed or _leaving:
		return
	match _mode:
		"play": _attach(_client.join_or_create(P.ROOM_PLAY, join_opts))
		"create": _attach(_client.create(P.ROOM_MATCH, join_opts))
		"join_by_id": _attach(_client.join_by_id(str(opts.get("code", "")), join_opts))


func leave() -> void:
	_leaving = true
	if _queue_room != null:
		_queue_room.leave()
	if _room != null:
		_room.leave()
	elif _queue_room == null:
		_terminal(P.CLOSE_CONSENTED)


## The Colyseus addon polls the socket from its own `_ColyseusPoller` node; a paused tree must not
## stop the network, heartbeats or reconnection (§8, §16.2), so it always processes.
func _keep_polling_when_paused() -> void:
	var poller = C._poll_node
	if poller != null and is_instance_valid(poller):
		poller.process_mode = Node.PROCESS_MODE_ALWAYS


func _pick_url(opts: Dictionary) -> String:
	if opts.has("url"):
		return str(opts.url)
	var urls = opts.get("urls", [])
	# TODO(§3.1): measure latency to each regional relay and pick the lowest. The Godot binding
	# exposes no selectByLatency; until it does, the first URL is used.
	if urls is Array and urls.size() > 0:
		return str(urls[0])
	return ""


## Fresh join options for EVERY join, create, joinById and queue join (§3.2: never cache a token).
func _join_options() -> Dictionary:
	var token := ""
	var ident = _opts.get("identity")
	if ident is Callable and ident.is_valid():
		var r = await ident.call()
		if r is Dictionary:
			token = str(r.get("embedToken", r.get("embed_token", "")))
		elif r != null:
			token = str(r)
	elif _opts.has("embed_token"):
		token = str(_opts.embed_token)
	var o := {}
	var extra = _opts.get("options", {})
	if extra is Dictionary:
		for k in extra:
			if not SERVER_OWNED_OPTIONS.has(str(k)):
				o[str(k)] = Util.sanitize(extra[k])
	o["gameId"] = str(_opts.get("game_id", ""))
	o["embedToken"] = token
	var name := str(_opts.get("name", ""))
	if name != "":
		o["name"] = name.left(P.MAX_NAME_CHARS)
	o["protocol"] = P.PROTOCOL_VERSION
	return o


func _attach(room, from_seat := false) -> void:
	if room == null:
		if from_seat:
			_retry_search(0) # §9.2 step 2: a failed consume searches again with a fresh token
		else:
			_terminal(0, "genex: join could not start")
		return
	_room = room
	_from_seat = from_seat
	_joined = false
	_sid = ""
	room.set_state_type(Schema.RoomState)
	room.joined.connect(_on_joined.bind(room))
	room.state_changed.connect(_on_state_changed.bind(room))
	room.message_received.connect(_on_message.bind(room))
	room.error.connect(_on_error.bind(room))
	room.left.connect(_on_left.bind(room))
	room.dropped.connect(_on_dropped.bind(room))
	room.reconnected.connect(_on_reconnected.bind(room))


func _on_joined(room) -> void:
	if room != _room:
		return
	if _closed or _leaving:
		room.leave() # left while the join was in flight: never keep the seat
		return
	_sid = room.get_session_id()
	# §8 reconnection settings. Applied at `joined`: the binding resets options set before the
	# join completes (measured: set earlier, a drop at 1.5 s ends "Room uptime too short").
	room.set_reconnection_options(P.RECONNECTION)
	_req_prefix = "gd%08x" % (randi() & 0x7fffffff)
	_start_heartbeat()


func _on_error(code: int, message: String, room) -> void:
	if room != _room:
		return
	if code == P.JOIN_PROTOCOL_UNSUPPORTED:
		push_error("genex: the relay refused protocol %d (%s): this game needs an update" % [P.PROTOCOL_VERSION, message])
	if not _joined:
		_room = null
		_graveyard.append(room)
		if _seat_consume_failed(code):
			return
		_terminal(code, message)
	else:
		node.emit_signal("error", code, message)


## §9.2 step 2: a seat reservation that fails before the match room joins searches again,
## unless the refusal is one a new search cannot fix.
func _seat_consume_failed(code: int) -> bool:
	if not _from_seat or _leaving or _closed:
		return false
	_from_seat = false
	if code in [P.JOIN_BAD_OPTION, P.JOIN_AUTH_REQUIRED, P.JOIN_FORBIDDEN, P.JOIN_PROTOCOL_UNSUPPORTED]:
		return false
	_retry_search(code)
	return true


func _on_dropped(code: int, _reason: String, room) -> void:
	if room != _room or _closed:
		return
	_reconnecting = true
	_host_ready = false
	_awaiting_resync = false # a drop during the post-reconnect sequence abandons it (§8)
	if _drop_at == 0.0:
		_drop_at = now_ms()
	_stall_kicks = 0
	_stall_ref = now_ms()
	_attempt += 1
	node.emit_signal("reconnecting", _attempt, code)


func _on_reconnected(room) -> void:
	if room != _room or _closed:
		return
	if _leaving:
		room.leave()
		return
	# §8 step 2, done before the snapshot lands so its samples seed the rebased history.
	if now_ms() - _drop_at > P.REBASE_AFTER_GAP_MS:
		_interp.rebase()
		_smooth.clear()
	# §8 step 1: wait for the first full-state decode (at most 2 s), then finish.
	_awaiting_resync = true
	_resync_deadline = now_ms() + P.FIRST_STATE_TIMEOUT_MS


## Works around a Colyseus native SDK bug (godot-v0.18.5, still on upstream main): when the
## server side closes a reconnect attempt's socket during the WebSocket handshake (TCP accepted,
## then closed: a relay restarting, an edge refusing, the bench's `block`), the transport never
## reports the close. It keeps polling the dead socket ("Connection closed during WebSocket
## handshake" on stderr, about 150 times a second), and the SDK's retry worker waits for that
## attempt forever, so the room never reconnects and never gives up.
##
## The SDK schedules attempt k at delay(k) after the previous one ended (§8 ladder). Once an
## attempt has had HANDSHAKE_STALL_MS past its scheduled start and the socket is still not open,
## room.drop() ends it: the SDK counts it as a failed attempt and runs the next one on its own
## ladder, inside the same retry budget (it still gives up with 4003). Never while the socket is
## open: a socket closed between open and the relay's join acknowledgement loses the seat (§8).
## A healthy failure (refused, reset) ends on its own, so a drop() then lands between attempts,
## where it does nothing.
const HANDSHAKE_STALL_MS := 1000.0

func _unstick_reconnect(now: float) -> void:
	if _room == null or _room.connected:
		return
	var k := _stall_kicks + 1
	var delay := clampf(float(P.RECONNECTION.delay_ms) * pow(2.0, mini(k, 30)), float(P.RECONNECTION.min_delay_ms), float(P.RECONNECTION.max_delay_ms))
	if now < _stall_ref + delay + HANDSHAKE_STALL_MS:
		return
	_stall_kicks = k
	_stall_ref = now
	_room.drop()


func _finish_resync() -> void:
	_awaiting_resync = false
	# step 3 is the state diff itself: it prunes players/objects removed while offline.
	# step 4: resend every pending control with its original requestId; re-request chat.
	for req in _pending.values():
		_send_raw(_control_message(req.operation), req.payload)
	_send_raw(P.MSG_CHAT_HISTORY_REQUEST, {})
	# step 5 + 6
	_reconnecting = false
	_host_ready = true
	_drop_at = 0.0
	_attempt = 0
	node.emit_signal("reconnected")
	if is_host():
		node.emit_signal("host_changed", _host)


func _on_left(code: int, reason: String, room) -> void:
	if room != _room:
		return
	_room = null
	_graveyard.append(room)
	if _requeuing:
		_requeuing = false
		_reset_room_state()
		_search()
		return
	if not _joined and _seat_consume_failed(code):
		return
	_terminal(code, reason)


func _terminal(code: int, message := "") -> void:
	if _closed and code != 0:
		return
	var was_joined := _joined
	_closed = true
	_joined = false
	_reconnecting = false
	_host_ready = false
	_awaiting_resync = false
	_stop_heartbeat()
	for req in _pending.values():
		req.settle(_local_result(req, "disconnected"))
	_pending.clear()
	if not was_joined and message != "" and code != P.CLOSE_CONSENTED:
		node.emit_signal("error", code, message)
	node.emit_signal("disconnected", code)


## A §9.2 requeue: the old match room is gone, and the next one starts from nothing.
func _reset_room_state() -> void:
	_joined = false
	_from_seat = false
	_reconnecting = false
	_host_ready = false
	_awaiting_resync = false
	_drop_at = 0.0
	_attempt = 0
	_clock_synced = false # the next room's input handle acks from zero
	# Settle the old room's requests: they must never be resent into the next room.
	var pending := _pending.values()
	_pending.clear()
	for req in pending:
		_revert_optimistic(req, null)
		req.settle(_local_result(req, "disconnected"))
	# Tell a signal-driven game the old room's players and objects are gone.
	var events: Array = []
	for id in _objects.keys():
		events.append(["object_removed", id])
	for sid in _players.keys():
		events.append(["player_left", sid])
	var had_host := _host != ""
	_players.clear()
	_objects.clear()
	_view_owner.clear()
	_shared.clear()
	_shared_text.clear()
	_local_objects.clear()
	_smooth.clear()
	_interp = Interp.new()
	_host = ""
	_match = {}
	_match_text = ""
	# Chat ids are monotonic per room (§12): the next room's ids restart and must not dedupe.
	_chat.clear()
	_chat_ids.clear()
	# The next room has no copy of my data: the first publish there must carry it.
	_last_data_text = ""
	_pose_mem = {}
	if had_host:
		events.append(["host_changed", ""])
	for e in events:
		node.callv("emit_signal", e)


# =============================================================================
# Matchmaking (§9.2)
# =============================================================================

func _search() -> void:
	if _closed or _leaving:
		return
	var join_opts: Dictionary = await _join_options()
	if _closed or _leaving:
		return
	var q = _client.join_or_create(P.ROOM_QUEUE, join_opts)
	if q == null:
		_terminal(0, "genex: queue join could not start")
		return
	_queue_room = q
	q.joined.connect(_on_queue_joined.bind(q))
	q.message_received.connect(_on_queue_message.bind(q))
	q.left.connect(_on_queue_left.bind(q))
	q.error.connect(_on_queue_error.bind(q))
	q.dropped.connect(_on_queue_dropped.bind(q))


func _on_queue_joined(q) -> void:
	if q != _queue_room:
		return
	if _closed or _leaving:
		q.leave()
		return
	# The queue holds no seat (§8): no auto-reconnect. Set at `joined`, because the binding
	# resets reconnection options set before the join completes (see _on_joined).
	q.set_reconnection_options({"enabled": false})


## §9.2 step 3: a queue drop searches again promptly with backoff, not through the SDK's
## reconnection ladder.
func _on_queue_dropped(code: int, _reason: String, q) -> void:
	if q != _queue_room:
		return
	_queue_room = null
	_graveyard.append(q)
	q.leave()
	if _leaving:
		_terminal(code)
		return
	_retry_search(code)


func _on_queue_message(type, raw_data, q) -> void:
	if q != _queue_room:
		return
	var data = Util.strip_undefined(raw_data)
	if type == P.SRV_QUEUE and data is Dictionary:
		node.emit_signal("queue_update", int(data.get("position", 0)), int(data.get("size", 0)))
	elif type == P.SRV_SEAT and data is Dictionary and data.has("reservation"):
		_queue_room = null
		_graveyard.append(q)
		q.leave()
		_queue_attempts = 0
		_attach(_client.consume_seat_reservation(data.reservation), true)


func _on_queue_left(code: int, _reason: String, q) -> void:
	if q != _queue_room:
		return
	_queue_room = null
	_graveyard.append(q)
	if _leaving:
		_terminal(code)
		return
	_retry_search(code)


func _on_queue_error(code: int, message: String, q) -> void:
	if q != _queue_room:
		return
	_queue_room = null
	_graveyard.append(q)
	if code in [P.JOIN_BAD_OPTION, P.JOIN_AUTH_REQUIRED, P.JOIN_FORBIDDEN, P.JOIN_PROTOCOL_UNSUPPORTED]:
		_terminal(code, message)
	else:
		_retry_search(code)


func _retry_search(code: int) -> void:
	_queue_attempts += 1
	if _queue_attempts > QUEUE_RETRY_MAX:
		_terminal(code, "genex: matchmaking queue unavailable")
		return
	var wait := minf(4.0, 0.25 * pow(2.0, _queue_attempts - 1))
	await node.get_tree().create_timer(wait).timeout
	_search()


# =============================================================================
# State diff (runs once per decoded patch, after the whole patch is applied)
# =============================================================================

func _on_state_changed(room) -> void:
	if room != _room:
		return
	var s = room.state
	if s == null:
		return
	var now := now_ms()
	var events: Array = []
	_diff_players(s, now, events)
	_diff_objects(s, now, events)
	_diff_shared(s, events)
	var host := str(s.host)
	if host != _host:
		_host = host
		events.append(["host_changed", host])
	var match_text := str(s.match)
	if match_text != _match_text:
		_match_text = match_text
		_match = Util.parse_object(match_text)
		events.append(["match_state_changed", _match])
	_clock_origin = float(s.clockOrigin)

	var first := not _joined
	if first:
		_joined = true
		_from_seat = false
		_host_ready = true
	for e in events:
		node.callv("emit_signal", e)
	if first:
		_send_raw(P.MSG_CHAT_HISTORY_REQUEST, {}) # §12: after the listener exists
		node.emit_signal("connected", _sid)
	elif _awaiting_resync:
		_finish_resync()


func _diff_players(s, now: float, events: Array) -> void:
	var seen := {}
	for sid in s.players:
		var p = s.players[sid]
		seen[sid] = true
		var m = _players.get(sid)
		var fresh: bool = m == null
		if fresh:
			m = {"data_text": "", "data": {}, "epoch": float(p.epoch), "posed": false, "pose_t": 0.0, "pose": {}, "connected": bool(p.connected)}
			_players[sid] = m
		m.name = str(p.name)
		m.uid = str(p.uid)
		m.team = int(p.team)
		m.avatar_url = str(p.avatarUrl)
		var key: String = "p:" + sid
		var remote: bool = sid != _sid
		var conn_changed: bool = (not fresh) and bool(p.connected) != m.connected
		m.connected = bool(p.connected)
		var epoch_changed: bool = (not fresh) and float(p.epoch) != m.epoch
		m.epoch = float(p.epoch)
		var posed := bool(p.posed)
		if posed and not m.posed:
			m.posed = true
			_interp.clear(key) # the stream switches to the §10.1 pose
		# data
		var data_changed: bool = str(p.data) != m.data_text
		var data_stamp := 0.0
		if data_changed:
			m.data_text = str(p.data)
			var parsed := Util.parse_object(m.data_text)
			var st = parsed.get(P.SEND_TIME_KEY)
			if Interp._is_num(st):
				data_stamp = float(st)
			parsed.erase(P.SEND_TIME_KEY)
			m.data = parsed
		# pose (§6.6): a sample is a change in which poseT changed and is nonzero
		var pose_sample := false
		if posed:
			var pose_t := float(p.poseT)
			if pose_t != m.pose_t or fresh or epoch_changed:
				m.pose = {"x": float(p.x), "y": float(p.y), "z": float(p.z), "yaw": float(p.yaw),
					"vx": float(p.vx), "vy": float(p.vy), "vz": float(p.vz), "anim": str(p.anim)}
				pose_sample = pose_t != m.pose_t and pose_t != 0.0
				m.pose_t = pose_t
		if remote:
			if epoch_changed:
				_interp.reseed(key, (m.pose if posed else m.data).duplicate(), now)
				_smooth.erase(key)
			if posed:
				if pose_sample:
					_interp.push(key, sid, m.pose_t, m.pose.duplicate(), now, true)
			elif data_changed and data_stamp != 0.0:
				_interp.push(key, sid, data_stamp, m.data.duplicate(), now)
		if fresh:
			events.append(["player_joined", sid, _raw_state(m)])
		else:
			if data_changed or pose_sample:
				events.append(["player_changed", sid, _raw_state(m)])
			if conn_changed:
				events.append(["player_connection_changed", sid, m.connected])
	for sid in _players.keys():
		if not seen.has(sid):
			_players.erase(sid)
			_interp.clear("p:" + sid)
			_interp.drop_sender(sid)
			_smooth.erase("p:" + sid)
			events.append(["player_left", sid])


func _diff_objects(s, now: float, events: Array) -> void:
	var seen := {}
	for id in s.objects:
		var o = s.objects[id]
		seen[id] = true
		var owner := str(o.owner)
		var seq := float(o.seq)
		var epoch := float(o.epoch)
		var t := float(o.t)
		var d_text := str(o.d)
		var m = _objects.get(id)
		var known: bool = m != null
		if not known:
			m = {"owner": owner, "seq": seq, "epoch": epoch, "t": 0.0, "d_text": "", "raw": {}}
			_objects[id] = m
		var handoff: bool = known and seq != m.seq
		var epoch_changed: bool = known and epoch != m.epoch
		var stamp_changed: bool = t != m.t
		if d_text != m.d_text:
			m.d_text = d_text
			m.raw = Util.parse_object(d_text)
		m.owner = owner
		m.seq = seq
		m.epoch = epoch
		m.t = t
		if not known or handoff:
			if not _has_pending_claim(id):
				_view_owner[id] = owner
		if _view_owner.get(id, owner) != _sid:
			# My last publish belongs to a previous tenure: never read back as the state on a reclaim.
			_local_objects.erase(id)
		var key: String = "o:" + id
		# §7.3 rules, in order: handoff, epoch, sample, unstamped resting pose.
		var sample: bool = t != 0.0 and stamp_changed and owner != ""
		if owner != _sid:
			if epoch_changed:
				_interp.reseed(key, m.raw.duplicate(), now)
				_smooth.erase(key)
			elif handoff:
				_interp.soft_handoff(key, m.raw.duplicate())
			if sample:
				_interp.push(key, owner, t, m.raw.duplicate(), now)
		if not known or handoff or epoch_changed:
			events.append(["object_changed", id, _view_owner.get(id, owner)])
	for id in _objects.keys():
		if not seen.has(id):
			_objects.erase(id)
			_view_owner.erase(id)
			_local_objects.erase(id)
			_interp.clear("o:" + id)
			_smooth.erase("o:" + id)
			events.append(["object_removed", id])


func _diff_shared(s, events: Array) -> void:
	for k in s.shared:
		var text := str(s.shared[k])
		if _shared_text.get(k) != text:
			_shared_text[k] = text
			var json := JSON.new()
			_shared[k] = json.data if json.parse(text) == OK else null
			events.append(["shared_changed", k, _shared[k]])


# =============================================================================
# Frame update
# =============================================================================

func process(_delta: float) -> void:
	if not _graveyard.is_empty():
		_graveyard.clear()
	var now := now_ms()
	if _awaiting_resync and now > _resync_deadline:
		_finish_resync()
	if _reconnecting and not _awaiting_resync:
		_unstick_reconnect(now)
	# control-request timeouts (§7.2)
	if not _pending.is_empty():
		for rid in _pending.keys():
			var req = _pending[rid]
			if now > req.deadline_ms:
				_pending.erase(rid)
				_revert_optimistic(req, null)
				req.settle(_local_result(req, "timeout"))
	# smoothing (§10): remote players and remote-owned objects
	for sid in _players:
		if sid == _sid:
			continue
		var key: String = "p:" + sid
		var out = _interp.sample(key, now)
		if out != null:
			_smooth[key] = out
	for id in _objects:
		var key: String = "o:" + id
		if _view_owner.get(id, "") == _sid and _local_objects.has(id):
			# keep the on-screen pose current so a later handoff glides from it (§10 step 6)
			_interp.reseed(key, _local_objects[id], now)
			_smooth.erase(key)
			continue
		var out = _interp.sample(key, now)
		if out != null:
			_smooth[key] = out


# =============================================================================
# Reads
# =============================================================================

func session_id() -> String:
	return _sid


func host_id() -> String:
	return _host


## True only while `host` is this session AND the post-reconnect sequence has completed (§6.3).
func is_host() -> bool:
	return _joined and _host != "" and _host == _sid and _host_ready and not _reconnecting


func is_joined() -> bool:
	return _joined and not _closed


func is_reconnecting() -> bool:
	return _reconnecting


func players() -> Dictionary:
	var out := {}
	for sid in _players:
		out[sid] = _player_view(sid)
	return out


func get_player(id: String):
	return _player_view(id) if _players.has(id) else null


func _raw_state(m: Dictionary) -> Dictionary:
	var raw: Dictionary = m.data.duplicate()
	if m.posed:
		raw.merge(m.pose, true)
	return raw


func _player_view(sid: String) -> Dictionary:
	var m: Dictionary = _players[sid]
	var raw := _raw_state(m)
	var state: Dictionary
	if sid == _sid:
		state = _local_state.duplicate(true) if _local_state != null else raw
	else:
		var sm = _smooth.get("p:" + sid)
		if sm == null:
			state = raw
		elif m.posed:
			state = m.data.duplicate()
			state.merge(sm, true)
		else:
			state = sm.duplicate()
	return {
		"id": sid, "name": m.name, "uid": m.uid, "team": m.team, "connected": m.connected,
		"avatar_url": m.avatar_url, "is_me": sid == _sid, "posed": m.posed,
		"state": state, "state_raw": raw,
	}


func shared_get(key: String, default = null):
	return _shared.get(key, default)


func shared_keys() -> Array:
	return _shared.keys()


func get_object(id: String):
	var m = _objects.get(id)
	if m == null:
		return null
	var owner: String = _view_owner.get(id, m.owner)
	var mine := owner == _sid and _sid != ""
	var state: Dictionary
	if mine and _local_objects.has(id):
		state = _local_objects[id].duplicate(true)
	else:
		var sm = _smooth.get("o:" + id)
		state = sm.duplicate() if sm != null else m.raw.duplicate()
	return {"id": id, "owner": owner, "confirmed_owner": m.owner, "is_mine": mine,
		"seq": int(m.seq), "epoch": int(m.epoch), "state": state, "state_raw": m.raw.duplicate()}


func object_ids() -> Array:
	return _objects.keys()


func match_state() -> Dictionary:
	return _match


func chat_history() -> Array:
	return _chat.duplicate()


func stats() -> Dictionary:
	return {"dropped_sends": _dropped_sends, "pending_requests": _pending.size(),
		"clock": clock_enabled(), "clock_synced": _clock_synced}


# =============================================================================
# Writes
# =============================================================================

## Messages go out only on an open, settled socket; anything else is dropped and counted (§8).
func _send(type: String, payload) -> bool:
	if _room == null or _closed or not _joined or _reconnecting or not _room.connected:
		_dropped_sends += 1
		return false
	_room.send_message(type, payload)
	return true


func _send_raw(type: String, payload) -> bool:
	if _room == null or not _room.connected:
		return false
	_room.send_message(type, payload)
	return true


func set_me(state: Dictionary, snap := false) -> bool:
	var clean: Dictionary = Util.sanitize(state)
	if clean.has(P.SEND_TIME_KEY):
		_warn_once("__t", "genex: '__t' is reserved for the send clock and was removed from set_me()")
		clean.erase(P.SEND_TIME_KEY)
	_local_state = clean.duplicate(true)
	var now := now_ms()
	if _pose_mode:
		return _publish_pose(clean, snap, now)
	var data := clean.duplicate()
	data[P.SEND_TIME_KEY] = now
	var text := JSON.stringify(data, "", false, true)
	if text.to_utf8_buffer().size() > P.MAX_STATE_BYTES:
		_warn_once("state-size", "genex: set_me() state is over 16 KiB and was not sent")
		return false
	return _send(P.MSG_STATE_SNAP if snap else P.MSG_STATE, text)


func _publish_pose(clean: Dictionary, snap: bool, now: float) -> bool:
	var pose := {}
	var data := {}
	for k in clean:
		var v = clean[k]
		if not P.POSE_KEYS.has(k):
			data[k] = v
		elif k == "anim":
			if v is String and v.length() <= P.MAX_ANIM_CHARS:
				pose[k] = v
		elif Interp._is_num(v) and absf(float(v)) <= P.MAX_POSE_ABS:
			pose[k] = float(v)
	# §6.6: derive velocity from successive poses when the game does not supply it.
	var dt := now - float(_pose_mem.get("t", 0.0))
	var usable: bool = _pose_mem.has("t") and dt > P.MIN_GAP_MS and dt < P.MAX_GAP_MS
	var mem := {"t": now}
	for axis in [["x", "vx"], ["y", "vy"], ["z", "vz"]]:
		if not pose.has(axis[0]):
			continue
		mem[axis[0]] = pose[axis[0]]
		if pose.has(axis[1]):
			continue
		var v := 0.0
		if usable and _pose_mem.has(axis[0]):
			v = (pose[axis[0]] - float(_pose_mem[axis[0]])) / dt * 1000.0
		pose[axis[1]] = v if absf(v) <= P.MAX_POSE_ABS else 0.0
	_pose_mem = mem
	pose["t"] = now
	var ok := _send(P.MSG_POSE_SNAP if snap else P.MSG_POSE, pose)
	var data_text := JSON.stringify(data, "", true, true)
	if data_text != _last_data_text or snap:
		_last_data_text = data_text
		data[P.SEND_TIME_KEY] = now
		_send(P.MSG_STATE, JSON.stringify(data, "", false, true))
	return ok


func shared_set(key: String, value) -> bool:
	if key == "" or key.length() > P.MAX_SHARED_KEY_CHARS or key.begins_with(P.RESERVED_SHARED_PREFIX):
		_warn_once("shared-key:" + key, "genex: invalid shared key '%s' (1..256 chars, no '__' prefix)" % key)
		return false
	var clean = Util.sanitize(value)
	var text := JSON.stringify(clean, "", false, true)
	if text.to_utf8_buffer().size() > P.MAX_SHARED_VALUE_BYTES:
		_warn_once("shared-size:" + key, "genex: shared value for '%s' is over 64 KiB" % key)
		return false
	if not _send(P.MSG_SHARED, {"key": key, "value": text}):
		return false
	_shared_text[key] = text
	_shared[key] = clean
	node.emit_signal.call_deferred("shared_changed", key, clean)
	return true


func claim(id: String, host_authority := false) -> Req:
	var payload := {"id": id}
	if host_authority:
		payload["authority"] = "host"
	return _control("claim", id, payload)


func release(id: String) -> Req:
	return _control("release", id, {"id": id})


func destroy(id: String) -> Req:
	return _control("remove", id, {"id": id})


func _control_message(operation: String) -> String:
	match operation:
		"claim": return P.MSG_CLAIM
		"release": return P.MSG_RELEASE
	return P.MSG_DESTROY


func _control(operation: String, id: String, payload: Dictionary) -> Req:
	var req := Req.new()
	req.operation = operation
	req.object_id = id
	_req_counter += 1
	req.request_id = "%s-%d" % [_req_prefix if _req_prefix != "" else "gd", _req_counter]
	payload["requestId"] = req.request_id
	req.payload = payload
	var timeout := clampf(float(_opts.get("control_timeout_ms", P.CONTROL_TIMEOUT_MS)), 1.0, P.CONTROL_TIMEOUT_MAX_MS)
	req.deadline_ms = now_ms() + timeout
	if _closed or not _joined:
		req.settle.call_deferred(_local_result(req, "disconnected"))
		return req
	if operation == "claim":
		req.optimistic = true
		_view_owner[id] = _sid # §7.2: optimistic, reverted on rejection
	_pending[req.request_id] = req
	_send(_control_message(operation), payload) # if the socket is down it is resent after reconnect
	return req


func _has_pending_claim(id: String) -> bool:
	for req in _pending.values():
		if req.operation == "claim" and req.object_id == id:
			return true
	return false


func _revert_optimistic(req: Req, owner) -> void:
	if not req.optimistic:
		return
	var m = _objects.get(req.object_id)
	if owner is String:
		_view_owner[req.object_id] = owner
	elif m != null:
		_view_owner[req.object_id] = m.owner
	else:
		_view_owner.erase(req.object_id)
	if _view_owner.get(req.object_id, "") != _sid:
		_local_objects.erase(req.object_id)


func _local_result(req: Req, reason: String) -> Dictionary:
	return {"requestId": req.request_id, "operation": req.operation, "id": req.object_id,
		"accepted": false, "sequence": 0, "reason": reason}


func _on_object_result(data: Dictionary) -> void:
	var rid := str(data.get("requestId", ""))
	var req = _pending.get(rid)
	if req == null:
		return
	_pending.erase(rid)
	var r := {
		"requestId": rid,
		"operation": str(data.get("operation", req.operation)),
		"id": str(data.get("id", req.object_id)),
		"accepted": data.get("accepted") == true,
		"sequence": int(data.get("sequence", 0)) if Interp._is_num(data.get("sequence")) else 0,
		"reason": str(data.get("reason", "")),
	}
	# Optional keys: anything that is not the right type (msgpack ext 0 = undefined) is absent.
	if data.get("owner") is String:
		r["owner"] = data.owner
	if Interp._is_num(data.get("retryAfterMs")):
		r["retryAfterMs"] = float(data.retryAfterMs)
	var id: String = req.object_id
	if r.accepted:
		match req.operation:
			"claim": _view_owner[id] = _sid
			"release":
				_view_owner[id] = ""
				_local_objects.erase(id)
			"remove":
				_view_owner.erase(id)
				_local_objects.erase(id)
	else:
		_revert_optimistic(req, r.get("owner"))
	req.settle(r)


func object_set(id: String, d: Dictionary, snap := false) -> bool:
	if _view_owner.get(id, "") != _sid or _sid == "":
		_warn_once("unowned:" + id, "genex: object_set('%s') ignored: this session does not own it (await claim(id).done first)" % id)
		return false
	var clean: Dictionary = Util.sanitize(d)
	if JSON.stringify(clean).to_utf8_buffer().size() > P.MAX_OBJECT_STATE_BYTES:
		_warn_once("obj-size:" + id, "genex: object '%s' state is over 64 KiB" % id)
		return false
	_local_objects[id] = clean.duplicate(true)
	return _send(P.MSG_OBJECT_SNAP if snap else P.MSG_OBJECT, {"id": id, "d": clean, "t": now_ms()})


func send(type: String, data = null) -> bool:
	if type.length() < 1 or type.length() > P.MAX_EVENT_TYPE_CHARS or P.is_reserved_event_type(type):
		_warn_once("event:" + type, "genex: '%s' is not a valid game event type (reserved or wrong length)" % type)
		return false
	var clean = Util.sanitize(data)
	if JSON.stringify(clean).to_utf8_buffer().size() > P.MAX_EVENT_BYTES:
		_warn_once("event-size:" + type, "genex: event '%s' is over 16 KiB" % type)
		return false
	return _send(type, clean)


func send_input(data) -> bool:
	var clean = Util.sanitize(data)
	if JSON.stringify(clean).to_utf8_buffer().size() > P.MAX_EVENT_BYTES:
		return false
	return _send(P.MSG_INPUT, clean)


func chat_send(text: String) -> bool:
	if text.strip_edges() == "":
		return false
	return _send(P.MSG_CHAT, {"text": text})


func set_room_open(open: bool) -> bool:
	if not is_host():
		return false
	return _send(P.MSG_ROOM_OPEN, {"open": open})


func report_eliminated() -> bool:
	return _send(P.MSG_MATCH_ELIMINATED, {})


func report_score(delta := 1.0) -> bool:
	return _send(P.MSG_MATCH_SCORE, {"delta": clampf(delta, -1000.0, 1000.0)})


func report_finish() -> bool:
	return _send(P.MSG_MATCH_FINISH, {})


# =============================================================================
# Inbound messages
# =============================================================================

func _on_message(type, raw_data, room) -> void:
	if room != _room or typeof(type) != TYPE_STRING:
		return
	var data = Util.strip_undefined(raw_data)
	match type:
		P.SRV_OBJECT_RESULT:
			if data is Dictionary:
				_on_object_result(data)
		P.SRV_CHAT:
			if data is Dictionary:
				_merge_chat(data, true)
		P.SRV_CHAT_HISTORY:
			if data is Dictionary and data.get("messages") is Array:
				for msg in data.messages:
					if msg is Dictionary:
						_merge_chat(msg, true)
		P.SRV_INPUT:
			if data is Dictionary and is_host():
				node.emit_signal("input_received", str(data.get("from", "")), data.get("d"))
		P.SRV_ROOM_OPEN:
			if data is Dictionary:
				node.emit_signal("room_open_changed", data.get("open") == true)
		P.SRV_RATE_DROP:
			var dropped := int(data.get("dropped", 0)) if data is Dictionary and Interp._is_num(data.get("dropped")) else 0
			node.emit_signal("rate_dropped", dropped)
			if now_ms() - _last_rate_warn > 10000.0:
				_last_rate_warn = now_ms()
				push_warning("genex: the relay dropped %d message(s) over budget; publish less often (idle objects <= 2 Hz)" % dropped)
		P.SRV_SERVER_RESTART:
			node.emit_signal("server_restart")
		P.SRV_MATCH_START:
			node.emit_signal("match_started", int(data.get("roundId", 0)) if data is Dictionary and Interp._is_num(data.get("roundId")) else 0)
		P.SRV_MATCH_ENDED:
			node.emit_signal("match_ended", data if data is Dictionary else {})
		P.SRV_MATCH_REQUEUE:
			var reason := str(data.get("reason", "")) if data is Dictionary and data.get("reason") is String else ""
			node.emit_signal("match_requeued", reason)
			if _mode == "matchmake" and _room != null:
				# §9.2 step 4: leave with consent and search again within 5 s.
				_requeuing = true
				_room.leave()
		_:
			if not P.is_reserved_event_type(type):
				node.emit_signal("message", type, data)


func _merge_chat(msg: Dictionary, emit: bool) -> void:
	if not Interp._is_num(msg.get("id")):
		return
	var id := int(msg.id)
	if _chat_ids.has(id):
		return
	var clean := {"id": id, "from": str(msg.get("from", "")), "name": str(msg.get("name", "")),
		"text": str(msg.get("text", "")), "at": float(msg.get("at", 0.0)) if Interp._is_num(msg.get("at")) else 0.0}
	_chat_ids[id] = true
	var i := _chat.size()
	while i > 0 and _chat[i - 1].id > id:
		i -= 1
	_chat.insert(i, clean)
	while _chat.size() > 200:
		_chat_ids.erase(_chat[0].id)
		_chat.pop_front()
	if emit:
		node.emit_signal("chat", clean)


# =============================================================================
# Server clock (§16)
# =============================================================================

## The relay publishes its clock when the handshake declared an input (INPUT_REFLECTION).
func clock_enabled() -> bool:
	return _room != null and _joined and _room.input() != null


func server_now() -> float:
	return _room.clock.server_now() if clock_enabled() else NAN


func rtt() -> float:
	return _room.clock.smoothed_rtt() if clock_enabled() else NAN


func clock_synced() -> bool:
	return _clock_synced


func clock_origin() -> float:
	return _clock_origin


## Milliseconds until a relay epoch-ms deadline (match startsAt/endsBy), §16.3.
func time_until_ms(deadline_epoch_ms: float) -> float:
	if _clock_synced and _clock_origin != 0.0 and clock_enabled():
		return (deadline_epoch_ms - _clock_origin) - server_now()
	return deadline_epoch_ms - Time.get_unix_time_from_system() * 1000.0


func _start_heartbeat() -> void:
	if _hb_timer == null:
		_hb_timer = Timer.new()
		_hb_timer.one_shot = true
		_hb_timer.process_mode = Node.PROCESS_MODE_ALWAYS # §16.2: beats run from join to leave, paused or not
		_hb_timer.timeout.connect(_on_heartbeat)
		node.add_child(_hb_timer)
	_schedule_heartbeat()


func _stop_heartbeat() -> void:
	if _hb_timer != null:
		_hb_timer.stop()


func _schedule_heartbeat() -> void:
	if _hb_timer == null or not _hb_timer.is_inside_tree():
		return
	# 10 Hz, dithered by up to ±15% so the beat never phase-locks to the patch tick (§16.2).
	var base := 1.0 / P.HEARTBEAT_HZ
	var wait := base * (1.0 + randf_range(-P.HEARTBEAT_DITHER, P.HEARTBEAT_DITHER))
	_hb_timer.start(clampf(wait, 1.0 / P.MAX_HEARTBEAT_HZ, 1.0 / P.MIN_HEARTBEAT_HZ))


func _on_heartbeat() -> void:
	if _closed:
		return
	if _room != null and _joined and not _reconnecting and _room.connected:
		var h = _room.input()
		if h != null: # no INPUT_REFLECTION = no clock = MUST NOT send heartbeats
			h.send()
			if not _clock_synced and h.last_processed >= P.WARMUP_ACKS:
				_clock_synced = true
	_schedule_heartbeat()


func _warn_once(key: String, text: String) -> void:
	if _warned.has(key):
		return
	_warned[key] = true
	push_warning(text)
