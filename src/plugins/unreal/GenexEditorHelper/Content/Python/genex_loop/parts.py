"""Applying a part, rolling it back and tracing what it left.

A part owns the content folder /Game/Parts/<Part>/ and the level actors tagged GenexPart:<Part>
in the Outliner folder Parts/<Part>. The template map is World Partition, one file per actor, so
a part's actors are its own files and a rollback is: destroy them, save, delete the folder; the
host then restores the files with git and reloads the level.
"""

import contextlib
import io
import time
import traceback

import unreal

from genex_loop import editor, part_api, part_files, paths
from genex_loop.errors import short_message

OUTPUT_TAIL = 4096
TRACEBACK_TAIL = 2048
# How much of the compiler's messages a refused part's error carries back to its builder.
COMPILE_WHY_CHARS = 1200
SCRIPT_NAME = '__genex_part__'


def _run_script(files: part_files.PartFiles, api) -> dict:
    """Runs apply.py; an exception in it becomes {ok: false, error, traceback}."""
    namespace = {'__name__': SCRIPT_NAME, '__file__': files.script, 'unreal': unreal, 'part': files.part, 'genex': api}
    try:
        exec(compile(files.source, files.script, 'exec'), namespace)
    except (Exception, SystemExit) as error:  # noqa: BLE001 - the builder's script, not ours
        frames = traceback.format_exception(type(error), error, error.__traceback__.tb_next)
        lines = [f.lineno for f in traceback.extract_tb(error.__traceback__) if f.filename == files.script]
        where = f' (apply.py line {lines[-1]})' if lines else ''
        return {'ok': False, 'error': f'{type(error).__name__}: {error}'.strip()[:400] + where,
                'traceback': ''.join(frames)[-TRACEBACK_TAIL:]}
    return {'ok': True}


def _build_then_run(files: part_files.PartFiles, api) -> tuple[dict, list[dict]]:
    built = api.build_part()
    failed = [b for b in built if not b['compiled']]
    if failed:
        names = ', '.join(b['name'] for b in failed)
        why = '; '.join(m for b in failed for m in b['messages'])[:COMPILE_WHY_CHARS]
        return {'ok': False, 'error': f'{names} did not compile: {why}. apply.py did not run.'}, built
    return _run_script(files, api), built


def _save(api) -> dict:
    try:
        api.save()
    except Exception as error:  # noqa: BLE001 - the editor refusing to save
        return {'ok': False, 'error': f'Saving the part failed: {short_message(error)}'}
    return {'ok': True}


def apply_part(script: str, part: str) -> dict:
    """Builds part.json's Blueprints, runs apply.py in one undo step, then saves; see GenexLoopTools."""
    files = part_files.load(script, part)
    editor.refuse_during_play()
    started = time.perf_counter()
    api = part_api.for_part(files)
    output = io.StringIO()
    with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
        with unreal.ScopedEditorTransaction(f'Genex part {files.part}'):
            result, built = _build_then_run(files, api)
        if result['ok']:
            result = _save(api)
    result.update({'ms': editor.elapsed_ms(started), 'output': output.getvalue()[-OUTPUT_TAIL:], 'blueprints': built,
                   'assets': editor.folder_assets(editor.part_folder(files.part)),
                   'actors': [a.get_actor_label() for a in editor.part_actors(files.part)]})
    return result


def rollback_part(part: str) -> dict:
    """Destroys the part's actors, saves the level and deletes the part's folder."""
    paths.check_part(part)
    editor.refuse_during_play()
    started = time.perf_counter()
    found = editor.part_actors(part)
    removed = [actor.get_actor_label() for actor in found]
    for actor in found:
        editor.actors().destroy_actor(actor)
    if found:
        editor.levels().save_current_level()
    folder = editor.part_folder(part)
    deleted = unreal.EditorAssetLibrary.does_directory_exist(folder) and unreal.EditorAssetLibrary.delete_directory(folder)
    return {'removed': removed, 'deletedFolder': bool(deleted), 'ms': editor.elapsed_ms(started)}


def save_all() -> dict:
    """Saves every unsaved level and asset without asking, before Genex quits Unreal (adding the
    game's C++ module); {saved, dirty, ms}: dirty names what is still unsaved."""
    editor.refuse_during_play()
    started = time.perf_counter()
    saved = unreal.EditorLoadingAndSavingUtils.save_dirty_packages(True, True)
    return {'saved': bool(saved), 'dirty': editor.dirty_packages(), 'ms': editor.elapsed_ms(started)}


def reload_level() -> dict:
    """Loads the current level again from its files (after the host restored them)."""
    editor.refuse_during_play()
    started = time.perf_counter()
    level = editor.editor_subsystem().get_editor_world().get_path_name().split('.')[0]
    reloaded = editor.levels().load_level(level)
    return {'level': level, 'reloaded': bool(reloaded), 'actors': len(editor.actors().get_all_level_actors()),
            'ms': editor.elapsed_ms(started)}


def part_trace(part: str) -> dict:
    """What of the part is in the editor: its actors, its assets, its folder and unsaved packages."""
    paths.check_part(part)
    folder = editor.part_folder(part)
    return {'part': part, 'actors': [a.get_actor_label() for a in editor.part_actors(part)],
            'assets': editor.folder_assets(folder),
            'folderExists': bool(unreal.EditorAssetLibrary.does_directory_exist(folder)),
            'dirty': editor.dirty_packages()}
