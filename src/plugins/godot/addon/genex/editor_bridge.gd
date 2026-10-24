# Genex's bridge into your own Godot editor. Genex never drives the editor: before it keeps a save
# point or rewinds the game it asks the editor to save what you have open, and after a Rewind to
# reload the scenes it changed on disk. The asks and answers are small JSON files in the project's
# .godot/genex/ folder (Godot's own cache, never shared); the editor also writes a heartbeat there
# each second, so Genex knows it is open. No port is opened and nothing else is run.
@tool
extends EditorPlugin

const FOLDER := "res://.godot/genex"
const HEARTBEAT := "editor.json"
const ASK_PREFIX := "ask-"
const ANSWER_PREFIX := "answer-"
const JSON_SUFFIX := ".json"
const PARTIAL_SUFFIX := ".partial"
const ASK_EVERY_S := 0.2
const BEAT_EVERY_S := 1.0
const OP_SAVE := "save"
const OP_RELOAD := "reload"

var _folder := ""
var _since_beat := BEAT_EVERY_S
var _since_ask := 0.0


func _enter_tree() -> void:
	_folder = ProjectSettings.globalize_path(FOLDER)
	DirAccess.make_dir_recursive_absolute(_folder)
	set_process(true)


func _exit_tree() -> void:
	set_process(false)
	DirAccess.remove_absolute(_folder.path_join(HEARTBEAT))


func _process(delta: float) -> void:
	_since_beat += delta
	_since_ask += delta
	if _since_ask >= ASK_EVERY_S:
		_since_ask = 0.0
		_answer_asks()
	if _since_beat >= BEAT_EVERY_S:
		_since_beat = 0.0
		_write(HEARTBEAT, _beat())


## What Genex reads each second: this editor, when, whether you play a scene, and the scripts you
## have changed and not saved.
func _beat() -> Dictionary:
	return {
		"pid": OS.get_process_id(),
		"at": int(Time.get_unix_time_from_system() * 1000.0),
		"playing": EditorInterface.is_playing_scene(),
		"unsavedScripts": _unsaved_code().size(),
	}


## Each ask Genex left, answered once in a file of its own and then removed.
func _answer_asks() -> void:
	var dir := DirAccess.open(_folder)
	if dir == null:
		return
	for name in dir.get_files():
		if not (name.begins_with(ASK_PREFIX) and name.ends_with(JSON_SUFFIX)):
			continue
		var id := name.trim_prefix(ASK_PREFIX).trim_suffix(JSON_SUFFIX)
		var path := _folder.path_join(name)
		var ask = JSON.parse_string(FileAccess.get_file_as_string(path))
		DirAccess.remove_absolute(path)
		if not id.is_valid_hex_number() or typeof(ask) != TYPE_DICTIONARY:
			continue
		_write(ANSWER_PREFIX + id + JSON_SUFFIX, _run(str(ask.get("op", ""))))


func _run(op: String) -> Dictionary:
	if op == OP_SAVE:
		return _save()
	if op == OP_RELOAD:
		return _reload()
	return {"ok": false, "error": "unknown-op"}


## Every open scene saved, and every script you changed whose text Godot holds as the script's.
func _save() -> Dictionary:
	EditorInterface.save_all_scenes()
	var saved := 0
	var scripts := EditorInterface.get_script_editor().get_open_scripts()
	for code in _unsaved_code():
		var script := _script_of(code, scripts)
		if script and ResourceSaver.save(script, script.resource_path) == OK:
			code.tag_saved_version()
			saved += 1
	return {"ok": true, "savedScripts": saved, "unsavedScripts": _unsaved_code().size()}


## Godot's file list read again, and each open scene that is still on disk loaded from it.
func _reload() -> Dictionary:
	EditorInterface.get_resource_filesystem().scan()
	var reloaded := 0
	for scene in EditorInterface.get_open_scenes():
		if FileAccess.file_exists(scene):
			EditorInterface.reload_scene_from_path(scene)
			reloaded += 1
	return {"ok": true, "reloadedScenes": reloaded}


## The script editor's text boxes holding changes not saved yet.
func _unsaved_code() -> Array[TextEdit]:
	var unsaved: Array[TextEdit] = []
	for editor in EditorInterface.get_script_editor().get_open_script_editors():
		var code := editor.get_base_editor() as TextEdit
		if code and code.get_version() != code.get_saved_version():
			unsaved.append(code)
	return unsaved


## The open script whose source is this text box's text, saved in the project; null without one.
func _script_of(code: TextEdit, scripts: Array[Script]) -> Script:
	for script in scripts:
		if script.resource_path.begins_with("res://") and script.source_code == code.text:
			return script
	return null


## A whole file or none: written beside, then moved into place.
func _write(name: String, value: Dictionary) -> void:
	var path := _folder.path_join(name)
	var file := FileAccess.open(path + PARTIAL_SUFFIX, FileAccess.WRITE)
	if file == null:
		return
	file.store_string(JSON.stringify(value))
	file.close()
	DirAccess.rename_absolute(path + PARTIAL_SUFFIX, path)
