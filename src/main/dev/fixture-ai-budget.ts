/**
 * A native game's AI budget in a fixture profile: the read, the quote, Approve and Stop answered
 * here, in the shapes genex.games serves (`play/ai-budget.ts` reads them), so a game page's line and
 * its sheet show every state with no socket and no credits spent. A few fixture games declare a
 * budget, each one of the sheet's cases; an approved budget lasts the launch and is spent a little
 * as time passes, so the page's count moves while a game is played.
 */
import { DAY_MS, MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { AiBudgetPeriod, AiBudgetRefusal, AiBudgetStatus, isLiveBudget } from "../../shared/play-ai-budget.ts";
import { type GalleryAnswer, type GalleryRequest, isRecord } from "../play/gallery.ts";
import { takenAccount } from "./fixture-people.ts";

/** How long a quote stays open to approve, and an approved budget runs: genex.games' own. */
export const FIXTURE_QUOTE_TTL_MS = 5 * MINUTE_MS;
export const FIXTURE_BUDGET_TTL_MS = DAY_MS;
/** An approved budget spends one call's credits this often, until it is used up. */
export const FIXTURE_SPEND_EVERY_MS = 20 * SECOND_MS;
export const FIXTURE_CALL_CREDITS = 3;

/** The fixture games' budgets, one per case of the page. Values name the cases in tests. */
export const FixtureBudgetCase = {
  /** Declared, with an estimate and a judge: the sheet asks, Approve starts the budget. */
  Ask: "ask",
  /** genex.games refuses Approve for want of credits (402). */
  Poor: "poor",
  /** No estimate and coarse steps; the first Approve of the launch finds its quote lapsed (409), the next goes through. */
  Expire: "expire",
  /** AI in games is paused: the budget cannot be opened (503). */
  Paused: "paused",
  /** A declared model is not served now: the page offers nothing to set. */
  Unavailable: "unavailable",
} as const;
export type FixtureBudgetCase = (typeof FixtureBudgetCase)[keyof typeof FixtureBudgetCase];

/** The fixture games that declare a budget, by their address; every other game declares none. */
export const FIXTURE_BUDGET_GAMES: Readonly<Record<string, FixtureBudgetCase>> = {
  "iron-tide": FixtureBudgetCase.Ask,
  "night-patrol": FixtureBudgetCase.Poor,
  frigate: FixtureBudgetCase.Expire,
  "puck-rush": FixtureBudgetCase.Paused,
  skate: FixtureBudgetCase.Unavailable,
};

/** The limits a quote offers. */
interface Bounds {
  minCredits: number;
  maxCredits: number;
  stepCredits: number;
  defaultCredits: number;
}

/** What a case's game declared. */
interface CaseSpec {
  labels: string[];
  judge: boolean;
  perCallMaxCredits: number;
  /** Credits per session the game estimates; 0 with no estimate. */
  estimate: number;
  bounds: Bounds;
}

const FINE: Bounds = { minCredits: 4, maxCredits: 2000, stepCredits: 1, defaultCredits: 240 };
const COARSE: Bounds = { minCredits: 50, maxCredits: 1000, stepCredits: 50, defaultCredits: 50 };
const TALKER: CaseSpec = {
  labels: ["Gemini 2.5 Flash", "GPT-5 mini"],
  judge: true,
  perCallMaxCredits: 4,
  estimate: 80,
  bounds: FINE,
};
const SPECS: Record<FixtureBudgetCase, CaseSpec> = {
  [FixtureBudgetCase.Ask]: TALKER,
  [FixtureBudgetCase.Poor]: { ...TALKER, judge: false },
  [FixtureBudgetCase.Expire]: {
    labels: ["GPT-5 mini"],
    judge: false,
    perCallMaxCredits: 12,
    estimate: 0,
    bounds: COARSE,
  },
  [FixtureBudgetCase.Paused]: { ...TALKER, judge: false },
  [FixtureBudgetCase.Unavailable]: { ...TALKER, labels: ["GPT-5 mini"], judge: false },
};

/** The billing policy a fixture quote names; Approve echoes it back. */
const BILLING_POLICY = "standing-v1";
const MODEL_IDS = ["google/gemini-2.5-flash", "openai/gpt-5-mini"];
const ROUTES = "/api/runtime/projects/";

/** HTTP statuses the fixture answers with. */
const HTTP = {
  Ok: 200,
  BadRequest: 400,
  Unauthorized: 401,
  PaymentRequired: 402,
  NotFound: 404,
  Conflict: 409,
  Unavailable: 503,
} as const;

const ok = (body: unknown): GalleryAnswer => ({ status: HTTP.Ok, body });
const refusal = (status: number, error: string): GalleryAnswer => ({ status, body: { error } });
const SIGNED_OUT = refusal(HTTP.Unauthorized, "unauthorized");
const NO_ROUTE = refusal(HTTP.NotFound, "not_found");
const NO_GRANT = refusal(HTTP.NotFound, AiBudgetRefusal.GrantNotFound);
const NO_PROJECT = refusal(HTTP.NotFound, AiBudgetRefusal.ProjectNotFound);

/** What the fixture's budgets need: the time, and the address of the launch's game with an id. */
export interface FixtureAiBudgetDeps {
  now(): number;
  slugOf(projectId: string): string | null;
}

/** A budget as the fixture holds it: a quote until approved, then running, then ended. */
interface FixtureGrant {
  id: string;
  quoteId: string;
  kase: FixtureBudgetCase;
  status: AiBudgetStatus;
  limitCredits: number;
  /** When it was approved; null for a quote. */
  approvedAt: number | null;
  expiresAt: number;
}

interface BudgetState {
  deps: FixtureAiBudgetDeps;
  /** How many quotes the launch has opened: each gets its own id. */
  opened: number;
  /** Each game's quote open for approval, and its budget once approved, by project id. */
  quotes: Map<string, FixtureGrant>;
  budgets: Map<string, FixtureGrant>;
  /** The games whose first Approve already found its quote lapsed. */
  lapsed: Set<string>;
}

/** What a running budget has spent by `now`: one call's credits every while, never past its limit. */
function spentBy(grant: FixtureGrant, now: number): number {
  if (grant.approvedAt === null) return 0;
  const calls = Math.floor((now - grant.approvedAt) / FIXTURE_SPEND_EVERY_MS);
  return Math.min(grant.limitCredits, Math.max(0, calls) * FIXTURE_CALL_CREDITS);
}

/** Where a budget stands now: a running one that spent its limit is used up, one past its day has lapsed. */
function statusNow(grant: FixtureGrant, now: number): AiBudgetStatus {
  if (!isLiveBudget(grant.status)) return grant.status;
  if (now >= grant.expiresAt) return AiBudgetStatus.Expired;
  return spentBy(grant, now) >= grant.limitCredits ? AiBudgetStatus.Exhausted : grant.status;
}

/** A budget as genex.games serves one. */
function view(grant: FixtureGrant, now: number, replaces: unknown[] = []): Record<string, unknown> {
  const spec = SPECS[grant.kase];
  const spentCredits = spentBy(grant, now);
  const disclosure = {
    periodLabel: AiBudgetPeriod.Session,
    estimatedCallsPerPeriod: Math.round(spec.estimate / FIXTURE_CALL_CREDITS),
    ...(spec.estimate > 0 ? { estimatedCreditsPerPeriod: spec.estimate } : {}),
  };
  return {
    id: grant.id,
    status: statusNow(grant, now),
    quoteId: grant.quoteId,
    terms: {
      billingPolicy: BILLING_POLICY,
      models: MODEL_IDS.slice(0, spec.labels.length),
      perCallMaxCredits: spec.perCallMaxCredits,
      perCallEstimateCredits: FIXTURE_CALL_CREDITS,
      disclosure,
      limit: spec.bounds,
      ...(spec.judge ? { judge: { enabled: true } } : {}),
    },
    limitCredits: grant.limitCredits,
    spentCredits,
    heldCredits: 0,
    remainingCredits: grant.limitCredits - spentCredits,
    expiresAt: new Date(grant.expiresAt).toISOString(),
    replaces,
  };
}

/** The game's budget while it runs, or null. */
function running(state: BudgetState, projectId: string): FixtureGrant | null {
  const grant = state.budgets.get(projectId);
  return grant && isLiveBudget(statusNow(grant, state.deps.now())) ? grant : null;
}

/** The page's read: what the game declared, and its running budget. */
function read(state: BudgetState, projectId: string, kase: FixtureBudgetCase | null): GalleryAnswer {
  const live = running(state, projectId);
  const spec = kase ? SPECS[kase] : null;
  const declared = spec && {
    models: spec.labels,
    judge: spec.judge,
    listens: false,
    speaks: false,
    periodLabel: AiBudgetPeriod.Session,
    estimatedCreditsPerPeriod: spec.estimate,
    available: kase !== FixtureBudgetCase.Unavailable,
  };
  return ok({ declared, current: live ? view(live, state.deps.now()) : null });
}

/** A fixture quote's id: a UUID that counts the launch's quotes. */
const quoteIdOf = (count: number): string => `00000000-0000-4000-8000-${String(count).padStart(12, "0")}`;

/** Open the declared budget: a new quote each time, naming the running budget it would replace. */
function open(state: BudgetState, projectId: string, kase: FixtureBudgetCase | null): GalleryAnswer {
  if (!kase) return refusal(HTTP.NotFound, AiBudgetRefusal.NotDeclared);
  if (kase === FixtureBudgetCase.Paused) return refusal(HTTP.Unavailable, AiBudgetRefusal.GenerationPaused);
  if (kase === FixtureBudgetCase.Unavailable) return refusal(HTTP.BadRequest, AiBudgetRefusal.ModelNotAvailable);
  const now = state.deps.now();
  state.opened += 1;
  const quote: FixtureGrant = {
    id: `fxb-${state.opened}`,
    quoteId: quoteIdOf(state.opened),
    kase,
    status: AiBudgetStatus.RequiresConfirmation,
    limitCredits: 0,
    approvedAt: null,
    expiresAt: now + FIXTURE_QUOTE_TTL_MS,
  };
  state.quotes.set(projectId, quote);
  const live = running(state, projectId);
  return ok(view(quote, now, live ? [view(live, now)] : []));
}

/** Whether `limit` is one the bounds offer, as genex.games judges it. */
const onStep = (limit: unknown, { minCredits, maxCredits, stepCredits }: Bounds): limit is number =>
  typeof limit === "number" &&
  Number.isInteger(limit) &&
  limit >= minCredits &&
  limit <= maxCredits &&
  (limit - minCredits) % stepCredits === 0;

/** Why an approval's body is refused before the case is weighed; null when it reads right. */
function bodyRefusal(quote: FixtureGrant, body: unknown): GalleryAnswer | null {
  const asked = ["quoteId", "funding", "billingPolicy", "limitCredits"];
  const exact = isRecord(body) && Object.keys(body).length === asked.length && asked.every((key) => key in body);
  if (!exact || body.funding !== "credits") return refusal(HTTP.BadRequest, "invalid_request");
  if (body.quoteId !== quote.quoteId) return refusal(HTTP.Conflict, AiBudgetRefusal.QuoteMismatch);
  if (body.billingPolicy !== BILLING_POLICY) return refusal(HTTP.Conflict, AiBudgetRefusal.BillingPolicyMismatch);
  return onStep(body.limitCredits, SPECS[quote.kase].bounds)
    ? null
    : refusal(HTTP.BadRequest, AiBudgetRefusal.InvalidLimit);
}

/** How a case answers Approve before the budget starts; null when it starts. */
function caseRefusal(state: BudgetState, projectId: string, quote: FixtureGrant): GalleryAnswer | null {
  if (quote.kase === FixtureBudgetCase.Poor) return refusal(HTTP.PaymentRequired, AiBudgetRefusal.InsufficientCredits);
  const lapses = quote.kase === FixtureBudgetCase.Expire && !state.lapsed.has(projectId);
  if (!lapses && state.deps.now() < quote.expiresAt) return null;
  state.lapsed.add(projectId);
  state.quotes.delete(projectId);
  return refusal(HTTP.Conflict, AiBudgetRefusal.QuoteExpired);
}

/** Approve: the open quote becomes the game's running budget, with the limit the body names. */
function confirm(state: BudgetState, projectId: string, grantId: string, body: unknown): GalleryAnswer {
  const quote = state.quotes.get(projectId);
  if (!quote || quote.id !== grantId) return NO_GRANT;
  const refused = bodyRefusal(quote, body) ?? caseRefusal(state, projectId, quote);
  if (refused) return refused;
  const limitCredits = isRecord(body) && typeof body.limitCredits === "number" ? body.limitCredits : 0;
  const now = state.deps.now();
  const budget: FixtureGrant = {
    ...quote,
    status: AiBudgetStatus.Active,
    limitCredits,
    approvedAt: now,
    expiresAt: now + FIXTURE_BUDGET_TTL_MS,
  };
  state.quotes.delete(projectId);
  state.budgets.set(projectId, budget);
  return ok(view(budget, now));
}

/** The player's stop: the running budget ends, what it spent as it was at the stop. */
function stop(state: BudgetState, projectId: string): GalleryAnswer {
  const live = running(state, projectId);
  if (!live) return NO_GRANT;
  const now = state.deps.now();
  state.budgets.delete(projectId);
  return ok({ ...view(live, now), status: AiBudgetStatus.Stopped, stopRequestedAt: new Date(now).toISOString() });
}

/** A path segment decoded; "" when it does not decode. */
function decoded(segment: string | undefined): string {
  try {
    return decodeURIComponent(segment ?? "");
  } catch {
    return "";
  }
}

/** The answer to a budget route of the game `projectId`, signed in as a fixture account. */
function budgetAnswer(state: BudgetState, parts: string[], init: Parameters<GalleryRequest>[1]): GalleryAnswer {
  const [project, door, third, fourth] = parts;
  const method = init.method ?? "GET";
  if (door !== "budget" || parts.length > 4) return NO_ROUTE;
  if (!takenAccount(init.token)) return SIGNED_OUT;
  const projectId = decoded(project);
  const slug = state.deps.slugOf(projectId);
  if (slug === null) return NO_PROJECT;
  const kase = FIXTURE_BUDGET_GAMES[slug] ?? null;
  if (third === undefined) {
    if (method === "GET") return read(state, projectId, kase);
    return method === "POST" ? open(state, projectId, kase) : NO_ROUTE;
  }
  if (method !== "POST") return NO_ROUTE;
  if (third === "stop" && fourth === undefined) return stop(state, projectId);
  return fourth === "confirm" ? confirm(state, projectId, decoded(third), init.body) : NO_ROUTE;
}

/** One launch's AI budgets: `answer` answers genex.games' budget routes, null for any other route. */
export function createFixtureAiBudget(deps: FixtureAiBudgetDeps) {
  const state: BudgetState = { deps, opened: 0, quotes: new Map(), budgets: new Map(), lapsed: new Set() };
  return {
    answer: (route: string, init: Parameters<GalleryRequest>[1]): GalleryAnswer | null => {
      const [pathname = ""] = route.split("?");
      if (!pathname.startsWith(ROUTES)) return null;
      return budgetAnswer(state, pathname.slice(ROUTES.length).split("/"), init);
    },
  };
}
