/**
 * A Play game's comments on genex.games: a page of them (anyone may read), a new one and deleting one
 * (both as the unlocked Genex account). Main names the game by its id and every comment by the id
 * genex.games gave it; nothing the renderer sends becomes part of an address unchecked. Electron-free:
 * the request, the token and who the account is come in as deps.
 */
import { isAccountId } from "../../shared/play-people.ts";
import {
  COMMENT_MAX,
  COMMENTS_PAGE,
  commentBody,
  type PlayComment,
  type PlayCommentAuthor,
  type PlayCommentsPage,
} from "../../shared/play-comments.ts";
import { isAvatarVariant } from "../../shared/avatar-recipe.ts";
import {
  type GalleryDeps,
  GalleryError,
  HTTP_UNAUTHORIZED,
  imageUrl,
  isCursor,
  isRecord,
  readRoute,
  SignInNeeded,
  text,
} from "./gallery.ts";

/** How much of a commenter's name the list keeps. */
const NAME_MAX = 120;
/** genex.games' own cap on a comment, with room for an older client's longer one. */
const BODY_MAX = 2000;

const MESSAGE = {
  BadGame: "Not a game on genex.games",
  BadComment: "Not a comment",
  BadBody: `A comment is 1 to ${COMMENT_MAX} characters`,
} as const;

/** The routes the comments call. */
export const CommentRoute = {
  list: (id: string) => `/api/projects/${encodeURIComponent(id)}/comments`,
  one: (id: string, commentId: string) =>
    `/api/projects/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}`,
} as const;

/** What the comments need beyond the gallery's deps: the unlocked account's id, null with none. */
export interface CommentDeps extends GalleryDeps {
  me(): Promise<string | null>;
}

/** The comment's author as the list draws them, or null when the answer names nobody. */
function toAuthor(value: unknown, local: boolean): PlayCommentAuthor | null {
  if (!isRecord(value) || !isAccountId(value.id)) return null;
  return {
    id: value.id,
    name: text(value.name, NAME_MAX).trim() || text(value.handle, NAME_MAX),
    imageUrl: imageUrl(value.image, local),
    avatarVariant: isAvatarVariant(value.avatarVariant) ? value.avatarVariant : 0,
  };
}

/** One comment from the API's answer, `mine` when `me` wrote it; null for anything that is not one. */
export function toComment(value: unknown, me: string | null, local = false): PlayComment | null {
  if (!isRecord(value) || !isCursor(value.id)) return null;
  const author = toAuthor(value.author, local);
  const body = text(value.body, BODY_MAX).trim();
  const at = typeof value.createdAt === "string" ? Date.parse(value.createdAt) : Number.NaN;
  if (!author || !body || !Number.isFinite(at)) return null;
  return { id: value.id, body, at, author, mine: me !== null && author.id === me };
}

/** A page of comments from the API's answer: the ones that read as comments, and the next page's cursor. */
export function toCommentsPage(body: unknown, me: string | null, local = false): PlayCommentsPage {
  const items = isRecord(body) && Array.isArray(body.items) ? body.items : [];
  const next = isRecord(body) ? body.nextCursor : null;
  return {
    items: items.flatMap((item) => toComment(item, me, local) ?? []),
    nextCursor: isCursor(next) ? next : null,
  };
}

/** The account's token for a write, or {@link SignInNeeded} when none is unlocked. */
async function writeToken(deps: CommentDeps): Promise<string> {
  const auth = await deps.token();
  if (!auth) throw new SignInNeeded();
  return auth;
}

/** A write's answer: refused for want of an account, failed, or through. */
function checkWrite(route: string, status: number): void {
  if (status === HTTP_UNAUTHORIZED) throw new SignInNeeded();
  if (status < 200 || status >= 300) throw new GalleryError(route, status);
}

/** The game's comments on genex.games, over `deps`. */
export function playComments(deps: CommentDeps) {
  const local = deps.localImages === true;
  const me = (): Promise<string | null> => deps.me().catch(() => null);

  /** A page of the game's comments, newest first: the first, or the one after `cursor`. */
  const list = async (gameId: string, cursor: string | null): Promise<PlayCommentsPage> => {
    if (!isCursor(gameId)) throw new Error(MESSAGE.BadGame);
    const query = new URLSearchParams({ limit: String(COMMENTS_PAGE) });
    if (isCursor(cursor)) query.set("cursor", cursor);
    const [body, mine] = await Promise.all([readRoute(deps.request, `${CommentRoute.list(gameId)}?${query}`), me()]);
    return toCommentsPage(body, mine, local);
  };

  /** Post `body` as the account's comment; answers it as genex.games saved it. */
  const post = async (gameId: string, body: unknown): Promise<PlayComment> => {
    if (!isCursor(gameId)) throw new Error(MESSAGE.BadGame);
    const clean = commentBody(body);
    if (!clean) throw new Error(MESSAGE.BadBody);
    const route = CommentRoute.list(gameId);
    const answer = await deps.request(route, { method: "POST", token: await writeToken(deps), body: { body: clean } });
    checkWrite(route, answer.status);
    const saved = toComment(isRecord(answer.body) ? answer.body.comment : null, await me(), local);
    if (!saved) throw new GalleryError(route, answer.status);
    // genex.games answers with the account's own comment.
    return { ...saved, mine: true };
  };

  /** Delete one of the account's comments. */
  const remove = async (gameId: string, commentId: unknown): Promise<void> => {
    if (!isCursor(gameId)) throw new Error(MESSAGE.BadGame);
    if (!isCursor(commentId)) throw new Error(MESSAGE.BadComment);
    const route = CommentRoute.one(gameId, commentId);
    const answer = await deps.request(route, { method: "DELETE", token: await writeToken(deps) });
    checkWrite(route, answer.status);
  };

  return { list, post, remove };
}

/** The comments as `playComments` makes them. */
export type PlayComments = ReturnType<typeof playComments>;
