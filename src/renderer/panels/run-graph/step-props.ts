import { sameSnapshot } from "../../state/snapshot-equality.ts";
import type { Rect } from "../../run-graph.ts";
import type { GatePoint, Step } from "../../run-steps.ts";
import type { WorkerPlace } from "../../run-graph-builds.ts";

/** Only the run and node state that can change one step's picture or interaction. */
export interface StepNodeProps {
  /** The game the run builds: a working step shows the screen of its agent on this game. */
  project: string | null;
  runId: string;
  active: boolean;
  step: Step;
  rect: Rect | undefined;
  ghost: boolean;
  selected: boolean;
  onSelect: (id: string) => void;
  /** On a Loop's build line, the build a worker hangs off and whether its work is in it. */
  place?: WorkerPlace | null;
}

/** Keep unchanged steps asleep when a different step is appended. */
export function sameStepNode(left: StepNodeProps, right: StepNodeProps): boolean {
  const sameRun = left.project === right.project && left.runId === right.runId && left.active === right.active;
  const sameInteraction = left.selected === right.selected && left.onSelect === right.onSelect;
  const samePicture =
    left.ghost === right.ghost && sameSnapshot(left.rect, right.rect) && sameSnapshot(left.step, right.step);
  return sameRun && sameInteraction && samePicture && sameSnapshot(left.place, right.place);
}

/** Only the gate's own geometry, review state and stable actions affect its button. */
export interface GateButtonProps {
  gate: GatePoint;
  notesId: string | null;
  onOpen: (gate: GatePoint, notesId: string | null) => void;
  onTip: (gate: GatePoint | null) => void;
}

/** Keep other gates asleep when a step elsewhere changes. */
export function sameGateButton(left: GateButtonProps, right: GateButtonProps): boolean {
  const sameActions = left.onOpen === right.onOpen && left.onTip === right.onTip;
  return sameActions && left.notesId === right.notesId && sameSnapshot(left.gate, right.gate);
}
