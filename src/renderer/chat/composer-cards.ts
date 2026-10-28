/** What the cards docked above the composer do: the plan's answers, the consent buttons and Claude's permission answers. */
import type { RefObject } from "react";
import type { ToolPermissionAnswer } from "../../shared/permissions.ts";
import { cardWait, chatMemory } from "../analytics/chat-memory.ts";
import { permissionAnsweredProperties, planAnsweredProperties } from "../analytics/chat-properties.ts";
import { PlanAction, SendSource } from "../analytics/chat-vocabulary.ts";
import { track } from "../analytics/client.ts";
import { AnalyticsEvent } from "../analytics/events.ts";
import type { PromptBarHandle } from "../ui/PromptBar.tsx";
import { CHAT_WORDS } from "../words.ts";
import { ConsentChoice } from "./consent-card.ts";
import type { PlanPrompt } from "./ComposerDock.tsx";
import type { ChatParts } from "./use-chat-panel.ts";
import { planAwaitsAnswer } from "./use-plan-review.ts";

/** What the person did on a plan card, counted against how long the plan waited. */
export function trackPlanAction(review: string, action: PlanAction): void {
  track(AnalyticsEvent.PlanAnswered, planAnsweredProperties(chatMemory, { review, action }, Date.now()));
}

/** The plan card's answers, while a plan waits for the user. */
export function planPrompt(
  { work, follow, submit, focusComposer }: ChatParts,
  composerRef: RefObject<PromptBarHandle | null>,
): PlanPrompt | null {
  const { plan } = work;
  const review = planAwaitsAnswer(plan.review) ? plan.review : null;
  if (!review) return null;
  return {
    review,
    busy: plan.answering,
    revising: plan.revising,
    onAnswer: plan.answer,
    onRetry: () => {
      trackPlanAction(review.id, PlanAction.TryAgain);
      return submit(review.text, { reviewPlan: true }, true, SendSource.PlanRetry);
    },
    onChooseModel: () => {
      trackPlanAction(review.id, PlanAction.ChooseModel);
      composerRef.current?.openModelMenu();
    },
    onRevise: () => {
      trackPlanAction(review.id, PlanAction.MakeChanges);
      plan.startRevising();
      follow.jumpToLatest();
      requestAnimationFrame(focusComposer);
    },
  };
}

/** The consent card's answer as its buttons name it. */
const consentChoice = (approved: boolean, always: boolean): ConsentChoice => {
  if (!approved) return ConsentChoice.Decline;
  return always ? ConsentChoice.Always : ConsentChoice.Once;
};

/**
 * The consent card's answer, with the person's edit of its field when it has one. A question that
 * already settled (answered elsewhere, timed out, or withdrawn by Stop) says so instead of
 * pretending the click counted.
 */
export async function answerConsent(
  consentId: string,
  approved: boolean,
  always = false,
  input?: string,
  inputEdited = false,
): Promise<void> {
  const { resolved } = await window.studio.pluginConsent(consentId, approved, always, input);
  const waitMs = cardWait(chatMemory, consentId, Date.now());
  track(AnalyticsEvent.ConsentAnswered, {
    choice: consentChoice(approved, always),
    input_edited: inputEdited,
    ...(waitMs === undefined ? {} : { wait_ms: waitMs }),
    resolved,
  });
  if (!resolved) throw new Error(CHAT_WORDS.consentSettled);
}

/**
 * Claude's own Allow / Deny questions settle the same way: one that already settled (answered
 * elsewhere, or withdrawn by Stop, the turn's end or a restart) says so.
 */
export async function answerPermission(requestId: string, answer: ToolPermissionAnswer): Promise<void> {
  const { resolved } = await window.studio.answerPermission(requestId, answer);
  const waitMs = cardWait(chatMemory, requestId, Date.now());
  track(AnalyticsEvent.PermissionAnswered, permissionAnsweredProperties(answer, { resolved, waitMs }));
  if (!resolved) throw new Error(CHAT_WORDS.consentSettled);
}
