/**
 * A game's saved campaign links as genex.games answers them: one link after a save, and
 * `{ links }` for the list. Read with the helpers in `kit.ts`; a tag, an address or a count that
 * cannot be trusted leaves its link out. A tag is the creator's own words and an address carries
 * them, so both lose the characters that turn text around or control a terminal. The creator
 * pastes a link where their audience clicks it, so a link points only at the game's own page on
 * the website Play links to, and a short link only at that website: any other leaves the link out,
 * or reads as no short link.
 */
import { CAMPAIGN_LINKS_MAX, CAMPAIGN_TAG_MAX, type CampaignLink } from "../../../shared/game-analytics.ts";
import { playPageUrl } from "../../../shared/play.ts";
import { isCursor, isRecord } from "../gallery.ts";
import { count, isoDay, line, type Read, rateOrNull, rows, whole } from "./kit.ts";

/** The longest a link's address may read: five tags at their limit fit several times over. */
const ADDRESS_MAX = 2048;

/** Where a game's links may point: the website Play links to (`origins.ts`), and the game's slug there. */
export interface LinkPlace {
  web: string;
  slug: string;
}

/** A tag a link must have: one clean line within the limit. */
const tag: Read<string> = (value) => line(value, CAMPAIGN_TAG_MAX);

/** A tag a link may leave out: null when it did (or sent it empty), undefined when it is not a tag. */
const optionalTag: Read<string | null> = (value) => {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  return value.trim() === "" ? null : tag(value);
};

/** An address on the website `web` with no sign-in in it, as a browser writes it. */
function webAddress(value: unknown, web: string): URL | undefined {
  const text = line(value, ADDRESS_MAX);
  if (text === undefined || !URL.canParse(text) || !URL.canParse(web)) return undefined;
  const url = new URL(text);
  const plain = url.username === "" && url.password === "";
  return plain && url.origin === new URL(web).origin ? url : undefined;
}

/** The game's own page on the website, with whatever tags it carries. */
const pageAddress =
  (place: LinkPlace): Read<string> =>
  (value) => {
    const url = webAddress(value, place.web);
    const page = webAddress(playPageUrl(place.web, place.slug), place.web);
    return url && url.pathname === page?.pathname ? url.href : undefined;
  };

/** The id a link is removed by: one main would send back (`savedIdOf`). */
const savedId: Read<string> = (value) => (isCursor(value) ? value : undefined);

/** One saved link; undefined when a part of it cannot be trusted. A short link off the website is none. */
const campaignLink =
  (place: LinkPlace): Read<CampaignLink> =>
  (value) => {
    if (!isRecord(value)) return undefined;
    return whole({
      id: savedId(value.id),
      source: tag(value.source),
      medium: tag(value.medium),
      campaign: tag(value.campaign),
      content: optionalTag(value.content),
      term: optionalTag(value.term),
      url: pageAddress(place)(value.url),
      shortUrl: webAddress(value.shortUrl, place.web)?.href ?? null,
      createdOn: isoDay(value.createdOn),
      newVisitors: count(value.newVisitors),
      newPlayers: count(value.newPlayers),
      day7: rateOrNull(value.day7),
    });
  };

/** One saved campaign link of the game at `place`, or null when `value` is not one. */
export function toCampaignLink(value: unknown, place: LinkPlace): CampaignLink | null {
  return campaignLink(place)(value) ?? null;
}

/**
 * The links of a `{ links }` answer about the game at `place`, at most `CAMPAIGN_LINKS_MAX` and one
 * per id, or null when `body` carries no list. A link that does not read is left out.
 */
export function toCampaignLinks(body: unknown, place: LinkPlace): CampaignLink[] | null {
  if (!isRecord(body)) return null;
  return rows(body.links, CAMPAIGN_LINKS_MAX, campaignLink(place), (link) => link.id) ?? null;
}
