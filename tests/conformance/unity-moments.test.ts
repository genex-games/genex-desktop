import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PluginHookContext } from "../../src/plugin-sdk/index.d.ts";
import { UnityTool } from "../../src/plugins/unity/backend.ts";
import { PIPELINE_VERSION } from "../../src/plugins/unity/pipeline.ts";
import { encodePng } from "../../src/substrate/png.ts";
import { HookEvent } from "../../src/shared/plugin-hooks.ts";
import { backendOn, commandsSent, look, ok, ready, withProject } from "../helpers/unity-backend.ts";
import { editorRow, json, type Reply, STAND_IN } from "../helpers/unity-editor-stand-in.ts";

const playing = () => json(200, { status: "playing", playMode: "playing" });
const scenes = (...listed: Array<[string, boolean]>) =>
  ok({ scenes: listed.map(([scenePath, isDirty]) => ({ path: scenePath, isDirty, isLoaded: true })) });
const failed = (details: string) =>
  json(400, { success: false, error: "Command Execution Failed", errorDetails: details });
const png = Buffer.from("\x89PNG\r\n\x1a\nfake-pixels").toString("base64");
/** A real PNG, base64, of `width` x `height` pixels coloured by `colour`. */
function still(width: number, height: number, colour: (x: number, y: number) => [number, number, number]): string {
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgb.set(colour(x, y), (y * width + x) * 3);
  return encodePng({ width, height, rgb }).toString("base64");
}

const chat = (on: HookEvent): PluginHookContext => ({ on });
const run = (on: HookEvent): PluginHookContext => ({ on, runId: "run-7" });

/** A game with a set-up Unity project that an editor has open, answering with `replies`. */
async function openGame(replies: Reply[] = []) {
  const backend = await backendOn(["6000.3.10f1"], replies);
  const root = await withProject(backend.game, "6000.3.10f1", { "com.unity.pipeline": PIPELINE_VERSION });
  await backend.openIn(root);
  const at = (tool: string, hook?: PluginHookContext) =>
    backend.call(tool, { project: "lantern", directory: backend.game, ...(hook ? { hook } : {}) });
  return { ...backend, root, at };
}

/** The same game with no editor open. */
async function closedGame(replies: Reply[] = []) {
  const backend = await backendOn(["6000.3.10f1"], replies);
  const root = await withProject(backend.game, "6000.3.10f1", { "com.unity.pipeline": PIPELINE_VERSION });
  const at = (tool: string, hook?: PluginHookContext) =>
    backend.call(tool, { project: "lantern", directory: backend.game, ...(hook ? { hook } : {}) });
  return { ...backend, root, at };
}

/** An editor whose main thread runs nothing: every look at it runs out of its time. */
function stall(game: Awaited<ReturnType<typeof openGame>>) {
  game.deps.timeout = () => AbortSignal.abort();
}

describe("save-all before a checkpoint", () => {
  it("saves each scene with unsaved work and the assets, saying so in a chat and nothing in a run", async () => {
    const replies = () => [look(), scenes(["Assets/Scenes/Main.unity", true]), ok({ saved: true }), ok()];
    const inChat = await openGame(replies());
    assert.deepEqual(await inChat.at(UnityTool.SaveAll, chat(HookEvent.CheckpointBefore)), {
      note: "Saved 1 scene in Unity.",
    });
    assert.deepEqual(commandsSent(inChat.seen), ["list_open_scenes", "save_scene", "eval"]);
    const inRun = await openGame(replies());
    assert.deepEqual(await inRun.at(UnityTool.SaveAll, run(HookEvent.CheckpointBefore)), {});
  });

  it("has nothing to save, and asks nobody, when no editor has the project open", async () => {
    const { at, seen } = await closedGame();
    assert.deepEqual(await at(UnityTool.SaveAll, run(HookEvent.CheckpointBefore)), {});
    assert.deepEqual(seen, []);
  });

  it("holds the snapshot while Unity plays: scenes can't be saved in Play mode", async () => {
    for (const hook of [chat(HookEvent.CheckpointBefore), run(HookEvent.CheckpointBefore)]) {
      const { at, seen } = await openGame([playing()]);
      const answer = (await at(UnityTool.SaveAll, hook)) as { block?: string };
      assert.match(String(answer.block), /Unity is in Play mode/);
      assert.deepEqual(commandsSent(seen), [], "the play is the person's or the agent's to stop");
    }
  });

  it("says in a chat why work stays unsaved, and holds a run's save point for the same reasons", async () => {
    const reasons: Array<[string, () => Reply[], RegExp]> = [
      ["an unsaved scene with no name", () => [look(), scenes(["", true]), ok()], /never been saved.*save_scene/],
      [
        "a save that failed",
        () => [look(), scenes(["Assets/A.unity", true]), failed("Read-only file")],
        /couldn't save its work: .*Read-only file/,
      ],
    ];
    for (const [what, replies, words] of reasons) {
      const inChat = (await (
        await openGame(replies())
      ).at(UnityTool.SaveAll, chat(HookEvent.CheckpointBefore))) as Record<string, string>;
      assert.match(String(inChat.note), words, what);
      assert.equal(inChat.block, undefined, `${what}: a chat's turn is not held`);
      const inRun = (await (
        await openGame(replies())
      ).at(UnityTool.SaveAll, run(HookEvent.CheckpointBefore))) as Record<string, string>;
      assert.match(String(inRun.block), words, what);
    }
  });

  it("can't save past a main thread that runs nothing, and asks it nothing more", async () => {
    const game = await openGame([new Error("no answer")]);
    stall(game);
    const answer = (await game.at(UnityTool.SaveAll, run(HookEvent.CheckpointBefore))) as { block?: string };
    assert.match(String(answer.block), /main thread runs nothing \(a dialog nobody answered/);
    assert.deepEqual(commandsSent(game.seen), []);
  });
});

describe("a restore of the game's files", () => {
  it("stops a play, saves, ends the editor, and opens it again afterwards on the restored files", async () => {
    const game = await openGame([
      playing(),
      ok("Exited play mode"),
      scenes(["Assets/Scenes/Main.unity", true]),
      ok(),
      ok(),
    ]);
    assert.deepEqual(await game.at(UnityTool.SaveAll, chat(HookEvent.RestoreBefore)), {
      note: "Saved 1 scene in Unity.",
    });
    assert.deepEqual(commandsSent(game.seen), ["editor_stop", "list_open_scenes", "save_scene", "eval"]);

    assert.deepEqual(await game.at(UnityTool.EndEditor, chat(HookEvent.RestoreBefore)), {});
    assert.deepEqual(game.table.running(), [], "the editor is gone before the files change under it");
    assert.deepEqual(game.launches, []);

    const after = (await game.at(UnityTool.ReopenEditor, chat(HookEvent.RestoreAfter))) as { block?: string };
    assert.equal(game.launches.length, 1, "the editor it closed is opened again");
    assert.equal(after.block, undefined, "what follows a restore never holds it");
    assert.deepEqual(await game.at(UnityTool.ReopenEditor, chat(HookEvent.RestoreAfter)), {}, "once per restore");
    assert.equal(game.launches.length, 1);
  });

  it("opens nothing after a restore that closed nothing", async () => {
    const { at, launches } = await closedGame();
    assert.deepEqual(await at(UnityTool.EndEditor, chat(HookEvent.RestoreBefore)), {});
    assert.deepEqual(await at(UnityTool.ReopenEditor, chat(HookEvent.RestoreAfter)), {});
    assert.deepEqual(launches, []);
  });

  it("holds the restore when the editor can't be saved or can't be ended, leaving the files as they are", async () => {
    const unsaved = await openGame([look(), scenes(["", true]), ok()]);
    const held = (await unsaved.at(UnityTool.SaveAll, chat(HookEvent.RestoreBefore))) as { block?: string };
    assert.match(String(held.block), /never been saved/, "even in a chat: a restore would lose that work");

    const stubborn = await backendOn(["6000.3.10f1"], [], { ends: { [STAND_IN.pid]: [] } });
    const root = await withProject(stubborn.game, "6000.3.10f1", { "com.unity.pipeline": PIPELINE_VERSION });
    stubborn.table.start(editorRow(STAND_IN.pid, root));
    const answer = (await stubborn.call(UnityTool.EndEditor, {
      project: "lantern",
      directory: stubborn.game,
      hook: chat(HookEvent.RestoreBefore),
    })) as { block?: string };
    assert.match(String(answer.block), /couldn't be closed for the restore/);
    assert.deepEqual(
      await stubborn.call(UnityTool.ReopenEditor, {
        project: "lantern",
        directory: stubborn.game,
        hook: chat(HookEvent.RestoreAfter),
      }),
      {},
      "a restore that was held closed nothing, so nothing is opened",
    );
  });
});

describe("the editor's health in a run", () => {
  it("is fine while Unity answers, and failed once Unity is gone", async () => {
    const well = await openGame([look()]);
    assert.deepEqual(await well.at(UnityTool.EditorState, run(HookEvent.Health)), {});
    const gone = await closedGame();
    const answer = (await gone.at(UnityTool.EditorState, run(HookEvent.Health))) as { block?: string };
    assert.match(String(answer.block), /Unity isn't running/);
  });

  it("waits while Unity is starting, reloading or importing", async () => {
    const starting = await backendOn(["6000.3.10f1"]);
    const root = await withProject(starting.game, "6000.3.10f1", { "com.unity.pipeline": PIPELINE_VERSION });
    starting.table.start(editorRow(STAND_IN.pid, root));
    const answer = (await starting.call(UnityTool.EditorState, {
      project: "lantern",
      directory: starting.game,
      hook: run(HookEvent.Health),
    })) as { pending?: string };
    assert.match(String(answer.pending), /starting, reloading its scripts or importing/);
  });

  it("gives a stalled main thread two minutes, then fails the check so the editor is opened again", async () => {
    let now = Date.parse("2026-10-14T09:00:00.000Z");
    const backend = await backendOn(
      ["6000.3.10f1"],
      Array.from({ length: 3 }, () => new Error("no answer")),
      { now: () => new Date(now) },
    );
    const root = await withProject(backend.game, "6000.3.10f1", { "com.unity.pipeline": PIPELINE_VERSION });
    await backend.openIn(root);
    backend.deps.timeout = () => AbortSignal.abort();
    const check = async () =>
      (await backend.call(UnityTool.EditorState, {
        project: "lantern",
        directory: backend.game,
        hook: run(HookEvent.Health),
      })) as Record<string, string>;

    const first = await check();
    assert.match(String(first.pending), /main thread is not answering/);
    assert.equal(first.block, undefined, "a long import looks the same at first");
    now += 90_000;
    assert.match(String((await check()).pending), /main thread is not answering/, "still within its two minutes");
    now += 31_000;
    assert.match(String((await check()).block), /has run nothing for 2 minutes: a dialog nobody answered/);
  });

  it("never fails the check, however long the stall, while someone is at the computer: the dialog may be theirs", async () => {
    let now = Date.parse("2026-10-14T09:00:00.000Z");
    const backend = await backendOn(
      ["6000.3.10f1"],
      Array.from({ length: 3 }, () => new Error("no answer")),
      { now: () => new Date(now), idleMs: () => 30_000 },
    );
    await backend.openIn(await withProject(backend.game, "6000.3.10f1", { "com.unity.pipeline": PIPELINE_VERSION }));
    backend.deps.timeout = () => AbortSignal.abort();
    const check = async () =>
      (await backend.call(UnityTool.EditorState, {
        project: "lantern",
        directory: backend.game,
        hook: run(HookEvent.Health),
      })) as Record<string, string>;
    assert.ok((await check()).pending);
    now += 30 * 60_000;
    const later = await check();
    assert.equal(later.block, undefined, "their editor is never ended under them");
    assert.match(String(later.pending), /someone is at this computer/);
  });

  it("forgets a stall once the main thread answers again", async () => {
    let now = Date.parse("2026-10-14T09:00:00.000Z");
    const replies: Reply[] = [new Error("no answer"), look(), new Error("no answer")];
    const backend = await backendOn(["6000.3.10f1"], replies, { now: () => new Date(now) });
    await backend.openIn(await withProject(backend.game, "6000.3.10f1", { "com.unity.pipeline": PIPELINE_VERSION }));
    const check = async (stalled: boolean) => {
      backend.deps.timeout = () => (stalled ? AbortSignal.abort() : new AbortController().signal);
      return (await backend.call(UnityTool.EditorState, {
        project: "lantern",
        directory: backend.game,
        hook: run(HookEvent.Health),
      })) as Record<string, string>;
    };
    assert.ok((await check(true)).pending);
    now += 180_000;
    assert.deepEqual(await check(false), {}, "it answered: the import was only long");
    now += 1000;
    assert.ok((await check(true)).pending, "a new stall gets its own two minutes");
  });

  it("ends what is left of the editor after a failed check and opens the project again", async () => {
    const game = await openGame([new Error("no answer"), ready()]);
    stall(game);
    const answer = await game.at(UnityTool.ReopenEditor, run(HookEvent.Crash));
    assert.deepEqual(game.table.sent, [[STAND_IN.pid, "SIGTERM"]]);
    assert.equal(game.launches.length, 1);
    assert.equal((answer as { block?: string }).block, undefined, "a crash's step is a note at most");
  });
});

describe("a run's start", () => {
  it("opens the game's editor and goes on once it answers", async () => {
    const { at, launches } = await closedGame([ready(), look(), ok()]);
    assert.deepEqual(await at(UnityTool.OpenForRun, run(HookEvent.RunPrepare)), {});
    assert.equal(launches.length, 1);
  });

  it("closes the run with the reason when the project is not set up or its Unity is not installed", async () => {
    const bare = await backendOn(["6000.3.10f1"]);
    await withProject(bare.game, "6000.3.10f1");
    const hook = run(HookEvent.RunPrepare);
    const notSetUp = (await bare.call(UnityTool.OpenForRun, { project: "lantern", directory: bare.game, hook })) as {
      block?: string;
    };
    assert.match(String(notSetUp.block), /no Pipeline package .* unity__setup/);

    const other = await backendOn(["6000.3.10f1"]);
    await withProject(other.game, "6000.0.26f1", { "com.unity.pipeline": PIPELINE_VERSION });
    const missing = (await other.call(UnityTool.OpenForRun, { project: "lantern", directory: other.game, hook })) as {
      block?: string;
    };
    assert.match(String(missing.block), /Unity 6000\.0\.26f1, which this project was saved with, isn't installed/);
    assert.deepEqual([bare.launches, other.launches], [[], []]);
  });
});

describe("the editor lock's probe", () => {
  it("says nobody is at an editor that is not open, and counts the scenes with unsaved work of one that is", async () => {
    const closed = await closedGame();
    assert.deepEqual(await closed.at(UnityTool.EditorActivity), { personActive: false, unsaved: 0 });
    const open = await openGame([look(), scenes(["Assets/A.unity", true], ["Assets/B.unity", false], ["", true])]);
    assert.deepEqual(await open.at(UnityTool.EditorActivity), { personActive: false, unsaved: 2 });
  });

  it("takes a play for the person's unless the agent started it through the connector", async () => {
    const persons = await openGame([playing(), scenes(["Assets/A.unity", false])]);
    assert.deepEqual(await persons.at(UnityTool.EditorActivity), { personActive: true, unsaved: 0 });

    const agents = await openGame([
      playing(),
      scenes(["Assets/A.unity", false]),
      look(),
      scenes(["Assets/A.unity", false]),
      playing(),
      scenes(),
    ]);
    const marker = path.join(agents.storage, "mcp", "lantern");
    await mkdir(marker, { recursive: true });
    await writeFile(
      path.join(marker, "agent-play.json"),
      JSON.stringify({ startedAt: Date.parse("2026-10-14T08:59:00.000Z") }),
    );
    assert.deepEqual(await agents.at(UnityTool.EditorActivity), { personActive: false, unsaved: 0 });
    assert.deepEqual(await agents.at(UnityTool.EditorActivity), { personActive: false, unsaved: 0 }, "the play ended");
    assert.deepEqual(
      await agents.at(UnityTool.EditorActivity),
      { personActive: true, unsaved: 0 },
      "the agent's play ended some other way, so the next play is the person's",
    );
  });

  it("can't tell who is at a stalled editor while someone is at the computer, and says nobody is once they are away", async () => {
    const attended = await backendOn(["6000.3.10f1"], [new Error("no answer")], { idleMs: () => 20_000 });
    await attended.openIn(await withProject(attended.game, "6000.3.10f1", { "com.unity.pipeline": PIPELINE_VERSION }));
    attended.deps.timeout = () => AbortSignal.abort();
    const bound = { project: "lantern", directory: attended.game };
    assert.deepEqual(await attended.call(UnityTool.EditorActivity, bound), {}, "the dialog may be the person's own");

    const away = await openGame([new Error("no answer")]);
    stall(away);
    assert.deepEqual(
      await away.at(UnityTool.EditorActivity),
      { personActive: false, unsaved: 0 },
      "nobody touched this computer for ten minutes: the editor is Genex's to get back",
    );

    const unknown = await backendOn(["6000.3.10f1"], [new Error("no answer")], { idleMs: () => undefined });
    await unknown.openIn(await withProject(unknown.game, "6000.3.10f1", { "com.unity.pipeline": PIPELINE_VERSION }));
    unknown.deps.timeout = () => AbortSignal.abort();
    assert.deepEqual(
      await unknown.call(UnityTool.EditorActivity, { project: "lantern", directory: unknown.game }),
      {},
      "where the computer can't say, someone may be there",
    );
  });

  it("answers nothing while the editor only reloads or starts: that passes by itself", async () => {
    const reloading = await backendOn(["6000.3.10f1"]);
    const root = await withProject(reloading.game, "6000.3.10f1", { "com.unity.pipeline": PIPELINE_VERSION });
    reloading.table.start(editorRow(STAND_IN.pid, root));
    assert.deepEqual(
      await reloading.call(UnityTool.EditorActivity, { project: "lantern", directory: reloading.game }),
      {},
    );
  });
});

describe("scene-shots", () => {
  it("hands back the main camera's still for a run's save point and for the reviewer, and none for a chat's checkpoint", async () => {
    const shot = () => ok({ width: 1280, height: 720, encoding: "png", base64: png, source: "camera:Main Camera" });
    const inRun = await openGame([look(), shot()]);
    assert.deepEqual(await inRun.at(UnityTool.SceneShots, run(HookEvent.CheckpointAfter)), {
      images: [{ name: "Main Camera", data: png }],
    });
    const observed = await openGame([look(), shot()]);
    assert.deepEqual(await observed.at(UnityTool.SceneShots), { images: [{ name: "Main Camera", data: png }] });
    const inChat = await openGame([look(), shot()]);
    assert.deepEqual(await inChat.at(UnityTool.SceneShots, chat(HookEvent.CheckpointAfter)), {});
    assert.deepEqual(inChat.seen, []);
  });

  it("gives a save point no picture when the main camera sees one flat colour, and says why", async () => {
    // A scene built only when Play starts: outside Play mode the camera sees its own background.
    const empty = still(160, 90, () => [3, 3, 5]);
    const shot = () => ok({ width: 160, height: 90, encoding: "png", base64: empty, source: "camera:Main Camera" });
    for (const asked of [run(HookEvent.CheckpointAfter), undefined]) {
      const game = await openGame([look(), shot()]);
      const answer = (await game.at(UnityTool.SceneShots, asked)) as { images?: unknown[]; note?: string };
      assert.equal(answer.images, undefined, "no black card for the save point or the reviewer");
      assert.match(String(answer.note), /one flat colour.* outside Play mode .* into the scene/);
    }
  });

  it("keeps a dark still that shows something, and one it can't read", async () => {
    // A night scene: black, with a lit window and a little dither.
    const night = still(160, 90, (x, y) => (x > 70 && x < 90 && y > 40 && y < 50 ? [250, 220, 140] : [x % 2, 0, 1]));
    const truncated = Buffer.from(night, "base64").subarray(0, 60).toString("base64");
    for (const data of [night, truncated]) {
      const shot = ok({ width: 160, height: 90, encoding: "png", base64: data, source: "camera:Main Camera" });
      const game = await openGame([look(), shot]);
      assert.deepEqual(await game.at(UnityTool.SceneShots, run(HookEvent.CheckpointAfter)), {
        images: [{ name: "Main Camera", data }],
      });
    }
  });

  it("answers no still when there is no camera, no answering editor or no editor at all", async () => {
    const noCamera = await openGame([look(), failed("No camera found to capture.")]);
    assert.deepEqual(await noCamera.at(UnityTool.SceneShots, run(HookEvent.CheckpointAfter)), {});
    const stalled = await openGame([new Error("no answer")]);
    stall(stalled);
    assert.deepEqual(await stalled.at(UnityTool.SceneShots, run(HookEvent.CheckpointAfter)), {});
    assert.deepEqual(await (await closedGame()).at(UnityTool.SceneShots, run(HookEvent.CheckpointAfter)), {});
  });
});
