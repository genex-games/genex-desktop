/**
 * The user's side of a thread: a message sent, the run's host controls, wrapping up a run, and Stop.
 * Composed by `StudioCore`; its state stays in the core.
 */
import { PlanReviewState, type ComposerSendOptions, type PlanReview } from "../../shared/composer.ts";
import path from "node:path";
import {
  BuildLaunch,
  type ChatRun,
  finishRequested,
  isHostRunTool,
  latestRun,
  RunControlAction,
  runSnapshot,
} from "../../shared/chat-run.ts";
import { CustomEvent, customEventData, customRecord, type AnyCustomPayload } from "../../shared/custom-events.ts";
import { MessageFrom } from "../../shared/engine-requests.ts";
import { EventKind, ThreadKind, type ConversationRecord, type EventEnvelope } from "../../shared/event-log.ts";
import { t } from "../../shared/i18n.ts";
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
  MessageOrigin,
  type DispatchAction,
  type ReferenceFrame,
} from "../../shared/protocol.ts";
import type { CoreInternals, StudioCore } from "../studio-core.ts";
import { errorMessage } from "../../shared/errors.ts";
import { NEW_CHAT_TITLE, NEW_GAME_TITLE } from "./game-threads.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { settleWithin } from "../app-lifecycle.ts";
import { threadOr } from "./main-thread.ts";
import { isQueueMessageId } from "./rewind.ts";
import { forgetChatComputerYes } from "./desktop-session.ts";
import {
  type MentionSources,
  type MentionTarget,
  type ResolvedMentions,
  resolveMentions,
  tagOf,
} from "./mention-tags.ts";
import {
  type MentionOutcome,
  type MentionRef,
  MentionResult,
  MentionRetry,
  readMentionRefs,
} from "../../shared/prompt-mention.ts";

/** A message with no tags. */
const NO_TAGS: ResolvedMentions = { readRoots: [], context: "", outcomes: [] };

/** Where tags come from when the core has no genex.games: every genex.games tag says it did not arrive. */
const OFFLINE_SOURCES: MentionSources = {
  world: () => Promise.reject(new Error("offline")),
  me: async () => null,
  clone: () => Promise.reject(new Error("offline")),
  assetManifest: () => Promise.reject(new Error("offline")),
  addFromLibrary: () => Promise.reject(new Error("offline")),
};

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

/** Titles a thread has before its first message names it. */
const PLACEHOLDER_TITLES: readonly string[] = [NEW_GAME_TITLE, NEW_CHAT_TITLE];
/** Characters of a first message kept as the thread's title. */
const THREAD_TITLE_CHARS = 56;

/**
 * User-facing copy of this module, and what the chat's session reads when a run control is refused.
 * The tag line is said to the person in their language; the tag retry line is the agent's, and the
 * rest are tool results.
 */
const MESSAGE = {
  tagNoGame: () => t("Tags belong to a game's chat"),
  tagRetried: (handle: string) => `@${handle} did not arrive with my last message; it is attached now.`,
  unknownTool: (name: string) => `unknown run control: ${name}`,
  inPlan:
    "The chat is in Plan mode, so this did not run: resuming a build waits until the plan is approved. Put it in your plan instead.",
  runChanged: "The run changed. This message cannot control another run; read the current state.",
  onlyPausedResumes: "Only a paused run from this conversation can be resumed. No new run was started.",
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

/** What a run control works on. */
interface RunCall {
  threadId: string;
  runId: string;
  args: Record<string, unknown>;
  messageId: string | undefined;
  events: EventEnvelope[];
  run: ChatRun;
  /**
   * The chat's own session asking: its own hold on the game folder is not a contractor building
   * there, nor one of the run's workers.
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

/** A message's pictures as saved in its game: the files it added. */
interface SavedPictures {
  added: string[];
}

/** No pictures saved: none sent, no game to save them in, or the save failed. */
const NO_PICTURES: SavedPictures = Object.freeze({ added: [] }) as SavedPictures;

/** Does a game thread's next message go to a plan review first? */
function needsPlanReview(options: ComposerSendOptions, waiting: PlanReview | undefined): boolean {
  const reviewOpen = Boolean(waiting && OPEN_PLAN_REVIEW.includes(waiting.state));
  return Boolean(options.reviewPlan || reviewOpen);
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
    if (await this.#requestPlanReview(text, options, sentAt)) return;
    const target = await this.#messageTarget(text, options);
    const tags = await this.#resolveTags(target, options);
    const { extraReads, stills } = target.studioThread
      ? { extraReads: [], stills: options.frames }
      : await this.#namedPaths(text, target, options.frames, tags.readRoots);
    const { sendOptions, resume } =
      !target.studioThread && options.engine
        ? await this.#resumeContractor(target.threadId, options)
        : { sendOptions: options, resume: options.resume };
    if (target.project && !target.studioThread) {
      await this.#core.games.ensureCover(target.project);
      this.#core.emit(UiEvent.GameChanged, { project: target.project });
    }
    const pictures = await this.#savePictures(target.project, sendOptions);
    // The agent reads the tags' lines after the person's words; the chat shows the words alone.
    const action = this.#userMessageAction(text + tags.context, target, sendOptions, {
      resume,
      extraReads,
      stills,
      references: pictures.added,
    });
    // The person sent this, on this thread: a session answering it answers them (chat-permissions.ts).
    const messageId = action.type === DispatchActionType.UserMessage ? action.messageId : undefined;
    if (!target.studioThread) this.#x.permissions.notePersonMessage(target.threadId, messageId);
    await this.#core.host.dispatch(action);
    // After the message, so the chat shows each tag's line under it.
    if (tags.outcomes.length)
      await this.#core.append(
        [customEventData(CustomEvent.MentionTagged, { ...(messageId ? { messageId } : {}), tags: tags.outcomes })],
        target.threadId,
      );
  }

  /**
   * A failed tag of a sent message, tried again or taken off. Again resolves it as a send would
   * and, when it now attaches, tells the agent in a line the chat leaves out; either way the
   * message's result card shows the tag's new result.
   */
  async retryMention(threadId: string, messageId: string, ref: MentionRef, action: MentionRetry): Promise<void> {
    const record = await this.#core.store.getRecord(threadId);
    const meta = record.metadata as ThreadMeta;
    const project = meta?.kind === ThreadKind.Game ? meta.project : undefined;
    if (!project) throw new Error(MESSAGE.tagNoGame());
    const recordTags = (tags: MentionOutcome[]) =>
      this.#core.append([customEventData(CustomEvent.MentionTagged, { messageId, tags })], threadId);
    if (action === MentionRetry.Remove) {
      await recordTags([{ ...tagOf(ref), result: MentionResult.Removed }]);
      return;
    }
    const target = { threadId, project, newProject: false, studioThread: false };
    const tags = await this.#resolveTags(target, { mentions: [ref] });
    await recordTags(tags.outcomes);
    if (tags.outcomes.every((tag) => tag.result === MentionResult.Unavailable)) return;
    await this.sendUserMessage(`${MESSAGE.tagRetried(ref.handle)}${tags.context}`, {
      thread: threadId,
      origin: MessageOrigin.TagRetry,
    });
  }

  /** The message's @ tags made real for its game; none outside a game's chat. */
  async #resolveTags(target: MessageTarget, options: ComposerSendOptions): Promise<ResolvedMentions> {
    const refs = readMentionRefs(options.mentions);
    const project = target.project;
    if (!refs.length || !project || target.studioThread) return NO_TAGS;
    const games = await this.#core.games.list();
    const game = games.find((entry) => entry.name === project);
    const tagTarget: MentionTarget = {
      project,
      gameDir: this.#core.games.dirFor(project),
      webGame: !game?.engine,
      libraryDir: async (name) => (name === project ? null : (games.find((entry) => entry.name === name)?.dir ?? null)),
    };
    return resolveMentions(refs, tagTarget, this.#core.options.mentionSources ?? OFFLINE_SOURCES);
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
   * A message's pictures become durable project data as it is sent — a later turn or run finds them
   * in <project>/references/ even if the chat is long gone. Returns, relative to the game, the files
   * this message added (`added`), which rewinding it takes back.
   */
  async #savePictures(project: string | undefined, options: ComposerSendOptions): Promise<SavedPictures> {
    const { frames } = options;
    if (!frames?.length || !project) return NO_PICTURES;
    const dir = this.#core.games.dirFor(project);
    try {
      const saved = await this.#core.saveReferenceFrames(project, frames);
      const relative = (file: string) => toPosixRelative(path.relative(dir, file));
      // Only files this message added: a picture sent before is the game's already.
      return { added: saved.filter((entry) => entry.created).map((entry) => relative(entry.file)) };
    } catch (err) {
      this.#core.options.onLog?.(`[core] mood board save failed: ${errorMessage(err)}`, "stderr");
      return NO_PICTURES;
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
   * and the folders of other named files become read roots the thread remembers, and still files
   * travel with the message.
   */
  async #namedPaths(
    text: string,
    target: MessageTarget,
    frames: ReferenceFrame[] | undefined,
    taggedRoots: readonly string[] = [],
  ): Promise<{ extraReads: string[]; stills: ReferenceFrame[] | undefined }> {
    const named = await resolveNamedPaths(text, { home: this.#core.games.homeDir });
    const { workspace } = named;
    const adoptsNamedFolder = target.newProject && !target.project && workspace;
    if (adoptsNamedFolder) await this.#adoptNamed(target, workspace);
    const project = target.project;
    if (!project) return { extraReads: [], stills: frames };
    const record = await this.#core.store.getRecord(target.threadId).catch(() => null);
    const meta = (record?.metadata ?? {}) as { extraReads?: string[] };
    const extraReads = [
      ...new Set([...(meta.extraReads ?? []), ...named.stillRoots, ...named.fileRoots, ...taggedRoots]),
    ];
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
      ...(options.roles ? { roles: options.roles } : {}),
      ...(projectDir ? { projectDir } : {}),
      ...(extraReads.length ? { extraReads } : {}),
      ...(stills?.length ? { stills } : {}),
      ...(options.origin ? { origin: options.origin } : {}),
      // Words the chat wrote itself, or a plugin's ask it shows: the agent reads them as Genex's.
      ...(options.origin || options.from === MessageFrom.Genex ? { from: MessageFrom.Genex } : {}),
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
   * One of the run's host controls (`run.control`): the run's controls the chat's own session keeps
   * after a closed Loop run (its status), answered live, and the resume it recorded, for
   * the session asking (`asker`). Recorded in the chat as a tool call and its result.
   */
  async runControl(
    threadId: string,
    runId: string,
    name: string,
    args: Record<string, unknown>,
    messageId?: string,
    asker?: AbortController,
  ): Promise<string> {
    const id = shortId("ctl");
    await this.#core.append(
      [{ type: EventKind.ToolRequested, tool_call_id: id, request: { name, arguments: { runId, ...args } } }],
      threadId,
    );
    try {
      const content = await this.#applyRunControl(threadId, runId, name, args, messageId, asker);
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

  async #applyRunControl(
    threadId: string,
    runId: string,
    name: string,
    args: Record<string, unknown>,
    messageId?: string,
    asker?: AbortController,
  ): Promise<string> {
    if (!isHostRunTool(name)) throw new Error(MESSAGE.unknownTool(name));
    // Going on with a build waits while the chat is in Plan; reading its status does not.
    const resumes = name === BuildLaunch.ResumeRun;
    if (resumes && (await this.#x.planning(threadId))) return MESSAGE.inPlan;
    // The chat as its routing reads it (`events.list`): a build a rewind withdrew is not its run.
    const events = await this.#x.rewind.harnessView(threadId, await this.#core.store.listEvents(threadId));
    const run = latestRun(events);
    if (!run || run.runId !== runId) throw new Error(MESSAGE.runChanged);
    const call: RunCall = { threadId, runId, args, messageId, events, run, ...(asker ? { asker } : {}) };
    return resumes ? this.#resumeRun(call) : this.#runStatus(call);
  }

  #runStatus({ runId, events, run, asker }: RunCall): string {
    return JSON.stringify({
      ...runSnapshot(events, runId),
      activeWorkers: [...this.#x.activeDelegations.entries()]
        .filter(([, d]) => d.project === run.project && d.abort !== asker)
        .map(([cwd, d]) => ({ workspace: path.basename(cwd), engine: d.engine, startedAt: d.startedAt })),
    });
  }

  async #resumeRun({ threadId, runId, args, messageId, events, run }: RunCall): Promise<string> {
    if (run.state === RunState.Running && this.#x.activeRunIds.has(runId))
      return "This run is already active; it was not restarted.";
    if (run.state !== RunState.Paused) throw new Error(MESSAGE.onlyPausedResumes);
    const text = textArg(args.text);
    // Once per message and text: a replayed turn does not record it twice, a restated one is kept.
    const alreadySaved = chatSteers(events).some(
      (steer) => steer.sourceMessageId === messageId && steer.runId === runId && steer.text === text,
    );
    if (text && !alreadySaved) {
      await this.#core.append(
        [
          customEventData(CustomEvent.RunSteering, {
            runId,
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
      .dispatch({ type: DispatchActionType.AutopilotResume, threadId, runId })
      .catch((err) =>
        this.#core.append([{ type: EventKind.Error, message: `Could not resume ${runId}: ${String(err)}` }], threadId),
      );
    return "Resume requested for the same run. Its saved plan and completed work will be retained.";
  }

  /**
   * Wrap up, Builds' Wrap up (`studio:run.finish`). The ask is a durable flag for the run's
   * current session: a resume registers the run again, and a session ignores asks written before
   * its `run_registered` (`finishRequested`), so an ask made before a Resume is written again, and
   * one already made this session is not. A run that is finished or paused is never asked: nothing
   * is running to wrap up.
   */
  async requestRunFinish(threadId: string, runId: string): Promise<void> {
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
  }

  /**
   * The stop button. Aborts the thread's contractor mid-build (its finished edits stay on disk
   * — the delegated turn then reports the partial state and offers Continue) and tells the
   * harness to wind down its own loop at the next round boundary. A rewind stops a build the same
   * way but keeps the queue held (`resumeQueue: false`): what waits there leaves with the rewind.
   */
  async stopThread(threadId: string, options: { resumeQueue?: boolean } = {}): Promise<void> {
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
    // Stop also ends the chat's yes to computer control: its next turn asks again.
    forgetChatComputerYes(this.#core, threadId);
    // And the timer its agent set (`wake_later`): nothing wakes the chat to go on with what was stopped.
    this.#core.wakeLater.cancel(threadId);
    this.#x.permissions.cancel(project ? { project } : { threadId }, ToolPermissionBy.Stop);
    this.#x.permissions.stopPersonMessages(threadId);
    await cancelling;
    // Interrupt first, then let the queued follow-up take over. Never abort its new session.
    if (options.resumeQueue !== false && this.#core.host.hasCapability(HarnessCapability.MessageQueue))
      await this.#core.host.dispatch({ type: DispatchActionType.QueueResume, threadId }, STOP_DISPATCH_TIMEOUT_MS);
  }
}
