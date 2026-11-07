"""motion_character (genex_build.tools.GenexBuildTools) gives an imported character the Game Animation
Sample's Motion Matching the sample's own way: a retargeter from the sample's mannequin, its entry in
ABP_GenericRetarget's map, and a child of the sample's character whose mannequin is hidden (in the
editor and in game) but still poses and whose Body mesh shows the character. Without the sample's
content, during play, or for a bad name it is refused and nothing in the editor changes.

A motion character an older helper made has its mannequin hidden only in the editor, and the sample's
character shows it again in play; hide_old_drivers, run once the editor has its level, hides it in
game too, checking each character once."""

import json
import os
import unittest
from unittest import mock

import unreal

import skeletons
from genex_build import motion
from genex_build.tools import GenexBuildTools

from support import HelperCase

HERO = '/Game/Cast/Hero/SK_Hero'


def tool(name: str, *args) -> dict:
    return json.loads(getattr(GenexBuildTools, name)(*args))


def sample_content(retargeters: dict | None = None) -> unreal.AnimBlueprint:
    """The sample's mannequin, its ABP_GenericRetarget (with the entries it ships) and its character."""
    skeletons.character(motion.SAMPLE_MESH, bind=skeletons.pose(arm_out=45.0, elbow=10.0))
    shipped = retargeters if retargeters is not None else {'RTG_UEFN_to_UE5_Mannequin': unreal.IKRetargeter()}
    abp_class = unreal.Class(path=f'{motion.SAMPLE_ABP}.ABP_GenericRetarget_C',
                             cdo=unreal._Defaults(**{motion.MAP_VARIABLE: dict(shipped)}))
    abp = unreal.AnimBlueprint(generated=abp_class, name='ABP_GenericRetarget')
    defaults = unreal._Defaults()
    defaults.components = [('Mesh', unreal.SkeletalMeshComponent('Mesh'))]
    character = unreal.Blueprint(generated=unreal.Class(path=f'{motion.SAMPLE_CHARACTER}.SandboxCharacter_CMC_C',
                                                        cdo=defaults), name='SandboxCharacter_CMC')
    unreal.state['loaded'].update({motion.SAMPLE_ABP: abp, motion.SAMPLE_CHARACTER: character})
    return abp


class MotionCharacter(HelperCase):
    def setUp(self) -> None:
        super().setUp()
        self.hero = skeletons.character(HERO)

    def components(self, blueprint_path: str) -> dict:
        return {name: component for name, component in unreal.state['loaded'][blueprint_path].components}

    def test_the_character_is_shown_on_the_samples_character_copying_its_hidden_mannequin(self) -> None:
        abp = sample_content()
        result = tool('motion_character', HERO, 'Hero')
        self.assertNotIn('error', result, result)
        self.assertEqual(result['blueprint'], '/Game/GX/Characters/BP_Hero')
        self.assertEqual(result['tag'], 'RTG_SKM_UEFN_Mannequin_to_SK_Hero')
        self.assertIn(('create_blueprint', '/Game/GX/Characters/BP_Hero', 'SandboxCharacter_CMC_C'), unreal.calls)
        parts = self.components('/Game/GX/Characters/BP_Hero')
        driver, body = parts['Mesh'], parts['Body']
        self.assertFalse(driver.props['visible'], 'the mannequin is hidden')
        self.assertTrue(driver.props.get('hidden_in_game'),
                        'hidden in game too: the sample\'s character makes its mesh visible again as play starts')
        self.assertEqual(driver.props['visibility_based_anim_tick_option'].name, 'ALWAYS_TICK_POSE_AND_REFRESH_BONES')
        self.assertEqual(body.props['attach_parent'], 'Mesh', 'the Body follows the mannequin')
        self.assertIs(body.props['skeletal_mesh_asset'], self.hero)
        self.assertEqual(body.props['animation_mode'].name, 'ANIMATION_BLUEPRINT')
        self.assertIs(body.props['anim_class'], abp.generated_class())
        self.assertEqual(body.props['component_tags'], [result['tag']])
        self.assertIn('put props on Body', result['meshes'], 'the answer says which mesh is which')
        entries = abp.generated_class().cdo.props[motion.MAP_VARIABLE]
        self.assertEqual(sorted(entries), ['RTG_SKM_UEFN_Mannequin_to_SK_Hero', 'RTG_UEFN_to_UE5_Mannequin'],
                         'the shipped entries stay')
        self.assertEqual(result['ikOff'], ['LeftArm', 'RightArm'], 'the retargeter is set up as retarget sets one')
        self.assertIn(('save_asset', 'ABP_GenericRetarget'), unreal.calls)
        self.assertIn(('save_asset', 'BP_Hero'), unreal.calls)

    def test_calling_it_again_updates_the_same_blueprint_and_map_entry(self) -> None:
        abp = sample_content()
        first = tool('motion_character', HERO, 'Hero')
        unreal.calls.clear()
        second = tool('motion_character', HERO, 'Hero')
        self.assertEqual(second['blueprint'], first['blueprint'])
        self.assertNotIn('create_blueprint', [call[0] for call in unreal.calls])
        self.assertEqual(sorted(self.components(first['blueprint'])), ['Body', 'Mesh'])
        self.assertEqual(len(abp.generated_class().cdo.props[motion.MAP_VARIABLE]), 2)

    def test_a_project_without_the_samples_content_is_refused_naming_what_is_missing(self) -> None:
        result = tool('motion_character', HERO, 'Hero')
        self.assertIn('Game Animation Sample', result['error'])
        self.assertIn(motion.SAMPLE_ABP, result['error'])
        self.assertIn('add-motion-matching', result['error'])
        self.assertEqual(unreal.calls, [], 'nothing in the editor changed')

    def test_input_it_does_not_take_is_refused_without_changing_anything(self) -> None:
        sample_content()
        for mesh, name in ((HERO, ''), (HERO, '1Hero'), (HERO, 'Hero Guard'), (HERO, 'x' * 49),
                           ('/Game/Cast/Missing/SK_Nobody', 'Hero'), ('C:/Hero', 'Hero')):
            with self.subTest(mesh=mesh, name=name):
                unreal.calls.clear()
                result = tool('motion_character', mesh, name)
                self.assertIn('error', result)
                self.assertEqual(unreal.calls, [])

    def test_refused_during_play(self) -> None:
        sample_content()
        unreal.state['pie'] = True
        result = tool('motion_character', HERO, 'Hero')
        self.assertIn('error', result)
        self.assertEqual(unreal.calls, [])


OLD = '/Game/GX/Characters/BP_Duel'


class OlderHelpersCharacters(HelperCase):
    """Motion characters an older helper made, in the project's Content/GX/Characters."""

    def setUp(self) -> None:
        super().setUp()
        self.characters = self.path('game', 'unreal', 'Content', 'GX', 'Characters')
        self.record = os.path.join(self.project, 'Saved', 'Genex', motion.CHECKED_RECORD)

    def character(self, path: str = OLD, body: bool = True, **driver) -> tuple:
        """A Blueprint file and its loaded Blueprint: Mesh hidden only in the editor (as an older helper
        left it, unless `driver` says otherwise) and a Body; (blueprint, mesh, body)."""
        name = path.rsplit('/', 1)[-1]
        self.write(os.path.join(self.characters, f'{name}.uasset'), 'uasset')
        mesh = unreal.SkeletalMeshComponent('Mesh')
        for prop, value in {'visible': False, **driver}.items():
            mesh.set_editor_property(prop, value)
        shown = unreal.SkeletalMeshComponent('Body')
        components = [('Mesh', mesh)] + ([('Body', shown)] if body else [])
        blueprint = unreal.Blueprint(components, name=name,
                                     generated=unreal.Class(path=f'{path}.{name}_C', cdo=unreal._Defaults()))
        unreal.state['loaded'][path] = blueprint
        return blueprint, mesh, shown

    def changed(self) -> list:
        return [call for call in unreal.calls if call[0] in ('compile', 'save_asset')]

    def test_an_older_helpers_mannequin_is_hidden_in_game_and_the_blueprint_saved(self) -> None:
        blueprint, mesh, body = self.character()
        body_before = dict(body.props)
        self.assertEqual(motion.hide_old_drivers(), [OLD])
        self.assertTrue(mesh.props['hidden_in_game'])
        self.assertFalse(mesh.props['visible'])
        self.assertEqual(mesh.props['visibility_based_anim_tick_option'].name, 'ALWAYS_TICK_POSE_AND_REFRESH_BONES',
                         'it still poses every frame for the Body to copy')
        self.assertEqual(body.props, body_before, 'the Body is left as it is')
        self.assertEqual(self.changed(), [('compile', blueprint), ('save_asset', 'BP_Duel')])

    def test_each_character_is_loaded_and_checked_once(self) -> None:
        self.character()
        motion.hide_old_drivers()
        with mock.patch.object(unreal, 'load_asset', wraps=unreal.load_asset) as load:
            unreal.calls.clear()
            self.assertEqual(motion.hide_old_drivers(), [])
            self.assertEqual(load.call_count, 0, 'a checked character is not loaded again')
            self.assertEqual(self.changed(), [])
            _blueprint, later, _body = self.character('/Game/GX/Characters/BP_Ronin')
            self.assertEqual(motion.hide_old_drivers(), ['/Game/GX/Characters/BP_Ronin'],
                             'one added later is checked at the next start')
            self.assertEqual([call.args for call in load.call_args_list], [('/Game/GX/Characters/BP_Ronin',)])
        self.assertTrue(later.props['hidden_in_game'])
        with open(self.record, encoding='utf-8') as file:
            self.assertEqual(json.load(file), {'checked': ['BP_Duel', 'BP_Ronin']})

    def test_characters_it_did_not_make_that_way_are_left_as_they_are(self) -> None:
        cases = {
            'mannequin made visible again': {'visible': True},
            'already hidden in game': {'hidden_in_game': True},
            'no Body': {'body': False},
        }
        for case, setup in cases.items():
            with self.subTest(case):
                unreal.calls.clear()
                body = setup.pop('body', True)
                path = f'/Game/GX/Characters/BP_{case.split()[0].title()}{len(unreal.state["loaded"])}'
                _blueprint, mesh, _shown = self.character(path, body=body, **setup)
                before = dict(mesh.props)
                self.assertEqual(motion.hide_old_drivers(), [])
                self.assertEqual(mesh.props, before)
                self.assertEqual(self.changed(), [])

    def test_files_that_are_not_a_characters_blueprint_are_never_loaded(self) -> None:
        for file in ('Hero.uasset', 'BP_9Lives.uasset', 'BP_Duel.uasset.bak', 'BP_Duel.umap', 'BP_.uasset',
                     'bp_duel.uasset', f'BP_{"x" * 49}.uasset'):
            self.write(os.path.join(self.characters, file), 'x')
        self.write(os.path.join(self.characters, 'Nested', 'BP_Deep.uasset'), 'x')
        with mock.patch.object(unreal, 'load_asset', wraps=unreal.load_asset) as load:
            self.assertEqual(motion.hide_old_drivers(), [])
        self.assertEqual(load.call_count, 0)
        self.assertEqual(self.changed(), [])

    def test_an_asset_that_is_not_a_blueprint_is_left_and_checked(self) -> None:
        self.write(os.path.join(self.characters, 'BP_Statue.uasset'), 'x')
        unreal.state['loaded']['/Game/GX/Characters/BP_Statue'] = unreal.SkeletalMesh()
        self.assertEqual(motion.hide_old_drivers(), [])
        self.assertEqual(self.changed(), [])
        with open(self.record, encoding='utf-8') as file:
            self.assertEqual(json.load(file), {'checked': ['BP_Statue']})

    def test_one_that_did_not_load_or_save_is_tried_again_at_the_next_start(self) -> None:
        self.write(os.path.join(self.characters, 'BP_Duel.uasset'), 'x')
        self.assertEqual(motion.hide_old_drivers(), [], 'not loadable yet')
        self.character()
        with mock.patch.object(unreal.EditorAssetLibrary, 'save_loaded_asset', return_value=False):
            self.assertEqual(motion.hide_old_drivers(), [], 'Unreal did not save it')
        _blueprint, mesh, _body = self.character()  # the next start loads it from the disk again
        self.assertEqual(motion.hide_old_drivers(), [OLD])
        self.assertTrue(mesh.props['hidden_in_game'])

    def test_the_levels_placed_copies_hide_their_mannequin_too_without_saving_the_level(self) -> None:
        blueprint, _mesh, _body = self.character()
        placed = []
        for label, driver in (('Duel_0', {'visible': False}), ('Duel_1', {'visible': True})):
            mesh = unreal.SkeletalMeshComponent('CharacterMesh0')
            for prop, value in driver.items():
                mesh.set_editor_property(prop, value)
            actor = unreal.Character(label, mesh=mesh)
            actor.get_class = blueprint.generated_class
            placed.append(mesh)
            unreal.state['actors'].append(actor)
        other = unreal.SkeletalMeshComponent('CharacterMesh0')
        other.set_editor_property('visible', False)
        unreal.state['actors'].append(unreal.Character('Guard_0', mesh=other))
        not_a_character = unreal.Actor('Statue_0')
        not_a_character.get_class = blueprint.generated_class
        unreal.state['actors'].append(not_a_character)
        self.assertEqual(motion.hide_old_drivers(), [OLD])
        self.assertTrue(placed[0].props['hidden_in_game'], 'a copy as an older helper left it')
        self.assertNotIn('hidden_in_game', placed[1].props, 'a copy someone made visible stays')
        self.assertNotIn('hidden_in_game', other.props, 'another class\'s actor stays')
        self.assertNotIn('save_current_level', [call[0] for call in unreal.calls])

    def test_one_without_its_mannequin_while_the_sample_is_missing_is_tried_again_with_a_warning(self) -> None:
        """The sample's content is kept out of checkpoints, so a game copied elsewhere can lack it."""
        blueprint, mesh, _body = self.character()
        blueprint.components = [component for component in blueprint.components if component[0] != 'Mesh']
        with mock.patch.object(unreal, 'log_warning') as warn:
            self.assertEqual(motion.hide_old_drivers(), [])
        self.assertIn('BP_Duel', warn.call_args.args[0])
        blueprint.components.insert(0, ('Mesh', mesh))
        self.assertEqual(motion.hide_old_drivers(), [OLD])

    def test_a_blueprint_with_no_mannequin_while_the_sample_is_there_is_checked_once(self) -> None:
        sample_content()
        blueprint, _mesh, _body = self.character()
        blueprint.components = [component for component in blueprint.components if component[0] != 'Mesh']
        self.assertEqual(motion.hide_old_drivers(), [])
        with mock.patch.object(unreal, 'load_asset', wraps=unreal.load_asset) as load:
            self.assertEqual(motion.hide_old_drivers(), [])
        self.assertEqual(load.call_count, 0)

    def test_one_that_does_not_compile_is_not_saved_and_is_tried_again(self) -> None:
        self.character()
        with mock.patch.object(motion.blueprints, 'compile_status', return_value=(False, ['EventGraph: bad'])):
            self.assertEqual(motion.hide_old_drivers(), [])
        self.assertNotIn('save_asset', [call[0] for call in unreal.calls])
        self.character()
        self.assertEqual(motion.hide_old_drivers(), [OLD])

    def test_nothing_changes_during_play(self) -> None:
        _blueprint, mesh, _body = self.character()
        unreal.state['pie'] = True
        self.assertEqual(motion.hide_old_drivers(), [])
        self.assertNotIn('hidden_in_game', mesh.props)
        self.assertEqual(self.changed(), [])
        self.assertFalse(os.path.lexists(self.record))

    def test_a_project_without_motion_characters_writes_nothing(self) -> None:
        os.rmdir(self.characters)
        self.assertEqual(motion.hide_old_drivers(), [])
        self.assertFalse(os.path.lexists(os.path.join(self.project, 'Saved')))

    def test_a_record_that_leads_out_of_saved_genex_is_refused_before_anything_changes(self) -> None:
        outside = self.write(os.path.join(self.outside, 'record.json'), 'keep')
        os.makedirs(os.path.dirname(self.record), exist_ok=True)
        hostile = {
            'a link to a file outside': lambda: os.symlink(outside, self.record),
            'a link to the folder outside': lambda: os.symlink(self.outside, self.record),
            'a folder': lambda: os.mkdir(self.record),
        }
        for case, make in hostile.items():
            with self.subTest(case):
                unreal.calls.clear()
                _blueprint, mesh, _body = self.character()
                make()
                try:
                    with self.assertRaises(motion.Refused):
                        motion.hide_old_drivers()
                    self.assertNotIn('hidden_in_game', mesh.props)
                    self.assertEqual(self.changed(), [])
                    with open(outside, encoding='utf-8') as file:
                        self.assertEqual(file.read(), 'keep')
                finally:
                    (os.rmdir if os.path.isdir(self.record) and not os.path.islink(self.record) else os.remove)(self.record)

    def test_a_record_that_could_not_be_put_in_place_leaves_no_file_behind(self) -> None:
        self.character()
        with mock.patch.object(motion.os, 'replace', side_effect=PermissionError('in use')):
            with self.assertRaises(PermissionError):
                motion.hide_old_drivers()
        self.assertEqual(os.listdir(os.path.dirname(self.record)), [])

    def test_an_unreadable_record_checks_every_character_again(self) -> None:
        for text in ('{not json', '{"checked": null}', '{"checked": 5}', '[]', '"BP_Duel"', '{"checked": [7]}'):
            with self.subTest(text):
                _blueprint, mesh, _body = self.character()
                self.write(self.record, text)
                self.assertEqual(motion.hide_old_drivers(), [OLD])
                self.assertTrue(mesh.props['hidden_in_game'])

    def test_soon_runs_on_an_editor_frame_and_a_failure_is_logged_not_raised(self) -> None:
        _blueprint, mesh, _body = self.character()
        motion.hide_old_drivers_soon()
        self.assertNotIn('hidden_in_game', mesh.props, 'nothing changes as the helper loads')
        with mock.patch.object(unreal, 'log') as log:
            for callback in list(unreal.state['ticks'].values()):
                callback(0.016)
        self.assertTrue(mesh.props['hidden_in_game'])
        self.assertIn(OLD, log.call_args.args[0])
        self.assertEqual(unreal.state['ticks'], {}, 'nothing left ticking')
        self.character('/Game/GX/Characters/BP_Broken')
        motion.hide_old_drivers_soon()
        with mock.patch.object(unreal, 'load_asset', side_effect=RuntimeError('LoadPackage failed')), \
                mock.patch.object(unreal, 'log_warning') as warn:
            for callback in list(unreal.state['ticks'].values()):
                callback(0.016)
        self.assertIn('LoadPackage failed', warn.call_args.args[0])
        self.assertEqual(unreal.state['ticks'], {})

    def test_soon_runs_once_even_when_a_save_ticks_the_editor_again(self) -> None:
        self.character()
        motion.hide_old_drivers_soon()
        runs = []
        real = motion.hide_old_drivers

        def saving_ticks_again() -> list:
            runs.append(True)
            for callback in list(unreal.state['ticks'].values()):
                callback(0.016)
            return real()

        with mock.patch.object(motion, 'hide_old_drivers', side_effect=saving_ticks_again):
            for callback in list(unreal.state['ticks'].values()):
                callback(0.016)
        self.assertEqual(len(runs), 1)
        self.assertEqual(unreal.state['ticks'], {})


if __name__ == '__main__':
    unittest.main()
