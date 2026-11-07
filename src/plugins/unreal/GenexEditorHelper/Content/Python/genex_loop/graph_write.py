"""Blueprint graph writes Genex can trust, through Epic's BlueprintTools.write_graph_dsl.

Epic's writer can answer ok while the graph it built lost most of its text: on UE 5.8 a function
that began (if (or (not (Utilities|IsValid ...)) ...) (return)) kept one of its fifteen nodes, and
was saved that way before anyone looked. Epic makes Utilities|IsValid its exec macro, which has no
value and no "then": it took the exec wire, and the nodes after it were made but never linked. So a
text with an IsValid that has none of its exec pins is refused before Unreal gets it, and each write
Genex makes or watches is read back (read_graph_dsl) and compared with its text, and a write that
came back short fails, naming what is missing:

- nodes are counted on both sides: calls, operators, branches, switches and loops. Variable reads
  are left out on both sides: the read-back spells each one as a node, the text often as a bare
  name. So are a component access such as (.x v), which Unreal may share between uses, and a break
  node (Math|Vector|BreakVector), which it reads back as component accesses. An input action's
  event (Input|EnhancedActionEvents|IA_Jump) is left out with everything it runs: the read-back
  shows it with an empty body.
- a node the text calls by name that doesn't come back under that name (its last part, so a call
  spelled CallFunction|Foo or Class|BP|Foo is the same node) is missing, except math, flow
  control, arrays and strings, which the read-back may spell as operators and statements.
- the write came back short when something is missing and the read-back holds fewer nodes, or
  when it holds under KEPT_SHARE of them and at least MIN_LOST fewer: Unreal may spell a few
  nodes another way (a break node as a component access, two equal pure calls as one), never most.

A read-back that can't be taken or read leaves the write as Unreal answered it: the check only
ever fails a write it could compare.

After each write the nodes nothing runs are deleted (clear_unlinked): Epic's writer deletes only
old nodes nothing links to, so every old node that takes the function's or event's parameter (DT,
DeltaSeconds) stayed through each rewrite, three identical writes leaving 7, 13 and 19 nodes, as
did each old result node, and the nodes a lost write made stay unlinked too. read_graph_dsl never
shows them. Only the classes the text writer makes (DELETABLE) are deleted, and only when no exec
flow from an event, an entry or a node of any other class (a timeline, which its component or Auto
Play runs) reaches them and they feed no node it does; a function keeps the result nodes its flow
reaches, or one, and a graph nothing starts (an animation graph) keeps every node. find_nodes
doesn't list comments, so they always stay.

One graph's text that makes more than MAX_NODES nodes is refused before Unreal gets it (a Loop
part's, which holds all its events, only is read back): writes that big took minutes each, grew the editor to about 29 GB and crashed it three times in one
evening, and splitting the graph into small functions ended it.

The text is read with Epic's own rules (blueprint-text.ts follows them too): `;` comments, quoted
strings with \\" and \\\\ escapes, `:"Quoted Pin"` keywords, and a `(` inside a word taking its
balanced group with it (`Equal(==)`), which also ends the word.

During a build script (run_script), `watching()` puts a stand-in for BlueprintTools in Epic's
module, so the script's own write_graph_dsl calls are checked too; every write that lost nodes or
was too big is kept, so the run fails even when the script caught the error.
"""

import contextlib
import functools
import sys
import typing

from genex_loop.errors import Refused

# The most nodes one graph's text may make (variable reads not counted).
MAX_NODES = 150
# A read-back with nothing missing came back short when it holds under this share of the text's
# nodes, at least this many fewer.
KEPT_SHARE = 0.75
MIN_LOST = 2
# How much of a short read-back an answer shows, and how many missing names it lists.
READ_BACK_CHARS = 600
MISSING_SHOWN = 12
EPIC_MODULE = 'editor_toolset.toolsets.blueprint'
EPIC_CLASS = 'BlueprintTools'
# The real class, kept on the stand-in so Genex's own writes never check twice.
EPIC_ATTR = '_genex_epic'

# The text's own words: statements.
STATEMENTS = frozenset({'event', 'fn', 'bind', 'return', 'if', 'elif', 'else', 'for', 'range', 'while',
                        'break', 'switch'})
# The statements that make a node (a branch, a switch, a loop), which the read-back may spell by its name.
NODE_STATEMENTS = frozenset({'if', 'elif', 'switch', 'for', 'while'})
# Operators, each a node; the read-back may spell a math node this way.
OPERATORS = frozenset({'+', '-', '*', '/', '%', 'xor', '==', '!=', '<', '<=', '>', '>=', 'and', 'or',
                       'not', 'neg', 'select'})
# Categories whose nodes the read-back may spell as an operator or a statement.
RESPELLED = ('math|', 'utilities|flowcontrol|', 'utilities|operators|', 'utilities|array|', 'utilities|string|')
VARIABLES = 'variables|'
GETTER = 'get'
# A math struct's break node (Math|Vector|BreakVector), which the read-back spells as component accesses
# (on UE 5.8 a vector's, rotator's and transform's; BreakHitResult and a user struct's come back by name).
BREAK = 'break'
BREAK_CATEGORY = 'math|'
# Epic's IsValid exec macro: written with none of its exec pins (:"Is Valid" ...), Unreal links nothing after it.
EXEC_MACRO = 'utilities|isvalid'
PIN = ':'
# The macro's exec outputs, as a keyword names them (case and spaces aside).
EXEC_MACRO_PINS = frozenset({'isvalid', 'isnotvalid'})
# An input action's event: the read-back shows it with an empty body, so nothing in it is compared.
INPUT_EVENT = 'input|enhancedactionevents|'
# A pin of the exec flow, as get_node_infos lists its type.
EXEC_PIN = 'Exec'
# The node classes Epic's text writer makes that are deleted once nothing runs them. Any other class (an
# event, a function's entry, a timeline, which runs from its component or Auto Play, a collapsed graph) is
# never deleted and keeps what it runs and what feeds it.
DELETABLE = frozenset({
    # Calls, flow control and values.
    'K2Node_CallFunction', 'K2Node_CallArrayFunction', 'K2Node_CallParentFunction', 'K2Node_CallFunctionOnMember',
    'K2Node_CallDataTableFunction', 'K2Node_Message', 'K2Node_IfThenElse', 'K2Node_ExecutionSequence',
    'K2Node_MacroInstance', 'K2Node_MultiGate', 'K2Node_DoOnceMultiInput', 'K2Node_PromotableOperator',
    'K2Node_CommutativeAssociativeBinaryOperator', 'K2Node_MathExpression', 'K2Node_EaseFunction',
    'K2Node_VariableGet', 'K2Node_VariableSet', 'K2Node_TemporaryVariable', 'K2Node_AssignmentStatement',
    'K2Node_Knot', 'K2Node_Select', 'K2Node_SwitchInteger', 'K2Node_SwitchString', 'K2Node_SwitchName',
    'K2Node_SwitchEnum', 'K2Node_Self', 'K2Node_Literal', 'K2Node_EnumLiteral', 'K2Node_EnumEquality',
    'K2Node_EnumInequality', 'K2Node_CastByteToEnum', 'K2Node_GetEnumeratorName',
    'K2Node_GetEnumeratorNameAsString', 'K2Node_GetNumEnumEntries', 'K2Node_ForEachElementInEnum',
    # Casts, structs, arrays and text.
    'K2Node_DynamicCast', 'K2Node_ClassDynamicCast', 'K2Node_BreakStruct', 'K2Node_MakeStruct',
    'K2Node_SetFieldsInStruct', 'K2Node_MakeArray', 'K2Node_GetArrayItem', 'K2Node_FormatText',
    # Objects, subsystems, delegates and assets.
    'K2Node_SpawnActorFromClass', 'K2Node_ConstructObjectFromClass', 'K2Node_CreateWidget', 'K2Node_AddComponent',
    'K2Node_GetSubsystem', 'K2Node_GetClassDefaults', 'K2Node_GetDataTableRow', 'K2Node_LoadAsset',
    'K2Node_AsyncAction', 'K2Node_CallDelegate', 'K2Node_AddDelegate', 'K2Node_RemoveDelegate',
    'K2Node_ClearDelegate', 'K2Node_CreateDelegate', 'K2Node_GetInputAxisValue', 'K2Node_GetInputAxisKeyValue',
    'K2Node_GetInputVectorAxisValue',
    'K2Node_FunctionResult'})
# A function's result node: its pins are the function's outputs, so one always stays.
RESULT = 'K2Node_FunctionResult'
WORD_END = frozenset(' \t\n\r;")')
SPACE = frozenset(' \t\n\r')

MESSAGE = {
    'too_big': ('{graph}: this text makes about {nodes} nodes, more than the {limit} one write takes: Unreal '
                'takes minutes over writes this big, grows by gigabytes and can crash. Split it into small '
                'helper functions (fn ...) of a few dozen nodes each, write each to its own graph, and write '
                'only the ones you changed.'),
    'lost': ('{graph}: Unreal answered ok, but reading the graph back found {kept} of the {wrote} nodes the text '
             'makes{missing}: don\'t save it like this. readBack shows what it linked; write the lost part another '
             'way or split it into smaller functions, then write it again.{cleared}'),
    'missing': '; missing {names}',
    'cleared': ' Genex deleted the {cleared} nodes Unreal left unlinked.',
    'exec_macro': ('{graph}: {name} makes Unreal\'s IsValid macro, which has no value and no "then": inside not, '
                   'and, or, a condition or a bind, or as a plain statement, it takes the exec wire and Unreal '
                   'links nothing after it. Write it with its exec pins: ({name} X (:"Is Valid" ...) '
                   '(:"Is Not Valid" ...)).'),
    'not_graph': 'graph must be a Blueprint graph\'s path, such as /Game/BP_Door.BP_Door:EventGraph.',
}


class GraphWriteLost(RuntimeError):
    """A write Unreal answered ok that came back short, or one refused as too big; `facts` says how."""

    def __init__(self, message: str, **facts: object) -> None:
        super().__init__(message)
        self.message = message
        self.facts = facts


class GraphText(typing.NamedTuple):
    """What a graph's text makes: its nodes (variable reads and break nodes left out), the nodes it
    names, by last part, and each IsValid it writes with none of its exec pins."""
    nodes: int
    named: dict
    unpinned: list


# ---------------------------------------------------------------------------
# Reading the text
# ---------------------------------------------------------------------------

def _string_end(text: str, start: int) -> int:
    """Where the string opening at `start` closes; ValueError when it never does."""
    i = start + 1
    while i < len(text) and text[i] != '"':
        i += 2 if text[i] == '\\' else 1
    if i >= len(text):
        raise ValueError('unterminated string literal')
    return i


def _word_end(text: str, start: int) -> int:
    """Where the word at `start` ends: at a separator, or just past a balanced (...) group inside it."""
    i = start
    while i < len(text) and text[i] not in WORD_END:
        if text[i] != '(':
            i += 1
            continue
        depth = 0
        while i < len(text):
            depth += {'(': 1, ')': -1}.get(text[i], 0)
            i += 1
            if depth == 0:
                return i
        return i
    return i


def tokens(text: str) -> list:
    """The text's tokens: '(' and ')', and each word or string as ('word', text) or ('string', text)."""
    found, i = [], 0
    while i < len(text):
        c = text[i]
        if c == ';':
            end = text.find('\n', i)
            i = len(text) if end < 0 else end
        elif c in '()':
            found.append(c)
            i += 1
        elif c == '"':
            end = _string_end(text, i)
            found.append(('string', text[i + 1:end]))
            i = end + 1
        elif c in SPACE:
            i += 1
        else:
            end = _word_end(text, i)
            word = text[i:end]
            if word == ':' and text[end:end + 1] == '"':
                close = _string_end(text, end)
                found.append(('word', ':' + text[end + 1:close]))
                end = close + 1
            else:
                found.append(('word', word))
            i = end
    return found


def forms(text: str) -> list:
    """The text's top-level forms: a list is a Python list, a word or string its token."""
    stack, top = [], []
    for token in tokens(text):
        if token == '(':
            stack.append([])
        elif token == ')':
            if not stack:
                raise ValueError('unexpected )')
            done = stack.pop()
            (stack[-1] if stack else top).append(done)
        else:
            (stack[-1] if stack else top).append(token)
    if stack:
        raise ValueError('unclosed parenthesis')
    return top


def _word(form) -> str:
    return form[1] if isinstance(form, tuple) and form[0] == 'word' else ''


def _is_params(form) -> bool:
    """Whether the list after an entry's name is its parameters: plain names, no type ids, no keywords."""
    return isinstance(form, list) and all(_word(item) and '|' not in _word(item) and _word(item) not in STATEMENTS
                                          and _word(item) not in OPERATORS for item in form)


def _skipped(form: list) -> int:
    """How many items at the head of a statement are names, not code: an entry's name and
    parameters, a bind's target, a loop's variable."""
    head = _word(form[0]) if form else ''
    if head in ('fn', 'event'):
        return 3 if len(form) > 2 and _is_params(form[2]) else 2
    if head in ('bind', 'for'):
        return 2
    return 1


def _is_getter(name: str) -> bool:
    lowered = name.lower()
    return lowered.startswith(VARIABLES) and lowered.rsplit('|', 1)[-1].startswith(GETTER)


def _is_break(name: str) -> bool:
    lowered = name.lower()
    return lowered.startswith(BREAK_CATEGORY) and lowered.rsplit('|', 1)[-1].startswith(BREAK)


def _is_exec_pin(form) -> bool:
    """Whether an item of an IsValid's form names one of its exec pins: (:"Is Valid" ...) or :"Is Not
    Valid" (a data input's keyword, :InputObject, is none)."""
    word = _word(form[0]) if isinstance(form, list) and form else _word(form)
    return word.startswith(PIN) and word[len(PIN):].replace(' ', '').lower() in EXEC_MACRO_PINS


def _visit(form, made: GraphText, counts: list, compared: bool) -> None:
    if not isinstance(form, list) or not form:
        return
    head = _word(form[0])
    if compared and head.lower().startswith(INPUT_EVENT):
        return
    if '|' in head:
        title = head.rsplit('|', 1)[-1].lower()
        if not _is_getter(head) and not (compared and _is_break(head)):
            counts[0] += 1
            made.named.setdefault(title, head)
        if head.lower() == EXEC_MACRO and not any(_is_exec_pin(item) for item in form[1:]):
            made.unpinned.append(head)
    elif head in OPERATORS or head in NODE_STATEMENTS:
        counts[0] += 1
    start = _skipped(form) if head in STATEMENTS else 1
    for item in form[start:]:
        _visit(item, made, counts, compared)


def read_text(text: str, compared: bool = True) -> GraphText:
    """What a graph's text makes; ValueError when it can't be read. As `compared` with a read-back,
    break nodes and input action events (with all they run) are left out, which the read-back
    spells another way or not at all; for the checks before a write, every node counts."""
    made, counts = GraphText(0, {}, []), [0]
    for form in forms(text):
        _visit(form, made, counts, compared)
    return made._replace(nodes=counts[0])


def _respelled(name: str) -> bool:
    return name.lower().startswith(RESPELLED)


def loss(written: str, read_back: str) -> dict | None:
    """How a read-back came back short of the text written, or None when it holds it all:
    {wrote, kept, missing}."""
    wrote, kept = read_text(written), read_text(read_back)
    missing = sorted(name for title, name in wrote.named.items() if title not in kept.named and not _respelled(name))
    fewer = kept.nodes < wrote.nodes
    most_lost = wrote.nodes - kept.nodes >= MIN_LOST and kept.nodes < wrote.nodes * KEPT_SHARE
    if not (missing and fewer) and not most_lost:
        return None
    return {'wrote': wrote.nodes, 'kept': kept.nodes, 'missing': missing}


def text_problem(text: str, graph: str, limit: bool = True) -> str | None:
    """Why one write of `text` is refused before Unreal gets it, or None (also for text this can't
    read: Unreal's own parser names what is wrong with it): an IsValid with none of its exec pins,
    or (when `limit`) more nodes than one write takes."""
    try:
        made = read_text(text, compared=False)
    except ValueError:
        return None
    if made.unpinned:
        return MESSAGE['exec_macro'].format(graph=graph, name=made.unpinned[0])
    if not limit or made.nodes <= MAX_NODES:
        return None
    return MESSAGE['too_big'].format(graph=graph, nodes=made.nodes, limit=MAX_NODES)


def loss_message(graph: str, lost: dict, cleared: int = 0) -> str:
    """The words for a write that came back short, and how many unlinked nodes were deleted after it."""
    shown = lost['missing'][:MISSING_SHOWN]
    more = len(lost['missing']) - len(shown)
    names = ', '.join(shown) + (f' and {more} more' if more > 0 else '')
    missing = MESSAGE['missing'].format(names=names) if shown else ''
    deleted = MESSAGE['cleared'].format(cleared=cleared) if cleared else ''
    return MESSAGE['lost'].format(graph=graph, kept=lost['kept'], wrote=lost['wrote'], missing=missing,
                                  cleared=deleted)


def _is_exec(pin) -> bool:
    return str(pin.type_id) == EXEC_PIN


def _starts(info) -> bool:
    """Whether a node starts an exec flow: an event or a function's entry (exec out, no exec in)."""
    return any(_is_exec(pin) for pin in info.output_pins) and not any(_is_exec(pin) for pin in info.input_pins)


def _linked(pins: list, flow: bool) -> list:
    """The nodes at the other end of the exec (`flow`) or data pins among `pins`."""
    return [linked.node.get_path_name() for pin in pins if _is_exec(pin) == flow for linked in pin.connected_pins]


def _class(info) -> str:
    return str(info.node.get_class().get_name())


def _reached(by_path: dict, todo: list) -> set:
    """The nodes the exec flow from `todo` runs, and every node feeding one of them."""
    live = set()
    while todo:
        path = todo.pop()
        if path in live or path not in by_path:
            continue
        live.add(path)
        info = by_path[path]
        todo += _linked(info.output_pins, True) + _linked(info.input_pins, False)
    return live


def unlinked(infos: list) -> list:
    """The nodes among `infos` (Epic's get_node_infos) that nothing runs: of a DELETABLE class, on
    no exec flow from an event, an entry or a node of another class, and feeding no node that is.
    A function keeps the result nodes its flow reaches, or the last listed (the newest) when it
    reaches none; a graph nothing starts keeps every node."""
    by_path = {info.node.get_path_name(): info for info in infos}
    if not any(_starts(info) for info in by_path.values()):
        return []
    live = _reached(by_path, [path for path, info in by_path.items() if _starts(info) or _class(info) not in DELETABLE])
    results = [path for path, info in by_path.items() if _class(info) == RESULT]
    if results and not live.intersection(results):
        live |= _reached(by_path, results[-1:])
    return [info.node for path, info in by_path.items() if path not in live]


def clear_unlinked(graph) -> int:
    """Deletes the nodes nothing in `graph` runs (unlinked); how many. Any error leaves the rest."""
    cleared = 0
    try:
        tools = epic_tools()
        for node in unlinked(tools.get_node_infos(tools.find_nodes(graph))):
            tools.delete_node(node)
            cleared += 1
    except Exception:  # noqa: BLE001 - a graph that can't be listed or cleaned is left as Unreal wrote it
        return cleared
    return cleared


# ---------------------------------------------------------------------------
# Writing in the editor
# ---------------------------------------------------------------------------

def epic_tools():
    """Epic's own BlueprintTools, never the stand-in a build script sees."""
    from editor_toolset.toolsets.blueprint import BlueprintTools
    return getattr(BlueprintTools, EPIC_ATTR, BlueprintTools)


def graph_name(graph) -> str:
    """A graph's path for an answer, or its name when it has none."""
    try:
        return str(graph.get_path_name())
    except Exception:  # noqa: BLE001 - anything Unreal hands as a graph still gets a name
        return str(graph)


def find_graph(path: str):
    """The Blueprint graph at `path` (/Game/BP_Door.BP_Door:EventGraph), or Refused."""
    import unreal
    if not isinstance(path, str) or not path.startswith('/') or ':' not in path:
        raise Refused(MESSAGE['not_graph'], graph=path)
    graph = unreal.find_object(None, path) or unreal.load_object(None, path)
    if not isinstance(graph, unreal.EdGraph):
        raise Refused(MESSAGE['not_graph'], graph=path)
    return graph


def check_text(graph, code: str, limit: bool = True) -> None:
    """Raises GraphWriteLost for a text refused before the write (text_problem); nothing reaches Unreal."""
    name = graph_name(graph)
    problem = text_problem(code, name, limit)
    if problem:
        raise GraphWriteLost(problem, graph=name, refused=True)


def check_written(graph, code: str, cleared: int = 0) -> dict:
    """Reads a written graph back and compares it with its text: {nodes, kept}, GraphWriteLost
    (naming the `cleared` unlinked nodes deleted after the write), or {} when it can't (Epic's
    reader failed, or either text can't be read here)."""
    name = graph_name(graph)
    try:
        read_back = epic_tools().read_graph_dsl(graph)
        # Outside raising mode a failing Epic tool reports a script error and answers None.
        if not isinstance(read_back, str):
            return {}
        lost = loss(code, read_back)
    except Exception:  # noqa: BLE001 - a check that can't compare leaves the write as Unreal answered it
        return {}
    if lost:
        raise GraphWriteLost(loss_message(name, lost, cleared), graph=name, readBack=read_back[:READ_BACK_CHARS],
                             cleared=cleared, **lost)
    return {'nodes': read_text(code).nodes, 'kept': read_text(read_back).nodes}


def write(graph, code: str, send=None, limit: bool = True):
    """Writes Blueprint text into a graph with Epic's write_graph_dsl (or `send`, the caller's own
    call of it), refusing a text with an unpinned IsValid or too big for one write (unless not
    `limit`) and failing one that came back short (GraphWriteLost), after deleting the nodes it
    left unlinked; Epic's answer otherwise."""
    check_text(graph, code, limit)
    answer = send() if send else epic_tools().write_graph_dsl(graph, code)
    check_written(graph, code, clear_unlinked(graph))
    return answer


def check_graph(path: str, code: str, written: bool) -> dict:
    """The check_graph tool: before a write (`written` false) whether `code` may be sent as one
    write, {graph, nodes}; after it, deletes the nodes the write left unlinked and answers whether
    the graph at `path` holds what `code` makes, {graph, nodes, kept, cleared}. Refused with the
    words and facts of what is wrong."""
    graph = find_graph(path)
    try:
        if not written:
            check_text(graph, code)
            return {'graph': path, 'nodes': read_text(code, compared=False).nodes}
        cleared = clear_unlinked(graph)
        return {'graph': path, **check_written(graph, code, cleared), 'cleared': cleared}
    except GraphWriteLost as lost:
        raise Refused(lost.message, **lost.facts) from None
    except ValueError:
        return {'graph': path}


# ---------------------------------------------------------------------------
# A build script's writes
# ---------------------------------------------------------------------------

class Watch:
    """The graph writes a build script made that lost nodes or were refused, as {graph, error, ...}."""

    def __init__(self) -> None:
        self.failed: list[dict] = []

    def write(self, tools, args: tuple, kwargs: dict):
        """The script's own call, sent as it made it; checked when it names a graph and a text."""
        send = functools.partial(tools.write_graph_dsl, *args, **kwargs)
        graph = args[0] if args else kwargs.get('graph')
        code = args[1] if len(args) > 1 else kwargs.get('code')
        if graph is None or not isinstance(code, str):
            # Epic's own refusal names what is wrong with the call.
            return send()
        try:
            return write(graph, code, send)
        except GraphWriteLost as lost:
            self.failed.append({'error': lost.message, **lost.facts})
            raise


class CheckedTools:
    """Epic's BlueprintTools as a build script sees it: every tool as Epic's, write_graph_dsl checked."""

    def __init__(self, tools, watch: Watch) -> None:
        setattr(self, EPIC_ATTR, tools)
        self._watch = watch

    def __getattr__(self, name: str):
        return getattr(getattr(self, EPIC_ATTR), name)

    def write_graph_dsl(self, *args, **kwargs):
        """Epic's write_graph_dsl, refused when too big and failed when it came back short."""
        return self._watch.write(getattr(self, EPIC_ATTR), args, kwargs)


@contextlib.contextmanager
def watching():
    """While it is open, a script importing Epic's BlueprintTools gets the checked stand-in; the Watch."""
    watch = Watch()
    module = sys.modules.get(EPIC_MODULE)
    if module is None:
        try:
            import editor_toolset.toolsets.blueprint as module
        except Exception:  # noqa: BLE001 - without Epic's toolset there is nothing to watch
            module = None
    epic = getattr(module, EPIC_CLASS, None) if module else None
    if isinstance(epic, CheckedTools):
        # A run inside a run: the outer one's stand-in already checks every write.
        yield epic._watch
        return
    if epic is None:
        yield watch
        return
    setattr(module, EPIC_CLASS, CheckedTools(epic, watch))
    try:
        yield watch
    finally:
        setattr(module, EPIC_CLASS, epic)


def failed_writes(watch: Watch) -> dict:
    """A run's answer for the writes that failed: {error, graphs}, or {}."""
    if not watch.failed:
        return {}
    return {'error': watch.failed[0]['error'], 'graphs': watch.failed}
