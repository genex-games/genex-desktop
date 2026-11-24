"""Test run: drive the editor's own UI through Epic's Slate inspector toolset. Find the Genex
toolbar button in the widget tree, picture it, click it like a person would, then click the web
page and type into it, and check from the server log whether the keys reached the page."""

import os
import re

os.environ['GENEX_PROTO_RUN'] = 'inspect'

import unreal  # noqa: E402

import genex_tab_proto as g  # noqa: E402

SLATE = 'SlateInspectorToolset.SlateInspectorToolset'
TYPED_TEXT = 'hello genex'


def slate(tool, args):
    value, error = yield from g._registry_call(SLATE, tool, args)
    returned = value.get('returnValue') if isinstance(value, dict) else value
    g.note(f'slate.{tool}', {'args': args, 'error': error, 'value': repr(returned)[:300]})
    return returned


def save_text(name, text):
    with open(os.path.join(g.OUT_DIR, name), 'w', encoding='utf-8') as handle:
        handle.write(text or '')


def save_image(name, image):
    data = image.get('data') if isinstance(image, dict) else None
    if data:
        with open(os.path.join(g.OUT_DIR, name), 'wb') as handle:
            handle.write(g.base64.b64decode(data))
    g.note(f'slate.saved.{name}', bool(data))


def find_ref(snapshot, pattern):
    """Return the ref on the first snapshot line that matches pattern, and that line."""
    for line in (snapshot or '').splitlines():
        if re.search(pattern, line):
            match = re.search(r'ref=([A-Za-z0-9_:-]+)', line) or re.search(r'\[(e\d+)\]', line)
            return (match.group(1) if match else None), line.strip()
    return None, None


def flow():
    yield from g.wait(5)
    g.note('run.started', g.ENGINE)
    yield from slate('Observe', {'ref': '', 'maxDepth': 60})
    yield from g.wait(2)
    snapshot = yield from slate('Snapshot', {'ref': '', 'maxDepth': 60})
    save_text(f'slate-{g.ENGINE_SHORT}-before.txt', snapshot)
    button_ref, button_line = find_ref(snapshot, r'Genex')
    g.note('slate.button', {'ref': button_ref, 'line': button_line})
    window = yield from slate('Screenshot', {'ref': ''})
    save_image(f'editor-{g.ENGINE_SHORT}-window.png', window)
    if button_ref:
        image = yield from slate('Screenshot', {'ref': button_ref})
        save_image(f'editor-{g.ENGINE_SHORT}-button.png', image)
        yield from slate('Click', {'ref': button_ref})
    yield from g.wait(6)
    g.note('slate.tab_open_after_click', g.tab_is_open())
    yield from slate('Observe', {'ref': '', 'maxDepth': 80})
    yield from g.wait(2)
    snapshot = yield from slate('Snapshot', {'ref': '', 'maxDepth': 80})
    save_text(f'slate-{g.ENGINE_SHORT}-after.txt', snapshot)
    browser_ref, browser_line = find_ref(snapshot, r'(?i)webbrowser|WebBrowserWidget|SWebBrowser')
    g.note('slate.browser', {'ref': browser_ref, 'line': browser_line})
    tab_ref, tab_line = find_ref(snapshot, r'EUW_GenexTab')
    g.note('slate.tab', {'ref': tab_ref, 'line': tab_line})
    if browser_ref:
        yield from slate('Click', {'ref': browser_ref})
        yield from g.wait(1)
        yield from slate('Type', {'ref': browser_ref, 'text': TYPED_TEXT, 'submit': False})
        yield from slate('PressKey', {'key': 'Enter'})
        yield from g.wait(2)
        image = yield from slate('Screenshot', {'ref': browser_ref})
        save_image(f'editor-{g.ENGINE_SHORT}-page.png', image)
    if tab_ref:
        image = yield from slate('Screenshot', {'ref': tab_ref})
        save_image(f'editor-{g.ENGINE_SHORT}-tab-full.png', image)
    yield from g.wait(3)
    unreal.SystemLibrary.quit_editor()


g.run_on_ticks(flow(), 'inspect')
