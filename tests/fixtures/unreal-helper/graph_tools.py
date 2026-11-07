"""A stand-in for the graph calls of Epic's BlueprintTools that attach_to_socket's construction-script
node uses: a graph per Blueprint (its entry first), nodes made by type id with the pins Unreal gives
them, pins joined and broken, values set, nodes deleted. Like Unreal, the node types it finds read a
component variable only after the Blueprint compiled with that component (the stub's
`compile_blueprint` keeps the names it compiled), and like Epic's toolset it remembers each graph's
node types until the Blueprint's member variables or graphs change (`NodeTypeCache`)."""

import unreal

ENTRY_CLASS = 'K2Node_FunctionEntry'
ATTACH = 'Transformation|AttachComponentToComponent'
ATTACH_INPUTS = ('execute', 'self', 'Parent', 'SocketName', 'LocationRule', 'RotationRule', 'ScaleRule')


class Point:
    """unreal.IntPoint where the tests create graph nodes."""

    def __init__(self, x: int = 0, y: int = 0) -> None:
        self.x, self.y = x, y


class Pin:
    """A pin and its id at once: its node, name, type and the pins joined to it."""

    def __init__(self, node: 'Node', name: str, type_id: str = 'Object') -> None:
        self.node, self.name, self.type_id = node, name, type_id
        self.joined: list['Pin'] = []
        self.value = ''

    @property
    def pin_id(self) -> 'Pin':
        return self

    @property
    def connected_pins(self) -> list['Pin']:
        return list(self.joined)


class Node(unreal.Object):
    def __init__(self, graph: 'Graph', type_id: str, class_name: str, position) -> None:
        self.graph, self.type_id, self.class_name, self.position = graph, type_id, class_name, position
        self.number = len(graph.made)
        graph.made.append(self)
        self.input_pins: list[Pin] = []
        self.output_pins: list[Pin] = []

    @property
    def node(self) -> 'Node':
        return self

    def get_path_name(self) -> str:
        return f'{self.graph.blueprint.get_path_name()}:{self.graph.name}.{self.class_name}_{self.number}'

    def get_class(self):
        return unreal.Class(path=self.class_name)

    def pin(self, name: str) -> Pin:
        return next(pin for pin in self.input_pins + self.output_pins if pin.name == name)

    def source(self, name: str) -> 'Node | None':
        """The node feeding the input `name`, or None."""
        joined = self.pin(name).joined
        return joined[0].node if joined else None


class Graph:
    def __init__(self, blueprint, name: str) -> None:
        self.blueprint, self.name, self.made = blueprint, name, []
        self.nodes: list[Node] = []
        entry = Node(self, f'|{name}', ENTRY_CLASS, Point(0, 0))
        entry.output_pins.append(Pin(entry, 'then', 'Exec'))
        self.nodes.append(entry)

    def of_type(self, type_id: str) -> list[Node]:
        return [node for node in self.nodes if node.type_id == type_id]


def graph_of(blueprint, name: str) -> Graph:
    graphs = vars(blueprint).setdefault('graphs', {})
    return graphs.setdefault(name, Graph(blueprint, name))


class NodeTypeCache:
    """Epic's _BlueprintCache as UE 5.8.3 has it: each graph's node types, kept for the whole editor session
    under a fingerprint of the Blueprint's member variables and graph names. A component added later changes
    neither, so the node reading it is missing until `invalidate`; compiling never invalidates."""

    remembered: dict[str, tuple] = {}

    @classmethod
    def node_types(cls, graph: Graph) -> list[str]:
        blueprint = graph.blueprint
        fingerprint = (tuple(blueprint.variables), tuple(vars(blueprint).get('graphs', {})))
        key = f'{blueprint.get_path_name()}:{graph.name}'
        if key not in cls.remembered or cls.remembered[key][0] != fingerprint:
            readers = [f'Variables|Default|Get{name}' for name in vars(blueprint).get('compiled', [])]
            cls.remembered[key] = (fingerprint, [*readers, ATTACH])
        return cls.remembered[key][1]

    @classmethod
    def invalidate(cls, blueprint) -> None:
        prefix = blueprint.get_path_name()
        for key in [key for key in cls.remembered if key.startswith(prefix)]:
            del cls.remembered[key]


class GraphTools:
    """The BlueprintTools calls blueprints.py makes on a graph."""

    @staticmethod
    def get_graph(blueprint, name: str) -> Graph:
        return graph_of(blueprint, name)

    @staticmethod
    def find_node_types(graph: Graph, type_id_filter: str) -> list[str]:
        return [type_id for type_id in NodeTypeCache.node_types(graph) if type_id_filter in type_id]

    @staticmethod
    def find_nodes(graph: Graph) -> list[Node]:
        return list(graph.nodes)

    @staticmethod
    def get_node_infos(nodes: list) -> list[Node]:
        return list(nodes)

    @staticmethod
    def create_node(graph: Graph, type_id: str, position) -> Node:
        if type_id == ATTACH:
            node = Node(graph, type_id, 'K2Node_CallFunction', position)
            node.input_pins = [Pin(node, name, 'Exec' if name == 'execute' else 'Object') for name in ATTACH_INPUTS]
            node.output_pins = [Pin(node, 'then', 'Exec'), Pin(node, 'ReturnValue', 'Boolean')]
        elif type_id.startswith('Variables|'):
            node = Node(graph, type_id, 'K2Node_VariableGet', position)
            node.output_pins = [Pin(node, type_id.rsplit('|Get', 1)[-1])]
        else:
            raise ValueError(f'{type_id} is not a node type of this graph')
        graph.nodes.append(node)
        return node

    @staticmethod
    def connect_pins(one: Pin, other: Pin) -> None:
        one.joined.append(other)
        other.joined.append(one)

    @staticmethod
    def break_pins(one: Pin, other: Pin) -> None:
        one.joined = [pin for pin in one.joined if pin is not other]
        other.joined = [pin for pin in other.joined if pin is not one]

    @staticmethod
    def set_pin_value(pin: Pin, value: str) -> None:
        pin.value = value

    @staticmethod
    def delete_node(node: Node) -> None:
        for pin in node.input_pins + node.output_pins:
            for other in pin.joined:
                other.joined = [joined for joined in other.joined if joined is not pin]
            pin.joined = []
        node.graph.nodes.remove(node)
