import { useState, type ReactNode } from "react";
import { IconButton } from "../ui/kit.tsx";
import { UserMessage } from "../chat/UserMessage.tsx";
import { type Notify, notifyProblem } from "../state/toasts.ts";
import type { ReferenceFrame } from "../../shared/protocol.ts";
import { CHAT_WORDS } from "../words.ts";
import { t } from "../../shared/i18n.ts";

/** The line under a follow-up until the work reads it: Sending…, always 24px tall (Remove's height), so nothing moves. */
function SendingLine({ children }: { children?: ReactNode }) {
  return (
    <div className="flex min-h-6 items-center gap-0.5 text-xs text-ink-3">
      <span role="status">{CHAT_WORDS.sendingMessage}</span>
      {children}
    </div>
  );
}

/** Sent during work and not saved yet: it waits where it will wait once saved. */
export function SendingMessage({ text, frames }: { text: string; frames?: ReferenceFrame[] }) {
  return (
    <div data-sending-message className="flex min-w-0 flex-col items-end gap-0.5">
      <UserMessage text={text} pending frames={frames} />
      <SendingLine />
    </div>
  );
}

/**
 * A saved follow-up waiting below the current work: it reads Sending… until the work reads it. One
 * the running turn has not taken (it waits for a turn of its own: a slash command for Studio's chat,
 * a model without sessions, a picture not saved in the game) can be withdrawn with Remove; one
 * handed to the running turn no longer can. How it arrives and leaves is the conversation's (`Presence`).
 */
export function QueuedMessage({
  threadId,
  messageId,
  text,
  sending = false,
  images,
  onNotice,
}: {
  threadId: string;
  messageId: string;
  text: string;
  /** Handed to the running turn and not read yet: it can no longer be withdrawn. */
  sending?: boolean;
  /** Pictures sent with it: how many, when the log knows. */
  images?: { count?: number };
  onNotice: Notify;
}) {
  const [removing, setRemoving] = useState(false);
  const remove = async () => {
    setRemoving(true);
    try {
      await window.studio.changeQueuedMessage(threadId, messageId, "remove");
    } catch (error) {
      notifyProblem(onNotice)(error);
      setRemoving(false);
    }
  };
  return (
    <div data-queued-message={messageId} className="flex min-w-0 flex-col items-end gap-0.5">
      <UserMessage
        text={text}
        pending
        {...(images ? { threadId, imagesOf: messageId, imageCount: images.count } : {})}
      />
      <SendingLine>
        {!sending && (
          <IconButton
            icon="trash"
            label={t("Remove queued message")}
            size={12}
            className="chat-queued-remove"
            disabled={removing}
            onClick={() => void remove()}
          />
        )}
      </SendingLine>
    </div>
  );
}
