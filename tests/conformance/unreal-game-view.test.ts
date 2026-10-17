/**
 * What the app does differently for a game linked to an Unreal project (`shared/game-engine.ts`):
 * the Loop waits for the Unreal Loop, Rewind says when Unreal's changes stay, and the Live tab's
 * Unreal card opens the editor through the Unreal plugin. Tested through the pure rules the
 * composer, the Rewind dialog and the stage apply.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chatLoopExtras,
  composerExtras,
  composerLoopView,
  loopAvailableFor,
  rememberChatLoop,
} from "../../src/renderer/loop-setting.ts";
import type { KeyValueStorage } from "../../src/renderer/storage.ts";
import {
  UNREAL_PLUGIN_ID,
  UnrealPluginAction,
  unrealLoopGate,
  unrealOpener,
  unrealProjectOf,
  unrealRewindNote,
} from "../../src/renderer/unreal-game.ts";
import { UNREAL_WORDS } from "../../src/renderer/words.ts";
import type { EngineBinding } from "../../src/shared/game-engine.ts";
import type { PluginInfo } from "../../src/shared/plugins.ts";

const memory = (): KeyValueStorage => {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
};

const linked = (project: string): EngineBinding => ({ kind: "unreal", project, linkedAt: "2026-10-04T10:00:00.000Z" });
const GAME_DIR = "/Users/me/AI Games/fog-valley";
const outsideGame = { dir: GAME_DIR, engine: linked("/Users/me/Documents/Unreal Projects/Valley/Valley.uproject") };
const insideGame = { dir: GAME_DIR, engine: linked(`${GAME_DIR}/unreal/Valley.uproject`) };
const webGame: { dir: string; engine?: EngineBinding } = { dir: GAME_DIR };

describe("the Loop for an Unreal game", () => {
  it("is available for a web game and an Unreal game whose project is in its folder, not one elsewhere", () => {
    assert.equal(loopAvailableFor(webGame), true);
    assert.equal(loopAvailableFor(null), true, "no game (a draft chat) keeps the Loop");
    assert.equal(loopAvailableFor(undefined), true);
    assert.equal(loopAvailableFor(insideGame), true, "the Unreal Loop's parts are undone with the game folder");
    assert.equal(loopAvailableFor(outsideGame), false, "a project elsewhere couldn't undo a part");
  });

  it("shows Mode off, keeps plan review and commissions nothing while the Loop waits", () => {
    const own = { on: true, hours: null };
    const view = composerLoopView({ own, build: null, loopAvailable: false });
    assert.deepEqual(view, { shown: { on: false, hours: null }, editable: true, loopUnavailable: true });
    assert.deepEqual(
      composerExtras({ gameMode: true, view, reviewPlan: true, frames: [] }),
      { reviewPlan: true },
      "Plan mode still works; only the Loop's commission is held back",
    );
  });

  it("keeps a web game's Mode exactly as it was", () => {
    const own = { on: true, hours: 2 };
    assert.deepEqual(composerLoopView({ own, build: null, loopAvailable: true }), { shown: own, editable: true });
    assert.deepEqual(composerLoopView({ own, build: null }), { shown: own, editable: true });
  });

  it("shows a running build's own Loop read-only, Unreal or not", () => {
    const own = { on: true, hours: 2 };
    const running = { state: "running" as const, loop: { on: true, hours: null } };
    assert.deepEqual(composerLoopView({ own, build: running, loopAvailable: false }), {
      shown: { on: true, hours: null },
      editable: false,
    });
  });

  it("a command's result in an Unreal game carries no Loop either", () => {
    const storage = memory();
    const threadId = "valley-chat";
    rememberChatLoop(storage, threadId, { on: true, hours: 2 });
    const input = { storage, threadId, build: null, coordinating: false, gameMode: true };
    assert.deepEqual(chatLoopExtras(input), { autopilot: { hours: 2, frames: [] } }, "a web game's result does");
    assert.deepEqual(chatLoopExtras({ ...input, loopAvailable: false }), {});
  });

  it("says why the Loop waits, where the project is, and the two ways to a Loop", () => {
    const gate = unrealLoopGate(outsideGame);
    assert.match(gate, /Valley is in Documents › Unreal Projects\./);
    assert.match(gate, /Make a new one from the Unreal button, or move Valley into this game’s folder/);
    assert.doesNotMatch(gate, /overnight|night|morning|tonight/i);
  });
});

describe("Rewind in an Unreal game", () => {
  it("says Unreal's changes stay when the project is outside the game folder", () => {
    assert.equal(unrealRewindNote(outsideGame), UNREAL_WORDS.rewindNote("Valley"));
    assert.match(UNREAL_WORDS.rewindNote("Valley"), /Valley/);
  });

  it("says nothing for a web game, no game, or a project inside the game folder", () => {
    assert.equal(unrealRewindNote(webGame), null);
    assert.equal(unrealRewindNote(null), null);
    assert.equal(unrealRewindNote(insideGame), null);
    assert.equal(unrealRewindNote({ dir: `${GAME_DIR}/`, engine: insideGame.engine }), null, "a trailing slash");
  });

  it("reads a project beside the game folder, or the folder's own name, as outside", () => {
    const hostile = [
      `${GAME_DIR}-copy/unreal/Valley.uproject`,
      `${GAME_DIR}.uproject`,
      "/Users/me/AI Games/Valley.uproject",
      "/Valley.uproject",
    ];
    for (const project of hostile)
      assert.equal(
        unrealRewindNote({ dir: GAME_DIR, engine: linked(project) }),
        UNREAL_WORDS.rewindNote(project.split("/").pop()?.replace(".uproject", "") ?? ""),
        project,
      );
  });
});

describe("the Live tab's Unreal card", () => {
  it("names an Unreal game's project and none for a web game", () => {
    assert.equal(unrealProjectOf(outsideGame), outsideGame.engine.project);
    assert.equal(unrealProjectOf(webGame), null);
    assert.equal(unrealProjectOf(null), null);
  });

  const plugin = (patch: Partial<PluginInfo> = {}, actions = [UnrealPluginAction.OpenEditor]): PluginInfo =>
    ({
      manifest: { id: UNREAL_PLUGIN_ID, actions: actions.map((name) => ({ name, label: name })) },
      enabled: true,
      removed: false,
      ...patch,
    }) as PluginInfo;

  it("opens the editor through the Unreal plugin only while it is on and declares Open in Unreal", () => {
    const on = plugin();
    assert.equal(unrealOpener([on]), on);
    assert.equal(unrealOpener([plugin({ enabled: false })]), null, "turned off");
    assert.equal(unrealOpener([plugin({ removed: true })]), null, "removed");
    assert.equal(unrealOpener([plugin({ unlisted: true })]), null, "found on disk, never allowed");
    assert.equal(unrealOpener([plugin({}, [])]), null, "an Unreal plugin without the action");
    assert.equal(unrealOpener([]), null, "not installed");
    const other = { ...plugin(), manifest: { ...plugin().manifest, id: "blender" } } as PluginInfo;
    assert.equal(unrealOpener([other]), null, "another plugin with the same action");
  });
});
