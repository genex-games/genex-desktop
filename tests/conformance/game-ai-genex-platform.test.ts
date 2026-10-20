/**
 * genex.games as play-time AI reaches it (`main/game-ai/platform.ts`), over a scripted API: the
 * balance, the packs at their one checkout price (D13), checkout and auto top-up's switch (D11,
 * whose caps genex.games enforces), the terms of a grant or generation the embed SDK asks the app
 * to confirm (D3) and the person's answer on genex.games, and the Report and fit-count sends (the
 * counts go with no account). Every answer is hostile input: a row or a field out of shape is
 * dropped, and an id that is not genex.games' shape never reaches a route.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createGenexAiCreatorReads, createGenexAiPlatform, PlatformRoute } from "../../src/main/game-ai/platform.ts";
import type { GalleryAnswer, GalleryRequest } from "../../src/main/play/gallery.ts";
import { AiDoor } from "../../src/shared/game-ai.ts";
import { AI_FIT_COUNTS_ROUTE } from "../../src/shared/game-ai-check.ts";
import {
  AI_REPORT_ROUTE,
  type AiReportBundle,
  AiReportFailure,
  AiReportKind,
  AiReportReason,
} from "../../src/shared/game-ai-report.ts";
import { AiCreditProductKind } from "../../src/shared/game-ai-views.ts";
import { GenexConfirmKind } from "../../src/shared/genex-desktop-bridge.ts";

type Init = Parameters<GalleryRequest>[1];
interface Sent {
  route: string;
  init: Init;
}

const TOKEN = "creator-token";
const QUOTE = "5b0e6a40-6f3e-4c1d-9a7e-1d2c3b4a5f60";
const STRIPE_SETUP = "https://checkout.stripe.com/c/pay/cs_setup_1";

/** A scripted genex.games: answers by `METHOD route`, every request recorded. */
function api(routes: Record<string, GalleryAnswer | ((init: Init) => GalleryAnswer)>, token: string | null = TOKEN) {
  const sent: Sent[] = [];
  const opened: string[] = [];
  const request: GalleryRequest = async (route, init) => {
    sent.push({ route, init });
    const answer = routes[`${init.method ?? "GET"} ${route}`];
    if (!answer) return { status: 404, body: { error: "not_found" } };
    return typeof answer === "function" ? answer(init) : answer;
  };
  const platform = createGenexAiPlatform({
    request,
    token: async () => token ?? undefined,
    openExternal: async (url) => void opened.push(url),
  });
  return { platform, sent, opened };
}

const ok = (body: unknown): GalleryAnswer => ({ status: 200, body });

/** A grant waiting for the person, as genex.games' `grantView` shows it. */
function grantView(patch: Record<string, unknown> = {}) {
  return {
    id: "grant_1",
    status: "requires_confirmation",
    funding: null,
    projectId: "proj_crowns",
    quoteId: QUOTE,
    terms: { billingPolicy: "metered-credits-v1", currency: "credits" },
    allowedFunding: ["credits", "claude"],
    currency: "credits",
    limitCredits: 300,
    ...patch,
  };
}

/** A generation waiting for the person, as genex.games' `generationView` shows it. */
function generationView(patch: Record<string, unknown> = {}) {
  return {
    id: "gen_1",
    status: "requires_confirmation",
    funding: null,
    projectId: "proj_crowns",
    currency: "credits",
    quote: { id: QUOTE, kind: "metered", billingPolicy: "metered-credits-v1", currency: "credits", maxCredits: 12 },
    allowedFunding: ["credits"],
    maxCredits: 12,
    ...patch,
  };
}

describe("genex.games for play-time AI: credits", () => {
  it("reads the spendable balance with the account's token, and nothing while signed out", async () => {
    const a = api({ [`GET ${PlatformRoute.Me}`]: ok({ balance: 900, spendable: 750 }) });
    assert.equal(await a.platform.balanceCredits(), 750);
    assert.equal(a.sent[0]?.init.token, TOKEN);
    const fallback = api({ [`GET ${PlatformRoute.Me}`]: ok({ balance: 900 }) });
    assert.equal(await fallback.platform.balanceCredits(), 900);
    const signedOut = api({}, null);
    assert.equal(await signedOut.platform.balanceCredits(), null);
    assert.equal(signedOut.sent.length, 0);
  });

  it("refuses a balance that is not a whole count of credits", async () => {
    for (const body of [{ balance: -1 }, { balance: 1.5 }, { balance: "900" }, null, [], { spendable: Number.NaN }]) {
      const a = api({ [`GET ${PlatformRoute.Me}`]: ok(body) });
      await assert.rejects(a.platform.balanceCredits(), JSON.stringify(body));
    }
    const down = api({ [`GET ${PlatformRoute.Me}`]: { status: 503, body: null } });
    await assert.rejects(down.platform.balanceCredits());
  });

  it("lists the packs genex.games sells at one price each, and drops a row out of shape", async () => {
    const a = api({
      [`GET ${PlatformRoute.Catalog}`]: ok({
        anchorUsdCentsPerCredit: 1,
        packs: [
          { key: "credits_1000", credits: 1000, priceUsdCents: 1100, available: true },
          { key: "credits_500", credits: 500, priceUsdCents: 550, available: true },
          { key: "credits_2500", credits: 2500, priceUsdCents: 2750, available: false },
          { key: "../evil", credits: 5000, priceUsdCents: 5500, available: true },
          { key: "credits_neg", credits: -5, priceUsdCents: 550, available: true },
          { key: "credits_free", credits: 500, priceUsdCents: 0, available: true },
          { key: "credits_half", credits: 500.5, priceUsdCents: 550, available: true },
          { key: 7, credits: 500, priceUsdCents: 550, available: true },
          "credits_500",
        ],
        pro: { priceUsdCents: 999, available: true },
        coin: null,
      }),
    });
    assert.deepEqual(await a.platform.packs(), [
      { id: "credits_500", credits: 500, priceCents: 550 },
      { id: "credits_1000", credits: 1000, priceCents: 1100 },
    ]);
    assert.equal(a.sent[0]?.init.token, undefined, "the catalog is public");
    const broken = api({ [`GET ${PlatformRoute.Catalog}`]: ok({ packs: "all" }) });
    assert.deepEqual(await broken.platform.packs(), []);
    const down = api({ [`GET ${PlatformRoute.Catalog}`]: { status: 404, body: null } });
    await assert.rejects(down.platform.packs());
  });

  it("asks genex.games for a pack's or Pro's checkout page as the signed-in account", async () => {
    const a = api({ [`POST ${PlatformRoute.Checkout}`]: ok({ url: "https://checkout.stripe.com/c/pay/cs_1" }) });
    assert.equal(
      await a.platform.checkoutUrl({ kind: AiCreditProductKind.Pack, packId: "credits_500" }),
      "https://checkout.stripe.com/c/pay/cs_1",
    );
    assert.deepEqual(a.sent[0]?.init.body, { product: "credits", packKey: "credits_500", source: "credits_modal" });
    assert.equal(a.sent[0]?.init.token, TOKEN);
    await a.platform.checkoutUrl({ kind: AiCreditProductKind.Pro });
    assert.deepEqual(a.sent[1]?.init.body, { product: "pro", source: "credits_modal" });
    for (const body of [{ url: 7 }, {}, null, { error: "verification_required" }]) {
      const bad = api({ [`POST ${PlatformRoute.Checkout}`]: ok(body) });
      await assert.rejects(bad.platform.checkoutUrl({ kind: AiCreditProductKind.Pro }), JSON.stringify(body));
    }
    const signedOut = api({}, null);
    await assert.rejects(signedOut.platform.checkoutUrl({ kind: AiCreditProductKind.Pro }));
    assert.equal(signedOut.sent.length, 0);
  });
});

describe("genex.games for play-time AI: auto top-up (D11)", () => {
  const view = (patch: Record<string, unknown> = {}) => ({
    config: { on: false, underCredits: 100, addCredits: 1000 },
    card: { brand: "visa", last4: "4242" },
    ready: true,
    disabledReason: null,
    mandate: { version: "2026-10-20", text: "…" },
    pausedGames: [],
    ...patch,
  });

  it("reads the switch, and nothing while signed out", async () => {
    const a = api({ [`GET ${PlatformRoute.AutoTopUp}`]: ok(view()) });
    assert.deepEqual(await a.platform.autoTopUp(), { on: false, underCredits: 100, addCredits: 1000 });
    assert.equal(await api({}, null).platform.autoTopUp(), null);
    for (const config of [
      { on: "yes", underCredits: 100, addCredits: 1000 },
      { on: true, underCredits: 0, addCredits: 1000 },
      { on: true, underCredits: 100, addCredits: 1.5 },
      null,
    ]) {
      const bad = api({ [`GET ${PlatformRoute.AutoTopUp}`]: ok(view({ config })) });
      assert.equal(await bad.platform.autoTopUp(), null, JSON.stringify(config));
    }
  });

  it("turns it on under the mandate the person was shown, and off with no mandate", async () => {
    const a = api({
      [`GET ${PlatformRoute.AutoTopUp}`]: ok(view()),
      [`PUT ${PlatformRoute.AutoTopUp}`]: (init) => ok(view({ config: { ...(init.body as object), on: true } })),
    });
    const on = await a.platform.setAutoTopUp({ on: true, underCredits: 100, addCredits: 1000 });
    assert.equal(on.on, true);
    const put = a.sent.find((row) => row.init.method === "PUT");
    assert.deepEqual(put?.init.body, { on: true, underCredits: 100, addCredits: 1000, mandateVersion: "2026-10-20" });
    await a.platform.setAutoTopUp({ on: false, underCredits: 100, addCredits: 1000 });
    const off = a.sent.filter((row) => row.init.method === "PUT")[1];
    assert.deepEqual(off?.init.body, { on: false, underCredits: 100, addCredits: 1000 });
  });

  it("opens Stripe's card page when no card is saved, and leaves the switch as it was", async () => {
    const a = api({
      [`GET ${PlatformRoute.AutoTopUp}`]: ok(view({ ready: false, card: null })),
      [`POST ${PlatformRoute.AutoTopUpSetup}`]: ok({ url: STRIPE_SETUP }),
    });
    const after = await a.platform.setAutoTopUp({ on: true, underCredits: 100, addCredits: 1000 });
    assert.equal(after.on, false);
    assert.deepEqual(a.opened, [STRIPE_SETUP]);
    assert.ok(!a.sent.some((row) => row.init.method === "PUT"), "nothing turned on before a card is saved");
    const setup = a.sent.find((row) => row.route === PlatformRoute.AutoTopUpSetup);
    assert.deepEqual(setup?.init.body, {
      underCredits: 100,
      addCredits: 1000,
      mandateVersion: "2026-10-20",
      source: "credits_modal",
    });
  });

  it("opens no card page anywhere but Stripe's checkout over https", async () => {
    for (const url of [
      "http://checkout.stripe.com/c/pay/cs_1",
      "https://checkout.stripe.com.evil.example/c/pay/cs_1",
      "javascript:alert(1)",
      "https://genex.games@evil.example/",
    ]) {
      const a = api({
        [`GET ${PlatformRoute.AutoTopUp}`]: ok(view({ ready: false })),
        [`POST ${PlatformRoute.AutoTopUpSetup}`]: ok({ url }),
      });
      await assert.rejects(a.platform.setAutoTopUp({ on: true, underCredits: 100, addCredits: 1000 }), url);
      assert.deepEqual(a.opened, [], url);
    }
  });

  it("says genex.games' refusal, by its code, and changes nothing here", async () => {
    const a = api({
      [`GET ${PlatformRoute.AutoTopUp}`]: ok(view()),
      [`PUT ${PlatformRoute.AutoTopUp}`]: { status: 409, body: { error: "mandate_changed" } },
    });
    await assert.rejects(a.platform.setAutoTopUp({ on: true, underCredits: 100, addCredits: 1000 }), /mandate_changed/);
    await assert.rejects(api({}, null).platform.setAutoTopUp({ on: false, underCredits: 100, addCredits: 1000 }));
  });
});

describe("genex.games for play-time AI: the desktop confirm (D3)", () => {
  it("reads a grant's terms by id: its most credits and its game", async () => {
    const a = api({ [`GET ${PlatformRoute.grant("grant_1")}`]: ok(grantView()) });
    assert.deepEqual(await a.platform.confirmTerms({ kind: GenexConfirmKind.Grant, id: "grant_1" }), {
      maxCredits: 300,
      game: "proj_crowns",
    });
    assert.equal(a.sent[0]?.init.token, TOKEN);
    const g = api({ [`GET ${PlatformRoute.generation("gen_1")}`]: ok(generationView()) });
    assert.deepEqual(await g.platform.confirmTerms({ kind: GenexConfirmKind.Generate, id: "gen_1" }), {
      maxCredits: 12,
      game: "proj_crowns",
    });
  });

  it("has no terms for a grant that is not the person's to approve in credits", async () => {
    const rows: Array<[string, Record<string, unknown>]> = [
      ["already approved", { status: "active", funding: "credits" }],
      ["stopped", { status: "stopped" }],
      ["coins", { currency: "coins" }],
      ["credits not allowed", { allowedFunding: ["claude"] }],
      ["no limit", { limitCredits: 0 }],
      ["a fractional limit", { limitCredits: 2.5 }],
      ["no game", { projectId: null }],
      ["a game id out of shape", { projectId: "../proj" }],
      ["no quote", { quoteId: 7 }],
    ];
    for (const [label, patch] of rows) {
      const a = api({ [`GET ${PlatformRoute.grant("grant_1")}`]: ok(grantView(patch)) });
      assert.equal(await a.platform.confirmTerms({ kind: GenexConfirmKind.Grant, id: "grant_1" }), null, label);
    }
    const missing = api({});
    assert.equal(await missing.platform.confirmTerms({ kind: GenexConfirmKind.Grant, id: "grant_1" }), null);
    assert.equal(await api({}, null).platform.confirmTerms({ kind: GenexConfirmKind.Grant, id: "grant_1" }), null);
  });

  it("never sends an id out of genex.games' shape to a route", async () => {
    for (const id of ["../admin", "a/b", "%2e%2e", "", "x".repeat(101), "id?x=1", "id#frag"]) {
      const a = api({});
      assert.equal(await a.platform.confirmTerms({ kind: GenexConfirmKind.Grant, id }), null, id);
      assert.deepEqual(await a.platform.answerConfirm({ kind: GenexConfirmKind.Generate, id }, true), {
        approved: false,
      });
      assert.equal(a.sent.length, 0, id);
    }
  });

  it("approves a grant in credits under the terms it reads again, and declines by stopping it", async () => {
    const a = api({
      [`GET ${PlatformRoute.grant("grant_1")}`]: ok(grantView()),
      [`POST ${PlatformRoute.grantConfirm("grant_1")}`]: ok(grantView({ status: "active", funding: "credits" })),
      [`POST ${PlatformRoute.grantStop("grant_1")}`]: ok(grantView({ status: "stopped" })),
    });
    assert.deepEqual(await a.platform.answerConfirm({ kind: GenexConfirmKind.Grant, id: "grant_1" }, true), {
      approved: true,
    });
    const confirm = a.sent.find((row) => row.route === PlatformRoute.grantConfirm("grant_1"));
    assert.deepEqual(confirm?.init.body, {
      quoteId: QUOTE,
      funding: "credits",
      billingPolicy: "metered-credits-v1",
      limitCredits: 300,
    });
    assert.deepEqual(await a.platform.answerConfirm({ kind: GenexConfirmKind.Grant, id: "grant_1" }, false), {
      approved: false,
    });
    assert.ok(a.sent.some((row) => row.route === PlatformRoute.grantStop("grant_1")));
  });

  it("approves a generation in credits, and declines by canceling it", async () => {
    const a = api({
      [`GET ${PlatformRoute.generation("gen_1")}`]: ok(generationView()),
      [`POST ${PlatformRoute.generationConfirm("gen_1")}`]: ok(
        generationView({ status: "queued", funding: "credits" }),
      ),
      [`POST ${PlatformRoute.generationCancel("gen_1")}`]: ok(generationView({ status: "canceled" })),
    });
    assert.deepEqual(await a.platform.answerConfirm({ kind: GenexConfirmKind.Generate, id: "gen_1" }, true), {
      approved: true,
    });
    const confirm = a.sent.find((row) => row.route === PlatformRoute.generationConfirm("gen_1"));
    assert.deepEqual(confirm?.init.body, { quoteId: QUOTE, funding: "credits", billingPolicy: "metered-credits-v1" });
    await a.platform.answerConfirm({ kind: GenexConfirmKind.Generate, id: "gen_1" }, false);
    assert.ok(a.sent.some((row) => row.route === PlatformRoute.generationCancel("gen_1")));
  });

  it("reports not approved when genex.games refused the confirm or answered something else", async () => {
    for (const confirmed of [
      { status: 409, body: { error: "quote_expired" } },
      ok(grantView({ status: "requires_confirmation" })),
      ok(grantView({ status: "active", funding: "claude" })),
      ok(null),
    ]) {
      const a = api({
        [`GET ${PlatformRoute.grant("grant_1")}`]: ok(grantView()),
        [`POST ${PlatformRoute.grantConfirm("grant_1")}`]: confirmed,
      });
      assert.deepEqual(await a.platform.answerConfirm({ kind: GenexConfirmKind.Grant, id: "grant_1" }, true), {
        approved: false,
      });
    }
  });
});

/** A player's Report of a published game, as the Report builder makes it (no account id in it). */
function reportBundle(): AiReportBundle {
  return {
    v: 1,
    id: "report-0001",
    kind: AiReportKind.Player,
    createdAt: "2026-10-20T18:00:00.000Z",
    game: { key: "play:proj_crowns", title: "Crowns of 1444" },
    reason: AiReportReason.Harmful,
    note: null,
    calls: [],
    replay: { seed: 7, commit: null, engine: "web", templateVersion: null, inputs: [], tape: [] },
    digests: [],
    aiState: null,
    consoleErrors: [],
    frame: null,
    modelCheck: null,
    playerText: true,
  };
}

describe("genex.games for play-time AI: Reports and fit counts", () => {
  it("sends fit counts with no account, and a Report as the signed-in person", async () => {
    const a = api({ [`POST ${AI_FIT_COUNTS_ROUTE}`]: ok({ accepted: 1 }) });
    await a.platform.sendFitCounts([
      {
        game: "play:proj_crowns",
        model: "anthropic/claude-haiku-4.5",
        door: AiDoor.Byok,
        week: "2026-W43",
        calls: 3,
        fitted: 2,
        invalid: 1,
      },
    ]);
    const sent = a.sent.find((row) => row.route === AI_FIT_COUNTS_ROUTE);
    assert.ok(sent, "the counts were sent");
    assert.equal(sent.init.token, undefined, "counts never carry the account");
    const reported = api({ [`POST ${AI_REPORT_ROUTE}`]: { status: 201, body: { id: "report_0001" } } });
    const outcome = await reported.platform.sendReport(reportBundle());
    assert.deepEqual(outcome, { ok: true, id: "report_0001" });
    assert.equal(reported.sent[0]?.init.token, TOKEN);
  });
});

describe("genex.games for play-time AI: the creator's own published game", () => {
  function reads(routes: Record<string, GalleryAnswer>, token: string | null = TOKEN) {
    const sent: Sent[] = [];
    const request: GalleryRequest = async (route, init) => {
      sent.push({ route, init });
      return routes[`${init.method ?? "GET"} ${route}`] ?? { status: 404, body: { error: "project_not_found" } };
    };
    return { reads: createGenexAiCreatorReads({ request, token: async () => token ?? undefined }), sent };
  }

  it("reads the creator's share of the game in basis points, and none it cannot read", async () => {
    const a = reads({ [`GET ${PlatformRoute.creatorShare("proj_moss")}`]: ok({ bps: 1000, earnedCredits: 0 }) });
    assert.equal(await a.reads.creatorShareBps("proj_moss"), 1000);
    assert.equal(a.sent[0]?.init.token, TOKEN);
    for (const body of [{ bps: -1 }, { bps: 10_001 }, { bps: 2.5 }, {}, null]) {
      const bad = reads({ [`GET ${PlatformRoute.creatorShare("proj_moss")}`]: ok(body) });
      assert.equal(await bad.reads.creatorShareBps("proj_moss"), null, JSON.stringify(body));
    }
    assert.equal(await reads({}).reads.creatorShareBps("proj_moss"), null, "another account's project is a 404");
    assert.equal(await reads({}, null).reads.creatorShareBps("proj_moss"), null);
    const hostile = reads({});
    assert.equal(await hostile.reads.creatorShareBps("../x"), null);
    assert.equal(hostile.sent.length, 0);
  });

  it("reads the title a published game is listed under, publicly, and none it cannot read", async () => {
    const a = reads(
      { [`GET ${PlatformRoute.published("proj_crowns")}`]: ok({ project: { title: "Crowns of 1444" } }) },
      null,
    );
    assert.equal(await a.reads.publishedTitle("proj_crowns"), "Crowns of 1444");
    assert.equal(a.sent[0]?.init.token, undefined, "a public read carries no account");
    for (const body of [
      { project: { title: "" } },
      { project: { title: 7 } },
      { title: "x" },
      null,
      { project: { title: "x".repeat(500) } },
    ]) {
      const bad = reads({ [`GET ${PlatformRoute.published("proj_crowns")}`]: ok(body) });
      assert.equal(await bad.reads.publishedTitle("proj_crowns"), null, JSON.stringify(body));
    }
    const hostile = reads({});
    assert.equal(await hostile.reads.publishedTitle("a/../b"), null);
    assert.equal(hostile.sent.length, 0);
  });

  it("lists the game's reports and reads one bundle for Fix with agent", async () => {
    const a = reads({
      [`GET ${PlatformRoute.reports("proj_moss")}`]: ok({ items: [{ id: "report-1" }] }),
      [`GET ${PlatformRoute.report("proj_moss", "report-1")}`]: ok({ id: "report-1", v: 1 }),
      [`GET ${PlatformRoute.report("proj_moss", "report-gone")}`]: { status: 404, body: { error: "report_not_found" } },
      [`GET ${PlatformRoute.report("proj_moss", "report-down")}`]: { status: 503, body: null },
    });
    assert.deepEqual(await a.reads.inbox.list("proj_moss"), [{ id: "report-1" }]);
    assert.deepEqual(await a.reads.inbox.bundle("proj_moss", "report-1"), { ok: true, body: { id: "report-1", v: 1 } });
    assert.deepEqual(await a.reads.inbox.bundle("proj_moss", "report-gone"), {
      ok: false,
      failure: AiReportFailure.Refused,
    });
    assert.deepEqual(await a.reads.inbox.bundle("proj_moss", "report-down"), {
      ok: false,
      failure: AiReportFailure.Offline,
    });
    await assert.rejects(reads({}).reads.inbox.list("proj_moss"));
    await assert.rejects(reads({}, null).reads.inbox.list("proj_moss"));
  });
});
