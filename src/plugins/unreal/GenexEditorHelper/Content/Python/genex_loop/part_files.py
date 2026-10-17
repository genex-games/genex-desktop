"""A part's folder as data: part.json (what it declares), each Blueprint's text (<Name>.dsl) and
apply.py. Builders write these, so everything is read and checked before the editor changes:
plain files only (no links), within a size cap, names that are identifiers, bases from the
reference's list, a C++ parent only from the part's own `cpp` classes. The same rules as Genex's
own reader (src/plugins/unreal/part-manifest.ts); tests/conformance/unreal-part-manifest-contract
holds the two to it."""

import dataclasses
import json
import os

from genex_loop import paths
from genex_loop.errors import Refused

MANIFEST = 'part.json'
BLUEPRINT_TEXT = '.dsl'
MAX_FILE_BYTES = 256 * 1024
MAX_BLUEPRINTS = 12
MAX_CPP_CLASSES = 12
MAX_TYPE = 64
# The prefixes Unreal gives a C++ class: A for an actor, U for any other object.
CPP_PREFIXES = ('A', 'U')
# The base a Blueprint made from one of the part's C++ classes is checked against unless it names one.
CPP_DEFAULT_BASE = 'Actor'
EVENT_GRAPH = 'EventGraph'
BASES = ('Actor', 'Character', 'Pawn', 'ActorComponent', 'SceneComponent', 'HUD', 'GameModeBase',
         'PlayerController', 'UserWidget', 'AnimInstance')


@dataclasses.dataclass
class Pin:
    """A function input or output."""
    name: str
    type: str


@dataclasses.dataclass
class Function:
    """A function graph a Blueprint declares, with its inputs and outputs."""
    name: str
    inputs: list[Pin]
    outputs: list[Pin]


@dataclasses.dataclass
class Blueprint:
    """One Blueprint a part owns, and its graphs' Blueprint text split by graph.

    `parent` is one of the part's own C++ classes (without its prefix) it is made from; `base` is
    then the engine class its nodes are checked against.
    """
    name: str
    base: str
    components: list[dict]
    variables: list[dict]
    functions: list[Function]
    graphs: list[tuple[str, str]] = dataclasses.field(default_factory=list)
    parent: str | None = None


@dataclasses.dataclass
class PartFiles:
    """A checked part folder, ready to build and run."""
    part: str
    folder: str
    script: str
    source: str
    title: str
    goal: str
    blueprints: list[Blueprint]


def _read_text(path: str) -> str:
    if os.path.getsize(path) > MAX_FILE_BYTES:
        raise Refused(f'{os.path.basename(path)} is larger than {MAX_FILE_BYTES // 1024} KiB.')
    with open(path, encoding='utf-8') as handle:
        return handle.read()


def _name(raw: dict, field: str, at: str) -> str:
    value = raw.get(field)
    if not paths.is_name(value):
        raise Refused(f'{at}: its {field} must be a plain identifier such as BP_Lantern.', value=value)
    return value


def _type(raw: dict, at: str) -> str:
    value = raw.get('type')
    if not isinstance(value, str) or not value.strip() or len(value) > MAX_TYPE:
        raise Refused(f'{at}: its type must be a type name of at most {MAX_TYPE} characters.')
    return value.strip()


def _records(raw: object, at: str) -> list[dict]:
    if raw is None:
        return []
    if not isinstance(raw, list) or not all(isinstance(item, dict) for item in raw):
        raise Refused(f'{at} must be a list of objects.')
    return raw


def _component(raw: dict, at: str) -> dict:
    component = {'name': _name(raw, 'name', at), 'class': _name(raw, 'class', at)}
    if raw.get('parent') is not None:
        component['parent'] = _name(raw, 'parent', at)
    return component


def _variable(raw: dict, at: str) -> dict:
    variable = {'name': _name(raw, 'name', at), 'type': _type(raw, at)}
    category = raw.get('category')
    if isinstance(category, str) and category.strip():
        variable['category'] = category.strip()[:MAX_TYPE]
    return variable


def _function(raw: dict, at: str) -> Function:
    name = _name(raw, 'name', at)
    pins = {side: [Pin(_name(pin, 'name', f'{at} {side}'), _type(pin, f'{at} {side}'))
                   for pin in _records(raw.get(side), f'{at} {side}')] for side in ('inputs', 'outputs')}
    return Function(name, pins['inputs'], pins['outputs'])


def _cpp_classes(raw: object) -> list[str]:
    """part.json's cpp: C++ class names without their prefix, each once, at most MAX_CPP_CLASSES."""
    if raw is None:
        return []
    names_ok = isinstance(raw, list) and all(paths.is_name(name) for name in raw)
    if not names_ok or len(raw) > MAX_CPP_CLASSES or len(set(raw)) != len(raw):
        raise Refused(f'part.json\'s cpp must list at most {MAX_CPP_CLASSES} C++ class names, each once, '
                      'without the A or U prefix (BikeCamera for ABikeCamera).')
    return raw


def _cpp_parent(raw: dict, name: str, cpp: list[str]) -> str | None:
    """The part's C++ class a Blueprint's parent names, with or without its A or U prefix."""
    parent = raw.get('parent')
    if parent is None:
        return None
    if paths.is_name(parent) and parent in cpp:
        return parent
    bare = parent[1:] if paths.is_name(parent) and parent[:1] in CPP_PREFIXES else None
    if bare in cpp:
        return bare
    raise Refused(f'{name}: its parent isn\'t one of the part\'s C++ classes (part.json cpp).', parent=parent)


def _blueprint(raw: object, index: int, cpp: list[str]) -> Blueprint:
    at = f'Blueprint #{index + 1}'
    if not isinstance(raw, dict):
        raise Refused(f'{at} is not an object.')
    name = _name(raw, 'name', at)
    parent = _cpp_parent(raw, name, cpp)
    base = raw.get('base', CPP_DEFAULT_BASE if parent else None)
    if base not in BASES:
        raise Refused(f'{name}: its base must be one of {", ".join(BASES)}.', base=base)
    blueprint = Blueprint(
        name, base,
        [_component(c, f'{name} component') for c in _records(raw.get('components'), f'{name} components')],
        [_variable(v, f'{name} variable') for v in _records(raw.get('variables'), f'{name} variables')],
        [_function(f, f'{name} function') for f in _records(raw.get('functions'), f'{name} functions')],
        parent=parent)
    components = {c['name'] for c in blueprint.components}
    for component in blueprint.components:
        if component.get('parent') not in (None, *components):
            raise Refused(f'{name}: component {component["name"]}\'s parent isn\'t one of its components.')
    return blueprint


def parse_manifest(raw: object) -> tuple[str, str, list[Blueprint]]:
    """part.json's title, goal and Blueprints, or Refused naming the first problem."""
    if not isinstance(raw, dict):
        raise Refused('part.json must be an object with title, goal and blueprints.')
    if not isinstance(raw.get('blueprints'), list):
        raise Refused('part.json\'s blueprints must be a list.')
    if len(raw['blueprints']) > MAX_BLUEPRINTS:
        raise Refused(f'A part owns at most {MAX_BLUEPRINTS} Blueprints.')
    cpp = _cpp_classes(raw.get('cpp'))
    blueprints = [_blueprint(item, i, cpp) for i, item in enumerate(raw['blueprints'])]
    names = [b.name for b in blueprints]
    twice = sorted({n for n in names if names.count(n) > 1})
    if twice:
        raise Refused(f'Blueprint {twice[0]} is declared twice.')
    return _text(raw.get('title')), _text(raw.get('goal')), blueprints


def _text(value: object) -> str:
    return value.strip() if isinstance(value, str) else ''


def _skip_string(text: str, at: int) -> int:
    """Offset just past the string whose opening quote is at `at` (Epic's escapes)."""
    i = at + 1
    while i < len(text) and text[i] != '"':
        i += 2 if text[i] == '\\' else 1
    if i >= len(text):
        raise Refused('Blueprint text has an unterminated string.')
    return i + 1


def _top_forms(text: str) -> list[tuple[int, int]]:
    """(start, end) of each top-level parenthesised form; comments and strings are skipped.

    A word that holds a `(` takes its balanced group with it (`Equal(==)`), as Epic's tokenizer
    reads it, which can't change the depth of the forms around it.
    """
    forms, depth, start, i = [], 0, 0, 0
    while i < len(text):
        char = text[i]
        if char == ';':
            end = text.find('\n', i)
            i = len(text) if end == -1 else end
            continue
        if char == '"':
            i = _skip_string(text, i)
            continue
        if char == '(':
            start = i if depth == 0 else start
            depth += 1
        elif char == ')':
            depth -= 1
            if depth < 0:
                raise Refused('Blueprint text has an unexpected ).')
            if depth == 0:
                forms.append((start, i + 1))
        i += 1
    if depth:
        raise Refused('Blueprint text has an unclosed parenthesis.')
    return forms


def _head(form: str) -> tuple[str, str]:
    words = form[1:].replace('(', ' ( ').split()
    return (words[0] if words else ''), (words[1] if len(words) > 1 else '')


def split_by_graph(text: str) -> list[tuple[str, str]]:
    """Blueprint text split by graph: (event ...) forms to the EventGraph, each (fn Name ...) to Name.

    The same split as splitByGraph in src/plugins/unreal/blueprint-check.ts.
    """
    events, functions = [], []
    for start, end in _top_forms(text):
        form = text[start:end]
        head, name = _head(form)
        if head == 'fn' and paths.is_name(name):
            functions.append((name, form))
        else:
            events.append(form)
    return ([(EVENT_GRAPH, '\n\n'.join(events))] if events else []) + functions


def _manifest(folder: str) -> tuple[str, str, list[Blueprint]]:
    path = paths.folder_file(folder, MANIFEST)
    if path is None:
        return '', '', []
    try:
        raw = json.loads(_read_text(path))
    except ValueError as error:
        raise Refused(f'part.json isn\'t valid JSON: {error}') from None
    return parse_manifest(raw)


def load(script: object, part: object) -> PartFiles:
    """A part's checked files, or Refused; reads only, never runs or writes anything."""
    real = paths.part_script(script, part)
    folder = os.path.dirname(real)
    title, goal, blueprints = _manifest(folder)
    for blueprint in blueprints:
        text_file = paths.folder_file(folder, blueprint.name + BLUEPRINT_TEXT)
        if text_file is not None:
            blueprint.graphs = split_by_graph(_read_text(text_file))
    return PartFiles(part, folder, real, _read_text(real), title, goal, blueprints)
