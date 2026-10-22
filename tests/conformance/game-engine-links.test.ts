/**
 * A `game-engine` plugin links a game to an engine project through the host: the host checks the
 * project file by real path, keeps the link in the plugin's storage (`links/<game>.json`, which its
 * MCP servers read to route calls and agents can't write), mirrors it into the game's studio.json,
 * and tells the chat it came from, with Undo. A refused link changes nothing on disk.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { CustomEvent, type CustomEventRecord, customEvent } from "../../src/shared/custom-events.ts";
import { GameEngine } from "../../src/shared/game-engine.ts";
import { ENGINE_LINKS_FOLDER, type PluginBinding, PluginSourceKind } from "../../src/shared/plugins.ts";
import { FactSource } from "../../src/shared/project-facts.ts";
import { UiEvent } from "../../src/shared/ui-events.ts";
import { readEngineBinding } from "../../src/substrate/game-engine-binding.ts";
import { createEngineLinks, EngineLinkStale } from "../../src/substrate/plugins/engine-links.ts";
import { copyOfExample as copyOf, pluginFixture } from "../helpers/plugins.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { ENGINES, TOY_ENGINE } from "../helpers/engines.ts";
import { TOY_PLUGIN } from "../helpers/project-fixtures.ts";
import { tmpDir } from "../helpers/tmp.ts";

const PLUGIN = "unreal";
const NOW = () => new Date("2026-10-04T12:00:00.000Z");
const LATER = () => new Date("2026-10-04T12:05:00.000Z");

/** How a test's host takes back a link's set-up: records the call, or refuses as the plugin would. */
type UndoSetUp = (pluginId: string, game: string, project: string) => Promise<void>;

async function world(
  now = NOW,
  { failAppend = false, undoSetUp }: { failAppend?: boolean; undoSetUp?: UndoSetUp } = {},
) {
  const root = await realpath(await tmpDir("studio-engine-links-"));
  const games = path.join(root, "games");
  const storage = path.join(root, "plugins", PLUGIN);
  const projects = path.join(root, "Unreal Projects");
  await mkdir(storage, { recursive: true });
  const makeGame = async (id: string) => {
    const dir = path.join(games, id);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "studio.json"), `${JSON.stringify({ name: id, title: id }, null, 2)}\n`);
    return dir;
  };
  const makeProject = async (name: string) => {
    const dir = path.join(projects, name);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, `${name}.uproject`);
    await writeFile(file, '{"FileVersion":3}\n');
    return file;
  };
  const appended: Array<{ record: CustomEventRecord; threadId: string }> = [];
  const changed: string[] = [];
  let clock = now;
  const links = createEngineLinks({
    root: (id) => path.join(root, "plugins", id),
    gameDir: (project) => path.join(games, project),
    append: async (record, threadId) => {
      if (failAppend) throw new Error("the chat could not be written");
      appended.push({ record, threadId });
    },
    changed: (project) => changed.push(project),
    gameThread: async (project) => `thread-of-${project}`,
    now: () => clock(),
    catalog: () => ENGINES,
    ...(undoSetUp ? { undoSetUp } : {}),
  });
  const binding = (project: string, threadId?: string): PluginBinding => ({
    project,
    directory: path.join(games, project),
    ...(threadId ? { threadId } : {}),
  });
  return {
    root,
    storage,
    links,
    binding,
    makeGame,
    makeProject,
    appended,
    changed,
    tick: (next: () => Date) => {
      clock = next;
    },
  };
}

/** Every file under `dir`, with its text, so a refused call can be shown to change nothing. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (at: string) => {
    for (const entry of await readdir(at, { withFileTypes: true }).catch(() => [])) {
      const file = path.join(at, entry.name);
      if (entry.isDirectory()) await walk(file);
      else out[path.relative(dir, file)] = await readFile(file, "utf8").catch(() => "<link>");
    }
  };
  await walk(dir);
  return out;
}

const envelope = (record: CustomEventRecord) => ({ data: record });

test("a link records the real project in the plugin's storage and studio.json, and tells the chat", async () => {
  const w = await world();
  const game = await w.makeGame("valley");
  const project = await w.makeProject("Valley");
  const linked = await w.links.link(PLUGIN, w.binding("valley", "t1"), { project });
  assert.deepEqual(linked, {
    kind: GameEngine.Unreal,
    project,
    name: "Valley",
    linkedAt: NOW().toISOString(),
  });
  assert.equal((await readEngineBinding(game, ENGINES))?.project, project);
  const record = JSON.parse(await readFile(path.join(w.storage, ENGINE_LINKS_FOLDER, "valley.json"), "utf8"));
  assert.equal(record.project, project);
  assert.equal(record.kind, GameEngine.Unreal);
  assert.deepEqual(await w.links.read(PLUGIN, w.binding("valley")), linked);
  assert.deepEqual(w.changed, ["valley"]);
  assert.equal(w.appended.length, 1);
  assert.equal(w.appended[0].threadId, "t1");
  const payload = customEvent(envelope(w.appended[0].record), CustomEvent.EngineLinked);
  assert.equal(payload?.name, "Valley");
  assert.equal(payload?.title, "valley", "the game's title from its studio.json");
  assert.equal(payload?.project, "valley");
  assert.equal(payload?.file, project);
  assert.equal(payload?.pluginId, PLUGIN);
  assert.equal(payload?.previous, undefined);
});

test("linking the project a game already uses changes nothing and says nothing", async () => {
  const w = await world();
  await w.makeGame("valley");
  const project = await w.makeProject("Valley");
  const first = await w.links.link(PLUGIN, w.binding("valley", "t1"), { project, auto: true });
  w.tick(LATER);
  const again = await w.links.link(PLUGIN, w.binding("valley", "t1"), { project });
  assert.deepEqual(again, first);
  assert.equal(w.appended.length, 1);
  assert.equal(customEvent(envelope(w.appended[0].record), CustomEvent.EngineLinked)?.auto, true);
});

test("a game with no link reads none; a link made outside a chat (the panel) tells the game's own chat", async () => {
  const w = await world();
  await w.makeGame("valley");
  const project = await w.makeProject("Valley");
  assert.equal(await w.links.read(PLUGIN, w.binding("valley")), null);
  await w.links.link(PLUGIN, w.binding("valley"), { project });
  assert.deepEqual(
    w.appended.map((a) => [a.threadId, customEvent(envelope(a.record), CustomEvent.EngineLinked)?.name]),
    [["thread-of-valley", "Valley"]],
  );
});

test("hostile games and project files are refused and change nothing on disk", async () => {
  const w = await world();
  await w.makeGame("valley");
  const project = await w.makeProject("Valley");
  const notes = path.join(w.root, "notes.txt");
  await writeFile(notes, "hi");
  const fake = path.join(w.root, "Fake.uproject");
  await symlink(notes, fake);
  const folder = path.join(w.root, "Folder.uproject");
  await mkdir(folder);
  const before = await snapshot(w.root);
  const cases: Array<[string, PluginBinding | undefined, unknown]> = [
    ["no game", undefined, { project }],
    ["dot-dot game", w.binding("../valley"), { project }],
    ["slashed game", w.binding("a/b"), { project }],
    ["empty game", w.binding(""), { project }],
    ["long game", w.binding("g".repeat(101)), { project }],
    ["no project", w.binding("valley"), {}],
    ["number project", w.binding("valley"), { project: 7 }],
    ["relative project", w.binding("valley"), { project: "Valley/Valley.uproject" }],
    ["dot-dot project", w.binding("valley"), { project: `${path.dirname(project)}/../Valley/Valley.uproject` }],
    ["missing project", w.binding("valley"), { project: path.join(w.root, "Gone.uproject") }],
    ["link to a text file", w.binding("valley"), { project: fake }],
    ["a folder", w.binding("valley"), { project: folder }],
    ["not a project", w.binding("valley"), { project: notes }],
    ["control characters", w.binding("valley"), { project: `${w.root}/Bad\nName.uproject` }],
  ];
  for (const [label, binding, args] of cases) {
    await assert.rejects(w.links.link(PLUGIN, binding, args), Error, label);
    assert.deepEqual(await snapshot(w.root), before, `${label}: nothing changed`);
  }
  assert.equal(w.appended.length, 0);
  assert.deepEqual(w.changed, []);
});

test("Undo puts back the project a link replaced, in studio.json and in the plugin's record", async () => {
  const w = await world();
  const game = await w.makeGame("valley");
  const first = await w.makeProject("Valley");
  const second = await w.makeProject("Mist");
  const a = await w.links.link(PLUGIN, w.binding("valley", "t1"), { project: first });
  w.tick(LATER);
  const b = await w.links.link(PLUGIN, w.binding("valley", "t1"), { project: second });
  assert.equal(customEvent(envelope(w.appended[1].record), CustomEvent.EngineLinked)?.previous, "Valley");

  await w.links.undo(PLUGIN, "valley", b.linkedAt, "t1");
  assert.equal((await readEngineBinding(game, ENGINES))?.project, first);
  assert.deepEqual(await w.links.read(PLUGIN, w.binding("valley")), a);
  const undone = customEvent(envelope(w.appended[2].record), CustomEvent.EngineLinkUndone);
  assert.equal(undone?.linkedAt, b.linkedAt);
  assert.equal(undone?.restored, "Valley");
});

test("Undo of a game's first link leaves it with no link", async () => {
  const w = await world();
  const game = await w.makeGame("valley");
  const project = await w.makeProject("Valley");
  const linked = await w.links.link(PLUGIN, w.binding("valley", "t1"), { project, auto: true });
  await w.links.undo(PLUGIN, "valley", linked.linkedAt, "t1");
  assert.equal(await readEngineBinding(game, ENGINES), undefined);
  assert.equal(await w.links.read(PLUGIN, w.binding("valley")), null);
  const studio = JSON.parse(await readFile(path.join(game, "studio.json"), "utf8"));
  assert.equal(studio.engine, undefined);
  assert.equal(studio.title, "valley");
});

test("a stale Undo, for a link that already changed, is refused and changes nothing", async () => {
  const w = await world();
  await w.makeGame("valley");
  const first = await w.makeProject("Valley");
  const second = await w.makeProject("Mist");
  const a = await w.links.link(PLUGIN, w.binding("valley", "t1"), { project: first });
  w.tick(LATER);
  await w.links.link(PLUGIN, w.binding("valley", "t1"), { project: second });
  const before = await snapshot(w.root);
  await assert.rejects(w.links.undo(PLUGIN, "valley", a.linkedAt, "t1"), EngineLinkStale);
  await assert.rejects(w.links.undo(PLUGIN, "other", a.linkedAt, "t1"), EngineLinkStale);
  await assert.rejects(w.links.undo(PLUGIN, "../valley", a.linkedAt, "t1"));
  assert.deepEqual(await snapshot(w.root), before);
});

test("a link that also set its project up says so, and its Undo takes the set-up back before the link", async () => {
  const asked: Array<{ call: [string, string, string]; linkedThen: string | undefined }> = [];
  const games: { dir?: string } = {};
  const w = await world(NOW, {
    undoSetUp: async (...call) => {
      asked.push({ call, linkedThen: (await readEngineBinding(games.dir ?? "", ENGINES))?.project });
    },
  });
  games.dir = await w.makeGame("valley");
  const project = await w.makeProject("Valley");
  const linked = await w.links.link(PLUGIN, w.binding("valley", "t1"), { project, setUp: true });
  assert.equal(customEvent(envelope(w.appended[0].record), CustomEvent.EngineLinked)?.setUp, true);

  await w.links.undo(PLUGIN, "valley", linked.linkedAt, "t1");
  assert.deepEqual(asked, [{ call: [PLUGIN, "valley", project], linkedThen: project }], "set-up first, link still on");
  assert.equal(await readEngineBinding(games.dir, ENGINES), undefined);
  const undone = customEvent(envelope(w.appended[1].record), CustomEvent.EngineLinkUndone);
  assert.equal(undone?.setUpUndone, "Valley");
});

test("Undo of a set-up link whose set-up is refused keeps the link, changes nothing and says why", async () => {
  const w = await world(NOW, {
    undoSetUp: async () => {
      throw new Error("Quit Unreal Editor first. It rewrites the project's settings when it closes.");
    },
  });
  const game = await w.makeGame("valley");
  const project = await w.makeProject("Valley");
  const linked = await w.links.link(PLUGIN, w.binding("valley", "t1"), { project, setUp: true });
  const before = await snapshot(w.root);
  await assert.rejects(w.links.undo(PLUGIN, "valley", linked.linkedAt, "t1"), /Quit Unreal Editor first/);
  assert.deepEqual(await snapshot(w.root), before);
  assert.equal((await readEngineBinding(game, ENGINES))?.project, project);
  assert.equal(w.appended.length, 1, "no undone line");
});

test("a link without set-up never asks for one back; one that set up the project a game uses is a new link", async () => {
  const asked: string[] = [];
  const w = await world(NOW, { undoSetUp: async (_id, _game, project) => void asked.push(project) });
  const game = await w.makeGame("valley");
  const project = await w.makeProject("Valley");
  const plain = await w.links.link(PLUGIN, w.binding("valley", "t1"), { project });
  w.tick(LATER);
  const setUp = await w.links.link(PLUGIN, w.binding("valley", "t1"), { project, setUp: true });
  assert.notEqual(setUp.linkedAt, plain.linkedAt, "the set-up gets its own line and Undo");
  await w.links.undo(PLUGIN, "valley", setUp.linkedAt, "t1");
  assert.deepEqual(asked, [project]);
  assert.equal((await readEngineBinding(game, ENGINES))?.project, project, "the game keeps the project it used");
  const restored = await w.links.read(PLUGIN, w.binding("valley"));
  assert.ok(restored);
  await w.links.undo(PLUGIN, "valley", restored.linkedAt, "t1");
  assert.deepEqual(asked, [project], "the earlier link set nothing up");
});

test("Undo of a set-up link keeps the set-up while another game's link names the project, and says only the link went", async () => {
  const asked: string[] = [];
  const w = await world(NOW, { undoSetUp: async (_id, _game, project) => void asked.push(project) });
  const valley = await w.makeGame("valley");
  const lantern = await w.makeGame("lantern");
  const project = await w.makeProject("Valley");
  const setUp = await w.links.link(PLUGIN, w.binding("valley", "t1"), { project, setUp: true });
  await w.links.link(PLUGIN, w.binding("lantern", "t2"), { project });
  await w.links.undo(PLUGIN, "valley", setUp.linkedAt, "t1");
  assert.deepEqual(asked, [], "the other game still builds in it");
  assert.equal(await readEngineBinding(valley, ENGINES), undefined, "the link itself is undone");
  assert.equal((await readEngineBinding(lantern, ENGINES))?.project, project);
  const undone = customEvent(envelope(w.appended[2].record), CustomEvent.EngineLinkUndone);
  assert.equal(undone?.setUpUndone, undefined, "the line never says the set-up went");
  assert.equal(undone?.setUpKept, "Valley", "it says the set-up stays");
});

test("Undo of a set-up link takes the set-up back once no other game's current link names the project", async () => {
  const asked: string[] = [];
  const w = await world(NOW, { undoSetUp: async (_id, _game, project) => void asked.push(project) });
  await w.makeGame("valley");
  await w.makeGame("lantern");
  const project = await w.makeProject("Valley");
  const setUp = await w.links.link(PLUGIN, w.binding("valley", "t1"), { project, setUp: true });
  await w.links.link(PLUGIN, w.binding("lantern", "t2"), { project });
  w.tick(LATER);
  await w.links.link(PLUGIN, w.binding("lantern", "t2"), { project: await w.makeProject("Mist") });
  await w.links.undo(PLUGIN, "valley", setUp.linkedAt, "t1");
  assert.deepEqual(asked, [project], "a link another game replaced is no longer its");
});

test("the studio's Undo of a set-up link runs the plugin's undo-setup first, with no question", async () => {
  const lite = await coreLite();
  try {
    const { core } = lite;
    const made = (await core.pluginServices.call(PLUGIN, "game.create", { title: "Seyda Neen" })) as {
      project: string;
      directory: string;
    };
    const file = path.join(made.directory, "unreal", "SeydaNeen.uproject");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{"FileVersion":3}\n');
    const asked: unknown[][] = [];
    const refusal: { message?: string } = { message: "Quit Unreal Editor first." };
    core.plugins.action = async (...call: unknown[]) => {
      asked.push(call.slice(0, 3));
      if (refusal.message) throw new Error(refusal.message);
      return null;
    };
    const link = (await core.pluginServices.call(PLUGIN, "game.engine.link", {
      project: file,
      game: made.project,
      setUp: true,
    })) as { linkedAt: string };
    const request = { project: made.project, pluginId: PLUGIN, linkedAt: link.linkedAt };
    await assert.rejects(core.undoEngineLink(request), /Quit Unreal Editor first/);
    const real = await realpath(file);
    assert.equal((await readEngineBinding(made.directory, ENGINES))?.project, real, "the link stays");
    delete refusal.message;
    await core.undoEngineLink(request);
    const undoSetUp = [PLUGIN, "undo-setup", { project: real, ifSetUp: true }];
    assert.deepEqual(asked, [undoSetUp, undoSetUp]);
    assert.equal(await readEngineBinding(made.directory, ENGINES), undefined);
  } finally {
    await lite.close();
  }
});

test("a link stops holding when its project file is swapped for a link", async () => {
  const w = await world();
  await w.makeGame("valley");
  const project = await w.makeProject("Valley");
  await w.links.link(PLUGIN, w.binding("valley"), { project });
  const elsewhere = path.join(w.root, "Elsewhere.uproject");
  await writeFile(elsewhere, "{}");
  const { rename } = await import("node:fs/promises");
  await rename(project, `${project}.bak`);
  await symlink(elsewhere, project);
  assert.equal(await w.links.read(PLUGIN, w.binding("valley")), null);
});

test("game.engine services are gated by the game-engine capability and need a game", async () => {
  const f = await pluginFixture({ installed: "local" });
  try {
    const dir = await copyOf(f.root, "engine-plugin");
    await writeFile(
      path.join(dir, "backend.mjs"),
      "export async function activate(){return {tool(n,a,c){return c.host('game.engine.read',{})}}}",
    );
    await f.registry.installLocal(dir);
    await assert.rejects(f.registry.tool("example__greet", { name: "Ada" }, f.binding), /capability denied/);
    const m = JSON.parse(await readFile(path.join(dir, "plugin.json"), "utf8"));
    m.capabilities.push("game-engine");
    await writeFile(path.join(dir, "plugin.json"), JSON.stringify(m));
    await f.registry.installLocal(dir, "local", m.capabilities);
    await assert.rejects(f.registry.tool("example__greet", { name: "Ada" }, f.binding), /Engine links unavailable/);
    const seen: unknown[] = [];
    f.services.engineLinks = {
      link: async () => {
        throw new Error("not used");
      },
      read: async (id, binding) => {
        seen.push([id, binding]);
        return null;
      },
      steps: async () => false,
    };
    assert.equal(await f.registry.tool("example__greet", { name: "Ada" }, f.binding), null);
    assert.deepEqual(seen, [["example", f.binding]]);
    await assert.rejects(f.services.call("example", "game.engine.read", {}), /Project required/);
  } finally {
    await f.close();
  }
});

test("game.create makes a game for the plugin that only it may then link, and a hostile title makes none", async () => {
  const f = await pluginFixture({ installed: "local" });
  try {
    const made: string[] = [];
    const linked: Array<[string, string | undefined, unknown]> = [];
    f.services.gameCreate = async (title) => {
      made.push(title);
      return { project: "lantern-path", directory: "/games/lantern-path" };
    };
    f.services.engineLinks = {
      link: async (id, binding, args) => {
        linked.push([id, binding?.project, args]);
        return { kind: GameEngine.Unreal, project: "/p/Lantern.uproject", linkedAt: "", name: "Lantern" } as never;
      },
      read: async () => null,
      steps: async () => false,
    };
    for (const title of ["", "   ", "a".repeat(81), "bell\u0007", "line\nbreak", 42, undefined])
      await assert.rejects(f.services.call("unreal", "game.create", { title }), /title/, JSON.stringify(title));
    assert.deepEqual(made, [], "a refused title makes no game");

    assert.deepEqual(await f.services.call("unreal", "game.create", { title: " Lantern Path " }), {
      project: "lantern-path",
      directory: "/games/lantern-path",
    });
    assert.deepEqual(made, ["Lantern Path"]);
    const panel: PluginBinding | undefined = undefined;
    await f.services.call(
      "unreal",
      "game.engine.link",
      { project: "/p/Lantern.uproject", game: "lantern-path" },
      panel,
    );
    assert.deepEqual(
      linked.map(([id, game]) => [id, game]),
      [["unreal", "lantern-path"]],
    );

    const refused: Array<[string, Record<string, unknown>, PluginBinding | undefined]> = [
      ["a game it never made", { project: "/p/A.uproject", game: "someone-elses" }, undefined],
      ["another plugin's game", { project: "/p/A.uproject", game: "lantern-path" }, undefined],
      ["a game that isn't a name", { project: "/p/A.uproject", game: 7 }, undefined],
      ["a game beside another bound one", { project: "/p/A.uproject", game: "lantern-path" }, f.binding],
    ];
    for (const [label, args, binding] of refused) {
      const plugin = label === "another plugin's game" ? "example" : "unreal";
      await assert.rejects(f.services.call(plugin, "game.engine.link", args, binding), label);
    }
    assert.equal(linked.length, 1, "no refused link reached the links");
  } finally {
    await f.close();
  }
});

test("the studio makes the game game.create asks for, and links the project its plugin made into it", async () => {
  const lite = await coreLite();
  try {
    const { core } = lite;
    const made = (await core.pluginServices.call("unreal", "game.create", { title: "Lantern Path" })) as {
      project: string;
      directory: string;
    };
    const game = (await core.games.list()).find((g) => g.name === made.project);
    assert.equal(game?.title, "Lantern Path");
    assert.equal(await realpath(made.directory), await realpath(game?.dir ?? ""));
    const file = path.join(made.directory, "unreal", "LanternPath.uproject");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{"FileVersion":3}\n');
    await core.pluginServices.call("unreal", "game.engine.link", { project: file, game: made.project });
    const binding = await readEngineBinding(made.directory, ENGINES);
    assert.equal(binding?.project, await realpath(file));
  } finally {
    await lite.close();
  }
});

test("game.engine.runs names each game whose run is going, with the project this plugin linked it to, and only those", async () => {
  const f = await pluginFixture({ installed: "local" });
  try {
    await assert.rejects(f.services.call("unreal", "game.engine.runs", {}), /Runs unavailable/);
    f.services.runningGames = async () => [
      { project: "dirt-track", directory: "/games/dirt-track", title: "Dirt Track" },
      { project: "web-toy", directory: "/games/web-toy", title: "Web Toy" },
    ];
    const asked: Array<[string, string | undefined]> = [];
    f.services.engineLinks = {
      link: async () => {
        throw new Error("not used");
      },
      read: async (id, binding) => {
        asked.push([id, binding?.project]);
        if (id !== "unreal" || binding?.project !== "dirt-track") return null;
        return { project: "/p/DirtTrack.uproject", linkedAt: "", name: "DirtTrack" } as never;
      },
      steps: async () => false,
    };
    assert.deepEqual(await f.services.call("unreal", "game.engine.runs", {}), [
      { game: "dirt-track", title: "Dirt Track", project: "/p/DirtTrack.uproject" },
    ]);
    assert.deepEqual(
      await f.services.call("example", "game.engine.runs", {}),
      [],
      "another plugin's links are its own",
    );
    assert.deepEqual(asked, [
      ["unreal", "dirt-track"],
      ["unreal", "web-toy"],
      ["example", "dirt-track"],
      ["example", "web-toy"],
    ]);
  } finally {
    await f.close();
  }
});

test("the studio answers game.engine.runs with no game while no run is going", async () => {
  const lite = await coreLite();
  try {
    assert.deepEqual(await lite.core.pluginServices.call("unreal", "game.engine.runs", {}), []);
  } finally {
    await lite.close();
  }
});

test("the studio names each game whose run it holds awake and still runs, with the project its plugin linked it to", async () => {
  const lite = await coreLite();
  try {
    const { core } = lite;
    const projects = await realpath(await tmpDir("studio-engine-runs-uproject-"));
    const linked = async (game: string) => {
      const made = await core.games.scaffold(game);
      const file = path.join(projects, game, `${game}.uproject`);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, '{"FileVersion":3}\n');
      await core.engineLinks.link(PLUGIN, { project: game, directory: made.dir }, { project: file });
      return file;
    };
    const valley = await linked("valley");
    await linked("done");
    await linked("quiet");
    await core.games.scaffold("plain");
    const record = async (game: string, eventType: string, runId: string) =>
      core.append(
        [{ type: "custom", event_type: eventType, payload: { runId, project: game, goal: "a dirt track" } }],
        await core.threadForGame(game),
      );
    await record("valley", CustomEvent.RunStarted, "run_valley");
    await record("plain", CustomEvent.RunStarted, "run_plain");
    await record("done", CustomEvent.RunStarted, "run_done");
    await record("done", CustomEvent.RunFinished, "run_done");
    await record("quiet", CustomEvent.RunStarted, "run_quiet");
    // The harness holds the studio awake for every run but `quiet`'s; `done`'s finished while held.
    for (const runId of ["run_valley", "run_plain", "run_done"])
      core.host.options.onNotify?.(UiEvent.RunKeepawake, { runId });
    const runs = (await core.pluginServices.call(PLUGIN, "game.engine.runs", {})) as Array<Record<string, string>>;
    assert.deepEqual(
      runs.map(({ game, project }) => [game, project]),
      [["valley", valley]],
      "a web game's run, a finished run and a run the harness no longer holds are not named",
    );
    assert.equal(typeof runs[0]?.title, "string");
    core.host.options.onNotify?.(UiEvent.RunSettled, { runId: "run_valley" });
    assert.deepEqual(await core.pluginServices.call(PLUGIN, "game.engine.runs", {}), [], "settled: nothing going");
  } finally {
    await lite.close();
  }
});

test("a link whose chat line can't be written takes back both its records: the game is linked as before", async () => {
  for (const linkedBefore of [false, true]) {
    const w = await world(NOW, { failAppend: true });
    await w.makeGame("valley");
    const earlier = await w.makeProject("Earlier");
    const project = await w.makeProject("Valley");
    if (linkedBefore) {
      // The same storage and games: an earlier link made while the chat could be written.
      const links = createEngineLinks({
        root: (id) => path.join(w.root, "plugins", id),
        gameDir: (id) => path.join(w.root, "games", id),
        append: async () => {},
        changed: () => {},
        gameThread: async (id) => `thread-of-${id}`,
        now: NOW,
        catalog: () => ENGINES,
      });
      await links.link(PLUGIN, w.binding("valley"), { project: earlier });
    }
    const before = await snapshot(w.root);
    await assert.rejects(
      w.links.link(PLUGIN, w.binding("valley", "t1"), { project }),
      /the chat could not be written/,
      `linked before: ${linkedBefore}`,
    );
    assert.deepEqual(await snapshot(w.root), before, `linked before: ${linkedBefore}`);
    assert.deepEqual(w.changed, []);
  }
});

const TOY = "toy-engine";

/** A toy-engine project file under the world's root. */
async function makeToy(root: string, name: string): Promise<string> {
  const dir = path.join(root, "Toy Projects", name);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}.toyproj`);
  await writeFile(file, "toy\n");
  return file;
}

test("any engine plugin links like Unreal: the record and the chat line name its engine and label", async () => {
  const w = await world();
  const game = await w.makeGame("garden");
  const project = await makeToy(w.root, "Garden");
  const linked = await w.links.link(TOY, w.binding("garden", "t1"), { project });
  assert.deepEqual(linked, { kind: TOY, project, name: "Garden", linkedAt: NOW().toISOString() });
  const studio = JSON.parse(await readFile(path.join(game, "studio.json"), "utf8"));
  assert.equal(studio.engine.kind, TOY);
  assert.deepEqual(await w.links.read(TOY, w.binding("garden")), linked);
  const payload = customEvent(envelope(w.appended[0].record), CustomEvent.EngineLinked);
  assert.equal(payload?.engine, TOY);
  assert.equal(payload?.label, "Toy");
  assert.equal(payload?.name, "Garden");
});

test("a link keeps a published game's ids; new ids rewrite it, and ids of a bad shape are dropped", async () => {
  const w = await world();
  await w.makeGame("garden");
  const project = await makeToy(w.root, "Garden");
  const remote = { placeId: "1818", universeId: "2929" };
  const first = await w.links.link(TOY, w.binding("garden", "t1"), { project, remote });
  assert.deepEqual(first.remote, remote);
  const again = await w.links.link(TOY, w.binding("garden", "t1"), { project, remote: { ...remote } });
  assert.deepEqual(again, first, "the same ids: nothing changes");
  assert.equal(w.appended.length, 1);

  w.tick(LATER);
  const moved = { placeId: "3030", universeId: "2929" };
  const rewritten = await w.links.link(TOY, w.binding("garden", "t1"), { project, remote: moved });
  assert.deepEqual(rewritten.remote, moved);
  assert.equal(rewritten.linkedAt, LATER().toISOString());
  const record = JSON.parse(
    await readFile(path.join(w.root, "plugins", TOY, ENGINE_LINKS_FOLDER, "garden.json"), "utf8"),
  );
  assert.deepEqual(record.remote, moved);
  assert.deepEqual((await readEngineBinding(path.join(w.root, "games", "garden"), ENGINES))?.remote, moved);

  for (const bad of [
    1818,
    { placeId: "0", universeId: "2929" },
    { placeId: "1".repeat(21), universeId: "2929" },
    {
      placeId: "18x",
      universeId: "2929",
    },
  ]) {
    const other = await w.makeGame("plain");
    const made = await w.links.link(TOY, w.binding("plain"), { project, remote: bad });
    assert.equal(made.project, project, `${JSON.stringify(bad)}: the link stays`);
    assert.equal(made.remote, undefined, `${JSON.stringify(bad)}: the ids are dropped`);
    assert.equal((await readEngineBinding(other, ENGINES))?.remote, undefined);
    await w.links.undo(TOY, "plain", made.linkedAt);
  }
});

test("a link may name its project as people know it: the chat line says that name, else the file's", async () => {
  const w = await world();
  await w.makeGame("garden");
  const project = await makeToy(w.root, "Garden");
  const named = await w.links.link(TOY, w.binding("garden", "t1"), { project, name: "Front Yard" });
  assert.equal(named.name, "Front Yard");
  assert.equal(customEvent(envelope(w.appended[0].record), CustomEvent.EngineLinked)?.name, "Front Yard");
  for (const bad of ["", " ", "two\nlines", "x".repeat(81), 7, null]) {
    await w.makeGame("plain");
    const made = await w.links.link(TOY, w.binding("plain", "t2"), { project, name: bad });
    assert.equal(made.name, "Garden", `${JSON.stringify(bad)}: the file's name`);
    const last = w.appended.at(-1);
    assert.ok(last, "the link is told in the chat");
    const line = customEvent(envelope(last.record), CustomEvent.EngineLinked);
    assert.equal(line?.name, "Garden", `${JSON.stringify(bad)}: the chat line names the file`);
    await w.links.undo(TOY, "plain", made.linkedAt);
  }
});

test("a plugin that declares no engine can't link a game, and nothing changes", async () => {
  const w = await world();
  await w.makeGame("garden");
  const project = await makeToy(w.root, "Garden");
  const uproject = await w.makeProject("Valley");
  const before = await snapshot(w.root);
  await assert.rejects(w.links.link("blender", w.binding("garden", "t1"), { project }), /declares no engine/);
  await assert.rejects(w.links.link(TOY, w.binding("garden", "t1"), { project: uproject }), /not a Toy project file/);
  assert.deepEqual(await snapshot(w.root), before);
  assert.equal(w.appended.length, 0);
});

test("a game linked by an engine plugin that is turned off still builds in that engine", async () => {
  const lite = await coreLite();
  try {
    const { core } = lite;
    await core.plugins.installLocal(TOY_PLUGIN, PluginSourceKind.Local, []);
    assert.equal(core.plugins.enabled(TOY), false, "a local plugin starts off");
    const made = await core.games.scaffold("garden");
    const projects = await realpath(await tmpDir("studio-toy-link-"));
    const project = await makeToy(projects, "Garden");
    await core.engineLinks.link(TOY, { project: made.name, directory: made.dir }, { project });
    const game = (await core.games.list()).find((g) => g.name === made.name);
    assert.equal(game?.engine?.kind, TOY);
    assert.deepEqual(
      game?.facts?.map(({ id, source }) => [id, source]),
      [["toy-project", FactSource.Link]],
      "the toy engine's fact, not Unreal's",
    );
    // What the app reads of its engine (the Loop's gate, Rewind's note) comes with the game, as declared.
    const { label, projectFiles, projectInFolder } = TOY_ENGINE;
    assert.deepEqual(game?.linkedEngine, { label, projectFiles, projectInFolder });
    const web = await core.games.scaffold("pond");
    assert.equal((await core.games.list()).find((g) => g.name === web.name)?.linkedEngine, undefined, "a web game");
  } finally {
    lite.core.plugins.cancel();
    await lite.close();
  }
});
