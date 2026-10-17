/**
 * Writing a Genex plugin for an engine Genex lacks: the Genex plugin carries the plugin-author skill, whose
 * example is a complete plugin the agent writes into the project; `plugin_check` checks such a folder
 * in place and installs nothing; `plugins_find`'s write-a-plugin answer names the guide. Only the
 * person loads a plugin and turns it on: the agent is never given a way to.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { cp, lstat, mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { checkPluginFolder } from "../../src/main/core/plugin-check.ts";
import { findPlugins } from "../../src/main/core/plugin-finder.ts";
import { GENEX_PLUGIN_ID } from "../../src/shared/genex.ts";
import { HostMethod } from "../../src/shared/harness-api.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import {
  isAgentTool,
  isFileSkill,
  type PluginManifest,
  PluginSourceKind,
  PluginToolAudience,
} from "../../src/shared/plugins.ts";
import { FolderHolds, type GameKind } from "../../src/shared/project-facts.ts";
import { FindNext, ProjectTool } from "../../src/shared/project-tools.ts";
import type { DelegateRequest } from "../../src/substrate/engines/types.ts";
import { inspectPackage, validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { PluginRegistry } from "../../src/substrate/plugins/registry.ts";
import { type CoreLite, coreLite, sharedResources } from "../helpers/core-lite.ts";
import { PLUGIN_AUTHOR, readSkill, writeSkillExample } from "../helpers/plugin-author.ts";
import { closeBeforeCleanup, tmpDir } from "../helpers/tmp.ts";

/** The fixture engine every delegation here runs on. */
const ENGINE = "claude-code";
/** The Genex plugin as it ships. */
const GENEX_MANIFEST = validateManifest(
  JSON.parse(readFileSync(new URL("../../src/plugins/genex/plugin.json", import.meta.url), "utf8")),
);
/** Every section the skill's example teaches, kept by Genex as written. */
const TAUGHT = [
  "detect",
  "tools",
  "skills",
  "locks",
  "folders",
  "hooks",
  "observers",
  "workspace",
  "assets",
  "workerTypes",
  "scaffolds",
] as const;

/** A stand-in for the Sketch editor's control port on this test's own port: it builds, and records each call. */
async function sketchEditor() {
  const calls: Array<{ route: string | undefined; body: unknown }> = [];
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => {
      text += chunk;
    });
    request.on("end", () => {
      calls.push({ route: request.url, body: text ? JSON.parse(text) : null });
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, output: "built" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return { port, calls, close };
}

/**
 * A stand-in for the Sketch editor that, like the real one, stops answering once it is asked to
 * close: its control port goes away with it.
 */
async function closingSketchEditor() {
  const routes: string[] = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      routes.push(String(request.url));
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, open: true }));
      if (request.url === "/close") server.close();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return { port, routes, close };
}

/** Names `port` as the project's Sketch editor port, where the skill's example reads it. */
async function writeEditorPort(dir: string, port: number): Promise<void> {
  await mkdir(path.join(dir, ".sketch"), { recursive: true });
  await writeFile(path.join(dir, ".sketch", "editor.json"), JSON.stringify({ port }));
}

/** A registry over the bundled plugins as a build ships them (the Genex plugin on), in a temp folder. */
async function bundledRegistry(): Promise<PluginRegistry> {
  const resources = await sharedResources();
  const root = await tmpDir("studio-plugin-author-");
  const registry = new PluginRegistry(
    path.join(root, "installed"),
    path.join(resources, "plugins"),
    path.join(resources, "plugin-sdk", "backend.mjs"),
    async () => null,
  );
  closeBeforeCleanup(async () => registry.cancel());
  await registry.init();
  return registry;
}

/** A game folder of the test's own and its binding. */
async function project(name: string) {
  const dir = await realpath(await tmpDir(`studio-plugin-author-${name}-`));
  return { dir, binding: { project: name, directory: dir } };
}

/** Every entry under `dir` with its kind, size and content hash: what a call that writes nothing leaves alike. */
async function tree(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of (await readdir(path.join(dir, rel))).sort()) {
    const file = rel ? `${rel}/${entry}` : entry;
    const s = await lstat(path.join(dir, file));
    if (s.isDirectory()) {
      out.push(`${file}/`, ...(await tree(dir, file)));
      continue;
    }
    const hash = s.isFile()
      ? createHash("sha256")
          .update(await readFile(path.join(dir, file)))
          .digest("hex")
      : "link";
    out.push(`${file} ${hash}`);
  }
  return out;
}

/**
 * The example the skill teaches is nothing the person is warned about: no dangerous finding, and,
 * as the scan reads code and not Markdown, only the plugin's own Markdown (its skill file and its
 * judge's brief) disclosed as not read.
 */
function assertScanQuiet(scan: { verdict: string; findings: Array<{ rule: string; severity: string; file: string }> }) {
  assert.deepEqual(
    scan.findings.filter((f) => f.severity === "dangerous"),
    [],
  );
  assert.notEqual(scan.verdict, "dangerous");
  assert.deepEqual(
    scan.findings.map((f) => `${f.rule} ${f.file}`),
    ["not-scanned judges/first-play.md", "not-scanned skills/sketch.md"],
  );
}

/**
 * Hostile shapes beside a plugin folder the skill wrote in a game: a link out of the game, a folder
 * holding a link, a broken manifest and a file; answers the folder arguments that name them and
 * others no check may take.
 */
async function hostileFolders(
  gameDir: string,
  folder: string,
  outside: string,
): Promise<Array<Record<string, unknown>>> {
  const plugins = path.join(gameDir, "genex-plugins");
  await mkdir(outside);
  await cp(path.join(gameDir, folder), path.join(outside, "sketch"), { recursive: true });
  await symlink(path.join(outside, "sketch"), path.join(plugins, "escape"));
  await cp(path.join(gameDir, folder), path.join(plugins, "linked"), { recursive: true });
  await symlink(path.join(outside, "sketch", "backend.mjs"), path.join(plugins, "linked", "extra.mjs"));
  await mkdir(path.join(plugins, "broken"));
  await writeFile(path.join(plugins, "broken", "plugin.json"), "{ not json");
  return [
    { folder: path.join(gameDir, folder) },
    { folder: "../outside/sketch" },
    { folder: "genex-plugins/../.." },
    { folder: "." },
    { folder: "genex-plugins/escape" },
    { folder: "genex-plugins/linked" },
    { folder: "genex-plugins/broken" },
    { folder: "genex-plugins/missing" },
    { folder: `${folder}/plugin.json` },
    { folder: "genex-plugins\\sketch" },
    { folder: "genex-plugins/\u0000sketch" },
    { folder: `genex-plugins/${"x".repeat(300)}` },
    { folder: "" },
    { folder: 7 },
    {},
  ];
}

describe("the plugin-author skill", () => {
  let registry: PluginRegistry;
  before(async () => {
    registry = await bundledRegistry();
  });

  it("the Genex plugin gives every project the plugin-author skill", async () => {
    const skill = GENEX_MANIFEST.skills.find((s) => s.name === PLUGIN_AUTHOR.skill);
    assert.ok(skill && isFileSkill(skill), "a skill read on demand");
    assert.deepEqual(skill.references, [...PLUGIN_AUTHOR.references]);
    const kinds: Record<string, GameKind> = {
      "no kind yet": { facts: [] },
      web: { facts: [{ id: "web-game", path: "." }] },
      unreal: { facts: [{ id: "unreal-project", path: "." }] },
      godot: { facts: [{ id: "godot-project", path: "." }] },
      "files of its own": { facts: [], holds: FolderHolds.OwnFiles },
    };
    for (const [label, game] of Object.entries(kinds)) {
      const snapshot = registry.snapshot(game);
      assert.match(snapshot.guidance, /\[genex\/plugin-author\]/, label);
      assert.ok(
        snapshot.tools.some((tool) => tool.name === PLUGIN_AUTHOR.tool),
        `${label}: it is read with ${PLUGIN_AUTHOR.tool}`,
      );
    }
    const { binding } = await project("guide");
    const text = await readSkill(registry, binding);
    assert.match(text, /genex-plugins\/<id>/, "it says where the plugin goes");
    assert.match(text, /plugin_check/, "and how to check it");
    assert.match(
      text,
      /Plugins → Add → Load local plugin…, choose genex-plugins\/<id>\. It starts off; turn it on there\./,
    );
    assert.match(text, /cannot load a plugin or turn one on/);
    assert.match(text, /runs with the person's access/);
  });

  it("the skill's example, written into a folder as the skill says, is a plugin Genex validates and loads off", async () => {
    const { dir, binding } = await project("sketch");
    const { folder, files } = await writeSkillExample(registry, binding, dir);
    assert.equal(folder, "genex-plugins/sketch");
    assert.ok(files.includes("genex-plugins/sketch/plugin.json"));
    assert.ok(files.includes("genex-plugins/sketch/backend.mjs"));
    const plugin = path.join(dir, folder);
    const raw = JSON.parse(await readFile(path.join(plugin, "plugin.json"), "utf8")) as Record<string, unknown>;
    const kept = (await inspectPackage(plugin)) as unknown as Record<string, unknown>;
    for (const section of TAUGHT) {
      assert.ok(raw[section] !== undefined, `the example declares ${section}`);
      assert.deepEqual(kept[section], raw[section], `Genex keeps its ${section} as written`);
    }
    const manifest = kept as unknown as PluginManifest;
    const agent = manifest.tools.filter(isAgentTool);
    assert.ok(
      agent.some((tool) => tool.facts?.length && tool.needs?.length),
      "an agent tool scoped by facts that needs a lock",
    );
    for (const hook of manifest.hooks ?? []) {
      const tool = manifest.tools.find((t) => t.name === hook.tool);
      assert.equal(tool?.audience, PluginToolAudience.Harness, `${hook.on} runs a harness tool`);
    }
    assert.ok(manifest.skills.some(isFileSkill), "a skill of its own, read on demand");

    await registry.installLocal(plugin, PluginSourceKind.Local, []);
    assert.equal(registry.enabled("sketch"), false, "loaded, it starts off");
    await assert.rejects(registry.tool("sketch__build", {}, binding), /unavailable/i, "off, its tools don't run");

    // The person turns it on and answers the tool's card yes. The editor is a stand-in on a port of
    // this test's own, named in the project's .sketch/editor.json as the skill says.
    await registry.setEnabled("sketch", true);
    const asked: Array<{ plugin: string; always: boolean }> = [];
    registry.consent = async (pluginId, _tool, _args, _binding, _signal, options) => {
      asked.push({ plugin: pluginId, always: options?.offerAlways === true });
      return { approved: true, by: "user" };
    };
    const editor = await sketchEditor();
    try {
      await writeEditorPort(dir, editor.port);
      const answer = (await registry.tool("sketch__build", {}, binding)) as { ok?: unknown; output?: unknown };
      assert.deepEqual(asked, [{ plugin: "sketch", always: true }], "its tool asks first");
      assert.deepEqual(answer, { ok: true, output: "built" }, "its backend answers with the editor's output");
      assert.deepEqual(editor.calls, [{ route: "/build", body: { project: dir } }], "it asked the editor to build");
    } finally {
      await editor.close();
    }
  });

  it("the skill's example says nobody is in a closed editor, so its lock is free at once", async () => {
    const { dir, binding } = await project("sketch-closed");
    const { folder } = await writeSkillExample(registry, binding, dir);
    const editor = await sketchEditor();
    await editor.close();
    // The port of an editor that has closed: nothing listens there now.
    await writeEditorPort(dir, editor.port);
    const backend = (await import(pathToFileURL(path.join(dir, folder, "backend.mjs")).href)) as {
      activate: () => Promise<{ tool: (name: string, args: object, context: object) => Promise<unknown> }>;
    };
    const tools = await backend.activate();
    const context = { directory: dir, project: "sketch-closed", signal: new AbortController().signal };
    assert.deepEqual(await tools.tool("editor-state", {}, context), { personActive: false, unsaved: 0 });
  });
});

describe("the skill's example across two Loops", () => {
  it("what a run's end does never leaves the next run's prepare step refused", async () => {
    const registry = await bundledRegistry();
    const { dir, binding } = await project("sketch-twice");
    const { folder } = await writeSkillExample(registry, binding, dir);
    const manifest = JSON.parse(await readFile(path.join(dir, folder, "plugin.json"), "utf8")) as PluginManifest;
    const backend = (await import(pathToFileURL(path.join(dir, folder, "backend.mjs")).href)) as {
      activate: () => Promise<{ tool: (name: string, args: object, context: object) => Promise<unknown> }>;
    };
    const tools = await backend.activate();
    const editor = await closingSketchEditor();
    try {
      await writeEditorPort(dir, editor.port);
      const context = { directory: dir, project: "sketch-twice", signal: new AbortController().signal };
      /** Every hook the example runs at `moment`, with their answers. */
      const at = async (moment: string) => {
        const answers: unknown[] = [];
        for (const hook of (manifest.hooks ?? []).filter((h) => h.on === moment))
          answers.push(await tools.tool(hook.tool, {}, { ...context, hook: { on: moment } }));
        return answers;
      };
      const blocked = (answers: unknown[]) => answers.filter((a) => (a as { block?: unknown }).block !== undefined);
      assert.deepEqual(blocked(await at("run.prepare")), [], "the first Loop starts");
      await at("run.end");
      assert.deepEqual(blocked(await at("run.prepare")), [], "the next Loop starts too");
    } finally {
      await editor.close();
    }
  });
});

describe("plugin_check's next step", () => {
  it("a folder of a plugin the person has on is loaded again with words that say it stays on", async () => {
    const dir = await realpath(await tmpDir("studio-plugin-next-"));
    const { folder } = await writeSkillExample(await bundledRegistry(), { project: "sketchbook", directory: dir }, dir);
    const first = await checkPluginFolder(dir, { folder });
    assert.ok(first.ok);
    assert.match(first.next, /It starts off; turn it on there\./);
    const asked: string[] = [];
    const again = await checkPluginFolder(dir, { folder }, (id) => {
      asked.push(id);
      return true;
    });
    assert.ok(again.ok);
    assert.deepEqual(asked, ["sketch"], "asked about the folder's own plugin");
    assert.match(again.next, /It is on, so it stays on and its new code runs at once/);
    assert.doesNotMatch(again.next, /starts off/);
  });
});

describe("plugin_check, the chat's own session's", () => {
  let lite: CoreLite;
  let root: string;
  before(async () => {
    root = await realpath(await tmpDir("studio-plugin-check-"));
    lite = await coreLite({
      gamesRoot: path.join(root, "games"),
      executionPolicy: { allowedProjectRoot: root, runBackgroundImprovement: false },
    });
  });
  after(async () => {
    lite.core.plugins.cancel();
    await lite.close();
  });

  /** What the plugins look like to the person: each one's id, version and whether it is on. */
  const pluginsNow = () =>
    lite.core.plugins
      .list()
      .map((p) => `${p.manifest.id}@${p.manifest.version} ${lite.core.plugins.enabled(p.manifest.id) ? "on" : "off"}`)
      .sort();

  it("plugin_check checks a folder inside the project and installs nothing", async (t) => {
    const calls: Array<Record<string, unknown>> = [];
    const sessions: Array<{ tools: string[]; answers: unknown[] }> = [];
    lite.core.engines.register({
      id: ENGINE,
      label: "fixture",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "fixture" }),
      models: async () => [],
      delegate: async (request: DelegateRequest) => {
        const tools = (request.liveTools ?? []).map((tool) => tool.name);
        const answers: unknown[] = [];
        if (tools.includes(ProjectTool.PluginCheck))
          for (const args of calls)
            answers.push(
              await request.onLiveTool?.(ProjectTool.PluginCheck, args).catch((err: Error) => `threw ${err.message}`),
            );
        sessions.push({ tools, answers });
        return { ok: true, engine: ENGINE, summary: "fixture", turns: 1, usage: {} };
      },
    } as never);
    t.after(async () => {
      await lite.core.mcp.close().catch(() => {});
    });

    const game = await lite.core.createGame("Sketchbook");
    const gameDir = await realpath(lite.core.games.dirFor(game.name));
    const binding = { project: game.name, directory: gameDir };
    const { folder } = await writeSkillExample(lite.core.plugins, binding, gameDir);
    const outside = path.join(root, "outside");
    const hostile = await hostileFolders(gameDir, folder, outside);
    calls.push({ folder }, ...hostile);
    const before = { plugins: pluginsNow(), game: await tree(gameDir), outside: await tree(outside) };
    /** Where Genex keeps the plugins it installed, and their records. */
    const pluginData = path.join(lite.userData, "engine-homes", "plugins");
    const installed = await tree(pluginData);

    // In Plan it still runs: it only reads.
    const threadId = await lite.core.threadForGame(game.name);
    await lite.core.setPermissionMode(threadId, PermissionMode.Plan);
    await lite.api()["engine.delegate"]({ engine: ENGINE, project: game.name, threadId, prompt: "check it" });
    const chat = sessions.at(-1);
    assert.ok(chat?.tools.includes(ProjectTool.PluginCheck), `the chat's own session: ${JSON.stringify(chat?.tools)}`);
    const [good, ...refused] = (chat?.answers ?? []).map((answer) => JSON.parse(String(answer)));
    assert.equal(good.ok, true, JSON.stringify(good));
    assert.equal(good.id, "sketch");
    assert.equal(good.name, "Sketch");
    assert.ok(good.tools.includes("build"), "its tools");
    assert.ok(good.skills.includes("sketch"), "its skills");
    for (const section of TAUGHT) assert.ok(good.sections.includes(section), `its ${section}`);
    assertScanQuiet(good.scan);
    assert.match(good.next, /Load local plugin…, choose genex-plugins\/sketch\. It starts off/);
    assert.equal(refused.length, hostile.length);
    refused.forEach((answer, index) => {
      const label = JSON.stringify(hostile[index]);
      assert.equal(answer.ok, false, label);
      assert.equal(typeof answer.problem, "string", label);
      assert.ok(!answer.problem.includes(root), `${label}: names no folder outside the project: ${answer.problem}`);
    });

    assert.deepEqual(pluginsNow(), before.plugins, "no plugin was installed, removed or turned on");
    assert.equal(lite.core.plugins.enabled("sketch"), false);
    assert.deepEqual(await tree(gameDir), before.game, "nothing in the game changed");
    assert.deepEqual(await tree(outside), before.outside, "nor outside it");
    assert.deepEqual(await tree(pluginData), installed, "nor among the plugins Genex installed");
    await lite.core.setPermissionMode(threadId, PermissionMode.Auto);

    // A builder in a worktree is never handed it.
    const worktree = path.join(lite.core.layout.scratch, "worktrees", `${game.name}-part`);
    await mkdir(worktree, { recursive: true });
    calls.length = 0;
    await lite.api()["engine.delegate"]({ engine: ENGINE, project: game.name, threadId, prompt: "x", cwd: worktree });
    assert.equal(sessions.at(-1)?.tools.includes(ProjectTool.PluginCheck), false, "a builder");
  });
});

describe("plugins_find, the harness's", () => {
  it("the local model's plugins_find never names plugin_check", async () => {
    const root = await realpath(await tmpDir("studio-plugins-find-local-"));
    const lite = await coreLite({
      gamesRoot: path.join(root, "games"),
      executionPolicy: { allowedProjectRoot: root, runBackgroundImprovement: false },
    });
    try {
      assert.equal(lite.core.plugins.enabled(GENEX_PLUGIN_ID), true, "the Genex plugin is on");
      // A kind no bundled plugin knows (Godot's and Unity's now have one each).
      const answer = await lite.api()[HostMethod.PluginsFind]({ fact: "gamemaker-project" });
      assert.equal(answer.next, FindNext.WritePlugin);
      assert.match(answer.note, /plugin-author/, "it learns where the guide is");
      assert.doesNotMatch(answer.note, /plugin_check/, "and is never told to call a tool it doesn't have");
    } finally {
      lite.core.plugins.cancel();
      await lite.close();
    }
  });
});

describe("plugins_find, when nothing fits", () => {
  const listed = (enabled: boolean, removed = false) => [{ manifest: GENEX_MANIFEST, enabled, removed }];

  it("plugins_find's write-a-plugin answer names the guide, and says how to get it when the Genex plugin is off", () => {
    const on = findPlugins(listed(true), [], { fact: "godot-project" }, true);
    assert.equal(on.next, FindNext.WritePlugin);
    assert.match(on.note, /genex__skill/);
    assert.match(on.note, /plugin-author/);
    assert.match(on.note, /plugin_check/);
    assert.match(on.note, /tell the person how to load it/);
    const unchecked = findPlugins(listed(true), [], { fact: "godot-project" });
    assert.match(unchecked.note, /plugin-author/, "a session with no plugin_check still learns how to write one");
    assert.doesNotMatch(unchecked.note, /plugin_check/, "and is never told to call a tool it doesn't have");
    assert.match(unchecked.note, /the chat/, "it hands the check to the chat");

    for (const [label, installed] of [
      ["off", listed(false)],
      ["removed", listed(true, true)],
      ["not installed", []],
    ] as const) {
      const off = findPlugins(installed, [], { fact: "godot-project" });
      assert.equal(off.next, FindNext.WritePlugin, label);
      assert.match(off.note, /comes with the Genex plugin, which is off/, label);
      assert.match(off.note, new RegExp(`plugins_suggest[^.]*${GENEX_PLUGIN_ID}`), label);
      assert.doesNotMatch(off.note, /genex__skill/, `${label}: no reader it can't call`);
    }
  });
});
