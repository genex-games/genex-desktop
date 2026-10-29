/**
 * The chat's own session, judges and playtesters get `computer` on an engine game's editor play
 * (`main/core/editor-play-session.ts`), through the real core and each plugin's backend. Unreal and
 * any other declared engine are selected by the game's engine link; Unity by the project's facts. With no editor open, the first look
 * answers the selected plugin's own words. Disabling the plugin removes the editor computer.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import type { SessionPort } from "../../src/main/core/session-port.ts";
import { ClockLevel, TargetRuntime } from "../../src/shared/computer-target.ts";
import { ENGINE_PLAY_TOOLS, EnginePlayTool, MAX_PLAY_PLAYERS } from "../../src/shared/engine-play.ts";
import { type PluginManifest, PluginSourceKind, PluginToolAudience } from "../../src/shared/plugins.ts";
import { HarnessCapability } from "../../src/shared/protocol.ts";
import { COMPUTER_TOOL_NAME } from "../../src/substrate/computer-tool.ts";
import type { DelegateRequest, LiveToolResult } from "../../src/substrate/engines/types.ts";
import { TOY_PLUGIN, TOY_PLUGIN_ID } from "../helpers/project-fixtures.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { closeWorkerChats, workerChat } from "../helpers/worker-chat.ts";

/** How long one case may take: a real lite core, the Unreal plugin's backend and their sessions. */
const CASE_TIMEOUT_MS = 90_000;
const UNREAL_PLUGIN = "unreal";
const UNITY_PLUGIN = "unity";

after(closeWorkerChats);

const text = (result: LiveToolResult | null): string => {
  if (result === null) return "";
  return typeof result === "string" ? result : result.text;
};
const offered = (request: DelegateRequest | undefined, name = COMPUTER_TOOL_NAME) =>
  (request?.liveTools ?? []).some((tool) => tool.name === name);

/** A Unity project in the game, without an editor open or any connection to a real editor. */
async function unityProject(directory: string): Promise<string> {
  const root = path.join(directory, "unity");
  const settings = path.join(root, "ProjectSettings");
  await mkdir(settings, { recursive: true });
  await writeFile(path.join(settings, "ProjectVersion.txt"), "m_EditorVersion: 6000.6.0f1\n");
  return root;
}

/** A `.uproject` of the game's own, as a linked Unreal project needs one on disk. */
async function uproject(name: string): Promise<string> {
  const file = path.join(await realpath(await tmpDir("editor-play-uproject-")), name, `${name}.uproject`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '{"FileVersion":3}\n');
  return file;
}

describe("the computer on an Unreal game's editor play, for the chat's own session", () => {
  it("is offered where the Unreal plugin is on and holds the game's link, and answers the plugin's words with no editor open", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const { core, game, project, seen, delegate, personSays, whileRunning } = await workerChat();
    // A web game's chat: no editor play, whatever plugins are on.
    await core.plugins.setEnabled(UNREAL_PLUGIN, true);
    await delegate({ chatTurn: { messageId: await personSays() } });
    assert.equal(offered(seen.at(-1)), false, "a web game's chat gets no editor computer");

    await core.engineLinks.link(
      UNREAL_PLUGIN,
      { project: game, directory: project.dir },
      { project: await uproject("Valley") },
    );
    let looked: LiveToolResult | null = null;
    whileRunning(async (request) => {
      if (!offered(request)) return;
      assert.ok(request.onLiveTool);
      looked = await request.onLiveTool(COMPUTER_TOOL_NAME, { action: "screenshot" });
    });
    await delegate({ chatTurn: { messageId: await personSays() } });
    const request = seen.at(-1);
    assert.equal(offered(request), true, "the linked Unreal game's chat plays its editor");
    const computer = request?.liveTools?.find((tool) => tool.name === COMPUTER_TOOL_NAME);
    assert.match(String(computer?.description), /engine's editor/);
    assert.match(String(computer?.description), /where the view is aimed/, "the mouse as a player has it");
    assert.doesNotMatch(String(computer?.description), /mouse_move coordinate/, "no point to put a pointer at");
    assert.match(text(looked), /Unreal Editor is not open/, "the plugin's own reason, through the real backend");

    // The plugin off: no editor computer, even on the linked game.
    await core.plugins.setEnabled(UNREAL_PLUGIN, false);
    whileRunning(async () => {});
    await delegate({ chatTurn: { messageId: await personSays() } });
    assert.equal(offered(seen.at(-1)), false, "no engine plugin on: no editor computer");
  });
});

describe("the computer of a judge or playtester on an Unreal game", () => {
  it("plays its editor where the Unreal plugin holds the game's link, and a web game in its window", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const { core, game, project } = await workerChat();
    const outDir = await tmpDir("editor-play-judge-");
    const session = {
      loaded: null,
      handle: () => "pool:1",
      get: async () => assert.fail("no window"),
      release: async () => {},
    };
    const computer = (role: "judge" | "playtester") =>
      core._computerToolsFor(
        { project: game, root: project.dir, handle: "pool:1", role },
        project.dir,
        outDir,
        session as never,
      );
    assert.notEqual((await computer("judge")).runtime, TargetRuntime.Editor, "a web game plays in its window");
    await core.plugins.setEnabled(UNREAL_PLUGIN, true);
    await core.engineLinks.link(
      UNREAL_PLUGIN,
      { project: game, directory: project.dir },
      { project: await uproject("Valley") },
    );
    try {
      for (const role of ["judge", "playtester"] as const) {
        const tools = await computer(role);
        assert.equal(tools.runtime, TargetRuntime.Editor, role);
        const looked = await tools.onLiveTool(COMPUTER_TOOL_NAME, { action: "screenshot" });
        assert.match(text(looked), /Unreal Editor is not open/, `${role}: the plugin's own reason`);
        await tools.release();
      }
    } finally {
      // Turning the plugin off stops its backend's process.
      await core.plugins.setEnabled(UNREAL_PLUGIN, false);
    }
  });
});

/** A `.toyproj` of the game's own, as a linked toy project needs one on disk. */
async function toyProject(name: string): Promise<string> {
  const file = path.join(await realpath(await tmpDir("editor-play-toyproj-")), name, `${name}.toyproj`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "toy\n");
  return file;
}

describe("the computer on a game another engine plays in its editor", () => {
  it("is built from what the engine's plugin declares, and reaches each of the toy engine's three players", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const { core, game, project } = await workerChat();
    const outDir = await tmpDir("editor-play-toy-");
    const session = {
      loaded: null,
      handle: () => "pool:1",
      get: async () => assert.fail("no window"),
      release: async () => {},
    };
    await core.plugins.installLocal(TOY_PLUGIN, PluginSourceKind.Local, []);
    await core.plugins.setEnabled(TOY_PLUGIN_ID, true);
    await core.engineLinks.link(
      TOY_PLUGIN_ID,
      { project: game, directory: project.dir },
      { project: await toyProject("Garden") },
    );
    try {
      const judge = await core._computerToolsFor(
        { project: game, root: project.dir, handle: "pool:1", role: "judge" },
        project.dir,
        outDir,
        session as never,
      );
      assert.equal(judge.runtime, TargetRuntime.Editor);
      const judged = judge.liveTools.find((tool) => tool.name === COMPUTER_TOOL_NAME);
      assert.match(String(judged?.description), /clock cannot be held still/, "the toy declares no clock to hold");
      assert.equal(Object.hasOwn(judged?.parameters.properties ?? {}, "player"), false, "a judge asked for one player");
      await judge.release();

      const crowd = await core._computerToolsFor(
        { project: game, root: project.dir, handle: "pool:1", role: "playtester", players: 3 },
        project.dir,
        outDir,
        session as never,
      );
      const tool = crowd.liveTools.find((t) => t.name === COMPUTER_TOOL_NAME);
      assert.match(String(tool?.description), /3 players/);
      for (const player of [1, 2, 3]) {
        const looked = await crowd.onLiveTool(COMPUTER_TOOL_NAME, { action: "screenshot", player });
        assert.equal(typeof looked === "string" ? 0 : looked.images?.length, 1, `player ${player} is seen`);
        assert.match(
          text(await crowd.onLiveTool(COMPUTER_TOOL_NAME, { action: "state" })),
          new RegExp(`"player":${player}`),
        );
      }
      assert.match(
        text(await crowd.onLiveTool(COMPUTER_TOOL_NAME, { action: "screenshot", player: 4 })),
        /player 4 is not in this play/,
      );
      await crowd.release();
    } finally {
      await core.plugins.setEnabled(TOY_PLUGIN_ID, false);
    }
  });
});

describe("the Roblox plugin's play tools", () => {
  it("declares every play tool as a harness step under the Studio lock, with players on open and a player on the others", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(import.meta.dirname, "../../src/plugins/roblox/plugin.json"), "utf8"),
    ) as PluginManifest;
    const tools = new Map(manifest.tools.map((tool) => [tool.name, tool]));
    for (const name of ENGINE_PLAY_TOOLS) {
      const tool = tools.get(name);
      assert.equal(tool?.audience, PluginToolAudience.Harness, name);
      assert.deepEqual(tool?.needs, ["studio"], name);
    }
    const params = (name: string) => Object.keys(tools.get(name)?.parameters?.properties ?? {});
    assert.ok(params(EnginePlayTool.Open).includes("players"));
    for (const name of [EnginePlayTool.Input, EnginePlayTool.Shot, EnginePlayTool.State])
      assert.ok(params(name).includes("player"), name);
    assert.deepEqual(manifest.engine?.play, {
      players: MAX_PLAY_PLAYERS,
      clock: ClockLevel.None,
      pointer: true,
      state: true,
    });
  });
});

describe("the computer on a Unity game's editor play", () => {
  it("offers the chat's computer and judge_play only while Unity is enabled and the game holds its project", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const { core, project, seen, delegate, personSays, whileRunning } = await workerChat();
    core.host.hasCapability = (capability) => capability === HarnessCapability.ChatJudge;
    await core.plugins.setEnabled(UNITY_PLUGIN, true);
    await delegate({ chatTurn: { messageId: await personSays() } });
    assert.equal(offered(seen.at(-1)), false, "no Unity project: no editor computer");
    assert.equal(offered(seen.at(-1), "judge_play"), false);

    const root = await unityProject(project.dir);
    let looked: LiveToolResult | null = null;
    whileRunning(async (request) => {
      if (!offered(request)) return;
      assert.ok(request.onLiveTool);
      looked = await request.onLiveTool(COMPUTER_TOOL_NAME, { action: "screenshot" });
    });
    await delegate({ chatTurn: { messageId: await personSays() } });
    assert.equal(offered(seen.at(-1)), true, "the project's facts select Unity's editor play");
    assert.equal(offered(seen.at(-1), "judge_play"), true, "the editor computer enables the chat's judge");
    assert.match(text(looked), /Unity.*not open/i, "the real Unity backend explains why it cannot play");

    whileRunning(async () => {});
    await core.plugins.setEnabled(UNITY_PLUGIN, false);
    await delegate({ chatTurn: { messageId: await personSays() } });
    assert.equal(offered(seen.at(-1)), false, "a disabled plugin offers no computer");
    assert.equal(offered(seen.at(-1), "judge_play"), false);

    await core.plugins.setEnabled(UNITY_PLUGIN, true);
    await rename(path.join(root, "ProjectSettings", "ProjectVersion.txt"), path.join(root, "version.txt"));
    await delegate({ chatTurn: { messageId: await personSays() } });
    assert.equal(offered(seen.at(-1)), false, "a removed Unity project no longer offers the computer");
    assert.equal(offered(seen.at(-1), "judge_play"), false);
    await core.plugins.setEnabled(UNITY_PLUGIN, false);
  });

  it("gives judges and playtesters the Unity editor target through the real backend", {
    timeout: CASE_TIMEOUT_MS,
  }, async () => {
    const { core, game, project } = await workerChat();
    await unityProject(project.dir);
    await core.plugins.setEnabled(UNITY_PLUGIN, true);
    const outDir = await tmpDir("unity-editor-play-judge-");
    const session: SessionPort = {
      loaded: null,
      handle: () => "pool:unity",
      get: async () => assert.fail("Unity play must not open a browser window"),
      release: async () => {},
    };
    try {
      for (const role of ["judge", "playtester"] as const) {
        const tools = await core._computerToolsFor(
          { project: game, root: project.dir, handle: "pool:unity", role },
          project.dir,
          outDir,
          session,
        );
        try {
          assert.equal(tools.runtime, TargetRuntime.Editor, role);
          const looked = await tools.onLiveTool(COMPUTER_TOOL_NAME, { action: "screenshot" });
          assert.match(text(looked), /Unity.*not open/i, `${role}: the real Unity backend's refusal`);
        } finally {
          await tools.release();
        }
      }
    } finally {
      await core.plugins.setEnabled(UNITY_PLUGIN, false);
    }
  });
});
