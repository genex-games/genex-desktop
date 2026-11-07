"""When Unreal loads the Genex editor helper it registers its toolsets with Epic's toolset
registry, which Epic's MCP server lists: the play tools, the queue's loop tools and the live
builder's build tools; and it leaves an editor frame to hide in game the mannequin of motion
characters an older helper made (test_motion has what that does)."""

import importlib
import unittest

import unreal
from toolset_registry import registration

from support import HelperCase


class Registers(HelperCase):
    def test_the_helper_registers_its_play_loop_and_build_toolsets(self) -> None:
        importlib.import_module('init_unreal')
        [toolsets] = registration.registered
        self.assertEqual(sorted(f'{t.__module__}.{t.__name__}' for t in toolsets),
                         ['genex_build.tools.GenexBuildTools', 'genex_loop.tools.GenexLoopTools',
                          'genex_play.tools.GenexPlayTools'])
        self.assertEqual(len(unreal.state['ticks']), 1, 'the check of older motion characters waits for a frame')


if __name__ == '__main__':
    unittest.main()
