# Genex's data copy for Windows: puts a file Genex staged in the project into Godot's own data
# folder as the user running it sees it, where Godot looks for export templates. Genex's sandbox
# user has a data folder of its own that the person's templates aren't in. Run headless as
# `godot --headless --path <project> -s genex_data.gd -- from=<file> to=<path in the data folder>`.
# It changes nothing in the project. The last line says where the file went, or why it didn't.
extends SceneTree

const COPIED := "GENEX_DATA_COPIED %s"
const FAILED := "GENEX_DATA_FAILED %s"


func _initialize() -> void:
	var args := {}
	for arg in OS.get_cmdline_user_args():
		var at := arg.find("=")
		if at > 0:
			args[arg.substr(0, at)] = arg.substr(at + 1)
	var from := String(args.get("from", ""))
	var to := String(args.get("to", ""))
	if from == "" or to == "" or to.is_absolute_path() or ".." in to.split("/"):
		print(FAILED % "arguments")
		quit(1)
		return
	var target := OS.get_data_dir().path_join(to)
	DirAccess.make_dir_recursive_absolute(target.get_base_dir())
	var error := DirAccess.copy_absolute(from, target)
	print((COPIED if error == OK else FAILED) % (target if error == OK else error_string(error)))
	quit(0 if error == OK else 1)
