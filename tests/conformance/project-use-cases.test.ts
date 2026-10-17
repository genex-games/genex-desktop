/**
 * The ten use cases of any project, as acceptance tests: a new web game, a new Unreal game with the
 * plugin on or off, someone's web folder, an Unreal editor plugin, a Godot game, an assets-only
 * folder, an Unreal game with a web site, a Genex plugin for an engine Genex lacks, and a Loop on
 * any of them. Each runs on a synthetic folder from `tests/fixtures/projects/` (copied, with the
 * files its engine writes while it runs) or the toy engine plugin. A whole Loop on the toy project
 * and on the Godot folder needs the harness, so it is proven through the real studio in
 * `one-loop-projects.test.ts`.
 *
 * A test marked `todo: "phase N: …"` is a target: its body runs today and fails for the reason it
 * names, without failing the suite; phase N makes it pass and removes the mark. An `it.todo` names a
 * behaviour with no interface yet. Find a phase's marks with `grep -n '"phase N:' <this file>`.
 * A marked test whose body passes still counts as todo, so after each phase run this file with
 * `--test-reporter=spec` and `grep -E '^\s*✔ .*# phase [0-9]+:'`: every hit is a target already
 * met, and its mark comes off in that phase.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { runDelegatedTurn } from "../../src/harness-seed/loop/delegated-turn.ts";
import { chatWorkerTool, closeChatWorkers, openChatWorkers } from "../../src/harness-seed/loop/workers/chat-workers.ts";
import { WORKER_TOOLS } from "../../src/harness-seed/loop/workers/specs.ts";
import { DispatchActionType, HarnessCapability } from "../../src/shared/protocol.ts";
import { RunEvent } from "../../src/harness-seed/loop/run-events.ts";
import { UNREAL_NEW_GAME_TOOL } from "../../src/harness-seed/loop/unreal-prompts.ts";
import { HostMethod } from "../../src/shared/harness-api.ts";
import { UiEvent } from "../../src/shared/ui-events.ts";
import { type EventEnvelope, EventKind, SnapshotScope } from "../../src/shared/event-log.ts";
import { ObserverLive, PREVIEW_OBSERVER } from "../../src/shared/observers.ts";
import { latestCaptures, liveViewFor, liveViewsFor } from "../../src/renderer/live-views.ts";
import { stageTabs } from "../../src/renderer/panels/stage/stage-tabs.ts";
import { STAGE_WORDS } from "../../src/renderer/words.ts";
import { projectKindLabel } from "../../src/renderer/project-kind.ts";
import type { GameProject } from "../../src/shared/game-project.ts";
import { buildRunGraph } from "../../src/renderer/run-graph.ts";
import { isAgentTool, PluginSourceKind } from "../../src/shared/plugins.ts";
import { FolderHolds } from "../../src/shared/project-facts.ts";
import { FindNext, PluginOffer } from "../../src/shared/project-tools.ts";
import { inspectPackage, validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { PluginRegistry } from "../../src/substrate/plugins/registry.ts";
import { buildContractorBrief } from "../../src/harness-seed/loop/chat-session.ts";
import { runUnrealLead } from "../../src/harness-seed/loop/unreal/lead.ts";
import { CustomEvent, customRecord } from "../../src/shared/custom-events.ts";
import {
  checkFinish,
  type FinishOutcome,
  type FinishScope,
  type FinishTally,
  newTally,
} from "../../src/harness-seed/loop/finish-check.ts";
import { FinishCheckStep, MAX_FINISH_REJECTIONS, ObserverSource } from "../../src/harness-seed/loop/finish-contract.ts";
import { GRACE_MS } from "../../src/harness-seed/loop/time-cap.ts";
import type { Evidence } from "../../src/harness-seed/loop/evidence.ts";
import type { Run } from "../../src/harness-seed/types/harness.d.ts";
import { PERMISSION_MODES, PermissionMode, type ToolPermissionEvent } from "../../src/shared/permissions.ts";
import { APP_LOOK_TOOL_NAME, JobTool } from "../../src/shared/jobs.ts";
import { stubAppLook } from "../../src/substrate/app-look.ts";
import type { JobSpawn } from "../../src/substrate/jobs.ts";
import type {
  DelegateRequest,
  PermissionAsk,
  PermissionReply,
  SteerMessage,
  WorkerSeat,
} from "../../src/substrate/engines/types.ts";
import { type NeverTouchHit, NeverTouchKind, neverTouchVerdict } from "../../src/substrate/engines/never-touch.ts";
import { MAX_WORKERS_AT_ONCE, WorkerIsolation, type WorkerType } from "../../src/shared/workers.ts";
import unrealManifest from "../../src/plugins/unreal/plugin.json" with { type: "json" };
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";
import { type CtxHandler, ctxRecorder } from "../helpers/ctx-recorder.ts";
import { gitFile } from "../helpers/git.ts";
import { copyOfExample, PLUGIN_SDK_BACKEND, personAllowsLocalTools } from "../helpers/plugins.ts";
import { unrealBackendFixture } from "../helpers/unreal-fake-engine.ts";
import { writeSkillExample } from "../helpers/plugin-author.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { Changes, until } from "../helpers/worker-chat.ts";
import { buildsOnly, leadHost, RUN, textOf, type Turn } from "../helpers/unreal-lead-host.ts";
import {
  CHAT_SESSION,
  gameRepo,
  type LoopHost,
  type LoopManifest,
  type LoopTurn,
  loopHost,
} from "../helpers/loop-host.ts";
import { fakeFinishReview, reviewerAnswer } from "../helpers/reviewer.ts";
import {
  copyProject,
  factIds,
  factsAt,
  liteHost,
  Project,
  PROJECTS,
  TOY_PLUGIN,
  TOY_PLUGIN_ID,
  toyRegistry,
} from "../helpers/project-fixtures.ts";

const CLAUDE = "claude-code";
/** Genex's tool that writes the web starter into a project with no kind yet, by the name a session calls. */
const START_WEB_GAME = "start_web_game";
/** Genex's tools that look for a Genex plugin and show the person a card to turn it on. */
const PLUGINS_FIND = "plugins_find";
const PLUGINS_SUGGEST = "plugins_suggest";
/** The record of that card in the chat's log. */
const PLUGIN_SUGGESTED = "plugin_suggested";
/** Genex's tool that starts a worker, by the name a session calls. */
const WORKER_START = "worker_start";
const ASK = "add an enemy that chases the player";
/** What Genex keeps in any project of its own: its record, its ignore file and the repository. */
const BOOKKEEPING = [".git", ".gitignore", "studio.json"];
/** The bundled Unreal plugin's id: off in this core, as it ships, until a case turns it on. */
const UNREAL_PLUGIN = "unreal";
const GENEX_PLUGIN = "genex";

/** A Loop on a copy of the Unreal game, through the one Loop, is over in seconds when it works. */
const LOOP_TIMEOUT = { timeout: 60_000 };
const HOUR = 3_600_000;
/** The Unreal plugin as the fake hook bus plans its moments, and its C++ worker type as `plugins.workerTypes` lists it. */
const UNREAL_LOOP_MANIFEST = unrealManifest as unknown as LoopManifest;
const CPP_WORKER: WorkerType = {
  pluginId: "unreal",
  id: "cpp",
  description: "Writes C++ in a copy",
  tools: ["unreal__check-part"],
  isolation: WorkerIsolation.Copy,
};
let unrealLoops = 0;

/** A Loop's host on a copy of the Unreal game made a git repository, with the Unreal plugin's moments. */
async function unrealLoopHost(turns: LoopTurn[], run: Record<string, unknown> = {}): Promise<LoopHost> {
  const dir = await gameRepo(await copyProject(Project.UnrealGame, await tmpDir("use-case-loop-")));
  unrealLoops += 1;
  return loopHost({
    dir,
    facts: [{ id: "unreal-project", path: "." }],
    manifest: UNREAL_LOOP_MANIFEST,
    workerTypes: [CPP_WORKER],
    turns,
    run: { runId: `run-use-case-${unrealLoops}`, ...run },
  });
}

/** A lead turn that claims the goal is reached, naming the project file as proof. */
const finishesLoop: LoopTurn = async ({ tool }) => {
  await tool("finish", { summary: "The level is built and the door opens.", proof: "Lantern.uproject" });
  return undefined;
};

let lite: CoreLite;
/** How often, and how many times, a case looks for a consent card before it says none came. */
const CARD_POLL_MS = 20;
const CARD_TRIES = 250;
/** Every job the core started, as asked: its process is a shell that exits at once, never the command. */
const jobsSpawned: Array<Parameters<JobSpawn>[0]> = [];
const recordingJobSpawn: JobSpawn = async (request) => {
  jobsSpawned.push(request);
  return { child: spawn("/bin/sh", ["-c", "exit 0"], { detached: true, stdio: "pipe" }), sandboxed: false };
};
/** The core announced a card (`UiEvent.ToolPermission`): a case waiting for one reads the rows again. */
const cards = new Changes();
/** Where each case's copy goes: beside the games folder, since every folder in it is a game of its own. */
let cases: string;
before(async () => {
  const root = await realpath(await tmpDir("studio-use-cases-"));
  cases = path.join(root, "cases");
  await mkdir(cases);
  lite = await coreLite({
    gamesRoot: path.join(root, "games"),
    executionPolicy: { allowedProjectRoot: root, runBackgroundImprovement: false },
    // Looks go to the stub and jobs to a recording spawn: nothing here sees the screen or runs a build.
    appLook: stubAppLook(),
    jobSpawn: recordingJobSpawn,
    onUiEvent: (event) => {
      if (event.type === UiEvent.ToolPermission) cards.notify();
    },
  });
});
after(async () => {
  // A core-lite never started, so its stop() leaves a plugin backend to the test.
  lite.core.plugins.cancel();
  await lite.close();
});

/** The runs a Loop's workers belong to, in these cases: one per game. */
const LOOP_RUN = "run_loop_workers";
let loopGames = 0;

/**
 * A game whose chat started a Loop that is running, a copy of the game in that run's own folder, and
 * an engine that asks (`permissionPrompts`) whose session does `during` with its request.
 */
async function loopWithWorker(
  t: { after: (fn: () => Promise<void>) => void },
  existing?: { name: string; dir: string },
) {
  const { core } = lite;
  const made = ++loopGames;
  const game = existing ?? (await core.createGame(`Loop Workers ${made}`));
  const other = await core.createGame(`Loop Workers Other ${loopGames}`);
  const threadId = await core.threadForGame(game.name);
  const runId = `${LOOP_RUN}_${loopGames}`;
  await core.append(
    [
      { type: "custom", event_type: "run_registered", payload: { runId, project: game.name, mode: "director" } },
      { type: "custom", event_type: "run_started", payload: { runId, project: game.name } },
    ] as never,
    threadId,
  );
  const copy = path.join(core.layout.scratch, "autopilot", runId, "stairs");
  await mkdir(path.dirname(copy), { recursive: true });
  core.snapshots.register({ name: game.name, dir: game.dir });
  await core.snapshots.worktreeAt(game.name, "HEAD", copy);
  const seen: DelegateRequest[] = [];
  let during: (request: DelegateRequest) => Promise<void> = async () => {};
  core.engines.register({
    id: CLAUDE,
    label: "fixture",
    kind: "delegated",
    permissionPrompts: true,
    // A chat's own session takes steered messages mid-turn when its turn says so (`request.steer`).
    steersMidTurn: true,
    status: async () => ({ code: "ready", detail: "fixture" }),
    models: async () => [],
    delegate: async (request: DelegateRequest) => {
      seen.push(request);
      await during(request);
      return { ok: true, engine: CLAUDE, summary: "fixture", turns: 1, usage: {} };
    },
  } as never);
  t.after(async () => {
    await core.mcp.close().catch(() => {});
  });
  const api = lite.api() as unknown as Record<string, (params: unknown) => Promise<unknown>>;
  /** A worker of the Loop delegated in its copy. */
  const worker = () =>
    api["engine.delegate"]?.({
      engine: CLAUDE,
      project: game.name,
      threadId,
      prompt: "build the stairs",
      cwd: copy,
      worker: { id: "stairs", title: "Stair builder", runId },
    });
  const rows = async () =>
    (await core.store.listEvents(threadId)).flatMap((event) => {
      const custom = customRecord(event.data);
      return custom?.event_type === "tool_permission" ? [custom.payload as unknown as ToolPermissionEvent] : [];
    });
  /** The first card in the chat, once the core announced it. */
  const firstCard = async (): Promise<ToolPermissionEvent> => {
    let card: ToolPermissionEvent | undefined;
    await until(cards, async () => {
      card = (await rows())[0];
      return card !== undefined;
    });
    if (!card) throw new Error("no card reached the chat");
    return card;
  };
  return {
    game,
    other,
    threadId,
    runId,
    api,
    seen,
    worker,
    rows,
    firstCard,
    whileRunning: (does: typeof during) => {
      during = does;
    },
  };
}

/** The real path of a path that may not exist yet: its nearest existing folder's, then the rest. */
async function realNearest(target: string): Promise<string> {
  const real = await realpath(target).catch(() => null);
  if (real) return real;
  return path.join(await realNearest(path.dirname(target)), path.basename(target));
}

/** A fresh folder for one case, so two cases never share a copy of one project. */
const caseDir = () => mkdtemp(path.join(cases, "case-"));

/** A copy of the project fixture, opened as a game the way the Open Game sheet does. */
async function adopted(name: Project) {
  const dir = await copyProject(name, await caseDir());
  const game = await lite.core.adoptProject(dir);
  return { dir, game };
}

/** The game as the core lists it (what the harness's `game.list` answers). */
async function listed(name: string): Promise<object> {
  const game = (await lite.core.games.list()).find((g) => g.name === name);
  assert.ok(game, `${name} is listed`);
  return game;
}

/** The run a use case's finish checks belong to. */
const FINISH_RUN_ID = "run_finish_check";
/** The lead's claim at a use case's finish. */
const FINISH_CLAIM = {
  summary: "The game meets the request.",
  proof: ["reports/tests.txt"],
  hookNotes: [],
  hookImages: [],
};
/** A render as a prop's turntable writes it: a PNG's first bytes. */
const RENDER_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
/** A preview pass's answer: one still with pixels. */
const PREVIEW_PASS = {
  ok: true,
  problems: [],
  warnings: [],
  consoleErrors: [],
  shots: [{ camera: "default", path: "/runs/finish/default.jpg", base64: "PREVIEW" }],
  motion: [],
} as unknown as Evidence;

/** A reviewer's answer as its session's summary. */
const reviewerSays = (verdict: string, reasons: string[]) => ({
  ok: true,
  engine: CLAUDE,
  turns: 1,
  usage: {},
  summary: JSON.stringify({ verdict, reasons }),
});

/**
 * A Loop's finish check on the lite core (`liteHost`): Claude Code holds the reviewer's sessions and
 * answers from `answers` in order, a scripted preview pass stands in for the evidence pass, and every
 * record is kept: the harness's, and the host's finish check records (`fakeFinishReview`).
 * `reviewers` holds the reviewer sessions the host started, with their params.
 */
function finishHost(game: object, dir: string, answers: unknown[], handlers: Record<string, CtxHandler> = {}) {
  const records: Array<{ event_type: string; payload: Record<string, unknown> }> = [];
  const checks = () =>
    records.filter((record) => record.event_type === CustomEvent.FinishCheck).map((record) => record.payload);
  const review = fakeFinishReview({
    delegate: () => answers.shift(),
    append: (payload) => records.push({ event_type: CustomEvent.FinishCheck, payload }),
    records: checks,
  });
  const r = liteHost(lite, {
    [HostMethod.EngineDescribe]: () => [
      { id: CLAUDE, label: CLAUDE, kind: "delegated", supportsSessions: true, models: [] },
    ],
    ...review.handlers,
    [HostMethod.EventsAppend]: (params) => {
      records.push(...(params.batch as typeof records));
      return "e1";
    },
    ...handlers,
  });
  const name = String((game as { name?: unknown }).name);
  const run = {
    runId: FINISH_RUN_ID,
    project: name,
    goal: "a kite racing game with three laps",
    engine: CLAUDE,
  } as unknown as Run;
  const scope = (tally: FinishTally): FinishScope => ({
    ctx: r.ctx as never,
    run,
    threadId: "chat-finish",
    game: game as never,
    leadFolder: dir,
    tally,
    now: Date.now,
    callStarted: Date.now(),
    closeMs: 0,
    said: [],
    previewPass: async () => PREVIEW_PASS,
  });
  return { r, records, checks, scope, reviewers: review.asked };
}

/** Whether a file exists in a folder. */
const exists = (dir: string, file: string) =>
  readFile(path.join(dir, file)).then(
    () => true,
    () => false,
  );

/** Whether a path is Genex's bookkeeping (or inside its repository) rather than the project's own. */
const isBookkeeping = (file: string) => BOOKKEEPING.some((kept) => file === kept || file.startsWith(`${kept}/`));

/** Every file in a folder, relative and with `/`, sorted; the repository's insides left out. */
async function filesIn(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .filter((file) => !file.startsWith(".git/"))
    .sort();
}

/** Opening a copy of the project plans and adds nothing but Genex's bookkeeping: no web template at all. */
async function opensWithoutStarter(name: Project): Promise<void> {
  const dir = await copyProject(name, await caseDir());
  const planned = (await lite.core.inspectFolder(dir)).starter;
  assert.deepEqual(
    planned.filter((file) => !isBookkeeping(file)),
    [],
    "the Open Game sheet plans nothing beyond Genex's bookkeeping",
  );
  const before = await filesIn(dir);
  await lite.core.adoptProject(dir);
  const added = (await filesIn(dir)).filter((file) => !before.includes(file));
  assert.deepEqual(
    added.filter((file) => !isBookkeeping(file)),
    [],
    "adoption adds nothing beyond Genex's bookkeeping",
  );
}

/** A folder's top-level entries that are not Genex's bookkeeping. */
const ownEntries = async (dir: string) => (await readdir(dir)).filter((name) => !BOOKKEEPING.includes(name)).sort();

/** Run `body` with the bundled Unreal plugin on, as the person turns it on, and off again after. */
async function withUnrealOn<T>(body: () => Promise<T>): Promise<T> {
  await lite.core.plugins.setEnabled(UNREAL_PLUGIN, true);
  try {
    return await body();
  } finally {
    await lite.core.plugins.setEnabled(UNREAL_PLUGIN, false);
  }
}

/** Whether git ignores a path in a game's own repository (adoption makes one). */
async function ignored(dir: string, file: string): Promise<boolean> {
  assert.ok(await exists(dir, ".git/HEAD"), "adoption made the game's repository");
  return gitFile(["check-ignore", "-q", file], { cwd: dir }).then(
    () => true,
    () => false,
  );
}

/** Write files into a folder, making their folders. */
async function writeIn(dir: string, files: Record<string, string>): Promise<void> {
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), text);
  }
}

/** The files a commit of a game's repository holds. */
const trackedAt = async (dir: string, commit: string) =>
  (await gitFile(["ls-tree", "-r", "--name-only", commit], { cwd: dir })).stdout.split("\n").filter(Boolean);

/** A run's records as the chat's log hands them to the Builds graph: its start, then each record. */
function runLog(runId: string, records: Array<{ event_type: string; payload: Record<string, unknown> }>) {
  const started = { event_type: CustomEvent.RunStarted, payload: { runId, goal: "Make it", project: "game" } };
  return [started, ...records].map(
    (data, n) =>
      ({
        id: `e${n + 1}`,
        thread_id: "t1",
        session_id: null,
        turn_id: null,
        created_at: new Date(Date.UTC(2026, 0, 1, 9, 0, n)).toISOString(),
        data: { type: EventKind.Custom, ...data },
      }) as EventEnvelope,
  );
}

/** A listed game's facts, read structurally: what and where. */
const factsOfListed = (game: object) =>
  ((game as { facts?: Array<{ id: string; path: string }> }).facts ?? []).map(({ id, path: where }) => ({
    id,
    path: where,
  }));

/** A registry whose only plugin is the example, with one skill for web games and one for Unreal projects. */
async function siteAndEditorSkills(): Promise<PluginRegistry> {
  const root = await tmpDir("studio-use-case-skills-");
  const seeds = path.join(root, "seeds");
  await mkdir(seeds);
  await copyOfExample(seeds, "example", (manifest) => {
    manifest.apiVersion = 3;
    manifest.skills = [
      { name: "page", text: "Load the model with GLTFLoader.", facts: ["web-game"] },
      { name: "editor", text: "Place the model in the open level.", facts: ["unreal-project"] },
    ];
  });
  const registry = new PluginRegistry(path.join(root, "installed"), seeds, PLUGIN_SDK_BACKEND, async () => null);
  await registry.init();
  return registry;
}

/** A tool the host serves, by name, as `plugins.tools` answers it. */
const servedTool = (name: string, description: string) => ({ name, description, parameters: {} });
/** The Unreal plugin's tool that makes a game's Unreal project: served only while the plugin is on. */
const NEW_GAME_TOOL = servedTool(UNREAL_NEW_GAME_TOOL, "Make the game's Unreal project.");
/** The Unreal plugin's kind, as the host lists it while the plugin is on. */
const UNREAL_KIND = { plugin: "unreal", name: "Unreal Editor", tool: UNREAL_NEW_GAME_TOOL, makes: ["unreal-project"] };

/** The names of the tools a delegated request lists, read structurally (a list may be absent). */
const namesOf = (tools: unknown) => (tools as Array<{ name: string }> | undefined)?.map((tool) => tool.name) ?? [];

/**
 * One chat turn on a game the real core lists: the core answers the game calls, the host serves
 * `tools` as the plugin tools, the builder runs `build` and answers ok, and the preview answers at
 * once (a black canvas); nothing else is real. Answers what the builder was handed and what the
 * turn's end did.
 */
async function chatTurn(
  project: string,
  text: string,
  options: { tools?: unknown[]; kinds?: unknown[]; build?: () => Promise<void> },
) {
  const host = liteHost(lite, {
    [HostMethod.EventsMessages]: () => [{ role: "user", content: text }],
    [HostMethod.PluginsTools]: () => ({
      tools: options.tools ?? [],
      guidance: "",
      revision: 1,
      kinds: options.kinds ?? [],
    }),
    [HostMethod.EngineDescribe]: () => [],
    [HostMethod.EngineDelegate]: async () => {
      await options.build?.();
      return { ok: true, engine: CLAUDE, turns: 1, usage: {}, sessionId: "s", summary: "Done." };
    },
    [HostMethod.PreviewLoad]: () => true,
    [HostMethod.PreviewReady]: () => ({ ready: true, ms: 5 }),
    [HostMethod.PreviewStatus]: () => ({ loadError: null }),
    [HostMethod.PreviewConsole]: () => [],
    [HostMethod.PreviewObserve]: () => ({ ok: false, reasons: ["black canvas"] }),
  });
  const turn = { threadId: "thread-1", turnId: "turn-1", text, engine: CLAUDE, engineLabel: "Claude Code", project };
  await runDelegatedTurn(host.ctx as never, turn as never);
  const [delegated] = host.paramsOf(HostMethod.EngineDelegate);
  assert.ok(delegated, "the ask reached the builder");
  const observations = host
    .paramsOf(HostMethod.TurnAppend)
    .flatMap((p) => (p.batch as Array<{ event_type?: string }>) ?? [])
    .filter((event) => event.event_type === RunEvent.BuildObservation);
  return {
    prompt: String(delegated.prompt),
    bridged: namesOf(delegated.interviewTools),
    live: namesOf(delegated.liveTools),
    capture: Boolean(delegated.selfCapture),
    previewCalls: host.sequence("preview."),
    observations,
    changed: host.notifications.some((note) => note.type === UiEvent.GameChanged),
    legs: host.paramsOf(HostMethod.EngineDelegate).map((leg) => ({ resume: leg.resume, prompt: String(leg.prompt) })),
  };
}

/** One live tool call a fixture session makes: its name, and its arguments from what earlier calls answered. */
type SessionCall = { name: string; args: (answers: unknown[]) => Record<string, unknown> };

/**
 * One delegation of the chat's own session on a game, through the real core, on a fixture engine:
 * answers the live tools the host handed it (read from the host's request, since the seed's own
 * delegate params carry none) and what each of `calls` answered, made in order.
 */
async function hostedTurn(
  t: { after: (fn: () => Promise<void>) => void },
  project: string,
  text: string,
  calls: SessionCall[] = [],
): Promise<{ live: string[]; answers: unknown[]; threadId: string }> {
  const threadId = await lite.core.threadForGame(project);
  const seen = { live: [] as string[], answers: [] as unknown[] };
  lite.core.engines.register({
    id: CLAUDE,
    label: "fixture",
    kind: "delegated",
    status: async () => ({ code: "ready", detail: "fixture" }),
    models: async () => [],
    delegate: async (request: DelegateRequest) => {
      seen.live = namesOf(request.liveTools);
      for (const call of calls) seen.answers.push(await request.onLiveTool?.(call.name, call.args(seen.answers)));
      return { ok: true, engine: CLAUDE, summary: "fixture", turns: 1, usage: {} };
    },
  } as never);
  t.after(async () => {
    await lite.core.mcp.close().catch(() => {});
  });
  const delegate = lite.api() as unknown as Record<string, (params: unknown) => Promise<unknown>>;
  await delegate["engine.delegate"]?.({ engine: CLAUDE, project, threadId, prompt: text });
  return { ...seen, threadId };
}

/**
 * One turn of a game chat's own session on an engine that asks: the session does `during` with
 * its request (calling its tools, answering cards) and answers ok.
 */
async function ownSessionTurn(
  t: { after: (fn: () => Promise<void>) => void },
  project: string,
  during: (request: DelegateRequest) => Promise<void>,
): Promise<void> {
  const threadId = await lite.core.threadForGame(project);
  lite.core.engines.register({
    id: CLAUDE,
    label: "fixture",
    kind: "delegated",
    permissionPrompts: true,
    status: async () => ({ code: "ready", detail: "fixture" }),
    models: async () => [],
    delegate: async (request: DelegateRequest) => {
      await during(request);
      return { ok: true, engine: CLAUDE, summary: "fixture", turns: 1, usage: {} };
    },
  } as never);
  t.after(async () => {
    await lite.core.mcp.close().catch(() => {});
  });
  const api = lite.api() as unknown as Record<string, (params: unknown) => Promise<unknown>>;
  await api["engine.delegate"]?.({ engine: CLAUDE, project, threadId, prompt: "check the build" });
}

/** The tool permission cards of a chat. */
async function permissionCards(threadId: string): Promise<ToolPermissionEvent[]> {
  return (await lite.core.store.listEvents(threadId)).flatMap((event) => {
    const custom = customRecord(event.data);
    return custom?.event_type === "tool_permission" ? [custom.payload as unknown as ToolPermissionEvent] : [];
  });
}

/** A look's answer: its text and how many pictures it holds. */
const looked = (answer: unknown) => ({
  text: answerText(answer),
  pictures: ((answer as { images?: unknown[] } | undefined)?.images ?? []).length,
});

/** A chat turn's message id, one per turn whose session starts workers. */
let workerTurns = 0;

/** What a chat turn whose own session started workers came to: each start's answer, and each worker's request. */
type WorkersTurn = { answers: string[]; workers: DelegateRequest[] };

/** The text of a tool's answer. */
const answerText = (answer: unknown) =>
  typeof answer === "string" ? answer : String((answer as { text?: unknown } | undefined)?.text ?? "");

/**
 * The harness, in process, for one test: the host claims workers and hands each `worker_tool` call to
 * the seed's chat pools, which call the core's own substrate table. Undone after the test.
 */
function harnessServesWorkers(t: { after: (fn: () => Promise<void>) => void }) {
  const { host } = lite.core;
  const { dispatch, hasCapability } = host;
  host.hasCapability = (capability) => capability === HarnessCapability.Workers || hasCapability.call(host, capability);
  host.dispatch = async (action, timeoutMs) =>
    action.type === DispatchActionType.WorkerTool ? chatWorkerTool(action) : dispatch.call(host, action, timeoutMs);
  t.after(async () => {
    host.dispatch = dispatch;
    host.hasCapability = hasCapability;
  });
  const api = lite.api() as unknown as Record<string, (params: unknown) => unknown>;
  const handlers = Object.fromEntries(
    Object.entries(api).map(([method, handler]) => [method, (p: unknown) => handler(p)]),
  );
  return ctxRecorder({ handlers });
}

/**
 * A chat turn on `game` whose own session starts a worker for each of `starts`, on an engine that
 * asks: the harness's pool for the turn starts them, and each worker's session stays at work until
 * every start was made, so the pool's cap shows. The turn's end closes the pool.
 */
async function chatTurnWithWorkers(
  t: { after: (fn: () => Promise<void>) => void },
  game: { name: string; dir: string },
  starts: Array<Record<string, unknown>>,
): Promise<WorkersTurn> {
  const ctx = harnessServesWorkers(t);
  const threadId = await lite.core.threadForGame(game.name);
  const turn = `msg-workers-${++workerTurns}`;
  const seen: WorkersTurn = { answers: [], workers: [] };
  const workerSeen = new Changes();
  let release: () => void = () => {};
  const allStarted = new Promise<void>((resolve) => {
    release = resolve;
  });
  lite.core.engines.register({
    id: CLAUDE,
    label: "fixture",
    kind: "delegated",
    permissionPrompts: true,
    status: async () => ({ code: "ready", detail: "fixture" }),
    models: async () => [],
    delegate: async (request: DelegateRequest) => {
      if (request.worker) {
        seen.workers.push(request);
        workerSeen.notify();
        await allStarted;
        return { ok: true, engine: CLAUDE, summary: "read", turns: 1, usage: {} };
      }
      for (const args of starts) seen.answers.push(answerText(await request.onLiveTool?.(WORKER_START, args)));
      const started = seen.answers.filter((answer) => /^Started /.test(answer)).length;
      await until(workerSeen, () => seen.workers.length >= started);
      release();
      return { ok: true, engine: CLAUDE, summary: "fixture", turns: 1, usage: {} };
    },
  } as never);
  await openChatWorkers(ctx.ctx as never, {
    threadId,
    turn,
    engine: CLAUDE,
    project: game.name,
    gameDir: game.dir,
    folderLabel: `AI Games/${game.name}`,
    facts: factsOfListed(await listed(game.name)),
  });
  try {
    const api = lite.api() as unknown as Record<string, (params: unknown) => Promise<unknown>>;
    const grant = { chatTurn: { messageId: turn }, workers: { tools: WORKER_TOOLS } };
    await api["engine.delegate"]?.({ engine: CLAUDE, project: game.name, threadId, prompt: ASK, ...grant });
  } finally {
    release();
    await closeChatWorkers(threadId, turn);
  }
  return seen;
}

/** The file the toy porter's `start-toy` writes into the bound game's folder. */
const TOY_PORT_FILE = "Garden.toyproj";

/**
 * A copy of the toy plugin, under an id of its own, with one more agent tool, `start-toy`, that
 * makes a toy project in the bound game's folder (`makes`), loaded and turned on by the person, and
 * turned off after the test. Answers the tool's name as a session calls it.
 */
async function toyPorter(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const id = "toy-porter";
  const dir = path.join(await tmpDir("studio-toy-porter-"), id);
  await cp(TOY_PLUGIN, dir, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(dir, "plugin.json"), "utf8"));
  manifest.id = id;
  manifest.engine.id = id;
  manifest.tools.push({
    name: "start-toy",
    description: "Make this game a toy project, in place.",
    parameters: { type: "object", properties: {} },
    makes: ["toy-project"],
  });
  await writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest, null, 2));
  await writeFile(
    path.join(dir, "backend.mjs"),
    `import { writeFile } from "node:fs/promises";
import path from "node:path";
export async function activate() {
  return {
    async tool(name, _args, ctx) {
      if (name === "start-toy") await writeFile(path.join(ctx.directory, ${JSON.stringify(TOY_PORT_FILE)}), "{}\\n");
      return "Made the toy project.";
    },
  };
}\n`,
  );
  await lite.core.plugins.installLocal(dir, PluginSourceKind.Local, []);
  await lite.core.plugins.setEnabled(id, true);
  // The person allows its tools: this case is about the port, not the card.
  const asksAgain = personAllowsLocalTools(lite.core.plugins);
  t.after(async () => {
    asksAgain();
    await lite.core.plugins.setEnabled(id, false);
  });
  return `${id}__start-toy`;
}

/** The files the Unreal plugin's new-plugin makes for `LevelTools`, as the stand-in writes them. */
const LEVEL_TOOLS_SHAPE: Record<string, string> = {
  "unreal/LevelToolsHost.uproject": "{}\n",
  "unreal/Source/LevelToolsHost/LevelToolsHost.Build.cs": "// the host's module\n",
  "unreal/Plugins/LevelTools/LevelTools.uplugin": "{}\n",
  "unreal/Plugins/LevelTools/Source/LevelTools/LevelTools.Build.cs": "// the plugin's module\n",
  "unreal/Plugins/GenexEditorHelper/GenexEditorHelper.uplugin": "{}\n",
};

/**
 * A local stand-in of the Unreal plugin, turned on, whose `new-plugin` writes the host project with
 * its plugin and the Genex editor helper (the real one needs Unreal installed). Its kind tools,
 * their readiness tool and its scaffolds are the bundled manifest's, copied at test time.
 */
async function unrealStandIn(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const id = "unreal-standin";
  const dir = path.join(await tmpDir("studio-unreal-standin-"), id);
  await cp(TOY_PLUGIN, dir, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(dir, "plugin.json"), "utf8"));
  manifest.id = id;
  manifest.engine.id = id;
  const real = unrealManifest as unknown as { tools: Array<{ name: string }>; scaffolds: unknown };
  manifest.tools.push(
    ...real.tools.filter((declared) => ["new-game", "new-plugin", "engine-status"].includes(declared.name)),
  );
  manifest.scaffolds = real.scaffolds;
  await writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest, null, 2));
  await writeFile(
    path.join(dir, "backend.mjs"),
    `import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
export async function activate() {
  return {
    async tool(name, _args, ctx) {
      if (name !== "new-plugin") return "nothing";
      for (const [file, text] of Object.entries(${JSON.stringify(LEVEL_TOOLS_SHAPE)})) {
        await mkdir(path.dirname(path.join(ctx.directory, file)), { recursive: true });
        await writeFile(path.join(ctx.directory, file), text);
      }
      return "Made LevelTools in unreal/Plugins/LevelTools/, inside the host project LevelToolsHost.";
    },
  };
}\n`,
  );
  await lite.core.plugins.installLocal(dir, PluginSourceKind.Local, []);
  await lite.core.plugins.setEnabled(id, true);
  // The person's yes on its card: this case is about the scaffold, not the card.
  const asksAgain = personAllowsLocalTools(lite.core.plugins);
  t.after(async () => {
    asksAgain();
    await lite.core.plugins.setEnabled(id, false);
  });
  return `${id}__new-plugin`;
}

/** A JPEG's first bytes: the plugin window's picture as app_look keeps it. */
const WINDOW_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);

/** What UBT, the headless editor and UAT answer in the plugin's backend: a build, two passing tests and a package. */
const SHIP_PROGRAMS = {
  compile: async () => ({
    ok: true,
    seconds: 30,
    errors: [],
    summary: "LevelToolsHostEditor built in 30 s.",
    retryable: false,
  }),
  runProgram: async (_file: string, args: readonly string[]) => {
    const report = (args.find((arg) => arg.startsWith("-ReportExportPath=")) ?? "").split("=")[1] ?? "";
    const tests = ["Opens", "Lists"].map((name) => ({ fullTestPath: `LevelTools.Window.${name}`, state: "Success" }));
    await writeFile(path.join(report, "index.json"), JSON.stringify({ tests }));
    return { code: 0, output: "", timedOut: false };
  },
  prepareSandbox: async () => {
    const scratch = await tmpDir("studio-ship-sandbox-");
    return { profile: path.join(scratch, "ubt.sb"), env: {}, cwd: scratch, dispose: async () => {} };
  },
  runCommand: async (_file: string, args: readonly string[]) => {
    const packaged = (args.find((arg) => arg.startsWith("-Package=")) ?? "").slice("-Package=".length);
    await writeFile(path.join(packaged, "LevelTools.uplugin"), JSON.stringify({ VersionName: "1.0" }));
    return { code: 0, output: "BUILD SUCCESSFUL\n" };
  },
};

/** Waits until a file exists. */
async function untilFile(file: string): Promise<void> {
  for (let i = 0; i < 2_000; i++) {
    if (await exists(path.dirname(file), path.basename(file))) return;
    await pause(5);
  }
  throw new Error(`${path.basename(file)} never appeared`);
}

/**
 * A local stand-in of the Unreal plugin, turned on, with the bundled manifest's editor lock and its
 * `plugin-build` and `editor-activity` declarations copied at test time: its probe says the person
 * isn't at Unreal, and its build marks that it runs, then answers once the test lets it. The
 * person's yes on the build's card is recorded in `asked`.
 */
async function shipStandIn(t: { after: (fn: () => Promise<void>) => void }) {
  const id = "unreal-ship-standin";
  const root = await tmpDir("studio-unreal-ship-standin-");
  const dir = path.join(root, id);
  const markers = path.join(root, "markers");
  await mkdir(markers);
  await cp(TOY_PLUGIN, dir, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(dir, "plugin.json"), "utf8"));
  const real = unrealManifest as unknown as { tools: Array<{ name: string }>; locks: unknown[] };
  manifest.id = id;
  manifest.engine.id = id;
  manifest.locks.push(...real.locks);
  manifest.tools.push(...real.tools.filter((declared) => ["plugin-build", "editor-activity"].includes(declared.name)));
  manifest.detect.push({ fact: "unreal-plugin", files: ["**/*.uplugin"], notUnder: ["**/GenexEditorHelper/"] });
  await writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest, null, 2));
  await writeFile(
    path.join(dir, "backend.mjs"),
    `import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as pause } from "node:timers/promises";
const markers = ${JSON.stringify(markers)};
const there = (name) => access(path.join(markers, name)).then(() => true, () => false);
export async function activate() {
  return {
    async tool(name) {
      if (name === "editor-activity") {
        await writeFile(path.join(markers, "probed"), "");
        return { personActive: false, pie: false, dirty: 0 };
      }
      if (name !== "plugin-build") return "nothing";
      await writeFile(path.join(markers, "inside"), "");
      while (!(await there("release"))) await pause(10);
      return { started: true };
    },
  };
}\n`,
  );
  await lite.core.plugins.installLocal(dir, PluginSourceKind.Local, []);
  await lite.core.plugins.setEnabled(id, true);
  const asked: string[] = [];
  const ask = lite.core.plugins.consent;
  lite.core.plugins.consent = async (_plugin, tool) => {
    asked.push(tool.name);
    return { approved: true, by: "user" };
  };
  t.after(async () => {
    lite.core.plugins.consent = ask;
    await lite.core.plugins.setEnabled(id, false);
  });
  return { id, tool: `${id}__plugin-build`, markers, inside: path.join(markers, "inside"), asked };
}

/** A chat turn on an opened copy of the project whose builder changes one of the game's files. */
async function chatTurnOn(name: Project, changed: string) {
  const { dir, game } = await adopted(name);
  return chatTurn(game.name, ASK, {
    build: () => writeFile(path.join(dir, changed), "# changed by the builder\n"),
  });
}

describe("the fixtures these cases use", () => {
  it("the toy engine plugin loads as a plugin package today, with its agent tool and its file skill", async () => {
    const manifest = await inspectPackage(TOY_PLUGIN);
    assert.equal(manifest.id, TOY_PLUGIN_ID);
    assert.deepEqual(
      manifest.tools.filter(isAgentTool).map((tool) => tool.name),
      ["build"],
    );
    assert.deepEqual(
      manifest.skills.map((skill) => skill.name),
      ["toy-engine"],
    );
  });
});

/** The bundled Unreal plugin's manifest as Genex keeps it: the file canonicalised the way installing it does. */
const UNREAL_MANIFEST = validateManifest(
  JSON.parse(readFileSync(new URL("../../src/plugins/unreal/plugin.json", import.meta.url), "utf8")),
);

/** A manifest section read structurally: Genex keeps only the sections it knows, so a later one reads as undefined. */
const sectionOf = (manifest: object, key: string): unknown => (manifest as Record<string, unknown>)[key];

/** A section's entries, read structurally: an absent section has none. */
const entriesOf = (manifest: object, key: string): Array<Record<string, unknown>> => {
  const section = sectionOf(manifest, key);
  return Array.isArray(section) ? section : [];
};

/** One tool of a manifest by name, read structurally (its later fields included). */
const toolOf = (manifest: object, name: string): Record<string, unknown> | undefined =>
  entriesOf(manifest, "tools").find((tool) => tool.name === name);

/** One of a manifest's MCP servers, by its id. */
const serverOf = (manifest: object, id: string): Record<string, unknown> | undefined =>
  entriesOf(manifest, "mcpServers").find((server) => server.id === id);

/** A game's facts as a lead's tools are scoped by them: an id and the folder it was found at. */
type FactScope = Array<{ id: string; path: string }>;

/** The agent tools a registry offers a lead whose game has `facts`. */
const toolNamesFor = (registry: PluginRegistry, facts: FactScope) =>
  registry.snapshot(facts).tools.map((tool) => tool.name);

/** One skill of a manifest by name, read structurally (its later fields included). */
const skillOf = (manifest: object, name: string): Record<string, unknown> | undefined =>
  entriesOf(manifest, "skills").find((skill) => skill.name === name);

describe("a new web game: the first message picks web, and a Loop ends on the finish check", () => {
  it("New game makes a game's folder and lists it", async () => {
    const game = await lite.core.createGame("Kite Run");
    assert.ok(await listed(game.name));
  });

  it("a first message that names no engine, with no engine plugin on, briefs a web build with the preview capture", async () => {
    const game = await lite.core.createGame("Kite Racer");
    const { prompt, bridged, capture } = await chatTurn(game.name, "make a kite racing game", { tools: [] });
    assert.doesNotMatch(prompt, /Unreal/);
    assert.deepEqual(bridged, [], "no question card");
    assert.equal(capture, true, "the builder captures the web preview");
  });

  it("New game leaves the folder empty but for Genex's bookkeeping until the first message picks a kind", async () => {
    const game = await lite.core.createGame("Kite Empty");
    assert.deepEqual(await ownEntries(lite.core.games.dirFor(game.name)), [], "only Genex's bookkeeping");
  });

  it("the harness's game scaffold leaves the folder empty but for Genex's bookkeeping", async () => {
    const game = await lite.api()[HostMethod.GameScaffold]({ name: "kite-scaffold" });
    assert.deepEqual(await ownEntries(lite.core.games.dirFor(game.name)), [], "only Genex's bookkeeping");
  });

  it("once the first message picks web, the starter is written and the folder's facts are web-game", async (t) => {
    const game = await lite.core.createGame("Kite Start");
    const threadId = await lite.core.threadForGame(game.name);
    const sessions: string[][] = [];
    lite.core.engines.register({
      id: CLAUDE,
      label: "fixture",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "fixture" }),
      models: async () => [],
      delegate: async (request: DelegateRequest) => {
        const live = namesOf(request.liveTools);
        sessions.push(live);
        if (live.includes(START_WEB_GAME)) await request.onLiveTool?.(START_WEB_GAME, {});
        return { ok: true, engine: CLAUDE, summary: "fixture", turns: 1, usage: {} };
      },
    } as never);
    t.after(async () => {
      await lite.core.mcp.close().catch(() => {});
    });
    const delegate = lite.api() as unknown as Record<string, (params: unknown) => Promise<unknown>>;
    const ask = { engine: CLAUDE, project: game.name, threadId, prompt: "make a kite game" };
    await delegate["engine.delegate"]?.(ask);
    const dir = lite.core.games.dirFor(game.name);
    assert.ok(await exists(dir, "index.html"), "the starter's page");
    assert.ok(await exists(dir, "src/main.js"), "the starter's code");
    assert.deepEqual(factsAt(await listed(game.name), "web-game"), ["."]);
    assert.deepEqual(factIds(await listed(game.name)), ["web-game"]);
    await delegate["engine.delegate"]?.(ask);
    assert.equal(sessions[0]?.includes(START_WEB_GAME), true, "the first turn is offered the starter");
    assert.equal(sessions[1]?.includes(START_WEB_GAME), false, "a web game's next turn is not");
  });
  it("a Loop on it ends only after a reviewer accepts the lead's finish, and three rejections in a row stop it with what isn't done", async () => {
    const game = await lite.core.createGame("Kite Finish");
    const dir = lite.core.games.dirFor(game.name);
    await mkdir(path.join(dir, "reports"), { recursive: true });
    await writeFile(path.join(dir, "reports", "tests.txt"), "8 passed\n");
    const notDone = ["The race has two laps, not three."];
    const { reviewers, checks, scope } = finishHost(game, dir, [
      reviewerSays("no", notDone),
      reviewerSays("no", notDone),
      reviewerSays("no", notDone),
    ]);
    const tally = newTally();
    const outcomes: FinishOutcome[] = [];
    for (let n = 0; n < MAX_FINISH_REJECTIONS; n++) outcomes.push(await checkFinish(scope(tally), FINISH_CLAIM));
    const last = outcomes.at(-1);
    assert.ok(last && !("noTime" in last) && last.step === FinishCheckStep.Rejected, "the third check is a no");
    assert.equal(last.stop, true, "and it stops the Loop");
    assert.deepEqual(last.reasons, notDone, "with what isn't done");
    for (const asked of reviewers) {
      assert.equal(asked.readOnly, true, "the reviewer only reads");
      assert.deepEqual(asked.reviewer, { runId: FINISH_RUN_ID, reads: dir }, "the lead's folder, for this run");
    }
    const ends = checks().filter((check) => check.step === FinishCheckStep.Rejected);
    assert.deepEqual(
      ends.map((check) => check.reasons),
      [notDone, notDone, notDone],
      "each record names the reasons",
    );
    const accepting = finishHost(game, dir, [reviewerSays("yes", ["Three laps and a timer."])]);
    const yes = await checkFinish(accepting.scope(newTally()), FINISH_CLAIM);
    assert.ok(!("noTime" in yes) && yes.step === FinishCheckStep.Accepted, "a reviewer's yes ends the Loop");
    assert.equal(accepting.checks().at(-1)?.step, FinishCheckStep.Accepted);
  });
});

describe("a new Unreal game, plugin on: the editor under its lock, workers in copies, the Unreal card", () => {
  it("a first message on a new game asks web or Unreal when the plugin is on", async () => {
    const game = await lite.core.createGame("Lantern Keep");
    const { bridged } = await chatTurn(game.name, "make a castle exploration game", {
      tools: [NEW_GAME_TOOL],
      kinds: [UNREAL_KIND],
    });
    assert.ok(bridged.includes("ask_user"), `the question card is bridged in (bridged: ${JSON.stringify(bridged)})`);
  });

  it("the plugin declares the editor lock, which gives way to the person, and its editor tools need it", () => {
    const editor = entriesOf(UNREAL_MANIFEST, "locks").find((lock) => lock.id === "editor");
    assert.ok(editor, `an editor lock (locks: ${JSON.stringify(sectionOf(UNREAL_MANIFEST, "locks"))})`);
    assert.equal(editor.personFirst, "editor-activity", "the lock gives way while the person uses the editor");
    assert.deepEqual(serverOf(UNREAL_MANIFEST, "editor")?.needs, ["editor"], "the agents' editor connector");
    assert.deepEqual(toolOf(UNREAL_MANIFEST, "save-all")?.needs, ["editor"], "Genex's own editor steps");
    assert.equal(toolOf(UNREAL_MANIFEST, "find-nodes")?.needs, undefined, "a lookup without Unreal needs nothing");
  });

  it("the plugin's hooks cover the editor's moments, and the end leaves the editor open", () => {
    const hooks = entriesOf(UNREAL_MANIFEST, "hooks");
    const moments = hooks.map((hook) => hook.on);
    const wanted = ["run.prepare", "checkpoint.before", "checkpoint.after", "restore.after", "health", "crash"];
    assert.deepEqual(
      wanted.filter((moment) => !moments.includes(moment)),
      [],
      `hooks on: ${JSON.stringify(moments)}`,
    );
    // An editor the person can see stays open when the run ends, as it does today.
    const endsEditor = hooks.filter((hook) => hook.on === "run.end" && hook.tool === "end-editor");
    assert.deepEqual(endsEditor, [], "the end leaves the editor open");
  });

  it("the plugin's worker types include C++ work in copies", () => {
    const cpp = entriesOf(UNREAL_MANIFEST, "workerTypes").find((type) => type.id === "cpp");
    assert.equal(cpp?.isolation, "copy");
  });

  it("the plugin's viewport observer gives Live the Unreal card", () => {
    const viewport = entriesOf(UNREAL_MANIFEST, "observers").find((observer) => observer.id === "viewport");
    assert.equal(viewport?.live, "unreal-card");
  });

  it("keeps Unreal's generated folders out of history", async () => {
    const { dir } = await withUnrealOn(() => adopted(Project.UnrealGame));
    const generated = ["Saved/Logs/Lantern.log", "Intermediate/x", "DerivedDataCache/x", "Binaries/x"];
    const kept: string[] = [];
    for (const file of generated) if (!(await ignored(dir, file))) kept.push(file);
    assert.deepEqual(kept, [], "every generated folder is ignored");
  });

  it("the lead on an Unreal game starts Blender-model and texture workers in copies, with worker types from whichever plugin declares them; these succeed the Unreal lead's blender_model, blender_prep, genex_cast, sound and texture agents", async () => {
    await lite.core.plugins.setEnabled(GENEX_PLUGIN, true);
    const types = await withUnrealOn(async () => {
      const { game } = await adopted(Project.UnrealGame);
      const api = lite.api() as unknown as Record<string, (params: unknown) => Promise<WorkerType[]>>;
      return (await api["plugins.workerTypes"]?.({ project: game.name })) ?? [];
    }).finally(() => lite.core.plugins.setEnabled(GENEX_PLUGIN, false));
    const declaredBy = Object.fromEntries(types.map((type) => [type.id, type.pluginId]));
    assert.equal(declaredBy.blender_model, "blender", "Local Blender declares the model worker");
    assert.equal(declaredBy.texture, "genex", "Genex declares the texture worker");
    for (const kind of ["blender_prep", "genex_cast", "sound", "cpp"])
      assert.ok(declaredBy[kind], `${kind} is declared`);
    const answers: string[] = [];
    const startsWorkers: Turn = async ({ tool }) => {
      answers.push(textOf(await tool(WORKER_START, { type: "blender_model", title: "Katana", task: "A katana." })));
      answers.push(
        textOf(await tool(WORKER_START, { type: "texture", title: "Moss", task: "A mossy stone texture." })),
      );
      return undefined;
    };
    const host = leadHost({ turns: [startsWorkers, buildsOnly, buildsOnly, buildsOnly], workerTypes: types });
    await runUnrealLead(host.rec.ctx as never, {
      threadId: "t1",
      run: { ...RUN, budgets: { ...RUN.budgets, wallClockMs: 20 * 60_000 } } as never,
      resume: false,
      now: host.now,
      sleep: host.sleep,
    });
    assert.match(answers[0] ?? "", /^Started worker blender_model-1/, answers.join("\n"));
    assert.match(answers[1] ?? "", /^Started worker texture-1/, answers.join("\n"));
    const copies = host.rec.paramsOf("engine.delegate").filter((p) => p.worker);
    // A worker that has not delivered yet is woken again in the same copy.
    assert.deepEqual(
      [...new Set(copies.map((p) => String(p.cwd).split("/").at(-1)))],
      ["agent-blender_model-1", "agent-texture-1"],
      "each works in its own copy",
    );
  });
  it(
    "a Loop on it is led by the chat's own session, under the editor lock, with workers in copies",
    LOOP_TIMEOUT,
    async () => {
      const answers: string[] = [];
      const host = await unrealLoopHost([
        async ({ tool }) => {
          await tool("save_point", { label: "One", summary: "the first room" });
          answers.push(textOf(await tool(WORKER_START, { type: "cpp", title: "Door", task: "A door that opens." })));
          await tool("finish", { summary: "The level is built and the door opens.", proof: "Lantern.uproject" });
          return undefined;
        },
      ]);
      await host.dispatch();
      const [first] = host.leadCalls();
      assert.equal(first?.resume, CHAT_SESSION, "the chat's own session leads");
      assert.equal((first?.director as { inPlace?: unknown } | undefined)?.inPlace, true, "in the game folder");
      const trail = host.trail();
      const probe = trail.indexOf("tool:unreal__editor-activity");
      const save = trail.indexOf("tool:unreal__save-all");
      assert.ok(probe >= 0 && probe < save, `the editor lock asked first: ${trail.join(", ")}`);
      assert.ok(save < trail.lastIndexOf("snapshot.create"), "the editor saved before the snapshot");
      assert.match(answers[0] ?? "", /^Started w1 \(copy\)/, answers.join("\n"));
      const [copy] = host.rec.paramsOf("snapshot.worktree");
      assert.ok(copy, "the worker got a copy of the game");
      const worker = host.workers[0];
      assert.notEqual(worker?.params.cwd, host.dir, "it works in its copy, not the game folder");
    },
  );
});

describe("Unreal asked for with the plugin off: find the plugin, or go on with generic tools", () => {
  it("a vague first message with the plugin off builds web: no Unreal in the brief, no question card", async () => {
    const game = await lite.core.createGame("Plain Start");
    const { prompt, bridged, capture } = await chatTurn(game.name, "make a game", { tools: [] });
    assert.doesNotMatch(prompt, /Unreal/);
    assert.deepEqual(bridged, [], "no question card");
    assert.equal(capture, true, "a web build");
  });

  it("with no engine plugin on, a chat turn is offered plugins_find whatever the message says", async (t) => {
    // Genex never decides by the person's words: a message naming Unreal and one naming no engine
    // are offered the same tool.
    for (const [name, text] of [
      ["Unreal Wish", "make a game with Unreal"],
      ["Any Wish", "make a game"],
    ]) {
      const game = await lite.core.createGame(name);
      const { live } = await hostedTurn(t, game.name, text);
      assert.ok(live.includes(PLUGINS_FIND), `"${text}" is offered: ${JSON.stringify(live)}`);
    }
  });

  it("plugins_find shows the turn-it-on card; on the person's word only, the lead goes on with generic tools and is told it cannot save inside the editor before checkpoints", async (t) => {
    const game = await lite.core.createGame("Unreal Card");
    // The session looks for the plugin, then suggests what it found.
    const found = (answers: unknown[]) =>
      (JSON.parse(String(answers[0])) as { plugins: Array<{ id: string }> }).plugins[0]?.id;
    const { answers, threadId } = await hostedTurn(t, game.name, "make a game with Unreal", [
      { name: PLUGINS_FIND, args: () => ({ text: "Unreal" }) },
      { name: PLUGINS_SUGGEST, args: (earlier) => ({ plugin: found(earlier), reason: "You asked for Unreal." }) },
    ]);
    assert.equal(found(answers), UNREAL_PLUGIN, "the search finds the Unreal plugin");
    assert.match(String(answers[1]), /End your reply now/);
    const cards = (await lite.core.store.listEvents(threadId)).filter(
      (event) => event.data.type === "custom" && event.data.event_type === PLUGIN_SUGGESTED,
    );
    assert.equal(cards.length, 1, "one turn-it-on card");
    assert.equal(lite.core.plugins.enabled(UNREAL_PLUGIN), false, "only the person turns it on");

    // On the person's word to go on without it, an Unreal project's turn is delegated, never refused.
    const { prompt } = await chatTurnOn(Project.UnrealGame, "Config/DefaultEngine.ini");
    assert.match(prompt, /Unreal plugin is off/);
    assert.match(prompt, /can't save inside the editor before a checkpoint/);
  });
  it("without the plugin the lead builds with UnrealBuildTool and UnrealEditor-Cmd as jobs and looks with app_look", {
    skip: process.platform === "win32" && "jobs' process groups are POSIX",
  }, async (t) => {
    const { dir, game } = await adopted(Project.UnrealGame);
    assert.equal(lite.core.plugins.enabled(UNREAL_PLUGIN), false, "the Unreal plugin is off");
    const threadId = await lite.core.threadForGame(game.name);
    await lite.core.setPermissionMode(threadId, PermissionMode.Bypass);
    const before = jobsSpawned.length;
    const answers: unknown[] = [];
    let live: string[] = [];
    await ownSessionTurn(t, game.name, async (request) => {
      live = namesOf(request.liveTools);
      for (const [title, command] of [
        ["Unreal build", "UnrealBuildTool Garden Mac Development -Project=Garden.uproject"],
        ["Headless check", "UnrealEditor-Cmd Garden.uproject -run=ResavePackages -unattended"],
      ])
        answers.push(await request.onLiveTool?.(JobTool.Start, { title, command }));
      answers.push(await request.onLiveTool?.(APP_LOOK_TOOL_NAME, { app: "Fixture App" }));
    });
    for (const tool of [JobTool.Start, APP_LOOK_TOOL_NAME]) assert.ok(live.includes(tool), `offered ${tool}`);
    for (const answer of answers.slice(0, 2)) assert.match(answerText(answer), /^Job [0-9a-f-]{36} \(/);
    const started = jobsSpawned.slice(before);
    assert.deepEqual(
      started.map((job) => [job.command.split(" ")[0], job.cwd]),
      [
        ["UnrealBuildTool", await realpath(dir)],
        ["UnrealEditor-Cmd", await realpath(dir)],
      ],
      "two jobs in the game's folder",
    );
    const look = looked(answers[2]);
    assert.match(look.text, /AXWindow "Fixture Window"/);
    assert.equal(look.pictures, 1, "a picture and a tree");
  });
});

/** A web folder's first commit leaves its packages and build out; after a port, a snapshot leaves the new engine's scratch out. */
async function firstCommitsFollowTheRules(): Promise<void> {
  const dir = await copyProject(Project.WebFolder, await caseDir());
  await writeIn(dir, { "node_modules/pkg/index.js": "module.exports = 1;\n", "dist/bundle.js": "bundle();\n" });
  const game = await lite.core.adoptProject(dir);
  const first = await trackedAt(dir, "HEAD");
  for (const file of ["index.html", "game.js"]) assert.ok(first.includes(file), `${file} is in history`);
  for (const file of ["node_modules/pkg/index.js", "dist/bundle.js"])
    assert.ok(!first.includes(file), `${file} stays out of history`);

  // The files a port to Unreal leaves, written directly: Unreal's real new game needs Unreal.
  await writeIn(dir, { "Garden.uproject": "{}\n", "Saved/Logs/a.log": "log\n", "Intermediate/b": "b\n" });
  const record = await lite.core.snapshot(SnapshotScope.Game, "after the port", game.name);
  assert.ok(record.git.game, "the snapshot holds the game");
  const saved = await trackedAt(dir, record.git.game);
  assert.ok(saved.includes("Garden.uproject"), "the project file is in history");
  assert.deepEqual(
    saved.filter((file) => file.startsWith("Saved/") || file.startsWith("Intermediate/")),
    [],
    "the new engine's scratch stays out of history",
  );
  assert.ok((await readFile(path.join(dir, ".gitignore"), "utf8")).split("\n").includes("/Saved/"));
}

describe("someone's web folder: analyze, research in parallel, port, one chat", () => {
  it("opening it keeps its own page and entry, and writes no starter beside them", async () => {
    const dir = await copyProject(Project.WebFolder, await caseDir());
    const original = path.join(PROJECTS, Project.WebFolder);
    await lite.core.adoptProject(dir);
    for (const file of ["index.html", "game.js"])
      assert.equal(await readFile(path.join(dir, file), "utf8"), await readFile(path.join(original, file), "utf8"));
    assert.equal(await exists(dir, "src/main.js"), false);
  });

  it("knows the folder as a web game at its root", async () => {
    const { game } = await adopted(Project.WebFolder);
    assert.deepEqual(factIds(await listed(game.name)), ["web-game"]);
    assert.deepEqual(factsAt(await listed(game.name), "web-game"), ["."]);
  });

  it("read-only workers read it in place, and a research worker gets web search", async (t) => {
    const { dir, game } = await adopted(Project.WebFolder);
    const before = await filesIn(dir);
    const { answers, workers } = await chatTurnWithWorkers(t, { name: game.name, dir }, [
      { title: "Read the game loop", task: "Explain how game.js runs a frame.", isolation: "read" },
      {
        title: "Research ports",
        task: "Find how others port a canvas game to Unreal.",
        isolation: "read",
        research: "yes",
      },
    ]);
    for (const answer of answers) assert.match(answer, /^Started w\d+ \(read\)/);
    assert.equal(workers.length, 2);
    for (const request of workers) {
      assert.equal(request.cwd, dir, `${request.worker?.title}: in the folder itself`);
      assert.equal(request.readOnly, true, `${request.worker?.title}: reads only`);
    }
    assert.deepEqual(
      workers.map((request) => [request.worker?.title, request.worker?.research]).sort(),
      [
        ["Read the game loop", false],
        ["Research ports", true],
      ],
      "only the research worker searches the web",
    );
    assert.deepEqual(await filesIn(dir), before, "nothing in the folder changed");
  });
  it("a port runs Unreal's new-game in place: refused during a run, a snapshot first, the port recorded as portedFrom; the turn ends and the same session continues with the Unreal tools", async (t) => {
    // Unreal's real new-game needs Unreal installed, so the port goes to a stand-in that declares
    // the same field: a copy of the toy plugin whose `start-toy` makes a toy project in place. The
    // bundled Unreal plugin's new-game declares what it makes the same way.
    assert.deepEqual(toolOf(UNREAL_MANIFEST, "new-game")?.makes, ["unreal-project"]);
    const tool = await toyPorter(t);
    const { dir, game } = await adopted(Project.WebFolder);
    const original = path.join(PROJECTS, Project.WebFolder);
    const invoke = async () =>
      lite.api()[HostMethod.PluginsInvoke]({
        project: game.name,
        threadId: await lite.core.threadForGame(game.name),
        name: tool,
        args: {},
      });

    const running = lite.core.pluginServices.runningGames;
    lite.core.pluginServices.runningGames = async () => [{ project: game.name, directory: dir, title: game.name }];
    const refused = (await invoke().finally(() => {
      lite.core.pluginServices.runningGames = running;
    })) as { refused?: string };
    assert.equal(refused.refused, "run_going", "refused while a run of the game is going");
    assert.equal(await exists(dir, TOY_PORT_FILE), false, "nothing ran");

    // This game's snapshots: the log holds every game's, and only this game's repository has its commits.
    const gameSnapshots = async () => {
      const all = (await lite.core.listAllEvents()).flatMap((event) =>
        event.data.type === "snapshot_created" && event.data.git.game ? [event.data.git.game] : [],
      );
      const inThisGame = await Promise.all(
        all.map((sha) =>
          gitFile(["cat-file", "-e", `${sha}^{commit}`], { cwd: dir }).then(
            () => true,
            () => false,
          ),
        ),
      );
      return all.filter((_, i) => inThisGame[i]);
    };
    const snapshotsBefore = await gameSnapshots();

    // The chat's own turn ports it; its end sees the new kind and the same session goes on.
    let ported = false;
    const { legs } = await chatTurn(game.name, "port it to the toy engine", {
      build: async () => {
        if (ported) return;
        ported = true;
        assert.match(JSON.stringify(await invoke()), /End your reply now/);
      },
    });
    const taken = (await gameSnapshots()).filter((sha) => !snapshotsBefore.includes(sha));
    assert.equal(taken.length, 1, "one snapshot of this game was taken for the port");
    const before = await gitFile(["cat-file", "-e", `${taken[0]}:${TOY_PORT_FILE}`], { cwd: dir }).then(
      () => true,
      () => false,
    );
    assert.equal(before, false, "the snapshot was taken before the port wrote anything");
    const meta = JSON.parse(await readFile(path.join(dir, "studio.json"), "utf8"));
    assert.deepEqual(
      meta.portedFrom.map((fact: { id: string; path: string }) => [fact.id, fact.path]),
      [["web-game", "."]],
    );
    assert.deepEqual(factIds(await listed(game.name)), ["toy-project"]);
    for (const file of ["index.html", "game.js"])
      assert.equal(await readFile(path.join(dir, file), "utf8"), await readFile(path.join(original, file), "utf8"));
    assert.deepEqual(
      legs.map((leg) => leg.resume ?? null),
      [null, "s"],
      "the same session went on by itself",
    );
  });
  it("the first commit after opening it follows the facts' ignore rules", firstCommitsFollowTheRules);
});

describe("an Unreal C++ editor plugin: build, test and package it", () => {
  // These cases build with the Unreal plugin's tools, so it is on. Unreal's kinds are in the core
  // table too, so their facts do not depend on it (an installed plugin that is off detects nothing).
  it("knows a plugin folder with no host project as an Unreal plugin", async () => {
    const ids = await withUnrealOn(async () =>
      factIds(await listed((await adopted(Project.UnrealPluginSource)).game.name)),
    );
    assert.ok(ids.includes("unreal-plugin"), `an unreal-plugin fact (facts: ${JSON.stringify(ids)})`);
  });

  it("does not take the Genex editor helper inside a game for a plugin project", async () => {
    const ids = await withUnrealOn(async () => factIds(await listed((await adopted(Project.UnrealGame)).game.name)));
    assert.ok(ids.includes("unreal-project"), `an unreal-project fact (facts: ${JSON.stringify(ids)})`);
    assert.ok(!ids.includes("unreal-plugin"), "no unreal-plugin fact");
  });

  it("opening it writes no web starter", async () => {
    await opensWithoutStarter(Project.UnrealPluginSource);
  });

  it("the plugin scaffold makes a host project with the plugin in Plugins/<Name>, and its kind label says plugin", async (t) => {
    const tool = await unrealStandIn(t);
    const game = await lite.core.createGame("Level Tools");
    const answer = await lite.api()[HostMethod.PluginsInvoke]({
      project: game.name,
      threadId: await lite.core.threadForGame(game.name),
      name: tool,
      args: { name: "LevelTools", template: "window" },
    });
    assert.match(JSON.stringify(answer), /LevelToolsHost/);
    const kind = (await listed(game.name)) as GameProject;
    assert.deepEqual(
      kind.facts.map((fact) => [fact.id, fact.path]),
      [
        ["unreal-project", "unreal"],
        ["unreal-plugin", "unreal/Plugins/LevelTools"],
      ],
      "the host and its plugin; never the Genex editor helper",
    );
    assert.equal(kind.scaffold?.label, "Unreal plugin");
    assert.match(projectKindLabel(kind) ?? "", /plugin/i);
  });
  it("plugin tools build under the editor lock, run the automation tests headless and package with BuildPlugin; the finish carries the test report, the package path and a screenshot of the plugin's window", async (t) => {
    // Under the editor lock: the person-first check comes first, and the call holds the project's lock.
    const ship = await shipStandIn(t);
    const game = await lite.core.createGame("Level Ship");
    const dir = lite.core.games.dirFor(game.name);
    for (const [file, text] of Object.entries(LEVEL_TOOLS_SHAPE)) {
      await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
      await writeFile(path.join(dir, file), text);
    }
    const building = lite.api()[HostMethod.PluginsInvoke]({
      project: game.name,
      threadId: await lite.core.threadForGame(game.name),
      name: ship.tool,
      args: {},
    });
    await untilFile(ship.inside);
    assert.ok(await exists(ship.markers, "probed"), "the person-first check ran before the call");
    const key = `${game.name}:${ship.id}:editor`;
    assert.ok(
      lite.core.locks.holders().some((held) => held.key === key),
      "the project's editor lock is held during the call",
    );
    await writeFile(path.join(ship.markers, "release"), "");
    assert.match(JSON.stringify(await building), /started/);
    assert.ok(!lite.core.locks.holders().some((held) => held.key === key), "and let go after");
    assert.deepEqual(ship.asked, ["plugin-build"], "the person was asked first");

    // The plugin's backend on a fake engine: build, tests and package, and the proof plugin-status lists.
    const f = await unrealBackendFixture({ programs: SHIP_PROGRAMS });
    await f.call("new-plugin", { name: "LevelTools" });
    const status = async () =>
      (await f.call("plugin-status", {})) as { proof: string[] } & Record<string, { state: string }>;
    for (const [tool, job] of [
      ["plugin-build", "build"],
      ["plugin-test", "test"],
      ["plugin-package", "package"],
    ] as const) {
      await f.call(tool, {});
      for (let i = 0; i < 2_000 && (await status())[job]?.state === "running"; i++) await pause(5);
      assert.equal((await status())[job]?.state, "done", `${job} is done`);
    }
    const shot = path.join(f.dir, "unreal", "Saved", "Genex", "Shots", "LevelTools-window.jpg");
    await mkdir(path.dirname(shot), { recursive: true });
    await writeFile(shot, WINDOW_JPEG);
    const { proof } = await status();
    assert.deepEqual(proof, [
      "unreal/Saved/Genex/Tests/LevelTools/summary.md",
      "unreal/Saved/Genex/Packages/LevelTools.md",
      "unreal/Saved/Genex/Shots/LevelTools-window.jpg",
    ]);

    // The finish names that proof: its reviewer reads the test summary, the package note's path and one picture.
    const proofGame = await lite.core.createGame("Level Proof");
    const proofDir = lite.core.games.dirFor(proofGame.name);
    for (const file of proof) await cp(path.join(f.dir, file), path.join(proofDir, file), { recursive: true });
    const api = lite.api() as unknown as Record<string, (params: unknown) => Promise<unknown>>;
    const kept = {
      [HostMethod.RunArtifact]: (params: Record<string, unknown>) => api[HostMethod.RunArtifact]?.(params),
    };
    const { reviewers, scope } = finishHost(
      await listed(proofGame.name),
      proofDir,
      [reviewerSays("yes", ["Built, tested and packaged."])],
      kept,
    );
    const outcome = await checkFinish(scope(newTally()), { ...FINISH_CLAIM, proof });
    assert.ok(!("noTime" in outcome) && outcome.step === FinishCheckStep.Accepted);
    const [asked] = reviewers;
    const brief = JSON.stringify(asked);
    assert.ok(brief.includes("2 passed, 0 failed, 0 not run."), "the test summary's text");
    assert.ok(brief.includes("unreal/Saved/Genex/Packages/LevelTools.md"), "the package note's path");
    assert.equal(((asked?.images ?? []) as unknown[]).length, 1, "one picture: the plugin's window");
  });
});

describe("a Godot game with its plugin off: generic tools, jobs and looking at the app", () => {
  it("opening it plans and writes no web starter", async () => {
    await opensWithoutStarter(Project.GodotGame);
  });

  it("a chat turn that changes its files is not checked as a web page", async () => {
    const { changed, previewCalls, observations } = await chatTurnOn(Project.GodotGame, "scripts/player.gd");
    assert.equal(changed, true, "the turn saw its write");
    assert.deepEqual(previewCalls, [], "no preview call");
    assert.equal(observations.length, 0, "no build_observation");
  });

  it("knows the folder as a Godot project", async () => {
    const { game } = await adopted(Project.GodotGame);
    assert.deepEqual(factIds(await listed(game.name)), ["godot-project"]);
  });

  it("briefs its builder without the web template's rule", async () => {
    const { prompt } = await chatTurnOn(Project.GodotGame, "scripts/player.gd");
    assert.ok(!prompt.includes("window.__studio"), "no web-template contract in the brief");
  });

  it("keeps Godot's import cache out of history", async () => {
    const { dir } = await adopted(Project.GodotGame);
    assert.equal(await ignored(dir, ".godot/imported/icon.ctex"), true);
  });

  it("the lead and workers run godot --headless as jobs within the chat's permission mode, and look at the running game with app_look", {
    skip: process.platform === "win32" && "jobs' process groups are POSIX",
  }, async (t) => {
    const { dir, game } = await adopted(Project.GodotGame);
    const gameDir = await realpath(dir);
    const threadId = await lite.core.threadForGame(game.name);
    const check = { title: "Godot check", command: "godot --headless --quit" };
    for (const mode of PERMISSION_MODES) {
      await lite.core.setPermissionMode(threadId, mode);
      const before = jobsSpawned.length;
      const known = new Set((await permissionCards(threadId)).map((card) => card.requestId));
      let start: unknown;
      let look: unknown;
      let card: ToolPermissionEvent | undefined;
      await ownSessionTurn(t, game.name, async (request) => {
        const call = request.onLiveTool?.(JobTool.Start, check);
        if (mode === PermissionMode.AcceptEdits || mode === PermissionMode.Manual) {
          await until(cards, async () => {
            card = (await permissionCards(threadId)).find((row) => !known.has(row.requestId));
            return card !== undefined;
          });
          assert.equal(card?.state, "pending", `${mode}: a card waits`);
          assert.equal(card?.tool, "Job");
          lite.core.answerPermission(card?.requestId ?? "", { decision: "deny" });
        }
        start = await call;
        look = await request.onLiveTool?.(APP_LOOK_TOOL_NAME, { window: "Fixture Window" });
      });
      const spawned = jobsSpawned.slice(before);
      if (mode === PermissionMode.Bypass || mode === PermissionMode.Auto) {
        assert.match(answerText(start), /^Job [0-9a-f-]{36} \(Godot check\)/, mode);
        assert.equal(spawned[0]?.cwd, gameDir, `${mode}: in the game's folder`);
        const writes = spawned[0]?.policy.allowWrite ?? [];
        assert.ok(writes.includes(gameDir), `${mode}: writes the game`);
        assert.equal(
          writes[0] === os.homedir(),
          mode === PermissionMode.Bypass,
          `${mode}: the home folder only in Bypass`,
        );
      } else {
        assert.equal(spawned.length, 0, `${mode}: nothing started`);
        if (mode === PermissionMode.Plan) assert.match(answerText(start), /jobs wait until the plan is approved/);
        else assert.match(answerText(start), /did not allow this job/, `${mode}: the declined card`);
      }
      assert.equal(looked(look).pictures, 1, `${mode}: app_look answers`);
    }

    await lite.core.setPermissionMode(threadId, PermissionMode.Auto);
    const loop = await loopWithWorker(t, game);
    const before = jobsSpawned.length;
    const worked: unknown[] = [];
    loop.whileRunning(async (request) => {
      worked.push(await request.onLiveTool?.(JobTool.Start, check));
      worked.push(await request.onLiveTool?.(APP_LOOK_TOOL_NAME, { app: "Fixture App" }));
    });
    await loop.worker();
    const [job] = jobsSpawned.slice(before);
    const copy = await realpath(path.join(lite.core.layout.scratch, "autopilot", loop.runId, "stairs"));
    assert.match(answerText(worked[0]), /^Job [0-9a-f-]{36} \(Godot check\)/);
    assert.equal(job?.cwd, copy, "a worker's job runs in its copy");
    assert.ok(job?.policy.allowWrite?.includes(copy), "and writes its copy");
    assert.ok(!job?.policy.allowWrite?.includes(gameDir), "never the game itself");
    assert.equal(looked(worked[1]).pictures, 1, "the worker looks too");
  });
  it("plugins_find suggests turning on the bundled Godot plugin, which ships off", async () => {
    // Genex's own plugins, and no catalog: the bundled Godot plugin knows a Godot project.
    const find = lite.api() as unknown as Record<string, (params: unknown) => Promise<unknown>>;
    const answer = (await find[HostMethod.PluginsFind]?.({ fact: "godot-project" })) as {
      plugins: Array<{ id: string; offer?: string }>;
      next: string;
    };
    assert.deepEqual(
      answer.plugins.map((plugin) => [plugin.id, plugin.offer]),
      [["godot", PluginOffer.TurnOn]],
    );
    assert.equal(answer.next, FindNext.Suggest);
  });
});

describe("assets only, a Blender pack: Blender workers, renders and the Assets tab", () => {
  it("opening it writes no web starter", async () => {
    await opensWithoutStarter(Project.BlenderAssets);
  });

  it("knows the folder as Blender assets", async () => {
    const { game } = await adopted(Project.BlenderAssets);
    assert.deepEqual(factIds(await listed(game.name)), ["blender-assets"]);
  });

  it("lists its .blend files in the Assets tab", async () => {
    const { game } = await adopted(Project.BlenderAssets);
    const files = (await lite.core.projectAssets(game.name)).assets.map((asset) => asset.file);
    assert.deepEqual(
      ["props/crate.blend", "props/lamp.blend"].filter((file) => !files.includes(file)),
      [],
      `listed: ${JSON.stringify(files)}`,
    );
  });

  it("keeps Blender's backup files out of history", async () => {
    const { dir } = await adopted(Project.BlenderAssets);
    assert.equal(await ignored(dir, "props/crate.blend1"), true);
  });

  it("the lead runs Blender workers, at most eight at once", async (t) => {
    const { dir, game } = await adopted(Project.BlenderAssets);
    // The kind of worker comes from the plugin that declares it: Local Blender, on as it ships.
    const api = lite.api() as unknown as Record<string, (params: unknown) => Promise<WorkerType[]>>;
    const types = (await api["plugins.workerTypes"]?.({ project: game.name })) ?? [];
    const model = types.find((type) => type.id === "blender_model");
    assert.ok(model, `a plugin that is on declares blender_model: ${types.map((type) => type.id).join(", ")}`);
    const props = Array.from({ length: 9 }, (_, n) => ({
      title: `Prop ${n + 1}`,
      task: `Model prop ${n + 1} and save it under props/.`,
      type: model.id,
    }));
    // The pool's own cap, under a Settings ceiling (Maximum concurrent workers) that allows as many.
    const ceiling = lite.core.settings.buildersMax;
    await lite.core.updateSettings({ buildersMax: MAX_WORKERS_AT_ONCE });
    t.after(async () => {
      await lite.core.updateSettings({ buildersMax: ceiling });
    });
    const { answers, workers } = await chatTurnWithWorkers(t, { name: game.name, dir }, props);
    assert.equal(workers.length, 8, "eight workers ran at once");
    for (const answer of answers.slice(0, 8)) assert.match(answer, /^Started w\d+ \(copy\)/);
    assert.match(answers[8] ?? "", /at most 8 run at once/, "the ninth is told why");
    for (const request of workers) {
      const plugins = namesOf(request.liveTools).filter((name) => name.includes("__"));
      assert.deepEqual(plugins.sort(), [...model.tools].sort(), "each is offered its type's tools and no others");
      assert.notEqual(request.cwd, dir, "each works in its own copy");
    }
  });
  it("each prop gets a turntable render; the finish check reads the renders and Live shows them", async () => {
    const { dir, game } = await adopted(Project.BlenderAssets);
    await mkdir(path.join(dir, "renders"), { recursive: true });
    for (const prop of ["crate", "lamp"]) await writeFile(path.join(dir, "renders", `${prop}.png`), RENDER_PNG);
    const api = lite.api() as unknown as Record<string, (params: unknown) => Promise<unknown>>;
    const kept = {
      [HostMethod.RunArtifact]: (params: Record<string, unknown>) => api[HostMethod.RunArtifact]?.(params),
    };
    const listedGame = await listed(game.name);
    const { reviewers, records, scope } = finishHost(
      listedGame,
      dir,
      [reviewerSays("yes", ["Both props have renders."])],
      kept,
    );
    const claim = { ...FINISH_CLAIM, proof: ["renders/crate.png", "renders/lamp.png"] };
    const outcome = await checkFinish(scope(newTally()), claim);
    assert.ok(!("noTime" in outcome) && outcome.step === FinishCheckStep.Accepted);
    const [asked] = reviewers;
    const images = (asked?.images ?? []) as Array<{ label: string; data: string }>;
    assert.deepEqual(
      images.map((image) => image.data),
      [RENDER_PNG.toString("base64"), RENDER_PNG.toString("base64")],
      "the reviewer is handed both renders",
    );
    const proofs = records.filter(
      (record) => record.event_type === CustomEvent.ObserverCapture && record.payload.source === ObserverSource.Proof,
    );
    assert.equal(proofs.length, 1, "one capture of the lead's proof");
    const files = ((proofs[0]?.payload.images ?? []) as Array<{ file: string }>).map((image) =>
      path.basename(image.file),
    );
    assert.deepEqual(files, ["1-crate.png", "2-lamp.png"], "listing both renders, kept with the run");
    // Live: a Blender pack has no view of its own, so it shows the run's latest pictures.
    assert.equal(liveViewFor({ facts: factsOfListed(listedGame) }, lite.core.plugins.list()).live, ObserverLive.Stills);
    const graph = buildRunGraph(runLog(FINISH_RUN_ID, records));
    assert.deepEqual(
      latestCaptures(graph).map((picture) => path.basename(picture.file)),
      ["1-crate.png", "2-lamp.png"],
      "Live shows both renders",
    );
  });
});

describe("an Unreal game with a web site: two facts, two views", () => {
  it("knows the Unreal project at the root and the web game in its site folder", async () => {
    // Its Live view switches to the Unreal card, so the plugin is on (see the editor plugin's case).
    const descriptor = await withUnrealOn(async () => listed((await adopted(Project.UnrealAndSite)).game.name));
    assert.deepEqual(factsAt(descriptor, "unreal-project"), ["."]);
    assert.deepEqual(factsAt(descriptor, "web-game"), ["site"]);
  });

  it("skills and rules scope by path: the web skill applies under site/, the Unreal skill at the root", async () => {
    const descriptor = await withUnrealOn(async () => listed((await adopted(Project.UnrealAndSite)).game.name));
    const facts = factsOfListed(descriptor);
    const registry = await siteAndEditorSkills();
    try {
      const { guidance } = registry.snapshot(facts);
      assert.match(guidance, /\[example\/page\] \(for site\/\)\n/, "the web skill names its folder");
      assert.match(guidance, /\[example\/editor\]\n/, "the Unreal skill applies at the root");
    } finally {
      registry.cancel();
    }
    const lines = buildContractorBrief({ ask: ASK, engine: CLAUDE, facts }).split("\n");
    const web = lines.filter((line) => line.includes("window.__studio"));
    assert.ok(web.length > 0 && web.every((line) => line.startsWith("For the web game in `site/`: ")));
    const unreal = lines.filter((line) => line.includes("the Unreal editor connector's tools"));
    assert.ok(unreal.length > 0 && unreal.every((line) => !line.startsWith("For the ")));
  });
  it("two observers; Live shows the Unreal card, picked by the facts", async () => {
    const { descriptor, observers, plugins } = await withUnrealOn(async () => {
      const descriptor = await listed((await adopted(Project.UnrealAndSite)).game.name);
      const kind = { facts: factsOfListed(descriptor) };
      return { descriptor, observers: lite.core.plugins.observers(kind), plugins: lite.core.plugins.list() };
    });
    assert.deepEqual(
      observers.map((observer) => [observer.key, observer.at]),
      [
        [`${UNREAL_PLUGIN}/viewport`, "."],
        [PREVIEW_OBSERVER, "site"],
      ],
    );
    assert.deepEqual(liveViewFor({ facts: factsOfListed(descriptor) }, plugins), {
      live: ObserverLive.UnrealCard,
      at: ".",
      observer: `${UNREAL_PLUGIN}/viewport`,
    });
  });
  it("Live switches between them: a tab for the Unreal card, then one for the site's preview", async () => {
    const { descriptor, plugins } = await withUnrealOn(async () => {
      const descriptor = await listed((await adopted(Project.UnrealAndSite)).game.name);
      return { descriptor, plugins: lite.core.plugins.list() };
    });
    const views = liveViewsFor({ facts: factsOfListed(descriptor) }, plugins);
    assert.deepEqual(
      views.map((view) => [view.live, view.at]),
      [
        [ObserverLive.UnrealCard, "."],
        [ObserverLive.Preview, "site"],
      ],
    );
    const tabs = stageTabs({ views, plugins, hasBuilds: true, buildsLive: false, beside: null });
    assert.deepEqual(
      tabs.map((tab) => tab.label),
      [STAGE_WORDS.tabs.unreal, STAGE_WORDS.tabs.webGame, STAGE_WORDS.tabs.builds, STAGE_WORDS.tabs.assets],
    );
  });
});

describe("a Genex plugin for an engine Genex lacks: written, loaded by the person, off until turned on", () => {
  let registry: PluginRegistry;
  before(async () => {
    registry = await toyRegistry();
  });
  const toy = () => registry.list().find((plugin) => plugin.manifest.id === TOY_PLUGIN_ID);
  /** The toy plugin's manifest as written, beside the one Genex keeps once it is installed. */
  const RAW = JSON.parse(readFileSync(path.join(TOY_PLUGIN, "plugin.json"), "utf8")) as object;

  it("the toy engine plugin installs as a local plugin today, with its agent tool and skill", () => {
    const plugin = toy();
    assert.ok(plugin, "the toy plugin is listed");
    assert.equal(plugin.source, PluginSourceKind.Local);
    assert.deepEqual(
      plugin.manifest.tools.filter(isAgentTool).map((tool) => tool.name),
      ["build"],
    );
    assert.deepEqual(
      plugin.manifest.skills.map((skill) => skill.name),
      ["toy-engine"],
    );
  });

  it("a loaded local plugin starts off", () => {
    assert.equal(registry.enabled(TOY_PLUGIN_ID), false);
  });

  /** Each part of the manifest a later phase keeps, read the same way from the file and from what Genex kept. */
  const KEPT: Array<{ part: string; todo?: string; read: (manifest: object) => unknown }> = [
    { part: "detect", read: (m) => sectionOf(m, "detect") },
    { part: "locks", read: (m) => sectionOf(m, "locks") },
    { part: "folders", read: (m) => sectionOf(m, "folders") },
    { part: "hooks", read: (m) => sectionOf(m, "hooks") },
    { part: "observers", read: (m) => sectionOf(m, "observers") },
    { part: "workspace", read: (m) => sectionOf(m, "workspace") },
    { part: "assets", read: (m) => sectionOf(m, "assets") },
    { part: "workerTypes", read: (m) => sectionOf(m, "workerTypes") },
    { part: "scaffolds", read: (m) => sectionOf(m, "scaffolds") },
    { part: "judges", read: (m) => sectionOf(m, "judges") },
    {
      part: "tools[].needs",
      read: (m) => toolOf(m, "build")?.needs,
    },
    {
      part: "tools[].facts",
      read: (m) => toolOf(m, "build")?.facts,
    },
    {
      part: "skills[].facts",
      read: (m) => skillOf(m, "toy-engine")?.facts,
    },
    {
      part: "skills[].tools",
      read: (m) => skillOf(m, "toy-engine")?.tools,
    },
  ];
  for (const { part, todo, read } of KEPT) {
    it(`keeps its ${part}`, { todo }, () => {
      const written = read(RAW);
      assert.ok(written !== undefined, `the toy plugin declares ${part}`);
      assert.deepEqual(read(toy()?.manifest ?? {}), written);
    });
  }

  it("its tools reach a toy project's lead and no web game's", async () => {
    // The person turns it on: this case is about scope, not about how a loaded plugin starts.
    await registry.setEnabled(TOY_PLUGIN_ID, true);
    assert.equal(registry.enabled(TOY_PLUGIN_ID), true, "the toy plugin is on");
    const build = `${TOY_PLUGIN_ID}__build`;
    const toyLead = toolNamesFor(registry, [{ id: "toy-project", path: "." }]);
    assert.ok(toyLead.includes(build), `a toy project's tools: ${JSON.stringify(toyLead)}`);
    const webLead = toolNamesFor(registry, [{ id: "web-game", path: "." }]);
    assert.ok(!webLead.includes(build), `a web game's tools: ${JSON.stringify(webLead)}`);
  });

  describe("a toy project, with the toy plugin loaded and turned on by the person", () => {
    before(async () => {
      await lite.core.plugins.installLocal(TOY_PLUGIN, PluginSourceKind.Local, []);
      await lite.core.plugins.setEnabled(TOY_PLUGIN_ID, true);
    });

    it("detects nothing while the toy plugin is installed but off", async () => {
      await lite.core.plugins.setEnabled(TOY_PLUGIN_ID, false);
      try {
        const { game } = await adopted(Project.ToyProject);
        const off = (await listed(game.name)) as { holds?: string };
        assert.deepEqual(factIds(off), [], "no toy-project fact while it is off");
        assert.equal(off.holds, FolderHolds.OwnFiles, "files of its own of a kind no rule knows");
        await lite.core.plugins.setEnabled(TOY_PLUGIN_ID, true);
        assert.deepEqual(factsAt(await listed(game.name), "toy-project"), ["."], "turned on, it detects");
      } finally {
        await lite.core.plugins.setEnabled(TOY_PLUGIN_ID, true);
      }
    });

    it("knows the folder as a toy project from the plugin's detect, but not the copy under vendor/", async () => {
      const { game } = await adopted(Project.ToyProject);
      assert.deepEqual(factsAt(await listed(game.name), "toy-project"), ["."]);
    });

    it("keeps the toy engine's cache out of history, from the plugin's workspace", async () => {
      const { dir } = await adopted(Project.ToyProject);
      assert.equal(await ignored(dir, "Cache/x"), true);
    });
  });

  it("only the person loads a local plugin and turns it on; an agent's request never does; its tools ask consent per tool and its card says it runs with your access", async () => {
    const { core } = lite;
    await core.plugins.installLocal(TOY_PLUGIN, PluginSourceKind.Local, []);
    await core.plugins.setEnabled(TOY_PLUGIN_ID, false);
    const { game } = await adopted(Project.ToyProject);
    const threadId = await core.store.createThread({ title: "Toy", metadata: { kind: "game", project: game.name } });
    const api = lite.api() as unknown as Record<string, (input: unknown) => Promise<unknown>>;
    await api[HostMethod.PluginsSuggest]!({ project: game.name, threadId, plugin: TOY_PLUGIN_ID, reason: "a toy" });
    await api[HostMethod.PluginsFind]!({ project: game.name, text: "toy" });
    assert.equal(core.plugins.enabled(TOY_PLUGIN_ID), false, "an agent's search and card leave it off");
    await core.plugins.setEnabled(TOY_PLUGIN_ID, true);
    const consents = async () =>
      (await core.store.listEvents(threadId)).flatMap((event) => {
        const record = customRecord(event.data);
        return record?.event_type === CustomEvent.PluginConsent
          ? [record.payload as { consentId: string; state: string; prompt: string; alwaysOffered?: boolean }]
          : [];
      });
    const build = api[HostMethod.PluginsInvoke]!({
      project: game.name,
      threadId,
      name: `${TOY_PLUGIN_ID}__build`,
      args: {},
    });
    let card: Awaited<ReturnType<typeof consents>>[number] | undefined;
    for (let tries = 0; tries < CARD_TRIES && !card; tries++) {
      card = (await consents()).find((c) => c.state === "pending");
      if (!card) await pause(CARD_POLL_MS);
    }
    assert.ok(card, "the call asks first");
    assert.match(card.prompt, /Toy Engine was loaded from a folder on this Mac and runs with your access/);
    assert.equal(card.alwaysOffered, true, "its card offers Always allow for this tool");
    core.resolveConsent(card.consentId, false);
    assert.equal(((await build) as { consent?: string }).consent, "declined", "a no runs nothing");
  });
  it("the plugin-author skill writes a plugin like this one into a local folder", async () => {
    const dir = await mkdtemp(path.join(cases, "plugin-author-"));
    const binding = { project: "plugin-author", directory: dir };
    // The guide comes with the Genex plugin, on as it ships.
    const genexWas = lite.core.plugins.enabled(GENEX_PLUGIN);
    await lite.core.plugins.setEnabled(GENEX_PLUGIN, true);
    const { folder } = await writeSkillExample(lite.core.plugins, binding, dir).finally(() =>
      lite.core.plugins.setEnabled(GENEX_PLUGIN, genexWas),
    );
    const written = await inspectPackage(path.join(dir, folder));
    const filled = (value: unknown) => (Array.isArray(value) ? value.length > 0 : value !== undefined);
    for (const [section, value] of Object.entries(RAW)) {
      if (!filled(value) || typeof value !== "object") continue;
      assert.ok(filled(sectionOf(written, section)), `the written plugin declares ${section}, as the toy one does`);
    }
    const tools = entriesOf(written, "tools");
    assert.ok(
      tools.some((tool) => tool.needs && tool.facts),
      "an agent tool with needs and facts",
    );
    assert.ok(
      entriesOf(written, "skills").some((skill) => skill.file && skill.facts && skill.tools),
      "a skill read on demand, scoped by facts and tools",
    );
    await lite.core.plugins.installLocal(path.join(dir, folder), PluginSourceKind.Local, []);
    assert.equal(lite.core.plugins.enabled(written.id), false, "loaded from that folder, it starts off");
  });
});

describe("an unlimited Loop on any of these: the lead, the facts' hooks and observers, workers, the finish check", () => {
  it("workers in a Loop follow the chat's permission mode, and a worker's question waits for the person until they answer or switch to Bypass", async (t) => {
    const { core } = lite;
    const loop = await loopWithWorker(t);
    for (const mode of Object.values(PermissionMode)) {
      await core.setPermissionMode(loop.threadId, mode);
      await loop.worker();
      assert.equal(loop.seen.at(-1)?.worker?.mode, mode, `${mode}: the chat's mode`);
    }
    await core.setPermissionMode(loop.threadId, PermissionMode.Manual);
    const ask: PermissionAsk = { toolUseId: "tu-1", tool: "Bash", input: { command: "npm install" }, always: [] };
    const answers: Array<PermissionReply | undefined> = [];
    loop.whileRunning(async (request) => {
      answers.push(await request.worker?.asks?.ask(ask, new AbortController().signal));
    });
    const waiting = loop.worker();
    const card = await loop.firstCard();
    assert.equal(card.state, "pending", "the question waits for the person");
    assert.equal(core.answerPermission(card.requestId, { decision: "deny" }), true);
    await waiting;
    const known = new Set((await loop.rows()).map((row) => row.requestId));
    const next = loop.worker();
    for (let tries = 0; tries < 200 && (await loop.rows()).every((row) => known.has(row.requestId)); tries++)
      await pause(25);
    await core.setPermissionMode(loop.threadId, PermissionMode.Bypass);
    await next;
    assert.deepEqual(
      answers.map((answer) => answer?.decision),
      ["deny", "allow"],
      "the person's answer, then their switch to Bypass",
    );
    const settled = (await loop.rows()).at(-1);
    assert.equal(settled?.by, "mode", "kept in the chat, answered by the switch");
    assert.equal(settled?.worker?.title, "Stair builder");
  });
  it("a worker's question is answered only by the person: a message from the lead or another worker never counts as approval", async (t) => {
    const { core } = lite;
    const loop = await loopWithWorker(t);
    await core.setPermissionMode(loop.threadId, PermissionMode.Manual);
    let answer: PermissionReply | undefined;
    const ask: PermissionAsk = { toolUseId: "tu-1", tool: "Bash", input: { command: "npm install" }, always: [] };
    // The chat's own session answers a message of the person's and takes steered messages as it works.
    const steered: SteerMessage[] = [];
    let release: () => void = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    loop.whileRunning(async (request) => {
      if (request.permissions) {
        request.steer?.ready((message) => {
          steered.push(message);
          return true;
        });
        await released;
        return;
      }
      answer = await request.worker?.asks?.ask(ask, new AbortController().signal);
    });
    const message = "msg-use-case-approval";
    // No harness here: the person's message is recorded, and its dispatch reaches nothing.
    const { dispatch } = core.host;
    core.host.dispatch = async () => undefined;
    t.after(() => {
      core.host.dispatch = dispatch;
    });
    await core.sendUserMessage("Build the stairs", { thread: loop.threadId, clientId: message, engine: CLAUDE });
    const chatTurn = Promise.resolve(
      loop.api["engine.delegate"]?.({
        engine: CLAUDE,
        project: loop.game.name,
        threadId: loop.threadId,
        prompt: "answer the person",
        chatTurn: { messageId: message },
      }),
    ).catch(() => null);
    const turn = loop.worker();
    const card = await loop.firstCard();
    assert.equal(card.worker?.title, "Stair builder", "the worker's question is a card in the chat, naming the worker");
    assert.equal(card.worker?.title, "Stair builder", "naming the worker");
    const said = { ...card, state: "allowed", by: "user", granted: "once" };
    await assert.rejects(
      Promise.resolve(
        loop.api["events.append"]?.({
          threadId: loop.threadId,
          batch: [{ type: "custom", event_type: "tool_permission", payload: said }],
        }),
      ),
      "the harness never settles a card",
    );
    const took = (await loop.api["engine.steer"]?.({
      threadId: loop.threadId,
      into: message,
      messages: [{ id: "from-the-lead", text: "Approved, go ahead." }],
    })) as { accepted?: string[] } | undefined;
    assert.deepEqual(took?.accepted, ["from-the-lead"], "a session really took the message");
    assert.deepEqual(
      steered.map((message) => message.id),
      ["from-the-lead"],
    );
    const states = (await loop.rows()).filter((row) => row.requestId === card.requestId).map((row) => row.state);
    assert.deepEqual(states, ["pending"], "a lead's or worker's message never counts");
    assert.equal(core.answerPermission(card.requestId, { decision: "allow" }), true, "the person's answer");
    await turn;
    assert.deepEqual(answer, { decision: "allow" });
    release();
    await chatTurn;
  });
  it("in every permission mode, Bypass included, workers never touch logins, Genex's own data or another game's folder", async (t) => {
    const { core } = lite;
    const loop = await loopWithWorker(t);
    const login = await realNearest(path.join(os.homedir(), ".codex", "auth.json"));
    const signIns = await Promise.all(
      [".ssh", ".aws", path.join(".config", "gh")].map((dir) => realNearest(path.join(os.homedir(), dir))),
    );
    const genexData = await realpath(lite.userData);
    const otherGame = await realpath(loop.other.dir);
    for (const mode of Object.values(PermissionMode)) {
      await core.setPermissionMode(loop.threadId, mode);
      await loop.worker();
      const seat: WorkerSeat | undefined = loop.seen.at(-1)?.worker;
      assert.ok(seat, `${mode}: a worker seat`);
      const roots = seat.neverTouch.roots.map((root) => root.path);
      for (const root of [genexData, otherGame, ...signIns]) assert.ok(roots.includes(root), `${mode}: ${root}`);
      assert.ok(
        roots.some((root) => login.startsWith(root)),
        `${mode}: ${login}`,
      );
      for (const file of ["~/.ssh/id_ed25519", "~/.aws/credentials", "~/.config/gh/hosts.yml"]) {
        const call = { tool: "Read", input: { file_path: file } };
        const hit: NeverTouchHit | null = neverTouchVerdict(call, seat.neverTouch, loop.game.dir, os.homedir());
        assert.equal(hit?.kind, NeverTouchKind.Login, `${mode}: ${file}`);
      }
    }
  });
  // A web Loop's starting snapshot before its first session: director.test.ts ("a run from scratch").
  it("the Unreal Loop's lead snapshots the game before its first turn", LOOP_TIMEOUT, async () => {
    const host = await unrealLoopHost([finishesLoop]);
    await host.dispatch();
    const trail = host.trail();
    const snapshot = trail.indexOf("snapshot.create");
    assert.ok(snapshot >= 0 && snapshot < trail.indexOf("engine.delegate"), trail.join(", "));
  });
  it(
    "an unlimited Loop runs until the finish check passes, capped at 24 hours; the credit cap lives in the run record",
    LOOP_TIMEOUT,
    async () => {
      const unlimited = { wallClockMs: 2 * HOUR, untilSatisfied: true, completionPolicy: "goal" };
      const host = await unrealLoopHost(
        [
          async ({ tool }) => {
            await tool(WORKER_START, { type: "cpp", title: "Door", task: "A door that opens." });
            await tool("finish", { summary: "The level is built.", proof: "Lantern.uproject" });
            return undefined;
          },
          finishesLoop,
        ],
        { budgets: unlimited },
      );
      host.reviews.push(reviewerAnswer("no", ["the door does not open"]));
      await host.start();
      const id = `autopilot_${host.run.runId}`;
      const journal = host.artifacts.get(id) as { run: Run; director: { clock: Record<string, string> } };
      const { started, finalDeadline } = journal.director.clock;
      assert.equal(
        Date.parse(finalDeadline) - Date.parse(started),
        24 * HOUR + GRACE_MS,
        "24 hours at most, then the grace to wrap up",
      );
      const steps = host.appended("finish_check").map((check) => check.step);
      assert.deepEqual(
        steps.filter((step) => step !== FinishCheckStep.Checking),
        [FinishCheckStep.Rejected, FinishCheckStep.Accepted],
        "a no goes on, a yes closes it",
      );
      assert.equal(host.appended("run_finished").length, 1);
      assert.equal(host.appended("run_finished")[0]?.victory, true);
      const [startedRecord] = host.appended("run_started");
      const recorded = startedRecord?.budgets as Record<string, unknown> | undefined;
      assert.equal(recorded?.creditCap, 600, "the cap is in the run record");
      assert.equal(journal.run.budgets.creditCap, 600, "and in the journal a resume reads");
      for (const lead of host.leadCalls()) assert.equal(lead.creditCap, 600, "every lead turn is capped");
      const workerCalls = host.rec.paramsOf("engine.delegate").filter((params) => params.worker);
      assert.ok(workerCalls.length > 0, "a worker ran");
      for (const call of workerCalls) {
        assert.equal(call.creditCap, 600, "every worker is capped");
        // A run worker's card waits as the lead's does: every worker names its run.
        assert.equal((call.worker as { runId?: unknown }).runId, host.run.runId);
      }

      const idle = await unrealLoopHost(
        [
          ({ host }) => {
            host.pass(24 * HOUR);
            return undefined;
          },
        ],
        { budgets: unlimited },
      );
      const report = await idle.start();
      assert.equal(
        report.stoppedBecause,
        "the Loop's time ran out before a reviewer accepted the goal; here is where it stands",
      );
      assert.equal(idle.reviewed().length, 0, "no reviewer was asked");
    },
  );
});
