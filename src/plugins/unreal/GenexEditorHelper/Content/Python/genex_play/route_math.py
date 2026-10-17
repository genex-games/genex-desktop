"""The maths of a route: a polyline on the ground (cm, Unreal's X and Y), open or closed.

Pure: no `unreal`, so the drive's steering, the route probe and the terrain builder share it and
it is tested outside the editor. Unreal's axes: X forward, Y right, Z up. A positive yaw turns
from +X toward +Y, a right turn; so a positive lateral offset is right of the route, a positive
curvature turns right and a positive steer turns right (the vehicle template's Steering).
"""

import math
from typing import NamedTuple

# How far ahead of the pawn's nearest route point the drive aims.
LOOK_AHEAD_CM = 1500.0
# The heading error that gives a full steer.
FULL_LOCK_DEG = 35.0
# Points closer than this to the previous one are the same point.
SAME_POINT_CM = 0.01
# A test drive is a steady lap, not a race: its top pace, the slowest it slows to for a bend, and the
# sideways grip (m/s2) a bend's pace is worked out from (pace = sqrt(grip x radius)).
MAX_PACE_KMH = 70.0
MIN_PACE_KMH = 25.0
GRIP_MS2 = 4.0
# How far ahead the pace looks for bends, how often it looks, and the stretch a bend is measured over.
PACE_AHEAD_CM = 4000.0
PACE_STEP_CM = 500.0
PACE_SPAN_CM = 1500.0
# Over the pace by up to this much, the throttle eases off; beyond it, the brake comes on.
PACE_BAND_KMH = 8.0
MS_TO_KMH = 3.6
CM_PER_M = 100.0


class Route(NamedTuple):
    """A polyline: its points, whether it closes back to the first, each point's arc length, its length."""
    points: tuple
    closed: bool
    starts: tuple
    length: float


class Nearest(NamedTuple):
    """The route's point nearest a position: its arc length, the position's signed lateral offset
    (right positive), the point, the unit tangent there and the horizontal distance to it."""
    s: float
    d: float
    x: float
    y: float
    tx: float
    ty: float
    distance: float


def make_route(points, closed: bool) -> Route:
    """A route through (x, y[, z]) points (z ignored), repeated points dropped; ValueError under two distinct points."""
    kept = []
    for point in points:
        x, y = float(point[0]), float(point[1])
        if not kept or math.hypot(x - kept[-1][0], y - kept[-1][1]) > SAME_POINT_CM:
            kept.append((x, y))
    if closed and len(kept) > 2 and math.hypot(kept[0][0] - kept[-1][0], kept[0][1] - kept[-1][1]) <= SAME_POINT_CM:
        kept.pop()
    if len(kept) < 2:
        raise ValueError('A route needs at least two distinct points.')
    starts = [0.0]
    count = len(kept) if closed else len(kept) - 1
    for i in range(count):
        a, b = kept[i], kept[(i + 1) % len(kept)]
        starts.append(starts[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
    length = starts.pop() if closed else starts[-1]
    return Route(tuple(kept), closed, tuple(starts), length)


def segment_count(route: Route) -> int:
    """How many segments: a closed route has one back to its first point."""
    return len(route.points) if route.closed else len(route.points) - 1


def segment(route: Route, i: int) -> tuple:
    """Segment i's two ends."""
    return route.points[i], route.points[(i + 1) % len(route.points)]


def on_segment(route: Route, i: int, x: float, y: float) -> Nearest:
    """The point of segment i nearest (x, y)."""
    (ax, ay), (bx, by) = segment(route, i)
    dx, dy = bx - ax, by - ay
    size = math.hypot(dx, dy)
    t = max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / (size * size)))
    px, py = ax + t * dx, ay + t * dy
    tx, ty = dx / size, dy / size
    return Nearest(route.starts[i] + t * size, (x - px) * -ty + (y - py) * tx, px, py, tx, ty, math.hypot(x - px, y - py))


def nearest(route: Route, x: float, y: float) -> Nearest:
    """The route's point nearest (x, y), over every segment."""
    return min((on_segment(route, i, x, y) for i in range(segment_count(route))), key=lambda n: n.distance)


def wrap_s(route: Route, s: float) -> float:
    """An arc length on the route: wrapped on a closed route, clamped on an open one."""
    if route.closed:
        return s % route.length
    return max(0.0, min(route.length, s))


def _segment_at(route: Route, s: float) -> int:
    """The segment holding arc length s (already wrapped)."""
    low, high = 0, segment_count(route) - 1
    while low < high:
        middle = (low + high + 1) // 2
        if route.starts[middle] <= s:
            low = middle
        else:
            high = middle - 1
    return low


def point_at(route: Route, s: float) -> tuple:
    """The route's point at arc length s."""
    at = wrap_s(route, s)
    i = _segment_at(route, at)
    (ax, ay), (bx, by) = segment(route, i)
    size = math.hypot(bx - ax, by - ay)
    t = (at - route.starts[i]) / size
    return ax + t * (bx - ax), ay + t * (by - ay)


def tangent_at(route: Route, s: float) -> tuple:
    """The unit tangent at arc length s."""
    (ax, ay), (bx, by) = segment(route, _segment_at(route, wrap_s(route, s)))
    size = math.hypot(bx - ax, by - ay)
    return (bx - ax) / size, (by - ay) / size


def wrap_deg(angle: float) -> float:
    """An angle in degrees, in (-180, 180]."""
    wrapped = (angle + 180.0) % 360.0 - 180.0
    return 180.0 if wrapped == -180.0 else wrapped


def heading_deg(tx: float, ty: float) -> float:
    """The yaw (degrees) a direction points at."""
    return math.degrees(math.atan2(ty, tx))


def advance(route: Route, s_from: float, s_to: float) -> float:
    """How far forward along the route s_to is from s_from (negative backward); the short way round a closed one."""
    delta = s_to - s_from
    if route.closed:
        delta = (delta + route.length / 2) % route.length - route.length / 2
    return delta


def facing_deg(route: Route, x: float, y: float, yaw_deg: float) -> float:
    """0 to 180 degrees between a yaw and the route's direction at its point nearest (x, y)."""
    near = nearest(route, x, y)
    return abs(wrap_deg(yaw_deg - heading_deg(near.tx, near.ty)))


def steer(route: Route, x: float, y: float, yaw_deg: float, look_ahead_cm: float = LOOK_AHEAD_CM) -> float:
    """-1 (full left) to 1 (full right): toward the route's point `look_ahead_cm` past the nearest one."""
    near = nearest(route, x, y)
    aim_x, aim_y = point_at(route, near.s + look_ahead_cm)
    error = wrap_deg(heading_deg(aim_x - x, aim_y - y) - yaw_deg)
    return max(-1.0, min(1.0, error / FULL_LOCK_DEG))


def curvature(route: Route, s: float, span_cm: float) -> float:
    """The signed curvature (1/cm, right positive) over `span_cm` of route centred on s."""
    half = span_cm / 2
    start, end = s - half, s + half
    if not route.closed:
        start, end = max(0.0, start), min(route.length, end)
    if end - start <= SAME_POINT_CM:
        return 0.0
    turn = wrap_deg(heading_deg(*tangent_at(route, end - SAME_POINT_CM)) - heading_deg(*tangent_at(route, start)))
    return math.radians(turn) / (end - start)


def pace_kmh(route: Route, s: float, ahead_cm: float = PACE_AHEAD_CM) -> float:
    """The speed to hold at arc length s: what the tightest bend within `ahead_cm` allows, between the
    slowest and the top pace."""
    looks = int(ahead_cm // PACE_STEP_CM) + 1
    tightest = max(abs(curvature(route, s + i * PACE_STEP_CM, PACE_SPAN_CM)) for i in range(looks))
    if tightest <= 0:
        return MAX_PACE_KMH
    radius_m = 1.0 / tightest / CM_PER_M
    return max(MIN_PACE_KMH, min(MAX_PACE_KMH, math.sqrt(GRIP_MS2 * radius_m) * MS_TO_KMH))


def pedals(speed_kmh: float, pace: float) -> tuple:
    """(throttle, brake), each 0 to 1, that bring the speed to the pace: full throttle below it, easing
    off just over it, braking well over it."""
    over = speed_kmh - pace
    if over <= 0:
        return 1.0, 0.0
    if over <= PACE_BAND_KMH:
        return round(1.0 - over / PACE_BAND_KMH, 2), 0.0
    return 0.0, round(min(1.0, (over - PACE_BAND_KMH) / PACE_BAND_KMH), 2)
