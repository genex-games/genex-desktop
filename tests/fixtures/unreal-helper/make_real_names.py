"""Writes real-names-5.8.json: Unreal 5.8's own Python names for what the stub `unreal` models and
what the helper's engine-facing modules (genex_build, genex_play; not the pure *_math.py) use.

Run on a machine with the engine's exported names (the Genex editor helper's `export_python_names`):
    python3 make_real_names.py <python-names.json> [<python-names.json> ...]
Several exports are merged: a template's own plugins (the vehicle template's Chaos Vehicles) export
names the others lack, and the file in place may be one of them.
Kept: the stub's classes with the members the stub defines, every `unreal.<Name>` and
`unreal.<Class>.<member>` the helper's modules write, each of those classes' members the helper
calls as a method (python-check checks a method on what `unreal.<Class>` made or found against that
class), and for every other method they call one real class that has it. Only names the real export has are copied, so a name invented in the
stub or the helper stays missing and its check fails. The file keeps the export's own shape (a class
maps to its members, a module function to null), so Genex's python-check reads it as it reads the
export. The 5.8 file comes from Unreal 5.8.3's export (Geometry Script, MaterialEditingLibrary,
Interchange and IK Rig included).
"""
import ast
import json
import os
import sys

sys.path.insert(0, 'stubs')
import unreal as stub  # noqa: E402

STUB_ONLY = {'Floor'}
HELPER = os.path.join('..', '..', '..', 'src', 'plugins', 'unreal', 'GenexEditorHelper', 'Content', 'Python')
ENGINE_FACING = ('genex_build', 'genex_play')
# Members every Python object or container has: the checker never asks the engine for these.
PYTHON_MEMBERS = set().union(*(dir(kind) for kind in (str, bytes, list, dict, set, tuple, int, float, bool, object)))


def stub_classes() -> dict:
    return {name: value for name, value in vars(stub).items()
            if isinstance(value, type) and not name.startswith('_') and name not in STUB_ONLY}


def helper_sources() -> list:
    sources = []
    for package in ENGINE_FACING:
        folder = os.path.join(HELPER, package)
        for file in sorted(os.listdir(folder)):
            if file.endswith('.py') and not file.endswith('_math.py'):
                with open(os.path.join(folder, file), encoding='utf-8') as handle:
                    sources.append(handle.read())
    return sources


def helper_names(sources: list) -> tuple[dict, set]:
    """({Name: {members written as unreal.Name.member}}, {methods called on objects})."""
    written: dict = {}
    called: set = set()
    for source in sources:
        for node in ast.walk(ast.parse(source)):
            if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name) and node.value.id == 'unreal':
                written.setdefault(node.attr, set())
            elif isinstance(node, ast.Attribute) and isinstance(node.value, ast.Attribute):
                inner = node.value
                if isinstance(inner.value, ast.Name) and inner.value.id == 'unreal':
                    written.setdefault(inner.attr, set()).add(node.attr)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                called.add(node.func.attr)
    return written, called - PYTHON_MEMBERS


def keep(out: dict, real: dict, name: str, members: set) -> None:
    """Copies `name` (and those of its members the real export has) into `out`."""
    if name not in real:
        return
    if real[name] is None:
        out[name] = None
        return
    kept = set(out.get(name) or [])
    out[name] = sorted(kept | {m for m in members if m in real[name]})


def merged(paths: list) -> dict:
    """The exports' names together: a class's members from every export that has it."""
    real: dict = {}
    for path in paths:
        for name, members in json.load(open(path)).items():
            if isinstance(members, list):
                real[name] = sorted(set(real.get(name) or []) | set(members))
            else:
                real.setdefault(name, None)
    return real


def main(paths: list) -> None:
    real = merged(paths)
    out = {n: None for n, v in vars(stub).items()
           if callable(v) and not isinstance(v, type) and not n.startswith('_') and n in real and real[n] is None}
    for name, cls in sorted(stub_classes().items()):
        keep(out, real, name, {m for m in vars(cls) if not m.startswith('_')})
    written, called = helper_names(helper_sources())
    for name, members in sorted(written.items()):
        # A method called on what a class made or found (get_component_by_class(unreal.X)) is checked on X.
        keep(out, real, name, members | called)
    every = {m for members in out.values() if isinstance(members, list) for m in members}
    for method in sorted(called - every):
        owner = next((name for name, members in sorted(real.items()) if isinstance(members, list) and method in members), None)
        if owner:
            keep(out, real, owner, {method})
    json.dump(out, open('real-names-5.8.json', 'w'), indent=1, sort_keys=True)
    print(f'{sum(1 for v in out.values() if v is not None)} classes')


if __name__ == '__main__':
    main(sys.argv[1:])
