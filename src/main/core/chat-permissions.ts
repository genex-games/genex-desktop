/**
 * Permissions in a game chat, the host's half: which delegation a person is answering, the mode it
 * runs in (the chat's own, as far as its engine honours it: `engineMode`), the Allow / Deny questions it asks (recorded in the chat as
 * `tool_permission` rows and waited on in the ledger), what "always" keeps, and the picker's reach
 * into a running session. Composed by `StudioCore`; reached through `CoreInternals.permissions`.
 *
 * Who asks is decided here from what the host recorded itself, never from what the harness says:
 * the message the person sent on this thread (`notePersonMessage`, from the composer's send), the
 * thread's own metadata, and the shape of the brief (`DelegationService`). A harness that forges
 * any of it can only make a session ask the person, in the mode the person chose.
 *
 * A build's lead and the run's coordinator ask too (`forLead`): they are the chat's main agent, so
 * only the chat's mode and the rules the person saved limit them, as the chat's own session. Each
 * runs in the chat's Auto, Accept edits or Bypass (Claude Code then acts as for the chat's own
 * session), or in Manual, the host answering each question for the chat's mode: Plan denies, and
 * anything else is a card, whether or not the person is talking to it, withdrawn when nobody
 * answers within `LEAD_ASK_TIMEOUT_MS`. The picker switches a running lead as it switches the chat's
 * own session, beside it on the same chat (`#live`); while the chat is in a mode a lead could not
 * be switched to, its screen asks first (`#screenLeadCall`), so the chat's mode answers.
 */
import { readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { CustomEvent, customEventData, customRecord, type AnyCustomPayload } from "../../shared/custom-events.ts";
import { MINUTE_MS } from "../../shared/duration.ts";
import { EventKind, ThreadKind } from "../../shared/event-log.ts";
import { SteerDelivery } from "../../shared/message-queue.ts";
import {
  engineMode,
  GrantKind,
  isPermissionMode,
  isSteadyPermissionMode,
  ModeSwitchFailure,
  PERMISSION_MODE_WORDS,
  PermissionDecision,
  PermissionGranted,
  type PermissionGrant,
  PermissionMode,
  type PermissionSettingsView,
  PLAN_TOOL,
  RuleScope,
  type ToolPermissionAnswer,
  ToolPermissionBy,
  type ToolPermissionEvent,
  ToolPermissionState,
} from "../../shared/permissions.ts";
import { EngineId } from "../../shared/providers.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import type {
  AskFirst,
  DelegateAsks,
  DelegatePermissions,
  LeadAsks,
  PermissionAsk,
  PermissionControl,
  PermissionReply,
  ScreenedCall,
  WithdrawnAnswer,
} from "../../substrate/engines/types.ts";
import { shortId } from "../../substrate/ids.ts";
import { isInside } from "../../substrate/paths.ts";
import type { EventData } from "../../substrate/types.ts";
import { PermissionStore } from "../permission-store.ts";
import type { StudioCore } from "../studio-core.ts";
import { ToolPermissions, type WithdrawnBy } from "../tool-permissions.ts";
import { permissionAnswer, permissionRequest } from "./permission-requests.ts";

/** The permission store's file, under engine-homes. */
const STORE_FILE = "permissions.json";
/**
 * How long a build's lead's or the run's coordinator's card waits for the person. A card nobody
 * sees must not hold a run's lead; the person can say it again.
 */
export const LEAD_ASK_TIMEOUT_MS = 5 * MINUTE_MS;
/** How many of a chat's messages the host remembers as the person's. */
const PERSON_MESSAGES_PER_CHAT = 64;
/** How deep the walk of the studio's own data folder opens folders that hold the games. */
const HOST_FILES_DEPTH = 4;
/** The queue's records that end a message: it was answered, or taken back. */
const MESSAGE_ENDS: ReadonlySet<unknown> = new Set([
  CustomEvent.CoordinatorMessageHandled,
  CustomEvent.CoordinatorMessageRemoved,
]);
/** The queue's records that leave a message waiting for a turn of its own: queued, or put back. */
const MESSAGE_WAITS: ReadonlySet<unknown> = new Set([
  CustomEvent.CoordinatorMessageQueued,
  CustomEvent.CoordinatorMessageRequeued,
]);
/** The queue's records that start an answer: its own turn, or joining (or read by) a running one. */
const MESSAGE_STARTS: ReadonlySet<unknown> = new Set([
  CustomEvent.CoordinatorMessageProcessing,
  CustomEvent.CoordinatorMessageSteering,
  CustomEvent.CoordinatorMessageDelivered,
]);

/** What the chat, Claude and the log read. */
const MESSAGE = {
  /** What Claude reads when the work ended around its request: a deny, never an error. */
  withdrawnStop: "The user stopped this work before answering.",
  withdrawnTurn: "The turn ended before the user answered.",
  withdrawnTimeout: `Nobody answered within ${LEAD_ASK_TIMEOUT_MS / MINUTE_MS} minutes, so this was not allowed. Do not retry it; say in your reply what you needed.`,
  /** What a build's lead or the run's coordinator reads when its chat was closed (archived, moved). */
  chatClosed:
    "This chat was closed, so nobody can approve this and it was not allowed. Do not retry it; say in your reply what you needed.",
  inPlan:
    "The chat is in Plan mode, so this was not allowed: a build is already approved work. Do not retry it; ask the person in your reply to switch the mode.",
  /** Why a lead started in Auto or Accept edits asks, once its chat has left that mode. */
  leftMode: (from: string, to: string) => `The chat switched from ${from} to ${to}.`,
  unknownMode: "Unknown permission mode.",
  notGameChat: "Permission modes are set for a game chat.",
  invalidAnswer: "Invalid permission answer",
  invalidRule: "Invalid permission rule",
  notSwitched: (label: string) => `The running reply could not switch to ${label}. Your next message will use it.`,
  grantNotSaved: (error: unknown) => `Could not save a permission grant: ${String(error)}`,
} as const;

/** A chat's running session, as the host follows it: its engine and model, and whether the host moved its mode. */
interface ChatSession {
  engine: string;
  model: string;
  steered: boolean;
}

/**
 * A build's lead or the run's coordinator, as the host follows it: the mode its session runs in,
 * where it started until the picker switches it (`#switchLead`), the switch still on its way, and
 * the calls its screen asked about first (by `toolUseId`) whose question has not reached the host
 * yet: the host's own questions, which the chat's mode answers whatever the session runs in by then.
 */
interface LeadState extends ChatSession {
  running: LeadAsks["mode"];
  switching: Promise<void>;
  askedFirst: Set<string>;
}

/** How many of a lead's asked-first calls the host remembers: a call denied before its question is never asked. */
const ASKED_FIRST_KEPT = 64;

/** A running session the picker reaches: the chat's own, a build's lead or the run's coordinator. */
interface LiveSession {
  /** A lead's or the coordinator's: an answer that moves the chat's mode switches it too. */
  lead: boolean;
  /** Switch it for the chat's new mode; resolves with the failure the picker shows, or null. */
  switchTo(mode: PermissionMode): Promise<Error | null>;
}

/** The session a holder handed the picker, if it still takes control requests. */
type LiveHolder = { live: LiveSession | null };

/** What "always" granted for one conversation only: rules and folders, gone when the app quits. */
interface ChatGrants {
  rules: Set<string>;
  dirs: Set<string>;
}

/** A thread's metadata, as far as permissions read it. */
type PermissionMeta =
  | { kind?: string; project?: unknown; archived?: unknown; permissionMode?: unknown; extraReads?: unknown }
  | undefined;

/** A message the person sent, as the host follows it until it is answered. */
interface PersonNote {
  /** The queue says it still waits for a turn of its own. */
  waiting: boolean;
  /** The build's lead it was handed to (the queue's delivery `how: lead`), and when; null otherwise. */
  lead: { runId: string; at: number } | null;
}

/** Whom a build's lead or the run's coordinator answers: its run's handed messages, or one message. */
export type LeadAnswers = { runId: string } | { messageId: string };

/** A build's lead or the run's coordinator the person may talk to in its game's chat. */
export interface LeadSessionAsk {
  project: string;
  threadId: string;
  answers: LeadAnswers;
  engine: string;
  model: string;
  /** The folder it works in: the game's (a lead) or its own home (the coordinator). */
  cwd: string;
  /** A lead's: the integration worktree it leads, as its seat checked it (real path). It builds there. */
  leads?: string;
  signal: AbortSignal;
}

/** A delegation that may be the person's: who asks, where, and on what. */
export interface PersonSessionAsk {
  project: string;
  /** The thread as the brief named it. */
  threadId: string;
  /** The message this session answers (`chatTurn`), which must be one the person sent here. */
  messageId: string;
  /** The engine it runs on, whose modes it honours (`permissionModesFor`). */
  engine: string;
  model: string;
  /** The folder the session works in: the game's own. */
  cwd: string;
  signal: AbortSignal;
}

/** A session a person answers: what its engine is handed, and its end. */
export interface PersonSession {
  request: DelegatePermissions;
  /** The session is over: the picker has nothing to switch. */
  end(): void;
}

/**
 * The folders a session works in, spelled as the walk of the studio's data folder meets them: a
 * lead's worktree is its seat's checked real path, and the data folder may be reached through a
 * link (macOS's /var → /private/var), so one under the real data folder is named under `root`.
 */
async function asWalked(root: string, folders: readonly string[]): Promise<string[]> {
  const real = await realpath(root).catch(() => root);
  return folders.map((folder) => {
    const resolved = path.resolve(folder);
    if (real === root || isInside(root, resolved) || !isInside(real, resolved)) return resolved;
    return path.join(root, path.relative(real, resolved));
  });
}

/** A build's lead's or the run's coordinator's session: what its engine is handed, and its end. */
export interface LeadSession {
  request: LeadAsks;
  /** The session is over: the picker has nothing to switch. */
  end(): void;
}

/** A deny in the host's own words, which Claude reads as they are. */
function hostDeny(message: string): WithdrawnAnswer {
  return { decision: PermissionDecision.Deny, withdrawn: true, message };
}

/** The host's words for a wait that ended without the person's answer, by what ended it. */
const WITHDRAWN_WORDS: Partial<Record<string, string>> = {
  [ToolPermissionBy.Turn]: MESSAGE.withdrawnTurn,
  [ToolPermissionBy.Timeout]: MESSAGE.withdrawnTimeout,
};

/** What a withdrawn wait answers with. */
function withdrawnAnswer(by: string): WithdrawnAnswer {
  return hostDeny(WITHDRAWN_WORDS[by] ?? MESSAGE.withdrawnStop);
}

/** This game's own chat, open: never a thread the harness made, another game's chat or an archived one. */
function isOpenGameChat(meta: PermissionMeta, project: string): boolean {
  return meta?.kind === ThreadKind.Game && meta.project === project && meta.archived !== true;
}

/** The modes a build's lead or the run's coordinator starts in as its chat has them. */
const LEAD_OWN_MODES: ReadonlySet<PermissionMode> = new Set([
  PermissionMode.Auto,
  PermissionMode.AcceptEdits,
  PermissionMode.Bypass,
]);

/**
 * The mode a build's lead's or the run's coordinator's session runs in for its chat's mode: Auto,
 * Accept edits and Bypass as they are, so Claude Code acts as it does for the chat's own session;
 * Manual for Manual and Plan, the host answering each question for the chat's mode (`#leadAsk`).
 */
function leadModeFor(mode: PermissionMode): LeadAsks["mode"] {
  return isLeadOwnMode(mode) ? mode : PermissionMode.Manual;
}

/** Whether a lead starts in this mode as its chat has it. */
function isLeadOwnMode(mode: PermissionMode): mode is LeadAsks["mode"] {
  return LEAD_OWN_MODES.has(mode);
}

/**
 * Whether a session running in `running` asks first while its chat is in `now`: whenever the chat
 * is in another mode (a switch that failed, or one still on its way), so the chat's mode answers,
 * except Accept edits in an Auto chat, where its edits going on and its questions carded is closer
 * to Auto than a card for every call. A session in Manual asks anyway.
 */
function asksFirst(running: LeadAsks["mode"], now: PermissionMode): boolean {
  if (running === PermissionMode.Manual || now === running) return false;
  return !(running === PermissionMode.AcceptEdits && now === PermissionMode.Auto);
}

/** Who a queue record hands a message to: a build's lead (`how: lead`, into its run), or nobody. */
function handedTo(eventType: string, payload: AnyCustomPayload): PersonNote["lead"] {
  const toLead = eventType === CustomEvent.CoordinatorMessageDelivered && payload.how === SteerDelivery.Lead;
  return toLead && typeof payload.into === "string" ? { runId: payload.into, at: Date.now() } : null;
}

/** How a settled request reads in the log. */
function settledRow(
  base: Omit<ToolPermissionEvent, "state">,
  answer: ToolPermissionAnswer | null,
  by: ToolPermissionEvent["by"],
): ToolPermissionEvent {
  const allowed = answer !== null && answer.decision !== PermissionDecision.Deny;
  const granted = answer?.decision === PermissionDecision.Always ? PermissionGranted.Always : PermissionGranted.Once;
  return {
    ...base,
    state: allowed ? ToolPermissionState.Allowed : ToolPermissionState.Denied,
    by,
    ...(allowed ? { granted } : {}),
    ...(answer?.decision === PermissionDecision.ApprovePlan ? { mode: answer.mode } : {}),
    ...(answer?.decision === PermissionDecision.Deny && answer.message ? { message: answer.message } : {}),
  };
}

/** The mode this answer moves the chat to (a plan approval, or "always" with a mode in it), or null. */
function movedTo(answer: ToolPermissionAnswer | null, always: PermissionGrant[] | undefined): PermissionMode | null {
  if (answer?.decision === PermissionDecision.ApprovePlan) return answer.mode;
  if (answer?.decision !== PermissionDecision.Always) return null;
  for (const grant of always ?? [])
    if (grant.kind === GrantKind.Mode && isPermissionMode(grant.mode)) return grant.mode;
  return null;
}

export class ChatPermissionService {
  readonly #core: StudioCore;
  /** Tool calls a game chat's Claude session is waiting on the person for (`tool_permission` cards). */
  readonly #ledger = new ToolPermissions();
  #store: PermissionStore | null = null;
  readonly #chatGrants = new Map<string, ChatGrants>();
  /**
   * Each chat's running sessions whose mode the picker can switch mid-turn: its own, and a build's
   * lead or the run's coordinator beside it on the same chat.
   */
  readonly #live = new Map<string, Set<LiveSession>>();
  /** Models whose sessions could not start in Auto ('' is the account's default model). */
  readonly #autoUnavailable = new Set<string>();
  /** The messages the person sent, by thread, that a session may still be answering, in the order sent. */
  readonly #personMessages = new Map<string, Map<string, PersonNote>>();

  constructor(core: StudioCore) {
    this.#core = core;
  }

  /** The mode new chats start in and each game's "always allow" rules; host-only, under engine-homes. */
  get store(): PermissionStore {
    this.#store ??= new PermissionStore(path.join(this.#core.layout.engineHomes, STORE_FILE));
    return this.#store;
  }

  /** Withdraw the waiting questions in scope (`{}` is every one). */
  cancel(scope: { project?: string; threadId?: string }, by: WithdrawnBy): void {
    this.#ledger.cancel(scope, by);
  }

  // ── whose message a session answers ────────────────────────────────────────────────────────

  /** The composer sent this message on this thread: a session answering it answers the person. */
  notePersonMessage(threadId: string, messageId: string | undefined): void {
    if (!messageId) return;
    const known = this.#personMessages.get(threadId) ?? new Map<string, PersonNote>();
    known.delete(messageId);
    // Not known to wait until the queue records it: a Stop before then ends it.
    known.set(messageId, { waiting: false, lead: null });
    for (const oldest of [...known.keys()].slice(0, Math.max(0, known.size - PERSON_MESSAGES_PER_CHAT)))
      known.delete(oldest);
    this.#personMessages.set(threadId, known);
  }

  /**
   * Follow the queue's records for the person's messages: one answered or taken back is nobody's
   * to answer any more, whether one still waits for a turn of its own decides what a Stop ends, and
   * one handed to a build's lead is the lead's until it heard it (`run_steering_delivered`) or the
   * queue took it back.
   */
  followQueueRecords(threadId: string, batch: readonly EventData[]): void {
    for (const data of batch) {
      const custom = data.type === EventKind.Custom ? customRecord(data) : null;
      if (custom) this.#followRecord(threadId, custom.event_type, custom.payload);
    }
  }

  #followRecord(threadId: string, eventType: string, payload: AnyCustomPayload): void {
    const heard = eventType === CustomEvent.RunSteeringDelivered && payload.how === SteerDelivery.Lead;
    if (heard && typeof payload.sourceMessageId === "string") this.#forgetMessage(threadId, payload.sourceMessageId);
    const { messageId } = payload;
    if (typeof messageId !== "string") return;
    if (MESSAGE_ENDS.has(eventType)) this.#forgetMessage(threadId, messageId);
    else if (MESSAGE_WAITS.has(eventType)) this.#markNote(threadId, messageId, { waiting: true, lead: null });
    else if (MESSAGE_STARTS.has(eventType))
      this.#markNote(threadId, messageId, { waiting: false, lead: handedTo(eventType, payload) });
  }

  /**
   * Stop ends what the chat was answering (and what joined it), never a message still waiting in
   * the queue: the queue answers that one after the Stop, and it is still the person's.
   */
  stopPersonMessages(threadId: string): void {
    const known = this.#personMessages.get(threadId);
    if (!known) return;
    for (const [messageId, note] of known) if (!note.waiting) known.delete(messageId);
    if (!known.size) this.#personMessages.delete(threadId);
  }

  /**
   * Whether this is a message the person sent on this thread that is still unanswered (noted from
   * the composer's send, not yet handled, removed or stopped): what the host asks before it lets a
   * harness's show or land change Live.
   */
  awaitsAnswer(threadId: string, messageId: string): boolean {
    return this.#personMessages.get(threadId)?.has(messageId) === true;
  }

  #markNote(threadId: string, messageId: string, note: PersonNote): void {
    const known = this.#personMessages.get(threadId);
    if (known?.has(messageId)) known.set(messageId, note);
  }

  #forgetMessage(threadId: string, messageId: string): void {
    const known = this.#personMessages.get(threadId);
    known?.delete(messageId);
    if (known && !known.size) this.#personMessages.delete(threadId);
  }

  // ── the session ──────────────────────────────────────────────────────────────────────────

  /**
   * The permissions of a session the person is answering, or null. The caller has already checked
   * the brief's shape; this checks what the host recorded: the message is one the person sent on
   * this thread, and the thread is this game's own open chat (a thread the harness made, another
   * game's chat or an archived one never asks).
   */
  async forSession(ask: PersonSessionAsk): Promise<PersonSession | null> {
    const { project, threadId } = ask;
    // A message handed to a build's lead is the lead's to answer (`forLead`), never the chat's own.
    if (this.#personMessages.get(threadId)?.get(ask.messageId)?.lead !== null) return null;
    const meta = await this.#threadMeta(threadId);
    if (!isOpenGameChat(meta, project)) return null;
    // The chat's mode as its engine honours it: one it does not runs in Auto, its own contract.
    const mode = engineMode(ask.engine, await this.#modeOf(threadId, meta));
    // Set once the studio itself moves the running mode (the picker, a plan approval, "allow all
    // edits"), after which a reported mode says nothing about whether Auto is available.
    const session: ChatSession = { engine: ask.engine, model: ask.model, steered: false };
    const holder: LiveHolder = { live: null };
    const request: DelegatePermissions = {
      mode,
      ...(await this.#standing(project, threadId, [ask.cwd])),
      ask: (question, asked) => this.#ask(project, threadId, question, AbortSignal.any([asked, ask.signal]), session),
      onMode: (reported) => this.#onMode(threadId, mode, session, reported),
      onControl: (control) => this.#onControl(threadId, mode, session, holder, control),
    };
    return { request, end: () => this.#onControl(threadId, mode, session, holder, null) };
  }

  /**
   * How a build's lead or the run's coordinator asks in its game's own open chat, or null for any
   * other thread. The caller has already checked the seat (this game's lead of this chat's run, or
   * the coordinator of that run). Each call is screened here (`#screenLeadCall`) and each question
   * routed here (`#leadAsk`), never by the harness.
   */
  async forLead(ask: LeadSessionAsk): Promise<LeadSession | null> {
    const { project, threadId, answers } = ask;
    // The coordinator's seat is a message the host noted as the person's and not yet answered, as
    // the chat's own session's: a harness cannot start one for a message nobody sent.
    if ("messageId" in answers && !this.awaitsAnswer(threadId, answers.messageId)) return null;
    const meta = await this.#threadMeta(threadId);
    if (!isOpenGameChat(meta, project)) return null;
    // Only the picker moves its mode, so what it reports says nothing about Auto for its model.
    const lead: LeadState = {
      engine: ask.engine,
      model: ask.model,
      steered: true,
      running: leadModeFor(await this.#modeOf(threadId, meta)),
      switching: Promise.resolve(),
      askedFirst: new Set(),
    };
    const holder: LiveHolder = { live: null };
    const request: LeadAsks = {
      ...(await this.#standing(project, threadId, [ask.cwd, ...(ask.leads ? [ask.leads] : [])])),
      mode: lead.running,
      screen: (call) => this.#screenLeadCall(ask, lead, call),
      ask: (question, asked) => this.#leadAsk(ask, lead, question, AbortSignal.any([asked, ask.signal])),
      onControl: (control) => this.#onLeadControl(threadId, lead, holder, control),
    };
    return { request, end: () => this.#onLeadControl(threadId, lead, holder, null) };
  }

  /**
   * What a session that asks stands on: the saved "always allow" rules for the game and the chat,
   * the chat's granted folders, and the studio's own files it never edits — all but the folders it
   * works in (`open`): its cwd, and for a lead the integration worktree it builds in.
   */
  async #standing(project: string, threadId: string, open: string[]): Promise<Omit<DelegateAsks, "ask">> {
    const grants = this.#chatGrants.get(threadId);
    return {
      allow: [...new Set([...(await this.store.rules(project)), ...(grants?.rules ?? [])])],
      directories: [...(grants?.dirs ?? [])],
      // The permission store by name as well: on a fresh install it does not exist yet when the
      // engine lists what to fence, and it is created during the session.
      protectWrites: [...(await this.#hostFiles(open)), this.store.file],
    };
  }

  /**
   * The screen as the lead's session runs it, ahead of each call but a read or the studio's own
   * (`LeadAsks.screen`, a PreToolUse hook): for a session running in Auto, Accept edits or Bypass
   * while its chat is in a mode the picker could not switch it to (or not yet), a question first
   * (`asksFirst`), so the chat's mode answers it (`#leadAsk`) rather than the mode the session runs
   * in. Anything else is left to the session's rules and mode, as for the chat's own session.
   */
  async #screenLeadCall(ask: LeadSessionAsk, lead: LeadState, call: ScreenedCall): Promise<AskFirst | null> {
    const { running } = lead;
    if (running === PermissionMode.Manual) return null;
    const mode = await this.#modeOf(ask.threadId, await this.#threadMeta(ask.threadId));
    if (!asksFirst(running, mode)) return null;
    if (call.toolUseId) {
      lead.askedFirst.add(call.toolUseId);
      for (const oldest of [...lead.askedFirst].slice(0, Math.max(0, lead.askedFirst.size - ASKED_FIRST_KEPT)))
        lead.askedFirst.delete(oldest);
    }
    const [from, to] = [PERMISSION_MODE_WORDS[running].label, PERMISSION_MODE_WORDS[mode].label];
    return { askFirst: true, reason: MESSAGE.leftMode(from, to) };
  }

  /**
   * A lead's or coordinator's question, as the chat's mode answers it, whether or not the person is
   * talking to it: Bypass allows one running in another mode, or a call the host asked about first
   * (a switch to Bypass may land before its question arrives), Plan denies (a build is approved
   * work), and anything else is a card that "always" can keep, withdrawn if nobody answers within
   * `LEAD_ASK_TIMEOUT_MS`. A session running in Bypass asks on its own only what Claude Code asks in
   * any mode (a dangerous `rm`), which is carded, as for the chat's own session. A chat archived or
   * moved since has nobody to show a card to, and is denied at once.
   */
  async #leadAsk(
    seat: LeadSessionAsk,
    lead: LeadState,
    ask: PermissionAsk,
    signal: AbortSignal,
  ): Promise<PermissionReply> {
    const { project, threadId } = seat;
    const meta = await this.#threadMeta(threadId);
    if (!isOpenGameChat(meta, project)) return hostDeny(MESSAGE.chatClosed);
    const mode = await this.#modeOf(threadId, meta);
    const hostAsked = lead.askedFirst.delete(ask.toolUseId);
    if (mode === PermissionMode.Bypass && (hostAsked || lead.running !== PermissionMode.Bypass))
      return { decision: PermissionDecision.Allow };
    if (mode === PermissionMode.Plan) return hostDeny(MESSAGE.inPlan);
    // Its mode is never its own to change: no "always" moves it.
    const always = ask.always.filter((grant) => grant.kind !== GrantKind.Mode);
    const timeoutMs = this.#core.options.leadAskTimeoutMs ?? LEAD_ASK_TIMEOUT_MS;
    return this.#ask(project, threadId, { ...ask, always }, signal, lead, { timeoutMs });
  }

  /**
   * Whether a game chat is in Plan mode. Plan is for planning: nothing outside the chat — no plugin
   * or connector action, whoever asks for it — runs on the chat's behalf until the plan is approved.
   */
  async planning(threadId: string): Promise<boolean> {
    return (await this.#threadMeta(threadId))?.permissionMode === PermissionMode.Plan;
  }

  /** A chat keeps the mode it first ran in; one that never chose is stamped with the default now. */
  async #modeOf(threadId: string, meta: PermissionMeta): Promise<PermissionMode> {
    const chosen = meta?.permissionMode;
    if (isPermissionMode(chosen)) return chosen;
    const mode = await this.store.defaultMode();
    await this.#core.store.updateThread(threadId, { metadata: { permissionMode: mode } }).catch(() => {});
    return mode;
  }

  /**
   * A session launched in Auto reports whether it runs in it: at start, and again when the CLI
   * settles its gate a moment later. Unless the studio moved the mode itself, that says whether
   * Auto is available for this model.
   */
  #onMode(threadId: string, mode: PermissionMode, session: ChatSession, reported: string): void {
    if (mode !== PermissionMode.Auto || session.steered || !reported) return;
    const running = reported === PermissionMode.Auto;
    const changed = running ? this.#autoUnavailable.delete(session.model) : !this.#autoUnavailable.has(session.model);
    if (!running) this.#autoUnavailable.add(session.model);
    if (changed) this.#core.emit(UiEvent.PermissionsChanged, { threadId });
  }

  #onControl(
    threadId: string,
    mode: PermissionMode,
    session: ChatSession,
    holder: LiveHolder,
    control: PermissionControl | null,
  ): void {
    if (!control) {
      this.#release(threadId, holder);
      return;
    }
    const live: LiveSession = { lead: false, switchTo: (to) => this.#switchChat(session, control, to) };
    this.#hold(threadId, holder, live);
    // A pick made while the session was starting has nothing to switch yet: apply it now.
    void this.#threadMeta(threadId)
      .then((meta) => {
        const now = meta?.permissionMode;
        if (!isPermissionMode(now) || holder.live !== live) return;
        const running = engineMode(session.engine, now);
        if (running === mode) return;
        session.steered = true;
        return control.setMode(running);
      })
      .catch(() => {});
  }

  /** A lead's or coordinator's control, as `#onControl` for the chat's own: switched for the chat's mode now. */
  #onLeadControl(threadId: string, lead: LeadState, holder: LiveHolder, control: PermissionControl | null): void {
    if (!control) {
      this.#release(threadId, holder);
      return;
    }
    const live: LiveSession = { lead: true, switchTo: () => this.#switchLead(threadId, lead, control) };
    this.#hold(threadId, holder, live);
    // A pick made while the session was starting has nothing to switch yet: apply it now.
    void this.#switchLead(threadId, lead, control);
  }

  /** Hand the picker a running session, in place of the one this holder handed it before. */
  #hold(threadId: string, holder: LiveHolder, live: LiveSession): void {
    this.#release(threadId, holder);
    holder.live = live;
    const held = this.#live.get(threadId) ?? new Set<LiveSession>();
    held.add(live);
    this.#live.set(threadId, held);
  }

  /** The session takes no more control requests, or ended: the picker has nothing of it to switch. */
  #release(threadId: string, holder: LiveHolder): void {
    const held = this.#live.get(threadId);
    if (holder.live) held?.delete(holder.live);
    if (held && !held.size) this.#live.delete(threadId);
    holder.live = null;
  }

  /** The folders a person's session reads beyond its game: those the thread records, and the host's own frames. */
  async chatReads(threadId: string, extraReads: string[], hostDirs: Array<string | null>): Promise<string[]> {
    const named = (await this.#threadMeta(threadId))?.extraReads;
    const recorded = Array.isArray(named) ? named.filter((dir): dir is string => typeof dir === "string") : [];
    const known = new Set(
      [...recorded, ...hostDirs.filter((dir): dir is string => Boolean(dir))].map((dir) => path.resolve(dir)),
    );
    return extraReads.filter((dir) => known.has(path.resolve(dir)));
  }

  async #threadMeta(threadId: string): Promise<PermissionMeta> {
    return (await this.#core.store.getRecord(threadId).catch(() => null))?.metadata as PermissionMeta;
  }

  /**
   * Everything the studio keeps in its own data folder, which a chat's file tools may not edit in
   * any mode: its settings, event log, harness, runs, checkpoints and whatever it adds later. Named
   * by walking the folder rather than listed, so a new store is covered the day it appears. The
   * games kept there (and the folders a session works in, `open`) are the person's, not the
   * studio's; secrets and engine homes are the engine's own unreadable fence already.
   */
  async #hostFiles(open: string[]): Promise<string[]> {
    const { layout } = this.#core;
    const root = path.resolve(this.#core.options.paths.userData);
    const work = await asWalked(root, open);
    const skip = new Set([layout.secrets, layout.engineHomes, layout.gamesRoot].map((dir) => path.resolve(dir)));
    const files: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const full = path.join(dir, entry.name);
        if (skip.has(full) || work.some((folder) => isInside(folder, full))) continue;
        // A folder that holds the games or a folder the session works in is opened up, never fenced whole.
        const holdsWork = isInside(full, layout.gamesRoot) || work.some((folder) => isInside(full, folder));
        if (!holdsWork) files.push(full);
        else if (entry.isDirectory() && depth < HOST_FILES_DEPTH) await walk(full, depth + 1);
      }
    };
    await walk(root, 0);
    return files;
  }

  // ── the question ─────────────────────────────────────────────────────────────────────────

  /**
   * Claude asks to use a tool it cannot decide on alone. The request goes into the chat's log as a
   * `tool_permission` card, the UI is nudged, and the session waits (as Claude Code does, with no
   * timeout of its own) for the person's answer, a Stop or the end of the turn. A lead's card
   * (`leadCard`) waits at most its `timeoutMs`, and no turn of the chat's ending withdraws it: the
   * lead is not that turn. The answer is logged the same way, and "always" is kept where its
   * grants say.
   */
  async #ask(
    project: string,
    threadId: string,
    ask: PermissionAsk,
    signal: AbortSignal,
    session: ChatSession,
    leadCard?: { timeoutMs: number },
  ): Promise<PermissionReply> {
    const requestId = shortId("perm");
    const base = permissionRequest({ requestId, project, threadId }, ask);
    const pending: ToolPermissionEvent = { ...base, state: ToolPermissionState.Pending };
    await this.#core.append([customEventData(CustomEvent.ToolPermission, { ...pending })], threadId);
    this.#core.emit(UiEvent.ToolPermission, { requestId, threadId, project, state: pending.state });
    const plan = ask.tool === PLAN_TOOL;
    const { answer: given, by } = await this.#ledger.request({
      requestId,
      project,
      threadId,
      signal,
      plan,
      ...(leadCard ? { timeoutMs: leadCard.timeoutMs, outlivesTurn: true } : {}),
    });
    const answer = this.#effectiveAnswer(given, base.always, session);
    // The studio moves the running mode now; what the session reports next is its doing.
    if (movedTo(answer, base.always)) session.steered = true;
    await this.#keep(project, threadId, answer, base.always);
    const settled = settledRow(base, answer, by);
    await this.#core.append([customEventData(CustomEvent.ToolPermission, { ...settled })], threadId);
    this.#core.emit(UiEvent.ToolPermission, { requestId, threadId, project, state: settled.state });
    return answer ?? withdrawnAnswer(by);
  }

  /**
   * "Always" with nothing to keep is an ordinary allow. A plan approved into Auto on a model that
   * cannot use it would skip Claude Code's own gate, so that work goes on asking first.
   */
  #effectiveAnswer(
    given: ToolPermissionAnswer | null,
    always: PermissionGrant[] | undefined,
    session: ChatSession,
  ): ToolPermissionAnswer | null {
    if (given?.decision === PermissionDecision.Always && !always) return { decision: PermissionDecision.Allow };
    const autoPlan = given?.decision === PermissionDecision.ApprovePlan && given.mode === PermissionMode.Auto;
    // Auto's gate is Claude Code's: another engine's model of the same name says nothing about it.
    const gated = session.engine === EngineId.ClaudeCode && this.#autoUnavailable.has(session.model);
    if (autoPlan && gated) return { decision: PermissionDecision.ApprovePlan, mode: PermissionMode.Manual };
    return given;
  }

  /**
   * What the answer keeps: "always" grants, or the mode an approved plan continues in. A mode the
   * chat moves to reaches its running leads as a pick does: the session that asked moves itself.
   */
  async #keep(
    project: string,
    threadId: string,
    answer: ToolPermissionAnswer | null,
    always: PermissionGrant[] | undefined,
  ): Promise<void> {
    try {
      let changed = false;
      if (answer?.decision === PermissionDecision.Always) changed = await this.#grant(project, threadId, always ?? []);
      if (answer?.decision === PermissionDecision.ApprovePlan) {
        await this.#core.store.updateThread(threadId, { metadata: { permissionMode: answer.mode } });
        changed = true;
      }
      if (changed) this.#core.emit(UiEvent.PermissionsChanged, { threadId });
      const moved = movedTo(answer, always);
      if (moved) void this.#switchLive(threadId, moved, { leadsOnly: true });
    } catch (error) {
      // The answer still stands for this call; only keeping it for later failed.
      this.#core.options.onLog?.(MESSAGE.grantNotSaved(error), "stderr");
    }
  }

  /** Keep what an "always" answer granted: game rules on disk, chat rules and folders in memory, a mode on the chat. */
  async #grant(project: string, threadId: string, grants: PermissionGrant[]): Promise<boolean> {
    let changed = false;
    const gameRules = grants.flatMap((grant) =>
      grant.kind === GrantKind.Rule && grant.scope === RuleScope.Game ? [grant.rule] : [],
    );
    if (gameRules.length) {
      await this.store.addRules(project, gameRules);
      changed = true;
    }
    for (const grant of grants) {
      if (grant.kind === GrantKind.Mode && isPermissionMode(grant.mode)) {
        await this.#core.store.updateThread(threadId, { metadata: { permissionMode: grant.mode } });
        changed = true;
      } else if (this.#grantForChat(threadId, grant)) changed = true;
    }
    return changed;
  }

  /** A chat rule or a folder, kept for this conversation; false for anything else. */
  #grantForChat(threadId: string, grant: PermissionGrant): boolean {
    const chatRule = grant.kind === GrantKind.Rule && grant.scope === RuleScope.Chat;
    const folder = grant.kind === GrantKind.Directory && path.isAbsolute(grant.path);
    if (!chatRule && !folder) return false;
    const chat = this.#chatGrants.get(threadId) ?? { rules: new Set<string>(), dirs: new Set<string>() };
    this.#chatGrants.set(threadId, chat);
    if (grant.kind === GrantKind.Rule) chat.rules.add(grant.rule);
    if (grant.kind === GrantKind.Directory) chat.dirs.add(path.resolve(grant.path));
    return true;
  }

  // ── the Studio UI's calls ────────────────────────────────────────────────────────────────

  /** What the Permissions settings show: the mode new chats start in, saved rules by game, and where Auto is unavailable. */
  async settings(): Promise<PermissionSettingsView> {
    const [defaultMode, rules, games] = await Promise.all([
      this.store.defaultMode(),
      this.store.all(),
      this.#core.games.list().catch(() => []),
    ]);
    const titles = new Map(games.map((game) => [game.name, game.title]));
    return {
      defaultMode,
      rules: Object.entries(rules)
        .map(([project, list]) => ({ project, title: titles.get(project) || project, rules: list }))
        .sort((a, b) => a.title.localeCompare(b.title)),
      autoUnavailable: [...this.#autoUnavailable],
    };
  }

  /**
   * The picker (Studio UI over IPC only, never an RPC method, so no agent chooses its own mode).
   * A running session switches now. Auto, Manual and Accept edits also become the mode the next
   * new chat starts in; Plan and Bypass stay with the chat that chose them.
   */
  async setMode(threadId: string | null, mode: unknown): Promise<PermissionSettingsView> {
    if (!isPermissionMode(mode)) throw new Error(MESSAGE.unknownMode);
    if (threadId !== null) {
      if ((await this.#threadMeta(threadId))?.kind !== ThreadKind.Game) throw new Error(MESSAGE.notGameChat);
      await this.#core.store.updateThread(threadId, { metadata: { permissionMode: mode } });
    }
    if (isSteadyPermissionMode(mode)) await this.store.setDefaultMode(mode);
    const failure = threadId === null ? null : await this.#switchLive(threadId, mode);
    this.#core.emit(UiEvent.PermissionsChanged, threadId !== null ? { threadId } : {});
    if (failure) throw failure;
    return this.settings();
  }

  /** Switch the chat's running sessions (or only its leads), if it has any; the failure to report, if any. */
  async #switchLive(threadId: string, mode: PermissionMode, { leadsOnly = false } = {}): Promise<Error | null> {
    const held = [...(this.#live.get(threadId) ?? [])].filter((live) => live.lead || !leadsOnly);
    const failures = await Promise.all(held.map((live) => live.switchTo(mode)));
    return failures.find((failure) => failure !== null) ?? null;
  }

  /** Switch the chat's own session to the chat's mode; the failure to report, if any. */
  async #switchChat(session: ChatSession, control: PermissionControl, mode: PermissionMode): Promise<Error | null> {
    session.steered = true;
    try {
      await control.setMode(engineMode(session.engine, mode));
      return null;
    } catch (error) {
      if (this.#autoRefused(session, error)) return null;
      return new Error(MESSAGE.notSwitched(PERMISSION_MODE_WORDS[mode].label));
    }
  }

  /**
   * Switch a lead's or the coordinator's session to its mode for the chat's (`leadModeFor`), one
   * switch after another, each to the chat's mode when it runs: a pick made before an earlier switch
   * landed, or a mode read before a later pick, is never where it ends. A session that will not
   * switch stays in the mode it runs in, and its screen asks first while the chat is elsewhere
   * (`#screenLeadCall`), so the chat's mode still answers: its failure is never the picker's to show.
   */
  #switchLead(threadId: string, lead: LeadState, control: PermissionControl): Promise<null> {
    lead.switching = lead.switching.then(async () => {
      const target = leadModeFor(await this.#modeOf(threadId, await this.#threadMeta(threadId)));
      if (lead.running === target) return;
      try {
        await control.setMode(target);
        lead.running = target;
      } catch (error) {
        this.#autoRefused(lead, error);
      }
    });
    return lead.switching.then(() => null);
  }

  /** Whether a switch failed on Auto itself: an answer about the plan or model, kept for it and shown beside the picker. */
  #autoRefused(session: ChatSession, error: unknown): boolean {
    if ((error as { code?: unknown })?.code !== ModeSwitchFailure.AutoUnavailable) return false;
    if (this.#autoUnavailable.has(session.model)) return true;
    this.#autoUnavailable.add(session.model);
    // A switch no pick waits on (one a lead's start owes) has nobody else to say so.
    this.#core.emit(UiEvent.PermissionsChanged, {});
    return true;
  }

  /** The person's answer to a `tool_permission` card. False once it is no longer waiting. */
  answer(requestId: unknown, answer: unknown): boolean {
    const checked = permissionAnswer(answer);
    if (typeof requestId !== "string" || !checked) throw new Error(MESSAGE.invalidAnswer);
    return this.#ledger.resolve(requestId, checked);
  }

  /** Stop allowing a saved "always allow" rule for a game. Running sessions keep it until their next message. */
  async forget(project: unknown, rule: unknown): Promise<PermissionSettingsView> {
    if (typeof project !== "string" || typeof rule !== "string") throw new Error(MESSAGE.invalidRule);
    if (await this.store.forget(project, rule)) this.#core.emit(UiEvent.PermissionsChanged, {});
    return this.settings();
  }

  /**
   * Ask the person in a chat as a Claude session would: the development fixtures' way in, so a card
   * is exercised on the real ledger and IPC without a model.
   */
  askFor(project: string, threadId: string, ask: PermissionAsk, signal: AbortSignal): Promise<PermissionReply> {
    return this.#ask(project, threadId, ask, signal, { engine: EngineId.ClaudeCode, model: "", steered: false });
  }
}
