import { providerInfo } from "../shared/providers.ts";
import type { ExportReview } from "../shared/plugins.ts";
/**
 * The chat transcript as entries: the thread's event log read once, oldest first, into the
 * bubbles, tool-chip groups, narration lines and cards the chat draws. Pure — `chat/transcript.ts`
 * and the panels render what this returns.
 */
import { PlanReviewState } from "../shared/composer.ts";
import {
  CustomEvent,
  type CustomPayload,
  customEvent,
  customPayload,
  customRecord,
  DELEGATED_PREFIX,
  delegatedPayload,
} from "../shared/custom-events.ts";
import { isHandoffNarration } from "../shared/chat-presentation.ts";
import { isCoordinatorTool } from "../shared/coordinator.ts";
import { SessionActivityRole } from "../shared/chat-activity.ts";
import type { EventData, Message } from "../shared/event-log.ts";
import { EventKind } from "../shared/event-log.ts";
import { type AssetDeliveredPayload, deliveredToBuild, isAssetDelivery } from "../shared/game-assets.ts";
import { SteerDelivery } from "../shared/message-queue.ts";
import { engineLabel, roleName } from "../shared/model-roles.ts";
import { ExecutionStatus, RoundOutcome, roundOutcome } from "../shared/run-state.ts";
import { plural, skillWords } from "../shared/skill-words.ts";
import { MINUTE_MS } from "../shared/duration.ts";
import { type ToolPermissionEvent, ToolPermissionState } from "../shared/permissions.ts";
import { contractorIdentity } from "./chat-labels.ts";
import { splitFeedback } from "./reply-about.ts";
import { plainDefect, reportSummary } from "./run-graph.ts";
import type { EventEnvelope } from "./types.ts";
import type { ToolChipRow } from "./ui/ToolChips.tsx";
import { OutputTone, ToolState } from "./ui/tool-state.ts";
import {
  A_PLUGIN,
  autopilotStartWords,
  checkReplanWords,
  circuitBreakWords,
  connectorWords,
  consentAskWords,
  consentOutcomeWords,
  decisionWords,
  fixWords,
  flagWords,
  harnessLearnedWords,
  improvementWords,
  judgeRoundLine,
  judgeUnreachable,
  livenessWords,
  modelWords,
  moveWords,
  outageWords,
  partRoundLine,
  autoResumedWords,
  pausedWords,
  permissionOutcomeWords,
  permissionTitleWords,
  PLAN_WORDS,
  planReviewWords,
  pluginToolWords,
  resumedWords,
  runStartWords,
  seedUpgradeWords,
  showWords,
  snapshotWords,
  soundsLikeTrouble,
  TRANSCRIPT_WORDS,
  toolActivityWords,
  toolWords,
  usingPluginWords,
  verdictSentence,
  wasCancelled,
} from "./words.ts";

/** What a transcript row is: which of `Entry`'s shapes it takes. */
export const EntryKind = {
  User: "user",
  Assistant: "assistant",
  System: "system",
  Thinking: "thinking",
  Tools: "tools",
  Notice: "notice",
  Activity: "activity",
  Learning: "learning",
  Question: "question",
  Assets: "assets",
  Action: "action",
  Morning: "morning",
  Compaction: "compaction",
} as const;
export type EntryKind = (typeof EntryKind)[keyof typeof EntryKind];

/** The one affordance an action card offers. */
export const EntryAction = {
  Resume: "resume",
  Steer: "steer",
  Rewind: "rewind",
  Live: "live",
  Consent: "consent",
  /** Claude's own Allow / Deny question, or a plan to approve (`tool_permission`). */
  Permission: "permission",
} as const;
export type EntryAction = (typeof EntryAction)[keyof typeof EntryAction];

export type Entry =
  | {
      kind: typeof EntryKind.User | typeof EntryKind.Assistant;
      id: string;
      text: string;
      meta?: string;
      contractor?: boolean;
      /** What a note sent to a build from its graph was about. */
      about?: string;
    }
  /**
   * A line of narration. `attention` marks one that reports trouble (a round stopped or broke
   * again, a step not delivered, a tool or model that failed, a part the studio stopped): routine
   * narration folds into one activity row, and trouble stays a line of its own.
   */
  | { kind: typeof EntryKind.System; id: string; text: string; tag?: string; attention?: boolean }
  | { kind: typeof EntryKind.Thinking; id: string; text: string }
  | { kind: typeof EntryKind.Tools; id: string; rows: ToolChipRow[] }
  | { kind: typeof EntryKind.Notice; id: string; row: ToolChipRow }
  | { kind: typeof EntryKind.Activity; id: string; rows: Array<{ text: string; tag?: string }> }
  /** The conversation was compacted: its own row, opening to the summary that replaced the messages. */
  | { kind: typeof EntryKind.Compaction; id: string; messages: number | null; summary: string | null }
  /** One plain line about what Harness learned; `link` opens Activity. */
  | { kind: typeof EntryKind.Learning; id: string; text: string; link: string }
  | {
      kind: typeof EntryKind.Question;
      id: string;
      text: string;
      choices: Array<{ id: string; label: string; description?: string }>;
      pending: boolean;
    }
  | { kind: typeof EntryKind.Assets; id: string; delivery: AssetDeliveredPayload }
  /** A card with one affordance: Resume a paused run, prefill a steering message, or Rewind. */
  | {
      kind: typeof EntryKind.Action;
      id: string;
      tag: string;
      text: string;
      action: EntryAction;
      runId?: string;
      prefill?: string;
      /** action "consent": a plugin's question to the user — Approve/Decline while it is pending, its outcome after. */
      consentId?: string;
      consentSource?: string;
      consentPrompt?: string;
      consentExport?: ExportReview;
      /** action "permission": Claude's own Allow / Deny question (or a plan to approve), as first asked, and how it ended. */
      permission?: ToolPermissionEvent;
      pending?: boolean;
      expiresAt?: number;
      outcome?: string;
      /**
       * action "steer": the answers this card offers, when "Change it" is not the only one. A
       * plan the run is holding for can be started with a word as well as changed, and a
       * button must type what its label says.
       */
      steers?: Array<{ label: string; prefill: string }>;
      snapshotId?: string;
    }
  /**
   * The morning: what the run amounts to, in one card. It replaces the line that read
   * "RUN ended after 21 iterations — the director finished the run" over a run that had
   * built, merged and judged a game.
   */
  | {
      kind: typeof EntryKind.Morning;
      id: string;
      /** the run it closes, so the card can tell a paused run from a finished one */
      runId: string | null;
      rounds: number;
      /** the run's own report to the user; a run that ran out of time first has none */
      summary: string | null;
      /** the close's own plain sentence about landing, when it wrote one */
      landingLine: string | null;
      /** the studio's own line about what the run taught it, from its ledger */
      learned: string | null;
      stoppedBecause: string | null;
      /** the provider failure that paused the run (the close's `limit.kind`), for the card's words */
      pausedOn: string | null;
      kept: number;
      undone: number;
      landed: boolean | null;
      project: string | null;
      commit: string | null;
      /** the first and last frames the run recorded, as saved-run stills */
      before: string | null;
      after: string | null;
      /** what the run generated in its own workspace: shown with its result, once in the game */
      assets?: AssetDeliveredPayload[];
      /** the user stopped it with a follow-up waiting, so that message is the next word, not this card */
      handedOff?: boolean;
      /** a later close of the same run followed: only that one offers Resume */
      superseded?: true;
    };

type ToolsEntry = Extract<Entry, { kind: typeof EntryKind.Tools }>;
type ActionEntry = Extract<Entry, { kind: typeof EntryKind.Action }>;

/** A plugin's permission card in the transcript. */
const isConsentCard = (e: Entry): e is ActionEntry => e.kind === EntryKind.Action && e.action === EntryAction.Consent;
/** Claude's own permission card in the transcript. */
const isPermissionCard = (e: Entry): e is ActionEntry =>
  e.kind === EntryKind.Action && e.action === EntryAction.Permission;
type MorningEntry = Extract<Entry, { kind: typeof EntryKind.Morning }>;
type QuestionEntry = Extract<Entry, { kind: typeof EntryKind.Question }>;

/** The tag of a narration line or card (`Entry.tag`): what the transcript shows and the activity fold keys on. */
export const SystemTag = {
  Error: "ERROR",
  SignIn: "SIGN IN",
  Restarted: "RESTARTED",
  Failed: "FAILED",
  Seed: "SEED",
  Compacted: "COMPACTED",
  Better: "BETTER",
  Run: "RUN",
  TheLead: "THE LEAD",
  TheBuild: "THE BUILD",
  Part: "PART",
  Move: "MOVE",
  Blender: "BLENDER",
  Tool: "TOOL",
  Fix: "FIX",
  Alive: "ALIVE",
  Waiting: "WAITING",
  Update: "UPDATE",
  Plan: "PLAN",
  Ask: "ASK",
  Stopped: "STOPPED",
  Resumed: "RESUMED",
  Reviewer: "REVIEWER",
  Checked: "CHECKED",
  Show: "SHOW",
  Checkpoint: "CHECKPOINT",
} as const;
export type SystemTag = (typeof SystemTag)[keyof typeof SystemTag];

/** Routine narration: folded into one activity row unless it reports trouble. */
const ROUTINE_TAGS = new Set<string>([
  SystemTag.Run,
  SystemTag.TheLead,
  SystemTag.TheBuild,
  SystemTag.Part,
  SystemTag.Move,
  SystemTag.Tool,
  SystemTag.Blender,
  SystemTag.Fix,
  SystemTag.Reviewer,
  SystemTag.Checked,
  SystemTag.Seed,
  SystemTag.Resumed,
  SystemTag.Checkpoint,
  SystemTag.Update,
]);

/** Records that start a run: any interview question still open is answered by it. */
const RUN_OPENING_EVENTS = new Set<string>([CustomEvent.RunRegistered, CustomEvent.RunStarted]);
/** Records that show a run moved on: its steering card is no longer waiting. */
const RUN_MOVING_EVENTS = [CustomEvent.DirectorWorker, CustomEvent.FacetBuildStarted, CustomEvent.RunFinished] as const;
/**
 * Queue bookkeeping: a follow-up waiting (a steered one too, until the running turn reads it),
 * and one that stopped waiting.
 */
const COORDINATOR_PREFIX = "coordinator_";
const QUEUED_EVENTS = [
  CustomEvent.CoordinatorMessageQueued,
  CustomEvent.CoordinatorMessageRequeued,
  CustomEvent.CoordinatorMessageSteering,
] as const;
const SETTLED_EVENTS = [
  CustomEvent.CoordinatorMessageProcessing,
  CustomEvent.CoordinatorMessageHandled,
  CustomEvent.CoordinatorMessageDelivered,
  CustomEvent.CoordinatorMessageRemoved,
] as const;
/** Capability receipts and live activity say nothing to the reader; they must not split a work group. */
const QUIET_EVENTS = new Set<string>([
  CustomEvent.SessionActivity,
  CustomEvent.ContextUsage,
  CustomEvent.ConnectionsApplied,
  CustomEvent.PlanningCapabilitiesApplied,
]);
const OUTAGE_EVENTS = [CustomEvent.FacetProviderOutage, CustomEvent.AutopilotProviderOutage] as const;
const NOTICE_EVENTS = [
  CustomEvent.FacetCircuitBreak,
  CustomEvent.FacetCheckReplanned,
  CustomEvent.FacetFlag,
  CustomEvent.AutopilotPlanReview,
] as const;
const PLUGIN_CALL_EVENTS = [CustomEvent.PluginToolStarted, CustomEvent.PluginTool] as const;

/** The arguments a tool chip names, in order of preference. */
const CHIP_ARGUMENT_KEYS = [
  "path",
  // Claude Code's Read, Write and Edit name their file this way.
  "file_path",
  "file",
  "filename",
  "command",
  "camera",
  "name",
  "project",
  "skill",
  "query",
  "keys",
  "key",
] as const;
/** How much of a tool's result a chip keeps. */
const TOOL_RESULT_MAX_CHARS = 12000;
/** How far back a build report looks for the contractor bubble it restates, and how much of it must match. */
const CONTRACTOR_REPLY_LOOKBACK = 4;
const CONTRACTOR_REPLY_PREFIX = 160;
/** The builder handing back after the user's Stop was stopped, not broken. */
const CONTRACTOR_STOPPED = /^Contractor stopped after \d+ turns \(stopped\)/;
/** The system message the studio writes into a conversation it restarted. */
const RESTART_MESSAGE_PREFIX = "You were restarted (";

function chipFor(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  for (const key of CHIP_ARGUMENT_KEYS) {
    const value = record[key];
    if (Array.isArray(value) && value.length) return value.map(String).join("+");
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

/** A mirrored call's chip: its input when that is text, else the argument it names. */
function inputChip(input: unknown): { chip?: string } {
  if (typeof input === "string") return { chip: input };
  const chip = chipFor(input);
  return chip ? { chip } : {};
}

/** A saved still, whether the event carried it as a path or as a shot with one. */
function shotPath(shot: unknown): unknown {
  if (typeof shot === "string") return shot;
  return shot && typeof shot === "object" ? (shot as { path?: unknown }).path : null;
}

/** The saved stills a round recorded, whatever shape the event used to carry them in. */
function shotPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(shotPath).filter((path): path is string => typeof path === "string" && path !== "");
}

/** `mcp__studio__genex__asset` and `genex__asset` are the same call, seen from two sides. */
const pluginToolKey = (name: string): string =>
  name
    .trim()
    .replace(/^mcp__[^_]+__/i, "")
    .toLowerCase();

/** How an engine mirrors a call to one of the studio's own tools (Claude's MCP, Codex's bridge). */
const STUDIO_TOOL_PREFIX = /^mcp__studio__/i;

/** Everything `toEntries` keeps while it walks the log. */
interface ChatDraft {
  signInReplies: Set<string>;
  entries: Entry[];
  /** What the run adds up to, gathered as the log is walked so the morning card can say it. */
  rounds: { kept: number; undone: number; firstShot: string | null; lastShot: string | null };
  rowByCall: Map<string, ToolChipRow>;
  directTurns: Map<string, string | null>;
  runByCall: Map<string, string>;
  /** Rows a build's worker (a facet) called: never the chat's own session, whatever run it answers for. */
  workerCalls: Set<string>;
  /**
   * A plugin tool call is two records: one when the studio passes the call on, one when it comes
   * back. The first is the whole point on a generation that takes minutes, so it becomes a line
   * straight away and the second rewrites that same line — one line per call, not two.
   */
  pluginCalls: Map<string, ToolChipRow>;
  /**
   * A delegated builder's own chip row, by the tool it called. The SDK mirrors the call but never
   * its result, so a plugin tool that failed used to leave a row that looked like it worked; the
   * host's own `plugin_tool` record is what marks it, best effort, within the same turn.
   */
  hostedTools: Set<string>;
  turnModels: Map<string, { engine?: string; model?: string }>;
  activeTurns: Map<string, string>;
  /**
   * A Loop run generates into its build workspace, not the game: those files are not playable,
   * previewable or even present until the build lands, so they wait for the run's result card.
   */
  runAssets: Map<string, AssetDeliveredPayload[]>;
  runResults: Map<string, MorningEntry>;
  /** Follow-ups typed during work and not yet delivered: a Stop with one waiting hands over to it. */
  waiting: Set<string>;
  /** The chip group new tool rows join, until a line of narration closes it. */
  group: ToolsEntry | null;
}

export function toEntries(events: EventEnvelope[]): Entry[] {
  const chat = newChatDraft(events);
  for (const event of events) readEvent(chat, event);
  for (const [runId, deliveries] of chat.runAssets) {
    const result = chat.runResults.get(runId);
    if (result) result.assets = deliveries;
  }
  return withUniqueIds(foldRoutine(chat.entries, chat.runResults));
}

function newChatDraft(events: EventEnvelope[]): ChatDraft {
  return {
    signInReplies: new Set(
      events.flatMap((event, index) => {
        const next = events[index + 1];
        const paired =
          customEvent(event, CustomEvent.NeedsSignin) &&
          next?.turn_id === event.turn_id &&
          next?.data.type === EventKind.Messages &&
          next.data.messages.some((message) => message.role === "assistant");
        return paired ? [event.id] : [];
      }),
    ),
    entries: [],
    rounds: { kept: 0, undone: 0, firstShot: null, lastShot: null },
    rowByCall: new Map(),
    directTurns: new Map(),
    runByCall: new Map(),
    workerCalls: new Set(),
    pluginCalls: new Map(),
    hostedTools: new Set(
      events.flatMap((e) => {
        const started = customEvent(e, CustomEvent.PluginToolStarted);
        return started ? [pluginToolKey(String(started.toolName ?? ""))] : [];
      }),
    ),
    turnModels: new Map(),
    activeTurns: new Map(),
    runAssets: new Map(),
    runResults: new Map(),
    waiting: new Set(),
    group: null,
  };
}

/** One record, read in the order the log gives: turns, the conversation, tool traffic, then narration. */
function readEvent(chat: ChatDraft, event: EventEnvelope): void {
  trackTurn(chat, event);
  if (readConversation(chat, event)) return;
  settleWaitingCards(chat, event.data);
  if (readToolTraffic(chat, event)) return;
  if (readQuiet(chat, event.data)) return;
  closeGroup(chat);
  for (const narrate of NARRATORS) narrate(chat, event);
}

function closeGroup(chat: ChatDraft): void {
  chat.group = null;
}

/** The open chip group, or a new one started at this record. */
function toolGroup(chat: ChatDraft, eventId: string): ToolsEntry {
  if (!chat.group) {
    chat.group = { kind: EntryKind.Tools, id: eventId, rows: [] };
    chat.entries.push(chat.group);
  }
  return chat.group;
}

/** A narration line; `attention` is written only when the record said whether it is trouble. */
function say(chat: ChatDraft, id: string, tag: SystemTag, text: string, attention?: boolean): void {
  chat.entries.push({ id, kind: EntryKind.System, tag, text, ...(attention === undefined ? {} : { attention }) });
}

const stringOrUndefined = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

function trackTurn(chat: ChatDraft, event: EventEnvelope): void {
  const { data } = event;
  if (data.type === EventKind.TurnStarted && event.turn_id) {
    chat.activeTurns.set(event.thread_id, event.turn_id);
    chat.turnModels.set(event.turn_id, {
      engine: stringOrUndefined(data.metadata?.engine),
      model: stringOrUndefined(data.metadata?.model),
    });
  }
  if (data.type === EventKind.TurnEnded) endTurn(chat, event, data.status);
}

/**
 * A turn's own tools, and a chat builder's mirrored tools (no run), end with the turn: an
 * aborted builder never sends the result that would settle them.
 */
function endTurn(chat: ChatDraft, event: EventEnvelope, status: string | undefined): void {
  chat.activeTurns.delete(event.thread_id);
  const ended: ToolState = status === "cancelled" ? ToolState.Stopped : ToolState.Unknown;
  for (const [id, row] of chat.rowByCall) {
    const ownTurn = chat.directTurns.get(id) === event.turn_id;
    const unowned = !chat.directTurns.has(id) && !chat.runByCall.has(id);
    const endsWithTurn = ownTurn || unowned;
    if (row.state === ToolState.Running && endsWithTurn) row.state = ended;
  }
  for (const [id, row] of chat.pluginCalls)
    if (row.state === ToolState.Running && !chat.runByCall.has(id)) row.state = ended;
}

/** A question or a steering card still waiting for the user. */
function awaitsAnswer(entry: Entry): entry is QuestionEntry | ActionEntry {
  return entry.kind === EntryKind.Question || (entry.kind === EntryKind.Action && entry.action === EntryAction.Steer);
}

function closeQuestions(chat: ChatDraft): void {
  for (const entry of chat.entries) if (entry.kind === EntryKind.Question) entry.pending = false;
}

/** A cancelled plan, the messages themselves and an interview question; true when the record was one. */
function readConversation(chat: ChatDraft, event: EventEnvelope): boolean {
  const { data } = event;
  if (customPayload(data, CustomEvent.PlanReview)?.state === PlanReviewState.Cancelled) {
    closeGroup(chat);
    chat.entries.push({ kind: EntryKind.System, id: event.id, text: TRANSCRIPT_WORDS.planCancelled });
    return true;
  }
  if (data.type === EventKind.Messages) {
    closeGroup(chat);
    readMessages(chat, event.id, data);
    return true;
  }
  if (readNoteLabel(chat, data)) return true;
  const asked = customPayload(data, CustomEvent.InterviewQuestion);
  if (!asked) return false;
  closeQuestions(chat);
  if (asked.question)
    chat.entries.push({
      kind: EntryKind.Question,
      id: event.id,
      text: asked.question,
      choices: asked.choices ?? [],
      pending: true,
    });
  return true;
}

/**
 * A note's record, written right after its message: it carries the name the chat gave the note.
 * True when the record was one.
 */
function readNoteLabel(chat: ChatDraft, data: EventData): boolean {
  const custom = customRecord(data);
  if (custom?.event_type !== CustomEvent.UserFeedback) return false;
  const { label } = custom.payload;
  if (typeof label !== "string" || !label) return true;
  const note = chat.entries
    .slice(-3)
    .reverse()
    .find((entry) => entry.kind === EntryKind.User && entry.about);
  if (note?.kind === EntryKind.User) note.about = label;
  return true;
}

/** What a note's bubble says it was about until its record names it. */
const NOTE_ABOUT = "Note to the build";

/** A user bubble; a note sent to a build from its graph shows the words the user wrote, and what they were about. */
function userEntry(id: string, content: string): Entry {
  const note = splitFeedback(content);
  if (!note) return { id, kind: EntryKind.User, text: content };
  return { id, kind: EntryKind.User, text: note.text, about: NOTE_ABOUT };
}

function readMessages(chat: ChatDraft, eventId: string, data: Extract<EventData, { type: "messages" }>): void {
  for (const [messageIndex, message] of data.messages.entries()) {
    const messageId = `${eventId}-${messageIndex}`;
    if (message.role === "user") {
      for (const entry of chat.entries) if (awaitsAnswer(entry)) entry.pending = false;
      chat.entries.push(userEntry(messageId, message.content));
    } else if (message.role === "assistant") {
      readReply(chat, messageId, message, data.usage?.model);
    } else if (message.role === "system") {
      chat.entries.push(systemMessage(messageId, message.content));
    }
  }
}

function readReply(chat: ChatDraft, messageId: string, message: Message, model: string | undefined): void {
  // A local thinking model's reasoning rides the same event; show it collapsed.
  const reasoning = (message as { reasoning?: string }).reasoning;
  if (reasoning?.trim()) chat.entries.push({ id: `${messageId}-r`, kind: EntryKind.Thinking, text: reasoning });
  if (!message.content.trim() || isHandoffNarration(message.content)) return;
  chat.entries.push({
    id: takeContractorBubble(chat.entries, message.content) ?? messageId,
    kind: EntryKind.Assistant,
    text: message.content,
    ...(model ? { meta: model } : {}),
  });
}

/**
 * The build report restates the contractor's own closing words (plus health and stats). Keep the
 * existing bubble's identity so reconciliation does not replay its entrance or briefly remove it
 * while the durable report replaces its text. Returns that bubble's id, having taken it out.
 */
function takeContractorBubble(entries: Entry[], content: string): string | null {
  const prefix = content.trim().slice(0, CONTRACTOR_REPLY_PREFIX);
  for (let i = entries.length - 1; i >= 0 && i >= entries.length - CONTRACTOR_REPLY_LOOKBACK; i--) {
    const prev = entries[i];
    const restated =
      prev?.kind === EntryKind.Assistant &&
      prev.contractor &&
      prefix.startsWith(prev.text.trim().slice(0, CONTRACTOR_REPLY_PREFIX));
    if (prev && restated) {
      entries.splice(i, 1);
      return prev.id;
    }
  }
  return null;
}

function systemMessage(messageId: string, content: string): Entry {
  if (!content.startsWith(RESTART_MESSAGE_PREFIX)) return { id: messageId, kind: EntryKind.System, text: content };
  return {
    id: messageId,
    kind: EntryKind.Notice,
    row: {
      key: messageId,
      icon: "run",
      label: TRANSCRIPT_WORDS.studioRestarted,
      state: ToolState.Stopped,
      detail: [{ text: content }],
    },
  };
}

/** A run starting answers any open question; a run moving on answers its own steering card. */
function settleWaitingCards(chat: ChatDraft, data: EventData): void {
  if (data.type === EventKind.Custom && RUN_OPENING_EVENTS.has(data.event_type)) closeQuestions(chat);
  const moved = customPayload(data, RUN_MOVING_EVENTS);
  if (!moved) return;
  for (const entry of chat.entries) {
    const steersMovedRun =
      entry.kind === EntryKind.Action && entry.action === EntryAction.Steer && entry.runId === moved.runId;
    if (steersMovedRun) entry.pending = false;
  }
}

/** A tool call, its result, or a delegated builder's mirrored trace; true when the record was one. */
function readToolTraffic(chat: ChatDraft, event: EventEnvelope): boolean {
  const { data } = event;
  if (data.type === EventKind.ToolRequested) {
    requestTool(chat, event, data);
    return true;
  }
  if (data.type === EventKind.ToolResult) {
    settleTool(chat, event.id, data);
    return true;
  }
  const delegated = delegatedPayload(data);
  if (!delegated) return false;
  readDelegated(chat, event, delegated);
  return true; // user/system/result mirrors stay in the log, not the transcript
}

function requestTool(
  chat: ChatDraft,
  event: EventEnvelope,
  data: Extract<EventData, { type: "tool_requested" }>,
): void {
  const group = toolGroup(chat, event.id);
  const style = toolWords(data.request.name);
  const chip = chipFor(data.request.arguments);
  const row: ToolChipRow = {
    key: data.tool_call_id,
    input: data.request.arguments,
    state: ToolState.Running,
    icon: style.icon,
    label: style.label,
    activeLabel: toolActivityWords(style.icon),
    ...(chip ? { chip } : {}),
  };
  group.rows.push(row);
  chat.rowByCall.set(data.tool_call_id, row);
  chat.directTurns.set(data.tool_call_id, event.turn_id);
}

function settleTool(chat: ChatDraft, eventId: string, data: Extract<EventData, { type: "tool_result" }>): void {
  const row = chat.rowByCall.get(data.tool_call_id) ?? orphanResultRow(chat, eventId, data.tool_call_id);
  const { ok, content } = data.result;
  const lines = content.slice(0, TOOL_RESULT_MAX_CHARS).split("\n");
  // The builder handing back after the user's Stop was stopped, not broken.
  const stopped = !ok && CONTRACTOR_STOPPED.test(content);
  row.failed = !ok && !stopped;
  row.state = resultState(ok, stopped);
  row.detail = lines.map((text) => ({
    text,
    ...(row.failed ? { tone: OutputTone.Err } : {}),
  }));
}

/** A result whose call was never seen still gets a row of its own. */
function orphanResultRow(chat: ChatDraft, eventId: string, callId: string): ToolChipRow {
  const row: ToolChipRow = { key: callId, icon: "run", label: TRANSCRIPT_WORDS.toolResult };
  toolGroup(chat, eventId).rows.push(row);
  chat.rowByCall.set(callId, row);
  return row;
}

function resultState(ok: boolean, stopped: boolean): ToolState {
  if (ok) return ToolState.Succeeded;
  return stopped ? ToolState.Stopped : ToolState.Failed;
}

type Delegated = NonNullable<ReturnType<typeof delegatedPayload>>;
type DelegatedRecord = Delegated["payload"];
type DelegatedPart = NonNullable<NonNullable<DelegatedRecord["data"]>["parts"]>[number];

/**
 * The contractor's mirrored trace: its thinking and tool calls become live rows in the current
 * chip group, so a delegation is watchable instead of a silent minute.
 */
function readDelegated(chat: ChatDraft, event: EventEnvelope, { engineId, payload }: Delegated): void {
  const scope = `${payload.delegationId ?? `${DELEGATED_PREFIX}${engineId}:${payload.runId ?? ""}:${payload.facetId ?? ""}`}:`;
  switch (payload.kind) {
    case "result":
      for (const [id, row] of chat.rowByCall)
        if (id.startsWith(scope) && row.state === ToolState.Running) row.state = ToolState.Unknown;
      break;
    case "system":
      readDelegatedSystem(chat, event, engineId, payload);
      break;
    case "checkpoint":
      readCheckpoint(chat, event.id, payload);
      break;
    case "user":
      settleDelegatedTools(chat, scope, payload);
      break;
    case "assistant":
      readDelegatedTurn(chat, event.id, scope, payload);
      break;
    default:
      break;
  }
}

/** Who is actually working, and when it gets told "no" — the two system events worth a row. */
function readDelegatedSystem(chat: ChatDraft, event: EventEnvelope, engineId: string, payload: DelegatedRecord): void {
  const subtype = payload.data?.subtype;
  if (subtype === "init") {
    const group = toolGroup(chat, event.id);
    // Older mirrored events have no turn_id; only inherit the still-active turn in
    // this thread, never a newer picker selection or a completed/background turn.
    const turnId = event.turn_id ?? chat.activeTurns.get(event.thread_id);
    const turn = turnId ? chat.turnModels.get(turnId) : undefined;
    const identity = contractorIdentity(
      engineId,
      payload.data?.model,
      payload.data?.requested_model ?? (turn?.engine === engineId ? turn.model : undefined),
    );
    group.rows.push({ key: `${event.id}-init`, icon: "run", ...identity });
  } else if (subtype === "permission_denied") {
    toolGroup(chat, event.id).rows.push(deniedRow(event.id, payload.data ?? {}));
  }
}

/**
 * The mirror keeps the SDK's whole story — which tool, whose decision, what the model was told —
 * so a denial is diagnosable, not folklore.
 */
function deniedRow(eventId: string, denied: NonNullable<DelegatedRecord["data"]>): ToolChipRow {
  const detail = [denied.decision_reason, denied.message]
    .filter((text): text is string => Boolean(text?.trim()))
    .map((text) => ({ text, tone: OutputTone.Err }));
  return {
    key: `${eventId}-denied`,
    icon: "run",
    label: TRANSCRIPT_WORDS.notAllowed,
    failed: true,
    ...(denied.tool_name ? { chip: denied.tool_name } : {}),
    detail: detail.length ? detail : [{ text: TRANSCRIPT_WORDS.notAllowedDetail, tone: OutputTone.Err }],
    detailMono: false,
  };
}

/** The contractor chose this moment: the preview just reloaded, the note says why. */
function readCheckpoint(chat: ChatDraft, eventId: string, payload: DelegatedRecord): void {
  closeGroup(chat);
  const note = payload.data?.note ?? "";
  say(chat, eventId, SystemTag.Checkpoint, note || TRANSCRIPT_WORDS.checkpoint, soundsLikeTrouble(note));
}

function settleDelegatedTools(chat: ChatDraft, scope: string, payload: DelegatedRecord): void {
  for (const part of payload.data?.parts ?? []) {
    if (part.type !== "tool_result" || !part.tool_use_id) continue;
    const row = chat.rowByCall.get(scope + part.tool_use_id);
    if (!row) continue;
    row.failed = part.is_error === true;
    row.state = row.failed ? ToolState.Failed : ToolState.Succeeded;
    if (part.content) row.detail = [{ text: part.content, tone: row.failed ? OutputTone.Err : undefined }];
  }
}

function readDelegatedTurn(chat: ChatDraft, eventId: string, scope: string, payload: DelegatedRecord): void {
  for (const [i, part] of (payload.data?.parts ?? []).entries()) {
    const key = `${eventId}-${i}`;
    if (readDelegatedWords(chat, key, part, payload)) continue;
    // A builder's or judge's reasoning is not the story: it doubled the rows and said nothing its
    // next tool call does not say better. Only what it *did* gets a row.
    if (part.type !== "tool_use" || !part.name) continue;
    if (recordedByHost(chat, part.name)) continue;
    addDelegatedToolRow(chat, eventId, scope + (part.id ?? key), part, payload);
  }
}

/**
 * A call the host records itself, so its mirror would be a second row: a plugin's (`plugin_tool`),
 * and a run control of the coordinator's or of the chat's own session after a run — the host
 * records its request and result when it runs it (conversation.ts `coordinatorTool`). A resume the
 * session only recorded runs once its reply ends, and shows then.
 */
function recordedByHost(chat: ChatDraft, name: string): boolean {
  if (chat.hostedTools.has(pluginToolKey(name))) return true;
  return isCoordinatorTool(name.trim().replace(STUDIO_TOOL_PREFIX, ""));
}

/**
 * What the session said, when the part is words: its narration is a bubble, and the chat's own
 * summarized thinking sits in the work disclosure ("Thinking details").
 */
function readDelegatedWords(chat: ChatDraft, key: string, part: DelegatedPart, payload: DelegatedRecord): boolean {
  if (part.type === "text" && part.text?.trim()) {
    closeGroup(chat);
    chat.entries.push(contractorSpeech(key, part.text, payload.role));
    return true;
  }
  if (!isChatThought(part, payload)) return false;
  closeGroup(chat);
  chat.entries.push({ id: key, kind: EntryKind.Thinking, text: part.text ?? "" });
  return true;
}

/**
 * The chat's own (planner) session's summarized thinking, with something in it. A builder's,
 * a checker's and a role-less legacy mirror's stay hidden; empty (omitted) thinking says nothing.
 */
function isChatThought(part: DelegatedPart, payload: DelegatedRecord): boolean {
  return part.type === "thinking" && Boolean(part.text?.trim()) && payload.role === SessionActivityRole.Planner;
}

/** A delegated tool call's row in the current chip group, running while its delegation is live. */
function addDelegatedToolRow(
  chat: ChatDraft,
  eventId: string,
  key: string,
  part: DelegatedPart,
  payload: DelegatedRecord,
): void {
  const did = toolWords(part.name ?? "");
  const row: ToolChipRow = {
    key,
    input: part.input,
    state: payload.delegationId ? ToolState.Running : ToolState.Unknown,
    icon: did.icon,
    label: did.label,
    activeLabel: did.active ?? toolActivityWords(did.icon),
    ...inputChip(part.input),
  };
  toolGroup(chat, eventId).rows.push(row);
  chat.rowByCall.set(row.key, row);
  trackCaller(chat, row.key, payload);
}

/** Who made a delegated call: the run it answers for, and whether a build's worker (a facet) made it. */
function trackCaller(chat: ChatDraft, key: string, payload: DelegatedRecord): void {
  if (payload.runId) chat.runByCall.set(key, payload.runId);
  if (payload.facetId) chat.workerCalls.add(key);
}

/**
 * The contractor's narration is real agent speech — a chat bubble, not a chip.
 * No signature: the build is its work, so the voice is obvious (Simeon's call).
 */
function contractorSpeech(key: string, text: string, role: string | undefined): Entry {
  if (!role || role === SessionActivityRole.Planner)
    return { id: key, kind: EntryKind.Assistant, text, contractor: true };
  const tag = role === SessionActivityRole.Reviewer ? TRANSCRIPT_WORDS.checkTag : TRANSCRIPT_WORDS.workerTag;
  return { id: key, kind: EntryKind.Activity, rows: [{ tag, text }] };
}

/** Queue bookkeeping and capability receipts say nothing to the reader; true when the record was one. */
function readQuiet(chat: ChatDraft, data: EventData): boolean {
  if (data.type !== EventKind.Custom) return false;
  if (data.event_type.startsWith(COORDINATOR_PREFIX)) {
    const queued = customPayload(data, QUEUED_EVENTS)?.messageId;
    const settled = customPayload(data, SETTLED_EVENTS)?.messageId;
    if (queued) chat.waiting.add(queued);
    else if (settled) chat.waiting.delete(settled);
    if (customPayload(data, CustomEvent.CoordinatorMessageDelivered)?.how === SteerDelivery.Interrupt)
      stopInterruptedLeg(chat);
    return true;
  }
  return QUIET_EVENTS.has(data.event_type);
}

/**
 * Steered in by interrupting the chat's session: the leg it cut off never sends the results that
 * would settle its tools, and the resumed session starts from the message. A run's coordinator
 * carries its runId too, so only a direct turn's calls and build workers' rows are left alone.
 */
function stopInterruptedLeg(chat: ChatDraft): void {
  for (const [id, row] of chat.rowByCall) {
    const chatLeg = !chat.directTurns.has(id) && !chat.workerCalls.has(id);
    if (row.state === ToolState.Running && chatLeg) row.state = ToolState.Stopped;
  }
}

// ── narration: one reader per kind of record ─────────────────────────────────────────────

type Narrator = (chat: ChatDraft, event: EventEnvelope) => void;

function narrateError(chat: ChatDraft, event: EventEnvelope): void {
  if (event.data.type === EventKind.Error) say(chat, event.id, SystemTag.Error, event.data.message);
}

function narrateSignIn(chat: ChatDraft, event: EventEnvelope): void {
  const failure = customPayload(event.data, CustomEvent.NeedsSignin);
  if (failure && !chat.signInReplies.has(event.id))
    say(
      chat,
      event.id,
      SystemTag.SignIn,
      TRANSCRIPT_WORDS.signInAgain(providerInfo(failure.engine)?.label ?? "Your coding provider"),
    );
}

function narrateRestore(chat: ChatDraft, event: EventEnvelope): void {
  const { data } = event;
  if (data.type !== EventKind.WorkspaceRestored) return;
  chat.entries.push({
    id: event.id,
    kind: EntryKind.Notice,
    row: {
      key: event.id,
      icon: "run",
      label: TRANSCRIPT_WORDS.workspaceRestored,
      state: ToolState.Succeeded,
      detail: [{ text: data.reason }, { text: snapshotWords(data.snapshot_id) }],
    },
  });
}

function narrateRebuild(chat: ChatDraft, event: EventEnvelope): void {
  const restart = customPayload(event.data, CustomEvent.RebuildAndRestartStudio);
  if (!restart) return;
  const tag = restart.ok ? SystemTag.Restarted : SystemTag.Failed;
  say(chat, event.id, tag, `${restart.reason ?? TRANSCRIPT_WORDS.rebuiltItself}`);
}

function narrateSeed(chat: ChatDraft, event: EventEnvelope): void {
  const seed = customPayload(event.data, CustomEvent.SeedUpgraded);
  if (seed) say(chat, event.id, SystemTag.Seed, seedUpgradeWords(seed));
}

/** A compaction is not routine work: it stays in the chat as its own row, with what it wrote. */
function narrateCompaction(chat: ChatDraft, event: EventEnvelope): void {
  const compaction = customPayload(event.data, CustomEvent.Compacted);
  if (!compaction) return;
  const summary = typeof compaction.summary === "string" ? compaction.summary.trim() : "";
  chat.entries.push({
    kind: EntryKind.Compaction,
    id: event.id,
    messages: typeof compaction.messages === "number" ? compaction.messages : null,
    summary: summary || null,
  });
}

function narrateImprovement(chat: ChatDraft, event: EventEnvelope): void {
  const improvement = customPayload(event.data, CustomEvent.ImprovementApplied);
  if (!improvement) return;
  chat.entries.push({
    id: event.id,
    kind: EntryKind.Action,
    tag: SystemTag.Better,
    action: EntryAction.Rewind,
    ...(improvement.snapshot_id ? { snapshotId: improvement.snapshot_id } : {}),
    text: improvementWords(improvement),
  });
}

function narrateSkillAccepted(chat: ChatDraft, event: EventEnvelope): void {
  const skillAccepted = customPayload(event.data, CustomEvent.SkilloptAccepted);
  if (!skillAccepted) return;
  // The instruction file and the proposer's notes live in Activity; the chat says it plainly.
  const title = skillAccepted.title?.trim().replace(/\.$/, "");
  const text = title
    ? `Harness learned to ${title.charAt(0).toLowerCase()}${title.slice(1)}.`
    : `Harness updated ${skillWords(skillAccepted.skill).replace(/^how Harness /, "how it ")}.`;
  chat.entries.push({ id: event.id, kind: EntryKind.Learning, text, link: TRANSCRIPT_WORDS.seeInHarness });
}

/** An engine's name as a person says it: the provider table's, else the role table's. */
function providerName(engine: string): string {
  return providerInfo(engine)?.label ?? engineLabel(engine);
}

/** An unattended run narrates itself in the game's own chat: start, verdicts, ending, lessons. */
function narrateRunStart(chat: ChatDraft, event: EventEnvelope): void {
  const started = customPayload(event.data, CustomEvent.RunStarted);
  if (!started) return;
  // Which model judges this run, by name: a stale saved preference can put the judging on the
  // orchestrator's model, and nothing else on screen says which model is answering. And on
  // which subscription, when the judges are not on the run's own (cross-provider roles).
  const judge = started.judgeModel ?? started.roles?.judge;
  const judgeEngine = started.judgeEngine ?? started.engine ?? "";
  const judgeName = judge ? roleName(judgeEngine, judge) : null;
  const crossProvider = Boolean(judgeName && started.engine && judgeEngine !== started.engine);
  const judgeWords = crossProvider ? `${judgeName} on ${providerName(judgeEngine)}` : judgeName;
  say(chat, event.id, SystemTag.Run, runStartWords(started.reference ?? null, judgeWords));
}

function narrateAutopilotStart(chat: ChatDraft, event: EventEnvelope): void {
  const autopilot = customPayload(event.data, CustomEvent.AutopilotStarted);
  if (!autopilot) return;
  const text = autopilotStartWords({
    facets: autopilot.facets ?? [],
    maxParallel: autopilot.maxParallel ?? 1,
    director: autopilot.director === true,
  });
  say(chat, event.id, autopilot.director ? SystemTag.TheLead : SystemTag.TheBuild, text);
}

function countRound(chat: ChatDraft, outcome: RoundOutcome): void {
  if (outcome === RoundOutcome.Accepted) chat.rounds.kept += 1;
  else if (outcome === RoundOutcome.Rejected) chat.rounds.undone += 1;
}

type RoundPayload = CustomPayload<typeof CustomEvent.FacetIteration>;

function narrateRound(chat: ChatDraft, event: EventEnvelope): void {
  const round = customPayload(event.data, CustomEvent.FacetIteration);
  if (!round) return;
  // The morning card counts the run's rounds; a round the lead stopped, or one that
  // recorded no winner, is neither kept nor undone.
  const outcome = roundOutcome(round);
  countRound(chat, outcome);
  for (const shot of shotPaths(round.shots)) {
    chat.rounds.firstShot ??= shot;
    chat.rounds.lastShot = shot;
  }
  const brokeAgain = (round.scoreboard?.regressions?.length ?? 0) > 0;
  const undoneUnjudged = outcome === RoundOutcome.Rejected && judgeUnreachable(round.verdictSource ?? null);
  const attention = outcome === RoundOutcome.Stopped || brokeAgain || round.move?.delivered === false || undoneUnjudged;
  const nextGap = judgedGap(round, outcome);
  say(chat, event.id, SystemTag.Part, partRoundLine(round, nextGap), attention);
}

/**
 * The gap a judge named, in plain words, or null. A round nobody judged (stopped by the lead, or
 * its judge out of reach) carries the builder's last known gap — on round one its whole brief —
 * and that is the harness's instruction, not a finding.
 */
function judgedGap(round: RoundPayload, outcome: RoundOutcome): string | null {
  const unjudged = outcome === RoundOutcome.Stopped || judgeUnreachable(round.verdictSource ?? null);
  if (unjudged || round.satisfied || !round.biggest_gap) return null;
  return plainDefect(round.biggest_gap);
}

function narrateMove(chat: ChatDraft, event: EventEnvelope): void {
  const step = customPayload(event.data, CustomEvent.FacetMove);
  if (step) say(chat, event.id, SystemTag.Move, moveWords(step));
}

function narrateModel(chat: ChatDraft, event: EventEnvelope): void {
  const modelled = customPayload(event.data, CustomEvent.BlenderAsset);
  if (!modelled) return;
  const text = modelWords({
    ...modelled,
    triangles: modelled.stats?.triangles ?? null,
    polygons: modelled.stats?.polygons ?? null,
  });
  say(chat, event.id, SystemTag.Blender, text, !modelled.ok);
}

/**
 * A plugin tool call, from the studio's own record of it. Both engine paths write the pair,
 * so a plugin that a run's builder used reads the same as one the user asked for in chat.
 */
function narratePluginCall(chat: ChatDraft, event: EventEnvelope): void {
  const { data } = event;
  const raw = customPayload(data, PLUGIN_CALL_EVENTS);
  if (!raw || data.type !== EventKind.Custom) return;
  const closing = data.event_type === CustomEvent.PluginTool;
  // An API 1 record carried no outcome at all and was appended only once the call had come
  // back, so a closing record that says nothing about how it went is one that went fine.
  // Without this, every plugin call in a log written before this version reads as still out.
  const payload = closing && raw.ok === undefined ? { ...raw, ok: true } : raw;
  const text = pluginToolWords(payload);
  const row =
    (payload.callId ? chat.pluginCalls.get(payload.callId) : undefined) ?? openPluginRow(chat, event, payload);
  row.chip = payload.tool ?? payload.toolName;
  row.state = pluginCallState(closing, payload.ok);
  row.failed = row.state === ToolState.Failed;
  row.detail = [{ text }, ...(raw.result ? [{ text: String(raw.result) }] : [])];
}

function pluginCallState(closing: boolean, ok: boolean | undefined): ToolState {
  if (!closing) return ToolState.Running;
  return ok ? ToolState.Succeeded : ToolState.Failed;
}

function openPluginRow(
  chat: ChatDraft,
  event: EventEnvelope,
  payload: { callId?: string; pluginName?: string; runId?: string },
): ToolChipRow {
  const row: ToolChipRow = {
    key: payload.callId ?? event.id,
    icon: "game",
    label: payload.pluginName ?? TRANSCRIPT_WORDS.plugin,
    activeLabel: usingPluginWords(payload.pluginName),
    detailMono: false,
  };
  toolGroup(chat, event.id).rows.push(row);
  chat.pluginCalls.set(row.key, row);
  if (payload.runId) chat.runByCall.set(row.key, payload.runId);
  return row;
}

function narrateDelivery(chat: ChatDraft, event: EventEnvelope): void {
  const delivery = customPayload(event.data, CustomEvent.AssetDelivered);
  if (!delivery || !isAssetDelivery(delivery)) return;
  if (!deliveredToBuild(delivery)) chat.entries.push({ kind: EntryKind.Assets, id: event.id, delivery });
  else if (delivery.runId)
    chat.runAssets.set(delivery.runId, [...(chat.runAssets.get(delivery.runId) ?? []), delivery]);
}

/**
 * A connector tool call. One record, written whichever way it ended — a connector has no
 * started/finished pair, because the host writes it around a single await.
 */
function narrateConnector(chat: ChatDraft, event: EventEnvelope): void {
  const connector = customPayload(event.data, CustomEvent.ConnectorTool);
  if (connector) say(chat, event.id, SystemTag.Tool, connectorWords(connector), connector.ok === false);
}

function narrateFix(chat: ChatDraft, event: EventEnvelope): void {
  const fix = customPayload(event.data, CustomEvent.FacetFix);
  if (fix) say(chat, event.id, SystemTag.Fix, fixWords(fix));
}

function narrateLiveness(chat: ChatDraft, event: EventEnvelope): void {
  const liveness = customPayload(event.data, CustomEvent.FacetLiveness);
  if (liveness) say(chat, event.id, SystemTag.Alive, livenessWords(liveness));
}

function narrateOutage(chat: ChatDraft, event: EventEnvelope): void {
  const outage = customPayload(event.data, OUTAGE_EVENTS);
  if (!outage) return;
  say(
    chat,
    event.id,
    SystemTag.Waiting,
    outageWords({ ...outage, minutes: Math.round((outage.wait ?? 0) / MINUTE_MS) }),
  );
}

function narrateDecision(chat: ChatDraft, event: EventEnvelope): void {
  const decided = customPayload(event.data, CustomEvent.AutopilotDecision);
  if (!decided) return;
  // The lead writes its decisions for itself; `plain` is the sentence it wrote for the user.
  const decision = (decided.plain ?? "").trim() || decisionWords(decided.decision ?? "");
  // The record holds only the lead's sentence; nothing structured says it went wrong.
  say(chat, event.id, SystemTag.Update, decision, soundsLikeTrouble(decision));
}

type NoticePayload = CustomPayload<(typeof NOTICE_EVENTS)[number]>;

function noticeText(eventType: string, notice: NoticePayload): string {
  switch (eventType) {
    case CustomEvent.FacetCircuitBreak:
      return circuitBreakWords(notice);
    case CustomEvent.FacetCheckReplanned:
      return checkReplanWords(notice);
    case CustomEvent.FacetFlag:
      return flagWords(notice);
    default:
      return planReviewWords(notice);
  }
}

function narrateNotice(chat: ChatDraft, event: EventEnvelope): void {
  const { data } = event;
  const notice = customPayload(data, NOTICE_EVENTS);
  if (!notice || data.type !== EventKind.Custom) return;
  const text = noticeText(data.event_type, notice);
  const waitMinutes = notice.waitMinutes ?? 0;
  const heldPlan = data.event_type === CustomEvent.AutopilotPlanReview && waitMinutes > 0;
  if (!heldPlan) {
    // A part the studio stopped retrying is trouble; a re-aimed check or a flag is routine.
    say(chat, event.id, SystemTag.Update, text, data.event_type === CustomEvent.FacetCircuitBreak);
    return;
  }
  chat.entries.push({
    id: event.id,
    kind: EntryKind.Action,
    tag: SystemTag.Plan,
    action: EntryAction.Steer,
    text,
    runId: notice.runId,
    pending: true,
    expiresAt: Date.parse(event.created_at) + waitMinutes * MINUTE_MS,
    prefill: PLAN_WORDS.changePrefill,
    // "go" only starts a run that is actually waiting for it, and the card that asks for it
    // offers both of its answers as their own button. A plan nobody is holding for is still
    // the user's to change, so that card keeps the one button it always had.
    steers: [
      { label: TRANSCRIPT_WORDS.sayGo, prefill: PLAN_WORDS.go },
      { label: TRANSCRIPT_WORDS.changeIt, prefill: PLAN_WORDS.changePrefill },
    ],
  });
}

/**
 * A plugin's question to the user rides the log twice — asked, then answered — and both land
 * on one card, keyed by the consent id, so the buttons give way to the outcome in place.
 */
function narrateConsent(chat: ChatDraft, event: EventEnvelope): void {
  const consent = customPayload(event.data, CustomEvent.PluginConsent);
  if (!consent) return;
  const consentId = consent.consentId ?? event.id;
  const existing = chat.entries.find((e): e is ActionEntry => isConsentCard(e) && e.consentId === consentId);
  const pending = consent.state === "pending";
  const outcome = () => consentOutcomeWords({ state: consent.state, by: consent.by });
  if (existing) {
    existing.pending = pending;
    if (!pending) existing.outcome = outcome();
    return;
  }
  closeGroup(chat);
  chat.entries.push({
    id: event.id,
    kind: EntryKind.Action,
    tag: SystemTag.Ask,
    action: EntryAction.Consent,
    consentId,
    consentSource: consent.pluginName || A_PLUGIN,
    consentPrompt: consent.prompt || undefined,
    consentExport: consent.exportReview,
    text: consentAskWords({
      pluginName: consent.pluginName,
      tool: consent.tool,
      args: consent.args,
      prompt: consent.prompt,
    }),
    pending,
    ...(pending ? {} : { outcome: outcome() }),
  });
}

/** What a later `tool_permission` row may change about a request: how it ended, never what it asked. */
function settlementOf(row: Partial<ToolPermissionEvent>): Partial<ToolPermissionEvent> {
  const { state, by, granted, mode, message } = row;
  const fields = Object.entries({ state, by, granted, mode, message }).filter(([, value]) => value !== undefined);
  return Object.fromEntries(fields) as Partial<ToolPermissionEvent>;
}

/**
 * Claude's own permission questions work like a plugin's: asked, then settled, one card per
 * request id. The question is the first row's; a later row only says how it ended.
 */
function narratePermission(chat: ChatDraft, event: EventEnvelope): void {
  const row = customPayload(event.data, CustomEvent.ToolPermission);
  if (!row) return;
  const requestId = row.requestId ?? event.id;
  const existing = chat.entries.find(
    (e): e is ActionEntry => isPermissionCard(e) && e.permission?.requestId === requestId,
  );
  const asked = existing?.permission ?? row;
  const permission = { ...asked, ...(existing ? settlementOf(row) : {}), requestId } as ToolPermissionEvent;
  const pending = permission.state === ToolPermissionState.Pending;
  if (existing) {
    existing.pending = pending;
    existing.permission = permission;
    if (!pending) existing.outcome = permissionOutcomeWords(permission);
    return;
  }
  closeGroup(chat);
  chat.entries.push({
    id: event.id,
    kind: EntryKind.Action,
    tag: SystemTag.Ask,
    action: EntryAction.Permission,
    text: permissionTitleWords(permission),
    permission,
    pending,
    ...(pending ? {} : { outcome: permissionOutcomeWords(permission) }),
  });
}

function narratePaused(chat: ChatDraft, event: EventEnvelope): void {
  const paused = customPayload(event.data, CustomEvent.AutopilotPaused);
  if (!paused) return;
  chat.entries.push({
    id: event.id,
    kind: EntryKind.Action,
    tag: SystemTag.Stopped,
    action: EntryAction.Resume,
    ...(paused.runId ? { runId: paused.runId } : {}),
    text: pausedWords(),
  });
}

function narrateResumed(chat: ChatDraft, event: EventEnvelope): void {
  const resumed = customPayload(event.data, CustomEvent.AutopilotResumed);
  if (resumed) say(chat, event.id, SystemTag.Resumed, resumedWords(resumed.doneFacets?.length ?? 0));
}

/** A build the studio resumed on its own: why, in plain words (`core/auto-resume.ts`). */
function narrateAutoResumed(chat: ChatDraft, event: EventEnvelope): void {
  const resumed = customPayload(event.data, CustomEvent.RunAutoResumed);
  if (resumed) say(chat, event.id, SystemTag.Resumed, autoResumedWords(resumed.cause));
}

function narrateJudgeRound(chat: ChatDraft, event: EventEnvelope): void {
  const judgeRound = customPayload(event.data, CustomEvent.RunIteration);
  if (!judgeRound) return;
  countRound(chat, roundOutcome(judgeRound));
  const nextGap = judgeRound.biggest_gap ? plainDefect(judgeRound.biggest_gap) : null;
  say(chat, event.id, SystemTag.Reviewer, judgeRoundLine(judgeRound, nextGap));
}

type FinishedPayload = CustomPayload<typeof CustomEvent.RunFinished>;

function narrateFinished(chat: ChatDraft, event: EventEnvelope): void {
  const finished = customPayload(event.data, CustomEvent.RunFinished);
  if (!finished) return;
  settleRunTools(chat, finished);
  const result = morningCard(chat, event.id, finished);
  chat.entries.push(result);
  // A paused or reopened run closes more than once; its latest result carries everything it
  // generated, and the earlier cards no longer speak for where it stands.
  if (result.runId) {
    const earlier = chat.runResults.get(result.runId);
    if (earlier) earlier.superseded = true;
    chat.runResults.set(result.runId, result);
  }
  chat.rounds = { kept: 0, undone: 0, firstShot: null, lastShot: null };
}

/** The run's own tool rows still out when it closed: stopped when the user stopped it, else unknown. */
function settleRunTools(chat: ChatDraft, finished: FinishedPayload): void {
  const cancelled = finished.executionStatus === ExecutionStatus.Cancelled || wasCancelled(finished.stoppedBecause);
  for (const [id, row] of [...chat.rowByCall, ...chat.pluginCalls]) {
    const ownRow = Boolean(finished.runId) && chat.runByCall.get(id) === finished.runId;
    if (row.state === ToolState.Running && ownRow) row.state = cancelled ? ToolState.Stopped : ToolState.Unknown;
  }
}

/** The provider failure that paused the run, by its typed kind (`run_finished.limit.kind`), or null. */
function pausedOnOf(finished: FinishedPayload): string | null {
  const kind = finished.limit?.kind;
  return typeof kind === "string" ? kind : null;
}

function morningCard(chat: ChatDraft, id: string, finished: FinishedPayload): MorningEntry {
  const { rounds } = chat;
  const judged = rounds.kept + rounds.undone;
  const n = judged || (Array.isArray(finished.iterations) ? finished.iterations.length : 0);
  const head = finished.integrationHead;
  const leftUnlanded =
    finished.landed === false && typeof head === "string" && head !== "" && head !== finished.baseCommit;
  const unlandedHead = leftUnlanded ? head : null;
  return {
    id,
    kind: EntryKind.Morning,
    runId: finished.runId ?? null,
    rounds: n,
    summary: reportSummary(finished),
    landingLine: typeof finished.landingResult?.line === "string" ? finished.landingResult.line : null,
    learned: typeof finished.learned === "string" && finished.learned.trim() ? finished.learned : null,
    stoppedBecause: finished.stoppedBecause ?? null,
    pausedOn: pausedOnOf(finished),
    kept: rounds.kept,
    undone: rounds.undone,
    landed: finished.landed ?? null,
    project: finished.project ?? null,
    commit: unlandedHead && finished.project ? unlandedHead : null,
    before: rounds.firstShot,
    after: rounds.lastShot,
    ...(chat.waiting.size > 0 && wasCancelled(finished.stoppedBecause) ? { handedOff: true } : {}),
  };
}

/**
 * The lead judged a build, or found one that would not start. Until now those looks lived
 * only in files nobody opens: the run's own judge said nothing in the chat for the whole run, and a
 * fork gate that refused every builder said nothing either.
 */
function narrateLook(chat: ChatDraft, event: EventEnvelope): void {
  const looked = customPayload(event.data, CustomEvent.DirectorVerdict);
  if (!looked) return;
  const because = verdictSentence(looked);
  // The judge always, and a fork gate only when it refused — that refusal is why no builder
  // started, and nothing else in the feed says it. The health pass and the close are left
  // out: the lead's own card and the morning card already carry those.
  const isJudge = looked.pass === "judge";
  const refusedFork = looked.pass === "gate" && looked.decision?.kept === false;
  if (!because || !(isJudge || refusedFork)) return;
  // A fork gate is only told here when it refused, and that refusal is why no builder
  // started. A judge's look is its own sentence and nothing else.
  say(
    chat,
    event.id,
    isJudge ? SystemTag.Reviewer : SystemTag.Checked,
    because,
    refusedFork || soundsLikeTrouble(because),
  );
}

/** The lead put a build in the window itself: say so, and give the user the way back to it. */
function narrateShow(chat: ChatDraft, event: EventEnvelope): void {
  const shown = customPayload(event.data, CustomEvent.DirectorShow);
  if (!shown) return;
  chat.entries.push({
    id: event.id,
    kind: EntryKind.Action,
    tag: SystemTag.Show,
    action: EntryAction.Live,
    text: showWords(shown.target),
  });
}

function narrateLearningPass(chat: ChatDraft, event: EventEnvelope): void {
  const pass = customPayload(event.data, CustomEvent.SkilloptPass);
  if (!pass) return;
  // Only what reached the user: applied changes and suggestions waiting for them. Reviews
  // that found nothing, and the rejected candidates, stay in Studio's own records.
  const staged = Math.max(0, pass.staged ?? 0);
  const learned = staged + Math.max(0, pass.accepted ?? 0);
  if (learned <= 0) return;
  chat.entries.push({
    id: event.id,
    kind: EntryKind.Learning,
    text: harnessLearnedWords(plural(learned, "thing")),
    link: staged > 0 ? TRANSCRIPT_WORDS.reviewInHarness : TRANSCRIPT_WORDS.seeInHarness,
  });
}

/** Every narrator, in the order a record is offered to them; each speaks for one kind of record. */
const NARRATORS: readonly Narrator[] = [
  narrateError,
  narrateSignIn,
  narrateRestore,
  narrateRebuild,
  narrateSeed,
  narrateCompaction,
  narrateImprovement,
  narrateSkillAccepted,
  narrateRunStart,
  narrateAutopilotStart,
  narrateRound,
  narrateMove,
  narrateModel,
  narratePluginCall,
  narrateDelivery,
  narrateConnector,
  narrateFix,
  narrateLiveness,
  narrateOutage,
  narrateDecision,
  narrateNotice,
  narrateConsent,
  narratePermission,
  narratePaused,
  narrateResumed,
  narrateAutoResumed,
  narrateJudgeRound,
  narrateFinished,
  narrateLook,
  narrateShow,
  narrateLearningPass,
];

// ── folding ───────────────────────────────────────────────────────────────────────────────

/** Routine narration folds into activity rows; a paused run's Resume line under its result card goes. */
function foldRoutine(entries: Entry[], runResults: Map<string, MorningEntry>): Entry[] {
  const compact: Entry[] = [];
  // A run's result card already says it stopped and offers Resume; a second line would repeat it.
  const covered = (entry: Entry): boolean =>
    entry.kind === EntryKind.Action &&
    entry.action === EntryAction.Resume &&
    Boolean(entry.runId && runResults.has(entry.runId));
  for (const entry of entries) {
    if (covered(entry)) continue;
    const routine = entry.kind === EntryKind.System && ROUTINE_TAGS.has(entry.tag ?? "") && !entry.attention;
    if (!routine) {
      compact.push(entry);
      continue;
    }
    const row = { text: entry.text, tag: entry.tag };
    const last = compact.at(-1);
    if (last?.kind === EntryKind.Activity) last.rows.push(row);
    else compact.push({ kind: EntryKind.Activity, id: entry.id, rows: [row] });
  }
  return compact;
}

/** Ids made unique by kind and occurrence, so a record that became two entries keeps both. */
function withUniqueIds(entries: Entry[]): Entry[] {
  const seen = new Map<string, number>();
  for (const entry of entries) {
    const key = `${entry.id}:${entry.kind}`;
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    entry.id = occurrence ? `${key}:${occurrence}` : key;
  }
  return entries;
}
