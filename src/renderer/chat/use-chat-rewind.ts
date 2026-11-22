/**
 * Rewind goes back to any answered message, whenever the chat is not answering (a running build is
 * stopped first): the message and everything after it leave the chat, and its words come back to
 * the composer.
 */
import { type RefObject, useCallback, useMemo, useRef, useState } from "react";
import { type RewindResult, rewindableMessages } from "../../shared/chat-rewind.ts";
import { t } from "../../shared/i18n.ts";
import type { EventEnvelope } from "../types.ts";
import { type Notify, ToastTone } from "../state/toasts.ts";
import { chatMemory, noteRewound } from "../analytics/chat-memory.ts";
import { messagesBack, rewindCompletedProperties } from "../analytics/chat-properties.ts";
import { track } from "../analytics/client.ts";
import { AnalyticsEvent } from "../analytics/events.ts";
import { useKept } from "./kept-value.ts";
import { focusPromptEnd, promptInput, restorePictures } from "./put-back.ts";

/** The event a user bubble was written in: its entry id is `<event id>-<message index>:user` (chat-entries.ts). */
export const bubbleEvent = (entryId: string): string => entryId.replace(/-\d+:user(?::\d+)?$/, "");

export interface RewindTarget {
  threadId: string;
  eventId: string;
  messageId: string;
}

const restoredWords = (files: number): string =>
  t("{count, plural, one {Restored # game file.} other {Restored # game files.}}", { count: files });

export interface ChatRewind {
  /**
   * Whether a user bubble (by entry id) carries Rewind. It changes only with the messages that can
   * be rewound, so the transcript's rows are not drawn again each time an answer starts or ends.
   */
  offers: (entryId: string) => boolean;
  /** Rewind can be pressed now: the chat is between answers. The bubbles' buttons show only then. */
  available: boolean;
  /** Stable, so memoized bubbles do not re-render whenever the chat does. */
  open: (entryId: string) => void;
  target: RewindTarget | null;
  /** Where focus lands when the dialog closes: the composer after a rewind, else the Rewind button. */
  returnFocus: RefObject<HTMLElement | null>;
  rewound: (target: RewindTarget, result: RewindResult) => void;
  dismiss: () => void;
}

export function useChatRewind(input: {
  threadId: string | undefined;
  studio: boolean;
  threadEvents: EventEnvelope[];
  /** The chat is loaded and not answering (a build may be running): the moment between answers. */
  between: boolean;
  putBack: (threadId: string, text: string) => void;
  onNotice: Notify;
  jumpToLatest: () => void;
}): ChatRewind {
  const { threadId, studio, threadEvents, between } = input;
  const rewindable = useKept(
    useMemo(() => (studio ? new Map<string, string>() : rewindableMessages(threadEvents)), [threadEvents, studio]),
  );
  const [target, setTarget] = useState<RewindTarget | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const openNow = useRef<(entryId: string) => void>(() => {});
  openNow.current = (entryId) => {
    const eventId = bubbleEvent(entryId);
    const messageId = rewindable.get(eventId);
    returnFocus.current = null;
    if (!between || !threadId || !messageId) return;
    setTarget({ threadId, eventId, messageId });
    track(AnalyticsEvent.RewindOpened, { messages_back: messagesBack(threadEvents, eventId) });
  };
  const open = useCallback((entryId: string) => openNow.current(entryId), []);
  const rewound = (done: RewindTarget, result: RewindResult): void => {
    // The message comes back to be changed and sent again; a draft already there stays after it.
    input.putBack(done.threadId, result.text);
    noteRewound(chatMemory, done.threadId);
    track(AnalyticsEvent.RewindCompleted, rewindCompletedProperties(result));
    restorePictures(done.threadId, [
      { messageId: result.messageId, pickedImages: result.pickedImages },
      ...result.held,
    ]);
    returnFocus.current = promptInput();
    if (result.files) input.onNotice(restoredWords(result.files), ToastTone.Ok);
    input.jumpToLatest();
    focusPromptEnd();
  };
  const offers = useCallback(
    (entryId: string) => !studio && rewindable.has(bubbleEvent(entryId)),
    [studio, rewindable],
  );
  return {
    offers,
    available: between,
    open,
    target: target && target.threadId === threadId ? target : null,
    returnFocus,
    rewound,
    dismiss: () => setTarget(null),
  };
}
