/**
 * The trace sink (`main/game-ai/trace-sink.ts`): the one place the service hands each settled call
 * with its text. It keeps the call in its game's Report session, saves a model-check moment, counts
 * it for fit from play (then sends counts when due), and asks for an automatic Report when the reply
 * was still invalid after its repair. No part can throw back into the call.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { AiErrorCode } from "../../src/shared/game-ai.ts";
import { AiValidation } from "../../src/shared/game-ai-report.ts";
import { createTraceSink } from "../../src/main/game-ai/trace-sink.ts";
import { PLAY_GAME, callerFor, traceOf } from "../helpers/game-ai-traces.ts";

/** A sink over recording parts; `fail` makes every part throw or reject. */
function sink(fail = false) {
  const seen: string[] = [];
  const act = (name: string) => {
    seen.push(name);
    if (fail) throw new Error(`${name} failed`);
  };
  const later = async (name: string) => act(name);
  const traces = createTraceSink({
    reports: {
      observe: () => act("observe"),
      automatic: (_caller, ticket) => later(`automatic:${ticket}`),
    },
    moments: { remember: () => later("remember") },
    fitCounts: { record: () => later("record"), flush: () => later("flush") },
  });
  return { traces, seen };
}

describe("the trace sink", () => {
  it("hands a call to its Report session, the moments and the fit counts", async () => {
    const fx = sink();
    fx.traces(callerFor(PLAY_GAME), traceOf());
    await tick();
    assert.deepEqual(fx.seen.sort(), ["flush", "observe", "record", "remember"]);
  });

  it("asks for an automatic Report of a reply still invalid after its repair", async () => {
    const fx = sink();
    const trace = traceOf({ validation: AiValidation.Invalid, code: AiErrorCode.InvalidOutput, value: null });
    fx.traces(callerFor(PLAY_GAME), trace);
    await tick();
    assert.ok(fx.seen.includes(`automatic:${trace.request.ticket}`));
  });

  it("never throws back into the call when a part fails", async () => {
    const fx = sink(true);
    fx.traces(callerFor(PLAY_GAME), traceOf({ validation: AiValidation.Invalid, code: AiErrorCode.InvalidOutput }));
    await tick();
    assert.ok(fx.seen.includes("observe"));
    assert.ok(fx.seen.includes("record"));
    assert.equal(fx.seen.includes("flush"), false, "a count that was not kept is not sent");
  });
});
