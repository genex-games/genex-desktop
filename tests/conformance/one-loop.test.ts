/**
 * The one Loop on a project that isn't a web game: the chat's own session leads in place, workers
 * come from the shared pool, and the Loop ends on a reviewer's yes, a stop, a pause or its time —
 * never by landing a copy.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, copyFile, mkdir, readdir, readFile, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  FRESH_EYES_MS,
  MAX_FOLDER_ONLY_TURNS,
  OPEN_CLOSE_MS,
  OPEN_TURN_MS,
  SAVE_REMINDER_MS,
} from "../../src/harness-seed/loop/director/open/contract.ts";
import { folderChanged } from "../../src/harness-seed/loop/director/open/close.ts";
import { FOLDER_GIT } from "../../src/harness-seed/loop/director/open/folder-git.ts";
import { MESSAGE as OPEN_END } from "../../src/harness-seed/loop/director/open/finish.ts";
import { BUSY_RETRY_MS, WAKE_POLL_MS } from "../../src/harness-seed/loop/director/wake.ts";
import { WAKE_DEBOUNCE_MS } from "../../src/harness-seed/loop/director/wake-schedule.ts";
import {
  OPEN_NEWS,
  OPEN_WORDS,
  openBrief,
  openDigest,
  openStartHeld,
} from "../../src/harness-seed/loop/director/open/prompts.ts";
import {
  CALL_MARGIN_MS,
  FINISH_OBSERVE_MS,
  FINISH_REPORT,
  FINISH_REVIEW_MS,
} from "../../src/harness-seed/loop/finish-check.ts";
import { HOOK_PROMPTS } from "../../src/harness-seed/loop/hooks-prompts.ts";
import { LEAD_CALL_MS } from "../../src/harness-seed/loop/finish-contract.ts";
import { JOB_POLL_MS } from "../../src/harness-seed/loop/jobs/watch.ts";
import { loopSkill, loopSkills } from "../../src/harness-seed/loop/loop-skills.ts";
import { forgetProviderLosses } from "../../src/harness-seed/loop/provider-loss.ts";
import { minutes } from "../../src/harness-seed/loop/time.ts";
import { runExecutions } from "../../src/shared/run-state.ts";
import { WorkerIsolation, type WorkerType } from "../../src/shared/workers.ts";
import unrealManifest from "../../src/plugins/unreal/plugin.json" with { type: "json" };
import toyManifest from "../fixtures/toy-engine-plugin/plugin.json" with { type: "json" };
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
const OPEN_TOOLS = [
  "finish",
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

/** A shell command in a folder, as the host's `run.exec` runs it: its exit code and output. */
async function shellIn(cwd: string, command: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await promisify(execFile)("/bin/sh", ["-c", command], { cwd });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const failed = err as { code?: number; stdout?: string; stderr?: string };
    return { code: Number(failed.code ?? 1), stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

/** A Loop's host on a copy of one project fixture made a git repository, under a run id of its own. */
async function hostOn(
  project: Project,
  options: Omit<Parameters<typeof loopHost>[0], "dir"> & { turns?: LoopTurn[] },
): Promise<LoopHost> {
  const dir = await gameRepo(await copyProject(project, await tmpDir("one-loop-")));
  runs += 1;
  return loopHost({ ...options, dir, run: { runId: `run-open-${runs}`, ...options.run } });
}

/** A turn that claims the goal is reached, naming a file of the folder as proof. */
const finishes: LoopTurn = async ({ tool }) => {
  await tool("finish", { summary: "The level is built and the door opens.", proof: "project.godot" });
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
    assert.equal(director.inPlace, true);
    assert.equal(director.root, host.dir);
    assert.equal(first.cwd, undefined);
    assert.equal(first.readOnly, undefined);
    for (const method of ["snapshot.worktree", "preview.load", "game.scaffold", "game.upgradeContract"])
      assert.ok(!host.trail().includes(method), `no ${method}`);
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

  it(
    "a blocked start closes the Loop before any turn, with the plugin's reason, and keeps nothing",
    TEST_TIMEOUT,
    async () => {
      for (const dirty of [false, true]) {
        const host = await hostOn(Project.ToyProject, { facts: TOY, manifest: TOY_MANIFEST, turns: [finishes] });
        host.stepAnswers.set("editor-state", (hook) =>
          hook.on === "run.prepare" ? { block: "The toy editor didn't open." } : {},
        );
        // The person's own uncommitted work in the folder, which a Loop that never started leaves alone.
        if (dirty) await writeFile(path.join(host.dir, "mine.txt"), "the person's notes\n");
        const report = await host.start();
        assert.equal(host.leadCalls().length, 0, "no turn");
        const closes = host.appended("run_finished");
        assert.equal(closes.length, 1);
        assert.match(String(report.stoppedBecause), /The toy editor didn't open\./);
        assert.match(String(report.stoppedBecause), /start the Loop again/);
        assert.equal(report.victory, false);
        assert.deepEqual(
          host.rec.paramsOf("checkpoint.take"),
          [],
          `no checkpoint (${dirty ? "dirty" : "clean"} folder)`,
        );
        assert.ok(!host.trail().includes("tool:toy-engine__save-scenes"), "no checkpoint step reached the app");
      }
    },
  );

  it("its brief names the folder's kind and none of the web method", TEST_TIMEOUT, async () => {
    const host = await hostOn(Project.GodotGame, { facts: GODOT, turns: [finishes] });
    await host.start();
    const [brief] = host.prompts();
    assert.match(String(brief), /godot-project/);
    for (const web of [/Unreal/, /three\.js/i, /index\.html/, /integration/i, /judge/i])
      assert.doesNotMatch(String(brief), web);
    const director = host.leadCalls()[0]?.director as
      | { tools?: Array<{ name: string; description: string }> }
      | undefined;
    const tools = director?.tools;
    assert.ok(tools?.length, "the lead was offered its tools");
    for (const tool of tools ?? []) assert.doesNotMatch(tool.description, /integration|judge|board/i, tool.name);
  });

  it("its brief, and a fresh session's, say it runs inside Genex", TEST_TIMEOUT, async () => {
    const overflows: LoopTurn = () => {
      throw Object.assign(new Error("the context is full"), { kind: "context_overflow" });
    };
    const worksOn: LoopTurn = async ({ host }) => {
      await writeFile(path.join(host.dir, "room.txt"), "a room\n");
      return undefined;
    };
    const host = await hostOn(Project.GodotGame, { facts: GODOT, turns: [worksOn, overflows, finishes] });
    await host.start();
    const prompts = host.prompts();
    const fresh = host.leadCalls().findIndex((call, i) => i > 0 && call.resume === undefined);
    assert.ok(fresh > 0, "a later turn opened a fresh session");
    for (const prompt of [prompts[0], prompts[fresh]]) {
      assert.match(String(prompt), /You are working inside Genex, the desktop app this chat runs in/);
      assert.match(String(prompt), /never start a server/);
    }
  });

  it(
    "a project whose app no plugin saves is told its save points keep only the files on disk",
    TEST_TIMEOUT,
    async () => {
      const unreal = await hostOn(Project.UnrealGame, { facts: UNREAL, turns: [finishes] });
      await unreal.start();
      assert.match(String(unreal.prompts()[0]), /save inside the app first/i);
      const toy = await hostOn(Project.ToyProject, { facts: TOY, manifest: TOY_MANIFEST, turns: [finishes] });
      await toy.start();
      assert.doesNotMatch(String(toy.prompts()[0]), /save inside the app first/i);
    },
  );

  it("the web method reaches only web Loops", async () => {
    const workspace = await tmpDir("one-loop-skills-");
    const skills = path.join(workspace, "skills");
    await mkdir(skills);
    const seedSkills = path.join(import.meta.dirname, "../../src/harness-seed/skills");
    for (const file of ["director.md", "facet-decomposition.md"])
      await copyFile(path.join(seedSkills, file), path.join(skills, file));
    // What the director's brief has always carried: the playbook without its front matter.
    const playbook = (await readFile(path.join(skills, "director.md"), "utf8")).replace(/^---[\s\S]*?---\n?/, "");
    const web = { facts: [{ id: "web-game", path: "." }] };
    const reached = await loopSkills(workspace, web);
    assert.deepEqual(reached.map((skill) => skill.slug).sort(), ["director", "facet-decomposition"]);
    assert.equal(reached.find((skill) => skill.slug === "director")?.text, playbook);
    assert.equal(await loopSkill(workspace, "director", web), playbook, "the web brief, byte for byte");
    const unrealWithSite = [...UNREAL, { id: "web-game", path: "site" }];
    for (const facts of [GODOT, UNREAL, TOY, unrealWithSite]) {
      assert.deepEqual(await loopSkills(workspace, { facts }), [], JSON.stringify(facts));
      assert.equal(await loopSkill(workspace, "director", { facts }), "", JSON.stringify(facts));
    }
    // A copy kept from before skills named their facts was the web method's, and still is.
    const kept = (await readFile(path.join(skills, "director.md"), "utf8")).replace(/^facts:.*\n/m, "");
    assert.doesNotMatch(kept, /^facts:/m);
    await writeFile(path.join(skills, "director.md"), kept);
    assert.equal(await loopSkill(workspace, "director", web), playbook);
    assert.equal(await loopSkill(workspace, "director", { facts: GODOT }), "");
    // A skill that names another kind's fact reaches that kind only.
    await writeFile(
      path.join(skills, "scenes.md"),
      "---\nname: Scenes\nfacts: godot-project, toy-project\n---\nScenes.\n",
    );
    assert.deepEqual(
      (await loopSkills(workspace, { facts: GODOT })).map((skill) => skill.slug),
      ["scenes"],
    );
    assert.deepEqual(
      (await loopSkills(workspace, { facts: TOY })).map((skill) => skill.slug),
      ["scenes"],
    );
    assert.ok(!(await loopSkills(workspace, web)).some((skill) => skill.slug === "scenes"));
  });

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
            await tool("finish", { summary: "The door is in.", proof: "scenes/door.tscn" });
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
    const [woke] = host.appended("director_continued");
    const reasons = (woke?.reasons as string[] | undefined) ?? [];
    assert.ok(reasons.includes("worker_ended"), `a worker's end woke it (${reasons.join(", ")})`);
    assert.ok(!reasons.includes("heartbeat"));
    assert.match(String(host.prompts()[1]), /w1/);
  });
});

describe("the one Loop's end", () => {
  it(
    "a claim after a row of no's that brings no new work is turned back before Genex's finish moment: no plugin step runs",
    TEST_TIMEOUT,
    async () => {
      const { MAX_FINISH_REJECTIONS } = await import("../../src/harness-seed/loop/finish-contract.ts");
      const answers: string[] = [];
      const host = await hostOn(Project.ToyProject, {
        facts: TOY,
        manifest: TOY_WITH_FINISH,
        run: { budgets: { wallClockMs: 5 * 60 * MINUTE, completionPolicy: "duration" } },
        turns: [
          async ({ tool, host }) => {
            await writeFile(path.join(host.dir, "scenes", "hall.toyscene"), "a hall\n");
            const claim = { summary: "The hall is built.", proof: "scenes/hall.toyscene" };
            for (let n = 0; n <= MAX_FINISH_REJECTIONS; n++) answers.push(String(await tool("finish", claim)));
            return undefined;
          },
        ],
      });
      for (let n = 0; n < MAX_FINISH_REJECTIONS; n++) host.reviews.push(reviewerAnswer("no", ["the hall is dark"]));
      await host.start();
      assert.match(
        answers[MAX_FINISH_REJECTIONS] ?? "",
        /new work since the last no/,
        "the stale claim is turned back",
      );
      assert.equal(host.reviewed().length, MAX_FINISH_REJECTIONS, "and asks no reviewer");
      const moments = callsOf(host, "hooks.fire", (p) => p.on === "finish");
      assert.equal(
        moments.length,
        MAX_FINISH_REJECTIONS,
        "Genex's finish moment ran once per checked claim, not for it",
      );
    },
  );

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
              String(await tool("finish", { summary: "The hall is built.", proof: "scenes/hall.toyscene" })),
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
    "a stop pauses it for a Resume, a usage cap pauses it, and a resume goes on with the time it worked and the save points it kept",
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

      // The Loop works 40 of its 180 minutes and keeps one save point, then meets its usage cap.
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
      const saved = host.artifacts.get(id) as { director: { clock: { workedMs: number } } };
      // The Loop's own polls tick its clock while a real git commit runs: a few seconds more than it worked.
      const worked = saved.director.clock.workedMs;
      assert.ok(worked >= 40 * MINUTE && worked < 43 * MINUTE, `the time it worked, on its clock (${worked} ms)`);
      forgetProviderLosses(host.run.runId);
      host.turns.push(({ host }) => {
        host.rec.cancel();
        return undefined;
      });
      host.reviews.push(reviewerAnswer("yes"));
      host.rec.ctx.cancelled = false;
      await host.start({ resume: true });
      const resumed = host.prompts().at(-1) ?? "";
      assert.match(resumed, /"One"/);
      const left = Number(/about (\d+) minutes of working time/.exec(resumed)?.[1]);
      assert.ok(left > 100 && left <= 140, `the time it had left (${left} minutes)`);
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
  it("a turn lasts at most 45 minutes, and the lead goes on at once", TEST_TIMEOUT, async () => {
    const host = await hostOn(Project.GodotGame, {
      facts: GODOT,
      turns: [
        ({ host }) => {
          host.pass(OPEN_TURN_MS + MINUTE);
          return { ok: false, stopReason: "deadline" };
        },
        finishes,
      ],
    });
    await host.start();
    const [first, second] = host.leadCalls();
    assert.ok(Number(first?.timeoutMs) <= OPEN_TURN_MS, `the turn's time (${String(first?.timeoutMs)})`);
    assert.match(String(second?.prompt), /^Your turn reached its 45 minutes; carry on where you were\./);
    const [woke] = host.appended("director_continued");
    assert.deepEqual(woke?.reasons, ["turn_cap"], "woken at once by its cap, never rested or wrapped up");
    assert.equal(host.appended("run_finished")[0]?.victory, true);
  });

  it("its first message says an ask to stop is wrap_up, and promises no news mid-turn", TEST_TIMEOUT, async () => {
    const host = await hostOn(Project.GodotGame, { facts: GODOT, turns: [finishes] });
    await host.start();
    const brief = String(host.prompts()[0]);
    assert.match(brief, /ask to stop[^\n]*wrap_up/i, "the person's stop is a wrap-up, in their words");
    // An engine that can't take input mid-turn (Codex) hears news only once its turn ends.
    assert.match(brief, /when your turn ends/i);
    assert.doesNotMatch(brief, /News that comes while you work reaches you mid-turn\./);
  });

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

  it("a blocked save point keeps nothing and says why", TEST_TIMEOUT, async () => {
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
    assert.match(String(answers[0]), /A play session is running in the toy editor\./);
    assert.match(String(answers[0]), /nothing was kept/i);
    assert.match(String(answers[1]), /Plan mode/);
    assert.ok(!host.appended("facet_iteration").some((r) => r.label === "One" || r.label === "Two"));
    assert.ok(!journalOf(host).director.open.savePoints.some((p) => p.label === "One" || p.label === "Two"));
  });
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
      assert.match(String(unreal.prompts()[0]), /after changing the game's C\+\+ source, call restart/i);
      const godot = await hostOn(Project.GodotGame, { facts: GODOT, turns: [finishes] });
      await godot.start();
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
          async ({ host }) => {
            await writeFile(path.join(host.dir, "notes.txt"), "the lead's notes\n");
            return undefined;
          },
          finishes,
        ],
      });
      await changed.start();
      const [kept, ...again] = autosaves(changed);
      assert.ok(kept, "a folder the lead changed is kept");
      assert.equal(kept.onlyIfUnsaved, undefined);
      assert.equal(again.length, 0);
      assert.equal(journalOf(changed).director.open.savePoints[0]?.auto, true);
      assert.match(String(changed.prompts()[1]), /Genex saved it as save point "Autosave"/);

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

/** A toy Loop whose app stops when `broken` says so; `reopens` counts its crash steps. */
async function crashingToy(turns: LoopTurn[], options: { reopenFixes: boolean; backFixes?: boolean }) {
  const state = { broken: false, reopens: 0 };
  const host = await hostOn(Project.ToyProject, { facts: TOY, manifest: TOY_MANIFEST, turns });
  host.stepAnswers.set("editor-state", (hook) => {
    const back = options.backFixes === true && host.trail().includes("snapshot.restore");
    return hook.on === "health" && state.broken && !back ? { block: "The toy editor stopped." } : {};
  });
  host.stepAnswers.set("reopen-editor", () => {
    state.reopens += 1;
    if (options.reopenFixes) state.broken = false;
    return {};
  });
  return { host, state };
}

describe("the one Loop's health watch", () => {
  it(
    "a stopped app is a health block: Genex runs its crash steps, waits until it answers, and tells the lead what may be lost",
    TEST_TIMEOUT,
    async () => {
      const toy = await crashingToy(
        [
          async ({ tool, host }) => {
            await tool("save_point", { label: "One", summary: "the first room" });
            toy.state.broken = true;
            assert.ok(await host.until(() => host.steered.some((s) => /stopped/.test(s.text))), "the lead was told");
            return undefined;
          },
          finishes,
        ],
        { reopenFixes: true },
      );
      const { host, state } = toy;
      await host.start();
      assert.equal(state.reopens, 1);
      const told = host.steered.find((s) => /stopped/.test(s.text));
      assert.equal(told?.interrupt, false);
      assert.match(String(told?.text), /since save point "One" may be lost/);
      assert.match(
        String(host.prompts()[1]),
        /since save point "One" may be lost/,
        "a line the turn did not take rides the next digest",
      );
      const reasons = (host.appended("director_continued")[0]?.reasons as string[] | undefined) ?? [];
      assert.ok(reasons.includes("app_crashed"), "the crash woke the lead at once");
      assert.equal(journalOf(host).director.open.crashes, 1);
      assert.deepEqual(host.rec.paramsOf("snapshot.restore"), []);
    },
  );

  it(
    "two failed reopens go back to the last save point; with none, the Loop pauses with the reason",
    TEST_TIMEOUT,
    async () => {
      const back = await crashingToy(
        [
          async ({ tool, host }) => {
            await tool("save_point", { label: "One", summary: "the first room" });
            back.state.broken = true;
            assert.ok(await host.until(() => host.steered.some((s) => /went back/.test(s.text))));
            return undefined;
          },
          finishes,
        ],
        { reopenFixes: false, backFixes: true },
      );
      await back.host.start();
      assert.equal(back.state.reopens, 2);
      const [restore, ...more] = back.host.rec.paramsOf("snapshot.restore");
      assert.equal(more.length, 0);
      assert.equal(restore?.snapshotId, journalOf(back.host).director.open.savePoints[0]?.snapshotId);
      assert.match(String(back.host.prompts()[1]), /went back to save point "One"/);
      assert.equal(back.host.appended("run_finished")[0]?.victory, true);

      const lost = await crashingToy(
        [
          async ({ host }) => {
            lost.state.broken = true;
            assert.ok(await host.until(() => host.rec.paramsOf("engine.abort").length > 0), "the turn was ended");
            return { ok: false, stopReason: "aborted" };
          },
        ],
        { reopenFixes: false },
      );
      const report = await lost.host.start();
      assert.equal(lost.state.reopens, 2);
      assert.equal(lost.host.rec.paramsOf("engine.abort")[0]?.cwd, lost.host.dir);
      // Addressed to the run's lead alone: another chat's session in the folder is never cut.
      assert.equal(lost.host.rec.paramsOf("engine.abort")[0]?.lead, lost.host.run.runId);
      assert.equal(report.executionStatus, "paused");
      assert.match(String(report.stoppedBecause), /The toy editor stopped/);
      assert.match(String(report.stoppedBecause), /Resume the Loop/);
      assert.equal(lost.host.appended("autopilot_paused").length, 1);
      assert.equal(lost.host.reviewed().length, 0);
    },
  );
});

describe("the one Loop's held crash steps", () => {
  it(
    "a crash step Genex held (Plan mode, the person in the app) pauses with Genex's words, never as an app that failed to reopen",
    TEST_TIMEOUT,
    async () => {
      const held = await crashingToy(
        [
          async ({ tool, host }) => {
            await tool("save_point", { label: "One", summary: "the first room" });
            host.planning = true;
            held.state.broken = true;
            assert.ok(await host.until(() => host.rec.paramsOf("engine.abort").length > 0), "the turn was ended");
            // The engine answers the abort by throwing, as a first turn ended under it does.
            throw Object.assign(new Error("The turn was aborted."), { kind: "aborted" });
          },
        ],
        { reopenFixes: true },
      );
      const report = await held.host.start();
      assert.equal(held.state.reopens, 0, "nothing reopened it");
      assert.deepEqual(
        held.host.rec.paramsOf("snapshot.restore"),
        [],
        "no way back was tried for an app nobody reopened",
      );
      assert.equal(report.executionStatus, "paused");
      assert.match(String(report.stoppedBecause), /Plan mode/);
      assert.doesNotMatch(String(report.stoppedBecause), /couldn't bring it back/);
    },
  );
});

describe("the one Loop's news", () => {
  it(
    "news reaches a working lead mid-turn: a worker's end and question, a job's end, the save reminder",
    TEST_TIMEOUT,
    async () => {
      const kinds = [/w1 is waiting for the person/, /worker w1: Survey done/, /Export/, /save point/i];
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        // Its worker's question stays pending: no other Loop's chat reads it.
        threadId: "t-news",
        turns: [
          async ({ tool, host }) => {
            await tool("worker_start", { title: "Survey", task: "Read the scenes and list them", isolation: "read" });
            await host.rec.ctx.call("events.append", {
              threadId: host.threadId,
              batch: [
                {
                  type: "custom",
                  event_type: "tool_permission",
                  payload: {
                    requestId: "q1",
                    state: "pending",
                    worker: { id: "w1" },
                    title: "May I read the export presets?",
                  },
                },
              ],
            });
            host.jobs.push({
              id: "j1",
              title: "Export",
              role: "lead",
              command: "godot --export-release Mac",
              state: "exited",
              exitCode: 0,
              endedAt: new Date(0).toISOString(),
              endSeq: 1,
              durationMs: MINUTE,
              stoppedBy: null,
            });
            host.pass(SAVE_REMINDER_MS + MINUTE);
            await host.workers[0]?.end({ summary: "three scenes" });
            assert.ok(
              await host.until(() => kinds.every((kind) => host.steered.some((s) => kind.test(s.text)))),
              `every kind of news was steered (${host.steered.map((s) => s.text).join(" | ")})`,
            );
            return undefined;
          },
          finishes,
        ],
      });
      host.steerTakes = true;
      await host.start();
      const firstTurn = host.steered.filter((s) => s.id.includes(`${host.run.runId}:1:`));
      for (const kind of kinds)
        assert.equal(firstTurn.filter((s) => kind.test(s.text)).length, 1, `${String(kind)} once in the turn`);
      assert.ok(
        host.steered.every((s) => s.interrupt === false),
        "news never cuts a turn short",
      );
      const next = String(host.prompts()[1]);
      assert.doesNotMatch(next, /Survey done/, "news the turn took is not told again");
      assert.doesNotMatch(next, /Export/);
    },
  );

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

/** The minutes of working time a lead's message says are left. */
const minutesLeftIn = (prompt: unknown): number =>
  Number(/about (\d+) minutes of working time/i.exec(String(prompt))?.[1]);

/** A turn that starts one reader and returns: its lead rests while the reader works. */
const startsReader: LoopTurn = async ({ tool }) => {
  await tool("worker_start", { title: "Survey", task: "Read the scenes and list them", isolation: "read" });
  return undefined;
};

/** Whether the lead has rested at all: the wake loop's journal names when it last went to sleep. */
const asleep = (host: LoopHost): boolean =>
  Boolean((journalOf(host)?.director as { wake?: { asleepSince?: unknown } } | undefined)?.wake?.asleepSince);

/** Whether the lead rests after a turn: the wake loop's state is on the journal then. */
const restsAfter = (host: LoopHost, turns: number) => () =>
  Boolean((journalOf(host)?.director as { wake?: unknown } | undefined)?.wake) && host.prompts().length === turns;

describe("the one Loop's wrap-up", () => {
  it(
    "tells the lead to claim the goal only if it is reached: a lead that follows it asks no reviewer",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        turns: [
          ({ host, params }) => {
            // The lead works through all of its working time.
            host.pass((minutesLeftIn(params.prompt) + 1) * MINUTE);
            return undefined;
          },
          async ({ params, tool }) => {
            // The goal isn't reached: a lead that follows its wrap-up's words makes no claim.
            if (!/only if the goal is reached/i.test(String(params.prompt)))
              await tool("finish", { summary: "Not done yet.", proof: "project.godot" });
            return undefined;
          },
        ],
      });
      const report = await host.start();
      assert.match(String(host.prompts()[1]), /YOUR WORKING TIME IS OVER/);
      assert.equal(host.reviewed().length, 0, "no reviewer was asked");
      assert.equal(report.stoppedBecause, OPEN_END.timeUpNoClaim);
      assert.equal(report.victory, false);
    },
  );
});

describe("the one Loop's lead builds by itself", () => {
  it(
    "keeps going while each turn keeps a save point or changes the folder, until its finish",
    TEST_TIMEOUT,
    async () => {
      const solo =
        (n: number): LoopTurn =>
        async ({ host, tool }) => {
          await writeFile(path.join(host.dir, `room-${n}.txt`), `room ${n}\n`);
          await tool("save_point", { label: `Room ${n}`, summary: `room ${n}` });
          return undefined;
        };
      const host = await hostOn(Project.GodotGame, { facts: GODOT, turns: [solo(1), solo(2), solo(3), finishes] });
      const report = await host.start();
      assert.equal(host.prompts().length, 4, "four turns");
      for (const prompt of host.prompts()) assert.doesNotMatch(prompt, /YOUR WORKING TIME IS OVER/);
      assert.equal(report.victory, true, String(report.stoppedBecause));
    },
  );

  it(
    "a lead that works by itself while its worker runs goes on at once, never rests until news",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        turns: [
          async (call) => {
            await startsReader(call);
            await writeFile(path.join(call.host.dir, "room-1.txt"), "room 1\n");
            return undefined;
          },
          finishes,
        ],
      });
      const report = await host.start();
      const reasons = (host.appended("director_continued")[0]?.reasons as string[] | undefined) ?? [];
      assert.ok(reasons.includes("carry_on"), reasons.join(", "));
      assert.ok(!reasons.includes("heartbeat"), reasons.join(", "));
      assert.equal(report.victory, true, String(report.stoppedBecause));
    },
  );

  it("a lead that asked what next keeps and changes nothing wraps up in the lead's words", TEST_TIMEOUT, async () => {
    const host = await hostOn(Project.GodotGame, { facts: GODOT, turns: [async () => undefined] });
    const report = await host.start();
    assert.match(String(host.prompts()[1]), /Nothing of yours is at work/);
    assert.equal(report.stoppedBecause, OPEN_END.idle);
    assert.doesNotMatch(String(report.stoppedBecause), /director/);
  });
});

describe("the one Loop's turn cap", () => {
  it(
    "a turn a plugin holds back long after the last turn began wraps up with the hold's reason, never as a capped turn",
    TEST_TIMEOUT,
    async () => {
      const holdsTurns = {
        ...TOY_MANIFEST,
        hooks: [...(TOY_MANIFEST.hooks ?? []), { on: "turn.start", tool: "editor-state" }],
      } as LoopManifest;
      const host = await hostOn(Project.ToyProject, {
        facts: TOY,
        manifest: holdsTurns,
        turns: [
          async (call) => {
            await startsReader(call);
            call.host.pass(50 * MINUTE);
            return undefined;
          },
        ],
      });
      host.stepAnswers.set("editor-state", (hook) =>
        hook.on === "turn.start" && hook.turn !== "1" ? { block: "The toy editor is busy." } : {},
      );
      const done = host.start();
      assert.ok(await host.until(() => host.workers.length === 1 && restsAfter(host, 1)()), "the lead rests");
      await host.workers[0]?.end({ summary: "three scenes" });
      const report = await done;
      const continued = host.appended("director_continued");
      assert.ok(continued.length <= 2, `woken ${continued.length} times`);
      assert.ok(!continued.some((wake) => (wake.reasons as string[]).includes("turn_cap")), "no turn was capped");
      assert.match(String(report.stoppedBecause), /The toy editor is busy\./);
    },
  );

  it(
    "a rate limit that resets after the turn's cap but within the working time is waited out, never paused",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        turns: [
          () => {
            throw Object.assign(new Error("Rate limited."), { kind: "rate_limit", retryAfterMs: 50 * MINUTE });
          },
          finishes,
        ],
      });
      const report = await host.start();
      // The limit was this run's own: no later Loop of this file hears of it.
      forgetProviderLosses(host.run.runId);
      assert.notEqual(report.executionStatus, "paused");
      assert.equal(report.victory, true, String(report.stoppedBecause));
      assert.equal(host.leadCalls().length, 2, "the same turn asked again once the limit reset");
      assert.ok(Number(host.leadCalls()[1]?.timeoutMs) > 0, "with a fresh cap");
    },
  );
});

describe("the one Loop's finish mark", () => {
  it("a timed open Loop has no art director: no finish mark wakes its lead", TEST_TIMEOUT, async () => {
    const host = await hostOn(Project.GodotGame, {
      facts: GODOT,
      run: { budgets: { wallClockMs: 3 * 60 * MINUTE, completionPolicy: "duration" } },
      turns: [
        async (call) => {
          await startsReader(call);
          call.host.pass(120 * MINUTE);
          return undefined;
        },
        finishes,
      ],
    });
    const done = host.start();
    assert.ok(await host.until(() => host.workers.length === 1 && restsAfter(host, 1)()), "the lead rests");
    await host.workers[0]?.end({ summary: "three scenes" });
    await done;
    const reasons = host.appended("director_continued").flatMap((wake) => wake.reasons as string[]);
    assert.ok(!reasons.includes("finish_mark"), reasons.join(", "));
    for (const prompt of host.prompts()) assert.doesNotMatch(prompt, /art director/i);
  });
});

describe("the one Loop's recovery beside its wake loop", () => {
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
    // The app's health step answers only once the test lets it.
    let looking = false;
    host.stepAnswers.set("editor-state", async (hook) => {
      if (hook.on !== "health") return {};
      looking = asleep(host);
      await held;
      return {};
    });
    const done = host.start();
    assert.ok(
      await host.until(() => host.workers.length === 1 && host.prompts().length === 1 && looking),
      "the lead rests while Genex looks at the app",
    );
    host.inbox.said.push("Is the door done?");
    const woken = await host.until(() => host.prompts().length === 2);
    release();
    const report = await done;
    assert.ok(woken, "the person's words woke the lead while the look was still under way");
    assert.match(String(host.prompts()[1]), /Is the door done\?/);
    assert.equal(report.victory, true, String(report.stoppedBecause));
  });

  it("the person's words wake the lead while Genex brings the project's app back", TEST_TIMEOUT, async () => {
    let release = () => {};
    const reopened = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Each later turn claims the goal once Genex has said the app is back.
    const finishesOnceBack: LoopTurn = async (call) =>
      /Genex reopened it/.test(String(call.params.prompt)) ? finishes(call) : undefined;
    const toy = await crashingToy([startsReader, ...Array.from({ length: 4 }, () => finishesOnceBack)], {
      reopenFixes: true,
    });
    const { host, state } = toy;
    host.stepAnswers.set("reopen-editor", async () => {
      state.reopens += 1;
      await reopened;
      state.broken = false;
      return {};
    });
    const done = host.start();
    assert.ok(await host.until(() => host.workers.length === 1 && restsAfter(host, 1)()), "the lead rests");
    state.broken = true;
    assert.ok(await host.until(() => state.reopens === 1), "the recovery began");
    host.inbox.said.push("Fix the door first.");
    const heard = await host.until(() => host.prompts().some((prompt) => prompt.includes("Fix the door first.")));
    release();
    assert.ok(heard, "the lead heard the person while the app was still being reopened");
    await host.workers[0]?.end({ summary: "three scenes" });
    const report = await done;
    assert.equal(report.victory, true, String(report.stoppedBecause));
  });

  it("a save point and a finish while Genex brings the app back keep and claim nothing", TEST_TIMEOUT, async () => {
    let release = () => {};
    const reopened = new Promise<void>((resolve) => {
      release = resolve;
    });
    const answers: string[] = [];
    const toy = await crashingToy(
      [
        async ({ tool, host }) => {
          toy.state.broken = true;
          assert.ok(await host.until(() => toy.state.reopens === 1), "the recovery began");
          answers.push(String(await tool("save_point", { label: "Mid", summary: "mid crash" })));
          answers.push(String(await tool("finish", { summary: "Done.", proof: "project.toyproj" })));
          release();
          return undefined;
        },
        finishes,
      ],
      { reopenFixes: true },
    );
    toy.host.stepAnswers.set("reopen-editor", async () => {
      toy.state.reopens += 1;
      await reopened;
      toy.state.broken = false;
      return {};
    });
    await toy.host.start();
    for (const answer of answers) assert.match(answer, /bringing the project's app back/);
    assert.ok(!journalOf(toy.host).director.open.savePoints.some((point) => point.label === "Mid"));
    assert.ok(toy.host.reviewed().length <= 1, "only the later claim was checked");
  });

  it("a crash Genex sees while the lead's finish is checked starts no recovery", TEST_TIMEOUT, async () => {
    const toy = await crashingToy([finishes], { reopenFixes: true });
    const finishing = {
      ...TOY_MANIFEST,
      hooks: [...(TOY_MANIFEST.hooks ?? []), { on: "finish", tool: "capture" }],
    } as LoopManifest;
    const host = await hostOn(Project.ToyProject, { facts: TOY, manifest: finishing, turns: [finishes] });
    const state = { broken: false, reopens: 0 };
    host.stepAnswers.set("editor-state", (hook) =>
      hook.on === "health" && state.broken ? { block: "The toy editor stopped." } : {},
    );
    host.stepAnswers.set("reopen-editor", () => {
      state.reopens += 1;
      return {};
    });
    host.stepAnswers.set("capture", (hook) => {
      if (hook.on === "finish") state.broken = true;
      return {};
    });
    void toy;
    const report = await host.start();
    assert.equal(report.victory, true, String(report.stoppedBecause));
    assert.equal(state.reopens, 0, "no crash step ran under the check or the close");
    assert.deepEqual(host.rec.paramsOf("snapshot.restore"), [], "nothing went back");
  });

  it(
    "a lead that rests when its app is lost is not cut, and nothing in the folder is aborted",
    TEST_TIMEOUT,
    async () => {
      const toy = await crashingToy([startsReader], { reopenFixes: false });
      const { host, state } = toy;
      const done = host.start();
      assert.ok(await host.until(() => host.workers.length === 1 && restsAfter(host, 1)()), "the lead rests");
      state.broken = true;
      const report = await done;
      assert.equal(report.executionStatus, "paused");
      assert.match(String(report.stoppedBecause), /The toy editor stopped/);
      assert.deepEqual(
        host.rec.paramsOf("engine.abort").filter((params) => params.worker === undefined),
        [],
        "no session in the game folder was aborted",
      );
    },
  );

  it("a Loop Genex pauses while it waits out a limit opens no new session", TEST_TIMEOUT, async () => {
    const toy = await crashingToy(
      [
        ({ host }) => {
          toy.state.broken = true;
          void host;
          throw Object.assign(new Error("Rate limited."), { kind: "rate_limit", retryAfterMs: 30 * MINUTE });
        },
        finishes,
      ],
      { reopenFixes: false },
    );
    const report = await toy.host.start();
    forgetProviderLosses(toy.host.run.runId);
    assert.equal(toy.host.leadCalls().length, 1, "no session after the pause");
    assert.equal(report.executionStatus, "paused");
    assert.match(String(report.stoppedBecause), /The toy editor stopped/);
  });
});

describe("the one Loop's rewinds across turns and pauses", () => {
  it(
    "a rewind goes back to the save point its label named when asked, not an autosave the turn's end takes under it",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        turns: [
          async ({ host }) => {
            await writeFile(path.join(host.dir, "one.txt"), "one\n");
            return undefined;
          },
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
  it("a line a session took in but never read rides the next digest", TEST_TIMEOUT, async () => {
    const host = await hostOn(Project.GodotGame, {
      facts: GODOT,
      threadId: "t-unread",
      turns: [
        async ({ tool, host }) => {
          await tool("worker_start", { title: "Survey", task: "Read the scenes and list them", isolation: "read" });
          await host.workers[0]?.end({ summary: "three scenes" });
          assert.ok(await host.until(() => host.steered.some((s) => /Survey done/.test(s.text))), "steered");
          return undefined;
        },
        finishes,
      ],
    });
    host.steerTakes = true;
    host.steerReads = false;
    await host.start();
    assert.match(String(host.prompts()[1]), /Survey done/, "the session never read it");
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
          async ({ host, tool }) => {
            // The session ends while its claim is checked (its CLI died mid-call): the reviewer is at work.
            void tool("finish", { summary: "The level is built.", proof: "project.godot" });
            await host.until(() => host.reviewed().length > 0);
            return undefined;
          },
          async ({ host, tool }) => {
            release(reviewerAnswer("yes", ["it holds what was asked"]));
            await host.until(() => host.appended("finish_check").some((check) => check.step !== "checking"));
            answers.push(String(await tool("finish", { summary: "The level is built.", proof: "project.godot" })));
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

/** The run's own clock as its journal keeps it: when it started, and when its working time ends. */
function runClockOf(host: LoopHost): { started: number; softDeadline: number } {
  const journal = host.artifacts.get(`autopilot_${host.run.runId}`) as {
    director: { clock: { started: string; softDeadline: string } };
  };
  const { started, softDeadline } = journal.director.clock;
  return { started: Date.parse(started), softDeadline: Date.parse(softDeadline) };
}

/** Asserts `value` lies in `[low, high]`. */
function assertWithin(value: number, [low, high]: [number, number], what: string): void {
  assert.ok(low <= value && value <= high, `${what} ${value}, not in ${low}..${high}`);
}

describe("the one Loop's status, notes and fresh look", () => {
  it("run_status answers its time, save points, workers, jobs, facts and crashes", TEST_TIMEOUT, async () => {
    let status: Record<string, any> = {};
    // The Loop's clock just before and just after run_status asks it. The turn's watch moves that
    // clock on each look while the turn's real work runs, so only these two bound what it reads.
    let asked = 0;
    let answered = 0;
    const host = await hostOn(Project.GodotGame, {
      facts: GODOT,
      turns: [
        async ({ host, tool }) => {
          await tool("save_point", { label: "One", summary: "the first room" });
          await tool("worker_start", { title: "Survey", task: "Read the scenes", isolation: "read" });
          host.jobs.push({ id: "j1", title: "Export", role: "lead", command: "godot --export", state: "running" });
          host.pass(30 * MINUTE);
          asked = host.now();
          status = JSON.parse(String(await tool("run_status")));
          answered = host.now();
          await tool("finish", { summary: "The level is built.", proof: "project.godot" });
          return undefined;
        },
      ],
    });
    await host.start();
    const { started, softDeadline } = runClockOf(host);
    assertWithin(status.time.elapsedMin, [minutes(asked - started), minutes(answered - started)], "elapsedMin");
    assertWithin(
      status.time.minutesLeft,
      [minutes(softDeadline - answered), minutes(softDeadline - asked)],
      "minutesLeft",
    );
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
          await tool("finish", { summary: "The level is built.", proof: "project.godot" });
          return undefined;
        },
      ],
    });
    await host.start();
    assert.equal(answer, "noted");
    const notes = (host.artifacts.get(`autopilot_${host.run.runId}`) as Record<string, any>).director.notes;
    assert.ok(notes.some((note: { text: string }) => note.text === "Chose the cave layout over the tower."));
  });

  it(
    "after a long stretch with no reader the next message suggests a fresh look, once; a reader started since quiets it",
    TEST_TIMEOUT,
    async () => {
      const fresh = /fresh eyes/;
      const solo: LoopTurn = async ({ host }) => {
        await writeFile(path.join(host.dir, `room-${host.prompts().length}.txt`), "a room\n");
        return undefined;
      };
      const quiet = await hostOn(Project.GodotGame, {
        facts: GODOT,
        turns: [
          async (call) => {
            call.host.pass(FRESH_EYES_MS + MINUTE);
            return solo(call);
          },
          solo,
          finishes,
        ],
      });
      await quiet.start();
      assert.match(String(quiet.prompts()[1]), fresh);
      assert.doesNotMatch(String(quiet.prompts()[2]), fresh, "said once");

      const looked = await hostOn(Project.GodotGame, {
        facts: GODOT,
        turns: [
          async ({ host, tool }) => {
            host.pass(FRESH_EYES_MS + MINUTE);
            await tool("worker_start", { title: "Survey", task: "Read the scenes", isolation: "read" });
            await host.workers[0]?.end({ summary: "three scenes" });
            return undefined;
          },
          finishes,
        ],
      });
      await looked.start();
      assert.doesNotMatch(String(looked.prompts()[1]), fresh);
    },
  );

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
  it(
    "a workspace skill naming the project's kind reaches the lead's brief, and the web method does not",
    TEST_TIMEOUT,
    async () => {
      const workspace = await tmpDir("one-loop-workspace-");
      await mkdir(path.join(workspace, "skills"));
      await copyFile(
        path.join(import.meta.dirname, "../../src/harness-seed/skills/director.md"),
        path.join(workspace, "skills", "director.md"),
      );
      await writeFile(
        path.join(workspace, "skills", "scenes.md"),
        "---\nname: Scenes\nfacts: godot-project\n---\nBuild each room as its own scene, instanced from the level.\n",
      );
      const host = await hostOn(Project.GodotGame, { facts: GODOT, workspace, turns: [finishes] });
      await host.start();
      const [brief] = host.prompts();
      assert.match(String(brief), /Build each room as its own scene, instanced from the level\./);
      assert.doesNotMatch(String(brief), /The director's playbook/);
    },
  );

  it(
    "an open Loop's journal names no build of its own: the host reads the game folder for its files",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, { facts: GODOT, turns: [finishes] });
      await host.start();
      const journal = host.artifacts.get(`autopilot_${host.run.runId}`) as Record<string, any>;
      assert.equal(journal.director.integrationHead, null);
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
              String(await tool("finish", { summary: "The hall is built.", proof: "scenes/hall.toyscene" })),
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
    return undefined;
  };

/** The host refusing the lead's session because another chat's turn holds the game folder. */
const folderHeld: LoopTurn = () => {
  throw Object.assign(new Error('a contractor is already building in "godot-game"'), { code: "folder_busy" });
};

describe("the one Loop's turns that fail or wait", () => {
  it(
    "a lead whose folder another chat's turn holds waits for it within its working time, and never wraps up for it",
    TEST_TIMEOUT,
    async () => {
      const held = Array.from({ length: 8 }, () => folderHeld);
      const host = await hostOn(Project.GodotGame, { facts: GODOT, turns: [keepsRoom(1), ...held, finishes] });
      const report = await host.start();
      for (const prompt of host.prompts()) assert.doesNotMatch(prompt, /this is your last turn/i);
      assert.equal(report.victory, true, String(report.stoppedBecause));
    },
  );

  it(
    "a lead whose folder stays held past its working time waits no longer: the Loop wraps up and closes",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        run: { budgets: { wallClockMs: 30 * MINUTE, completionPolicy: "goal" } },
        turns: [keepsRoom(1)],
      });
      // From its second turn on, another chat's turn holds the folder for good.
      for (let n = 0; n < 400; n += 1) host.turns.push(folderHeld);
      const report = await host.start();
      assert.ok(host.leadCalls().length < 200, `${host.leadCalls().length} lead calls`);
      assert.equal(host.appended("run_finished").length, 1, "the Loop closed");
      assert.notEqual(report.victory, true);
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

  it(
    "a turn that waited past its cap for the folder still waits out its provider's outage within its fresh cap",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        run: { budgets: { wallClockMs: 3 * 60 * MINUTE, completionPolicy: "goal", outageDelays: [50 * MINUTE] } },
        turns: [
          keepsRoom(1),
          ({ host }) => {
            // Another chat's turn holds the folder for 50 minutes: past this turn's first cap.
            host.pass(50 * MINUTE);
            return folderHeld({ host } as never);
          },
          () => ({ ok: false, stopReason: "error", errorText: "529 overloaded" }),
        ],
      });
      const done = host.start();
      const waits = () =>
        host.appended("autopilot_decision").some((decision) => /asking it again/.test(String(decision.text)));
      const waited = await host.until(waits);
      host.rec.cancel();
      await done;
      assert.ok(waited, "the outage was waited out, not taken as a lost provider");
    },
  );

  it(
    "a turn that fails before its cap wraps up in the lead's words, never goes on as a capped turn",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        turns: [
          keepsRoom(1),
          ({ host }) => {
            host.pass(10 * MINUTE);
            return { ok: false, stopReason: "error" };
          },
        ],
      });
      const report = await host.start();
      const wrapUp = String(host.prompts()[2]);
      assert.match(wrapUp, /this is your last turn/i);
      assert.doesNotMatch(wrapUp, /reached its 45 minutes/);
      const reasons = host.appended("director_continued").flatMap((wake) => wake.reasons as string[]);
      assert.ok(!reasons.includes("turn_cap"), reasons.join(", "));
      assert.equal(report.stoppedBecause, OPEN_END.sessionEnded("error"));
      assert.doesNotMatch(String(report.stoppedBecause), /director/);
    },
  );

  it(
    "a turn that fails a minute before its cap wraps up, though the work after it passes the cap",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.ToyProject, {
        facts: TOY,
        manifest: TOY_MANIFEST,
        turns: [
          keepsRoom(1),
          async ({ host }) => {
            host.pass(OPEN_TURN_MS - MINUTE);
            await writeFile(path.join(host.dir, "unsaved.txt"), "unsaved work\n");
            // Genex's autosave after this turn takes the project's app a few minutes.
            host.stepAnswers.set("save-scenes", () => {
              host.pass(3 * MINUTE);
              return {};
            });
            return { ok: false, stopReason: "error" };
          },
        ],
      });
      const report = await host.start();
      assert.match(String(host.prompts()[2]), /this is your last turn/i);
      const reasons = host.appended("director_continued").flatMap((wake) => wake.reasons as string[]);
      assert.ok(!reasons.includes("turn_cap"), reasons.join(", "));
      assert.equal(report.stoppedBecause, OPEN_END.sessionEnded("error"));
    },
  );

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

  it(
    "time that runs out while a reviewer still reads the lead's claim closes in the Loop's own words",
    TEST_TIMEOUT,
    async () => {
      let answer: (value: unknown) => void = () => {};
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        turns: [
          async ({ host, tool, params }) => {
            void tool("finish", { summary: "The level is built.", proof: "project.godot" });
            assert.ok(await host.until(() => host.reviewed().length === 1), "a reviewer reads the claim");
            host.pass((minutesLeftIn(params.prompt) + 1) * MINUTE);
            return undefined;
          },
        ],
      });
      host.reviews.push(
        new Promise((resolve) => {
          answer = resolve;
        }) as never,
      );
      const report = await host.start();
      answer(reviewerAnswer("yes", ["it holds what was asked"]));
      assert.equal(report.stoppedBecause, OPEN_END.timeUpUnderReview);
      assert.doesNotMatch(String(report.stoppedBecause), /director/);
    },
  );

  it(
    "a claim too late in its turn for a review and the close is answered as no time left, and no reviewer is asked",
    TEST_TIMEOUT,
    async () => {
      const answers: unknown[] = [];
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        turns: [
          async ({ host, tool }) => {
            host.pass(OPEN_TURN_MS - 3 * MINUTE);
            answers.push(await tool("finish", { summary: "The level is built.", proof: "project.godot" }));
            return undefined;
          },
          finishes,
        ],
      });
      await host.start();
      assert.match(String(answers[0]), /Your turn ends too soon for a reviewer/);
      assert.equal(host.reviewed().length, 1, "only the next turn's claim was reviewed");
    },
  );
});

/** Whether any of the lead's messages so far opens its last turn. */
const wrappedUp = (host: LoopHost): boolean => host.prompts().some((prompt) => /this is your last turn/i.test(prompt));

describe("the one Loop's idle rule", () => {
  it("a quiet turn after worked ones that asked for a rewind is no idle turn", TEST_TIMEOUT, async () => {
    const rewinds: LoopTurn = async ({ tool }) => {
      await tool("rewind", { label: "Room 1" });
      return undefined;
    };
    const host = await hostOn(Project.GodotGame, {
      facts: GODOT,
      turns: [keepsRoom(1), keepsRoom(2), rewinds, keepsRoom(3), finishes],
    });
    const report = await host.start();
    assert.equal(wrappedUp(host), false, "no wrap-up while the lead works");
    assert.equal(report.victory, true, String(report.stoppedBecause));
  });

  it("a claim a reviewer turned down, the Loop going on, is no idle turn", TEST_TIMEOUT, async () => {
    const host = await hostOn(Project.GodotGame, {
      facts: GODOT,
      turns: [keepsRoom(1), finishes, keepsRoom(2), finishes],
    });
    host.reviews.push(reviewerAnswer("no", ["the door does not open"]));
    const report = await host.start();
    assert.equal(wrappedUp(host), false, "no wrap-up while the lead works");
    assert.equal(report.victory, true, String(report.stoppedBecause));
  });

  it(
    "a timed Loop in a Godot project names its time left when it settles a claim, so the reviewer's no keeps it going",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        run: { budgets: { wallClockMs: 3 * 60 * MINUTE, completionPolicy: "duration" } },
        turns: [keepsRoom(1), finishes, keepsRoom(2), finishes],
      });
      host.reviews.push(reviewerAnswer("no", ["the door does not open"]));
      const report = await host.start();
      const [settled] = host.rec.paramsOf("finish.settle");
      assert.ok(
        Number(settled?.timeLeftMs) > 2 * 60 * MINUTE,
        `the settle names the Loop's time left: ${settled?.timeLeftMs}`,
      );
      const no = host.appended("finish_check").find((record) => record.step === "rejected");
      assert.equal(no?.timeLeft, true, "the no records that the Loop had time left");
      assert.equal(report.victory, true, String(report.stoppedBecause));
    },
  );

  it("one quiet turn after work is asked what next, never wrapped up at once", TEST_TIMEOUT, async () => {
    const host = await hostOn(Project.GodotGame, {
      facts: GODOT,
      turns: [keepsRoom(1), async () => undefined, finishes],
    });
    const report = await host.start();
    assert.match(String(host.prompts()[2]), /Nothing of yours is at work/);
    assert.equal(wrappedUp(host), false);
    assert.equal(report.victory, true, String(report.stoppedBecause));
  });

  it(
    "an autosave Genex holds back makes no quiet turn a worked one: the lead is not asked again and again",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        run: { budgets: { wallClockMs: 30 * MINUTE, completionPolicy: "goal" } },
        turns: [
          async ({ host }) => {
            await writeFile(path.join(host.dir, "room.txt"), "a room\n");
            // Plan mode holds every checkpoint back: the folder stays as the lead left it.
            host.planning = true;
            return undefined;
          },
        ],
      });
      const report = await host.start();
      assert.ok(host.prompts().length <= 4, `${host.prompts().length} turns`);
      assert.equal(report.stoppedBecause, OPEN_END.idle);
    },
  );

  it(
    "a file Genex's save always leaves out makes no quiet turn a worked one: the idle lead is asked once, then wraps up",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        turns: [
          async ({ host }) => {
            await writeFile(path.join(host.dir, "room.txt"), "a room\n");
            // Genex's snapshot never takes a private env file: it stays untracked after every save.
            await writeFile(path.join(host.dir, ".env.example"), "KEY=\n");
            return undefined;
          },
        ],
      });
      const report = await host.start();
      assert.equal(host.prompts().filter((prompt) => /Decide what next/.test(prompt)).length, 1, "asked once");
      assert.ok(host.prompts().length <= 4, `${host.prompts().length} turns`);
      assert.equal(report.stoppedBecause, OPEN_END.idle);
    },
  );

  it(
    "a file already changed and edited again in a turn whose autosave Genex held back is work",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        turns: [
          async ({ host }) => {
            // Plan mode holds every checkpoint back: the folder stays as the lead left it.
            host.planning = true;
            await writeFile(path.join(host.dir, "room.txt"), "a room\n");
            return undefined;
          },
          async ({ host }) => {
            await writeFile(path.join(host.dir, "room.txt"), "a room with a door\n");
            return undefined;
          },
        ],
      });
      await host.start();
      assert.doesNotMatch(String(host.prompts()[2]), /Decide what next/, "the second edit was work");
      assert.match(String(host.prompts()[2]), /Carry on/);
    },
  );

  it(
    "an ∞ Loop's idle lead rests until something happens, and never wraps up without a check",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        run: { budgets: { untilSatisfied: true, completionPolicy: "goal" } },
        turns: [async () => undefined, async () => undefined, finishes],
      });
      const done = host.start();
      assert.ok(await host.until(restsAfter(host, 2)), "the lead rests after the question of what next");
      assert.equal(wrappedUp(host), false);
      host.inbox.said.push("Is the door done?");
      const report = await done;
      assert.equal(wrappedUp(host), false);
      assert.equal(report.victory, true, String(report.stoppedBecause));
    },
  );
});

describe("the one Loop's save points in its messages", () => {
  it("a long Loop's wake message and brief name its latest save points and count the rest", () => {
    const point = (label: string, auto: boolean, n: number) => ({
      label,
      summary: auto ? "Saved by Genex: the lead's turn ended with unsaved work." : `step ${n}`,
      snapshotId: `snap-${n}`,
      auto,
      at: n,
      notes: [],
    });
    // Twelve hours of quick turns: one save point of the lead's in every ten, the rest Genex's autosaves.
    const points = Array.from({ length: 360 }, (_, n) =>
      n % 10 === 9 ? point(`Step ${n}`, false, n) : point("Autosave", true, n),
    );
    const digest = openDigest({
      reasons: ["carry_on"],
      resumed: false,
      now: 0,
      softDeadline: 60 * MINUTE,
      userSays: [],
      happened: [],
      carried: [],
      savePoints: points,
      atWork: 0,
      freshEyes: false,
      closing: "",
    });
    const line = digest.split("\n").find((one) => one.startsWith("SAVE POINTS:")) ?? "";
    assert.ok(line.length < 400, `${line.length} characters`);
    assert.match(line, /"Step 359"/, "the latest save point of the lead's");
    assert.match(line, /and \d+ earlier/);
    const brief = openBrief({
      goal: "A level.",
      folder: "/games/level",
      folderLabel: "level",
      facts: GODOT,
      holds: null,
      carried: [],
      references: [],
      workerTypes: [],
      appSaved: false,
      restart: false,
      cppRestart: false,
      judge: false,
      savePoints: points,
      now: 0,
      softDeadline: 60 * MINUTE,
      finalDeadline: 60 * MINUTE,
      untilFinish: false,
      skills: [],
    });
    const kept = brief.split("\n\n").find((one) => one.startsWith("SAVE POINTS kept so far")) ?? "";
    assert.ok(kept.length < 800, `${kept.length} characters`);
    assert.match(kept, /"Step 359" \(step 359\)/);
  });
});

describe("the one Loop's wake cap", () => {
  it(
    "the lead's own carry-on turns fill no hourly cap: after many, a worker's end still wakes the resting lead at once",
    TEST_TIMEOUT,
    async () => {
      const BURST = 31;
      const writes =
        (n: number): LoopTurn =>
        async ({ host }) => {
          await writeFile(path.join(host.dir, `step-${n}.txt`), `step ${n}\n`);
          return undefined;
        };
      let wokeAt = 0;
      // The burst is real git work on every turn: the test waits for its last turn to run, then a short while for the rest.
      let burstEnded = (): void => {};
      const burstDone = {
        promise: new Promise<void>((resolve) => (burstEnded = resolve)),
        resolve: () => burstEnded(),
      };
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        turns: [
          ...Array.from({ length: BURST }, (_, n) => writes(n)),
          async (call) => {
            burstDone.resolve();
            return startsReader(call);
          },
          async (call) => {
            wokeAt = call.host.now();
            return finishes(call);
          },
        ],
      });
      const done = host.start();
      // A run that ends before the burst does fails on the wait below at once.
      await Promise.race([burstDone.promise, done]);
      assert.ok(
        await host.until(() => host.workers.length === 1 && asleep(host) && host.prompts().length === BURST + 1),
        "the lead rests once its worker runs",
      );
      const endedAt = host.now();
      await host.workers[0]?.end({ summary: "three scenes" });
      const report = await done;
      assert.equal(report.victory, true, String(report.stoppedBecause));
      assert.ok(wokeAt - endedAt < WAKE_DEBOUNCE_MS + 5 * WAKE_POLL_MS, `woken ${wokeAt - endedAt} ms after the end`);
    },
  );
});

describe("the one Loop's recovery and its lone lead", () => {
  it("a lone lead whose turn ends while Genex brings the app back rests until it is back", TEST_TIMEOUT, async () => {
    let release = () => {};
    const reopened = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finishesOnceBack: LoopTurn = async (call) =>
      /Genex reopened it/.test(String(call.params.prompt)) ? finishes(call) : undefined;
    const toy = await crashingToy(
      [
        async ({ host }) => {
          toy.state.broken = true;
          assert.ok(await host.until(() => toy.state.reopens === 1), "the recovery began");
          return undefined;
        },
        ...Array.from({ length: 6 }, () => finishesOnceBack),
      ],
      { reopenFixes: true },
    );
    const { host, state } = toy;
    host.stepAnswers.set("reopen-editor", async () => {
      state.reopens += 1;
      await reopened;
      state.broken = false;
      return {};
    });
    const done = host.start();
    assert.ok(await host.until(() => state.reopens === 1), "the recovery began");
    assert.ok(await host.until(restsAfter(host, 1)), "the lead rests while the app comes back");
    const before = host.prompts().length;
    assert.equal(host.appended("run_finished").length, 0, "the Loop is not closed under its recovery");
    assert.equal(wrappedUp(host), false);
    release();
    const report = await done;
    assert.ok(before <= 1, `no turns piled up while it came back (${before})`);
    assert.equal(report.victory, true, String(report.stoppedBecause));
  });
});

describe("the one Loop's guards while Genex brings the app back", () => {
  it(
    "nothing is kept or restored between turns meanwhile, and a rewind asked then waits, as the lead is told",
    TEST_TIMEOUT,
    async () => {
      let release = () => {};
      const reopened = new Promise<void>((resolve) => {
        release = resolve;
      });
      let quiet = 0;
      const finishesOnceBack: LoopTurn = async (call) => {
        if (/Genex reopened it/.test(String(call.params.prompt))) return finishes(call);
        quiet += 1;
        return undefined;
      };
      const toy = await crashingToy(
        [
          async ({ host, tool }) => {
            await tool("save_point", { label: "One", summary: "the first room" });
            toy.state.broken = true;
            assert.ok(await host.until(() => toy.state.reopens === 1), "the recovery began");
            await writeFile(path.join(host.dir, "mid.txt"), "work during the crash\n");
            await tool("rewind", { label: "One" });
            return undefined;
          },
          ...Array.from({ length: 4 }, () => finishesOnceBack),
        ],
        { reopenFixes: true },
      );
      const { host, state } = toy;
      host.stepAnswers.set("reopen-editor", async () => {
        state.reopens += 1;
        await reopened;
        state.broken = false;
        return {};
      });
      const done = host.start();
      // Its first turn worked, so it goes on at once; its next, quiet, rests while the app comes back.
      assert.ok(await host.until(() => quiet === 1 && asleep(host)), "the lead rests while the app comes back");
      const autosaves = host.rec.paramsOf("checkpoint.take").filter((params) => params.label === "Autosave");
      assert.deepEqual(autosaves, [], "no autosave while Genex brings the app back");
      assert.deepEqual(host.rec.paramsOf("snapshot.restore"), [], "no rewind while Genex brings the app back");
      release();
      await done;
      const back = host.prompts().find((prompt) => /Genex reopened it/.test(prompt));
      assert.ok(back, "the lead heard the app is back");
      assert.ok(back.includes(OPEN_NEWS.askWaits), "and that its rewind waits");
      assert.ok(back.includes(OPEN_NEWS.bringingBack), "and why nothing was kept");
    },
  );

  it(
    "a working lead hears at once that the app isn't answering, in its turn, and a resting lead is never woken for it",
    TEST_TIMEOUT,
    async () => {
      const working = await crashingToy(
        [
          async ({ host }) => {
            working.state.broken = true;
            assert.ok(await host.until(() => host.steered.some((s) => /reopened it/.test(s.text))), "back");
            return undefined;
          },
          finishes,
        ],
        { reopenFixes: true },
      );
      await working.host.start();
      const stopping = working.host.steered.find((s) => s.text === OPEN_NEWS.appStopping);
      assert.ok(stopping, "the lead was told the app isn't answering");
      assert.equal(stopping.interrupt, false, "into its turn, never cutting it short");

      const resting = await crashingToy([startsReader], { reopenFixes: false });
      const done = resting.host.start();
      assert.ok(await resting.host.until(() => resting.host.workers.length === 1 && restsAfter(resting.host, 1)()));
      resting.state.broken = true;
      await done;
      const reasons = resting.host.appended("director_continued").flatMap((wake) => wake.reasons as string[]);
      assert.ok(!reasons.includes("app_stopping"), reasons.join(", "));
    },
  );

  it("a Loop Genex pauses while its lead's provider is down opens no new session", TEST_TIMEOUT, async () => {
    const toy = await crashingToy(
      [
        ({ host }) => {
          toy.state.broken = true;
          void host;
          return { ok: false, stopReason: "error", errorText: "529 overloaded" };
        },
        finishes,
      ],
      { reopenFixes: false },
    );
    // Flipped: the outage is waited out on the Loop's own clock, long enough for the recovery to pause it.
    toy.host.run.budgets = { ...toy.host.run.budgets, outageDelays: [30 * MINUTE] };
    const report = await toy.host.start();
    assert.equal(toy.host.leadCalls().length, 1, "no session after the pause");
    assert.equal(report.executionStatus, "paused");
    assert.match(String(report.stoppedBecause), /The toy editor stopped/);
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
  it(
    "a Loop Genex paused ends its lead's session again until it ends, and refuses its save point and finish",
    TEST_TIMEOUT,
    async () => {
      const answers: unknown[] = [];
      let resent = false;
      const lost = await crashingToy(
        [
          async ({ host, tool }) => {
            lost.state.broken = true;
            // The host had not seated this session when Genex first ended it: it goes on working.
            resent = await host.until(() => host.rec.paramsOf("engine.abort").length >= 3);
            answers.push(await tool("save_point", { label: "Late", summary: "after the pause" }));
            answers.push(await tool("finish", { summary: "The level is built.", proof: "project.godot" }));
            return { ok: false, stopReason: "aborted" };
          },
        ],
        { reopenFixes: false },
      );
      const report = await lost.host.start();
      assert.ok(resent, "Genex ended the session again while it ran");
      assert.deepEqual(answers, [OPEN_WORDS.paused, OPEN_WORDS.paused]);
      assert.equal(lost.host.reviewed().length, 0);
      assert.equal(report.executionStatus, "paused");
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
          answers.push(await tool("finish", { summary: "The level is built.", proof: "project.godot" }));
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
          await tool("finish", { summary: "The level is built.", proof: "project.godot" });
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

  it(
    "a lead whose finish is checked hears no save reminder, and keeps no save point once accepted",
    TEST_TIMEOUT,
    async () => {
      let answer: (value: unknown) => void = () => {};
      const answers: unknown[] = [];
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        turns: [
          async ({ host, tool }) => {
            host.pass(SAVE_REMINDER_MS - MINUTE);
            const claim = tool("finish", { summary: "The level is built.", proof: "project.godot" });
            assert.ok(await host.until(() => host.reviewed().length === 1), "a reviewer reads the claim");
            // The reviewer reads past the time a reminder to save would be due.
            await host.sleep(3 * MINUTE);
            await delay(20);
            answer(reviewerAnswer("yes", ["it holds what was asked"]));
            answers.push(await claim);
            answers.push(await tool("save_point", { label: "Late", summary: "after the close" }));
            return undefined;
          },
        ],
      });
      host.steerTakes = true;
      host.reviews.push(
        new Promise((resolve) => {
          answer = resolve;
        }) as never,
      );
      const report = await host.start();
      assert.match(String(answers[0]), /^Accepted/);
      assert.equal(answers[1], OPEN_WORDS.ending);
      assert.ok(!host.steered.some((one) => /since your last save point/.test(one.text)), "no reminder to save");
      assert.equal(report.victory, true);
    },
  );
});

describe("the one Loop's close and a recovery under way", () => {
  it(
    "a recovery waiting for the app when the Loop closes asks it no more once the run has ended",
    TEST_TIMEOUT,
    async () => {
      const toy = await crashingToy(
        [
          async ({ host }) => {
            toy.state.broken = true;
            const waiting = () => toy.state.reopens === 1 && healthAsks() > asksAtReopen;
            assert.ok(await host.until(waiting), "Genex waits for the reopened app");
            // The person asks the Loop to finish while Genex still waits.
            host.inbox.finishing = true;
            return undefined;
          },
        ],
        { reopenFixes: false },
      );
      const { host, state } = toy;
      const fires = () => host.rec.paramsOf("hooks.fire");
      const healthAsks = () => fires().filter((params) => params.on === "health").length;
      let asksAtReopen = Number.POSITIVE_INFINITY;
      host.stepAnswers.set("reopen-editor", () => {
        state.reopens += 1;
        asksAtReopen = healthAsks();
        return {};
      });
      // Reopened, the app only loads: Genex's wait goes on until it answers or its time runs out.
      host.stepAnswers.set("editor-state", (hook) => {
        if (hook.on !== "health" || !state.broken) return {};
        return state.reopens > 0 ? { pending: "The toy editor is loading." } : { block: "The toy editor stopped." };
      });
      await host.start();
      await delay(200);
      const ons = fires().map((params) => params.on);
      const ended = ons.indexOf("run.end");
      assert.ok(ended >= 0, "the run ended");
      assert.deepEqual(
        ons.slice(ended + 1).filter((on) => on === "health"),
        [],
        "no look at the app after the run's end",
      );
    },
  );

  it(
    "a way back the lead heard mid-turn is its own news: a finish in that same turn keeps its later work and says nothing of it",
    TEST_TIMEOUT,
    async () => {
      const answers: unknown[] = [];
      const toy = await crashingToy(
        [
          async ({ host, tool }) => {
            await tool("save_point", { label: "One", summary: "the first room" });
            await writeFile(path.join(host.dir, "mid.txt"), "work after the save point\n");
            toy.state.broken = true;
            const heard = () => host.steered.some((s) => s.text === OPEN_NEWS.wentBack("One"));
            assert.ok(await host.until(heard), "the lead heard the folder went back");
            await writeFile(path.join(host.dir, "redo.txt"), "the work done again\n");
            for (let tries = 0; tries < 50; tries += 1) {
              const answer = await tool("finish", { summary: "The level is built again.", proof: "redo.txt" });
              answers.push(answer);
              if (!/bringing the project's app back/.test(String(answer))) break;
              await delay(5);
            }
            return undefined;
          },
        ],
        { reopenFixes: false, backFixes: true },
      );
      toy.host.steerTakes = true;
      const report = await toy.host.start();
      assert.match(String(answers.at(-1)), /^Accepted/);
      assert.ok(report.lastCheckpoint, "the lead's work after the way back is kept");
      assert.doesNotMatch(String(report.summary), /took the folder back/);
    },
  );

  it(
    "a way back whose app still doesn't answer pauses the Loop and says it, though a session began meanwhile",
    TEST_TIMEOUT,
    async () => {
      const toy = await crashingToy(
        [
          async ({ host, tool }) => {
            await tool("save_point", { label: "One", summary: "the first room" });
            await writeFile(path.join(host.dir, "mid.txt"), "work after the save point\n");
            toy.state.broken = true;
            assert.ok(await host.until(() => host.trail().includes("snapshot.restore")), "the way back began");
            return undefined;
          },
        ],
        { reopenFixes: false },
      );
      const { host, state } = toy;
      // Back at the save point the app only loads, and never answers within Genex's wait. Genex's
      // wait asks only once the next session has begun: its clock never runs out ahead of that turn.
      host.stepAnswers.set("editor-state", async (hook) => {
        if (hook.on !== "health" || !state.broken) return {};
        if (!host.trail().includes("snapshot.restore")) return { block: "The toy editor stopped." };
        await host.until(() => host.prompts().length >= 2);
        return { pending: "The toy editor is loading." };
      });
      const report = await host.start();
      assert.ok(host.prompts().length >= 2, "a session began while Genex waited for the app");
      assert.equal(report.executionStatus, "paused");
      assert.equal(report.lastCheckpoint, undefined, "nothing kept over the folder taken back");
      // Flipped: the lead hears the way back as soon as the restore lands, before Genex's wait for the app.
      assert.ok(
        host
          .prompts()
          .slice(1)
          .some((prompt) => prompt.includes(OPEN_NEWS.wentBack("One"))),
        "the session that began meanwhile was told the folder went back",
      );
      const carried = (journalOf(host).director.open as unknown as { carried: string[] }).carried;
      assert.ok(carried.includes(OPEN_NEWS.wentBack("One")), "a Resume tells the lead");
    },
  );

  it(
    "a recovery still reopening the app when the Loop closes reopens nothing more and keeps no journal after the close",
    TEST_TIMEOUT,
    async () => {
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const toy = await crashingToy(
        [
          async ({ host }) => {
            toy.state.broken = true;
            assert.ok(await host.until(() => toy.state.reopens === 1), "the recovery began");
            // The person asks the Loop to finish while Genex still reopens the app.
            host.inbox.finishing = true;
            return undefined;
          },
        ],
        { reopenFixes: false },
      );
      const { host, state } = toy;
      host.stepAnswers.set("reopen-editor", async () => {
        state.reopens += 1;
        await held;
        return {};
      });
      await host.start();
      const closedAt = host.rec.calls.length;
      assert.equal(host.appended("run_finished").length, 1, "the Loop closed");
      release();
      await delay(200);
      assert.equal(state.reopens, 1, "no crash step after the close");
      const journalWrites = host.rec.calls
        .slice(closedAt)
        .filter((call) => call.method === "artifact.write" && String(call.params.artifactId).startsWith("autopilot_"));
      assert.deepEqual(journalWrites, [], "no journal written over the closed run");
    },
  );

  it(
    "a close while the folder goes back to a save point waits for it, keeps nothing over it, and says so",
    TEST_TIMEOUT,
    async () => {
      let release = () => {};
      const restoring = new Promise<void>((resolve) => {
        release = resolve;
      });
      const toy = await crashingToy(
        [
          async ({ host, tool }) => {
            await tool("save_point", { label: "One", summary: "the first room" });
            await writeFile(path.join(host.dir, "mid.txt"), "work after the save point\n");
            toy.state.broken = true;
            assert.ok(await host.until(() => host.trail().includes("snapshot.restore")), "the way back began");
            host.inbox.finishing = true;
            return undefined;
          },
        ],
        { reopenFixes: false },
      );
      const { host } = toy;
      host.stepAnswers.set("reload-scenes", async () => {
        await restoring;
        return {};
      });
      const done = host.start();
      // The way back is still held when the wrap-up turn has run: the close meets it under way.
      assert.ok(await host.until(() => host.prompts().length >= 2), "the wrap-up turn ran");
      release();
      const report = await done;
      assert.equal(report.lastCheckpoint, undefined, "no checkpoint of the folder taken back");
      assert.match(String(report.summary), /took the folder back to save point "One"/);
    },
  );
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
    "a lead whose writer in place writes while its turns are quiet rests until the writer ends, and nothing is autosaved under it",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        turns: [
          async (call) => {
            await startsWriter(call);
            // The writer's first edit, made while the lead's turn still works.
            await writeFile(path.join(call.host.dir, "bindings-0.txt"), "jump\n");
            return undefined;
          },
          finishes,
        ],
      });
      const done = host.start();
      assert.ok(await host.until(() => host.workers.length === 1 && asleep(host)), "the lead rests");
      // The writer keeps editing while the lead rests.
      for (let n = 1; n <= 3; n += 1) {
        await writeFile(path.join(host.dir, `bindings-${n}.txt`), `step ${n}\n`);
        await delay(30);
      }
      assert.equal(host.leadCalls().length, 1, "never woken back to back while its writer writes");
      assert.deepEqual(savePointLabels(host), [], "no autosave of the writer's half-done files");
      await host.workers[0]?.end({ summary: "the bindings are reworked" });
      const report = await done;
      assert.equal(report.victory, true, String(report.stoppedBecause));
      assert.match(String(host.prompts()[1]), /so Genex kept no autosave of your turn/);
    },
  );

  it(
    "a lead that keeps an unchanged save point every turn is asked what next, then wraps up",
    TEST_TIMEOUT,
    async () => {
      const savesOnly =
        (n: number): LoopTurn =>
        async ({ tool }) => {
          await tool("save_point", { label: `Again ${n}`, summary: "nothing new" });
          return undefined;
        };
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        turns: [keepsRoom(1), ...Array.from({ length: 12 }, (_, n) => savesOnly(n))],
      });
      const report = await host.start();
      assert.match(String(host.prompts()[2]), /Decide what next/);
      assert.ok(host.prompts().length <= 4, `${host.prompts().length} turns`);
      assert.equal(report.stoppedBecause, OPEN_END.idle);
    },
  );

  it(
    "an autosave that keeps what the project's app held is work; one that keeps nothing more is not",
    TEST_TIMEOUT,
    async () => {
      for (const appHeld of [true, false]) {
        const host = await hostOn(Project.UnrealGame, {
          facts: UNREAL,
          manifest: UNREAL_MANIFEST,
          turns: [
            keepsRoom(1),
            ({ host }) => {
              // The lead edited the level in the editor only: its turn ends with nothing new on disk.
              host.stepAnswers.set("save-all", async (hook) => {
                if (appHeld && hook.label === "Autosave")
                  await writeFile(path.join(host.dir, "held-level.txt"), "what the editor held\n");
                return {};
              });
              return undefined;
            },
            finishes,
          ],
        });
        await host.start();
        const third = String(host.prompts()[2]);
        if (appHeld) assert.match(third, /Carry on/, "the app's save was the lead's work");
        else assert.match(third, /Decide what next/, "an autosave that kept nothing more is no work");
      }
    },
  );

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
      assert.match(String(host.prompts()[1]), /THE PERSON ASKED THE LOOP TO FINISH: this is your last turn/);
      assert.equal(report.stoppedBecause, OPEN_END.finishAsked);
    },
  );
});

/** One of the run's jobs as `jobs.list` answers it: running, or ended with its place among the game's job ends. */
function jobOf(
  id: string,
  owner: { role: "lead" | "worker"; worker?: string },
  end: { endSeq: number } | null = null,
): Record<string, unknown> {
  const ended = end
    ? { state: "succeeded", exitCode: 0, endedAt: new Date(0).toISOString(), endSeq: end.endSeq, durationMs: MINUTE }
    : { state: "running", exitCode: null, endedAt: null, endSeq: null, durationMs: null };
  return { id, title: `Export ${id}`, ...owner, command: "godot --export-release Mac", stoppedBy: null, ...ended };
}

/** Why each wake after the first turn woke the lead, in order. */
const wakeReasons = (host: LoopHost): string[][] =>
  host.appended("director_continued").map((woke) => (woke.reasons as string[] | undefined) ?? []);

/**
 * A turn that starts writer in place number `n`, which writes one file in the folder and ends
 * before the turn does: the turn's only change came beside it.
 */
const writerWithinTurn =
  (n: number): LoopTurn =>
  async ({ host, tool }) => {
    await tool("worker_start", { title: `Bindings ${n}`, task: "Rework the input bindings", isolation: "lock" });
    assert.ok(await host.until(() => host.workers.length === n), "the writer started");
    await host.workers[n - 1]?.end({ summary: "reworked", files: { [`bindings-${n}.txt`]: `step ${n}\n` } });
    assert.ok(await host.until(() => host.appended("worker_finished").length === n), "the writer ended");
    return undefined;
  };

describe("the one Loop's work beside its jobs and its other writers", () => {
  it(
    "a lead that writes a file, runs its own job to its end and keeps a save point each turn carries on until its finish",
    TEST_TIMEOUT,
    async () => {
      const withJob =
        (n: number): LoopTurn =>
        async (call) => {
          call.host.jobs.push(jobOf(`j${n}`, { role: "lead" }, { endSeq: n }));
          return keepsRoom(n)(call);
        };
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        turns: [...[1, 2, 3, 4, 5].map(withJob), finishes],
      });
      const report = await host.start();
      assert.equal(host.prompts().length, 6, "six turns");
      for (const prompt of host.prompts().slice(1)) assert.match(prompt, /Carry on/);
      assert.equal(report.victory, true, String(report.stoppedBecause));
    },
  );

  it(
    "an ∞ Loop whose lead edits and runs its own short job each turn carries on, never left asleep with nothing running",
    TEST_TIMEOUT,
    async () => {
      const editsAndBuilds =
        (n: number): LoopTurn =>
        async ({ host }) => {
          await writeFile(path.join(host.dir, `room-${n}.txt`), `room ${n}\n`);
          host.jobs.push(jobOf(`j${n}`, { role: "lead" }, { endSeq: n }));
          // The build takes a while, and Genex hears of its end while the turn still works.
          host.pass(2 * JOB_POLL_MS);
          await delay(30);
          return undefined;
        };
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        run: { budgets: { untilSatisfied: true, completionPolicy: "goal" } },
        turns: [...[1, 2, 3, 4].map(editsAndBuilds), finishes],
      });
      const report = await host.start();
      assert.equal(host.prompts().length, 5, "five turns");
      for (const prompt of host.prompts().slice(1)) assert.match(prompt, /Carry on/);
      assert.equal(report.victory, true, String(report.stoppedBecause));
    },
  );

  it(
    "a lead whose own long job runs goes on after each turn that changed the folder, never rested to the heartbeat",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        turns: [
          async (call) => {
            // The game it runs to look at, left running.
            call.host.jobs.push(jobOf("j1", { role: "lead" }));
            return keepsRoom(1)(call);
          },
          keepsRoom(2),
          finishes,
        ],
      });
      const report = await host.start();
      for (const reasons of wakeReasons(host)) {
        assert.ok(reasons.includes("carry_on"), reasons.join(", "));
        assert.ok(!reasons.includes("heartbeat"), reasons.join(", "));
      }
      assert.equal(report.victory, true, String(report.stoppedBecause));
    },
  );

  it("a lead whose worker in a copy runs a job goes on after each turn of its own work", TEST_TIMEOUT, async () => {
    const host = await hostOn(Project.GodotGame, {
      facts: GODOT,
      turns: [
        async (call) => {
          await call.tool("worker_start", { title: "Hall", task: "Add the hall scene", isolation: "copy" });
          // The worker's build runs in its own copy of the game.
          call.host.jobs.push(jobOf("j1", { role: "worker", worker: "Hall" }));
          return keepsRoom(1)(call);
        },
        keepsRoom(2),
        async (call) => {
          await call.host.workers[0]?.end({ summary: "the hall" });
          await call.tool("worker_mark", { id: "w1", verdict: "rejected", note: "not needed" });
          return finishes(call);
        },
      ],
    });
    await host.start();
    const [first, second] = wakeReasons(host);
    assert.ok(first?.includes("carry_on"), String(first));
    assert.ok(second?.includes("carry_on"), String(second));
  });

  it(
    "a change made while a job a writer in place left runs is not the lead's: it rests until the job ends",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        turns: [
          async (call) => {
            await startsWriter(call);
            assert.ok(await call.host.until(() => call.host.workers.length === 1), "the writer started");
            // The writer starts the game's export as a job of the run.
            call.host.jobs.push(jobOf("j1", { role: "worker", worker: "Bindings" }));
            return undefined;
          },
          async ({ host }) => {
            // The writer's export, still running, writes its first output while the lead's turn works.
            await mkdir(path.join(host.dir, "exports"), { recursive: true });
            await writeFile(path.join(host.dir, "exports", "game-0.pck"), "pack 0\n");
            return undefined;
          },
          finishes,
        ],
      });
      const done = host.start();
      assert.ok(await host.until(() => host.workers.length === 1 && restsAfter(host, 1)()), "the lead rests");
      await host.workers[0]?.end({ summary: "the bindings are reworked" });
      assert.ok(await host.until(() => host.prompts().length === 2), "the writer's end woke the lead");
      // The export goes on writing while the lead rests.
      for (let n = 1; n <= 3; n += 1) {
        await delay(30);
        await writeFile(path.join(host.dir, "exports", `game-${n}.pck`), `pack ${n}\n`);
      }
      assert.equal(host.leadCalls().length, 2, "never woken back to back while the writer's job writes");
      Object.assign(host.jobs[0] ?? {}, jobOf("j1", { role: "worker", worker: "Bindings" }, { endSeq: 1 }));
      const report = await done;
      assert.equal(report.victory, true, String(report.stoppedBecause));
      assert.ok(!wakeReasons(host)[1]?.includes("carry_on"), "the turn beside the job was not read as the lead's work");
      assert.match(
        String(host.prompts()[2]),
        /left running \(Export j1\)[\s\S]*job_stop/,
        "the lead hears which job holds it",
      );
    },
  );

  it(
    "turns whose only change came beside a writer in place carry on at most twice in a row, then the lead is asked what next",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        turns: [writerWithinTurn(1), writerWithinTurn(2), writerWithinTurn(3)],
      });
      await host.start();
      assert.match(String(host.prompts()[1]), /Carry on/);
      assert.match(String(host.prompts()[2]), /Carry on/);
      assert.match(String(host.prompts()[3]), /Decide what next/);
    },
  );

  it(
    "a folder something else changes each turn while the lead does nothing carries on a few turns at most, then it is asked what next",
    TEST_TIMEOUT,
    async () => {
      // The project's own tool appends to its log while the lead's turns do nothing: each session only answers.
      const outside: LoopTurn = async ({ host, n }) => {
        await appendFile(path.join(host.dir, "game.log"), `line ${n}\n`);
        return { turns: 1 };
      };
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        run: { budgets: { wallClockMs: 30 * MINUTE, completionPolicy: "goal" } },
        turns: Array.from({ length: 12 }, () => outside),
      });
      const report = await host.start();
      const asked = host.prompts().findIndex((prompt) => /Decide what next/.test(prompt));
      assert.ok(asked > 0 && asked <= MAX_FOLDER_ONLY_TURNS + 1, `asked what next at prompt ${asked}`);
      assert.equal(report.stoppedBecause, OPEN_END.idle);
    },
  );

  it(
    "a lead that keeps a save point of its own work each turn while its writer in place waits on the person goes on at once",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        threadId: "t-waiting-writer",
        turns: [
          async (call) => {
            await startsWriter(call);
            assert.ok(await call.host.until(() => call.host.workers.length === 1), "the writer started");
            await call.host.rec.ctx.call("events.append", {
              threadId: call.host.threadId,
              batch: [
                {
                  type: "custom",
                  event_type: "tool_permission",
                  payload: {
                    requestId: "q-wait",
                    state: "pending",
                    worker: { id: "w1" },
                    title: "May I delete the old maps?",
                  },
                },
              ],
            });
            assert.match(String(await call.tool("worker_status")), /May I delete the old maps\?/);
            return keepsRoom(1)(call);
          },
          keepsRoom(2),
          keepsRoom(3),
          async (call) => {
            await call.tool("worker_stop", { id: "w1", why: "the maps stay" });
            return finishes(call);
          },
        ],
      });
      const report = await host.start();
      for (const reasons of wakeReasons(host).slice(0, 3)) {
        assert.ok(reasons.includes("carry_on"), reasons.join(", "));
        assert.ok(!reasons.includes("heartbeat"), reasons.join(", "));
      }
      assert.equal(report.victory, true, String(report.stoppedBecause));
    },
  );

  it(
    "a way back that lands in a turn begun while Genex brings the app back is not the lead's work",
    TEST_TIMEOUT,
    async () => {
      let release = () => {};
      const reopenHeld = new Promise<void>((resolve) => {
        release = resolve;
      });
      let healthAfterBack = 0;
      const toy = await crashingToy(
        [
          // The lead's own turns: nothing has spent the turns read only from the folder.
          keepsRoom(1),
          keepsRoom(2),
          async ({ host }) => {
            toy.state.broken = true;
            assert.ok(await host.until(() => toy.state.reopens === 1), "the recovery began");
            // Unsaved work the way back will take away.
            await writeFile(path.join(host.dir, "scratch.txt"), "half a door\n");
            return undefined;
          },
          async ({ host }) => {
            release();
            assert.ok(await host.until(() => healthAfterBack > 0), "the folder went back and the app answers");
            // The recovery's last steps settle before the turn ends.
            await delay(50);
            return undefined;
          },
        ],
        { reopenFixes: false, backFixes: true },
      );
      const { host, state } = toy;
      host.stepAnswers.set("reopen-editor", async () => {
        state.reopens += 1;
        await reopenHeld;
        return {};
      });
      host.stepAnswers.set("editor-state", (hook) => {
        const back = host.trail().includes("snapshot.restore");
        if (hook.on === "health" && back) healthAfterBack += 1;
        return hook.on === "health" && state.broken && !back ? { block: "The toy editor stopped." } : {};
      });
      const done = host.start();
      assert.ok(await host.until(() => host.prompts().length === 3 && state.reopens === 1), "the third turn");
      await delay(50);
      host.inbox.said.push("Is the door done?");
      await done;
      assert.ok(host.rec.paramsOf("snapshot.restore").length > 0, "the folder went back");
      const turn = host.prompts().findIndex((prompt) => prompt.includes("Is the door done?"));
      assert.ok(turn > 0, "the person's words woke the lead");
      assert.doesNotMatch(String(host.prompts()[turn + 1]), /Carry on/);
      assert.match(String(host.prompts()[turn + 1]), /Decide what next/);
    },
  );
});

/** A turn that writes one file in the folder and keeps no save point: Genex autosaves it. */
const editsOnly =
  (n: number): LoopTurn =>
  async ({ host }) => {
    await writeFile(path.join(host.dir, `room-${n}.txt`), `room ${n}\n`);
    return undefined;
  };

/** A worker's question in the chat's log, pending until the person answers it. */
async function workerAsks(host: LoopHost, state: "pending" | "approved", worker = "w1"): Promise<void> {
  const payload = { requestId: `q-${worker}`, state, worker: { id: worker }, title: "May I delete the old maps?" };
  await host.rec.ctx.call("events.append", {
    threadId: host.threadId,
    batch: [{ type: "custom", event_type: "tool_permission", payload }],
  });
}

describe("the one Loop's lead that edits without save points of its own", () => {
  for (const budgets of [
    { wallClockMs: 3 * 60 * MINUTE, completionPolicy: "goal" },
    { wallClockMs: 3 * 60 * MINUTE, completionPolicy: "duration" },
    { untilSatisfied: true, completionPolicy: "goal" },
  ])
    it(
      `a lead that edits a file each turn and keeps no save point carries on past every cap (${JSON.stringify(budgets)})`,
      TEST_TIMEOUT,
      async () => {
        const edits = MAX_FOLDER_ONLY_TURNS + 3;
        const host = await hostOn(Project.GodotGame, {
          facts: GODOT,
          run: { budgets },
          turns: [...Array.from({ length: edits }, (_, n) => editsOnly(n + 1)), finishes],
        });
        await host.start();
        assert.ok(host.prompts().length > edits, `${host.prompts().length} turns`);
        // Every turn after one that edited goes on at once; a timed Loop's claim waits for its time.
        for (const prompt of host.prompts().slice(1, edits + 1)) {
          assert.match(prompt, /Carry on/);
          assert.doesNotMatch(prompt, /Decide what next|this is your last turn/i);
        }
        for (const reasons of wakeReasons(host).slice(0, edits)) {
          assert.ok(reasons.includes("carry_on"), reasons.join(", "));
          assert.ok(!reasons.includes("heartbeat"), reasons.join(", "));
        }
      },
    );

  it(
    "a turn whose two edges git read in different ways is not idle when the lead's session acted",
    TEST_TIMEOUT,
    async () => {
      let unreadable = false;
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        turns: [
          async (call) => {
            await editsOnly(1)(call);
            // The folder's content can't be read at this turn's end: Genex reads git's list of changes instead.
            unreadable = true;
            return undefined;
          },
          async (call) => {
            unreadable = false;
            return editsOnly(2)(call);
          },
          finishes,
        ],
      });
      const call = host.rec.ctx.call;
      host.rec.ctx.call = (method: string, params?: Record<string, unknown>) =>
        unreadable && method === "run.exec" && String(params?.label ?? "").endsWith(":turn-tree")
          ? Promise.resolve({ code: 128, stdout: "", stderr: "fatal: git-write-tree: error building trees" })
          : call(method, params);
      await host.start();
      assert.match(String(host.prompts()[1]), /Carry on/);
      assert.match(String(host.prompts()[2]), /Carry on/);
    },
  );

  it(
    "a writer in place the person answers mid-turn, which writes, is not the lead's work though the lead never asked",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        threadId: "t-answered-writer",
        turns: [
          async (call) => {
            await startsWriter(call);
            assert.ok(await call.host.until(() => call.host.workers.length === 1), "the writer started");
            await workerAsks(call.host, "pending");
            assert.match(String(await call.tool("worker_status")), /May I delete the old maps\?/);
            return keepsRoom(1)(call);
          },
          async ({ host }) => {
            // The person answers; the writer goes on and writes. The lead does nothing of its own.
            await workerAsks(host, "approved");
            await writeFile(path.join(host.dir, "maps.txt"), "the new maps\n");
            return undefined;
          },
          async (call) => {
            await call.tool("worker_stop", { id: "w1", why: "done" });
            return finishes(call);
          },
        ],
      });
      const done = host.start();
      assert.ok(await host.until(() => host.prompts().length === 2 && asleep(host)), "the lead rests");
      await host.workers[0]?.end({ summary: "the maps are new" });
      await done;
      assert.ok(!wakeReasons(host)[1]?.includes("carry_on"), String(wakeReasons(host)[1]));
    },
  );

  it(
    "a lead whose writer in place began to wait on the person after the lead last looked goes on at once after its own work",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        threadId: "t-unseen-question",
        turns: [
          async (call) => {
            await startsWriter(call);
            assert.ok(await call.host.until(() => call.host.workers.length === 1), "the writer started");
            await call.tool("worker_status");
            // Its question comes after the lead's last look: the lead works around it.
            await workerAsks(call.host, "pending");
            return keepsRoom(1)(call);
          },
          keepsRoom(2),
          keepsRoom(3),
          async (call) => {
            await call.tool("worker_stop", { id: "w1", why: "the maps stay" });
            return finishes(call);
          },
        ],
      });
      const report = await host.start();
      for (const reasons of wakeReasons(host).slice(1, 3)) {
        assert.ok(reasons.includes("carry_on"), reasons.join(", "));
        assert.ok(!reasons.includes("heartbeat"), reasons.join(", "));
      }
      assert.equal(report.victory, true, String(report.stoppedBecause));
    },
  );

  it(
    "a job a writer in place left running when it ended holds no later turn with the lead's own save point to the heartbeat",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        turns: [
          async (call) => {
            await startsWriter(call);
            assert.ok(await call.host.until(() => call.host.workers.length === 1), "the writer started");
            // The writer leaves the game running to look at, then ends.
            call.host.jobs.push(jobOf("j1", { role: "worker", worker: "Bindings" }));
            await call.host.workers[0]?.end({ summary: "the bindings are reworked" });
            assert.ok(await call.host.until(() => call.host.appended("worker_finished").length === 1), "it ended");
            await call.tool("worker_mark", { id: "w1", verdict: "used", note: "the bindings stay" });
            return keepsRoom(1)(call);
          },
          keepsRoom(2),
          keepsRoom(3),
          finishes,
        ],
      });
      const report = await host.start();
      for (const reasons of wakeReasons(host)) {
        assert.ok(reasons.includes("carry_on"), reasons.join(", "));
        assert.ok(!reasons.includes("heartbeat"), reasons.join(", "));
      }
      assert.equal(report.victory, true, String(report.stoppedBecause));
    },
  );

  it(
    "a job of a worker the pool doesn't know, begun and ended within a turn, is someone else's writing",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        turns: [
          writerWithinTurn(1),
          writerWithinTurn(2),
          async ({ host }) => {
            // A job of a worker this run's pool never started ran and ended while the turn worked, writing its output.
            host.jobs.push(jobOf("j9", { role: "worker", worker: "Somebody" }, { endSeq: 1 }));
            await writeFile(path.join(host.dir, "export.pck"), "pack\n");
            return undefined;
          },
        ],
      });
      await host.start();
      assert.match(String(host.prompts()[1]), /Carry on/);
      assert.match(String(host.prompts()[2]), /Carry on/);
      assert.match(String(host.prompts()[3]), /Decide what next/, "the third turn beside others is not the lead's");
    },
  );

  it(
    "a writer in place the person answers, which writes and ends within one turn, is someone else's writing",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        threadId: "t-answered-ended",
        turns: [
          writerWithinTurn(1),
          writerWithinTurn(2),
          async (call) => {
            await call.tool("worker_start", { title: "Maps", task: "Rework the maps", isolation: "lock" });
            assert.ok(await call.host.until(() => call.host.workers.length === 3), "the writer started");
            await workerAsks(call.host, "pending", "w3");
            // A third turn beside a writer: the turns read only from the folder are spent.
            await writeFile(path.join(call.host.dir, "notes.txt"), "the maps wait\n");
            return undefined;
          },
          async ({ host }) => {
            // Answered mid-turn, the writer writes and ends before the turn does.
            await workerAsks(host, "approved", "w3");
            await host.workers[2]?.end({ summary: "maps", files: { "maps.txt": "the new maps\n" } });
            assert.ok(await host.until(() => host.appended("worker_finished").length === 3), "the writer ended");
            return undefined;
          },
        ],
      });
      await host.start();
      const asked = host.prompts().findIndex((prompt, n) => n >= 4 && /Decide what next/.test(prompt));
      assert.equal(
        asked,
        4,
        host
          .prompts()
          .map((prompt) => prompt.slice(0, 60))
          .join(" | "),
      );
    },
  );
});

describe("the one Loop's writers that end while Genex reads the folder", () => {
  it(
    "a writer in place that ends while the folder is read at a turn's end counts for the turn after",
    TEST_TIMEOUT,
    async () => {
      let armed = false;
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        turns: [
          writerWithinTurn(1),
          writerWithinTurn(2),
          async (call) => {
            await call.tool("worker_start", { title: "Maps", task: "Rework the maps", isolation: "lock" });
            assert.ok(await call.host.until(() => call.host.workers.length === 3), "the writer started");
            await writeFile(path.join(call.host.dir, "notes.txt"), "maps next\n");
            // Plan mode holds the autosave back: what the writer leaves stays for the next turn to see.
            call.host.planning = true;
            armed = true;
            return undefined;
          },
          // The lead does nothing of its own: the change it finds is the writer's.
          async () => undefined,
        ],
      });
      const plain = host.rec.ctx.call.bind(host.rec.ctx);
      host.rec.ctx.call = (async (method: string, params?: Record<string, unknown>) => {
        const read = method === "run.exec" && String(params?.label ?? "").endsWith(":turn-tree");
        if (!read || !armed) return plain(method, params);
        armed = false;
        // The writer's last edit lands, and it ends, while git reads the folder.
        const answer = await plain(method, params);
        await host.workers[2]?.end({ summary: "maps", files: { "maps.txt": "the new maps\n" } });
        assert.ok(await host.until(() => host.appended("worker_finished").length === 3), "the writer ended");
        return answer;
      }) as never;
      await host.start();
      assert.match(String(host.prompts()[3]), /Decide what next/);
      assert.doesNotMatch(String(host.prompts()[4]), /Carry on/, "the writer's edit was not the lead's work");
    },
  );
});

describe("the one Loop's way back and a close under a writer's slow stop", () => {
  it(
    "a Stop while Genex stops a writer in place for a way back takes nothing back after the close",
    TEST_TIMEOUT,
    async () => {
      const toy = await crashingToy(
        [
          async (call) => {
            await keepsRoom(1)(call);
            return startsWriter(call);
          },
        ],
        { reopenFixes: false },
      );
      const { host, state } = toy;
      let stopAsked = false;
      let releaseStop = () => {};
      const stopHeld = new Promise<void>((resolve) => {
        releaseStop = resolve;
      });
      const plain = host.rec.ctx.call.bind(host.rec.ctx);
      host.rec.ctx.call = (async (method: string, params?: Record<string, unknown>) => {
        // The recovery's stop of the writer takes long; the close's own abort goes through.
        const stop = (method === "engine.abort" || method === "engine.interrupt") && params?.worker;
        if (stop && !stopAsked) {
          stopAsked = true;
          await stopHeld;
        }
        return plain(method, params);
      }) as never;
      const done = host.start();
      assert.ok(await host.until(() => host.workers.length === 1 && restsAfter(host, 1)()), "the lead rests");
      state.broken = true;
      assert.ok(await host.until(() => stopAsked), "Genex stops the writer before going back");
      host.rec.cancel();
      const report = await done;
      assert.equal(report.executionStatus, "paused");
      releaseStop();
      await delay(200);
      assert.deepEqual(host.rec.paramsOf("snapshot.restore"), [], "nothing went back after the close");
      const why = host.appended("worker_finished").map((ended) => String(ended.stoppedBecause ?? ""));
      assert.ok(why.length > 0, "the writer's end is recorded");
      for (const reason of why)
        assert.doesNotMatch(reason, /took the folder back/, "it never says the folder went back");
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

  it("a Stop during the folder read as a turn begins opens no session", TEST_TIMEOUT, async () => {
    const host = await hostOn(Project.GodotGame, { facts: GODOT, turns: [finishes] });
    const plain = host.rec.ctx.call.bind(host.rec.ctx);
    host.rec.ctx.call = ((method: string, params?: Record<string, unknown>) => {
      if (method === "run.exec" && String(params?.label ?? "").endsWith(":turn-tree")) host.rec.cancel();
      return plain(method, params);
    }) as never;
    const report = await host.start();
    assert.equal(host.leadCalls().length, 0, "no lead session opened");
    assert.equal(report.executionStatus, "paused");
  });

  it("a resumed Loop stopped while its plugins prepare it spends none of its working time", TEST_TIMEOUT, async () => {
    const host = await pausedToy();
    const workedBefore = workedMsOf(host);
    host.stepAnswers.set("editor-state", (hook) => {
      if (hook.on !== "run.prepare") return {};
      // The plugin works a long while on the app, and the person presses Stop meanwhile.
      host.pass(30 * MINUTE);
      host.rec.cancel();
      return {};
    });
    const resumed = await host.start({ resume: true });
    assert.equal(resumed.executionStatus, "paused");
    const spent = workedMsOf(host) - workedBefore;
    assert.ok(spent >= 0 && spent < MINUTE, `the stopped start spent ${spent} ms`);
  });

  it(
    "a way back that waits on the git queue behind a save point takes nothing back once the Loop is stopped",
    TEST_TIMEOUT,
    async () => {
      let releaseSave = () => {};
      const saveHeld = new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
      let saving = false;
      const toy = await crashingToy(
        [
          keepsRoom(1),
          async ({ host, tool }) => {
            await writeFile(path.join(host.dir, "room-2.txt"), "room 2\n");
            await tool("save_point", { label: "Room 2", summary: "room 2" });
            return undefined;
          },
        ],
        { reopenFixes: false },
      );
      const { host, state } = toy;
      const plain = host.rec.ctx.call.bind(host.rec.ctx);
      host.rec.ctx.call = (async (method: string, params?: Record<string, unknown>) => {
        // The lead's save point holds the git queue while Genex fails to reopen the app. The app
        // stops only once the save holds the queue, so the way back is always queued behind it.
        if (method === "checkpoint.take" && params?.label === "Room 2") {
          saving = true;
          state.broken = true;
          await saveHeld;
        }
        return plain(method, params);
      }) as never;
      const done = host.start();
      assert.ok(await host.until(() => saving && state.reopens >= 2), "the way back is next, behind the save point");
      await delay(100);
      host.rec.cancel();
      releaseSave();
      const report = await done;
      await delay(100);
      assert.equal(report.executionStatus, "paused");
      assert.deepEqual(host.rec.paramsOf("snapshot.restore"), [], "nothing went back after the Stop");
    },
  );

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

  it(
    "Genex's pause during the lead's provider outage takes effect within one step of the wait",
    TEST_TIMEOUT,
    async () => {
      const toy = await crashingToy(
        [
          () => {
            toy.state.broken = true;
            return { ok: false, stopReason: "error", errorText: "529 overloaded" };
          },
          finishes,
        ],
        { reopenFixes: false },
      );
      const { host } = toy;
      host.run.budgets = { untilSatisfied: true, completionPolicy: "goal", outageDelays: [20 * 60 * MINUTE] };
      const startedAt = host.now();
      const report = await host.start();
      assert.equal(report.executionStatus, "paused");
      assert.match(String(report.stoppedBecause), /The toy editor stopped/);
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
            answers.push(String(await call.tool("finish", { summary: "Done.", proof: "project.godot" })));
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
    "a timed Loop's claim while working minutes remain is checked, and so is its wrap-up's claim",
    TEST_TIMEOUT,
    async () => {
      const answers: string[] = [];
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        run: { budgets: { wallClockMs: 3 * 60 * MINUTE, completionPolicy: "duration" } },
        turns: [
          async ({ tool }) => {
            answers.push(String(await tool("finish", { summary: "The level is built.", proof: "project.godot" })));
            return undefined;
          },
          ({ host, params }) => {
            host.pass((minutesLeftIn(params.prompt) + 1) * MINUTE);
            return undefined;
          },
          finishes,
        ],
      });
      // Flipped: a claim is never refused for time; its reviewer reads it (time-cap.ts), and says no here.
      host.reviews.push(reviewerAnswer("no", ["the door does not open"]));
      const report = await host.start();
      assert.doesNotMatch(String(answers[0]), /finish refused/);
      assert.equal(host.reviewed().length, 2, "the early claim and the wrap-up's were checked");
      assert.equal(report.victory, true, String(report.stoppedBecause));
    },
  );

  it(
    "three no's in a row close the Loop as not accepted, with what isn't done, and no fourth review",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        turns: [finishes, finishes, finishes, finishes],
      });
      for (let n = 0; n < 3; n += 1) host.reviews.push(reviewerAnswer("no", ["the door does not open"]));
      const report = await host.start();
      assert.equal(host.reviewed().length, 3);
      assert.equal(report.stoppedBecause, FINISH_REPORT.notAccepted);
      assert.ok((report.notDone as string[] | undefined)?.length, "what isn't done is in the report");
      assert.equal(report.victory, false);
    },
  );

  it(
    "a plugin that holds the finish back is told to the lead, no reviewer reads, and the Loop goes on",
    TEST_TIMEOUT,
    async () => {
      const answers: string[] = [];
      const host = await hostOn(Project.ToyProject, {
        facts: TOY,
        manifest: TOY_WITH_FINISH,
        turns: [
          async ({ tool, host }) => {
            host.stepAnswers.set("capture", (hook) =>
              hook.on === "finish" ? { block: "The toy viewport is closed." } : {},
            );
            answers.push(String(await tool("finish", { summary: "Done.", proof: "project.godot" })));
            host.stepAnswers.delete("capture");
            return undefined;
          },
          finishes,
        ],
      });
      const report = await host.start();
      assert.equal(answers[0], HOOK_PROMPTS.finishHeld("The toy viewport is closed."));
      assert.equal(host.reviewed().length, 1, "only the second claim was checked");
      assert.equal(report.victory, true, String(report.stoppedBecause));
    },
  );

  it("a claim no engine here can review closes the Loop as having no reviewer", TEST_TIMEOUT, async () => {
    let seatless = false;
    const host = await hostOn(Project.GodotGame, {
      facts: GODOT,
      turns: [
        async (call) => {
          seatless = true;
          return finishes(call);
        },
      ],
    });
    const plain = host.rec.ctx.call.bind(host.rec.ctx);
    host.rec.ctx.call = ((method: string, params?: Record<string, unknown>) =>
      method === "engine.describe" && seatless ? Promise.resolve([]) : plain(method, params)) as never;
    const report = await host.start();
    assert.equal(host.reviewed().length, 0);
    assert.equal(report.stoppedBecause, FINISH_REPORT.noReviewer);
    assert.equal(report.victory, false);
  });

  it("a claim too late in the last turn closes the Loop as too late", TEST_TIMEOUT, async () => {
    const answers: string[] = [];
    const host = await hostOn(Project.GodotGame, {
      facts: GODOT,
      run: { budgets: { wallClockMs: 30 * MINUTE, completionPolicy: "goal" } },
      turns: [
        ({ host, params }) => {
          host.pass((minutesLeftIn(params.prompt) + 1) * MINUTE);
          return undefined;
        },
        async ({ host, tool }) => {
          const status = JSON.parse(String(await tool("run_status"))) as { time: { hardMinutesLeft: number } };
          host.pass(Math.max(0, status.time.hardMinutesLeft - 1) * MINUTE);
          answers.push(String(await tool("finish", { summary: "Done.", proof: "project.godot" })));
          return undefined;
        },
      ],
    });
    const report = await host.start();
    assert.equal(answers[0], OPEN_WORDS.noTimeLeft);
    assert.equal(host.reviewed().length, 0);
    assert.equal(report.stoppedBecause, FINISH_REPORT.tooLate);
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
      assert.ok(await host.until(() => host.workers.length === 1 && asleep(host)), "the lead rests");
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

  it(
    "a way back stops the run's writer in place first, and tells the working lead before Genex waits for the app",
    TEST_TIMEOUT,
    async () => {
      const seen = { answered: false, toldFirst: false, pendings: 0 };
      const toy = await crashingToy(
        [
          async (call) => {
            const { host, tool } = call;
            await tool("save_point", { label: "One", summary: "the first room" });
            await startsWriter(call);
            toy.state.broken = true;
            const told = () => host.steered.some((one) => one.text.includes(OPEN_NEWS.wentBack("One")));
            assert.ok(await host.until(told), "the lead was told the folder went back");
            seen.toldFirst = !seen.answered;
            assert.ok(await host.until(() => seen.answered), "the app answers again");
            return undefined;
          },
          finishes,
        ],
        { reopenFixes: false },
      );
      const { host, state } = toy;
      host.steerTakes = true;
      // Back at the save point the app loads a while before it answers.
      host.stepAnswers.set("editor-state", (hook) => {
        if (hook.on !== "health" || !state.broken) return {};
        if (!host.trail().includes("snapshot.restore")) return { block: "The toy editor stopped." };
        seen.pendings += 1;
        if (seen.pendings < 4) return { pending: "The toy editor is loading." };
        seen.answered = true;
        return {};
      });
      await host.start();
      assert.ok(seen.toldFirst, "told before the wait for the app ended");
      const trail = host.trail();
      assert.ok(trail.indexOf("engine.abort") >= 0, "the writer was stopped");
      assert.ok(trail.indexOf("engine.abort") < trail.indexOf("snapshot.restore"), "before the restore");
      const told = host.steered.find((one) => one.text.includes(OPEN_NEWS.wentBack("One")));
      assert.match(String(told?.text), /Genex stopped .+ first/);
    },
  );

  it(
    "a look at the app still under way as the turn ends settles first: its recovery never goes back to that turn's autosave",
    TEST_TIMEOUT,
    async () => {
      let slowOnce = true;
      const toy = await crashingToy(
        [
          async ({ host, tool }) => {
            await tool("save_point", { label: "One", summary: "the first room" });
            await writeFile(path.join(host.dir, "mid.txt"), "unsaved work\n");
            const looks = () => host.rec.paramsOf("hooks.fire").filter((params) => params.on === "health").length;
            const before = looks();
            toy.state.broken = true;
            assert.ok(await host.until(() => looks() > before), "a look at the app began");
            return undefined;
          },
          finishes,
        ],
        { reopenFixes: false, backFixes: true },
      );
      const { host, state } = toy;
      host.stepAnswers.set("editor-state", async (hook) => {
        if (hook.on !== "health" || !state.broken || host.trail().includes("snapshot.restore")) return {};
        if (slowOnce) {
          slowOnce = false;
          await delay(150);
        }
        return { block: "The toy editor stopped." };
      });
      await host.start();
      const one = journalOf(host).director.open.savePoints.find((point) => point.label === "One");
      const [restore] = host.rec.paramsOf("snapshot.restore");
      assert.equal(restore?.snapshotId, one?.snapshotId, "back to the lead's save point");
      assert.ok(!savePointLabels(host).slice(0, 2).includes("Autosave"), "no autosave beside the crash");
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
    "an outage late in a turn is waited out within the Loop's working time, on its clock, never taken as a lost provider",
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

/** How long the Loop had worked when its journal was last saved. */
const workedMsOf = (host: LoopHost): number =>
  (host.artifacts.get(`autopilot_${host.run.runId}`) as { director: { clock: { workedMs: number } } }).director.clock
    .workedMs;

describe("the one Loop's resume held back", () => {
  it("a resumed Loop whose start a plugin holds back stays paused, its journal kept", TEST_TIMEOUT, async () => {
    const host = await pausedToy();
    const workedBefore = workedMsOf(host);
    host.stepAnswers.set("editor-state", (hook) => {
      if (hook.on !== "run.prepare") return {};
      // The plugin works a long while on the app before it gives up.
      host.pass(30 * MINUTE);
      return { block: "The toy editor didn't open." };
    });
    const startedAt = Date.now();
    const resumed = await host.start({ resume: true });
    assert.equal(resumed.executionStatus, "paused");
    assert.equal(resumed.landed, false);
    assert.equal(host.appended("autopilot_paused").length, 2, "paused again");
    assert.match(String(resumed.stoppedBecause), /Resume/);
    const journal = host.artifacts.get(`autopilot_${host.run.runId}`) as { phase?: string };
    assert.notEqual(journal.phase, "done");
    assert.deepEqual(savePointLabels(host), ["One"]);
    // Far less than the half hour the plugin's step took: the journal reads its clock a moment apart.
    const spent = workedMsOf(host) - workedBefore;
    assert.ok(spent >= 0 && spent < MINUTE, `an attempt that ran no turn spent none of the Loop's time (${spent} ms)`);
    // The app counts the run's working time from its start record to its close, both as it writes them.
    const at = (ms: number) => new Date(ms).toISOString();
    const records = [
      {
        created_at: at(startedAt),
        data: { type: "custom", event_type: "run_started", payload: { runId: host.run.runId } },
      },
      {
        created_at: at(startedAt + 30 * MINUTE),
        data: { type: "custom", event_type: "run_finished", payload: resumed },
      },
    ];
    const run = runExecutions(records as never).get(host.run.runId);
    assert.equal(run?.worked.ms, 0, "the app counts none of the held attempt as worked");
  });

  it(
    "a resumed Loop Plan mode holds back stays paused, and the person is told to press Resume",
    TEST_TIMEOUT,
    async () => {
      const host = await pausedToy();
      host.planning = true;
      const resumed = await host.start({ resume: true });
      assert.equal(resumed.executionStatus, "paused");
      assert.match(String(resumed.stoppedBecause), /Plan mode/);
      assert.match(String(resumed.stoppedBecause), /press Resume/);
      assert.doesNotMatch(String(resumed.stoppedBecause), /Start it again/);
    },
  );

  it("every hold of Genex's own on a resumed Loop's start says to press Resume, a new Loop's to start it again", () => {
    for (const hold of ["plan", "person_first", "cant_tell", "busy"]) {
      const held = { reason: "held for agents", hold, label: "Toy editor" };
      assert.match(openStartHeld(held, true), /stays paused: press Resume/, hold);
      assert.doesNotMatch(openStartHeld(held, true), /Start it again/, hold);
      assert.match(openStartHeld(held, false), /Start it again/, hold);
    }
  });

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

/** What a read of the folder's content (`FOLDER_GIT.tree`) answered, and git's state it must leave as it was. */
async function readOf(dir: string, runId: string): Promise<{ code: number; id: string; stderr: string }> {
  const read = await shellIn(dir, FOLDER_GIT.tree(runId));
  return { code: read.code, id: read.stdout.trim(), stderr: read.stderr };
}

/** A repository's objects, refs, hooks and index, as one string: a read that wrote nothing leaves it the same. */
async function gitState(dir: string): Promise<string> {
  const git = async (...args: string[]) => (await shellIn(dir, `git ${args.join(" ")}`)).stdout;
  const gitDir = (await git("rev-parse", "--absolute-git-dir")).trim();
  const index = await readFile(path.join(gitDir, "index")).catch(() => Buffer.alloc(0));
  const hooks = (await readdir(path.join(gitDir, "hooks")).catch(() => [])).sort().join(",");
  const lfs = await readdir(path.join(gitDir, "lfs")).catch(() => null);
  return JSON.stringify({
    objects: await git("count-objects", "-v"),
    refs: await git("for-each-ref"),
    hooks,
    lfs,
    index: index.toString("base64"),
  });
}

/** A git repository at `dir` with one file committed, as an addon kept as its own repository is. */
async function addonRepo(dir: string, file = "tool.gd"): Promise<string> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, file), "extends Node\n");
  return gameRepo(dir);
}

describe("the one Loop's reads of the game folder, given hostile folders", () => {
  it("a folder whose path holds ':' or ';' still reads, and a second edit of a changed file is a change", async () => {
    for (const name of ["Half:Life", "semi;colon"]) {
      const dir = path.join(await tmpDir("one-loop-path-"), name);
      await mkdir(dir);
      await writeFile(path.join(dir, "keep.txt"), "kept\n");
      await writeFile(path.join(dir, "room.txt"), "a room\n");
      // An unchanged file the index holds as clean: its blob is found only in the game's own store.
      const old = new Date(Date.now() - 3_600_000);
      await utimes(path.join(dir, "keep.txt"), old, old);
      await gameRepo(dir);
      const before = await gitState(dir);
      await appendFile(path.join(dir, "room.txt"), "a door\n");
      const first = await readOf(dir, "run_path");
      await appendFile(path.join(dir, "room.txt"), "a key\n");
      const second = await readOf(dir, "run_path");
      assert.equal(first.code, 0, `${name}: ${first.stderr}`);
      assert.equal(second.code, 0, `${name}: ${second.stderr}`);
      assert.notEqual(first.id, second.id, name);
      assert.equal(await gitState(dir), before, `${name}: the game's git is as it was`);
    }
  });

  it("an LFS file is read with no LFS filter: none runs, nothing lands in .git/lfs or its hooks", async () => {
    const dir = await tmpDir("one-loop-lfs-");
    await writeFile(path.join(dir, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
    await gameRepo(dir);
    // The folder's own LFS filter, set to leave a mark should git ever run it.
    await shellIn(dir, `git config filter.lfs.clean 'sh -c "touch ran-clean; cat"'`);
    await shellIn(dir, `git config filter.lfs.process 'sh -c "touch ran-process; cat"'`);
    await shellIn(dir, "git config filter.lfs.required true");
    await writeFile(path.join(dir, "level.bin"), Buffer.alloc(4096, 3));
    // A time ahead of now: git checks such an entry's content again as it writes the tree.
    const ahead = new Date(Date.now() + 3_600_000);
    await utimes(path.join(dir, "level.bin"), ahead, ahead);
    const before = await gitState(dir);
    const first = await readOf(dir, "run_lfs");
    const again = await readOf(dir, "run_lfs");
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.id, again.id, "the same bytes read the same");
    for (const mark of ["ran-clean", "ran-process"])
      assert.equal(await readFile(path.join(dir, mark)).catch(() => null), null, `${mark}: no LFS filter ran`);
    assert.equal(await gitState(dir), before, "no LFS object, hook, object or ref was written");
  });

  it("nested repositories: odd names read, their build output and a repository with no commit don't count, nothing outside is written", async () => {
    const outside = await tmpDir("one-loop-outside-");
    const dir = await tmpDir("one-loop-nested-");
    await writeFile(path.join(dir, ".gitignore"), "Intermediate/\n**/Intermediate/\n");
    await writeFile(path.join(dir, "main.txt"), "main\n");
    await gameRepo(dir);
    for (const name of ["Plugins/Tool", "addons/with space", "addons/-x", 'addons/qu"ote'])
      await addonRepo(path.join(dir, name));
    // A submodule-like folder whose .git is a file naming a git folder outside the game.
    await mkdir(path.join(dir, "linked"));
    await writeFile(path.join(dir, "linked", "l.gd"), "extends Node\n");
    await shellIn(
      path.join(dir, "linked"),
      `git init -q -b main --separate-git-dir ${JSON.stringify(path.join(outside, "linked.git"))}`,
    );
    await shellIn(path.join(dir, "linked"), "git add -A && git -c user.name=t -c user.email=t@t commit -qm l");
    const nestedStates = async () =>
      Promise.all(
        ["Plugins/Tool", "addons/with space", "addons/-x", "linked"].map((name) => gitState(path.join(dir, name))),
      );
    const outsideFiles = async () => JSON.stringify(await readdir(outside, { recursive: true }));
    const [game, nested, linked] = [await gitState(dir), await nestedStates(), await outsideFiles()];
    const base = await readOf(dir, "run_nested");
    assert.equal(base.code, 0, base.stderr);
    // Build output inside a nested repository, under the folder's own ignore rules.
    await mkdir(path.join(dir, "Plugins/Tool/Intermediate/Build"), { recursive: true });
    await writeFile(path.join(dir, "Plugins/Tool/Intermediate/Build/t.obj"), "obj\n");
    assert.equal((await readOf(dir, "run_nested")).id, base.id, "nested build output is no change");
    // A repository the lead or the person just made, with no commit yet.
    await mkdir(path.join(dir, "plug"));
    await shellIn(path.join(dir, "plug"), "git init -q -b main && echo p > p.txt");
    const withEmpty = await readOf(dir, "run_nested");
    assert.equal(withEmpty.code, 0, withEmpty.stderr);
    assert.equal(withEmpty.id, base.id, "a repository with no commit is left out");
    for (const name of ["addons/with space", "addons/-x", "linked"]) {
      const before = (await readOf(dir, "run_nested")).id;
      await appendFile(path.join(dir, name, name === "linked" ? "l.gd" : "tool.gd"), "# edited\n");
      const after = await readOf(dir, "run_nested");
      assert.equal(after.code, 0, `${name}: ${after.stderr}`);
      assert.notEqual(after.id, before, `${name}: an edit there is a change`);
    }
    assert.equal(await gitState(dir), game, "the game's git is as it was");
    assert.deepEqual(await nestedStates(), nested, "each nested repository's git is as it was");
    assert.equal(await outsideFiles(), linked, "nothing was written in the git folder outside the game");
  });

  it("a nested repository that can't be read fails the read, never reading as a change", async () => {
    const dir = await tmpDir("one-loop-broken-");
    await writeFile(path.join(dir, "main.txt"), "main\n");
    await gameRepo(dir);
    await addonRepo(path.join(dir, "addons", "tool"));
    assert.equal((await readOf(dir, "run_broken")).code, 0);
    await writeFile(path.join(dir, "addons", "tool", ".git", "index"), "not an index\n");
    const read = await readOf(dir, "run_broken");
    assert.notEqual(read.code, 0, "the read fails");
    assert.equal(read.id, "", "no id is answered");
  });

  it("a read clears what killed reads of other runs left long ago, and keeps a young one and its run's own store", async () => {
    const dir = await tmpDir("one-loop-leftovers-");
    await writeFile(path.join(dir, "main.txt"), "main\n");
    await gameRepo(dir);
    const gitDir = path.join(dir, ".git");
    const long = new Date(Date.now() - 60 * MINUTE);
    for (const name of ["genex-turn-other.index.12.objects", "genex-turn-other.objects", "genex-turn-young.objects"])
      await mkdir(path.join(gitDir, name), { recursive: true });
    for (const name of ["genex-turn-other.index.12.objects", "genex-turn-other.objects"])
      await utimes(path.join(gitDir, name), long, long);
    assert.equal((await readOf(dir, "run_mine")).code, 0);
    const left = (await readdir(gitDir)).filter((name) => name.startsWith("genex-turn-")).sort();
    assert.deepEqual(left, ["genex-turn-run_mine.objects", "genex-turn-young.objects"]);
  });
});

describe("the one Loop's reads of the game folder", () => {
  it(
    "a read of the folder's content a killed read left locked still reads: the lead's edit is work",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, {
        facts: GODOT,
        turns: [
          async ({ host }) => {
            await writeFile(path.join(host.dir, "room.txt"), "a room\n");
            return undefined;
          },
          finishes,
        ],
      });
      // An earlier read of this run's, killed by its timeout, left its index's lock behind.
      await writeFile(path.join(host.dir, ".git", `genex-turn-${host.run.runId}.index.lock`), "");
      await host.start();
      assert.match(String(host.prompts()[1]), /Carry on/, "the edit read as work");
    },
  );

  it("a read of the folder's content at a turn's edge writes nothing into the game's own git", async () => {
    const host = await hostOn(Project.GodotGame, { facts: GODOT });
    const objects = () => host.git("count-objects", "-v");
    const tree = async () => {
      const read = await shellIn(host.dir, FOLDER_GIT.tree(host.run.runId));
      assert.equal(read.code, 0, read.stderr);
      return read.stdout.trim();
    };
    // A large file Genex's checkpoints leave out, and a tracked file changed.
    await writeFile(path.join(host.dir, "big.bin"), Buffer.alloc(2 * 1024 * 1024, 7));
    await appendFile(path.join(host.dir, "project.godot"), "\n; edited\n");
    const before = await objects();
    const first = await tree();
    await appendFile(path.join(host.dir, "big.bin"), "more");
    const second = await tree();
    assert.notEqual(first, second, "a second edit of a changed file reads as a change");
    assert.equal(await objects(), before, "no object was written into the game's git");
    const leftovers = async () =>
      (await readdir(path.join(host.dir, ".git"))).filter((name) => name.startsWith("genex-turn-"));
    assert.deepEqual(await leftovers(), [`genex-turn-${host.run.runId}.objects`], "only the run's own store stays");
    const dropped = await shellIn(host.dir, FOLDER_GIT.dropTurnStore(host.run.runId));
    assert.equal(dropped.code, 0, dropped.stderr);
    assert.deepEqual(await leftovers(), [], "nothing of the reads is left once the Loop is over");
  });

  it("a Loop's close leaves nothing of its reads of the folder in the game's git", TEST_TIMEOUT, async () => {
    const host = await hostOn(Project.GodotGame, { facts: GODOT, turns: [editsOnly(1), finishes] });
    await host.start();
    const leftovers = (await readdir(path.join(host.dir, ".git"))).filter((name) => name.startsWith("genex-turn-"));
    assert.deepEqual(leftovers, []);
  });

  it("edits made only inside a nested repository count as the lead's work", TEST_TIMEOUT, async () => {
    const editsTool =
      (n: number): LoopTurn =>
      async ({ host }) => {
        await appendFile(path.join(host.dir, "addons", "tool", "tool.gd"), `# step ${n}\n`);
        return undefined;
      };
    const host = await hostOn(Project.GodotGame, {
      facts: GODOT,
      run: { budgets: { wallClockMs: 30 * MINUTE, completionPolicy: "goal" } },
      turns: [editsTool(1), editsTool(2), finishes],
    });
    // An addon kept as a repository of its own inside the game folder.
    const addon = path.join(host.dir, "addons", "tool");
    await mkdir(addon, { recursive: true });
    await writeFile(path.join(addon, "tool.gd"), "extends Node\n");
    await gameRepo(addon);
    const report = await host.start();
    assert.match(String(host.prompts()[1]), /Carry on/);
    assert.match(String(host.prompts()[2]), /Carry on/);
    assert.equal(report.victory, true, String(report.stoppedBecause));
  });

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

describe("the open lead's finish words", () => {
  it("a timed Loop's no's stop it only once little time is left, an ∞ Loop's at the cap, and a picture outranks the files", async () => {
    const { FINISH_TIME_LEFT_MS, MAX_FINISH_REJECTIONS } = await import(
      "../../src/harness-seed/loop/finish-contract.ts"
    );
    const finishLine = (untilFinish: boolean) =>
      openBrief({
        goal: "A level.",
        folder: "/games/level",
        folderLabel: "level",
        facts: GODOT,
        holds: null,
        carried: [],
        references: [],
        workerTypes: [],
        appSaved: false,
        restart: false,
        cppRestart: false,
        judge: false,
        savePoints: [],
        now: 0,
        softDeadline: 60 * MINUTE,
        finalDeadline: 60 * MINUTE,
        untilFinish,
        skills: [],
      })
        .split("\n\n")
        .find((one) => one.startsWith("FINISH:")) ?? "";
    const timed = finishLine(false);
    const endless = finishLine(true);
    assert.ok(timed.includes(`while over ${FINISH_TIME_LEFT_MS / MINUTE} minutes are left, no's never stop the Loop`));
    assert.match(timed, /a new claim needs a new save point and new proof/);
    assert.ok(endless.includes(`${MAX_FINISH_REJECTIONS} no's in a row stop the Loop.`));
    assert.doesNotMatch(endless, /never stop/);
    for (const line of [timed, endless])
      assert.match(line, /Your own pictures of the running project outrank what its files say/);
  });
});
