"""export_project writes what a game's template is made of — its level, the game mode and the pawn it
spawns, the project's own Blueprints (native parent, components, variables) and input actions —
into Saved/Genex for the builders, leaving out the parts' own and the reference's throwaway
Blueprints; it refuses any file outside Saved/Genex, and changes nothing in the editor."""

import json
import os
from unittest import mock

import unreal

from genex_loop import editor
from support import HelperCase

BLUEPRINTS = '/Game/VehicleTemplate/Blueprints'
MODE_CLASS = f'{BLUEPRINTS}/BP_VehicleAdvGameMode.BP_VehicleAdvGameMode_C'
CAR_CLASS = f'{BLUEPRINTS}/OffroadCar/BP_VehicleAdvOffroadCar.BP_VehicleAdvOffroadCar_C'
# The file export_project writes for the scene below, exactly.
SHARED_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'project-facts.json')


def pin(category: str, sub_object: str = 'None', container: str = 'None') -> str:
    """A pin type's export text, as Unreal writes it."""
    return (f'(PinCategory="{category}",PinSubCategory="",PinSubCategoryObject={sub_object},'
            f'PinSubCategoryMemberReference=(),PinValueType=(),ContainerType={container},bIsReference=False)')


def blueprint(path: str, parent: str, components: list | None = None, variables: dict | None = None,
              kind: str = 'Blueprint', fails: bool = False) -> unreal.AssetData:
    tags = {'NativeParentClass': f"/Script/CoreUObject.Class'/Script/Engine.{parent}'"}
    return unreal.AssetData(path, kind, tags, unreal.Blueprint(components, variables), fails)


class Project(HelperCase):
    def setUp(self) -> None:
        super().setUp()
        self.file = os.path.join(self.project, 'Saved', 'Genex', 'project.json')
        car = blueprint(f'{BLUEPRINTS}/OffroadCar/BP_VehicleAdvOffroadCar', 'WheeledVehiclePawn', [
            ('VehicleMesh', unreal.SkeletalMeshComponent('VehicleMesh', {})),
            ('BackSpringArm', unreal.SpringArmComponent()),
            ('BackCamera', unreal.CameraComponent('BackCamera')),
        ], {
            'IsReversing': pin('bool'),
            'TopSpeed': pin('real'),
            'Target': pin('object', "/Script/CoreUObject.Class'/Script/Engine.Actor'"),
            'Offset': pin('struct', "/Script/CoreUObject.ScriptStruct'/Script/CoreUObject.Vector'"),
            'Gears': pin('int', container='Array'),
        })
        unreal.state['registry'] = [
            car,
            blueprint(f'{BLUEPRINTS}/BP_VehicleAdvGameMode', 'GameModeBase'),
            blueprint('/Game/VehicleTemplate/UI/UI_Speedometer', 'UserWidget', kind='WidgetBlueprint'),
            blueprint('/Game/Parts/Bike/BP_BikeFront', 'Actor'),
            blueprint('/Game/Parts', 'Actor'),
            blueprint('/Game/__GenexRef/GenexRef_Actor', 'Actor'),
            blueprint('/Game/PartsKit/BP_Cone', 'Actor'),
            blueprint('/ChaosVehiclesPlugin/BP_Sample', 'Pawn'),
            unreal.AssetData('/Game/Input/Actions/IA_Throttle', 'InputAction'),
            unreal.AssetData('/Game/Input/Actions/IA_Steering', 'InputAction'),
            unreal.AssetData('/Game/Input/Jump', 'InputAction'),
            unreal.AssetData('/Game/Parts/Bike/IA_Wheelie', 'InputAction'),
            unreal.AssetData('/Game/VehicleTemplate/Meshes/SM_Rock', 'StaticMesh'),
        ]
        car_class = unreal.Class(path=CAR_CLASS)
        mode_cdo = unreal.Actor()
        mode_cdo.props['default_pawn_class'] = car_class
        unreal.state['classes'] = {MODE_CLASS: unreal.Class(path=MODE_CLASS, cdo=mode_cdo)}
        unreal.state['default_mode'] = MODE_CLASS

    def written(self) -> dict:
        with open(self.file, encoding='utf-8') as handle:
            return json.load(handle)

    def test_writes_the_level_game_mode_blueprints_and_input_actions(self) -> None:
        result = self.call('export_project', self.file)
        self.assertEqual({k: result[k] for k in ['file', 'blueprints', 'more', 'inputActions']},
                         {'file': self.file, 'blueprints': 4, 'more': 0, 'inputActions': 3})
        # The level, the game mode and its pawn, the Blueprints by path (none of /Game/Parts or the
        # reference's) with their components and typed variables, and the input actions without IA_.
        with open(SHARED_FILE, encoding='utf-8') as handle:
            self.assertEqual(self.written(), json.load(handle))
        self.assertEqual(unreal.calls, [], 'the editor was changed')

    def test_the_levels_game_mode_override_wins_over_the_project_default(self) -> None:
        other = '/Game/Modes/BP_RaceMode.BP_RaceMode_C'
        cdo = unreal.Actor()
        cdo.props['default_pawn_class'] = unreal.Class(path='/Game/Bikes/BP_Bike.BP_Bike_C')
        unreal.state['mode_override'] = unreal.Class(path=other, cdo=cdo)
        self.call('export_project', self.file)
        self.assertEqual(self.written()['gameMode'], {'path': '/Game/Modes/BP_RaceMode', 'parent': None,
                                                      'defaultPawn': 'BP_Bike'})

    def test_writes_the_same_facts_while_a_play_session_runs(self) -> None:
        # Unreal's editor-world getter answers None during play; the play session's copy of the level
        # names the same level (without the play prefix) and carries the same game mode.
        unreal.state['pie'] = True
        with mock.patch.object(unreal.UnrealEditorSubsystem, 'get_editor_world', autospec=True) as asked:
            result = self.call('export_project', self.file)
        self.assertEqual({k: result[k] for k in ['file', 'blueprints', 'more', 'inputActions']},
                         {'file': self.file, 'blueprints': 4, 'more': 0, 'inputActions': 3})
        with open(SHARED_FILE, encoding='utf-8') as handle:
            self.assertEqual(self.written(), json.load(handle))
        self.assertEqual(unreal.calls, [], 'the editor was changed')
        # Each call during play writes "The Editor is currently in a play mode." to the log, which reads as a game error.
        self.assertEqual(asked.call_count, 0, 'the editor-world getter was asked during play')

    def test_a_parts_game_mode_names_its_parent(self) -> None:
        # A part may set the level's GameMode Override to its own Blueprint, which the listing leaves out.
        other = '/Game/Parts/Rules/BP_RulesMode.BP_RulesMode_C'
        unreal.state['registry'].append(blueprint('/Game/Parts/Rules/BP_RulesMode', 'GameModeBase'))
        unreal.state['mode_override'] = unreal.Class(path=other, cdo=unreal.Actor())
        for pie in (False, True):
            with self.subTest(pie=pie):
                unreal.state['pie'] = pie
                self.call('export_project', self.file)
                self.assertEqual(self.written()['gameMode'], {'path': '/Game/Parts/Rules/BP_RulesMode',
                                                              'parent': 'GameModeBase', 'defaultPawn': None})

    def test_a_play_copys_level_is_named_as_the_level_it_copies(self) -> None:
        names = {
            '/Game/Maps/UEDPIE_0_Map.Map': '/Game/Maps/Map',
            '/Game/Maps/UEDPIE_12_Arena.Arena': '/Game/Maps/Arena',
            '/Game/Maps/Map.Map': '/Game/Maps/Map',
            '/Game/UEDPIE_0_Folder/Map.Map': '/Game/UEDPIE_0_Folder/Map',
            '/Game/Maps/MyUEDPIE_0_Map.MyUEDPIE_0_Map': '/Game/Maps/MyUEDPIE_0_Map',
        }
        for path, level in names.items():
            with self.subTest(path):
                world = unreal.World('Map')
                world.get_path_name = lambda path=path: path
                self.assertEqual(editor.level_path(world), level)

    def test_no_level_open_is_refused_and_writes_nothing(self) -> None:
        subsystem = unreal.UnrealEditorSubsystem
        self.addCleanup(setattr, subsystem, 'get_editor_world', subsystem.get_editor_world)
        subsystem.get_editor_world = lambda _self: None
        self.assert_refused(self.call('export_project', self.file))
        self.assertFalse(os.path.exists(self.file))

    def test_no_game_mode_anywhere_is_null(self) -> None:
        unreal.state['default_mode'] = ''
        self.call('export_project', self.file)
        self.assertIsNone(self.written()['gameMode'])

    def test_a_blueprint_that_does_not_load_keeps_its_name_and_parent(self) -> None:
        unreal.state['registry'] = [blueprint('/Game/Broken/BP_Broken', 'Character', fails=True)]
        self.call('export_project', self.file)
        self.assertEqual(self.written()['blueprints'], [{'name': 'BP_Broken', 'path': '/Game/Broken/BP_Broken',
                                                         'parent': 'Character', 'components': [], 'variables': []}])

    def test_writes_at_most_200_blueprints_sorted_by_path(self) -> None:
        unreal.state['registry'] = [blueprint(f'/Game/Props/BP_Prop{i:03}', 'Actor') for i in range(204, -1, -1)]
        result = self.call('export_project', self.file)
        paths = [b['path'] for b in self.written()['blueprints']]
        self.assertEqual((len(paths), result['more'], paths[0], paths[-1]),
                         (200, 5, '/Game/Props/BP_Prop000', '/Game/Props/BP_Prop199'))

    def test_refuses_files_outside_saved_genex(self) -> None:
        genex = self.path('game', 'unreal', 'Saved', 'Genex')
        os.symlink(self.outside, os.path.join(genex, 'out'))
        sibling = self.path('game', 'unreal', 'Saved', 'GenexEvil')
        hostile = {
            'relative': 'Saved/Genex/project.json',
            'dot-dot': os.path.join(genex, '..', '..', '..', 'project.json'),
            'outside': os.path.join(self.outside, 'project.json'),
            'link out of the folder': os.path.join(genex, 'out', 'project.json'),
            'sibling with the same prefix': os.path.join(sibling, 'project.json'),
            'the folder itself': genex,
            'a directory inside': self.path('game', 'unreal', 'Saved', 'Genex', 'dir'),
            'empty': '',
            'nul': os.path.join(genex, 'project\0.json'),
        }
        for label, file in hostile.items():
            with self.subTest(label):
                self.fresh()
                self.assert_refused(self.call('export_project', file))
                self.assertEqual(os.listdir(self.outside), [])
                self.assertEqual(os.listdir(sibling), [])
        self.assertFalse(os.path.exists(os.path.join(self.project, 'project.json')))
