/**
 * A quest: a goal in the game's own state (`__studio.state()`) that the studio checks after every
 * move of a judge that plays, so "I reached it" rests on the studio's reading rather than the
 * judge's word. The director writes one as `goal_state`; a run's setup `verify` is one already.
 *
 * Pure: parsing untrusted text into a quest, and testing a state against one.
 */
import { isRecord } from "./json.ts";

/** The state a quest waits for: a dotted path, and the value it must hold or merely be truthy. */
export interface QuestUntil {
  path: string;
  equals?: string | number | boolean | null;
  truthy?: boolean;
}

/** A goal the studio checks after every move, named for the record. */
export interface Quest {
  id: string;
  until: QuestUntil;
  /**
   * The one question this goal was set for. Only that question's yes may rest on the studio seeing
   * the goal reached; every other answer of the same session is the model's word.
   */
  checkId?: string;
}

/** What a play check may be tied to (`Check.reaches`): the run's requested state, its setup `verify`. */
export const PlayReaches = { Setup: "setup" } as const;
export type PlayReaches = (typeof PlayReaches)[keyof typeof PlayReaches];

/** The longest state path a quest may name. */
const MAX_QUEST_PATH_CHARS = 120;
/** The longest quest id. */
const MAX_QUEST_ID_CHARS = 48;
/** A dotted path of plain identifiers, as the host's own setup verify accepts it. */
const QUEST_PATH = /^[a-zA-Z_$][\w$]*(\.[a-zA-Z_$][\w$]*)*$/;
/** Segments that walk off the state into the object machinery. */
const PROTOTYPE_SEGMENTS: ReadonlySet<string> = new Set(["__proto__", "prototype", "constructor"]);

/** Why a `goal_state` could not be read, in the director's words. */
const MESSAGE = {
  notJson: 'goal_state must be JSON like {"path":"flow.phase","equals":"playing"}',
  notObject: "goal_state must be one JSON object with a path",
  badPath: "goal_state path must be dotted plain names (flow.phase), no spaces, brackets or __proto__",
  badEquals: "goal_state equals must be a string, number, true/false or null",
  needsTest: 'goal_state needs "equals" or "truthy": true',
} as const;

/** A path the studio can read as a quest: dotted plain names, never into the prototype. */
export function isQuestPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_QUEST_PATH_CHARS || !QUEST_PATH.test(value)) return false;
  return value.split(".").every((segment) => !PROTOTYPE_SEGMENTS.has(segment));
}

/** A value a quest may wait for: a primitive, never an object. */
function isQuestValue(value: unknown): value is QuestUntil["equals"] {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

/** Untrusted `{path, equals | truthy}` as what a quest waits for, or the sentence that says why not. */
export function questUntilOf(raw: unknown): { until: QuestUntil } | { error: string } {
  if (!isRecord(raw) || Array.isArray(raw)) return { error: MESSAGE.notObject };
  if (!isQuestPath(raw.path)) return { error: MESSAGE.badPath };
  if ("equals" in raw) {
    if (!isQuestValue(raw.equals)) return { error: MESSAGE.badEquals };
    return { until: { path: raw.path, equals: raw.equals } };
  }
  if (raw.truthy === true) return { until: { path: raw.path, truthy: true } };
  return { error: MESSAGE.needsTest };
}

/** The director's `goal_state` argument: null when absent, the quest's state, or the sentence that refuses it. */
export function parseGoalState(text: unknown): { until: QuestUntil } | { error: string } | null {
  if (text === undefined || text === null || String(text).trim() === "") return null;
  if (typeof text === "object") return questUntilOf(text);
  try {
    return questUntilOf(JSON.parse(String(text)));
  } catch {
    return { error: MESSAGE.notJson };
  }
}

/** A quest id from free text: lower case, letters, digits and dashes. */
export function questId(text: unknown, fallback: string): string {
  const id = String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_QUEST_ID_CHARS);
  return id || fallback;
}

/** A run's setup verify as a quest, when it names one the studio can check; tied to `checkId` when given. */
export function questFromSetup(setup: unknown, id: string, checkId?: string): Quest | null {
  const verify = isRecord(setup) ? setup.verify : null;
  const read = questUntilOf(verify);
  if (!("until" in read)) return null;
  return { id, until: read.until, ...(checkId ? { checkId } : {}) };
}

/** The goal as the host is handed it (`DelegatePlaytestGrant.quest`): its name and its state, nothing of ours. */
export function questGrant(quest: Quest): { id: string; until: QuestUntil } {
  return { id: quest.id, until: quest.until };
}

/** The value at a dotted path, or undefined when the walk leaves the state. */
function valueAt(state: unknown, path: string): unknown {
  let current: unknown = state;
  for (const key of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

/** Does the state hold the quest's goal? Null when the state is unreadable. */
export function questHolds(until: QuestUntil, state: unknown): boolean | null {
  if (!isRecord(state) || state.__missing) return null;
  const value = valueAt(state, until.path);
  if ("equals" in until) return value === until.equals || String(value) === String(until.equals);
  if (until.truthy) return Boolean(value);
  return value !== undefined;
}
