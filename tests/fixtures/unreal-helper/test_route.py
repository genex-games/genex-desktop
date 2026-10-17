"""route_math: the pure maths the drive steers by and the route probe measures with. Unreal's axes:
X forward, Y right, Z up, so a positive yaw turns from +X toward +Y (a right turn), a positive
lateral offset is right of the route, and a positive steer turns right."""

import math
import unittest

from genex_play import route_math

STRAIGHT = route_math.make_route([(0, 0), (10000, 0)], closed=False)


def circle(radius: float, points: int = 72, right: bool = True) -> route_math.Route:
    """A closed circle through (0, 0) heading +X, turning right (toward +Y) or left."""
    side = 1 if right else -1
    rows = [(radius * math.sin(2 * math.pi * i / points), side * radius * (1 - math.cos(2 * math.pi * i / points)))
            for i in range(points)]
    return route_math.make_route(rows, closed=True)


def bend(right: bool) -> route_math.Route:
    """20 m straight along +X, then a quarter turn of 20 m radius to the right (+Y) or the left."""
    side = 1 if right else -1
    rows = [(x * 100.0, 0.0) for x in range(0, 21)]
    rows += [(2000 + 2000 * math.sin(a * math.pi / 36), side * 2000 * (1 - math.cos(a * math.pi / 36)))
             for a in range(1, 19)]
    return route_math.make_route(rows, closed=False)


class Pace(unittest.TestCase):
    """A test drive is a steady lap, not a race: it slows for the bends ahead so the car can make them
    (at full throttle a car runs straight off a sharp bend)."""

    def test_on_a_straight_it_holds_the_top_pace(self) -> None:
        self.assertEqual(route_math.pace_kmh(STRAIGHT, 500.0), route_math.MAX_PACE_KMH)

    def test_a_tight_bend_ahead_lowers_the_pace_before_it_is_reached(self) -> None:
        before = route_math.pace_kmh(bend(right=True), 0.0)
        far = route_math.pace_kmh(route_math.make_route([(x * 100.0, 0.0) for x in range(0, 200)], closed=False), 0.0)
        self.assertLess(before, far, 'a 20 m bend 20 m ahead slows the car')
        self.assertLess(before, 45.0)

    def test_the_pace_never_drops_below_the_slowest_one(self) -> None:
        self.assertGreaterEqual(route_math.pace_kmh(circle(300.0), 0.0), route_math.MIN_PACE_KMH)

    def test_a_wider_bend_allows_more_speed(self) -> None:
        self.assertLess(route_math.pace_kmh(circle(1500.0), 0.0), route_math.pace_kmh(circle(4000.0), 0.0))

    def test_below_the_pace_it_is_full_throttle_and_no_brake(self) -> None:
        self.assertEqual(route_math.pedals(30.0, 50.0), (1.0, 0.0))

    def test_a_little_over_the_pace_it_eases_off_without_braking(self) -> None:
        throttle, brake = route_math.pedals(53.0, 50.0)
        self.assertLess(throttle, 1.0)
        self.assertGreater(throttle, 0.0)
        self.assertEqual(brake, 0.0)

    def test_well_over_the_pace_it_brakes_with_no_throttle(self) -> None:
        throttle, brake = route_math.pedals(90.0, 40.0)
        self.assertEqual(throttle, 0.0)
        self.assertGreater(brake, 0.5)
        self.assertLessEqual(brake, 1.0)


class Steering(unittest.TestCase):
    def test_on_the_route_and_facing_along_it_the_steer_is_straight(self) -> None:
        self.assertAlmostEqual(route_math.steer(STRAIGHT, 500, 0, 0.0), 0.0, places=6)

    def test_left_of_the_route_it_steers_right_and_right_of_it_left(self) -> None:
        self.assertGreater(route_math.steer(STRAIGHT, 500, -300, 0.0), 0.0, 'left of the route (y < 0): turn right')
        self.assertLess(route_math.steer(STRAIGHT, 500, 300, 0.0), 0.0, 'right of the route (y > 0): turn left')

    def test_a_bend_ahead_is_steered_into_before_it_is_reached(self) -> None:
        self.assertGreater(route_math.steer(bend(right=True), 1500, 0, 0.0), 0.05, 'the look-ahead sees the right bend')
        self.assertLess(route_math.steer(bend(right=False), 1500, 0, 0.0), -0.05, 'and the left one')

    def test_the_steer_never_leaves_full_lock(self) -> None:
        for yaw in (90.0, 179.0, -179.0, -90.0):
            with self.subTest(yaw=yaw):
                self.assertLessEqual(abs(route_math.steer(STRAIGHT, 500, 0, yaw)), 1.0)
        self.assertEqual(route_math.steer(STRAIGHT, 500, 0, 90.0), -1.0, 'facing +Y the route is far to the left')
        self.assertEqual(route_math.steer(STRAIGHT, 500, 0, -90.0), 1.0)

    def test_on_a_circle_turning_right_the_steer_is_right_and_left_on_one_turning_left(self) -> None:
        self.assertGreater(route_math.steer(circle(3000, right=True), 0, 0, 0.0), 0.0)
        self.assertLess(route_math.steer(circle(3000, right=False), 0, 0, 0.0), 0.0)


class Facing(unittest.TestCase):
    def test_the_angle_to_the_route_tangent_is_0_to_180_degrees_either_side(self) -> None:
        rows = {0.0: 0.0, 30.0: 30.0, -30.0: 30.0, 90.0: 90.0, 180.0: 180.0, 190.0: 170.0, -170.0: 170.0, 360.0: 0.0}
        for yaw, expected in rows.items():
            with self.subTest(yaw=yaw):
                self.assertAlmostEqual(route_math.facing_deg(STRAIGHT, 500, 40, yaw), expected, places=6)

    def test_on_a_circle_it_is_measured_against_the_tangent_at_the_nearest_point(self) -> None:
        route = circle(3000, points=360)
        # A quarter of the way round a right-turning circle from (0, 0), the route heads +Y (yaw 90).
        self.assertAlmostEqual(route_math.facing_deg(route, 3000, 3000, 90.0), 0.0, delta=1.0)
        self.assertAlmostEqual(route_math.facing_deg(route, 3000, 3000, 0.0), 90.0, delta=1.0)


class Nearest(unittest.TestCase):
    def test_arc_length_and_signed_lateral_offset(self) -> None:
        near = route_math.nearest(STRAIGHT, 2500, -400)
        self.assertEqual((round(near.s), round(near.d), round(near.distance)), (2500, -400, 400))
        self.assertEqual((near.tx, near.ty), (1.0, 0.0))
        self.assertEqual(round(route_math.nearest(STRAIGHT, 2500, 400).d), 400, 'right of the route is positive')

    def test_beyond_an_open_routes_ends_it_is_the_end_point(self) -> None:
        self.assertEqual(round(route_math.nearest(STRAIGHT, -500, 0).s), 0)
        self.assertEqual(round(route_math.nearest(STRAIGHT, 12000, 0).s), 10000)

    def test_a_closed_routes_closing_segment_counts(self) -> None:
        square = route_math.make_route([(0, 0), (1000, 0), (1000, 1000), (0, 1000)], closed=True)
        self.assertEqual(square.length, 4000)
        near = route_math.nearest(square, -10, 500)
        self.assertEqual(round(near.s), 3500, 'on the segment back to the start')


class Progress(unittest.TestCase):
    def test_moving_along_counts_forward_and_backward(self) -> None:
        self.assertEqual(route_math.advance(STRAIGHT, 1000, 1600), 600)
        self.assertEqual(route_math.advance(STRAIGHT, 1600, 1000), -600)

    def test_crossing_the_start_of_a_closed_route_wraps(self) -> None:
        loop = circle(3000)
        self.assertAlmostEqual(route_math.advance(loop, loop.length - 100, 200), 300, places=6)
        self.assertAlmostEqual(route_math.advance(loop, 200, loop.length - 100), -300, places=6)

    def test_points_wrap_on_a_closed_route_and_stop_at_an_open_routes_ends(self) -> None:
        square = route_math.make_route([(0, 0), (1000, 0), (1000, 1000), (0, 1000)], closed=True)
        self.assertEqual(route_math.point_at(square, 4500), (500.0, 0.0))
        self.assertEqual(route_math.point_at(STRAIGHT, 12000), (10000.0, 0.0))
        self.assertEqual(route_math.point_at(STRAIGHT, -5), (0.0, 0.0))


class Curvature(unittest.TestCase):
    def test_a_right_turn_curves_positive_and_a_left_turn_negative(self) -> None:
        self.assertGreater(route_math.curvature(circle(3000, right=True), 1000, 1500), 0)
        self.assertLess(route_math.curvature(circle(3000, right=False), 1000, 1500), 0)
        self.assertAlmostEqual(route_math.curvature(circle(3000, points=360), 1000, 1500), 1 / 3000, delta=1e-5)
        self.assertEqual(route_math.curvature(STRAIGHT, 5000, 1500), 0.0)


class Shapes(unittest.TestCase):
    def test_a_route_needs_two_distinct_points(self) -> None:
        for rows in ([], [(0, 0)], [(5, 5), (5, 5), (5, 5)]):
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                route_math.make_route(rows, closed=False)

    def test_repeated_points_are_dropped(self) -> None:
        route = route_math.make_route([(0, 0), (0, 0), (100, 0), (100, 0), (200, 0)], closed=False)
        self.assertEqual(route.points, ((0.0, 0.0), (100.0, 0.0), (200.0, 0.0)))
        self.assertEqual(route.length, 200)


if __name__ == '__main__':
    unittest.main()
