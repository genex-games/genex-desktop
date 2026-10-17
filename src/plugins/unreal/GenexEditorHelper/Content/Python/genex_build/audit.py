"""gx.audit and the audit tool: what the level is made of, in counts. Primitives (Unreal's
/Engine/BasicShapes cube, cylinder, sphere, cone and plane) are blockout, never the finished look;
the audit counts them, actors, mesh components, instances and an estimate of the triangles drawn
(a Nanite mesh counts its full Nanite triangles, an instanced mesh once per instance). Given a
camera, it also counts the primitives in that camera's view (a cone around its direction, within
VIEW_DISTANCE_CM), the ones a player would see in that shot.
"""

import math

import unreal

from genex_build import place
from genex_loop import editor

BASIC_SHAPES = '/Engine/BasicShapes/'
VIEW_DISTANCE_CM = 50_000.0
# How many of the heaviest meshes the audit names.
HEAVIEST = 5
LISTED_PRIMITIVES = 10


def _mesh_triangles(mesh: unreal.StaticMesh) -> int:
    nanite = mesh.get_num_nanite_triangles()
    return int(nanite) if nanite else int(mesh.get_num_triangles(0))


def _instances(component) -> int:
    if isinstance(component, unreal.InstancedStaticMeshComponent):
        return int(component.get_instance_count())
    return 1


def _in_view(location, camera) -> bool:
    """Whether a point is inside the camera's view cone (its horizontal FOV, generously), within the view distance."""
    eye = camera.get_actor_location()
    forward = camera.get_actor_forward_vector()
    offset = unreal.Vector(location.x - eye.x, location.y - eye.y, location.z - eye.z)
    distance = offset.length()
    if distance < 1.0:
        return True
    if distance > VIEW_DISTANCE_CM:
        return False
    cosine = (offset.x * forward.x + offset.y * forward.y + offset.z * forward.z) / distance
    half = math.radians(camera.camera_component.get_editor_property('field_of_view') / 2)
    return cosine >= math.cos(half)


def _components(actor) -> list:
    """The actor's mesh components a player can see (an editor-only camera mesh is none of them)."""
    return [c for c in actor.get_components_by_class(unreal.StaticMeshComponent)
            if c.get_editor_property('static_mesh') is not None and not c.get_editor_property('hidden_in_game')]


def audit(camera: str = '') -> dict:
    """{actors, meshComponents, instances, triangles, primitives, primitivesInView?, heaviest, primitiveActors}."""
    view = place.find_camera(camera) if camera else None
    totals = {'actors': 0, 'meshComponents': 0, 'instances': 0, 'triangles': 0, 'primitives': 0}
    in_view = 0
    by_mesh: dict[str, int] = {}
    primitive_actors: list[str] = []
    for actor in editor.actors().get_all_level_actors():
        totals['actors'] += 1
        for component in _components(actor):
            mesh = component.get_editor_property('static_mesh')
            count = _instances(component)
            path = mesh.get_path_name()
            totals['meshComponents'] += 1
            totals['instances'] += count
            totals['triangles'] += _mesh_triangles(mesh) * count
            by_mesh[path] = by_mesh.get(path, 0) + _mesh_triangles(mesh) * count
            if path.startswith(BASIC_SHAPES):
                totals['primitives'] += count
                primitive_actors.append(actor.get_actor_label())
                in_view += 1 if view is not None and _in_view(actor.get_actor_location(), view) else 0
    heaviest = sorted(by_mesh.items(), key=lambda item: -item[1])[:HEAVIEST]
    answer = {**totals, 'heaviest': [{'mesh': path.split('.')[0], 'triangles': tris} for path, tris in heaviest],
              'primitiveActors': sorted(set(primitive_actors))[:LISTED_PRIMITIVES]}
    if view is not None:
        answer['camera'] = view.get_actor_label()
        answer['primitivesInView'] = in_view
    return answer
