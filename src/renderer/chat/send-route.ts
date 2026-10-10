/**
 * Where a message from the composer goes: a note to the build the chat replies about, the held
 * plan's inbox, plan review, or the chat's queue with a bubble that shows at once.
 */
import { PlanReviewState } from "../../shared/composer.ts";
import { EntryAction, EntryKind } from "../chat-entries.ts";
import { loopCommissions } from "../loop-setting.ts";
import { autoChoice } from "../model-choices.ts";
import { noteSentWords, type ReplyAbout } from "../reply-about.ts";
import { type Notify, ToastTone } from "../state/toasts.ts";
import type { AutopilotSend, ComposerExtras } from "../ui/PromptBar.tsx";
import { problemWords } from "../words.ts";
import type { ConversationEntry } from "./conversation-entries.ts";
import { newClientId, type PendingSend, sendPlacement } from "./pending-sends.ts";
import type { ChatThread } from "./use-chat-thread.ts";
import type { ChatWorkView } from "./use-chat-work.ts";
import type { ComposerModel } from "./use-composer-model.ts";
import type { FollowScroll } from "./use-follow-scroll.ts";
import type { ReplyingAbout } from "./use-reply-about.ts";

/** A legacy in-run plan that holds the worker until it is answered. */
export const isHeldPlan = (entry: ConversationEntry, runId: string | null, now: number): boolean =>
  entry.kind === EntryKind.Action &&
  entry.action === EntryAction.Steer &&
  Boolean(entry.pending) &&
  entry.runId === runId &&
  (entry.expiresAt ?? 0) > now;

/** Plan states that take the next message as the plan's request (main routes it alike). */
const REVIEW_TAKES_MESSAGE: ReadonlySet<string> = new Set([
  PlanReviewState.Waiting,
  PlanReviewState.Generating,
  PlanReviewState.Failed,
]);

/** The model a send goes with: the pick, or for a timed build with no pick, the first usable one. */
export function sendKey(model: ComposerModel, extras: ComposerExtras | undefined): string | null {
  if (model.selected !== null) return model.selected;
  if (!extras?.autopilot) return null;
  return autoChoice(model.choices)?.key ?? null;
}

/**
 * A reply about the build is a note to it (the steering inbox), not a chat turn: it needs no
 * model and never waits behind the build. A failure keeps the words in the composer.
 */
async function sendNote(about: ReplyAbout, text: string, onNotice: Notify): Promise<void> {
  await window.studio
    .runFeedback({ threadId: about.threadId, runId: about.runId, ...about.target, text, label: about.label })
    .catch((err: unknown) => {
      onNotice(problemWords(err), ToastTone.Error);
      throw err;
    });
  onNotice(noteSentWords(about), ToastTone.Ok);
}

/** Where a send goes besides the chat's queue: plan review takes it as the plan's request. */
function sendRoute(chat: ChatThread, work: ChatWorkView, extras?: ComposerExtras) {
  // The one commission rule, applied again here for senders that bypass the composer's Mode.
  const commissions = loopCommissions(chat.run);
  const autopilot = commissions ? extras?.autopilot : undefined;
  const runOpen = !commissions;
  const review = work.plan.review;
  const reviewTakes = Boolean(review && REVIEW_TAKES_MESSAGE.has(review.state));
  const toPlanReview =
    !chat.isStudioThread && !runOpen && Boolean(extras?.reviewPlan || autopilot?.reviewPlan || reviewTakes);
  return { autopilot, toPlanReview };
}

/** The bubble a send shows at once, until its durable row arrives (`chat/pending-sends.ts`). */
function pendingSend(
  send: { clientId: string; threadId: string; text: string },
  chat: ChatThread,
  work: ChatWorkView,
  frames: { extras?: ComposerExtras; autopilot?: AutopilotSend },
): PendingSend {
  const attached = frames.extras?.frames?.length ? frames.extras.frames : frames.autopilot?.frames;
  return {
    ...send,
    after: chat.rawStateEvents.at(-1)?.id ?? null,
    placement: sendPlacement(work.line.chatWorking || Boolean(chat.activeRunId), chat.queue),
    ...(attached?.length ? { frames: attached } : {}),
  };
}

/** Send as a note to the build the chat replies about, when it does; true when it went. */
export async function sentAsNote(
  reply: ReplyingAbout,
  threadId: string | undefined,
  text: string,
  onNotice: Notify,
  follow: FollowScroll,
): Promise<boolean> {
  const { about } = reply;
  if (!about || about.threadId !== threadId) return false;
  await sendNote(about, text, onNotice);
  reply.drop(about.threadId);
  follow.jumpToLatest();
  return true;
}

/**
 * The bubble a message to the chat shows at once, and its id; none for the held plan's inbox or
 * for plan review, whose request shows in the plan.
 */
export function showSend(
  parts: { chat: ChatThread; work: ChatWorkView },
  text: string,
  extras: ComposerExtras | undefined,
  heldRun: string | null,
): string | undefined {
  const { chat, work } = parts;
  const { threadId } = chat;
  const { autopilot, toPlanReview } = sendRoute(chat, work, extras);
  if (!threadId || heldRun || toPlanReview) return undefined;
  const clientId = newClientId();
  chat.sends.add(pendingSend({ clientId, threadId, text }, chat, work, { extras, autopilot }));
  return clientId;
}
