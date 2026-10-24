/**
 * What an agent asks a Godot play to do, checked before Godot starts: the keys to press on a
 * timeline (`"right 1.5, space, wait 1, left 0.5"`: each key held for its seconds, a tap when none
 * is given, `wait` to let time pass), and the moments to take stills at. Both become the plain
 * `key@start:length;…` and `frame:mode;…` values Genex's play script (`genex_play.gd`) reads, in
 * frames at its fixed 60 a second. Nothing an agent writes reaches Godot unchecked.
 */

/** The frames a play runs each second (the script's `FPS`, Godot's `--fixed-fps`). */
export const PLAY_FPS = 60;
/** The longest play, in seconds: the keys' timeline and every still fit inside it. */
export const MAX_PLAY_SECONDS = 60;
/** The most steps one key timeline may have. */
const MAX_KEY_STEPS = 32;
/** A tap's length when a key names no seconds. */
const TAP_SECONDS = 0.1;
const WAIT = "wait";
/** The named keys the play script presses; any single letter or digit works too. */
const NAMED_KEYS: ReadonlySet<string> = new Set([
  "left",
  "right",
  "up",
  "down",
  "space",
  "enter",
  "escape",
  "tab",
  "shift",
  "ctrl",
  "alt",
  "backspace",
]);
const SINGLE_KEY = /^[a-z0-9]$/;
const SECONDS = /^\d{1,2}(\.\d{1,3})?$/;

const MESSAGE = {
  BadStep: (step: string) =>
    `"${step}" isn't a key step: write a key and its seconds ("right 1.5"), a key alone for a tap ("space"), or "wait 1".`,
  BadKey: (key: string) =>
    `"${key}" isn't a key Genex can press: use left, right, up, down, space, enter, escape, tab, shift, ctrl, alt, backspace, or one letter or digit.`,
  TooLong: `keys and seconds fit in ${MAX_PLAY_SECONDS} seconds of play.`,
  TooMany: `keys has at most ${MAX_KEY_STEPS} steps.`,
} as const;

/** Why a play request was refused: the words the agent reads. */
export class PlayInputError extends Error {}

/** A key held from a frame for a number of frames. */
export type KeyPress = { key: string; start: number; length: number };

/** Whether a key name is one the play script presses. */
const isKey = (key: string) => NAMED_KEYS.has(key) || SINGLE_KEY.test(key);

/** One step of a timeline as written: a key or `wait`, and its seconds. */
function readStep(step: string): { key: string; seconds: number } {
  const [name = "", seconds, ...rest] = step.trim().toLowerCase().split(/\s+/);
  if (!name || rest.length > 0 || (seconds !== undefined && !SECONDS.test(seconds)))
    throw new PlayInputError(MESSAGE.BadStep(step.trim()));
  if (name !== WAIT && !isKey(name)) throw new PlayInputError(MESSAGE.BadKey(name));
  return { key: name, seconds: seconds === undefined ? TAP_SECONDS : Number(seconds) };
}

/** A key timeline as an agent wrote it, in frames from the play's start; empty when none was asked for. */
export function readKeys(asked: string): KeyPress[] {
  const steps = asked.trim() ? asked.split(",") : [];
  if (steps.length > MAX_KEY_STEPS) throw new PlayInputError(MESSAGE.TooMany);
  const presses: KeyPress[] = [];
  let at = 0;
  for (const step of steps) {
    const { key, seconds } = readStep(step);
    if (key !== WAIT)
      presses.push({ key, start: Math.round(at * PLAY_FPS), length: Math.max(1, Math.round(seconds * PLAY_FPS)) });
    at += seconds;
  }
  if (at > MAX_PLAY_SECONDS) throw new PlayInputError(MESSAGE.TooLong);
  return presses;
}

/** The frame a timeline's last key lets go, so a play runs at least that long. */
export const keysEnd = (presses: readonly KeyPress[]): number =>
  presses.reduce((end, press) => Math.max(end, press.start + press.length + 1), 0);

/** The play script's `keys=` value. */
export const keysArg = (presses: readonly KeyPress[]): string =>
  presses.map((press) => `${press.key}@${press.start}:${press.length}`).join(";");

/** Which cameras a still takes: every `genex_shot` camera, or the first only (a recording's frame). Never rename a value. */
export const ShotCameras = { All: "all", First: "first" } as const;
export type ShotCameras = (typeof ShotCameras)[keyof typeof ShotCameras];

/** A still to take: at which frame, of which cameras. */
export type ShotAt = { frame: number; cameras: ShotCameras };

/** The play script's `shots=` value. */
export const shotsArg = (shots: readonly ShotAt[]): string =>
  shots.map((shot) => `${shot.frame}:${shot.cameras}`).join(";");

/** A moment in seconds as the frame a still is taken at: at least the first frame. */
export const frameAt = (seconds: number): number => Math.max(1, Math.round(seconds * PLAY_FPS));

/** `count` frames spread evenly up to `seconds`, the last one at it: a short recording of the first camera. */
export function recordingShots(seconds: number, count: number): ShotAt[] {
  return Array.from({ length: count }, (_, index) => ({
    frame: frameAt((seconds * (index + 1)) / count),
    cameras: ShotCameras.First,
  }));
}
