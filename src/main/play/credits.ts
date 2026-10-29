/**
 * The Genex account's credits for the Genex plugin's Credits tab, read from genex.games at once: the
 * balance, the Pro plan's allowance and when it comes, the invite bonus, the price list (public,
 * never typed into the app) and the last few spends and refunds. A part genex.games does not answer
 * is left out rather than failing the tab. Electron-free, like the gallery.
 */
import {
  type CreditEntry,
  type CreditPlan,
  isCreditKind,
  type PlayCredits,
  RECENT_CREDITS,
} from "../../shared/play-credits.ts";
import { type GalleryDeps, isRecord, PlayRoute, SignInNeeded, text } from "./gallery.ts";
import { countOf } from "./people.ts";

/** The routes the Credits tab reads. */
export const CreditsRoute = {
  Me: "/api/credits/me",
  Prices: "/api/credits/prices",
  Ledger: "/api/credits/ledger",
  Plan: "/api/plans/me",
} as const;

/** Ledger reasons that give credits back for a generation. Wire values. */
const REFUND_REASONS: readonly string[] = ["refund_failed_generation", "refund", "refund_platform_fault"];
const ID_MAX = 64;
const TITLE_MAX = 200;

/** An ISO date the API sent, or null. */
const isoDate = (value: unknown): string | null =>
  typeof value === "string" && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null;

/** The cheapest price of each kind the price list names. */
export function toPrices(body: unknown): PlayCredits["prices"] {
  const lanes = isRecord(body) && Array.isArray(body.lanes) ? body.lanes : [];
  const prices: PlayCredits["prices"] = {};
  for (const lane of lanes) {
    const from = isRecord(lane) ? countOf(lane.from) : null;
    if (isRecord(lane) && isCreditKind(lane.kind) && from !== null) prices[lane.kind] = from;
  }
  return prices;
}

/** One ledger row as a spend or a refund; null for grants and anything unreadable. */
function toEntry(value: unknown): CreditEntry | null {
  if (!isRecord(value) || typeof value.amount !== "number" || !Number.isInteger(value.amount)) return null;
  const id = text(value.id, ID_MAX);
  const at = isoDate(value.createdAt);
  const refund = typeof value.reason === "string" && REFUND_REASONS.includes(value.reason) && value.amount > 0;
  if (!id || !at || (value.amount >= 0 && !refund)) return null;
  const game = isRecord(value.game) ? text(value.game.title, TITLE_MAX).trim() || null : null;
  return { id, amount: value.amount, kind: isCreditKind(value.kind) ? value.kind : null, refund, at, game };
}

/** The last few spends and refunds, newest first, as the ledger lists them. */
export function toRecent(body: unknown): CreditEntry[] {
  const rows = isRecord(body) && Array.isArray(body.transactions) ? body.transactions : [];
  return rows
    .map(toEntry)
    .filter((entry): entry is CreditEntry => entry !== null)
    .slice(0, RECENT_CREDITS);
}

/** The Pro plan, when the account is a member. */
export function toPlan(body: unknown): CreditPlan | null {
  if (!isRecord(body) || body.member !== true) return null;
  return { allowance: countOf(body.allowance) ?? 0, resetsAt: isoDate(body.resetsAt) };
}

/** The Credits tab's reads over `deps`. */
export function genexCredits(deps: GalleryDeps) {
  const { request, token } = deps;

  /** Everything the Credits tab shows; throws only when the account is signed out. */
  const credits = async (): Promise<PlayCredits> => {
    const current = await token();
    if (!current) throw new SignInNeeded();
    const read = async (route: string, auth?: string): Promise<unknown> => {
      const answer = await request(route, { method: "GET", ...(auth ? { token: auth } : {}) }).catch(() => null);
      return answer && answer.status >= 200 && answer.status < 300 ? answer.body : null;
    };
    const [me, prices, plan, referral, ledger] = await Promise.all([
      read(CreditsRoute.Me, current),
      read(CreditsRoute.Prices),
      read(CreditsRoute.Plan, current),
      read(PlayRoute.Referral, current),
      read(CreditsRoute.Ledger, current),
    ]);
    const spendable = isRecord(me) ? (countOf(me.spendable) ?? countOf(me.balance)) : null;
    return {
      balance: spendable,
      unlimited: isRecord(me) && me.unlimited === true,
      plan: toPlan(plan),
      inviteBonus: isRecord(referral) ? countOf(referral.inviterBonus) : null,
      prices: toPrices(prices),
      recent: toRecent(ledger),
    };
  };

  return { credits };
}

/** The Credits tab's reads as `genexCredits` makes them. */
export type GenexCredits = ReturnType<typeof genexCredits>;
