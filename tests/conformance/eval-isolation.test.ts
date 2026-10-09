/**
 * The anti-fitting checker (§6.4) over synthetic strings only: a seven-word run of a brief or a
 * checklist term found in an instruction file is a leak naming the file, a brief too short to
 * shingle is exempt rather than silently clean, the vacuity guards refuse a scan that measured
 * nothing, and the walker reads only the instruction trees without following symlinks out.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { parseCases } from "../../scripts/evals/cases.ts";
import {
  checkIsolation,
  findLeaks,
  GRADER_RUBRIC_FILES,
  type IsolationFile,
  IsolationVacuity,
  isolationFiles,
  isolationInputs,
  LeakKind,
  MIN_FILES_SCANNED,
  SHINGLE_WORDS,
  TERM_MIN_WORDS,
} from "../../scripts/evals/check-isolation.ts";
import { tmpDir } from "../helpers/tmp.ts";

const BRIEF = {
  caseId: "lantern-walk",
  text: "Carry a paper lantern along a winding river path at dusk, and light every stone marker.",
};
const SHORT = { caseId: "vague", text: "make me a game about lanterns" };
const TERM = { caseId: "lantern-walk", term: "light every stone marker" };

const filler = (count: number): IsolationFile[] =>
  Array.from({ length: count }, (_, i) => ({ path: `src/harness-seed/filler-${i}.md`, text: "Build good games." }));
const scan = (...files: IsolationFile[]) => findLeaks([BRIEF, SHORT], [TERM], [...files, ...filler(MIN_FILES_SCANNED)]);

describe("findLeaks", () => {
  it("flags a seven-word run of a brief across case, punctuation and line breaks", () => {
    const report = scan({
      path: "src/harness-seed/prompts/tip.md",
      text: "Tip: a PAPER lantern,\nalong a winding river — then stop!",
    });
    assert.equal(SHINGLE_WORDS, 7);
    assert.deepEqual(report.leaks, [
      {
        file: "src/harness-seed/prompts/tip.md",
        caseId: "lantern-walk",
        kind: LeakKind.Shingle,
        match: "a paper lantern along a winding river",
      },
    ]);
    assert.deepEqual(report.vacuity, []);
  });

  it("passes a six-word run and the same words out of order", () => {
    const report = scan(
      { path: "src/a-prompts.ts", text: "a paper lantern along a winding" },
      { path: "src/b-prompts.ts", text: "river winding a along lantern paper a" },
    );
    assert.deepEqual(report.leaks, []);
  });

  it("flags a checklist term only as whole words", () => {
    const report = scan(
      { path: "src/game-template/NOTES.md", text: "Remember to light every stone marker." },
      { path: "src/game-template/other.md", text: "delight every stone markers" },
    );
    assert.deepEqual(
      report.leaks.map((leak) => [leak.file, leak.kind, leak.match]),
      [["src/game-template/NOTES.md", LeakKind.Term, "light every stone marker"]],
    );
  });

  it("names each distinct shingle once per file", () => {
    const text = `${BRIEF.text} ${BRIEF.text}`;
    const report = scan({ path: "src/harness-seed/copy.md", text });
    const shingles = report.leaks.filter((leak) => leak.kind === LeakKind.Shingle).map((leak) => leak.match);
    assert.equal(new Set(shingles).size, shingles.length);
    assert.ok(shingles.length > 0);
  });

  it("exempts a brief shorter than a shingle instead of calling it clean", () => {
    const report = scan({ path: "src/harness-seed/example.md", text: "Say: make me a game about lanterns." });
    assert.deepEqual(report.leaks, []);
    assert.deepEqual(report.exempt, ["vague"]);
  });

  it("refuses a scan over too few files", () => {
    const report = findLeaks([BRIEF], [TERM], filler(MIN_FILES_SCANNED - 1));
    assert.deepEqual(report.vacuity, [IsolationVacuity.FewFiles]);
  });

  it("refuses briefs with fewer sentences than cases, and no briefs at all", () => {
    const blank = findLeaks([BRIEF, { caseId: "blank", text: "   " }], [], filler(MIN_FILES_SCANNED));
    assert.deepEqual(blank.vacuity, [IsolationVacuity.FewSentences]);
    const none = findLeaks([], [], filler(MIN_FILES_SCANNED));
    assert.deepEqual(none.vacuity, [IsolationVacuity.FewSentences]);
  });
});

describe("isolationInputs", () => {
  const cases = parseCases(
    [
      "## C1 · `lantern-walk` — synthetic",
      "**Exposure:** none",
      `> ${BRIEF.text}`,
      "**Acceptance:**",
      "```",
      '[ ] markers light <- "light every stone marker"',
      '[ ] short trace   <- "at dusk"',
      '[ ] split trace   <- "carry a paper lantern ... along a winding river"',
      "[ ] no trace",
      "```",
      "**Control:** the lantern is a tuba that plays the national anthem",
    ].join("\n"),
  );

  it("takes each brief and the traced phrases of four or more words, split at an ellipsis", () => {
    const inputs = isolationInputs(cases);
    assert.equal(TERM_MIN_WORDS, 4);
    assert.deepEqual(inputs.briefs, [BRIEF]);
    assert.deepEqual(
      inputs.terms.map((t) => t.term),
      ["light every stone marker", "carry a paper lantern", "along a winding river"],
    );
  });
});

describe("the isolation walker and CLI check", () => {
  async function repo(): Promise<string> {
    const dir = await tmpDir("eval-isolation-");
    const write = (rel: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    };
    for (let i = 0; i < MIN_FILES_SCANNED; i++) write(`src/harness-seed/notes/n${i}.md`, "Build good games.");
    write("src/game-template/src/main.js", "// a template");
    write("src/plugins/kites/skills/fly/SKILL.md", "Fly kites.");
    write("src/plugins/kites/manifest.json", "{}");
    write("src/main/deep/thing-prompts.ts", "export const P = 'x';");
    write("src/main/deep/thing.ts", `// ${BRIEF.text}`);
    write("src/harness-seed/node_modules/dep/index.js", BRIEF.text);
    write("src/harness-seed/art/sprite.png", BRIEF.text);
    write("outside/leak.md", BRIEF.text);
    fs.symlinkSync(path.join(dir, "outside"), path.join(dir, "src/harness-seed/linked"));
    fs.symlinkSync(path.join(dir, "outside/leak.md"), path.join(dir, "src/game-template/leak.md"));
    write(
      "evals/cases.md",
      [
        "## C1 · `lantern-walk` — synthetic",
        "**Exposure:** none",
        `> ${BRIEF.text}`,
        "**Acceptance:**",
        "```",
        '[ ] markers light <- "light every stone marker"',
        "```",
        "**Control:** the lantern is a tuba",
      ].join("\n"),
    );
    return dir;
  }

  it("walks the instruction trees and prompt modules only, skipping symlinks, dependencies and binaries", async () => {
    const dir = await repo();
    const files = isolationFiles(dir);
    assert.ok(files.includes("src/game-template/src/main.js"));
    assert.ok(files.includes("src/plugins/kites/skills/fly/SKILL.md"));
    assert.ok(files.includes("src/main/deep/thing-prompts.ts"));
    for (const skipped of [
      "src/plugins/kites/manifest.json",
      "src/main/deep/thing.ts",
      "src/harness-seed/node_modules/dep/index.js",
      "src/harness-seed/art/sprite.png",
      "src/harness-seed/linked/leak.md",
      "src/game-template/leak.md",
    ])
      assert.ok(!files.includes(skipped), skipped);
  });

  it("reports a clean tree, then names the file and shingle of a planted leak", async () => {
    const dir = await repo();
    const clean = checkIsolation(dir);
    assert.equal(clean.ok, true, clean.lines.join("\n"));
    fs.writeFileSync(path.join(dir, "src/harness-seed/notes/n3.md"), `Hint: ${BRIEF.text}`);
    const leaked = checkIsolation(dir);
    assert.equal(leaked.ok, false);
    assert.ok(leaked.lines.some((line) => line.startsWith("src/harness-seed/notes/n3.md: lantern-walk shingle")));
  });

  it("scans the graders' rubrics too, but never a symlinked one", async () => {
    const dir = await repo();
    const [checklistRubric, pairwiseRubric] = GRADER_RUBRIC_FILES;
    fs.mkdirSync(path.join(dir, path.dirname(pairwiseRubric)), { recursive: true });
    fs.mkdirSync(path.join(dir, path.dirname(checklistRubric)), { recursive: true });
    fs.writeFileSync(path.join(dir, pairwiseRubric), `Prefer the side where you ${BRIEF.text}`);
    const outside = path.join(dir, "outside.md");
    fs.writeFileSync(outside, `Rubric: ${BRIEF.text}`);
    fs.symlinkSync(outside, path.join(dir, checklistRubric));
    const files = isolationFiles(dir);
    assert.ok(files.includes(pairwiseRubric));
    assert.ok(!files.includes(checklistRubric), "a linked rubric is not followed");
    const leaked = checkIsolation(dir);
    assert.equal(leaked.ok, false);
    assert.ok(leaked.lines.some((line) => line.startsWith(`${pairwiseRubric}: lantern-walk shingle`)));
    assert.ok(!leaked.lines.some((line) => line.startsWith(checklistRubric)));
  });

  it("fails a vacuous scan", async () => {
    const dir = await repo();
    fs.rmSync(path.join(dir, "src/harness-seed/notes"), { recursive: true });
    const report = checkIsolation(dir);
    assert.equal(report.ok, false);
    assert.ok(report.lines.some((line) => line.includes(IsolationVacuity.FewFiles)));
  });
});
