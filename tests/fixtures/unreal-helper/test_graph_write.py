"""Blueprint graph writes Genex can trust (genex_loop.graph_write). Epic's write_graph_dsl can answer
ok and keep only part of the text: every write Genex makes or watches is read back and compared,
so one that came back short fails, naming what is missing, and one too big for a single write is
refused before Unreal gets it. A read-back that spells the same graph another way (variable reads
as nodes, an early return as an else, math as an operator, a call by another prefix) is no loss.
Build scripts' own writes are watched the same way, and their run fails even when the script
caught the error; the check_graph tool refuses anything that isn't a graph's path."""

import json
import os
import sys

import unreal

from editor_toolset.toolsets.blueprint import BlueprintTools
from genex_build.tools import GenexBuildTools
from genex_loop import graph_write

from support import HelperCase

GRAPH = '/Game/Duel/Blueprints/BPC_Duel.BPC_Duel:CombatTick'

# The write that dropped nodes on UE 5.8 (an early return first), and what Unreal kept of it.
COMBAT_TICK = """(fn CombatTick (DT)
 (if (or (not (Utilities|IsValid Opp)) (not (Utilities|IsValid Sword)))
  (return))
 (CallFunction|TickCommon :DT DT)
 (if IsAI (CallFunction|AITick :DT DT) (else (CallFunction|PollInput)))
 (CallFunction|Stance)
 (bind _state State)
 (if (== _state 1) (CallFunction|TickAttack :DT DT) (else (CallFunction|TickOther :DT DT))))
"""
KEPT = """(fn CombatTick (DT)
 (Utilities|IsValid (Variables|Default|GetOpp)))
"""
# The same graph as Unreal reads it back whole: variable reads as nodes, the early return as an else.
RESTRUCTURED = """(fn CombatTick (DT)
 (if (or (not (Utilities|IsValid (Variables|Default|GetOpp))) (not (Utilities|IsValid (Variables|Default|GetSword))))
  (return)
  (else
   (CallFunction|TickCommon :DT DT)
   (if (Variables|Default|GetIsAI) (CallFunction|AITick :DT DT) (else (CallFunction|PollInput)))
   (CallFunction|Stance)
   (bind _state (Variables|Default|GetState))
   (if (== _state 1) (CallFunction|TickAttack :DT DT) (else (CallFunction|TickOther :DT DT))))))
"""


def tool(name: str, *args) -> dict:
    return json.loads(getattr(GenexBuildTools, name)(*args))


def calls(count: int) -> str:
    """A function whose text makes `count` nodes."""
    body = '\n'.join(f' (Development|PrintString :InString "{i}")' for i in range(count))
    return f'(fn Big ()\n{body})\n'


class Compares(HelperCase):
    def test_a_read_back_that_kept_part_of_the_text_is_a_loss_naming_the_missing_nodes(self) -> None:
        lost = graph_write.loss(COMBAT_TICK, KEPT)
        self.assertEqual(lost['wrote'], 15)
        self.assertEqual(lost['kept'], 1)
        self.assertEqual(lost['missing'], ['CallFunction|AITick', 'CallFunction|PollInput', 'CallFunction|Stance',
                                           'CallFunction|TickAttack', 'CallFunction|TickCommon',
                                           'CallFunction|TickOther'])

    def test_a_read_back_that_spells_the_same_graph_another_way_is_no_loss(self) -> None:
        same = [
            ('variable reads as nodes, the early return as an else', COMBAT_TICK, RESTRUCTURED),
            ('math as an operator', '(fn F (A) (return (Math|Float|Add_DoubleDouble A 1.0)))',
             '(fn F (A) (return (+ A 1.0)))'),
            ('a switch by its alias', '(fn F (N) (Utilities|FlowControl|Switch|SwitchonInt N (:0 (CallFunction|G))))',
             '(fn F (N) (switch int N (:0 (CallFunction|G))))'),
            ('a call by another prefix', '(fn F () (Class|BPCDuel|TickCommon))', '(fn F () (CallFunction|TickCommon))'),
            ('names in any case', '(fn F () (Utilities|Time|GetGameTimeinSeconds))',
             '(fn F () (Utilities|Time|GetGameTimeInSeconds))'),
            ('a conversion Unreal added', '(fn F (I) (Development|PrintString :InString I))',
             '(fn F (I) (Development|PrintString :InString (Utilities|String|Conv_IntToString I)))'),
            ('comments and strings with parentheses', '(fn F () ; (CallFunction|Gone)\n (Development|PrintString "(x)"))',
             '(fn F () (Development|PrintString "(x)"))'),
            ('an event with its parameters', '(event EventTick (DeltaSeconds) (CallFunction|Tick :DT DeltaSeconds))',
             '(event EventTick (DeltaSeconds) (CallFunction|Tick :DT DeltaSeconds))'),
            ('a function read back without its empty parameters', '(fn F () (CallFunction|A) (CallFunction|B))',
             '(fn F (CallFunction|A) (CallFunction|B))'),
            ('an array loop as a statement', '(fn F (L) (Utilities|Array|ForEachLoop L (CallFunction|G)))',
             '(fn F (L) (for x L (CallFunction|G)))'),
            ('a break node as a component access, of many',
             '(fn F (V) (CallFunction|A (Math|Vector|BreakVector V)) (CallFunction|B) (CallFunction|C))',
             '(fn F (V) (CallFunction|A (.x V)) (CallFunction|B) (CallFunction|C))'),
            ('two equal pure calls shared', '(fn F () (CallFunction|A (Game|GetPawn)) (CallFunction|B (Game|GetPawn)))',
             '(fn F () (bind p (Game|GetPawn)) (CallFunction|A p) (CallFunction|B p))'),
        ]
        for name, written, read_back in same:
            with self.subTest(name):
                self.assertIsNone(graph_write.loss(written, read_back))

    def test_one_dropped_call_is_a_loss_though_variable_reads_came_back_as_nodes(self) -> None:
        written = '(fn F () (bind st State) (CallFunction|Hit :S st) (CallFunction|Die))'
        read_back = '(fn F () (bind st (Variables|Default|GetState)) (CallFunction|Hit :S st))'
        self.assertEqual(graph_write.loss(written, read_back), {'wrote': 2, 'kept': 1, 'missing': ['CallFunction|Die']})

    def test_fewer_math_nodes_than_written_is_a_loss(self) -> None:
        lost = graph_write.loss('(fn F (A) (return (* (+ A 1.0) 2.0)))', '(fn F (A) (return A))')
        self.assertEqual((lost['wrote'], lost['kept'], lost['missing']), (2, 0, []))

    def test_a_text_too_big_for_one_write_is_refused_by_its_node_count(self) -> None:
        self.assertIsNone(graph_write.size_problem(calls(graph_write.MAX_NODES), GRAPH))
        problem = graph_write.size_problem(calls(graph_write.MAX_NODES + 1), GRAPH)
        self.assertIn(f'about {graph_write.MAX_NODES + 1} nodes', problem)
        self.assertIn('helper functions', problem)
        self.assertIsNone(graph_write.size_problem('(fn F () (unclosed', GRAPH), "Unreal's own parser names that")


class Writes(HelperCase):
    def setUp(self) -> None:
        super().setUp()
        self.graph = unreal.EdGraph(GRAPH)
        unreal.state['graphs'] = {GRAPH: self.graph}

    def test_a_write_that_came_back_short_fails_with_what_unreal_kept(self) -> None:
        unreal.state['kept'] = {GRAPH: KEPT}
        with self.assertRaises(graph_write.GraphWriteLost) as raised:
            graph_write.write(self.graph, COMBAT_TICK)
        self.assertIn('found 1 of the 15 nodes', raised.exception.message)
        self.assertIn("don't save it", raised.exception.message)
        self.assertIn('CallFunction|TickCommon', raised.exception.message)
        self.assertEqual(raised.exception.facts['readBack'], KEPT)

    def test_a_write_that_came_back_whole_answers_as_epic_did(self) -> None:
        unreal.state['kept'] = {GRAPH: RESTRUCTURED}
        self.assertIsNone(graph_write.write(self.graph, COMBAT_TICK))
        self.assertEqual(unreal.state['written'][GRAPH], COMBAT_TICK)

    def test_a_read_back_that_fails_leaves_the_write_as_epic_answered(self) -> None:
        unreal.state['read_fails'] = "read_graph_dsl can't spell node K2Node_X"
        self.assertIsNone(graph_write.write(self.graph, COMBAT_TICK))
        self.assertEqual(unreal.state['written'][GRAPH], COMBAT_TICK)

    def test_a_loop_part_s_write_is_read_back_but_never_refused_for_its_size(self) -> None:
        text = calls(graph_write.MAX_NODES + 1)
        self.assertIsNone(graph_write.write(self.graph, text, limit=False))
        unreal.state['kept'] = {GRAPH: KEPT}
        with self.assertRaises(graph_write.GraphWriteLost):
            graph_write.write(self.graph, text, limit=False)

    def test_a_text_too_big_never_reaches_unreal(self) -> None:
        with self.assertRaises(graph_write.GraphWriteLost) as raised:
            graph_write.write(self.graph, calls(graph_write.MAX_NODES + 1))
        self.assertTrue(raised.exception.facts['refused'])
        self.assertNotIn(('write_graph_dsl', GRAPH), unreal.calls)


class BuildScripts(HelperCase):
    """A build script writing a graph itself, through Epic's BlueprintTools."""

    SCRIPT = ('from editor_toolset.toolsets.blueprint import BlueprintTools as BT\n'
              'graph = unreal.find_object(None, args["graph"])\n'
              'try:\n'
              '    BT.write_graph_dsl(graph, args["code"])\n'
              '    result = "ok"\n'
              'except Exception as error:\n'
              '    result = str(error)\n')

    def setUp(self) -> None:
        super().setUp()
        self.build = self.path('game', 'unreal', 'build')
        unreal.state['graphs'] = {GRAPH: unreal.EdGraph(GRAPH)}
        self.write(os.path.join(self.build, 'apply_dsl.py'), self.SCRIPT)

    def run_with(self, code: str) -> dict:
        return tool('run_script', 'apply_dsl.py', json.dumps({'graph': GRAPH, 'code': code}))

    def test_a_short_write_fails_the_run_though_the_script_caught_it(self) -> None:
        unreal.state['kept'] = {GRAPH: KEPT}
        answer = self.run_with(COMBAT_TICK)
        self.assertFalse(answer['ok'])
        self.assertIn('found 1 of the 15 nodes', answer['error'])
        [graph] = answer['graphs']
        self.assertEqual((graph['graph'], graph['wrote'], graph['kept']), (GRAPH, 15, 1))
        self.assertIn('CallFunction|Stance', graph['missing'])

    def test_a_whole_write_runs_as_before_and_epic_s_tools_come_back_after_the_run(self) -> None:
        answer = self.run_with(COMBAT_TICK)
        self.assertTrue(answer['ok'], answer)
        self.assertEqual(answer['result'], 'ok')
        self.assertNotIn('graphs', answer)
        module = sys.modules['editor_toolset.toolsets.blueprint']
        self.assertIs(module.BlueprintTools, BlueprintTools)

    def test_a_text_too_big_is_refused_inside_the_script_and_fails_the_run(self) -> None:
        answer = self.run_with(calls(graph_write.MAX_NODES + 1))
        self.assertFalse(answer['ok'])
        self.assertTrue(answer['graphs'][0]['refused'])
        self.assertNotIn(('write_graph_dsl', GRAPH), unreal.calls)

    def test_a_call_the_check_can_t_read_goes_to_epic_as_the_script_made_it(self) -> None:
        self.write(os.path.join(self.build, 'apply_dsl.py'), self.SCRIPT.replace(
            'BT.write_graph_dsl(graph, args["code"])', 'BT.write_graph_dsl(graph=graph, text=args["code"])'))
        answer = self.run_with(COMBAT_TICK)
        self.assertIn('text', answer['result'], "Epic's own refusal of the wrong keyword")
        self.assertNotIn(GRAPH, unreal.state.get('written', {}), 'nothing was written in its place')
        self.assertNotIn('graphs', answer)

    def test_the_script_s_own_error_stays_the_run_s_error(self) -> None:
        unreal.state['kept'] = {GRAPH: KEPT}
        self.write(os.path.join(self.build, 'apply_dsl.py'), self.SCRIPT.replace('    result = str(error)\n',
                                                                                 '    raise ValueError("mine")\n'))
        answer = self.run_with(COMBAT_TICK)
        self.assertIn('ValueError: mine', answer['error'])
        self.assertEqual(len(answer['graphs']), 1)


class CheckGraph(HelperCase):
    def setUp(self) -> None:
        super().setUp()
        unreal.state['graphs'] = {GRAPH: unreal.EdGraph(GRAPH)}
        unreal.state['written'] = {GRAPH: COMBAT_TICK}

    def test_anything_but_a_graph_s_path_is_refused_and_nothing_is_read(self) -> None:
        for path in ('', 'CombatTick', '../../etc/passwd', 'C:\\Game\\BP.BP:Graph', '/Game/BP_Door.BP_Door',
                     '/Game/Missing.Missing:EventGraph', 42):
            with self.subTest(path=path):
                self.fresh()
                answer = tool('check_graph', path, COMBAT_TICK, True)
                self.assertIn('error', answer)
                self.assertNotIn('read_graph_dsl', [call[0] for call in unreal.calls])

    def test_before_a_write_it_counts_the_text_and_refuses_one_too_big(self) -> None:
        self.assertEqual(tool('check_graph', GRAPH, COMBAT_TICK, False), {'graph': GRAPH, 'nodes': 15})
        refused = tool('check_graph', GRAPH, calls(graph_write.MAX_NODES + 1), False)
        self.assertTrue(refused['refused'])
        self.assertIn('helper functions', refused['error'])
        self.assertNotIn('read_graph_dsl', [call[0] for call in unreal.calls])

    def test_a_read_back_that_fails_is_no_verdict(self) -> None:
        unreal.state['read_fails'] = "read_graph_dsl can't spell node K2Node_X"
        self.assertEqual(tool('check_graph', GRAPH, COMBAT_TICK, True), {'graph': GRAPH})

    def test_after_a_write_it_names_what_came_back_short(self) -> None:
        self.assertEqual(tool('check_graph', GRAPH, COMBAT_TICK, True), {'graph': GRAPH, 'nodes': 15, 'kept': 15})
        unreal.state['kept'] = {GRAPH: KEPT}
        lost = tool('check_graph', GRAPH, COMBAT_TICK, True)
        self.assertEqual((lost['wrote'], lost['kept']), (15, 1))
        self.assertIn('CallFunction|TickOther', lost['missing'])
        self.assertIn("don't save it", lost['error'])
