/**
 * Who answers for the build's camera wiring (evidence.ts `camerasOwned`). A new module, so a kept
 * older phase never hides it from another.
 */
import { FacetRole } from "./state.ts";

/**
 * Does this part answer for the build's camera wiring: it owns the entry, or it is the integration
 * of every part. Any other part — a sound, a world — cannot rewire the cameras, so cameras that all
 * show one frame never make its rounds unjudgeable (evidence.ts `camerasOwned`).
 */
export function ownsCameraWiring({ ownsMain, role }: { ownsMain: boolean; role: string }): boolean {
  return ownsMain || role === FacetRole.Integration;
}
