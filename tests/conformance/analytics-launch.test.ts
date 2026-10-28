/**
 * Usage analytics for a launch: an error is told by kind, built-in type and a fingerprint of where
 * it was thrown (never its message or the folders it ran from), long tasks are summed, the
 * bootstrap's first answer and its Retries are timed from the clock given, and an update is
 * followed from ready to Relaunch.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PostHog } from "posthog-js";
import { createStore } from "zustand/vanilla";
import { RestartAnswer, UpdateAction, UpdateCheckStatus } from "../../src/shared/app-update.ts";
import { UiEvent } from "../../src/shared/ui-events.ts";
import { startAnalytics } from "../../src/renderer/analytics/client.ts";
import { AnalyticsEvent } from "../../src/renderer/analytics/events.ts";
import {
  appErrorProperties,
  appReadyProperties,
  type BootstrapWatch,
  bootstrapStep,
  CHECK_CALL_FAILED,
  createLaunchObservers,
  ErrorKind,
  errorType,
  fingerprint,
  NO_STALLS,
  reportError,
  reportFirstScreen,
  RestartOutcome,
  stackFrames,
  stallAdded,
  stallSummary,
  trackedRestart,
  updateCheckProperties,
  UpdateSurface,
} from "../../src/renderer/analytics/events/launch.ts";
import { CountBucket } from "../../src/renderer/analytics/properties.ts";
import { SessionStatus } from "../../src/renderer/state/session.ts";
import type { Studio } from "../../src/renderer/state/studio.ts";
import { createToastsStore } from "../../src/renderer/state/toasts.ts";

/** A V8 stack as the renderer throws it, from an app installed in `home`. */
const stack = (home: string, message: string): string =>
  [
    `TypeError: ${message}`,
    `    at readGame (file://${home}/Applications/Genex.app/Contents/Resources/app.asar/dist/renderer/index.js:120:33)`,
    `    at file://${home}/Applications/Genex.app/Contents/Resources/app.asar/dist/renderer/index.js:88:7`,
    "    at async Promise.all (index 0)",
    `    at load (file://${home}/Applications/Genex.app/Contents/Resources/app.asar/dist/renderer/chunk-ab12.js?v=3:4:1)`,
    `    at C:\\Users\\bob\\AppData\\Local\\Genex\\renderer\\index.js:9:9`,
    "    at sixth (index.js:1:1)",
  ].join("\n");

const SECRET_MESSAGE = "Cannot read /Users/alice/Games/Alice's Dungeon/game.json";

/** One recorder in place of PostHog's for the file: every event captured. */
const captured: Array<{ event: string; properties: Record<string, unknown> }> = [];
const posthog = {
  init: () => undefined,
  has_opted_out_capturing: () => false,
  opt_in_capturing: () => undefined,
  register: () => undefined,
  stopSessionRecording: () => undefined,
  capture: (event: string, properties: Record<string, unknown>) => captured.push({ event, properties }),
} as unknown as PostHog;
async function recorder(): Promise<typeof captured> {
  await startAnalytics({ key: "phc_test", host: "https://eu.i.posthog.com" }, { replay: false }, async () => ({
    posthog,
  }));
  captured.length = 0;
  return captured;
}

describe("errors", () => {
  it("names only JavaScript's own error types", () => {
    assert.equal(errorType(new TypeError("x")), "TypeError");
    assert.equal(errorType(new RangeError("x")), "RangeError");
    assert.equal(errorType({ name: "AbortError" }), "AbortError");
    class SecretThing extends Error {
      override name = "AliceDungeonError";
    }
    assert.equal(errorType(new SecretThing()), "other");
    assert.equal(errorType("a string"), "other");
    assert.equal(errorType(null), "other");
  });

  it("keeps the top five frames' file names and positions, never the message or the folders", () => {
    const frames = stackFrames(stack("/Users/alice", SECRET_MESSAGE));
    assert.deepEqual(frames, [
      "at readGame (index.js:120:33)",
      "at index.js:88:7",
      "at async Promise.all (index 0)",
      "at load (chunk-ab12.js:4:1)",
      "at index.js:9:9",
    ]);
    assert.doesNotMatch(frames.join("\n"), /alice|bob|Users|file:|Dungeon/);
  });

  it("fingerprints where an error was thrown the same for everyone, and apart from elsewhere", () => {
    const alice = fingerprint(stackFrames(stack("/Users/alice", "one")));
    const bob = fingerprint(stackFrames(stack("/Users/bob", "two")));
    assert.match(alice ?? "", /^[0-9a-f]{8}$/);
    assert.equal(alice, bob, "the same code in another home folder, with other words");
    assert.notEqual(alice, fingerprint(stackFrames(stack("/Users/alice", "one").replace(":120:33", ":121:33"))));
    assert.equal(fingerprint([]), null);
  });

  it("sends kind, type and fingerprint, and a render error as fatal", () => {
    const error = new TypeError(SECRET_MESSAGE);
    error.stack = stack("/Users/alice", SECRET_MESSAGE);
    const properties = appErrorProperties(error, ErrorKind.Render);
    assert.equal(properties.process, "renderer");
    assert.equal(properties.kind, "render");
    assert.equal(properties.error_type, "TypeError");
    assert.equal(properties.fatal, true);
    assert.match(properties.fingerprint ?? "", /^[0-9a-f]{8}$/);
    assert.equal(appErrorProperties(SECRET_MESSAGE, ErrorKind.Rejection).fingerprint, null);
    assert.equal(appErrorProperties(SECRET_MESSAGE, ErrorKind.Rejection).fatal, false);
    assert.doesNotMatch(JSON.stringify(properties), /alice|Users|Dungeon|Cannot/);
  });

  it("sends one error a few times a launch, however often it is thrown", async () => {
    const sent = await recorder();
    const error = new Error(SECRET_MESSAGE);
    error.stack = stack("/Users/alice", SECRET_MESSAGE);
    for (let i = 0; i < 10; i += 1) reportError(error, ErrorKind.Uncaught);
    reportError(error, ErrorKind.Rejection);
    assert.deepEqual(
      sent.map((s) => s.properties.kind),
      ["uncaught", "uncaught", "uncaught", "rejection"],
    );
    assert.ok(sent.every((s) => s.event === AnalyticsEvent.AppErrorCaught));
    assert.doesNotMatch(JSON.stringify(sent), /alice|Users|Dungeon|Cannot/);
  });
});

describe("long tasks", () => {
  it("sums them and sends nothing when nothing was slow", () => {
    assert.equal(stallSummary(NO_STALLS, "/home"), null);
    const tally = [120.4, 610.6, 55].reduce(stallAdded, NO_STALLS);
    assert.deepEqual(stallSummary(tally, "/game/live"), {
      screen: "/game/live",
      long_tasks: 3,
      total_ms: 786,
      max_ms: 611,
    });
  });
});

describe("the launch's measures", () => {
  const watch = (status: SessionStatus): BootstrapWatch => ({
    status,
    startedAt: 1_000,
    answered: false,
    attempts: 0,
    retryingSince: null,
  });

  it("times the bootstrap's first answer once", () => {
    const answered = bootstrapStep(watch(SessionStatus.Loading), SessionStatus.Ready, 3_500);
    assert.equal(answered.answeredMs, 2_500);
    assert.equal(answered.retried, null);
    const later = bootstrapStep(answered.watch, SessionStatus.Loading, 9_000);
    assert.equal(bootstrapStep(later.watch, SessionStatus.Ready, 9_500).answeredMs, null);
  });

  it("times each Retry after a failure, by its number in the launch", () => {
    const failed = bootstrapStep(watch(SessionStatus.Loading), SessionStatus.Failed, 2_000);
    assert.equal(failed.answeredMs, 1_000);
    const retrying = bootstrapStep(failed.watch, SessionStatus.Loading, 5_000);
    const again = bootstrapStep(retrying.watch, SessionStatus.Failed, 6_000);
    assert.deepEqual(again.retried, { attempt: 1, succeeded: false, elapsed_ms: 1_000 });
    const second = bootstrapStep(again.watch, SessionStatus.Loading, 7_000);
    const ok = bootstrapStep(second.watch, SessionStatus.Ready, 7_250);
    assert.deepEqual(ok.retried, { attempt: 2, succeeded: true, elapsed_ms: 250 });
  });

  it("measures the first screen from what the stores hold", () => {
    const state = { status: SessionStatus.Ready, welcoming: true, firstLaunch: false, games: 4, enginesReady: 2 };
    assert.deepEqual(appReadyProperties(state, 1834.6, 900), {
      window_to_first_screen_ms: 1835,
      bootstrap_ms: 900,
      bootstrap_failed: false,
      first_launch: true,
      games_bucket: CountBucket.Few,
      engines_ready_count: 2,
    });
  });

  it("sends the first screen once a launch", async () => {
    const sent = await recorder();
    const app = {
      session: createStore(() => ({ status: SessionStatus.Ready, welcoming: false, firstLaunch: false })),
      library: createStore(() => ({ games: [{}, {}] })),
      engines: createStore(() => ({ list: [{ status: { code: "ready" } }, { status: { code: "needs_login" } }] })),
    } as unknown as Studio;
    reportFirstScreen(app, 1_200);
    reportFirstScreen(app, 5_000);
    assert.deepEqual(
      sent.map((s) => [s.event, s.properties.window_to_first_screen_ms, s.properties.engines_ready_count]),
      [[AnalyticsEvent.AppReadyMeasured, 1_200, 1]],
    );
  });
});

describe("updates", () => {
  it("reads a check's status, or that the call failed", () => {
    assert.deepEqual(updateCheckProperties({ status: UpdateCheckStatus.Current }, 812.2), {
      status: "current",
      duration_ms: 812,
    });
    assert.equal(updateCheckProperties(null, 5).status, CHECK_CALL_FAILED);
  });

  it("follows an update from ready, announced or found at the bootstrap, to Relaunch", async () => {
    const sent = await recorder();
    let now = 10_000;
    const clock = () => now;
    const later: Array<() => void> = [];
    const observers = createLaunchObservers(clock, (run) => later.push(run));
    const update = createStore<{ ready: { version: string | null; action: UpdateAction } | null }>(() => ({
      ready: null,
    }));
    const session = createStore(() => ({ status: SessionStatus.Ready }));
    const toasts = createToastsStore(() => undefined);
    const stop = observers.start?.({ update, session, toasts } as unknown as Studio);

    // Found by the bootstrap: the store moves, and nothing announces it.
    update.setState({ ready: { version: "0.2.0", action: UpdateAction.Restart } });
    for (const run of later.splice(0)) run();
    // Announced by main: the store moves first, then the event is heard.
    const announced = { version: "0.3.0", action: UpdateAction.Download };
    update.setState({ ready: announced });
    observers.ui?.({ type: UiEvent.UpdateReady, payload: announced });
    for (const run of later.splice(0)) run();
    stop?.();

    now = 70_000;
    assert.equal(await trackedRestart(UpdateSurface.About, async () => RestartAnswer.Declined, clock), false);
    await assert.rejects(trackedRestart(UpdateSurface.Sidebar, async () => Promise.reject(new Error("x")), clock));
    assert.deepEqual(
      sent.map((s) => [s.event, s.properties]),
      [
        [AnalyticsEvent.UpdateReady, { action: "restart", at_bootstrap: true }],
        [AnalyticsEvent.UpdateReady, { action: "download", at_bootstrap: false }],
        [
          AnalyticsEvent.UpdateRestartPressed,
          { surface: "about", outcome: RestartOutcome.Declined, waited_ms: 60_000 },
        ],
        [
          AnalyticsEvent.UpdateRestartPressed,
          { surface: "sidebar", outcome: RestartOutcome.Failed, waited_ms: 60_000 },
        ],
      ],
    );
  });
});
