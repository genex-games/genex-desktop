/**
 * The user's side of a thread: a message sent (answered directly, delegated, or queued to a running
 * build's coordinator), the coordinator's tools, wrapping up a run, and Stop. Composed by
 * `StudioCore`; its state stays in the core.
 */
import { PlanReviewState, type ComposerSendOptions, type PlanReview } from "../../shared/composer.ts";
import path from "node:path";
import {
  CoordinatorTool,
  finishRequested,
  isCoordinatorTool,
  isRunControl,
  latestRun,
  RunControlAction,
  runSnapshot,
  type CoordinatorRun,
} from "../../shared/coordinator.ts";
import { CustomEvent, customEventData, customRecord, type AnyCustomPayload } from "../../shared/custom-events.ts";
import { EventKind, ThreadKind, type ConversationRecord, type EventEnvelope } from "../../shared/event-log.ts";
import { crossesCompletionEngine } from "../../shared/model-roles.ts";
import { ToolPermissionBy } from "../../shared/permissions.ts";
import { RunState } from "../../shared/run-state.ts";
import { SteerDelivery } from "../../shared/message-queue.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import { shortId } from "../../substrate/ids.ts";
import { resolveNamedPaths } from "../../substrate/user-paths.ts";
import { toPosixRelative } from "../../substrate/paths.ts";
import {
  DispatchActionType,
  HarnessCapability,
  HarnessState,
  type DispatchAction,
  type ReferenceFrame,
} from "../../shared/protocol.ts";
import type { CoreInternals, StudioCore } from "../studio-core.ts";
import { errorMessage } from "../../shared/errors.ts";
import { NEW_CHAT_TITLE, NEW_GAME_TITLE } from "./game-threads.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { settleWithin } from "../app-lifecycle.ts";
import { threadOr } from "./main-thread.ts";
import { CapabilityAudience } from "../planning-capabilities.ts";
import { isQueueMessageId } from "./rewind.ts";

/** Which build `show_build` and `land_build` mean when the coordinator names none: the run's own. */
const INTEGRATION_BUILD = "integration";
/** A show while Live holds another game: nothing was shown, and nothing waits for its Reload. */
const OTHER_GAME_IN_LIVE =
  "Another game is open in Live, so it was left as it is and nothing was shown. Tell the user to open this game first, then ask again.";

/** The build `show_build` means by the game folder as it is. */
const LIVE_BUILD = "live";
/** A commit hash, full or abbreviated, as a build name. */
const COMMIT_HASH = /^[0-9a-f]{7,40}$/i;
/** Characters of a commit hash quoted back to the model. */
const SHORT_COMMIT = 10;
/** Stop must reach providers even when the editable harness cannot acknowledge the queue hold. */
const STOP_DISPATCH_TIMEOUT_MS = 5 * SECOND_MS;
/**
 * How long Stop waits for a plan being written to be cancelled and a message still sending to
 * reach the chat's queue. A harness that takes neither must not keep Stop from aborting its work.
 */
const STOP_SEND_WAIT_MS = 5 * SECOND_MS;

/** A plan review in one of these states still owns the thread's next message. */
const OPEN_PLAN_REVIEW: readonly string[] = [
  PlanReviewState.Waiting,
  PlanReviewState.Generating,
  PlanReviewState.Failed,
];

/**
 * The coordinator's tools that start, go on with or land a build: while the chat is in Plan none
 * runs, whether the run's coordinator or the chat's own run controls call it. Reading, showing and
 * wrapping up still work.
 */
const BUILD_CHANGES: ReadonlySet<CoordinatorTool> = new Set<CoordinatorTool>([
  CoordinatorTool.ContinueBuild,
  CoordinatorTool.ResumeRun,
  CoordinatorTool.LandBuild,
]);
/** Titles a thread has before its first message names it. */
const PLACEHOLDER_TITLES: readonly string[] = [NEW_GAME_TITLE, NEW_CHAT_TITLE];
/** Characters of a first message kept as the thread's title. */
const THREAD_TITLE_CHARS = 56;

/** User-facing copy of this module, and what the coordinator reads when a tool call is refused. */
const MESSAGE = {
  autopilotOutdated:
    "This build of the studio can't run a timed build yet — your brief is saved above, and sending it again once the " +
    "studio has updated itself will start the build. (Its own loop code predates timed builds: the seed's " +
    "harness-seed/loop needs to be merged into it, or the seed copies restored so the next launch upgrades them.)",
  localRolesOutdated:
    "This build's workers or reviewers run on a local model, which the studio's own loop code doesn't support yet — " +
    "your brief is saved above. Pick every job on one kind of engine and send it again, or ask the studio to merge " +
    "the seed's harness-seed/loop into its own loop code (or restore the seed copies) so the next launch upgrades them.",
  loopOutdated:
    "Loop can't start: the studio's own loop code predates the composer's Loop feature, so it doesn't know how to " +
    "run a timed build. To fix it, ask the studio in chat to merge the seed's Loop handling " +
    "(harness-seed/loop) into its own loop code and restart itself — or restore the seed copies so the next " +
    "launch upgrades them. Your brief is saved above; send it again once the loop code is current.",
  unknownTool: (name: string) => `unknown coordinator tool: ${name}`,
  inPlan:
    "The chat is in Plan mode, so this did not run: starting, continuing, resuming or landing a build waits until the plan is approved. Put it in your plan instead.",
  runChanged: "The run changed. This message cannot control another run; read the current state.",
  onlyPausedResumes: "Only a paused run from this conversation can be resumed. No new run was started.",
  continueWhichRun: "Continue the active run with steer_run, or a paused run with resume_run.",
  continueNeedsText: "Continued work needs a message and an instruction.",
  noProjectFolder: "This run has no project folder to show.",
  noIntegrationToShow: "This run has no integration branch to show yet.",
  unknownBuild: (build: string) => `"${build}" is neither live, integration nor a commit hash.`,
  stillRunning: "The run is still running; finish_run lands its work when the workers are done.",
  noIntegrationToLand: "This run has no integration branch to land.",
  notCommitHash: (build: string) => `"${build}" is not a commit hash.`,
  notSteerable: (state: string) =>
    `The run is ${state}; no worker was restarted. Resume a paused run before steering it.`,
  emptyGuidance: "Worker guidance cannot be empty",
  unknownFacet: (facetId: string) => `Unknown facet: ${facetId}`,
  nothingToFinish: (known: boolean) =>
    `That build is ${known ? "no longer running" : "not in this conversation"}; nothing was asked to finish.`,
} as const;

type ThreadMeta = { kind?: string; project?: string | null } | undefined;

/** A thread's remembered contractor session and last provider choice. */
type ContractorMeta =
  | {
      contractor?: { engine?: string; sessionId?: string; model?: string; effort?: string };
      lastEngine?: string;
      lastModel?: string;
      lastEffort?: string;
    }
  | undefined;

/** Where a message lands: its thread, the game it is about, and whether the studio thread answers it. */
interface MessageTarget {
  threadId: string;
  project: string | undefined;
  newProject: boolean;
  studioThread: boolean;
}

/** What a coordinator tool call works on. */
interface CoordinatorCall {
  threadId: string;
  runId: string;
  args: Record<string, unknown>;
  messageId: string | undefined;
  events: EventEnvelope[];
  run: CoordinatorRun;
  /**
   * The chat's own session asking, when a run control is its (`runControl`): its own hold on the
   * game folder is not a contractor building there, nor one of the run's workers.
   */
  asker?: AbortController;
}

/** The payloads of every record of this custom event in the log. */
function payloadsOf(events: readonly EventEnvelope[], name: CustomEvent): AnyCustomPayload[] {
  return events.flatMap((event) => {
    const custom = customRecord(event.data);
    return custom && custom.event_type === name ? [custom.payload] : [];
  });
}

/**
 * The steers this chat's own turns recorded. One a run's lead took from a message (`how: "lead"`,
 * live chat) is not: the lead heard it, or it came back to the chat, which records its words anew.
 */
function chatSteers(events: readonly EventEnvelope[]): AnyCustomPayload[] {
  return payloadsOf(events, CustomEvent.RunSteering).filter((steer) => steer.how !== SteerDelivery.Lead);
}

/** Does a game thread's next message go to a plan review first? */
function needsPlanReview(options: ComposerSendOptions, waiting: PlanReview | undefined): boolean {
  const reviewOpen = Boolean(waiting && OPEN_PLAN_REVIEW.includes(waiting.state));
  return Boolean(options.reviewPlan || options.autopilot?.reviewPlan || reviewOpen);
}

/** Did this send change the provider, model or effort the thread remembers? */
function choiceChanged(metadata: ContractorMeta, options: ComposerSendOptions): boolean {
  if (metadata?.lastEngine !== options.engine) return true;
  if (options.model && metadata?.lastModel !== options.model) return true;
  return Boolean(options.effort && metadata?.lastEffort !== options.effort);
}

/** A thread still named for what it was before its first message: a fresh chat, or its game's folder. */
function hasPlaceholderTitle(record: ConversationRecord, meta: ThreadMeta): boolean {
  if (!record.title || PLACEHOLDER_TITLES.includes(record.title)) return true;
  return meta?.project != null && record.title === meta.project;
}

/** The commit a build name means: the run's integration head, or a commit named by hash. */
function commitFor(build: string, integrationHead: string | null): string | null {
  if (build === INTEGRATION_BUILD) return integrationHead;
  return COMMIT_HASH.test(build) ? build : null;
}

/**
 * The session a message to a provider resumes — the one asked for, or the thread's saved one
 * with that provider — and the options it is sent with.
 */
function resumedSession(
  metadata: ContractorMeta,
  options: ComposerSendOptions,
): { sendOptions: ComposerSendOptions; resume: string | undefined } {
  const contractor = metadata?.contractor;
  const sameEngine = !contractor?.engine || contractor.engine === options.engine;
  const saved = contractor?.sessionId && sameEngine ? contractor.sessionId : undefined;
  // The session the caller named wins; only when it named none (or "") does the saved one resume.
  const resume = !options.resume && saved ? saved : options.resume;
  // Keep going names a saved session, not a new choice of provider defaults.
  // Restore only recorded settings of this exact session/provider. An explicit
  // model (including an empty/default choice) still takes precedence.
  if (!contractor || !resume || resume !== saved) return { sendOptions: options, resume };
  const lastUsed = metadata?.lastEngine === options.engine;
  const model = contractor.model ?? (lastUsed ? metadata?.lastModel : undefined);
  const effort = contractor.effort ?? (lastUsed ? metadata?.lastEffort : undefined);
  const sendOptions = {
    ...options,
    ...(options.model === undefined && model !== undefined ? { model } : {}),
    ...(options.effort === undefined && effort !== undefined ? { effort } : {}),
  };
  return { sendOptions, resume };
}

/** A text argument, trimmed; anything else reads as empty. */
function textArg(value: unknown): string {
  return String(value ?? "").trim();
}

/** The model the composer chose for a message, each part only when it was chosen. */
function modelChoice(options: ComposerSendOptions) {
  return {
    ...(options.engine ? { engine: options.engine } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
    ...(options.preferences ? { preferences: options.preferences } : {}),
  };
}

export class ConversationService {
  readonly #core: StudioCore;
  readonly #x: CoreInternals;

  constructor(core: StudioCore, x: CoreInternals) {
    this.#core = core;
    this.#x = x;
  }

  /** A message from the composer. A chat being rewound takes none until the rewind has settled. */
  async sendUserMessage(text: string, options: ComposerSendOptions = {}): Promise<void> {
    await this.#x.rewind.whileSending(threadOr(this.#core, options.thread), () => this.#send(text, options));
  }

  async #send(text: string, options: ComposerSendOptions): Promise<void> {
    const sentAt = Date.now();
    this.#x.selfImprovement.touchActivity();
    if (await this.#requestPlanReview(text, options, sentAt)) return;
    const target = await this.#messageTarget(text, options);
    const { extraReads, stills } = target.studioThread
      ? { extraReads: [], stills: options.frames }
      : await this.#namedPaths(text, target, options.frames);
    const { sendOptions, resume } =
      !target.studioThread && options.engine
        ? await this.#resumeContractor(target.threadId, options)
        : { sendOptions: options, resume: options.resume };
    if (target.project && !target.studioThread) {
      await this.#core.games.ensureCover(target.project);
      this.#core.emit(UiEvent.GameChanged, { project: target.project });
    }
    const references = await this.#saveMoodBoard(target.project, sendOptions);
    const action = this.#userMessageAction(text, target, sendOptions, { resume, extraReads, stills, references });
    const refusal = this.#commissionRefusal(sendOptions);
    if (refusal) {
      // The renderer already cleared the composer — the brief must survive in the log, ahead of
      // the refusal that explains it.
      await this.#core.append(
        [
          { type: EventKind.Messages, messages: [{ role: "user", content: text }] },
          { type: EventKind.Error, message: refusal },
        ],
        target.threadId,
      );
      this.#core.emit(UiEvent.ChatError, { threadId: target.threadId, message: refusal });
      return;
    }
    // The person sent this, on this thread: a session answering it answers them (chat-permissions.ts).
    const messageId = action.type === DispatchActionType.UserMessage ? action.messageId : undefined;
    if (!target.studioThread) this.#x.permissions.notePersonMessage(target.threadId, messageId);
    await this.#core.host.dispatch(action);
  }

  /** A game thread whose plan is under review, or that asked for one, sends the message there. */
  async #requestPlanReview(text: string, options: ComposerSendOptions, sentAt: number): Promise<boolean> {
    const reviewThread = threadOr(this.#core, options.thread);
    const record = await this.#core.store.getRecord(reviewThread);
    const waiting = (record.metadata as { planReview?: PlanReview } | undefined)?.planReview;
    const isGame = (record.metadata as ThreadMeta)?.kind === ThreadKind.Game;
    // Reading the whole log costs seconds on a long chat, so only a message that could go to
    // plan review pays for it; every other send reaches the queue without it.
    if (!isGame || !needsPlanReview(options, waiting)) return false;
    // A stale checked toggle cannot detach a follow-up from the plan already being built.
    if (await this.#continuingRun(reviewThread)) return false;
    // A plan keeps its request, not the composer's bubble id: approving it sends a new message.
    const { clientId: _clientId, ...planOptions } = options;
    // A Stop pressed while this send read the chat is for this plan (`sentAt`).
    await this.#x.planReviews.request(reviewThread, text, planOptions, { sentAt });
    return true;
  }

  /**
   * Is the thread's run still going: still building, not finished, or still registered? A build a
   * rewind withdrew is not the chat's any more (the conversation reads without it).
   */
  async #continuingRun(threadId: string): Promise<boolean> {
    if ([...this.#x.activeDelegations.values()].some((delegation) => delegation.threadId === threadId)) return true;
    const run = latestRun(await this.#x.rewind.harnessView(threadId, await this.#core.store.listEvents(threadId)));
    if (run && run.state !== RunState.Finished) return true;
    return run?.runId !== undefined && this.#x.activeRunIds.has(run.runId);
  }

  /**
   * The mood board becomes durable project data the moment it commissions a run — the next
   * interview finds it in <project>/references/ even if the chat is long gone. Returns the files
   * this message added (relative to the game), which rewinding it takes back.
   */
  async #saveMoodBoard(project: string | undefined, options: ComposerSendOptions): Promise<string[]> {
    const frames = options.frames ?? options.autopilot?.frames;
    if (!frames?.length || !project) return [];
    const dir = this.#core.games.dirFor(project);
    try {
      const saved = await this.#core.saveReferenceFrames(project, frames);
      // Only files this message added: a picture sent before is the game's already.
      return saved.filter((entry) => entry.created).map((entry) => toPosixRelative(path.relative(dir, entry.file)));
    } catch (err) {
      this.#core.options.onLog?.(`[core] mood board save failed: ${errorMessage(err)}`, "stderr");
      return [];
    }
  }

  /**
   * The active thread decides where a message lands: a game thread carries its project (an
   * unbound draft means "scaffold a fresh one"), and the studio thread never builds.
   */
  async #messageTarget(text: string, options: ComposerSendOptions): Promise<MessageTarget> {
    const target: MessageTarget = {
      threadId: this.#core.mainThread,
      project: options.project,
      newProject: options.newProject === true,
      studioThread: false,
    };
    if (!options.thread) return target;
    const record = await this.#core.store.getRecord(options.thread);
    target.threadId = record.id;
    const meta = record.metadata as ThreadMeta;
    if (meta?.kind === ThreadKind.Game) {
      if (meta.project) target.project = meta.project;
      else target.newProject = true;
    } else {
      target.studioThread = true;
      target.project = undefined;
      target.newProject = false;
    }
    const first = hasPlaceholderTitle(record, meta);
    if (first && meta?.kind === ThreadKind.Game) await this.#nameThread(target.threadId, text, meta.project ?? null);
    // A game its first message left Untitled ("Hello", which home already named it from) is named
    // by a later one that says what it is. Never awaited: the message goes on while it is named.
    const later = !first && !options.origin && meta?.kind === ThreadKind.Game;
    if (later && meta.project) void this.#nameFromIdea(meta.project, text, options);
    return target;
  }

  /** The game named from this message, on the model it was sent to; a failure keeps the title it has. */
  async #nameFromIdea(project: string, text: string, options: ComposerSendOptions): Promise<void> {
    const request = { prompt: text, ...(options.engine ? { engine: options.engine } : {}) };
    await this.#core
      .nameFromIdea(project, { ...request, ...(options.model ? { model: options.model } : {}) })
      .catch(() => {});
  }

  /** A game thread is named after the first line of its first message. */
  async #nameThread(threadId: string, text: string, project: string | null): Promise<void> {
    const title = text.trim().split("\n")[0]?.slice(0, THREAD_TITLE_CHARS).trim();
    if (!title) return;
    await this.#core.store.updateThread(threadId, { title });
    this.#core.emit(UiEvent.ThreadUpdated, { threadId, title, project });
  }

  /**
   * Folders and stills the message names: a folder may become the thread's game, still folders
   * become read roots the thread remembers, and still files travel with the message.
   */
  async #namedPaths(
    text: string,
    target: MessageTarget,
    frames: ReferenceFrame[] | undefined,
  ): Promise<{ extraReads: string[]; stills: ReferenceFrame[] | undefined }> {
    const named = await resolveNamedPaths(text, { home: this.#core.games.homeDir });
    const { workspace } = named;
    const adoptsNamedFolder = target.newProject && !target.project && workspace;
    if (adoptsNamedFolder) await this.#adoptNamed(target, workspace);
    const project = target.project;
    if (!project) return { extraReads: [], stills: frames };
    const record = await this.#core.store.getRecord(target.threadId).catch(() => null);
    const meta = (record?.metadata ?? {}) as { extraReads?: string[] };
    const extraReads = [...new Set([...(meta.extraReads ?? []), ...named.stillRoots])];
    this.#x.delegation.addReadRoots(project, extraReads);
    // updateThread merges: only the key this changes, so a stale copy never overwrites others.
    if (record && extraReads.length) await this.#core.store.updateThread(target.threadId, { metadata: { extraReads } });
    if (!named.stillFiles.length) return { extraReads, stills: frames };
    return { extraReads, stills: [...(frames ?? []), ...(await this.#x.delegation.loadNamedStills(named.stillFiles))] };
  }

  async #adoptNamed(target: MessageTarget, workspace: string): Promise<void> {
    try {
      const adopted = await this.#core.adoptProject(workspace);
      await this.#core.bindThreadToProject(target.threadId, adopted.name);
      target.project = adopted.name;
      target.newProject = false;
    } catch {
      /* a path that cannot be adopted still reaches the model as extra stills */
    }
  }

  /**
   * A message to a provider resumes the thread's saved session with it, and the thread
   * remembers the provider, model and effort it was last sent with.
   */
  async #resumeContractor(
    threadId: string,
    options: ComposerSendOptions,
  ): Promise<{ sendOptions: ComposerSendOptions; resume: string | undefined }> {
    const record = await this.#core.store.getRecord(threadId).catch(() => null);
    const metadata = record?.metadata as ContractorMeta;
    const { sendOptions, resume } = resumedSession(metadata, options);
    // Written only when the choice changed: each write takes the store lock and three fsyncs
    // ahead of the message itself.
    if (record && choiceChanged(metadata, sendOptions)) {
      await this.#core.store.updateThread(threadId, {
        metadata: {
          lastEngine: sendOptions.engine,
          ...(sendOptions.model ? { lastModel: sendOptions.model } : {}),
          ...(sendOptions.effort ? { lastEffort: sendOptions.effort } : {}),
        },
      });
    }
    return { sendOptions, resume };
  }

  #userMessageAction(
    text: string,
    target: MessageTarget,
    options: ComposerSendOptions,
    context: {
      resume: string | undefined;
      extraReads: string[];
      stills: ReferenceFrame[] | undefined;
      references: string[];
    },
  ): DispatchAction {
    const { project, newProject, studioThread } = target;
    const { resume, extraReads, stills } = context;
    const projectDir = project ? this.#core.games.dirFor(project) : undefined;
    return {
      type: DispatchActionType.UserMessage,
      threadId: target.threadId,
      text,
      ...this.#rewindable(options, stills, context.references),
      ...modelChoice(options),
      ...(project ? { project } : {}),
      ...(newProject ? { newProject: true } : {}),
      ...(studioThread ? { studioThread: true } : {}),
      ...(resume ? { resume } : {}),
      ...(options.loop ? { loop: options.loop } : {}),
      ...(options.autopilot ? { autopilot: options.autopilot } : {}),
      ...(projectDir ? { projectDir } : {}),
      ...(extraReads.length ? { extraReads } : {}),
      ...(stills?.length ? { stills } : {}),
      ...(options.origin ? { origin: options.origin } : {}),
    };
  }

  /**
   * What makes the message rewindable. The composer's bubble id becomes the queue's message id, so
   * the bubble is matched exactly (a harness without the queue never reads it; the id also names
   * the attachments artifact). Recorded with the message so rewinding it can take back what it
   * added: the pictures the composer attached (the rest of the stills came from paths in the
   * text) and the reference files saved from them.
   */
  #rewindable(
    options: ComposerSendOptions,
    stills: ReferenceFrame[] | undefined,
    references: string[],
  ): { messageId?: string; pickedImages?: number; references?: string[] } {
    // A ready loop without the queue is not given it (a loop between the two read an id as
    // "already saved"); before the harness is ready its capabilities are unknown, and a first
    // message sent then kept its placeholder beside its own saved row.
    const host = this.#core.host;
    const queued = host.state !== HarnessState.Ready || host.hasCapability(HarnessCapability.MessageQueue);
    const messageId = queued && isQueueMessageId(options.clientId) ? options.clientId : undefined;
    return {
      ...(messageId ? { messageId } : {}),
      ...(stills?.length ? { pickedImages: Math.min(options.frames?.length ?? 0, stills.length) } : {}),
      ...(references.length ? { references } : {}),
    };
  }

  /**
   * An Autopilot or Loop commission to a harness whose loop code predates the feature must be
   * refused loudly, never silently downgraded to a plain chat message: a Loop commission is a
   * promise of an unattended run, and the user would wake to nothing. Gated on "ready" only: a
   * starting/restarting harness has not claimed anything yet.
   */
  #commissionRefusal(options: ComposerSendOptions): string | null {
    const host = this.#core.host;
    if (host.state !== HarnessState.Ready) return null;
    if (options.autopilot && !host.hasCapability(HarnessCapability.Autopilot)) return MESSAGE.autopilotOutdated;
    if (options.loop && !host.hasCapability(HarnessCapability.Loop)) return MESSAGE.loopOutdated;
    const localRoles = crossesCompletionEngine(options.engine ?? "", options.autopilot?.roles);
    if (localRoles && !host.hasCapability(HarnessCapability.LocalRoles)) return MESSAGE.localRolesOutdated;
    return null;
  }

  /**
   * Chat entry point. The active thread decides where a message lands: a game thread carries
   * its project (an unbound draft means "scaffold a fresh one"), and the studio thread never
   * builds — the flag lets the harness answer instead of guessing a workspace.
   */
  async coordinatorTool(
    threadId: string,
    runId: string,
    name: string,
    args: Record<string, unknown>,
    messageId?: string,
    asker?: AbortController,
  ): Promise<string> {
    const id = shortId("coord");
    await this.#core.append(
      [{ type: EventKind.ToolRequested, tool_call_id: id, request: { name, arguments: { runId, ...args } } }],
      threadId,
    );
    try {
      const content = await this.applyCoordinatorTool(threadId, runId, name, args, messageId, asker);
      await this.#core.append(
        [{ type: EventKind.ToolResult, tool_call_id: id, result: { ok: true, content } }],
        threadId,
      );
      return content;
    } catch (err) {
      await this.#core.append(
        [{ type: EventKind.ToolResult, tool_call_id: id, result: { ok: false, content: String(errorMessage(err)) } }],
        threadId,
      );
      throw err;
    }
  }

  /**
   * The run's controls the chat's own session keeps after a run it led (`runControls`: status,
   * show and land), answered as the coordinator's tools are, for the session asking (`asker`).
   */
  async runControl(
    threadId: string,
    grant: { runId: string; messageId?: string },
    name: string,
    args: Record<string, unknown>,
    asker: AbortController,
  ): Promise<string> {
    if (!isRunControl(name)) throw new Error(MESSAGE.unknownTool(name));
    return this.coordinatorTool(threadId, grant.runId, name, args, grant.messageId, asker);
  }

  async applyCoordinatorTool(
    threadId: string,
    runId: string,
    name: string,
    args: Record<string, unknown>,
    messageId?: string,
    asker?: AbortController,
  ): Promise<string> {
    if (!isCoordinatorTool(name)) throw new Error(MESSAGE.unknownTool(name));
    if (BUILD_CHANGES.has(name) && (await this.#x.planning(threadId))) return MESSAGE.inPlan;
    // The chat as its routing reads it (`events.list`): a build a rewind withdrew is not its run.
    const events = await this.#x.rewind.harnessView(threadId, await this.#core.store.listEvents(threadId));
    const run = latestRun(events);
    if (!run || run.runId !== runId) throw new Error(MESSAGE.runChanged);
    const call: CoordinatorCall = { threadId, runId, args, messageId, events, run, ...(asker ? { asker } : {}) };
    switch (name) {
      case CoordinatorTool.RunStatus:
        return this.#runStatus(call);
      case CoordinatorTool.ResumeRun:
        return this.#resumeRun(call);
      case CoordinatorTool.ContinueBuild:
        return this.#continueBuild(call);
      // Seeing and landing a build are for any run — finished, paused or running. A user who
      // asks "run the project" after a run must get the game, not "the run is finished".
      case CoordinatorTool.ShowBuild:
        return this.#showBuild(call);
      case CoordinatorTool.LandBuild:
        return this.#landBuild(call);
      case CoordinatorTool.FinishRun:
        this.#assertSteerable(call);
        return this.#core.requestRunFinish(threadId, runId);
      case CoordinatorTool.SteerRun:
        this.#assertSteerable(call);
        return this.#steerRun(call);
    }
  }

  async #runStatus({ threadId, runId, events, run, asker }: CoordinatorCall): Promise<string> {
    const coordinators = path.join(this.#core.layout.scratch, "coordinators") + path.sep;
    return JSON.stringify({
      ...runSnapshot(events, runId),
      toolCapabilities: (await this.#x.capabilityFacts(threadId, run.project, CapabilityAudience.Conversation)).text,
      activeWorkers: [...this.#x.activeDelegations.entries()]
        .filter(([cwd, d]) => d.project === run.project && !cwd.startsWith(coordinators) && d.abort !== asker)
        .map(([cwd, d]) => ({ workspace: path.basename(cwd), engine: d.engine, startedAt: d.startedAt })),
    });
  }

  async #resumeRun({ threadId, runId, args, messageId, events }: CoordinatorCall): Promise<string> {
    const targetRunId = typeof args.runId === "string" && args.runId ? args.runId : runId;
    const targetRun = latestRun(events, targetRunId);
    if (targetRun?.state === RunState.Running && this.#x.activeRunIds.has(targetRunId))
      return "This run is already active; it was not restarted.";
    if (targetRun?.state !== RunState.Paused) throw new Error(MESSAGE.onlyPausedResumes);
    const text = textArg(args.text);
    // Once per message and text: a replayed turn does not record it twice, a restated one is kept.
    const alreadySaved = chatSteers(events).some(
      (steer) => steer.sourceMessageId === messageId && steer.runId === targetRunId && steer.text === text,
    );
    if (text && !alreadySaved) {
      await this.#core.append(
        [
          customEventData(CustomEvent.RunSteering, {
            runId: targetRunId,
            text,
            sourceMessageId: messageId,
            at: new Date().toISOString(),
          }),
        ],
        threadId,
      );
    }
    // Dispatch is intentionally nonblocking; this resumes the existing journal, not intake.
    void this.#core.host
      .dispatch({ type: DispatchActionType.AutopilotResume, threadId, runId: targetRunId })
      .catch((err) =>
        this.#core.append(
          [{ type: EventKind.Error, message: `Could not resume ${targetRunId}: ${String(err)}` }],
          threadId,
        ),
      );
    // A lead's build goes on with the working time it had left (the harness's journal.ts `loopRunClock`).
    return "Resume requested for the same run. Its saved plan and completed work will be retained; a lead's build goes on with the working time it had left, and time spent paused does not count.";
  }

  async #continueBuild({ threadId, runId, args, messageId, events, run }: CoordinatorCall): Promise<string> {
    // A finished run is over for the chat, though the harness holds it through the learning pass
    // that follows (it stays in `activeRunIds` until `run.settled`): that pass never holds the chat.
    if (run.state !== RunState.Finished) throw new Error(MESSAGE.continueWhichRun);
    const text = textArg(args.text);
    if (!text || !messageId) throw new Error(MESSAGE.continueNeedsText);
    // A contained change goes to one builder turn even when a Loop came with the message.
    const contained = args.build === false;
    // Once per message, unless the request changed (a message steered into this turn restated it):
    // the builder takes the latest.
    const previous = payloadsOf(events, CustomEvent.RunFollowupRequested)
      .filter((followup) => followup.sourceMessageId === messageId)
      .at(-1);
    if (previous?.text !== text || (previous?.build === false) !== contained) {
      const followup = { runId, sourceMessageId: messageId, text, ...(contained ? { build: false } : {}) };
      await this.#core.append([customEventData(CustomEvent.RunFollowupRequested, followup)], threadId);
    }
    // Neutral on purpose: with a Loop on the message the harness goes on as the same build, reopened
    // with the Loop's time, and tells its coordinator so; without one a builder takes it in the chat.
    return "The requested work will continue in this game after your reply, using the saved plan and conversation.";
  }

  /** The build a show or land names, the game it is in, and the commit it means (none for live or an unknown name). */
  async #namedBuild({
    threadId,
    runId,
    args,
    run,
  }: CoordinatorCall): Promise<{ build: string; project: string; commit: string | null }> {
    const build = textArg(args.build ?? INTEGRATION_BUILD) || INTEGRATION_BUILD;
    const project = String(run.project ?? "");
    if (!project) throw new Error(MESSAGE.noProjectFolder);
    const integrationHead =
      typeof run.integrationHead === "string" ? run.integrationHead : await this.#journalHead(threadId, runId);
    return { build, project, commit: commitFor(build, integrationHead) };
  }

  /** The integration head the run's journal recorded, when its close did not carry one. */
  async #journalHead(threadId: string, runId: string): Promise<string | null> {
    const journal = (await this.#core.store.readArtifact(threadId, `autopilot_${runId}`).catch(() => null)) as {
      director?: { integrationHead?: string };
    } | null;
    return journal?.director?.integrationHead ?? null;
  }

  /**
   * Whether this show or land may load Live itself: it answers a message the person sent on this
   * thread that is still unanswered, by the host's own note (`awaitsAnswer`), whatever message id
   * the harness named, and Live is out of their sight. Such a message cannot tell "show me" from
   * "change the title", so while they watch Live it only offers the change; Reload brings it in.
   */
  #loadsLive({ threadId, messageId }: CoordinatorCall, project: string): boolean {
    const asked = messageId !== undefined && this.#x.permissions.awaitsAnswer(threadId, messageId);
    return asked && this.#x.previews.liveOutOfSight(project);
  }

  async #showBuild(call: CoordinatorCall): Promise<string> {
    const { build, project, commit } = await this.#namedBuild(call);
    const loads = this.#loadsLive(call, project);
    const elsewhere = this.#x.previews.liveHoldsAnother(project);
    if (build === LIVE_BUILD) {
      if (elsewhere) return OTHER_GAME_IN_LIVE;
      if (!loads) {
        await this.#core.offerLive({ project, root: null });
        return "Live was left as the person has it; if the game folder changed since it loaded, the Reload button on the stage now offers it.";
      }
      await this.#x.previews.loadPreview({ project });
      this.#core.emit(UiEvent.StageShow, { project, view: "live" });
      return "Live, on the right of the chat, now shows the game folder as it is.";
    }
    if (!commit) {
      if (build === INTEGRATION_BUILD) throw new Error(MESSAGE.noIntegrationToShow);
      throw new Error(MESSAGE.unknownBuild(build));
    }
    if (elsewhere) return OTHER_GAME_IN_LIVE;
    if (!loads) {
      const offered = await this.#core.offerBuild(project, commit);
      return `Live was left as the person has it: the Reload button on the stage now offers this build (${offered.slice(0, SHORT_COMMIT)}) and plays it when they press it. The game folder is unchanged. Tell the user it is ready to play with Reload.`;
    }
    const shown = await this.#core.showBuild(project, commit);
    this.#core.emit(UiEvent.StageShow, { project, view: "live" });
    const what = build === INTEGRATION_BUILD ? "the run's build" : `commit ${commit.slice(0, SHORT_COMMIT)}`;
    const notLanded =
      (call.run as { landed?: boolean }).landed === false
        ? "; this build is not in it yet, and land_build puts it there"
        : "";
    return `Live, on the right of the chat, now shows ${what} (${shown.commit.slice(0, SHORT_COMMIT)}). The game folder is unchanged${notLanded}. Tell the user it is open in Live.`;
  }

  async #landBuild(call: CoordinatorCall): Promise<string> {
    const { build, project, commit } = await this.#namedBuild(call);
    if (this.#x.activeRunIds.has(call.runId) && call.run.state === RunState.Running)
      throw new Error(MESSAGE.stillRunning);
    if (!commit) {
      if (build === INTEGRATION_BUILD) throw new Error(MESSAGE.noIntegrationToLand);
      throw new Error(MESSAGE.notCommitHash(build));
    }
    const loads = this.#loadsLive(call, project);
    const landed = await this.#core.landBuild(project, commit, {
      ...(call.asker ? { asker: call.asker } : {}),
      offerLive: !loads,
    });
    const landing = `Landed ${commit.slice(0, SHORT_COMMIT)} in the game folder (${landed.how})`;
    if (this.#x.previews.liveHoldsAnother(project))
      return `${landing}; another game is open in Live, so this one shows it when the user opens it.`;
    if (!loads)
      return `${landing}; Live was left as the person has it, and the Reload button on the stage now offers it.`;
    this.#core.emit(UiEvent.StageShow, { project, view: "live" });
    return `${landing}; Live now shows it.`;
  }

  /** Steering and finishing need the run running here and now; nothing restarts a stopped one. */
  #assertSteerable({ runId, run }: CoordinatorCall): void {
    if (this.#x.activeRunIds.has(runId) && run.state === RunState.Running) return;
    const state = run.state === RunState.Running ? "inactive" : run.state;
    throw new Error(MESSAGE.notSteerable(state));
  }

  async #steerRun({ threadId, runId, args, messageId, events }: CoordinatorCall): Promise<string> {
    const text = textArg(args.text);
    if (!text) throw new Error(MESSAGE.emptyGuidance);
    const facetId = typeof args.facetId === "string" && args.facetId.trim() ? args.facetId.trim() : undefined;
    if (facetId) await this.#assertFacet(threadId, runId, facetId);
    const duplicate =
      messageId &&
      chatSteers(events).some(
        (steer) =>
          steer.runId === runId &&
          steer.sourceMessageId === messageId &&
          steer.text === text &&
          steer.facetId === facetId,
      );
    if (duplicate) return "This guidance was already saved for this message; no duplicate was sent.";
    await this.#core.append(
      [
        customEventData(CustomEvent.RunSteering, {
          runId,
          text,
          ...(messageId ? { sourceMessageId: messageId } : {}),
          ...(facetId ? { facetId } : {}),
          at: new Date().toISOString(),
        }),
      ],
      threadId,
    );
    // An addressed steer no longer waits: the harness hands it to the worker it names and
    // interrupts that build turn (run-inbox `addressed`, director `routeUserSteers`).
    if (facetId)
      return `Guidance saved for ${facetId} and delivered as soon as the run reads its inbox: that worker's current turn is interrupted and the instruction goes in front of everything. Nothing was restarted, and no other worker was touched.`;
    return "Guidance saved for the existing workers' next iteration boundary. It has not yet been applied; no work was restarted.";
  }

  async #assertFacet(threadId: string, runId: string, facetId: string): Promise<void> {
    const journal = (await this.#core.store.readArtifact(threadId, `autopilot_${runId}`)) as {
      plan?: { facets?: Array<{ id: string }> };
    } | null;
    if (!journal?.plan?.facets?.some((f) => f.id === facetId)) throw new Error(MESSAGE.unknownFacet(facetId));
  }

  /**
   * Wrap up, from either door — the coordinator's `finish_run` tool and the Stop sheet. The ask
   * is a durable flag for the run's current session: a resume registers the run again, and a
   * session ignores asks written before its `run_registered` (`finishRequested`), so an ask made
   * before a Resume is written again, and one already made this session is not. A run that is
   * finished or paused is never asked: nothing is running to wrap up. One rule, both doors.
   */
  async requestRunFinish(threadId: string, runId: string): Promise<string> {
    const events = await this.#core.store.listEvents(threadId);
    const run = latestRun(events, runId);
    if (run?.state !== RunState.Running) throw new Error(MESSAGE.nothingToFinish(Boolean(run)));
    if (!finishRequested(events, runId)) {
      await this.#core.append(
        [
          customEventData(CustomEvent.RunControl, {
            runId,
            action: RunControlAction.Finish,
            at: new Date().toISOString(),
          }),
        ],
        threadId,
      );
    }
    return "Finishing requested: current worker attempts can complete, then accepted work is integrated, checked, and shown live. The run, plan, clock and worktrees are unchanged.";
  }

  /**
   * The stop button. Aborts the thread's contractor mid-build (its finished edits stay on disk
   * — the delegated turn then reports the partial state and offers Continue) and tells the
   * harness to wind down its own loop at the next round boundary. A rewind stops a build the same
   * way but keeps the queue held (`resumeQueue: false`): what waits there leaves with the rewind.
   */
  async stopThread(threadId: string, options: { resumeQueue?: boolean } = {}): Promise<void> {
    this.#x.selfImprovement.touchActivity();
    // A plan being written is a send still on its way: cancel it first, or waiting for sends below
    // would wait for the whole plan. A Stop pressed while its message was still sending is for that
    // message: let it reach the chat's queue first, or the harness would answer it after the Stop
    // as a fresh message. Both are bounded: a wedged harness that takes neither still gets stopped.
    const landed = this.#x.planReviews.cancel(threadId).then(() => this.#x.rewind.sendsLanded(threadId));
    await settleWithin(landed, this.#core.options.stopSendWaitMs ?? STOP_SEND_WAIT_MS, undefined);
    // Put the queue behind cancellation before aborting a provider can settle its turn.
    const cancelling = this.#core.host
      .dispatch({ type: DispatchActionType.Cancel, threadId }, STOP_DISPATCH_TIMEOUT_MS)
      .catch((error) =>
        this.#core.options.onLog?.(`[core] Stop acknowledgement failed: ${errorMessage(error)}`, "stderr"),
      );
    for (const controller of this.#x.activeCompletions.get(threadId) ?? []) controller.abort();
    this.#x.cancelConnectorCalls({ threadId });
    this.#core.plugins?.cancel({ threadId });
    const record = await this.#core.store.getRecord(threadId);
    const project = (record.metadata as { project?: string } | undefined)?.project;
    for (const delegation of this.#x.activeDelegations.values()) {
      if (delegation.threadId === threadId || (project && delegation.project === project)) delegation.abort.abort();
    }
    // Stop withdraws the game's unanswered plugin and tool questions too (the thread's own when
    // unbound), and nothing the chat was answering is the person's to answer any more. A message
    // still queued behind it is: the queue answers it next, and its session asks.
    this.#x.consent.cancel(project ? { project } : { threadId }, "stop");
    this.#x.permissions.cancel(project ? { project } : { threadId }, ToolPermissionBy.Stop);
    this.#x.permissions.stopPersonMessages(threadId);
    await cancelling;
    // Interrupt first, then let the queued follow-up take over. Never abort its new session.
    if (options.resumeQueue !== false && this.#core.host.hasCapability(HarnessCapability.MessageQueue))
      await this.#core.host.dispatch({ type: DispatchActionType.QueueResume, threadId }, STOP_DISPATCH_TIMEOUT_MS);
  }
}
