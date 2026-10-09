import { sameSnapshot, shareRecords } from "./snapshot-equality.ts";
/**
 * Conversations: the records, each thread's live status line, and which one is open.
 *
 * The open game is not stored beside the open thread; it is derived from it. A game chat shows
 * its own game (a draft has none until its first brief binds one), and the Studio chat keeps
 * whichever game the stage held when it was entered. That removes the three copies App used to
 * keep in step by effects.
 *
 * Actions are pure `(state, input) => state`; `createThreadsStore` binds them to a `StudioApi`.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import { ThreadKind } from "../../shared/event-log.ts";
import type { ThreadStatusMap, UiEvent, UiEventMap } from "../../shared/ui-events.ts";
import type { ConversationRecord, GameProject, StudioApi } from "../../shared/studio-api.ts";
import type { ThreadMeta } from "../types.ts";
import { createRefresher } from "./refresher.ts";

/** Which room the workspace shows: home, Studio's review, or a game's build stage (`data-room`). */
export const Room = {
  Home: "home",
  Studio: "studio",
  Build: "build",
} as const;
export type Room = (typeof Room)[keyof typeof Room];

export interface ThreadsState {
  records: ConversationRecord[];
  status: ThreadStatusMap;
  /**
   * Where `status` came from. The harness reports the whole map on every change; once it has
   * spoken, a (retried) bootstrap's snapshot is older than what the screen already shows.
   */
  statusSource: "none" | "bootstrap" | "live";
  activeThreadId: string | null;
  /** The game the stage holds while the Studio chat is open. */
  stageProject: string | null;
  /** The game chat the stage last showed in this session; the Studio chat keeps its stage. */
  stageThreadId: string | null;
  /** The game chat Cmd-1 returns to, remembered across launches. */
  lastGameThreadId: string | null;
  /** What the person is waited on to finish in, per chat (a lock's label: "Unreal"), while a call waits. */
  personFirst: Readonly<Record<string, string>>;
}

export const initialThreads = (lastGameThreadId: string | null = null): ThreadsState => ({
  records: [],
  status: {},
  statusSource: "none",
  activeThreadId: null,
  stageProject: null,
  stageThreadId: null,
  lastGameThreadId,
  personFirst: {},
});

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** The contractor session a thread hands work to, when the record names its engine and session. */
function contractorOf(value: unknown): ThreadMeta["contractor"] | undefined {
  const isObject = typeof value === "object" && value !== null && !Array.isArray(value);
  if (!isObject) return undefined;
  const c = value as Record<string, unknown>;
  if (typeof c.engine !== "string" || typeof c.sessionId !== "string") return undefined;
  return {
    engine: c.engine,
    sessionId: c.sessionId,
    ...(text(c.project) ? { project: text(c.project) } : {}),
    ...(text(c.model) ? { model: text(c.model) } : {}),
    ...(text(c.effort) ? { effort: text(c.effort) } : {}),
  };
}

/** The harness's thread metadata, read field by field (it is written by agent-editable code). */
const META_CACHE = new WeakMap<ConversationRecord, ThreadMeta>();

export function threadMeta(thread: ConversationRecord | null | undefined): ThreadMeta {
  const cached = thread ? META_CACHE.get(thread) : undefined;
  if (cached) return cached;
  const raw = thread?.metadata ?? {};
  const meta: ThreadMeta = {};
  if (raw.kind === ThreadKind.Studio || raw.kind === ThreadKind.Game) meta.kind = raw.kind;
  if (typeof raw.project === "string" || raw.project === null) meta.project = raw.project;
  if (typeof raw.archived === "boolean") meta.archived = raw.archived;
  if (Array.isArray(raw.extraReads))
    meta.extraReads = raw.extraReads.filter((item): item is string => typeof item === "string");
  const contractor = contractorOf(raw.contractor);
  if (contractor) meta.contractor = contractor;
  if (text(raw.lastEngine)) meta.lastEngine = text(raw.lastEngine);
  if (text(raw.lastModel) !== undefined) meta.lastModel = text(raw.lastModel);
  if (text(raw.lastEffort) !== undefined) meta.lastEffort = text(raw.lastEffort);
  if (thread) META_CACHE.set(thread, meta);
  return meta;
}

export const isGameThread = (thread: ConversationRecord | null | undefined): boolean =>
  threadMeta(thread).kind === ThreadKind.Game;

/** A game chat that is not archived. */
const isLiveGameChat = (meta: ThreadMeta): boolean => meta.kind === ThreadKind.Game && !meta.archived;

// ── selectors ─────────────────────────────────────────────────────────────────────────────

export const activeThread = (state: ThreadsState): ConversationRecord | null =>
  state.records.find((thread) => thread.id === state.activeThreadId) ?? null;

/** Home while no chat is open, Studio while the Studio chat is, Build for a game chat. */
export const roomOf = (state: ThreadsState): Room => {
  if (!state.activeThreadId) return Room.Home;
  const active = activeThread(state);
  return active && !isGameThread(active) ? Room.Studio : Room.Build;
};

/** The game on the stage: the open game chat's own, else the one the Studio chat kept. */
export const projectOf = (state: ThreadsState): string | null => {
  const active = activeThread(state);
  return active && isGameThread(active) ? (threadMeta(active).project ?? null) : state.stageProject;
};

export const studioThreadOf = (state: ThreadsState): ConversationRecord | null =>
  state.records.find((thread) => !isGameThread(thread)) ?? null;

/**
 * The sidebar's games: pinned first, then the most recently worked on (its newest chat, else when it
 * was made), then by title. Opening a game is not work: a row never moves because it was selected.
 */
export function sidebarGames(games: readonly GameProject[], records: readonly ConversationRecord[]): GameProject[] {
  const recent = (game: GameProject) =>
    Math.max(
      Date.parse(game.createdAt) || 0,
      ...records
        .filter((thread) => threadMeta(thread).project === game.name)
        .map((thread) => Date.parse(thread.updated_at) || 0),
    );
  return [...games].sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
    return recent(b) - recent(a) || a.title.localeCompare(b.title);
  });
}

/** The rail's order for Alt-↑/↓: Studio, then each game's primary (else freshest) chat. */
export function railThreadIds(records: readonly ConversationRecord[], games: readonly GameProject[]): string[] {
  const ids: string[] = [];
  const studio = records.find((thread) => !isGameThread(thread));
  if (studio) ids.push(studio.id);
  for (const game of games) {
    const chats = records
      .filter((thread) => {
        const meta = threadMeta(thread);
        return isLiveGameChat(meta) && meta.project === game.name;
      })
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
    const chat = chats.find((thread) => thread.id === game.primaryThreadId) ?? chats[0];
    if (chat) ids.push(chat.id);
  }
  return ids;
}

/** Where Cmd-1 goes: the last game chat, if its game is still there, else the first live one. */
export function returnTarget(state: ThreadsState, games: readonly GameProject[]): string | null {
  const gameThreads = state.records.filter((thread) => {
    const meta = threadMeta(thread);
    return isLiveGameChat(meta) && games.some((game) => game.name === meta.project);
  });
  return (gameThreads.find((thread) => thread.id === state.lastGameThreadId) ?? gameThreads[0])?.id ?? null;
}

/** The status line the harness reports for a thread with nothing to do. */
const IDLE_STATUS = "idle";

/** Does this status line say the thread is working (anything but empty or idle)? */
export const isWorkingStatus = (status: string | undefined): boolean => Boolean(status && status !== IDLE_STATUS);

/** Threads with a working status line (anything but idle). */
export function busyThreadIds(status: ThreadStatusMap): Set<string> {
  return new Set(
    Object.entries(status)
      .filter(([, value]) => isWorkingStatus(value.status))
      .map(([id]) => id),
  );
}

// ── actions ───────────────────────────────────────────────────────────────────────────────

export function threadsLoaded(state: ThreadsState, records: ConversationRecord[]): ThreadsState {
  const shared = shareRecords(state.records, records, (record) => record.id);
  return shared === state.records ? state : { ...state, records: shared };
}

/** A record main just handed over joins the list unless it is already there. */
export function threadAdded(state: ThreadsState, record: ConversationRecord): ThreadsState {
  return state.records.some((thread) => thread.id === record.id)
    ? state
    : { ...state, records: [...state.records, record] };
}

export function threadReplaced(state: ThreadsState, record: ConversationRecord): ThreadsState {
  return { ...state, records: state.records.map((thread) => (thread.id === record.id ? record : thread)) };
}

/** Open a conversation. Leaving a game chat for Studio keeps its game on the stage. */
export function threadSelected(state: ThreadsState, threadId: string | null): ThreadsState {
  const next: ThreadsState = { ...state, activeThreadId: threadId, stageProject: projectOf(state) };
  const record = next.records.find((thread) => thread.id === threadId);
  if (record && isGameThread(record)) {
    next.stageThreadId = record.id;
    next.lastGameThreadId = record.id;
  }
  return next;
}

/** The game the stage opens on when the first conversation is not a game chat. */
export function stageProjectSet(state: ThreadsState, project: string | null): ThreadsState {
  return { ...state, stageProject: project };
}

/** The harness's whole status map, as it reported it. */
export function statusReported(state: ThreadsState, all: ThreadStatusMap): ThreadsState {
  if (state.statusSource === "live" && sameSnapshot(state.status, all)) return state;
  return { ...state, status: all, statusSource: "live" };
}

/**
 * A call began or stopped waiting for the person to finish in an app a plugin guards. Read field
 * by field: a wait with no chat or no label to name is not shown.
 */
export function personFirstReported(state: ThreadsState, notice: UiEventMap[typeof UiEvent.PersonFirst]): ThreadsState {
  const { threadId, label, waiting } = notice;
  const named = typeof label === "string" && label.trim() !== "";
  const placed = typeof threadId === "string" && threadId !== "" && !(threadId in Object.prototype);
  if (!named || !placed) return state;
  const shown = state.personFirst[threadId];
  if (waiting === true)
    return shown === label.trim()
      ? state
      : { ...state, personFirst: { ...state.personFirst, [threadId]: label.trim() } };
  if (shown === undefined) return state;
  const { [threadId]: _ended, ...rest } = state.personFirst;
  return { ...state, personFirst: rest };
}

/** What the person is waited on to finish in, in one chat; null when nothing waits for them there. */
export function personFirstLabel(state: ThreadsState, threadId: string | null): string | null {
  if (!threadId || !Object.hasOwn(state.personFirst, threadId)) return null;
  return state.personFirst[threadId] ?? null;
}

/** A harness that is not ready has nothing running: no stale "working" line survives it. */
export function harnessDown(state: ThreadsState): ThreadsState {
  return statusReported(state, {});
}

/** A bootstrap's snapshot, unless the harness has already reported since. */
export function statusBootstrapped(state: ThreadsState, snapshot: ThreadStatusMap | undefined): ThreadsState {
  return state.statusSource === "live" ? state : { ...state, status: snapshot ?? {}, statusSource: "bootstrap" };
}

/**
 * A game was removed. If the stage held it, the stage lets go of it and home opens; a remembered
 * return to it is forgotten.
 */
export function gameRemovedFromThreads(state: ThreadsState, project: string): ThreadsState {
  if (projectOf(state) !== project) return state;
  return {
    ...state,
    activeThreadId: null,
    stageProject: null,
    stageThreadId: null,
    lastGameThreadId: null,
  };
}

export interface ThreadsStore extends StoreApi<ThreadsState> {
  refresh(): Promise<void>;
}

export function createThreadsStore(
  api: Pick<StudioApi, "threads">,
  options: { lastGameThreadId?: string | null; publish?: (apply: () => void) => void } = {},
): ThreadsStore {
  const store = createStore<ThreadsState>()(() => initialThreads(options.lastGameThreadId ?? null));
  const refresher = createRefresher(
    api.threads.bind(api),
    (records) => store.setState((state) => threadsLoaded(state, records), true),
    { publish: options.publish },
  );
  return Object.assign(store, { refresh: () => refresher.request() });
}
