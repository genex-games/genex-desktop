"""The true triangle count of a model file, read from the file itself: Unreal's own count of an
imported Nanite mesh is its fallback mesh (a 148k-triangle model reads as about 15k), so an import
reports this one beside it. Reads .glb and .gltf (every mesh primitive drawn by a node, triangles
only) and .obj (each face of n corners is n - 2 triangles); answers None for anything else or a
file it can't read. Also the scale a rigged glTF's skeleton root carries (an exporter's centimetre
Armature at 0.01), which Unreal's import bakes into the mesh: rig_math takes it out of the file
before the import. Pure Python: reads the file, never runs or imports anything."""

import json
import os
import struct

GLB_MAGIC = b'glTF'
GLB_HEADER = struct.Struct('<4sII')
CHUNK_HEADER = struct.Struct('<II')
JSON_CHUNK = 0x4E4F534A
# glTF primitive modes: 4 triangles, 5 a strip, 6 a fan; anything else draws no triangles.
TRIANGLES, STRIP, FAN = 4, 5, 6
MAX_JSON_BYTES = 32 * 1024 * 1024
# A skeleton root scaled within this of 1 is left as it is: only a unit change (0.01, 100) is countered.
UNIT_SCALE_LOW, UNIT_SCALE_HIGH = 0.2, 5.0


def _glb_json(data: bytes) -> dict | None:
    """The JSON chunk of a binary glTF, or None."""
    if len(data) < GLB_HEADER.size + CHUNK_HEADER.size:
        return None
    magic, _version, _length = GLB_HEADER.unpack_from(data, 0)
    length, kind = CHUNK_HEADER.unpack_from(data, GLB_HEADER.size)
    start = GLB_HEADER.size + CHUNK_HEADER.size
    if magic != GLB_MAGIC or kind != JSON_CHUNK or length > MAX_JSON_BYTES:
        return None
    return json.loads(data[start:start + length].decode('utf-8'))


def _primitive_triangles(document: dict, primitive: dict) -> int:
    accessors = document.get('accessors', [])
    index = primitive.get('indices')
    if index is None:
        index = primitive.get('attributes', {}).get('POSITION')
    count = accessors[index].get('count', 0) if isinstance(index, int) and 0 <= index < len(accessors) else 0
    mode = primitive.get('mode', TRIANGLES)
    if mode == TRIANGLES:
        return count // 3
    return max(0, count - 2) if mode in (STRIP, FAN) else 0


def gltf_triangles(document: dict) -> int:
    """Triangles every node draws: a mesh used by several nodes counts once per node."""
    meshes = document.get('meshes', [])
    per_mesh = [sum(_primitive_triangles(document, p) for p in mesh.get('primitives', [])) for mesh in meshes]
    drawn = [node.get('mesh') for node in document.get('nodes', []) if isinstance(node.get('mesh'), int)]
    if not drawn:
        return sum(per_mesh)
    return sum(per_mesh[m] for m in drawn if 0 <= m < len(per_mesh))


def obj_triangles(text: str) -> int:
    """Triangles of an OBJ's faces."""
    total = 0
    for line in text.splitlines():
        if line.startswith('f '):
            total += max(0, len(line.split()) - 3)
    return total


def source_triangles(file: str) -> int | None:
    """The model file's own triangle count, or None (see the module notes)."""
    extension = os.path.splitext(file)[1].lower()
    try:
        if extension == '.glb':
            with open(file, 'rb') as handle:
                document = _glb_json(handle.read())
            return gltf_triangles(document) if document is not None else None
        if extension == '.gltf':
            with open(file, encoding='utf-8') as handle:
                return gltf_triangles(json.load(handle))
        if extension == '.obj':
            with open(file, encoding='utf-8', errors='replace') as handle:
                return obj_triangles(handle.read())
    except (OSError, ValueError, KeyError, TypeError, struct.error):
        return None
    return None


def parents_of(document: dict) -> dict[int, int]:
    """Each node's parent, by index."""
    parents = {}
    for index, node in enumerate(document.get('nodes', [])):
        for child in node.get('children', []):
            if isinstance(child, int):
                parents[child] = index
    return parents


def _uniform(node: dict) -> float:
    """A node's scale as one number: the mean of its three axes (1 when it has none)."""
    scale = node.get('scale')
    if not (isinstance(scale, list) and len(scale) == 3):
        return 1.0
    return sum(float(axis) for axis in scale) / 3


def depth_of(node: int, parents: dict[int, int]) -> int:
    """How many ancestors the node has."""
    depth, seen = 0, set()
    while node in parents and node not in seen:
        seen.add(node)
        node = parents[node]
        depth += 1
    return depth


def skeleton_root(document: dict) -> int | None:
    """The node a glTF's skeleton hangs from: the shallowest joint of its first skin, or, in a file of clips
    with no skin, the shallowest node an animation moves; None when it has neither."""
    nodes = document.get('nodes', [])
    skins = document.get('skins', [])
    joints = skins[0].get('joints', []) if skins and isinstance(skins[0], dict) else []
    if not joints:
        joints = [channel.get('target', {}).get('node') for animation in document.get('animations', [])
                  if isinstance(animation, dict) for channel in animation.get('channels', []) if isinstance(channel, dict)]
    found = [j for j in joints if isinstance(j, int) and not isinstance(j, bool) and 0 <= j < len(nodes)]
    if not found:
        return None
    parents = parents_of(document)
    return min(found, key=lambda joint: (depth_of(joint, parents), joint))


def skeleton_counter_scale(document: dict) -> float:
    """The uniform scale that undoes the scale of a glTF's skeleton root (skeleton_root) and the chain above it,
    or 1 when that scale is within a unit's tolerance of 1 or there is no skeleton. The root joint's own scale
    counts: an Armature's 0.01 applied to the object alone leaves the root bone at x100 with every other bone
    in metres."""
    nodes = document.get('nodes', [])
    root = skeleton_root(document)
    if root is None:
        return 1.0
    parents = parents_of(document)
    product, at, seen = _uniform(nodes[root]), parents.get(root), set()
    while isinstance(at, int) and 0 <= at < len(nodes) and at not in seen:
        seen.add(at)
        product *= _uniform(nodes[at])
        at = parents.get(at)
    if product <= 0 or UNIT_SCALE_LOW <= product <= UNIT_SCALE_HIGH:
        return 1.0
    return 1.0 / product


def source_counter_scale(file: str) -> float:
    """skeleton_counter_scale of a .glb or .gltf file; 1 for any other file or one it can't read."""
    extension = os.path.splitext(file)[1].lower()
    try:
        if extension == '.glb':
            with open(file, 'rb') as handle:
                document = _glb_json(handle.read())
            return skeleton_counter_scale(document) if document is not None else 1.0
        if extension == '.gltf':
            with open(file, encoding='utf-8') as handle:
                return skeleton_counter_scale(json.load(handle))
    except (OSError, ValueError, KeyError, TypeError, struct.error):
        return 1.0
    return 1.0
