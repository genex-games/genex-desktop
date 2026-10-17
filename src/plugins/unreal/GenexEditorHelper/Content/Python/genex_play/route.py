"""The game's route: the spline of the actor tagged GenexRoute (genex_build.set_route makes it),
read from a world as a route_math polyline, and the player measured against it (probe_route)."""

import math

import unreal

from genex_play import play, route_math

ROUTE_TAG = 'GenexRoute'
# The spline is read as points this far apart, at most MAX_SAMPLES of them.
SAMPLE_CM = 100.0
MAX_SAMPLES = 2000

NO_ROUTE = {'route': False, 'facingDeg': None, 'offRouteCm': None, 'progressM': None, 'lengthM': None}


def route_actor(world: unreal.World) -> unreal.Actor | None:
    """The first actor (by label) tagged GenexRoute that carries a spline, or None."""
    tagged = [actor for actor in unreal.GameplayStatics.get_all_actors_of_class(world, unreal.Actor)
              if ROUTE_TAG in [str(tag) for tag in actor.tags]]
    for actor in sorted(tagged, key=lambda a: a.get_actor_label()):
        if actor.get_component_by_class(unreal.SplineComponent) is not None:
            return actor
    return None


def sample(spline: unreal.SplineComponent, spacing_cm: float = SAMPLE_CM) -> route_math.Route | None:
    """The spline as a polyline of world points about spacing_cm apart; None when it is too short to steer by."""
    length = float(spline.get_spline_length())
    if not math.isfinite(length) or length <= route_math.SAME_POINT_CM:
        return None
    closed = bool(spline.is_closed_loop())
    count = max(2, min(MAX_SAMPLES, math.ceil(length / spacing_cm)))
    step = length / count
    distances = [i * step for i in range(count + (0 if closed else 1))]
    world = unreal.SplineCoordinateSpace.WORLD
    points = []
    for distance in distances:
        at = spline.get_location_at_distance_along_spline(distance, world)
        points.append((float(at.x), float(at.y)))
    try:
        return route_math.make_route(points, closed)
    except ValueError:  # every sample in one place
        return None


def find_route(world: unreal.World, spacing_cm: float = SAMPLE_CM) -> route_math.Route | None:
    """The world's route as a polyline, or None when it has none."""
    actor = route_actor(world)
    if actor is None:
        return None
    return sample(actor.get_component_by_class(unreal.SplineComponent), spacing_cm)


def probe_route() -> dict:
    """The player against the route: facing (0 to 180 degrees off its direction), how far off it, how far along."""
    pawn = play.player_pawn()
    route = find_route(play.game_world())
    if route is None:
        return dict(NO_ROUTE)
    location = pawn.get_actor_location()
    yaw = float(pawn.get_actor_rotation().yaw)
    near = route_math.nearest(route, float(location.x), float(location.y))
    facing = abs(route_math.wrap_deg(yaw - route_math.heading_deg(near.tx, near.ty)))
    return {'route': True, 'facingDeg': round(facing, 1),
            'offRouteCm': round(near.distance), 'progressM': round(near.s / 100, 1),
            'lengthM': round(route.length / 100, 1)}
