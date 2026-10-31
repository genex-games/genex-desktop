/**
 * A Loop's build history on the Builds graph: its integration head as a timeline. Each health check
 * the Loop ran (`integration_health`) is one build, "Build 1", "Build 2", …: the merge before it and
 * the check itself, wearing the check's screenshot and outcome. A check of the head the build before
 * it already had (the finish looking again at an unchanged head) is that build looked at again.
 *
 * A worker hangs off the build its work was merged into; one not merged (working, not used,
 * stopped) hangs off the build it started from, or the lead when it started before the first build.
 * Per build, finished workers past a few fold into one card that opens in place.
 *
 * Only a run whose checks name their pictures, workers or findings has a history: older runs keep
 * the graph they always had. Pure: no DOM, no window. `run-tree.ts` lays it out through
 * `panels/run-graph/timeline-layout.ts`; the tests read it directly.
 */
import { HealthFinding } from "../shared/preview-contract.ts";
import type { HealthLook, RunGraph } from "./run-graph.ts";
import { isLiveStep, type PartRow, type Step, StepState, stepWord } from "./run-steps.ts";
import { BUILD_LINE_WORDS, workerPlaceWords } from "./words.ts";

/** How many finished workers a build shows before the rest fold into one card. */
export const WORKERS_SHOWN = 3;

/** What a build's health check found: it passed, its frame was blank, it threw, or it failed some other way. */
export const BuildOutcome = {
  Passed: "passed",
  Blank: "blank",
  Errors: "errors",
  /** not passed, with no code of the host's to say why: a check never made, or an older record */
  Failed: "failed",
} as const;
export type BuildOutcome = (typeof BuildOutcome)[keyof typeof BuildOutcome];

/** The codes that mean the page broke rather than drew nothing. */
const BROKEN: ReadonlySet<HealthFinding> = new Set([
  HealthFinding.NotLoaded,
  HealthFinding.Crashed,
  HealthFinding.Uncaught,
]);

/** One build of the timeline. */
export interface BuildCard {
  /** its selection id, `build:<n>` */
  id: string;
  /** 1 for the first build */
  n: number;
  head: string | null;
  outcome: BuildOutcome;
  /** what its newest check found wrong, in the host's words */
  problems: string[];
  /** the host's codes for them (none on older records) */
  findings: HealthFinding[];
  /** its newest check's screenshot, under the run folder */
  picture: string | null;
  /** the part whose worker's merge made it; null for the lead's own work */
  worker: string | null;
  /** its first check's place in the log: when the build was made */
  seq: number;
}

/** Where one worker hangs: the build (0 for the lead, before the first build) and whether its work is in it. */
export interface WorkerPlace {
  build: number;
  merged: boolean;
}

/** What hangs off one build: the workers it shows, and how many finished ones are folded. */
export interface BuildHangers {
  /** 0 for the lead, else the build's `n` */
  build: number;
  steps: Step[];
  /** how many finished workers the fold card stands for (open or not) */
  folded: number;
  /** the fold is open: every worker shows, and its card folds them again */
  open: boolean;
}

/** A run's build history as the graph draws it. */
export interface BuildTimeline {
  builds: BuildCard[];
  /** every worker's place, by its step's id */
  places: Map<string, WorkerPlace>;
  /** what hangs off the lead (index 0) and each build, in order */
  hangers: BuildHangers[];
}

const BUILD_PREFIX = "build:";
const FOLD_PREFIX = "fold:";

/** The selection id of build `n`. */
export const buildSelection = (n: number): string => `${BUILD_PREFIX}${n}`;
/** Whether a selection id names a build of the timeline. */
export const isBuildSelection = (id: string): boolean => id.startsWith(BUILD_PREFIX);
/** The layout id of the card that folds a build's workers (0: the lead's). */
export const foldId = (build: number): string => `${FOLD_PREFIX}${build}`;

/** A check written since checks named their pictures, workers or findings. */
const isNewCheck = (look: HealthLook): boolean =>
  look.picture !== null || look.worker !== null || look.findings !== null;

/** Whether the run's checks can draw a build history: any of them names a picture, a worker or findings. */
export const hasBuildHistory = (graph: RunGraph): boolean => graph.health.some(isNewCheck);

/** What one check found, as a build's outcome. */
export function buildOutcome(look: Pick<HealthLook, "ok" | "findings">): BuildOutcome {
  if (look.ok) return BuildOutcome.Passed;
  const found = look.findings ?? [];
  if (found.some((finding) => BROKEN.has(finding))) return BuildOutcome.Errors;
  return found.includes(HealthFinding.Blank) ? BuildOutcome.Blank : BuildOutcome.Failed;
}

/** A check looks again at the build before it: the same head, known. */
const looksAgain = (card: BuildCard | undefined, look: HealthLook): card is BuildCard =>
  card !== undefined && look.head !== null && card.head === look.head;

/** The run's builds, oldest first: one per head its checks looked at in turn, its newest check's word. */
export function buildsOf(graph: RunGraph): BuildCard[] {
  const builds: BuildCard[] = [];
  for (const look of graph.health) {
    const last = builds.at(-1);
    if (looksAgain(last, look)) {
      last.outcome = buildOutcome(look);
      last.problems = look.problems;
      last.findings = look.findings ?? [];
      last.picture = look.picture ?? last.picture;
      last.worker ??= look.worker;
      continue;
    }
    const n = builds.length + 1;
    builds.push({
      id: buildSelection(n),
      n,
      head: look.head,
      outcome: buildOutcome(look),
      problems: look.problems,
      findings: look.findings ?? [],
      picture: look.picture,
      worker: look.worker,
      seq: look.seq,
    });
  }
  return builds;
}

/**
 * The build whose screenshot `build`'s may be compared with: the one right before it, when both have
 * one. Both were taken the same way, by a health check (one page load, one window size); nothing
 * else is ever paired with a build.
 */
export function buildBefore(builds: readonly BuildCard[], build: BuildCard): BuildCard | null {
  const before = builds.find((item) => item.n === build.n - 1);
  return before?.picture && build.picture ? before : null;
}

/** How many builds were made before the log reached `seq`: the build a worker started then started from. */
const builtBefore = (builds: readonly BuildCard[], seq: number): number =>
  builds.filter((build) => build.seq < seq).length;

/**
 * Where a worker hangs: the build its merge made (its check names it), else for a worker whose work
 * went in unnamed the first build made after it settled; any other off the build it started from.
 */
export function workerPlace(builds: readonly BuildCard[], step: Step): WorkerPlace {
  const named = builds.findLast((build) => build.worker === step.facetId);
  if (named) return { build: named.n, merged: true };
  const info = step.worker;
  const startedAt = info?.startedSeq ?? info?.settledSeq ?? 0;
  const settled = info?.settledSeq ?? null;
  const after = info?.merged && settled !== null ? builds.find((build) => build.seq > settled) : undefined;
  if (after) return { build: after.n, merged: true };
  return { build: builtBefore(builds, startedAt), merged: false };
}

/**
 * A worker's status on the build line: one merged into a build is in that build (the game gets it
 * when the run lands); any other reads as everywhere else (`stepWord`).
 */
export function placedWord(step: Step, place: WorkerPlace | undefined, active: boolean): string {
  return place?.merged && step.state === StepState.InBuild ? BUILD_LINE_WORDS.addedToBuild : stepWord(step, active);
}

/** A worker node's words: its status, and over its name on the build line the build it hangs off. */
export function placedFace(
  step: Step,
  place: WorkerPlace | null,
  active: boolean,
): { word: string; eyebrow: string | null } {
  if (!place) return { word: stepWord(step, active), eyebrow: null };
  return { word: placedWord(step, place, active), eyebrow: workerPlaceWords(place) };
}

/** Which finished workers of a build stay in sight: the merged one first, then the newest to settle. */
function keptInSight(finished: readonly Step[], places: Map<string, WorkerPlace>): Set<Step> {
  const settled = (step: Step): number => step.worker?.settledSeq ?? step.worker?.startedSeq ?? 0;
  const ranked = [...finished].sort(
    (a, b) => Number(places.get(b.id)?.merged) - Number(places.get(a.id)?.merged) || settled(b) - settled(a),
  );
  return new Set(ranked.slice(0, WORKERS_SHOWN));
}

/** One build's hangers: every worker at work and the finished ones in sight, in the order they started. */
function hangersAt(build: number, steps: Step[], places: Map<string, WorkerPlace>, open: boolean): BuildHangers {
  const finished = steps.filter((step) => !isLiveStep(step));
  const folded = Math.max(0, finished.length - WORKERS_SHOWN);
  if (!folded || open) return { build, steps, folded, open: open && folded > 0 };
  const inSight = keptInSight(finished, places);
  return { build, steps: steps.filter((step) => isLiveStep(step) || inSight.has(step)), folded, open: false };
}

/** A worker's row: its one node, built in one session. */
const isWorkerRow = (row: PartRow): boolean =>
  row.facet.worker !== undefined && row.steps.length === 1 && row.steps.every((step) => step.session);

/**
 * The run's build history, or null when it has none to draw: its checks name nothing new, or a row
 * is not a worker's one node. `open` names the builds (0: the lead) whose folded workers show.
 */
export function buildTimeline(
  graph: RunGraph,
  rows: readonly PartRow[],
  open: ReadonlySet<number> = new Set(),
): BuildTimeline | null {
  if (!graph.tree || !hasBuildHistory(graph) || !rows.every(isWorkerRow)) return null;
  const builds = buildsOf(graph);
  const startedAt = (step: Step): number => step.worker?.startedSeq ?? step.worker?.settledSeq ?? 0;
  const steps = rows.flatMap((row) => row.steps).sort((a, b) => startedAt(a) - startedAt(b));
  const places = new Map(steps.map((step) => [step.id, workerPlace(builds, step)] as const));
  const hangers = [0, ...builds.map((build) => build.n)].map((build) => {
    const here = steps.filter((step) => places.get(step.id)?.build === build);
    return hangersAt(build, here, places, open.has(build));
  });
  return { builds, places, hangers };
}
