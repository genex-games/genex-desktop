import type { MessageOrigin } from "../../shared/protocol.ts";
import { RunState } from "../../shared/run-state.ts";
import { chatLoopExtras, loopAvailableFor, loopCommissions, reportCommissions } from "../loop-setting.ts";
import { browserStorage } from "../storage.ts";
import type { ComposerExtras } from "../ui/PromptBar.tsx";
import type { ChatPanelProps } from "./chat-panel-props.ts";
import { isHeldPlan, sendKey, sentAsNote, showSend } from "./send-route.ts";
import type { ChatComposerState } from "./use-chat-composer.ts";
import type { ChatThread } from "./use-chat-thread.ts";
import type { ChatWorkView } from "./use-chat-work.ts";
import { composerSendOptions } from "./use-composer-model.ts";
import type { FollowScroll } from "./use-follow-scroll.ts";
import type { ReplyingAbout } from "./use-reply-about.ts";

/** The composer's send: the text, what it carries, and whether the draft stays in the box. */
export type Send = (text: string, extras?: ComposerExtras, preserveDraft?: boolean) => Promise<void>;

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
): Send {
  const { threadId, activeRunId, run, transcript } = chat;
  const { drafts, model, gate } = composer;
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
  const { sends } = chat;
  const deliver = async (
    text: string,
    key: string | null,
    extras: ComposerExtras | undefined,
    route: { heldRun: string | null; clientId: string | undefined },
  ): Promise<void> => {
    const { heldRun, clientId } = route;
    if (threadId && heldRun) {
      await window.studio.runFeedback({ threadId, runId: heldRun, text });
      return;
    }
    const options = { autopilot: loopCommissions(run), ...(extras ? { extras } : {}) };
    await props.onSend(text, { ...composerSendOptions(model, key, options), ...(clientId ? { clientId } : {}) });
    if (clientId) sends.settle(clientId);
  };
  return async (text, extras, preserveDraft = false) => {
    if (await sentAsNote(reply, threadId, text, props.onNotice, follow)) return;
    if (gate.needsSignIn) {
      await gate.signIn();
      return;
    }
    const key = sendKey(model, extras);
    if (!key && !extras?.autopilot) return;
    const heldRun = heldPlanRun();
    const clientId = showSend({ chat, work }, text, extras, heldRun);
    startSend(key, preserveDraft);
    try {
      await deliver(text, key, extras, { heldRun, clientId });
    } catch (error) {
      // The composer gets the text back (PromptBar) and the chat says why (main): no bubble stays.
      if (clientId) sends.drop(clientId);
      throw error;
    } finally {
      endSend();
    }
  };
}

/**
 * Send words the chat wrote itself (a command's result): to the agent with the chat's model, as a
 * plain chat message, with no bubble, no draft change and no reply-about note. It carries the chat's
 * Loop only before the chat's first build, and never reopens one (`reportCommissions`).
 */
/** Sends words the chat wrote itself, marked with who wrote them. */
export type Report = (text: string, origin: MessageOrigin) => Promise<void>;

export function useReport(props: ChatPanelProps, chat: ChatThread, composer: ChatComposerState): Report {
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
    await props.onSend(text, { ...composerSendOptions(model, key, options), origin });
  };
}
