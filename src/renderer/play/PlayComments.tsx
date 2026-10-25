/**
 * The viewer's Comments: a modal over the dimmed game, in the bar's layer. Its title is the count; its
 * list (newest first, a page at a time as it scrolls) keeps the modal at its height however few there
 * are, and a footer is pinned under it: one line and Sign in while signed out, else the comment field
 * with Post inside it, shown once something is typed. The account's own comments can be deleted.
 * Esc, ✕ or a click outside closes it, and the keyboard goes back to the game.
 */
import * as Dialog from "@radix-ui/react-dialog";
import type { FormEvent, JSX, RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { type PlayBarState, PlayControl } from "../../shared/play.ts";
import { COMMENT_MAX, commentBody, type PlayComment } from "../../shared/play-comments.ts";
import { AvatarMotion } from "../avatars/GeneratedAvatar.tsx";
import { Icon } from "../ui/icons.tsx";
import { prefersReducedMotion } from "../ui/media-queries.ts";
import { useMoreBelow } from "../ui/scroll-fade.ts";
import { PLAY_WORDS } from "../words.ts";
import {
  type CommentsList,
  CommentsStatus,
  minutesSince,
  NO_COMMENTS,
  withCommentsPage,
  withoutComment,
  withPosted,
} from "./bar-model.ts";
import type { BarApi } from "./PlayBarPage.tsx";
import type { SendControl } from "./PlayViewerBar.tsx";
import { PersonAvatar } from "./PersonAvatar.tsx";

const WORDS = PLAY_WORDS.comments;
/** How long the close animation plays before the modal goes (`play.css`). */
const CLOSE_MS = 150;
/** How near the list's end a scroll asks for the next page, in pixels. */
const MORE_AT_PX = 160;
/** How many rows stand in for the first page while it loads. */
const SKELETON_ROWS = 3;

/** The game's comments as read so far, the next page on asking, and the list after a post or a delete. */
function useComments(api: BarApi) {
  const [list, setList] = useState<CommentsList>(NO_COMMENTS);
  const live = useRef(true);
  const reading = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const read = useCallback(
    async (cursor: string | null) => {
      if (reading.current) return;
      reading.current = true;
      const more = cursor !== null;
      setList((shown) => (more ? { ...shown, loadingMore: true } : NO_COMMENTS));
      try {
        const page = await api.playComments(cursor);
        if (live.current) setList((shown) => withCommentsPage(shown, page, more));
      } catch {
        if (live.current)
          setList((shown) => (more ? { ...shown, loadingMore: false } : { ...shown, status: CommentsStatus.Failed }));
      } finally {
        reading.current = false;
      }
    },
    [api],
  );
  useEffect(() => void read(null), [read]);
  const more = (): void => {
    if (list.nextCursor && !list.loadingMore) void read(list.nextCursor);
  };
  return {
    list,
    more,
    retry: () => void read(null),
    posted: (comment: PlayComment) => setList((shown) => withPosted(shown, comment)),
    removed: (id: string) => setList((shown) => withoutComment(shown, id)),
  };
}

/** A row in the list's own shape, shimmering, while the first page loads. */
function SkeletonRow(): JSX.Element {
  return (
    <li className="play-comment" data-skeleton aria-hidden="true">
      <span className="play-comment-skeleton-avatar" />
      <span className="play-comment-main">
        <span className="play-comment-skeleton-line" data-short />
        <span className="play-comment-skeleton-line" />
      </span>
    </li>
  );
}

/** One comment: its writer's avatar and name, how long ago, the words, and Delete on the account's own. */
function CommentRow({
  comment,
  now,
  onDelete,
}: {
  comment: PlayComment;
  now: number;
  onDelete: (comment: PlayComment) => void;
}): JSX.Element {
  const { author } = comment;
  return (
    <li className="play-comment" data-play-comment={comment.id}>
      <PersonAvatar person={author} size={28} motion={AvatarMotion.Still} />
      <div className="play-comment-main">
        <div className="play-comment-meta">
          <span className="play-comment-name">{author.name}</span>
          <span className="play-comment-when">{WORDS.ago(minutesSince(comment.at, now))}</span>
          {comment.mine && (
            <button
              type="button"
              className="play-comment-delete"
              aria-label={WORDS.deleteLabel}
              onClick={() => onDelete(comment)}
            >
              {WORDS.delete}
            </button>
          )}
        </div>
        <p className="play-comment-body">{comment.body}</p>
      </div>
    </li>
  );
}

/** The list: skeleton rows while it loads, what went wrong with Try again, a line when there are none. */
function CommentsBody({
  list,
  title,
  retry,
  onDelete,
}: {
  list: CommentsList;
  title: string;
  retry: () => void;
  onDelete: (comment: PlayComment) => void;
}): JSX.Element {
  if (list.status === CommentsStatus.Failed)
    return (
      <div className="play-comments-note" role="alert" data-problem>
        <span>{WORDS.failed}</span>
        <button type="button" className="play-comments-action" onClick={retry}>
          {WORDS.retry}
        </button>
      </div>
    );
  if (list.status === CommentsStatus.Ready && list.items.length === 0)
    return <p className="play-comments-note">{WORDS.none(title)}</p>;
  const now = Date.now();
  return (
    <ul className="play-comments-items">
      {list.status === CommentsStatus.Loading
        ? Array.from({ length: SKELETON_ROWS }, (_, at) => <SkeletonRow key={at} />)
        : list.items.map((comment) => <CommentRow key={comment.id} comment={comment} now={now} onDelete={onDelete} />)}
      {list.loadingMore && <SkeletonRow />}
    </ul>
  );
}

/** The comment field, with Post inside it once something is typed; Enter posts too. */
function CommentField({
  api,
  field,
  onPosted,
}: {
  api: BarApi;
  field: RefObject<HTMLInputElement | null>;
  onPosted: (comment: PlayComment) => void;
}): JSX.Element {
  const [draft, setDraft] = useState("");
  const [failed, setFailed] = useState(false);
  const posting = useRef(false);
  const body = commentBody(draft);
  const post = (event: FormEvent): void => {
    event.preventDefault();
    if (!body || posting.current) return;
    posting.current = true;
    setFailed(false);
    api
      .playComment(body)
      .then((comment) => {
        onPosted(comment);
        setDraft("");
      })
      .catch(() => setFailed(true))
      .finally(() => {
        posting.current = false;
      });
  };
  return (
    <div className="play-comments-write">
      {failed && (
        <p className="play-comments-problem" role="alert">
          {WORDS.postFailed}
        </p>
      )}
      <form className="play-comments-field" onSubmit={post}>
        <input
          ref={field}
          aria-label={WORDS.field}
          placeholder={WORDS.field}
          maxLength={COMMENT_MAX}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          data-play-comment-field
        />
        {body && (
          <button type="submit" className="play-comments-post" data-play-comment-post>
            {WORDS.post}
          </button>
        )}
      </form>
    </div>
  );
}

/**
 * The footer's way to comment: the field signed in, one line and Sign in signed out, and an empty
 * line of the same height while main has not said yet.
 */
function CommentsFooter({
  api,
  bar,
  send,
  field,
  onPosted,
}: {
  api: BarApi;
  bar: PlayBarState;
  send: SendControl;
  field: RefObject<HTMLInputElement | null>;
  onPosted: (comment: PlayComment) => void;
}): JSX.Element {
  if (bar.signedIn === null) return <div className="play-comments-signin" aria-hidden="true" />;
  if (bar.signedIn) return <CommentField api={api} field={field} onPosted={onPosted} />;
  return (
    <div className="play-comments-signin">
      <span>{WORDS.signIn(bar.title)}</span>
      <button type="button" className="play-comments-action" onClick={() => send(PlayControl.Install)}>
        {WORDS.signInAction}
      </button>
    </div>
  );
}

/** The modal over the dimmed game, for the game whose bar is `bar`. */
export function PlayComments({
  api,
  bar,
  send,
  onClose,
}: {
  api: BarApi;
  bar: PlayBarState;
  send: SendControl;
  onClose: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(true);
  const [deleteFailed, setDeleteFailed] = useState(false);
  const { list, more, retry, posted, removed } = useComments(api);
  const field = useRef<HTMLInputElement>(null);
  const fade = useMoreBelow<HTMLDivElement>();
  const closed = useRef(onClose);
  closed.current = onClose;
  const close = (): void => {
    setOpen(false);
    setTimeout(() => closed.current(), prefersReducedMotion() ? 0 : CLOSE_MS);
  };
  const deleting = useRef(new Set<string>());
  const remove = (comment: PlayComment): void => {
    // A second press while the first is on its way would be refused as a comment already gone.
    if (deleting.current.has(comment.id)) return;
    deleting.current.add(comment.id);
    setDeleteFailed(false);
    api
      .playUncomment(comment.id)
      .then(
        () => removed(comment.id),
        () => setDeleteFailed(true),
      )
      .finally(() => deleting.current.delete(comment.id));
  };
  const scrolled = (element: HTMLDivElement): void => {
    // The list's top edge fades once anything has scrolled under the title.
    element.toggleAttribute("data-above", element.scrollTop > 0);
    if (element.scrollTop + element.clientHeight >= element.scrollHeight - MORE_AT_PX) more();
  };
  return (
    <Dialog.Root open={open} onOpenChange={(value) => !value && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="play-comments-scrim" />
        <Dialog.Content
          className="play-comments"
          aria-describedby={undefined}
          data-play-comments-dialog
          onOpenAutoFocus={(event) => {
            if (!field.current) return;
            event.preventDefault();
            field.current.focus();
          }}
        >
          <div className="play-comments-head">
            <Dialog.Title className="play-comments-title">
              {WORDS.title(bar.comments ?? list.items.length)}
            </Dialog.Title>
            <Dialog.Close className="play-comments-close" aria-label={WORDS.close}>
              <Icon name="close" size={16} />
            </Dialog.Close>
          </div>
          <div
            ref={fade}
            className="play-comments-list scroll-fade"
            onScroll={(event) => scrolled(event.currentTarget)}
          >
            <CommentsBody list={list} title={bar.title} retry={retry} onDelete={remove} />
          </div>
          <div className="play-comments-foot">
            {deleteFailed && (
              <p className="play-comments-problem" role="alert">
                {WORDS.deleteFailed}
              </p>
            )}
            <CommentsFooter api={api} bar={bar} send={send} field={field} onPosted={posted} />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
