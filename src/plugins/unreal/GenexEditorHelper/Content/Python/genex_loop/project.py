"""What a game's template is made of, for Genex's builders, who never open the editor: the level,
the game mode it plays with and the pawn that mode spawns, the project's own Blueprints (native
parent, components, variables) and its input actions, written as JSON into Saved/Genex.

Blueprints and input actions come from the asset registry; each Blueprint is loaded once to read
its components (SubobjectDataSubsystem, inherited ones included) and member variables. The parts'
own Blueprints (/Game/Parts) and the node reference's throwaway ones are left out. Read only,
apart from the file it writes.
"""

import json
import re
import time

import unreal

from genex_loop import editor, paths, reference

BLUEPRINTS_CAP = 200
MEMBERS_CAP = 60
GAME_ROOT = '/Game/'
LEFT_OUT = (editor.PARTS_CONTENT, reference.REF_FOLDER)
BLUEPRINT_CLASS = ('/Script/Engine', 'Blueprint')
INPUT_ACTION_CLASS = ('/Script/EnhancedInput', 'InputAction')
INPUT_PREFIX = 'IA_'
GENERATED_SUFFIX = '_C'
NATIVE_PARENT_TAG = 'NativeParentClass'
# The class at the end of an object path: /Script/CoreUObject.Class'/Script/Engine.Actor' -> Actor.
CLASS_AT_END = re.compile(r'''([A-Za-z0-9_]+)['"]*$''')
PIN_CATEGORY = re.compile(r'PinCategory="([^"]*)"')
PIN_OBJECT = re.compile(r'PinSubCategoryObject=([^,)]*)')
PIN_CONTAINER = re.compile(r'ContainerType=(\w+)')
# A pin category as part.json spells a variable's type; references name their class first.
BASIC_TYPES = {'bool': 'bool', 'int': 'int', 'int64': 'int64', 'real': 'float', 'float': 'float', 'double': 'float',
               'byte': 'byte', 'name': 'name', 'string': 'string', 'text': 'text'}
REFERENCE_TYPES = {'object': 'object ref', 'softobject': 'soft object ref', 'class': 'class ref',
                   'softclass': 'soft class ref', 'interface': 'interface'}
CONTAINERS = {'Array': 'array', 'Set': 'set', 'Map': 'map'}


def _class_name(path: object) -> str | None:
    """The class an object path ends with, a Blueprint's without its _C, or None."""
    match = CLASS_AT_END.search(str(path or '').strip())
    if not match or match.group(1) == 'None':
        return None
    name = match.group(1)
    return name[:-len(GENERATED_SUFFIX)] if name.endswith(GENERATED_SUFFIX) else name


def _left_out(package: str) -> bool:
    outside_game = not package.startswith(GAME_ROOT)
    return outside_game or any(package == folder or package.startswith(f'{folder}/') for folder in LEFT_OUT)


def _assets(class_path: tuple[str, str], sub_classes: bool) -> list:
    registry = unreal.AssetRegistryHelpers.get_asset_registry()
    found = registry.get_assets_by_class(unreal.TopLevelAssetPath(*class_path), sub_classes)
    return [data for data in found if not _left_out(str(data.package_name))]


def _native_parent(data) -> str | None:
    return _class_name(data.get_tag_value(NATIVE_PARENT_TAG)) if data is not None else None


def _field(pattern: re.Pattern, text: str) -> str:
    match = pattern.search(text)
    return match.group(1) if match else ''


def _type_name(pin_type) -> str:
    """A member variable's type the way part.json writes one: float, Vector, Actor object ref, int array."""
    text = str(pin_type.export_text())
    category = _field(PIN_CATEGORY, text)
    named = _class_name(_field(PIN_OBJECT, text))
    container = CONTAINERS.get(_field(PIN_CONTAINER, text))
    if category in REFERENCE_TYPES and named:
        kind = f'{named} {REFERENCE_TYPES[category]}'
    elif named and category in ('struct', 'byte', 'enum'):
        kind = named
    else:
        kind = BASIC_TYPES.get(category, category)
    return f'{kind} {container}' if container else kind


def _components(blueprint) -> list[dict]:
    """Its components, inherited ones included, once each in the editor's order."""
    subobjects = unreal.get_engine_subsystem(unreal.SubobjectDataSubsystem)
    library = unreal.SubobjectDataBlueprintFunctionLibrary
    found: dict[str, str] = {}
    for handle in subobjects.k2_gather_subobject_data_for_blueprint(blueprint):
        data = subobjects.k2_find_subobject_data_from_handle(handle)
        template = library.get_object(data)
        if template is None or isinstance(template, unreal.Actor):  # the Blueprint's own actor comes first
            continue
        found.setdefault(str(library.get_variable_name(data)), template.get_class().get_name())
    return [{'name': name, 'class': cls} for name, cls in list(found.items())[:MEMBERS_CAP]]


def _variables(blueprint) -> list[dict]:
    """Its own member variables (not inherited ones) with their types."""
    library = unreal.BlueprintEditorLibrary
    rows = []
    for name in list(library.list_member_variable_names(blueprint, False))[:MEMBERS_CAP]:
        pin_type = library.get_member_variable_type(blueprint, name)
        rows.append({'name': str(name), 'type': _type_name(pin_type) if pin_type is not None else ''})
    return rows


def _blueprint_row(data) -> dict:
    row = {'name': str(data.asset_name), 'path': str(data.package_name), 'parent': _native_parent(data),
           'components': [], 'variables': []}
    try:
        blueprint = data.get_asset()
        row['components'] = _components(blueprint)
        row['variables'] = _variables(blueprint)
    except Exception:  # noqa: BLE001 - a Blueprint that doesn't load still names itself and its parent
        pass
    return row


def _mode_class(world):
    """The level's GameMode Override, else the project's default game mode, else None."""
    override = world.get_world_settings().get_editor_property('default_game_mode')
    if override:
        return override
    default = unreal.get_default_object(unreal.GameMapsSettings).get_editor_property('global_default_game_mode')
    path = str(default.export_text()).strip().strip('"\'')
    return unreal.load_class(None, path) if path else None


def _asset_path(cls) -> str:
    """A Blueprint class's asset path (/Game/.../BP_Mode), or a native class's object path."""
    path = str(cls.get_path_name())
    return path.split('.', 1)[0] if path.startswith(GAME_ROOT) else path


def _game_mode(world) -> dict | None:
    cls = _mode_class(world)
    if not cls:
        return None
    path = _asset_path(cls)
    data = unreal.EditorAssetLibrary.find_asset_data(path) if path.startswith(GAME_ROOT) else None
    pawn = unreal.get_default_object(cls).get_editor_property('default_pawn_class')
    parent = _native_parent(data) if path.startswith(GAME_ROOT) else _class_name(path)
    return {'path': path, 'parent': parent, 'defaultPawn': _class_name(pawn.get_path_name()) if pawn else None}


def _input_actions() -> list[str]:
    names = {str(data.asset_name) for data in _assets(INPUT_ACTION_CLASS, False)}
    return sorted({name[len(INPUT_PREFIX):] if name.startswith(INPUT_PREFIX) else name for name in names})


def export_project(file: str) -> dict:
    """Writes the level, game mode, the project's Blueprints and input actions into a Saved/Genex file."""
    target = paths.inside_genex_folder(file, editor.project_dir())
    started = time.perf_counter()
    world = editor.editor_subsystem().get_editor_world()
    found = sorted(_assets(BLUEPRINT_CLASS, True), key=lambda data: str(data.package_name))
    data = {'map': str(world.get_path_name()).split('.', 1)[0], 'gameMode': _game_mode(world),
            'blueprints': [_blueprint_row(d) for d in found[:BLUEPRINTS_CAP]],
            'more': max(0, len(found) - BLUEPRINTS_CAP), 'inputActions': _input_actions()}
    with open(target, 'w', encoding='utf-8') as handle:
        json.dump(data, handle)
    return {'file': target, 'blueprints': len(data['blueprints']), 'more': data['more'],
            'inputActions': len(data['inputActions']), 'ms': editor.elapsed_ms(started)}
