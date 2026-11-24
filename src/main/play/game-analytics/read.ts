/**
 * A game's analytics from genex.games, which only the game's creator ever sees: its reports, its
 * events as they arrive, its campaign links and its funnels, each read or written with the Genex
 * account's token. genex.games computes every number; this client asks, checks the answer and
 * hands it on.
 *
 * How a read ends is told apart, because the page says something different for each: genex.games
 * does not serve analytics yet, the game is not there (or not this account's), the game has no such
 * report, or here it is. An answer that cannot be read is none of those: it throws, so a broken
 * answer never shows as "not served yet" or as zeros. Nothing is kept between calls, so a second
 * account on the same computer never sees the first one's numbers. Electron-free, like the gallery.
 */
import {
  type AnalyticsRead,
  AnalyticsWriteRefusal,
  type CampaignLink,
  type CampaignTags,
  type EventFunnel,
  type EventFunnelDraft,
  type EventOrigin,
  type EventsStatus,
  type GameReportAnswer,
  type GameReportQuery,
  ReadKind,
} from "../../../shared/game-analytics.ts";
import { AnalyticsSaveRefusal } from "../../../shared/game-analytics-asks.ts";
import { CodedError } from "../../../shared/errors.ts";
import { t } from "../../../shared/i18n.ts";
import type { StatsPeriod } from "../../../shared/play-stats.ts";
import {
  type GalleryAnswer,
  type GalleryDeps,
  GalleryError,
  HTTP_UNAUTHORIZED,
  isRecord,
  SignInNeeded,
} from "../gallery.ts";
import { campaignTagsOf, funnelDraftOf, originOf, periodOf, reportQueryOf, savedIdOf, slugOf } from "./asked.ts";
import { toEventsStatus } from "./events-status.ts";
import { toEventFunnel } from "./funnels.ts";
import { toCampaignLink, toCampaignLinks } from "./links.ts";
import { toReportAnswer } from "./reports.ts";
import { AnalyticsRoute, eventsStatusRoute, linksRoute, reportRoute } from "./routes.ts";

const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
/** A success that does not answer what was asked reads as a bad gateway, as the gallery's do. */
const BAD_GATEWAY = 502;
const MESSAGE = {
  Limit: () => t("This game keeps no more of these. Remove one first."),
} as const;

/** Why a read has no value. */
type NoValue = Exclude<ReadKind, typeof ReadKind.Ready>;

/**
 * What a 404 means: the code its body names when that is "no such game" or "no such report", else
 * (no body, no code, a code the app does not know) a genex.games that serves no analytics yet.
 */
function refusalOf(body: unknown): NoValue {
  const code = isRecord(body) ? body.code : undefined;
  return code === ReadKind.NoGame || code === ReadKind.NoReport ? code : ReadKind.Unavailable;
}

const succeeded = (status: number): boolean => status >= 200 && status < 300;

/** A successful answer's body read by `parse`; a refusal, or a body `parse` cannot read, throws. */
function readWith<Value>(route: string, answer: GalleryAnswer, parse: (body: unknown) => Value | null): Value {
  if (!succeeded(answer.status)) throw new GalleryError(route, answer.status);
  const value = parse(answer.body);
  if (value === null) throw new GalleryError(route, BAD_GATEWAY);
  return value;
}

/** Whether a save was refused because the game keeps no more of its kind: a 409 whose body says so. */
const pastLimit = (answer: GalleryAnswer): boolean =>
  answer.status === HTTP_CONFLICT && isRecord(answer.body) && answer.body.code === AnalyticsWriteRefusal.Limit;

/** What a save answered, read by `parse`; a refusal past the game's limit throws with a code the page reads. */
function savedWith<Value>(route: string, answer: GalleryAnswer, parse: (body: unknown) => Value | null): Value {
  if (pastLimit(answer)) throw new CodedError(AnalyticsSaveRefusal.Limit, MESSAGE.Limit());
  return readWith(route, answer, parse);
}

/** What the client runs on: the gallery's calls, and the website Play links to, where a game's links point. */
export interface GameAnalyticsDeps extends GalleryDeps {
  web: string;
}

/** The game analytics client over `deps`: one call per `StudioApi` method. */
export function gameAnalytics(deps: GameAnalyticsDeps) {
  const { request, token, web } = deps;
  const local = deps.localImages === true;

  /** One call as the account: none unlocked, or a token genex.games rejects, is a sign-in needed. */
  const signed = async (
    route: string,
    init: { method: "GET" | "POST" | "DELETE"; body?: unknown },
  ): Promise<GalleryAnswer> => {
    const current = await token();
    if (!current) throw new SignInNeeded();
    const answer = await request(route, { ...init, token: current });
    if (answer.status === HTTP_UNAUTHORIZED) throw new SignInNeeded();
    return answer;
  };

  /** A read: its value, or why genex.games has none. */
  const read = async <Value>(route: string, parse: (body: unknown) => Value | null): Promise<AnalyticsRead<Value>> => {
    const answer = await signed(route, { method: "GET" });
    if (answer.status === HTTP_NOT_FOUND) return { kind: refusalOf(answer.body) };
    return { kind: ReadKind.Ready, value: readWith(route, answer, parse) };
  };

  /** One report of a game over a period. */
  const report = async (query: GameReportQuery): Promise<AnalyticsRead<GameReportAnswer>> => {
    const asked = reportQueryOf(query);
    return read(reportRoute(asked), (body) => toReportAnswer(body, asked, local));
  };

  /** A game's events as they arrive from the published game or from Studio's preview. */
  const events = async (slug: string, origin: EventOrigin): Promise<AnalyticsRead<EventsStatus>> => {
    const game = slugOf(slug);
    const from = originOf(origin);
    return read(eventsStatusRoute(game, from), (body) => toEventsStatus(body, game, from, local));
  };

  /** A game's saved campaign links, with what each brought over `days`. */
  const links = async (slug: string, days: StatsPeriod): Promise<AnalyticsRead<CampaignLink[]>> => {
    const game = slugOf(slug);
    return read(linksRoute(game, periodOf(days)), (body) => toCampaignLinks(body, { web, slug: game }));
  };

  /** Save a campaign link; the link as genex.games keeps it. */
  const saveLink = async (slug: string, tags: CampaignTags): Promise<CampaignLink> => {
    const game = slugOf(slug);
    const route = AnalyticsRoute.links(game);
    const body = campaignTagsOf(tags);
    const answer = await signed(route, { method: "POST", body });
    return savedWith(route, answer, (saved) => toCampaignLink(saved, { web, slug: game }));
  };

  /** Remove a saved campaign link. */
  const removeLink = async (slug: string, id: string): Promise<void> => {
    const route = AnalyticsRoute.link(slugOf(slug), savedIdOf(id));
    const answer = await signed(route, { method: "DELETE" });
    if (!succeeded(answer.status)) throw new GalleryError(route, answer.status);
  };

  /** Save a funnel; the funnel with the players who reached each step. */
  const saveFunnel = async (slug: string, draft: EventFunnelDraft): Promise<EventFunnel> => {
    const route = AnalyticsRoute.funnels(slugOf(slug));
    const body = funnelDraftOf(draft);
    return savedWith(route, await signed(route, { method: "POST", body }), toEventFunnel);
  };

  /** Remove a saved funnel. */
  const removeFunnel = async (slug: string, id: string): Promise<void> => {
    const route = AnalyticsRoute.funnel(slugOf(slug), savedIdOf(id));
    const answer = await signed(route, { method: "DELETE" });
    if (!succeeded(answer.status)) throw new GalleryError(route, answer.status);
  };

  return { report, events, links, saveLink, removeLink, saveFunnel, removeFunnel };
}

/** The game analytics client as `gameAnalytics` makes it. */
export type GameAnalytics = ReturnType<typeof gameAnalytics>;
