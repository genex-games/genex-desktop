/**
 * Where a session's pictures land: under the run's folder, one folder per facet and kind, one
 * `iter_NNN` folder per iteration. Every name that reaches a path is made a plain segment first.
 */
import path from "node:path";

/** Which session took the pictures: a builder looking at its own build. */
export const ShotKind = {
  Self: "self",
} as const;
export type ShotKind = (typeof ShotKind)[keyof typeof ShotKind];

/** The run folder of a session that names no run. */
const ADHOC_RUN = "adhoc";
/** The facet folder of a session that names no facet. */
const DEFAULT_FACET = "build";

/** A name made safe to use as one path segment: anything but letters, digits, `-` and `_` becomes `-`. */
export function safePathSegment(value: string): string {
  return value.replace(/[^a-z0-9-_]/gi, "-");
}

/** A run's own folder under the runs root. */
export function runDir(runsRoot: string, runId: string | null | undefined): string {
  return path.join(runsRoot, safePathSegment(runId ?? ADHOC_RUN));
}

/** `<runs>/<run>/facet_<facet>/<kind>`: where one facet's pictures of this kind land. */
export function runShotsDir(
  runsRoot: string,
  runId: string | null | undefined,
  facetId: string | null | undefined,
  kind: ShotKind,
): string {
  return path.join(runDir(runsRoot, runId), `facet_${safePathSegment(facetId ?? DEFAULT_FACET)}`, kind);
}

/** `iter_NNN` under a shots folder: one iteration's pictures. */
export function iterationDir(shotsDir: string, iteration: number | null | undefined): string {
  return path.join(shotsDir, `iter_${String(iteration ?? 0).padStart(3, "0")}`);
}
