/**
 * Words another surface leaves for this chat's composer (`compose-in-chat.ts`): taken only when
 * they are for the game this chat is open on, put in front of its draft once, and sent through the
 * chat's own send only when the request asks.
 */
import { type RefObject, useEffect, useRef } from "react";
import { COMPOSE_IN_CHAT_EVENT, type ComposeInChat, composedInChat, takeWaitingCompose } from "../compose-in-chat.ts";
import type { PromptBarHandle } from "../ui/PromptBar.tsx";
import type { SendAnswered } from "./use-submit.ts";
import type { ThreadDrafts } from "./use-thread-drafts.ts";

/** The chat words may land in: its thread, its game and its open draft. */
interface OpenChat {
  threadId: string | undefined;
  project: string | null;
  drafts: Pick<ThreadDrafts, "draft" | "putBack">;
}

/** This chat's thread when the words left are for the game it is open on, else null. */
function threadFor(request: ComposeInChat | undefined, chat: OpenChat): string | null {
  const sameGame = Boolean(request?.text) && Boolean(chat.project) && request?.project === chat.project;
  return sameGame ? (chat.threadId ?? null) : null;
}

/** Take words another surface leaves for this chat's composer, cursor after them; send them when asked. */
export function useComposeInChat(
  threadId: string | undefined,
  project: string | null,
  drafts: OpenChat["drafts"],
  composer: RefObject<PromptBarHandle | null>,
  submit: SendAnswered,
): void {
  const open = useRef<OpenChat>({ threadId, project, drafts });
  open.current = { threadId, project, drafts };
  const send = useRef(submit);
  send.current = submit;
  const take = useRef<(request: ComposeInChat) => void>(() => undefined);
  useEffect(() => {
    const takeRequest = (request: ComposeInChat): void => {
      const chat = open.current;
      const thread = threadFor(request, chat);
      if (!thread) return;
      composedInChat(request);
      if (request.send) {
        // Composed first, as a launch hands over its first message: a send the chat can't make
        // yet (no model, a sign-in first) leaves the words in the composer instead of losing them.
        // A draft the person was typing stays theirs: the send leaves it as it is.
        const typing = chat.drafts.draft.trim() !== "";
        composer.current?.compose(request.text);
        send.current(request.text, undefined, typing).then(
          (went) => {
            if (went) request.sent?.();
          },
          () => {
            // The send failed: the words wait in the composer, as typed words would.
            if (!open.current.drafts.draft.includes(request.text)) open.current.drafts.putBack(thread, request.text);
          },
        );
        return;
      }
      // Asked again before sending, the words are already there: they go in once.
      if (!chat.drafts.draft.includes(request.text)) chat.drafts.putBack(thread, request.text);
      // Once the words are in, the cursor goes after them; compose only places it when the draft is set.
      requestAnimationFrame(() => composer.current?.compose(request.text));
    };
    take.current = takeRequest;
    const compose = (event: Event): void => takeRequest((event as CustomEvent<ComposeInChat>).detail);
    window.addEventListener(COMPOSE_IN_CHAT_EVENT, compose);
    return () => window.removeEventListener(COMPOSE_IN_CHAT_EVENT, compose);
  }, [composer]);
  // Words left for this game before its chat opened (`composeInChatWhenOpen`) are taken as it opens.
  useEffect(() => {
    if (!threadId) return;
    const request = takeWaitingCompose(project);
    if (request) take.current(request);
  }, [threadId, project]);
}
