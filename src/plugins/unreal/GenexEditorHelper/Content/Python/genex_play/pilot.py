"""Runs a pilot (genex_play.pilot_kit) in the play session: every frame on the game clock, its
running move steps; every 1/look_hz game seconds it looks, checks its outcome and stages, and offers
its moves; at decision points a move is picked.

Picks: started with decide, a decision point puts an ask out (the state the decider reads, the moves
by name with what each does) and the host hands it to the fast decision model, answering through
step(); the answer's probabilities pick, a running move giving way only when it can_stop and the
pick leads it by stop_lead (or is urgent). Started without decide, or while an ask goes
unanswered, the first move offered wins; a running move then gives way only to an urgent move listed
before it. While an ask is out and nothing runs, the first move starts after IDLE_WAIT_S as a
stand-in, so no frame is idle: the answer, when it comes, replaces it without the margin. An ask
unanswered after ASK_LATE_S is dropped. One move offered and nothing running starts it at once.

A run ends done or failed by the pilot's outcome; stalled when no stage was done and no move worked
for stall_seconds, or one stage took stage_seconds; timed-out at its seconds (or 4x them plus 10 s of
wall clock when the game clock stalls); stopped by the host or the play ending; broken when its file,
its setup or every look fails. Its report says how, what each move did, the plan, the last facts and
the last lines of what happened.
"""

import collections
import inspect
import json
import math
import os
import statistics
import sys
import time
import traceback
import types

import unreal

from genex_loop.errors import Refused, short_message
from genex_loop.paths import is_own_path, is_regular_file
from genex_play import detect, play
from genex_play.pilot_game import Game
from genex_play.pilot_kit import Move, Outcome, Pilot, Stage

DEFAULT_INSTRUCTIONS = (
    'You play a video game toward `goal`. Pick the move that serves it best right now. `situation` is '
    'what is true in the game now and `moves.<name>` are facts about each move. `doing` is the move under '
    'way: keep it unless another is clearly better now. `recent` lists the last moves and how each went: '
    'do not keep picking one that keeps failing in the same situation. `plan`, when present, lists the '
    "goal's stages in order: serve `plan.now`, and never redo a stage in `plan.done`."
)
MIN_SECONDS, MAX_SECONDS = 1.0, 300.0
# An ask unanswered this long (wall seconds) is decided by the pilot's order; with nothing running,
# the first move starts after IDLE_WAIT_S of waiting.
ASK_LATE_S = 2.0
IDLE_WAIT_S = 0.3
# Looks that fail this many times in a row end the run as broken.
MAX_LOOK_ERRORS = 20
# A move that fails within QUICK_FAIL_S of starting this many times in a row rests COOLDOWN_S.
QUICK_FAIL_S = 0.5
QUICK_FAILS = 2
COOLDOWN_S = 3.0
TIMELINE_KEPT = 40
# The run report shows this many of the last reflexes.
REFLEXES_SHOWN = 8
# Every pick is logged (who picked, what, with which probabilities) up to this many, for the run's film.
DECISIONS_KEPT = 1200
ERRORS_KEPT = 8
MOVE_NAME_CHARS = 64


class PilotOutcome:
    DONE, FAILED, STALLED, TIMED_OUT, STOPPED, BROKEN = 'done', 'failed', 'stalled', 'timed-out', 'stopped', 'broken'


class Phase:
    PILOTING, OVER = 'piloting', 'over'


class Decision:
    """A logged pick: what it did and who made it."""
    START, KEEP, SWITCH = 'start', 'keep', 'switch'
    BY_JEV, BY_ORDER = 'jev', 'order'


class Result:
    WORKED, FAILED, UNCLEAR, STOPPED = 'worked', 'failed', 'unclear', 'stopped'


_run = None


def _project_dir() -> str:
    return os.path.realpath(os.path.normpath(unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_dir())))


def _plain(file: object) -> bool:
    """Whether a pilot is named as a .py path whose folder and file names hold no NUL and no '..'. The
    names are split at / and, on Windows, at \\ too; elsewhere a \\ is never part of a pilot's name."""
    if not isinstance(file, str) or not file.endswith('.py') or '\0' in file:
        return False
    names = file.replace(os.path.sep, '/').split('/')
    return '..' not in names and not any('\\' in name for name in names)


def pilot_file(file: object) -> str:
    """The real path of a pilot file: given relative to the project (Pilots/<name>.py), or by its real
    absolute path (Genex hands over one in the game folder, pilots/<name>.py); else Refused."""
    if not _plain(file):
        raise Refused('A pilot is a .py file, such as pilots/gate.py in the game folder.', file=file)
    path = os.path.normpath(file if os.path.isabs(file) else os.path.join(_project_dir(), file))
    if not is_own_path(path):
        raise Refused('The pilot file leads through a link; give its own path in the project.', file=file)
    if not is_regular_file(path):
        raise Refused(f'There is no pilot file at {file} in the project.', file=file)
    return path


def _load(path: str) -> Pilot:
    """The last Pilot subclass the file defines, made; ValueError when it defines none. The file is
    compiled from its source each time, so no bytecode cache is left beside it in the project."""
    name = f'genex_pilot_{abs(hash((path, os.path.getmtime(path))))}'
    module = types.ModuleType(name)
    module.__file__ = path
    sys.modules[name] = module
    with open(path, encoding='utf-8') as source:
        exec(compile(source.read(), path, 'exec'), module.__dict__)  # noqa: S102 - the project's own pilot, run as the editor runs its scripts
    found = [c for c in vars(module).values()
             if inspect.isclass(c) and issubclass(c, Pilot) and c is not Pilot and c.__module__ == name]
    if not found:
        raise ValueError(f'{os.path.basename(path)} defines no Pilot subclass.')
    return found[-1]()


def _where(error: BaseException) -> str:
    """Where in the pilot's own file an error rose: its line, else nothing."""
    frames = [f for f in traceback.extract_tb(error.__traceback__) if 'genex_play' not in f.filename]
    return f' (line {frames[-1].lineno})' if frames else ''


def _finite(value, fallback: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return number if math.isfinite(number) else fallback


class Running:
    """The move under way: its generator, when it started, the view it started on."""

    def __init__(self, move: Move, gen, view: dict, started: float, why: str) -> None:
        self.move, self.gen, self.view, self.started, self.why = move, gen, view, started, why


class Run:
    """One pilot's run in the play session."""

    def __init__(self, pilot: Pilot, name: str, seconds: float, decide: bool) -> None:
        self.pilot, self.name, self.with_decider = pilot, name, decide
        self.game = Game()
        now = play.game_seconds()
        self.started, self.until = now, now + seconds
        self.wall_until = play.wall_clock() + play.wall_cap(seconds)
        self.phase, self.report_ = Phase.PILOTING, None
        self.view, self.facts, self.offered, self.offered_names = None, {}, [], None
        self.last_look, self.look_errors, self.fresh_look = -math.inf, 0, True
        self.running, self.recent = None, collections.deque(maxlen=max(1, int(pilot.recent_kept)))
        self.ask, self.ask_id, self.ask_wall, self.last_decision = None, 0, 0.0, -math.inf
        # The move started by order while the ask out was waiting: its answer replaces it without the margin.
        self.stand_in: str | None = None
        self.asked = self.answered = self.by_order = 0
        self.stages = [s for s in (pilot.stages or []) if isinstance(s, Stage)]
        self.stage_done: dict[str, float] = {}
        self.stage_since, self.progress_at = now, now
        self.mismatched: set[str] = set()
        self.tally = collections.defaultdict(lambda: {'started': 0, 'worked': 0, 'failed': 0, 'seconds': []})
        self.quick_fails = collections.Counter()
        self.resting: dict[str, float] = {}
        self.timeline = collections.deque(maxlen=TIMELINE_KEPT)
        self.decisions: list[dict] = []
        self.epoch0 = time.time()
        self.run_id = _new_run_id(int(self.epoch0), name)
        self.film_file: str | None = None
        detect.ensure()
        self.detect_mark = detect.mark()
        self.does: dict[str, str] = {}
        self.errors: list[str] = []

    # -- what happened -------------------------------------------------------------------------

    def note(self, now: float, text: str) -> None:
        self.timeline.append(f'{now - self.started:.1f} s {text}')

    def decided(self, now: float, kind: str, move: str, by: str, probabilities: dict | None = None,
                ms: float | None = None) -> None:
        """Logs one pick: start, keep or switch, the move, who picked (jev or order), and the decider's odds."""
        if len(self.decisions) >= DECISIONS_KEPT:
            return
        row = {'t': round(now - self.started, 2), 'w': round(time.time() - self.epoch0, 2), 'kind': kind, 'move': move, 'by': by,
               'facts': {k: v for k, v in _jsonable(self.facts).items() if isinstance(v, (int, float, str, bool))}}
        if probabilities:
            row['p'] = {name: round(value, 2) for name, value in probabilities.items()}
        if ms is not None:
            row['ms'] = round(_finite(ms, 0.0))
        self.decisions.append(row)

    def error(self, where: str, error: BaseException) -> None:
        text = f'{where}{_where(error)}: {type(error).__name__}: {short_message(error)}'
        if text not in self.errors and len(self.errors) < ERRORS_KEPT:
            self.errors.append(text)

    # -- looking ----------------------------------------------------------------------------------

    def look(self, now: float) -> bool:
        """Reads the game, checks the outcome and the plan, and offers the moves; False once the run is over."""
        try:
            view = self.pilot.look(self.game)
            if not isinstance(view, dict):
                raise TypeError('look must answer a dict')
            outcome = self.pilot.outcome(view)
            moves = [m for m in (self.pilot.moves(view) or []) if isinstance(m, Move)]
        except Exception as error:  # noqa: BLE001 - the pilot's own code
            self.look_errors += 1
            self.error('look', error)
            if self.look_errors >= MAX_LOOK_ERRORS:
                self.finish(now, PilotOutcome.BROKEN, f'its look kept failing: {short_message(error)}')
                return False
            return True
        self.look_errors, self.view, self.last_look, self.fresh_look = 0, view, now, False
        self.facts = self._facts(view)
        self._advance(view, now)
        if isinstance(outcome, Outcome) and outcome.over:
            state = PilotOutcome.DONE if outcome.state == Outcome.DONE else PilotOutcome.FAILED
            self.finish(now, state, outcome.note, outcome.evidence)
            return False
        self.offered = self._offer([m for m in moves if self.resting.get(m.name, -math.inf) <= now])
        return self._watch_stall(now)

    def _facts(self, view: dict) -> dict:
        try:
            return dict(self.pilot.facts(view))
        except Exception as error:  # noqa: BLE001 - the pilot's own code
            self.error('facts', error)
            return {k: v for k, v in view.items() if not str(k).startswith('_')}

    def _advance(self, view: dict, now: float) -> None:
        """Marks each stage done once its done() holds; the current stage is the first not done."""
        for stage in self.stages:
            if stage.name in self.stage_done:
                continue
            try:
                done = bool(stage.done(view))
            except Exception as error:  # noqa: BLE001 - the pilot's own code
                self.error(f'stage {stage.name}', error)
                done = False
            if not done:
                return
            self.stage_done[stage.name] = now
            self.stage_since = self.progress_at = now
            self.note(now, f'stage {stage.name} done')

    def stage(self) -> Stage | None:
        return next((s for s in self.stages if s.name not in self.stage_done), None)

    def _offer(self, moves: list) -> list:
        """The moves the current stage offers (and urgent ones); every move when none of its own is on offer."""
        stage = self.stage()
        if stage is None or stage.moves is None:
            return moves
        named = [m for m in moves if m.name in stage.moves or m.urgent]
        if any(m.name in stage.moves for m in named):
            return named
        own_running = self.running is not None and self.running.move.name in stage.moves
        if moves and not own_running and stage.name not in self.mismatched:
            self.mismatched.add(stage.name)
            self.note(self.last_look, f'stage {stage.name} offers none of its moves: every move is offered')
        return moves

    def _watch_stall(self, now: float) -> bool:
        stall = _finite(self.pilot.stall_seconds, 0.0)
        long_stage = _finite(self.pilot.stage_seconds, 0.0)
        if stall > 0 and now - self.progress_at >= stall:
            self.finish(now, PilotOutcome.STALLED, f'no stage done and no move worked for {stall:g} game seconds')
            return False
        stage = self.stage()
        if stage is not None and long_stage > 0 and now - self.stage_since >= long_stage:
            self.finish(now, PilotOutcome.STALLED, f'stage {stage.name} took {long_stage:g} game seconds')
            return False
        return True

    # -- deciding -------------------------------------------------------------------------------

    def _names(self) -> list:
        return [m.name for m in self.offered]

    def _decision_due(self, now: float) -> bool:
        hz = _finite(self.pilot.decide_hz, 0.0)
        changed = self._names() != self.offered_names
        cadence = hz > 0 and now - self.last_decision >= 1.0 / hz
        return self.running is None or changed or cadence

    def decide(self, now: float) -> None:
        """At a decision point: start the only move, ask the decider, or pick by the pilot's order."""
        if not self.offered or not self._decision_due(now):
            self._settle_late_ask(now)
            return
        self.offered_names = self._names()
        self.last_decision = now
        if len(self.offered) == 1 and self.running is None:
            self.by_order += 1
            self.decided(now, Decision.START, self.offered[0].name, Decision.BY_ORDER)
            self.start(self.offered[0], now, 'the only move')
            return
        if self.with_decider and len(self._candidates()) >= 2:
            if self.ask is None:
                self._put_ask(now)
            self._settle_late_ask(now)
            return
        self.pick_by_order(now)

    def _candidates(self) -> list:
        """The moves a pick chooses between: those offered, and the running one while it runs."""
        names = self._names()
        running = self.running.move if self.running and self.running.move.name not in names else None
        return self.offered + ([running] if running else [])

    def _settle_late_ask(self, now: float) -> None:
        """An ask waiting with nothing running starts the first move as a stand-in; one waiting too long is dropped."""
        if self.ask is None:
            return
        waited = play.wall_clock() - self.ask_wall
        if waited >= ASK_LATE_S:
            self.ask, self.stand_in = None, None
            self.pick_by_order(now)
        elif self.running is None and waited >= IDLE_WAIT_S and self.pick_by_order(now):
            self.stand_in = self.running.move.name if self.running else None

    def pick_by_order(self, now: float) -> bool:
        """The first move offered: started when nothing runs; while one runs, only an urgent move listed
        before it. Whether it started one."""
        if not self.offered:
            return False
        first = self.offered[0]
        if self.running is None:
            self.by_order += 1
            self.decided(now, Decision.START, first.name, Decision.BY_ORDER)
            self.start(first, now, 'first by order')
            return True
        if first.name == self.running.move.name or not self.running.move.can_stop:
            return False
        names = self._names()
        before = self.running.move.name not in names or names.index(first.name) < names.index(self.running.move.name)
        if not (first.urgent and before):
            return False
        self.by_order += 1
        self.decided(now, Decision.SWITCH, first.name, Decision.BY_ORDER)
        self.stop_running(now, f'switched to {first.name}')
        self.start(first, now, 'urgent, first by order')
        return True

    def _put_ask(self, now: float) -> None:
        candidates = self._candidates()
        self.ask_id += 1
        self.asked += 1
        self.ask_wall = play.wall_clock()
        doing = None
        if self.running is not None:
            doing = {'move': self.running.move.name, 'for_seconds': round(now - self.running.started, 1)}
        state = {'goal': self.pilot.goal, 'situation': _jsonable(self.facts),
                 'moves': {m.name: _jsonable(m.facts) for m in candidates}, 'doing': doing,
                 'recent': list(self.recent)}
        if self.stages:
            state['plan'] = self._plan_facts(now)
        try:
            questions = dict(self.pilot.questions(self.view) or {})
        except Exception as error:  # noqa: BLE001 - the pilot's own code
            self.error('questions', error)
            questions = {}
        self.ask = {'id': self.ask_id, 'state': state, 'moves': {m.name: m.does for m in candidates},
                    'instructions': self.pilot.instructions or DEFAULT_INSTRUCTIONS,
                    'questions': _jsonable(questions)}

    def _plan_facts(self, now: float) -> dict:
        stage = self.stage()
        facts = {'done': [s.name for s in self.stages if s.name in self.stage_done],
                 'next': [s.what for s in self.stages if s.name not in self.stage_done][1:]}
        if stage is not None:
            facts['now'] = {'stage': stage.name, 'what': stage.what, 'for_seconds': round(now - self.stage_since, 1)}
        return facts

    def answer(self, given: dict, now: float) -> str:
        """Applies the decider's answer to the ask out; what it did: started, kept, switched, kept-running or stale."""
        if self.ask is None or given.get('id') != self.ask['id']:
            return 'stale'
        stand_in, self.ask, self.stand_in = self.stand_in, None, None
        self.answered += 1
        try:
            self.pilot.heard(dict(given.get('answers') or {}), self.view)
        except Exception as error:  # noqa: BLE001 - the pilot's own code
            self.error('heard', error)
        by_name = {m.name: m for m in self._candidates()}
        probabilities = {k: _finite(v, 0.0) for k, v in dict(given.get('probabilities') or {}).items() if k in by_name}
        if not probabilities:
            self.pick_by_order(now)
            return 'by-order'
        chosen = max(probabilities, key=probabilities.get)
        p = probabilities[chosen]
        ms = given.get('ms')
        if self.running is None:
            self.decided(now, Decision.START, chosen, Decision.BY_JEV, probabilities, ms)
            self.start(by_name[chosen], now, f'picked (p {p:.2f})')
            return 'started'
        current = self.running.move
        if chosen == current.name:
            self.decided(now, Decision.KEEP, chosen, Decision.BY_JEV, probabilities, ms)
            return 'kept'
        lead = p - probabilities.get(current.name, 0.0)
        # A stand-in started only while this answer was on its way: the answer takes its place.
        replaces = current.name == stand_in or lead >= _finite(self.pilot.stop_lead, 0.2)
        if current.can_stop and (by_name[chosen].urgent or replaces):
            self.decided(now, Decision.SWITCH, chosen, Decision.BY_JEV, probabilities, ms)
            self.stop_running(now, f'switched to {chosen}')
            self.start(by_name[chosen], now, f'picked over {current.name} (p {p:.2f})')
            return 'switched'
        self.decided(now, Decision.KEEP, current.name, Decision.BY_JEV, probabilities, ms)
        return 'kept-running'

    # -- moving ---------------------------------------------------------------------------------

    def start(self, move: Move, now: float, why: str) -> None:
        try:
            gen = move.run(self.game, self.view)
        except Exception as error:  # noqa: BLE001 - the pilot's own code
            self.error(f'move {move.name}', error)
            self._ended(move, now, now, Result.FAILED, f'it raised {type(error).__name__}', self.view)
            return
        self.tally[move.name]['started'] += 1
        self.does.setdefault(move.name, str(move.does)[:120])
        self.note(now, f'start {move.name}: {why}')
        if not inspect.isgenerator(gen):
            self._ended(move, now, now, _result_of(gen)[0], _result_of(gen)[1], self.view)
            return
        self.running = Running(move, gen, self.view, now, why)

    def stop_running(self, now: float, why: str) -> None:
        running, self.running = self.running, None
        if running is None:
            return
        try:
            running.gen.close()  # its controllers let go of what they pressed
        except Exception as error:  # noqa: BLE001 - the pilot's own code
            self.error(f'move {running.move.name}', error)
        self._ended(running.move, running.started, now, Result.STOPPED, why, running.view)

    def step_move(self, now: float) -> None:
        running = self.running
        if running is None:
            return
        if now - running.started >= _finite(running.move.seconds, 20.0):
            self.stop_running(now, f'ran out of its {running.move.seconds:g} s')
            self.tally[running.move.name]['failed'] += 1
            return
        try:
            next(running.gen)
            return
        except StopIteration as stop:
            result, why = _result_of(stop.value)
        except Exception as error:  # noqa: BLE001 - the pilot's own code
            self.error(f'move {running.move.name}', error)
            result, why = Result.FAILED, f'it raised {type(error).__name__}'
        self.running = None
        self.fresh_look = True  # the next decision waits for a look taken after the move ended
        self._ended(running.move, running.started, now, result, why, running.view)

    def _ended(self, move: Move, started: float, now: float, result: str, why: str, before: dict) -> None:
        if result != Result.STOPPED and move.worked is not None and self.view is not None:
            try:
                judged = move.worked(before or {}, self.view)
                if judged is not None:
                    result = Result.WORKED if judged else Result.FAILED
            except Exception as error:  # noqa: BLE001 - the pilot's own code
                self.error(f'worked {move.name}', error)
        tally = self.tally[move.name]
        tally['seconds'].append(now - started)
        if result == Result.WORKED:
            tally['worked'] += 1
            self.progress_at = now
            self.quick_fails[move.name] = 0
        elif result == Result.FAILED:
            tally['failed'] += 1
            self._rest_if_quick(move, now - started, now)
        self.recent.append({'move': move.name, 'result': result, **({'why': why} if why else {}),
                            'seconds': round(now - started, 1)})
        self.note(now, f'{move.name} {result}' + (f': {why}' if why else ''))

    def _rest_if_quick(self, move: Move, ran: float, now: float) -> None:
        if ran > QUICK_FAIL_S:
            self.quick_fails[move.name] = 0
            return
        self.quick_fails[move.name] += 1
        if self.quick_fails[move.name] >= QUICK_FAILS:
            self.quick_fails[move.name] = 0
            self.resting[move.name] = now + COOLDOWN_S
            self.note(now, f'{move.name} rests {COOLDOWN_S:g} s: it failed at once {QUICK_FAILS} times')

    # -- the frame --------------------------------------------------------------------------------

    def frame(self, now: float, wall: float) -> bool:
        """One frame of the run; False once it is over."""
        if self.phase == Phase.OVER:
            return False
        if now >= self.until or wall >= self.wall_until:
            self.finish(now, PilotOutcome.TIMED_OUT, f'its {self.until - self.started:g} game seconds ran out')
            return False
        due = self.fresh_look or now - self.last_look >= 1.0 / max(0.5, _finite(self.pilot.look_hz, 10.0))
        if due and not self.look(now):
            return False
        self._reflex()
        if self.view is not None and not self.fresh_look:
            self.decide(now)
        self.step_move(now)
        return self.phase != Phase.OVER

    def _reflex(self) -> None:
        try:
            self.pilot.reflex(self.game)
        except Exception as error:  # noqa: BLE001 - the pilot's own code
            self.error('reflex', error)

    def finish(self, now: float, outcome: str, note: str, evidence: dict | None = None) -> None:
        if self.phase == Phase.OVER:
            return
        if self.running is not None:
            self.stop_running(now, f'the run ended: {outcome}')
        self.phase, self.ask = Phase.OVER, None
        self.note(now, f'over: {outcome}' + (f' ({note})' if note else ''))
        try:
            self.pilot.teardown(self.game)
        except Exception as error:  # noqa: BLE001 - the pilot's own code
            self.error('teardown', error)
        self.report_ = {'outcome': outcome, 'note': note, 'evidence': _jsonable(evidence or {}),
                        'gameSeconds': round(max(0.0, now - self.started), 1)}
        self._save_film()

    def _save_film(self) -> None:
        """Keeps the run's film log in <project>/Saved/Genex/pilots/, for a film of the play beside its picks."""
        try:
            folder = os.path.join(_project_dir(), 'Saved', 'Genex', 'pilots')
            os.makedirs(folder, exist_ok=True)
            path = os.path.join(folder, f'{self.run_id}.json')
            self.film_file = path
            with open(path, 'w', encoding='utf-8') as out:
                json.dump(dict(self.film_log(), epoch0=self.epoch0), out)
        except OSError as error:
            self.error('film log', error)

    def report(self) -> dict:
        base = dict(self.report_ or {'outcome': PilotOutcome.STOPPED, 'note': 'still running', 'evidence': {},
                                     'gameSeconds': None})
        moves = [{'name': name, 'started': t['started'], 'worked': t['worked'], 'failed': t['failed'],
                  'medianSeconds': round(statistics.median(t['seconds']), 1) if t['seconds'] else None}
                 for name, t in self.tally.items()]
        stages = [{'name': s.name, 'done': s.name in self.stage_done,
                   'atSeconds': round(self.stage_done[s.name] - self.started, 1) if s.name in self.stage_done else None}
                  for s in self.stages]
        base.update({'pilot': self.name, 'stages': stages, 'moves': moves, 'asked': self.asked,
                     'answered': self.answered, 'byOrder': self.by_order, 'facts': _jsonable(self.facts),
                     'timeline': list(self.timeline), 'errors': list(self.errors),
                     'reflexes': {'count': len(self.game.reflexes), 'last': self.game.reflexes[-REFLEXES_SHOWN:]},
                     'runId': self.run_id, 'findings': detect.since(self.detect_mark), 'film': self.film_file})
        return base

    def film_log(self) -> dict:
        """Everything a film of the run shows beside the play: each pick and each reflex, on the run's clock."""
        return {'pilot': self.name, 'goal': self.pilot.goal, 'decisions': list(self.decisions), 'does': dict(self.does),
                'outcome': (self.report_ or {}).get('outcome'), 'note': (self.report_ or {}).get('note'),
                'reflexes': [dict(r, t=round(r['t'] - self.started, 2)) for r in self.game.reflexes]}

_run_ids: set[str] = set()


def _new_run_id(second: int, name: str) -> str:
    """A run's id, its start second and pilot: a second later for each run of that pilot already started in it."""
    while f'{second}-{name}' in _run_ids:
        second += 1
    _run_ids.add(f'{second}-{name}')
    return f'{second}-{name}'


def _result_of(value) -> tuple:
    """(result, why) from what a move's run returned: True, False, None, or (that, 'why')."""
    why = ''
    if isinstance(value, tuple) and len(value) == 2:
        value, why = value[0], str(value[1])
    if value is None:
        return Result.UNCLEAR, why
    return (Result.WORKED if value else Result.FAILED), why


def _jsonable(value, depth: int = 0):
    """value made JSON-safe: actors and vectors as text, floats rounded, deep nests cut."""
    if depth > 8:
        return str(value)
    if isinstance(value, dict):
        return {str(k): _jsonable(v, depth + 1) for k, v in value.items() if not str(k).startswith('_')}
    if isinstance(value, (list, tuple, set)):
        return [_jsonable(v, depth + 1) for v in value]
    if isinstance(value, bool) or value is None or isinstance(value, (int, str)):
        return value
    if isinstance(value, float):
        return round(value, 3) if math.isfinite(value) else None
    return str(value)


# -- the toolset's side ----------------------------------------------------------------------------


def _stopped() -> None:
    """The play ended (or every input was let go): the run stops."""
    if _run is not None and _run.phase == Phase.PILOTING:
        try:
            now = play.game_seconds()
        except RuntimeError:  # the play session is gone
            now = _run.last_look if math.isfinite(_run.last_look) else _run.started
        _run.finish(now, PilotOutcome.STOPPED, 'the play ended')


def _frame(game_now: float, wall_now: float) -> bool:
    run = _run
    if run is None:
        return False
    try:
        return run.frame(game_now, wall_now)
    except Exception as error:  # noqa: BLE001 - never let the play's tick fall over
        run.error('the run', error)
        run.finish(game_now, PilotOutcome.BROKEN, f'the run fell over: {short_message(error)}')
        return False


def start(file: str, seconds: float, decide: bool) -> dict:
    """Starts the pilot in the project's file for `seconds` of game time; a running one stops first."""
    global _run
    path = pilot_file(file)
    span = min(MAX_SECONDS, max(MIN_SECONDS, _finite(seconds, 60.0)))
    play.player_pawn()
    if _run is not None and _run.phase == Phase.PILOTING:
        _run.finish(play.game_seconds(), PilotOutcome.STOPPED, 'a new pilot started')
    try:
        pilot = _load(path)
    except Exception as error:  # noqa: BLE001 - the pilot's own file
        return {'error': f'{file}{_where(error)}: {type(error).__name__}: {short_message(error)}'}
    run = Run(pilot, type(pilot).__name__, span, bool(decide))
    try:
        pilot.setup(run.game)
    except Exception as error:  # noqa: BLE001 - the pilot's own code
        run.error('setup', error)
        run.finish(run.started, PilotOutcome.BROKEN, f'its setup failed: {short_message(error)}')
    _run = run
    if run.phase == Phase.PILOTING:
        play.watch(_frame, _stopped)
    return {'piloting': run.phase == Phase.PILOTING, 'pilot': run.name, 'seconds': span, 'decide': run.with_decider,
            'stages': [s.name for s in run.stages]}


def step(answer: str = '', stop: bool = False) -> dict:
    """Hands the running pilot its answer (JSON {id, probabilities, answers, ms}) or stops it; how it stands."""
    run = _run
    if run is None:
        return {'phase': Phase.OVER, 'report': {'outcome': PilotOutcome.BROKEN, 'note': 'no pilot ran in this play'}}
    now = play.game_seconds() if run.phase == Phase.PILOTING else run.started
    applied = None
    if stop:
        run.finish(now, PilotOutcome.STOPPED, 'stopped by Genex')
    elif answer and run.phase == Phase.PILOTING:
        try:
            given = json.loads(answer)
        except ValueError:
            given = None
        applied = run.answer(given, now) if isinstance(given, dict) else 'malformed'
    if run.phase == Phase.OVER:
        return {'phase': Phase.OVER, 'report': run.report(), 'byOrder': run.by_order}
    running = run.running.move.name if run.running else None
    stage = run.stage()
    return {'phase': Phase.PILOTING, 'ask': run.ask, 'applied': applied, 'byOrder': run.by_order,
            'running': running, 'stage': stage.name if stage else None,
            'gameSeconds': round(now - run.started, 1)}
