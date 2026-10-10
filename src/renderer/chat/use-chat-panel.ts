/**
 * The chat panel's hooks, wired in order: the open thread, its composer, its work, following the
 * newest entry, replies about a build, words left for the composer, sending and Rewind.
 * `ChatPanel` draws what this returns.
 */
import { useCallback, useRef, useState } from "react";
import type { PromptBarHandle } from "../ui/PromptBar.tsx";
import type { ChatPanelProps } from "./chat-panel-props.ts";
import { type ChatComposerState, useChatComposer } from "./use-chat-composer.ts";
import { useChatExport } from "./use-chat-export.ts";
import { type ChatRewind, useChatRewind } from "./use-chat-rewind.ts";
import { type ChatThread, useChatThread } from "./use-chat-thread.ts";
import { type ChatWorkView, useChatWork } from "./use-chat-work.ts";
import { type FollowScroll, useFollowScroll } from "./use-follow-scroll.ts";
import { type ReplyingAbout, useReplyAbout } from "./use-reply-about.ts";
import { useCommandResults } from "./use-command-results.ts";
import { useComposeInChat } from "./use-compose-in-chat.ts";
import { useLaunchHandover } from "./use-launch-handover.ts";
import { type Send, useReport, useSubmit } from "./use-submit.ts";

/** Whether a reply is being written on screen, as the streaming reply reports it. */
export interface StreamShowing {
  showing: boolean;
  onShowing: (showing: boolean) => void;
}

/** What the chat's parts share: the panel's props and the state the panel derived from them. */
export interface ChatParts {
  props: ChatPanelProps;
  chat: ChatThread;
  composer: ChatComposerState;
  work: ChatWorkView;
  follow: FollowScroll;
  submit: Send;
  focusComposer: () => void;
  reply: ReplyingAbout;
  rewind: ChatRewind;
  stream: StreamShowing;
}

/** The chat panel's state: the parts it draws, its composer handle and the header's export. */
export function useChatPanel(props: ChatPanelProps) {
  const { history, loading } = props;
  const ownComposer = useRef<PromptBarHandle>(null);
  const composerRef = props.composer ?? ownComposer;
  const chat = useChatThread(props);
  const composer = useChatComposer(props, chat);
  const busy = composer.drafts.busy;
  const chatExport = useChatExport(props.onNotice);
  const [streaming, setStreaming] = useState(false);
  const work = useChatWork(props, chat, busy, streaming);
  const follow = useFollowScroll({
    threadId: chat.threadId,
    count: chat.transcript.entries.length,
    working: chat.working,
    loading,
    history,
  });
  const focusComposer = useCallback((): void => composerRef.current?.focus(), [composerRef]);
  const reply = useReplyAbout(chat.threadId, focusComposer);
  useComposeInChat(chat.threadId, chat.project, composer.drafts, composerRef);
  const submit = useSubmit(props, chat, composer, work, follow, reply);
  const report = useReport(props, chat, composer);
  useLaunchHandover(chat.threadId, loading, submit, composerRef);
  useCommandResults(chat.threadId ?? null, !chat.isStudioThread, report, props.onNotice);
  const rewind = useChatRewind({
    threadId: chat.threadId,
    studio: chat.isStudioThread,
    threadEvents: chat.threadEvents,
    // A running build is between answers too: confirming a rewind stops it first.
    between: !loading && !work.answering,
    putBack: composer.drafts.putBack,
    onNotice: props.onNotice,
    jumpToLatest: follow.jumpToLatest,
  });
  const stream = { showing: streaming, onShowing: setStreaming };
  const parts: ChatParts = { props, chat, composer, work, follow, submit, focusComposer, reply, rewind, stream };
  return { parts, composerRef, chatExport };
}
