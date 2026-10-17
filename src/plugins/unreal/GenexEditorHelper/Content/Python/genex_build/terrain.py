"""track_terrain: the ground along the game's route, built with Geometry Script as it works on
Unreal 5.8.3:

append_rectangle_xy makes a flat grid over the route and its banks; get_all_vertex_positions and
convert_vector_list_to_array read its vertices; each takes its height from terrain_math (pure,
tested outside the editor); convert_array_to_vector_list and set_all_mesh_vertex_positions put
them back; recompute_normals, a planar UV projection, then create_new_static_mesh_asset_from_mesh
with complex-as-simple collision makes the asset (normals already made). Out-params come back as
tuples, so values are picked by type (outs.pick). A 200 x 24 m grid at 25 cm (77k vertices) takes
about 0.4 s to shape and 10 s to become an asset.

No Landscape: Python cannot create Landscape components. The ground is a StaticMeshActor tagged
genex:terrain; a later terrain replaces its mesh with a new asset.
"""

import time

import unreal

from genex_build import args, outs, routes, terrain_math
from genex_loop import editor
from genex_loop.errors import Refused
from genex_play import route, route_math

TERRAIN_TAG = 'genex:terrain'
TERRAIN_LABEL = 'GenexTerrain'
TERRAIN_FOLDER = '/Game/Genex/Terrain'
TERRAIN_ASSET = 'SM_GenexTerrain'
MAX_ASSET_COPIES = 999
# The route is read as points this far apart for the terrain (its curves stay within a few cm).
ROUTE_SAMPLE_CM = 300.0
WIDTH_M = (4.0, 60.0)
MAX_WHOOPS = 40
MAX_JUMPS = 6
# The planar UV projection's scale.
UV_SCALE = (4.0, 4.0, 1.0)


def _route(length_m: float) -> tuple:
    """(the route to follow, the straight rows to lay first when the level has none)."""
    actor = route.route_actor(editor.editor_subsystem().get_editor_world())
    spline = actor.get_component_by_class(unreal.SplineComponent) if actor is not None else None
    found = route.sample(spline, ROUTE_SAMPLE_CM) if spline is not None else None
    if found is not None:
        return found, None
    rows = [(0.0, 0.0, 0.0), (length_m * 100.0, 0.0, 0.0)]
    return route_math.make_route(rows, False), rows


def _shaped_mesh(track: terrain_math.Track) -> tuple:
    """(the shaped DynamicMesh, its vertex count): a grid over the track, each vertex at the terrain's height."""
    grid = terrain_math.grid(track)
    mesh = unreal.DynamicMesh()
    centre = unreal.Transform(location=unreal.Vector(grid.center_x, grid.center_y, 0.0))
    unreal.GeometryScript_Primitives.append_rectangle_xy(mesh, unreal.GeometryScriptPrimitiveOptions(), centre,
                                                         grid.size_x, grid.size_y, grid.steps_x, grid.steps_y)
    found = unreal.GeometryScript_MeshQueries.get_all_vertex_positions(mesh, False)
    listed = outs.pick(found, unreal.GeometryScriptVectorList, 'vertex list')
    positions = outs.pick(unreal.GeometryScript_List.convert_vector_list_to_array(listed), unreal.Array, 'vertices')
    flat = [(float(v.x), float(v.y)) for v in positions]
    heights = terrain_math.heights_cm(track, flat)
    shaped = [unreal.Vector(x, y, z) for (x, y), z in zip(flat, heights)]
    moved = outs.pick(unreal.GeometryScript_List.convert_array_to_vector_list(shaped), unreal.GeometryScriptVectorList,
                      'vertex list')
    unreal.GeometryScript_MeshEdits.set_all_mesh_vertex_positions(mesh, moved)
    unreal.GeometryScript_Normals.recompute_normals(mesh, unreal.GeometryScriptCalculateNormalsOptions())
    unreal.GeometryScript_UVs.set_mesh_u_vs_from_planar_projection(
        mesh, 0, unreal.Transform(scale=unreal.Vector(*UV_SCALE)), unreal.GeometryScriptMeshSelection())
    return mesh, len(shaped)


def _free_path() -> str:
    """The first terrain asset path not taken yet."""
    for copy in range(1, MAX_ASSET_COPIES + 1):
        name = TERRAIN_ASSET if copy == 1 else f'{TERRAIN_ASSET}_{copy}'
        path = f'{TERRAIN_FOLDER}/{name}'
        if not unreal.EditorAssetLibrary.does_asset_exist(path):
            return path
    raise Refused(f'{TERRAIN_FOLDER} already holds {MAX_ASSET_COPIES} terrains; delete some first.')


def _make_asset(mesh) -> tuple:
    """(the new StaticMesh, its path), with complex-as-simple collision and the normals already made."""
    path = _free_path()
    options = unreal.GeometryScriptCreateNewStaticMeshAssetOptions(
        enable_collision=True, collision_mode=unreal.CollisionTraceFlag.CTF_USE_COMPLEX_AS_SIMPLE,
        enable_recompute_normals=False)
    made = unreal.GeometryScript_NewAssetUtils.create_new_static_mesh_asset_from_mesh(mesh, path, options)
    return outs.pick(made, unreal.StaticMesh, f'terrain mesh asset at {path}'), path


def _terrain_actor(static_mesh: unreal.StaticMesh) -> unreal.Actor:
    """The level's terrain actor showing the new mesh, or a new one tagged genex:terrain."""
    tagged = [a for a in editor.actors().get_all_level_actors() if TERRAIN_TAG in [str(t) for t in a.tags]]
    for actor in sorted(tagged, key=lambda a: a.get_actor_label()):
        component = actor.get_component_by_class(unreal.StaticMeshComponent)
        if component is not None:
            component.set_static_mesh(static_mesh)
            return actor
    actor = editor.actors().spawn_actor_from_object(static_mesh, unreal.Vector(0.0, 0.0, 0.0), unreal.Rotator())
    if actor is None:
        raise Refused('Unreal did not place the terrain.')
    actor.set_actor_label(TERRAIN_LABEL)
    actor.tags = list(actor.tags) + [unreal.Name(TERRAIN_TAG)]
    actor.set_folder_path(unreal.Name(routes.OUTLINER_FOLDER))
    return actor


def track_terrain(seed: int, length_m: float, width_m: float, whoops: int, jumps: int) -> dict:
    """The ground along the route (a straight one of length_m laid first when the level has none)."""
    planted = args.seed(seed)
    length = args.number(length_m, 'length_m', *routes.ROUTE_M)
    width = args.number(width_m, 'width_m', *WIDTH_M)
    bumps = args.count(whoops, 'whoops', 0, MAX_WHOOPS)
    kickers = args.count(jumps, 'jumps', 0, MAX_JUMPS)
    editor.refuse_during_play()
    started = time.perf_counter()
    path, straight = _route(length)
    try:
        track = terrain_math.plan_track(path, width * 100.0, bumps, kickers, planted)
    except ValueError as error:
        raise Refused(str(error)) from None
    if straight is not None:
        routes.lay_route(straight, False)
    mesh, vertices = _shaped_mesh(track)
    static_mesh, asset = _make_asset(mesh)
    with unreal.ScopedEditorTransaction('Genex: lay the terrain'):
        actor = _terrain_actor(static_mesh)
    return {'mesh': asset, 'actor': actor.get_actor_label(), 'vertices': vertices,
            'lengthM': round(path.length / 100, 1), 'widthM': width, 'ms': editor.elapsed_ms(started)}
