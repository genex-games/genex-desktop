"""Test run on a newer engine: make this engine's own copy of the widget asset by script (under a
different name, so the asset saved by the older engine stays as it was), open it as a tab, then
quit the editor."""

import os

os.environ['GENEX_PROTO_RUN'] = 'create-own'

import unreal  # noqa: E402

import genex_tab_proto as g  # noqa: E402

g.ASSET_NAME = f'EUW_GenexTab_{g.ENGINE_SHORT.replace(".", "")}'
g.ASSET_PATH = f'{g.ASSET_DIR}/{g.ASSET_NAME}'
HOLD_SECONDS = 15


def flow():
    yield from g.wait(5)
    g.note('run.started', {'engine': g.ENGINE, 'asset': g.ASSET_PATH})
    blueprint = yield from g.ensure_asset()
    g.note('run.asset_ready', blueprint is not None)
    yield from g.wait(2)
    g.open_tab('start-script', run_tag=f'create-own-{g.ENGINE_SHORT}')
    yield from g.wait(8)
    yield from g.capture_editor('own')
    yield from g.wait(HOLD_SECONDS)
    g.note('run.tab_open_before_quit', g.tab_is_open())
    unreal.SystemLibrary.quit_editor()


g.run_on_ticks(flow(), 'create-own')
