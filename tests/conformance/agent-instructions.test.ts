import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Developer instruction files and the docs they route to. Their links are the only way a fresh
// agent finds the recipes, so a broken one is a broken instruction.
const root = path.resolve(import.meta.dirname, "../..");
const ROUTED = ["AGENTS.md", "src/AGENTS.md", "tests/AGENTS.md", "docs/agent/glossary.md", "docs/agent/recipes.md"];
const IMPORTS = ["CLAUDE.md", "src/CLAUDE.md", "tests/CLAUDE.md"];
// scripts/build.mjs copies these trees into every user's workspace, where in-app engines read
// any AGENTS.md/CLAUDE.md as their own instructions.
const SHIPPED = ["src/harness-seed", "src/game-template", "src/game-template-cpp", "src/game-template-rust"];
const PAYLOAD = new Set([
  "src/game-template/CLAUDE.md",
  "src/game-template-cpp/CLAUDE.md",
  "src/game-template-rust/CLAUDE.md",
]);

const unfenced = (text: string) => text.replace(/^\s*(```|~~~)[\s\S]*?^\s*\1.*$/gm, "");
const prose = (text: string) => unfenced(text).replace(/`[^`\n]*`/g, "");
// Same slug rule as scripts/check-agent-context.ts, so anchors that pass here pass verify:context.
const slugs = (text: string) =>
  [...unfenced(text).matchAll(/^#+\s+(.+)$/gm)].map((m) =>
    m[1]!
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .replace(/\s+/g, "-"),
  );

/** Relative Markdown links in `file` whose target file or heading anchor does not exist. */
function brokenLinks(base: string, file: string): string[] {
  const text = fs.readFileSync(path.join(base, file), "utf8"),
    broken: string[] = [];
  for (const [, raw] of prose(text).matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const link = raw!.replace(/^<|>$/g, "");
    if (/^[a-z][a-z\d+.-]*:/i.test(link)) continue;
    const [target, anchor] = link.split("#");
    const dest = target ? path.resolve(path.dirname(path.join(base, file)), target) : path.join(base, file);
    if (!dest.startsWith(base + path.sep) || !fs.existsSync(dest)) {
      broken.push(`${file}: ${link}`);
      continue;
    }
    if (anchor && dest.endsWith(".md") && !slugs(fs.readFileSync(dest, "utf8")).includes(anchor))
      broken.push(`${file}: ${link}`);
  }
  return broken;
}

/** CLAUDE.md files that do not import their sibling AGENTS.md as the first line. */
function missingImports(base: string, files: string[]): string[] {
  return files.filter((file) => {
    const lines = fs
      .readFileSync(path.join(base, file), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    return (
      lines[0] !== "@AGENTS.md" || lines.length > 2 || !fs.existsSync(path.join(base, path.dirname(file), "AGENTS.md"))
    );
  });
}

/** Developer instruction files inside trees that ship to user workspaces. */
function shippedInstructions(base: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(base, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/^(agents|claude)\.md$/i.test(entry.name) && !PAYLOAD.has(rel)) found.push(rel);
    }
  };
  for (const dir of SHIPPED) if (fs.existsSync(path.join(base, dir))) walk(dir);
  return found;
}

function scratch(t: { after: (fn: () => void) => void }, files: Record<string, string>): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-instructions-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  return dir;
}

test("link check flags missing files, missing anchors and escapes, and ignores code and URLs", (t) => {
  const dir = scratch(t, {
    "docs/a.md": "# A\n\n## Real heading\n",
    "AGENTS.md": [
      "[ok](docs/a.md) [ok anchor](docs/a.md#real-heading) [self](#top) [web](https://example.com)",
      "[gone](docs/missing.md) [bad anchor](docs/a.md#nope) [escape](../outside.md)",
      "`[code](docs/missing.md)`",
      "```",
      "[fenced](docs/missing.md)",
      "```",
      "# Top",
    ].join("\n"),
  });
  assert.deepEqual(brokenLinks(dir, "AGENTS.md"), [
    "AGENTS.md: docs/missing.md",
    "AGENTS.md: docs/a.md#nope",
    "AGENTS.md: ../outside.md",
  ]);
});

test("every relative link in the developer instructions, glossary and recipes resolves", () => {
  for (const file of ROUTED) assert.ok(fs.existsSync(path.join(root, file)), `${file} is missing`);
  assert.deepEqual(
    ROUTED.flatMap((file) => brokenLinks(root, file)),
    [],
  );
});

test("import check accepts @AGENTS.md plus one line and rejects links, extra text and orphans", (t) => {
  const dir = scratch(t, {
    "AGENTS.md": "# Root",
    "CLAUDE.md": "@AGENTS.md\n",
    "a/AGENTS.md": "# A",
    "a/CLAUDE.md": "@AGENTS.md\nFolder notes.\n",
    "b/AGENTS.md": "# B",
    "b/CLAUDE.md": "Read [AGENTS.md](AGENTS.md).\n",
    "c/AGENTS.md": "# C",
    "c/CLAUDE.md": "@AGENTS.md\none\ntwo\n",
    "d/CLAUDE.md": "@AGENTS.md\n",
  });
  assert.deepEqual(missingImports(dir, ["CLAUDE.md", "a/CLAUDE.md", "b/CLAUDE.md", "c/CLAUDE.md", "d/CLAUDE.md"]), [
    "b/CLAUDE.md",
    "c/CLAUDE.md",
    "d/CLAUDE.md",
  ]);
});

test("each CLAUDE.md imports its folder AGENTS.md", () => {
  assert.deepEqual(missingImports(root, IMPORTS), []);
});

test("shipped-tree check finds nested and differently cased instruction files but allows the template payload", (t) => {
  const dir = scratch(t, {
    "src/game-template/CLAUDE.md": "payload",
    "src/game-template/CLAUDE.own.md": "payload",
    "src/game-template/src/AGENTS.md": "dev",
    "src/game-template-cpp/CLAUDE.md": "payload",
    "src/game-template-cpp/src/CLAUDE.md": "dev",
    "src/game-template-rust/CLAUDE.md": "payload",
    "src/game-template-rust/CLAUDE.own.md": "payload",
    "src/game-template-rust/src/Agents.md": "dev",
    "src/harness-seed/loop/claude.md": "dev",
    "src/harness-seed/AGENTS.md": "dev",
    "src/main/AGENTS.md": "fine",
  });
  assert.deepEqual(shippedInstructions(dir).sort(), [
    "src/game-template-cpp/src/CLAUDE.md",
    "src/game-template-rust/src/Agents.md",
    "src/game-template/src/AGENTS.md",
    "src/harness-seed/AGENTS.md",
    "src/harness-seed/loop/claude.md",
  ]);
});

test("no developer AGENTS.md or CLAUDE.md ships inside harness-seed or any game template", () => {
  for (const payload of PAYLOAD) {
    assert.ok(fs.existsSync(path.join(root, payload)), `${payload} moved; update PAYLOAD`);
  }
  assert.deepEqual(shippedInstructions(root), []);
});
