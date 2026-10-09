/**
 * The judges' rubrics as shipped text (src/harness-seed/judge/*.md).
 *
 * Three rubrics used to carry the same block of known artefact classes, and they only worked if
 * they carried it identically: a class the blind judge reports and the taste judge has never
 * heard of is a defect nobody can act on. The block now lives in ONE file and each rubric writes
 * `{{artefact-classes}}` where it went, so the identity rule is structural rather than
 * asserted — what this file holds instead is that the marker is there, that the expansion with
 * no tokens is what the three rubrics used to say byte for byte, and that a `{when:}` clause
 * never reaches a judge.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import * as pathMod from "node:path";
import { fileURLToPath } from "node:url";
import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  ARTEFACT_MARKER,
  CRITIC_PRINCIPLES,
  VISION_BATCH_FALLBACK,
  artefactTokens,
  filterArtefactClasses,
  judgePrompt,
} from "../../src/harness-seed/loop/judge.ts";

const judgeDir = pathMod.resolve(fileURLToPath(new URL("../../src/harness-seed/judge", import.meta.url)));
const loopDir = pathMod.resolve(fileURLToPath(new URL("../../src/harness-seed/loop", import.meta.url)));
const fixtureDir = pathMod.resolve(fileURLToPath(new URL("../fixtures", import.meta.url)));
const SHARED = ["blind-compare.md", "facet-compare.md", "taste-veto.md"];

function rubric(name: string): string {
  return readFileSync(pathMod.join(judgeDir, name), "utf8");
}

/** The shared file as `judgePrompt` reads it: the trailing newline stripped, nothing else. */
function sharedBlock(): string {
  return readFileSync(pathMod.join(judgeDir, "artefact-classes.md"), "utf8").replace(/\n+$/, "");
}

/** What the three rubrics carried before the block moved out of them, frozen. */
function frozenBlock(): string {
  return readFileSync(pathMod.join(fixtureDir, "artefact-classes-shared.md"), "utf8").replace(/\n+$/, "");
}

/** Classes added to the shared block since it was frozen: the HUD's two (WP-HUD). */
const ADDED_SINCE_FROZEN = ["hud-crowding", "jagged-hud"];

/** A rendered block with the added classes' bullets taken out: what is left is the frozen text. */
function withoutAdded(block: string): string {
  const lines = block.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const added = ADDED_SINCE_FROZEN.some((name) => lines[i]!.startsWith(`- \`[${name}]\``));
    if (!added) {
      out.push(lines[i]!);
      continue;
    }
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) i++;
  }
  return out.join("\n");
}

/** Every added class is in a rendered block, once. */
function assertAdded(block: string): void {
  for (const name of ADDED_SINCE_FROZEN) assert.equal(block.split(`[${name}]`).length - 1, 1, name);
}

describe("the artefact classes the three judges share", () => {
  it("lives in one file, and each rubric carries the marker exactly once", () => {
    for (const name of SHARED) {
      const text = rubric(name);
      assert.equal(text.split(ARTEFACT_MARKER).length - 1, 1, `${name} carries the marker once`);
      assert.equal(text.includes("[haze-plane]"), false, `${name} no longer carries a copy of the block`);
      assert.equal(text.includes("## Known artefact classes"), false, `${name} no longer carries the heading`);
    }
    assert.match(sharedBlock(), /^## Known artefact classes/);
  });

  it("keeps the marker out of the finish rubric, which rides after taste-veto.md and would list the classes twice", () => {
    const text = rubric("taste-finish.md");
    assert.equal(text.includes(ARTEFACT_MARKER), false);
    assert.equal(text.includes("[haze-plane]"), false);
    assert.match(text, /^## The finish stage/);
  });

  it("renders byte for byte what the rubrics used to say when the run declared nothing", () => {
    // This is what makes the migration safe: an empty token set is the identity filter, and the
    // fixture is the text the three rubrics shipped before the block moved.
    // Flipped (WP-HUD): the block has grown the two HUD classes since it was frozen, so the
    // identity holds for everything else, and the two are there exactly once.
    for (const tokens of [[], artefactTokens({}), artefactTokens({ ownShape: true })]) {
      const rendered = filterArtefactClasses(sharedBlock(), tokens);
      assert.equal(withoutAdded(rendered), frozenBlock(), JSON.stringify(tokens));
      assertAdded(rendered);
    }
  });

  it("keeps every class for a first-person run and drops [no-hands] for a game with no hands", () => {
    const all = filterArtefactClasses(sharedBlock(), ["template", "fps"]);
    assert.equal(withoutAdded(all), frozenBlock(), "a shooter sees the whole list");
    assertAdded(all);
    assertAdded(filterArtefactClasses(sharedBlock(), ["template", "racing"]));
    const puzzle = filterArtefactClasses(sharedBlock(), ["template", "puzzle"]);
    assert.equal(puzzle.includes("[no-hands]"), false, "a puzzle has no first-person hands to miss");
    const bullets = (block: string) => (block.match(/^- `\[[a-z-]+\]`/gm) ?? []).length;
    assert.equal(bullets(puzzle), bullets(all) - 1, "exactly one class was dropped");
  });

  it("never lets a {when:} clause reach a judge", () => {
    for (const tokens of [[], ["fps"], ["puzzle"], ["top-down", "own-shape"]]) {
      assert.equal(filterArtefactClasses(sharedBlock(), tokens).includes("{when:"), false, JSON.stringify(tokens));
    }
  });

  it("names each class once", () => {
    const bullets = sharedBlock().match(/^- `\[[a-z-]+\]`/gm) ?? [];
    assert.ok(bullets.length >= 10, "the block is the class list, not an empty heading");
    assert.equal(new Set(bullets).size, bullets.length, "no class is listed twice");
  });

  it("conditions [dead-input] on the GAME line and retracts it for a game that has none", () => {
    const block = sharedBlock();
    assert.equal(block.match(/\[dead-input\]/g)?.length, 1, "the class is named once");
    assert.match(block, /the numbers the GAME line\n {2}names as this game's input evidence are unchanged/);
    assert.match(block, /Never report it when the GAME line says the class does not apply/);
  });

  it("reads its tokens off the run record", () => {
    assert.deepEqual(artefactTokens(null), []);
    assert.deepEqual(artefactTokens({ genres: [], game: {} }), []);
    assert.deepEqual(artefactTokens({ genres: ["FPS"], game: { kind: "first-person" } }).sort(), [
      "first-person",
      "fps",
      "template",
    ]);
    assert.ok(artefactTokens({ genres: ["puzzle"], ownShape: true }).includes("own-shape"));
  });
});

describe("every rubric judge.ts asks for exists", () => {
  it("has a file for every name passed to judgePrompt", () => {
    // The assertion that would have caught vision-batch.md: the name was passed for months and
    // the file was never shipped, so every batch call quietly ran on the inline fallback.
    const source = readFileSync(pathMod.join(loopDir, "judge.ts"), "utf8");
    const names = new Set<string>();
    for (const match of source.matchAll(/"([a-z0-9-]+\.md)"/g)) names.add(match[1]!);
    assert.ok(names.size >= 8, `found only ${names.size} rubric names — did judgePrompt change shape?`);
    const shipped = new Set(readdirSync(judgeDir));
    for (const name of names) assert.ok(shipped.has(name), `judge/${name} is asked for and not shipped`);
  });

  it("ships vision-batch.md opening with the fallback it replaces, plus the confidence rule", () => {
    const text = rubric("vision-batch.md");
    assert.ok(text.startsWith(VISION_BATCH_FALLBACK), "a workspace that deletes the file behaves the same");
    assert.match(text, /0\.7/, "the flip threshold is named");
    assert.match(text, /0\.5/, "the does-not-show-enough threshold is named");
  });
});

describe("the two critics' rubrics", () => {
  it("ships a screen critic that opens by saying what it is not judging", () => {
    const text = rubric("readability.md");
    assert.match(
      text,
      /^This game is a screen, not a place a player walks through: judge what the screen tells the\nplayer, not how real the world feels\./,
    );
    assert.match(
      text,
      /Do not ask for a world\./,
      "the screen critic is told not to grade a board down for being a board",
    );
    for (const principle of CRITIC_PRINCIPLES.screen)
      assert.match(text, new RegExp("`" + principle.key + "`"), `readability.md scores ${principle.key}`);
  });

  it("keeps both tables five grow and three polish, so the arithmetic is one arithmetic", () => {
    for (const [critic, table] of Object.entries(CRITIC_PRINCIPLES)) {
      assert.equal(table.length, 8, `${critic} has eight principles`);
      assert.equal(
        table.filter((p: { kind: string }) => p.kind === "grow").length,
        5,
        `${critic} has five grow principles`,
      );
      assert.equal(
        table.filter((p: { kind: string }) => p.kind === "polish").length,
        3,
        `${critic} has three polish principles`,
      );
    }
    const place = rubric("liveness.md");
    for (const principle of CRITIC_PRINCIPLES.place)
      assert.match(place, new RegExp("`" + principle.key + "`"), `liveness.md scores ${principle.key}`);
  });
});

describe("judgePrompt expands the marker against a workspace", () => {
  /** A workspace with the shipped judge/ directory, minus whatever the caller drops. */
  function workspace(drop: string[] = []): string {
    const root = mkdtempSync(pathMod.join(tmpdir(), "judge-prompt-"));
    mkdirSync(pathMod.join(root, "judge"));
    for (const name of readdirSync(judgeDir)) {
      if (drop.includes(name)) continue;
      cpSync(pathMod.join(judgeDir, name), pathMod.join(root, "judge", name));
    }
    return root;
  }

  it("puts the class list where the marker was", async () => {
    const text = await judgePrompt({ workspace: workspace() } as never, "blind-compare.md", "fallback", []);
    assert.equal(text.includes(ARTEFACT_MARKER), false, "the marker is gone");
    // Flipped (WP-HUD): verbatim apart from the two HUD classes added since the block was frozen.
    assert.ok(withoutAdded(text).includes(frozenBlock()), "and the block it used to carry is back, verbatim");
    assertAdded(text);
    assert.match(text, /^You are judging two builds/, "the rest of the rubric is untouched");
  });

  it("filters the list by the run's tokens", async () => {
    const ws = workspace();
    const text = await judgePrompt({ workspace: ws } as never, "taste-veto.md", "fallback", ["puzzle"]);
    assert.equal(text.includes("[no-hands]"), false);
    assert.ok(text.includes("[haze-plane]"));
  });

  it("returns the rubric unchanged when the shared file is missing", async () => {
    const ws = workspace(["artefact-classes.md"]);
    const text = await judgePrompt({ workspace: ws } as never, "blind-compare.md", "fallback", []);
    assert.equal(text, rubric("blind-compare.md"), "one block short, never a crash");
  });

  it("falls back to the inline prompt when the rubric itself is missing", async () => {
    const ws = workspace(["blind-compare.md"]);
    assert.equal(await judgePrompt({ workspace: ws } as never, "blind-compare.md", "fallback", []), "fallback");
  });

  it("leaves a rubric with no marker alone", async () => {
    const ws = workspace();
    assert.equal(
      await judgePrompt({ workspace: ws } as never, "liveness.md", "fallback", ["fps"]),
      rubric("liveness.md"),
    );
  });
});
