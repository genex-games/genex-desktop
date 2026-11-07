"""A stand-in for Epic's BlueprintTools: creating a Blueprint fails when the test says so, and a
graph written reads back as written unless the test says what Unreal kept (unreal.state['kept']),
or that reading it back fails (unreal.state['read_fails']). A graph's nodes, as find_nodes and
get_node_infos list them, are the NodeInfos in unreal.state['nodes'] (by graph path), which
delete_node removes; listing them fails when unreal.state['nodes_fail'] says so."""

import unreal

from toolset_registry import epic_tool


class NodeClass:
    def __init__(self, name: str) -> None:
        self.name = name

    def get_name(self) -> str:
        return self.name


class Node:
    """A node in a graph: its path and its class."""

    def __init__(self, path: str, cls: str) -> None:
        self.path = path
        self.cls = NodeClass(cls)

    def get_path_name(self) -> str:
        return self.path

    def get_class(self) -> NodeClass:
        return self.cls


class LinkedPin:
    """The pin at a link's other end, as a pin's connected_pins lists it: with the node it is on."""

    def __init__(self, node: Node) -> None:
        self.node = node


class Pin:
    def __init__(self, name: str, type_id: str, linked: list) -> None:
        self.name = name
        self.pin_id = name
        self.type_id = type_id
        self.connected_pins = linked


class NodeInfo:
    def __init__(self, node: Node, type_id: str, input_pins: list, output_pins: list) -> None:
        self.node = node
        self.type_id = type_id
        self.input_pins = input_pins
        self.output_pins = output_pins


def _infos(graph) -> list:
    return unreal.state.setdefault('nodes', {}).setdefault(graph.get_path_name(), [])


class BlueprintTools:
    @staticmethod
    @epic_tool
    def create(folder: str, name: str, parent):
        unreal._record('create_blueprint', f'{folder}/{name}', parent.get_path_name())
        if unreal.state['create_fails']:
            raise RuntimeError(f'Could not create Blueprint {name}')
        return unreal.Blueprint()


    @staticmethod
    @epic_tool
    def write_graph_dsl(graph, code: str):
        unreal._record('write_graph_dsl', graph.get_path_name())
        unreal.state.setdefault('written', {})[graph.get_path_name()] = code

    @staticmethod
    @epic_tool
    def read_graph_dsl(graph) -> str:
        unreal._record('read_graph_dsl', graph.get_path_name())
        if unreal.state.get('read_fails'):
            raise RuntimeError(unreal.state['read_fails'])
        path = graph.get_path_name()
        return unreal.state.get('kept', {}).get(path, unreal.state.get('written', {}).get(path, ''))

    @staticmethod
    @epic_tool
    def find_nodes(graph) -> list:
        if unreal.state.get('nodes_fail'):
            raise RuntimeError(unreal.state['nodes_fail'])
        return [info.node for info in _infos(graph)]

    @staticmethod
    @epic_tool
    def get_node_infos(nodes: list) -> list:
        every = [info for infos in unreal.state.get('nodes', {}).values() for info in infos]
        return [info for node in nodes for info in every if info.node is node]

    @staticmethod
    @epic_tool
    def delete_node(node) -> None:
        unreal._record('delete_node', node.get_path_name())
        for infos in unreal.state.get('nodes', {}).values():
            infos[:] = [info for info in infos if info.node is not node]


class _BlueprintCache:
    @staticmethod
    def list_nodes(graph) -> list[str]:
        return []
