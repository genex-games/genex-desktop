# Genex's check of a Godot project: loads every script, scene and resource under res:// once, so
# Godot itself prints each parse error, missing dependency and broken reference with its file and
# line. Run headless after an import, as `godot --headless --path <project> -s genex_check.gd`.
# It changes nothing in the project. The last line says how many files it loaded.
extends SceneTree

const CHECKED := ["gd", "tscn", "scn", "tres", "res"]
const SKIPPED := [".godot", ".git", "addons/genex"]
const DONE := "GENEX_CHECKED %d"


func _initialize() -> void:
	var files: Array[String] = []
	_collect("res://", files)
	for file in files:
		ResourceLoader.load(file, "", ResourceLoader.CACHE_MODE_IGNORE)
	print(DONE % files.size())
	quit(0)


func _collect(folder: String, files: Array[String]) -> void:
	var dir := DirAccess.open(folder)
	if dir == null:
		return
	for name in dir.get_directories():
		var child := folder.path_join(name)
		if not _skipped(child):
			_collect(child, files)
	for name in dir.get_files():
		if name.get_extension() in CHECKED:
			files.append(folder.path_join(name))


func _skipped(folder: String) -> bool:
	for skipped in SKIPPED:
		if folder == "res://" + skipped:
			return true
	return folder.get_file().begins_with(".")
