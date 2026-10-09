/**
 * A game chat with a run started in it and a worker seat to delegate: a real core (`coreLite`), fake
 * delegated engines that record each request and do what the test says while their turn runs, a
 * copy of the game under the run's own folder in scratch, and the chat's `tool_permission` rows.
 * No harness: the test writes the run's start records itself, as the harness does. Waits are on
 * what happened (a request the engine saw, a card the core announced), never on a clock.
 */
import assert from "node:assert/strict";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { customRecord } from "../../src/shared/custom-events.ts";
import type { ToolPermissionEvent } from "../../src/shared/permissions.ts";
import { UiEvent } from "../../src/shared/ui-events.ts";
import type {
  DelegateRequest,
  DelegateResult,
  PermissionAsk,
  PermissionReply,
} from "../../src/substrate/engines/types.ts";
import type { AppLookPort, ScreenAccess } from "../../src/substrate/app-look.ts";
import type { JobSpawn } from "../../src/substrate/jobs.ts";
import { type CoreLite, type CoreLiteOptions, coreLite } from "./core-lite.ts";
import { tmpDir } from "./tmp.ts";

export const CLAUDE = "claude-code";
export const CODEX = "codex";
/** A local model's engine: it runs sessions, but carries no worker's seat. */
export const LOCAL = "local-model";
/** The run every worker chat starts in its chat, running until the test finishes it. */
export const RUN_ID = "run_workers";
/** How often a test looks for something it cannot be told of, and how many times. */
export const POLL_MS = 25;
export const POLL_TRIES = 200;

/** What a fake engine does while its turn runs. */
export type During = (request: DelegateRequest) => Promise<void>;
/** The substrate table the harness calls, by method name. */
export type Api = Record<string, (params: unknown) => Promise<unknown>>;
/** What a seat's asks are, as a session asks through them. */
export type DelegateRequestAsk = (request: PermissionAsk, signal: AbortSignal) => Promise<PermissionReply>;

const lites: CoreLite[] = [];

/** Stop every core a worker chat started; a test file calls it in its `after`. */
export async function closeWorkerChats(): Promise<void> {
  for (const lite of lites.splice(0)) await lite.close();
}

/** Something a test waits to be told of: a promise for the next change, and its signal. */
export class Changes {
  #waiters: Array<() => void> = [];
  /** The next change. Ask for it before reading the state it changes, so none is missed. */
  next(): Promise<void> {
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
  /** A change happened: everyone waiting hears it. */
  notify(): void {
    for (const resolve of this.#waiters.splice(0)) resolve();
  }
}

/** Wait until `done` holds, reading it again on each change. */
export async function until(changes: Changes, done: () => boolean | Promise<boolean>): Promise<void> {
  for (;;) {
    const next = changes.next();
    if (await done()) return;
    await next;
  }
}

/** What kind of engine a fake is: a delegated one carries a worker's seat; a direct one (a local model) does not. */
export type FakeKind = "delegated" | "direct";

/** A fake engine that records each request, tells `seen` of it, and does what the test says while its turn runs. */
function fakeEngine(
  engine: { id: string; kind: FakeKind; permissionPrompts: boolean },
  seen: DelegateRequest[],
  saw: Changes,
  during: () => During,
) {
  return {
    ...engine,
    label: engine.id,
    supportsSessions: true,
    // A chat's own session takes steered messages mid-turn when its turn says so (`request.steer`).
    steersMidTurn: true,
    status: async () => ({ code: "ready", detail: "fixture" }),
    models: async () => [],
    delegate: async (request: DelegateRequest): Promise<DelegateResult> => {
      seen.push(request);
      saw.notify();
      await during()(request);
      return { ok: true, engine: engine.id, sessionId: `s${seen.length}`, turns: 1, usage: {}, summary: "" };
    },
  } as never;
}

/** The tool permission rows of a thread, as the chat keeps them. */
export async function permissionRows(core: CoreLite["core"], threadId: string): Promise<ToolPermissionEvent[]> {
  return (await core.store.listEvents(threadId)).flatMap((event) => {
    const custom = customRecord(event.data);
    return custom?.event_type === "tool_permission" ? [custom.payload as unknown as ToolPermissionEvent] : [];
  });
}

/** The seat's way to ask, when it has one. */
export const workerAsks = (request: DelegateRequest) => request.worker?.asks;

/** A path as the host spells it: its real path, as far as it exists. */
export async function realNearest(target: string): Promise<string> {
  const real = await realpath(target).catch(() => null);
  if (real) return real;
  return path.join(await realNearest(path.dirname(target)), path.basename(target));
}

/**
 * A game chat on an engine that asks, another game, and a run started in the chat that is running,
 * with a copy of the game under the run's own folder in scratch.
 */
export async function workerChat(
  options: {
    leadAskTimeoutMs?: number;
    consentTimeoutMs?: number;
    neverTouchGames?: string[];
    /** How the core starts agent jobs (`job-tools`); a lite core's default is the sandbox's. */
    jobSpawn?: JobSpawn;
    /** How the core looks at app windows (`app_look`); a lite core's default answers macOS only. */
    appLook?: AppLookPort;
    /** macOS access for `app_look`; none: the core looks without asking. */
    screenAccess?: ScreenAccess;
    /** The core's locks: how long an agent's call waits for one (`plugin-locks`). */
    locks?: CoreLiteOptions["locks"];
  } = {},
) {
  /** The core announced a card (`UiEvent.ToolPermission`): a test waiting for one reads the rows again. */
  const cards = new Changes();
  const lite = await coreLite({
    gamesRoot: await realpath(await tmpDir("worker-seats-games-")),
    onUiEvent: (event) => {
      if (event.type === UiEvent.ToolPermission) cards.notify();
    },
    ...options,
  });
  lites.push(lite);
  const { core } = lite;
  // No harness in a lite core: a dispatch reaches nothing.
  core.host.dispatch = async () => undefined;
  const seen: DelegateRequest[] = [];
  const saw = new Changes();
  let during: During = async () => {};
  core.engines.register(
    fakeEngine({ id: CLAUDE, kind: "delegated", permissionPrompts: true }, seen, saw, () => during),
  );
  core.engines.register(
    fakeEngine({ id: CODEX, kind: "delegated", permissionPrompts: false }, seen, saw, () => during),
  );
  core.engines.register(fakeEngine({ id: LOCAL, kind: "direct", permissionPrompts: false }, seen, saw, () => during));
  const project = await core.games.scaffold("worker-seats");
  const other = await core.games.scaffold("worker-seats-other");
  const game = project.name;
  const threadId = await core.threadForGame(game);
  const api = core.api() as unknown as Api;
  /** A run's start on the record of `thread`, as the harness writes it, running until it finishes. */
  const startRun = async (runId: string, thread = threadId, forGame = game) => {
    await core.append(
      [
        { type: "custom", event_type: "run_registered", payload: { runId, project: forGame, mode: "director" } },
        { type: "custom", event_type: "run_started", payload: { runId, project: forGame } },
      ] as never,
      thread,
    );
  };
  /** A copy of the game under a run's own folder in scratch, as the pool makes a writer's copy. */
  const copyOf = async (runId: string, name: string) => {
    const dir = path.join(core.layout.scratch, "autopilot", runId, name);
    await mkdir(path.dirname(dir), { recursive: true });
    core.snapshots.register({ name: game, dir: project.dir });
    await core.snapshots.worktreeAt(game, "HEAD", dir);
    return dir;
  };
  await startRun(RUN_ID);
  const worktree = await copyOf(RUN_ID, "w1");
  const delegate = (extra: Record<string, unknown>, engine = CLAUDE) =>
    api["engine.delegate"]!({ engine, prompt: "go", project: game, threadId, ...extra });
  /** A worker of the chat's run, in its own copy. */
  const runWorker = (id = "w1", cwd = worktree, extra: Record<string, unknown> = {}, runId = RUN_ID) => ({
    cwd,
    worker: { id, title: `Worker ${id}`, runId },
    ...extra,
  });
  let sent = 0;
  /** The person sends a message in the chat, as the composer does. */
  const personSays = async (): Promise<string> => {
    const messageId = `msg-worker-${++sent}`;
    await core.sendUserMessage("Build the level", { thread: threadId, clientId: messageId, engine: CLAUDE });
    return messageId;
  };
  /** Wait for a card the given rows did not have. */
  const nextCard = async (known: Set<string>): Promise<ToolPermissionEvent> => {
    let card: ToolPermissionEvent | undefined;
    await until(cards, async () => {
      card = (await permissionRows(core, threadId)).find((row) => !known.has(row.requestId));
      return card !== undefined;
    });
    if (!card) throw new Error("no card reached the chat");
    return card;
  };
  /** Wait until the engines have seen `count` requests. */
  const untilSeen = (count: number) => until(saw, () => seen.length >= count);
  /** Wait until the engines have seen a request `matches` holds for. */
  const untilRequest = (matches: (request: DelegateRequest) => boolean) => until(saw, () => seen.some(matches));
  /**
   * A session briefed with `extra` asks `ask` once through `asksOf`; `card` is the pending row it
   * left, and `done` its answer once the turn returned.
   */
  const asking = async (
    ask: Omit<PermissionAsk, "toolUseId">,
    extra: Record<string, unknown>,
    asksOf: (request: DelegateRequest) => { ask: DelegateRequestAsk } | undefined,
  ) => {
    const known = new Set((await permissionRows(core, threadId)).map((row) => row.requestId));
    let answer: PermissionReply | undefined;
    during = async (request) => {
      const asks = asksOf(request);
      if (asks) answer = await asks.ask({ toolUseId: `tu-${known.size}`, ...ask }, new AbortController().signal);
    };
    const turn = delegate(extra).finally(() => {
      during = async () => {};
    });
    const card = await nextCard(known);
    return {
      card,
      done: async () => {
        await turn;
        return answer;
      },
    };
  };
  /** The person's "always allow this folder in this chat", answered on a card of the chat's own session. */
  const grantFolder = async (dir: string) => {
    const said = await personSays();
    const { card, done } = await asking(
      { tool: "Read", input: { file_path: path.join(dir, "a.png") }, always: [{ kind: "directory", path: dir }] },
      { chatTurn: { messageId: said } },
      (request) => request.permissions,
    );
    assert.equal(core.answerPermission(card.requestId, { decision: "always" }), true);
    await done();
  };
  return {
    lite,
    core,
    api,
    project,
    other,
    game,
    threadId,
    worktree,
    seen,
    delegate,
    runWorker,
    startRun,
    copyOf,
    personSays,
    asking,
    grantFolder,
    rows: () => permissionRows(core, threadId),
    untilSeen,
    untilRequest,
    nextCard,
    whileRunning: (does: During) => {
      during = does;
    },
  };
}
