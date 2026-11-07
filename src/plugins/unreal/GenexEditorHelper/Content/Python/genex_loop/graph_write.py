"""Blueprint graph writes Genex can trust, through Epic's BlueprintTools.write_graph_dsl.

Epic's writer can answer ok while the graph it built lost most of its text: on UE 5.8 a function
whose first statement was an early (if ... (return)) kept two of its nodes, and was saved that way
before anyone looked. So each write Genex makes or watches is read back (read_graph_dsl) and
compared with its text, and a write that came back short fails, naming what is missing:

- nodes are counted on both sides: calls, operators, branches, switches and loops. Variable reads
  are left out on both sides: the read-back spells each one as a node, the text often as a bare
  name. So is a component access such as (.x v), which Unreal may share between uses.
- a node the text calls by name that doesn't come back under that name (its last part, so a call
  spelled CallFunction|Foo or Class|BP|Foo is the same node) is missing, except math, flow
  control, arrays and strings, which the read-back may spell as operators and statements.
- the write came back short when something is missing and the read-back holds fewer nodes, or
  when it holds under KEPT_SHARE of them and at least MIN_LOST fewer: Unreal may spell a few
  nodes another way (a break node as a component access, two equal pure calls as one), never most.

A read-back that can't be taken or read leaves the write as Unreal answered it: the check only
ever fails a write it could compare.

One graph's text that makes more than MAX_NODES nodes is refused before Unreal gets it (a Loop
part's, which holds all its events, only is read back): writes
that big took minutes each, grew the editor to about 29 GB and crashed it three times in one
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
WORD_END = frozenset(' \t\n\r;")')
SPACE = frozenset(' \t\n\r')

MESSAGE = {
    'too_big': ('{graph}: this text makes about {nodes} nodes, more than the {limit} one write takes: Unreal '
                'takes minutes over writes this big, grows by gigabytes and can crash. Split it into small '
                'helper functions (fn ...) of a few dozen nodes each, write each to its own graph, and write '
                'only the ones you changed.'),
    'lost': ('{graph}: Unreal answered ok, but reading the graph back found {kept} of the {wrote} nodes the text '
             'makes{missing}. The graph now holds only what Unreal kept: don\'t save it like this. readBack shows '
             'what it kept; write the lost part another way or split it into smaller functions, then write it '
             'again.'),
    'missing': '; missing {names}',
    'not_graph': 'graph must be a Blueprint graph\'s path, such as /Game/BP_Door.BP_Door:EventGraph.',
}


class GraphWriteLost(RuntimeError):
    """A write Unreal answered ok that came back short, or one refused as too big; `facts` says how."""

    def __init__(self, message: str, **facts: object) -> None:
        super().__init__(message)
        self.message = message
        self.facts = facts


class GraphText(typing.NamedTuple):
    """What a graph's text makes: its nodes (variable reads left out) and the nodes it names, by last part."""
    nodes: int
    named: dict


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


def _visit(form, found: dict, counts: list) -> None:
    if not isinstance(form, list) or not form:
        return
    head = _word(form[0])
    if '|' in head:
        title = head.rsplit('|', 1)[-1].lower()
        if not _is_getter(head):
            counts[0] += 1
            found.setdefault(title, head)
    elif head in OPERATORS or head in NODE_STATEMENTS:
        counts[0] += 1
    start = _skipped(form) if head in STATEMENTS else 1
    for item in form[start:]:
        _visit(item, found, counts)


def read_text(text: str) -> GraphText:
    """What a graph's text makes; ValueError when it can't be read."""
    found, counts = {}, [0]
    for form in forms(text):
        _visit(form, found, counts)
    return GraphText(counts[0], found)


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


def size_problem(text: str, graph: str) -> str | None:
    """Why one write of `text` is refused for its size, or None (also for text this can't read:
    Unreal's own parser names what is wrong with it)."""
    try:
        nodes = read_text(text).nodes
    except ValueError:
        return None
    if nodes <= MAX_NODES:
        return None
    return MESSAGE['too_big'].format(graph=graph, nodes=nodes, limit=MAX_NODES)


def loss_message(graph: str, lost: dict) -> str:
    """The words for a write that came back short."""
    shown = lost['missing'][:MISSING_SHOWN]
    more = len(lost['missing']) - len(shown)
    names = ', '.join(shown) + (f' and {more} more' if more > 0 else '')
    missing = MESSAGE['missing'].format(names=names) if shown else ''
    return MESSAGE['lost'].format(graph=graph, kept=lost['kept'], wrote=lost['wrote'], missing=missing)


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


def check_size(graph, code: str) -> None:
    """Raises GraphWriteLost for a text too big for one write; nothing reaches Unreal."""
    name = graph_name(graph)
    problem = size_problem(code, name)
    if problem:
        raise GraphWriteLost(problem, graph=name, refused=True)


def check_written(graph, code: str) -> dict:
    """Reads a written graph back and compares it with its text: {nodes, kept}, GraphWriteLost, or
    {} when it can't (Epic's reader failed, or either text can't be read here)."""
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
        raise GraphWriteLost(loss_message(name, lost), graph=name, readBack=read_back[:READ_BACK_CHARS], **lost)
    return {'nodes': read_text(code).nodes, 'kept': read_text(read_back).nodes}


def write(graph, code: str, send=None, limit: bool = True):
    """Writes Blueprint text into a graph with Epic's write_graph_dsl (or `send`, the caller's own
    call of it), refusing a text too big for one write (unless not `limit`) and failing one that
    came back short (GraphWriteLost); Epic's answer otherwise."""
    if limit:
        check_size(graph, code)
    answer = send() if send else epic_tools().write_graph_dsl(graph, code)
    check_written(graph, code)
    return answer


def check_graph(path: str, code: str, written: bool) -> dict:
    """The check_graph tool: before a write (`written` false) whether `code` fits one write,
    {graph, nodes}; after it, whether the graph at `path` holds what `code` makes, {graph, nodes,
    kept}. Refused with the words and facts of what is wrong."""
    graph = find_graph(path)
    try:
        if not written:
            check_size(graph, code)
            return {'graph': path, 'nodes': read_text(code).nodes}
        return {'graph': path, **check_written(graph, code)}
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


def failure(watch: Watch) -> dict:
    """A run's answer for the writes that failed: {error, graphs}, or {}."""
    if not watch.failed:
        return {}
    return {'error': watch.failed[0]['error'], 'graphs': watch.failed}
