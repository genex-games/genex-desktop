"""Building Blueprints the way a part declares them, as it works on UE 5.8.3:

- a Blueprint: BlueprintTools.create (BlueprintFactory), WidgetBlueprintFactory for UserWidget,
  AnimBlueprintFactory for AnimInstance; an existing asset of that name is reused;
- a component: SubobjectDataSubsystem.add_new_subobject under the root (the first gathered
  handle) or a named parent, then rename_subobject; one of that name is reused (the gather lists
  child components twice, so names are matched, not counted);
- a member variable: BlueprintEditorLibrary.add_member_variable with a pin type from
  get_basic_type_by_name (bool, int, real for float, byte, name, string, text), get_struct_type
  (Vector, Rotator, Transform, Vector2D, LinearColor) or get_object_reference_type for
  "<Class> object ref"; its category through BlueprintTools.set_variable_category;
- a function: BlueprintTools.add_function_graph, then BlueprintGraphEditor
  add_graph_input_parameter / add_graph_output_parameter for each missing input and output (what
  add_function_param does, without refusing one that exists);
- a graph's Blueprint text: BlueprintTools.write_graph_dsl (it compiles and raises on errors);
- a component held at a socket: an "Attach Component To Component" node right after the construction
  script's entry (Python can't set a Blueprint component's parent socket), made with BlueprintTools'
  node calls, or the one made before reused;
- compiling: BlueprintEditorLibrary.compile_blueprint, then the Blueprint's Status and the
  ErrorMsg of each node with an error (as Epic's compile_blueprint helper reads them).
"""

import re

import unreal

OBJECT_REF = re.compile(r'([A-Za-z][A-Za-z0-9_]{0,63}) object ref', re.IGNORECASE)
BASIC_TYPES = {'bool': 'bool', 'int': 'int', 'float': 'real', 'real': 'real', 'byte': 'byte',
               'name': 'name', 'string': 'string', 'text': 'text'}
STRUCT_TYPES = ('Vector', 'Rotator', 'Transform', 'Vector2D', 'LinearColor')


def _tools():
    # Imported on use so the helper's other tools load even if Epic's toolset changes.
    from editor_toolset.toolsets.blueprint import BlueprintTools
    return BlueprintTools


def unreal_class(name_or_class: object, base: type = unreal.Object) -> unreal.Class:
    """An unreal class from a class or a name such as 'PointLightComponent', or ValueError."""
    if isinstance(name_or_class, unreal.Class):
        return name_or_class
    found = getattr(unreal, name_or_class, None) if isinstance(name_or_class, str) else name_or_class
    if not isinstance(found, type) or not issubclass(found, base):
        raise ValueError(f'{name_or_class} is not a {base.__name__} class.')
    return found.static_class()


def make_blueprint(folder: str, name: str, base: object) -> unreal.Blueprint:
    """The Blueprint folder/name, created with the base class (a class or its name) or reused."""
    path = f'{folder}/{name}'
    if unreal.EditorAssetLibrary.does_asset_exist(path):
        return unreal.load_asset(path)
    parent = unreal_class(base)
    tools = unreal.AssetToolsHelpers.get_asset_tools()
    if unreal.MathLibrary.class_is_child_of(parent, unreal.UserWidget.static_class()):
        factory = unreal.WidgetBlueprintFactory()
        factory.set_editor_property('parent_class', parent)
        return tools.create_asset(name, folder, unreal.WidgetBlueprint, factory)
    if unreal.MathLibrary.class_is_child_of(parent, unreal.AnimInstance.static_class()):
        factory = unreal.AnimBlueprintFactory()
        factory.set_editor_property('parent_class', parent)
        factory.set_editor_property('template', True)
        return tools.create_asset(name, folder, unreal.AnimBlueprint, factory)
    return _tools().create(folder, name, parent)


def _subobjects() -> unreal.SubobjectDataSubsystem:
    return unreal.get_engine_subsystem(unreal.SubobjectDataSubsystem)


def _handle_named(blueprint: unreal.Blueprint, name: str):
    library = unreal.SubobjectDataBlueprintFunctionLibrary
    for handle in _subobjects().k2_gather_subobject_data_for_blueprint(blueprint):
        data = _subobjects().k2_find_subobject_data_from_handle(handle)
        if str(library.get_variable_name(data)) == name:
            return handle
    return None


def add_component(blueprint: unreal.Blueprint, cls: object, name: str, parent: str | None = None) -> unreal.ActorComponent:
    """The Blueprint's component `name` of class `cls` (added under `parent` or the root, or reused)."""
    library = unreal.SubobjectDataBlueprintFunctionLibrary
    existing = _handle_named(blueprint, name)
    if existing is None:
        under = _handle_named(blueprint, parent) if parent else _subobjects().k2_gather_subobject_data_for_blueprint(blueprint)[0]
        if under is None:
            raise ValueError(f'{name}: there is no component {parent} to put it under.')
        params = unreal.AddNewSubobjectParams(parent_handle=under, new_class=unreal_class(cls, unreal.ActorComponent),
                                              blueprint_context=blueprint)
        existing, failure = _subobjects().add_new_subobject(params)
        if str(failure) not in ('', 'None'):
            raise ValueError(f'{name}: {failure}')
        _subobjects().rename_subobject(existing, unreal.Text(name))
    return library.get_object(_subobjects().k2_find_subobject_data_from_handle(existing))


def _object_class(name: str, folder: str | None) -> unreal.Class:
    """An engine class by name, else the Blueprint of that name in the part's folder."""
    if isinstance(getattr(unreal, name, None), type):
        return unreal_class(name)
    asset = unreal.load_asset(f'{folder}/{name}') if folder else None
    if isinstance(asset, unreal.Blueprint):
        return asset.generated_class()
    raise ValueError(f'{name} is neither an Unreal class nor a Blueprint of this part.')


def pin_type(type_name: str, folder: str | None = None) -> unreal.EdGraphPinType:
    """The pin type for a declared type name, or ValueError naming the ones it knows."""
    library = unreal.BlueprintEditorLibrary
    key = type_name.strip()
    if key.lower() in BASIC_TYPES:
        return library.get_basic_type_by_name(BASIC_TYPES[key.lower()])
    struct = next((s for s in STRUCT_TYPES if s.lower() == key.lower()), None)
    if struct:
        return library.get_struct_type(getattr(unreal, struct).static_struct())
    match = OBJECT_REF.fullmatch(key)
    if match:
        return library.get_object_reference_type(_object_class(match.group(1), folder))
    raise ValueError(f'Unknown type "{type_name}": use bool, int, float, byte, name, string, text, '
                     f'{", ".join(STRUCT_TYPES)} or "<Class> object ref".')


def add_variable(blueprint: unreal.Blueprint, name: str, type_name: str, category: str = '',
                 folder: str | None = None) -> None:
    """Adds a member variable unless one of that name exists."""
    library = unreal.BlueprintEditorLibrary
    if name not in [str(n) for n in library.list_member_variable_names(blueprint, False)]:
        if not library.add_member_variable(blueprint, name, pin_type(type_name, folder)):
            raise ValueError(f'Could not add variable {name} ({type_name}).')
    if category:
        _tools().set_variable_category(blueprint, name, category)


def add_function(blueprint: unreal.Blueprint, name: str, inputs: list, outputs: list,
                 folder: str | None = None) -> unreal.EdGraph:
    """The function graph `name` with the declared inputs and outputs (those missing are added)."""
    tools = _tools()
    graph = tools.add_function_graph(blueprint, name)
    editor = unreal.BlueprintGraphEditor.get_graph_editor(graph)
    for is_input, pins in ((True, inputs), (False, outputs)):
        for pin in pins:
            if tools._param_name_exists(graph, pin.name, is_input):
                continue
            if is_input:
                editor.add_graph_input_parameter(pin.name, pin_type(pin.type, folder))
            else:
                editor.add_graph_output_parameter(pin.name, pin_type(pin.type, folder))
    return graph


def graph_named(blueprint: unreal.Blueprint, graph: str | None) -> unreal.EdGraph:
    """The event graph (None or 'EventGraph'), or the function graph of that name (created first)."""
    if graph in (None, '', 'EventGraph'):
        return unreal.BlueprintEditorLibrary.find_event_graph(blueprint)
    return _tools().add_function_graph(blueprint, graph)


def write_graph(blueprint: unreal.Blueprint, text: str, graph: str | None = None) -> None:
    """Writes Blueprint text into a graph (Epic's write_graph_dsl); raises with Epic's message."""
    _tools().write_graph_dsl(graph_named(blueprint, graph), text)


def compile_status(blueprint: unreal.Blueprint) -> tuple[bool, list[str]]:
    """Compiles the Blueprint: whether it compiled, and its nodes' error messages."""
    unreal.BlueprintEditorLibrary.compile_blueprint(blueprint)
    status = blueprint.get_editor_property('status')
    if status == unreal.BlueprintStatus.BS_UP_TO_DATE:
        return True, []
    messages = []
    for graph in unreal.BlueprintEditorLibrary.list_graphs(blueprint):
        editor = unreal.BlueprintGraphEditor.get_graph_editor(graph)
        messages += [f'{graph.get_name()}: {node.get_editor_property("ErrorMsg")}'
                     for node in editor.list_nodes_with_errors()]
    compiled = status == unreal.BlueprintStatus.BS_UP_TO_DATE_WITH_WARNINGS
    return compiled, messages or ([] if compiled else [f'{blueprint.get_name()} did not compile ({status}).'])


CONSTRUCTION_SCRIPT = 'UserConstructionScript'
ATTACH_NODE = 'Transformation|AttachComponentToComponent'
KEEP_RELATIVE = 'KeepRelative'
FUNCTION_ENTRY = 'K2Node_FunctionEntry'


def _getter(graph, name: str) -> str:
    """The type id of the Blueprint node that reads the component variable `name` (its display name, no _ or spaces)."""
    wanted = f'|Get{name.replace("_", "").replace(" ", "")}'
    found = [t for t in _tools().find_node_types(graph, wanted[1:]) if t.startswith('Variables|') and t.endswith(wanted)]
    if not found:
        raise ValueError(f'No Blueprint node reads the component {name}; compile the Blueprint and retry.')
    return found[0]


def _pin(info, name: str, inputs: bool = True):
    pins = info.input_pins if inputs else info.output_pins
    return next(pin for pin in pins if str(pin.name) == name)


def _reads(source, getter: str) -> bool:
    """Whether a node is a getter of the variable `getter` reads: placed nodes list it as "|Get<Name>"."""
    return source is not None and source.type_id.rsplit('|', 1)[-1] == getter.rsplit('|', 1)[-1]


def _existing_attaches(graph, getter: str) -> list:
    """The attach nodes whose target is read by `getter` (ones this made before), in graph order."""
    tools = _tools()
    infos = tools.get_node_infos(tools.find_nodes(graph))
    by_node = {info.node.get_path_name(): info for info in infos}
    found = []
    for info in infos:
        if info.type_id != ATTACH_NODE:
            continue
        if any(_reads(by_node.get(linked.node.get_path_name()), getter) for linked in _pin(info, 'self').connected_pins):
            found.append(info)
    return found


def _remove_attach(info) -> None:
    """Deletes an attach node and the getters feeding it, joining the exec flow around it."""
    tools = _tools()
    sources = list(_pin(info, 'execute').connected_pins)
    targets = list(_pin(info, 'then', False).connected_pins)
    getters = [linked.node for name in ('self', 'Parent') for linked in _pin(info, name).connected_pins]
    for source in sources:
        tools.break_pins(source, _pin(info, 'execute').pin_id)
        for target in targets:
            tools.connect_pins(source, target)
    for node in [info.node, *getters]:
        tools.delete_node(node)


def _insert_attach(graph, getter: str, parent_getter: str):
    """A new attach node right after the construction script's entry, its target and parent wired; its NodeInfo."""
    tools = _tools()
    infos = tools.get_node_infos(tools.find_nodes(graph))
    # The entry's type id is the graph's display name ("|ConstructionScript"), so it is found by its class.
    entry = next(info for info in infos if info.node.get_class().get_name() == FUNCTION_ENTRY)
    then = next(pin for pin in entry.output_pins if str(pin.type_id) == 'Exec')
    after = list(then.connected_pins)
    base = entry.position
    attach = tools.create_node(graph, ATTACH_NODE, unreal.IntPoint(base.x + 260, base.y + 260))
    target = tools.create_node(graph, getter, unreal.IntPoint(base.x, base.y + 360))
    parent = tools.create_node(graph, parent_getter, unreal.IntPoint(base.x, base.y + 440))
    node = tools.get_node_infos([attach])[0]
    for pin in after:
        tools.break_pins(then.pin_id, pin)
        tools.connect_pins(_pin(node, 'then', False).pin_id, pin)
    tools.connect_pins(then.pin_id, _pin(node, 'execute').pin_id)
    tools.connect_pins(tools.get_node_infos([target])[0].output_pins[0].pin_id, _pin(node, 'self').pin_id)
    tools.connect_pins(tools.get_node_infos([parent])[0].output_pins[0].pin_id, _pin(node, 'Parent').pin_id)
    return tools.get_node_infos([attach])[0]


def attach_in_construction_script(blueprint: unreal.Blueprint, component: str, parent: str,
                                  parent_getter: str | None, socket: str) -> None:
    """Holds the component variable `component` at `socket` of `parent` from the construction script,
    keeping its relative offset; `parent_getter` names the node reading the parent when it isn't the
    Blueprint's own component variable (a Character's inherited Mesh)."""
    tools = _tools()
    graph = tools.get_graph(blueprint, CONSTRUCTION_SCRIPT)
    getter = _getter(graph, component)
    existing = _existing_attaches(graph, getter)
    for extra in existing[1:]:
        _remove_attach(extra)
    info = existing[0] if existing else _insert_attach(graph, getter, parent_getter or _getter(graph, parent))
    tools.set_pin_value(_pin(info, 'SocketName').pin_id, socket)
    for rule in ('LocationRule', 'RotationRule', 'ScaleRule'):
        tools.set_pin_value(_pin(info, rule).pin_id, KEEP_RELATIVE)
