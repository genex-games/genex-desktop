/** How the Builds bar holds the chat's builds (tabs while they read, else one picker) and what its Play plays. */
import type { HistoryEntry } from "../../build-progress.ts";

/** The most builds the bar shows as tabs; past it, one picker holds them all. */
export const MAX_BUILD_TABS = 3;
/** The narrowest a tab may be and still read as a name (about 16 characters), in px. */
export const READABLE_TAB_PX = 150;
/**
 * What the bar keeps for Play whatever its label reads ("Play", "Play latest", "Opening…"): the
 * widest, with the bar's padding and the gap before it, in px. Measured off the label, pressing Play
 * near the edge would swap tabs for the picker and back.
 */
export const PLAY_ROOM_PX = 160;

/** The bar's two shapes. */
export const BuildBarShape = { Tabs: "tabs", Picker: "picker" } as const;
export type BuildBarShape = (typeof BuildBarShape)[keyof typeof BuildBarShape];

/**
 * Tabs for up to three builds while each has room to read; more builds, or a panel too narrow for
 * their names, get the picker. One build is always its own tab: there is nothing to pick between.
 * `room` is the bar's width less `PLAY_ROOM_PX`, in px.
 */
export function buildBarShape(count: number, room: number): BuildBarShape {
  if (count > MAX_BUILD_TABS) return BuildBarShape.Picker;
  const cramped = count > 1 && room < count * READABLE_TAB_PX;
  return cramped ? BuildBarShape.Picker : BuildBarShape.Tabs;
}

/** The picker's list: the newest build first, the history itself left as it is. */
export const newestFirst = (builds: readonly HistoryEntry[]): HistoryEntry[] => [...builds].reverse();

/** What Play on the bar does. */
type PlayAction = () => Promise<void> | void;

/**
 * The bar's Play stays for every build: the open build's own when it made one, else Live as the game
 * is now. Only with neither is there nothing to play.
 */
export function barPlay(hasBuild: boolean, play: PlayAction, showLive: (() => void) | undefined): PlayAction | null {
  if (hasBuild) return play;
  return showLive ? () => showLive() : null;
}
