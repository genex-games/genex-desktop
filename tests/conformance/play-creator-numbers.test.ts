/**
 * A creator's numbers from genex.games: the account's own stats (per-game daily series, read only
 * with its token), Play's Top creators (ranked by games and hours, on a log scale) and the Credits
 * tab (balance, plan, live prices, recent spends and refunds). What the API answers is hostile input:
 * a series of the wrong length, a negative count or a row off Genex's hosts never reaches the page,
 * and a route genex.games does not have yet answers null instead of failing.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fixtureCreatorAnswer } from "../../src/main/dev/fixture-creator.ts";
import { fixturePlayRequest } from "../../src/main/dev/fixture-play.ts";
import { FixtureAccount, fixtureAccountToken } from "../../src/main/dev/fixture-people.ts";
import { CreatorRoute, creatorStats, toCreators, toStats } from "../../src/main/play/creator-stats.ts";
import { CreditsRoute, genexCredits, toPlan, toPrices, toRecent } from "../../src/main/play/credits.ts";
import { type GalleryAnswer, type GalleryRequest, PlayRoute, SignInNeeded } from "../../src/main/play/gallery.ts";
import { CreditKind } from "../../src/shared/play-credits.ts";
import { creatorScore } from "../../src/shared/play-people.ts";
import { statsTotals } from "../../src/shared/play-stats.ts";

const TOKEN = "genex-cli-token";
const COVER = "https://cdn.genex.technology/covers/a.webp";
const ok = (body: unknown): GalleryAnswer => ({ status: 200, body });
const status = (code: number): GalleryAnswer => ({ status: code, body: null });

/** A stats game row over `days` days. */
const gameRow = (slug: string, days: number, extra: Record<string, unknown> = {}) => ({
  slug,
  title: slug.toUpperCase(),
  thumbnailUrl: COVER,
  plays: Array.from({ length: days }, (_, day) => day + 1),
  players: Array.from({ length: days }, () => 1),
  playsBefore: 10,
  playersTotal: 4,
  playersBefore: 3,
  online: 2,
  ...extra,
});

/** Calls kept as they are made, answered by `answers`. */
function rig(answers: (route: string) => GalleryAnswer, { signedIn = true }: { signedIn?: boolean } = {}) {
  const token = signedIn ? TOKEN : undefined;
  const calls: Array<{ route: string; token?: string }> = [];
  let clock = 0;
  const request: GalleryRequest = async (route, init) => {
    calls.push({ route, ...(init.token ? { token: init.token } : {}) });
    return answers(route);
  };
  const deps = { request, token: async () => token, now: () => clock };
  return { creators: creatorStats(deps), credits: genexCredits(deps), calls, advance: (ms: number) => (clock += ms) };
}

describe("the account's stats", () => {
  it("keeps each game whose daily series fits the period, and drops the rest", () => {
    const stats = toStats(
      {
        days: 7,
        endsOn: "2026-10-13",
        games: [
          gameRow("neon-rush", 7),
          gameRow("short", 6),
          gameRow("negative", 7, { plays: [1, 2, 3, -4, 5, 6, 7] }),
          gameRow("Bad Slug", 7),
          gameRow("neon-rush", 7),
          gameRow("off-host", 7, { thumbnailUrl: "https://evil.example/c.png" }),
        ],
        players: 12,
        playersBefore: 9,
        published: 19,
        publishedThisMonth: 2,
      },
      7,
    );
    assert.deepEqual(
      stats?.games.map((game) => [game.slug, game.coverUrl]),
      [
        ["neon-rush", COVER],
        ["off-host", null],
      ],
    );
    assert.equal(stats?.published, 19);
    assert.equal(statsTotals(stats ?? assert.fail()).plays, 56, "the totals are the series' own sum");
  });

  it("is not stats when the period or the last day is not the one asked for", () => {
    assert.equal(toStats({ days: 30, endsOn: "2026-10-13", games: [] }, 7), null);
    assert.equal(toStats({ days: 7, endsOn: "yesterday", games: [] }, 7), null);
  });

  it("asks with the account's token for a known period only, and answers null while genex.games has none", async () => {
    const { creators, calls } = rig((route) => (route.startsWith(CreatorRoute.Stats) ? status(404) : status(500)));
    assert.equal(await creators.stats(30), null);
    assert.deepEqual(calls, [{ route: `${CreatorRoute.Stats}?days=30`, token: TOKEN }]);
    await assert.rejects(creators.stats(14 as 7), /stats period/);
    assert.equal(calls.length, 1, "a period the page does not offer is never asked");
  });

  it("needs the account", async () => {
    const signedOut = rig(() => ok({}), { signedIn: false });
    await assert.rejects(signedOut.creators.stats(7), SignInNeeded);
    assert.equal(signedOut.calls.length, 0);
    const refused = rig(() => status(401));
    await assert.rejects(refused.creators.stats(7), SignInNeeded);
  });
});

describe("Top creators", () => {
  it("ranks by games and hours on a log scale, hours counted double, and needs a published game", () => {
    assert.equal(creatorScore(0, 500), Number.NEGATIVE_INFINITY);
    assert.ok(creatorScore(6, 640) > creatorScore(31, 120), "hours played weigh more than a pile of games");
    assert.ok(creatorScore(19, 420) > creatorScore(1, 420), "games still count");
  });

  it("orders the row by that score, whatever order genex.games sends", () => {
    const creators = toCreators({
      creators: [
        { id: "yuki", name: "Yuki", image: null, games: 31, hours: 120 },
        { id: "ben", name: "Ben", image: null, games: 6, hours: 640 },
        { id: "none", name: "None", image: null, games: 0, hours: 900 },
        { id: "../bad", name: "Bad", games: 3, hours: 3 },
        { id: "omar", name: "Omar", image: null, games: 19, hours: 420 },
        { id: "ben", name: "Ben again", games: 1, hours: 1 },
      ],
    });
    assert.deepEqual(
      creators.map((creator) => creator.id),
      ["omar", "ben", "yuki"],
    );
  });

  it("is read once in a while, public, and null while genex.games does not rank creators", async () => {
    const { creators, calls, advance } = rig(() => status(404));
    assert.equal(await creators.topCreators(), null);
    assert.equal(await creators.topCreators(), null);
    assert.equal(calls.length, 1, "kept a while");
    assert.equal(calls[0]?.token, undefined, "no token on a public read");
    advance(11 * 60_000);
    await creators.topCreators();
    assert.equal(calls.length, 2);
  });
});

describe("the Credits tab", () => {
  it("names the cheapest price of each kind genex.games prices, and nothing it does not", () => {
    assert.deepEqual(
      toPrices({
        lanes: [
          { kind: "model", from: 35 },
          { kind: "character", from: 64 },
          { kind: "character_concept", from: 5 },
          { kind: "image", from: -7 },
          { kind: "music" },
        ],
      }),
      { [CreditKind.Model]: 35, [CreditKind.Character]: 64 },
    );
  });

  it("lists spends and refunds with their game, newest first, and leaves grants out", () => {
    const recent = toRecent({
      transactions: [
        {
          id: "t1",
          amount: -35,
          reason: "debit_generation",
          kind: "model",
          createdAt: "2026-10-13T10:00:00Z",
          game: { title: "Lost Cathedral" },
        },
        { id: "t2", amount: 9, reason: "refund_failed_generation", kind: "texture", createdAt: "2026-10-13T09:00:00Z" },
        { id: "t3", amount: 2000, reason: "plan_grant", createdAt: "2026-10-01T00:00:00Z" },
        { id: "t4", amount: -7, reason: "debit_generation", kind: "lasers", createdAt: "2026-10-12T00:00:00Z" },
        { id: "t5", amount: -1, reason: "debit_generation", createdAt: "not a date" },
      ],
    });
    assert.deepEqual(
      recent.map((entry) => [entry.id, entry.amount, entry.refund, entry.kind, entry.game]),
      [
        ["t1", -35, false, CreditKind.Model, "Lost Cathedral"],
        ["t2", 9, true, CreditKind.Texture, null],
        ["t4", -7, false, null, null],
      ],
    );
  });

  it("says the Pro allowance and when it comes, only for a member", () => {
    assert.deepEqual(toPlan({ member: true, allowance: 2000, resetsAt: "2026-11-01T00:00:00Z" }), {
      allowance: 2000,
      resetsAt: "2026-11-01T00:00:00.000Z",
    });
    assert.equal(toPlan({ member: false }), null);
    assert.equal(toPlan(null), null, "plans off: no plan");
  });

  it("reads everything at once and leaves out what genex.games did not answer", async () => {
    const { credits, calls } = rig((route) => {
      if (route === CreditsRoute.Me) return ok({ balance: 1300, spendable: 1240, unlimited: false });
      if (route === CreditsRoute.Prices) return ok({ lanes: [{ kind: "sfx", from: 2 }] });
      if (route === PlayRoute.Referral) return ok({ inviterBonus: 100 });
      return status(404);
    });
    const read = await credits.credits();
    assert.deepEqual(read, {
      balance: 1240,
      unlimited: false,
      plan: null,
      inviteBonus: 100,
      prices: { [CreditKind.Sound]: 2 },
      recent: [],
    });
    assert.equal(calls.find((call) => call.route === CreditsRoute.Prices)?.token, undefined, "prices are public");
  });

  it("needs the account", async () => {
    const { credits, calls } = rig(() => ok({}), { signedIn: false });
    await assert.rejects(credits.credits(), SignInNeeded);
    assert.equal(calls.length, 0);
  });
});

describe("the fixture account's numbers", () => {
  const items = ["lost-cathedral", "stick-steel"].map((slug, index) => ({
    slug,
    title: slug,
    thumbnailUrl: null,
    playsCount: 2000 + index * 500,
    online: index,
    author: { id: "fx-simeon-m", name: "Simeon M" },
  }));
  const catalog = { games: (authorId: string) => (authorId === "fx-simeon-m" ? items : []) };
  const stats = (account: (typeof FixtureAccount)[keyof typeof FixtureAccount], days = 7) =>
    toStats(
      fixtureCreatorAnswer(`${CreatorRoute.Stats}?days=${days}`, { token: fixtureAccountToken(account) }, catalog)
        ?.body,
      days as 7,
    );

  it("has a busy week, a quiet one, a game two days old, and no games, by account", () => {
    const full = stats(FixtureAccount.Full);
    assert.ok(full && statsTotals(full).plays > 0);
    assert.equal(statsTotals(stats(FixtureAccount.Quiet) ?? assert.fail()).plays, 0);
    const fresh = stats(FixtureAccount.Fresh) ?? assert.fail();
    assert.equal(fresh.games.length, 1);
    assert.equal(fresh.games[0]?.playsBefore, 0, "nothing before a new game");
    assert.deepEqual(fresh.games[0]?.plays.slice(0, 5), [0, 0, 0, 0, 0]);
    assert.equal(stats(FixtureAccount.New)?.games.length, 0);
    assert.equal(stats(FixtureAccount.Full, 90)?.games[0]?.plays.length, 90);
  });

  it("answers the stats route through the fixture launch's requests, beside the account's own routes", async () => {
    const token = fixtureAccountToken(FixtureAccount.Full);
    const answer = await fixturePlayRequest(`${CreatorRoute.Stats}?days=7`, { method: "GET", token });
    assert.equal(answer.status, 200);
    assert.ok(toStats(answer.body, 7), "a week of stats");
    assert.equal((await fixturePlayRequest(CreditsRoute.Me, { method: "GET", token })).status, 200);
  });

  it("answers stats and credits signed in only, Top creators and prices to anyone", () => {
    assert.equal(fixtureCreatorAnswer(`${CreatorRoute.Stats}?days=7`, {}, catalog)?.status, 401);
    assert.equal(fixtureCreatorAnswer(CreditsRoute.Me, {}, catalog)?.status, 401);
    assert.equal(fixtureCreatorAnswer(CreatorRoute.TopCreators, {}, catalog)?.status, 200);
    assert.equal(fixtureCreatorAnswer(CreditsRoute.Prices, {}, catalog)?.status, 200);
    assert.equal(fixtureCreatorAnswer(PlayRoute.Feed, {}, catalog), null, "the gallery's routes are not its");
  });
});
