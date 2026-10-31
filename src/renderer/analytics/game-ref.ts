/**
 * A random id per game, kept on this Mac, so one game's events can be joined (time to a first
 * playable build, reruns, a game made and never written to) without ever naming it. A ref is drawn
 * at random the first time a game is asked about, never derived from its name, and only the ref
 * leaves; the name it stands for stays in this profile's storage.
 */
import { browserStorage, type KeyValueStorage, readJson, STORAGE_KEYS, writeJson } from "../storage.ts";

/** How many games keep a ref; past this the oldest is forgotten (a game of its may get a new one). */
export const GAME_REFS_MAX = 500;
/** Random bytes in a ref: 16 hex characters. */
const REF_BYTES = 8;
const REF_SHAPE = /^[0-9a-f]{16}$/;

/** The games' refs, oldest first, as `[name, ref]` pairs: a game named "2048" keeps its place too. */
type GameRefs = ReadonlyArray<readonly [string, string]>;

const isPair = (value: unknown): value is [string, string] =>
  Array.isArray(value) && value.length === 2 && typeof value[0] === "string" && REF_SHAPE.test(String(value[1]));

/** The refs kept, with anything malformed left out. */
function readRefs(storage: KeyValueStorage | null): GameRefs {
  const kept: unknown = readJson<unknown>(STORAGE_KEYS.analyticsGames, [], storage);
  return Array.isArray(kept) ? kept.filter(isPair) : [];
}

/** Refs for games this window met while nothing could be kept: they last until it closes. */
const unkept = new Map<string, string>();

/** A new ref: 16 random hex characters. */
export function randomRef(): string {
  const bytes = new Uint8Array(REF_BYTES);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The game's ref (by its folder name, which a rename keeps), drawn the first time it is asked for.
 * Null for no game. A draw that does not look like a ref is drawn again from `randomRef`.
 */
export function gameRef(
  name: string | null | undefined,
  storage: KeyValueStorage | null = browserStorage(),
  random: () => string = randomRef,
): string | null {
  if (!name) return null;
  const refs = readRefs(storage);
  const known = refs.find(([game]) => game === name)?.[1] ?? unkept.get(name);
  if (known) return known;
  const drawn = random();
  const ref = REF_SHAPE.test(drawn) ? drawn : randomRef();
  const next = [...refs, [name, ref] as const].slice(-GAME_REFS_MAX);
  if (!writeJson(STORAGE_KEYS.analyticsGames, next, storage)) unkept.set(name, ref);
  return ref;
}
