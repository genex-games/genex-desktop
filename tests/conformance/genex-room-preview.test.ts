/**
 * A local room is only useful if the person can play in it: while `genex__room` runs a game's
 * room, the game's Live preview (on its loopback origin, the only one the Genex SDK's local test
 * mode takes) is loaded with the room's address, and loaded without it once the room ends. A game
 * the preview serves on `game://` is never handed an address its SDK would not take.
 */
import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { authorityDevDir } from "../../src/plugins/genex/cli.ts";
import { studioSdkImports } from "../../src/shared/genex.ts";
import { PluginHostTool } from "../../src/shared/plugins.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { tmpDir } from "../helpers/tmp.ts";

const ROOM_JS =
  "export default { contract: 1, config: { tickHz: 30, maxPlayers: 4 }, init: () => ({}), onJoin() {}, onLeave() {}, onInput() {}, step() {} };";

/** A Live view that records what it loads. */
function livePort() {
  const port = {
    loads: [] as Array<{ entry: string; loopback: boolean }>,
    async load(project: string, entry: string, _root?: string, options: { loopback?: boolean } = {}) {
      port.loads.push({ entry, loopback: options.loopback === true });
      return options.loopback ? `http://localhost:41000/${entry}` : `game://${project}/${entry}`;
    },
    async reload() {},
    status: () => ({ project: "arena", loadError: null, consoleErrors: [], url: null }),
    async evaluate() {
      return { via: "contract", ready: true, phase: "ready" };
    },
  };
  return port;
}

/** A core whose resources carry the toolchain, and a template game declaring a room. */
async function arena(page: string) {
  const tool = authorityDevDir();
  assert.ok(tool, "the repository carries the toolchain");
  const port = livePort();
  const gamesRoot = await realpath(await tmpDir("studio-room-"));
  const lite = await coreLite({ preview: port as never, gamesRoot, authorityDev: tool });
  const game = await lite.core.games.scaffold("arena");
  await writeFile(path.join(game.dir, "index.html"), page);
  await mkdir(path.join(game.dir, "server"), { recursive: true });
  await writeFile(path.join(game.dir, "server", "room.js"), ROOM_JS);
  await writeFile(path.join(game.dir, "genex.json"), JSON.stringify({ authority: { module: "server/room.js" } }));
  await lite.core.loadPreview({ project: "arena" });
  const room = (action: string) =>
    lite.core.plugins.hostTool?.(
      "genex",
      PluginHostTool.GenexRoom,
      { action, bots: 0 },
      {
        project: "arena",
        directory: game.dir,
      },
    ) as Promise<{ url: string | null; previewJoined: boolean }>;
  return { lite, port, room };
}

const page = (imports: Record<string, string>) =>
  `<!doctype html><script type="importmap">${JSON.stringify({ imports })}</script><script type="module" src="./src/main.js"></script>`;

describe("the preview plays in the game's local room", () => {
  it("loads a loopback game into the room while it runs, and out of it once it stops", async () => {
    const { lite, port, room } = await arena(page(studioSdkImports("@genex-ai/multiplayer")));
    try {
      assert.equal(port.loads.at(-1)?.loopback, true, "a game that loads the SDK is served on loopback");
      const started = await room("start");
      assert.equal(started.previewJoined, true);
      const inRoom = new URLSearchParams(port.loads.at(-1)?.entry.split("?")[1] ?? "");
      assert.equal(inRoom.get("genex_authority_url"), started.url);
      assert.equal(inRoom.get("genex_local_test"), "1");
      await room("stop");
      assert.doesNotMatch(port.loads.at(-1)?.entry ?? "", /genex_authority_url/, "the room is gone from the page");
    } finally {
      await lite.close();
    }
  });

  it("never hands the room's address to a game served on game://", async () => {
    const { lite, port, room } = await arena(page({ three: "/vendor/three.module.js" }));
    try {
      const started = await room("start");
      assert.equal(started.previewJoined, false);
      assert.ok(port.loads.every((load) => !load.entry.includes("genex_authority_url")));
      await room("stop");
    } finally {
      await lite.close();
    }
  });
});
