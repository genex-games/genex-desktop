"""Test run 2 (restart): open nothing. Wait about a minute, record whether Unreal brought the tab
back by itself from its saved layout, then quit the editor."""

import os

os.environ['GENEX_PROTO_RUN'] = 'idle'

import unreal  # noqa: E402

import genex_tab_proto as g  # noqa: E402

WAIT_SECONDS = 60


def flow():
    g.note('run.started', g.ENGINE)
    yield from g.wait(WAIT_SECONDS)
    g.note('run.tab_open_by_itself', g.tab_is_open())
    yield from g.capture_editor('restart')
    unreal.SystemLibrary.quit_editor()


g.run_on_ticks(flow(), 'idle')
