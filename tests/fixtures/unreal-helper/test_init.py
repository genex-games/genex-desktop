"""When Unreal loads the Genex editor helper it registers its toolsets with Epic's toolset
registry, which Epic's MCP server lists: the play tools, the queue's loop tools and the live
builder's build tools."""

import importlib
import unittest

from toolset_registry import registration


class Registers(unittest.TestCase):
    def test_the_helper_registers_its_play_loop_and_build_toolsets(self) -> None:
        importlib.import_module('init_unreal')
        [toolsets] = registration.registered
        self.assertEqual(sorted(f'{t.__module__}.{t.__name__}' for t in toolsets),
                         ['genex_build.tools.GenexBuildTools', 'genex_loop.tools.GenexLoopTools',
                          'genex_play.tools.GenexPlayTools'])


if __name__ == '__main__':
    unittest.main()
