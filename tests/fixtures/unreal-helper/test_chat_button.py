"""The Genex button on the level editor's toolbar: the helper adds it at each editor start, and a
press asks the computer to open `genex://editor/<this project's folder>`, which Genex answers by
opening the chat of the game the project belongs to. An editor without that toolbar (a commandlet)
gets no button and the helper's tools still register."""

import base64
import importlib
import unittest

import unreal

from support import HelperCase


class _Entry:
    def __init__(self, name=None, type=None) -> None:  # noqa: A002 - Unreal's own argument name
        self.made = {'name': name, 'type': type}

    def set_label(self, label) -> None:
        self.made['label'] = label

    def set_tool_tip(self, tip) -> None:
        self.made['tip'] = tip

    def set_icon(self, style, icon) -> None:
        self.made['icon'] = (style, icon)

    def set_string_command(self, kind, custom, command) -> None:
        self.made['command'] = (kind, command)


class _Menu:
    def __init__(self) -> None:
        self.sections, self.entries = [], []

    def add_section(self, name, label) -> None:
        self.sections.append(name)

    def add_menu_entry(self, section, entry) -> None:
        self.entries.append((section, entry.made))


class _Menus:
    def __init__(self, known) -> None:
        self.known, self.menu, self.refreshed = known, _Menu(), 0

    def find_menu(self, name):
        return self.menu if name in self.known else None

    def extend_menu(self, name):
        return self.menu

    def refresh_all_widgets(self) -> None:
        self.refreshed += 1


class ChatButton(HelperCase):
    def editor(self, toolbars=('LevelEditor.LevelEditorToolBar.PlayToolBar',)) -> _Menus:
        """An editor with these toolbars, whose opened links are kept in `self.opened`."""
        menus = _Menus(set(toolbars))
        self.opened = []
        fakes = {
            'ToolMenus': type('ToolMenus', (), {'get': staticmethod(lambda: menus)}),
            'ToolMenuEntry': _Entry,
            'MultiBlockType': type('MultiBlockType', (), {'TOOL_BAR_BUTTON': 'button'}),
            'ToolMenuStringCommandType': type('ToolMenuStringCommandType', (), {'PYTHON': 'python'}),
        }
        for name, fake in fakes.items():
            setattr(unreal, name, fake)
            self.addCleanup(delattr, unreal, name)
        unreal.SystemLibrary.launch_url = staticmethod(self.opened.append)
        self.addCleanup(delattr, unreal.SystemLibrary, 'launch_url')
        return menus

    def test_the_button_sits_on_the_toolbar_and_runs_the_helper(self) -> None:
        menus = self.editor()
        button = importlib.import_module('genex_chat.button')
        self.assertTrue(button.add_button())
        [(section, made)] = menus.menu.entries
        self.assertEqual((section, made['label'], made['type']), ('Genex', 'Genex', 'button'))
        self.assertEqual(made['command'], ('python', 'import genex_chat.button; genex_chat.button.open_genex()'))
        self.assertEqual(menus.refreshed, 1, 'the toolbar is drawn again with the button')

    def test_a_press_opens_the_link_that_names_this_projects_folder(self) -> None:
        self.editor()
        button = importlib.import_module('genex_chat.button')
        link = button.open_genex()
        self.assertEqual(self.opened, [link])
        self.assertTrue(link.startswith('genex://editor/'))
        code = link[len('genex://editor/'):]
        self.assertRegex(code, r'^[A-Za-z0-9_-]+$', 'unpadded base64url, as Genex reads it')
        self.assertEqual(base64.urlsafe_b64decode(code + '=' * (-len(code) % 4)).decode('utf-8'), self.project)

    def test_an_editor_without_the_toolbar_gets_no_button(self) -> None:
        menus = self.editor(toolbars=())
        button = importlib.import_module('genex_chat.button')
        self.assertFalse(button.add_button())
        self.assertEqual(menus.menu.entries, [])


if __name__ == '__main__':
    unittest.main()
