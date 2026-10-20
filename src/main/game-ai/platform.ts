/**
 * genex.games as play-time AI reaches it (`GenexAiPlatform`), with the Genex account Studio is
 * signed in as: the credit balance, the packs at their one checkout price (D13), checkout for a
 * pack or Genex Pro, auto top-up's switch (D11; its caps, idempotency and receipts are genex.games'
 * own), the terms of a grant or generation the embed SDK asks the app to confirm (D3) and the
 * person's answer given on genex.games, and the Report and fit-count sends.
 *
 * Every answer is read as hostile input: a row or a field out of shape is dropped, never guessed.
 * An id the page named is checked against genex.games' own shape before it reaches a route, and a
 * page Studio opens in the browser for a card is Stripe's checkout over https and nothing else.
 * Fit counts (counts only, D12) and Reports (D9) go with no account at all, and a bundle holds no
 * account id. Electron-free: the request and the browser are handed in.
 */
import { isPlainRecord } from "../../shared/game-ai.ts";
import type { AiFitCountRow } from "../../shared/game-ai-check.ts";
import { type AiReportBundle, AiReportFailure } from "../../shared/game-ai-report.ts";
import {
  AI_MAX_SETTING_CREDITS,
  type AiAutoTopUp,
  type AiCreditPack,
  type AiCreditProduct,
  AiCreditProductKind,
} from "../../shared/game-ai-views.ts";
import {
  GENEX_CONFIRM_ID_RE,
  GenexConfirmKind,
  type GenexDesktopConfirmAnswer,
  type GenexDesktopConfirmRequest,
} from "../../shared/genex-desktop-bridge.ts";
import type { GalleryAnswer, GalleryRequest } from "../play/gallery.ts";
import type { ReportInboxSource, ReportSourceAnswer } from "./report-inbox.ts";
import { genexAiIngest } from "./report-ingest.ts";
import type { GenexAiPlatform } from "./types.ts";

/** The routes play-time AI reads and writes on genex.games. */
export const PlatformRoute = {
  Me: "/api/credits/me",
  Catalog: "/api/billing/catalog",
  Checkout: "/api/billing/checkout",
  AutoTopUp: "/api/billing/auto-topup",
  AutoTopUpSetup: "/api/billing/auto-topup/setup",
  grant: (id: string) => `/api/runtime/grants/${encodeURIComponent(id)}`,
  grantConfirm: (id: string) => `/api/runtime/grants/${encodeURIComponent(id)}/confirm`,
  grantStop: (id: string) => `/api/runtime/grants/${encodeURIComponent(id)}/stop`,
  generation: (id: string) => `/api/runtime/generations/${encodeURIComponent(id)}`,
  generationConfirm: (id: string) => `/api/runtime/generations/${encodeURIComponent(id)}/confirm`,
  generationCancel: (id: string) => `/api/runtime/generations/${encodeURIComponent(id)}/cancel`,
  published: (project: string) => `/api/gallery/${encodeURIComponent(project)}`,
  creatorShare: (project: string) => `/api/runtime/projects/${encodeURIComponent(project)}/creator-share`,
  reports: (project: string) => `/api/runtime/projects/${encodeURIComponent(project)}/ai-reports`,
  report: (project: string, id: string) =>
    `/api/runtime/projects/${encodeURIComponent(project)}/ai-reports/${encodeURIComponent(id)}`,
} as const;

/** The one origin a card page may open on: Stripe's hosted checkout, where genex.games sends a person to save a card. */
export const STRIPE_CHECKOUT_ORIGIN = "https://checkout.stripe.com";

/** Where genex.games counts a checkout Studio started (its `CHECKOUT_SOURCES`): the Get credits card. */
const CHECKOUT_SOURCE = "credits_modal";
/** The status of a grant or generation that waits for the person's yes. Wire value. */
const AWAITS_CONFIRMATION = "requires_confirmation";
/** The funding a desktop confirm approves: Genex credits. Wire value. */
const CREDITS_FUNDING = "credits";
/** genex.games' code for auto top-up with no card saved under the current mandate. Wire value. */
const SETUP_REQUIRED = "setup_required";
/** genex.games' project and pack ids. */
const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PACK_KEY_RE = /^[A-Za-z0-9_-]{1,40}$/;
/** A quote id (a UUID) and a billing policy word, as genex.games names them. */
const QUOTE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POLICY_RE = /^[a-z0-9-]{1,40}$/;
const MANDATE_RE = /^[A-Za-z0-9._-]{1,40}$/;
/** The most credits a confirm may name: genex.games' own cap on a grant's limit. */
const MAX_CONFIRM_CREDITS = 1_000_000;
/** The largest price a pack may name, in cents ($100,000). */
const MAX_PACK_CENTS = 10_000_000;

const MESSAGE = {
  signedOut: "sign in to Genex first",
  unreadable: (what: string) => `genex.games answered ${what} in a shape Studio does not read`,
  refused: (what: string, code: string) => `genex.games refused ${what}${code ? `: ${code}` : ""}`,
  notACardPage: "genex.games named a card page that is not Stripe's checkout",
} as const;

/** What the platform runs on. */
export interface GenexAiPlatformDeps {
  /** genex.games' API (`networkRequest` over its API origin). */
  request: GalleryRequest;
  /** The signed-in Genex account's token, or undefined while signed out. */
  token(): Promise<string | undefined>;
  /** Open a page in the person's browser. */
  openExternal(url: string): Promise<void>;
}

const isSuccess = (answer: GalleryAnswer): boolean => answer.status >= 200 && answer.status < 300;
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isPositiveCount = (value: unknown, max: number): value is number => isCount(value) && value >= 1 && value <= max;
const errorCode = (body: unknown): string =>
  isPlainRecord(body) && typeof body.error === "string" ? body.error.slice(0, 80) : "";
const textMatching = (value: unknown, re: RegExp): string | null =>
  typeof value === "string" && re.test(value) ? value : null;

/** An https page on `origin` with no user part, or null. */
function pageOn(raw: unknown, origin: string): string | null {
  if (typeof raw !== "string" || !URL.canParse(raw)) return null;
  const url = new URL(raw);
  const plain = url.protocol === "https:" && !url.username && !url.password;
  return plain && url.origin === origin ? url.href : null;
}

/** An https page anywhere, with no user part, or null: a checkout page genex.games names (the IPC host checks where). */
function httpsPage(raw: unknown): string | null {
  if (typeof raw !== "string" || !URL.canParse(raw)) return null;
  const url = new URL(raw);
  return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
}

/** A pack row the catalog lists, or null: a pack id, a whole count of credits and a price, on sale. */
function readPack(raw: unknown): AiCreditPack | null {
  if (!isPlainRecord(raw) || raw.available !== true) return null;
  const id = textMatching(raw.key, PACK_KEY_RE);
  const { credits, priceUsdCents } = raw;
  if (!id || !isPositiveCount(credits, AI_MAX_SETTING_CREDITS * 100) || !isPositiveCount(priceUsdCents, MAX_PACK_CENTS))
    return null;
  return { id, credits, priceCents: priceUsdCents };
}

/** Auto top-up's switch as genex.games' view holds it, or null. */
function readAutoTopUpConfig(raw: unknown): AiAutoTopUp | null {
  if (!isPlainRecord(raw)) return null;
  const { on, underCredits, addCredits } = raw;
  if (typeof on !== "boolean") return null;
  if (!isPositiveCount(underCredits, AI_MAX_SETTING_CREDITS) || !isPositiveCount(addCredits, AI_MAX_SETTING_CREDITS))
    return null;
  return { on, underCredits, addCredits };
}

/** Auto top-up as genex.games shows it: the switch, whether a card is saved, and the mandate's version. */
interface AutoTopUpView {
  config: AiAutoTopUp;
  ready: boolean;
  mandateVersion: string | null;
}

function readAutoTopUpView(raw: unknown): AutoTopUpView | null {
  if (!isPlainRecord(raw)) return null;
  const config = readAutoTopUpConfig(raw.config);
  if (!config) return null;
  const mandate = isPlainRecord(raw.mandate) ? textMatching(raw.mandate.version, MANDATE_RE) : null;
  return { config, ready: raw.ready === true, mandateVersion: mandate };
}

/** What a confirm needs of a grant or generation: its quote, policy, most credits and game. */
interface ConfirmTerms {
  quoteId: string;
  billingPolicy: string;
  maxCredits: number;
  game: string;
}

/** The fields every waiting grant or generation shares, or null when it is not the person's to approve in credits. */
function waitingInCredits(raw: unknown): { game: string } | null {
  if (!isPlainRecord(raw) || raw.status !== AWAITS_CONFIRMATION || raw.currency !== CREDITS_FUNDING) return null;
  const allowed = Array.isArray(raw.allowedFunding) && raw.allowedFunding.includes(CREDITS_FUNDING);
  const game = textMatching(raw.projectId, PROJECT_ID_RE);
  return allowed && game ? { game } : null;
}

/** A grant's terms (`grantView`), or null. */
function readGrantTerms(raw: unknown): ConfirmTerms | null {
  const waiting = waitingInCredits(raw);
  if (!waiting || !isPlainRecord(raw)) return null;
  const terms = isPlainRecord(raw.terms) ? raw.terms : null;
  const quoteId = textMatching(raw.quoteId, QUOTE_ID_RE);
  const billingPolicy = textMatching(terms?.billingPolicy, POLICY_RE);
  const maxCredits = raw.limitCredits;
  if (!quoteId || !billingPolicy || !isPositiveCount(maxCredits, MAX_CONFIRM_CREDITS)) return null;
  return { quoteId, billingPolicy, maxCredits, game: waiting.game };
}

/** A generation's terms (`generationView`), or null. */
function readGenerationTerms(raw: unknown): ConfirmTerms | null {
  const waiting = waitingInCredits(raw);
  if (!waiting || !isPlainRecord(raw)) return null;
  const quote = isPlainRecord(raw.quote) ? raw.quote : null;
  const quoteId = textMatching(quote?.id, QUOTE_ID_RE);
  const billingPolicy = textMatching(quote?.billingPolicy, POLICY_RE);
  const maxCredits = quote?.maxCredits ?? raw.maxCredits;
  if (!quoteId || !billingPolicy || !isPositiveCount(maxCredits, MAX_CONFIRM_CREDITS)) return null;
  return { quoteId, billingPolicy, maxCredits, game: waiting.game };
}

/** Whether genex.games' answer to a confirm says it is now funded by Genex credits. */
function approvedInCredits(answer: GalleryAnswer): boolean {
  if (!isSuccess(answer) || !isPlainRecord(answer.body)) return false;
  return answer.body.funding === CREDITS_FUNDING && answer.body.status !== AWAITS_CONFIRMATION;
}

/** The routes of one confirm kind. */
const CONFIRM_ROUTES = {
  [GenexConfirmKind.Grant]: {
    read: PlatformRoute.grant,
    confirm: PlatformRoute.grantConfirm,
    decline: PlatformRoute.grantStop,
    terms: readGrantTerms,
  },
  [GenexConfirmKind.Generate]: {
    read: PlatformRoute.generation,
    confirm: PlatformRoute.generationConfirm,
    decline: PlatformRoute.generationCancel,
    terms: readGenerationTerms,
  },
} as const satisfies Record<GenexConfirmKind, unknown>;

/** The confirm body genex.games takes for each kind: a grant also names the most it may spend. */
function confirmBody(kind: GenexConfirmKind, terms: ConfirmTerms): Record<string, unknown> {
  const body = { quoteId: terms.quoteId, funding: CREDITS_FUNDING, billingPolicy: terms.billingPolicy };
  return kind === GenexConfirmKind.Grant ? { ...body, limitCredits: terms.maxCredits } : body;
}

const NOT_APPROVED: GenexDesktopConfirmAnswer = { approved: false };

/** genex.games as the signed-in account: its token, and a call made with it. */
interface Account {
  request: GalleryRequest;
  token(): Promise<string | undefined>;
  /** A call as the signed-in account; throws while signed out, before anything is sent. */
  signed(route: string, init: Omit<Parameters<GalleryRequest>[1], "token">): Promise<GalleryAnswer>;
}

function accountOf(deps: Pick<GenexAiPlatformDeps, "request" | "token">): Account {
  const token = (): Promise<string | undefined> => deps.token().catch(() => undefined);
  return {
    request: deps.request,
    token,
    async signed(route, init) {
      const current = await token();
      if (!current) throw new Error(MESSAGE.signedOut);
      return deps.request(route, { ...init, token: current });
    },
  };
}

/** The balance, the packs and checkout. */
function creditCalls(account: Account): Pick<GenexAiPlatform, "balanceCredits" | "packs" | "checkoutUrl"> {
  return {
    async balanceCredits() {
      if (!(await account.token())) return null;
      const answer = await account.signed(PlatformRoute.Me, { method: "GET" });
      const body = isSuccess(answer) && isPlainRecord(answer.body) ? answer.body : null;
      const balance = body?.spendable ?? body?.balance;
      if (!isCount(balance)) throw new Error(MESSAGE.unreadable("the balance"));
      return balance;
    },
    async packs() {
      const answer = await account.request(PlatformRoute.Catalog, { method: "GET" });
      if (!isSuccess(answer)) throw new Error(MESSAGE.refused("the price list", errorCode(answer.body)));
      const rows = isPlainRecord(answer.body) && Array.isArray(answer.body.packs) ? answer.body.packs : [];
      const packs = rows.map(readPack).filter((pack): pack is AiCreditPack => pack !== null);
      return packs.sort((a, b) => a.credits - b.credits);
    },
    async checkoutUrl(product: AiCreditProduct) {
      const body =
        product.kind === AiCreditProductKind.Pack
          ? { product: "credits", packKey: product.packId, source: CHECKOUT_SOURCE }
          : { product: "pro", source: CHECKOUT_SOURCE };
      const answer = await account.signed(PlatformRoute.Checkout, { method: "POST", body });
      if (!isSuccess(answer)) throw new Error(MESSAGE.refused("checkout", errorCode(answer.body)));
      const page = httpsPage(isPlainRecord(answer.body) ? answer.body.url : null);
      if (!page) throw new Error(MESSAGE.unreadable("checkout"));
      return page;
    },
  };
}

/** The body auto top-up's switch is saved with: turning it on names the mandate the person was shown. */
function autoTopUpBody(next: AiAutoTopUp, view: AutoTopUpView): Record<string, unknown> {
  const config = { on: next.on, underCredits: next.underCredits, addCredits: next.addCredits };
  return next.on ? { ...config, mandateVersion: view.mandateVersion } : config;
}

/** The switch genex.games saved, or why it did not. */
function savedAutoTopUp(answer: GalleryAnswer): AiAutoTopUp {
  if (!isSuccess(answer)) throw new Error(MESSAGE.refused("auto top-up", errorCode(answer.body)));
  const saved = isPlainRecord(answer.body) ? readAutoTopUpConfig(answer.body.config) : null;
  if (!saved) throw new Error(MESSAGE.unreadable("auto top-up"));
  return saved;
}

/** Auto top-up's switch (D11): its caps, idempotency and receipts are genex.games' own. */
function autoTopUpCalls(
  account: Account,
  openExternal: GenexAiPlatformDeps["openExternal"],
): Pick<GenexAiPlatform, "autoTopUp" | "setAutoTopUp"> {
  const viewOf = async (): Promise<AutoTopUpView | null> => {
    if (!(await account.token())) return null;
    const answer = await account.signed(PlatformRoute.AutoTopUp, { method: "GET" });
    return isSuccess(answer) ? readAutoTopUpView(answer.body) : null;
  };
  /** No card saved under the mandate: open Stripe's page to save one, and leave the switch as it is. */
  const setUpCard = async (next: AiAutoTopUp, view: AutoTopUpView): Promise<AiAutoTopUp> => {
    const body = {
      underCredits: next.underCredits,
      addCredits: next.addCredits,
      mandateVersion: view.mandateVersion,
      source: CHECKOUT_SOURCE,
    };
    const answer = await account.signed(PlatformRoute.AutoTopUpSetup, { method: "POST", body });
    if (!isSuccess(answer)) throw new Error(MESSAGE.refused("auto top-up", errorCode(answer.body)));
    const page = pageOn(isPlainRecord(answer.body) ? answer.body.url : null, STRIPE_CHECKOUT_ORIGIN);
    if (!page) throw new Error(MESSAGE.notACardPage);
    await openExternal(page);
    return view.config;
  };
  return {
    autoTopUp: async () => (await viewOf())?.config ?? null,
    async setAutoTopUp(next) {
      const view = await viewOf();
      if (!view) throw new Error((await account.token()) ? MESSAGE.unreadable("auto top-up") : MESSAGE.signedOut);
      if (next.on && !view.ready) return setUpCard(next, view);
      const answer = await account.signed(PlatformRoute.AutoTopUp, { method: "PUT", body: autoTopUpBody(next, view) });
      if (errorCode(answer.body) === SETUP_REQUIRED) return setUpCard(next, view);
      return savedAutoTopUp(answer);
    },
  };
}

/** The embed SDK's desktop confirm (D3): the terms read by id, and the person's answer given on genex.games. */
function confirmCalls(account: Account): Pick<GenexAiPlatform, "confirmTerms" | "answerConfirm"> {
  const terms = async (confirm: GenexDesktopConfirmRequest): Promise<ConfirmTerms | null> => {
    if (!GENEX_CONFIRM_ID_RE.test(confirm.id) || !(await account.token())) return null;
    const routes = CONFIRM_ROUTES[confirm.kind];
    const answer = await account.signed(routes.read(confirm.id), { method: "GET" }).catch(() => null);
    return answer && isSuccess(answer) ? routes.terms(answer.body) : null;
  };
  return {
    async confirmTerms(confirm) {
      const read = await terms(confirm);
      return read ? { maxCredits: read.maxCredits, game: read.game } : null;
    },
    async answerConfirm(confirm, approved) {
      if (!GENEX_CONFIRM_ID_RE.test(confirm.id)) return NOT_APPROVED;
      const routes = CONFIRM_ROUTES[confirm.kind];
      if (!approved) {
        await account.signed(routes.decline(confirm.id), { method: "POST" }).catch(() => null);
        return NOT_APPROVED;
      }
      // The terms are read again here: a yes is given only to what genex.games holds now.
      const read = await terms(confirm);
      if (!read) return NOT_APPROVED;
      const body = confirmBody(confirm.kind, read);
      const answer = await account.signed(routes.confirm(confirm.id), { method: "POST", body }).catch(() => null);
      return { approved: answer !== null && approvedInCredits(answer) };
    },
  };
}

/** genex.games for play-time AI over `deps`. */
export function createGenexAiPlatform(deps: GenexAiPlatformDeps): GenexAiPlatform {
  const account = accountOf(deps);
  // Reports and fit counts go with no account at all (D9, D12): genex.games takes both anonymously,
  // and the Report sheet tells the player their account is not included.
  const ingest = genexAiIngest({
    request: (route, init) => deps.request(route, { method: init.method, body: init.body }),
  });
  return {
    ...creditCalls(account),
    ...autoTopUpCalls(account, deps.openExternal),
    ...confirmCalls(account),
    sendReport: (bundle: AiReportBundle) => ingest.sendReport(bundle),
    sendFitCounts: (rows: readonly AiFitCountRow[]) => ingest.sendFitCounts(rows),
  };
}

// ── the creator's own published game ─────────────────────────────────────────────────────────

/** The longest title a published game is read under. */
const MAX_TITLE_CHARS = 200;
/** The most a share may be, in basis points: the whole of it. */
const MAX_SHARE_BPS = 10_000;
/** From here on a failure is genex.games' own, not the request's. */
const HTTP_SERVER_ERROR = 500;
/** A report id as genex.games stores it. */
const REPORT_ID_RE = /^[A-Za-z0-9_-]{8,100}$/;

/** What the creator's reads run on: genex.games' API, as the signed-in account. */
export type GenexAiCreatorDeps = Pick<GenexAiPlatformDeps, "request" | "token">;

/**
 * What Studio reads of published games: the title one is listed under (a public read), and of the
 * creator's own, their share of its AI spend and its Player reports.
 */
export interface GenexAiCreatorReads {
  /** The title a published game is listed under on genex.games; null when it cannot be read. */
  publishedTitle(projectId: string): Promise<string | null>;
  /** The creator's share of what players spend on AI in the game, in basis points; null when it cannot be read. */
  creatorShareBps(projectId: string): Promise<number | null>;
  /** The game's Player reports (D9), for the inbox (`report-inbox.ts`). */
  inbox: ReportInboxSource;
}

/** The creator's reads over `deps`; a project id out of genex.games' shape never reaches a route. */
export function createGenexAiCreatorReads(deps: GenexAiCreatorDeps): GenexAiCreatorReads {
  const read = async (route: string): Promise<GalleryAnswer | null> => {
    const token = await deps.token().catch(() => undefined);
    if (!token) return null;
    return deps.request(route, { method: "GET", token }).catch(() => null);
  };
  return {
    async publishedTitle(projectId) {
      if (!PROJECT_ID_RE.test(projectId)) return null;
      const answer = await deps.request(PlatformRoute.published(projectId), { method: "GET" }).catch(() => null);
      const project = answer && isSuccess(answer) && isPlainRecord(answer.body) ? answer.body.project : null;
      const title = isPlainRecord(project) && typeof project.title === "string" ? project.title.trim() : "";
      return title && title.length <= MAX_TITLE_CHARS ? title : null;
    },
    async creatorShareBps(projectId) {
      if (!PROJECT_ID_RE.test(projectId)) return null;
      const answer = await read(PlatformRoute.creatorShare(projectId));
      const bps = answer && isSuccess(answer) && isPlainRecord(answer.body) ? answer.body.bps : null;
      return isCount(bps) && bps <= MAX_SHARE_BPS ? bps : null;
    },
    inbox: {
      async list(projectId) {
        if (!PROJECT_ID_RE.test(projectId)) throw new Error(MESSAGE.unreadable("the reports"));
        const answer = await read(PlatformRoute.reports(projectId));
        if (!answer || !isSuccess(answer)) throw new Error(MESSAGE.refused("the reports", errorCode(answer?.body)));
        return isPlainRecord(answer.body) ? answer.body.items : undefined;
      },
      async bundle(projectId, id): Promise<ReportSourceAnswer> {
        if (!PROJECT_ID_RE.test(projectId) || !REPORT_ID_RE.test(id))
          return { ok: false, failure: AiReportFailure.Refused };
        const answer = await read(PlatformRoute.report(projectId, id));
        if (!answer || answer.status >= HTTP_SERVER_ERROR) return { ok: false, failure: AiReportFailure.Offline };
        if (!isSuccess(answer)) return { ok: false, failure: AiReportFailure.Refused };
        return { ok: true, body: answer.body };
      },
    },
  };
}
