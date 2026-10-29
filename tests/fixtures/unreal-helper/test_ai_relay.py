"""Play-time AI's relay in the Genex editor helper: Genex Studio pulls the lines a playing game's
GenexAI plugin queued and pushes its answers back, through the plugin's UGenexAiRelayLibrary. A
project without the plugin plays nothing here, and a push to it is not taken."""

import json
import unittest

import unreal

from genex_ai.tools import GenexAiRelayTools

PULLED = json.dumps({'playing': True, 'lines': ['{"event":"ai"}'], 'echo': {'asked': [], 'answered': []}})


class FakeRelayLibrary:
    """The GenexAI plugin's relay as Python sees it: what it pulled, and every push it took."""

    pushed: list[str] = []

    @staticmethod
    def pull() -> str:
        return PULLED

    @staticmethod
    def push(answers: str) -> bool:
        FakeRelayLibrary.pushed.append(answers)
        return answers != 'refused'


class Relay(unittest.TestCase):
    def setUp(self) -> None:
        FakeRelayLibrary.pushed = []

    def with_library(self, library) -> None:
        """The editor's `unreal` module with the plugin's relay class, or (None) without the plugin."""
        unreal.GenexAiRelayLibrary = library
        self.addCleanup(delattr, unreal, 'GenexAiRelayLibrary')

    def with_plugin(self) -> None:
        self.with_library(FakeRelayLibrary)

    def test_a_project_without_the_plugin_plays_nothing_and_takes_no_answers(self) -> None:
        self.with_library(None)
        self.assertEqual(json.loads(GenexAiRelayTools.ai_pull()), {'playing': False, 'lines': []})
        self.assertEqual(json.loads(GenexAiRelayTools.ai_push('W10=')), {'taken': False})

    def test_pulls_the_plugins_lines_as_it_said_them(self) -> None:
        self.with_plugin()
        self.assertEqual(GenexAiRelayTools.ai_pull(), PULLED)

    def test_pushes_the_answers_as_given_and_says_whether_they_were_taken(self) -> None:
        self.with_plugin()
        self.assertEqual(json.loads(GenexAiRelayTools.ai_push('W10=')), {'taken': True})
        self.assertEqual(json.loads(GenexAiRelayTools.ai_push('refused')), {'taken': False})
        self.assertEqual(FakeRelayLibrary.pushed, ['W10=', 'refused'])


if __name__ == '__main__':
    unittest.main()
