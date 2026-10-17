"""`genex`: what a part's apply.py gets beside `unreal` and `part`.

A part is unreal/parts/<Part>/ in the game folder: part.json declares its Blueprints (base
class, or one of the part's own C++ classes as parent, which must be hot reloaded first;
components, variables, functions), <Blueprint>.dsl holds each one's Blueprint text, and
apply.py does the rest. Before apply.py runs, the Genex editor helper builds what part.json
declares in /Game/Parts/<Part>/ and compiles it; apply.py runs only when every Blueprint
compiled. Everything runs in one undo step and is saved afterwards, so apply.py only adds what
part.json can't say: placing actors, tuning defaults, importing.

    genex.part        the part's name, e.g. "Lantern"
    genex.folder      its content folder, "/Game/Parts/Lantern"
    genex.build_part()
        Builds part.json's Blueprints again (idempotent): [{name, compiled, messages}].
    genex.blueprint(name, base_class)
        The Blueprint <folder>/<name>, created from base_class (unreal.Actor or "Actor") or reused.
    genex.add_component(bp, cls, name, parent=None)
        The component `name` of class cls (unreal.PointLightComponent or its name), reused if there.
    genex.write_graph(bp, text, graph=None)
        Writes Blueprint text into the event graph, or the function graph `graph` (made first).
    genex.compile(bp)
        Compiles; raises with the editor's error messages when it doesn't.
    genex.place(asset_or_class, location, label, rotation=None)
        Spawns a Blueprint, asset, asset path or actor class at location (x, y, z) in cm, with
        rotation (pitch, yaw, roll) in degrees; labels it, tags it GenexPart:<part> and puts it in
        the Outliner folder Parts/<part>. A part actor with the same label is replaced.
    genex.save()
        Saves the part's folder and the level (done for you after apply.py).
    genex.import_model(path, name)
    genex.import_sound(path, name)
    genex.import_texture(path, name)
        Imports a file of the game folder into <folder>/Imported/<name> (again over it when the
        part is applied again) and answers the asset path to place or set: the model's one static
        mesh, the SoundWave, the Texture2D. `path` is relative to the game folder, such as the
        model.glb path blender__model returned or unreal/parts/<part>/<file>; a plain file, never
        through a link. A model is .glb, .gltf, .fbx or .obj up to 100 MB; a sound .wav and a
        texture .png, .jpg or .jpeg up to 20 MB. `name` is an identifier such as DirtBike.

Example apply.py:

    lantern = genex.blueprint('BP_Lantern', 'Actor')
    for i, y in enumerate((-200, 200)):
        genex.place(lantern, (300, y, 50), f'Lantern_{i}')
    bike = genex.import_model('assets/blender/<job>/model.glb', 'DirtBike')
    genex.place(bike, (600, 0, 0), 'DirtBike_0')
"""

import functools
import os
import types
import typing

import unreal

from genex_loop import assets, blueprints, editor, paths
from genex_loop.errors import MESSAGE_CHARS, Refused, short_message
from genex_loop.part_files import PartFiles


def _vector(value: object) -> unreal.Vector:
    if isinstance(value, unreal.Vector):
        return value
    x, y, z = value
    return unreal.Vector(float(x), float(y), float(z))


def _rotator(value: object) -> unreal.Rotator:
    if value is None:
        return unreal.Rotator(roll=0.0, pitch=0.0, yaw=0.0)
    if isinstance(value, unreal.Rotator):
        return value
    pitch, yaw, roll = value
    return unreal.Rotator(roll=float(roll), pitch=float(pitch), yaw=float(yaw))


def _spawn(asset_or_class: object, location: unreal.Vector, rotation: unreal.Rotator) -> unreal.Actor:
    subsystem = editor.actors()
    if isinstance(asset_or_class, str):
        asset_or_class = unreal.load_asset(asset_or_class)
    is_class = isinstance(asset_or_class, unreal.Class) or (
        isinstance(asset_or_class, type) and issubclass(asset_or_class, unreal.Actor))
    if is_class:
        return subsystem.spawn_actor_from_class(asset_or_class, location, rotation)
    return subsystem.spawn_actor_from_object(asset_or_class, location, rotation)


def place(part: str, asset_or_class: object, location: object, label: str, rotation: object = None) -> unreal.Actor:
    """Spawns a part actor (see the module docs)."""
    for actor in editor.part_actors(part):
        if actor.get_actor_label() == label:
            editor.actors().destroy_actor(actor)
    actor = _spawn(asset_or_class, _vector(location), _rotator(rotation))
    if actor is None:
        raise RuntimeError(f'Could not place {label} from {asset_or_class}.')
    actor.set_actor_label(label)
    actor.tags = list(actor.tags) + [editor.part_tag(part)]
    actor.set_folder_path(unreal.Name(f'Parts/{part}'))
    return actor


def save(part: str) -> None:
    """Saves the part's content folder (recursively) and the current level."""
    folder = editor.part_folder(part)
    if unreal.EditorAssetLibrary.does_directory_exist(folder):
        unreal.EditorAssetLibrary.save_directory(folder, only_if_is_dirty=True, recursive=True)
    editor.levels().save_current_level()


def compile_or_raise(blueprint: unreal.Blueprint) -> None:
    """Compiles; raises with the error messages when the Blueprint doesn't compile."""
    compiled, messages = blueprints.compile_status(blueprint)
    if not compiled:
        raise RuntimeError(f'{blueprint.get_name()} did not compile: {messages}')


def _attempt(result: dict, step, *args) -> object:
    """Runs one build step; an editor error becomes one of the Blueprint's messages."""
    try:
        return step(*args)
    except Exception as error:  # noqa: BLE001 - Epic's tools raise RuntimeError, AssertionError, ValueError
        result['messages'].append(short_message(error))
        return None


def _structure(blueprint: unreal.Blueprint, decl, folder: str) -> None:
    for component in decl.components:
        blueprints.add_component(blueprint, component['class'], component['name'], component.get('parent'))
    for variable in decl.variables:
        blueprints.add_variable(blueprint, variable['name'], variable['type'], variable.get('category', ''), folder)
    for function in decl.functions:
        blueprints.add_function(blueprint, function.name, function.inputs, function.outputs, folder)


# Where a part's C++ lives in the game: Source/<Module>/Parts/<Part>/.
SOURCE_FOLDER = 'Source'
CPP_PARTS_FOLDER = 'Parts'
NOT_LOADED = ("{name} isn't loaded in the editor: the part's C++ is compiled and hot reloaded "
              "(recompile_module) before its Blueprints are built.")


def _cpp_class(part: str, name: str) -> unreal.Class:
    """The part's C++ class `name` as the hot reload loaded it, from the game module holding the part's C++."""
    source = os.path.join(editor.project_dir(), SOURCE_FOLDER)
    try:
        modules = sorted(os.listdir(source))
    except OSError:  # a Blueprint game has no Source
        modules = []
    for module in modules:
        if paths.is_name(module) and os.path.isdir(os.path.join(source, module, CPP_PARTS_FOLDER, part)):
            found = unreal.load_class(None, f'/Script/{module}.{name}')
            if found is not None:
                return found
    raise ValueError(NOT_LOADED.format(name=name))


def _make(folder: str, part: str, decl) -> unreal.Blueprint:
    """The declared Blueprint, made from its C++ parent when it names one, else from its base."""
    base = _cpp_class(part, decl.parent) if decl.parent else decl.base
    return blueprints.make_blueprint(folder, decl.name, base)


def build_part(files: PartFiles) -> list[dict]:
    """Builds what part.json declares; [{name, compiled, messages}] per Blueprint.

    All Blueprints exist before any is filled in, and every signature compiles before any
    Blueprint text is written, so Blueprints can name each other's types and functions.
    """
    folder = editor.part_folder(files.part)
    results = {d.name: {'name': d.name, 'compiled': False, 'messages': []} for d in files.blueprints}
    made = {}
    for decl in files.blueprints:
        made[decl.name] = _attempt(results[decl.name], _make, folder, files.part, decl)
    built = [(decl, made[decl.name]) for decl in files.blueprints if made[decl.name] is not None]
    for decl, blueprint in built:
        _attempt(results[decl.name], _structure, blueprint, decl, folder)
    for decl, blueprint in built:
        unreal.BlueprintEditorLibrary.compile_blueprint(blueprint)
    for decl, blueprint in built:
        for graph, text in decl.graphs:
            _attempt(results[decl.name], blueprints.write_graph, blueprint, text, graph)
    for decl, blueprint in built:
        compiled, messages = blueprints.compile_status(blueprint)
        result = results[decl.name]
        result['compiled'] = compiled and not result['messages']
        result['messages'] += [m[:MESSAGE_CHARS] for m in messages]
    return list(results.values())


class Import(typing.NamedTuple):
    """What one genex.import_<what> takes: the helper's import kind, the file extensions, the size cap."""
    kind: str
    extensions: tuple[str, ...]
    max_bytes: int


# genex.import_<what>: what each imports, from which files, up to what size.
IMPORTS = {
    'model': Import('static_mesh', assets.MODELS, 100 * paths.MIB),
    'sound': Import('sound', ('.wav',), 20 * paths.MIB),
    'texture': Import('texture', ('.png', '.jpg', '.jpeg'), 20 * paths.MIB),
}
# Where a part's imports land inside its content folder, so rolling the part back deletes them too.
IMPORTED_FOLDER = 'Imported'
SEVERAL_MESHES = ("It imported as {count} static meshes: join the model's objects into one mesh object at the "
                  'end of its Blender script (bpy.ops.object.join()), model it again and import the new model.glb.')
NO_MAIN_ASSET = 'It imported no {main}, only {made}.'
# How much of each argument a refused import repeats, so apply.py's short error keeps the reason.
SHOWN_CHARS = 100


def _main_asset(made: list[dict], kind: str) -> str:
    """The one asset an import was for (a model's static mesh), or Refused."""
    main = assets.MAIN_CLASS[kind]
    found = [asset['path'] for asset in made if asset['class'] == main]
    if len(found) > 1 and kind == 'static_mesh':
        raise Refused(SEVERAL_MESHES.format(count=len(found)))
    if not found:
        raise Refused(NO_MAIN_ASSET.format(main=main, made=', '.join(sorted({str(a['class']) for a in made}))))
    return found[0]


def import_file(files: PartFiles, what: str, path: object, name: object) -> str:
    """genex.import_<what>: a file of the game folder imported into <folder>/Imported/<name>; the asset path to place.

    Everything is checked before Unreal imports anything; a refusal names the call, so apply.py's
    error says which import failed and why.
    """
    spec = IMPORTS[what]
    try:
        if not paths.is_name(name):
            raise Refused(paths.MESSAGE['name'], name=name)
        source = paths.game_file(paths.part_game(files.folder), path, spec.extensions, spec.max_bytes)
        dest = f'{editor.part_folder(files.part)}/{IMPORTED_FOLDER}/{name}'
        made = assets.import_asset(source, dest, name, spec.kind, '', True)['assets']
        return _main_asset(made, spec.kind)
    except Refused as refusal:
        call = f'genex.import_{what}({repr(path)[:SHOWN_CHARS]}, {repr(name)[:SHOWN_CHARS]})'
        raise Refused(f'{call}: {refusal.message}') from None


def for_part(files: PartFiles) -> types.ModuleType:
    """The `genex` module bound to one part."""
    api = types.ModuleType('genex', __doc__)
    api.part = files.part
    api.folder = editor.part_folder(files.part)
    api.build_part = functools.partial(build_part, files)
    api.blueprint = functools.partial(blueprints.make_blueprint, api.folder)
    api.add_component = blueprints.add_component
    api.write_graph = blueprints.write_graph
    api.compile = compile_or_raise
    api.place = functools.partial(place, files.part)
    api.save = functools.partial(save, files.part)
    api.import_model = functools.partial(import_file, files, 'model')
    api.import_sound = functools.partial(import_file, files, 'sound')
    api.import_texture = functools.partial(import_file, files, 'texture')
    return api
