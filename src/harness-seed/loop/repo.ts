/**
 * How the studio touches a game's repository — one committer, refs nobody has to look at, and
 * one place for a builder's notes.
 *
 * The morning after the first real run, the user's own repo held eleven `attempt/*` branches,
 * a `snap/*` tag that `git push --tags` would have shipped, seven `NOTES.<facet>.md` beside the
 * one they wrote, and four committer names in `git log`. None of that is theirs to keep. What
 * the run must be able to find again lives under `refs/studio/…`: a real ref, reachable by
 * hash and by name, that `git branch`, `git tag` and `git log --oneline` never show. What the
 * builders write down lives under `docs/notes/`, one folder, out of the root.
 *
 * Snapshot commits still land on the user's branch — that is Rewind,
 * the optimizer baseline and `landBuild`'s ancestor test, and it moves on its own day.
 */

/** The one name every studio commit carries, wherever in the run it is made. */
export const STUDIO_COMMITTER = { name: "AI Game Studio", email: "studio@ai-game-studio.local" };

/**
 * The `-c` flags that put that name on a commit, spliced into the git command lines the harness
 * runs through `run.exec` (`/bin/sh -c`, so the quoted name survives the space).
 */
export const STUDIO_AS = `-c user.name="${STUDIO_COMMITTER.name}" -c user.email=${STUDIO_COMMITTER.email}`;

/** Everything one run keeps: `refs/studio/runs/<runId>/…` — integration, workers, attempts, spikes. */
export function runRef(runId: string, ...parts: Array<string | number>): string {
  return ["refs/studio/runs", String(runId), ...parts.map((part) => String(part))].join("/");
}

/**
 * A round the loop did not keep: its code, committed and bookmarked so the next brief can name
 * it and a morning can still read it. `stopped` marks the round a stop ended rather than a
 * verdict.
 */
export function attemptRef(
  runId: string,
  facetId: string,
  iteration: number | string,
  { stopped = false }: { stopped?: boolean } = {},
): string {
  return runRef(runId, "attempts", facetId, `${iteration}${stopped ? "-stopped" : ""}`);
}

/** A spike's worktree commit, kept the same way: the technique is there whether it passed or not. */
export function spikeRef(runId: string, facetId: string, spikeId: string): string {
  return runRef(runId, "spikes", facetId, spikeId);
}

/** Where a builder keeps its own working notes — never the root, which is the game's own. */
export function facetNotes(facetId: string): string {
  return `docs/notes/NOTES.${facetId}.md`;
}
