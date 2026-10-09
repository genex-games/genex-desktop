import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { baseAllowlist, checkTestStyle, sourceReads } from "../../scripts/check-test-style.ts";
import { testEnv } from "../../scripts/affected-tests.mjs";

const checker = path.resolve(import.meta.dirname, "../../scripts/check-test-style.ts");

function fixture(t: { after(fn: () => void): void }, tests: Record<string, string>, allowlist?: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "test-style-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files: Record<string, string> = {
    "src/renderer/App.tsx": "export const App = () => null;\n",
    "src/renderer/panels/Chat.tsx": "export const Chat = () => null;\n",
    "src/plugin-sdk/panel.js": "globalThis.panel = 1;\n",
    "src/harness-seed/judge/rubric.md": "# Rubric\n",
    ...Object.fromEntries(Object.entries(tests).map(([name, text]) => [`tests/conformance/${name}`, text])),
    ...(allowlist ? { "tests/test-style-allowlist.json": JSON.stringify({ files: allowlist }) } : {}),
  };
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

const OFFENDER = `import fs, { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');
readFileSync('src/renderer/App.tsx', 'utf8');
fs.readFileSync(path.join(root, 'src', 'renderer', 'panels', 'Chat.tsx'), 'utf8');
read('src/renderer/panels/Chat.tsx');
await readFile(new URL('../../src/renderer/App.tsx', import.meta.url), 'utf8');
for (const name of ['App.tsx']) readFileSync(\`\${root}/src/renderer/\${name}\`).toString();
`;
const CLEAN = `import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { App } from '../../src/renderer/App.tsx';
const read = (rel: string) => fs.readFileSync(path.join('src/harness-seed', rel), 'utf8');
declare const gameDir: string;
App();
read('judge/rubric.md');
fs.readFileSync(path.join(gameDir, 'src', 'main.js'), 'utf8');
fs.readFileSync('src/plugin-sdk/panel.js');
vm.runInNewContext(fs.readFileSync('src/plugin-sdk/panel.js', 'utf8'), {});
fs.readFileSync('tests/fixtures/data.json', 'utf8');
`;

test("flags each way a test reads studio source as text, and nothing else", (t) => {
  const root = fixture(t, { "offender.test.ts": OFFENDER, "clean.test.ts": CLEAN });
  assert.deepEqual(
    sourceReads(root, "tests/conformance/offender.test.ts").map((r) => `${r.line}:${r.target}`),
    [
      "7:src/renderer/App.tsx",
      "8:src/renderer/panels/Chat.tsx",
      "9:src/renderer/panels/Chat.tsx",
      "10:src/renderer/App.tsx",
      "11:src/renderer/App.tsx",
    ],
  );
  // Imports, markdown rubrics, a game's own files, bytes and source executed in a VM are not source-text tests.
  assert.deepEqual(sourceReads(root, "tests/conformance/clean.test.ts"), []);
});

test("dynamic filenames keep the entire known folder when paths use native separators", (t) => {
  const root = fixture(t, {
    "walk.test.ts": `import { readFileSync } from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '../..');
const sources = path.join(root, 'src', 'renderer');
const cards = path.join(root, 'src', 'plugin-sdk', 'skills');
declare const filename: string;
readFileSync(path.join(sources, filename), 'utf8');
readFileSync(path.join(cards, filename), 'utf8');
`,
  });
  const cards = path.join(root, "src", "plugin-sdk", "skills");
  fs.mkdirSync(cards, { recursive: true });
  fs.writeFileSync(path.join(cards, "SKILL.md"), "# A markdown-only payload\n");

  assert.deepEqual(sourceReads(root, "tests/conformance/walk.test.ts"), [
    { file: "tests/conformance/walk.test.ts", line: 7, target: "src/renderer/…" },
  ]);
});

test("a new offender fails; the allowlist admits frozen files and may only shrink", (t) => {
  const root = fixture(t, { "offender.test.ts": OFFENDER, "clean.test.ts": CLEAN });
  const fresh = checkTestStyle(root, { allowlist: [] });
  assert.equal(fresh.length, 5);
  assert.match(fresh[0]!, /^tests\/conformance\/offender\.test\.ts:7: reads src\/renderer\/App\.tsx as text/);
  const frozen = ["tests/conformance/offender.test.ts"];
  assert.deepEqual(checkTestStyle(root, { allowlist: frozen, baseline: frozen }), []);
  assert.match(
    checkTestStyle(root, { allowlist: frozen, baseline: [] }).join("\n"),
    /offender\.test\.ts was added; the list only shrinks/,
  );
  assert.match(
    checkTestStyle(root, { allowlist: [...frozen, "tests/conformance/clean.test.ts"] }).join("\n"),
    /clean\.test\.ts no longer reads source as text; remove it/,
  );
  assert.match(
    checkTestStyle(root, { allowlist: [...frozen, "tests/conformance/gone.test.ts"] }).join("\n"),
    /gone\.test\.ts no longer exists/,
  );
});

test("a base from before the allowlist freezes only the tests that read source there", (t) => {
  const root = fixture(t, { "old.test.ts": OFFENDER, "clean.test.ts": CLEAN });
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=F", "-c", "user.email=f@example.invalid", "-c", "commit.gpgsign=false", ...args],
      { cwd: root, encoding: "utf8", env: testEnv() },
    ).trim();
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "base without a list");
  const base = git("rev-parse", "HEAD");
  // The change that introduces the list also adds a new source-text test and freezes it.
  fs.writeFileSync(path.join(root, "tests/conformance/new.test.ts"), OFFENDER);
  const listed = ["tests/conformance/new.test.ts", "tests/conformance/old.test.ts"];
  fs.writeFileSync(path.join(root, "tests/test-style-allowlist.json"), JSON.stringify({ files: listed }));
  const baseline = baseAllowlist(root, base);
  assert.deepEqual(baseline, ["tests/conformance/old.test.ts"]);
  assert.deepEqual(checkTestStyle(root, { baseline }), [
    "tests/test-style-allowlist.json: tests/conformance/new.test.ts was added; the list only shrinks. Rewrite the test to check behaviour instead.",
  ]);
});

test("the command exits non-zero on a new offender and passes once it is frozen", (t) => {
  const run = (root: string) => spawnSync(process.execPath, [checker], { cwd: root, encoding: "utf8" });
  const failing = run(fixture(t, { "offender.test.ts": OFFENDER }, []));
  assert.equal(failing.status, 1);
  assert.match(failing.stderr, /offender\.test\.ts:9: reads src\/renderer\/panels\/Chat\.tsx as text/);
  const passing = run(fixture(t, { "offender.test.ts": OFFENDER }, ["tests/conformance/offender.test.ts"]));
  assert.equal(passing.status, 0, passing.stderr);
  assert.match(passing.stdout, /1 frozen/);
});
