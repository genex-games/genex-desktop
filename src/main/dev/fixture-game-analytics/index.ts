/**
 * A game's analytics in a fixture profile: genex.games' answers to every analytics route, made here
 * in the contract's shapes (`shared/game-analytics.ts`) from one made-up game per slug (`sample.ts`),
 * so the page, its tabs and its empty states can be checked with no socket. The fixture account's
 * own games answer; anyone else's is "no such game", and Installs for a game with no app build is
 * "no such report". A question is held to the same checks main holds the renderer's to. A saved
 * link or funnel lives for the launch: it shows on the next read and is gone at the next launch.
 * Saves answer as the contract says: tags already saved answer the link that has them, and a save
 * past `CAMPAIGN_LINKS_MAX` or `FUNNELS_MAX` (made-up and saved together) is a 409 "limit".
 */
import {
  AnalyticsWriteRefusal,
  CAMPAIGN_LINKS_MAX,
  type CampaignLink,
  type CampaignTags,
  campaignUrl,
  type EventFunnel,
  type EventFunnelDraft,
  FUNNELS_MAX,
  GameReport,
  type GameReportMap,
  type GameReportOptions,
  type GameReportQuery,
  isGameReport,
  ReadKind,
} from "../../../shared/game-analytics.ts";
import { PLAY_ORIGIN } from "../../../shared/play.ts";
import type { StatsPeriod } from "../../../shared/play-stats.ts";
import type { GalleryAnswer } from "../../play/gallery.ts";
import { campaignTagsOf, funnelDraftOf, originOf, periodOf, reportQueryOf } from "../../play/game-analytics/asked.ts";
import { analyticsPathOf } from "../../play/game-analytics/routes.ts";
import { type FixtureCatalog, takenAccount } from "../fixture-people.ts";
import { fixtureAcquisition } from "./fixture-acquisition.ts";
import { fixtureEngagement } from "./fixture-engagement.ts";
import { fixtureEvents } from "./fixture-events.ts";
import { fixtureEventsStatus } from "./fixture-events-status.ts";
import { fixtureInstalls } from "./fixture-installs.ts";
import { fixtureLinks } from "./fixture-links.ts";
import { fixtureOverview } from "./fixture-overview.ts";
import { fixtureRetention } from "./fixture-retention.ts";
import { fixtureRevenue } from "./fixture-revenue.ts";
import { type GameSample, gameSample, ownSamples, type SampleSource } from "./sample.ts";

/** The period a save or a removal is answered over, and the events as they arrive: neither names one. */
const PLAIN_DAYS: StatsPeriod = 30;
/** How a saved funnel fills in: the share of the period's players who start it, and who go on at each step. */
const FUNNEL_STARTED = 0.8;
const FUNNEL_GOES_ON = 0.55;

const ok = (body: unknown): GalleryAnswer => ({ status: 200, body });
const BAD_REQUEST: GalleryAnswer = { status: 400, body: { error: "bad_request" } };
const SIGNED_OUT: GalleryAnswer = { status: 401, body: null };
/** A route genex.games does not have: no code, as a platform that serves no analytics answers. */
const NOT_FOUND: GalleryAnswer = { status: 404, body: null };
/** A save past what a game keeps. */
const PAST_LIMIT: GalleryAnswer = { status: 409, body: { code: AnalyticsWriteRefusal.Limit } };
const refused = (code: typeof ReadKind.NoGame | typeof ReadKind.NoReport): GalleryAnswer => ({
  status: 404,
  body: { code },
});

/** Each report's maker. */
const REPORTS = {
  [GameReport.Overview]: fixtureOverview,
  [GameReport.Acquisition]: fixtureAcquisition,
  [GameReport.Retention]: fixtureRetention,
  [GameReport.Engagement]: fixtureEngagement,
  [GameReport.Events]: fixtureEvents,
  [GameReport.Revenue]: fixtureRevenue,
  [GameReport.Installs]: fixtureInstalls,
} as const satisfies {
  [Report in GameReport]: (sample: GameSample, options: GameReportOptions) => Partial<GameReportMap[Report]>;
};

/** What the launch saved and removed. */
interface Launch {
  now(): number;
  /** Each game's links saved during the launch, newest first. */
  links: Map<string, CampaignLink[]>;
  /** Each game's funnels saved during the launch, newest first: what was written and the id it got. */
  funnels: Map<string, Array<{ id: string; draft: EventFunnelDraft }>>;
  /** The ids of the made-up links and funnels the launch removed. */
  removed: Set<string>;
  /** How many links and funnels the launch saved, for their ids. */
  saved: number;
}

/** One call about one of the account's games. */
interface Asked {
  launch: Launch;
  game: SampleSource;
  method: string;
  query: URLSearchParams;
  body: unknown;
}

/** `read`'s value, or null when the question does not pass main's own checks. */
function checked<Value>(read: () => Value): Value | null {
  try {
    return read();
  } catch {
    return null;
  }
}

/** A saved funnel over a period: fewer players at each step. */
function funnelOf(id: string, draft: EventFunnelDraft, sample: GameSample): EventFunnel {
  const started = Math.round(sample.players.now * FUNNEL_STARTED);
  return {
    id,
    name: draft.name,
    withinDays: draft.withinDays,
    steps: draft.steps.map((step, index) => ({ ...step, players: Math.round(started * FUNNEL_GOES_ON ** index) })),
    typicalDay: started > 0 ? Math.min(draft.withinDays, 2) : null,
  };
}

/** A game's funnels: the launch's own first, then the made-up ones it did not remove. */
function funnelsOf(launch: Launch, sample: GameSample, made: readonly EventFunnel[]): EventFunnel[] {
  const saved = (launch.funnels.get(sample.game.slug) ?? []).map(({ id, draft }) => funnelOf(id, draft, sample));
  return [...saved, ...made.filter((funnel) => !launch.removed.has(funnel.id))];
}

/** A game's links: the launch's own first, then the made-up ones it did not remove. */
function linksOf(launch: Launch, sample: GameSample): CampaignLink[] {
  const made = fixtureLinks(sample).links ?? [];
  const saved = launch.links.get(sample.game.slug) ?? [];
  return [...saved, ...made.filter((link) => !launch.removed.has(link.id))];
}

/** A link's five tags as one key: two links with the same key are one link. */
const tagsKey = (tags: CampaignTags): string =>
  JSON.stringify([tags.source, tags.medium, tags.campaign, tags.content, tags.term]);

/** One report: its data from the game's sample, in the envelope every report arrives in. */
function reportAnswer({ launch, game, query }: Asked, report: GameReport): GalleryAnswer {
  const options = Object.fromEntries(query);
  const asked = checked(() => reportQueryOf({ ...options, slug: game.slug, report, days: Number(query.get("days")) }));
  if (!asked) return BAD_REQUEST;
  if (report === GameReport.Installs && !game.hasAppBuild) return refused(ReadKind.NoReport);
  const sample = gameSample(game, asked.days, launch.now());
  return ok({ report, game: sample.game, window: sample.window, data: reportData(launch, sample, asked) });
}

/** A report's data; the Events report's funnels are the launch's. */
function reportData(launch: Launch, sample: GameSample, asked: GameReportQuery): object {
  if (asked.report !== GameReport.Events) return REPORTS[asked.report](sample, asked);
  const events = fixtureEvents(sample, asked);
  return { ...events, funnels: funnelsOf(launch, sample, events.funnels ?? []) };
}

/** The game's events as they arrive. */
function eventsAnswer({ launch, game, query }: Asked): GalleryAnswer {
  const origin = checked(() => originOf(query.get("origin")));
  if (!origin) return BAD_REQUEST;
  const now = launch.now();
  return ok(fixtureEventsStatus(gameSample(game, PLAIN_DAYS, now), origin, now));
}

/** The game's links over a period, or a save: the link that already has the tags, a new one, or the limit. */
function linksAnswer({ launch, game, method, query, body }: Asked): GalleryAnswer {
  if (method === "GET") {
    const days = checked(() => periodOf(Number(query.get("days"))));
    return days ? ok({ links: linksOf(launch, gameSample(game, days, launch.now())) }) : BAD_REQUEST;
  }
  const tags = method === "POST" ? checked(() => campaignTagsOf(body)) : null;
  if (!tags) return method === "POST" ? BAD_REQUEST : NOT_FOUND;
  const listed = linksOf(launch, gameSample(game, PLAIN_DAYS, launch.now()));
  const already = listed.find((link) => tagsKey(link) === tagsKey(tags));
  if (already) return ok(already);
  if (listed.length >= CAMPAIGN_LINKS_MAX) return PAST_LIMIT;
  launch.saved += 1;
  const link: CampaignLink = {
    ...tags,
    id: `fx-link-${launch.saved}`,
    url: campaignUrl(`${PLAY_ORIGIN.web}/${game.slug}`, tags),
    shortUrl: `${PLAY_ORIGIN.web}/go/fx${launch.saved}`,
    createdOn: new Date(launch.now()).toISOString().slice(0, 10),
    // Saved a moment ago: it has brought nobody yet.
    newVisitors: 0,
    newPlayers: 0,
    day7: null,
  };
  launch.links.set(game.slug, [link, ...(launch.links.get(game.slug) ?? [])]);
  return ok(link);
}

/** A new funnel saved for the launch, unless the game keeps no more. */
function funnelAnswer({ launch, game, method, body }: Asked): GalleryAnswer {
  const draft = method === "POST" ? checked(() => funnelDraftOf(body)) : null;
  if (!draft) return method === "POST" ? BAD_REQUEST : NOT_FOUND;
  const sample = gameSample(game, PLAIN_DAYS, launch.now());
  if (funnelsOf(launch, sample, fixtureEvents(sample, {}).funnels ?? []).length >= FUNNELS_MAX) return PAST_LIMIT;
  launch.saved += 1;
  const id = `fx-funnel-${launch.saved}`;
  launch.funnels.set(game.slug, [{ id, draft }, ...(launch.funnels.get(game.slug) ?? [])]);
  return ok(funnelOf(id, draft, sample));
}

/** Take a link out: one the launch saved is forgotten, a made-up one is left out from now on. */
function removeLink({ launch, game }: Asked, id: string): GalleryAnswer {
  const sample = gameSample(game, PLAIN_DAYS, launch.now());
  if (!linksOf(launch, sample).some((link) => link.id === id)) return NOT_FOUND;
  launch.links.set(
    game.slug,
    (launch.links.get(game.slug) ?? []).filter((link) => link.id !== id),
  );
  launch.removed.add(id);
  return ok({});
}

/** Take a funnel out, the same way. */
function removeFunnel({ launch, game }: Asked, id: string): GalleryAnswer {
  const sample = gameSample(game, PLAIN_DAYS, launch.now());
  const made = fixtureEvents(sample, {}).funnels ?? [];
  if (!funnelsOf(launch, sample, made).some((funnel) => funnel.id === id)) return NOT_FOUND;
  launch.funnels.set(
    game.slug,
    (launch.funnels.get(game.slug) ?? []).filter((funnel) => funnel.id !== id),
  );
  launch.removed.add(id);
  return ok({});
}

/**
 * The answer to what follows a game's analytics folder: `reports/<report>`, `links`, `funnels/<id>`.
 * An id is read as it is written: the ones handed out here need no escaping.
 */
function gameAnswer(asked: Asked, rest: string): GalleryAnswer {
  const [folder = "", name = "", ...deeper] = rest.split("/");
  const reads = asked.method === "GET";
  const removes = asked.method === "DELETE" && name !== "" && deeper.length === 0;
  if (rest === "events/status") return reads ? eventsAnswer(asked) : NOT_FOUND;
  if (rest === "links") return linksAnswer(asked);
  if (rest === "funnels") return funnelAnswer(asked);
  if (folder === "links" && removes) return removeLink(asked, name);
  if (folder === "funnels" && removes) return removeFunnel(asked, name);
  const report = folder === "reports" && reads && deeper.length === 0 ? name : "";
  return isGameReport(report) ? reportAnswer(asked, report) : NOT_FOUND;
}

/** A fixture launch's game analytics: its answers, and what it saved, for as long as the launch lasts. */
export function createFixtureGameAnalytics(options: { now?: () => number } = {}) {
  const launch: Launch = {
    now: options.now ?? Date.now,
    links: new Map(),
    funnels: new Map(),
    removed: new Set(),
    saved: 0,
  };

  /**
   * The answer to an analytics route, or null when the route is not one of them. Signed out (or
   * ended) every one is a 401, as the stats route is; a game that is not the account's is a 404
   * that says so.
   */
  const answer = (
    route: string,
    init: { method?: string; body?: unknown; token?: string },
    catalog: FixtureCatalog,
  ): GalleryAnswer | null => {
    const [pathname = "", search = ""] = route.split("?");
    const path = analyticsPathOf(pathname);
    if (!path) return null;
    const account = takenAccount(init.token);
    if (!account) return SIGNED_OUT;
    const game = ownSamples(account, catalog).find((own) => own.slug === path.slug);
    if (!game) return refused(ReadKind.NoGame);
    const query = new URLSearchParams(search);
    return gameAnswer({ launch, game, method: init.method ?? "GET", query, body: init.body }, path.rest);
  };

  return { answer };
}
