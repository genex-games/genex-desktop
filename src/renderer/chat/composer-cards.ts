/** What the cards docked above the composer do: the plan's answers, the consent buttons and Claude's permission answers. */
import type { RefObject } from "react";
import type { ToolPermissionAnswer } from "../../shared/permissions.ts";
import type { PromptBarHandle } from "../ui/PromptBar.tsx";
import { CHAT_WORDS } from "../words.ts";
import type { PlanPrompt } from "./ComposerDock.tsx";
import type { ChatParts } from "./use-chat-panel.ts";
import { planAwaitsAnswer } from "./use-plan-review.ts";

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
    onRetry: () => submit(review.text, { reviewPlan: true }, true),
    onChooseModel: () => composerRef.current?.openModelMenu(),
    onRevise: () => {
      plan.startRevising();
      follow.jumpToLatest();
      requestAnimationFrame(focusComposer);
    },
  };
}

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
): Promise<void> {
  const { resolved } = await window.studio.pluginConsent(consentId, approved, always, input);
  if (!resolved) throw new Error(CHAT_WORDS.consentSettled);
}

/**
 * Claude's own Allow / Deny questions settle the same way: one that already settled (answered
 * elsewhere, or withdrawn by Stop, the turn's end or a restart) says so.
 */
export async function answerPermission(requestId: string, answer: ToolPermissionAnswer): Promise<void> {
  const { resolved } = await window.studio.answerPermission(requestId, answer);
  if (!resolved) throw new Error(CHAT_WORDS.consentSettled);
}
