/**
 * The Genex player sign-in for the plan watcher, ported from genex-demo
 * `apps/cli/src/lib/player/auth.ts`: genex.games' device sign-in with one field more,
 * `scope: 'player'`. That field decides what the approval page says and what genex.games mints: a
 * session that reaches the seven player routes and can move no money. It rides on the request that
 * starts the sign-in, so the person approves the smaller thing they were shown.
 *
 * The credential is kept in the OS secret store (`GENEX_PLAYER_CREDENTIAL_SECRET`), never in
 * `~/.genex/player.json`, apart from the creator's Genex account, and bound to the API it was
 * minted by: a development profile pointing Play at another genex.games reads it as signed out
 * rather than sending it there. An approval that names any scope but `player` is refused, so a
 * full account credential is never kept for an unattended watcher.
 */
import { DeviceStatus, GenexRoute, MIN_POLL_INTERVAL_S } from "../../plugins/genex/http.ts";
import { DAY_MS, SECOND_MS } from "../../shared/duration.ts";
import { isPlainRecord } from "../../shared/game-ai.ts";
import { onWebsite } from "../play/origins.ts";

/** The scope a player credential is asked for and must come back with. Wire value: never rename it. */
export const PLAYER_SCOPE = "player";
/** The stored credential's shape version. */
const CREDENTIAL_VERSION = 1;
/** One sign-in request, including reading its answer. */
const REQUEST_TIMEOUT_MS = 20 * SECOND_MS;
/** genex.games' device polls are never faster than this, whatever it asks. */
const MIN_POLL_MS = MIN_POLL_INTERVAL_S * SECOND_MS;
/** How long a sign-in waits for the browser when genex.games names no lifetime. */
const DEFAULT_SIGN_IN_MS = 10 * 60 * SECOND_MS;
/** The longest a sign-in may wait, whatever genex.games names. */
const MAX_SIGN_IN_MS = 60 * 60 * SECOND_MS;
/** How long a credential lives when genex.games names no end. */
const DEFAULT_CREDENTIAL_MS = 30 * DAY_MS;
/** The answer genex.games gives when a device code expired. */
const HTTP_GONE = 410;
/** The answer genex.games gives on a user-code collision: ask once more. */
const HTTP_CONFLICT = 409;
/** A player token: printable, no space, bounded. */
const TOKEN_RE = /^[\x21-\x7e]{16,4096}$/;
/** A device or user code as genex.games spells them. */
const CODE_RE = /^[A-Za-z0-9_-]{1,200}$/;

const MESSAGE = {
  NoPlayerSignIn: "This genex.games has no player sign-in",
  StartFailed: (status: number) => `genex.games did not start a player sign-in (HTTP ${status})`,
  BadStart: "genex.games answered a player sign-in with a page the app does not open",
} as const;

/** The player credential as the secret store keeps it. */
export interface PlayerCredential {
  v: typeof CREDENTIAL_VERSION;
  /** The API origin it was minted by, and the only one it is sent to. */
  api: string;
  token: string;
  expiresAt: string;
}

/** A sign-in waiting for the browser. */
export interface PendingSignIn {
  deviceCode: string;
  userCode: string;
  verifyUrl: string;
  expiresAt: number;
  intervalMs: number;
}

/** What one poll came to. Wire values: never rename one. */
export const SignInPoll = {
  Pending: "pending",
  Approved: "approved",
  /** Declined, expired, or minted for the wrong scope: the sign-in is over. */
  Ended: "ended",
} as const;
export type SignInPoll = (typeof SignInPoll)[keyof typeof SignInPoll];

/** What the sign-in talks to. */
export interface SignInDeps {
  api: string;
  /** The website the approval page must be a page of. */
  web: string;
  fetch: typeof fetch;
}

/** The stored credential, or null: it must read, belong to `api` and not have expired. */
export function readPlayerCredential(raw: string | null, api: string, now: number): PlayerCredential | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainRecord(parsed) || parsed.v !== CREDENTIAL_VERSION || parsed.api !== api) return null;
  const { token, expiresAt } = parsed;
  if (typeof token !== "string" || !TOKEN_RE.test(token) || typeof expiresAt !== "string") return null;
  const until = Date.parse(expiresAt);
  return Number.isFinite(until) && until > now ? { v: CREDENTIAL_VERSION, api, token, expiresAt } : null;
}

/** A credential as the secret store keeps it. */
export const writePlayerCredential = (credential: PlayerCredential): string => JSON.stringify(credential);

/** One sign-in request: POST, JSON, no credential, no redirect, bounded in time. */
async function post(deps: SignInDeps, route: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const res = await deps.fetch(deps.api + route, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text().catch(() => "");
  try {
    return { status: res.status, body: text ? JSON.parse(text) : null };
  } catch {
    return { status: res.status, body: null };
  }
}

/** A started sign-in as genex.games answered it, or null when it is not one the app follows. */
function readStart(body: unknown, deps: SignInDeps, now: number): PendingSignIn | null {
  if (!isPlainRecord(body)) return null;
  const { deviceCode, userCode, verifyUrl, expiresIn, interval } = body;
  const codes = typeof deviceCode === "string" && CODE_RE.test(deviceCode) && typeof userCode === "string";
  if (!codes || !CODE_RE.test(userCode.replaceAll("-", "_")) || typeof verifyUrl !== "string") return null;
  // The approval page is a page of the website Play links to, over https unless it is this Mac.
  if (!onWebsite(verifyUrl, deps.web)) return null;
  const lasts = typeof expiresIn === "number" && expiresIn > 0 ? expiresIn * SECOND_MS : DEFAULT_SIGN_IN_MS;
  const every = typeof interval === "number" && interval > 0 ? interval * SECOND_MS : MIN_POLL_MS;
  return {
    deviceCode,
    userCode,
    verifyUrl,
    expiresAt: now + Math.min(MAX_SIGN_IN_MS, lasts),
    intervalMs: Math.max(MIN_POLL_MS, every),
  };
}

/** Start a player sign-in; throws when genex.games has none or answers with a page the app does not open. */
export async function startPlayerSignIn(deps: SignInDeps, label: string, now: number): Promise<PendingSignIn> {
  // One retry: a user-code collision answers 409, and the fix is to ask again.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const answer = await post(deps, GenexRoute.DeviceStart, { label, scope: PLAYER_SCOPE });
    if (answer.status === HTTP_CONFLICT) continue;
    if (answer.status === 404 || answer.status === 501) throw new Error(MESSAGE.NoPlayerSignIn);
    if (answer.status < 200 || answer.status > 299) throw new Error(MESSAGE.StartFailed(answer.status));
    const pending = readStart(answer.body, deps, now);
    if (!pending) throw new Error(MESSAGE.BadStart);
    return pending;
  }
  throw new Error(MESSAGE.StartFailed(HTTP_CONFLICT));
}

/** The credential an approval carries, or null: a player scope and a token that reads. */
function approvedCredential(body: Record<string, unknown>, api: string, now: number): PlayerCredential | null {
  const { token, scope, expiresAt } = body;
  if (scope !== PLAYER_SCOPE || typeof token !== "string" || !TOKEN_RE.test(token)) return null;
  const until = typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
  const end = Number.isFinite(until) && until > now ? until : now + DEFAULT_CREDENTIAL_MS;
  return { v: CREDENTIAL_VERSION, api, token, expiresAt: new Date(end).toISOString() };
}

/**
 * Ask genex.games once whether the browser approved. A network failure is not an answer (the
 * sign-in still waits until it expires); a decline, an expired code or the wrong scope ends it.
 */
export async function pollPlayerSignIn(
  deps: SignInDeps,
  pending: PendingSignIn,
  now: number,
): Promise<
  | { poll: typeof SignInPoll.Approved; credential: PlayerCredential }
  | { poll: Exclude<SignInPoll, typeof SignInPoll.Approved> }
> {
  if (now > pending.expiresAt) return { poll: SignInPoll.Ended };
  const answer = await post(deps, GenexRoute.DevicePoll, { deviceCode: pending.deviceCode }).catch(() => null);
  if (!answer) return { poll: SignInPoll.Pending };
  if (answer.status === HTTP_GONE) return { poll: SignInPoll.Ended };
  if (answer.status < 200 || answer.status > 299 || !isPlainRecord(answer.body)) return { poll: SignInPoll.Pending };
  const { status } = answer.body;
  if (status === DeviceStatus.Denied || status === DeviceStatus.Expired) return { poll: SignInPoll.Ended };
  if (status !== DeviceStatus.Approved) return { poll: SignInPoll.Pending };
  const credential = approvedCredential(answer.body, deps.api, now);
  return credential ? { poll: SignInPoll.Approved, credential } : { poll: SignInPoll.Ended };
}
