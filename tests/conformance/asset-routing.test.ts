/**
 * Asset routing (WP-0): the one table that says where each kind of asset comes from
 * (`shared/asset-routing.ts`), and the asset plugins' instructions that carry it. Gen3 followed
 * the Genex plugin's "Blender first for props" into cube-stacked benches and cone birches; the table
 * keeps Blender to scan-textured kits and finishing heavy models, and every asset plugin's skill
 * gives an agent the same paragraph.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import {
  ASSET_ROUTES,
  AssetClass,
  AssetNever,
  type AssetRoute,
  AssetSource,
  assetRoutingText,
} from "../../src/shared/asset-routing.ts";

const BLENDER_SOURCES: ReadonlySet<AssetSource> = new Set([AssetSource.BlenderKit, AssetSource.BlenderFinish]);
const route = (kind: AssetClass): AssetRoute => ASSET_ROUTES[kind];

/** A bundled plugin's skills as its manifest declares them, text by name. */
async function skills(plugin: string): Promise<Map<string, string>> {
  const raw = JSON.parse(
    await readFile(new URL(`../../src/plugins/${plugin}/plugin.json`, import.meta.url), "utf8"),
  ) as {
    skills?: Array<{ name: string; text?: string }>;
  };
  return new Map((raw.skills ?? []).map((skill) => [skill.name, skill.text ?? ""]));
}

describe("the asset routing table", () => {
  it("routes every class somewhere and names what each may never be", () => {
    for (const kind of Object.values(AssetClass)) {
      assert.ok(route(kind).use.length > 0, `${kind} has a source`);
      assert.ok(route(kind).never.length > 0, `${kind} has a never`);
    }
  });

  it("sends props, organic shapes and characters to sourced geometry, never to Blender or stacked primitives", () => {
    for (const kind of [AssetClass.CloseUpProp, AssetClass.Organic, AssetClass.Character]) {
      assert.ok(!route(kind).use.some((source) => BLENDER_SOURCES.has(source)), `${kind} is never a Blender script`);
      assert.ok(route(kind).never.includes(AssetNever.PrimitiveStack), `${kind} is never stacked primitives`);
    }
    assert.deepEqual(route(AssetClass.CloseUpProp).use, [AssetSource.Cc0Model, AssetSource.GenexModel]);
  });

  it("keeps Blender to scan-textured kits and finishing heavy models", () => {
    const blenderClasses = Object.values(AssetClass).filter((kind) =>
      route(kind).use.some((source) => BLENDER_SOURCES.has(source)),
    );
    assert.deepEqual(blenderClasses.sort(), [AssetClass.HeavyModel, AssetClass.ModularKit].sort());
    assert.ok(route(AssetClass.ModularKit).never.includes(AssetNever.FlatColour));
  });

  it("is the paragraph every asset plugin's guiding skill carries", async () => {
    const paragraph = assetRoutingText();
    const carriers: Array<[string, string]> = [
      ["genex", "asset-preference"],
      ["blender", "local-modeling"],
      ["blender", "local-modeling-rust"],
      ["cc0", "cc0-library"],
      ["cc0", "cc0-library-rust"],
    ];
    for (const [plugin, skill] of carriers) {
      const text = (await skills(plugin)).get(skill);
      assert.ok(text?.includes(paragraph), `${plugin}/${skill} carries the routing paragraph`);
    }
  });
});
