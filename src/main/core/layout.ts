/** Where the studio keeps its own state under userData: the event store, workspaces, runs and homes. */
import path from "node:path";

// A type alias, not an interface: the bootstrap hands it to the renderer as `Record<string, string>`.
export type StudioLayout = {
  exoharness: string;
  workspaces: string;
  harnessWs: string;
  gamesRoot: string;
  secrets: string;
  scratch: string;
  runs: string;
  updates: string;
  engineHomes: string;
  exports: string;
  /**
   * Agent jobs' records and logs, one folder per game. Never writable by an agent process: it sits
   * outside every writable root and inside the never-touch list's Genex data.
   */
  jobs: string;
  /**
   * The homes of Loops' reviewers, one fresh folder per call. Never writable by an agent process
   * (unlike scratch), so no box can swap a folder on the way for a link while the host makes one.
   */
  reviewers: string;
};

export function layoutFor(userData: string): StudioLayout {
  return {
    exoharness: path.join(userData, "exoharness"),
    workspaces: path.join(userData, "workspaces"),
    harnessWs: path.join(userData, "workspaces", "harness"),
    gamesRoot: path.join(userData, "workspaces", "games"),
    secrets: path.join(userData, "secrets"),
    scratch: path.join(userData, "scratch"),
    runs: path.join(userData, "runs"),
    updates: path.join(userData, "updates"),
    engineHomes: path.join(userData, "engine-homes"),
    exports: path.join(userData, "exports"),
    jobs: path.join(userData, "jobs"),
    reviewers: path.join(userData, "reviewers"),
  };
}
