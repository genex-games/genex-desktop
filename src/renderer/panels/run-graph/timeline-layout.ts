/**
 * The Builds graph of a Loop with a build history (`run-graph-builds.ts`): what you asked → the lead
 * → Build 1 → Build 2 → … → your build, on one line. Each worker hangs below or above the build its
 * work went into, or the build it started from (the lead's column before the first build), each on
 * its own line from the trunk left of that column: solid when its work is in that build, live while
 * it works, dotted otherwise. Finished workers past a few fold into one card in the same lanes.
 *
 * Pure: no DOM, no window. `run-tree.ts` picks it for a graph whose timeline is drawn.
 */
import { boundsOf, type Rect } from "../../run-graph.ts";
import {
  type BuildCard,
  type BuildHangers,
  type BuildTimeline,
  foldId,
  type WorkerPlace,
} from "../../run-graph-builds.ts";
import { columnX, LANE_PITCH, laneOf, TRUNK_INSET } from "../../run-graph-comb.ts";
import {
  bend,
  isLiveStep,
  type LayoutDraft,
  type LayoutOptions,
  placeEnd,
  placeResult,
  placeStart,
  placeTreeLead,
  STEPS,
  type Step,
  StepEdgeKind,
  type StepsLayout,
} from "../../run-steps.ts";

/** One thing hanging off a column: a worker's node, or (no step) the card that folds the rest. */
interface Hanger {
  id: string;
  step: Step | null;
}

/** A column's hangers in lane order: its workers, then the fold card when it folds any. */
function columnHangers(hangers: BuildHangers): Hanger[] {
  const items = hangers.steps.map((step) => ({ id: step.id, step }));
  return hangers.folded ? [...items, { id: foldId(hangers.build), step: null }] : items;
}

/** The lane of a column's `index`th hanger; the lead's first lane below is its background tile's when it has one. */
const slotOf = (index: number, jobsBelow: boolean) => laneOf(jobsBelow ? index + 1 : index);

/** How many lanes the busiest column needs above the line. */
function lanesAbove(columns: Hanger[][], jobs: boolean): number {
  let most = 0;
  columns.forEach((items, column) => {
    items.forEach((_, index) => {
      const { below, lane } = slotOf(index, column === 0 && jobs);
      if (!below) most = Math.max(most, lane + 1);
    });
  });
  return most;
}

/** The line into a hanger: in hand now, its work in this build, or not. The fold card's is dotted. */
function hangKind(step: Step | null, place: WorkerPlace | undefined): StepEdgeKind {
  if (!step) return StepEdgeKind.Dotted;
  if (isLiveStep(step)) return StepEdgeKind.Live;
  return place?.merged ? StepEdgeKind.Solid : StepEdgeKind.Dotted;
}

/** One column's hangers, each on its own line from the trunk left of it. */
function placeHangers(
  draft: LayoutDraft,
  items: Hanger[],
  at: { column: number; midY: number; jobsBelow: boolean },
  places: Map<string, WorkerPlace>,
): void {
  const S = STEPS;
  const x = columnX(at.column);
  const trunk = x - TRUNK_INSET;
  items.forEach((item, index) => {
    const { below, lane } = slotOf(index, at.jobsBelow);
    const offset = (lane + 1) * LANE_PITCH;
    const y = at.midY - S.nodeH / 2 + (below ? offset : -offset);
    const cy = y + S.nodeH / 2;
    draft.rects[item.id] = { x, y, w: S.nodeW, h: S.nodeH };
    const kind = hangKind(item.step, item.step ? places.get(item.step.id) : undefined);
    if (item.step && kind === StepEdgeKind.Dotted) draft.ghosts.add(item.step.id);
    draft.edges.push({ id: `hang:${item.id}`, d: bend(trunk, at.midY, cy, x, S.corner), kind });
    if (item.step?.gate) draft.gates.push({ target: item.step.id, gate: item.step.gate, x, y: cy });
  });
}

/** The builds on the line, each joined to the node before it. */
function placeBuilds(draft: LayoutDraft, builds: readonly BuildCard[], midY: number): void {
  const S = STEPS;
  builds.forEach((build, index) => {
    const x = columnX(index + 1);
    draft.rects[build.id] = { x, y: midY - S.nodeH / 2, w: S.nodeW, h: S.nodeH };
    const from = columnX(index) + S.nodeW;
    draft.edges.push({ id: `line:${build.id}`, d: `M${from} ${midY} H${x}`, kind: StepEdgeKind.Solid });
  });
}

/** Reading order along the line: the lead's hangers, then each build and what hangs off it. */
function timelineOrder(timeline: BuildTimeline, columns: Hanger[][]): string[] {
  const workers = (column: number): string[] => (columns[column] ?? []).flatMap((item) => (item.step ? [item.id] : []));
  return [...workers(0), ...timeline.builds.flatMap((build) => [build.id, ...workers(build.n)])];
}

/**
 * What you asked (its assets under it) → the lead (its background work under it) → each build →
 * your build → the finish check, on one line; each worker hangs off the column it belongs to.
 */
export function layoutTimeline(timeline: BuildTimeline, options: LayoutOptions = {}): StepsLayout {
  const S = STEPS;
  const draft: LayoutDraft = { rects: {}, edges: [], gates: [], ghosts: new Set<string>() };
  const columns = timeline.hangers.map(columnHangers);
  const jobs = options.tree?.jobs === true;
  const midY = S.pad + lanesAbove(columns, jobs) * LANE_PITCH + S.startH / 2;

  placeStart(draft, midY, options.assets === true, options.startWords === true);
  placeTreeLead(draft, midY, jobs, options.lead === true);
  placeBuilds(draft, timeline.builds, midY);
  timeline.hangers.forEach((hangers, index) => {
    const at = { column: hangers.build, midY, jobsBelow: hangers.build === 0 && jobs };
    placeHangers(draft, columns[index] ?? [], at, timeline.places);
  });
  const into = columnX(timeline.builds.length + 1);
  const final = placeResult(draft, into, midY);
  placeEnd(draft, final, midY, options);
  const lastNode: Rect | undefined = draft.rects[timeline.builds.at(-1)?.id ?? "lead"];
  const from = lastNode ? lastNode.x + lastNode.w : columnX(0) + S.nodeW;
  draft.edges.push({ id: "line:final", d: `M${from} ${midY} H${into}`, kind: StepEdgeKind.Solid });
  if (options.resultGate) draft.gates.push({ target: "final", gate: options.resultGate, x: final.x, y: midY });
  // The lines that carried nothing go under the ones that did.
  draft.edges.sort((a, b) => Number(a.kind === StepEdgeKind.Solid) - Number(b.kind === StepEdgeKind.Solid));

  const bounds = boundsOf(Object.values(draft.rects)) ?? { x: 0, y: 0, w: 0, h: 0 };
  return {
    ...draft,
    order: timelineOrder(timeline, columns),
    width: bounds.x + bounds.w + S.pad,
    height: bounds.y + bounds.h + S.pad,
  };
}
