# Genex's player for a Godot scene: plays it at a fixed 60 frames a second, presses keys on a
# timeline, and saves stills at chosen frames: every camera in the `genex_shot` group, or only the
# first one (a recording's frames). Run as
#   godot [--headless] --path <project> --fixed-fps 60 -s genex_play.gd -- key=value ...
# with scene=<res:// path or empty for the main scene>, frames=<frames to play>,
# keys=<key@start:length;...> (frames), shots=<frame:all|first;...>, out=<file prefix>, most=<cameras>.
# A game may move its hero shot with project settings genex/shot_seconds and genex/shot_keys
# (`hero=1` asks for them). It writes only the PNGs named by the prefix, and prints one
# `GENEX_SHOT <camera> <frame> <file>` line per still and `GENEX_PLAYED <frames>` at the end.
extends SceneTree

const SHOT_GROUP := "genex_shot"
const FPS := 60
const SHOT_LINE := "GENEX_SHOT %s %d %s"
const PLAYED_LINE := "GENEX_PLAYED %d"
const NO_SCENE := "GENEX_NO_SCENE %s"
const SHOT_SECONDS_SETTING := "genex/shot_seconds"
const SHOT_KEYS_SETTING := "genex/shot_keys"
const KEYS := {
	"left": KEY_LEFT, "right": KEY_RIGHT, "up": KEY_UP, "down": KEY_DOWN, "space": KEY_SPACE,
	"enter": KEY_ENTER, "escape": KEY_ESCAPE, "tab": KEY_TAB, "shift": KEY_SHIFT, "ctrl": KEY_CTRL,
	"alt": KEY_ALT, "backspace": KEY_BACKSPACE,
}

var args := {}
var presses: Array[Dictionary] = []
var shots: Array[Dictionary] = []


func _initialize() -> void:
	_read_args()
	var scene_path := String(args.get("scene", ""))
	if scene_path == "":
		scene_path = String(ProjectSettings.get_setting("application/run/main_scene", ""))
	var packed := load(scene_path) as PackedScene
	if packed == null:
		print(NO_SCENE % scene_path)
		quit(1)
		return
	var scene := packed.instantiate()
	root.add_child(scene)
	current_scene = scene
	await _play(int(args.get("frames", "1")))
	quit(0)


func _read_args() -> void:
	for arg in OS.get_cmdline_user_args():
		var at := arg.find("=")
		if at > 0:
			args[arg.substr(0, at)] = arg.substr(at + 1)
	presses = _parse_keys(String(args.get("keys", "")), 0)
	shots = _parse_shots(String(args.get("shots", "")))
	if args.get("hero", "") == "1":
		_apply_hero_settings()


# A game's own hero moment: its keys come first, and every still moves to its time.
func _apply_hero_settings() -> void:
	var seconds := float(ProjectSettings.get_setting(SHOT_SECONDS_SETTING, -1.0))
	var keys := String(ProjectSettings.get_setting(SHOT_KEYS_SETTING, ""))
	if keys != "":
		presses = _parse_named_keys(keys)
	if seconds < 0.0:
		return
	var frame := maxi(1, int(seconds * FPS))
	for shot in shots:
		if shot.mode == "all":
			shot.frame = frame
	args["frames"] = str(maxi(int(args.get("frames", "1")), frame + 1))


func _play(frames: int) -> void:
	for frame in maxi(frames, 1):
		_press_keys(frame)
		await process_frame
		for shot in shots:
			if shot.frame == frame:
				await _shoot(shot.mode == "all", frame)
	print(PLAYED_LINE % frames)


func _press_keys(frame: int) -> void:
	for press in presses:
		if frame == press.start:
			_send_key(press.key, true)
		elif frame == press.start + press.length:
			_send_key(press.key, false)


func _send_key(keycode: Key, pressed: bool) -> void:
	var event := InputEventKey.new()
	event.keycode = keycode
	event.physical_keycode = keycode
	event.pressed = pressed
	Input.parse_input_event(event)
	Input.flush_buffered_events()


func _shoot(every_camera: bool, frame: int) -> void:
	var prefix := String(args.get("out", ""))
	if prefix == "":
		return
	var most := maxi(1, int(args.get("most", "4")))
	var cameras := get_nodes_in_group(SHOT_GROUP).filter(func(node): return node is Camera3D or node is Camera2D)
	if not every_camera:
		cameras = cameras.slice(0, 1)
	if cameras.is_empty():
		await _save("main", prefix, frame, 0)
		return
	for index in mini(cameras.size(), most):
		var camera = cameras[index]
		camera.make_current()
		await _save(String(camera.name), prefix, frame, index)


func _save(name: String, prefix: String, frame: int, index: int) -> void:
	await RenderingServer.frame_post_draw
	var file := "%s-%d-%d.png" % [prefix, frame, index]
	if root.get_texture().get_image().save_png(file) == OK:
		print(SHOT_LINE % [name.replace(" ", "_"), frame, file])


# keys=<key>@<start frame>:<length in frames>;... as Genex sends them, already checked.
func _parse_keys(text: String, _offset: int) -> Array[Dictionary]:
	var found: Array[Dictionary] = []
	for part in text.split(";", false):
		var at := part.find("@")
		var colon := part.find(":")
		if at < 0 or colon < at:
			continue
		var name := part.substr(0, at)
		if KEYS.has(name) or name.length() == 1:
			found.append({"key": _keycode(name), "start": int(part.substr(at + 1, colon - at - 1)), "length": maxi(1, int(part.substr(colon + 1)))})
	return found


# genex/shot_keys as a game writes it: "enter 0.2, wait 1, right 2", seconds.
func _parse_named_keys(text: String) -> Array[Dictionary]:
	var found: Array[Dictionary] = []
	var at := 0.0
	for part in text.split(",", false):
		var words := part.strip_edges().split(" ", false)
		if words.is_empty():
			continue
		var name := words[0].to_lower()
		var seconds := float(words[1]) if words.size() > 1 else 0.1
		if name != "wait" and (KEYS.has(name) or name.length() == 1):
			found.append({"key": _keycode(name), "start": int(at * FPS), "length": maxi(1, int(seconds * FPS))})
		at += seconds
	return found


func _keycode(name: String) -> Key:
	if KEYS.has(name):
		return KEYS[name]
	return OS.find_keycode_from_string(name.to_upper())


func _parse_shots(text: String) -> Array[Dictionary]:
	var found: Array[Dictionary] = []
	for part in text.split(";", false):
		var colon := part.find(":")
		if colon > 0:
			found.append({"frame": int(part.substr(0, colon)), "mode": part.substr(colon + 1)})
	return found
