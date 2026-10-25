/**
 * A tool that needs a lock waits its turn, and the person comes first.
 *
 * Unit level over `LockService` with a clock the test moves and a scripted probe; then a real core
 * (`coreLite`) with a local test plugin whose agent tool `paint` needs the lock `bench`, whose probe
 * `busy` reads a file the test writes, and whose connector needs the same lock.
 */
import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextTurn, setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import {
  AGENT_LOCK_WAIT_MS,
  LockRefused,
  LockRefusal,
  LockService,
  PERSON_FIRST_ASK_MS,
  PERSON_FIRST_FRESH_MS,
  PERSON_FIRST_POLL_MS,
  PERSON_REFUSAL_STANDS_MS,
  runHolders,
  workerHolder,
} from "../../src/main/core/plugin-locks.ts";
import { PluginToolService } from "../../src/main/core/plugin-tools.ts";
import { WRITERS_LET_GO_MS } from "../../src/main/core/recovery.ts";
import { CustomEvent, customEvent, customEventData } from "../../src/shared/custom-events.ts";
import { EventKind, SnapshotScope } from "../../src/shared/event-log.ts";
import { HostMethod, harnessParamsProblem } from "../../src/shared/harness-api.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import { HookEvent, LockScope, type PluginLock } from "../../src/shared/plugin-hooks.ts";
import { PluginCallBlocker, PluginSourceKind, type PluginBinding } from "../../src/shared/plugins.ts";
import { CoreFact, type GameKind } from "../../src/shared/project-facts.ts";
import { UiEvent, type UiEvent as UiEventEnvelope } from "../../src/shared/ui-events.ts";
import { BRIDGE_TOOL_DEADLINE_MS } from "../../src/substrate/engines/studio-bridge.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";
import { closeWorkerChats, LOCAL, RUN_ID, workerChat } from "../helpers/worker-chat.ts";
import { personAllowsLocalTools } from "../helpers/plugins.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** Where the lock plugin came from: GitHub, so its connector follows the chat's mode (a local plugin's server asks every call). */
const FROM_GITHUB = { kind: PluginSourceKind.Github, repo: "studio-tests/locks", sha: "a".repeat(40) } as const;
/** How many turns of the event loop a test lets the service take before it reads what happened. */
const SETTLE_TICKS = 20;

async function settle(): Promise<void> {
  for (let tick = 0; tick < SETTLE_TICKS; tick++) await nextTurn();
}

/** A clock the test moves: every wait stays pending until `advance` passes its end, or its signal aborts it. */
function manualClock() {
  let now = 0;
  const timers = new Set<{ at: number; resolve: () => void }>();
  return {
    now: () => now,
    sleep(ms: number, signal?: AbortSignal): Promise<void> {
      return new Promise((resolve, reject) => {
        const timer = { at: now + ms, resolve };
        timers.add(timer);
        signal?.addEventListener(
          "abort",
          () => {
            timers.delete(timer);
            reject(signal.reason);
          },
          { once: true },
        );
      });
    },
    async advance(ms: number): Promise<void> {
      now += ms;
      for (const timer of [...timers])
        if (timer.at <= now) {
          timers.delete(timer);
          timer.resolve();
        }
      await settle();
    },
  };
}

const BENCH: PluginLock = { id: "bench", label: "Bench", per: LockScope.Project, personFirst: "busy" };
const QUIET: PluginLock = { id: "quiet", label: "Quiet room", per: LockScope.Project };
const SHARED: PluginLock = { id: "desk", label: "Desk", per: LockScope.App };
const bench = { plugin: "tl", lock: BENCH };
const quiet = { plugin: "tl", lock: QUIET };
const shared = { plugin: "tl", lock: SHARED };
const binding = (project = "garden"): PluginBinding => ({ project, directory: `/games/${project}`, threadId: "t1" });

/** A service over a scripted probe: each call answers the next answer (the last one repeats); an Error is thrown. */
function service(answers: unknown[] = [{ personActive: false }]) {
  const clock = manualClock();
  const asked: string[] = [];
  const said: Array<{ label: string; waiting: boolean; threadId?: string }> = [];
  const locks = new LockService({
    probe: async (plugin, lock) => {
      asked.push(`${plugin}:${lock.id}`);
      const answer = answers[Math.min(asked.length - 1, answers.length - 1)];
      if (answer instanceof Error) throw answer;
      return answer;
    },
    now: clock.now,
    sleep: clock.sleep,
    onPersonFirst: ({ label, waiting, threadId }) => said.push({ label, waiting, threadId }),
  });
  return { locks, clock, asked, said };
}

/** A hold that records when it was granted, or why it was refused. */
function track(promise: Promise<() => void>) {
  const state: { release: (() => void) | null; error: unknown } = { release: null, error: null };
  promise.then(
    (release) => {
      state.release = release;
    },
    (error: unknown) => {
      state.error = error;
    },
  );
  return state;
}

/** Whether a tracked hold was granted. */
const granted = (held: { release: (() => void) | null }): boolean => held.release !== null;

const HOUR = 3_600_000;

describe("LockService", () => {
  it("one holder at a time, in the order they asked", async () => {
    const { locks } = service();
    const order: string[] = [];
    const holds = ["a", "b", "c"].map((holder) => ({
      holder,
      held: track(locks.hold([quiet], { binding: binding(), waitMs: HOUR, holder })),
    }));
    await settle();
    const holding = () => holds.filter(({ held }) => held.release).map(({ holder }) => holder);
    assert.deepEqual(holding(), ["a"], "the first asker holds it; the others wait");
    // Another game's lock of the same id is its own.
    const elsewhere = track(locks.hold([quiet], { binding: binding("valley"), waitMs: HOUR, holder: "d" }));
    await settle();
    assert.ok(granted(elsewhere), "another game's lock is free");
    for (const expected of ["b", "c"]) {
      const current = holds.find(({ holder }) => holder === holding().at(-1));
      order.push(current?.holder ?? "");
      current?.held.release?.();
      await settle();
      assert.equal(holding().at(-1), expected, `${expected} is next`);
    }
    assert.deepEqual(order, ["a", "b"]);
    // A lock per app is one lock across every game.
    const here = track(locks.hold([shared], { binding: binding("garden"), waitMs: HOUR, holder: "e" }));
    const there = track(locks.hold([shared], { binding: binding("valley"), waitMs: HOUR, holder: "f" }));
    await settle();
    assert.ok(granted(here));
    assert.equal(granted(there), false, "an app's lock is shared by every game");
    here.release?.();
    await settle();
    assert.ok(granted(there));
  });

  it("waits while the person uses it, and goes on once they stop", async () => {
    const { locks, clock, asked, said } = service([
      { personActive: true },
      { personActive: true },
      { personActive: false },
    ]);
    const held = track(locks.hold([bench], { binding: binding(), waitMs: HOUR, holder: "lead" }));
    await settle();
    assert.equal(asked.length, 1);
    assert.equal(granted(held), false, "the person is at it: the call waits");
    await clock.advance(PERSON_FIRST_POLL_MS);
    assert.equal(asked.length, 2);
    assert.equal(granted(held), false);
    await clock.advance(PERSON_FIRST_POLL_MS);
    assert.equal(asked.length, 3);
    assert.ok(granted(held), "granted once the person stopped");
    assert.deepEqual(said, [
      { label: "Bench", waiting: true, threadId: "t1" },
      { label: "Bench", waiting: false, threadId: "t1" },
    ]);
  });

  it("is refused, naming the lock, when the person keeps using it past the wait, or Genex can't tell", async () => {
    const rows: Array<[string, unknown[], RegExp, LockRefusal]> = [
      ["always at it", [{ personActive: true }], /you|person/i, LockRefusal.PersonFirst],
      ["the probe throws", [new Error("no editor")], /can't tell|could not tell/i, LockRefusal.CantTell],
      ["the probe answers nothing", [{}], /can't tell|could not tell/i, LockRefusal.CantTell],
      ["the probe answers a word", [{ personActive: "yes" }], /can't tell|could not tell/i, LockRefusal.CantTell],
      [
        "a count that is no count",
        [{ personActive: false, unsaved: -1 }],
        /can't tell|could not tell/i,
        LockRefusal.CantTell,
      ],
    ];
    for (const [name, answers, words, code] of rows) {
      const { locks, clock } = service(answers);
      const held = track(locks.hold([bench], { binding: binding(), waitMs: 3 * PERSON_FIRST_POLL_MS, holder: "lead" }));
      for (let poll = 0; poll < 4; poll++) await clock.advance(PERSON_FIRST_POLL_MS);
      assert.ok(held.error instanceof LockRefused, name);
      assert.equal(held.error.code, code, `${name}: why, typed`);
      assert.match(held.error.message, /Bench/, `${name}: the lock's label`);
      assert.match(held.error.message, words, name);
      assert.deepEqual(locks.holders(), [], `${name}: nothing is held`);
    }
  });

  it("a person's own action never waits for the person", async () => {
    const { locks, asked } = service([{ personActive: true }]);
    const held = track(locks.hold([bench], { binding: binding(), waitMs: HOUR, holder: "person", forPerson: true }));
    await settle();
    assert.ok(granted(held));
    assert.deepEqual(asked, [], "the probe is never asked");
  });

  it("Stop ends a wait and takes nothing", async () => {
    const { locks } = service();
    const first = track(locks.hold([quiet], { binding: binding(), waitMs: HOUR, holder: "a" }));
    const stop = new AbortController();
    const stopped = track(locks.hold([quiet], { binding: binding(), waitMs: HOUR, holder: "b", signal: stop.signal }));
    const next = track(locks.hold([quiet], { binding: binding(), waitMs: HOUR, holder: "c" }));
    await settle();
    stop.abort(new Error("stopped"));
    await settle();
    assert.match(String((stopped.error as Error)?.message), /stopped/);
    assert.deepEqual(
      locks.holders().map((held) => held.holder),
      ["a"],
    );
    first.release?.();
    await settle();
    assert.equal(granted(stopped), false);
    assert.ok(granted(next), "the next waiter is granted");
  });

  it("a wait Genex can't read the person's use from still waits, but never says the person is at it", async () => {
    for (const answers of [[new Error("busy editor")], [{}], [new Error("busy editor"), { personActive: false }]]) {
      const { locks, clock, said } = service(answers);
      const held = track(locks.hold([bench], { binding: binding(), waitMs: HOUR, holder: "lead" }));
      await settle();
      assert.equal(granted(held), false, "it waits while Genex can't tell");
      await clock.advance(PERSON_FIRST_POLL_MS);
      assert.deepEqual(said, [], "no line speaks of the person");
      held.release?.();
    }
    const { locks, clock, said } = service([new Error("busy editor"), { personActive: true }, { personActive: false }]);
    const held = track(locks.hold([bench], { binding: binding(), waitMs: HOUR, holder: "lead" }));
    await settle();
    await clock.advance(PERSON_FIRST_POLL_MS);
    await clock.advance(PERSON_FIRST_POLL_MS);
    assert.ok(granted(held));
    assert.deepEqual(
      said.map((line) => line.waiting),
      [true, false],
      "said once the probe saw the person, and taken back",
    );
  });

  it("Stop during a wait on the person takes the line back, holds nothing, and the next holder goes at once", async () => {
    const { locks, clock, said } = service([{ personActive: true }, { personActive: true }, { personActive: false }]);
    const stop = new AbortController();
    const held = track(locks.hold([bench], { binding: binding(), waitMs: HOUR, holder: "lead", signal: stop.signal }));
    await settle();
    await clock.advance(PERSON_FIRST_POLL_MS);
    assert.deepEqual(said.at(-1), { label: "Bench", waiting: true, threadId: "t1" });
    stop.abort(new Error("stopped by the person"));
    await settle();
    assert.match(String((held.error as Error)?.message), /stopped by the person/);
    assert.deepEqual(said.at(-1), { label: "Bench", waiting: false, threadId: "t1" }, "the waiting line is taken back");
    assert.deepEqual(locks.holders(), [], "nothing taken so far is kept");
    const next = track(locks.hold([bench], { binding: binding(), waitMs: HOUR, holder: "next", forPerson: true }));
    await settle();
    assert.ok(granted(next), "a later holder is granted at once");
  });

  it("two locks are taken in one order, so two callers never hold one each", async () => {
    const { locks } = service();
    const one = track(locks.hold([quiet, shared], { binding: binding(), waitMs: HOUR, holder: "a" }));
    const two = track(locks.hold([shared, quiet], { binding: binding(), waitMs: HOUR, holder: "b" }));
    await settle();
    assert.ok(granted(one));
    assert.equal(granted(two), false);
    assert.deepEqual(
      locks.holders().map((held) => held.holder),
      ["a", "a"],
      "the first holds both",
    );
    one.release?.();
    await settle();
    assert.ok(granted(two), "the second takes both once the first lets go");
  });

  it("a holder's own calls pass its lock, and still give way to the person", async () => {
    const { locks, clock, asked } = service([{ personActive: true }, { personActive: false }]);
    const writer = track(
      locks.hold([bench], { binding: binding(), waitMs: 0, holder: "w1", title: "Tune", personFirst: false }),
    );
    await settle();
    assert.ok(granted(writer), "an in-place writer takes the lock without asking the person");
    assert.equal(asked.length, 0);
    const other = track(locks.hold([bench], { binding: binding(), waitMs: HOUR, holder: "lead" }));
    const own = track(locks.hold([bench], { binding: binding(), waitMs: HOUR, holder: "w1" }));
    await settle();
    assert.equal(granted(own), false, "its own call waits for the person");
    await clock.advance(PERSON_FIRST_POLL_MS);
    assert.ok(granted(own), "then passes its own lock");
    assert.equal(granted(other), false, "another caller still waits its turn");
    own.release?.();
    await settle();
    assert.equal(granted(other), false, "the writer still holds it");
    writer.release?.();
    await settle();
    assert.ok(granted(other));
  });

  it("a chat hears one wait on the person while any of its calls waits, and its end once the last stops", async () => {
    const clock = manualClock();
    const said: Array<{ label: string; waiting: boolean; threadId?: string }> = [];
    let personActive = true;
    const locks = new LockService({
      probe: async () => ({ personActive }),
      now: clock.now,
      sleep: clock.sleep,
      onPersonFirst: ({ label, waiting, threadId }) => said.push({ label, waiting, threadId }),
    });
    locks.hold([bench], { binding: binding(), waitMs: 0, holder: "w1", title: "Tune", personFirst: false });
    await settle();
    const stop = new AbortController();
    const first = track(locks.hold([bench], { binding: binding(), waitMs: HOUR, holder: "w1", signal: stop.signal }));
    const second = track(locks.hold([bench], { binding: binding(), waitMs: HOUR, holder: "w1" }));
    await settle();
    assert.deepEqual(said, [{ label: "Bench", waiting: true, threadId: "t1" }], "one line for both waits");
    stop.abort(new Error("Stopped."));
    await settle();
    assert.ok(first.error, "the first call stopped waiting");
    assert.deepEqual(
      said,
      [{ label: "Bench", waiting: true, threadId: "t1" }],
      "the other still waits: the line stays",
    );
    personActive = false;
    await clock.advance(PERSON_FIRST_POLL_MS);
    assert.ok(granted(second));
    assert.deepEqual(said, [
      { label: "Bench", waiting: true, threadId: "t1" },
      { label: "Bench", waiting: false, threadId: "t1" },
    ]);
  });

  it("a harness that ends, planned or not, lets go of the holds it asked for, and only those", async () => {
    const { locks } = service();
    const writer = track(
      locks.hold([quiet], { binding: binding(), waitMs: 0, holder: "w1", personFirst: false, forHarness: true }),
    );
    const other = track(locks.hold([shared], { binding: binding(), waitMs: 0, holder: "lead" }));
    await settle();
    assert.ok(granted(writer) && granted(other));
    locks.releaseHarnessHolds();
    assert.deepEqual(
      locks.holders().map((held) => held.holder),
      ["lead"],
      "the writer the harness started holds nothing; another holder keeps its lock",
    );
    const next = track(locks.hold([quiet], { binding: binding(), waitMs: 0, holder: "w2" }));
    await settle();
    assert.ok(granted(next), "the game folder is free for the next writer");
  });

  it("a worker's holds all end with it, and a busy lock is refused at once with the holder's title", async () => {
    const { locks } = service();
    const writer = track(
      locks.hold([quiet, shared], { binding: binding(), waitMs: 0, holder: "w1", title: "Tune", personFirst: false }),
    );
    await settle();
    assert.ok(granted(writer));
    const busy = track(locks.hold([quiet], { binding: binding(), waitMs: 0, holder: "w2", title: "More" }));
    await settle();
    assert.ok(busy.error instanceof LockRefused);
    assert.equal(busy.error.code, LockRefusal.Busy);
    assert.match(busy.error.message, /Tune/);
    assert.match(busy.error.message, /Quiet room/);
    locks.releaseHolder("w2");
    assert.equal(locks.holders().length, 2, "another holder's release frees nothing");
    locks.releaseHolder("w1");
    assert.deepEqual(locks.holders(), []);
  });

  it("adds up what the probes say is unsaved, and can't tell when one can't", async () => {
    const rows: Array<[string, unknown[], number | null]> = [
      ["nothing unsaved", [{ personActive: false, unsaved: 0 }], 0],
      ["three unsaved", [{ personActive: false, unsaved: 3 }], 3],
      ["no count", [{ personActive: false }], null],
      ["a throw", [new Error("gone")], null],
    ];
    for (const [name, answers, expected] of rows) {
      const { locks } = service(answers);
      assert.equal(await locks.unsaved([bench], binding()), expected, name);
    }
    assert.equal(await service().locks.unsaved([quiet], binding()), null, "a lock with no probe can't tell");
    assert.equal(await service().locks.unsaved([], binding()), 0, "no lock, nothing unsaved");
  });

  it("a run's moment passes the locks the run's own workers hold; another run's or a chat's waits", async () => {
    const { locks } = service();
    const worker = workerHolder({ threadId: "t1", runId: "r1", id: "w1" });
    const life = { binding: binding(), waitMs: HOUR, holder: worker, personFirst: false, forHarness: true };
    const whole = track(locks.hold([quiet], life));
    await settle();
    assert.ok(granted(whole));
    const own = track(
      locks.hold([quiet], { binding: binding(), waitMs: HOUR, holder: "moment-1", passes: runHolders("r1") }),
    );
    const other = track(
      locks.hold([quiet], { binding: binding(), waitMs: HOUR, holder: "moment-2", passes: runHolders("r2") }),
    );
    const chat = track(locks.hold([quiet], { binding: binding(), waitMs: HOUR, holder: "moment-3" }));
    await settle();
    assert.ok(granted(own), "the run's own moment goes at once");
    assert.equal(granted(other), false, "another run's moment waits");
    assert.equal(granted(chat), false, "a chat's moment waits");
    own.release?.();
    whole.release?.();
    await settle();
    assert.ok(granted(other), "the next in turn once both let go");
  });

  it("two moments of a run that pass its writer's whole-life hold still go one at a time", async () => {
    const { locks } = service();
    const worker = workerHolder({ threadId: "t1", runId: "r1", id: "w1" });
    const life = { binding: binding(), waitMs: HOUR, holder: worker, personFirst: false, forHarness: true };
    const whole = track(locks.hold([quiet], life));
    await settle();
    assert.ok(granted(whole));
    const moment = (holder: string) =>
      track(locks.hold([quiet], { binding: binding(), waitMs: HOUR, holder, passes: runHolders("r1") }));
    const first = moment("moment-1");
    const second = moment("moment-2");
    await settle();
    assert.ok(granted(first), "the first passes the writer's hold");
    assert.equal(granted(second), false, "the second waits for the first, never beside it");
    first.release?.();
    await settle();
    assert.ok(granted(second), "then the second goes, still passing the writer's hold");
    second.release?.();
    whole.release?.();
    await settle();
    assert.deepEqual(locks.holders(), []);
  });

  it("a run's moment queued behind its writer joins the writer once the writer's whole-life hold is given", async () => {
    const { locks } = service();
    const call = track(locks.hold([quiet], { binding: binding(), waitMs: HOUR, holder: "lead" }));
    await settle();
    assert.ok(granted(call));
    const worker = workerHolder({ threadId: "t1", runId: "r1", id: "w1" });
    const life = { binding: binding(), waitMs: HOUR, holder: worker, personFirst: false, forHarness: true };
    const whole = track(locks.hold([quiet], life));
    const moment = track(
      locks.hold([quiet], { binding: binding(), waitMs: HOUR, holder: "moment-1", passes: runHolders("r1") }),
    );
    await settle();
    assert.equal(granted(whole) || granted(moment), false, "both wait for the lead's call");
    call.release?.();
    await settle();
    assert.ok(granted(whole), "the writer is next in turn");
    assert.ok(granted(moment), "and the run's moment passes it at once, never waiting out the writer's life");
    moment.release?.();
    whole.release?.();
    await settle();
    assert.deepEqual(locks.holders(), []);
  });

  it("a moment never passes a worker's hold for one call: it waits for that call to end", async () => {
    const { locks } = service();
    const reader = workerHolder({ threadId: "t1", runId: "r1", id: "w2" });
    const call = track(locks.hold([quiet], { binding: binding(), waitMs: HOUR, holder: reader }));
    await settle();
    assert.ok(granted(call));
    const moment = track(
      locks.hold([quiet], { binding: binding(), waitMs: HOUR, holder: "moment-3", passes: runHolders("r1") }),
    );
    await settle();
    assert.equal(granted(moment), false, "the moment waits while the worker's call runs");
    call.release?.();
    await settle();
    assert.ok(granted(moment), "and goes once it ends");
    moment.release?.();
  });

  it("a moment that passed a worker's lock keeps it when the worker ends first, until the moment lets go", async () => {
    const { locks } = service();
    const worker = workerHolder({ threadId: "t1", runId: "r1", id: "w1" });
    const life = { binding: binding(), waitMs: HOUR, holder: worker, personFirst: false, forHarness: true };
    const whole = track(locks.hold([quiet], life));
    await settle();
    const moment = track(
      locks.hold([quiet], { binding: binding(), waitMs: HOUR, holder: "moment-1", passes: runHolders("r1") }),
    );
    const next = track(locks.hold([quiet], { binding: binding(), waitMs: HOUR, holder: "lead" }));
    await settle();
    assert.ok(granted(whole) && granted(moment));
    locks.releaseHolder(worker);
    await settle();
    assert.equal(granted(next), false, "the moment still holds the lock it passed into");
    assert.deepEqual(
      locks.holders().map((held) => held.holder),
      ["moment-1"],
    );
    whole.release?.();
    await settle();
    assert.equal(granted(next), false, "the worker's late release frees nothing the moment holds");
    moment.release?.();
    await settle();
    assert.ok(granted(next), "the next in turn once the moment lets go");
  });

  it("a moment never joins a writer's own call on a lock its whole-life hold did not take", async () => {
    const { locks } = service();
    const worker = workerHolder({ threadId: "t1", runId: "r1", id: "w1" });
    const life = { binding: binding(), waitMs: 0, holder: worker, personFirst: false, forHarness: true };
    const whole = track(locks.hold([quiet], life));
    await settle();
    const call = track(locks.hold([shared], { binding: binding(), waitMs: HOUR, holder: worker, personFirst: false }));
    await settle();
    assert.ok(granted(whole) && granted(call));
    const moment = track(
      locks.hold([shared], { binding: binding(), waitMs: HOUR, holder: "moment-1", passes: runHolders("r1") }),
    );
    await settle();
    assert.equal(granted(moment), false, "the writer's call on another lock is one call: the moment waits for it");
    call.release?.();
    await settle();
    assert.ok(granted(moment), "and goes once that call ends");
    moment.release?.();
    whole.release?.();
  });

  it("a moment let in beside a writer keeps the lock to itself when the writer lets go in the same turn", async () => {
    const { locks } = service();
    const worker = workerHolder({ threadId: "t1", runId: "r1", id: "w1" });
    track(locks.hold([quiet], { binding: binding(), waitMs: 0, holder: worker, personFirst: false, forHarness: true }));
    await settle();
    const moment = (holder: string) =>
      track(locks.hold([quiet], { binding: binding(), waitMs: HOUR, holder, passes: runHolders("r1") }));
    const first = moment("moment-1");
    await settle();
    const second = moment("moment-2");
    const lead = track(locks.hold([quiet], { binding: binding(), waitMs: HOUR, holder: "lead" }));
    await settle();
    first.release?.();
    locks.releaseHolder(worker);
    await settle();
    assert.ok(granted(second), "the moment let in holds the lock");
    assert.equal(granted(lead), false, "one holder at a time: the lead waits for the moment");
    assert.deepEqual(
      locks.holders().map((held) => held.holder),
      ["moment-2"],
    );
    second.release?.();
    await settle();
    assert.ok(granted(lead), "the lead goes once the moment lets go");
  });

  it("a moment let in as its writer lets go, with nobody behind it, still holds the lock against a new caller", async () => {
    const { locks } = service();
    const worker = workerHolder({ threadId: "t1", runId: "r1", id: "w1" });
    track(locks.hold([quiet], { binding: binding(), waitMs: 0, holder: worker, personFirst: false, forHarness: true }));
    await settle();
    const moment = (holder: string) =>
      track(locks.hold([quiet], { binding: binding(), waitMs: HOUR, holder, passes: runHolders("r1") }));
    const first = moment("moment-1");
    await settle();
    const second = moment("moment-2");
    await settle();
    first.release?.();
    locks.releaseHolder(worker);
    await settle();
    assert.ok(granted(second));
    const late = track(locks.hold([quiet], { binding: binding(), waitMs: 0, holder: "lead" }));
    await settle();
    assert.ok(late.error instanceof LockRefused, "a new caller is refused while the moment holds the lock");
    assert.deepEqual(
      locks.holders().map((held) => held.holder),
      ["moment-2"],
    );
  });

  it("a run's moment queued behind a call that gives up joins its writer at once", async () => {
    const { locks, clock } = service();
    const worker = workerHolder({ threadId: "t1", runId: "r1", id: "w1" });
    track(locks.hold([quiet], { binding: binding(), waitMs: 0, holder: worker, personFirst: false, forHarness: true }));
    await settle();
    const moment = (holder: string) =>
      track(locks.hold([quiet], { binding: binding(), waitMs: 60_000, holder, passes: runHolders("r1") }));
    const first = moment("moment-1");
    await settle();
    const call = track(locks.hold([quiet], { binding: binding(), waitMs: 15_000, holder: "lead" }));
    await settle();
    const second = moment("moment-2");
    await settle();
    first.release?.();
    await settle();
    assert.equal(granted(second), false, "in turn behind the call");
    await clock.advance(15_000);
    assert.ok(call.error instanceof LockRefused);
    assert.ok(granted(second), "joins the writer once the call ahead gave up");
  });

  it("a passing moment whose wait runs out as it is let in holds nothing, and the next moment still joins the writer", async () => {
    const { locks, clock } = service();
    const worker = workerHolder({ threadId: "t1", runId: "r1", id: "w1" });
    track(locks.hold([quiet], { binding: binding(), waitMs: 0, holder: worker, personFirst: false, forHarness: true }));
    await settle();
    const moment = (holder: string, waitMs: number) =>
      track(locks.hold([quiet], { binding: binding(), waitMs, holder, passes: runHolders("r1") }));
    const first = moment("moment-1", HOUR);
    await settle();
    const second = moment("moment-2", 1000);
    await settle();
    // Its wait runs out, and one turn later the first moment's release lets it in: the wait answers first.
    const advancing = clock.advance(1000);
    await Promise.resolve();
    first.release?.();
    await advancing;
    assert.ok(second.error instanceof LockRefused, "refused: its wait ran out");
    const third = moment("moment-3", 0);
    await settle();
    assert.ok(granted(third), "nothing of the refused moment is left to stand in the next one's way");
  });

  it("a hold whose wait was already stopped takes nothing, free lock or fresh probe", async () => {
    const { locks } = service();
    const warm = track(locks.hold([bench], { binding: binding(), waitMs: HOUR, holder: "a" }));
    await settle();
    warm.release?.();
    await settle();
    const stopped = AbortSignal.abort(new Error("Stopped"));
    for (const ref of [quiet, bench]) {
      const held = track(locks.hold([ref], { binding: binding(), waitMs: HOUR, holder: "late", signal: stopped }));
      await settle();
      assert.equal(granted(held), false, ref.lock.id);
    }
    assert.deepEqual(locks.holders(), []);
  });

  it("a probe still unanswered when the wait runs out grants nothing: the call is refused at the wait's end", async () => {
    const clock = manualClock();
    let answer: (value: unknown) => void = () => {};
    let ended = false;
    const locks = new LockService({
      // A probe that answers only when the test says, and whose call ends when its signal does.
      probe: (_plugin, _lock, _binding, signal) =>
        new Promise((resolve, reject) => {
          answer = resolve;
          signal?.addEventListener("abort", () => {
            ended = true;
            reject(signal.reason);
          });
        }),
      now: clock.now,
      sleep: clock.sleep,
      timeout: (ms) => {
        const timer = new AbortController();
        clock.sleep(ms).then(() => timer.abort(new Error("the wait ran out")));
        return timer.signal;
      },
    });
    const held = track(locks.hold([bench], { binding: binding(), waitMs: AGENT_LOCK_WAIT_MS, holder: "lead" }));
    await settle();
    await clock.advance(AGENT_LOCK_WAIT_MS);
    assert.ok(ended, "the probe's call ended with the wait");
    assert.ok(held.error instanceof LockRefused, "refused once the wait ran out, the probe still asking");
    assert.equal((held.error as LockRefused).code, LockRefusal.CantTell);
    answer({ personActive: false });
    await settle();
    assert.equal(granted(held), false, "a late answer grants nothing");
    assert.deepEqual(locks.holders(), []);
  });

  /** A service whose probe answers `answers` in turn and then never settles, its call ended by its signal, on one clock. */
  function hangingAfter(answers: unknown[]) {
    const clock = manualClock();
    const said: boolean[] = [];
    const probes: Array<{ ended: boolean; answer: (value: unknown) => void }> = [];
    const locks = new LockService({
      probe: (_plugin, _lock, _binding, signal) => {
        const index = probes.length;
        const probe = { ended: false, answer: (_value: unknown) => {} };
        probes.push(probe);
        if (index < answers.length) return Promise.resolve(answers[index]);
        return new Promise((resolve, reject) => {
          probe.answer = resolve;
          signal?.addEventListener("abort", () => {
            probe.ended = true;
            reject(signal.reason);
          });
        });
      },
      now: clock.now,
      sleep: clock.sleep,
      timeout: (ms) => {
        const timer = new AbortController();
        clock.sleep(ms).then(() => timer.abort(new Error("the wait ran out")));
        return timer.signal;
      },
      onPersonFirst: ({ waiting }) => said.push(waiting),
    });
    return { locks, clock, said, probes };
  }

  it("a wait on the person that runs out is refused at its end, never probing again after it", async () => {
    const { locks, clock, said, probes } = hangingAfter([{ personActive: true }, { personActive: true }]);
    const waitMs = 2 * PERSON_FIRST_POLL_MS;
    const held = track(locks.hold([bench], { binding: binding(), waitMs, holder: "lead" }));
    await settle();
    await clock.advance(PERSON_FIRST_POLL_MS);
    await clock.advance(PERSON_FIRST_POLL_MS);
    assert.ok(held.error instanceof LockRefused, "refused at the wait's end");
    assert.equal((held.error as LockRefused).code, LockRefusal.PersonFirst, "in the words of the last answer");
    assert.deepEqual(locks.holders(), [], "nothing is held");
    assert.deepEqual(said, [true, false], "the waiting line is taken back");
    assert.ok(
      probes.slice(2).every((probe) => probe.ended),
      "no probe is still asking past the wait",
    );
    for (const probe of probes) probe.answer({ personActive: false });
    await settle();
    assert.equal(granted(held), false, "a late answer grants nothing");
    assert.deepEqual(locks.holders(), []);
  });

  it("a read of what is unsaved whose probe never answers can't tell once one short ask ran out, the probe's call ended", async () => {
    const { locks, clock, probes } = hangingAfter([]);
    let read: number | null | undefined;
    void locks.unsaved([bench], binding()).then((value) => {
      read = value;
    });
    await settle();
    assert.equal(read, undefined, "still asking");
    await clock.advance(PERSON_FIRST_ASK_MS);
    assert.equal(read, null, "Genex can't tell");
    assert.ok(probes[0]?.ended, "the probe's call ended with the ask");
  });

  it("a hold that may not wait asks the person's probe once, for a short while, and the next holder goes after", async () => {
    const { locks, clock, probes } = hangingAfter([]);
    const health = track(locks.hold([bench], { binding: binding(), waitMs: 0, holder: "health" }));
    const next = track(locks.hold([bench], { binding: binding(), waitMs: HOUR, holder: "next", forPerson: true }));
    await settle();
    assert.equal(probes.length, 1, "asked once");
    await clock.advance(PERSON_FIRST_ASK_MS);
    assert.ok(probes[0]?.ended, "its probe's call ended with that while");
    assert.ok(health.error instanceof LockRefused);
    assert.equal((health.error as LockRefused).code, LockRefusal.CantTell);
    assert.ok(granted(next), "the next holder is granted right after");
    next.release?.();
  });

  it("a hold of several locks with no wait left gets one short ask for all of them, never one per lock", async () => {
    const clock = manualClock();
    const asked: string[] = [];
    const locks = new LockService({
      // The bench's probe takes a while to say the person is not there; the cellar's never answers.
      probe: (_plugin, lock, _binding, signal) => {
        asked.push(lock.id);
        if (lock.id === "bench") return clock.sleep(3_000).then(() => ({ personActive: false }));
        return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason)));
      },
      now: clock.now,
      sleep: clock.sleep,
      timeout: (ms) => {
        const timer = new AbortController();
        clock.sleep(ms).then(() => timer.abort(new Error("the ask ran out")));
        return timer.signal;
      },
    });
    const CELLAR: PluginLock = { id: "cellar", label: "Cellar", per: LockScope.Project, personFirst: "busy" };
    const cellar = { plugin: "tl", lock: CELLAR };
    const held = track(locks.hold([bench, cellar], { binding: binding(), waitMs: 0, holder: "health" }));
    await settle();
    await clock.advance(3_000);
    assert.deepEqual(asked.toSorted(), ["bench", "cellar"], "both asked");
    await clock.advance(PERSON_FIRST_ASK_MS - 3_000);
    assert.ok(held.error instanceof LockRefused, "refused once the hold's one short ask ran out");
    assert.deepEqual(locks.holders(), []);
  });

  it("a hold whose turn comes just before its wait runs out still asks the person's probe for a short while", async () => {
    const clock = manualClock();
    const locks = new LockService({
      // The person is not at it, which the probe takes a moment to say.
      probe: () => clock.sleep(50).then(() => ({ personActive: false })),
      now: clock.now,
      sleep: clock.sleep,
      timeout: (ms) => {
        const timer = new AbortController();
        clock.sleep(ms).then(() => timer.abort(new Error("the wait ran out")));
        return timer.signal;
      },
    });
    const first = track(locks.hold([bench], { binding: binding(), waitMs: HOUR, holder: "a", forPerson: true }));
    await settle();
    assert.ok(granted(first));
    const next = track(locks.hold([bench], { binding: binding(), waitMs: 30_000, holder: "b" }));
    await clock.advance(29_990);
    first.release?.();
    await settle();
    await clock.advance(50);
    assert.equal(next.error, null, String(next.error));
    assert.ok(granted(next), "granted: the probe had its short while to say the person is not at it");
    next.release?.();
  });

  it("a probe that sees the person at it takes back an earlier 'not at it': the holder's next call asks again", async () => {
    const clock = manualClock();
    const answers: Array<(answer: unknown) => void> = [];
    const locks = new LockService({
      // Each probe answers when the test says, in any order.
      probe: () => new Promise((resolve) => answers.push(resolve)),
      now: clock.now,
      sleep: clock.sleep,
    });
    const holder = "lead";
    const hold = () => track(locks.hold([bench], { binding: binding(), waitMs: HOUR, holder }));
    const first = hold();
    const second = hold();
    await settle();
    assert.equal(answers.length, 2, "both ask at once");
    answers[0]?.({ personActive: false });
    await settle();
    assert.ok(granted(first));
    answers[1]?.({ personActive: true });
    await settle();
    assert.equal(granted(second), false, "the later answer sees the person at it");
    const third = hold();
    await settle();
    assert.equal(answers.length, 3, "the next call asks the probe again, never trusting the earlier answer");
    answers[2]?.({ personActive: true });
    await settle();
    assert.equal(granted(third), false, "and waits for the person too");
  });

  it("a hold queued behind a call that waits on the person is refused as the person's, never as busy", async () => {
    const { locks, clock } = service([{ personActive: true }]);
    const agent = track(locks.hold([bench], { binding: binding(), waitMs: AGENT_LOCK_WAIT_MS, holder: "agent" }));
    await settle();
    const moment = track(locks.hold([bench], { binding: binding(), waitMs: 60_000, holder: "moment" }));
    await clock.advance(60_000);
    assert.ok(moment.error instanceof LockRefused, String(moment.error));
    assert.equal((moment.error as LockRefused).code, LockRefusal.PersonFirst);
    await clock.advance(AGENT_LOCK_WAIT_MS);
    assert.ok(agent.error instanceof LockRefused);
  });

  it("a call right after one refused for the person asks once, briefly, instead of waiting it all again", async () => {
    const { locks, clock, asked } = service([{ personActive: true }]);
    const first = track(locks.hold([bench], { binding: binding(), waitMs: AGENT_LOCK_WAIT_MS, holder: "a" }));
    await settle();
    await clock.advance(AGENT_LOCK_WAIT_MS);
    assert.ok(first.error instanceof LockRefused);
    const next = track(locks.hold([bench], { binding: binding(), waitMs: AGENT_LOCK_WAIT_MS, holder: "b" }));
    await settle();
    await clock.advance(PERSON_FIRST_ASK_MS);
    assert.ok(next.error instanceof LockRefused, "refused after one short ask");
    assert.equal((next.error as LockRefused).code, LockRefusal.PersonFirst);
    const before = asked.length;
    await clock.advance(PERSON_REFUSAL_STANDS_MS);
    const later = track(locks.hold([bench], { binding: binding(), waitMs: AGENT_LOCK_WAIT_MS, holder: "c" }));
    await settle();
    await clock.advance(PERSON_FIRST_ASK_MS);
    assert.equal(later.error, null, "long after the refusal, a call waits its whole wait again");
    assert.ok(asked.length > before);
  });

  it("a refusal for the person stands only while the person is still at it", async () => {
    const { locks, clock } = service([{ personActive: true }, { personActive: false }]);
    const first = track(locks.hold([bench], { binding: binding(), waitMs: PERSON_FIRST_POLL_MS, holder: "a" }));
    await settle();
    await clock.advance(PERSON_FIRST_POLL_MS);
    assert.ok(first.error instanceof LockRefused);
    const next = track(locks.hold([bench], { binding: binding(), waitMs: AGENT_LOCK_WAIT_MS, holder: "b" }));
    await settle();
    await clock.advance(PERSON_FIRST_ASK_MS);
    assert.ok(granted(next), "the person stopped: granted at once");
  });

  it("a probe that lets an agent go ahead of the person tells the chat the call answers to, once per answer", async () => {
    const clock = manualClock();
    const ahead: Array<{ project: string; threadId?: string; label: string; plugin: string }> = [];
    const answers = [{ personActive: false, wentAhead: true }, { personActive: false }];
    let asked = 0;
    const locks = new LockService({
      probe: async () => answers[Math.min(asked++, answers.length - 1)],
      now: clock.now,
      sleep: clock.sleep,
      onWentAhead: (notice) => ahead.push(notice),
    });
    const first = await locks.hold([bench], { binding: binding(), waitMs: AGENT_LOCK_WAIT_MS, holder: "a" });
    first();
    await clock.advance(PERSON_FIRST_FRESH_MS);
    const second = await locks.hold([bench], { binding: binding(), waitMs: AGENT_LOCK_WAIT_MS, holder: "b" });
    second();
    assert.deepEqual(ahead, [{ project: "garden", threadId: "t1", label: "Bench", plugin: "tl" }]);
    assert.equal(await locks.unsaved([bench], binding()), null, "a read of what is unsaved tells nothing");
    assert.equal(ahead.length, 1);
  });

  it("names a worker by the run or the chat it works for", () => {
    assert.notEqual(
      workerHolder({ threadId: "t1", runId: null, id: "w1" }),
      workerHolder({ threadId: "t1", runId: "run-1", id: "w1" }),
    );
    assert.notEqual(
      workerHolder({ threadId: "t1", runId: null, id: "w1" }),
      workerHolder({ threadId: "t2", runId: null, id: "w1" }),
    );
  });
});

// ── a real core ─────────────────────────────────────────────────────────────────────────────

const PROJECT = "bench-game";
const PLUGIN_ID = "tl";

/**
 * The test plugin's backend: `paint` logs its start, waits for a `release` file, logs its end; `stamp`
 * (a card, no lock) logs and waits the same way; `busy` reads `person.json`.
 */
const BACKEND = `
import { access, appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
export async function activate() {
  return {
    async tool(name, _args, ctx) {
      const dir = ctx.directory;
      if (name === "busy") {
        try { return JSON.parse(await readFile(path.join(dir, "person.json"), "utf8")); }
        catch { return { personActive: false }; }
      }
      if (name === "varnish") {
        await appendFile(path.join(dir, "paint.log"), "varnish\\n");
        return { varnished: true };
      }
      if (name === "sand") {
        await appendFile(path.join(dir, "paint.log"), "sand\\n");
        return { sanded: true };
      }
      if (name === "stamp") {
        await appendFile(path.join(dir, "paint.log"), "stamp\\n");
        for (;;) { try { await access(path.join(dir, "release")); break; } catch { await sleep(20); } }
        return { stamped: true };
      }
      if (name === "paint") {
        await appendFile(path.join(dir, "paint.log"), "start\\n");
        for (;;) { try { await access(path.join(dir, "release")); break; } catch { await sleep(20); } }
        await appendFile(path.join(dir, "paint.log"), "end\\n");
        return { painted: true };
      }
      return { ran: name };
    },
  };
}
`;

/** The connector's server: one tool, `look`, listed and answered (the test stands in for its calls). */
const SERVER = `
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const TOOLS = [{ name: "look", description: "Look.", inputSchema: { type: "object", properties: {} } }];
process.stdin.setEncoding("utf8");
let buffer = "";
for await (const chunk of process.stdin) {
  buffer += chunk;
  for (let i = buffer.indexOf("\\n"); i >= 0; i = buffer.indexOf("\\n")) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    const { id, method, params } = JSON.parse(line);
    if (id === undefined || id === null) continue;
    if (method === "initialize") send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "bench", version: "1.0.0" } } });
    else if (method === "tools/list") send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    else send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "looked" }] } });
  }
}
`;

async function lockPackage(): Promise<string> {
  const dir = await tmpDir("studio-lock-plugin-");
  const empty = { type: "object", properties: {} };
  const manifest = {
    apiVersion: 3,
    id: PLUGIN_ID,
    version: "1.0.0",
    name: "Lock demo",
    publisher: "Studio tests",
    description: "A bench one holder at a time may use.",
    backend: "backend.mjs",
    capabilities: [],
    locks: [{ id: "bench", label: "Bench", per: "project", personFirst: "busy" }],
    hooks: [
      { on: "crash", tool: "sand" },
      { on: "checkpoint.before", tool: "sand" },
      { on: "restore.before", tool: "sand" },
    ],
    tools: [
      { name: "paint", description: "Paint at the bench.", parameters: empty, needs: ["bench"] },
      { name: "plain", description: "Needs nothing.", parameters: empty },
      {
        name: "varnish",
        description: "Varnish the bench.",
        confirmation: "Varnish the bench?",
        parameters: empty,
        needs: ["bench"],
      },
      { name: "stamp", description: "Stamp the sheet.", confirmation: "Stamp the sheet?", parameters: empty },
      { name: "busy", audience: "harness", description: "Whether the person is at the bench.", parameters: empty },
      { name: "sand", audience: "harness", description: "Sand at the bench.", parameters: empty, needs: ["bench"] },
    ],
    skills: [],
    panels: [],
    settings: [],
    actions: [],
    mcpServers: [
      {
        id: "desk",
        transport: "stdio",
        command: "node",
        args: ["server.mjs"],
        cwd: "storage:project",
        description: "The bench's own connector.",
        needs: ["bench"],
      },
    ],
  };
  await writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest, null, 2));
  await writeFile(path.join(dir, "backend.mjs"), BACKEND);
  await writeFile(path.join(dir, "server.mjs"), SERVER);
  return dir;
}

type Api = Record<string, (input: unknown) => Promise<unknown>>;

describe("locks in a real core", () => {
  let lite: CoreLite;
  let threadId: string;
  let api: Api;
  let dir: string;
  const events: UiEventEnvelope[] = [];
  // The locks' clock moves only when a test moves it: a wait for another holder never runs out here.
  const clock = manualClock();

  /** One host method, as the harness calls it. */
  const call = (method: string, params: unknown) => {
    const handler = api[method];
    assert.ok(handler, method);
    return handler(params);
  };
  const paintLog = async (): Promise<string[]> =>
    (await readFile(path.join(dir, "paint.log"), "utf8").catch(() => "")).split("\n").filter(Boolean);
  const invoke = (name: string) => call(HostMethod.PluginsInvoke, { project: PROJECT, threadId, name, args: {} });
  const person = (answer: unknown) => writeFile(path.join(dir, "person.json"), JSON.stringify(answer));
  const reset = async () => {
    await writeFile(path.join(dir, "paint.log"), "");
    await person({ personActive: false });
    await rm(path.join(dir, "release"), { force: true });
    // What the person was doing a moment ago is asked again.
    await clock.advance(PERSON_FIRST_FRESH_MS);
  };
  /** Waits (in real time, bounded) until the paint log has `count` lines. */
  const linesAtLeast = async (count: number) => {
    for (let tries = 0; tries < 200 && (await paintLog()).length < count; tries++) await settle();
    for (let tries = 0; tries < 100 && (await paintLog()).length < count; tries++) await sleep(20);
  };

  before(async () => {
    lite = await coreLite({
      onUiEvent: (event) => events.push(event),
      locks: { now: clock.now, sleep: clock.sleep, agentWaitMs: 3 * PERSON_FIRST_POLL_MS },
    });
    await lite.core.games.scaffold(PROJECT);
    dir = lite.core.games.dirFor(PROJECT);
    threadId = await lite.core.createGameThread(PROJECT);
    await lite.core.setPermissionMode(threadId, PermissionMode.Bypass);
    await lite.core.plugins.installLocal(await lockPackage(), PluginSourceKind.Github, [], FROM_GITHUB);
    await lite.core.plugins.setEnabled(PLUGIN_ID, true);
    // Its agent tools would ask the person first; these cases are about locks, so the person allows them.
    personAllowsLocalTools(lite.core.plugins);
    api = lite.api() as unknown as Api;
    await mkdir(dir, { recursive: true });
  });

  after(async () => {
    lite.core.plugins.cancel();
    await lite.core.mcp.close().catch(() => {});
    await lite.close();
  });

  it("an agent's call of a tool that needs a lock waits for another holder, then runs", async () => {
    await reset();
    const first = invoke(`${PLUGIN_ID}__paint`);
    const second = invoke(`${PLUGIN_ID}__paint`);
    await linesAtLeast(1);
    await sleep(200);
    assert.deepEqual(await paintLog(), ["start"], "the second call waits for the first");
    await writeFile(path.join(dir, "release"), "");
    assert.deepEqual(await first, { painted: true });
    assert.deepEqual(await second, { painted: true });
    assert.deepEqual(await paintLog(), ["start", "end", "start", "end"]);
    assert.deepEqual(lite.core.locks.holders(), [], "both let go");
  });

  it("an agent's call the plugin lets go ahead of the person runs, and its chat is told once in a line of its own", async () => {
    await reset();
    await person({ personActive: false, wentAhead: true });
    const painted = invoke(`${PLUGIN_ID}__paint`);
    await linesAtLeast(1);
    await writeFile(path.join(dir, "release"), "");
    assert.deepEqual(await painted, { painted: true });
    const told = (await lite.core.store.listEvents(threadId)).flatMap((event) => {
      const payload = customEvent(event, CustomEvent.AgentWentAhead);
      return payload ? [payload] : [];
    });
    assert.deepEqual(told, [{ project: PROJECT, pluginId: PLUGIN_ID, label: "Bench" }]);
  });

  it("an agent's call waits while the person is busy, and answers the lock's words past the wait", async () => {
    await reset();
    events.length = 0;
    await person({ personActive: true });
    const call = invoke(`${PLUGIN_ID}__paint`);
    let settled = false;
    void call.finally(() => {
      settled = true;
    });
    // Each poll asks the plugin again; the clock moves on only once the call is waiting.
    for (let polls = 0; polls < 50 && !settled; polls++) {
      await sleep(30);
      await clock.advance(PERSON_FIRST_POLL_MS);
    }
    const answer = (await call) as { blocker?: string; message?: string; lock?: string };
    assert.equal(answer.blocker, PluginCallBlocker.Lock);
    assert.equal(answer.lock, "Bench");
    assert.match(String(answer.message), /Bench/);
    assert.deepEqual(await paintLog(), [], "nothing ran");
    const records = (await lite.core.store.listEvents(threadId)).flatMap((event) =>
      event.data.type === EventKind.Custom && event.data.event_type === CustomEvent.PluginTool
        ? [event.data.payload]
        : [],
    ) as Array<{ toolName?: string; ok?: boolean; error?: string }>;
    const closed = records.findLast((record) => record.toolName === `${PLUGIN_ID}__paint`);
    assert.equal(closed?.ok, false, "the call's record is closed as not run");
    assert.match(String(closed?.error), /Bench/, "with the lock's words");
    const waits = events.filter((event) => event.type === UiEvent.PersonFirst).map((event) => event.payload);
    assert.deepEqual(waits, [
      { project: PROJECT, threadId, label: "Bench", waiting: true },
      { project: PROJECT, threadId, label: "Bench", waiting: false },
    ]);
    await person({ personActive: false });
    await writeFile(path.join(dir, "release"), "");
    assert.deepEqual(await invoke(`${PLUGIN_ID}__paint`), { painted: true }, "it runs once the person is done");
  });

  it("an agent's call with arguments its tool refuses is refused at once, never waiting for the lock first", async () => {
    await reset();
    const writer = { project: PROJECT, threadId, holder: { id: "w6", title: "Glue" } };
    assert.deepEqual(await call(HostMethod.LocksHold, writer), { held: true, labels: ["Bench"] });
    try {
      const refused = call(HostMethod.PluginsInvoke, {
        project: PROJECT,
        threadId,
        name: `${PLUGIN_ID}__paint`,
        args: { coat: 3 },
      }).then(
        () => "answered",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      const outcome = await Promise.race([refused, sleep(1000).then(() => "still waiting")]);
      assert.match(outcome, /coat/, "refused for its arguments while another holder keeps the bench");
      assert.deepEqual(await paintLog(), [], "nothing ran");
    } finally {
      await call(HostMethod.LocksRelease, writer);
    }
  });

  it("an agent's call holds no lock while its card waits for the person, and a declined card takes nothing", async () => {
    await reset();
    const asking = await lite.core.createGameThread(PROJECT);
    const cards = async () =>
      (await lite.core.listAllEvents()).flatMap((event) =>
        event.data.type === EventKind.Custom && event.data.event_type === CustomEvent.PluginConsent
          ? [event.data.payload as { consentId: string; state: string; threadId?: string }]
          : [],
      );
    const known = new Set((await cards()).map((card) => card.consentId));
    const varnish = call(HostMethod.PluginsInvoke, {
      project: PROJECT,
      threadId: asking,
      name: `${PLUGIN_ID}__varnish`,
      args: {},
    });
    let card: { consentId: string } | undefined;
    for (let tries = 0; tries < 200 && !card; tries++) {
      card = (await cards()).find((c) => c.state === "pending" && !known.has(c.consentId));
      if (!card) await sleep(20);
    }
    assert.ok(card, "the call asks its card");
    assert.deepEqual(lite.core.locks.holders(), [], "nothing is held while the card waits");
    const other = { project: PROJECT, threadId, holder: { id: "w8", title: "Polish" } };
    assert.deepEqual(
      await call(HostMethod.LocksHold, other),
      { held: true, labels: ["Bench"] },
      "another holder goes at once",
    );
    await call(HostMethod.LocksRelease, other);
    lite.core.resolveConsent(card.consentId, false);
    assert.equal(((await varnish) as { consent?: string }).consent, "declined");
    assert.deepEqual(lite.core.locks.holders(), [], "a declined call took nothing");
    assert.deepEqual(await paintLog(), [], "and never ran");
  });

  it("a plugin turned off while its call waits its turn is refused once granted: its backend never runs", async () => {
    await reset();
    await writeFile(path.join(dir, "release"), "");
    // The person was just asked and is not at the bench: the call's turn, once it comes, asks no probe.
    assert.deepEqual(await invoke(`${PLUGIN_ID}__paint`), { painted: true });
    await writeFile(path.join(dir, "paint.log"), "");
    const writer = { project: PROJECT, threadId, holder: { id: "w9", title: "Glue" } };
    assert.deepEqual(await call(HostMethod.LocksHold, writer), { held: true, labels: ["Bench"] });
    const waiting = outcomeOf(invoke(`${PLUGIN_ID}__paint`));
    try {
      await sleep(200);
      assert.deepEqual(await paintLog(), [], "the call waits behind the writer");
      await lite.core.plugins.setEnabled(PLUGIN_ID, false);
      await call(HostMethod.LocksRelease, writer);
      assert.match(await waiting, /Plugin tl is unavailable/, "refused as a plugin turned off, once its turn came");
      assert.deepEqual(await paintLog(), [], "its backend never ran");
      assert.deepEqual(lite.core.locks.holders(), []);
    } finally {
      await call(HostMethod.LocksRelease, writer);
      await lite.core.plugins.setEnabled(PLUGIN_ID, true);
    }
  });

  it("a run's call waiting for the person is told in the chat the run was started from, never the run's own thread", async () => {
    await reset();
    events.length = 0;
    await person({ personActive: true });
    const runId = "run-told";
    await lite.core.append([customEventData(CustomEvent.RunRegistered, { runId, project: PROJECT })], threadId);
    const call = ownService(lite).invokePluginTool(
      `${PLUGIN_ID}__paint`,
      {},
      { project: PROJECT, directory: dir, threadId: "run-told-thread" },
      undefined,
      { engine: "claude-code", director: { runId } },
    );
    let settled = false;
    void call.finally(() => {
      settled = true;
    });
    // The clock moves on only once the call waits on the person.
    const waiting = () => events.some((event) => event.type === UiEvent.PersonFirst);
    for (let tries = 0; tries < 100 && !waiting() && !settled; tries++) await sleep(20);
    for (let polls = 0; polls < 50 && !settled; polls++) {
      await sleep(30);
      await clock.advance(PERSON_FIRST_POLL_MS);
    }
    const answer = (await call) as { blocker?: string };
    assert.equal(answer.blocker, PluginCallBlocker.Lock, "it waited, then was told why");
    const told = events.filter((event) => event.type === UiEvent.PersonFirst).map((event) => event.payload);
    assert.deepEqual(told, [
      { project: PROJECT, threadId, label: "Bench", waiting: true },
      { project: PROJECT, threadId, label: "Bench", waiting: false },
    ]);
  });

  it("a harness step that needs a lock is answered why, and not run, while the person keeps using it", async () => {
    await reset();
    await person({ personActive: true });
    const step = call(HostMethod.PluginsInvoke, {
      project: PROJECT,
      threadId,
      name: `${PLUGIN_ID}__sand`,
      args: {},
      step: true,
    });
    let settled = false;
    void step.finally(() => {
      settled = true;
    });
    for (let polls = 0; polls < 50 && !settled; polls++) {
      await sleep(30);
      await clock.advance(PERSON_FIRST_POLL_MS);
    }
    const answer = (await step) as { blocker?: string; lock?: string; message?: string };
    assert.equal(answer.blocker, PluginCallBlocker.Lock);
    assert.equal(answer.lock, "Bench");
    assert.deepEqual(await paintLog(), [], "the step never ran");
    await person({ personActive: false });
    await clock.advance(PERSON_FIRST_FRESH_MS);
    assert.deepEqual(
      await call(HostMethod.PluginsInvoke, {
        project: PROJECT,
        threadId,
        name: `${PLUGIN_ID}__sand`,
        args: {},
        step: true,
      }),
      { sanded: true },
      "it runs once the person is done",
    );
  });

  it("a connector that needs a lock holds it for its call", async () => {
    await reset();
    const gates: Array<() => void> = [];
    const order: string[] = [];
    const tool = lite.core.mcp.tool;
    lite.core.mcp.tool = (async () => {
      order.push("start");
      await new Promise<void>((resolve) => gates.push(resolve));
      order.push("end");
      return "ok";
    }) as typeof tool;
    try {
      const look = () =>
        call(HostMethod.McpInvoke, { project: PROJECT, threadId, name: `${PLUGIN_ID}-desk__look`, args: {} });
      const first = look();
      const second = look();
      void first.catch((error: unknown) => order.push(`first failed: ${String(error)}`));
      void second.catch((error: unknown) => order.push(`second failed: ${String(error)}`));
      for (let tries = 0; tries < 200 && order.length < 1; tries++) await sleep(20);
      await sleep(200);
      assert.deepEqual(order, ["start"], "the second connector call waits for the first");
      // Either call may reach the lock first (each is asked its consent before): whichever holds it ends first.
      gates.shift()?.();
      await Promise.race([first, second]);
      for (let tries = 0; tries < 200 && order.length < 3; tries++) await sleep(20);
      gates.shift()?.();
      await Promise.all([first, second]);
      assert.deepEqual(order, ["start", "end", "start", "end"]);
    } finally {
      lite.core.mcp.tool = tool;
    }
  });

  it("a connector call refused its lock while the person keeps using it is answered why, its record closed, nothing held", async () => {
    await reset();
    events.length = 0;
    await person({ personActive: true });
    const tool = lite.core.mcp.tool;
    let reached = 0;
    lite.core.mcp.tool = (async () => {
      reached += 1;
      return "looked";
    }) as typeof tool;
    try {
      const look = call(HostMethod.McpInvoke, {
        project: PROJECT,
        threadId,
        name: `${PLUGIN_ID}-desk__look`,
        args: {},
      });
      let settled = false;
      void look.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      for (let polls = 0; polls < 50 && !settled; polls++) {
        await sleep(30);
        await clock.advance(PERSON_FIRST_POLL_MS);
      }
      await assert.rejects(look, /Bench/, "the call is refused naming the lock");
      assert.equal(reached, 0, "the connector was never called");
      const records = (await lite.core.store.listEvents(threadId)).flatMap((event) =>
        event.data.type === EventKind.Custom && event.data.event_type === CustomEvent.ConnectorTool
          ? [event.data.payload]
          : [],
      ) as Array<{ ok?: boolean; error?: string }>;
      assert.equal(records.at(-1)?.ok, false, "its record is closed as not run");
      assert.match(String(records.at(-1)?.error), /Bench/, "with the lock's words");
      const waits = events.filter((event) => event.type === UiEvent.PersonFirst).map((event) => event.payload);
      assert.deepEqual(waits, [
        { project: PROJECT, threadId, label: "Bench", waiting: true },
        { project: PROJECT, threadId, label: "Bench", waiting: false },
      ]);
      assert.deepEqual(lite.core.locks.holders(), [], "nothing is held after the refusal");
    } finally {
      lite.core.mcp.tool = tool;
    }
  });

  it("a connector whose own call time takes all of the call's leaves it no wait for the person: refused after one short ask", async () => {
    await reset();
    events.length = 0;
    await person({ personActive: true });
    const { tool, callTimeoutOf } = lite.core.mcp;
    let reached = 0;
    lite.core.mcp.tool = (async () => {
      reached += 1;
      return "looked";
    }) as typeof tool;
    // Its connector's own time for one call leaves five seconds of the agent's call.
    lite.core.mcp.callTimeoutOf = () => BRIDGE_TOOL_DEADLINE_MS - 10_000;
    try {
      const look = call(HostMethod.McpInvoke, {
        project: PROJECT,
        threadId,
        name: `${PLUGIN_ID}-desk__look`,
        args: {},
      });
      let settled = false;
      void look.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      for (let polls = 0; polls < 50 && !settled; polls++) {
        await sleep(30);
        await clock.advance(PERSON_FIRST_POLL_MS);
      }
      await assert.rejects(look, /Bench/, "refused naming the lock");
      assert.deepEqual(
        events.filter((event) => event.type === UiEvent.PersonFirst),
        [],
        "it never waited for the person: the chat was never told it does",
      );
      assert.equal(reached, 0, "the connector was never called");
      assert.deepEqual(lite.core.locks.holders(), []);
    } finally {
      lite.core.mcp.tool = tool;
      lite.core.mcp.callTimeoutOf = callTimeoutOf;
    }
  });

  it("a lock is taken only for what the manifest says", async () => {
    await reset();
    const hold = (params: Record<string, unknown>) => call(HostMethod.LocksHold, params);
    const release = (params: Record<string, unknown>) => call(HostMethod.LocksRelease, params);
    const writer = { project: PROJECT, threadId, holder: { id: "w1", title: "Tune" } };
    assert.deepEqual(await hold(writer), { held: true, labels: ["Bench"] });
    // A tool that needs nothing runs while the bench is held, and takes nothing.
    assert.deepEqual(await invoke(`${PLUGIN_ID}__plain`), { ran: "plain" });
    assert.deepEqual(
      lite.core.locks.holders().map((held) => held.holder),
      [workerHolder({ threadId, runId: null, id: "w1" }), workerHolder({ threadId, runId: null, id: "w1" })],
    );
    const hostile: Array<[string, Record<string, unknown>]> = [
      ["an unknown game", { ...writer, project: "no-such-game", holder: { id: "w2", title: "x" } }],
      ["a game that climbs", { ...writer, project: "../outside", holder: { id: "w2", title: "x" } }],
      ["a game named '..'", { ...writer, project: "..", holder: { id: "w2", title: "x" } }],
      ["a game named by an absolute path", { ...writer, project: dir, holder: { id: "w2", title: "x" } }],
      ["a holder id that climbs", { ...writer, holder: { id: "../x", title: "x" } }],
      ["a holder id with a slash", { ...writer, holder: { id: "a/b", title: "x" } }],
      ["a ten-kilobyte title", { ...writer, holder: { id: "w3", title: "x".repeat(10_240) } }],
      ["no holder", { project: PROJECT, threadId }],
    ];
    for (const [name, params] of hostile) await assert.rejects(hold(params), name);
    // The shape alone refuses a holder the host could not name a lock by.
    assert.ok(harnessParamsProblem(HostMethod.LocksHold, { ...writer, holder: { id: "../x", title: "x" } }));
    assert.equal(lite.core.locks.holders().length, 2, "no refused hold took anything");
    // Another holder's release frees nothing.
    await release({ project: PROJECT, threadId, holder: { id: "w9" } });
    assert.equal(lite.core.locks.holders().length, 2);
    // A second writer is told who works there now.
    const busy = (await hold({ ...writer, holder: { id: "w2", title: "More" } })) as { busy?: string };
    assert.match(String(busy.busy), /Tune/);
    await release({ project: PROJECT, threadId, holder: { id: "w1" } });
    assert.deepEqual(lite.core.locks.holders(), []);
  });

  it("a writer in place the harness started holds nothing once a self-update restarts the harness", async () => {
    await reset();
    const writer = { project: PROJECT, threadId, holder: { id: "w7", title: "Sand" } };
    const seen: number[] = [];
    const { restart, healthcheck } = lite.core.host;
    lite.core.host.restart = (async () => {
      seen.push(lite.core.locks.holders().length);
    }) as never;
    // The new self answers: the update is applied, and nothing rewinds this core's harness.
    lite.core.host.healthcheck = (async () => true) as never;
    try {
      assert.deepEqual(await call(HostMethod.LocksHold, writer), { held: true, labels: ["Bench"] });
      await lite.core.requestSelfRestart("test", 0);
      for (let tries = 0; tries < 100 && seen.length < 1; tries++) await sleep(20);
      // The applied update's own record is written after the restart: let it land before the stubs go.
      await sleep(100);
    } finally {
      lite.core.host.restart = restart;
      lite.core.host.healthcheck = healthcheck;
    }
    assert.deepEqual(seen, [0], "the restart found the game free");
    assert.deepEqual(lite.core.locks.holders(), []);
  });

  /** The planned restarts and the watchdog's rewind, each started as the core starts it. */
  const restarts: Array<[string, () => Promise<unknown>]> = [
    ["a self-update", () => lite.core.requestSelfRestart("test", 0)],
    [
      "the person's rollback",
      async () =>
        lite.core.rollbackTo((await lite.core.snapshot(SnapshotScope.Harness, "a rollback point")).snapshot_id),
    ],
    ["the watchdog's rewind", () => lite.core.recover("harness stopped responding for 600s")],
  ];
  for (const [name, restartBy] of restarts)
    it(`${name} stops the old harness before it ends the moments that harness asked for`, async () => {
      await reset();
      await person({ personActive: true });
      events.length = 0;
      const order: string[] = [];
      let settled = false;
      const checkpoint = call(HostMethod.CheckpointTake, { project: PROJECT, threadId, label: "Before the restart" });
      void checkpoint.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      for (let tries = 0; tries < 100 && !events.some((event) => event.type === UiEvent.PersonFirst); tries++)
        await sleep(20);
      const { restart, healthcheck, stop } = lite.core.host;
      lite.core.host.stop = (async () => {
        order.push(settled ? "stopped after its moment ended" : "stopped while its moment ran");
      }) as never;
      lite.core.host.restart = (async () => {
        order.push("restarted");
      }) as never;
      lite.core.host.healthcheck = (async () => true) as never;
      try {
        await restartBy();
        for (let tries = 0; tries < 100 && !order.includes("restarted"); tries++) await sleep(20);
        await sleep(100);
      } finally {
        lite.core.host.stop = stop;
        lite.core.host.restart = restart;
        lite.core.host.healthcheck = healthcheck;
      }
      assert.equal(order[0], "stopped while its moment ran", `no live harness hears its moment stopped: ${order}`);
      assert.equal(order.at(-1), "restarted");
      assert.ok(settled, "the moment ended with the old harness");
      assert.deepEqual(lite.core.locks.holders(), []);
    });

  it("calls a harness made whose handler was still reading as it died run stopped: no step runs, nothing is called or held", async () => {
    await reset();
    const { kindOf } = lite.core.games;
    const { pluginBinding } = lite.core;
    const { tool } = lite.core.mcp;
    let reached = 0;
    lite.core.mcp.tool = (async () => {
      reached += 1;
      return "looked";
    }) as typeof tool;
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    // Each handler is still reading the game when the harness dies.
    lite.core.games.kindOf = (async (project: string) => {
      await gate;
      return kindOf.call(lite.core.games, project);
    }) as typeof kindOf;
    lite.core.pluginBinding = (async (...args: Parameters<typeof pluginBinding>) => {
      await gate;
      return pluginBinding.apply(lite.core, args);
    }) as typeof pluginBinding;
    try {
      const calls: Array<[string, Promise<string>]> = [
        [
          HostMethod.HooksFire,
          outcomeOf(call(HostMethod.HooksFire, { project: PROJECT, threadId, on: HookEvent.Crash })),
        ],
        [
          HostMethod.CheckpointTake,
          outcomeOf(call(HostMethod.CheckpointTake, { project: PROJECT, threadId, label: "Late" })),
        ],
        [
          HostMethod.PluginsInvoke,
          outcomeOf(
            call(HostMethod.PluginsInvoke, {
              project: PROJECT,
              threadId,
              name: `${PLUGIN_ID}__sand`,
              args: {},
              step: true,
            }),
          ),
        ],
        [
          HostMethod.McpInvoke,
          outcomeOf(
            call(HostMethod.McpInvoke, { project: PROJECT, threadId, name: `${PLUGIN_ID}-desk__look`, args: {} }),
          ),
        ],
      ];
      await sleep(50);
      await lite.core.host.options.onUnexpectedExit?.({ at: Date.now(), code: 1, signal: null, harnessVersion: null });
      open();
      for (const [method, pending] of calls) assert.notEqual(await pending, "answered", method);
      assert.deepEqual(await paintLog(), [], "no step ran for the harness that is gone");
      assert.equal(reached, 0, "its connector call was never made");
      assert.deepEqual(lite.core.locks.holders(), [], "and nothing is held for it");
    } finally {
      lite.core.games.kindOf = kindOf;
      lite.core.pluginBinding = pluginBinding;
      lite.core.mcp.tool = tool;
    }
  });

  it("a planned restart cuts off the connector call its harness made while that call waits its turn", async () => {
    await reset();
    const binding = { project: PROJECT, directory: dir, threadId };
    const other = await lite.core.locks.hold([{ plugin: PLUGIN_ID, lock: BENCH }], {
      binding,
      waitMs: 0,
      holder: "other",
    });
    const { tool } = lite.core.mcp;
    let reached = 0;
    lite.core.mcp.tool = (async () => {
      reached += 1;
      return "looked";
    }) as typeof tool;
    const { restart, healthcheck, stop } = lite.core.host;
    let restarted = false;
    lite.core.host.stop = (async () => {}) as never;
    lite.core.host.restart = (async () => {
      restarted = true;
    }) as never;
    lite.core.host.healthcheck = (async () => true) as never;
    try {
      const look = outcomeOf(
        call(HostMethod.McpInvoke, { project: PROJECT, threadId, name: `${PLUGIN_ID}-desk__look`, args: {} }),
      );
      await sleep(200);
      await lite.core.requestSelfRestart("test", 0);
      for (let tries = 0; tries < 100 && !restarted; tries++) await sleep(20);
      const cut = await Promise.race([look, sleep(2000).then(() => "still waiting")]);
      assert.match(cut, /loop ended/, "the call is cut off with the harness that made it");
      other();
      await sleep(100);
      assert.equal(reached, 0, "the connector was never called for the harness that is gone");
      assert.deepEqual(lite.core.locks.holders(), []);
    } finally {
      other();
      lite.core.mcp.tool = tool;
      lite.core.host.stop = stop;
      lite.core.host.restart = restart;
      lite.core.host.healthcheck = healthcheck;
    }
  });

  it("a planned restart after a crash tells the booted harness of the runs the crash left open", async () => {
    await reset();
    const runId = "run-left-open";
    lite.core.host.options.onNotify?.(UiEvent.RunKeepawake, { runId });
    await lite.core.host.options.onUnexpectedExit?.({ at: Date.now(), code: 1, signal: null, harnessVersion: null });
    const notices: Array<{ notice?: { openRuns?: string[] } }> = [];
    const { restart, healthcheck, stop } = lite.core.host;
    lite.core.host.stop = (async () => {}) as never;
    lite.core.host.restart = (async (notice: { notice?: { openRuns?: string[] } }) => {
      notices.push(notice);
    }) as never;
    lite.core.host.healthcheck = (async () => true) as never;
    try {
      await lite.core.requestSelfRestart("test", 0);
      for (let tries = 0; tries < 100 && notices.length < 1; tries++) await sleep(20);
      await sleep(100);
    } finally {
      lite.core.host.stop = stop;
      lite.core.host.restart = restart;
      lite.core.host.healthcheck = healthcheck;
    }
    assert.deepEqual(notices[0]?.notice?.openRuns, [runId], "the boot notice names the run the crash left open");
  });

  it("a hold the harness asked for whose answer comes after the harness died holds nothing", async () => {
    await reset();
    const writer = { project: PROJECT, threadId, holder: { id: "w10", title: "Late" } };
    const { kindOf } = lite.core.games;
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    // The handler is still reading the game when the harness dies.
    lite.core.games.kindOf = (async (project: string) => {
      await gate;
      return kindOf.call(lite.core.games, project);
    }) as typeof kindOf;
    try {
      const pending = outcomeOf(call(HostMethod.LocksHold, writer));
      await sleep(50);
      await lite.core.host.options.onUnexpectedExit?.({ at: Date.now(), code: 1, signal: null, harnessVersion: null });
      open();
      assert.notEqual(await pending, "answered", "the dead harness's hold is refused");
      assert.deepEqual(lite.core.locks.holders(), [], "and nothing is held for it");
    } finally {
      lite.core.games.kindOf = kindOf;
    }
  });

  it("a harness that dies lets go only of the holds it asked for: the host's own hold and its waiter keep their place", async () => {
    await reset();
    const binding = { project: PROJECT, directory: dir, threadId };
    const bench = { plugin: PLUGIN_ID, lock: BENCH };
    // A restore the host runs for the person, and the person's Rewind waiting behind it.
    const restoring = await lite.core.locks.hold([bench], { binding, waitMs: 0, holder: "restore", forPerson: true });
    const rewind = track(lite.core.locks.hold([bench], { binding, waitMs: HOUR, holder: "rewind", forPerson: true }));
    await settle();
    await lite.core.host.options.onUnexpectedExit?.({ at: Date.now(), code: 1, signal: null, harnessVersion: null });
    await settle();
    assert.equal(rewind.error, null, "the person's Rewind still waits its turn");
    assert.deepEqual(
      lite.core.locks.holders().map((held) => held.holder),
      ["restore"],
      "the host's own hold is kept until its work ends",
    );
    restoring();
    await settle();
    assert.ok(granted(rewind), "then the Rewind goes");
    rewind.release?.();
    assert.deepEqual(lite.core.locks.holders(), []);
  });

  it("a run's crash steps pass the lock its own writer in place holds; a chat's crash steps wait for it", async () => {
    await reset();
    const writer = { project: PROJECT, threadId, runId: "run-own", holder: { id: "w4", title: "Carve" } };
    assert.deepEqual(await call(HostMethod.LocksHold, writer), { held: true, labels: ["Bench"] });
    try {
      const fire = (runId?: string) =>
        call(HostMethod.HooksFire, {
          project: PROJECT,
          threadId,
          on: "crash",
          ...(runId ? { runId } : {}),
        }) as Promise<{
          blocked: { reason: string; hold?: string; label?: string } | null;
          notes: Array<{ text: string }>;
          ran: string[];
        }>;
      const own = await fire("run-own");
      assert.deepEqual(own.ran, [`${PLUGIN_ID}__sand`], "the run's own recovery never waits on its worker");
      assert.deepEqual(await paintLog(), ["sand"]);
      const chat = fire();
      let settled = false;
      void chat.finally(() => {
        settled = true;
      });
      for (let polls = 0; polls < 50 && !settled; polls++) {
        await sleep(20);
        await clock.advance(PERSON_FIRST_POLL_MS * 3);
      }
      const held = await chat;
      assert.deepEqual(held.ran, [], "a moment of no run waits for the worker, then is held with why");
      assert.equal(held.blocked?.hold, "busy", "a writing moment's hold is typed, as Plan mode's is");
      assert.equal(held.blocked?.label, "Bench");
      assert.match(String(held.blocked?.reason), /Carve/);
      assert.deepEqual(await paintLog(), ["sand"]);
    } finally {
      await call(HostMethod.LocksRelease, writer);
    }
    assert.deepEqual(lite.core.locks.holders(), []);
  });

  /** Waits (bounded, in real time) until a call waits on the person: the chat heard of it. */
  const untilWaitingOnPerson = async () => {
    const waiting = () =>
      events.some((event) => event.type === UiEvent.PersonFirst && (event.payload as { waiting?: boolean }).waiting);
    for (let tries = 0; tries < 300 && !waiting(); tries++) await sleep(10);
    assert.ok(waiting(), "the moment waits on the person");
  };
  /** How a pending host call ended: "answered", or its error's message. */
  const outcomeOf = (pending: Promise<unknown>) =>
    pending.then(
      () => "answered",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
  /** A game snapshot of the bench game, and a file changed after it. */
  const changedSince = async () => {
    await writeFile(path.join(dir, "board.txt"), "before\n");
    const saved = (await call(HostMethod.SnapshotCreate, {
      scope: "game",
      project: PROJECT,
      reason: "Before the board changed",
    })) as { snapshot_id: string };
    await writeFile(path.join(dir, "board.txt"), "after\n");
    return saved.snapshot_id;
  };
  const board = () => readFile(path.join(dir, "board.txt"), "utf8");

  /** A harness step of its own (`plugins.invoke` with `step`), which needs the bench. */
  const harnessStep = () =>
    call(HostMethod.PluginsInvoke, { project: PROJECT, threadId, name: `${PLUGIN_ID}__sand`, args: {}, step: true });

  it("Stop ends a moment, a checkpoint, a harness step and a game restore while they wait for the person: nothing runs, nothing is held", async () => {
    const asks: Array<[string, () => Promise<unknown>]> = [
      ["a moment", () => call(HostMethod.HooksFire, { project: PROJECT, threadId, runId: "run-own", on: "crash" })],
      ["a checkpoint", () => call(HostMethod.CheckpointTake, { project: PROJECT, threadId, label: "Halfway" })],
      ["a harness step", harnessStep],
    ];
    for (const [what, ask] of asks) {
      await reset();
      events.length = 0;
      await person({ personActive: true });
      const snapshots = lite.core.snapshotIndex.all().length;
      const pending = outcomeOf(ask());
      await untilWaitingOnPerson();
      await call(HostMethod.EngineAbort, { project: PROJECT });
      const ended = await Promise.race([pending, sleep(2000).then(() => "still waiting")]);
      await person({ personActive: false });
      for (let polls = 0; polls < 5; polls++) {
        await sleep(20);
        await clock.advance(PERSON_FIRST_POLL_MS);
      }
      await pending;
      assert.match(ended, /Stopped/, `${what}: the Stop ended it`);
      assert.deepEqual(await paintLog(), [], `${what}: no step ran`);
      assert.equal(lite.core.snapshotIndex.all().length, snapshots, `${what}: no snapshot`);
      assert.deepEqual(lite.core.locks.holders(), [], `${what}: nothing held`);
    }
    await reset();
    events.length = 0;
    const snapshotId = await changedSince();
    await person({ personActive: true });
    const restore = outcomeOf(call(HostMethod.SnapshotRestore, { snapshotId, project: PROJECT, threadId }));
    await untilWaitingOnPerson();
    await call(HostMethod.EngineAbort, { threadId });
    assert.match(await restore, /Stopped/, "the chat's Stop ended the restore");
    assert.equal(await board(), "after\n", "the game's files are as they were");
    assert.deepEqual(await paintLog(), [], "no step ran");
    assert.deepEqual(lite.core.locks.holders(), []);
  });

  it("a harness that dies while its moment, harness step or game restore waits for the person ends them: no step runs afterwards", async () => {
    const asks: Array<[string, () => Promise<unknown>]> = [
      ["a moment", () => call(HostMethod.HooksFire, { project: PROJECT, threadId, runId: "run-own", on: "crash" })],
      ["a harness step", harnessStep],
      [
        "a game restore",
        async () => call(HostMethod.SnapshotRestore, { snapshotId: await changedSince(), project: PROJECT, threadId }),
      ],
    ];
    for (const [what, ask] of asks) {
      await reset();
      events.length = 0;
      await person({ personActive: true });
      const pending = outcomeOf(ask());
      await untilWaitingOnPerson();
      await lite.core.host.options.onUnexpectedExit?.({ at: Date.now(), code: 1, signal: null, harnessVersion: null });
      const ended = await Promise.race([pending, sleep(2000).then(() => "still waiting")]);
      await person({ personActive: false });
      for (let polls = 0; polls < 5; polls++) {
        await sleep(20);
        await clock.advance(PERSON_FIRST_POLL_MS);
      }
      assert.match(ended, /Stopped/, `${what}: the harness's death ended it`);
      assert.deepEqual(await paintLog(), [], `${what}: no step ran, then or later`);
      assert.deepEqual(lite.core.locks.holders(), [], `${what}: nothing held`);
      await pending;
    }
    assert.equal(await board(), "after\n", "the game's files are as they were");
  });

  it("Stop of another game or another chat leaves a moment waiting, and it runs once the person is done", async () => {
    const stops = [{ project: "another-game" }, { threadId: "another-chat" }];
    for (const stop of stops) {
      await reset();
      events.length = 0;
      await person({ personActive: true });
      const pending = outcomeOf(
        call(HostMethod.HooksFire, { project: PROJECT, threadId, runId: "run-own", on: "crash" }),
      );
      await untilWaitingOnPerson();
      await call(HostMethod.EngineAbort, stop);
      await person({ personActive: false });
      let outcome = "";
      void pending.then((ended) => {
        outcome = ended;
      });
      for (let polls = 0; polls < 50 && !outcome; polls++) {
        await sleep(20);
        await clock.advance(PERSON_FIRST_POLL_MS);
      }
      assert.equal(outcome, "answered", JSON.stringify(stop));
      assert.deepEqual(await paintLog(), ["sand"], `${JSON.stringify(stop)}: its step ran`);
    }
    assert.deepEqual(lite.core.locks.holders(), []);
  });

  it("a writer in place may start in a game of any kind, not only one that holds a web page", async () => {
    await reset();
    const empty = (await lite.core.createGame("Bench Without Page")).name;
    const writer = { project: empty, threadId, holder: { id: "w5", title: "Carve" } };
    assert.deepEqual(await call(HostMethod.LocksHold, writer), { held: true, labels: ["Bench"] });
    await call(HostMethod.LocksRelease, writer);
    assert.deepEqual(lite.core.locks.holders(), []);
  });

  it("an in-place writer holds the game's plugin locks until it ends, and the lead's call waits for it", async () => {
    await reset();
    const writer = { project: PROJECT, threadId, holder: { id: "w1", title: "Tune" } };
    assert.deepEqual(await call(HostMethod.LocksHold, writer), { held: true, labels: ["Bench"] });
    await writeFile(path.join(dir, "release"), "");
    // The writer's own call passes its lock.
    const own = await ownService(lite).invokePluginTool(
      `${PLUGIN_ID}__paint`,
      {},
      { project: PROJECT, directory: dir, threadId },
      undefined,
      { engine: "claude-code", holder: workerHolder({ threadId, runId: null, id: "w1" }) },
    );
    assert.deepEqual(own, { painted: true });
    // The lead's waits for the writer's end.
    await writeFile(path.join(dir, "paint.log"), "");
    const lead = invoke(`${PLUGIN_ID}__paint`);
    await sleep(200);
    assert.deepEqual(await paintLog(), [], "the lead's call waits for the writer");
    await call(HostMethod.LocksRelease, { project: PROJECT, threadId, holder: { id: "w1" } });
    assert.deepEqual(await lead, { painted: true });
    await access(path.join(dir, "release"));
  });
});

/** The core's plugin tool service as a worker's session reaches it, over the core's own locks. */
function ownService(lite: CoreLite): PluginToolService {
  return new PluginToolService(lite.core, {
    consent: null as never,
    pluginCallAttribution: new WeakMap(),
    mcpSecrets: null,
    activeConnectorCalls: new Map(),
    assetCalls: new Map(),
    cutOffCalls: new Map(),
    planning: async () => false,
    chatMode: async () => PermissionMode.Bypass,
    locks: lite.core.locks,
    hooks: lite.core.hooks,
  });
}

describe("an agent's call answers within the engine bridge's deadline", () => {
  let lite: CoreLite;
  let threadId: string;
  let dir: string;
  const events: UiEventEnvelope[] = [];
  // One clock for the locks, their timers and the call's own time: it moves only when a test moves it.
  const clock = manualClock();
  const timeout = (ms: number) => {
    const timer = new AbortController();
    clock.sleep(ms).then(() => timer.abort(new Error("the time ran out")));
    return timer.signal;
  };
  const person = (answer: unknown) => writeFile(path.join(dir, "person.json"), JSON.stringify(answer));
  /** An agent's call, as the local harness's agents make one. */
  const invoke = (name: string) =>
    (lite.api() as unknown as Api)[HostMethod.PluginsInvoke]?.({ project: PROJECT, threadId, name, args: {} }) ??
    Promise.reject(new Error("no plugins.invoke"));
  /** A call's answer or error, and whether it came yet. */
  const watched = (pending: Promise<unknown>) => {
    const state: { done: boolean; outcome: unknown } = { done: false, outcome: null };
    pending.then(
      (value) => Object.assign(state, { done: true, outcome: value }),
      (error: unknown) => Object.assign(state, { done: true, outcome: error }),
    );
    return state;
  };

  before(async () => {
    lite = await coreLite({
      onUiEvent: (event) => events.push(event),
      locks: { now: clock.now, sleep: clock.sleep, timeout },
    });
    await lite.core.games.scaffold(PROJECT);
    dir = lite.core.games.dirFor(PROJECT);
    threadId = await lite.core.createGameThread(PROJECT);
    await lite.core.plugins.installLocal(await lockPackage(), PluginSourceKind.Github, [], FROM_GITHUB);
    await lite.core.plugins.setEnabled(PLUGIN_ID, true);
    // Its agent tools would ask the person first; these cases are about locks, so the person allows them.
    personAllowsLocalTools(lite.core.plugins);
  });

  after(async () => {
    lite.core.plugins.cancel();
    await lite.close();
  });

  const cards = async () =>
    (await lite.core.listAllEvents()).flatMap((event) =>
      event.data.type === EventKind.Custom && event.data.event_type === CustomEvent.PluginConsent
        ? [event.data.payload as { consentId: string; state: string }]
        : [],
    );
  /** The card a call asks, one not answered yet (bounded, in real time). */
  const pendingCard = async () => {
    let card: { consentId: string } | undefined;
    for (let tries = 0; tries < 200 && !card; tries++) {
      const all = await cards();
      const answered = new Set(all.filter((c) => c.state !== "pending").map((c) => c.consentId));
      card = all.find((c) => c.state === "pending" && !answered.has(c.consentId));
      if (!card) await sleep(20);
    }
    assert.ok(card, "the call asks its card");
    return card;
  };
  const paintLog = async (): Promise<string[]> =>
    (await readFile(path.join(dir, "paint.log"), "utf8").catch(() => "")).split("\n").filter(Boolean);
  /** Waits (in real time, bounded) until a call answers. */
  const untilDone = async (state: { done: boolean }) => {
    for (let tries = 0; tries < 300 && !state.done; tries++) await sleep(10);
  };

  it("a card answered late leaves the call's wait for the person only what is left of the call's time", async () => {
    await person({ personActive: true });
    const started = clock.now();
    const varnish = watched(invoke(`${PLUGIN_ID}__varnish`));
    const card = await pendingCard();
    // The person reads the card for seven and a half minutes.
    await clock.advance(450_000);
    lite.core.resolveConsent(card.consentId, true);
    // The clock moves only while the call waits on the person: their time, not Genex's work.
    const waitingOnPerson = () => events.some((event) => event.type === UiEvent.PersonFirst);
    for (let tries = 0; tries < 300 && !varnish.done; tries++) {
      await sleep(10);
      if (waitingOnPerson()) await clock.advance(PERSON_FIRST_POLL_MS);
    }
    assert.ok(varnish.done, "the call answered");
    assert.equal(
      (varnish.outcome as { blocker?: string }).blocker,
      PluginCallBlocker.Lock,
      JSON.stringify(varnish.outcome),
    );
    const tookMs = clock.now() - started;
    assert.ok(tookMs < BRIDGE_TOOL_DEADLINE_MS, `answered after ${tookMs} ms, within the bridge's deadline`);
  });

  it("a call with no steps around it and no lock, its card answered late, still runs to its own end", async () => {
    await person({ personActive: false });
    await rm(path.join(dir, "release"), { force: true });
    await writeFile(path.join(dir, "paint.log"), "");
    const stamping = watched(invoke(`${PLUGIN_ID}__stamp`));
    const card = await pendingCard();
    // The person reads the card for eight minutes and forty seconds.
    await clock.advance(520_000);
    lite.core.resolveConsent(card.consentId, true);
    for (let tries = 0; tries < 200 && !(await paintLog()).includes("stamp"); tries++) await sleep(20);
    assert.deepEqual(await paintLog(), ["stamp"], "the approved call started");
    await clock.advance(PERSON_FIRST_POLL_MS);
    await sleep(100);
    assert.equal(stamping.done, false, "and is not cut for the late card");
    await writeFile(path.join(dir, "release"), "");
    await untilDone(stamping);
    assert.deepEqual(stamping.outcome, { stamped: true });
  });

  it("a call that needs a lock, its card answered with too little of its time left, does not run and says so", async () => {
    await person({ personActive: false });
    await writeFile(path.join(dir, "paint.log"), "");
    const varnish = watched(invoke(`${PLUGIN_ID}__varnish`));
    const card = await pendingCard();
    await clock.advance(BRIDGE_TOOL_DEADLINE_MS - 8_000);
    lite.core.resolveConsent(card.consentId, true);
    await untilDone(varnish);
    assert.ok(varnish.done, "the call answered");
    const answer = varnish.outcome as { notRun?: boolean; message?: string };
    assert.equal(answer.notRun, true, JSON.stringify(varnish.outcome));
    assert.match(String(answer.message), /did not run/);
    assert.deepEqual(await paintLog(), [], "its plugin was never called");
    assert.deepEqual(lite.core.locks.holders(), [], "nothing is held");
  });

  it("a call's wait for its lock leaves the call its own ceiling: a person still at it past that wait refuses it", async () => {
    events.length = 0;
    await person({ personActive: true });
    await writeFile(path.join(dir, "paint.log"), "");
    const varnish = watched(invoke(`${PLUGIN_ID}__varnish`));
    const card = await pendingCard();
    await clock.advance(300_000);
    const answeredAt = clock.now();
    lite.core.resolveConsent(card.consentId, true);
    const waitingOnPerson = () => events.some((event) => event.type === UiEvent.PersonFirst);
    for (let tries = 0; tries < 400 && !varnish.done; tries++) {
      await sleep(10);
      if (waitingOnPerson()) await clock.advance(PERSON_FIRST_POLL_MS);
    }
    assert.equal((varnish.outcome as { blocker?: string }).blocker, PluginCallBlocker.Lock, String(varnish.outcome));
    // What is left after the card (295 s) less the call's own ceiling (190 s) and one short ask:
    // about 100 s (the test moves the clock a few polls more while the answer comes back), never
    // an agent's whole wait.
    const waited = clock.now() - answeredAt;
    assert.ok(waited < AGENT_LOCK_WAIT_MS - 60_000, `waited ${waited} ms for the person`);
    assert.deepEqual(await paintLog(), [], "the call never ran");
  });

  it("a call that never answers is ended where its time runs out, saying whether it took effect is unknown", async () => {
    await person({ personActive: false });
    await rm(path.join(dir, "release"), { force: true });
    const started = clock.now();
    const painting = watched(invoke(`${PLUGIN_ID}__paint`));
    for (let tries = 0; tries < 200 && !(await readFile(path.join(dir, "paint.log"), "utf8").catch(() => "")); tries++)
      await sleep(20);
    // Just short of the bridge's deadline from the call's start: the call must have been ended by then.
    await clock.advance(BRIDGE_TOOL_DEADLINE_MS - 1 - (clock.now() - started));
    for (let tries = 0; tries < 300 && !painting.done; tries++) await sleep(10);
    assert.ok(painting.done, "the call answered before the bridge gave up");
    assert.ok(painting.outcome instanceof Error, String(painting.outcome));
    assert.match(painting.outcome.message, /ran out of the time one call may take/);
    assert.deepEqual(lite.core.locks.holders(), [], "nothing is held");
    await writeFile(path.join(dir, "release"), "");
  });
});

describe("the Unreal plugin's editor lock", () => {
  let lite: CoreLite;
  before(async () => {
    lite = await coreLite();
    await lite.core.plugins.setEnabled("unreal", true);
  });
  after(async () => {
    lite.core.plugins.cancel();
    await lite.close();
  });

  it("is held by an in-place worker of an Unreal game only: a web game's worker never works in Unreal", () => {
    const web: GameKind = { facts: [{ id: CoreFact.WebGame, path: "." }] };
    const unreal: GameKind = { facts: [{ id: CoreFact.UnrealProject, path: "unreal" }] };
    assert.deepEqual(lite.core.plugins.locksFor(web), [], "only the agent's tools and connectors count");
    assert.deepEqual(
      lite.core.plugins.locksFor(unreal).map(({ plugin, lock }) => [plugin, lock.id, lock.label]),
      [["unreal", "editor", "Unreal"]],
    );
  });
});

describe("a worker's own session passes the locks its pool holds for it", () => {
  const cores: CoreLite["core"][] = [];
  after(async () => {
    for (const core of cores) core.plugins.cancel();
    await closeWorkerChats();
  });

  it("its plugin calls run while the worker holds the lock; another session's wait behind it", async () => {
    // An agent's call waits briefly here, so a call left waiting is answered why within the test.
    const chat = await workerChat({ locks: { agentWaitMs: 300 } });
    const { core, game, threadId, worktree, delegate, runWorker, whileRunning } = chat;
    cores.push(core);
    await core.setPermissionMode(threadId, PermissionMode.Bypass);
    await core.plugins.installLocal(await lockPackage(), PluginSourceKind.Github, [], FROM_GITHUB);
    await core.plugins.setEnabled(PLUGIN_ID, true);
    // Its agent tools would ask the person first; these cases are about locks, so the person allows them.
    personAllowsLocalTools(core.plugins);
    await writeFile(path.join(worktree, "release"), "");
    const api = core.api() as unknown as Api;
    const writer = { project: game, threadId, runId: RUN_ID, holder: { id: "w1", title: "Tune" } };
    assert.deepEqual(await api[HostMethod.LocksHold]?.(writer), { held: true, labels: ["Bench"] });
    const tool = core.mcp.tool;
    core.mcp.tool = (async () => "looked") as typeof tool;
    try {
      const answers: unknown[] = [];
      const looks: string[] = [];
      whileRunning(async (request) => {
        const call = request.onLiveTool;
        if (!call) return;
        answers.push(await call(`${PLUGIN_ID}__paint`, {}));
        looks.push(
          await call(`${PLUGIN_ID}-desk__look`, {}).then(
            (answer) => JSON.stringify(answer),
            (error: unknown) => `refused: ${String(error)}`,
          ),
        );
      });
      await delegate(runWorker("w1"));
      await delegate(runWorker("w2"));
      const [own, other] = answers.map((answer) => JSON.stringify(answer));
      assert.match(String(own), /painted/, "the worker's own call passed the lock it holds");
      assert.match(
        String(other),
        new RegExp(PluginCallBlocker.Lock),
        "another worker's call waited, then was told why",
      );
      assert.match(String(looks[0]), /looked/, "its connector call passed the lock it holds too");
      assert.match(String(looks[1]), /refused: .*Bench/, "another worker's connector call was told why");
    } finally {
      core.mcp.tool = tool;
      await api[HostMethod.LocksRelease]?.(writer);
    }
  });

  it("an in-place worker on an engine that carries no worker's seat passes its own lock too", async () => {
    const chat = await workerChat({ locks: { agentWaitMs: 300 } });
    const { core, game, threadId, delegate, runWorker, whileRunning } = chat;
    cores.push(core);
    await core.setPermissionMode(threadId, PermissionMode.Bypass);
    await core.plugins.installLocal(await lockPackage(), PluginSourceKind.Github, [], FROM_GITHUB);
    await core.plugins.setEnabled(PLUGIN_ID, true);
    // Its agent tools would ask the person first; these cases are about locks, so the person allows them.
    personAllowsLocalTools(core.plugins);
    const gameDir = core.games.dirFor(game);
    await writeFile(path.join(gameDir, "release"), "");
    const api = core.api() as unknown as Api;
    const writer = { project: game, threadId, runId: RUN_ID, holder: { id: "w1", title: "Tune" } };
    assert.deepEqual(await api[HostMethod.LocksHold]?.(writer), { held: true, labels: ["Bench"] });
    try {
      const answers: string[] = [];
      whileRunning(async (request) => {
        const call = request.onLiveTool;
        if (call) answers.push(JSON.stringify(await call(`${PLUGIN_ID}__paint`, {})));
      });
      await delegate(runWorker("w1", gameDir), LOCAL);
      assert.equal(answers.length, 1, "the local session called the tool");
      assert.match(String(answers[0]), /painted/, "its own call passed the lock it holds for its life");
    } finally {
      await api[HostMethod.LocksRelease]?.(writer);
    }
  });

  it("a planned harness restart ends the in-place worker sessions whose holds it lets go", async () => {
    const chat = await workerChat({ locks: { agentWaitMs: 300 } });
    const { core, game, threadId, delegate, runWorker, whileRunning } = chat;
    cores.push(core);
    await core.setPermissionMode(threadId, PermissionMode.Bypass);
    await core.plugins.installLocal(await lockPackage(), PluginSourceKind.Github, [], FROM_GITHUB);
    await core.plugins.setEnabled(PLUGIN_ID, true);
    // Its agent tools would ask the person first; these cases are about locks, so the person allows them.
    personAllowsLocalTools(core.plugins);
    const gameDir = core.games.dirFor(game);
    const api = core.api() as unknown as Api;
    const writer = { project: game, threadId, runId: RUN_ID, holder: { id: "w1", title: "Tune" } };
    assert.deepEqual(await api[HostMethod.LocksHold]?.(writer), { held: true, labels: ["Bench"] });
    let begun = () => {};
    const working = new Promise<void>((resolve) => {
      begun = resolve;
    });
    let ended = false;
    // Told to stop, the worker's engine takes a while to let go: the test says when.
    let letGo = () => {};
    const lettingGo = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    const holdersWhileStopping: string[][] = [];
    whileRunning(async (request) => {
      begun();
      await new Promise<void>((resolve) => {
        if (request.signal?.aborted) resolve();
        request.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      ended = request.signal?.aborted === true;
      await sleep(50);
      holdersWhileStopping.push([...new Set(core.locks.holders().map((held) => held.holder))]);
      await lettingGo;
    });
    const session = delegate(runWorker("w1", gameDir), LOCAL).catch(() => {});
    await working;
    const seen: number[] = [];
    const { restart, healthcheck } = core.host;
    core.host.restart = (async () => {
      seen.push(core.locks.holders().length);
    }) as never;
    core.host.healthcheck = (async () => true) as never;
    try {
      await core.requestSelfRestart("test", 0);
      for (let tries = 0; tries < 100 && holdersWhileStopping.length < 1; tries++) await sleep(20);
      assert.deepEqual(
        holdersWhileStopping,
        [[workerHolder({ threadId, runId: RUN_ID, id: "w1" })]],
        "the worker's holds stay until its session has ended",
      );
      assert.deepEqual(seen, [], "and the restart waits for it");
      letGo();
      for (let tries = 0; tries < 100 && seen.length < 1; tries++) await sleep(20);
      await Promise.race([session, sleep(2000)]);
      // The applied update's own record is written after the restart: let it land before the stubs go.
      await sleep(100);
    } finally {
      core.host.restart = restart;
      core.host.healthcheck = healthcheck;
    }
    assert.deepEqual(seen, [0], "the restart found the game free");
    assert.equal(ended, true, "the worker's session that wrote in place was ended, not left writing");
  });

  it("a planned harness restart lets a hung in-place worker's holds go once its bounded wait runs out", async () => {
    // Each wait on the locks' clock the test may end at once; each also ends in its own time.
    const waits: Array<{ ms: number; end: () => void }> = [];
    const timeout = (ms: number) => {
      const ended = new AbortController();
      waits.push({ ms, end: () => ended.abort(new Error("the wait ran out")) });
      return AbortSignal.any([ended.signal, AbortSignal.timeout(ms)]);
    };
    const chat = await workerChat({ locks: { agentWaitMs: 300, timeout } });
    const { core, game, threadId, delegate, runWorker, whileRunning } = chat;
    cores.push(core);
    await core.setPermissionMode(threadId, PermissionMode.Bypass);
    await core.plugins.installLocal(await lockPackage(), PluginSourceKind.Github, [], FROM_GITHUB);
    await core.plugins.setEnabled(PLUGIN_ID, true);
    // Its agent tools would ask the person first; these cases are about locks, so the person allows them.
    personAllowsLocalTools(core.plugins);
    const gameDir = core.games.dirFor(game);
    const api = core.api() as unknown as Api;
    const writer = { project: game, threadId, runId: RUN_ID, holder: { id: "w1", title: "Tune" } };
    assert.deepEqual(await api[HostMethod.LocksHold]?.(writer), { held: true, labels: ["Bench"] });
    let begun = () => {};
    const working = new Promise<void>((resolve) => {
      begun = resolve;
    });
    let release = () => {};
    const hung = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Told to stop, the worker's engine never lets go (until the test is done with it).
    whileRunning(async () => {
      begun();
      await hung;
    });
    const session = delegate(runWorker("w1", gameDir), LOCAL).catch(() => {});
    await working;
    const seen: number[] = [];
    const { restart, healthcheck } = core.host;
    core.host.restart = (async () => {
      seen.push(core.locks.holders().length);
    }) as never;
    core.host.healthcheck = (async () => true) as never;
    try {
      void core.requestSelfRestart("test", 0);
      let bound: { ms: number; end: () => void } | undefined;
      for (let tries = 0; tries < 100 && !bound; tries++) {
        await sleep(20);
        bound = waits.find((wait) => wait.ms === WRITERS_LET_GO_MS);
      }
      assert.ok(bound, "the restart waits for the writer on the locks' clock");
      assert.deepEqual(seen, [], "and holds the restart while it waits");
      bound.end();
      for (let tries = 0; tries < 100 && seen.length < 1; tries++) await sleep(20);
      await sleep(100);
    } finally {
      core.host.restart = restart;
      core.host.healthcheck = healthcheck;
      release();
      await Promise.race([session, sleep(2000)]);
    }
    assert.deepEqual(seen, [0], "the restart went on with the game free once the wait ran out");
    assert.deepEqual(core.locks.holders(), []);
  });

  it("a session on such an engine passes no worker's lock outside the game folder, nor one naming no chat", async () => {
    const chat = await workerChat({ locks: { agentWaitMs: 300 } });
    const { core, game, threadId, worktree, delegate, runWorker, whileRunning } = chat;
    cores.push(core);
    await core.setPermissionMode(threadId, PermissionMode.Bypass);
    await core.plugins.installLocal(await lockPackage(), PluginSourceKind.Github, [], FROM_GITHUB);
    await core.plugins.setEnabled(PLUGIN_ID, true);
    // Its agent tools would ask the person first; these cases are about locks, so the person allows them.
    personAllowsLocalTools(core.plugins);
    const gameDir = core.games.dirFor(game);
    await writeFile(path.join(gameDir, "release"), "");
    await writeFile(path.join(worktree, "release"), "");
    const api = core.api() as unknown as Api;
    const writer = { project: game, threadId, runId: RUN_ID, holder: { id: "w1", title: "Tune" } };
    assert.deepEqual(await api[HostMethod.LocksHold]?.(writer), { held: true, labels: ["Bench"] });
    try {
      const answers: string[] = [];
      whileRunning(async (request) => {
        const call = request.onLiveTool;
        if (call) answers.push(JSON.stringify(await call(`${PLUGIN_ID}__paint`, {})));
      });
      const sessions: Array<[string, Record<string, unknown>]> = [
        ["in the run's copy", runWorker("w1", worktree)],
        ["naming no chat", { ...runWorker("w1", gameDir), threadId: undefined }],
      ];
      for (const [name, params] of sessions) {
        answers.length = 0;
        await delegate(params, LOCAL);
        assert.equal(answers.length, 1, `${name}: the local session called the tool`);
        for (const answer of answers) {
          assert.match(answer, new RegExp(PluginCallBlocker.Lock), `${name}: its call waited, then was told why`);
          assert.doesNotMatch(answer, /painted/, `${name}: never painted`);
        }
      }
    } finally {
      await api[HostMethod.LocksRelease]?.(writer);
    }
  });
});

describe("the person writing ends a session's waits for a lock, never a lock given", () => {
  it("a hold waiting behind another holder is refused at once, naming the lock, and leaves the line", async () => {
    const { locks } = service();
    const first = track(locks.hold([quiet], { binding: binding(), waitMs: HOUR, holder: "a" }));
    await settle();
    const wrote = new AbortController();
    const waiting = track(
      locks.hold([quiet], { binding: binding(), waitMs: HOUR, holder: "b", personWrote: wrote.signal }),
    );
    const other = track(locks.hold([quiet], { binding: binding(), waitMs: HOUR, holder: "c" }));
    await settle();
    wrote.abort();
    await settle();
    assert.ok(waiting.error instanceof LockRefused, String(waiting.error));
    assert.equal(waiting.error.code, LockRefusal.PersonWrote);
    assert.equal(waiting.error.label, "Quiet room");
    assert.match(waiting.error.message, /wrote/);
    assert.match(waiting.error.message, /Quiet room/);
    assert.equal(granted(other), false, "another caller's wait goes on");
    first.release?.();
    await settle();
    assert.equal(granted(other), true, "and it is next: the refused hold left the line");
    other.release?.();
    assert.deepEqual(locks.holders(), []);
  });

  it("a wait on the person ends too, and the chat hears the wait is over", async () => {
    const { locks, said, clock } = service([{ personActive: true }]);
    const wrote = new AbortController();
    const waiting = track(
      locks.hold([bench], { binding: binding(), waitMs: HOUR, holder: "a", personWrote: wrote.signal }),
    );
    await settle();
    assert.deepEqual(said, [{ label: "Bench", waiting: true, threadId: "t1" }]);
    wrote.abort();
    await settle();
    assert.ok(waiting.error instanceof LockRefused);
    assert.equal(waiting.error.code, LockRefusal.PersonWrote);
    assert.deepEqual(said.at(-1), { label: "Bench", waiting: false, threadId: "t1" });
    assert.deepEqual(locks.holders(), [], "nothing held");
    // Not a refusal for the person's use of the bench: the next call waits its whole wait, not one short ask.
    const next = track(locks.hold([bench], { binding: binding(), waitMs: HOUR, holder: "b" }));
    await clock.advance(PERSON_FIRST_ASK_MS + PERSON_FIRST_POLL_MS);
    assert.equal(next.error, null, "it still waits for the person");
  });

  it("only a wait ends: a free lock is taken though the person already wrote, and a lock given stays given", async () => {
    const { locks } = service();
    const wrote = new AbortController();
    wrote.abort();
    const free = track(
      locks.hold([quiet], { binding: binding(), waitMs: HOUR, holder: "a", personWrote: wrote.signal }),
    );
    await settle();
    assert.equal(granted(free), true, "nothing to wait for: taken");
    const later = new AbortController();
    const given = track(
      locks.hold([shared], { binding: binding(), waitMs: HOUR, holder: "b", personWrote: later.signal }),
    );
    await settle();
    later.abort();
    await settle();
    assert.equal(granted(given), true);
    assert.equal(locks.holders().length, 2, "both still held: the person's words never take a lock back");
    free.release?.();
    given.release?.();
  });

  it("a person who already wrote refuses the next wait at once", async () => {
    const { locks } = service();
    const first = track(locks.hold([quiet], { binding: binding(), waitMs: HOUR, holder: "a" }));
    await settle();
    const wrote = new AbortController();
    wrote.abort();
    const waiting = track(
      locks.hold([quiet], { binding: binding(), waitMs: HOUR, holder: "b", personWrote: wrote.signal }),
    );
    await settle();
    assert.equal((waiting.error as LockRefused | null)?.code, LockRefusal.PersonWrote);
    first.release?.();
  });

  it("Stop is still Stop: a wait the call's own signal ends is not the person's words", async () => {
    const { locks } = service();
    const first = track(locks.hold([quiet], { binding: binding(), waitMs: HOUR, holder: "a" }));
    await settle();
    const stop = new AbortController();
    const wrote = new AbortController();
    const waiting = track(
      locks.hold([quiet], {
        binding: binding(),
        waitMs: HOUR,
        holder: "b",
        signal: stop.signal,
        personWrote: wrote.signal,
      }),
    );
    await settle();
    stop.abort(new Error("stopped"));
    wrote.abort();
    await settle();
    assert.equal(waiting.error instanceof LockRefused, false, "a Stop is never answered as the person's message");
    first.release?.();
  });
});

describe("a steer ends the waits for a lock of the session it reaches", () => {
  const cores: CoreLite["core"][] = [];
  after(async () => {
    for (const core of cores) core.plugins.cancel();
    await closeWorkerChats();
  });

  /** Until `check` holds, in real time, bounded. */
  const eventually = async (check: () => boolean | Promise<boolean>) => {
    for (let tries = 0; tries < 250 && !(await check()); tries++) await sleep(20);
    assert.ok(await check(), "it never happened");
  };

  /** A worker chat with the lock plugin, whose waits never run out here, and every hold recorded as it is asked. */
  async function benchChat() {
    const chat = await workerChat({ locks: { agentWaitMs: HOUR } });
    const { core, game, threadId } = chat;
    cores.push(core);
    await core.setPermissionMode(threadId, PermissionMode.Bypass);
    await core.plugins.installLocal(await lockPackage(), PluginSourceKind.Github, [], FROM_GITHUB);
    await core.plugins.setEnabled(PLUGIN_ID, true);
    // Its agent tools would ask the person first; these cases are about locks, so the person allows them.
    personAllowsLocalTools(core.plugins);
    const asked: unknown[] = [];
    const hold = core.locks.hold.bind(core.locks);
    core.locks.hold = (locks, options) => {
      asked.push(options);
      return hold(locks, options);
    };
    const api = core.api() as unknown as Api;
    const writer = { project: game, threadId, runId: RUN_ID, holder: { id: "w1", title: "Tune" } };
    const steer = (into: string) =>
      api[HostMethod.EngineSteer]?.({ threadId, into, messages: [{ id: "m-red", text: "Paint it red instead." }] });
    return { ...chat, api, asked, writer, steer, gameDir: core.games.dirFor(game) };
  }

  it("the chat's session waiting for a lock hears at once that the person wrote; another session's wait goes on", async () => {
    const { api, asked, writer, steer, delegate, personSays, runWorker, worktree, whileRunning } = await benchChat();
    assert.deepEqual(await api[HostMethod.LocksHold]?.(writer), { held: true, labels: ["Bench"] });
    const answers = new Map<string, string>();
    whileRunning(async (request) => {
      const who = request.steer ? "chat" : "worker";
      request.steer?.ready(() => true);
      const call = request.onLiveTool;
      if (call) answers.set(who, JSON.stringify(await call(`${PLUGIN_ID}__paint`, {})));
    });
    const messageId = await personSays();
    const chatTurn = delegate({ chatTurn: { messageId } });
    const workerTurn = delegate(runWorker("w2"));
    await eventually(() => asked.length >= 2);
    await settle();
    assert.deepEqual(await steer(messageId), { how: "native", accepted: ["m-red"] });
    await chatTurn;
    const answer = String(answers.get("chat"));
    assert.match(answer, new RegExp(PluginCallBlocker.Lock));
    assert.match(answer, new RegExp(LockRefusal.PersonWrote));
    assert.match(answer, /read their message/i);
    assert.equal(answers.has("worker"), false, "the worker's session still waits for the bench");
    await api[HostMethod.LocksRelease]?.(writer);
    await writeFile(path.join(worktree, "release"), "");
    await workerTurn;
    assert.match(String(answers.get("worker")), /painted/, "it waited its turn, then ran");
  });

  it("a call that already holds its lock runs to its end", async () => {
    const { steer, delegate, personSays, whileRunning, gameDir, core } = await benchChat();
    const answers: string[] = [];
    whileRunning(async (request) => {
      request.steer?.ready(() => true);
      const call = request.onLiveTool;
      if (call) answers.push(JSON.stringify(await call(`${PLUGIN_ID}__paint`, {})));
    });
    const messageId = await personSays();
    const turn = delegate({ chatTurn: { messageId } });
    const log = async () => (await readFile(path.join(gameDir, "paint.log"), "utf8").catch(() => "")).split("\n");
    await eventually(async () => (await log()).includes("start"));
    assert.deepEqual(await steer(messageId), { how: "native", accepted: ["m-red"] });
    await settle();
    assert.equal(core.locks.holders().length, 1, "it keeps the bench");
    await writeFile(path.join(gameDir, "release"), "");
    await turn;
    assert.match(String(answers[0]), /painted/);
  });
});
