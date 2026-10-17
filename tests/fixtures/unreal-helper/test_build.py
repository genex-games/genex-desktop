"""The build tools (genex_build.tools.GenexBuildTools) agents call through call_tool: the route (a
spline tagged GenexRoute, the PlayerStart on its first point facing down it), the terrain along it (a
Geometry Script grid made a static mesh with complex-as-simple collision, tagged genex:terrain), the
dirt material, models imported from the game's assets folder (one combined static mesh in its own
folder, with collision and Nanite as asked) and meshes attached to a Blueprint. Every refused input (a path out of its folder or through a link, a
number out of range or not finite, JSON of the wrong shape) answers {error} with nothing changed
in the editor: no call recorded, no actor added."""

import json
import math
import os
import unittest

import unreal
from unreal import Vector

from genex_build import terrain_math
from genex_build.tools import GenexBuildTools
from genex_play import route_math

from support import HelperCase

MIB = 1024 * 1024
DARK, LIGHT = (0.13, 0.11, 0.09), (0.30, 0.27, 0.23)


def tool(name: str, *args) -> dict:
    return json.loads(getattr(GenexBuildTools, name)(*args))


class BuildCase(HelperCase):
    """An editor (no play session) whose level holds the template's PlayerStart."""

    def setUp(self) -> None:
        super().setUp()
        self.start = unreal.PlayerStart('PlayerStart', Vector(-500, 300, 90))
        unreal.state['actors'] = [self.start]

    def assert_unchanged(self, result: dict, actors: list | None = None) -> None:
        """Refused: an error, no editor call, the level's actors as they were."""
        self.assertIn('error', result)
        self.assertEqual(unreal.calls, [], 'the editor was changed')
        self.assertEqual(unreal.state['actors'], actors if actors is not None else [self.start])

    def tagged(self, tag: str) -> list:
        return [a for a in unreal.state['actors'] if tag in [str(t) for t in a.tags]]


class SetRoute(BuildCase):
    def test_refuses_points_that_are_not_a_route(self) -> None:
        far = 10 ** 9
        cases = {
            'not JSON': 'route please',
            'an object': '{"points": [[0, 0, 0], [5000, 0, 0]]}',
            'no points': '[]',
            'one point': '[[0, 0, 0]]',
            'one place twice': '[[10, 10, 0], [10, 10, 0]]',
            'two coordinates': '[[0, 0], [5000, 0]]',
            'four coordinates': '[[0, 0, 0, 1], [5000, 0, 0, 1]]',
            'text coordinates': '[[0, 0, 0], ["5000", 0, 0]]',
            'true as a coordinate': '[[0, 0, 0], [true, 0, 0]]',
            'NaN': '[[0, 0, 0], [NaN, 0, 0]]',
            'Infinity': '[[0, 0, 0], [Infinity, 0, 0]]',
            'too far out': f'[[0, 0, 0], [{far}, 0, 0]]',
            'too short to drive': '[[0, 0, 0], [500, 0, 0]]',
            'too many points': json.dumps([[i * 100, 0, 0] for i in range(1025)]),
            'too much text': '[[0, 0, 0], [5000, 0, 0]]' + ' ' * 70000,
        }
        for label, points in cases.items():
            with self.subTest(label):
                self.fresh()
                self.assert_unchanged(tool('set_route', points, 0, False, 200.0))

    def test_refuses_a_seed_route_of_a_length_it_cannot_make(self) -> None:
        for length in (0.0, -50.0, 5.0, 1e7, float('nan'), float('inf')):
            with self.subTest(length=length):
                self.fresh()
                self.assert_unchanged(tool('set_route', '', 3, True, length))
        self.assert_unchanged(tool('set_route', '', True, True, 200.0))

    def test_refused_during_play(self) -> None:
        unreal.state['pie'] = True
        self.assert_unchanged(tool('set_route', '[[0, 0, 0], [5000, 0, 0]]', 0, False, 200.0))

    def test_points_make_a_tagged_spline_and_move_the_player_start_to_its_start_facing_down_it(self) -> None:
        result = tool('set_route', '[[0, 0, 0], [5000, 5000, 0], [10000, 5000, 0]]', 0, False, 200.0)
        [actor] = self.tagged('GenexRoute')
        self.assertIn('genex:route', [str(t) for t in actor.tags])
        [spline] = actor.get_components_by_class(unreal.SplineComponent)
        self.assertEqual([(p.x, p.y, p.z) for p in spline.points], [(0, 0, 0), (5000, 5000, 0), (10000, 5000, 0)])
        self.assertIn(('set_spline_points', 3, 'WORLD'), unreal.calls)
        self.assertFalse(spline.is_closed_loop())
        self.assertEqual((self.start.location.x, self.start.location.y), (0, 0))
        self.assertGreater(self.start.location.z, 0, 'lifted above the route so the pawn drops onto it')
        self.assertAlmostEqual(self.start.rotation.yaw, 45.0)
        self.assertEqual(result['route'], actor.get_actor_label())
        self.assertEqual((result['points'], result['closed']), (3, False))
        self.assertAlmostEqual(result['lengthM'], (math.hypot(5000, 5000) + 5000) / 100, places=1)
        self.assertEqual(result['playerStart'], {'location': [0, 0, round(self.start.location.z)], 'yaw': 45.0})

    def test_a_seed_makes_a_closed_loop_and_a_second_call_moves_the_same_spline(self) -> None:
        first = tool('set_route', '', 7, True, 300.0)
        self.assertEqual(first['closed'], True)
        self.assertAlmostEqual(first['lengthM'], 300.0, delta=3.0)
        self.assertEqual(first['points'], len(terrain_math.route_points(7, 300.0, True)))
        tool('set_route', '[[0, 0, 0], [8000, 0, 0]]', 0, False, 200.0)
        [actor] = self.tagged('GenexRoute')
        self.assertEqual(len(actor.get_components_by_class(unreal.SplineComponent)), 1)
        self.assertEqual([c for c in unreal.calls if c[0] == 'add_subobject'], [('add_subobject', 'SplineComponent', 'Actor')])

    def test_a_level_without_a_player_start_gets_one(self) -> None:
        unreal.state['actors'] = []
        tool('set_route', '[[100, 200, 0], [100, 9000, 0]]', 0, False, 200.0)
        [start] = [a for a in unreal.state['actors'] if isinstance(a, unreal.PlayerStart)]
        self.assertEqual((start.location.x, start.location.y, round(start.rotation.yaw)), (100, 200, 90))


class TrackTerrain(BuildCase):
    def test_refuses_sizes_and_counts_out_of_range_without_touching_the_level(self) -> None:
        cases = {
            'width zero': (1, 200.0, 0.0, 0, 0),
            'width negative': (1, 200.0, -12.0, 0, 0),
            'width too wide': (1, 200.0, 500.0, 0, 0),
            'width NaN': (1, 200.0, float('nan'), 0, 0),
            'length too short': (1, 5.0, 12.0, 0, 0),
            'length infinite': (1, float('inf'), 12.0, 0, 0),
            'negative whoops': (1, 200.0, 12.0, -1, 0),
            'too many whoops': (1, 200.0, 12.0, 41, 0),
            'whoops as a bool': (1, 200.0, 12.0, True, 0),
            'too many jumps': (1, 200.0, 12.0, 0, 7),
            'seed as a bool': (False, 200.0, 12.0, 0, 0),
            'features that do not fit': (1, 60.0, 12.0, 0, 2),
        }
        for label, args in cases.items():
            with self.subTest(label):
                self.fresh()
                self.assert_unchanged(tool('track_terrain', *args))

    def test_refused_during_play(self) -> None:
        unreal.state['pie'] = True
        self.assert_unchanged(tool('track_terrain', 1, 200.0, 12.0, 0, 0))

    def test_without_a_route_it_lays_a_straight_one_then_the_ground_along_it(self) -> None:
        result = tool('track_terrain', 4, 200.0, 12.0, 6, 1)
        [route] = self.tagged('GenexRoute')
        [spline] = route.get_components_by_class(unreal.SplineComponent)
        self.assertEqual([(p.x, p.y) for p in spline.points], [(0, 0), (20000, 0)])
        [terrain] = self.tagged('genex:terrain')
        mesh = terrain.static_mesh_component.get_editor_property('static_mesh')
        self.assertEqual(result['mesh'], '/Game/Genex/Terrain/SM_GenexTerrain')
        self.assertIs(unreal.load_asset(result['mesh']), mesh)
        self.assertEqual((result['actor'], result['lengthM'], result['widthM']), (terrain.get_actor_label(), 200.0, 12.0))
        self.assertEqual(result['vertices'], len(mesh.vertices))
        self.assertLessEqual(result['vertices'], terrain_math.MAX_VERTICES)
        [created] = [c for c in unreal.calls if c[0] == 'create_new_static_mesh_asset_from_mesh']
        self.assertEqual(created[2], {'enable_collision': True,
                                      'collision_mode': unreal.CollisionTraceFlag.CTF_USE_COMPLEX_AS_SIMPLE,
                                      'enable_recompute_normals': False})
        self.assertIn(('recompute_normals',), unreal.calls)
        self.assertIn(('set_mesh_u_vs_from_planar_projection', 0), unreal.calls)
        # The ground's heights are terrain_math's: the track's groove on the start straight, flat ground far off it.
        heights = {(round(v.x), round(v.y)): v.z for v in mesh.vertices}
        near_start = min(heights, key=lambda xy: math.hypot(xy[0] - 1000, xy[1]))
        far_off = min(heights, key=lambda xy: math.hypot(xy[0] - 10000, xy[1] - 2500))
        self.assertEqual(heights[near_start], -terrain_math.GROOVE_CM)
        self.assertEqual(heights[far_off], 0.0)
        self.assertGreater(max(heights.values()), terrain_math.JUMP_HEIGHT_CM - terrain_math.GROOVE_CM - 1, 'the jump')

    def test_it_follows_an_existing_closed_route_and_a_second_terrain_replaces_the_first(self) -> None:
        tool('set_route', '', 2, True, 250.0)
        first = tool('track_terrain', 1, 999.0, 14.0, 4, 0)
        self.assertAlmostEqual(first['lengthM'], 250.0, delta=5.0, msg='the route decides the length')
        [route] = self.tagged('GenexRoute')
        self.assertTrue(route.get_components_by_class(unreal.SplineComponent)[0].is_closed_loop())
        second = tool('track_terrain', 2, 999.0, 14.0, 0, 1)
        [terrain] = self.tagged('genex:terrain')
        self.assertEqual(second['mesh'], '/Game/Genex/Terrain/SM_GenexTerrain_2')
        self.assertIs(terrain.static_mesh_component.get_editor_property('static_mesh'), unreal.load_asset(second['mesh']))
        self.assertEqual(second['actor'], first['actor'])

    def test_a_mesh_asset_unreal_does_not_make_is_an_error_and_no_actor(self) -> None:
        tool('set_route', '[[0, 0, 0], [20000, 0, 0]]', 0, False, 200.0)
        unreal.state['mesh_asset_fails'] = True
        result = tool('track_terrain', 1, 200.0, 12.0, 0, 0)
        self.assertIn('error', result)
        self.assertEqual(self.tagged('genex:terrain'), [])


class DirtMaterial(BuildCase):
    def test_refuses_names_and_palettes_it_does_not_take(self) -> None:
        names = ['', '../Dirt', 'Dirt/Mud', 'Dirt Mud', '1Dirt', 'D' * 65, 'Dirt\0', '/Game/Dirt']
        for name in names:
            with self.subTest(name=name):
                self.fresh()
                self.assert_unchanged(tool('dirt_material', name, ''))
        palettes = {
            'not JSON': 'brown',
            'a list': '[[0, 0, 0], [1, 1, 1]]',
            'no light': '{"dark": [0.1, 0.1, 0.1]}',
            'another key': '{"dark": [0.1, 0.1, 0.1], "light": [0.3, 0.3, 0.3], "mid": [0.2, 0.2, 0.2]}',
            'above one': '{"dark": [0.1, 0.1, 1.5], "light": [0.3, 0.3, 0.3]}',
            'negative': '{"dark": [-0.1, 0.1, 0.1], "light": [0.3, 0.3, 0.3]}',
            'NaN': '{"dark": [NaN, 0.1, 0.1], "light": [0.3, 0.3, 0.3]}',
            'two channels': '{"dark": [0.1, 0.1], "light": [0.3, 0.3, 0.3]}',
            'text channel': '{"dark": ["0.1", 0.1, 0.1], "light": [0.3, 0.3, 0.3]}',
        }
        for label, palette in palettes.items():
            with self.subTest(label):
                self.fresh()
                self.assert_unchanged(tool('dirt_material', 'Dirt', palette))

    def expression(self, material, kind: str) -> list:
        return [e for e in material.expressions if type(e).__name__ == kind]

    def test_the_default_dirt_is_world_space_noise_between_two_grey_browns_and_rough(self) -> None:
        result = tool('dirt_material', 'Dirt', '')
        self.assertEqual(result['material'], '/Game/Genex/Materials/M_Dirt')
        material = unreal.load_asset(result['material'])
        coarse, fine = sorted(self.expression(material, 'MaterialExpressionNoise'), key=lambda n: n.props['scale'])
        self.assertEqual((coarse.props['scale'], coarse.props['levels']), (0.004, 4))
        self.assertEqual((fine.props['scale'], fine.props['levels']), (0.08, 3))
        colors = sorted((c.props['constant'].r, c.props['constant'].g, c.props['constant'].b)
                        for c in self.expression(material, 'MaterialExpressionConstant3Vector'))
        self.assertEqual(colors, [DARK, LIGHT])
        [rough] = self.expression(material, 'MaterialExpressionConstant')
        self.assertEqual(rough.props['r'], 0.92)
        properties = {link[2]: type(link[0]).__name__ for link in material.links if isinstance(link[2], str)}
        self.assertEqual(properties, {'MP_BASE_COLOR': 'MaterialExpressionLinearInterpolate',
                                      'MP_ROUGHNESS': 'MaterialExpressionConstant'})
        inputs = sorted((type(a).__name__, type(b).__name__, pin) for a, _out, b, pin in material.links
                        if not isinstance(b, str))
        self.assertIn(('MaterialExpressionWorldPosition', 'MaterialExpressionNoise', 'Position'), inputs)
        self.assertIn(('MaterialExpressionMultiply', 'MaterialExpressionLinearInterpolate', 'Alpha'), inputs)
        self.assertIn(('recompile_material', result['material']), unreal.calls)

    def test_a_palette_sets_the_two_colours_and_a_second_call_rebuilds_the_same_material(self) -> None:
        tool('dirt_material', 'Mud', '')
        result = tool('dirt_material', 'Mud', '{"dark": [0.05, 0.04, 0.03], "light": [0.2, 0.18, 0.15]}')
        material = unreal.load_asset(result['material'])
        colors = sorted((c.props['constant'].r, c.props['constant'].g, c.props['constant'].b)
                        for c in self.expression(material, 'MaterialExpressionConstant3Vector'))
        self.assertEqual(colors, [(0.05, 0.04, 0.03), (0.2, 0.18, 0.15)])
        self.assertEqual(len([c for c in unreal.calls if c[0] == 'create_asset']), 1, 'made once, then rebuilt')
        self.assertIn(('delete_all_material_expressions', result['material']), unreal.calls)

    def test_another_kind_of_asset_at_the_materials_path_is_refused(self) -> None:
        unreal.state['assets'].add('/Game/Genex/Materials/M_Dirt')
        unreal.state['loaded']['/Game/Genex/Materials/M_Dirt'] = unreal.StaticMesh(Vector(), Vector(1, 1, 1))
        self.assert_unchanged(tool('dirt_material', 'Dirt', ''))


def mesh(triangles: int = 900) -> unreal.StaticMesh:
    return unreal.StaticMesh(Vector(-40, -30, 0), Vector(40, 30, 60), triangles)


class ImportModel(BuildCase):
    def setUp(self) -> None:
        super().setUp()
        self.model = self.write(os.path.join(self.game, 'assets', 'helpers', 'h1', 'bike.glb'), 'glTF')

    def imports(self, file: str, *assets: tuple[str, object]) -> None:
        unreal.state['imports'][file] = list(assets)

    def test_refuses_files_outside_the_games_assets_and_links_without_importing(self) -> None:
        assets = os.path.join(self.game, 'assets')
        outside = self.write(os.path.join(self.outside, 'evil.glb'), 'glTF')
        os.symlink(outside, os.path.join(assets, 'linked.glb'))
        os.symlink(self.outside, os.path.join(assets, 'linked_dir'))
        self.write(os.path.join(self.outside, 'inner.glb'), 'glTF')
        self.write(os.path.join(self.game, 'top.glb'), 'glTF')
        self.write(os.path.join(self.project, 'Content', 'x.glb'), 'glTF')
        self.write(os.path.join(assets, 'notes.txt'), 'hi')
        self.path('game', 'assets', 'folder.glb')
        with open(os.path.join(assets, 'huge.glb'), 'wb') as handle:
            handle.truncate(101 * MIB)
        files = {
            'outside the game': outside,
            'relative out of the game': '../outside/evil.glb',
            'dot-dot inside assets': 'assets/helpers/../../top.glb',
            'a link to a file outside': 'assets/linked.glb',
            'through a linked folder': 'assets/linked_dir/inner.glb',
            'in the game but not in assets': 'top.glb',
            'in the Unreal project': 'unreal/Content/x.glb',
            'not a model': 'assets/notes.txt',
            'a folder': 'assets/folder.glb',
            'missing': 'assets/nope.glb',
            'too large': 'assets/huge.glb',
            'empty': '',
            'a backslash': 'assets\\helpers\\h1\\bike.glb',
            'a NUL': 'assets/helpers/h1/bike.glb\0',
        }
        for label, file in files.items():
            with self.subTest(label):
                self.fresh()
                self.assert_unchanged(tool('import_model', file, '/Game/Genex/Models', 'Bike', 'box', True))
        for dest, name in (('/Engine/Models', 'Bike'), ('/Game/../Engine', 'Bike'), ('Game/Models', 'Bike'),
                           ('/Game/Genex/Models', 'Bi ke'), ('/Game/Genex/Models', '../Bike'), ('/Game/Genex/Models', '')):
            with self.subTest(dest=dest, name=name):
                self.fresh()
                self.assert_unchanged(tool('import_model', 'assets/helpers/h1/bike.glb', dest, name, 'box', True))

    def test_a_project_outside_a_game_folder_imports_nothing(self) -> None:
        unreal.reset(self.path('elsewhere', 'Drift'))
        unreal.state['actors'] = [self.start]
        self.assert_unchanged(tool('import_model', 'assets/helpers/h1/bike.glb', '/Game/Genex/Models', 'Bike', 'box', True))

    def test_a_model_imports_into_its_own_folder_as_one_mesh_with_its_collision_and_nanite(self) -> None:
        nested = '/Game/Genex/Models/Bike/bike/StaticMeshes/bike'
        self.imports(self.model, ('/Game/Genex/Models/Bike/bike/Materials/M_Paint', unreal.MaterialInstanceConstant()),
                     (nested, mesh()))
        result = tool('import_model', 'assets/helpers/h1/bike.glb', '/Game/Genex/Models', 'Bike', 'box', True)
        self.assertEqual({k: result[k] for k in ('asset', 'class', 'folder', 'fallbackTriangles', 'boundsCm', 'meshes')},
                         {'asset': nested, 'class': 'StaticMesh', 'folder': '/Game/Genex/Models/Bike',
                          'fallbackTriangles': 900, 'boundsCm': [80, 60, 60], 'meshes': 1})
        self.assertIsNone(result['sourceTriangles'], 'the stand-in file is no real glTF')
        [task] = unreal.state['import_tasks']
        self.assertEqual((task.filename, task.destination_path), (self.model, '/Game/Genex/Models/Bike'))
        [pipeline] = task.options.pipelines
        meshes = pipeline.get_editor_property('mesh_pipeline').props
        combine = (meshes['combine_static_meshes_behavior'], meshes['import_skeletal_meshes'], meshes['build_nanite'])
        self.assertEqual(combine, (unreal.InterchangeCombineStaticMeshesBehavior.ALL, False, True))
        self.assertIn(('nanite', f'{nested}.bike', True), unreal.calls)
        self.assertIn(('add_simple_collisions', f'{nested}.bike', 'BOX'), unreal.calls)
        console = [c[1][1] for c in unreal.calls if c[0] == 'console']
        self.assertIn('Interchange.FeatureFlags.Import.SyncToBrowser 0', console, 'the Content Browser stays shut')

    def test_the_games_own_absolute_path_is_taken_too(self) -> None:
        self.imports(self.model, ('/Game/Genex/Models/Bike/bike/StaticMeshes/bike', mesh()))
        self.assertEqual(tool('import_model', self.model, '/Game/Genex/Models', 'Bike', 'none', False)['class'], 'StaticMesh')

    def test_complex_collision_makes_the_mesh_walkable_on_its_own_triangles(self) -> None:
        made = mesh()
        self.imports(self.model, ('/Game/Genex/Models/Ramp/ramp/StaticMeshes/ramp', made))
        tool('import_model', 'assets/helpers/h1/bike.glb', '/Game/Genex/Models', 'Ramp', 'complex', False)
        flag = made.get_editor_property('body_setup').props['collision_trace_flag']
        self.assertEqual(flag, unreal.CollisionTraceFlag.CTF_USE_COMPLEX_AS_SIMPLE)

class ImportsDuringPlay(BuildCase):
    """An import during a play session makes only part of the asset (a Skeleton with no SkeletalMesh, a mesh with no
    triangles) and says nothing: every import and retarget is refused until play stops."""

    def test_every_import_and_retarget_is_refused_while_the_game_plays(self) -> None:
        unreal.state['pie'] = True
        calls = {
            'import_model': ('assets/helpers/h1/bike.glb', '/Game/Genex/Models', 'Bike', 'box', True),
            'import_character': ('assets/helpers/h1/goblin.glb', '/Game/Genex/Cast', 'Goblin'),
            'import_animation': ('assets/helpers/h1/run.glb', '/Game/Genex/Cast/Goblin/SK', '/Game/Genex/Cast', 'Run'),
            'import_sound': ('assets/helpers/h1/step.wav', '/Game/Genex/Sound', 'Step'),
            'retarget': ('/Game/A/SK_A', '/Game/B/SK_B', '["/Game/A/Run"]', '/Game/B/Anims'),
        }
        for name, args in calls.items():
            with self.subTest(name):
                result = tool(name, *args)
                self.assert_unchanged(result)
                self.assertIn('StopPIE', result['error'])


class AttachMesh(BuildCase):
    BLUEPRINT = '/Game/VehicleTemplate/Blueprints/OffroadCar/BP_OffroadCar'
    MESH = '/Game/Genex/Models/Bike/bike/StaticMeshes/SM_BikeFront'

    def setUp(self) -> None:
        super().setUp()
        self.camera = unreal.CameraComponent('FrontCamera')
        self.blueprint = unreal.Blueprint(components=[('DefaultSceneRoot', unreal.SceneComponent('DefaultSceneRoot')),
                                                      ('FrontCamera', self.camera)])
        self.front = mesh()
        unreal.state['loaded'].update({self.BLUEPRINT: self.blueprint, self.MESH: self.front,
                                       '/Game/Genex/Materials/M_Dirt': unreal.Material('/Game/Genex/Materials/M_Dirt')})

    def test_refuses_paths_parents_and_offsets_it_does_not_take_without_touching_the_blueprint(self) -> None:
        good = (self.BLUEPRINT, self.MESH, 'FrontCamera', '')
        cases = {
            'blueprint outside Game': ('/Engine/BP_Car', *good[1:]),
            'blueprint relative': ('Game/BP_Car', *good[1:]),
            'blueprint dot-dot': ('/Game/../BP_Car', *good[1:]),
            'blueprint missing': ('/Game/Nothing/BP_Car', *good[1:]),
            'blueprint is a mesh': (self.MESH, self.MESH, 'FrontCamera', ''),
            'mesh outside Game': (self.BLUEPRINT, '/Engine/BasicShapes/Cube', 'FrontCamera', ''),
            'mesh missing': (self.BLUEPRINT, '/Game/Nothing/SM_Front', 'FrontCamera', ''),
            'mesh is a material': (self.BLUEPRINT, '/Game/Genex/Materials/M_Dirt', 'FrontCamera', ''),
            'parent missing': (self.BLUEPRINT, self.MESH, 'RearCamera', ''),
            'parent a path': (self.BLUEPRINT, self.MESH, 'Front/Camera', ''),
            'offset not JSON': (*good[:3], 'up a bit'),
            'offset a list': (*good[:3], '[0, 0, 10]'),
            'offset unknown key': (*good[:3], '{"position": [0, 0, 10]}'),
            'offset two numbers': (*good[:3], '{"location": [0, 10]}'),
            'offset NaN': (*good[:3], '{"location": [0, NaN, 10]}'),
            'offset far away': (*good[:3], '{"location": [0, 0, 1e9]}'),
            'scale zero': (*good[:3], '{"scale": [0, 1, 1]}'),
            'scale negative': (*good[:3], '{"scale": [1, -1, 1]}'),
        }
        for label, args in cases.items():
            with self.subTest(label):
                self.fresh()
                self.assert_unchanged(tool('attach_mesh', *args))
                self.assertEqual(len(self.blueprint.components), 2)

    def test_refused_during_play(self) -> None:
        unreal.state['pie'] = True
        self.assert_unchanged(tool('attach_mesh', self.BLUEPRINT, self.MESH, 'FrontCamera', ''))

    def test_it_attaches_the_mesh_under_the_parent_with_its_offset_then_compiles_and_saves(self) -> None:
        offset = '{"location": [40, 0, -25], "rotation": [0, 90, 0], "scale": [0.5, 0.5, 0.5]}'
        result = tool('attach_mesh', self.BLUEPRINT, self.MESH, 'FrontCamera', offset)
        self.assertEqual(result, {'component': 'Genex_SM_BikeFront', 'parent': 'FrontCamera', 'compiled': True, 'saved': True})
        [(_name, component)] = [h for h in self.blueprint.components if h[0] == 'Genex_SM_BikeFront']
        self.assertIsInstance(component, unreal.StaticMeshComponent)
        self.assertIs(component.props['static_mesh'], self.front)
        self.assertEqual(component.props['attach_parent'], 'FrontCamera')
        location, rotation, scale = (component.props[k] for k in ('relative_location', 'relative_rotation', 'relative_scale3d'))
        self.assertEqual(((location.x, location.y, location.z), (rotation.pitch, rotation.yaw, rotation.roll),
                          (scale.x, scale.y, scale.z)), ((40, 0, -25), (0, 90, 0), (0.5, 0.5, 0.5)))
        self.assertIn(('compile', self.blueprint), unreal.calls)
        self.assertIn(('save_asset', self.blueprint.get_name()), unreal.calls)

    def test_attaching_again_reuses_the_component_and_no_parent_means_the_root(self) -> None:
        tool('attach_mesh', self.BLUEPRINT, self.MESH, '', '')
        again = tool('attach_mesh', self.BLUEPRINT, self.MESH, '', '{"location": [0, 0, 5]}')
        self.assertEqual((again['component'], again['parent']), ('Genex_SM_BikeFront', ''))
        self.assertEqual(len([c for c in unreal.calls if c[0] == 'add_subobject']), 1)


class RoutesAreRouteMath(BuildCase):
    def test_the_route_the_tools_read_back_is_the_one_set(self) -> None:
        tool('set_route', '[[0, 0, 0], [6000, 0, 0], [6000, 6000, 0]]', 0, True, 200.0)
        [actor] = self.tagged('GenexRoute')
        [spline] = actor.get_components_by_class(unreal.SplineComponent)
        route = route_math.make_route([(p.x, p.y) for p in spline.points], spline.is_closed_loop())
        self.assertAlmostEqual(route.length, 6000 + 6000 + math.hypot(6000, 6000))


if __name__ == '__main__':
    unittest.main()
