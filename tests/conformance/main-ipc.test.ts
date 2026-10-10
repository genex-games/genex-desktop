/**
 * Main-process behaviour that used to be pinned by reading `main/index.ts` as text: the keep-awake
 * hold through a run's settlement, the run stop and start handlers, and the subscription sign-in
 * wiring. The registrars in `src/main/ipc/` take their dependencies explicitly, so each is driven
 * here through the real typed `handle()` with recorders in place of Electron and the core.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createIpcHandle, type IpcResult, type IpcSender } from "../../src/main/ipc-handle.ts";
import { KEEP_AWAKE_FALLBACK_MS, KeepAwake, type FallbackTimers } from "../../src/main/keep-awake.ts";
import { registerRunsIpc, extFromMime, safeLabel, type RunsIpcDeps } from "../../src/main/ipc/runs.ts";
import { registerLoginIpc, type LoginIpcDeps } from "../../src/main/ipc/login.ts";
import { badgeText, registerNotificationsIpc } from "../../src/main/ipc/notifications.ts";
import { registerModelsIpc, type ModelsIpcDeps } from "../../src/main/ipc/models.ts";
import { registerUpdateIpc } from "../../src/main/ipc/update.ts";
import { createLoginControllers, type SubscriptionEngine } from "../../src/main/login-controllers.ts";
import type { ClaudeLoginState } from "../../src/shared/claude-login.ts";
import type { CodexLoginState } from "../../src/shared/codex-login.ts";
import type { UiEvent } from "../../src/shared/ui-events.ts";
import { UpdateAction, UpdateCheckStatus } from "../../src/shared/app-update.ts";
import type { EventEnvelope } from "../../src/shared/event-log.ts";

type Listener = (event: IpcSender, payload: unknown) => Promise<IpcResult>;
const studio = { sender: "studio", senderFrame: "main-frame" };

function registrar() {
  const listeners = new Map<string, Listener>();
  const handle = createIpcHandle(
    {
      handle: (channel, listener) => {
        listeners.set(channel, listener);
      },
    },
    { fixture: false, isStudioUi: () => true },
  );
  const invoke = (channel: string, payload?: unknown) => {
    const listener = listeners.get(channel);
    assert.ok(listener, `${channel} is not registered`);
    return listener(studio, payload);
  };
  return { handle, invoke };
}

/** A power-save blocker and a fallback timer that only fire when told to. */
function blockerAndTimers() {
  const log: string[] = [];
  let next = 1;
  const pending = new Map<object, () => void>();
  const blocker = {
    start: (type: string) => {
      const id = next++;
      log.push(`start ${type} ${id}`);
      return id;
    },
    stop: (id: number) => {
      log.push(`stop ${id}`);
    },
  };
  const timers: FallbackTimers & { fire(): void; armed(): number; delays: number[]; unrefs: number } = {
    delays: [],
    unrefs: 0,
    setTimeout(callback, ms) {
      timers.delays.push(ms);
      const handle = {
        unref: () => {
          timers.unrefs++;
        },
      };
      pending.set(handle, callback);
      return handle;
    },
    clearTimeout(handle) {
      pending.delete(handle);
    },
    fire() {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const callback of callbacks) callback();
    },
    armed: () => pending.size,
  };
  return { blocker, timers, log };
}

describe("the Mac stays awake until the run actually settles", () => {
  it("a run holds the blocker once, and run.settled or run.failed is what releases it", () => {
    const { blocker, timers, log } = blockerAndTimers();
    const keep = new KeepAwake(blocker, timers);
    keep.observe({ type: "run.keepawake", payload: { runId: "r1" } });
    keep.hold();
    keep.observe({ type: "run.keepawake", payload: { runId: "r1" } });
    assert.equal(keep.held, true);
    keep.observe({ type: "run.finished", payload: { runId: "r1" } });
    assert.equal(keep.held, true, "a finished run still has its post-run pass to settle");
    keep.observe({ type: "run.settled", payload: { runId: "r1" } });
    assert.equal(keep.held, false);
    keep.hold();
    keep.observe({ type: "run.failed", payload: { runId: "r2", error: "boom" } });
    assert.equal(keep.held, false);
    assert.deepEqual(log, ["start prevent-app-suspension 1", "stop 1", "start prevent-app-suspension 2", "stop 2"]);
  });

  it("a harness that never reports back cannot leak the blocker: the stop fallback releases it after five minutes", () => {
    const { blocker, timers, log } = blockerAndTimers();
    const keep = new KeepAwake(blocker, timers);
    keep.armFallback();
    assert.equal(timers.armed(), 0, "nothing held, nothing to arm");
    keep.hold();
    keep.armFallback();
    keep.armFallback();
    assert.equal(timers.armed(), 1, "armed once");
    assert.deepEqual(timers.delays, [KEEP_AWAKE_FALLBACK_MS]);
    assert.equal(KEEP_AWAKE_FALLBACK_MS, 5 * 60_000);
    assert.equal(timers.unrefs, 1, "the fallback must not hold the app open");
    timers.fire();
    assert.equal(keep.held, false);
    assert.deepEqual(log, ["start prevent-app-suspension 1", "stop 1"]);
  });

  it("a fresh run is not stopped by the last one's fallback, and a release disarms it", () => {
    const { blocker, timers } = blockerAndTimers();
    const keep = new KeepAwake(blocker, timers);
    keep.hold();
    keep.armFallback();
    keep.observe({ type: "run.keepawake", payload: { runId: "next" } });
    assert.equal(timers.armed(), 0);
    keep.armFallback();
    keep.release();
    assert.equal(timers.armed(), 0);
    timers.fire();
    assert.equal(keep.held, false);
  });
});

function runsFixture(
  dispatch: (action: unknown, timeoutMs?: number) => Promise<unknown>,
  history: EventEnvelope[] = [],
) {
  const calls: string[] = [];
  const { blocker, timers } = blockerAndTimers();
  const keepAwake = new KeepAwake(blocker, timers);
  const events: UiEvent[] = [];
  const core = {
    host: {
      dispatch: async (action: unknown, timeoutMs?: number) => {
        calls.push(`dispatch ${JSON.stringify(action)} ${timeoutMs}`);
        return dispatch(action, timeoutMs);
      },
    },
    // The core's own stop keeps the user's word for host auto-resume, then dispatches.
    stopRun: async (runId: string, timeoutMs?: number) => {
      calls.push(`stopRun ${runId} ${timeoutMs}`);
      await dispatch({ type: "run_stop", runId }, timeoutMs);
    },
    newRunId: () => "run_1",
    saveRunArtifact: async (_runId: string, name: string) => {
      calls.push(`save ${name}`);
      return `/runs/${name}`;
    },
    dispatchRun: async (run: { runId: string; reference: { shots: string[] } }) => {
      calls.push(`run ${run.runId} ${run.reference.shots.join(",")}`);
    },
    mainThread: "studio",
    layout: { runs: "/nowhere/runs" },
    runPreviewIdentity: () => null,
  } as unknown as RunsIpcDeps["core"];
  const { handle, invoke } = registrar();
  registerRunsIpc(handle, {
    core,
    keepAwake,
    runSummaryReader: { forProject: async () => history },
    pushUiEvent: (event) => events.push(event),
    appendErrorDurably: async () => {},
  });
  return { invoke, keepAwake, timers, calls, events };
}

describe("the run controls", () => {
  it("a stop request goes through the core and does not release the blocker: it arms the fallback, with the dispatch bounded to 30 s", async () => {
    const { invoke, keepAwake, timers, calls } = runsFixture(async () => true);
    keepAwake.hold();
    assert.deepEqual(await invoke("studio:run.stop", { runId: "run_1" }), { ok: true, value: true });
    assert.equal(keepAwake.held, true, "the close pass runs after the request");
    assert.equal(timers.armed(), 1);
    assert.deepEqual(calls, ["stopRun run_1 30000"], "the stop goes through the core, which keeps the user's word");
  });

  it("the fallback is armed however the dispatch ends — a wedged harness is exactly the case it exists for", async () => {
    const { invoke, keepAwake, timers } = runsFixture(async () => {
      throw new Error("harness gone");
    });
    keepAwake.hold();
    assert.deepEqual(await invoke("studio:run.stop", { runId: "run_1" }), { ok: false, error: "harness gone" });
    assert.equal(timers.armed(), 1);
  });

  it("starting a run holds the Mac awake and saves the reference frames before dispatching", async () => {
    const { invoke, keepAwake, calls } = runsFixture(async () => true);
    const frames = [
      { data: "aGk=", mimeType: "image/png", label: "Title Screen!" },
      { data: "aGk=", mimeType: "image/webp" },
    ];
    const result = await invoke("studio:run.start", {
      goal: "g",
      project: "pong",
      hours: 1,
      reference: { name: "ref", kind: "reference", frames },
    });
    assert.deepEqual(result, { ok: true, value: { runId: "run_1" } });
    assert.equal(keepAwake.held, true);
    assert.deepEqual(calls, [
      "save reference/01-title-screen.png",
      "save reference/02-frame-2.webp",
      "run run_1 /runs/reference/01-title-screen.png,/runs/reference/02-frame-2.webp",
    ]);
    assert.deepEqual(
      await invoke("studio:run.start", {
        goal: "g",
        project: "pong",
        hours: 1,
        reference: { name: "ref", kind: "reference", frames: frames.slice(0, 1) },
      }),
      { ok: false, error: 'A "beat a real game" run needs at least two screenshots of the reference.' },
    );
  });

  it("a live summary sends only the graph events after the ones the renderer holds", async () => {
    const graph = ["e1", "e2", "e3"].map((id) => ({
      id,
      thread_id: "t",
      turn_id: null,
      session_id: null,
      created_at: id,
      data: { type: "custom", event_type: "director_worker", payload: { runId: "run_1", project: "pong" } },
    })) as EventEnvelope[];
    const { invoke } = runsFixture(async () => true, graph);
    const read = async (graphFrom?: unknown) => {
      const reply = await invoke("studio:run.summary", { project: "pong", runId: "run_1", graphFrom });
      assert.ok(reply.ok);
      const summary = reply.value as { graphEvents?: EventEnvelope[]; graphEventsFrom?: number };
      return [summary.graphEventsFrom, (summary.graphEvents ?? []).map((event) => event.id)];
    };
    assert.deepEqual(await read(), [0, ["e1", "e2", "e3"]]);
    // The held last event comes again, with the compaction tail it has now.
    assert.deepEqual(await read({ count: 2, lastId: "e2" }), [1, ["e2", "e3"]]);
    assert.deepEqual(await read({ count: 3, lastId: "e3" }), [2, ["e3"]]);
    // A cursor that no longer matches, or one the renderer made up, gets everything again.
    for (const cursor of [{ count: 2, lastId: "e9" }, { count: 9, lastId: "e3" }, { count: "2", lastId: "e2" }, "e2"])
      assert.deepEqual(await read(cursor), [0, ["e1", "e2", "e3"]], JSON.stringify(cursor));
  });

  it("frame names are safe file names", () => {
    assert.equal(extFromMime("image/png"), "png");
    assert.equal(extFromMime("image/gif"), "gif");
    assert.equal(extFromMime("image/jpeg"), "jpg");
    assert.equal(safeLabel("  ../Boss: Phase 2  "), "boss-phase-2");
    assert.equal(safeLabel(undefined), "");
    assert.equal(safeLabel("x".repeat(60)).length, 40);
  });
});

const claudeIdle: ClaudeLoginState = { revision: 0, phase: "idle", hasBrowserUrl: false };
const codexIdle: CodexLoginState = {
  revision: 0,
  visible: false,
  phase: "idle",
  method: "browser",
  lines: [],
  hasBrowserUrl: false,
};

function loginFixture(logins: Record<string, Awaited<ReturnType<SubscriptionEngine["resolveLogin"]>>>, busy = false) {
  const started: string[] = [];
  const engines = new Map<string, SubscriptionEngine>(
    ["claude-code", "codex"].map((id) => [
      id,
      {
        engineHome: `/homes/${id}`,
        resolveLogin: async () => logins[id] ?? { source: "none", home: null },
        recheckLogin: async () => {
          started.push(`recheck ${id}`);
        },
      },
    ]),
  );
  const deps: LoginIpcDeps = {
    openCodeLogin: {
      start: async () => {
        started.push("opencode");
        return { started: true };
      },
    },
    claudeLogin: {
      start: async (home: string | null) => {
        started.push(`claude ${home}`);
        return { started: true };
      },
      snapshot: () => claudeIdle,
      submitCode: async () => claudeIdle,
      openBrowser: async () => {},
      cancel: async () => {},
    },
    codexLogin: {
      start: async (home: string, method?: string) => {
        started.push(`codex ${home} ${method ?? "browser"}`);
        return { ...codexIdle, phase: "waiting" };
      },
      snapshot: () => codexIdle,
      cancel: async () => {
        started.push("codex cancel");
      },
      dismiss: async () => {},
      openBrowser: async () => {},
    },
    subscription: (id) => engines.get(id) ?? null,
    busy: () => busy,
    pushUiEvent: () => {},
  };
  const { handle, invoke } = registrar();
  registerLoginIpc(handle, deps);
  return { invoke, started };
}

describe("both sign-in paths go through the controllers", () => {
  it("Claude signs in to the studio's own home, the env home, or the Mac-wide login, as the engine resolves it", async () => {
    for (const [login, expected] of [
      [{ source: "isolated", home: "/homes/claude-code" }, "claude /homes/claude-code"],
      [{ source: "env", home: "/custom" }, "claude /custom"],
      [{ source: "system", home: null }, "claude null"],
    ] as const) {
      const { invoke, started } = loginFixture({ "claude-code": login });
      assert.deepEqual(await invoke("studio:subscription.signin", {}), { ok: true, value: { started: true } });
      assert.deepEqual(started, [expected]);
    }
    const { invoke, started } = loginFixture({ "claude-code": { source: "system", home: null } });
    await invoke("studio:subscription.signin", { engine: "claude-code", separate: true });
    assert.deepEqual(
      started,
      ["claude /homes/claude-code"],
      "a separate account always signs in to the studio's own home",
    );
  });

  it("Codex signs in through its controller, and never while a run or a turn is in flight", async () => {
    const { invoke, started } = loginFixture({});
    assert.deepEqual(await invoke("studio:subscription.signin", { engine: "codex" }), {
      ok: true,
      value: { started: true, error: undefined },
    });
    await invoke("studio:codex-login.retry", { method: "device" });
    assert.deepEqual(started, ["codex /homes/codex browser", "codex cancel", "codex /homes/codex device"]);
    const refused = loginFixture({}, true);
    assert.deepEqual(await refused.invoke("studio:subscription.signin", { engine: "codex" }), {
      ok: false,
      error: "Finish or stop the active work before changing the ChatGPT connection.",
    });
    assert.deepEqual(refused.started, []);
  });

  it("OpenCode signs in through its own CLI in the terminal, whatever else is running", async () => {
    const { invoke, started } = loginFixture({}, true);
    assert.deepEqual(await invoke("studio:opencode.signin"), { ok: true, value: { started: true } });
    assert.deepEqual(started, ["opencode"]);
  });

  it("the OpenCode sign-in runs `opencode auth login` in the terminal, and rechecks its models when it ends", async () => {
    const opened: Array<{ file: string; args: string[]; kind: string; env: NodeJS.ProcessEnv }> = [];
    let exit: ((code: number) => void) | undefined;
    let signedIn = 0;
    const { openCodeLogin } = createLoginControllers({
      terminals: {
        open: (launch) => {
          opened.push(launch);
          exit = launch.onExit;
          return { id: "t1", title: launch.title, kind: launch.kind, phase: "running" };
        },
        stop: async () => {},
      },
      openExternal: async () => {},
      subscription: () => null,
      pushUiEvent: () => {},
      showCodexState: () => {},
      showClaudeState: () => {},
      onOpenCodeSignedIn: async () => {
        signedIn++;
      },
      requireCli: async (provider) => ({
        path: `/bin/${provider}`,
        env: { PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant-not-for-opencode", OPENCODE_CONFIG: "/oc.json" },
        status: {
          provider,
          state: "ready",
          selection: "automatic",
          path: `/bin/${provider}`,
          detail: "",
          guidanceUrl: "",
        },
      }),
    });
    assert.deepEqual(await openCodeLogin.start(), { started: true });
    assert.equal(opened[0]?.file, "/bin/opencode");
    assert.deepEqual(opened[0]?.args, ["auth", "login"]);
    assert.equal(opened[0]?.kind, "opencode-login");
    assert.equal(opened[0]?.env.ANTHROPIC_API_KEY, undefined, "no other vendor's key reaches the sign-in");
    assert.equal(opened[0]?.env.OPENCODE_CONFIG, "/oc.json");
    assert.equal(
      opened[0]?.env.OPENCODE_DISABLE_MODELS_FETCH,
      "1",
      "the provider list never waits on a catalog download that can stall",
    );
    exit?.(0);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(signedIn, 1);

    const missing = createLoginControllers({
      terminals: {
        open: () => {
          throw new Error("no terminal without a CLI");
        },
        stop: async () => {},
      },
      openExternal: async () => {},
      subscription: () => null,
      pushUiEvent: () => {},
      showCodexState: () => {},
      showClaudeState: () => {},
      requireCli: async () => {
        throw new Error("opencode is not installed");
      },
    });
    assert.deepEqual(await missing.openCodeLogin.start(), { started: false, missingCli: true });
  });

  it("on OpenCode 2.x the sign-in runs on a server of its own, never the shared background one", async () => {
    const v2: Array<{ args: string[] }> = [];
    const { openCodeLogin: v2Login } = createLoginControllers({
      terminals: {
        open: (launch) => {
          v2.push(launch);
          return { id: "t2", title: launch.title, kind: launch.kind, phase: "running" };
        },
        stop: async () => {},
      },
      openExternal: async () => {},
      subscription: () => null,
      pushUiEvent: () => {},
      showCodexState: () => {},
      showClaudeState: () => {},
      requireCli: async (provider) => ({
        path: `/bin/${provider}`,
        env: { PATH: "/bin" },
        status: {
          provider,
          state: "ready",
          selection: "automatic",
          path: `/bin/${provider}`,
          version: "opencode v2.0.20",
          detail: "",
          guidanceUrl: "",
        },
      }),
    });
    await v2Login.start();
    assert.deepEqual(
      v2[0]?.args,
      ["auth", "login", "--standalone"],
      "2.x signs in on a server of its own, never by starting the shared background one",
    );
  });

  it("an unknown engine is refused", async () => {
    const { invoke } = loginFixture({});
    assert.deepEqual(await invoke("studio:subscription.signin", { engine: "nope" }), {
      ok: false,
      error: "unknown subscription engine: nope",
    });
  });

  it("each controller resolves the executable the SDK spawns for its own provider", async () => {
    const asked: string[] = [];
    const { claudeLogin, codexLogin } = createLoginControllers({
      terminals: {
        open: () => {
          throw new Error("no terminal in this test");
        },
        stop: async () => {},
      },
      openExternal: async () => {},
      subscription: () => null,
      pushUiEvent: () => {},
      showCodexState: () => {},
      showClaudeState: () => {},
      requireCli: async (provider) => {
        asked.push(provider);
        throw new Error(`${provider} is not installed`);
      },
      findBinary: async () => {
        throw new Error("the installation is resolved first");
      },
    });
    assert.deepEqual(await claudeLogin.start(null), { started: false, error: "claude-code is not installed" });
    await codexLogin.start("/homes/codex");
    assert.deepEqual(asked, ["claude-code", "codex"]);
  });
});

describe("the composer's plan limits", () => {
  it("come from every ready subscription and never from a signed-out, missing or failing one", async () => {
    const usage = {
      measuredAt: "2026-09-24T00:00:00.000Z",
      windows: [{ id: "five_hour", label: "5-hour limit", percent: 12 }],
    };
    const engines: Record<string, { status(): Promise<{ code: string }>; readUsage?(): Promise<unknown> }> = {
      "claude-code": { status: async () => ({ code: "ready" }), readUsage: async () => usage },
      codex: {
        status: async () => ({ code: "needs_login" }),
        readUsage: async () => {
          throw new Error("must not be asked");
        },
      },
      ollama: { status: async () => ({ code: "ready" }), readUsage: async () => usage },
    };
    const core = {
      engines: { has: (id: string) => id in engines, get: (id: string) => engines[id] },
    } as unknown as ModelsIpcDeps["core"];
    const { handle, invoke } = registrar();
    registerModelsIpc(handle, { core, subscription: () => null, pushUiEvent: () => {} });
    assert.deepEqual(await invoke("studio:provider-usage"), { ok: true, value: [{ engine: "claude-code", usage }] });
    engines.codex = {
      status: async () => ({ code: "ready" }),
      readUsage: async () => {
        throw new Error("offline");
      },
    };
    delete engines["claude-code"];
    assert.deepEqual(await invoke("studio:provider-usage"), { ok: true, value: [{ engine: "codex", usage: null }] });
  });
});

describe("notifications reach the person outside the window", () => {
  function notificationsRig(supported = true) {
    const { handle, invoke } = registrar();
    const created: Array<{
      options: { title: string; subtitle?: string; body: string };
      listeners: Map<string, () => void>;
      shown: number;
    }> = [];
    const log: string[] = [];
    const events: UiEvent[] = [];
    let minimized = true;
    const window = {
      isDestroyed: () => false,
      isMinimized: () => minimized,
      restore: () => {
        log.push("restore");
        minimized = false;
      },
      show: () => log.push("show"),
      focus: () => log.push("focus"),
    };
    registerNotificationsIpc(handle, {
      notifications: {
        isSupported: () => supported,
        create: (options) => {
          const note = { options, listeners: new Map<string, () => void>(), shown: 0 };
          created.push(note);
          return {
            on: (event, listener) => note.listeners.set(event, listener),
            show: () => {
              note.shown++;
            },
          };
        },
      },
      window: () => window,
      setDockBadge: (text) => log.push(`badge ${JSON.stringify(text)}`),
      pushUiEvent: (event) => events.push(event),
    });
    return { invoke, created, log, events };
  }

  it("a note is shown clipped, and its click brings the window forward and opens the row it names", async () => {
    const { invoke, created, log, events } = notificationsRig();
    assert.deepEqual(
      await invoke("studio:notify", {
        id: "run:1",
        title: "t".repeat(200),
        subtitle: "Lunar garden",
        body: "b".repeat(400),
      }),
      { ok: true, value: true },
    );
    assert.equal(created.length, 1);
    assert.equal(created[0]!.shown, 1);
    assert.deepEqual(
      [created[0]!.options.title.length, created[0]!.options.subtitle, created[0]!.options.body.length],
      [120, "Lunar garden", 240],
    );
    created[0]!.listeners.get("click")!();
    assert.deepEqual(log, ["restore", "show", "focus"]);
    assert.deepEqual(events, [{ type: "notification.open", payload: { id: "run:1" } }]);
  });

  it("a note without an id opens nothing, and an unsupported system shows none", async () => {
    const quiet = notificationsRig();
    await invoke(quiet, { title: "Done", body: "The build finished." });
    quiet.created[0]!.listeners.get("click")!();
    assert.deepEqual(quiet.events, []);
    const unsupported = notificationsRig(false);
    assert.deepEqual(await unsupported.invoke("studio:notify", { title: "Done", body: "x" }), {
      ok: true,
      value: false,
    });
    assert.equal(unsupported.created.length, 0);
    function invoke(rig: ReturnType<typeof notificationsRig>, payload: unknown) {
      return rig.invoke("studio:notify", payload);
    }
  });

  it("the Dock badge shows whole counts up to 99 and clears for none or nonsense", async () => {
    const { invoke, log } = notificationsRig();
    for (const count of [3, 250, 0, -4, 2.7, "x"]) await invoke("studio:badge", { count });
    assert.deepEqual(log, ['badge "3"', 'badge "99"', 'badge ""', 'badge ""', 'badge "2"', 'badge ""']);
    assert.equal(badgeText(Number.NaN), "");
  });
});

it("model refresh validates provider identities before invoking discovery", async () => {
  const { EngineRegistry } = await import("../../src/substrate/engines/registry.ts");
  let calls = 0;
  const engines = new EngineRegistry();
  engines.register({
    id: "codex",
    label: "Codex",
    kind: "delegated",
    models: async () => [],
    status: async () => ({ code: "ready", detail: "" }),
    refreshModels: async (force) => {
      assert.equal(force, true);
      calls++;
    },
  });
  // Only the registrar's engine registry is needed; no profile or credentials are opened.
  const core = { engines };
  const { handle, invoke } = registrar();
  registerModelsIpc(handle, { core, subscription: () => null, pushUiEvent: () => {} });
  for (const provider of [undefined, null, 7, {}, "../codex", "ollama", ""]) {
    assert.equal((await invoke("studio:models.refresh", { provider })).ok, false);
    assert.equal(calls, 0);
  }
  assert.deepEqual(await invoke("studio:models.refresh", { provider: "codex" }), { ok: true, value: true });
  assert.equal(calls, 1);
});

it("model refresh and recheck reach OpenCode and OpenRouter, which have no subscription sign-in", async () => {
  const { EngineRegistry } = await import("../../src/substrate/engines/registry.ts");
  const refreshed: string[] = [];
  const engines = new EngineRegistry();
  for (const id of ["opencode", "openrouter"])
    engines.register({
      id,
      label: id,
      kind: id === "opencode" ? "delegated" : "direct",
      models: async () => [],
      status: async () => ({ code: "ready", detail: "" }),
      refreshModels: async (force) => {
        refreshed.push(`${id} ${force}`);
      },
    });
  const events: UiEvent[] = [];
  const { handle, invoke } = registrar();
  registerModelsIpc(handle, {
    core: { engines },
    subscription: () => null,
    pushUiEvent: (event) => events.push(event),
  });
  assert.deepEqual(await invoke("studio:models.refresh", { provider: "opencode" }), { ok: true, value: true });
  assert.deepEqual(await invoke("studio:engines.recheck", { engine: "openrouter" }), { ok: true, value: true });
  assert.deepEqual(refreshed, ["opencode true", "openrouter true"]);
  assert.deepEqual(events, [{ type: "engines.changed", payload: {} }]);
});

/** The status code an engine-status answer carries. */
const statusCode = (value: unknown): unknown => (value as { code?: unknown } | null)?.code;

it("the OpenRouter key is saved and forgotten through the engine, and only its status comes back", async () => {
  const { EngineRegistry } = await import("../../src/substrate/engines/registry.ts");
  const { OpenRouterEngine } = await import("../../src/substrate/engines/openrouter.ts");
  const { memoryKeyStore } = await import("../../src/substrate/provider-keys.ts");
  const { tmpDir } = await import("../helpers/tmp.ts");
  const { startFakeOpenRouter, GOOD_KEY } = await import("../helpers/fake-openrouter.ts");
  const server = await startFakeOpenRouter();
  try {
    const keys = memoryKeyStore(null);
    const engines = new EngineRegistry();
    engines.register(new OpenRouterEngine({ root: await tmpDir("ipc-openrouter-"), keys, baseUrl: server.baseUrl }));
    const events: UiEvent[] = [];
    const { handle, invoke } = registrar();
    registerModelsIpc(handle, {
      core: { engines },
      subscription: () => null,
      pushUiEvent: (event) => events.push(event),
    });
    // Hostile payloads: nothing is kept, and no answer ever carries a key.
    for (const payload of [
      undefined,
      null,
      {},
      { key: 7 },
      { key: "" },
      { key: `${GOOD_KEY}\nX: 1` },
      { key: "x".repeat(5000) },
    ]) {
      const answer = await invoke("studio:openrouter.key.save", payload);
      assert.equal(answer.ok && statusCode(answer.value), "needs_login", JSON.stringify(payload)?.slice(0, 40));
      assert.equal(await keys.read(), null);
    }
    const saved = await invoke("studio:openrouter.key.save", { key: GOOD_KEY });
    assert.equal(saved.ok && statusCode(saved.value), "ready");
    assert.doesNotMatch(JSON.stringify(saved), /0123456789abcdef/);
    assert.equal(await keys.read(), GOOD_KEY);
    const cleared = await invoke("studio:openrouter.key.clear");
    assert.equal(cleared.ok && statusCode(cleared.value), "needs_login");
    assert.equal(await keys.read(), null);
    assert.ok(events.every((event) => event.type === "engines.changed"));
    assert.equal(events.length, 9);
  } finally {
    await server.close();
  }
});

it("deleting a model asks the local engine that owns it and announces the change", async () => {
  const removed: string[] = [];
  const events: UiEvent[] = [];
  const engines: Record<string, { removeModel?(id: string): Promise<void> }> = {
    bonsai: { removeModel: async (id) => void removed.push(`bonsai ${id}`) },
    ollama: { removeModel: async (id) => void removed.push(`ollama ${id}`) },
  };
  const core = {
    engines: { has: (id: string) => id in engines, get: (id: string) => engines[id] },
  } as unknown as ModelsIpcDeps["core"];
  const { handle, invoke } = registrar();
  registerModelsIpc(handle, { core, subscription: () => null, pushUiEvent: (event) => events.push(event) });
  assert.deepEqual(await invoke("studio:models.remove", { model: "bonsai-2:27b-ptq1_0" }), { ok: true, value: true });
  assert.deepEqual(await invoke("studio:models.remove", { model: "gemma4:12b" }), { ok: true, value: true });
  assert.deepEqual(removed, ["bonsai bonsai-2:27b-ptq1_0", "ollama gemma4:12b"]);
  assert.deepEqual(events, [
    { type: "engines.changed", payload: { engine: "bonsai" } },
    { type: "engines.changed", payload: { engine: "ollama" } },
  ]);
  for (const payload of [undefined, null, {}, { model: 7 }, { model: "" }, { model: ["gemma4:12b"] }]) {
    assert.equal((await invoke("studio:models.remove", payload)).ok, false, JSON.stringify(payload));
  }
  delete engines.ollama;
  engines.bonsai = {};
  for (const model of ["gemma4:12b", "bonsai-2:27b-ptq1_0"]) {
    assert.equal((await invoke("studio:models.remove", { model })).ok, false, `${model} has no engine to delete it`);
  }
  assert.equal(removed.length, 2, "a refused delete asks no engine");
  assert.equal(events.length, 2, "and announces nothing");
});

describe("the in-window update prompt", () => {
  /** The update channels over a recorded announcer, in a live or a fixture profile. */
  function updateRig(fixture: boolean) {
    const listeners = new Map<string, Listener>();
    const handle = createIpcHandle(
      { handle: (channel, listener) => listeners.set(channel, listener) },
      {
        fixture,
        isStudioUi: () => true,
      },
    );
    const restarts: string[] = [];
    registerUpdateIpc(handle, {
      updates: {
        ready: () => ({ version: "0.2.0", action: UpdateAction.Restart }),
        restart: async () => {
          restarts.push("restart");
          return true;
        },
        download: () => {
          restarts.push("download");
          return true;
        },
      },
      check: async () => ({ status: UpdateCheckStatus.Off, current: "0.1.0", update: null }),
      about: () => ({ version: "0.1.0", platform: "darwin", arch: "arm64" }),
    });
    const invoke = (channel: string) => listeners.get(channel)!(studio, undefined);
    return { invoke, restarts };
  }

  it("answers what is running for Settings → About, in a fixture profile too", async () => {
    for (const fixture of [false, true])
      assert.deepEqual(await updateRig(fixture).invoke("studio:update.about"), {
        ok: true,
        value: { version: "0.1.0", platform: "darwin", arch: "arm64" },
      });
  });

  it("answers the downloaded update, and restarts into it on the person's word", async () => {
    const { invoke, restarts } = updateRig(false);
    assert.deepEqual(await invoke("studio:update"), {
      ok: true,
      value: { version: "0.2.0", action: UpdateAction.Restart },
    });
    assert.deepEqual(await invoke("studio:update.restart"), { ok: true, value: true });
    assert.deepEqual(restarts, ["restart"]);
  });

  it("a fixture profile reads the update but never quits the app to install one", async () => {
    const { invoke, restarts } = updateRig(true);
    assert.deepEqual(await invoke("studio:update"), {
      ok: true,
      value: { version: "0.2.0", action: UpdateAction.Restart },
    });
    const refused = await invoke("studio:update.restart");
    assert.equal(refused.ok, false);
    assert.deepEqual(restarts, []);
  });

  it("checks for updates in any profile, but only a live one opens the download page", async () => {
    const off = { status: UpdateCheckStatus.Off, current: "0.1.0", update: null };
    const live = updateRig(false);
    assert.deepEqual(await live.invoke("studio:update.check"), { ok: true, value: off });
    assert.deepEqual(await live.invoke("studio:update.download"), { ok: true, value: true });
    assert.deepEqual(live.restarts, ["download"]);
    const fixture = updateRig(true);
    assert.deepEqual(await fixture.invoke("studio:update.check"), { ok: true, value: off });
    assert.equal((await fixture.invoke("studio:update.download")).ok, false);
    assert.deepEqual(fixture.restarts, []);
  });
});
