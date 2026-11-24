"""Test run 3 (another engine version): open the widget asset saved by the other engine, without
saving it, and see whether its page loads. Then quit the editor."""

import os

os.environ['GENEX_PROTO_RUN'] = 'cross'

import unreal  # noqa: E402

import genex_tab_proto as g  # noqa: E402

HOLD_SECONDS = 45


def flow():
    yield from g.wait(5)
    g.note('run.started', g.ENGINE)
    exists = unreal.EditorAssetLibrary.does_asset_exist(g.ASSET_PATH)
    g.note('cross.asset_exists', exists)
    if exists:
        blueprint = unreal.EditorAssetLibrary.load_asset(g.ASSET_PATH)
        g.note('cross.asset_loaded', blueprint is not None)
        g.note('cross.has_browser', blueprint is not None and g._find_template_browser(blueprint) is not None)
        g.open_tab('cross-script', run_tag=f'cross-{g.ENGINE_SHORT}')
    yield from g.wait(10)
    yield from g.capture_editor('cross')
    yield from g.wait(HOLD_SECONDS)
    g.note('run.tab_open_before_quit', g.tab_is_open())
    unreal.SystemLibrary.quit_editor()


g.run_on_ticks(flow(), 'cross')
