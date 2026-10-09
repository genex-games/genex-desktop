/**
 * Rewinding a game chat (`shared/chat-rewind.ts`): a message and everything after it leave the
 * conversation (the log keeps them), the provider sessions that remember them are dropped, and,
 * when asked, the game files go back to the checkpoint taken before that message was answered
 * (`../chat-checkpoints.ts`). A build running in the chat is stopped first; its rows, and those of
 * every build started after the message, leave the conversation with it. This service also takes
 * those checkpoints as the queue starts and settles each message, holds sends and other changes to
 * a chat while it is being rewound, and gives the harness the log as the conversation reads after
 * its rewinds.
 * Composed by `StudioCore`; its state stays here.
 */
import path from "node:path";
import { lstat, rm } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import {
  CHECKPOINT_SKIPPED_FILES_LISTED,
  type CheckpointSkippedPayload,
  endsChatSessions,
  FilesStay,
  harnessView,
  type ChatRewind,
  type PlannedRewind,
  planRewind,
  type RewindFiles,
  type RewindPlan,
  type RewindPreview,
  type RewindResult,
  rewindRefusalWords,
  RewindRefusal,
  rewindsOf,
  SkippedBy,
  type SkippedFile,
  withoutRewound,
} from "../../shared/chat-rewind.ts";
import type { PlanReview } from "../../shared/composer.ts";
import { CustomEvent, customEventData, customRecord } from "../../shared/custom-events.ts";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import { EventKind, type EventData, type EventEnvelope, type Message, ThreadKind } from "../../shared/event-log.ts";
import { messageQueueState } from "../../shared/message-queue.ts";
import { DispatchActionType, HarnessCapability, HarnessState, type ReferenceFrame } from "../../shared/protocol.ts";
import { RunState } from "../../shared/run-state.ts";
import { latestRun } from "../../shared/coordinator.ts";
import type { PlacedRule } from "../../shared/project-workspace.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import { listDirs, pathExists } from "../../substrate/fsx.ts";
import { isUuid } from "../../substrate/ids.ts";
import { toolchain } from "../../substrate/toolchain.ts";
import {
  CHECKPOINT_CHANGE_MAX_BYTES,
  CHECKPOINT_FILE_MAX_BYTES,
  CheckpointPhase,
  ChatCheckpoints,
} from "../chat-checkpoints.ts";
import type { CoreInternals, StudioCore } from "../studio-core.ts";
import { noteUnsaved } from "./unsaved-files.ts";

/** How long a message's answer waits for the game checkpoint before going ahead without it. */
const CHAT_CHECKPOINT_WAIT_MS = 30 * SECOND_MS;
/** How long a rewind waits for the harness to take back the mood board; it never waits for more. */
const REWIND_NOTICE_TIMEOUT_MS = 3 * SECOND_MS;
/**
 * How long a rewind waits for the build it stopped to close (its workers settle, its close is
 * written). A stopped build lands nothing, so this is its workers winding down, never the run.
 */
const REWIND_BUILD_STOP_WAIT_MS = 2 * MINUTE_MS;
/** How often the rewind looks again while that build closes. */
const REWIND_BUILD_STOP_POLL_MS = 250;
/** How much of a failure's message the log line keeps. */
const LOG_DETAIL_CHARS = 300;
/** A queue message id the host accepts: the harness's own, or a composer bubble's. */
const MESSAGE_ID = /^[\w-]{1,80}$/;
/** A reference picture a message saved: one file directly in the game's `references/`. */
const REFERENCE_FILE = /^references\/[^/]+$/;
/** The artifacts a run coordinator keeps its session in, one per run. */
const COORDINATOR_ARTIFACT_PREFIX = "coordinator_";

const MESSAGE = {
  WaitForRewind: "Wait for the rewind to finish, then try again.",
  WaitToSend: "Wait for the rewind to finish, then send it again.",
  AlreadyRewinding: "This chat is already rewinding.",
  NotInChat: "That message is not in this chat.",
  OnlyGameChat: "Only a game chat can be rewound.",
  Restarting: "Studio is restarting. Try again in a moment.",
  HeldNeedsQueue: "Remove the waiting messages first: this harness cannot take them back.",
  BuildStillStopping: "The build is still stopping. Try again in a moment.",
  checkpointLate: (messageId: string) =>
    `[core] the game checkpoint before ${messageId} took too long; that message can rewind the chat, not its files`,
  checkpointFailed: (phase: CheckpointPhase, messageId: string, err: unknown) =>
    `[core] no game checkpoint ${phase} ${messageId}: ${errorMessage(err).slice(0, LOG_DETAIL_CHARS)}`,
  rulesFailed: (err: unknown) =>
    `[core] a game checkpoint went on without the folder's ignore rules: ${errorMessage(err).slice(0, LOG_DETAIL_CHARS)}`,
  skippedNotReported: (threadId: string, err: unknown) =>
    `[core] files too large to save in ${threadId} could not be reported: ${errorMessage(err).slice(0, LOG_DETAIL_CHARS)}`,
  putBackFailed: (err: unknown) => `[core] rewind could not put the game files back: ${errorMessage(err)}`,
  tidyFailed: (threadId: string, what: string, err: unknown) =>
    `[core] after rewinding ${threadId}, ${what} failed: ${errorMessage(err)}`,
  resumeFailed: (threadId: string, err: unknown) =>
    `[core] the rewind of ${threadId} failed, and its queue could not resume: ${errorMessage(err)}`,
} as const;

/** Is this a queue message id the host may use (as a ref name, an artifact name)? */
export function isQueueMessageId(value: unknown): value is string {
  return typeof value === "string" && MESSAGE_ID.test(value);
}

/** What a rewind reads from a chat's record. */
type RewindMeta = { kind?: string; project?: string | null; planReview?: PlanReview; extraReads?: unknown } | undefined;

/**
 * The folders a chat still reads once a rewind took messages back: those the remaining messages
 * named, and only ones the thread already recorded. The queue's rows are the harness's, so a
 * rewind may narrow what the host recorded but never widen it.
 */
export function readsAfterRewind(recorded: unknown, remaining: readonly { extraReads?: string[] }[]): string[] {
  const known = new Set(Array.isArray(recorded) ? recorded.filter((dir) => typeof dir === "string") : []);
  return [...new Set(remaining.flatMap((action) => action.extraReads ?? []))].filter((dir) => known.has(dir));
}
/** The parts of a queued message's saved action a rewind takes back. */
interface RewoundAction {
  extraReads?: string[];
  references?: string[];
  attachmentsArtifact?: string;
  autopilot?: { frames?: unknown };
}
/** A message that stays after a rewind: its bubble and its saved action. */
interface RemainingAction {
  eventId: string;
  action: RewoundAction;
}
/** Game files a rewind put back, the saved copy that undoes it, and files too large to put back. */
interface RestoredFiles {
  files: number;
  saved: string;
  stayed?: string[];
}
/** Who left files too large to save, for the chat's line: a message's checkpoint, or a rewind. */
type SkippedReport = Required<Pick<CheckpointSkippedPayload, "project" | "messageId" | "by">>;

/** Each file with its size now, largest first (0 for one already gone); links are never followed. */
async function sizedFiles(dir: string, files: readonly string[]): Promise<SkippedFile[]> {
  const sized = await Promise.all(
    files.map(async (file) => ({ file, bytes: (await lstat(path.join(dir, file)).catch(() => null))?.size ?? 0 })),
  );
  return sized.sort((a, b) => b.bytes - a.bytes || a.file.localeCompare(b.file));
}
/** One rewind as asked for and first planned. */
interface RewindRequest {
  threadId: string;
  eventId: string;
  messageId: string;
  meta: RewindMeta;
  rewinds: ChatRewind[];
  first: PlannedRewind;
  /** The game folder, when the chat has one. */
  dir: string | null;
  /** Put the game files back too. */
  files: boolean;
}
/** A rewind as asked for (`files`: the person asked for the game files too), before it is planned. */
type AskedRewind = Omit<RewindRequest, "first" | "dir">;
/** What a rewind withdrew, and the files it put back. */
interface AppliedRewind {
  planned: PlannedRewind;
  withdrawn: RewoundAction[];
  remaining: RemainingAction[];
  restored: RestoredFiles | null;
}

function plannedOrThrow(plan: RewindPlan): PlannedRewind {
  if (!plan.ok) throw new Error(rewindRefusalWords(plan.reason));
  return plan;
}

const unavailable = (reason: FilesStay): RewindFiles => ({ state: "unavailable", reason });

/**
 * Why the game files cannot follow the chat back, before any checkpoint is asked: the message
 * joined an answer under way (no checkpoint was taken just before it), a build after it landed,
 * or it has no queue record (the queue takes every checkpoint) or an id no checkpoint could name.
 */
function filesStay(planned: PlannedRewind): FilesStay | null {
  if (planned.joined) return FilesStay.JoinedAnswer;
  if (planned.builds.some((build) => build.landed)) return FilesStay.BuildChanged;
  if (!planned.queued || !isQueueMessageId(planned.rewind.messageId)) return FilesStay.NoCheckpoint;
  return null;
}

/** A checkpoint whose history moved says so as a build's doing when a build ran after the message. */
function afterBuilds(files: RewindFiles, planned: PlannedRewind): RewindFiles {
  const moved = files.state === "unavailable" && files.reason === FilesStay.HistoryChanged;
  return moved && planned.builds.length ? unavailable(FilesStay.BuildChanged) : files;
}

const actionOf = (message: { action?: unknown }): RewoundAction => (message.action ?? {}) as RewoundAction;

/** A withdrawn message changed state the remaining ones may share: named folders, a mood board, pictures. */
const sharesState = (action: RewoundAction): boolean =>
  Boolean(action.extraReads?.length || action.references?.length || action.autopilot || action.attachmentsArtifact);

/** The saved actions of the messages from a bubble on. */
function withdrawnActions(rows: readonly EventEnvelope[], eventId: string): RewoundAction[] {
  return [...messageQueueState(rows).messages.values()]
    .filter((message) => message.eventId && message.eventId >= eventId)
    .map(actionOf);
}

/** What the composer gets back to offer the message (and its waiting follow-ups) again. */
function rewindResult(first: PlannedRewind, messageId: string, restored: RestoredFiles | null): RewindResult {
  return {
    text: [first.text, ...first.held.map((held) => held.text)].filter((text) => text.trim()).join("\n\n"),
    messageId,
    imageCount: first.imageCount,
    pickedImages: first.pickedImages,
    files: restored?.files ?? null,
    held: first.held
      .filter((held) => held.pickedImages > 0)
      .map((held) => ({ messageId: held.messageId, pickedImages: held.pickedImages })),
  };
}

/** Reference pictures only withdrawn messages saved; the rest of the game still reads them. */
async function removeWithdrawnReferences(
  dir: string,
  withdrawn: readonly RewoundAction[],
  remaining: readonly RemainingAction[],
): Promise<number> {
  const kept = new Set(remaining.flatMap((entry) => entry.action.references ?? []));
  let removed = 0;
  for (const file of new Set(withdrawn.flatMap((action) => action.references ?? []))) {
    if (kept.has(file) || !REFERENCE_FILE.test(file)) continue;
    const target = path.join(dir, file);
    if (!(await pathExists(target))) continue;
    await rm(target, { force: true });
    removed++;
  }
  return removed;
}

export class ChatRewindService {
  readonly #core: StudioCore;
  readonly #x: CoreInternals;
  /** Chats being rewound: no message is taken until the rewind has settled. */
  readonly #rewinding = new Set<string>();
  /** Sends in progress per chat: a rewind waits for them. */
  readonly #sending = new Map<string, number>();
  /** The sends themselves, per chat: a Stop waits for them to reach the chat's queue. */
  readonly #inFlight = new Map<string, Set<Promise<void>>>();
  /** Per chat, the game checkpoint its next answer waits for (bounded; it never fails the answer). */
  readonly #checkpointsBefore = new Map<string, Promise<void>>();
  /** Per chat, the files too large to save its last report named (sorted, one per line). */
  readonly #reportedSkips = new Map<string, string>();
  #checkpoints?: ChatCheckpoints;

  constructor(core: StudioCore, x: CoreInternals) {
    this.#core = core;
    this.#x = x;
  }

  /** The game folder before each chat message, for rewinding (`../chat-checkpoints.ts`). */
  get checkpoints(): ChatCheckpoints {
    this.#checkpoints ??= new ChatCheckpoints(
      path.join(this.#core.layout.scratch, "chat-checkpoints"),
      async () => (await toolchain()).path,
      // The folder's rules for what it holds now, topped up first (one walk per checkpoint).
      { neverCaptured: (dir) => this.#rules(dir) },
    );
    return this.#checkpoints;
  }

  /** What a game folder's rules leave out of its checkpoints; none, logged, when they cannot be read. */
  async #rules(dir: string): Promise<PlacedRule[]> {
    try {
      return await this.#core.games.ensureWorkspaceRules(dir);
    } catch (err) {
      this.#log(MESSAGE.rulesFailed(err));
      return [];
    }
  }

  #log(line: string): void {
    this.#core.options.onLog?.(line, "stderr");
  }

  /** What changes a chat's conversation waits while it is being rewound. */
  assertNotRewinding(threadId: string, message: string = MESSAGE.WaitForRewind): void {
    if (this.#rewinding.has(threadId)) throw new Error(message);
  }

  /**
   * A send into a chat. A rewind waits for sends already on their way: one could otherwise
   * resume the session the rewind is clearing, or land between its plan and its marker.
   */
  async whileSending(threadId: string, send: () => Promise<void>): Promise<void> {
    this.assertNotRewinding(threadId, MESSAGE.WaitToSend);
    this.#sending.set(threadId, (this.#sending.get(threadId) ?? 0) + 1);
    const sending = send();
    const inFlight = this.#inFlight.get(threadId) ?? new Set<Promise<void>>();
    inFlight.add(sending);
    this.#inFlight.set(threadId, inFlight);
    try {
      await sending;
    } finally {
      inFlight.delete(sending);
      if (!inFlight.size) this.#inFlight.delete(threadId);
      const left = (this.#sending.get(threadId) ?? 1) - 1;
      if (left > 0) this.#sending.set(threadId, left);
      else this.#sending.delete(threadId);
    }
  }

  /**
   * Settles once every send into this chat that was on its way has reached the chat's queue (or
   * failed): a Stop pressed while its message was still sending then reaches that message.
   */
  async sendsLanded(threadId: string): Promise<void> {
    await Promise.allSettled([...(this.#inFlight.get(threadId) ?? [])]);
  }

  /**
   * A handover or a log summary ends the chat's provider session as a rewind does: the next turn
   * starts a fresh one briefed with it (`harnessView`), so the session the host would resume goes
   * too. The provider's own compaction keeps it (`endsChatSessions`). The compaction is already in
   * the log, and names the session it ended, so a failed write only leaves the session saved,
   * never resumed.
   */
  async forgetCompactedSession(threadId: string, batch: readonly EventData[]): Promise<void> {
    if (!batch.some(endsChatSessions)) return;
    await this.#core.store.updateThread(threadId, { metadata: { contractor: null } }).catch(() => {});
  }

  // ── checkpoints ──────────────────────────────────────────────────────────────────────────
  /**
   * A message's processing starts the game checkpoint that its answer's `turn.begin` waits for;
   * its end records the folder after. Neither holds up the queue that wrote them.
   */
  checkpointQueueRecords(threadId: string, batch: readonly EventData[]): void {
    for (const data of batch) {
      const custom = customRecord(data);
      if (custom?.event_type === CustomEvent.CoordinatorMessageProcessing) {
        void this.#checkpoint(threadId, custom.payload.messageId, CheckpointPhase.Before);
      }
      if (custom?.event_type === CustomEvent.CoordinatorMessageHandled) {
        void this.#checkpoint(threadId, custom.payload.messageId, CheckpointPhase.After);
      }
    }
  }

  /** The checkpoint a chat's next answer waits for; nothing of the answer runs before it. */
  checkpointBefore(threadId: string): Promise<void> {
    return this.#checkpointsBefore.get(threadId) ?? Promise.resolve();
  }

  /**
   * The game folder before a message's answer, or after it. Without a checkpoint the chat can
   * still be rewound, only its files cannot, so this never delays an answer for long: one that
   * is not ready by the deadline is not kept, as the answer may already be changing the folder.
   */
  #checkpoint(threadId: string, messageId: unknown, phase: CheckpointPhase): Promise<void> {
    if (!isQueueMessageId(messageId)) return Promise.resolve();
    const deadline = Date.now() + CHAT_CHECKPOINT_WAIT_MS;
    const work = this.#takeCheckpoint(threadId, messageId, phase, deadline).catch((err: unknown) =>
      this.#log(MESSAGE.checkpointFailed(phase, messageId, err)),
    );
    if (phase === CheckpointPhase.After) return work;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, CHAT_CHECKPOINT_WAIT_MS);
    });
    const bounded = Promise.race([work, timeout]).finally(() => clearTimeout(timer));
    this.#checkpointsBefore.set(threadId, bounded);
    void bounded.then(() => {
      if (this.#checkpointsBefore.get(threadId) === bounded) this.#checkpointsBefore.delete(threadId);
    });
    return bounded;
  }

  async #takeCheckpoint(threadId: string, messageId: string, phase: CheckpointPhase, deadline: number): Promise<void> {
    const record = await this.#core.store.getRecord(threadId).catch(() => null);
    const meta = record?.metadata as RewindMeta;
    if (meta?.kind !== ThreadKind.Game || !meta.project) return;
    const dir = this.#core.games.dirFor(meta.project);
    if (
      !(await this.#core.assertProjectAllowed(dir).then(
        () => true,
        () => false,
      ))
    )
      return;
    const before = phase === CheckpointPhase.Before;
    const taken = await this.checkpoints.take(dir, threadId, messageId, phase, before ? deadline : undefined);
    if (!taken) {
      this.#log(MESSAGE.checkpointLate(messageId));
      return;
    }
    await this.#reportCheckpointSkips(threadId, dir, taken, {
      project: meta.project,
      messageId,
      by: SkippedBy.Checkpoint,
    });
  }

  /**
   * A checkpoint that left files out for their size says so once per new set: the chat gets a line
   * and the thread's next delegated session is told. A report that fails is logged, never more.
   */
  async #reportCheckpointSkips(threadId: string, dir: string, commit: string, report: SkippedReport): Promise<void> {
    try {
      const { skipped } = await this.checkpoints.leftOut(dir, commit);
      const set = [...skipped].sort().join("\n");
      const reported = this.#reportedSkips.get(threadId);
      if (set === (reported ?? "")) return;
      if (!skipped.length) {
        this.#reportedSkips.delete(threadId);
        return;
      }
      // Claimed before the report's awaits, so a checkpoint right behind it is not told twice.
      this.#reportedSkips.set(threadId, set);
      await this.#reportSkipped(threadId, dir, skipped, report).catch((err: unknown) => {
        if (this.#reportedSkips.get(threadId) === set) this.#reportedSkips.delete(threadId);
        throw err;
      });
    } catch (err) {
      this.#log(MESSAGE.skippedNotReported(threadId, err));
    }
  }

  /**
   * Changed files a rewind left as they are for their size, reported like a checkpoint's: those a
   * restore held back, or, when only the chat went back, every changed file if all were too large.
   */
  async #reportLeftTooLarge(threadId: string, project: string, applied: AppliedRewind): Promise<void> {
    const messageId = applied.planned.rewind.messageId;
    const dir = this.#core.games.dirFor(project);
    const stayed = applied.restored ? (applied.restored.stayed ?? []) : await this.#allTooLarge(threadId, dir, applied);
    if (!stayed.length) return;
    await this.#reportSkipped(threadId, dir, stayed, { project, messageId, by: SkippedBy.Rewind });
  }

  /** The changed files, when every one was too large to save and the checkpoint could have been asked. */
  async #allTooLarge(threadId: string, dir: string, applied: AppliedRewind): Promise<string[]> {
    if (filesStay(applied.planned)) return [];
    const plan = await this.checkpoints.plan(dir, threadId, applied.planned.rewind.messageId);
    const tooLarge = plan.state === "unavailable" && plan.reason === FilesStay.TooLarge;
    return tooLarge ? (plan.tooLargeFiles ?? []) : [];
  }

  /** Files too large to save, with their sizes: noted for the lead, and a line in the chat. */
  async #reportSkipped(threadId: string, dir: string, files: readonly string[], report: SkippedReport): Promise<void> {
    const sized = await sizedFiles(dir, files);
    noteUnsaved(this.#x.unsavedFiles, threadId, sized);
    const listed = sized.slice(0, CHECKPOINT_SKIPPED_FILES_LISTED);
    const record = customEventData(CustomEvent.CheckpointSkipped, {
      ...report,
      files: listed,
      ...(sized.length > listed.length ? { total: sized.length } : {}),
      fileLimitBytes: CHECKPOINT_FILE_MAX_BYTES,
      changeLimitBytes: CHECKPOINT_CHANGE_MAX_BYTES,
    });
    await this.#core.append([record], threadId);
  }

  // ── the conversation as it reads ─────────────────────────────────────────────────────────
  /** A chat's rewinds, as its record indexes them. */
  async rewinds(threadId: string): Promise<ChatRewind[]> {
    return rewindsOf([], (await this.#core.store.getRecord(threadId).catch(() => null))?.metadata);
  }

  /**
   * A thread's log as the conversation reads after its rewinds, without the sessions a run
   * mirrored into it. Every harness version (and every file of it an agent edited) builds
   * prompts, replays its queue and picks a session from it.
   */
  async harnessView(threadId: string, events: EventEnvelope[]): Promise<EventEnvelope[]> {
    return harnessView(events, await this.rewinds(threadId));
  }

  /** The messages of a thread as the conversation reads after its rewinds. */
  async harnessMessages(threadId: string): Promise<Message[]> {
    const events = await this.harnessView(threadId, await this.#core.store.listEvents(threadId));
    return events.flatMap((event) => (event.data.type === EventKind.Messages ? event.data.messages : []));
  }

  // ── rewinding ────────────────────────────────────────────────────────────────────────────
  async #meta(threadId: string): Promise<RewindMeta> {
    return (await this.#core.store.getRecord(threadId)).metadata as RewindMeta;
  }

  /**
   * The rows from a user bubble on: enough to rewind to it. A message's queue record follows it
   * in the same batch, and everything a rewind withdraws comes after it.
   */
  async #rowsFrom(threadId: string, eventId: string): Promise<EventEnvelope[]> {
    if (!isUuid(eventId)) throw new Error(MESSAGE.NotInChat);
    const first = await this.#core.store.getEvent(threadId, eventId);
    if (!first) throw new Error(MESSAGE.NotInChat);
    return [first, ...(await this.#core.store.listEvents(threadId, { after: eventId }))];
  }

  /** The chat's own input on its way: a send, or a plan being written for one. */
  #chatSending(threadId: string): boolean {
    return (this.#sending.get(threadId) ?? 0) > 0 || this.#x.planReviews.busy(threadId);
  }

  /** Work in flight in this chat, or in its game's folder. */
  #chatBusy(threadId: string, project: string | null): boolean {
    const x = this.#x;
    return (
      this.#chatSending(threadId) ||
      Boolean(x.activeCompletions.get(threadId)?.size) ||
      x.pluginTurnLeases.has(threadId) ||
      [...x.openTurns.values()].some((turn) => turn.threadId === threadId) ||
      [...x.activeDelegations.values()].some(
        (work) => work.threadId === threadId || (project !== null && work.project === project),
      )
    );
  }

  /** The build running in this chat, as the conversation reads (a withdrawn one is not the chat's). */
  async #runningBuild(threadId: string): Promise<string | null> {
    const run = latestRun(await this.#core.store.chatState(threadId));
    return run?.state === RunState.Running && typeof run.runId === "string" ? run.runId : null;
  }

  /**
   * A rewind lands between answers, never under one: a running answer would outlive it. A running
   * build is no answer: the rewind stops it first, with whatever this chat's turns do for it
   * meanwhile (its lead, its coordinator, its workers). Returns that build.
   */
  async #assertRewindable(threadId: string, meta: RewindMeta): Promise<string | null> {
    if (meta?.kind !== ThreadKind.Game) throw new Error(MESSAGE.OnlyGameChat);
    if (this.#core.host.state !== HarnessState.Ready) throw new Error(MESSAGE.Restarting);
    const building = await this.#runningBuild(threadId);
    const answering = building ? this.#chatSending(threadId) : this.#chatBusy(threadId, meta.project ?? null);
    if (answering) throw new Error(rewindRefusalWords(RewindRefusal.Busy));
    return building;
  }

  /**
   * The plan for a rewind asked for while a build runs: what is answered under that build stops
   * with it, so only a message that is gone, or still waits, is refused before the Stop.
   */
  #planBeforeStop(
    rows: EventEnvelope[],
    rewinds: ChatRewind[],
    messageId: string,
    building: string | null,
  ): RewindPlan {
    const plan = planRewind(rows, rewinds, messageId);
    const settledByStop = building !== null && !plan.ok && plan.reason === RewindRefusal.Busy;
    if (!plan.ok && !settledByStop) throw new Error(rewindRefusalWords(plan.reason));
    return plan;
  }

  /**
   * The queued actions of the messages that stay after a rewind, oldest first. Reads the whole
   * log, so it is asked only when a withdrawn message changed something they may share.
   */
  async #remainingActions(threadId: string, rewinds: ChatRewind[]): Promise<RemainingAction[]> {
    const events = await this.#core.store.listEvents(threadId);
    const visible = new Set(withoutRewound(events, rewinds).map((event) => event.id));
    const remaining: RemainingAction[] = [];
    for (const message of messageQueueState(events).messages.values()) {
      if (!message.eventId || !visible.has(message.eventId) || message.state === "removed") continue;
      remaining.push({ eventId: message.eventId, action: actionOf(message) });
    }
    return remaining.sort((a, b) => a.eventId.localeCompare(b.eventId));
  }

  /** What rewinding to a message would do to the game's files, for the confirmation. */
  async preview(threadId: string, eventId: string, messageId: string): Promise<RewindPreview> {
    const meta = await this.#meta(threadId);
    const building = await this.#assertRewindable(threadId, meta);
    const rows = await this.#rowsFrom(threadId, eventId);
    const plan = this.#planBeforeStop(rows, rewindsOf([], meta), messageId, building);
    const stopsBuild = building !== null;
    if (!meta?.project) return { files: { state: "none" }, stopsBuild };
    // A refused plan got here only because the build's Stop will settle what it waits on.
    if (building || !plan.ok) return { files: unavailable(FilesStay.BuildRunning), stopsBuild };
    const stay = filesStay(plan);
    if (stay) return { files: unavailable(stay), stopsBuild };
    const dir = this.#core.games.dirFor(meta.project);
    await this.#core.assertProjectAllowed(dir);
    // Pictures the withdrawn messages saved are theirs, not changes made outside the chat.
    const ours = [...messageQueueState(rows).messages.values()].flatMap(
      (message) => actionOf(message).references ?? [],
    );
    const files = await this.checkpoints
      .plan(dir, threadId, plan.rewind.messageId, plan.answered, ours)
      .catch(() => unavailable(FilesStay.NoCheckpoint));
    return { files: afterBuilds(files, plan), stopsBuild };
  }

  /**
   * Rewind a game chat to just before one of its messages: it and everything after it leave the
   * conversation (the log keeps them), the provider sessions that remember them are dropped, and,
   * when asked, the game files go back to the checkpoint taken before that message was answered.
   * Returns what the composer needs to offer the message again.
   */
  async rewind(
    threadId: string,
    eventId: string,
    messageId: string,
    options: { files?: boolean } = {},
  ): Promise<RewindResult> {
    if (this.#rewinding.has(threadId)) throw new Error(MESSAGE.AlreadyRewinding);
    this.#rewinding.add(threadId);
    try {
      return await this.#rewindOnce(threadId, eventId, messageId, options.files === true);
    } finally {
      this.#rewinding.delete(threadId);
    }
  }

  async #rewindOnce(threadId: string, eventId: string, messageId: string, files: boolean): Promise<RewindResult> {
    const meta = await this.#meta(threadId);
    const building = await this.#assertRewindable(threadId, meta);
    const rewinds = rewindsOf([], meta);
    this.#planBeforeStop(await this.#rowsFrom(threadId, eventId), rewinds, messageId, building);
    const asked = { threadId, eventId, messageId, meta, rewinds, files };
    if (!building) return this.#rewindNow(asked, false);
    let rewound = false;
    try {
      await this.#stopBuild(threadId, meta?.project ?? null, building);
      const result = await this.#rewindNow(asked, true);
      rewound = true;
      return result;
    } finally {
      // The Stop held the queue for follow-ups that were to leave with the rewind. The rewind
      // failed, so they stay: what waits is answered as after any Stop.
      if (!rewound) await this.#resumeQueue(threadId).catch((err) => this.#log(MESSAGE.resumeFailed(threadId, err)));
    }
  }

  /** The rewind itself, once no build runs in the chat (`stopped`: the rewind stopped one). */
  async #rewindNow(asked: AskedRewind, stopped: boolean): Promise<RewindResult> {
    const { threadId, eventId, messageId, meta, rewinds, files } = asked;
    const first = plannedOrThrow(planRewind(await this.#rowsFrom(threadId, eventId), rewinds, messageId));
    await this.#holdFollowUps(threadId, first);
    const dir = meta?.project ? this.#core.games.dirFor(meta.project) : null;
    const target = first.rewind.messageId;
    let applied: AppliedRewind;
    try {
      const restore = files && !stopped && (await this.#restorable(threadId, dir, first));
      const request = { threadId, eventId, messageId: target, meta, rewinds, first, dir, files: restore };
      applied = await this.#apply(request);
    } catch (err) {
      // The hold paused the queue for follow-ups that were to leave with the rewind. It failed,
      // so they stay and are answered as usual (a rewind that stopped a build resumes it itself).
      if (first.held.length && !stopped)
        await this.#resumeQueue(threadId).catch((e) => this.#log(MESSAGE.resumeFailed(threadId, e)));
      throw err;
    }
    await this.#afterRewind(threadId, meta, applied, stopped);
    return rewindResult(first, target, applied.restored);
  }

  /**
   * Files come back only from a checkpoint nothing since has made unsafe (the preview's rule), and
   * only one that was taken: without it the chat alone goes back.
   */
  async #restorable(threadId: string, dir: string | null, first: PlannedRewind): Promise<boolean> {
    if (!dir || filesStay(first)) return false;
    return this.checkpoints.has(dir, threadId, first.rewind.messageId);
  }

  /**
   * Stop the chat's build as its Stop does, except that the queue stays held: what waits there
   * was sent after the message and comes back to the composer. Then wait for the build to close,
   * so its close is part of the log the rewind reads (and stays: the build began before it).
   */
  async #stopBuild(threadId: string, project: string | null, runId: string): Promise<void> {
    await this.#core.stopThread(threadId, { resumeQueue: false });
    // The run's own Stop too: it reaches a run whose loop died under it.
    if (this.#core.host.hasCapability(HarnessCapability.RunStop)) {
      await this.#core.host.dispatch({ type: DispatchActionType.RunStop, runId }).catch(() => {});
    }
    const clock = this.#core.options.rewindBuildStop ?? {};
    const now = clock.now ?? Date.now;
    const wait = clock.sleep ?? sleep;
    const deadline = now() + (clock.timeoutMs ?? REWIND_BUILD_STOP_WAIT_MS);
    while (await this.#stillStopping(threadId, project, runId)) {
      if (now() >= deadline) throw new Error(MESSAGE.BuildStillStopping);
      await wait(REWIND_BUILD_STOP_POLL_MS);
    }
  }

  /** The chat's queue answers what waits in it again (a rewind's Stop held it). */
  async #resumeQueue(threadId: string): Promise<void> {
    if (!this.#core.host.hasCapability(HarnessCapability.MessageQueue)) return;
    await this.#core.host.dispatch({ type: DispatchActionType.QueueResume, threadId });
  }

  /**
   * The build is still closing: running in the log, held by the harness, its work still in flight,
   * or its jobs not yet ended (so their ends are in the log the rewind reads, and leave with it).
   */
  async #stillStopping(threadId: string, project: string | null, runId: string): Promise<boolean> {
    const runClosing = this.#x.activeRunIds.has(runId) || this.#x.runJobStops.has(runId);
    if (runClosing || this.#chatBusy(threadId, project)) return true;
    return (await this.#runningBuild(threadId)) !== null;
  }

  /**
   * Follow-ups still waiting (after a Stop or a hold) were sent after this message and leave
   * with it. Holding the queue first keeps any of them from starting meanwhile.
   */
  async #holdFollowUps(threadId: string, first: PlannedRewind): Promise<void> {
    const [oldest] = first.held;
    if (!oldest) return;
    if (!this.#core.host.hasCapability(HarnessCapability.MessageQueue)) throw new Error(MESSAGE.HeldNeedsQueue);
    await this.#queueMessage(threadId, oldest.messageId, "hold");
  }

  #queueMessage(threadId: string, messageId: string, operation: "hold" | "remove"): Promise<unknown> {
    return this.#core.host.dispatch({ type: DispatchActionType.QueueMessage, threadId, messageId, operation });
  }

  /**
   * Files first, then the conversation. Nothing half-done: a failure puts the files back. The files
   * change between the game's plugins' restore steps (an editor saved and closed before, opened
   * after), the person's own: they never wait for the person or the plan, and a step's block keeps
   * the files and fails the rewind with its reason.
   */
  async #apply(request: RewindRequest): Promise<AppliedRewind> {
    const project = request.meta?.project;
    if (!(request.files && request.dir && project)) return this.#applyFiles(request);
    return this.#x.hooks.restoreWithHooks(project, () => this.#applyFiles(request), {
      forPerson: true,
      threadId: request.threadId,
    });
  }

  async #applyFiles(request: RewindRequest): Promise<AppliedRewind> {
    const { dir } = request;
    let restored: RestoredFiles | null = null;
    try {
      // Files first: when they cannot come back, nothing else has changed.
      if (request.files && dir) {
        await this.#core.assertProjectAllowed(dir);
        restored = await this.checkpoints.restore(dir, request.threadId, request.messageId);
      }
      return await this.#withdraw(request, restored);
    } catch (err) {
      // Files that came back go back to how the rewind found them.
      if (restored && dir) {
        await this.checkpoints.putBack(dir, restored.saved).catch((e) => this.#log(MESSAGE.putBackFailed(e)));
      }
      throw err;
    }
  }

  /** Withdraw the message and what came after it: planned again, now that the files are back. */
  async #withdraw(request: RewindRequest, restored: RestoredFiles | null): Promise<AppliedRewind> {
    const { threadId, eventId, messageId, rewinds, first, dir } = request;
    const rows = await this.#rowsFrom(threadId, eventId);
    const planned = plannedOrThrow(planRewind(rows, rewinds, messageId));
    // What the withdrawn messages brought into the chat's own state leaves with them.
    const withdrawn = withdrawnActions(rows, eventId);
    const remaining = withdrawn.some(sharesState)
      ? await this.#remainingActions(threadId, [...rewinds, planned.rewind])
      : [];
    const removed = restored && dir ? await removeWithdrawnReferences(dir, withdrawn, remaining) : 0;
    for (const held of first.held) await this.#queueMessage(threadId, held.messageId, "remove");
    await this.#recordRewind(request, planned, withdrawn, remaining);
    return {
      planned,
      withdrawn,
      remaining,
      restored: restored ? { ...restored, files: restored.files + removed } : null,
    };
  }

  /**
   * The rewind takes effect here: every reader of the chat applies the thread's index. The record
   * is written before its event, so a failure after the write still counts as done.
   */
  async #recordRewind(
    { threadId, meta, rewinds }: RewindRequest,
    planned: PlannedRewind,
    withdrawn: readonly RewoundAction[],
    remaining: readonly RemainingAction[],
  ): Promise<void> {
    const reviewLeaves = meta?.planReview && planned.reviews.includes(meta.planReview.id);
    const readsLeave = withdrawn.some((action) => action.extraReads?.length);
    const metadata = {
      rewinds: [...rewinds, planned.rewind],
      // A resumed session keeps its id and remembers the rewound turns; the next turn starts fresh.
      contractor: null,
      ...(reviewLeaves ? { planReview: null } : {}),
      ...(readsLeave
        ? {
            extraReads: readsAfterRewind(
              meta?.extraReads,
              remaining.map((entry) => entry.action),
            ),
          }
        : {}),
    };
    await this.#core.store.updateThread(threadId, { metadata }).catch(async (err: unknown) => {
      const written = (await this.rewinds(threadId)).some(
        (rewind) => rewind.from === planned.rewind.from && rewind.through === planned.rewind.through,
      );
      if (!written) throw err;
    });
  }

  /** The chat is rewound. What follows tidies up after it and never undoes it. */
  async #afterRewind(threadId: string, meta: RewindMeta, applied: AppliedRewind, stopped: boolean): Promise<void> {
    const tidy = (what: string, work: () => Promise<unknown>) =>
      work().then(
        () => {},
        (err: unknown) => this.#log(MESSAGE.tidyFailed(threadId, what, err)),
      );
    await tidy("clearing coordinator sessions", () => this.#clearCoordinatorSessions(threadId));
    const marker = customEventData(CustomEvent.ConversationRewound, {
      ...applied.planned.rewind,
      files: applied.restored?.files ?? null,
    });
    await tidy("recording the rewind", () => this.#core.append([marker], threadId));
    if (meta?.project) {
      const project = meta.project;
      await tidy("reporting files too large to put back", () => this.#reportLeftTooLarge(threadId, project, applied));
    }
    // Rebuilt now, so the chat reloading after the marker gets it at once.
    await tidy("rebuilding the chat state", () => this.#core.store.chatState(threadId));
    // The harness keeps the Loop mood board the remaining messages gave it (best effort: the
    // rewind itself never waits on the harness for long).
    if (this.#core.host.hasCapability(HarnessCapability.Rewind)) {
      await tidy("telling the harness", () => this.#tellHarness(threadId, applied));
    }
    // The build's Stop held the queue: what was sent before the message is answered again as usual.
    if (stopped) await tidy("resuming the queue", () => this.#resumeQueue(threadId));
    const project = meta?.project ?? null;
    // The files went back; Live keeps what it shows until the person reloads it (`live.behind`).
    if (applied.restored && project) {
      void this.#x.previews.offerLive({ project, root: null }).catch(() => {});
      this.#core.emit(UiEvent.GameChanged, { project });
    }
    this.#core.emit(UiEvent.ThreadUpdated, { threadId, project });
    this.#core.emit(UiEvent.ThreadRewound, { threadId });
  }

  /** A run coordinator's saved session remembers the withdrawn turns: the next one starts fresh. */
  async #clearCoordinatorSessions(threadId: string): Promise<void> {
    const store = this.#core.store;
    for (const artifact of await listDirs(store.artifactsDir(threadId)).catch(() => [] as string[])) {
      if (!artifact.startsWith(COORDINATOR_ARTIFACT_PREFIX)) continue;
      const prior = await store
        .readArtifact<{ sessionId?: string | null; engine?: string }>(threadId, artifact)
        .catch(() => null);
      if (prior?.sessionId) await store.writeArtifact(threadId, artifact, { ...prior, sessionId: null });
    }
  }

  async #tellHarness(threadId: string, applied: AppliedRewind): Promise<void> {
    const boardChanged = applied.withdrawn.some((action) => action.autopilot);
    const board = boardChanged ? { frames: await this.#latestBoard(threadId, applied.remaining) } : {};
    await this.#core.host.dispatch({ type: DispatchActionType.Rewind, threadId, ...board }, REWIND_NOTICE_TIMEOUT_MS);
  }

  /** The mood board the Loop interview still has: the latest remaining one, unless a run took it. */
  async #latestBoard(threadId: string, remaining: readonly RemainingAction[]): Promise<ReferenceFrame[] | null> {
    const runStarts = new Set<string>([CustomEvent.RunRegistered, CustomEvent.RunStarted]);
    const lastRun = (await this.#core.store.chatState(threadId))
      .filter((event) => runStarts.has(customRecord(event.data)?.event_type ?? ""))
      .reduce((latest, event) => (event.id > latest ? event.id : latest), "");
    for (const entry of [...remaining].reverse()) {
      const artifact = entry.action.attachmentsArtifact;
      if (!entry.action.autopilot || !artifact) continue;
      if (entry.eventId < lastRun) return null;
      const saved = await this.#core.store
        .readArtifact<{ frames?: ReferenceFrame[] }>(threadId, artifact)
        .catch(() => null);
      if (saved?.frames?.length) return saved.frames;
    }
    return null;
  }
}
