/**
 * Live stays still while the person watches it (docs/product/builds-live.md). A change nobody on
 * the stage asked for marks Live behind instead of reloading it, and the stage's Reload says why.
 */

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
