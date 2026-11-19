import { StudioPlatform } from "../../shared/boot.ts";

/** Window events the terminal dock listens for. */

/** Ask the terminal dock to show its open terminal (a sign-in running in Studio's own terminal, for one). */
export const SHOW_TERMINAL_EVENT = "studio:show-terminal";

/** Show the terminal dock at this session (a command a reply offered), or at its open terminal. */
export const showTerminal = (sessionId?: string): void => {
  window.dispatchEvent(new CustomEvent(SHOW_TERMINAL_EVENT, { detail: { sessionId } }));
};

/** The session a show-terminal event asks for, if it names one. */
export const shownSession = (event: Event): string | undefined =>
  event instanceof CustomEvent && typeof event.detail?.sessionId === "string" ? event.detail.sessionId : undefined;

/** Show the terminal dock, or hide it when it is showing (Cmd/Ctrl+`). */
export const TOGGLE_TERMINAL_EVENT = "studio:toggle-terminal";

/** Open a new terminal in the game's folder. */
export const OPEN_TERMINAL_EVENT = "studio:open-terminal";

/** Whether a key press is the terminal's own chord, Cmd/Ctrl+`. */
export const isTerminalChord = (event: { metaKey: boolean; ctrlKey: boolean; code: string }): boolean =>
  (event.metaKey || event.ctrlKey) && event.code === "Backquote";

/** A key's typed text that is one Latin letter: the layout itself names the letter. */
const LATIN_LETTER = /^[a-z]$/i;

/** Whether `event` is Ctrl with `letter` and no Cmd or Alt, by the typed letter on a Latin layout and the key's place on any other. */
const ctrlLetter = (
  event: { metaKey: boolean; ctrlKey: boolean; altKey: boolean; code: string; key: string },
  letter: string,
): boolean => {
  const ctrlOnly = event.ctrlKey && !event.metaKey && !event.altKey;
  const latin = LATIN_LETTER.test(event.key);
  return ctrlOnly && (latin ? event.key.toLowerCase() === letter : event.code === `Key${letter.toUpperCase()}`);
};

/**
 * Whether a key press copies the terminal's selection: Ctrl+Shift+C anywhere, and off a Mac Ctrl+C
 * over a selection, as Windows Terminal does, so a selected sign-in code is copied instead of the
 * sign-in being interrupted. With nothing selected Ctrl+C stays the interrupt.
 */
export const isCopyChord = (
  event: { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; code: string; key: string },
  platform: string,
  selected: boolean,
): boolean => {
  if (!ctrlLetter(event, "c")) return false;
  return event.shiftKey || (selected && platform !== StudioPlatform.Mac);
};

/**
 * Whether a key press is a paste the terminal must leave to the browser: Ctrl+V or Ctrl+Shift+V off
 * a Mac (Cmd+V on a Mac is the app menu's paste and never reaches the terminal). Left to xterm, it
 * sends one control character (^V) in place of the clipboard, so a pasted sign-in code never arrives.
 * On a Latin layout the typed letter decides (Dvorak's V, not the key where QWERTY has it); on any
 * other layout (Russian) the key in V's place does, as the system's own Ctrl+V.
 */
export const isPasteChord = (
  event: { metaKey: boolean; ctrlKey: boolean; altKey: boolean; code: string; key: string },
  platform: string,
): boolean => {
  return ctrlLetter(event, "v") && platform !== StudioPlatform.Mac;
};
