"""set_route: the game's route as a spline on an actor tagged GenexRoute (and genex:route), with
the level's PlayerStart moved to its first point facing its second.

The spline is an instance component of a plain actor in the level, added through the
SubobjectDataSubsystem as the Details panel's Add Component does; its points are set in world
space. A route already in the level is moved, never duplicated.
"""

import math

import unreal

from genex_build import args, terrain_math
from genex_loop import blueprints, editor
from genex_loop.errors import Refused
from genex_play import route, route_math

ROUTE_LABEL = 'GenexRoute'
ROUTE_FEATURE_TAG = 'genex:route'
OUTLINER_FOLDER = 'Genex'
# A seed route's length in metres, and the shortest route a car can be driven along (cm).
ROUTE_M = (20.0, 3000.0)
MIN_ROUTE_CM = 2000.0
# The PlayerStart stands this far above the route's first point, so the pawn drops onto the ground.
SPAWN_LIFT_CM = 150.0


def plan_points(points: str, seed: int, closed: bool, length_m: float) -> list:
    """The route's [(x, y, z)] cm from JSON points, or else from a seed; Refused when it isn't a drivable route."""
    if points != '':
        rows = args.route_points(points)
    else:
        rows = terrain_math.route_points(args.seed(seed), args.number(length_m, 'length_m', *ROUTE_M), closed)
    try:
        length = route_math.make_route(rows, closed).length
    except ValueError as error:
        raise Refused(str(error)) from None
    if length < MIN_ROUTE_CM:
        raise Refused(f'The route is {length / 100:.1f} m; a route is at least {MIN_ROUTE_CM / 100:g} m.')
    return rows


def _spline_of(actor: unreal.Actor) -> unreal.SplineComponent:
    """The actor's spline, added as an instance component when it has none."""
    found = actor.get_component_by_class(unreal.SplineComponent)
    if found is not None:
        return found
    subsystem = unreal.get_engine_subsystem(unreal.SubobjectDataSubsystem)
    handles = subsystem.k2_gather_subobject_data_for_instance(actor)
    # The actor's own handle comes first; its root scene component, when it has one, next.
    parent = handles[1] if len(handles) > 1 else handles[0]
    spline_class = blueprints.unreal_class(unreal.SplineComponent, unreal.ActorComponent)
    params = unreal.AddNewSubobjectParams(parent_handle=parent, new_class=spline_class, blueprint_context=None)
    _handle, failure = subsystem.add_new_subobject(params)
    if str(failure) not in ('', 'None'):
        raise Refused(f'Unreal did not add the route spline: {failure}')
    made = actor.get_component_by_class(unreal.SplineComponent)
    if made is None:
        raise Refused('Unreal did not add the route spline.')
    return made


def _route_actor(first: tuple) -> unreal.Actor:
    """The level's route actor, or a new one at the route's first point."""
    found = route.route_actor(editor.editor_subsystem().get_editor_world())
    if found is not None:
        return found
    actor = editor.actors().spawn_actor_from_class(unreal.Actor, unreal.Vector(*first), unreal.Rotator())
    if actor is None:
        raise Refused('Unreal did not place the route actor.')
    actor.set_actor_label(ROUTE_LABEL)
    actor.tags = list(actor.tags) + [unreal.Name(route.ROUTE_TAG), unreal.Name(ROUTE_FEATURE_TAG)]
    actor.set_folder_path(unreal.Name(OUTLINER_FOLDER))
    return actor


def _place_player_start(first: tuple, second: tuple) -> dict:
    """Moves the level's first PlayerStart (or a new one) above the first point, facing the second."""
    yaw = round(math.degrees(math.atan2(second[1] - first[1], second[0] - first[0])), 1)
    location = unreal.Vector(first[0], first[1], first[2] + SPAWN_LIFT_CM)
    rotation = unreal.Rotator(roll=0.0, pitch=0.0, yaw=yaw)
    starts = sorted((a for a in editor.actors().get_all_level_actors() if isinstance(a, unreal.PlayerStart)),
                    key=lambda a: a.get_actor_label())
    if starts:
        starts[0].set_actor_location_and_rotation(location, rotation, False, True)
    else:
        editor.actors().spawn_actor_from_class(unreal.PlayerStart, location, rotation)
    return {'location': [round(first[0]), round(first[1]), round(first[2] + SPAWN_LIFT_CM)], 'yaw': yaw}


def lay_route(rows: list, closed: bool) -> dict:
    """Sets the route's spline through rows (world cm) and moves the PlayerStart to its start."""
    with unreal.ScopedEditorTransaction('Genex: set the route'):
        actor = _route_actor(rows[0])
        spline = _spline_of(actor)
        spline.set_spline_points([unreal.Vector(*row) for row in rows], unreal.SplineCoordinateSpace.WORLD, True)
        spline.set_closed_loop(closed, True)
        start = _place_player_start(rows[0], rows[1])
    return {'route': actor.get_actor_label(), 'points': len(rows),
            'lengthM': round(float(spline.get_spline_length()) / 100, 1), 'closed': closed, 'playerStart': start}


def set_route(points: str, seed: int, closed: bool, length_m: float) -> dict:
    """The route from JSON points or a seed (see GenexBuildTools.set_route)."""
    editor.refuse_during_play()
    return lay_route(plan_points(points, seed, bool(closed), length_m), bool(closed))
