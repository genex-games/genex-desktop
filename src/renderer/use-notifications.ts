import { studio } from "./state/studio.ts";
import { SECOND_MS } from "../shared/duration.ts";
/**
 * The notifications feed as the app shows it: read from the same log the chat reads, kept per
 * profile in storage (`notifications.ts` owns the rules and the format), badged on the Dock, and
 * — for what arrives while Studio is in the background — sent to macOS. A row about the chat on
 * screen arrives read. A game's review that arrives while Studio is in front and another game is
 * open is a toast with [Open].
 */
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import type { ConversationRecord, GameProject } from "./types.ts";
import {
  activityNotices,
  applyEvents,
  clearActivity,
  EMPTY_NOTICES,
  loadNotices,
  markRead,
  noticeSource,
  reviewToasts,
  saveNotices,
  systemNotes,
  waitingNotices,
  type Notice,
  NoticeKind,
  type NoticeState,
} from "./notifications.ts";
import { threadMeta } from "./state/threads.ts";
import { safeStorage } from "./storage.ts";
import { ThreadKind } from "../shared/event-log.ts";
import { UiEvent } from "../shared/ui-events.ts";
import { track } from "./analytics/client.ts";
import { AnalyticsEvent } from "./analytics/events.ts";
import { noticeProperties } from "./analytics/workspace-properties.ts";
import { NoticeVia } from "./analytics/workspace-vocabulary.ts";
import { REVIEW_WORDS } from "./words.ts";

/** A sign-in or Play notice belongs to no chat: it always shows. Any other shows while its chat is open and its game is here. */
const unthreaded = (notice: Notice): boolean => notice.kind === NoticeKind.SignIn || notice.kind === NoticeKind.Play;

export interface Notifications {
  /** Rows about chats and games that still exist (and every sign-in). */
  visible: Notice[];
  waitingCount: number;
  unread: boolean;
  /** Go where a row points; `via` says whether it was the panel's row or the system's notification. */
  open(notice: Notice, via?: NoticeVia): void;
  readAll(): void;
  clear(): void;
}

export function useNotifications({
  ready,
  threads,
  games,
  activeThreadId,
  away,
  onOpen,
}: {
  ready: boolean;
  threads: ConversationRecord[];
  games: GameProject[];
  activeThreadId: string | null;
  /** Another room covers the chat (Plugins): its rows are not being watched. */
  away: boolean;
  /** Take the person to what a row is about. */
  onOpen: (notice: Notice, via: NoticeVia) => void;
}): Notifications {
  const storage = useMemo(() => safeStorage(), []);
  // With nothing saved yet, the first read catches up without ringing.
  const [notices, setNotices] = useState<NoticeState>(() => loadNotices(storage) ?? EMPTY_NOTICES);
  const noticesNow = useRef(notices);

  const catchUp = useRef(notices.floor === null);
  const started = useRef(false);
  const watching = useRef({ threadId: activeThreadId, away });
  watching.current = { threadId: activeThreadId, away };

  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const save = useCallback(() => saveNotices(storage, noticesNow.current), [storage]);
  const changed = useCallback(
    (state: NoticeState) => {
      noticesNow.current = state;
      setNotices((current) => (current.items === state.items ? current : state));
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(save, SECOND_MS);
    },
    [save],
  );
  const onOpenNow = useRef(onOpen);
  onOpenNow.current = onOpen;
  const open = useCallback(
    (notice: Notice, via: NoticeVia = NoticeVia.Panel) => {
      changed(markRead(noticesNow.current, new Set([notice.id])));
      onOpenNow.current(notice, via);
    },
    [changed],
  );
  const receive = useEffectEvent(() => {
    if (!ready) return;
    const feed = studio().eventLog.getState().feed;
    const focused = document.hasFocus() && document.visibilityState === "visible";
    const first = !started.current;
    const { state, arrived } = applyEvents(noticesNow.current, feed, {
      catchUp: catchUp.current,
      seen: (threadId) => focused && !watching.current.away && threadId === watching.current.threadId,
    });
    catchUp.current = false;
    started.current = true;
    if (state === noticesNow.current) return;
    changed(state);
    tellArrived(arrived, { first, focused }, { threads, games, watching: watching.current, open });
  });
  useEffect(() => {
    if (ready) receive();
    return studio().eventLog.subscribe(() => receive());
  }, [ready]);
  useEffect(() => {
    window.addEventListener("pagehide", save);
    return () => {
      clearTimeout(saveTimer.current);
      save();
      window.removeEventListener("pagehide", save);
    };
  }, [save]);

  const visible = useMemo(() => {
    const openChat = (id: string): boolean =>
      threads.some((thread) => thread.id === id && !threadMeta(thread).archived);
    const gameKept = (project: string | undefined): boolean => !project || games.some((game) => game.name === project);
    const shows = (notice: Notice): boolean =>
      unthreaded(notice) || (openChat(notice.threadId) && gameKept(notice.project));
    return notices.items.filter(shows);
  }, [notices, threads, games]);
  const waitingCount = waitingNotices(visible).length;
  const unread = activityNotices(visible).some((notice) => !notice.read);
  useEffect(() => {
    void window.studio.setBadge(waitingCount).catch(() => {});
  }, [waitingCount]);

  // A click on the macOS notification focuses Studio and names the row.
  useEffect(
    () =>
      window.studio.onEvent((event) => {
        if (event.type !== UiEvent.NotificationOpen) return;
        const notice = noticesNow.current.items.find((item) => item.id === event.payload.id);
        if (notice) open(notice, NoticeVia.SystemNotification);
      }),
    [open],
  );

  const readAll = useCallback(() => changed(markRead(noticesNow.current)), [changed]);
  const clear = useCallback(() => changed(clearActivity(noticesNow.current)), [changed]);
  return useMemo(
    () => ({
      visible,
      waitingCount,
      unread,
      open,
      readAll,
      clear,
    }),
    [visible, waitingCount, unread, open, readAll, clear],
  );
}

/** What a read tells of the notices that arrived: where they stand, and to whom. */
interface Telling {
  threads: ConversationRecord[];
  games: GameProject[];
  /** The chat on screen, and whether another room covers it. */
  watching: { threadId: string | null; away: boolean };
  open(notice: Notice, via: NoticeVia): void;
}

/**
 * Tell what arrived: macOS while Studio is in the background (the first read and a focused window
 * are already in front of the person; nothing arrived sends nothing), the count for usage
 * analytics, and a toast with [Open] for a game's review while another game is open.
 */
function tellArrived(arrived: Notice[], seen: { first: boolean; focused: boolean }, telling: Telling): void {
  const notes = systemNotes(arrived, seen, (notice) => sourceOf(notice, telling.threads, telling.games));
  countArrived(arrived, { system_notified: notes.length > 0, window_focused: seen.focused });
  for (const note of notes) void window.studio.notify(note).catch(() => {});
  if (seen.first) return;
  const { threadId, away } = telling.watching;
  const openProject = away ? null : (threadMeta(telling.threads.find((one) => one.id === threadId)).project ?? null);
  for (const notice of reviewToasts(arrived, { focused: seen.focused, openProject }))
    studio().toasts.offer(notice.headline ?? notice.text, {
      label: REVIEW_WORDS.notice.open,
      run: () => telling.open(notice, NoticeVia.Toast),
    });
}

/** Each notice that arrived, by its kind, for usage analytics: never its words or its game. */
function countArrived(arrived: Notice[], seen: { system_notified: boolean; window_focused: boolean }): void {
  for (const notice of arrived) track(AnalyticsEvent.NoticeArrived, { ...noticeProperties(notice), ...seen });
}

/** Who a row is from, as macOS titles it: its game, its chat's kind, or its own headline. */
function sourceOf(notice: Notice, threads: ConversationRecord[], games: GameProject[]): string {
  const thread = threadMeta(threads.find((item) => item.id === notice.threadId));
  return noticeSource(
    notice,
    games.find((game) => game.name === (notice.project ?? thread.project))?.title,
    thread.kind === ThreadKind.Game,
  );
}
