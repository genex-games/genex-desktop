/**
 * Which Loop a run gets, through the run's start as the chat and Resume reach it: a project of any
 * kind runs the one Loop in its folder on an engine that keeps a session and is told, before
 * anything is promised, that it needs one otherwise; a paused Loop that worked in place goes on in
 * it; a paused web Loop from before is refused, naming where its work is; a paused classic or Unreal
 * runner build is closed as it stood; and the Loop's start describes the one Loop truthfully.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate } from "node:timers/promises";
import { afterLeadLoopRun, afterLoopRunGrant } from "../../src/harness-seed/loop/after-loop-run.ts";
import { launchFromIntake } from "../../src/harness-seed/loop/chat-dispatch.ts";
import { OPEN_LOOP_REFUSAL } from "../../src/harness-seed/loop/open-loop-prompts.ts";
import { startAutopilot } from "../../src/harness-seed/loop/start-autopilot.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";
import { stopRunsOf } from "../../src/harness-seed/loop/live-chat.ts";
import { runControlTools } from "../../src/shared/chat-run.ts";
import * as runDispatchParts from "../../src/harness-seed/loop/run-dispatch.ts";
import { chooseRunner, handleRunStart } from "../../src/harness-seed/loop/run-dispatch.ts";
import { RunnerKind } from "../../src/harness-seed/loop/studio-state.ts";
import { CHAT_SESSION, gameRepo, type LoopHost, type LoopTurn, loopHost } from "../helpers/loop-host.ts";
import { copyProject, Project } from "../helpers/project-fixtures.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** No Loop here may hang the suite: each is over in a few seconds when it works. */
const TEST_TIMEOUT = { timeout: 60_000 };

const GODOT = [{ id: "godot-project", path: "." }];
const UNREAL = [{ id: "unreal-project", path: "." }];
const WEB = [{ id: "web-game", path: "." }];

/** An engine that keeps no session, as `engine.describe` lists it. */
const DIRECT = { id: "ollama", label: "Ollama", kind: "direct" };

/** An engine Genex drives itself that keeps sessions (Bonsai's shape), as `engine.describe` lists it. */
const DIRECT_WITH_SESSIONS = { id: "bonsai", label: "Bonsai", kind: "direct", supportsSessions: true };

/**
 * The words a refused Loop on a direct engine closes with (flipped in phase 5: any Loop needs a
 * session, and the chat goes on; flipped again with the one Loop: they named what Genex found that
 * made the project's Loop work in place, and every Loop does).
 */
const NEEDS_SESSION =
  "A Loop needs an engine that keeps a session of its own (Claude Code, Codex, OpenCode, Grok Build or a local model's session); Ollama doesn't, so nothing was built. The chat still answers here.";

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
  await tool("finish", { review: "yes", summary: "The level is built and the door opens.", proof: "project.godot" });
  return undefined;
};

/**
 * The lead delegations that worked in place, as the one Loop's do. Flipped: read from the grant's
 * `inPlace` flag, which is gone; a lead's grant is in place by its root, the game folder itself.
 */
const inPlaceLeads = (host: LoopHost) =>
  host.leadCalls().filter((call) => (call.director as { root?: unknown } | undefined)?.root === host.game.dir);

describe("which Loop a run gets", () => {
  it("a Loop on a project that isn't a web game runs the one Loop", TEST_TIMEOUT, async () => {
    const host = await hostOn(Project.GodotGame, { facts: GODOT, turns: [finishes] });
    await host.dispatch();
    const [first] = inPlaceLeads(host);
    assert.ok(first, "the lead worked in place");
    assert.equal(first.resume, CHAT_SESSION, "the chat's own session leads");
    assert.equal(first.selfCapture, undefined, "a Godot folder Genex does not see: no window, as its chat's turns");
    for (const method of ["game.scaffold", "preview.load"]) assert.ok(!host.trail().includes(method), `no ${method}`);
    assert.equal(host.appended("run_finished").length, 1);
  });

  it("on an engine without sessions the Loop closes saying it needs one", TEST_TIMEOUT, async () => {
    const host = await hostOn(Project.GodotGame, { facts: GODOT, run: { engine: "ollama" } });
    host.rec.handle("engine.describe", () => [DIRECT]);
    await host.dispatch();
    const [closed] = host.appended("run_finished");
    assert.equal(closed?.stoppedBecause, NEEDS_SESSION);
    assert.equal(closed?.landed, false);
    assert.equal(host.rec.paramsOf("engine.delegate").length, 0, "no session ran");
  });

  it("a Loop on an engine without sessions closes with the typed reason, on any project", TEST_TIMEOUT, async () => {
    assert.equal(
      chooseRunner({ runId: "r", project: "p", goal: "g", engine: "ollama" } as never, [DIRECT as never]),
      RunnerKind.NeedsSession,
    );
    for (const [project, facts] of [
      [Project.GodotGame, GODOT],
      [Project.WebFolder, WEB],
    ] as const) {
      const host = await hostOn(project, { facts, run: { engine: "ollama" } });
      host.rec.handle("engine.describe", () => [DIRECT]);
      await host.dispatch();
      const [closed] = host.appended("run_finished");
      assert.equal(closed?.refusal, runDispatchParts.LoopRefusal.NeedsSession, `${project}: the reason is typed`);
      assert.equal(closed?.landed, false);
      assert.equal(host.rec.paramsOf("engine.delegate").length, 0, `${project}: no session ran`);
    }
  });

  it(
    // Flipped (Loop phase 3): it was refused at launch and at dispatch; any model orchestrates now.
    "on an engine Genex drives itself that keeps sessions (Bonsai's) the one Loop runs too, led in place",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, { facts: GODOT, run: { engine: "bonsai" }, turns: [finishes] });
      host.rec.handle("engine.describe", () => [DIRECT_WITH_SESSIONS]);
      const words = OPEN_LOOP_REFUSAL.needsSession("Bonsai");
      await host.dispatch();
      const [first] = inPlaceLeads(host);
      assert.ok(first, "the lead worked in place");
      assert.notEqual(host.appended("run_finished")[0]?.stoppedBecause, words, "never refused for its engine");
    },
  );

  it("a paused Loop on an Unreal game goes on in the one Loop on Resume", TEST_TIMEOUT, async () => {
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
    await host.dispatch({ resume: true });
    assert.equal(inPlaceLeads(host).length, 2, "both turns were the one Loop's");
  });
});

describe("kept older parts, finished Loops and the chat's words", () => {
  it("a web Loop on an engine that keeps a session runs under the director", () => {
    const described = [{ id: "claude-code", kind: "delegated", supportsSessions: true }] as never;
    assert.equal(chooseRunner({ mode: "autopilot", engine: "claude-code" } as never, described), RunnerKind.Director);
  });

  it("a finished open Loop reads as worked in place, a web Loop's not", async () => {
    const journal = { director: { lead: { chatSession: true }, open: { version: 1, savePoints: [] } } };
    const host = { call: async () => structuredClone(journal) };
    const run = { runId: "run-done", state: "finished", project: "lantern", goal: "a level", engine: "claude-code" };
    const inPlace = await afterLeadLoopRun(host as never, { threadId: "t1" }, run);
    assert.equal(inPlace?.inPlace, true, "worked in place");
    const web = { call: async () => ({ director: { lead: { chatSession: true } } }) };
    const webRun = await afterLeadLoopRun(web as never, { threadId: "t1" }, run);
    assert.equal(webRun?.inPlace, undefined);
  });

  it("after a paused web Loop from before the chat answers as after a finished one: no resume_run", async () => {
    const paused = { runId: "run-paused", state: "paused", project: "lantern", goal: "a level", engine: "claude-code" };
    const open = { call: async () => ({ director: { lead: { chatSession: true }, open: { version: 1 } } }) };
    const web = { call: async () => ({ director: { lead: { chatSession: true } } }) };
    const offered = async (host: unknown) => {
      const after = await afterLeadLoopRun(host as never, { threadId: "t1" }, paused);
      assert.ok(after, "the chat's own session answers after it");
      const grant = afterLoopRunGrant(after);
      return { controls: grant.runControls.runId, tools: (grant.interviewTools ?? []).map((tool) => tool.name) };
    };
    assert.deepEqual(await offered(open), { controls: "run-paused", tools: ["resume_run"] });
    // Run dispatch refuses its resume (`OPEN_LOOP_REFUSAL.webLoopBefore`): no resume is offered for it.
    assert.deepEqual(await offered(web), { controls: "run-paused", tools: [] });
  });
});

/** The studio a dispatch reaches, over a host's recorder, as main.ts makes it. */
function studioOf(host: LoopHost) {
  const ctx = host.rec.ctx;
  return {
    host: ctx,
    cancels: new Set<string>(),
    stoppedMessages: new Set<string>(),
    activeRuns: new Map(),
    startingRuns: new Map(),
    orphanRuns: new Map(),
    scoped: () => ctx,
  };
}

describe("the chat's launch tool", () => {
  // Flipped: it answered "Building until its lead calls finish."; a turn that ends with nothing at work also ends a Loop, so it says only that it builds.
  it("names no method and no rule about when in its description, and answers that it builds, nothing about when it ends", async () => {
    assert.doesNotMatch(String(startAutopilot.description), /critic|facet|when Loop|in words|hours/i);
    const host = ctxRecorder({ threadId: "chat-1", extra: { project: "lantern" } });
    const answer = await startAutopilot.execute(
      { goal: "A level.", direction: "a lantern-lit cave" },
      host.ctx as never,
    );
    assert.equal((answer as { content?: unknown }).content, "Building.");
    assert.deepEqual(host.calls, [], "it asks the host nothing");
  });
});

describe("a paused Loop's journal, read at its start", () => {
  // Flipped (one Loop): a paused web Loop resumed in its integration worktree on a web folder, and on
  // a folder that read otherwise it stayed paused with `webElsewhere`'s words. No web Loop works in a
  // copy now: it is refused on any folder, and its card names the ref that holds its work.
  it(
    "a paused web Loop from before is refused on any folder, stays paused, and names the ref its work is on",
    TEST_TIMEOUT,
    async () => {
      for (const [project, facts] of [
        [Project.WebFolder, WEB],
        [Project.GodotGame, GODOT],
      ] as const) {
        const host = await hostOn(project, { facts, turns: [finishes] });
        const journal = {
          runId: host.run.runId,
          run: host.run,
          director: { baseCommit: "abc", integrationHead: "def", workers: {}, notes: [] },
        };
        host.artifacts.set(`autopilot_${host.run.runId}`, structuredClone(journal));
        const head = await host.git("rev-parse", "HEAD");
        await host.dispatch({ resume: true });
        const [closed] = host.appended("run_finished");
        // A refusal keeps the run's record as it came: no credit cap of a Loop it never ran.
        assert.deepEqual(
          {
            status: closed?.executionStatus,
            paused: host.appended("autopilot_paused").length,
            journalKept: JSON.stringify(host.artifacts.get(`autopilot_${host.run.runId}`)) === JSON.stringify(journal),
            report: host.rec.paramsOf("run.artifact").some((params) => params.name === "report.json"),
            leads: host.leadCalls().length,
            cap: (host.appended("run_started")[0]?.budgets as Record<string, unknown> | undefined)?.creditCap,
            head: await host.git("rev-parse", "HEAD"),
            status_: await host.git("status", "--porcelain"),
          },
          {
            status: "paused",
            paused: 1,
            journalKept: true,
            report: false,
            leads: 0,
            cap: undefined,
            head,
            status_: "",
          },
          project,
        );
        const words = String(closed?.stoppedBecause);
        assert.ok(words.includes(`refs/studio/runs/${host.run.runId}/integration`), `${project}: ${words}`);
        assert.doesNotMatch(words, /reads as a web game|Resume picks it up/, `${project}: never webElsewhere's words`);
      }
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
      assert.equal((lead?.director as { root?: string } | undefined)?.root, web.game.dir, "led in place");
      // A folder that reads as a web game now: the lead's turn carries its chat's eyes on it.
      assert.deepEqual(
        lead?.selfCapture,
        { project: web.game.name, root: web.game.dir, label: web.game.name },
        "the window its chat's turns have",
      );
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
    // Flipped (one Loop): the earlier close's `integrationHead` was kept, the paused build still
    // offered to show or land; no run leaves a build of its own now, and none is kept.
    assert.equal(closed?.integrationHead, undefined);
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
          run: { budgets: { creditCap: asked } },
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
});

describe("after a Loop in place", () => {
  // Flipped: an after-run note was also checked to name no build to show or land; no note is written now.
  it("the chat keeps its status alone, with no tool to show or land a build", TEST_TIMEOUT, async () => {
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
    // Flipped: the grant carried `inPlace` and the host chose the status alone by it; every Loop's
    // chat is handed the one control now, `run_status`.
    const grant = afterLoopRunGrant(after as never);
    assert.deepEqual(grant.runControls, { runId: host.run.runId });
    assert.deepEqual(
      runControlTools.map((tool) => tool.name),
      ["run_status"],
    );
  });

  it(
    "a Loop in place launches with no promise of when it ends and no time limit, whatever hours its start named",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, { facts: GODOT });
      const studio = studioOf(host);
      // The launched Loop claims its goal at once and closes before anything is asserted.
      host.turns.push(finishes);
      await launchFromIntake(
        studio as never,
        host.rec.ctx as never,
        { threadId: host.threadId, project: host.game.name } as never,
        { goal: "A level the player walks through.", engine: "claude-code", mode: "autopilot", hours: 3 },
      );
      assert.ok(await host.until(() => host.appended("run_finished").length > 0), "the launched Loop closed");
      assert.ok(await host.until(() => studio.activeRuns.size === 0), "the launched Loop settled");
      const said = host.rec
        .paramsOf("events.append")
        .flatMap((params) => (params.batch ?? []) as Array<{ type?: string }>)
        .filter((data) => data.type === "messages");
      // Flipped: the chat promised "Building until about …, keep the app open"; it promises nothing now.
      assert.deepEqual(said, [], "no promise in the chat");
      const budgets = host.appended("run_registered")[0]?.budgets as Record<string, unknown> | undefined;
      // Flipped (no clock): the launch registered `untilSatisfied: true` under a 24-hour `wallClockMs`.
      assert.equal(budgets?.untilSatisfied, undefined);
      assert.equal(budgets?.wallClockMs, undefined);
    },
  );
});

describe("a build an earlier Genex paused, of a kind no Loop is now", () => {
  // Flipped (one Loop): on a folder that read as no web game, a classic run and a run the Unreal
  // runner paused stayed paused with `webElsewhere`'s words ("paused as a web game's Loop"), which
  // named neither. Both are a build from before now, on any folder: closed as they stood.
  it(
    "a paused classic run or one the Unreal runner paused is closed as it stood, in words for a build from before",
    TEST_TIMEOUT,
    async () => {
      const classic = (host: LoopHost) => ({ plan: { facets: [] }, phase: "facets", facets: {}, run: host.run });
      const runner = (host: LoopHost) => ({ kind: "unreal-lead", phase: "paused", run: host.run });
      for (const [project, facts, journalOf] of [
        [Project.GodotGame, GODOT, classic],
        [Project.WebFolder, WEB, classic],
        [Project.UnrealGame, UNREAL, runner],
      ] as const) {
        const host = await hostOn(project, { facts, turns: [finishes] });
        host.artifacts.set(`autopilot_${host.run.runId}`, { runId: host.run.runId, ...journalOf(host) });
        await host.dispatch({ resume: true });
        const [closed] = host.appended("run_finished");
        assert.match(String(closed?.stoppedBecause), /paused by an earlier version of Genex/, project);
        assert.equal(closed?.executionStatus, "completed", `${project}: closed as it stood`);
        assert.equal(host.leadCalls().length, 0, `${project}: no turn`);
        const budgets = host.appended("run_started")[0]?.budgets as Record<string, unknown> | undefined;
        assert.equal(budgets?.creditCap, undefined, `${project}: no credit cap of a Loop it never ran`);
      }
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
        await tool("finish", {
          review: "yes",
          summary: "The level is built and the door opens.",
          proof: "project.godot",
        });
        return undefined;
      };
      const host = await hostOn(Project.GodotGame, { facts: GODOT, turns: [notes] });
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

  // Flipped: Genex's own gate refused the chat-launched web Loop ("is not ready for a run: index.html
  // is missing"), and no run was registered; its lead builds in that very folder, so it reads why.
  it(
    "a chat-launched web Loop missing its page starts, its lead's first line naming what is missing, and a Loop the gate doesn't reach is never validated",
    TEST_TIMEOUT,
    async () => {
      const web = await hostOn(Project.GodotGame, { facts: WEB });
      web.rec.handle("game.validate", () => ({ problems: ["index.html is missing"], missing: ["index.html"] }));
      const action = { type: "run_start", threadId: web.threadId, run: structuredClone(web.run) };
      await handleRunStart(studioOf(web) as never, action as never, { keepStop: true });
      assert.deepEqual(web.appended("run_start_blocked"), [], "never refused");
      assert.equal(web.appended("run_registered").length, 1, "the run started");
      const [first] = web.prompts();
      assert.ok(first?.includes(`${web.run.project}'s page is missing index.html.`), String(first));

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
      for (const method of ["game.scaffold", "game.start", "preview.load", "engine.delegate"])
        assert.equal(host.rec.paramsOf(method).length, 0, `no ${method}`);
    },
  );
});
