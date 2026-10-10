/**
 * Words another surface leaves in a game's chat composer for the person to send themselves, such
 * as the Publish dialog's Ask for a cover: never sent for them. The chat open on that game puts
 * them in front of any draft, cursor at the end (`chat/use-compose-in-chat.ts`); a chat on another
 * game ignores them.
 */

/** Words for one game's composer. */
export interface ComposeInChat {
  /** The game whose chat takes them. */
  project: string;
  text: string;
}

/** The window event {@link composeInChat} dispatches and the open chat listens for. */
export const COMPOSE_IN_CHAT_EVENT = "studio:compose-in-chat";

/** Leave words in a game's chat composer, unsent. */
export function composeInChat(request: ComposeInChat): void {
  window.dispatchEvent(new CustomEvent<ComposeInChat>(COMPOSE_IN_CHAT_EVENT, { detail: request }));
}

/** The chat's prompt: a dialog that leaves words there hands it the focus as it closes. */
export const chatPrompt = (): HTMLTextAreaElement | null =>
  document.querySelector("[data-chat-composer] [data-promptbar] textarea");
