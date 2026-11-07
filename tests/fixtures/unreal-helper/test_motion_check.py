"""motion_check measures a character's motion on the body the player sees, every frame of a play: a
sword duel's fighters slid for hours while stills, a critic and the old slide detector all said they
walked. The detector read the character's own mesh, which on a Motion Matching character is a hidden
driver, so it never measured the fighters at all; and a still can't show a foot riding along with the
body. The check reads the visible Body, and tells sliding (the stance foot moving with the body),
pose pops, snap turns, montages stopped early, started over or stuck at their start, hidden frames, and
frames too far apart to read; a body that steps, swings a sword, turns at a turn's pace and lets go of a
looping run is clean."""

import json
import math
import os
import sys
import unittest
from unittest import mock

import unreal
from unreal import Rotator, Vector

from genex_build import motion_check, motion_check_math as maths
from genex_build.tools import GenexBuildTools
from genex_play import play

from test_build_eyes import PlayCase

FPS = 30.0
SPEED = 300.0
# One stride: each foot stands still for half of it while the body passes over it, then swings ahead.
STRIDE_S = 0.8
FOOT_LIFT_CM = 12.0
ROOT_Z = 90.0


def tool(name: str, *args) -> dict:
    return json.loads(getattr(GenexBuildTools, name)(*args))


def foot_x(t: float, offset: float, speed: float) -> tuple[float, float]:
    """(world x, height) of a foot that steps under a body moving at `speed` along x."""
    s = t / STRIDE_S + offset
    k, f = math.floor(s), s - math.floor(s)
    planted = speed * STRIDE_S * (k - offset) + speed * STRIDE_S / 4
    if f < 0.5:
        return planted, 2.0
    swing = (f - 0.5) * 2
    return planted + speed * STRIDE_S * swing, 2.0 + FOOT_LIFT_CM * math.sin(math.pi * swing)


def walk(seconds: float = 3.0, speed: float = SPEED, legs: str = 'stepping', **change) -> list:
    """Frames of a body walking along x: its feet stepping, riding along with it ('skating'), or a walk
    clip playing at half the pace the body moves ('half')."""
    frames = []
    for i in range(int(seconds * FPS)):
        t = i / FPS
        x = speed * t
        if legs == 'stepping':
            feet = {side: foot_x(t, offset, speed) for side, offset in (('l', 0.0), ('r', 0.5))}
        elif legs == 'half':
            feet = {side: foot_x(t, offset, speed / 2) for side, offset in (('l', 0.0), ('r', 0.5))}
            feet = {side: (fx + speed * t / 2, z) for side, (fx, z) in feet.items()}
        else:
            feet = {'l': (x + 10, 2.0), 'r': (x - 10, 2.0)}
        frame = {'t': t, 'root': (x, 0.0, ROOT_Z), 'yaw': 0.0,
                 'feet': {side: (fx, -12.0 if side == 'l' else 12.0, z) for side, (fx, z) in feet.items()},
                 'bones': {'pelvis': (0.0, 0.0, 0.0), 'head': (0.0, 0.0, 70.0),
                           'hand_r': (20.0 * math.sin(t * 4), 20.0, 0.0)},
                 'montages': {}, 'hidden': False, 'ragdoll': False, 'falling': False}
        frames.append(frame)
    for key, edit in change.items():
        for frame in frames:
            edit(frame)
    return frames


def codes(report: dict) -> list:
    return [problem['code'] for problem in report['problems']]


class Sliding(unittest.TestCase):
    def test_a_body_that_steps_has_still_planted_feet_and_no_problem(self) -> None:
        report = maths.report(walk())
        self.assertLess(report['slide']['ratio'], 0.05)
        self.assertEqual(codes(report), [])
        self.assertEqual(report['verdict'], 'clean')

    def test_feet_that_ride_along_with_the_body_slide(self) -> None:
        report = maths.report(walk(legs='skating'))
        self.assertGreater(report['slide']['ratio'], 0.9)
        self.assertEqual(codes(report), [maths.SLIDING])
        self.assertIn('slide', report['problems'][0]['detail'])

    def test_a_walk_clip_playing_at_half_the_bodys_pace_slides(self) -> None:
        report = maths.report(walk(legs='half'))
        self.assertGreater(report['slide']['ratio'], maths.SLIDE_MAX)
        self.assertEqual(codes(report), [maths.SLIDING])

    def test_a_planted_foot_that_glides_a_little_like_a_lunges_is_not_sliding(self) -> None:
        # The duel's fixed slash read 0.18 to 0.24 in Unreal, its bug 1.0.
        def glide(frame: dict) -> None:
            for side, (x, y, z) in frame['feet'].items():
                frame['feet'][side] = (x + 0.25 * SPEED * frame['t'], y, z)
        frames = walk(glide=glide)
        report = maths.report(frames)
        self.assertAlmostEqual(report['slide']['ratio'], 0.25, delta=0.03)
        self.assertEqual(codes(report), [])

    def test_a_body_standing_still_is_not_measured_as_sliding(self) -> None:
        report = maths.report(walk(speed=0.0, legs='skating'))
        self.assertIsNone(report['slide']['ratio'])
        self.assertEqual(codes(report), [])

    def test_a_jump_carries_the_feet_with_the_body_without_sliding(self) -> None:
        def airborne(frame: dict) -> None:
            frame['falling'] = True
        report = maths.report(walk(legs='skating', jump=airborne))
        self.assertEqual(report['slide']['movingFrames'], 0)
        self.assertEqual(codes(report), [])

    def test_a_long_frame_a_strides_stance_changes_inside_is_not_read_for_sliding(self) -> None:
        # A shot's stall can leave one 0.4 s frame, half a stride: the foot that stood has stepped on.
        frames = walk()
        before, after = frames[:30], frames[42:]
        moving = maths.slide(before)['movingFrames'] + maths.slide(after)['movingFrames']
        self.assertEqual(maths.slide(before + after)['movingFrames'], moving)

    def test_frames_too_far_apart_to_read_are_a_problem_never_a_clean_check(self) -> None:
        # At 5 fps every step is longer than a slide or a pop is read over: read clean, a skate passed.
        report = maths.report(walk(seconds=6.0, legs='skating')[::6])
        self.assertEqual(report['slide']['movingFrames'], 0)
        self.assertEqual(report['slowShare'], 1.0)
        self.assertEqual((codes(report), report['verdict']), ([maths.SLOW_FRAMES], 'problems'))
        self.assertEqual(maths.report(walk())['slowShare'], 0.0, 'none at 30 fps')

    def test_just_over_half_the_steps_too_long_is_already_too_slow(self) -> None:
        frames = walk(seconds=14.0)[:401]
        for i, frame in enumerate(frames):  # 201 steps of 0.2 s, then 199 at 30 fps
            frame['t'] = 0.2 * min(i, 201) + max(0, i - 201) / FPS
        report = maths.report(frames)
        self.assertEqual(report['slowShare'], 0.5)
        self.assertIn(maths.SLOW_FRAMES, codes(report))

    def test_one_low_frame_a_foot_steps_down_into_leaves_the_slide_measured(self) -> None:
        frames = walk(legs='skating')
        for frame in frames[:3]:  # a step down with foot IK before the skate
            frame['feet'] = {side: (x, y, z - 15.0) for side, (x, y, z) in frame['feet'].items()}
        report = maths.report(frames)
        self.assertGreater(report['slide']['movingFrames'], 60)
        self.assertEqual(codes(report), [maths.SLIDING])


class Pops(unittest.TestCase):
    def test_a_hand_that_jumps_for_one_frame_and_back_is_one_pop(self) -> None:
        frames = walk()
        frames[40]['bones']['hand_r'] = (60.0, 20.0, 30.0)
        report = maths.report(frames)
        self.assertEqual(len(report['pops']), 1, report['pops'])
        self.assertEqual(report['pops'][0]['bones'], ['hand_r'])
        self.assertEqual(codes(report), [maths.POSE_POP])

    def test_a_flash_a_few_frames_long_is_one_pop_at_any_frame_rate(self) -> None:
        # On screen for 1/15 s: two frames at 30 fps, eight at 120.
        for fps in (30.0, 120.0):
            with self.subTest(fps=fps):
                frames = walk()
                for frame in frames:
                    frame['t'] = frame['t'] * FPS / fps
                out = range(40, 40 + round(fps / 15))
                for i in out:
                    frames[i]['bones']['hand_r'] = (60.0, 20.0, 30.0)
                report = maths.report(frames)
                self.assertEqual([p['bones'] for p in report['pops']], [['hand_r']], report['pops'])

    def test_a_fast_smooth_swing_is_no_pop(self) -> None:
        frames = walk()
        for i, frame in enumerate(frames):
            angle = min(1.0, max(0.0, (i - 30) / 14)) * math.pi  # at rest, a half circle in 0.47 s, at rest
            frame['bones']['hand_r'] = (60 * math.cos(angle), 20.0 + 60 * math.sin(angle), 0.0)
        self.assertEqual(maths.report(frames)['pops'], [])

    def test_a_sword_swing_whose_hands_cover_a_metre_in_one_frame_and_go_on_is_no_pop(self) -> None:
        # The duel's light attack moved its sword hand 58 to 105 cm in one frame at 22 to 49 fps.
        frames = walk()
        for i, frame in enumerate(frames):
            reach = 0.0 if i < 40 else 90.0 + min(i - 40, 5) * 4.0  # struck in one frame, then follows through
            for side, y in (('hand_r', 20.0), ('hand_l', -20.0)):
                frame['bones'][side] = (reach, y, 30.0 if i >= 40 else 0.0)
        report = maths.report(frames)
        self.assertEqual((report['pops'], codes(report)), ([], []))

    def test_the_whole_pose_snapping_to_another_in_one_frame_is_one_pop(self) -> None:
        frames = walk()
        for frame in frames[40:]:
            for bone in ('pelvis', 'head', 'hand_r'):
                x, y, z = frame['bones'][bone]
                frame['bones'][bone] = (x, y, z - 30.0)  # a crouch with no blend
        report = maths.report(frames)
        self.assertEqual([p['bones'] for p in report['pops']], [['hand_r', 'head', 'pelvis']])
        self.assertEqual(codes(report), [maths.POSE_POP])

    def test_frames_too_far_apart_to_tell_a_jump_from_a_move_read_no_pops_and_say_so(self) -> None:
        frames = walk()[::4]  # 7.5 fps
        frames[10]['bones']['hand_r'] = (60.0, 20.0, 30.0)
        report = maths.report(frames)
        self.assertEqual((report['pops'], codes(report)), ([], [maths.SLOW_FRAMES]))

    def test_a_hand_that_snaps_out_and_back_a_third_of_a_second_later_reads_as_a_move(self) -> None:
        # Back after more than POP_FLASH_S is a jab, not a flash; one bone that snaps and stays is a known gap.
        frames = walk()
        for frame in frames[40:50]:
            frame['bones']['hand_r'] = (60.0, 20.0, 30.0)
        self.assertEqual(maths.report(frames)['pops'], [])


class Turns(unittest.TestCase):
    def test_a_quarter_turn_in_one_frame_is_a_snap(self) -> None:
        frames = walk()
        for frame in frames[50:]:
            frame['yaw'] = 90.0
        report = maths.report(frames)
        self.assertEqual([snap['deg'] for snap in report['snapTurns']], [90.0])
        self.assertEqual(codes(report), [maths.SNAP_TURN])

    def test_a_half_turn_over_half_a_second_is_no_snap(self) -> None:
        frames = walk()
        for i, frame in enumerate(frames):
            frame['yaw'] = min(180.0, max(0.0, (i - 30) * 12.0))
        self.assertEqual(maths.report(frames)['snapTurns'], [])

    def test_a_body_on_its_side_shows_no_facing_and_so_no_turn(self) -> None:
        frames = walk()
        for frame in frames[40:50]:
            frame['yaw'] = None  # the shoulders stand upright: a knockdown, a side roll
        frames[50]['yaw'] = 120.0
        for frame in frames[51:]:
            frame['yaw'] = 120.0
        self.assertEqual(maths.report(frames)['snapTurns'], [])

    def test_a_turn_across_the_back_counts_its_short_way_round(self) -> None:
        frames = walk()
        for i, frame in enumerate(frames):
            frame['yaw'] = (170.0 + i * 2.0 + 180.0) % 360.0 - 180.0  # past 180 it reads -178
        self.assertEqual(maths.report(frames)['snapTurns'], [])


def montage(name: str, start: int, stop: int, length: float, mesh: str = 'Mesh', blend_out: float = 0.0,
            rate: float = 1.0):
    """Plays a montage from frame `start` to frame `stop` (its position from 0 at `rate` times the game's pace)."""
    def play(frame: dict) -> None:
        i = round(frame['t'] * FPS)
        if start <= i < stop:
            frame['montages'][mesh] = (name, (i - start) / FPS * rate, length, blend_out, rate)
        else:
            frame['montages'].setdefault(mesh, None)
    return play


class Montages(unittest.TestCase):
    def test_a_swing_another_montage_cuts_off_early_is_cut(self) -> None:
        frames = walk(slash=montage('AM_Slash', 10, 22, 1.5), hit=lambda f: None)
        for frame in frames[22:40]:
            frame['montages']['Mesh'] = ('AM_Hit', (round(frame['t'] * FPS) - 22) / FPS, 0.6)
        report = maths.report(frames)
        slash = report['montages'][0]
        self.assertEqual((slash['montage'], slash['end'], slash['then']), ('AM_Slash', 'cut', 'AM_Hit'))
        self.assertEqual(codes(report), [maths.CUT_MONTAGE])

    def test_a_montage_that_plays_to_its_blend_out_is_finished(self) -> None:
        report = maths.report(walk(slash=montage('AM_Slash', 10, 49, 1.5)))
        self.assertEqual([(m['montage'], m['end']) for m in report['montages']], [('AM_Slash', 'finished')])
        self.assertEqual(codes(report), [])

    def test_a_montage_that_starts_over_before_its_end_is_told(self) -> None:
        frames = walk(first=montage('AM_Slash', 10, 25, 1.5), again=lambda f: None)
        for frame in frames[25:40]:
            frame['montages']['Mesh'] = ('AM_Slash', (round(frame['t'] * FPS) - 25) / FPS, 1.5)
        report = maths.report(frames)
        self.assertEqual(report['montages'][0]['end'], 'restarted')
        self.assertIn(maths.RESTARTED_MONTAGE, codes(report))

    def test_a_fast_montage_that_starts_over_between_two_frames_is_told(self) -> None:
        frames = walk(first=lambda f: None)
        for i, frame in enumerate(frames[10:18]):  # 4.5 times the game's pace
            frame['montages']['Mesh'] = ('AM_Dash', i / FPS * 4.5, 3.0, 0.0, 4.5)
        for i, frame in enumerate(frames[18:30]):  # begun again, first read 0.15 s in
            frame['montages']['Mesh'] = ('AM_Dash', (i + 1) / FPS * 4.5, 3.0, 0.0, 4.5)
        report = maths.report(frames)
        self.assertEqual(report['montages'][0]['end'], 'restarted', report['montages'])

    def test_a_loop_back_to_an_early_section_at_the_games_pace_plays_on(self) -> None:
        frames = walk(hold=lambda f: None)
        for i, frame in enumerate(frames[10:80]):  # a 2 s guard looping its 0.15 to 0.5 s section
            position = i / FPS if i < 15 else 0.15 + ((i - 15) / FPS) % 0.35
            frame['montages']['Mesh'] = ('AM_Guard', position, 2.0, 0.0, 1.0)
        played = maths.report(frames)['montages']
        self.assertEqual([m['montage'] for m in played], ['AM_Guard'], played)

    def test_a_looping_run_played_over_and_over_and_let_go_mid_way_is_no_cut(self) -> None:
        # The duel's run montage (0.8 s) plays again at each end and stops where the player lets go of W.
        frames = walk(seconds=4.0, run=lambda f: None)
        for i, frame in enumerate(frames[:80]):
            frame['montages']['Mesh'] = ('AM_RMRun_F', (i % 24) / FPS, 0.8, 0.2, 1.0)
        report = maths.report(frames)
        self.assertEqual([m['end'] for m in report['montages']], ['finished'] * 3 + ['loop-stopped'], report['montages'])
        self.assertEqual(codes(report), [])

    def test_a_looping_run_replayed_after_each_blend_out_and_let_go_is_no_cut(self) -> None:
        # Played again from its On Completed: no montage is active for the blend-out between cycles.
        frames = walk(seconds=4.0, run=lambda f: None)
        for i, frame in enumerate(frames[:92]):  # three cycles, then let go 0.23 s into the fourth
            cycle = i % 28
            frame['montages']['Mesh'] = ('AM_Run', cycle / FPS, 0.8, 0.2, 1.0) if cycle < 22 else None
        report = maths.report(frames)
        self.assertEqual([m['end'] for m in report['montages']], ['finished'] * 3 + ['loop-stopped'], report['montages'])
        self.assertEqual(codes(report), [])

    def test_a_run_played_again_after_a_long_pause_and_let_go_mid_way_is_a_cut(self) -> None:
        # More than LOOP_GAP_S between plays is no loop: each one is an attack of its own.
        frames = walk(seconds=4.0, run=lambda f: None)
        for i, frame in enumerate(frames[:109]):  # three plays 0.4 s apart, then one cut 0.23 s in
            cycle = i % 34
            frame['montages']['Mesh'] = ('AM_Run', cycle / FPS, 0.8, 0.2, 1.0) if cycle < 22 else None
        report = maths.report(frames)
        self.assertEqual([m['end'] for m in report['montages']], ['finished'] * 3 + ['cut'], report['montages'])

    def test_an_attack_pressed_again_whose_second_swing_is_cut_is_a_cut(self) -> None:
        frames = walk(slash=montage('AM_Slash', 10, 42, 1.2))
        for i, frame in enumerate(frames[42:50]):  # pressed again, then hit 0.27 s in
            frame['montages']['Mesh'] = ('AM_Slash', i / FPS, 1.2, 0.25, 1.0)
        for i, frame in enumerate(frames[50:70]):
            frame['montages']['Mesh'] = ('AM_HitReact', i / FPS, 0.6, 0.2, 1.0)
        report = maths.report(frames)
        self.assertEqual([m['end'] for m in report['montages']][:2], ['finished', 'cut'], report['montages'])
        self.assertIn(maths.CUT_MONTAGE, codes(report))

    def test_a_slow_montage_and_one_with_a_long_frame_are_not_stuck(self) -> None:
        for rate, stop in ((0.2, 35), (0.1, 32)):  # a bow at a fifth of its pace for 1 s, a tenth for 0.9 s
            with self.subTest(rate=rate):
                slow = walk(slow=montage('AM_Bow', 5, stop, 2.0, rate=rate))
                self.assertNotEqual(maths.report(slow)['montages'][0]['end'], 'stuck')
        frames = walk(late=lambda f: None)
        for frame in frames[30:]:
            frame['t'] += 0.4  # one long frame after frame 29: a shot's stall
        for i, frame in enumerate(frames[10:30] + frames[30:33]):
            frame['montages']['Mesh'] = ('AM_Guard', (frame['t'] - frames[10]['t']) * 0.5, 2.0, 0.0, 0.5)
        self.assertEqual(maths.report(frames)['montages'][0]['end'], 'cut')

    def test_a_montage_played_again_every_frame_is_stuck_at_its_start(self) -> None:
        # With the duel's Anim variable left on an old instance, its run montage sat at 0.00 s for 2.7 s.
        frames = walk(stuck=lambda f: None)
        for frame in frames[5:85]:
            frame['montages']['Mesh'] = ('AM_RMRun_F', 0.0, 0.8, 0.2, 1.0)
        for frame in frames[85:]:
            frame['montages']['Mesh'] = ('AM_Stance', (round(frame['t'] * FPS) - 85) / FPS, 4.0, 0.25, 1.0)
        report = maths.report(frames)
        run = report['montages'][0]
        self.assertEqual((run['end'], run['heldS']), ('stuck', round(79 / FPS, 2)))
        self.assertEqual(codes(report), [maths.STUCK_MONTAGE])

    def test_a_montage_paused_at_its_start_is_stuck(self) -> None:
        frames = walk(paused=montage('AM_Draw', 5, 40, 1.0, rate=0.0))
        run = maths.report(frames)['montages'][0]
        self.assertEqual((run['end'], run['heldS']), ('stuck', round(34 / FPS, 2)))

    def test_a_montage_held_at_its_end_is_not_stuck(self) -> None:
        frames = walk(rest=lambda f: None)
        for i, frame in enumerate(frames[5:80]):  # a fall played to its last pose and held there
            frame['montages']['Mesh'] = ('AM_Fall', min(i / FPS, 1.2), 1.2, 0.0, 1.0)
        self.assertEqual([m['end'] for m in maths.report(frames)['montages']], ['finished'])

    def test_a_montage_that_stops_being_active_at_its_long_blend_out_is_finished(self) -> None:
        report = maths.report(walk(slash=montage('AM_Slash', 10, 55, 2.0, blend_out=0.5)))
        self.assertEqual([(m['montage'], m['end']) for m in report['montages']], [('AM_Slash', 'finished')])
        self.assertEqual(codes(report), [])

    def test_a_held_section_that_loops_plays_on_and_a_swing_played_again_at_its_end_finished(self) -> None:
        frames = walk(seconds=5.0, hold=lambda f: None)
        for i, frame in enumerate(frames[10:70]):  # a 2 s channel looping its 0.5 to 0.8 s section
            frame['montages']['Mesh'] = ('AM_Channel', i / FPS if i < 15 else 0.5 + ((i - 15) / FPS) % 0.3, 2.0)
        for i, frame in enumerate(frames[70:]):  # the same slash again as the first blends out
            frame['montages']['Mesh'] = ('AM_Slash', (i % 40) / FPS, 1.5)
        report = maths.report(frames)
        self.assertEqual([m['end'] for m in report['montages']][:2], ['cut', 'finished'], report['montages'])
        self.assertNotIn(maths.RESTARTED_MONTAGE, codes(report))


class Flags(unittest.TestCase):
    def test_hidden_frames_are_a_problem_and_a_ragdoll_is_only_counted(self) -> None:
        frames = walk()
        for frame in frames[20:22]:
            frame['hidden'] = True
        for frame in frames[70:]:
            frame['ragdoll'] = True
        report = maths.report(frames)
        self.assertEqual(report['hidden'], {'frames': 2, 'firstAt': round(20 / FPS, 3)})
        self.assertEqual(report['ragdoll']['frames'], len(frames) - 70)
        self.assertEqual(codes(report), [maths.HIDDEN])

    def test_too_few_frames_is_no_verdict(self) -> None:
        report = maths.report(walk(seconds=0.2))
        self.assertIn('error', report)


class Montage:
    """A montage's blend-out settings and rate scale, and an animation instance playing it at `rate`."""

    def __init__(self, trigger: float, blend: float, rate: float = 1.0, scale: float = 1.0) -> None:
        self.trigger, self.blend, self.rate, self.scale = trigger, blend, rate, scale

    def get_editor_property(self, name: str):
        if name == 'blend_out_trigger_time':
            return self.trigger
        if name == 'rate_scale':
            return self.scale
        return mock.Mock(get_editor_property=lambda key: {'blend_time': self.blend}[key])

    def montage_get_play_rate(self, montage) -> float:
        return self.rate


class Shoulders:
    """A mesh whose shoulders stand where they are given."""

    def __init__(self, left: tuple, right: tuple) -> None:
        self.at = {'l': Vector(*left), 'r': Vector(*right)}

    def get_socket_location(self, name: str) -> Vector:
        return self.at[name]

    def get_world_rotation(self) -> Rotator:
        return Rotator(yaw=33.0)


class EngineReads(unittest.TestCase):
    def test_the_blend_out_is_its_trigger_time_when_set_else_its_blend_at_the_rate_it_plays(self) -> None:
        # Read on Unreal 5.8: the duel's montages answer a blend_out of 0.2 s and a trigger time of -1.
        for label, montage, rate, lead in (('trigger at the end', Montage(0.0, 0.5), 1.0, 0.0),
                                           ('its own blend, twice as fast', Montage(-1.0, 0.4), 2.0, 0.8),
                                           ('a trigger time', Montage(0.3, 0.5), 1.0, 0.3),
                                           ('neither', object(), 1.0, 0.0)):
            with self.subTest(label):
                self.assertAlmostEqual(motion_check._blend_out(montage, rate), lead)

    def test_a_montage_plays_at_its_instances_rate_times_its_own_rate_scale(self) -> None:
        montage = Montage(-1.0, 0.2, rate=2.0, scale=1.5)
        self.assertAlmostEqual(motion_check._rate(montage, montage), 3.0)
        self.assertAlmostEqual(motion_check._rate(object(), object()), 1.0, msg='unread: the game\'s pace')

    def test_the_facing_is_square_to_the_shoulders_and_none_for_a_body_on_its_side(self) -> None:
        sides = {'l': 'l', 'r': 'r'}
        self.assertAlmostEqual(motion_check._facing(Shoulders((0, -20, 140), (0, 20, 140)), sides), 0.0)
        self.assertAlmostEqual(motion_check._facing(Shoulders((20, 0, 140), (-20, 0, 140)), sides), 90.0)
        self.assertIsNone(motion_check._facing(Shoulders((0, 0.3, 30), (0, -0.2, 70)), sides))
        self.assertEqual(motion_check._facing(Shoulders((0, 0, 0), (0, 0, 0)), {}), 33.0)


class MotionCharacter:
    """A Motion Matching character as motion_character builds it: its own mesh a hidden driver that poses
    every frame, and a visible Body under it that copies the pose; the test moves them each frame."""

    def __init__(self, label: str = 'BP_DuelManny_C_1', at: Vector | None = None) -> None:
        self.driver = unreal.SkeletalMeshComponent('Mesh', bones={}, visible=False,
                                                   anim_instance=unreal.AnimInstance())
        self.body = unreal.SkeletalMeshComponent('Body', bones={}, anim_instance=unreal.AnimInstance())
        self.actor = unreal.Character(label, at or Vector(0, 0, ROOT_Z), mesh=self.driver)
        self.actor.components.append(self.body)
        self.legs = 'stepping'
        self.t = 0.0
        self.pose()

    def pose(self) -> None:
        at = self.actor.location
        driver_feet = {side: foot_x(self.t, o, SPEED) for side, o in (('l', 0.0), ('r', 0.5))}
        if self.legs == 'stepping':
            feet = driver_feet
        else:
            feet = {'l': (at.x + 10, 2.0), 'r': (at.x - 10, 2.0)}
        for mesh, posed in ((self.driver, driver_feet), (self.body, feet)):
            mesh.bones.update({f'foot_{s}': Vector(x, -12 if s == 'l' else 12, z) for s, (x, z) in posed.items()})
            mesh.bones.update({'pelvis': Vector(at.x, 0, at.z), 'head': Vector(at.x, 0, at.z + 70),
                               'hand_r': Vector(at.x + 20, 20, at.z), 'hand_l': Vector(at.x + 20, -20, at.z),
                               'upperarm_l': Vector(at.x, -20, at.z + 50), 'upperarm_r': Vector(at.x, 20, at.z + 50)})

    def step(self, dt: float) -> None:
        self.t += dt
        self.actor.location = Vector(SPEED * self.t, 0, ROOT_Z)
        self.pose()


class Tool(PlayCase):
    def setUp(self) -> None:
        super().setUp()
        self.fighter = MotionCharacter()
        unreal.state['actors'].append(self.fighter.actor)

    def run_frames(self, seconds: float) -> None:
        dt = 1 / FPS
        for _ in range(int(seconds * FPS) + 2):
            self.fighter.step(dt)
            self.tick(game=dt, wall=dt)

    def record(self, answer: dict) -> dict:
        with open(answer['record'], encoding='utf-8') as handle:
            return json.load(handle)

    def test_it_measures_the_visible_body_of_a_motion_character_never_its_hidden_driver(self) -> None:
        self.fighter.legs = 'skating'  # the driver steps; the Body the player sees slides
        answer = tool('motion_check', 'DuelManny', 2.0)
        self.assertEqual((answer['target'], answer['mesh'], answer['otherMeshes']), ('BP_DuelManny_C_1', 'Body', ['Mesh']))
        self.assertFalse(os.path.exists(answer['record']), 'the report is written once the time is up')
        self.run_frames(2.0)
        record = self.record(answer)
        self.assertEqual(codes(record), [maths.SLIDING])
        self.assertEqual(record['mesh'], 'Body')
        self.assertEqual(unreal.state['ticks'], {}, 'the check stops watching once it reported')

    def test_a_driver_left_shown_under_the_body_is_still_not_the_one_measured(self) -> None:
        # The duel's driver stayed shown in play (it showed through the Body) and was measured instead.
        self.fighter.driver.visible = True
        self.fighter.legs = 'skating'
        answer = tool('motion_check', 'DuelManny', 1.0)
        self.assertEqual((answer['mesh'], answer['otherMeshes']), ('Body', ['Mesh']))
        self.run_frames(1.0)
        self.assertEqual(codes(self.record(answer)), [maths.SLIDING])

    def test_a_body_that_steps_reports_clean_and_names_the_driver_montage(self) -> None:
        slash = unreal.AnimMontage('/Game/Sword/AM_Slash', seconds=1.2)
        self.fighter.driver.props['anim_instance'] = unreal.AnimInstance(slash, 0.4)
        answer = tool('motion_check', 'BP_DuelManny_C_1', 1.0)
        self.run_frames(1.0)
        record = self.record(answer)
        self.assertEqual(record['verdict'], 'clean', record['problems'])
        self.assertEqual(record['montages'][0]['montage'], 'AM_Slash')
        self.assertEqual(record['montages'][0]['mesh'], 'Mesh')

    def test_a_play_that_ends_early_still_writes_what_was_measured(self) -> None:
        answer = tool('motion_check', 'DuelManny', 5.0)
        self.run_frames(1.0)
        unreal.state['pie'] = False
        self.tick(game=0.0, wall=0.0)
        record = self.record(answer)
        self.assertEqual(record['stopped'], motion_check.MESSAGE['ended'])
        self.assertGreaterEqual(record['frames'], maths.MIN_FRAMES)

    def test_a_capsule_that_turns_ahead_of_the_body_is_no_snap_turn_and_no_pop(self) -> None:
        answer = tool('motion_check', 'DuelManny', 2.0)
        self.run_frames(1.0)
        self.fighter.body.rotation = Rotator(yaw=90.0)  # the capsule turned at once; the pose turns later
        self.run_frames(1.0)
        record = self.record(answer)
        self.assertEqual((record['snapTurns'], record['pops']), ([], []))
        self.assertEqual(record['verdict'], 'clean', record['problems'])

    def test_a_strip_that_ends_mid_check_leaves_the_throttle_lifted_until_the_check_is_done(self) -> None:
        tool('motion_check', 'DuelManny', 1.0)
        strip = tool('motion_strip', 2, 0.1)
        for index in range(2):
            self.run_frames(0.1)
            with open(strip['files'][index], 'wb') as handle:
                handle.write(b'\x89PNG frame')
        self.run_frames(0.1)
        self.assertTrue(os.path.exists(strip['poses']), 'the strip is done')
        self.assertFalse(self.throttled(), 'the check still holds the throttle off')
        self.run_frames(1.0)
        self.assertTrue(self.throttled(), 'given back once the check is done too')

    def test_on_a_mac_that_ray_traces_the_throttle_stays_on(self) -> None:
        for ray_tracing, throttled in ((1, True), (0, False)):
            with self.subTest(ray_tracing=ray_tracing), mock.patch.object(sys, 'platform', 'darwin'):
                unreal.state.setdefault('cvars', {})['r.RayTracing'] = ray_tracing
                answer = tool('motion_check', 'DuelManny', 0.5)
                self.assertEqual(self.throttled(), throttled)
                self.run_frames(0.6)
                self.assertTrue(os.path.exists(answer['record']))
                self.assertTrue(self.throttled(), 'on again once the check is done')

    def test_frames_of_a_game_held_all_but_still_are_not_read(self) -> None:
        # A motion strip holds the game all but still while each of its frames is written.
        answer = tool('motion_check', 'DuelManny', 1.0)
        self.run_frames(0.5)
        for _ in range(200):
            self.tick(game=0.00004, wall=0.005)
        self.run_frames(0.6)
        self.assertLess(self.record(answer)['frames'], 60)

    def test_a_check_the_wall_clock_cuts_short_says_so(self) -> None:
        answer = tool('motion_check', 'DuelManny', 2.0)
        self.run_frames(0.5)
        self.fighter.step(0.01)
        self.tick(game=0.01, wall=play.wall_cap(2.0))
        record = self.record(answer)
        self.assertEqual(record['stopped'], motion_check.MESSAGE['wall'])

    def test_the_bridge_waits_for_the_check_past_its_cap_by_the_time_strips_may_hold_the_game(self) -> None:
        # A strip's hold pauses the check's own cap; a bridge that waited only the cap gave up on its report.
        answer = tool('motion_check', 'DuelManny', 2.0)
        self.assertGreaterEqual(answer['waitS'], play.wall_cap(2.0) + motion_check.STRIP_HOLD_S)
        play.release_all()
        self.tick()

    def test_refused_without_play_out_of_range_for_an_unknown_name_and_a_body_it_cannot_see(self) -> None:
        hidden = unreal.Character('BP_Ghost_0', Vector(500, 0, 90),
                                  mesh=unreal.SkeletalMeshComponent('Mesh', bones={'foot_l': Vector(), 'foot_r': Vector()},
                                                                    visible=False))
        unpassed = unreal.Character('BP_Shade_0', Vector(600, 0, 90),
                                    mesh=unreal.SkeletalMeshComponent('Mesh', bones={'foot_l': Vector(), 'foot_r': Vector()},
                                                                      render_in_main_pass=False))
        unreal.state['actors'].extend([hidden, unpassed])
        for label, args, pie, says in (('no play', ('DuelManny', 2.0), False, 'play session'),
                                       ('too long', ('DuelManny', 60.0), True, 'seconds'),
                                       ('too short', ('DuelManny', 0.1), True, 'seconds'),
                                       ('not a number', ('DuelManny', 'long'), True, 'seconds'),
                                       ('no such actor', ('Kagemaru', 2.0), True, 'Closest names'),
                                       ('nothing shown', ('Ghost', 2.0), True, 'no shown skeletal mesh'),
                                       ('drawn in no main pass', ('Shade', 2.0), True, 'no shown skeletal mesh')):
            with self.subTest(label):
                unreal.state['pie'] = pie
                answer = tool('motion_check', *args)
                self.assertIn(says, answer.get('error', ''))
                self.assertEqual(unreal.state['ticks'], {}, 'nothing is watched')


class Strip(PlayCase):
    def test_a_burst_of_24_frames_is_taken_and_finer_more_or_over_a_minute_is_refused(self) -> None:
        for frames, interval in ((25, 0.1), (12, 0.02), (24, 5.0)):
            with self.subTest(frames=frames, interval=interval):
                self.assertIn('error', tool('motion_strip', frames, interval))
        self.assertEqual(len(tool('motion_strip', 24, 0.03)['files']), 24)
        unreal.state['pie'] = False
        self.tick(game=0.0, wall=0.0)  # the play ends, and the strip with it


if __name__ == '__main__':
    unittest.main()
