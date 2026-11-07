"""A pilot plays toward a goal by itself in the play session, every frame on the game clock: its
running move steps each frame, it looks a few times a second, and at decision points a move is picked
by a decider's answer or, without one, by the pilot's own order. The fast decision model is optional:
without it a pilot plays by its order alone."""

import json
import ntpath
import os
import textwrap
import types
from unittest import mock

import unreal
from unreal import Vector

from genex_loop import paths
from genex_loop.errors import Refused
from genex_play import pilot as pilot_run
from genex_play.tools import GenexPlayTools

from support import HelperCase
from test_walk import WalkCase

STONE_PILOT = '''
from genex_play.pilot_kit import Move, Outcome, Pilot, Stage

class Stones(Pilot):
    goal = 'Pick up a stone'
    stages = [Stage('stone', 'Hold a stone', lambda view: view['stones'] >= 1, ['pick_stone'])]

    def look(self, game):
        stone, metres = game.nearest('Stone')
        return {'stones': game.read('BP_Hero_0', 'stones', 0), 'stone_m': metres, '_stone': stone}

    def moves(self, view):
        moves = [Move('wait', 'stand still', lambda game, view: game.wait(1.0))]
        if view['_stone'] is not None:
            moves.insert(0, Move('pick_stone', 'walk to the nearest stone and pick it up', self.pick,
                                 facts={'distance_m': view['stone_m']}))
        return moves

    def pick(self, game, view):
        walked = yield from game.walk_to(view['_stone'])
        if walked['state'] != 'arrived':
            return False, walked['reason']
        yield from game.tap('E')
        return True

    def outcome(self, view):
        return Outcome.done('a stone in hand', stones=view['stones']) if view['stones'] >= 1 else Outcome.playing()
'''

TWO_WAYS = '''
from genex_play.pilot_kit import Move, Outcome, Pilot

class TwoWays(Pilot):
    goal = 'Reach a flag'
    decide_hz = 2.0
    stop_lead = 0.3

    def look(self, game):
        return {'east_m': game.distance('FlagEast'), 'west_m': game.distance('FlagWest')}

    def moves(self, view):
        return [Move('go_east', 'walk to the east flag', lambda game, view: game.walk_to('FlagEast'),
                     facts={'distance_m': view['east_m']}),
                Move('go_west', 'walk to the west flag', lambda game, view: game.walk_to('FlagWest'),
                     facts={'distance_m': view['west_m']}, can_stop=STOPPABLE)]

    def outcome(self, view):
        return Outcome.done('at a flag') if min(view['east_m'], view['west_m']) < 1.5 else Outcome.playing()
'''

NEVER_WORKS = '''
from genex_play.pilot_kit import Move, Pilot

class Stuck(Pilot):
    goal = 'Open the door'
    stall_seconds = 3.0

    def look(self, game):
        return {}

    def moves(self, view):
        return [Move('push', 'push the door', self.push)]

    def push(self, game, view):
        yield from game.wait(0.6)
        return False, 'the door did not move'
'''


class Prop(unreal.Actor):
    """A level actor of the game's own with a body, a variable or two read by the pilot."""

    def __init__(self, label: str, location: Vector) -> None:
        super().__init__(label, location)
        self.components = [unreal.CapsuleComponent(location=location)]


def tool(name: str, *args) -> dict:
    return json.loads(getattr(GenexPlayTools, name)(*args))


class PilotCase(WalkCase):
    """The walk tests' world (a character on open ground, facing +Y, with move and jump actions), a
    stone to the east that E picks up from within 1.5 m, and a pilots folder in the project."""

    def setUp(self) -> None:
        super().setUp()
        self.hero.props['stones'] = 0
        self.stone = Prop('Stone_1', Vector(600, 0, 100))
        unreal.state['actors'].append(self.stone)
        shout = self.world.console

        def console(command: str) -> None:
            shout(command)
            near = abs(self.hero.location.x - 600) < 150 and abs(self.hero.location.y) < 150
            if command == 'Input.+key E 1' and near and self.stone in unreal.state['actors']:
                self.hero.props['stones'] += 1
                unreal.state['actors'].remove(self.stone)

        unreal.state['on_console'] = console
        unreal.state['keys'].add('E')
        self.addCleanup(self.stop_pilot)

    def stop_pilot(self) -> None:
        if pilot_run._run is not None and pilot_run._run.phase == pilot_run.Phase.PILOTING:
            tool('pilot_step', '', True)
        pilot_run._run = None

    def pilot_file(self, name: str, source: str, **names) -> str:
        text = textwrap.dedent(source)
        for key, value in names.items():
            text = text.replace(key, repr(value))
        self.write(os.path.join(self.project, 'Pilots', name), text)
        return f'Pilots/{name}'

    def until_over(self, most: int = 4000, answer=None) -> dict:
        """Frames until the pilot's run is over (answering each ask with answer(ask) when given); its report."""
        for _ in range(most):
            state = tool('pilot_step')
            if state['phase'] == 'over':
                return state['report']
            if answer is not None and state['ask'] is not None:
                given = answer(state['ask'])
                if given is not None:
                    tool('pilot_step', json.dumps(given))
            self.frame()
        self.fail('the pilot never ended')


class ByOrder(PilotCase):
    def test_plays_to_its_goal_by_its_own_order_without_any_decider(self) -> None:
        started = tool('pilot', self.pilot_file('stones.py', STONE_PILOT), 60.0, False)
        self.assertEqual((started['piloting'], started['pilot'], started['stages']), (True, 'Stones', ['stone']))
        report = self.until_over()
        self.assertEqual(report['outcome'], 'done')
        self.assertEqual(report['evidence'], {'stones': 1})
        self.assertEqual(report['stages'][0]['done'], True)
        moves = {m['name']: m for m in report['moves']}
        self.assertEqual(moves['pick_stone']['started'], 1, 'one pick did it (the run may end before the move reports back)')
        self.assertNotIn('wait', moves, 'the stage offers only its own move')
        self.assertEqual((report['asked'], report['answered']), (0, 0))
        self.assertGreaterEqual(report['byOrder'], 1)
        self.assertNotIn('IA_Move', self.world.actions, 'nothing is left held')
        pilots = os.path.join(self.project, 'Pilots')
        self.assertEqual(sorted(os.listdir(pilots)), ['stones.py'], 'no bytecode cache is left in the project')

    def test_an_urgent_move_listed_first_stops_the_running_one_and_its_walk_lets_go(self) -> None:
        unreal.state['actors'].append(Prop('FlagEast', Vector(5000, 0, 100)))
        source = '''
        from genex_play.pilot_kit import Move, Pilot

        class Flee(Pilot):
            goal = 'Walk east until hit, then hold still'

            def look(self, game):
                return {'hit': game.read('BP_Hero_0', 'hit', False)}

            def moves(self, view):
                walk = Move('go_east', 'walk east', lambda game, view: game.walk_to('FlagEast'))
                if view['hit']:
                    return [Move('duck', 'crouch', lambda game, view: game.hold('C', 5.0), urgent=True), walk]
                return [walk]
        '''
        unreal.state['keys'].add('C')
        tool('pilot', self.pilot_file('flee.py', source), 30.0, False)
        self.frames(20)
        self.assertIn('IA_Move', self.world.actions, 'it walks east first')
        self.hero.props['hit'] = True
        self.frames(6)
        self.assertNotIn('IA_Move', self.world.actions, 'the stopped walk let go of the move action')
        self.assertIn('C', self.world.keys, 'the urgent move holds its key')
        timeline = tool('pilot_step', '', True)['report']['timeline']
        self.assertTrue(any('go_east stopped: switched to duck' in line for line in timeline), timeline)
        self.assertNotIn('C', self.world.keys, 'stopping the run released the held key')

    def test_a_move_that_never_works_stalls_the_run_with_what_it_tried(self) -> None:
        tool('pilot', self.pilot_file('stuck.py', NEVER_WORKS), 60.0, False)
        report = self.until_over()
        self.assertEqual(report['outcome'], 'stalled')
        self.assertIn('no stage done and no move worked for 3 game seconds', report['note'])
        push = report['moves'][0]
        self.assertEqual((push['name'], push['worked']), ('push', 0))
        self.assertGreaterEqual(push['failed'], 3)
        self.assertTrue(any('push failed: the door did not move' in line for line in report['timeline']))

    def test_runs_out_of_time_as_timed_out(self) -> None:
        tool('pilot', self.pilot_file('stuck.py', NEVER_WORKS.replace('3.0', '0')), 2.0, False)
        report = self.until_over()
        self.assertEqual(report['outcome'], 'timed-out')
        self.assertLessEqual(abs(report['gameSeconds'] - 2.0), 0.2)


class Deciding(PilotCase):
    def setUp(self) -> None:
        super().setUp()
        unreal.state['actors'].extend([Prop('FlagEast', Vector(3000, 0, 100)), Prop('FlagWest', Vector(-3000, 0, 100))])

    def test_asks_with_the_state_and_moves_and_plays_the_decided_move_not_the_first(self) -> None:
        tool('pilot', self.pilot_file('two.py', TWO_WAYS, STOPPABLE=True), 60.0, True)
        self.frame()
        ask = tool('pilot_step')['ask']
        self.assertEqual(ask['moves'], {'go_east': 'walk to the east flag', 'go_west': 'walk to the west flag'})
        self.assertEqual(ask['state']['goal'], 'Reach a flag')
        self.assertEqual(ask['state']['moves']['go_east'], {'distance_m': 30.0})
        self.assertIn('situation', ask['state'])
        self.assertTrue(ask['instructions'])
        west = lambda ask: {'id': ask['id'], 'probabilities': {'go_east': 0.1, 'go_west': 0.9}, 'answers': {}, 'ms': 120}
        report = self.until_over(answer=west)
        self.assertEqual(report['outcome'], 'done')
        self.assertLess(self.hero.location.x, -2800, 'it went west, as decided, though east is listed first')
        self.assertGreaterEqual(report['answered'], 1)
        self.assertEqual(report['moves'][0]['name'], 'go_west')

    def test_a_late_answer_replaces_the_stand_in_started_while_it_was_on_its_way(self) -> None:
        tool('pilot', self.pilot_file('two.py', TWO_WAYS, STOPPABLE=True), 60.0, True)
        self.frame()
        ask = tool('pilot_step')['ask']
        self.frames(10)  # half a second: the first move by order starts as a stand-in
        self.assertIn('IA_Move', self.world.actions, 'no frame stays idle while the answer is on its way')
        applied = tool('pilot_step', json.dumps({'id': ask['id'], 'probabilities': {'go_east': 0.45, 'go_west': 0.55},
                                                 'answers': {}, 'ms': 500}))['applied']
        self.assertEqual(applied, 'switched', 'the answer replaces the stand-in even under the margin')
        self.assertEqual(tool('pilot_step')['running'], 'go_west')

    def test_a_running_move_gives_way_only_by_the_margin_and_never_when_it_cannot_stop(self) -> None:
        for stoppable, lead, expected in ((True, 0.2, 'kept-running'), (True, 0.6, 'switched'), (False, 0.9, 'kept-running')):
            with self.subTest(stoppable=stoppable, lead=lead):
                self.stop_pilot()
                tool('pilot', self.pilot_file('two.py', TWO_WAYS, STOPPABLE=stoppable), 60.0, True)
                self.frame()
                first = tool('pilot_step')['ask']
                low = (1 - lead) / 2
                tool('pilot_step', json.dumps({'id': first['id'], 'probabilities': {'go_west': 1.0}, 'answers': {}, 'ms': 1}))
                self.assertEqual(tool('pilot_step')['running'], 'go_west')
                ask = None
                for _ in range(40):
                    self.frame()
                    ask = tool('pilot_step')['ask']
                    if ask is not None:
                        break
                self.assertIsNotNone(ask, 'it asks again while the move runs, at decide_hz')
                answer = {'id': ask['id'], 'probabilities': {'go_east': low + lead, 'go_west': low}, 'answers': {}, 'ms': 1}
                self.assertEqual(tool('pilot_step', json.dumps(answer))['applied'], expected)

    def test_an_answer_for_an_old_ask_or_malformed_changes_nothing(self) -> None:
        tool('pilot', self.pilot_file('two.py', TWO_WAYS, STOPPABLE=True), 60.0, True)
        self.frame()
        ask = tool('pilot_step')['ask']
        for given, expected in ((json.dumps({'id': ask['id'] + 7, 'probabilities': {'go_west': 1}}), 'stale'),
                                ('{not json', 'malformed'), (json.dumps([1, 2]), 'malformed')):
            with self.subTest(given=given):
                self.assertEqual(tool('pilot_step', given)['applied'], expected)
                self.assertIsNone(tool('pilot_step')['running'])

    def test_an_ask_nobody_answers_is_dropped_and_play_goes_on_by_order(self) -> None:
        tool('pilot', self.pilot_file('two.py', TWO_WAYS, STOPPABLE=True), 60.0, True)
        report = self.until_over()
        self.assertEqual(report['outcome'], 'done')
        self.assertGreater(self.hero.location.x, 2800, 'by order: the first move listed')
        self.assertEqual(report['answered'], 0)
        self.assertGreaterEqual(report['asked'], 1)


class Broken(PilotCase):
    def test_refuses_a_path_up_out_through_a_link_or_not_a_plain_python_file_and_loads_nothing(self) -> None:
        outside = self.write(os.path.join(self.outside, 'evil.py'), 'raise SystemExit("ran")\n')
        os.symlink(outside, os.path.join(self.path('game', 'unreal', 'Pilots'), 'link.py'))
        os.symlink(self.outside, os.path.join(self.root, 'linked'))
        for file in ('../outside/evil.py', 'Pilots/missing.py', 'Pilots/stones.txt', 'Pilots/link.py',
                     os.path.join(self.root, 'linked', 'evil.py'), outside + '.txt', 'Pilots\\stones.py', '', 7):
            with self.subTest(file=file):
                self.assertIn('error', tool('pilot', file, 10.0, False))
                self.assertIsNone(pilot_run._run)

    def test_plays_a_pilot_genex_hands_over_from_the_game_folder_by_its_real_path(self) -> None:
        file = self.write(os.path.join(self.game, 'pilots', 'stones.py'), textwrap.dedent(STONE_PILOT))
        self.assertTrue(tool('pilot', file, 60.0, False)['piloting'])
        self.assertEqual(self.until_over()['outcome'], 'done')
        self.assertFalse(os.path.exists(os.path.join(self.project, 'Pilots')), 'the project is left as it was')

    def test_a_file_that_does_not_load_names_its_line(self) -> None:
        answer = tool('pilot', self.pilot_file('bad.py', 'x = 1\ndef broken(:\n'), 10.0, False)
        self.assertIn('bad.py', answer['error'])
        self.assertIn('SyntaxError', answer['error'])
        self.assertIn('defines no Pilot subclass', tool('pilot', self.pilot_file('none.py', 'x = 1\n'), 10.0, False)['error'])

    def test_a_failing_setup_or_a_look_that_keeps_failing_ends_the_run_broken_with_the_line(self) -> None:
        setup = 'from genex_play.pilot_kit import Pilot\nclass P(Pilot):\n    def setup(self, game):\n        raise KeyError("door")\n'
        self.assertFalse(tool('pilot', self.pilot_file('setup.py', setup), 10.0, False)['piloting'])
        report = tool('pilot_step')['report']
        self.assertEqual(report['outcome'], 'broken')
        self.assertTrue(any('setup (line 4): KeyError' in e for e in report['errors']), report['errors'])
        look = 'from genex_play.pilot_kit import Pilot\nclass P(Pilot):\n    def look(self, game):\n        return 1 / 0\n'
        tool('pilot', self.pilot_file('look.py', look), 30.0, False)
        report = self.until_over()
        self.assertEqual(report['outcome'], 'broken')
        self.assertIn('its look kept failing', report['note'])

    def test_a_move_that_fails_at_once_twice_rests_while_another_is_offered(self) -> None:
        source = '''
        from genex_play.pilot_kit import Move, Pilot

        class Rest(Pilot):
            goal = 'Open the chest'
            stall_seconds = 0

            def look(self, game):
                return {}

            def moves(self, view):
                return [Move('open', 'open the chest', lambda game, view: False),
                        Move('wait', 'wait', lambda game, view: game.wait(0.2))]
        '''
        tool('pilot', self.pilot_file('rest.py', source), 2.5, False)
        report = self.until_over()
        self.assertTrue(any('open rests 3 s' in line for line in report['timeline']), report['timeline'])
        opened = next(m for m in report['moves'] if m['name'] == 'open')
        self.assertEqual(opened['started'], 2, 'resting, it is not offered again before the run ends')

    def test_the_play_ending_stops_the_run(self) -> None:
        tool('pilot', self.pilot_file('stuck.py', NEVER_WORKS), 60.0, False)
        self.frames(3)
        self.end_play()
        report = tool('pilot_step')['report']
        self.assertEqual((report['outcome'], report['note']), ('stopped', 'the play ended'))


class WindowsDisk:
    """Paths as Windows spells them (ntpath): Unreal names the project D:/games/duel/unreal/, a real path
    has \\ between folders and each name in its real case, and a folder may be a link elsewhere."""

    PROJECT = 'D:/games/duel/unreal/'
    FILES = ('D:\\games\\duel\\unreal\\Pilots\\fight.py', 'D:\\games\\duel\\pilots\\fight.py',
             'E:\\elsewhere\\evil.py')
    LINKS = {'D:\\games\\duel\\unreal\\Linked': 'E:\\elsewhere'}

    def realpath(self, path: str) -> str:
        spelled = ntpath.normpath(path)
        for link, target in self.LINKS.items():
            if ntpath.normcase(spelled).startswith(ntpath.normcase(link) + '\\'):
                spelled = target + spelled[len(link):]
        return next((real for real in self.FILES if ntpath.normcase(real) == ntpath.normcase(spelled)), spelled)

    def is_regular_file(self, path: str) -> bool:
        """Like os.lstat, it follows links on the way to the file."""
        return ntpath.normcase(self.realpath(path)) in {ntpath.normcase(real) for real in self.FILES}

    def os(self) -> types.SimpleNamespace:
        """An `os` whose path module is ntpath with this disk's real paths."""
        flavor = types.SimpleNamespace(**{name: getattr(ntpath, name) for name in ('isabs', 'join', 'normpath',
                                                                                  'normcase', 'sep', 'altsep')})
        flavor.realpath = self.realpath
        return types.SimpleNamespace(path=flavor)


class WindowsPilotPaths(HelperCase):
    """On Windows the project's real path has \\ and a pilot is named with / (or by the \\ path Genex hands
    over): the same file, never a link."""

    def setUp(self) -> None:
        super().setUp()
        disk = WindowsDisk()
        unreal.state['project'] = WindowsDisk.PROJECT.rstrip('/')
        for patch in (mock.patch.object(pilot_run, 'os', disk.os()), mock.patch.object(paths, 'os', disk.os()),
                      mock.patch.object(pilot_run, 'is_regular_file', disk.is_regular_file)):
            patch.start()
            self.addCleanup(patch.stop)

    def test_takes_a_pilot_named_with_slashes_in_any_case_or_by_its_full_path(self) -> None:
        cases = {
            'Pilots/fight.py': 'D:\\games\\duel\\unreal\\Pilots\\fight.py',
            'pilots/FIGHT.py': 'D:\\games\\duel\\unreal\\pilots\\FIGHT.py',
            'Pilots\\fight.py': 'D:\\games\\duel\\unreal\\Pilots\\fight.py',
            'D:\\games\\duel\\pilots\\fight.py': 'D:\\games\\duel\\pilots\\fight.py',
            'D:/games/duel/pilots/fight.py': 'D:\\games\\duel\\pilots\\fight.py',
        }
        for file, path in cases.items():
            with self.subTest(file=file):
                self.assertEqual(pilot_run.pilot_file(file), path)

    def test_still_refuses_a_link_a_way_up_or_a_missing_file(self) -> None:
        cases = {
            'Linked/evil.py': 'leads through a link',
            'Linked\\evil.py': 'leads through a link',
            'Pilots\\..\\..\\pilots\\fight.py': 'is a .py file',
            'Pilots/../Pilots/fight.py': 'is a .py file',
            'Pilots/missing.py': 'no pilot file',
            'Pilots/fight.txt': 'is a .py file',
        }
        for file, why in cases.items():
            with self.subTest(file=file), self.assertRaises(Refused) as refused:
                pilot_run.pilot_file(file)
            self.assertIn(why, str(refused.exception), file)


class Blocker:
    """A wall seen from above (x0, y0, x1, y1) that sight lines across it hit."""

    def __init__(self, rect: tuple, owner) -> None:
        self.rect, self.owner = rect, owner

    def crossed(self, start, end):
        for step in range(1, 101):
            t = step / 100
            x, y = start.x + (end.x - start.x) * t, start.y + (end.y - start.y) * t
            if self.rect[0] <= x <= self.rect[2] and self.rect[1] <= y <= self.rect[3]:
                return Vector(x, y, start.z)
        return None


BRUTE_PILOT = '''
from genex_play.pilot_kit import Move, Pilot

class Duel(Pilot):
    goal = 'Beat the brute'

    def look(self, game):
        return {'brute_m': game.distance('Brute')}

    def moves(self, view):
        return [Move('wait', 'stand and watch', lambda game, view: game.wait(1.0))]

    def reflex(self, game):
        game.dodge('Brute')
'''


class RunIds(PilotCase):
    def test_two_runs_of_a_pilot_in_one_second_get_their_own_ids(self) -> None:
        path = self.pilot_file('stones.py', STONE_PILOT)
        ids = []
        for _ in range(2):
            self.assertTrue(tool('pilot', path, 30.0, False)['piloting'])
            ids.append(tool('pilot_step', '', True)['report']['runId'])
        self.assertNotEqual(ids[0], ids[1], 'a second run keeps its own record and film log')


class Reflexes(PilotCase):
    """A brute swings a montage whose hits land at DoAttackTrace notifies: a pilot reads the seconds until each
    hit and dodges once per hit, just before it lands, in its every-frame reflex."""

    def setUp(self) -> None:
        super().setUp()
        unreal.state['registry'].append(unreal.AssetData('/Game/Input/IA_Dodge', 'InputAction',
                                                         asset=unreal.InputAction('IA_Dodge', unreal.InputActionValueType.BOOLEAN)))
        self.swing = unreal.AnimMontage('/Game/AM_Combo', 3.0, [(0.467, 'DoAttackTrace'), (0.533, 'CheckCombo'),
                                                                (1.467, 'DoAttackTrace')])
        self.anim = unreal.AnimInstance(rate=0.65)
        mesh = unreal.SkeletalMeshComponent(location=Vector(300, 0, 100), anim_instance=self.anim)
        self.brute = unreal.Character('Brute', Vector(300, 0, 100), mesh=mesh)
        unreal.state['actors'].append(self.brute)

    def kit(self):
        from genex_play.pilot_game import Game
        return Game()

    def test_reads_the_game_seconds_until_the_next_hit_lands(self) -> None:
        game = self.kit()
        self.assertIsNone(game.threat('Brute'), 'no attack plays')
        self.anim.montage, self.anim.position = self.swing, 0.2
        seen = game.threat('Brute')
        self.assertEqual((seen['attack'], seen['hit_at']), ('AM_Combo', 0.467))
        self.assertAlmostEqual(seen['to_hit'], (0.467 - 0.2) / 0.65, places=2)
        self.anim.position = 0.5
        self.assertEqual(game.threat('Brute')['hit_at'], 1.467, 'CheckCombo is bookkeeping, not a hit')
        self.anim.position = 2.0
        self.assertIsNone(game.threat('Brute')['to_hit'], 'no hit is left in the swing')

    def test_a_pilot_dodges_each_hit_once_just_before_it_lands(self) -> None:
        path = self.pilot_file('duel.py', BRUTE_PILOT)
        self.assertTrue(tool('pilot', path, 30.0, False)['piloting'])
        pressed = []
        shout = self.world.console

        def console(command: str) -> None:
            shout(command)
            if command.startswith('Input.+action IA_Dodge'):
                pressed.append(round(self.anim.position, 3))

        unreal.state['on_console'] = console
        self.anim.montage = self.swing
        for position in [0.0, 0.1, 0.2, 0.3, 0.35, 0.4, 0.45, 0.6, 1.0, 1.2, 1.3, 1.4, 0.0, 0.3, 0.35]:
            self.anim.position = position
            self.frame()
        self.assertEqual(pressed, [0.3, 1.3, 0.3], 'once per hit, under 0.3 s before it, and again when the swing starts over')
        report = tool('pilot_step', '', True)['report']
        self.assertEqual(report['reflexes']['count'], 3)
        self.assertEqual(report['reflexes']['last'][0]['attack'], 'AM_Combo')


STARTER = os.path.join(os.path.dirname(__file__), '..', '..', '..', 'src', 'plugins', 'unreal', 'GenexEditorHelper',
                       'Templates', 'pilots', 'explore.py')


class Starter(PilotCase):
    """Genex's starter pilot plays any level: it walks to places and meets the characters, without errors."""

    def test_the_starter_pilot_plays_without_errors(self) -> None:
        unreal.state['keys'] |= {'LeftMouseButton', 'RightMouseButton'}  # keys every Unreal knows
        unreal.state['actors'].append(unreal.Character('BP_Bot_1', Vector(-800, 0, 100)))
        unreal.state['actors'].append(unreal.PlayerStart('PlayerStart_2', Vector(0, 1500, 100)))
        unreal.state['actors'].append(unreal.PlayerStart('PlayerStart_3', Vector(0, 900, 2000)))  # up on a roof
        unreal.state['nav_path'] = lambda start, end: unreal.NavigationPath([start, end])  # every floor point is reachable
        path = self.pilot_file('explore.py', open(STARTER).read())
        self.assertTrue(tool('pilot', path, 20.0, False)['piloting'])
        for _ in range(400):
            self.frame()
        report = tool('pilot_step', '', True)['report']
        self.assertEqual(report['errors'], [])
        started = {m['name'] for m in report['moves'] if m['started']}
        places = [p.get_actor_label() for p in pilot_run._run.pilot.places]
        self.assertNotIn('PlayerStart_3', places, 'a place out of reach is never a goal')
        self.assertTrue(started & {'meet', 'explore', 'shoot'}, report['moves'])


class ShooterControls(PilotCase):
    """What a fight needs: whether the player sees an enemy, strafing, and several controllers at once."""

    def controls(self):
        from genex_play.pilot_game import Game
        return Game()

    def drive(self, gen, frames: int = 400):
        for _ in range(frames):
            try:
                next(gen)
            except StopIteration as stop:
                return stop.value
            self.frame()
        self.fail('the controller never ended')

    def test_sees_an_enemy_only_with_nothing_blocking_the_sight_line(self) -> None:
        enemy = Prop('Enemy_1', Vector(1000, 0, 100))
        unreal.state['actors'].append(enemy)
        game = self.controls()
        self.assertTrue(game.visible('Enemy_1'))
        crate = Prop('Crate', Vector(500, 0, 100))
        unreal.state['sight_blockers'] = [Blocker((450, -50, 550, 50), crate)]
        self.assertFalse(game.visible(enemy))
        unreal.state['sight_blockers'] = [Blocker((450, -50, 550, 50), enemy)]
        self.assertTrue(game.visible(enemy), 'a hit on the enemy itself is seeing it')
        self.assertIsNone(game.visible('Nobody'))

    def test_sight_is_from_the_camera_so_a_wall_beside_the_body_still_hides_an_enemy(self) -> None:
        enemy = Prop('Enemy_1', Vector(1000, 0, 100))
        unreal.state['actors'].append(enemy)
        unreal.state['camera'] = unreal.PlayerCameraManager(Vector(0, -200, 170), unreal.Rotator(0, 0, 90))
        wall = Prop('Wall', Vector(500, -150, 100))
        unreal.state['sight_blockers'] = [Blocker((450, -250, 550, -60), wall)]
        game = self.controls()
        self.assertFalse(game.visible(enemy), 'the line from the body slips past the wall; the camera\'s does not')
        unreal.state['camera'] = unreal.PlayerCameraManager(Vector(0, 0, 170), unreal.Rotator(0, 0, 90))
        self.assertTrue(game.visible(enemy))

    def test_a_wall_that_lets_the_sight_channel_through_still_hides_an_enemy(self) -> None:
        enemy = Prop('Enemy_1', Vector(1000, 0, 100))
        unreal.state['actors'].append(enemy)
        door = Blocker((450, -100, 550, 100), Prop('Door', Vector(500, 0, 100)))
        door.sight = False
        unreal.state['sight_blockers'] = [door]
        self.assertFalse(self.controls().visible(enemy), 'a door set to ignore the sight channel still stops bullets')

    def test_the_players_own_gun_never_hides_an_enemy(self) -> None:
        enemy = Prop('Enemy_1', Vector(1000, 0, 100))
        gun = Prop('FP_Rifle', Vector(40, 0, 150))
        self.hero.attached = [gun]
        unreal.state['actors'] += [enemy, gun]
        unreal.state['sight_blockers'] = [Blocker((20, -30, 60, 30), gun)]
        self.assertTrue(self.controls().visible(enemy), 'a gun the player holds is not a wall')

    def test_strafes_by_the_move_action_and_lets_go_when_done_or_stopped(self) -> None:
        game = self.controls()
        start_y = self.hero.location.y
        gen = game.strafe(1.0, 0.5)
        next(gen)
        self.assertEqual(self.world.actions.get('IA_Move'), 'X=1 Y=0')
        self.drive(gen)
        self.assertNotIn('IA_Move', self.world.actions)
        self.assertNotEqual(self.hero.location.y, start_y, 'the player moved sideways')
        stopped = game.strafe(-1.0, 5.0)
        next(stopped)
        self.assertEqual(self.world.actions.get('IA_Move'), 'X=-1 Y=0')
        stopped.close()
        self.assertNotIn('IA_Move', self.world.actions, 'a stopped strafe lets go')

    def test_together_steps_controllers_in_the_same_frames_and_answers_each_result(self) -> None:
        unreal.state['keys'].add('LeftMouseButton')
        game = self.controls()
        gen = game.together(game.strafe(1.0, 0.3), game.hold('LeftMouseButton', 0.6))
        next(gen)
        self.assertIn('IA_Move', self.world.actions)
        self.assertIn('LeftMouseButton', self.world.keys)
        results = self.drive(gen)
        self.assertEqual(results, [None, None])
        self.assertNotIn('LeftMouseButton', self.world.keys)
        early = game.together(game.strafe(1.0, 5.0), game.hold('LeftMouseButton', 5.0))
        next(early)
        early.close()
        self.assertNotIn('IA_Move', self.world.actions)
        self.assertNotIn('LeftMouseButton', self.world.keys, 'stopping it stops every controller')

    def test_reads_a_property_by_its_cpp_spelling_too(self) -> None:
        from genex_play.pilot_game import python_name
        for cpp, python in (('Health', 'health'), ('bDead', 'dead'), ('MaxHP', 'max_hp'), ('ammo', 'ammo'),
                            ('CurrentHP', 'current_hp'), ('b', 'b'), ('bad', 'bad')):
            with self.subTest(cpp=cpp):
                self.assertEqual(python_name(cpp), python)
        class Bot(Prop):
            """An actor whose missing property raises, as Unreal's does."""

            def get_editor_property(self, name):
                if name not in self.props:
                    raise ValueError(f'no property {name}')
                return self.props[name]

        bot = Bot('Bot_1', Vector(500, 0, 100))
        bot.props.update(health=80.0, dead=False)
        unreal.state['actors'].append(bot)
        game = self.controls()
        self.assertEqual(game.read('Bot_1', 'Health'), 80.0)
        self.assertIs(game.read('Bot_1', 'bDead'), False)
        self.assertEqual(game.read('Bot_1', 'Nothing', 7), 7)

    def test_shoots_raising_sights_and_firing_in_bursts_only_once_the_view_is_on_the_target(self) -> None:
        unreal.state['keys'] |= {'LeftMouseButton', 'RightMouseButton'}
        enemy = Prop('Enemy_1', Vector(1000, 0, 164))
        unreal.state['actors'].append(enemy)
        game = self.controls()
        gen = game.shoot(enemy, 2.0)
        next(gen)
        self.assertNotIn('RightMouseButton', self.world.keys, 'sights come up only once on target')
        self.assertNotIn('LeftMouseButton', self.world.keys, 'no shot while the view is 90 degrees off')
        fired_while_off, sights_seen = [], False
        result = None
        for _ in range(200):
            off = abs(game.bearing(enemy))
            if 'LeftMouseButton' in self.world.keys:
                fired_while_off.append(off)
            sights_seen = sights_seen or 'RightMouseButton' in self.world.keys
            try:
                next(gen)
            except StopIteration as stop:
                result = stop.value
                break
            self.frame()
        self.assertTrue(fired_while_off, 'it fired once on target')
        self.assertTrue(sights_seen, 'down the sights once on target')
        self.assertLess(max(fired_while_off), 6.0, 'never fired far off the target')
        self.assertGreater(result['fired'], 0.3)
        self.assertGreater(result['onTarget'], 0.3)
        self.assertNotIn('RightMouseButton', self.world.keys)
        self.assertNotIn('LeftMouseButton', self.world.keys)

    def test_stops_shooting_once_the_target_goes_behind_a_wall(self) -> None:
        unreal.state['keys'] |= {'LeftMouseButton', 'RightMouseButton'}
        enemy = Prop('Enemy_1', Vector(1000, 0, 164))
        unreal.state['actors'].append(enemy)
        game = self.controls()
        gen = game.shoot(enemy, 10.0)
        self.drive_frames(gen, 60)
        unreal.state['sight_blockers'] = [Blocker((450, -100, 550, 100), Prop('Wall', Vector(500, 0, 100)))]
        result = self.drive(gen, 120)
        self.assertTrue(result['lost'], 'it stopped because the enemy went out of sight')
        self.assertNotIn('LeftMouseButton', self.world.keys, 'and let go of the trigger')

    def drive_frames(self, gen, frames: int) -> None:
        for _ in range(frames):
            next(gen)
            self.frame()

    def test_aim_follows_through_a_change_in_how_far_the_mouse_turns_the_view(self) -> None:
        enemy = Prop('Enemy_1', Vector(1000, 0, 164))
        unreal.state['actors'].append(enemy)
        game = self.controls()
        gen = game.aim(enemy, 8.0)
        off_after = []
        for frame in range(140):
            next(gen)
            if frame == 20:
                self.world.yaw_per_px = 0.05  # down the sights: the mouse turns the view a tenth as far
            enemy.location = Vector(1000, frame * 8.0, 164)
            enemy.components = [unreal.CapsuleComponent(location=enemy.location)]
            self.frame()
            if frame >= 60:
                off_after.append(abs(game.bearing(enemy)))
        self.assertLess(max(off_after), 5.0, 'the view keeps up with a strafing target through the slower mouse')
        gen.close()

    def test_aim_keeps_the_view_on_a_moving_actor(self) -> None:
        enemy = Prop('Enemy_1', Vector(1000, 0, 164))
        unreal.state['actors'].append(enemy)
        game = self.controls()
        gen = game.aim(enemy, 4.0)
        for frame in range(80):
            next(gen)
            enemy.location = Vector(1000, frame * 4.0, 164)
            enemy.components = [unreal.CapsuleComponent(location=enemy.location)]
            self.frame()
        self.assertLess(abs(game.bearing(enemy)), 10.0, 'the view followed it')
        gen.close()
        self.frames(2)  # a forced mouse is stilled for a frame before it is let go
        self.assertNotIn('Mouse2D', self.world.keys, 'the mouse is let go')


if __name__ == '__main__':
    import unittest

    unittest.main()
