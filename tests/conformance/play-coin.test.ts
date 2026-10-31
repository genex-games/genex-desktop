/**
 * The coin client behind Play's purchase sheet: main reads a purchase and the account's balance on
 * genex.games, and confirms or cancels the purchase as the app's Genex account, from Studio's own
 * sheet. What genex.games answers is hostile input: a purchase that does not read as one is never
 * drawn or confirmed, an id that is not one is never sent, and only a read the token was refused on
 * ends the sign-in.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";
import {
  CoinFailure,
  CoinIntentStatus,
  CoinRefused,
  CoinRoute,
  type CoinIntent,
  playCoin,
  toCoinIntent,
} from "../../src/main/play/coin.ts";
import { type GalleryAnswer, type GalleryRequest, networkRequest, SignInNeeded } from "../../src/main/play/gallery.ts";

const TOKEN = "genex-cli-token";
const EXPIRES = "2026-10-19T12:02:00.000Z";
/** Direction controls a game could hide in its words, by code point so none sits in this file. */
const BIDI = {
  RightToLeftOverride: String.fromCodePoint(0x202e),
  PopFormatting: String.fromCodePoint(0x202c),
  LeftToRightIsolate: String.fromCodePoint(0x2066),
  PopIsolate: String.fromCodePoint(0x2069),
  RightToLeftMark: String.fromCodePoint(0x200f),
} as const;

/** A purchase as genex.games serves one (`GET /api/coin/intents/:id`). */
const served = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "clx123",
  status: "requires_confirmation",
  projectId: "cm1",
  skuId: "sku1",
  orderId: null,
  description: null,
  projectName: "Lost Cathedral",
  failureCode: null,
  name: "Gem pack",
  iconUrl: "https://cdn.genex.technology/sku/gem.png",
  quantity: 1,
  unitPriceCoins: 75,
  totalCoins: 75,
  priceDisplayUsdCents: 75,
  expiresAt: EXPIRES,
  ...overrides,
});

/** A payment the game priced itself (`requestPayment()`): no SKU, an order and its terms. */
const dynamic = (overrides: Record<string, unknown> = {}) =>
  served({
    skuId: null,
    orderId: "order-1",
    name: "Revive",
    description: "Back on your feet.",
    iconUrl: null,
    ...overrides,
  });

/** A purchase as the client reads it. */
function intentOf(body: Record<string, unknown>): CoinIntent {
  const intent = toCoinIntent(body);
  assert.ok(intent, JSON.stringify(body));
  return intent;
}

interface Call {
  route: string;
  method: string;
  body?: unknown;
  token?: string;
}

/** The coin client over a recording fake of genex.games: `answer` decides each reply. */
function rig(answer: (route: string, init: Parameters<GalleryRequest>[1]) => GalleryAnswer, token = TOKEN) {
  const calls: Call[] = [];
  const refused: string[] = [];
  const request: GalleryRequest = async (route, init) => {
    calls.push({ route, method: init.method ?? "GET", body: init.body, token: init.token });
    return answer(route, init);
  };
  const coin = playCoin({
    request,
    token: async () => token || undefined,
    now: () => 0,
    refused: (refusedToken) => refused.push(refusedToken),
  });
  return { coin, calls, refused };
}

const ok = (body: unknown): GalleryAnswer => ({ status: 200, body });
const posts = (calls: Call[]) => calls.filter((call) => call.method !== "GET");

describe("A purchase as genex.games serves it", () => {
  it("reads what the sheet shows and what confirming it needs", () => {
    assert.deepEqual(toCoinIntent(served()), {
      id: "clx123",
      status: CoinIntentStatus.RequiresConfirmation,
      projectId: "cm1",
      dynamic: false,
      name: "Gem pack",
      description: null,
      iconUrl: "https://cdn.genex.technology/sku/gem.png",
      quantity: 1,
      unitPriceCoins: 75,
      totalCoins: 75,
      usdCents: 75,
      expiresAt: Date.parse(EXPIRES),
      failure: null,
    });
    const priced = toCoinIntent(dynamic());
    assert.equal(priced?.dynamic, true, "a payment with no SKU names its dynamic terms when confirmed");
    assert.equal(priced?.description, "Back on your feet.");
    const five = toCoinIntent(served({ quantity: 5, unitPriceCoins: 75, totalCoins: 375 }));
    assert.deepEqual([five?.quantity, five?.unitPriceCoins, five?.totalCoins], [5, 75, 375]);
    assert.equal(toCoinIntent(served({ priceDisplayUsdCents: null }))?.usdCents, null);
    assert.equal(toCoinIntent(served({ projectId: null }))?.projectId, null, "a payment held for no game");
    assert.equal(toCoinIntent(served({ description: "   " }))?.description, null);
  });

  it("reads why genex.games failed one, by its code", () => {
    const short = toCoinIntent(served({ status: "failed", failureCode: "insufficient_balance" }));
    assert.equal(short?.status, CoinIntentStatus.Failed);
    assert.equal(short?.failure, CoinFailure.InsufficientBalance);
    assert.equal(
      toCoinIntent(served({ status: "failed", failureCode: "something_new" }))?.failure,
      CoinFailure.Unknown,
    );
    assert.equal(
      toCoinIntent(served({ status: "expired", failureCode: "intent_expired" }))?.failure,
      CoinFailure.IntentExpired,
    );
    for (const status of ["processing", "succeeded", "consumed", "expired", "canceled", "failed", "refunded"])
      assert.equal(toCoinIntent(served({ status }))?.status, status, status);
  });
});

describe("A purchase Studio will not show", () => {
  it("refuses anything that does not read as a purchase Studio may show", () => {
    const hostile: Array<[string, unknown]> = [
      ["nothing", null],
      ["a list", [served()]],
      ["text", "clx123"],
      ["no coin", served({ totalCoins: 0 })],
      ["negative coin", served({ totalCoins: -1 })],
      ["part of a coin", served({ totalCoins: 1.5 })],
      ["not a number", served({ totalCoins: Number.NaN })],
      ["infinite coin", served({ totalCoins: Number.POSITIVE_INFINITY })],
      ["more than one sheet may confirm", served({ totalCoins: 100_001, unitPriceCoins: 100_001 })],
      ["coin as text", served({ totalCoins: "75" })],
      ["no total", served({ totalCoins: undefined })],
      ["no unit price", served({ unitPriceCoins: 0 })],
      ["a unit price as text", served({ unitPriceCoins: "75" })],
      ["a unit price over the cap", served({ unitPriceCoins: 100_001 })],
      ["no quantity", served({ quantity: 0 })],
      ["a hundred of them", served({ quantity: 100 })],
      ["part of one", served({ quantity: 1.5 })],
      ["a quantity as text", served({ quantity: "1" })],
      ["negative cents", served({ priceDisplayUsdCents: -1 })],
      ["part of a cent", served({ priceDisplayUsdCents: 0.5 })],
      ["cents as text", served({ priceDisplayUsdCents: "75" })],
      ["an unknown status", served({ status: "paid" })],
      ["no status", served({ status: undefined })],
      ["no name", served({ name: "" })],
      ["a blank name", served({ name: "   " })],
      ["a name of direction marks only", served({ name: BIDI.RightToLeftOverride + BIDI.LeftToRightIsolate })],
      ["a name too long", served({ name: "x".repeat(81) })],
      ["a name that is not text", served({ name: 42 })],
      ["no name at all", served({ name: null })],
      ["terms too long to show whole", served({ description: "x".repeat(1001) })],
      ["terms that are not text", served({ description: 42 })],
      ["a time that is not one", served({ expiresAt: "yesterday" })],
      ["a time as a number", served({ expiresAt: 1_760_000_000_000 })],
      ["no time", served({ expiresAt: undefined })],
      ["an id that climbs", served({ id: "../clx123" })],
      ["an id too long", served({ id: "a".repeat(65) })],
      ["no id", served({ id: undefined })],
      ["a game id that climbs", served({ projectId: "../cm1" })],
      ["a game id that is not text", served({ projectId: 42 })],
      ["a SKU that is not one", served({ skuId: 42 })],
      ["no word on a SKU", served({ skuId: undefined })],
    ];
    for (const [why, body] of hostile) assert.equal(toCoinIntent(body), null, why);
  });

  it("reads one with a broken body as an error, and confirms nothing", async () => {
    for (const body of [null, served({ totalCoins: 0 }), served({ status: "paid" }), served({ name: "" })]) {
      const { coin, calls } = rig(() => ok(body));
      await assert.rejects(coin.intent("clx123"), JSON.stringify(body));
      assert.deepEqual(posts(calls), [], "nothing was confirmed or canceled");
    }
  });
});

describe("A purchase's picture and words", () => {
  it("draws a picture only from a host the app loads images from", () => {
    for (const iconUrl of [
      "javascript:alert(1)",
      "http://cdn.genex.technology/sku/gem.png",
      "https://evil.example/gem.png",
      "https://cdn.genex.technology.evil.example/gem.png",
      "data:image/svg+xml;utf8,<svg/>",
      42,
    ])
      assert.equal(toCoinIntent(served({ iconUrl }))?.iconUrl, null, String(iconUrl));
    const drawn = "data:image/svg+xml;utf8,<svg/>";
    assert.equal(toCoinIntent(served({ iconUrl: drawn }), true)?.iconUrl, drawn, "a fixture's drawn picture");
  });

  it("keeps the game's words without anything that turns their direction", () => {
    const { RightToLeftOverride, PopFormatting, LeftToRightIsolate, PopIsolate, RightToLeftMark } = BIDI;
    const name = `${RightToLeftOverride}Gem${PopFormatting} pack`;
    const description = ` Pay${LeftToRightIsolate} now ${PopIsolate}${RightToLeftMark}`;
    const sly = toCoinIntent(served({ name, description, skuId: null }));
    assert.equal(sly?.name, "Gem pack");
    assert.equal(sly?.description, "Pay now");
    assert.equal(toCoinIntent(served({ description: "x".repeat(1000) }))?.description?.length, 1000);
    assert.equal(toCoinIntent(served({ name: ` ${"x".repeat(80)} ` }))?.name.length, 80);
  });
});

describe("The coin client", () => {
  it("reads the purchase it asked for and the balance, as the account", async () => {
    const { coin, calls } = rig((route) =>
      route === CoinRoute.Balance ? ok({ spendable: 1240, purchased: 1000, earned: 240 }) : ok(served()),
    );
    assert.equal((await coin.intent("clx123")).totalCoins, 75);
    assert.equal(await coin.balance(), 1240);
    assert.deepEqual(calls, [
      { route: "/api/coin/intents/clx123", method: "GET", body: undefined, token: TOKEN },
      { route: "/api/coin/balance", method: "GET", body: undefined, token: TOKEN },
    ]);
    const other = rig(() => ok(served({ id: "clx999" })));
    await assert.rejects(other.coin.intent("clx123"), "an answer about another purchase is not this one");
  });

  it("reads the earned coin still on hold and when it is ready, and none for anything it cannot trust", async () => {
    const release = "2026-10-30T12:00:00.000Z";
    const wallet = (body: Record<string, unknown>) => rig(() => ok({ spendable: 12_450, ...body })).coin.wallet();
    assert.deepEqual(await wallet({ earnedHeld: 7500, nextReleaseAt: release }), {
      spendable: 12_450,
      held: { coins: 7500, releaseAt: Date.parse(release) },
    });
    const none: Array<Record<string, unknown>> = [
      { earnedHeld: 0, nextReleaseAt: release },
      { earnedHeld: 7500, nextReleaseAt: null },
      { earnedHeld: 7500 },
      { nextReleaseAt: release },
      { earnedHeld: -1, nextReleaseAt: release },
      { earnedHeld: 1.5, nextReleaseAt: release },
      { earnedHeld: "7500", nextReleaseAt: release },
      { earnedHeld: 7500, nextReleaseAt: "soon" },
      { earnedHeld: 7500, nextReleaseAt: 1_793_000_000_000 },
    ];
    for (const body of none)
      assert.deepEqual(await wallet(body), { spendable: 12_450, held: null }, JSON.stringify(body));
    assert.equal(
      await rig(() => ok({ spendable: 12_450, earnedHeld: 7500, nextReleaseAt: release })).coin.balance(),
      12_450,
    );
  });

  it("answers the plate's balance, or none signed out, with coin off, during an outage or for a broken answer", async () => {
    assert.equal(await rig(() => ok({ spendable: 1240 })).coin.spendableOrNone(), 1240);
    const none: Array<() => GalleryAnswer> = [
      () => ({ status: 404, body: { error: "not_found" } }),
      () => ({ status: 500, body: null }),
      () => ok(null),
      () => ok({ spendable: -1 }),
    ];
    for (const answer of none) assert.equal(await rig(answer).coin.spendableOrNone(), null);
    const signedOut = rig(() => ok({ spendable: 1240 }), "");
    assert.equal(await signedOut.coin.spendableOrNone(), null);
    assert.deepEqual(signedOut.calls, [], "nothing is sent while no account is unlocked");
  });

  it("refuses a balance that is not a count of coin", async () => {
    for (const spendable of [-1, 1.5, "1240", null, Number.NaN]) {
      const { coin } = rig(() => ok({ spendable }));
      await assert.rejects(coin.balance(), String(spendable));
    }
    await assert.rejects(rig(() => ok(null)).coin.balance());
  });

  it("confirms from Studio's own sheet, naming dynamic terms only for a payment the game priced", async () => {
    const { coin, calls } = rig(() => ok({ intentId: "clx123", entitlementId: null, totalCoins: 75, replayed: false }));
    await coin.confirm(intentOf(served()));
    await coin.confirm(intentOf(dynamic()));
    assert.deepEqual(calls, [
      {
        route: "/api/coin/intents/clx123/confirm",
        method: "POST",
        body: { confirmSurface: "native_modal" },
        token: TOKEN,
      },
      {
        route: "/api/coin/intents/clx123/confirm",
        method: "POST",
        body: { confirmSurface: "native_modal", paymentPolicy: "dynamic-payment-v1" },
        token: TOKEN,
      },
    ]);
  });

  it("cancels with no body, and says how the purchase stands after", async () => {
    const { coin, calls } = rig(() => ok(served({ status: "canceled" })));
    assert.equal(await coin.cancel("clx123"), CoinIntentStatus.Canceled);
    assert.deepEqual(calls, [
      { route: "/api/coin/intents/clx123/cancel", method: "POST", body: undefined, token: TOKEN },
    ]);
    const landed = rig(() => ok(served({ status: "succeeded" })));
    assert.equal(
      await landed.coin.cancel("clx123"),
      CoinIntentStatus.Succeeded,
      "a charge that already landed is paid",
    );
    assert.equal(await rig(() => ok({ status: "paid" })).coin.cancel("clx123"), null);
    assert.equal(await rig(() => ok(null)).coin.cancel("clx123"), null);
  });
});

describe("What the coin client refuses to send, and why genex.games refused", () => {
  it("sends nothing for an id that is not one", async () => {
    const hostile = [
      "",
      "../balance",
      "clx/../../admin",
      "clx?x=1",
      "clx#x",
      "c 1",
      "%2e%2e",
      "a".repeat(65),
      42,
      null,
    ];
    const { coin, calls } = rig(() => ok(served()));
    for (const id of hostile) {
      await assert.rejects(coin.intent(id as string), String(id));
      await assert.rejects(coin.cancel(id as string), String(id));
      await assert.rejects(coin.confirm({ ...intentOf(served()), id: id as string }), String(id));
    }
    assert.deepEqual(calls, []);
  });

  it("asks for a sign-in, sending nothing, while no account is unlocked", async () => {
    const { coin, calls, refused } = rig(() => ok(served()), "");
    await assert.rejects(coin.intent("clx123"), SignInNeeded);
    await assert.rejects(coin.balance(), SignInNeeded);
    await assert.rejects(coin.confirm(intentOf(served())), SignInNeeded);
    await assert.rejects(coin.cancel("clx123"), SignInNeeded);
    assert.deepEqual(calls, []);
    assert.deepEqual(refused, []);
  });

  it("ends the sign-in only when a read's token is refused", async () => {
    const reads = rig(() => ({ status: 401, body: { error: "unauthorized" } }));
    await assert.rejects(reads.coin.intent("clx123"), SignInNeeded);
    await assert.rejects(reads.coin.balance(), SignInNeeded);
    assert.deepEqual(reads.refused, [TOKEN, TOKEN]);
    const writes = rig(() => ({ status: 401, body: { error: "confirm_requires_session" } }));
    for (const write of [writes.coin.confirm(intentOf(served())), writes.coin.cancel("clx123")])
      await assert.rejects(write, (error: unknown) => {
        assert.ok(error instanceof CoinRefused);
        assert.deepEqual([error.code, error.status], [CoinFailure.ConfirmRequiresSession, 401]);
        return true;
      });
    assert.deepEqual(writes.refused, [], "genex.games refusing Studio's sheet is not a signed-out account");
  });

  it("says why genex.games refused, by its code, and an outage apart from a refusal", async () => {
    const refusals: Array<[number, unknown, CoinFailure]> = [
      [402, { error: "insufficient_balance" }, CoinFailure.InsufficientBalance],
      [409, { error: "intent_expired" }, CoinFailure.IntentExpired],
      [409, { error: "intent_not_pending" }, CoinFailure.IntentNotPending],
      [409, { error: "payment_confirmation_required" }, CoinFailure.PaymentConfirmationRequired],
      [409, { error: "sku_inactive" }, CoinFailure.SkuInactive],
      [403, { error: "surface_cap" }, CoinFailure.SurfaceCap],
      [403, { error: "forbidden_origin" }, CoinFailure.ForbiddenOrigin],
      [404, { error: "not_your_purchase" }, CoinFailure.NotYourPurchase],
      [404, { error: "intent_not_found" }, CoinFailure.IntentNotFound],
      [404, { error: "project_not_found" }, CoinFailure.ProjectNotFound],
      [403, {}, CoinFailure.Unknown],
      [403, { error: "a_new_rule" }, CoinFailure.Unknown],
      [400, { error: 42 }, CoinFailure.Unknown],
      [429, null, CoinFailure.Unknown],
    ];
    for (const [status, body, code] of refusals) {
      const { coin, refused } = rig(() => ({ status, body }));
      await assert.rejects(coin.confirm(intentOf(served())), (error: unknown) => {
        assert.ok(error instanceof CoinRefused, `${status} ${JSON.stringify(body)}`);
        assert.deepEqual([error.code, error.status], [code, status]);
        return true;
      });
      assert.deepEqual(refused, []);
    }
    const lost = rig(() => ({ status: 404, body: { error: "intent_not_found" } }));
    await assert.rejects(lost.coin.intent("clx123"), CoinRefused);
    for (const status of [500, 502, 503]) {
      const { coin } = rig(() => ({ status, body: { error: "insufficient_balance" } }));
      await assert.rejects(coin.confirm(intentOf(served())), (error: unknown) => {
        assert.ok(!(error instanceof CoinRefused), "an outage is not a refusal: the payment may still land");
        return true;
      });
    }
  });
});

describe("The coin client over the network", () => {
  it("sends the account's token and no Origin or Cookie, as genex.games' native confirm expects", async () => {
    const seen: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }> = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        res.setHeader("content-type", "application/json");
        const answer = req.url?.endsWith("/confirm")
          ? { intentId: "clx123", entitlementId: null, totalCoins: 75, replayed: false }
          : served({ status: "canceled" });
        res.end(JSON.stringify(answer));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as { port: number };
      const coin = playCoin({
        request: networkRequest(globalThis.fetch, `http://127.0.0.1:${port}`),
        token: async () => TOKEN,
        now: () => 0,
      });
      await coin.confirm(intentOf(served()));
      assert.equal(await coin.cancel("clx123"), CoinIntentStatus.Canceled);
      assert.deepEqual(
        seen.map(({ method, url }) => `${method} ${url}`),
        ["POST /api/coin/intents/clx123/confirm", "POST /api/coin/intents/clx123/cancel"],
      );
      for (const { headers } of seen) {
        assert.equal(headers.origin, undefined, "genex.games lets a native confirm through only with no Origin");
        assert.equal(headers.cookie, undefined);
        assert.equal(headers.referer, undefined);
        assert.equal(headers.authorization, `Bearer ${TOKEN}`);
      }
      assert.equal(seen[0]?.headers["content-type"], "application/json");
      assert.deepEqual(JSON.parse(seen[0]?.body ?? ""), { confirmSurface: "native_modal" });
      assert.equal(seen[1]?.body, "", "a cancel carries no body");
      assert.equal(seen[1]?.headers["content-type"], undefined);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
