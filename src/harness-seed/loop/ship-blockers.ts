/**
 * The art director's defects that are work: its blockers. Only a blocker starts or steers a
 * builder's round and holds a build back from finishing; a visible flaw or a nit goes in the user's
 * report. A new module, so a kept older ship-review.ts never hides it from its callers.
 */
import { DefectSeverity, type ShipDefect } from "./ship-review.ts";

/** The blockers among `defects`. */
export const blockersOf = (defects: readonly ShipDefect[]): ShipDefect[] =>
  defects.filter((defect) => defect.severity === DefectSeverity.Blocker);
