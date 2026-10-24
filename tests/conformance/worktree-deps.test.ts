import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DepsOutcome, depsKey, restoreDeps } from "../../scripts/worktree-deps.ts";
import { HOUR_MS } from "../../src/shared/duration.ts";
import { tmpDir } from "../helpers/tmp.ts";

const KEY = "0123456789abcdef";
const NOW = Date.parse("2026-10-17T12:00:00Z");

/** Steps that record their calls: an install writes one package, a clone copies the folder. */
function steps(inUse = false) {
  const calls: string[] = [];
  return {
    calls,
    install(checkout: string) {
      calls.push(`install ${path.basename(checkout)}`);
      fs.mkdirSync(path.join(checkout, "node_modules", "pkg"), { recursive: true });
      fs.writeFileSync(path.join(checkout, "node_modules", "pkg", "index.js"), "installed");
    },
    clone(from: string, to: string) {
      calls.push(`clone ${path.basename(path.dirname(from))}`);
      fs.cpSync(from, to, { recursive: true });
    },
    inUse: () => inUse,
  };
}

async function repo() {
  const root = await tmpDir("worktree-deps-");
  const checkout = (name: string) => {
    fs.mkdirSync(path.join(root, name), { recursive: true });
    return path.join(root, name);
  };
  return { shared: path.join(root, "main", ".studio-dev", "deps"), checkout };
}

const pkg = (checkout: string) => fs.readFileSync(path.join(checkout, "node_modules", "pkg", "index.js"), "utf8");

test("the first checkout installs and shares, the next ones clone, and a current one is left alone", async () => {
  const r = await repo();
  const s = steps();
  const [a, b] = [r.checkout("a"), r.checkout("b")];
  assert.equal(restoreDeps(a, r.shared, KEY, s, NOW), DepsOutcome.Installed);
  assert.equal(restoreDeps(b, r.shared, KEY, s, NOW), DepsOutcome.Cloned);
  assert.equal(restoreDeps(b, r.shared, KEY, s, NOW), DepsOutcome.Current);
  assert.deepEqual(s.calls, ["install a", "clone a", `clone ${KEY}`]);
  assert.equal(pkg(b), "installed");
  assert.deepEqual(fs.readdirSync(r.shared), [KEY]);
});

test("a stale install is replaced, a link's target is never touched, and a used one is refused", async (t) => {
  const r = await repo();
  restoreDeps(r.checkout("seed"), r.shared, KEY, steps(), NOW);
  const elsewhere = r.checkout("elsewhere");
  fs.writeFileSync(path.join(elsewhere, "keep"), "x");
  const cases: Array<[string, (checkout: string) => void]> = [
    ["an install from another lockfile", (c) => fs.mkdirSync(path.join(c, "node_modules", "old"), { recursive: true })],
    ["a link to another checkout's node_modules", (c) => fs.symlinkSync(elsewhere, path.join(c, "node_modules"))],
  ];
  for (const [name, arrange] of cases)
    await t.test(name, () => {
      const checkout = r.checkout(name.replaceAll(" ", "-"));
      arrange(checkout);
      assert.equal(restoreDeps(checkout, r.shared, KEY, steps(), NOW), DepsOutcome.Cloned);
      assert.equal(fs.lstatSync(path.join(checkout, "node_modules")).isSymbolicLink(), false);
      assert.equal(fs.existsSync(path.join(checkout, "node_modules", "old")), false);
      assert.deepEqual(fs.readdirSync(elsewhere), ["keep"]);
    });
  await t.test("a node_modules a running dev app uses", () => {
    const checkout = r.checkout("running");
    fs.mkdirSync(path.join(checkout, "node_modules", "electron"), { recursive: true });
    const s = steps(true);
    assert.throws(() => restoreDeps(checkout, r.shared, KEY, s, NOW), /running dev app uses/);
    assert.deepEqual(s.calls, []);
    assert.deepEqual(fs.readdirSync(path.join(checkout, "node_modules")), ["electron"]);
  });
});

test("a half-made shared install is never cloned, and only the newest two installs are kept", async () => {
  const r = await repo();
  fs.mkdirSync(path.join(r.shared, KEY, "node_modules"), { recursive: true });
  const old = (name: string, age: number) => {
    fs.mkdirSync(path.join(r.shared, name), { recursive: true });
    fs.utimesSync(path.join(r.shared, name), (NOW - age) / 1000, (NOW - age) / 1000);
  };
  old("aaaaaaaaaaaaaaaa", 3 * HOUR_MS);
  old("bbbbbbbbbbbbbbbb", 2 * HOUR_MS);
  old(`${KEY}.123.tmp`, 2 * HOUR_MS);
  old(`${KEY}.456.tmp`, 0);
  const s = steps();
  assert.equal(restoreDeps(r.checkout("a"), r.shared, KEY, s, NOW), DepsOutcome.Installed);
  assert.deepEqual(s.calls, ["install a", "clone a"]);
  assert.equal(fs.existsSync(path.join(r.shared, KEY, ".complete")), true);
  // The current install, the newest older one, and the staging another checkout is still writing.
  assert.deepEqual(fs.readdirSync(r.shared).sort(), [KEY, `${KEY}.456.tmp`, "bbbbbbbbbbbbbbbb"].sort());
});

test("an install's key changes with the lockfile and with the runtime its native packages need", () => {
  const runtime = { platform: "darwin", arch: "arm64", versions: { modules: "137" } };
  const lock = Buffer.from('{"lockfileVersion":3}');
  const key = depsKey(lock, runtime);
  assert.match(key, /^[0-9a-f]{16}$/);
  assert.equal(depsKey(Buffer.from('{"lockfileVersion":3}'), runtime), key);
  assert.notEqual(depsKey(Buffer.from('{"lockfileVersion":3,"x":1}'), runtime), key);
  assert.notEqual(depsKey(lock, { ...runtime, versions: { modules: "127" } }), key);
  assert.notEqual(depsKey(lock, { ...runtime, arch: "x64" }), key);
});
