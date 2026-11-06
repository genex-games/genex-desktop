/**
 * Where the seed fires Genex's moments, and that a game no plugin hooks makes no new call. A chat
 * turn announces its start and end, the worker pool each worker's start and end, and the director
 * its lead's finish. A step's block refuses only the call that asked for its moment (the lead's
 * finish); at a chat turn's or a worker's start or end, what the steps said is a line for whoever
 * reads that moment (the turn's first leg, `worker_start`'s answer, a run's worker end line), and
 * nothing is held back. A game whose descriptor lists no moment (every web game) gets no
 * `hooks.fire` at all.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runDelegatedTurn } from "../../src/harness-seed/loop/delegated-turn.ts";
import { openLoopPool } from "../../src/harness-seed/loop/director/open/setup.ts";
import { HELD_TURN_WAIT_MS, whileTurnHeld } from "../../src/harness-seed/loop/director/turn-hold.ts";
import { openStartHeld, turnsHeldWords as directorTurnsHeld } from "../../src/harness-seed/loop/director/held-words.ts";
import { NoteKind } from "../../src/harness-seed/loop/director/wake-schedule.ts";
import {
  endOfTurnCheckpoint,
  fireHooks,
  HookEvent,
  HookHold,
  notesText,
  pendingLine,
  takeCheckpoint,
  turnHeldLine,
  waitReady,
} from "../../src/harness-seed/loop/hooks.ts";
import { momentLines } from "../../src/harness-seed/loop/moment-lines.ts";
import { closeRunPool } from "../../src/harness-seed/loop/workers/run-pool.ts";
import { HOOK_LABEL_CHARS, isHookLabel } from "../../src/shared/plugin-hooks.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import { HostMethod } from "../../src/shared/harness-api.ts";
import { WorkerTool } from "../../src/shared/workers.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";
import {
  CLAUDE as POOL_ENGINE,
  chatPool,
  fakeLocks,
  fastClock,
  finish,
  gameRepo,
  PROJECT,
  poolHost,
  start,
  THREAD,
} from "../helpers/worker-pool-host.ts";

/** A test that would hang on a regression fails within this instead. */
const TEST_TIMEOUT_MS = 60_000;
const CLAUDE = "claude-code";
const NAME = "harbor";
const REASON = "The harbor's crane is being serviced; try again in a minute.";
const TURN = {
  threadId: "thread-1",
  turnId: "turn-1",
  text: "add a crane",
  engine: CLAUDE,
  engineLabel: "Claude Code",
};

/** Genex's own hold of a moment, as the host types it: the person at the lock's app, and its label. */
const PERSON_HELD = {
  plugin: "@genex",
  tool: "",
  reason:
    "The person is using the harbor's crane, and this waited for them to finish. Try again later, or ask them in the chat.",
  hold: "person_first",
  label: "the crane",
};

/** A `hooks.fire` answer: blocked at `blockOn` with the reason (or `by`'s hold), else a moment no step held back. */
function fired(
  blockOn: string | null,
  by: Record<string, unknown> = { plugin: "harbor", tool: "crane", reason: REASON },
) {
  return (p: Record<string, unknown>) => ({
    blocked: p.on === blockOn ? by : null,
    pending: null,
    notes: [],
    images: [],
    ran: ["harbor__crane"],
  });
}

/**
 * A `hooks.fire` answer with `note` at `noteOn`, as today's host files a step's block or Genex's hold
 * there; nothing said elsewhere.
 */
function noted(noteOn: string, note: Record<string, unknown> = { plugin: "harbor", text: REASON }) {
  return (p: Record<string, unknown>) => ({
    blocked: null,
    pending: null,
    notes: p.on === noteOn ? [note] : [],
    images: [],
    ran: ["harbor__crane"],
  });
}

/** Genex's own hold as today's host answers it at a moment that answers no call: a note carrying the hold. */
const PERSON_HELD_NOTE = {
  plugin: PERSON_HELD.plugin,
  text: PERSON_HELD.reason,
  hold: PERSON_HELD.hold,
  label: PERSON_HELD.label,
};

/** A `hooks.fire` handler, as a test's host answers each moment. */
type Fired = (p: Record<string, unknown>) => unknown;

/** The harbor game as `game.list` lists it: a web game, plus what a turn's first leg added (`gained`). */
function harbor(hookEvents: string[] | undefined, gained: readonly unknown[] = []) {
  return {
    name: NAME,
    title: NAME,
    dir: `/games/${NAME}`,
    shape: { entry: "index.html", main: "src/main.js", build: null, own: false, kind: "studio-template" },
    built: true,
    facts: [{ id: "web-game", path: ".", source: "core" }, ...gained],
    ...(hookEvents ? { hookEvents } : {}),
  };
}

/**
 * One chat turn on a game whose descriptor lists `hookEvents` (absent: a web game's, none), its
 * moments answered by `answer`. A first leg that `gains` facts changes what the project is, so the
 * same session goes on in a second leg.
 */
async function chatTurn(hookEvents: string[] | undefined, answer: Fired = fired(null), gains: readonly unknown[] = []) {
  let legs = 0;
  const recorder = ctxRecorder({
    unknown: { value: null },
    handlers: {
      "events.messages": () => [{ role: "user", content: TURN.text }],
      "game.contentStamp": () => ({ all: "a", source: "a" }),
      "game.list": () => [harbor(hookEvents, legs > 0 ? gains : [])],
      "plugins.tools": () => ({ tools: [], guidance: "", revision: 1, kinds: [] }),
      "engine.describe": () => [],
      "preview.ready": () => ({ ready: true, ms: 1 }),
      "hooks.fire": answer,
      "engine.delegate": () => {
        legs += 1;
        return { ok: true, engine: CLAUDE, turns: 1, usage: {}, sessionId: "s", summary: "Done." };
      },
    },
  });
  await runDelegatedTurn(recorder.ctx as never, { ...TURN, project: NAME } as never);
  const said = recorder.notifications
    .filter((n) => n.type === "chat.message")
    .map((n) => String((n.payload as { content?: unknown }).content));
  return { recorder, said };
}

/** The notices one leg of a chat turn was handed. */
const noticesOf = (leg: Record<string, unknown> | undefined): string[] =>
  Array.isArray(leg?.notices) ? leg.notices.map(String) : [];

/**
 * A run's worker pool as the open Loop opens it (`openLoopPool`), on a stand-in for the Loop's run
 * that keeps every line noted for its lead, with its kind (`LoopRun.note`).
 */
async function runPoolOn(host: ReturnType<typeof poolHost>, repo: string, hookEvents: readonly string[]) {
  const noted: Array<{ text: string; kind: string }> = [];
  const runId = `run-${Math.random().toString(36).slice(2)}`;
  const open: Record<string, unknown> = { hookEvents, facts: [], holds: null, clock: fastClock(), halted: null };
  const loopRun = {
    ctx: host.recorder.ctx,
    projectDir: repo,
    run: { project: PROJECT, runId, engine: POOL_ENGINE },
    threadId: THREAD,
    state: { finished: false },
    open,
    note: (text: string, kind: string) => noted.push({ text, kind }),
  };
  await openLoopPool(loopRun as never, open as never);
  return { pool: open.pool as Awaited<ReturnType<typeof chatPool>>, noted, close: () => closeRunPool(runId) };
}

describe("Genex's moments, as the seed fires them", { timeout: TEST_TIMEOUT_MS }, () => {
  it("a chat turn announces its start and end to the game's plugins", async () => {
    const { recorder } = await chatTurn([HookEvent.TurnStart, HookEvent.TurnEnd]);
    const moments = recorder.paramsOf("hooks.fire");
    assert.deepEqual(
      moments.map((p) => p.on),
      [HookEvent.TurnStart, HookEvent.TurnEnd],
    );
    for (const moment of moments) {
      assert.equal(moment.project, NAME);
      assert.equal(moment.threadId, TURN.threadId);
      assert.equal(moment.turn, TURN.turnId);
    }
    assert.ok(
      recorder.sequence().indexOf("hooks.fire") < recorder.sequence().indexOf("engine.delegate"),
      "the start comes before any engine works",
    );
  });

  // Flipped (hooks advise, the lead decides): "a turn.start block ends a chat turn before any engine
  // call, and the chat says why". Only a call's own moment refuses it; a chat turn is no such call.
  it("a turn.start step's block never ends a chat turn: its reason is one notice on the turn's first leg, from today's host or an older one", async () => {
    // Today's host files a step's block at turn.start as its note; an older one answered it as a block.
    for (const [host, answer] of [
      ["today's", noted(HookEvent.TurnStart)],
      ["an older", fired(HookEvent.TurnStart)],
    ] as const) {
      const { recorder, said } = await chatTurn([HookEvent.TurnStart, HookEvent.TurnEnd], answer);
      const legs = recorder.paramsOf("engine.delegate");
      assert.equal(legs.length, 1, `${host} host: the turn ran`);
      const told = noticesOf(legs[0]).filter((notice) => notice.includes(REASON));
      assert.equal(told.length, 1, `${host} host: ${JSON.stringify(legs[0]?.notices)}`);
      assert.ok(!said.some((line) => /wasn't worked on/.test(line)), said.join(" | "));
      assert.deepEqual(
        recorder.paramsOf("hooks.fire").map((p) => p.on),
        [HookEvent.TurnStart, HookEvent.TurnEnd],
        `${host} host: its end is announced too`,
      );
    }
  });

  it("a turn.start notice is said once: a leg the same session goes on in is not told it again", async () => {
    const gains = [{ id: "godot-project", path: ".", source: "core" }];
    const { recorder } = await chatTurn([HookEvent.TurnStart], noted(HookEvent.TurnStart), gains);
    const legs = recorder.paramsOf("engine.delegate");
    assert.equal(legs.length, 2, "the project's new kind goes on in the same session");
    assert.equal(legs[1]?.resume, "s");
    assert.ok(noticesOf(legs[0]).some((notice) => notice.includes(REASON)));
    assert.ok(!noticesOf(legs[1]).some((notice) => notice.includes(REASON)), JSON.stringify(legs[1]?.notices));
  });

  // Flipped (hooks advise, the lead decides): "a turn.start Genex held for the person says so in words
  // for them, never the agents' words" ended the turn with "This message wasn't worked on".
  it("a turn.start Genex held for the person reaches the turn's session in words for them, never the agents' words", async () => {
    for (const answer of [noted(HookEvent.TurnStart, PERSON_HELD_NOTE), fired(HookEvent.TurnStart, PERSON_HELD)]) {
      const { recorder, said } = await chatTurn([HookEvent.TurnStart, HookEvent.TurnEnd], answer);
      const legs = recorder.paramsOf("engine.delegate");
      assert.equal(legs.length, 1, "the turn ran");
      const notice = noticesOf(legs[0]).find((text) => /the crane/.test(text)) ?? "";
      assert.match(notice, /while you were using the crane/, JSON.stringify(legs[0]?.notices));
      assert.doesNotMatch(notice, /the person|ask them|Try again later/i);
      assert.ok(!said.some((line) => /wasn't worked on/.test(line)), said.join(" | "));
    }
  });

  // Flipped (hooks advise, the lead decides): "a worker.start block starts no worker and writes no
  // worker_started; a worker's end is announced after its record". worker.start answers no call.
  it("a worker.start step's block never holds a worker back: it starts, its answer carries the step's words, and its end is announced after its record", async () => {
    const repo = await gameRepo();
    for (const answer of [noted(HookEvent.WorkerStart), fired(HookEvent.WorkerStart)]) {
      const told = poolHost(repo);
      told.recorder.handle(HostMethod.HooksFire, answer);
      const toldPool = await chatPool(told, repo, { hookEvents: [HookEvent.WorkerStart, HookEvent.WorkerEnd] });
      const started = await toldPool.call(WorkerTool.Start, {
        title: "Read",
        task: "Read the code.",
        isolation: "read",
      });
      assert.match(started, /^Started (w\d+) \(read\)\./, started);
      assert.ok(started.includes(REASON), started);
      assert.equal(toldPool.state.records.length, 1, "its record is kept");
      assert.equal(told.sessions.length, 1, "its session starts");
      assert.ok(
        told.appended.some((row) => row.type === CustomEvent.WorkerStarted),
        "worker_started",
      );
      assert.ok(told.recorder.paramsOf(HostMethod.HooksFire)[0]?.worker !== undefined, "the step is told the worker");
      const id = String(/^Started (w\d+)/.exec(started)?.[1]);
      await finish(told, toldPool, id, { ok: true, sessionId: "s0", summary: "Read it." });
    }

    const open = poolHost(repo);
    open.recorder.handle(HostMethod.HooksFire, fired(null));
    const pool = await chatPool(open, repo, { hookEvents: [HookEvent.WorkerStart, HookEvent.WorkerEnd] });
    const id = await start(pool, { title: "Read", task: "Read the code.", isolation: "read" });
    await finish(open, pool, id, { ok: true, sessionId: "s1", summary: "Read it." });
    const moments = open.recorder.paramsOf(HostMethod.HooksFire);
    assert.deepEqual(
      moments.map((p) => p.on),
      [HookEvent.WorkerStart, HookEvent.WorkerEnd],
    );
    assert.deepEqual(moments[1]?.worker, { id, title: "Read" });
    const order = open.recorder.sequence((m) => m === HostMethod.HooksFire || m === HostMethod.EventsAppend);
    assert.equal(order.at(-1), HostMethod.HooksFire, "the end is announced after the end's record");
  });

  it("a worker.end step's words join the end line a run's lead is woken with", async () => {
    const repo = await gameRepo();
    const host = poolHost(repo);
    const LUAU = "Luau: 2 warnings in src/Cannon.luau.";
    host.recorder.handle(HostMethod.HooksFire, noted(HookEvent.WorkerEnd, { plugin: "roblox", text: LUAU }));
    const run = await runPoolOn(host, repo, [HookEvent.WorkerStart, HookEvent.WorkerEnd]);
    try {
      const id = await start(run.pool, { title: "Read", task: "Read the code.", isolation: "read" });
      await finish(host, run.pool, id, { ok: true, sessionId: "s1", summary: "Read it." });
      const ends = run.noted.filter((line) => line.kind === NoteKind.WorkerEnded);
      assert.deepEqual(
        ends.map((line) => line.text),
        [`worker ${id} "Read" ended: done. ${LUAU}`],
      );
    } finally {
      await run.close();
    }
  });

  // Flipped (hooks advise, the lead decides): "a hooks.fire that fails at a blocking moment holds it
  // back; only a host that never knew the moments goes on" held a worker back. Blocking moments now
  // answer a call (the lead's finish); a failure anywhere else is Genex's note.
  it("a hooks.fire that fails holds back only a blocking moment's call; elsewhere it is Genex's note, and a host that never knew the moments says nothing", async () => {
    const repo = await gameRepo();
    const failing = poolHost(repo);
    failing.recorder.handle(HostMethod.HooksFire, () => {
      throw Object.assign(new Error("the plugin host is restarting"), { name: "InvalidParams" });
    });
    const pool = await chatPool(failing, repo, { hookEvents: [HookEvent.WorkerStart, HookEvent.WorkerEnd] });
    const answer = await pool.call(WorkerTool.Start, { title: "Read", task: "Read the code.", isolation: "read" });
    assert.match(answer, /^Started w1 \(read\)\..*couldn't ask the game's plugins: the plugin host is restarting/);
    assert.equal(failing.sessions.length, 1, "its session starts");
    await finish(failing, pool, "w1", { ok: true, sessionId: "s1", summary: "Read it." });

    const game = { hookEvents: [HookEvent.Finish, HookEvent.WorkerStart, HookEvent.Health] };
    const throwing = (name: string) =>
      ctxRecorder({
        handlers: {
          "hooks.fire": () => {
            throw Object.assign(new Error(`refused: ${name}`), { name });
          },
        },
      }).ctx as never;
    const scope = { project: NAME };
    const held = await fireHooks(throwing("InvalidParams"), game, HookEvent.Finish, scope);
    assert.match(String(held.blocked?.reason), /refused: InvalidParams/, "fail closed where the block answers a call");
    for (const on of [HookEvent.WorkerStart, HookEvent.Health]) {
      const report = await fireHooks(throwing("InvalidParams"), game, on, scope);
      assert.equal(report.blocked, null, on);
      assert.deepEqual(
        report.notes.map((note) => [
          note.plugin,
          /couldn't ask the game's plugins: refused: InvalidParams/.test(note.text),
        ]),
        [["@genex", true]],
        on,
      );
    }
    for (const on of [HookEvent.Finish, HookEvent.WorkerStart]) {
      const older = await fireHooks(throwing("UnknownMethod"), game, on, scope);
      assert.deepEqual([older.blocked, older.notes], [null, []], `an older host without moments says nothing: ${on}`);
    }
  });

  // Flipped (hooks advise, the lead decides): turn.start and worker.start answered "Stopped." as a
  // block; they answer no call now, so a Stop there says nothing, as a moment no step ran at.
  it("a moment or a checkpoint a Stop ended answers as stopped, never as a failure of the game's plugins", async () => {
    const stopped = () => {
      const recorder = ctxRecorder({
        handlers: {
          "hooks.fire": () => {
            throw new Error("Stopped.");
          },
          "checkpoint.take": () => {
            throw new Error("Stopped.");
          },
        },
      });
      recorder.cancel();
      return recorder.ctx as never;
    };
    const game = {
      hookEvents: [HookEvent.Finish, HookEvent.RestoreBefore, HookEvent.TurnStart, HookEvent.WorkerStart],
    };
    for (const on of [HookEvent.Finish, HookEvent.RestoreBefore]) {
      const report = await fireHooks(stopped(), game, on, { project: NAME });
      assert.equal(report.blocked?.reason, "Stopped.", on);
      assert.doesNotMatch(String(report.blocked?.reason), /couldn't ask/);
    }
    for (const on of [HookEvent.TurnStart, HookEvent.WorkerStart]) {
      const report = await fireHooks(stopped(), game, on, { project: NAME });
      assert.deepEqual([report.blocked, report.notes], [null, []], on);
      assert.deepEqual(await momentLines(stopped(), game, on, { project: NAME }), [], on);
    }
    const checkpoint = await takeCheckpoint(stopped(), { project: NAME, threadId: "t1", label: "Halfway" });
    assert.deepEqual(checkpoint, { blocked: "Stopped." });
    // The chat's line for a turn its Stop ended at turn.start blames no plugin.
    assert.doesNotMatch(turnHeldLine({ reason: "Stopped." }), /couldn't ask|plugins/);
  });

  it("a wait for the game's apps a Stop cut short is never read as ready, even when no health step ran", async () => {
    // The Stop came while health was asked: the host answers as if no step ran.
    const recorder = ctxRecorder({
      handlers: {
        "hooks.fire": () => ({ blocked: null, pending: null, notes: [], images: [], ran: [] }),
      },
    });
    recorder.cancel();
    const clock = { now: () => 0, sleep: async () => {} };
    const game = { hookEvents: [HookEvent.Health] };
    const outcome = await waitReady(recorder.ctx as never, game, { project: NAME }, clock, 60_000);
    assert.equal(outcome.ok, false, "never ready");
    assert.ok(!outcome.ok && !outcome.timedOut && /stopped/i.test(outcome.reason), JSON.stringify(outcome));
  });

  it("a worker refused after its start was announced has its end announced too", async () => {
    const repo = await gameRepo();
    const locks = fakeLocks();
    locks.held.set(PROJECT, { key: "elsewhere:w9", title: "Varnish" });
    const host = poolHost(repo, { locks });
    host.recorder.handle(HostMethod.HooksFire, fired(null));
    const pool = await chatPool(host, repo, { hookEvents: [HookEvent.WorkerStart, HookEvent.WorkerEnd] });
    const answer = await pool.call(WorkerTool.Start, { title: "Tune", task: "Tune the bridge.", isolation: "lock" });
    assert.match(answer, /Varnish/, "refused: another writer works in place");
    assert.deepEqual(
      host.recorder.paramsOf(HostMethod.HooksFire).map((p) => p.on),
      [HookEvent.WorkerStart, HookEvent.WorkerEnd],
      "every announced start has its end",
    );
    assert.deepEqual(pool.state.records, [], "no record is kept");
  });

  it("two workers started at once on a game that hooks worker.start number apart", async () => {
    const repo = await gameRepo();
    const host = poolHost(repo);
    let opened: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      opened = resolve;
    });
    host.recorder.handle(HostMethod.HooksFire, async (p: Record<string, unknown>) => {
      if (p.on === HookEvent.WorkerStart) await gate;
      return fired(null)(p);
    });
    const pool = await chatPool(host, repo, { hookEvents: [HookEvent.WorkerStart, HookEvent.WorkerEnd] });
    const first = pool.call(WorkerTool.Start, { title: "Read A", task: "Read the code.", isolation: "read" });
    const second = pool.call(WorkerTool.Start, { title: "Read B", task: "Read the docs.", isolation: "read" });
    await new Promise((resolve) => setImmediate(resolve));
    opened();
    const ids = (await Promise.all([first, second])).map((answer) => /Started (w\d+)/.exec(answer)?.[1]);
    assert.ok(ids[0] && ids[1], ids.join(", "));
    assert.notEqual(ids[0], ids[1]);
    assert.deepEqual(pool.state.records.map((record) => record.id).sort(), [...ids].sort());
    for (const id of ids) await finish(host, pool, String(id), { ok: true, sessionId: `s-${id}`, summary: "Read." });
  });

  // Flipped (one Loop): "a finish block keeps the director's run going" drove the web lead's handler;
  // every Loop's finish moment is the one Loop's (one-loop.test.ts, the toy plugin's finish step).
  it("a checkpoint's label and a moment's turn and label reach the host on one line within its cap", async () => {
    const taken = { snapshot: { snapshot_id: "snap_1", scope: "game", reason: "checkpoint" }, notes: [], images: [] };
    const recorder = ctxRecorder({
      unknown: { value: null },
      handlers: { "checkpoint.take": () => taken, "hooks.fire": fired(null) },
    });
    const long = `Atmosphere\tpass\n${"x".repeat(200)}`;
    const answer = await takeCheckpoint(recorder.ctx as never, { project: NAME, threadId: TURN.threadId, label: long });
    assert.ok("snapshot" in answer, JSON.stringify(answer));
    const [asked] = recorder.paramsOf("checkpoint.take");
    assert.ok(isHookLabel(asked?.label), String(asked?.label));
    assert.equal(String(asked?.label).length, HOOK_LABEL_CHARS);
    assert.match(String(asked?.label), /^Atmosphere pass x/);
    const unnamed = await takeCheckpoint(recorder.ctx as never, { project: NAME, label: "\n\t" });
    assert.ok("snapshot" in unnamed, "a label of nothing but control characters still names the checkpoint");
    assert.ok(isHookLabel(recorder.paramsOf("checkpoint.take")[1]?.label));

    await fireHooks(recorder.ctx as never, { hookEvents: [HookEvent.Health] }, HookEvent.Health, {
      project: NAME,
      turn: long,
      label: long,
    });
    const [fire] = recorder.paramsOf("hooks.fire");
    assert.ok(isHookLabel(fire?.turn) && isHookLabel(fire?.label), JSON.stringify(fire));
  });

  // Flipped (one Loop): it also drove the web lead's finish; a Loop on a project no plugin hooks is
  // one-loop.test.ts's ("a project no plugin hooks makes no hooks.fire call but the run's own moments").
  it("a web game's chat turn and pool make no hooks.fire call", async () => {
    const { recorder } = await chatTurn(undefined);
    assert.equal(recorder.paramsOf("engine.delegate").length, 1, "the turn ran");
    assert.deepEqual(recorder.paramsOf("hooks.fire"), [], "a chat turn");

    const repo = await gameRepo();
    const host = poolHost(repo);
    const pool = await chatPool(host, repo);
    const id = await start(pool, { title: "Read", task: "Read the code.", isolation: "read" });
    await finish(host, pool, id, { ok: true, sessionId: "s1", summary: "Read it." });
    assert.deepEqual(host.recorder.paramsOf(HostMethod.HooksFire), [], "a pool's workers");
  });
});

describe("a director's turn a plugin keeps holding back", () => {
  /** A clock that only moves when a wait is asked of it. */
  function steppingClock() {
    let now = 0;
    const sleep = async (ms: number) => {
      now += ms;
    };
    return { now: () => now, sleep };
  }

  it("asks again after a wait, and the turn runs once it isn't held: never an idle turn", async () => {
    const clock = steppingClock();
    const answers = [REASON, REASON, null];
    const held = await whileTurnHeld(
      async () => answers.shift() ?? null,
      clock,
      () => false,
    );
    assert.equal(held, null, "the turn runs");
    assert.equal(clock.now(), 2 * HELD_TURN_WAIT_MS, "it waited between asks");
  });

  // Flipped (no clock): a turn held through `MAX_HELD_TURNS` asks (about five minutes) gave up and
  // failed; a held turn waits until the plugin lets it start, or the run can't wait (a Stop, its wrap-up).
  it("waits for as long as the plugin holds it, and gives up with the hold's reason only when the run can't wait", async () => {
    const clock = steppingClock();
    let asked = 0;
    const always = async () => {
      asked += 1;
      return REASON;
    };
    // The person's Stop comes after a hundred asks: far past the five that used to end the wait.
    const held = await whileTurnHeld(always, clock, () => asked >= 100);
    assert.equal(held, REASON, "the person's Stop ends the wait with the hold's reason");
    assert.equal(asked, 100);
    assert.equal(clock.now(), 99 * HELD_TURN_WAIT_MS, "it waited between every ask");
    asked = 0;
    assert.equal(await whileTurnHeld(always, steppingClock(), () => true), REASON, "a wrap-up or a run that is over");
    assert.equal(asked, 1);
  });
});

describe("Genex's own holds, in the person's words on every surface", () => {
  const APP = "the crane";
  /** What each of Genex's holds must say, and never: the person reads them, so no agents' words. */
  const HOLDS: Array<[HookHold, RegExp]> = [
    [HookHold.PersonFirst, /you(?:'re| were) using the crane|finish in the crane|while you use it/],
    [HookHold.CantTell, /couldn't tell whether you were using the crane/],
    [HookHold.Busy, /[Ss]omething else (?:was|kept) working (?:in the crane|there)/],
    [HookHold.Plan, /Plan mode/],
  ];
  const AGENTS_WORDS = /the person|ask them|Try again later|a plugin of this game/i;
  const held = (hold: HookHold) => ({ reason: "The person is using the crane. Try again later.", hold, label: APP });

  /**
   * Every surface's words for Genex's holds: a line the person reads for each, or null where it says
   * nothing. Flipped (hooks advise, the lead decides): a chat turn's start, a Loop's start and a
   * director run's lead turns are held no more, so their lines left; a Loop's start line came.
   */
  const SURFACES: Array<[string, (hold: HookHold) => Promise<string | null> | string | null]> = [
    [
      "a Loop's start line",
      async (hold) => {
        const note = { plugin: "@genex", text: held(hold).reason, hold, label: APP };
        const recorder = ctxRecorder({ handlers: { [HostMethod.HooksFire]: noted(HookEvent.RunPrepare, note) } });
        const game = { hookEvents: [HookEvent.RunPrepare] };
        const lines = await momentLines(recorder.ctx as never, game, HookEvent.RunPrepare, { project: NAME });
        return lines[0] ?? null;
      },
    ],
    [
      "a chat turn's end checkpoint",
      async (hold) => {
        const recorder = ctxRecorder({
          handlers: { [HostMethod.CheckpointTake]: () => ({ blocked: held(hold).reason, hold, label: APP }) },
        });
        const game = { hookEvents: [HookEvent.CheckpointBefore] };
        return endOfTurnCheckpoint(recorder.ctx as never, { project: NAME, threadId: "t1" }, game);
      },
    ],
    ["a chat's wait for the game's apps", (hold) => pendingLine(held(hold))],
    [
      "a note Genex added at a moment",
      (hold) => notesText({ notes: [{ plugin: "@genex", text: held(hold).reason, hold, label: APP }] })[0] ?? null,
    ],
  ];

  for (const [surface, words] of SURFACES) {
    it(`${surface}: each hold in its own words, never the agents'`, async () => {
      const said = new Map<HookHold, string | null>();
      for (const [hold, expected] of HOLDS) {
        const line = await words(hold);
        said.set(hold, line);
        // A chat turn that planned left nothing to say, as a planning turn never did.
        if (line === null && surface === "a chat turn's end checkpoint" && hold === HookHold.Plan) continue;
        assert.match(String(line), expected, `${surface}, ${hold}: ${line}`);
        assert.doesNotMatch(String(line), AGENTS_WORDS, `${surface}, ${hold}`);
      }
      assert.doesNotMatch(String(said.get(HookHold.PersonFirst)), /couldn't tell/, "using it is not can't tell");
      assert.doesNotMatch(String(said.get(HookHold.CantTell)), /you're using/, "can't tell is not using it");
    });
  }

  it("a step's own block keeps its reason: no surface words it as Genex's hold", async () => {
    // A step's block: its reason, and no hold of Genex's.
    const step = { reason: "The crane is being serviced.", hold: undefined };
    assert.match(openStartHeld(step), /a plugin of this project held it back: The crane is being serviced\./);
    assert.match(directorTurnsHeld(step), /The crane is being serviced\./);
    assert.match(turnHeldLine(step), /The crane is being serviced\./);
    assert.equal(pendingLine(step), "The crane is being serviced.");
    assert.deepEqual(notesText({ notes: [{ plugin: "crane", text: step.reason }] }), [step.reason]);
    // An older host's block at a moment that answers no call: one line, after the steps' notes.
    const blocked = { plugin: "crane", tool: "service", reason: step.reason };
    const answer = { blocked, pending: null, notes: [{ plugin: "crane", text: "Oiled." }], images: [], ran: [] };
    const recorder = ctxRecorder({ handlers: { [HostMethod.HooksFire]: () => answer } });
    const game = { hookEvents: [HookEvent.TurnStart] };
    const lines = await momentLines(recorder.ctx as never, game, HookEvent.TurnStart, { project: NAME });
    assert.deepEqual(lines, ["Oiled.", step.reason]);
  });
});
