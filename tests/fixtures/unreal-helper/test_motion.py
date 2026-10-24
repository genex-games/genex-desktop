"""motion_character (genex_build.tools.GenexBuildTools) gives an imported character the Game Animation
Sample's Motion Matching the sample's own way: a retargeter from the sample's mannequin, its entry in
ABP_GenericRetarget's map, and a child of the sample's character whose mannequin is hidden but still
poses and whose Body mesh shows the character. Without the sample's content, during play, or for a bad
name it is refused and nothing in the editor changes."""

import json
import unittest

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
        self.assertEqual(driver.props['visibility_based_anim_tick_option'].name, 'ALWAYS_TICK_POSE_AND_REFRESH_BONES')
        self.assertEqual(body.props['attach_parent'], 'Mesh', 'the Body follows the mannequin')
        self.assertIs(body.props['skeletal_mesh_asset'], self.hero)
        self.assertEqual(body.props['animation_mode'].name, 'ANIMATION_BLUEPRINT')
        self.assertIs(body.props['anim_class'], abp.generated_class())
        self.assertEqual(body.props['component_tags'], [result['tag']])
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


if __name__ == '__main__':
    unittest.main()
