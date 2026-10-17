"""terrain_math: the heights track_terrain gives its ground, pure so they are tested here. Along the
route the track is a groove a little below the ground; whoops and tabletop jumps rise from it, each
jump after a clear run-up the car can use; the outside of a turn is banked into a berm while the
infield stays flat; a closed route has no seam. The same seed always gives the same ground."""

import math
import unittest

from genex_build import terrain_math
from genex_play import route_math

T = terrain_math
WIDTH_CM = 1200.0
HALF = WIDTH_CM / 2
FAR_CM = HALF + T.SHOULDER_CM + T.BERM_BACK_CM + 100


def straight(length_cm: float = 30000.0) -> route_math.Route:
    return route_math.make_route([(x, 0.0) for x in range(0, int(length_cm) + 1, 500)], closed=False)


def circle(radius: float, right: bool = True, points: int = 180) -> route_math.Route:
    side = 1 if right else -1
    return route_math.make_route(
        [(radius * math.sin(2 * math.pi * i / points), side * radius * (1 - math.cos(2 * math.pi * i / points)))
         for i in range(points)], closed=True)


def centre(track: terrain_math.Track, s: float) -> float:
    """The ground's height on the route at arc length s."""
    x, y = route_math.point_at(track.route, s)
    return T.height_cm(track, x, y)


def features(track: terrain_math.Track, kind: str) -> list:
    return [f for f in track.features if f.kind == kind]


class Deterministic(unittest.TestCase):
    def test_the_same_seed_gives_the_same_ground_and_another_seed_moves_the_features(self) -> None:
        route = straight(40000)
        points = [(x, y) for x in range(0, 40000, 370) for y in (-900, -300, 0, 450)]
        first = T.heights_cm(T.plan_track(route, WIDTH_CM, 6, 1, seed=7), points)
        again = T.heights_cm(T.plan_track(route, WIDTH_CM, 6, 1, seed=7), points)
        other = T.heights_cm(T.plan_track(route, WIDTH_CM, 6, 1, seed=8), points)
        self.assertEqual(first, again)
        self.assertNotEqual(first, other)

    def test_the_fast_heights_match_the_one_point_heights(self) -> None:
        track = T.plan_track(circle(5000), WIDTH_CM, 6, 0, seed=3)
        points = [(x, y) for x in range(-6000, 6001, 433) for y in range(-1500, 11501, 433)]
        self.assertEqual(T.heights_cm(track, points), [T.height_cm(track, x, y) for x, y in points])


class Groove(unittest.TestCase):
    def test_on_a_plain_straight_the_track_lies_below_the_ground_and_climbs_out_over_the_shoulder(self) -> None:
        track = T.plan_track(straight(), WIDTH_CM, 0, 0, seed=1)
        across = [T.height_cm(track, 15000, d) for d in (0, HALF, HALF + T.SHOULDER_CM / 2, HALF + T.SHOULDER_CM, FAR_CM)]
        self.assertEqual(across[0], -T.GROOVE_CM)
        self.assertEqual(across[1], -T.GROOVE_CM, 'flat across the whole track width')
        self.assertTrue(-T.GROOVE_CM < across[2] < 0, across)
        self.assertEqual(across[3:], [0.0, 0.0])
        self.assertEqual(T.height_cm(track, 15000, -HALF), T.height_cm(track, 15000, HALF), 'both edges alike')


class Whoops(unittest.TestCase):
    def test_whoops_are_evenly_spaced_bumps_of_their_height_rising_from_the_track(self) -> None:
        track = T.plan_track(straight(), WIDTH_CM, 5, 0, seed=4)
        [group] = features(track, T.FeatureKind.WHOOPS)
        self.assertEqual(group.count, 5)
        self.assertAlmostEqual(group.end - group.start, 5 * T.WHOOP_LENGTH_CM)
        self.assertGreaterEqual(group.start, T.START_CLEAR_CM, 'the start straight stays clear')
        crests = [centre(track, group.start + (i + 0.5) * T.WHOOP_LENGTH_CM) for i in range(5)]
        troughs = [centre(track, group.start + i * T.WHOOP_LENGTH_CM) for i in range(6)]
        self.assertEqual([round(c, 6) for c in crests], [T.WHOOP_HEIGHT_CM - T.GROOVE_CM] * 5)
        self.assertEqual([round(t, 6) for t in troughs], [-T.GROOVE_CM] * 6)

    def test_many_whoops_come_in_groups(self) -> None:
        track = T.plan_track(straight(60000), WIDTH_CM, 14, 0, seed=4)
        groups = features(track, T.FeatureKind.WHOOPS)
        self.assertEqual(sum(g.count for g in groups), 14)
        self.assertTrue(all(g.count <= T.WHOOPS_PER_GROUP for g in groups))


class Jumps(unittest.TestCase):
    def test_a_tabletop_jump_has_a_clear_run_up_a_flat_top_of_its_height_and_a_landing(self) -> None:
        track = T.plan_track(straight(), WIDTH_CM, 0, 1, seed=2)
        [jump] = features(track, T.FeatureKind.JUMP)
        run_up = [round(centre(track, jump.start - d), 6) for d in range(0, int(T.JUMP_RUN_UP_CM) + 1, 100)]
        self.assertEqual(set(run_up), {-T.GROOVE_CM}, 'at least 25 m of flat track before the face')
        self.assertGreaterEqual(T.JUMP_RUN_UP_CM, 2500)
        top = jump.start + T.JUMP_FACE_CM
        self.assertEqual({round(centre(track, top + d), 6) for d in (1, T.JUMP_TOP_CM / 2, T.JUMP_TOP_CM - 1)},
                         {T.JUMP_HEIGHT_CM - T.GROOVE_CM})
        self.assertEqual(T.JUMP_HEIGHT_CM, 250)
        face = [centre(track, jump.start + f * T.JUMP_FACE_CM) for f in (0.25, 0.5, 0.75)]
        self.assertEqual(face, sorted(face), 'the face only climbs')
        self.assertEqual(round(centre(track, jump.end), 6), -T.GROOVE_CM, 'back down on the track after the landing')

    def test_a_jump_goes_on_the_straighter_part_of_the_route(self) -> None:
        # 40 m straight, a quarter turn of 30 m radius, then 150 m straight: the jump and its run-up skip the turn.
        rows = [(x, 0.0) for x in range(0, 4001, 500)]
        rows += [(4000 + 3000 * math.sin(a * math.pi / 40), 3000 * (1 - math.cos(a * math.pi / 40))) for a in range(1, 21)]
        rows += [(7000.0, 3000.0 + y) for y in range(500, 15001, 500)]
        route = route_math.make_route(rows, closed=False)
        turn_end = route_math.nearest(route, 7000, 3000).s
        [jump] = features(T.plan_track(route, WIDTH_CM, 0, 1, seed=11), T.FeatureKind.JUMP)
        self.assertGreaterEqual(jump.start - T.JUMP_RUN_UP_CM, turn_end, 'run-up, face, top and landing on the straight')

    def test_features_that_do_not_fit_the_route_are_refused_with_the_lengths(self) -> None:
        with self.assertRaises(ValueError) as refused:
            T.plan_track(straight(8000), WIDTH_CM, 0, 2, seed=1)
        self.assertIn(' m', str(refused.exception))


class Berms(unittest.TestCase):
    def assert_banked(self, right: bool) -> None:
        radius = 4000.0
        track = T.plan_track(circle(radius, right=right), WIDTH_CM, 0, 0, seed=5)
        # A quarter of the way round, the route runs along +Y (right turn) or -Y (left turn) at x = radius,
        # with the turn's centre at x = 0: the outside is +X and the infield -X.
        y = radius if right else -radius
        outer = [T.height_cm(track, radius + d, y) for d in (HALF, HALF + T.SHOULDER_CM)]
        inner = [T.height_cm(track, radius - d, y) for d in (HALF, HALF + T.SHOULDER_CM)]
        self.assertTrue(all(o > i for o, i in zip(outer, inner)), (outer, inner))
        self.assertGreater(outer[1], 0.0, 'the berm stands above the ground outside the turn')
        self.assertAlmostEqual(inner[1], 0.0, delta=0.01, msg='the infield is flat ground (a polyline circle)')
        self.assertEqual(T.height_cm(track, radius - FAR_CM, y), 0.0)

    def test_the_outside_of_a_right_turn_is_banked(self) -> None:
        self.assert_banked(right=True)

    def test_the_outside_of_a_left_turn_is_banked(self) -> None:
        self.assert_banked(right=False)

    def test_a_straight_has_no_berm(self) -> None:
        track = T.plan_track(straight(), WIDTH_CM, 0, 0, seed=5)
        self.assertEqual(T.height_cm(track, 15000, HALF + T.SHOULDER_CM), 0.0)


class ClosedRoute(unittest.TestCase):
    def test_the_ground_has_no_seam_where_a_closed_route_starts(self) -> None:
        track = T.plan_track(circle(6000), WIDTH_CM, 6, 1, seed=9)
        length = track.route.length
        for d in (0, HALF, HALF + 150):
            with self.subTest(d=d):
                before = T.height_cm(track, *_offset(track, length - 30, d))
                after = T.height_cm(track, *_offset(track, 30, d))
                self.assertAlmostEqual(before, after, delta=2.0)
        self.assertTrue(all(T.START_CLEAR_CM <= f.start and f.end <= length - T.END_CLEAR_CM for f in track.features))

    def test_arc_lengths_past_the_end_of_a_loop_wrap_round(self) -> None:
        track = T.plan_track(circle(6000), WIDTH_CM, 6, 0, seed=9)
        [group] = features(track, T.FeatureKind.WHOOPS)
        crest = group.start + T.WHOOP_LENGTH_CM / 2
        self.assertAlmostEqual(T.profile_cm(track, track.route.length + crest), T.WHOOP_HEIGHT_CM)


def _offset(track: terrain_math.Track, s: float, d: float) -> tuple:
    x, y = route_math.point_at(track.route, s)
    tx, ty = route_math.tangent_at(track.route, s)
    return x - ty * d, y + tx * d


class Grid(unittest.TestCase):
    def test_the_grid_covers_the_route_and_its_banks_within_the_vertex_cap(self) -> None:
        track = T.plan_track(circle(6000), WIDTH_CM, 0, 0, seed=1)
        grid = T.grid(track)
        xs = [p[0] for p in track.route.points]
        ys = [p[1] for p in track.route.points]
        self.assertLessEqual(grid.center_x - grid.size_x / 2, min(xs) - FAR_CM)
        self.assertGreaterEqual(grid.center_x + grid.size_x / 2, max(xs) + FAR_CM)
        self.assertLessEqual(grid.center_y - grid.size_y / 2, min(ys) - FAR_CM)
        self.assertGreaterEqual(grid.center_y + grid.size_y / 2, max(ys) + FAR_CM)
        self.assertLessEqual((grid.steps_x + 1) * (grid.steps_y + 1), T.MAX_VERTICES)

    def test_a_small_track_gets_the_finest_spacing(self) -> None:
        grid = T.grid(T.plan_track(straight(5000), WIDTH_CM, 0, 0, seed=1))
        self.assertAlmostEqual(grid.size_x / grid.steps_x, T.GRID_SPACING_CM, delta=1.0)


class SeededRoutes(unittest.TestCase):
    def test_a_closed_route_from_a_seed_has_the_length_asked_for_and_starts_at_the_origin_heading_x(self) -> None:
        rows = T.route_points(3, 400.0, closed=True)
        route = route_math.make_route(rows, closed=True)
        self.assertAlmostEqual(route.length, 40000, delta=400)
        self.assertEqual(rows[0], (0.0, 0.0, 0.0))
        self.assertAlmostEqual(route_math.heading_deg(*route_math.tangent_at(route, 0)), 0.0, delta=5.0)
        self.assertEqual(rows, T.route_points(3, 400.0, closed=True))
        self.assertNotEqual(rows, T.route_points(4, 400.0, closed=True))

    def test_an_open_route_from_a_seed_starts_straight(self) -> None:
        rows = T.route_points(3, 250.0, closed=False)
        route = route_math.make_route(rows, closed=False)
        self.assertAlmostEqual(route.length, 25000, delta=250)
        self.assertLess(abs(route_math.curvature(route, T.START_CLEAR_CM / 2, T.START_CLEAR_CM)), 1e-5)


if __name__ == '__main__':
    unittest.main()
