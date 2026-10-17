"""character_check (genex_build.tools.GenexBuildTools) measures a rigged character standing and walking
and answers a verdict with its reasons, then (with pictures) shoots a temporary copy of it as one
sheet; retarget sets each IK Rig up with full-body IK, keeps an IK goal solve in the op stack and
turns the target's arms in the retarget pose to the source's. Refused input changes nothing."""

import json
import unittest
from unittest import mock

import unreal
from unreal import Vector

import skeletons
from genex_build import character, character_math, pose_math, shots
from genex_build.tools import GenexBuildTools

from support import HelperCase

SETTINGS = '/Script/UnrealEd.EditorPerformanceSettings'
HERO = '/Game/Cast/Hero/SK_Hero'
MANNY = '/Game/Characters/SKM_Manny'


def tool(name: str, *args) -> dict:
    return json.loads(getattr(GenexBuildTools, name)(*args))


class Clock:
    def __init__(self) -> None:
        self.now = 100.0

    def monotonic(self) -> float:
        return self.now

    def time(self) -> float:
        return 1_800_000_000.0 + self.now

    def perf_counter(self) -> float:
        return self.now


class CharacterCase(HelperCase):
    def setUp(self) -> None:
        super().setUp()
        settings = unreal.Object()
        settings.set_editor_property('bThrottleCPUWhenNotForeground', True)
        settings.get_editor_property = lambda name: settings.props[name]
        unreal.state['classes'][SETTINGS] = unreal.Class(path=SETTINGS, cdo=settings)
        self.start = unreal.PlayerStart('PlayerStart', Vector(400, -200, 90))
        unreal.state['actors'] = [self.start]
        self.clock = Clock()
        for module in (shots, character):
            patcher = mock.patch.object(module, 'time', self.clock)
            patcher.start()
            self.addCleanup(patcher.stop)

    def hero(self, idle: dict, walk=None, strip: bool = False, fingers: bool = False) -> None:
        mesh = skeletons.character(HERO, strip=strip, fingers=fingers)
        skeletons.clip(f'{HERO}_Idle', mesh, lambda t: idle)
        if walk is not None:
            skeletons.clip(f'{HERO}_Walk', mesh, walk)

    def check(self, idle: str = f'{HERO}_Idle', walk: str = '', driver: str = '', pictures: bool = False) -> dict:
        return tool('character_check', HERO, idle, walk, driver, pictures)


class Verdict(CharacterCase):
    def test_a_character_standing_with_its_arms_by_its_sides_passes(self) -> None:
        self.hero(skeletons.pose(), walk=lambda t: skeletons.pose(arm_out=12.0, elbow=20.0))
        result = self.check(walk=f'{HERO}_Walk')
        self.assertTrue(result['passed'], result['reasons'])
        self.assertEqual(result['heightCm'], 180)
        self.assertEqual(result['bones']['Left']['forearm'], 'LeftForeArm')
        self.assertAlmostEqual(result['clips']['idle']['armOutDeg']['Left'], 8.0, delta=0.3)
        self.assertEqual(result['stretch']['stretch'], 1.0)
        self.assertEqual(unreal.calls, [], 'measuring changed the editor')

    def test_a_character_left_in_its_bind_a_pose_fails_and_says_why(self) -> None:
        self.hero(skeletons.pose(arm_out=55.0, elbow=100.0))
        result = self.check()
        self.assertFalse(result['passed'])
        joined = ' '.join(result['reasons'])
        for words in ('left upper arm stands', 'hand is', 'times as wide'):
            self.assertIn(words, joined)
        self.assertIn('no left finger bones', ' '.join(result['warnings']))

    def test_no_idle_clip_checks_the_reference_pose_and_says_so(self) -> None:
        self.hero(skeletons.pose())
        result = self.check(idle='')
        self.assertFalse(result['passed'], 'the reference pose is the A-pose the mesh is bound in')
        self.assertIn('reference pose', result['notes'][0])

    def test_a_strip_weighted_to_the_hand_stretches_when_the_arms_come_down(self) -> None:
        self.hero(skeletons.pose(), strip=True)
        result = self.check()
        self.assertGreater(result['stretch']['stretch'], character_math.MAX_EDGE_STRETCH)
        self.assertIn('strip of cloth', ' '.join(result['reasons']))

    def test_feet_that_float_in_the_walk_fail(self) -> None:
        self.hero(skeletons.pose(), walk=lambda t: skeletons.pose(feet_up=12.0))
        result = self.check(walk=f'{HERO}_Walk')
        self.assertEqual(result['clips']['walk']['feetGroundErrorCm'], 12.0)
        self.assertIn('walk: the feet float or sink', ' '.join(result['reasons']))

    def test_moving_fingers_are_seen(self) -> None:
        self.hero(skeletons.pose(fingers=True), walk=lambda t: skeletons.pose(fingers=True, curl=4.0 * t), fingers=True)
        result = self.check(walk=f'{HERO}_Walk')
        self.assertEqual(result['fingers']['Left']['bones'], 1)
        self.assertGreater(result['fingers']['Left']['movedCm'], character_math.MIN_FINGER_MOVE_CM)
        self.assertEqual(result['warnings'], [])

    def test_each_limb_is_held_against_the_driver_at_the_same_frame(self) -> None:
        self.hero(skeletons.pose(arm_out=40.0, elbow=10.0))
        driver = skeletons.character(MANNY, bind=skeletons.pose(arm_out=45.0, elbow=5.0, yaw=90.0))
        skeletons.clip(f'{MANNY}_Idle', driver, lambda t: skeletons.pose(arm_out=8.0, yaw=90.0))
        result = self.check(driver=json.dumps({'mesh': MANNY, 'idle': f'{MANNY}_Idle'}))
        self.assertEqual(result['driver'], MANNY)
        self.assertAlmostEqual(result['limbErrorDeg']['Left upperArm'], 32.0, delta=0.5)
        self.assertIn('left upperarm points', ' '.join(result['reasons']))


class Refuses(CharacterCase):
    def test_input_it_does_not_take_is_refused_without_changing_anything(self) -> None:
        self.hero(skeletons.pose())
        other = unreal.Skeleton('/Game/Other/SK_Other_Skeleton')
        unreal.state['loaded']['/Game/Other/Run'] = unreal.AnimSequence('/Game/Other/Run', 1.0, other)
        unreal.state['loaded']['/Game/Props/SM_Rock'] = unreal.StaticMesh(Vector(), Vector(1, 1, 1))
        cases = {
            'a static mesh': ('/Game/Props/SM_Rock', f'{HERO}_Idle', '', '', False),
            'no such actor': ('Nobody', f'{HERO}_Idle', '', '', False),
            'a clip of another skeleton': (HERO, '/Game/Other/Run', '', '', False),
            'a clip that is a mesh': (HERO, HERO, '', '', False),
            'a driver that is not JSON': (HERO, f'{HERO}_Idle', '', '{mesh', False),
            'a driver without a mesh': (HERO, f'{HERO}_Idle', '', '{"idle": "/Game/A"}', False),
            'pictures not a bool': (HERO, f'{HERO}_Idle', '', '', 'yes'),
        }
        for label, args in cases.items():
            with self.subTest(label):
                self.fresh()
                result = tool('character_check', *args)
                self.assertIn('error', result)
                self.assertEqual(unreal.calls, [])
                self.assertEqual(unreal.state['actors'], [self.start])

    def test_a_skeleton_unreal_cannot_characterise_is_named(self) -> None:
        mesh = skeletons.character(HERO)
        mesh.chains = {'Spine': ('Spine', 'Spine')}
        skeletons.clip(f'{HERO}_Idle', mesh, lambda t: skeletons.pose())
        self.assertIn(HERO, self.check()['error'])

    def test_refused_during_play(self) -> None:
        self.hero(skeletons.pose())
        unreal.state['pie'] = True
        self.assertIn('StopPIE', self.check()['error'])


class Pictures(CharacterCase):
    def tick(self) -> None:
        for callback in list(unreal.state['ticks'].values()):
            callback(0.016)

    def land(self, file: str) -> None:
        with open(file, 'wb') as handle:
            handle.write(b'png')

    def test_a_copy_is_shot_front_side_and_back_then_through_the_walk_and_removed(self) -> None:
        self.hero(skeletons.pose(), walk=lambda t: skeletons.pose(arm_out=10.0))
        result = self.check(walk=f'{HERO}_Walk', pictures=True)
        sheet = result['pictures']
        self.assertEqual(len(sheet['files']), 3 + len(character.WALK_FRACTIONS))
        copies = [a for a in unreal.state['actors'] if a.get_actor_label().startswith(character.CHECK_LABEL)]
        self.assertEqual(len(copies), 2, 'the copy and its camera')
        for file in sheet['files']:
            self.tick()
            shot = unreal.state['screenshots'][-1]
            self.assertTrue(shot['game_view'])
            self.land(file)
        self.tick()
        self.assertEqual(unreal.state['actors'], [self.start], 'the copy and its camera are gone')
        with open(sheet['record'], encoding='utf-8') as handle:
            record = json.load(handle)
        self.assertEqual([f['label'] for f in record['frames']][:3], ['idle front', 'idle side', 'idle back'])
        self.assertEqual(record['files'], sheet['files'])
        settings = unreal.state['classes'][SETTINGS].cdo
        self.assertTrue(settings.props['bThrottleCPUWhenNotForeground'], 'the throttle is given back')

    def test_the_front_camera_looks_at_the_face(self) -> None:
        self.hero(skeletons.pose())
        self.check(pictures=True)
        self.tick()
        moves = [c for c in unreal.calls if c[0] == 'move']
        _, label, x, y, _, yaw = moves[0]
        self.assertGreater(x, self.start.location.x, 'the camera stands in front, where the toes point (+X)')
        self.assertAlmostEqual(y, self.start.location.y, delta=1)
        self.assertAlmostEqual(abs(yaw), 180.0, delta=0.5)

    def test_a_shot_that_never_lands_ends_the_sheet_with_why(self) -> None:
        self.hero(skeletons.pose())
        sheet = self.check(pictures=True)['pictures']
        self.tick()
        self.clock.now += character.SHOT_WAIT_S + 1
        self.tick()
        with open(sheet['record'], encoding='utf-8') as handle:
            self.assertIn('never landed', json.load(handle)['error'])
        self.assertEqual(unreal.state['actors'], [self.start])


class Retarget(HelperCase):
    def setUp(self) -> None:
        super().setUp()
        self.source = skeletons.character(MANNY, bind=skeletons.pose(arm_out=45.0, elbow=10.0))
        self.target = skeletons.character(HERO)
        skeletons.clip('/Game/Characters/Anims/Walk', self.source, lambda t: skeletons.pose(yaw=90.0))

    def run_retarget(self) -> dict:
        return tool('retarget', MANNY, HERO, '["/Game/Characters/Anims/Walk"]', '/Game/Cast/Hero/Anims')

    def retargeter(self) -> unreal.IKRetargeter:
        return unreal.state['loaded']['/Game/GX/Retarget/RTG_SKM_Manny_to_SK_Hero']

    def test_both_rigs_get_full_body_ik_and_the_stack_solves_ik_goals(self) -> None:
        result = self.run_retarget()
        self.assertEqual(result['fbik'], {'source': True, 'target': True})
        self.assertIn(('apply_auto_fbik', 'SK_Hero'), unreal.calls)
        self.assertIn('RunIKRig', self.retargeter().ops)
        self.assertIn(('assign_ik_rig_to_all_ops', 'TARGET'), unreal.calls)
        self.assertEqual(result['animations'], ['/Game/Cast/Hero/Anims/Walk_SK_Hero'])
        self.assertEqual(unreal.state['batch_inputs']['ik_retarget_asset'], self.retargeter())

    def test_a_stack_whose_defaults_bring_no_ik_solve_gets_one(self) -> None:
        unreal.state['default_ops'] = ('PelvisMotion', 'FKChains')
        self.run_retarget()
        self.assertIn(('add_retarget_op', '/Script/IKRig.IKRetargetRunIKRigOp'), unreal.calls)

    def test_the_targets_bent_a_posed_arms_are_turned_to_the_sources_in_the_retarget_pose(self) -> None:
        result = self.run_retarget()
        fixed = result['armFixDeg']
        self.assertGreater(fixed['LeftForeArm'][0], 30.0, 'auto-alignment left the forearm bent')
        for bone, (before, after) in fixed.items():
            self.assertLess(after, 0.5, bone)
        offsets = {bone: (q.x, q.y, q.z, q.w) for bone, q in self.retargeter().offsets['TARGET'].items()}
        self.assertEqual(sorted(offsets), ['LeftArm', 'LeftForeArm', 'RightArm', 'RightForeArm'])
        calls = [c[0] for c in unreal.calls]
        self.assertLess(calls.index('reset_retarget_pose'), calls.index('auto_align_all_bones'))
        self.assertLess(calls.index('auto_align_all_bones'), calls.index('rotation_offset'))
        found = character_math.roles(skeletons.chains(), skeletons.ROOT, skeletons.parents().get, lambda b: [])
        posed = pose_math.with_deltas(self.target.reference, skeletons.parents(), offsets)
        source = self.source.reference
        for side in character_math.SIDES:
            for bone, child in (('upperArm', 'forearm'), ('forearm', 'hand')):
                ours = pose_math.limb_direction(posed, found[side][bone], found[side][child])
                theirs = pose_math.limb_direction(source, found[side][bone], found[side][child])
                self.assertLess(pose_math.angle_deg(ours, theirs), 0.5, f'{side} {bone}')

    def test_the_spine_chain_runs_from_its_lowest_bone(self) -> None:
        result = self.run_retarget()
        self.assertEqual(result['spineFrom'], {'source': 'Spine02', 'target': 'Spine02'})
        rig = unreal.state['loaded']['/Game/GX/Retarget/IK_SK_Hero']
        self.assertEqual(rig.chains['Spine'], ('Spine02', 'Spine'))

    def test_chains_map_exactly_first_and_the_limbs_copy_bone_for_bone_with_ik_only_on_the_legs(self) -> None:
        result = self.run_retarget()
        maps = [c[1:] for c in unreal.calls if c[0] == 'auto_map_chains']
        self.assertEqual(maps, [('EXACT', True), ('FUZZY', False)])
        self.assertEqual(result['oneToOne'], ['LeftArm', 'LeftLeg', 'RightArm', 'RightLeg'])
        self.assertEqual(result['ikOff'], ['LeftArm', 'RightArm'])
        controllers = self.retargeter().op_controllers
        modes = {str(c.get_editor_property('target_chain_name')): c.get_editor_property('rotation_mode').name
                 for c in controllers['FKChains'].settings.get_editor_property('chains_to_retarget')}
        self.assertEqual((modes['LeftArm'], modes['Spine']), ('ONE_TO_ONE', 'INTERPOLATED'))
        ik = {str(c.get_editor_property('target_chain_name')): c.get_editor_property('enable_ik')
              for c in controllers['RunIKRig'].settings.get_editor_property('chains')}
        self.assertEqual((ik['LeftArm'], ik['LeftLeg']), (False, True))

    def test_finger_chains_are_aligned_again_after_the_arm_fix(self) -> None:
        self.target = skeletons.character(HERO, fingers=True)
        result = self.run_retarget()
        self.assertEqual(result['fingersAligned'], 2)
        aligned = [c for c in unreal.calls if c[0] == 'auto_align_bones']
        self.assertEqual(aligned, [('auto_align_bones', ('LeftHandIndex1', 'RightHandIndex1'), 'TARGET')])
        calls = [c[0] for c in unreal.calls]
        self.assertGreater(calls.index('auto_align_bones'), max(i for i, c in enumerate(calls) if c == 'rotation_offset'))

    def test_the_first_new_clip_is_held_against_its_source_as_unreal_made_it(self) -> None:
        unreal.state['retargeted'] = lambda t: skeletons.pose()
        result = self.run_retarget()
        self.assertLess(max(result['limbErrorDeg'].values()), 0.5, result['limbErrorDeg'])
        self.assertEqual(result['warnings'], [])

    def test_a_new_clip_whose_arms_stay_off_its_source_is_warned_about(self) -> None:
        unreal.state['retargeted'] = lambda t: skeletons.pose(arm_out=55.0, elbow=100.0)
        result = self.run_retarget()
        self.assertGreater(result['limbErrorDeg']['Left forearm'], character_math.MAX_CHAIN_ERROR_DEG)
        self.assertIn('/Game/Cast/Hero/Anims/Walk_SK_Hero', result['warnings'][0])
        self.assertIn('Left forearm', result['warnings'][0])

    def test_a_rig_unreal_has_no_full_body_ik_for_still_retargets(self) -> None:
        unreal.state['fbik_fails'] = True
        result = self.run_retarget()
        self.assertEqual(result['fbik'], {'source': False, 'target': False})
        self.assertEqual(len(result['animations']), 1)


if __name__ == '__main__':
    unittest.main()
