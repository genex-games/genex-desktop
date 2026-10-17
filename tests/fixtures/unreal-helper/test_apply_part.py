"""apply_part runs only a part's own apply.py, after checking its path, its name and its folder's
declaration; refused input never runs the script and never changes the editor."""

import json
import os

import unreal

from genex_loop import part_files
from support import MARKER_SCRIPT, HelperCase

LANTERN = {'title': 'Lantern', 'goal': 'Two lanterns light the yard.', 'blueprints': [
    {'name': 'BP_Lantern', 'base': 'Actor',
     'components': [{'name': 'Body', 'class': 'StaticMeshComponent'},
                    {'name': 'Light', 'class': 'PointLightComponent', 'parent': 'Body'}],
     'variables': [{'name': 'Flicker', 'type': 'float', 'category': 'Lantern'}],
     'functions': [{'name': 'Flash', 'inputs': [{'name': 'Strength', 'type': 'float'}], 'outputs': []}]}]}


class ScriptPaths(HelperCase):
    """Only <base>/parts/<part>/apply.py, with no link in its last three steps, may run."""

    def hostile_scripts(self) -> list[tuple[str, str, str]]:
        good = self.part('Lantern')
        elsewhere = self.write(os.path.join(self.outside, 'evil.py'), MARKER_SCRIPT.format(marker=self.marker))
        shaped = self.write(os.path.join(self.outside, 'parts', 'Shaped', 'apply.py'), MARKER_SCRIPT.format(marker=self.marker))
        os.makedirs(os.path.join(self.parts, 'Evil'))
        os.symlink(elsewhere, os.path.join(self.parts, 'Evil', 'apply.py'))
        os.makedirs(os.path.join(self.parts, 'Shaped'))
        os.symlink(shaped, os.path.join(self.parts, 'Shaped', 'apply.py'))
        os.symlink(os.path.dirname(shaped), os.path.join(self.parts, 'Linked'))
        os.makedirs(os.path.join(self.parts, 'Dir', 'apply.py'))
        os.makedirs(os.path.join(self.parts, 'Ghost'))
        self.write(os.path.join(self.parts, 'Lantern', 'run.py'), MARKER_SCRIPT.format(marker=self.marker))
        self.write(os.path.join(self.game, 'unreal', 'stuff', 'Lantern', 'apply.py'), MARKER_SCRIPT.format(marker=self.marker))
        return [
            ('relative', os.path.relpath(good), 'Lantern'),
            ('dot-dot', os.path.join(self.parts, 'Ghost', '..', 'Lantern', 'apply.py'), 'Lantern'),
            ('link to a file elsewhere', os.path.join(self.parts, 'Evil', 'apply.py'), 'Evil'),
            ('link to a part-shaped file elsewhere', os.path.join(self.parts, 'Shaped', 'apply.py'), 'Shaped'),
            ('linked part folder', os.path.join(self.parts, 'Linked', 'apply.py'), 'Linked'),
            ('wrong basename', os.path.join(self.parts, 'Lantern', 'run.py'), 'Lantern'),
            ('folder named for another part', good, 'Other'),
            ('no parts parent', os.path.join(self.game, 'unreal', 'stuff', 'Lantern', 'apply.py'), 'Lantern'),
            ('a directory', os.path.join(self.parts, 'Dir', 'apply.py'), 'Dir'),
            ('a missing file', os.path.join(self.parts, 'Ghost', 'apply.py'), 'Ghost'),
            ('empty', '', 'Lantern'),
        ]

    def test_refuses_every_hostile_script_path_without_running_it(self) -> None:
        for label, script, part in self.hostile_scripts():
            with self.subTest(label):
                self.fresh()
                self.assert_refused(self.call('apply_part', script, part))

    def test_refuses_part_names_that_are_paths_or_not_identifiers(self) -> None:
        good = self.part('Lantern')
        for part in ['a/b', '..', 'Lan tern', '', 'A' * 65, '1Lantern', 'Lantern\0', '_x', 'Lantern.py']:
            with self.subTest(part=part):
                self.fresh()
                self.assert_refused(self.call('apply_part', good, part))

    def test_a_64_character_name_is_a_part_name(self) -> None:
        name = 'A' * 64
        result = self.call('apply_part', self.part(name), name)
        self.assertTrue(result['ok'], result)


class Running(HelperCase):
    """What a part's script prints comes back, and its exceptions become results."""

    def test_returns_the_script_output_after_one_undo_step_and_a_save(self) -> None:
        result = self.call('apply_part', self.part('Lantern', 'print("hello from", part, genex.folder)\n'), 'Lantern')
        self.assertTrue(result['ok'], result)
        self.assertIn('hello from Lantern /Game/Parts/Lantern', result['output'])
        self.assertEqual(unreal.calls, [('transaction', 'Genex part Lantern'), ('save_current_level',)])

    def test_keeps_the_last_4_kib_of_output(self) -> None:
        result = self.call('apply_part', self.part('Lantern', 'print("x" * 9000)\nprint("end")\n'), 'Lantern')
        self.assertEqual(len(result['output']), 4096)
        self.assertTrue(result['output'].endswith('end\n'))

    def test_an_exception_becomes_a_failed_result_with_its_traceback(self) -> None:
        script = 'print("before")\n\ndef boom():\n    raise ValueError("no lantern mesh")\n\nboom()\n'
        result = self.call('apply_part', self.part('Lantern', script), 'Lantern')
        self.assertFalse(result['ok'])
        self.assertEqual(result['error'], 'ValueError: no lantern mesh (apply.py line 4)', 'the builder is told where')
        self.assertIn('apply.py", line 4, in boom', result['traceback'])
        self.assertNotIn('parts.py', result['traceback'], 'the helper\'s own frame is left out')
        self.assertIn('before', result['output'])
        self.assertNotIn(('save_current_level',), unreal.calls, 'a failed part is not saved')

    def test_a_syntax_error_is_a_failed_result(self) -> None:
        result = self.call('apply_part', self.part('Lantern', 'def broken(:\n'), 'Lantern')
        self.assertFalse(result['ok'])
        self.assertTrue(result['error'].startswith('SyntaxError'))

    def test_placed_actors_carry_the_part_tag_folder_and_label(self) -> None:
        script = 'genex.place("/Game/Parts/Lantern/BP_Lantern", (300, -200, 50), "Lantern_0")\n' \
                 'genex.place("/Game/Parts/Lantern/BP_Lantern", (300, 200, 50), "Lantern_0")\n'
        result = self.call('apply_part', self.part('Lantern', script), 'Lantern')
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['actors'], ['Lantern_0'], 'a second place with the same label replaces the first')
        actor = unreal.state['actors'][0]
        self.assertEqual([str(t) for t in actor.tags], ['GenexPart:Lantern'])
        self.assertEqual(actor.folder, 'Parts/Lantern')

    def test_refuses_while_a_play_session_runs(self) -> None:
        unreal.state['pie'] = True
        self.assert_refused(self.call('apply_part', self.part('Lantern'), 'Lantern'))


class Declaration(HelperCase):
    """part.json and the Blueprint text are checked before the editor changes."""

    def apply_with(self, files: dict[str, str]) -> dict:
        return self.call('apply_part', self.part('Lantern', files=files), 'Lantern')

    def test_refuses_hostile_declarations_without_running_anything(self) -> None:
        def blueprint(**fields) -> str:
            return json.dumps({'blueprints': [{'name': 'BP_Lantern', 'base': 'Actor', **fields}]})
        cases = {
            'not an object': '[1, 2]',
            'not JSON': '{"blueprints": [',
            'blueprints not a list': '{"blueprints": {"name": "BP_Lantern"}}',
            'a Blueprint not an object': '{"blueprints": ["BP_Lantern"]}',
            'unknown base': blueprint(base='Object'),
            'base given as a path': blueprint(base='/Script/Engine.Actor'),
            'name with a path': json.dumps({'blueprints': [{'name': '../BP_Evil', 'base': 'Actor'}]}),
            'name with a slash': json.dumps({'blueprints': [{'name': 'Parts/BP_Evil', 'base': 'Actor'}]}),
            'name with a space': json.dumps({'blueprints': [{'name': 'BP Lantern', 'base': 'Actor'}]}),
            'component class with a path': blueprint(components=[{'name': 'Body', 'class': '/Script/Engine.StaticMeshComponent'}]),
            'component name with a space': blueprint(components=[{'name': 'My Body', 'class': 'StaticMeshComponent'}]),
            'parent not a component': blueprint(components=[{'name': 'Light', 'class': 'PointLightComponent', 'parent': 'Body'}]),
            'variable without a type': blueprint(variables=[{'name': 'Flicker'}]),
            'function input name with a path': blueprint(functions=[{'name': 'Flash', 'inputs': [{'name': 'a/b', 'type': 'float'}]}]),
            'declared twice': json.dumps({'blueprints': [{'name': 'BP_A', 'base': 'Actor'}] * 2}),
            'thirteen Blueprints': json.dumps({'blueprints': [{'name': f'BP_{i}', 'base': 'Actor'} for i in range(13)]}),
        }
        for label, manifest in cases.items():
            with self.subTest(label):
                self.fresh()
                self.assert_refused(self.apply_with({'part.json': manifest}))

    def test_refuses_a_declaration_or_blueprint_text_that_links_out_of_the_folder(self) -> None:
        outside_json = self.write(os.path.join(self.outside, 'part.json'), json.dumps(LANTERN))
        outside_dsl = self.write(os.path.join(self.outside, 'BP_Lantern.dsl'), '(event ReceiveBeginPlay)')
        script = self.part('Lantern')
        os.symlink(outside_json, os.path.join(self.parts, 'Lantern', 'part.json'))
        self.assert_refused(self.call('apply_part', script, 'Lantern'))
        os.remove(os.path.join(self.parts, 'Lantern', 'part.json'))
        self.write(os.path.join(self.parts, 'Lantern', 'part.json'), json.dumps(LANTERN))
        os.symlink(outside_dsl, os.path.join(self.parts, 'Lantern', 'BP_Lantern.dsl'))
        self.fresh()
        self.assert_refused(self.call('apply_part', script, 'Lantern'))

    def test_refuses_blueprint_text_that_does_not_parse(self) -> None:
        for text in ['(event ReceiveBeginPlay', '(event ReceiveBeginPlay))', '(event Tick (PrintString "open)']:
            with self.subTest(text):
                self.fresh()
                self.assert_refused(self.apply_with({'part.json': json.dumps(LANTERN), 'BP_Lantern.dsl': text}))

    def test_a_blueprint_that_fails_to_build_stops_apply_py(self) -> None:
        unreal.state['create_fails'] = True
        result = self.apply_with({'part.json': json.dumps(LANTERN)})
        self.assertFalse(result['ok'])
        self.assertEqual(result['blueprints'][0]['name'], 'BP_Lantern')
        self.assertFalse(result['blueprints'][0]['compiled'])
        self.assertEqual(result['blueprints'][0]['messages'], ['RuntimeError: Could not create Blueprint BP_Lantern\n  in: create'])
        self.assertIn('Could not create Blueprint BP_Lantern', result['error'], 'the builder is told why, not only which')
        self.assertNotIn('script_error', [call[0] for call in unreal.calls], 'an Epic tool error would fail the whole call')
        self.assertFalse(os.path.exists(self.marker), 'apply.py ran after a Blueprint failed')
        self.assertNotIn(('save_current_level',), unreal.calls)

    def test_builds_declared_blueprints_then_runs_apply_py(self) -> None:
        manifest = json.dumps({'title': 'Sign', 'goal': 'A sign', 'blueprints': [{'name': 'BP_Sign', 'base': 'Actor'}]})
        result = self.apply_with({'part.json': manifest})
        self.assertTrue(result['ok'], result)
        self.assertEqual(result['blueprints'], [{'name': 'BP_Sign', 'compiled': True, 'messages': []}])
        self.assertIn(('create_blueprint', '/Game/Parts/Lantern/BP_Sign', '/Script/Engine.Actor'), unreal.calls)
        self.assertTrue(os.path.exists(self.marker))

    def cpp_part(self, parent: str) -> dict:
        """Applies a part whose Blueprint is made from its C++ class LanternLight, in the module Rush."""
        os.makedirs(os.path.join(self.project, 'Source', 'Rush', 'Parts', 'Lantern'))
        manifest = json.dumps({'title': 'Lantern', 'goal': '', 'cpp': ['LanternLight'],
                               'blueprints': [{'name': 'BP_Lantern', 'parent': parent}]})
        return self.apply_with({'part.json': manifest})

    def test_builds_a_blueprint_from_the_parts_own_cpp_class(self) -> None:
        unreal.state['classes']['/Script/Rush.LanternLight'] = unreal.Class(unreal.Actor, '/Script/Rush.LanternLight')
        result = self.cpp_part('ALanternLight')
        self.assertTrue(result['ok'], result)
        self.assertIn(('create_blueprint', '/Game/Parts/Lantern/BP_Lantern', '/Script/Rush.LanternLight'), unreal.calls)
        self.assertTrue(os.path.exists(self.marker))

    def test_a_cpp_parent_the_editor_has_not_loaded_stops_apply_py(self) -> None:
        result = self.cpp_part('LanternLight')
        self.assertFalse(result['ok'])
        self.assertIn('recompile_module', result['blueprints'][0]['messages'][0])
        self.assertNotIn('create_blueprint', [call[0] for call in unreal.calls])
        self.assertFalse(os.path.exists(self.marker), 'apply.py ran without its Blueprint')

    def test_reads_the_declaration_and_splits_blueprint_text_by_graph(self) -> None:
        text = ('; lantern\n(event ReceiveBeginPlay (Flash 1.0))\n'
                '(fn Flash (Strength) (PrintString "(fn not a form)"))\n'
                '(event ReceiveTick (DeltaSeconds) (Equal(==) 1 1))\n')
        script = self.part('Lantern', files={'part.json': json.dumps(LANTERN), 'BP_Lantern.dsl': text})
        files = part_files.load(script, 'Lantern')
        self.assertEqual((files.title, files.goal), ('Lantern', 'Two lanterns light the yard.'))
        [lantern] = files.blueprints
        self.assertEqual(lantern.components[1], {'name': 'Light', 'class': 'PointLightComponent', 'parent': 'Body'})
        self.assertEqual(lantern.variables, [{'name': 'Flicker', 'type': 'float', 'category': 'Lantern'}])
        self.assertEqual([p.name for p in lantern.functions[0].inputs], ['Strength'])
        self.assertEqual(lantern.graphs, [
            ('EventGraph', '(event ReceiveBeginPlay (Flash 1.0))\n\n(event ReceiveTick (DeltaSeconds) (Equal(==) 1 1))'),
            ('Flash', '(fn Flash (Strength) (PrintString "(fn not a form)"))'),
        ])

    def test_a_part_without_part_json_declares_nothing(self) -> None:
        files = part_files.load(self.part('Lantern'), 'Lantern')
        self.assertEqual(files.blueprints, [])


class Rollback(HelperCase):
    def test_destroys_the_part_actors_saves_and_deletes_its_folder(self) -> None:
        lantern, floor = unreal.Actor('Lantern_0'), unreal.Actor('Floor')
        lantern.tags = [unreal.Name('GenexPart:Lantern')]
        unreal.state['actors'] = [lantern, floor]
        unreal.state['dirs'].add('/Game/Parts/Lantern')
        result = self.call('rollback_part', 'Lantern')
        self.assertEqual((result['removed'], result['deletedFolder']), (['Lantern_0'], True))
        self.assertEqual(unreal.calls, [('destroy_actor', 'Lantern_0'), ('save_current_level',),
                                        ('delete_directory', '/Game/Parts/Lantern')])
        self.assertEqual(unreal.state['actors'], [floor])

    def test_leaves_the_level_file_alone_when_the_part_placed_nothing(self) -> None:
        unreal.state['dirs'].add('/Game/Parts/Props')
        self.call('rollback_part', 'Props')
        self.assertEqual(unreal.calls, [('delete_directory', '/Game/Parts/Props')])

    def test_refuses_part_names_that_are_paths(self) -> None:
        for part in ['../Lantern', 'Parts/Lantern', '']:
            with self.subTest(part=part):
                self.fresh()
                self.assert_refused(self.call('rollback_part', part))
