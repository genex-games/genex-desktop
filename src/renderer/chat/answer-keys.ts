/**
 * The keys that press a waiting card's recommended answer: ⌘↩ on a Mac, Ctrl+Enter elsewhere.
 * Plain Enter stays the composer's send, and a held key never answers twice.
 */
import { StudioPlatform } from "../../shared/boot.ts";

/** A key press as the card reads it: a `KeyboardEvent`'s own fields. */
export interface AnswerPress {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  repeat?: boolean;
}

/** The keys as the button shows them, and as `aria-keyshortcuts` names them. */
export interface AnswerKeys {
  caps: readonly string[];
  aria: string;
}

const MAC_KEYS: AnswerKeys = { caps: ["⌘", "↩"], aria: "Meta+Enter" };
const OTHER_KEYS: AnswerKeys = { caps: ["Ctrl", "↵"], aria: "Control+Enter" };

/** Enter pressed once, with no input method composing and no Shift or Option beside it. */
function isBareEnter(press: AnswerPress): boolean {
  if (press.key !== "Enter" || press.isComposing || press.repeat) return false;
  return !press.shiftKey && !press.altKey;
}

/** Whether a press is the answer keys on this system (`process.platform` spelling; empty before main said). */
export function pressesAnswer(press: AnswerPress, platform: string): boolean {
  if (!isBareEnter(press)) return false;
  if (platform === StudioPlatform.Mac) return Boolean(press.metaKey) && !press.ctrlKey;
  return Boolean(press.ctrlKey) && !press.metaKey;
}

/** The answer keys on this system. */
export function answerKeys(platform: string): AnswerKeys {
  return platform === StudioPlatform.Mac ? MAC_KEYS : OTHER_KEYS;
}
