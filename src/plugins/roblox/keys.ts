/**
 * The keys a play test is driven with: the studio's web key codes (`KeyboardEvent.code`) by
 * Roblox's `KeyCode` names, as Studio's `user_keyboard_input` takes them, and the mouse buttons
 * its `user_mouse_input` presses. Every name here is in the `key_code` list Studio 0.743's MCP
 * server declares (`roblox-computer-play.test.ts` holds them to the recorded list).
 */
import { MouseButtonCode } from "../../shared/engine-play.ts";

/** The mouse buttons Studio's `user_mouse_input` presses. Wire values: never rename. */
export const RobloxMouseButton = { Left: "left", Right: "right" } as const;
export type RobloxMouseButton = (typeof RobloxMouseButton)[keyof typeof RobloxMouseButton];

/** The mouse buttons by the studio's names for them; the middle button Studio's input has no way to press. */
const MOUSE_BUTTONS: Readonly<Record<string, RobloxMouseButton>> = {
  [MouseButtonCode.Left]: RobloxMouseButton.Left,
  [MouseButtonCode.Right]: RobloxMouseButton.Right,
};

/** Web key codes by Roblox's `KeyCode` names: letters, digits, function and keypad keys are by rule, below. */
const ROBLOX_KEYS: Readonly<Record<string, string>> = {
  Space: "Space",
  Enter: "Return",
  Escape: "Escape",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ShiftLeft: "LeftShift",
  ShiftRight: "RightShift",
  ControlLeft: "LeftControl",
  ControlRight: "RightControl",
  AltLeft: "LeftAlt",
  AltRight: "RightAlt",
  MetaLeft: "LeftSuper",
  MetaRight: "RightSuper",
  CapsLock: "CapsLock",
  NumLock: "NumLock",
  ScrollLock: "ScrollLock",
  Pause: "Pause",
  PrintScreen: "Print",
  ContextMenu: "Menu",
  Minus: "Minus",
  Equal: "Equals",
  Comma: "Comma",
  Period: "Period",
  Slash: "Slash",
  Semicolon: "Semicolon",
  Quote: "Quote",
  BracketLeft: "LeftBracket",
  BracketRight: "RightBracket",
  Backslash: "BackSlash",
  Backquote: "Backquote",
  NumpadDecimal: "KeypadPeriod",
  NumpadDivide: "KeypadDivide",
  NumpadMultiply: "KeypadMultiply",
  NumpadSubtract: "KeypadMinus",
  NumpadAdd: "KeypadPlus",
  NumpadEnter: "KeypadEnter",
  NumpadEqual: "KeypadEquals",
};
/** Roblox's names for the digits, `Digit0` to `Digit9` and `Numpad0` to `Numpad9` (with `Keypad`). */
const DIGITS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"] as const;
/** The function keys Roblox names, `F1` to `F15`. */
const FUNCTION_KEY = /^F(?:[1-9]|1[0-5])$/;

/** Roblox's `KeyCode` name for a web key code, or null when Studio's keyboard input has none. */
export function robloxKey(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1] ?? null;
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return DIGITS[Number(digit[1])] ?? null;
  const keypad = /^Numpad([0-9])$/.exec(code);
  if (keypad) return `Keypad${DIGITS[Number(keypad[1])]}`;
  if (FUNCTION_KEY.test(code)) return code;
  return Object.hasOwn(ROBLOX_KEYS, code) ? (ROBLOX_KEYS[code] ?? null) : null;
}

/** The mouse button Studio presses for one of the studio's mouse button names, or null for none. */
export function robloxMouseButton(code: string): RobloxMouseButton | null {
  return Object.hasOwn(MOUSE_BUTTONS, code) ? (MOUSE_BUTTONS[code] ?? null) : null;
}

/** Every Roblox `KeyCode` name the table can give, for checking against what Studio declares. */
export function robloxKeyNames(): string[] {
  const letters = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
  const functions = Array.from({ length: 15 }, (_, i) => `F${i + 1}`);
  const keypad = DIGITS.map((digit) => `Keypad${digit}`);
  return [...letters, ...DIGITS, ...keypad, ...functions, ...Object.values(ROBLOX_KEYS)];
}
