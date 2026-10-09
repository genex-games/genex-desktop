import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  checkContext,
  checkHandbook,
  checkReferences,
  HANDBOOK_LIMITS,
  localCitations,
  REFERENCE_WORD_LIMIT,
  type Area,
} from "../../scripts/check-agent-context.ts";
import { reviewContext } from "../../scripts/review-agent-context.ts";

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-"));
  fs.mkdirSync(path.join(root, "docs/agent"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs/product"));
  fs.writeFileSync(path.join(root, "docs/agent/context.md"), "# Overview\n[Chat](../product/chat.md)\n");
  fs.writeFileSync(path.join(root, "docs/product/chat.md"), "# Chat\nCurrent product behavior.\n");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/a.ts"), "export const a=1;");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { verify: "true" } }));
  fs.writeFileSync(path.join(root, "docs/agent/doc.md"), "# Behavior\n");
  const area: Area = {
    id: "all",
    sources: ["src/**", "package.json"],
    documents: ["docs/agent/doc.md#behavior"],
    commands: ["verify"],
  };
  const file = path.join(root, "docs/agent/knowledge-map.json");
  const save = () =>
    fs.writeFileSync(
      file,
      JSON.stringify({ version: 2, localOnly: [".studio-dev/**", ".claude/plans/**"], areas: [area] }),
    );
  save();
  return { root, area, file, save };
}
test("source and prose edits require no generated receipts; routing and checking are read-only", (t) => {
  const x = setup();
  t.after(() => fs.rmSync(x.root, { recursive: true, force: true }));
  const original = fs.readFileSync(x.file, "utf8");
  for (const [file, text] of [
    ["src/a.ts", "changed"],
    ["docs/agent/doc.md", "# Behavior\nCurrent contract"],
    ["src/new.ts", "new"],
  ]) {
    fs.writeFileSync(path.join(x.root, file!), text!);
    assert.deepEqual(checkContext(x.root), []);
  }
  fs.unlinkSync(path.join(x.root, "src/new.ts"));
  assert.deepEqual(checkContext(x.root), []);
  assert.match(reviewContext(x.root, "all"), /docs\/agent\/doc.md#behavior/);
  assert.throws(() => reviewContext(x.root, "missing"), /Unknown area/);
  assert.equal(fs.readFileSync(x.file, "utf8"), original);
});
test("missing ownership, command, anchor and document still fail", (t) => {
  const x = setup();
  t.after(() => fs.rmSync(x.root, { recursive: true, force: true }));
  x.area.sources = ["package.json"];
  x.save();
  assert.match(checkContext(x.root).join("\n"), /unmapped.*src\/a/);
  x.area.commands = ["unknown"];
  x.save();
  assert.match(checkContext(x.root).join("\n"), /unknown command/);
  x.area.documents = ["docs/agent/doc.md#absent"];
  x.save();
  assert.match(checkContext(x.root).join("\n"), /broken local anchor/);
  x.area.documents = ["docs/agent/missing.md"];
  x.save();
  assert.match(checkContext(x.root).join("\n"), /broken local link/);
  x.area.documents = ["../outside.md"];
  x.save();
  assert.match(checkContext(x.root).join("\n"), /unsafe document/);
});
test("transitive documentation links cannot depend on local notes or missing files", (t) => {
  const x = setup();
  t.after(() => fs.rmSync(x.root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(x.root, ".studio-dev"), { recursive: true });
  fs.writeFileSync(path.join(x.root, ".studio-dev/note.md"), "Private working note");
  fs.writeFileSync(path.join(x.root, "docs/agent/doc.md"), "# Behavior\n[Topic](topic.md)\n");
  fs.writeFileSync(
    path.join(x.root, "docs/agent/topic.md"),
    "[Evidence](../../.studio-dev/note.md)\n[Missing](missing.md)\n[Back](doc.md#behavior)",
  );
  const errors = checkContext(x.root).join("\n");
  assert.match(errors, /local-only.*\.studio-dev/);
  assert.match(errors, /broken local link missing.md/);
});
test("ignored local artifacts pass, force-added artifacts fail, untracking preserves local bytes", (t) => {
  const x = setup();
  t.after(() => fs.rmSync(x.root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: x.root, stdio: "pipe" });
  git("init", "-q");
  fs.writeFileSync(path.join(x.root, ".gitignore"), ".studio-dev/\n.claude/plans/\n");
  x.area.sources.push(".gitignore");
  x.save();
  for (const file of [".studio-dev/notes/task.md", ".claude/plans/report.json"]) {
    fs.mkdirSync(path.dirname(path.join(x.root, file)), { recursive: true });
    fs.writeFileSync(path.join(x.root, file), "retained evidence");
    assert.deepEqual(checkContext(x.root), []);
    git("add", "-f", "--", file);
    assert.match(checkContext(x.root).join("\n"), /local artifact in Git index/);
    git("rm", "--cached", "--", file);
    assert.equal(fs.readFileSync(path.join(x.root, file), "utf8"), "retained evidence");
  }
  assert.deepEqual(checkContext(x.root), []);
});
test("old fingerprint receipts and malformed maps are rejected without mutation", (t) => {
  const x = setup();
  t.after(() => fs.rmSync(x.root, { recursive: true, force: true }));
  (x.area as Area & { review: object }).review = {};
  x.save();
  assert.match(checkContext(x.root).join("\n"), /remove generated review fingerprints/);
  fs.writeFileSync(x.file, JSON.stringify({ version: 2, localOnly: [], areas: [null] }));
  assert.match(checkContext(x.root).join("\n"), /invalid\/duplicate area/);
});
test("handbook limits reject growing pages and dense dumps without rewriting documents", (t) => {
  const x = setup();
  t.after(() => fs.rmSync(x.root, { recursive: true, force: true }));
  const intro = path.join(x.root, "docs/agent/context.md");
  const topic = path.join(x.root, "docs/product/chat.md");
  fs.appendFileSync(intro, "word ".repeat(HANDBOOK_LIMITS.overview));
  assert.match(checkContext(x.root).join("\n"), /context.md uses.*limit 500/);
  fs.writeFileSync(intro, "[Chat](../product/chat.md)");
  const oversized = "word ".repeat(HANDBOOK_LIMITS.topic + 1);
  fs.writeFileSync(topic, oversized);
  assert.match(checkHandbook(x.root).join("\n"), /chat.md uses.*limit 800/);
  assert.equal(fs.readFileSync(topic, "utf8"), oversized);
  fs.writeFileSync(topic, "x".repeat(HANDBOOK_LIMITS.topic * 16 + 1));
  assert.match(checkHandbook(x.root).join("\n"), /chat.md uses 1 words/);
});
test("splitting or adding unlisted pages cannot evade the shared handbook budget", (t) => {
  const x = setup();
  t.after(() => fs.rmSync(x.root, { recursive: true, force: true }));
  const intro = path.join(x.root, "docs/agent/context.md");
  // Every page fits individually, but all pages are counted even without map entries.
  for (let i = 0; i < 6; i++) {
    const name = `part-${i}.md`;
    fs.writeFileSync(path.join(x.root, "docs/product", name), "word ".repeat(700));
    fs.appendFileSync(intro, `\n[Part ${i}](../product/${name})`);
  }
  assert.match(checkHandbook(x.root).join("\n"), /total.*exceeds 4000/);
  for (let i = 0; i < 6; i++) fs.unlinkSync(path.join(x.root, "docs/product", `part-${i}.md`));
  fs.writeFileSync(path.join(x.root, "docs/product/new.md"), "# New page");
  assert.match(checkHandbook(x.root).join("\n"), /link docs\/product\/new.md/);
  for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(x.root, "docs/product", `extra-${i}.md`), "# Part");
  assert.match(checkHandbook(x.root).join("\n"), /product pages exceed 8/);
});
test("handbook is required and cannot hide appendices in nested folders or artifact files", (t) => {
  const x = setup();
  t.after(() => fs.rmSync(x.root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(x.root, "docs/product/appendices"));
  fs.writeFileSync(path.join(x.root, "docs/product/report.json"), "{}");
  assert.equal(checkHandbook(x.root).filter((e) => e.includes("must be a Markdown page")).length, 2);
  fs.rmSync(path.join(x.root, "docs/product"), { recursive: true });
  fs.unlinkSync(path.join(x.root, "docs/agent/context.md"));
  const errors = checkHandbook(x.root).join("\n");
  assert.match(errors, /missing docs\/product/);
  assert.match(errors, /missing docs\/agent\/context.md/);
});
test("agent reference pages stay current references: no dated headings and a word cap (DEVX-2)", (t) => {
  const x = setup();
  t.after(() => fs.rmSync(x.root, { recursive: true, force: true }));
  const page = path.join(x.root, "docs/agent/doc.md");
  for (const heading of [
    "## Autopilot corrections (17 September)",
    "### Seed upgrade (2026-09-22)",
    "## Loop runs (16 September continuation)",
  ]) {
    fs.writeFileSync(page, `# Behavior\n${heading}\nText.\n`);
    assert.match(checkReferences(x.root).join("\n"), /docs\/agent\/doc\.md: dated heading/, heading);
  }
  fs.writeFileSync(
    page,
    "# Behavior\n## Seed upgrades\nOn 2026-09-22 the seed moved; prose may carry a date.\n```\n# (2026-09-22) inside a code block\n```\n",
  );
  assert.deepEqual(checkReferences(x.root), []);
  fs.writeFileSync(page, `# Behavior\n${"word ".repeat(REFERENCE_WORD_LIMIT + 1)}`);
  assert.match(checkReferences(x.root).join("\n"), /doc\.md uses \d+ words; limit/);
  assert.match(checkContext(x.root).join("\n"), /doc\.md uses \d+ words; limit/, "checkContext runs it");
});
test("tracked code cannot cite a local-only document; generic names, prose docs and untracked files pass", (t) => {
  const x = setup();
  t.after(() => fs.rmSync(x.root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: x.root, stdio: "pipe" });
  git("init", "-q");
  // Fictional names: the real localOnly list must never appear in this tracked file.
  const local = ["SCRATCH-NOTES.md", "notes/README.md", "notes/shot.png", "drafts/**"];
  x.area.sources.push(".gitignore");
  fs.writeFileSync(x.file, JSON.stringify({ version: 2, localOnly: local, areas: [x.area] }));
  fs.writeFileSync(path.join(x.root, ".gitignore"), "SCRATCH-NOTES.md\nnotes/\ndrafts/\n");
  fs.writeFileSync(path.join(x.root, "src/README.md"), "# Source\n");
  fs.writeFileSync(
    path.join(x.root, "src/a.ts"),
    "// See OTHER-SCRATCH-NOTES.md, README.md, SCRATCH-NOTES.mdx, shot.png, drafts/x.md\n",
  );
  fs.writeFileSync(path.join(x.root, "docs/agent/doc.md"), "# Behavior\nOwners keep SCRATCH-NOTES.md locally.\n");
  git("add", "-A");
  assert.deepEqual(checkContext(x.root), []);
  fs.writeFileSync(path.join(x.root, "src/b.ts"), "/** Rule from SCRATCH-NOTES.md §2. */\nexport const b = 2;\n");
  assert.deepEqual(checkContext(x.root), [], "an untracked file is not part of the repository yet");
  git("add", "src/b.ts");
  fs.writeFileSync(path.join(x.root, "src/a.ts"), "export const a = 1; // (../notes/README.md)\n");
  assert.deepEqual(checkContext(x.root), [
    "src/a.ts:1: cites local-only document notes/README.md; state the rule or link a maintained doc instead",
    "src/b.ts:1: cites local-only document SCRATCH-NOTES.md; state the rule or link a maintained doc instead",
  ]);
  fs.mkdirSync(path.join(x.root, "scripts"));
  fs.writeFileSync(path.join(x.root, "scripts/d.ts"), "x\n# SCRATCH-NOTES.md\n");
  // Shipped seed and template payload is exempt: editing it would refresh every install. So is a
  // byte-for-byte copy of a shipped file an upgrade test recognises by its digest.
  for (const payload of [
    "src/harness-seed/loop/x.mjs",
    "src/game-template/src/y.js",
    "src/harness-boot/z.mjs",
    "tests/fixtures/shipped/w.js.txt",
  ]) {
    fs.mkdirSync(path.join(x.root, path.dirname(payload)), { recursive: true });
    fs.writeFileSync(path.join(x.root, payload), "// see SCRATCH-NOTES.md\n");
  }
  assert.deepEqual(
    localCitations(x.root, local, [
      "scripts/d.ts",
      "tests/missing.ts",
      "docs/agent/knowledge-map.json",
      "src/harness-seed/loop/x.mjs",
      "src/game-template/src/y.js",
      "src/harness-boot/z.mjs",
      "tests/fixtures/shipped/w.js.txt",
    ]),
    ["scripts/d.ts:2: cites local-only document SCRATCH-NOTES.md; state the rule or link a maintained doc instead"],
  );
});
