# Genex Play Protocol 3 for a Godot game (docs/play-protocol.md in Genex): lets Genex's computer
# tool, its playtesters and its judges look at the game, press keys, point, type, hold and step the
# clock, reseed it and read its state. It is an autoload that does nothing unless the game is started
# with `-- --play-protocol` (Genex's bin/play does); in the editor and in a normal run it removes itself.
# Requests arrive as JSON lines on stdin and every reply is one JSON line on stdout; logs go to stderr.
# Time runs in physics ticks at the game's fixed rate: while paused (SceneTree.paused) nothing
# moves, input waits for the next tick, and `step` runs whole ticks.
extends Node

const PROTOCOL := 3
const FLAG := "--play-protocol"
const MAX_STEP_MS := 60000.0
const MAX_TYPE_CHARS := 2000
const MAX_STATE_NODES := 4000
const WHEEL_UNIT := 120.0
const CORE_OPS := ["hello", "screenshot", "pointer", "key", "type", "look", "wheel", "act", "pause", "play", "step", "reset", "state", "quit"]
const BUTTONS := {"left": MOUSE_BUTTON_LEFT, "middle": MOUSE_BUTTON_MIDDLE, "right": MOUSE_BUTTON_RIGHT}
const NAMED_CODES := {
	"Space": KEY_SPACE, "Enter": KEY_ENTER, "Escape": KEY_ESCAPE, "Tab": KEY_TAB, "Backspace": KEY_BACKSPACE,
	"Delete": KEY_DELETE, "Insert": KEY_INSERT, "Home": KEY_HOME, "End": KEY_END, "PageUp": KEY_PAGEUP,
	"PageDown": KEY_PAGEDOWN, "ArrowUp": KEY_UP, "ArrowDown": KEY_DOWN, "ArrowLeft": KEY_LEFT,
	"ArrowRight": KEY_RIGHT, "Minus": KEY_MINUS, "Equal": KEY_EQUAL, "Comma": KEY_COMMA,
	"Period": KEY_PERIOD, "Slash": KEY_SLASH, "ShiftLeft": KEY_SHIFT, "ControlLeft": KEY_CTRL,
	"AltLeft": KEY_ALT, "MetaLeft": KEY_META,
}

var _reader: Thread
var _lock := Mutex.new()
var _lines: Array[String] = []
var _closed := false
var _busy := false
var _view := Vector2i(1280, 720)
var _tick := 0
var _step_left := 0
var _due: Array[Dictionary] = []
var _echo := {}
var _held_keys := {}
var _held_actions := {}
var _pointer := Vector2.ZERO
var _buttons := {}


signal stepped


func _ready() -> void:
	if Engine.is_editor_hint() or not OS.get_cmdline_user_args().has(FLAG):
		queue_free()
		return
	process_mode = Node.PROCESS_MODE_ALWAYS
	process_physics_priority = -1000000
	process_priority = -1000000
	_view = _design_view()
	_clear_echo()
	_reader = Thread.new()
	_reader.start(_read_stdin)
	_emit({"event": "ready", "protocol": PROTOCOL, "name": _game_name()})


func _exit_tree() -> void:
	if _reader and _reader.is_started():
		_closed = true


# --- Reading: byte by byte, split into lines here. A bigger read waits for a full buffer on a
# pipe, and a line read can't tell an empty line from the end; requests are small. ---

func _read_stdin() -> void:
	var line := PackedByteArray()
	while true:
		var byte := OS.read_buffer_from_stdin(1)
		if byte.is_empty():
			break
		if byte[0] != 10:
			line.append(byte[0])
			continue
		var text := line.get_string_from_utf8().strip_edges()
		line.clear()
		if text != "":
			_lock.lock()
			_lines.append(text)
			_lock.unlock()
	_lock.lock()
	_closed = true
	_lock.unlock()


func _process(_delta: float) -> void:
	if not _busy:
		_drain()


# Ops are applied one at a time, in the order they arrived; an op that waits (a step, a picture)
# holds the ones after it.
func _drain() -> void:
	_busy = true
	while true:
		_lock.lock()
		var line: String = _lines.pop_front() if not _lines.is_empty() else ""
		var closed := _closed
		_lock.unlock()
		if line == "":
			if closed:
				get_tree().quit(0)
			break
		await _handle_line(line)
	_busy = false


func _handle_line(line: String) -> void:
	var request = JSON.parse_string(line)
	if typeof(request) != TYPE_DICTIONARY or not request.has("id"):
		return
	var id = request.id
	var op = request.get("op")
	if typeof(op) != TYPE_STRING or not (op in CORE_OPS):
		_fail(id, str(op) if typeof(op) == TYPE_STRING else "", "unknown-op", "Not an op of this game.", {"available": CORE_OPS})
		return
	# A game with no actions of its own lacks act, whatever it is asked.
	if op == "act" and _actions().is_empty():
		_fail(id, op, "unsupported", "This game has no named actions.")
		return
	var refusal := _check(op, request)
	if refusal != "":
		_fail(id, op, "bad-args", refusal)
		return
	var result = await call("_op_" + op, request)
	_reply(id, op, result)


# --- Ticks: input given at a tick's start, the clock held between steps. ---

func _physics_process(_delta: float) -> void:
	if get_tree().paused and _step_left == 0:
		return
	if _step_left > 0:
		_step_left -= 1
		if _step_left == 0:
			# This frame's tick is the last one asked for: hold the clock when it is done.
			call_deferred("_end_step")
	_apply_due()
	_tick += 1


func _end_step() -> void:
	get_tree().paused = true
	stepped.emit()


func _apply_due() -> void:
	var now := _due.filter(func(entry): return entry.at <= _tick)
	_due = _due.filter(func(entry): return entry.at > _tick)
	for entry in now:
		entry.apply.call()


# Something to happen at the start of the tick `offset` ticks from the next one.
func _later(offset: int, apply: Callable) -> void:
	_due.append({"at": _tick + offset, "apply": apply})


# --- Ops ---

func _op_hello(_r: Dictionary) -> Dictionary:
	var actions := _actions()
	return {
		"protocol": PROTOCOL,
		"name": _game_name(),
		"view": {"width": _view.x, "height": _view.y},
		"build": {"id": "godot-%s" % Engine.get_version_info().string},
		"capabilities": {
			"pointer": "absolute", "clock": "step-locked", "state": "game", "seed": true,
			"actions": actions, "screenshot": ["jpeg", "png"],
		},
		"ops": [],
		"unsupported": [] if not actions.is_empty() else ["act"],
	}


func _op_screenshot(r: Dictionary) -> Dictionary:
	await RenderingServer.frame_post_draw
	var image := get_viewport().get_texture().get_image()
	if image.get_size() != _view:
		image.resize(_view.x, _view.y, Image.INTERPOLATE_BILINEAR)
	var format: String = r.get("format", "jpeg")
	var quality: float = float(r.get("quality", 85)) / 100.0
	var bytes := image.save_png_to_buffer() if format == "png" else image.save_jpg_to_buffer(quality)
	return {"format": format, "data": Marshalls.raw_to_base64(bytes), "width": _view.x, "height": _view.y}


func _op_pointer(r: Dictionary) -> Dictionary:
	var at := Vector2(float(r.x), float(r.y))
	var button: MouseButton = BUTTONS[r.get("button", "left")]
	_pointer = at
	_echo.pointer.x = int(at.x)
	_echo.pointer.y = int(at.y)
	_later(0, func(): _move_pointer(at))
	if r.has("down"):
		_set_button_echo(r.button if r.has("button") else "left", bool(r.down))
		_later(0, func(): _send_button(button, bool(r.down), at, false))
	elif r.has("click"):
		var double := int(r.click) >= 2
		_later(0, func(): _send_button(button, true, at, double))
		_later(1, func(): _send_button(button, false, at, false))
	return {"x": int(at.x), "y": int(at.y)}


func _op_key(r: Dictionary) -> Dictionary:
	var code: String = r.code
	var key := _keycode(code)
	if r.has("down"):
		var down := bool(r.down)
		_set_key_echo(code, down)
		_later(0, func(): _send_key(key, down))
	else:
		_later(0, func(): _send_key(key, true))
		_later(1, func(): _send_key(key, false))
	return {"code": code}


func _op_type(r: Dictionary) -> Dictionary:
	var text: String = r.text
	_echo.typed += text
	_later(0, func(): _send_text(text))
	return {"typed": text.length()}


func _op_look(r: Dictionary) -> Dictionary:
	var delta := Vector2(float(r.dx), float(r.dy))
	_echo.look.dx += delta.x
	_echo.look.dy += delta.y
	_later(0, func(): _send_look(delta))
	return {"dx": delta.x, "dy": delta.y}


func _op_wheel(r: Dictionary) -> Dictionary:
	var delta := Vector2(float(r.dx), float(r.dy))
	_echo.wheel.dx += delta.x
	_echo.wheel.dy += delta.y
	var at := _pointer
	_later(0, func(): _send_wheel(delta, at))
	return {"dx": delta.x, "dy": delta.y}


func _op_act(r: Dictionary) -> Dictionary:
	for item in r.list:
		var action: String = item.action
		match String(item.state):
			"press":
				_later(0, func(): Input.action_press(action))
				_later(1, func(): Input.action_release(action))
			"hold":
				var ticks := int(item.get("ticks", 1))
				_held_actions[action] = true
				_later(0, func(): Input.action_press(action))
				_later(ticks, func(): Input.action_release(action); _held_actions.erase(action))
			"release":
				_held_actions.erase(action)
				_later(0, func(): Input.action_release(action))
	return {"acted": r.list.size()}


func _op_pause(_r: Dictionary) -> Dictionary:
	_step_left = 0
	get_tree().paused = true
	return {"paused": true}


func _op_play(_r: Dictionary) -> Dictionary:
	_step_left = 0
	get_tree().paused = false
	return {"paused": false}


func _op_step(r: Dictionary) -> Dictionary:
	var rate := float(Engine.physics_ticks_per_second)
	var ticks := maxi(1, roundi(float(r.ms) * rate / 1000.0))
	get_tree().paused = true
	_step_left = ticks
	get_tree().paused = false
	await stepped
	return {"simulatedMs": ticks * 1000.0 / rate}


func _op_reset(r: Dictionary) -> Dictionary:
	var paused := get_tree().paused
	_step_left = 0
	_release_everything()
	_due.clear()
	_clear_echo()
	_pointer = Vector2.ZERO
	seed(int(r.seed))
	get_tree().reload_current_scene()
	await get_tree().process_frame
	await get_tree().process_frame
	_tick = 0
	_due.clear()
	get_tree().paused = paused
	return {"seed": int(r.seed)}


func _op_state(_r: Dictionary) -> Dictionary:
	var scene := get_tree().current_scene
	var game = scene.call("genex_state") if scene and scene.has_method("genex_state") else null
	# Simulated time is part of the simulation: a step always moves the checksum.
	var simulation := {"tick": _tick, "scene": scene.scene_file_path if scene else "", "nodes": _snapshot(scene)}
	if game != null:
		simulation["game"] = game
	return {
		"tick": _tick,
		"scene": simulation.scene,
		"game": game,
		"checksum": JSON.stringify(simulation).md5_text(),
		"input": _echo.duplicate(true),
		"volatile": {"fps": Engine.get_frames_per_second(), "frames": Engine.get_process_frames()},
	}


func _op_quit(_r: Dictionary) -> Dictionary:
	get_tree().call_deferred("quit", 0)
	return {"quitting": true}


# --- Checking a request's arguments: a bad one is refused, never applied. ---

func _check(op: String, r: Dictionary) -> String:
	match op:
		"screenshot":
			if r.has("format") and not (r.format in ["jpeg", "png"]):
				return "format is jpeg or png."
			if r.has("quality") and not (_is_number(r.quality) and float(r.quality) >= 1 and float(r.quality) <= 100):
				return "quality is 1 to 100."
		"pointer":
			return _check_pointer(r)
		"key":
			if typeof(r.get("code")) != TYPE_STRING or _keycode(r.code) == KEY_NONE:
				return "code is a KeyboardEvent.code this game knows."
			if r.has("down") and typeof(r.down) != TYPE_BOOL:
				return "down is true or false."
		"type":
			if typeof(r.get("text")) != TYPE_STRING or String(r.text).length() > MAX_TYPE_CHARS:
				return "text is a string of at most 2000 characters."
		"look", "wheel":
			if not (_is_number(r.get("dx")) and _is_number(r.get("dy"))):
				return "dx and dy are numbers."
		"act":
			return _check_act(r)
		"step":
			if not (_is_number(r.get("ms")) and float(r.ms) > 0 and float(r.ms) <= MAX_STEP_MS):
				return "ms is more than 0 and at most 60000."
		"reset":
			if not (_is_number(r.get("seed")) and float(r.seed) >= 0 and float(r.seed) == floorf(float(r.seed))):
				return "seed is a whole number from 0."
	return ""


func _check_pointer(r: Dictionary) -> String:
	if not (_is_number(r.get("x")) and _is_number(r.get("y"))):
		return "x and y are numbers."
	if r.has("button") and not (r.button in BUTTONS):
		return "button is left, middle or right."
	if r.has("down") and typeof(r.down) != TYPE_BOOL:
		return "down is true or false."
	if r.has("click") and not (_is_number(r.click) and int(r.click) >= 1 and int(r.click) <= 3):
		return "click is 1 to 3."
	return ""


func _check_act(r: Dictionary) -> String:
	if typeof(r.get("list")) != TYPE_ARRAY:
		return "list is an array of actions."
	var known := _actions()
	for item in r.list:
		if typeof(item) != TYPE_DICTIONARY or not (item.get("action") in known):
			return "each action is one hello names."
		if not (item.get("state") in ["press", "hold", "release"]):
			return "state is press, hold or release."
		if item.has("ticks") and not (_is_number(item.ticks) and int(item.ticks) >= 1):
			return "ticks is a whole number from 1."
	return ""


func _is_number(value) -> bool:
	return typeof(value) == TYPE_FLOAT or typeof(value) == TYPE_INT


# --- Input into the game ---

func _keycode(code: String) -> Key:
	if NAMED_CODES.has(code):
		return NAMED_CODES[code]
	if code.length() == 4 and code.begins_with("Key"):
		return OS.find_keycode_from_string(code.substr(3))
	if code.length() == 6 and code.begins_with("Digit"):
		return OS.find_keycode_from_string(code.substr(5))
	if code.begins_with("F") and code.substr(1).is_valid_int() and int(code.substr(1)) in range(1, 25):
		return OS.find_keycode_from_string(code)
	return KEY_NONE


func _send_key(key: Key, down: bool) -> void:
	var event := InputEventKey.new()
	event.keycode = key
	event.physical_keycode = key
	event.pressed = down
	Input.parse_input_event(event)
	Input.flush_buffered_events()


func _send_text(text: String) -> void:
	for character in text:
		for down in [true, false]:
			var event := InputEventKey.new()
			event.unicode = character.unicode_at(0)
			event.pressed = down
			Input.parse_input_event(event)
	Input.flush_buffered_events()


func _window_point(at: Vector2) -> Vector2:
	var size := Vector2(get_window().size)
	return at * Vector2(size.x / _view.x, size.y / _view.y)


func _move_pointer(at: Vector2) -> void:
	var event := InputEventMouseMotion.new()
	event.position = _window_point(at)
	event.global_position = event.position
	Input.parse_input_event(event)
	Input.flush_buffered_events()


func _send_button(button: MouseButton, down: bool, at: Vector2, double: bool) -> void:
	var event := InputEventMouseButton.new()
	event.button_index = button
	event.pressed = down
	event.double_click = double
	event.position = _window_point(at)
	event.global_position = event.position
	Input.parse_input_event(event)
	Input.flush_buffered_events()


func _send_look(delta: Vector2) -> void:
	var event := InputEventMouseMotion.new()
	event.relative = delta
	event.position = _window_point(_pointer)
	Input.parse_input_event(event)
	Input.flush_buffered_events()


func _send_wheel(delta: Vector2, at: Vector2) -> void:
	var steps := [[MOUSE_BUTTON_WHEEL_DOWN, delta.y], [MOUSE_BUTTON_WHEEL_UP, -delta.y], [MOUSE_BUTTON_WHEEL_RIGHT, delta.x], [MOUSE_BUTTON_WHEEL_LEFT, -delta.x]]
	for step in steps:
		if step[1] > 0:
			for down in [true, false]:
				var event := InputEventMouseButton.new()
				event.button_index = step[0]
				event.factor = step[1] / WHEEL_UNIT
				event.pressed = down
				event.position = _window_point(at)
				Input.parse_input_event(event)
	Input.flush_buffered_events()


func _release_everything() -> void:
	for code in _held_keys.keys():
		_send_key(_keycode(code), false)
	for action in _held_actions.keys():
		Input.action_release(action)
	for button in _buttons.keys():
		_send_button(BUTTONS[button], false, _pointer, false)
	_held_keys.clear()
	_held_actions.clear()
	_buttons.clear()


# --- The echo of what the game was given, and the state's own snapshot ---

func _clear_echo() -> void:
	_echo = {"pointer": {"x": 0, "y": 0, "buttons": []}, "keys": [], "typed": "", "look": {"dx": 0.0, "dy": 0.0}, "wheel": {"dx": 0.0, "dy": 0.0}}


func _set_key_echo(code: String, down: bool) -> void:
	if down:
		_held_keys[code] = true
	else:
		_held_keys.erase(code)
	_echo.keys = _held_keys.keys()


func _set_button_echo(button: String, down: bool) -> void:
	if down:
		_buttons[button] = true
	else:
		_buttons.erase(button)
	_echo.pointer.buttons = _buttons.keys()


# Where everything is: each 2D and 3D node's place, each label's text, in tree order, so the
# checksum moves only when the simulation does.
func _snapshot(scene: Node) -> Array:
	var found := []
	if scene == null:
		return found
	var stack: Array[Node] = [scene]
	while not stack.is_empty() and found.size() < MAX_STATE_NODES:
		var node: Node = stack.pop_back()
		if node is Node2D:
			found.append([str(node.get_path()), node.global_position.snappedf(0.001), snappedf(node.global_rotation, 0.0001), node.visible])
		elif node is Node3D:
			found.append([str(node.get_path()), node.global_position.snappedf(0.001), node.global_rotation.snappedf(0.0001), node.visible])
		elif node is Label:
			found.append([str(node.get_path()), node.text, node.visible])
		for child in node.get_children():
			stack.push_back(child)
	return found.map(func(entry): return str(entry))


func _actions() -> Array:
	return Array(InputMap.get_actions()).map(func(a): return String(a)).filter(func(a): return not a.begins_with("ui_")).filter(func(a): return not a.contains("/"))


func _design_view() -> Vector2i:
	var width := int(ProjectSettings.get_setting("display/window/size/viewport_width", 1280))
	var height := int(ProjectSettings.get_setting("display/window/size/viewport_height", 720))
	return Vector2i(width, height)


func _game_name() -> String:
	return String(ProjectSettings.get_setting("application/config/name", "godot-game"))


# --- Writing: one JSON line per reply on stdout, the id first. ---

func _emit(value: Dictionary) -> void:
	print(JSON.stringify(value, "", false))


func _reply(id, op: String, result) -> void:
	_emit({"id": _id(id), "ok": true, "op": op, "result": result})


func _fail(id, op: String, code: String, error: String, more := {}) -> void:
	var line := {"id": _id(id), "ok": false, "op": op, "error": error, "code": code}
	line.merge(more)
	_emit(line)


func _id(id):
	return int(id) if typeof(id) == TYPE_FLOAT and id == floorf(id) else id
