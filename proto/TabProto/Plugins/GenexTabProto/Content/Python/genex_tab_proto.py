"""Throwaway prototype: a Genex toolbar button and a docked web tab, made from Python only.

Every finding goes to proto/out/findings.jsonl (one JSON object per line, tagged with the engine
version and the run), so the results can be read without looking at the screen."""

import base64
import json
import os
import time

import unreal

PORT = 18431
URL = f'http://127.0.0.1:{PORT}/'
ASSET_DIR = '/Game/GenexTabProto'
ASSET_NAME = 'EUW_GenexTab'
ASSET_PATH = f'{ASSET_DIR}/{ASSET_NAME}'
BROWSER_NAME = 'GenexBrowser'
BUTTON_COMMAND = 'import genex_tab_proto; genex_tab_proto.open_tab("button")'
TOOLBAR_CANDIDATES = [
    'LevelEditor.LevelEditorToolBar.PlayToolBar',
    'LevelEditor.LevelEditorToolBar.User',
    'LevelEditor.LevelEditorToolBar.AssetsToolBar',
    'LevelEditor.LevelEditorToolBar.ModesToolBar',
    'LevelEditor.LevelEditorToolBar',
    'LevelEditor.MainMenu.Tools',
]
UMG_TOOLSETS = ['UMGEditor.WidgetBlueprintEditorSubsystem', 'UMGToolSet.UMGToolSet']

ENGINE = unreal.SystemLibrary.get_engine_version()
ENGINE_SHORT = '.'.join(ENGINE.split('.')[:2])
OUT_DIR = os.path.normpath(os.path.join(unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_dir()), '..', 'out'))


def note(key, value):
    """Append one finding to proto/out/findings.jsonl and the editor log."""
    os.makedirs(OUT_DIR, exist_ok=True)
    line = {'at': time.strftime('%Y-%m-%dT%H:%M:%S'), 'engine': ENGINE_SHORT, 'run': os.environ.get('GENEX_PROTO_RUN', 'interactive'), 'key': key, 'value': value}
    with open(os.path.join(OUT_DIR, 'findings.jsonl'), 'a', encoding='utf-8') as handle:
        handle.write(json.dumps(line, default=str) + '\n')
    unreal.log(f'[GenexTabProto] {key}: {value}')


def _attempt(label, fn):
    try:
        result = fn()
        note(label, {'ok': True, 'result': repr(result)[:400]})
        return result
    except Exception as error:  # noqa: BLE001 - every failure is a finding
        note(label, {'ok': False, 'error': f'{type(error).__name__}: {error}'[:600]})
        return None


# ---------------------------------------------------------------- toolbar button


def add_button():
    """Add the Genex button to the first level editor toolbar menu that exists."""
    menus = unreal.ToolMenus.get()
    existing = {name: menus.find_menu(name) is not None for name in TOOLBAR_CANDIDATES}
    note('toolbar.menus_found', existing)
    target = next((name for name in TOOLBAR_CANDIDATES if existing[name]), None)
    if target is None:
        note('toolbar.added', False)
        return
    menu = menus.extend_menu(target)
    _attempt('toolbar.add_section', lambda: menu.add_section('GenexTabProto', 'Genex'))
    entry = unreal.ToolMenuEntry(name='GenexTabProto.Open', type=unreal.MultiBlockType.TOOL_BAR_BUTTON)
    entry.set_label('Genex')
    entry.set_tool_tip('Open the Genex tab (prototype)')
    _attempt('toolbar.set_icon_existing_style', lambda: entry.set_icon('EditorStyle', 'Icons.Comment'))
    entry.set_string_command(unreal.ToolMenuStringCommandType.PYTHON, '', BUTTON_COMMAND)
    _attempt('toolbar.add_menu_entry', lambda: menu.add_menu_entry('GenexTabProto', entry))
    _attempt('toolbar.refresh', menus.refresh_all_widgets)
    note('toolbar.added', target)


def discover_icon_routes():
    """List every Python-reachable name that could register or point at a custom image."""
    words = ('style', 'brush', 'icon', 'slate')
    names = sorted(name for name in dir(unreal) if any(word in name.lower() for word in words))
    note('icon.python_names', names)
    entry_methods = [name for name in dir(unreal.ToolMenuEntry) if not name.startswith('_')]
    note('icon.tool_menu_entry_methods', entry_methods)
    script_methods = [name for name in dir(unreal.ToolMenuEntryScript) if not name.startswith('_')]
    note('icon.tool_menu_entry_script_methods', script_methods)


# ---------------------------------------------------------------- widget asset


def _registry():
    return getattr(unreal, 'ToolsetRegistry', None)


def dump_umg_schema():
    """Save the UMG toolset JSON schemas so the tool and argument names are on record."""
    registry = _registry()
    if registry is None:
        note('toolsets.registry', 'missing')
        return
    registered = {name: registry.is_toolset_registered(name) for name in UMG_TOOLSETS}
    note('toolsets.umg_registered', registered)
    schemas = _attempt('toolsets.all_schemas', registry.get_all_toolset_json_schemas)
    if schemas:
        with open(os.path.join(OUT_DIR, f'toolset-schemas-{ENGINE_SHORT}.json'), 'w', encoding='utf-8') as handle:
            handle.write(schemas)


def _registry_call(toolset, tool, args):
    """Run one registered tool. Yields until the call completes; returns (value, error)."""
    registry = _registry()
    result = registry.execute_tool(toolset, tool, json.dumps(args))
    deadline = time.time() + 30
    while not result.is_complete and time.time() < deadline:
        yield
    if not result.is_complete:
        return None, 'timeout'
    if result.error:
        return None, str(result.error)
    try:
        return json.loads(result.value), None
    except Exception:  # noqa: BLE001
        return result.value, None


def _create_blueprint():
    factory = unreal.EditorUtilityWidgetBlueprintFactory()
    _attempt('asset.factory_parent', lambda: factory.set_editor_property('parent_class', unreal.EditorUtilityWidget))
    tools = unreal.AssetToolsHelpers.get_asset_tools()
    return tools.create_asset(ASSET_NAME, ASSET_DIR, unreal.EditorUtilityWidgetBlueprint, factory)


SCRATCH_PATH = f'{ASSET_DIR}/Scratch/EUW_RouteA'


def _probe_route_a():
    """Route (a) on a scratch asset that is deleted afterwards: a failed attempt leaves an orphan
    widget behind that Unreal then warns about, so it must never touch the real asset."""
    factory = unreal.EditorUtilityWidgetBlueprintFactory()
    factory.set_editor_property('parent_class', unreal.EditorUtilityWidget)
    tools = unreal.AssetToolsHelpers.get_asset_tools()
    scratch = _attempt('route_a.scratch_create', lambda: tools.create_asset('EUW_RouteA', f'{ASSET_DIR}/Scratch', unreal.EditorUtilityWidgetBlueprint, factory))
    worked = scratch is not None and _route_pure_python(scratch) is not None
    _attempt('route_a.scratch_delete', lambda: unreal.EditorAssetLibrary.delete_directory(f'{ASSET_DIR}/Scratch'))
    return worked


def _route_pure_python(blueprint):
    """Route (a): reach the widget tree from plain Python and put a WebBrowser in it.

    Succeeds only if the new widget becomes the tree's root: an object merely created inside the
    tree is not part of the widget."""
    _attempt('route_a.get_widget_tree_property', lambda: blueprint.get_editor_property('widget_tree'))
    tree = _attempt('route_a.find_widget_tree_object', lambda: unreal.find_object(None, f'{blueprint.get_path_name()}:WidgetTree'))
    if tree is None:
        return None
    note('route_a.widget_tree_methods', [name for name in dir(tree) if not name.startswith('_')])
    browser = _attempt('route_a.new_web_browser', lambda: unreal.new_object(unreal.WebBrowser, outer=tree, name='ProbeRouteA'))
    if browser is None:
        return None
    if _attempt('route_a.set_root_widget', lambda: tree.set_editor_property('root_widget', browser) or True) is None:
        return None
    return browser


def _route_subsystem(blueprint):
    """Route (b1): the UMG editor subsystem's Python-callable functions (Unreal 5.9)."""
    subsystem_class = getattr(unreal, 'WidgetBlueprintEditorSubsystem', None)
    note('route_b1.subsystem_class', repr(subsystem_class))
    if subsystem_class is None:
        return None
    subsystem = unreal.get_editor_subsystem(subsystem_class)
    note('route_b1.methods', [name for name in dir(subsystem) if not name.startswith('_')])
    info = _attempt('route_b1.create_and_add_widget', lambda: subsystem.create_and_add_widget(blueprint, unreal.WebBrowser, BROWSER_NAME))
    if info is None:
        return None
    return _attempt('route_b1.info_widget', lambda: info.get_editor_property('widget'))


def _umg_add_tools():
    """Find every registered tool that adds a widget to a widget blueprint, with its input schema."""
    registry = _registry()
    if registry is None:
        return []
    found = []
    for toolset in json.loads(registry.get_all_toolset_json_schemas()):
        for tool in toolset.get('tools', []):
            short = tool['name'].rsplit('.', 1)[-1]
            if short in ('CreateAndAddWidget', 'AddWidget'):
                found.append((toolset['name'], short, tool.get('inputSchema', {})))
    note('route_b2.add_tools_found', [(toolset, short, list(schema.get('properties', {}))) for toolset, short, schema in found])
    return found


def _add_args(schema, blueprint):
    args = {}
    for key in schema.get('properties', {}):
        lower = key.lower()
        if 'blueprint' in lower:
            args[key] = {'refPath': blueprint.get_path_name()}
        elif 'class' in lower:
            args[key] = {'refPath': '/Script/WebBrowserWidget.WebBrowser'}
        elif 'name' in lower:
            args[key] = BROWSER_NAME
    return args


def _widget_path(value):
    returned = value.get('returnValue') if isinstance(value, dict) else None
    if not isinstance(returned, dict):
        return None
    widget = returned.get('widget') or returned.get('Widget')
    return widget.get('refPath') if isinstance(widget, dict) else widget


def _route_registry(blueprint):
    """Route (b2): Epic's UMG toolset through the toolset registry (what Epic's MCP server calls)."""
    for toolset, tool, schema in _umg_add_tools():
        args = _add_args(schema, blueprint)
        value, error = yield from _registry_call(toolset, tool, args)
        note(f'route_b2.{toolset}.{tool}', {'args': args, 'value': value, 'error': error})
        path = _widget_path(value)
        if path:
            return unreal.find_object(None, path)
    return None


def _find_template_browser(blueprint):
    return unreal.find_object(None, f'{blueprint.get_path_name()}:WidgetTree.{BROWSER_NAME}')


def ensure_asset():
    """Generator: load the widget asset, or create it by script. Returns the blueprint."""
    if unreal.EditorAssetLibrary.does_asset_exist(ASSET_PATH):
        blueprint = unreal.EditorAssetLibrary.load_asset(ASSET_PATH)
        note('asset.loaded_existing', blueprint.get_path_name() if blueprint else None)
        browser = _find_template_browser(blueprint) if blueprint else None
        note('asset.existing_has_browser', browser is not None)
        return blueprint
    blueprint = _attempt('asset.create', _create_blueprint)
    if blueprint is None:
        return None
    note('asset.class', blueprint.get_class().get_name())
    dump_umg_schema()
    note('route_a.worked', _probe_route_a())
    route = 'b1-umg-subsystem-python'
    browser = _route_subsystem(blueprint)
    if browser is None:
        route = 'b2-toolset-registry'
        browser = yield from _route_registry(blueprint)
    note('asset.route_that_worked', route if browser else None)
    if browser is None:
        return blueprint
    _attempt('asset.set_initial_url', lambda: browser.set_editor_property('initial_url', f'{URL}?run=initial-url-{ENGINE_SHORT}'))
    _attempt('asset.compile', lambda: unreal.BlueprintEditorLibrary.compile_blueprint(blueprint))
    _attempt('asset.save', lambda: unreal.EditorAssetLibrary.save_asset(ASSET_PATH, only_if_is_dirty=False))
    return blueprint


# ---------------------------------------------------------------- tab


def _browser_in_instance(widget):
    found = _attempt('tab.instance_property', lambda: widget.get_editor_property(BROWSER_NAME))
    if found:
        return found
    return _attempt('tab.instance_subobject', lambda: unreal.find_object(None, f'{widget.get_path_name()}.WidgetTree.{BROWSER_NAME}'))


def open_tab(source='script', run_tag=None):
    """Open the widget as an editor tab (the button's command and the test scripts call this)."""
    note('tab.open_requested', source)
    blueprint = unreal.EditorAssetLibrary.load_asset(ASSET_PATH)
    if blueprint is None:
        note('tab.no_asset', ASSET_PATH)
        return None
    subsystem = unreal.get_editor_subsystem(unreal.EditorUtilitySubsystem)
    widget = _attempt('tab.spawn_and_register_tab', lambda: subsystem.spawn_and_register_tab(blueprint))
    if widget is not None and run_tag:
        browser = _browser_in_instance(widget)
        if browser is not None:
            _attempt('tab.load_url_runtime', lambda: browser.load_url(f'{URL}?run={run_tag}'))
    return widget


def tab_is_open():
    blueprint = unreal.EditorAssetLibrary.load_asset(ASSET_PATH)
    if blueprint is None:
        return False
    subsystem = unreal.get_editor_subsystem(unreal.EditorUtilitySubsystem)
    return _attempt('tab.find_utility_widget', lambda: subsystem.find_utility_widget_from_blueprint(blueprint)) is not None


def capture_editor(label):
    """Generator: save a picture of the editor's own windows (Epic's EditorToolset renders them
    itself, so nothing else on the desktop is in it) to proto/out/editor-<version>-<label>.png."""
    value, error = yield from _registry_call('EditorToolset.EditorAppToolset', 'CaptureEditorImage', {})
    image = value.get('returnValue') if isinstance(value, dict) else None
    data = image.get('data') if isinstance(image, dict) else None
    if not data:
        note(f'capture.{label}', {'ok': False, 'error': error, 'value': repr(value)[:300]})
        return
    path = os.path.join(OUT_DIR, f'editor-{ENGINE_SHORT}-{label}.png')
    with open(path, 'wb') as handle:
        handle.write(base64.b64decode(data))
    note(f'capture.{label}', {'ok': True, 'path': path, 'mime': image.get('mimeType')})


# ---------------------------------------------------------------- tick runner


_running = {}


def run_on_ticks(generator, name):
    """Step a generator once per editor tick (no blocking sleeps).

    -ExecutePythonScript closes the editor the tick after the script returns unless the script
    asks to stay alive, so this keeps it alive until the generator quits the editor itself."""
    unreal.EditorPythonScripting.set_keep_python_script_alive(True)

    def tick(_delta):
        # Compiling or saving an asset pumps Slate, which calls this tick again inside the step.
        if getattr(generator, 'gi_running', False):
            return
        try:
            next(generator)
        except StopIteration:
            unreal.unregister_slate_post_tick_callback(_running.pop(name))
        except Exception as error:  # noqa: BLE001
            note(f'{name}.crashed', f'{type(error).__name__}: {error}')
            unreal.unregister_slate_post_tick_callback(_running.pop(name))
            unreal.EditorPythonScripting.set_keep_python_script_alive(False)

    _running[name] = unreal.register_slate_post_tick_callback(tick)


def wait(seconds):
    """Generator: yield ticks for this many seconds."""
    deadline = time.time() + seconds
    while time.time() < deadline:
        yield
