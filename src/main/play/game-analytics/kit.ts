/**
 * What every parser of a game's analytics reads genex.games' JSON with. An answer is hostile input:
 * its words are written by anyone who can craft a link or a game (campaign tags, referrers, event
 * names), so numbers are held to what they count, lists are cut, and words lose the characters that
 * turn their direction or control a terminal.
 *
 * One rule runs through every reader here: it answers `undefined` for a value that is not what it
 * should be, and `null` only where the contract itself says "not known yet". A parser collects its
 * parts in {@link whole}, which answers undefined when any part was not read, so a broken answer
 * fails as a whole and never reads as zeros; the exported parser ends with `?? null`. A row of a
 * list is the exception: {@link rows} leaves out the ones that do not read and keeps the rest.
 *
 * `store.ts` keeps its own `line`, `wholeIn` and `listOf` private; these do the same work.
 */
import type { Compared, Measure } from "../../../shared/game-analytics.ts";
import { withoutBidiControls } from "../../../shared/play-purchase.ts";
import { isRecord } from "../gallery.ts";

/** Control characters (C0, DEL, C1) and the two separators that break a line. */
const CONTROLS = /[\p{Cc}\u2028\u2029]/gu;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A country as genex.games names one: two letters, in either case. */
const COUNTRY = /^[A-Za-z]{2}$/;
/** An ISO time with its zone, as genex.games writes one; `Date.parse` alone takes much more. */
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Reads one value: undefined when it is not what it should be. */
export type Read<Value> = (value: unknown) => Value | undefined;

/** A whole count, not below zero: a fraction or a negative number is not one. */
export const count: Read<number> = (value) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** A measured amount (seconds, frames a second, Nex per player): finite and not below zero. */
export const amount: Read<number> = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** A rate: a fraction from 0 to 1. */
export const rate: Read<number> = (value) =>
  typeof value === "number" && value >= 0 && value <= 1 ? value : undefined;

/** `read`, which also takes the wire's null for "not known yet" and keeps it null. */
export const orNull =
  <Value>(read: Read<Value>): Read<Value | null> =>
  (value) =>
    value === null ? null : read(value);

/** A rate, or null while it cannot be known. */
export const rateOrNull: Read<number | null> = orNull(rate);

/** A number now and over the period before: counts unless `read` says otherwise. */
export function compared(value: unknown, read: Read<number> = count): Compared | undefined {
  if (!isRecord(value)) return undefined;
  const now = read(value.now);
  const before = read(value.before);
  return now === undefined || before === undefined ? undefined : { now, before };
}

/** A rate, a median or an average now and before, each null when there is nothing to measure. */
export function measure(value: unknown, read: Read<number> = amount): Measure | undefined {
  if (!isRecord(value)) return undefined;
  const now = orNull(read)(value.now);
  const before = orNull(read)(value.before);
  return now === undefined || before === undefined ? undefined : { now, before };
}

/**
 * Exactly `length` values, each read by `read`: `series(value, days, count)` for one number a day,
 * `series(value, days, rateOrNull)` for one that may hold nulls. One value that does not read
 * spoils the series.
 */
export function series<Value>(value: unknown, length: number, read: Read<Value>): Value[] | undefined {
  return Array.isArray(value) && value.length === length ? everyOne(value, read) : undefined;
}

/** A series of any length up to `max`, as a retention curve is. */
export function shortSeries<Value>(value: unknown, max: number, read: Read<Value>): Value[] | undefined {
  return Array.isArray(value) && value.length <= max ? everyOne(value, read) : undefined;
}

/** Every item read by `read`, or undefined when one of them does not read. */
function everyOne<Value>(items: readonly unknown[], read: Read<Value>): Value[] | undefined {
  const values: Value[] = [];
  for (const item of items) {
    const value = read(item);
    if (value === undefined) return undefined;
    values.push(value);
  }
  return values;
}

/**
 * A list's first `max` rows that read, in the order sent; a row `read` cannot read is left out, and
 * so is a second row with the same `key`. Undefined when the value is not a list at all.
 */
export function rows<Row>(value: unknown, max: number, read: Read<Row>, key?: (row: Row) => string): Row[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const kept: Row[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (kept.length === max) break;
    const row = read(item);
    if (row === undefined) continue;
    if (key) {
      if (seen.has(key(row))) continue;
      seen.add(key(row));
    }
    kept.push(row);
  }
  return kept;
}

/**
 * One line of someone's words, cleaned of the characters that turn text around or control a
 * terminal and trimmed: undefined when it is not text, is empty, or is longer than `max`.
 */
export function line(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = withoutBidiControls(value).replace(CONTROLS, "").trim();
  return clean && clean.length <= max ? clean : undefined;
}

/** A predicate for the values of a vocabulary object: `oneOf(SourceChannel)`. */
export function oneOf<const Vocabulary extends Readonly<Record<string, string>>>(
  vocabulary: Vocabulary,
): (value: unknown) => value is Vocabulary[keyof Vocabulary] {
  const values: ReadonlySet<unknown> = new Set(Object.values(vocabulary));
  return (value): value is Vocabulary[keyof Vocabulary] => values.has(value);
}

/** A country's two letters, kept in capitals whichever case they came in: a table's key and a group's alike. */
export const countryCode: Read<string> = (value) =>
  typeof value === "string" && COUNTRY.test(value) ? value.toUpperCase() : undefined;

/** A UTC day (`YYYY-MM-DD`) that exists. */
export const isoDay: Read<string> = (value) => {
  if (typeof value !== "string" || !DAY.test(value)) return undefined;
  const at = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(at) && new Date(at).toISOString().slice(0, 10) === value ? value : undefined;
};

/** A time genex.games wrote, as the ISO text of that moment in UTC. */
export const isoTime: Read<string> = (value) => {
  if (typeof value !== "string" || !TIME.test(value)) return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
};

/** `Parts` with every part read. */
type Whole<Parts> = { [Key in keyof Parts]: Exclude<Parts[Key], undefined> };

const isWhole = <Parts extends Record<string, unknown>>(parts: Parts): parts is Parts & Whole<Parts> =>
  Object.values(parts).every((part) => part !== undefined);

/** `parts` when every one of them was read, else undefined: how a reader of several parts ends. */
export function whole<Parts extends Record<string, unknown>>(parts: Parts): Whole<Parts> | undefined {
  return isWhole(parts) ? parts : undefined;
}
