import { useMemo } from "react";
import { ChatActivityPhase, chatActivity } from "../../shared/chat-activity.ts";
import { useRunSummary } from "../use-run-summary.ts";
import { statusWords } from "../words.ts";
import type { ChatPanelProps } from "./chat-panel-props.ts";
import { useChatStop } from "./chat-stop.ts";
import { busyLabel, chatWorkState } from "./chat-work-state.ts";
import type { ChatWorkProps } from "./ChatWork.tsx";
import { buildCaption, currentWorkLabel } from "./current-work.ts";
import { currentWorkItems, finishingRun, runBudgetMs, runStartedAt } from "./transcript.ts";
import type { ChatThread } from "./use-chat-thread.ts";
import { usePlanReview } from "./use-plan-review.ts";

const NO_ITEMS: NonNullable<ChatWorkProps["details"]> = [];

/**
 * What the chat is doing: the harness's phase, the running build and its lead's screen, the plan
 * under review, Stop, and whether the busy line shows and what it says.
 */
export function useChatWork(props: ChatPanelProps, chat: ChatThread, busy: boolean, streamingReply = false) {
  const { status, onNotice } = props;
  const { threadId, threadEvents, activeRunId, working, transcript, answering } = chat;
  // The busy line: the harness's own phase, in the user's words.
  const activity = useMemo(
    () => chatActivity(threadEvents, working || busy || answering, statusWords(status).line),
    [threadEvents, working, busy, answering, status],
  );
  const outcome = useRunSummary(chat.project, activeRunId);
  const plan = usePlanReview(threadEvents, threadId);
  const running = activeRunId !== null;
  // Stop immediately hands work to the oldest queued follow-up; an empty queue stays idle.
  const stop = useChatStop({
    threadId: threadId ?? null,
    runId: activeRunId,
    working: working || busy || running,
    turnInFlight: busy || working || plan.working || answering,
    events: threadEvents,
    onNotice,
  });
  const questionsWaiting = transcript.pendingConsents.length > 0 || transcript.pendingPermissions.length > 0;
  const state = chatWorkState({
    status,
    run: chat.run,
    activeRunId,
    busy,
    sending: chat.sends.sending,
    answering,
    working,
    planWorking: plan.working,
    revisingPlan: plan.revising,
    stopping: stop.stopping,
    questionsWaiting,
    readingEntries: transcript.readingEntries,
    streamingReply,
  });
  const { currentDetails } = state;
  const visibleEntries = useMemo(
    () => (currentDetails ? transcript.readingEntries.slice(0, -1) : transcript.readingEntries),
    [transcript.readingEntries, currentDetails],
  );
  const words = useWorkWords(chat, {
    activity,
    outcome,
    details: state.workItems.length ? state.workItems : NO_ITEMS,
    plan: plan.review,
  });
  const showsWork = state.chatWorking || running;
  const current = showsWork ? words.current : "";
  const waitsOnUser = questionsWaiting || plan.revising;
  const sending = chat.sends.sending;
  const line: ChatWorkProps = {
    chatWorking: state.chatWorking,
    learning: state.learning,
    activeRunId,
    workKey: plan.working ? plan.review?.id : (activeRunId ?? threadId),
    label: busyLabel({ stopping: stop.stopping, sending, questionsWaiting, revisingPlan: plan.revising, current }),
    caption: running ? words.caption : "",
    waiting: waitsOnUser || (!plan.working && activity.phase === ChatActivityPhase.Waiting),
    busySince: props.busySince,
    details: currentDetails?.items ?? null,
    learningLine: statusWords(status).line,
    runStarted: words.runStarted,
    budgetMs: words.budgetMs,
    project: chat.project,
    onShowBuilds: props.onShowBuilds,
  };
  return {
    activity,
    plan,
    stop,
    line,
    visibleEntries,
    answering: state.answering,
    stoppable: state.stoppable,
  };
}

/**
 * What the work says: the busy line's current work, and for a running build its caption, when it
 * started and the time it was given.
 */
function useWorkWords(
  chat: ChatThread,
  input: {
    activity: ReturnType<typeof chatActivity>;
    outcome: ReturnType<typeof useRunSummary>;
    details: NonNullable<ChatWorkProps["details"]>;
    plan: ReturnType<typeof usePlanReview>["review"];
  },
) {
  const { threadEvents, stateEvents, activeRunId } = chat;
  const { activity, outcome, details, plan } = input;
  const runStarted = useMemo(
    () => runStartedAt(threadEvents, activeRunId, outcome?.worked),
    [threadEvents, activeRunId, outcome?.worked],
  );
  const budgetMs = useMemo(() => runBudgetMs(threadEvents, activeRunId), [threadEvents, activeRunId]);
  const workItems = useMemo(
    () => currentWorkItems(stateEvents, outcome, activeRunId, details),
    [stateEvents, outcome, activeRunId, details],
  );
  const finishing = useMemo(() => finishingRun(threadEvents, activeRunId), [threadEvents, activeRunId]);
  return {
    current: currentWorkLabel(activity, outcome, finishing, workItems, plan?.state),
    caption: buildCaption(activity, outcome, finishing, workItems, plan?.state),
    runStarted,
    budgetMs,
  };
}

/** The chat's work as the panel's hooks and parts read it. */
export type ChatWorkView = ReturnType<typeof useChatWork>;
