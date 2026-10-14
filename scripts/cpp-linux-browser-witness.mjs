import assert from "node:assert/strict";

/** A successful real starter drive: simulation progressed without a runtime error and drew content. */
export function assertStarterWitness({ paused, seeded, step, before, after }) {
  assert.equal(paused, true, "pause did not succeed");
  assert.equal(seeded, 7, "seed did not succeed");
  assert.ok(step?.steppedFrames > 0 && step.drawCalls > 0, "step did not succeed and draw");
  assert.equal(before?.error, null, "starter has a runtime error before stepping");
  assert.equal(after?.error, null, "starter has a runtime error after stepping");
  assert.equal(before.seed, 7);
  assert.equal(after.running, false);
  for (const field of ["frame", "simulatedMs"]) {
    assert.ok(Number.isFinite(before[field]) && Number.isFinite(after[field]));
    assert.ok(after[field] > before[field], `step did not advance ${field}`);
    assert.equal(after[field], step[field]);
  }
  assert.ok(after.__render?.drawCalls > 0, "starter drew no content");
}
