/**
 * Usage analytics, phase 3 (P6): runs and Live say why. Live's status names why its page did not
 * load (`LiveLoadFailure`: Chromium's error number, or the game's own build that failed or fell back
 * to the last build that worked) and why its renderer went away (`PreviewGone`), and a load Electron
 * refused crosses IPC with its kind; `live_game_shown` says both. The harness records why it refused
 * a run's start beside its words (`RunStartRefusal` on `run_start_blocked`) and `run_start_refused`
 * says it. The core refuses a Resume with a `ResumeRefusal` that reaches `error_toast_shown`.
 * Forged values, words, paths, URLs and Node codes read as none.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { handleRunStart } from "../../src/harness-seed/loop/run-dispatch.ts";
import { createIpcHandle, type IpcResult, type IpcSender } from "../../src/main/ipc-handle.ts";
import { registerPreviewIpc } from "../../src/main/ipc/preview.ts";
import { codedLoadRefusal, failedLoad } from "../../src/main/preview-load-failure.ts";
import { createStudioBridge } from "../../src/preload/studio-bridge.ts";
import { liveRefusedProperties, liveShownProperties } from "../../src/renderer/analytics/builds-stage.ts";
import { errorToastsShown } from "../../src/renderer/analytics/events/launch.ts";
import { buildsLogEvents, buildsMemory, LiveOutcome, LiveTrigger } from "../../src/renderer/analytics/events/builds.ts";
import { givenUp } from "../../src/renderer/panels/stage/live-load.ts";
import { createToastsStore, notifyProblem } from "../../src/renderer/state/toasts.ts";
import { CustomEvent, customEventData, RunStartRefusal } from "../../src/shared/custom-events.ts";
import { CodedError, errorCode, errorCodeIn, errorMessage } from "../../src/shared/errors.ts";
import type { EventEnvelope } from "../../src/shared/event-log.ts";
import {
  isBuildLoadFailure,
  LiveLoadFailure,
  liveLoadFailure,
  PreviewGone,
} from "../../src/shared/preview-contract.ts";
import { HostMethod } from "../../src/shared/harness-api.ts";
import { HarnessCapability } from "../../src/shared/protocol.ts";
import { ResumeRefusal } from "../../src/shared/run-state.ts";
import type { StudioApi } from "../../src/shared/studio-api.ts";
import type { PreviewPort } from "../../src/substrate/preview-port.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";
import { assertClean, crossed, HOSTILE, HOSTILE_THROWS, refusalOf } from "../helpers/failure-codes.ts";

const T0 = Date.parse("2026-10-27T10:00:00.000Z");
const ORCHARD = "game://orchard/index.html";

/** What Electron's `loadURL` rejects with: Chromium's number and name, and the address it failed on. */
function electronRefusal(errno: number, name: string, url = ORCHARD): Error {
  return Object.assign(new Error(`${name} (${errno}) loading '${url}'`), { errno, code: name, url });
}

/** A load error that is nothing but addresses and build output: none of it may leave. */
const URL_LOAD_ERROR = `ERR_FILE_NOT_FOUND (-6) for file:///Users/alice/Secret Game/index.html via ${ORCHARD} and http://10.0.0.7:11434`;

/** Values a forged or older status, record or refusal may hold where a code belongs. */
const FORGED: readonly unknown[] = [...HOSTILE, URL_LOAD_ERROR, "not-found", "oom ", 6, -6, null, undefined, {}, []];

// ── Live ────────────────────────────────────────────────────────────────────────────────────

/** A Live probe of this game's page, as `previewLive` answers it. */
function probeOf(fields: { loadError?: string | null; loadFailure?: unknown; crashed?: boolean; gone?: unknown }) {
  const live = {
    project: "orchard",
    navigating: false,
    stopped: false,
    loadError: null,
    crashed: false,
    gone: null,
    loadFailure: null,
    unresponsive: false,
    page: null,
    ...fields,
  };
  return { live: live as never, current: true, broken: false, now: T0 + 1000 };
}

/** The renderer's preview calls over main's real preview handlers, as the app wires them. */
function previewBridge(core: { loadPreview?: () => Promise<string>; playLive?: () => Promise<void> }): StudioApi {
  const listeners = new Map<string, (event: IpcSender, payload: unknown) => Promise<IpcResult>>();
  const handle = createIpcHandle(
    { handle: (channel, listener) => listeners.set(channel, listener) },
    { fixture: false, isStudioUi: () => true },
  );
  const games = { touch: async () => {}, kindOf: async () => null };
  registerPreviewIpc(handle, {
    core: { games, ...core } as never,
    preview: () => null,
    previewBoundsSeen: { last: null },
  });
  const sender = { sender: "studio", senderFrame: "main-frame" };
  return createStudioBridge({
    invoke: (channel, payload) => {
      const listener = listeners.get(channel);
      assert.ok(listener, channel);
      return listener(sender, payload);
    },
    on: () => undefined,
    off: () => undefined,
  });
}

/** What a renderer call rejected with. */
const rejection = (call: Promise<unknown>): Promise<unknown> =>
  call.then(
    () => assert.fail("expected a refusal"),
    (err: unknown) => err,
  );

/** A Live port that records each load and each note the studio writes on its console. */
function recordingPort() {
  const notes: Array<{ message: string; options: { loadError?: boolean; failure?: LiveLoadFailure } | undefined }> = [];
  const loads: string[] = [];
  const port: PreviewPort = {
    async load(project, entry = "index.html", root) {
      loads.push(root ?? project);
      return `game://${project}/${entry}`;
    },
    async reload() {},
    note(_level, message, options) {
      notes.push({ message, options });
    },
    async screenshot() {
      return Buffer.alloc(0);
    },
    async evaluate() {
      return null;
    },
    async studioState() {
      return null;
    },
    async studioCall() {
      return null;
    },
    async input() {
      return { ok: true, applied: 0, width: 800, height: 600 };
    },
    consoleEntries: () => [],
    status: () => ({
      project: null,
      url: null,
      crashed: false,
      unresponsive: false,
      loadError: null,
      consoleErrors: 0,
    }),
  } as PreviewPort;
  return { port, notes, loads };
}

/** The harness's `preview.load` of Live, through the core's substrate table. */
async function loadLive(lite: CoreLite, project: string): Promise<void> {
  const load = lite.api()["preview.load"];
  assert.ok(load, "the core serves preview.load");
  await load({ project } as never);
}

/** A game with its own build, whose command the test sets. */
async function ownBuildGame(dir: string, command: string): Promise<void> {
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(path.join(dir, "index.html"), "<!doctype html><title>Orchard</title>\n");
  await writeFile(path.join(dir, "src", "main.js"), "export {};\n");
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "orchard", type: "module" }));
  await writeFile(
    path.join(dir, "studio.json"),
    JSON.stringify({
      name: "orchard",
      title: "orchard",
      createdAt: "",
      contractVersion: 1,
      entry: "dist/index.html",
      main: "src/main.js",
      build: command,
      serve: "dist",
      own: true,
      kind: "three-vite",
    }),
  );
}

/** Values that are not one of Chromium's load error numbers, or one it gives no kind. */
const NOT_CHROMIUM: readonly unknown[] = [
  ...HOSTILE,
  URL_LOAD_ERROR,
  "ERR_FILE_NOT_FOUND",
  "-6",
  Number.NaN,
  -1,
  0,
  null,
  {},
];

const BUILDS = "mkdir -p dist && cp index.html dist/index.html";
const BREAKS = "echo 'src/main.js:1:1 - error' >&2; exit 3";

describe("phase 3 analytics: Live says why its page did not show", () => {
  it("reads Chromium's load errors by kind, and anything else as other", () => {
    assert.equal(liveLoadFailure(-6), LiveLoadFailure.NotFound);
    assert.equal(liveLoadFailure(-102), LiveLoadFailure.ServerDown);
    assert.equal(liveLoadFailure(-20), LiveLoadFailure.Blocked);
    assert.equal(liveLoadFailure(-3), LiveLoadFailure.Aborted);
    for (const value of NOT_CHROMIUM) assert.equal(liveLoadFailure(value), LiveLoadFailure.Other, String(value));
    assert.equal(isBuildLoadFailure(LiveLoadFailure.StaleBuild), true);
    assert.equal(isBuildLoadFailure(LiveLoadFailure.BuildFailed), true);
    assert.equal(isBuildLoadFailure(LiveLoadFailure.NotFound), false);
    assert.equal(isBuildLoadFailure(null), false);
  });

  it("a failed load keeps its line beside its kind; one another navigation replaced is no failure", () => {
    assert.deepEqual(failedLoad(-6, "ERR_FILE_NOT_FOUND", ORCHARD), {
      loadError: `ERR_FILE_NOT_FOUND (-6) for ${ORCHARD}`,
      loadFailure: LiveLoadFailure.NotFound,
    });
    assert.equal(failedLoad(-3, "ERR_ABORTED", ORCHARD), null);
  });

  it("the stage's build notes say whether the build left nothing to show or the last build that worked", async () => {
    const live = recordingPort();
    const lite = await coreLite({ preview: live.port });
    try {
      const dir = path.join(lite.gamesRoot, "orchard");
      await ownBuildGame(dir, BREAKS);
      const project = await lite.core.adoptProject(dir);
      await loadLive(lite, project.name);
      assert.equal(live.loads.length, 0, "no build ever worked, so nothing was loaded");
      assert.equal(live.notes.at(-1)?.options?.failure, LiveLoadFailure.BuildFailed);
      assert.equal(live.notes.at(-1)?.options?.loadError, true, "the note is still the page's load error");

      await ownBuildGame(dir, BUILDS);
      await loadLive(lite, project.name);
      const before = live.notes.length;
      await ownBuildGame(dir, BREAKS);
      await loadLive(lite, project.name);
      assert.equal(live.loads.length, 2, "the last build that worked is loaded again");
      // The build's note comes before the load, which clears it; the page is then told it is stale.
      assert.deepEqual(
        live.notes.slice(before).map((note) => note.options?.failure),
        [LiveLoadFailure.BuildFailed, LiveLoadFailure.StaleBuild],
      );
      assert.match(live.notes.at(-1)?.message ?? "", /the game's build failed/, "the words stay as they were");
    } finally {
      await lite.close();
    }
  });

  it("a load Electron refused crosses IPC with its kind beside the same words; other failures carry none", async () => {
    const refused = electronRefusal(-6, "ERR_FILE_NOT_FOUND");
    const bridge = previewBridge({
      loadPreview: () => Promise.reject(refused),
      playLive: () => Promise.reject(refused),
    });
    const loaded = await rejection(bridge.loadPreview("orchard"));
    assert.equal(errorCodeIn(LiveLoadFailure, loaded), LiveLoadFailure.NotFound);
    assert.equal(errorMessage(loaded), refused.message, "the words stay as they were");
    const played = await rejection(bridge.playPreview());
    assert.equal(errorCodeIn(LiveLoadFailure, played), LiveLoadFailure.NotFound, "Play's load too");
    const down = await crossed(codedLoadRefusal(electronRefusal(-102, "ERR_CONNECTION_REFUSED")));
    assert.equal(errorCode(down), LiveLoadFailure.ServerDown);
    for (const [label, thrown] of HOSTILE_THROWS) {
      assert.equal(codedLoadRefusal(thrown), thrown, `${label} is thrown as it was`);
      const other = await rejection(
        previewBridge({ loadPreview: () => Promise.reject(thrown) }).loadPreview("orchard"),
      );
      assert.equal(errorCodeIn(LiveLoadFailure, other), null, label);
    }
    const forgedErrno = Object.assign(new Error(URL_LOAD_ERROR), { errno: "-6" });
    assert.equal(codedLoadRefusal(forgedErrno), forgedErrno, "an errno that is not Chromium's number");
  });
});

describe("phase 3 analytics: live_game_shown says why Live gave up", () => {
  it("a stage that fell back to the last build that worked gave up on a broken build, not a failed load", () => {
    const load = { project: "orchard", pending: false, since: T0 };
    const stale = probeOf({
      loadError: "the game's build failed (npm run build, exit 3)",
      loadFailure: LiveLoadFailure.StaleBuild,
    });
    assert.equal(givenUp(load, stale), LiveOutcome.BuildBroken);
    const nothing = probeOf({ loadError: "the game's build failed", loadFailure: LiveLoadFailure.BuildFailed });
    assert.equal(givenUp(load, nothing), LiveOutcome.BuildBroken);
    assert.equal(
      givenUp(load, probeOf({ loadError: URL_LOAD_ERROR, loadFailure: LiveLoadFailure.NotFound })),
      LiveOutcome.LoadFailed,
    );
    assert.equal(givenUp(load, probeOf({ crashed: true, gone: PreviewGone.Oom })), LiveOutcome.Crashed);
    for (const forged of FORGED)
      assert.equal(givenUp(load, probeOf({ loadError: URL_LOAD_ERROR, loadFailure: forged })), LiveOutcome.LoadFailed);
  });

  it("live_game_shown says the load's failure and the crash's reason, re-checked against their vocabularies", () => {
    const shown = {
      outcome: LiveOutcome.LoadFailed,
      load: { since: T0, trigger: LiveTrigger.Reload },
      now: T0 + 1000,
      firstInLaunch: false,
      gameCreatedAt: null,
      firstMessageAt: null,
      state: null,
      gameRef: null,
    };
    const failed = liveShownProperties({ ...shown, failure: { load: LiveLoadFailure.NotFound, gone: null } });
    assert.equal(failed.load_failure, LiveLoadFailure.NotFound);
    assert.equal(failed.crash_reason, null);
    const crashed = liveShownProperties({
      ...shown,
      outcome: LiveOutcome.Crashed,
      failure: { load: null, gone: PreviewGone.Oom },
    });
    assert.equal(crashed.crash_reason, PreviewGone.Oom);
    assert.equal(liveShownProperties(shown).load_failure, null, "a probe that said nothing");
    for (const forged of FORGED) {
      const properties = liveShownProperties({ ...shown, failure: { load: forged, gone: forged } });
      assert.equal(properties.load_failure, null, String(forged));
      assert.equal(properties.crash_reason, null, String(forged));
      assertClean(String(forged), properties);
    }
  });

  it("a load the stage asked for and main refused is told as load_failed with its code; a replaced one is not", async () => {
    const load = { since: T0, trigger: LiveTrigger.Play };
    const refused = await crossed(codedLoadRefusal(electronRefusal(-6, "ERR_FILE_NOT_FOUND")));
    const properties = liveRefusedProperties(load, refused, { now: T0 + 2000, gameRef: "0123456789abcdef" });
    assert.equal(properties?.outcome, LiveOutcome.LoadFailed);
    assert.equal(properties?.load_failure, LiveLoadFailure.NotFound);
    assert.equal(properties?.load_ms, 2000);
    assert.equal(properties?.trigger, LiveTrigger.Play);
    const aborted = await crossed(codedLoadRefusal(electronRefusal(-3, "ERR_ABORTED")));
    assert.equal(
      liveRefusedProperties(load, aborted, { now: T0, gameRef: null }),
      null,
      "its replacement reports itself",
    );
    for (const [label, thrown] of HOSTILE_THROWS) {
      const other = liveRefusedProperties(load, await crossed(thrown), { now: T0, gameRef: null });
      assert.equal(other?.outcome, LiveOutcome.LoadFailed, label);
      assert.equal(other?.load_failure, null, label);
      assertClean(label, other ?? {});
    }
  });
});

// ── run starts ──────────────────────────────────────────────────────────────────────────────

/** One record a harness appends, as far as these tests read it. */
type Appended = { event_type?: string; payload?: Record<string, unknown> };

/** A harness host in memory: `game.list` and `game.validate` answer as given, every append is kept. */
function memoryHost(game: Record<string, unknown>, missing: unknown = undefined) {
  const appended: Appended[] = [];
  const host = {
    workspace: "/nonexistent",
    notify: () => {},
    heartbeat: () => {},
    call: async (method: string, params?: { batch?: Appended[] }): Promise<unknown> => {
      if (method === HostMethod.EventsAppend) appended.push(...(params?.batch ?? []));
      if (method === HostMethod.GameList) return [game];
      if (method === HostMethod.GameValidate) return { problems: [], missing };
      return null;
    },
  };
  const studio = {
    host,
    cancels: new Set<string>(),
    moodBoards: new Map(),
    activeRuns: new Map(),
    startingRuns: new Map(),
    orphanRuns: new Map(),
    scoped: () => ({ ...host, host, cancelled: false, setStatus: () => {} }),
  };
  const blocked = () =>
    appended.filter((data) => data.event_type === CustomEvent.RunStartBlocked).map((data) => data.payload ?? {});
  return { studio, blocked };
}

const start = (runId: string, project: string) => ({
  type: "run_start",
  threadId: "chat-1",
  run: { runId, project, goal: "an orchard" },
});

/** A `run_start_blocked` record as the log holds it. */
function blockedRecord(payload: Record<string, unknown>): EventEnvelope {
  return {
    id: "ev-1",
    thread_id: "thread-5b7e21",
    session_id: null,
    turn_id: null,
    created_at: new Date(T0).toISOString(),
    data: customEventData(CustomEvent.RunStartBlocked, payload),
  };
}

describe("phase 3 analytics: a refused run start says why", () => {
  it("the harness records why it refused a start beside the words the chat reads", async () => {
    const exported = memoryHost({ name: "orchard", shape: { kind: "engine-export" } });
    await Promise.all([
      handleRunStart(exported.studio as never, start("run-a", "orchard") as never),
      handleRunStart(exported.studio as never, start("run-b", "orchard") as never),
    ]);
    const [folder, second] = [
      exported.blocked().find((payload) => payload.requestedRunId === "run-a"),
      exported.blocked().find((payload) => payload.requestedRunId === "run-b"),
    ];
    assert.equal(folder?.refusal, RunStartRefusal.EngineExport);
    assert.match(String(folder?.reason), /exported from a game engine/, "the words stay as they were");
    assert.equal(second?.refusal, RunStartRefusal.RunOwnsThread, JSON.stringify(exported.blocked()));

    const web = memoryHost({ name: "orchard", facts: [{ id: "web-game", path: "." }] }, ["index.html"]);
    await handleRunStart(web.studio as never, start("run-c", "orchard") as never, { keepStop: true });
    const [notReady] = web.blocked();
    assert.equal(notReady?.refusal, RunStartRefusal.WebNotReady);
    assert.match(String(notReady?.reason), /is not ready for a run: index\.html is missing/);
  });

  it("run_start_refused carries the refusal; a forged one, or none from an older harness, reads as none", () => {
    const [sent] = buildsLogEvents(
      blockedRecord({ refusal: RunStartRefusal.WebNotReady, reason: "x" }),
      buildsMemory(),
    );
    assert.deepEqual(sent?.properties, { conflict: false, refusal: RunStartRefusal.WebNotReady });
    const [older] = buildsLogEvents(blockedRecord({ runId: "run-a", reason: "A run already owns" }), buildsMemory());
    assert.deepEqual(older?.properties, { conflict: true, refusal: null });
    for (const forged of FORGED) {
      const [read] = buildsLogEvents(blockedRecord({ refusal: forged, reason: URL_LOAD_ERROR }), buildsMemory());
      assert.deepEqual(read?.properties, { conflict: false, refusal: null }, String(forged));
      assertClean(String(forged), read?.properties ?? {});
    }
  });
});

// ── Resume ──────────────────────────────────────────────────────────────────────────────────

describe("phase 3 analytics: a refused Resume says why", () => {
  it("main refuses a Resume with a code beside the same words, and error_toast_shown says it", async () => {
    const lite = await coreLite();
    const { core } = lite;
    try {
      const none = await refusalOf(core.resumeAutopilot("run-none"));
      assert.equal(errorCodeIn(ResumeRefusal, none), ResumeRefusal.NoJournal);
      assert.match(errorMessage(none), /no Autopilot journal found for run run-none/, "the words stay as they were");
      const thread = await core.store.createThread({ title: "Orchard", metadata: {} });
      await core.store.writeArtifact(thread, "autopilot_run-done", { phase: "done" });
      const done = await refusalOf(core.resumeAutopilot("run-done"));
      assert.equal(errorCodeIn(ResumeRefusal, done), ResumeRefusal.AlreadyFinished);
      Object.defineProperty(core.host, "state", { configurable: true, get: () => "ready" });
      const lacksAutopilot = (capability: HarnessCapability) => capability !== HarnessCapability.Autopilot;
      Object.defineProperty(core.host, "hasCapability", { configurable: true, value: lacksAutopilot });
      const older = await refusalOf(core.resumeAutopilot("run-done"));
      assert.equal(errorCodeIn(ResumeRefusal, older), ResumeRefusal.Unsupported);

      const toasts = createToastsStore(() => undefined);
      const before = toasts.getState();
      notifyProblem(toasts.notify)(older);
      for (const [, thrown] of HOSTILE_THROWS) notifyProblem(toasts.notify)(await crossed(thrown));
      const shown = errorToastsShown(before, toasts.getState(), "/game/chat");
      assert.equal(shown[0]?.code, ResumeRefusal.Unsupported);
      assert.deepEqual(
        shown.slice(1).map((toast) => toast.code),
        HOSTILE_THROWS.map(() => null),
      );
      for (const toast of shown) assertClean("error_toast_shown", toast);
      assert.equal(errorCode(new CodedError(ResumeRefusal.NoJournal, "x")), ResumeRefusal.NoJournal);
    } finally {
      Reflect.deleteProperty(core.host, "state");
      Reflect.deleteProperty(core.host, "hasCapability");
      await lite.close();
    }
  });
});
