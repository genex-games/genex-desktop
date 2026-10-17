import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  type EditorDeps,
  editorRuns,
  endEditor,
  firstSetup,
  openPids,
  saveWork,
} from "../../src/plugins/unity/editor-life.ts";
import { PipelineProblem } from "../../src/plugins/unity/pipeline.ts";
import type { ProcessRow } from "../../src/plugins/unity/processes.ts";
import {
  EDITOR_PROGRAM,
  editor,
  editorRow,
  json,
  openProject,
  processRow,
  processTable,
  type Reply,
  type Seen,
  STAND_IN,
  unityProject,
} from "../helpers/unity-editor-stand-in.ts";

/** A Windows editor's program, as Windows' task list names it. */
const WINDOWS_EDITOR = "Unity.exe";
const ok = (result: unknown = {}) => json(200, { success: true, result });
const look = () => json(200, { status: "ready", playMode: "stopped" });
const scenes = (...listed: Array<[string, boolean]>) =>
  ok({ scenes: listed.map(([path, isDirty]) => ({ path, isDirty, isLoaded: true })) });
const sent = (seen: Seen[]) =>
  seen
    .map((request) => request.body as { command?: string; parameters?: Record<string, unknown> } | undefined)
    .filter((body) => body?.command)
    .map((body) => [body?.command, body?.parameters]);

/** An open project whose editor is the process the descriptor names, with these answers. */
async function live(replies: Reply[], ends?: Record<number, NodeJS.Signals[]>) {
  const root = await openProject();
  const table = processTable([editorRow(STAND_IN.pid, root)], ends);
  const stand = editor(replies, { alive: (pid) => table.running().includes(pid) });
  const deps: EditorDeps = { pipeline: stand.deps, processes: table.env };
  return { root, deps, table, seen: stand.seen, sleeps: stand.sleeps };
}

describe("whether an editor has a game's project open", () => {
  it("is so by its process, by a descriptor whose process runs, and by nothing a dead editor left", async () => {
    const { root, deps, table } = await live([]);
    assert.deepEqual(await openPids(root, deps), [STAND_IN.pid]);
    table.end(STAND_IN.pid);
    assert.equal(await editorRuns(root, deps), false, "its descriptor is still on disk and names nobody");

    const elsewhere = processTable([editorRow(77, "/another/project")]);
    const served = editor([], { alive: () => true });
    const unlisted: EditorDeps = { pipeline: served.deps, processes: elsewhere.env };
    assert.deepEqual(await openPids(root, unlisted), [], "a descriptor whose process isn't listed names nobody");
    assert.equal(
      await editorRuns(await unityProject(), unlisted),
      false,
      "a project with no descriptor and no process",
    );
  });

  it("counts the process a descriptor names only when it is a Unity editor of this project or of none", async () => {
    const root = await openProject();
    const rows: Array<[string, ProcessRow, number[]]> = [
      [
        "another app that got the pid",
        processRow(STAND_IN.pid, "/Applications/Safari.app/Contents/MacOS/Safari", ""),
        [],
      ],
      ["another project's editor", editorRow(STAND_IN.pid, "/another/project"), []],
      ["Unity Hub", processRow(STAND_IN.pid, "/Applications/Unity Hub.app/Contents/MacOS/Unity Hub", ""), []],
      ["an editor that names no project", processRow(STAND_IN.pid, EDITOR_PROGRAM, "-useHub"), [STAND_IN.pid]],
      ["a Windows editor, which lists no command line", processRow(STAND_IN.pid, WINDOWS_EDITOR, ""), [STAND_IN.pid]],
      ["this project's editor", editorRow(STAND_IN.pid, root), [STAND_IN.pid]],
    ];
    for (const [what, row, expected] of rows) {
      const table = processTable([row]);
      const stand = editor([], { alive: () => true });
      assert.deepEqual(await openPids(root, { pipeline: stand.deps, processes: table.env }), expected, what);
    }
  });

  it("never signals another app that got the pid of a stale descriptor", async () => {
    const root = await openProject();
    const table = processTable([processRow(STAND_IN.pid, "/Applications/Safari.app/Contents/MacOS/Safari", "")]);
    const stand = editor([], { alive: (pid) => table.running().includes(pid) });
    const deps: EditorDeps = { pipeline: stand.deps, processes: table.env };
    assert.equal(await editorRuns(root, deps), false);
    assert.equal(await endEditor(root, deps), true);
    assert.deepEqual([stand.seen, table.sent, table.running()], [[], [], [STAND_IN.pid]]);
  });
});

describe("saving the editor's work", () => {
  it("saves each named scene with unsaved work by its own path, then the assets, and never asks Unity for a file name", async () => {
    const { root, deps, seen } = await live([
      scenes(
        ["Assets/Scenes/Main.unity", true],
        ["Assets/Scenes/Clean.unity", false],
        ["Assets/Scenes/Hud.unity", true],
      ),
      ok({ saved: true }),
      ok({ saved: true }),
      ok(),
    ]);
    assert.deepEqual(await saveWork(root, deps), {
      saved: ["Assets/Scenes/Main.unity", "Assets/Scenes/Hud.unity"],
      untitled: 0,
    });
    assert.deepEqual(sent(seen), [
      ["list_open_scenes", {}],
      ["save_scene", { path: "Assets/Scenes/Main.unity" }],
      ["save_scene", { path: "Assets/Scenes/Hud.unity" }],
      ["eval", { code: "UnityEditor.AssetDatabase.SaveAssets();" }],
    ]);
  });

  it("counts a scene that was never saved instead of saving it, whatever else is open", async () => {
    const { root, deps, seen } = await live([
      scenes(["", true], ["Assets/Scenes/Main.unity", true], ["", false]),
      ok(),
      ok(),
    ]);
    assert.deepEqual(await saveWork(root, deps), { saved: ["Assets/Scenes/Main.unity"], untitled: 1 });
    assert.ok(!sent(seen).some(([command]) => command === "save_all"), "save_all would open a save panel");
  });

  it("answers the editor's trouble and saves no further", async () => {
    const stalled = {
      success: false,
      error: "Internal Server Error",
      errorDetails: "Main thread operation timed out after 60000ms",
    };
    const listing = await live([json(400, stalled)]);
    const none = await saveWork(listing.root, listing.deps);
    assert.deepEqual([none.saved, none.trouble?.problem], [[], PipelineProblem.Stalled]);

    const second = await live([
      scenes(["Assets/A.unity", true], ["Assets/B.unity", true]),
      ok(),
      json(400, { success: false, error: "Command Execution Failed", errorDetails: "Read-only file" }),
    ]);
    const partly = await saveWork(second.root, second.deps);
    assert.deepEqual(partly.saved, ["Assets/A.unity"]);
    assert.equal(partly.trouble?.problem, PipelineProblem.Failed);
    assert.equal(sent(second.seen).length, 3, "the assets were not saved past a scene that failed");
  });
});

describe("getting a project Genex made ready", () => {
  it("lets the game run behind other windows and gives the project a saved first scene with a camera", async () => {
    const { root, deps, seen } = await live([ok({ result: true }), ok({ assetPath: "Assets/Scenes/Main.unity" })]);
    assert.equal(await firstSetup(root, deps), undefined);
    assert.deepEqual(sent(seen), [
      ["eval", { code: "UnityEditor.PlayerSettings.runInBackground = true; UnityEditor.AssetDatabase.SaveAssets();" }],
      ["create_scene", { path: "Scenes/Main.unity", template: "default" }],
    ]);
  });

  it("answers the first trouble it meets", async () => {
    const { root, deps } = await live([
      ok(),
      json(400, { success: false, error: "Command Execution Failed", errorDetails: "Scene already exists" }),
    ]);
    const trouble = await firstSetup(root, deps);
    assert.deepEqual(
      [trouble?.problem, trouble?.detail],
      [PipelineProblem.Failed, "Command Execution Failed: Scene already exists"],
    );
  });
});

describe("ending a project's editor", () => {
  it("has nothing to do when no editor has the project open", async () => {
    const { root, deps, table, seen } = await live([]);
    table.end(STAND_IN.pid);
    assert.equal(await endEditor(root, deps), true);
    assert.deepEqual([seen, table.sent], [[], []]);
  });

  it("exits cleanly through the editor when its main thread answers, signalling nothing", async () => {
    const ended = await live([]);
    const stand = editor(
      [
        look(),
        () => {
          ended.table.end(STAND_IN.pid);
          return ok();
        },
      ],
      { alive: (pid) => ended.table.running().includes(pid) },
    );
    const deps: EditorDeps = { pipeline: stand.deps, processes: ended.table.env };
    assert.equal(await endEditor(ended.root, deps), true);
    assert.deepEqual(sent(stand.seen), [["eval", { code: "UnityEditor.EditorApplication.Exit(0);" }]]);
    assert.deepEqual(ended.table.sent, []);
  });

  it("signals the project's own processes when its main thread is stalled, as behind a dialog", async () => {
    const { root, table, deps, seen } = await live([new Error("timed out")]);
    const stalled: EditorDeps = { ...deps, pipeline: { ...deps.pipeline, timeout: () => AbortSignal.abort() } };
    table.start(editorRow(99, "/another/project"));
    assert.equal(await endEditor(root, stalled), true);
    assert.deepEqual(sent(seen), [], "nothing is asked of a main thread that runs nothing");
    assert.deepEqual(table.sent, [[STAND_IN.pid, "SIGTERM"]]);
    assert.deepEqual(table.running(), [99], "another project's editor is left alone");
  });

  it("falls back to a signal when the clean exit leaves the editor running, and says so when nothing ends it", async () => {
    const lingering = await live([look(), ok()]);
    assert.equal(await endEditor(lingering.root, lingering.deps), true);
    assert.deepEqual(lingering.table.sent, [[STAND_IN.pid, "SIGTERM"]]);

    const stubborn = await live([look(), ok()], { [STAND_IN.pid]: [] });
    assert.equal(await endEditor(stubborn.root, stubborn.deps), false);
    assert.deepEqual(
      stubborn.table.sent.map(([, signal]) => signal),
      ["SIGTERM", "SIGKILL"],
    );
  });
});
