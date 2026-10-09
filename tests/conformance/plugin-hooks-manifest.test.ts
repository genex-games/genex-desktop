/**
 * What a plugin may declare about Genex's moments and its locks, and what Genex refuses.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { HOOK_CALL_MS } from "../../src/main/core/plugin-hooks.ts";
import { OPEN_FOR_RUN_MAX_MS, RESTORE_SAVE_MAX_MS } from "../../src/plugins/unreal/editor-moments.ts";
import { HookEvent, hookEventsOf, hookPlan, LockScope } from "../../src/shared/plugin-hooks.ts";
import type { PluginManifest } from "../../src/shared/plugins.ts";
import { FolderHolds, type GameKind } from "../../src/shared/project-facts.ts";
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

/** The smallest manifest that loads, with an agent tool that makes a kind, harness tools and the given sections. */
const manifest = (
  sections: Record<string, unknown>,
  { apiVersion = 3, id = "moment-test", tools = {} as Record<string, Record<string, unknown>> } = {},
) => ({
  apiVersion,
  id,
  version: "1.0.0",
  name: "Moment test",
  publisher: "Genex tests",
  description: "A manifest whose hooks, locks, needs and readiness are under test.",
  backend: "backend.mjs",
  capabilities: [],
  tools: [
    {
      name: "build",
      description: "Build.",
      parameters: NO_PARAMETERS,
      ...(apiVersion === 3 ? { makes: ["toy-project"] } : {}),
      ...tools.build,
    },
    { name: "paint", description: "Paint.", parameters: NO_PARAMETERS, ...tools.paint },
    // Tools only the harness calls need API 3 themselves.
    ...(apiVersion === 3
      ? [
          harnessTool("save", tools.save),
          harnessTool("probe", tools.probe),
          harnessTool("wipe", { confirmation: "Wipe the editor's scratch files?", ...tools.wipe }),
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

const lock = (fields: Record<string, unknown> = {}) => ({
  id: "bench",
  label: "Bench",
  per: "project",
  personFirst: "probe",
  ...fields,
});
const hook = (on: string, tool: string, fields: Record<string, unknown> = {}) => ({ on, tool, ...fields });
const server = (fields: Record<string, unknown> = {}) => ({
  id: "bench",
  transport: "stdio",
  command: "node",
  args: ["server.mjs"],
  cwd: "storage",
  description: "The bench's own connector.",
  ...fields,
});

const toyKind: GameKind = { facts: [{ id: "toy-project", path: "." }] };
const webKind: GameKind = { facts: [{ id: "web-game", path: "." }] };
const ownFilesKind: GameKind = { facts: [], holds: FolderHolds.OwnFiles };

/** A lock with no probe: valid on API 3 as it stands. */
const PLAIN_LOCK = { id: "bench", label: "Bench", per: "project" };
/** A manifest whose `status` tool runs a host program: valid but for a hook on it. */
const genexHost = { apiVersion: 3, id: "genex", tools: { status: { host: "genex-cli" } } };
/** Each refused declaration, the section its refusal names, and the manifest around it. */
const hostile: Array<[string, RegExp, Record<string, unknown>, Parameters<typeof manifest>[1]?]> = [
  ["a hook on an unknown moment", /hooks/, { hooks: [hook("run.start", "save")] }],
  ["a hook on __proto__", /hooks/, { hooks: [hook("__proto__", "save")] }],
  ["a hook with no moment", /hooks/, { hooks: [{ tool: "save" }] }],
  ["a hook run by an agent tool", /hooks/, { hooks: [hook(HookEvent.Health, "build")] }],
  ["a hook run by another plugin's tool", /hooks/, { hooks: [hook(HookEvent.Health, "unreal__save-all")] }],
  ["a hook run by an undeclared tool", /hooks/, { hooks: [hook(HookEvent.Health, "flush")] }],
  ["a hook run by a tool that asks the person", /hooks/, { hooks: [hook(HookEvent.Health, "wipe")] }],
  ["a hook run by a host program", /hooks/, { hooks: [hook(HookEvent.Health, "status")] }, genexHost],
  ["a hook scoped to no fact id", /hooks/, { hooks: [hook(HookEvent.Health, "save", { facts: ["Unreal"] })] }],
  ["a hook scoped to no facts", /hooks/, { hooks: [hook(HookEvent.Health, "save", { facts: [] })] }],
  [
    "a hook scoped to a fact twice",
    /hooks/,
    { hooks: [hook(HookEvent.Health, "save", { facts: ["toy-project", "toy-project"] })] },
  ],
  [
    "the same tool hooked to one moment twice",
    /hooks/,
    { hooks: [hook(HookEvent.Health, "save"), hook(HookEvent.Health, "save")] },
  ],
  ["an unknown key in a hook", /hooks/, { hooks: [{ ...hook(HookEvent.Health, "save"), args: { all: true } }] }],
  ["33 hooks", /hooks/, { hooks: Array.from({ length: 33 }, () => hook(HookEvent.Health, "save")) }],
  ["hooks that are no list", /hooks/, { hooks: hook(HookEvent.Health, "save") }],
  ["a lock id that is a path", /locks/, { locks: [lock({ id: "../x" })] }],
  ["a lock id with capitals", /locks/, { locks: [lock({ id: "Editor" })] }],
  ["a lock declared twice", /locks/, { locks: [lock(), lock({ label: "Again" })] }],
  ["a lock per game", /locks/, { locks: [lock({ per: "game" })] }],
  ["a lock with an empty label", /locks/, { locks: [lock({ label: "" })] }],
  ["a lock label with a line break", /locks/, { locks: [lock({ label: "Bench\nnow" })] }],
  ["a lock label of 61 characters", /locks/, { locks: [lock({ label: "b".repeat(61) })] }],
  ["a person-first probe that is an agent tool", /locks/, { locks: [lock({ personFirst: "build" })] }],
  ["a person-first probe that is undeclared", /locks/, { locks: [lock({ personFirst: "watch" })] }],
  ["a person-first probe that asks the person", /locks/, { locks: [lock({ personFirst: "wipe" })] }],
  [
    "a person-first probe that needs its own lock",
    /locks/,
    { locks: [lock()] },
    { tools: { probe: { needs: ["bench"] } } },
  ],
  ["an unknown key in a lock", /locks/, { locks: [{ ...lock(), wait: 5 }] }],
  ["nine locks", /locks/, { locks: Array.from({ length: 9 }, (_, n) => lock({ id: `bench-${n}` })) }],
  ["needs naming an undeclared lock", /needs/, { locks: [lock()] }, { tools: { paint: { needs: ["kiln"] } } }],
  ["needs with no lock declared at all", /needs/, {}, { tools: { paint: { needs: ["bench"] } } }],
  ["needs that name nothing", /needs/, { locks: [lock()] }, { tools: { paint: { needs: [] } } }],
  ["needs naming one lock twice", /needs/, { locks: [lock()] }, { tools: { paint: { needs: ["bench", "bench"] } } }],
  ["a connector's needs naming an undeclared lock", /needs/, { mcpServers: [server({ needs: ["kiln"] })] }],
  ["ready on a tool that makes nothing", /ready/, {}, { tools: { paint: { ready: "status" } } }],
  ["ready naming an agent tool", /ready/, {}, { tools: { build: { ready: "paint" } } }],
  ["ready naming an undeclared tool", /ready/, {}, { tools: { build: { ready: "warm" } } }],
  // Refused for the API version itself, by its own words: never for another fault the entry may have.
  ["hooks on API 2", /hooks requires apiVersion 3/, { hooks: [hook(HookEvent.Health, "save")] }, { apiVersion: 2 }],
  ["locks on API 2", /locks requires apiVersion 3/, { locks: [PLAIN_LOCK] }, { apiVersion: 2 }],
  ["needs on API 2", /needs requires apiVersion 3/, {}, { apiVersion: 2, tools: { paint: { needs: ["bench"] } } }],
  ["ready on API 2", /ready requires apiVersion 3/, {}, { apiVersion: 2, tools: { build: { ready: "paint" } } }],
  [
    "a connector's needs on API 2",
    /needs requires apiVersion 3/,
    { mcpServers: [server({ needs: ["bench"] })] },
    { apiVersion: 2 },
  ],
];

/** Two plugins' hooks planned for games of three kinds, and a tool's own moments. */
function plansByFactsAndOrder() {
  const a = {
    id: "a",
    manifest: {
      tools: [harnessTool("save", { needs: ["bench"] }), harnessTool("audit")],
      hooks: [
        hook(HookEvent.CheckpointBefore, "save", { facts: ["toy-project"] }),
        hook(HookEvent.ToolBefore, "audit"),
      ],
    } as Pick<PluginManifest, "hooks" | "tools">,
  };
  const b = {
    id: "b",
    manifest: {
      tools: [harnessTool("flush")],
      hooks: [hook(HookEvent.CheckpointBefore, "flush")],
    } as Pick<PluginManifest, "hooks" | "tools">,
  };
  const save = { plugin: "a", tool: "save", needs: ["bench"] };
  const flush = { plugin: "b", tool: "flush", needs: [] };
  assert.deepEqual(hookPlan([a, b], HookEvent.CheckpointBefore, toyKind), [save, flush]);
  assert.deepEqual(hookPlan([b, a], HookEvent.CheckpointBefore, toyKind), [flush, save], "plugin order as given");
  assert.deepEqual(hookPlan([a, b], HookEvent.CheckpointBefore, webKind), [flush], "a web game has no toy project");
  assert.deepEqual(hookPlan([a, b], HookEvent.CheckpointBefore, ownFilesKind), [flush], "nor a folder of its own");
  assert.deepEqual(hookPlan([a, b], HookEvent.Health, toyKind), [], "nobody hooks health");

  const audit = { plugin: "a", tool: "audit", needs: [] };
  assert.deepEqual(hookPlan([a, b], HookEvent.ToolBefore, toyKind, "a"), [audit], "a's own tool");
  assert.deepEqual(hookPlan([a, b], HookEvent.ToolBefore, toyKind, "b"), [], "never around another plugin's tool");
  assert.deepEqual(hookPlan([a, b], HookEvent.ToolBefore, toyKind), [], "nor around a tool of no plugin");

  assert.deepEqual(hookEventsOf([a, b], toyKind), [HookEvent.CheckpointBefore, HookEvent.ToolBefore]);
  assert.deepEqual(hookEventsOf([a, b], webKind), [HookEvent.CheckpointBefore, HookEvent.ToolBefore]);
  assert.deepEqual(hookEventsOf([a], webKind), [HookEvent.ToolBefore]);
  assert.deepEqual(hookEventsOf([], toyKind), []);
}

/** The toy plugin's moments and lock through a registry, off and then on. */
async function registryPlansPluginsThatAreOn() {
  const registry = await toyRegistry();
  await registry.setEnabled(TOY_PLUGIN_ID, false);
  assert.deepEqual(registry.hookPlan(HookEvent.CheckpointBefore, toyKind), []);
  assert.deepEqual(registry.hookEvents(toyKind), []);
  assert.deepEqual(registry.locksFor(toyKind), []);
  assert.deepEqual(registry.needsOf(`${TOY_PLUGIN_ID}__build`), []);
  assert.equal(registry.lockOf(TOY_PLUGIN_ID, "toy-editor"), null);

  await registry.setEnabled(TOY_PLUGIN_ID, true);
  assert.deepEqual(registry.hookPlan(HookEvent.CheckpointBefore, toyKind), [
    { plugin: TOY_PLUGIN_ID, tool: "save-scenes", needs: [] },
  ]);
  assert.deepEqual(
    [...registry.hookEvents(toyKind)].sort(),
    [
      HookEvent.RunPrepare,
      HookEvent.CheckpointBefore,
      HookEvent.CheckpointAfter,
      HookEvent.RestoreAfter,
      HookEvent.Health,
      HookEvent.Crash,
      HookEvent.RunEnd,
    ].sort(),
  );
  const editor = { id: "toy-editor", label: "Toy editor", per: LockScope.Project, personFirst: "editor-state" };
  assert.deepEqual(registry.lockOf(TOY_PLUGIN_ID, "toy-editor"), editor);
  assert.equal(registry.lockOf(TOY_PLUGIN_ID, "kiln"), null);
  assert.deepEqual(registry.locksFor(toyKind), [{ plugin: TOY_PLUGIN_ID, lock: editor }], "its build needs it");
  assert.deepEqual(registry.locksFor(webKind), [], "no tool that needs it reaches a web game");
  assert.deepEqual(registry.needsOf(`${TOY_PLUGIN_ID}__build`), [{ plugin: TOY_PLUGIN_ID, lock: editor }]);
  assert.deepEqual(registry.needsOf(`${TOY_PLUGIN_ID}__save-scenes`), []);
  for (const unknown of ["nope__build", `${TOY_PLUGIN_ID}__paint`, "build", `${TOY_PLUGIN_ID}-bench__x`, ""])
    assert.deepEqual(registry.needsOf(unknown), [], unknown);
}

describe("a plugin's hooks, locks, needs and readiness", () => {
  it("keeps hooks, locks, needs and ready in their canonical form", () => {
    const kept = validateManifest(
      manifest(
        {
          locks: [
            { personFirst: "probe", per: "app", label: "Bench", id: "bench" },
            lock({ id: "kiln", label: "Kiln" }),
          ],
          hooks: [
            hook(HookEvent.CheckpointBefore, "save", { facts: ["toy-project"] }),
            hook(HookEvent.ToolBefore, "status"),
          ],
          mcpServers: [server({ needs: ["bench"] })],
        },
        { tools: { paint: { needs: ["bench", "kiln"] }, build: { ready: "status" } } },
      ),
    );
    assert.deepEqual(kept.locks, [
      { id: "bench", label: "Bench", per: LockScope.App, personFirst: "probe" },
      { id: "kiln", label: "Kiln", per: LockScope.Project, personFirst: "probe" },
    ]);
    // Canonical: the known keys of each entry, in a fixed order.
    assert.equal(
      JSON.stringify(kept.locks?.[0]),
      JSON.stringify({ id: "bench", label: "Bench", per: "app", personFirst: "probe" }),
    );
    assert.deepEqual(kept.hooks, [
      { on: "checkpoint.before", tool: "save", facts: ["toy-project"] },
      { on: "tool.before", tool: "status" },
    ]);
    const tool = (name: string) => kept.tools.find((t) => t.name === name);
    assert.deepEqual(tool("paint")?.needs, ["bench", "kiln"]);
    assert.equal(tool("build")?.ready, "status");
    assert.equal(tool("save")?.needs, undefined, "a tool that needs nothing says nothing");
    assert.deepEqual(kept.mcpServers?.[0]?.needs, ["bench"]);

    const plain = validateManifest(manifest({}));
    for (const section of ["hooks", "locks"]) assert.equal(section in plain, false, `no ${section} unless declared`);

    const raw = JSON.parse(readFileSync(path.join(TOY_PLUGIN, "plugin.json"), "utf8")) as PluginManifest;
    const toy = validateManifest(raw);
    assert.deepEqual(toy.locks, raw.locks, "the toy plugin keeps its lock");
    assert.deepEqual(toy.hooks, raw.hooks, "the toy plugin keeps its seven hooks");
    assert.deepEqual(
      toy.tools.find((t) => t.name === "build")?.needs,
      ["toy-editor"],
      "the toy plugin's build needs its editor",
    );
  });

  it("refuses a hook, lock, need or readiness it cannot keep: unknown moments, other plugins' tools, bad ids and labels", () => {
    // The host-program row is a valid manifest but for its hook.
    assert.doesNotThrow(() => validateManifest(manifest({}, genexHost)));
    for (const [name, section, sections, options] of hostile) {
      assert.throws(() => validateManifest(manifest(sections, options)), section, name);
    }
  });

  it("plans a moment's handlers by facts and plugin order, and a tool's own hooks only", plansByFactsAndOrder);
  it("a registry plans only the hooks of plugins that are on", registryPlansPluginsThatAreOn);

  it("the bundled Unreal manifest is valid and its lock's probe needs no lock", () => {
    const raw = JSON.parse(readFileSync("src/plugins/unreal/plugin.json", "utf8")) as PluginManifest;
    const unreal = validateManifest(raw);
    assert.equal(unreal.version, "0.7.0");
    assert.deepEqual(unreal.locks, [
      { id: "editor", label: "Unreal", per: LockScope.Project, personFirst: "editor-activity" },
    ]);
    const tool = (name: string) => unreal.tools.find((t) => t.name === name);
    assert.equal(tool("editor-activity")?.needs, undefined, "the probe asks without waiting for its own lock");
    const needing = unreal.tools.filter((t) => t.needs?.includes("editor")).map((t) => t.name);
    assert.deepEqual(needing.sort(), [...UNREAL_EDITOR_STEPS].sort());
    assert.deepEqual(unreal.mcpServers?.find((s) => s.id === "editor")?.needs, ["editor"]);
    assert.equal(tool("open-for-run")?.audience, "harness");
    assert.equal(tool("new-game")?.ready, "engine-status");
    const UNREAL_PROJECT = ["unreal-project"];
    assert.deepEqual(
      unreal.hooks,
      [
        ["run.prepare", "open-for-run"],
        ["run.prepare", "log-errors"],
        ["checkpoint.before", "save-all"],
        ["checkpoint.before", "log-errors"],
        ["checkpoint.after", "hero-shots"],
        ["restore.before", "save-all"],
        ["restore.before", "end-editor"],
        ["restore.after", "reopen-editor"],
        ["health", "editor-state"],
        ["crash", "reopen-editor"],
      ].map(([on, tool]) => ({ on, tool, facts: UNREAL_PROJECT })),
      "its moments, each for Unreal projects only; nothing ends the person's editor when a run ends",
    );
  });

  it("gives the Unreal plugin's save before a restore longer than it waits for a busy editor", () => {
    assert.ok(
      HOOK_CALL_MS[HookEvent.RestoreBefore] > RESTORE_SAVE_MAX_MS,
      "the step answers in its own words before Genex's ceiling cuts it off",
    );
  });

  it("gives the Unreal plugin's open-for-run longer than its slowest start: a busy wait, a helper update and two opens", () => {
    assert.ok(
      HOOK_CALL_MS[HookEvent.RunPrepare] > OPEN_FOR_RUN_MAX_MS,
      "the step answers in its own words before Genex's ceiling cuts it off",
    );
  });
});

/** The Unreal plugin's harness tools that work in the open editor, and so wait for its lock. */
const UNREAL_EDITOR_STEPS = [
  "open-for-run",
  "save-all",
  "end-editor",
  "reopen-editor",
  "update-helper",
  "add-cpp-module",
  "export-reference",
  "hero-shots",
  "play-check",
  "run-part",
  "rollback-part",
  "reload-level",
];
