import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Codex loads .agents/skills and Claude Code loads .claude/skills; the second is a byte copy of
// the first (see .agents/skills/SOURCES.md), so both agents get the same instructions.
const root = path.resolve(import.meta.dirname, "../..");
const codex = path.join(root, ".agents/skills"),
  claude = path.join(root, ".claude/skills");
const files = (dir: string) =>
  (fs.readdirSync(dir, { recursive: true }) as string[])
    .filter((rel) => fs.statSync(path.join(dir, rel)).isFile())
    .map((rel) => rel.split(path.sep).join("/"))
    .sort();
const skills = (dir: string) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
const frontmatter = (text: string) => {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1];
  return block === undefined
    ? null
    : Object.fromEntries(
        block
          .split("\n")
          .map((line) => /^([a-z-]+):\s*(.*)$/.exec(line))
          .filter((m) => m)
          .map((m) => [m![1], m![2]]),
      );
};

test("every skill in .agents/skills has an identical mirror in .claude/skills and vice versa", () => {
  assert.deepEqual(
    skills(claude),
    skills(codex),
    "skill directories differ; copy .agents/skills/<name> to .claude/skills/<name>",
  );
  assert.deepEqual(files(claude), files(codex), "file lists differ");
  for (const rel of files(codex))
    assert.ok(
      fs.readFileSync(path.join(codex, rel)).equals(fs.readFileSync(path.join(claude, rel))),
      `${rel} differs between .agents/skills and .claude/skills`,
    );
});

test("each skill has frontmatter naming its directory and describing when to use it", () => {
  for (const name of skills(codex)) {
    const meta = frontmatter(fs.readFileSync(path.join(codex, name, "SKILL.md"), "utf8"));
    assert.ok(meta, `${name}/SKILL.md has no frontmatter`);
    assert.equal(meta.name, name);
    assert.ok((meta.description ?? "").length > 20, `${name} needs a description`);
  }
});

test("opt-in exploration skills stay out of automatic invocation for both agents", () => {
  for (const name of ["break", "variant"]) {
    assert.equal(
      frontmatter(fs.readFileSync(path.join(codex, name, "SKILL.md"), "utf8"))?.["disable-model-invocation"],
      "true",
      name,
    );
    assert.match(
      fs.readFileSync(path.join(codex, name, "agents/openai.yaml"), "utf8"),
      /allow_implicit_invocation: false/,
      name,
    );
  }
});

// The skills this repository wrote itself; the other directories are the pinned upstream design
// skills `.agents/skills/SOURCES.md` records.
const ENGINEERING_SKILLS = [
  "add-event-type",
  "add-genex-api",
  "add-ipc-channel",
  "add-plugin-tool",
  "harness-incident-fix",
  "run-area-tests",
  "verify-ui-via-dev-control",
] as const;

// Design skills this repository wrote itself, named in SOURCES.md beside the engineering list.
const LOCAL_DESIGN_SKILLS = ["wire-art"] as const;

test("SOURCES.md names every engineering skill and every skill directory is engineering or upstream", () => {
  const sources = fs.readFileSync(path.join(codex, "SOURCES.md"), "utf8");
  const upstream = [...sources.matchAll(/^- `([a-z-]+)`$/gm)].map((m) => m[1] ?? "").sort();
  assert.deepEqual(
    skills(codex),
    [...upstream, ...ENGINEERING_SKILLS, ...LOCAL_DESIGN_SKILLS].sort(),
    "a skill directory is neither upstream (SOURCES.md list) nor a local engineering or design skill",
  );
  const engineeringLine = /The engineering skills\s*\(([^)]*)\)/.exec(sources)?.[1] ?? "";
  const named = [...engineeringLine.matchAll(/`([a-z-]+)`/g)].map((m) => m[1] ?? "").sort();
  assert.deepEqual(named, [...ENGINEERING_SKILLS].sort(), "SOURCES.md's engineering list is out of date");
  for (const name of LOCAL_DESIGN_SKILLS) assert.match(sources, new RegExp(`design skill \`${name}\``), name);
});

test("every repository path an engineering skill names exists", () => {
  const roots = /^(src|tests|docs|scripts|native|evals|\.github)\//;
  for (const name of ENGINEERING_SKILLS) {
    const text = fs.readFileSync(path.join(codex, name, "SKILL.md"), "utf8");
    for (const [, token = ""] of text.matchAll(/`([^`\s]+)`/g)) {
      const file = token.replace(/[:#].*$/, "").replace(/[.,;]$/, "");
      if (!roots.test(file) || /[<*{}()$|]/.test(file) || file.endsWith("/")) continue;
      assert.ok(fs.existsSync(path.join(root, file)), `${name}/SKILL.md names ${file}, which does not exist`);
    }
  }
});
