/**
 * Components read the stores through these hooks, and always through a selector: a component
 * re-renders when what it selected changes, not when anything in the store does. Select one
 * value, or wrap a selector that builds an object or array in `useShallow`.
 * `tests/conformance/renderer-state.test.ts` refuses a store hook called without one.
 */
import { useStore } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { AgentScreensState } from "./agent-screens.ts";
import type { BootStore, BootStoreState } from "./boot.ts";
import type { CommandRunsState } from "./command-runs.ts";
import type { EnginesState } from "./engines.ts";
import type { EventLogState } from "./event-log.ts";
import type { LaunchState } from "./launch.ts";
import type { LayoutState } from "./layout.ts";
import type { LibraryState } from "./library.ts";
import type { ModelPickerState } from "./model-picker.ts";
import type { PeopleState } from "./people.ts";
import type { PlayState } from "./play.ts";
import type { PluginsState } from "./plugins.ts";
import type { SharingState } from "./sharing.ts";
import { type SessionState, SessionStatus } from "./session.ts";
import { studio } from "./studio.ts";
import { activeThread, isGameThread, roomOf, threadMeta, studioThreadOf, type ThreadsState } from "./threads.ts";
import type { ToastsState } from "./toasts.ts";
import type { UpdateState } from "./update.ts";
import type { AgentsStartState } from "./agents-start.ts";

export { useShallow } from "zustand/react/shallow";

type Selector<S, T> = (state: S) => T;

export const useSession = <T>(select: Selector<SessionState, T>): T => useStore(studio().session, select);
export const useEventLog = <T>(select: Selector<EventLogState, T>): T => useStore(studio().eventLog, select);
export const useThreads = <T>(select: Selector<ThreadsState, T>): T => useStore(studio().threads, select);
export const useLibrary = <T>(select: Selector<LibraryState, T>): T => useStore(studio().library, select);
export const useEngines = <T>(select: Selector<EnginesState, T>): T => useStore(studio().engines, select);
export const usePlugins = <T>(select: Selector<PluginsState, T>): T => useStore(studio().plugins, select);
export const usePlay = <T>(select: Selector<PlayState, T>): T => useStore(studio().play, select);
export const usePeople = <T>(select: Selector<PeopleState, T>): T => useStore(studio().people, select);
export const useSharing = <T>(select: Selector<SharingState, T>): T => useStore(studio().sharing, select);
export const useAgentScreens = <T>(select: Selector<AgentScreensState, T>): T =>
  useStore(studio().agentScreens, select);
export const useCommandRuns = <T>(select: Selector<CommandRunsState, T>): T => useStore(studio().commandRuns, select);
export const useToasts = <T>(select: Selector<ToastsState, T>): T => useStore(studio().toasts, select);
export const useLayout = <T>(select: Selector<LayoutState, T>): T => useStore(studio().layout, select);
export const useLaunch = <T>(select: Selector<LaunchState, T>): T => useStore(studio().launch, select);
export const useUpdate = <T>(select: Selector<UpdateState, T>): T => useStore(studio().update, select);
export const useAgentsStart = <T>(select: Selector<AgentsStartState, T>): T => useStore(studio().agentsStart, select);
export const useModelPicker = <T>(select: Selector<ModelPickerState, T>): T => useStore(studio().modelPicker, select);
/** The boot store lives beside the studio, not in it: it decides whether the studio starts at all. */
export const useBoot = <T>(store: BootStore, select: Selector<BootStoreState, T>): T => useStore(store, select);

// ── Grouped views ─────────────────────────────────────────────────────────────────────────
//
// A view reads several fields of one store in one subscription (`useRailView`: one per store). Each is safe under `useShallow`
// only because every field it selects is a primitive or a reference the store already holds:
// `useShallow` compares the fields one by one with Object.is, so the component re-renders at
// exactly the moments separate one-field selectors would have made it. A field that builds a new
// array, set or object (`busyThreadIds`, `railThreadIds`) would differ on every store update and
// re-render on each; such derivations stay in the component's `useMemo`, over the fields here.

/**
 * The conversations as the shell reads them. `records` and `status` are the store's own
 * references; `activeThread` and `studioThread` are elements of `records` (or null); `room`,
 * `project` and the two ids are strings. Nothing here is built by the selector.
 */
export const useThreadsView = () =>
  useThreads(
    useShallow((s) => {
      const active = activeThread(s);
      const game = isGameThread(active);
      return {
        records: s.records,
        status: s.status,
        activeThreadId: s.activeThreadId,
        stageThreadId: s.stageThreadId,
        activeThread: active,
        room: roomOf(s),
        project: active && game ? (threadMeta(active).project ?? null) : s.stageProject,
        studioThread: studioThreadOf(s),
      };
    }),
  );

/**
 * What the rail's order and the notifications read: the thread records, the open thread's id and
 * the games. One `useShallow` subscription to the threads store over its own `records` array and
 * a string, and one read of the library's own `games` array: it re-renders exactly when one of
 * the three changes, as three one-field reads did.
 */
export const useRailView = () => {
  const { records, activeThreadId } = useThreads(
    useShallow((s) => ({ records: s.records, activeThreadId: s.activeThreadId })),
  );
  const games = useLibrary((s) => s.games);
  return { records, activeThreadId, games };
};

/**
 * The library as the sidebar reads it: the store's own `games` array and `building` set, and a
 * number. Nothing is built by the selector, so a change of `rootLabel`, `runsRoot` or the asset
 * inventories never re-renders the sidebar.
 */
export const useSidebarLibrary = () =>
  useLibrary(useShallow((s) => ({ games: s.games, building: s.building, stagedCount: s.stagedCount })));

/**
 * The library as the stage reads it: the store's own `games` array and two strings (or null).
 * Nothing is built by the selector, so a builder starting or the staged count moving never
 * re-renders the stage.
 */
export const useStageLibrary = () =>
  useLibrary(useShallow((s) => ({ games: s.games, rootLabel: s.rootLabel, runsRoot: s.runsRoot })));

/**
 * The window layout the shell reads: two primitives. The chat's width is not here on purpose: it
 * follows every pointer move of a drag, and only the shell's CSS variable needs it
 * (`useChatWidthVariable` in `shell/use-shell-chrome.ts`), not a render.
 */
export const useLayoutView = () =>
  useLayout(useShallow((s) => ({ sidebarOpen: s.sidebarOpen, stageView: s.stageView })));

/** Whether this is an unpackaged developer run, which offers the developer tools. */
export const useDeveloperRun = (): boolean => useSession((s) => s.developer);

/** The website Play links to: genex.games', unless a development profile points Play elsewhere. */
export const usePlayWeb = (): string => useSession((s) => s.playWeb);

/** The session as the shell reads it: two booleans, so a change of error text never re-renders. */
export const useSessionView = () =>
  useSession(useShallow((s) => ({ ready: s.status === SessionStatus.Ready, welcoming: s.welcoming })));

/** The stage ignores worker metadata and unrelated thread status updates. */
export const useStageThreads = () =>
  useThreads(
    useShallow((state) => {
      const active = activeThread(state);
      const game = isGameThread(active);
      return {
        activeThreadId: state.activeThreadId,
        stageThreadId: state.stageThreadId,
        room: roomOf(state),
        project: active && game ? (threadMeta(active).project ?? null) : state.stageProject,
        activeStatus: state.activeThreadId ? state.status[state.activeThreadId] : undefined,
      };
    }),
  );
