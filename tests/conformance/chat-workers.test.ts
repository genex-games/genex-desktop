/**
 * Workers in a chat: the chat's own session, answering a turn on an engine that carries a worker's
 * seat, is offered the worker tools (never a worker, a run's builder or lead, the coordinator or a
 * local model's session); the seed's chat turn hands its session the tools and the brief's line and
 * closes the pool however the turn ends; a worker tool call reaches the harness's pool of the live
 * turn only; Plan holds writers and merges (no snapshot, no copy, no delegation, no merge) while a
 * reader runs; and a worker the pool starts carries the turn's grant, on the Workers role's engine,
 * which the host honours by seating it in the chat's mode. Real core, fake engines, and the seed's
 * own pool answering the host's dispatch.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { runDelegatedTurn } from "../../src/harness-seed/loop/delegated-turn.ts";
import { chatWorkerTool, closeChatWorkers, openChatWorkers } from "../../src/harness-seed/loop/workers/chat-workers.ts";
import { WORKERS_BRIEF_LINE } from "../../src/harness-seed/loop/workers/prompts.ts";
import { keptRef } from "../../src/harness-seed/loop/workers/records.ts";
import { WORKER_TOOLS } from "../../src/harness-seed/loop/workers/specs.ts";
import { SessionActivityRole } from "../../src/shared/chat-activity.ts";
import { CustomEvent, customRecord } from "../../src/shared/custom-events.ts";
import { HostMethod } from "../../src/shared/harness-api.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import { DispatchActionType, HarnessCapability } from "../../src/shared/protocol.ts";
import { WORKER_ASK_CHARS, WorkerTool } from "../../src/shared/workers.ts";
import type { DelegateRequest, LiveToolResult } from "../../src/substrate/engines/types.ts";
import { type CtxHandler, type CtxRecorder, ctxRecorder } from "../helpers/ctx-recorder.ts";
import { gitFile } from "../helpers/git.ts";
import { closeWorkerChats, CODEX, LOCAL, RUN_ID, workerChat } from "../helpers/worker-chat.ts";

/** A case that would hang on a regression fails within this instead; each case has its own. */
const CASE_TIMEOUT_MS = 60_000;
const WORKER_TOOL_NAMES = Object.values(WorkerTool).sort();
/** What the host answers a writer's start, and a merge, while the chat plans. */
const WRITERS_WAIT = /The chat is in Plan: writers start once the person approves your plan/;
const MERGES_WAIT = /The chat is in Plan: a worker's work is merged once the person approves your plan/;
/** A Codex model id: a Workers role naming it runs the workers on Codex. */
const CODEX_MODEL = "gpt-5.6-sol";

after(closeWorkerChats);

type Chat = Awaited<ReturnType<typeof workerChat>>;

/** The worker tools a delegated session was handed. */
const workerToolsOf = (request: DelegateRequest | undefined) =>
  (request?.liveTools ?? []).map((tool) => tool.name).filter((name) => WORKER_TOOL_NAMES.includes(name as never));

/** A tool's answer, as text. */
const textOf = (answer: LiveToolResult | undefined) => (typeof answer === "string" ? answer : (answer?.text ?? ""));

/** The substrate table as a recorder's handlers: every call reaches the real core. */
function coreHandlers(chat: Chat): Record<string, CtxHandler> {
  return Object.fromEntries(
    Object.entries(chat.api).map(([method, handler]) => [method, (params: Record<string, unknown>) => handler(params)]),
  );
}

/**
 * The harness, in process: a host that claims workers and hands every `worker_tool` dispatch to the
 * seed's chat pools, which call the core's own substrate table. Answers the dispatched actions.
 */
function harnessInProcess(chat: Chat): { dispatched: Array<Record<string, unknown>>; ctx: CtxRecorder } {
  const { core } = chat;
  const dispatched: Array<Record<string, unknown>> = [];
  const claims = core.host.hasCapability.bind(core.host);
  core.host.hasCapability = (capability) => capability === HarnessCapability.Workers || claims(capability);
  core.host.dispatch = async (action) => {
    dispatched.push(action as unknown as Record<string, unknown>);
    return action.type === DispatchActionType.WorkerTool ? chatWorkerTool(action) : undefined;
  };
  return { dispatched, ctx: ctxRecorder({ threadId: chat.threadId, handlers: coreHandlers(chat) }) };
}

/** Open the seed's pool for the chat turn `turn`, on the core, as a delegated chat turn does. */
function openPoolFor(chat: Chat, ctx: CtxRecorder, turn: string, commission: Record<string, unknown> | null = null) {
  return openChatWorkers(ctx.ctx as never, {
    threadId: chat.threadId,
    turn,
    engine: "claude-code",
    commission,
    project: chat.game,
    gameDir: chat.project.dir,
    folderLabel: `AI Games/${chat.game}`,
    facts: [{ id: "web-game", path: "." }],
  });
}

/**
 * The chat's own session answering `turn`, granted the worker tools: while its turn runs it makes
 * `calls` in order, then waits until a request `until` holds for has reached the engines. Answers
 * what each call answered.
 */
async function chatSessionCalls(
  chat: Chat,
  turn: string,
  calls: Array<[string, Record<string, unknown>]>,
  until: ((request: DelegateRequest) => boolean) | null = null,
): Promise<string[]> {
  const answers: string[] = [];
  chat.whileRunning(async (request) => {
    if (request.worker) return;
    for (const [name, args] of calls) answers.push(textOf(await request.onLiveTool?.(name, args)));
    if (until) await chat.untilRequest(until);
  });
  await chat.delegate({ chatTurn: { messageId: turn }, workers: { tools: WORKER_TOOLS } });
  chat.whileRunning(async () => {});
  return answers;
}

/** A steer handle that brings nothing in: the turn answers `messageId` and hears of no other message. */
function quietSteer(messageId: string) {
  return {
    messageId,
    carried: [],
    delivered: [],
    expect: async () => {},
    done: async () => {},
    open: async () => [],
    close: async () => [],
    deliver: async () => {},
    requeue: async () => {},
    inOrder: <T>(items: T[]) => items,
  };
}

/**
 * One chat turn through the seed's `runDelegatedTurn` on the chat's game: the host's game, snapshot
 * and git calls reach the real core; `delegate` answers each delegation. Answers the recorder.
 */
async function seedTurn(
  chat: Chat,
  options: {
    engine?: string;
    runId?: string;
    steer?: string;
    /** What the person said in the message the turn answers. */
    text?: string;
    /** The Loop commission the turn's message carries (`loop`), its roles included. */
    commission?: Record<string, unknown>;
    delegate?: (params: Record<string, unknown>) => Promise<unknown>;
    abort?: (params: Record<string, unknown>) => unknown;
  },
): Promise<CtxRecorder & { error: unknown }> {
  const real = coreHandlers(chat);
  const through = Object.fromEntries(
    Object.entries(real).filter(
      ([method]) => /^(game|snapshot|run)\./.test(method) && method !== HostMethod.RunArtifact,
    ),
  );
  const host = ctxRecorder({
    threadId: chat.threadId,
    unknown: { value: null },
    handlers: {
      ...through,
      [HostMethod.EventsMessages]: () => [{ role: "user", content: "build the level" }],
      [HostMethod.PluginsTools]: () => ({ tools: [], guidance: "", revision: 1 }),
      [HostMethod.EngineDescribe]: () => [],
      [HostMethod.EngineDelegate]: (params) =>
        options.delegate?.(params) ?? { ok: true, engine: "claude-code", turns: 1, usage: {}, summary: "Done." },
      [HostMethod.EngineAbort]: (params) => options.abort?.(params) ?? { aborted: 0 },
      [HostMethod.PreviewLoad]: () => true,
      [HostMethod.PreviewReady]: () => ({ ready: true, ms: 5 }),
      [HostMethod.PreviewStatus]: () => ({ loadError: null }),
      [HostMethod.PreviewConsole]: () => [],
      [HostMethod.PreviewObserve]: () => ({ ok: false, reasons: ["black canvas"] }),
    },
  });
  const turn = {
    threadId: chat.threadId,
    turnId: "turn-workers",
    text: options.text ?? "build the level",
    engine: options.engine ?? "claude-code",
    engineLabel: "Claude Code",
    project: chat.game,
    ...(options.steer ? { steer: quietSteer(options.steer) } : {}),
    ...(options.runId ? { runId: options.runId } : {}),
    ...(options.commission ? { loop: options.commission } : {}),
  };
  const error = await runDelegatedTurn(host.ctx as never, turn as never).then(
    () => null,
    (err: unknown) => err,
  );
  return Object.assign(host, { error });
}

/** A file at a revision of a repository, or null when it is not there. */
async function shown(dir: string, revision: string): Promise<string | null> {
  return gitFile(["show", revision], { cwd: dir }).then(
    ({ stdout }) => String(stdout),
    () => null,
  );
}

/** A repository's HEAD commit. */
async function headOf(dir: string): Promise<string> {
  return String((await gitFile(["rev-parse", "HEAD"], { cwd: dir })).stdout).trim();
}

describe("workers in a chat", () => {
  it("the chat's own session is offered the worker tools; a worker, a run's builder or lead, the coordinator and a local model's session are not", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const chat = await workerChat();
    harnessInProcess(chat);
    const { seen, delegate, runWorker, personSays, game, project, threadId } = chat;
    const turn = await personSays();
    const grant = {
      workers: { tools: [...WORKER_TOOLS, { name: "rm_everything", description: "x", parameters: {} }] },
    };
    await delegate({ chatTurn: { messageId: turn }, ...grant });
    assert.deepEqual(workerToolsOf(seen.at(-1)).sort(), WORKER_TOOL_NAMES, "the chat's own session");
    assert.ok(!seen.at(-1)?.liveTools?.some((tool) => tool.name === "rm_everything"), "only worker tools pass");
    const notOffered: Array<[string, Record<string, unknown>, string?]> = [
      ["a worker: depth is one", runWorker()],
      ["a run's builder", { cwd: chat.worktree, attribution: { runId: RUN_ID, agentId: "b1" } }],
      ["a session answering no turn", {}],
      [
        "a run's lead",
        {
          chatTurn: { messageId: RUN_ID },
          director: { runId: RUN_ID, threadId, project: game, root: project.dir, setup: null, tools: [] },
        },
      ],
      ["the run's coordinator", { coordinator: { runId: RUN_ID, messageId: turn }, readOnly: true }],
      ["a local model's own session", { chatTurn: { messageId: await personSays() } }, LOCAL],
    ];
    for (const [label, extra, engine] of notOffered) {
      await delegate({ ...extra, ...grant }, engine);
      assert.deepEqual(workerToolsOf(seen.at(-1)), [], label);
    }
  });

  it("the seed's chat turn hands its own session the worker tools and the brief's line; a run's turn, a local model and a turn with no message none", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const chat = await workerChat();
    const turn = await chat.personSays();
    const asked = (host: CtxRecorder) => host.paramsOf(HostMethod.EngineDelegate).at(-1) ?? {};
    const own = asked(await seedTurn(chat, { steer: turn }));
    const tools = (own.workers as { tools?: Array<{ name: string }> } | undefined)?.tools ?? [];
    assert.deepEqual(tools.map((tool) => tool.name).sort(), WORKER_TOOL_NAMES, "the chat's own session");
    assert.ok(String(own.prompt).includes(WORKERS_BRIEF_LINE), "its brief says it runs workers");
    assert.deepEqual(own.chatTurn, { messageId: turn });
    const none: Array<[string, Parameters<typeof seedTurn>[1]]> = [
      ["a run's turn", { steer: turn, runId: RUN_ID }],
      ["a local model's turn", { steer: turn, engine: "bonsai" }],
      ["a turn with no message", {}],
    ];
    for (const [label, options] of none) {
      const params = asked(await seedTurn(chat, options));
      assert.equal(params.workers, undefined, label);
      assert.ok(!String(params.prompt).includes(WORKERS_BRIEF_LINE), `${label}: no line`);
    }
  });

  it("a chat turn that fails or is stopped still stops its running worker, and a copy's work is kept on the chat's ref", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const chat = await workerChat();
    for (const ending of ["fails", "stopped"] as const) {
      const turn = await chat.personSays();
      const aborts: Array<Record<string, unknown>> = [];
      let stop: () => void = () => {};
      const stopped = new Promise<void>((resolve) => {
        stop = resolve;
      });
      let working: () => void = () => {};
      const atWork = new Promise<void>((resolve) => {
        working = resolve;
      });
      const ran = await seedTurn(chat, {
        steer: turn,
        abort: (params) => {
          aborts.push(params);
          stop();
          return { aborted: 1 };
        },
        delegate: async (params) => {
          if (params.worker) {
            await writeFile(path.join(String(params.cwd), "sky.txt"), "a sky\n");
            working();
            await stopped;
            return { ok: false, engine: "claude-code", turns: 1, usage: {}, summary: "", stopReason: "stopped" };
          }
          const started = await chatWorkerTool({
            threadId: chat.threadId,
            turn,
            name: WorkerTool.Start,
            args: { title: "Sky", task: "paint the sky", isolation: "copy" },
          });
          assert.match(started, /^Started w\d+ \(copy\)/, ending);
          await atWork;
          if (ending === "fails") throw new Error("the provider went away");
          return { ok: false, engine: "claude-code", turns: 1, usage: {}, summary: "", stopReason: "stopped" };
        },
      });
      if (ending === "fails") assert.match(String(ran.error), /the provider went away/, "the failure is the turn's");
      const [abort] = aborts;
      assert.ok(abort?.worker, `${ending}: the worker was stopped`);
      assert.match(
        await chatWorkerTool({ threadId: chat.threadId, turn, name: WorkerTool.Status, args: {} }),
        /No workers for this turn/,
      );
      const ref = keptRef({ scope: { threadId: chat.threadId } } as never, String(abort.worker));
      assert.equal(await shown(chat.project.dir, `${ref}:sky.txt`), "a sky\n", `${ending}: its copy's work is kept`);
    }
  });

  it("a chat turn's worker's start record names the turn's message and keeps what the person asked, clipped", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const chat = await workerChat();
    const turn = await chat.personSays();
    const asked = `Make the car drift less on straight roads. ${"It pulls left after every jump. ".repeat(12)}`;
    const ran = await seedTurn(chat, {
      steer: turn,
      text: asked,
      delegate: async (params) => {
        if (params.worker) return { ok: true, engine: "claude-code", turns: 1, usage: {}, summary: "Looked." };
        const args = { title: "Check the physics", task: "Read the car's physics.", isolation: "read" };
        await chatWorkerTool({ threadId: chat.threadId, turn, name: WorkerTool.Start, args });
        return { ok: true, engine: "claude-code", turns: 1, usage: {}, summary: "Done." };
      },
    });
    assert.equal(ran.error, null);
    const starts = ran
      .paramsOf(HostMethod.EventsAppend)
      .flatMap((params) => (params.batch as Array<Record<string, unknown>>) ?? [])
      .flatMap((data) => {
        const custom = customRecord(data as never);
        return custom?.event_type === CustomEvent.WorkerStarted ? [custom.payload] : [];
      });
    assert.equal(starts.length, 1);
    assert.equal(starts[0]?.turn, turn, "the start names the message the turn answers");
    assert.equal(starts[0]?.ask, asked.trim().slice(0, WORKER_ASK_CHARS), "and what the person asked, clipped");
  });

  it("a worker tool call reaches the harness for the live turn only", { timeout: CASE_TIMEOUT_MS }, async () => {
    const chat = await workerChat();
    const { dispatched, ctx } = harnessInProcess(chat);
    const turn = await chat.personSays();
    await openPoolFor(chat, ctx, turn);
    try {
      const [status] = await chatSessionCalls(chat, turn, [[WorkerTool.Status, {}]]);
      assert.match(status ?? "", /No workers yet in this chat/);
      const forwarded = dispatched.filter((action) => action.type === DispatchActionType.WorkerTool);
      assert.deepEqual(forwarded, [
        { type: DispatchActionType.WorkerTool, threadId: chat.threadId, turn, name: WorkerTool.Status, args: {} },
      ]);
      const stale = { threadId: chat.threadId, turn: "msg-earlier", name: WorkerTool.Start, args: {} };
      assert.match(await chatWorkerTool(stale), /No workers for this turn/);
    } finally {
      await closeChatWorkers(chat.threadId, turn);
    }
  });

  it("in Plan a writer waits for the plan's approval and a reader runs", { timeout: CASE_TIMEOUT_MS }, async () => {
    const chat = await workerChat();
    const { ctx } = harnessInProcess(chat);
    const turn = await chat.personSays();
    await chat.core.setPermissionMode(chat.threadId, PermissionMode.Plan);
    const pool = await openPoolFor(chat, ctx, turn);
    try {
      const writers: Array<[string, Record<string, unknown>]> = [
        [WorkerTool.Start, { title: "Copy writer", task: "x", isolation: "copy" }],
        [WorkerTool.Start, { title: "In place", task: "x", isolation: "lock" }],
        [WorkerTool.Start, { title: "No isolation", task: "x" }],
      ];
      const reader: [string, Record<string, unknown>] = [
        WorkerTool.Start,
        { title: "Reader", task: "x", isolation: "read" },
      ];
      const answers = await chatSessionCalls(chat, turn, [...writers, reader], (request) => Boolean(request.worker));
      for (const answer of answers.slice(0, writers.length)) assert.match(answer, WRITERS_WAIT);
      assert.match(answers.at(-1) ?? "", /Started w1 \(read\)/);
      assert.deepEqual(ctx.sequence("snapshot."), [], "no snapshot (Plan holds checkpoints) and no copy");
      const workerRequests = chat.seen.filter((request) => request.worker);
      assert.equal(workerRequests.length, 1, "only the reader was delegated");
      assert.equal(workerRequests[0]?.worker?.mode, PermissionMode.Plan, "and it reads in Plan");
      assert.deepEqual(
        pool.state.records.map((record) => record.title),
        ["Reader"],
      );
    } finally {
      await closeChatWorkers(chat.threadId, turn);
    }
  });

  it("in Plan a worker's kept work is not merged: worker_mark used waits for the plan's approval and the game folder stays as it was", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const chat = await workerChat();
    const { ctx, dispatched } = harnessInProcess(chat);
    await chat.core.setPermissionMode(chat.threadId, PermissionMode.AcceptEdits);
    // Turn 1: a copy worker writes, ends, and its work is kept on the chat's ref.
    const first = await chat.personSays();
    await openPoolFor(chat, ctx, first);
    chat.whileRunning(async (request) => {
      // No chat session answers this turn, so the host runs the copy worker unattended: it still writes.
      if (!request.permissions) await writeFile(path.join(request.cwd, "sky.txt"), "a sky\n");
    });
    const started = await chatWorkerTool({
      threadId: chat.threadId,
      turn: first,
      name: WorkerTool.Start,
      args: { title: "Sky", task: "paint the sky", isolation: "copy" },
    });
    assert.match(started, /^Started w1 \(copy\)/);
    await chatWorkerTool({ threadId: chat.threadId, turn: first, name: WorkerTool.Wait, args: { id: "w1" } });
    await closeChatWorkers(chat.threadId, first);
    // Turn 2, in Plan: the lead asks to merge it.
    const head = await headOf(chat.project.dir);
    await chat.core.setPermissionMode(chat.threadId, PermissionMode.Plan);
    const second = await chat.personSays();
    await openPoolFor(chat, ctx, second);
    try {
      const before = dispatched.length;
      const [held] = await chatSessionCalls(chat, second, [[WorkerTool.Mark, { id: "w1", verdict: "used" }]]);
      assert.match(held ?? "", MERGES_WAIT);
      assert.equal(dispatched.length, before, "nothing reached the harness");
      assert.equal(await headOf(chat.project.dir), head, "the game folder's history is as it was");
      assert.equal(await shown(chat.project.dir, "HEAD:sky.txt"), null, "nothing merged");
      const kept = keptRef({ scope: { threadId: chat.threadId } } as never, "w1");
      assert.equal(await shown(chat.project.dir, `${kept}:sky.txt`), "a sky\n", "the work stays kept for later");
    } finally {
      await closeChatWorkers(chat.threadId, second);
    }
  });

  it("a worker's delegation carries the turn's grant, and the host seats it in the chat's mode", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const chat = await workerChat();
    const { ctx } = harnessInProcess(chat);
    await chat.core.setPermissionMode(chat.threadId, PermissionMode.AcceptEdits);
    const turn = await chat.personSays();
    await openPoolFor(chat, ctx, turn);
    try {
      const start: [string, Record<string, unknown>] = [
        WorkerTool.Start,
        { title: "Tune the jump", task: "x", isolation: "lock" },
      ];
      await chatSessionCalls(chat, turn, [start], (request) => Boolean(request.worker));
      const [asked] = ctx.paramsOf("engine.delegate");
      assert.deepEqual(asked?.worker, { id: "w1", title: "Tune the jump", turn, research: false });
      const workerRequests = chat.seen.filter((request) => request.worker);
      const seat = workerRequests[0]?.worker;
      assert.ok(seat, "the host honoured the grant");
      assert.equal(seat.mode, PermissionMode.AcceptEdits, "in the chat's mode");
      assert.deepEqual([seat.id, seat.title], ["w1", "Tune the jump"]);
      assert.deepEqual(workerToolsOf(workerRequests[0]), [], "a worker is never offered the worker tools");
      // Its words are a worker's in the chat, never the chat's own reply.
      const roles = (await chat.core.store.listEvents(chat.threadId)).flatMap((event) => {
        const custom = customRecord(event.data);
        return custom?.event_type === CustomEvent.SessionActivity ? [String(custom.payload.role)] : [];
      });
      assert.ok(roles.includes(SessionActivityRole.Builder), `the worker reports as a worker: ${roles.join(", ")}`);
    } finally {
      await closeChatWorkers(chat.threadId, turn);
    }
  });

  it("a chat turn whose message carries a Loop's roles hands them to its workers: they start on the Workers role's engine and model", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const chat = await workerChat();
    const turn = await chat.personSays();
    const ok = { ok: true, engine: "claude-code", turns: 1, usage: {}, summary: "Done." };
    const workers: Array<Record<string, unknown>> = [];
    const answers: string[] = [];
    const call = (name: string, args: Record<string, unknown>) =>
      chatWorkerTool({ threadId: chat.threadId, turn, name, args });
    const host = await seedTurn(chat, {
      steer: turn,
      commission: { hours: 2, roles: { builder: CODEX_MODEL, engines: { builder: CODEX } } },
      delegate: async (params) => {
        if (params.worker) {
          workers.push(params);
          return ok;
        }
        answers.push(await call(WorkerTool.Start, { title: "Look around", task: "x", isolation: "read" }));
        answers.push(await call(WorkerTool.Wait, { id: "w1" }));
        return ok;
      },
    });
    assert.equal(host.error, null);
    assert.match(answers[0] ?? "", /^Started w1 \(read\)/, answers.join("\n"));
    const [asked] = workers;
    assert.equal(asked?.engine, CODEX, "the Workers role's engine");
    assert.equal(asked?.model, CODEX_MODEL, "and its model");
  });

  it("a turn whose message carries roles starts its workers on the Workers role's engine and model", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const chat = await workerChat();
    const { ctx } = harnessInProcess(chat);
    const turn = await chat.personSays();
    await openPoolFor(chat, ctx, turn, { roles: { builder: CODEX_MODEL, engines: { builder: CODEX } } });
    try {
      const count = chat.seen.length;
      await chatWorkerTool({
        threadId: chat.threadId,
        turn,
        name: WorkerTool.Start,
        args: { title: "Look around", task: "x", isolation: "read" },
      });
      await chat.untilSeen(count + 1);
      const [asked] = ctx.paramsOf("engine.delegate");
      assert.equal(asked?.engine, CODEX, "the Workers role's engine");
      assert.equal(asked?.model, CODEX_MODEL, "and its model");
    } finally {
      await closeChatWorkers(chat.threadId, turn);
    }
  });
});
