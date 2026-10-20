"""Registers the Genex editor helper's toolsets with Unreal's toolset registry, which Epic's MCP
server lists: the play tools, the loop tools, play-time AI's relay and the build tools. The build
tools load last and apart, so the others still register if they can't (a project without Geometry
Script)."""

import unreal

from toolset_registry.registration import Registration

from genex_ai.tools import GenexAiRelayTools
from genex_loop.tools import GenexLoopTools
from genex_play.tools import GenexPlayTools

_genex_toolsets = [GenexPlayTools, GenexLoopTools, GenexAiRelayTools]
try:
    from genex_build.tools import GenexBuildTools
except Exception as error:  # noqa: BLE001 - whatever stops the build tools loading must not stop the others
    unreal.log_warning(f'Genex editor helper build tools did not load: {error}')
else:
    _genex_toolsets.append(GenexBuildTools)

_genex_registration = Registration(_genex_toolsets)
unreal.log(f'Genex editor helper tools registered: {_genex_registration.register()}')
