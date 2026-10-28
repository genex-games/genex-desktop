/**
 * The chat and its composer (plan §1.5): sending, waiting for the answer, the cards that block a
 * turn, stopping and rewinding. Every value is one of the app's own vocabularies, a switch, a count
 * or a duration: never the words, a name, a path or an id (they are paired in `chat-memory.ts`).
 */
import type { PlanReviewState, SendFailure, SendRefusal } from "../../../shared/composer.ts";
import type { ChatActivityPhase } from "../../../shared/chat-activity.ts";
import type { FilesStay } from "../../../shared/chat-rewind.ts";
import type { EngineKind } from "../../../shared/engine-descriptor.ts";
import type { EngineFailureKind, LimitKind } from "../../../shared/engine-requests.ts";
import type { ToolCategory } from "../../../shared/eval-lane.ts";
import type { SteerDelivery } from "../../../shared/message-queue.ts";
import type { ReasoningEffort } from "../../../shared/model-preferences.ts";
import type {
  ModeSwitchFailure,
  PermissionDecision,
  PermissionMode,
  SteadyPermissionMode,
} from "../../../shared/permissions.ts";
import type { MentionKind, MentionOrigin } from "../../../shared/prompt-mention.ts";
import type { ConsentChoice } from "../../chat/consent-card.ts";
import type { SendPlacement } from "../../chat/pending-sends.ts";
import type { CommandState } from "../../state/command-runs.ts";
import { type ChatMemory, chatMemory } from "../chat-memory.ts";
import type { SendEvent } from "../chat-observe.ts";
import { questionAnsweredProperties, type RewindCode, type UndoRewindCode } from "../chat-properties.ts";
import { track } from "../client.ts";
import type {
  CardSettledBy,
  ComposerRoom,
  CompactTrigger,
  ContextBucket,
  HoursBucket,
  LeftTo,
  LoopVia,
  ModelMenuFrom,
  ModelReplaced,
  ModelSetting,
  ModeVia,
  PlanAction,
  PlanModeVia,
  QuestionDeferral,
  QuestionVia,
  RetryAfterBucket,
  RewindAction,
  RewindFilesState,
  SendBlock,
  SendFailStage,
  SendRoute,
  SendSource,
  SignInAction,
  SignInFrom,
  StopEndedBy,
  StopIgnored,
  StopVia,
  TurnOutcome,
  TurnStatus,
  WaitingCardKind,
} from "../chat-vocabulary.ts";
import type { CharsBucket, CountBucket } from "../properties.ts";

export const ChatEvent = {
  MessageSent: "message_sent",
  MessageSendBlocked: "message_send_blocked",
  MessageSendFailed: "message_send_failed",
  MessageQueueWaited: "message_queue_waited",
  MessageSteered: "message_steered",
  ReplyFirstTokenReceived: "reply_first_token_received",
  MessageRowMissing: "message_row_missing",
  ChatTurnEnded: "chat_turn_ended",
  MessageAnswerFailed: "message_answer_failed",
  QueuedMessageRemoved: "queued_message_removed",
  ChatStopRequested: "chat_stop_requested",
  ChatStopSettled: "chat_stop_settled",
  PermissionRequested: "permission_requested",
  PermissionAnswered: "permission_answered",
  CardSettledWithoutAnswer: "card_settled_without_answer",
  ChatLeftWhileWaiting: "chat_left_while_waiting",
  PermissionModeChanged: "permission_mode_changed",
  ChatQuestionAsked: "chat_question_asked",
  ChatQuestionAnswered: "chat_question_answered",
  ChatQuestionDeferred: "chat_question_deferred",
  PlanModeToggled: "plan_mode_toggled",
  PlanReviewChanged: "plan_review_changed",
  PlanAnswered: "plan_answered",
  RewindOpened: "rewind_opened",
  RewindPreviewed: "rewind_previewed",
  RewindDecided: "rewind_decided",
  RewindCompleted: "rewind_completed",
  RewindUndone: "rewind_undone",
  ModelMenuClosed: "model_menu_closed",
  ModelPicked: "model_picked",
  ModelSettingsChanged: "model_settings_changed",
  ModelPickReplaced: "model_pick_replaced",
  LoopModeChanged: "loop_mode_changed",
  ChatSignInNeeded: "chat_sign_in_needed",
  SignInCardAction: "sign_in_card_action",
  EngineFellBack: "engine_fell_back",
  ChatContextCompacted: "chat_context_compacted",
  ChatOpened: "chat_opened",
  ChatHistoryPaged: "chat_history_paged",
  ComposerAttachmentsRejected: "composer_attachments_rejected",
  MentionAdded: "mention_added",
  ChatCommandRun: "chat_command_run",
  ConsentAnswered: "consent_answered",
} as const;
export type ChatEvent = (typeof ChatEvent)[keyof typeof ChatEvent];

/** An engine id from the app's own list, else `other` (or `none`). */
type EngineRef = string;
/** A catalog model id, else `custom`, `default` or `none` (`modelRef`). */
type ModelRef = string;

/** What `message_sent` carries: how the message went and the chat it went into, never its words. */
export type MessageSentProperties = {
  room: ComposerRoom;
  route: SendRoute;
  placement?: SendPlacement;
  source: SendSource;
  permission_mode?: PermissionMode;
  engine: EngineRef;
  engine_kind?: EngineKind;
  model: ModelRef;
  effort?: ReasoningEffort;
  loop_on: boolean;
  loop_hours_bucket: HoursBucket;
  plan_review: boolean;
  pictures: number;
  files: number;
  mentions: number;
  chars_bucket: CharsBucket;
  /** This message's place among the chat's user messages (1 for the first). */
  user_message_index: number;
  is_first_in_game: boolean;
  chat_working: boolean;
  /** The first send after a rewind put words back. */
  after_rewind: boolean;
  /** Sent within `AFTER_STOP_MS` of a Stop in this chat. */
  after_stop: boolean;
  /** The same words as the chat's previous user message (compared here, never sent). */
  repeats_previous: boolean;
  /** Since this chat's last turn ended. */
  think_time_ms?: number;
};

/** A turn's close, from its records: how it ended and what it went through. */
export type ChatTurnEndedProperties = {
  status: TurnStatus;
  outcome: TurnOutcome;
  interrupted: boolean;
  duration_ms?: number;
  engine: EngineRef;
  engine_kind?: EngineKind;
  streamed: boolean;
  stream_failed: boolean;
  /** How its engine failed: a direct engine's call, or main's word on a delegated one. */
  failure_kind?: EngineFailureKind;
  /** The provider's limit it ended on, and how long the provider said to wait. */
  limit_kind?: LimitKind;
  retry_after_bucket?: RetryAfterBucket;
  launched_build: boolean;
};

/**
 * A message that did not go: its send rejected (`rejected`, with the send's facts) or its chat
 * refusing what it commissions (`refused`, heard from main), with the code of either.
 */
export type MessageSendFailedProperties = {
  stage: SendFailStage;
  code: SendFailure | SendRefusal | null;
  route?: SendRoute;
  ack_ms?: number;
  pictures?: number;
  mentions?: number;
};

export type ChatEventProperties = {
  [ChatEvent.MessageSent]: MessageSentProperties;
  [ChatEvent.MessageSendBlocked]: {
    reason: SendBlock;
    room: ComposerRoom;
    engine: EngineRef;
    /** Presses on a dead Send since the last message that went. */
    attempts_in_row: number;
  };
  [ChatEvent.MessageSendFailed]: MessageSendFailedProperties;
  [ChatEvent.MessageQueueWaited]: { queue_wait_ms: number; placement?: SendPlacement };
  [ChatEvent.MessageSteered]: { how?: SteerDelivery; requeued: boolean; steer_wait_ms?: number };
  [ChatEvent.ReplyFirstTokenReceived]: {
    first_token_ms: number;
    first_activity_ms?: number;
    from_processing_ms?: number;
    first_phase?: ChatActivityPhase;
    engine: EngineRef;
    engine_kind?: EngineKind;
    is_first_in_game: boolean;
  };
  [ChatEvent.MessageRowMissing]: { placement?: SendPlacement };
  [ChatEvent.ChatTurnEnded]: ChatTurnEndedProperties;
  [ChatEvent.MessageAnswerFailed]: { engine: EngineRef; failure_kind?: EngineFailureKind };
  [ChatEvent.QueuedMessageRemoved]: { waited_ms?: number };
  [ChatEvent.ChatStopRequested]: {
    via: StopVia;
    turn_age_ms?: number;
    streaming: boolean;
    waiting_card: WaitingCardKind;
    build_running: boolean;
    ignored: StopIgnored;
  };
  [ChatEvent.ChatStopSettled]: { latency_ms: number; ended_by: StopEndedBy; status?: TurnStatus };
  [ChatEvent.PermissionRequested]: {
    tool_category: ToolCategory;
    is_plan: boolean;
    from_worker: boolean;
    from_subagent: boolean;
    always_offered: boolean;
    cards_waiting: number;
  };
  [ChatEvent.PermissionAnswered]: {
    decision: PermissionDecision;
    with_message: boolean;
    plan_mode?: SteadyPermissionMode;
    wait_ms?: number;
    resolved: boolean;
  };
  [ChatEvent.CardSettledWithoutAnswer]: {
    card: WaitingCardKind;
    by: CardSettledBy;
    wait_ms?: number;
    tool_category?: ToolCategory;
    plugin_ref?: string;
  };
  [ChatEvent.ChatLeftWhileWaiting]: { card: WaitingCardKind; wait_ms: number; to: LeftTo; cards_waiting: number };
  [ChatEvent.PermissionModeChanged]: {
    from?: PermissionMode;
    to: PermissionMode;
    via: ModeVia;
    failed: boolean;
    /** Why a switch failed, when the session said. */
    code?: ModeSwitchFailure | null;
  };
  [ChatEvent.ChatQuestionAsked]: { choices: number; cards_waiting: number };
  [ChatEvent.ChatQuestionAnswered]: {
    via: QuestionVia;
    choice_index?: number;
    picked_recommended?: boolean;
    wait_ms?: number;
  };
  [ChatEvent.ChatQuestionDeferred]: { action: QuestionDeferral };
  [ChatEvent.PlanModeToggled]: { on: boolean; via: PlanModeVia };
  [ChatEvent.PlanReviewChanged]: {
    state: PlanReviewState;
    generation_ms?: number;
    revision_index: number;
    failure_kind?: EngineFailureKind;
  };
  [ChatEvent.PlanAnswered]: { action: PlanAction; wait_ms?: number; refused?: boolean };
  [ChatEvent.RewindOpened]: { messages_back: number };
  [ChatEvent.RewindPreviewed]: {
    files_state: RewindFilesState;
    files_stay_reason?: FilesStay;
    files_bucket?: CountBucket;
    outside_changes?: number;
    stops_build: boolean;
    /** A refused preview's code (`RewindRefusal`, `RewindBlock`, a plugin step's block); null when it had none. */
    code?: RewindCode | null;
  };
  [ChatEvent.RewindDecided]: {
    action: RewindAction;
    restore_files: boolean;
    default_overridden: boolean;
    failed: boolean;
    /** A failed rewind's code; null when it had none. */
    code?: RewindCode | null;
  };
  [ChatEvent.RewindCompleted]: { files_restored_bucket?: CountBucket; held_followups: number; undo_offered: boolean };
  [ChatEvent.RewindUndone]: { ok: boolean; code?: UndoRewindCode | null };
  [ChatEvent.ModelMenuClosed]: { from: ModelMenuFrom; picked: boolean; open_ms: number };
  [ChatEvent.ModelPicked]: {
    engine: EngineRef;
    engine_kind?: EngineKind;
    model: ModelRef;
    previous_engine: EngineRef;
    changed_engine: boolean;
    free: boolean;
    local: boolean;
    /** Within `AFTER_FAILURE_MS` of a turn that failed or hit a limit, or a plan that failed. */
    after_failure: boolean;
  };
  [ChatEvent.ModelSettingsChanged]: { setting: ModelSetting; effort?: string };
  [ChatEvent.ModelPickReplaced]: { engine: EngineRef; reason: ModelReplaced };
  [ChatEvent.LoopModeChanged]: { on: boolean; hours_bucket: HoursBucket; via: LoopVia };
  [ChatEvent.ChatSignInNeeded]: { engine: EngineRef; from: SignInFrom };
  [ChatEvent.SignInCardAction]: { action: SignInAction; engine: EngineRef };
  [ChatEvent.EngineFellBack]: { from: EngineRef; to: EngineRef; kind?: EngineFailureKind };
  [ChatEvent.ChatContextCompacted]: {
    trigger: CompactTrigger;
    native: boolean;
    failed: boolean;
    failure_kind?: EngineFailureKind;
    percent_before_bucket?: ContextBucket;
  };
  [ChatEvent.ChatOpened]: { load_ms: number; has_more_history: boolean; attempt: number; failed: boolean };
  [ChatEvent.ChatHistoryPaged]: { page_index: number; ms: number; failed: boolean };
  [ChatEvent.ComposerAttachmentsRejected]: { over_pictures: number; over_files: number; unlinked: number };
  [ChatEvent.MentionAdded]: { kind: MentionKind; origin?: MentionOrigin; at_cap: boolean };
  [ChatEvent.ChatCommandRun]: { state: CommandState; reported: boolean };
  [ChatEvent.ConsentAnswered]: {
    choice: ConsentChoice;
    /** The card's field was changed before the answer. */
    input_edited: boolean;
    wait_ms?: number;
    /** The answer reached a card still waiting; false when it had settled already (a timeout, a Stop). */
    resolved: boolean;
  };
};

/**
 * What the chat's observers are made with; a test passes its own memory, clock and recorder. The
 * observers themselves are `chat-observe.ts`'s `createChatObservers`, which reads this file's names.
 */
export interface ChatObserverOptions {
  memory?: ChatMemory;
  now?: () => number;
  send?: SendEvent;
}

/** An answer to a chat's open question: by which of its choices, or in the person's own words. */
export interface QuestionAnswer {
  thread: string | undefined;
  via: QuestionVia;
  index?: number;
}

/** `chat_question_answered` for an answer not counted yet for the open question, or null; the answer is noted. */
function answerToCount(
  memory: ChatMemory,
  answer: QuestionAnswer,
  at: number,
): { thread: string; properties: ChatEventProperties[typeof ChatEvent.ChatQuestionAnswered] } | null {
  const { thread } = answer;
  if (!thread || memory.answered.has(thread)) return null;
  try {
    return { thread, properties: questionAnsweredProperties(memory, { ...answer, thread }, at) };
  } catch {
    return null;
  }
}

/**
 * Send an answer to a chat's open question, unchanged, and count it as `chat_question_answered`
 * once the send went without failing, once per open question: an answer pressed again (after a
 * sign-in held the first back) is the same answer. A send that fails leaves the question unanswered.
 */
export async function sendQuestionAnswer(
  answer: QuestionAnswer,
  deliver: () => Promise<void>,
  options: ChatObserverOptions = {},
): Promise<void> {
  const memory = options.memory ?? chatMemory;
  const counted = answerToCount(memory, answer, (options.now ?? Date.now)());
  try {
    await deliver();
  } catch (error) {
    if (counted) memory.answered.delete(counted.thread);
    throw error;
  }
  if (counted) (options.send ?? track)(ChatEvent.ChatQuestionAnswered, counted.properties);
}
