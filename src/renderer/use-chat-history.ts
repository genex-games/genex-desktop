import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CHAT_PAGE_SIZE, chatContext, mergeChatEvents, type ChatPage } from "../shared/chat-history.ts";
import { CustomEvent, customRecord } from "../shared/custom-events.ts";
import type { EventEnvelope } from "./types.ts";
import { errorMessage } from "../shared/errors.ts";
import { elapsedMs } from "./analytics/properties.ts";
import { track } from "./analytics/client.ts";
import { AnalyticsEvent } from "./analytics/events.ts";

/** A chat whose reader follows its newest line holds at most this many records before it drops its earliest. */
export const FOLLOWING_HOLDS = 8 * CHAT_PAGE_SIZE;
/** The newest records a following chat keeps when it drops its earliest: a few pages, as it opens with one. */
export const FOLLOWING_KEEPS = 4 * CHAT_PAGE_SIZE;

/**
 * The events of this thread in `log` (in log order) that come after the loaded tail. They are the
 * log's end, so it is read from the back: a long chat's whole log was read on every batch.
 */
function freshFor(log: readonly EventEnvelope[], threadId: string | null, tail: string | undefined): EventEnvelope[] {
  let start = log.length;
  while (start > 0 && (!tail || (log[start - 1]?.id ?? "") > tail)) start--;
  return log.slice(start).filter((event) => event.thread_id === threadId);
}

/**
 * The loaded page plus the live events of this thread that arrived after it. Every notification
 * re-reads the log, so most calls carry nothing new for this thread: those return the same array,
 * so the transcript and its state do not recompute for another chat's events.
 */
export function withLiveTail(
  events: EventEnvelope[],
  live: readonly EventEnvelope[],
  threadId: string | null,
): EventEnvelope[] {
  const fresh = freshFor(live, threadId, events.at(-1)?.id);
  return fresh.length ? mergeChatEvents(events, fresh) : events;
}

type History = ChatPage & { threadId: string; loading: boolean; error?: string; paging: boolean; pageError?: string };

/**
 * How many records a following chat keeps when it drops its earliest, and how many it holds
 * before it does. `filled` is how many it held when it last paged earlier history in to fill its
 * height (`filledAfterPage`): a Loop draws its builders' traces as a few short tool rows, so its
 * newest pages could leave the chat too short to scroll. It then paged them back, the next batch
 * dropped them again, and the chat read about seven pages for every batch of a long Loop.
 */
export function followingWindow(filled: number): { holds: number; keeps: number } {
  const keeps = Math.max(FOLLOWING_KEEPS, filled);
  return { keeps, holds: Math.max(FOLLOWING_HOLDS, 2 * keeps) };
}

/**
 * The loaded history once a batch of live records is in it (`rendered`, the loaded events and
 * their live tail). Every batch re-reads all the chat holds (its transcript, queue, run and work
 * rows), and an open chat kept every record since it opened: through a Loop of hours each of its
 * builders' traces cost the whole session again. So a chat whose reader follows its newest line
 * keeps its newest pages only, as when it opens: the current-state facts already hold what the
 * dropped records say about now, and scrolling up reads them back a page at a time. It never keeps
 * fewer than it needed to fill its height (`followingWindow`).
 */
export function withLiveBatch<H extends ChatPage>(
  history: H,
  rendered: EventEnvelope[],
  fresh: EventEnvelope[],
  following: boolean,
  filled = 0,
): H {
  const next = { ...history, events: rendered, context: chatContext(history.context, fresh) };
  const bounds = followingWindow(filled);
  if (!following || rendered.length <= bounds.holds) return next;
  const kept = rendered.slice(-bounds.keeps);
  return { ...next, events: kept, before: kept[0]?.id ?? null, hasMore: true };
}

/**
 * What a following chat needed to fill its height, once a page of earlier history landed: a page
 * a following reader asked for was asked because the chat was too short to scroll
 * (`loadsEarlier`), so it needed every record it now `held`. A reader scrolled up pages by
 * choice, which says nothing about the chat's height.
 */
export const filledAfterPage = (filled: number, held: number, following: boolean): number =>
  following ? Math.max(filled, held) : filled;

const empty = (threadId = ""): History => ({
  threadId,
  events: [],
  context: [],
  before: null,
  hasMore: false,
  loading: true,
  paging: false,
});

/** The next older page of this thread to ask for, from where its loaded history stops, or null. */
function olderPage(history: History, threadId: string | null): { threadId: string; before: string } | null {
  if (!threadId || history.threadId !== threadId) return null;
  return history.hasMore && history.before ? { threadId, before: history.before } : null;
}

/** The newest rewind marker of this thread among the live events, or null. */
const latestRewind = (live: readonly EventEnvelope[], threadId: string | null): string | null =>
  live.findLast(
    (event) => event.thread_id === threadId && customRecord(event.data)?.event_type === CustomEvent.ConversationRewound,
  )?.id ?? null;

/** The loaded history with a fresh first page read in after a rewind. */
function withReloadedPage(current: History, page: ChatPage, threadId: string): History {
  if (current.threadId !== threadId) return current;
  if (current.loading) return { ...page, threadId, loading: false, paging: false };
  // Earlier pages already loaded stay; the chat hides their withdrawn rows itself.
  const keepsEarlier = Boolean(current.before && page.before && current.before < page.before);
  return {
    ...current,
    context: page.context,
    events: mergeChatEvents(current.events, page.events),
    paging: false,
    ...(keepsEarlier ? {} : { before: page.before, hasMore: page.hasMore }),
  };
}

/**
 * A rewind hides rows the page and its current-state facts already hold, and a fold cannot
 * take a fact back: a new rewind marker reloads the page in place, without the loading state.
 */
function useRewindReload(
  threadId: string | null,
  live: readonly EventEnvelope[],
  generation: RefObject<number>,
  pageRequest: RefObject<boolean>,
  setHistory: Dispatch<SetStateAction<History>>,
): void {
  const rewindSeen = useRef<{ threadId: string | null; id: string | null }>({ threadId: null, id: null });
  useEffect(() => {
    const marker = latestRewind(live, threadId);
    const seen = rewindSeen.current;
    rewindSeen.current = { threadId, id: marker };
    if (!threadId || seen.threadId !== threadId || !marker || marker === seen.id) return;
    // A page request already on its way was read before the rewind: it is dropped, not merged.
    const version = ++generation.current;
    pageRequest.current = false;
    void window.studio
      .chatPage(threadId)
      .then((page) => {
        if (generation.current === version) setHistory((current) => withReloadedPage(current, page, threadId));
      })
      .catch(() => {});
  }, [live, threadId, generation, pageRequest, setHistory]);
}

/** Only the selected conversation is retained; drafts belong to the composer, not this cache. */
export function useChatHistory(threadId: string | null, live: EventEnvelope[], attempt: number) {
  const [history, setHistory] = useState<History>(empty);
  const generation = useRef(0);
  const pageRequest = useRef(false);
  // Earlier pages read in this chat, for `chat_history_paged`.
  const pages = useRef(0);
  // Whether the reader follows the newest line: the transcript's scroll keeps it (`useFollowScroll`).
  const following = useRef(true);
  // How many records this chat held when it last paged in to fill its height (`filledAfterPage`).
  const filled = useRef(0);
  useEffect(() => {
    const version = ++generation.current;
    pages.current = 0;
    following.current = true;
    filled.current = 0;
    pageRequest.current = false;
    setHistory(empty(threadId ?? ""));
    if (!threadId) return;
    const startedAt = Date.now();
    const opened = (failed: boolean, hasMore: boolean): void =>
      track(AnalyticsEvent.ChatOpened, {
        load_ms: elapsedMs(startedAt, Date.now()),
        has_more_history: hasMore,
        attempt,
        failed,
      });
    void window.studio
      .chatPage(threadId)
      .then((page) => {
        if (generation.current !== version) return;
        setHistory({ ...page, threadId, loading: false, paging: false });
        opened(false, page.hasMore);
      })
      .catch((error) => {
        if (generation.current !== version) return;
        setHistory({ ...empty(threadId), error: String(error.message ?? error) });
        opened(true, false);
      });
    return () => {
      ++generation.current;
    };
  }, [threadId, attempt]);
  useRewindReload(threadId, live, generation, pageRequest, setHistory);

  const loadEarlier = useCallback(async () => {
    const older = olderPage(history, threadId);
    if (!older || pageRequest.current) return;
    pageRequest.current = true;
    const version = generation.current;
    const filling = following.current;
    setHistory((current) => ({ ...current, paging: true, pageError: undefined }));
    const startedAt = Date.now();
    const paged = (failed: boolean): void =>
      track(AnalyticsEvent.ChatHistoryPaged, {
        page_index: pages.current,
        ms: elapsedMs(startedAt, Date.now()),
        failed,
      });
    try {
      const page = await window.studio.chatPage(older.threadId, older.before);
      pages.current += 1;
      paged(false);
      if (version === generation.current)
        setHistory((current) => {
          const events = mergeChatEvents(page.events, current.events);
          filled.current = filledAfterPage(filled.current, events.length, filling);
          return { ...current, events, before: page.before, hasMore: page.hasMore, paging: false };
        });
    } catch (error) {
      paged(true);
      if (version === generation.current)
        setHistory((current) => ({ ...current, paging: false, pageError: String(errorMessage(error)) }));
    } finally {
      if (version === generation.current) pageRequest.current = false;
    }
  }, [threadId, history.threadId, history.before, history.hasMore]);
  const current = history.threadId === threadId ? history : empty(threadId ?? "");
  // Reconcile live rows during render, in the same paint as busy/question state. Waiting
  // for the persistence effect made an answered question collapse before its reply appeared.
  const renderedEvents = useMemo(() => {
    if (current.loading) return current.events;
    return withLiveTail(current.events, live, threadId);
  }, [current.events, current.loading, live, threadId]);
  useEffect(() => {
    if (current.loading || current.events === renderedEvents) return;
    const fresh = freshFor(renderedEvents, threadId, current.events.at(-1)?.id);
    setHistory((previous) =>
      previous === history
        ? withLiveBatch(previous, renderedEvents, fresh, following.current, filled.current)
        : previous,
    );
  }, [history, current.loading, current.events, renderedEvents, threadId]);
  const stateEvents = useMemo(
    () => mergeChatEvents(current.context, renderedEvents),
    [current.context, renderedEvents],
  );
  return { ...current, events: renderedEvents, stateEvents, loadEarlier, following };
}
