/**
 * The studio's word is only its own: an interaction the harness (agent-editable code) records as
 * `studio-verified` keeps that word only when a computer session the host ran saw its goal reached
 * in that very trace; any other claim is recorded as the model's word.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { vouchedInteractions } from "../../src/main/core/harness-events.ts";
import { isVerified, markVerified } from "../../src/main/core/verified-traces.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import { EventKind } from "../../src/shared/event-log.ts";
import type { EventData } from "../../src/substrate/types.ts";

const interaction = (payload: Record<string, unknown>): EventData => ({
  type: EventKind.Custom,
  event_type: CustomEvent.RunInteractionEvidence,
  payload,
});

describe("studio-verified interactions", () => {
  it("keeps the studio's word for a trace it saw reach the goal, and only that one", () => {
    markVerified("/runs/r/facet_x/playtest/iter_001/trace.jsonl");
    const [seen, claimed, forged, said, other] = vouchedInteractions([
      interaction({ objective: "studio-verified", trace: "/runs/r/facet_x/playtest/iter_001/trace.jsonl" }),
      interaction({ objective: "studio-verified", trace: "/runs/r/facet_x/playtest/iter_001/trace-2.jsonl" }),
      interaction({ objective: "studio-verified" }),
      interaction({ objective: "model-said", trace: "/x" }),
      { type: EventKind.Custom, event_type: CustomEvent.RunVisualEvidence, payload: { objective: "studio-verified" } },
    ]) as Array<{ payload: { objective?: string } }>;
    assert.equal(seen?.payload.objective, "studio-verified");
    assert.equal(claimed?.payload.objective, "model-said", "a trace the studio never saw reach its goal");
    assert.equal(forged?.payload.objective, "model-said", "no trace at all");
    assert.equal(said?.payload.objective, "model-said");
    assert.equal(other?.payload.objective, "studio-verified", "other records pass untouched");
    assert.equal(isVerified(42), false);
  });
});
