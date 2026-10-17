"""export_project writes what a game's template is made of — its level, the game mode and the pawn it
spawns, the project's own Blueprints (native parent, components, variables) and input actions —
into Saved/Genex for the builders, leaving out the parts' own and the reference's throwaway
Blueprints; it refuses any file outside Saved/Genex, and changes nothing in the editor."""

import json
import os

import unreal

from support import HelperCase

BLUEPRINTS = '/Game/VehicleTemplate/Blueprints'
MODE_CLASS = f'{BLUEPRINTS}/BP_VehicleAdvGameMode.BP_VehicleAdvGameMode_C'
CAR_CLASS = f'{BLUEPRINTS}/OffroadCar/BP_VehicleAdvOffroadCar.BP_VehicleAdvOffroadCar_C'
# The file export_project writes for the scene below, exactly; the seed's projectFacts reads the same
# file in tests/conformance/unreal-project-facts.test.ts, so both sides agree on its shape.
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
