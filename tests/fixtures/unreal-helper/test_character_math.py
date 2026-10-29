"""The character check's numbers and verdict, and the retarget pose's arm fix, on synthetic skeletons:
arms hanging by the body pass, arms held out in an A-pose fail with the reasons, any facing gives the
same numbers, a strip of the mesh weighted to the wrong bone shows as a stretched edge, and the arm
fix turns a target's arms to point where the source's do whatever way each faces."""

import math
import unittest

from genex_build import character_math as cm
from genex_build import pose_math as pm

IDENTITY = pm.IDENTITY
SHOULDER_X, SHOULDER_Z = 18.0, 145.0
UPPER_ARM_CM, FOREARM_CM = 30.0, 25.0


def yawed(yaw: float):
    turn = pm.quat_axis_angle((0.0, 0.0, 1.0), yaw)
    return lambda v: pm.rotate(turn, v)


def humanoid(arm_out: float = 8.0, elbow: float = 10.0, yaw: float = 0.0, feet_up: float = 0.0,
             fingers: bool = True, finger_curl: float = 0.0) -> dict:
    """A 180 cm body, left side along +X, up +Z, facing -Y, turned by `yaw` about Z: arms `arm_out` degrees
    out from the body with the elbow bent `elbow` degrees forward, feet raised by `feet_up`."""
    turn = yawed(yaw)
    pose = {}

    def put(bone: str, location: tuple) -> None:
        pose[bone] = (turn(location), pm.quat_axis_angle((0.0, 0.0, 1.0), yaw))

    put('pelvis', (0.0, 0.0, 100.0))
    put('neck', (0.0, 0.0, 150.0))
    for side, sign in (('Left', 1.0), ('Right', -1.0)):
        out = math.radians(arm_out)
        shoulder = (sign * SHOULDER_X, 0.0, SHOULDER_Z)
        upper = (sign * math.sin(out), 0.0, -math.cos(out))
        elbow_at = pm.add(shoulder, pm.scaled(upper, UPPER_ARM_CM))
        bend = math.radians(elbow)
        forearm = pm.unit((upper[0] * math.cos(bend), -math.sin(bend), upper[2] * math.cos(bend)))
        hand = pm.add(elbow_at, pm.scaled(forearm, FOREARM_CM))
        put(f'{side}Shoulder', shoulder)
        put(f'{side}Elbow', elbow_at)
        put(f'{side}Hand', hand)
        if fingers:
            put(f'{side}Index', pm.add(hand, (0.0, -finger_curl, -8.0)))
        put(f'{side}Thigh', (sign * 10.0, 0.0, 95.0))
        put(f'{side}Knee', (sign * 10.0, 0.0, 52.0))
        put(f'{side}Foot', (sign * 10.0, 0.0, 8.0 + feet_up))
        put(f'{side}Toe', (sign * 10.0, -12.0, 2.0 + feet_up))
    return pose


def humanoid_roles(fingers: bool = True) -> dict:
    found = {'pelvis': 'pelvis', 'neck': 'neck'}
    for side in cm.SIDES:
        found[side] = {'upperArm': f'{side}Shoulder', 'forearm': f'{side}Elbow', 'hand': f'{side}Hand',
                       'thigh': f'{side}Thigh', 'knee': f'{side}Knee', 'foot': f'{side}Foot', 'toe': f'{side}Toe',
                       'fingers': [f'{side}Index'] if fingers else []}
    return found


class Roles(unittest.TestCase):
    def test_bones_are_found_from_the_auto_rigs_chains_on_any_naming(self) -> None:
        meshy = {'LeftArm': 'LeftShoulder', 'LeftForeArm': 'LeftArm', 'LeftHand': 'LeftForeArm',
                 'RightArm': 'RightShoulder', 'RightForeArm': 'RightArm', 'RightHand': 'RightForeArm',
                 'LeftUpLeg': 'Hips', 'LeftLeg': 'LeftUpLeg', 'LeftFoot': 'LeftLeg', 'LeftToeBase': 'LeftFoot',
                 'RightUpLeg': 'Hips', 'RightLeg': 'RightUpLeg', 'RightFoot': 'RightLeg', 'RightToeBase': 'RightFoot',
                 'LeftShoulder': 'Spine02', 'RightShoulder': 'Spine02', 'neck': 'Spine02', 'Head': 'neck',
                 'Spine02': 'Hips', 'Hips': None}
        chains = {'LeftArm': ('LeftArm', 'LeftHand'), 'RightArm': ('RightArm', 'RightHand'),
                  'LeftLeg': ('LeftUpLeg', 'LeftToeBase'), 'RightLeg': ('RightUpLeg', 'RightToeBase'),
                  'Neck': ('neck', 'neck'), 'Head': ('Head', 'Head')}
        children = lambda bone: [b for b, p in meshy.items() if p == bone]  # noqa: E731
        found = cm.roles(chains, 'Hips', meshy.get, children)
        self.assertEqual(found['Left'], {'upperArm': 'LeftArm', 'forearm': 'LeftForeArm', 'hand': 'LeftHand',
                                         'thigh': 'LeftUpLeg', 'knee': 'LeftLeg', 'foot': 'LeftFoot',
                                         'toe': 'LeftToeBase', 'fingers': []})
        self.assertEqual(found['neck'], 'neck')
        ue = {'upperarm_l': 'clavicle_l', 'lowerarm_l': 'upperarm_l', 'upperarm_twist_01_l': 'upperarm_l',
              'hand_l': 'lowerarm_l', 'index_01_l': 'hand_l', 'index_02_l': 'index_01_l', 'clavicle_l': 'spine_05'}
        arm = cm._limb_roles({'LeftArm': ('upperarm_l', 'hand_l'), 'LeftLeg': ('upperarm_l', 'hand_l')}, 'Left',
                             ue.get, lambda bone: [b for b, p in ue.items() if p == bone])
        self.assertEqual((arm['forearm'], arm['fingers']), ('lowerarm_l', ['index_01_l', 'index_02_l']))

    def test_a_skeleton_without_arm_or_leg_chains_has_no_roles(self) -> None:
        self.assertIsNone(cm.roles({'Spine': ('a', 'b')}, 'a', {}.get, lambda bone: []))


class Numbers(unittest.TestCase):
    def check(self, pose: dict, height: float = 180.0) -> dict:
        found = humanoid_roles()
        frame = cm.frame_numbers(pose, found)
        summary = cm.clip_summary([frame], cm.frame_numbers(humanoid(), found))
        return {'frame': frame, 'verdict': cm.verdict({'idle': summary}, height, None, None, None)}

    def test_arms_hanging_by_the_body_pass(self) -> None:
        checked = self.check(humanoid())
        self.assertTrue(checked['verdict']['passed'], checked)
        self.assertAlmostEqual(checked['frame']['armOutDeg']['Left'], 8.0, delta=0.2)
        self.assertLess(checked['frame']['handToThighCm']['Left'], 0.15 * 180)

    def test_an_a_pose_idle_fails_on_arms_hands_and_width(self) -> None:
        checked = self.check(humanoid(arm_out=45.0, elbow=60.0))
        self.assertFalse(checked['verdict']['passed'])
        joined = ' '.join(checked['verdict']['reasons'])
        for words in ('left upper arm stands', 'right upper arm stands', 'hand is', 'times as wide'):
            self.assertIn(words, joined)

    def test_any_facing_gives_the_same_numbers(self) -> None:
        found = humanoid_roles()
        for yaw in (0.0, 90.0, 137.0, -60.0):
            with self.subTest(yaw=yaw):
                turned = cm.frame_numbers(humanoid(arm_out=30.0, elbow=40.0, yaw=yaw), found)
                straight = cm.frame_numbers(humanoid(arm_out=30.0, elbow=40.0), found)
                for key in ('armOutDeg', 'armToTorsoDeg', 'handToThighCm'):
                    for side in cm.SIDES:
                        self.assertAlmostEqual(turned[key][side], straight[key][side], delta=0.2)
                self.assertAlmostEqual(turned['widthCm'], straight['widthCm'], delta=0.2)

    def test_an_arm_swinging_forward_is_not_out(self) -> None:
        pose = humanoid()
        rotation = pose['LeftElbow'][1]
        pose['LeftElbow'] = (pm.add(pose['LeftShoulder'][0], (0.0, -21.0, -21.0)), rotation)
        self.assertLess(cm.frame_numbers(pose, humanoid_roles())['armOutDeg']['Left'], 1.0)

    def test_feet_that_float_against_the_reference_fail(self) -> None:
        found = humanoid_roles()
        reference = cm.frame_numbers(humanoid(), found)
        walk = cm.clip_summary([cm.frame_numbers(humanoid(feet_up=9.0), found)], reference)
        self.assertEqual(walk['feetGroundErrorCm'], 9.0)
        result = cm.verdict({'walk': walk}, 180.0, None, None, None)
        self.assertIn('feet float or sink by 9 cm', ' '.join(result['reasons']))


class Stretch(unittest.TestCase):
    def test_a_strip_weighted_to_the_wrong_bone_stretches_when_the_body_moves(self) -> None:
        bind_bones = {'root': ((0.0, 0.0, 0.0), IDENTITY), 'hips': ((0.0, 0.0, 100.0), IDENTITY)}
        posed_bones = {'root': ((0.0, 0.0, 0.0), IDENTITY), 'hips': ((0.0, 60.0, 100.0), IDENTITY)}
        positions = [(0.0, 0.0, 90.0), (5.0, 0.0, 90.0), (0.0, 0.0, 85.0), (5.0, 0.0, 85.0)]
        triangles = [(0, 1, 2), (1, 3, 2)]
        healthy = [[('hips', 1.0)]] * 4
        strip = [[('hips', 1.0)], [('hips', 1.0)], [('root', 1.0)], [('root', 1.0)]]
        matrices = cm.bone_matrices(bind_bones, posed_bones)
        self.assertEqual(cm.edge_stretch(positions, cm.skin(positions, healthy, matrices), triangles)['stretch'], 1.0)
        stretched = cm.edge_stretch(positions, cm.skin(positions, strip, matrices), triangles)
        self.assertGreater(stretched['stretch'], cm.MAX_EDGE_STRETCH)
        result = cm.verdict({}, 180.0, stretched, None, None)
        self.assertFalse(result['passed'])
        self.assertIn('strip of cloth', result['reasons'][0])

    def test_a_tiny_edge_folding_at_a_joint_is_not_a_strip(self) -> None:
        bind_bones = {'root': ((0.0, 0.0, 0.0), IDENTITY), 'elbow': ((0.0, 0.0, 100.0), IDENTITY)}
        posed_bones = {'root': ((0.0, 0.0, 0.0), IDENTITY), 'elbow': ((0.0, 1.0, 100.0), IDENTITY)}
        # A 0.12 cm edge between the arm and the forearm at the elbow grows ninefold, to about 1 cm.
        positions = [(0.0, 0.0, 100.0), (0.12, 0.0, 100.0), (0.0, 0.0, 99.0)]
        weights = [[('root', 1.0)], [('elbow', 1.0)], [('root', 1.0)]]
        posed = cm.skin(positions, weights, cm.bone_matrices(bind_bones, posed_bones))
        self.assertEqual(cm.edge_stretch(positions, posed, [(0, 1, 2)])['stretch'], 1.0)

    def test_skinning_follows_a_turned_bone(self) -> None:
        turn = pm.quat_axis_angle((0.0, 0.0, 1.0), 90.0)
        matrices = cm.bone_matrices({'arm': ((10.0, 0.0, 0.0), IDENTITY)}, {'arm': ((10.0, 0.0, 0.0), turn)})
        [moved] = cm.skin([(20.0, 0.0, 0.0)], [[('arm', 1.0)]], matrices)
        for got, wanted in zip(moved, (10.0, 10.0, 0.0)):
            self.assertAlmostEqual(got, wanted, places=6)


class Driver(unittest.TestCase):
    def test_each_limb_is_measured_against_the_driver_at_the_same_frame(self) -> None:
        found = humanoid_roles()
        errors = cm.chain_errors(humanoid(arm_out=45.0, yaw=70.0), found, humanoid(arm_out=8.0), found)
        self.assertAlmostEqual(errors['Left upperArm'], 37.0, delta=0.5)
        self.assertLess(errors['Left thigh'], 0.5)
        result = cm.verdict({}, 180.0, None, errors, None)
        self.assertIn('left upperarm points', ' '.join(result['reasons']))


class Fingers(unittest.TestCase):
    def test_no_finger_bones_and_still_fingers_are_warned_about(self) -> None:
        motion = cm.finger_motion([humanoid(fingers=False)] * 2, humanoid_roles(fingers=False))
        self.assertEqual(motion['Left'], {'bones': 0, 'movedCm': 0.0})
        still = cm.finger_motion([humanoid(), humanoid()], humanoid_roles())
        curling = cm.finger_motion([humanoid(), humanoid(finger_curl=3.0)], humanoid_roles())
        self.assertEqual(still['Left']['movedCm'], 0.0)
        self.assertGreater(curling['Left']['movedCm'], cm.MIN_FINGER_MOVE_CM)
        warned = cm.verdict({}, 180.0, None, None, motion)
        self.assertTrue(warned['passed'], 'missing fingers warn, they do not fail')
        self.assertIn('no left finger bones', warned['warnings'][0])
        self.assertEqual(cm.verdict({}, 180.0, None, None, curling)['warnings'], [])


class ArmFix(unittest.TestCase):
    """The retarget pose's arm fix: target limbs turned to point, in the target's body frame, where the
    source's point in the source's, by local deltas applied after each bone's own rotation."""

    def chain_pose(self, arm_out: float, elbow: float, yaw: float) -> tuple:
        """(component pose, parents) of a skeleton with real rotations: each bone points along its local +X."""
        flat = humanoid(arm_out=arm_out, elbow=elbow, yaw=yaw)
        parents = {'neck': 'pelvis', 'LeftShoulder': 'neck', 'RightShoulder': 'neck', 'LeftElbow': 'LeftShoulder',
                   'RightElbow': 'RightShoulder', 'LeftHand': 'LeftElbow', 'RightHand': 'RightElbow', 'pelvis': None}
        children = {'LeftShoulder': 'LeftElbow', 'LeftElbow': 'LeftHand', 'RightShoulder': 'RightElbow',
                    'RightElbow': 'RightHand'}
        pose = {}
        for bone in parents:
            location = flat[bone][0]
            child = children.get(bone)
            rotation = pm.quat_between((1.0, 0.0, 0.0), pm.sub(flat[child][0], location)) if child else IDENTITY
            pose[bone] = (location, rotation)
        return pose, parents

    def test_an_a_posed_target_facing_elsewhere_gets_the_sources_arms(self) -> None:
        source, _ = self.chain_pose(arm_out=10.0, elbow=5.0, yaw=0.0)
        target, parents = self.chain_pose(arm_out=55.0, elbow=100.0, yaw=90.0)
        found = humanoid_roles()
        source_frame, target_frame = cm.frame_of(source, found), cm.frame_of(target, found)
        wanted = []
        for side in cm.SIDES:
            for bone, child in (('Shoulder', 'Elbow'), ('Elbow', 'Hand')):
                direction = pm.limb_direction(source, f'{side}{bone}', f'{side}{child}')
                wanted.append((f'{side}{bone}', f'{side}{child}', pm.in_frame(source_frame, direction)))
        deltas, report = pm.match_limbs(target, parents, {}, target_frame, wanted)
        self.assertGreater(report['LeftElbow'][0], 30.0, 'the bent elbow started far off')
        fixed = pm.with_deltas(target, parents, deltas)
        for bone, child, coords in wanted:
            with self.subTest(bone=bone):
                now = pm.in_frame(target_frame, pm.limb_direction(fixed, bone, child))
                self.assertLess(pm.angle_deg(now, coords), 0.5)
                self.assertLess(report[bone][1], 0.5)

    def test_deltas_already_there_are_kept_and_built_on(self) -> None:
        target, parents = self.chain_pose(arm_out=55.0, elbow=60.0, yaw=0.0)
        frame = cm.frame_of(target, humanoid_roles())
        nudge = {'LeftShoulder': pm.quat_axis_angle((0.0, 1.0, 0.0), 12.0)}
        straight_down = pm.in_frame(frame, (0.0, 0.0, -1.0))
        deltas, _ = pm.match_limbs(target, parents, nudge, frame, [('LeftShoulder', 'LeftElbow', straight_down)])
        fixed = pm.with_deltas(target, parents, deltas)
        self.assertLess(pm.angle_deg(pm.limb_direction(fixed, 'LeftShoulder', 'LeftElbow'), (0.0, 0.0, -1.0)), 0.5)


class Quaternions(unittest.TestCase):
    def test_turns_compose_like_unreals_fquat(self) -> None:
        yaw = pm.quat_axis_angle((0.0, 0.0, 1.0), 90.0)
        pitch = pm.quat_axis_angle((0.0, 1.0, 0.0), 90.0)
        # FQuat a * b applies b first: pitch takes +X to -Z, then yaw leaves -Z where it is.
        turned = pm.rotate(pm.quat_mul(yaw, pitch), (1.0, 0.0, 0.0))
        for got, wanted in zip(turned, (0.0, 0.0, -1.0)):
            self.assertAlmostEqual(got, wanted, places=9)
        for a, b in (((1, 0, 0), (0, 1, 0)), ((0, 0, 1), (0, 0, -1)), ((1, 2, 3), (-3, 1, 0.5))):
            with self.subTest(a=a, b=b):
                self.assertLess(pm.angle_deg(pm.rotate(pm.quat_between(a, b), a), b), 1e-6)

    def test_local_and_component_poses_round_trip(self) -> None:
        pose, parents = ArmFix().chain_pose(arm_out=30.0, elbow=40.0, yaw=25.0)
        again = pm.component_pose(pm.local_pose(pose, parents), parents)
        for bone, (location, rotation) in pose.items():
            for got, wanted in zip(again[bone][0], location):
                self.assertAlmostEqual(got, wanted, places=6)
            self.assertLess(pm.quat_angle_deg(pm.quat_mul(pm.quat_inverse(rotation), again[bone][1])), 1e-4)


if __name__ == '__main__':
    unittest.main()
