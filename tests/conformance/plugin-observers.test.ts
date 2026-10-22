/**
 * What Genex can capture of a project, by its facts: the plugins' observers and Genex's own web preview.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { ObserverLive, type ObserverRef, observersFor, PREVIEW_OBSERVER } from "../../src/shared/observers.ts";
import type { PluginManifest } from "../../src/shared/plugins.ts";
import { CoreFact, FolderHolds, type GameKind } from "../../src/shared/project-facts.ts";
import { STAGE_WORDS } from "../../src/renderer/words.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { TOY_PLUGIN, TOY_PLUGIN_ID, toyRegistry } from "../helpers/project-fixtures.ts";

const NO_PARAMETERS = { type: "object", properties: {} };
const harnessTool = (name: string, fields: Record<string, unknown> = {}) => ({
  name,
  audience: "harness",
  description: `${name}.`,
  parameters: NO_PARAMETERS,
  ...fields,
});

/** The smallest API 3 manifest with an agent tool, quiet and asking harness tools and the given sections. */
const manifest = (
  sections: Record<string, unknown>,
  { apiVersion = 3, id = "observer-test", tools = {} as Record<string, Record<string, unknown>> } = {},
) => ({
  apiVersion,
  id,
  version: "1.0.0",
  name: "Observer test",
  publisher: "Genex tests",
  description: "A manifest whose observers are under test.",
  backend: "backend.mjs",
  capabilities: [],
  tools: [
    { name: "build", description: "Build.", parameters: NO_PARAMETERS, ...tools.build },
    ...(apiVersion === 3
      ? [
          harnessTool("shot", tools.shot),
          harnessTool("ask", { confirmation: "Take a picture?", ...tools.ask }),
          harnessTool("status", tools.status),
        ]
      : []),
  ],
  skills: [],
  panels: [],
  settings: [],
  actions: [],
  ...sections,
});

const observer = (fields: Record<string, unknown> = {}) => ({
  id: "viewport",
  facts: ["toy-project"],
  tool: "shot",
  ...fields,
});

/** The action a card's status names: declared, and it asks nothing. */
const STAGE_ACTION = { name: "stage", label: "On the Live stage" };

const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8")) as PluginManifest;
const TOY_MANIFEST = readJson(path.join(TOY_PLUGIN, "plugin.json"));
const UNREAL_MANIFEST = readJson("src/plugins/unreal/plugin.json");
const BLENDER_MANIFEST = readJson("src/plugins/blender/plugin.json");

/** A manifest whose `status` tool runs a host program: valid but for an observer on it. */
const genexHost = { id: "genex", tools: { status: { host: "genex-cli" } } };

const hostile: Array<[string, Record<string, unknown>, Parameters<typeof manifest>[1]?]> = [
  ["an id with capitals", { observers: [observer({ id: "Viewport" })] }],
  ["a duplicate id", { observers: [observer(), observer({ facts: ["web-game"] })] }],
  ["Genex's own preview id", { observers: [observer({ id: PREVIEW_OBSERVER })] }],
  ["the proof id", { observers: [observer({ id: "proof" })] }],
  ["no facts", { observers: [observer({ facts: [] })] }],
  ["a fact that is no fact id", { observers: [observer({ facts: ["Unreal"] })] }],
  ["a fact named twice", { observers: [observer({ facts: ["toy-project", "toy-project"] })] }],
  ["nine observers", { observers: Array.from({ length: 9 }, (_, index) => observer({ id: `view-${index}` })) }],
  ["an agent tool", { observers: [observer({ tool: "build" })] }],
  ["a missing tool", { observers: [observer({ tool: "nowhere" })] }],
  ["a tool that asks the person", { observers: [observer({ tool: "ask" })] }],
  ["a tool that runs a host program", { observers: [observer({ tool: "status" })] }, genexHost],
  ["Genex's own preview view", { observers: [observer({ live: ObserverLive.Preview })] }],
  ["a view Genex does not draw", { observers: [observer({ live: "theatre" })] }],
  ["the Unreal card outside the Unreal plugin", { observers: [observer({ live: ObserverLive.UnrealCard })] }],
  ["observers on API 2", { observers: [observer()] }, { apiVersion: 2 }],
  ["observers that are no list", { observers: { id: "viewport" } }],
  ["an entry that is no object", { observers: ["viewport"] }],
  ["an empty label", { observers: [observer({ label: "" })] }],
  ["a blank label", { observers: [observer({ label: "   " })] }],
  ["a label of 25 characters", { observers: [observer({ label: "x".repeat(25) })] }],
  ["a label over two lines", { observers: [observer({ label: "a\nb" })] }],
  ["a label that is a number", { observers: [observer({ label: 7 })] }],
  ["a label with a bidi control", { observers: [observer({ label: "\u202e" })] }],
  ["a label with a NUL", { observers: [observer({ label: "\u0000" })] }],
  ["a label with a line separator", { observers: [observer({ label: "Board\u2028Two" })] }],
  ["a label with a paragraph separator", { observers: [observer({ label: "Board\u2029Two" })] }],
  ["a label that is a stage-strip tab", { observers: [observer({ label: "Builds" })] }],
  ["a label that is a Live view's own name in another case", { observers: [observer({ label: "unreal" })] }],
  ["a label that is the web preview's name", { observers: [observer({ label: "Web Game" })] }],
  ["a card that names no status", { observers: [observer({ live: "card" })], actions: [STAGE_ACTION] }],
  ["a card whose status is no action", { observers: [observer({ live: "card", status: "nowhere" })] }],
  [
    "a card whose status asks the person",
    { observers: [observer({ live: "card", status: "stage" })], actions: [{ ...STAGE_ACTION, confirmation: "Look?" }] },
  ],
  ["a status beside stills", { observers: [observer({ live: "stills", status: "stage" })], actions: [STAGE_ACTION] }],
  ["a status that is no name", { observers: [observer({ live: "card", status: 7 })], actions: [STAGE_ACTION] }],
];

const ROOT = ".";
const kind = (...facts: Array<[string, string]>): GameKind => ({ facts: facts.map(([id, at]) => ({ id, path: at })) });
const preview = (at: string): ObserverRef => ({
  key: PREVIEW_OBSERVER,
  plugin: null,
  id: PREVIEW_OBSERVER,
  tool: null,
  live: ObserverLive.Preview,
  at,
  on: true,
});
const pluginRef = (plugin: string, id: string, tool: string, at: string, fields: Partial<ObserverRef> = {}) => ({
  key: `${plugin}/${id}`,
  plugin,
  id,
  tool,
  live: null,
  at,
  on: true,
  ...fields,
});

type Listed = Parameters<typeof observersFor>[0][number];
const listed = (manifest: PluginManifest, enabled = true): Listed => ({ id: manifest.id, enabled, manifest });

const forTable: Array<[string, Listed[], GameKind, ObserverRef[]]> = [
  ["a game with no kind yet is Genex's preview at its root", [listed(UNREAL_MANIFEST)], kind(), [preview(ROOT)]],
  [
    "an Unreal game with a site: the Unreal viewport at the root, then the site's preview",
    [listed(UNREAL_MANIFEST)],
    kind([CoreFact.UnrealProject, ROOT], [CoreFact.WebGame, "site"]),
    [pluginRef("unreal", "viewport", "hero-shots", ROOT, { live: ObserverLive.UnrealCard }), preview("site")],
  ],
  [
    "a folder of Blender assets has no observer",
    [listed(UNREAL_MANIFEST), listed(BLENDER_MANIFEST)],
    kind([CoreFact.BlenderAssets, "props"]),
    [],
  ],
  [
    "a toy project with the toy plugin on",
    [listed(TOY_MANIFEST)],
    kind(["toy-project", ROOT]),
    [pluginRef(TOY_PLUGIN_ID, "viewport", "capture", ROOT)],
  ],
  [
    "a toy project with the toy plugin off is listed as off",
    [listed(TOY_MANIFEST, false)],
    kind(["toy-project", ROOT]),
    [pluginRef(TOY_PLUGIN_ID, "viewport", "capture", ROOT, { on: false })],
  ],
  [
    "two toy projects: one ref each, the root first",
    [listed(TOY_MANIFEST)],
    kind(["toy-project", "b"], ["toy-project", ROOT]),
    [pluginRef(TOY_PLUGIN_ID, "viewport", "capture", ROOT), pluginRef(TOY_PLUGIN_ID, "viewport", "capture", "b")],
  ],
  [
    "two sites: Genex's preview at each, the root first",
    [],
    kind([CoreFact.WebGame, "web"], [CoreFact.WebGame, ROOT]),
    [preview(ROOT), preview("web")],
  ],
  [
    "a folder of a kind Genex can't name has none",
    [listed(TOY_MANIFEST)],
    { facts: [], holds: FolderHolds.OwnFiles },
    [],
  ],
];

describe("a plugin's observers and Genex's own preview", () => {
  it("keeps a plugin's observers as written", () => {
    const kept = validateManifest(TOY_MANIFEST);
    assert.deepEqual(kept.observers, TOY_MANIFEST.observers);
    const unknownKey = validateManifest(manifest({ observers: [{ ...observer(), extra: "dropped" }] }));
    assert.deepEqual(unknownKey.observers, [{ id: "viewport", facts: ["toy-project"], tool: "shot" }]);
    assert.deepEqual(
      Object.keys(validateManifest(manifest({ observers: [observer({ live: "stills" })] })).observers?.[0] ?? {}),
      ["id", "facts", "tool", "live"],
    );
    assert.equal(validateManifest(manifest({})).observers, undefined, "a manifest without observers keeps none");
  });

  it("any plugin's observer may be a card that names the action it reads its status from", () => {
    const kept = validateManifest(
      manifest({ observers: [observer({ live: "card", status: "stage", label: "Toy" })], actions: [STAGE_ACTION] }),
    );
    assert.deepEqual(kept.observers, [
      { id: "viewport", facts: ["toy-project"], tool: "shot", live: "card", label: "Toy", status: "stage" },
    ]);
  });

  it("an observer may name its Live view's tab", () => {
    const kept = validateManifest(manifest({ observers: [observer({ live: "stills", label: "Viewport" })] }));
    assert.deepEqual(kept.observers, [
      { id: "viewport", facts: ["toy-project"], tool: "shot", live: "stills", label: "Viewport" },
    ]);
    const markup = validateManifest(manifest({ observers: [observer({ label: "<b>x</b>" })] }));
    assert.equal(markup.observers?.[0]?.label, "<b>x</b>", "markup is kept as plain text: React shows it as text");
  });

  it("no observer's tab may take a name the stage strip already shows", () => {
    for (const name of Object.values(STAGE_WORDS.tabs))
      assert.throws(() => validateManifest(manifest({ observers: [observer({ label: name })] })), /observers/, name);
  });

  it("refuses an observer it could not run or show", () => {
    for (const [name, sections, options] of hostile)
      assert.throws(() => validateManifest(manifest(sections, options)), /observers/, name);
    // The host-program row is valid but for its observer.
    assert.doesNotThrow(() => validateManifest(manifest({}, genexHost)));
  });

  it("lists each plugin's observers for the facts it reaches, then Genex's preview for each web site", () => {
    for (const [name, plugins, game, expected] of forTable)
      assert.deepEqual(observersFor(plugins, game), expected, name);
  });

  it("a registry lists the installed plugins' observers and names the tool only of one whose plugin is on", async () => {
    const registry = await toyRegistry();
    const toy = kind(["toy-project", ROOT]);
    await registry.setEnabled(TOY_PLUGIN_ID, false);
    assert.deepEqual(registry.observers(toy), [pluginRef(TOY_PLUGIN_ID, "viewport", "capture", ROOT, { on: false })]);
    assert.equal(
      registry.observerTool(`${TOY_PLUGIN_ID}/viewport`),
      null,
      "an observer of a plugin that is off runs nothing",
    );

    await registry.setEnabled(TOY_PLUGIN_ID, true);
    assert.deepEqual(registry.observers(toy), [pluginRef(TOY_PLUGIN_ID, "viewport", "capture", ROOT)]);
    assert.deepEqual(registry.observerTool(`${TOY_PLUGIN_ID}/viewport`), {
      pluginId: TOY_PLUGIN_ID,
      tool: "capture",
      needs: [],
    });
    for (const unknown of [PREVIEW_OBSERVER, `${TOY_PLUGIN_ID}/missing`, "nope/viewport", `${TOY_PLUGIN_ID}/`, ""])
      assert.equal(registry.observerTool(unknown), null, unknown);

    await registry.remove(TOY_PLUGIN_ID);
    assert.deepEqual(registry.observers(toy), [], "a removed plugin has none");
  });

  it("the bundled Unreal manifest declares its viewport observer, which runs hero-shots", () => {
    const unreal = validateManifest(UNREAL_MANIFEST);
    assert.deepEqual(unreal.observers, [
      { id: "viewport", facts: [CoreFact.UnrealProject], tool: "hero-shots", live: ObserverLive.UnrealCard },
    ]);
    assert.deepEqual(
      unreal.tools.find((tool) => tool.name === "hero-shots")?.needs,
      ["editor"],
      "its capture waits for the editor lock",
    );
  });
});
