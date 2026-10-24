/**
 * When the studio ends native games (`core/native-lifecycle.ts`), over a fake registry that knows
 * which runs exist: window close ends every run, a renderer crash ends the embedded ones, composer
 * Stop cancels its own game's builds before it ends that game's agent runs and leaves other games
 * and the person's Play window, harness death ends its leases' runs, and the quit step that stops
 * native games is bounded. Nothing pauses.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  nativeOnComposerStop,
  nativeOnHarnessGone,
  nativeOnRendererGone,
  nativeOnWindowClosed,
} from "../../src/main/core/native-lifecycle.ts";
import type { NativeRunsHost } from "../../src/main/core/native-runs.ts";
import { runShutdown, shutdownSteps, type ShutdownTimers } from "../../src/main/app-lifecycle.ts";
import { NATIVE_STOP_BUDGET_MS, NativeRunMode } from "../../src/shared/native-contract.ts";
import { coreLite } from "../helpers/core-lite.ts";

/** One fake run: its game, its mode and the lease that started it. */
interface FakeRun {
  runId: string;
  project: string;
  mode: NativeRunMode;
  owner: string | null;
}

/** A registry that records every call in order and ends the runs each stop names. */
function fakeRuns(runs: FakeRun[]) {
  const live = new Map(runs.map((run) => [run.runId, run]));
  const calls: string[] = [];
  const end = (keep: (run: FakeRun) => boolean) => {
    for (const run of [...live.values()]) if (!keep(run)) live.delete(run.runId);
  };
  const registry: Pick<NativeRunsHost, "stopAll" | "stopMode" | "stopAgentRuns" | "stopProject" | "stopOwnedBy"> & {
    pause(): never;
  } = {
    stopAll: async () => {
      calls.push("stopAll");
      end(() => false);
    },
    stopMode: async (mode) => {
      calls.push(`stopMode:${mode}`);
      end((run) => run.mode !== mode);
    },
    stopAgentRuns: async () => {
      calls.push("stopAgentRuns");
      end((run) => run.mode !== NativeRunMode.Headless);
    },
    stopProject: async (project, modes) => {
      calls.push(`stopProject:${project}:${modes.join(",")}`);
      end((run) => run.project !== project || !modes.includes(run.mode));
    },
    stopOwnedBy: async (owner) => {
      calls.push(`stopOwnedBy:${owner}`);
      end((run) => run.owner !== owner);
    },
    pause: () => {
      throw new Error("a native run is never paused");
    },
  };
  return { registry, calls, live: () => [...live.keys()].sort() };
}

const RUNS: FakeRun[] = [
  { runId: "play", project: "pond", mode: NativeRunMode.Window, owner: null },
  { runId: "agent-1", project: "pond", mode: NativeRunMode.Headless, owner: "harness:1" },
  { runId: "agent-2", project: "lake", mode: NativeRunMode.Headless, owner: "harness:2" },
  { runId: "live", project: "pond", mode: NativeRunMode.Embedded, owner: null },
];

describe("when the studio ends native games", () => {
  it("closing the studio window ends every run, the Play window included", async () => {
    const { registry, calls, live } = fakeRuns(RUNS);
    await nativeOnWindowClosed(registry);
    assert.deepEqual(calls, ["stopAll"]);
    assert.deepEqual(live(), []);
  });

  it("a renderer crash ends only the runs drawn inside it", async () => {
    const { registry, calls, live } = fakeRuns(RUNS);
    await nativeOnRendererGone(registry);
    assert.deepEqual(calls, [`stopMode:${NativeRunMode.Embedded}`]);
    assert.deepEqual(live(), ["agent-1", "agent-2", "play"]);
  });

  it("composer Stop cancels its game's builds first, then ends that game's agent runs, and leaves the rest", async () => {
    const { registry, calls, live } = fakeRuns(RUNS);
    const builds = { cancelGame: (project: string) => void calls.push(`cancelGame:${project}`) };
    await nativeOnComposerStop(builds, registry, "pond");
    assert.deepEqual(calls, ["cancelGame:pond", `stopProject:pond:${NativeRunMode.Headless}`]);
    assert.deepEqual(
      live(),
      ["agent-2", "live", "play"],
      "another game's agent run and the person's views keep running",
    );
  });

  it("harness death ends the runs its own leases started", async () => {
    const { registry, calls, live } = fakeRuns(RUNS);
    await nativeOnHarnessGone(registry, "harness:1");
    assert.deepEqual(calls, ["stopOwnedBy:harness:1"]);
    assert.deepEqual(live(), ["agent-2", "live", "play"]);
  });
});

describe("the studio's own wiring", () => {
  /** A lite core whose C++ lane and registry record what a Stop cancels and ends. */
  async function stopRig() {
    const lite = await coreLite();
    const { registry, calls, live } = fakeRuns(RUNS);
    Object.assign(lite.core.cppBuilds, {
      cancelAll: () => void calls.push("cancelAll"),
      cancelGame: (project: string) => void calls.push(`cancelGame:${project}`),
    });
    Object.assign(lite.core.nativeRuns, { stopAgentRuns: registry.stopAgentRuns, stopProject: registry.stopProject });
    return { lite, calls, live };
  }

  /** The Stop's game work is started at once, after the thread's record is read: the thread's own stop does not wait for it. */
  async function settled(calls: string[], count: number): Promise<void> {
    for (let i = 0; i < 50 && calls.length < count; i++) await new Promise((resolve) => setImmediate(resolve));
  }

  it("composer Stop in one game's chat cancels that game's builds before its agent runs end, and never another game's", async () => {
    const { lite, calls, live } = await stopRig();
    const thread = await lite.core.store.createThread({ title: "Pond", metadata: { kind: "game", project: "pond" } });
    await lite.core.stopThread(thread).catch(() => {});
    await settled(calls, 2);
    assert.deepEqual(calls, ["cancelGame:pond", `stopProject:pond:${NativeRunMode.Headless}`]);
    assert.deepEqual(live(), ["agent-2", "live", "play"]);
    await lite.close();
  });

  it("composer Stop in a chat with no game cancels no game's builds", async () => {
    const { lite, calls } = await stopRig();
    await lite.core.stopThread("no-such-thread").catch(() => {});
    await settled(calls, 1);
    assert.deepEqual(calls, []);
    await lite.close();
  });
});

describe("quitting stops native games, bounded", () => {
  /** Timers that fire only when the test says so. */
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
  const idle = { release() {}, dismiss() {}, cancel() {}, dispose() {} };

  it("stops native games before the core, within the stop sequence's budget", () => {
    const steps = shutdownSteps({
      keepAwake: idle,
      codexLogin: idle,
      claudeLogin: idle,
      terminals: idle,
      core: null,
      native: { stopAll: async () => {} },
    });
    const names = steps.map((step) => step.name);
    const native = names.indexOf("stop native games");
    assert.ok(native >= 0, "a step stops native games");
    assert.ok(native < names.indexOf("stop the studio core"), "before the core stops");
    const step = steps[native];
    assert.ok(step);
    assert.ok(step.timeoutMs >= NATIVE_STOP_BUDGET_MS, "long enough for quit, TERM and KILL");
  });

  it("a native stop that hangs is abandoned at its bound, and the core still stops", async () => {
    const order: string[] = [];
    const timers = manualTimers();
    const steps = shutdownSteps({
      keepAwake: idle,
      codexLogin: idle,
      claudeLogin: idle,
      terminals: idle,
      core: {
        host: { stop: async () => void order.push("harness"), kill: () => void order.push("kill") },
        stop: async () => void order.push("core"),
      },
      native: { stopAll: () => new Promise<void>(() => void order.push("native")) },
    });
    const done = runShutdown(steps, { log: () => {}, timers });
    // Let the steps run up to the hanging one, then let its bound pass.
    for (let i = 0; i < 20 && !order.includes("native"); i++) await new Promise((resolve) => setImmediate(resolve));
    timers.fireAll();
    const failed = await done;
    assert.deepEqual(failed, ["stop native games"]);
    assert.deepEqual(order, ["harness", "native", "core", "kill"]);
  });
});
