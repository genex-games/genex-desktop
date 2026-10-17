/**
 * Words another surface leaves in a game's chat composer, such as the Publish dialog's Ask for a
 * cover, for the person to send themselves. The chat open on that game puts them in front of any
 * draft, cursor at the end (`chat/use-compose-in-chat.ts`); a chat on another game ignores them.
 * A press that means "ask the agent this", such as the strip's Multiplayer, sends them as well,
 * through the chat's own send, so a plan to review, a sign-in first or a running turn take them as
 * they would typed words, and a send that can't happen yet leaves them in the composer.
 */

/** Words for one game's composer. */
export interface ComposeInChat {
  /** The game whose chat takes them. */
  project: string;
  text: string;
  /** Send them too, as if typed and sent; otherwise they wait in the composer. */
  send?: boolean;
}

/** The window event {@link composeInChat} dispatches and the open chat listens for. */
export const COMPOSE_IN_CHAT_EVENT = "studio:compose-in-chat";

/** Leave words in a game's chat composer, and send them when the request says so. */
export function composeInChat(request: ComposeInChat): void {
  window.dispatchEvent(new CustomEvent<ComposeInChat>(COMPOSE_IN_CHAT_EVENT, { detail: request }));
}

/** The chat's prompt: a dialog that leaves words there hands it the focus as it closes. */
export const chatPrompt = (): HTMLTextAreaElement | null =>
  document.querySelector("[data-chat-composer] [data-promptbar] textarea");
