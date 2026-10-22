"""A rigged binary glTF whose skeleton hangs under a scaled root (an exporter's centimetre Armature
at 0.01, or a root bone left at such a scale) lands in Unreal that many times too small or large, and
no import option undoes it cleanly. bake() takes the scale out of the file instead, keeping every
bone and every skinned vertex where it was:

- each scaled node from the skeleton root up (mesh_math.skeleton_root) gets scale 1;
- every node below the topmost of them has its translation, and every translation key of its clips,
  multiplied by the scale it lost from above;
- a scaled node's own scale keys are divided by that scale;
- each joint's inverse bind matrix is premultiplied by the scale its joint lost, so the skin binds
  the same vertices to the same places.

A node's world transform was its new one times that scale, which is the uniform scale's property
S(s) T(t) R(r) = T(s t) R(r) S(s); a skinned mesh node's own transform does not count in glTF.
Anything it can't bake exactly gives None and the file is imported as it is: a scale that differs
by axis, a node given as a matrix, a mesh without a skin under the scaled node (it would change
size), keys or matrices that are not plain floats in the file's own buffer, or one accessor two
different changes would need. Pure Python: reads and writes bytes, never the engine.
"""

import json
import struct

from genex_build import mesh_math

GLB_HEADER = struct.Struct('<4sII')
CHUNK_HEADER = struct.Struct('<II')
GLB_MAGIC = b'glTF'
GLB_VERSION = 2
JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942
FLOAT = 5126
FLOAT_BYTES = 4
COMPONENTS = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}
MATRIX_SIDE = 4
# How far a scale's axes may differ (relative) and still be one uniform scale.
UNIFORM_TOLERANCE = 1e-4
# A scale this close to 1 is no scale.
UNIT_TOLERANCE = 1e-6


def read_glb(data: bytes) -> tuple[dict, bytearray] | None:
    """(the JSON document, its binary chunk) of a binary glTF, or None."""
    if len(data) < GLB_HEADER.size + CHUNK_HEADER.size:
        return None
    magic, _version, _total = GLB_HEADER.unpack_from(data, 0)
    length, kind = CHUNK_HEADER.unpack_from(data, GLB_HEADER.size)
    start = GLB_HEADER.size + CHUNK_HEADER.size
    if magic != GLB_MAGIC or kind != JSON_CHUNK or start + length > len(data):
        return None
    try:
        document = json.loads(data[start:start + length].decode('utf-8'))
    except ValueError:
        return None
    binary = bytearray()
    at = start + length
    if at + CHUNK_HEADER.size <= len(data):
        size, kind = CHUNK_HEADER.unpack_from(data, at)
        if kind == BIN_CHUNK:
            binary = bytearray(data[at + CHUNK_HEADER.size:at + CHUNK_HEADER.size + size])
    return (document, binary) if isinstance(document, dict) else None


def write_glb(document: dict, binary: bytes) -> bytes:
    """A binary glTF of the document and its binary chunk, each padded to four bytes."""
    text = json.dumps(document, separators=(',', ':')).encode('utf-8')
    text += b' ' * (-len(text) % 4)
    chunks = CHUNK_HEADER.pack(len(text), JSON_CHUNK) + text
    if binary:
        padded = bytes(binary) + b'\0' * (-len(binary) % 4)
        chunks += CHUNK_HEADER.pack(len(padded), BIN_CHUNK) + padded
    return GLB_HEADER.pack(GLB_MAGIC, GLB_VERSION, GLB_HEADER.size + len(chunks)) + chunks


def _uniform_scale(node: dict) -> float | None:
    """The node's scale as one number (1 without one), or None when its axes differ or it isn't positive."""
    scale = node.get('scale', [1.0, 1.0, 1.0])
    if not (isinstance(scale, list) and len(scale) == 3 and all(isinstance(a, (int, float)) for a in scale)):
        return None
    mean = sum(scale) / 3
    if mean <= 0 or max(scale) - min(scale) > UNIFORM_TOLERANCE * mean:
        return None
    return mean


def _removed_scales(document: dict, root: int, parents: dict) -> dict | None:
    """{node: its uniform scale} for the root and its ancestors not at scale 1, or None when one can't be baked."""
    nodes = document['nodes']
    removed, at, seen = {}, root, set()
    while isinstance(at, int) and at not in seen:
        seen.add(at)
        if 'matrix' in nodes[at]:
            return None
        scale = _uniform_scale(nodes[at])
        if scale is None:
            return None
        if abs(scale - 1.0) > UNIT_TOLERANCE:
            removed[at] = scale
        at = parents.get(at)
    return removed


def _below(document: dict, top: int) -> list:
    """The node `top` and every node under it."""
    nodes, found, stack = document['nodes'], [], [top]
    while stack:
        index = stack.pop()
        if index in found or not 0 <= index < len(nodes):
            continue
        found.append(index)
        stack.extend(child for child in nodes[index].get('children', []) if isinstance(child, int))
    return found


def _factors(document: dict, removed: dict, parents: dict, subtree: list) -> tuple[dict, dict]:
    """({node: scale its ancestors lost}, {node: scale it and its ancestors lost}) under the topmost scaled node."""
    above, through = {}, {}
    for node in subtree:
        lost, at, seen = 1.0, parents.get(node), set()
        while isinstance(at, int) and at not in seen:
            seen.add(at)
            lost *= removed.get(at, 1.0)
            at = parents.get(at)
        above[node], through[node] = lost, lost * removed.get(node, 1.0)
    return above, through


class _Edits:
    """Per accessor, the change its floats need: one factor for all, or one per matrix (inverse bind
    matrices). A second, different change for the same accessor makes the bake impossible."""

    def __init__(self) -> None:
        self.wanted: dict = {}
        self.clash = False

    def want(self, accessor: object, change: tuple) -> None:
        if not isinstance(accessor, int):
            self.clash = True
            return
        if self.wanted.setdefault(accessor, change) != change:
            self.clash = True


def _element_offsets(document: dict, accessor: dict, components: int) -> list | None:
    """The byte offset of each element's first float in the binary chunk, or None when not plain floats there."""
    views = document.get('bufferViews', [])
    view_index = accessor.get('bufferView')
    if accessor.get('componentType') != FLOAT or accessor.get('normalized') or 'sparse' in accessor:
        return None
    if not isinstance(view_index, int) or not 0 <= view_index < len(views):
        return None
    view = views[view_index]
    buffer = document.get('buffers', [{}])[view.get('buffer', 0)] if document.get('buffers') else {}
    if view.get('buffer', 0) != 0 or 'uri' in buffer:
        return None
    stride = view.get('byteStride') or components * FLOAT_BYTES
    start = view.get('byteOffset', 0) + accessor.get('byteOffset', 0)
    return [start + i * stride for i in range(accessor.get('count', 0))]


def _apply(document: dict, binary: bytearray, index: int, change: tuple) -> bool:
    """Scales accessor `index`'s floats in place (and its min and max); False when it can't."""
    accessors = document.get('accessors', [])
    if not 0 <= index < len(accessors):
        return False
    accessor = accessors[index]
    components = COMPONENTS.get(accessor.get('type'))
    offsets = _element_offsets(document, accessor, components or 0) if components else None
    if offsets is None or (offsets and offsets[-1] + components * FLOAT_BYTES > len(binary)):
        return False
    kind, factors = change
    if kind == 'matrix' and (components != MATRIX_SIDE * MATRIX_SIDE or len(factors) != len(offsets)):
        return False
    values = []
    for element, offset in enumerate(offsets):
        floats = list(struct.unpack_from(f'<{components}f', binary, offset))
        if kind == 'all':
            floats = [f * factors for f in floats]
        else:  # premultiply by diag(s, s, s, 1): rows 0 to 2 of the column-major matrix
            floats = [f * factors[element] if i % MATRIX_SIDE < 3 else f for i, f in enumerate(floats)]
        struct.pack_into(f'<{components}f', binary, offset, *floats)
        values.append(floats)
    if values and 'min' in accessor and 'max' in accessor:
        accessor['min'] = [min(v[i] for v in values) for i in range(components)]
        accessor['max'] = [max(v[i] for v in values) for i in range(components)]
    return True


def _plan_nodes(document: dict, removed: dict, above: dict, edits: _Edits) -> bool:
    """Sets the new node scales and translations; False when a rigid mesh hangs under the scale."""
    nodes = document['nodes']
    for node, lost in above.items():
        entry = nodes[node]
        if 'mesh' in entry and 'skin' not in entry:
            return False
        if 'matrix' in entry:
            return False
        if node in removed:
            entry.pop('scale', None)
        if 'translation' in entry and abs(lost - 1.0) > UNIT_TOLERANCE:
            entry['translation'] = [t * lost for t in entry['translation']]
    for animation in document.get('animations', []):
        samplers = animation.get('samplers', [])
        for channel in animation.get('channels', []):
            node = channel.get('target', {}).get('node')
            path = channel.get('target', {}).get('path')
            sampler = channel.get('sampler')
            if node not in above or not isinstance(sampler, int) or not 0 <= sampler < len(samplers):
                continue
            output = samplers[sampler].get('output')
            if path == 'translation':
                edits.want(output, ('all', above[node]))
            elif path == 'scale':
                edits.want(output, ('all', 1.0 / removed.get(node, 1.0)))
    return True


def _plan_skins(document: dict, through: dict, edits: _Edits) -> None:
    for skin in document.get('skins', []):
        joints = skin.get('joints', [])
        factors = tuple(through.get(joint, 1.0) for joint in joints)
        if 'inverseBindMatrices' in skin and any(abs(f - 1.0) > UNIT_TOLERANCE for f in factors):
            edits.want(skin['inverseBindMatrices'], ('matrix', factors))


def bake(data: bytes) -> tuple[bytes, float] | None:
    """(the file with its skeleton's scale baked in, the scale taken out: 0.01 for a centimetre Armature), or None
    when there is nothing to bake or it can't be baked exactly (see the module notes)."""
    read = read_glb(data)
    if read is None:
        return None
    document, binary = read
    if not isinstance(document.get('nodes'), list) or mesh_math.skeleton_counter_scale(document) == 1.0:
        return None
    root = mesh_math.skeleton_root(document)
    parents = mesh_math.parents_of(document)
    removed = _removed_scales(document, root, parents) if root is not None else None
    if not removed:
        return None
    top = min(removed, key=lambda node: mesh_math.depth_of(node, parents))
    subtree = _below(document, top)
    above, through = _factors(document, removed, parents, subtree)
    edits = _Edits()
    if not _plan_nodes(document, removed, above, edits):
        return None
    _plan_skins(document, through, edits)
    uses = _accessor_uses(document)
    for index in edits.wanted:
        if uses.get(index, 0) > 1:
            edits.clash = True
    if edits.clash or not all(_apply(document, binary, i, change) for i, change in edits.wanted.items()):
        return None
    taken = 1.0
    for scale in removed.values():
        taken *= scale
    return write_glb(document, binary), taken


def _accessor_uses(document: dict) -> dict:
    """How many places read each accessor: animation outputs, inverse bind matrices and mesh attributes."""
    uses: dict = {}

    def count(index: object) -> None:
        if isinstance(index, int):
            uses[index] = uses.get(index, 0) + 1

    for animation in document.get('animations', []):
        for sampler in animation.get('samplers', []):
            count(sampler.get('output'))
    for skin in document.get('skins', []):
        count(skin.get('inverseBindMatrices'))
    for mesh in document.get('meshes', []):
        for primitive in mesh.get('primitives', []):
            for accessor in primitive.get('attributes', {}).values():
                count(accessor)
            count(primitive.get('indices'))
    return uses
