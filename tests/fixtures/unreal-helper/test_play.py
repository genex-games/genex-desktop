"""The play tools count the play session's GAME seconds: a cold or loaded editor runs at a few
frames a second, so a hold, a settle or a drive timed by the wall clock saw about a second of game
(every shot the same, the car never moved). Each also ends after a wall-clock cap (4x
its seconds plus 10 s) when the game clock stalls. A drive follows the game's GenexRoute spline
by forcing the steering input each frame toward a point 15 m ahead; the route probe measures the
player against the route."""

import json
import math
import unittest
from unittest import mock

import unreal
from unreal import Name, Rotator, Vector

from genex_play import play
from genex_play.tools import GenexPlayTools

from support import HelperCase

THROTTLE, STEERING, HANDBRAKE, BRAKE = 'IA_Throttle', 'IA_Steering', 'IA_Handbrake', 'IA_Brake'


class Clock:
    """The wall clock the play tools read (time.monotonic), moved by the test."""

    def __init__(self) -> None:
        self.now = 1000.0

    def monotonic(self) -> float:
        return self.now


def tool(name: str, *args) -> dict:
    return json.loads(getattr(GenexPlayTools, name)(*args))


class PlayCase(HelperCase):
    """A play session with the player's car at the origin facing +X and the vehicle template's input actions."""

    def setUp(self) -> None:
        super().setUp()
        self.clock = Clock()
        patcher = mock.patch.object(play, 'time', self.clock)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.let_go)
        unreal.state['pie'] = True
        self.car = unreal.WheeledVehiclePawn('BP_OffroadCar_0', Vector(0, 0, 50))
        unreal.state['player'] = self.car
        unreal.state['actors'] = [self.car]
        for name, kind in ((THROTTLE, unreal.InputActionValueType.AXIS1D),
                           (STEERING, unreal.InputActionValueType.AXIS1D),
                           (BRAKE, unreal.InputActionValueType.AXIS1D),
                           (HANDBRAKE, unreal.InputActionValueType.BOOLEAN)):
            unreal.state['registry'].append(unreal.AssetData(f'/Game/Input/{name}', 'InputAction',
                                                             asset=unreal.InputAction(name, kind)))

    def let_go(self) -> None:
        """Lets go of everything and runs one frame, so no tick outlives the test."""
        play.release_all()
        self.frame(0.0, 0.0)

    def frame(self, game: float, wall: float) -> None:
        """One editor frame: the game clock and the wall clock move, then every post-tick callback runs."""
        unreal.state['game_seconds'] += game
        unreal.state['world_delta'] = game
        self.clock.now += wall
        for callback in list(unreal.state['ticks'].values()):
            callback(wall)

    def frames(self, count: int, game: float, wall: float) -> None:
        for _ in range(count):
            self.frame(game, wall)

    def commands(self) -> list[str]:
        return [call[1][1] for call in unreal.calls if call[0] == 'console']

    def released(self, action: str) -> int:
        return self.commands().count(f'Input.-action {action}')

    def value(self, action: str) -> float:
        """The value last forced on an action; 0 once let go."""
        for command in reversed(self.commands()):
            if command == f'Input.-action {action}':
                return 0.0
            if command.startswith(f'Input.+action {action} '):
                return float(command.rsplit(' ', 1)[1])
        return 0.0

    def route(self, points: list[tuple], closed: bool = False) -> unreal.Actor:
        """The game's GenexRoute: an actor with a spline through the points (cm)."""
        actor = unreal.Actor('GenexRoute', Vector())
        actor.tags = [Name('GenexRoute'), Name('genex:route')]
        actor.components = [unreal.SplineComponent('Route', [Vector(x, y, 0) for x, y in points], closed)]
        unreal.state['actors'].append(actor)
        return actor


class GameTimeHolds(PlayCase):
    def test_a_hold_lasts_its_game_seconds_however_slow_the_editor_runs(self) -> None:
        tool('hold', 'Throttle', 1.0, 0.0, 2.0)
        self.assertEqual(self.value(THROTTLE), 1.0)
        # Two frames a second: one game second takes five wall seconds.
        self.frames(10, game=0.1, wall=0.5)
        self.assertEqual(self.released(THROTTLE), 0, 'still held after 1 game second and 5 wall seconds')
        self.frames(9, game=0.1, wall=0.5)
        self.assertEqual(self.released(THROTTLE), 0)
        self.frames(1, game=0.1, wall=0.5)
        self.assertEqual(self.released(THROTTLE), 1, 'let go after 2 game seconds')
        self.assertEqual(unreal.state['ticks'], {}, 'nothing left to tick')

    def test_a_hold_in_a_stalled_play_session_ends_at_its_wall_clock_cap(self) -> None:
        tool('hold', 'Throttle', 1.0, 0.0, 2.0)
        self.frames(17, game=0.0, wall=1.0)
        self.assertEqual(self.released(THROTTLE), 0)
        self.frames(1, game=0.0, wall=1.0)
        self.assertEqual(self.released(THROTTLE), 1, '4 x 2 s + 10 s of wall clock')

    def test_holds_end_when_the_play_session_ends(self) -> None:
        tool('hold', 'Throttle', 1.0, 0.0, 5.0)
        unreal.state['pie'] = False
        self.frame(0.1, 0.1)
        self.assertEqual(unreal.state['ticks'], {})
        unreal.state['pie'] = True
        self.assertEqual(tool('player_state')['held'], [], 'the next play session starts with nothing held')


class Mouse(PlayCase):
    """The player's mouse moves and its wheel turns for exactly one frame of the game, as a mouse
    does: the game's own look mapping (Mouse XY 2D-Axis) turns the view by what moved. Unreal lets go
    of a forced analog key by injecting its opposite, which would turn the view straight back, so the
    key is forced to zero for a frame before it is let go."""

    def test_moves_the_mouse_for_one_frame_then_holds_it_still_before_letting_go(self) -> None:
        self.assertEqual(tool('mouse', 12.0, 5.0, 0.0), {'moved': [12.0, 5.0], 'wheel': 0.0})
        self.assertEqual(self.commands(), ['Input.+key Mouse2D X=12 Y=-5'], 'down on screen is negative y')
        self.frame(0.0, 0.0)
        self.assertEqual(len(self.commands()), 1, 'nothing until a game frame has run')
        self.frame(0.016, 0.016)
        self.assertEqual(self.commands()[-1], 'Input.+key Mouse2D X=0 Y=0', 'still after one frame')
        self.frame(0.016, 0.016)
        self.assertEqual(self.commands()[-1], 'Input.-key Mouse2D', 'let go once it was still for a frame')
        self.assertEqual(unreal.state['ticks'], {})

    def test_turns_the_wheel_for_one_frame_up_being_positive(self) -> None:
        tool('mouse', 0.0, 0.0, 2.0)
        self.frames(2, game=0.016, wall=0.016)
        self.assertEqual(self.commands(), ['Input.+key MouseWheelAxis 2', 'Input.+key MouseWheelAxis 0',
                                           'Input.-key MouseWheelAxis'])

    def test_lets_go_when_everything_is_let_go_or_the_game_clock_stalls(self) -> None:
        tool('mouse', 5.0, 0.0, 0.0)
        play.release_all()
        self.assertEqual(self.commands()[-1], 'Input.-key Mouse2D')
        unreal.calls.clear()
        tool('mouse', 5.0, 0.0, 0.0)
        self.frames(11, game=0.0, wall=1.0)
        self.assertEqual(self.commands()[-1], 'Input.-key Mouse2D', 'let go at the wall-clock cap')

    def test_nothing_to_move_forces_nothing(self) -> None:
        self.assertEqual(tool('mouse', 0.0, 0.0, 0.0), {'moved': [0.0, 0.0], 'wheel': 0.0})
        self.assertEqual(self.commands(), [])

    def test_without_a_play_session_it_is_an_error_not_an_exception(self) -> None:
        unreal.state['pie'] = False
        self.assertIn('error', tool('mouse', 5.0, 0.0, 0.0))


class Pause(PlayCase):
    """The play session's own pause, which Genex holds between a judge's moves so the game waits
    while the judge looks and decides."""

    def test_pauses_and_resumes_the_game(self) -> None:
        self.assertEqual(tool('pause', True), {'paused': True})
        self.assertTrue(unreal.state['paused'])
        self.assertEqual(tool('pause', False), {'paused': False})
        self.assertFalse(unreal.state['paused'])

    def test_without_a_play_session_it_is_an_error_not_an_exception(self) -> None:
        unreal.state['pie'] = False
        self.assertIn('error', tool('pause', True))


class Clocks(PlayCase):
    def test_player_state_reads_the_game_clock_and_the_frame_rate(self) -> None:
        tool('hold', 'Throttle', 1.0, 0.0, 10.0)
        self.frames(40, game=0.02, wall=0.125)
        state = tool('player_state')
        self.assertAlmostEqual(state['gameSeconds'], 0.8, places=2)
        self.assertAlmostEqual(state['fps'], 8.0, delta=0.1, msg='eight editor frames a wall second')
        self.assertEqual((state['pawn'], state['routeProgressM'], state['settle'], state['drive']),
                         (self.car.get_name(), None, None, None))

    def test_before_any_frame_the_rate_is_the_last_frames(self) -> None:
        unreal.state['game_seconds'], unreal.state['world_delta'] = 3.5, 0.04
        state = tool('player_state')
        self.assertEqual((state['gameSeconds'], state['fps']), (3.5, 25.0))

    def test_without_a_play_session_player_state_is_an_error_not_an_exception(self) -> None:
        unreal.state['pie'] = False
        self.assertIn('error', tool('player_state'))


class Settle(PlayCase):
    def test_a_pawn_at_rest_for_one_game_second_is_settled(self) -> None:
        self.assertEqual(tool('settle', 8.0), {'watching': True, 'seconds': 8.0})
        self.frames(9, game=0.1, wall=0.4)
        self.assertEqual(tool('player_state')['settle']['state'], 'watching')
        self.frames(3, game=0.1, wall=0.4)
        settle = tool('player_state')['settle']
        self.assertEqual(settle['state'], 'settled')
        self.assertTrue(1.0 <= settle['gameSeconds'] <= 1.3, f"one game second at rest, then a frame: {settle}")
        self.assertEqual(settle['speedCmS'], 0)

    def test_a_pawn_still_moving_when_the_game_seconds_run_out_is_unsettled(self) -> None:
        self.car.velocity = Vector(300, 0, 0)
        tool('settle', 2.0)
        self.frames(19, game=0.1, wall=0.4)
        self.assertEqual(tool('player_state')['settle']['state'], 'watching')
        self.frames(2, game=0.1, wall=0.4)
        settle = tool('player_state')['settle']
        self.assertEqual((settle['state'], settle['speedCmS']), ('unsettled', 300))

    def test_a_slow_pawn_whose_height_keeps_changing_is_not_settled(self) -> None:
        tool('settle', 3.0)
        for _ in range(25):
            self.car.location = Vector(0, 0, self.car.location.z - 3)
            self.frame(0.1, 0.1)
        self.assertEqual(tool('player_state')['settle']['state'], 'watching')

    def test_a_stalled_play_session_ends_the_settle_at_its_wall_clock_cap(self) -> None:
        self.car.velocity = Vector(300, 0, 0)
        tool('settle', 8.0)
        self.frames(41, game=0.0, wall=1.0)
        self.assertEqual(tool('player_state')['settle']['state'], 'watching')
        self.frames(1, game=0.0, wall=1.0)
        self.assertEqual(tool('player_state')['settle']['state'], 'unsettled')

    def test_seconds_are_clamped_and_nonsense_is_refused(self) -> None:
        self.assertEqual(tool('settle', 30.0)['seconds'], 8.0)
        self.assertGreater(tool('settle', 0.0)['seconds'], 0.0)
        for bad in (float('nan'), float('inf'), float('-inf')):
            with self.subTest(seconds=bad):
                self.assertIn('error', tool('settle', bad))

    def test_without_a_play_session_settle_is_refused(self) -> None:
        unreal.state['pie'] = False
        self.assertIn('error', tool('settle', 8.0))
        self.assertEqual(unreal.state['ticks'], {})


class DriveWithoutRoute(PlayCase):
    def test_without_a_route_it_holds_the_throttle_for_its_game_seconds(self) -> None:
        self.assertEqual(tool('drive_route', 5.0, 'Throttle', 'Steering'),
                         {'driving': True, 'seconds': 5.0, 'route': False})
        self.assertEqual(self.value(THROTTLE), 1.0)
        self.frames(49, game=0.1, wall=0.3)
        self.assertEqual(tool('player_state')['drive']['state'], 'driving')
        self.frames(2, game=0.1, wall=0.3)
        drive = tool('player_state')['drive']
        self.assertEqual((drive['state'], drive['route'], drive['progressM']), ('done', False, None))
        self.assertAlmostEqual(drive['gameSeconds'], 5.0, delta=0.15)
        self.assertEqual(self.released(THROTTLE), 1)
        self.assertNotIn(STEERING, ' '.join(self.commands()), 'no route, no steering')

    def test_seconds_are_clamped_to_thirty(self) -> None:
        self.assertEqual(tool('drive_route', 90.0, 'Throttle', 'Steering')['seconds'], 30.0)


class DriveAlongRoute(PlayCase):
    def drive(self, seconds: float, dt: float = 0.05, speed: float = 1000.0, yaw_rate: float = 60.0) -> float:
        """Plays the car: each frame it turns by the forced steering and rolls forward; the farthest it strayed."""
        route = [(p.x, p.y) for p in unreal.state['actors'][-1].components[0].points]
        worst = 0.0
        for _ in range(round(seconds / dt) + 2):
            yaw = self.car.rotation.yaw + self.value(STEERING) * yaw_rate * dt
            rad = math.radians(yaw)
            moving = self.value(THROTTLE) * speed
            self.car.rotation = Rotator(0, 0, yaw)
            self.car.velocity = Vector(moving * math.cos(rad), moving * math.sin(rad), 0)
            self.car.location = Vector(self.car.location.x + self.car.velocity.x * dt,
                                       self.car.location.y + self.car.velocity.y * dt, 50)
            worst = max(worst, min(math.hypot(self.car.location.x - x, self.car.location.y - y) for x, y in route))
            self.frame(dt, dt * 3)
        return worst

    def test_it_follows_a_closed_route_round_by_steering_through_the_forced_input(self) -> None:
        radius, points = 3000.0, 120
        self.route([(radius * math.sin(2 * math.pi * i / points), radius * (1 - math.cos(2 * math.pi * i / points)))
                    for i in range(points)], closed=True)
        self.assertEqual(tool('drive_route', 20.0, 'Throttle', 'Steering'), {'driving': True, 'seconds': 20.0, 'route': True})
        worst = self.drive(20.0)
        self.assertLess(worst, 300.0, 'the car stayed on the route all the way round')
        state = tool('player_state')
        self.assertEqual((state['drive']['state'], state['drive']['route']), ('done', True))
        self.assertGreater(state['drive']['progressM'], 170.0, 'past the start of the loop: progress wraps')
        self.assertLess(state['drive']['progressM'], 205.0)
        self.assertEqual(state['routeProgressM'], state['drive']['progressM'])
        self.assertEqual((self.released(THROTTLE), self.released(STEERING)), (1, 1))

    def ride(self, seconds: float, dt: float = 0.05) -> float:
        """Plays a car with grip: the forced throttle speeds it up and the brake slows it, and how hard
        it can turn falls as it goes faster (sideways grip of 6 m/s2); the farthest it strayed (cm)."""
        route = [(p.x, p.y) for p in unreal.state['actors'][-1].components[0].points]
        worst, speed = 0.0, 0.0  # m/s
        for _ in range(round(seconds / dt) + 2):
            speed = max(0.0, min(40.0, speed + (self.value(THROTTLE) * 5.0 - self.value(BRAKE) * 9.0) * dt))
            asked = math.radians(self.value(STEERING) * 60.0)
            grip = 6.0 / speed if speed > 0.1 else asked
            turn = max(-grip, min(grip, asked))
            yaw = self.car.rotation.yaw + math.degrees(turn * dt)
            rad = math.radians(yaw)
            self.car.rotation = Rotator(0, 0, yaw)
            self.car.velocity = Vector(speed * 100 * math.cos(rad), speed * 100 * math.sin(rad), 0)
            self.car.location = Vector(self.car.location.x + self.car.velocity.x * dt,
                                       self.car.location.y + self.car.velocity.y * dt, 50)
            worst = max(worst, min(math.hypot(self.car.location.x - x, self.car.location.y - y) for x, y in route))
            self.frame(dt, dt * 3)
        return worst

    def test_it_slows_for_a_tight_loop_so_a_car_with_grip_stays_on_it(self) -> None:
        """At full throttle a car runs wide of a tight loop; the paced drive keeps it on the route."""
        radius, points = 2500.0, 120
        self.route([(radius * math.sin(2 * math.pi * i / points), radius * (1 - math.cos(2 * math.pi * i / points)))
                    for i in range(points)], closed=True)
        tool('drive_route', 30.0, 'Throttle', 'Steering')
        self.assertLess(self.ride(30.0), 400.0, 'the car kept to the loop at a pace it could turn at')
        self.assertGreater(tool('player_state')['drive']['progressM'], 150.0, 'and still made progress')
        self.assertEqual(self.released(BRAKE), 1, 'the brake is let go at the end')

    def test_a_game_without_a_brake_action_still_drives_by_easing_off(self) -> None:
        unreal.state['registry'] = [a for a in unreal.state['registry'] if BRAKE not in str(a.package_name)]
        self.route([(0, 0), (10000, 0)])
        self.assertEqual(tool('drive_route', 5.0, 'Throttle', 'Steering')['route'], True)
        self.assertNotIn(BRAKE, ' '.join(self.commands()))

    def test_unforced_the_car_would_leave_the_route(self) -> None:
        """The control case: with the steering never forced, the same car runs off the same loop."""
        radius, points = 3000.0, 120
        self.route([(radius * math.sin(2 * math.pi * i / points), radius * (1 - math.cos(2 * math.pi * i / points)))
                    for i in range(points)], closed=True)
        tool('hold', 'Throttle', 1.0, 0.0, 10.0)
        self.assertGreater(self.drive(10.0), 1000.0)

    def test_a_game_without_the_steering_action_is_refused_before_anything_is_pressed(self) -> None:
        self.route([(0, 0), (10000, 0)])
        result = tool('drive_route', 10.0, 'Throttle', 'Steer')
        self.assertIn('error', result)
        self.assertEqual(self.commands(), [])
        self.assertEqual(unreal.state['ticks'], {})

    def test_release_all_ends_the_drive_and_lets_go_of_both_inputs(self) -> None:
        self.route([(0, 0), (10000, 0)])
        tool('drive_route', 10.0, 'Throttle', 'Steering')
        self.drive(1.0)
        play.release_all()
        self.assertEqual(tool('player_state')['drive']['state'], 'done')
        self.assertEqual(self.released(THROTTLE), 1)


class ProbeRoute(PlayCase):
    def test_it_measures_the_player_against_the_route(self) -> None:
        self.route([(0, 0), (10000, 0)])
        self.car.location = Vector(2500, 300, 50)
        self.car.rotation = Rotator(0, 0, 20)
        self.assertEqual(tool('probe_route'),
                         {'route': True, 'facingDeg': 20.0, 'offRouteCm': 300, 'progressM': 25.0, 'lengthM': 100.0})

    def test_a_game_without_a_route_says_so(self) -> None:
        self.assertEqual(tool('probe_route'),
                         {'route': False, 'facingDeg': None, 'offRouteCm': None, 'progressM': None, 'lengthM': None})

    def test_without_a_play_session_it_is_refused(self) -> None:
        unreal.state['pie'] = False
        self.assertIn('error', tool('probe_route'))


if __name__ == '__main__':
    unittest.main()
