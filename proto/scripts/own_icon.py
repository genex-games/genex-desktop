"""Own image on the button, with no compiled module: Epic's User Toolbox plugin (UserToolBoxCore,
shipped with the engine) registers a Slate style set "UserToolBoxStyle" and adds one image brush
for every .png in the folders an IconsTracker data asset names. This run makes that asset in the
test plugin (or loads it), points it at the plugin's Resources/Icons folder, asks User Toolbox to
refresh, adds a second toolbar button whose icon is "UserToolBoxStyle" / "Genex.genex-logo-test",
and saves Unreal's own pictures of the toolbar. Then it quits the editor."""

import os
import re

os.environ['GENEX_PROTO_RUN'] = 'own-icon'

import unreal  # noqa: E402

import genex_tab_proto as g  # noqa: E402

SLATE = 'SlateInspectorToolset.SlateInspectorToolset'
ICONS_DIR = '/GenexTabProto'
ICONS_NAME = 'GenexIcons'
ICONS_PATH = f'{ICONS_DIR}/{ICONS_NAME}'
STYLE_SET = 'UserToolBoxStyle'
PREFIX = 'Genex.'
BRUSH = f'{PREFIX}genex-logo-test'
FOLDER_TEXT = '((FolderPath=(Path="Resources/Icons"),PrefixId="",IconSize=(X=20.000000,Y=20.000000)))'
ENTRY_NAME = 'GenexTabProto.OwnIcon'
ENTRY_LABEL = 'Genex own icon'
MENU = 'LevelEditor.LevelEditorToolBar.PlayToolBar'
# Set ONLY_LOAD to skip creating and filling the asset, to prove a shipped asset works alone.
ONLY_LOAD = os.path.exists(os.path.join(g.OUT_DIR, 'own-icon-only-load'))


def console(command):
    g.note('own.console', command)
    unreal.SystemLibrary.execute_console_command(None, command)


def python_names():
    g.note('own.python_has', {name: hasattr(unreal, name) for name in ('IconsTracker', 'IconFolderInfo', 'IconTrackerFactory', 'UserToolboxSubsystem')})


def create_icons_asset():
    """IconsTracker is not a BlueprintType, so Python has no unreal.IconsTracker; the class is
    loaded by its path instead, and User Toolbox's own factory makes the asset."""
    tracker_class = g._attempt('own.load_tracker_class', lambda: unreal.load_class(None, '/Script/UserToolBoxCore.IconsTracker'))
    if tracker_class is None:
        return None
    tools = unreal.AssetToolsHelpers.get_asset_tools()
    factory_class = getattr(unreal, 'IconTrackerFactory', None)
    if factory_class is not None:
        return g._attempt('own.create_with_icon_factory', lambda: tools.create_asset(ICONS_NAME, ICONS_DIR, tracker_class, factory_class()))
    factory = unreal.DataAssetFactory()
    factory.set_editor_property('data_asset_class', tracker_class)
    return g._attempt('own.create_with_data_asset_factory', lambda: tools.create_asset(ICONS_NAME, ICONS_DIR, tracker_class, factory))


def fill_icons_asset(asset):
    """Route 1: plain Python. Route 2: the console 'set' command, which imports the text form
    of the value into every IconsTracker object, so it needs no Python struct type."""
    g._attempt('own.py_set_prefix', lambda: asset.set_editor_property('PrefixId', PREFIX))
    infos = g._attempt('own.py_get_folder_infos', lambda: asset.get_editor_property('IconFolderInfos'))
    folder_struct = getattr(unreal, 'IconFolderInfo', None)
    if folder_struct is not None:
        info = folder_struct()
        # The struct's fields are not exposed to Python, so its text form is imported instead.
        imported = g._attempt('own.py_import_text', lambda: info.import_text(FOLDER_TEXT[1:-1]))
        if not imported:
            g._attempt('own.py_field_folder', lambda: info.set_editor_property('FolderPath', unreal.DirectoryPath(path='Resources/Icons')))
            g._attempt('own.py_field_size', lambda: info.set_editor_property('IconSize', unreal.Vector2D(20, 20)))
        g._attempt('own.py_info_text', lambda: info.export_text())
        g._attempt('own.py_set_folder_infos', lambda: asset.set_editor_property('IconFolderInfos', [info]))
    g.note('own.folder_infos_before', len(infos) if infos is not None else None)
    g._attempt('own.read_back_prefix', lambda: asset.get_editor_property('PrefixId'))
    g._attempt('own.read_back_folder_infos', lambda: [item.export_text() for item in asset.get_editor_property('IconFolderInfos')])
    g._attempt('own.mark_dirty', lambda: asset.modify())
    g._attempt('own.save', lambda: unreal.EditorAssetLibrary.save_asset(ICONS_PATH, only_if_is_dirty=False))


def add_own_icon_button():
    menus = unreal.ToolMenus.get()
    menu = menus.extend_menu(MENU)
    entry = unreal.ToolMenuEntry(name=ENTRY_NAME, type=unreal.MultiBlockType.TOOL_BAR_BUTTON)
    entry.set_label(ENTRY_LABEL)
    entry.set_tool_tip('Genex button with its own image (prototype)')
    g._attempt('own.set_icon', lambda: entry.set_icon(STYLE_SET, BRUSH))
    entry.set_string_command(unreal.ToolMenuStringCommandType.PYTHON, '', g.BUTTON_COMMAND)
    g._attempt('own.add_entry', lambda: menu.add_menu_entry('GenexTabProto', entry))
    g._attempt('own.refresh', menus.refresh_all_widgets)


def slate(tool, args):
    value, error = yield from g._registry_call(SLATE, tool, args)
    returned = value.get('returnValue') if isinstance(value, dict) else value
    g.note(f'own.slate.{tool}', {'args': args, 'error': error, 'value': repr(returned)[:300]})
    return returned


def save_image(name, image):
    data = image.get('data') if isinstance(image, dict) else None
    if data:
        with open(os.path.join(g.OUT_DIR, name), 'wb') as handle:
            handle.write(g.base64.b64decode(data))
    g.note(f'own.saved.{name}', bool(data))


def picture_buttons(label):
    """Unreal's own pictures: the whole editor, and each Genex button found in the widget tree."""
    yield from g.capture_editor(f'own-icon-{label}')
    if not g._registry().is_toolset_registered(SLATE):
        g.note('own.slate_inspector', 'not registered')
        return
    yield from slate('Observe', {'ref': '', 'maxDepth': 60})
    yield from g.wait(2)
    snapshot = yield from slate('Snapshot', {'ref': '', 'maxDepth': 60})
    lines = [line.strip() for line in (snapshot or '').splitlines() if 'Genex' in line]
    g.note('own.genex_lines', lines)
    for index, line in enumerate(lines):
        match = re.search(r'ref=([A-Za-z0-9_:-]+)', line) or re.search(r'\[(e\d+)\]', line)
        if match:
            image = yield from slate('Screenshot', {'ref': match.group(1)})
            save_image(f'{g.PLATFORM_PREFIX}editor-{g.ENGINE_SHORT}-own-icon-{label}-button{index}.png', image)


def flow():
    yield from g.wait(5)
    g.note('run.started', {'engine': g.ENGINE, 'only_load': ONLY_LOAD})
    python_names()
    exists = unreal.EditorAssetLibrary.does_asset_exist(ICONS_PATH)
    g.note('own.asset_exists', exists)
    asset = unreal.EditorAssetLibrary.load_asset(ICONS_PATH) if exists else None
    if asset is None and not ONLY_LOAD:
        asset = create_icons_asset()
    if asset is not None and not ONLY_LOAD:
        fill_icons_asset(asset)
    console('UserToolbox.RefreshIcons')
    yield from g.wait(1)
    add_own_icon_button()
    yield from g.wait(3)
    yield from picture_buttons('only-load' if ONLY_LOAD else 'made')
    yield from g.wait(2)
    unreal.SystemLibrary.quit_editor()


g.run_on_ticks(flow(), 'own-icon')
