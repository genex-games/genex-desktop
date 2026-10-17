"""The other loop tools refuse names that are paths, files outside their folder and kinds they
don't import, without touching the editor or writing anywhere."""

import json
import os

import unreal

from support import HelperCase


class Capture(HelperCase):
    def test_refuses_capture_names_that_are_paths(self) -> None:
        unreal.state['pie'] = True
        for name in ['../shot', 'a/b', '/tmp/shot', 'shot.png', '', 'x' * 65, 'shot 1', '..', 'shot\0']:
            with self.subTest(name=name):
                self.fresh()
                self.assert_refused(self.call('capture_play', name, 1280, 720))
        self.assertFalse(os.path.exists(os.path.join(self.project, 'Saved')))

    def test_refuses_without_a_play_session(self) -> None:
        self.assert_refused(self.call('capture_play', 'shot', 1280, 720))

    def shots_asked(self) -> list[str]:
        """The high-resolution shots asked through the play session's own console."""
        return [call[1][1] for call in unreal.calls if call[0] == 'console' and call[1][1].startswith('HighResShot')]

    def test_queues_a_clamped_shot_of_the_players_view_through_its_console_replacing_an_older_one(self) -> None:
        unreal.state['pie'] = True
        unreal.state['player'] = unreal.Character('Hero_0', unreal.Vector())
        older = self.write(os.path.join(self.project, 'Saved', 'Genex', 'captures', 'yard-1.png'), 'old')
        result = self.call('capture_play', 'yard-1', 99999, 10)
        self.assertEqual(result, {'queued': True, 'file': older})
        self.assertFalse(os.path.exists(older), 'the older shot is removed before the new one is queued')
        self.assertEqual(self.shots_asked(), [f'HighResShot 3840x240 filename="{older}"'])
        self.assertNotIn('screenshot', [call[0] for call in unreal.calls],
                         'never the automation screenshot, which renders the level viewport and writes twice')

    def test_a_size_left_at_zero_is_the_default(self) -> None:
        unreal.state['pie'] = True
        unreal.state['player'] = unreal.Character('Hero_0', unreal.Vector())
        file = self.call('capture_play', 'yard', 0, 0)['file']
        self.assertEqual(self.shots_asked(), [f'HighResShot 1280x720 filename="{file}"'])


class Imports(HelperCase):
    def setUp(self) -> None:
        super().setUp()
        self.glb = self.write(os.path.join(self.game, 'assets', 'lantern.glb'), 'glTF')
        self.wav = self.write(os.path.join(self.game, 'assets', 'hum.wav'), 'RIFF')

    def test_refuses_kinds_extensions_destinations_and_names_it_does_not_take(self) -> None:
        os.symlink('/etc/hosts', os.path.join(self.game, 'assets', 'hosts.glb'))
        good = (self.glb, '/Game/Parts/Lantern', 'SM_Lantern', 'static_mesh')
        cases = {
            'unknown kind': (self.glb, good[1], good[2], 'blueprint'),
            'sound from a model': (self.glb, good[1], good[2], 'sound'),
            'model from a sound': (self.wav, good[1], good[2], 'static_mesh'),
            'animation from an obj': (self.write(os.path.join(self.game, 'assets', 'a.obj'), 'o'), good[1], 'A_Run', 'animation'),
            'relative file': (os.path.relpath(self.glb), *good[1:]),
            'dot-dot file': (os.path.join(self.game, 'assets', '..', 'assets', 'lantern.glb'), *good[1:]),
            'missing file': (os.path.join(self.game, 'assets', 'nope.glb'), *good[1:]),
            'link to a file of another kind': (os.path.join(self.game, 'assets', 'hosts.glb'), *good[1:]),
            'a directory': (self.path('game', 'assets', 'dir.glb'), *good[1:]),
            'dest outside Game': (self.glb, '/Engine/BasicShapes', good[2], good[3]),
            'dest with dot-dot': (self.glb, '/Game/Parts/../../Engine', good[2], good[3]),
            'dest relative': (self.glb, 'Game/Parts', good[2], good[3]),
            'dest a file path': (self.glb, self.project, good[2], good[3]),
            'dest with a space': (self.glb, '/Game/My Parts', good[2], good[3]),
            'name with a slash': (self.glb, good[1], 'a/b', good[3]),
            'name with a space': (self.glb, good[1], 'SM Lantern', good[3]),
            'empty name': (self.glb, good[1], '', good[3]),
        }
        for label, (file, dest, name, kind) in cases.items():
            with self.subTest(label):
                self.fresh()
                self.assert_refused(self.call('import_asset', file, dest, name, kind, '', True))

    def test_an_animation_needs_a_skeleton_asset_path(self) -> None:
        for skeleton in ['', '../SK_Mannequin', '/Engine/SK_Mannequin', '/Game/Characters/SK Mannequin']:
            with self.subTest(skeleton=skeleton):
                self.fresh()
                self.assert_refused(self.call('import_asset', self.glb, '/Game/Anims', 'A_Run', 'animation', skeleton, True))

    def test_list_assets_takes_only_game_folders(self) -> None:
        for path in ['/Engine', '/Game/../Engine', 'Game', '/Game/a b']:
            with self.subTest(path=path):
                self.fresh()
                self.assert_refused(self.call('list_assets', path))


class Exports(HelperCase):
    def hostile_files(self) -> dict[str, str]:
        genex = self.path('game', 'unreal', 'Saved', 'Genex')
        os.symlink(self.outside, os.path.join(genex, 'out'))
        sibling = self.path('game', 'unreal', 'Saved', 'GenexEvil')
        return {
            'relative': 'Saved/Genex/reference.json',
            'dot-dot': os.path.join(genex, '..', '..', '..', 'reference.json'),
            'outside': os.path.join(self.outside, 'reference.json'),
            'link out of the folder': os.path.join(genex, 'out', 'reference.json'),
            'sibling with the same prefix': os.path.join(sibling, 'reference.json'),
            'the folder itself': genex,
            'a directory inside': self.path('game', 'unreal', 'Saved', 'Genex', 'dir'),
            'empty': '',
        }

    def test_refuses_export_files_outside_saved_genex(self) -> None:
        hostile = self.hostile_files()
        for tool in ['export_reference', 'export_python_names']:
            for label, file in hostile.items():
                with self.subTest(tool=tool, case=label):
                    self.fresh()
                    self.assert_refused(self.call(tool, file))
                    self.assertEqual(os.listdir(self.outside), [])

    def test_refuses_a_pin_request_that_is_not_contexts_to_type_ids(self) -> None:
        file = os.path.join(self.project, 'Saved', 'Genex', 'reference.json')
        for pins in ['[', '["Actor/EventGraph"]', '{"Actor/Graph": ["X"]}', '{"Actor/EventGraph": "X"}',
                     json.dumps({'Actor/EventGraph': [f'N{i}' for i in range(201)]})]:
            with self.subTest(pins=pins):
                self.fresh()
                self.assert_refused(self.call('export_reference', file, pins))
                self.assertFalse(os.path.exists(file))

    def test_writes_python_names_inside_saved_genex(self) -> None:
        file = os.path.join(self.project, 'Saved', 'Genex', 'names', 'python-names.json')
        result = self.call('export_python_names', file)
        self.assertEqual(result['file'], file)
        with open(file, encoding='utf-8') as handle:
            self.assertIn('Actor', json.load(handle))


class Session(HelperCase):
    def test_stop_play_releases_inputs_and_asks_the_session_to_end(self) -> None:
        unreal.state['pie'] = True
        self.assertEqual(self.call('stop_play'), {'stopping': True, 'released': 0})
        self.assertEqual(unreal.calls, [('end_play',)])

    def test_play_state_and_game_state_read_without_changing_anything(self) -> None:
        tagged = unreal.Actor('Lantern_0', unreal.Vector(300.4, -200, 50))
        tagged.tags = [unreal.Name('GenexPart:Lantern')]
        unreal.state['actors'] = [tagged, unreal.Actor('Floor')]
        self.assertEqual(self.call('play_state'), {'pie': False, 'world': None, 'gameSeconds': None, 'fps': None})
        state = self.call('game_state', '')
        self.assertEqual([a['label'] for a in state['actors']], ['Lantern_0'])
        self.assertEqual(state['actors'][0]['location'], [300, -200, 50])
        self.assertEqual(self.call('game_state', 'Other')['actors'], [])
        self.assertIn('error', self.call('game_state', '../Lantern'))
        self.assertEqual(unreal.calls, [])

    def test_game_state_lists_the_live_builders_feature_actors_with_their_genex_tags(self) -> None:
        part = unreal.Actor('Lantern_0')
        part.tags = [unreal.Name('GenexPart:Lantern')]
        terrain = unreal.Actor('GenexTerrain')
        terrain.tags = [unreal.Name('genex:terrain'), unreal.Name('Ground')]
        ramp = unreal.Actor('Ramp_0')
        ramp.tags = [unreal.Name('genex:jumps'), unreal.Name('genex:track')]
        unreal.state['actors'] = [part, terrain, ramp, unreal.Actor('Floor')]
        rows = {a['label']: a['tags'] for a in self.call('game_state', '')['actors']}
        self.assertEqual(rows, {'Lantern_0': [], 'GenexTerrain': ['genex:terrain'],
                                'Ramp_0': ['genex:jumps', 'genex:track']})
        self.assertEqual([a['label'] for a in self.call('game_state', 'Lantern')['actors']], ['Lantern_0'],
                         'a part still lists only its own actors')
        self.assertEqual(unreal.calls, [])

    def test_game_state_counts_every_genex_tag_past_the_actors_it_lists(self) -> None:
        posts = []
        for i in range(250):
            post = unreal.Actor(f'Post_{i}')
            post.tags = [unreal.Name('genex:scenery')]
            posts.append(post)
        terrain = unreal.Actor('GenexTerrain')
        terrain.tags = [unreal.Name('genex:terrain'), unreal.Name('Ground')]
        unreal.state['actors'] = [*posts, terrain, unreal.Actor('Floor')]
        state = self.call('game_state', '')
        self.assertEqual((len(state['actors']), state['more']), (200, 51), 'the rows stay capped')
        self.assertEqual(state['tags'], {'genex:scenery': 250, 'genex:terrain': 1},
                         'every genex: tag is counted, the ones past the cap too')
        self.assertEqual(unreal.calls, [])

    def test_play_state_reads_the_play_sessions_game_clock(self) -> None:
        unreal.state['pie'] = True
        unreal.state['game_seconds'], unreal.state['world_delta'] = 12.25, 0.125
        self.assertEqual(self.call('play_state'), {'pie': True, 'world': 'PIE_Map', 'gameSeconds': 12.25, 'fps': 8.0})
