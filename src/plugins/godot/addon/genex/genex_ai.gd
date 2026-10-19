# Genex play-time AI for a Godot game (docs/play-protocol.md in Genex, "Play-time AI"): the game asks
# a model for text, or for JSON that fits a schema, and Genex answers on the model the person chose.
# Use it as an autoload named GenexAI (project.godot, [autoload]:
# GenexAI="*res://addons/genex/genex_ai.gd"). A game that cannot run without AI sets the project
# setting genex/ai/requires to "ai"; "optional" (works without AI) is the default.
#
# A call answers its ticket at once. Its result enters the game only through drain(), called once at
# the top of _physics_process: {ticket, site, ok, value, code, source, provenance, fallback}. A
# failure carries ok false, its code, and as value the fallback the call named (fallback true), or
# null. Answers are data: clamp them before they change the world. Never put player-typed text in a
# prompt: pass it in options.untrusted, which every model sees fenced as player text.
#
# Genex answers through its Play Protocol when it started the game (GenexPlay, `--play-protocol`),
# so a replayed run gets every answer on the same tick; through the project's .godot/genex/ folder
# while the game plays in an editor Genex relays for; and nowhere else: a build shipped outside
# Genex answers ai_off at once and plays its fallbacks.
extends Node

const WIRE := 1
const PLAY_NODE := "/root/GenexPlay"
const RELAY_FOLDER := "res://.godot/genex"
const RELAY_BEAT := "ai-relay.json"
const IN_PREFIX := "ai-in-"
const OUT_PREFIX := "ai-out-"
const JSON_SUFFIX := ".json"
const PARTIAL_SUFFIX := ".partial"
const RELAY_FRESH_MS := 3000
const READ_EVERY_S := 0.05
const MAX_IN_FLIGHT := 4
const MAX_ECHO := 64
const NO_GRANT := "no-grant"
const DEFAULT_OUTPUT_TOKENS := 512
const SETTING_REQUIRES := "genex/ai/requires"
const REQUIRES := ["ai", "optional"]
const TIERS := ["fast", "smart"]
const AUTHORITIES := ["local", "shared"]
const OP_REPLY := "ai.reply"
const OP_DELTA := "ai.delta"
const TRANSPORT_PROTOCOL := "protocol"
const TRANSPORT_EDITOR := "editor"
const TRANSPORT_OFF := "off"
const CODE_OFF := "ai_off"
const CODE_CONCURRENCY := "grant_concurrency"
const CODE_BAD_REQUEST := "bad_request"
const CODE_PROVIDER := "provider"
const OP_CALL := "call"
const KIND_CALL := "call"
const KIND_HELLO := "hello"
const KIND_GRANT := "grant"
const KIND_OTHER := "other"

## Emitted when the game's AI turns on or off, or its grant changes.
signal changed

var _transport := ""
var _rids := 0
var _tickets := 0
var _pending := {}
var _partials := {}
var _arrived: Array[Dictionary] = []
var _on := false
var _grant = null
var _asked: Array[String] = []
var _answered: Array[String] = []
var _since_read := 0.0
var _folder := ""


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	_folder = ProjectSettings.globalize_path(RELAY_FOLDER)


func _process(delta: float) -> void:
	if _transport != TRANSPORT_EDITOR or _pending.is_empty():
		return
	_since_read += delta
	if _since_read < READ_EVERY_S:
		return
	_since_read = 0.0
	_read_relay()


# --- What a game calls ---

## Whether the game requires AI ("ai") or works without it ("optional"), from genex/ai/requires.
func requires() -> String:
	var said := str(ProjectSettings.get_setting(SETTING_REQUIRES, "optional"))
	return said if said in REQUIRES else "optional"


## JSON that fits `schema` (the closed dialect: every object lists additionalProperties false and
## requires every property). options: system, untrusted, memory, tier, authority, max_output_tokens,
## fallback. Answers the call's ticket.
func ask(site: String, prompt: String, schema: Dictionary, options := {}) -> String:
	return _call("ask", site, prompt, schema, options)


## Free text, streamed: partial(ticket) holds what has arrived so far.
func say(site: String, prompt: String, options := {}) -> String:
	return _call("say", site, prompt, null, options)


## A classification of a state against fixed questions, as JSON that fits `schema`.
func judge(site: String, prompt: String, schema: Dictionary, options := {}) -> String:
	return _call("judge", site, prompt, schema, options)


## One tool of a fixed set picked, as JSON that fits `schema`.
func act(site: String, prompt: String, schema: Dictionary, options := {}) -> String:
	return _call("act", site, prompt, schema, options)


## Stop waiting for a call; its result still arrives once, as `canceled` or the answer it had.
func cancel(ticket: String) -> void:
	_send("cancel", {"ticket": ticket}, {"kind": KIND_OTHER})


## The results that arrived since the last drain, oldest first. Call it once per physics tick.
func drain() -> Array[Dictionary]:
	var out := _arrived
	_arrived = []
	return out


## A streamed say's text so far; empty before any arrives and once its result did.
func partial(ticket: String) -> String:
	return str(_partials.get(ticket, ""))


## Start AI for this game: Genex picks the model and asks the person only before their plan or their
## credits are used. Call it from a player's action. `changed` fires when the answer arrives.
func start(tiers := ["fast"]) -> void:
	var asked: Array[String] = []
	for tier in tiers:
		if tier in TIERS and not (tier in asked):
			asked.append(tier)
	if asked.is_empty():
		asked.append("fast")
	_send("budget.request", {"v": WIRE, "requires": requires(), "tiers": asked}, {"kind": KIND_GRANT})


## The game turns its own AI off.
func stop() -> void:
	_send("budget.stop", null, {"kind": KIND_OTHER})
	_grant = null
	changed.emit()


## Whether Genex said AI runs for this game here (after the first call, or start()).
func is_on() -> bool:
	return _on


## The grant the game holds, as the game may see it ({id, status, door, …}), or null.
func grant():
	return _grant


## Where the game's AI stands, for a HUD or the game's state.
func status() -> Dictionary:
	return {"transport": _transport_now(), "on": _on, "inFlight": _pending.size(), "requires": requires()}


# --- What GenexPlay hands over (the Play Protocol lane) ---

## The rids this run sent and those answered, newest last; rids are not part of a replay.
func echo() -> Dictionary:
	return {"asked": _asked.duplicate(), "answered": _answered.duplicate()}


## The studio reset the game: every line of the run before is forgotten, so a late answer to one is
## ignored and the new run starts with nothing waiting.
func forget_run() -> void:
	_pending.clear()
	_partials.clear()
	_arrived.clear()
	_asked.clear()
	_answered.clear()


## One of the studio's AI ops: an answer by its rid, or a streamed answer's text so far. True when
## it answered a line still waiting; a late or unknown one is taken and ignored.
func take_studio_op(op: String, args: Dictionary) -> bool:
	var rid = args.get("rid")
	if typeof(rid) != TYPE_STRING or not _pending.has(rid):
		return false
	if op == OP_DELTA:
		return _take_delta(rid, args.get("text"))
	if op == OP_REPLY:
		_take_reply(rid, args.get("reply"))
		return true
	return false


# --- Sending ---

func _call(op: String, site: String, prompt: String, schema, options: Dictionary) -> String:
	_tickets += 1
	var ticket := "gdtk-%08d" % _tickets
	var entry := {
		"kind": KIND_CALL, "ticket": ticket, "site": site,
		"has_fallback": options.has("fallback"), "fallback": options.get("fallback"),
	}
	var body := {
		"v": WIRE, "op": op, "site": site, "ticket": ticket,
		"grantId": str(_grant.get("id", NO_GRANT)) if typeof(_grant) == TYPE_DICTIONARY else NO_GRANT,
		"system": _text_or_null(options.get("system")), "prompt": prompt,
		"untrusted": _untrusted(options.get("untrusted", {})), "memory": _text_or_null(options.get("memory")),
		"schema": schema, "tier": _member(options.get("tier"), TIERS, "fast"),
		"authority": _member(options.get("authority"), AUTHORITIES, "local"),
		"maxOutputTokens": maxi(1, int(options.get("max_output_tokens", DEFAULT_OUTPUT_TOKENS))),
		"stream": op == "say",
	}
	if body.untrusted == null:
		_settle(entry, CODE_BAD_REQUEST)
		return ticket
	_send(OP_CALL, body, entry)
	return ticket


func _send(op: String, body, entry: Dictionary) -> void:
	var transport := _transport_now()
	if transport == TRANSPORT_OFF or (transport == TRANSPORT_EDITOR and not _relay_fresh()):
		_settle(entry, CODE_OFF)
		return
	if _pending.size() >= MAX_IN_FLIGHT:
		_settle(entry, CODE_CONCURRENCY)
		return
	_rids += 1
	var rid := "gdai-%08d" % _rids
	_pending[rid] = entry
	_remember(_asked, rid)
	var line := {"event": "ai", "rid": rid, "op": op, "body": body}
	if transport == TRANSPORT_PROTOCOL:
		get_node(PLAY_NODE).call("emit_ai", line)
	else:
		_write(IN_PREFIX + rid + JSON_SUFFIX, line)


## The first call decides how this run reaches Genex, once.
func _transport_now() -> String:
	if _transport != "":
		return _transport
	var play := get_node_or_null(PLAY_NODE)
	if play and play.has_method("speaks_protocol") and play.call("speaks_protocol"):
		_transport = TRANSPORT_PROTOCOL
	elif OS.has_feature("editor") and DirAccess.dir_exists_absolute(_folder):
		_transport = TRANSPORT_EDITOR
	else:
		_transport = TRANSPORT_OFF
	return _transport


# --- Answers ---

func _take_reply(rid: String, reply) -> void:
	var entry: Dictionary = _pending[rid]
	_pending.erase(rid)
	_remember(_answered, rid)
	var answer: Dictionary = reply if typeof(reply) == TYPE_DICTIONARY else {}
	match str(entry.kind):
		KIND_CALL:
			_partials.erase(entry.ticket)
			_arrived.append(_result(entry, answer))
		KIND_HELLO:
			_set_on(answer.get("on") == true)
		KIND_GRANT:
			_grant = answer.get("view") if typeof(answer.get("view")) == TYPE_DICTIONARY else null
			_set_on(_grant != null)


func _take_delta(rid: String, text) -> bool:
	var entry: Dictionary = _pending[rid]
	if str(entry.kind) != KIND_CALL or typeof(text) != TYPE_STRING:
		return false
	_partials[entry.ticket] = text
	return true


func _result(entry: Dictionary, answer: Dictionary) -> Dictionary:
	var ok: bool = answer.get("ok") == true
	if ok:
		_set_on(true)
		return {
			"ticket": entry.ticket, "site": entry.site, "ok": true, "value": answer.get("value"), "code": "",
			"source": str(answer.get("source", "")), "provenance": str(answer.get("provenance", "")),
			"fallback": false,
		}
	var code := str(answer.get("code", CODE_PROVIDER))
	if code == CODE_OFF:
		_set_on(false)
	return _failure(entry, code)


func _failure(entry: Dictionary, code: String) -> Dictionary:
	return {
		"ticket": entry.ticket, "site": entry.site, "ok": false, "value": entry.fallback, "code": code,
		"source": "", "provenance": "", "fallback": entry.has_fallback,
	}


## A line Genex never got: a call's result arrives in the next drain, as any other.
func _settle(entry: Dictionary, code: String) -> void:
	if str(entry.kind) == KIND_CALL:
		_arrived.append(_failure(entry, code))
	elif code == CODE_OFF:
		_set_on(false)


func _set_on(on: bool) -> void:
	if on == _on:
		return
	_on = on
	changed.emit()


# --- The editor's relay: whole files in .godot/genex/ ---

func _relay_fresh() -> bool:
	var path := _folder.path_join(RELAY_BEAT)
	if not FileAccess.file_exists(path):
		return false
	var beat = JSON.parse_string(FileAccess.get_file_as_string(path))
	if typeof(beat) != TYPE_DICTIONARY or not (typeof(beat.get("at")) in [TYPE_INT, TYPE_FLOAT]):
		return false
	var now := Time.get_unix_time_from_system() * 1000.0
	return absf(now - float(beat.at)) <= RELAY_FRESH_MS


## Each answer Studio left, in the order it named them; a relay that stopped beating answers ai_off.
func _read_relay() -> void:
	var dir := DirAccess.open(_folder)
	if dir == null:
		return
	var names := Array(dir.get_files()).filter(func(name): return name.begins_with(OUT_PREFIX) and name.ends_with(JSON_SUFFIX))
	names.sort()
	for name in names:
		var path := _folder.path_join(name)
		var item = JSON.parse_string(FileAccess.get_file_as_string(path))
		DirAccess.remove_absolute(path)
		if typeof(item) == TYPE_DICTIONARY and typeof(item.get("args")) == TYPE_DICTIONARY:
			take_studio_op(str(item.get("op", "")), item.args)
	if not _pending.is_empty() and not _relay_fresh():
		for rid in _pending.keys():
			_take_reply(rid, {"ok": false, "code": CODE_OFF, "on": false, "view": null})


## A whole file or none: written beside, then moved into place.
func _write(name: String, value: Dictionary) -> void:
	var path := _folder.path_join(name)
	var file := FileAccess.open(path + PARTIAL_SUFFIX, FileAccess.WRITE)
	if file == null:
		return
	file.store_string(JSON.stringify(value, "", false))
	file.close()
	DirAccess.rename_absolute(path + PARTIAL_SUFFIX, path)


# --- Small readers ---

func _text_or_null(value):
	return value if typeof(value) == TYPE_STRING else null


func _member(value, allowed: Array, fallback: String) -> String:
	return value if typeof(value) == TYPE_STRING and value in allowed else fallback


## The player-typed fields as strings by name, or null when one is not text.
func _untrusted(fields):
	if typeof(fields) != TYPE_DICTIONARY:
		return null
	var out := {}
	for key in fields:
		if typeof(fields[key]) != TYPE_STRING:
			return null
		out[str(key)] = fields[key]
	return out


func _remember(list: Array[String], rid: String) -> void:
	list.append(rid)
	if list.size() > MAX_ECHO:
		list.pop_front()
