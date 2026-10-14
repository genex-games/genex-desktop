import assert from "node:assert/strict";
import test from "node:test";
import { previewVisibility } from "../../src/main/preview-visibility.ts";
import { BuildTarget, GameStack } from "../../src/shared/game-project.ts";
import { NativeRunMode } from "../../src/shared/native-contract.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { ScaffoldCaller } from "../../src/substrate/game-workspace.ts";

test("modal occlusion dominates stage and observer visibility in either arrival order", () => {
  for (const initialVisible of [false, true]) {
    const applied: boolean[] = [];
    const visibility = previewVisibility((visible) => applied.push(visible));
    visibility.setVisible(initialVisible);
    visibility.setOccluded(true);
    visibility.setVisible(true);
    assert.equal(applied.at(-1), false);
    visibility.setVisible(false);
    visibility.setOccluded(false);
    assert.equal(applied.at(-1), false);
    visibility.setVisible(true);
    assert.equal(applied.at(-1), true);
    visibility.setOccluded(true);
    assert.equal(applied.at(-1), false);
    visibility.setOccluded(false);
    assert.equal(applied.at(-1), true);
  }
});

/**
 * Hiding the stage rests what is drawn in it: Live, and a C++ game's run embedded in Live (the
 * registry rests its clock and stops its frames: `native-frames.test.ts`). The person's own Play
 * window is a desktop window of its own and an agent's headless run belongs to the agent, so
 * neither is paused by the stage. The registry is a scripted stand-in.
 */
test("hiding Live pauses an embedded run, never the Play window or an agent's run", async () => {
  const told = new Map<string, boolean[]>();
  const shown: Array<[string, boolean]> = [];
  const port = (key: string) => ({
    setVisible: (visible: boolean) => told.set(key, [...(told.get(key) ?? []), visible]),
    setAudioMuted: () => {},
  });
  const registry = {
    start: async () => {
      throw new Error("nothing starts here");
    },
    stop: async () => {},
    stopAll: async () => {},
    stopAgentRuns: async () => {},
    stopProject: async () => {},
    stopMode: async () => {},
    stopOwnedBy: async () => {},
    state: () => null,
    portOf: (project: string, mode?: string) => (mode ? port(`${project}/${mode}`) : null),
    front: async () => false,
    sweepOrphans: async () => 0,
    onFocus: () => () => {},
    onStatus: () => () => {},
    showEmbedded: (project: string, visible: boolean) => void shown.push([project, visible]),
  };
  const live = {
    load: async (project: string) => `game://${project}/index.html`,
    reload: async () => {},
    note: () => {},
    status: () => ({
      project: null,
      url: null,
      crashed: false,
      unresponsive: false,
      loadError: null,
      consoleErrors: null,
    }),
    setVisible: () => {},
    setObserved: () => {},
    setAudioMuted: () => {},
  };
  const { core } = await coreLite({ preview: live as never, createNativeRuns: () => registry as never });
  await core.games.scaffold("pong", {
    title: "Pong",
    stack: GameStack.RaylibCpp,
    caller: ScaffoldCaller.Internal,
    targets: [BuildTarget.Mac],
  });
  await core.loadPreview({ project: "pong" });
  told.clear();
  shown.length = 0;
  await core.previewStageVisible(false);
  assert.deepEqual(shown, [["pong", false]], "the embedded run of the game Live holds rests with the stage");
  assert.equal(
    told.get(`pong/${NativeRunMode.Window}`)?.length ?? 0,
    0,
    "the Play window is never paused by the stage",
  );
  assert.equal(told.get(`pong/${NativeRunMode.Headless}`)?.length ?? 0, 0, "an agent's run is the agent's");
  await core.previewStageVisible(true);
  assert.deepEqual(shown, [
    ["pong", false],
    ["pong", true],
  ]);
});

/**
 * With Native chosen the web view gives its slot up (zero bounds) while the person still watches
 * Live: the game drawn in Live's own canvas is on screen, so it plays and is heard. Live hidden
 * (another room, Plugins) rests and mutes it. A Mac-only game's run is followed by the registry's
 * announcements, whatever page Live holds. The registry is a scripted stand-in.
 */
test("an embedded run follows the person watching Live, not the web view's bounds", async () => {
  const shown: Array<[string, boolean]> = [];
  const muted: boolean[] = [];
  const listeners: Array<(run: unknown) => void> = [];
  const embedded = new Set<string>();
  const registry = {
    start: async () => {
      throw new Error("nothing starts here");
    },
    stop: async () => {},
    stopAll: async () => {},
    stopAgentRuns: async () => {},
    stopProject: async () => {},
    stopMode: async () => {},
    stopOwnedBy: async () => {},
    state: (project: string, mode?: string) =>
      mode === NativeRunMode.Embedded && embedded.has(project) ? { project, mode, state: "ready" } : null,
    portOf: (project: string, mode?: string) =>
      mode === NativeRunMode.Embedded && embedded.has(project)
        ? { setVisible: () => {}, setAudioMuted: (value: boolean) => void muted.push(value) }
        : null,
    front: async () => false,
    sweepOrphans: async () => 0,
    onFocus: () => () => {},
    onStatus: (listener: (run: unknown) => void) => {
      listeners.push(listener);
      return () => {};
    },
    showEmbedded: (project: string, visible: boolean) => void shown.push([project, visible]),
  };
  const live = {
    load: async (project: string) => `game://${project}/index.html`,
    reload: async () => {},
    note: () => {},
    status: () => ({
      project: null,
      url: null,
      crashed: false,
      unresponsive: false,
      loadError: null,
      consoleErrors: null,
    }),
    setVisible: () => {},
    setObserved: () => {},
    setAudioMuted: () => {},
  };
  const { core } = await coreLite({ preview: live as never, createNativeRuns: () => registry as never });
  await core.games.scaffold("pong", {
    title: "Pong",
    stack: GameStack.RaylibCpp,
    caller: ScaffoldCaller.Internal,
    targets: [BuildTarget.Mac],
  });
  await core.previewStageVisible(true);
  embedded.add("pong");
  for (const listener of listeners) listener({ project: "pong", mode: NativeRunMode.Embedded, state: "ready" });
  shown.length = 0;
  muted.length = 0;
  await core.previewStageVisible(false, true);
  assert.deepEqual(shown.at(-1), ["pong", true], "Native on screen: the web view's zero bounds do not rest the game");
  assert.equal(muted.at(-1), false, "and it is heard");
  await core.previewStageVisible(false, false);
  assert.deepEqual(shown.at(-1), ["pong", false], "Live hidden: the embedded run rests");
  assert.equal(muted.at(-1), true, "and is not heard");
});
