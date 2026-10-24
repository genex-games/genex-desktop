/**
 * Nicknames: a person's handle, which is also the address of their profile, `genex.games/@<handle>`.
 * The shape rules are genex.games' own, judged here the same way so the field can say what is wrong
 * while it is typed and main never sends a handle genex.games would refuse for its shape. Whether a
 * well-formed handle is free is genex.games' to say (`playHandleCheck`): reserved words and taken
 * handles depend on its data. A handle is lowercase: it is a link people type from memory, and two
 * people told apart only by case would be one impersonating the other.
 */
import type { PlayMe } from "./play-people.ts";

/** A handle's length, in characters. */
export const HANDLE_LENGTH = { min: 3, max: 20 } as const;
/** The most handles genex.games offers in place of one that cannot be had. */
export const HANDLE_SUGGESTIONS_MAX = 3;

/** Why a typed handle cannot be used, before anyone asks whether it is free. Wire values: never rename one. */
export const HandleProblem = {
  TooShort: "too_short",
  TooLong: "too_long",
  /** A character outside a–z, 0–9 and the dash. */
  LatinOnly: "latin_only",
  /** A dash at the start or the end, or two together. */
  DashEdge: "dash_edge",
} as const;
export type HandleProblem = (typeof HandleProblem)[keyof typeof HandleProblem];

/** What a typed handle is: a shape problem, or whether it can be had. Wire values: never rename one. */
export const HandleState = {
  Free: "free",
  /** The account's own handle already. */
  Yours: "yours",
  Taken: "taken",
  /** A word genex.games keeps; shown exactly as Taken, so the list is never advertised. */
  Reserved: "reserved",
  TooShort: HandleProblem.TooShort,
  TooLong: HandleProblem.TooLong,
  LatinOnly: HandleProblem.LatinOnly,
  DashEdge: HandleProblem.DashEdge,
} as const;
export type HandleState = (typeof HandleState)[keyof typeof HandleState];

const STATES: ReadonlySet<string> = new Set(Object.values(HandleState));
/** Whether a value names a handle state. */
export const isHandleState = (value: unknown): value is HandleState => typeof value === "string" && STATES.has(value);

const PROBLEMS: ReadonlySet<string> = new Set(Object.values(HandleProblem));
/** Whether a value names a shape problem (and nothing else: never Free, Taken or the account's own). */
export const isHandleProblem = (value: unknown): value is HandleProblem =>
  typeof value === "string" && PROBLEMS.has(value);

/** What genex.games (or the field, before it answers) says of a typed handle. */
export interface HandleCheck {
  /** What was typed, read as genex.games reads it. */
  handle: string;
  state: HandleState;
  /** At most {@link HANDLE_SUGGESTIONS_MAX} handles to offer instead; empty when there is none. */
  suggestions: string[];
}

/** How saving a handle went. The app's own words: main reads genex.games' answer into one. */
export const HandleSaveOutcome = {
  Saved: "saved",
  /** genex.games refused the handle: taken or reserved (with suggestions), or a shape problem. */
  Refused: "refused",
  /** The account changed its handle too often lately; nothing was written. */
  TooManyChanges: "too-many-changes",
} as const;
export type HandleSaveOutcome = (typeof HandleSaveOutcome)[keyof typeof HandleSaveOutcome];

/** What saving a handle answers. */
export type HandleSave =
  | { outcome: typeof HandleSaveOutcome.Saved; me: PlayMe | null }
  | { outcome: typeof HandleSaveOutcome.Refused; check: HandleCheck }
  | { outcome: typeof HandleSaveOutcome.TooManyChanges };

/** Lowercase letters, digits and dashes: a handle's whole alphabet. */
const HANDLE_CHARS = /^[a-z0-9-]+$/;
const DASH = "-";

/** A handle as people type it, read the way genex.games stores it: trimmed, without a leading @, lowercase. */
export function normalizeHandleInput(raw: string): string {
  return raw.trim().replace(/^@/, "").toLowerCase();
}

/**
 * The first rule a handle breaks, or null for a well-formed one. Takes the normalized value; length
 * comes first, so a two-letter name in another script reads too short, the thing to fix first.
 */
export function handleProblem(handle: string): HandleProblem | null {
  if (handle.length < HANDLE_LENGTH.min) return HandleProblem.TooShort;
  if (handle.length > HANDLE_LENGTH.max) return HandleProblem.TooLong;
  if (!HANDLE_CHARS.test(handle)) return HandleProblem.LatinOnly;
  const dashAtEdge = handle.startsWith(DASH) || handle.endsWith(DASH);
  if (dashAtEdge || handle.includes(DASH + DASH)) return HandleProblem.DashEdge;
  return null;
}

/** Whether a value is a well-formed handle, as genex.games stores them. */
export const isHandle = (value: unknown): value is string => typeof value === "string" && handleProblem(value) === null;

/** Cyrillic in Latin letters, as people write their own names in Latin; the soft and hard signs vanish. */
const CYRILLIC: Readonly<Record<string, string>> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  ґ: "g",
  д: "d",
  е: "e",
  ё: "e",
  є: "ye",
  ж: "zh",
  з: "z",
  и: "i",
  і: "i",
  ї: "yi",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ў: "u",
  ф: "f",
  х: "kh",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "shch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
};

/** Latin letters that do not decompose into a base letter and a mark. */
const LATIN_EXTRA: Readonly<Record<string, string>> = {
  ß: "ss",
  æ: "ae",
  ø: "o",
  œ: "oe",
  đ: "d",
  ð: "d",
  ł: "l",
  þ: "th",
  ı: "i",
};

/**
 * A Latin handle from a name: "Rab Neba" and "Рабнеба" give `rabneba`, "José" `jose`. Words run
 * together, anything that is not a Latin letter or a digit after spelling it in Latin is dropped,
 * and it is cut to the longest a handle may be. '' when nothing is left.
 */
export function handleBaseFromName(name: string): string {
  const latin = [...name.toLowerCase()]
    .map((ch) => CYRILLIC[ch] ?? LATIN_EXTRA[ch] ?? ch)
    .join("")
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
  return latin.replace(/[^a-z0-9]+/g, "").slice(0, HANDLE_LENGTH.max);
}

/**
 * What can be said of a typed handle at once, without genex.games: its shape problem (with a Latin
 * handle to try when it has letters a handle can't take), or that it is the account's own (`own`).
 * Null for any other well-formed handle: whether it is free is genex.games' to say.
 */
export function localHandleCheck(raw: string, own: string | null): HandleCheck | null {
  const handle = normalizeHandleInput(raw);
  const problem = handleProblem(handle);
  if (problem === HandleProblem.LatinOnly) {
    const latin = handleBaseFromName(handle);
    return { handle, state: problem, suggestions: isHandle(latin) ? [latin] : [] };
  }
  if (problem) return { handle, state: problem, suggestions: [] };
  return handle === own ? { handle, state: HandleState.Yours, suggestions: [] } : null;
}

/** Whether a handle in this state may be kept: it is free, or the account's own already. */
export const handleKept = (state: HandleState): boolean => state === HandleState.Free || state === HandleState.Yours;

/** Whether the field shows this state as Taken: taken, or a word genex.games keeps. */
export const shownAsTaken = (state: HandleState): boolean =>
  state === HandleState.Taken || state === HandleState.Reserved;
