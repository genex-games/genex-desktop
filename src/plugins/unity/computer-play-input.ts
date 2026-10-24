import { MAX_PLAY_INPUT_SECONDS, MouseButtonCode, playInputKeys } from "../../shared/engine-play.ts";

const MAX_KEYS = 32;
const MAX_KEYS_CHARS = 512;
const MAX_MOUSE_DELTA = 10_000;
const MAX_WHEEL_NOTCHES = 100;

/** Unity Input System key names; letters, digits and function keys follow the rules below. */
const KEYS: Readonly<Record<string, string>> = {
  Space: "Space",
  Enter: "Enter",
  NumpadEnter: "NumpadEnter",
  Escape: "Escape",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "UpArrow",
  ArrowDown: "DownArrow",
  ArrowLeft: "LeftArrow",
  ArrowRight: "RightArrow",
  ShiftLeft: "LeftShift",
  ShiftRight: "RightShift",
  ControlLeft: "LeftCtrl",
  ControlRight: "RightCtrl",
  AltLeft: "LeftAlt",
  AltRight: "RightAlt",
  MetaLeft: "LeftMeta",
  MetaRight: "RightMeta",
  Minus: "Minus",
  Equal: "Equals",
  Comma: "Comma",
  Period: "Period",
  Slash: "Slash",
  Semicolon: "Semicolon",
  Quote: "Quote",
  BracketLeft: "LeftBracket",
  BracketRight: "RightBracket",
  Backslash: "Backslash",
  Backquote: "Backquote",
  CapsLock: "CapsLock",
};

/** The only mouse controls a validated input can select. */
export const UNITY_MOUSE_BUTTONS = {
  [MouseButtonCode.Left]: "leftButton",
  [MouseButtonCode.Right]: "rightButton",
  [MouseButtonCode.Middle]: "middleButton",
} as const;
export type UnityMouseButton = (typeof UNITY_MOUSE_BUTTONS)[MouseButtonCode];

/** Unity's Input System name for a browser key code, or null when there is none. */
export function unityKey(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1] ?? null;
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return `Digit${digit[1]}`;
  if (/^F(?:[1-9]|1[0-2])$/.test(code)) return code;
  if (/^Numpad[0-9]$/.test(code)) return code;
  return Object.hasOwn(KEYS, code) ? (KEYS[code] ?? null) : null;
}

/** A finite, bounded scalar, checked before touching the editor. */
function scalar(value: unknown, name: string, limit: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > limit)
    throw new Error(`${name} must be a finite number between ${-limit} and ${limit}.`);
  return value;
}

/** Parsed input retains unknown key codes for an actionable refusal without sending any commands. */
export function parsePlayInput(args: Record<string, unknown>) {
  if (typeof args.keys !== "string" || args.keys.length > MAX_KEYS_CHARS)
    throw new Error("keys must be a comma-separated string of key codes.");
  const codes = [...new Set(playInputKeys(args.keys))];
  if (codes.length > MAX_KEYS) throw new Error(`At most ${MAX_KEYS} keys can be held together.`);
  const seconds = scalar(args.seconds, "seconds", MAX_PLAY_INPUT_SECONDS);
  if (seconds <= 0) throw new Error("seconds must be greater than zero.");
  const dx = scalar(args.dx === undefined ? 0 : args.dx, "dx", MAX_MOUSE_DELTA);
  const dy = scalar(args.dy === undefined ? 0 : args.dy, "dy", MAX_MOUSE_DELTA);
  const wheel = scalar(args.wheel === undefined ? 0 : args.wheel, "wheel", MAX_WHEEL_NOTCHES);
  const keys = codes.map((code) => {
    const button = Object.hasOwn(UNITY_MOUSE_BUTTONS, code) ? UNITY_MOUSE_BUTTONS[code as MouseButtonCode] : undefined;
    return { code, button, name: button ?? unityKey(code) };
  });
  return { keys, seconds, dx, dy, wheel };
}
