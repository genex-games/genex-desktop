"""The build tools' eyes. capture_shot takes a still from a hero camera in the editor world;
capture_play and motion_strip take the player's view during play through the player's own console
(HighResShot), which shows the play session's viewport wherever it is.

Every high-resolution shot freezes the game clock while it renders, so a strip that asked for its
frames by the wall clock kept landing in the same frozen moment: consecutive frames came out
identical while the pawn was said to move. A strip now asks for a frame only when the GAME clock has
moved `interval_s` past the last one and the last one is on disk, and records the pawn's and the
view's position the moment it asks. Refused input queues nothing."""

import json
import os
import unittest
from unittest import mock

import unreal
from unreal import Rotator, Vector

from genex_build import shots
from genex_build.tools import GenexBuildTools
from genex_play import play
from genex_play.tools import GenexPlayTools

from support import HelperCase

SETTINGS = '/Script/UnrealEd.EditorPerformanceSettings'


def tool(name: str, *args) -> dict:
    return json.loads(getattr(GenexBuildTools, name)(*args))


class Clock:
    """The wall clock the play tools and the waits read (time.monotonic), moved by the test."""

    def __init__(self) -> None:
        self.now = 500.0

    def monotonic(self) -> float:
        return self.now

    def time(self) -> float:
        return 1_800_000_000.0 + self.now


class EyesCase(HelperCase):
    """An editor whose "Use Less CPU when in Background" is on, with a moved clock."""

    def setUp(self) -> None:
        super().setUp()
        self.settings = unreal.Object()
        self.settings.set_editor_property('bThrottleCPUWhenNotForeground', True)
        self.settings.get_editor_property = lambda name: self.settings.props[name]
        unreal.state['classes'][SETTINGS] = unreal.Class(path=SETTINGS, cdo=self.settings)
        self.clock = Clock()
        for module in (play, shots):
            patcher = mock.patch.object(module, 'time', self.clock)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.addCleanup(play.release_all)

    def throttled(self) -> bool:
        return self.settings.props['bThrottleCPUWhenNotForeground']

    def tick(self, game: float = 0.0, wall: float = 0.0) -> None:
        unreal.state['game_seconds'] += game
        unreal.state['world_delta'] = game
        self.clock.now += wall
        for callback in list(unreal.state['ticks'].values()):
            callback(wall)

    def captures(self) -> str:
        return os.path.join(self.project, 'Saved', 'Genex', 'captures')

    def shots_asked(self) -> list[str]:
        return [call[1][1] for call in unreal.calls if call[0] == 'console' and call[1][1].startswith('HighResShot')]


class Stills(EyesCase):
    def setUp(self) -> None:
        super().setUp()
        self.hero = unreal.CameraActor('GX_Shot_Hall', Vector(0, 0, 200))
        unreal.state['actors'] = [self.hero, unreal.CameraActor('SomeCamera', Vector())]

    def test_refuses_sizes_delays_and_cameras_it_cannot_take_without_queuing_anything(self) -> None:
        cases = {
            'too narrow': ('Hall', 100, 720, 2.0),
            'too wide': ('Hall', 9000, 720, 2.0),
            'a fractional size': ('Hall', 1280.5, 720, 2.0),
            'a negative delay': ('Hall', 1280, 720, -1.0),
            'too long a delay': ('Hall', 1280, 720, 60.0),
            'a delay that is not a number': ('Hall', 1280, 720, 'soon'),
            'no such camera': ('Roof', 1280, 720, 2.0),
        }
        for label, args in cases.items():
            with self.subTest(label):
                self.fresh()
                result = tool('capture_shot', *args)
                self.assertIn('error', result)
                self.assertEqual(unreal.calls, [])
                self.assertTrue(self.throttled(), 'the throttle is untouched')
        self.assertIn('GX_Shot_Hall', tool('capture_shot', 'Roof', 1280, 720, 2.0)['error'], 'it names the hero cameras')

    def test_during_play_it_points_to_capture_play(self) -> None:
        unreal.state['pie'] = True
        self.assertIn('capture_play', tool('capture_shot', 'Hall', 1280, 720, 2.0)['error'])

    def test_a_still_comes_from_the_hero_camera_after_its_delay_in_game_view_with_the_throttle_lifted_meanwhile(self) -> None:
        unreal.state['shot_done'] = False
        result = tool('capture_shot', 'Hall', 1920, 1080, 3.0)
        self.assertEqual(result['camera'], 'GX_Shot_Hall')
        self.assertEqual(result['file'], os.path.join(self.captures(), 'shot-GX_Shot_Hall.png'))
        [shot] = unreal.state['screenshots']
        self.assertEqual((shot['camera'], shot['delay'], shot['game_view']), (self.hero, 3.0, True))
        self.assertIn(('viewport_realtime', True), unreal.calls)
        self.assertFalse(self.throttled(), 'lifted while the frame settles')
        self.tick(wall=1.0)
        self.assertFalse(self.throttled())
        unreal.state['shot_done'] = True
        self.tick(wall=0.1)
        self.assertTrue(self.throttled(), 'given back once the shot is done')
        self.assertEqual(unreal.state['ticks'], {}, 'nothing left ticking')

    def test_an_empty_camera_means_the_first_hero_camera(self) -> None:
        self.assertEqual(tool('capture_shot', '', 0, 0, 0.0)['camera'], 'GX_Shot_Hall')

    def test_shot_cameras_names_the_hero_cameras_by_label_and_nothing_else(self) -> None:
        unreal.state['actors'].append(unreal.CameraActor('GX_Shot_Atrium', Vector(0, 900, 300)))
        self.assertEqual(tool('shot_cameras'), {'cameras': ['GX_Shot_Atrium', 'GX_Shot_Hall']})
        self.assertEqual(unreal.calls, [], 'reading the cameras changes nothing')
        unreal.state['actors'] = []
        self.assertEqual(tool('shot_cameras'), {'cameras': []})


class PlayCase(EyesCase):
    """A play session with the player's pawn at the origin and a camera behind it."""

    def setUp(self) -> None:
        super().setUp()
        unreal.state['pie'] = True
        self.pawn = unreal.Character('BP_Hero_0', Vector(0, 0, 90))
        unreal.state['player'] = self.pawn
        unreal.state['actors'] = [self.pawn]
        unreal.state['camera'] = unreal.PlayerCameraManager(Vector(-400, 0, 300), Rotator(0, -10, 0))

    def walk(self, x: float) -> None:
        """The pawn and the view that follows it move to x."""
        self.pawn.location = Vector(x, 0, 90)
        unreal.state['camera'].location = Vector(x - 400, 0, 300)


class PlayShots(PlayCase):
    def test_a_play_shot_goes_through_the_players_console_and_answers_the_pose_it_shows(self) -> None:
        self.walk(250)
        result = tool('capture_play', 'look', 1280, 720)
        file = os.path.join(self.captures(), 'look.png')
        self.assertEqual(self.shots_asked(), [f'HighResShot 1280x720 filename="{file}"'])
        self.assertEqual((result['pawn'], result['view']), ([250, 0, 90], [-150, 0, 300]))

    def test_the_frame_rate_leaves_out_the_frame_a_shot_froze(self) -> None:
        # A shot freezes the editor for about a second; counted in, a 20 fps game read 2-4 fps.
        self.clock.now += 3600.0  # past every frame an earlier test counted
        self.assertIn('held', json.loads(GenexPlayTools.hold('W', 1.0, 0.0, 30.0)))
        for _ in range(20):
            self.tick(0.05, 0.05)
        self.assertTrue(tool('capture_play', 'look', 1280, 720)['queued'])
        self.tick(0.05, 1.2)
        for _ in range(6):
            self.tick(0.05, 0.05)
        self.assertAlmostEqual(play.fps(), 20.0, delta=0.5)
        play.release_all()
        self.tick()  # one frame after letting go, so no tick outlives the test

    def test_without_a_play_session_or_with_a_path_for_a_name_nothing_is_asked(self) -> None:
        for label, args, pie in (('no play', ('look', 1280, 720), False), ('a path', ('../look', 1280, 720), True),
                                 ('a bad size', ('look', 10, 10), True)):
            with self.subTest(label):
                unreal.state['pie'] = pie
                self.fresh()
                self.assertIn('error', tool('capture_play', *args))
                self.assertEqual(self.shots_asked(), [])


class Strips(PlayCase):
    def land(self, index: int) -> None:
        """Unreal writes the frame asked for `index`."""
        asked = self.shots_asked()[index]
        file = asked.split('filename="', 1)[1].rstrip('"')
        with open(file, 'wb') as handle:
            handle.write(b'\x89PNG frame')

    def test_frames_follow_the_game_clock_one_at_a_time_never_the_wall_clock(self) -> None:
        answer = tool('motion_strip', 3, 1.0)
        self.assertEqual(len(answer['files']), 3)
        self.assertEqual(len(self.shots_asked()), 0, 'asked on the next frame, not inside the call')
        self.tick(game=0.02, wall=0.02)
        self.assertEqual(len(self.shots_asked()), 1, 'the first frame at once')
        # The shot freezes the game clock; the wall clock runs on. No second frame while the first isn't on disk.
        self.tick(game=0.0, wall=5.0)
        self.assertEqual(len(self.shots_asked()), 1)
        self.land(0)
        # Still no game time passed: a frame asked now would show the same frozen moment.
        self.tick(game=0.0, wall=5.0)
        self.tick(game=0.0, wall=5.0)
        self.assertEqual(len(self.shots_asked()), 1, 'no new frame before the game clock moves on')
        self.walk(300)
        self.tick(game=0.6, wall=0.1)
        self.assertEqual(len(self.shots_asked()), 1)
        self.walk(500)
        self.tick(game=0.5, wall=0.1)
        self.assertEqual(len(self.shots_asked()), 2, 'one game second after the first')
        self.land(1)
        self.walk(900)
        self.tick(game=1.0, wall=0.1)
        self.tick(game=0.1, wall=0.1)
        self.assertEqual(len(self.shots_asked()), 3)
        self.land(2)
        self.tick(game=0.1, wall=0.1)
        with open(answer['poses'], encoding='utf-8') as handle:
            record = json.load(handle)
        self.assertEqual([frame['pawn'] for frame in record['frames']], [[0, 0, 90], [500, 0, 90], [900, 0, 90]])
        self.assertEqual([frame['view'] for frame in record['frames']], [[-400, 0, 300], [100, 0, 300], [500, 0, 300]])
        times = [frame['gameSeconds'] for frame in record['frames']]
        self.assertTrue(all(b - a >= 1.0 for a, b in zip(times, times[1:])), times)
        self.assertEqual(record['files'], answer['files'])
        self.assertTrue(self.throttled(), 'the throttle is given back when the strip is done')

    def test_a_frame_that_never_lands_ends_the_strip_with_why(self) -> None:
        answer = tool('motion_strip', 2, 0.5)
        self.tick(game=0.02, wall=0.02)
        self.tick(game=0.0, wall=shots.FRAME_WAIT_S + 1)
        with open(answer['poses'], encoding='utf-8') as handle:
            record = json.load(handle)
        self.assertIn('never landed', record['error'])

    def test_refuses_counts_and_intervals_out_of_range_and_a_strip_without_play(self) -> None:
        for frames, interval in ((1, 1.0), (13, 1.0), (True, 1.0), (3, 0.0), (3, 9.0), (3, 'fast')):
            with self.subTest(frames=frames, interval=interval):
                self.fresh()
                self.assertIn('error', tool('motion_strip', frames, interval))
                self.assertEqual(unreal.state['ticks'], {})
        unreal.state['pie'] = False
        self.assertIn('error', tool('motion_strip', 3, 1.0))


if __name__ == '__main__':
    unittest.main()
