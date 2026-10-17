"""Scopes make build scripts idempotent. gx.scope(name) removes the level actors the scope made the
last time and tags every actor made after it with gx:<name> (Outliner folder GX/<name>), so a script
run twice leaves one copy of what it builds. run_script opens the script's own scope first (zones/
shaft for unreal/build/zones/shaft.py) and closes the books when the script ends: how many actors
each scope removed and made. Hero cameras (gx:shot) and the atmosphere (gx:atmosphere) keep their
own tags, so rebuilding a scene never deletes them by accident."""

import re
from typing import NamedTuple

import unreal

from genex_loop import editor
from genex_loop.errors import Refused

TAG_PREFIX = 'gx:'
FOLDER_ROOT = 'GX'
# A scope's name: letters, digits, _, - and / (zones/shaft), at most 64 characters.
SCOPE_NAME = re.compile(r'[A-Za-z0-9_][A-Za-z0-9_/-]{0,63}')
# Scopes of their own, never a script's.
SHOT_SCOPE = 'shot'
ATMOSPHERE_SCOPE = 'atmosphere'

MESSAGE = {
    'name': 'A scope name is 1 to 64 letters, digits, _, - or / (zones/shaft), starting with a letter or digit.',
    'no_scope': 'No scope is open: call gx.scope("name") first.',
}


class Count(NamedTuple):
    """What one scope did in a run: actors removed when it opened, actors made since."""
    removed: int
    made: int


class _Book:
    """The open scope and each scope's counts for the current run."""

    def __init__(self) -> None:
        self.current: str | None = None
        self.counts: dict[str, Count] = {}


_book = _Book()


def check_name(name: object) -> str:
    """A scope name, or Refused."""
    if not isinstance(name, str) or re.fullmatch(SCOPE_NAME, name) is None or '//' in name or name.endswith('/'):
        raise Refused(MESSAGE['name'], scope=name)
    return name


def tag_of(name: str) -> unreal.Name:
    """The tag every actor of the scope carries."""
    return unreal.Name(f'{TAG_PREFIX}{name}')


def scope_actors(name: str) -> list:
    """The editor level's actors the scope made."""
    tag = tag_of(check_name(name))
    return [actor for actor in editor.actors().get_all_level_actors() if tag in actor.tags]


def _remove(name: str) -> int:
    found = scope_actors(name)
    for actor in found:
        editor.actors().destroy_actor(actor)
    return len(found)


class Scope:
    """An open scope; as a context manager it gives the previous scope back on exit."""

    def __init__(self, name: str, previous: str | None) -> None:
        self.name, self.previous = name, previous

    def __enter__(self) -> 'Scope':
        return self

    def __exit__(self, *exc) -> bool:
        _book.current = self.previous
        return False


def scope(name: str) -> Scope:
    """Removes what the scope made before (once per run) and makes it the open scope."""
    checked = check_name(name)
    if checked not in _book.counts:
        _book.counts[checked] = Count(_remove(checked), 0)
    previous, _book.current = _book.current, checked
    return Scope(checked, previous)


def current() -> str:
    """The open scope's name, or Refused."""
    if _book.current is None:
        raise Refused(MESSAGE['no_scope'])
    return _book.current


def current_or(default: str) -> str:
    """The open scope's name, or `default` outside a script run."""
    return _book.current or check_name(default)


def own(actor, label: str | None = None, scope_name: str | None = None):
    """Tags a new actor as the open scope's (or `scope_name`'s), files it under GX/<scope> and labels it."""
    name = check_name(scope_name) if scope_name is not None else current()
    actor.tags = list(actor.tags) + [tag_of(name)]
    actor.set_folder_path(unreal.Name(f'{FOLDER_ROOT}/{name}'))
    if label:
        actor.set_actor_label(label)
    removed, made = _book.counts.get(name, Count(0, 0))
    _book.counts[name] = Count(removed, made + 1)
    return actor


def replace_owned(name: str) -> int:
    """Removes every actor of a scope of its own (gx:shot, gx:atmosphere) whatever the run; how many."""
    return _remove(check_name(name))


def begin_run(name: str) -> None:
    """A fresh book for a script run, with the script's own scope open."""
    _book.current = None
    _book.counts = {}
    scope(name)


def end_run() -> dict:
    """The run's counts by scope, and the books closed."""
    counts = {name: {'removed': count.removed, 'made': count.made} for name, count in _book.counts.items()}
    _book.current = None
    _book.counts = {}
    return counts
