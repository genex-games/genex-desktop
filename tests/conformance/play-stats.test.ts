/**
 * A creator's stats as the app shows them, and the rest of the profile and Friends pages' pure
 * decisions: every number derived from the same per-game daily series (totals, the chart's line,
 * the table), how a number moved ("New" with nothing before, a dash with nothing at all), what the
 * profile's 7-day strip shows in each state, the people store's reads of stats and Top creators,
 * the stats page's place in Play's pages, the friends stack's faces, the charts' axes, the credits
 * scramble, and the generated avatar's painter geometry and mix. No DOM.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { avatarRecipe, AvatarEyes, AvatarGear, type AvatarRecipe } from "../../src/shared/avatar-recipe.ts";
import { AvatarStyle, type PlayMe } from "../../src/shared/play-people.ts";
import type { PlayGame } from "../../src/shared/play.ts";
import {
  ChangeKind,
  changeOf,
  dailyTotals,
  dayBefore,
  gameRows,
  type PlayGameStats,
  type PlayStats,
  periodDays,
  statsTotals,
} from "../../src/shared/play-stats.ts";
import { avatarGeometry, roundRobin, stillTime } from "../../src/renderer/avatars/avatar-painter.ts";
import { openness } from "../../src/renderer/avatars/draw-kit.ts";
import { mixOf } from "../../src/renderer/play/avatar-mix.ts";
import { SCRAMBLE_FRAMES, SHARD_CELLS, scrambled } from "../../src/renderer/play/credits-shard.ts";
import { dayAt, labelledDays, niceMax } from "../../src/renderer/play/stats-chart.ts";
import { StripKind, stripView } from "../../src/renderer/play/stats-view.ts";
import { createPeopleStore, LoadStatus, type StatsEntry } from "../../src/renderer/state/people.ts";
import { GenexAccountStatus } from "../../src/shared/genex-account.ts";
import { backFromProfile, initialPlay, PlayPage, profileShown, statsShown } from "../../src/renderer/state/play.ts";

/** A game's stats over a week. */
const game = (slug: string, plays: number[], fields: Partial<PlayGameStats> = {}): PlayGameStats => ({
  slug,
  title: slug,
  coverUrl: null,
  plays,
  players: plays.map((count) => Math.ceil(count / 3)),
  playsBefore: 0,
  playersTotal: 0,
  playersBefore: 0,
  playingNow: 0,
  ...fields,
});

/** A week's stats. */
const week = (games: PlayGameStats[], fields: Partial<PlayStats> = {}): PlayStats => ({
  days: 7,
  endsOn: "2026-10-13",
  games,
  players: 0,
  playersBefore: 0,
  published: games.length,
  publishedThisMonth: 0,
  ...fields,
});

/** A dashboard game. */
const card = (slug: string, plays: number, online: number | null = null): PlayGame => ({
  id: slug,
  slug,
  title: slug.toUpperCase(),
  description: "",
  coverUrl: null,
  clipUrl: null,
  multiplayer: online !== null,
  plays,
  online,
  author: { id: "me", name: "Rab", imageUrl: null },
  remixable: true,
  assetKind: null,
});

const entry = (stats: PlayStats | null, fields: Partial<StatsEntry> = {}): StatsEntry => ({
  status: LoadStatus.Ready,
  stats,
  unavailable: stats === null,
  ...fields,
});

describe("how a number moved", () => {
  it("is a whole percentage up or down, flat when it held, New with nothing before, and none with nothing at all", () => {
    assert.deepEqual(changeOf(120, 100), { kind: ChangeKind.Up, percent: 20 });
    assert.deepEqual(changeOf(92, 100), { kind: ChangeKind.Down, percent: -8 });
    assert.deepEqual(changeOf(100, 100), { kind: ChangeKind.Flat, percent: 0 });
    assert.deepEqual(changeOf(14, 0), { kind: ChangeKind.New, percent: 0 });
    assert.deepEqual(changeOf(0, 0), { kind: ChangeKind.None, percent: 0 });
  });
});

describe("a period's numbers", () => {
  const stats = week(
    [
      game("sandstorm", [10, 12, 9, 14, 20, 30, 25], { playsBefore: 100, playingNow: 4, playersTotal: 40 }),
      game("neon-rush", [0, 0, 0, 0, 0, 6, 8], { playingNow: 1, playersTotal: 5 }),
      game("quiet-harbor", [0, 0, 0, 0, 0, 0, 0], { playsBefore: 30 }),
    ],
    { players: 44, playersBefore: 50 },
  );

  it("agree: the totals are the rows' sums, and the chart's line is the days' sums", () => {
    const totals = statsTotals(stats);
    const rows = gameRows(stats);
    assert.equal(
      totals.plays,
      rows.reduce((sum, row) => sum + row.plays, 0),
    );
    assert.equal(
      totals.plays,
      dailyTotals(stats, "plays").reduce((sum, day) => sum + day, 0),
    );
    assert.deepEqual(dailyTotals(stats, "plays"), [10, 12, 9, 14, 20, 36, 33]);
    assert.deepEqual(totals.playsChange, changeOf(134, 130));
    assert.deepEqual(totals.playersChange, { kind: ChangeKind.Down, percent: -12 });
  });

  it("say who is playing now and where, the busiest game first", () => {
    const totals = statsTotals(stats);
    assert.equal(totals.playingNow, 5);
    assert.equal(totals.liveGame, "sandstorm");
    assert.equal(totals.liveOthers, 1);
  });

  it("rank the table by plays, and call a game with nothing before it New", () => {
    const rows = gameRows(stats);
    assert.deepEqual(
      rows.map((row) => [row.game.slug, row.change.kind]),
      [
        ["sandstorm", ChangeKind.Up],
        ["neon-rush", ChangeKind.New],
        ["quiet-harbor", ChangeKind.Down],
      ],
    );
  });

  it("name each day of the period, ending today", () => {
    assert.equal(dayBefore("2026-10-13", 6), "2026-10-07");
    assert.deepEqual(periodDays(stats), [
      "2026-10-07",
      "2026-10-08",
      "2026-10-09",
      "2026-10-10",
      "2026-10-11",
      "2026-10-12",
      "2026-10-13",
    ]);
  });
});

describe("the profile's last 7 days", () => {
  const games = [card("sandstorm", 9000, 2), card("lantern-run", 400)];

  it("invites the first game when there is none, whatever the stats say", () => {
    assert.equal(stripView(entry(week([])), []).kind, StripKind.NoGames);
    assert.equal(stripView(undefined, []).kind, StripKind.NoGames);
  });

  it("waits while the first read is on its way", () => {
    assert.equal(stripView(undefined, games).kind, StripKind.Loading);
    assert.equal(
      stripView(entry(null, { status: LoadStatus.Loading, unavailable: false }), games).kind,
      StripKind.Loading,
    );
  });

  it("shows the plays in total while genex.games has no daily stats", () => {
    assert.deepEqual(stripView(entry(null), games), { kind: StripKind.Totals, plays: 9400, playingNow: 2 });
  });

  it("is honest zeros in a quiet week, with the most played game's link to share", () => {
    const quiet = week([game("sandstorm", [0, 0, 0, 0, 0, 0, 0], { playsBefore: 80 })]);
    const view = stripView(entry(quiet), games);
    assert.equal(view.kind, StripKind.Quiet);
    assert.equal(view.kind === StripKind.Quiet && view.share?.slug, "sandstorm");
  });

  it("is the numbers with their change, and New for a new game without a players' change beside it", () => {
    const busy = week([game("sandstorm", [5, 5, 5, 5, 5, 5, 5], { playsBefore: 25 })], {
      players: 9,
      playersBefore: 6,
    });
    const view = stripView(entry(busy), games);
    assert.equal(view.kind, StripKind.Numbers);
    if (view.kind !== StripKind.Numbers) return;
    assert.equal(view.plays, 35);
    assert.deepEqual(view.playsChange, { kind: ChangeKind.Up, percent: 40 });
    assert.deepEqual(view.playersChange, { kind: ChangeKind.Up, percent: 50 });
    const fresh = stripView(entry(week([game("neon-rush", [0, 0, 0, 0, 0, 6, 8])], { players: 9 })), games);
    assert.ok(fresh.kind === StripKind.Numbers && fresh.playsChange.kind === ChangeKind.New);
    assert.ok(fresh.kind === StripKind.Numbers && fresh.playersChange === null);
  });

  it("says when the stats could not be read", () => {
    assert.equal(
      stripView(entry(null, { status: LoadStatus.Failed, unavailable: false }), games).kind,
      StripKind.Failed,
    );
  });
});

describe("the people store's numbers", () => {
  const me: PlayMe = {
    id: "me",
    name: "Rab",
    handle: null,
    imageUrl: null,
    avatarVariant: 0,
    pro: false,
    joinedAt: null,
    avatarStyle: AvatarStyle.Generated,
    photoUrl: null,
    avatarVariantKept: false,
    handleChosen: null,
  };
  /** A store over an API that answers what the test says. */
  function store(answers: { stats?: () => Promise<PlayStats | null>; creators?: () => Promise<null> } = {}) {
    const calls: string[] = [];
    const api = {
      playMe: async () => me,
      playRename: async () => me,
      playAvatar: async () => me,
      playAvatarStyle: async () => ({ ...me, avatarStyle: AvatarStyle.Photo }),
      playAvatarVariant: async () => assert.fail("not regenerated"),
      playProfile: async () => assert.fail("not read"),
      playFriends: async () => assert.fail("not read"),
      playFriend: async () => assert.fail("not read"),
      playPeople: async () => assert.fail("not read"),
      playVisibility: async () => assert.fail("not read"),
      playStats: async (days: number) => {
        calls.push(`stats ${days}`);
        return (answers.stats ?? (async () => week([])))();
      },
      playCreators: async () => {
        calls.push("creators");
        return (answers.creators ?? (async () => null))();
      },
      playCredits: async () => assert.fail("not read"),
      storeCoins: async () => assert.fail("not read"),
      playSetHandle: async () => assert.fail("no nickname saved"),
      genexAccount: async () => ({ status: GenexAccountStatus.SignedIn }),
      genexSignIn: async () => assert.fail("not signed in"),
      genexCancelSignIn: async () => assert.fail("not cancelled"),
      genexSignOut: async () => assert.fail("not signed out"),
    };
    return { people: createPeopleStore(api, null), calls };
  }

  it("reads stats only signed in, once a period unless forced, and marks a period genex.games has none for", async () => {
    const { people, calls } = store({ stats: async () => null });
    await people.loadStats(7);
    assert.deepEqual(calls, [], "signed out: nothing read");
    await people.loadMe();
    await people.loadStats(7);
    await people.loadStats(7);
    assert.deepEqual(calls, ["stats 7"]);
    assert.equal(people.getState().stats[7]?.unavailable, true);
    await people.loadStats(7, { force: true });
    assert.equal(calls.length, 2);
  });

  it("keeps the last stats when a read fails", async () => {
    let fail = false;
    const { people } = store({
      stats: async () => {
        if (fail) throw new Error("offline");
        return week([game("a", [1, 1, 1, 1, 1, 1, 1])]);
      },
    });
    await people.loadMe();
    await people.loadStats(7);
    fail = true;
    await people.loadStats(7, { force: true });
    assert.equal(people.getState().stats[7]?.status, LoadStatus.Failed);
    assert.equal(people.getState().stats[7]?.stats?.games.length, 1);
  });

  it("reads Top creators once, and switches the avatar's style", async () => {
    const { people, calls } = store();
    await people.loadCreators();
    await people.loadCreators();
    assert.deepEqual(calls, ["creators"]);
    assert.equal(people.getState().creators.list, null);
    await people.loadMe();
    await people.setAvatarStyle(AvatarStyle.Photo);
    assert.equal(people.getState().me?.avatarStyle, AvatarStyle.Photo);
  });
});

describe("the stats page among Play's pages", () => {
  it("opens from the account's profile and Back returns to that profile, then where it came from", () => {
    const profile = profileShown({ ...initialPlay(), view: { page: PlayPage.Friends } }, "me");
    const stats = statsShown(profile);
    assert.deepEqual(stats.view, { page: PlayPage.Stats, userId: "me", from: PlayPage.Friends });
    assert.deepEqual(backFromProfile(stats).view, profile.view);
    assert.equal(backFromProfile(backFromProfile(stats)).view.page, PlayPage.Friends);
  });

  it("only opens from a profile", () => {
    const shelf = initialPlay();
    assert.equal(statsShown(shelf), shelf);
  });
});

describe("the stats charts' axes", () => {
  it("round the top up to 1, 2, 2.5 or 5 times a power of ten", () => {
    assert.equal(niceMax(0), 10);
    assert.equal(niceMax(7), 10);
    assert.equal(niceMax(180), 200);
    assert.equal(niceMax(230), 250);
    assert.equal(niceMax(4100), 5000);
  });

  it("date every day of a week with room, else the ends and a few between", () => {
    assert.deepEqual(labelledDays(7, 600), [0, 1, 2, 3, 4, 5, 6]);
    assert.deepEqual(labelledDays(7, 200), [0, 3, 6]);
    assert.deepEqual(labelledDays(30, 900), [0, 10, 19, 29]);
    assert.deepEqual(labelledDays(1, 900), [0]);
  });

  it("find the day under the pointer, held to the period", () => {
    assert.equal(dayAt(46, 656, 7), 0);
    assert.equal(dayAt(646, 656, 7), 6);
    assert.equal(dayAt(-50, 656, 7), 0);
    assert.equal(dayAt(9000, 656, 7), 6);
  });
});

describe("the credits shard", () => {
  it("is the site's shard, its pixels landing in a shuffled order within half a second", () => {
    assert.equal(SHARD_CELLS.length, 54);
    const delays = new Set(SHARD_CELLS.map((cell) => cell.delay));
    assert.ok(Math.max(...delays) <= 14 * 35 && delays.size > 10);
  });

  it("scrambles a number's digits, locking them in from the left, and keeps its commas", () => {
    assert.equal(scrambled("1,240", SCRAMBLE_FRAMES), "1,240");
    const first = scrambled("1,240", 0);
    assert.equal(first.length, 5);
    assert.equal(first[1], ",");
    assert.notEqual(first, "1,240");
    assert.ok(scrambled("1,240", 6).startsWith("1,2"), "most of it has locked in by then");
  });
});

describe("the generated avatar on screen", () => {
  it("fills a small box with its body, and leaves room for gear in a large one", () => {
    assert.deepEqual(avatarGeometry(48, true), { cx: 24, cy: 24, rad: 24 });
    assert.deepEqual(avatarGeometry(300, false), { cx: 150, cy: 165, rad: 120 });
  });

  it("holds still with its eyes open", () => {
    for (let index = 0; index < 400; index++) {
      const recipe = avatarRecipe(`still-${index}`);
      assert.equal(openness(recipe, stillTime(recipe)), 1, recipe.body);
    }
  });

  it("paints at most a frame's budget, round-robin from where the last frame stopped", () => {
    const all = Array.from({ length: 10 }, (_, index) => index);
    assert.deepEqual(roundRobin(all, 8, 4), [8, 9, 0, 1]);
    assert.deepEqual(roundRobin([1, 2], 5, 4), [1, 2]);
  });

  it("names what it is made of: body, eyes, how block eyes look, and gear when there is some", () => {
    const blocks: AvatarRecipe = { ...avatarRecipe("rab neba"), eyes: AvatarEyes.Blocks, gear: AvatarGear.Scar };
    assert.deepEqual(mixOf(blocks), ["Galaxy", "Blocks", "fury", "Scar"]);
    const plain: AvatarRecipe = { ...blocks, eyes: AvatarEyes.Mono, gear: AvatarGear.None };
    assert.deepEqual(mixOf(plain), ["Galaxy", "Mono eye"]);
  });
});
