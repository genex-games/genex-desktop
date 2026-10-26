/**
 * Which Loop a run gets, through the run's start as the chat and Resume reach it: a project that
 * isn't a web game runs the one Loop on an engine that keeps a session and is told, before anything
 * is promised, that it needs one otherwise; classic and the gauntlet stay a web game's; the Unreal
 * runner from before runs only behind its internal switch; a run that runner paused goes on in the
 * one Loop; a finished one Loop starts the next; and the chat describes the one Loop truthfully.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { setImmediate } from "node:timers/promises";
import * as builtinHookParts from "../../src/harness-seed/loop/builtin-hooks.ts";
import { afterLeadLoopRun, afterLoopRunGrant } from "../../src/harness-seed/loop/after-loop-run.ts";
import { afterLoopRunNote } from "../../src/harness-seed/loop/after-loop-run-prompts.ts";
import { handleUserMessage, launchFromIntake, startsNextOpenLoop } from "../../src/harness-seed/loop/chat-dispatch.ts";
import * as directorParts from "../../src/harness-seed/loop/director.ts";
import * as openContractParts from "../../src/harness-seed/loop/director/open/contract.ts";
import { servesOpenLoop } from "../../src/harness-seed/loop/director/open/contract.ts";
import * as setupParts from "../../src/harness-seed/loop/director/setup.ts";
import * as wakeParts from "../../src/harness-seed/loop/director/wake.ts";
import * as wakeScheduleParts from "../../src/harness-seed/loop/director/wake-schedule.ts";
import { MAX_RUN_HOURS } from "../../src/harness-seed/loop/config.ts";
import { LoopProfile } from "../../src/harness-seed/loop/folder-facts.ts";
import { GameEngine } from "../../src/harness-seed/loop/game-engine.ts";
import { launchRules } from "../../src/harness-seed/loop/launch-prompts.ts";
import * as seedLoopSwitch from "../../src/harness-seed/loop/loop-switch.ts";
import { unrealRunnerOn } from "../../src/harness-seed/loop/loop-switch.ts";
import { OPEN_LAUNCH_WORDS, OPEN_LOOP_REFUSAL } from "../../src/harness-seed/loop/open-loop-prompts.ts";
import { tools as gameTools } from "../../src/harness-seed/tools/game-tools.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";
import { stopRunsOf } from "../../src/harness-seed/loop/live-chat.ts";
import { finishedLoopRun, reopenAfterReply } from "../../src/harness-seed/loop/reopen-run.ts";
import { runControlsFor } from "../../src/shared/coordinator.ts";
import * as runDispatchParts from "../../src/harness-seed/loop/run-dispatch.ts";
import { chooseRunner, handleRunStart } from "../../src/harness-seed/loop/run-dispatch.ts";
import * as studioStateParts from "../../src/harness-seed/loop/studio-state.ts";
import { RunnerKind } from "../../src/harness-seed/loop/studio-state.ts";
import { harnessRunEnv, UNREAL_RUNNER_ENV } from "../../src/shared/protocol.ts";
import { CHAT_SESSION, gameRepo, type LoopHost, type LoopTurn, loopHost } from "../helpers/loop-host.ts";
import { copyProject, Project } from "../helpers/project-fixtures.ts";
import { reviewerAnswer } from "../helpers/reviewer.ts";
import { tmpDir } from "../helpers/tmp.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** No Loop here may hang the suite: each is over in a few seconds when it works. */
const TEST_TIMEOUT = { timeout: 60_000 };

const GODOT = [{ id: "godot-project", path: "." }];
const UNREAL = [{ id: "unreal-project", path: "." }];

/** An engine that keeps no session, as `engine.describe` lists it. */
const DIRECT = { id: "ollama", label: "Ollama", kind: "direct" };

/** An engine Genex drives itself that keeps sessions (Bonsai's shape), as `engine.describe` lists it. */
const DIRECT_WITH_SESSIONS = { id: "bonsai", label: "Bonsai", kind: "direct", supportsSessions: true };

/** What Genex finds in a Godot project's folder that makes its Loop work in place, as the refusals name it. */
const GODOT_FOUND = "godot-project at the folder's root";
/** The words a refused Loop on a direct engine closes with (flipped: they name what Genex found). */
const NEEDS_SESSION =
  "A Loop on this project (Genex finds godot-project at the folder's root) needs an engine that works as an agent in the project's folder (Claude Code, Codex, OpenCode or Grok Build); Ollama doesn't, so nothing was built.";
const WEB_ONLY = "This kind of run works on web games only; a Loop on this project is led by the chat's own session.";
const CANNOT_RESUME =
  "This Loop was paused by an earlier version and can't be picked up. Start a new Loop: it goes on from the project as it is now, with every save point kept.";
const OTHER_LOOP =
  "This Loop was paused as another kind of Loop than this project reads as now, so it can't go on now. It stays paused: once the project reads as it did, Resume picks it up.";

const switchBefore = process.env[UNREAL_RUNNER_ENV];
after(() => {
  if (switchBefore === undefined) delete process.env[UNREAL_RUNNER_ENV];
  else process.env[UNREAL_RUNNER_ENV] = switchBefore;
});

let runs = 0;

/** A Loop's host on a copy of one project fixture made a git repository, under a run id of its own. */
async function hostOn(
  project: Project,
  options: Omit<Parameters<typeof loopHost>[0], "dir"> & { turns?: LoopTurn[] },
): Promise<LoopHost> {
  const dir = await gameRepo(await copyProject(project, await tmpDir("one-loop-dispatch-")));
  runs += 1;
  return loopHost({ ...options, dir, run: { runId: `run-dispatch-${runs}`, ...options.run } });
}

/** A turn that claims the goal is reached, naming a file of the folder as proof. */
const finishes: LoopTurn = async ({ tool }) => {
  await tool("finish", { summary: "The level is built and the door opens.", proof: "project.godot" });
  return undefined;
};

/** The lead delegations that worked in place, as the one Loop's do. */
const inPlaceLeads = (host: LoopHost) =>
  host.leadCalls().filter((call) => (call.director as { inPlace?: unknown } | undefined)?.inPlace === true);

/** The Unreal runner's paused journal: two save points, 40 of 180 minutes worked, one reviewer's no. */
function olderJournal(host: LoopHost): Record<string, unknown> {
  const point = (label: string, snapshotId: string, auto: boolean) => ({
    label,
    snapshotId,
    summary: `the ${label.toLowerCase()} room`,
    auto,
    at: 1,
    thumbnails: [],
    milestoneId: "lead",
    round: 1,
  });
  return {
    kind: "unreal-lead",
    phase: "paused",
    run: { ...host.run, budgets: { wallClockMs: 3 * HOUR, completionPolicy: "duration" } },
    seat: { folder: host.dir },
    sessionId: "unreal-lead-session",
    workedMs: 40 * MINUTE,
    savePoints: [point("One", "snap-old-1", false), point("Two", "snap-old-2", true)],
    finishTally: { round: 1, rejections: 1, checking: false, reasons: ["the door does not open"] },
    digest: { heardOwner: [], toldAgents: [], toldCritiques: 0, carried: ["Unreal reopened."], jobs: [], lastAt: null },
    credits: { spent: 120, cap: 600 },
    savedAt: new Date(0).toISOString(),
  };
}

describe("which Loop a run gets", () => {
  it("a Loop on a project that isn't a web game runs the one Loop", TEST_TIMEOUT, async () => {
    const host = await hostOn(Project.GodotGame, { facts: GODOT, turns: [finishes] });
    await host.dispatch();
    const [first] = inPlaceLeads(host);
    assert.ok(first, "the lead worked in place");
    assert.equal(first.resume, CHAT_SESSION, "the chat's own session leads");
    for (const method of ["game.scaffold", "game.upgradeContract", "preview.load"])
      assert.ok(!host.trail().includes(method), `no ${method}`);
    assert.equal(host.appended("run_finished").length, 1);
  });

  it("on an engine without sessions it says it needs one, before any promise in the chat", TEST_TIMEOUT, async () => {
    const host = await hostOn(Project.GodotGame, { facts: GODOT, run: { engine: "ollama" } });
    host.rec.handle("engine.describe", () => [DIRECT]);
    const studio = { host: host.rec.ctx, moodBoards: new Map(), activeRuns: new Map(), startingRuns: new Map() };
    await assert.rejects(
      launchFromIntake(studio as never, host.rec.ctx as never, { threadId: "t1", project: host.game.name } as never, {
        goal: "A level the player walks through.",
        engine: "ollama",
        mode: "autopilot",
      }),
      (err: Error) => err.message === NEEDS_SESSION,
    );
    assert.ok(!JSON.stringify(host.rec.paramsOf("events.append")).includes("Building until about"), "nothing promised");
    assert.equal(host.rec.paramsOf("engine.delegate").length, 0);

    await host.dispatch({ resume: true });
    const [closed] = host.appended("run_finished");
    assert.equal(closed?.stoppedBecause, NEEDS_SESSION);
    assert.equal(closed?.landed, false);
    assert.equal(host.rec.paramsOf("engine.delegate").length, 0, "no session ran");
  });

  it(
    "on an engine Genex drives itself that keeps sessions it is refused too, at launch and at dispatch",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, { facts: GODOT, run: { engine: "bonsai" } });
      host.rec.handle("engine.describe", () => [DIRECT_WITH_SESSIONS]);
      const words = OPEN_LOOP_REFUSAL.needsSession("Bonsai", GODOT_FOUND);
      const studio = { host: host.rec.ctx, moodBoards: new Map(), activeRuns: new Map(), startingRuns: new Map() };
      await assert.rejects(
        launchFromIntake(studio as never, host.rec.ctx as never, { threadId: "t1", project: host.game.name } as never, {
          goal: "A level the player walks through.",
          engine: "bonsai",
          mode: "autopilot",
        }),
        (err: Error) => err.message === words,
      );
      await host.dispatch();
      assert.equal(host.appended("run_finished")[0]?.stoppedBecause, words);
      assert.equal(host.rec.paramsOf("engine.delegate").length, 0, "no session ran");
    },
  );

  it("classic is a web game's internal only", TEST_TIMEOUT, async () => {
    const host = await hostOn(Project.GodotGame, { facts: GODOT, run: { classic: true }, turns: [finishes] });
    await host.dispatch();
    assert.equal(inPlaceLeads(host).length, 1, "the one Loop, classic or not");
    const described = [{ id: "claude-code", kind: "delegated", supportsSessions: true }] as never;
    const web = { mode: "autopilot", engine: "claude-code", classic: true } as never;
    assert.equal(chooseRunner(web, described, LoopProfile.Web), RunnerKind.Autopilot);
  });

  it("the gauntlet works on web games only, and says so on any other project", TEST_TIMEOUT, async () => {
    const host = await hostOn(Project.GodotGame, { facts: GODOT, run: { mode: undefined } });
    await host.dispatch();
    const [closed] = host.appended("run_finished");
    assert.equal(closed?.stoppedBecause, WEB_ONLY);
    assert.equal(host.rec.paramsOf("engine.delegate").length, 0);
    assert.ok(!host.trail().includes("preview.load"), "nothing was looked at");
  });

  it(
    "the Unreal runner runs only when the switch names it, and a run of the one Loop never goes to it",
    TEST_TIMEOUT,
    async () => {
      const named = { [UNREAL_RUNNER_ENV]: "lead" };
      const unreal = { facts: UNREAL };
      assert.equal(unrealRunnerOn({ env: named, game: unreal, resume: false }), true);
      assert.equal(unrealRunnerOn({ env: named, game: unreal, resume: true, journalKind: "unreal-lead" }), true);
      assert.equal(unrealRunnerOn({ env: named, game: unreal, resume: true, journalKind: undefined }), false);
      assert.equal(unrealRunnerOn({ env: named, game: { facts: GODOT }, resume: false }), false);
      assert.equal(unrealRunnerOn({ env: {}, game: unreal, resume: false }), false);
      assert.equal(unrealRunnerOn({ env: { [UNREAL_RUNNER_ENV]: "yes" }, game: unreal, resume: false }), false);

      // A paused run of the one Loop, resumed with the switch on: the one Loop goes on with it.
      const host = await hostOn(Project.UnrealGame, {
        facts: UNREAL,
        turns: [
          ({ host }) => {
            host.rec.cancel();
            return undefined;
          },
        ],
      });
      await host.start();
      host.turns.push(finishes);
      host.rec.ctx.cancelled = false;
      process.env[UNREAL_RUNNER_ENV] = "lead";
      try {
        await host.dispatch({ resume: true });
      } finally {
        delete process.env[UNREAL_RUNNER_ENV];
      }
      assert.equal(inPlaceLeads(host).length, 2, "both turns were the one Loop's");
    },
  );

  it("the switch reaches the harness by name and nothing else does", () => {
    assert.equal(seedLoopSwitch.UNREAL_RUNNER_ENV, UNREAL_RUNNER_ENV);
    assert.deepEqual(harnessRunEnv({ [UNREAL_RUNNER_ENV]: "lead", HOME: "/Users/me" }), {
      [UNREAL_RUNNER_ENV]: "lead",
    });
    assert.deepEqual(harnessRunEnv({ STUDIO_UNREAL_LEAD: "lead" }), {});
  });
});

describe("a run the Unreal runner paused", () => {
  it(
    "a run paused under the Unreal runner goes on in the one Loop: the chat's own session, its save points, the time it had left, its finish count",
    TEST_TIMEOUT,
    async () => {
      // Through the run's start: the one Loop takes it, led by the chat's own session.
      const through = await hostOn(Project.UnrealGame, { facts: UNREAL, turns: [finishes] });
      through.artifacts.set(`autopilot_${through.run.runId}`, olderJournal(through));
      await through.dispatch({ resume: true });
      const [first] = inPlaceLeads(through);
      assert.ok(first, "the one Loop led it");
      assert.equal(first.resume, CHAT_SESSION);
      assert.match(String(first.prompt), /"One"/);
      assert.match(String(first.prompt), /"Two"/);

      // On the Loop's own clock: the time it had left, a rewind to a save point it kept, its no's.
      const host = await hostOn(Project.UnrealGame, {
        facts: UNREAL,
        turns: [
          // A claim waits for the rewind its turn asked for: the next turn claims.
          async ({ tool }) => {
            await tool("rewind", { label: "One" });
            return undefined;
          },
          finishes,
          finishes,
        ],
      });
      const id = `autopilot_${host.run.runId}`;
      host.artifacts.set(id, olderJournal(host));
      // The runner's no is on the run's record, where Genex counts the no's in a row.
      const earlierNo = { runId: host.run.runId, round: 1, step: "rejected", reasons: ["the door does not open"] };
      await host.rec.ctx.call("events.append", {
        threadId: host.threadId,
        batch: [{ type: "custom", event_type: "finish_check", payload: earlierNo }],
      });
      host.reviews.push(reviewerAnswer("no", ["the door still does not open"]));
      const started = host.now();
      await host.start({ resume: true });
      const prompt = host.prompts()[0] ?? "";
      const left = Number(/about (\d+) minutes of working time/.exec(prompt)?.[1]);
      assert.ok(left > 100 && left <= 140, `the time it had left (${left} minutes)`);
      const restored = host.rec.paramsOf("snapshot.restore").map((params) => params.snapshotId);
      assert.deepEqual(restored, ["snap-old-1"], "the rewind went back to its own snapshot");
      const journal = host.artifacts.get(id) as Record<string, any>;
      assert.equal(journal.kind, undefined, "a director journal now");
      assert.deepEqual(
        journal.director.open.savePoints.slice(0, 2).map((point: { label: string }) => point.label),
        ["One", "Two"],
      );
      assert.equal(journal.director.finishTally.rejections, 0, "the yes cleared the count");
      const rejected = host
        .appended("finish_check")
        .filter((check) => check.step === "rejected")
        .at(-1);
      assert.equal(rejected?.rejections, 2, "a reviewer's no counted on from the run's one");
      // Flipped: the cap is the time it had left, and the grace follows it (time-cap.ts).
      const cap = Date.parse(journal.director.clock.softDeadline);
      assert.ok(Math.abs(cap - started - 140 * MINUTE) < MINUTE, "140 of its 180 minutes were left");
    },
  );

  it(
    "a paused run whose journal it can't read is told it can't resume and that a new Loop goes on from the project as it is",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.UnrealGame, { facts: UNREAL, turns: [finishes] });
      host.artifacts.set(`autopilot_${host.run.runId}`, { ...olderJournal(host), savePoints: "lost" });
      await host.dispatch({ resume: true });
      const [closed] = host.appended("run_finished");
      assert.equal(closed?.stoppedBecause, CANNOT_RESUME);
      assert.equal(host.leadCalls().length, 0, "no lead ran");
      assert.deepEqual(host.rec.paramsOf("hooks.fire"), [], "no moment of the project ran");
    },
  );
});

describe("kept older parts, finished Loops and the chat's words", () => {
  it("an older kept director that can't lead an open Loop refuses it with words, and a web Loop still runs", () => {
    const parts = [
      directorParts,
      setupParts,
      wakeParts,
      wakeScheduleParts,
      openContractParts,
      builtinHookParts,
      studioStateParts,
      // The chat's launch reads the run's start too.
      runDispatchParts,
    ];
    assert.equal(servesOpenLoop(parts), true, "every part this seed ships serves the one Loop");
    for (let i = 0; i < parts.length; i++) {
      const kept = parts.map((part, j) => (j === i ? { ...part, SERVES_OPEN_LOOP: undefined } : part));
      assert.equal(servesOpenLoop(kept), false, `a kept older part ${i} refuses it`);
    }
    const described = [{ id: "claude-code", kind: "delegated", supportsSessions: true }] as never;
    assert.equal(chooseRunner({ mode: "autopilot", engine: "claude-code" } as never, described), RunnerKind.Director);
  });

  it("a Loop message after a finished open Loop starts the next one; a finished open Loop is never reopened", async () => {
    const journal = { director: { lead: { chatSession: true }, open: { version: 1, savePoints: [] } } };
    const host = { call: async () => structuredClone(journal) };
    const run = { runId: "run-done", state: "finished", project: "lantern", goal: "a level" };
    assert.equal(await finishedLoopRun(host as never, "t1", run), null);
    const web = { call: async () => ({ director: { lead: { chatSession: true } } }) };
    assert.notEqual(await finishedLoopRun(web as never, "t1", run), null, "a web Loop's finished build still reopens");
  });

  it("the chat tells a Loop on a project that isn't a web game that the lead builds in place and a reviewer checks its finish", () => {
    const unlimited = { toolName: "start_autopilot", hours: null, frameCount: 2 };
    const open = launchRules("claude-code", unlimited, GameEngine.Web, LoopProfile.Open).join("\n");
    assert.doesNotMatch(open, /builder|judge/i);
    assert.doesNotMatch(open, /Unreal/);
    assert.match(open, /until a reviewer accepts the finish, 24 h at most/);
    assert.match(open, /the lead builds the whole project itself in this folder/);
    const timed = launchRules(
      "claude-code",
      { toolName: "start_autopilot", hours: 3 },
      GameEngine.Web,
      LoopProfile.Open,
    );
    assert.match(timed.join("\n"), /up to 3 h/);
    const web = launchRules("claude-code", unlimited, GameEngine.Web);
    assert.deepEqual(
      launchRules("claude-code", unlimited, GameEngine.Web, LoopProfile.Web),
      web,
      "web words unchanged",
    );
    const unreal = launchRules("claude-code", unlimited, GameEngine.Unreal, LoopProfile.Open).join("\n");
    assert.match(unreal, /Write an Unreal build's goal with the look first/);
    assert.doesNotMatch(unreal, /builder|judge/i);
    assert.equal(web.join("\n").includes("Write an Unreal build's goal"), false);
  });
});

/** The studio a dispatch or a reopen reaches, over a host's recorder, as main.ts makes it. */
function studioOf(host: LoopHost) {
  const ctx = host.rec.ctx;
  return {
    host: ctx,
    cancels: new Set<string>(),
    stoppedMessages: new Set<string>(),
    moodBoards: new Map(),
    activeRuns: new Map(),
    startingRuns: new Map(),
    orphanRuns: new Map(),
    scoped: () => ctx,
  };
}

/** The words the Unreal runner closes with on a game linked to no Unreal project: its own, no one Loop's. */
const RUNNER_NOT_LINKED = "This game isn't linked to an Unreal project, so the Unreal Loop can't build it.";

describe("the chat's launch tool", () => {
  it("names no method in its description, and answers an ∞ Loop as the project's Loop ends", async () => {
    const launch = gameTools.find((tool) => tool.name === "start_autopilot");
    assert.ok(launch);
    assert.doesNotMatch(String(launch.description), /critic|facet/i);
    const rows: Array<[string, Array<{ id: string; path: string }>, string]> = [
      ["a Godot project", GODOT, OPEN_LAUNCH_WORDS.building],
      ["a web game", [{ id: "web-game", path: "." }], "Building until what was asked is verified"],
    ];
    const outcomes: Array<[string, boolean]> = [];
    for (const [label, facts, says] of rows) {
      const host = ctxRecorder({
        threadId: "chat-1",
        extra: { project: "lantern", autopilot: { hours: null, frames: [] } },
        handlers: { "game.list": () => [{ name: "lantern", facts }] },
      });
      const answer = await launch.execute({ goal: "A level.", direction: "a lantern-lit cave" }, host.ctx as never);
      outcomes.push([label, String((answer as { content?: unknown }).content).startsWith(says)]);
    }
    assert.deepEqual(
      outcomes,
      rows.map(([label]) => [label, true]),
    );
  });
});

describe("the Unreal runner behind its switch, through the run's start", () => {
  it(
    "a fresh run on an Unreal game goes to the runner with the switch on, and a saved runner journal resumes there",
    TEST_TIMEOUT,
    async () => {
      const fresh = await hostOn(Project.UnrealGame, { facts: UNREAL, turns: [finishes] });
      const resumed = await hostOn(Project.UnrealGame, { facts: UNREAL, turns: [finishes] });
      resumed.artifacts.set(`autopilot_${resumed.run.runId}`, olderJournal(resumed));
      process.env[UNREAL_RUNNER_ENV] = "lead";
      try {
        await fresh.dispatch();
        await resumed.dispatch({ resume: true });
      } finally {
        delete process.env[UNREAL_RUNNER_ENV];
      }
      for (const host of [fresh, resumed]) {
        assert.equal(inPlaceLeads(host).length, 0, "no lead of the one Loop");
        assert.equal(host.appended("run_finished")[0]?.stoppedBecause, RUNNER_NOT_LINKED, "the runner's own close");
      }
    },
  );
});

describe("a paused Loop's journal, read at its start", () => {
  it(
    "a runner journal of any wrong shape closes the run with words, before anything of the project ran",
    TEST_TIMEOUT,
    async () => {
      const shapes: Array<[string, (journal: Record<string, any>) => void]> = [
        ["no run", (journal) => delete journal.run],
        ["worked time negative", (journal) => (journal.workedMs = -1)],
        ["worked time fractional", (journal) => (journal.workedMs = 1.5)],
        ["save points not a list", (journal) => (journal.savePoints = "lost")],
        ["a save point with no label", (journal) => delete journal.savePoints[0].label],
        ["a save point with no summary", (journal) => delete journal.savePoints[0].summary],
        ["a save point with no snapshot", (journal) => delete journal.savePoints[0].snapshotId],
        ["a save point with no autosave mark", (journal) => delete journal.savePoints[0].auto],
        ["a finish count of the wrong shape", (journal) => (journal.finishTally = { round: "one" })],
        ["carried lines not text", (journal) => (journal.digest.carried = [1])],
        ["no credits spent", (journal) => delete journal.credits],
      ];
      const outcomes: Array<Record<string, unknown>> = [];
      for (const [label, spoil] of shapes) {
        const host = await hostOn(Project.UnrealGame, { facts: UNREAL, turns: [finishes] });
        const journal = olderJournal(host) as Record<string, any>;
        spoil(journal);
        host.artifacts.set(`autopilot_${host.run.runId}`, journal);
        await host.start({ resume: true });
        const touched = ["snapshot.create", "checkpoint.take", "hooks.fire", "engine.delegate"].filter(
          (method) => host.rec.paramsOf(method).length > 0,
        );
        outcomes.push({ label, closed: host.appended("run_finished")[0]?.stoppedBecause, touched });
      }
      assert.deepEqual(
        outcomes,
        shapes.map(([label]) => ({ label, closed: CANNOT_RESUME, touched: [] })),
      );
    },
  );

  it(
    "a paused web Loop resumed while its folder reads otherwise stays paused, its journal and report untouched, both where it is refused",
    TEST_TIMEOUT,
    async () => {
      const outcomes: Array<Record<string, unknown>> = [];
      for (const how of ["in place", "at dispatch"] as const) {
        const host = await hostOn(Project.GodotGame, { facts: GODOT, turns: [finishes] });
        const journal = {
          runId: host.run.runId,
          run: host.run,
          director: { baseCommit: "abc", integrationHead: "def", workers: {}, notes: [] },
        };
        host.artifacts.set(`autopilot_${host.run.runId}`, structuredClone(journal));
        if (how === "in place") await host.start({ resume: true });
        else await host.dispatch({ resume: true });
        const [closed] = host.appended("run_finished");
        outcomes.push({
          how,
          words: closed?.stoppedBecause,
          status: closed?.executionStatus,
          paused: host.appended("autopilot_paused").length,
          journalKept: JSON.stringify(host.artifacts.get(`autopilot_${host.run.runId}`)) === JSON.stringify(journal),
          report: host.rec.paramsOf("run.artifact").some((params) => params.name === "report.json"),
          leads: host.leadCalls().length,
          cap: (host.appended("run_started")[0]?.budgets as Record<string, unknown> | undefined)?.creditCap,
        });
      }
      // A refusal keeps the run's record as it came: no credit cap of a Loop it never ran.
      const kept = { status: "paused", paused: 1, journalKept: true, report: false, leads: 0, cap: undefined };
      assert.deepEqual(outcomes, [
        { how: "in place", words: OTHER_LOOP, ...kept },
        { how: "at dispatch", words: OPEN_LOOP_REFUSAL.webElsewhere(GODOT_FOUND), ...kept },
      ]);
    },
  );

  it(
    "a paused Loop that worked in place goes on in place, whatever its folder reads as now",
    TEST_TIMEOUT,
    async () => {
      const web = await hostOn(Project.GodotGame, { facts: [{ id: "web-game", path: "." }], turns: [finishes] });
      web.artifacts.set(`autopilot_${web.run.runId}`, {
        runId: web.run.runId,
        run: web.run,
        phase: "paused",
        director: { baseCommit: "abc", integrationHead: null, open: { version: 1, savePoints: [] } },
      });
      await web.dispatch({ resume: true });
      const [lead] = web.leadCalls();
      assert.equal((lead?.director as { inPlace?: boolean } | undefined)?.inPlace, true, "led in place");
      assert.equal(web.appended("run_finished").at(-1)?.victory, true);
    },
  );

  it("a resumed run refused at its start stays paused and keeps its earlier report", TEST_TIMEOUT, async () => {
    const host = await hostOn(Project.GodotGame, { facts: GODOT, run: { engine: "ollama" } });
    host.rec.handle("engine.describe", () => [DIRECT]);
    // The paused session's close: a build on its integration branch, its workers and notes.
    const earlier = {
      runId: host.run.runId,
      project: host.run.project,
      executionStatus: "paused",
      paused: true,
      landed: false,
      integrationHead: "head-1",
      baseCommit: "base-1",
      workers: [{ id: "w1", title: "Hall" }],
      notes: ["the hall is half done"],
      // How that session stopped: the provider stopped taking the account.
      limit: { kind: "auth", at: new Date(0).toISOString() },
      stopCode: "provider",
      failure: null,
      workedUntil: new Date(0).toISOString(),
      stoppedBecause: "The model provider stopped accepting this account.",
    };
    await host.rec.ctx.call("events.append", {
      threadId: host.threadId,
      batch: [{ type: "custom", event_type: "run_finished", payload: earlier }],
    });
    await host.dispatch({ resume: true });
    const closed = host.appended("run_finished").at(-1);
    assert.equal(closed?.stoppedBecause, NEEDS_SESSION);
    assert.equal(closed?.executionStatus, "paused");
    assert.equal(closed?.integrationHead, "head-1", "the paused build is still offered");
    assert.equal(closed?.baseCommit, "base-1");
    assert.deepEqual(closed?.workers, earlier.workers);
    assert.deepEqual(closed?.notes, earlier.notes);
    for (const how of ["limit", "stopCode", "failure", "workedUntil"])
      assert.ok(!(how in (closed ?? {})), `the refusal reads as its own stop, not the earlier session's ${how}`);
    assert.equal(host.appended("autopilot_paused").length, 1);
    assert.ok(
      !host.rec.paramsOf("run.artifact").some((params) => params.name === "report.json"),
      "no report rewritten",
    );
  });
});

describe("the credit cap a Loop in place keeps", () => {
  it(
    "a run's own cap is kept and carried to its workers; one Genex can't read becomes the default",
    TEST_TIMEOUT,
    async () => {
      const caps: Array<[unknown, number]> = [
        [200, 200],
        [-1, 600],
        [1.5, 600],
        ["600", 600],
      ];
      for (const [asked, kept] of caps) {
        const host = await hostOn(Project.GodotGame, {
          facts: GODOT,
          run: { budgets: { wallClockMs: 3 * HOUR, completionPolicy: "goal", creditCap: asked } },
          turns: [
            async ({ tool, host }) => {
              await tool("worker_start", { title: "Survey", task: "Read the scenes", isolation: "read" });
              await host.workers[0]?.end({ summary: "three scenes" });
              return undefined;
            },
            finishes,
          ],
        });
        await host.start();
        const [started] = host.appended("run_started");
        assert.equal((started?.budgets as Record<string, unknown> | undefined)?.creditCap, kept, String(asked));
        assert.equal(host.workers[0]?.params.creditCap, kept, `its worker carries it (${String(asked)})`);
      }
    },
  );

  it(
    "a run the Unreal runner paused goes on with what its jobs already spent taken off its cap",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.UnrealGame, { facts: UNREAL, turns: [finishes] });
      host.artifacts.set(`autopilot_${host.run.runId}`, olderJournal(host));
      await host.start({ resume: true });
      const [started] = host.appended("run_started");
      assert.equal(
        (started?.budgets as Record<string, unknown> | undefined)?.creditCap,
        480,
        "600 less the 120 it spent",
      );
    },
  );
});

describe("after a Loop in place", () => {
  it(
    "the chat keeps its status alone, is told nothing of a build to show or land, and never reopens it",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, { facts: GODOT, turns: [finishes] });
      await host.start();
      const run = {
        runId: host.run.runId,
        state: "finished",
        project: host.game.name,
        goal: "a level",
        engine: "claude-code",
      };
      const after = await afterLeadLoopRun(host.rec.ctx as never, { threadId: host.threadId }, run);
      assert.equal(after?.inPlace, true);
      const grant = afterLoopRunGrant(after as never);
      assert.equal(grant.runControls.inPlace, true);
      assert.deepEqual(
        runControlsFor(grant.runControls).map((tool) => tool.name),
        ["run_status"],
      );
      const note = afterLoopRunNote(after as never, "claude-code");
      assert.doesNotMatch(note, /show_build|land_build/);

      // The chat's own session's reopen of it is refused, saying why; no run starts.
      let started = 0;
      await reopenAfterReply(
        studioOf(host) as never,
        { threadId: host.threadId, cancelled: false },
        after as never,
        { hours: null, text: "Add a second room.", words: "Add a second room.", models: null },
        async () => {
          started += 1;
        },
      );
      assert.equal(started, 0);
      const errors = host.rec
        .paramsOf("events.append")
        .flatMap((params) => params.batch as Array<Record<string, unknown>>);
      assert.ok(
        errors.some((event) => String(event.message ?? "").includes(OPEN_LOOP_REFUSAL.notReopenable)),
        "the chat is told why",
      );
    },
  );

  it("a Loop message after a finished run follows that run's own kind, whatever the folder reads as now", async () => {
    const inPlace = { director: { open: { version: 1, savePoints: [] } } };
    const web = { director: { baseCommit: "abc", integrationHead: "def" } };
    const rows: Array<[string, unknown, Array<{ id: string; path: string }>, boolean]> = [
      ["a Loop in place, its folder now a web game", inPlace, [{ id: "web-game", path: "." }], true],
      ["a web Loop, its folder now read as nothing Genex knows", web, [], false],
      ["a web Loop, its folder now a Godot project", web, GODOT, true],
      ["a web Loop, its folder still a web game", web, [{ id: "web-game", path: "." }], false],
    ];
    const outcomes: Array<[string, boolean]> = [];
    for (const [label, journal, facts] of rows) {
      const host = {
        call: async (method: string) =>
          method === "game.list"
            ? [{ name: "lantern", facts, ...(facts.length ? {} : { holds: "unreadable" }) }]
            : structuredClone(journal),
      };
      const run = { runId: "run-done", state: "finished", project: "lantern" };
      const message = { threadId: "t1", project: "lantern", loop: true } as never;
      outcomes.push([label, await startsNextOpenLoop(host as never, message, run as never)]);
    }
    assert.deepEqual(
      outcomes,
      rows.map(([label, , , next]) => [label, next]),
    );
  });

  it(
    "Keep building after a finished Loop in place really launches the next Loop, on Godot and on Unreal: on its base goal and what is left, never refused",
    TEST_TIMEOUT,
    async () => {
      for (const [project, facts] of [
        [Project.GodotGame, GODOT],
        [Project.UnrealGame, UNREAL],
      ] as const) {
        const host = await hostOn(project, { facts, turns: [finishes] });
        await host.start();
        const leadsBefore = host.leadCalls().length;
        // The chat's turn for each tap: begun and ended, with nothing asked of a session in it.
        host.rec.handle("turn.begin", () => ({ turnId: "turn-keep" }));
        host.rec.handle("turn.end", () => null);
        const tap = async (n: number, left: string, hours: number | null = 3) => {
          host.turns.push(finishes);
          const keep = {
            type: "user_message",
            threadId: host.threadId,
            project: host.game.name,
            text: `Keep building: fix what’s left.\n- ${left}`,
            engine: "claude-code",
            messageId: `m-keep-${n}`,
            autopilot: { ...(hours === null ? {} : { hours }), keepBuilding: true },
          };
          await handleUserMessage(studioOf(host) as never, keep as never);
          assert.ok(await host.until(() => host.appended("run_finished").length > n), `${project}: tap ${n} closed`);
          return { started: host.appended("run_started").at(-1), closed: host.appended("run_finished").at(-1) };
        };
        const first = await tap(1, "The door sticks.");
        assert.equal(first.started?.mode, "director", `${project}: the one Loop's lead started it`);
        assert.notEqual(first.closed?.stoppedBecause, OPEN_LOOP_REFUSAL.webOnly, `${project}: not refused`);
        assert.ok(host.leadCalls().length > leadsBefore, `${project}: its lead built`);
        assert.match(String(first.started?.goal), /The door sticks/, "what is left is its goal");
        assert.match(
          String(first.started?.goal),
          new RegExp(String(host.run.goal).slice(0, 20)),
          "beside the base goal",
        );
        const second = await tap(2, "The lamp flickers.");
        assert.doesNotMatch(
          String(second.started?.goal),
          /The door sticks/,
          `${project}: an earlier tap's words don't pile up`,
        );
        assert.match(
          String(second.started?.goal),
          new RegExp(String(host.run.goal).slice(0, 20)),
          "the base goal stays",
        );
        assert.equal(
          (second.started?.reference as { name?: string } | undefined)?.name,
          "Level",
          "its reference is kept",
        );
        const forever = await tap(3, "The roof leaks.", null);
        const budgets = forever.started?.budgets as { wallClockMs?: number; untilSatisfied?: boolean } | undefined;
        assert.deepEqual(
          [budgets?.wallClockMs, budgets?.untilSatisfied],
          [MAX_RUN_HOURS * 60 * MINUTE, true],
          `${project}: ∞ runs until done under the launch's own ceiling`,
        );
      }
    },
  );

  it("a Loop message after it starts the next Loop, even when the game list can't be read", TEST_TIMEOUT, async () => {
    const host = await hostOn(Project.GodotGame, { facts: GODOT, turns: [finishes] });
    await host.start();
    host.rec.handle("game.list", () => {
      throw new Error("the list is busy");
    });
    const run = { runId: host.run.runId, state: "finished", project: host.game.name };
    const message = { threadId: host.threadId, project: host.game.name, loop: true } as never;
    assert.equal(await startsNextOpenLoop(host.rec.ctx as never, message, run), true);
  });

  it(
    "the chat's launch promise for a Loop in place says how it ends and promises no web connection",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, { facts: GODOT });
      const studio = studioOf(host);
      for (const [n, until] of [true, false].entries()) {
        host.rec.calls.length = 0;
        // The launched Loop claims its goal at once and closes before anything is asserted.
        host.turns.push(finishes);
        await launchFromIntake(
          studio as never,
          host.rec.ctx as never,
          { threadId: host.threadId, project: host.game.name } as never,
          {
            goal: "A level the player walks through.",
            engine: "claude-code",
            mode: "autopilot",
            ...(until ? { untilSatisfied: true } : { hours: 3 }),
          },
        );
        assert.ok(await host.until(() => host.appended("run_finished").length > n), "the launched Loop closed");
        // The next launch waits for this run to settle, as the chat's next message does.
        assert.ok(await host.until(() => studio.activeRuns.size === 0), "the launched Loop settled");
        const said = JSON.stringify(host.rec.paramsOf("events.append"));
        assert.doesNotMatch(said, /studio's connection/, "no web connection is promised");
        assert.doesNotMatch(said, /required outcomes/);
        if (until) assert.match(said, /a reviewer accepts the lead's finish/);
        else assert.match(said, /Building until about/);
      }
    },
  );
});

describe("a finished web Loop on a folder that reads otherwise now", () => {
  it(
    "its reopen is refused before anything is promised or written, and leaves the build finished",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, { facts: GODOT });
      const journal = {
        runId: host.run.runId,
        run: host.run,
        director: { baseCommit: "abc", integrationHead: "def", lead: { chatSession: true } },
      };
      const id = `autopilot_${host.run.runId}`;
      host.artifacts.set(id, structuredClone(journal));
      // The finished build's close: landed, its head the live game.
      const finished = {
        runId: host.run.runId,
        executionStatus: "completed",
        victory: true,
        landed: true,
        integrationHead: "def",
        summary: "The level is live.",
      };
      await host.rec.ctx.call("events.append", {
        threadId: host.threadId,
        batch: [{ type: "custom", event_type: "run_finished", payload: finished }],
      });
      let started = 0;
      await reopenAfterReply(
        studioOf(host) as never,
        { threadId: host.threadId, cancelled: false },
        { runId: host.run.runId } as never,
        { hours: 2, text: "keep going", words: "keep going", models: null },
        async () => {
          started += 1;
        },
      );
      const said = host.rec
        .paramsOf("events.append")
        .flatMap((params) => params.batch as Array<Record<string, unknown>>);
      assert.equal(started, 0);
      assert.ok(said.some((event) => String(event.message ?? "").includes(OPEN_LOOP_REFUSAL.webBuildElsewhere)));
      assert.ok(!JSON.stringify(said).includes('"role":"assistant"'), "nothing promised");
      assert.equal(JSON.stringify(host.artifacts.get(id)), JSON.stringify(journal), "its journal untouched");

      // A reopen that reaches the run's start anyway closes as the finished build it was, never paused.
      await handleRunStart(
        studioOf(host) as never,
        {
          type: "run_start",
          threadId: host.threadId,
          run: structuredClone(host.run) as never,
          resume: true,
          reopen: { after: null },
        } as never,
      );
      const closed = host.appended("run_finished").at(-1);
      assert.equal(closed?.executionStatus, "completed");
      assert.equal(closed?.stoppedBecause, OPEN_LOOP_REFUSAL.webBuildElsewhere);
      assert.equal(closed?.landed, true, "the build that landed still reads as landed");
      assert.equal(closed?.integrationHead, "def");
      assert.equal(closed?.victory, true, "the finished build keeps its outcome");
      const chatLines = host.rec
        .paramsOf("events.append")
        .flatMap((params) => (params.batch ?? []) as Array<{ type?: string; messages?: Array<{ content?: string }> }>)
        .filter((data) => data.type === "messages")
        .flatMap((data) => data.messages ?? []);
      assert.ok(
        chatLines.some((message) => message.content === OPEN_LOOP_REFUSAL.webBuildElsewhere),
        "the chat says why the build was not picked up",
      );
      assert.equal(host.appended("autopilot_paused").length, 0);
    },
  );

  it(
    "a paused classic Autopilot run is a web Loop's: on a folder that reads otherwise it stays paused, its cap unrecorded",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, { facts: GODOT, run: { engine: "ollama" } });
      host.rec.handle("engine.describe", () => [DIRECT]);
      const journal = { runId: host.run.runId, run: host.run, plan: { facets: [] }, phase: "facets", facets: {} };
      host.artifacts.set(`autopilot_${host.run.runId}`, structuredClone(journal));
      await host.dispatch({ resume: true });
      const [closed] = host.appended("run_finished");
      assert.equal(closed?.stoppedBecause, OPEN_LOOP_REFUSAL.webElsewhere(GODOT_FOUND));
      assert.equal(closed?.executionStatus, "paused");

      const classic = await hostOn(Project.GodotGame, { facts: GODOT, run: { classic: true } });
      classic.artifacts.set(`autopilot_${classic.run.runId}`, {
        ...journal,
        runId: classic.run.runId,
        run: classic.run,
      });
      await classic.dispatch({ resume: true });
      assert.equal(classic.appended("run_finished")[0]?.stoppedBecause, OPEN_LOOP_REFUSAL.webElsewhere(GODOT_FOUND));
      const budgets = classic.appended("run_started")[0]?.budgets as Record<string, unknown> | undefined;
      assert.equal(budgets?.creditCap, undefined, "no credit cap of the open Loop's on a web run's refusal");
    },
  );
});

describe("what a Loop in place teaches", () => {
  it(
    "a fresh Loop in place runs no self-improvement pass: it is no evidence for the web method",
    TEST_TIMEOUT,
    async () => {
      const notes: LoopTurn = async ({ tool }) => {
        await tool("note", { text: "Rooms first, then the door." });
        await tool("finish", { summary: "The level is built and the door opens.", proof: "project.godot" });
        return undefined;
      };
      const host = await hostOn(Project.GodotGame, { facts: GODOT, turns: [notes] });
      host.rec.handle("learning.enabled", () => true);
      await host.dispatch();
      assert.equal(host.appended("run_finished").at(-1)?.victory, true);
      assert.deepEqual(host.appended("run_learning"), [], "no learning pass");
    },
  );
});

describe("a web page missing its files, at the run's start", () => {
  it(
    "a launch kept from before that made a game with no kind is not refused for the web page it is about to get",
    TEST_TIMEOUT,
    async () => {
      const fresh = await hostOn(Project.GodotGame, { facts: [] });
      fresh.rec.handle("game.validate", () => ({
        problems: ["index.html is missing", "src/main.js is missing"],
        missing: ["index.html", "src/main.js"],
      }));
      fresh.rec.handle("game.start", () => {
        throw new Error("the web starter ran");
      });
      const action = { type: "run_start", threadId: fresh.threadId, run: structuredClone(fresh.run) };
      await handleRunStart(studioOf(fresh) as never, action as never, { keepStop: true });
      assert.deepEqual(fresh.appended("run_start_blocked"), [], "no refusal before the web starter");
      assert.equal(fresh.appended("run_registered").length, 1, "the run started");
      assert.equal(fresh.rec.paramsOf("game.start").length, 1, "and asked for the web starter");
    },
  );

  it(
    "a chat-launched web Loop is refused by Genex's own gate whichever launch asked, and a Loop in place is never validated",
    TEST_TIMEOUT,
    async () => {
      const web = await hostOn(Project.GodotGame, { facts: [{ id: "web-game", path: "." }] });
      web.rec.handle("game.validate", () => ({ problems: ["index.html is missing"], missing: ["index.html"] }));
      // An older launch hands the start no typed list: the start asks for it itself.
      const action = { type: "run_start", threadId: web.threadId, run: structuredClone(web.run) };
      await handleRunStart(studioOf(web) as never, action as never, { keepStop: true });
      const [blocked] = web.appended("run_start_blocked");
      assert.match(String(blocked?.reason), /is not ready for a run: index\.html is missing/);
      assert.equal(web.appended("run_registered").length, 0, "no run was registered");

      const godot = await hostOn(Project.GodotGame, { facts: GODOT, turns: [finishes] });
      const start = { type: "run_start", threadId: godot.threadId, run: structuredClone(godot.run) };
      await handleRunStart(studioOf(godot) as never, start as never, { keepStop: true });
      assert.deepEqual(godot.rec.paramsOf("game.validate"), []);
      assert.equal(godot.appended("run_finished").length, 1);
    },
  );
});

describe("a Resume while the paused run is still closing", () => {
  it("waits for that run's close and starts: it is never refused as a second run", TEST_TIMEOUT, async () => {
    const host = await hostOn(Project.GodotGame, {
      facts: GODOT,
      turns: [
        ({ host }) => {
          host.rec.cancel();
          return undefined;
        },
      ],
    });
    // Once the pause is recorded, the run's close is held: its report is still being written.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pauseRecorded = () => {};
    const recorded = new Promise<void>((resolve) => {
      pauseRecorded = resolve;
    });
    // What the Resume had done when the held close was let go: it waits, so nothing yet.
    let atClose: { lists: number; registered: number } | undefined;
    host.rec.handle("run.artifact", async (params) => {
      if (host.appended("autopilot_paused").length > 0 && !atClose) {
        pauseRecorded();
        await held;
        atClose = { lists: host.rec.paramsOf("game.list").length, registered: host.appended("run_registered").length };
      }
      return `/runs/${String(params.runId)}/${String(params.name)}`;
    });
    const studio = studioOf(host);
    const start = (resume: boolean) =>
      ({ type: "run_start", threadId: host.threadId, run: structuredClone(host.run), resume }) as never;
    const paused = handleRunStart(studio as never, start(false));
    // A first run that ends before its pause fails here, never waits forever.
    await Promise.race([recorded, paused]);
    assert.equal(host.appended("autopilot_paused").length, 1, "the pause is recorded");

    host.turns.push(finishes);
    host.rec.ctx.cancelled = false;
    const listsBefore = host.rec.paramsOf("game.list").length;
    const resumed = handleRunStart(studio as never, start(true));
    // Every step the Resume can take before the paused run's close is let go: a start that did not
    // wait would read the game list (its first host call) within them.
    await setImmediate();
    release();
    await Promise.all([paused, resumed]);
    assert.deepEqual(
      atClose,
      { lists: listsBefore, registered: 1 },
      "while the paused run closed, the Resume only waited: no game list read, no run registered",
    );
    assert.deepEqual(host.appended("run_start_blocked"), [], "the Resume is not refused");
    const registered = host.appended("run_registered");
    assert.equal(registered.length, 2, "the Resume started once the paused run had closed");
    assert.equal(registered[1]?.resumed, true);
    assert.equal(host.appended("run_finished").length, 2);
  });
});

/** A run's report write (`run.artifact`) held once `event` is appended for it: the run is writing its close. */
function holdCloseAfter(host: LoopHost, event: string) {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached = () => {};
  const closing = new Promise<void>((resolve) => {
    reached = resolve;
  });
  // What the second start had done when the held close was let go.
  const state: { atClose?: { lists: number; registered: number } } = {};
  host.rec.handle("run.artifact", async (params) => {
    if (host.appended(event).length > 0 && !state.atClose) {
      reached();
      await held;
      state.atClose = {
        lists: host.rec.paramsOf("game.list").length,
        registered: host.appended("run_registered").length,
      };
    }
    return `/runs/${String(params.runId)}/${String(params.name)}`;
  });
  return { release, closing, state };
}

describe("a start while the finished run is still closing", () => {
  it("waits for that run's close and starts: it is never refused as a second run", TEST_TIMEOUT, async () => {
    const host = await hostOn(Project.GodotGame, { facts: GODOT, turns: [finishes] });
    const { release, closing, state } = holdCloseAfter(host, "run_finished");
    const studio = studioOf(host);
    const first = handleRunStart(
      studio as never,
      {
        type: "run_start",
        threadId: host.threadId,
        run: structuredClone(host.run),
      } as never,
    );
    // A first run that ends before its close fails here, never waits forever.
    await Promise.race([closing, first]);
    assert.equal(host.appended("run_finished").length, 1, "the finish is recorded");

    host.turns.push(finishes);
    const listsBefore = host.rec.paramsOf("game.list").length;
    const next = handleRunStart(
      studio as never,
      {
        type: "run_start",
        threadId: host.threadId,
        run: structuredClone(host.run),
        resume: true,
      } as never,
    );
    // Every step the start can take before the finished run's close is let go.
    await setImmediate();
    release();
    await Promise.all([first, next]);
    assert.deepEqual(
      state.atClose,
      { lists: listsBefore, registered: 1 },
      "while the finished run closed, the start only waited: no game list read, no run registered",
    );
    assert.deepEqual(host.appended("run_start_blocked"), [], "the start is not refused");
    assert.equal(host.appended("run_registered").length, 2, "it started once the finished run had closed");
  });
});

describe("Stop pressed again while a Resume waits for the Stop-paused run's close", () => {
  it("the Resume does not start", TEST_TIMEOUT, async () => {
    let studio: ReturnType<typeof studioOf> | undefined;
    const host = await hostOn(Project.GodotGame, {
      facts: GODOT,
      turns: [
        ({ host }) => {
          // The person's Stop: the thread's flag, and every run of the chat stopped.
          host.rec.cancel();
          if (studio) stopRunsOf(studio as never, host.threadId);
          return undefined;
        },
      ],
    });
    const { release, closing } = holdCloseAfter(host, "autopilot_paused");
    studio = studioOf(host);
    const start = (resume: boolean) =>
      ({ type: "run_start", threadId: host.threadId, run: structuredClone(host.run), resume }) as never;
    const paused = handleRunStart(studio as never, start(false));
    await Promise.race([closing, paused]);
    assert.equal(host.appended("autopilot_paused").length, 1, "the pause is recorded");

    host.turns.push(finishes);
    host.rec.ctx.cancelled = false;
    const resumed = handleRunStart(studio as never, start(true));
    await setImmediate();
    // Stop again, as the composer's Stop does it.
    studio.cancels.add(host.threadId);
    stopRunsOf(studio as never, host.threadId);
    release();
    await Promise.all([paused, resumed]);
    assert.equal(host.appended("run_registered").length, 1, "only the paused run was ever registered");
  });
});

describe("a run's route when its journal, its folder or the game list can't be read", () => {
  it(
    "a paused Loop that worked in place goes on in place on a folder of no kind Genex names, and nothing is written into it",
    TEST_TIMEOUT,
    async () => {
      const outcomes: Array<Record<string, unknown>> = [];
      for (const holds of ["own-files", "notes"]) {
        const host = await hostOn(Project.GodotGame, { facts: [], holds, turns: [finishes] });
        host.artifacts.set(`autopilot_${host.run.runId}`, {
          runId: host.run.runId,
          run: host.run,
          phase: "paused",
          director: { baseCommit: "abc", integrationHead: null, open: { version: 1, savePoints: [] } },
        });
        await host.dispatch({ resume: true });
        outcomes.push({
          holds,
          started: host.rec.paramsOf("game.start").length,
          inPlace: inPlaceLeads(host).length > 0,
          status: host.appended("run_finished").at(-1)?.executionStatus,
        });
      }
      assert.deepEqual(outcomes, [
        { holds: "own-files", started: 0, inPlace: true, status: "completed" },
        { holds: "notes", started: 0, inPlace: true, status: "completed" },
      ]);
    },
  );

  it(
    "a paused Loop whose journal can't be read stays paused, and no Loop of either kind runs",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, { facts: GODOT, turns: [finishes] });
      const id = `autopilot_${host.run.runId}`;
      host.artifacts.set(id, {
        runId: host.run.runId,
        run: host.run,
        director: { baseCommit: "abc", open: { version: 1 } },
      });
      host.rec.handle("artifact.read", (params) => {
        if (params.artifactId === id) throw new Error("the disk is busy");
        return structuredClone(host.artifacts.get(String(params.artifactId)) ?? null);
      });
      await host.dispatch({ resume: true });
      const [closed] = host.appended("run_finished");
      assert.equal(closed?.stoppedBecause, OPEN_LOOP_REFUSAL.journalUnreadable);
      assert.equal(closed?.executionStatus, "paused");
      assert.equal(host.leadCalls().length, 0);
    },
  );

  it(
    "a fresh run whose game list can't be read is refused with words, and nothing web is written",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, { facts: GODOT, turns: [finishes] });
      host.rec.handle("game.list", () => {
        throw new Error("a studio.json can't be read");
      });
      await host.dispatch();
      const [closed] = host.appended("run_finished");
      assert.equal(closed?.stoppedBecause, OPEN_LOOP_REFUSAL.gamesUnreadable);
      for (const method of ["game.scaffold", "game.start", "game.upgradeContract", "preview.load", "engine.delegate"])
        assert.equal(host.rec.paramsOf(method).length, 0, `no ${method}`);
    },
  );

  it(
    "a finished web Loop whose folder can't be read is neither reopened nor followed by a new Loop: the reopen says why",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, { facts: [], holds: "unreadable" });
      const journal = { runId: host.run.runId, run: host.run, director: { baseCommit: "abc", integrationHead: "def" } };
      host.artifacts.set(`autopilot_${host.run.runId}`, structuredClone(journal));
      const run = { runId: host.run.runId, state: "finished", project: host.game.name };
      const message = { threadId: host.threadId, project: host.game.name, loop: true } as never;
      assert.equal(await startsNextOpenLoop(host.rec.ctx as never, message, run as never), false);
      let started = 0;
      await reopenAfterReply(
        studioOf(host) as never,
        { threadId: host.threadId, cancelled: false },
        { runId: host.run.runId } as never,
        { hours: 2, text: "keep going", words: "keep going", models: null },
        async () => {
          started += 1;
        },
      );
      const said = JSON.stringify(host.rec.paramsOf("events.append"));
      assert.equal(started, 0);
      assert.ok(said.includes(OPEN_LOOP_REFUSAL.folderUnknown.slice(0, 60)), said);
      assert.ok(!said.includes("send the Loop again"), "no advice that leads back to the same refusal");
    },
  );

  it(
    "a web game holding an engine's sample project is told which files make its Loop work in place",
    TEST_TIMEOUT,
    async () => {
      const facts = [
        { id: "web-game", path: "." },
        { id: "godot-project", path: "assets/pack" },
      ];
      const host = await hostOn(Project.GodotGame, { facts, run: { engine: "ollama" } });
      host.rec.handle("engine.describe", () => [DIRECT]);
      const studio = { host: host.rec.ctx, moodBoards: new Map(), activeRuns: new Map(), startingRuns: new Map() };
      await assert.rejects(
        launchFromIntake(studio as never, host.rec.ctx as never, { threadId: "t1", project: host.game.name } as never, {
          goal: "A level the player walks through.",
          engine: "ollama",
          mode: "autopilot",
        }),
        (err: Error) => err.message === OPEN_LOOP_REFUSAL.needsSession("Ollama", "godot-project in assets/pack"),
      );
    },
  );
});
