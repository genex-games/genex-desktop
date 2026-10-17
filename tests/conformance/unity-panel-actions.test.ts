import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PluginToolbarStatus } from "../../src/plugin-sdk/index.d.ts";
import { UnityAction } from "../../src/plugins/unity/backend.ts";
import { getUnityLaunch, openProjectLaunch, UNITY_DOWNLOAD_URL } from "../../src/plugins/unity/editor-launch.ts";
import { Opened } from "../../src/plugins/unity/editor-open.ts";
import type { UnityEditor } from "../../src/plugins/unity/editors.ts";
import { PanelStep, type PanelStatus } from "../../src/plugins/unity/panel-status.ts";
import { PIPELINE_VERSION } from "../../src/plugins/unity/pipeline.ts";
import { backendOn, commandsSent, look, manifestOf, ok, ready, withProject } from "../helpers/unity-backend.ts";
import { editorRow, json, type Reply, refusedConnection, STAND_IN } from "../helpers/unity-editor-stand-in.ts";

const UNITY_6 = "6000.3.10f1";
const SET_UP = { "com.unity.pipeline": PIPELINE_VERSION };
const NO_GAME = {};

type Backend = Awaited<ReturnType<typeof backendOn>>;
const statusOf = async (backend: Backend, binding?: Record<string, never>) =>
  (await backend.act(UnityAction.Status, {}, binding)) as PanelStatus;
const wordOf = async (backend: Backend, binding?: Record<string, never>) =>
  (await backend.act(UnityAction.ToolbarStatus, {}, binding)) as PluginToolbarStatus;

/** A game with a set-up Unity 6 project, its editor installed. */
async function setUpGame(replies: Reply[] = []) {
  const backend = await backendOn([UNITY_6], replies);
  const root = await withProject(backend.game, UNITY_6, SET_UP);
  return { ...backend, root };
}

/** The same game with an editor that has the project open. */
async function openGame(replies: Reply[] = []) {
  const game = await setUpGame(replies);
  await game.openIn(game.root);
  return game;
}

describe("where a game's Unity stands, for the panel and the toolbar button", () => {
  it("asks for Unity 6 while none is installed and the game has no project to open", async () => {
    const none = await backendOn([]);
    assert.deepEqual(await statusOf(none), { step: PanelStep.GetUnity, installed: [] });
    assert.deepEqual(await statusOf(none, NO_GAME), { step: PanelStep.GetUnity, installed: [] });
    const word = await wordOf(none);
    // The plugin page's Editor row reads this word, so it says what is true, never Ready.
    assert.equal(word.badge, "Not installed");
    assert.equal(word.tone, "info");
    assert.match(String(word.title), /Unity 6 isn't installed/);

    const older = await backendOn(["2022.3.13f1"]);
    assert.deepEqual(await statusOf(older), { step: PanelStep.GetUnity, installed: ["2022.3.13f1"] });
  });

  it("says so when no game is open, or the open game holds no Unity project, with no badge on the button", async () => {
    const backend = await backendOn([UNITY_6]);
    assert.deepEqual(await statusOf(backend, NO_GAME), { step: PanelStep.NoGame, installed: [UNITY_6] });
    assert.deepEqual(await statusOf(backend), { step: PanelStep.NoProject, installed: [UNITY_6] });
    const word = await wordOf(backend);
    assert.equal(word.badge, undefined, "a web game's toolbar carries no word about Unity");
    assert.match(String(word.title), /no Unity project/);
  });

  it("names the project's folder and Unity, and whether it is set up", async () => {
    const old = await backendOn(["2022.3.13f1", UNITY_6]);
    await withProject(old.game, "2022.3.13f1");
    const installed = [UNITY_6, "2022.3.13f1"];
    assert.deepEqual(await statusOf(old), {
      step: PanelStep.OldProject,
      folder: "unity",
      version: "2022.3.13f1",
      installed,
    });

    const plain = await backendOn([UNITY_6]);
    await withProject(plain.game, UNITY_6, { "com.unity.ugui": "2.0.0" });
    assert.deepEqual(await statusOf(plain), {
      step: PanelStep.NotSetUp,
      folder: "unity",
      version: UNITY_6,
      installed: [UNITY_6],
    });
    for (const backend of [old, plain]) {
      const word = await wordOf(backend);
      assert.deepEqual([word.badge, word.dot], ["Not set up", true]);
    }
  });

  it("says a set-up project is not open, or that the Unity it was saved with isn't installed", async () => {
    const closed = await setUpGame();
    assert.deepEqual(await statusOf(closed), {
      step: PanelStep.NotOpen,
      folder: "unity",
      version: UNITY_6,
      installed: [UNITY_6],
    });
    assert.deepEqual(await wordOf(closed), { badge: "Not open", tone: "info", dot: true, title: "Unity isn't open" });

    const other = await backendOn(["6000.0.26f1"]);
    await withProject(other.game, UNITY_6, SET_UP);
    assert.equal((await statusOf(other)).step, PanelStep.NoEditor);
    const word = await wordOf(other);
    assert.equal(word.badge, "Not open");
    assert.match(String(word.title), /Unity 6000\.3\.10f1 isn't installed/);
  });

  it("says Unity is starting while an editor has the project open and does not answer", async () => {
    const silent = await setUpGame();
    silent.table.start(editorRow(55, silent.root));
    assert.equal((await statusOf(silent)).step, PanelStep.Opening, "an editor with no server yet");

    const refusing = await openGame([refusedConnection(), refusedConnection()]);
    assert.equal((await statusOf(refusing)).step, PanelStep.Opening, "a server that isn't listening yet");
    assert.deepEqual(await wordOf(refusing), {
      badge: "Starting",
      tone: "warn",
      dot: true,
      title: "Unity is starting",
    });
  });

  it("says Unity is ready once its main thread answers, and whether it plays or compiles", async () => {
    const idle = await openGame([look(), look()]);
    assert.deepEqual(await statusOf(idle), {
      step: PanelStep.Ready,
      folder: "unity",
      version: UNITY_6,
      installed: [UNITY_6],
      playing: false,
      compiling: false,
    });
    assert.deepEqual(await wordOf(idle), { badge: "Ready", tone: "ok", dot: true, title: "Unity is open and answers" });

    const busy = await openGame([json(200, { playMode: "playing", compiling: true })]);
    const status = await statusOf(busy);
    assert.deepEqual([status.step, status.playing, status.compiling], [PanelStep.Ready, true, true]);
  });

  it("says Unity is stalled when its main thread runs nothing, and draws the button's attention", async () => {
    const stalled = await openGame([new Error("no answer"), new Error("no answer")]);
    stalled.deps.timeout = () => AbortSignal.abort();
    assert.equal((await statusOf(stalled)).step, PanelStep.Stalled);
    const word = await wordOf(stalled);
    assert.deepEqual([word.badge, word.tone, word.attention], ["Stalled", "warn", true]);
    assert.match(String(word.title), /isn't answering/);
  });

  it("only looks: it sends the editor no command, opens nothing and signals nothing", async () => {
    const game = await openGame([look(), look()]);
    await statusOf(game);
    await wordOf(game);
    assert.deepEqual(
      game.seen.map((request) => [request.method, new URL(request.url).pathname]),
      [
        ["GET", "/api/editor_status"],
        ["GET", "/api/editor_status"],
      ],
    );
    assert.deepEqual([game.launches, game.table.sent, commandsSent(game.seen)], [[], [], []]);
  });
});

describe("the Unity panel's actions", () => {
  it("opens the game's project in the Unity it was saved with and keeps it ticking", async () => {
    const game = await setUpGame([ready(), look(), ok()]);
    assert.deepEqual(await game.act(UnityAction.OpenEditor), { opened: Opened.Ready, version: UNITY_6 });
    assert.deepEqual(game.launches, [openProjectLaunch(game.editors[0] as UnityEditor, game.root, "darwin")]);
    assert.deepEqual(commandsSent(game.seen), ["set_autotick"]);
  });

  it("opens only the open game's own project, whatever a panel sends with the press", async () => {
    const hostile: Array<Record<string, unknown>> = [
      { project: "/etc" },
      { root: "../../.." },
      { directory: "/", projectPath: "/Applications" },
      { editor: "/bin/sh", args: ["-c", "true"] },
      { version: "2022.3.13f1" },
    ];
    for (const args of hostile) {
      const game = await setUpGame([ready(), look(), ok()]);
      await game.act(UnityAction.OpenEditor, args);
      assert.deepEqual(
        game.launches,
        [openProjectLaunch(game.editors[0] as UnityEditor, game.root, "darwin")],
        JSON.stringify(args),
      );
    }
  });

  it("refuses to open with nothing started when there is no game, no project, or no setup", async () => {
    const bare = await backendOn([UNITY_6]);
    await assert.rejects(async () => bare.act(UnityAction.OpenEditor, {}, NO_GAME), /Open a game first/);
    await assert.rejects(async () => bare.act(UnityAction.OpenEditor), /no Unity project/);
    await withProject(bare.game, UNITY_6);
    await assert.rejects(async () => bare.act(UnityAction.OpenEditor), /Set this project up first/);
    assert.deepEqual(bare.launches, []);
  });

  it("sets the project up and opens it, in words for the person when it can't", async () => {
    const game = await backendOn([UNITY_6], [ready()]);
    const root = await withProject(game.game, UNITY_6, { "com.unity.ugui": "2.0.0" });
    assert.deepEqual(await game.act(UnityAction.Setup), {
      changed: true,
      version: PIPELINE_VERSION,
      opening: { opened: Opened.Ready, version: UNITY_6 },
    });
    assert.deepEqual(await manifestOf(root), { dependencies: { ...SET_UP, "com.unity.ugui": "2.0.0" } });

    const old = await backendOn(["2022.3.13f1", UNITY_6]);
    const untouched = await withProject(old.game, "2022.3.13f1");
    await assert.rejects(
      async () => old.act(UnityAction.Setup),
      (error: Error) => {
        assert.match(error.message, /saved with Unity 2022\.3\.13f1.*Upgrade it in Unity Hub/);
        assert.doesNotMatch(error.message, /ask the user|call again|unity__/, "a person reads this, not an agent");
        return true;
      },
    );
    assert.deepEqual(await manifestOf(untouched), { dependencies: {} });
    assert.deepEqual(old.launches, []);
  });

  it("takes the setup back, and says when nothing of Genex's was left to take", async () => {
    const game = await backendOn([UNITY_6], [ready()]);
    const root = await withProject(game.game, UNITY_6, { "com.unity.ugui": "2.0.0" });
    await game.act(UnityAction.Setup);
    assert.deepEqual(await game.act(UnityAction.UndoSetup), { changed: true });
    assert.deepEqual(await manifestOf(root), { dependencies: { "com.unity.ugui": "2.0.0" } });
    assert.deepEqual(await game.act(UnityAction.UndoSetup), { changed: false });
  });

  it("ends a stalled editor and opens the project again, and opens no second editor beside one that won't end", async () => {
    const stalled = await openGame([new Error("no answer"), ready()]);
    stalled.deps.timeout = () => AbortSignal.abort();
    assert.deepEqual(await stalled.act(UnityAction.RestartEditor), {
      ended: true,
      opening: { opened: Opened.Ready, version: UNITY_6 },
    });
    assert.deepEqual(stalled.table.sent, [[STAND_IN.pid, "SIGTERM"]]);
    assert.equal(stalled.launches.length, 1);

    const stubborn = await backendOn([UNITY_6], [], { ends: { 8: [] } });
    const root = await withProject(stubborn.game, UNITY_6, SET_UP);
    stubborn.table.start(editorRow(8, root));
    assert.deepEqual(await stubborn.act(UnityAction.RestartEditor), { ended: false });
    assert.deepEqual(stubborn.launches, []);
  });

  it("gets Unity through Unity Hub when it is installed, else from Unity's download page", async () => {
    const without = await backendOn([]);
    assert.deepEqual(await without.act(UnityAction.GetUnity), { opened: "download" });
    assert.deepEqual(without.launches, [{ command: "/usr/bin/open", args: [UNITY_DOWNLOAD_URL], detached: false }]);

    const withHub = await backendOn([]);
    const hub = path.join(withHub.env.applications, "Unity Hub.app");
    await mkdir(path.join(hub, "Contents"), { recursive: true });
    assert.deepEqual(await withHub.act(UnityAction.GetUnity, { url: "https://example.com", app: "/bin/sh" }), {
      opened: "hub",
    });
    assert.deepEqual(withHub.launches, [{ command: "/usr/bin/open", args: ["-a", hub], detached: false }]);
    for (const backend of [without, withHub])
      assert.deepEqual(backend.table.running(), [], "neither Hub nor a web page is an editor with a project open");

    const linked = await backendOn([]);
    await writeFile(path.join(linked.env.applications, "Unity Hub.app"), "not an app");
    assert.deepEqual(await linked.act(UnityAction.GetUnity), { opened: "download" }, "a file by that name is no Hub");
  });

  it("starts Hub or the browser on Windows by its own programs, never through a shell", () => {
    const hub = "C:\\Program Files\\Unity Hub\\Unity Hub.exe";
    assert.deepEqual(getUnityLaunch("win32", hub, { SystemRoot: "C:\\Windows" }), {
      command: hub,
      args: [],
      detached: true,
    });
    assert.deepEqual(getUnityLaunch("win32", undefined, { SystemRoot: "C:\\Windows" }), {
      command: "C:\\Windows\\explorer.exe",
      args: [UNITY_DOWNLOAD_URL],
      detached: true,
    });
  });

  it("refuses an action it does not have", async () => {
    const backend = await backendOn([UNITY_6]);
    await assert.rejects(async () => backend.act("quit-editor"), /Unknown Unity action quit-editor/);
  });
});
