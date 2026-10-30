/**
 * The Loop's one health check (loop/health-check.ts): the page loads, it logs no uncaught error and
 * its screenshot is not blank. Genex looks from outside — its own window, the window's console, a
 * screenshot of the page — before a worker's work is merged in and before the build lands.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  blankPicture,
  checkHealth,
  HEALTH_WORDS,
  healthLine,
  pageErrors,
} from "../../src/harness-seed/loop/health-check.ts";
import { HostMethod } from "../../src/harness-seed/loop/host-methods.ts";
import { PreviewConsoleSource } from "../../src/harness-seed/loop/preview-gone.ts";
import { RunEvent } from "../../src/harness-seed/loop/run-events.ts";
import { appended, fakeHost, fakeLoopRun } from "../helpers/director-run.ts";

/** The integration head the rows' git answers. */
const HEAD = "1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a";
/** A screenshot with something on it. */
const LIT = { stats: { contrast: 42, litFraction: 0.6 }, path: "/runs/run_j/health.png" };
/** One flat colour. */
const FLAT = { stats: { contrast: 0, litFraction: 1 }, path: "/runs/run_j/flat.png" };
/** The page's own uncaught error, as the window's console keeps it. */
const UNCAUGHT = { level: "error", message: "TypeError: player is undefined" };

/** What one page answers: its console, its picture, its window's status, and whether a window comes. */
interface Page {
  console?: unknown[];
  shot?: unknown;
  status?: Record<string, unknown>;
  window?: boolean;
  loadFails?: boolean;
}

/** The preview's answers for `page`, by method. */
function previewAnswers(page: Page = {}): Record<string, unknown> {
  return {
    [HostMethod.PreviewAcquire]: page.window === false ? null : { handle: "pool:1" },
    [HostMethod.PreviewLoad]: () => {
      if (page.loadFails) throw new Error("the serve layer stopped");
      return { ok: true };
    },
    [HostMethod.PreviewReady]: { ready: true },
    [HostMethod.PreviewStatus]: page.status ?? { loadError: null, crashed: false },
    [HostMethod.PreviewConsole]: page.console ?? [],
    [HostMethod.PreviewScreenshot]: page.shot === undefined ? LIT : page.shot,
  };
}

/** A harness ctx over `answers`, every call kept. */
function pageCtx(answers: Record<string, unknown>) {
  const calls: Array<{ method: string; params: Record<string, any> }> = [];
  const ctx = {
    threadId: "t1",
    cancelled: false,
    call: async (method: string, params: Record<string, any>) => {
      calls.push({ method, params });
      const answer = answers[method];
      return typeof answer === "function" ? answer(params) : (answer ?? null);
    },
  };
  return { ctx: ctx as never, calls, methods: () => calls.map((call) => call.method) };
}

/** A clock whose sleeps are only counted. */
function heldClock() {
  const slept: number[] = [];
  return {
    slept,
    sleep: async (ms: number) => {
      slept.push(ms);
    },
  };
}

/** The git the run's integration worktree answers: nothing uncommitted, the head at HEAD. */
function gitAnswers(params: Record<string, any>) {
  const command = String(params.command ?? "");
  if (command.startsWith("git rev-parse HEAD")) return { code: 0, stdout: `${HEAD}\n` };
  return { code: 0, stdout: "" };
}

describe("the Loop's health check", () => {
  it("a page that loads, logs no error and shows a picture is healthy, and its window is given back", async () => {
    const { ctx, calls, methods } = pageCtx(previewAnswers());
    const check = await checkHealth(ctx, { project: "plaza", root: "/runs/w", label: "merge" }, heldClock());
    assert.equal(check.ok, true);
    assert.deepEqual(check.problems, []);
    assert.equal(check.picture, LIT.path);
    assert.equal(healthLine(check), "Health check: the page loads, logs no errors and shows a picture.");
    const load = calls.find((call) => call.method === HostMethod.PreviewLoad);
    assert.equal(load?.params.root, "/runs/w", "the worktree's build is the one served");
    const shot = calls.find((call) => call.method === HostMethod.PreviewScreenshot);
    assert.equal(shot?.params.surface, "page", "the whole page, its HTML included");
    assert.equal(methods().at(-1), HostMethod.PreviewRelease);
    for (const asked of methods()) assert.ok(asked.startsWith("preview."), `${asked}: it looks from outside only`);
  });

  it("an uncaught error, a load error, a crashed window or a blank picture each fail it, in words", async () => {
    const cases: Array<[string, Page, (check: Awaited<ReturnType<typeof checkHealth>>) => void]> = [
      [
        "uncaught error",
        { console: [UNCAUGHT, { level: "warning", message: "slow frame" }] },
        (check) => {
          assert.deepEqual(check.errors, [UNCAUGHT.message]);
          assert.deepEqual(check.problems, [HEALTH_WORDS.errors([UNCAUGHT.message])]);
        },
      ],
      [
        "load error",
        { status: { loadError: "net::ERR_FILE_NOT_FOUND" } },
        (check) => {
          assert.equal(check.loaded, false);
          assert.deepEqual(check.problems, [HEALTH_WORDS.loadFailed("net::ERR_FILE_NOT_FOUND")]);
        },
      ],
      [
        "crashed window",
        { status: { crashed: true } },
        (check) => {
          assert.equal(check.loaded, false);
          assert.deepEqual(check.problems, [HEALTH_WORDS.crashed]);
        },
      ],
      [
        "blank picture",
        { shot: FLAT },
        (check) => {
          assert.equal(check.blank, true);
          assert.deepEqual(check.problems, [HEALTH_WORDS.blank]);
        },
      ],
      [
        "no picture",
        { shot: null },
        (check) => {
          assert.equal(check.blank, true);
          assert.deepEqual(check.problems, [HEALTH_WORDS.noPicture]);
        },
      ],
    ];
    for (const [name, page, expect] of cases) {
      const { ctx, methods } = pageCtx(previewAnswers(page));
      const check = await checkHealth(ctx, { project: "plaza", label: name }, heldClock());
      assert.equal(check.ok, false, name);
      assert.equal(check.unchecked, null, `${name}: the check was made`);
      expect(check);
      assert.equal(methods().at(-1), HostMethod.PreviewRelease, `${name}: the window is given back`);
    }
  });

  it("reads the page's own errors, never the studio's notes about its window", () => {
    const entries = [
      UNCAUGHT,
      { level: "error", message: "the window went away", source: PreviewConsoleSource.WindowGone },
      { level: "error", message: "observation note", source: PreviewConsoleSource.Observation },
      { level: "log", message: "ready" },
      "not an entry",
    ];
    assert.deepEqual(pageErrors(entries), [UNCAUGHT.message]);
    assert.deepEqual(pageErrors(null), []);
  });

  it("calls a picture blank by its spread of brightness, else by how little of it is lit", () => {
    const rows: Array<[unknown, boolean]> = [
      [{ contrast: 0 }, true],
      [{ contrast: 0.5, litFraction: 1 }, true],
      [{ contrast: 1 }, false],
      [{ contrast: 30, litFraction: 0 }, false],
      [{ litFraction: 0.001 }, true],
      [{ litFraction: 0.2 }, false],
      [{}, true],
      [null, true],
    ];
    for (const [stats, blank] of rows) assert.equal(blankPicture(stats), blank, JSON.stringify(stats));
  });

  it("with no window free it says the check could not be made, after its retries on the run's clock", async () => {
    const clock = heldClock();
    const { ctx, methods } = pageCtx(previewAnswers({ window: false }));
    const check = await checkHealth(ctx, { project: "plaza", label: "finish" }, clock);
    assert.equal(check.ok, false);
    assert.equal(check.unchecked, HEALTH_WORDS.noWindow);
    assert.deepEqual(clock.slept, [1000, 2000, 4000]);
    assert.ok(!methods().includes(HostMethod.PreviewLoad), "nothing was loaded");
  });

  it("a host that fails mid-check gives the window back and says the check could not run", async () => {
    const { ctx, methods } = pageCtx(previewAnswers({ loadFails: true }));
    const check = await checkHealth(ctx, { project: "plaza", label: "finish" }, heldClock());
    assert.equal(check.unchecked, HEALTH_WORDS.failed("the serve layer stopped"));
    assert.equal(methods().at(-1), HostMethod.PreviewRelease);
  });
});

describe("the health check in a web game's Loop", () => {
  it("a worker's merge is answered with the merged build's health check, on the run's record", async () => {
    const host = fakeHost();
    const loopRun = fakeLoopRun(
      host,
      {},
      { ...previewAnswers({ console: [UNCAUGHT] }), [HostMethod.RunExec]: gitAnswers },
    );
    const line = await loopRun.afterMerge({ id: "w1" });
    assert.equal(line, `Health check failed: ${HEALTH_WORDS.errors([UNCAUGHT.message])}.`);
    assert.equal(loopRun.state.integrationHealthy, false);
    assert.equal(loopRun.state.healthByHead.get(HEAD)?.ok, false);
    const [health] = appended(host).filter((event) => event.type === RunEvent.IntegrationHealth);
    assert.equal(health?.payload.head, HEAD);
    assert.equal(health?.payload.ok, false);
    const served = host.calls.find((call) => call.method === HostMethod.PreviewLoad);
    assert.equal(served?.params.root, loopRun.integrationWorktree, "the integration worktree's build is checked");
  });

  it("finish does not make live a build that fails its health check, and tells the lead why", async () => {
    const host = fakeHost();
    const loopRun = fakeLoopRun(host, {}, { ...previewAnswers({ shot: FLAT }), [HostMethod.RunExec]: gitAnswers });
    const answer = await loopRun.finish({ summary: "The plaza is built." });
    assert.match(String(answer), /^Not finished: the build fails its health check/);
    assert.ok(String(answer).includes(HEALTH_WORDS.blank));
    assert.equal(loopRun.state.finish, null, "the run is not closed");
    assert.ok(!appended(host).some((event) => event.type === RunEvent.RunFinished), "nothing landed");
  });

  it("a head that still holds the user's own repository as a pointer fails it: no edit there could land", async () => {
    const host = fakeHost();
    const exec = (params: Record<string, any>) =>
      String(params.command).startsWith("git ls-tree HEAD -- ")
        ? { code: 0, stdout: `160000 commit ${HEAD}\tvendor/engine\n` }
        : gitAnswers(params);
    const loopRun = fakeLoopRun(
      host,
      { nestedRepos: ["vendor/engine"] },
      { ...previewAnswers(), [HostMethod.RunExec]: exec },
    );
    const line = await loopRun.afterMerge({ id: "w1" });
    assert.match(
      line,
      /^Health check failed: vendor\/engine\/ is the user's own repository and this build carries nothing from inside it/,
    );
    assert.equal(loopRun.state.integrationHealthy, false);
  });
});
