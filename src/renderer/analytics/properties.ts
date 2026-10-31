/**
 * What an analytics property may hold, and the buckets that keep sizes from naming anything: an
 * enum from the app's own vocabularies, a switch, a count or a duration — never what a person
 * wrote, a name they chose, a path, an id of theirs or English the app shows.
 */

/** One property value. */
export type EventValue = string | number | boolean | null | readonly string[];
/** An event's properties. Declare each event's as a `type` (not an `interface`) so it fits this. */
export type EventProperties = { readonly [key: string]: EventValue | undefined };

/** How long a text was, never what it said. */
export const CharsBucket = {
  None: "0",
  Short: "1-40",
  Medium: "41-200",
  Long: "201-1000",
  Huge: "1000+",
} as const;
export type CharsBucket = (typeof CharsBucket)[keyof typeof CharsBucket];

const CHARS_LIMITS: ReadonlyArray<[number, CharsBucket]> = [
  [0, CharsBucket.None],
  [40, CharsBucket.Short],
  [200, CharsBucket.Medium],
  [1000, CharsBucket.Long],
];

/** The bucket a text's length falls in. */
export function charsBucket(length: number): CharsBucket {
  return CHARS_LIMITS.find(([limit]) => length <= limit)?.[1] ?? CharsBucket.Huge;
}

/** How many of something, in steps that say enough. */
export const CountBucket = {
  None: "0",
  One: "1",
  Few: "2-5",
  Several: "6-20",
  Many: "21+",
} as const;
export type CountBucket = (typeof CountBucket)[keyof typeof CountBucket];

const COUNT_LIMITS: ReadonlyArray<[number, CountBucket]> = [
  [0, CountBucket.None],
  [1, CountBucket.One],
  [5, CountBucket.Few],
  [20, CountBucket.Several],
];

/** The bucket a count falls in. */
export function countBucket(count: number): CountBucket {
  return COUNT_LIMITS.find(([limit]) => count <= limit)?.[1] ?? CountBucket.Many;
}

/** A duration in whole milliseconds, never negative: clocks that jump back report 0. */
export const elapsedMs = (from: number, to: number): number => Math.max(0, Math.round(to - from));

/** The word of a vocabulary a value spells, or null: never a free string. */
export function oneOf<V extends string>(vocabulary: Readonly<Record<string, V>>, value: unknown): V | null {
  for (const word of Object.values(vocabulary)) if (word === value) return word;
  return null;
}
