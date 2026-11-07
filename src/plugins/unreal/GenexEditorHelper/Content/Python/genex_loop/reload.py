"""Brings a newer helper's Python into the running editor without a restart: Genex writes the new
files into the project's Plugins/GenexEditorHelper, then reload_helper reloads every helper module
behind the toolsets, each after the helper modules it imports. The toolsets themselves (tools.py),
each package's __init__.py, errors.py (whose Refused the toolsets catch) and init_unreal.py are
registered with Unreal or held by what is, so Genex restarts Unreal when one of them changes.

A module keeps its state in module globals (held keys, a pilot, a pending shot, the render settings
a lighter play lowered), so the reload is refused while a play session runs or while the helper still
holds something of the editor's: reloading then would leave Unreal calling the old code, or settings
the new module no longer knows to put back."""

import ast
import importlib
import sys
import time

from genex_loop import editor
from genex_loop.errors import Refused

PACKAGES = ('genex_build', 'genex_loop', 'genex_play')
# Module names that never reload (see the module notes).
FIXED = ('tools', 'errors', '__init__')
# What the helper holds of the editor, by module and global, set (truthy) while it does: its own
# editor-tick callbacks, and the console values a lighter play lowered, to put back when it ends.
HELD = (('genex_play.play', '_tick_handle'), ('genex_build.shots', '_wait_handle'), ('genex_play.light', '_kept'))

MESSAGE = {
    'playing': 'A play session is running; the helper reloads only between plays. Stop play, then retry.',
    'busy': 'The helper still holds something of the editor ({module}); retry once it is done, or restart Unreal.',
}


def reloadable(name: str) -> bool:
    """Whether a module name is one of the helper's modules that reload: genex_<package>.<module>,
    never a toolset, a package's __init__ or errors."""
    package, _, leaf = name.partition('.')
    return package in PACKAGES and leaf.isidentifier() and leaf not in FIXED


def _imported(module) -> set:
    """The helper modules a module imports by name: `import a.b`, `from a import b` (b a module) and
    `from a.b import c`."""
    try:
        with open(module.__file__, encoding='utf-8') as source:
            tree = ast.parse(source.read())
    except (OSError, SyntaxError, TypeError):
        return set()
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            names.add(node.module)
            names.update(f'{node.module}.{alias.name}' for alias in node.names)
    return {name for name in names if reloadable(name)}


def order(modules: dict) -> list:
    """The modules' names, each after the ones it imports (`modules` maps a name to its module). An
    import cycle keeps the names' sorted order among the modules in it."""
    imports = {name: _imported(module) & modules.keys() for name, module in modules.items()}
    done: list = []
    seen: set = set()

    def visit(name: str, path: tuple) -> None:
        if name in seen or name in path:
            return
        for imported in sorted(imports[name]):
            visit(imported, path + (name,))
        seen.add(name)
        done.append(name)

    for name in sorted(modules):
        visit(name, ())
    return done


def _busy() -> str | None:
    """The helper module still holding something of the editor's (HELD), or None."""
    for name, held in HELD:
        module = sys.modules.get(name)
        if module is not None and getattr(module, held, None):
            return name
    return None


def check() -> dict:
    """{ready, why?}: whether reload_helper can run now."""
    if editor.play_world() is not None:
        return {'ready': False, 'why': MESSAGE['playing']}
    busy = _busy()
    if busy:
        return {'ready': False, 'why': MESSAGE['busy'].format(module=busy)}
    return {'ready': True}


def reload_helper() -> dict:
    """Reloads every loaded helper module that reloads, imports first; {reloaded, ms}."""
    ready = check()
    if not ready['ready']:
        raise Refused(ready['why'])
    started = time.perf_counter()
    loaded = {name: module for name, module in list(sys.modules.items()) if module is not None and reloadable(name)}
    reloaded = []
    for name in order(loaded):
        importlib.reload(loaded[name])
        reloaded.append(name)
    return {'reloaded': reloaded, 'ms': editor.elapsed_ms(started)}
