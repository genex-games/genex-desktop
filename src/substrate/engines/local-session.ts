/** Studio-owned agent sessions. A local completion model can execute the same host-granted
 * director/worker tools as a subscription, without borrowing a subscription's CLI or account. */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ChatActivityPhase } from "../../shared/chat-activity.ts";
import { ContextSource } from "../../shared/context.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { EngineFailureKind, isContextFailure, StopReason } from "../../shared/engine-requests.ts";
import { errorMessage } from "../../shared/errors.ts";
import { ReasoningEffort } from "../../shared/model-preferences.ts";
import { PermissionMode } from "../../shared/permissions.ts";
import { EngineId } from "../../shared/providers.ts";
import { credentialHomes } from "../credential-homes.ts";
import { atomicWriteText } from "../fsx.ts";
import { HOST_GIT_CONFIG } from "../snapshots.ts";
import { ProcessSandbox } from "../spawn.ts";
import type { Message, ToolCall, Usage } from "../types.ts";
import { DEFAULT_COMPACTION_PERCENT, interruption } from "./common.ts";
import { checkpointCut, type LocalCheckpoint, summarizeLocalCheckpoint } from "./local-checkpoint.ts";
import {
  LOCAL_NOTE,
  localBudgetNote,
  localSystemPrompt,
  modeChangedNote,
  noProgressNote,
  progressCheckNote,
} from "./local-session-prompts.ts";
import { changesSomething, localMode, permitCall, sessionMode } from "./local-session-permissions.ts";
import {
  executeLocalTool,
  INSPECTION_TOOLS,
  localToolDefinitions,
  sessionFileResolver,
  type ToolContext,
} from "./local-session-tools.ts";
import { lockUnowned, releaseLocks } from "./ownership-locks.ts";
import { StudioTool } from "./studio-tool-prompts.ts";
import {
  type CompleteRequest,
  type CompleteResponse,
  DelegateEventType,
  type DelegateRequest,
  type DelegateResult,
  EngineError,
  type LiveToolResult,
  type ToolDefinition,
} from "./types.ts";

/** How long and how hard a local session works. */
const LOCAL_SESSION_LIMITS = {
  /** Model turns when the request sets no cap. */
  maxTurns: 200,
  /** Tries at one completion, compacting the history between them. */
  compactionAttempts: 5,
  /** Whole rounds of recent work the first compaction keeps; each retry keeps one fewer. */
  keptRounds: 2,
  replyTokens: 3072,
  /** Replies cut off by the output limit before the session gives up on them. */
  outputRepairs: 2,
  /** Completed-action ids a checkpoint message lists (the count covers the rest). */
  listedActions: 50,
  /** A tool's answer as the model reads it, and as the chat previews it. */
  toolReplyChars: 40_000,
  toolPreviewChars: 2_000,
  /** Tool rounds without a workspace change before the session stops, and the rounds that get a nudge. */
  idleRoundLimit: 16,
  idleNudgeRounds: [6, 10] as readonly number[],
  gitProbeTimeoutMs: 5 * SECOND_MS,
} as const;

/** How much of a workspace a progress stamp looks at. */
const STAMP = {
  maxFiles: 3000,
  depth: 6,
  skipped: [".git", "node_modules", ".studio"] as readonly string[],
} as const;

/** The start of the user message that carries tool screenshots (`LOCAL_NOTE.roundImages`). */
const OBSERVATION_PREFIX = "Images returned by";
/** A session id is a UUID, and nothing else ever names a session file. */
const SESSION_ID = /^[a-f0-9-]{36}$/;

/** Why a local session refuses to run or resume. */
const MESSAGE = {
  InvalidId: "Invalid local session id",
  AlreadyRunning: "This local session is already running",
  DifferentWorkspace: "Cannot resume local session: different workspace",
  SessionNotFound: "Cannot resume local session: session not found",
  DifferentWorkspaceOrModel: "Cannot resume local session: different workspace or model",
  NoResponse: "Local inference produced no response",
} as const;

interface SavedSession {
  version: 1;
  cwd: string;
  model: string;
  messages: Message[];
  task?: string;
  requirements?: string[];
  checkpoint?: LocalCheckpoint;
  checkpointMessage?: string;
  parentSession?: string;
}
export interface LocalSessionOptions {
  /** The engine whose sessions these are (Bonsai, OpenRouter): its id names every event and result. */
  engine?: string;
  root: string;
  scratchRoot?: string;
  protectedPaths: string[];
  complete: (r: CompleteRequest) => Promise<CompleteResponse>;
  /** The working context, the same for every model (a local runtime) or per model (an API's catalog). */
  contextWindow: number | ((model: string) => number);
  toolPath?: () => Promise<string>;
}

/** One running session: what it was asked, where it works, and what it has done so far. */
interface LocalRun {
  /** The engine whose session this is. */
  engine: string;
  request: DelegateRequest;
  model: string;
  cwd: string;
  id: string;
  signal: AbortSignal;
  started: number;
  saved: SavedSession;
  messages: Message[];
  requirements: string[];
  save: () => Promise<void>;
  readonly: boolean;
  definitions: ToolDefinition[];
  tools: ToolContext;
  system: string;
  usage: Usage;
  turns: number;
  summary: string;
  actualModel: string;
  progressNote: string;
  idleRounds: number;
  /** Cut-off replies in a row; a whole reply resets it. */
  outputRepairs: number;
  workspaceStamp: string;
  /** The chat's permission mode it runs in (`local-session-permissions.ts`); null for unattended work. */
  mode: PermissionMode | null;
  /** What the model reads at its next round about a mode the user switched to while it ran. */
  modeNote: string;
}

/** What a session's file tools may reach. */
interface FileBounds {
  /** The workspace and any extra read folders, resolved. */
  readRoots: string[];
  /** Paths its tools may never read or write. */
  forbidden: string[];
  /** Paths its tools may not write. */
  deniedWrites: string[];
}

export class LocalSessions {
  readonly options: LocalSessionOptions;
  /** The engine whose sessions these are; Bonsai when the options name none. */
  readonly engine: string;
  #active = new Set<string>();
  constructor(options: LocalSessionOptions) {
    this.options = options;
    this.engine = options.engine ?? EngineId.Bonsai;
  }

  /** The working context for one model. */
  contextWindowFor(model: string): number {
    const window = this.options.contextWindow;
    return typeof window === "number" ? window : window(model);
  }

  async run(request: DelegateRequest, model: string): Promise<DelegateResult> {
    const originalId = request.resume ?? randomUUID();
    if (!SESSION_ID.test(originalId)) throw new Error(MESSAGE.InvalidId);
    if (this.#active.has(originalId)) throw new Error(MESSAGE.AlreadyRunning);
    let id = originalId;
    this.#active.add(originalId);
    try {
      request.signal?.throwIfAborted();
      const cwd = await realpath(request.cwd);
      if (request.resume) {
        const prior = JSON.parse(
          await readFile(path.join(this.options.root, `${originalId}.json`), "utf8"),
        ) as SavedSession;
        if (prior.cwd !== cwd) throw new Error(MESSAGE.DifferentWorkspace);
        if (prior.model !== model) {
          id = randomUUID();
          this.#active.add(id);
          await this.#fork(prior, request, model, originalId, id);
        }
      }
      const resumed = id === originalId ? request : { ...request, resume: id };
      return await this.#run(resumed, model, cwd, id);
    } finally {
      this.#active.delete(originalId);
      this.#active.delete(id);
    }
  }

  /** A resumed session on a different model continues as a new session that keeps the history. */
  async #fork(
    prior: SavedSession,
    request: DelegateRequest,
    model: string,
    parentSession: string,
    id: string,
  ): Promise<void> {
    await writeFile(path.join(this.options.root, `${id}.json`), JSON.stringify({ ...prior, model, parentSession }), {
      mode: 0o600,
    });
    request.onEvent?.({
      type: DelegateEventType.System,
      payload: {
        subtype: "session_fork",
        parent_session_id: parentSession,
        session_id: id,
        model,
        reason: LOCAL_NOTE.forkReason,
      },
    });
  }

  async #run(request: DelegateRequest, model: string, cwd: string, id: string): Promise<DelegateResult> {
    const run = await this.#open(request, model, cwd, id);
    const locks = request.ownership && !run.readonly ? await lockUnowned(cwd, request.ownership) : null;
    run.workspaceStamp = await stampWorkspace(cwd);
    const instructions = await run.tools
      .resolveFile("CLAUDE.md")
      .then((p) => readFile(p, "utf8"))
      .catch(() => "");
    run.system = localSystemPrompt({
      readonly: run.readonly,
      ownership: request.ownership,
      instructions,
      mode: run.mode,
    });
    request.onEvent?.({ type: DelegateEventType.System, payload: { subtype: "init", session_id: id, model } });
    // The composer's picker reaches the running session: the next call is decided in the new mode,
    // and the model reads of it at its next round.
    request.permissions?.onControl?.({
      setMode: async (mode) => {
        run.mode = sessionMode(run.engine, mode);
        run.modeNote = modeChangedNote(run.mode);
      },
    });
    try {
      await run.save();
      while (run.turns < (request.maxTurns ?? LOCAL_SESSION_LIMITS.maxTurns)) {
        const ending = await this.#round(run);
        if (ending) return ending;
      }
      return localResult(run, false, StopReason.MaxTurns, LOCAL_NOTE.maxTurns);
    } catch (err) {
      await run.save();
      const abortedByEngine = err instanceof EngineError && err.kind === EngineFailureKind.Aborted;
      if (run.signal.aborted || abortedByEngine)
        return localResult(run, false, interruption(request.signal?.aborted).stopReason);
      throw err;
    } finally {
      request.permissions?.onControl?.(null);
      if (locks) await releaseLocks(cwd, locks);
      await run.tools.sandbox?.dispose();
    }
  }

  /**
   * Load (or start) the session and everything it runs with: its history and requirements, the
   * files it may read and write, its tools, and the sandbox its commands run in.
   */
  async #open(request: DelegateRequest, model: string, cwd: string, id: string): Promise<LocalRun> {
    const started = Date.now();
    const signal = runSignal(request);
    await mkdir(this.options.root, { recursive: true });
    const sessionFile = path.join(this.options.root, `${id}.json`);
    const saved = await this.#loadSaved(request, sessionFile, { cwd, model });
    const messages = saved.messages;
    const budget = localBudgetNote({
      maxTurns: request.maxTurns ?? LOCAL_SESSION_LIMITS.maxTurns,
      timeoutMs: request.timeoutMs,
    });
    const requirements = continueHistory(saved, messages, request, budget);
    const save = () => atomicWriteText(sessionFile, JSON.stringify(saved), { mode: 0o600 });
    const { readRoots, forbidden, deniedWrites } = await this.#fileBounds(request, cwd);
    const readonly = isReadOnlySession(request);
    const resolveFile = sessionFileResolver({
      cwd,
      readRoots,
      forbidden,
      deniedWrites,
      readonly,
      ownership: request.ownership,
    });
    const definitions = localToolDefinitions(request, readonly);
    const studioToolCalls: NonNullable<DelegateResult["studioToolCalls"]> = [];
    const sandbox = readonly ? null : await this.#sandbox(cwd, id, forbidden, deniedWrites);
    return {
      engine: this.engine,
      request,
      model,
      cwd,
      id,
      signal,
      started,
      saved,
      messages,
      requirements,
      save,
      readonly,
      definitions,
      tools: {
        request,
        cwd,
        signal,
        resolveFile,
        sandbox,
        forbidden,
        deniedWrites,
        label: `${this.engine}:${id}`,
        seenReads: new Map(),
        studioToolCalls,
      },
      system: "",
      usage: { input_tokens: 0, output_tokens: 0 },
      turns: 0,
      summary: "",
      actualModel: model,
      progressNote: "",
      idleRounds: 0,
      outputRepairs: 0,
      workspaceStamp: "",
      mode: localMode(this.engine, request.permissions),
      modeNote: "",
    };
  }

  /** The folders the session may read, the paths it may never touch, and the ones it may not write. */
  async #fileBounds(request: DelegateRequest, cwd: string): Promise<FileBounds> {
    const readRoots = [
      cwd,
      ...(await Promise.all((request.extraReads ?? []).map((p) => realpath(p).catch(() => path.resolve(p))))),
    ];
    // The coding CLIs' sign-in homes, from the one shared list the sandbox and contractors use (SEC-3).
    const forbidden = [...this.options.protectedPaths, ...credentialHomes(), ...(request.denyReads ?? [])].map((p) =>
      path.resolve(p),
    );
    const deniedWrites = [
      ...this.options.protectedPaths,
      ...credentialHomes(),
      ...(request.optimization?.denyWrites ?? []),
    ];
    return { readRoots, forbidden, deniedWrites };
  }

  /** The saved session to continue, or a fresh one; a resumed session must match its workspace and model. */
  async #loadSaved(
    request: DelegateRequest,
    sessionFile: string,
    expected: { cwd: string; model: string },
  ): Promise<SavedSession> {
    const saved: SavedSession = request.resume
      ? JSON.parse(
          await readFile(sessionFile, "utf8").catch(() => {
            throw new Error(MESSAGE.SessionNotFound);
          }),
        )
      : { version: 1, cwd: expected.cwd, model: expected.model, messages: [] };
    const matches = saved.version === 1 && saved.cwd === expected.cwd && saved.model === expected.model;
    if (!matches) throw new Error(MESSAGE.DifferentWorkspaceOrModel);
    return saved;
  }

  /** The command sandbox: the workspace and a linked worktree's Git metadata are its only writable places. */
  async #sandbox(cwd: string, id: string, forbidden: string[], deniedWrites: string[]): Promise<ProcessSandbox> {
    // A linked worktree's index and objects live outside cwd; authorize only its Git metadata.
    const gitMetadata: string[] = [];
    for (const flag of ["--absolute-git-dir", "--git-common-dir"]) {
      const answer = await promisify(execFile)("/usr/bin/git", [...HOST_GIT_CONFIG, "-C", cwd, "rev-parse", flag], {
        timeout: LOCAL_SESSION_LIMITS.gitProbeTimeoutMs,
      }).catch(() => null);
      if (answer) gitMetadata.push(await realpath(path.resolve(cwd, answer.stdout.trim())));
    }
    const scratchRoot = this.options.scratchRoot ?? path.join(os.tmpdir(), `studio-${this.engine}`);
    return ProcessSandbox.create({
      writableRoots: [cwd, ...gitMetadata],
      scratchDir: path.join(scratchRoot, id),
      secretPaths: forbidden,
      denyWrite: deniedWrites,
      ...(this.options.toolPath ? { toolPath: this.options.toolPath } : {}),
    });
  }

  /** One model turn and the tool calls it asked for; the session's ending when this round ends it. */
  async #round(run: LocalRun): Promise<DelegateResult | null> {
    run.signal.throwIfAborted();
    if (run.modeNote) {
      run.messages.push({ role: "user", content: run.modeNote });
      run.modeNote = "";
    }
    const answer = await this.#completeWithCompaction(run);
    if ("ending" in answer) return answer.ending;
    const { response } = answer;
    if (!response) throw new Error(MESSAGE.NoResponse);
    run.turns++;
    run.actualModel = response.model;
    run.summary = response.message.content;
    addUsage(run.usage, response.usage);
    if (response.stopReason === StopReason.Length) return this.#repairTruncatedReply(run);
    // The allowance is for cuts in a row: a whole reply between them starts it again.
    run.outputRepairs = 0;
    const { reasoning: _reasoning, ...assistantMessage } = response.message;
    run.messages.push(assistantMessage);
    await run.save();
    reportAssistant(run, response);
    const calls = response.message.tool_calls ?? [];
    if (!calls.length) return localResult(run, response.stopReason !== StopReason.Length, response.stopReason);
    const roundImages = await this.#runTools(run, calls);
    // Plan only looks: a round that changed nothing is what it is for, not a stall.
    if (!run.readonly && run.mode !== PermissionMode.Plan) {
      const stalled = await checkProgress(run, calls);
      if (stalled) return stalled;
    }
    // Complete every tool reply before adding the user image message.
    if (roundImages.length) {
      addRoundImages(run.messages, roundImages);
      await run.save();
    }
    return null;
  }

  /**
   * A reply cut off by its output limit. Original completed calls remain saved. Do not add a
   * partial tool_use or pretend that a truncated narrative is a successful final answer.
   */
  async #repairTruncatedReply(run: LocalRun): Promise<DelegateResult | null> {
    run.messages.push({ role: "user", content: LOCAL_NOTE.outputLimit });
    await run.save();
    run.request.onEvent?.({ type: DelegateEventType.Status, payload: { message: LOCAL_NOTE.outputLimit } });
    run.outputRepairs++;
    if (run.outputRepairs > LOCAL_SESSION_LIMITS.outputRepairs)
      return localResult(run, false, StopReason.Length, LOCAL_NOTE.outputRepeatedlyTooLong);
    return null;
  }

  /** One completion; when the context is full, compact the history and try again, a few times. */
  async #completeWithCompaction(
    run: LocalRun,
  ): Promise<{ response: CompleteResponse | undefined } | { ending: DelegateResult }> {
    for (let attempt = 0; attempt < LOCAL_SESSION_LIMITS.compactionAttempts; attempt++) {
      try {
        return { response: await this.options.complete(completionRequest(run)) };
      } catch (err) {
        if (!(err instanceof EngineError) || !isContextFailure(err.kind)) throw err;
        // Reduce whole rounds progressively. Repeatedly keeping one round
        // cannot make progress when that round contains the oversized result.
        const keep = Math.max(0, LOCAL_SESSION_LIMITS.keptRounds - attempt);
        const cut = checkpointCut(run.messages, keep) || checkpointCut(run.messages, 0);
        const lastAttempt = attempt === LOCAL_SESSION_LIMITS.compactionAttempts - 1;
        if (lastAttempt || !run.messages.some((m) => m.role === "assistant"))
          return {
            ending: localResult(run, false, StopReason.ContextOverflow, LOCAL_NOTE.contextOverflow + err.message),
          };
        await this.#compact(run, cut);
      }
    }
    return { response: undefined };
  }

  /**
   * Replace everything before `cut` with a checkpoint: the requirements in order, a summary of
   * the work, and the ids of completed actions, so nothing done is done twice. The earlier
   * messages are archived beside the session, never discarded.
   */
  async #compact(run: LocalRun, cut: number): Promise<void> {
    const { request, messages, saved } = run;
    request.onEvent?.({
      type: DelegateEventType.Activity,
      payload: { phase: ChatActivityPhase.Compacting, sessionId: run.id, engine: run.engine },
    });
    const earlier = messages.slice(0, cut);
    const next = await summarizeLocalCheckpoint({
      messages: earlier.filter((m) => m.content !== saved.checkpointMessage),
      previous: saved.checkpoint,
      model: run.model,
      signal: run.signal,
      complete: async (r) => {
        const answer = await this.options.complete(r);
        addUsage(run.usage, answer.usage);
        return answer;
      },
      contextWindow: this.contextWindowFor(run.model),
    });
    run.signal.throwIfAborted();
    const archive = path.join(this.options.root, "checkpoints", run.id);
    await mkdir(archive, { recursive: true });
    await writeFile(path.join(archive, `${next.id}.json`), JSON.stringify({ checkpoint: next, messages: earlier }), {
      mode: 0o600,
    });
    const recent = messages.slice(cut);
    const latestObservation = messages.findLast((m) => isObservation(m) && m.images?.length);
    const checkpointMessage = checkpointMessageFor(run, next);
    messages.splice(0, messages.length, checkpointMessage, ...recent);
    if (latestObservation && !recent.includes(latestObservation)) messages.push(latestObservation);
    saved.checkpointMessage = checkpointMessage.content;
    saved.checkpoint = next;
    await run.save();
    request.onEvent?.({
      type: DelegateEventType.Context,
      payload: {
        engine: run.engine,
        model: run.model,
        sessionId: run.id,
        source: ContextSource.NativeTokenizer,
        compacted: true,
        checkpointId: next.id,
        parentCheckpoint: next.parent,
        thresholdPercent: request.contextPolicy?.thresholdPercent ?? DEFAULT_COMPACTION_PERCENT,
      },
    });
  }

  /** Run a round's tool calls in order, answering each; the pictures they returned, for one image message. */
  async #runTools(run: LocalRun, calls: ToolCall[]): Promise<NonNullable<Message["images"]>> {
    const roundImages: NonNullable<Message["images"]> = [];
    for (const call of calls) {
      run.signal.throwIfAborted();
      run.request.onEvent?.({
        type: DelegateEventType.Activity,
        payload: { phase: ChatActivityPhase.Tool, sessionId: run.id, engine: run.engine, tool: call.name },
      });
      const { answer, failed } = await callTool(run, call);
      const text = typeof answer === "string" ? answer : answer.text;
      run.messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: text.slice(0, LOCAL_SESSION_LIMITS.toolReplyChars),
      });
      if (typeof answer !== "string" && answer.images?.length) roundImages.push(...answer.images);
      await run.save();
      run.request.onEvent?.({
        type: DelegateEventType.User,
        payload: {
          role: "user",
          parts: [
            {
              type: "tool_result",
              tool_use_id: call.id,
              is_error: failed,
              content: text.slice(0, LOCAL_SESSION_LIMITS.toolPreviewChars),
            },
          ],
        },
      });
    }
    return roundImages;
  }
}

/** The signal a run stops on: the user's stop or, when it has one, its time budget. */
function runSignal(request: DelegateRequest): AbortSignal {
  const signals: AbortSignal[] = [];
  if (request.signal) signals.push(request.signal);
  if (request.timeoutMs) signals.push(AbortSignal.timeout(request.timeoutMs));
  return AbortSignal.any(signals);
}

/**
 * A session that may not edit: a read-only pass (playtest, scout) or a coordinator. A chat that
 * may launch a build is still a full contractor and keeps its write tools.
 */
function isReadOnlySession(request: DelegateRequest): boolean {
  return Boolean(request.readOnly || request.coordinator);
}

/** The launch tools a Loop chat was bridged, by name (its question tool is not one). */
function launchToolNames(request: DelegateRequest): string[] {
  return (request.interviewTools ?? []).map((t) => t.name).filter((name) => name !== StudioTool.AskUser);
}

/**
 * The history a turn continues: the requirements in order (a repeated brief is not appended
 * twice), an answer for every call whose result was never saved, and the new prompt with this
 * request's budget (`localBudgetNote`).
 */
function continueHistory(saved: SavedSession, messages: Message[], request: DelegateRequest, budget: string): string[] {
  // Exact ordered instructions are separate from action history. Identical repeated
  // briefs need not be concatenated at every continuation. Oversized fixed requirements
  // fail explicitly below instead of silently deleting the user's original request.
  const requirements = saved.requirements ?? [...(saved.task ? [saved.task] : [])];
  if (requirements.at(-1) !== request.prompt) requirements.push(request.prompt);
  saved.requirements = requirements;
  delete saved.task;
  // Interrupted tool calls are never replayed: their side effects may already exist.
  const answered = new Set(messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
  for (const message of [...messages])
    for (const call of message.tool_calls ?? [])
      if (!answered.has(call.id))
        messages.push({ role: "tool", tool_call_id: call.id, content: LOCAL_NOTE.interrupted });
  messages.push({
    role: "user",
    content: `${request.prompt}\n\n${budget}`,
    ...(request.images?.length ? { images: request.images } : {}),
  });
  return requirements;
}

/** The completion one turn asks for: the whole history, the session's tools, a bounded reply. */
function completionRequest(run: LocalRun): CompleteRequest {
  const { request, id } = run;
  const streamId = randomUUID();
  return {
    model: run.model,
    signal: run.signal,
    systemPrompt: run.system,
    messages: run.messages,
    // Plan offers no tool that changes anything; a call to one is refused all the same (`permitCall`).
    tools:
      run.mode === PermissionMode.Plan ? run.definitions.filter((t) => !changesSomething(t.name)) : run.definitions,
    effort: request.effort ?? ReasoningEffort.Low,
    maxTokens: LOCAL_SESSION_LIMITS.replyTokens,
    contextPolicy: request.contextPolicy ?? { mode: "default" },
    onContext: (m) => request.onEvent?.({ type: DelegateEventType.Context, payload: { ...m, sessionId: id } }),
    onActivity: (phase) =>
      request.onEvent?.({
        type: DelegateEventType.Activity,
        payload: { phase, sessionId: id, engine: run.engine },
      }),
    onDelta: (delta) => request.onEvent?.({ type: DelegateEventType.TextDelta, payload: { streamId, delta } }),
  };
}

/** The message that stands for everything a compaction cut. */
function checkpointMessageFor(run: LocalRun, next: LocalCheckpoint): Message {
  return {
    role: "user",
    content: JSON.stringify({
      instructionsInOrder: run.requirements,
      checkpoint: next.summary,
      completedActionIds: next.completedActions.slice(-LOCAL_SESSION_LIMITS.listedActions).map((a) => a.id),
      completedActionCount: next.completedActions.length,
      checkpointArchive: next.id,
      actionPolicy: LOCAL_NOTE.actionPolicy,
      progressNote: run.progressNote,
    }),
    ...(run.request.images?.length ? { images: run.request.images } : {}),
  };
}

/** The assistant's reply as the log mirrors it: its words, then the tools it called. */
function reportAssistant(run: LocalRun, response: CompleteResponse): void {
  run.request.onEvent?.({
    type: DelegateEventType.Assistant,
    payload: {
      role: "assistant",
      parts: [
        ...(run.summary ? [{ type: "text", text: run.summary }] : []),
        ...(response.message.tool_calls ?? []).map((c) => ({
          type: "tool_use",
          id: c.id,
          name: c.name,
          input: c.arguments,
        })),
      ],
    },
  });
}

/**
 * One tool call's answer; a thrown tool answers with its error, marked failed. A call the chat's
 * mode does not allow, or the user denied, answers with why it did not run.
 */
async function callTool(run: LocalRun, call: ToolCall): Promise<{ answer: LiveToolResult; failed: boolean }> {
  try {
    const { mode, cwd, signal, request } = run;
    const refused = await permitCall({
      engine: run.engine,
      mode,
      call,
      cwd,
      permissions: request.permissions,
      signal,
    });
    if (refused !== null) return { answer: refused, failed: true };
    return { answer: await executeLocalTool(call, run.definitions, run.tools), failed: false };
  } catch (err) {
    return { answer: `Tool failed: ${errorMessage(err)}`, failed: true };
  }
}

/**
 * Stop a builder that keeps inspecting without changing anything, after nudging it twice. Real
 * edits count, including shell and host-tool edits — not the model's claims of progress.
 */
async function checkProgress(run: LocalRun, calls: ToolCall[]): Promise<DelegateResult | null> {
  const nextStamp = await stampWorkspace(run.cwd);
  const inspecting = calls.every((c) => INSPECTION_TOOLS.has(c.name));
  run.idleRounds = inspecting && nextStamp === run.workspaceStamp ? run.idleRounds + 1 : 0;
  run.workspaceStamp = nextStamp;
  if (run.idleRounds >= LOCAL_SESSION_LIMITS.idleRoundLimit)
    return localResult(run, false, StopReason.NoProgress, noProgressNote(LOCAL_SESSION_LIMITS.idleRoundLimit));
  if (LOCAL_SESSION_LIMITS.idleNudgeRounds.includes(run.idleRounds)) {
    run.progressNote = progressCheckNote(run.idleRounds, launchToolNames(run.request));
    run.messages.push({ role: "user", content: run.progressNote });
    run.request.onEvent?.({ type: DelegateEventType.Status, payload: { message: run.progressNote } });
  }
  return null;
}

/**
 * A live screen supersedes earlier tool screenshots. Keep the user's original reference images;
 * do not let repeated looks fill the working context.
 */
function addRoundImages(messages: Message[], roundImages: NonNullable<Message["images"]>): void {
  for (const m of messages.slice(1))
    if (isObservation(m) && m.images) {
      delete m.images;
      m.content += LOCAL_NOTE.superseded;
    }
  messages.push({ role: "user", content: LOCAL_NOTE.roundImages, images: roundImages });
}

/** A user message the studio added to carry tool screenshots. */
function isObservation(message: Message): boolean {
  return message.role === "user" && message.content.startsWith(OBSERVATION_PREFIX);
}

/** The session's outcome, as a delegation result. */
function localResult(run: LocalRun, ok: boolean, stopReason: string, errorText?: string): DelegateResult {
  return {
    ok,
    stopReason,
    summary: run.summary,
    usage: run.usage,
    turns: run.turns,
    engine: run.engine,
    model: run.actualModel,
    requestedModel: run.model,
    sessionId: run.id,
    durationMs: Date.now() - run.started,
    ...(errorText ? { errorText } : {}),
    ...(run.tools.studioToolCalls.length ? { studioToolCalls: run.tools.studioToolCalls } : {}),
  };
}

/** Add a completion's tokens to the session's running total. */
function addUsage(into: Usage, from: Usage): void {
  into.input_tokens = (into.input_tokens ?? 0) + (from.input_tokens ?? 0);
  into.output_tokens = (into.output_tokens ?? 0) + (from.output_tokens ?? 0);
}

/** Observe real edits (including shell/host-tool edits), not the model's claims of progress. */
async function stampWorkspace(root: string): Promise<string> {
  const parts: string[] = [];
  await stampDirectory(root, root, STAMP.depth, parts);
  return parts.join("\n");
}

/** Add each file under `dir` (to `depth` levels) to the stamp as its path, size and mtime. */
async function stampDirectory(root: string, dir: string, depth: number, parts: string[]): Promise<void> {
  const items = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const item of items) {
    if (STAMP.skipped.includes(item.name) || parts.length >= STAMP.maxFiles) continue;
    const file = path.join(dir, item.name);
    if (item.isDirectory() && depth > 0) await stampDirectory(root, file, depth - 1, parts);
    else if (item.isFile()) {
      const s = await stat(file).catch(() => null);
      if (s) parts.push(`${path.relative(root, file)}:${s.size}:${s.mtimeMs}`);
    }
  }
}
