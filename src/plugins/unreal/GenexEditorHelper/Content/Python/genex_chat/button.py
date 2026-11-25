"""The Genex button in the level editor's toolbar. Pressing it asks the computer to open
`genex://editor/<this project's folder>`: Genex comes forward (or starts) on the chat of the game
this project belongs to. The button is added again at each editor start, because Unreal keeps no
scripted toolbar entry between sessions. It wears one of Unreal's own icons: a picture of ours
needs a compiled Slate style, and this helper is Python only."""

import base64

import unreal

LINK_START = 'genex://editor/'
TOOLBAR = 'LevelEditor.LevelEditorToolBar.PlayToolBar'
SECTION = 'Genex'
ENTRY = 'Genex.OpenChat'
LABEL = 'Genex'
TOOL_TIP = 'Open this project\'s chat in Genex'
ICON_STYLE = 'EditorStyle'
ICON = 'Icons.Comment'
COMMAND = 'import genex_chat.button; genex_chat.button.open_genex()'


def project_link() -> str:
    """The link that names this project's folder: its whole path as unpadded base64url."""
    folder = unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_dir()).rstrip('/\\')
    code = base64.urlsafe_b64encode(folder.encode('utf-8')).decode('ascii').rstrip('=')
    return LINK_START + code


def open_genex() -> str:
    """Ask the computer to open this project's link; Genex answers it. Returns the link."""
    link = project_link()
    unreal.SystemLibrary.launch_url(link)
    return link


def add_button() -> bool:
    """Put the Genex button on the level editor's toolbar; False when this editor has no such toolbar."""
    menus = unreal.ToolMenus.get()
    if menus.find_menu(TOOLBAR) is None:
        return False
    menu = menus.extend_menu(TOOLBAR)
    menu.add_section(SECTION, LABEL)
    entry = unreal.ToolMenuEntry(name=ENTRY, type=unreal.MultiBlockType.TOOL_BAR_BUTTON)
    entry.set_label(LABEL)
    entry.set_tool_tip(TOOL_TIP)
    entry.set_icon(ICON_STYLE, ICON)
    entry.set_string_command(unreal.ToolMenuStringCommandType.PYTHON, '', COMMAND)
    menu.add_menu_entry(SECTION, entry)
    menus.refresh_all_widgets()
    return True
