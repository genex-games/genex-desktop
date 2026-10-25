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
  /** Called once the chat really sent them; never when they wait in the composer instead. */
  sent?: () => void;
}

/** The window event {@link composeInChat} dispatches and the open chat listens for. */
export const COMPOSE_IN_CHAT_EVENT = "studio:compose-in-chat";

/** Leave words in a game's chat composer, and send them when the request says so. */
export function composeInChat(request: ComposeInChat): void {
  window.dispatchEvent(new CustomEvent<ComposeInChat>(COMPOSE_IN_CHAT_EVENT, { detail: request }));
}

/** Words left for a game whose chat was not open yet: the chat that next opens on that game takes them. */
let waiting: ComposeInChat | null = null;

/**
 * Leave words for a game's chat, open or about to open (Create › Items' Add to \<game>): the chat
 * open on that game takes them now, else the one that opens on it next. A later request replaces
 * one still waiting.
 */
export function composeInChatWhenOpen(request: ComposeInChat): void {
  waiting = request;
  composeInChat(request);
}

/** A chat took these words: they no longer wait. */
export function composedInChat(request: ComposeInChat): void {
  if (waiting === request) waiting = null;
}

/** The words waiting for `project`'s chat, taken once. */
export function takeWaitingCompose(project: string | null): ComposeInChat | null {
  if (!project || waiting?.project !== project) return null;
  const request = waiting;
  waiting = null;
  return request;
}

/** The chat's prompt: a dialog that leaves words there hands it the focus as it closes. */
export const chatPrompt = (): HTMLTextAreaElement | null =>
  document.querySelector("[data-chat-composer] [data-promptbar] textarea");
