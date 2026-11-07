"""What the owner can change at the editor, read cheaply so the queue can poll it: the viewport
camera, the selection, the unsaved packages and whether a play session runs. A change while the
queue is quiet means the owner is working, and the queue waits."""

from genex_loop import editor


def _camera() -> list | None:
    info = editor.editor_subsystem().get_level_viewport_camera_info()
    if not info:
        return None
    location, rotation = info[-2:]
    return [round(location.x), round(location.y), round(location.z), round(rotation.pitch, 1), round(rotation.yaw, 1)]


def _selection(pie: bool) -> list:
    """The selected actors' labels. During play Unreal answers none and writes "The Editor is currently
    in a play mode." to its log as an error, which every save point would then report: so it isn't asked."""
    if pie:
        return []
    return sorted(a.get_actor_label() for a in editor.actors().get_selected_level_actors())


def editor_activity() -> dict:
    """{camera: [x, y, z, pitch, yaw], selection: [labels], dirty: [package names], pie}."""
    pie = editor.play_world() is not None
    return {'camera': _camera(), 'selection': _selection(pie), 'dirty': editor.dirty_packages(), 'pie': pie}
