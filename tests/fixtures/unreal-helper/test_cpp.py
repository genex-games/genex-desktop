"""recompile_module hot-reloads the game's own C++ module while the editor stays open: Unreal's
`Module Recompile <Module>` compiles it with UBT and loads the new library, which it names with a
fresh suffix (Binaries/Mac/libUnrealEditor-<Module>-1234.dylib) and doesn't write when the compile
fails. The tool answers ok only when such a new library appeared, the reload logged no error and
every listed class loads; a failed compile answers ok false with the compiler's and the hot
reload's lines from the editor's log, only those written during the call, with the project's paths
from Source/ on and the owner's home folder as ~. It refuses bad names, a module the project
doesn't have, a running play session and any machine but a Mac without running anything.

save_all saves the editor's unsaved levels and assets without asking, before Genex quits Unreal
to add the game's C++ module, and says what is still unsaved."""

import os
import shutil
import sys
import time
from unittest import mock

import unreal

from support import HelperCase

MODULE = 'GxCpp'
COMMAND = ('console', (None, 'Module Recompile GxCpp'))
HOME = '/Users/genex-tester'
# The project's folder in a log line; each test fills in its own.
GAME = '{game}'
STAMP = '[2026.01.01-12.07.26:459][214]'
RECOMPILING = 'LogHotReload: Recompiling module GxCpp...'
# Clang's error as UBT printed it on 5.8.3, the source line and caret after it.
CLANG_ERROR = (f"{GAME}/Source/GxCpp/Parts/Lap/GxLapTimer.cpp:6:9: error: use of undeclared identifier 'FStrin'; "
               "did you mean 'FString'?")
# An engine header in the owner's home folder, outside the project.
HOME_ERROR = f'{HOME}/Epic/UE_5.8/Engine/Source/Runtime/Core/Public/CoreMinimal.h:4:1: error: a home path'
GENERATED = '1 error generated.'
EXITED = ' Compile [Apple] GxLapTimer.cpp: Exited with error code 1 . The build will fail.'
# What the editor logs for a hot reload that compiles: the command, the hot reload's own line, UBT's output.
COMPILED = [
    f'{STAMP}Cmd: Module Recompile GxCpp',
    f'{STAMP}{RECOMPILING}',
    f'{STAMP}Launching UnrealBuildTool... [Build.sh -ModuleWithSuffix=GxCpp,5706 GxCppEditor Mac Development '
    f'-Project="{GAME}/GxCpp.uproject"]',
    '[2/3] Link [Apple] libUnrealEditor-GxCpp-5706.dylib',
    'Result: Succeeded',
    f'{STAMP}CompilerResultsLog: Result: Succeeded',
    f'{STAMP}Reloading module GxCpp after successful compile.',
]
# A compile error: UBT's raw output, then the same lines again under CompilerResultsLog.
FAILED = [
    f'{STAMP}Cmd: Module Recompile GxCpp',
    f'{STAMP}{RECOMPILING}',
    f'In file included from {GAME}/Source/GxCpp/Parts/Lap/GxLapTimer.cpp:1:',
    CLANG_ERROR,
    '    6 |         FStrin Name;',
    '      |         ^~~~~~',
    HOME_ERROR,
    "/Users/genex-tester2/Other/Thing.h:3:1: error: a sibling of the home folder stays as it is",
    GENERATED,
    EXITED,
    'Result: Failed (OtherCompilationError)',
    f'{STAMP}CompilerResultsLog: {CLANG_ERROR}',
    f'{STAMP}CompilerResultsLog: {GENERATED}',
    f'{STAMP}CompilerResultsLog: Result: Failed (OtherCompilationError)',
    f'{STAMP}LogMainFrame: MainFrame: Module compiling took 8.1 seconds',
]
FAILED_LOG = [
    RECOMPILING,
    "Source/GxCpp/Parts/Lap/GxLapTimer.cpp:6:9: error: use of undeclared identifier 'FStrin'; did you mean 'FString'?",
    '~/Epic/UE_5.8/Engine/Source/Runtime/Core/Public/CoreMinimal.h:4:1: error: a home path',
    "/Users/genex-tester2/Other/Thing.h:3:1: error: a sibling of the home folder stays as it is",
    GENERATED,
    EXITED.strip(),
]


class Recompile(HelperCase):
    def setUp(self) -> None:
        super().setUp()
        for patch in (mock.patch.object(sys, 'platform', 'darwin'), mock.patch.dict(os.environ, {'HOME': HOME})):
            patch.start()
            self.addCleanup(patch.stop)
        self.write(os.path.join(self.project, 'Source', MODULE, f'{MODULE}.Build.cs'), 'using UnrealBuildTool;\n')
        self.binaries = self.path('game', 'unreal', 'Binaries', 'Mac')
        self.write(os.path.join(self.binaries, 'libUnrealEditor-GxCpp.dylib'), 'the first build')
        an_hour_ago = time.time() - 3600
        earlier = self.write(os.path.join(self.binaries, 'libUnrealEditor-GxCpp-1111.dylib'), 'an earlier hot reload')
        os.utime(earlier, (an_hour_ago, an_hour_ago))
        self.logs = self.path('game', 'unreal', 'Saved', 'Logs')
        self.log = self.write(os.path.join(self.logs, 'GxCpp.log'), '[2026.01.01-12.00.00:000][  0]LogInit: Display: Start\n'
                              '[2026.01.01-12.01.00:000][ 10]LogTemp: Error: written before the call\n')
        backup = self.write(os.path.join(self.logs, 'GxCpp_2.log'), 'an older editor session\n')
        os.utime(backup, (an_hour_ago, an_hour_ago))
        self.loadable('GxProbe')

    def loadable(self, *names: str) -> None:
        for name in names:
            unreal.state['classes'][f'/Script/{MODULE}.{name}'] = unreal.Class(path=f'/Script/{MODULE}.{name}')

    def libraries(self) -> list[str]:
        return sorted(os.listdir(self.binaries))

    def ubt(self, lines: list[str], suffix: str = '', classes: tuple[str, ...] = (), library: str = '') -> None:
        """Unreal's answer to the console command: it logs the lines, writes the library (suffixed
        by `suffix`, or exactly `library`) and has the classes."""

        def run(command: str) -> None:
            if lines:
                with open(self.log, 'a', encoding='utf-8') as handle:
                    handle.write(''.join(f'{line.replace(GAME, self.project)}\n' for line in lines))
            name = library or (f'libUnrealEditor-{MODULE}-{suffix}.dylib' if suffix else '')
            if name:
                self.write(os.path.join(self.binaries, name), 'hot reload')
            self.loadable(*classes)

        unreal.state['on_console'] = run

    def recompile(self, module: object = MODULE, classes: object = ('GxProbe',)) -> dict:
        return self.call('recompile_module', module, list(classes) if isinstance(classes, tuple) else classes)

    def test_a_new_library_with_every_class_loading_is_ok(self) -> None:
        self.ubt(COMPILED, suffix='5706', classes=('GxSpinner',))
        result = self.recompile(classes=('GxProbe', 'GxSpinner'))
        self.assertEqual({k: result[k] for k in ['ok', 'compiled', 'missing', 'log']},
                         {'ok': True, 'compiled': True, 'missing': [], 'log': [RECOMPILING]})
        self.assertIsInstance(result['ms'], int)
        self.assertEqual(unreal.calls, [COMMAND])

    def test_with_no_classes_a_new_library_is_enough(self) -> None:
        self.ubt(COMPILED, suffix='5706')
        self.assertTrue(self.recompile(classes=[])['ok'])

    def test_a_failed_compile_is_not_ok_and_brings_the_errors_written_during_the_call(self) -> None:
        self.ubt(FAILED)
        result = self.recompile()
        # The class is the one loaded before, so nothing is missing; no new library means no compile.
        self.assertEqual({k: result[k] for k in ['ok', 'compiled', 'missing', 'log']},
                         {'ok': False, 'compiled': False, 'missing': [], 'log': FAILED_LOG})
        self.assertEqual(unreal.calls, [COMMAND])

    def test_a_class_that_does_not_load_is_missing(self) -> None:
        self.ubt(COMPILED, suffix='5706', classes=('GxSpinner',))
        result = self.recompile(classes=('GxProbe', 'GxLapTimer', 'GxSpinner'))
        self.assertEqual({k: result[k] for k in ['ok', 'compiled', 'missing']},
                         {'ok': False, 'compiled': True, 'missing': ['GxLapTimer']})

    def test_only_a_new_suffixed_library_of_this_module_proves_the_compile(self) -> None:
        elsewhere = self.write(os.path.join(self.outside, 'libUnrealEditor-GxCpp-9999.dylib'), 'not UBT')
        cases = {
            'nothing written': {},
            'another module': {'library': 'libUnrealEditor-GxCppTools-5706.dylib'},
            'the unsuffixed library': {'library': 'libUnrealEditor-GxCpp.dylib'},
            'a suffix that is not a number': {'library': 'libUnrealEditor-GxCpp-new.dylib'},
            'the game, not the editor': {'library': 'libGxCpp-5706.dylib'},
        }
        for label, written in cases.items():
            with self.subTest(label):
                self.fresh()
                self.ubt(COMPILED, **written)
                self.assertEqual({k: self.recompile()[k] for k in ['ok', 'compiled']}, {'ok': False, 'compiled': False})
        with self.subTest('a link with a suffixed name'):
            link = os.path.join(self.binaries, 'libUnrealEditor-GxCpp-9999.dylib')
            unreal.state['on_console'] = lambda command: os.symlink(elsewhere, link)
            self.assertFalse(self.recompile()['compiled'])

    def test_keeps_at_most_20_error_lines_each_cut_short(self) -> None:
        self.ubt([f'{STAMP}CompilerResultsLog: Part.cpp:{n}:1: error: number {n}' for n in range(30)])
        self.assertEqual(self.recompile()['log'], [f'Part.cpp:{n}:1: error: number {n}' for n in range(20)])
        self.ubt([f'Long.cpp:1:1: error: {"x" * 2000}'])
        self.assertLessEqual(len(self.recompile()['log'][0]), 500)

    def test_reads_the_newest_plain_log_never_a_link(self) -> None:
        secret = self.write(os.path.join(self.outside, 'secret.txt'), '')
        self.ubt(FAILED)
        run = unreal.state['on_console']

        def run_and_write_elsewhere(command: str) -> None:
            run(command)
            with open(secret, 'a', encoding='utf-8') as handle:
                handle.write('error: a line from a file outside the log folder\n')

        os.symlink(secret, os.path.join(self.logs, 'Zz.log'))
        unreal.state['on_console'] = run_and_write_elsewhere
        self.assertEqual(self.recompile()['log'], FAILED_LOG)

    def test_answers_without_an_editor_log(self) -> None:
        shutil.rmtree(self.logs)
        self.ubt([], suffix='5706')
        result = self.recompile()
        self.assertEqual((result['ok'], result['log']), (True, []))

    def test_an_engine_error_from_the_command_is_an_answer_not_a_failure(self) -> None:
        def refuse(command: str) -> None:
            raise RuntimeError(f'Hot reload could not start for {self.project}/GxCpp.uproject')

        unreal.state['on_console'] = refuse
        result = self.recompile()
        self.assertEqual((result['ok'], result['compiled']), (False, False))
        self.assertEqual(result['log'][0], 'Hot reload could not start for GxCpp.uproject')

    def test_a_reload_that_logs_an_error_after_a_new_library_is_not_ok(self) -> None:
        cases = {
            'the hot reload failed': 'LogHotReload: Error: Hot reload failed, GxCpp could not be reloaded.',
            'the module did not load': 'LogModuleManager: Error: Unable to load module GxCpp-5706.',
        }
        # Each case builds a library of its own: one written again within the same timestamp tick
        # as the case before it (a fast runner) would look untouched, so not compiled.
        for index, (label, line) in enumerate(cases.items()):
            with self.subTest(label):
                self.fresh()
                self.ubt([*COMPILED, f'{STAMP}{line}'], suffix=str(5706 + index))
                result = self.recompile()
                self.assertEqual({k: result[k] for k in ['ok', 'compiled', 'missing']},
                                 {'ok': False, 'compiled': True, 'missing': []})
                self.assertIn(line, result['log'])

    def test_a_hot_reload_warning_is_still_ok(self) -> None:
        self.ubt([*COMPILED, f'{STAMP}LogHotReload: Warning: GxCpp took longer than usual.'], suffix='5706')
        self.assertTrue(self.recompile()['ok'])

    def test_a_log_that_shrank_during_the_call_brings_no_old_lines(self) -> None:
        def rotate(command: str) -> None:
            with open(self.log, 'w', encoding='utf-8') as handle:
                handle.write('LogTemp: Error: x\n')
            self.write(os.path.join(self.binaries, 'libUnrealEditor-GxCpp-5706.dylib'), 'hot reload')

        unreal.state['on_console'] = rotate
        result = self.recompile()
        self.assertEqual((result['ok'], result['log']), (True, []))

    def test_refuses_during_a_play_session(self) -> None:
        unreal.state['pie'] = True
        self.ubt(COMPILED, suffix='5706')
        before = self.libraries()
        self.assert_refused(self.recompile())
        self.assertEqual(self.libraries(), before)

    def test_refuses_off_a_mac(self) -> None:
        self.ubt(COMPILED, suffix='5706')
        with mock.patch.object(sys, 'platform', 'win32'):
            self.assert_refused(self.recompile())

    def test_refuses_names_that_are_not_the_projects_module_or_class_names(self) -> None:
        linked = self.path('outside', 'Linked')
        self.write(os.path.join(linked, 'Linked.Build.cs'), 'elsewhere')
        os.symlink(linked, os.path.join(self.project, 'Source', 'Linked'))
        self.path('game', 'unreal', 'Source', 'NoRules')
        swap = self.path('game', 'unreal', 'Source', 'Swap')
        os.symlink(os.path.join(linked, 'Linked.Build.cs'), os.path.join(swap, 'Swap.Build.cs'))
        cases = {
            'module with dot-dot': ('../x', ['GxProbe']),
            'module with a command after it': ('Engine;rm', ['GxProbe']),
            'module and another word': ('GxCpp Engine', ['GxProbe']),
            'module path': ('/Script/GxCpp', ['GxProbe']),
            'empty module': ('', ['GxProbe']),
            'module too long': ('G' * 65, ['GxProbe']),
            'module not a string': (7, ['GxProbe']),
            'an engine module': ('Engine', ['GxProbe']),
            'a module folder that is a link': ('Linked', ['GxProbe']),
            'a module without its Build.cs': ('NoRules', ['GxProbe']),
            'a Build.cs that is a link': ('Swap', ['GxProbe']),
            'classes a string': (MODULE, 'GxProbe'),
            'classes missing': (MODULE, None),
            'classes a dict': (MODULE, {'GxProbe': 1}),
            'too many classes': (MODULE, ['GxProbe'] * 33),
            'a class path': (MODULE, ['/Script/GxCpp.GxProbe']),
            'a class with dot-dot': (MODULE, ['../GxProbe']),
            'a class with a prefix and a space': (MODULE, ['A GxProbe']),
            'a class too long': (MODULE, ['G' * 65]),
            'an empty class': (MODULE, ['']),
            'a class not a string': (MODULE, [3]),
        }
        self.ubt(COMPILED, suffix='5706')
        before = self.libraries()
        for label, (module, classes) in cases.items():
            with self.subTest(label):
                self.fresh()
                self.assert_refused(self.recompile(module, classes))
                self.assertEqual(self.libraries(), before)


class SaveAll(HelperCase):
    def test_saves_every_unsaved_level_and_asset_without_asking(self) -> None:
        unreal.state['dirty'] = ['/Game/Maps/Track', '/Game/Parts/Bike/BP_Bike']
        result = self.call('save_all')
        self.assertEqual({k: result[k] for k in ['saved', 'dirty']}, {'saved': True, 'dirty': []})
        self.assertIsInstance(result['ms'], int)
        self.assertEqual(unreal.calls, [('save_dirty_packages', True, True)])

    def test_names_what_the_editor_left_unsaved(self) -> None:
        unreal.state['dirty'] = ['/Game/Maps/Track']
        unreal.state['save_refused'] = True
        result = self.call('save_all')
        self.assertEqual({k: result[k] for k in ['saved', 'dirty']}, {'saved': False, 'dirty': ['/Game/Maps/Track']})

    def test_refuses_during_a_play_session_and_saves_nothing(self) -> None:
        unreal.state['dirty'] = ['/Game/Maps/Track']
        unreal.state['pie'] = True
        self.assert_refused(self.call('save_all'))
        self.assertEqual(unreal.state['dirty'], ['/Game/Maps/Track'])
