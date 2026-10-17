"""The node reference and the Python names Genex checks builders' parts against without Unreal.

Node names come from Epic's own node lists for a throwaway Blueprint of each base class, in its
event graph and in a function graph (about 5 s for all). Pins cost about 0.1 s of editor time per
node, so they are read only for the nodes asked for. The throwaway Blueprints live in
/Game/__GenexRef and are deleted before the call returns, unsaved, so nothing reaches Content;
the nodes they add themselves (casts to them, calls to their function) are left out by their
GenexRef marker.
The file is ReferenceData, the shape src/plugins/unreal/blueprint-reference.ts reads.
"""

import json
import re
import time

import unreal

from genex_loop import blueprints, editor, paths
from genex_loop.errors import Refused, short_message

REF_FOLDER = '/Game/__GenexRef'
REF_MARKER = 'GenexRef'
REF_BLUEPRINT = f'{REF_MARKER}_{{base}}'
REF_FUNCTION = f'{REF_MARKER}Fn'
EVENT_GRAPH = 'EventGraph'
FUNCTION_GRAPH = 'Function'
BASES = ('Actor', 'Character', 'Pawn', 'ActorComponent', 'SceneComponent', 'HUD', 'GameModeBase',
         'PlayerController', 'UserWidget', 'AnimInstance')
CONTEXTS = tuple(f'{base}/{graph}' for base in BASES for graph in (EVENT_GRAPH, FUNCTION_GRAPH))
PINS_CAP = 200
ENGINE_VERSION = re.compile(r'\d+\.\d+\.\d+')


def _cache():
    from editor_toolset.toolsets.blueprint import _BlueprintCache
    return _BlueprintCache


def _tools():
    from editor_toolset.toolsets.blueprint import BlueprintTools
    return BlueprintTools


def engine_version() -> str:
    """The engine's version, short: 5.8.3."""
    full = str(unreal.SystemLibrary.get_engine_version())
    match = ENGINE_VERSION.match(full)
    return match.group(0) if match else full


def _graph(context: str, made: dict) -> unreal.EdGraph:
    base, kind = context.split('/')
    if base not in made:
        made[base] = blueprints.make_blueprint(REF_FOLDER, REF_BLUEPRINT.format(base=base), base)
    if kind == EVENT_GRAPH:
        return unreal.BlueprintEditorLibrary.find_event_graph(made[base])
    return _tools().add_function_graph(made[base], REF_FUNCTION)


def parse_pin_request(pins: str) -> dict[str, list[str]]:
    """The {context: [type ids]} asked for, or Refused."""
    if not pins:
        return {}
    try:
        wanted = json.loads(pins)
    except ValueError:
        raise Refused('pins must be JSON: {"Actor/EventGraph": ["type id", ...]}.') from None
    shaped = isinstance(wanted, dict) and all(
        key in CONTEXTS and isinstance(ids, list) and all(isinstance(i, str) for i in ids) for key, ids in wanted.items())
    if not shaped:
        raise Refused(f'pins must map contexts ({CONTEXTS[0]}, ...) to lists of type ids.')
    if sum(len(set(ids)) for ids in wanted.values()) > PINS_CAP:
        raise Refused(f'Ask for at most {PINS_CAP} nodes\' pins in one call.')
    return wanted


def _names(made: dict) -> dict[str, set[str]]:
    """Every node type id per context, without the throwaway Blueprints' own nodes."""
    return {context: {name for name in _cache().list_nodes(_graph(context, made)) if REF_MARKER not in name}
            for context in CONTEXTS}


def _node_pins(graph: unreal.EdGraph, type_id: str) -> dict:
    tools = _tools()
    node = tools.create_node(graph, type_id, unreal.IntPoint(0, 0))
    try:
        info = tools._get_node_info(node)
        return {'inputs': [[str(p.name), str(p.type_id)] for p in info.input_pins],
                'outputs': [[str(p.name), str(p.type_id)] for p in info.output_pins]}
    finally:
        unreal.BlueprintGraphEditor.get_graph_editor(graph).remove_nodes([node])


def _pins(wanted: dict[str, list[str]], made: dict) -> tuple[dict, list]:
    pins, failed = {}, []
    for context, type_ids in wanted.items():
        graph = _graph(context, made)
        for type_id in dict.fromkeys(type_ids):
            if type_id in pins:
                continue
            try:
                pins[type_id] = _node_pins(graph, type_id)
            except Exception as error:  # noqa: BLE001 - a name the editor doesn't know
                failed.append([context, type_id, short_message(error)[:200]])
    return pins, failed


def _remove_ref_folder() -> None:
    library = unreal.EditorAssetLibrary
    if library.does_directory_exist(REF_FOLDER):
        library.delete_directory(REF_FOLDER)


def export_reference(file: str, pins: str) -> dict:
    """Writes every node name per context and the asked-for nodes' pins into a Saved/Genex file."""
    wanted = parse_pin_request(pins)
    target = paths.inside_genex_folder(file, editor.project_dir())
    editor.refuse_during_play()
    started = time.perf_counter()
    made = {}
    try:
        names = _names(made)
        found, failed = _pins(wanted, made)
    finally:
        _remove_ref_folder()
    common = set.intersection(*names.values())
    data = {'version': 1, 'engine': engine_version(), 'common': sorted(common),
            'contexts': {context: sorted(ids - common) for context, ids in names.items()}, 'pins': found}
    with open(target, 'w', encoding='utf-8') as handle:
        json.dump(data, handle)
    return {'file': target, 'engine': data['engine'], 'common': len(common),
            'contexts': {k: len(v) for k, v in data['contexts'].items()}, 'pins': len(found),
            'failed': failed[:20], 'ms': editor.elapsed_ms(started)}


def export_python_names(file: str) -> dict:
    """Writes the unreal module's names (classes with their members) into a Saved/Genex file."""
    target = paths.inside_genex_folder(file, editor.project_dir())
    started = time.perf_counter()
    names = {}
    for name in dir(unreal):
        if name.startswith('_'):
            continue
        value = getattr(unreal, name, None)
        names[name] = sorted(m for m in dir(value) if not m.startswith('_')) if isinstance(value, type) else None
    with open(target, 'w', encoding='utf-8') as handle:
        json.dump(names, handle)
    return {'file': target, 'names': len(names), 'classes': sum(1 for v in names.values() if v is not None),
            'ms': editor.elapsed_ms(started)}
