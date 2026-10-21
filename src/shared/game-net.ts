/**
 * A Rust game's net view as Studio reads it (game-systems MP-7): the `__net` runtime key a game
 * built with `[net]` puts in its `state()` (display only, never in the checksum), copied out of the
 * untrusted state with only its known fields. The vocabularies restate genex-net's (`vocab.rs`,
 * `NetMode`, `NetStatus`, `NetOffline`) in their exact wire spelling; the facade vocabulary
 * fixture holds both sides to the same lists. Browser-safe: the stage's net row reads it.
 */

/** The runtime key of the net view in a game's `state()`. */
export const NET_STATE_KEY = "__net";

/** Which backend the build chose (genex-net `NetMode`). Wire values; never rename one. */
export const NetMode = {
  /** Built without `[net]`: the API compiles, nothing connects. */
  Off: "off",
  /** Studio Live, captures, judges, demos and tests: an in-process room. */
  Loopback: "loopback",
  /** Exports and the web draft: the relay. */
  Relay: "relay",
  /** A journal fed back (tests). */
  Replay: "replay",
} as const;
export type NetMode = (typeof NetMode)[keyof typeof NetMode];

/** Where the seat stands (genex-net `NetStatus`). Wire values; never rename one. */
export const NetStatus = {
  Offline: "offline",
  Connecting: "connecting",
  Searching: "searching",
  Waiting: "waiting",
  Joined: "joined",
  Reconnecting: "reconnecting",
  Closed: "closed",
} as const;
export type NetStatus = (typeof NetStatus)[keyof typeof NetStatus];

/** Why the seat is offline before any connect (genex-net `NetOffline`). Wire values; never rename one. */
export const NetOffline = {
  Disabled: "net-disabled",
  NoSlug: "net-no-slug",
  NoIdentity: "net-no-identity",
  Unsupported: "net-unsupported",
  LocalTest: "net-local-test",
} as const;
export type NetOffline = (typeof NetOffline)[keyof typeof NetOffline];

/** The relay's seat cap (genex-net `NET_PLAYERS_MAX`): a count above it is outside the shape. */
export const NET_PLAYERS_MAX = 64;

/** `state().__net`, as far as Studio shows it. */
export interface NetView {
  mode: NetMode;
  status: NetStatus;
  /** Why the seat is offline; null while it is not, or when the game named no reason. */
  reason: NetOffline | null;
  /** Players in the room, me included. */
  players: number;
  /** Players whose connection is live. */
  connected: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `value` when it is one of `vocabulary`'s wire values, else null. */
const wordOf = <T extends string>(vocabulary: Record<string, T>, value: unknown): T | null =>
  Object.values(vocabulary).find((word) => word === value) ?? null;

/** `value` when it is a seat count the relay allows, else null. */
function seatCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return value >= 0 && value <= NET_PLAYERS_MAX ? value : null;
}

/** The reason a raw view names: null when it names none, undefined when it names one outside the vocabulary. */
function reasonOf(value: unknown): NetOffline | null | undefined {
  if (value === undefined) return null;
  return wordOf(NetOffline, value) ?? undefined;
}

/**
 * The net view of a game's untrusted `state()`, copied with only its known fields; null when the
 * game reports none (built without `[net]` and no `game.net`) or reports one outside its shape.
 */
export function netViewOf(state: unknown): NetView | null {
  const raw = isRecord(state) ? state[NET_STATE_KEY] : undefined;
  if (!isRecord(raw)) return null;
  const mode = wordOf(NetMode, raw.mode);
  const status = wordOf(NetStatus, raw.status);
  const reason = reasonOf(raw.reason);
  if (mode === null || status === null) return null;
  if (reason === undefined) return null;
  const players = seatCount(raw.players);
  const connected = seatCount(raw.connected);
  if (players === null || connected === null) return null;
  return { mode, status, reason, players, connected };
}
