import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { engineBoot } from "../../src/main/engine-boot.ts";
import { EngineRegistry } from "../../src/substrate/engines/registry.ts";
import type { EngineDescriptor } from "../../src/shared/engine-descriptor.ts";
import { tmpDir } from "../helpers/tmp.ts";

const BUILD = "0.1.8";

/** One engine as `EngineRegistry.describe` lists it, in the given state. */
function engine(id: string, code: EngineDescriptor["status"]["code"], extra: Partial<EngineDescriptor> = {}) {
  return {
    id,
    label: id,
    kind: "delegated",
    status: { code, detail: code },
    models: [],
    defaultModel: null,
    ...extra,
  } as EngineDescriptor;
}

/** A describe the test answers when it wants, counting its calls. */
function heldChecks() {
  let answer: (list: EngineDescriptor[]) => void = () => {};
  let calls = 0;
  const describe = () => {
    calls++;
    return new Promise<EngineDescriptor[]>((resolve) => {
      answer = resolve;
    });
  };
  return { describe, answer: (list: EngineDescriptor[]) => answer(list), calls: () => calls };
}

/** Whether `promise` has settled by the time pending callbacks have run. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  return done;
}

async function remembered(file: string, build: string, list: unknown): Promise<void> {
  await writeFile(file, JSON.stringify({ build, engines: list }));
}

test("a relaunch opens on the engines the last launch saw, then announces the checked ones", async () => {
  const file = path.join(await tmpDir(), "last-engines.json");
  await remembered(file, BUILD, [engine("claude-code", "ready")]);
  const checks = heldChecks();
  let announced = 0;
  const boot = engineBoot({ describe: checks.describe, file, build: BUILD, changed: () => announced++ });
  boot.start();
  const list = await boot.bootstrap();
  assert.deepEqual(
    list.map((e) => [e.id, e.status.code]),
    [["claude-code", "ready"]],
  );
  assert.equal(announced, 0, "nothing to announce before the checks finish");
  checks.answer([engine("claude-code", "needs_login")]);
  await boot.checked();
  assert.equal(announced, 1, "the window hears the checked list replaced the remembered one");
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.engines[0].status.code, "needs_login", "the checked list is the next launch's");
  assert.equal(checks.calls(), 1, "the checks run once");
});

test("a first launch waits for the checks, as before", async () => {
  const file = path.join(await tmpDir(), "last-engines.json");
  const checks = heldChecks();
  let announced = 0;
  const boot = engineBoot({ describe: checks.describe, file, build: BUILD, changed: () => announced++ });
  boot.start();
  const bootstrap = boot.bootstrap();
  assert.equal(await settled(bootstrap), false, "no list to show yet");
  checks.answer([engine("codex", "ready")]);
  assert.deepEqual(
    (await bootstrap).map((e) => e.id),
    ["codex"],
  );
  await boot.checked();
  assert.equal(announced, 0, "the window already has the checked list");
});

test("once the launch's checks are done, a bootstrap checks afresh, as it always did", async () => {
  const file = path.join(await tmpDir(), "last-engines.json");
  await remembered(file, BUILD, [engine("claude-code", "ready")]);
  let code: EngineDescriptor["status"]["code"] = "not_installed";
  let announced = 0;
  const boot = engineBoot({
    describe: async () => [engine("claude-code", code)],
    file,
    build: BUILD,
    changed: () => announced++,
  });
  boot.start();
  await boot.checked();
  assert.equal((await boot.bootstrap())[0]?.status.code, "not_installed", "never the remembered list");
  code = "ready";
  assert.equal((await boot.bootstrap())[0]?.status.code, "ready", "a reloaded window sees a later sign-in");
  assert.equal(announced, 0);
});

test("a list another version remembered, or a damaged one, is never shown", async () => {
  const dir = await tmpDir();
  const cases: Array<[string, (file: string) => Promise<void>]> = [
    ["another version", (file) => remembered(file, "0.1.7", [engine("claude-code", "ready")])],
    ["not JSON", (file) => writeFile(file, "{")],
    ["no list", (file) => remembered(file, BUILD, { id: "claude-code" })],
    ["an engine without a status", (file) => remembered(file, BUILD, [{ id: "claude-code", models: [] }])],
    ["an engine without models", (file) => remembered(file, BUILD, [{ id: "x", status: { code: "ready" } }])],
  ];
  for (const [name, write] of cases) {
    const file = path.join(dir, `${name}.json`);
    await write(file);
    const checks = heldChecks();
    const boot = engineBoot({ describe: checks.describe, file, build: BUILD, changed: () => {} });
    boot.start();
    const bootstrap = boot.bootstrap();
    assert.equal(await settled(bootstrap), false, `${name}: waits for the checks`);
    checks.answer([engine("codex", "ready")]);
    assert.deepEqual(
      (await bootstrap).map((e) => e.id),
      ["codex"],
      name,
    );
  }
});

test("plan usage is never remembered: it is only true when read", async () => {
  const file = path.join(await tmpDir(), "last-engines.json");
  const usage = { fetchedAt: 1 } as unknown as EngineDescriptor["usage"];
  const boot = engineBoot({
    describe: async () => [engine("claude-code", "ready", { usage })],
    file,
    build: BUILD,
    changed: () => {},
  });
  boot.start();
  await boot.checked();
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal("usage" in saved.engines[0], false);
});

test("checks that fail leave the bootstrap to ask again", async () => {
  const file = path.join(await tmpDir(), "last-engines.json");
  let calls = 0;
  const boot = engineBoot({
    describe: async () => {
      calls++;
      if (calls === 1) throw new Error("checks failed");
      return [engine("ollama", "not_running")];
    },
    file,
    build: BUILD,
    changed: () => {},
  });
  boot.start();
  await boot.checked();
  assert.deepEqual(
    (await boot.bootstrap()).map((e) => e.id),
    ["ollama"],
  );
});

test("every later description is remembered too: a sign-in is the next launch's state", async () => {
  const file = path.join(await tmpDir(), "last-engines.json");
  const registry = new EngineRegistry();
  let code: EngineDescriptor["status"]["code"] = "needs_login";
  registry.register({
    id: "claude-code",
    label: "Claude Code",
    kind: "delegated",
    status: async () => ({ code, detail: code }),
    models: async () => [],
  } as never);
  const boot = engineBoot({ describe: () => registry.describe(), file, build: BUILD, changed: () => {} });
  registry.onDescribed((list) => boot.remember(list));
  boot.start();
  await boot.checked();
  code = "ready";
  await registry.describe();
  await boot.saved();
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.engines[0].status.code, "ready");
});
