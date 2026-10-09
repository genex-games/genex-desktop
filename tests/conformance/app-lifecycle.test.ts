/**
 * The main process's recovery rules, driven through their pure interfaces with fake clocks and
 * timers: process-level error handlers that log and keep the app alive, the bounded reload after a
 * renderer crash, and a quit sequence that always finishes even when a step hangs or throws.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  createReloadPolicy,
  installProcessHandlers,
  pageRecovery,
  QuitQuestion,
  quitQuestion,
  runShutdown,
  settleWithin,
  type ShutdownTimers,
} from "../../src/main/app-lifecycle.ts";

/** Timers that only fire when the test says so, recording each delay asked for. */
function manualTimers() {
  const pending = new Map<number, () => void>();
  let next = 1;
  const timers: ShutdownTimers & { delays: number[]; fireAll(): void } = {
    delays: [],
    setTimeout(callback, ms) {
      const id = next++;
      timers.delays.push(ms);
      pending.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      pending.delete(id as number);
    },
    fireAll() {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback();
    },
  };
  return timers;
}

describe("process-level error handlers", () => {
  it("register for uncaught exceptions and unhandled rejections", () => {
    const target = new EventEmitter();
    installProcessHandlers(target, () => {});
    assert.equal(target.listenerCount("uncaughtException"), 1);
    assert.equal(target.listenerCount("unhandledRejection"), 1);
  });

  it("log the error with its stack and keep the process running", () => {
    const target = new EventEmitter();
    const lines: string[] = [];
    installProcessHandlers(target, (source, line) => lines.push(`${source}: ${line}`));
    target.emit("uncaughtException", new Error("disk went away"), "uncaughtException");
    target.emit("unhandledRejection", "plain reason");
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /^main: uncaught exception: Error: disk went away/);
    assert.match(lines[0]!, /app-lifecycle\.test\.ts/, "the stack is kept");
    assert.equal(lines[1], "main: unhandled rejection: plain reason");
  });

  it("never throws from the handler, even when logging fails", () => {
    const target = new EventEmitter();
    installProcessHandlers(target, () => {
      throw new Error("log is gone");
    });
    assert.doesNotThrow(() => target.emit("unhandledRejection", new Error("x")));
  });
});

describe("reload after a renderer crash", () => {
  it("a clean exit is not a crash and never reloads", () => {
    const policy = createReloadPolicy({ now: () => 0 });
    assert.equal(policy.decide("clean-exit"), "clean-exit");
    assert.equal(policy.decide("crashed"), "reload", "a clean exit spends none of the budget");
  });

  it("reloads at most twice within a minute, then gives up until the window passes", () => {
    let time = 0;
    const policy = createReloadPolicy({ limit: 2, windowMs: 60_000, now: () => time });
    assert.equal(policy.decide("crashed"), "reload");
    time = 10_000;
    assert.equal(policy.decide("oom"), "reload");
    time = 20_000;
    assert.equal(policy.decide("crashed"), "give-up");
    time = 60_001;
    assert.equal(policy.decide("crashed"), "reload", "the first reload has aged out of the window");
    time = 69_999;
    assert.equal(policy.decide("crashed"), "give-up", "the reload at 10 s is still inside the window");
  });
});

describe("what a dead studio page gets", () => {
  const person = { quitting: false, unattended: false };

  it("nothing while quitting or after a clean exit; a reload within the budget", () => {
    assert.equal(pageRecovery("reload", { ...person, quitting: true }), "ignore");
    assert.equal(pageRecovery("clean-exit", person), "ignore");
    assert.equal(pageRecovery("reload", person), "reload");
  });

  it("past the budget the person is asked; unattended sessions, which show no dialog, leave it dead", () => {
    assert.equal(pageRecovery("give-up", person), "ask");
    assert.equal(pageRecovery("give-up", { ...person, unattended: true }), "leave");
    assert.equal(pageRecovery("reload", { ...person, unattended: true }), "reload", "a reload needs no one to answer");
  });

  it("follows the reload policy: two reloads a minute, then a question", () => {
    const policy = createReloadPolicy({ now: () => 0 });
    const steps = ["crashed", "oom", "crashed"].map((reason) => pageRecovery(policy.decide(reason), person));
    assert.deepEqual(steps, ["reload", "reload", "ask"]);
  });
});

describe("settleWithin", () => {
  it("answers the value when it arrives in time and the fallback when it does not", async () => {
    const timers = manualTimers();
    assert.equal(await settleWithin(Promise.resolve(3), 100, 0, timers), 3);
    const late = settleWithin(new Promise<number>(() => {}), 100, -1, timers);
    timers.fireAll();
    assert.equal(await late, -1);
  });

  it("answers the fallback when the work rejects", async () => {
    assert.equal(await settleWithin(Promise.reject(new Error("no")), 100, "fallback", manualTimers()), "fallback");
  });
});

describe("the quit sequence", () => {
  it("runs every step in order and reports none as failed", async () => {
    const order: string[] = [];
    const failures = await runShutdown(
      [
        {
          name: "a",
          timeoutMs: 100,
          run: async () => {
            order.push("a");
          },
        },
        {
          name: "b",
          timeoutMs: 100,
          run: () => {
            order.push("b");
          },
        },
      ],
      { log: () => {}, timers: manualTimers() },
    );
    assert.deepEqual(order, ["a", "b"]);
    assert.deepEqual(failures, []);
  });

  it("a step that throws is logged and the later steps still run", async () => {
    const order: string[] = [];
    const lines: string[] = [];
    const failures = await runShutdown(
      [
        {
          name: "release plugin leases",
          timeoutMs: 100,
          run: async () => {
            throw new Error("registry write failed");
          },
        },
        {
          name: "stop core",
          timeoutMs: 100,
          run: async () => {
            order.push("stop core");
          },
        },
      ],
      { log: (_source, line) => lines.push(line), timers: manualTimers() },
    );
    assert.deepEqual(order, ["stop core"]);
    assert.deepEqual(failures, ["release plugin leases"]);
    assert.match(lines.join("\n"), /release plugin leases failed: registry write failed/);
  });

  it("a step that hangs is abandoned at its timeout and the sequence resolves", async () => {
    const timers = manualTimers();
    const order: string[] = [];
    const lines: string[] = [];
    const done = runShutdown(
      [
        { name: "dispose terminals", timeoutMs: 3_000, run: () => new Promise<void>(() => {}) },
        {
          name: "stop core",
          timeoutMs: 10_000,
          run: async () => {
            order.push("stop core");
          },
        },
      ],
      { log: (_source, line) => lines.push(line), timers },
    );
    // Let the first step start, then run out its clock.
    await Promise.resolve();
    timers.fireAll();
    const failures = await done;
    assert.deepEqual(order, ["stop core"]);
    assert.deepEqual(failures, ["dispose terminals"]);
    assert.ok(timers.delays.includes(3_000));
    assert.match(lines.join("\n"), /dispose terminals timed out after 3000 ms/);
  });

  it("clears the timer of a step that finished in time", async () => {
    const timers = manualTimers();
    let cleared = 0;
    const clear = timers.clearTimeout;
    timers.clearTimeout = (id) => {
      cleared++;
      clear(id);
    };
    await runShutdown([{ name: "a", timeoutMs: 100, run: async () => {} }], { log: () => {}, timers });
    assert.equal(cleared, 1);
  });
});

describe("quitQuestion: what a quit or a relaunch into an update asks first", () => {
  const RESUME_AT = Date.parse("2026-10-06T05:00:00.000Z");
  const rows: Array<{
    name: string;
    runActive: boolean;
    resumeAt: number | null;
    confirmed: boolean;
    want: QuitQuestion;
  }> = [
    {
      name: "nothing running or waiting quits at once",
      runActive: false,
      resumeAt: null,
      confirmed: false,
      want: QuitQuestion.None,
    },
    {
      name: "an active run asks first",
      runActive: true,
      resumeAt: null,
      confirmed: false,
      want: QuitQuestion.RunActive,
    },
    {
      name: "a paused build waiting to resume on its own asks first: the quit drops the resume",
      runActive: false,
      resumeAt: RESUME_AT,
      confirmed: false,
      want: QuitQuestion.ResumePending,
    },
    {
      name: "an active run is the question even with a resume waiting",
      runActive: true,
      resumeAt: RESUME_AT,
      confirmed: false,
      want: QuitQuestion.RunActive,
    },
    {
      name: "an answered quit does not ask twice",
      runActive: true,
      resumeAt: RESUME_AT,
      confirmed: true,
      want: QuitQuestion.None,
    },
  ];
  for (const { name, want, ...state } of rows) {
    it(name, () => assert.equal(quitQuestion(state), want));
  }
});
