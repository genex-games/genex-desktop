/**
 * The Loop's one health check (loop/health-check.ts): the page loads, it throws no uncaught error and
 * its frame is not blank. Genex serves the build in a window of its own and asks the host's own check
 * (`preview.observe`) — before a worker's work is merged in and before the build lands.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkHealth, HEALTH_WORDS, healthLine } from "../../src/harness-seed/loop/health-check.ts";
import { HostMethod } from "../../src/harness-seed/loop/host-methods.ts";
import { RunEvent } from "../../src/harness-seed/loop/run-events.ts";
import { appended, fakeHost, fakeLoopRun } from "../helpers/director-run.ts";

/** The integration head the rows' git answers. */
const HEAD = "1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a";
/** The screenshot the check keeps. */
const SHOT = { stats: { contrast: 42 }, path: "/runs/run_j/health.png" };
/** The host's reasons, in its own words: a page that threw, and one whose frame is blank. */
const UNCAUGHT = "1 uncaught error: TypeError: player is undefined";
const BLANK = "the page's frame is blank: one flat colour, nothing drawn";

/** What one page answers: the host's check, and whether a window comes or the load fails. */
interface Page {
  observed?: unknown;
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
    [HostMethod.PreviewObserve]: page.observed === undefined ? { ok: true, reasons: [] } : page.observed,
    [HostMethod.PreviewScreenshot]: SHOT,
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
  it("serves the build in a window of its own, asks the host's check, keeps a picture and gives the window back", async () => {
    const { ctx, calls, methods } = pageCtx(previewAnswers());
    const check = await checkHealth(ctx, { project: "plaza", root: "/runs/w", label: "merge" }, heldClock());
    assert.deepEqual(check, { ok: true, problems: [], picture: SHOT.path, unchecked: null });
    assert.equal(
      healthLine(check),
      "Health check: the page loads, throws no uncaught error and its frame is not blank.",
    );
    const load = calls.find((call) => call.method === HostMethod.PreviewLoad);
    assert.equal(load?.params.root, "/runs/w", "the worktree's build is the one served");
    const observe = calls.find((call) => call.method === HostMethod.PreviewObserve);
    assert.equal(observe?.params.handle, "pool:1", "in the window it leased, never the person's Live");
    const shot = calls.find((call) => call.method === HostMethod.PreviewScreenshot);
    assert.equal(shot?.params.surface, "page", "the whole page, its HTML included");
    assert.equal(methods().at(-1), HostMethod.PreviewRelease);
    for (const asked of methods()) assert.ok(asked.startsWith("preview."), `${asked}: it looks from outside only`);
  });

  it("fails on each reason the host gives, in the host's own words", async () => {
    for (const reasons of [[UNCAUGHT], [BLANK], [UNCAUGHT, BLANK]]) {
      const { ctx, methods } = pageCtx(previewAnswers({ observed: { ok: false, reasons } }));
      const check = await checkHealth(ctx, { project: "plaza", label: "merge" }, heldClock());
      assert.equal(check.ok, false);
      assert.deepEqual(check.problems, reasons);
      assert.equal(check.unchecked, null, "the check was made");
      assert.equal(healthLine(check), `Health check failed: ${reasons.join("; ")}.`);
      assert.equal(methods().at(-1), HostMethod.PreviewRelease);
    }
  });

  it("is no pass when the host's check answers nothing it can read", async () => {
    for (const observed of [null, {}, { ok: "yes" }]) {
      const { ctx } = pageCtx(previewAnswers({ observed }));
      const check = await checkHealth(ctx, { project: "plaza", label: "merge" }, heldClock());
      assert.equal(check.ok, false, JSON.stringify(observed));
      assert.equal(check.unchecked, HEALTH_WORDS.noAnswer);
    }
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
    const observed = { ok: false, reasons: [UNCAUGHT] };
    const loopRun = fakeLoopRun(host, {}, { ...previewAnswers({ observed }), [HostMethod.RunExec]: gitAnswers });
    const line = await loopRun.afterMerge({ id: "w1" });
    assert.equal(line, `Health check failed: ${UNCAUGHT}.`);
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
    const observed = { ok: false, reasons: [BLANK] };
    const loopRun = fakeLoopRun(host, {}, { ...previewAnswers({ observed }), [HostMethod.RunExec]: gitAnswers });
    const answer = await loopRun.finish({ summary: "The plaza is built." });
    assert.match(String(answer), /^Not finished: the build fails its health check/);
    assert.ok(String(answer).includes(BLANK));
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
