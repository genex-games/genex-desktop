/**
 * A creator's numbers from genex.games: the account's own stats (per-game daily series, read only
 * with its token), Play's Top creators (in the order genex.games ranks them) and the Credits
 * tab (balance, plan, live prices, recent spends and refunds). What the API answers is hostile input:
 * a series of the wrong length, a negative count or a row off Genex's hosts never reaches the page,
 * and a route genex.games does not have yet answers null instead of failing.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fixtureCreatorAnswer } from "../../src/main/dev/fixture-creator.ts";
import { createFixtureGameAnalytics } from "../../src/main/dev/fixture-game-analytics/index.ts";
import { fixturePlayRequest } from "../../src/main/dev/fixture-play.ts";
import { FixtureAccount, fixtureAccountToken } from "../../src/main/dev/fixture-people.ts";
import { CreatorRoute, creatorStats, toCreators, toStats } from "../../src/main/play/creator-stats.ts";
import { CreditsRoute, genexCredits, toPlan, toPrices, toRecent } from "../../src/main/play/credits.ts";
import { type GalleryAnswer, type GalleryRequest, PlayRoute, SignInNeeded } from "../../src/main/play/gallery.ts";
import { toReportAnswer } from "../../src/main/play/game-analytics/reports.ts";
import { reportRoute } from "../../src/main/play/game-analytics/routes.ts";
import { GameReport, OverviewMetric } from "../../src/shared/game-analytics.ts";
import { GenexOperation } from "../../src/shared/genex.ts";
import { canAfford, CreditKind, operationPrice } from "../../src/shared/play-credits.ts";
import { STATS_PERIODS, type StatsPeriod, statsTotals } from "../../src/shared/play-stats.ts";

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
  it("keeps the order genex.games ranks them in, which counts more than games and hours", () => {
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
      ["yuki", "ben", "omar"],
      "as sent, without anyone who has no published game, a bad id or a second row",
    );
  });

  it("shows at most 24 creators, the first genex.games sent", () => {
    const sent = Array.from({ length: 30 }, (_, place) => ({
      id: `maker-${place}`,
      name: `Maker ${place}`,
      games: 1,
      hours: place,
    }));
    const creators = toCreators({ creators: sent });
    assert.equal(creators.length, 24);
    assert.deepEqual(
      creators.map((creator) => creator.id),
      sent.slice(0, 24).map((creator) => creator.id),
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

/** The fixture account's two games, as the fixture catalog lists them. */
const items = ["lost-cathedral", "stick-steel"].map((slug, index) => ({
  slug,
  title: slug,
  thumbnailUrl: null,
  playsCount: 2000 + index * 500,
  online: index,
  author: { id: "fx-simeon-m", name: "Simeon M" },
}));
const catalog = { games: (authorId: string) => (authorId === "fx-simeon-m" ? items : []) };

describe("the fixture account's numbers", () => {
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
    assert.deepEqual(fresh.games[0]?.plays.slice(0, 4), [0, 0, 0, 0], "nothing before it was published, two days ago");
    assert.ok(
      fresh.games[0]?.plays.slice(4).every((plays) => plays > 0),
      "plays on the day it was published and since",
    );
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

describe("the fixture account's stats beside its games' analytics", () => {
  /** The fixture's Overview of a game, as its analytics page reads it: the real route, the real parser. */
  function overviewOf(
    analytics: ReturnType<typeof createFixtureGameAnalytics>,
    token: string,
    query: { slug: string; report: typeof GameReport.Overview; days: StatsPeriod },
  ) {
    const answered = analytics.answer(reportRoute(query), { method: "GET", token }, catalog);
    const overview = toReportAnswer(answered?.body, query, true);
    return overview?.report === GameReport.Overview ? overview : assert.fail(`${query.slug}: no Overview`);
  }

  it("gives a game's row on the Stats page the numbers its analytics page shows, for every account and period", () => {
    const now = Date.parse("2026-11-17T12:04:00.000Z");
    const analytics = createFixtureGameAnalytics({ now: () => now });
    const accounts = [FixtureAccount.Full, FixtureAccount.Quiet, FixtureAccount.Fresh];
    const asked = accounts.flatMap((account) => STATS_PERIODS.map((days) => ({ account, days })));
    for (const { account, days } of asked) {
      const token = fixtureAccountToken(account);
      const body = fixtureCreatorAnswer(`${CreatorRoute.Stats}?days=${days}`, { token }, catalog, () => now)?.body;
      const read = toStats(body, days) ?? assert.fail(`${account} over ${days} days is not stats`);
      assert.equal(read.endsOn, "2026-11-17", "the period ends today, in UTC");
      assert.equal(read.games.length, account === FixtureAccount.Fresh ? 1 : 2);
      for (const game of read.games) {
        const about = `${account}: ${game.slug} over ${days} days`;
        const overview = overviewOf(analytics, token, { slug: game.slug, report: GameReport.Overview, days });
        const plays = overview.data.series[OverviewMetric.Plays] ?? assert.fail(`${about}: no plays`);
        const players = overview.data.series[OverviewMetric.Players] ?? assert.fail(`${about}: no players`);
        assert.deepEqual(game.plays, plays.daily, `${about}: plays per day`);
        assert.deepEqual(game.players, players.daily, `${about}: players per day`);
        assert.equal(game.playsBefore, plays.before, `${about}: plays before`);
        assert.equal(game.playersTotal, players.now, `${about}: players`);
        assert.equal(game.playersBefore, players.before, `${about}: players before`);
        assert.equal(game.playingNow, overview.game.playingNow, `${about}: playing now`);
        assert.equal(game.title, overview.game.title, about);
      }
    }
  });

  it("keeps the stats answer's own shape, and counts a person who plays two games once", () => {
    const token = fixtureAccountToken(FixtureAccount.Full);
    const body = fixtureCreatorAnswer(`${CreatorRoute.Stats}?days=30`, { token }, catalog)?.body as {
      games: Record<string, unknown>[];
      players: number;
      playersBefore: number;
      published: number;
      publishedThisMonth: number;
    };
    assert.deepEqual(Object.keys(body).sort(), [
      "days",
      "endsOn",
      "games",
      "players",
      "playersBefore",
      "published",
      "publishedThisMonth",
    ]);
    assert.deepEqual(Object.keys(body.games[0] ?? {}).sort(), [
      "online",
      "players",
      "playersBefore",
      "playersTotal",
      "plays",
      "playsBefore",
      "slug",
      "thumbnailUrl",
      "title",
    ]);
    const total = (key: string) => body.games.reduce((sum, game) => sum + Number(game[key]), 0);
    assert.ok(body.players > 0 && body.players < total("playersTotal"), "fewer people than the games' players summed");
    assert.ok(body.playersBefore > 0 && body.playersBefore < total("playersBefore"));
    assert.deepEqual([body.published, body.publishedThisMonth], [2, 2]);
  });

  it("refuses a period the Stats page does not offer", () => {
    const token = fixtureAccountToken(FixtureAccount.Full);
    assert.equal(fixtureCreatorAnswer(`${CreatorRoute.Stats}?days=14`, { token }, catalog)?.status, 400);
    assert.equal(fixtureCreatorAnswer(CreatorRoute.Stats, { token }, catalog)?.status, 400);
  });
});

describe("prices where credits are spent", () => {
  const prices = { [CreditKind.Model]: 35, [CreditKind.Sound]: 2, [CreditKind.CharacterFinalize]: 29 };

  it("prices an operation from the list by its kind, and nothing it cannot name exactly", () => {
    assert.equal(operationPrice(GenexOperation.Model, prices), 35);
    assert.equal(operationPrice(GenexOperation.Sfx, prices), 2);
    assert.equal(operationPrice(GenexOperation.CharacterFinalize, prices), 29);
    assert.equal(operationPrice(GenexOperation.Character, prices), null, "concept or one-shot: priced apart");
    assert.equal(operationPrice(GenexOperation.Image, prices), null, "a kind the list left out");
    assert.equal(operationPrice("constructor", prices), null, "never an inherited name");
    assert.equal(operationPrice(GenexOperation.Model, null), null);
    assert.equal(operationPrice(undefined, prices), null);
  });

  it("pays for a price from the balance; an unlimited account and an unread balance always do", () => {
    assert.equal(canAfford({ balance: 35, unlimited: false }, 35), true);
    assert.equal(canAfford({ balance: 18, unlimited: false }, 35), false);
    assert.equal(canAfford({ balance: 0, unlimited: true }, 35), true);
    assert.equal(canAfford({ balance: null, unlimited: false }, 35), true);
    assert.equal(canAfford({ balance: 0, unlimited: false }, null), false, "no price: only an empty balance is short");
    assert.equal(canAfford({ balance: 1, unlimited: false }, null), true);
  });

  it("gives the fixture account the balance a launch names, and the character steps' prices", () => {
    const me = () =>
      fixtureCreatorAnswer(
        CreditsRoute.Me,
        { token: fixtureAccountToken(FixtureAccount.Full) },
        {
          games: () => [],
        },
      )?.body as { spendable: number; unlimited: boolean };
    const before = process.env.STUDIO_FIXTURE_CREDITS;
    try {
      delete process.env.STUDIO_FIXTURE_CREDITS;
      assert.deepEqual([me().spendable, me().unlimited], [1240, false]);
      for (const [named, left] of [
        ["low", 18],
        ["zero", 0],
      ] as const) {
        process.env.STUDIO_FIXTURE_CREDITS = named;
        assert.deepEqual([me().spendable, me().unlimited], [left, false], named);
      }
      process.env.STUDIO_FIXTURE_CREDITS = "unlimited";
      assert.equal(me().unlimited, true);
    } finally {
      if (before === undefined) delete process.env.STUDIO_FIXTURE_CREDITS;
      else process.env.STUDIO_FIXTURE_CREDITS = before;
    }
    const listed = toPrices(fixtureCreatorAnswer(CreditsRoute.Prices, {}, { games: () => [] })?.body);
    assert.deepEqual([listed[CreditKind.CharacterPreview], listed[CreditKind.CharacterFinalize]], [41, 29]);
  });
});
