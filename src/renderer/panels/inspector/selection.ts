/**
 * What can be selected on the Builds graph. The fixed nodes have their own ids (they are also the
 * panel's `data-graph-panel` values); a step is selected by its own id, a part by `part:<facet>`.
 */

/** The graph's fixed nodes. Persisted as `data-graph-*` values the smoke reads: never rename a value. */
export const GraphSelection = {
  Start: "start",
  Assets: "assets",
  Optimization: "optimization",
  Final: "final",
  /** the lead of a run or a chat turn: in a tree for the whole run, else while it has the run between parts */
  Lead: "lead",
  /** the lead's background work, under it in a tree */
  Jobs: "jobs",
  /** the reviewer's check that a run is done, the last node of a run's tree */
  FinishCheck: "finish_check",
} as const;
export type GraphSelection = (typeof GraphSelection)[keyof typeof GraphSelection];

const PART_PREFIX = "part:";

/** The selection id of a part's row. */
export const partSelection = (facetId: string): string => `${PART_PREFIX}${facetId}`;

/** Whether a selection id names a part's row. */
export const isPartSelection = (id: string): boolean => id.startsWith(PART_PREFIX);

/** The facet a part selection names. */
export const selectedPart = (id: string): string => id.slice(PART_PREFIX.length);

/** The facet a selection names when it is a part's row, else null. */
export const partOf = (id: string | null): string | null => (id && isPartSelection(id) ? selectedPart(id) : null);
