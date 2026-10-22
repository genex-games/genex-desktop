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
import { COMPOSE_FRAMES_EVENT } from "../ui/PromptBar.tsx";

/** The event a user bubble was written in: its entry id is `<event id>-<message index>:user` (chat-entries.ts). */
export const bubbleEvent = (entryId: string): string => entryId.replace(/-\d+:user(?::\d+)?$/, "");

/** The composer's prompt, where a rewound message comes back. */
const promptInput = (): HTMLTextAreaElement | null => document.querySelector("[data-promptbar] textarea");

export interface RewindTarget {
  threadId: string;
  eventId: string;
  messageId: string;
}

/** Only the pictures the composer had attached come back: the rest came from paths the text still names. */
function restorePictures(threadId: string, result: RewindResult): void {
  for (const sent of [{ messageId: result.messageId, pickedImages: result.pickedImages }, ...result.held]) {
    if (!sent.pickedImages) continue;
    void window.studio
      .messageImages(threadId, sent.messageId)
      .then((frames) =>
        window.dispatchEvent(
          new CustomEvent(COMPOSE_FRAMES_EVENT, {
            detail: { conversationKey: threadId, frames: frames.slice(0, sent.pickedImages) },
          }),
        ),
      )
      .catch(() => {});
  }
}

const restoredWords = (files: number): string =>
  t("{count, plural, one {Restored # game file.} other {Restored # game files.}}", { count: files });

export interface ChatRewind {
  /** Whether a user bubble (by entry id) offers Rewind now. */
  offers: (entryId: string) => boolean;
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
  const rewindable = useMemo(
    () => (studio ? new Map<string, string>() : rewindableMessages(threadEvents)),
    [threadEvents, studio],
  );
  const [target, setTarget] = useState<RewindTarget | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const openNow = useRef<(entryId: string) => void>(() => {});
  openNow.current = (entryId) => {
    const eventId = bubbleEvent(entryId);
    const messageId = rewindable.get(eventId);
    returnFocus.current = null;
    if (threadId && messageId) setTarget({ threadId, eventId, messageId });
  };
  const open = useCallback((entryId: string) => openNow.current(entryId), []);
  const rewound = (done: RewindTarget, result: RewindResult): void => {
    // The message comes back to be changed and sent again; a draft already there stays after it.
    input.putBack(done.threadId, result.text);
    restorePictures(done.threadId, result);
    returnFocus.current = promptInput();
    if (result.files) input.onNotice(restoredWords(result.files), ToastTone.Ok);
    input.jumpToLatest();
    requestAnimationFrame(() => {
      const prompt = promptInput();
      prompt?.focus();
      prompt?.setSelectionRange(prompt.value.length, prompt.value.length);
    });
  };
  const offers = useCallback(
    (entryId: string) => !studio && between && rewindable.has(bubbleEvent(entryId)),
    [studio, between, rewindable],
  );
  return {
    offers,
    open,
    target: target && target.threadId === threadId ? target : null,
    returnFocus,
    rewound,
    dismiss: () => setTarget(null),
  };
}
