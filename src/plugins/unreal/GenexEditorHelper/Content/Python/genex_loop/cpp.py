"""Hot reload of the game's own C++ module while the editor stays open, for a C++ part: once the
queue has copied the part's sources into the game, recompile_module has Unreal compile the module
with UBT and load the new library (`Module Recompile <Module>`, which blocks: 11 to 19 s on a Mac),
then checks that the part's classes load.

Unreal gives each hot-reloaded library a fresh suffix (Binaries/Mac/libUnrealEditor-<Module>-1234.dylib)
and writes none when the compile fails, so a new one is the proof the module compiled; an error the
reload logs after it means the new code isn't live. The compiler's and the hot reload's error lines
come from the editor's log, read from where it ended when the call began (none when the log shrank
meanwhile), with the project's paths from Source/ on and the owner's home folder as ~.
"""

import os
import re
import sys
import time

import unreal

from genex_loop import editor, editor_log, paths
from genex_loop.errors import Refused, short_message

# A module or class name as Unreal's /Script/<Module>.<Class> path spells it (no A/U prefix).
IDENTIFIER = re.compile(r'[A-Za-z][A-Za-z0-9_]{0,63}')
CLASSES_CAP = 32
RECOMPILE_COMMAND = 'Module Recompile'
SOURCE_FOLDER = 'Source'
# Hot reload on a Mac: the editor's libraries, and the one a hot reload writes for <module>.
MAC_PLATFORM = 'darwin'
BINARIES = ('Binaries', 'Mac')
HOT_LIBRARY = 'libUnrealEditor-{module}-[0-9]+[.]dylib'
LOG_LINES_CAP = 20
LOG_LINE_CHARS = 500
# A hot reload logs about 11 kB (as measured on 5.8.3), a failed compile a little more; past this nothing is read.
LOG_READ_BYTES = 1024 * 1024
# The lines kept from the log: the compiler's errors and the hot reload's own lines.
LOG_MARKS = ('error', 'Error:', 'LogHotReload')
# A log line's time stamp and frame, and the category the editor repeats the compiler's output under.
LOG_PREFIX = re.compile(r'(\[[^\]]*\]\[ *\d+\])?(CompilerResultsLog: )?')
# An error the editor logs in its own format (`LogHotReload: Error: ...`): after a new library, the
# reload failed and the old code still runs. The compiler's own errors are lowercase (`error:`).
RELOAD_ERROR = re.compile(r'^\w+: Error:')

MESSAGE = {
    'module': 'A module name is a letter, then up to 63 letters, digits or _.',
    'not_module': "The project has no such C++ module: Source/<module>/<module>.Build.cs, a plain file.",
    'classes': (f'classes is a list of at most {CLASSES_CAP} class names, each a letter, then up to 63 '
                'letters, digits or _ (without the A or U prefix).'),
    'play': 'A play session is running, and hot reload during play is not allowed; stop it first (stop_play).',
    'platform': "Hot reload of the game's C++ module works on a Mac only.",
}


def _check_classes(classes: object) -> list[str]:
    """The class names as a list, or Refused. The editor hands a list argument over as unreal.Array."""
    if not isinstance(classes, (list, tuple, unreal.Array)):
        raise Refused(MESSAGE['classes'], classes=classes)
    names = list(classes)
    if len(names) > CLASSES_CAP:
        raise Refused(MESSAGE['classes'], count=len(names))
    for name in names:
        if not paths.is_name(name, IDENTIFIER):
            raise Refused(MESSAGE['classes'], className=name)
    return names


def _check_module(module: object) -> str:
    """The name of one of the project's own C++ modules, or Refused.

    Its rules file Source/<module>/<module>.Build.cs must be a plain file at that real path, so an
    engine module's name or a module folder linked in from elsewhere is refused.
    """
    if not paths.is_name(module, IDENTIFIER):
        raise Refused(MESSAGE['module'], module=module)
    project = editor.project_dir()
    rules = os.path.join(SOURCE_FOLDER, module, f'{module}.Build.cs')
    expected = os.path.join(os.path.realpath(project), rules)
    if os.path.realpath(os.path.join(project, rules)) != expected or not paths.is_regular_file(expected):
        raise Refused(MESSAGE['not_module'], module=module)
    return module


def _hot_libraries(module: str) -> dict[str, int]:
    """The module's hot-reloaded libraries (plain files only) by name, with their modification times."""
    pattern = re.compile(HOT_LIBRARY.format(module=module))
    found: dict[str, int] = {}
    try:
        with os.scandir(os.path.join(editor.project_dir(), *BINARIES)) as entries:
            for entry in entries:
                if pattern.fullmatch(entry.name) and entry.is_file(follow_symlinks=False):
                    found[entry.name] = entry.stat(follow_symlinks=False).st_mtime_ns
    except OSError:  # no Binaries/Mac yet
        return {}
    return found


def _compiled(module: str, before: dict[str, int]) -> bool:
    """Whether a hot-reloaded library appeared, or one was written again, since `before`."""
    return any(name not in before or written > before[name] for name, written in _hot_libraries(module).items())


def _home_pattern() -> re.Pattern | None:
    """The owner's home folder where it starts a path (not a longer name), or None without one."""
    home = os.path.expanduser('~').rstrip('/')
    return re.compile(re.escape(home) + r'(?![\w.-])') if home else None


def _project_pattern() -> re.Pattern:
    """The project's folder and the slash after it, as given and by real path, where a path starts."""
    project = editor.project_dir().rstrip('/')
    spellings = sorted({project, os.path.realpath(project)}, key=len, reverse=True)
    return re.compile(r'(?<![\w.~/-])(?:' + '|'.join(re.escape(spelling) for spelling in spellings) + ')/')


def _shown(line: str, project: re.Pattern, home: re.Pattern | None) -> str:
    """A log line as the answer shows it: the project's paths relative to it (Source/...), the
    owner's home folder written as ~, cut short."""
    line = project.sub('', line)
    return (home.sub('~', line) if home else line)[:LOG_LINE_CHARS]


def _log_lines(file: str | None, offset: int) -> list[str]:
    """The error and hot reload lines the log gained after `offset`, once each, without time stamps;
    none when the log is shorter than `offset` (a new log replaced it: nothing to tell this call's
    lines from an older session's)."""
    kept: list[str] = []
    for raw in editor_log.read_since(file, offset, LOG_READ_BYTES).splitlines():
        if not any(mark in raw for mark in LOG_MARKS):
            continue
        line = raw[LOG_PREFIX.match(raw).end():].strip()
        if line and line not in kept:
            kept.append(line)
    return kept


def _recompile(module: str) -> str:
    """Runs Unreal's hot reload of the module, which returns when it compiled and reloaded or
    failed; '' or the engine's own error, which is an answer, never a failure of the tool."""
    try:
        unreal.SystemLibrary.execute_console_command(None, f'{RECOMPILE_COMMAND} {module}')
    except RuntimeError as error:
        return short_message(error)
    return ''


def _loads(module: str, name: str) -> bool:
    """Whether the module's class `name` is loaded in the editor now."""
    try:
        return unreal.load_class(None, f'/Script/{module}.{name}') is not None
    except RuntimeError:
        return False


def recompile_module(module: str, classes: list[str]) -> dict:
    """{ok, compiled, ms, missing, log}: ok when a new library compiled, the reload logged no error
    and every class loads."""
    started = time.perf_counter()
    _check_module(module)
    names = _check_classes(classes)
    if sys.platform != MAC_PLATFORM:
        raise Refused(MESSAGE['platform'], module=module)
    if editor.play_world() is not None:
        raise Refused(MESSAGE['play'], module=module)
    before = _hot_libraries(module)
    log, offset = editor_log.mark()
    failure = _recompile(module)
    unreal.log_flush()
    compiled = _compiled(module, before)
    missing = [name for name in names if not _loads(module, name)]
    lines = ([failure] if failure else []) + _log_lines(log, offset)
    reload_failed = any(RELOAD_ERROR.match(line) for line in lines)
    project, home = _project_pattern(), _home_pattern()
    return {'ok': compiled and not missing and not reload_failed, 'compiled': compiled,
            'ms': editor.elapsed_ms(started), 'missing': missing,
            'log': [_shown(line, project, home) for line in lines[:LOG_LINES_CAP]]}
