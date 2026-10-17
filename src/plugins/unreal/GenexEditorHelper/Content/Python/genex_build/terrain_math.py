"""The ground track_terrain builds, as heights; pure (no `unreal`), so it is tested outside the editor.

Every point of the ground takes the route's profile at its nearest route point: its arc length s
and its signed lateral offset d (route_math; right positive). Inside the track's width the ground
is the track surface, a shallow groove below the ground with whoops and tabletop jumps rising from
it; the outside of a turn is banked into a berm (its side from the curvature's sign) while the
infield climbs back to flat ground over the shoulder. A closed route has no seam: arc lengths wrap.

Features are laid along the route from a seed, after a clear start straight: whoops in groups,
and jumps where the route is straightest, each after a flat run-up the car can use. All lengths
and heights are cm; the ground outside the track is at 0.
"""

import math
import random
from typing import NamedTuple

from genex_play import route_math

GROUND_CM = 0.0
# The track surface lies this far below the ground, so the car stays in its groove.
GROOVE_CM = 25.0
# Beyond the track's edge, the ground climbs back over this much.
SHOULDER_CM = 300.0
# From this fraction of the half width outward, the outside of a turn starts banking up.
BANK_FROM = 0.5
# The berm's height at the shoulder's crest in a turn at least this tight, and how far it falls back.
BERM_CM = 150.0
BERM_FULL_RADIUS_CM = 1500.0
BERM_BACK_CM = 400.0
# Curvature is measured over this much route, every CURVE_STEP_CM of arc length.
CURVE_SPAN_CM = 1500.0
CURVE_STEP_CM = 100.0
# Whoops: bumps of this height and length, at most WHOOPS_PER_GROUP in a row.
WHOOP_HEIGHT_CM = 55.0
WHOOP_LENGTH_CM = 360.0
WHOOPS_PER_GROUP = 6
# A tabletop jump: a flat run-up, a face, the top, the landing.
JUMP_HEIGHT_CM = 250.0
JUMP_RUN_UP_CM = 2500.0
JUMP_FACE_CM = 900.0
JUMP_TOP_CM = 800.0
JUMP_LANDING_CM = 1200.0
# Space between features, the clear straight after the start and before an open route's end.
FEATURE_GAP_CM = 1500.0
START_CLEAR_CM = 3000.0
END_CLEAR_CM = 1500.0
# A jump slides along the route in these steps to find its straightest place.
JUMP_SLIDE_STEP_CM = 200.0
# The ground's grid: this spacing at the finest, at most MAX_VERTICES, MARGIN_CM past the banks.
GRID_SPACING_CM = 25.0
MAX_VERTICES = 120_000
MARGIN_CM = 1000.0
# A seeded closed route: a rounded rectangle (superellipse) of this many points.
LOOP_POINTS = 64
LOOP_SQUARENESS = (3.0, 5.0)
LOOP_ASPECT = (1.6, 2.4)
LOOP_WOBBLE = 0.06
# A seeded open route: points this far apart, swaying sideways after a straight start.
OPEN_STEP_CM = 500.0
OPEN_SWAY_CM = (400.0, 900.0)
OPEN_SWAY_PERIOD_CM = 15000.0
OPEN_STRAIGHT_CM = 1.25 * START_CLEAR_CM

MESSAGE = {
    'fit': ('{whoops} whoops and {jumps} jumps need {need} m of track after the {start} m start straight; '
            'the route has {length} m. Ask for fewer, or set a longer route.'),
    'width': 'The track width must be a positive number.',
}


class FeatureKind:
    """What a feature on the track is."""
    WHOOPS = 'whoops'
    JUMP = 'jump'


class Feature(NamedTuple):
    """A feature's kind, where its shape begins and ends (arc length; a jump's run-up is before
    its start) and, for whoops, how many."""
    kind: str
    start: float
    end: float
    count: int


class Track(NamedTuple):
    """The track along a route: half its width, its features and the route's curvature every CURVE_STEP_CM."""
    route: route_math.Route
    half_width: float
    features: tuple
    curve: tuple


class Grid(NamedTuple):
    """The ground's rectangle: its centre, its size and how many steps each way."""
    center_x: float
    center_y: float
    size_x: float
    size_y: float
    steps_x: int
    steps_y: int


class _Piece(NamedTuple):
    kind: str
    count: int
    lead: float
    body: float


def _smooth(t: float) -> float:
    """0 to 1 with flat ends, for t from 0 to 1 (clamped)."""
    u = min(1.0, max(0.0, t))
    return u * u * (3 - 2 * u)


# Seeded routes

def _loop(rng: random.Random) -> list:
    squareness = rng.uniform(*LOOP_SQUARENESS)
    aspect = rng.uniform(*LOOP_ASPECT)
    phase = rng.uniform(0.0, 2 * math.pi)
    rows = []
    for i in range(LOOP_POINTS):
        t = -math.pi / 2 + 2 * math.pi * i / LOOP_POINTS
        c, s = math.cos(t), math.sin(t)
        wobble = 1 + LOOP_WOBBLE * math.sin(3 * t + phase)
        x = aspect * math.copysign(abs(c) ** (2 / squareness), c)
        y = math.copysign(abs(s) ** (2 / squareness), s)
        rows.append((x * wobble, y * wobble))
    return rows


def _sway(rng: random.Random, length_cm: float) -> list:
    amplitude = rng.uniform(*OPEN_SWAY_CM)
    phase = rng.uniform(0.0, 2 * math.pi)
    rows = []
    for i in range(int(length_cm // OPEN_STEP_CM) + 1):
        x = i * OPEN_STEP_CM
        ramp = _smooth((x - OPEN_STRAIGHT_CM) / OPEN_STRAIGHT_CM)
        rows.append((x, amplitude * ramp * math.sin(2 * math.pi * x / OPEN_SWAY_PERIOD_CM + phase)))
    return rows


def _fitted(rows: list, length_cm: float, closed: bool) -> list:
    """Rows scaled to length_cm, moved to start at the origin and turned to head +X from there."""
    route = route_math.make_route(rows, closed)
    scale = length_cm / route.length
    x0, y0 = rows[0]
    x1, y1 = rows[1]
    angle = -math.atan2(y1 - y0, x1 - x0)
    cos_a, sin_a = math.cos(angle), math.sin(angle)
    fitted = []
    for x, y in rows:
        dx, dy = (x - x0) * scale, (y - y0) * scale
        fitted.append((round(dx * cos_a - dy * sin_a, 1), round(dx * sin_a + dy * cos_a, 1), 0.0))
    return fitted


def route_points(seed: int, length_m: float, closed: bool) -> list:
    """A route of about length_m from a seed, [(x, y, z)] cm from (0, 0, 0) heading +X: a closed
    rounded loop turning right, or an open route that sways after a straight start."""
    rng = random.Random(seed)
    length_cm = length_m * 100.0
    rows = _loop(rng) if closed else _sway(rng, length_cm)
    return _fitted(rows, length_cm, closed)


# The track's plan

def _pieces(whoops: int, jumps: int) -> list:
    groups = math.ceil(whoops / WHOOPS_PER_GROUP)
    counts = [whoops // groups + (1 if i < whoops % groups else 0) for i in range(groups)]
    pieces = [_Piece(FeatureKind.WHOOPS, count, 0.0, count * WHOOP_LENGTH_CM) for count in counts]
    jump_body = JUMP_FACE_CM + JUMP_TOP_CM + JUMP_LANDING_CM
    return pieces + [_Piece(FeatureKind.JUMP, 1, JUMP_RUN_UP_CM, jump_body) for _ in range(jumps)]


def _curve(route: route_math.Route) -> tuple:
    count = int(route.length // CURVE_STEP_CM) + 2
    return tuple(route_math.curvature(route, i * CURVE_STEP_CM, CURVE_SPAN_CM) for i in range(count))


def _bend(curve: tuple, start: float, end: float) -> float:
    """The sharpest curvature between two arc lengths."""
    first = int(start // CURVE_STEP_CM)
    last = min(len(curve) - 1, int(end // CURVE_STEP_CM) + 1)
    return max(abs(k) for k in curve[first:last + 1])


def _slide(curve: tuple, piece: _Piece, cursor: float, spare: float, rng: random.Random, left: int) -> float:
    """How far past the cursor a piece goes: a jump to its straightest place, whoops a seeded share of the spare."""
    if piece.kind != FeatureKind.JUMP:
        return rng.uniform(0.0, spare / left)
    footprint = piece.lead + piece.body
    offsets = [i * JUMP_SLIDE_STEP_CM for i in range(int(spare // JUMP_SLIDE_STEP_CM) + 1)]
    return min(offsets, key=lambda off: (_bend(curve, cursor + off, cursor + off + footprint), off))


def _place(route: route_math.Route, curve: tuple, pieces: list, rng: random.Random, asked: tuple) -> tuple:
    first, last = START_CLEAR_CM, route.length - END_CLEAR_CM
    need = sum(p.lead + p.body for p in pieces) + FEATURE_GAP_CM * max(0, len(pieces) - 1)
    if need > last - first:
        raise ValueError(MESSAGE['fit'].format(whoops=asked[0], jumps=asked[1], need=round(need / 100),
                                               start=round(START_CLEAR_CM / 100), length=round(route.length / 100)))
    spare = last - first - need
    cursor = first
    placed = []
    for index, piece in enumerate(pieces):
        slide = _slide(curve, piece, cursor, spare, rng, len(pieces) - index)
        begin = cursor + slide + piece.lead
        placed.append(Feature(piece.kind, begin, begin + piece.body, piece.count))
        spare -= slide
        cursor = begin + piece.body + FEATURE_GAP_CM
    return tuple(placed)


def plan_track(route: route_math.Route, width_cm: float, whoops: int, jumps: int, seed: int) -> Track:
    """The track along a route: its features placed from the seed; ValueError when they don't fit."""
    if not (math.isfinite(width_cm) and width_cm > 0):
        raise ValueError(MESSAGE['width'])
    rng = random.Random(seed)
    pieces = _pieces(whoops, jumps)
    rng.shuffle(pieces)
    curve = _curve(route)
    return Track(route, width_cm / 2, _place(route, curve, pieces, rng, (whoops, jumps)), curve)


# Heights

def _shape(feature: Feature, u: float) -> float:
    """A feature's height u cm into its shape."""
    if feature.kind == FeatureKind.WHOOPS:
        return WHOOP_HEIGHT_CM * math.sin(math.pi * u / WHOOP_LENGTH_CM) ** 2
    if u <= JUMP_FACE_CM:
        rise = u / JUMP_FACE_CM
        return JUMP_HEIGHT_CM * rise * rise
    if u <= JUMP_FACE_CM + JUMP_TOP_CM:
        return JUMP_HEIGHT_CM
    return JUMP_HEIGHT_CM * (1 - _smooth((u - JUMP_FACE_CM - JUMP_TOP_CM) / JUMP_LANDING_CM))


def profile_cm(track: Track, s: float) -> float:
    """How far the track's features lift it at arc length s."""
    at = route_math.wrap_s(track.route, s)
    for feature in track.features:
        if feature.start <= at <= feature.end:
            return _shape(feature, at - feature.start)
    return 0.0


def curvature_at(track: Track, s: float) -> float:
    """The route's curvature at arc length s, between its samples."""
    at = route_math.wrap_s(track.route, s) / CURVE_STEP_CM
    i = min(int(at), len(track.curve) - 2)
    frac = at - i
    return track.curve[i] * (1 - frac) + track.curve[i + 1] * frac


def reach_cm(track: Track) -> float:
    """How far from the route the track changes the ground."""
    return track.half_width + SHOULDER_CM + BERM_BACK_CM


def _infield_side(surface: float, a: float, w: float) -> float:
    if a <= w:
        return surface
    return surface + (GROUND_CM - surface) * _smooth((a - w) / SHOULDER_CM)


def _berm_side(surface: float, berm: float, a: float, w: float) -> float:
    rise_from, crest = BANK_FROM * w, w + SHOULDER_CM
    if a <= rise_from:
        return surface
    if a <= crest:
        return surface + berm * _smooth((a - rise_from) / (crest - rise_from))
    top = surface + berm
    return top + (GROUND_CM - top) * _smooth((a - crest) / BERM_BACK_CM)


def section_cm(track: Track, s: float, d: float, a: float) -> float:
    """The ground's height a cm from the route (d: signed lateral offset, its side) at arc length s."""
    surface = profile_cm(track, s) - GROOVE_CM
    k = curvature_at(track, s)
    berm = BERM_CM * min(1.0, abs(k) * BERM_FULL_RADIUS_CM)
    # A right turn (k > 0) banks its left (d < 0) side, the outside.
    outside = d * k < 0
    if outside and berm > 0:
        return _berm_side(surface, berm, a, track.half_width)
    return _infield_side(surface, a, track.half_width)


def _closest(route: route_math.Route, segments, x: float, y: float) -> int:
    """The index of the segment nearest (x, y) among `segments` (the first of equals), or -1."""
    points, count = route.points, len(route.points)
    best, best_d2 = -1, math.inf
    for i in segments:
        ax, ay = points[i]
        bx, by = points[(i + 1) % count]
        dx, dy = bx - ax, by - ay
        t = min(1.0, max(0.0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
        ex, ey = ax + t * dx - x, ay + t * dy - y
        d2 = ex * ex + ey * ey
        if d2 < best_d2:
            best, best_d2 = i, d2
    return best


def _height_on(track: Track, segment: int, x: float, y: float) -> float:
    if segment < 0:
        return GROUND_CM
    near = route_math.on_segment(track.route, segment, x, y)
    if near.distance > reach_cm(track):
        return GROUND_CM
    return section_cm(track, near.s, near.d, near.distance)


def height_cm(track: Track, x: float, y: float) -> float:
    """The ground's height at (x, y)."""
    return _height_on(track, _closest(track.route, range(route_math.segment_count(track.route)), x, y), x, y)


def _buckets(track: Track, cell: float) -> dict:
    """For each grid cell, the segments within reach of any of its points, in order."""
    reach = reach_cm(track)
    buckets: dict = {}
    for i in range(route_math.segment_count(track.route)):
        (ax, ay), (bx, by) = route_math.segment(track.route, i)
        for cx in range(math.floor((min(ax, bx) - reach) / cell), math.floor((max(ax, bx) + reach) / cell) + 1):
            for cy in range(math.floor((min(ay, by) - reach) / cell), math.floor((max(ay, by) + reach) / cell) + 1):
                buckets.setdefault((cx, cy), []).append(i)
    return buckets


def heights_cm(track: Track, points) -> list:
    """The ground's heights at many (x, y) points: the same as height_cm, looking only at nearby segments."""
    cell = reach_cm(track)
    buckets = _buckets(track, cell)
    heights = []
    for x, y in points:
        near = buckets.get((math.floor(x / cell), math.floor(y / cell)), ())
        heights.append(_height_on(track, _closest(track.route, near, x, y), x, y))
    return heights


def grid(track: Track) -> Grid:
    """The ground's rectangle: the route, its banks and a margin, at most MAX_VERTICES vertices."""
    reach = reach_cm(track) + MARGIN_CM
    xs = [p[0] for p in track.route.points]
    ys = [p[1] for p in track.route.points]
    low_x, high_x, low_y, high_y = min(xs) - reach, max(xs) + reach, min(ys) - reach, max(ys) + reach
    size_x, size_y = high_x - low_x, high_y - low_y
    spacing = max(GRID_SPACING_CM, math.sqrt(size_x * size_y / MAX_VERTICES))
    steps_x, steps_y = math.ceil(size_x / spacing), math.ceil(size_y / spacing)
    while (steps_x + 1) * (steps_y + 1) > MAX_VERTICES:
        spacing *= 1.02
        steps_x, steps_y = math.ceil(size_x / spacing), math.ceil(size_y / spacing)
    return Grid((low_x + high_x) / 2, (low_y + high_y) / 2, size_x, size_y, steps_x, steps_y)
