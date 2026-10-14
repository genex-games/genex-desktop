/**
 * The Genex promo, as pure decisions: a finished welcome queues it once, it shows while Genex can
 * still be connected, it settles for good once it is dismissed or a Genex account is connected, and
 * floats over Home or a game's stage while no dialog is open. `panels/GenexPromo.tsx` draws the
 * card these decide.
 */
import type { ConnectionSnapshot } from "../shared/connections.ts";
import { type KeyValueStorage, browserStorage, readText, STORAGE_KEYS, writeText } from "./storage.ts";

/** Where the promo stands on this profile. Persisted: never rename a value. */
export const GenexPromoState = {
  /** The welcome ended; the card waits for its moment. */
  Pending: "pending",
  /** Dismissed or connected: never shown again. */
  Done: "done",
} as const;
export type GenexPromoState = (typeof GenexPromoState)[keyof typeof GenexPromoState];

/** A plugin's account, as the host's connection snapshot reports it. */
export type PromoAccount = ConnectionSnapshot["sources"][number]["account"];

/** The welcome just ended: queue the promo, unless it was queued or settled before. */
export function queueGenexPromo(storage: KeyValueStorage | null = browserStorage()): void {
  if (readText(STORAGE_KEYS.genexPromo, storage) === null)
    writeText(STORAGE_KEYS.genexPromo, GenexPromoState.Pending, storage);
}

/** Settle the promo for good: dismissed, connected, or no longer needed. */
export function finishGenexPromo(storage: KeyValueStorage | null = browserStorage()): void {
  writeText(STORAGE_KEYS.genexPromo, GenexPromoState.Done, storage);
}

/** The promo's stored state, or null when the welcome never queued it. */
export const storedGenexPromo = (storage: KeyValueStorage | null = browserStorage()): string | null =>
  readText(STORAGE_KEYS.genexPromo, storage);

/** What decides whether the card is on screen. */
export interface PromoInput {
  stored: string | null;
  /** The Genex plugin as installed, or undefined when there is none. */
  plugin: { installed: boolean; enabled: boolean } | undefined;
  account: PromoAccount;
  welcoming: boolean;
  pluginsOpen: boolean;
  overlayOpen?: boolean;
}

/**
 * Accounts the card can still help with. A new profile's account starts `locked`: nothing is known
 * to be saved until the credential store is unlocked, which Connect does first.
 */
const CONNECTABLE: ReadonlySet<PromoAccount> = new Set<PromoAccount>([
  "locked",
  "not connected",
  "authorizing",
  "failed",
]);

/** Whether the card shows: queued, Genex installed and on, an account still to connect, nothing in front of it. */
export function genexPromoVisible(input: PromoInput): boolean {
  const covered = input.welcoming || input.pluginsOpen || input.overlayOpen;
  if (input.stored !== GenexPromoState.Pending || covered) return false;
  if (!input.plugin?.installed || !input.plugin.enabled) return false;
  return CONNECTABLE.has(input.account);
}

/** Whether a Genex account is connected, so the promo has nothing left to offer. */
export const genexPromoSettled = (account: PromoAccount): boolean => account === "unlocked";

/** The card's steps: the offer, waiting on the browser, connected, or a sign-in to try again. */
export const PromoPhase = {
  Offer: "offer",
  Waiting: "waiting",
  Connected: "connected",
  Failed: "failed",
} as const;
export type PromoPhase = (typeof PromoPhase)[keyof typeof PromoPhase];

/** The sign-in the card started: whether it did, what went wrong, and whether the browser step was reached. */
export interface PromoAttempt {
  started: boolean;
  error: string;
  /** The account reported `authorizing` since the card started: a later return means it ended. */
  sawSignIn: boolean;
}

/** The card's step for the account's state and the sign-in the card itself started. */
export function promoPhase(account: PromoAccount, attempt: PromoAttempt): PromoPhase {
  if (attempt.started && genexPromoSettled(account)) return PromoPhase.Connected;
  if (attempt.error) return PromoPhase.Failed;
  if (account === "authorizing") return PromoPhase.Waiting;
  if (attempt.started) return attempt.sawSignIn ? PromoPhase.Failed : PromoPhase.Waiting;
  return account === "failed" ? PromoPhase.Failed : PromoPhase.Offer;
}
