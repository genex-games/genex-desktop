/**
 * Live's profile strip, per game (game-systems PROF-7): whether the person opened it, the summary
 * polls it keeps for the sparkline, whether GPU nodes are armed and their last times, why there is
 * no profile, and the crash record the card shows. The strip polls `studio:native.profile` every
 * {@link PROFILE_POLL_MS} only while it is open; closing it stops the poll and forgets the polls.
 *
 * Actions are pure `(state, input) => state`; `createLiveProfileStore` binds them to a `StudioApi`
 * and an injected clock, and `liveProfileStoreFor` keeps the app's one store.
 */
import { createStore, type StoreApi } from "zustand/vanilla";
import type { GameCrashEntry } from "../../shared/crash-record.ts";
import {
  FrameProfileAction,
  type FrameProfileAnswer,
  GpuTimingMode,
  type ProfileReportV2,
  type ProfileSummaryV1,
  type ProfileUnavailableReason,
} from "../../shared/frame-profile.ts";
import type { NativeTimers } from "../../shared/native-contract.ts";
import type { StudioApi } from "../../shared/studio-api.ts";
import { type GpuNodeRow, gpuNodeRows, type ProfilePoint, profilePointOf, withPoint } from "../live-profile.ts";

/** How often an open strip asks for the summary. */
export const PROFILE_POLL_MS = 500;
/** The frames an armed strip's report asks for (its GPU nodes are their mean). */
export const PROFILE_NODE_FRAMES = 30;

/** One game's strip. */
export interface LiveProfileGame {
  open: boolean;
  armed: boolean;
  history: readonly ProfilePoint[];
  summary: ProfileSummaryV1 | null;
  nodes: readonly GpuNodeRow[];
  /** Why the last poll had no profile; null when it had one (or none answered yet). */
  unavailable: ProfileUnavailableReason | null;
  /** The last poll failed outright (no answer). */
  failed: boolean;
  /** The kept record of the shown run's crash, once read. */
  crash: GameCrashEntry | null;
}

/** Every game's strip, by game name. */
export interface LiveProfileState {
  games: Readonly<Record<string, LiveProfileGame>>;
}

const CLOSED: LiveProfileGame = Object.freeze({
  open: false,
  armed: false,
  history: Object.freeze([]),
  summary: null,
  nodes: Object.freeze([]),
  unavailable: null,
  failed: false,
  crash: null,
});

/** Nothing open. */
export const initialLiveProfile = (): LiveProfileState => ({ games: {} });

/** `project`'s strip as the store holds it; a game nobody opened is closed. */
export const liveProfileOf = (state: LiveProfileState, project: string | null | undefined): LiveProfileGame =>
  (project ? state.games[project] : undefined) ?? CLOSED;

function withGame(state: LiveProfileState, project: string, change: Partial<LiveProfileGame>): LiveProfileState {
  return { games: { ...state.games, [project]: { ...liveProfileOf(state, project), ...change } } };
}

/** The person opened the strip. */
export const profileOpened = (state: LiveProfileState, project: string): LiveProfileState =>
  withGame(state, project, { open: true });

/** The person closed it: its polls, nodes and reasons are forgotten; a crash record is kept. */
export function profileClosed(state: LiveProfileState, project: string): LiveProfileState {
  const crash = liveProfileOf(state, project).crash;
  return withGame(state, project, { ...CLOSED, crash });
}

const isUnavailable = (
  answer: FrameProfileAnswer,
): answer is { state: "unavailable"; reason: ProfileUnavailableReason } =>
  "state" in answer && answer.state === "unavailable";
const isSummary = (answer: FrameProfileAnswer): answer is ProfileSummaryV1 => "v" in answer && answer.v === 1;

/** A summary poll answered: a point for the sparkline, or why there is no profile. Ignored on a closed strip. */
export function profileRead(state: LiveProfileState, project: string, answer: FrameProfileAnswer): LiveProfileState {
  const game = liveProfileOf(state, project);
  if (!game.open) return state;
  if (isUnavailable(answer)) return withGame(state, project, { unavailable: answer.reason, failed: false });
  if (!isSummary(answer)) return state;
  return withGame(state, project, {
    summary: answer,
    history: withPoint(game.history, profilePointOf(answer)),
    unavailable: null,
    failed: false,
  });
}

/** A poll failed outright. */
export const profileFailed = (state: LiveProfileState, project: string): LiveProfileState =>
  liveProfileOf(state, project).open ? withGame(state, project, { failed: true }) : state;

/** GPU nodes armed or disarmed, as the game answered; disarming forgets their times. */
export const nodesArmed = (state: LiveProfileState, project: string, armed: boolean): LiveProfileState =>
  withGame(state, project, armed ? { armed } : { armed, nodes: [] });

/** An armed strip's report answered: its GPU nodes. */
export function nodesRead(state: LiveProfileState, project: string, report: ProfileReportV2): LiveProfileState {
  const game = liveProfileOf(state, project);
  return game.open && game.armed ? withGame(state, project, { nodes: gpuNodeRows(report) }) : state;
}

/** The shown run's crash record, or none. */
export const crashRead = (state: LiveProfileState, project: string, crash: GameCrashEntry | null): LiveProfileState =>
  withGame(state, project, { crash });

/** What the store reaches the host through. */
export type LiveProfileApi = Pick<StudioApi, "nativeProfile" | "gameCrashes">;

/** What the strip and the card do with the store. */
export interface LiveProfileStore extends StoreApi<LiveProfileState> {
  /** Open `project`'s strip and poll it until {@link LiveProfileStore.close}. */
  open(project: string): void;
  close(project: string): void;
  /** Arm or disarm per-node GPU timing; resolves once the game answered. */
  arm(project: string, on: boolean): Promise<void>;
  /** Read the kept record `crashId` of `project` for the card. */
  readCrash(project: string, crashId: string): Promise<void>;
}

const isReport = (answer: FrameProfileAnswer): answer is ProfileReportV2 => "v" in answer && answer.v === 2;
const isArmAnswer = (answer: FrameProfileAnswer): answer is { mode: GpuTimingMode } => "mode" in answer;

/** The store over `api`, polling on `timers` (a fake clock in tests). */
export function createLiveProfileStore(api: LiveProfileApi, timers: NativeTimers): LiveProfileStore {
  const store = createStore<LiveProfileState>(() => initialLiveProfile());
  /** Each open strip's poll: replaced on every open, so a tick of an earlier open never schedules again. */
  const polls = new Map<string, { timer: unknown }>();
  const apply = (action: (state: LiveProfileState) => LiveProfileState): void =>
    store.setState(action(store.getState()));

  // One summary (and an armed strip's report) per tick, the next tick only after it answered.
  const tick = async (project: string, poll: { timer: unknown }): Promise<void> => {
    try {
      const summary = await api.nativeProfile(project, { action: FrameProfileAction.Summary });
      if (polls.get(project) !== poll) return;
      apply((state) => profileRead(state, project, summary));
      if (liveProfileOf(store.getState(), project).armed) {
        const report = await api.nativeProfile(project, {
          action: FrameProfileAction.Report,
          frames: PROFILE_NODE_FRAMES,
        });
        if (isReport(report)) apply((state) => nodesRead(state, project, report));
      }
    } catch {
      if (polls.get(project) === poll) apply((state) => profileFailed(state, project));
    }
    if (polls.get(project) === poll) poll.timer = timers.setTimeout(() => void tick(project, poll), PROFILE_POLL_MS);
  };

  return Object.assign(store, {
    open(project: string): void {
      if (polls.has(project)) return;
      apply((state) => profileOpened(state, project));
      const poll = { timer: null };
      polls.set(project, poll);
      void tick(project, poll);
    },
    close(project: string): void {
      timers.clearTimeout(polls.get(project)?.timer);
      polls.delete(project);
      apply((state) => profileClosed(state, project));
    },
    async arm(project: string, on: boolean): Promise<void> {
      const mode = on ? GpuTimingMode.Nodes : GpuTimingMode.Frame;
      const answer = await api.nativeProfile(project, { action: FrameProfileAction.Arm, mode });
      if (isArmAnswer(answer)) apply((state) => nodesArmed(state, project, answer.mode === GpuTimingMode.Nodes));
    },
    async readCrash(project: string, crashId: string): Promise<void> {
      const answer = await api.gameCrashes(project);
      const entry = "records" in answer ? (answer.records.find((record) => record.crashId === crashId) ?? null) : null;
      apply((state) => crashRead(state, project, entry));
    },
  });
}

/** The renderer's clock. */
const WINDOW_TIMERS: NativeTimers = {
  now: () => Date.now(),
  setTimeout: (run, ms) => window.setTimeout(run, ms),
  clearTimeout: (handle) => {
    if (typeof handle === "number") window.clearTimeout(handle);
  },
};

const stores = new WeakMap<LiveProfileApi, LiveProfileStore>();

/** The app's one live profile store over `api`. */
export function liveProfileStoreFor(api: LiveProfileApi): LiveProfileStore {
  let store = stores.get(api);
  if (!store) {
    store = createLiveProfileStore(api, WINDOW_TIMERS);
    stores.set(api, store);
  }
  return store;
}
