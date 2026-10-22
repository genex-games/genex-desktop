import type { AutopilotCommission, LoopCommission, MessageOrigin, ReferenceFrame } from "./protocol.ts";
import type { ModelPreferences } from "./model-preferences.ts";
import type { MentionRef } from "./prompt-mention.ts";
/** One send contract from the renderer through preload to the host. */
export interface ComposerSendOptions {
  thread?: string;
  engine?: string;
  model?: string;
  effort?: string;
  preferences?: ModelPreferences;
  project?: string;
  newProject?: boolean;
  resume?: string;
  loop?: LoopCommission;
  autopilot?: AutopilotCommission;
  reviewPlan?: boolean;
  frames?: ReferenceFrame[];
  /** The games, tools and assets the message tags with @ (`shared/prompt-mention.ts`). */
  mentions?: MentionRef[];
  /** The renderer's id for its optimistic bubble; the queue records the message under it. */
  clientId?: string;
  /** Words the chat wrote itself rather than the user; absent for the user's own. */
  origin?: MessageOrigin;
}
/**
 * What an approved plan's message puts between the user's request and the plan
 * (`main/plan-review-prompts.ts`); a rewind gives back only the request before it.
 */
export const APPROVED_PLAN_HEADING = "\n\nUser-approved implementation plan:\n";
/** Where a plan review stands (`plan_review` records carry it). Persisted: never rename a value. */
export const PlanReviewState = {
  /** The lead is writing the plan. */
  Generating: "generating",
  /** The plan waits for the user's answer. */
  Waiting: "waiting",
  /** Approved, and the run is starting. */
  Starting: "starting",
  Approved: "approved",
  Cancelled: "cancelled",
  Failed: "failed",
} as const;
export type PlanReviewState = (typeof PlanReviewState)[keyof typeof PlanReviewState];

export interface PlanReview {
  id: string;
  state: PlanReviewState;
  text: string;
  plan?: string;
  error?: string;
  options: ComposerSendOptions;
}
/** A plan review as the log records it (`plan_review`): the whole review except its send options. */
export type PlanReviewRecord = Omit<PlanReview, "options">;
/** A recorded review the composer can act on: it names its id, its state and the request. */
export function isPlanReviewRecord(review: Partial<PlanReviewRecord>): review is PlanReviewRecord {
  return typeof review.id === "string" && typeof review.state === "string" && typeof review.text === "string";
}
