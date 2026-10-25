/**
 * A Loop's hours are a soft cap: an early yes ends it, the lead hears 15 minutes before and at the
 * cap, and Genex closes it after a short grace. One rule for the open Loop and the web director.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { directorBrief } from "../../src/harness-seed/loop/director/briefs.ts";
import { MESSAGE as OPEN_END } from "../../src/harness-seed/loop/director/open/finish.ts";
import { closeLeftOpen } from "../../src/harness-seed/loop/director.ts";
import { StopWhy } from "../../src/harness-seed/loop/finish-contract.ts";
import { stopRuleWords } from "../../src/harness-seed/loop/finish-check-prompts.ts";
import { keepRunClock } from "../../src/harness-seed/loop/director/cap-lines.ts";
import { holdFinish, releaseFinish } from "../../src/harness-seed/loop/director/close-latch.ts";
import { DIRECTOR_TOOLS, DirectorTool } from "../../src/harness-seed/loop/director/tool-specs.ts";
import { turnEndsOf } from "../../src/harness-seed/loop/director/turn-ends.ts";
import { runWakeLoop } from "../../src/harness-seed/loop/director/wake.ts";
import { buildCard } from "../../src/harness-seed/loop/director/wake-prompts.ts";
import { WRAP_UP_MARGIN_MS, WrapCause } from "../../src/harness-seed/loop/director/wake-schedule.ts";
import { HostMethod } from "../../src/harness-seed/loop/host-methods.ts";
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
import { CLOCK, fakeClock, fakeHost, fakeLoopRun, lead, T0 } from "../helpers/director-run.ts";
import { gameRepo, type LoopHost, type LoopTurn, loopHost } from "../helpers/loop-host.ts";
import { copyProject, Project } from "../helpers/project-fixtures.ts";
import { reviewerAnswer, seatedReviewer } from "../helpers/reviewer.ts";
import { customEvents, makeFakePreview, type Rig, startRig, waitForLog } from "../helpers/studio-rig.ts";
import { tmpDir } from "../helpers/tmp.ts";

const TEST_TIMEOUT = { timeout: 60_000 };
/** A run's start well after the wall clock's now: only the run's own clock can say its time ran out. */
const LATER = Date.now() + 30 * 24 * HOUR_MS;
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
  await tool("finish", { summary: "The level is built and the door opens.", proof: "project.godot" });
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

  it("the web lead hears when no's stop its build, by its kind, and that pictures outrank files", () => {
    const briefOf = (budgets: Record<string, unknown>) =>
      directorBrief({
        run: { runId: "run_o", project: "level", goal: "a level", engine: "codex", budgets },
        softDeadline: T0 + HOUR_MS,
        finalDeadline: T0 + HOUR_MS + GRACE_MS,
        integrationWorktree: "/runs/run_o/integration",
        baseCommit: "abcdef1234567890",
      } as never);
    const timed = briefOf({ wallClockMs: HOUR_MS, completionPolicy: "duration" });
    assert.ok(
      timed.includes(stopRuleWords(false, "new commits")),
      "a timed build goes on past its no's with time left",
    );
    assert.match(timed, /pictures outrank files/);
    const finish = DIRECTOR_TOOLS.find((tool) => tool.name === DirectorTool.Finish);
    assert.ok(JSON.stringify(finish).includes(stopRuleWords(null)), "finish's own description says it for every build");
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
        await tool("finish", { summary: "The level is built and the door opens.", proof: "project.godot" });
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
        await tool("finish", { summary: "The level is built and the door opens.", proof: "project.godot" });
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
  it("a web lead hears the heads-up and time's up mid-turn", TEST_TIMEOUT, async () => {
    const clock = capClock({ saved: null, now: T0, totalMs: HOUR_MS });
    const steers: Array<Record<string, any>> = [];
    const loopRun = fakeLoopRun(
      fakeHost(),
      { ...clock, clock },
      {
        [HostMethod.EngineSteer]: (params: Record<string, any>) => {
          steers.push(params);
          return { how: "native", accepted: params.messages.map((message: { id: string }) => message.id) };
        },
      },
    );
    loopRun.state.softDeadline = clock.softDeadline;
    loopRun.state.finalDeadline = clock.finalDeadline;
    const wall = fakeClock(T0);
    const reached = async (count: number) => {
      for (let tries = 0; tries < 100 && steers.length < count; tries += 1) await delay(50);
      return steers.length >= count;
    };
    const { talk, turns } = lead(async (turn) => {
      if (turn > 1) {
        loopRun.state.finished = true;
        return { ok: true, sessionId: "lead-1" };
      }
      wall.at = Number(clock.headsUpAt) + SECOND_MS;
      assert.ok(await reached(1), "the heads-up reached the turn");
      wall.at = clock.softDeadline + SECOND_MS;
      assert.ok(await reached(2), "the time's up reached the turn");
      return { ok: true, sessionId: "lead-1", steered: steers.map((steer) => steer.messages[0].id) };
    });
    await runWakeLoop(loopRun, talk, () => "You are the DIRECTOR of run run_j", wall);
    assert.deepEqual(
      steers.map((steer) => [steer.messages[0].text, steer.interrupt]),
      [
        [TIME_CAP_WORDS.headsUp(15), false],
        [TIME_CAP_WORDS.timesUp, true],
      ],
    );
    assert.equal(
      turns[0]?.timeoutMs,
      clock.finalDeadline - WRAP_UP_MARGIN_MS - T0,
      "the turn may go on into the grace",
    );
    assert.equal(turns.length, 2, "the wrap-up is one more turn");
    assert.doesNotMatch(String(turns[1]?.prompt), /Time's up/, "heard mid-turn: not said again");
  });

  it("a timed web Loop's lead is told a claim may come as soon as the goal is reached", () => {
    const now = Date.now();
    const deadlines = { softDeadline: now + HOUR_MS, finalDeadline: now + HOUR_MS + GRACE_MS };
    const run = {
      runId: "run_t",
      project: "plaza",
      goal: "a dusk plaza",
      engine: "codex",
      reference: { name: "Dusk", kind: "direction", shots: [] },
      budgets: { wallClockMs: HOUR_MS, completionPolicy: "duration" },
    };
    const brief = directorBrief({
      run,
      ...deadlines,
      integrationWorktree: "/runs/run_t/integration",
      baseCommit: "abcdef1234567890",
    } as never);
    const card = (finishing: boolean) =>
      buildCard({
        ...deadlines,
        card: { runId: "run_t", project: "plaza", goal: "a dusk plaza", direction: true, plan: null, finishing },
      } as never);
    for (const [label, words] of [
      ["the brief", brief],
      ["the build card", card(false)],
      ["the build card in its finish stage", card(true)],
    ] as const) {
      assert.match(words, /victory=yes (as soon as|once) the goal is reached/, label);
      assert.match(words, /a reviewer's yes ends the build/, label);
      assert.match(words, /a finish that claims nothing waits for the wrap-up, unless the user asks/i, label);
      assert.doesNotMatch(words, /finish in (the )?wrap-up/, label);
    }
  });

  it("from the cap no web worker starts", TEST_TIMEOUT, async () => {
    const clock = capClock({ saved: null, now: LATER, totalMs: HOUR_MS });
    const loopRun = fakeLoopRun(fakeHost(), { ...clock, clock });
    keepRunClock(loopRun, () => clock.softDeadline + SECOND_MS);
    const answer = await loopRun.handler(DirectorTool.WorkerStart, {
      title: "Bindings",
      task: "Rework the input bindings",
    });
    assert.equal(answer, TIME_CAP_WORDS.noNewWorkers);
    assert.equal(loopRun.state.workers.size, 0, "no worker started");
  });

  it(
    "a web lead whose session took no time's-up mid-turn hears it at the top of its next message",
    TEST_TIMEOUT,
    async () => {
      const clock = capClock({ saved: null, now: T0, totalMs: HOUR_MS });
      const steers: Array<Record<string, any>> = [];
      const loopRun = capRun(clock, (params) => {
        steers.push(params);
        return { how: "none", accepted: [] };
      });
      const wall = fakeClock(T0);
      const { talk, turns } = lead(async (turn) => {
        if (turn > 1) {
          loopRun.state.finished = true;
          return { ok: true, sessionId: "lead-1" };
        }
        wall.at = clock.softDeadline + SECOND_MS;
        assert.ok(await reachedSteers(steers, 1), "the time's up was offered to the turn");
        return { ok: true, sessionId: "lead-1" };
      });
      await runWakeLoop(loopRun, talk, () => "You are the DIRECTOR of run run_j", wall);
      assert.match(String(turns[1]?.prompt), /^Time's up: put the build together\./, "the next message opens with it");
    },
  );

  it(
    "a run whose clock a kept older setup made hears none of the cap's lines and keeps its deadline",
    TEST_TIMEOUT,
    async () => {
      const steers: Array<Record<string, any>> = [];
      const loopRun = fakeLoopRun(
        fakeHost(),
        {},
        {
          [HostMethod.EngineSteer]: (params: Record<string, any>) => {
            steers.push(params);
            return { how: "native", accepted: params.messages.map((message: { id: string }) => message.id) };
          },
        },
      );
      const wall = fakeClock(T0);
      const { talk, turns } = lead(async () => {
        wall.at = CLOCK.finalDeadline;
        await delay(1_500);
        loopRun.state.finished = true;
        return { ok: true, sessionId: "lead-1" };
      });
      await runWakeLoop(loopRun, talk, () => "You are the DIRECTOR of run run_j", wall);
      assert.deepEqual(steers, [], "no line of the cap");
      assert.equal(turns[0]?.timeoutMs, CLOCK.softDeadline - T0, "the turn ends at the working deadline, as before");
    },
  );

  it("a web turn that may run to the end of the grace is the run's last for a claim", TEST_TIMEOUT, async () => {
    const clock = capClock({ saved: null, now: T0, totalMs: HOUR_MS });
    const loopRun = capRun(clock, () => ({ how: "native", accepted: [] }));
    const noted: Array<ReturnType<typeof turnEndsOf>> = [];
    const { talk } = lead(async () => {
      noted.push(turnEndsOf(loopRun.state));
      loopRun.state.finished = true;
      return { ok: true, sessionId: "lead-1" };
    });
    await runWakeLoop(loopRun, talk, () => "You are the DIRECTOR of run run_j", fakeClock(T0));
    assert.equal(noted[0]?.endsBy, clock.finalDeadline - WRAP_UP_MARGIN_MS);
    assert.equal(noted[0]?.last, true, "no turn follows one that ends with the run");
  });

  it("a wrap-up that began before the cap hears no line of it and is never cut for it", TEST_TIMEOUT, async () => {
    const clock = capClock({ saved: null, now: T0, totalMs: HOUR_MS });
    const steers: Array<Record<string, any>> = [];
    let finishing = false;
    const loopRun = capRun(
      clock,
      (params) => {
        steers.push(params);
        return { how: "interrupt", accepted: params.messages.map((message: { id: string }) => message.id) };
      },
      { finishing: async () => finishing },
    );
    const wall = fakeClock(T0);
    const { talk, turns } = lead(async (turn) => {
      if (turn === 1) {
        finishing = true;
        return { ok: true, sessionId: "lead-1" };
      }
      if (turn === 2) {
        wall.at = clock.softDeadline + SECOND_MS;
        await delay(1_500);
      }
      loopRun.state.finished = true;
      return { ok: true, sessionId: "lead-1" };
    });
    await runWakeLoop(loopRun, talk, () => "You are the DIRECTOR of run run_j", wall);
    assert.ok(loopRun.softDeadline < clock.softDeadline, "the person's finish began the wrap-up early");
    assert.deepEqual(steers, [], "nothing said into, or cut from, the wrap-up turn");
    assert.doesNotMatch(String(turns[1]?.prompt), /Time's up|About \d+ minutes left/);
  });

  it(
    "the time's-up never cuts a turn inside a tool call or a claim's check, and cuts it once that is over",
    TEST_TIMEOUT,
    async () => {
      for (const holding of ["a tool call", "a claim's check"] as const) {
        const clock = capClock({ saved: null, now: T0, totalMs: HOUR_MS });
        const steers: Array<Record<string, any>> = [];
        const loopRun = capRun(clock, (params) => {
          steers.push(params);
          return { how: "none", accepted: [] };
        });
        const wall = fakeClock(T0);
        const hold = () => {
          if (holding === "a tool call") loopRun.toolsInFlight = 1;
          else holdFinish(loopRun.state);
        };
        const release = () => {
          if (holding === "a tool call") loopRun.toolsInFlight = 0;
          else releaseFinish(loopRun.state);
        };
        const { talk } = lead(async (turn) => {
          if (turn > 1) {
            loopRun.state.finished = true;
            return { ok: true, sessionId: "lead-1" };
          }
          hold();
          wall.at = clock.softDeadline + SECOND_MS;
          assert.ok(await reachedSteers(steers, 1), "the time's up was offered");
          release();
          assert.ok(await reachedSteers(steers, steers.length + 1), "and offered again once it was over");
          return { ok: true, sessionId: "lead-1" };
        });
        await runWakeLoop(loopRun, talk, () => "You are the DIRECTOR of run run_j", wall);
        assert.equal(steers[0]?.interrupt, false, `${holding}: never cut inside it`);
        assert.equal(steers.at(-1)?.interrupt, true, `${holding}: cut once it was over`);
      }
    },
  );

  it("a time's-up a turn took but never read opens its wrap-up message", TEST_TIMEOUT, async () => {
    for (const how of ["interrupt", "native"] as const) {
      const clock = capClock({ saved: null, now: T0, totalMs: HOUR_MS });
      const steers: Array<Record<string, any>> = [];
      const loopRun = capRun(clock, (params) => {
        steers.push(params);
        return { how, accepted: params.messages.map((message: { id: string }) => message.id) };
      });
      const wall = fakeClock(T0);
      const { talk, turns } = lead(async (turn) => {
        if (turn > 1) {
          loopRun.state.finished = true;
          return { ok: true, sessionId: "lead-1" };
        }
        wall.at = clock.softDeadline + SECOND_MS;
        assert.ok(await reachedSteers(steers, 1), `${how}: the time's up was taken`);
        // Cut short (interrupt), or taken natively and never read: absent from `steered`.
        return { ok: true, sessionId: "lead-1", steered: [] };
      });
      await runWakeLoop(loopRun, talk, () => "You are the DIRECTOR of run run_j", wall);
      assert.equal(steers.length, 1, `${how}: taken once, never offered again`);
      assert.match(
        String(turns[1]?.prompt),
        /^Time's up: put the build together\./,
        `${how}: the wrap-up opens with it`,
      );
    }
  });

  it(
    "a web lead that idles past its grace closes as not checked; one whose claim got no answer says so",
    TEST_TIMEOUT,
    async () => {
      const closeOf = async (tally: Record<string, unknown> | null) => {
        const clock = capClock({ saved: null, now: LATER, totalMs: HOUR_MS });
        const closes: Array<Record<string, any>> = [];
        const loopRun = fakeLoopRun(
          fakeHost(),
          { ...clock, clock, closeTheLoopRun: async (options: Record<string, any>) => closes.push(options) },
          { [HostMethod.EngineSteer]: () => ({ how: "none", accepted: [] }) },
        );
        loopRun.state.softDeadline = clock.softDeadline;
        loopRun.state.finalDeadline = clock.finalDeadline;
        loopRun.state.finishTally = tally;
        const wall = fakeClock(LATER);
        const { talk } = lead(async () => {
          wall.at = clock.finalDeadline;
          return { ok: true, sessionId: "lead-1" };
        });
        const outcome = await runWakeLoop(loopRun, talk, () => "You are the DIRECTOR of run run_j", wall);
        // The wall clock is hours away from the run's: only the run's own clock can say the time ran out.
        await closeLeftOpen(loopRun, outcome.failed ?? outcome.result ?? {}, outcome.wrapCause, wall.now());
        return { loopRun, close: closes[0] ?? {} };
      };
      const idle = await closeOf(null);
      assert.deepEqual(idle.loopRun.report.notDone, [TIME_CAP_WORDS.notChecked]);
      assert.match(
        String(idle.close.summary),
        /time ran out before a final look/,
        "and the summary the person reads says it",
      );

      const unanswered = await closeOf({ round: 1, rejections: 0, checking: false, reasons: [], asked: true });
      assert.ok(!(unanswered.loopRun.report.notDone ?? []).includes(TIME_CAP_WORDS.notChecked));
      const because = String(unanswered.close.because?.({ ok: false, reason: "x" }));
      assert.match(because, /ran out of time before a reviewer said yes to its claim/);
      const afterNo = await closeOf({ round: 1, rejections: 1, checking: false, reasons: [], notDone: ["No door"] });
      assert.equal(afterNo.close.ended, StopWhy.Time, "its result card says its time ran out");
    },
  );

  it(
    "a Resume before the cap hears the heads-up and the time's-up of the time it has left, once each",
    TEST_TIMEOUT,
    async () => {
      const clock = capClock({ saved: { workedMs: 30 * MINUTE_MS }, now: T0, totalMs: HOUR_MS });
      assert.equal(clock.softDeadline, T0 + 30 * MINUTE_MS, "the cap is the time it had left");
      const steers: Array<Record<string, any>> = [];
      const loopRun = capRun(clock, (params) => {
        steers.push(params);
        return { how: "native", accepted: params.messages.map((message: { id: string }) => message.id) };
      });
      loopRun.resume = true;
      const wall = fakeClock(T0);
      const { talk } = lead(async (turn) => {
        if (turn > 1) {
          loopRun.state.finished = true;
          return { ok: true, sessionId: "lead-1" };
        }
        wall.at = Number(clock.headsUpAt) + SECOND_MS;
        assert.ok(await reachedSteers(steers, 1));
        wall.at = clock.softDeadline + SECOND_MS;
        assert.ok(await reachedSteers(steers, 2));
        return { ok: true, sessionId: "lead-1", steered: steers.map((steer) => steer.messages[0].id) };
      });
      await runWakeLoop(loopRun, talk, () => "You are the DIRECTOR of run run_j", wall);
      assert.deepEqual(
        steers.map((steer) => steer.messages[0].text),
        [TIME_CAP_WORDS.headsUp(15), TIME_CAP_WORDS.timesUp],
      );
    },
  );

  it(
    "a Resume past the cap opens with the time's-up, starts no worker and closes as not checked",
    TEST_TIMEOUT,
    async () => {
      const now = LATER + 5 * HOUR_MS;
      const clock = capClock({ saved: { workedMs: 2 * HOUR_MS }, now, totalMs: HOUR_MS });
      const closes: Array<Record<string, any>> = [];
      const loopRun = fakeLoopRun(
        fakeHost(),
        {
          ...clock,
          clock,
          resume: true,
          closeTheLoopRun: async (options: Record<string, any>) => closes.push(options),
        },
        { [HostMethod.EngineSteer]: () => ({ how: "none", accepted: [] }) },
      );
      loopRun.state.softDeadline = clock.softDeadline;
      loopRun.state.finalDeadline = clock.finalDeadline;
      const wall = fakeClock(now);
      keepRunClock(loopRun, () => wall.at);
      const answers: unknown[] = [];
      const { talk, turns } = lead(async () => {
        answers.push(await loopRun.handler(DirectorTool.WorkerStart, { title: "Bindings", task: "Rework them" }));
        wall.at = clock.finalDeadline;
        return { ok: true, sessionId: "lead-1" };
      });
      const outcome = await runWakeLoop(loopRun, talk, () => "You are the DIRECTOR of run run_j", wall);
      assert.match(
        String(turns[0]?.prompt),
        /Time's up: put the build together\./,
        "the resumed lead hears it at once",
      );
      assert.equal(answers[0], TIME_CAP_WORDS.noNewWorkers);
      await closeLeftOpen(loopRun, outcome.failed ?? outcome.result ?? {}, outcome.wrapCause, wall.now());
      assert.deepEqual(loopRun.report.notDone, [TIME_CAP_WORDS.notChecked]);
    },
  );

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
      answers.push(text(await call("finish", { summary: "The dusk scene is playable", land: "yes", victory: "yes" })));
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

/** A web run on a cap clock whose lead's steers `steer` answers; `inbox` replaces parts of its inbox. */
function capRun(
  clock: ReturnType<typeof capClock>,
  steer: (params: Record<string, any>) => unknown,
  inbox: Record<string, unknown> = {},
) {
  const loopRun = fakeLoopRun(
    fakeHost(),
    {
      ...clock,
      clock,
      inbox: {
        steering: async () => [],
        finishing: async () => false,
        addressed: async () => [],
        backlog: async () => [],
        ...inbox,
      },
    },
    { [HostMethod.EngineSteer]: steer },
  );
  loopRun.state.softDeadline = clock.softDeadline;
  loopRun.state.finalDeadline = clock.finalDeadline;
  return loopRun;
}

/** Wait, in real time, until `count` steers were asked for. */
async function reachedSteers(steers: unknown[], count: number): Promise<boolean> {
  for (let tries = 0; tries < 100 && steers.length < count; tries += 1) await delay(50);
  return steers.length >= count;
}

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
