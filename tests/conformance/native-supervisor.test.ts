/**
 * The native supervisor: a utility process the app forks beside its terminals, told each native
 * game's process group and start time. When its parent (the app) is gone — a crash, a force quit —
 * it kills every registered group whose start time still matches, and exits, so no game outlives
 * the app. A run the registry forgot (it ended) is never killed, and neither is a pid reused by
 * another process. The rules run over an injected parent, `ps`, `kill` and clock; the real rows
 * use real children, `ps` and signals.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { symlink } from "node:fs/promises";
import path from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { NativeTimers } from "../../src/shared/native-contract.ts";
import {
  lazyNativeSupervisorClient,
  type NativeSupervisorMessage,
  OWNER_POLL_MS,
  processStartedAt,
  superviseNativeRuns,
} from "../../src/main/native-supervisor-logic.ts";
import { runNativeSupervisor } from "../../src/main/native-supervisor.ts";
import { running } from "../helpers/processes.ts";
import { tmpDir } from "../helpers/tmp.ts";

const POSIX_ONLY = process.platform === "win32" ? "not run: process groups and ps are POSIX" : false;

function fakeClock() {
  let now = 0;
  const due: Array<{ at: number; run: () => void }> = [];
  const timers: NativeTimers = {
    now: () => now,
    setTimeout: (run, ms) => {
      const timer = { at: now + ms, run };
      due.push(timer);
      return timer;
    },
    clearTimeout: (handle) => {
      const index = due.findIndex((timer) => timer === handle);
      if (index >= 0) due.splice(index, 1);
    },
  };
  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      for (let round = 0; round < 5; round++) await tick();
      due.sort((a, b) => a.at - b.at);
      const next = due[0];
      if (!next || next.at > until) break;
      due.shift();
      now = next.at;
      next.run();
    }
    now = until;
    for (let round = 0; round < 5; round++) await tick();
  };
  return { timers, advance };
}

function supervisor(starts: Map<number, string>) {
  const clock = fakeClock();
  let parent = 4000;
  const killed: Array<[number, string]> = [];
  let exited = 0;
  const handle = superviseNativeRuns({
    ppid: () => parent,
    startedAt: async (pid) => starts.get(pid) ?? null,
    kill: (pgid, signal) => void killed.push([pgid, signal]),
    timers: clock.timers,
    exit: () => void exited++,
  });
  return {
    clock,
    handle,
    killed,
    exited: () => exited,
    orphan: () => {
      parent = 1;
    },
  };
}

const register = (runId: string, pgid: number, lstart: string): NativeSupervisorMessage => ({
  register: { runId, pgid, lstart },
});

describe("the supervisor's rules", () => {
  it("a parent that is gone (the ppid flips) kills every registered group and exits", async () => {
    const s = supervisor(
      new Map([
        [5001, "Thu Oct  1 12:00:01 2026"],
        [5002, "Thu Oct  1 12:00:02 2026"],
      ]),
    );
    s.handle(register("aaaaaaaaaaaa", 5001, "Thu Oct  1 12:00:01 2026"));
    s.handle(register("bbbbbbbbbbbb", 5002, "Thu Oct  1 12:00:02 2026"));
    await s.clock.advance(OWNER_POLL_MS * 3);
    assert.deepEqual(s.killed, [], "the app still runs: nothing is killed");
    s.orphan();
    await s.clock.advance(OWNER_POLL_MS);
    assert.deepEqual(s.killed, [
      [5001, "SIGKILL"],
      [5002, "SIGKILL"],
    ]);
    assert.equal(s.exited(), 1);
  });

  it("a forgotten run is not killed, nor a pid another process now has", async () => {
    const s = supervisor(
      new Map([
        [5001, "Thu Oct  1 12:00:01 2026"],
        [5003, "Thu Oct  1 13:30:00 2026"],
      ]),
    );
    s.handle(register("aaaaaaaaaaaa", 5001, "Thu Oct  1 12:00:01 2026"));
    s.handle({ forget: "aaaaaaaaaaaa" });
    s.handle(register("cccccccccccc", 5003, "Thu Oct  1 12:00:03 2026"));
    s.orphan();
    await s.clock.advance(OWNER_POLL_MS);
    assert.deepEqual(s.killed, []);
    assert.equal(s.exited(), 1);
  });

  it("a malformed message registers nothing", async () => {
    const s = supervisor(new Map([[1, "Thu Oct  1 00:00:00 2026"]]));
    for (const message of [
      { register: { runId: "x", pgid: 1, lstart: "Thu Oct  1 00:00:00 2026" } },
      { register: { runId: "aaaaaaaaaaaa", pgid: -1, lstart: "Thu" } },
      { register: { runId: "aaaaaaaaaaaa", pgid: 1.5, lstart: "Thu" } },
      { register: null },
      "register",
      null,
    ])
      s.handle(message as never);
    s.orphan();
    await s.clock.advance(OWNER_POLL_MS);
    assert.deepEqual(s.killed, []);
  });

  it("the registry's client posts one message per call", () => {
    const posted: NativeSupervisorMessage[] = [];
    const client = lazyNativeSupervisorClient(() => ({ postMessage: (message) => void posted.push(message) }));
    client.register({ runId: "aaaaaaaaaaaa", pgid: 5001, lstart: "now" });
    client.forget("aaaaaaaaaaaa");
    assert.deepEqual(posted, [register("aaaaaaaaaaaa", 5001, "now"), { forget: "aaaaaaaaaaaa" }]);
  });

  it("the app's client forks the supervisor at its first run, once, and never for a forget alone", () => {
    const posted: NativeSupervisorMessage[] = [];
    let forks = 0;
    const client = lazyNativeSupervisorClient(() => {
      forks += 1;
      return { postMessage: (message) => void posted.push(message) };
    });
    assert.equal(forks, 0, "nothing is forked before a game runs: the app may not be ready yet");
    client.forget("aaaaaaaaaaaa");
    assert.equal(forks, 0, "a forget with no supervisor has nothing to tell");
    client.register({ runId: "bbbbbbbbbbbb", pgid: 5002, lstart: "now" });
    client.register({ runId: "cccccccccccc", pgid: 5003, lstart: "later" });
    client.forget("bbbbbbbbbbbb");
    assert.equal(forks, 1, "one supervisor for every run");
    assert.deepEqual(posted, [
      register("bbbbbbbbbbbb", 5002, "now"),
      register("cccccccccccc", 5003, "later"),
      { forget: "bbbbbbbbbbbb" },
    ]);
  });

  it("the utility entry refuses to run outside a utility process", () => {
    assert.throws(() => runNativeSupervisor(undefined), /utility process/);
  });
});

describe("the supervisor with real children", { skip: POSIX_ONLY }, () => {
  /** A real game stand-in: its own process group, as spawnGame starts one. */
  function game() {
    const child = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
    assert.ok(child.pid);
    const exited = new Promise<void>((done) => child.once("exit", () => done()));
    return { pid: child.pid, exited };
  }

  it("a ppid flip kills a registered real group; a forgotten one keeps running", async () => {
    const clock = fakeClock();
    let parent = process.pid;
    let exited = 0;
    const handle = superviseNativeRuns({
      ppid: () => parent,
      startedAt: processStartedAt,
      kill: (pgid, signal) => process.kill(-pgid, signal),
      timers: clock.timers,
      exit: () => void exited++,
    });
    const doomed = game();
    const kept = game();
    try {
      const [doomedStart, keptStart] = await Promise.all([processStartedAt(doomed.pid), processStartedAt(kept.pid)]);
      assert.ok(doomedStart && keptStart, "ps names both start times");
      handle(register("dddddddddddd", doomed.pid, doomedStart));
      handle(register("eeeeeeeeeeee", kept.pid, keptStart));
      handle({ forget: "eeeeeeeeeeee" });
      parent = 1;
      await clock.advance(OWNER_POLL_MS);
      await doomed.exited;
      assert.equal(running(doomed.pid), false, "the registered game is gone");
      assert.equal(running(kept.pid), true, "the forgotten one was left alone");
      assert.equal(exited, 1);
    } finally {
      for (const pid of [doomed.pid, kept.pid]) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      await Promise.all([doomed.exited, kept.exited]);
    }
  });
});

describe("the supervisor's bundle", () => {
  it("the build bundles the utility entry where the app looks for it", async () => {
    const { nodeBundles } = await import("../../scripts/build.mjs");
    const root = fileURLToPath(new URL("../..", import.meta.url));
    const dist = path.join(root, "dist");
    const bundles = nodeBundles(root, dist) as Array<{ entry: string; outfile: string; format: string }>;
    const supervisorBundle = bundles.find((bundle) =>
      bundle.entry.endsWith(path.join("src", "main", "native-supervisor.ts")),
    );
    assert.deepEqual(supervisorBundle, {
      entry: path.join(root, "src", "main", "native-supervisor.ts"),
      outfile: path.join(dist, "resources", "native", "supervisor.cjs"),
      format: "cjs",
    });
    assert.ok(bundles.some((bundle) => bundle.outfile === path.join(dist, "resources", "terminal", "host.cjs")));
  });

  it("the build runs when started through a link to it, and only importing it builds nothing", async () => {
    const { runsAsScript } = await import("../../scripts/build.mjs");
    const script = fileURLToPath(new URL("../../scripts/build.mjs", import.meta.url));
    const scriptUrl = pathToFileURL(script).href;
    const links = await tmpDir("build-links-");
    const linked = path.join(links, "build.mjs");
    await symlink(script, linked);
    const linkedFolder = path.join(links, "scripts");
    await symlink(path.dirname(script), linkedFolder);
    const rows: Array<[string, string | undefined, boolean]> = [
      ["the script itself", script, true],
      ["a link to the script", linked, true],
      ["the script through a linked folder", path.join(linkedFolder, "build.mjs"), true],
      ["another script (a test runner importing it)", fileURLToPath(import.meta.url), false],
      ["no script at all (a REPL)", undefined, false],
      ["a path that does not exist", path.join(links, "missing.mjs"), false],
    ];
    for (const [label, argv1, expected] of rows) assert.equal(runsAsScript(argv1, scriptUrl), expected, label);
  });
});
