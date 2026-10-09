/**
 * An edited first-generation `src/hud.js` is the main owner's work, and a contract upgrade leaves
 * it alone (D5). The run notes that, and every builder is told what that HUD draws: the gen-5
 * facade skips arc, path, image, panel and font on it with a console warning the capture never
 * reports, so a brief that offers gauges sends the builder round after round after a gauge that
 * cannot draw.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderBrief } from "../../src/harness-seed/loop/library.ts";
import { facetPrompt } from "../../src/harness-seed/loop/facet-loop.ts";
import { noteHudUpgrade } from "../../src/harness-seed/loop/held-hud.ts";

const LEFT_ALONE = { upgraded: false, materialsAdded: false, hud: { generation: 1, replaced: false } };
const REPLACED = { upgraded: false, hud: { generation: 2, replaced: true, backup: "src/hud.v1.js" } };
const SPEC = { id: "dash", title: "Dashboard", intent: "the speedometer", checks: [], owns: ["src/dash.js"] };

function briefFor(run: Record<string, unknown>): string {
  return renderBrief({ run: { runId: "r", goal: "a racer", ...run }, spec: SPEC, iteration: 1, board: {} } as never);
}

function promptFor(run: Record<string, unknown>): string {
  return facetPrompt({
    run: { runId: "r", goal: "a racer", ...run },
    spec: SPEC,
    iteration: 1,
    resumed: false,
    briefFile: null,
    worktree: "/w",
    ownsMain: false,
  });
}

/** The brief's or prompt's one-screen rule, alone. */
function screenRule(text: string): string {
  return text.split("\n").find((line) => line.startsWith("- ONE SCREEN")) ?? "";
}

describe("an edited first-generation HUD the studio keeps", () => {
  it("is noted as kept, with the generation it holds, and stamped on the run", () => {
    const run: Record<string, unknown> = {};
    const note = noteHudUpgrade(run, LEFT_ALONE);
    assert.ok(note, "a HUD left at an older generation is a decision");
    assert.match(note.decision, /left src\/hud\.js at HUD generation 1/);
    assert.match(note.plain, /text, bars and the crosshair/);
    assert.ok(!/src\/|hud\.js|\bnight\b|\bmorning\b/i.test(note.plain), note.plain);
    assert.equal(run.heldHudGeneration, 1);
  });

  it("notes a replaced HUD with its backup, and the run holds the template's", () => {
    const run: Record<string, unknown> = { heldHudGeneration: 1 };
    const note = noteHudUpgrade(run, REPLACED);
    assert.ok(note);
    assert.match(note.decision, /src\/hud\.v1\.js/);
    assert.equal(run.heldHudGeneration, undefined, "a replaced HUD is the template's");
  });

  it("notes nothing for a current HUD, and keeps the run as it was when the upgrade did not answer", () => {
    const current: Record<string, unknown> = { heldHudGeneration: 1 };
    assert.equal(noteHudUpgrade(current, { upgraded: false }), null);
    assert.equal(current.heldHudGeneration, undefined);
    for (const answer of [null, undefined, "nope", { hud: { generation: "1", replaced: false } }, { hud: null }]) {
      const run: Record<string, unknown> = { heldHudGeneration: 1 };
      assert.equal(noteHudUpgrade(run, answer), null, JSON.stringify(answer));
      if (answer === null || answer === undefined || typeof answer === "string")
        assert.equal(run.heldHudGeneration, 1, "no answer changes nothing");
    }
  });

  it("briefs a builder on the calls it has, not on arcs and gauges it does not", () => {
    const run: Record<string, unknown> = {};
    noteHudUpgrade(run, LEFT_ALONE);
    const held = screenRule(briefFor(run));
    assert.match(held, /text, bars and the crosshair/, held);
    assert.ok(!/arcs and gauges/.test(held), held);
    assert.match(held, /no-dom-ui and single-hud/, "the screen checks still hold");
    // The template's HUD keeps the rule it always had.
    assert.match(screenRule(briefFor({})), /arcs and gauges, vector paths, images/);
  });

  it("prompts a builder the same way", () => {
    const run: Record<string, unknown> = {};
    noteHudUpgrade(run, LEFT_ALONE);
    const held = screenRule(promptFor(run));
    assert.match(held, /ONE SCREEN, ONE INPUT PATH/);
    assert.match(held, /text, bars and the crosshair/, held);
    assert.ok(!/arcs and gauges/.test(held), held);
    assert.match(screenRule(promptFor({})), /text, bars, arcs and gauges, paths, images, panels and fonts/);
  });
});
