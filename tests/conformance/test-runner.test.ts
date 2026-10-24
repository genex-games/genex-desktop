import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { removeTree } from "../helpers/tmp.ts";

const repo = path.resolve(import.meta.dirname, "../..");
const runner = path.join(repo, "scripts/test.mjs");
const RUN_TIMEOUT_MS = 15_000;

function fixture(t: { after(fn: () => void | Promise<void>): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "studio-test-runner-"));
  t.after(() => removeTree(root));
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write("package.json", '{"type":"module"}');
  write("tsconfig.json", '{"compilerOptions":{"module":"nodenext","moduleResolution":"nodenext"}}');
  write("tests/helpers/studio-rig.ts", "export const rig = true;\n");
  for (const name of ["fast-a", "fast-b", "rig-a", "rig-b"]) {
    const rig = name.startsWith("rig-") ? 'import { rig } from "../helpers/studio-rig.ts"; void rig;' : "";
    write(
      `tests/conformance/${name}.test.ts`,
      `${rig}
import { test } from 'node:test';
import fs from 'node:fs';
test('${name}', () => fs.appendFileSync('events.jsonl', JSON.stringify({ name: '${name}', argv: process.execArgv }) + '\\n'));
`,
    );
  }
  const run = (args: string[] = [], env: NodeJS.ProcessEnv = {}) =>
    spawnSync(process.execPath, [runner, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: RUN_TIMEOUT_MS,
      env: { ...process.env, ...env },
    });
  const events = (): { name: string; argv: string[] }[] => {
    const log = path.join(root, "events.jsonl");
    return fs.existsSync(log)
      ? fs
          .readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  };
  return { root, write, run, events };
}

test("bare npm test runs every fast file with bounded parallelism, then every rig file serially", (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const seen = f.events();
  assert.deepEqual(seen.map(({ name }) => name).sort(), ["fast-a", "fast-b", "rig-a", "rig-b"]);
  assert.ok(seen.slice(0, 2).every(({ name }) => name.startsWith("fast-")));
  for (const { name, argv } of seen)
    assert.ok(argv.includes(`--test-concurrency=${name.startsWith("rig-") ? 1 : 2}`), `${name}: ${argv}`);
});

test("an empty discovered inventory fails, but an empty group in a nonempty inventory is valid", async (t) => {
  const empty = fixture(t);
  await removeTree(path.join(empty.root, "tests/conformance"));
  const missing = empty.run();
  assert.equal(missing.status, 1, missing.stdout + missing.stderr);
  assert.match(missing.stderr, /No test files discovered/);

  const onlyFast = fixture(t);
  for (const name of ["rig-a", "rig-b"]) fs.unlinkSync(path.join(onlyFast.root, `tests/conformance/${name}.test.ts`));
  const noRigs = onlyFast.run(["--group", "rig"]);
  assert.equal(noRigs.status, 0, noRigs.stdout + noRigs.stderr);
  assert.deepEqual(onlyFast.events(), []);
});

test("an explicit file and name pattern never load the selection compiler or unrelated tests", (t) => {
  const f = fixture(t);
  f.write(
    "block-compiler.mjs",
    `import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@typescript/typescript6') throw new Error('selection compiler must stay unloaded');
  return next(specifier, context);
} });
`,
  );
  f.write(
    "tests/conformance/named.test.ts",
    `import { test } from 'node:test'; import fs from 'node:fs';
test('chosen behavior', () => fs.appendFileSync('events.jsonl', JSON.stringify({name:'chosen',argv:process.execArgv})+'\\n'));
test('other behavior', () => { throw new Error('unselected behavior ran'); });
`,
  );
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      path.join(f.root, "block-compiler.mjs"),
      runner,
      "--test-name-pattern",
      "chosen behavior",
      "tests/conformance/named.test.ts",
    ],
    { cwd: f.root, encoding: "utf8", timeout: RUN_TIMEOUT_MS, env: { ...process.env } },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(
    f.events().map(({ name }) => name),
    ["chosen"],
  );
});

test("explicit globs deduplicate files and preserve equal and separate Node flag values", (t) => {
  const f = fixture(t);
  const result = f.run([
    "--test-concurrency",
    "2",
    "--test-reporter",
    "tap",
    "--test-name-pattern=fast-",
    "tests/conformance/fast-*.test.ts",
    "tests/conformance/fast-a.test.ts",
  ]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /TAP version/);
  assert.deepEqual(
    f
      .events()
      .map(({ name }) => name)
      .sort(),
    ["fast-a", "fast-b"],
  );
});

test("flags-only, missing files and unmatched globs fail before any test executes", (t) => {
  const f = fixture(t);
  for (const args of [
    ["--test-name-pattern", "fast"],
    ["tests/conformance/missing.test.ts"],
    ["tests/conformance/missing-*.test.ts"],
    ["--test-name-pattern", "tests/conformance/fast-a.test.ts"],
  ]) {
    const result = f.run(args);
    assert.notEqual(result.status, 0, `${args}: ${result.stdout}${result.stderr}`);
    assert.deepEqual(f.events(), [], `${args}: no implicit Node discovery`);
  }
});

test("group listings are disjoint and complete, and rig concurrency cannot be overridden", (t) => {
  const f = fixture(t);
  const groups = ["fast", "rig"].map((group) => {
    const result = f.run(["--group", group, "--list"]);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().split("\n");
  });
  assert.deepEqual(
    groups.flat().sort(),
    ["fast-a", "fast-b", "rig-a", "rig-b"].map((name) => `tests/conformance/${name}.test.ts`),
  );
  assert.equal(new Set(groups.flat()).size, 4);
  for (const flag of [["--test-concurrency=2"], ["--test-concurrency", "2"]]) {
    const result = f.run(["--group", "rig", ...flag]);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(f.events(), []);
  }
});

test("a failed fast batch still executes the rig batch and fails the complete run", (t) => {
  const f = fixture(t);
  f.write(
    "tests/conformance/fast-a.test.ts",
    "import { test } from 'node:test'; test('fails', () => { throw new Error('expected fixture failure'); });\n",
  );
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.deepEqual(
    f
      .events()
      .map(({ name }) => name)
      .sort(),
    ["fast-b", "rig-a", "rig-b"],
  );
});

test("nested tests clear repository pinning while retaining the leftover-child preload", (t) => {
  const f = fixture(t);
  f.write(
    "tests/conformance/environment.test.ts",
    `import { test } from 'node:test'; import assert from 'node:assert/strict';
test('clean child environment', () => {
  assert.equal(process.env.GIT_DIR, undefined);
  assert.equal(process.env.GIT_INDEX_FILE, undefined);
  assert.equal(process.env.GIT_CONFIG_KEY_0, undefined);
  assert.equal(process.env.GIT_AUTHOR_NAME, 'retained');
});
`,
  );
  const clean = f.run(["tests/conformance/environment.test.ts"], {
    NODE_TEST_CONTEXT: "child-v8",
    GIT_DIR: "/missing-repository",
    GIT_INDEX_FILE: "/missing-index",
    GIT_CONFIG_KEY_0: "bad",
    GIT_AUTHOR_NAME: "retained",
  });
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  f.write(
    "tests/conformance/leftover.test.ts",
    "import { test } from 'node:test'; import { spawn } from 'node:child_process'; test('leaks', () => { spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']); });\n",
  );
  const leak = f.run(["tests/conformance/leftover.test.ts"], { STUDIO_TEST_EXIT_GRACE_MS: "0" });
  assert.notEqual(leak.status, 0);
  assert.match(leak.stdout + leak.stderr, /left 1 child process\(es\) running/);
});

test("a test process terminated by a signal never passes the wrapper", {
  skip: process.platform === "win32" && "POSIX signal termination",
}, (t) => {
  const f = fixture(t);
  f.write("tests/conformance/signal.test.ts", "process.kill(process.pid, 'SIGTERM');\n");
  const result = f.run(["tests/conformance/signal.test.ts"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.error, undefined);
});

test("what a test leaves in the temp folder is gone when its batch ends, and nothing lands beside it", (t) => {
  const f = fixture(t);
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "studio-test-runner-tmp-"));
  t.after(() => removeTree(outer));
  f.write(
    "tests/conformance/litter.test.ts",
    `import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
test('litters', () => {
  const left = fs.mkdtempSync(path.join(os.tmpdir(), 'left-behind-'));
  fs.writeFileSync(path.join(left, 'file'), 'x');
  fs.writeFileSync('litter.txt', left);
});
`,
  );
  const result = f.run(["tests/conformance/litter.test.ts"], { TMPDIR: outer, TMP: outer, TEMP: outer });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const left = fs.readFileSync(path.join(f.root, "litter.txt"), "utf8");
  assert.equal(fs.existsSync(left), false, `${left} survived its batch`);
  assert.deepEqual(fs.readdirSync(outer), []);
});
