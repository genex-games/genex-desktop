/**
 * Why the stage cannot show a game that builds itself.
 *
 * Until now a failed build reached exactly two places: the game's own console, and the agent
 * loop. The user saw a black rectangle and no sentence (`studio-core.ts` set `loadError` and no
 * renderer file read it). This is that sentence's payload — structured, so the stage owns the
 * words and this file owns none of them.
 */
export interface BuildProblem {
  project: string;
  /** The command that failed, shown only behind "Details". */
  command: string;
  /** Its exit code; null when it was killed. */
  code: number | null;
  /** The first three lines of what it printed — the part that names the error. */
  lines: string[];
  /** Dependencies are declared and node_modules is not there: offer "Install packages". */
  needsInstall: boolean;
  /** What that button runs (`npm install`, `pnpm install`, …); null when there is nothing to install. */
  install: string | null;
  /** The stage is showing the last build that worked instead of nothing at all. */
  showingLastBuild: boolean;
  /**
   * A remix's setup scripts its script-free install skipped, which it may need to build: the stage
   * offers to run them once the person trusts the game. Null for a game whose scripts ran.
   */
  skippedScripts: SetupScripts | null;
  at: string;
}

/** The setup scripts a script-free install skipped: the game's own, and its packages' by name. */
export interface SetupScripts {
  own: boolean;
  packages: string[];
}

/** What one press of "Install packages" did. */
export interface InstallResult {
  ok: boolean;
  /** The last few lines of the install, for the same "Details" disclosure. */
  lines: string[];
}
