/**
 * A plugin's `workerTypes` and `folders` (API 3): the kinds of worker it declares, and the folders
 * outside the game its engine programs write to. Genex keeps both in canonical form and refuses a
 * manifest with an entry it cannot keep: a folder that is a login, Genex's own data or a whole
 * personal folder is never a worker's write root.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { TOY_PLUGIN } from "../helpers/project-fixtures.ts";

const bundled = (id: string) =>
  JSON.parse(readFileSync(new URL(`../../src/plugins/${id}/plugin.json`, import.meta.url), "utf8")) as Record<
    string,
    unknown
  >;

/** The smallest manifest that loads, with one agent tool, one harness tool (API 3) and the given sections. */
const manifest = (sections: Record<string, unknown>, apiVersion = 3) => ({
  apiVersion,
  id: "worker-test",
  version: "1.0.0",
  name: "Worker test",
  publisher: "Genex tests",
  description: "A manifest whose worker types and folders are under test.",
  backend: "backend.mjs",
  capabilities: [],
  tools: [
    { name: "build", description: "Build.", parameters: { type: "object", properties: {} } },
    // A tool only the harness calls needs API 3 itself.
    ...(apiVersion === 3
      ? [{ name: "save", audience: "harness", description: "Save.", parameters: { type: "object", properties: {} } }]
      : []),
  ],
  skills: [],
  panels: [],
  settings: [],
  actions: [],
  ...sections,
});

const type = (fields: Record<string, unknown> = {}) => ({
  id: "scene",
  description: "Edits one scene",
  tools: ["build"],
  isolation: "copy",
  ...fields,
});
const folder = (at: string, why = "Its settings") => ({ path: at, why });

describe("a plugin's worker types and folders", () => {
  it("keeps worker types and folders in their canonical form", () => {
    const raw = JSON.parse(readFileSync(path.join(TOY_PLUGIN, "plugin.json"), "utf8")) as Record<string, unknown>;
    const kept = validateManifest(raw);
    assert.deepEqual(kept.workerTypes, raw.workerTypes, "the manifest keeps workerTypes");
    assert.deepEqual(kept.folders, raw.folders, "the manifest keeps folders");

    const mixed = validateManifest(
      manifest({
        workerTypes: [
          type({ isolation: "read" }),
          type({ id: "cast_2", tools: ["build", "blender__", "genex__asset"], isolation: "lock" }),
        ],
        folders: [folder("/private/tmp/.dotnet"), folder("~/Library/Application Support/Epic/UnrealBuildTool")],
      }),
    );
    assert.deepEqual(mixed.workerTypes, [
      type({ isolation: "read" }),
      type({ id: "cast_2", tools: ["build", "blender__", "genex__asset"], isolation: "lock" }),
    ]);
    assert.deepEqual(
      mixed.folders?.map((f) => f.path),
      ["/private/tmp/.dotnet", "~/Library/Application Support/Epic/UnrealBuildTool"],
    );
    // Canonical: only the known keys of each entry, in a fixed order.
    const reordered = validateManifest(
      manifest({ workerTypes: [{ isolation: "copy", tools: ["build"], description: "Edits one scene", id: "scene" }] }),
    );
    assert.equal(JSON.stringify(reordered.workerTypes), JSON.stringify([type()]));

    for (const id of ["unreal", "blender", "genex"]) {
      const plugin = bundled(id);
      const keptBundled = validateManifest(plugin);
      assert.deepEqual(keptBundled.workerTypes, plugin.workerTypes, `${id} keeps its worker types`);
      assert.deepEqual(keptBundled.folders, plugin.folders, `${id} keeps its folders`);
    }
  });

  const home = os.homedir();
  const hostile: Array<[string, Record<string, unknown>, number?]> = [
    ["a worker type id that is no slug", { workerTypes: [type({ id: "Scene" })] }],
    ["a worker type id that starts with a digit", { workerTypes: [type({ id: "1scene" })] }],
    ["a worker type id of 41 characters", { workerTypes: [type({ id: `s${"x".repeat(40)}` })] }],
    ["a duplicate worker type id", { workerTypes: [type(), type({ description: "Again" })] }],
    ["an unknown isolation", { workerTypes: [type({ isolation: "sandbox" })] }],
    ["no isolation", { workerTypes: [type({ isolation: undefined })] }],
    ["an empty description", { workerTypes: [type({ description: "" })] }],
    ["a description of 201 characters", { workerTypes: [type({ description: "d".repeat(201) })] }],
    ["a tool the plugin lacks", { workerTypes: [type({ tools: ["paint"] })] }],
    ["a tool only the harness calls", { workerTypes: [type({ tools: ["save"] })] }],
    ["no tools", { workerTypes: [type({ tools: [] })] }],
    ["nine tools", { workerTypes: [type({ tools: Array.from({ length: 9 }, () => "build") })] }],
    ["another plugin's prefix that is no plugin id", { workerTypes: [type({ tools: ["Blender__"] })] }],
    ["a bare separator", { workerTypes: [type({ tools: ["__"] })] }],
    ["another plugin's tool that is no tool name", { workerTypes: [type({ tools: ["blender__Model"] })] }],
    ["a tool that is no string", { workerTypes: [type({ tools: [7] })] }],
    ["an unknown key in a worker type", { workerTypes: [{ ...type(), model: "opus" }] }],
    ["workerTypes that are no list", { workerTypes: type() }],
    ["workerTypes on API 2", { workerTypes: [type()] }, 2],
    ["the folder ../x", { folders: [folder("../x")] }],
    ["the folder ~/a/../.ssh", { folders: [folder("~/a/../.ssh")] }],
    ["the folder ~/./x", { folders: [folder("~/./x")] }],
    ["a relative folder", { folders: [folder("Library/x")] }],
    ["the folder ~", { folders: [folder("~")] }],
    ["the folder ~/", { folders: [folder("~/")] }],
    ["the folder /", { folders: [folder("/")] }],
    ["the folder ~/Library", { folders: [folder("~/Library")] }],
    ["the folder ~/Library/Application Support", { folders: [folder("~/Library/Application Support")] }],
    ["the folder ~/Documents", { folders: [folder("~/Documents")] }],
    ["the folder ~/Desktop", { folders: [folder("~/Desktop")] }],
    ["the folder ~/Downloads", { folders: [folder("~/Downloads")] }],
    ["the folder ~/.codex", { folders: [folder("~/.codex")] }],
    ["the folder ~/.CODEX (a case-blind disk)", { folders: [folder("~/.CODEX")] }],
    ["the folder ~/.claude/x", { folders: [folder("~/.claude/x")] }],
    ["the folder ~/.genex", { folders: [folder("~/.genex")] }],
    ["the folder ~/.ssh", { folders: [folder("~/.ssh")] }],
    ["the folder ~/.aws/config", { folders: [folder("~/.aws/config")] }],
    ["the folder ~/Library/Keychains", { folders: [folder("~/Library/Keychains")] }],
    ["the folder ~/library/keychains/x", { folders: [folder("~/library/keychains/x")] }],
    ["the folder ~/Library/Application Support/Genex", { folders: [folder("~/Library/Application Support/Genex")] }],
    [
      "the folder ~/Library/Application Support/Genex/x",
      { folders: [folder("~/Library/Application Support/Genex/x")] },
    ],
    [
      "the folder ~/Library/Application Support/genex/engine-homes",
      { folders: [folder("~/Library/Application Support/genex/engine-homes")] },
    ],
    ["the home folder spelled whole", { folders: [folder(home)] }],
    ["the folder that holds the home folder", { folders: [folder(path.dirname(home))] }],
    ["a login spelled from the home folder", { folders: [folder(path.join(home, ".codex"))] }],
    ["a glob", { folders: [folder("~/Library/Caches/*")] }],
    ["a glob of two stars", { folders: [folder("/private/tmp/**")] }],
    ["a question mark", { folders: [folder("/private/tmp/a?")] }],
    ["a bracket", { folders: [folder("/private/tmp/[ab]")] }],
    ["a folder of 201 characters", { folders: [folder(`/private/tmp/${"x".repeat(188)}`)] }],
    ["an empty why", { folders: [folder("/private/tmp/.dotnet", "")] }],
    ["a why of 121 characters", { folders: [folder("/private/tmp/.dotnet", "w".repeat(121))] }],
    ["a folder that is no string", { folders: [{ path: 7, why: "Its settings" }] }],
    ["an unknown key in a folder", { folders: [{ ...folder("/private/tmp/.dotnet"), write: true }] }],
    ["a NUL in a folder", { folders: [folder("/private/tmp/a\0b")] }],
    ["folders that are no list", { folders: folder("/private/tmp/.dotnet") }],
    ["folders on API 2", { folders: [folder("/private/tmp/.dotnet")] }, 2],
  ];
  it("refuses a worker type or folder it cannot keep: bad ids and tools, whole personal folders, logins, Genex's data, globs", () => {
    for (const [name, sections, apiVersion] of hostile) {
      const section = "workerTypes" in sections ? /workerTypes/ : /folders/;
      assert.throws(() => validateManifest(manifest(sections, apiVersion)), section, name);
    }
  });
});
