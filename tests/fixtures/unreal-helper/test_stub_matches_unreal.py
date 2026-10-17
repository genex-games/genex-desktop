"""The stub `unreal` the helper's tests run against offers only what Unreal 5.8's own Python has.

Probes written against an invented name (GameplayStatics.break_hit_result, PlayerCameraManager
.get_view_target, unreal.Engine) passed every stub test and failed in the first real editor. Each
class, method and module function the stub defines must be in real-names-5.8.json, the engine's
own names for those classes (made by make_real_names.py from the helper's export_python_names): a
class maps to its members, a module function to null.
"""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'stubs'))
import unreal  # noqa: E402

REAL = json.load(open(os.path.join(os.path.dirname(__file__), 'real-names-5.8.json')))

# The stub's own test machinery, which models nothing in Unreal.
STUB_CLASSES = {'Floor'}
STUB_MEMBERS = {'corners'}
STUB_FUNCTIONS = {'reset'}


def stub_classes() -> dict:
    return {name: value for name, value in vars(unreal).items()
            if isinstance(value, type) and not name.startswith('_') and name not in STUB_CLASSES}


class StubMatchesUnreal(unittest.TestCase):
    def test_every_stub_class_is_one_unreal_has(self) -> None:
        missing = sorted(name for name in stub_classes() if REAL.get(name) is None)
        self.assertEqual(missing, [], 'classes Unreal 5.8 Python does not have')

    def test_every_stub_method_is_one_its_unreal_class_has(self) -> None:
        missing = []
        for name, cls in sorted(stub_classes().items()):
            real = set(REAL.get(name) or [])
            own = {m for m in vars(cls) if not m.startswith('_') and m not in STUB_MEMBERS}
            missing += [f'{name}.{m}' for m in sorted(own - real)]
        self.assertEqual(missing, [], 'methods Unreal 5.8 Python does not have on that class')

    def test_every_stub_function_is_one_unreal_has(self) -> None:
        functions = {n for n, v in vars(unreal).items()
                     if callable(v) and not isinstance(v, type) and not n.startswith('_')} - STUB_FUNCTIONS
        self.assertEqual(sorted(functions - {name for name, members in REAL.items() if members is None}), [])


if __name__ == '__main__':
    unittest.main()
