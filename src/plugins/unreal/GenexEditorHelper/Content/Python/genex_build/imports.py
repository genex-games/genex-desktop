"""Importing the game's own asset files: models (one static mesh per file: its pieces are combined),
characters (a skeletal mesh with its skeleton, physics asset and any clips in the file), animations
onto an existing skeleton, and sounds (.wav, .mp3, .ogg, .flac).

A file is a plain file in the game folder's assets/ or public/assets/ (assets/blender/<job>/,
assets/agents/<id>/), never through a link. Each import lands in its own folder <dest>/<name>/, so two
models never share material names, and it answers the real asset paths Unreal gave (Interchange
names them after the file and its nodes; a path may hold a dash, and the tools take it as is). Imports
never pop the Content Browser over the viewport: Interchange's "select imported assets" switch is
turned off first, so later captures stay clean. Every import runs to the end before it answers.

A rigged .glb whose skeleton hangs under a scaled root (a centimetre Armature at 0.01) is imported
from a copy with that scale baked in (rig_math), written to the project's Saved/Genex/imports/, and
the answer says so (skeletonScale); one the bake can't take still imports, with scaleWarning. A
character's own materials are marked for use on skinned meshes (skinnedMaterials): Unreal otherwise
draws the default grey material in its place in game, though the editor shows the textures.

Importing again into a folder that already holds an import doesn't import over it (Unreal's importer
then imports nothing): the same file, unchanged, answers the first import's answer again (reused),
so a build script that imports can run again; any other file is refused with the way out. What each
folder holds is recorded in Saved/Genex/imports/records.json.
"""

import json
import os
import pathlib
import time
import zlib

import unreal

from genex_build import mesh_math, rig_math
from genex_loop import assets, editor, paths
from genex_loop.errors import Refused, short_message

ASSET_ROOTS = ('assets/', 'public/assets/')
MODEL_MAX_BYTES = 100 * paths.MIB
SOUND_MAX_BYTES = 50 * paths.MIB
SOUNDS = ('.wav', '.mp3', '.ogg', '.flac')
ANIMATIONS = ('.glb', '.gltf', '.fbx')
COLLISIONS = ('box', 'convex', 'complex', 'none')
# Interchange's console switch that selects (and so opens) imported assets in the Content Browser.
BROWSER_SYNC = 'Interchange.FeatureFlags.Import.SyncToBrowser'
CONVEX_HULLS = 8
CONVEX_HULL_VERTS = 16
CONVEX_PRECISION = 100_000
# Where baked copies and the record of each import folder's file go, below the project's Saved/Genex.
IMPORTS_FOLDER = 'imports'
RECORDS_FILE = 'records.json'
GLB = '.glb'
# How many of an occupied folder's assets a refusal names.
NAMED_ASSETS = 4

MESSAGE = {
    'no_game': ('This Unreal project is not a Genex game\'s unreal/ folder, so it has no assets folder to '
                'import from.'),
    'not_assets': ('The file must be a file in the game folder\'s assets/ (or public/assets/), such as '
                   'assets/blender/<job>/model.glb.'),
    'collision': f'collision must be one of {", ".join(COLLISIONS)}.',
    'nanite': 'nanite must be true or false.',
    'nothing': 'Unreal imported nothing from this file; see the editor log.',
    'no_main': 'It imported no {main}, only {made}.',
    'skeleton': 'skeleton must be an existing Skeleton asset (the one import_character answered).',
    'skeleton_scale': ('This file\'s skeleton is scaled {scale} at its root (an exporter\'s centimetre Armature, or '
                       'a root bone left at that scale), so Unreal imported it that many times too small or large. '
                       'Genex takes that scale out of a .glb whose scale is the same on every axis, but not out of this '
                       'file: export the character as such a .glb (Genex\'s Blender plugin with rig on applies the '
                       'scale as it exports) and import that.'),
    'taken': ('{folder} already holds an earlier import of another file ({assets}), and importing over it imports '
              'nothing. Import this file under a new name (such as {name}_2) and point the level and the build scripts '
              'at the new asset; delete the old folder in a build script (unreal.EditorAssetLibrary.delete_directory) '
              'once nothing uses it.'),
    'playing': ('A play session is running, and an import or retarget during play makes only part of the asset (a '
                'Skeleton without its mesh, a mesh without triangles). Call release_all, then StopPIE, then try again.'),
}


def refuse_during_play() -> None:
    """Refused while a play session runs: Unreal can't import a skeletal mesh at runtime, and says so only in its log."""
    if editor.play_world() is not None:
        raise Refused(MESSAGE['playing'])


def game_folder() -> str:
    """The real game folder holding this project (<game>/unreal), or Refused."""
    project = os.path.realpath(editor.project_dir())
    if os.path.basename(project) != paths.GAME_PROJECT_FOLDER:
        raise Refused(MESSAGE['no_game'])
    return os.path.dirname(project)


def game_asset(file: object, extensions: tuple, max_bytes: int) -> str:
    """The real path of a file in the game's assets, given relative to the game folder or as its own full path."""
    game = game_folder()
    relative = file
    if isinstance(file, str) and os.path.isabs(file):
        normal = os.path.normpath(file)
        inside = os.path.commonpath([game, normal]) == game
        relative = os.path.relpath(normal, game) if inside else file
    if not isinstance(relative, str) or not relative.startswith(ASSET_ROOTS):
        raise Refused(MESSAGE['not_assets'], file=file)
    return paths.game_file(game, relative, extensions, max_bytes)


def check_import(dest: object, name: object) -> str:
    """The import's own folder <dest>/<name>, or Refused (also while a play session runs)."""
    refuse_during_play()
    paths.check_content_path(dest)
    if not paths.is_name(name):
        raise Refused(paths.MESSAGE['name'], name=name)
    return f'{dest}/{name}'


def _imports_folder() -> str:
    return os.path.join(editor.project_dir(), *paths.GENEX_FOLDER, IMPORTS_FOLDER)


def _records() -> dict:
    """{content folder: {file, fingerprint, answer}} of the imports made so far; {} when unreadable."""
    try:
        with open(os.path.join(_imports_folder(), RECORDS_FILE), encoding='utf-8') as handle:
            found = json.load(handle)
    except (OSError, ValueError):
        return {}
    return found if isinstance(found, dict) else {}


def _write_file(path: str, data: bytes) -> None:
    """Writes `data` to `path` whole: a reader never sees half a file."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temporary = f'{path}.partial'
    # Called through their classes, so Genex's Unreal-names check sees standard library calls, not engine ones.
    pathlib.Path.write_bytes(pathlib.Path(temporary), data)
    os.replace(temporary, path)


def _record(folder: str, source: str, digest: str, answer: dict) -> None:
    records = _records()
    records[folder] = {'file': source, 'fingerprint': digest, 'answer': answer}
    _write_file(os.path.join(_imports_folder(), RECORDS_FILE), json.dumps(records, indent=1).encode('utf-8'))


def _read(file: str) -> bytes:
    return pathlib.Path.read_bytes(pathlib.Path(file))


def _digest(file: str) -> str:
    """The file's size and CRC-32: what tells the same file, unchanged, from any other."""
    data = _read(file)
    return f"{len(data)}:{zlib.crc32(data):08x}"


def _main_asset(answer: dict) -> str | None:
    return answer.get('asset') or answer.get('mesh') or next((a['path'] for a in answer.get('animations', [])), None)


def earlier_import(folder: str, name: str, digest: str) -> dict | None:
    """The answer to give again when `folder` already holds this same file's import (reused), None when the folder
    holds nothing yet; Refused when it holds anything else (see the module notes)."""
    held = [str(path).split('.')[0] for path in unreal.EditorAssetLibrary.list_assets(folder, True, False)]
    if not held:
        return None
    record = _records().get(folder) or {}
    answer = record.get('answer')
    same = record.get('fingerprint') == digest and isinstance(answer, dict)
    if same and unreal.EditorAssetLibrary.does_asset_exist(_main_asset(answer) or ''):
        return {**answer, 'reused': True}
    listed = ', '.join(held[:NAMED_ASSETS]) + (', ...' if len(held) > NAMED_ASSETS else '')
    raise Refused(MESSAGE['taken'].format(folder=folder, assets=listed, name=name), folder=folder)


def check_collision(collision: object, nanite: object) -> None:
    """Refused unless collision is one of COLLISIONS and nanite a bool."""
    if collision not in COLLISIONS:
        raise Refused(MESSAGE['collision'], collision=collision)
    if not isinstance(nanite, bool):
        raise Refused(MESSAGE['nanite'], nanite=nanite)


def quiet_browser() -> None:
    """Stops imports from selecting (and so opening) their assets in the Content Browser."""
    unreal.SystemLibrary.execute_console_command(None, f'{BROWSER_SYNC} 0')


def _stack(pipeline) -> unreal.InterchangePipelineStackOverride:
    stack = unreal.InterchangePipelineStackOverride()
    stack.add_pipeline(pipeline)
    return stack


def model_pipeline(nanite: bool) -> unreal.InterchangeGenericAssetsPipeline:
    """Interchange's generic pipeline for one static mesh per file: every piece combined, no animation."""
    pipeline = unreal.InterchangeGenericAssetsPipeline()
    meshes = pipeline.get_editor_property('mesh_pipeline')
    meshes.set_editor_property('import_static_meshes', True)
    meshes.set_editor_property('import_skeletal_meshes', False)
    meshes.set_editor_property('combine_static_meshes_behavior', unreal.InterchangeCombineStaticMeshesBehavior.ALL)
    meshes.set_editor_property('build_nanite', nanite)
    pipeline.get_editor_property('animation_pipeline').set_editor_property('import_animations', False)
    return pipeline


def character_pipeline() -> unreal.InterchangeGenericAssetsPipeline:
    """Interchange's generic pipeline for a rigged character: its skeletal mesh, skeleton, physics asset and clips."""
    pipeline = unreal.InterchangeGenericAssetsPipeline()
    meshes = pipeline.get_editor_property('mesh_pipeline')
    meshes.set_editor_property('import_skeletal_meshes', True)
    meshes.set_editor_property('create_physics_asset', True)
    pipeline.get_editor_property('animation_pipeline').set_editor_property('import_animations', True)
    return pipeline


def animation_pipeline(skeleton: unreal.Skeleton) -> unreal.InterchangeGenericAssetsPipeline:
    """Interchange's generic pipeline for clips only, onto an existing skeleton."""
    pipeline = unreal.InterchangeGenericAssetsPipeline()
    common = pipeline.get_editor_property('common_skeletal_meshes_and_animations_properties')
    common.set_editor_property('skeleton', skeleton)
    common.set_editor_property('import_only_animations', True)
    pipeline.get_editor_property('animation_pipeline').set_editor_property('import_animations', True)
    return pipeline


def run_import(source: str, folder: str, pipeline=None) -> list[str]:
    """Imports one file into `folder` to the end (one undo step); the object paths it made, or Refused."""
    quiet_browser()
    task = unreal.AssetImportTask()
    task.set_editor_property('filename', source)
    task.set_editor_property('destination_path', folder)
    task.set_editor_property('automated', True)
    task.set_editor_property('replace_existing', True)
    task.set_editor_property('save', True)
    task.set_editor_property('async_', False)
    if pipeline is not None:
        task.set_editor_property('options', _stack(pipeline))
    try:
        unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])
    except Exception as error:  # noqa: BLE001 - Interchange and the asset tools raise RuntimeError and others
        raise Refused(f'The import failed: {short_message(error)}', file=source) from None
    made = [str(path).split('.')[0] for path in task.get_editor_property('imported_object_paths')]
    if not made:
        raise Refused(MESSAGE['nothing'], file=source)
    return made


def _of_class(made: list[str], cls) -> list:
    return [asset for asset in (unreal.load_asset(path) for path in made) if isinstance(asset, cls)]


def _main(made: list[str], cls, main: str):
    found = _of_class(made, cls)
    if not found:
        classes = sorted({assets.describe(path)['class'] or '?' for path in made})
        raise Refused(MESSAGE['no_main'].format(main=main, made=', '.join(classes)))
    return found[0]


def _bounds(mesh) -> list:
    box = mesh.get_bounding_box()
    return [round(box.max.x - box.min.x), round(box.max.y - box.min.y), round(box.max.z - box.min.z)]


def set_collision(mesh: unreal.StaticMesh, collision: str) -> None:
    """Gives a static mesh its collision: simple boxes, convex hulls, its own triangles, or none."""
    subsystem = unreal.get_editor_subsystem(unreal.StaticMeshEditorSubsystem)
    subsystem.remove_collisions(mesh)
    setup = mesh.get_editor_property('body_setup')
    if collision == 'box':
        subsystem.add_simple_collisions(mesh, unreal.ScriptCollisionShapeType.BOX)
    elif collision == 'convex':
        subsystem.set_convex_decomposition_collisions(mesh, CONVEX_HULLS, CONVEX_HULL_VERTS, CONVEX_PRECISION)
    if setup is not None:
        flag = 'CTF_USE_COMPLEX_AS_SIMPLE' if collision == 'complex' else 'CTF_USE_DEFAULT'
        setup.set_editor_property('collision_trace_flag', getattr(unreal.CollisionTraceFlag, flag))


def set_nanite(mesh: unreal.StaticMesh, enabled: bool) -> None:
    """Turns Nanite on or off for a static mesh and rebuilds it."""
    subsystem = unreal.get_editor_subsystem(unreal.StaticMeshEditorSubsystem)
    settings = subsystem.get_nanite_settings(mesh)
    settings.set_editor_property('enabled', enabled)
    subsystem.set_nanite_settings(mesh, settings, True)


def import_model(file: str, dest: str, name: str, collision: str, nanite: bool) -> dict:
    """One static mesh from a model file of the game's assets (see the module notes)."""
    folder = check_import(dest, name)
    check_collision(collision, nanite)
    source = game_asset(file, assets.MODELS, MODEL_MAX_BYTES)
    digest = _digest(source)
    again = earlier_import(folder, name, digest)
    if again is not None:
        return again
    started = time.perf_counter()
    made = run_import(source, folder, model_pipeline(nanite))
    mesh = _main(made, unreal.StaticMesh, 'StaticMesh')
    set_nanite(mesh, nanite)
    set_collision(mesh, collision)
    unreal.EditorAssetLibrary.save_loaded_asset(mesh, False)
    answer = {'asset': mesh.get_path_name().split('.')[0], 'class': 'StaticMesh', 'folder': folder,
              'sourceTriangles': mesh_math.source_triangles(source), 'naniteTriangles': mesh.get_num_nanite_triangles(),
              'fallbackTriangles': mesh.get_num_triangles(0), 'boundsCm': _bounds(mesh), 'collision': collision,
              'nanite': nanite, 'meshes': len(_of_class(made, unreal.StaticMesh))}
    _record(folder, source, digest, answer)
    return {**answer, 'ms': editor.elapsed_ms(started)}


def _paths(found: list) -> list[str]:
    return [asset.get_path_name().split('.')[0] for asset in found]


def rig_source(source: str, folder: str) -> tuple[str, dict]:
    """(the file to import, what the answer adds): a .glb whose skeleton is scaled at its root is imported from a
    copy with the scale baked in, under Saved/Genex/imports/<folder below /Game>/ ({skeletonScale}); a file the bake
    can't take is imported as it is ({scaleWarning}); any other file as it is ({})."""
    counter = mesh_math.source_counter_scale(source)
    if counter == 1.0:
        return source, {}
    baked = None
    if source.lower().endswith(GLB):
        baked = rig_math.bake(_read(source))
    if baked is None:
        return source, {'scaleWarning': MESSAGE['skeleton_scale'].format(scale=round(1 / counter, 4))}
    data, taken = baked
    copy = os.path.join(_imports_folder(), *folder.split('/')[2:], os.path.basename(source))
    _write_file(copy, data)
    return copy, {'skeletonScale': {'baked': round(taken, 6), 'file': copy}}


def skinned_materials(mesh) -> list[str]:
    """The game's own base materials on a skeletal mesh that weren't marked for skinned meshes, marked and
    saved; Unreal draws the default material in game for one without that flag. Engine materials are left."""
    library = unreal.MaterialEditingLibrary
    usage = unreal.MaterialUsage.MATUSAGE_SKELETAL_MESH
    marked: list[str] = []
    for slot in mesh.get_editor_property('materials'):
        material = slot.get_editor_property('material_interface')
        base = material.get_base_material() if material else None
        if base is None or not base.get_path_name().startswith('/Game/') or library.has_material_usage(base, usage):
            continue
        if library.set_material_usage(base, usage):
            library.recompile_material(base)
        unreal.EditorAssetLibrary.save_loaded_asset(base, False)
        marked.append(base.get_path_name())
    return marked


def import_character(file: str, dest: str, name: str) -> dict:
    """A rigged character from a model file of the game's assets: its skeletal mesh, skeleton, physics asset and clips."""
    folder = check_import(dest, name)
    source = game_asset(file, assets.MODELS, MODEL_MAX_BYTES)
    digest = _digest(source)
    again = earlier_import(folder, name, digest)
    if again is not None:
        return again
    started = time.perf_counter()
    imported, rig = rig_source(source, folder)
    made = run_import(imported, folder, character_pipeline())
    mesh = _main(made, unreal.SkeletalMesh, 'SkeletalMesh')
    skeleton = mesh.get_editor_property('skeleton')
    physics = mesh.get_editor_property('physics_asset')
    extent = mesh.get_bounds().box_extent
    clips = _of_class(made, unreal.AnimSequence)
    skinned = skinned_materials(mesh)
    answer = {'mesh': _paths([mesh])[0], 'skeleton': _paths([skeleton])[0] if skeleton else None,
              'physicsAsset': _paths([physics])[0] if physics else None,
              'boundsCm': [round(extent.x * 2), round(extent.y * 2), round(extent.z * 2)],
              'animations': [{'path': p, 'seconds': round(c.get_play_length(), 2)} for p, c in zip(_paths(clips), clips)],
              'folder': folder, **rig, **({'skinnedMaterials': skinned} if skinned else {})}
    _record(folder, source, digest, answer)
    return {**answer, 'ms': editor.elapsed_ms(started)}


def import_animation(file: str, skeleton: str, dest: str, name: str) -> dict:
    """The clips of a file of the game's assets, onto an existing skeleton."""
    folder = check_import(dest, name)
    target = unreal.load_asset(skeleton) if isinstance(skeleton, str) and skeleton.startswith('/Game/') else None
    if not isinstance(target, unreal.Skeleton):
        raise Refused(MESSAGE['skeleton'], skeleton=skeleton)
    source = game_asset(file, ANIMATIONS, MODEL_MAX_BYTES)
    digest = _digest(source)
    again = earlier_import(folder, name, digest)
    if again is not None:
        return again
    started = time.perf_counter()
    imported, rig = rig_source(source, folder)
    made = run_import(imported, folder, animation_pipeline(target))
    clips = _of_class(made, unreal.AnimSequence)
    if not clips:
        _main(made, unreal.AnimSequence, 'AnimSequence')
    answer = {'animations': [{'path': p, 'seconds': round(c.get_play_length(), 2)} for p, c in zip(_paths(clips), clips)],
              'skeleton': _paths([target])[0], 'folder': folder, **rig}
    _record(folder, source, digest, answer)
    return {**answer, 'ms': editor.elapsed_ms(started)}


def import_sound(file: str, dest: str, name: str) -> dict:
    """A sound wave from a .wav, .mp3, .ogg or .flac file of the game's assets."""
    folder = check_import(dest, name)
    source = game_asset(file, SOUNDS, SOUND_MAX_BYTES)
    digest = _digest(source)
    again = earlier_import(folder, name, digest)
    if again is not None:
        return again
    started = time.perf_counter()
    made = run_import(source, folder)
    sound = _main(made, unreal.SoundWave, 'SoundWave')
    answer = {'asset': _paths([sound])[0], 'seconds': round(sound.get_editor_property('duration'), 2), 'folder': folder}
    _record(folder, source, digest, answer)
    return {**answer, 'ms': editor.elapsed_ms(started)}
