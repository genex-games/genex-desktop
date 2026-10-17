/**
 * A plugin tool may say what its calls make (`tools[].asset`, API 3): a kind Genex draws, which of
 * its own parameters is the prompt, and the outside tool doing the work. It is kept in canonical
 * form where a manifest is parsed, refused in any other shape, below API 3 and on a tool only the
 * harness calls, and the bundled plugins that make assets declare it.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { MakingKind } from "../../src/shared/asset-making.ts";
import type { PluginManifest } from "../../src/shared/plugins.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { EXAMPLE_PLUGIN } from "../helpers/plugins.ts";

// biome-ignore lint/suspicious/noExplicitAny: a hostile manifest is any shape a writer may send.
type RawManifest = any;

const exampleManifest: RawManifest = JSON.parse(await readFile(path.join(EXAMPLE_PLUGIN, "plugin.json"), "utf8"));

/** The example manifest on `apiVersion` with its `greet` tool (parameter `name`) given `fields`. */
function withGreet(fields: Record<string, unknown>, apiVersion = 3): RawManifest {
  const manifest = structuredClone(exampleManifest);
  manifest.apiVersion = apiVersion;
  manifest.tools = manifest.tools.map((t: { name: string }) => (t.name === "greet" ? { ...t, ...fields } : t));
  return manifest;
}
const greetOf = (m: PluginManifest) => m.tools.find((t) => t.name === "greet");

test("a tool says what its calls make, kept in canonical form", () => {
  const asset = { kind: "image", prompt: "name", tool: "Pixel Lab", note: "dropped" };
  assert.deepEqual(greetOf(validateManifest(withGreet({ asset })))?.asset, {
    kind: MakingKind.Image,
    prompt: "name",
    tool: "Pixel Lab",
  });
  assert.deepEqual(greetOf(validateManifest(withGreet({ asset: { kind: "model" } })))?.asset, { kind: "model" });
  assert.equal(Object.hasOwn(greetOf(validateManifest(withGreet({}))) ?? {}, "asset"), false, "none says nothing");
});

test("a declaration in any other shape, below API 3 or on a harness step is refused", () => {
  const hostile: unknown[] = [
    null,
    "image",
    ["image"],
    {},
    { kind: "hologram" },
    { kind: "constructor" },
    { kind: "image", prompt: "missing" },
    { kind: "image", prompt: "" },
    { kind: "image", prompt: 3 },
    { kind: "image", tool: "x".repeat(41) },
  ];
  for (const asset of hostile)
    assert.throws(() => validateManifest(withGreet({ asset })), /tools\[\]\.asset/, JSON.stringify(asset));
  assert.throws(() => validateManifest(withGreet({ asset: { kind: "image" } }, 2)), /requires apiVersion 3/);
  assert.throws(
    () => validateManifest(withGreet({ asset: { kind: "image" }, audience: "harness" })),
    /tools\[\]\.asset/,
    "the harness's own steps make no card",
  );
});

test("the bundled plugins that make assets declare it: Blender's model, by its name", async () => {
  const blender = validateManifest(
    JSON.parse(await readFile(new URL("../../src/plugins/blender/plugin.json", import.meta.url), "utf8")),
  );
  assert.deepEqual(blender.tools.find((t) => t.name === "model")?.asset, { kind: MakingKind.Model, prompt: "name" });
  assert.deepEqual(
    blender.tools.filter((t) => t.asset).map((t) => t.name),
    ["model"],
  );
});
