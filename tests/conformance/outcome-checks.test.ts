/**
 * The checks under a build's Technical details, as the person reads them: grouped by the build they
 * were taken on, failures first, each saying who checked and what it rests on, never a raw slug.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkGroups, checkMeta, checkNote, checkTitle } from "../../src/renderer/outcome-checks.ts";
import type { RunEvidence } from "../../src/shared/run-summary.ts";

const HEAD = "f0771a0887aa";
const EARLIER = "5c06cd4d1dbb";

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
  it("puts this build's checks first, failures before passes, and an earlier build's apart", () => {
    const rows = [
      evidence({ label: "Build health", category: "health" }),
      evidence({ label: "old judge", head: EARLIER, status: "failed" }),
      evidence({ label: "judge", status: "failed", source: "hands-on-judge" }),
      evidence({ label: "unmeasured", status: "unknown" }),
      // A check whose build was not recorded is never called earlier.
      evidence({ label: "route", head: null, source: "route-replay" }),
    ];
    const groups = checkGroups(rows, HEAD);
    assert.deepEqual(
      groups.current.map((e) => e.label),
      ["judge", "unmeasured", "Build health", "route"],
    );
    assert.deepEqual(
      groups.earlier.map((e) => e.label),
      ["old judge"],
    );
  });

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

  it("names a replayed route by what it is, and says what held in words, not the route's slug", () => {
    const route = evidence({
      label: "route verify-every-required-scenario-through-actual-in",
      source: "route-replay",
      note: "route verify-every-required-scenario-through-actual-in replayed: the goal held after the same calls",
    });
    assert.equal(checkTitle(route), "Replayed the judge's route");
    assert.equal(checkNote(route), "The judge's moves were replayed on this build, and the goal held.");
    const diverged = evidence({
      ...route,
      status: "failed",
      note: "route r diverged at step 3 of 7: the goal did not hold after the same calls",
    });
    assert.equal(checkNote(diverged), diverged.note, "a divergence keeps the step it parted at");
    assert.equal(checkTitle(evidence({ label: "Build health" })), "Build health");
  });
});
