/**
 * A fake host for a Loop's tests (`runDirector` on a project of any kind): a real git repository as
 * the game folder (so workers' copies, merges and the folder's state are real), the game's facts and
 * the moments a plugin manifest the test hands it hooks (the toy plugin's, the Unreal plugin's, or
 * none), answered by the fake hook bus (`unreal-moment-bus.ts`), and `engine.delegate` split three
 * ways: the lead (a script of turns calling the run's tools through `directorTool`, as the host
 * forwards them), pool workers (sessions the test ends, writing files in their copies first), and
 * the reviewer (`reviewerAnswer`), and a judge that plays on a leased window (a delegation with a
 * `playtest` grant, answering yes to every question it is asked unless the test says otherwise). A checkpoint's pictures are kept as the plugin's observer's
 * capture, as the host keeps them. A checkpoint commits the folder and a restore resets it to the
 * snapshot's commit (after a rescue commit), as the host's snapshots do; the test may put the chat in Plan mode, let the lead's turn take
 * what is steered into it, and list the run's jobs. The clock is the test's: a wait moves it and
 * yields a millisecond. `dispatch` starts the run through the run's start instead, on the wall clock.
 * Every call lands on one ordered trail, a moment's steps and snapshots where they happen.
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay, setImmediate as tick } from "node:timers/promises";
import { promisify } from "node:util";
import { runDirector } from "../../src/harness-seed/loop/director.ts";
import { handleRunStart } from "../../src/harness-seed/loop/run-dispatch.ts";
import { directorTool } from "../../src/harness-seed/loop/director/tool-specs.ts";
import { LoopProfile } from "../../src/harness-seed/loop/folder-facts.ts";
import { type HookEvent, type HookContext, type HookedPlugin, hookEventsOf } from "../../src/shared/plugin-hooks.ts";
import type { GameKind } from "../../src/shared/project-facts.ts";
import type { WorkerType } from "../../src/shared/workers.ts";
import { type CtxRecorder, ctxRecorder } from "./ctx-recorder.ts";
import { gitFile } from "./git.ts";
import { asksReviewer, fakeFinishReview, reviewerAnswer } from "./reviewer.ts";
import { type BusHost, checkpoint, fire, restore } from "./unreal-moment-bus.ts";

const run = promisify(execFile);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** How long a test waits, in real time, for something it expects the Loop to do. */
const UNTIL_MS = 15_000;

/** The chat the Loop runs in, and the session its contractor bookmark names. */
export const THREAD = "t1";
export const CHAT_SESSION = "chat-session-1";

/** A plugin manifest as the bus plans moments from it. */
export type LoopManifest = HookedPlugin["manifest"] & { id: string };

/** One turn of the lead's session: what it was asked, its run tools, and the host. */
export type LoopTurnCall = {
  params: Record<string, unknown>;
  tool: (name: string, args?: Record<string, string>) => Promise<unknown>;
  host: LoopHost;
  /** The turn's number, from 1. */
  n: number;
};
/** What a scripted turn does; it may answer its own result, or throw as an engine does. */
export type LoopTurn = (
  call: LoopTurnCall,
) => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined;

/** A worker's session the test ends: what the pool asked for, and its end. */
export type WorkerSession = {
  params: Record<string, unknown>;
  id: string;
  /** Ends it: files written in its copy first (or in place), then its result. */
  end: (result?: { ok?: boolean; summary?: string; files?: Record<string, string> }) => Promise<void>;
};

export type LoopHost = {
  rec: CtxRecorder;
  /** The chat the Loop runs in (`THREAD` unless the test names its own). */
  threadId: string;
  /** The game folder: a real git repository. */
  dir: string;
  /** The game as `game.list` lists it; a test may mark it played in an editor, with its engine's judges. */
  game: {
    name: string;
    dir: string;
    facts: GameKind["facts"];
    holds?: string | null;
    editorPlay?: boolean;
    judges?: Array<{ id: string; label: string }>;
  };
  run: Record<string, unknown> & { runId: string; project: string; budgets: Record<string, unknown> };
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Moves the clock on without a wait (a turn that worked for a while). */
  pass: (ms: number) => void;
  turns: LoopTurn[];
  /** The reviewers' answers in order; with none left a reviewer says yes. */
  reviews: Array<Record<string, unknown>>;
  /** A step's answer at a moment, by the plugin tool's name, in place of an empty answer. */
  stepAnswers: Map<string, (hook: HookContext) => unknown>;
  /** The worker sessions the pool started, in order. */
  workers: WorkerSession[];
  /** How a judge's session answers its questions, by check id; yes to each when the test sets nothing. */
  judging: ((params: Record<string, unknown>, ids: string[]) => Record<string, unknown> | undefined) | null;
  /** The judges' sessions, as the Loop delegated them, in order. */
  judged: () => Array<Record<string, unknown>>;
  /** The run's artifacts by id, as `artifact.write` keeps them (the journal is one). */
  artifacts: Map<string, unknown>;
  /** The chat's run inbox: what the person said, and whether they asked to finish. */
  inbox: { said: string[]; finishing: boolean };
  /** The chat is in Plan mode: Genex holds every writing moment and checkpoint back. */
  planning: boolean;
  /** Whether the lead's session takes what is steered into its turn (`engine.steer`); it takes nothing by default. */
  steerTakes: boolean;
  /**
   * Whether a turn that took what was steered into it also read it (its result's `steered` names
   * each id it took); true by default. False: taken in, never read, as a session cut at its cap.
   */
  steerReads: boolean;
  /**
   * How a taken line reaches the turn: `native` (read mid-turn), or `interrupt` for a line Genex may
   * cut the turn for (an engine that takes no input as it works); `native` by default.
   */
  steerHow: "native" | "interrupt";
  /** What was steered into the lead's turns, in order. */
  steered: Array<{ id: string; text: string; interrupt: unknown }>;
  /** The run's jobs, as `jobs.list` answers them. */
  jobs: Array<Record<string, unknown>>;
  /** The calls in order (`tool:<plugin>__<tool>` for a moment's step, the snapshot where it is taken). */
  trail: () => string[];
  /** The records the Loop appended, of one type, in order. */
  appended: (eventType: string) => Array<Record<string, unknown>>;
  /** The lead's delegations, in order. */
  leadCalls: () => Array<Record<string, unknown>>;
  /** The lead turns' prompts, in order. */
  prompts: () => string[];
  /** What each reviewer was asked. */
  reviewed: () => Array<Record<string, unknown>>;
  /** Waits, in real time, until `done` holds; whether it did. */
  until: (done: () => boolean) => Promise<boolean>;
  /** Runs the Loop: the open profile unless the test names another; resolves with its report. */
  start: (options?: { resume?: boolean }) => Promise<Record<string, unknown>>;
  /**
   * Starts the run through the run's start (`handleRunStart`), as Resume or the chat's launch does:
   * the runner is chosen from the game as listed, and the Loop runs on the wall clock.
   */
  dispatch: (options?: { resume?: boolean }) => Promise<void>;
  /** git in the game folder, its output trimmed. */
  git: (...args: string[]) => Promise<string>;
};

type Internals = LoopHost & {
  log: string[];
  /** Each running worker session's stop, by the worker's id (the host's interrupt and abort). */
  stops: Map<string, () => void>;
  events: Array<{ id: string; data: Record<string, unknown> }>;
  snapshots: number;
  /** Each snapshot's commit in the game folder, by its id. */
  commits: Map<string, string>;
  manifest: LoopManifest | null;
  workerTypes: readonly WorkerType[];
  /** The host's finish checks over this fake: the reviewers it started, with their params. */
  review: ReturnType<typeof fakeFinishReview>;
  /** The recorder's own call, which leaves the trail alone (the host's own records). */
  plainCall: (method: string, params: Record<string, unknown>) => Promise<unknown>;
};

/** The host's finish checks, its reviewer answering from the test's script (a yes when none is left). */
function finishReview(host: Internals) {
  return fakeFinishReview({
    delegate: () => host.reviews.shift() ?? reviewerAnswer("yes", ["it holds what was asked"]),
    // Through the recorder, off the trail: the log keeps it as it keeps every other record.
    append: (payload) =>
      host.plainCall("events.append", {
        threadId: host.threadId,
        batch: [{ type: "custom", event_type: "finish_check", payload }],
      }),
    records: () =>
      host.events
        .map((event) => event.data as { event_type?: string; payload?: Record<string, unknown> })
        .filter((data) => data.event_type === "finish_check")
        .map((data) => data.payload ?? {}),
  });
}

/** A shell command in a folder, answered as `run.exec` answers. */
async function shell(command: string, cwd: string) {
  try {
    const { stdout, stderr } = await run("/bin/sh", ["-c", command], { cwd });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const failed = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failed.code === "number" ? failed.code : 1,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
    };
  }
}

/** A folder made a git repository with one commit, as a game folder is. */
export async function gameRepo(dir: string): Promise<string> {
  await gitFile(["init", "-q", "-b", "main"], { cwd: dir });
  await gitFile(["add", "-A"], { cwd: dir });
  await gitFile(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "first"], { cwd: dir });
  return dir;
}

/** git in the game folder as the host's snapshots run it, under a fixed name. */
const commitArgs = (message: string) => [
  "-c",
  "user.name=t",
  "-c",
  "user.email=t@t",
  "commit",
  "-q",
  "--allow-empty",
  "-m",
  message,
];

/** What the host's own `git add` leaves out of every snapshot (`git-policy.ts`): the folder's private env files. */
const PRIVATE_ENV_PATHS = [":(glob,exclude)**/.env", ":(glob,exclude)**/.env.*"];

/** A snapshot of the game folder, as the host takes one: everything but the private env files committed, its commit kept by id. */
async function commitSnapshot(host: Internals, label: string) {
  await gitFile(["add", "-A", "--", ".", ...PRIVATE_ENV_PATHS], { cwd: host.dir });
  await gitFile(commitArgs(label), { cwd: host.dir });
  const head = (await shell("git rev-parse HEAD", host.dir)).stdout.trim();
  host.snapshots += 1;
  const id = `snap-${host.snapshots}`;
  host.commits.set(id, head);
  return { snapshot_id: id, scope: "game", git: { game: head }, created_at: new Date(0).toISOString(), reason: label };
}

/** A restore of the game folder, as the host's is: a rescue snapshot, then the folder reset to the snapshot's commit. */
async function resetToSnapshot(host: Internals, snapshotId: unknown): Promise<void> {
  const commit = host.commits.get(String(snapshotId));
  if (!commit) return;
  await commitSnapshot(host, `rescue before ${String(snapshotId)}`);
  await gitFile(["reset", "-q", "--hard", commit], { cwd: host.dir });
  await gitFile(["clean", "-qfd"], { cwd: host.dir });
}

/** The bus over this host: the manifest's plan for the game's facts, the test's step answers, the trail. */
function busOf(host: Internals): BusHost {
  return {
    plugins: () => (host.manifest ? [{ id: host.manifest.id, manifest: host.manifest }] : []),
    game: { facts: host.game.facts },
    planning: () => host.planning,
    now: host.now,
    sleep: host.sleep,
    step: async (_plugin, tool, hook) => {
      const own = host.stepAnswers.get(tool);
      return own ? own(hook) : {};
    },
    // Nobody uses the app, and something in it is unsaved.
    probe: async () => ({ personActive: false, unsaved: 1 }),
    log: (entry) => host.log.push(entry),
    snapshot: (label) => commitSnapshot(host, label),
  };
}

/** The moments the manifest's plugin hooks for the game, as `game.list` lists them. */
function hookEventsFor(host: Internals): HookEvent[] {
  return host.manifest
    ? hookEventsOf([{ id: host.manifest.id, manifest: host.manifest }], { facts: host.game.facts })
    : [];
}

/** One lead turn: the next scripted one, or one that does nothing. What was steered into it and read, it names. */
async function leadTurn(host: Internals, params: Record<string, unknown>, n: number) {
  const turn = host.turns.shift();
  const runId = String((params.director as { runId?: string } | undefined)?.runId ?? "");
  const tool = (name: string, args: Record<string, string> = {}) => directorTool({ runId, name, args });
  const steeredFrom = host.steered.length;
  const own = turn ? await turn({ params, tool, host, n }) : undefined;
  await tick();
  const sessionId = String(params.resume ?? `lead-session-${n}`);
  const read = host.steerTakes && host.steerReads ? host.steered.slice(steeredFrom).map((one) => one.id) : [];
  const result = { ok: true, engine: String(host.run.engine), summary: "worked", usage: {}, turns: 2, sessionId };
  return { ...result, steered: read, ...own };
}

/** A pool worker's session: pending until the test ends it (or the pool stops it). */
function workerSession(host: Internals, params: Record<string, unknown>): Promise<unknown> {
  const id = String((params.worker as { id?: unknown }).id);
  return new Promise((resolve) => {
    let over = false;
    const finish = (result: Record<string, unknown>) => {
      if (over) return;
      over = true;
      resolve({ engine: String(host.run.engine), turns: 1, usage: {}, sessionId: `worker-${id}`, ...result });
    };
    const end: WorkerSession["end"] = async ({ ok = true, summary = "done", files = {} } = {}) => {
      const where = typeof params.cwd === "string" ? params.cwd : host.dir;
      for (const [file, text] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(where, file)), { recursive: true });
        await writeFile(path.join(where, file), text);
      }
      finish({ ok, summary });
    };
    host.workers.push({ params, id, end });
    host.stops.set(id, () => finish({ ok: false, stopReason: "stopped" }));
  });
}

/** The check ids a judge's prompt asks it to answer (`- <id>: <question>`). */
function askedIds(prompt: string): string[] {
  const from = prompt.indexOf("QUESTIONS TO ANSWER");
  if (from < 0) return [];
  return [...prompt.slice(from).matchAll(/^- ([^:\s]+): /gm)].map((match) => match[1] ?? "");
}

/** A judge's session: its answers as the judge's JSON reply, yes to each question unless the test says otherwise. */
function judgeSession(host: Internals, params: Record<string, unknown>) {
  const ids = askedIds(String(params.prompt ?? ""));
  const answers = Object.fromEntries(ids.map((id) => [id, { answer: "yes", note: "played it through", frames: [] }]));
  const own = host.judging?.(params, ids);
  const summary = JSON.stringify({ answers, ...own });
  const trace = { path: `/runs/${host.run.runId}/judge-${host.judged().length}/trace.jsonl`, actions: 3 };
  return { ok: true, engine: String(host.run.engine), summary, usage: {}, turns: 3, trace };
}

/** The run's events as the log keeps them: what the test seeded, then every append. */
function append(host: Internals, params: Record<string, unknown>): { ids: string[] } {
  const batch = (params.batch ?? []) as Array<Record<string, unknown>>;
  const ids = batch.map((data) => {
    const id = `e${String(host.events.length + 1).padStart(4, "0")}`;
    host.events.push({ id, data });
    return id;
  });
  return { ids };
}

/**
 * The pictures a checkpoint's after steps took, kept as the plugin's observer's capture, as the host
 * keeps them (`observers.keepCheckpoint`): one `observer_capture` with source `checkpoint`.
 */
function keepCheckpointPictures(
  host: Internals,
  params: Record<string, unknown>,
  answer: Record<string, unknown>,
): void {
  const images = Array.isArray(answer.images) ? (answer.images as Array<{ name: string }>) : [];
  const observer = (host.manifest as { observers?: Array<{ id: string }> } | null)?.observers?.[0];
  if (!images.length || !observer || !host.manifest) return;
  const payload = {
    runId: host.run.runId,
    project: host.run.project,
    observer: `${host.manifest.id}/${observer.id}`,
    label: `${observer.id} at ${String(params.label)}`,
    source: "checkpoint",
    images: images.map((image) => ({ name: image.name, file: `/runs/${host.run.runId}/${image.name}.png` })),
    at: new Date(0).toISOString(),
  };
  host.events.push({
    id: `e${String(host.events.length + 1).padStart(4, "0")}`,
    data: { type: "custom", event_type: "observer_capture", payload },
  });
}

/** The host's answers to snapshots and copies: real git worktrees beside the game folder. */
function snapshotHandlers(host: Internals) {
  return {
    "snapshot.create": (params: Record<string, unknown>) => commitSnapshot(host, String(params.reason)),
    "snapshot.worktree": async (params: Record<string, unknown>) => {
      const dir = path.join(path.dirname(host.dir), `${path.basename(host.dir)}-${String(params.name)}`);
      await gitFile(["worktree", "add", "-q", "--detach", dir, String(params.commit ?? "HEAD")], { cwd: host.dir });
      return { path: dir, commit: (await shell("git rev-parse HEAD", dir)).stdout.trim() };
    },
    "snapshot.removeWorktree": async (params: Record<string, unknown>) => {
      await gitFile(["worktree", "remove", "--force", String(params.path)], { cwd: host.dir }).catch(() => {});
      return true;
    },
    "snapshot.restore": (params: Record<string, unknown>) =>
      restore(busOf(host), params, () => resetToSnapshot(host, params.snapshotId)),
    "checkpoint.take": async (params: Record<string, unknown>) => {
      const answer = await checkpoint(busOf(host), params);
      keepCheckpointPictures(host, params, answer);
      return answer;
    },
    "hooks.fire": (params: Record<string, unknown>) => fire(busOf(host), params),
  };
}

/** The host's answers, by method. */
function handlers(host: Internals) {
  let leadTurns = 0;
  const stop = (params: Record<string, unknown>) => {
    host.stops.get(String(params.worker))?.();
    return { aborted: 1 };
  };
  return {
    ...snapshotHandlers(host),
    ...host.review.handlers,
    "events.append": (params: Record<string, unknown>) => append(host, params),
    "events.list": (params: Record<string, unknown>) => {
      const from = host.events.findIndex((event) => event.id === params.after);
      return host.events.slice(from + 1);
    },
    "events.head": () => host.events.at(-1)?.id ?? null,
    "game.list": () => [{ ...host.game, hookEvents: hookEventsFor(host) }],
    "engine.describe": () => [{ id: String(host.run.engine), kind: "delegated", supportsSessions: true }],
    "plugins.workerTypes": () => [...host.workerTypes],
    "engine.delegate": (params: Record<string, unknown>) => {
      if (params.worker) return workerSession(host, params);
      if (params.playtest) return judgeSession(host, params);
      return leadTurn(host, params, ++leadTurns);
    },
    "engine.steer": (params: Record<string, unknown>) => {
      const messages = (params.messages ?? []) as Array<{ id: string; text: string }>;
      for (const message of messages) host.steered.push({ ...message, interrupt: params.interrupt });
      if (!host.steerTakes) return { how: null, accepted: [] };
      const how = host.steerHow === "interrupt" && params.interrupt === true ? "interrupt" : "native";
      return { how, accepted: messages.map((message) => message.id) };
    },
    "engine.interrupt": stop,
    "engine.abort": stop,
    "artifact.write": (params: Record<string, unknown>) => {
      host.artifacts.set(String(params.artifactId), structuredClone(params.value));
      return 1;
    },
    "artifact.read": (params: Record<string, unknown>) =>
      structuredClone(host.artifacts.get(String(params.artifactId)) ?? null),
    "run.artifact": (params: Record<string, unknown>) => `/runs/${String(params.runId)}/${String(params.name)}`,
    "run.exec": (params: Record<string, unknown>) =>
      shell(String(params.command), typeof params.cwd === "string" ? params.cwd : host.dir),
    "jobs.list": () => ({
      jobs: structuredClone(host.jobs),
      seq: Math.max(0, ...host.jobs.map((job) => (typeof job.endSeq === "number" ? job.endSeq : 0))),
    }),
    "observers.capture": () => [],
    "locks.hold": () => ({ held: true, labels: [] }),
    "locks.release": () => true,
    // A judge's window: the pool always has one free.
    "preview.capacity": () => ({ max: 4, inUse: 0, headless: true }),
    "preview.acquire": (params: Record<string, unknown>) => ({ handle: `window-${String(params.label)}` }),
    "preview.release": () => true,
  };
}

/** The chat's contractor bookmark, as the chat leaves it before the Loop. */
function bookmark(project: string, engine: string) {
  return { type: "custom", event_type: "contractor_session", payload: { project, engine, sessionId: CHAT_SESSION } };
}

/** Starts the host's run through the run's start, over the loop's own state as main.ts makes it. */
async function dispatchThrough(host: LoopHost, { resume = false }: { resume?: boolean } = {}): Promise<void> {
  const ctx = host.rec.ctx;
  const studio = {
    host: ctx,
    cancels: new Set<string>(),
    stoppedMessages: new Set<string>(),
    moodBoards: new Map(),
    activeRuns: new Map(),
    startingRuns: new Map(),
    orphanRuns: new Map(),
    scoped: () => ctx,
  };
  const action = {
    type: "run_start" as const,
    threadId: host.threadId,
    run: structuredClone(host.run) as never,
    resume,
  };
  await handleRunStart(studio as never, action);
}

/** A fake host for Loops on one game; the test hands it the game folder (a git repository) and its facts. */
export function loopHost(options: {
  dir: string;
  facts: GameKind["facts"];
  holds?: string | null;
  name?: string;
  manifest?: LoopManifest | null;
  workerTypes?: readonly WorkerType[];
  turns?: LoopTurn[];
  run?: Record<string, unknown>;
  /** The harness workspace the Loop reads its skills from; a fake path by default. */
  workspace?: string;
  /**
   * The chat the Loop runs in. A chat's workers' questions are read once per chat in a process
   * (`waitingWorkers`): a test that leaves one pending names a chat of its own.
   */
  threadId?: string;
}): LoopHost {
  const name = options.name ?? path.basename(options.dir);
  const host = {
    dir: options.dir,
    game: {
      name,
      dir: options.dir,
      facts: options.facts,
      ...(options.holds === undefined ? {} : { holds: options.holds }),
    },
    run: {
      runId: "run-open",
      goal: "A small level the player can walk through, with a door that opens.",
      project: name,
      mode: "autopilot",
      engine: "claude-code",
      reference: { name: "Level", shots: [] },
      budgets: { wallClockMs: 3 * HOUR, completionPolicy: "goal" },
      ...options.run,
    },
    turns: [...(options.turns ?? [])],
    reviews: [],
    stepAnswers: new Map(),
    workers: [],
    judging: null,
    artifacts: new Map<string, unknown>(),
    inbox: { said: [], finishing: false },
    planning: false,
    steerTakes: false,
    steerReads: true,
    steerHow: "native",
    steered: [],
    jobs: [],
    log: [],
    events: [],
    snapshots: 0,
    commits: new Map(),
    stops: new Map(),
    manifest: options.manifest ?? null,
    workerTypes: options.workerTypes ?? [],
  } as unknown as Internals;
  let skew = 0;
  host.now = () => Date.now() + skew;
  host.sleep = async (ms: number) => {
    skew += ms;
    await delay(1);
  };
  host.pass = (ms) => {
    skew += ms;
  };
  host.events.push({ id: "e0000", data: bookmark(name, String(host.run.engine)) });
  host.threadId = options.threadId ?? THREAD;
  host.review = finishReview(host);
  host.rec = ctxRecorder({
    threadId: host.threadId,
    handlers: handlers(host),
    ...(options.workspace ? { workspace: options.workspace } : {}),
  });
  Object.assign(host.rec.ctx, {
    runInbox: {
      finishing: async () => host.inbox.finishing,
      steering: async (_address?: unknown, consume?: boolean) =>
        consume ? host.inbox.said.splice(0) : [...host.inbox.said],
      backlog: async () => [...host.inbox.said],
    },
  });
  const plain = host.rec.ctx.call.bind(host.rec.ctx);
  host.plainCall = plain;
  host.rec.ctx.call = (method: string, params?: Record<string, unknown>) => {
    if (!["hooks.fire", "checkpoint.take", "snapshot.restore"].includes(method)) host.log.push(method);
    return plain(method, params);
  };
  host.trail = () => [...host.log];
  host.appended = (eventType) =>
    host.events
      .map((event) => event.data as { event_type?: string; payload?: Record<string, unknown> })
      .filter((data) => data.event_type === eventType)
      .map((data) => data.payload ?? {});
  host.leadCalls = () =>
    host.rec.paramsOf("engine.delegate").filter((p) => !asksReviewer(p) && !p.worker && !p.playtest);
  host.judged = () => host.rec.paramsOf("engine.delegate").filter((p) => Boolean(p.playtest));
  host.prompts = () => host.leadCalls().map((p) => String(p.prompt));
  host.reviewed = () => [...host.review.asked];
  host.until = async (done) => {
    const by = Date.now() + UNTIL_MS;
    while (!done() && Date.now() < by) await delay(1);
    return done();
  };
  host.git = async (...args) => String((await gitFile(args, { cwd: host.dir })).stdout).trim();
  host.start = ({ resume = false } = {}) =>
    runDirector(host.rec.ctx as never, {
      threadId: host.threadId,
      run: structuredClone(host.run) as never,
      resume,
      profile: LoopProfile.Open,
      clock: { now: host.now, sleep: host.sleep },
    });
  host.dispatch = (options) => dispatchThrough(host, options);
  return host;
}
