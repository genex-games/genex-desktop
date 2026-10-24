import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { tscLayout } from "../../src/substrate/type-gate.ts";
import { coreLite, sharedResources as coreResources } from "../helpers/core-lite.ts";
import { makeResources, sharedResources } from "../helpers/resources.ts";
import { startRig } from "../helpers/studio-rig.ts";

const RULES = "harness-seed/prompts/operating-rules.md";

test("concurrent resource readers share one assembly, including its working compiler", async () => {
  const first = sharedResources();
  const second = sharedResources();
  assert.equal(first, second, "readers coalesce while the assembly is still running");
  assert.equal(coreResources(), first, "core-lite's existing entry point shares the same assembly");
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left, right);
  assert.equal(await sharedResources(), left, "later readers reuse the completed assembly");
  assert.ok((await stat(tscLayout(left).binary)).isFile());
  assert.ok((await stat(path.join(left, "plugins/genex/backend.mjs"))).isFile());
});

test("fresh resource copies stay mutable and independent, and compiler-free copies stay compiler-free", async () => {
  const shared = await sharedResources();
  const [first, second] = await Promise.all([makeResources({ tsc: false }), makeResources({ tsc: false })]);
  assert.equal(new Set([shared, first, second]).size, 3);
  const original = await readFile(path.join(shared, RULES), "utf8");
  assert.equal(await readFile(path.join(first, RULES), "utf8"), original);
  assert.equal(await readFile(path.join(second, RULES), "utf8"), original);
  await writeFile(path.join(first, RULES), "a shipped change for one upgrade fixture\n");
  await writeFile(path.join(first, "plugins/genex/plugin.json"), "{}\n");
  assert.equal(await readFile(path.join(second, RULES), "utf8"), original);
  assert.equal(await readFile(path.join(shared, RULES), "utf8"), original);
  assert.equal(
    await readFile(path.join(second, "plugins/genex/plugin.json"), "utf8"),
    await readFile(path.join(shared, "plugins/genex/plugin.json"), "utf8"),
  );
  for (const resources of [first, second]) await assert.rejects(stat(tscLayout(resources).binary), { code: "ENOENT" });
  assert.ok(
    (await stat(tscLayout(shared).binary)).isFile(),
    "a compiler-free fixture never removes the shared compiler",
  );
});

test("a full rig borrows the same read-only resources as core-lite", async () => {
  const resources = await sharedResources();
  const rig = await startRig({ replies: [] });
  try {
    assert.ok(rig.core.host.pid, "the real harness is running");
    assert.equal(rig.core.options.paths.resources, resources, "starting a rig does not rebuild the same resources");
  } finally {
    await rig.stop();
  }
});

test("cores sharing resources keep separate harness edits and installed plugin settings", async () => {
  const first = await coreLite();
  const second = await coreLite();
  try {
    assert.equal(first.resources, second.resources);
    assert.notEqual(first.userData, second.userData);
    assert.notEqual(first.core.layout.harnessWs, second.core.layout.harnessWs);
    assert.notEqual(first.core.layout.engineHomes, second.core.layout.engineHomes);
    const relative = "prompts/operating-rules.md";
    const original = await readFile(path.join(second.core.layout.harnessWs, relative), "utf8");
    await writeFile(path.join(first.core.layout.harnessWs, relative), "one agent's own edit\n");
    await first.core.plugins.setEnabled("blender", false);
    assert.equal(first.core.plugins.enabled("blender"), false);
    assert.equal(second.core.plugins.enabled("blender"), true);
    assert.equal(await readFile(path.join(second.core.layout.harnessWs, relative), "utf8"), original);
    assert.equal(await readFile(path.join(first.resources, RULES), "utf8"), original);
  } finally {
    await first.close();
    await second.close();
  }
});
