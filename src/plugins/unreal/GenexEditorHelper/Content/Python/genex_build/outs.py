"""Reading what an Unreal function hands back.

A function with out-params answers a TUPLE in Python: its return value (if any) and each
out-param, in an order that differs between functions and engine versions. So the value wanted
is picked by its type, never by position: get_all_vertex_positions gives (mesh, positions, gaps),
create_new_static_mesh_asset_from_mesh gives (the new StaticMesh or None, the outcome).
"""

from genex_loop.errors import Refused


def pick(result: object, kind: type, what: str) -> object:
    """The value of type `kind` in an Unreal answer (the answer itself, or one item of its tuple); else Refused."""
    if isinstance(result, kind):
        return result
    if isinstance(result, tuple):
        for item in result:
            if isinstance(item, kind):
                return item
    raise Refused(f'Unreal gave no {what}.', got=type(result).__name__)
