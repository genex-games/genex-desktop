/**
 * The checks under a build's Technical details, as the person reads them: grouped by the build they
 * were taken on, failures first, each saying who checked and what it rests on, never a raw slug.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkMeta } from "../../src/renderer/outcome-checks.ts";
import type { RunEvidence } from "../../src/shared/run-summary.ts";

const HEAD = "f0771a0887aa";

function evidence(fields: Partial<RunEvidence>): RunEvidence {
  return {
    id: fields.label ?? "e",
    head: HEAD,
    category: "interaction",
    label: "Can you reach the star?",
    status: "passed",
    note: null,
    source: "recorded",
    ...fields,
  };
}

describe("the checks of a build", () => {
  it("says the state in words, who checked and what it rests on, and no category or revision", () => {
    assert.equal(
      checkMeta(evidence({ status: "passed", source: "hands-on-judge", objective: "studio-verified" })),
      "Passed · Judge who played it · verified by the studio",
    );
    assert.equal(
      checkMeta(evidence({ status: "failed", source: "hands-on-judge", objective: "model-said" })),
      "Failed · Judge who played it · the player's word",
    );
    assert.equal(checkMeta(evidence({ status: "unknown", category: "visual" })), "Not measured · Reviewer");
    assert.equal(checkMeta(evidence({ category: "health" })), "Passed · Recorded check");
  });
});
