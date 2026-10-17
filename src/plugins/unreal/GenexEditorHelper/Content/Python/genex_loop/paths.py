"""The names and paths the loop tools accept. Builders write part folders and the host passes
paths on, so every name is checked against a pattern and every path by its real path before
anything runs or is written."""

import os
import re
import stat

from genex_loop.errors import Refused

PART_NAME = re.compile(r'[A-Za-z][A-Za-z0-9_]{0,63}')
CAPTURE_NAME = re.compile(r'[A-Za-z0-9_-]{1,64}')
CONTENT_PATH = re.compile(r'/Game(/[A-Za-z0-9_]{1,64}){1,12}')
OBJECT_PATH = re.compile(r'/Game(/[A-Za-z0-9_]{1,64}){1,12}(\.[A-Za-z0-9_]{1,64})?')
PART_SCRIPT = 'apply.py'
PARTS_FOLDER = 'parts'
GENEX_FOLDER = ('Saved', 'Genex')
# The game folder's Unreal project: a part is <game>/unreal/parts/<Part>/.
GAME_PROJECT_FOLDER = 'unreal'
MIB = 1024 * 1024

MESSAGE = {
    'part': 'A part name is a letter, then up to 63 letters, digits or _.',
    'name': 'A name is a letter, then up to 63 letters, digits or _.',
    'capture': 'A capture name is 1 to 64 letters, digits, _ or -.',
    'absolute': 'The path must be absolute.',
    'dots': 'The path must not contain "..".',
    'script': 'A part script is parts/<part>/apply.py.',
    'link': 'The path leads through a link; give the real path.',
    'not_file': 'There is no such file.',
    'inside': 'The file must be inside the project\'s Saved/Genex folder.',
    'content': 'The destination must be a /Game/ folder of letters, digits and _.',
    'object': 'The asset must be a /Game/ path of letters, digits and _.',
    'game_relative': ('The file is a path relative to the game folder, with / between folders, '
                      'such as the model.glb path blender__model returned.'),
    'game_link': 'The path leads through a link; give the file\'s own path in the game folder.',
    'game_part': 'Only a part in the game\'s unreal/parts/<Part>/ imports files from the game folder.',
}


def is_name(value: object, pattern: re.Pattern = PART_NAME) -> bool:
    """Whether a value is a string matching the pattern exactly."""
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def check_part(part: object) -> str:
    """The part name, or Refused."""
    if not is_name(part):
        raise Refused(MESSAGE['part'], part=part)
    return part


def check_capture_name(name: object) -> str:
    """The capture's file stem, or Refused; a capture name is never a path."""
    if not is_name(name, CAPTURE_NAME):
        raise Refused(MESSAGE['capture'], name=name)
    return name


def check_content_path(path: object) -> str:
    """A /Game/ folder path, or Refused."""
    if not is_name(path, CONTENT_PATH):
        raise Refused(MESSAGE['content'], dest=path)
    return path


def check_object_path(path: object, field: str) -> str:
    """A /Game/ asset path (optionally with .Object), or Refused."""
    if not is_name(path, OBJECT_PATH):
        raise Refused(MESSAGE['object'], **{field: path})
    return path


def _absolute(path: object, field: str) -> str:
    if not isinstance(path, str) or not path or '\0' in path or not os.path.isabs(path):
        raise Refused(MESSAGE['absolute'], **{field: path})
    if '..' in path.replace('\\', '/').split('/'):
        raise Refused(MESSAGE['dots'], **{field: path})
    return path


def is_regular_file(path: str) -> bool:
    """Whether the path itself (not a link) is a regular file."""
    try:
        return stat.S_ISREG(os.lstat(path).st_mode)
    except OSError:
        return False


def part_script(script: object, part: object) -> str:
    """The real path of a part's apply.py, or Refused without touching it.

    The script must be <base>/parts/<part>/apply.py where only <base> may lead through links:
    parts, the part folder and apply.py are themselves real, so a link can't swap in a file
    from elsewhere.
    """
    check_part(part)
    given = _absolute(script, 'script')
    folder = os.path.dirname(given)
    parts = os.path.dirname(folder)
    shaped = (os.path.basename(given) == PART_SCRIPT and os.path.basename(folder) == part
              and os.path.basename(parts) == PARTS_FOLDER)
    if not shaped:
        raise Refused(MESSAGE['script'], script=script)
    expected = os.path.join(os.path.realpath(os.path.dirname(parts)), PARTS_FOLDER, part, PART_SCRIPT)
    if not os.path.lexists(given):
        raise Refused(MESSAGE['not_file'], script=script)
    if os.path.realpath(given) != expected:
        raise Refused(MESSAGE['link'], script=script)
    if not is_regular_file(expected):
        raise Refused(MESSAGE['not_file'], script=script)
    return expected


def folder_file(folder: str, name: str) -> str | None:
    """A file in a part's real folder: its path, None when missing, Refused when a link or not a file."""
    path = os.path.join(folder, name)
    if not os.path.lexists(path):
        return None
    if os.path.realpath(path) != path or not is_regular_file(path):
        raise Refused(f'{name} must be a plain file in the part folder.', file=name)
    return path


def inside_genex_folder(file: object, project_dir: str) -> str:
    """The real path for a file under <project>/Saved/Genex (created), or Refused."""
    given = _absolute(file, 'file')
    root = os.path.join(project_dir, *GENEX_FOLDER)
    os.makedirs(root, exist_ok=True)
    root = os.path.realpath(root)
    target = os.path.realpath(given)
    if target == root or os.path.commonpath([root, target]) != root:
        raise Refused(MESSAGE['inside'], file=file)
    if os.path.lexists(target) and not is_regular_file(target):
        raise Refused(MESSAGE['not_file'], file=file)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    return target


def part_game(part_folder: str) -> str:
    """The game folder holding a part's real folder (<game>/unreal/parts/<Part>), or Refused."""
    project = os.path.dirname(os.path.dirname(part_folder))
    if os.path.basename(project) != GAME_PROJECT_FOLDER:
        raise Refused(MESSAGE['game_part'], folder=part_folder)
    return os.path.dirname(project)


def _relative(file: object) -> str:
    """A path relative to the game folder: a non-empty string, never absolute, no backslash, NUL or ".."."""
    plain = isinstance(file, str) and file and '\0' not in file and '\\' not in file
    if not plain or os.path.isabs(file):
        raise Refused(MESSAGE['game_relative'], file=file)
    if '..' in file.split('/'):
        raise Refused(MESSAGE['dots'], file=file)
    return file


def game_file(game: str, file: object, extensions: tuple[str, ...], max_bytes: int) -> str:
    """The full path of a plain file in the game folder `game` (a real path), given relative to it, or Refused.

    No link anywhere on the way, the file itself included, so it is the game's own file; one of
    `extensions` (any case); at most `max_bytes`. Reads only the file's metadata.
    """
    joined = os.path.normpath(os.path.join(game, _relative(file)))
    if joined == game or os.path.commonpath([game, joined]) != game or not os.path.lexists(joined):
        raise Refused(MESSAGE['not_file'], file=file)
    if os.path.realpath(joined) != joined:
        raise Refused(MESSAGE['game_link'], file=file)
    if not is_regular_file(joined):
        raise Refused(MESSAGE['not_file'], file=file)
    if os.path.splitext(joined)[1].lower() not in extensions:
        raise Refused(f'This imports {", ".join(extensions)} files.', file=file)
    if os.lstat(joined).st_size > max_bytes:
        raise Refused(f'The file is larger than {max_bytes // MIB} MB.', file=file)
    return joined


def import_source(file: object, extensions: tuple[str, ...]) -> str:
    """The real path of a file to import, or Refused when missing or of a kind it can't be."""
    given = _absolute(file, 'file')
    real = os.path.realpath(given)
    if not is_regular_file(real):
        raise Refused(MESSAGE['not_file'], file=file)
    extension = os.path.splitext(real)[1].lower()
    if extension not in extensions:
        raise Refused(f'This kind imports {", ".join(extensions)} files.', file=file)
    return real
