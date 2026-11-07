"""reload_helper brings the helper's newer Python, which Genex has just written into the project,
into the running editor without a restart: it reloads every loaded helper module, each after the
helper modules it imports, never a toolset (tools.py), a package's __init__ or errors.py. It
refuses, reloading nothing, while a play session runs or while the helper still holds something of
the editor's (a tick of its own, render settings a lighter play lowered); check_only answers whether
it would run, changing nothing."""

import importlib
import sys
import types
from unittest import mock

import unreal

from genex_loop import reload
from support import HelperCase


class Reloadable(HelperCase):
    def test_names_only_the_helpers_own_modules_that_reload(self) -> None:
        for name in ('genex_loop.parts', 'genex_build.terrain', 'genex_play.play'):
            with self.subTest(name):
                self.assertTrue(reload.reloadable(name))
        for name in ('genex_loop.tools', 'genex_play.tools', 'genex_loop.errors', 'genex_build.__init__',
                     'genex_loop', 'init_unreal', 'unreal', 'toolset_registry.registration', 'genex_other.parts',
                     'genex_loop.parts.inner', 'genex_loop.'):
            with self.subTest(name):
                self.assertFalse(reload.reloadable(name))


class Order(HelperCase):
    def test_puts_each_module_after_the_helper_modules_it_imports(self) -> None:
        names = ['genex_loop.parts', 'genex_loop.part_api', 'genex_loop.editor', 'genex_loop.paths']
        modules = {name: importlib.import_module(name) for name in names}
        done = reload.order(modules)
        self.assertEqual(sorted(done), sorted(names))
        for name, module in modules.items():
            for imported in reload._imported(module) & modules.keys():
                with self.subTest(f'{imported} before {name}'):
                    self.assertLess(done.index(imported), done.index(name))

    def test_an_import_cycle_still_orders_every_module_once(self) -> None:
        cycle = {'genex_loop.a': {'genex_loop.b'}, 'genex_loop.b': {'genex_loop.a'}}
        with mock.patch.object(reload, '_imported', side_effect=lambda module: cycle[module.__name__]):
            done = reload.order({name: types.ModuleType(name) for name in cycle})
        self.assertEqual(sorted(done), sorted(cycle))


class ReloadHelper(HelperCase):
    def reloaded(self, *args) -> dict:
        return self.call('reload_helper', *args)

    def test_reloads_every_loaded_helper_module_with_its_new_code_and_none_it_never_reloads(self) -> None:
        from genex_build import terrain
        terrain.TERRAIN_LABEL = 'as the old code had it'
        result = self.reloaded()
        self.assertNotIn('error', result, result)
        self.assertEqual(terrain.TERRAIN_LABEL, 'GenexTerrain', 'the module ran again from its file')
        self.assertIn('genex_build.terrain', result['reloaded'])
        self.assertIn('genex_loop.parts', result['reloaded'])
        for fixed in ('genex_loop.tools', 'genex_play.tools', 'genex_build.tools', 'genex_loop.errors'):
            with self.subTest(fixed):
                self.assertNotIn(fixed, result['reloaded'])
        self.assertIsInstance(result['ms'], int)
        # The toolsets reach the reloaded modules: a tool still answers through them.
        self.assertEqual(self.call('editor_activity')['pie'], False)

    def test_refuses_during_a_play_session_or_a_pending_tick_and_reloads_nothing(self) -> None:
        from genex_build import shots
        from genex_play import light

        def idle() -> None:
            shots._wait_handle = None
            light._kept.clear()

        cases = {
            'a play session': lambda: unreal.state.update(pie=True),
            'a capture waiting on the editor': lambda: setattr(shots, '_wait_handle', object()),
            'render settings a lighter play lowered': lambda: light._kept.update({'r.ScreenPercentage': 100}),
        }
        self.addCleanup(idle)
        for label, arrange in cases.items():
            with self.subTest(label):
                unreal.reset(self.project)
                idle()
                arrange()
                with mock.patch.object(importlib, 'reload') as reloading:
                    self.assertIn('error', self.reloaded())
                    self.assertFalse(self.reloaded(True)['ready'])
                reloading.assert_not_called()

    def test_check_only_reloads_nothing(self) -> None:
        with mock.patch.object(importlib, 'reload') as reloading:
            self.assertEqual(self.reloaded(True), {'ready': True})
        reloading.assert_not_called()
        self.assertIn('genex_loop.reload', sys.modules)
