/**
 * Where the seed fires Genex's moments, and that a game no plugin hooks makes no new call. A chat
 * turn announces its start and end, the worker pool each worker's start and end, and the director
 * its lead's finish; a step's block holds the moment back (the turn never reaches an engine, the
 * worker never starts, the run goes on unfinished). A game whose descriptor lists no moment (every
 * web game) gets no `hooks.fire` at all.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runDelegatedTurn } from "../../src/harness-seed/loop/delegated-turn.ts";
import { handler as directorTool } from "../../src/harness-seed/loop/director/tools.ts";
import { HELD_TURN_WAIT_MS, MAX_HELD_TURNS, whileTurnHeld } from "../../src/harness-seed/loop/director/turn-hold.ts";
import { runHeldWords, turnsHeldWords as directorTurnsHeld } from "../../src/harness-seed/loop/director/held-words.ts";
import {
  endOfTurnCheckpoint,
  fireHooks,
  HookEvent,
  HookHold,
  takeCheckpoint,
  turnHeldLine,
} from "../../src/harness-seed/loop/hooks.ts";
import {
  betweenHeldWords,
  closeHeldWords,
  cppHeldWords,
  startHeldWords,
  turnsHeldWords as unrealTurnsHeld,
} from "../../src/harness-seed/loop/unreal/hold-words.ts";
import { HOOK_LABEL_CHARS, isHookLabel } from "../../src/shared/plugin-hooks.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import { HostMethod } from "../../src/shared/harness-api.ts";
import { WorkerTool } from "../../src/shared/workers.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";
import { chatPool, fakeLocks, finish, gameRepo, PROJECT, poolHost, start } from "../helpers/worker-pool-host.ts";

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

/** One chat turn on a game whose descriptor lists `hookEvents` (absent: a web game's, none). */
async function chatTurn(hookEvents: string[] | undefined, blockOn: string | null = null, by?: Record<string, unknown>) {
  const recorder = ctxRecorder({
    unknown: { value: null },
    handlers: {
      "events.messages": () => [{ role: "user", content: TURN.text }],
      "game.contentStamp": () => ({ all: "a", source: "a" }),
      "game.list": () => [
        {
          name: NAME,
          title: NAME,
          dir: `/games/${NAME}`,
          shape: { entry: "index.html", main: "src/main.js", build: null, own: false, kind: "studio-template" },
          built: true,
          facts: [{ id: "web-game", path: ".", source: "core" }],
          ...(hookEvents ? { hookEvents } : {}),
        },
      ],
      "plugins.tools": () => ({ tools: [], guidance: "", revision: 1, kinds: [] }),
      "engine.describe": () => [],
      "preview.ready": () => ({ ready: true, ms: 1 }),
      "hooks.fire": fired(blockOn, by),
      "engine.delegate": () => ({ ok: true, engine: CLAUDE, turns: 1, usage: {}, sessionId: "s", summary: "Done." }),
    },
  });
  await runDelegatedTurn(recorder.ctx as never, { ...TURN, project: NAME } as never);
  const said = recorder.notifications
    .filter((n) => n.type === "chat.message")
    .map((n) => String((n.payload as { content?: unknown }).content));
  return { recorder, said };
}

/** A director's run as its tool handler reads it, on a game whose descriptor lists `hookEvents`. */
function directorRun(hookEvents: string[] | undefined, blockOn: string | null = null) {
  const recorder = ctxRecorder({ unknown: { value: null }, handlers: { "hooks.fire": fired(blockOn) } });
  const finishes: unknown[] = [];
  const loopRun = {
    ctx: recorder.ctx,
    run: { project: NAME, runId: "run_harbor" },
    threadId: TURN.threadId,
    game: hookEvents ? { hookEvents } : { hookEvents: undefined },
    state: { integrationHead: null, finished: false, workers: new Map() },
    journal: { director: {} },
    toolCalls: 0,
    keepMemory: async () => {},
    syncHead: async () => {},
    saveJournal: async () => {},
    finish: async (args: unknown) => {
      finishes.push(args);
      return "Finished: the build is landed.";
    },
  };
  return { recorder, loopRun, finishes };
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

  it("a turn.start block ends a chat turn before any engine call, and the chat says why", async () => {
    const { recorder, said } = await chatTurn([HookEvent.TurnStart, HookEvent.TurnEnd], HookEvent.TurnStart);
    assert.deepEqual(recorder.paramsOf("engine.delegate"), [], "no engine works on it");
    assert.ok(
      said.some((line) => line.includes(REASON)),
      said.join(" | "),
    );
  });

  it("a turn.start Genex held for the person says so in words for them, never the agents' words", async () => {
    const { recorder, said } = await chatTurn(
      [HookEvent.TurnStart, HookEvent.TurnEnd],
      HookEvent.TurnStart,
      PERSON_HELD,
    );
    assert.deepEqual(recorder.paramsOf("engine.delegate"), []);
    const line = said.find((text) => /wasn't worked on/.test(text)) ?? "";
    assert.match(line, /you're using the crane/, said.join(" | "));
    assert.doesNotMatch(line, /the person|ask them|Try again later/i);
  });

  it("a worker.start block starts no worker and writes no worker_started; a worker's end is announced after its record", async () => {
    const repo = await gameRepo();
    const held = poolHost(repo);
    held.recorder.handle(HostMethod.HooksFire, fired(HookEvent.WorkerStart));
    const heldPool = await chatPool(held, repo, { hookEvents: [HookEvent.WorkerStart, HookEvent.WorkerEnd] });
    const answer = await heldPool.call(WorkerTool.Start, { title: "Read", task: "Read the code.", isolation: "read" });
    assert.match(answer, /Not started: .*crane is being serviced/);
    assert.deepEqual(heldPool.state.records, [], "no record is kept");
    assert.deepEqual(held.sessions, [], "no session starts");
    assert.ok(!held.appended.some((row) => row.type === CustomEvent.WorkerStarted), "no worker_started");
    assert.equal(
      held.recorder.paramsOf(HostMethod.HooksFire)[0]?.worker !== undefined,
      true,
      "the step is told the worker",
    );

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

  it("a hooks.fire that fails at a blocking moment holds it back; only a host that never knew the moments goes on", async () => {
    const repo = await gameRepo();
    const failing = poolHost(repo);
    failing.recorder.handle(HostMethod.HooksFire, () => {
      throw Object.assign(new Error("the plugin host is restarting"), { name: "InvalidParams" });
    });
    const pool = await chatPool(failing, repo, { hookEvents: [HookEvent.WorkerStart, HookEvent.WorkerEnd] });
    const answer = await pool.call(WorkerTool.Start, { title: "Read", task: "Read the code.", isolation: "read" });
    assert.match(answer, /Not started: .*the plugin host is restarting/);
    assert.deepEqual(failing.sessions, [], "no session starts");

    const game = { hookEvents: [HookEvent.WorkerStart, HookEvent.Health] };
    const throwing = (name: string) =>
      ctxRecorder({
        handlers: {
          "hooks.fire": () => {
            throw Object.assign(new Error(`refused: ${name}`), { name });
          },
        },
      }).ctx as never;
    const scope = { project: NAME };
    const held = await fireHooks(throwing("InvalidParams"), game, HookEvent.WorkerStart, scope);
    assert.match(String(held.blocked?.reason), /refused: InvalidParams/);
    const older = await fireHooks(throwing("UnknownMethod"), game, HookEvent.WorkerStart, scope);
    assert.equal(older.blocked, null, "an older host without moments: nothing held");
    const health = await fireHooks(throwing("InvalidParams"), game, HookEvent.Health, scope);
    assert.equal(health.blocked, null, "a moment that never blocks stays quiet");
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

  it("a finish block keeps the director's run going, and the lead hears why", async () => {
    const held = directorRun([HookEvent.Finish], HookEvent.Finish);
    const answer = await directorTool(held.loopRun as never, "finish", { summary: "Done." });
    assert.match(String(answer), /crane is being serviced/);
    assert.deepEqual(held.finishes, [], "the run is not finished");
    const free = directorRun([HookEvent.Finish]);
    assert.equal(
      await directorTool(free.loopRun as never, "finish", { summary: "Done." }),
      "Finished: the build is landed.",
    );
    assert.equal(free.finishes.length, 1);
  });

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

  it("a web game's chat turn, director run and pool make no hooks.fire call", async () => {
    const { recorder } = await chatTurn(undefined);
    assert.equal(recorder.paramsOf("engine.delegate").length, 1, "the turn ran");
    assert.deepEqual(recorder.paramsOf("hooks.fire"), [], "a chat turn");

    const director = directorRun(undefined);
    await directorTool(director.loopRun as never, "finish", { summary: "Done." });
    assert.equal(director.finishes.length, 1, "the run finished");
    assert.deepEqual(director.recorder.paramsOf("hooks.fire"), [], "a director's finish");

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

  it("gives up with the hold's reason after the cap, or at once when the run can't wait", async () => {
    const clock = steppingClock();
    let asked = 0;
    const always = async () => {
      asked += 1;
      return REASON;
    };
    assert.equal(await whileTurnHeld(always, clock, () => false), REASON);
    assert.equal(asked, MAX_HELD_TURNS);
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

  /** Every surface's words for Genex's holds: a line the person reads for each, or null where it says nothing. */
  const SURFACES: Array<[string, (hold: HookHold) => Promise<string | null> | string | null]> = [
    ["a chat turn's start", (hold) => turnHeldLine(held(hold))],
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
    ["the Unreal Loop's start", (hold) => startHeldWords(held(hold))],
    ["the Unreal Loop's close", (hold) => closeHeldWords(held(hold))],
    ["the Unreal lead's turns held", (hold) => unrealTurnsHeld(held(hold))],
    ["a restore or restart between turns", (hold) => betweenHeldWords(held(hold))],
    ["adding C++", (hold) => cppHeldWords(held(hold))],
    ["a director run's start", (hold) => runHeldWords(held(hold))],
    ["a director run's lead turns held", (hold) => directorTurnsHeld(held(hold))],
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

  it("a step's own block keeps its reason: no surface words it as Genex's hold", () => {
    // A step's block: its reason, and no hold of Genex's.
    const step = { reason: "The crane is being serviced.", hold: undefined };
    for (const words of [startHeldWords, closeHeldWords, unrealTurnsHeld, betweenHeldWords, cppHeldWords])
      assert.equal(words(step), null);
    assert.match(runHeldWords(step), /a plugin of this game held it back: The crane is being serviced\./);
    assert.match(directorTurnsHeld(step), /The crane is being serviced\./);
    assert.match(turnHeldLine(step), /The crane is being serviced\./);
  });
});
