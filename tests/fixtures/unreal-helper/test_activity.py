"""editor_activity is what the queue and every save point read of the editor: during a play
session it never asks Unreal for the selection, whose answer then is none and whose call writes
"The Editor is currently in a play mode." to Unreal's log as an error, which each save point would
report as a new error of the game."""

from unittest import mock

import unreal

from support import HelperCase


class EditorActivity(HelperCase):
    def selection_asked(self, pie: bool) -> tuple[dict, int]:
        unreal.state['pie'] = pie
        with mock.patch.object(unreal.EditorActorSubsystem, 'get_selected_level_actors',
                               autospec=True, return_value=[unreal.Actor('Bike')]) as asked:
            activity = self.call('editor_activity')
        return activity, asked.call_count

    def test_never_asks_the_selection_during_a_play_session(self) -> None:
        activity, asked = self.selection_asked(True)
        self.assertEqual(asked, 0)
        self.assertEqual(activity['selection'], [])
        self.assertTrue(activity['pie'])

    def test_asks_the_selection_outside_a_play_session(self) -> None:
        activity, asked = self.selection_asked(False)
        self.assertEqual(asked, 1)
        self.assertEqual(activity['selection'], ['Bike'])
        self.assertFalse(activity['pie'])
