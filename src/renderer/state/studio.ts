import { unstable_batchedUpdates } from "react-dom";
import { createPublicationBatch } from "./refresher.ts";
import { browserVisibility, type VisibilitySource } from "./visibility.ts";
/**
 * The renderer's state, wired once: every domain store, the one `onEvent` subscription that feeds
 * them, the log poll, the bootstrap, and the commands that span stores (opening a game, sending,
 * removing a game).
 *
 * `createStudio(api)` takes any `StudioApi` — the preload's `window.studio` in the app, the fake
 * in `tests/helpers/fake-studio-api.ts` in tests — and `start()` subscribes. The app has one
 * instance (`studio()`), started before React mounts, so StrictMode's replayed effects cannot
 * subscribe twice or drop a reply.
 */
import type { AgentScreenEvent } from "../../shared/agent-screen.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import type { ComposerSendOptions } from "../../shared/composer.ts";
import type { GameUpdate } from "../../shared/game-library.ts";
import { HarnessState } from "../../shared/protocol.ts";
import type { GameName } from "../../shared/game-project.ts";
import type { Bootstrap, ConversationRecord, GameProject, StudioApi } from "../../shared/studio-api.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import { shouldWelcome } from "../onboarding/state.ts";
import {
  browserStorage,
  readText,
  removeKey,
  safeStorage,
  STORAGE_KEYS,
  writeText,
  type KeyValueStorage,
} from "../storage.ts";
import { parseModelKey } from "../model-key.ts";
import { rememberChatEffort, rememberChatModel } from "../stored-model.ts";
import type { ComposerExtras } from "../ui/PromptBar.tsx";
import { problemWords } from "../words.ts";
import {
  createAgentScreensStore,
  frameReceived,
  screenClosed,
  screensLoaded,
  type AgentScreensStore,
} from "./agent-screens.ts";
import { createCommandOutput, type CommandOutput } from "./command-output.ts";
import { createCommandRunsStore, terminalChanged, type CommandRunsStore } from "./command-runs.ts";
import { createEnginesStore, enginesLoaded, type EnginesStore } from "./engines.ts";
import { createEventLogStore, type EventLogStore } from "./event-log.ts";
import {
  createLaunchStore,
  launchFailed,
  launchFinished,
  launchHanded,
  launchMade,
  launchNamed,
  launchOpened,
  launchStarted,
  returnTaken,
  type LaunchStore,
} from "./launch.ts";
import { createLayoutStore, stageViewChosen, type LayoutStore } from "./layout.ts";
import { createModelPickerStore, type ModelPickerStore } from "./model-picker.ts";
import {
  createLibraryStore,
  delegationChanged,
  gameAdded,
  libraryBootstrapped,
  stagedCounted,
  type LibraryStore,
} from "./library.ts";
import { createPluginsStore, PLUGIN_INDEX_POLL_MS, type PluginsStore } from "./plugins.ts";
import {
  bootstrapFailed,
  bootstrapReady,
  bootstrapStarted,
  createSessionStore,
  welcomeFinished,
  type SessionStore,
} from "./session.ts";
import {
  createThreadsStore,
  gameRemovedFromThreads,
  harnessDown,
  isGameThread,
  projectOf,
  stageProjectSet,
  statusBootstrapped,
  statusReported,
  threadAdded,
  threadReplaced,
  threadSelected,
  threadsLoaded,
  type ThreadsState,
  type ThreadsStore,
} from "./threads.ts";
import { createToastsStore, notifyProblem, ToastTone, type ToastsStore } from "./toasts.ts";
import { uiEventReads } from "./ui-event-routes.ts";
import { createUpdateStore, updateDownloaded, type UpdateStore } from "./update.ts";

/** The log is the source of truth; this poll is the safety net for anything the stream missed. */
export const EVENT_POLL_MS = 3 * SECOND_MS;

/** An agent screen that went away. */
const SCREEN_CLOSED: AgentScreenEvent["state"] = "closed";

export interface StudioTimers {
  setInterval(run: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(run: () => void, ms: number): unknown;
}

const browserTimers: StudioTimers = {
  setInterval: (run, ms) => globalThis.setInterval(run, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout: (run, ms) => globalThis.setTimeout(run, ms),
};

export interface Studio {
  readonly api: StudioApi;
  readonly session: SessionStore;
  readonly eventLog: EventLogStore;
  readonly threads: ThreadsStore;
  readonly library: LibraryStore;
  readonly engines: EnginesStore;
  readonly plugins: PluginsStore;
  readonly agentScreens: AgentScreensStore;
  readonly commandRuns: CommandRunsStore;
  /** What commands a reply offered have printed, outside React state. */
  readonly commandOutput: CommandOutput;
  readonly toasts: ToastsStore;
  readonly layout: LayoutStore;
  /** A game being started from home (`launch.ts`). */
  readonly launch: LaunchStore;
  /** Which subscription models the model picker lists, as set in Settings. */
  readonly modelPicker: ModelPickerStore;
  /** A new version of the app waiting for a restart. */
  readonly update: UpdateStore;
  /** Subscribe to main's events, start the poll and bootstrap. Returns the stop. */
  start(): () => void;
  /** (Re)load everything main knows; a newer call wins over one still in flight. */
  bootstrap(): Promise<void>;
  /** Feed one UI event to the stores (what the `onEvent` subscription does). */
  handleUiEvent(event: UiEvent): void;
  notify(text: string, tone?: ToastTone): void;
  /** Open a conversation the user picked. */
  selectThread(threadId: string): void;
  /** Go home: no conversation open, the composer that starts a new game. */
  goHome(): void;
  /** The first-launch welcome is done on this profile; home follows it. */
  finishWelcome(): void;
  /**
   * Open a game's chat (made on demand by main) and put the game on the stage. Resolves with the
   * chat, or null when main refused (the refusal is toasted). `open` carries out the selection
   * itself (a view transition wraps it when leaving home).
   */
  enterProject(name: string, hooks?: OpenHooks): Promise<ConversationRecord | null>;
  renameThread(threadId: string, title: string): void;
  addGame(game: GameProject): void;
  saveGame(name: string, patch: GameUpdate): Promise<void>;
  /** Remove a game. True when the stage held it and home opened in its place. */
  removeGame(name: string): Promise<boolean>;
  /** Send from the open conversation, then read what the send wrote. */
  send(text: string, options: ComposerSendOptions): Promise<void>;
  /**
   * Home's first message starts a game: named by the model picked, made where chosen, opened. The
   * game's chat then sends the message itself (`launchHanded`). A refusal is toasted, and the words
   * wait for home again. One launch at a time.
   */
  launchGame(input: LaunchInput): Promise<void>;
  /** The opened chat took the launch's message. */
  launchHanded(id: string): void;
  /** The launch's message is the chat's: the launch is over. */
  launchFinished(id: string): void;
  /** Home's composer took back a failed launch's words. */
  returnTaken(): void;
}

/** How a game's chat is opened: something to do with the chat first, and the way the selection is made. */
export interface OpenHooks {
  beforeOpen?: (record: ConversationRecord) => void;
  open?: (select: () => void) => void;
}

/** What home sends a new game: the message, what it carries, the model it was written for, and where it goes. */
export interface LaunchInput {
  text: string;
  extras?: ComposerExtras;
  /** The model key home's composer had (`engine::model`), and its effort. */
  modelKey: string | null;
  effort: string | null;
  /** A folder chosen at home; the games folder when absent. */
  parent?: string;
}

/** Every domain store, created together. */
interface Stores {
  readonly publication: ReturnType<typeof createPublicationBatch>;
  readonly session: SessionStore;
  readonly eventLog: EventLogStore;
  readonly threads: ThreadsStore;
  readonly library: LibraryStore;
  readonly engines: EnginesStore;
  readonly plugins: PluginsStore;
  readonly agentScreens: AgentScreensStore;
  readonly commandRuns: CommandRunsStore;
  readonly commandOutput: CommandOutput;
  readonly toasts: ToastsStore;
  readonly layout: LayoutStore;
  readonly launch: LaunchStore;
  readonly modelPicker: ModelPickerStore;
  readonly update: UpdateStore;
}

function createStores(
  api: StudioApi,
  storage: KeyValueStorage | null,
  timers: StudioTimers,
  visibility: VisibilitySource,
): Stores {
  const publication = createPublicationBatch(unstable_batchedUpdates);
  return {
    publication,
    session: createSessionStore(),
    eventLog: createEventLogStore(api, publication.publish),
    threads: createThreadsStore(api, {
      lastGameThreadId: readText(STORAGE_KEYS.lastGameThread, storage),
      publish: publication.publish,
    }),
    library: createLibraryStore(api, timers, visibility, publication.publish),
    engines: createEnginesStore(api),
    plugins: createPluginsStore(api),
    agentScreens: createAgentScreensStore(),
    commandRuns: createCommandRunsStore(),
    commandOutput: createCommandOutput(),
    toasts: createToastsStore((run, ms) => timers.setTimeout(run, ms)),
    layout: createLayoutStore(storage),
    launch: createLaunchStore(),
    modelPicker: createModelPickerStore(storage),
    update: createUpdateStore(),
  };
}

/** What the commands share: the api, the stores, the storage and the two app-wide actions. */
interface StudioContext {
  readonly api: StudioApi;
  readonly stores: Stores;
  readonly storage: KeyValueStorage | null;
  readonly follower: StageFollower;
  readonly visibility: VisibilitySource;
  /** The wall clock, for when a launch began. */
  now(): number;
  notify(text: string, tone?: ToastTone): void;
  selectThread(threadId: string): void;
}

interface StageFollower {
  /** The threads changed: load the stage's game if it moved, and remember the last game chat. */
  threadsChanged(): void;
  /** Run a change that loads the preview itself, so the follower leaves that one change alone. */
  whileLoading(project: string, change: () => void): void;
}

/**
 * The preview follows the game on the stage: whenever it changes to a game, main is asked to
 * load it. A command that loads the preview itself (opening a game) says so, and the follower
 * leaves that one change alone.
 */
function stageFollower(api: StudioApi, threads: ThreadsStore, storage: KeyValueStorage | null): StageFollower {
  let followed: string | null = projectOf(threads.getState());
  let loading: string | null = null;
  let lastGame = threads.getState().lastGameThreadId;
  const follow = (): void => {
    const project = projectOf(threads.getState());
    if (project === followed) return;
    followed = project;
    if (!project) return;
    writeText(STORAGE_KEYS.reviewProject, project, storage);
    if (project !== loading) void api.loadPreview(project);
  };
  const rememberLastGame = (): void => {
    const next = threads.getState().lastGameThreadId;
    if (next === lastGame) return;
    lastGame = next;
    if (next) writeText(STORAGE_KEYS.lastGameThread, next, storage);
    else removeKey(STORAGE_KEYS.lastGameThread, storage);
  };
  return {
    threadsChanged() {
      follow();
      rememberLastGame();
    },
    whileLoading(project, change) {
      loading = project;
      change();
      loading = null;
    },
  };
}

/**
 * The threads a bootstrap opens on: its records and status, and nothing selected. Every launch
 * starts at home, whatever was open last; ⌘1 and the sidebar go back to it.
 */
function openedThreads(state: ThreadsState, boot: Bootstrap): ThreadsState {
  return statusBootstrapped(threadsLoaded(state, boot.threads), boot.threadStatus);
}

/** (Re)load everything main knows; a newer call wins over one still in flight. */
function bootstrapper(api: StudioApi, stores: Stores, storage: KeyValueStorage | null): () => Promise<void> {
  const { session, eventLog, library, engines, threads, plugins, agentScreens, update } = stores;
  let generation = 0;
  return async () => {
    const version = ++generation;
    const superseded = (): boolean => version !== generation;
    session.setState((state) => bootstrapStarted(state), true);
    eventLog.unbootstrap();
    try {
      const boot = await api.bootstrap();
      if (superseded()) return;
      eventLog.bootstrap(boot);
      library.setState((state) => libraryBootstrapped(state, boot), true);
      engines.setState((state) => enginesLoaded(state, boot.engines), true);
      threads.setState((state) => openedThreads(state, boot), true);
      const welcome = shouldWelcome(boot.welcome, boot.games.length, safeStorage(storage));
      const developer = boot.developer;
      session.setState((state) => bootstrapReady(state, { welcome, developer }), true);
      void plugins.refresh();
      void plugins.refreshIndex();
      // An update downloaded before this window opened, or before a reload, still waits.
      const ready = await api.readyUpdate().catch(() => null);
      if (superseded()) return;
      update.setState((state) => updateDownloaded(state, ready), true);
      const staged = await api.staged().catch(() => []);
      if (superseded()) return;
      library.setState((state) => stagedCounted(state, staged.length), true);
      const screens = await api.agentScreens().catch(() => []);
      if (superseded()) return;
      agentScreens.setState((state) => screensLoaded(state, screens), true);
    } catch (error) {
      if (superseded()) return;
      session.setState((state) => bootstrapFailed(state, error instanceof Error ? error.message : String(error)), true);
    }
  };
}

/** The events that change a store directly, beyond the reads they ask for. */
function applyUiEvent({ agentScreens, threads, layout, library, update }: Stores, event: UiEvent): void {
  switch (event.type) {
    case UiEvent.PreviewFrame:
      agentScreens.setState((state) => frameReceived(state, event.payload), true);
      break;
    case UiEvent.PreviewScreen:
      if (event.payload.state === SCREEN_CLOSED)
        agentScreens.setState((state) => screenClosed(state, event.payload.handle), true);
      break;
    case UiEvent.HarnessState:
      // Only a ready harness has threads running; any other state leaves no working line.
      if (event.payload.state !== HarnessState.Ready) threads.setState((state) => harnessDown(state), true);
      break;
    case UiEvent.HarnessStatus: {
      const all = event.payload.all;
      if (all) threads.setState((state) => statusReported(state, all), true);
      break;
    }
    case UiEvent.StageShow:
      // The chat put a build on screen for the game on the stage: that is Live, so Live shows.
      if (event.payload.project === projectOf(threads.getState()))
        layout.setState((state) => stageViewChosen(state, event.payload.view), true);
      break;
    case UiEvent.UpdateReady:
      update.setState((state) => updateDownloaded(state, event.payload), true);
      break;
    case UiEvent.DelegationStarted:
    case UiEvent.DelegationFinished:
      library.setState(
        (state) =>
          delegationChanged(state, {
            started: event.type === UiEvent.DelegationStarted,
            project: event.payload?.project,
            active: event.payload?.active,
          }),
        true,
      );
      break;
  }
}

/** Read again what an event says changed. */
function refreshAfter(stores: Stores, event: UiEvent): void {
  if (event.type === UiEvent.GameChanged) {
    void stores.publication.run(() =>
      Promise.all([stores.threads.refresh(), stores.eventLog.refresh(), stores.library.refreshGames()]),
    );
    return;
  }
  const reads = uiEventReads(event);
  if (reads.threads) void stores.threads.refresh();
  if (reads.events) void stores.eventLog.refresh();
  if (reads.games) void stores.library.refreshGames();
  if (reads.staged) void stores.library.refreshStaged();
  if (reads.engines) void stores.engines.refresh();
  if (reads.plugins) {
    void stores.plugins.refresh();
    // A plugin that was just updated is no longer one the index has a newer release for.
    void stores.plugins.refreshIndex();
  }
  if (reads.assets) stores.library.refreshAssets(reads.assets.project);
}

/**
 * Open a game's chat (made on demand by main) and put the game on the stage. `beforeOpen` runs
 * with the chat before it is selected; `open` makes the selection (at once, by default).
 */
async function enterProject(
  ctx: StudioContext,
  name: string,
  { beforeOpen, open = (select) => select() }: OpenHooks = {},
): Promise<ConversationRecord | null> {
  const { api, stores, storage, notify } = ctx;
  let record: ConversationRecord;
  try {
    record = await api.threadForGame(name);
  } catch (error) {
    notify(problemWords(error), ToastTone.Error);
    return null;
  }
  stores.threads.setState((state) => threadAdded(state, record), true);
  beforeOpen?.(record);
  // This command loads the preview itself (and re-reads the library after it), so the
  // follower leaves the change it is about to see alone.
  open(() =>
    ctx.follower.whileLoading(name, () => {
      ctx.selectThread(record.id);
      if (!isGameThread(record)) stores.threads.setState((state) => stageProjectSet(state, name), true);
    }),
  );
  writeText(STORAGE_KEYS.reviewProject, name, storage);
  void api
    .loadPreview(name)
    .then(() => stores.library.refreshGames())
    .catch(notifyProblem(notify));
  return record;
}

/** Untitled game: what a game is called when even naming it failed. */
const UNTITLED_GAME = "Untitled game";
let launches = 0;

/** The name for a launch's game: the model's, else Untitled game, waiting for an idea. Never fails. */
async function launchName(api: StudioApi, input: LaunchInput): Promise<GameName> {
  const { engine, model } = parseModelKey(input.modelKey);
  const request = { prompt: input.text, ...(engine ? { engine } : {}), ...(model ? { model } : {}) };
  const named = await api.nameGame(request).catch(() => null);
  const title = named?.title.trim();
  if (!title) return { title: UNTITLED_GAME, provisional: true };
  return named?.provisional ? { title, provisional: true } : { title };
}

/** The new chat opens on home's model and effort, the ones its first message was written for. */
function keepComposerChoice(storage: KeyValueStorage | null, threadId: string, input: LaunchInput): void {
  const kept = safeStorage(storage);
  if (input.modelKey) rememberChatModel(kept, threadId, input.modelKey);
  if (input.effort) rememberChatEffort(kept, threadId, input.effort);
}

async function launchGame(ctx: StudioContext, input: LaunchInput): Promise<void> {
  const { api, stores, storage, notify } = ctx;
  const { launch } = stores;
  if (launch.getState().launch) return;
  const id = `launch-${++launches}`;
  launch.setState((state) => launchStarted(state, { id, text: input.text, extras: input.extras, at: ctx.now() }), true);
  const { title, provisional } = await launchName(api, input);
  launch.setState((state) => launchNamed(state, id, title), true);
  try {
    const options = { ...(input.parent ? { parent: input.parent } : {}), ...(provisional ? { provisional } : {}) };
    const game = await api.createGame(title, ...(Object.keys(options).length ? [options] : []));
    // The launch learns its game as the library lists it, so its placeholder row never sits
    // beside the game's own while the chat opens (a library refresh can land first).
    launch.setState((state) => launchMade(state, id, game.name), true);
    stores.library.setState((state) => gameAdded(state, game), true);
    const record = await enterProject(ctx, game.name, {
      beforeOpen: (opened) => keepComposerChoice(storage, opened.id, input),
    });
    if (!record) {
      launch.setState((state) => launchFailed(state, id), true);
      return;
    }
    launch.setState((state) => launchOpened(state, id, { project: game.name, threadId: record.id }), true);
  } catch (error) {
    notify(problemWords(error), ToastTone.Error);
    launch.setState((state) => launchFailed(state, id), true);
  }
}

/** Remove a game. True when the stage held it and home opened in its place. */
async function removeGame({ stores, storage }: StudioContext, name: string): Promise<boolean> {
  const { library, threads } = stores;
  await library.removeGame(name);
  if (readText(STORAGE_KEYS.reviewProject, storage) === name) removeKey(STORAGE_KEYS.reviewProject, storage);
  const before = threads.getState();
  if (projectOf(before) !== name) return false;
  threads.setState((state) => gameRemovedFromThreads(state, name), true);
  const after = threads.getState();
  if (after.activeThreadId && after.activeThreadId !== before.activeThreadId)
    writeText(STORAGE_KEYS.activeThread, after.activeThreadId, storage);
  return true;
}

/** Subscribe to main's events and start the poll and the bootstrap. Returns the stop. */
function startStores(ctx: StudioContext, bootstrap: () => Promise<void>, timers: StudioTimers): () => void {
  const { api, stores, follower } = ctx;
  const unfollow = stores.threads.subscribe((state, previous) => {
    follower.threadsChanged();
    if (state.records === previous.records) return;
    const ids = new Set(state.records.filter((record) => !record.metadata?.archived).map((record) => record.id));
    for (const record of previous.records) if (!ids.has(record.id)) stores.eventLog.forgetThread(record.id);
  });
  const off = api.onEvent((event) => {
    applyUiEvent(stores, event);
    refreshAfter(stores, event);
  });
  const offTerminal = api.onTerminal((event) => {
    stores.commandOutput.terminalEvent(event);
    stores.commandRuns.setState((state) => terminalChanged(state, event), true);
  });
  // Ticks before the bootstrap has set the cursor defer to one read right after it.
  const refresh = () => {
    if (!ctx.visibility.hidden()) void stores.eventLog.refresh();
  };
  const poll = timers.setInterval(refresh, EVENT_POLL_MS);
  // A release published while the studio runs is offered without a restart.
  const indexPoll = timers.setInterval(() => {
    if (!ctx.visibility.hidden()) void stores.plugins.refreshIndex();
  }, PLUGIN_INDEX_POLL_MS);
  const unwatchVisibility = ctx.visibility.subscribe(refresh);
  void bootstrap();
  return () => {
    off();
    offTerminal();
    unfollow();
    unwatchVisibility();
    timers.clearInterval(poll);
    timers.clearInterval(indexPoll);
  };
}

export function createStudio(
  api: StudioApi,
  options: {
    storage?: KeyValueStorage | null;
    timers?: StudioTimers;
    visibility?: VisibilitySource;
    now?: () => number;
  } = {},
): Studio {
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  const timers = options.timers ?? browserTimers;
  const visibility = options.visibility ?? browserVisibility;
  const stores = createStores(api, storage, timers, visibility);
  const { session, threads, library } = stores;
  const notify = (text: string, tone: ToastTone = ToastTone.Info): void => stores.toasts.notify(text, tone);
  const selectThread = (threadId: string): void => {
    threads.setState((state) => threadSelected(state, threadId), true);
    writeText(STORAGE_KEYS.activeThread, threadId, storage);
  };
  const follower = stageFollower(api, threads, storage);
  const ctx: StudioContext = {
    visibility,
    now: options.now ?? Date.now,
    api,
    stores,
    storage,
    follower,
    notify,
    selectThread,
  };
  const bootstrap = bootstrapper(api, stores, storage);

  return {
    api,
    ...stores,
    start: () => startStores(ctx, bootstrap, timers),
    bootstrap,
    handleUiEvent(event) {
      applyUiEvent(stores, event);
      refreshAfter(stores, event);
    },
    notify,
    selectThread,
    goHome() {
      threads.setState((state) => threadSelected(state, null), true);
    },
    finishWelcome() {
      writeText(STORAGE_KEYS.welcomed, "1", storage);
      session.setState((state) => welcomeFinished(state), true);
    },
    enterProject: (name, hooks) => enterProject(ctx, name, hooks),
    renameThread(threadId, title) {
      void api
        .renameThread(threadId, title)
        .then((record) => threads.setState((state) => threadReplaced(state, record), true), notifyProblem(notify));
    },
    addGame(game) {
      library.setState((state) => gameAdded(state, game), true);
    },
    saveGame: (name, patch) => library.saveGame(name, patch),
    removeGame: (name) => removeGame(ctx, name),
    launchGame: (input) => launchGame(ctx, input),
    launchHanded(id) {
      stores.launch.setState((state) => launchHanded(state, id), true);
    },
    launchFinished(id) {
      stores.launch.setState((state) => launchFinished(state, id), true);
    },
    returnTaken() {
      stores.launch.setState((state) => returnTaken(state), true);
    },
    async send(text, sendOptions) {
      const thread = threads.getState().activeThreadId;
      await api.send(text, { ...(thread ? { thread } : {}), ...sendOptions });
      await stores.eventLog.refresh();
      void library.refreshGames();
      void threads.refresh();
    },
  };
}

let instance: Studio | null = null;
let started = false;

/** The app's one studio, over the preload's `window.studio`. */
export function studio(): Studio {
  instance ??= createStudio(window.studio);
  return instance;
}

/** Wire the app's studio once: before React mounts, so no effect ever subscribes it. */
export function startStudio(): Studio {
  const current = studio();
  if (!started) {
    started = true;
    current.start();
  }
  return current;
}
