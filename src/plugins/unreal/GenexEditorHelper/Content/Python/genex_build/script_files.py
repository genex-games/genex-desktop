"""The build scripts run_script takes, checked before anything runs: a .py file of at most
MAX_SCRIPT_BYTES in the game's unreal/build/ folder (or a folder inside it), named relative to that
folder (kit.py, zones/shaft.py) or by its own full path there. Every part of the path below the game
folder is real (no link, so a link can't swap in a file from elsewhere), and the file is a plain
file. The script's arguments are a JSON object. Nothing here runs, imports or writes anything."""

import json
import os
import re

from genex_loop import paths
from genex_loop.errors import Refused

# The folder of the game's build scripts, inside its Unreal project folder.
BUILD_FOLDER = 'build'
SCRIPT_EXTENSION = '.py'
MAX_SCRIPT_BYTES = 256 * 1024
MAX_ARGS_CHARS = 64 * 1024
# A script's path below build/: folders and a file name of letters, digits, _ and -.
SCRIPT_PATH = re.compile(r'([A-Za-z0-9_][A-Za-z0-9_-]{0,63}/){0,6}[A-Za-z0-9_][A-Za-z0-9_-]{0,63}\.py')

MESSAGE = {
    'no_game': ('This Unreal project is not a Genex game\'s unreal/ folder, so it has no unreal/build/ folder '
                'to run scripts from.'),
    'shape': ('file is a .py script in the game\'s unreal/build/ folder, named from there: kit.py or '
              'zones/shaft.py (letters, digits, _ and -; no "..").'),
    'outside': 'The script must be in the game\'s unreal/build/ folder.',
    'link': 'The script\'s path leads through a link; give the script\'s own path in unreal/build/.',
    'missing': 'There is no such script in unreal/build/.',
    'large': f'The script is larger than {MAX_SCRIPT_BYTES // 1024} KB; split it into modules it imports.',
    'args': f'args_json must be a JSON object of at most {MAX_ARGS_CHARS} characters, or empty.',
}


def build_folder(project_dir: str) -> str:
    """The real build folder of the project <game>/unreal (it may not exist yet), or Refused."""
    project = os.path.realpath(project_dir)
    if os.path.basename(project) != paths.GAME_PROJECT_FOLDER:
        raise Refused(MESSAGE['no_game'])
    return os.path.join(project, BUILD_FOLDER)


def _below_build(build: str, file: object) -> str:
    """The script's path relative to the build folder, from a relative or full path; or Refused."""
    if not isinstance(file, str) or not file or '\0' in file or '\\' in file:
        raise Refused(MESSAGE['shape'], file=file)
    relative = file
    if os.path.isabs(file):
        normal = os.path.normpath(file)
        if os.path.commonpath([build, normal]) != build or normal == build:
            raise Refused(MESSAGE['outside'], file=file)
        relative = os.path.relpath(normal, build)
    for prefix in (f'{paths.GAME_PROJECT_FOLDER}/{BUILD_FOLDER}/', f'{BUILD_FOLDER}/'):
        relative = relative[len(prefix):] if relative.startswith(prefix) else relative
    if re.fullmatch(SCRIPT_PATH, relative) is None:
        raise Refused(MESSAGE['shape'], file=file)
    return relative


def script_path(project_dir: str, file: object) -> str:
    """The full real path of a build script (see the module notes), or Refused; reads only metadata."""
    build = build_folder(project_dir)
    relative = _below_build(build, file)
    joined = os.path.join(build, *relative.split('/'))
    if not os.path.lexists(joined):
        raise Refused(MESSAGE['missing'], file=file)
    if os.path.realpath(joined) != joined:
        raise Refused(MESSAGE['link'], file=file)
    if not paths.is_regular_file(joined):
        raise Refused(MESSAGE['missing'], file=file)
    if os.lstat(joined).st_size > MAX_SCRIPT_BYTES:
        raise Refused(MESSAGE['large'], file=file)
    return joined


def scope_name(build: str, script: str) -> str:
    """The script's own scope: its path below build/ without .py (zones/shaft for zones/shaft.py)."""
    return os.path.relpath(script, build)[:-len(SCRIPT_EXTENSION)].replace(os.sep, '/')


def script_args(text: object) -> dict:
    """The script's arguments: a JSON object (empty text is {}), or Refused."""
    if text in ('', None):
        return {}
    if not isinstance(text, str) or len(text) > MAX_ARGS_CHARS:
        raise Refused(MESSAGE['args'])

    def no_constants(constant: str) -> None:
        raise ValueError(f'{constant} is not a number')

    try:
        parsed = json.loads(text, parse_constant=no_constants)
    except ValueError as error:
        raise Refused(f'args_json is not JSON: {error}.') from None
    if not isinstance(parsed, dict):
        raise Refused(MESSAGE['args'])
    return parsed
