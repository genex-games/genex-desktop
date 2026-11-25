"""Typing test: open the Genex tab, size its floating window, bring it to the front, and keep the
editor open while a person types into the page. The editor never quits by itself before the cap.

Control files in proto/out, read about once a second:
- typing-resize: "<width> <height>" in Slate screen pixels resizes the tab window again.
- typing-front: brings the tab window to the front again.
- typing-quit: quits the editor."""

import json
import os
import time

os.environ['GENEX_PROTO_RUN'] = 'typing'

import unreal  # noqa: E402

import genex_tab_proto as g  # noqa: E402

SLATE = 'SlateInspectorToolset.SlateInspectorToolset'
TAB_SIZE_POINTS = (900, 700)
HOLD_CAP_SECONDS = 25 * 60
CONTROL_EVERY_SECONDS = 1.0


def slate(tool, args):
    value, error = yield from g._registry_call(SLATE, tool, args)
    returned = value.get('returnValue') if isinstance(value, dict) else value
    g.note(f'typing.slate.{tool}', {'args': args, 'error': error, 'value': repr(returned)[:1500]})
    return returned


def list_windows():
    returned = yield from slate('Windows', {'action': 'list'})
    try:
        return json.loads(returned) if isinstance(returned, str) else (returned or [])
    except Exception:  # noqa: BLE001
        return []


# The floating tab window carries the main window's title, so it is told apart by its ref: the
# one window ref that appears when the tab opens.
_tab_ref = {'ref': None}
# Nomad tabs open at 1000 x 600 points; the inspector reports screen pixels.
NOMAD_DEFAULT_WIDTH_POINTS = 1000


def tab_window(windows):
    for window in windows:
        if isinstance(window, dict) and window.get('ref') == _tab_ref['ref']:
            return window
    return None


def _ref_args(window):
    return {'ref': str(window.get('ref'))}


def _read_control(name):
    path = os.path.join(g.OUT_DIR, name)
    if not os.path.exists(path):
        return None
    with open(path, encoding='utf-8') as handle:
        text = handle.read().strip()
    os.remove(path)
    return text


def resize_and_front(width, height):
    windows = yield from list_windows()
    target = tab_window(windows)
    g.note('typing.tab_window', target)
    if target is None:
        return
    args = _ref_args(target)
    yield from slate('Windows', {'action': 'resize', 'width': width, 'height': height, **args})
    yield from slate('Windows', {'action': 'select', **args})
    after = yield from list_windows()
    g.note('typing.windows_after', after)


def flow():
    yield from g.wait(5)
    g.note('run.started', g.ENGINE)
    before = yield from list_windows()
    g.note('typing.windows_before', before)
    known = {window.get('ref') for window in before if isinstance(window, dict)}
    g.open_tab('typing-script', run_tag=f'typing-{g.ENGINE_SHORT}')
    yield from g.wait(4)
    opened = yield from list_windows()
    g.note('typing.windows_opened', opened)
    new = [window for window in opened if isinstance(window, dict) and window.get('ref') not in known and window.get('regular')]
    if new:
        _tab_ref['ref'] = new[0].get('ref')
        scale = max(1, round(int(new[0].get('width', NOMAD_DEFAULT_WIDTH_POINTS)) / NOMAD_DEFAULT_WIDTH_POINTS))
        g.note('typing.tab_window_ref', {'ref': _tab_ref['ref'], 'title': new[0].get('title'), 'scale': scale})
        yield from resize_and_front(TAB_SIZE_POINTS[0] * scale, TAB_SIZE_POINTS[1] * scale)
    g.note('typing.ready', True)
    deadline = time.time() + HOLD_CAP_SECONDS
    while time.time() < deadline:
        yield from g.wait(CONTROL_EVERY_SECONDS)
        size = _read_control('typing-resize')
        if size:
            width, height = (int(part) for part in size.split())
            yield from resize_and_front(width, height)
        if _read_control('typing-front') is not None:
            yield from front_only()
        if _read_control('typing-quit') is not None:
            break
    g.note('run.tab_open_before_quit', g.tab_is_open())
    unreal.SystemLibrary.quit_editor()


def front_only():
    windows = yield from list_windows()
    target = tab_window(windows)
    if target is not None:
        yield from slate('Windows', {'action': 'select', **_ref_args(target)})


g.run_on_ticks(flow(), 'typing')
