/**
 * A plugin's Live card as the host reads its status answer (`shared/plugin-stage-card.ts`): one
 * line, a quieter hint and one step that is the plugin's panel or an action it declared. Whatever
 * else a plugin answers is dropped, never drawn in part.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STAGE_CARD_LABEL_CHARS, STAGE_CARD_LINE_CHARS, stageCardFrom } from "../../src/shared/plugin-stage-card.ts";

const ACTIONS: ReadonlySet<string> = new Set(["open-editor", "set-up"]);

describe("a plugin's Live card", () => {
  it("keeps a line, a hint and a step that is an action the plugin declared or its panel", () => {
    assert.deepEqual(
      stageCardFrom(
        { line: " Plays in Godot. ", hint: "Reloads.", button: { label: "Open", action: "open-editor" } },
        ACTIONS,
      ),
      { line: "Plays in Godot.", hint: "Reloads.", button: { label: "Open", action: "open-editor" } },
    );
    assert.deepEqual(stageCardFrom({ line: "Get it.", button: { label: "Get", panel: true } }, ACTIONS), {
      line: "Get it.",
      button: { label: "Get", panel: true },
    });
  });

  it("shows no card without a line it can draw", () => {
    const rows: Array<[string, unknown]> = [
      ["nothing", null],
      ["a string", "Plays in Godot."],
      ["no line", { hint: "Reloads." }],
      ["a blank line", { line: "   " }],
      ["a number", { line: 7 }],
      ["two lines", { line: "Plays\nin Godot." }],
      ["a bidi override", { line: "Plays \u202Ein Godot." }],
      ["a line too long", { line: "x".repeat(STAGE_CARD_LINE_CHARS + 1) }],
    ];
    for (const [what, answer] of rows) assert.equal(stageCardFrom(answer, ACTIONS), null, what);
  });

  it("drops a hint or step that breaks the rules, keeping the line", () => {
    const rows: Array<[string, Record<string, unknown>]> = [
      ["a hint on two lines", { hint: "a\u2028b" }],
      ["a step naming no declared action", { button: { label: "Delete", action: "delete-everything" } }],
      ["a step with no label", { button: { action: "set-up" } }],
      ["a label too long", { button: { label: "x".repeat(STAGE_CARD_LABEL_CHARS + 1), action: "set-up" } }],
      ["a panel that is no flag", { button: { label: "Get", panel: "yes" } }],
      ["a step that is a string", { button: "set-up" }],
    ];
    for (const [what, fields] of rows)
      assert.deepEqual(
        stageCardFrom({ line: "Plays in Godot.", ...fields }, ACTIONS),
        { line: "Plays in Godot." },
        what,
      );
  });
});
