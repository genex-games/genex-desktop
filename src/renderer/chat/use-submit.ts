import { MessageOrigin } from "../../shared/protocol.ts";
import { RunState } from "../../shared/run-state.ts";
import { SendBlock, SendRoute, SendSource } from "../analytics/chat-vocabulary.ts";
import { chatLoopExtras, loopAvailableFor, loopCommissions, reportCommissions } from "../loop-setting.ts";
import { browserStorage } from "../storage.ts";
import type { ComposerExtras } from "../ui/PromptBar.tsx";
import type { ChatPanelProps } from "./chat-panel-props.ts";
import { type SendParts, sendTracking, sourceOf, trackSendBlocked } from "./send-analytics.ts";
import { isHeldPlan, sendDestination, sendKey, sentAsNote, showSend } from "./send-route.ts";
import type { ChatComposerState } from "./use-chat-composer.ts";
import type { ChatThread } from "./use-chat-thread.ts";
import type { ChatWorkView } from "./use-chat-work.ts";
import { type ComposerModel, composerSendOptions } from "./use-composer-model.ts";
import type { FollowScroll } from "./use-follow-scroll.ts";
import type { ReplyingAbout } from "./use-reply-about.ts";

/**
 * The composer's send: the text, what it carries, whether the draft stays in the box, and who
 * sent it (the person at the composer unless the caller says otherwise).
 */
export type Send = (
  text: string,
  extras?: ComposerExtras,
  preserveDraft?: boolean,
  source?: SendSource,
) => Promise<void>;

/** The same send, answering true once the message went to the chat (false: a sign-in first, a note, nothing to send with). */
export type SendAnswered = (
  text: string,
  extras?: ComposerExtras,
  preserveDraft?: boolean,
  source?: SendSource,
) => Promise<boolean>;

/** A routed message on its way: to the held plan's inbox, or to the chat with the model it goes with. */
async function deliverSend(
  props: ChatPanelProps,
  chat: ChatThread,
  model: ComposerModel,
  send: {
    text: string;
    key: string | null;
    extras: ComposerExtras | undefined;
    heldRun: string | null;
    clientId?: string;
  },
): Promise<void> {
  const { text, key, extras, heldRun, clientId } = send;
  if (chat.threadId && heldRun) {
    await window.studio.runFeedback({ threadId: chat.threadId, runId: heldRun, text });
    return;
  }
  const options = { autopilot: loopCommissions(chat.run), ...(extras ? { extras } : {}) };
  await props.onSend(text, { ...composerSendOptions(model, key, options), ...(clientId ? { clientId } : {}) });
  if (clientId) chat.sends.settle(clientId);
}

/**
 * Send from the composer: a note to the build it replies about, else a sign-in first when one is
 * needed, else to the held plan or the chat. A message to the chat shows at once.
 */
export function useSubmit(
  props: ChatPanelProps,
  chat: ChatThread,
  composer: ChatComposerState,
  work: ChatWorkView,
  follow: FollowScroll,
  reply: ReplyingAbout,
): SendAnswered {
  const { threadId, activeRunId, transcript } = chat;
  const { drafts, model, gate } = composer;
  const parts: SendParts = { props, chat, composer, work };
  const startSend = (key: string | null, preserveDraft: boolean): void => {
    if (!threadId) return;
    follow.jumpToLatest();
    drafts.setSending(threadId, true);
    if (!preserveDraft) drafts.clearDraft(threadId);
    if (key) model.remember(threadId, key);
  };
  const endSend = (): void => {
    if (threadId) drafts.setSending(threadId, false);
  };
  // A legacy in-run plan is already holding the worker. Its answer goes straight to
  // that run's inbox, rather than waiting in the queue behind the held build.
  const heldPlanRun = (): string | null => {
    if (!activeRunId) return null;
    const now = Date.now();
    return transcript.entries.some((entry) => isHeldPlan(entry, activeRunId, now)) ? activeRunId : null;
  };
  // Keep building is the person asking the build to go on: never a note to the build in reply.
  const asNote = (text: string, extras: ComposerExtras | undefined): Promise<boolean> =>
    extras?.autopilot?.keepBuilding === true
      ? Promise.resolve(false)
      : sentAsNote(reply, threadId, text, props.onNotice, follow);
  // A note to the build, a sign-in first, or no model to send with: the send ends here.
  const goesNowhere = async (text: string, extras: ComposerExtras | undefined, source: SendSource) => {
    if (await asNote(text, extras)) {
      sendTracking(parts, { text, extras, key: model.selected, source, route: SendRoute.NoteToBuild }).sent();
      return true;
    }
    if (gate.needsSignIn) {
      trackSendBlocked(parts, SendBlock.SignInNeeded, model.selected);
      await gate.signIn();
      return true;
    }
    if (sendKey(model, extras) || extras?.autopilot) return false;
    trackSendBlocked(parts, SendBlock.NoModel, null);
    return true;
  };
  return async (text, extras, preserveDraft = false, source = sourceOf(extras)) => {
    if (await goesNowhere(text, extras, source)) return false;
    const key = sendKey(model, extras);
    // The held plan's inbox takes words only: pictures alone go to the chat.
    const heldRun = text.trim() ? heldPlanRun() : null;
    const destination = sendDestination({ chat, work }, text, extras, heldRun);
    const clientId = showSend({ chat, work }, text, extras, heldRun);
    const tracking = sendTracking(parts, { text, extras, key, source, ...destination, clientId });
    startSend(key, preserveDraft);
    try {
      await deliverSend(props, chat, model, { text, key, extras, heldRun, ...(clientId ? { clientId } : {}) });
      tracking.sent();
      return true;
    } catch (error) {
      // The composer gets the text back (PromptBar) and the chat says why (main): no bubble stays.
      if (clientId) chat.sends.drop(clientId);
      tracking.failed(error);
      throw error;
    } finally {
      endSend();
    }
  };
}

/** Who wrote a report the chat sends itself, as `message_sent` names it. */
const REPORT_SOURCE: Readonly<Record<MessageOrigin, SendSource>> = {
  [MessageOrigin.CommandResult]: SendSource.CommandResult,
  [MessageOrigin.PluginTurnedOn]: SendSource.PluginTurnedOn,
  [MessageOrigin.SetupCard]: SendSource.SetupCard,
  [MessageOrigin.TagRetry]: SendSource.TagRetry,
};

/** Sends words the chat wrote itself, marked with who wrote them. */
export type Report = (text: string, origin: MessageOrigin) => Promise<void>;

/**
 * Send words the chat wrote itself (a command's result): to the agent with the chat's model, as a
 * plain chat message, with no bubble, no draft change and no reply-about note. It carries the chat's
 * Loop only before the chat's first build, and never reopens one (`reportCommissions`).
 */
export function useReport(
  props: ChatPanelProps,
  chat: ChatThread,
  composer: ChatComposerState,
  work?: ChatWorkView,
): Report {
  const { model } = composer;
  const { threadId, run } = chat;
  return async (text: string, origin: MessageOrigin): Promise<void> => {
    const key = sendKey(model, undefined);
    if (!key || !threadId) return;
    const extras = chatLoopExtras({
      storage: browserStorage(),
      threadId,
      build: composer.build,
      coordinating: run?.state === RunState.Running,
      gameMode: !chat.isStudioThread,
      loopAvailable: loopAvailableFor(chat.folder),
    });
    const options = { autopilot: reportCommissions(run), extras };
    const source = REPORT_SOURCE[origin];
    const parts = { props, chat, composer, ...(work ? { work } : {}) };
    const tracking = sendTracking(parts, { text, extras, key, source, route: SendRoute.Chat });
    try {
      await props.onSend(text, { ...composerSendOptions(model, key, options), origin });
    } catch (error) {
      tracking.failed(error);
      throw error;
    }
    tracking.sent();
  };
}
