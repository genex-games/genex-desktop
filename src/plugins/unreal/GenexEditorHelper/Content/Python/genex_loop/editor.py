"""The editor pieces the loop tools share: subsystems, the play world, the project folder and
the part's tag, folder and actors."""

import os
import time

import unreal

from genex_loop.errors import Refused

PART_TAG_PREFIX = 'GenexPart:'
PARTS_CONTENT = '/Game/Parts'


def actors() -> unreal.EditorActorSubsystem:
    """The level's actors, as the editor sees them."""
    return unreal.get_editor_subsystem(unreal.EditorActorSubsystem)


def levels() -> unreal.LevelEditorSubsystem:
    """Loading, saving and playing the level."""
    return unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)


def editor_subsystem() -> unreal.UnrealEditorSubsystem:
    """The editor and play worlds, and the viewport camera."""
    return unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem)


def play_world() -> unreal.World | None:
    """The running play session's world (PIE), or None."""
    return editor_subsystem().get_game_world()


def refuse_during_play() -> None:
    """Refused while a play session runs: the level can't be saved or reloaded then."""
    if play_world() is not None:
        raise Refused('A play session is running; stop it first (stop_play).')


def project_dir() -> str:
    """The open project's folder, as a full path."""
    return os.path.normpath(unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_dir()))


def part_folder(part: str) -> str:
    """The part's content folder."""
    return f'{PARTS_CONTENT}/{part}'


def part_tag(part: str) -> unreal.Name:
    """The tag every level actor of the part carries."""
    return unreal.Name(f'{PART_TAG_PREFIX}{part}')


def part_actors(part: str) -> list[unreal.Actor]:
    """The editor level's actors tagged as the part's."""
    tag = part_tag(part)
    return [actor for actor in actors().get_all_level_actors() if tag in actor.tags]


def folder_assets(folder: str) -> list[str]:
    """The asset paths in a content folder (recursive), or [] when it doesn't exist."""
    library = unreal.EditorAssetLibrary
    if not library.does_directory_exist(folder):
        return []
    return sorted(str(path) for path in library.list_assets(folder, recursive=True))


def dirty_packages() -> list[str]:
    """The names of unsaved content and map packages, sorted."""
    utils = unreal.EditorLoadingAndSavingUtils
    names = [p.get_name() for p in utils.get_dirty_content_packages()]
    names += [p.get_name() for p in utils.get_dirty_map_packages()]
    return sorted(names)


def elapsed_ms(started: float) -> int:
    """Milliseconds since a time.perf_counter() reading."""
    return round((time.perf_counter() - started) * 1000)
