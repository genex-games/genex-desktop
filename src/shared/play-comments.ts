/**
 * A Play game's comments, as the viewer's Comments shows them: genex.games' own (plain text, newest
 * first, in pages), read and written by main for the game on screen.
 */

/** The longest comment genex.games takes, in characters. */
export const COMMENT_MAX = 500;
/** How many comments one page holds. */
export const COMMENTS_PAGE = 20;

/** Who wrote a comment: enough to draw their avatar and name. */
export interface PlayCommentAuthor {
  id: string;
  name: string;
  imageUrl: string | null;
  avatarVariant: number;
}

/** One comment. */
export interface PlayComment {
  id: string;
  body: string;
  /** When it was written, in milliseconds since the epoch. */
  at: number;
  author: PlayCommentAuthor;
  /** The unlocked account wrote it: it may be deleted here. */
  mine: boolean;
}

/** One page of comments, newest first; `nextCursor` asks for the next, null at the end. */
export interface PlayCommentsPage {
  items: PlayComment[];
  nextCursor: string | null;
}

/** A comment as genex.games takes it: trimmed, with something in it, at most {@link COMMENT_MAX} characters. */
export function commentBody(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const body = value.trim();
  return body.length > 0 && body.length <= COMMENT_MAX ? body : null;
}
