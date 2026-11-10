/**
 * A server-authoritative Unreal game made in Genex had no room: an Unreal game has no package.json
 * and no index.html, so Genex read no `authority` block from it. Publish staged no room module
 * (every join would be refused, 424) and `genex__room` refused it ("no room"). And an Unreal
 * editor's Play could not find the room `genex__room` ran: Genex's Unreal plugin reads its address
 * from the game's `.studio/authority.json`, which nothing wrote.
 *
 * Now an Unreal game whose project carries Genex's `GenexMultiplayer` plugin is read like a Unity or
 * Godot game with Genex multiplayer: its `genex.json` settings, the room block among them, ride
 * along. Publish stages its `server/` beside the public copy through the same staging every game
 * uses, `genex__room` validates and runs it with bots in the sandbox, and while the room runs Genex
 * names it in `.studio/authority.json`, which it removes when the room ends.
 */
import assert from "node:assert/strict";
import { lstat, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { GenexRoomService, type RoomStatus } from "../../src/main/core/genex-room.ts";
import { authorityDevDir } from "../../src/plugins/genex/cli.ts";
import { workspaceManifest } from "../../src/plugins/genex/publish.ts";
import { ExportRefusal } from "../../src/shared/game-library.ts";
import { GENEX_GAME_PACKAGES } from "../../src/shared/genex.ts";
import { PluginService } from "../../src/shared/plugins.ts";
import { readGenexGameManifest } from "../../src/substrate/genex-game-manifest.ts";
import { PluginServices } from "../../src/substrate/plugins/services.ts";
import { ProcessSandbox } from "../../src/substrate/spawn.ts";
import { tmpDir } from "../helpers/tmp.ts";

const ROOM = { module: "server/room.ts", tickHz: 30, maxPlayers: 4 };
/** A room module as the authoritative skill has the builder write one, in TypeScript, sharing a rule with the client's data. */
const ROOM_TS = [
  'import { SPEED } from "./rules.ts";',
  "type Player = { id: string };",
  "export default {",
  "  contract: 1,",
  '  config: { tickHz: 30, maxPlayers: 4, preset: { name: "topdown" } },',
  "  init: () => ({ joins: 0 }),",
  '  onJoin(ctx: any, player: Player) { ctx.state.joins += SPEED > 0 ? 1 : 0; ctx.entities.spawn({ kind: "player", owner: player.id, hp: 3 }); },',
  "  onLeave(ctx: any, player: Player) { const me = ctx.entities.ownedBy(player.id); if (me) ctx.entities.remove(me.id); },",
  "  onInput() {},",
  "  step() {},",
  "};",
].join("\n");
/** The Unreal game Genex's New game makes (project in `unreal/`), with Genex's multiplayer plugin in it. */
const UNREAL_GAME = {
  "studio.json": "{}",
  "unreal/Duel.uproject": JSON.stringify({ FileVersion: 3, Plugins: [{ Name: "GenexMultiplayer", Enabled: true }] }),
  "unreal/Plugins/GenexMultiplayer/GenexMultiplayer.uplugin": JSON.stringify({ FileVersion: 3, VersionName: "0.1.0" }),
  "unreal/Source/Duel/Duel.cpp": "// the client\n",
  "server/room.ts": ROOM_TS,
  "server/rules.ts": "export const SPEED = 4;",
  "genex.json": JSON.stringify({ authority: ROOM }),
};
/** Where Genex names the running room for the Unreal editor's Play (the plugin's GenexLocalAuthority). */
const HANDOFF = path.join(".studio", "authority.json");
const LOOK_EVERY_MS = 100;
const LOOK_FOR_MS = 20_000;

let root: string;
let sandbox: ProcessSandbox;
before(async () => {
  root = await tmpDir("studio-unreal-room-");
  sandbox = await ProcessSandbox.create({
    writableRoots: [path.join(root, "games")],
    scratchDir: path.join(root, "sandbox"),
    secretPaths: [],
  });
});
after(async () => {
  await sandbox.dispose();
});

/** An Unreal game folder with `files` (relative path → text) over {@link UNREAL_GAME}. */
async function unrealGame(name: string, files: Record<string, string | null> = {}): Promise<string> {
  const dir = path.join(root, "games", name);
  for (const [rel, text] of Object.entries({ ...UNREAL_GAME, ...files })) {
    if (text === null) continue;
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), text);
  }
  return dir;
}

/** `genex__room` on the real sandbox and the toolchain Studio ships. */
function rooms(dir: string) {
  const toolDir = authorityDevDir();
  assert.ok(toolDir, "the repository carries the toolchain");
  const service = new GenexRoomService({
    run: (request) => sandbox.run(request),
    spawn: async (request) => {
      const { child, input, expose } = await sandbox.spawnLongLived(request);
      return expose ? { child, input, expose } : { child, input };
    },
    toolDir,
    scratch: path.join(root, "runs"),
    boundGame: async () => dir,
    loopbackPorts: () => sandbox.loopbackPorts(),
    ownLoopback: () => sandbox.ownLoopback(),
  });
  return { service, binding: { project: path.basename(dir), directory: dir } };
}

async function until(service: GenexRoomService, project: string, ready: (status: RoomStatus) => boolean) {
  for (let waited = 0; waited < LOOK_FOR_MS; waited += LOOK_EVERY_MS) {
    const status = service.status(project);
    if (ready(status)) return status;
    await sleep(LOOK_EVERY_MS);
  }
  throw new Error(`the room never got there: ${JSON.stringify(service.status(project))}`);
}

describe("an Unreal game with Genex multiplayer declares its room", () => {
  it("reads the room block from genex.json once the project carries GenexMultiplayer", async () => {
    const dir = await unrealGame("manifest");
    const manifest = await readGenexGameManifest(dir);
    assert.deepEqual(manifest, {
      dependencies: { "@genex-ai/multiplayer": GENEX_GAME_PACKAGES["@genex-ai/multiplayer"] },
      genex: { authority: ROOM },
    });
    assert.deepEqual(workspaceManifest("manifest", manifest, false)?.genex, { authority: ROOM });
  });

  it("reads nothing for an Unreal game without the plugin, or with the plugin only behind a link", async () => {
    const plain = await unrealGame("plain", { "unreal/Plugins/GenexMultiplayer/GenexMultiplayer.uplugin": null });
    assert.equal(await readGenexGameManifest(plain), undefined);
    const linked = await unrealGame("linked", { "unreal/Plugins/GenexMultiplayer/GenexMultiplayer.uplugin": null });
    const elsewhere = path.join(root, "elsewhere", "GenexMultiplayer");
    await mkdir(elsewhere, { recursive: true });
    await writeFile(path.join(elsewhere, "GenexMultiplayer.uplugin"), "{}");
    await rmPlugins(linked);
    await symlink(path.dirname(elsewhere), path.join(linked, "unreal", "Plugins"));
    assert.equal(await readGenexGameManifest(linked), undefined, "a plugin reached through a link is not the game's");
  });

  it("export.stage stages the room beside the public copy, never in it", async () => {
    const dir = await unrealGame("publish");
    const services = new PluginServices(path.join(root, "data"), {}, async () => null);
    services.exportStage = async (_binding, target) => {
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, "index.html"), "<!doctype html>");
      return { dir: target, files: 1, included: ["index.html"], excluded: [] };
    };
    const binding = { project: "publish", directory: dir };
    const staged = (await services.call("genex", PluginService.ExportStage, {}, binding)) as { genex?: unknown };
    const workspace = path.join(services.root("genex"), "publish", "publish");
    assert.deepEqual((staged.genex as { genex?: unknown }).genex, { authority: ROOM });
    assert.equal(await readFile(path.join(workspace, "server", "room.ts"), "utf8"), ROOM_TS);
    assert.equal(await readFile(path.join(workspace, "server", "rules.ts"), "utf8"), "export const SPEED = 4;");
    assert.deepEqual(await readdir(path.join(workspace, "dist")), ["index.html"], "server code is never public");
    assert.equal(await lstat(path.join(workspace, "unreal")).catch(() => null), null, "the Unreal project stays out");
  });
});

describe("export.room stages an Unreal game's room for its apps, with no web export", () => {
  it("stages the room into the publish copy while Studio exports nothing", async () => {
    const dir = await unrealGame("apps");
    // No host exporter at all: an Unreal game has no web build, and export.stage refuses it.
    const services = new PluginServices(path.join(root, "data-apps"), {}, async () => null);
    const binding = { project: "apps", directory: dir };
    const staged = (await services.call("genex", PluginService.ExportRoom, {}, binding)) as { genex?: unknown };
    const workspace = path.join(services.root("genex"), "publish", "apps");
    assert.deepEqual((staged.genex as { genex?: unknown }).genex, { authority: ROOM });
    assert.equal(await readFile(path.join(workspace, "server", "room.ts"), "utf8"), ROOM_TS);
    assert.equal(await readFile(path.join(workspace, "server", "rules.ts"), "utf8"), "export const SPEED = 4;");
    assert.deepEqual((await readdir(workspace)).sort(), [".genex", "server"], "no dist, no Unreal project");
  });

  it("refuses a hostile game and leaves the publish copy as it was", async () => {
    const outside = await tmpDir("studio-unreal-room-outside-");
    await writeFile(path.join(outside, "rules.ts"), "export const SPEED = 9;");
    const cases: Array<[string, string, string | undefined, (dir: string) => Promise<void>]> = [
      ["a project name that is a path", "../apps", undefined, async () => {}],
      [
        "a module file that is a link out of the game",
        "linked-module",
        ExportRefusal.RoomLink,
        async (dir) => {
          const { rm } = await import("node:fs/promises");
          await rm(path.join(dir, "server", "rules.ts"));
          await symlink(path.join(outside, "rules.ts"), path.join(dir, "server", "rules.ts"));
        },
      ],
      [
        "a room that imports a file outside the game",
        "imports-outside",
        ExportRefusal.RoomOutside,
        (dir) => writeFile(path.join(dir, "server", "room.ts"), 'import "../../../../etc/hosts";\nexport default {};'),
      ],
    ];
    for (const [index, [name, project, code, arrange]] of cases.entries()) {
      const dir = await unrealGame(`hostile-${index}`);
      await arrange(dir);
      const services = new PluginServices(path.join(root, `data-hostile-${index}`), {}, async () => null);
      const publish = path.join(services.root("genex"), "publish");
      const refused = services.call("genex", PluginService.ExportRoom, {}, { project, directory: dir });
      await assert.rejects(refused, (error: { code?: unknown }) => code === undefined || error.code === code, name);
      const left = await readdir(publish, { recursive: true }).catch(() => []);
      assert.ok(
        left.every((file) => !String(file).includes("server")),
        `${name}: nothing staged`,
      );
      assert.equal(await readFile(path.join(outside, "rules.ts"), "utf8"), "export const SPEED = 9;", name);
    }
  });
});

describe("genex__room runs an Unreal game's room and names it to the editor's Play", () => {
  it("validates the module as the publish gate does", async () => {
    const dir = await unrealGame("validate");
    const { service, binding } = rooms(dir);
    const verdict = (await service.call({ action: "validate" }, binding)) as { passed: boolean };
    assert.equal(verdict.passed, true, JSON.stringify(verdict));
  });

  it("serves it with bots and names it in .studio/authority.json until it ends", async () => {
    const dir = await unrealGame("start");
    const { service, binding } = rooms(dir);
    const started = (await service.call({ action: "start", bots: 2 }, binding)) as RoomStatus;
    try {
      assert.equal(started.reachable, true);
      const handoff = await readFile(path.join(dir, HANDOFF), "utf8");
      assert.deepEqual(JSON.parse(handoff), { url: started.url });
      assert.match(handoff, /^\{"url":"ws:\/\/127\.0\.0\.1:[1-9]\d{3,4}"\}$/, "the shape the Unreal plugin parses");
      await until(service, binding.project, (status) => ((status.report as { players?: number })?.players ?? 0) >= 2);
    } finally {
      await service.call({ action: "stop" }, binding);
    }
    assert.equal(await lstat(path.join(dir, HANDOFF)).catch(() => null), null, "an ended room is named nowhere");
  });

  it("never writes the handoff through a link, and leaves what the link reaches alone", async () => {
    const cases: Array<[string, (dir: string, outside: string) => Promise<void>]> = [
      ["the .studio folder is a link", (dir, outside) => symlink(outside, path.join(dir, ".studio"))],
      [
        "authority.json is a link",
        async (dir, outside) => {
          await mkdir(path.join(dir, ".studio"), { recursive: true });
          await symlink(path.join(outside, "authority.json"), path.join(dir, HANDOFF));
        },
      ],
    ];
    for (const [name, arrange] of cases) {
      const dir = await unrealGame(`link-${cases.findIndex(([n]) => n === name)}`);
      const outside = await tmpDir("studio-unreal-room-outside-");
      await writeFile(path.join(outside, "authority.json"), "theirs");
      await arrange(dir, outside);
      const { service, binding } = rooms(dir);
      const started = (await service.call({ action: "start", bots: 0 }, binding)) as RoomStatus;
      try {
        assert.equal(started.running, true, `${name}: the room still runs`);
        assert.deepEqual(await readdir(outside), ["authority.json"], `${name}: nothing new outside`);
        assert.equal(await readFile(path.join(outside, "authority.json"), "utf8"), "theirs", name);
      } finally {
        await service.call({ action: "stop" }, binding);
      }
      assert.equal(
        await readFile(path.join(outside, "authority.json"), "utf8"),
        "theirs",
        `${name}: stop removes nothing outside`,
      );
    }
  });
});

/** Remove the game's Unreal Plugins folder (to put a link in its place). */
async function rmPlugins(dir: string): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(path.join(dir, "unreal", "Plugins"), { recursive: true, force: true });
}
