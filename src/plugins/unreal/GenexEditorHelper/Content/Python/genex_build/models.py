"""attach_mesh: a static mesh put on a Blueprint's component (a vehicle's front on its first-person
camera). It adds the component through the SubobjectDataSubsystem (as the part tools do), then
compiles and saves the Blueprint. Models come in through imports.py."""

import unreal

from genex_build import args
from genex_loop import blueprints, editor, paths
from genex_loop.errors import Refused, short_message

COMPONENT_PREFIX = 'Genex_'

MESSAGE = {
    'blueprint': 'blueprint must be an existing Blueprint asset.',
    'mesh': 'mesh must be an existing StaticMesh asset.',
    'parent': 'The Blueprint has no component {parent}.',
}


def _loaded(path: object, field: str, kind: type, message: str) -> object:
    """The asset at a /Game/ path, of the kind wanted, or Refused."""
    checked = paths.check_object_path(path, field)
    asset = unreal.load_asset(checked)
    if not isinstance(asset, kind):
        raise Refused(message, **{field: path})
    return asset


def _component_names(blueprint: unreal.Blueprint) -> set:
    """The variable names of the Blueprint's components, read only."""
    subsystem = unreal.get_engine_subsystem(unreal.SubobjectDataSubsystem)
    library = unreal.SubobjectDataBlueprintFunctionLibrary
    return {str(library.get_variable_name(subsystem.k2_find_subobject_data_from_handle(handle)))
            for handle in subsystem.k2_gather_subobject_data_for_blueprint(blueprint)}


def _component_name(mesh_path: str) -> str:
    """Genex_<the mesh asset's name>, cut to a name's 64 characters."""
    asset = mesh_path.split('.')[0].rsplit('/', 1)[-1]
    return f'{COMPONENT_PREFIX}{asset}'[:64]


def _place(component, offset: args.Offset, static_mesh: unreal.StaticMesh) -> None:
    location, rotation, scale = offset
    component.set_editor_property('static_mesh', static_mesh)
    component.set_editor_property('relative_location', unreal.Vector(*location))
    component.set_editor_property('relative_rotation', unreal.Rotator(roll=rotation[2], pitch=rotation[0], yaw=rotation[1]))
    component.set_editor_property('relative_scale3d', unreal.Vector(*scale))


def attach_mesh(blueprint: str, mesh: str, parent: str, offset: str) -> dict:
    """Puts a static mesh on a Blueprint under `parent` (its root when ''), compiles and saves it."""
    place = args.offset(offset)
    if parent != '':
        args.name(parent, 'parent')
    editor.refuse_during_play()
    target = _loaded(blueprint, 'blueprint', unreal.Blueprint, MESSAGE['blueprint'])
    static_mesh = _loaded(mesh, 'mesh', unreal.StaticMesh, MESSAGE['mesh'])
    if parent != '' and parent not in _component_names(target):
        raise Refused(MESSAGE['parent'].format(parent=parent), parent=parent)
    name = _component_name(mesh)
    try:
        component = blueprints.add_component(target, 'StaticMeshComponent', name, parent or None)
    except Exception as error:  # noqa: BLE001 - the subsystem refusing the component
        raise Refused(f'Unreal did not add {name}: {short_message(error)}') from None
    _place(component, place, static_mesh)
    compiled, _messages = blueprints.compile_status(target)
    saved = bool(unreal.EditorAssetLibrary.save_loaded_asset(target))
    return {'component': name, 'parent': parent, 'compiled': compiled, 'saved': saved}
