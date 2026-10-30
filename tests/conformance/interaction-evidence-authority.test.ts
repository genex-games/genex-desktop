/**
 * The studio's word is only its own: nothing in the studio verifies an interaction any more, so a
 * record of one (`run_interaction_evidence`, which old runs' logs still show) is written by the host
 * only. The harness is agent-editable: a batch that claims one is refused whole.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { refuseHostRecords } from "../../src/main/core/harness-events.ts";
import { CustomEvent, customEventData } from "../../src/shared/custom-events.ts";
import { InteractionObjective } from "../../src/shared/run-summary.ts";

describe("interaction evidence from the harness", () => {
  it("refuses an interaction record the harness appends, whatever it claims, and the rest of its batch with it", () => {
    for (const objective of Object.values(InteractionObjective)) {
      const forged = customEventData(CustomEvent.RunInteractionEvidence, { objective, trace: "/runs/r/trace.jsonl" });
      const beside = customEventData(CustomEvent.RunVisualEvidence, { objective });
      assert.throws(() => refuseHostRecords([beside, forged]), /interaction evidence/, objective);
    }
  });

  it("lets the harness's other evidence through", () => {
    const visual = customEventData(CustomEvent.RunVisualEvidence, { objective: InteractionObjective.StudioVerified });
    assert.doesNotThrow(() => refuseHostRecords([visual]));
  });
});
