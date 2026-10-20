/**
 * The service hands every call a door answered (or failed) to its trace sink (`GameAiDeps.traces`),
 * with the text the ledger never keeps: the session's Reports (D9), the creator's model-check
 * moments (D10) and fit from play (D12) are built from it. A refusal before any door is chosen is
 * not a model's call and is not traced; a sink that throws never reaches the game's answer.
 * Moderation (D6) is told which door answered, so only a door genex.games screened passes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AiCallTrace, GameAiCaller } from "../../src/main/game-ai/types.ts";
import { EngineFailureKind } from "../../src/shared/engine-requests.ts";
import { AiAuthority, AiDoor, AiErrorCode, AiProvenance, type AiModelRef } from "../../src/shared/game-ai.ts";
import { AiValidation } from "../../src/shared/game-ai-report.ts";
import { AiContext } from "../../src/shared/game-ai-route.ts";
import { EngineError } from "../../src/substrate/engines/types.ts";
import { BYOK_HAIKU } from "../helpers/game-ai-fakes.ts";
import { BAD, call, caller, CROWNS, GOOD, granted, MOSS, refusal, rig } from "../helpers/game-ai-rig.ts";

/** A sink that keeps what it heard. */
function sink() {
  const heard: Array<{ caller: GameAiCaller; trace: AiCallTrace }> = [];
  return { heard, traces: (who: GameAiCaller, trace: AiCallTrace) => void heard.push({ caller: who, trace }) };
}

const DEV_MODEL: AiModelRef = { door: AiDoor.GenexDev, engine: "genex", model: "anthropic/claude-haiku-4.5" };

describe("play-time AI service: traces", () => {
  it("hands a usable reply to the sink with its text, value and what it cost", async () => {
    const heard = sink();
    const r = await rig({ scripts: { [AiDoor.Byok]: [GOOD] }, traces: heard.traces });
    await granted(r, BYOK_HAIKU);
    const request = call({ untrusted: { said: "march on Dijon" } });
    assert.ok((await r.ask(request)).ok);
    assert.equal(heard.heard.length, 1);
    const [{ caller: who, trace } = { caller: null, trace: null }] = heard.heard;
    assert.equal(who?.game, CROWNS);
    assert.deepEqual(trace?.request, request);
    assert.equal(trace?.rawOutput, GOOD.text);
    assert.deepEqual(trace?.value, { move: "march" });
    assert.equal(trace?.validation, AiValidation.Valid);
    assert.equal(trace?.code, null);
    assert.equal(trace?.door, AiDoor.Byok);
    assert.deepEqual(trace?.model, BYOK_HAIKU);
    assert.equal(trace?.servedModel, GOOD.model);
    assert.equal(trace?.provenance, AiProvenance.Unverified);
    assert.deepEqual(trace?.usage, GOOD.usage);
    assert.equal(trace?.costMicros, GOOD.costMicros);
  });

  it("traces a repaired reply as repaired and free, and one still invalid as invalid and free (D7)", async () => {
    const repaired = sink();
    const r = await rig({ scripts: { [AiDoor.Byok]: [BAD, GOOD] }, traces: repaired.traces });
    await granted(r, BYOK_HAIKU);
    assert.ok((await r.ask(call())).ok);
    assert.equal(repaired.heard[0]?.trace.validation, AiValidation.Repaired);
    assert.equal(repaired.heard[0]?.trace.costMicros, 0);
    assert.equal(repaired.heard[0]?.trace.rawOutput, GOOD.text);

    const invalid = sink();
    const bad = await rig({ scripts: { [AiDoor.Byok]: [BAD, BAD] }, traces: invalid.traces });
    await granted(bad, BYOK_HAIKU);
    assert.equal(refusal(await bad.ask(call())), AiErrorCode.InvalidOutput);
    const trace = invalid.heard[0]?.trace;
    assert.equal(trace?.validation, AiValidation.Invalid);
    assert.equal(trace?.code, AiErrorCode.InvalidOutput);
    assert.equal(trace?.value, null);
    assert.equal(trace?.rawOutput, BAD.text);
    assert.equal(trace?.costMicros, 0);
  });

  it("traces a door that failed as no reply, with the code the game got", async () => {
    const heard = sink();
    const r = await rig({
      scripts: { [AiDoor.Byok]: [new EngineError(EngineFailureKind.Timeout, "openrouter", "slow")] },
      traces: heard.traces,
    });
    await granted(r, BYOK_HAIKU);
    assert.equal(refusal(await r.ask(call())), AiErrorCode.Timeout);
    const trace = heard.heard[0]?.trace;
    assert.equal(trace?.validation, AiValidation.NoReply);
    assert.equal(trace?.code, AiErrorCode.Timeout);
    assert.equal(trace?.rawOutput, null);
    assert.equal(trace?.costMicros, 0);
  });

  it("asks moderation with the door that answered, and traces a refused answer without its value", async () => {
    const heard = sink();
    const asked: AiDoor[] = [];
    const r = await rig({
      scripts: { [AiDoor.GenexDev]: [GOOD] },
      traces: heard.traces,
      moderate: async (_text, door) => {
        asked.push(door);
        return false;
      },
    });
    await granted(r, DEV_MODEL, MOSS);
    const own = caller({ game: MOSS, context: AiContext.CreateLive, ownGame: true });
    assert.equal(refusal(await r.ask(call({ authority: AiAuthority.Shared }), own)), AiErrorCode.Moderated);
    assert.deepEqual(asked, [AiDoor.GenexDev]);
    const trace = heard.heard[0]?.trace;
    assert.equal(trace?.code, AiErrorCode.Moderated);
    assert.equal(trace?.value, null);
    assert.equal(trace?.costMicros, 0);
  });

  it("traces a kept answer as a free, valid call of the same door", async () => {
    const heard = sink();
    const r = await rig({ scripts: { [AiDoor.Byok]: [GOOD] }, traces: heard.traces });
    await granted(r, BYOK_HAIKU);
    const request = call();
    assert.ok((await r.ask(request)).ok);
    const again = await r.ask({ ...request, ticket: "t_cached01" });
    assert.ok(again.ok && again.cached);
    const kept = heard.heard[1]?.trace;
    assert.equal(kept?.door, AiDoor.Byok);
    assert.equal(kept?.validation, AiValidation.Valid);
    assert.deepEqual(kept?.value, { move: "march" });
    assert.equal(kept?.costMicros, 0);
    assert.equal(kept?.request.ticket, "t_cached01");
  });

  it("does not trace a refusal made before any door was chosen", async () => {
    const heard = sink();
    const r = await rig({ traces: heard.traces });
    await r.grants.setOn(CROWNS, false);
    assert.equal(refusal(await r.ask(call())), AiErrorCode.Off);
    assert.equal(heard.heard.length, 0);
  });

  it("answers the game even when the sink throws", async () => {
    const r = await rig({
      scripts: { [AiDoor.Byok]: [GOOD] },
      traces: () => {
        throw new Error("sink broke");
      },
    });
    await granted(r, BYOK_HAIKU);
    assert.ok((await r.ask(call())).ok);
  });
});
