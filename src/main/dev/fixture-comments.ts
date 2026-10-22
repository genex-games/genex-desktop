/**
 * Play's comments in a fixture profile: each fixture game's comments made here, the shapes the API
 * serves, newest first in pages, so the viewer's Comments can be read, written and deleted with no
 * socket. One game has more than a page; the fixture account writes and deletes its own.
 */
import { HOUR_MS } from "../../shared/duration.ts";
import { COMMENT_MAX } from "../../shared/play-comments.ts";
import type { GalleryAnswer, GalleryRequest } from "../play/gallery.ts";
import { fixtureAccountOf, fixtureMeNamed, fixturePersonNamed } from "./fixture-people.ts";

/** A comment as the API serves one. */
interface FixtureComment {
  id: string;
  body: string;
  createdAt: string;
  author: ReturnType<typeof fixturePersonNamed> | ReturnType<typeof fixtureMeNamed>;
}

/** The fixture's own words for its comments, in turn. */
const LINES = [
  "The lighting in the second hall is unreal",
  "Took me three tries to find the hidden door",
  "Please add a checkpoint before the bell tower",
  "Played this with my brother all evening",
  "The music fits perfectly",
  "How do you get past the flooded crypt?",
];
const NAMES = ["Mira Kovač", "Tomás Reyes", "Kenji Mori", "Juno Park", "Simeon M"];
/** The most comments one page answers with, as the API caps it. */
const PAGE_MAX = 50;
/** The fixture's own clock for its comments: the newest was written then, each older one seven hours before the next. */
const NEWEST = Date.parse("2026-10-17T09:00:00.000Z");
const APART_MS = 7 * HOUR_MS;

/** A game's seeded comments: `count` of them, newest first. */
function seeded(gameId: string, count: number): FixtureComment[] {
  return Array.from({ length: count }, (_, at) => ({
    id: `${gameId}c${String(count - at).padStart(3, "0")}`,
    body: LINES[at % LINES.length] ?? "",
    createdAt: new Date(NEWEST - at * APART_MS).toISOString(),
    author: fixturePersonNamed(NAMES[at % NAMES.length] ?? "Simeon M"),
  }));
}

/** How many comments each fixture game starts with, by its gallery id (`fixture-play.ts`); the rest have none. */
const SEEDS: Record<string, number> = { fx0000: 26, fx0001: 1 };
const threads = new Map<string, FixtureComment[]>();
let written = 0;

const ok = (body: unknown, status = 200): GalleryAnswer => ({ status, body });
const SIGNED_OUT: GalleryAnswer = { status: 401, body: null };
const NOT_FOUND: GalleryAnswer = { status: 404, body: null };
const BAD_REQUEST: GalleryAnswer = { status: 400, body: null };

/** A game's comments as they stand in this launch. */
function thread(gameId: string): FixtureComment[] {
  let list = threads.get(gameId);
  if (!list) {
    list = seeded(gameId, SEEDS[gameId] ?? 0);
    threads.set(gameId, list);
  }
  return list;
}

/** How many comments a fixture game has, for its page facts. */
export const fixtureCommentCount = (gameId: string): number => thread(gameId).length;

/** One page of a game's comments, from the cursor on. */
function page(gameId: string, query: URLSearchParams): GalleryAnswer {
  const list = thread(gameId);
  const limit = Math.min(PAGE_MAX, Number(query.get("limit")) || PAGE_MAX);
  const cursor = query.get("cursor");
  const start = cursor ? list.findIndex((comment) => comment.id === cursor) + 1 : 0;
  const items = list.slice(start, start + limit);
  const last = items.at(-1);
  return ok({ items, nextCursor: start + limit < list.length && last ? last.id : null });
}

/** A new comment by the fixture account. */
function post(gameId: string, body: unknown): GalleryAnswer {
  const text = typeof body === "object" && body !== null ? (body as { body?: unknown }).body : undefined;
  const clean = typeof text === "string" ? text.trim() : "";
  if (!clean || clean.length > COMMENT_MAX) return BAD_REQUEST;
  written += 1;
  const comment = {
    id: `${gameId}n${written}`,
    body: clean,
    createdAt: new Date().toISOString(),
    author: fixtureMeNamed(),
  };
  thread(gameId).unshift(comment);
  return ok({ comment }, 201);
}

/** Delete the fixture account's own comment. */
function remove(gameId: string, commentId: string): GalleryAnswer {
  const list = thread(gameId);
  const at = list.findIndex((comment) => comment.id === commentId);
  if (at < 0) return NOT_FOUND;
  if (list[at]?.author.id !== fixtureMeNamed().id) return { status: 403, body: null };
  list.splice(at, 1);
  return ok({ ok: true });
}

const ROUTE = /^\/api\/projects\/([^/]+)\/comments(?:\/([^/]+))?$/;

/** The answer to a comments route, or null for any other route. */
export const fixtureCommentsAnswer = (route: string, init: Parameters<GalleryRequest>[1]): GalleryAnswer | null => {
  const [pathname = "", search = ""] = route.split("?");
  const match = ROUTE.exec(pathname);
  if (!match) return null;
  const gameId = decodeURIComponent(match[1] ?? "");
  const commentId = match[2] === undefined ? null : decodeURIComponent(match[2]);
  const method = init.method ?? "GET";
  if (method === "GET" && commentId === null) return page(gameId, new URLSearchParams(search));
  if (!fixtureAccountOf(init.token)) return SIGNED_OUT;
  if (method === "POST" && commentId === null) return post(gameId, init.body);
  if (method === "DELETE" && commentId !== null) return remove(gameId, commentId);
  return NOT_FOUND;
};
