/**
 * The packaged app keeps V8's compiled code for its main bundle between launches, so a launch does
 * not parse and compile the whole bundle again. Only a normal packaged launch writes the cache:
 * development and test launches leave every profile folder as it was.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { COMPILE_CACHE_FOLDER, startCompileCache, type CompileCacheHost } from "../../src/main/compile-cache.ts";

interface Hooks {
  tick?: () => Promise<void>;
  quit?: () => void;
}

function fakeHost(overrides: Partial<CompileCacheHost> = {}) {
  const calls: string[] = [];
  const hooks: Hooks = {};
  const host: CompileCacheHost = {
    packaged: true,
    argv: ["/Applications/Genex.app/Contents/MacOS/Genex"],
    userData: "/Users/someone/Library/Application Support/Genex",
    enable: (dir) => {
      calls.push(`enable ${dir}`);
      return { enabled: true, directory: dir };
    },
    flush: () => calls.push("flush"),
    onQuit: (write) => {
      calls.push("onQuit");
      hooks.quit = write;
    },
    later: (write) => {
      calls.push("later");
      hooks.tick = write;
    },
    ...overrides,
  };
  return { host, calls, hooks };
}

test("a normal packaged launch keeps its compile cache beside the profile and writes it later and at quit", async () => {
  const { host, calls, hooks } = fakeHost();
  startCompileCache(host);
  assert.deepEqual(calls, [`enable ${path.join(host.userData, COMPILE_CACHE_FOLDER)}`, "later", "onQuit"]);
  await hooks.tick?.();
  hooks.quit?.();
  assert.deepEqual(calls.slice(3), ["flush", "flush"]);
});

test("development, test and runner launches never write a compile cache", () => {
  const launches: Array<[string, Partial<CompileCacheHost>]> = [
    ["an unpackaged build", { packaged: false }],
    ["a smoke launch", { argv: ["Genex", "--studio-smoke"] }],
    ["a self test", { argv: ["Genex", "--studio-selftest"] }],
    ["a developer launch", { argv: ["Genex", "--studio-dev-launch=/x/launch.json"] }],
    ["an eval lane", { argv: ["Genex", "--studio-smoke", "--studio-eval-lane=/x/spec.json"] }],
    ["a test data folder", { argv: ["Genex", "--userdata=/tmp/x"] }],
    ["a Windows uninstall step", { argv: ["Genex.exe", "--squirrel-uninstall"] }],
  ];
  for (const [name, overrides] of launches) {
    const { host, calls } = fakeHost(overrides);
    startCompileCache(host);
    assert.deepEqual(calls, [], name);
  }
});

test("a cache Node cannot open costs the launch nothing", () => {
  const { host, calls } = fakeHost({
    enable: () => {
      throw new Error("EACCES");
    },
  });
  assert.doesNotThrow(() => startCompileCache(host));
  assert.deepEqual(calls, []);
  const refused = fakeHost({ enable: () => ({ enabled: false, directory: undefined }) });
  startCompileCache(refused.host);
  assert.deepEqual(refused.calls, []);
});

test("a write that fails is ignored", async () => {
  const { host, hooks } = fakeHost({
    flush: () => {
      throw new Error("ENOSPC");
    },
  });
  startCompileCache(host);
  await assert.doesNotReject(async () => hooks.tick?.());
  assert.doesNotThrow(() => hooks.quit?.());
});

test("caches left by an older runtime are removed once this one has written its own", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "compile-cache-"));
  try {
    const current = `v${process.versions.node}-${process.arch}-0123abcd-0`;
    for (const name of [current, "v22.1.0-arm64-89ab4567-0", "v23.0.0-x64-89ab4567-501", "notes"])
      await mkdir(path.join(dir, name));
    const { host, hooks } = fakeHost({
      userData: path.dirname(dir),
      enable: () => ({ enabled: true, directory: dir }),
    });
    startCompileCache(host);
    await hooks.tick?.();
    assert.deepEqual((await readdir(dir)).sort(), [current, "notes"].sort());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
