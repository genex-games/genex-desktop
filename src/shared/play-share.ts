/**
 * The links Play hands out: a person's profile on genex.games, and X's post page carrying a link.
 * Each builder takes the website's origin, genex.games' unless a development profile points Play
 * at another (`main/play/origins.ts`; the renderer reads it at bootstrap).
 */
import type { PlayPerson } from "./play-people.ts";

/** X's page for writing a post, filled in from its query. */
const X_POST = "https://x.com/intent/post";
/** The scheme a link box leaves out. */
const SCHEME = /^https?:\/\//;

/** A person's profile on the website at `web`: `/@<handle>`, or `/u/<id>` while they have no handle. */
export function profileUrl(web: string, person: Pick<PlayPerson, "id" | "handle">): string {
  return person.handle ? `${web}/@${person.handle}` : `${web}/u/${encodeURIComponent(person.id)}`;
}

/** X's post page with `text` written and `link` attached. */
export function xPostUrl(text: string, link: string): string {
  return `${X_POST}?text=${encodeURIComponent(text)}&url=${encodeURIComponent(link)}`;
}

/** A link as a box shows it, without its scheme: `genex.games/@rabneba/invite`. */
export const linkWithoutScheme = (link: string): string => link.replace(SCHEME, "");
