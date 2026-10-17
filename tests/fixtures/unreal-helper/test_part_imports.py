"""A part's apply.py imports a model, sound or texture from the game folder with genex.import_model,
genex.import_sound and genex.import_texture: into /Game/Parts/<Part>/Imported/<name>, answering the
asset to place. A path that isn't a plain file of the game (absolute, "..", a link anywhere on the
way, not a file, the wrong kind, too large) or a name that isn't an identifier is refused before
anything is imported; the refusal is apply.py's error, with its line."""

import os

import unreal

from support import HelperCase

MIB = 1024 * 1024
MESH = '/Game/Parts/Bike/Imported/Bike/model/StaticMeshes/Bike'
MATERIAL = '/Game/Parts/Bike/Imported/Bike/model/Materials/MI_Red'


def mesh() -> unreal.StaticMesh:
    return unreal.StaticMesh(unreal.Vector(-90, -40, 0), unreal.Vector(90, 40, 110))


class PartImports(HelperCase):
    def setUp(self) -> None:
        super().setUp()
        self.model = self.write(os.path.join(self.game, 'public', 'assets', 'blender', 'job1', 'model.glb'), 'glTF')
        self.sound = self.write(os.path.join(self.game, 'assets', 'hum.wav'), 'RIFF')
        self.texture = self.write(os.path.join(self.parts, 'Bike', 'decal.png'), 'PNG')
        self.evil = self.write(os.path.join(self.outside, 'evil.glb'), 'glTF')

    def imports(self, file: str, *assets: tuple[str, object]) -> None:
        """What Unreal makes from `file`: (object path without .Object, asset) rows, in import order."""
        unreal.state['imports'][file] = list(assets)

    def apply(self, script: str) -> dict:
        return self.call('apply_part', self.part('Bike', script), 'Bike')

    def imported(self) -> list[tuple]:
        return [call for call in unreal.calls if call[0] == 'import']

    def assert_refused_import(self, result: dict, why: str = '') -> None:
        """apply.py failed on its import line, and nothing was imported, placed or saved."""
        self.assertFalse(result['ok'], result)
        self.assertIn('Refused: genex.import_', result['error'])
        self.assertIn('(apply.py line 1)', result['error'], 'the builder is told where')
        self.assertIn(why, result['error'])
        self.assertEqual(self.imported(), [], 'a refused file was imported')
        self.assertNotIn('spawn', [call[0] for call in unreal.calls])
        self.assertNotIn(('save_current_level',), unreal.calls)


class Imports(PartImports):
    def test_a_model_blender_delivered_imports_into_the_parts_folder_and_answers_its_static_mesh(self) -> None:
        self.imports(self.model, (MATERIAL, unreal.MaterialInstanceConstant()), (MESH, mesh()))
        script = ('bike = genex.import_model("public/assets/blender/job1/model.glb", "Bike")\n'
                  'print("bike is", bike)\n'
                  'genex.place(bike, (0, 0, 0), "Bike_0")\n')
        result = self.apply(script)
        self.assertTrue(result['ok'], result)
        self.assertIn(f'bike is {MESH}\n', result['output'])
        [task] = unreal.state['import_tasks']
        self.assertEqual((task.filename, task.destination_path, task.destination_name), (self.model, '/Game/Parts/Bike/Imported/Bike', 'Bike'))
        self.assertTrue(task.replace_existing, 'applying the part again imports over the same assets')
        self.assertIn(('spawn', str(unreal.state['loaded'][MESH])), unreal.calls, 'the imported mesh is placed')
        self.assertEqual(result['actors'], ['Bike_0'])

    def test_a_model_in_the_parts_own_folder_imports_too(self) -> None:
        own = self.write(os.path.join(self.parts, 'Bike', 'Trophy.glb'), 'glTF')
        trophy = '/Game/Parts/Bike/Imported/Trophy/Trophy/StaticMeshes/Trophy'
        self.imports(own, (trophy, mesh()))
        result = self.apply('print(genex.import_model("unreal/parts/Bike/Trophy.glb", "Trophy"))\n')
        self.assertTrue(result['ok'], result)
        self.assertIn(trophy, result['output'])

    def test_a_sound_answers_its_sound_wave_and_a_texture_its_texture(self) -> None:
        self.imports(self.sound, ('/Game/Parts/Bike/Imported/Hum/Hum', unreal.SoundWave(2.5)))
        self.imports(self.texture, ('/Game/Parts/Bike/Imported/Decal/Decal', unreal.Texture2D(512, 256)))
        script = ('print(genex.import_sound("assets/hum.wav", "Hum"))\n'
                  'print(genex.import_texture("unreal/parts/Bike/decal.png", "Decal"))\n')
        result = self.apply(script)
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['output'], '/Game/Parts/Bike/Imported/Hum/Hum\n/Game/Parts/Bike/Imported/Decal/Decal\n')
        self.assertEqual([t.destination_path for t in unreal.state['import_tasks']],
                         ['/Game/Parts/Bike/Imported/Hum', '/Game/Parts/Bike/Imported/Decal'])

    def test_the_static_mesh_is_found_behind_more_materials_than_an_import_describes(self) -> None:
        materials = [(f'{MATERIAL}_{i}', unreal.MaterialInstanceConstant()) for i in range(20)]
        self.imports(self.model, *materials, (MESH, mesh()))
        result = self.apply('print(genex.import_model("public/assets/blender/job1/model.glb", "Bike"))\n')
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['output'], f'{MESH}\n')

    def test_a_model_that_imports_as_several_meshes_is_refused_with_how_to_join_it(self) -> None:
        wheel = '/Game/Parts/Bike/Imported/Bike/model/StaticMeshes/Wheel'
        self.imports(self.model, (MESH, mesh()), (wheel, mesh()))
        result = self.apply('genex.import_model("public/assets/blender/job1/model.glb", "Bike")\n')
        self.assertFalse(result['ok'])
        self.assertIn('2 static meshes', result['error'])
        self.assertIn('one mesh object', result['error'])
        self.assertIn('(apply.py line 1)', result['error'])

    def test_a_model_that_makes_no_static_mesh_is_refused(self) -> None:
        self.imports(self.model, (MATERIAL, unreal.MaterialInstanceConstant()))
        result = self.apply('genex.import_model("public/assets/blender/job1/model.glb", "Bike")\n')
        self.assertFalse(result['ok'])
        self.assertIn('no StaticMesh', result['error'])

    def test_a_file_at_the_size_cap_imports(self) -> None:
        exact = self.write(os.path.join(self.game, 'assets', 'long.wav'), '')
        os.truncate(exact, 20 * MIB)
        self.imports(exact, ('/Game/Parts/Bike/Imported/Long/Long', unreal.SoundWave(90.0)))
        result = self.apply('genex.import_sound("assets/long.wav", "Long")\n')
        self.assertTrue(result['ok'], result)


class Refusals(PartImports):
    def hostile_paths(self) -> dict[str, tuple[str, str, str]]:
        """label: (function, the path argument as Python source, what the refusal says)."""
        assets = os.path.join(self.game, 'assets')
        os.symlink(self.sound, os.path.join(assets, 'alias.wav'))
        os.symlink(self.evil, os.path.join(assets, 'out.glb'))
        os.symlink(self.outside, os.path.join(assets, 'linked'))
        os.symlink(assets, os.path.join(self.game, 'more'))
        os.makedirs(os.path.join(assets, 'dir.glb'))
        os.mkfifo(os.path.join(assets, 'pipe.wav'))
        self.write(os.path.join(assets, 'notes.txt'), 'notes')
        self.write(os.path.join(assets, 'model'), 'glTF')
        self.write(os.path.join(assets, 'decal.tga'), 'TGA')
        self.write(os.path.join(assets, 'model.glb.txt'), 'glTF')
        for name, size in (('huge.glb', 100 * MIB + 1), ('loud.wav', 20 * MIB + 1), ('big.png', 20 * MIB + 1)):
            os.truncate(self.write(os.path.join(assets, name), ''), size)
        model = 'genex.import_model'
        return {
            'None': (model, 'None', 'relative to the game folder'),
            'a number': (model, '5', 'relative to the game folder'),
            'bytes': (model, "b'public/assets/blender/job1/model.glb'", 'relative to the game folder'),
            'a list': (model, "['public/assets/blender/job1/model.glb']", 'relative to the game folder'),
            'empty': (model, "''", 'relative to the game folder'),
            'absolute, inside the game': (model, repr(self.model), 'relative to the game folder'),
            'absolute, elsewhere': (model, "'/etc/hosts'", 'relative to the game folder'),
            'up out of the game': (model, "'../outside/evil.glb'", '..'),
            'up and back in': (model, "'public/assets/../assets/blender/job1/model.glb'", '..'),
            'backslashes': (model, r"'public\\assets\\blender\\job1\\model.glb'", 'relative to the game folder'),
            'a NUL': (model, "'public/assets/blender/job1/model.glb\\0'", 'relative to the game folder'),
            'the game folder itself': (model, "'.'", 'no such file'),
            'a link to a file inside': ('genex.import_sound', "'assets/alias.wav'", 'link'),
            'a link to a file outside': (model, "'assets/out.glb'", 'link'),
            'through a linked folder outside': (model, "'assets/linked/evil.glb'", 'link'),
            'through a linked folder inside': ('genex.import_sound', "'more/hum.wav'", 'link'),
            'a folder': (model, "'assets/dir.glb'", 'no such file'),
            'a fifo': ('genex.import_sound', "'assets/pipe.wav'", 'no such file'),
            'a missing file': (model, "'assets/nope.glb'", 'no such file'),
            'a model that is text': (model, "'assets/notes.txt'", '.glb'),
            'a model without an extension': (model, "'assets/model'", '.glb'),
            'a model under a second extension': (model, "'assets/model.glb.txt'", '.glb'),
            'a sound as a model': (model, "'assets/hum.wav'", '.glb'),
            'a model as a sound': ('genex.import_sound', "'public/assets/blender/job1/model.glb'", '.wav'),
            'a texture of a kind it does not take': ('genex.import_texture', "'assets/decal.tga'", '.png'),
            'a model over 100 MB': (model, "'assets/huge.glb'", '100 MB'),
            'a sound over 20 MB': ('genex.import_sound', "'assets/loud.wav'", '20 MB'),
            'a texture over 20 MB': ('genex.import_texture', "'assets/big.png'", '20 MB'),
        }

    def test_refuses_every_hostile_path_before_importing_anything(self) -> None:
        for label, (function, path, why) in self.hostile_paths().items():
            with self.subTest(label):
                self.fresh()
                unreal.state['import_tasks'].clear()
                self.assert_refused_import(self.apply(f'{function}({path}, "Bike")\n'), why)
                self.assertEqual(os.listdir(self.outside), ['evil.glb'])

    def test_a_refusal_keeps_its_reason_whatever_the_path_is_like(self) -> None:
        result = self.apply(f'genex.import_model({"x/" * 400 + "model.glb"!r}, "Bike")\n')
        self.assert_refused_import(result, 'There is no such file.')

    def test_refuses_names_that_are_not_identifiers(self) -> None:
        self.imports(self.model, (MESH, mesh()))
        for name in ['None', "''", "'a/b'", "'../Bike'", "'Bike Model'", "'1Bike'", repr('A' * 65), "'Bike\\0'",
                     "'Bike.glb'", '5', "'_Bike'"]:
            with self.subTest(name=name):
                self.fresh()
                result = self.apply(f'genex.import_model("public/assets/blender/job1/model.glb", {name})\n')
                self.assert_refused_import(result, 'A name is a letter')

    def test_refuses_imports_for_a_part_outside_a_games_unreal_folder(self) -> None:
        loose = os.path.join(self.path('loose', 'parts', 'Bike'), 'apply.py')
        self.write(os.path.join(self.root, 'loose', 'assets', 'hum.wav'), 'RIFF')
        self.write(loose, 'genex.import_sound("assets/hum.wav", "Hum")\n')
        self.assert_refused_import(self.call('apply_part', loose, 'Bike'), 'unreal/parts')
