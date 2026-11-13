/**
 * The one Loop, on a project of any kind (a web game's too): the chat's own session leads in place,
 * workers come from the shared pool, and the Loop ends on its lead's finish, a stop or a pause (a turn that
 * ends with nothing at work pauses it) — never by landing a copy, and never on a clock.
 */
import assert from "node:assert/strict";
import { readFile, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { OPEN_CLOSE_MS } from "../../src/harness-seed/loop/director/open/contract.ts";
import { directorTool } from "../../src/harness-seed/loop/director/tool-specs.ts";
import { folderChanged } from "../../src/harness-seed/loop/director/open/close.ts";
import { MESSAGE as OPEN_END } from "../../src/harness-seed/loop/director/open/finish.ts";
import { BUSY_RETRY_MS } from "../../src/harness-seed/loop/director/wake.ts";
import { LOOP_WORDS } from "../../src/harness-seed/loop/director/wake-prompts.ts";
import { OPEN_NEWS, OPEN_WORDS } from "../../src/harness-seed/loop/director/open/prompts.ts";
import { APP_NEWS } from "../../src/harness-seed/loop/director/open/app-prompts.ts";
import {
  CALL_MARGIN_MS,
  FINISH_OBSERVE_MS,
  FINISH_REPORT,
  FINISH_REVIEW_MS,
} from "../../src/harness-seed/loop/finish-check.ts";
import { HOOK_PROMPTS } from "../../src/harness-seed/loop/hooks-prompts.ts";
import { LEAD_CALL_MS } from "../../src/harness-seed/loop/finish-contract.ts";
import { forgetProviderLosses } from "../../src/harness-seed/loop/provider-loss.ts";
import { WorkerIsolation, type WorkerType } from "../../src/shared/workers.ts";
import unrealManifest from "../../src/plugins/unreal/plugin.json" with { type: "json" };
import toyManifest from "../fixtures/toy-engine-plugin/plugin.json" with { type: "json" };
import pausedJournals from "../fixtures/open-loop-paused-journals.json" with { type: "json" };
import {
  CHAT_SESSION,
  gameRepo,
  type LoopHost,
  type LoopManifest,
  type LoopTurn,
  loopHost,
} from "../helpers/loop-host.ts";
import { copyProject, Project } from "../helpers/project-fixtures.ts";
import { reviewerAnswer } from "../helpers/reviewer.ts";
import { tmpDir } from "../helpers/tmp.ts";

const MINUTE = 60_000;
/** How long, in real time, a plugin's step at the Loop's close takes when a test makes it outlast the call. */
const CLOSE_STEP_REAL_MS = 100;
/** No Loop here may hang the suite: each is over in a few seconds when it works. */
const TEST_TIMEOUT = { timeout: 60_000 };

const GODOT = [{ id: "godot-project", path: "." }];
const TOY = [{ id: "toy-project", path: "." }];
const UNREAL = [{ id: "unreal-project", path: "." }];

/** The toy plugin, with a step at the finish moment too. */
const TOY_MANIFEST = toyManifest as unknown as LoopManifest;
const TOY_WITH_FINISH = {
  ...TOY_MANIFEST,
  hooks: [...(TOY_MANIFEST.hooks ?? []), { on: "finish", tool: "capture" }],
} as LoopManifest;

/** The toy plugin's worker type, as `plugins.workerTypes` lists it. */
const SCENE: WorkerType = {
  pluginId: "toy-engine",
  id: "scene",
  description: "Edits one scene",
  tools: ["toy-engine__build"],
  isolation: WorkerIsolation.Copy,
};

/** The Unreal plugin, as the bus plans its moments. */
const UNREAL_MANIFEST = unrealManifest as unknown as LoopManifest;

/** The open lead's tools, by name, on a project whose plugin restarts its app (the toy's). */
// Flipped (phase 5): every Loop's lead may ask for a second opinion (`judge`).
const OPEN_TOOLS = [
  "finish",
  "judge",
  "note",
  "pause",
  "restart",
  "rewind",
  "run_status",
  "save_point",
  "worker_mark",
  "worker_start",
  "worker_status",
  "worker_steer",
  "worker_stop",
  "worker_wait",
  "wrap_up",
];

/** A picture a plugin's step answers with. */
const PICTURE = {
  name: "viewport",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==",
};

let runs = 0;

/** A Loop's host on a copy of one project fixture made a git repository, under a run id of its own. */
async function hostOn(
  project: Project,
  options: Omit<Parameters<typeof loopHost>[0], "dir"> & { turns?: LoopTurn[] },
): Promise<LoopHost> {
  const dir = await gameRepo(await copyProject(project, await tmpDir("one-loop-")));
  runs += 1;
  return loopHost({ ...options, dir, run: { runId: `run-open-${runs}`, ...options.run } });
}

/**
 * `turn`, and the person's words sent while it worked, which wake the next turn: a turn that ends
 * with nothing at work and nothing to be woken for pauses the Loop.
 */
const thenThePersonSays =
  (turn: LoopTurn, words = "Go on."): LoopTurn =>
  async (call) => {
    const own = await turn(call);
    await call.host.say(words);
    return own;
  };

/** A turn that claims the goal is reached, naming a file of the folder as proof. */
const finishes: LoopTurn = async ({ tool }) => {
  await tool("finish", { review: "yes", summary: "The level is built and the door opens.", proof: "project.godot" });
  return undefined;
};

/** The indexes of a method's calls on the recorder, in order. */
function callsOf(host: LoopHost, method: string, where: (params: Record<string, unknown>) => boolean = () => true) {
  return host.rec.calls.flatMap((call, i) => (call.method === method && where(call.params) ? [i] : []));
}

/** The journal the Loop keeps, as its artifact holds it. */
function journalOf(host: LoopHost) {
  return host.artifacts.get(`autopilot_${host.run.runId}`) as {
    director: {
      open: {
        savePoints: Array<{ label: string; snapshotId: string; auto: boolean; notes: string[] }>;
        crashes: number;
      };
    };
  };
}

/** The lead's tool names on its first turn. */
const toolNamesOf = (host: LoopHost): string[] =>
  (
    ((host.leadCalls()[0]?.director as { tools?: Array<{ name: string }> } | undefined)?.tools ?? []).map(
      (tool) => tool.name,
    ) as string[]
  ).sort();

/** A turn that keeps one save point, "One". */
const savesOne: LoopTurn = async ({ tool }) => {
  await tool("save_point", { label: "One", summary: "the first room" });
  return undefined;
};

/** The first lead delegation's place among the recorder's calls. */
const firstLeadTurn = (host: LoopHost): number =>
  host.rec.calls.findIndex(
    (call) => call.method === "engine.delegate" && Boolean(call.params.director) && !call.params.reviewer,
  );

describe("the one Loop's start", () => {
  it("is led in place by the chat's own session", TEST_TIMEOUT, async () => {
    const host = await hostOn(Project.GodotGame, { facts: GODOT, turns: [finishes] });
    await host.start();
    const [first] = host.leadCalls();
    assert.ok(first, "the lead had a turn");
    assert.equal(first.resume, CHAT_SESSION);
    const director = first.director as Record<string, unknown>;
    // Flipped: the grant also said `inPlace: true`; its root alone, the game folder, places it now.
    assert.equal("inPlace" in director, false);
    assert.equal(director.root, host.dir);
    assert.equal(first.cwd, undefined);
    assert.equal(first.readOnly, undefined);
    for (const method of ["snapshot.worktree", "preview.load", "game.scaffold"])
      assert.ok(!host.trail().includes(method), `no ${method}`);
  });

  // Flipped: the first message was a brief of 2–3K characters (Genex's identity, YOU LEAD THIS LOOP,
  // THE GOAL, THE PROJECT holds, WORKERS, SAVE POINTS, FINISH, HOW THIS LOOP WORKS…) restating the
  // tools; the chat's session already holds the person's words, and its tools say what they do.
  it("its first message is one Genex line: the Loop started, with its goal", TEST_TIMEOUT, async () => {
    const host = await hostOn(Project.GodotGame, { facts: GODOT, turns: [finishes] });
    await host.start();
    const [first] = host.leadCalls();
    // Flipped (SC-4): the goal's line carries its bounds (LOOP_WORDS.started).
    assert.equal(first?.prompt, LOOP_WORDS.started(String(host.run.goal)));
    assert.equal(first?.from, "genex", "Genex's line: the goal is the chat agent's own words, not the person's");
    assert.equal(first?.notices, undefined);
    assert.match(String(first?.system), /You are working inside Genex/, "Genex's context is the system text, once");
  });

  it(
    "snapshots the folder before the first turn, and fires the project's start moment only when a plugin hooks it",
    TEST_TIMEOUT,
    async () => {
      const godot = await hostOn(Project.GodotGame, { facts: GODOT, turns: [finishes] });
      await godot.start();
      const [snapshot] = callsOf(godot, "snapshot.create", (p) => /before the Loop/.test(String(p.reason)));
      assert.ok(snapshot !== undefined && snapshot < firstLeadTurn(godot), "the snapshot came before the first turn");
      assert.deepEqual(callsOf(godot, "hooks.fire"), [], "a project no plugin hooks hears no moment");
      const [started] = godot.appended("run_started");
      assert.equal((started?.budgets as Record<string, unknown> | undefined)?.creditCap, 600);
      assert.equal(godot.appended("autopilot_started")[0]?.profile, "open");

      const toy = await hostOn(Project.ToyProject, { facts: TOY, manifest: TOY_MANIFEST, turns: [finishes] });
      await toy.start();
      const [prepare] = callsOf(toy, "hooks.fire", (p) => p.on === "run.prepare");
      assert.ok(prepare !== undefined && prepare < firstLeadTurn(toy), "the start moment came before the first turn");
      const trail = toy.trail();
      assert.ok(trail.indexOf("tool:toy-engine__editor-state") < trail.indexOf("engine.delegate"));
    },
  );

  // Flipped: a blocked start closed the Loop before any turn, with the plugin's reason, kept nothing,
  // and its close said `startHeld` so the chat's agent was sent to fix it (core/held-start.ts, gone).
  it(
    "a start step's block is its lead's first line: the Loop runs, and the chat's agent is never sent to fix it",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.ToyProject, { facts: TOY, manifest: TOY_MANIFEST, turns: [finishes] });
      host.stepAnswers.set("editor-state", (hook) =>
        hook.on === "run.prepare" ? { block: "The toy editor didn't open." } : {},
      );
      const report = await host.start();
      const [first, ...more] = host.prompts();
      assert.ok(first?.startsWith("The Loop started."), String(first));
      assert.ok(first?.includes("The toy editor didn't open."), "the step's own words, for the lead");
      assert.equal(more.length, 0, "one turn, and it finished");
      assert.equal(report.victory, true, String(report.stoppedBecause));
      assert.equal(report.startHeld, undefined);
      assert.doesNotMatch(String(report.stoppedBecause), /start the Loop again/);
    },
  );

  it(
    "a start that finds the project's app not answering, or not ready, says so in its lead's first message, and Genex opens nothing",
    TEST_TIMEOUT,
    async () => {
      for (const [answer, words] of [
        [{ block: "The toy editor isn't open." }, /The project's app doesn't answer: The toy editor isn't open\./],
        [
          { pending: "The toy editor is compiling." },
          /The project's app isn't ready yet: The toy editor is compiling\./,
        ],
      ] as const) {
        const host = await hostOn(Project.ToyProject, { facts: TOY, manifest: TOY_MANIFEST, turns: [finishes] });
        let looks = 0;
        host.stepAnswers.set("editor-state", (hook) => {
          if (hook.on !== "health") return {};
          looks += 1;
          return looks === 1 ? answer : {};
        });
        const report = await host.start();
        const [look] = callsOf(host, "hooks.fire", (p) => p.on === "health");
        assert.ok(look !== undefined && look < firstLeadTurn(host), "one look at the app before the first turn");
        assert.match(String(host.prompts()[0]), words);
        assert.ok(!host.trail().includes("tool:toy-engine__reopen-editor"), "nothing reopened the app");
        assert.equal(report.victory, true, String(report.stoppedBecause));
      }
    },
  );

  // Flipped: the brief named the folder's kind ("THE PROJECT holds: godot-project at the folder's
  // root"); the chat's own session knows its project, and the first message is Genex's one line.
  it("its first message and its tools name none of the web method", TEST_TIMEOUT, async () => {
    const host = await hostOn(Project.GodotGame, { facts: GODOT, turns: [finishes] });
    await host.start();
    const [brief] = host.prompts();
    for (const web of [/Unreal/, /three\.js/i, /index\.html/, /integration/i, /worktree/i])
      assert.doesNotMatch(String(brief), web);
    const director = host.leadCalls()[0]?.director as
      | { tools?: Array<{ name: string; description: string }> }
      | undefined;
    const tools = director?.tools;
    assert.ok(tools?.length, "the lead was offered its tools");
    for (const tool of tools ?? []) assert.doesNotMatch(tool.description, /integration|board/i, tool.name);
  });

  // Flipped: the brief, and a fresh session's replay of it, opened with Genex's identity; it is the
  // session's system text now, the same on every turn, and a fresh session is told how its Loop began.
  it("its first turn, and a fresh session's, run inside Genex: the system text says so", TEST_TIMEOUT, async () => {
    const overflows: LoopTurn = () => {
      throw Object.assign(new Error("the context is full"), { kind: "context_overflow" });
    };
    const worksOn: LoopTurn = async ({ host }) => {
      await writeFile(path.join(host.dir, "room.txt"), "a room\n");
      return undefined;
    };
    const host = await hostOn(Project.GodotGame, {
      facts: GODOT,
      turns: [thenThePersonSays(worksOn), overflows, finishes],
    });
    await host.start();
    const calls = host.leadCalls();
    const fresh = calls.findIndex((call, i) => i > 0 && call.resume === undefined);
    assert.ok(fresh > 0, "a later turn opened a fresh session");
    for (const call of [calls[0], calls[fresh]]) {
      assert.match(String(call?.system), /You are working inside Genex, the desktop app this chat runs in/);
      assert.match(String(call?.system), /never start a server/);
    }
    assert.equal(calls[fresh]?.prompt, calls[fresh - 1]?.prompt, "the turn's own message, never a replay");
    const [lost] = (calls[fresh]?.notices as string[] | undefined) ?? [];
    assert.match(
      String(lost),
      /^Your earlier session was lost \(its context was full\); this session is new\.\nThe Loop started\./,
    );
  });

  // Flipped: the brief said so ("SAVING: … save inside the app first"); save_point's description does.
  it(
    "a project whose app no plugin saves is told by save_point that it keeps only the files on disk",
    TEST_TIMEOUT,
    async () => {
      const savePointOf = (host: LoopHost) =>
        (
          host.leadCalls()[0]?.director as { tools?: Array<{ name: string; description: string }> } | undefined
        )?.tools?.find((tool) => tool.name === "save_point")?.description;
      const unreal = await hostOn(Project.UnrealGame, { facts: UNREAL, turns: [finishes] });
      await unreal.start();
      assert.match(String(savePointOf(unreal)), /save inside the app first/i);
      const toy = await hostOn(Project.ToyProject, { facts: TOY, manifest: TOY_MANIFEST, turns: [finishes] });
      await toy.start();
      assert.doesNotMatch(String(savePointOf(toy)), /save inside the app first/i);
    },
  );

  it("offers the open tools", TEST_TIMEOUT, async () => {
    const host = await hostOn(Project.ToyProject, {
      facts: TOY,
      manifest: TOY_MANIFEST,
      workerTypes: [SCENE],
      turns: [finishes],
    });
    await host.start();
    const director = host.leadCalls()[0]?.director as
      | { tools?: Array<{ name: string; description: string }> }
      | undefined;
    const tools = director?.tools ?? [];
    assert.deepEqual(tools.map((tool) => tool.name).sort(), OPEN_TOOLS);
    const start = tools.find((tool) => tool.name === "worker_start");
    assert.match(String(start?.description), /scene \(Edits one scene\)/);
  });
});

describe("the one Loop's workers", () => {
  it(
    "its workers come from the run pool with the run's grant, and a writer's copy is merged into the game folder",
    TEST_TIMEOUT,
    async () => {
      const answers: string[] = [];
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        turns: [
          async ({ tool }) => {
            for (const title of ["Door", "Key"])
              answers.push(
                String(await tool("worker_start", { title, task: `Add the ${title} scene`, isolation: "copy" })),
              );
            return undefined;
          },
          async ({ tool, host }) => {
            // Woken by the first worker's end, the lead waits for the other within its turn.
            for (const id of ["w1", "w2"]) await tool("worker_wait", { id, seconds: "60" });
            // The lead's own edit of the key scene, not committed yet.
            await writeFile(path.join(host.dir, "scenes", "key.tscn"), "the lead's key\n");
            answers.push(String(await tool("worker_mark", { id: "w2", verdict: "used" })));
            answers.push(String(await tool("worker_mark", { id: "w1", verdict: "used" })));
            await tool("finish", { review: "yes", summary: "The door is in.", proof: "scenes/door.tscn" });
            return undefined;
          },
        ],
      });
      const done = host.start();
      assert.ok(await host.until(() => host.workers.length === 2), "both workers started");
      const [door, key] = host.workers;
      await door?.end({ files: { "scenes/door.tscn": "a door\n" } });
      await key?.end({ files: { "scenes/key.tscn": "the worker's key\n" } });
      await done;
      assert.match(String(answers[0]), /Started w1/);
      for (const session of host.workers) {
        const grant = session.params.worker as Record<string, unknown>;
        assert.equal(grant.runId, host.run.runId);
        assert.equal(session.params.creditCap, 600);
        assert.notEqual(session.params.cwd, host.dir, "a writer works in its own copy");
      }
      assert.ok(host.trail().includes("snapshot.worktree"), "the copies are Genex's");
      assert.match(
        String(answers[2]),
        /scenes\/key\.tscn/,
        "the merge over the lead's edit is refused, naming the file",
      );
      assert.equal(await readFile(path.join(host.dir, "scenes", "key.tscn"), "utf8"), "the lead's key\n");
      assert.equal(await readFile(path.join(host.dir, "scenes", "door.tscn"), "utf8"), "a door\n");
    },
  );

  it("a worker's end wakes the resting lead", TEST_TIMEOUT, async () => {
    const host = await hostOn(Project.GodotGame, {
      facts: GODOT,
      turns: [
        async ({ tool }) => {
          await tool("worker_start", { title: "Survey", task: "Read the scenes and list them", isolation: "read" });
          return undefined;
        },
        finishes,
      ],
    });
    const done = host.start();
    assert.ok(await host.until(() => host.workers.length === 1), "the worker started");
    // The lead rests once its first turn is over: the wake loop's state is on the journal then.
    const resting = () => Boolean((journalOf(host)?.director as { wake?: unknown } | undefined)?.wake);
    assert.ok(await host.until(() => resting() && host.prompts().length === 1), "the lead rests after its first turn");
    await host.workers[0]?.end({ summary: "three scenes" });
    await done;
    assert.equal(host.prompts().length, 2);
    // Flipped: the end was wrapped ("Genex woke you: a worker ended.", "WHAT HAPPENED:", "… says what
    // it found.", "Act on it…") and the wake recorded as `director_continued`; now it is the one line.
    assert.equal(host.prompts()[1], 'worker w1 "Survey" ended: done.');
    assert.equal(host.leadCalls()[1]?.from, "genex", "Genex's line, never the person's");
    assert.deepEqual(host.appended("director_continued"), []);
  });

  it("news reaches a working turn once, through one channel, and is not said again", TEST_TIMEOUT, async () => {
    const host = await hostOn(Project.GodotGame, {
      facts: GODOT,
      threadId: "t-news-once",
      turns: [
        async ({ tool, host }) => {
          await tool("worker_start", { title: "Survey", task: "Read the scenes and list them", isolation: "read" });
          await tool("worker_start", { title: "Count", task: "Count the scenes", isolation: "read" });
          await host.workers[0]?.end({ summary: "three scenes" });
          await host.workers[1]?.end({ ok: false, summary: "no scenes folder" });
          assert.ok(await host.until(() => host.steered.length === 2), "both said into the turn");
          return undefined;
        },
        finishes,
      ],
    });
    host.steerTakes = true;
    const report = await host.start();
    const runId = String(host.run.runId);
    assert.deepEqual(
      host.steered.map(({ text, interrupt, ...rest }) => ({
        text,
        interrupt,
        from: (rest as { from?: unknown }).from,
      })),
      [
        { text: 'worker w1 "Survey" ended: done.', interrupt: false, from: "genex" },
        { text: 'worker w2 "Count" ended: failed.', interrupt: false, from: "genex" },
      ],
    );
    for (const one of host.steered) assert.match(one.id, new RegExp(`^${runId}:1:news-\\d+$`));
    assert.equal(host.prompts().length, 1, "read in its turn: nothing woke the lead for them after it");
    assert.equal(report.victory, false, "the Loop closed when that turn ended with nothing at work");
  });
});

describe("the one Loop's end", () => {
  it(
    "finish runs the finish moment, then asks the reviewer; a yes closes the Loop in place: workers settled, the last work kept, run.end fired, the report and journal written",
    TEST_TIMEOUT,
    async () => {
      const answers: string[] = [];
      const host = await hostOn(Project.ToyProject, {
        facts: TOY,
        manifest: TOY_WITH_FINISH,
        turns: [
          async ({ tool, host }) => {
            await writeFile(path.join(host.dir, "scenes", "hall.toyscene"), "a hall\n");
            await tool("worker_start", { title: "Survey", task: "Read the scenes", isolation: "read" });
            answers.push(
              String(
                await tool("finish", { review: "yes", summary: "The hall is built.", proof: "scenes/hall.toyscene" }),
              ),
            );
            return undefined;
          },
        ],
      });
      const report = await host.start();
      assert.match(String(answers[0]), /Accepted/);
      assert.equal(report.victory, true);
      assert.equal(report.profile, "open");
      assert.equal(host.appended("run_finished").length, 1);
      const steps = host.appended("finish_check").map((check) => check.step);
      assert.ok(steps.includes("accepted"), `the reviewer's yes is recorded (${steps.join(", ")})`);
      const [finishMoment] = callsOf(host, "hooks.fire", (p) => p.on === "finish");
      const [reviewer] = callsOf(host, "finish.review");
      assert.ok(finishMoment !== undefined && reviewer !== undefined && finishMoment < reviewer);
      const lastCheckpoint = callsOf(host, "checkpoint.take").at(-1);
      const [runEnd] = callsOf(host, "hooks.fire", (p) => p.on === "run.end");
      assert.ok(lastCheckpoint !== undefined && runEnd !== undefined && lastCheckpoint < runEnd);
      const ended = host.appended("worker_finished").find((end) => end.state === "stopped");
      assert.ok(ended, "the worker still at work was stopped");
      assert.ok(host.rec.paramsOf("run.artifact").some((p) => p.name === "report.json"));
      assert.deepEqual(callsOf(host, "snapshot.removeWorktree"), [], "nothing of a copy is landed or removed");
      const journal = host.artifacts.get(`autopilot_${host.run.runId}`) as Record<string, Record<string, unknown>>;
      assert.ok(journal.director?.open, "the journal keeps the open Loop's own record");
    },
  );
});

describe("the one Loop's stop, pause and resume", () => {
  it(
    "a stop pauses it for a Resume, a usage cap pauses it, and a resume goes on with the save points it kept",
    TEST_TIMEOUT,
    async () => {
      const stopped = await hostOn(Project.GodotGame, {
        facts: GODOT,
        turns: [
          ({ host }) => {
            host.rec.cancel();
            return undefined;
          },
        ],
      });
      const stop = await stopped.start();
      assert.equal(stop.stoppedBecause, "stopped by the user");
      assert.equal(stop.executionStatus, "paused", "a Stop pauses the Loop: Resume goes on from the folder");
      assert.equal(stopped.appended("autopilot_paused").length, 1);
      assert.equal(stopped.appended("run_finished").length, 1);
      assert.equal(stopped.reviewed().length, 0);

      // The Loop keeps one save point, then meets its usage cap.
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        turns: [
          async ({ host, tool }) => {
            await tool("save_point", { label: "One", summary: "the first room" });
            host.pass(40 * MINUTE);
            throw Object.assign(new Error("You've reached your usage limit."), { kind: "usage_limit" });
          },
        ],
      });
      const paused = await host.start();
      assert.equal(paused.executionStatus, "paused");
      // Its save point is in the folder, yet nothing is "live" while it is paused: every surface agrees.
      assert.equal(host.appended("run_finished")[0]?.landed, false);
      assert.equal(host.appended("autopilot_paused").length, 1);
      const id = `autopilot_${host.run.runId}`;
      // Flipped (no clock): the journal kept the Loop's clock and worked time; it keeps none.
      assert.equal((host.artifacts.get(id) as { director: { clock?: unknown } }).director.clock, undefined);
      forgetProviderLosses(host.run.runId);
      host.turns.push(({ host }) => {
        host.rec.cancel();
        return undefined;
      });
      host.reviews.push(reviewerAnswer("yes"));
      host.rec.ctx.cancelled = false;
      await host.start({ resume: true });
      const resumed = host.prompts().at(-1) ?? "";
      // Flipped: the resumed brief named its save points; Genex's one line says it resumed, and
      // run_status answers the save points it kept (below: the journal's).
      // Flipped (SC-4): the goal's line carries its bounds (LOOP_WORDS.resumed).
      assert.equal(resumed, LOOP_WORDS.resumed(String(host.run.goal)));
      assert.doesNotMatch(resumed, /working time/, "no time left is named");
      const journal = host.artifacts.get(id) as { director: { open: { savePoints: Array<{ label: string }> } } };
      assert.deepEqual(
        journal.director.open.savePoints.map((point) => point.label),
        ["One"],
      );
    },
  );

  it("the observers and the reviewer fit inside the finish call with the open close", () => {
    assert.ok(FINISH_OBSERVE_MS + FINISH_REVIEW_MS + OPEN_CLOSE_MS + CALL_MARGIN_MS <= LEAD_CALL_MS);
  });
});

describe("the one Loop's turns", () => {
  // Flipped: "its first message leaves the stop rule to wrap_up's own description, and promises no
  // news mid-turn" read the rules in the brief; the first message has none ("its first message is one
  // Genex line").
  it("tools now include save_point and rewind, and restart only when hooked", TEST_TIMEOUT, async () => {
    const godot = await hostOn(Project.GodotGame, { facts: GODOT, turns: [finishes] });
    await godot.start();
    assert.deepEqual(
      toolNamesOf(godot),
      OPEN_TOOLS.filter((name) => name !== "restart"),
    );
    const toy = await hostOn(Project.ToyProject, { facts: TOY, manifest: TOY_MANIFEST, turns: [finishes] });
    await toy.start();
    assert.deepEqual(toolNamesOf(toy), OPEN_TOOLS);
  });

  it(
    "what a turn.start step found is a line of the lead's turn, its block too: every turn runs, and each turn's end is fired",
    TEST_TIMEOUT,
    async () => {
      const LOCKED = "The toy editor's scene is locked by another tool.";
      const manifest = {
        ...TOY_MANIFEST,
        hooks: [
          ...(TOY_MANIFEST.hooks ?? []),
          { on: "turn.start", tool: "capture" },
          { on: "turn.end", tool: "capture" },
        ],
      } as LoopManifest;
      const host = await hostOn(Project.ToyProject, {
        facts: TOY,
        manifest,
        turns: [thenThePersonSays(async () => undefined), finishes],
      });
      host.stepAnswers.set("capture", (hook) => (hook.on === "turn.start" ? { block: LOCKED } : {}));
      const report = await host.start();
      assert.equal(host.leadCalls().length, 2, "both turns ran");
      assert.match(String(host.prompts()[0]), /^The Loop started\.[\s\S]*The toy editor's scene is locked/);
      assert.equal(host.prompts()[1], "Go on.");
      assert.ok(
        (host.leadCalls()[1]?.notices as string[] | undefined)?.some((notice) => notice.includes(LOCKED)),
        "the next turn's own start says it beside the person's words",
      );
      const ends = host.rec.paramsOf("hooks.fire").filter((params) => params.on === "turn.end");
      assert.equal(ends.length, 2, "each turn's end");
      assert.equal(report.victory, true, String(report.stoppedBecause));
    },
  );
});

describe("the one Loop's save points", () => {
  it(
    "save_point takes Genex's checkpoint: the plugin's steps, a snapshot, its notes and pictures",
    TEST_TIMEOUT,
    async () => {
      const answers: string[] = [];
      const host = await hostOn(Project.ToyProject, {
        facts: TOY,
        manifest: TOY_MANIFEST,
        turns: [
          async ({ tool }) => {
            answers.push(String(await tool("save_point", { label: "One", summary: "the first room" })));
            return undefined;
          },
          finishes,
        ],
      });
      host.stepAnswers.set("save-scenes", () => ({ note: "Saved 2 scenes." }));
      host.stepAnswers.set("capture", () => ({ images: [PICTURE] }));
      await host.start();
      assert.match(String(answers[0]), /One/);
      assert.match(String(answers[0]), /Saved 2 scenes\./);
      const trail = host.trail();
      const saved = trail.indexOf("tool:toy-engine__save-scenes");
      const snapshot = trail.indexOf("snapshot.create", saved);
      const captured = trail.indexOf("tool:toy-engine__capture", snapshot);
      assert.ok(saved >= 0 && snapshot > saved && captured > snapshot, "the plugin's steps around the snapshot");
      const kept = host
        .appended("observer_capture")
        .filter((c) => c.source === "checkpoint" && /One/.test(String(c.label)));
      assert.equal(kept.length, 1, "the save point's pictures are one capture (the host's), never recorded twice");
      const [point] = journalOf(host).director.open.savePoints;
      assert.equal(point?.label, "One");
      assert.equal(point?.auto, false);
      assert.deepEqual(point?.notes, ["Saved 2 scenes."]);
      const round = host.appended("facet_iteration").find((r) => r.label === "One");
      assert.equal(round?.facetId, "lead");
      assert.equal(round?.snapshot, point?.snapshotId);
      assert.equal((round?.shots as unknown[] | undefined)?.length, 1, "its picture is the round's thumbnail");
      assert.ok(host.appended("director_worker").some((row) => row.workerId === "lead" && row.state === "running"));
    },
  );

  // Flipped: a step's block at the checkpoint kept nothing ("nothing was kept"); it is a note the save
  // point keeps, and only Plan mode keeps nothing.
  it(
    "a save point a step blocks is kept with the step's words; one in a planning chat keeps nothing and says why",
    TEST_TIMEOUT,
    async () => {
      const answers: string[] = [];
      const host = await hostOn(Project.ToyProject, {
        facts: TOY,
        manifest: TOY_MANIFEST,
        turns: [
          async ({ tool, host }) => {
            answers.push(String(await tool("save_point", { label: "One", summary: "the first room" })));
            host.planning = true;
            answers.push(String(await tool("save_point", { label: "Two", summary: "the second room" })));
            host.planning = false;
            return undefined;
          },
          finishes,
        ],
      });
      host.stepAnswers.set("save-scenes", (hook) =>
        hook.label === "One" ? { block: "A play session is running in the toy editor." } : {},
      );
      await host.start();
      assert.match(String(answers[0]), /^Saved save point "One"/);
      assert.match(String(answers[0]), /A play session is running in the toy editor\./);
      assert.match(String(answers[1]), /Plan mode/);
      assert.match(String(answers[1]), /nothing was kept/i);
      const labels = journalOf(host).director.open.savePoints.map((point) => point.label);
      assert.ok(labels.includes("One"), "the blocked step's save point is kept");
      assert.ok(!labels.includes("Two"), "the planning chat's is not");
      const rounds = host.appended("facet_iteration").map((round) => round.label);
      assert.ok(rounds.includes("One") && !rounds.includes("Two"), rounds.join(", "));
    },
  );
});

describe("the one Loop's rewinds and restarts", () => {
  it(
    "a rewind goes back when the turn ends, through Genex's restore, and waits until the project's app answers",
    TEST_TIMEOUT,
    async () => {
      const answers: string[] = [];
      let restoredInTurn = true;
      let healthAfter = 0;
      const host = await hostOn(Project.ToyProject, {
        facts: TOY,
        manifest: TOY_MANIFEST,
        turns: [
          async ({ tool, host }) => {
            await tool("save_point", { label: "One", summary: "the first room" });
            answers.push(String(await tool("rewind", { label: "One" })));
            answers.push(String(await tool("rewind", { label: "Nowhere" })));
            restoredInTurn = host.trail().includes("snapshot.restore");
            return undefined;
          },
          finishes,
        ],
      });
      host.stepAnswers.set("editor-state", (hook) => {
        if (hook.on !== "health" || !host.trail().includes("snapshot.restore")) return {};
        healthAfter += 1;
        return healthAfter === 1 ? { pending: "The toy editor is reopening." } : {};
      });
      await host.start();
      assert.match(String(answers[0]), /when this turn ends/);
      assert.match(String(answers[1]), /Nowhere/);
      assert.match(String(answers[1]), /One/, "an unknown label answers the labels there are");
      assert.equal(restoredInTurn, false, "nothing is restored under a running turn");
      const [restore, ...more] = host.rec.paramsOf("snapshot.restore");
      assert.equal(more.length, 0);
      assert.equal(restore?.snapshotId, journalOf(host).director.open.savePoints[0]?.snapshotId);
      assert.equal(restore?.runId, host.run.runId);
      const trail = host.trail();
      assert.ok(trail.indexOf("tool:toy-engine__reload-scenes") > trail.indexOf("snapshot.restore"));
      assert.ok(healthAfter >= 2, "Genex asked again until the app answered");
      assert.match(String(host.prompts()[1]), /back to save point "One"/);
    },
  );

  it(
    "restart is offered only to a project whose plugin restarts its app, and changes no files",
    TEST_TIMEOUT,
    async () => {
      const answers: string[] = [];
      let restartedInTurn = true;
      const host = await hostOn(Project.ToyProject, {
        facts: TOY,
        manifest: TOY_MANIFEST,
        turns: [
          async ({ tool, host }) => {
            answers.push(String(await tool("restart", { why: "the scenes changed" })));
            restartedInTurn = host.trail().includes("tool:toy-engine__reload-scenes");
            return undefined;
          },
          finishes,
        ],
      });
      const tree = await host.git("rev-parse", "HEAD^{tree}");
      await host.start();
      assert.match(String(answers[0]), /when this turn ends/);
      assert.equal(restartedInTurn, false);
      assert.ok(host.trail().includes("tool:toy-engine__reload-scenes"), "the plugin's restore steps ran");
      assert.deepEqual(host.rec.paramsOf("snapshot.restore"), [], "no file was restored");
      // Genex's snapshots commit (an empty one too); the files are the same.
      assert.equal(await host.git("rev-parse", "HEAD^{tree}"), tree);
      assert.equal(await host.git("status", "--porcelain"), "");
      assert.match(String(host.prompts()[1]), /restarted the project's app/);

      const unreal = await hostOn(Project.UnrealGame, { facts: UNREAL, manifest: UNREAL_MANIFEST, turns: [finishes] });
      await unreal.start();
      assert.ok(toolNamesOf(unreal).includes("restart"));
      // Flipped: the brief said "After changing the game's C++ source, call restart: it rebuilds."; restart's description says it.
      const restartOf = (host: LoopHost) =>
        (
          host.leadCalls()[0]?.director as { tools?: Array<{ name: string; description: string }> } | undefined
        )?.tools?.find((tool) => tool.name === "restart")?.description;
      assert.match(String(restartOf(unreal)), /rebuilds the game's C\+\+ source/i);
      const godot = await hostOn(Project.GodotGame, { facts: GODOT, turns: [finishes] });
      await godot.start();
      assert.ok(!toolNamesOf(godot).includes("restart"));
      assert.doesNotMatch(String(godot.prompts()[0]), /restart/);
    },
  );
});

describe("the one Loop's autosaves", () => {
  it(
    "between turns Genex keeps what the lead left: only if unsaved where a plugin saves, and only if the folder changed where none does",
    TEST_TIMEOUT,
    async () => {
      const autosaves = (host: LoopHost) =>
        host.rec.paramsOf("checkpoint.take").filter((params) => params.label === "Autosave");
      const changed = await hostOn(Project.GodotGame, {
        facts: GODOT,
        turns: [
          thenThePersonSays(async ({ host }) => {
            await writeFile(path.join(host.dir, "notes.txt"), "the lead's notes\n");
            return undefined;
          }),
          finishes,
        ],
      });
      await changed.start();
      const [kept, ...again] = autosaves(changed);
      assert.ok(kept, "a folder the lead changed is kept");
      assert.equal(kept.onlyIfUnsaved, undefined);
      assert.equal(again.length, 0);
      assert.equal(journalOf(changed).director.open.savePoints[0]?.auto, true);
      // Flipped: it rode the next digest under FROM GENEX; it is Genex's line beside the person's words.
      assert.equal(changed.prompts()[1], "Go on.");
      // Flipped (CA4): the person's words that open the turn now come after Genex's line that they wait.
      assert.deepEqual(changed.leadCalls()[1]?.notices, [
        'Your turn ended with unsaved work, so Genex saved it as save point "Autosave".',
        LOOP_WORDS.personWaits,
      ]);

      const clean = await hostOn(Project.GodotGame, { facts: GODOT, turns: [async () => undefined, finishes] });
      await clean.start();
      assert.deepEqual(clean.rec.paramsOf("checkpoint.take"), [], "a clean folder no plugin saves is left alone");

      const toy = await hostOn(Project.ToyProject, {
        facts: TOY,
        manifest: TOY_MANIFEST,
        turns: [async () => undefined, finishes],
      });
      await toy.start();
      assert.equal(autosaves(toy)[0]?.onlyIfUnsaved, true, "where a plugin saves, only what is unsaved");

      const saved = await hostOn(Project.ToyProject, {
        facts: TOY,
        manifest: TOY_MANIFEST,
        turns: [savesOne, finishes],
      });
      await saved.start();
      assert.deepEqual(autosaves(saved), [], "a turn that kept a save point is not autosaved");
    },
  );
});

/** A toy Loop whose app stops when `broken` says so; `reopens` counts its crash steps, which nobody should run. */
async function stoppingToy(turns: LoopTurn[]) {
  const state = { broken: false, reopens: 0 };
  const host = await hostOn(Project.ToyProject, { facts: TOY, manifest: TOY_MANIFEST, turns });
  host.stepAnswers.set("editor-state", (hook) =>
    hook.on === "health" && state.broken ? { block: "The toy editor stopped." } : {},
  );
  host.stepAnswers.set("reopen-editor", () => {
    state.reopens += 1;
    return {};
  });
  return { host, state };
}

/** What the lead reads when the toy's app stops. */
const TOY_STOPPED = APP_NEWS.notAnswering("The toy editor stopped.");

/** How many times Genex asked the project's app whether it is well. */
const healthLooks = (host: LoopHost): number =>
  host.rec.paramsOf("hooks.fire").filter((params) => params.on === "health").length;

describe("the one Loop's health watch", () => {
  // Flipped: Genex ran the crash steps, waited until the app answered and told the lead what may be
  // lost ("Genex is bringing it back"); the watch only tells the lead, once each way.
  it(
    "a stopped app is a health block: the lead hears its plugin's reason once, in its turn, and Genex runs no crash step; once it answers again, the lead hears that too",
    TEST_TIMEOUT,
    async () => {
      let status: Record<string, unknown> = {};
      const toy = await stoppingToy([
        async ({ tool, host }) => {
          await tool("save_point", { label: "One", summary: "the first room" });
          toy.state.broken = true;
          assert.ok(await host.until(() => host.steered.some((s) => s.text === TOY_STOPPED)), "the lead was told");
          // More looks find it still stopped: nothing more is said.
          const seen = healthLooks(host);
          assert.ok(await host.until(() => healthLooks(host) >= seen + 3), "the watch looked again");
          toy.state.broken = false;
          const back = () => host.steered.some((s) => s.text === OPEN_NEWS.appAnswers);
          assert.ok(await host.until(back), "the lead was told it answers again");
          return undefined;
        },
        async (call) => {
          status = JSON.parse(String(await call.tool("run_status")));
          return finishes(call);
        },
      ]);
      const { host, state } = toy;
      const report = await host.start();
      assert.equal(state.reopens, 0, "no crash step ran");
      assert.deepEqual(
        host.rec.paramsOf("hooks.fire").filter((params) => params.on === "crash"),
        [],
        "no crash moment was fired",
      );
      assert.deepEqual(host.rec.paramsOf("snapshot.restore"), [], "nothing went back");
      assert.deepEqual(host.rec.paramsOf("engine.abort"), [], "the lead's turn was never cut");
      assert.equal(host.steered.find((s) => s.text === TOY_STOPPED)?.interrupt, false, "into its turn");
      // The lines the turn did not take wake the lead: one for the stop, one for the app back, each once.
      assert.equal(host.prompts()[1], `${TOY_STOPPED}\n${OPEN_NEWS.appAnswers}`);
      assert.equal(host.leadCalls()[1]?.from, "genex");
      assert.equal(journalOf(host).director.open.crashes, 1, "the journal counts the stop the watch saw");
      assert.equal(status.crashes, 1, "and run_status answers it");
      assert.equal(report.victory, true, String(report.stoppedBecause));
    },
  );

  it(
    "an app the lead's restart left stopped is said once, with the restart: the watch goes on from there and counts no stop of its own",
    TEST_TIMEOUT,
    async () => {
      const toy = await stoppingToy([
        async ({ tool }) => {
          await tool("restart", { why: "the scenes changed" });
          return undefined;
        },
        async (call) => {
          const seen = healthLooks(call.host);
          assert.ok(await call.host.until(() => healthLooks(call.host) >= seen + 2), "the watch looked again");
          return finishes(call);
        },
      ]);
      const { host, state } = toy;
      host.stepAnswers.set("reload-scenes", () => {
        state.broken = true;
        return {};
      });
      const report = await host.start();
      assert.match(String(host.prompts()[1]), /didn't answer again: The toy editor stopped/, "the restart's own line");
      assert.equal(
        host.steered.some((s) => s.text === TOY_STOPPED),
        false,
        "the watch never says it again",
      );
      assert.equal(
        journalOf(host).director.open.crashes,
        0,
        "a stop the lead's own ask left is no crash the watch saw",
      );
      assert.equal(report.victory, true, String(report.stoppedBecause));
    },
  );
});

describe("the one Loop's news", () => {
  it("a project no plugin hooks makes no hooks.fire call but the run's own moments", TEST_TIMEOUT, async () => {
    const host = await hostOn(Project.GodotGame, {
      facts: GODOT,
      turns: [
        async ({ tool, host }) => {
          await writeFile(path.join(host.dir, "notes.txt"), "the lead's notes\n");
          await tool("save_point", { label: "One", summary: "the notes" });
          await tool("rewind", { label: "One" });
          return undefined;
        },
        finishes,
      ],
    });
    await host.start();
    assert.deepEqual(callsOf(host, "hooks.fire"), [], "no health, crash, restore or other moment was asked");
    assert.equal(host.rec.paramsOf("snapshot.restore").length, 1, "the rewind is a plain restore");
    assert.ok(
      host.rec.paramsOf("checkpoint.take").some((p) => p.label === "One"),
      "a save point is a plain checkpoint",
    );
  });
});

/** A turn that starts one reader and returns: its lead rests while the reader works. */
const startsReader: LoopTurn = async ({ tool }) => {
  await tool("worker_start", { title: "Survey", task: "Read the scenes and list them", isolation: "read" });
  return undefined;
};

/** Whether the lead has rested at all: the wake loop's state is on the journal once it first rests. */
const asleep = (host: LoopHost): boolean =>
  Boolean((journalOf(host)?.director as { wake?: unknown } | undefined)?.wake);

/** Whether the lead rests after a turn: the wake loop's state is on the journal then. */
const restsAfter = (host: LoopHost, turns: number) => () =>
  Boolean((journalOf(host)?.director as { wake?: unknown } | undefined)?.wake) && host.prompts().length === turns;

describe("the one Loop's wrap-up", () => {
  // Flipped: the wrap-up said what to claim ("YOUR LAST TURN FAILED, SO THE LOOP WRAPS UP: this is your
  // last turn. Only if the goal is reached, call finish…"); finish's own description says what a claim
  // is, and the wrap-up is Genex's one line.
  it(
    "a failed turn's wrap-up is Genex's one line: the turn failed, and the Loop closes when this one ends",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        turns: [() => ({ ok: false, stopReason: "error" }), () => undefined],
      });
      const report = await host.start();
      assert.equal(host.prompts()[1], "Your last turn failed (error): the Loop closes when this turn ends.");
      assert.equal(host.leadCalls()[1]?.from, "genex");
      assert.equal(host.prompts().length, 2, "the wrap-up is the last turn");
      assert.equal(host.reviewed().length, 0, "no reviewer was asked");
      assert.equal(report.stoppedBecause, OPEN_END.sessionEnded("error"));
      assert.equal(report.victory, false);
    },
  );
});

describe("the one Loop's finish mark", () => {
  it("an open Loop has no art director: no finish mark wakes its lead", TEST_TIMEOUT, async () => {
    const host = await hostOn(Project.GodotGame, { facts: GODOT, turns: [startsReader, finishes] });
    const done = host.start();
    assert.ok(await host.until(() => host.workers.length === 1 && restsAfter(host, 1)()), "the lead rests");
    await host.workers[0]?.end({ summary: "three scenes" });
    await done;
    for (const prompt of host.prompts()) assert.doesNotMatch(prompt, /art director|finish mark/i);
  });
});

describe("the one Loop's watch beside its wake loop", () => {
  it("a slow look at the project's app never holds up the person's words to a resting lead", TEST_TIMEOUT, async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const host = await hostOn(Project.ToyProject, {
      facts: TOY,
      manifest: TOY_MANIFEST,
      turns: [
        startsReader,
        async (call) => {
          release();
          return finishes(call);
        },
      ],
    });
    // The app's health step answers only once the test lets it, while the lead rests. Flipped: the
    // start's own look (before the first turn) was held too; it answers at once.
    let looking = false;
    host.stepAnswers.set("editor-state", async (hook) => {
      if (hook.on !== "health" || !asleep(host)) return {};
      looking = true;
      await held;
      return {};
    });
    const done = host.start();
    assert.ok(
      await host.until(() => host.workers.length === 1 && host.prompts().length === 1 && looking),
      "the lead rests while Genex looks at the app",
    );
    await host.say("Is the door done?");
    const woken = await host.until(() => host.prompts().length === 2);
    release();
    const report = await done;
    assert.ok(woken, "the person's words woke the lead while the look was still under way");
    assert.match(String(host.prompts()[1]), /Is the door done\?/);
    assert.equal(report.victory, true, String(report.stoppedBecause));
  });

  // Flipped: Genex's tries at the lead's turns ran out and the Loop paused in the person's words; the
  // resting lead is woken with the app's reason and decides (here, it finishes).
  it(
    "a lead that rests when its app is lost is woken with the app's reason, never cut, and nothing in the folder is aborted",
    TEST_TIMEOUT,
    async () => {
      const toy = await stoppingToy([startsReader, finishes]);
      const { host, state } = toy;
      const done = host.start();
      assert.ok(await host.until(() => host.workers.length === 1 && restsAfter(host, 1)()), "the lead rests");
      state.broken = true;
      const report = await done;
      assert.match(
        String(host.prompts()[1]),
        /The toy editor stopped/,
        "the resting lead was woken with the app's reason",
      );
      assert.equal(state.reopens, 0, "Genex reopened nothing");
      assert.deepEqual(
        host.rec.paramsOf("engine.abort").filter((params) => params.worker === undefined),
        [],
        "no session in the game folder was aborted",
      );
      assert.equal(report.victory, true, String(report.stoppedBecause));
    },
  );
});

describe("the one Loop's rewinds across turns and pauses", () => {
  it(
    "a rewind goes back to the save point its label named when asked, not an autosave the turn's end takes under it",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        turns: [
          thenThePersonSays(async ({ host }) => {
            await writeFile(path.join(host.dir, "one.txt"), "one\n");
            return undefined;
          }),
          async ({ host, tool }) => {
            await writeFile(path.join(host.dir, "two.txt"), "two\n");
            await tool("rewind", { label: "Autosave" });
            return undefined;
          },
          finishes,
        ],
      });
      await host.start();
      const points = journalOf(host).director.open.savePoints;
      assert.equal(points.filter((point) => point.label === "Autosave").length, 2, "both turns were autosaved");
      const restored = host.rec.paramsOf("snapshot.restore").map((params) => params.snapshotId);
      assert.deepEqual(restored, [points[0]?.snapshotId], "the autosave the label named when the lead asked");
    },
  );

  it("a rewind a Stop cut off is said on Resume, never run over the resumed turn's work", TEST_TIMEOUT, async () => {
    const host = await hostOn(Project.GodotGame, {
      facts: GODOT,
      turns: [
        async ({ host, tool }) => {
          await tool("save_point", { label: "One", summary: "the first room" });
          await writeFile(path.join(host.dir, "two.txt"), "two\n");
          await tool("rewind", { label: "One" });
          host.rec.cancel();
          return undefined;
        },
      ],
    });
    await host.start();
    assert.deepEqual(host.rec.paramsOf("snapshot.restore"), [], "the Stop came before the turn's end");
    host.rec.ctx.cancelled = false;
    host.turns.push(async ({ host }) => {
      await writeFile(path.join(host.dir, "three.txt"), "three\n");
      return undefined;
    }, finishes);
    await host.start({ resume: true });
    assert.deepEqual(host.rec.paramsOf("snapshot.restore"), [], "nothing went back over the resumed work");
    assert.equal(await readFile(path.join(host.dir, "three.txt"), "utf8"), "three\n");
    assert.match(String(host.prompts()[1]), /asked to go back to save point "One"; it paused first/);
  });

  it("a restart a Stop cut off is said on Resume, never run", TEST_TIMEOUT, async () => {
    const host = await hostOn(Project.ToyProject, {
      facts: TOY,
      manifest: TOY_MANIFEST,
      turns: [
        async ({ host, tool }) => {
          await tool("restart", { why: "the scenes changed" });
          host.rec.cancel();
          return undefined;
        },
      ],
    });
    await host.start();
    host.rec.ctx.cancelled = false;
    host.turns.push(finishes);
    await host.start({ resume: true });
    assert.ok(!host.trail().includes("tool:toy-engine__reload-scenes"), "the app was never restarted");
    assert.ok(String(host.prompts()[1]).includes(OPEN_NEWS.restartDropped));
  });
});

describe("the one Loop's news a turn never read", () => {
  it("a line a session took in but never read wakes it after the turn", TEST_TIMEOUT, async () => {
    const host = await hostOn(Project.GodotGame, {
      facts: GODOT,
      threadId: "t-unread",
      turns: [
        async ({ tool, host }) => {
          await tool("worker_start", { title: "Survey", task: "Read the scenes and list them", isolation: "read" });
          await host.workers[0]?.end({ summary: "three scenes" });
          assert.ok(await host.until(() => host.steered.some((s) => /"Survey" ended: done/.test(s.text))), "steered");
          return undefined;
        },
        finishes,
      ],
    });
    host.steerTakes = true;
    host.steerReads = false;
    await host.start();
    assert.equal(host.prompts()[1], 'worker w1 "Survey" ended: done.', "the session never read it");
  });
});

describe("the one Loop's claim whose turn ended", () => {
  it(
    "a reviewer's answer that comes after the claim's turn ended counts as no answer, and the Loop goes on",
    TEST_TIMEOUT,
    async () => {
      let release = (_answer: unknown) => {};
      const late = new Promise((resolve) => {
        release = resolve;
      });
      const answers: string[] = [];
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        turns: [
          thenThePersonSays(async ({ host, tool }) => {
            // The session ends while its claim is checked (its CLI died mid-call): the reviewer is at work.
            void tool("finish", { review: "yes", summary: "The level is built.", proof: "project.godot" });
            await host.until(() => host.reviewed().length > 0);
            return undefined;
          }),
          async ({ host, tool }) => {
            release(reviewerAnswer("yes", ["it holds what was asked"]));
            await host.until(() => host.appended("finish_check").some((check) => check.step !== "checking"));
            answers.push(
              String(await tool("finish", { review: "yes", summary: "The level is built.", proof: "project.godot" })),
            );
            return undefined;
          },
        ],
      });
      host.reviews.push(late as never);
      const report = await host.start();
      const steps = host.appended("finish_check").map((check) => check.step);
      assert.equal(
        steps.find((step) => step !== "checking"),
        "unanswered",
        steps.join(", "),
      );
      assert.match(String(answers[0]), /Accepted/);
      assert.equal(report.victory, true);
    },
  );
});

describe("the lead's tools", () => {
  it("answers a tool call for a run without a lead with a sentence, never a throw", async () => {
    // Flipped (Loop phase 5): the sentence names a lead session, no director.
    assert.match(
      String(await directorTool({ runId: "run_nobody", name: "run_status", args: {} })),
      /no lead session for run run_nobody/,
    );
  });
});

describe("the one Loop's status, notes and fresh look", () => {
  // Flipped (no clock): run_status answered the Loop's time (elapsed, minutes left); it names none.
  it("run_status answers its save points, workers, jobs, facts and crashes", TEST_TIMEOUT, async () => {
    let status: Record<string, any> = {};
    const host = await hostOn(Project.GodotGame, {
      facts: GODOT,
      turns: [
        async ({ host, tool }) => {
          await tool("save_point", { label: "One", summary: "the first room" });
          await tool("worker_start", { title: "Survey", task: "Read the scenes", isolation: "read" });
          host.jobs.push({ id: "j1", title: "Export", role: "lead", command: "godot --export", state: "running" });
          status = JSON.parse(String(await tool("run_status")));
          await tool("finish", { review: "yes", summary: "The level is built.", proof: "project.godot" });
          return undefined;
        },
      ],
    });
    await host.start();
    assert.equal(status.time, undefined);
    assert.deepEqual(
      status.savePoints.map((point: { label: string }) => point.label),
      ["One"],
    );
    assert.match(JSON.stringify(status.workers), /w1/);
    assert.deepEqual(status.jobs, [{ id: "j1", title: "Export", state: "running" }]);
    assert.deepEqual(status.facts, GODOT);
    assert.equal(status.crashes, 0);
  });

  it("a note is a decision kept in the journal", TEST_TIMEOUT, async () => {
    let answer = "";
    const host = await hostOn(Project.GodotGame, {
      facts: GODOT,
      turns: [
        async ({ tool }) => {
          answer = String(await tool("note", { text: "Chose the cave layout over the tower." }));
          await tool("finish", { review: "yes", summary: "The level is built.", proof: "project.godot" });
          return undefined;
        },
      ],
    });
    await host.start();
    assert.equal(answer, "noted");
    const notes = (host.artifacts.get(`autopilot_${host.run.runId}`) as Record<string, any>).director.notes;
    assert.ok(notes.some((note: { text: string }) => note.text === "Chose the cave layout over the tower."));
  });

  it("restart on a project whose plugin restarts no app is no tool of its", TEST_TIMEOUT, async () => {
    let answer = "";
    const host = await hostOn(Project.GodotGame, {
      facts: GODOT,
      turns: [
        async ({ tool }) => {
          answer = String(await tool("restart", { why: "the scenes changed" }));
          return undefined;
        },
        finishes,
      ],
    });
    await host.start();
    assert.equal(answer, "unknown tool: restart");
    assert.deepEqual(callsOf(host, "hooks.fire"), [], "no restore moment ran");
    assert.doesNotMatch(String(host.prompts()[1]), /restarted/);
  });
});

describe("the one Loop's skills and its record", () => {
  // Flipped: "a workspace skill naming the project's kind is named in the lead's brief, and a web skill
  // is not" read the brief's SKILLS line; the lead is the chat's own session, told no list a chat turn
  // isn't (loop-skills.ts went with the brief).
  it(
    "an open Loop's journal names no build of its own: the host reads the game folder for its files",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, { facts: GODOT, turns: [finishes] });
      await host.start();
      const journal = host.artifacts.get(`autopilot_${host.run.runId}`) as Record<string, any>;
      // Flipped (one Loop): it kept `integrationHead: null`; no Loop has an integration head now.
      assert.ok(!("integrationHead" in journal.director));
      assert.equal(typeof journal.director.baseCommit, "string", "its starting point is kept");
    },
  );
});

describe("the one Loop's close inside the lead's call", () => {
  it(
    "a close that outlasts the lead's call is told as closing, never left for the lead to carry on",
    TEST_TIMEOUT,
    async () => {
      const answers: string[] = [];
      const host = await hostOn(Project.ToyProject, {
        facts: TOY,
        manifest: TOY_MANIFEST,
        turns: [
          async ({ tool, host }) => {
            await writeFile(path.join(host.dir, "scenes", "hall.toyscene"), "a hall\n");
            answers.push(
              String(
                await tool("finish", { review: "yes", summary: "The hall is built.", proof: "scenes/hall.toyscene" }),
              ),
            );
            return undefined;
          },
        ],
      });
      // The app's save before the Loop's last checkpoint takes longer than the call has left.
      host.stepAnswers.set("save-scenes", async (hook) => {
        if (hook.label !== "The Loop's end") return {};
        host.pass(LEAD_CALL_MS);
        await delay(CLOSE_STEP_REAL_MS);
        return {};
      });
      const report = await host.start();
      assert.match(String(answers[0]), /^Accepted: the Loop is closing/);
      assert.equal(report.victory, true);
      assert.equal(host.appended("run_finished").length, 1);
    },
  );
});

/** A turn that writes a file in the folder and keeps a save point of it: a turn that worked. */
const keepsRoom =
  (n: number): LoopTurn =>
  async ({ host, tool }) => {
    await writeFile(path.join(host.dir, `room-${n}.txt`), `room ${n}\n`);
    await tool("save_point", { label: `Room ${n}`, summary: `room ${n}` });
    // Flipped (no clock): a turn that changed the folder carried on by itself; now the person's words
    // (sent while it worked) wake the next turn, and a turn that ends with nothing at work pauses the Loop.
    await host.say(`Now room ${n + 1}.`);
    return undefined;
  };

/** The host refusing the lead's session because another chat's turn holds the game folder. */
const folderHeld: LoopTurn = () => {
  throw Object.assign(new Error('a contractor is already building in "godot-game"'), { code: "folder_busy" });
};

describe("the one Loop's turns that fail or wait", () => {
  it(
    "a lead whose folder another chat's turn holds waits until it is free, and never wraps up for it",
    TEST_TIMEOUT,
    async () => {
      const held = Array.from({ length: 8 }, () => folderHeld);
      const host = await hostOn(Project.GodotGame, { facts: GODOT, turns: [keepsRoom(1), ...held, finishes] });
      const report = await host.start();
      for (const prompt of host.prompts()) assert.doesNotMatch(prompt, /this is your last turn/i);
      assert.equal(report.victory, true, String(report.stoppedBecause));
    },
  );

  it("a Stop while the folder is held pauses the Loop, and no lead call follows", TEST_TIMEOUT, async () => {
    let held = 0;
    const host = await hostOn(Project.GodotGame, {
      facts: GODOT,
      turns: [keepsRoom(1)],
    });
    for (let n = 0; n < 400; n += 1)
      host.turns.push((call) => {
        held += 1;
        if (held === 3) call.host.rec.cancel();
        return folderHeld(call);
      });
    const report = await host.start();
    assert.equal(held, 3, "no lead call after the Stop");
    assert.equal(report.executionStatus, "paused");
  });

  it("a Stop during the wait for the folder opens no session after it", TEST_TIMEOUT, async () => {
    let heldAsked = false;
    let stoppedAt = -1;
    const host = await hostOn(Project.GodotGame, {
      facts: GODOT,
      turns: [
        keepsRoom(1),
        (call) => {
          heldAsked = true;
          return folderHeld(call);
        },
        keepsRoom(2),
        finishes,
      ],
    });
    const sleep = host.sleep;
    host.sleep = async (ms: number) => {
      // The person presses Stop while the lead waits for the folder; the next ask would be seated.
      if (heldAsked && stoppedAt < 0 && ms === BUSY_RETRY_MS) {
        stoppedAt = host.leadCalls().length;
        host.rec.cancel();
      }
      return sleep(ms);
    };
    const report = await host.start();
    assert.ok(stoppedAt > 0, "the Stop came during the wait");
    assert.equal(host.leadCalls().length, stoppedAt, "no lead call after the Stop");
    assert.equal(report.executionStatus, "paused");
  });

  // Flipped (no clock): a failed turn could be told apart from one its cap cut; there is no cap.
  it("a turn that fails wraps up in the lead's words", TEST_TIMEOUT, async () => {
    const host = await hostOn(Project.GodotGame, {
      facts: GODOT,
      turns: [keepsRoom(1), () => ({ ok: false, stopReason: "error" })],
    });
    const report = await host.start();
    // Flipped: "… this is your last turn …" and a `director_continued` wake for it; Genex's one line.
    assert.equal(host.prompts()[2], "Your last turn failed (error): the Loop closes when this turn ends.");
    assert.equal(report.stoppedBecause, OPEN_END.sessionEnded("error"));
    assert.doesNotMatch(String(report.stoppedBecause), /director/);
  });

  it("the person's finish with no claim in the last turn closes in the Loop's own words", TEST_TIMEOUT, async () => {
    const host = await hostOn(Project.GodotGame, {
      facts: GODOT,
      turns: [
        ({ host }) => {
          host.inbox.finishing = true;
          return undefined;
        },
      ],
    });
    const report = await host.start();
    assert.equal(host.reviewed().length, 0);
    assert.equal(report.stoppedBecause, OPEN_END.finishAsked);
    assert.doesNotMatch(String(report.stoppedBecause), /director/);
  });
});

describe("the one Loop's app that stops, and its lead's pause", () => {
  // Flipped: Genex told a working lead it was bringing the app back, and never woke a resting one for
  // that line; the app's stop is one line that reaches a working lead and wakes a resting one.
  it(
    "a working lead hears at once that the app doesn't answer, in its turn, and a resting lead is woken for it",
    TEST_TIMEOUT,
    async () => {
      const working = await stoppingToy([
        async ({ host }) => {
          working.state.broken = true;
          assert.ok(await host.until(() => host.steered.some((s) => s.text === TOY_STOPPED)), "told");
          return undefined;
        },
        finishes,
      ]);
      await working.host.start();
      const told = working.host.steered.find((s) => s.text === TOY_STOPPED);
      assert.ok(told, "the lead was told the app doesn't answer");
      assert.equal(told.interrupt, false, "into its turn, never cutting it short");

      const resting = await stoppingToy([startsReader, finishes]);
      const done = resting.host.start();
      assert.ok(await resting.host.until(() => resting.host.workers.length === 1 && restsAfter(resting.host, 1)()));
      resting.state.broken = true;
      const report = await done;
      assert.ok(String(resting.host.prompts()[1]).endsWith(TOY_STOPPED), "the line woke the resting lead");
      assert.equal(report.victory, true, String(report.stoppedBecause));
    },
  );

  // Flipped: Genex paused the Loop while its lead's provider was down (its crash steps held back); only
  // the lead pauses a Loop now, here in the turn its provider's outage ended.
  it("a Loop its lead paused in a turn its provider's outage ended opens no new session", TEST_TIMEOUT, async () => {
    const why = "I need the person to sign in to the toy store.";
    const host = await hostOn(Project.GodotGame, {
      facts: GODOT,
      turns: [
        async ({ tool }) => {
          await tool("pause", { why });
          return { ok: false, stopReason: "error", errorText: "529 overloaded" };
        },
        finishes,
      ],
    });
    host.run.budgets = { ...host.run.budgets, outageDelays: [30 * MINUTE] };
    const report = await host.start();
    assert.equal(host.leadCalls().length, 1, "no session after the pause");
    assert.equal(report.executionStatus, "paused");
    assert.equal(report.stoppedBecause, why, "the lead's own words");
  });
});

describe("the one Loop's crash close", () => {
  it(
    "a first turn that throws closes the Loop in place as failed, its work kept, then the run ends",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.ToyProject, {
        facts: TOY,
        manifest: TOY_MANIFEST,
        turns: [
          async ({ host }) => {
            await writeFile(path.join(host.dir, "room.txt"), "a room\n");
            throw new Error("the engine broke");
          },
        ],
      });
      const report = await host.start();
      assert.equal(report.executionStatus, "failed");
      assert.equal((report.failure as { message?: string } | undefined)?.message, "the engine broke");
      assert.equal(host.appended("run_finished").length, 1);
      assert.ok(report.lastCheckpoint, "the changed folder is kept in the close's checkpoint");
      const finishedAt = host.rec.calls.findIndex(
        (call) =>
          call.method === "events.append" &&
          ((call.params.batch ?? []) as Array<{ event_type?: string }>).some(
            (one) => one.event_type === "run_finished",
          ),
      );
      const endedAt = host.rec.calls.findIndex((call) => call.method === "hooks.fire" && call.params.on === "run.end");
      assert.ok(finishedAt >= 0 && endedAt > finishedAt, `run.end (${endedAt}) after the close (${finishedAt})`);
    },
  );
});

describe("the one Loop's acts once it pauses or closes", () => {
  // Flipped: Genex's own pause (its crash steps held back) ended the session; only the lead's pause does now.
  it(
    "a Loop its lead paused ends its session again until it ends, and refuses its save point and finish",
    TEST_TIMEOUT,
    async () => {
      const answers: unknown[] = [];
      let resent = false;
      const why = "I need the person to pick the door's colour.";
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        turns: [
          async ({ host, tool }) => {
            await tool("pause", { why });
            // The host had not seated this session when Genex first ended it: it goes on working.
            resent = await host.until(() => host.rec.paramsOf("engine.abort").length >= 3);
            answers.push(await tool("save_point", { label: "Late", summary: "after the pause" }));
            answers.push(
              await tool("finish", { review: "yes", summary: "The level is built.", proof: "project.godot" }),
            );
            return { ok: false, stopReason: "aborted" };
          },
        ],
      });
      const report = await host.start();
      assert.ok(resent, "Genex ended the session again while it ran");
      assert.deepEqual(answers, [OPEN_WORDS.paused, OPEN_WORDS.paused]);
      assert.equal(host.reviewed().length, 0);
      assert.equal(report.executionStatus, "paused");
      assert.equal(report.stoppedBecause, why, "the lead's own words");
    },
  );

  it("a claim while the lead's restart waits for its turn's end is not checked yet", TEST_TIMEOUT, async () => {
    const answers: unknown[] = [];
    const host = await hostOn(Project.ToyProject, {
      facts: TOY,
      manifest: TOY_MANIFEST,
      turns: [
        async ({ tool }) => {
          await tool("restart");
          answers.push(await tool("finish", { review: "yes", summary: "The level is built.", proof: "project.godot" }));
          return undefined;
        },
        finishes,
      ],
    });
    const report = await host.start();
    assert.equal(answers[0], OPEN_WORDS.askFirst);
    assert.equal(host.reviewed().length, 1, "only the next turn's claim was checked");
    assert.equal(report.victory, true, String(report.stoppedBecause));
  });

  it("a close that comes before the lead's rewind says it never ran, and forgets it", TEST_TIMEOUT, async () => {
    const host = await hostOn(Project.GodotGame, {
      facts: GODOT,
      turns: [
        async ({ host, tool }) => {
          await tool("save_point", { label: "One", summary: "the first room" });
          await writeFile(path.join(host.dir, "two.txt"), "two\n");
          await tool("rewind", { label: "One" });
          host.inbox.finishing = true;
          await tool("finish", { review: "yes", summary: "The level is built.", proof: "project.godot" });
          return undefined;
        },
      ],
    });
    const report = await host.start();
    assert.equal(report.executionStatus, "completed");
    assert.match(String(report.summary), /didn't run: the Loop closed first/);
    const between = (journalOf(host).director.open as unknown as { between: { rewind: unknown } }).between;
    assert.equal(between.rewind, null);
  });
});

/** A worker that writes in the folder in place, under its lock, started by the lead. */
const startsWriter: LoopTurn = async ({ tool }) => {
  await tool("worker_start", { title: "Bindings", task: "Rework the input bindings", isolation: "lock" });
  return undefined;
};

/** The journal's save points, by label. */
const savePointLabels = (host: LoopHost): string[] =>
  (journalOf(host)?.director.open.savePoints ?? []).map((point) => point.label);

describe("the one Loop's work read from the lead's own acts", () => {
  it(
    "the person's finish reaches a resting lead as its last turn: the Loop closes after that one turn",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, { facts: GODOT, turns: [startsReader, async () => undefined] });
      const done = host.start();
      assert.ok(await host.until(() => host.workers.length === 1 && asleep(host)), "the lead rests");
      host.inbox.finishing = true;
      const report = await done;
      assert.equal(host.prompts().length, 2, "one turn after the request");
      // Flipped: "THE PERSON ASKED THE LOOP TO FINISH: this is your last turn. Call finish…"; Genex's one line.
      assert.equal(host.prompts()[1], "The person asked the Loop to finish: it closes when this turn ends.");
      assert.equal(report.stoppedBecause, OPEN_END.finishAsked);
    },
  );
});

describe("the one Loop's Stop and pause, whenever they come", () => {
  it(
    "a Stop while the lead's session is being seated ends that session at the turn's next look",
    TEST_TIMEOUT,
    async () => {
      let aborted = false;
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        turns: [
          async ({ host }) => {
            // The run's Stop came while the host still seated this session: its one abort missed it.
            host.rec.cancel();
            aborted = await host.until(() => host.rec.paramsOf("engine.abort").some((params) => params.lead));
            return undefined;
          },
        ],
      });
      const report = await host.start();
      assert.ok(aborted, "the lead's session was ended under the Stop");
      assert.equal(report.executionStatus, "paused");
    },
  );

  it("a Stop while the Loop takes its starting point prepares no app for it", TEST_TIMEOUT, async () => {
    const prepared: string[] = [];
    const host = await hostOn(Project.ToyProject, { facts: TOY, manifest: TOY_MANIFEST, turns: [finishes] });
    host.stepAnswers.set("editor-state", (hook) => {
      prepared.push(String(hook.on));
      return {};
    });
    const plain = host.rec.ctx.call.bind(host.rec.ctx);
    host.rec.ctx.call = ((method: string, params?: Record<string, unknown>) => {
      if (method === "snapshot.create") host.rec.cancel();
      return plain(method, params);
    }) as never;
    const report = await host.start();
    assert.deepEqual(
      prepared.filter((on) => on === "run.prepare"),
      [],
      "no plugin opened its app",
    );
    assert.equal(host.leadCalls().length, 0);
    assert.equal(report.executionStatus, "paused");
  });

  it(
    "a Stop during the first turn's wait for the folder keeps nothing and reaches into no app",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.ToyProject, {
        facts: TOY,
        manifest: TOY_MANIFEST,
        turns: [folderHeld, finishes],
      });
      const sleep = host.sleep;
      host.sleep = async (ms: number) => {
        if (ms === BUSY_RETRY_MS) host.rec.cancel();
        return sleep(ms);
      };
      const report = await host.start();
      assert.equal(report.executionStatus, "paused");
      assert.equal(host.leadCalls().length, 1, "no session after the Stop");
      assert.deepEqual(host.rec.paramsOf("checkpoint.take"), [], "no checkpoint reached into the app");
    },
  );

  it("a resumed Loop stopped while its plugins prepare it stays paused", TEST_TIMEOUT, async () => {
    const host = await pausedToy();
    host.stepAnswers.set("editor-state", (hook) => {
      if (hook.on !== "run.prepare") return {};
      // The plugin works a long while on the app, and the person presses Stop meanwhile.
      host.pass(30 * MINUTE);
      host.rec.cancel();
      return {};
    });
    const resumed = await host.start({ resume: true });
    assert.equal(resumed.executionStatus, "paused");
    assert.equal(typeof resumed.workedUntil, "string", "the app counts none of the stopped start as worked");
  });

  it("a worker's merge whose turn on the git queue comes after the close lands nothing", TEST_TIMEOUT, async () => {
    let marking: Promise<unknown> = Promise.resolve();
    let armed = false;
    let held = false;
    const host = await hostOn(Project.GodotGame, {
      facts: GODOT,
      turns: [
        async (call) => {
          await call.tool("worker_start", { title: "Hall", task: "Add the hall scene", isolation: "copy" });
          assert.ok(await call.host.until(() => call.host.workers.length === 1), "the worker started");
          await call.host.workers[0]?.end({ summary: "the hall", files: { "hall.tscn": "[node]\n" } });
          assert.ok(await call.host.until(() => call.host.appended("worker_finished").length === 1), "it ended");
          // The lead marks it used; the person presses Stop while the mark still works.
          armed = true;
          marking = call.tool("worker_mark", { id: "w1", verdict: "used" });
          assert.ok(await call.host.until(() => held), "the mark is under way");
          call.host.rec.cancel();
          return undefined;
        },
      ],
    });
    const plain = host.rec.ctx.call.bind(host.rec.ctx);
    host.rec.ctx.call = (async (method: string, params?: Record<string, unknown>) => {
      // The mark's commit in the worker's copy is slow: it ends only once the close kept the folder.
      const inCopy = method === "run.exec" && typeof params?.cwd === "string" && params.cwd !== host.dir;
      if (armed && inCopy && !held) {
        held = true;
        await host.until(() => host.rec.paramsOf("checkpoint.take").length > 0);
      }
      return plain(method, params);
    }) as never;
    const report = await host.start();
    await marking;
    assert.equal(report.executionStatus, "paused");
    assert.equal(await readFile(path.join(host.dir, "hall.tscn"), "utf8").catch(() => null), null, "no merge landed");
  });

  // Flipped: Genex's own pause (its crash steps held back) came during the wait; only the lead pauses a
  // Loop now, and its pause in the turn the outage ended stops the wait at once.
  it(
    "its lead's pause in a turn its provider's outage ended takes effect within one step of the wait",
    TEST_TIMEOUT,
    async () => {
      const why = "I need the person to sign in to the toy store.";
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        turns: [
          async ({ tool }) => {
            await tool("pause", { why });
            return { ok: false, stopReason: "error", errorText: "529 overloaded" };
          },
          finishes,
        ],
      });
      host.run.budgets = { untilSatisfied: true, completionPolicy: "goal", outageDelays: [20 * 60 * MINUTE] };
      const startedAt = host.now();
      const report = await host.start();
      assert.equal(report.executionStatus, "paused");
      assert.equal(report.stoppedBecause, why);
      const waited = host.now() - startedAt;
      assert.ok(
        waited < 5 * 60 * MINUTE,
        `the Loop paused ${Math.round(waited / MINUTE)} minutes on, not after the wait`,
      );
    },
  );
});

describe("the one Loop's claims that are turned back before a reviewer reads", () => {
  it(
    "a claim while a worker writes in place is refused, and no reviewer reads the moving folder",
    TEST_TIMEOUT,
    async () => {
      const answers: string[] = [];
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        turns: [
          async (call) => {
            await startsWriter(call);
            answers.push(
              String(await call.tool("finish", { review: "yes", summary: "Done.", proof: "project.godot" })),
            );
            return undefined;
          },
          finishes,
        ],
      });
      const done = host.start();
      assert.ok(await host.until(() => host.workers.length === 1 && asleep(host)), "the lead rests");
      assert.equal(host.reviewed().length, 0);
      await host.workers[0]?.end({ summary: "the bindings are reworked" });
      const report = await done;
      assert.match(String(answers[0]), /A worker writes in the folder in place/);
      assert.equal(host.reviewed().length, 1);
      assert.equal(report.victory, true, String(report.stoppedBecause));
    },
  );
});

describe("the one Loop's finish outcomes", () => {
  it(
    "a reviewer's no's decide nothing: after three the lead's claim with no review closes the Loop on its word",
    TEST_TIMEOUT,
    async () => {
      const onItsWord: LoopTurn = async ({ tool }) => {
        await tool("finish", { summary: "The level is built and the door opens." });
        return undefined;
      };
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        turns: [thenThePersonSays(finishes), thenThePersonSays(finishes), thenThePersonSays(finishes), onItsWord],
      });
      for (let n = 0; n < 3; n += 1) host.reviews.push(reviewerAnswer("no", ["the door does not open"]));
      const report = await host.start();
      // Flipped (Loop phase 4): three no's closed the Loop as not accepted; a no is a second opinion now.
      assert.equal(host.reviewed().length, 3, "the lead asked three times, and the fourth claim asked nobody");
      assert.notEqual(report.stoppedBecause, FINISH_REPORT.notAccepted);
      assert.equal(report.victory, true, String(report.stoppedBecause));
    },
  );

  it("a claim with no review closes the Loop on the lead's word: no reviewer reads it", TEST_TIMEOUT, async () => {
    const answers: string[] = [];
    const host = await hostOn(Project.GodotGame, {
      facts: GODOT,
      turns: [
        async ({ tool }) => {
          answers.push(String(await tool("finish", { summary: "The level is built.", proof: "project.godot" })));
          return undefined;
        },
      ],
    });
    const report = await host.start();
    assert.equal(host.reviewed().length, 0, "nobody was asked");
    assert.equal(report.victory, true, String(report.stoppedBecause));
    assert.match(answers[0] ?? "", /closed on your word|closing/);
  });

  it(
    "a plugin that holds the finish back is told to the lead, no reviewer reads, and the Loop goes on",
    TEST_TIMEOUT,
    async () => {
      const answers: string[] = [];
      const host = await hostOn(Project.ToyProject, {
        facts: TOY,
        manifest: TOY_WITH_FINISH,
        turns: [
          thenThePersonSays(async ({ tool, host }) => {
            host.stepAnswers.set("capture", (hook) =>
              hook.on === "finish" ? { block: "The toy viewport is closed." } : {},
            );
            answers.push(String(await tool("finish", { review: "yes", summary: "Done.", proof: "project.godot" })));
            host.stepAnswers.delete("capture");
            return undefined;
          }),
          finishes,
        ],
      });
      const report = await host.start();
      assert.equal(answers[0], HOOK_PROMPTS.finishHeld("The toy viewport is closed."));
      assert.equal(host.reviewed().length, 1, "only the second claim was checked");
      assert.equal(report.victory, true, String(report.stoppedBecause));
    },
  );

  it("a review no engine here can hold goes back to the lead, who finishes on its word", TEST_TIMEOUT, async () => {
    let seatless = false;
    const answers: string[] = [];
    const host = await hostOn(Project.GodotGame, {
      facts: GODOT,
      turns: [
        async ({ tool }) => {
          seatless = true;
          answers.push(String(await tool("finish", { review: "yes", summary: "Done.", proof: "project.godot" })));
          answers.push(String(await tool("finish", { summary: "Done." })));
          return undefined;
        },
      ],
    });
    const plain = host.rec.ctx.call.bind(host.rec.ctx);
    host.rec.ctx.call = ((method: string, params?: Record<string, unknown>) =>
      method === "engine.describe" && seatless ? Promise.resolve([]) : plain(method, params)) as never;
    const report = await host.start();
    assert.equal(host.reviewed().length, 0);
    // Flipped (Loop phase 4): with no reviewer to seat the Loop closed without a yes; the lead decides now.
    assert.match(answers[0] ?? "", /No engine here can hold a reviewer/);
    assert.notEqual(report.stoppedBecause, FINISH_REPORT.noReviewer);
    assert.equal(report.victory, true, String(report.stoppedBecause));
  });
});

describe("the one Loop's rewinds, restores and writers in place", () => {
  it(
    "a rewind asked while a worker writes in place waits until it ends, then runs at a turn's end",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        turns: [
          keepsRoom(1),
          async (call) => {
            await startsWriter(call);
            await call.tool("rewind", { label: "Room 1" });
            return undefined;
          },
          async () => undefined,
          finishes,
        ],
      });
      const done = host.start();
      // Flipped: the line was carried on the open Loop's journal for the next message; it is the run's log's.
      const waiting = () =>
        ((journalOf(host)?.director as unknown as { log?: Array<{ text: string }> } | undefined)?.log ?? []).some(
          (line) => /waits until a turn ends after it is done/.test(line.text),
        );
      assert.ok(await host.until(() => host.workers.length === 1 && waiting()), "the lead rests beside its writer");
      assert.ok(!host.trail().includes("snapshot.restore"), "nothing restored under the writer");
      await host.workers[0]?.end({ summary: "the bindings are reworked" });
      await done;
      assert.match(String(host.prompts()[2]), /waits until a turn ends after it is done/);
      assert.ok(host.trail().includes("snapshot.restore"), "the rewind ran once the writer was done");
    },
  );

  it(
    "a rewind in a planning chat on a project no plugin hooks restores nothing and says why",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        turns: [
          keepsRoom(1),
          async ({ host, tool }) => {
            await writeFile(path.join(host.dir, "room-2.txt"), "room 2\n");
            await tool("rewind", { label: "Room 1" });
            host.planning = true;
            return undefined;
          },
          async (call) => {
            call.host.planning = false;
            return finishes(call);
          },
        ],
      });
      await host.start();
      assert.ok(!host.trail().includes("snapshot.restore"), "no restore while the chat plans");
      assert.match(String(host.prompts()[2]), /couldn't go back to save point "Room 1": the chat is in Plan mode/);
    },
  );

  // Flipped: what the look saw started a recovery that went back to the lead's save point, and no
  // autosave was kept beside it; nothing goes back now, and what the look saw is said before the autosave.
  it(
    "a look at the app still under way as the turn ends settles first: what it saw is said before Genex keeps the turn's work, and nothing goes back",
    TEST_TIMEOUT,
    async () => {
      let slowOnce = true;
      const toy = await stoppingToy([
        async ({ host }) => {
          await writeFile(path.join(host.dir, "mid.txt"), "unsaved work\n");
          const before = healthLooks(host);
          toy.state.broken = true;
          assert.ok(await host.until(() => healthLooks(host) > before), "a look at the app began");
          return undefined;
        },
        finishes,
      ]);
      const { host, state } = toy;
      host.stepAnswers.set("editor-state", async (hook) => {
        if (hook.on !== "health" || !state.broken) return {};
        if (slowOnce) {
          slowOnce = false;
          await delay(150);
        }
        return { block: "The toy editor stopped." };
      });
      const report = await host.start();
      const [stopped, autosaved] = String(host.prompts()[1]).split("\n");
      assert.equal(stopped, TOY_STOPPED, "the look's line first");
      assert.match(String(autosaved), /^Your turn ended with unsaved work, so Genex saved it as save point "Autosave"/);
      assert.deepEqual(host.rec.paramsOf("snapshot.restore"), [], "nothing went back");
      assert.deepEqual(savePointLabels(host).slice(0, 1), ["Autosave"], "the turn's work is kept");
      assert.equal(report.victory, true, String(report.stoppedBecause));
    },
  );
});

describe("the one Loop's close and its run's end", () => {
  it("a close that outlasts the lead's call is written before the run ends", TEST_TIMEOUT, async () => {
    let closesAtEnd = -1;
    const host = await hostOn(Project.ToyProject, { facts: TOY, manifest: TOY_MANIFEST, turns: [finishes] });
    host.stepAnswers.set("end-editor", () => {
      closesAtEnd = host.appended("run_finished").length;
      return {};
    });
    const plain = host.rec.ctx.call.bind(host.rec.ctx);
    host.rec.ctx.call = (async (method: string, params?: Record<string, unknown>) => {
      const batch = (params?.batch ?? []) as Array<{ event_type?: string }>;
      // The log takes the close's records slowly: longer than the lead's call has left.
      if (method === "events.append" && batch.some((one) => one.event_type === "run_finished")) await delay(800);
      return plain(method, params);
    }) as never;
    const report = await host.start();
    assert.equal(report.victory, true, String(report.stoppedBecause));
    assert.equal(closesAtEnd, 1, "the run ended after its close was written");
  });
});

describe("the one Loop's outages", () => {
  it(
    "an outage late in a turn is waited out on the Loop's clock, never taken as a lost provider",
    TEST_TIMEOUT,
    async () => {
      const outage = () => ({ ok: false, stopReason: "error", errorText: "529 overloaded" });
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        turns: [
          keepsRoom(1),
          ({ host }) => {
            host.pass(30 * MINUTE);
            return outage();
          },
          outage,
          outage,
          outage,
          finishes,
        ],
      });
      const report = await host.start();
      forgetProviderLosses(host.run.runId);
      assert.notEqual(report.executionStatus, "paused");
      assert.equal(report.victory, true, String(report.stoppedBecause));
    },
  );
});

/** A toy Loop that kept save point "One" and was stopped: paused for a Resume. */
async function pausedToy(): Promise<LoopHost> {
  const host = await hostOn(Project.ToyProject, {
    facts: TOY,
    manifest: TOY_MANIFEST,
    turns: [
      async ({ host, tool }) => {
        await tool("save_point", { label: "One", summary: "the first room" });
        host.rec.cancel();
        return undefined;
      },
    ],
  });
  const paused = await host.start();
  assert.equal(paused.executionStatus, "paused");
  host.rec.ctx.cancelled = false;
  return host;
}

describe("the one Loop's resume held back", () => {
  // Flipped: the resumed Loop stayed paused in the plugin's words, none of the held attempt counted as worked.
  it(
    "a resumed Loop whose start a plugin's step blocks goes on: its lead reads why first, its journal kept",
    TEST_TIMEOUT,
    async () => {
      const host = await pausedToy();
      host.stepAnswers.set("editor-state", (hook) => {
        if (hook.on !== "run.prepare") return {};
        // The plugin works a long while on the app before it gives up.
        host.pass(30 * MINUTE);
        return { block: "The toy editor didn't open." };
      });
      host.turns.push(finishes);
      const turns = host.leadCalls().length;
      const resumed = await host.start({ resume: true });
      const [first, ...more] = host.prompts().slice(turns);
      assert.ok(first?.startsWith("The Loop resumed"), String(first));
      assert.ok(first?.includes("The toy editor didn't open."), "the step's own words, for the lead");
      assert.equal(more.length, 0, "one turn, and it finished");
      assert.equal(host.appended("autopilot_paused").length, 1, "never paused again");
      assert.equal(resumed.victory, true, String(resumed.stoppedBecause));
      assert.deepEqual(savePointLabels(host).slice(0, 1), ["One"], "its journal kept");
    },
  );

  // Flipped: Plan mode held the resumed Loop's start back, and it stayed paused for the person's Resume.
  it(
    "a resumed Loop in Plan mode goes on: its lead reads first that the start's steps that write were skipped",
    TEST_TIMEOUT,
    async () => {
      const host = await pausedToy();
      host.planning = true;
      host.turns.push(finishes);
      const turns = host.leadCalls().length;
      const resumed = await host.start({ resume: true });
      const [first] = host.prompts().slice(turns);
      assert.match(String(first), /^The Loop resumed[\s\S]*the chat is in Plan mode/);
      assert.doesNotMatch(String(resumed.stoppedBecause), /press Resume/);
      assert.equal(host.appended("autopilot_paused").length, 1, "never paused for the plan");
    },
  );

  // Flipped: Genex's own hold of a new Loop's start (Plan mode) closed it before any turn.
  it(
    "a new Loop in Plan mode runs, its lead's first line Genex's note: the chat's agent is not told to fix it",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.ToyProject, { facts: TOY, manifest: TOY_MANIFEST, turns: [finishes] });
      host.planning = true;
      const report = await host.start();
      assert.equal(host.leadCalls().length, 1, "its lead's turn ran");
      assert.match(String(host.prompts()[0]), /^The Loop started[\s\S]*the chat is in Plan mode/);
      assert.equal(report.startHeld, undefined);
    },
  );

  it(
    "a Stop while the project's plugins prepare the Loop keeps nothing and reaches into no app",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.ToyProject, { facts: TOY, manifest: TOY_MANIFEST, turns: [finishes] });
      host.stepAnswers.set("editor-state", (hook) => {
        if (hook.on === "run.prepare") host.rec.cancel();
        return {};
      });
      await writeFile(path.join(host.dir, "left.txt"), "the person's own file\n");
      const report = await host.start();
      assert.equal(report.executionStatus, "paused");
      assert.equal(host.leadCalls().length, 0, "no turn ran");
      assert.deepEqual(host.rec.paramsOf("checkpoint.take"), [], "no checkpoint reached into the app");
      assert.ok(!host.trail().includes("tool:toy-engine__save-scenes"), host.trail().join(", "));
    },
  );
});

describe("the one Loop's reads of the game folder", () => {
  it("a look at the folder's changes never writes its index, so another git write never meets its lock", async () => {
    const host = await hostOn(Project.GodotGame, { facts: GODOT });
    const tracked = path.join(host.dir, "project.godot");
    // The same content with another time: a status that may write would refresh the index.
    await writeFile(tracked, await readFile(tracked, "utf8"));
    const old = new Date(Date.now() - 3_600_000);
    await utimes(tracked, old, old);
    const index = path.join(host.dir, ".git", "index");
    const before = await readFile(index);
    const loopRun = { ctx: host.rec.ctx, run: host.run } as unknown as Parameters<typeof folderChanged>[0];
    assert.equal(await folderChanged(loopRun), false);
    assert.ok((await readFile(index)).equals(before), "the folder's index is as it was");
  });
});

/** No line a lead reads names a clock: no minutes left, no time's up, no working time, no grace, no turn cap. */
const CLOCK_WORDS = /minutes left|time's up|working time|grace|reached its \d+ minutes|minutes of working/i;

/** Whatever the lead read: its prompts and what was steered into its turns. */
const leadRead = (host: LoopHost): string[] => [
  ...host.prompts(),
  ...host.leadCalls().flatMap((call) => (call.notices as string[] | undefined) ?? []),
  ...host.steered.map((one) => one.text),
];

describe("a Loop with no clock", () => {
  it(
    "a long turn is never cut, and a lead resting on a worker hears no time however long it rests",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        turns: [
          async ({ host, tool }) => {
            host.pass(50 * MINUTE);
            await tool("worker_start", { title: "Survey", task: "Read the scenes and list them", isolation: "read" });
            return undefined;
          },
          finishes,
        ],
      });
      const done = host.start();
      assert.ok(await host.until(() => host.workers.length === 1), "the worker started");
      await delay(50);
      host.pass(30 * 60 * MINUTE);
      await delay(50);
      assert.equal(host.leadCalls().length, 1, "the lead rests on its worker: no wake, no wrap-up, no cut");
      assert.equal(host.appended("run_finished").length, 0, "no close for time");
      await host.workers[0]?.end({ summary: "three scenes" });
      const report = await done;
      assert.equal(host.leadCalls().length, 2, "the worker's end woke it");
      assert.equal(report.victory, true, String(report.stoppedBecause));
      assert.deepEqual(
        leadRead(host).filter((text) => CLOCK_WORDS.test(text)),
        [],
        "no line names a clock",
      );
      assert.deepEqual(
        host.leadCalls().map((call) => call.timeoutMs),
        [undefined, undefined],
        "no lead turn is delegated with a time limit",
      );
    },
  );

  it(
    "a turn that ends with nothing at work pauses the Loop for the person's next word: the lead's last message is its summary",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        turns: [
          async ({ host }) => {
            await writeFile(path.join(host.dir, "room.txt"), "a room\n");
            return { summary: "The room is built; the door comes next." };
          },
        ],
      });
      const report = await host.start();
      assert.equal(host.leadCalls().length, 1, "no wake and no wrap-up turn after it");
      assert.equal(host.appended("director_continued").length, 0);
      assert.equal(host.appended("run_finished").length, 1);
      // Flipped (BP-1): it closed, not paused; a build is the whole making of the game, so it waits.
      assert.equal(report.executionStatus, "paused", "paused for the person's next word");
      assert.equal(host.appended("autopilot_paused").length, 1);
      assert.equal(report.victory, false, "nobody claimed the goal");
      assert.equal(
        report.stoppedBecause,
        OPEN_END.nothingAtWork,
        "the ordinary end, never a session that stopped short",
      );
      assert.equal(await host.git("status", "--porcelain"), "", "its work is kept in Genex's checkpoint");
    },
  );

  it("a lead resting on a job of the run is woken when it ends", TEST_TIMEOUT, async () => {
    const host = await hostOn(Project.GodotGame, {
      facts: GODOT,
      turns: [
        ({ host }) => {
          host.jobs.push({ id: "job-1", title: "Godot export", state: "running", role: "lead" });
          return undefined;
        },
        finishes,
      ],
    });
    const done = host.start();
    assert.ok(await host.until(() => host.leadCalls().length === 1), "the first turn ran");
    await delay(50);
    host.pass(30 * 60 * MINUTE);
    await delay(50);
    assert.equal(host.leadCalls().length, 1, "it rests while its job runs, however long");
    assert.equal(host.appended("run_finished").length, 0);
    host.jobs[0] = { ...host.jobs[0], state: "exited", exitCode: 0, endSeq: 1 };
    const report = await done;
    assert.equal(host.leadCalls().length, 2, "the job's end woke it");
    assert.match(String(host.prompts()[1]), /Godot export/);
    assert.equal(report.victory, true, String(report.stoppedBecause));
  });

  it(
    "the person's Finish while the lead's turn works gives exactly one wrap-up turn once that turn ends",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        turns: [
          ({ host }) => {
            host.inbox.finishing = true;
            return undefined;
          },
          // The wrap-up turn ends without a finish: the Loop closes after it all the same.
          () => undefined,
          finishes,
        ],
      });
      const report = await host.start();
      assert.equal(host.leadCalls().length, 2, "one turn, then its one wrap-up turn");
      // Flipped: "THE PERSON ASKED THE LOOP TO FINISH: this is your last turn…"; Genex's one line.
      assert.equal(host.prompts()[1], "The person asked the Loop to finish: it closes when this turn ends.");
      assert.deepEqual(
        host.leadCalls().map((call) => call.timeoutMs),
        [undefined, undefined],
        "the wrap-up turn has no time limit",
      );
      assert.equal(String(report.stoppedBecause), OPEN_END.finishAsked);
      assert.equal(host.appended("run_finished").length, 1);
    },
  );
});

/** A Loop's journal as the seed before this one wrote it when the Loop paused: its clock, its hours, an old wrap-up's cause. */
const PAUSED_JOURNALS = pausedJournals as unknown as Record<"midRun" | "inGrace", Record<string, any>>;

/** A host whose chat holds a Loop the earlier seed paused (`which`), its journal and run record as that seed left them. */
async function pausedByTheEarlierSeed(which: "midRun" | "inGrace", turns: LoopTurn[]): Promise<LoopHost> {
  const saved = structuredClone(PAUSED_JOURNALS[which]);
  const host = await hostOn(Project.GodotGame, { facts: GODOT, run: { budgets: saved.run.budgets }, turns });
  saved.runId = host.run.runId;
  saved.run = { ...saved.run, runId: host.run.runId, project: host.run.project };
  saved.director.baseCommit = await host.git("rev-parse", "HEAD");
  host.artifacts.set(`autopilot_${host.run.runId}`, saved);
  return host;
}

describe("a Loop the earlier seed paused, resumed on this one", () => {
  for (const which of ["midRun", "inGrace"] as const) {
    const paused = which === "midRun" ? "paused mid-run" : "paused inside its old wrap-up grace";
    it(`${paused}: it resumes and runs with no clock until its lead finishes`, TEST_TIMEOUT, async () => {
      let status: unknown = null;
      const host = await pausedByTheEarlierSeed(which, [
        async ({ tool }) => {
          status = await tool("run_status");
          await tool("worker_start", { title: "Survey", task: "Read the scenes and list them", isolation: "read" });
          return undefined;
        },
        finishes,
      ]);
      const done = host.start({ resume: true });
      assert.ok(await host.until(() => host.workers.length === 1), "its first turn on this seed started a worker");
      await delay(50);
      host.pass(30 * 60 * MINUTE);
      await delay(50);
      assert.equal(host.leadCalls().length, 1, "no wrap-up for its old hours, no wake for time");
      assert.equal(host.appended("run_finished").length, 0, "not closed by its old clock");
      await host.workers[0]?.end({ summary: "three scenes" });
      const report = await done;
      assert.equal(report.victory, true, String(report.stoppedBecause));
      // Flipped: the resumed brief named its save points; run_status answers them, and the first message is Genex's line.
      assert.match(String(status), /"label":"One"/, "its save point carried over");
      assert.match(String(host.prompts()[0]), /^The Loop resumed after a pause/);
      assert.deepEqual(
        leadRead(host).filter((text) => CLOCK_WORDS.test(text)),
        [],
      );
    });
  }

  it("paused inside its old grace and resumed, a Stop pauses it again", TEST_TIMEOUT, async () => {
    const host = await pausedByTheEarlierSeed("inGrace", [
      ({ host }) => {
        host.rec.cancel();
        return undefined;
      },
    ]);
    const report = await host.start({ resume: true });
    assert.equal(report.executionStatus, "paused", "a Stop pauses it, as any Loop");
  });

  it("paused mid-run and resumed, the person's Finish gives it its one wrap-up turn", TEST_TIMEOUT, async () => {
    const host = await pausedByTheEarlierSeed("midRun", [
      ({ host }) => {
        host.inbox.finishing = true;
        return undefined;
      },
      finishes,
    ]);
    const report = await host.start({ resume: true });
    assert.equal(host.leadCalls().length, 2, "a turn, then the one wrap-up turn");
    assert.equal(report.executionStatus, "completed");
  });

  it(
    "paused inside its old grace and resumed, a turn that ends with nothing at work pauses it again",
    TEST_TIMEOUT,
    async () => {
      const host = await pausedByTheEarlierSeed("inGrace", [() => undefined]);
      const report = await host.start({ resume: true });
      assert.equal(host.leadCalls().length, 1, "no wrap-up turn for its old grace");
      // Flipped (BP-1): it closed; a turn with nothing at work pauses a build for the person's next word.
      assert.equal(report.executionStatus, "paused");
    },
  );
});

const WEB = [{ id: "web-game", path: "." }];

/** The lead's tools on any game whose app no plugin restarts: one list, each name once. */
const ONE_LOOP_TOOLS = OPEN_TOOLS.filter((name) => name !== "restart");

/** The page a web game's health check reads, as the host's windows answer: healthy, or throwing `threw`. */
function pageAnswers(host: LoopHost, page: { threw: string | null }): void {
  host.rec.handle("preview.load", () => true);
  host.rec.handle("preview.ready", () => ({ ready: true }));
  host.rec.handle("preview.observe", () =>
    page.threw ? { ok: false, reasons: [page.threw] } : { ok: true, reasons: [] },
  );
  host.rec.handle("preview.screenshot", () => ({ path: "/shots/page.png" }));
}

// Flipped (one Loop): a web game's Loop forked an integration worktree, its lead built there, `show`
// offered it to Live and `finish` landed it. It works in the game folder, as every project's.
describe("a web game's Loop", () => {
  it("works in the game's own folder, as every project's, and a copy worker merges there", TEST_TIMEOUT, async () => {
    const host = await hostOn(Project.WebFolder, {
      facts: WEB,
      turns: [
        async ({ tool }) => {
          await tool("worker_start", { title: "Menu", task: "Add a menu", isolation: "copy" });
          return undefined;
        },
        async ({ tool }) => {
          await tool("worker_mark", { id: "w1", verdict: "used" });
          await tool("finish", { summary: "The menu is in." });
          return undefined;
        },
      ],
    });
    pageAnswers(host, { threw: null });
    const done = host.dispatch();
    assert.ok(await host.until(() => host.workers.length === 1), "the worker started");
    await host.workers[0]?.end({ files: { "menu.js": "export const menu = true;\n" } });
    await done;
    const [first] = host.leadCalls();
    const director = first?.director as Record<string, unknown> | undefined;
    // Flipped: "led in place" was the grant's `inPlace: true`; its root, the game folder, says it now.
    assert.equal(director?.root, host.dir, "led in place: its root is the game folder");
    // A web game: the lead's turn carries its chat's eyes on it, the window its chat's turns have.
    assert.equal((first?.selfCapture as { root?: string } | undefined)?.root, host.dir);
    assert.equal(host.appended("autopilot_started")[0]?.profile, "open");
    const copies = host.rec.paramsOf("snapshot.worktree").map((params) => String(params.name));
    assert.ok(!copies.includes("integration"), `no integration worktree (${copies.join(", ")})`);
    const removed = host.rec.paramsOf("snapshot.removeWorktree").map((params) => String(params.path));
    assert.ok(
      removed.every((dir) => /-worker-w\d+$/.test(dir)),
      `only the workers' copies are removed: ${removed.join(", ")}`,
    );
    assert.equal(await readFile(path.join(host.dir, "menu.js"), "utf8"), "export const menu = true;\n");
    assert.equal(host.appended("run_finished").at(-1)?.victory, true);
  });

  it(
    "its finish checks the game's page once, in the game folder: a failing page keeps the Loop going",
    TEST_TIMEOUT,
    async () => {
      const page: { threw: string | null } = { threw: "the page threw: boom" };
      const answers: string[] = [];
      let closesAfterFirst = -1;
      const host = await hostOn(Project.WebFolder, {
        facts: WEB,
        turns: [
          async ({ tool, host }) => {
            answers.push(String(await tool("finish", { summary: "The menu is in." })));
            closesAfterFirst = host.appended("run_finished").length;
            page.threw = null;
            answers.push(String(await tool("finish", { summary: "The menu is in, and it no longer throws." })));
            return undefined;
          },
        ],
      });
      pageAnswers(host, page);
      await host.dispatch();
      assert.match(String(answers[0]), /boom/, "the failing check's problem comes back to the lead");
      assert.equal(closesAfterFirst, 0, "the Loop stayed open");
      const loads = host.rec.paramsOf("preview.load");
      assert.equal(loads.length, 2, "one check per finish");
      for (const load of loads) {
        assert.equal(load.project, host.game.name);
        assert.equal(load.root, undefined, "the game's own folder, never a copy");
      }
      assert.equal(host.appended("run_finished").length, 1);
      assert.equal(host.appended("run_finished")[0]?.victory, true, "a passing check closes it in place");
    },
  );

  it(
    "its finish checks no page on an engine's game: one that took an engine's project during the Loop, or holds one beside its web page",
    TEST_TIMEOUT,
    async () => {
      const unreal = [{ id: "unreal-project", path: "unreal" }];
      for (const [label, start, atFinish] of [
        ["took an Unreal project during the Loop", WEB, unreal],
        ["an Unreal project beside the web starter", [...WEB, ...unreal], [...WEB, ...unreal]],
      ] as const) {
        const host = await hostOn(Project.WebFolder, {
          facts: [...start],
          turns: [
            async ({ tool, host }) => {
              host.game.facts = [...atFinish];
              await tool("finish", { summary: "The duel is in Unreal." });
              return undefined;
            },
          ],
        });
        pageAnswers(host, { threw: "the page's frame is blank: one flat colour, nothing drawn" });
        await host.dispatch();
        assert.deepEqual(host.rec.paramsOf("preview.load"), [], `${label}: no page loaded for a web check`);
        assert.equal(host.appended("run_finished")[0]?.victory, true, `${label}: the lead's word closes it`);
      }
    },
  );

  it("every game's lead gets one tool list, each name once", TEST_TIMEOUT, async () => {
    for (const [project, facts] of [
      [Project.WebFolder, WEB],
      [Project.GodotGame, GODOT],
    ] as const) {
      const host = await hostOn(project, { facts, turns: [finishes] });
      pageAnswers(host, { threw: null });
      await host.dispatch();
      const names = toolNamesOf(host);
      assert.equal(new Set(names).size, names.length, `${project}: no name twice (${names.join(", ")})`);
      assert.deepEqual(names, ONE_LOOP_TOOLS, project);
      if (project === Project.GodotGame)
        assert.deepEqual(host.rec.paramsOf("preview.load"), [], "a project that is no web game loads no page");
    }
  });
});
