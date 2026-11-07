"""attach_to_socket on a Blueprint (genex_build.tools.GenexBuildTools) puts a static mesh in the hand
players see: on a motion_character Blueprint that is the Body copying the hidden mannequin (Mesh), so
the mesh becomes a component under Body, held at the socket by one Attach Component To Component node
in the construction script. Each mesh gets its own node; attaching one again reuses its component and
node, moving it onto the visible mesh when it was held by another. A socket only the hidden mannequin
has is refused before anything changes."""

import json
import unittest
from unittest import mock

import unreal
from unreal import Vector

import graph_tools
import skeletons
from genex_build import motion
from genex_build.tools import GenexBuildTools
from genex_loop import blueprints

from support import HelperCase
from test_motion import HERO, sample_content

BLUEPRINT = '/Game/GX/Characters/BP_Hero'
KATANA = '/Game/Props/SM_Katana'
SAYA = '/Game/Props/SM_Saya'
CONSTRUCTION = 'UserConstructionScript'


def tool(name: str, *args) -> dict:
    return json.loads(getattr(GenexBuildTools, name)(*args))


def static_mesh(path: str) -> unreal.StaticMesh:
    mesh = unreal.StaticMesh(Vector(-2, -2, 0), Vector(2, 2, 90))
    mesh.get_name = lambda: path.rsplit('/', 1)[-1]
    unreal.state['loaded'][path] = mesh
    return mesh


class AttachToSocket(HelperCase):
    """BP_Hero from motion_character: its Mesh shows the sample's mannequin (hidden), its Body the hero."""

    def setUp(self) -> None:
        super().setUp()
        skeletons.character(HERO)
        sample_content()
        self.assertNotIn('error', tool('motion_character', HERO, 'Hero'))
        self.mesh['Mesh'].props['skeletal_mesh_asset'] = unreal.state['loaded'][motion.SAMPLE_MESH]
        static_mesh(KATANA)
        static_mesh(SAYA)
        for patch in (mock.patch.object(blueprints, '_tools', lambda: graph_tools.GraphTools),
                      mock.patch.object(blueprints, '_node_type_cache', lambda: graph_tools.NodeTypeCache),
                      mock.patch.object(unreal, 'IntPoint', graph_tools.Point, create=True)):
            patch.start()
            self.addCleanup(patch.stop)
        self.addCleanup(graph_tools.NodeTypeCache.remembered.clear)

    @property
    def mesh(self) -> dict:
        return {name: component for name, component in unreal.state['loaded'][BLUEPRINT].components}

    def attaches(self) -> dict:
        """The construction script's attach nodes by the component each holds: (parent read, socket)."""
        graph = graph_tools.graph_of(unreal.state['loaded'][BLUEPRINT], CONSTRUCTION)
        return {node.source('self').type_id.rsplit('|Get', 1)[-1]:
                (node.source('Parent').type_id, node.pin('SocketName').value)
                for node in graph.of_type(graph_tools.ATTACH)}

    def test_a_motion_characters_prop_is_held_in_the_visible_bodys_hand(self) -> None:
        result = tool('attach_to_socket', BLUEPRINT, KATANA, 'RightHand', '')
        self.assertNotIn('error', result, result)
        self.assertEqual((result['component'], result['parent'], result['saved']), ('GxSMKatana', 'Body', True))
        self.assertEqual(self.mesh['GxSMKatana'].props['attach_parent'], 'Body')
        self.assertEqual(self.attaches(), {'GxSMKatana': ('Variables|Default|GetBody', 'RightHand')})

    def test_a_second_prop_gets_its_own_attach_node(self) -> None:
        """Epic's toolset remembers the graph's node types from the first attach, before the second prop."""
        tool('attach_to_socket', BLUEPRINT, KATANA, 'RightHand', '')
        result = tool('attach_to_socket', BLUEPRINT, SAYA, 'Hips', '{"location": [0, 12, 0]}')
        self.assertNotIn('error', result, result)
        self.assertEqual(self.attaches(), {'GxSMKatana': ('Variables|Default|GetBody', 'RightHand'),
                                           'GxSMSaya': ('Variables|Default|GetBody', 'Hips')})

    def test_attaching_again_moves_a_prop_held_by_the_hidden_mannequin_onto_the_body(self) -> None:
        self.mesh['Body'].props['visible'] = False
        self.assertEqual(tool('attach_to_socket', BLUEPRINT, KATANA, 'RightHand', '')['parent'], 'Mesh',
                         'with no mesh shown, the first with the socket holds it')
        self.assertEqual(self.attaches(), {'GxSMKatana': ('Variables|Character|GetMesh', 'RightHand')})
        self.mesh['Body'].props['visible'] = True
        again = tool('attach_to_socket', BLUEPRINT, KATANA, 'LeftHand', '')
        self.assertEqual(again['parent'], 'Body')
        self.assertEqual(self.attaches(), {'GxSMKatana': ('Variables|Default|GetBody', 'LeftHand')})
        graph = graph_tools.graph_of(unreal.state['loaded'][BLUEPRINT], CONSTRUCTION)
        self.assertEqual(graph.of_type('Variables|Character|GetMesh'), [], 'the old parent node went too')
        self.assertEqual(len(graph.of_type('Variables|Default|GetGxSMKatana')), 1)

    def test_a_socket_only_the_hidden_mannequin_has_is_refused_and_nothing_changes(self) -> None:
        self.mesh['Mesh'].bones = {'ik_hand_gun': Vector()}
        self.fresh()
        result = tool('attach_to_socket', BLUEPRINT, KATANA, 'ik_hand_gun', '')
        self.assertIn('only the hidden Mesh has it', result['error'])
        self.assertIn('Body has: Hips', result['error'])
        self.assertEqual(unreal.calls, [], 'the editor was changed')
        self.assertNotIn('GxSMKatana', self.mesh)


if __name__ == '__main__':
    unittest.main()
