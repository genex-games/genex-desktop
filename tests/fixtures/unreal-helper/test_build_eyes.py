"""The build tools' eyes. capture_shot takes a still from a hero camera in the editor world;
capture_play and motion_strip take the player's view during play through the player's own console
(HighResShot), which shows the play session's viewport wherever it is.

Every high-resolution shot freezes the game clock while it renders, so a strip that asked for its
frames by the wall clock kept landing in the same frozen moment: consecutive frames came out
identical while the pawn was said to move. A strip now asks for a frame only when the GAME clock has
moved `interval_s` past the last one and the last one is on disk, records the pawn's and the view's
position the moment it asks, and holds the game all but still until the frame is on disk: the frame
after a shot's stall moved a sword duel's game up to 0.4 s on. Refused input queues nothing."""

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


class TickingClock:
    """The test's clock, moving a microsecond on every read, as a real one does between calls in one frame."""

    def __init__(self, clock: Clock) -> None:
        self.clock = clock

    def monotonic(self) -> float:
        self.clock.now += 1e-6
        return self.clock.now

    def time(self) -> float:
        return self.clock.time()


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
        game *= unreal.state['time_dilation']
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
        self.tick(game=0.03, wall=0.03)
        self.tick(game=0.03, wall=0.03)
        self.walk(900)
        self.tick(game=1.0, wall=0.1)
        self.assertEqual(len(self.shots_asked()), 3)
        self.land(2)
        for _ in range(3):
            self.tick(game=0.1, wall=0.1)
        with open(answer['poses'], encoding='utf-8') as handle:
            record = json.load(handle)
        self.assertEqual([frame['pawn'] for frame in record['frames']], [[0, 0, 90], [500, 0, 90], [900, 0, 90]])
        self.assertEqual([frame['view'] for frame in record['frames']], [[-400, 0, 300], [100, 0, 300], [500, 0, 300]])
        times = [frame['gameSeconds'] for frame in record['frames']]
        self.assertTrue(all(b - a >= 1.0 for a, b in zip(times, times[1:])), times)
        self.assertEqual(record['files'], answer['files'])
        self.assertTrue(self.throttled(), 'the throttle is given back when the strip is done')

    def test_the_game_is_held_still_while_a_frame_is_drawn_and_written_then_runs_on(self) -> None:
        # A shot stalls the editor about a second, and the frame after the stall moved the duel's game up
        # to 0.4 s on: a 0.05 s burst came out 0.02 to 0.42 s apart, and a picture 2 m past its pose.
        answer = tool('motion_strip', 2, 0.05)
        self.tick(game=0.02, wall=0.02)
        self.assertEqual(unreal.state['time_dilation'], shots.FREEZE_DILATION)
        asked_at = unreal.state['game_seconds']
        self.tick(game=0.4, wall=1.0)  # the long frame after the shot's stall
        self.assertLess(unreal.state['game_seconds'] - asked_at, 0.001, 'the game barely moved')
        self.land(0)
        self.tick(game=0.03, wall=0.03)
        self.assertEqual(unreal.state['time_dilation'], shots.FREEZE_DILATION, 'still held as the file lands')
        self.tick(game=0.4, wall=0.4)  # the long frame that can follow a shot's write
        self.assertLess(unreal.state['game_seconds'] - asked_at, 0.001, 'the game barely moved')
        self.assertEqual(unreal.state['time_dilation'], 1.0, 'it runs on once that frame is past')
        for _ in range(2):
            self.tick(game=0.03, wall=0.03)
        self.assertEqual(len(self.shots_asked()), 2)
        self.land(1)
        for _ in range(3):
            self.tick(game=0.03, wall=0.03)
        with open(answer['poses'], encoding='utf-8') as handle:
            times = [frame['gameSeconds'] for frame in json.load(handle)['frames']]
        self.assertAlmostEqual(times[1] - times[0], 0.06, places=2)
        self.assertEqual(unreal.state['time_dilation'], 1.0)

    def end_watching(self) -> None:
        """Ends the play's own watches, and the frame after, so no tick outlives the test."""
        play.release_all()
        self.tick()

    def settle(self, index: int) -> None:
        """Frame `index` lands, and the world frame the game stays held after it passes."""
        self.land(index)
        self.tick(game=0.03, wall=0.03)
        self.tick(game=0.03, wall=0.03)

    def test_a_slow_motion_the_game_sets_while_a_frame_is_taken_is_kept(self) -> None:
        tool('motion_strip', 2, 0.05)
        self.tick(game=0.02, wall=0.02)
        unreal.state['time_dilation'] = 0.3  # a hit's slow motion, set by the game meanwhile
        self.settle(0)
        self.assertEqual(unreal.state['time_dilation'], 0.3)
        unreal.state['pie'] = False
        self.tick()  # the play ends, and the strip with it

    def test_a_slow_motion_the_game_had_before_a_frame_is_given_back(self) -> None:
        unreal.state['time_dilation'] = 0.5
        tool('motion_strip', 2, 0.05)
        self.tick(game=0.02, wall=0.02)
        self.assertEqual(unreal.state['time_dilation'], shots.FREEZE_DILATION)
        self.settle(0)
        self.assertEqual(unreal.state['time_dilation'], 0.5)
        unreal.state['pie'] = False
        self.tick()

    def test_a_game_that_cannot_be_slowed_as_far_is_held_as_far_as_it_goes_then_given_back(self) -> None:
        # A world whose least time dilation is raised clamps the freeze: read back, it is still the strip's.
        unreal.state['min_time_dilation'] = 0.01
        tool('motion_strip', 2, 0.05)
        self.tick(game=0.02, wall=0.02)
        self.assertEqual(unreal.state['time_dilation'], 0.01)
        self.settle(0)
        self.assertEqual(unreal.state['time_dilation'], 1.0)
        unreal.state['pie'] = False
        self.tick()

    def test_a_hold_runs_its_game_seconds_however_long_the_frames_hold_the_game(self) -> None:
        # Held, the game barely moves while the wall clock runs on: a cap that counted those seconds let go of
        # a key held for 2 game seconds once two frames had taken 10 s each to land.
        self.addCleanup(self.end_watching)
        self.assertIn('held', json.loads(GenexPlayTools.hold('W', 1.0, 0.0, 2.0)))
        tool('motion_strip', 2, 0.5)
        for index in range(2):
            self.tick(game=0.5, wall=0.5)  # a frame asked, the game held
            self.tick(game=0.0, wall=10.0)
            self.settle(index)
        self.assertEqual(json.loads(GenexPlayTools.player_state())['held'], ['W'])
        # Not held, the cap counts on: 4 x 2 s + 10 s of wall clock in all.
        for _ in range(18):
            self.tick(game=0.0, wall=1.0)
        self.assertEqual(json.loads(GenexPlayTools.player_state())['held'], [])

    def test_a_shot_after_a_strip_still_excuses_the_frame_its_stall_froze(self) -> None:
        # The caps' clock stands still while a strip holds the game; timed on it, a later shot's stall read as a hitch.
        def findings() -> list:
            return [finding['code'] for finding in json.loads(GenexPlayTools.player_state(True))['findings']]
        self.addCleanup(self.end_watching)
        self.assertEqual(findings(), [])
        for _ in range(250):  # past the first seconds, which are the level loading
            self.tick(game=0.016, wall=0.016)
        tool('motion_strip', 2, 0.05)
        for index in range(2):
            self.tick(game=0.06, wall=0.06)  # a frame asked, the game held
            self.tick(game=0.0, wall=2.0)  # the shot renders and is written
            self.settle(index)
        self.assertTrue(tool('capture_play', 'look', 1280, 720)['queued'])
        self.tick(game=0.016, wall=1.2)  # the frame that renders the shot
        self.assertEqual(findings(), [])
        self.tick(game=0.016, wall=1.2)  # a frame no shot froze
        self.assertEqual(findings(), ['hitch'])

    def test_a_strip_shot_excuses_its_stall_whatever_watch_steps_first(self) -> None:
        # Started before the play's own watch, the strip notes its shot a moment before that watch steps in
        # the same frame: timed from then, the frame that renders the shot read as a hitch.
        ticking = TickingClock(self.clock)
        for module in (play, shots):
            patcher = mock.patch.object(module, 'time', ticking)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.addCleanup(self.end_watching)
        tool('motion_strip', 2, 4.0)
        self.assertEqual(json.loads(GenexPlayTools.player_state(True))['findings'], [])
        self.tick(game=0.02, wall=0.02)
        self.settle(0)
        for _ in range(400):  # past the first seconds and the next frame's due time
            self.tick(game=0.016, wall=0.016)
            if len(self.shots_asked()) == 2:
                break
        self.assertEqual(len(self.shots_asked()), 2)
        self.tick(game=0.0, wall=1.2)  # the frame that renders frame 1
        self.settle(1)
        self.assertEqual(json.loads(GenexPlayTools.player_state(True))['findings'], [])

    def test_a_strip_stepped_after_it_finished_asks_nothing_and_holds_nothing(self) -> None:
        self.addCleanup(self.end_watching)
        tool('motion_strip', 2, 0.05)
        self.tick(game=0.02, wall=0.02)
        strip = shots._strip[0]
        strip.finish('the play session ended')
        self.assertEqual(unreal.state['time_dilation'], 1.0, 'let go as it finishes')
        self.land(0)
        self.assertFalse(strip.step(1.0, 1.0))
        self.assertEqual((len(self.shots_asked()), unreal.state['time_dilation']), (1, 1.0))

    def test_a_frame_that_never_lands_ends_the_strip_with_why(self) -> None:
        answer = tool('motion_strip', 2, 0.5)
        self.tick(game=0.02, wall=0.02)
        self.tick(game=0.0, wall=shots.FRAME_WAIT_S + 1)
        with open(answer['poses'], encoding='utf-8') as handle:
            record = json.load(handle)
        self.assertIn('never landed', record['error'])
        self.assertEqual(unreal.state['time_dilation'], 1.0, 'the game runs on')

    def test_refuses_counts_and_intervals_out_of_range_and_a_strip_without_play(self) -> None:
        for frames, interval in ((1, 1.0), (25, 1.0), (True, 1.0), (3, 0.0), (3, 0.02), (3, 9.0), (3, 'fast')):
            with self.subTest(frames=frames, interval=interval):
                self.fresh()
                self.assertIn('error', tool('motion_strip', frames, interval))
                self.assertEqual(unreal.state['ticks'], {})
        unreal.state['pie'] = False
        self.assertIn('error', tool('motion_strip', 3, 1.0))


if __name__ == '__main__':
    unittest.main()
