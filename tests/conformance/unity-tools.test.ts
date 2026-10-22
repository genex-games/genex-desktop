import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { agentPlayFolder, agentPlayMarker } from "../../src/plugins/unity/agent-play.ts";
import { createUnityBackend, UnityTool } from "../../src/plugins/unity/backend.ts";
import { type Launch, openProjectLaunch } from "../../src/plugins/unity/editor-launch.ts";
import type { UnityEditor } from "../../src/plugins/unity/editors.ts";
import { PIPELINE_VERSION } from "../../src/plugins/unity/pipeline.ts";
import { rememberedProject } from "../../src/plugins/unity/project-folder.ts";
import {
  backendOn,
  commandsSent,
  look,
  mac,
  manifestOf,
  NOW,
  ok,
  ready,
  realTmp,
  settling,
  withProject,
} from "../helpers/unity-backend.ts";
import {
  editorRow,
  json,
  pluginContext,
  processRow,
  processTable,
  type Reply,
  refusedConnection,
  STAND_IN,
  editor as standInEditor,
  writeDescriptor,
} from "../helpers/unity-editor-stand-in.ts";

describe("whether a Unity game can be made here", () => {
  it("is ready with a Unity 6 installed, and says what the engine question offers", async () => {
    const { call } = await backendOn(["2022.3.13f1", "6000.0.26f1", "6000.3.10f1"]);
    const answer = (await call(UnityTool.EngineStatus, {})) as { ready: boolean; version: string; note: string };
    assert.equal(answer.ready, true);
    assert.equal(answer.version, "6000.3.10f1");
    assert.match(answer.note, /call unity__new-game/);
  });

  it("is not ready with only an older Unity, or none, and sends the person to Unity Hub", async () => {
    const older = (await (await backendOn(["2022.3.13f1"])).call(UnityTool.EngineStatus, {})) as Record<
      string,
      unknown
    >;
    assert.deepEqual([older.ready, older.version], [false, "2022.3.13f1"]);
    assert.match(String(older.note), /older than the Unity 6 .* don't call unity__new-game, .* Unity Hub/);
    const none = (await (await backendOn([])).call(UnityTool.EngineStatus, {})) as Record<string, unknown>;
    assert.deepEqual([none.ready, none.version], [false, null]);
    assert.match(
      String(none.note),
      /isn't installed on this computer yet, .* don't call unity__new-game, .* Unity Hub/,
    );
  });
});

describe("new-game", () => {
  it("makes the game's Unity project, opens it in the newest Unity 6, waits for it and gives it a saved first scene", async () => {
    const { call, game, storage, editors, launches, sleeps, seen } = await backendOn(
      ["6000.0.26f1", "6000.3.10f1"],
      [
        settling(),
        settling(),
        ready(),
        look(),
        ok("Auto-tick enabled"),
        ok(),
        ok({ assetPath: "Assets/Scenes/Main.unity" }),
      ],
    );
    const answer = String(await call(UnityTool.NewGame));
    const root = path.join(game, "unity");
    assert.match(answer, /Made this game's Unity project in unity\/ for Unity 6000\.3\.10f1/);
    assert.match(answer, /the editor answers now/);
    assert.match(answer, /first scene is Assets\/Scenes\/Main\.unity/);
    assert.equal((await manifestOf(root)).dependencies["com.unity.pipeline"], PIPELINE_VERSION);
    assert.equal(
      await readFile(path.join(root, "ProjectSettings", "ProjectVersion.txt"), "utf8"),
      "m_EditorVersion: 6000.3.10f1\n",
    );
    assert.deepEqual(await rememberedProject(storage, "lantern"), { root, game });
    const newest = editors.find((installed) => installed.version === "6000.3.10f1");
    assert.deepEqual(launches, [
      { command: "/usr/bin/open", args: ["-n", "-a", newest?.app, "--args", "-projectPath", root], detached: false },
    ]);
    assert.deepEqual(sleeps, [2000, 2000], "it asks again every two seconds until Unity is ready");
    assert.deepEqual(
      commandsSent(seen),
      ["set_autotick", "eval", "create_scene"],
      "the editor keeps ticking, the game runs in the background, and no untitled scene is left to save",
    );
  });

  it("says so when the first scene could not be made, and what to do before anything else", async () => {
    const failed = json(400, { success: false, error: "Command Execution Failed", errorDetails: "Disk full" });
    const { call } = await backendOn(["6000.3.10f1"], [ready(), look(), ok(), ok(), failed]);
    const answer = String(await call(UnityTool.NewGame));
    assert.match(answer, /first scene could not be made \(Command Execution Failed: Disk full\).* create_scene/);
  });

  it("says Unity is still starting when it is not ready within the wait, without failing", async () => {
    const { call, launches, seen } = await backendOn(["6000.3.10f1"], Array.from({ length: 200 }, settling));
    const answer = String(await call(UnityTool.NewGame));
    assert.match(answer, /Made this game's Unity project in unity\//);
    assert.match(answer, /not ready yet .* call again in a moment/);
    assert.equal(launches.length, 1);
    assert.deepEqual(commandsSent(seen), [], "nothing is asked of an editor that is not ready");
  });

  it("keeps the project it made when Unity can't be opened, and says why", async () => {
    const { env } = await mac(["6000.3.10f1"]);
    const game = await realTmp("unity-game-");
    const storage = await realTmp("unity-storage-");
    const backend = createUnityBackend({
      now: NOW,
      editors: env,
      pipeline: standInEditor([]).deps,
      processes: processTable().env,
      idleMs: async () => undefined,
      open: async () => {
        throw new Error("The application cannot be opened");
      },
    });
    const bound = pluginContext(storage, { project: "lantern", directory: game });
    const answer = String(await backend.tool?.(UnityTool.NewGame, {}, bound));
    assert.match(answer, /but Unity didn't open it: The application cannot be opened\. .* Unity Hub/);
    assert.deepEqual(await rememberedProject(storage, "lantern"), { root: path.join(game, "unity"), game });
  });

  it("refuses with nothing made when there is no game, no Unity 6, or the game already has a project", async () => {
    const noGame = await backendOn(["6000.3.10f1"]);
    await assert.rejects(async () => noGame.call(UnityTool.NewGame, {}), /Open a game in Genex first/);

    const older = await backendOn(["2022.3.13f1"]);
    await assert.rejects(async () => older.call(UnityTool.NewGame), /needs Unity 6.*Unity Hub/);

    const taken = await backendOn(["6000.3.10f1"]);
    await withProject(taken.game, "6000.3.10f1");
    await assert.rejects(async () => taken.call(UnityTool.NewGame), /already holds a Unity project/);

    const place = await backendOn(["6000.3.10f1"]);
    await writeFile(path.join(place.game, "unity"), "notes");
    await assert.rejects(async () => place.call(UnityTool.NewGame), /already has something named unity/);

    for (const refused of [noGame, older, taken, place]) assert.deepEqual(refused.launches, []);
    assert.equal(await rememberedProject(older.storage, "lantern"), undefined);
  });
});

describe("setup", () => {
  it("adds the Pipeline package to the game's existing project, keeps it for the connector and opens it in its own Unity", async () => {
    const { call, game, storage, editors, launches } = await backendOn(["6000.0.26f1", "6000.3.10f1"], [ready()]);
    const root = await withProject(game, "6000.0.26f1", { "com.unity.ugui": "2.0.0" });
    const answer = String(await call(UnityTool.Setup));
    assert.match(answer, /Added Unity's Pipeline package/);
    assert.match(answer, /opened .* the editor answers now/);
    assert.deepEqual(await manifestOf(root), {
      dependencies: { "com.unity.pipeline": PIPELINE_VERSION, "com.unity.ugui": "2.0.0" },
    });
    assert.deepEqual(await rememberedProject(storage, "lantern"), { root, game });
    const own = editors.find((installed) => installed.version === "6000.0.26f1");
    assert.ok(own);
    assert.deepEqual(launches, [openProjectLaunch(own, root, "darwin")], "the project's own Unity, not the newest");
  });

  it("opens nothing an editor already has open: one that answers, or one that runs without answering yet", async () => {
    const answering = await backendOn(["6000.3.10f1"], [ready(), look(), ok()]);
    await answering.openIn(await withProject(answering.game, "6000.3.10f1"));
    assert.match(
      String(await answering.call(UnityTool.Setup)),
      /Unity has this project open: bring Unity to the front/,
    );

    const running = await backendOn(["6000.3.10f1"]);
    const held = await withProject(running.game, "6000.3.10f1", { "com.unity.pipeline": PIPELINE_VERSION });
    running.table.start(editorRow(55, held));
    assert.match(String(await running.call(UnityTool.Setup)), /already asks for Unity's Pipeline package/);
    assert.match(
      String(await running.call(UnityTool.OpenEditor)),
      /Unity has this project open, but its Pipeline server does not answer yet/,
    );
    assert.deepEqual([answering.launches, running.launches], [[], []]);
  });

  it("refuses a project it can't set up, in words that say what to do", async () => {
    const none = await backendOn(["6000.3.10f1"]);
    await assert.rejects(async () => none.call(UnityTool.Setup), /holds no Unity project/);

    const old = await backendOn(["2022.3.13f1", "6000.3.10f1"]);
    const root = await withProject(old.game, "2022.3.13f1");
    await assert.rejects(async () => old.call(UnityTool.Setup), /saved with Unity 2022\.3\.13f1.*needs Unity 6/);
    assert.deepEqual(await manifestOf(root), { dependencies: {} });

    const broken = await backendOn(["6000.3.10f1"]);
    const unreadable = await withProject(broken.game, "6000.3.10f1");
    await writeFile(path.join(unreadable, "Packages", "manifest.json"), "{ nope");
    await assert.rejects(async () => broken.call(UnityTool.Setup), /Packages\/manifest\.json can't be read/);
    for (const refused of [none, old, broken]) assert.deepEqual(refused.launches, []);
  });

  it("takes the package back on undo-setup, and says so when there is nothing of Genex's to take back", async () => {
    const { call, game, launches } = await backendOn(["6000.3.10f1"], [ready()]);
    const root = await withProject(game, "6000.3.10f1", { "com.unity.ugui": "2.0.0" });
    await call(UnityTool.Setup);
    assert.match(String(await call(UnityTool.UndoSetup)), /Took Unity's Pipeline package back out/);
    assert.deepEqual(await manifestOf(root), { dependencies: { "com.unity.ugui": "2.0.0" } });
    assert.match(String(await call(UnityTool.UndoSetup)), /Genex added nothing .* that is still as it wrote it/);
    assert.equal(launches.length, 1, "undoing opens nothing");
  });
});

describe("open-editor", () => {
  it("opens the game's project in the Unity it was saved with, waits for it and keeps it ticking", async () => {
    const { call, game, editors, launches, seen } = await backendOn(["6000.3.10f1"], [ready(), look(), ok()]);
    const root = await withProject(game, "6000.3.10f1", { "com.unity.pipeline": PIPELINE_VERSION });
    assert.match(
      String(await call(UnityTool.OpenEditor)),
      /Opened this game's Unity project .* the editor answers now/,
    );
    assert.deepEqual(launches, [openProjectLaunch(editors[0] as UnityEditor, root, "darwin")]);
    assert.deepEqual(commandsSent(seen), ["set_autotick"]);
  });

  it("says the project is open already when its editor answers", async () => {
    const { call, game, launches, openIn } = await backendOn(["6000.3.10f1"], [ready(), look(), ok()]);
    await openIn(await withProject(game, "6000.3.10f1", { "com.unity.pipeline": PIPELINE_VERSION }));
    assert.match(String(await call(UnityTool.OpenEditor)), /already open in Unity and answers/);
    assert.deepEqual(launches, []);
  });

  it("opens a project whose last editor was killed: what it left behind stands in nobody's way", async () => {
    const { call, game, launches } = await backendOn(["6000.3.10f1"], [ready()]);
    const root = await withProject(game, "6000.3.10f1", { "com.unity.pipeline": PIPELINE_VERSION });
    await mkdir(path.join(root, "Temp"));
    await writeFile(path.join(root, "Temp", "UnityLockfile"), "");
    await writeDescriptor(root, { pid: 31337, port: 7800, evalToken: "left-behind" });
    assert.match(String(await call(UnityTool.OpenEditor)), /Opened this game's Unity project/);
    assert.equal(launches.length, 1);
  });

  it("opens a project whose stale descriptor names another app's process, and leaves that app alone", async () => {
    // Nothing of Unity's listens on the port the stale descriptor names.
    const { call, game, launches, table } = await backendOn(["6000.3.10f1"], [refusedConnection(), ready()]);
    const root = await withProject(game, "6000.3.10f1", { "com.unity.pipeline": PIPELINE_VERSION });
    await writeDescriptor(root, { pid: 31337, port: 7800, evalToken: "left-behind" });
    table.start(processRow(31337, "/Applications/Safari.app/Contents/MacOS/Safari", ""));
    assert.match(String(await call(UnityTool.OpenEditor)), /Opened this game's Unity project/);
    assert.equal(launches.length, 1);
    assert.deepEqual(table.sent, []);
  });

  it("sets aside the scene backups a killed editor left, so Unity opens without asking to recover them", async () => {
    const { call, game, storage, launches } = await backendOn(["6000.3.10f1"], [ready()]);
    const root = await withProject(game, "6000.3.10f1", { "com.unity.pipeline": PIPELINE_VERSION });
    await mkdir(path.join(root, "Temp", "__Backupscenes"), { recursive: true });
    await writeFile(path.join(root, "Temp", "__Backupscenes", "0.backup"), "an unsaved scene");
    const answer = String(await call(UnityTool.OpenEditor));
    assert.match(answer, /Opened this game's Unity project/);
    assert.match(answer, /backups of scenes that were unsaved when Unity last ended.* moved them to /);
    assert.equal(
      existsSync(path.join(root, "Temp", "__Backupscenes")),
      false,
      "nothing is left for Unity to ask about",
    );
    const kept = path.join(storage, "recovered", "lantern");
    const [stamp] = await readdir(kept);
    assert.equal(stamp, "2026-10-14T09-00-00-000Z");
    assert.equal(
      await readFile(path.join(kept, String(stamp), "0.backup"), "utf8"),
      "an unsaved scene",
      "kept, not deleted",
    );
    assert.ok(answer.includes(path.join(kept, String(stamp))), "the answer says where they are");
    assert.equal(launches.length, 1);
  });

  it("leaves an open editor's own scene backups alone, and never follows a link out of the project for them", async () => {
    const open = await backendOn(["6000.3.10f1"], [ready(), look(), ok()]);
    const root = await withProject(open.game, "6000.3.10f1", { "com.unity.pipeline": PIPELINE_VERSION });
    await mkdir(path.join(root, "Temp", "__Backupscenes"), { recursive: true });
    await open.openIn(root);
    assert.match(String(await open.call(UnityTool.OpenEditor)), /already open in Unity and answers/);
    assert.equal(existsSync(path.join(root, "Temp", "__Backupscenes")), true, "a playing editor keeps them there");

    const linked = await backendOn(["6000.3.10f1"], [ready()]);
    const outside = await realTmp("unity-outside-");
    await mkdir(path.join(outside, "__Backupscenes"));
    await writeFile(path.join(outside, "__Backupscenes", "0.backup"), "someone else's");
    const other = await withProject(linked.game, "6000.3.10f1", { "com.unity.pipeline": PIPELINE_VERSION });
    await symlink(outside, path.join(other, "Temp"));
    assert.doesNotMatch(String(await linked.call(UnityTool.OpenEditor)), /backups of scenes/);
    assert.equal(
      existsSync(path.join(outside, "__Backupscenes", "0.backup")),
      true,
      "nothing outside the project moved",
    );
    assert.equal(existsSync(path.join(linked.storage, "recovered")), false);
  });

  it("never opens a project in another Unity than its own, or one with no Pipeline package", async () => {
    const other = await backendOn(["6000.3.10f1"]);
    await withProject(other.game, "6000.0.26f1", { "com.unity.pipeline": PIPELINE_VERSION });
    assert.match(
      String(await other.call(UnityTool.OpenEditor)),
      /saved with Unity 6000\.0\.26f1, which isn't installed here \(installed: 6000\.3\.10f1\).* Unity Hub/,
    );

    const bare = await backendOn(["6000.3.10f1"]);
    await withProject(bare.game, "6000.3.10f1");
    assert.match(String(await bare.call(UnityTool.OpenEditor)), /has no Pipeline package yet: call unity__setup/);

    const none = await backendOn(["6000.3.10f1"]);
    await assert.rejects(async () => none.call(UnityTool.OpenEditor), /holds no Unity project/);
    assert.deepEqual([other.launches, bare.launches, none.launches], [[], [], []]);
  });
});

describe("restart-editor", () => {
  it("ends an editor whose main thread is stalled, as behind a dialog, and opens the project again", async () => {
    const stalled = await backendOn(["6000.3.10f1"], [new Error("no answer"), ready()]);
    const root = await withProject(stalled.game, "6000.3.10f1", { "com.unity.pipeline": PIPELINE_VERSION });
    await stalled.openIn(root);
    // The look at the main thread runs out of its time: the editor is stalled.
    stalled.deps.timeout = () => AbortSignal.abort();
    const answer = String(await stalled.call(UnityTool.RestartEditor));
    assert.deepEqual(stalled.table.sent, [[STAND_IN.pid, "SIGTERM"]], "a stalled editor is signalled, never asked");
    assert.match(answer, /Ended Unity and opened this game's project again in Unity 6000\.3\.10f1/);
    assert.equal(stalled.launches.length, 1);
  });

  it("gives the editor it opened two minutes to answer, so ending and opening stay inside the host's limit for one call", async () => {
    const slow = await backendOn(
      ["6000.3.10f1"],
      Array.from({ length: 100 }, () => settling()),
    );
    await withProject(slow.game, "6000.3.10f1", { "com.unity.pipeline": PIPELINE_VERSION });
    assert.match(String(await slow.call(UnityTool.RestartEditor)), /Unity is not ready yet/);
    const waited = slow.sleeps.reduce((total, ms) => total + ms, 0);
    assert.equal(waited, 120_000, "ending may take half a minute, and the host ends a call at 190 s");
  });

  it("opens the project when no editor has it open, and says so when the editor can't be ended", async () => {
    const closed = await backendOn(["6000.3.10f1"], [ready()]);
    await withProject(closed.game, "6000.3.10f1", { "com.unity.pipeline": PIPELINE_VERSION });
    assert.match(String(await closed.call(UnityTool.RestartEditor)), /opened this game's project again/);
    assert.deepEqual(closed.table.sent, []);

    const { env } = await mac(["6000.3.10f1"]);
    const game = await realTmp("unity-game-");
    const root = await withProject(game, "6000.3.10f1", { "com.unity.pipeline": PIPELINE_VERSION });
    const stubborn = processTable([editorRow(8, root)], { 8: [] });
    const launches: Launch[] = [];
    const backend = createUnityBackend({
      now: NOW,
      editors: env,
      pipeline: standInEditor([]).deps,
      processes: stubborn.env,
      idleMs: async () => undefined,
      open: async (launch) => void launches.push(launch),
    });
    const bound = pluginContext(await realTmp("unity-storage-"), { project: "lantern", directory: game });
    assert.match(String(await backend.tool?.(UnityTool.RestartEditor, {}, bound)), /Unity could not be ended/);
    assert.deepEqual(launches, [], "a second editor is never opened beside one that would not end");
  });
});

/** The editor's list of its open scenes: each by its path (empty: never saved) and whether it has unsaved work. */
const sceneList = (...listed: Array<[string, boolean]>) =>
  ok({ scenes: listed.map(([scenePath, isDirty]) => ({ path: scenePath, isDirty, isLoaded: true })) });
const playingLook = () => json(200, { status: "playing", playMode: "playing" });
const MAIN_SCENE = "Assets/Scenes/Main.unity";
/** The C# Genex's clean exit runs in the editor. */
const EXIT = "UnityEditor.EditorApplication.Exit(0);";
const codesSent = (seen: { body: unknown }[]) =>
  seen.map((request) => (request.body as { parameters?: { code?: string } } | undefined)?.parameters?.code);

/** A game whose set-up project an editor has open, its server answering with what the test pushes onto `replies`. */
async function openUnity() {
  const replies: Reply[] = [];
  const backend = await backendOn(["6000.3.10f1"], replies);
  const root = await withProject(backend.game, "6000.3.10f1", { "com.unity.pipeline": PIPELINE_VERSION });
  await backend.openIn(root);
  /** Unity's answer to Genex's clean exit: the editor is gone before it can say more. */
  const exits = () => () => {
    backend.table.end(STAND_IN.pid);
    return ok();
  };
  return { ...backend, root, replies, exits };
}

describe("quit-editor", () => {
  it("saves every scene with unsaved work and the assets through Unity, then quits it cleanly", async () => {
    const unity = await openUnity();
    unity.replies.push(
      look(),
      sceneList([MAIN_SCENE, true], ["Assets/Scenes/Menu.unity", false]),
      ok({ saved: true }),
      ok(),
      look(),
      unity.exits(),
    );
    const answer = String(await unity.call(UnityTool.QuitEditor));
    assert.match(answer, /Saved 1 scene in Unity, then quit it\. .*unity__open-editor/);
    assert.deepEqual(commandsSent(unity.seen), ["list_open_scenes", "save_scene", "eval", "eval"]);
    assert.equal(codesSent(unity.seen).at(-1), EXIT, "Unity's own exit, after the save");
    assert.deepEqual(unity.table.running(), []);
    assert.deepEqual(unity.table.sent, [], "a saved editor exits by itself and is never signalled");
    assert.deepEqual(unity.launches, []);
  });

  it("stops the agent's own play before it saves, and refuses the person's", async () => {
    const agents = await openUnity();
    await agentPlayMarker(agentPlayFolder(agents.storage, "lantern") ?? "", () => NOW().getTime()).started();
    agents.replies.push(playingLook(), ok(), sceneList([MAIN_SCENE, false]), ok(), look(), agents.exits());
    assert.match(String(await agents.call(UnityTool.QuitEditor)), /quit it/);
    assert.deepEqual(commandsSent(agents.seen), ["editor_stop", "list_open_scenes", "eval", "eval"]);

    const person = await openUnity();
    person.replies.push(playingLook());
    await assert.rejects(async () => person.call(UnityTool.QuitEditor), /user is playing the game in Unity/);
    assert.deepEqual([person.table.running(), commandsSent(person.seen)], [[STAND_IN.pid], []]);
  });

  it("leaves Unity open when work stays unsaved: a scene that has no file, or a save Unity refused", async () => {
    const untitled = await openUnity();
    untitled.replies.push(look(), sceneList(["", true]), ok());
    await assert.rejects(
      async () => untitled.call(UnityTool.QuitEditor),
      /never been saved.*save_scene.*Genex left Unity open/,
    );
    assert.deepEqual(untitled.table.running(), [STAND_IN.pid]);
    assert.ok(!codesSent(untitled.seen).includes(EXIT), "no exit is sent");

    const refused = await openUnity();
    refused.replies.push(
      look(),
      sceneList([MAIN_SCENE, true]),
      json(400, { success: false, error: "Command Execution Failed", errorDetails: "read-only file" }),
    );
    await assert.rejects(
      async () => refused.call(UnityTool.QuitEditor),
      /couldn't save .*read-only file.*left Unity open/,
    );
    assert.deepEqual([refused.table.running(), refused.table.sent], [[STAND_IN.pid], []]);
  });

  it("never quits an editor it can't ask to save, and says what to call instead", async () => {
    const stalled = await openUnity();
    stalled.replies.push(new Error("no answer"));
    stalled.deps.timeout = () => AbortSignal.abort();
    await assert.rejects(
      async () => stalled.call(UnityTool.QuitEditor),
      /can't save its work, so Genex didn't quit it.*unity__restart-editor/,
    );
    assert.deepEqual([stalled.table.running(), stalled.table.sent], [[STAND_IN.pid], []]);
  });

  it("has nothing to quit when no editor has the project open", async () => {
    const closed = await backendOn(["6000.3.10f1"]);
    await withProject(closed.game, "6000.3.10f1", { "com.unity.pipeline": PIPELINE_VERSION });
    assert.match(String(await closed.call(UnityTool.QuitEditor)), /Unity doesn't have this game's project open/);
    assert.deepEqual([closed.seen, closed.launches, closed.table.sent], [[], [], []]);
  });
});

describe("restart-editor on an editor that answers", () => {
  it("saves its work through Unity first, its play stopped, then ends it cleanly and opens the project again", async () => {
    const unity = await openUnity();
    unity.replies.push(
      playingLook(),
      ok(),
      sceneList([MAIN_SCENE, true]),
      ok({ saved: true }),
      ok(),
      unity.exits(),
      ready(),
      look(),
      ok(),
    );
    assert.match(String(await unity.call(UnityTool.RestartEditor)), /Ended Unity and opened this game's project again/);
    assert.deepEqual(commandsSent(unity.seen), [
      "editor_stop",
      "list_open_scenes",
      "save_scene",
      "eval",
      "eval",
      "set_autotick",
    ]);
    assert.deepEqual(unity.table.sent, [], "a saved editor exits by itself and is never signalled");
    assert.equal(unity.launches.length, 1);
  });
});

describe("setup of a project Unity never opened", () => {
  it("opens it in its own Unity without waiting, Unity writes its manifest, and says to call setup again", async () => {
    const { call, game, launches } = await backendOn(["6000.3.10f1"], [settling()]);
    const root = await withProject(game, "6000.3.10f1");
    await rm(path.join(root, "Packages", "manifest.json"));
    const answer = String(await call(UnityTool.Setup));
    assert.match(
      answer,
      /had no Packages\/manifest\.json yet, so Genex opened it in Unity 6000\.3\.10f1.*Call unity__setup again/,
    );
    assert.doesNotMatch(answer, /ask the user/);
    assert.equal(launches.length, 1);
  });
});
