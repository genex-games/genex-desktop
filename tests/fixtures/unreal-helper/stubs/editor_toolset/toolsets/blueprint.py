"""A stand-in for Epic's BlueprintTools: creating a Blueprint fails when the test says so, and a
graph written reads back as written unless the test says what Unreal kept (unreal.state['kept']),
or that reading it back fails (unreal.state['read_fails'])."""

import unreal

from toolset_registry import epic_tool


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


class _BlueprintCache:
    @staticmethod
    def list_nodes(graph) -> list[str]:
        return []
