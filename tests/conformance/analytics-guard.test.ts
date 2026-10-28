/**
 * Usage analytics never stands in the app's way: `track` and the super properties never throw, an
 * area that fails to be made, to start or to hear a record leaves the other areas listening, and an
 * area's store listener that throws neither breaks the store's `setState` nor keeps the store's
 * later listeners (the app's own, which subscribe after analytics) from hearing the change.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PostHog } from "posthog-js";
import { createStore, type StoreApi } from "zustand/vanilla";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import { type EventEnvelope, EventKind } from "../../src/shared/event-log.ts";
import { UiEvent } from "../../src/shared/ui-events.ts";
import { guarded, registerSuperProperties, startAnalytics, track } from "../../src/renderer/analytics/client.ts";
import { AnalyticsEvent } from "../../src/renderer/analytics/events.ts";
import { createBuildsObservers } from "../../src/renderer/analytics/events/builds.ts";
import { createLaunchObservers } from "../../src/renderer/analytics/events/launch.ts";
import { createPluginsObservers } from "../../src/renderer/analytics/events/plugins.ts";
import { createWorkspaceObservers } from "../../src/renderer/analytics/events/workspace.ts";
import { createChatMemory } from "../../src/renderer/analytics/chat-memory.ts";
import { createChatObservers } from "../../src/renderer/analytics/chat-observe.ts";
import { type AreaObservers, startObservers } from "../../src/renderer/analytics/observers.ts";
import type { Studio } from "../../src/renderer/state/studio.ts";
import { createToastsStore } from "../../src/renderer/state/toasts.ts";

const BROKEN = { needs_install: false, showing_last_build: false, skipped_scripts: false, killed: false };

/** A log record made at `at`, after the observers' mark of 0. */
const record = (at: number): EventEnvelope => ({
  id: `ev-${at}`,
  thread_id: "t",
  session_id: null,
  turn_id: null,
  created_at: new Date(at).toISOString(),
  data: { type: EventKind.Custom, event_type: CustomEvent.PluginSuggested, payload: {} },
});

/** An app with the log feed and main's events only, each handing its listener to the test. */
function feeds() {
  const heard: { log: ((events: readonly EventEnvelope[]) => void) | null; ui: ((event: never) => void) | null } = {
    log: null,
    ui: null,
  };
  const app = {
    eventLog: {
      onArrived: (listener: (events: readonly EventEnvelope[]) => void) => {
        heard.log = listener;
        return () => undefined;
      },
    },
    onUiEvent: (listener: (event: never) => void) => {
      heard.ui = listener;
      return () => undefined;
    },
  } as unknown as Studio;
  return { app, heard };
}

const fail = (what: string) => (): never => {
  throw new Error(what);
};

/** A real area over stores of the test's, and the store move its listener fails on. */
interface FailingListener {
  name: string;
  area: AreaObservers;
  app: Record<string, unknown>;
  move: () => void;
}

/** One case per area that subscribes to a store: the state each moves to is one its listener throws on. */
function failingListeners(): FailingListener[] {
  const library = createStore<Record<string, unknown>>(() => ({ games: [], assets: {} }));
  const layout = createStore<Record<string, unknown>>(() => ({ stageView: "live" }));
  const engines = createStore<Record<string, unknown>>(() => ({ list: [] }));
  const update = createStore<Record<string, unknown>>(() => ({ ready: null }));
  const plugins = createStore<Record<string, unknown>>(() => ({ list: [], index: null }));
  const empty = () => createStore(() => ({ list: [] }));
  return [
    {
      name: "builds' library",
      area: createBuildsObservers(() => 0),
      app: { library, plugins: empty() },
      move: () => library.setState({ games: null }),
    },
    {
      name: "workspace's stage (no threads store to read)",
      area: createWorkspaceObservers(() => 0),
      app: {
        layout,
        launch: createStore(() => ({ launch: null })),
        toasts: createStore(() => ({ lastId: 0, items: [] })),
      },
      move: () => layout.setState({ stageView: "builds" }),
    },
    {
      name: "chat's engines",
      area: createChatObservers({ memory: createChatMemory(), now: () => 0, send: () => undefined }),
      app: { engines, plugins: empty(), threads: createStore(() => ({ activeThreadId: null })) },
      move: () => engines.setState({ list: null }),
    },
    {
      name: "plugins' index (a read with no entries)",
      area: createPluginsObservers(() => 0),
      app: { plugins, play: createStore(() => ({})) },
      move: () => plugins.setState({ index: { stale: false } }),
    },
    {
      name: "launch's update (its moment later fails)",
      area: createLaunchObservers(() => 0, fail("later")),
      app: { update, session: createStore(() => ({ status: "loading" })), toasts: createToastsStore(() => undefined) },
      move: () => update.setState({ ready: { action: "restart", version: "9.9.9" } }),
    },
  ];
}

describe("analytics never stands in the app's way", () => {
  it("track and the super properties never throw, before or after the recorder is up, even when PostHog does", async () => {
    let broken = false;
    const posthog = {
      init: () => undefined,
      has_opted_out_capturing: () => false,
      opt_in_capturing: () => undefined,
      register: () => {
        if (broken) throw new Error("register");
      },
      stopSessionRecording: () => undefined,
      capture: () => {
        if (broken) throw new Error("capture");
      },
    } as unknown as PostHog;
    assert.doesNotThrow(() => track(AnalyticsEvent.GameBuildFailed, BROKEN));
    await startAnalytics({ key: "phc_test", host: "https://eu.i.posthog.com" }, { replay: false }, async () => ({
      posthog,
    }));
    broken = true;
    assert.doesNotThrow(() => track(AnalyticsEvent.GameBuildFailed, BROKEN));
    assert.doesNotThrow(() => registerSuperProperties({ locale: "en" }));
    const listener = guarded((value: number) => {
      if (value > 0) throw new Error("listener");
    });
    assert.doesNotThrow(() => listener(1));
  });

  it("keeps every other area listening when one fails to be made, to start, or to hear", () => {
    const { app, heard } = feeds();
    const healthy = { log: 0, ui: 0, started: 0, stopped: 0 };
    const parts: Array<() => AreaObservers> = [
      fail("made"),
      () => ({ start: fail("start") }),
      () => ({ log: fail("log"), ui: fail("ui"), start: () => fail("stop") }),
      () => ({
        log: () => void healthy.log++,
        ui: () => void healthy.ui++,
        start: () => {
          healthy.started++;
          return () => void healthy.stopped++;
        },
      }),
    ];
    const stop = startObservers(app, null, 0, parts);
    assert.doesNotThrow(() => heard.log?.([record(1000), record(2000)]));
    assert.doesNotThrow(() => heard.ui?.({ type: UiEvent.PluginsChanged } as never));
    assert.doesNotThrow(stop);
    assert.deepEqual(healthy, { log: 2, ui: 1, started: 1, stopped: 1 });
  });

  it("lets a store's later listeners hear a change an area's listener failed on, and setState return", () => {
    for (const { name, area, app, move } of failingListeners()) {
      const stop = area.start?.(app as unknown as Studio) ?? (() => undefined);
      const stores = Object.values(app) as Array<Pick<StoreApi<unknown>, "subscribe">>;
      let heard = 0;
      const offs = stores.map((store) => store.subscribe(() => void heard++));
      assert.doesNotThrow(move, name);
      assert.equal(heard, 1, `${name}: the app's own listener heard the change`);
      for (const off of offs) off();
      stop();
    }
  });
});
