"""Test run 1: create the widget asset by script if it is missing, open it as a docked tab from the
start script and through the button's own command, hold the editor up so the page can load and
post, then quit the editor."""

import os

os.environ['GENEX_PROTO_RUN'] = 'create'

import unreal  # noqa: E402

import genex_tab_proto as g  # noqa: E402

HOLD_SECONDS = 20


def flow():
    yield from g.wait(5)
    g.note('run.started', g.ENGINE)
    g.discover_icon_routes()
    blueprint = yield from g.ensure_asset()
    g.note('run.asset_ready', blueprint is not None)
    yield from g.wait(2)
    g.open_tab('start-script', run_tag=f'create-{g.ENGINE_SHORT}')
    yield from g.wait(5)
    exec(g.BUTTON_COMMAND)  # the exact command the toolbar button runs
    yield from g.wait(5)
    yield from g.capture_editor('tab')
    yield from g.wait(HOLD_SECONDS)
    g.note('run.tab_open_before_quit', g.tab_is_open())
    g.note('run.quitting', True)
    unreal.SystemLibrary.quit_editor()


g.run_on_ticks(flow(), 'create')
