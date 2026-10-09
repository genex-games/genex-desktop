/**
 * An input plan for a target whose clock the session steps. On a stepped clock nothing runs between
 * two input events unless the session steps it, so a key pressed and released in one call is
 * never seen by a game that reads its keys once a frame, and a held key holds for no game time at
 * all. This splits every press, tap and hold into its down, an exact step of game time, and its up;
 * the session carries the steps out on the target's own clock.
 *
 * Pure and Electron-free: the same plan for the browser window and a Play Protocol game.
 */
import { parseCombo, type PreviewInputAction } from "./preview-input.ts";

/** One part of a stepped plan: input to send, or game time to step. */
export type SteppedPart = { input: PreviewInputAction[] } | { stepMs: number };

/** Key codes of a `press` combo, modifiers first. */
function comboKeys(combo: string): string[] {
  const { modifiers, key } = parseCombo(combo);
  return [...modifiers.map((k) => k.code), ...(key ? [key.code] : [])];
}

/** Keys down, game time for them to be seen, keys up. */
function stroke(keys: string[], ms: number): SteppedPart[] {
  if (!keys.length) return [];
  return [{ input: [{ type: "down", keys }] }, { stepMs: ms }, { input: [{ type: "up", keys }] }];
}

/** One action as stepped parts. */
function partsOf(action: PreviewInputAction, tapMs: number): SteppedPart[] {
  switch (action.type) {
    case "hold":
      return stroke(action.keys, Math.max(tapMs, action.ms ?? tapMs));
    case "tap":
      return stroke(action.keys, tapMs);
    case "press": {
      const keys = comboKeys(action.combo);
      const times = Math.max(1, action.repeat ?? 1);
      return Array.from({ length: times }, () => stroke(keys, tapMs)).flat();
    }
    case "click":
      return [{ input: [{ ...action, stepMs: action.stepMs ?? tapMs }] }];
    default:
      return [{ input: [action] }];
  }
}

/** Consecutive input parts merged into one send, so a plan crosses to the target as few times as it can. */
function merged(parts: SteppedPart[]): SteppedPart[] {
  const out: SteppedPart[] = [];
  for (const part of parts) {
    const last = out.at(-1);
    if (last && "input" in last && "input" in part) last.input.push(...part.input);
    else out.push("input" in part ? { input: [...part.input] } : part);
  }
  return out;
}

/** The plan as parts for a stepped clock: every key stroke given game time between its down and its up. */
export function steppedPlan(actions: readonly PreviewInputAction[], tapMs: number): SteppedPart[] {
  return merged(actions.flatMap((action) => partsOf(action, tapMs)));
}

/** How many input actions a plan sends. */
export function plannedInputs(parts: readonly SteppedPart[]): number {
  return parts.reduce((sum, part) => sum + ("input" in part ? part.input.length : 0), 0);
}
