/**
 * A Loop's hours are a soft cap: an early yes ends it, the lead hears 15 minutes before and at the
 * cap, and Genex closes it after a short grace. One rule for the open Loop and the web director.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { directorBrief } from "../../src/harness-seed/loop/director/briefs.ts";
import { MESSAGE as OPEN_END } from "../../src/harness-seed/loop/director/open/finish.ts";
import { StopWhy } from "../../src/harness-seed/loop/finish-contract.ts";
import { WrapCause } from "../../src/harness-seed/loop/director/wake-schedule.ts";
import { HOUR_MS, MINUTE_MS, SECOND_MS } from "../../src/harness-seed/loop/time.ts";
import {
  CapPhase,
  capClock,
  capPhase,
  GRACE_MS,
  HEADS_UP_MS,
  ranOutUnchecked,
  UNTIL_DONE_CAP_MS,
} from "../../src/harness-seed/loop/time-cap.ts";
import { TIME_CAP_WORDS } from "../../src/harness-seed/loop/time-cap-prompts.ts";
import type { DelegateRequest, DelegateResult, LiveToolResult } from "../../src/substrate/engines/types.ts";
import { T0 } from "../helpers/director-run.ts";
import { gameRepo, type LoopHost, type LoopTurn, loopHost } from "../helpers/loop-host.ts";
import { copyProject, Project } from "../helpers/project-fixtures.ts";
import { reviewerAnswer, seatedReviewer } from "../helpers/reviewer.ts";
import { customEvents, makeFakePreview, type Rig, startRig, waitForLog } from "../helpers/studio-rig.ts";
import { tmpDir } from "../helpers/tmp.ts";

const TEST_TIMEOUT = { timeout: 60_000 };
const RIG_TIMEOUT = { timeout: 240_000 };
const GODOT = [{ id: "godot-project", path: "." }];
/** A timed Loop of half an hour: its heads-up comes 15 minutes in, its cap at 30. */
const HALF_HOUR = { budgets: { wallClockMs: 30 * MINUTE_MS, completionPolicy: "duration" } };

let runs = 0;
const rigs: Rig[] = [];
afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.stop().catch(() => {})));
});

/** An open Loop's host on a copy of the Godot fixture, under a run id of its own. */
async function godotHost(run: Record<string, unknown>, turns: LoopTurn[]): Promise<LoopHost> {
  const dir = await gameRepo(await copyProject(Project.GodotGame, await tmpDir("loop-time-cap-")));
  runs += 1;
  return loopHost({ dir, facts: GODOT, turns, run: { runId: `run-cap-${runs}`, ...run } });
}

/** A turn that claims the goal is reached, naming a file of the folder as proof. */
const finishes: LoopTurn = async ({ tool }) => {
  await tool("finish", { summary: "The level is built and the door opens.", proof: "project.godot", review: "yes" });
  return undefined;
};

/** What was steered into the lead's turns about its cap, in order. */
const capSteers = (host: LoopHost) => host.steered.filter((steer) => steer.id.startsWith("cap_"));

describe("a Loop's clock under its cap", () => {
  it("the clock: the cap is the hours, the heads-up 15 minutes before, the grace 15 minutes after", () => {
    const now = T0;
    assert.deepEqual(capClock({ saved: null, now, totalMs: 2 * HOUR_MS }), {
      started: now,
      headsUpAt: now + 2 * HOUR_MS - HEADS_UP_MS,
      softDeadline: now + 2 * HOUR_MS,
      finalDeadline: now + 2 * HOUR_MS + GRACE_MS,
    });
    const short = capClock({ saved: null, now, totalMs: 15 * MINUTE_MS });
    assert.equal(short.headsUpAt, null, "a Loop of 15 minutes gets no heads-up");
    assert.equal(short.finalDeadline, now + 15 * MINUTE_MS + GRACE_MS);
    const untilDone = capClock({ saved: null, now, totalMs: UNTIL_DONE_CAP_MS });
    assert.equal(untilDone.softDeadline, now + 24 * HOUR_MS, "∞ is capped at 24 hours");
    const pastCap = capClock({ saved: { workedMs: 3 * HOUR_MS }, now, totalMs: 2 * HOUR_MS });
    assert.deepEqual(pastCap, {
      started: now - 3 * HOUR_MS,
      headsUpAt: null,
      softDeadline: now,
      finalDeadline: now + GRACE_MS,
    });
    const before = capClock({ saved: { workedMs: HOUR_MS }, now, totalMs: 2 * HOUR_MS });
    assert.equal(before.softDeadline, now + HOUR_MS, "a resume before the cap has the working time it had left");
    assert.equal(before.headsUpAt, now + HOUR_MS - HEADS_UP_MS);
    const phases = [now, now + 106 * MINUTE_MS, now + 2 * HOUR_MS, now + 2 * HOUR_MS + GRACE_MS].map((at) =>
      capPhase(at, capClock({ saved: null, now, totalMs: 2 * HOUR_MS })),
    );
    assert.deepEqual(phases, [CapPhase.Working, CapPhase.HeadsUp, CapPhase.TimesUp, CapPhase.Over]);
  });

  it("the time cap's words are plain", () => {
    const words = [
      TIME_CAP_WORDS.headsUp(15),
      TIME_CAP_WORDS.timesUp,
      TIME_CAP_WORDS.noNewWorkers,
      TIME_CAP_WORDS.notChecked,
    ];
    for (const line of words) {
      assert.doesNotMatch(line, /night|morning|tonight|builder|sub-agent/i, line);
    }
    assert.match(TIME_CAP_WORDS.headsUp(15), /^About 15 minutes left: don't start anything big\./);
    assert.match(TIME_CAP_WORDS.timesUp, /^Time's up: put the build together\. Bring in finished worker work/);
    assert.match(TIME_CAP_WORDS.noNewWorkers, /no new workers/);
    assert.match(TIME_CAP_WORDS.notChecked, /^The time ran out before a final look/);
  });

  it("the time's up never tells a lead to claim a goal it hasn't reached", () => {
    for (const line of [TIME_CAP_WORDS.timesUp, TIME_CAP_WORDS.noNewWorkers])
      assert.match(line, /call finish, claiming the goal only if it is reached\.$/, line);
    const brief = directorBrief({
      run: { runId: "run_o", project: "level", goal: "a level", engine: "codex", budgets: { wallClockMs: HOUR_MS } },
      softDeadline: T0 + HOUR_MS,
      finalDeadline: T0 + HOUR_MS + GRACE_MS,
      integrationWorktree: "/runs/run_o/integration",
      baseCommit: "abcdef1234567890",
    } as never);
    assert.doesNotMatch(brief, /save, and call finish\./, "the web brief");
  });
});

describe("the open Loop under its cap", () => {
  it("an open Loop's claim before its cap goes to the reviewer, and a yes ends it", TEST_TIMEOUT, async () => {
    const host = await godotHost({ budgets: { wallClockMs: 3 * HOUR_MS, completionPolicy: "duration" } }, [finishes]);
    const report = await host.start();
    assert.equal(host.reviewed().length, 1, "the early claim was checked");
    assert.equal(report.victory, true, String(report.stoppedBecause));
    assert.equal(host.leadCalls().length, 1, "the yes ended the Loop");
  });

  it("the lead hears about 15 minutes left, then time's up, while its turn goes on", TEST_TIMEOUT, async () => {
    const host = await godotHost(HALF_HOUR, [
      async ({ host }) => {
        host.pass(HEADS_UP_MS + SECOND_MS);
        assert.ok(await host.until(() => capSteers(host).length === 1), "the heads-up reached the turn");
        host.pass(HEADS_UP_MS);
        assert.ok(await host.until(() => capSteers(host).length === 2), "the time's up reached the turn");
        return undefined;
      },
      finishes,
    ]);
    host.steerTakes = true;
    const report = await host.start();
    const steers = capSteers(host);
    assert.deepEqual(
      steers.map((steer) => steer.text),
      [TIME_CAP_WORDS.headsUp(15), TIME_CAP_WORDS.timesUp],
    );
    assert.equal(steers[0]?.interrupt, false, "the heads-up never cuts the turn short");
    const first = host.leadCalls()[0] as { timeoutMs?: number };
    assert.ok(Number(first.timeoutMs) > 30 * MINUTE_MS, "the turn may go on into the grace");
    assert.doesNotMatch(String(host.prompts()[1]), /Time's up/, "heard mid-turn: not said again");
    assert.equal(report.victory, true, String(report.stoppedBecause));
  });

  it(
    "an engine that can't read mid-turn is cut at the time's-up, and its wrap-up opens with it",
    TEST_TIMEOUT,
    async () => {
      const host = await godotHost(HALF_HOUR, [
        async ({ host }) => {
          host.pass(31 * MINUTE_MS);
          assert.ok(await host.until(() => capSteers(host).length === 1), "the time's up reached the turn");
          return undefined;
        },
        finishes,
      ]);
      host.steerTakes = true;
      host.steerHow = "interrupt";
      host.steerReads = false;
      const report = await host.start();
      const steers = capSteers(host);
      assert.deepEqual(
        steers.map((steer) => [steer.text, steer.interrupt]),
        [[TIME_CAP_WORDS.timesUp, true]],
        "said once, cutting the turn",
      );
      assert.match(String(host.prompts()[1]), /^Time's up: put the build together\./, "the wrap-up opens with it");
      assert.equal(report.victory, true, String(report.stoppedBecause));
    },
  );

  it("from the cap no worker starts", TEST_TIMEOUT, async () => {
    const answers: unknown[] = [];
    const host = await godotHost(HALF_HOUR, [
      async ({ host, tool }) => {
        host.pass(31 * MINUTE_MS);
        answers.push(
          await tool("worker_start", { title: "Bindings", task: "Rework the input bindings", isolation: "lock" }),
        );
        return undefined;
      },
      finishes,
    ]);
    const report = await host.start();
    assert.equal(answers[0], TIME_CAP_WORDS.noNewWorkers);
    assert.equal(host.workers.length, 0);
    assert.equal(report.victory, true, String(report.stoppedBecause));
  });

  it(
    "past the grace Genex closes the Loop with what is and isn't done, and keeps the last save point",
    TEST_TIMEOUT,
    async () => {
      const host = await godotHost(HALF_HOUR, [
        async ({ host, tool }) => {
          await writeFile(path.join(host.dir, "door.gd"), "extends Node\n");
          await tool("save_point", { label: "Door", summary: "the door opens" });
          host.pass(31 * MINUTE_MS);
          return undefined;
        },
        ({ host }) => {
          host.pass(GRACE_MS);
          return undefined;
        },
      ]);
      const report = await host.start();
      assert.equal(host.reviewed().length, 0);
      assert.match(String(host.prompts()[1]), /^Time's up: put the build together\./, "the wrap-up opens with it");
      assert.equal(report.stoppedBecause, OPEN_END.timeUpNoClaim);
      assert.deepEqual(report.notDone, [TIME_CAP_WORDS.notChecked]);
      assert.deepEqual(
        report.stillToFix,
        { done: [], notDone: [], why: StopWhy.Time, hours: 0.5 },
        "its card says its time ran out before a final look, with Keep building",
      );
      assert.match(String(report.summary), /Door/);
      assert.match(String(report.summary), /time ran out before a final look/);
      assert.deepEqual(
        (report.savePoints as Array<{ label: string }>).map((point) => point.label),
        ["Door"],
      );
      assert.equal(report.victory, false);
    },
  );
});

describe("a web Loop's close and its result card (director/integrate.ts)", () => {
  it("a Stop that refused a closing finish's landing pauses the build; one after it landed ends nothing more; a close its time ended lists what is left", async () => {
    const { endedAs } = await import("../../src/harness-seed/loop/director/integrate.ts");
    const STOPPED = { ok: false, why: "stopped", reason: "stopped by the user" };
    const LANDED = { ok: true, how: "judge-pick", line: "made live" };
    const closing = (over: { cancelled: boolean; state: Record<string, unknown> }, landed: object = STOPPED) => {
      const loopRun = {
        ctx: { cancelled: over.cancelled },
        journal: { phase: "running" },
        report: {} as Record<string, unknown>,
        run: { runId: "run_w", project: "plaza", budgets: { wallClockMs: 2 * HOUR_MS, completionPolicy: "duration" } },
        state: { integrationHead: "a".repeat(40), ...over.state },
      };
      endedAs(loopRun as never, landed);
      return loopRun;
    };
    const finish = { summary: "done", land: true, victory: true, at: 0 };
    const stopped = closing({ cancelled: true, state: { finish } });
    assert.equal(stopped.report.executionStatus, "paused", "Resume picks it up");
    assert.equal(stopped.report.stillToFix, undefined, "a pause keeps its own words, with no list");
    const late = closing({ cancelled: true, state: { finish } }, LANDED);
    assert.equal(late.report.executionStatus, "completed", "a Stop after the landing: the build is done, no Resume");
    const tally = { round: 1, rejections: 1, checking: false, reasons: [], notDone: ["No door"] };
    const timedOut = closing(
      {
        cancelled: false,
        state: { finish: { ...finish, victory: false }, endedWhy: StopWhy.Time, finishTally: tally },
      },
      LANDED,
    );
    assert.equal(timedOut.report.executionStatus, "completed");
    assert.deepEqual(timedOut.report.stillToFix, { done: [], notDone: ["No door"], why: StopWhy.Time, hours: 2 });
  });
});

describe("the open Loop past its grace with a claim", () => {
  it("a no and then the time running out ends on a card that says its time ran out", TEST_TIMEOUT, async () => {
    const left = "The door doesn't open from the far side.";
    const host = await godotHost(HALF_HOUR, [
      async ({ host, tool }) => {
        await tool("finish", {
          summary: "The level is built and the door opens.",
          proof: "project.godot",
          review: "yes",
        });
        host.pass(31 * MINUTE_MS);
        return undefined;
      },
      ({ host }) => {
        host.pass(GRACE_MS);
        return undefined;
      },
    ]);
    host.reviews.push(reviewerAnswer("no", ["The level is built."], "claude-code", [left], ["The level"]));
    const report = await host.start();
    assert.equal(report.victory, false);
    assert.deepEqual(report.stillToFix, { done: ["The level"], notDone: [left], why: StopWhy.Time, hours: 0.5 });
  });

  it("a claim a reviewer gave no answer to is not reported as one that never came", TEST_TIMEOUT, async () => {
    const host = await godotHost(HALF_HOUR, [
      ({ host }) => {
        host.pass(31 * MINUTE_MS);
        return undefined;
      },
      async ({ host, tool }) => {
        await tool("finish", {
          summary: "The level is built and the door opens.",
          proof: "project.godot",
          review: "yes",
        });
        host.pass(GRACE_MS);
        return undefined;
      },
    ]);
    host.reviews.push({ ok: false, errorText: "the reviewer's time ran out" });
    const report = await host.start();
    assert.equal(host.reviewed().length, 1, "the claim reached a reviewer");
    assert.equal(report.victory, false);
    assert.ok(
      !((report.notDone as string[] | undefined) ?? []).includes(TIME_CAP_WORDS.notChecked),
      String(report.notDone),
    );
  });
});

describe("the web director under its cap", () => {
  it("a close past the cap says no reviewer read a claim only when none reached one", () => {
    const softDeadline = T0 + HOUR_MS;
    const closing = (tally: Record<string, unknown> | null, more: Record<string, unknown> = {}) =>
      ranOutUnchecked(
        { ctx: { cancelled: false }, softDeadline, state: { limit: null, finishTally: tally as never } },
        { at: softDeadline + GRACE_MS, held: false, wrapCause: WrapCause.Deadline, ...more },
      );
    const noClaim = { round: 0, rejections: 0, checking: false, reasons: [] };
    assert.equal(closing(null), true, "no claim, no tally");
    assert.equal(closing(noClaim), true, "no claim");
    assert.equal(closing({ ...noClaim, round: 1, asked: true }), false, "a claim a reviewer got and never answered");
    assert.equal(closing({ ...noClaim, checking: true }), false, "a claim still under review");
    assert.equal(closing(noClaim, { at: softDeadline - 10 * MINUTE_MS }), false, "before the time ran out");
    for (const wrapCause of [WrapCause.Idle, WrapCause.Finish, WrapCause.Failed])
      assert.equal(closing(noClaim, { wrapCause }), false, `a wrap-up for ${wrapCause}`);
    assert.equal(closing(noClaim, { held: true }), false, "a held turn");
  });

  it("a web Loop's early claim is checked, and a yes ends it", RIG_TIMEOUT, async () => {
    const answers: string[] = [];
    const { turns, reviews, events, runId } = await webLoop(async (call, turn) => {
      if (turn > 1) return turnResult("Nothing more");
      answers.push(
        text(
          await call("finish", { summary: "The dusk scene is playable", land: "yes", victory: "yes", review: "yes" }),
        ),
      );
      return turnResult("First playable");
    });
    assert.doesNotMatch(String(answers[0]), /finish refused/);
    assert.equal(reviews(), 1, "a reviewer checked the early claim");
    assert.equal(turns(), 1, "the yes ended the Loop");
    // Closed by the claim's yes: the lead's finish, not its time.
    const finished = customEvents(events, "run_finished").find((event) => event.runId === runId);
    assert.equal(finished?.stoppedBecause, "the director finished the run", JSON.stringify(finished?.stoppedBecause));
  });

  it("a finish that claims nothing before the cap is still refused", RIG_TIMEOUT, async () => {
    const answers: string[] = [];
    await webLoop(async (call, turn, finishAsked) => {
      if (turn === 1) {
        answers.push(text(await call("finish", { summary: "The starting point is playable", land: "yes" })));
        return turnResult("First playable");
      }
      await finishAsked();
      answers.push(text(await call("finish", { summary: "Stopped early at the user's request", land: "no" })));
      return turnResult("Finished as requested");
    });
    assert.match(String(answers[0]), /^finish refused: \d+ working minutes remain in this timed build/);
    assert.match(String(answers[1]), /run is closed/);
  });
});

/** A tool's answer as text. */
const text = (result: LiveToolResult): string => (typeof result === "string" ? result : result.text);

/** A lead turn's answer, as the engine reports one. */
const turnResult = (summary: string): DelegateResult => ({
  ok: true,
  engine: "codex",
  turns: 1,
  usage: {},
  sessionId: "timed-session",
  summary,
});

/**
 * A timed web Loop of an hour on the rig, its lead's turns scripted (`script` gets the turn's tool
 * call, its number and the person's Finish), its reviewer saying yes. Resolves once the run is over.
 */
async function webLoop(
  script: (
    call: (name: string, args: Record<string, unknown>) => Promise<LiveToolResult>,
    turn: number,
    finishAsked: () => Promise<void>,
  ) => Promise<DelegateResult>,
) {
  const rig = await startRig(
    { replies: [] },
    { previewPoolMax: 3, createHeadlessPreview: async () => makeFakePreview() },
  );
  rigs.push(rig);
  const project = await rig.core.games.scaffold("timed-cap", { title: "Timed cap" });
  const runId = rig.core.newRunId();
  let leadTurns = 0;
  let reviewers = 0;
  const finishAsked = async () => {
    await rig.core.append(
      [{ type: "custom", event_type: "run_control", payload: { runId, action: "finish" } }],
      await rig.core.threadForGame(project.name),
    );
  };
  rig.core.engines.register({
    id: "codex",
    label: "codex",
    kind: "delegated",
    status: async () => ({ code: "ready", detail: "" }),
    models: async () => [],
    delegate: async (request: DelegateRequest) => {
      if (seatedReviewer(request)) {
        reviewers += 1;
        return reviewerAnswer("yes") as never;
      }
      if (!request.director) return turnResult("worker");
      leadTurns += 1;
      return script((name, args) => request.onLiveTool!(name, args), leadTurns, finishAsked);
    },
  } as never);
  await rig.core.dispatchRun({
    runId,
    goal: "A dusk scene",
    project: project.name,
    mode: "autopilot",
    engine: "codex",
    reference: { name: "Dusk", kind: "direction", shots: [] },
    budgets: { wallClockMs: HOUR_MS },
  });
  const events = await waitForLog(
    rig.core,
    (log) => customEvents(log, "run_finished").some((event) => event.runId === runId),
    120_000,
    "timed web Loop",
  );
  return { turns: () => leadTurns, reviews: () => reviewers, events, runId };
}
