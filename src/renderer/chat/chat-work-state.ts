/**
 * Is the chat itself working, and on what? "Working" is the chat's own work: a reply, a plan, a
 * stop, a question it waits on. A running build shows as the build, and Studio learning from one
 * is a quiet line, never "Thinking". Pure, so ChatPanel only reads the answer.
 */
import { RunState, type RunExecution } from "../../shared/run-state.ts";
import { CHAT_WORDS, PERSON_FIRST_WORDS, runIdIn } from "../words.ts";
import { type ActivityItem, type ConversationEntry, WORK_KIND, workHasResults } from "./conversation-entries.ts";

type WorkEntry = Extract<ConversationEntry, { kind: typeof WORK_KIND }>;

/** Studio's status line while it learns from a finished build. */
const LEARNING_STATUS = /^self-improving\b/i;

/** Is Studio learning from a build (a quiet line, not work)? */
export const isLearningStatus = (status: string): boolean => LEARNING_STATUS.test(status);

/**
 * The trailing work group, while it holds nothing to keep in view (a failed step, pictures, a
 * delivery): it is the work in progress.
 */
function openWork(entry: ConversationEntry | undefined): WorkEntry | null {
  if (entry?.kind !== WORK_KIND) return null;
  return workHasResults(entry) ? null : entry;
}

export interface ChatWorkInput {
  status: string;
  run: RunExecution | null;
  activeRunId: string | null;
  /** A send from this chat is in flight. */
  busy: boolean;
  /** A message on its way shows in the chat until its row arrives. */
  sending: boolean;
  /** Saved input is about to be answered (queued or processing, no build running). */
  answering: boolean;
  /** The harness says the thread works, or its build runs. */
  working: boolean;
  planWorking: boolean;
  revisingPlan: boolean;
  stopping: boolean;
  /** Consent questions waiting on the user. */
  questionsWaiting: boolean;
  /** The transcript as read, without the waiting follow-ups and questions. */
  readingEntries: readonly ConversationEntry[];
  /** A reply is streaming in after the transcript's last row. */
  streamingReply?: boolean;
}

export interface ChatWorkState {
  learning: boolean;
  /** The chat's own work is under way: the busy line shows. */
  chatWorking: boolean;
  /**
   * The chat is answering: its own input, plan, Stop or turn. A running build is not, nor a
   * question it waits on: Rewind is offered over them (and stops the build first).
   */
  answering: boolean;
  /** The composer can interrupt current work in this chat. */
  stoppable: boolean;
  /** The trailing work group the busy line folds in as its details, or null. */
  currentDetails: WorkEntry | null;
  /**
   * The steps the busy line names its work from: the trailing group's while the chat works, folded
   * in or kept in the transcript for its results.
   */
  workItems: ActivityItem[];
}

export function chatWorkState(input: ChatWorkInput): ChatWorkState {
  const { status, run, activeRunId, working } = input;
  const learning = isLearningStatus(status);
  // A settled run can keep its status through cleanup or learning; that is not active run work.
  const statusRun = runIdIn(status);
  const settledRunStatus = Boolean(statusRun && statusRun === run?.runId && run?.state !== RunState.Running);
  const waitingOnAnswer = input.questionsWaiting && Boolean(working || activeRunId);
  const ownTurnWorking = working && !activeRunId && !learning && !settledRunStatus;
  const stoppable =
    input.busy || (working && !settledRunStatus) || input.planWorking || input.answering || activeRunId !== null;
  const ownInput = input.busy || input.sending || input.answering;
  const planWork = input.planWorking || input.revisingPlan;
  const answering = ownInput || planWork || input.stopping || ownTurnWorking;
  const chatWorking = answering || waitingOnAnswer;
  // Work followed by a streaming reply is done: it stays in the transcript, above where the reply
  // lands, so nothing moves when the reply is saved.
  const trailing = chatWorking && !input.streamingReply ? input.readingEntries.at(-1) : undefined;
  const currentDetails = openWork(trailing);
  return {
    learning,
    chatWorking,
    answering: answering || (waitingOnAnswer && !activeRunId),
    stoppable,
    currentDetails,
    workItems: trailing?.kind === WORK_KIND ? trailing.items : [],
  };
}

/** The busy line's label: a stop, a send, a question, a wait for the person or a plan change comes before the work itself. */
export function busyLabel(state: {
  stopping: boolean;
  sending: boolean;
  questionsWaiting: boolean;
  revisingPlan: boolean;
  current: string;
  /** What the work waits for the person to finish in (a lock's label), when it does. */
  personFirst?: string | null;
}): string {
  if (state.stopping) return CHAT_WORDS.stopping;
  if (state.sending) return CHAT_WORDS.sending;
  if (state.questionsWaiting) return CHAT_WORDS.waitingForAnswer;
  if (state.personFirst) return PERSON_FIRST_WORDS.waiting(state.personFirst);
  if (state.revisingPlan) return CHAT_WORDS.describeChanges;
  return state.current;
}
