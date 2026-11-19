/**
 * The Unity plugin against the real Unity on this computer: a new game's project opens with the
 * Pipeline package Genex asks for, the connector lists and runs that editor's own commands and
 * refuses the ones agents never run, a project an editor still has open on Pipeline 0.8 keeps
 * working under its flat names, and a closed one is moved to the current package as it opens.
 * Machine-dependent, so skipped unless asked for:
 * `STUDIO_UNITY_LIVE=1 node --test tests/conformance/unity-live.test.ts` with a Unity 6 installed
 * by Unity Hub and signed in. It opens Unity's own windows, and each case takes a few minutes while
 * Unity imports an empty project and downloads the package.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { systemBackendDeps, createUnityBackend, UnityTool } from "../../src/plugins/unity/backend.ts";
import { openProjectLaunch, systemOpener, waitForEditor } from "../../src/plugins/unity/editor-launch.ts";
import { editorRuns, endEditor } from "../../src/plugins/unity/editor-life.ts";
import { createEditorMcp, EditorTool } from "../../src/plugins/unity/editor-mcp.ts";
import { findEditors, isUnity6 } from "../../src/plugins/unity/editors.ts";
import { editorStatus, PIPELINE_PACKAGE, PIPELINE_VERSION, readDescriptor } from "../../src/plugins/unity/pipeline.ts";
import { tmpDir } from "../helpers/tmp.ts";
import { manifestOf, withProject } from "../helpers/unity-backend.ts";
import { pluginContext } from "../helpers/unity-editor-stand-in.ts";

const LIVE = process.env.STUDIO_UNITY_LIVE === "1";
/** A first open imports the project and downloads the package: generous for a cold computer. */
const LIVE_TIMEOUT_MS = 20 * 60 * 1000;
const EDITOR_WAIT_MS = 10 * 60 * 1000;
const PLAY_WAIT_MS = 2 * 60 * 1000;
const PLAY_POLL_MS = 500;
/** The version of the package Genex asked for before 1.0.0. */
const PIPELINE_0_8 = "0.8.0-exp.1";
const PNG_SIGNATURE = "iVBORw0KGgo";

type ToolAnswer = { isError?: boolean; content: Array<{ type: string; text?: string; data?: string }> };

const textOf = (answer: ToolAnswer) => answer.content.map((part) => part.text ?? "").join("\n");

/** The real backend and the real connector over a fresh game folder, with the plugin's storage beside it. */
async function liveGame() {
  const base = await realpath(await tmpDir("studio-unity-live-"));
  const game = path.join(base, "game");
  const storage = path.join(base, "storage");
  await mkdir(game);
  await mkdir(storage);
  const deps = systemBackendDeps();
  const backend = createUnityBackend(deps);
  const context = () => pluginContext(storage, { project: "live", directory: game });
  const tool = async (name: string) => String(await backend.tool?.(name, {}, context()));
  const root = path.join(game, "unity");
  const bridge = createEditorMcp(async () => ({ root, game }), deps.pipeline);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "unity-live", version: "0" }, { capabilities: {} });
  await Promise.all([bridge.server.connect(serverSide), client.connect(clientSide)]);
  const run = async (command: string, parameters: Record<string, unknown> = {}) =>
    (await client.callTool({ name: EditorTool.RunCommand, arguments: { command, parameters } })) as ToolAnswer;
  const listed = async (): Promise<string[]> => {
    const answer = (await client.callTool({ name: EditorTool.ListCommands, arguments: {} })) as ToolAnswer;
    assert.equal(answer.isError, undefined, textOf(answer));
    return (JSON.parse(textOf(answer)) as Array<{ name: string }>).map((command) => command.name);
  };
  /** Ends whatever editor the case left on the project, saving nothing. */
  const cleanUp = async () => {
    await endEditor(root, deps).catch(() => false);
    await bridge.close();
  };
  return { base, game, root, deps, tool, run, listed, cleanUp };
}

type Live = Awaited<ReturnType<typeof liveGame>>;

/** The newest Unity 6 this computer has, which the cases open their projects in. */
async function newestUnity6(live: Live) {
  const editor = (await findEditors(live.deps.editors)).find((installed) => isUnity6(installed.version));
  assert.ok(editor, "this computer has no Unity 6 installed by Unity Hub");
  return editor;
}

/** Waits until the editor's Play mode is `playMode`. */
async function playModeIs(live: Live, playMode: string): Promise<void> {
  for (let waited = 0; waited < PLAY_WAIT_MS; waited += PLAY_POLL_MS) {
    const look = await editorStatus(live.root, live.deps.pipeline, { waits: true });
    if (look.ok && look.result.playMode === playMode) return;
    await live.deps.pipeline.sleep(PLAY_POLL_MS);
  }
  assert.fail(`Unity did not reach Play mode ${playMode}`);
}

/** What every editor must refuse an agent, under each name that could reach it. */
async function refusesWhatAgentsNeverRun(live: Live, names: string[]): Promise<void> {
  for (const name of names) {
    const answer = await live.run(name, { code: "return 1+1;", root: "Assets", path: "File/Quit" });
    assert.equal(answer.isError, true, `${name}: ${textOf(answer)}`);
  }
  assert.equal(await editorRuns(live.root, live.deps), true, "no refused command reached the editor");
}

describe("the Unity plugin on this computer's Unity", { skip: !LIVE, timeout: LIVE_TIMEOUT_MS }, () => {
  it("makes a game on the current Pipeline package, builds in it through the connector and quits it", async () => {
    const live = await liveGame();
    try {
      const made = await live.tool(UnityTool.NewGame);
      assert.equal((await manifestOf(live.root)).dependencies[PIPELINE_PACKAGE], PIPELINE_VERSION);
      assert.equal(await waitForEditor(live.root, live.deps.pipeline, { waitMs: EDITOR_WAIT_MS }), "ready", made);
      assert.equal((await readDescriptor(live.root))?.grouped, true, "1.0.0 groups its commands");
      assert.match(made, /first scene/i, made);
      assert.equal(existsSync(path.join(live.root, "Assets", "Scenes", "Main.unity")), true, made);

      const names = await live.listed();
      for (const name of ["scene save", "editor save_all", "capture game_view", "script run", "job batch"])
        assert.ok(names.includes(name), `${name} is listed`);
      for (const name of ["script eval", "editor quit", "runtime quit", "authoring set_root"])
        assert.ok(!names.includes(name), `${name} is not offered`);
      await refusesWhatAgentsNeverRun(live, [
        "script eval",
        "script.eval",
        "eval",
        "authoring set_root",
        "set_root",
        "editor quit",
        "runtime quit",
        "quit",
        "invoke_menu",
      ]);
      const quitsByMenu = await live.run("editor invoke_menu", { path: "File/Quit" });
      assert.equal(quitsByMenu.isError, true, textOf(quitsByMenu));

      const cube = await live.run("gameobject create", { name: "LiveCube", primitive: "Cube" });
      assert.equal(cube.isError, undefined, textOf(cube));
      const saved = await live.run("editor save_all");
      assert.equal(saved.isError, undefined, textOf(saved));
      assert.match(await readFile(path.join(live.root, "Assets", "Scenes", "Main.unity"), "utf8"), /LiveCube/);

      const still = await live.run("capture game_view", { source: "camera" });
      const picture = still.content.find((part) => part.type === "image");
      assert.ok(picture?.data?.startsWith(PNG_SIGNATURE), textOf(still));
      const outside = await live.run("capture game_view", { "output-path": path.join(live.base, "outside.png") });
      assert.equal(outside.isError, true, textOf(outside));
      assert.equal(existsSync(path.join(live.base, "outside.png")), false);

      const played = await live.run("editor.playmode start");
      assert.equal(played.isError, undefined, textOf(played));
      await playModeIs(live, "playing");
      const stopped = await live.run("editor.playmode stop");
      assert.equal(stopped.isError, undefined, textOf(stopped));
      await playModeIs(live, "stopped");

      assert.match(await live.tool(UnityTool.QuitEditor), /quit it/);
      assert.equal(await editorRuns(live.root, live.deps), false);
    } finally {
      await live.cleanUp();
    }
  });

  it("keeps working in an editor that still has a project open on Pipeline 0.8", async () => {
    const live = await liveGame();
    try {
      const editor = await newestUnity6(live);
      await withProject(live.game, editor.version, { [PIPELINE_PACKAGE]: PIPELINE_0_8 });
      // Opened as a person opens it, not by Genex: the project stays on the version it asks for.
      await systemOpener(openProjectLaunch(editor, live.root, live.deps.editors.platform));
      assert.equal(await waitForEditor(live.root, live.deps.pipeline, { waitMs: EDITOR_WAIT_MS }), "ready");
      assert.equal((await readDescriptor(live.root))?.grouped, false, "0.8 lists flat names");

      const names = await live.listed();
      for (const name of ["save_scene", "save_all", "capture_game_view", "run_script", "batch"])
        assert.ok(names.includes(name), `${name} is listed`);
      for (const name of ["eval", "eval_file", "quit", "set_authoring_root"])
        assert.ok(!names.includes(name), `${name} is not offered`);
      await refusesWhatAgentsNeverRun(live, ["eval", "eval_file", "quit", "set_authoring_root", "script eval"]);

      const scene = await live.run("create_scene", { path: "Scenes/Main.unity", template: "default" });
      assert.equal(scene.isError, undefined, textOf(scene));
      const cube = await live.run("create_gameobject", { name: "LiveCube", primitive: "Cube" });
      assert.equal(cube.isError, undefined, textOf(cube));
      const still = await live.run("capture_game_view", { source: "camera" });
      assert.ok(
        still.content.some((part) => part.type === "image"),
        textOf(still),
      );
      // Genex's own save and quit name their commands the way this editor knows them.
      assert.match(await live.tool(UnityTool.QuitEditor), /Saved 1 scene in Unity, then quit it/);
      assert.equal(await editorRuns(live.root, live.deps), false);
      assert.match(await readFile(path.join(live.root, "Assets", "Scenes", "Main.unity"), "utf8"), /LiveCube/);
    } finally {
      await live.cleanUp();
    }
  });

  it("moves a closed project from Pipeline 0.8 to the current package as it opens it", async () => {
    const live = await liveGame();
    try {
      const editor = await newestUnity6(live);
      await withProject(live.game, editor.version, { [PIPELINE_PACKAGE]: PIPELINE_0_8 });
      const opened = await live.tool(UnityTool.OpenEditor);
      assert.equal((await manifestOf(live.root)).dependencies[PIPELINE_PACKAGE], PIPELINE_VERSION);
      assert.equal(await waitForEditor(live.root, live.deps.pipeline, { waitMs: EDITOR_WAIT_MS }), "ready", opened);
      assert.equal((await readDescriptor(live.root))?.grouped, true);
      assert.ok((await live.listed()).includes("scene save"));
    } finally {
      await live.cleanUp();
    }
  });
});
