/**
 * Live stays still while the person watches it (docs/product/builds-live.md). A change nobody on
 * the stage asked for marks Live behind instead of reloading it, and the stage's Reload says why.
 */
import { BuildTarget } from "./game-project.ts";

/** Why Live is behind what it could show. */
export const LiveBehindReason = {
  /** The game folder changed since Live loaded it. */
  Changed: "changed",
  /** A build of a run is ready to play. */
  Build: "build",
  /** The build Live shows was found not to run; Reload goes back to the game folder. */
  Broken: "broken",
} as const;
export type LiveBehindReason = (typeof LiveBehindReason)[keyof typeof LiveBehindReason];

/** What Live did when the stage asked for the game's web build (`loadWebBuild`). Wire values: never rename one. */
export const WebBuildLoad = {
  /** Live loaded the finished build. */
  Loaded: "loaded",
  /** The build is still being written: ask again once it has settled. */
  Unfinished: "unfinished",
  /** Live is left as it is: it has the build, holds another game or a chosen build, the game is stopped, or the load failed. */
  Kept: "kept",
} as const;
export type WebBuildLoad = (typeof WebBuildLoad)[keyof typeof WebBuildLoad];

/**
 * The `live.behind` UI event, and what the stage reads on mount (`liveBehind`): what main is holding
 * for Live's Reload (`reason: null` once Live is current), and the build Live shows. Main sends it
 * whenever either changes, whichever path loaded Live.
 */
export interface LiveBehindEvent {
  project: string;
  reason: LiveBehindReason | null;
  /** The build Reload would play, when it is a run's build. */
  commit: string | null;
  /** A builder's own words about the change (its checkpoint note), when it gave some. */
  note: string | null;
  /** The build Live shows now, by commit: null for the game folder (or a build whose commit is not known). */
  shows: string | null;
}

/**
 * What Live's background build of the game folder came to (`prepareLiveBuild`): after the folder
 * changed under a compiled game's Live, the build its Reload would play is made while Live keeps
 * the earlier one. Wire values: never rename one.
 */
export const LivePrepare = {
  /** The build for the view is made: Reload plays it at once. */
  Built: "built",
  /** The build failed: Live keeps the earlier one, and Reload shows why. */
  Failed: "failed",
  /** Nothing to build: Live shows another folder or game, the game has its build already, or it builds no such destination. */
  Skipped: "skipped",
} as const;
export type LivePrepare = (typeof LivePrepare)[keyof typeof LivePrepare];

/** The destinations Live builds in the background: its web view's and its Native view's. */
export const LIVE_PREPARE_TARGETS = [BuildTarget.Web, BuildTarget.Mac] as const;
export type LivePrepareTarget = (typeof LIVE_PREPARE_TARGETS)[number];

/** Whether `value` is a destination Live builds in the background. */
export const isLivePrepareTarget = (value: unknown): value is LivePrepareTarget =>
  LIVE_PREPARE_TARGETS.some((target) => target === value);
