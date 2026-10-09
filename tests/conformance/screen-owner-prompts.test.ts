/**
 * Builders hear who owns the screen. The screen-owner rule (loop/screen-owner.ts) turns a non-owner's
 * call into the contract HUD into a code-review finding, but a builder that reads nothing about the
 * owner draws its own readouts beside the HUD part's and learns the rule only from the review. The
 * brief and the opening prompt say it,
 * from the spec's typed `ownsScreen` / `screenOwner` fields; a run with no owner reads as before.
 *
 * And the chat that launches a build narrows it without cutting the game's own front-end: "a
 * system they did not name goes in cut" must not read a title screen and a start key as systems.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderBrief } from "../../src/harness-seed/loop/library.ts";
import { facetPrompt } from "../../src/harness-seed/loop/facet/prompt.ts";
import { launchRules } from "../../src/harness-seed/loop/launch-prompts.ts";
import { turnBriefing } from "../../src/harness-seed/loop/turn-prompts.ts";
import { FINISH_RULES } from "../../src/harness-seed/loop/facet/stage-prompts.ts";
import { screenOwnerLine } from "../../src/harness-seed/loop/screen-owner-prompts.ts";
import { screenOwnership } from "../../src/harness-seed/loop/screen-owner.ts";

const RUN = { runId: "r1", goal: "a night racer", project: "/games/apex" };
const BASE = { id: "race", title: "Race", intent: "the pursuit", checks: [], owns: ["src/race.js"] };
const OWNER = { ...BASE, id: "hud", owns: ["src/hud-ui.js"], ownsScreen: true, screenOwner: "hud" };
const NON_OWNER = { ...BASE, screenOwner: "hud" };

function brief(spec: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return renderBrief({ run: RUN, spec, iteration: 1, board: {}, ...extra } as never);
}

function prompt(spec: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  return facetPrompt({
    run: RUN,
    spec,
    iteration: 1,
    resumed: false,
    briefFile: ".studio/BRIEF.md",
    briefText: null,
    worktree: "/w",
    ownsMain: false,
    ...extra,
  });
}

/** The text with every line that names the screen's owner taken out, its blank lines collapsed as the renderers do. */
function withoutOwnerLines(text: string, owner: string): string {
  return text
    .split("\n")
    .filter((line) => !line.includes(`screen owner ${owner}`) && !line.startsWith("- YOU OWN THE SCREEN"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

const RENDERERS: Array<[string, (spec: Record<string, unknown>) => string]> = [
  ["the brief", (spec) => brief(spec)],
  ["the opening prompt that points at the brief", (spec) => prompt(spec)],
  ["a direct engine's opening prompt", (spec) => prompt(spec, { briefFile: null })],
];

describe("who owns the screen, as a builder reads it", () => {
  for (const [where, render] of RENDERERS) {
    it(`tells the owner in ${where} that the HUD, the menus and the layout are its`, () => {
      const text = render(OWNER);
      const line = text.split("\n").find((each) => each.startsWith("- YOU OWN THE SCREEN"));
      assert.ok(line, text);
      assert.match(line, /the HUD, the menus and the layout/);
      // The owner builds the front-end, so it hears the front-end's obligation where it hears the job.
      assert.match(line, /config\.begin.*config\.flow/, "a title without begin/flow shows every judge the title");
      assert.ok(!text.includes("the screen owner hud draws them"), "the owner is not told to keep off its own screen");
    });

    it(`tells every other part in ${where} to publish its values for the owner to draw`, () => {
      const text = render(NON_OWNER);
      const line = text.split("\n").find((each) => each.includes("the screen owner hud draws them"));
      assert.ok(line, text);
      assert.match(line, /publish .*state\(\).*module's API/);
      assert.match(line, /code-review finding/, "the rule is enforced, and the line says how");
      // Every call the rule flags is named, so a hit flash or a crosshair does not read as allowed.
      for (const call of ["text", "bar", "arc", "path", "image", "panel", "font", "crosshair", "flash"])
        assert.match(line, new RegExp(`\\b${call}\\b`), call);
      assert.match(line, /THE SCREEN BELONGS TO PART "hud"/);
      assert.ok(!text.includes("YOU OWN THE SCREEN"));
    });

    it(`renders ${where} as before when no part owns the screen: only the owner's line differs`, () => {
      const none = render(BASE);
      assert.equal(withoutOwnerLines(render(NON_OWNER), "hud"), none);
      // A field that is not the typed shape is no owner (screen-owner.ts reads it the same way).
      for (const fields of [
        { ownsScreen: false },
        { screenOwner: "" },
        { screenOwner: 7 },
        { ownsScreen: "true" },
        { screenOwner: null },
      ])
        assert.equal(render({ ...BASE, ...fields }), none, JSON.stringify(fields));
    });
  }

  it("tells the line's side exactly as the screen-owner rule decides it, for well-formed and malformed fields", () => {
    const fields: Array<Record<string, unknown>> = [
      {},
      { ownsScreen: true },
      { ownsScreen: true, screenOwner: "other" },
      { screenOwner: "hud" },
      { ownsScreen: false, screenOwner: "hud" },
      { ownsScreen: "true", screenOwner: "hud" },
      { ownsScreen: false },
      { screenOwner: "" },
      { screenOwner: 7 },
      { screenOwner: null },
      { ownsScreen: "true" },
    ];
    for (const spec of fields) {
      const flagged = screenOwnership({
        file: "src/race.js",
        added: [{ line: 1, text: "__studio.hud.text('speed', 0.1, 0.1);" }],
        spec,
        template: true,
      }).length;
      const line = screenOwnerLine(spec) ?? "";
      assert.equal(line.includes("code-review finding"), flagged > 0, JSON.stringify(spec));
      assert.equal(line.startsWith("- YOU OWN THE SCREEN"), spec.ownsScreen === true, JSON.stringify(spec));
    }
  });

  it("says nothing of an owner in a game of its own shape, where the rule is inert", () => {
    const own = { screen: false, template: false };
    assert.equal(brief(NON_OWNER, own), brief(BASE, own));
    assert.equal(brief(OWNER, own), brief({ ...OWNER, ownsScreen: undefined, screenOwner: undefined }, own));
    const shaped = { ownShape: true, shape: { main: "src/index.ts", entry: "index.html" } };
    assert.equal(prompt(NON_OWNER, shaped), prompt(BASE, shaped));
  });
});

describe("a finishing part and a resumed session hear who owns the screen", () => {
  const finish = { stage: "finish", polish: ["the speedometer's needle is blurry"] };
  const HUD_CRAFT = "the HUD's craft";
  /** The brief's finish section, up to its polish list. */
  const finishOf = (text: string) =>
    text.slice(text.indexOf("## THE FINISH"), text.indexOf("The judge's polish list")).split("\n");

  it("never tells a finishing part that does not own the screen to polish the HUD's craft", () => {
    const text = brief(NON_OWNER, finish);
    assert.ok(!text.includes(HUD_CRAFT), text);
    assert.ok(text.includes("the screen owner hud draws them"), "the owner's line is still there");
    // A polish item about the HUD is handed to the owner, not left as this part's work.
    assert.ok(
      finishOf(text).some((line) => line.includes("screen owner")),
      text,
    );
  });

  it("keeps the finish rules as they are for the owner and when no part owns the screen", () => {
    for (const spec of [OWNER, BASE]) {
      const text = brief(spec, finish);
      for (const rule of FINISH_RULES) assert.ok(text.includes(rule), `${spec.id}: ${rule}`);
    }
    // A non-owner reads the same finish section with only the rule about the HUD changed.
    const others = finishOf(brief(NON_OWNER, finish));
    const before = finishOf(brief(BASE, finish));
    assert.deepEqual(
      before.filter((line) => !others.includes(line)),
      FINISH_RULES.filter((rule) => rule.includes(HUD_CRAFT)),
    );
  });

  it("tells a finishing part of a game of its own shape the finish rules as they are", () => {
    const own = { ...finish, screen: false, template: false };
    assert.equal(brief(NON_OWNER, own), brief(BASE, own));
  });

  const resumed = (spec: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    prompt(spec, { resumed: true, iteration: 3, ...extra });

  it("repeats the owner's line in a direct engine's resumed prompt, which has no brief to point at", () => {
    const direct = { briefFile: null };
    assert.ok(resumed(NON_OWNER, direct).includes("the screen owner hud draws them"));
    assert.ok(
      resumed(OWNER, direct)
        .split("\n")
        .some((line) => line.startsWith("- YOU OWN THE SCREEN")),
    );
    // The resumed prompt keeps its blank lines as it always has, so only the one line is taken out.
    const lines = resumed(NON_OWNER, direct).split("\n");
    const at = lines.findIndex((line) => line.includes("the screen owner hud draws them"));
    assert.equal([...lines.slice(0, at), ...lines.slice(at + 1)].join("\n"), resumed(BASE, direct));
  });

  it("leaves a resumed prompt that points at the brief, and every run with no owner, as it was", () => {
    assert.equal(resumed(NON_OWNER), resumed(BASE));
    assert.equal(resumed(OWNER), resumed({ ...OWNER, ownsScreen: undefined, screenOwner: undefined }));
    const shaped = { briefFile: null, ownShape: true, shape: { main: "src/index.ts", entry: "index.html" } };
    assert.equal(resumed(NON_OWNER, shaped), resumed(BASE, shaped));
  });
});

describe("narrowing a build keeps the game's own front-end", () => {
  const sentences = (text: string) => text.split(/(?<=[.:])\s+/);
  const cutSentences = (text: string) => sentences(text).filter((each) => each.includes("goes in cut"));

  const BRIEFINGS: Array<[string, string]> = [
    ["a delegated Loop chat", launchRules("claude-code", { toolName: "start_unattended_run" }).join("\n")],
    ["a direct Autopilot briefing", turnBriefing({ autopilot: {} }) ?? ""],
    ["a direct Loop briefing", turnBriefing({ loop: { hours: 2 } }) ?? ""],
  ];
  for (const [who, text] of BRIEFINGS) {
    it(`never lets ${who} cut the title, the start on a key or the results`, () => {
      const said = cutSentences(text);
      assert.ok(said.length, text);
      for (const sentence of said) {
        assert.match(sentence, /title/, sentence);
        assert.match(sentence, /start on a key/, sentence);
        assert.match(sentence, /results/, sentence);
        assert.match(sentence, /template requires/, sentence);
      }
    });
  }
});
