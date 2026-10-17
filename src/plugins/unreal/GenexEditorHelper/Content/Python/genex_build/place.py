"""Placing things in the editor level for build scripts: a static mesh actor (gx.spawn_mesh), many
copies of one mesh as ONE actor holding a hierarchical instanced static mesh component (gx.instances,
the cheap way to repeat a module a thousand times), lights (gx.light) and the hero shot cameras
(gx.shot_camera, CameraActors labelled GX_Shot_<name> that save points and capture_shot use). Every
actor belongs to the open scope (see scope.py); a hero camera to the gx:shot scope.

Positions are (x, y, z) in cm, rotations (pitch, yaw, roll) in degrees, scales (x, y, z) or one number.
"""

import math

import unreal

from genex_build import scope
from genex_loop import editor, paths
from genex_loop.errors import Refused

SHOT_PREFIX = 'GX_Shot_'
MAX_INSTANCES = 100_000
FOV_RANGE = (5.0, 170.0)
# The temperature a light without a colour gets: a pale cool white.
DEFAULT_KELVIN = 6500.0
LIGHT_CLASSES = {'point': 'PointLight', 'spot': 'SpotLight', 'rect': 'RectLight'}

MESSAGE = {
    'mesh': 'mesh must be a StaticMesh, or the /Game/ path of one.',
    'material': 'material must be a material or material instance, or the /Game/ path of one.',
    'triple': '{field} must be three finite numbers.',
    'transforms': f'transforms must be a list of 1 to {MAX_INSTANCES} entries: (x, y, z), or (location, rotation[, scale]), or unreal.Transform.',
    'light': f'kind must be one of {", ".join(LIGHT_CLASSES)}.',
    'camera_name': 'A shot camera\'s name is a letter, then up to 63 letters, digits or _.',
    'fov': f'fov must be from {FOV_RANGE[0]:g} to {FOV_RANGE[1]:g} degrees.',
    'subobject': 'Unreal did not add the instanced mesh component: {why}',
}


def _finite_triple(value: object, field: str) -> tuple:
    numbers = isinstance(value, (tuple, list)) and len(value) == 3
    if not numbers or not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in value):
        raise Refused(MESSAGE['triple'].format(field=field), **{field: repr(value)[:80]})
    return tuple(float(v) for v in value)


def vector(value: object, field: str = 'location') -> unreal.Vector:
    """An unreal.Vector from (x, y, z) or a Vector."""
    if isinstance(value, unreal.Vector):
        return value
    x, y, z = _finite_triple(value, field)
    return unreal.Vector(x, y, z)


def rotator(value: object, field: str = 'rotation') -> unreal.Rotator:
    """An unreal.Rotator from (pitch, yaw, roll), a Rotator, or None for no rotation."""
    if value is None:
        return unreal.Rotator(roll=0.0, pitch=0.0, yaw=0.0)
    if isinstance(value, unreal.Rotator):
        return value
    pitch, yaw, roll = _finite_triple(value, field)
    return unreal.Rotator(roll=roll, pitch=pitch, yaw=yaw)


def scale3d(value: object) -> unreal.Vector:
    """An unreal.Vector scale from one number, (x, y, z), a Vector, or None for 1."""
    if value is None:
        return unreal.Vector(1.0, 1.0, 1.0)
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return vector((value, value, value), 'scale')
    return vector(value, 'scale')


def transform(entry: object) -> unreal.Transform:
    """An unreal.Transform from (x, y, z), (location, rotation[, scale]) or a Transform."""
    if isinstance(entry, unreal.Transform):
        return entry
    if isinstance(entry, (tuple, list)) and len(entry) == 3 and not isinstance(entry[0], (tuple, list)):
        return unreal.Transform(vector(entry), rotator(None), scale3d(None))
    if isinstance(entry, (tuple, list)) and len(entry) in (2, 3):
        return unreal.Transform(vector(entry[0]), rotator(entry[1]), scale3d(entry[2] if len(entry) == 3 else None))
    raise Refused(MESSAGE['transforms'])


def static_mesh(mesh: object) -> unreal.StaticMesh:
    """A StaticMesh from itself or its /Game/ (or /Engine/) path, or Refused."""
    if isinstance(mesh, unreal.StaticMesh):
        return mesh
    loaded = unreal.load_asset(mesh) if isinstance(mesh, str) and mesh.startswith(('/Game/', '/Engine/')) else None
    if not isinstance(loaded, unreal.StaticMesh):
        raise Refused(MESSAGE['mesh'], mesh=repr(mesh)[:120])
    return loaded


def material(value: object) -> unreal.MaterialInterface:
    """A material (or instance) from itself or its /Game/ (or /Engine/) path, or Refused."""
    if isinstance(value, unreal.MaterialInterface):
        return value
    loaded = unreal.load_asset(value) if isinstance(value, str) and value.startswith(('/Game/', '/Engine/')) else None
    if not isinstance(loaded, unreal.MaterialInterface):
        raise Refused(MESSAGE['material'], material=repr(value)[:120])
    return loaded


def _set_mesh(component, mesh: unreal.StaticMesh, override: object, collision: bool) -> None:
    component.set_static_mesh(mesh)
    if override is not None:
        component.set_material(0, material(override))
    if not collision:
        component.set_collision_enabled(unreal.CollisionEnabled.NO_COLLISION)


def spawn_mesh(mesh, location, rotation=None, scale=None, label=None, material=None, collision=True):
    """A StaticMeshActor of `mesh` at `location`, in the open scope."""
    checked = static_mesh(mesh)
    actor = editor.actors().spawn_actor_from_class(unreal.StaticMeshActor, vector(location), rotator(rotation))
    actor.set_actor_scale3d(scale3d(scale))
    _set_mesh(actor.static_mesh_component, checked, material, collision)
    return scope.own(actor, label)


def _instanced_component(actor) -> unreal.HierarchicalInstancedStaticMeshComponent:
    """A hierarchical instanced static mesh component added to a level actor, the way the Details panel adds one."""
    subsystem = unreal.get_engine_subsystem(unreal.SubobjectDataSubsystem)
    [owner, *_rest] = subsystem.k2_gather_subobject_data_for_instance(actor)
    params = unreal.AddNewSubobjectParams(parent_handle=owner, new_class=unreal.HierarchicalInstancedStaticMeshComponent,
                                          blueprint_context=None)
    added = subsystem.add_new_subobject(params)
    handle = next((item for item in added if isinstance(item, unreal.SubobjectDataHandle)), None)
    why = next((str(item) for item in added if isinstance(item, unreal.Text)), '')
    data = subsystem.k2_find_subobject_data_from_handle(handle) if handle is not None else None
    component = unreal.SubobjectDataBlueprintFunctionLibrary.get_object(data) if data is not None else None
    if not isinstance(component, unreal.HierarchicalInstancedStaticMeshComponent):
        raise Refused(MESSAGE['subobject'].format(why=why or 'no component'))
    return component


def instances(mesh, transforms, label=None, material=None, collision=True, cull_m=0.0):
    """One actor drawing `mesh` at every transform (world space) through one instanced component, in the open scope."""
    checked = static_mesh(mesh)
    if not isinstance(transforms, (list, tuple)) or not 0 < len(transforms) <= MAX_INSTANCES:
        raise Refused(MESSAGE['transforms'])
    placed = [transform(entry) for entry in transforms]
    actor = editor.actors().spawn_actor_from_class(unreal.Actor, unreal.Vector(0.0, 0.0, 0.0), rotator(None))
    component = _instanced_component(actor)
    # The subsystem gives the actor a movable default root; a static component under a movable
    # parent is dropped when the level loads again ("AttachTo ... is not static"), so both are static.
    for part in (actor.root_component, component):
        part.set_mobility(unreal.ComponentMobility.STATIC)
    _set_mesh(component, checked, material, collision)
    if cull_m:
        component.set_cull_distances(0, int(float(cull_m) * 100))
    component.add_instances(placed, False, True)
    return scope.own(actor, label)


def _color(color: object, kelvin: object) -> tuple:
    """(LinearColor, use temperature, temperature): a colour (r, g, b, 0 to 1) or a temperature in K."""
    if color is not None:
        r, g, b = _finite_triple(color, 'color')
        return unreal.LinearColor(r=r, g=g, b=b, a=1.0), False, DEFAULT_KELVIN
    temperature = float(kelvin) if kelvin is not None else DEFAULT_KELVIN
    return unreal.LinearColor(r=1.0, g=1.0, b=1.0, a=1.0), True, temperature


def light(kind, location, rotation=None, intensity=10.0, color=None, kelvin=None, radius_m=10.0,
          volumetric=1.0, shadows=True, label=None):
    """A point, spot or rect light in the open scope; intensity in the light's own units (candela for
    point and spot, lumens-like for rect), radius_m its attenuation radius, volumetric how strongly it
    lights the volumetric fog."""
    if kind not in LIGHT_CLASSES:
        raise Refused(MESSAGE['light'], kind=kind)
    cls = unreal.load_class(None, f'/Script/Engine.{LIGHT_CLASSES[kind]}')
    actor = editor.actors().spawn_actor_from_class(cls, vector(location), rotator(rotation))
    component = actor.get_component_by_class(unreal.LocalLightComponent)
    linear, use_temperature, temperature = _color(color, kelvin)
    component.set_intensity(float(intensity))
    component.set_light_color(linear, True)
    component.set_use_temperature(use_temperature)
    component.set_temperature(temperature)
    component.set_attenuation_radius(float(radius_m) * 100)
    component.set_volumetric_scattering_intensity(float(volumetric))
    component.set_cast_shadows(bool(shadows))
    return scope.own(actor, label)


def _shot_label(name: object) -> str:
    if not paths.is_name(name):
        raise Refused(MESSAGE['camera_name'], name=name)
    return f'{SHOT_PREFIX}{name}'


def shot_cameras() -> list:
    """The level's hero cameras (CameraActors labelled GX_Shot_*), by label."""
    found = [a for a in editor.actors().get_all_level_actors()
             if isinstance(a, unreal.CameraActor) and a.get_actor_label().startswith(SHOT_PREFIX)]
    return sorted(found, key=lambda actor: actor.get_actor_label())


def find_camera(name: str):
    """The CameraActor labelled `name` or GX_Shot_`name`, or None."""
    wanted = {name, f'{SHOT_PREFIX}{name}'}
    return next((a for a in editor.actors().get_all_level_actors()
                 if isinstance(a, unreal.CameraActor) and a.get_actor_label() in wanted), None)


def shot_camera(name, location, rotation, fov=60.0):
    """The hero camera GX_Shot_<name> (replacing one of that name) at `location` looking along `rotation`."""
    label = _shot_label(name)
    if not isinstance(fov, (int, float)) or not FOV_RANGE[0] <= fov <= FOV_RANGE[1]:
        raise Refused(MESSAGE['fov'], fov=fov)
    place, turn = vector(location), rotator(rotation)
    for old in [a for a in shot_cameras() if a.get_actor_label() == label]:
        editor.actors().destroy_actor(old)
    camera = editor.actors().spawn_actor_from_class(unreal.CameraActor, place, turn)
    camera.camera_component.set_field_of_view(float(fov))
    camera.camera_component.set_constraint_aspect_ratio(False)
    return scope.own(camera, label, scope.SHOT_SCOPE)
