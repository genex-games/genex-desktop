"""attach_to_socket: a static mesh held by a skeletal mesh's socket or bone (a katana in a character's
hand), on a Blueprint so every spawned character carries it, or on an actor already in the level.

The skeletal mesh is the first one players see that has the socket: a character moved by a hidden
mesh (motion_character's Body copying its hidden mannequin, Mesh) holds the mesh in the visible hand.
When only a hidden mesh has the socket the call is refused, since the held mesh would follow a skeleton
nobody sees. On a Blueprint the mesh becomes the component Gx<mesh name> under that skeletal mesh (often
a Character's Mesh). Unreal's Python can't set a Blueprint component's parent socket, so the
Blueprint's construction script gets one "Attach Component To Component" node right after its entry,
keeping the component's offset relative to the socket; attaching the same mesh again reuses that
component and that node (it changes the socket and the offset, and the parent when another mesh held
it). The Blueprint is compiled and saved. On a level actor the mesh's actor is attached to the actor's skeletal mesh at the socket.
"""

import re

import unreal

from genex_build import args, place, scope
from genex_loop import blueprints, editor, paths
from genex_loop.errors import Refused, short_message

COMPONENT_PREFIX = 'Gx'
CHARACTER_MESH = 'Mesh'
CHARACTER_MESH_GETTER = 'Variables|Character|GetMesh'
SOCKET = re.compile(r'[A-Za-z0-9_]{1,64}')
MAX_OFFSET_CM = 1000.0
# The scope a held mesh belongs to when attach_to_socket is called outside a build script.
HELD_SCOPE = 'held'

MESSAGE = {
    'socket': 'socket must be a socket or bone name: 1 to 64 letters, digits or _ (hand_r, HandGrip_R).',
    'target': 'target must be a Blueprint\'s /Game/ path or the label of an actor in the level.',
    'no_skeleton': '{target} has no skeletal mesh component to attach to.',
    'no_socket': '{target}\'s skeletal mesh {mesh} has no socket or bone {socket}; it has: {names}.',
    'hidden_socket': ('{target}\'s visible skeletal mesh {mesh} has no socket or bone {socket}; only the hidden '
                      '{hidden} has it, and a mesh held there would follow a skeleton nobody sees. {mesh} has: '
                      '{names}.'),
    'node': 'Unreal did not add the attach node to the construction script: {why}',
    'compile': '{blueprint} did not compile after the attach: {why}',
}


def check(socket: object, offset: object) -> tuple:
    """(socket, (location, rotation, scale)) checked, or Refused."""
    if not isinstance(socket, str) or re.fullmatch(SOCKET, socket) is None:
        raise Refused(MESSAGE['socket'], socket=socket)
    if offset is None:
        return socket, ((0.0, 0.0, 0.0), (0.0, 0.0, 0.0), (1.0, 1.0, 1.0))
    if not isinstance(offset, dict) or not set(offset) <= {'location', 'rotation', 'scale'}:
        raise Refused('offset must be {"location": (x, y, z), "rotation": (pitch, yaw, roll), "scale": (x, y, z)}.')
    location = place.vector(offset.get('location', (0.0, 0.0, 0.0)), 'location')
    if max(abs(location.x), abs(location.y), abs(location.z)) > MAX_OFFSET_CM:
        raise Refused(f'An offset location is at most {MAX_OFFSET_CM:g} cm from the socket.')
    rotation = place.rotator(offset.get('rotation'), 'rotation')
    scale = place.scale3d(offset.get('scale'))
    low, high = args.SCALE_RANGE
    if not all(low <= value <= high for value in (scale.x, scale.y, scale.z)):
        raise Refused(f'An offset scale is from {low:g} to {high:g} on each axis.')
    return socket, ((location.x, location.y, location.z), (rotation.pitch, rotation.yaw, rotation.roll),
                    (scale.x, scale.y, scale.z))


def _shown(component) -> bool:
    """Whether players see a skeletal mesh: visible and not hidden in game."""
    return bool(component.get_editor_property('visible')) and not component.get_editor_property('hidden_in_game')


def _sockets(component) -> list[str]:
    return [str(name) for name in component.get_all_socket_names()]


def _skeletal_component(meshes: list, target: str, socket: str) -> tuple:
    """(name, component) of the skeletal mesh to hold at `socket`, from `meshes` [(name, component)] in
    the order Unreal lists them: the first one players see that has the socket (the first with it when
    none is seen); Refused when it is missing there or only a hidden mesh has it."""
    if not meshes:
        raise Refused(MESSAGE['no_skeleton'].format(target=target))
    shown = [mesh for mesh in meshes if _shown(mesh[1])] or meshes
    held = next((mesh for mesh in shown if socket in _sockets(mesh[1])), None)
    if held is not None:
        return held
    name, component = shown[0]
    names = ', '.join(_sockets(component)[:40])
    hidden = next((other for other, mesh in meshes if socket in _sockets(mesh)), None)
    if hidden is not None:
        raise Refused(MESSAGE['hidden_socket'].format(target=target, mesh=name, socket=socket, hidden=hidden,
                                                      names=names))
    raise Refused(MESSAGE['no_socket'].format(target=target, mesh=name, socket=socket, names=names))


def _blueprint_meshes(blueprint: unreal.Blueprint) -> list:
    """The Blueprint's skeletal mesh components, inherited ones too, as (variable name, the component as
    this Blueprint sets it up) in the order Unreal gathers them. The class defaults list only the
    components a C++ class makes, never one a Blueprint adds (motion_character's Body)."""
    subsystem = unreal.get_engine_subsystem(unreal.SubobjectDataSubsystem)
    library = unreal.SubobjectDataBlueprintFunctionLibrary
    found = {}
    for handle in subsystem.k2_gather_subobject_data_for_blueprint(blueprint):
        data = subsystem.k2_find_subobject_data_from_handle(handle)
        component = library.get_object_for_blueprint(data, blueprint)
        if isinstance(component, unreal.SkeletalMeshComponent):
            found.setdefault(str(library.get_variable_name(data)), component)
    return list(found.items())


def _component_name(mesh: unreal.StaticMesh) -> str:
    """Gx<mesh name> without underscores, so the Blueprint node reading it is named as predictably."""
    return f'{COMPONENT_PREFIX}{mesh.get_name().replace("_", "")}'[:64]


def _place_component(component, mesh, offset) -> None:
    location, rotation, scale = offset
    component.set_editor_property('static_mesh', mesh)
    component.set_editor_property('relative_location', unreal.Vector(*location))
    component.set_editor_property('relative_rotation', unreal.Rotator(roll=rotation[2], pitch=rotation[0], yaw=rotation[1]))
    component.set_editor_property('relative_scale3d', unreal.Vector(*scale))
    component.set_collision_enabled(unreal.CollisionEnabled.NO_COLLISION)


def _on_blueprint(blueprint: unreal.Blueprint, mesh, socket: str, offset) -> dict:
    parent_name = _skeletal_component(_blueprint_meshes(blueprint), blueprint.get_name(), socket)[0]
    name = _component_name(mesh)
    try:
        component = blueprints.add_component(blueprint, 'StaticMeshComponent', name, parent_name)
    except Exception as error:  # noqa: BLE001 - the subsystem refusing the component
        raise Refused(f'Unreal did not add {name}: {short_message(error)}') from None
    _place_component(component, mesh, offset)
    unreal.BlueprintEditorLibrary.compile_blueprint(blueprint)
    parent_getter = CHARACTER_MESH_GETTER if parent_name == CHARACTER_MESH else None
    try:
        blueprints.attach_in_construction_script(blueprint, name, parent_name, parent_getter, socket)
    except Exception as error:  # noqa: BLE001 - Epic's graph tools raise AssertionError and RuntimeError
        raise Refused(MESSAGE['node'].format(why=short_message(error))) from None
    compiled, messages = blueprints.compile_status(blueprint)
    if not compiled:
        raise Refused(MESSAGE['compile'].format(blueprint=blueprint.get_name(), why='; '.join(messages)[:600]))
    saved = bool(unreal.EditorAssetLibrary.save_loaded_asset(blueprint, False))
    return {'blueprint': blueprint.get_path_name().split('.')[0], 'component': name, 'parent': parent_name,
            'socket': socket, 'compiled': compiled, 'saved': saved}


def _on_actor(actor, mesh, socket: str, offset) -> dict:
    meshes = [(component.get_name(), component)
              for component in actor.get_components_by_class(unreal.SkeletalMeshComponent)]
    parent, skeletal = _skeletal_component(meshes, actor.get_actor_label(), socket)
    location, rotation, scale = offset
    label = f'{actor.get_actor_label()}_{_component_name(mesh)}'
    for old in [a for a in editor.actors().get_all_level_actors() if a.get_actor_label() == label]:
        editor.actors().destroy_actor(old)
    held = editor.actors().spawn_actor_from_class(unreal.StaticMeshActor, unreal.Vector(0.0, 0.0, 0.0),
                                                  place.rotator(None))
    held.static_mesh_component.set_static_mesh(mesh)
    held.static_mesh_component.set_collision_enabled(unreal.CollisionEnabled.NO_COLLISION)
    held.static_mesh_component.set_mobility(unreal.ComponentMobility.MOVABLE)
    scope.own(held, label, scope.current_or(HELD_SCOPE))
    rule = unreal.AttachmentRule.SNAP_TO_TARGET
    held.attach_to_component(skeletal, socket, rule, rule, unreal.AttachmentRule.KEEP_WORLD, False)
    held.root_component.set_relative_location_and_rotation(
        unreal.Vector(*location), unreal.Rotator(roll=rotation[2], pitch=rotation[0], yaw=rotation[1]), False, True)
    held.set_actor_scale3d(unreal.Vector(*scale))
    return {'actor': actor.get_actor_label(), 'held': label, 'parent': parent, 'socket': socket}


def attach_to_socket(target, mesh, socket, offset=None) -> dict:
    """Attaches `mesh` to `target`'s skeletal mesh at `socket` (see the module notes)."""
    socket, placed = check(socket, offset)
    static_mesh = place.static_mesh(mesh)
    editor.refuse_during_play()
    if isinstance(target, str) and target.startswith('/Game/'):
        paths.check_object_path(target.split('.')[0], 'target')
        blueprint = unreal.load_asset(target)
        if not isinstance(blueprint, unreal.Blueprint):
            raise Refused(MESSAGE['target'], target=target)
        return _on_blueprint(blueprint, static_mesh, socket, placed)
    found = next((a for a in editor.actors().get_all_level_actors() if a.get_actor_label() == target), None)
    if found is None:
        raise Refused(MESSAGE['target'], target=target)
    return _on_actor(found, static_mesh, socket, placed)
