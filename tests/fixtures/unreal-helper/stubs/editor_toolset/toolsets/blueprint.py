"""A stand-in for Epic's BlueprintTools: creating a Blueprint fails when the test says so."""

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


class _BlueprintCache:
    @staticmethod
    def list_nodes(graph) -> list[str]:
        return []
