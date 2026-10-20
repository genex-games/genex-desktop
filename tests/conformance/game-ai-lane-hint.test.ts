/**
 * Studio's lane hint on a preview page (`page-serve.ts` `rewriteGameHtml`): a harness replay or
 * recording names the lane its page plays on (and the demo whose saved playtest answers) on the
 * shim's tag, as `data-genex-ai`, where `genex-ai` reads it; a load that names none adds nothing.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rewriteGameHtml, shimTag } from "../../src/main/page-serve.ts";
import { AI_LANE_ATTRIBUTE, AiLane, type AiLaneHint, readAiLaneHint } from "../../src/shared/game-ai-lane.ts";

const PAGE =
  "<!doctype html><html><head><title>t</title></head><body><script type=module src=main.js></script></body></html>";

/** The hint the page's shim tag carries, read back as the page reads an attribute. */
function hintOf(html: string): AiLaneHint | null {
  const tag = /<script\b[^>]*\bdata-studio-shim\b[^>]*>/i.exec(html)?.[0] ?? "";
  const raw = new RegExp(`${AI_LANE_ATTRIBUTE}="([^"]*)"`).exec(tag)?.[1];
  if (raw === undefined) return null;
  const value = raw.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
  return readAiLaneHint(value);
}

describe("the lane hint on a preview page", () => {
  it("rides on the shim's tag for each lane a harness run plays on", () => {
    for (const hint of [
      { lane: AiLane.Tape, tape: "turn-three" },
      { lane: AiLane.Off, tape: null },
      { lane: AiLane.Edge, tape: null },
      { lane: AiLane.Host, tape: null },
    ] satisfies AiLaneHint[]) {
      const { html, injected } = rewriteGameHtml(PAGE, { aiLane: hint });
      assert.equal(injected, true);
      assert.deepEqual(hintOf(html), hint, hint.lane);
    }
  });

  it("adds nothing when the load names no lane", () => {
    assert.equal(hintOf(rewriteGameHtml(PAGE).html), null);
    assert.equal(hintOf(rewriteGameHtml(PAGE, { aiLane: null }).html), null);
    assert.ok(!shimTag(null).includes(AI_LANE_ATTRIBUTE));
  });

  it("keeps the shim's own options beside the hint", () => {
    const tag = shimTag({ seed: 7 }, { lane: AiLane.Tape, tape: "walk" });
    assert.match(tag, /data-studio-options="/);
    assert.deepEqual(hintOf(tag), { lane: AiLane.Tape, tape: "walk" });
  });
});
