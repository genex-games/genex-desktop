import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PluginHookContext } from "../../src/plugin-sdk/index.d.ts";
import { UnityTool } from "../../src/plugins/unity/backend.ts";
import {
  closeIdleEditors,
  IDLE_CLOSE_MS,
  IDLE_LOOK_MS,
  IdleLook,
  rememberLaunch,
  runEnded,
  runGoesOn,
  runMarksOnce,
} from "../../src/plugins/unity/editor-idle.ts";
import { PIPELINE_VERSION } from "../../src/plugins/unity/pipeline.ts";
import { HookEvent } from "../../src/shared/plugin-hooks.ts";
import {
  type BackendOptions,
  backendOn,
  commandsSent,
  look,
  ok,
  ready,
  realTmp,
  withProject,
} from "../helpers/unity-backend.ts";
import { json, type Reply } from "../helpers/unity-editor-stand-in.ts";

const MINUTE = 60_000;
const run = (on: HookEvent): PluginHookContext => ({ on, runId: "run-7" });
const scenes = (...listed: Array<[string, boolean]>) =>
  ok({ scenes: listed.map(([scenePath, isDirty]) => ({ path: scenePath, isDirty, isLoaded: true })) });
const playing = () => json(200, { status: "playing", playMode: "playing" });
/** Unity's answer to the look inside: whether it is the app in front, and its undo group. */
const inside = (active: boolean, undo: number) => ok({ active, undo });
/** A look that finds the editor idle, in the back, its undo history at `undo`. */
const idleLook = (undo = 5): Reply[] => [look(), inside(false, undo)];
/** A look that closes the editor: idle, nothing unsaved, its assets saved; ending it is a signal (no reply left). */
const closingLook = (undo = 5): Reply[] => [
  ...idleLook(undo),
  scenes(["Assets/Scenes/Main.unity", false]),
  scenes(["Assets/Scenes/Main.unity", false]),
  ok(),
];

/**
 * A game with a set-up Unity project and no editor open, on a clock the test moves. The run starts
 * (Genex's `find-project` at `run.prepare`) and its lead opens Unity with `open-editor`; with
 * `inRun: false` a chat's agent opens it instead, no run under way (its turn's `find-project`).
 * `opened` says whether that opens it (Genex's own) or finds it already open (the person's); the
 * editor answers the open and then `replies`.
 */
async function ranGame(replies: Reply[], options: { opened?: boolean; inRun?: boolean } & BackendOptions = {}) {
  const clock = { at: Date.parse("2026-10-21T09:00:00.000Z") };
  const opened = options.opened ?? true;
  // The lead's open: the editor's server ready, a look at its main thread, and it kept ticking.
  const atStart = [ready(), look(), ok()];
  const backend = await backendOn(["6000.3.10f1"], [...atStart, ...replies], {
    now: () => new Date(clock.at),
    ...options,
  });
  const root = await withProject(backend.game, "6000.3.10f1", { "com.unity.pipeline": PIPELINE_VERSION });
  if (!opened) await backend.openIn(root);
  const at = (tool: string, hook: PluginHookContext) =>
    backend.call(tool, { project: "lantern", directory: backend.game, hook });
  // Flipped: Genex's own open-for-run opened Unity at the run's start; now the run's lead does.
  await at(UnityTool.FindProject, options.inRun === false ? { on: HookEvent.TurnStart } : run(HookEvent.RunPrepare));
  await backend.call(UnityTool.OpenEditor);
  assert.equal(backend.launches.length, opened ? 1 : 0);
  const idleDeps = { pipeline: backend.deps, processes: backend.table.env, now: () => new Date(clock.at) };
  /** The backend's half-minute look, `minutes` after now. */
  const lookAfter = async (minutes: number) => {
    clock.at += minutes * MINUTE;
    return (await closeIdleEditors(backend.storage, idleDeps)).lantern;
  };
  const sentBeforeLooks = backend.seen.length;
  const sentInLooks = () => commandsSent(backend.seen.slice(sentBeforeLooks));
  return { ...backend, clock, at, root, lookAfter, sentInLooks };
}

/** The editor connector of `lantern` noting a command it sent at `at`. */
async function agentSent(storage: string, at: number): Promise<void> {
  const folder = path.join(storage, "mcp", "lantern");
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "agent-used.json"), JSON.stringify({ at }));
}

describe("closing a Unity editor Genex opened for a run", () => {
  it("an editor its lead opened is closed idle after the run like one Genex opened: once unused for fifteen minutes, its assets saved first", async () => {
    const game = await ranGame([...idleLook(), ...closingLook()]);
    assert.deepEqual(await game.at(UnityTool.AfterRun, run(HookEvent.RunEnd)), {});
    assert.equal(await game.lookAfter(1), IdleLook.Waits);
    assert.equal(game.table.running().length, 1, "still open within the fifteen minutes");
    assert.equal(await game.lookAfter(IDLE_CLOSE_MS / MINUTE), IdleLook.Closed);
    assert.deepEqual(game.table.running(), [], "Unity's memory is given back");
    assert.deepEqual(game.sentInLooks(), ["eval", "eval", "list_open_scenes", "list_open_scenes", "eval"]);
    assert.equal(await game.lookAfter(IDLE_LOOK_MS / MINUTE), undefined, "nothing is left to look at");
  });

  it("never closes an editor that was already open when the run started, its lead's open notwithstanding: it is the person's", async () => {
    const game = await ranGame([], { opened: false });
    assert.deepEqual(await game.at(UnityTool.AfterRun, run(HookEvent.RunEnd)), {});
    assert.equal(await game.lookAfter(60), undefined);
    assert.equal(game.table.running().length, 1);
    assert.deepEqual(game.sentInLooks(), [], "it is not even asked");
  });

  it("does nothing while the person turned the closing off", async () => {
    const game = await ranGame([], { settings: { "close-idle-editor": false } });
    await game.at(UnityTool.AfterRun, run(HookEvent.RunEnd));
    assert.equal(await game.lookAfter(60), undefined);
    assert.equal(game.table.running().length, 1);
  });

  it("waits while the run goes on, and closes nothing before the run ends", async () => {
    const game = await ranGame([]);
    assert.equal(await game.lookAfter(60), IdleLook.Waits);
    assert.deepEqual(game.sentInLooks(), []);
    assert.equal(game.table.running().length, 1);
  });

  it("leaves it to the person for good once they bring Unity to the front", async () => {
    const game = await ranGame([look(), inside(true, 5)]);
    await game.at(UnityTool.AfterRun, run(HookEvent.RunEnd));
    assert.equal(await game.lookAfter(1), IdleLook.Forgotten);
    assert.equal(await game.lookAfter(60), undefined, "never looked at again");
    assert.equal(game.table.running().length, 1);
  });

  it("leaves it to the person once its undo history moves with no agent command, but not for the agent's own", async () => {
    const person = await ranGame([...idleLook(5), ...idleLook(6)]);
    await person.at(UnityTool.AfterRun, run(HookEvent.RunEnd));
    assert.equal(await person.lookAfter(1), IdleLook.Waits);
    assert.equal(await person.lookAfter(1), IdleLook.Forgotten, "someone edited in Unity");
    assert.equal(person.table.running().length, 1);

    const agent = await ranGame([...idleLook(5), ...idleLook(6), ...idleLook(6), ...closingLook(6)]);
    await agent.at(UnityTool.AfterRun, run(HookEvent.RunEnd));
    assert.equal(await agent.lookAfter(1), IdleLook.Waits);
    await agentSent(agent.storage, agent.clock.at + MINUTE / 2);
    assert.equal(await agent.lookAfter(1), IdleLook.Waits, "the agent's command moved it");
    // Fifteen minutes from the run's end, but the agent's command was later: its idle time starts there.
    assert.equal(await agent.lookAfter(IDLE_CLOSE_MS / MINUTE - 2), IdleLook.Waits);
    assert.equal(agent.table.running().length, 1);
    assert.equal(await agent.lookAfter(2), IdleLook.Closed);
  });

  it("leaves it to the person when a scene holds unsaved work, and waits through a play", async () => {
    const dirty = await ranGame([...idleLook(), scenes(["Assets/Scenes/Main.unity", true])]);
    await dirty.at(UnityTool.AfterRun, run(HookEvent.RunEnd));
    assert.equal(await dirty.lookAfter(IDLE_CLOSE_MS / MINUTE), IdleLook.Forgotten);
    assert.equal(dirty.table.running().length, 1, "unsaved work is never thrown away");

    const played = await ranGame([playing(), ...closingLook()]);
    await played.at(UnityTool.AfterRun, run(HookEvent.RunEnd));
    assert.equal(await played.lookAfter(IDLE_CLOSE_MS / MINUTE), IdleLook.Waits);
    assert.equal(played.table.running().length, 1);
    assert.equal(await played.lookAfter(1), IdleLook.Closed);
  });

  it("forgets an editor that was quit some other way, and is in use again when a new run starts on it", async () => {
    const quit = await ranGame([]);
    await quit.at(UnityTool.AfterRun, run(HookEvent.RunEnd));
    for (const pid of quit.table.running()) quit.table.end(pid);
    assert.equal(await quit.lookAfter(1), IdleLook.Forgotten);

    const again = await ranGame(closingLook());
    await again.at(UnityTool.AfterRun, run(HookEvent.RunEnd));
    // Flipped: Genex's open-for-run found it open; now the second run's start alone says it is in use.
    await again.at(UnityTool.FindProject, run(HookEvent.RunPrepare));
    assert.equal(await again.lookAfter(60), IdleLook.Waits, "its run goes on");
    assert.equal(again.table.running().length, 1);
    assert.deepEqual(again.sentInLooks(), [], "nothing is asked of an editor a run uses");
  });
});

describe("closing a Unity editor: which run it is Genex's for", () => {
  it("an editor an agent opened with no run under way is the person's: a run that ends later never closes it", async () => {
    const game = await ranGame([...idleLook(), ...closingLook()], { inRun: false });
    assert.equal(game.table.running().length, 1, "the chat's agent opened it");
    await game.at(UnityTool.FindProject, run(HookEvent.RunPrepare));
    assert.deepEqual(await game.at(UnityTool.AfterRun, run(HookEvent.RunEnd)), {});
    assert.equal(await game.lookAfter(1), undefined);
    assert.equal(await game.lookAfter(IDLE_CLOSE_MS / MINUTE), undefined);
    assert.equal(game.table.running().length, 1, "still open");
    assert.deepEqual(game.sentInLooks(), [], "it is not even asked");
  });

  it("a run that never reached its end leaves nothing once Genex starts again: an agent's open with no run under way stays the person's", async () => {
    const clock = { at: Date.parse("2026-10-21T09:00:00.000Z") };
    const game = await backendOn(["6000.3.10f1"], [ready(), look(), ok(), ...idleLook(), ...closingLook()], {
      now: () => new Date(clock.at),
    });
    await withProject(game.game, "6000.3.10f1", { "com.unity.pipeline": PIPELINE_VERSION });
    const at = (tool: string, hook: PluginHookContext) =>
      game.call(tool, { project: "lantern", directory: game.game, hook });
    // A run's start marked it under way; Genex quit mid-run, so its run.end never came.
    await at(UnityTool.FindProject, run(HookEvent.RunPrepare));
    game.restart();
    // Genex started again, and a chat's agent opens Unity: no run is under way on the game.
    await at(UnityTool.FindProject, { on: HookEvent.TurnStart });
    await game.call(UnityTool.OpenEditor);
    assert.equal(game.launches.length, 1, "the chat's agent opened it");
    await at(UnityTool.FindProject, run(HookEvent.RunPrepare));
    assert.deepEqual(await at(UnityTool.AfterRun, run(HookEvent.RunEnd)), {});
    const idleDeps = { pipeline: game.deps, processes: game.table.env, now: () => new Date(clock.at) };
    clock.at += IDLE_CLOSE_MS + MINUTE;
    assert.equal((await closeIdleEditors(game.storage, idleDeps)).lantern, undefined);
    assert.equal(game.table.running().length, 1, "still open: it is the person's");
  });

  it("an editor a new run uses is in use again from its lead's first turn, though its start ran no step (Plan mode)", async () => {
    const again = await ranGame(closingLook());
    await again.at(UnityTool.AfterRun, run(HookEvent.RunEnd));
    await again.at(UnityTool.FindProject, { on: HookEvent.TurnStart, runId: "run-8" });
    assert.equal(await again.lookAfter(60), IdleLook.Waits, "its run goes on");
    assert.equal(again.table.running().length, 1);
    assert.deepEqual(again.sentInLooks(), [], "nothing is asked of an editor a run uses");
  });
});

/** Every file and link under `dir`, relative to it, sorted. */
async function everythingUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => !entry.isDirectory())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)))
    .sort();
}

describe("closing a Unity editor: the marks it keeps per game", () => {
  /** Game ids a call may carry that are no plain folder name: each writes and removes nothing anywhere. */
  const HOSTILE_GAMES: ReadonlyArray<readonly [string, string]> = [
    ["a parent folder", ".."],
    ["a way out", "../outside"],
    ["a folder in a folder", "a/b"],
    ["a Windows separator", "a\\b"],
    ["the folder itself", "."],
    ["a dotted name", "lantern.json"],
    ["nothing", ""],
    ["a name past 100 characters", "x".repeat(101)],
    ["a line break", "lantern\n"],
  ];

  it("a game id that is no plain folder name marks, remembers and removes nothing", async () => {
    const storage = await realTmp("unity-marks-");
    const outside = await realTmp("unity-marks-outside-");
    await writeFile(path.join(outside, "keep.json"), "{}");
    await mkdir(path.join(storage, "launched"), { recursive: true });
    await writeFile(path.join(storage, "launched", "lantern.json"), JSON.stringify({ root: "/games/lantern/unity" }));
    const before = await everythingUnder(storage);
    for (const [why, game] of HOSTILE_GAMES) {
      await runGoesOn(storage, game, "/games/x/unity");
      await rememberLaunch(storage, game, "/games/x/unity");
      await runEnded(storage, game, Date.now(), true);
      assert.deepEqual(await everythingUnder(storage), before, `${why}: nothing written or removed`);
    }
    assert.deepEqual(await everythingUnder(outside), ["keep.json"], "nothing outside the storage");
  });

  it("forgetting an earlier backend's marks removes a linked runs folder's link, never what it points to", async () => {
    const storage = await realTmp("unity-marks-");
    const outside = await realTmp("unity-marks-outside-");
    await writeFile(path.join(outside, "lantern.json"), "{}");
    await symlink(outside, path.join(storage, "runs"));
    await runMarksOnce()(storage);
    assert.deepEqual(await everythingUnder(outside), ["lantern.json"], "what the link pointed to stays");
    assert.deepEqual(await everythingUnder(storage), [], "the link is gone");
  });
});
