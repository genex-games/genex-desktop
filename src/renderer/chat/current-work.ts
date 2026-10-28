import { type PlanReview, PlanReviewState } from "../../shared/composer.ts";
import { type ChatActivity, ChatActivityPhase } from "../../shared/chat-activity.ts";
import { t } from "../../shared/i18n.ts";
import type { RunSummary } from "../../shared/run-summary.ts";
import { type ActivityItem, ActivityItemKind } from "./conversation-entries.ts";
import { TaskState } from "./task-state.ts";
import { ToolState } from "../ui/tool-state.ts";
import { CHAT_WORDS, TOOL_ACTIVITY_WORDS, USING_A_TOOL } from "../words.ts";

/** Phases that say only that something is busy: the work itself can name them better. */
const GENERIC_PHASES: ReadonlySet<string> = new Set<ChatActivityPhase>([
  ChatActivityPhase.Thinking,
  ChatActivityPhase.Working,
  ChatActivityPhase.Idle,
  ChatActivityPhase.Tool,
]);
/** A tool phase's labels that name no tool. */
const GENERIC_TOOL_LABELS: ReadonlySet<string> = new Set([TOOL_ACTIVITY_WORDS.run, USING_A_TOOL]);
/** A running tool's own label, as the busy line says it. */
const TOOL_WORDS: ReadonlyMap<string, string> = new Map([
  [TOOL_ACTIVITY_WORDS.read, t("Reading the code")],
  [TOOL_ACTIVITY_WORDS.write, t("Editing the game")],
]);

/** What the plan under review is doing, when that is the chat's work. */
function planLabel(activity: ChatActivity, run: RunSummary | null, planState?: PlanReview["state"]): string | null {
  if (planState === PlanReviewState.Generating) return t("Preparing your plan");
  const starting = planState === PlanReviewState.Starting && activity.phase === ChatActivityPhase.Idle && !run;
  return starting ? t("Starting your build") : null;
}

/** The newest tool still running in the chat's own work, in words, or null. */
function runningToolLabel(items: ActivityItem[]): string | null {
  const current = items.findLast(
    (item) => item.kind === ActivityItemKind.Tool && item.tool.state === ToolState.Running,
  );
  if (current?.kind !== ActivityItemKind.Tool) return null;
  const label = current.tool.activeLabel ?? current.tool.label;
  return TOOL_WORDS.get(label) ?? label;
}

/** What the chat is doing, and whether that only says the lead is between parts. */
interface Work {
  label: string;
  betweenParts: boolean;
}

/** Phases whose own label only says the lead is busy: between parts, the build card says it is planning. */
const PLANNING_PHASES: ReadonlySet<ChatActivityPhase> = new Set<ChatActivityPhase>([
  ChatActivityPhase.Thinking,
  ChatActivityPhase.Working,
  ChatActivityPhase.Idle,
]);

/** Work a label names. */
const named = (label: string): Work => ({ label, betweenParts: false });

/** The activity's own label: between parts when it is a busy phase's own word, not work a record named. */
const activityWork = (activity: ChatActivity): Work => ({
  label: activity.label,
  betweenParts: PLANNING_PHASES.has(activity.phase) && !activity.named,
});

/** What a running build is doing: its one task, how many, or what comes next. */
function runWork(run: RunSummary, activity: ChatActivity): Work {
  const active = run.tasks.filter((task) => task.state === TaskState.Running);
  const [only] = active;
  if (active.length === 1 && only) return named(only.title);
  if (active.length > 1)
    return named(t("{count, plural, one {Working on # task} other {Working on # tasks}}", { count: active.length }));
  if (run.tasks.some((task) => task.state === TaskState.Queued)) return named(t("Preparing the next task"));
  const idle = activity.phase === ChatActivityPhase.Idle && !activity.named;
  return idle ? { label: t("Working"), betweenParts: true } : activityWork(activity);
}

/** Explicit conversation activity wins. A run's generic busy state names the actual work. */
function currentWork(
  activity: ChatActivity,
  run: RunSummary | null,
  finishing: boolean,
  items: ActivityItem[],
  planState?: PlanReview["state"],
): Work {
  const plan = planLabel(activity, run, planState);
  if (plan) return named(plan);
  if (finishing) return named(t("Finishing up"));
  if (!GENERIC_PHASES.has(activity.phase)) return activityWork(activity);
  const toolPhase = activity.phase === ChatActivityPhase.Tool;
  if (toolPhase && !GENERIC_TOOL_LABELS.has(activity.label)) return activityWork(activity);
  const tool = runningToolLabel(items);
  if (tool !== null) return named(tool);
  if (toolPhase || !run) return activityWork(activity);
  return runWork(run, activity);
}

/** What the chat's busy line says: explicit conversation activity wins, a run's generic busy state names the actual work. */
export function currentWorkLabel(
  activity: ChatActivity,
  run: RunSummary | null,
  finishing: boolean,
  items: ActivityItem[] = [],
  planState?: PlanReview["state"],
): string {
  return currentWork(activity, run, finishing, items, planState).label;
}

/**
 * The one line in the chat's build card: what is happening right now, one thing at a time. A part
 * at work names itself; between parts the lead is planning, or doing what its tool says it is.
 */
export function buildCaption(
  activity: ChatActivity,
  run: RunSummary | null,
  finishing: boolean,
  items: ActivityItem[] = [],
  planState?: PlanReview["state"],
): string {
  if (finishing) return t("Finishing up");
  const running = run?.tasks.filter((task) => task.state === TaskState.Running) ?? [];
  const [first] = running;
  if (first && running.length === 1) return t("{task} · working", { task: first.title });
  if (first)
    return t("{count, plural, other {{task} and # more · working}}", { task: first.title, count: running.length - 1 });
  const work = currentWork(activity, run, finishing, items, planState);
  if (work.betweenParts) return CHAT_WORDS.planningNextStep;
  // A label that names no tool: the lead is working on the build.
  if (GENERIC_TOOL_LABELS.has(work.label)) return t("Working on the build");
  return work.label;
}
