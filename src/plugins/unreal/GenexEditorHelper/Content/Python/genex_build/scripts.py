"""run_script: runs a build script of the game, unreal/build/<file>.py, in the open editor with the
full `unreal` module, the `gx` library and `args` (its JSON arguments), in one undo step.

The script is checked first (script_files: in unreal/build/, a .py, no link, at most 256 KB); a
refused one never runs and the editor doesn't change. It runs in its own scope (see scope.py), so
running it again replaces what it made before. Its modules in unreal/build/ import fresh on every
run. It may run for SCRIPT_TIMEOUT_S; past that it stops at its next Python line (an Unreal call
already running finishes first). The answer is {ok, ms, script, output (the end of what it printed),
result (the script's `result`, if it set one), scopes (actors removed and made per scope), actors
(the level's count)} or, when it failed, also {error, where (file:line), line (its text)}. Whatever
it changed before failing stays: fix the script and run it again, or undo in the editor.

A material Unreal fails to compile while the script runs is only a warning in the editor's log, and
the game draws it with the default material: the run reads what the log gained meanwhile, and a
material it changed (unsaved, or saved since it began) that so failed makes it fail too, with
{materials: [{material, instanceOf?, platform, reasons}]}. Others Unreal compiled meanwhile in the
background are only named, under otherMaterials.
"""

import contextlib
import io
import json
import os
import pathlib
import sys
import time
import traceback

import unreal

from genex_build import compile_log, gx, scope, script_files
from genex_loop import editor, editor_log

SCRIPT_TIMEOUT_S = 240.0
# How many traced Python lines pass between looks at the clock.
CLOCK_EVERY = 512
OUTPUT_CHARS = 4000
RESULT_CHARS = 8000
ERROR_CHARS = 600
SCRIPT_NAME = '__genex_build__'
# The most of the editor's log a run reads back for the materials it failed to compile.
LOG_READ_BYTES = 4 * 1024 * 1024
# The navigation bounds a level's nav mesh is built in.
NAV_BOUNDS_CLASS = 'NavMeshBoundsVolume'


class ScriptTimeout(BaseException):
    """Raised inside a script past its time; a BaseException, so the script's own `except Exception` can't keep it."""


@contextlib.contextmanager
def deadline(seconds: float, clock=time.monotonic):
    """Stops the Python code run inside it at its next line once `seconds` have passed."""
    ends = clock() + seconds
    lines = [0]

    def local(frame, event, arg):
        lines[0] += 1
        if lines[0] % CLOCK_EVERY == 0 and clock() > ends:
            raise ScriptTimeout(f'The script ran past {seconds:g} s and was stopped.')
        return local

    def global_(frame, event, arg):
        return local

    previous = sys.gettrace()
    sys.settrace(global_)
    try:
        yield
    finally:
        sys.settrace(previous)


def _below(build: str, file: str | None) -> bool:
    return bool(file) and os.path.realpath(file).startswith(build + os.sep)


def _forget_modules(build: str) -> None:
    for name, module in list(sys.modules.items()):
        if _below(build, getattr(module, '__file__', None)):
            del sys.modules[name]


@contextlib.contextmanager
def build_imports(build: str):
    """The build folder importable by the script, its modules fresh: loaded again on every run."""
    _forget_modules(build)
    sys.path.insert(0, build)
    try:
        yield
    finally:
        while build in sys.path:
            sys.path.remove(build)
        _forget_modules(build)


def failure(error: BaseException, build: str) -> dict:
    """{error, where, line, traceback}: where is the deepest frame in the game's build folder."""
    frames = traceback.extract_tb(error.__traceback__)
    ours = [frame for frame in frames if _below(build, frame.filename)]
    answer = {'error': f'{type(error).__name__}: {error}'.strip()[:ERROR_CHARS]}
    if isinstance(error, SyntaxError) and _below(build, error.filename):
        answer.update({'where': f'{os.path.relpath(error.filename, build)}:{error.lineno}',
                       'line': (error.text or '').strip()})
    elif ours:
        frame = ours[-1]
        answer.update({'where': f'{os.path.relpath(frame.filename, build)}:{frame.lineno}', 'line': (frame.line or '').strip()})
    answer['traceback'] = ''.join(traceback.format_exception(type(error), error, error.__traceback__))[-ERROR_CHARS:]
    return answer


def _result(namespace: dict) -> dict:
    if 'result' not in namespace:
        return {}
    text = json.dumps(namespace['result'], default=str)
    if len(text) <= RESULT_CHARS:
        return {'result': json.loads(text)}
    return {'result': text[:RESULT_CHARS], 'resultTrimmed': True}


def _execute(code, namespace: dict, build: str) -> dict:
    """Runs compiled script code; {} or the failure."""
    try:
        with build_imports(build), deadline(SCRIPT_TIMEOUT_S):
            exec(code, namespace)
    except (Exception, ScriptTimeout, SystemExit) as error:  # noqa: BLE001 - the script's own errors are its answer
        return failure(error, build)
    return {}


def run_script(file: str, args_json: str) -> dict:
    """Runs a build script (see the module notes)."""
    project = editor.project_dir()
    script = script_files.script_path(project, file)
    arguments = script_files.script_args(args_json)
    editor.refuse_during_play()
    build = script_files.build_folder(project)
    name = script_files.scope_name(build, script)
    started = time.perf_counter()
    # Called through their classes, so Genex's Unreal-names check sees standard library calls, not engine ones.
    source = pathlib.Path.read_text(pathlib.Path(script), encoding='utf-8')
    relative = os.path.relpath(script, build)
    try:
        code = compile(source, script, 'exec')
    except SyntaxError as error:
        return {'ok': False, 'ms': editor.elapsed_ms(started), 'script': relative, **failure(error, build)}
    output = io.StringIO()
    namespace = {'__name__': SCRIPT_NAME, '__file__': script, 'unreal': unreal, 'gx': gx, 'args': arguments}
    sys.modules.setdefault('gx', gx)
    log, offset = editor_log.mark()
    since = time.time()
    with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
        with unreal.ScopedEditorTransaction(f'Genex build {name}'):
            scope.begin_run(name)
            problem = _execute(code, namespace, build)
            counts = scope.end_run()
    failed, others = _materials(log, offset, problem, (project, since))
    problem = {**problem, **failed}
    return {'ok': not problem, 'ms': editor.elapsed_ms(started), 'script': relative,
            'output': io.StringIO.getvalue(output)[-OUTPUT_CHARS:], **_result(namespace), **problem, **others,
            'scopes': counts,
            **_navigation(counts), 'actors': len(editor.actors().get_all_level_actors())}


def _materials(log: str | None, offset: int, problem: dict, run: tuple) -> tuple:
    """The materials Unreal failed to compile during the run: ({materials, error?} for those the run changed, the
    script's own error, if any, staying the error; {otherMaterials} for those it didn't), each {} when there are
    none. `run` is (the project's folder, when the run began)."""
    unreal.log_flush()
    failures = compile_log.material_failures(editor_log.read_since(log, offset, LOG_READ_BYTES))
    dirty = set(editor.dirty_packages())
    own = [failure for failure in failures if _changed(failure['material'], dirty, run)]
    others = [failure for failure in failures if failure not in own]
    noted = {'otherMaterials': others} if others else {}
    if not own:
        return {}, noted
    error = {} if 'error' in problem else {'error': compile_log.failure_message(own)}
    return {'materials': own, **error}, noted


def _changed(material: str, dirty: set, run: tuple) -> bool:
    """Whether the run changed a /Game/ material: unsaved now, or its package saved since the run began."""
    if material in dirty:
        return True
    project, since = run
    package = os.path.join(project, 'Content', *material.removeprefix('/Game/').split('/')) + '.uasset'
    try:
        return os.stat(package).st_mtime >= since
    except OSError:
        return False


def _navigation(counts: dict) -> dict:
    """A run that removed or made actors in a level with navigation bounds rebuilds its nav mesh, which would
    otherwise stay stale and leave every AI standing idle; {'navigation': 'rebuilt'}, or {}."""
    changed = any(scoped.get('removed') or scoped.get('made') for scoped in counts.values())
    actors = editor.actors().get_all_level_actors() if changed else []
    if not any(actor.get_class().get_name() == NAV_BOUNDS_CLASS for actor in actors):
        return {}
    world = editor.editor_subsystem().get_editor_world()
    unreal.SystemLibrary.execute_console_command(world, 'RebuildNavigation')
    return {'navigation': 'rebuilt'}
