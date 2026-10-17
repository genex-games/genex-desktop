"""probe_characters and probe_view measure in the running play session what a shot can hide: a
pawn's feet off (or into) the ground, a pawn facing away from where it moves, the player's own
meshes cut by the camera's near plane, and extreme post-process. They only read: refused input
never even traces, and nothing in the editor changes."""

import os

import unreal
from unreal import Name, Rotator, Vector

from support import HelperCase

# Unreal's 1 m basic cube, centred on its pivot.
CUBE = unreal.StaticMesh(Vector(-50, -50, -50), Vector(50, 50, 50))
EYE = Vector(0, 0, 160)
HOSTILE_PARTS = ['../Lantern', 'a/b', '/tmp/Lantern', '..', 'Lan tern', ' Lantern', 'A' * 65, '1Lantern',
                 'Lantern\0', '_x', 'Lantern.py', 'GenexPart:Lantern', 'Lantern\n', '*']


def bones(low_z: float, high_z: float, x: float = 0.0) -> dict[str, Vector]:
    """A standing skeleton's feet and head."""
    return {'foot_l': Vector(x, -10, low_z), 'foot_r': Vector(x, 10, low_z), 'head': Vector(x, 0, high_z)}


def tagged(actor: unreal.Actor, *parts: str) -> unreal.Actor:
    actor.tags = [Name(f'GenexPart:{part}') for part in parts]
    return actor


class ProbeCase(HelperCase):
    """A play session over one flat floor at z = 0."""

    def setUp(self) -> None:
        super().setUp()
        unreal.state['pie'] = True
        unreal.state['floors'] = [unreal.Floor(0.0)]

    def pawns(self, part: str = '') -> list[dict]:
        result = self.call('probe_characters', part)
        self.assertNotIn('error', result)
        self.assertEqual(unreal.calls, [], 'the editor was changed')
        return result['pawns']

    def character(self, label: str, z: float = 88.0, mesh_from: float = 0.0, **kw) -> unreal.Character:
        mesh = unreal.SkeletalMeshComponent('CharacterMesh0', bones(mesh_from, mesh_from + 170))
        actor = unreal.Character(label, Vector(100, 0, z), mesh, **kw)
        unreal.state['actors'].append(actor)
        return actor


class Characters(ProbeCase):
    def test_refuses_part_names_that_are_paths_or_not_identifiers_without_tracing(self) -> None:
        self.character('Mutant_0')
        for part in HOSTILE_PARTS:
            with self.subTest(part=part):
                self.fresh()
                unreal.state['traces'].clear()
                self.assert_refused(self.call('probe_characters', part))
                self.assertEqual(unreal.state['traces'], [], 'it traced for a refused part')

    def test_refuses_without_a_play_session(self) -> None:
        unreal.state['pie'] = False
        self.character('Mutant_0')
        self.assert_refused(self.call('probe_characters', ''))
        self.assertEqual(unreal.state['traces'], [])

    def test_a_character_standing_on_the_floor_has_no_gap(self) -> None:
        tagged(self.character('Mutant_0'), 'Mutants')
        [row] = self.pawns('Mutants')
        self.assertEqual({k: row[k] for k in ['label', 'kind', 'player', 'parts', 'ground', 'aboveGround']},
                         {'label': 'Mutant_0', 'kind': 'character', 'player': False, 'parts': ['Mutants'],
                          'ground': 'below', 'aboveGround': True})
        self.assertEqual((row['gapCm'], row['feetGapCm'], row['groundZ']), (0, 0, 0))

    def test_a_mesh_floating_over_its_capsule_shows_in_the_feet_gap(self) -> None:
        self.character('Mutant_0', mesh_from=40)
        [row] = self.pawns()
        self.assertEqual((row['gapCm'], row['feetGapCm']), (0, 40), 'the capsule stands; its mesh floats')

    def test_a_character_under_the_ground_is_not_above_it(self) -> None:
        self.character('Mutant_0', z=-12, mesh_from=-100)
        [row] = self.pawns()
        self.assertEqual((row['ground'], row['aboveGround'], row['gapCm'], row['feetGapCm']), ('above', False, -100, -100))

    def test_a_character_a_little_into_the_ground_still_finds_it_below(self) -> None:
        self.character('Mutant_0', z=68, mesh_from=-20)
        [row] = self.pawns()
        self.assertEqual((row['ground'], row['aboveGround'], row['gapCm'], row['feetGapCm']), ('below', True, -20, -20))

    def test_a_character_over_nothing_has_no_ground(self) -> None:
        unreal.state['floors'] = []
        self.character('Mutant_0')
        [row] = self.pawns()
        self.assertEqual((row['ground'], row['aboveGround'], row['gapCm'], row['groundZ']), ('none', False, None, None))

    def test_a_floor_under_only_part_of_the_world_counts_only_there(self) -> None:
        unreal.state['floors'] = [unreal.Floor(0.0, rect=(-500, -500, 0, 500)), unreal.Floor(-300.0)]
        self.character('Mutant_0')
        [row] = self.pawns()
        self.assertEqual((row['groundZ'], row['gapCm']), (-300, 300), 'it stands past the floor\'s edge')

    def test_facing_is_compared_with_the_direction_it_moves(self) -> None:
        sideways = self.character('Crab_0')
        sideways.velocity = Vector(0, 300, -5)
        around = self.character('Turn_0')
        around.rotation = Rotator(yaw=170)
        around.velocity = Vector(-100, -17.6327, 0)
        still = self.character('Still_0')
        still.velocity = Vector(0.2, 0, 0)
        rows = {row['label']: row for row in self.pawns()}
        self.assertEqual((rows['Crab_0']['speedCmS'], rows['Crab_0']['verticalCmS']), (300, -5))
        self.assertEqual((rows['Crab_0']['moveYaw'], rows['Crab_0']['facingOffDeg']), (90.0, 90.0))
        self.assertEqual(rows['Turn_0']['facingOffDeg'], 20.0, 'the angle wraps around ±180')
        self.assertEqual((rows['Still_0']['moveYaw'], rows['Still_0']['facingOffDeg']), (None, None))

    def test_a_falling_character_says_so(self) -> None:
        self.character('Jumper_0', z=188, falling=True)
        [row] = self.pawns()
        self.assertEqual((row['falling'], row['gapCm']), (True, 100))

    def test_a_vehicle_reports_its_wheels_and_ignores_its_own_and_attached_collision(self) -> None:
        body = unreal.SkeletalMeshComponent('VehicleMesh', bones(35, 150), visible=False)
        car = unreal.WheeledVehiclePawn('BP_OffroadCar_0', Vector(0, 0, 90), body, contacts=[True, True, True, False])
        bike = unreal.Actor('BikeFront_0')
        car.attached = [bike]
        unreal.state['floors'] += [unreal.Floor(60.0, owner=car), unreal.Floor(80.0, owner=bike)]
        unreal.state['actors'] = [car, bike]
        unreal.state['player'] = car
        [row] = self.pawns()
        self.assertEqual({k: row[k] for k in ['label', 'kind', 'player', 'meshHidden', 'wheels', 'gapCm', 'feetGapCm']},
                         {'label': 'BP_OffroadCar_0', 'kind': 'vehicle', 'player': True, 'meshHidden': True,
                          'wheels': {'touching': 3, 'count': 4}, 'gapCm': 35, 'feetGapCm': None})

    def test_a_part_name_keeps_only_its_pawns_and_none_keeps_all_with_the_player_first(self) -> None:
        tagged(self.character('Mutant_0'), 'Mutants')
        self.character('Zombie_0')
        player = tagged(self.character('BP_FirstPersonCharacter_0'), 'Core', 'Arms')
        unreal.state['player'] = player
        unreal.state['actors'].append(tagged(unreal.Actor('Lantern_0'), 'Mutants'))
        self.assertEqual([row['label'] for row in self.pawns('Mutants')], ['Mutant_0'])
        rows = self.pawns('')
        self.assertEqual([row['label'] for row in rows], ['BP_FirstPersonCharacter_0', 'Mutant_0', 'Zombie_0'])
        self.assertEqual((rows[0]['player'], rows[0]['parts']), (True, ['Core', 'Arms']))
        self.assertEqual(self.pawns('Other'), [])

    def test_reports_at_most_30_pawns(self) -> None:
        for index in range(31):
            self.character(f'Mutant_{index:02}')
        result = self.call('probe_characters', '')
        self.assertEqual((len(result['pawns']), result['more']), (30, 1))

    def test_an_engine_call_that_fails_becomes_an_error_answer(self) -> None:
        class Broken(unreal.Pawn):
            def get_velocity(self):
                raise AttributeError("'Pawn' object has no attribute 'get_velocity'")

        unreal.state['actors'] = [Broken('Broken_0')]
        result = self.call('probe_characters', '')
        self.assertIn('error', result)
        self.assertIn('get_velocity', result['detail'])


class View(ProbeCase):
    """A first-person player whose eye is at (0, 0, 160), looking along +X with a 90° view."""

    def player(self, *components: unreal.SceneComponent, attached: tuple = (), **camera) -> unreal.Character:
        pawn = unreal.Character('BP_FirstPersonCharacter_0', Vector(0, 0, 88))
        pawn.components += [unreal.CameraComponent(location=EYE, **camera), *components]
        pawn.attached = list(attached)
        unreal.state['actors'] += [pawn, *attached]
        unreal.state['player'] = pawn
        unreal.state['camera'] = unreal.PlayerCameraManager(EYE, Rotator(), 90.0, pawn)
        return pawn

    def view(self) -> dict:
        result = self.call('probe_view')
        self.assertNotIn('error', result)
        self.assertEqual(unreal.calls, [], 'the editor was changed')
        return result

    def meshes(self) -> dict[str, dict]:
        return {row['component']: row for row in self.view()['meshes']}

    def test_refuses_without_a_play_session_or_a_player_camera(self) -> None:
        self.player()
        unreal.state['pie'] = False
        self.assert_refused(self.call('probe_view'))
        unreal.state['pie'] = True
        unreal.state['camera'] = None
        self.assert_refused(self.call('probe_view'))

    def test_reads_the_camera_and_the_project_near_clip_plane(self) -> None:
        self.player()
        config = os.path.join(unreal.state['project'], 'Config')
        os.makedirs(config, exist_ok=True)
        with open(os.path.join(config, 'DefaultEngine.ini'), 'w', encoding='utf-8') as handle:
            handle.write('[/Script/Engine.RendererSettings]\nNearClipPlane=99\n\n[/Script/Engine.Engine]\nNearClipPlane=20\n')
        camera = self.view()['camera']
        self.assertEqual(camera, {'location': [0, 0, 160], 'rotation': [0.0, 0.0, 0.0], 'fov': 90.0,
                                  'nearClipCm': 20.0, 'nearClipFrom': 'project',
                                  'viewTarget': 'BP_FirstPersonCharacter_0', 'component': 'FirstPersonCamera'})

    def test_a_camera_near_clip_override_wins(self) -> None:
        self.player(override_custom_near_clipping_plane=True, custom_near_clipping_plane=3.0)
        camera = self.view()['camera']
        self.assertEqual((camera['nearClipCm'], camera['nearClipFrom']), (3.0, 'camera'))

    def test_arms_held_in_front_are_in_view_and_clear_even_when_their_bounds_hold_the_eye(self) -> None:
        arms = unreal.SkeletalMeshComponent('FirstPersonMesh', {
            'hand_r': Vector(40, 12, 145), 'hand_l': Vector(40, -12, 145), 'upperarm_r': Vector(5, 20, 135)},
            bounds=(Vector(-20, -30, 120), Vector(60, 30, 170)))
        self.player(arms)
        row = self.meshes()['FirstPersonMesh']
        self.assertEqual({k: row[k] for k in ['actor', 'kind', 'inView', 'clipping', 'firstPerson']},
                         {'actor': 'BP_FirstPersonCharacter_0', 'kind': 'skeletal', 'inView': True,
                          'clipping': False, 'firstPerson': False})

    def test_arms_whose_hands_reach_the_camera_clip(self) -> None:
        arms = unreal.SkeletalMeshComponent('FirstPersonMesh', {'hand_r': Vector(6, 3, 158), 'hand_l': Vector(40, -12, 145)})
        self.player(arms)
        self.assertTrue(self.meshes()['FirstPersonMesh']['clipping'])

    def test_a_handlebar_through_the_near_plane_clips_and_one_further_out_does_not(self) -> None:
        through = unreal.StaticMeshComponent('Handlebar', CUBE, Vector(10, 0, 158), scale=Vector(0.08, 0.6, 0.04))
        clear = unreal.StaticMeshComponent('NumberPlate', CUBE, Vector(40, 0, 150), scale=Vector(0.02, 0.3, 0.2))
        below = unreal.StaticMeshComponent('Fender', CUBE, Vector(10, 0, 140), scale=Vector(0.08, 0.6, 0.04))
        self.player(through, clear, below)
        rows = self.meshes()
        self.assertEqual({k: rows['Handlebar'][k] for k in ['kind', 'inside', 'clipping', 'nearestCm']},
                         {'kind': 'static', 'inside': False, 'clipping': True, 'nearestCm': 6.0})
        self.assertEqual((rows['NumberPlate']['inView'], rows['NumberPlate']['clipping']), (True, False))
        self.assertFalse(rows['Fender']['clipping'], 'below the near plane\'s rectangle, out of sight')

    def test_a_turned_thin_bar_crossing_the_near_plane_clips(self) -> None:
        bar = unreal.StaticMeshComponent('Bar', CUBE, Vector(10, 0, 160), Rotator(yaw=45), Vector(0.01, 0.3, 0.01))
        aside = unreal.StaticMeshComponent('Aside', CUBE, Vector(10, 30, 160), Rotator(yaw=45), Vector(0.01, 0.1, 0.01))
        self.player(bar, aside)
        rows = self.meshes()
        self.assertTrue(rows['Bar']['clipping'])
        self.assertEqual((rows['Aside']['clipping'], rows['Aside']['inView']), (False, False))

    def test_the_camera_inside_a_mesh_is_inside_and_clips(self) -> None:
        self.player(unreal.StaticMeshComponent('Helmet', CUBE, EYE, scale=Vector(0.5, 0.5, 0.5)))
        row = self.meshes()['Helmet']
        self.assertEqual((row['inside'], row['clipping'], row['nearestCm']), (True, True, 0.0))

    def test_meshes_the_player_never_sees_are_left_out(self) -> None:
        near = {'location': Vector(10, 0, 160), 'scale': Vector(0.1, 0.1, 0.1)}
        self.player(
            unreal.StaticMeshComponent('Hidden', CUBE, visible=False, **near),
            unreal.StaticMeshComponent('HiddenInGame', CUBE, hidden_in_game=True, **near),
            unreal.StaticMeshComponent('OwnerNoSee', CUBE, owner_no_see=True, **near),
            unreal.StaticMeshComponent('Body', CUBE, first_person_primitive_type=unreal.FirstPersonPrimitiveType.WORLD_SPACE_REPRESENTATION, **near),
            unreal.StaticMeshComponent('Behind', CUBE, Vector(-60, 0, 160), scale=Vector(0.1, 0.1, 0.1)),
        )
        rows = self.meshes()
        self.assertEqual(sorted(rows), ['Behind'])
        self.assertEqual((rows['Behind']['inView'], rows['Behind']['clipping']), (False, False))

    def test_an_attached_weapon_counts_as_the_players(self) -> None:
        rifle = unreal.Actor('BP_Rifle_0')
        rifle.components = [unreal.StaticMeshComponent('RifleMesh', CUBE, Vector(8, 0, 160), scale=Vector(0.1, 0.05, 0.05))]
        self.player(attached=(rifle,))
        row = self.meshes()['RifleMesh']
        self.assertEqual((row['actor'], row['clipping']), ('BP_Rifle_0', True))

    def test_first_person_scale_draws_first_person_meshes_closer(self) -> None:
        gun = unreal.StaticMeshComponent('Gun', CUBE, Vector(20, 0, 160), scale=Vector(0.1, 0.05, 0.05),
                                         first_person_primitive_type=unreal.FirstPersonPrimitiveType.FIRST_PERSON)
        self.player(gun)
        self.assertEqual((self.meshes()['Gun']['clipping'], self.meshes()['Gun']['firstPerson']), (False, True))
        self.fresh()
        unreal.state['actors'].clear()
        self.player(gun, enable_first_person_scale=True, first_person_scale=0.5)
        self.assertTrue(self.meshes()['Gun']['clipping'], 'drawn at half the distance, it crosses the near plane')

    def test_audits_active_post_process_and_flags_extreme_values(self) -> None:
        settings = unreal.PostProcessSettings
        unreal.state['cvars'] = {'r.DefaultFeature.MotionBlur': 1, 'r.MotionBlurQuality': 4}
        far = (Vector(5000, 5000, 0), Vector(6000, 6000, 500))
        unreal.state['actors'] += [
            unreal.PostProcessVolume('PP_Global', settings(override_motion_blur_amount=True, motion_blur_amount=1.0,
                                                           bloom_intensity=50.0, override_scene_fringe_intensity=True,
                                                           scene_fringe_intensity=0.5), priority=1.0),
            unreal.PostProcessVolume('PP_Off', settings(override_bloom_intensity=True, bloom_intensity=20.0), enabled=False),
            unreal.PostProcessVolume('PP_Far', settings(override_vignette_intensity=True, vignette_intensity=1.0),
                                     unbound=False, box=far),
            unreal.PostProcessVolume('PP_Zero', settings(override_bloom_intensity=True, bloom_intensity=20.0), blend_weight=0.0),
        ]
        self.player(post_process_settings=settings(override_vignette_intensity=True, vignette_intensity=1.0,
                                                   override_depth_of_field_focal_distance=True,
                                                   depth_of_field_focal_distance=200.0))
        audit = self.view()['postProcess']
        self.assertEqual(audit['defaults'], {'motionBlur': 1, 'motionBlurQuality': 4, 'autoExposure': 0, 'bloom': 0})
        self.assertEqual({s['name']: s['active'] for s in audit['sources']},
                         {'PP_Global': True, 'PP_Off': False, 'PP_Far': False, 'PP_Zero': False, 'FirstPersonCamera': True})
        self.assertEqual(next(s for s in audit['sources'] if s['name'] == 'PP_Global')['settings'],
                         {'motionBlurAmount': 1.0, 'chromaticAberration': 0.5})
        self.assertEqual(audit['extreme'], [
            {'source': 'volume', 'name': 'PP_Global', 'setting': 'motionBlurAmount', 'value': 1.0, 'fine': [0.0, 0.7]},
            {'source': 'camera', 'name': 'FirstPersonCamera', 'setting': 'vignetteIntensity', 'value': 1.0, 'fine': [0.0, 0.8]},
            {'source': 'camera', 'name': 'FirstPersonCamera', 'setting': 'dofFocalDistance', 'value': 200.0, 'fine': [500.0, None]},
        ])

    def test_depth_of_field_at_zero_is_off_not_extreme(self) -> None:
        self.player(post_process_settings=unreal.PostProcessSettings(
            override_depth_of_field_focal_distance=True, depth_of_field_focal_distance=0.0))
        self.assertEqual(self.view()['postProcess']['extreme'], [])
