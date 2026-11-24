"""Throwaway prototype: on every editor start, add the Genex toolbar button once Slate is up.

A file named skip-button in proto/out leaves the button out, to see whether Unreal keeps it by itself."""

import os

import unreal

import genex_tab_proto

_handle = None


def _first_tick(_delta):
    global _handle
    unreal.unregister_slate_post_tick_callback(_handle)
    if os.path.exists(os.path.join(genex_tab_proto.OUT_DIR, 'skip-button')):
        genex_tab_proto.note('toolbar.skipped_by_flag', True)
        return
    try:
        genex_tab_proto.add_button()
    except Exception as error:  # noqa: BLE001 - a prototype failure must not stop the editor
        genex_tab_proto.note('toolbar.crashed', f'{type(error).__name__}: {error}')


if unreal.is_editor():
    _handle = unreal.register_slate_post_tick_callback(_first_tick)
