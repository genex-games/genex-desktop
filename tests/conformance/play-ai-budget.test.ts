/**
 * A native game's AI budget, as main reads and sets it on genex.games for the game's page in Play:
 * each call's route, method and body; what genex.games answers read as hostile input (an answer
 * that does not read whole is never shown, and no approval is ever sent with a limit the quote does
 * not offer); every refusal as its typed code; and the sign-in ended only by the page's read.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AiBudgetRoute, playAiBudget, toAiBudgetDeclared, toAiBudgetView } from "../../src/main/play/ai-budget.ts";
import { type GalleryAnswer, GalleryError, type GalleryRequest, SignInNeeded } from "../../src/main/play/gallery.ts";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import {
  AiBudgetPeriod,
  AiBudgetRefusal,
  AiBudgetStatus,
  limitOffered,
  nearestLimit,
} from "../../src/shared/play-ai-budget.ts";

const TOKEN = "genex-app-token";
const PROJECT = "cmproject1";
const GRANT = "grant_1";
const QUOTE_ID = "3f2c1a4e-5b6d-4c7e-8f90-a1b2c3d4e5f6";
const EXPIRES = "2026-11-24T12:05:00.000Z";
const BUDGET = AiBudgetRoute.budget(PROJECT);
const CONFIRM = AiBudgetRoute.confirm(PROJECT, GRANT);
const STOP = AiBudgetRoute.stop(PROJECT);

type Fields = Record<string, unknown>;

/** A budget's terms as genex.games serves them. */
const terms = (overrides: Fields = {}): Fields => ({
  billingPolicy: "standing-v1",
  models: ["openai/gpt-5-mini"],
  perCallMaxCredits: 4,
  perCallEstimateCredits: 2,
  disclosure: { periodLabel: "session", estimatedCallsPerPeriod: 40, estimatedCreditsPerPeriod: 80 },
  limit: { minCredits: 10, maxCredits: 500, stepCredits: 10, defaultCredits: 100 },
  ...overrides,
});

/** A quote as `POST /projects/:id/budget` answers one. */
const quote = (overrides: Fields = {}): Fields => ({
  id: GRANT,
  status: "requires_confirmation",
  quoteId: QUOTE_ID,
  terms: terms(),
  limitCredits: 0,
  spentCredits: 0,
  heldCredits: 0,
  remainingCredits: 0,
  expiresAt: EXPIRES,
  replaces: [],
  ...overrides,
});

/** A running budget as genex.games serves one. */
const active = (overrides: Fields = {}): Fields =>
  quote({ status: "active", limitCredits: 100, spentCredits: 12, heldCredits: 3, remainingCredits: 85, ...overrides });

/** What a game declared, as the page's read answers it. */
const declared = (overrides: Fields = {}): Fields => ({
  models: ["GPT-5 mini"],
  judge: false,
  listens: false,
  speaks: false,
  periodLabel: "session",
  estimatedCreditsPerPeriod: 80,
  available: true,
  ...overrides,
});

interface Call {
  route: string;
  method: string;
  body?: unknown;
  token?: string;
}

const ok = (body: unknown): GalleryAnswer => ({ status: 200, body });
const refuse = (status: number, error?: string): GalleryAnswer => ({ status, body: error ? { error } : null });

interface RigOptions {
  token?: string;
  project?: (slug: string) => Promise<string>;
  now?: () => number;
}

/** The budget calls over a recording fake of genex.games: `answer` decides each reply. */
function rig(answer: (call: Call) => GalleryAnswer, options: RigOptions = {}) {
  const calls: Call[] = [];
  const refused: string[] = [];
  const asked: string[] = [];
  const request: GalleryRequest = async (route, init) => {
    const call = { route, method: init.method ?? "GET", body: init.body, token: init.token };
    calls.push(call);
    return answer(call);
  };
  const budget = playAiBudget({
    request,
    token: async () => (options.token ?? TOKEN) || undefined,
    now: options.now ?? (() => 0),
    refused: (token) => refused.push(token),
    project: async (slug) => {
      asked.push(slug);
      return options.project ? options.project(slug) : PROJECT;
    },
  });
  return { budget, calls, refused, asked };
}

const confirms = (calls: Call[]) => calls.filter((call) => call.route.endsWith("/confirm"));
/** A quote on the open, then `confirm` for the approval. */
const quoting =
  (confirm: GalleryAnswer, body: Fields = quote()) =>
  (call: Call): GalleryAnswer =>
    call.route === BUDGET ? ok(body) : confirm;

describe("The game page's read of an AI budget", () => {
  it("asks genex.games about the game the catalog names, as the account", async () => {
    const { budget, calls, asked } = rig(() => ok({ declared: declared({ judge: true }), current: active() }));
    assert.deepEqual(await budget.status("iron-tide"), {
      signedOut: false,
      declared: {
        models: ["GPT-5 mini"],
        judge: true,
        voice: false,
        estimate: { period: AiBudgetPeriod.Session, credits: 80 },
        available: true,
      },
      current: {
        status: AiBudgetStatus.Active,
        limitCredits: 100,
        spentCredits: 12,
        heldCredits: 3,
        remainingCredits: 85,
        expiresAt: EXPIRES,
        stopping: false,
      },
    });
    assert.deepEqual(asked, ["iron-tide"]);
    assert.deepEqual(calls, [{ route: BUDGET, method: "GET", body: undefined, token: TOKEN }]);
  });

  it("reads a game that declared nothing, and one whose player has no budget", async () => {
    const none = rig(() => ok({ declared: null, current: null }));
    assert.deepEqual(await none.budget.status("frigate"), { signedOut: false, declared: null, current: null });
    const fresh = rig(() => ok({ declared: declared(), current: null }));
    assert.equal((await fresh.budget.status("frigate")).current, null);
  });

  it("reads voice, a missing estimate and a stop under way", async () => {
    assert.equal(toAiBudgetDeclared(declared({ listens: true }))?.voice, true);
    assert.equal(toAiBudgetDeclared(declared({ speaks: true }))?.voice, true);
    assert.equal(toAiBudgetDeclared(declared({ estimatedCreditsPerPeriod: 0 }))?.estimate, null);
    assert.equal(toAiBudgetDeclared(declared({ periodLabel: "fortnight" }))?.estimate, null);
    assert.equal(toAiBudgetDeclared(declared({ judge: undefined }))?.judge, false, "a flag left out is off");
    assert.equal(toAiBudgetView(active({ stopRequestedAt: EXPIRES }))?.stopping, true);
    assert.equal(toAiBudgetView(active({ stopRequestedAt: null }))?.stopping, false);
    for (const status of Object.values(AiBudgetStatus))
      assert.equal(toAiBudgetView(active({ status }))?.status, status);
  });

  it("shows model names as plain text, and only the first few", () => {
    const override = String.fromCodePoint(0x202e);
    const read = toAiBudgetDeclared(declared({ models: [`  ${override}GPT-5 mini `, "", "x".repeat(200)] }));
    assert.deepEqual(read?.models, ["GPT-5 mini", "x".repeat(80)]);
    const many = toAiBudgetDeclared(declared({ models: Array.from({ length: 40 }, (_, i) => `Model ${i}`) }));
    assert.equal(many?.models.length, 16);
  });

  it("treats any 404 as no AI budget for the game, and asks the catalog again next time", async () => {
    for (const code of ["not_found", "project_not_found", undefined]) {
      const { budget, asked } = rig(() => refuse(404, code));
      assert.deepEqual(await budget.status("iron-tide"), { signedOut: false, declared: null, current: null });
      await budget.status("iron-tide");
      assert.equal(asked.length, 2, "the address may have moved to another game");
    }
  });

  it("keeps a game's id for a few minutes of reads, then asks the catalog again", async () => {
    let now = 0;
    const { budget, asked } = rig(() => ok({ declared: null, current: null }), { now: () => now });
    await budget.status("iron-tide");
    now = 4 * MINUTE_MS;
    await budget.status("iron-tide");
    assert.equal(asked.length, 1);
    now = 6 * MINUTE_MS;
    await budget.status("iron-tide");
    assert.equal(asked.length, 2);
  });

  it("sends nothing while signed out", async () => {
    const { budget, calls, asked } = rig(() => ok({}), { token: "" });
    await assert.rejects(budget.status("iron-tide"), SignInNeeded);
    await assert.rejects(budget.open("iron-tide"), SignInNeeded);
    await assert.rejects(budget.stop("iron-tide"), SignInNeeded);
    assert.deepEqual([calls, asked], [[], []]);
  });

  it("ends the sign-in when genex.games refuses the token on the read", async () => {
    const { budget, refused } = rig(() => refuse(401, "unauthorized"));
    await assert.rejects(budget.status("iron-tide"), SignInNeeded);
    assert.deepEqual(refused, [TOKEN]);
  });

  it("fails on an outage, a refused credential and an answer that does not read whole", async () => {
    const broken: Array<[string, GalleryAnswer]> = [
      ["an outage", refuse(503)],
      ["a credential that may not ask", refuse(403, "credential_scope")],
      ["nothing", ok(null)],
      ["a list", ok([])],
      ["a declaration that is text", ok({ declared: "yes", current: null })],
      ["a budget that does not read", ok({ declared: declared(), current: active({ remainingCredits: "85" }) })],
    ];
    for (const [why, answer] of broken) {
      const { budget, refused } = rig(() => answer);
      await assert.rejects(budget.status("iron-tide"), GalleryError, why);
      assert.deepEqual(refused, [], why);
    }
  });

  it("refuses a game id that could not be one", async () => {
    for (const id of ["../admin", "a/b", "", "x".repeat(65), "id?x=1"]) {
      const { budget, calls } = rig(() => ok({}), { project: async () => id });
      await assert.rejects(budget.status("iron-tide"), /Not a game/, id);
      await assert.rejects(budget.open("iron-tide"), /Not a game/, id);
      assert.deepEqual(calls, [], id);
    }
  });
});

describe("Answers the app will not show", () => {
  it("refuses a declaration that does not read as one", () => {
    const hostile: Array<[string, unknown]> = [
      ["text", "declared"],
      ["a list", [declared()]],
      ["a number", 1],
      ["models as text", declared({ models: "GPT-5 mini" })],
      ["a model that is not text", declared({ models: ["GPT-5 mini", 5] })],
      ["no models", declared({ models: undefined })],
      ["a judge that is not a flag", declared({ judge: "yes" })],
      ["listening that is not a flag", declared({ listens: 1 })],
      ["speaking that is not a flag", declared({ speaks: {} })],
      ["no word on whether it is served", declared({ available: undefined })],
      ["served as text", declared({ available: "true" })],
    ];
    for (const [why, body] of hostile) assert.equal(toAiBudgetDeclared(body), undefined, why);
    assert.equal(toAiBudgetDeclared(null), null);
    assert.equal(toAiBudgetDeclared(undefined), null);
  });

  it("leaves an estimate out when its number is not an amount", () => {
    for (const credits of [-5, Number.NaN, Number.POSITIVE_INFINITY, "80", null, 2 ** 60])
      assert.equal(toAiBudgetDeclared(declared({ estimatedCreditsPerPeriod: credits }))?.estimate, null);
  });

  it("refuses a budget that does not read as one", () => {
    const inherited: unknown = JSON.parse(`{"__proto__": ${JSON.stringify(active())}}`);
    const hostile: Array<[string, unknown]> = [
      ["nothing", null],
      ["a list", [active()]],
      ["text", GRANT],
      ["fields only a __proto__ key carries", inherited],
      ["an id that climbs", active({ id: "../grant" })],
      ["an id too long", active({ id: "g".repeat(129) })],
      ["no id", active({ id: undefined })],
      ["an unknown status", active({ status: "paid" })],
      ["no status", active({ status: undefined })],
      ["a negative limit", active({ limitCredits: -1 })],
      ["a limit as text", active({ limitCredits: "100" })],
      ["nothing spent said", active({ spentCredits: undefined })],
      ["a spend that is not a number", active({ spentCredits: Number.NaN })],
      ["an endless hold", active({ heldCredits: Number.POSITIVE_INFINITY })],
      ["more left than a number holds", active({ remainingCredits: 2 ** 60 })],
      ["negative credits left", active({ remainingCredits: -3 })],
      ["a time that is not one", active({ expiresAt: "tomorrow" })],
      ["a time as a number", active({ expiresAt: 1_790_000_000_000 })],
      ["a stop that is not a time", active({ stopRequestedAt: true })],
    ];
    for (const [why, body] of hostile) assert.equal(toAiBudgetView(body), null, why);
  });

  it("never approves a quote that does not read whole", async () => {
    const hostile: Array<[string, unknown]> = [
      ["nothing", null],
      ["a running budget", active()],
      ["an id that climbs", quote({ id: "../x" })],
      ["a quote id that is not one", quote({ quoteId: "quote-1" })],
      ["no quote id", quote({ quoteId: undefined })],
      ["no terms", quote({ terms: undefined })],
      ["terms as text", quote({ terms: "standing" })],
      ["no billing policy", quote({ terms: terms({ billingPolicy: "" }) })],
      ["a billing policy that is not text", quote({ terms: terms({ billingPolicy: 1 }) })],
      ["a billing policy too long", quote({ terms: terms({ billingPolicy: "p".repeat(65) }) })],
      ["a negative call price", quote({ terms: terms({ perCallMaxCredits: -4 }) })],
      ["a call price that is not a number", quote({ terms: terms({ perCallMaxCredits: Number.NaN }) })],
      ["no limits", quote({ terms: terms({ limit: undefined }) })],
      ["limits as a list", quote({ terms: terms({ limit: [10, 500, 10, 100] }) })],
      ["a least above the most", quote({ terms: terms({ limit: limits({ minCredits: 600 }) }) })],
      ["a default below the least", quote({ terms: terms({ limit: limits({ defaultCredits: 5 }) }) })],
      ["a default above the most", quote({ terms: terms({ limit: limits({ defaultCredits: 501 }) }) })],
      ["no step", quote({ terms: terms({ limit: limits({ stepCredits: 0 }) }) })],
      ["a negative step", quote({ terms: terms({ limit: limits({ stepCredits: -10 }) }) })],
      ["part of a credit", quote({ terms: terms({ limit: limits({ minCredits: 10.5 }) }) })],
      ["a most beyond any budget", quote({ terms: terms({ limit: limits({ maxCredits: 1_000_001 }) }) })],
      ["a most that is not a number", quote({ terms: terms({ limit: limits({ maxCredits: Number.NaN }) }) })],
      ["limits as text", quote({ terms: terms({ limit: limits({ maxCredits: "500" }) }) })],
      ["a time that is not one", quote({ expiresAt: "soon" })],
      ["budgets to replace that are not a list", quote({ replaces: "all" })],
    ];
    for (const [why, body] of hostile) {
      const { budget, calls } = rig((call) => (call.route === BUDGET ? ok(body) : ok(active())));
      await assert.rejects(budget.open("iron-tide"), GalleryError, why);
      assert.deepEqual(await budget.confirm("iron-tide", 100), { refused: AiBudgetRefusal.QuoteExpired }, why);
      assert.deepEqual(confirms(calls), [], why);
    }
  });
});

/** A quote's limits with some changed. */
function limits(overrides: Fields): Fields {
  return { minCredits: 10, maxCredits: 500, stepCredits: 10, defaultCredits: 100, ...overrides };
}

describe("Opening an AI budget for approval", () => {
  it("posts no body and answers what the sheet shows, with no id in it", async () => {
    const { budget, calls, asked } = rig(() => ok(quote({ replaces: [active()] })));
    assert.deepEqual(await budget.open("iron-tide"), {
      quote: {
        perCallMaxCredits: 4,
        estimate: { period: AiBudgetPeriod.Session, credits: 80 },
        limit: { minCredits: 10, maxCredits: 500, stepCredits: 10, defaultCredits: 100 },
        replaces: true,
        expiresAt: EXPIRES,
      },
    });
    assert.deepEqual(calls, [{ route: BUDGET, method: "POST", body: undefined, token: TOKEN }]);
    await budget.open("iron-tide");
    assert.equal(asked.length, 2, "each quote is for the game the catalog names now");
  });

  it("leaves the estimate out when genex.games gave none", async () => {
    const bare = terms({ disclosure: { periodLabel: "hour", estimatedCallsPerPeriod: 0 } });
    const { budget } = rig(() => ok(quote({ terms: bare })));
    const opened = await budget.open("iron-tide");
    assert.ok("quote" in opened);
    assert.equal(opened.quote.estimate, null);
    assert.equal(opened.quote.replaces, false);
  });

  it("opens nothing for a budget that covers voice", async () => {
    const { budget, calls } = rig(quoting(ok(active()), quote({ terms: terms({ voice: { speech: {} } }) })));
    assert.deepEqual(await budget.open("iron-tide"), { refused: AiBudgetRefusal.Voice });
    assert.deepEqual(await budget.confirm("iron-tide", 100), { refused: AiBudgetRefusal.QuoteExpired });
    assert.deepEqual(confirms(calls), []);
  });

  it("answers each refusal by its code, and never ends the sign-in", async () => {
    const table: Array<[number, string | undefined, AiBudgetRefusal]> = [
      [404, "model_budget_not_declared", AiBudgetRefusal.NotDeclared],
      [400, "model_not_available", AiBudgetRefusal.ModelNotAvailable],
      [503, "generation_paused", AiBudgetRefusal.GenerationPaused],
      [404, "project_not_found", AiBudgetRefusal.ProjectNotFound],
      [403, "credential_scope", AiBudgetRefusal.CredentialScope],
      [401, "unauthorized", AiBudgetRefusal.SessionRevoked],
      [401, undefined, AiBudgetRefusal.SessionRevoked],
      [500, undefined, AiBudgetRefusal.Unknown],
      [418, "something_new", AiBudgetRefusal.Unknown],
    ];
    for (const [status, code, refused] of table) {
      const { budget, refused: ended } = rig(() => refuse(status, code));
      assert.deepEqual(await budget.open("iron-tide"), { refused }, String(code));
      assert.deepEqual(ended, [], "a refused write is not a signed-out account");
    }
  });
});

describe("Approving an AI budget", () => {
  it("names the quote main kept, credits, its billing policy and the chosen limit, and no voice", async () => {
    const { budget, calls } = rig(quoting(ok(active({ limitCredits: 250, remainingCredits: 250, spentCredits: 0 }))));
    await budget.open("iron-tide");
    const approved = await budget.confirm("iron-tide", 250);
    assert.ok("current" in approved);
    assert.equal(approved.current.status, AiBudgetStatus.Active);
    assert.equal(approved.current.limitCredits, 250);
    assert.deepEqual(confirms(calls), [
      {
        route: CONFIRM,
        method: "POST",
        body: { quoteId: QUOTE_ID, funding: "credits", billingPolicy: "standing-v1", limitCredits: 250 },
        token: TOKEN,
      },
    ]);
  });

  it("approves a quote once", async () => {
    const { budget, calls } = rig(quoting(ok(active())));
    await budget.open("iron-tide");
    await budget.confirm("iron-tide", 100);
    assert.deepEqual(await budget.confirm("iron-tide", 100), { refused: AiBudgetRefusal.QuoteExpired });
    assert.equal(confirms(calls).length, 1);
  });

  it("sends nothing with no quote open, or for another game's quote", async () => {
    const { budget, calls } = rig(quoting(ok(active())));
    assert.deepEqual(await budget.confirm("iron-tide", 100), { refused: AiBudgetRefusal.QuoteExpired });
    await budget.open("iron-tide");
    assert.deepEqual(await budget.confirm("frigate", 100), { refused: AiBudgetRefusal.QuoteExpired });
    assert.deepEqual(confirms(calls), []);
  });

  it("never sends a limit the quote does not offer", async () => {
    const outside = [9, 0, -10, 501, 510, 1_000_000, 105, 10.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60];
    for (const limit of outside) {
      const { budget, calls } = rig(quoting(ok(active())));
      await budget.open("iron-tide");
      await assert.rejects(budget.confirm("iron-tide", limit), /Not a limit/, String(limit));
      assert.deepEqual(confirms(calls), [], String(limit));
    }
    for (const limit of [10, 20, 100, 500]) {
      const { budget, calls } = rig(quoting(ok(active())));
      await budget.open("iron-tide");
      await budget.confirm("iron-tide", limit);
      assert.equal(confirms(calls).length, 1, String(limit));
    }
  });

  it("answers each refusal by its code, and never ends the sign-in", async () => {
    const table: Array<[number, string | undefined, AiBudgetRefusal]> = [
      [400, "invalid_grant_limit", AiBudgetRefusal.InvalidLimit],
      [400, "grant_limit_below_call_ceiling", AiBudgetRefusal.LimitBelowCallCeiling],
      [409, "quote_expired", AiBudgetRefusal.QuoteExpired],
      [409, "quote_mismatch", AiBudgetRefusal.QuoteMismatch],
      [409, "billing_policy_mismatch", AiBudgetRefusal.BillingPolicyMismatch],
      [402, "insufficient_credits", AiBudgetRefusal.InsufficientCredits],
      [403, "credits_unverified", AiBudgetRefusal.CreditsUnverified],
      [503, "generation_paused", AiBudgetRefusal.GenerationPaused],
      [503, "provider_unavailable", AiBudgetRefusal.ProviderUnavailable],
      [401, "session_revoked", AiBudgetRefusal.SessionRevoked],
      [404, "grant_not_found", AiBudgetRefusal.GrantNotFound],
      [404, "game_unavailable", AiBudgetRefusal.GameUnavailable],
      [502, undefined, AiBudgetRefusal.Unknown],
    ];
    for (const [status, code, refused] of table) {
      const { budget, refused: ended } = rig(quoting(refuse(status, code)));
      await budget.open("iron-tide");
      assert.deepEqual(await budget.confirm("iron-tide", 100), { refused }, String(code));
      assert.deepEqual(ended, []);
    }
  });

  it("keeps the quote after a refusal it can outlive, and drops one that has ended", async () => {
    const kept = rig(quoting(refuse(402, "insufficient_credits")));
    await kept.budget.open("iron-tide");
    await kept.budget.confirm("iron-tide", 100);
    await kept.budget.confirm("iron-tide", 100);
    assert.equal(confirms(kept.calls).length, 2, "Approve again, once there are credits");
    for (const code of ["quote_expired", "quote_mismatch", "billing_policy_mismatch", "grant_not_found"]) {
      const ended = rig(quoting(refuse(409, code)));
      await ended.budget.open("iron-tide");
      await ended.budget.confirm("iron-tide", 100);
      await ended.budget.confirm("iron-tide", 100);
      assert.equal(confirms(ended.calls).length, 1, code);
    }
  });

  it("fails when the approval's answer does not read as a budget, and does not send it twice", async () => {
    const { budget, calls } = rig(quoting(ok({ status: "active" })));
    await budget.open("iron-tide");
    await assert.rejects(budget.confirm("iron-tide", 100), GalleryError);
    assert.deepEqual(await budget.confirm("iron-tide", 100), { refused: AiBudgetRefusal.QuoteExpired });
    assert.equal(confirms(calls).length, 1);
  });

  it("sends nothing once the app has signed out", async () => {
    let token = TOKEN;
    const calls: Call[] = [];
    const budget = playAiBudget({
      request: async (route, init) => {
        calls.push({ route, method: init.method ?? "GET" });
        return ok(quote());
      },
      token: async () => token || undefined,
      now: () => 0,
      project: async () => PROJECT,
    });
    await budget.open("iron-tide");
    token = "";
    await assert.rejects(budget.confirm("iron-tide", 100), SignInNeeded);
    assert.deepEqual(confirms(calls), []);
  });
});

describe("Stopping an AI budget", () => {
  it("posts no body and answers the budget after it", async () => {
    const { budget, calls } = rig(() => ok(active({ status: "stopped" })));
    const stopped = await budget.stop("iron-tide");
    assert.ok("current" in stopped);
    assert.equal(stopped.current?.status, AiBudgetStatus.Stopped);
    assert.deepEqual(calls, [{ route: STOP, method: "POST", body: undefined, token: TOKEN }]);
  });

  it("says a stop is under way while a started call finishes", async () => {
    const { budget } = rig(() => ok(active({ stopRequestedAt: EXPIRES })));
    const stopped = await budget.stop("iron-tide");
    assert.ok("current" in stopped);
    assert.deepEqual([stopped.current?.status, stopped.current?.stopping], [AiBudgetStatus.Active, true]);
  });

  it("reads nothing to stop as already stopped, and any other refusal by its code", async () => {
    const none = rig(() => refuse(404, "grant_not_found"));
    assert.deepEqual(await none.budget.stop("iron-tide"), { current: null });
    const revoked = rig(() => refuse(401, "session_revoked"));
    assert.deepEqual(await revoked.budget.stop("iron-tide"), { refused: AiBudgetRefusal.SessionRevoked });
    assert.deepEqual(revoked.refused, []);
    const broken = rig(() => ok({ id: GRANT }));
    await assert.rejects(broken.budget.stop("iron-tide"), GalleryError);
  });
});

describe("The limits a quote offers", () => {
  const offer = { minCredits: 10, maxCredits: 505, stepCredits: 10, defaultCredits: 100 };

  it("are whole steps from the least, within the most", () => {
    for (const limit of [10, 20, 500]) assert.equal(limitOffered(offer, limit), true, String(limit));
    for (const limit of [0, 9, 15, 505, 510, 10.5, Number.NaN, "100", null, undefined])
      assert.equal(limitOffered(offer, limit), false, String(limit));
  });

  it("the nearest one to any number is always offered", () => {
    for (const value of [-50, 0, 10, 14, 15, 104, 499, 505, 9999, Number.NaN, Number.POSITIVE_INFINITY]) {
      const near = nearestLimit(offer, value);
      assert.equal(limitOffered(offer, near), true, `${value} → ${near}`);
    }
    assert.deepEqual([nearestLimit(offer, 14), nearestLimit(offer, 16), nearestLimit(offer, 9999)], [10, 20, 500]);
  });
});
