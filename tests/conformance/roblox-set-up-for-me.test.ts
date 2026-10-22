/**
 * Genex sets Roblox Studio up for the person, all but signing in, over a fake Mac whose home,
 * storage and game folders are real temporary folders:
 * - Get Roblox Studio in a game with no place writes and links the game's new place first, and once
 *   Studio is installed, signed in and set up, opens that place rather than Studio alone.
 * - Set it up for me (`finish-setup`, the card's own button and an agent tool) does every step
 *   Genex can do now: a new place for a game with none, Set up while Studio is closed (Restart
 *   Studio's normal quit while it is open), then the game's place opened. Once only signing in is
 *   left, it changes nothing and says signing in is the person's.
 * - When the installer's Studio stays open after the person signs in (Studio's log says so), Genex
 *   quits it normally, sets it up and opens the game's place; Set it up for me meanwhile changes
 *   nothing, so it never cuts off the sign-in.
 * - Neither asks on a card: the person's press, or the agent's call, is the go-ahead.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { PluginContext, PluginScalar } from "../../src/plugin-sdk/index.d.ts";
import { createRobloxBackend, type RobloxStatus } from "../../src/plugins/roblox/backend.ts";
import { HELPER_FILE } from "../../src/plugins/roblox/setup.ts";
import { STUDIO_MAC_APP } from "../../src/plugins/roblox/studio-locate.ts";
import { SIGNED_IN_MARK } from "../../src/plugins/roblox/studio-logs.ts";
import { type HostCall, hostFor, type Mac, makeGame, robloxMac } from "../helpers/roblox-mac.ts";

const STUDIO = `${STUDIO_MAC_APP}/Contents/MacOS/RobloxStudio`;
const ON_A_MAC = { skip: process.platform === "win32" && "a Mac home on a Mac path" };

const linkCalls = (calls: HostCall[]) => calls.filter((call) => call.method === "game.engine.link");
const editFile = (file: string) => ({ file: STUDIO, args: ["--task", "EditFile", "--localPlaceFile", file] });

/** Studio's Roblox folder and one account's settings with its MCP switch as given, as Studio leaves them. */
async function studioFolders(mac: Mac, mcpOn = false) {
  await mkdir(path.join(mac.home, "Documents", "Roblox"), { recursive: true });
  const settings = path.join(mac.home, "Library", "Roblox", "AssistantSettings");
  await mkdir(settings, { recursive: true });
  const file = path.join(settings, "1.json");
  await writeFile(file, JSON.stringify({ "mcp-server": { enabled: mcpOn } }));
  return {
    helper: path.join(mac.home, "Documents", "Roblox", "Plugins", HELPER_FILE),
    switchOn: async () => JSON.parse(await readFile(file, "utf8"))["mcp-server"].enabled === true,
  };
}

/** Roblox's installer on this fake Mac: downloaded, signed by Roblox, and Studio in Applications after it runs. */
async function withInstaller(mac: Mac) {
  await mkdir(mac.deps.install.tempRoot, { recursive: true });
  mac.deps.install = {
    ...mac.deps.install,
    fetch: (async () => new Response(Buffer.from("roblox dmg"))) as typeof fetch,
    run: async (file, args) => {
      if (file === "/usr/bin/codesign" && !args.includes("--verify"))
        return { code: 0, stdout: "", stderr: "TeamIdentifier=2CFABCH843\n" };
      if (file === "/usr/bin/hdiutil" && args[0] === "attach")
        await mkdir(path.join(args[args.indexOf("-mountpoint") + 1] ?? "", "RobloxStudioInstaller.app"));
      if (file === "/usr/bin/open") mac.state.installed = true;
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

/** The status once Get Roblox Studio has finished, or failed, polled as the panel polls it. */
async function finished(mac: Mac, backend: ReturnType<typeof createRobloxBackend>, context: PluginContext) {
  for (let tries = 0; tries < 400; tries++) {
    const answer = (await backend.action?.("status", {}, context)) as RobloxStatus;
    if (answer.install && ["done", "failed"].includes(answer.install.phase)) return answer;
    await nextTurn();
  }
  assert.fail(`Get Roblox Studio never finished on ${mac.home}`);
}

const press = async <T>(mac: Mac, name: string, context: PluginContext, args: Record<string, PluginScalar> = {}) =>
  (await createRobloxBackend(mac.deps).action?.(name, args, context)) as T;

describe("Get Roblox Studio in a game with no place", () => {
  it("writes and links the game's new place first, then opens it once Studio is set up", ON_A_MAC, async () => {
    const mac = await robloxMac({ installed: false, setUp: false, running: false });
    const folders = await studioFolders(mac);
    await withInstaller(mac);
    const game = await makeGame(mac, "sky-race", "Sky Race");
    const { context, calls, methods } = hostFor(mac, game);
    const backend = createRobloxBackend(mac.deps);
    const started = (await backend.action?.("get-studio", {}, context)) as { started: boolean };
    assert.equal(started.started, true);
    const file = path.join(game.directory, "sky-race.rbxlx");
    assert.ok(existsSync(file), "the place is written before Studio is there");
    assert.deepEqual(
      linkCalls(calls).map((call) => call.args),
      [{ project: file }],
    );
    assert.ok(methods().indexOf("game.snapshot") < methods().indexOf("game.engine.link"), "the press snapshots first");
    const status = await finished(mac, backend, context);
    assert.equal(status.install?.phase, "done", status.install?.message);
    assert.deepEqual(mac.launches, [editFile(file)], "Studio opens once, with the game's place");
    assert.ok(existsSync(folders.helper), "the helper is in Studio's Plugins folder");
    assert.equal(await folders.switchOn(), true, "and Studio's MCP server is on");
  });

  it("as the agent's tool, takes no snapshot of its own and names the new place", ON_A_MAC, async () => {
    const mac = await robloxMac({ installed: false, setUp: false, running: false });
    await studioFolders(mac);
    await withInstaller(mac);
    const game = await makeGame(mac, "sky-race", "Sky Race");
    const { context, methods } = hostFor(mac, game);
    const backend = createRobloxBackend(mac.deps);
    const words = String(await backend.tool?.("get-studio", {}, context));
    assert.match(words, /sky-race\.rbxlx/);
    assert.match(words, /signs in/);
    assert.equal(methods().includes("game.snapshot"), false);
    await finished(mac, backend, context);
  });

  it("in a game that already builds in a place, makes none and opens that one", ON_A_MAC, async () => {
    const mac = await robloxMac({ installed: false, setUp: false, running: false });
    await studioFolders(mac);
    await withInstaller(mac);
    const game = await makeGame(mac, "sky-race", "Sky Race");
    const own = path.join(game.directory, "Own.rbxl");
    await writeFile(own, "");
    const { context, calls } = hostFor(mac, game);
    await context.host("game.engine.link" as never, { project: own } as never);
    const backend = createRobloxBackend(mac.deps);
    await backend.action?.("get-studio", {}, context);
    await finished(mac, backend, context);
    assert.equal(linkCalls(calls).length, 1, "no other link");
    assert.equal(existsSync(path.join(game.directory, "sky-race.rbxlx")), false);
    assert.deepEqual(mac.launches, [editFile(own)]);
  });
});

describe("Get Roblox Studio when the installer's Studio stays open after the sign-in", () => {
  it(
    "quits it normally once Studio's log shows the sign-in, sets it up and opens the game's place",
    ON_A_MAC,
    async () => {
      const mac = await robloxMac({ installed: false, setUp: false, running: false });
      const folders = await studioFolders(mac);
      await withInstaller(mac);
      const log = path.join(
        mac.home,
        "Library",
        "Logs",
        "Roblox",
        "0.744.0.7441077_20261022T181824Z_Studio_147ed_last.log",
      );
      await mkdir(path.dirname(log), { recursive: true });
      const installer = mac.deps.install.run;
      mac.deps.install.run = async (file, args, options) => {
        const ran = await installer(file, args, options);
        // Roblox's installer opens Studio at its sign-in, and Studio starts its log.
        if (file === "/usr/bin/open") {
          mac.state.running = true;
          await writeFile(log, "Info [FLog::StudioKeyEvents] login (automatic) [start]\n");
        }
        return ran;
      };
      const quits: string[] = [];
      const run = mac.deps.run;
      mac.deps.run = async (file, args) => {
        if (file === "/usr/bin/osascript") {
          quits.push(file);
          mac.state.running = false;
        }
        return run(file, args);
      };
      const game = await makeGame(mac, "sky-race", "Sky Race");
      const { context } = hostFor(mac, game);
      const backend = createRobloxBackend(mac.deps);
      await backend.action?.("get-studio", {}, context);
      for (let tries = 0; tries < 400 && !mac.state.running; tries++) await nextTurn();
      // The job reaches the sign-in once its own checks after the installer have run.
      let signingIn = (await backend.action?.("status", {}, context)) as RobloxStatus;
      for (let tries = 0; tries < 400 && signingIn.install?.phase !== "signing-in"; tries++) {
        await nextTurn();
        signingIn = (await backend.action?.("status", {}, context)) as RobloxStatus;
      }
      assert.equal(signingIn.install?.phase, "signing-in");
      assert.deepEqual(quits, [], "never quit before the sign-in");
      const pressed = (await backend.action?.("finish-setup", {}, context)) as { message: string };
      assert.equal(pressed.message, signingIn.install?.message, "Set it up for me leaves the sign-in alone");
      assert.match(String(await backend.tool?.("finish-setup", {}, context)), /signs in to Roblox there/);
      assert.deepEqual(quits, []);
      await appendFile(log, `Info ${SIGNED_IN_MARK}\n`);
      const status = await finished(mac, backend, context);
      assert.equal(status.install?.phase, "done", status.install?.message);
      assert.equal(quits.length, 1, "Studio's own quit, which asks to save");
      assert.ok(existsSync(folders.helper));
      assert.equal(await folders.switchOn(), true);
      assert.deepEqual(mac.launches, [editFile(path.join(game.directory, "sky-race.rbxlx"))]);
    },
  );
});

describe("Set it up for me", () => {
  it(
    "with Studio closed and not set up, makes the game's place, sets Studio up and opens the place",
    ON_A_MAC,
    async () => {
      const mac = await robloxMac({ setUp: false, running: false });
      const folders = await studioFolders(mac);
      const game = await makeGame(mac, "sky-race", "Sky Race");
      const { context, calls } = hostFor(mac, game);
      await press(mac, "finish-setup", context);
      const file = path.join(game.directory, "sky-race.rbxlx");
      assert.deepEqual(
        linkCalls(calls).map((call) => call.args),
        [{ project: file }],
      );
      assert.ok(existsSync(folders.helper));
      assert.equal(await folders.switchOn(), true);
      assert.deepEqual(mac.launches, [editFile(file)]);
    },
  );

  it(
    "with Studio open and not set up, quits it normally, sets it up while closed and opens the game's place",
    ON_A_MAC,
    async () => {
      const mac = await robloxMac({ setUp: false, running: true });
      const folders = await studioFolders(mac);
      const run = mac.deps.run;
      const quits: string[] = [];
      mac.deps.run = async (file, args) => {
        if (file === "/usr/bin/osascript") {
          quits.push(file);
          mac.state.running = false;
        }
        return run(file, args);
      };
      const game = await makeGame(mac, "sky-race", "Sky Race");
      const { context } = hostFor(mac, game);
      await press(mac, "finish-setup", context);
      assert.equal(quits.length, 1, "Studio's own quit, which asks to save");
      assert.ok(existsSync(folders.helper));
      assert.deepEqual(mac.launches, [editFile(path.join(game.directory, "sky-race.rbxlx"))]);
    },
  );

  it("once only signing in is left, changes nothing and says signing in is the person's", ON_A_MAC, async () => {
    const mac = await robloxMac({ running: true, answering: false });
    await studioFolders(mac, true);
    const game = await makeGame(mac, "sky-race", "Sky Race");
    const own = path.join(game.directory, "Own.rbxl");
    await writeFile(own, "");
    const { context, calls } = hostFor(mac, game);
    await context.host("game.engine.link" as never, { project: own } as never);
    const answer = await press<{ message: string }>(mac, "finish-setup", context);
    assert.match(answer.message, /Sign in to Roblox in Studio/);
    const words = String(await createRobloxBackend(mac.deps).tool?.("finish-setup", {}, context));
    assert.match(words, /signing in to Roblox .*is the person's/i);
    assert.deepEqual(mac.launches, []);
    assert.equal(linkCalls(calls).length, 1, "only the test's own link");
  });

  it("asks on no card, nor do Get Roblox Studio, Set up and Restart Studio", async () => {
    const mac = await robloxMac({ setUp: false, running: false });
    const backend = createRobloxBackend(mac.deps);
    const { context } = hostFor(mac, undefined);
    for (const name of ["finish-setup", "get-studio", "setup", "restart-studio"])
      assert.deepEqual(await backend.review?.(name, {}, context), {}, name);
  });
});
