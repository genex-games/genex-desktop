"""gx.kit_module: one modular kit piece made with Geometry Script and saved as a static mesh asset
/Game/GX/Kit/SM_<name>: Nanite on, simple collision, box-projected UVs, its edges bevelled so they
catch the light. Making a piece of the same name again rewrites the same asset in place, so every
actor using it updates and a build script stays idempotent.

Kinds and their size (x, y, z) in cm:
    slab     a box x by y, z thick (floors, walls, panels)
    rib      an upright rib: z tall, x deep, y wide, tapering toward its front edge
    girder   an I-beam x long, y wide (its flanges), z tall
    stairs   a flight rising z over a run of x, y wide, about 18 cm per step
    pipe     a round pipe of diameter y along x (or along `path`, points in cm)
Every piece sits on its base at the origin, x forward.
"""

import math
import time

import unreal

from genex_loop import editor, paths
from genex_loop.errors import Refused

KIT_FOLDER = '/Game/GX/Kit'
KINDS = ('slab', 'rib', 'girder', 'stairs', 'pipe')
SIZE_RANGE_CM = (0.1, 100_000.0)
DEFAULT_BEVEL_CM = 2.0
MAX_BEVEL_CM = 50.0
STEP_RISE_CM = 18.0
PIPE_SIDES = 16
MAX_PATH_POINTS = 512
# How far a rib's front edge tapers in, and how thick an I-beam's web and flanges are, as shares of its size.
RIB_TAPER = 0.35
FLANGE_SHARE = 0.12
WEB_SHARE = 0.18
# Box UVs: one texture tile per this many cm.
UV_TILE_CM = 200.0

MESSAGE = {
    'kind': f'kind must be one of {", ".join(KINDS)}.',
    'size': f'size must be three numbers (x, y, z) in cm, each from {SIZE_RANGE_CM[0]:g} to {SIZE_RANGE_CM[1]:g}.',
    'bevel': f'bevel_cm must be from 0 to {MAX_BEVEL_CM:g}.',
    'path': f'path must be 2 to {MAX_PATH_POINTS} (x, y, z) points in cm.',
    'other': '{path} is not a static mesh; choose another name.',
    'made': 'Unreal did not make the static mesh {path}.',
}


def _size(size: object) -> tuple:
    good = isinstance(size, (tuple, list)) and len(size) == 3
    if not good or not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
                           and SIZE_RANGE_CM[0] <= v <= SIZE_RANGE_CM[1] for v in size):
        raise Refused(MESSAGE['size'], size=repr(size)[:80])
    return tuple(float(v) for v in size)


def check(kind: object, name: object, size: object, bevel_cm: object) -> tuple:
    """(kind, name, size, bevel) checked, or Refused; nothing in the editor changes."""
    if kind not in KINDS:
        raise Refused(MESSAGE['kind'], kind=kind)
    if not paths.is_name(name):
        raise Refused(paths.MESSAGE['name'], name=name)
    bevel = bevel_cm if bevel_cm is not None else DEFAULT_BEVEL_CM
    if not isinstance(bevel, (int, float)) or isinstance(bevel, bool) or not 0 <= bevel <= MAX_BEVEL_CM:
        raise Refused(MESSAGE['bevel'], bevel_cm=bevel_cm)
    return kind, name, _size(size), float(bevel)


def _options() -> unreal.GeometryScriptPrimitiveOptions:
    options = unreal.GeometryScriptPrimitiveOptions()
    options.set_editor_property('polygroup_mode', unreal.GeometryScriptPrimitivePolygroupMode.PER_FACE)
    return options


def _identity() -> unreal.Transform:
    return unreal.Transform(unreal.Vector(0.0, 0.0, 0.0), unreal.Rotator(roll=0.0, pitch=0.0, yaw=0.0),
                            unreal.Vector(1.0, 1.0, 1.0))


def _turned(pitch: float, yaw: float, roll: float, location=(0.0, 0.0, 0.0)) -> unreal.Transform:
    return unreal.Transform(unreal.Vector(*location), unreal.Rotator(roll=roll, pitch=pitch, yaw=yaw),
                            unreal.Vector(1.0, 1.0, 1.0))


def _polygon(points: list) -> list:
    return [unreal.Vector2D(float(u), float(v)) for u, v in points]


def _slab(mesh, size) -> None:
    x, y, z = size
    unreal.GeometryScript_Primitives.append_box(mesh, _options(), _identity(), x, y, z, 0, 0, 0,
                                                unreal.GeometryScriptPrimitiveOriginMode.BASE)


def _rib(mesh, size) -> None:
    # A profile in (x, y) extruded up z: full width at the back, tapered toward the front edge.
    x, y, z = size
    half, front = y / 2, y / 2 * (1 - RIB_TAPER)
    profile = [(-x / 2, -half), (x / 2, -front), (x / 2, front), (-x / 2, half)]
    unreal.GeometryScript_Primitives.append_simple_extrude_polygon(mesh, _options(), _identity(), _polygon(profile), z,
                                                                   0, True, unreal.GeometryScriptPrimitiveOriginMode.BASE)


def _girder(mesh, size) -> None:
    # An I profile in (y, z) extruded along x. The extrusion runs up its own z, so the profile is turned
    # by pitch -90 (its z becomes x, its x becomes -z): a profile point (y, z) is the polygon point (-z, y).
    x, y, z = size
    flange, web = z * FLANGE_SHARE, y * WEB_SHARE
    hy, hw = y / 2, web / 2
    profile = [(-hy, 0), (hy, 0), (hy, flange), (hw, flange), (hw, z - flange), (hy, z - flange), (hy, z), (-hy, z),
               (-hy, z - flange), (-hw, z - flange), (-hw, flange), (-hy, flange)]
    unreal.GeometryScript_Primitives.append_simple_extrude_polygon(
        mesh, _options(), _turned(-90.0, 0.0, 0.0, (-x / 2, 0.0, 0.0)), _polygon([(-v, u) for u, v in profile]), x, 0,
        True, unreal.GeometryScriptPrimitiveOriginMode.BASE)


def _stairs(mesh, size) -> None:
    x, y, z = size
    steps = max(1, round(z / STEP_RISE_CM))
    unreal.GeometryScript_Primitives.append_linear_stairs(mesh, _options(), _identity(), y, z / steps, x / steps, steps,
                                                          False)


def _path(path: object, length: float) -> list:
    if path is None:
        return [(-length / 2, 0.0, 0.0), (length / 2, 0.0, 0.0)]
    good = isinstance(path, (list, tuple)) and 2 <= len(path) <= MAX_PATH_POINTS
    if not good:
        raise Refused(MESSAGE['path'])
    return [_size_free(point) for point in path]


def _size_free(point: object) -> tuple:
    good = isinstance(point, (tuple, list)) and len(point) == 3
    if not good or not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in point):
        raise Refused(MESSAGE['path'])
    return tuple(float(v) for v in point)


def _pipe(mesh, size, path) -> None:
    x, y, _z = size
    radius = y / 2
    circle = [(radius * math.cos(2 * math.pi * i / PIPE_SIDES), radius * math.sin(2 * math.pi * i / PIPE_SIDES))
              for i in range(PIPE_SIDES)]
    points = [unreal.Vector(*point) for point in _path(path, x)]
    unreal.GeometryScript_Primitives.append_simple_swept_polygon(mesh, _options(), _identity(), _polygon(circle), points,
                                                                 False, True, 1.0, 1.0, 0.0, 1.0)


def _shape(mesh, kind: str, size: tuple, path: object) -> None:
    if kind == 'slab':
        _slab(mesh, size)
    elif kind == 'rib':
        _rib(mesh, size)
    elif kind == 'girder':
        _girder(mesh, size)
    elif kind == 'stairs':
        _stairs(mesh, size)
    else:
        _pipe(mesh, size, path)


def _finish(mesh, bevel: float) -> None:
    """Bevels every face group's edges, recomputes normals and projects box UVs."""
    if bevel > 0:
        options = unreal.GeometryScriptMeshBevelOptions()
        options.set_editor_property('bevel_distance', bevel)
        options.set_editor_property('subdivisions', 1)
        unreal.GeometryScript_MeshModeling.apply_mesh_polygroup_bevel(mesh, options)
    unreal.GeometryScript_Normals.recompute_normals(mesh, unreal.GeometryScriptCalculateNormalsOptions())
    box = unreal.Transform(unreal.Vector(0.0, 0.0, 0.0), unreal.Rotator(roll=0.0, pitch=0.0, yaw=0.0),
                           unreal.Vector(UV_TILE_CM, UV_TILE_CM, UV_TILE_CM))
    unreal.GeometryScript_UVs.set_mesh_u_vs_from_box_projection(mesh, 0, box, unreal.GeometryScriptMeshSelection(), 2)


def _collision_method(kind: str):
    if kind in ('slab', 'girder'):
        return unreal.GeometryScriptCollisionGenerationMethod.ALIGNED_BOXES
    return unreal.GeometryScriptCollisionGenerationMethod.CONVEX_HULLS


def _nanite() -> unreal.MeshNaniteSettings:
    settings = unreal.MeshNaniteSettings()
    settings.set_editor_property('enabled', True)
    return settings


def _write(mesh, path: str, name: str) -> unreal.StaticMesh:
    """The mesh saved as the static mesh asset at `path`: rewritten in place when it exists."""
    library = unreal.EditorAssetLibrary
    if library.does_asset_exist(path):
        existing = unreal.load_asset(path)
        if not isinstance(existing, unreal.StaticMesh):
            raise Refused(MESSAGE['other'].format(path=path), mesh=path)
        options = unreal.GeometryScriptCopyMeshToAssetOptions()
        options.set_editor_property('apply_nanite_settings', True)
        options.set_editor_property('new_nanite_settings', _nanite())
        options.set_editor_property('enable_recompute_normals', False)
        unreal.GeometryScript_AssetUtils.copy_mesh_to_static_mesh(mesh, existing, options,
                                                                   unreal.GeometryScriptMeshWriteLOD(), True)
        return existing
    options = unreal.GeometryScriptCreateNewStaticMeshAssetOptions()
    options.set_editor_property('enable_nanite', True)
    options.set_editor_property('nanite_settings', _nanite())
    options.set_editor_property('enable_recompute_normals', False)
    made = unreal.GeometryScript_NewAssetUtils.create_new_static_mesh_asset_from_mesh(mesh, path, options)
    asset = next((item for item in made if isinstance(item, unreal.StaticMesh)), None) if isinstance(made, tuple) else made
    if not isinstance(asset, unreal.StaticMesh):
        raise Refused(MESSAGE['made'].format(path=path), mesh=name)
    return asset


def kit_module(kind, name, size, bevel_cm=None, path=None):
    """The kit piece SM_<name> (see the module notes); answers the StaticMesh asset."""
    kind, name, size, bevel = check(kind, name, size, bevel_cm)
    started = time.perf_counter()
    mesh = unreal.DynamicMesh()
    _shape(mesh, kind, size, path)
    _finish(mesh, bevel)
    asset_path = f'{KIT_FOLDER}/SM_{name}'
    asset = _write(mesh, asset_path, name)
    collision = unreal.GeometryScriptCollisionFromMeshOptions()
    collision.set_editor_property('method', _collision_method(kind))
    unreal.GeometryScript_Collision.set_static_mesh_collision_from_mesh(mesh, asset, collision)
    unreal.EditorAssetLibrary.save_loaded_asset(asset, False)
    unreal.log(f'gx.kit_module {asset_path}: {kind} {size} in {editor.elapsed_ms(started)} ms')
    return asset

