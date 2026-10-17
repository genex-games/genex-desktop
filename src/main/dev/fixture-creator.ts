/**
 * A fixture account's numbers: its stats for a period (a believable week of plays for the full
 * account; honest zeros, or a game two days old, for the quiet and fresh ones), Play's Top creators
 * from the fixture catalog, and the Credits tab's balance, plan, prices and recent spends. Made in
 * the API's shapes, deterministic for a day, so the strip, the stats page, the row and the tab can be
 * checked with no socket.
 */
import { CreatorRoute } from "../play/creator-stats.ts";
import { CreditsRoute } from "../play/credits.ts";
import type { GalleryAnswer } from "../play/gallery.ts";
import {
  FixtureAccount,
  type FixtureCatalog,
  fixtureAccountOf,
  fixtureOwnGames,
  fixturePeople,
} from "./fixture-people.ts";

/** How a fixture week goes: a little busier towards the weekend. */
const WEEK_RHYTHM = [0.92, 0.88, 0.95, 1, 1.08, 1.22, 1.18] as const;
/** About this share of a day's plays are different people. */
const PLAYERS_SHARE = 0.38;
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
] as const;

const ok = (body: unknown): GalleryAnswer => ({ status: 200, body });
const SIGNED_OUT: GalleryAnswer = { status: 401, body: null };

interface FixtureItem {
  slug: string;
  title: string;
  thumbnailUrl: string | null;
  playsCount: number;
  online: number | null;
  author: { id: string; name: string };
}

/** A repeatable 0..1 number for `index` under `seed`. */
function wobble(seed: number, index: number): number {
  const x = Math.sin(seed * 12.9898 + index * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/** A game's plays per day over `days` days, ending today: its catalog plays spread over a season. */
function dailyPlays(game: FixtureItem, seed: number, days: number, account: FixtureAccount): number[] {
  const base = Math.max(3, game.playsCount / 90);
  return Array.from({ length: days }, (_, day) => {
    const ageDays = days - 1 - day;
    if (account === FixtureAccount.Quiet && ageDays < days / 2) return 0;
    if (account === FixtureAccount.Fresh && ageDays > 1) return 0;
    const growth = 1 + (0.3 * day) / days;
    const rhythm = WEEK_RHYTHM[(day + seed) % WEEK_RHYTHM.length] ?? 1;
    return Math.max(0, Math.round(base * growth * rhythm * (0.88 + wobble(seed, day) * 0.24)));
  });
}

/** One game's row: the period's days and the period before as one number. */
function gameRow(game: FixtureItem, index: number, days: number, account: FixtureAccount) {
  const both = dailyPlays(game, index + 3, days * 2, account);
  const plays = both.slice(days);
  const before = both.slice(0, days);
  const players = plays.map((count) => Math.round(count * PLAYERS_SHARE));
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  const quiet = account === FixtureAccount.Quiet;
  return {
    slug: game.slug,
    title: game.title,
    thumbnailUrl: game.thumbnailUrl,
    plays,
    players,
    playsBefore: sum(before),
    playersTotal: Math.round(sum(players) * 0.82),
    playersBefore: Math.round(sum(before) * PLAYERS_SHARE * 0.8),
    online: quiet ? 0 : (game.online ?? (index === 0 ? 2 : 0)),
  };
}

/** The account's stats for `days`, as `/api/users/me/stats` answers. */
function stats(days: number, account: FixtureAccount, catalog: FixtureCatalog): GalleryAnswer {
  const games = (fixtureOwnGames(account, catalog) as FixtureItem[]).map((game, index) =>
    gameRow(game, index, days, account),
  );
  const players = Math.round(games.reduce((sum, game) => sum + game.playersTotal, 0) * 0.93);
  const playersBefore = Math.round(games.reduce((sum, game) => sum + game.playersBefore, 0) * 0.93);
  return ok({
    days,
    endsOn: new Date().toISOString().slice(0, 10),
    games,
    players,
    playersBefore,
    published: games.length,
    publishedThisMonth: account === FixtureAccount.Fresh ? 1 : Math.min(2, games.length),
  });
}

/** Top creators from the fixture catalog: their games and hours played in the last 30 days. */
function topCreators(catalog: FixtureCatalog): GalleryAnswer {
  const creators = fixturePeople()
    .map((person) => {
      const games = catalog.games(person.id) as FixtureItem[];
      const plays = games.reduce((sum, game) => sum + game.playsCount, 0);
      return { ...person, games: games.length, hours: Math.round((plays * 11) / 60) };
    })
    .filter((creator) => creator.games > 0);
  return ok({ creators });
}

/** The first day of next month (UTC), when a Pro allowance comes. */
function nextMonth(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

/** The Credits tab's reads for the fixture account. */
function credits(pathname: string): GalleryAnswer | null {
  if (pathname === CreditsRoute.Me) return ok({ balance: 1240, reserved: 0, spendable: 1240, unlimited: false });
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
 * Stats and credits need a fixture account; Top creators and prices are public.
 */
export function fixtureCreatorAnswer(
  route: string,
  init: { token?: string },
  catalog: FixtureCatalog,
): GalleryAnswer | null {
  const [pathname = "", query = ""] = route.split("?");
  if (pathname === CreatorRoute.TopCreators) return topCreators(catalog);
  if (pathname === CreditsRoute.Prices) return prices();
  const account = fixtureAccountOf(init.token);
  const mine = pathname === CreatorRoute.Stats || Object.values(CreditsRoute).some((path) => path === pathname);
  if (!mine) return null;
  if (!account) return SIGNED_OUT;
  if (pathname === CreatorRoute.Stats) return stats(Number(new URLSearchParams(query).get("days")), account, catalog);
  return credits(pathname);
}
