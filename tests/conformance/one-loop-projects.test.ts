/**
 * A Loop on a plugin's project and on a project with no plugin, through the real studio: Genex fires
 * the plugin's moments, runs its observer and its worker type, and ends on the reviewer's yes — none
 * of it named in the harness.
 *
 * The real core and harness, the person's own steps (the toy plugin installed from its folder and
 * turned on, the project opened, a message sent with Loop on and no hours), and one fake delegated
 * engine playing the chat, the lead, its workers and the reviewer. The plugin's calls are read where
 * the host makes them (the registry's `tool`), so the plugin itself is the one the person installs.
 */
import assert from "node:assert/strict";
import { cp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { PluginSourceKind } from "../../src/shared/plugins.ts";
import type { DelegateRequest, DelegateResult, LiveToolResult } from "../../src/substrate/engines/types.ts";
import { copyProject, Project, TOY_PLUGIN, TOY_PLUGIN_ID } from "../helpers/project-fixtures.ts";
import { reviewerAnswer } from "../helpers/reviewer.ts";
import { customEvents, makeFakePreview, type Rig, startRig, waitForLog } from "../helpers/studio-rig.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** No Loop here may hang the suite: each is over in well under a minute when it works. */
const RIG_TIMEOUT_MS = 240_000;
/** How long a test waits for the Loop's close. */
const CLOSE_WAIT_MS = 180_000;
/** The run's end moment fires after its close is written: how often, and how many times, a test looks for it. */
const END_POLL_MS = 50;
const END_POLLS = 600;
const ENGINE = "claude-code";
const rigs: Rig[] = [];
afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.stop().catch(() => {})));
});

/** What one delegation was for, read off the request the way the host hands it to an engine. */
const Seat = {
  Chat: "chat",
  Lead: "lead",
  Worker: "worker",
  Reviewer: "reviewer",
  Other: "other",
} as const;
type Seat = (typeof Seat)[keyof typeof Seat];

function seatOf(request: DelegateRequest): Seat {
  if (request.reviewer) return Seat.Reviewer;
  if (request.director) return Seat.Lead;
  if (request.worker) return Seat.Worker;
  return request.interviewTools?.length ? Seat.Chat : Seat.Other;
}

const text = (result: LiveToolResult): string => (typeof result === "string" ? result : result.text);

/** One plugin call the host made: the tool's full name, and the moment or the observer it was for. */
interface PluginCall {
  name: string;
  moment: string | null;
  observer: string | null;
  project: string;
}

/** Record every call the host makes into a plugin, in order, while still making it. */
function recordPluginCalls(rig: Rig): PluginCall[] {
  const calls: PluginCall[] = [];
  const registry = rig.core.plugins;
  const tool = registry.tool.bind(registry);
  registry.tool = ((name, args, binding, ...rest) => {
    const hook = (binding as { hook?: { on?: string } }).hook;
    const observe = (binding as { observe?: { observer?: string } }).observe;
    calls.push({
      name,
      moment: hook?.on ?? null,
      observer: observe?.observer ?? null,
      project: binding.project,
    });
    return tool(name, args, binding, ...rest);
  }) as typeof registry.tool;
  return calls;
}

/** A turn of one seat: it may call its live tools; what it returns joins the session's result. */
type Script = (
  request: DelegateRequest,
  call: (name: string, args: Record<string, unknown>) => Promise<string>,
) => Promise<void>;

/** The fake delegated engine: the chat starts the Loop, the reviewer says yes, the rest follows `scripts`. */
function loopEngine(rig: Rig, scripts: { lead: Script[]; worker: Script }) {
  const requests: Array<{ seat: Seat; request: DelegateRequest }> = [];
  let leadTurns = 0;
  rig.core.engines.register({
    id: ENGINE,
    label: ENGINE,
    kind: "delegated",
    status: async () => ({ code: "ready", detail: "" }),
    models: async () => [],
    complete: async () => ({
      message: { role: "assistant", content: "{}" },
      usage: {},
      model: "fixture",
      engine: ENGINE,
      stopReason: "stop",
    }),
    delegate: async (request: DelegateRequest): Promise<DelegateResult> => {
      const seat = seatOf(request);
      requests.push({ seat, request });
      if (seat === Seat.Reviewer) return reviewerAnswer("yes", ["It is there."], ENGINE) as DelegateResult;
      const call = async (name: string, args: Record<string, unknown>) => {
        const onLiveTool = request.onLiveTool;
        if (!onLiveTool) throw new Error(`no live tools on this ${seat} turn`);
        return text(await onLiveTool(name, args));
      };
      if (seat === Seat.Lead) await scripts.lead[leadTurns++]?.(request, call);
      if (seat === Seat.Worker) await scripts.worker(request, call);
      const sessionId = request.resume ?? (seat === Seat.Worker ? `worker-${requests.length}` : "chat-session");
      return {
        ok: true,
        engine: ENGINE,
        turns: 1,
        usage: {},
        sessionId,
        summary: `${seat} done`,
        ...(seat === Seat.Chat
          ? { studioToolCalls: [{ name: "start_autopilot", args: { goal: "a garden with a pond" } }] }
          : {}),
      };
    },
  } as never);
  return { requests, seat: (seat: Seat) => requests.filter((r) => r.seat === seat).map((r) => r.request) };
}

/** A rig whose game is a copy of one project fixture, opened as the person opens a folder, with its chat. */
async function openedProject(project: Project, plugin?: string) {
  const rig = await startRig(
    { replies: [] },
    { previewPoolMax: 3, createHeadlessPreview: async () => makeFakePreview() },
  );
  rigs.push(rig);
  if (plugin) {
    await rig.core.plugins.installLocal(plugin, PluginSourceKind.Local, []);
    const id = JSON.parse(await readFile(path.join(plugin, "plugin.json"), "utf8")).id as string;
    await rig.core.plugins.setEnabled(id, true);
  }
  const game = await rig.core.adoptProject(
    await copyProject(project, await realpath(await tmpDir("one-loop-projects-"))),
  );
  const threadId = await rig.core.threadForGame(game.name);
  return { rig, game, threadId };
}

/** Send the message with Loop on and no hours (∞), and wait for the Loop's close. */
async function loopUntilClosed(rig: Rig, threadId: string) {
  await rig.core.sendUserMessage("make a garden with a pond", { thread: threadId, engine: ENGINE, autopilot: {} });
  const events = await waitForLog(
    rig.core,
    (log) => customEvents(log, "run_finished").length >= 1,
    CLOSE_WAIT_MS,
    "the Loop's close",
  );
  return { events, finished: customEvents(events, "run_finished") };
}

/** Once a call `matches` is recorded (the run's end fires after its close is written); false when none came. */
async function untilCalled(calls: PluginCall[], matches: (call: PluginCall) => boolean): Promise<boolean> {
  for (let poll = 0; poll < END_POLLS; poll++) {
    if (calls.some(matches)) return true;
    await sleep(END_POLL_MS);
  }
  return false;
}

/** Whether a file exists. */
const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

/** The toy plugin copied under a new id with every tool renamed: what Genex does must follow the names alone. */
async function renamedToyPlugin(): Promise<{ dir: string; id: string; rename: (tool: string) => string }> {
  const dir = path.join(await tmpDir("toy-renamed-"), "toy-renamed");
  await cp(TOY_PLUGIN, dir, { recursive: true });
  const rename = (tool: string) => `r-${tool}`;
  const manifest = JSON.parse(await readFile(path.join(dir, "plugin.json"), "utf8"));
  manifest.id = "toy-renamed";
  manifest.engine.id = "toy-renamed";
  manifest.name = "Toy Renamed";
  for (const tool of manifest.tools) tool.name = rename(tool.name);
  for (const hook of manifest.hooks) hook.tool = rename(hook.tool);
  for (const observer of manifest.observers) observer.tool = rename(observer.tool);
  for (const lock of manifest.locks) lock.personFirst = rename(lock.personFirst);
  for (const skill of manifest.skills) skill.tools = skill.tools.map(rename);
  for (const type of manifest.workerTypes) type.tools = type.tools.map(rename);
  for (const judge of manifest.judges) if (judge.probe) judge.probe = rename(judge.probe);
  await writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest, null, 2));
  return { dir, id: manifest.id, rename };
}

/**
 * The toy Loop's lead: a save point after its first room, a stray file it rewinds away, a worker of
 * the plugin's type once the folder is back, that worker's copy merged, and its claim.
 */
function toyLead(answers: Record<string, string>): Script[] {
  return [
    async (request, call) => {
      const dir = String(request.director?.root);
      await writeFile(path.join(dir, "scenes", "garden.toyscene"), "a garden\n");
      answers.saved = await call("save_point", { label: "Garden", summary: "the garden scene" });
      await writeFile(path.join(dir, "scenes", "stray.toyscene"), "a stray\n");
      answers.rewind = await call("rewind", { label: "Garden" });
    },
    async (_request, call) => {
      answers.started = await call("worker_start", { title: "Pond", task: "Add a pond scene", type: "scene" });
    },
    async (_request, call) => {
      answers.waited = await call("worker_wait", { seconds: "60" });
      answers.marked = await call("worker_mark", { id: "w1", verdict: "used" });
      answers.finish = await call("finish", { summary: "The garden has a pond.", proof: "scenes/pond.toyscene" });
    },
  ];
}

/** The scene worker: it writes the pond in its own copy. */
const pondWorker: Script = async (request) => {
  await writeFile(path.join(request.cwd, "scenes", "pond.toyscene"), "a pond\n");
};

/** The calls into one plugin, as `<moment|observer|tool>:<tool>`, health polls left out. */
function trailOf(calls: PluginCall[], pluginId: string) {
  const own = calls.filter((call) => call.name.startsWith(`${pluginId}__`));
  const steps = own
    .filter((call) => call.moment !== "health")
    .map((call) => `${call.moment ?? (call.observer ? "observer" : "tool")}:${call.name.slice(pluginId.length + 2)}`);
  return { steps, health: own.filter((call) => call.moment === "health").map((call) => call.name) };
}

/** Where `want` appears in `trail` in order, or -1 at the first that doesn't. */
function inOrder(trail: string[], want: string[]): number[] {
  const at: number[] = [];
  let from = 0;
  for (const step of want) {
    const index = trail.indexOf(step, from);
    at.push(index);
    if (index < 0) return at;
    from = index + 1;
  }
  return at;
}

/** Run the toy Loop on a plugin and check what Genex did with it, by the plugin's own tool names. */
async function toyLoop(plugin: { dir: string; id: string; rename: (tool: string) => string }) {
  const { rig, game, threadId } = await openedProject(Project.ToyProject, plugin.dir);
  const calls = recordPluginCalls(rig);
  const answers: Record<string, string> = {};
  const engine = loopEngine(rig, { lead: toyLead(answers), worker: pondWorker });
  const { events, finished } = await loopUntilClosed(rig, threadId);
  assert.equal(finished.length, 1, "the Loop closed once");
  assert.equal(finished[0]?.victory, true, `${String(finished[0]?.stoppedBecause)} ${JSON.stringify(answers)}`);
  const name = plugin.rename;
  const ended = await untilCalled(calls, (call) => call.moment === "run.end");
  assert.ok(ended, "the run's end moment fired");
  const { steps: trail, health } = trailOf(calls, plugin.id);
  // The person's message that started the Loop took its own checkpoints first, with the one step
  // the plugin opts in to for chat messages, before its answer and (flipped: also) after it; the
  // run's own steps follow them.
  const message = `checkpoint.before:${name("save-scenes")}`;
  assert.equal(trail[0], message, `the message's checkpoint step comes first: ${trail.join(", ")}`);
  const leading = trail.findIndex((step) => step !== message);
  const steps = trail.slice(leading);
  const want = [
    `run.prepare:${name("editor-state")}`,
    `checkpoint.before:${name("save-scenes")}`,
    `checkpoint.after:${name("capture")}`,
    `restore.after:${name("reload-scenes")}`,
    `observer:${name("capture")}`,
    `run.end:${name("end-editor")}`,
  ];
  assert.ok(!inOrder(steps, want).includes(-1), `the plugin's steps in order: ${steps.join(", ")}`);
  assert.equal(steps[0], want[0], "the run's start comes first");
  assert.equal(steps.at(-1), want.at(-1), "and its end last");
  assert.ok(health.length > 0, "the app's health was polled");
  assert.ok(health.every((tool) => tool === `${plugin.id}__${name("editor-state")}`));
  // The save point kept the garden, and the rewind put the folder back to it.
  assert.match(answers.saved ?? "", /Garden/);
  assert.equal(await exists(path.join(game.dir, "scenes", "stray.toyscene")), false, "the rewind took the stray away");
  assert.equal(await readFile(path.join(game.dir, "scenes", "garden.toyscene"), "utf8"), "a garden\n");
  // The worker of the plugin's type worked in its own copy, and its copy was merged into the folder.
  const [worker] = engine.seat(Seat.Worker);
  assert.ok(worker, "a worker ran");
  assert.match(answers.started ?? "", /\(copy\)/, "the plugin's type chose the copy");
  assert.notEqual(path.resolve(worker.cwd), game.dir, "in a copy of its own");
  const workerTools = (worker.liveTools ?? []).map((tool) => tool.name);
  assert.ok(workerTools.includes(`${plugin.id}__${name("build")}`), `with its type's tool: ${workerTools.join(", ")}`);
  assert.equal(await readFile(path.join(game.dir, "scenes", "pond.toyscene"), "utf8"), "a pond\n", answers.marked);
  // The observer fed the evidence, and the reviewer's yes ended the Loop.
  const captures = customEvents(events, "observer_capture").filter((c) =>
    String(c.observer ?? "").startsWith(plugin.id),
  );
  assert.ok(
    captures.some((c) => c.observer === `${plugin.id}/viewport`),
    JSON.stringify(captures),
  );
  const steps2 = customEvents(events, "finish_check").map((check) => check.step);
  assert.ok(steps2.includes("accepted"), steps2.join(", "));
  assert.match(answers.finish ?? "", /Accepted/);
  return { rig, game, engine, events };
}

describe("a Loop on a plugin's project, through the real studio", () => {
  it("a Loop on the toy project with the toy plugin on needs no seed change: the plugin's hooks run at run.prepare, checkpoint.before and .after, restore.after and run.end, its observer feeds the evidence, and the Loop ends on the reviewer's finish check", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    await toyLoop({ dir: TOY_PLUGIN, id: TOY_PLUGIN_ID, rename: (tool) => tool });
  });

  it("the same Loop on a renamed copy of the plugin calls the renamed tools at the same moments", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    await toyLoop(await renamedToyPlugin());
  });
});

describe("a Loop on a project with no plugin, through the real studio", () => {
  it("a Loop on the Godot folder with no plugin runs with generic tools and ends on the finish check", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    const { rig, game, threadId } = await openedProject(Project.GodotGame);
    const calls = recordPluginCalls(rig);
    const answers: Record<string, string> = {};
    const engine = loopEngine(rig, {
      lead: [
        async (request, call) => {
          await writeFile(path.join(String(request.director?.root), "scenes", "door.tscn"), "a door\n");
          answers.saved = await call("save_point", { label: "Door", summary: "the door scene" });
          answers.started = await call("worker_start", { title: "Survey", task: "List the scenes", isolation: "read" });
        },
        async (_request, call) => {
          answers.waited = await call("worker_wait", { seconds: "60" });
          answers.finish = await call("finish", { summary: "The door is in.", proof: "scenes/door.tscn" });
        },
      ],
      worker: async () => {},
    });
    const { events, finished } = await loopUntilClosed(rig, threadId);
    assert.equal(finished.length, 1);
    assert.equal(finished[0]?.victory, true, `${String(finished[0]?.stoppedBecause)} ${JSON.stringify(answers)}`);
    assert.deepEqual(
      calls.filter((call) => call.project === game.name),
      [],
      "no plugin step ran for the folder",
    );
    assert.ok(!rig.preview.loads.includes(game.name), "the preview never loaded the folder");
    for (const file of ["index.html", path.join("src", "studio.js"), path.join("docs", "CONTRACT.md")])
      assert.equal(await exists(path.join(game.dir, file)), false, `${file} was never written`);
    const leads = engine.seat(Seat.Lead);
    assert.ok(leads.length >= 2, `${leads.length} lead turns`);
    for (const lead of leads) {
      const tools = (lead.liveTools ?? []).map((tool) => tool.name);
      assert.ok(!tools.includes("look") && !tools.includes("computer"), `no window: ${tools.join(", ")}`);
      assert.equal(await realpath(lead.cwd), game.dir, "the lead works in the folder");
      assert.notEqual(lead.readOnly, true);
    }
    const [reader] = engine.seat(Seat.Worker);
    assert.ok(reader, "the reader worker ran");
    assert.equal(await realpath(reader.cwd), game.dir, "a reader works in place");
    assert.match(answers.saved ?? "", /Door/);
    assert.ok(customEvents(events, "finish_check").some((check) => check.step === "accepted"));
    assert.match(answers.finish ?? "", /Accepted/);
  });
});
