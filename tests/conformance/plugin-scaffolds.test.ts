/**
 * A plugin's scaffolds (API 3): the kinds of project its tools make, each with its own label. A
 * scaffold whose tool reaches a game is a kind on offer of its own; when that tool makes the
 * project, Genex records the scaffold in the game's studio.json, and the record's rules add facts
 * detection would skip (a plugin inside a host project's `Plugins/`). A project that isn't a game
 * shows what it is beside its name.
 */
import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { buildContractorBrief } from "../../src/harness-seed/loop/chat-session.ts";
import { ownKindRules, pendingKindRule } from "../../src/harness-seed/loop/project-prompts.ts";
import { engineChoiceRule } from "../../src/harness-seed/loop/unreal-prompts.ts";
import { projectKindLabel } from "../../src/renderer/project-kind.ts";
import { HostMethod } from "../../src/shared/harness-api.ts";
import type { GameProject } from "../../src/shared/game-project.ts";
import { type PluginKindOffer, PluginSourceKind } from "../../src/shared/plugins.ts";
import {
  CoreFact,
  type FactRef,
  FactSource,
  FolderHolds,
  type ProjectFact,
  parseScaffoldRecord,
  pluginFactSource,
} from "../../src/shared/project-facts.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { PluginRegistry } from "../../src/substrate/plugins/registry.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";
import { copyOfExample, EXAMPLE_PLUGIN, PLUGIN_SDK_BACKEND, personAllowsLocalTools } from "../helpers/plugins.ts";
import { TOY_PLUGIN } from "../helpers/project-fixtures.ts";
import { tmpDir } from "../helpers/tmp.ts";

// biome-ignore lint/suspicious/noExplicitAny: a hostile manifest is any shape a writer may send.
type RawManifest = any;

const exampleManifest: RawManifest = JSON.parse(await readFile(path.join(EXAMPLE_PLUGIN, "plugin.json"), "utf8"));
const unrealManifest: RawManifest = JSON.parse(await readFile("src/plugins/unreal/plugin.json", "utf8"));

const TOY = "toy-project";
const TOY_PLUGIN_FACT = "toy-plugin";
const at = (id: string, where = "."): FactRef => ({ id, path: where });
const WEB = [at(CoreFact.WebGame)];

/** A tool for the example manifest, with `fields` added. */
const tool = (name: string, fields: Record<string, unknown> = {}) => ({
  name,
  description: `The ${name} tool.`,
  parameters: { type: "object", properties: {} },
  ...fields,
});

/** The rule a toy plugin scaffold adds: a `.toyplug` anywhere but in the toy helper's folder. */
const TOY_PLUGIN_RULE = { fact: TOY_PLUGIN_FACT, files: ["**/*.toyplug"], notUnder: ["**/ToyHelper/"] };

/** Tools that make kinds: a toy game, a toy plugin inside a host, and a port that is no scaffold. */
const KIND_TOOLS = [
  tool("new-toy", { makes: [TOY] }),
  tool("new-toy-plugin", { makes: [TOY, TOY_PLUGIN_FACT] }),
  tool("use-toy", { makes: [TOY] }),
  tool("greet"),
];
const SCAFFOLDS = [
  { id: "game", label: "Toy game", tool: "new-toy" },
  { id: "plugin", label: "Toy plugin", tool: "new-toy-plugin", facts: [TOY_PLUGIN_RULE] },
  { id: "bare", label: "Bare toy" },
];

/** The example manifest on API 3 with `fields`. */
const manifestWith = (fields: Record<string, unknown>): RawManifest => ({
  ...structuredClone(exampleManifest),
  apiVersion: 3,
  tools: KIND_TOOLS,
  skills: [],
  ...fields,
});

/** A registry whose only plugin is a bundled seed of the example with `fields`, and so on. */
async function registryWith(id: string, fields: Record<string, unknown>) {
  const root = await tmpDir("studio-scaffolds-");
  const seeds = path.join(root, "seeds");
  await mkdir(seeds);
  await copyOfExample(seeds, id, (m) => Object.assign(m, manifestWith({ id, ...fields })));
  const registry = new PluginRegistry(path.join(root, "installed"), seeds, PLUGIN_SDK_BACKEND, async () => null);
  await registry.init();
  return registry;
}

describe("a plugin's scaffolds", () => {
  it("a malformed scaffolds section is refused", () => {
    const rows: Array<[string, unknown, Record<string, unknown>?]> = [
      ["not a list", { id: "game", label: "Toy game" }],
      ["more than eight", Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, label: `S ${i}` }))],
      ["an entry that is no object", ["game"]],
      ["an id that is no fact id", [{ id: "Game", label: "Toy game" }]],
      ["an id with a path in it", [{ id: "../game", label: "Toy game" }]],
      ["an id twice", [SCAFFOLDS[0], { ...SCAFFOLDS[0], label: "Again" }]],
      ["no label", [{ id: "game" }]],
      ["an empty label", [{ id: "game", label: "" }]],
      ["a label over 40 characters", [{ id: "game", label: "x".repeat(41) }]],
      ["a label that is no text", [{ id: "game", label: 7 }]],
      ["a tool the manifest lacks", [{ id: "game", label: "Toy game", tool: "missing" }]],
      ["a tool that makes nothing", [{ id: "game", label: "Toy game", tool: "greet" }]],
      ["a tool that is no text", [{ id: "game", label: "Toy game", tool: ["new-toy"] }]],
      ["a tool two scaffolds name", [SCAFFOLDS[0], { id: "again", label: "Toy again", tool: "new-toy" }]],
      ["facts with no tool", [{ id: "game", label: "Toy game", facts: [TOY_PLUGIN_RULE] }]],
      ["more than four rules", [{ ...SCAFFOLDS[1], facts: Array.from({ length: 5 }, () => TOY_PLUGIN_RULE) }]],
      ["a rule outside the detect grammar", [{ ...SCAFFOLDS[1], facts: [{ ...TOY_PLUGIN_RULE, files: ["../x"] }] }]],
      ["a rule of a fact its tool doesn't make", [{ ...SCAFFOLDS[1], facts: [{ ...TOY_PLUGIN_RULE, fact: "other" }] }]],
      ["facts that are no list", [{ ...SCAFFOLDS[1], facts: TOY_PLUGIN_RULE }]],
      ["on API 2", [{ id: "game", label: "Toy game" }], { apiVersion: 2, tools: [tool("greet")] }],
      ["a game flag that is no true or false", [{ ...SCAFFOLDS[0], game: "no" }]],
    ];
    for (const [name, scaffolds, fields] of rows)
      assert.throws(() => validateManifest(manifestWith({ scaffolds, ...fields })), /scaffold/i, name);
    const kept = validateManifest(manifestWith({ scaffolds: [...SCAFFOLDS, { id: "x", label: "X", extra: 1 }] }));
    assert.deepEqual(kept.scaffolds, [...SCAFFOLDS, { id: "x", label: "X" }], "only present known keys are kept");
  });

  it("each scaffold of a reaching tool is its own kind on the card, named by its label", async () => {
    const registry = await registryWith("toys", { scaffolds: SCAFFOLDS });
    try {
      const offer = (name: string, scaffold: string, label: string, makes: string[]): PluginKindOffer => ({
        plugin: "toys",
        name: exampleManifest.name,
        tool: `toys__${name}`,
        makes,
        scaffold,
        label,
      });
      assert.deepEqual(registry.snapshot(WEB).kinds, [
        offer("new-toy", "game", "Toy game", [TOY]),
        offer("new-toy-plugin", "plugin", "Toy plugin", [TOY, TOY_PLUGIN_FACT]),
      ]);
      assert.deepEqual(
        registry.snapshot(WEB, (name) => name !== "toys__new-toy").kinds.map((kind) => kind.scaffold),
        ["plugin"],
        "a scaffold whose tool isn't offered is not on offer",
      );
      assert.deepEqual(registry.scaffoldOf("toys", "new-toy-plugin"), {
        plugin: "toys",
        id: "plugin",
        label: "Toy plugin",
        facts: [TOY_PLUGIN_RULE],
      });
      assert.deepEqual(registry.scaffoldOf("toys", "new-toy"), {
        plugin: "toys",
        id: "game",
        label: "Toy game",
        facts: [],
      });
      assert.equal(registry.scaffoldOf("toys", "use-toy"), undefined, "a kind tool no scaffold names");
      assert.equal(registry.scaffoldOf("nobody", "new-toy"), undefined);
    } finally {
      registry.cancel();
    }
    const plain = await registryWith("plain", {});
    try {
      assert.deepEqual(
        plain.snapshot(WEB).kinds.map((kind) => [kind.tool, kind.label]),
        [
          ["plain__new-toy", undefined],
          ["plain__new-toy-plugin", undefined],
          ["plain__use-toy", undefined],
        ],
        "a plugin with no scaffolds offers each kind tool as before",
      );
    } finally {
      plain.cancel();
    }
  });

  it("the question offers only what makes a game; a scaffold that makes something else is made when the request asks for it", () => {
    const offers: PluginKindOffer[] = [
      {
        plugin: "unreal",
        name: "Unreal Engine",
        tool: "unreal__new-game",
        makes: [],
        scaffold: "game",
        label: "Unreal game",
      },
      {
        plugin: "unreal",
        name: "Unreal Engine",
        tool: "unreal__new-plugin",
        makes: [],
        scaffold: "plugin",
        label: "Unreal plugin",
        game: false,
      },
    ];
    const rule = engineChoiceRule("claude-code", null, offers);
    const question = rule.slice(0, rule.indexOf("and end your reply"));
    assert.ok(question.includes('"Unreal game"'), "a game's kind is an option");
    assert.ok(!question.includes("Unreal plugin"), "an Unreal plugin project is no answer to where a game plays");
    assert.match(rule, /When the request asks for an Unreal plugin, call mcp__studio__unreal__new-plugin/);
    const only = engineChoiceRule("claude-code", null, [offers[1]!]);
    assert.doesNotMatch(only, /ask the user/, "with no game on offer but the web, nothing is asked");
    assert.match(only, /asks for an Unreal plugin/);
  });

  it("the card offers each scaffold by its label", () => {
    const unreal = (tool: string, scaffold: string, label: string): PluginKindOffer => ({
      plugin: "unreal",
      name: "Unreal Editor",
      tool,
      makes: ["unreal-project"],
      asksReady: true,
      ready: true,
      scaffold,
      label,
    });
    const rule = engineChoiceRule("claude-code", null, [
      unreal("unreal__new-game", "game", "Unreal game"),
      unreal("unreal__new-plugin", "plugin", "Unreal plugin"),
      { plugin: "godot", name: "Godot", tool: "godot__use", makes: ["godot-project"] },
      { plugin: "godot", name: "Godot", tool: "godot__new", makes: ["godot-project"], asksReady: true },
    ]);
    for (const option of ['"Unreal game"', '"Unreal plugin"', '"Godot"']) assert.ok(rule.includes(option), option);
    assert.match(rule, /is Unreal plugin, call mcp__studio__unreal__new-plugin/);
    assert.match(rule, /is Unreal game, call mcp__studio__unreal__new-game/);
    assert.match(rule, /is Godot, call mcp__studio__godot__new/);
    assert.doesNotMatch(rule, /godot__use/, "a plugin with no scaffolds still offers one kind");
  });

  it("with no card, the brief pairs each scaffold's label with its own tool", () => {
    const unreal = (tool: string, scaffold: string, label: string): PluginKindOffer => ({
      plugin: "unreal",
      name: "Unreal Editor",
      tool,
      makes: ["unreal-project"],
      scaffold,
      label,
    });
    const offers = [
      unreal("unreal__new-game", "game", "Unreal game"),
      unreal("unreal__new-plugin", "plugin", "Unreal plugin"),
    ];
    const rules = pendingKindRule("claude-code", offers, null, null, false).join("\n");
    assert.match(
      rules,
      /names Unreal game, call mcp__studio__unreal__new-game: it makes the game's Unreal game project/,
    );
    assert.match(
      rules,
      /names Unreal plugin, call mcp__studio__unreal__new-plugin: it makes the game's Unreal plugin project/,
    );
    assert.doesNotMatch(rules, /names Unreal Editor/, "never two lines with one trigger");
  });

  it("a plugin's own kind held only by a scaffold's record looks for its plugin first", () => {
    const fact = (source: ProjectFact["source"]): ProjectFact => ({ id: TOY_PLUGIN_FACT, path: ".", source });
    const scaffolded = ownKindRules("claude-code", fact(FactSource.Scaffold)).join("\n");
    assert.match(scaffolded, /plugins_find/, "the plugin may be off: it is looked for, never assumed on");
    const detected = ownKindRules("claude-code", fact(pluginFactSource("toys"))).join("\n");
    assert.doesNotMatch(detected, /plugins_find/, "one its plugin's detect found has that plugin on");
    assert.match(ownKindRules("claude-code", { id: CoreFact.GodotProject, path: "." }).join("\n"), /plugins_find/);
    const roblox = ownKindRules("claude-code", { id: CoreFact.RobloxProject, path: ".", source: FactSource.Core });
    assert.match(roblox.join("\n"), /plugins_find/, "a Roblox place with Roblox Studio off looks for it first");
    assert.match(roblox.join("\n"), /holds a Roblox place/, "and names it in words");
    const brief = buildContractorBrief({ ask: "go on", engine: "claude-code", facts: [fact(FactSource.Scaffold)] });
    assert.match(brief, /plugins_find/, "the chat's brief keeps the fact's source");
  });

  it("a project that isn't a game shows what it is; a game shows nothing", () => {
    const fact = (id: string, source: ProjectFact["source"] = FactSource.Core, where = "."): ProjectFact => ({
      id,
      path: where,
      source,
    });
    const game = (facts: ProjectFact[], extra: Partial<GameProject> = {}) =>
      ({ name: "g", title: "G", facts, ...extra }) as GameProject;
    const scaffold = { plugin: "unreal", id: "plugin", label: "Unreal plugin" };
    const rows: Array<[string, GameProject, string | null]> = [
      [
        "a host project with its plugin",
        game(
          [
            fact("unreal-project", FactSource.Core, "unreal"),
            fact("unreal-plugin", FactSource.Scaffold, "unreal/Plugins/X"),
          ],
          {
            scaffold,
          },
        ),
        "Unreal plugin",
      ],
      [
        "a scaffold fact the app has a word for: the app's word, in the app's language, not the stored label",
        game([fact("unreal-plugin", FactSource.Scaffold, "unreal/Plugins/X")], {
          scaffold: { ...scaffold, label: "Host plugin" },
        }),
        "Unreal plugin",
      ],
      [
        "a scaffold fact no word names keeps the scaffold's label",
        game([fact("toy-project", FactSource.Scaffold, "toy")], { scaffold: { ...scaffold, label: "Toy addon" } }),
        "Toy addon",
      ],
      [
        "a record whose rules no longer find anything",
        game([fact("unreal-project", FactSource.Core, "unreal")], { scaffold }),
        null,
      ],
      ["an Unreal plugin's own folder", game([fact("unreal-plugin")]), "Unreal plugin"],
      ["a folder of Blender files", game([fact("blender-assets")]), "Blender assets"],
      ["a web game", game([fact("web-game")]), null],
      ["a web game with Blender files", game([fact("web-game"), fact("blender-assets", FactSource.Core, "art")]), null],
      ["an Unreal game", game([fact("unreal-project", FactSource.Link)]), null],
      ["a Godot game", game([fact("godot-project")]), null],
      ["a kind no word names", game([fact("toy-project", "plugin:toy")]), null],
      ["no kind yet", game([], { holds: FolderHolds.Nothing }), null],
    ];
    for (const [name, listed, label] of rows) assert.equal(projectKindLabel(listed), label, name);
  });

  it("a malformed or hostile scaffold record is ignored, never followed", () => {
    const good = { plugin: "unreal", id: "plugin", label: "Unreal plugin", facts: [TOY_PLUGIN_RULE] };
    assert.deepEqual(parseScaffoldRecord(good), good);
    const rows: Array<[string, unknown]> = [
      ["nothing", undefined],
      ["a string", "unreal"],
      ["a list", [good]],
      ["a plugin id with a path", { ...good, plugin: "../unreal" }],
      ["a plugin id that is no text", { ...good, plugin: 3 }],
      ["an id that is no fact id", { ...good, id: "Plugin" }],
      ["a label over 40 characters", { ...good, label: "x".repeat(41) }],
      ["no label", { ...good, label: undefined }],
      ["more than four rules", { ...good, facts: Array.from({ length: 5 }, () => TOY_PLUGIN_RULE) }],
      ["a rule reaching out of the folder", { ...good, facts: [{ ...TOY_PLUGIN_RULE, files: ["../../*.uplugin"] }] }],
      ["an absolute rule", { ...good, facts: [{ ...TOY_PLUGIN_RULE, files: ["/etc/*"] }] }],
      ["a rule whose fact is no fact id", { ...good, facts: [{ ...TOY_PLUGIN_RULE, fact: "Bad Fact" }] }],
      ["facts that are no list", { ...good, facts: "**/*" }],
    ];
    for (const [name, raw] of rows) assert.equal(parseScaffoldRecord(raw), null, name);
  });

  it("the Unreal plugin offers an Unreal game and an Unreal plugin", async () => {
    const kept = validateManifest(unrealManifest);
    assert.deepEqual(kept.scaffolds, unrealManifest.scaffolds, "the bundled manifest keeps its scaffolds");
    assert.deepEqual(
      unrealManifest.scaffolds.map((s: { label: string }) => s.label),
      ["Unreal game", "Unreal plugin"],
    );
    const registry = await registryWith("unreal", {
      name: unrealManifest.name,
      tools: unrealManifest.tools,
      locks: unrealManifest.locks,
      detect: unrealManifest.detect,
      scaffolds: unrealManifest.scaffolds,
    });
    try {
      assert.deepEqual(
        registry.snapshot([]).kinds.map((kind) => [kind.label, kind.tool, kind.asksReady]),
        [
          ["Unreal game", "unreal__new-game", true],
          ["Unreal plugin", "unreal__new-plugin", true],
        ],
      );
      assert.deepEqual(
        registry.snapshot([]).kinds.map((kind) => kind.game),
        [undefined, false],
        "an Unreal plugin project is no game: the new game's question never offers it",
      );
      assert.deepEqual(registry.scaffoldOf("unreal", "new-plugin")?.facts, [
        { fact: "unreal-plugin", files: ["**/*.uplugin"], notUnder: ["**/GenexEditorHelper/"] },
      ]);
    } finally {
      registry.cancel();
    }
  });
});

describe("a scaffold's record in a game", () => {
  let lite: CoreLite;
  before(async () => {
    lite = await coreLite();
  });
  after(async () => {
    lite.core.plugins.cancel();
    await lite.close();
  });

  /** A local stand-in of the toy plugin whose `new-toy-plugin` makes a host with its plugin and the toy helper. */
  async function scaffoldingPlugin(t: { after: (fn: () => Promise<void>) => void }, writes = true) {
    const id = writes ? "toy-scaffold" : "toy-scaffold-idle";
    const dir = path.join(await tmpDir("studio-toy-scaffold-"), id);
    await cp(TOY_PLUGIN, dir, { recursive: true });
    const manifest = JSON.parse(await readFile(path.join(dir, "plugin.json"), "utf8"));
    manifest.id = id;
    manifest.engine.id = id;
    manifest.tools.push(tool("new-toy-plugin", { makes: [TOY, TOY_PLUGIN_FACT] }));
    manifest.scaffolds = [SCAFFOLDS[1]];
    await writeFile(path.join(dir, "plugin.json"), JSON.stringify(manifest, null, 2));
    const made = writes
      ? {
          "toy/Host.toyproj": "{}",
          "toy/Plugins/Tool/Tool.toyplug": "{}",
          "toy/Plugins/ToyHelper/ToyHelper.toyplug": "{}",
        }
      : {};
    await writeFile(
      path.join(dir, "backend.mjs"),
      `import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
export async function activate() {
  return {
    async tool(name, _args, ctx) {
      if (name !== "new-toy-plugin") return "nothing";
      for (const [file, text] of Object.entries(${JSON.stringify(made)})) {
        await mkdir(path.dirname(path.join(ctx.directory, file)), { recursive: true });
        await writeFile(path.join(ctx.directory, file), text);
      }
      return "Made Tool inside the host project Host.";
    },
  };
}\n`,
    );
    await lite.core.plugins.installLocal(dir, PluginSourceKind.Local, []);
    await lite.core.plugins.setEnabled(id, true);
    // The person's yes on the card: this case is about the record, not the card.
    const asksAgain = personAllowsLocalTools(lite.core.plugins);
    t.after(async () => {
      asksAgain();
      await lite.core.plugins.setEnabled(id, false);
    });
    return id;
  }

  const listed = async (name: string) => {
    const game = (await lite.core.games.list()).find((g) => g.name === name);
    assert.ok(game, `${name} is listed`);
    return game;
  };
  const factRows = (game: GameProject) => game.facts.map((fact) => [fact.id, fact.path, fact.source]);

  it("making a project with a scaffold's tool records the scaffold, and its rules add facts detection skips", async (t) => {
    const id = await scaffoldingPlugin(t);
    const game = await lite.core.createGame("Scaffolded");
    await writeFile(path.join(game.dir, "studio.json"), JSON.stringify({ title: "Scaffolded", keep: "mine" }));
    const answer = await lite.api()[HostMethod.PluginsInvoke]({
      project: game.name,
      threadId: await lite.core.threadForGame(game.name),
      name: `${id}__new-toy-plugin`,
      args: {},
    });
    assert.match(JSON.stringify(answer), /Made Tool/);
    const meta = JSON.parse(await readFile(path.join(game.dir, "studio.json"), "utf8"));
    assert.equal(meta.keep, "mine", "every other key stays");
    assert.deepEqual(meta.scaffold, { plugin: id, id: "plugin", label: "Toy plugin", facts: [TOY_PLUGIN_RULE] });
    const on = await listed(game.name);
    assert.deepEqual(factRows(on), [
      [TOY, "toy", `plugin:${id}`],
      [TOY_PLUGIN_FACT, "toy/Plugins/Tool", FactSource.Scaffold],
    ]);
    assert.deepEqual(on.scaffold, { plugin: id, id: "plugin", label: "Toy plugin" });
    assert.equal(projectKindLabel(on), "Toy plugin");

    // Turned off, the plugin detects nothing; the record's rules still find the plugin.
    await lite.core.plugins.setEnabled(id, false);
    assert.deepEqual(factRows(await listed(game.name)), [[TOY_PLUGIN_FACT, "toy/Plugins/Tool", FactSource.Scaffold]]);
  });

  it("a scaffold tool that makes nothing records nothing, even where its rules already match", async (t) => {
    const id = await scaffoldingPlugin(t, false);
    const game = await lite.core.createGame("Idle scaffold");
    await mkdir(path.join(game.dir, "vendor", "Plugins", "Foo"), { recursive: true });
    await writeFile(path.join(game.dir, "vendor", "Plugins", "Foo", "Foo.toyplug"), "{}");
    await writeFile(path.join(game.dir, "studio.json"), JSON.stringify({ title: "Idle scaffold" }));
    const answer = await lite.api()[HostMethod.PluginsInvoke]({
      project: game.name,
      threadId: await lite.core.threadForGame(game.name),
      name: `${id}__new-toy-plugin`,
      args: {},
    });
    assert.doesNotMatch(JSON.stringify(answer), /End your reply now/, "no note that the project changed");
    const meta = JSON.parse(await readFile(path.join(game.dir, "studio.json"), "utf8"));
    assert.equal(meta.scaffold, undefined, "no record written");
  });

  it("a malformed or hostile record in studio.json adds no facts and no scaffold", async () => {
    const hostile: unknown[] = [
      "toy",
      { plugin: "toy", id: "plugin", label: "Toy plugin", facts: [{ fact: "toy-plugin", files: ["../*.toyplug"] }] },
      { plugin: "toy", id: "plugin", label: "x".repeat(41), facts: [TOY_PLUGIN_RULE] },
      { plugin: "../toy", id: "plugin", label: "Toy plugin", facts: [TOY_PLUGIN_RULE] },
    ];
    for (const [i, scaffold] of hostile.entries()) {
      const game = await lite.core.createGame(`Hostile ${i}`);
      await mkdir(path.join(game.dir, "Plugins", "Tool"), { recursive: true });
      await writeFile(path.join(game.dir, "Plugins", "Tool", "Tool.toyplug"), "{}");
      const meta = JSON.parse(await readFile(path.join(game.dir, "studio.json"), "utf8"));
      await writeFile(path.join(game.dir, "studio.json"), JSON.stringify({ ...meta, scaffold }));
      const game2 = await listed(game.name);
      assert.ok(!game2.facts.some((fact) => fact.id === TOY_PLUGIN_FACT), `record ${i}: no fact`);
      assert.equal(game2.scaffold, undefined, `record ${i}: no scaffold`);
    }
  });
});
