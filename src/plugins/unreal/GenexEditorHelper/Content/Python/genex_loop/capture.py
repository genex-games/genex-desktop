"""Shots of the running play session's game view, without the editor around it.

A shot goes through the local player's own console (HighResShot <w>x<h> filename="..."), so it shows
the play session's viewport wherever that is (in the level viewport or a window of its own) and is
written once. Unreal's automation screenshot renders the first level viewport instead and writes
its file a second time about a second later. Every high-resolution shot freezes the game clock while
it renders, so shots meant to show motion must be spaced by the game clock (genex_build.shots).

Python tools are synchronous and the shot is taken on a later frame, so capture_play queues it
and returns the file; the host waits for the file to appear.
"""

import os

import unreal

from genex_loop import editor, paths
from genex_loop.errors import Refused
from genex_play import play

CAPTURES = 'captures'
WIDTH_RANGE = (320, 3840)
HEIGHT_RANGE = (240, 2160)
DEFAULT_SIZE = (1280, 720)

MESSAGE = {
    'not_playing': 'No play session is running; start one first.',
    'no_player': 'The play session has no local player yet.',
}


def _size(value: object, default: int, bounds: tuple[int, int]) -> int:
    """The size in range; 0 or less means the default size."""
    low, high = bounds
    wanted = int(value)
    return default if wanted <= 0 else max(low, min(high, wanted))


def capture_file(name: str) -> str:
    """Where the capture `name` goes: <project>/Saved/Genex/captures/<name>.png."""
    return os.path.join(editor.project_dir(), *paths.GENEX_FOLDER, CAPTURES, f'{paths.check_capture_name(name)}.png')


def console_shot(file: str, width: int, height: int) -> None:
    """Asks the play session's local player for a high-resolution shot of its own view into `file`."""
    world = editor.play_world()
    if world is None:
        raise Refused(MESSAGE['not_playing'])
    controller = unreal.GameplayStatics.get_player_controller(world, 0)
    if controller is None:
        raise Refused(MESSAGE['no_player'])
    play.note_shot()
    unreal.SystemLibrary.execute_console_command(world, f'HighResShot {width}x{height} filename="{file}"', controller)


def capture_play(name: str, width: int, height: int) -> dict:
    """Queues a high-resolution shot of the play view; {queued, file}."""
    file = capture_file(name)
    if editor.play_world() is None:
        raise Refused(MESSAGE['not_playing'], name=name)
    os.makedirs(os.path.dirname(file), exist_ok=True)
    if os.path.lexists(file):
        os.remove(file)
    console_shot(file, _size(width, DEFAULT_SIZE[0], WIDTH_RANGE), _size(height, DEFAULT_SIZE[1], HEIGHT_RANGE))
    return {'queued': True, 'file': file}
