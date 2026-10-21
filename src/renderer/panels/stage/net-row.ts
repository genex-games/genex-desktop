/**
 * Live's net row for a Rust game built with `[net]` (game-systems MP-7), pure: what the row says
 * about the game's seat (its backend, where the seat stands, why it is offline, the players), and
 * the poll that reads the game's `__net` through the Live page's existing state read
 * (`previewState`, after `previewLive` says the page is this game's). A game with no `__net` has
 * no row. `NetRow.tsx` renders it; the conformance tests hold it without a DOM, on a fake clock.
 */
import { SECOND_MS } from "../../../shared/duration.ts";
import { type NetView, netViewOf } from "../../../shared/game-net.ts";
import type { NativeTimers } from "../../../shared/native-contract.ts";
import type { StudioApi } from "../../../shared/studio-api.ts";
import { NET_WORDS } from "../../words.ts";

/** How often the row reads the Live page's net view, the next read only after the last answered. */
export const NET_POLL_MS = 2 * SECOND_MS;

/** What the row shows for one game's seat. */
export interface NetRowView {
  /** The seat's wire status, for the row's `data-stage-net` selector. */
  status: NetView["status"];
  /** The backend the build chose, in words. */
  mode: string;
  /** Where the seat stands, in words. */
  title: string;
  /** Why the seat is offline, in words; null while it is not. */
  reason: string | null;
  /** The room's players, in words; null while the seat holds none. */
  players: string | null;
}

/** The row for a game's net view, or null when the game reports none. */
export function netRowView(view: NetView | null): NetRowView | null {
  if (!view) return null;
  return {
    status: view.status,
    mode: NET_WORDS.mode[view.mode],
    title: NET_WORDS.status[view.status],
    reason: view.reason ? NET_WORDS.reason[view.reason] : null,
    players: view.players > 0 ? NET_WORDS.players(view.players, view.connected) : null,
  };
}

/** What the poll reads the Live page through: the existing preview reads, no channel of its own. */
export type NetRowApi = Pick<StudioApi, "previewLive" | "previewState">;

/** A running poll; `stop` ends it, and an answer still on its way is dropped. */
export interface NetPoll {
  stop(): void;
}

/**
 * The net view of `project`'s Live page, or null when Live holds another game's page, is loading
 * or stopped, or the read failed. Never another game's state.
 */
async function readNetView(api: NetRowApi, project: string): Promise<NetView | null> {
  const live = await api.previewLive();
  // The page is this game's, loaded, and playing: anything else says nothing about its seat.
  const playing = live.project === project && !live.navigating && !live.stopped && live.page !== null;
  if (!playing) return null;
  return netViewOf(await api.previewState());
}

/** Poll `project`'s net view every {@link NET_POLL_MS} on `timers`, handing each read to `onView`. */
export function startNetPoll(
  api: NetRowApi,
  timers: NativeTimers,
  project: string,
  onView: (view: NetView | null) => void,
): NetPoll {
  const poll: { stopped: boolean; timer: unknown } = { stopped: false, timer: null };
  const tick = async (): Promise<void> => {
    const view = await readNetView(api, project).catch(() => null);
    if (poll.stopped) return;
    onView(view);
    poll.timer = timers.setTimeout(() => void tick(), NET_POLL_MS);
  };
  void tick();
  return {
    stop(): void {
      poll.stopped = true;
      timers.clearTimeout(poll.timer);
    },
  };
}
