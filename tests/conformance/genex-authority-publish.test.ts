/**
 * A server-authoritative game published from Studio deployed without its room module, so every
 * player's join was refused (424): the game's `authority` block never reached the publish copy,
 * the copy had no `server/` for the CLI to bundle, and no `@genex-ai/authority-dev` to bundle it
 * with (`toolchain_missing`).
 *
 * Now the block rides along as the game wrote it, the export stages the room (its `server/` and
 * every file it imports) beside the public copy, never in it, and the copy links the pinned
 * toolchain from the Genex plugin's payload. A game with no room block gets none of it.
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { lstat, mkdir, readdir, readFile, readlink, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { GenexRoomService } from "../../src/main/core/genex-room.ts";
import { linkAuthorityToolchain } from "../../src/plugins/genex/authority-toolchain.ts";
import { authorityDevDir } from "../../src/plugins/genex/cli.ts";
import { workspaceManifest } from "../../src/plugins/genex/publish.ts";
import { AUTHORITY_DEV_PACKAGE, GENEX_STUDIO_TOOLS, type GenexGameManifest } from "../../src/shared/genex.ts";
import { ExportRefusal } from "../../src/shared/game-library.ts";
import { PluginService } from "../../src/shared/plugins.ts";
import { genexGameManifest, readGenexGameManifest } from "../../src/substrate/genex-game-manifest.ts";
import { clearStagedRoom, stageRoom } from "../../src/substrate/genex-room-stage.ts";
import { PluginServices } from "../../src/substrate/plugins/services.ts";
import { tmpDir } from "../helpers/tmp.ts";

const ROOM = { module: "server/room.js", tickHz: 30, maxPlayers: 4 };
/** A room module as a template game writes one: plain JavaScript, sharing a file in `src/`. */
const ROOM_JS = [
  'import { SPEED } from "../src/world.js";',
  "export default {",
  "  contract: 1,",
  '  config: { tickHz: 30, maxPlayers: 4, preset: { name: "topdown" } },',
  "  init: () => ({ joins: 0 }),",
  '  onJoin(ctx, player) { ctx.state.joins += SPEED > 0 ? 1 : 0; ctx.entities.spawn({ kind: "player", owner: player.id, hp: 3 }); },',
  "  onLeave(ctx, player) { const me = ctx.entities.ownedBy(player.id); if (me) ctx.entities.remove(me.id); },",
  "  onInput() {},",
  "  step() {},",
  "};",
].join("\n");

/** Every path under `dir` (links named, not followed), with each file's text, for no-side-effect checks. */
async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])) {
    const full = path.join(entry.parentPath, entry.name);
    const rel = path.relative(dir, full).split(path.sep).join("/");
    if (entry.isSymbolicLink()) out[rel] = `-> ${await readlink(full)}`;
    else out[rel] = entry.isFile() ? await readFile(full, "utf8") : "/";
  }
  return out;
}

/** A game folder with `files` (relative path → text), beside an `outside` folder and a publish copy. */
async function gameWith(files: Record<string, string>) {
  const root = await tmpDir("studio-genex-room-");
  const game = path.join(root, "game");
  const outside = path.join(root, "outside");
  const workspace = path.join(root, "publish", "game");
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(game, rel)), { recursive: true });
    await writeFile(path.join(game, rel), text);
  }
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "secret.js"), "export const SECRET = 1;");
  await mkdir(path.join(workspace, "dist"), { recursive: true });
  await mkdir(path.join(workspace, "home"), { recursive: true });
  await writeFile(path.join(workspace, "dist", "index.html"), "<!doctype html>");
  return { root, game, outside, workspace };
}

describe("a game's room block reaches the publish copy", () => {
  it("passes the authority block through as written, malformed too, and adds nothing without one", () => {
    const table: Array<[string, unknown, GenexGameManifest | undefined]> = [
      ["a room", { genex: { authority: ROOM } }, { dependencies: {}, genex: { authority: ROOM } }],
      // The CLI names what is wrong with it; dropping it would ship a game every join refuses.
      [
        "a path, not a block",
        { genex: { authority: "server/room.js" } },
        { dependencies: {}, genex: { authority: "server/room.js" } },
      ],
      [
        "outside server/",
        { genex: { authority: { module: "../room.js" } } },
        { dependencies: {}, genex: { authority: { module: "../room.js" } } },
      ],
      ["no room", { genex: { mobileControls: true } }, { dependencies: {}, genex: { mobileControls: true } }],
      ["inherited", JSON.parse('{"genex":{"__proto__":{"authority":{"module":"server/room.js"}}}}'), undefined],
    ];
    for (const [name, pkg, expected] of table) assert.deepEqual(genexGameManifest(pkg), expected, name);
  });

  it("reads a template game's room from genex.json, and the copy's package.json carries it", async () => {
    const { game } = await gameWith({
      "index.html": "<!doctype html>",
      "genex.json": JSON.stringify({ authority: ROOM }),
    });
    const manifest = await readGenexGameManifest(game);
    assert.deepEqual(manifest, { dependencies: {}, genex: { authority: ROOM } });
    assert.deepEqual(workspaceManifest("game", manifest, true)?.genex, { authority: ROOM });
  });
});

describe("the room is staged beside the public copy, never in it", () => {
  it("stages server/ and every file the module imports, and clears them once the game declares no room", async () => {
    const { game, workspace } = await gameWith({
      "server/room.js": ROOM_JS,
      "server/rules.json": "{}",
      "server/.env": "TOKEN=x",
      "src/world.js": 'export { SPEED } from "./speed";',
      "src/speed.ts": "export const SPEED: number = 4;",
      "src/main.js": "console.log('client only');",
    });
    const staged = await stageRoom(game, workspace, ROOM.module);
    assert.deepEqual(staged, {
      files: ["server/room.js", "server/rules.json", "src/speed.ts", "src/world.js"],
      tops: ["server", "src"],
    });
    const copy = await tree(workspace);
    assert.equal(copy["server/room.js"], ROOM_JS);
    assert.equal(copy["src/main.js"], undefined, "a client file the module never imports stays out");
    assert.equal(copy["server/.env"], undefined, "a hidden file stays out");
    assert.match(copy["server/.gitignore"] ?? "", /^\*$/m, "git keeps none of the server code");
    assert.deepEqual(await readdir(path.join(workspace, "dist")), ["index.html"], "the public copy is untouched");
    await clearStagedRoom(workspace);
    const cleared = await tree(workspace);
    assert.deepEqual(
      Object.keys(cleared).filter((rel) => rel.startsWith("server") || rel.startsWith("src")),
      [],
      "nothing of the room is left",
    );
  });

  it("follows a TypeScript room's extensionless and .js imports, past its type-only ones", async () => {
    const { game, workspace } = await gameWith({
      "server/room.ts": [
        'import type { GenexRoomModule } from "@genex-ai/multiplayer/authority/module";',
        'import { WORLD } from "../src/car-world";',
        'import { step } from "../shared/step.js";',
        "enum Mode { Play }",
        "const room: GenexRoomModule = { contract: 1, init: () => ({ w: WORLD, s: step, m: Mode.Play }) } as never;",
        "export default room;",
      ].join("\n"),
      "src/car-world.ts": "export const WORLD: number = 1;",
      "shared/step.ts": "export const step = (x: number): number => x;",
    });
    const staged = await stageRoom(game, workspace, "server/room.ts");
    assert.deepEqual(staged.files, ["server/room.ts", "shared/step.ts", "src/car-world.ts"]);
  });

  it("refuses a room that reaches outside the game or into the copy's own folders, and changes nothing", async () => {
    const cases: Array<
      [string, Record<string, string>, (fx: { game: string; outside: string }) => Promise<void>, string]
    > = [
      [
        "an import that climbs out of the game",
        { "server/room.js": 'import "../../outside/secret.js";' },
        async () => {},
        ExportRefusal.RoomOutside,
      ],
      [
        "an import of a file at the game's top level",
        { "server/room.js": 'import "../config.js";', "config.js": "" },
        async () => {},
        ExportRefusal.RoomOutside,
      ],
      [
        "an import into the copy's home/",
        { "server/room.js": 'import "../home/x.js";', "home/x.js": "" },
        async () => {},
        ExportRefusal.RoomReserved,
      ],
      [
        "an import into the copy's dist/",
        { "server/room.js": 'import "../dist/x.js";', "dist/x.js": "" },
        async () => {},
        ExportRefusal.RoomReserved,
      ],
      [
        "an import of a hidden folder",
        { "server/room.js": 'import "../.secrets/x.js";', ".secrets/x.js": "" },
        async () => {},
        ExportRefusal.RoomReserved,
      ],
      [
        "a module that is a link out of the game",
        {},
        async ({ game, outside }) => {
          await mkdir(path.join(game, "server"), { recursive: true });
          await symlink(path.join(outside, "secret.js"), path.join(game, "server", "room.js"));
        },
        ExportRefusal.RoomLink,
      ],
      [
        "a server/ folder that is a link",
        {},
        async ({ game, outside }) => {
          await mkdir(game, { recursive: true });
          await writeFile(path.join(outside, "room.js"), ROOM_JS);
          await symlink(outside, path.join(game, "server"));
        },
        ExportRefusal.RoomLink,
      ],
      [
        "a link inside server/",
        { "server/room.js": ROOM_JS, "src/world.js": "export const SPEED = 1;" },
        async ({ game, outside }) => symlink(path.join(outside, "secret.js"), path.join(game, "server", "secret.js")),
        ExportRefusal.RoomLink,
      ],
      [
        "an import through a linked folder",
        { "server/room.js": 'import "../src/lib/secret.js";' },
        async ({ game, outside }) => {
          await mkdir(path.join(game, "src"), { recursive: true });
          await symlink(outside, path.join(game, "src", "lib"));
        },
        ExportRefusal.RoomLink,
      ],
      [
        "more than a room module could be",
        { "server/room.js": ROOM_JS, "server/blob.bin": "x".repeat(33 * 1024 * 1024) },
        async () => {},
        ExportRefusal.RoomTooLarge,
      ],
    ];
    for (const [name, files, arrange, code] of cases) {
      const fx = await gameWith(files);
      await arrange(fx);
      const before = await tree(fx.workspace);
      const outsideBefore = await tree(fx.outside);
      await assert.rejects(stageRoom(fx.game, fx.workspace, "server/room.js"), { code }, name);
      assert.deepEqual(await tree(fx.workspace), before, `${name}: the copy is unchanged`);
      assert.deepEqual(await tree(fx.outside), outsideBefore, `${name}: nothing outside is touched`);
    }
  });

  it("export.stage stages a declared room beside dist/ and leaves no room for a game without one", async () => {
    const { root, game } = await gameWith({
      "index.html": "<!doctype html>",
      "genex.json": JSON.stringify({ authority: ROOM }),
      "server/room.js": ROOM_JS,
      "src/world.js": "export const SPEED = 1;",
    });
    const services = new PluginServices(path.join(root, "data"), {}, async () => null);
    services.exportStage = async (_binding, target) => {
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, "index.html"), "<!doctype html>");
      return { dir: target, files: 1, included: ["index.html"], excluded: [] };
    };
    const binding = { project: "game", directory: game };
    const workspace = path.join(services.root("genex"), "publish", "game");
    const staged = (await services.call("genex", PluginService.ExportStage, {}, binding)) as { genex?: unknown };
    assert.deepEqual(staged.genex, { dependencies: {}, genex: { authority: ROOM } });
    assert.equal(await readFile(path.join(workspace, "server", "room.js"), "utf8"), ROOM_JS);
    assert.deepEqual(await readdir(path.join(workspace, "dist")), ["index.html"], "server code is never public");
    await writeFile(path.join(game, "genex.json"), "{}");
    await services.call("genex", PluginService.ExportStage, {}, binding);
    assert.deepEqual((await readdir(workspace)).sort(), [".genex", "dist"], "a game without a room leaves none");
  });
});

/**
 * A `genex.json` that was not JSON, or a stray package.json at an engine game's root, dropped the
 * `authority` block without a word, and the game published with no room: every join refused (424).
 * Now a game whose `server/room.*` sits beside such a manifest is refused by name, at the export
 * before anything is copied or shown, and at `genex__room` before anything runs.
 */
describe("a dropped authority block is refused, never published without its room", () => {
  const UNITY = {
    "unity/Packages/com.genex.multiplayer/package.json": JSON.stringify({ name: "com.genex.multiplayer" }),
  };
  const block = JSON.stringify({ authority: ROOM });
  const table: Array<[string, Record<string, string>, ExportRefusal]> = [
    [
      "a template game's genex.json with a trailing comma",
      { "index.html": "<!doctype html>", "genex.json": block.replace(/}}$/, ",}}"), "server/room.js": ROOM_JS },
      ExportRefusal.RoomManifestBroken,
    ],
    [
      "a genex.json that is a list",
      { "index.html": "<!doctype html>", "genex.json": `[${block}]`, "server/room.js": ROOM_JS },
      ExportRefusal.RoomManifestBroken,
    ],
    [
      "a Unity game's cut-off genex.json",
      { ...UNITY, "genex.json": block.slice(0, -3), "server/room.ts": "export default { contract: 1 };" },
      ExportRefusal.RoomManifestBroken,
    ],
    [
      "a package.json that is not JSON",
      { "package.json": '{ "name": "game", }', "server/room.js": ROOM_JS },
      ExportRefusal.RoomManifestBroken,
    ],
    [
      "a package.json whose genex is not an object",
      { "package.json": JSON.stringify({ genex: "server/room.js" }), "server/room.js": ROOM_JS },
      ExportRefusal.RoomManifestBroken,
    ],
    [
      "a stray package.json at a Unity game's root, read before its genex.json",
      { ...UNITY, "package.json": JSON.stringify({ name: "tools" }), "genex.json": block, "server/room.js": ROOM_JS },
      ExportRefusal.RoomManifestShadowed,
    ],
    [
      "an engine game's genex.json that nothing reads (no page, no Genex multiplayer)",
      { "unreal/Game.uproject": "{}", "genex.json": block, "server/room.js": ROOM_JS },
      ExportRefusal.RoomManifestShadowed,
    ],
  ];

  it("export.stage refuses each by name before the export runs, and changes nothing", async () => {
    for (const [name, files, code] of table) {
      const { root, game } = await gameWith(files);
      const services = new PluginServices(path.join(root, "data"), {}, async () => null);
      let exported = 0;
      services.exportStage = async (_binding, target) => {
        exported++;
        return { dir: target, files: 0, included: [], excluded: [] };
      };
      const workspace = path.join(services.root("genex"), "publish", "game");
      const before = await tree(workspace);
      const gameBefore = await tree(game);
      await assert.rejects(
        services.call("genex", PluginService.ExportStage, {}, { project: "game", directory: game }),
        (error: Error & { code?: unknown }) => error.code === code && /authority/.test(error.message),
        name,
      );
      assert.equal(exported, 0, `${name}: the export never ran`);
      assert.deepEqual(await tree(workspace), before, `${name}: the publish copy is unchanged`);
      assert.deepEqual(await tree(game), gameBefore, `${name}: the game is unchanged`);
    }
  });

  it("genex__room refuses each by name and runs nothing", async () => {
    for (const [name, files, code] of table) {
      const { root, game } = await gameWith(files);
      const runs: string[] = [];
      const rooms = new GenexRoomService({
        run: async (request) => {
          runs.push(request.command);
          throw new Error("ran");
        },
        spawn: async (request) => {
          runs.push(request.command);
          throw new Error("ran");
        },
        toolDir: path.join(root, "tool"),
        scratch: path.join(root, "runs"),
        boundGame: async () => game,
      });
      for (const action of ["validate", "start"])
        await assert.rejects(
          rooms.call({ action }, { project: "game", directory: game }),
          (error: Error & { code?: unknown }) => error.code === code,
          `${name}: ${action}`,
        );
      assert.deepEqual(runs, [], `${name}: nothing ran`);
    }
  });

  it("still exports a game whose genex.json declares no room, or whose broken genex.json has no room beside it", async () => {
    const cases: Array<[string, Record<string, string>]> = [
      [
        "no block, a server/ folder",
        { "index.html": "<!doctype html>", "genex.json": "{}", "server/room.js": ROOM_JS },
      ],
      ["a broken genex.json, no room", { "index.html": "<!doctype html>", "genex.json": "{ nope" }],
    ];
    for (const [name, files] of cases) {
      const { root, game } = await gameWith(files);
      const services = new PluginServices(path.join(root, "data"), {}, async () => null);
      services.exportStage = async (_binding, target) => {
        await mkdir(target, { recursive: true });
        return { dir: target, files: 0, included: [], excluded: [] };
      };
      await assert.doesNotReject(
        services.call("genex", PluginService.ExportStage, {}, { project: "game", directory: game }),
        name,
      );
    }
  });
});

describe("a Unity game's room travels with its WebGL build", () => {
  it("export.stage stages server/room.ts beside the build, and none of the Unity project", async () => {
    // A Unity game: its project (here in unity/) carries Genex's package, its WebGL build is web/,
    // and genex.json declares the room; it has no package.json or page of its own at the top.
    const room = { module: "server/room.ts", tickHz: 30, maxPlayers: 8 };
    const { root, game } = await gameWith({
      "unity/Packages/com.genex.multiplayer/package.json": JSON.stringify({ name: "com.genex.multiplayer" }),
      "unity/Assets/Scripts/Online.cs": "public sealed class Online {}",
      "web/index.html": "<!doctype html>",
      "genex.json": JSON.stringify({ authority: room, matchmaking: { preset: "open" } }),
      "server/room.ts": "export default { contract: 1 };",
      "server/rules.ts": "export const SPEED: number = 4;",
    });
    const manifest = await readGenexGameManifest(game);
    assert.deepEqual(manifest?.genex, { authority: room, matchmaking: { preset: "open" } });
    assert.ok(manifest?.dependencies["@genex-ai/multiplayer"], "a multiplayer game, as a relay Unity game is");
    const services = new PluginServices(path.join(root, "data"), {}, async () => null);
    // The host's export copies the WebGL build (web/), as studio-core's exportPublicCopy does for an engine's web export.
    services.exportStage = async (_binding, target) => {
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, "index.html"), await readFile(path.join(game, "web", "index.html")));
      return { dir: target, files: 1, included: ["index.html"], excluded: [] };
    };
    const binding = { project: "game", directory: game };
    const workspace = path.join(services.root("genex"), "publish", "game");
    const staged = (await services.call("genex", PluginService.ExportStage, {}, binding)) as {
      genex?: GenexGameManifest;
    };
    assert.deepEqual(staged.genex?.genex?.authority, room);
    assert.deepEqual((await readdir(workspace)).sort(), [".genex", "dist", "server"], "only the room beside the build");
    assert.deepEqual((await readdir(path.join(workspace, "server"))).sort(), [".gitignore", "room.ts", "rules.ts"]);
    assert.deepEqual(await readdir(path.join(workspace, "dist")), ["index.html"], "server code is never public");
  });
});

describe("the publish copy finds Studio's pinned toolchain", () => {
  const declared: GenexGameManifest = { dependencies: {}, genex: { authority: ROOM } };

  it("links the pinned package, which the CLI resolves and loads as a dependency of the game", async () => {
    const tool = authorityDevDir();
    assert.ok(tool, "this build carries the toolchain");
    const { workspace } = await gameWith({});
    await linkAuthorityToolchain(workspace, tool, declared);
    const require = createRequire(path.join(workspace, "package.json"));
    const manifestPath = require.resolve(`${AUTHORITY_DEV_PACKAGE}/package.json`);
    const pkg = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(pkg.version, GENEX_STUDIO_TOOLS[AUTHORITY_DEV_PACKAGE], "the version Studio pins");
    const lib = await import(pathToFileURL(path.resolve(path.dirname(manifestPath), pkg.exports["."].import)).href);
    assert.equal(typeof lib.bundleModule, "function");
    assert.equal(typeof lib.validateModule, "function");
    assert.match(await readFile(path.join(workspace, "node_modules", ".gitignore"), "utf8"), /^\*$/m);
  });

  it("leaves no dependency folder for a game without a room, and never follows one it finds", async () => {
    const { workspace, outside } = await gameWith({});
    await symlink(outside, path.join(workspace, "node_modules"));
    const outsideBefore = await tree(outside);
    await linkAuthorityToolchain(workspace, authorityDevDir(), { dependencies: {} });
    await assert.rejects(lstat(path.join(workspace, "node_modules")), { code: "ENOENT" });
    assert.deepEqual(await tree(outside), outsideBefore, "the link's target is untouched");
    await linkAuthorityToolchain(workspace, null, declared);
    await assert.rejects(lstat(path.join(workspace, "node_modules")), { code: "ENOENT" }, "no toolchain, no link");
  });
});
