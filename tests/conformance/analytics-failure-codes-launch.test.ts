/**
 * Usage analytics, phase 3 (P7, P8, P10): a launch says how it started and how the session before
 * it ended, and main says what went wrong on its own side. Main keeps a marker of each session in
 * the data folder (`main/session-marker.ts`) and hands its typed facts with the first bootstrap
 * only; the boot gate names each held start with a `BootFailure` code beside its words and says
 * which steps the start passed through; Relaunch to update answers a `RestartAnswer`; a background
 * update's failure names its `UpdateFailure` stage; main's own uncaught errors and a window's hang
 * reach the window as `app.diagnostic`. The renderer sends `previous_session_ended`,
 * `app_ready_measured`'s start facts, `update_restart_pressed`, `update_background_failed`,
 * `agents_start_failed`, `app_error_caught` (process main) and `window_unresponsive`. A forged
 * marker or payload (words, paths, huge numbers) reads as none.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import type { PostHog } from "posthog-js";
import { createStore, type StoreApi } from "zustand/vanilla";
import { installProcessHandlers } from "../../src/main/app-lifecycle.ts";
import { createUpdateAnnouncer, InstallCheck, watchInstaller } from "../../src/main/auto-update.ts";
import { createBootGate } from "../../src/main/boot-gate.ts";
import { DataLaunchKind, pointElectronAtData, writeDataFolderRecord } from "../../src/main/data-folder.ts";
import { createIpcHandle, type IpcResult, type IpcSender } from "../../src/main/ipc-handle.ts";
import { MainDiagnostic, type PreviousSession, RendererGone, SessionExit } from "../../src/shared/app-session.ts";
import { RestartAnswer, UpdateFailure } from "../../src/shared/app-update.ts";
import {
  BootFailure,
  BootPhase,
  SandboxProblemCode,
  type StartFacts,
  StartPassage,
  StartStep,
  StudioPlatform,
} from "../../src/shared/boot.ts";
import { DAY_MS, MINUTE_MS, SECOND_MS } from "../../src/shared/duration.ts";
import type { Bootstrap } from "../../src/shared/studio-api.ts";
import { UiEvent } from "../../src/shared/ui-events.ts";
import { SandboxUnavailableError } from "../../src/substrate/sandbox-unavailable.ts";
import { startAnalytics } from "../../src/renderer/analytics/client.ts";
import { AnalyticsEvent } from "../../src/renderer/analytics/events.ts";
import * as launchEvents from "../../src/renderer/analytics/events/launch.ts";
import { CountBucket, type EventProperties } from "../../src/renderer/analytics/properties.ts";
import { SessionStatus } from "../../src/renderer/state/session.ts";
import type { Studio } from "../../src/renderer/state/studio.ts";
import { createToastsStore } from "../../src/renderer/state/toasts.ts";
import { assertClean, HOSTILE, HOSTILE_THREAD } from "../helpers/failure-codes.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** Main's new modules, loaded where a test needs them. */
const sessionMarkers = () => import("../../src/main/session-marker.ts");
const appDiagnostics = () => import("../../src/main/app-diagnostics.ts");

const T0 = Date.parse("2026-10-27T10:00:00.000Z");
const VERSION = "0.4.0";

/** One recorder in place of PostHog's for the file: every event captured. */
const captured: Array<{ event: string; properties: EventProperties }> = [];
const posthog = {
  init: () => undefined,
  has_opted_out_capturing: () => false,
  opt_in_capturing: () => undefined,
  register: () => undefined,
  stopSessionRecording: () => undefined,
  capture: (event: string, properties: EventProperties) => captured.push({ event, properties }),
} as unknown as PostHog;
async function recorder(): Promise<typeof captured> {
  await startAnalytics({ key: "phc_test", host: "https://eu.i.posthog.com" }, { replay: false }, async () => ({
    posthog,
  }));
  captured.length = 0;
  return captured;
}
const sentOf = (sent: typeof captured, event: string): EventProperties[] =>
  sent.filter((one) => one.event === event).map((one) => one.properties);

/** A marker kept in memory, as `markerFileIo` keeps it on disk. */
function memoryIo(text: string | null = null) {
  const held = { text };
  return {
    held,
    io: {
      read: async () => held.text,
      write: async (next: string) => {
        held.text = next;
      },
    },
  };
}

/** A clock the test moves by hand. */
function handClock(start = T0) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/** The launch observers over stores a test drives, started. */
function launchHeard(session: StoreApi<Record<string, unknown>>) {
  const observers = launchEvents.createLaunchObservers(
    () => T0,
    (run) => run(),
  );
  const update = createStore(() => ({ ready: null }));
  const toasts = createToastsStore(() => undefined);
  const stop = observers.start?.({ update, session, toasts } as unknown as Studio);
  return { ui: (event: unknown) => observers.ui?.(event as UiEvent), stop: () => stop?.() };
}

/** Every value of a previous session's facts is a vocabulary's or a bounded whole number. */
function assertTyped(label: string, previous: PreviousSession | null): void {
  if (!previous) return;
  assert.ok(Object.values(SessionExit).includes(previous.exit), label);
  assert.ok(previous.lastCrash === null || Object.values(RendererGone).includes(previous.lastCrash), label);
  for (const count of [previous.rendererCrashes, previous.hangs, previous.mainErrors, previous.updateFailures])
    assert.ok(Number.isInteger(count) && count >= 0 && count <= 10_000, `${label}: ${count}`);
  const { uptimeMs } = previous;
  assert.ok(uptimeMs === null || (Number.isFinite(uptimeMs) && uptimeMs >= 0), label);
}

describe("P8: how the previous session ended", () => {
  it("a marker kept through a session says how it ended, read once at the next launch", async () => {
    const { createSessionMarker } = await sessionMarkers();
    const { io } = memoryIo();
    const clock = handClock();
    const first = createSessionMarker({ io, version: VERSION, now: clock.now });
    assert.deepEqual(await first.begin(), { previous: null, notes: [] }, "a first launch has nothing before it");
    first.rendererGone(RendererGone.Crashed);
    first.rendererGone(RendererGone.CleanExit);
    first.rendererGone(RendererGone.Oom);
    first.hung();
    first.mainError();
    first.updateFailed();
    clock.advance(42 * MINUTE_MS);
    first.heartbeat();
    await first.flushed();

    const second = createSessionMarker({ io, version: VERSION, now: clock.now });
    assert.deepEqual((await second.begin()).previous, {
      exit: SessionExit.Unclean,
      rendererCrashes: 2,
      lastCrash: RendererGone.Oom,
      hangs: 1,
      mainErrors: 1,
      updateFailures: 1,
      uptimeMs: 42 * MINUTE_MS,
    });
    await second.quitting();
    const ended = async (version: string) => {
      const next = createSessionMarker({ io, version, now: clock.now });
      return { marker: next, previous: (await next.begin()).previous };
    };
    const third = await ended(VERSION);
    assert.equal(third.previous?.exit, SessionExit.Clean);
    assert.equal(third.previous?.rendererCrashes, 0, "each session counts its own");
    await third.marker.updating();
    await third.marker.quitting();
    const fourth = await ended(VERSION);
    assert.equal(fourth.previous?.exit, SessionExit.UpdateInterrupted, "relaunched to update, still the old version");
    await fourth.marker.updating();
    const fifth = await ended("0.5.0");
    assert.equal(fifth.previous?.exit, SessionExit.UpdateInstalled);
    await fifth.marker.quitting();
    const sixth = await ended("0.6.0");
    assert.equal(sixth.previous?.exit, SessionExit.UpdateInstalled, "a downloaded update installs at a quit");
  });

  it("a missing, corrupt or forged marker gives no facts, or only typed ones", async () => {
    const { readPrevious } = await sessionMarkers();
    const valid = { v: 1, state: "running", version: VERSION, startedAt: T0, aliveAt: T0 + SECOND_MS };
    const forged: ReadonlyArray<[string, string | null]> = [
      ["no marker", null],
      ["empty", ""],
      ["not JSON", "{running"],
      ["an array", "[]"],
      ["null", "null"],
      ["another shape", JSON.stringify({ ...valid, v: 2 })],
      ["words as state", JSON.stringify({ ...valid, state: HOSTILE[5] })],
      ["a path as version", JSON.stringify({ ...valid, version: "x".repeat(5000) })],
      [
        "words and paths everywhere",
        JSON.stringify({
          ...valid,
          rendererCrashes: HOSTILE[0],
          lastCrash: HOSTILE[2],
          hangs: -4,
          mainErrors: 1.5,
          updateFailures: 1e308,
          notes: [HOSTILE[0], StartPassage.DataMoved, HOSTILE_THREAD, StartPassage.DataMoved],
        }),
      ],
      ["a start after its last sign of life", JSON.stringify({ ...valid, startedAt: T0 + DAY_MS })],
      ["times as words", JSON.stringify({ ...valid, startedAt: "yesterday", aliveAt: HOSTILE[8] })],
    ];
    for (const [label, text] of forged) {
      const { previous, notes } = readPrevious(text, VERSION);
      assertTyped(label, previous);
      assert.ok(
        notes.every((note) => Object.values(StartPassage).includes(note)),
        label,
      );
      if (previous) assertClean(label, launchEvents.previousSessionProperties(previous) ?? {});
    }
    const words = readPrevious(forged[8]?.[1] ?? null, VERSION);
    assert.equal(words.previous?.rendererCrashes, 0);
    assert.equal(words.previous?.lastCrash, null);
    assert.equal(words.previous?.updateFailures, 10_000, "a huge count is capped");
    assert.deepEqual(words.notes, [StartPassage.DataMoved]);
    assert.equal(readPrevious(forged[9]?.[1] ?? null, VERSION).previous?.uptimeMs, null);
    assert.equal(readPrevious(forged[6]?.[1] ?? null, VERSION).previous, null, "an unknown state is no session");
  });

  it("the marker is read only as a file of its own and written only in a folder of its own", async (t) => {
    if (process.platform === "win32") return t.skip("links need privileges on Windows");
    const { createSessionMarker, markerFileIo } = await sessionMarkers();
    const root = await tmpDir("session-marker-");
    const secret = path.join(root, "secret.txt");
    await writeFile(secret, HOSTILE[6]);
    const linked = path.join(root, "linked-file");
    await mkdir(path.join(linked, "analytics"), { recursive: true });
    await symlink(secret, path.join(linked, "analytics", "session.json"));
    const marker = createSessionMarker({ io: markerFileIo(linked), version: VERSION, now: () => T0 });
    assert.deepEqual(await marker.begin(), { previous: null, notes: [] }, "a link is not read");
    assert.equal(await readFile(secret, "utf8"), HOSTILE[6], "nor written through");
    const kept = JSON.parse(await readFile(path.join(linked, "analytics", "session.json"), "utf8"));
    assert.equal(kept.state, "running", "the link is replaced by the marker itself");

    const elsewhere = path.join(root, "elsewhere");
    await mkdir(elsewhere);
    const linkedDir = path.join(root, "linked-folder");
    await mkdir(linkedDir);
    await symlink(elsewhere, path.join(linkedDir, "analytics"));
    const other = createSessionMarker({ io: markerFileIo(linkedDir), version: VERSION, now: () => T0 });
    await other.begin();
    await other.quitting();
    assert.deepEqual(await readdir(elsewhere), [], "nothing is written through a linked folder");
  });

  it("main hands the facts with the first bootstrap only; a reload or Retry gets none", async () => {
    const { handOnce, launchFacts } = await sessionMarkers();
    const { registerThreadsIpc } = await import("../../src/main/ipc/threads.ts");
    const previous: PreviousSession = {
      exit: SessionExit.Unclean,
      rendererCrashes: 1,
      lastCrash: RendererGone.Crashed,
      hangs: 0,
      mainErrors: 0,
      updateFailures: 0,
      uptimeMs: MINUTE_MS,
    };
    const start: StartFacts = { passed: [StartPassage.SandboxSetup], failure: null, retries: 1 };
    const facts = launchFacts({ previous, notes: [StartPassage.DataMissing] }, start, true);
    assert.deepEqual(facts.start.passed, [
      StartPassage.DataMissing,
      StartPassage.SandboxSetup,
      StartPassage.DataFallback,
    ]);
    const listeners = new Map<string, (event: IpcSender, payload: unknown) => Promise<IpcResult>>();
    const handle = createIpcHandle(
      { handle: (channel, listener) => listeners.set(channel, listener) },
      { fixture: false, isStudioUi: () => true },
    );
    const core = {
      mainThread: "thread-main",
      layout: {},
      host: { state: "ready", harnessVersion: null, capabilities: [] },
      store: { listAllSince: async () => ({ events: [], cursor: null }), listThreads: async () => [] },
      games: { list: async () => [] },
      activeBuilders: () => ({}),
    };
    const deps = {
      core,
      engines: { bootstrap: async () => [] },
      gamesRootLabel: () => "~/AI Games",
      threadStatus: () => ({}),
      smokeReads: null,
      analytics: null,
      launchFacts: handOnce(async () => facts),
    } as unknown as Parameters<typeof registerThreadsIpc>[1];
    registerThreadsIpc(handle, deps);
    const bootstrap = listeners.get("studio:bootstrap");
    assert.ok(bootstrap);
    const sender = { sender: "studio", senderFrame: "main-frame" };
    const answers = await Promise.all([bootstrap(sender, undefined), bootstrap(sender, undefined)]);
    const launches = answers.map((answer) => (answer.ok ? (answer.value as Bootstrap).launch : "failed"));
    assert.deepEqual(launches, [facts, null]);
    const reload = await bootstrap(sender, undefined);
    assert.equal(reload.ok && (reload.value as Bootstrap).launch, null);
  });

  it("the renderer sends previous_session_ended once, from the first bootstrap's facts", async () => {
    const sent = await recorder();
    const previous: PreviousSession = {
      exit: SessionExit.UpdateInterrupted,
      rendererCrashes: 3,
      lastCrash: RendererGone.Crashed,
      hangs: 1,
      mainErrors: 0,
      updateFailures: 2,
      uptimeMs: 3 * MINUTE_MS,
    };
    const launch = { previous, start: { passed: [], failure: null, retries: 0 } };
    const session = createStore<Record<string, unknown>>(() => ({ status: SessionStatus.Loading, launch: null }));
    const heard = launchHeard(session);
    session.setState({ status: SessionStatus.Ready, launch });
    session.setState({ status: SessionStatus.Loading, launch: null });
    session.setState({ status: SessionStatus.Ready, launch });
    heard.stop();
    assert.deepEqual(sentOf(sent, AnalyticsEvent.PreviousSessionEnded), [
      {
        exit: SessionExit.UpdateInterrupted,
        renderer_crashes: CountBucket.Few,
        last_crash_reason: RendererGone.Crashed,
        hangs: CountBucket.One,
        main_errors: CountBucket.None,
        update_failures: CountBucket.Few,
        uptime_bucket: launchEvents.UptimeBucket.Minutes,
      },
    ]);
    const forged = [
      { ...previous, exit: HOSTILE[0] },
      { ...previous, exit: "clean", rendererCrashes: HOSTILE[3], lastCrash: HOSTILE[2], uptimeMs: -5, hangs: 1e308 },
      HOSTILE[5],
      null,
    ];
    for (const facts of forged) {
      const properties = launchEvents.previousSessionProperties(facts);
      if (properties) assertClean(JSON.stringify(facts), properties);
    }
    assert.equal(launchEvents.previousSessionProperties(forged[0]), null, "an exit that is not one is no event");
    assert.deepEqual(launchEvents.previousSessionProperties(forged[1]), {
      exit: SessionExit.Clean,
      renderer_crashes: CountBucket.None,
      last_crash_reason: null,
      hangs: CountBucket.Many,
      main_errors: CountBucket.None,
      update_failures: CountBucket.Few,
      uptime_bucket: null,
    });
  });
});

describe("P10a: Relaunch to update, and updates that fail in the background", () => {
  it("Relaunch says why it did not relaunch; the buttons still read only whether it did", async () => {
    let agree = false;
    let asking: ((agree: boolean) => void) | null = null;
    const updates = createUpdateAnnouncer({
      studioUp: () => true,
      announce: () => undefined,
      notify: () => undefined,
      confirmRestart: () =>
        asking === null
          ? Promise.resolve(agree)
          : new Promise((resolve) => {
              asking = resolve;
            }),
      quitAndInstall: () => undefined,
      openRelease: () => undefined,
    });
    assert.equal(await updates.restart(), RestartAnswer.NoUpdate);
    updates.downloaded("Genex 0.5.0");
    assert.equal(await updates.restart(), RestartAnswer.Declined);
    asking = () => undefined;
    const first = updates.restart();
    assert.equal(await updates.restart(), RestartAnswer.AlreadyAsking);
    asking(true);
    assert.equal(await first, RestartAnswer.Relaunching);
    asking = null;
    agree = true;
    assert.equal(await updates.restart(), RestartAnswer.Relaunching);

    const sent = await recorder();
    const pressed = async (answer: unknown) =>
      launchEvents.trackedRestart(launchEvents.UpdateSurface.About, async () => answer as RestartAnswer);
    assert.equal(await pressed(RestartAnswer.Relaunching), true);
    assert.equal(await pressed(RestartAnswer.Declined), false);
    assert.equal(await pressed(true), false, "an answer that is not one never reads as relaunching");
    assert.equal(await pressed(HOSTILE[0]), false);
    const outcomes = sentOf(sent, AnalyticsEvent.UpdateRestartPressed).map((properties) => properties.outcome);
    assert.deepEqual(outcomes, [RestartAnswer.Relaunching, RestartAnswer.Declined, null, null]);
  });

  it("a background update failure names its stage; a busy refusal or a person's own check is not one", async () => {
    const listeners = new EventEmitter();
    let checking: (() => void) | null = null;
    const updater = {
      on: (event: string, listener: (error?: unknown) => void) => listeners.on(event, listener),
      once: (event: string, listener: (error?: unknown) => void) => listeners.once(event, listener),
      removeListener: (event: string, listener: (error?: unknown) => void) => listeners.removeListener(event, listener),
      checkForUpdates: () => checking?.(),
    };
    const stages: UpdateFailure[] = [];
    const installer = watchInstaller(updater, { timeoutMs: SECOND_MS, failed: (stage) => stages.push(stage) });
    listeners.emit("checking-for-update");
    listeners.emit("error", new Error(HOSTILE[7]));
    listeners.emit("checking-for-update");
    listeners.emit("update-available");
    listeners.emit("error", Object.assign(new Error("busy"), { domain: "RACCommandErrorDomain", code: 1 }));
    listeners.emit("error", new Error("ECONNRESET"));
    checking = () => listeners.emit("error", new Error(HOSTILE[7]));
    assert.equal(await installer.ask(), InstallCheck.Failed, "the person's own check fails as it did");
    checking = null;
    listeners.emit("checking-for-update");
    listeners.emit("update-available");
    listeners.emit("update-downloaded");
    listeners.emit("error", new Error("No update available, can't quit and install"));
    assert.deepEqual(stages, [UpdateFailure.Check, UpdateFailure.Download, UpdateFailure.Install]);

    const sent = await recorder();
    const session = createStore<Record<string, unknown>>(() => ({ status: SessionStatus.Ready, launch: null }));
    const heard = launchHeard(session);
    heard.ui({ type: UiEvent.UpdateFailed, payload: { stage: UpdateFailure.Download } });
    for (const stage of [HOSTILE[0], 3, null, "download "])
      heard.ui(JSON.parse(JSON.stringify({ type: UiEvent.UpdateFailed, payload: { stage } })));
    heard.ui({ type: UiEvent.UpdateFailed });
    heard.stop();
    const failures = sentOf(sent, AnalyticsEvent.UpdateBackgroundFailed);
    assert.deepEqual(failures, [
      { stage: UpdateFailure.Download },
      { stage: null },
      { stage: null },
      { stage: null },
      { stage: null },
      { stage: null },
    ]);
    for (const properties of failures) assertClean("update_background_failed", properties);
  });
});

describe("P7: how the app started", () => {
  it("each held start has a typed code beside its words, and a Try again that fails keeps it", async () => {
    const gate = createBootGate(StudioPlatform.Windows);
    gate.starting(StartStep.Workspace);
    gate.overdue("still starting after 3 minutes", async () => {});
    assert.equal(gate.state().failureCode, BootFailure.StartOverdue);
    gate.fail("harness exited during boot", async () => {
      throw new Error(HOSTILE[4]);
    });
    assert.equal(gate.state().failureCode, BootFailure.CoreFailed);
    const again = await gate.retry();
    assert.equal(again.failure, HOSTILE[4], "the words are the new failure's");
    assert.equal(again.failureCode, BootFailure.CoreFailed, "the code is still the screen's");
    gate.moveStopped("D:\\Genex", "A file was in use.", async () => {});
    assert.equal(gate.state().failureCode, BootFailure.MoveStopped);
    gate.dataMissing("D:\\Genex", async () => {});
    assert.equal(gate.state().failureCode, BootFailure.DataMissing);
    gate.agentsFailed("srt-win acl stamp timed out", async () => {});
    assert.deepEqual([gate.state().phase, gate.state().failureCode], [BootPhase.Ready, BootFailure.HarnessFailed]);
    gate.agentsFailed("bubblewrap is missing", async () => {}, SandboxProblemCode.MissingTools);
    assert.equal(gate.state().failureCode, SandboxProblemCode.MissingTools, "the sandbox's own code where known");
    gate.ready();
    assert.equal(gate.state().failureCode, undefined);
  });

  it("the gate says which steps the start passed through, its last failure and its tries", async () => {
    const quiet = createBootGate(StudioPlatform.Mac);
    quiet.ready();
    assert.deepEqual(quiet.started(), { passed: [], failure: null, retries: 0 });

    const gate = createBootGate(StudioPlatform.Linux);
    const problem = {
      code: SandboxProblemCode.MissingTools,
      platform: "linux",
      missingTools: [],
      installCommands: [],
      details: [HOSTILE[0]],
    };
    let tries = 0;
    gate.hold(problem, async () => {
      tries++;
      if (tries === 1) throw new SandboxUnavailableError(problem);
      gate.fail("harness exited during boot", async () => gate.ready());
    });
    await gate.retry();
    await gate.retry();
    await gate.retry();
    assert.equal(gate.state().phase, BootPhase.Ready);
    assert.deepEqual(gate.started(), {
      passed: [StartPassage.SandboxSetup, StartPassage.FailureRetried],
      failure: BootFailure.CoreFailed,
      retries: 3,
    });
    gate.agentsFailed("later", async () => {});
    assert.equal(
      gate.started().failure,
      BootFailure.CoreFailed,
      "what happens after the studio opened is not its start",
    );
  });

  it("a data folder Electron could not use falls back, and says so", async () => {
    const root = await tmpDir("data-fallback-");
    const appData = path.join(root, "AppData");
    const defaultDir = path.join(appData, "Genex");
    await mkdir(defaultDir, { recursive: true });
    await writeDataFolderRecord(defaultDir, { moveTo: path.join(root, "D", "Genex") });
    const launch = pointElectronAtData({
      appData,
      appName: "Genex",
      temp: path.join(root, "Temp"),
      argvNormal: true,
      setPath: (_name, dir) => {
        if (dir !== defaultDir) throw new Error("Failed to set path");
      },
      lock: () => true,
    });
    assert.deepEqual(launch, { kind: DataLaunchKind.Default, dir: defaultDir, fellBack: true });
  });

  it("app_ready_measured carries the start's facts; forged ones read as none", () => {
    const state = { status: SessionStatus.Ready, welcoming: false, firstLaunch: false, games: 0, enginesReady: 0 };
    const start = {
      passed: [StartPassage.SandboxSetup, StartPassage.FailureRetried],
      failure: SandboxProblemCode.NotProvisioned,
      retries: 2,
    };
    const ready = launchEvents.appReadyProperties(state, 900, 400, start);
    assert.deepEqual(
      [ready.start_passed, ready.start_failure, ready.start_retries],
      [[StartPassage.SandboxSetup, StartPassage.FailureRetried], SandboxProblemCode.NotProvisioned, CountBucket.Few],
    );
    assert.equal(
      launchEvents.appReadyProperties(state, 900, 400).start_passed,
      undefined,
      "a reload has no start to tell",
    );
    const forged = launchEvents.appReadyProperties(state, 900, 400, {
      passed: [HOSTILE[0], StartPassage.DataMoved, HOSTILE_THREAD, StartPassage.DataMoved],
      failure: HOSTILE[3],
      retries: 1e308,
    } as unknown as StartFacts);
    assert.deepEqual(
      [forged.start_passed, forged.start_failure, forged.start_retries],
      [[StartPassage.DataMoved], null, CountBucket.Many],
    );
    assertClean("app_ready_measured", forged);
    const words = launchEvents.appReadyProperties(state, 900, 400, HOSTILE[1] as unknown as StartFacts);
    assertClean("app_ready_measured", words);
  });

  it("agents that would not start say why with a code, never the words", async () => {
    const sent = await recorder();
    const session = createStore<Record<string, unknown>>(() => ({ status: SessionStatus.Ready, launch: null }));
    const heard = launchHeard(session);
    heard.ui({
      type: UiEvent.HarnessStartFailed,
      payload: { failure: HOSTILE[4], failureCode: SandboxProblemCode.IsolationBlocked },
    });
    heard.ui({ type: UiEvent.HarnessStartFailed, payload: { failure: HOSTILE[4], failureCode: HOSTILE[0] } });
    heard.ui({ type: UiEvent.HarnessStartFailed, payload: { failure: HOSTILE[6] } });
    heard.stop();
    const failed = sentOf(sent, AnalyticsEvent.AgentsStartFailed);
    assert.deepEqual(failed, [{ code: SandboxProblemCode.IsolationBlocked }, { code: null }, { code: null }]);
    for (const properties of failed) assertClean("agents_start_failed", properties);
  });
});

describe("P10b: main's own errors and a window that stopped answering", () => {
  it("main tells only an error's kind and type, a few times a launch, and a hang's length", async () => {
    const { createAppDiagnostics, MAIN_FAULT_EVENTS_MAX } = await appDiagnostics();
    const target = new EventEmitter();
    const faults: string[] = [];
    installProcessHandlers(
      target,
      () => undefined,
      (kind) => faults.push(kind),
    );
    target.emit("uncaughtException", new TypeError(HOSTILE[4]));
    target.emit("unhandledRejection", HOSTILE[0]);
    assert.deepEqual(faults, [MainDiagnostic.Uncaught, MainDiagnostic.Rejection]);
    const throwing = new EventEmitter();
    installProcessHandlers(
      throwing,
      () => undefined,
      () => {
        throw new Error("not yet");
      },
    );
    assert.doesNotThrow(() => throwing.emit("uncaughtException", new Error("x")), "a failing report keeps main up");

    const pushed: unknown[] = [];
    const counted: string[] = [];
    const clock = handClock();
    const diagnostics = createAppDiagnostics({
      push: (payload) => pushed.push(payload),
      marker: { mainError: () => counted.push("error"), hung: () => counted.push("hang") },
      now: clock.now,
    });
    const error = new RangeError(HOSTILE[4]);
    for (let i = 0; i < MAIN_FAULT_EVENTS_MAX + 5; i++) diagnostics.fault(MainDiagnostic.Uncaught, error);
    diagnostics.fault(MainDiagnostic.Rejection, HOSTILE[0]);
    assert.equal(pushed.length, MAIN_FAULT_EVENTS_MAX, "a loop that throws is one problem");
    assert.deepEqual(pushed[0], { kind: MainDiagnostic.Uncaught, errorType: "RangeError" });
    assert.equal(counted.length, MAIN_FAULT_EVENTS_MAX + 6, "the session counts every one");
    pushed.length = 0;
    const hang = diagnostics.hangWatch();
    hang.responsive();
    hang.unresponsive();
    hang.unresponsive();
    clock.advance(4200);
    hang.responsive();
    hang.responsive();
    assert.deepEqual(pushed, [{ kind: MainDiagnostic.Unresponsive, durationMs: 4200 }]);
    assert.deepEqual(counted.slice(-1), ["hang"]);
    assert.doesNotMatch(JSON.stringify(pushed), /alice|Users|limit/);
  });

  it("the renderer sends them as app_error_caught (main) and window_unresponsive, never words", async () => {
    const sent = await recorder();
    const session = createStore<Record<string, unknown>>(() => ({ status: SessionStatus.Ready, launch: null }));
    const heard = launchHeard(session);
    heard.ui({ type: UiEvent.AppDiagnostic, payload: { kind: MainDiagnostic.Rejection, errorType: "TypeError" } });
    heard.ui({ type: UiEvent.AppDiagnostic, payload: { kind: MainDiagnostic.Uncaught, errorType: HOSTILE[0] } });
    heard.ui({ type: UiEvent.AppDiagnostic, payload: { kind: MainDiagnostic.Unresponsive, durationMs: 4200.4 } });
    for (const durationMs of [-1, 1e308, "5", HOSTILE[5]])
      heard.ui({ type: UiEvent.AppDiagnostic, payload: { kind: MainDiagnostic.Unresponsive, durationMs } });
    for (const kind of [HOSTILE[0], "render", null])
      heard.ui({ type: UiEvent.AppDiagnostic, payload: { kind, errorType: "TypeError" } });
    heard.stop();
    const errors = sentOf(sent, AnalyticsEvent.AppErrorCaught);
    assert.deepEqual(errors, [
      { process: "main", kind: "rejection", error_type: "TypeError", fatal: false, fingerprint: null },
      { process: "main", kind: "uncaught", error_type: "other", fatal: false, fingerprint: null },
    ]);
    const hangs = sentOf(sent, AnalyticsEvent.WindowUnresponsive);
    assert.deepEqual(hangs, [
      { duration_ms: 4200 },
      { duration_ms: null },
      { duration_ms: null },
      { duration_ms: null },
      { duration_ms: null },
    ]);
    for (const properties of [...errors, ...hangs]) assertClean("main diagnostics", properties);
  });
});
