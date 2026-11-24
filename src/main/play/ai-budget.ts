/**
 * A native game's AI budget, as the game's page in Play sets it before Play (docs/play.md, "AI
 * budget"): what the game declared and the player's budget in it are read from genex.games, and the
 * budget is opened for approval, approved and stopped as the app's Genex account. The game is told
 * nothing: launched with the app's sign-in as ever, it finds the live budget on genex.games itself.
 *
 * genex.games is the authority on money. Its answers are read as hostile input: one that does not
 * read whole is never shown, and the quote an approval names stays here, so the only thing the page
 * chooses is a limit, sent only when the quote offers it. Voice budgets are never opened or
 * approved here. Electron-free: the request, the token and the game's id come in as deps.
 */
import { MINUTE_MS } from "../../shared/duration.ts";
import {
  type AiBudgetConfirmed,
  type AiBudgetDeclared,
  type AiBudgetEstimate,
  type AiBudgetLimit,
  type AiBudgetOpened,
  type AiBudgetQuote,
  type AiBudgetRead,
  AiBudgetRefusal,
  AiBudgetStatus,
  type AiBudgetStopped,
  type AiBudgetView,
  aiBudgetRefusalOf,
  isAiBudgetPeriod,
  isAiBudgetStatus,
  limitOffered,
} from "../../shared/play-ai-budget.ts";
import { withoutBidiControls } from "../../shared/play-purchase.ts";
import {
  type GalleryAnswer,
  type GalleryDeps,
  GalleryError,
  HTTP_UNAUTHORIZED,
  isCursor,
  isRecord,
  SignInNeeded,
} from "./gallery.ts";
import { refusingRequest } from "./people.ts";

/** The most a budget's limit may be: genex.games' own cap on what an approval may name. */
const LIMIT_MAX = 1_000_000;
/** The most models a page lists, and the longest name it shows for one. */
const MODELS_MAX = 16;
const MODEL_NAME_MAX = 80;
/** The longest billing policy an approval echoes back (genex.games' own are short words). */
const BILLING_POLICY_MAX = 64;
/** How long a game's id is trusted for the page's reads before the catalog is asked again. */
const PROJECT_TTL_MS = 5 * MINUTE_MS;
/** A success that does not answer what was asked reads as a bad gateway, as the gallery's do. */
const BAD_GATEWAY = 502;
const HTTP_NOT_FOUND = 404;
/** How approvals are paid here: credits. A native build has no other way. */
const FUNDING = "credits";

const GRANT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const QUOTE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MESSAGE = {
  BadLimit: "Not a limit the AI budget offers",
  BadProject: "Not a game on genex.games",
} as const;

/** The routes of a game's AI budget. */
export const AiBudgetRoute = {
  budget: (projectId: string) => `/api/runtime/projects/${encodeURIComponent(projectId)}/budget`,
  confirm: (projectId: string, grantId: string) =>
    `/api/runtime/projects/${encodeURIComponent(projectId)}/budget/${encodeURIComponent(grantId)}/confirm`,
  stop: (projectId: string) => `/api/runtime/projects/${encodeURIComponent(projectId)}/budget/stop`,
} as const;

/** What the budget calls need beyond the gallery's deps. */
export interface AiBudgetDeps extends GalleryDeps {
  /** genex.games refused `token` (401) on the page's read: its sign-in has ended. An approval or a stop never says so. */
  refused?(token: string): void;
  /** The id of the game at this address, read from the catalog now. */
  project(slug: string): Promise<string>;
}

/** A quote as main keeps it between the sheet opening and Approve: what approving it names. */
interface HeldQuote {
  projectId: string;
  grantId: string;
  quoteId: string;
  billingPolicy: string;
  limit: AiBudgetLimit;
}

/** A quote as read: what the sheet shows, what approving it names, and whether it covers voice. */
interface ReadQuote {
  shown: AiBudgetQuote;
  grantId: string;
  quoteId: string;
  billingPolicy: string;
  voice: boolean;
}

/** Refusals after which the held quote can never be approved: the sheet opens a new one. */
const QUOTE_ENDED: ReadonlySet<AiBudgetRefusal> = new Set([
  AiBudgetRefusal.QuoteExpired,
  AiBudgetRefusal.QuoteMismatch,
  AiBudgetRefusal.BillingPolicyMismatch,
  AiBudgetRefusal.GrantNotFound,
]);

const NOTHING: AiBudgetRead = { signedOut: false, declared: null, current: null };

/** A field of the answer's own: never one inherited through a `__proto__` it carried. */
const own = (record: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(record, key) ? record[key] : undefined;
const absent = (value: unknown): value is null | undefined => value === null || value === undefined;
const succeeded = (status: number): boolean => status >= 200 && status < 300;

/** An amount of credits genex.games counted: a real number, never negative. */
const isCredits = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
/** A whole count of credits a limit may be. */
const isLimitCredits = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= LIMIT_MAX;
/** An ISO time as sent, or null when it is not one. */
const isoTime = (value: unknown): string | null =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
/** A flag that may be left out: undefined when it is there and not a flag. */
const flagOf = (value: unknown): boolean | undefined => {
  if (absent(value)) return false;
  return typeof value === "boolean" ? value : undefined;
};

/** A game's estimate per period, or null with none it can show (no period it knows, no amount). */
function estimateOf(period: unknown, credits: unknown): AiBudgetEstimate | null {
  if (!isAiBudgetPeriod(period) || !isCredits(credits) || credits === 0) return null;
  return { period, credits };
}

/** The models' names as a page may show them: plain text, trimmed, the first few. */
function modelNames(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string")) return null;
  return value
    .map((name: string) => withoutBidiControls(name).trim().slice(0, MODEL_NAME_MAX))
    .filter((name) => name.length > 0)
    .slice(0, MODELS_MAX);
}

/** What a game declared: null with nothing declared, undefined when the answer does not read as one. */
export function toAiBudgetDeclared(value: unknown): AiBudgetDeclared | null | undefined {
  if (absent(value)) return null;
  if (!isRecord(value)) return undefined;
  const models = modelNames(own(value, "models"));
  const [judge, listens, speaks] = ["judge", "listens", "speaks"].map((key) => flagOf(own(value, key)));
  const available = own(value, "available");
  const flagged = judge !== undefined && listens !== undefined && speaks !== undefined;
  if (!models || !flagged || typeof available !== "boolean") return undefined;
  return {
    models,
    judge,
    voice: listens || speaks,
    estimate: estimateOf(own(value, "periodLabel"), own(value, "estimatedCreditsPerPeriod")),
    available,
  };
}

/** The four amounts a budget counts; null when any is not an amount. */
function amountsOf(body: Record<string, unknown>) {
  const [limitCredits, spentCredits, heldCredits, remainingCredits] = [
    "limitCredits",
    "spentCredits",
    "heldCredits",
    "remainingCredits",
  ].map((key) => own(body, key));
  const counted =
    isCredits(limitCredits) && isCredits(spentCredits) && isCredits(heldCredits) && isCredits(remainingCredits);
  return counted ? { limitCredits, spentCredits, heldCredits, remainingCredits } : null;
}

/** A budget as genex.games counts it, or null when the answer does not read as one. */
export function toAiBudgetView(body: unknown): AiBudgetView | null {
  if (!isRecord(body)) return null;
  const id = own(body, "id");
  const status = own(body, "status");
  const amounts = amountsOf(body);
  const expiresAt = isoTime(own(body, "expiresAt"));
  const stop = own(body, "stopRequestedAt");
  const named = typeof id === "string" && GRANT_ID.test(id) && isAiBudgetStatus(status);
  const stopReadable = absent(stop) || typeof stop === "string";
  if (!named || !amounts || !expiresAt || !stopReadable) return null;
  return { status, ...amounts, expiresAt, stopping: typeof stop === "string" };
}

/** The limits a quote offers: whole credits, its default inside them; null for anything else. */
function limitOf(value: unknown): AiBudgetLimit | null {
  if (!isRecord(value)) return null;
  const [minCredits, maxCredits, stepCredits, defaultCredits] = [
    "minCredits",
    "maxCredits",
    "stepCredits",
    "defaultCredits",
  ].map((key) => own(value, key));
  const whole =
    isLimitCredits(minCredits) &&
    isLimitCredits(maxCredits) &&
    isLimitCredits(stepCredits) &&
    isLimitCredits(defaultCredits);
  if (!whole || stepCredits < 1) return null;
  const ordered = minCredits <= defaultCredits && defaultCredits <= maxCredits;
  return ordered ? { minCredits, maxCredits, stepCredits, defaultCredits } : null;
}

/** Whether approving would end a budget already running: undefined when the answer does not say it readably. */
function replacesOf(value: unknown): boolean | undefined {
  if (absent(value)) return false;
  return Array.isArray(value) ? value.length > 0 : undefined;
}

/** A quote's terms: what the sheet shows of them and what an approval echoes back; null when unreadable. */
function termsOf(value: unknown) {
  if (!isRecord(value)) return null;
  const billingPolicy = own(value, "billingPolicy");
  const perCallMaxCredits = own(value, "perCallMaxCredits");
  const limit = limitOf(own(value, "limit"));
  const disclosure = own(value, "disclosure");
  const policed =
    typeof billingPolicy === "string" && billingPolicy.length > 0 && billingPolicy.length <= BILLING_POLICY_MAX;
  if (!policed || !isCredits(perCallMaxCredits) || !limit) return null;
  const estimate = isRecord(disclosure)
    ? estimateOf(own(disclosure, "periodLabel"), own(disclosure, "estimatedCreditsPerPeriod"))
    : null;
  return { billingPolicy, perCallMaxCredits, limit, estimate, voice: !absent(own(value, "voice")) };
}

/** A budget opened for approval, or null when the answer does not read as a quote the app may show. */
function toQuote(body: unknown): ReadQuote | null {
  if (!isRecord(body) || own(body, "status") !== AiBudgetStatus.RequiresConfirmation) return null;
  const grantId = own(body, "id");
  const quoteId = own(body, "quoteId");
  const terms = termsOf(own(body, "terms"));
  const expiresAt = isoTime(own(body, "expiresAt"));
  const replaces = replacesOf(own(body, "replaces"));
  const named = typeof grantId === "string" && GRANT_ID.test(grantId);
  const quoted = typeof quoteId === "string" && QUOTE_ID.test(quoteId);
  if (!named || !quoted || !terms || !expiresAt || replaces === undefined) return null;
  const { billingPolicy, voice, ...shown } = terms;
  return { shown: { ...shown, replaces, expiresAt }, grantId, quoteId, billingPolicy, voice };
}

/** Why genex.games refused a write: its code; a 401 with none the app knows is the sign-in gone. */
function refusalOf(answer: GalleryAnswer): AiBudgetRefusal {
  const code = aiBudgetRefusalOf(isRecord(answer.body) ? own(answer.body, "error") : undefined);
  const signInGone = code === AiBudgetRefusal.Unknown && answer.status === HTTP_UNAUTHORIZED;
  return signInGone ? AiBudgetRefusal.SessionRevoked : code;
}

/** The page's read of `route`, as `auth`: what it says, nothing for a 404, and the sign-in's end for a 401. */
async function readBudget(request: GalleryDeps["request"], route: string, auth: string): Promise<AiBudgetRead | null> {
  const answer = await request(route, { method: "GET", token: auth });
  if (answer.status === HTTP_UNAUTHORIZED) throw new SignInNeeded();
  // No budget for this game, or a genex.games that serves none at all.
  if (answer.status === HTTP_NOT_FOUND) return null;
  if (!succeeded(answer.status)) throw new GalleryError(route, answer.status);
  const body = isRecord(answer.body) ? answer.body : null;
  const declared = body ? toAiBudgetDeclared(own(body, "declared")) : undefined;
  const sent = body ? own(body, "current") : undefined;
  const current = absent(sent) ? null : toAiBudgetView(sent);
  const unreadable = declared === undefined || (!absent(sent) && !current);
  if (unreadable) throw new GalleryError(route, BAD_GATEWAY);
  return { signedOut: false, declared, current };
}

/** Each game's id by its address, kept a few minutes for the page's reads. */
function projectIds(deps: Pick<AiBudgetDeps, "project" | "now">) {
  const known = new Map<string, { id: string; at: number }>();
  const fresh = async (slug: string): Promise<string> => {
    const id = await deps.project(slug);
    if (!isCursor(id)) throw new Error(MESSAGE.BadProject);
    known.set(slug, { id, at: deps.now() });
    return id;
  };
  const recent = (slug: string): Promise<string> => {
    const kept = known.get(slug);
    return kept && deps.now() - kept.at < PROJECT_TTL_MS ? Promise.resolve(kept.id) : fresh(slug);
  };
  return { fresh, recent, forget: (slug: string) => void known.delete(slug) };
}

/** The budget calls over `deps`. Only the page's read ends the sign-in when genex.games refuses the token. */
export function playAiBudget(deps: AiBudgetDeps) {
  const reads = refusingRequest(deps.request, deps.refused);
  const projects = projectIds(deps);
  /** The quote each game's sheet has open, by the game's address. */
  const quotes = new Map<string, HeldQuote>();
  const accountToken = async (): Promise<string> => {
    const auth = await deps.token();
    if (!auth) throw new SignInNeeded();
    return auth;
  };
  const post = (route: string, auth: string, body?: unknown): Promise<GalleryAnswer> =>
    deps.request(route, { method: "POST", token: auth, ...(body === undefined ? {} : { body }) });

  /** What the game at `slug` declared and the account's budget in it; throws {@link SignInNeeded} signed out. */
  const status = async (slug: string): Promise<AiBudgetRead> => {
    const auth = await accountToken();
    const read = await readBudget(reads, AiBudgetRoute.budget(await projects.recent(slug)), auth);
    if (read) return read;
    // The address may have moved to another game: the next read asks the catalog again.
    projects.forget(slug);
    return NOTHING;
  };

  /** Open the declared budget for approval: the quote the sheet shows, kept here for {@link confirm}. */
  const open = async (slug: string): Promise<AiBudgetOpened> => {
    const auth = await accountToken();
    quotes.delete(slug);
    const projectId = await projects.fresh(slug);
    const route = AiBudgetRoute.budget(projectId);
    const answer = await post(route, auth);
    if (!succeeded(answer.status)) return { refused: refusalOf(answer) };
    const quote = toQuote(answer.body);
    if (!quote) throw new GalleryError(route, BAD_GATEWAY);
    if (quote.voice) return { refused: AiBudgetRefusal.Voice };
    const { grantId, quoteId, billingPolicy, shown } = quote;
    quotes.set(slug, { projectId, grantId, quoteId, billingPolicy, limit: shown.limit });
    return { quote: shown };
  };

  /** Approve the open quote with `limitCredits`; a limit the quote does not offer is never sent. */
  const confirm = async (slug: string, limitCredits: number): Promise<AiBudgetConfirmed> => {
    const held = quotes.get(slug);
    if (!held) return { refused: AiBudgetRefusal.QuoteExpired };
    if (!limitOffered(held.limit, limitCredits)) throw new Error(MESSAGE.BadLimit);
    const auth = await accountToken();
    const route = AiBudgetRoute.confirm(held.projectId, held.grantId);
    const body = { quoteId: held.quoteId, funding: FUNDING, billingPolicy: held.billingPolicy, limitCredits };
    const answer = await post(route, auth, body);
    if (!succeeded(answer.status)) {
      const refused = refusalOf(answer);
      if (QUOTE_ENDED.has(refused)) quotes.delete(slug);
      return { refused };
    }
    quotes.delete(slug);
    const current = toAiBudgetView(answer.body);
    if (!current) throw new GalleryError(route, BAD_GATEWAY);
    return { current };
  };

  /** The player's stop: the budget after it, null when none was running. */
  const stop = async (slug: string): Promise<AiBudgetStopped> => {
    const auth = await accountToken();
    const route = AiBudgetRoute.stop(await projects.recent(slug));
    const answer = await post(route, auth);
    if (succeeded(answer.status)) {
      const current = toAiBudgetView(answer.body);
      if (!current) throw new GalleryError(route, BAD_GATEWAY);
      return { current };
    }
    const refused = refusalOf(answer);
    // Nothing to stop: it had already ended.
    return refused === AiBudgetRefusal.GrantNotFound ? { current: null } : { refused };
  };

  return { status, open, confirm, stop };
}

/** The budget calls as `playAiBudget` makes them. */
export type PlayAiBudget = ReturnType<typeof playAiBudget>;
