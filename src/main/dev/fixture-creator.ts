/**
 * A fixture account's numbers: its stats for a period (a believable week of plays for the full
 * account; games that went silent two weeks ago, or a game two days old, for the quiet and fresh
 * ones), Play's Top creators from the fixture catalog, and the Credits tab's balance
 * (`STUDIO_FIXTURE_CREDITS=low|zero|unlimited` names another), plan, prices and recent spends. Made
 * in the API's shapes, deterministic for a day, so the strip, the stats page, the row and the tab
 * can be checked with no socket. Each game's stats are its analytics sample's own
 * (`fixture-game-analytics/sample.ts`), so its row on the Stats page and its analytics page agree.
 */
import { isStatsPeriod, type StatsPeriod } from "../../shared/play-stats.ts";
import { CreatorRoute } from "../play/creator-stats.ts";
import { CreditsRoute } from "../play/credits.ts";
import type { GalleryAnswer } from "../play/gallery.ts";
import { gameSample, ownSamples, type SampleSource } from "./fixture-game-analytics/sample.ts";
import { FixtureAccount, type FixtureCatalog, fixtureAccountOf, fixturePeople } from "./fixture-people.ts";

/** The share of the games' players summed who are different people: some play more than one game. */
const DIFFERENT_PEOPLE = 0.93;
/** The price list as genex.games answers it, the default call's price first in each lane. */
const LANES = [
  ["model", 35],
  ["model_rig", 29],
  ["model_animation", 12],
  ["image", 7],
  ["video", 23],
  ["texture", 9],
  ["sfx", 2],
  ["music", 27],
  ["voice", 2],
  ["character", 64],
  ["character_preview", 41],
  ["character_finalize", 29],
] as const;

/** The balances a launch may name with `STUDIO_FIXTURE_CREDITS`; anything else is the full balance. */
const FixtureCredits = { Low: "low", Zero: "zero", Unlimited: "unlimited" } as const;
/** The fixture account's balance, and the few credits of a low one: less than a 3D model costs. */
const FULL_BALANCE = 1240;
const LOW_BALANCE = 18;

/** The fixture account's balance as `/api/credits/me` answers it, by `STUDIO_FIXTURE_CREDITS`. */
function fixtureBalance(): { balance: number; reserved: number; spendable: number; unlimited: boolean } {
  const named = process.env.STUDIO_FIXTURE_CREDITS;
  if (named === FixtureCredits.Unlimited) return { balance: 0, reserved: 0, spendable: 0, unlimited: true };
  const left = { [FixtureCredits.Low]: LOW_BALANCE, [FixtureCredits.Zero]: 0 }[named ?? ""] ?? FULL_BALANCE;
  return { balance: left, reserved: 0, spendable: left, unlimited: false };
}

const ok = (body: unknown): GalleryAnswer => ({ status: 200, body });
const BAD_REQUEST: GalleryAnswer = { status: 400, body: { error: "bad_request" } };
const SIGNED_OUT: GalleryAnswer = { status: 401, body: null };

interface FixtureItem {
  slug: string;
  title: string;
  thumbnailUrl: string | null;
  playsCount: number;
  online: number | null;
  author: { id: string; name: string };
}

/**
 * One game's row: its plays and players per day, and the period before as one number, as the
 * game's analytics sample has them over the same days.
 */
function gameRow(source: SampleSource, days: StatsPeriod, now: number) {
  const { game, plays, players } = gameSample(source, days, now);
  return {
    slug: game.slug,
    title: game.title,
    thumbnailUrl: game.coverUrl,
    plays: plays.daily,
    players: players.daily,
    playsBefore: plays.before,
    playersTotal: players.now,
    playersBefore: players.before,
    online: game.playingNow,
  };
}

/** The account's stats for `days` ending on the UTC day of `now`, as `/api/users/me/stats` answers. */
function stats(days: StatsPeriod, account: FixtureAccount, catalog: FixtureCatalog, now: number): GalleryAnswer {
  const games = ownSamples(account, catalog).map((source) => gameRow(source, days, now));
  const people = (total: number): number => Math.round(total * DIFFERENT_PEOPLE);
  return ok({
    days,
    endsOn: new Date(now).toISOString().slice(0, 10),
    games,
    players: people(games.reduce((sum, game) => sum + game.playersTotal, 0)),
    playersBefore: people(games.reduce((sum, game) => sum + game.playersBefore, 0)),
    published: games.length,
    publishedThisMonth: account === FixtureAccount.Fresh ? 1 : Math.min(2, games.length),
  });
}

/**
 * Top creators from the fixture catalog, best first as genex.games sends them: their games and
 * hours played in the last 30 days.
 */
function topCreators(catalog: FixtureCatalog): GalleryAnswer {
  const creators = fixturePeople()
    .map((person) => {
      const games = catalog.games(person.id) as FixtureItem[];
      const plays = games.reduce((sum, game) => sum + game.playsCount, 0);
      return { ...person, games: games.length, hours: Math.round((plays * 11) / 60) };
    })
    .filter((creator) => creator.games > 0)
    .toSorted((a, b) => b.hours - a.hours);
  return ok({ creators });
}

/** The first day of next month (UTC), when a Pro allowance comes. */
function nextMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

/** The Credits tab's reads for the fixture account. */
function credits(pathname: string): GalleryAnswer | null {
  if (pathname === CreditsRoute.Me) return ok(fixtureBalance());
  if (pathname === CreditsRoute.Plan)
    return ok({ member: true, plan: { name: "Pro" }, status: "active", allowance: 2000, resetsAt: nextMonth() });
  if (pathname === CreditsRoute.Ledger) {
    const at = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
    const row = (id: string, amount: number, reason: string, kind: string, hours: number, title: string) => ({
      id,
      amount,
      reason,
      kind,
      balanceAfter: 1240,
      createdAt: at(hours),
      game: { slug: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"), title },
    });
    return ok({
      transactions: [
        row("fx-tx-1", -35, "debit_generation", "model", 2, "Lost Cathedral"),
        row("fx-tx-2", -7, "debit_generation", "image", 5, "SANDSTORM"),
        { ...row("fx-tx-3", 9, "refund_failed_generation", "texture", 6, "SANDSTORM") },
        row("fx-tx-4", -64, "debit_generation", "character", 30, "Stick & Steel"),
        { id: "fx-tx-5", amount: 2000, reason: "plan_grant", kind: null, balanceAfter: 1400, createdAt: at(200) },
      ],
      nextCursor: null,
    });
  }
  return null;
}

/** The public price list, as `/api/credits/prices` answers it. */
const prices = (): GalleryAnswer =>
  ok({
    anchorUsdCentsPerCredit: 1,
    marginMultiplier: 1.4,
    lanes: LANES.map(([kind, from]) => ({ kind, from, options: [{ label: "Default", credits: from }] })),
  });

/**
 * A fixture answer for the creator and credits routes, or null when the route is none of them.
 * Stats and credits need a fixture account; Top creators and prices are public. Stats are for one
 * of the periods the Stats page offers, ending on the UTC day of `now`.
 */
export function fixtureCreatorAnswer(
  route: string,
  init: { token?: string },
  catalog: FixtureCatalog,
  now: () => number = Date.now,
): GalleryAnswer | null {
  const [pathname = "", query = ""] = route.split("?");
  if (pathname === CreatorRoute.TopCreators) return topCreators(catalog);
  if (pathname === CreditsRoute.Prices) return prices();
  const account = fixtureAccountOf(init.token);
  const mine = pathname === CreatorRoute.Stats || Object.values(CreditsRoute).some((path) => path === pathname);
  if (!mine) return null;
  if (!account) return SIGNED_OUT;
  if (pathname !== CreatorRoute.Stats) return credits(pathname);
  const days = Number(new URLSearchParams(query).get("days"));
  return isStatsPeriod(days) ? stats(days, account, catalog, now()) : BAD_REQUEST;
}
