/**
 * The Builds graph of a lead's tree in place: what you asked → the lead → its save points, one
 * line (the spine) into your build. Each worker hangs below or above the spine, under the save
 * point that took its work, or, when nothing of it was taken, after the save point that was current
 * when it started, on a dotted line. Rows never span the graph: a worker is one node in a column of
 * the spine, so the graph grows along the save points, not with the workers.
 *
 * Pure: no DOM, no window. `run-tree.ts` picks this layout for a tree whose rows are all workers
 * and at most one row of the lead's save points; every other graph keeps `layoutSteps`.
 */
import { boundsOf, type Rect } from "./run-graph.ts";
import {
  bend,
  isLiveStep,
  isSavePoint,
  type LayoutDraft,
  type LayoutOptions,
  type PartRow,
  placeEnd,
  placeResult,
  placeStart,
  placeTreeLead,
  STEPS,
  type Step,
  StepEdgeKind,
  type StepsLayout,
  treeLeadX,
} from "./run-steps.ts";

/** How far apart two hanging lanes are, top to top. */
const LANE_PITCH = STEPS.nodeH + STEPS.hangGap;
/** Where a column's trunk runs: in the middle of the gap left of its node. */
const TRUNK_INSET = (STEPS.pitch - STEPS.nodeW) / 2;

/** A worker's row: its one node, built in one session. */
const isWorkerRow = (row: PartRow): boolean =>
  row.facet.worker !== undefined && row.steps.length === 1 && row.steps.every((step) => step.session);

/** The lead's own row: nothing but save points. */
const isSaveRow = (row: PartRow): boolean =>
  row.facet.worker === undefined && row.steps.length > 0 && row.steps.every(isSavePoint);

/**
 * Whether a tree is a lead's in place: it has a row, every row is a worker's one node or the lead's
 * save points, and there is at most one row of save points to make the spine.
 */
export function isInPlaceTree(rows: PartRow[]): boolean {
  const saveRows = rows.filter(isSaveRow).length;
  return rows.length > 0 && saveRows <= 1 && rows.every((row) => isWorkerRow(row) || isSaveRow(row));
}

/** The place in the log a save point was made. */
const savedAt = (step: Step): number => {
  const round = step.tries.at(-1);
  return round?.judgedSeq ?? round?.startedSeq ?? 0;
};

/**
 * Which gap of the spine a worker hangs in: gap `g` is after save point `g` and before save point
 * `g + 1` (gap 0 is before the first). A worker whose work was taken hangs before the first save
 * point made after the lead took it; any other hangs after the last save point made before it
 * started. Either way: the number of save points made before that moment.
 */
export function workerGap(step: Step, saves: readonly number[]): number {
  const settled = step.worker?.settledSeq ?? null;
  const started = step.worker?.startedSeq ?? settled;
  const moment = (step.onLine && settled !== null ? settled : started) ?? 0;
  return saves.filter((seq) => seq < moment).length;
}

/** The spine's steps in the order they were saved, and the workers by gap in the order they started. */
interface Spine {
  saves: Step[];
  gaps: Map<number, Step[]>;
}

function spineOf(rows: PartRow[]): Spine {
  const saves = rows
    .filter(isSaveRow)
    .flatMap((row) => row.steps)
    .sort((a, b) => savedAt(a) - savedAt(b));
  const moments = saves.map(savedAt);
  const startedAt = (step: Step): number => step.worker?.startedSeq ?? step.worker?.settledSeq ?? 0;
  const workers = rows
    .filter(isWorkerRow)
    .flatMap((row) => row.steps)
    .sort((a, b) => startedAt(a) - startedAt(b));
  const gaps = new Map<number, Step[]>();
  for (const step of workers) {
    const gap = workerGap(step, moments);
    gaps.set(gap, [...(gaps.get(gap) ?? []), step]);
  }
  return { saves, gaps };
}

/** A hanger's lane: the first below, the second above, then further out on each side in turn. */
const laneOf = (index: number): { below: boolean; lane: number } => ({
  below: index % 2 === 0,
  lane: Math.floor(index / 2),
});

/** How many lanes the busiest gap needs above the spine. */
function lanesAbove(gaps: Map<number, Step[]>): number {
  return Math.max(0, ...[...gaps.values()].map((steps) => Math.floor(steps.length / 2)));
}

/** The edge into a hanger: in hand now, its work taken, or nothing of it taken. */
function hangKind(step: Step): StepEdgeKind {
  if (isLiveStep(step)) return StepEdgeKind.Live;
  return step.onLine ? StepEdgeKind.Solid : StepEdgeKind.Dotted;
}

/** A column's left edge: column 0 is the lead, column `c` the spine's `c`th place. */
const columnX = (column: number): number => treeLeadX() + column * STEPS.pitch;

/** The workers of one gap, under or over the column right of it, each on its own line from the spine. */
function placeGap(draft: LayoutDraft, steps: Step[], column: number, midY: number): void {
  const S = STEPS;
  const x = columnX(column);
  const trunk = x - TRUNK_INSET;
  steps.forEach((step, index) => {
    const { below, lane } = laneOf(index);
    const offset = (lane + 1) * LANE_PITCH;
    const y = midY - S.nodeH / 2 + (below ? offset : -offset);
    const cy = y + S.nodeH / 2;
    draft.rects[step.id] = { x, y, w: S.nodeW, h: S.nodeH };
    if (!step.onLine && !isLiveStep(step)) draft.ghosts.add(step.id);
    draft.edges.push({ id: `hang:${step.id}`, d: bend(trunk, midY, cy, x, S.corner), kind: hangKind(step) });
    if (step.gate) draft.gates.push({ target: step.id, gate: step.gate, x, y: cy });
  });
}

/** The save points on the spine, each joined to the node before it. */
function placeSaves(draft: LayoutDraft, saves: Step[], midY: number): void {
  const S = STEPS;
  saves.forEach((step, index) => {
    const x = columnX(index + 1);
    draft.rects[step.id] = { x, y: midY - S.nodeH / 2, w: S.nodeW, h: S.nodeH };
    const from = columnX(index) + S.nodeW;
    const kind = step.onLine ? StepEdgeKind.Solid : StepEdgeKind.Dotted;
    draft.edges.push({ id: `line:${step.id}`, d: `M${from} ${midY} H${x}`, kind });
    if (step.gate) draft.gates.push({ target: step.id, gate: step.gate, x, y: midY });
  });
}

/** Reading order along the spine: each gap's workers, then the save point that closes it. */
function spineOrder({ saves, gaps }: Spine, columns: number): string[] {
  const order: string[] = [];
  for (let gap = 0; gap < columns; gap++) {
    order.push(...(gaps.get(gap) ?? []).map((step) => step.id));
    const save = saves[gap];
    if (save) order.push(save.id);
  }
  return order;
}

/**
 * What you asked (its assets under it) → the lead (its background work under it) → each save point
 * → your build → the finish check, on one line; each worker hangs off that line in the gap it
 * belongs to. A worker in the gap after the last save point gets a column of its own before the
 * result, so the line into your build carries the work on its way.
 */
export function layoutComb(rows: PartRow[], options: LayoutOptions = {}): StepsLayout {
  const S = STEPS;
  const draft: LayoutDraft = { rects: {}, edges: [], gates: [], ghosts: new Set<string>() };
  const spine = spineOf(rows);
  const last = spine.saves.length;
  const columns = last + 1 + (spine.gaps.has(last) ? 1 : 0);
  const midY = S.pad + lanesAbove(spine.gaps) * LANE_PITCH + S.startH / 2;

  placeStart(draft, midY, options.assets === true, options.startWords === true);
  placeTreeLead(draft, midY, options.tree?.jobs === true, options.lead === true);
  placeSaves(draft, spine.saves, midY);
  for (const [gap, steps] of spine.gaps) placeGap(draft, steps, gap + 1, midY);
  const into = columnX(columns);
  const final = placeResult(draft, into, midY, options.optimization === true);
  placeEnd(draft, final, midY, options);
  const lastNode: Rect | undefined = draft.rects[spine.saves.at(-1)?.id ?? "lead"];
  const from = lastNode ? lastNode.x + lastNode.w : columnX(0) + S.nodeW;
  draft.edges.push({ id: "line:final", d: `M${from} ${midY} H${into}`, kind: StepEdgeKind.Solid });
  if (options.resultGate) draft.gates.push({ target: "final", gate: options.resultGate, x: final.x, y: midY });
  // The lines that carried nothing go under the ones that did.
  draft.edges.sort((a, b) => Number(a.kind === StepEdgeKind.Solid) - Number(b.kind === StepEdgeKind.Solid));

  const bounds = boundsOf(Object.values(draft.rects)) ?? { x: 0, y: 0, w: 0, h: 0 };
  return {
    ...draft,
    order: spineOrder(spine, columns),
    width: bounds.x + bounds.w + S.pad,
    height: bounds.y + bounds.h + S.pad,
  };
}
