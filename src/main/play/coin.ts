/**
 * The coin client behind Play's purchase sheet: a purchase (genex.games calls it an intent) and the
 * account's balance read on genex.games, and the purchase confirmed or canceled as the app's Genex
 * account from Studio's own sheet. This is the sheet's one seam to genex.games: the surface Studio
 * names when it confirms ({@link STUDIO_CONFIRM_SURFACE}) and `confirm`/`cancel` themselves. A
 * purchase is named only by the id genex.games gave it, and what genex.games answers is read as
 * hostile input. Electron-free: the request, the token and the refused-token report come in as deps.
 */
import { isIntentId, type PurchaseHeld, withoutBidiControls } from "../../shared/play-purchase.ts";
import {
  type GalleryAnswer,
  type GalleryDeps,
  GalleryError,
  type GalleryRequest,
  HTTP_UNAUTHORIZED,
  imageUrl,
  isCursor,
  isRecord,
  SignInNeeded,
} from "./gallery.ts";
import { refusingRequest } from "./people.ts";

/** The most coin one purchase may cost here: genex.games' cap on the surface Studio confirms on. */
const COINS_MAX = 100_000;
/** The most of one item a purchase may be for: genex.games' own rule for a game's `buy()`. */
const QUANTITY_MAX = 99;
/** genex.games' own limits on a game's words: an item's name, and the terms of a payment it priced. */
const NAME_MAX = 80;
const TERMS_MAX = 1000;
/** A success that does not answer what was asked reads as a bad gateway, as the gallery's do. */
const BAD_GATEWAY = 502;
/** HTTP statuses from here on are genex.games failing, not refusing: a payment may still land. */
const SERVER_ERROR = 500;

const MESSAGE = { BadIntent: "Not a purchase on genex.games" } as const;

/** The routes the coin client calls. */
export const CoinRoute = {
  Balance: "/api/coin/balance",
  intent: (id: string) => `/api/coin/intents/${encodeURIComponent(id)}`,
  confirm: (id: string) => `/api/coin/intents/${encodeURIComponent(id)}/confirm`,
  cancel: (id: string) => `/api/coin/intents/${encodeURIComponent(id)}/cancel`,
} as const;

/** Where a purchase stands on genex.games. Values are genex.games' own: never rename one. */
export const CoinIntentStatus = {
  RequiresConfirmation: "requires_confirmation",
  /** A confirm is under way (here or elsewhere): neither paid nor refused yet. */
  Processing: "processing",
  Succeeded: "succeeded",
  /** Paid, and the game has already taken the item. */
  Consumed: "consumed",
  Expired: "expired",
  Canceled: "canceled",
  Failed: "failed",
  Refunded: "refunded",
} as const;
export type CoinIntentStatus = (typeof CoinIntentStatus)[keyof typeof CoinIntentStatus];

/** Why genex.games refused a call or failed a purchase. Values are its own codes: never rename one. */
export const CoinFailure = {
  InsufficientBalance: "insufficient_balance",
  IntentExpired: "intent_expired",
  /** The price is over what the surface Studio confirms on may approve. */
  SurfaceCap: "surface_cap",
  SkuInactive: "sku_inactive",
  ProjectNotFound: "project_not_found",
  /** A payment the game priced was confirmed without naming its terms ({@link PaymentPolicy}). */
  PaymentConfirmationRequired: "payment_confirmation_required",
  IntentNotPending: "intent_not_pending",
  IntentNotFound: "intent_not_found",
  /** The purchase is another account's (genex.games answers it as not found). */
  NotYourPurchase: "not_your_purchase",
  ForbiddenOrigin: "forbidden_origin",
  /** genex.games took the token for a read but not for a confirm or cancel: it refuses Studio's sheet. */
  ConfirmRequiresSession: "confirm_requires_session",
  /** A code the client does not know, or none at all. */
  Unknown: "unknown",
} as const;
export type CoinFailure = (typeof CoinFailure)[keyof typeof CoinFailure];

/** Where genex.games is told a purchase was confirmed. Values are its own: never rename one. */
export const ConfirmSurface = {
  ParentFrame: "parent_frame",
  Popup: "popup",
  NativeModal: "native_modal",
  NestedFrame: "nested_frame",
  LocalTest: "local_test",
} as const;
export type ConfirmSurface = (typeof ConfirmSurface)[keyof typeof ConfirmSurface];

/** What a confirm acknowledges it showed. Values are genex.games' own: never rename one. */
export const PaymentPolicy = {
  /** The sheet showed a game-priced payment's own title, terms and amount. */
  DynamicV1: "dynamic-payment-v1",
} as const;
export type PaymentPolicy = (typeof PaymentPolicy)[keyof typeof PaymentPolicy];

/**
 * The surface Studio names when it confirms: its sheet is drawn in a native view above the game's,
 * which the game can neither paint over nor hide. genex.games caps it at {@link COINS_MAX} coin.
 * UNCONFIRMED: genex.games has yet to agree that Studio confirms through this door on this surface;
 * if it names another, this is the line to change.
 */
export const STUDIO_CONFIRM_SURFACE: ConfirmSurface = ConfirmSurface.NativeModal;

/** A purchase as the sheet shows it and a confirm needs it. */
export interface CoinIntent {
  id: string;
  status: CoinIntentStatus;
  /** The game it is for; null for a payment genex.games holds for no game. */
  projectId: string | null;
  /** A payment the game priced itself (no SKU): confirming it names {@link PaymentPolicy.DynamicV1}. */
  dynamic: boolean;
  name: string;
  /** The terms the game wrote for its own price, whole; null with none. */
  description: string | null;
  /** On a host the app loads images from, else null. */
  iconUrl: string | null;
  quantity: number;
  unitPriceCoins: number;
  totalCoins: number;
  /** What the coin is worth in US cents, as genex.games shows it; null when it gives none. */
  usdCents: number | null;
  /** When genex.games lets the purchase lapse, in milliseconds since the epoch. */
  expiresAt: number;
  /** Why genex.games ended it, when it says. */
  failure: CoinFailure | null;
}

/** The account's coin as the sheet reads it: what it may spend, and what it earned that is still on hold. */
export interface CoinWallet {
  spendable: number;
  /** Null with none on hold, or when genex.games does not say when it is ready (an older API). */
  held: PurchaseHeld | null;
}

/** genex.games refused a call for a reason it named: `code` says which, `status` is the HTTP status. */
export class CoinRefused extends Error {
  readonly code: CoinFailure;
  readonly status: number;
  constructor(route: string, status: number, code: CoinFailure) {
    super(`Genex ${route}: HTTP ${status} ${code}`);
    this.code = code;
    this.status = status;
  }
}

/** What the coin client needs beyond the gallery's deps. */
export interface CoinDeps extends GalleryDeps {
  /** genex.games refused `token` (401) on a read: its sign-in has ended. A confirm or cancel never says so. */
  refused?(token: string): void;
}

const STATUSES: ReadonlySet<string> = new Set(Object.values(CoinIntentStatus));
const FAILURES: ReadonlySet<string> = new Set(Object.values(CoinFailure));

const isStatus = (value: unknown): value is CoinIntentStatus => typeof value === "string" && STATUSES.has(value);
const isFailure = (value: unknown): value is CoinFailure => typeof value === "string" && FAILURES.has(value);
const failureOf = (value: unknown): CoinFailure => (isFailure(value) ? value : CoinFailure.Unknown);
const wholeIn = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
/** A game's words as the sheet may show them: without direction controls, trimmed; null when not text. */
const plainText = (value: unknown): string | null =>
  typeof value === "string" ? withoutBidiControls(value).trim() : null;

/** Absent on the wire: genex.games sends null, an older answer may leave the field out. */
const absent = (value: unknown): value is null | undefined => value === null || value === undefined;

/** An answer that names a purchase: an id genex.games could have handed out, and a status it knows. */
const isIntentBody = (body: unknown): body is Record<string, unknown> & { id: string; status: CoinIntentStatus } =>
  isRecord(body) && isIntentId(body.id) && isStatus(body.status);

/** Whose a purchase is and what confirming it names; null when the answer says neither. */
function ownerOf(body: Record<string, unknown>): { projectId: string | null; dynamic: boolean } | null {
  const { projectId, skuId } = body;
  const project = projectId === null || isCursor(projectId);
  const sku = skuId === null || typeof skuId === "string";
  return project && sku ? { projectId, dynamic: skuId === null } : null;
}

/** The terms a game wrote for its own price, whole: null with none, undefined when they cannot be shown whole. */
function termsOf(value: unknown): string | null | undefined {
  if (absent(value)) return null;
  const terms = plainText(value);
  if (terms === null || terms.length > TERMS_MAX) return undefined;
  return terms || null;
}

/** The item's name and the payment's terms; null when either cannot be shown whole. */
function wordsOf(body: Record<string, unknown>): { name: string; description: string | null } | null {
  const name = plainText(body.name);
  const description = termsOf(body.description);
  const named = name !== null && name.length > 0 && name.length <= NAME_MAX;
  return named && description !== undefined ? { name, description } : null;
}

/** What the coin is worth in US cents: null with none, undefined when it is not a count of cents. */
const centsOf = (value: unknown): number | null | undefined => {
  if (absent(value)) return null;
  return wholeIn(value, 0, Number.MAX_SAFE_INTEGER) ? value : undefined;
};

/** How many, at what, for how much; null when any of it is not a price Studio may confirm. */
function priceOf(body: Record<string, unknown>) {
  const { quantity, unitPriceCoins, totalCoins } = body;
  const usdCents = centsOf(body.priceDisplayUsdCents);
  const counted =
    wholeIn(quantity, 1, QUANTITY_MAX) && wholeIn(unitPriceCoins, 1, COINS_MAX) && wholeIn(totalCoins, 1, COINS_MAX);
  return counted && usdCents !== undefined ? { quantity, unitPriceCoins, totalCoins, usdCents } : null;
}

/** When a purchase lapses, in milliseconds since the epoch; null when the answer gives no time. */
function lapseOf(value: unknown): number | null {
  const at = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) ? at : null;
}

/**
 * A purchase from genex.games' answer, or null when it does not read as one Studio may show and
 * confirm: an id, a known status, the game's words, a price within the cap and a time it lapses.
 * `local` (fixture launches only) lets a drawn picture through.
 */
export function toCoinIntent(body: unknown, local = false): CoinIntent | null {
  if (!isIntentBody(body)) return null;
  const owner = ownerOf(body);
  const words = wordsOf(body);
  const price = priceOf(body);
  const expiresAt = lapseOf(body.expiresAt);
  const unreadable = !owner || !words || !price || expiresAt === null;
  if (unreadable) return null;
  return {
    id: body.id,
    status: body.status,
    ...owner,
    ...words,
    iconUrl: imageUrl(body.iconUrl, local),
    ...price,
    expiresAt,
    failure: absent(body.failureCode) ? null : failureOf(body.failureCode),
  };
}

/** The unlocked account's token, or {@link SignInNeeded}: nothing is sent without one. */
async function accountToken(deps: GalleryDeps): Promise<string> {
  const auth = await deps.token();
  if (!auth) throw new SignInNeeded();
  return auth;
}

const succeeded = (status: number): boolean => status >= 200 && status < 300;

/** A failed answer as thrown: a refusal says why; an outage stays apart, since a payment may still land. */
function failed(route: string, answer: GalleryAnswer): Error {
  if (answer.status >= SERVER_ERROR) return new GalleryError(route, answer.status);
  const code = isRecord(answer.body) ? answer.body.error : undefined;
  return new CoinRefused(route, answer.status, failureOf(code));
}

/** A read's body; a refused token ends the sign-in ({@link SignInNeeded}). */
async function read(request: GalleryRequest, route: string, auth: string): Promise<unknown> {
  const answer = await request(route, { method: "GET", token: auth });
  if (succeeded(answer.status)) return answer.body;
  if (answer.status === HTTP_UNAUTHORIZED) throw new SignInNeeded();
  throw failed(route, answer);
}

/**
 * A confirm's or cancel's body. Their 401 is a refusal like any other: genex.games read the purchase
 * with the same token, so it refuses Studio's sheet, not a signed-out account.
 */
async function write(request: GalleryRequest, route: string, auth: string, body?: unknown): Promise<unknown> {
  const answer = await request(route, { method: "POST", token: auth, ...(body === undefined ? {} : { body }) });
  if (succeeded(answer.status)) return answer.body;
  throw failed(route, answer);
}

/**
 * Earned coin on hold, as the balance names it (`earnedHeld`, `nextReleaseAt`): a whole count above
 * nothing and the time the first of it is ready; null for none, or for either it cannot trust.
 */
function heldOf(body: Record<string, unknown>): PurchaseHeld | null {
  const { earnedHeld, nextReleaseAt } = body;
  const releaseAt = typeof nextReleaseAt === "string" ? Date.parse(nextReleaseAt) : Number.NaN;
  if (!wholeIn(earnedHeld, 1, Number.MAX_SAFE_INTEGER) || !Number.isFinite(releaseAt)) return null;
  return { coins: earnedHeld, releaseAt };
}

/** The coin client over `deps`. Only reads end the sign-in when genex.games refuses the token. */
export function playCoin(deps: CoinDeps) {
  const local = deps.localImages === true;
  const reads = refusingRequest(deps.request, deps.refused);

  /** The purchase with this id, as the account reads it. */
  const intent = async (id: string): Promise<CoinIntent> => {
    if (!isIntentId(id)) throw new Error(MESSAGE.BadIntent);
    const route = CoinRoute.intent(id);
    const found = toCoinIntent(await read(reads, route, await accountToken(deps)), local);
    if (!found || found.id !== id) throw new GalleryError(route, BAD_GATEWAY);
    return found;
  };

  /** The coin the account may spend, and its earned coin still on hold. */
  const wallet = async (): Promise<CoinWallet> => {
    const body = await read(reads, CoinRoute.Balance, await accountToken(deps));
    const spendable = isRecord(body) ? body.spendable : undefined;
    if (!isRecord(body) || !wholeIn(spendable, 0, Number.MAX_SAFE_INTEGER))
      throw new GalleryError(CoinRoute.Balance, BAD_GATEWAY);
    return { spendable, held: heldOf(body) };
  };

  /** The coin the account may spend. */
  const balance = async (): Promise<number> => (await wallet()).spendable;

  /**
   * The coin the account may spend, as the account plate shows it in Play: none while signed out,
   * with coin off on genex.games, during an outage or for an answer that is no balance.
   */
  const spendableOrNone = (): Promise<number | null> => balance().catch(() => null);

  /** Pay for `purchase` from Studio's sheet; a game-priced payment acknowledges the terms the sheet showed. */
  const confirm = async (purchase: CoinIntent): Promise<void> => {
    if (!isIntentId(purchase.id)) throw new Error(MESSAGE.BadIntent);
    const terms = purchase.dynamic ? { paymentPolicy: PaymentPolicy.DynamicV1 } : {};
    const body = { confirmSurface: STUDIO_CONFIRM_SURFACE, ...terms };
    await write(deps.request, CoinRoute.confirm(purchase.id), await accountToken(deps), body);
  };

  /**
   * Cancel the purchase with this id; answers where it stands after, null when the answer does not
   * say. A charge that had already landed answers `succeeded`: it is paid, not canceled.
   */
  const cancel = async (id: string): Promise<CoinIntentStatus | null> => {
    if (!isIntentId(id)) throw new Error(MESSAGE.BadIntent);
    const answer = await write(deps.request, CoinRoute.cancel(id), await accountToken(deps));
    const status = isRecord(answer) ? answer.status : undefined;
    return isStatus(status) ? status : null;
  };

  return { intent, balance, spendableOrNone, wallet, confirm, cancel };
}

/** The coin client as `playCoin` makes it. */
export type PlayCoin = ReturnType<typeof playCoin>;
