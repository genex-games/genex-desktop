@tool
extends EditorPlugin

const AUTOLOAD := "GenexMultiplayer"


func _enable_plugin() -> void:
	add_autoload_singleton(AUTOLOAD, "res://addons/genex_multiplayer/genex_multiplayer.gd")
	if not FileAccess.file_exists("res://addons/colyseus/colyseus.gdextension"):
		push_warning("Genex Multiplayer: addons/colyseus is missing. Run sdks/godot/fetch-colyseus.sh <project> for native builds.")


func _disable_plugin() -> void:
	remove_autoload_singleton(AUTOLOAD)
