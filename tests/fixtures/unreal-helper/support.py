"""Shared setup for the Genex editor helper's Python tests: a throwaway game folder and project,
the stub `unreal` reset for each test, and tool calls answered as parsed JSON."""

import json
import os
import shutil
import tempfile
import unittest

import unreal

from genex_loop.tools import GenexLoopTools

MARKER_SCRIPT = 'open({marker!r}, "w").write("ran")\nprint("script ran")\n'


class HelperCase(unittest.TestCase):
    """A game folder (game/unreal/parts/...), a project folder and a folder outside both."""

    def setUp(self) -> None:
        self.root = os.path.realpath(tempfile.mkdtemp(prefix='genex-helper-'))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.game = self.path('game')
        self.parts = self.path('game', 'unreal', 'parts')
        self.project = self.path('game', 'unreal')
        self.outside = self.path('outside')
        self.marker = os.path.join(self.root, 'ran.txt')
        unreal.reset(self.project)

    def path(self, *names: str) -> str:
        path = os.path.join(self.root, *names)
        os.makedirs(path, exist_ok=True)
        return path

    def write(self, path: str, text: str) -> str:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as handle:
            handle.write(text)
        return path

    def part(self, name: str, script: str | None = None, files: dict[str, str] | None = None) -> str:
        """Writes parts/<name>/apply.py (a marker writer unless given) and other files; returns apply.py."""
        folder = os.path.join(self.parts, name)
        for file, text in (files or {}).items():
            self.write(os.path.join(folder, file), text)
        return self.write(os.path.join(folder, 'apply.py'), script if script is not None else MARKER_SCRIPT.format(marker=self.marker))

    def fresh(self) -> None:
        """Before each case of a table: no calls recorded and no script run yet."""
        unreal.calls.clear()
        if os.path.exists(self.marker):
            os.remove(self.marker)

    def call(self, tool: str, *args) -> dict:
        return json.loads(getattr(GenexLoopTools, tool)(*args))

    def assert_refused(self, result: dict) -> None:
        """The tool refused: an error, the script never ran, and nothing in the editor changed."""
        self.assertIn('error', result)
        self.assertFalse(result.get('ok', False))
        self.assertFalse(os.path.exists(self.marker), 'the part script ran')
        self.assertEqual(unreal.calls, [], 'the editor was changed')
