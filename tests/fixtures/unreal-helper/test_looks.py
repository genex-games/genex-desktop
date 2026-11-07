"""The play's look checks read the characters near the player by their skeleton a few times a second:
one that slides along without stepping, one in a T-pose, and feet that float over the ground or sink
into it are told as findings; a character that walks with its feet, stands with its arms down, or
lies as a ragdoll is not."""

import math

import unreal
from unreal import Vector

from genex_play import looks_math

from test_detect import DetectCase, player_state

STEP_S = 0.05


class Body:
    """A bot near the player: a character with a skeleton whose bones the test poses each frame."""

    def __init__(self, label: str = 'BP_Bot_3', at: Vector | None = None) -> None:
        self.mesh = unreal.SkeletalMeshComponent(name=f'{label}_Mesh', bones={})
        self.actor = unreal.Character(label, at or Vector(500, 0, 100), mesh=self.mesh)
        self.arms_out, self.feet_z, self.stepping = False, 12.0, True
        self.pose(0.0)

    def pose(self, t: float) -> None:
        at = self.actor.location
        swing = 25.0 * math.sin(t * 8.0) if self.stepping else 0.0
        reach = (0.0, 60.0) if self.arms_out else (0.0, 20.0)
        drop = 0.0 if self.arms_out else -55.0
        self.mesh.bones.update({
            'foot_l': Vector(at.x + swing, at.y - 12, self.feet_z), 'foot_r': Vector(at.x - swing, at.y + 12, self.feet_z),
            'upperarm_l': Vector(at.x, at.y - 18, at.z + 50), 'hand_l': Vector(at.x + reach[0], at.y - 18 - reach[1], at.z + 50 + drop),
            'upperarm_r': Vector(at.x, at.y + 18, at.z + 50), 'hand_r': Vector(at.x + reach[0], at.y + 18 + reach[1], at.z + 50 + drop),
            'lowerarm_l': Vector(at.x, at.y - 40, at.z + 50), 'ik_foot_l': Vector(at.x, at.y, at.z)})


class Looks(DetectCase):
    def setUp(self) -> None:
        super().setUp()
        unreal.state['floors'] = [unreal.Floor(0.0)]
        self.bot = Body()
        unreal.state['actors'].append(self.bot.actor)

    def play(self, seconds: float, speed_cm_s: float = 0.0) -> list[str]:
        t = 0.0
        while t < seconds:
            self.bot.actor.location = Vector(self.bot.actor.location.x, self.bot.actor.location.y + speed_cm_s * STEP_S, 100)
            t += STEP_S
            self.bot.pose(t)
            self.frame(STEP_S, STEP_S)
        return [f['code'] for f in player_state()['findings']]

    def test_a_bot_that_walks_with_its_feet_stands_with_its_arms_down_on_the_ground_is_fine(self) -> None:
        self.assertEqual(self.play(4.0, 300.0), [])

    def test_a_bot_that_slides_along_without_stepping_is_told(self) -> None:
        self.bot.stepping = False
        codes = self.play(4.0, 300.0)
        self.assertEqual(codes, ['sliding'])

    def test_a_bot_standing_still_with_still_feet_is_not_sliding(self) -> None:
        self.bot.stepping = False
        self.assertEqual(self.play(4.0, 0.0), [])

    def test_a_bot_in_a_t_pose_is_told_once(self) -> None:
        self.bot.arms_out = True
        self.assertEqual(self.play(4.0), ['t-pose'])

    def test_feet_over_the_ground_float_and_feet_under_it_sink(self) -> None:
        self.bot.feet_z = 60.0
        self.assertEqual(self.play(2.0), ['floating'])
        self.bot.feet_z = -50.0
        self.assertEqual(self.play(2.0), ['sunk'])

    def test_a_motion_character_is_read_by_the_body_the_player_sees_not_its_hidden_driver(self) -> None:
        # motion_character's own mesh is the sample's hidden mannequin; the visible Body copies its pose.
        # Read by its own mesh, a sliding fighter was skipped as hidden, and the detector said nothing.
        driver = unreal.SkeletalMeshComponent('BP_Duel_3_Driver', bones=dict(self.bot.mesh.bones), visible=False)
        self.bot.actor.props['mesh'] = driver
        self.bot.actor.components.append(driver)
        self.bot.stepping = False
        self.assertEqual(self.play(4.0, 300.0), ['sliding'])

    def test_a_driver_left_shown_under_the_body_is_not_the_body_read(self) -> None:
        # The sword duel's driver stayed shown in play, under the Body: read first, its stepping feet hid the slide.
        stepper = Body('BP_Duel_3_Driver')
        self.bot.actor.props['mesh'] = stepper.mesh
        self.bot.actor.components.append(stepper.mesh)
        pose = self.bot.pose

        def both(t: float) -> None:
            pose(t)
            stepper.actor.location = self.bot.actor.location
            stepper.pose(t)

        self.bot.pose = both
        self.bot.stepping = False
        self.assertEqual(self.play(4.0, 300.0), ['sliding'])

    def test_first_person_arms_are_never_the_body_read(self) -> None:
        # A first-person pawn's arms share the body's skeleton, feet and all, and its owner alone sees them.
        arms = unreal.SkeletalMeshComponent('Mesh1P', bones={'foot_l': Vector(), 'foot_r': Vector()}, only_owner_see=True)
        self.bot.actor.components.append(arms)
        self.bot.stepping = False
        self.assertEqual(self.play(4.0, 300.0), ['sliding'])

    def test_a_rig_whose_bones_carry_a_prefix_is_read_by_its_feet(self) -> None:
        self.bot.mesh.bones = {}
        self.bot.pose = lambda t: self.bot.mesh.bones.update({
            'mixamorig:LeftFoot': Vector(self.bot.actor.location.x, self.bot.actor.location.y - 12, 12),
            'mixamorig:RightFoot': Vector(self.bot.actor.location.x, self.bot.actor.location.y + 12, 12)})
        self.bot.pose(0.0)
        self.assertEqual(self.play(4.0, 300.0), ['sliding'])

    def test_a_floor_that_lets_the_sight_channel_through_is_still_the_ground(self) -> None:
        unreal.state['floors'] = [unreal.Floor(0.0, sight=False), unreal.Floor(-40.0)]
        self.assertEqual(self.play(2.0), [], 'the bot stands on the floor the sight channel passes')

    def test_a_ragdoll_or_a_far_bot_is_left_alone(self) -> None:
        self.bot.arms_out, self.bot.feet_z = True, 80.0
        self.bot.mesh.props['simulating'] = True
        self.assertEqual(self.play(3.0), [])
        self.bot.mesh.props['simulating'] = False
        self.bot.actor.location = Vector(6000, 0, 100)
        self.assertEqual(self.play(3.0), [])


class Arithmetic(DetectCase):
    def test_an_arm_out_is_level_and_across_the_facing(self) -> None:
        self.assertTrue(looks_math.arm_out((0, 0, 150), (0, 60, 150), 0.0))
        self.assertFalse(looks_math.arm_out((0, 0, 150), (0, 15, 95), 0.0), 'an arm hanging down')
        self.assertFalse(looks_math.arm_out((0, 0, 150), (60, 0, 150), 0.0), 'an arm reaching forward (aiming)')
