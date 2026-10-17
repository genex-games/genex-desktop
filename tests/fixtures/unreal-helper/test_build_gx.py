"""The gx library's pieces that need no engine to judge: scope names and their bookkeeping, the
arguments of kit pieces, world materials, atmosphere presets, sockets and instancing (refused
before anything is made), the true triangle count of a model file, and the import tools' file and
option checks (a file outside the game's assets, through a link, of the wrong kind, or an option it
doesn't take imports nothing)."""

import json
import os
import struct
import unittest

import unreal
from unreal import Vector

from genex_build import atmosphere, audit, kit, mesh_math, place, scope, sockets, world_materials
from genex_build.tools import GenexBuildTools
from genex_loop.errors import Refused

from support import HelperCase

MIB = 1024 * 1024


def tool(name: str, *args) -> dict:
    return json.loads(getattr(GenexBuildTools, name)(*args))


def glb(document: dict) -> bytes:
    """A binary glTF holding only its JSON chunk."""
    text = json.dumps(document).encode('utf-8')
    text += b' ' * (-len(text) % 4)
    return struct.pack('<4sII', b'glTF', 2, 12 + 8 + len(text)) + struct.pack('<II', len(text), 0x4E4F534A) + text


class Arguments(HelperCase):
    def assert_refused_quietly(self, step, *args, **kwargs) -> None:
        self.fresh()
        with self.assertRaises(Refused):
            step(*args, **kwargs)
        self.assertEqual(unreal.calls, [], 'the editor was changed')

    def test_scope_names_are_short_paths_of_plain_words(self) -> None:
        for good in ('kit', 'zones/shaft', 'Lamp-row_2'):
            self.assertEqual(scope.check_name(good), good)
        for bad in ('', '/kit', 'kit/', 'zones//shaft', 'a b', '../kit', 'k' * 65, 7, None, 'gx:kit'):
            with self.subTest(bad=bad):
                self.assert_refused_quietly(scope.check_name, bad)

    def test_kit_pieces_refuse_kinds_names_sizes_and_bevels_they_do_not_take(self) -> None:
        cases = [('arch', 'Slab', (100, 100, 10), None), ('slab', 'Sl ab', (100, 100, 10), None),
                 ('slab', 'Slab', (100, 100), None), ('slab', 'Slab', (0, 100, 10), None),
                 ('slab', 'Slab', (100, float('nan'), 10), None), ('slab', 'Slab', (1e9, 100, 10), None),
                 ('slab', 'Slab', (100, True, 10), None), ('slab', 'Slab', (100, 100, 10), -1),
                 ('slab', 'Slab', (100, 100, 10), 500)]
        for args in cases:
            with self.subTest(args=args):
                self.assert_refused_quietly(kit.kit_module, *args)
        self.assertEqual(kit.check('girder', 'Beam', [800, 40, 60], None), ('girder', 'Beam', (800.0, 40.0, 60.0), 2.0))

    def test_world_materials_take_only_their_kinds_parameters_in_range(self) -> None:
        self.assertEqual(world_materials.check('concrete', None, {'dark': (0.1, 0.1, 0.1), 'roughness': 0.8}),
                         ('concrete', 'Concrete', {'Dark': (0.1, 0.1, 0.1), 'Roughness': 0.8}))
        cases = [('marble', None, {}), ('concrete', 'Bad Name', {}), ('concrete', None, {'color': (1, 1, 1)}),
                 ('concrete', None, {'dark': (0.1, 0.1)}), ('concrete', None, {'dark': (-1, 0, 0)}),
                 ('steel', None, {'rusted': float('inf')}), ('emissive', None, {'intensity': -5}),
                 ('emissive', None, {'color': 'orange'})]
        for kind, name, params in cases:
            with self.subTest(kind=kind, params=params):
                self.assert_refused_quietly(world_materials.world_material, kind, name, **params)

    def test_atmosphere_presets_take_overrides_of_their_own_values_only(self) -> None:
        self.assertEqual(atmosphere.resolve('megastructure', {'exposure': 1.5}).exposure, 1.5)
        self.assertEqual(atmosphere.resolve('daylight', {}), atmosphere.PRESETS['daylight'])
        for preset, overrides in (('noon', {}), ('daylight', {'sun_colour': 1}), ('daylight', {'exposure': 'bright'}),
                                  ('daylight', {'fog_density': float('nan')})):
            with self.subTest(preset=preset, overrides=overrides):
                self.assert_refused_quietly(atmosphere.atmosphere, preset, **overrides)

    def test_instances_refuse_meshes_and_transforms_before_spawning_anything(self) -> None:
        unreal.state['loaded']['/Game/Kit/SM_Rib'] = unreal.StaticMesh(Vector(), Vector(1, 1, 1))
        cases = [('/Game/Kit/Missing', [(0, 0, 0)]), ('/Game/Kit/SM_Rib', []),
                 ('/Game/Kit/SM_Rib', [(0, 0)]), ('/Game/Kit/SM_Rib', [((0, 0, 0), (0, 'x', 0))]),
                 ('/Game/Kit/SM_Rib', [(0, float('inf'), 0)]), ('/Game/Kit/SM_Rib', 'everywhere'),
                 ('/Game/Kit/SM_Rib', [(0, 0, 0)] * (place.MAX_INSTANCES + 1))]
        for mesh, transforms in cases:
            with self.subTest(mesh=mesh, transforms=str(transforms)[:40]):
                self.assert_refused_quietly(place.instances, mesh, transforms)

    def test_transforms_come_from_plain_tuples(self) -> None:
        moved = place.transform(((100, 200, 300), (10, 90, 0), 2))
        self.assertEqual((moved.location.x, moved.rotation.yaw, moved.scale.z), (100, 90, 2))
        self.assertEqual(place.transform((5, 6, 7)).location.y, 6)

    def test_sockets_and_offsets_are_checked_first(self) -> None:
        self.assertEqual(sockets.check('hand_r', None)[0], 'hand_r')
        for socket, offset in (('hand r', None), ('', None), ('../hand', None), ('hand_r', {'position': (0, 0, 0)}),
                               ('hand_r', {'location': (0, 0, 5000)}), ('hand_r', {'scale': (0, 1, 1)}),
                               ('hand_r', 'up')):
            with self.subTest(socket=socket, offset=offset):
                self.assert_refused_quietly(sockets.check, socket, offset)
        self.assertIn('error', tool('attach_to_socket', '/Game/BP_Hero', '/Game/SM_Blade', 'hand r', ''))
        self.assertIn('error', tool('attach_to_socket', '/Game/BP_Hero', '/Game/SM_Blade', 'hand_r', '[1, 2]'))


class Books(HelperCase):
    def test_a_scope_opened_twice_in_a_run_removes_its_old_actors_once(self) -> None:
        old = unreal.Actor('OldLamp')
        old.tags = [unreal.Name('gx:lamps')]
        unreal.state['actors'] = [old]
        scope.begin_run('kit')
        scope.scope('lamps')
        scope.own(unreal.Actor('NewLamp'))
        scope.scope('lamps')
        self.assertEqual(scope.end_run(), {'kit': {'removed': 0, 'made': 0}, 'lamps': {'removed': 1, 'made': 1}})
        self.assertEqual(unreal.state['actors'], [], 'the old lamp went; the new one was never placed in this stub level')

    def test_outside_a_run_there_is_no_open_scope(self) -> None:
        scope.end_run()
        with self.assertRaises(Refused):
            scope.current()
        self.assertEqual(scope.current_or('held'), 'held')


class Audit(HelperCase):
    def test_it_counts_primitives_instances_and_triangles(self) -> None:
        cube = unreal.StaticMesh(Vector(-50, -50, -50), Vector(50, 50, 50), 12)
        cube.get_path_name = lambda: '/Engine/BasicShapes/Cube.Cube'
        cube.get_num_nanite_triangles = lambda: 0
        rib = unreal.StaticMesh(Vector(), Vector(1, 1, 1), 100)
        rib.get_path_name = lambda: '/Game/GX/Kit/SM_Rib.SM_Rib'
        rib.get_num_nanite_triangles = lambda: 5000
        box = unreal.StaticMeshActor('Box_0')
        box.static_mesh_component.props['static_mesh'] = cube
        wall = unreal.StaticMeshActor('Wall')
        wall.static_mesh_component.props['static_mesh'] = rib
        unreal.state['actors'] = [box, wall, unreal.Actor('Empty')]
        counted = audit.audit('')
        self.assertEqual((counted['actors'], counted['meshComponents'], counted['primitives']), (3, 2, 1))
        self.assertEqual(counted['triangles'], 12 + 5000)
        self.assertEqual(counted['primitiveActors'], ['Box_0'])
        self.assertEqual(counted['heaviest'][0], {'mesh': '/Game/GX/Kit/SM_Rib', 'triangles': 5000})


class SkeletonScale(HelperCase):
    """A rigged glTF whose skeleton hangs under a scaled root (Meshy's Armature at 0.01) imports that
    scale into the mesh, so a 2 m character lands 2 cm tall: the import counters it."""

    @staticmethod
    def rigged(root_scale, hips_scale=None) -> dict:
        armature = {'name': 'Armature', 'children': [1, 2]}
        if root_scale is not None:
            armature['scale'] = [root_scale] * 3
        hips = {'name': 'Hips', 'children': [3]}
        if hips_scale is not None:
            hips['scale'] = [hips_scale] * 3
        return {
            'scenes': [{'nodes': [0]}],
            'nodes': [armature, {'name': 'char1', 'mesh': 0, 'skin': 0}, hips, {'name': 'Spine'}],
            'skins': [{'joints': [2, 3]}],
            'meshes': [{'primitives': [{'attributes': {'POSITION': 0}}]}],
            'accessors': [{'count': 3, 'min': [-0.4, 0, -0.2], 'max': [0.4, 2.0, 0.2]}],
        }

    def test_a_skeleton_under_a_centimetre_root_is_scaled_back_up(self) -> None:
        self.assertAlmostEqual(mesh_math.skeleton_counter_scale(self.rigged(0.01)), 100.0)

    def test_a_root_joint_scaled_itself_counts_too(self) -> None:
        # Applying an Armature's 0.01 to the object alone leaves the root joint at x100 with every other bone in metres.
        self.assertAlmostEqual(mesh_math.skeleton_counter_scale(self.rigged(None, hips_scale=100)), 0.01)
        self.assertEqual(mesh_math.skeleton_counter_scale(self.rigged(0.01, hips_scale=100)), 1.0)

    def test_a_skeleton_at_scale_one_is_left_alone(self) -> None:
        self.assertEqual(mesh_math.skeleton_counter_scale(self.rigged(None)), 1.0)
        self.assertEqual(mesh_math.skeleton_counter_scale(self.rigged(1.02)), 1.0)

    def test_a_model_without_a_skin_is_left_alone(self) -> None:
        document = self.rigged(0.01)
        document['skins'] = []
        self.assertEqual(mesh_math.skeleton_counter_scale(document), 1.0)

    def test_the_file_is_read_for_it(self) -> None:
        path = os.path.join(self.game, 'assets', 'genex', 'troll.glb')
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'wb') as handle:
            handle.write(glb(self.rigged(0.01)))
        self.assertAlmostEqual(mesh_math.source_counter_scale(path), 100.0)
        self.assertEqual(mesh_math.source_counter_scale(path + '.missing'), 1.0)


class SourceTriangles(HelperCase):
    def test_a_glb_counts_every_primitive_each_node_draws(self) -> None:
        document = {
            'accessors': [{'count': 300}, {'count': 90}, {'count': 12}],
            'meshes': [{'primitives': [{'indices': 0}, {'attributes': {'POSITION': 1}}]},
                       {'primitives': [{'indices': 2, 'mode': 5}, {'indices': 2, 'mode': 1}]}],
            'nodes': [{'mesh': 0}, {'mesh': 0}, {'mesh': 1}, {'name': 'empty'}],
        }
        file = os.path.join(self.root, 'model.glb')
        with open(file, 'wb') as handle:
            handle.write(glb(document))
        # Mesh 0: 100 + 30 triangles, drawn twice; mesh 1: a strip of 12 points (10) and lines (none).
        self.assertEqual(mesh_math.source_triangles(file), 2 * 130 + 10)

    def test_an_obj_counts_each_face_of_n_corners_as_n_minus_2(self) -> None:
        file = self.write(os.path.join(self.root, 'm.obj'), 'v 0 0 0\nf 1 2 3\nf 1 2 3 4\nf 1 2 3 4 5\n# f 1 2 3\n')
        self.assertEqual(mesh_math.source_triangles(file), 1 + 2 + 3)

    def test_anything_else_or_unreadable_has_no_count(self) -> None:
        bad = os.path.join(self.root, 'bad.glb')
        with open(bad, 'wb') as handle:
            handle.write(b'not a glb at all')
        for file in (bad, self.write(os.path.join(self.root, 'm.fbx'), 'Kaydara'), os.path.join(self.root, 'none.glb')):
            with self.subTest(file=os.path.basename(file)):
                self.assertIsNone(mesh_math.source_triangles(file))


class Imports(HelperCase):
    def setUp(self) -> None:
        super().setUp()
        self.assets = self.path('game', 'assets', 'agents', 'a1')
        self.model = self.write(os.path.join(self.assets, 'blade.glb'), 'glTF')
        self.sound = self.write(os.path.join(self.assets, 'hit.mp3'), 'ID3')

    def test_imports_refuse_files_outside_the_games_assets_links_kinds_and_options_without_importing(self) -> None:
        outside = self.write(os.path.join(self.outside, 'evil.glb'), 'glTF')
        os.symlink(outside, os.path.join(self.assets, 'linked.glb'))
        self.write(os.path.join(self.game, 'top.glb'), 'glTF')
        with open(os.path.join(self.assets, 'huge.glb'), 'wb') as handle:
            handle.truncate(101 * MIB)
        good = 'assets/agents/a1/blade.glb'
        cases = {
            'outside the game': ('import_model', outside, '/Game/Models', 'Blade', 'box', True),
            'climbing out': ('import_model', '../outside/evil.glb', '/Game/Models', 'Blade', 'box', True),
            'a link out': ('import_model', 'assets/agents/a1/linked.glb', '/Game/Models', 'Blade', 'box', True),
            'not in assets': ('import_model', 'top.glb', '/Game/Models', 'Blade', 'box', True),
            'too large': ('import_model', 'assets/agents/a1/huge.glb', '/Game/Models', 'Blade', 'box', True),
            'a collision it does not take': ('import_model', good, '/Game/Models', 'Blade', 'mesh', True),
            'nanite not a bool': ('import_model', good, '/Game/Models', 'Blade', 'box', 'yes'),
            'a dest outside Game': ('import_model', good, '/Engine/Models', 'Blade', 'box', True),
            'a name that is a path': ('import_model', good, '/Game/Models', '../Blade', 'box', True),
            'a sound of another kind': ('import_sound', 'assets/agents/a1/blade.glb', '/Game/Audio', 'Hit'),
            'a character from a sound': ('import_character', 'assets/agents/a1/hit.mp3', '/Game/Characters', 'Hero'),
            'an animation with no skeleton': ('import_animation', good, '/Game/Nothing/SK_Hero', '/Game/Anims', 'Swing'),
        }
        for label, (name, *args) in cases.items():
            with self.subTest(label):
                self.fresh()
                result = tool(name, *args)
                self.assertIn('error', result)
                self.assertEqual(unreal.state['import_tasks'], [], 'nothing was imported')
                self.assertEqual(unreal.calls, [], 'the editor was changed')


if __name__ == '__main__':
    unittest.main()
