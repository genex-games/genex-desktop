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

from editor_toolset.toolsets.blueprint import BlueprintTools, LinkedPin, Node, NodeInfo, Pin
from genex_build.tools import GenexBuildTools
from genex_loop import graph_write

from support import HelperCase

GRAPH = '/Game/Duel/Blueprints/BPC_Duel.BPC_Duel:CombatTick'

# A function Unreal kept one node of, and what it kept. (On UE 5.8 an IsValid used as a value did this
# first; Genex now refuses that before the write: ISVALID_AS_VALUE.)
COMBAT_TICK = """(fn CombatTick (DT)
 (if (or (not (CallFunction|IsAlive Opp)) (not (CallFunction|IsAlive Sword)))
  (return))
 (CallFunction|TickCommon :DT DT)
 (if IsAI (CallFunction|AITick :DT DT) (else (CallFunction|PollInput)))
 (CallFunction|Stance)
 (bind _state State)
 (if (== _state 1) (CallFunction|TickAttack :DT DT) (else (CallFunction|TickOther :DT DT))))
"""
KEPT = """(fn CombatTick (DT)
 (CallFunction|IsAlive (Variables|Default|GetOpp)))
"""
# The same graph as Unreal reads it back whole: variable reads as nodes, the early return as an else.
RESTRUCTURED = """(fn CombatTick (DT)
 (if (or (not (CallFunction|IsAlive (Variables|Default|GetOpp))) (not (CallFunction|IsAlive (Variables|Default|GetSword))))
  (return)
  (else
   (CallFunction|TickCommon :DT DT)
   (if (Variables|Default|GetIsAI) (CallFunction|AITick :DT DT) (else (CallFunction|PollInput)))
   (CallFunction|Stance)
   (bind _state (Variables|Default|GetState))
   (if (== _state 1) (CallFunction|TickAttack :DT DT) (else (CallFunction|TickOther :DT DT))))))
"""
# The UE 5.8 write that came back with one node: Epic makes Utilities|IsValid its exec macro, which has no
# value and no "then", so inside (not ...) it took the exec wire and Unreal linked nothing after it.
ISVALID_AS_VALUE = """(fn CombatTick (DT)
 (if (or (not (Utilities|IsValid (Variables|Default|GetOpp))) (not (Utilities|IsValid (Variables|Default|GetSword))))
  (return))
 (CallFunction|TickCommon :DT DT))
"""
# The same test with the macro's exec pins, which came back whole.
ISVALID_WITH_PINS = """(fn CombatTick (DT)
 (Utilities|IsValid (Variables|Default|GetOpp)
  (:"Is Valid" (CallFunction|TickCommon :DT DT))
  (:"Is Not Valid" (return))))
"""


# A function's graph after Epic rewrote it: its live nodes, and the old ones it left because they take the
# function's parameter (DT), which nothing runs or reads; its result, which no flow reaches here, holds the
# function's outputs and keeps what feeds it. Each name: (class, kind, exec from, data from).
LEFT_OVER = {
    'Entry': ('K2Node_FunctionEntry', 'start', [], []),
    'Tick': ('K2Node_CallFunction', 'step', ['Entry'], ['Entry']),
    'Speed': ('K2Node_CallFunction', 'pure', [], []),
    'Move': ('K2Node_CallFunction', 'step', ['Tick'], ['Speed']),
    'Return': ('K2Node_FunctionResult', 'end', [], ['Total']),
    'Total': ('K2Node_CallFunction', 'pure', [], []),
    'Note': ('EdGraphNode_Comment', 'note', [], []),
    'OldTick': ('K2Node_CallFunction', 'step', [], ['Entry']),
    'OldScale': ('K2Node_CallFunction', 'pure', [], ['Entry']),
    'OldMove': ('K2Node_CallFunction', 'step', ['OldTick'], ['OldScale']),
}
LEFT_OVER_NAMES = [f'{GRAPH}.{name}' for name in ('OldMove', 'OldScale', 'OldTick')]
# A function rewritten twice: the result nodes its flow reaches, and an old one with what fed it.
OLD_RESULTS = {
    'Entry': ('K2Node_FunctionEntry', 'start', [], []),
    'Branch': ('K2Node_IfThenElse', 'step', ['Entry'], ['Entry']),
    'Zero': ('K2Node_FunctionResult', 'end', ['Branch'], []),
    'Double': ('K2Node_FunctionResult', 'end', ['Branch'], ['Times']),
    'Times': ('K2Node_PromotableOperator', 'pure', [], ['Entry']),
    'OldResult': ('K2Node_FunctionResult', 'end', [], ['OldTimes']),
    'OldTimes': ('K2Node_PromotableOperator', 'pure', [], ['Entry']),
}
# An event graph whose timeline runs from its component (nothing wires its Play), a collapsed graph,
# and one old call left taking the event's parameter.
TIMELINE = {
    'Begin': ('K2Node_Event', 'start', [], []),
    'Print': ('K2Node_CallFunction', 'step', ['Begin'], []),
    'Timeline': ('K2Node_Timeline', 'step', [], []),
    'Lerp': ('K2Node_CallFunction', 'pure', [], ['Timeline']),
    'SetLoc': ('K2Node_CallFunction', 'step', ['Timeline'], ['Lerp']),
    'Collapsed': ('K2Node_Composite', 'pure', [], []),
    'OldPrint': ('K2Node_CallFunction', 'step', [], ['Begin']),
}
# A graph no event or entry starts (an animation graph's poses).
POSES = {'Root': ('AnimGraphNode_Root', 'pure', [], ['Blend']), 'Blend': ('AnimGraphNode_BlendSpace', 'pure', [], [])}


def place(graph: str, nodes: dict) -> None:
    """Puts a graph's nodes in the stub editor, as Epic's get_node_infos lists them. A kind is 'start' (an
    event or entry: exec out only), 'step' (exec in and out), 'end' (exec in only), 'pure' (data only) or
    'note' (no pins)."""
    made = {name: Node(f'{graph}.{name}', cls) for name, (cls, *_rest) in nodes.items()}
    infos = []
    for name, (_cls, kind, exec_from, data_from) in nodes.items():
        inputs, outputs = [], []
        if kind in ('step', 'end'):
            inputs.append(Pin('execute', 'Exec', [LinkedPin(made[source]) for source in exec_from]))
        if kind in ('start', 'step'):
            targets = [other for other, spec in nodes.items() if name in spec[2]]
            outputs.append(Pin('then', 'Exec', [LinkedPin(made[target]) for target in targets]))
        if kind != 'note':
            inputs.append(Pin('In', 'Real', [LinkedPin(made[source]) for source in data_from]))
            readers = [other for other, spec in nodes.items() if name in spec[3]]
            outputs.append(Pin('Out', 'Real', [LinkedPin(made[reader]) for reader in readers]))
        infos.append(NodeInfo(made[name], f'Test|{name}', inputs, outputs))
    unreal.state.setdefault('nodes', {})[graph] = infos


def deleted() -> list:
    return sorted(call[1] for call in unreal.calls if call[0] == 'delete_node')


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
            ('two break nodes bound to names, read back as component accesses',
             '(fn F (A B) (bind (ax ay az) (Math|Vector|BreakVector A)) (bind (bx by bz) (Math|Vector|BreakVector B))'
             ' (return (+ (* ax bx) (* ay by))))',
             '(fn F (A B) (return (+ (* (.x A) (.x B)) (* (.y A) (.y B)))))'),
            ('an input action event, whose body the read-back leaves out',
             '(event Custom|Holder (Input|EnhancedActionEvents|IA_Attack (:Triggered (CallFunction|Attack))'
             ' (:Completed (CallFunction|Rest))))',
             '(event Custom|Holder (Input|EnhancedActionEvents|EnhancedInputActionIA_Attack))'),
            ('a math break node of several, as component accesses',
             '(fn F (V) (Math|Rotator|BreakRotator V) (CallFunction|A) (CallFunction|B))',
             '(fn F (V) (CallFunction|A) (CallFunction|B))'),
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

    def test_a_dropped_call_named_break_that_breaks_no_struct_is_a_loss(self) -> None:
        lost = graph_write.loss('(fn F () (Physics|Constraint|BreakConstraint) (CallFunction|A))', '(fn F () (CallFunction|A))')
        self.assertEqual(lost['missing'], ['Physics|Constraint|BreakConstraint'])

    def test_fewer_math_nodes_than_written_is_a_loss(self) -> None:
        lost = graph_write.loss('(fn F (A) (return (* (+ A 1.0) 2.0)))', '(fn F (A) (return A))')
        self.assertEqual((lost['wrote'], lost['kept'], lost['missing']), (2, 0, []))

    def test_a_text_too_big_for_one_write_is_refused_by_its_node_count(self) -> None:
        self.assertIsNone(graph_write.text_problem(calls(graph_write.MAX_NODES), GRAPH))
        problem = graph_write.text_problem(calls(graph_write.MAX_NODES + 1), GRAPH)
        self.assertIn(f'about {graph_write.MAX_NODES + 1} nodes', problem)
        self.assertIn('helper functions', problem)
        self.assertIsNone(graph_write.text_problem(calls(graph_write.MAX_NODES + 1), GRAPH, limit=False))
        self.assertIsNone(graph_write.text_problem('(fn F () (unclosed', GRAPH), "Unreal's own parser names that")

    def test_isvalid_without_its_exec_pins_is_refused_before_the_write(self) -> None:
        for name, text in (('as a value', ISVALID_AS_VALUE),
                           ('as a plain statement', '(fn F (A) (Utilities|IsValid A) (CallFunction|G))'),
                           ('bound to a name', '(fn F (A) (bind ok (Utilities|IsValid A)) (if ok (CallFunction|G)))'),
                           ('its input by name, as a value',
                            '(fn F (A) (if (not (Utilities|IsValid :InputObject A)) (return)) (CallFunction|G))'),
                           ('its input as a group',
                            '(fn F (A) (Utilities|IsValid (:InputObject A)) (CallFunction|G))')):
            with self.subTest(name):
                problem = graph_write.text_problem(text, GRAPH, limit=False)
                self.assertIn('Utilities|IsValid', problem)
                self.assertIn(':"Is Not Valid"', problem)
        self.assertIsNone(graph_write.text_problem(ISVALID_WITH_PINS, GRAPH))
        for pins in (':"Is Valid" (CallFunction|G)', ':IsNotValid (return)', '(:"is not valid" (return))'):
            with self.subTest(pins):
                self.assertIsNone(graph_write.text_problem(f'(fn F (A) (Utilities|IsValid :InputObject A {pins}))', GRAPH))

    def test_an_input_action_event_s_body_is_checked_before_the_write_though_never_compared(self) -> None:
        unpinned = '(event Custom|Holder (Input|EnhancedActionEvents|IA_Fire (:Triggered {})))'
        problem = graph_write.text_problem(unpinned.format('(if (not (Utilities|IsValid X)) (return))'), GRAPH)
        self.assertIn('Utilities|IsValid', problem)
        prints = ' '.join(f'(Development|PrintString "{i}")' for i in range(graph_write.MAX_NODES + 1))
        self.assertIn('helper functions', graph_write.text_problem(unpinned.format(prints), GRAPH))
        self.assertIsNone(graph_write.loss(ISVALID_WITH_PINS, ISVALID_WITH_PINS))


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

    def test_isvalid_as_a_value_never_reaches_unreal_even_in_a_loop_part(self) -> None:
        for limit in (True, False):
            with self.subTest(limit=limit):
                with self.assertRaises(graph_write.GraphWriteLost) as raised:
                    graph_write.write(self.graph, ISVALID_AS_VALUE, limit=limit)
                self.assertTrue(raised.exception.facts['refused'])
                self.assertNotIn(('write_graph_dsl', GRAPH), unreal.calls)
        self.assertIsNone(graph_write.write(self.graph, ISVALID_WITH_PINS))

    def test_the_nodes_no_event_or_entry_reaches_are_deleted_after_a_write(self) -> None:
        place(GRAPH, LEFT_OVER)
        self.assertIsNone(graph_write.write(self.graph, COMBAT_TICK))
        self.assertEqual(deleted(), LEFT_OVER_NAMES)
        kept = sorted(info.node.get_path_name().rsplit('.', 1)[-1] for info in unreal.state['nodes'][GRAPH])
        self.assertEqual(kept, ['Entry', 'Move', 'Note', 'Return', 'Speed', 'Tick', 'Total'])

    def test_a_write_that_came_back_short_says_how_many_unlinked_nodes_it_deleted(self) -> None:
        place(GRAPH, LEFT_OVER)
        unreal.state['kept'] = {GRAPH: KEPT}
        with self.assertRaises(graph_write.GraphWriteLost) as raised:
            graph_write.write(self.graph, COMBAT_TICK)
        self.assertIn('Genex deleted the 3 nodes', raised.exception.message)
        self.assertEqual(raised.exception.facts['cleared'], 3)
        self.assertEqual(deleted(), LEFT_OVER_NAMES)

    def test_a_function_keeps_the_results_its_flow_reaches_and_old_ones_go(self) -> None:
        place(GRAPH, OLD_RESULTS)
        graph_write.write(self.graph, COMBAT_TICK)
        self.assertEqual(deleted(), [f'{GRAPH}.OldResult', f'{GRAPH}.OldTimes'])

    def test_an_old_spawn_and_what_it_kept_alive_go_too(self) -> None:
        place(GRAPH, {'Entry': ('K2Node_FunctionEntry', 'start', [], []),
                      'Spawn': ('K2Node_SpawnActorFromClass', 'step', ['Entry'], ['Where']),
                      'Where': ('K2Node_CallFunction', 'pure', [], ['Entry']),
                      'OldSpawn': ('K2Node_SpawnActorFromClass', 'step', [], ['OldWhere']),
                      'OldWhere': ('K2Node_CallFunction', 'pure', [], ['Entry']),
                      'OldPrint': ('K2Node_CallFunction', 'step', ['OldSpawn'], ['OldSpawn'])})
        graph_write.write(self.graph, COMBAT_TICK)
        self.assertEqual(deleted(), [f'{GRAPH}.{name}' for name in ('OldPrint', 'OldSpawn', 'OldWhere')])

    def test_a_timeline_its_component_runs_and_a_collapsed_graph_keep_what_they_run(self) -> None:
        place(GRAPH, TIMELINE)
        graph_write.write(self.graph, COMBAT_TICK)
        self.assertEqual(deleted(), [f'{GRAPH}.OldPrint'])

    def test_a_graph_nothing_starts_or_one_that_can_t_be_listed_keeps_every_node(self) -> None:
        place(GRAPH, POSES)
        self.assertIsNone(graph_write.write(self.graph, COMBAT_TICK))
        place(GRAPH, LEFT_OVER)
        unreal.state['nodes_fail'] = 'find_nodes failed'
        self.assertIsNone(graph_write.write(self.graph, COMBAT_TICK))
        self.assertEqual(deleted(), [])

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
        place(GRAPH, LEFT_OVER)
        self.assertEqual(tool('check_graph', GRAPH, COMBAT_TICK, False), {'graph': GRAPH, 'nodes': 15})
        self.assertEqual(deleted(), [], 'nothing is written yet')
        refused = tool('check_graph', GRAPH, calls(graph_write.MAX_NODES + 1), False)
        self.assertTrue(refused['refused'])
        self.assertIn('helper functions', refused['error'])
        self.assertTrue(tool('check_graph', GRAPH, ISVALID_AS_VALUE, False)['refused'])
        self.assertNotIn('read_graph_dsl', [call[0] for call in unreal.calls])

    def test_a_read_back_that_fails_is_no_verdict(self) -> None:
        unreal.state['read_fails'] = "read_graph_dsl can't spell node K2Node_X"
        self.assertEqual(tool('check_graph', GRAPH, COMBAT_TICK, True), {'graph': GRAPH, 'cleared': 0})

    def test_after_a_write_it_names_what_came_back_short(self) -> None:
        place(GRAPH, LEFT_OVER)
        self.assertEqual(tool('check_graph', GRAPH, COMBAT_TICK, True),
                         {'graph': GRAPH, 'nodes': 15, 'kept': 15, 'cleared': 3})
        self.assertEqual(deleted(), LEFT_OVER_NAMES)
        unreal.state['kept'] = {GRAPH: KEPT}
        lost = tool('check_graph', GRAPH, COMBAT_TICK, True)
        self.assertEqual((lost['wrote'], lost['kept']), (15, 1))
        self.assertIn('CallFunction|TickOther', lost['missing'])
        self.assertIn("don't save it", lost['error'])
