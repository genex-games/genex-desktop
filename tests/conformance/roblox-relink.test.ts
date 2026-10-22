/**
 * After a publish, Genex links the game to the place Roblox now has by itself (`relink.ts`): a first
 * publish handed to the chat leaves a note, and the next look (the panel's status, a moment, a
 * publish call) finds the one Studio whose place is now published under that name or in the Studio
 * the game was bound to, and links it with its ids, with no Use in this game. Nothing is linked
 * without a publish to follow, for two candidates, for a place another game builds in, or once the
 * note is old. Over the fake Mac, with the host keeping links as Genex does.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { createRobloxBackend, RobloxAction, RobloxTool } from "../../src/plugins/roblox/backend.ts";
import { HookEvent } from "../../src/shared/plugin-hooks.ts";
import { noMomentServices } from "../../src/plugins/roblox/moment-ops.ts";
import { LOST_STUDIO_MS, PUBLISH_NOTE_MS } from "../../src/plugins/roblox/relink.ts";
import { BINDING_FILE, placeMatcher, readPlaceLink } from "../../src/plugins/roblox/studio-binding.ts";
import { type Game, hostFor, makeGame, type OpenStudio, robloxMac } from "../helpers/roblox-mac.ts";

const onMacWorld = { skip: process.platform === "win32" ? "the fake Mac helper is POSIX-only" : false };
const PUBLISHED = { placeId: "129143288655360", universeId: "5512" };

/** A game linked to its place file, open in Studio as `studio-a`, with the backend and its host. */
async function linkedGame(options: { bound?: string } = {}) {
  const mac = await robloxMac({ studios: [{ id: "studio-a", name: "sky-race.rbxlx" }] });
  if (options.bound) mac.deps.moments = { ...noMomentServices(mac.deps.now), bound: () => options.bound };
  const game = await makeGame(mac, "sky-race", "Sky Race");
  const file = path.join(game.directory, "sky-race.rbxlx");
  await writeFile(file, "<roblox/>");
  const host = hostFor(mac, game, { assist: () => ({ started: true }) });
  const backend = createRobloxBackend(mac.deps);
  const linked = (await backend.action?.(RobloxAction.UsePlace, { file }, host.context)) as { linked: boolean };
  assert.equal(linked.linked, true);
  return { mac, game, host, backend, file };
}

/** The host's link record for `game`. */
async function linkOf(storage: string, game: Game) {
  return JSON.parse(await readFile(path.join(storage, "links", `${game.project}.json`), "utf8")) as {
    project: string;
    remote?: { placeId: string; universeId: string };
  };
}

/** Studio after the publish: the place reopened under its published name, with its ids. */
const reopened = (name: string, id = "studio-c"): OpenStudio => ({
  id,
  name: `${name} (placeId: ${PUBLISHED.placeId})`,
  ...PUBLISHED,
});

describe("after a first publish, Genex links the game to the published place by itself", onMacWorld, () => {
  it("the Studio that now names the game is linked with its ids, keeping the place file, with no Use in this game", async () => {
    const { mac, game, host, backend, file } = await linkedGame();
    await backend.tool?.(RobloxTool.FirstPublish, { name: "Sky Racers" }, host.context);
    mac.state.studios = [reopened("Sky Racers")];
    const status = (await backend.action?.(RobloxAction.Status, {}, host.context)) as {
      publish?: { published: boolean };
      rows: Array<{ id: string; label: string }>;
    };
    const link = await linkOf(mac.storage, game);
    assert.equal(link.project, file);
    assert.deepEqual(link.remote, PUBLISHED);
    assert.equal(status.publish?.published, true);
    assert.equal(status.rows.find((row) => row.id === "place")?.label, "This game builds in Sky Racers");
    const links = host.calls.filter((call) => call.method === "game.engine.link");
    assert.deepEqual(links.at(-1)?.args, { project: file, remote: PUBLISHED, name: "Sky Racers" });
    // Once linked, it is done: the next look links nothing again.
    await backend.action?.(RobloxAction.Status, {}, host.context);
    assert.equal(host.calls.filter((call) => call.method === "game.engine.link").length, links.length);
  });

  it("the Studio the game was bound to is linked though Studio names the place otherwise", async () => {
    const { mac, game, host, backend } = await linkedGame({ bound: "studio-a" });
    await backend.tool?.(RobloxTool.FirstPublish, { name: "Sky Racers" }, host.context);
    mac.state.studios = [{ id: "studio-a", name: "Untitled Game", ...PUBLISHED }];
    await backend.action?.(RobloxAction.Status, {}, host.context);
    assert.deepEqual((await linkOf(mac.storage, game)).remote, PUBLISHED);
  });

  it("a moment of Genex's links it too, as the publish turn ends", async () => {
    const { mac, game, host, backend } = await linkedGame();
    await backend.tool?.(RobloxTool.FirstPublish, { name: "Sky Racers" }, host.context);
    mac.state.studios = [reopened("Sky Racers")];
    await backend.tool?.(RobloxTool.TeamNote, {}, { ...host.context, hook: { on: HookEvent.TurnStart } });
    assert.deepEqual((await linkOf(mac.storage, game)).remote, PUBLISHED);
  });
});

describe("an automatic link that is undone or refused", onMacWorld, () => {
  it("leaves the game finding its own place file after Undo, not the published name", async () => {
    const { mac, game, host, backend, file } = await linkedGame();
    await backend.tool?.(RobloxTool.FirstPublish, { name: "Sky Racers" }, host.context);
    mac.state.studios = [reopened("Sky Racers")];
    await backend.action?.(RobloxAction.Status, {}, host.context);
    assert.deepEqual((await linkOf(mac.storage, game)).remote, PUBLISHED);
    // Undo: the host puts the link it replaced back, the place file with no ids.
    const undone = { kind: "roblox", project: file, linkedAt: new Date(0).toISOString() };
    await writeFile(path.join(mac.storage, "links", `${game.project}.json`), JSON.stringify(undone));
    const link = await readPlaceLink(mac.storage, game.project);
    assert.deepEqual(link, { project: file });
    assert.equal(link && placeMatcher(link)({ id: "studio-a", name: "sky-race.rbxlx" }), true);
  });

  it("leaves the game finding its own place file when the host refuses the link", async () => {
    const { mac, game, host, backend, file } = await linkedGame();
    await backend.tool?.(RobloxTool.FirstPublish, { name: "Sky Racers" }, host.context);
    mac.state.studios = [reopened("Sky Racers")];
    const refusing = {
      ...host.context,
      host: (async (method: string, args?: Record<string, unknown>) => {
        if (method === "game.engine.link") throw new Error("The game's link changed meanwhile");
        return host.context.host(method as never, args as never);
      }) as unknown as typeof host.context.host,
    };
    await backend.action?.(RobloxAction.Status, {}, refusing);
    assert.equal((await linkOf(mac.storage, game)).remote, undefined);
    assert.deepEqual(await readPlaceLink(mac.storage, game.project), { project: file });
  });
});

describe("nothing is linked without one free place to follow", onMacWorld, () => {
  // Flipped: a first publish the chat couldn't start used to be followed all the same.
  it("a first publish the chat couldn't start leaves nothing to follow", async () => {
    for (const reason of ["unavailable", "declined"] as const) {
      const mac = await robloxMac({ studios: [{ id: "studio-a", name: "sky-race.rbxlx" }] });
      const game = await makeGame(mac, "sky-race", "Sky Race");
      const file = path.join(game.directory, "sky-race.rbxlx");
      await writeFile(file, "<roblox/>");
      const host = hostFor(mac, game, { assist: () => ({ started: false, reason }) });
      const backend = createRobloxBackend(mac.deps);
      await backend.action?.(RobloxAction.UsePlace, { file }, host.context);
      const answer = (await backend.tool?.(RobloxTool.FirstPublish, { name: "Sky Race" }, host.context)) as {
        started: boolean;
      };
      assert.equal(answer.started, false);
      mac.state.studios = [reopened("Sky Race")];
      await backend.action?.(RobloxAction.Status, {}, host.context);
      assert.equal((await linkOf(mac.storage, game)).remote, undefined, reason);
    }
  });

  it("with no publish to follow, a published place open in Studio is never taken for the game's", async () => {
    const { mac, game, host, backend } = await linkedGame();
    mac.state.studios = [reopened("Sky Racers")];
    await backend.action?.(RobloxAction.Status, {}, host.context);
    assert.equal((await linkOf(mac.storage, game)).remote, undefined);
  });

  it("two published places that could be the game's link neither", async () => {
    const { mac, game, host, backend } = await linkedGame();
    await backend.tool?.(RobloxTool.FirstPublish, { name: "Sky Racers" }, host.context);
    mac.state.studios = [reopened("Sky Racers"), { ...reopened("Sky Racers", "studio-d"), placeId: "777" }];
    await backend.action?.(RobloxAction.Status, {}, host.context);
    assert.equal((await linkOf(mac.storage, game)).remote, undefined);
  });

  it("a published place another game builds in is left to that game", async () => {
    const { mac, game, host, backend } = await linkedGame();
    const other = await makeGame(mac, "tower", "Tower");
    const otherHost = hostFor(mac, other);
    mac.state.studios = [{ id: "studio-t", name: "Tower", ...PUBLISHED }];
    await backend.action?.(RobloxAction.UsePlace, { studio: "studio-t" }, otherHost.context);
    await backend.tool?.(RobloxTool.FirstPublish, { name: "Tower" }, host.context);
    await backend.action?.(RobloxAction.Status, {}, host.context);
    assert.equal((await linkOf(mac.storage, game)).remote, undefined);
  });

  it("a published place already open when the publish was handed over is never taken for the game's", async () => {
    // The person's own game of the same name, open in another Studio, and a publish nobody clicked.
    const other: OpenStudio = { id: "studio-o", name: "Sky Race (placeId: 999)", placeId: "999", universeId: "9" };
    const mac = await robloxMac({ studios: [{ id: "studio-a", name: "sky-race.rbxlx" }, other] });
    const game = await makeGame(mac, "sky-race", "Sky Race");
    const file = path.join(game.directory, "sky-race.rbxlx");
    await writeFile(file, "<roblox/>");
    const host = hostFor(mac, game, { assist: () => ({ started: false, reason: "declined" }) });
    const backend = createRobloxBackend(mac.deps);
    await backend.action?.(RobloxAction.UsePlace, { file }, host.context);
    await backend.tool?.(RobloxTool.FirstPublish, { name: "Sky Race" }, host.context);
    mac.state.studios = [other];
    await backend.action?.(RobloxAction.Status, {}, host.context);
    assert.equal((await linkOf(mac.storage, game)).remote, undefined);
  });

  it("a published place of that name opened while the game's own place is still unpublished is left alone", async () => {
    const { mac, game, host, backend } = await linkedGame();
    await backend.tool?.(RobloxTool.FirstPublish, { name: "Sky Race" }, host.context);
    // The click never happened: the game's place is still open, and the person opens their other game.
    mac.state.studios = [
      { id: "studio-a", name: "sky-race.rbxlx" },
      { id: "studio-o", name: "Sky Race (placeId: 111)", placeId: "111", universeId: "1" },
    ];
    await backend.action?.(RobloxAction.Status, {}, host.context);
    assert.equal((await linkOf(mac.storage, game)).remote, undefined);
  });

  it("a publish note older than its limit is no longer followed", async () => {
    const { mac, game, host, backend } = await linkedGame();
    await backend.tool?.(RobloxTool.FirstPublish, { name: "Sky Racers" }, host.context);
    mac.advance(PUBLISH_NOTE_MS + 1);
    mac.state.studios = [reopened("Sky Racers")];
    await backend.action?.(RobloxAction.Status, {}, host.context);
    assert.equal((await linkOf(mac.storage, game)).remote, undefined);
  });
});

describe("a publish by hand in the game's own Studio", onMacWorld, () => {
  /** The game's last binding, written `ago` before now, as the helper link writes it. */
  async function boundAgo(mac: Awaited<ReturnType<typeof robloxMac>>, game: Game, ago: number) {
    const folder = path.join(mac.storage, "mcp", game.project);
    await mkdir(folder, { recursive: true });
    const binding = { studioId: "studio-a", session: "s-1", at: mac.deps.now() - ago };
    await writeFile(path.join(folder, BINDING_FILE), JSON.stringify(binding));
  }

  // Flipped: a lost Studio is followed only while its place carries the game's own name.
  it("is linked once Genex lost that Studio, within the limit, under the game's own name", async () => {
    const { mac, game, host, backend } = await linkedGame();
    await boundAgo(mac, game, 2 * 60_000);
    mac.state.studios = [{ id: "studio-a", name: "Sky Race", ...PUBLISHED }];
    await backend.action?.(RobloxAction.Status, {}, host.context);
    assert.deepEqual((await linkOf(mac.storage, game)).remote, PUBLISHED);
  });

  it("is not, once that lost Studio shows a place of another name", async () => {
    const { mac, game, host, backend } = await linkedGame();
    await boundAgo(mac, game, 2 * 60_000);
    mac.state.studios = [{ id: "studio-a", name: "Obby (placeId: 129143288655360)", ...PUBLISHED }];
    await backend.action?.(RobloxAction.Status, {}, host.context);
    assert.equal((await linkOf(mac.storage, game)).remote, undefined);
  });

  it("publish-update looks for it first: the update starts, with no first publish asked for", async () => {
    const { mac, game, host, backend } = await linkedGame();
    await boundAgo(mac, game, 1000);
    mac.state.studios = [{ id: "studio-a", name: "Sky Racers", ...PUBLISHED }];
    const answer = (await backend.tool?.(RobloxTool.PublishUpdate, {}, host.context)) as {
      started: boolean;
      reason?: string;
    };
    assert.deepEqual((await linkOf(mac.storage, game)).remote, PUBLISHED);
    assert.equal(answer.reason, undefined);
    assert.equal(answer.started, true);
  });

  it("is not, past the limit", async () => {
    const { mac, game, host, backend } = await linkedGame();
    await boundAgo(mac, game, LOST_STUDIO_MS + 60_000);
    mac.state.studios = [{ id: "studio-a", name: "Sky Racers", ...PUBLISHED }];
    await backend.action?.(RobloxAction.Status, {}, host.context);
    assert.equal((await linkOf(mac.storage, game)).remote, undefined);
  });

  it("while still connected, the panel's looks never ask Studio; a publish call does, and then updates", async () => {
    const { mac, game, host, backend } = await linkedGame();
    await boundAgo(mac, game, 1000);
    mac.state.studios = [{ id: "studio-a", name: "Sky Racers", ...PUBLISHED }];
    await backend.action?.(RobloxAction.Status, {}, host.context);
    assert.equal((await linkOf(mac.storage, game)).remote, undefined, "a look leaves a connected Studio alone");
    const answer = (await backend.tool?.(RobloxTool.FirstPublish, { name: "Sky Racers" }, host.context)) as {
      started: boolean;
      reason?: string;
    };
    assert.deepEqual((await linkOf(mac.storage, game)).remote, PUBLISHED);
    assert.equal(answer.reason, "published", "it is on Roblox already: an update, not a first publish");
  });
});

describe("where Genex can't click, the person's own first publish", onMacWorld, () => {
  it("is followed from the panel's look, so Studio reopening it later elsewhere is linked", async () => {
    const mac = await robloxMac({ studios: [{ id: "studio-a", name: "sky-race.rbxlx" }], canClick: false });
    const game = await makeGame(mac, "sky-race", "Sky Race");
    const file = path.join(game.directory, "sky-race.rbxlx");
    await writeFile(file, "<roblox/>");
    const host = hostFor(mac, game);
    const backend = createRobloxBackend(mac.deps);
    await backend.action?.(RobloxAction.UsePlace, { file }, host.context);
    const shown = (await backend.action?.(RobloxAction.Status, {}, host.context)) as { publish?: unknown };
    assert.deepEqual(shown.publish, { published: false, canClick: false, name: "Sky Race" });
    // Later than a lost Studio is followed, in a Studio Genex never saw.
    mac.advance(LOST_STUDIO_MS + 60_000);
    mac.state.studios = [reopened("Sky Race", "studio-z")];
    await backend.action?.(RobloxAction.Status, {}, host.context);
    assert.deepEqual((await linkOf(mac.storage, game)).remote, PUBLISHED);
  });

  it("isn't followed while the game's own place isn't open: a same-named place opened later is the person's own", async () => {
    const mac = await robloxMac({ studios: [], canClick: false });
    const game = await makeGame(mac, "sky-race", "Sky Race");
    const file = path.join(game.directory, "sky-race.rbxlx");
    await writeFile(file, "<roblox/>");
    const host = hostFor(mac, game);
    const backend = createRobloxBackend(mac.deps);
    await backend.action?.(RobloxAction.UsePlace, { file }, host.context);
    // Studio is closed while the panel looks, again and again.
    for (let look = 0; look < 3; look++) {
      await backend.action?.(RobloxAction.Status, {}, host.context);
      mac.advance(60_000);
    }
    mac.state.studios = [{ id: "studio-z", name: "Sky Race (placeId: 999)", placeId: "999", universeId: "9" }];
    await backend.action?.(RobloxAction.Status, {}, host.context);
    assert.equal((await linkOf(mac.storage, game)).remote, undefined);
  });

  it("is noted once for the Studio showing the game's place, not again each time the note grows old", async () => {
    const mac = await robloxMac({ studios: [{ id: "studio-a", name: "sky-race.rbxlx" }], canClick: false });
    const game = await makeGame(mac, "sky-race", "Sky Race");
    const file = path.join(game.directory, "sky-race.rbxlx");
    await writeFile(file, "<roblox/>");
    const host = hostFor(mac, game);
    const backend = createRobloxBackend(mac.deps);
    await backend.action?.(RobloxAction.UsePlace, { file }, host.context);
    await backend.action?.(RobloxAction.Status, {}, host.context);
    mac.advance(PUBLISH_NOTE_MS + 1);
    await backend.action?.(RobloxAction.Status, {}, host.context);
    mac.state.studios = [{ id: "studio-z", name: "Sky Race (placeId: 999)", placeId: "999", universeId: "9" }];
    await backend.action?.(RobloxAction.Status, {}, host.context);
    assert.equal((await linkOf(mac.storage, game)).remote, undefined);
  });
});
