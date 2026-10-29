"""Characters and clips whose skeleton hangs under a scaled root (a centimetre Armature at 0.01) are
baked before Unreal imports them, keeping every bone and skinned vertex where it was, and an import
into a folder that already holds one never silently imports nothing: the same file answers its first
import again, any other file is refused with the way out."""

import json
import math
import os
import struct
import unittest

import unreal
from unreal import Vector

from genex_build import mesh_math, rig_math
from genex_build.tools import GenexBuildTools

from support import HelperCase

ARMATURE, CHARACTER, HIPS, SPINE = 0, 1, 2, 3
SPINE_TURN = (0.0, 0.0, math.sin(math.radians(15)), math.cos(math.radians(15)))


def tool(name: str, *args) -> dict:
    return json.loads(getattr(GenexBuildTools, name)(*args))


def quat_matrix(q: tuple) -> list:
    x, y, z, w = q
    return [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]


def node_matrix(node: dict) -> list:
    """A glTF node's local 4x4 matrix (rows) from its translation, rotation and scale."""
    t, s = node.get('translation', [0, 0, 0]), node.get('scale', [1, 1, 1])
    r = quat_matrix(node.get('rotation', [0, 0, 0, 1]))
    return [[r[i][j] * s[j] for j in range(3)] + [t[i]] for i in range(3)] + [[0, 0, 0, 1]]


def multiply(a: list, b: list) -> list:
    return [[sum(a[i][k] * b[k][j] for k in range(4)) for j in range(4)] for i in range(4)]


def inverse_affine(m: list) -> list:
    """The inverse of an affine 4x4 whose 3x3 part is a rotation times a uniform scale."""
    scale_squared = sum(m[i][0] ** 2 for i in range(3))
    linear = [[m[j][i] / scale_squared for j in range(3)] for i in range(3)]
    moved = [-sum(linear[i][k] * m[k][3] for k in range(3)) for i in range(3)]
    return [linear[i] + [moved[i]] for i in range(3)] + [[0, 0, 0, 1]]


def worlds(document: dict) -> dict:
    """Every node's world matrix."""
    parents = mesh_math.parents_of(document)
    found: dict = {}

    def world(index: int) -> list:
        if index not in found:
            local = node_matrix(document['nodes'][index])
            parent = parents.get(index)
            found[index] = local if parent is None else multiply(world(parent), local)
        return found[index]

    for index in range(len(document['nodes'])):
        world(index)
    return found


class Builder:
    """A binary glTF's buffer, views and accessors, written float by float."""

    def __init__(self) -> None:
        self.binary, self.views, self.accessors = b'', [], []

    def floats(self, rows: list, kind: str, bounds: bool = False) -> int:
        start = len(self.binary)
        flat = [value for row in rows for value in row]
        self.binary += struct.pack(f'<{len(flat)}f', *flat)
        self.views.append({'buffer': 0, 'byteOffset': start, 'byteLength': len(flat) * 4})
        accessor = {'bufferView': len(self.views) - 1, 'componentType': 5126, 'count': len(rows), 'type': kind}
        if bounds:
            accessor.update({'min': [min(r[i] for r in rows) for i in range(len(rows[0]))],
                             'max': [max(r[i] for r in rows) for i in range(len(rows[0]))]})
        self.accessors.append(accessor)
        return len(self.accessors) - 1


def rigged(scale: list | None = (0.01, 0.01, 0.01), skin: bool = True, rigid_child: bool = False,
           shared_output: bool = False) -> bytes:
    """A character (or, without a skin, its clip) as Meshy rigs one: Armature (scaled) > Hips 100 cm up >
    Spine 20 cm above it, turned; the skin's inverse bind matrices are its joints' world inverses; a clip
    lifts the hips by 4 cm and turns the spine."""
    nodes = [{'name': 'Armature', 'children': [CHARACTER, HIPS]}, {'name': 'char1'},
             {'name': 'Hips', 'translation': [0.0, 100.0, 0.0], 'children': [SPINE]},
             {'name': 'Spine', 'translation': [0.0, 20.0, 0.0], 'rotation': list(SPINE_TURN)}]
    if scale is not None:
        nodes[ARMATURE]['scale'] = list(scale)
    built = Builder()
    document = {'asset': {'version': '2.0'}, 'scenes': [{'nodes': [ARMATURE]}], 'scene': 0, 'nodes': nodes}
    positions = built.floats([[-0.3, 0.0, -0.1], [0.3, 0.0, 0.1], [0.0, 1.8, 0.0]], 'VEC3', bounds=True)
    document['meshes'] = [{'primitives': [{'attributes': {'POSITION': positions}}]}]
    if skin:
        joint_worlds = worlds(document)
        inverse = [inverse_affine(joint_worlds[joint]) for joint in (HIPS, SPINE)]
        matrices = built.floats([[m[row][col] for col in range(4) for row in range(4)] for m in inverse], 'MAT4')
        document['skins'] = [{'joints': [HIPS, SPINE], 'inverseBindMatrices': matrices}]
        nodes[CHARACTER].update({'mesh': 0, 'skin': 0})
    times = built.floats([[0.0], [1.0]], 'SCALAR', bounds=True)
    lift = built.floats([[0.0, 100.0, 0.0], [0.0, 104.0, 0.0]], 'VEC3', bounds=True)
    turn = built.floats([list(SPINE_TURN), [0.0, 0.0, 0.0, 1.0]], 'VEC4')
    samplers = [{'input': times, 'output': lift}, {'input': times, 'output': turn}]
    channels = [{'sampler': 0, 'target': {'node': HIPS, 'path': 'translation'}},
                {'sampler': 1, 'target': {'node': SPINE, 'path': 'rotation'}}]
    if shared_output:
        samplers.append({'input': times, 'output': lift})
        channels.append({'sampler': 2, 'target': {'node': SPINE, 'path': 'translation'}})
    document['animations'] = [{'name': 'Idle', 'samplers': samplers, 'channels': channels}]
    if rigid_child:
        nodes.append({'name': 'sword', 'mesh': 0})
        nodes[HIPS]['children'].append(len(nodes) - 1)
    document.update({'accessors': built.accessors, 'bufferViews': built.views,
                     'buffers': [{'byteLength': len(built.binary)}]})
    return rig_math.write_glb(document, built.binary)


def accessor_rows(document: dict, binary: bytes, index: int) -> list:
    accessor = document['accessors'][index]
    view = document['bufferViews'][accessor['bufferView']]
    width = {'SCALAR': 1, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}[accessor['type']]
    start = view.get('byteOffset', 0) + accessor.get('byteOffset', 0)
    return [list(struct.unpack_from(f'<{width}f', binary, start + i * width * 4)) for i in range(accessor['count'])]


class Bake(unittest.TestCase):
    def assert_close(self, a: list, b: list, places: int = 5) -> None:
        for x, y in zip(a, b):
            self.assertAlmostEqual(x, y, places=places)

    def test_a_centimetre_armature_is_baked_into_the_bones_skin_and_clips(self) -> None:
        original = rigged()
        baked, taken = rig_math.bake(original)
        self.assertAlmostEqual(taken, 0.01)
        before, binary_before = rig_math.read_glb(original)
        after, binary = rig_math.read_glb(baked)
        self.assertEqual(mesh_math.skeleton_counter_scale(after), 1.0, 'nothing scaled is left for Unreal to import')
        self.assertNotIn('scale', after['nodes'][ARMATURE])
        old, new = worlds(before), worlds(after)
        for joint in (HIPS, SPINE):
            with self.subTest(joint=joint):
                self.assert_close([old[joint][i][3] for i in range(3)], [new[joint][i][3] for i in range(3)])
                self.assertAlmostEqual(sum(new[joint][i][0] ** 2 for i in range(3)), 1.0, places=5)
        # Every skinned vertex stays put: each joint's world times its inverse bind matrix is unchanged.
        skin = after['skins'][0]
        old_inverse = accessor_rows(before, binary_before, before['skins'][0]['inverseBindMatrices'])
        new_inverse = accessor_rows(after, binary, skin['inverseBindMatrices'])
        for k, joint in enumerate(skin['joints']):
            column_major = (lambda rows: [[rows[k][col * 4 + row] for col in range(4)] for row in range(4)])
            was = multiply(old[joint], column_major(old_inverse))
            now = multiply(new[joint], column_major(new_inverse))
            self.assert_close([v for row in was for v in row], [v for row in now for v in row])
        lift = after['animations'][0]['samplers'][0]['output']
        self.assertEqual(accessor_rows(after, binary, lift), [[0.0, 1.0, 0.0], [0.0, as_float32(1.04), 0.0]])
        self.assert_close(after['accessors'][lift]['max'], [0.0, 1.04, 0.0])
        turn = after['animations'][0]['samplers'][1]['output']
        self.assertEqual(accessor_rows(after, binary, turn), accessor_rows(before, binary_before, turn))

    def test_a_clip_with_no_skin_is_baked_the_same_way(self) -> None:
        clip = rigged(skin=False)
        self.assertAlmostEqual(mesh_math.skeleton_counter_scale(rig_math.read_glb(clip)[0]), 100.0)
        baked, taken = rig_math.bake(clip)
        after, binary = rig_math.read_glb(baked)
        self.assertAlmostEqual(taken, 0.01)
        self.assertEqual(after['nodes'][HIPS]['translation'], [0.0, 1.0, 0.0])
        lift = after['animations'][0]['samplers'][0]['output']
        self.assert_close(accessor_rows(after, binary, lift)[1], [0.0, 1.04, 0.0])

    def test_what_it_cannot_bake_exactly_is_left_as_it_is(self) -> None:
        cases = {
            'scale one': rigged(scale=None),
            'a scale near one': rigged(scale=[1.02, 1.02, 1.02]),
            'a scale that differs by axis': rigged(scale=[0.01, 0.02, 0.01]),
            'a mesh without a skin under the scale': rigged(rigid_child=True),
            'one clip output read twice': rigged(shared_output=True),
            'not a glTF': b'solid cube\nendsolid\n',
            'a glTF of JSON only': rigged()[:12] + b'\0' * 8,
        }
        for label, data in cases.items():
            with self.subTest(label):
                self.assertIsNone(rig_math.bake(data))


def read_bytes(path: str) -> bytes:
    with open(path, 'rb') as handle:
        return handle.read()


def as_float32(value: float) -> float:
    """`value` as a 32-bit float reads back."""
    return struct.unpack('<f', struct.pack('<f', value))[0]


class ImportRigged(HelperCase):
    """import_character and import_animation on files of the game's assets/genex/ folder."""

    def setUp(self) -> None:
        super().setUp()
        self.folder = os.path.join(self.game, 'assets', 'genex', 'job1')
        os.makedirs(self.folder, exist_ok=True)

    def file(self, name: str, data: bytes) -> str:
        path = os.path.join(self.folder, name)
        with open(path, 'wb') as handle:
            handle.write(data)
        return path

    def character_made(self, folder: str, stem: str) -> list:
        mesh = unreal.SkeletalMesh(f'{folder}/{stem}', unreal.Vector(30.0, 15.0, 90.0))
        return [(f'{folder}/{stem}', mesh), (f'{folder}/{stem}_Skeleton', unreal.Skeleton())]

    def test_a_centimetre_armature_character_imports_from_a_baked_copy_at_full_size(self) -> None:
        source = self.file('hero.glb', rigged())
        original = read_bytes(source)
        copy = os.path.join(self.project, 'Saved', 'Genex', 'imports', 'Cast', 'Hero', 'hero.glb')
        unreal.state['imports'][copy] = self.character_made('/Game/Cast/Hero', 'hero')
        answer = tool('import_character', 'assets/genex/job1/hero.glb', '/Game/Cast', 'Hero')
        self.assertNotIn('error', answer)
        [task] = unreal.state['import_tasks']
        self.assertEqual(task.filename, copy, 'Unreal imports the baked copy')
        self.assertEqual(answer['skeletonScale'], {'baked': 0.01, 'file': copy})
        self.assertNotIn('scaleWarning', answer)
        self.assertEqual(mesh_math.source_counter_scale(copy), 1.0)
        self.assertEqual(read_bytes(source), original, "the game's own file is left as it was")

    def test_its_own_materials_are_marked_for_skinned_meshes_so_the_game_draws_their_textures(self) -> None:
        self.file('hero.glb', rigged())
        copy = os.path.join(self.project, 'Saved', 'Genex', 'imports', 'Cast', 'Hero', 'hero.glb')
        made = self.character_made('/Game/Cast/Hero', 'hero')
        own = unreal.Material('/Game/Cast/Hero/Material_0')
        engine = unreal.Material('/InterchangeAssets/gltf/M_Default')
        made[0][1].materials = [unreal.SkeletalMaterial(own), unreal.SkeletalMaterial(unreal.MaterialInstanceConstant(own)),
                                unreal.SkeletalMaterial(engine), unreal.SkeletalMaterial(None)]
        unreal.state['imports'][copy] = made
        answer = tool('import_character', 'assets/genex/job1/hero.glb', '/Game/Cast', 'Hero')
        self.assertEqual(answer['skinnedMaterials'], ['/Game/Cast/Hero/Material_0.Material_0'], 'marked once')
        self.assertIn('MATUSAGE_SKELETAL_MESH', own.usages)
        self.assertEqual(engine.usages, set(), "the engine's own material is left as it is")

    def test_its_clips_are_baked_too(self) -> None:
        self.file('idle.glb', rigged(skin=False))
        unreal.state['loaded']['/Game/Cast/Hero/hero_Skeleton'] = unreal.Skeleton()
        copy = os.path.join(self.project, 'Saved', 'Genex', 'imports', 'Cast', 'Idle', 'idle.glb')
        unreal.state['imports'][copy] = [('/Game/Cast/Idle/idle', unreal.AnimSequence())]
        answer = tool('import_animation', 'assets/genex/job1/idle.glb', '/Game/Cast/Hero/hero_Skeleton', '/Game/Cast', 'Idle')
        self.assertEqual(unreal.state['import_tasks'][0].filename, copy)
        self.assertEqual(answer['skeletonScale']['baked'], 0.01)

    def test_a_scale_it_cannot_bake_says_how_to_fix_the_file_without_a_helper_agent(self) -> None:
        source = self.file('ogre.glb', rigged(scale=[0.01, 0.02, 0.01]))
        unreal.state['imports'][source] = self.character_made('/Game/Cast/Ogre', 'ogre')
        answer = tool('import_character', 'assets/genex/job1/ogre.glb', '/Game/Cast', 'Ogre')
        self.assertEqual(unreal.state['import_tasks'][0].filename, source)
        self.assertIn('scaleWarning', answer)
        self.assertNotIn('blender_prep', answer['scaleWarning'])
        self.assertNotIn('sub-agent', answer['scaleWarning'])


class ImportAgain(HelperCase):
    """A second import into <dest>/<name>/: Unreal's importer imports nothing over an earlier import."""

    def setUp(self) -> None:
        super().setUp()
        self.model = self.write(os.path.join(self.game, 'assets', 'models', 'rock.glb'), 'glTF rock')
        self.other = self.write(os.path.join(self.game, 'assets', 'models', 'rock2.glb'), 'glTF rock 2')
        self.made = ('/Game/Models/Rock/rock', unreal.StaticMesh(Vector(-50, -50, 0), Vector(50, 50, 80), 400))
        unreal.state['imports'][self.model] = [self.made]
        unreal.state['imports'][self.other] = [self.made]

    def test_the_same_file_answers_its_first_import_again_without_importing(self) -> None:
        first = tool('import_model', 'assets/models/rock.glb', '/Game/Models', 'Rock', 'convex', True)
        self.assertNotIn('error', first)
        again = tool('import_model', 'assets/models/rock.glb', '/Game/Models', 'Rock', 'convex', True)
        self.assertTrue(again['reused'])
        self.assertEqual(again['asset'], first['asset'])
        self.assertEqual(len(unreal.state['import_tasks']), 1, 'Unreal imported once')

    def test_another_file_into_the_same_folder_is_refused_with_the_way_out(self) -> None:
        tool('import_model', 'assets/models/rock.glb', '/Game/Models', 'Rock', 'convex', True)
        self.fresh()
        refused = tool('import_model', 'assets/models/rock2.glb', '/Game/Models', 'Rock', 'convex', True)
        self.assertIn('/Game/Models/Rock', refused['error'])
        self.assertIn('Rock_2', refused['error'])
        self.assertEqual(refused['folder'], '/Game/Models/Rock')
        self.assertEqual(unreal.calls, [], 'the editor was changed')
        self.assertEqual(len(unreal.state['import_tasks']), 1)

    def test_a_changed_file_is_refused_too(self) -> None:
        tool('import_model', 'assets/models/rock.glb', '/Game/Models', 'Rock', 'convex', True)
        self.write(self.model, 'glTF rock, remodelled')
        self.fresh()
        self.assertIn('error', tool('import_model', 'assets/models/rock.glb', '/Game/Models', 'Rock', 'convex', True))
        self.assertEqual(unreal.calls, [])

    def test_a_folder_emptied_since_imports_again(self) -> None:
        tool('import_model', 'assets/models/rock.glb', '/Game/Models', 'Rock', 'convex', True)
        unreal.state['assets'].clear()
        again = tool('import_model', 'assets/models/rock.glb', '/Game/Models', 'Rock', 'convex', True)
        self.assertNotIn('reused', again)
        self.assertEqual(len(unreal.state['import_tasks']), 2)


if __name__ == '__main__':
    unittest.main()
