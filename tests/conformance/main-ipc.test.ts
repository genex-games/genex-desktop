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
import { registerStorageIpc } from "../../src/main/ipc/storage.ts";
import { registerJobsIpc } from "../../src/main/ipc/jobs.ts";
import { type PlayIpcDeps, registerPlayIpc } from "../../src/main/ipc/play.ts";
import { NativeArch, type NativeHost, NativePlatform } from "../../src/shared/play-native.ts";
import { gameLinks } from "../../src/main/play/game-links.ts";
import { createLoginControllers, settleSignIn, type SubscriptionEngine } from "../../src/main/login-controllers.ts";
import { AccountId, SubscriptionAccounts } from "../../src/substrate/engines/subscription-accounts.ts";
import { EngineStatusCode } from "../../src/shared/engine-descriptor.ts";
import { mkdtempSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ClaudeLoginState } from "../../src/shared/claude-login.ts";
import type { CodexLoginState } from "../../src/shared/codex-login.ts";
import { UiEvent } from "../../src/shared/ui-events.ts";
import { UpdateAction, UpdateCheckStatus } from "../../src/shared/app-update.ts";
import type { EventEnvelope } from "../../src/shared/event-log.ts";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { Duplex, PassThrough } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { registerGamesIpc, type GamesIpcDeps } from "../../src/main/ipc/games.ts";
import { StudioPlatform } from "../../src/shared/boot.ts";
import { BuildTarget, GameStack } from "../../src/shared/game-project.ts";
import { type CreateOptions, GameWorkspaces, ScaffoldCaller } from "../../src/substrate/game-workspace.ts";
import { registerNativeIpc } from "../../src/main/ipc/native.ts";
import { createGameCrashStore } from "../../src/main/core/game-crashes.ts";
import { type GameCrashesAnswer, parseCrashRecord } from "../../src/shared/crash-record.ts";
import { fixtureNativeRuns } from "../../src/main/dev/fixture-native-runs.ts";
import { FixtureName } from "../../src/main/dev/fixture-kit.ts";
import { FIXTURE_CPP_GAMES } from "../../src/main/dev/fixture-toolchains.ts";
import {
  type NativeEmbedRequest,
  NativeRuns,
  type NativeStartRequest,
  type NativeSurfaceSize,
  type PreparedRun,
} from "../../src/main/core/native-runs.ts";
import { assertOwnedProject } from "../../src/main/project-policy.ts";
import {
  initialNative,
  nativeLogReceived,
  nativeOf,
  nativeStatusReceived,
  nativeWatched,
} from "../../src/renderer/state/native.ts";
import { NativeGamePort } from "../../src/substrate/native-game-port.ts";
import type { GameChild } from "../../src/substrate/spawn.ts";
import { type BuildProblem, BuildProblemCode } from "../../src/shared/build-problem.ts";
import {
  NATIVE_GAMEPAD_AXES_MAX,
  NATIVE_INPUT_ACTIONS_MAX,
  NATIVE_NO_RUN_ID,
  NATIVE_READY_TIMEOUT_MS,
  type NativeInputAction,
  type NativeLogBatch,
  NativeError,
  NativeRefusal,
  NativeRunMode,
  type NativeRunStatus,
  NativeRunState,
  type NativeTimers,
  ringSizeFor,
} from "../../src/shared/native-contract.ts";
import { tmpDir } from "../helpers/tmp.ts";

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

function loginFixture(
  logins: Record<string, Awaited<ReturnType<SubscriptionEngine["resolveLogin"]>>>,
  busy = false,
  accountsFor: { signedIn?: string[]; emails?: Record<string, string> } = {},
) {
  const started: string[] = [];
  const accountsRoot = mkdtempSync(path.join(os.tmpdir(), "studio-ipc-accounts-"));
  const signedIn = new Set(accountsFor.signedIn ?? []);
  const engines = new Map<string, SubscriptionEngine>(
    ["claude-code", "codex"].map((id) => [
      id,
      {
        engineHome: `/homes/${id}`,
        systemHome: `/system/${id}`,
        accounts: new SubscriptionAccounts({
          systemHome: `/system/${id}`,
          studioHome: `/homes/${id}`,
          root: path.join(accountsRoot, id),
          signedIn: async (home) => signedIn.has(home),
        }),
        resolveLogin: async () => logins[id] ?? { source: "none", home: null },
        recheckLogin: async () => {
          started.push(`recheck ${id}`);
        },
        runOnAccount: async (account) => {
          started.push(`use ${id} ${account}`);
          return { code: EngineStatusCode.Ready, detail: "" };
        },
        accountEmail: async (home) => {
          started.push(`email ${id} ${home}`);
          return accountsFor.emails?.[home] ?? null;
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
  return { invoke, started, engines, accountsRoot, signedIn };
}

describe("a subscription's accounts", () => {
  it("signs one more account in to a fresh home of its own, never over another's", async () => {
    for (const engine of ["claude-code", "codex"]) {
      const { invoke, started, accountsRoot } = loginFixture({});
      await invoke("studio:subscription.signin", { engine, account: "new" });
      const home = path.join(accountsRoot, engine, "account-2");
      assert.equal(started.at(-1), engine === "codex" ? `codex ${home} browser` : `claude ${home}`);
      assert.ok(existsSync(home));
    }
  });

  it("signs Claude in to the Terminal login where the CLI keeps it, and never prepares Codex's own home", async () => {
    const claude = loginFixture({});
    await claude.invoke("studio:subscription.signin", { engine: "claude-code", account: AccountId.Terminal });
    assert.deepEqual(claude.started, ["claude null"]);
    const codex = loginFixture({ codex: { source: "system", home: "/system/codex" } });
    await codex.invoke("studio:subscription.signin", { engine: "codex", account: AccountId.Terminal });
    assert.deepEqual(codex.started, ["codex /homes/codex browser"], "Studio never writes into ~/.codex");
  });

  it("signs in again to the account in use when it is one Studio added, and only then", async () => {
    const logins: Parameters<typeof loginFixture>[0] = {};
    const { invoke, started, accountsRoot } = loginFixture(logins);
    const added = path.join(accountsRoot, "codex", "account-3");
    logins.codex = { source: "isolated", home: added };
    logins["claude-code"] = { source: "isolated", home: "/elsewhere" };
    await invoke("studio:subscription.signin", { engine: "codex" });
    await invoke("studio:subscription.signin", { engine: "claude-code" });
    logins.codex = { source: "isolated", home: "/elsewhere" };
    await invoke("studio:subscription.signin", { engine: "codex" });
    assert.deepEqual(started, [`codex ${added} browser`, "claude /elsewhere", "codex /homes/codex browser"]);
  });

  it("refuses a sign-in to an id that is no account's, and writes nothing", async () => {
    for (const account of ["../x", "/etc", "account-1", "ACCOUNT-2"]) {
      const { invoke, started, accountsRoot } = loginFixture({});
      const answer = await invoke("studio:subscription.signin", { engine: "claude-code", account });
      assert.equal(answer.ok, false, account);
      assert.deepEqual(started, []);
      assert.equal(existsSync(path.join(accountsRoot, "claude-code")), false);
    }
  });

  it("switches accounts through the engine, Codex never while work is in flight", async () => {
    const { invoke, started } = loginFixture({});
    assert.deepEqual(await invoke("studio:subscription.use-account", { engine: "claude-code", account: "studio" }), {
      ok: true,
      value: { code: EngineStatusCode.Ready, detail: "" },
    });
    assert.deepEqual(started, ["use claude-code studio"]);
    const busy = loginFixture({}, true);
    const refused = await busy.invoke("studio:subscription.use-account", { engine: "codex", account: "studio" });
    assert.equal(refused.ok, false);
    assert.deepEqual(busy.started, []);
  });

  it("lists the accounts with each email asked for once and kept", async () => {
    const { invoke, started } = loginFixture({}, false, {
      signedIn: ["/system/claude-code", "/homes/claude-code"],
      emails: { "/homes/claude-code": "me@example.com" },
    });
    const first = await invoke("studio:subscription.accounts", { engine: "claude-code" });
    assert.deepEqual(first, {
      ok: true,
      value: [
        { id: "terminal", email: null, terminal: true, signedIn: true, active: false },
        { id: "studio", email: "me@example.com", terminal: false, signedIn: true, active: true },
      ],
    });
    await invoke("studio:subscription.accounts", { engine: "claude-code" });
    assert.deepEqual(started, ["email claude-code /system/claude-code", "email claude-code /homes/claude-code"]);
  });

  it("never signs the Terminal login out, nor an id that is no account's", async () => {
    for (const account of [AccountId.Terminal, "../../x"]) {
      const { invoke, started } = loginFixture({});
      const answer = await invoke("studio:subscription.forget-studio-login", { engine: "claude-code", account });
      assert.equal(answer.ok, false, account);
      assert.deepEqual(started, []);
    }
  });

  it("forgetting the account in use runs the next signed-in one", async () => {
    const { invoke, engines, signedIn, accountsRoot } = loginFixture({}, false, {
      signedIn: ["/system/claude-code"],
    });
    const accounts = engines.get("claude-code")?.accounts;
    assert.ok(accounts);
    const added = await accounts.newAccount();
    signedIn.add(added.home);
    await accounts.remember(added.id, { email: "work@example.com" });
    await accounts.choose(added.id);
    await invoke("studio:subscription.forget-studio-login", { engine: "claude-code", account: added.id });
    assert.equal(await accounts.chosen(), AccountId.Terminal);
    assert.equal(existsSync(path.join(accountsRoot, "claude-code", added.id)), false);
  });

  it("never shows a forgotten account's email on the next account given its id", async () => {
    const emails: Record<string, string> = {};
    const { invoke, engines, signedIn } = loginFixture({}, false, { signedIn: ["/system/claude-code"], emails });
    const engine = engines.get("claude-code");
    assert.ok(engine);
    const first = await engine.accounts.newAccount();
    signedIn.add(first.home);
    await settleSignIn(engine, first.home);
    // Its CLI names the email only later, when the list asks.
    emails[first.home] = "old@example.com";
    const listed = async () => {
      const answer = await invoke("studio:subscription.accounts", { engine: "claude-code" });
      assert.ok(answer.ok);
      return (answer.value as { id: string; email: string | null }[]).find((entry) => entry.id === first.id)?.email;
    };
    assert.equal(await listed(), "old@example.com");
    await invoke("studio:subscription.forget-studio-login", { engine: "claude-code", account: first.id });
    const next = await engine.accounts.newAccount();
    assert.equal(next.id, first.id, "a forgotten account's id is given again");
    signedIn.add(next.home);
    delete emails[next.home];
    await settleSignIn(engine, next.home);
    assert.equal(await listed(), null, "the new person's CLI reports no email, so none shows");
  });

  it("a finished sign-in remembers its account with its email and runs on it", async () => {
    const { engines, signedIn, started } = loginFixture({}, false, { signedIn: ["/system/codex"] });
    const engine = engines.get("codex");
    assert.ok(engine);
    const added = await engine.accounts.newAccount();
    signedIn.add(added.home);
    await settleSignIn(engine, added.home, "work@example.com");
    assert.equal(await engine.accounts.chosen(), added.id);
    const listed = (await engine.accounts.list()).find((entry) => entry.id === added.id);
    assert.equal(listed?.email, "work@example.com");
    assert.deepEqual(started, ["recheck codex"]);
  });
});

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
    registerModelsIpc(handle, { core, subscription: () => null, pushUiEvent: () => {}, openRouterLogin: noSignIn });
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
  registerModelsIpc(handle, { core, subscription: () => null, pushUiEvent: () => {}, openRouterLogin: noSignIn });
  for (const provider of [undefined, null, 7, {}, "../codex", "ollama", ""]) {
    assert.equal((await invoke("studio:models.refresh", { provider })).ok, false);
    assert.equal(calls, 0);
  }
  assert.deepEqual(await invoke("studio:models.refresh", { provider: "codex" }), { ok: true, value: true });
  assert.equal(calls, 1);
});

/** A stand-in for `src/game-template-cpp` until the C++ template lands. */
async function cppTemplate(dir: string): Promise<string> {
  const files: Record<string, string> = {
    "CMakeLists.txt": "cmake_minimum_required(VERSION 3.28)\nproject(game CXX C)\ngenex_add_game(SOURCES src/*.cpp)\n",
    "src/main.cpp": '#include "studio.h"\nint main() {\n  studio::install({});\n}\n',
    "CLAUDE.md": "# Rules for a C++ game\n",
    "NOTES.md": "# __GAME_TITLE__\n",
  };
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), text);
  }
  return dir;
}

/** `[first, <empty>, last]`: a list with an empty slot, which a renderer's structured clone carries as it is. */
function gapped(first: string, last: string): string[] {
  const list: string[] = [];
  list[0] = first;
  list[2] = last;
  return list;
}

/** The games registrar over a real library: what the core was asked for, and where games land. */
async function gamesIpc() {
  const base = await tmpDir("studio-main-ipc-games-");
  const root = path.join(base, "library");
  const games = new GameWorkspaces({
    root,
    templateDir: path.resolve(import.meta.dirname, "../../src/game-template"),
    cppTemplateDir: await cppTemplate(path.join(base, "game-template-cpp")),
    vendorDir: path.join(base, "vendor"),
    indexFile: path.join(base, "projects.json"),
    userData: path.join(base, "userData"),
    homeDir: base,
    platform: StudioPlatform.Mac,
  });
  const asked: Array<[string, CreateOptions]> = [];
  const core = {
    createGame: (title: string, options: CreateOptions) => {
      asked.push([title, options]);
      return games.create(title, options);
    },
  };
  const { handle, invoke } = registrar();
  const deps = { core, runSummaryReader: {}, pushUiEvent: () => {} } as unknown as GamesIpcDeps;
  registerGamesIpc(handle, deps);
  return { invoke, asked, root };
}

/** Whether a game's folder holds a page at its root. */
const hasPage = (dir: string) =>
  readFile(path.join(dir, "index.html")).then(
    () => true,
    () => false,
  );

describe("Create game carries where people play", () => {
  it("studio:game.create forwards stack and targets, and a game made without them stays a browser game", async () => {
    const { invoke, asked } = await gamesIpc();
    // Raylib creation is retired (M6.3; its refusal is native-scaffold's row), and this library's
    // development gate is closed to Rust, so the stack forwarded here is the browser's, named.
    const created = await invoke("studio:game.create", {
      title: "Pong",
      stack: GameStack.ThreeJs,
      targets: [BuildTarget.Web],
    });
    assert.ok(created.ok, JSON.stringify(created));
    const pong = created.value as { dir: string };
    // Flipped (M6 review): the IPC names the person as the caller, so the library refuses raylib for it too.
    assert.deepEqual(asked.at(-1), [
      "Pong",
      { stack: GameStack.ThreeJs, targets: [BuildTarget.Web], caller: ScaffoldCaller.Person },
    ]);
    // FLIPPED for empty new projects: the folder holds no page until its first message picks its
    // kind, where it used to get the Three.js starter.
    assert.equal(await hasPage(pong.dir), false);

    const madePlain = await invoke("studio:game.create", { title: "Plain" });
    assert.ok(madePlain.ok, JSON.stringify(madePlain));
    const plain = madePlain.value as { dir: string };
    assert.deepEqual(asked.at(-1), ["Plain", { caller: ScaffoldCaller.Person }]);
    assert.equal(await hasPage(plain.dir), false);
  });

  it("refuses a stack or destinations it does not know before any folder is made", async () => {
    const { invoke, asked, root } = await gamesIpc();
    const hostile: Array<[string, Record<string, unknown>]> = [
      ["a destination that is not a string", { targets: [BuildTarget.Web, 1] }],
      ["destinations that are not a list", { targets: BuildTarget.Mac }],
      ["no destination", { targets: [] }],
      ["forty destinations", { targets: Array.from({ length: 40 }, () => BuildTarget.Web) }],
      ["a prototype's name", { targets: ["__proto__"] }],
      ["one destination twice", { targets: [BuildTarget.Web, BuildTarget.Web] }],
      ["an unknown destination", { targets: ["playstation"] }],
      ["an unknown stack", { stack: "unity" }],
      ["a stack that is not a string", { stack: { toString: GameStack.RaylibCpp } }],
      ["a null stack", { stack: null }],
      ["an empty slot", { targets: new Array(1) }],
      ["an empty slot in a C++ game", { stack: GameStack.RaylibCpp, targets: new Array(1) }],
      ["a gap between destinations", { targets: gapped(BuildTarget.Web, BuildTarget.Mac) }],
    ];
    for (const [label, fields] of hostile) {
      const reply = await invoke("studio:game.create", { title: "Pong", ...fields });
      assert.equal(reply.ok, false, label);
    }
    assert.deepEqual(asked, [], "the core was never asked");
    assert.deepEqual(await readdir(root).catch(() => []), [], "no folder was made");
  });
});

/** What the native registrar asked the registry for, in order. */
type NativeAsk = { call: "start" | "stop" | "state" | "front"; detail: unknown };

/**
 * The native registrar over a library of one game (`pong-mac`, in a real folder) and a recording
 * registry whose window run of `pong-mac` is `running` (or none). `start` answers `start()`'s run,
 * or throws what the row gives it.
 */
async function nativeIpc(
  options: { fixture?: boolean; running?: NativeRunStatus | null; start?: () => Promise<NativeRunStatus> } = {},
) {
  const root = await tmpDir("studio-main-ipc-native-");
  const game = { name: "pong-mac", dir: path.join(root, "pong-mac") };
  await mkdir(game.dir);
  const asked: NativeAsk[] = [];
  const nativeRuns = {
    async start(request: NativeStartRequest) {
      asked.push({ call: "start", detail: { ...request } });
      const status = options.start ? await options.start() : nativeStatus(request.project, NativeRunState.Ready);
      return { status, port: null };
    },
    async stop(runId: string) {
      asked.push({ call: "stop", detail: runId });
    },
    state(project: string, mode?: NativeRunMode) {
      asked.push({ call: "state", detail: [project, mode] });
      return project === game.name ? (options.running ?? null) : null;
    },
    async front(project: string) {
      asked.push({ call: "front", detail: project });
      return true;
    },
    // The shown run's port answers its frame profile (PROF-6): here a fixed summary, by request.
    portOf(project: string) {
      const shown = project === game.name && options.running;
      return shown ? { frameProfile: async (request: { action: string }) => ({ answeredFor: request.action }) } : null;
    },
    onStatus: () => () => {},
  };
  const core = {
    nativeRuns,
    games: { list: async () => [game] },
    assertProjectAllowed: async () => {},
  } as unknown as Parameters<typeof registerNativeIpc>[1];
  const listeners = new Map<string, Listener>();
  const handle = createIpcHandle(
    { handle: (channel, listener) => void listeners.set(channel, listener) },
    { fixture: options.fixture === true, isStudioUi: () => true },
  );
  registerNativeIpc(handle, core, { now: () => Date.parse("2026-10-01T05:00:00.000Z") });
  const invoke = (channel: string, payload?: unknown) => {
    const listener = listeners.get(channel);
    assert.ok(listener, `${channel} is not registered`);
    return listener(studio, payload);
  };
  return { invoke, asked, root, game };
}

/** A window run of `project`, as the registry reports it. */
function nativeStatus(project: string, state: NativeRunState, extra: Partial<NativeRunStatus> = {}): NativeRunStatus {
  return {
    project,
    runId: "run-1",
    target: BuildTarget.Mac,
    state,
    mode: NativeRunMode.Window,
    pid: 4242,
    backend: null,
    refusal: null,
    problem: null,
    exit: null,
    owner: null,
    startedAt: "2026-10-01T04:59:00.000Z",
    endedAt: null,
    ...extra,
  };
}

const NATIVE_CHANNELS = ["studio:native.run", "studio:native.stop", "studio:native.state", "studio:native.front"];

describe("a game's frame profile and crash records over IPC (PROF-0c)", () => {
  const PROFILE_AND_CRASHES = ["studio:native.profile", "studio:game.crashes"];

  it("answers a profile from the shown run (no-run when none), and a game's kept crash records, in a fixture too", async () => {
    const running = nativeStatus("pong-mac", NativeRunState.Ready);
    for (const fixture of [false, true]) {
      const live = await nativeIpc({ fixture, running });
      // CRASH-5 flipped this from `unavailable not-served`: the host keeps records now.
      assert.deepEqual(await live.invoke("studio:game.crashes", { project: "pong-mac" }), {
        ok: true,
        value: { records: [] },
      });
      const store = createGameCrashStore({
        gameDir: async () => live.game.dir,
        announce: async () => {},
        now: () => Date.parse("2026-10-01T05:00:00.000Z"),
      });
      const panic = parseCrashRecord({
        format: "genex-crash/1",
        kind: "panic",
        source: "game",
        fatal: true,
        handled: false,
        message: "boom",
      });
      assert.ok(panic);
      await store.keep({ project: "pong-mac", runId: "0123456789ab" }, panic);
      const listed = await live.invoke("studio:game.crashes", { project: "pong-mac" });
      assert.equal(listed.ok, true);
      const value = listed.ok ? (listed.value as GameCrashesAnswer) : null;
      assert.deepEqual(
        value?.records.map((entry) => [entry.crashId, entry.record.message]),
        [["0123456789ab-1", "boom"]],
      );
      // PROF-6 flipped this from `unavailable not-served`: the shown run's port answers it now.
      assert.deepEqual(
        await live.invoke("studio:native.profile", { project: "pong-mac", request: { action: "summary" } }),
        {
          ok: true,
          value: { answeredFor: "summary" },
        },
      );
      const idle = await nativeIpc({ fixture });
      assert.deepEqual(
        await idle.invoke("studio:native.profile", { project: "pong-mac", request: { action: "report", frames: 120 } }),
        {
          ok: true,
          value: { state: "unavailable", reason: "no-run" },
        },
      );
    }
  });

  it("refuses a request outside the profile's shape, and a name that is not a listed game, writing nothing", async () => {
    const { invoke, asked, root } = await nativeIpc({ running: nativeStatus("pong-mac", NativeRunState.Ready) });
    const before = await readdir(root, { recursive: true });
    for (const request of [
      undefined,
      null,
      {},
      { action: "flame" },
      { action: "report", frames: 241 },
      { action: "arm", mode: "all" },
    ]) {
      const reply = await invoke("studio:native.profile", { project: "pong-mac", request });
      assert.equal(reply.ok, false, JSON.stringify(request));
    }
    for (const channel of PROFILE_AND_CRASHES)
      for (const project of ["", "../x", "pong-mac/../../x", "p".repeat(10 * 1024), "pong-pc", ["pong-mac"], null, 7])
        assert.equal(
          (await invoke(channel, { project, request: { action: "summary" } })).ok,
          false,
          `${channel} ${String(project).slice(0, 20)}`,
        );
    assert.deepEqual(asked, [], "the registry was never asked");
    assert.deepEqual(await readdir(root, { recursive: true }), before, "nothing was written");
  });
});

describe("a C++ game's own window over IPC", () => {
  it("Play on Mac starts the game's Mac build in a window and answers its status", async () => {
    const { invoke, asked } = await nativeIpc();
    const reply = await invoke("studio:native.run", { project: "pong-mac" });
    assert.ok(reply.ok, JSON.stringify(reply));
    assert.equal((reply.value as NativeRunStatus).state, NativeRunState.Ready);
    assert.deepEqual(asked, [
      { call: "start", detail: { project: "pong-mac", target: BuildTarget.Mac, mode: NativeRunMode.Window } },
      // The run `start` registered at once: the answer is about it, should the start fail.
      { call: "state", detail: ["pong-mac", NativeRunMode.Window] },
    ]);
  });

  it("a refused run answers a refused status, with the build's problem, instead of an error", async () => {
    const problem: BuildProblem = {
      project: "pong-mac",
      command: "",
      code: null,
      lines: [],
      needsInstall: false,
      install: null,
      skippedScripts: null,
      showingLastBuild: false,
      at: "2026-10-01T05:00:00.000Z",
      reason: BuildProblemCode.ToolchainMissing,
      target: BuildTarget.Mac,
    };
    const { invoke } = await nativeIpc({
      start: async () => {
        throw new NativeError(NativeRefusal.BuildFailed, "the Mac build failed", problem);
      },
    });
    const reply = await invoke("studio:native.run", { project: "pong-mac" });
    assert.ok(reply.ok, JSON.stringify(reply));
    const status = reply.value as NativeRunStatus;
    assert.deepEqual(
      [status.project, status.target, status.mode, status.state, status.refusal, status.problem, status.pid],
      [
        "pong-mac",
        BuildTarget.Mac,
        NativeRunMode.Window,
        NativeRunState.Refused,
        NativeRefusal.BuildFailed,
        problem,
        null,
      ],
    );
    assert.equal(status.startedAt, "2026-10-01T05:00:00.000Z");
    const broken = await nativeIpc({
      start: async () => {
        throw new Error("the registry broke");
      },
    });
    const failed = await broken.invoke("studio:native.run", { project: "pong-mac" });
    assert.equal(failed.ok, false, "anything but a typed refusal stays an error");
  });

  it("Stop ends the window run, State reads it, Bring to front raises it", async () => {
    const running = nativeStatus("pong-mac", NativeRunState.Ready);
    const { invoke, asked } = await nativeIpc({ running });
    assert.deepEqual(await invoke("studio:native.state", { project: "pong-mac" }), { ok: true, value: running });
    assert.deepEqual(await invoke("studio:native.front", { project: "pong-mac" }), { ok: true, value: true });
    assert.deepEqual(await invoke("studio:native.stop", { project: "pong-mac" }), { ok: true, value: true });
    assert.deepEqual(asked, [
      { call: "state", detail: ["pong-mac", NativeRunMode.Window] },
      { call: "front", detail: "pong-mac" },
      { call: "state", detail: ["pong-mac", NativeRunMode.Window] },
      { call: "stop", detail: "run-1" },
    ]);
    const idle = await nativeIpc();
    assert.deepEqual(await idle.invoke("studio:native.stop", { project: "pong-mac" }), { ok: true, value: false });
  });

  it("studio:native.run and front refuse in a fixture; stop and state do not", async () => {
    const running = nativeStatus("pong-mac", NativeRunState.Ready);
    const { invoke, asked } = await nativeIpc({ fixture: true, running });
    for (const channel of ["studio:native.run", "studio:native.front"]) {
      const reply = await invoke(channel, { project: "pong-mac" });
      assert.equal(reply.ok, false, channel);
      assert.match(reply.ok ? "" : reply.error, /unsupported-in-fixture/, channel);
    }
    assert.equal((await invoke("studio:native.state", { project: "pong-mac" })).ok, true);
    assert.equal((await invoke("studio:native.stop", { project: "pong-mac" })).ok, true);
    assert.deepEqual(
      asked.map((ask) => ask.call),
      ["state", "state", "stop"],
      "nothing was started or raised",
    );
  });

  it("refuses a game name that is not a listed game before anything runs, and writes nothing", async () => {
    const { invoke, asked, root } = await nativeIpc({ running: nativeStatus("pong-mac", NativeRunState.Ready) });
    const before = await readdir(root, { recursive: true });
    const hostile: Array<[string, unknown]> = [
      ["an empty name", { project: "" }],
      ["a path out of the library", { project: "../x" }],
      ["a path into the game", { project: "pong-mac/../../x" }],
      ["ten kilobytes of name", { project: "p".repeat(10 * 1024) }],
      ["a game that is not in the library", { project: "pong-pc" }],
      ["a list", { project: ["pong-mac"] }],
      ["a null name", { project: null }],
      ["a number", { project: 7 }],
      ["no name", {}],
      ["no payload", undefined],
      ["a null payload", null],
    ];
    for (const channel of NATIVE_CHANNELS)
      for (const [label, payload] of hostile) {
        const reply = await invoke(channel, payload);
        assert.equal(reply.ok, false, `${channel}: ${label}`);
      }
    assert.deepEqual(asked, [], "the registry was never asked");
    assert.deepEqual(await readdir(root, { recursive: true }), before, "nothing was written");
  });

  it("refuses a listed game whose folder is not inside the games root, before the registry is asked", async () => {
    const base = await tmpDir("studio-main-ipc-native-root-");
    const gamesRoot = path.join(base, "games");
    const elsewhere = path.join(base, "elsewhere");
    await mkdir(path.join(elsewhere, "pong-out"), { recursive: true });
    await mkdir(path.join(gamesRoot, "real"), { recursive: true });
    await writeFile(path.join(elsewhere, "pong-out", "CMakeLists.txt"), "project(pong)\n");
    await symlink(path.join(elsewhere, "pong-out"), path.join(gamesRoot, "pong-link"));
    await symlink(elsewhere, path.join(gamesRoot, "aliased"));
    const listed = [
      ["a game folder that is a link out of the root", { name: "pong-link", dir: path.join(gamesRoot, "pong-link") }],
      ["a game folder outside the root", { name: "pong-out", dir: path.join(elsewhere, "pong-out") }],
      [
        "a game folder under a linked folder",
        { name: "pong-aliased", dir: path.join(gamesRoot, "aliased", "pong-out") },
      ],
      [
        "a game folder that climbs out of the root",
        { name: "pong-climb", dir: path.join(gamesRoot, "real", "..", "..", "elsewhere", "pong-out") },
      ],
    ] as const;
    const asked: string[] = [];
    const nativeRuns = {
      start: async () => void asked.push("start"),
      stop: async () => void asked.push("stop"),
      state: () => {
        asked.push("state");
        return null;
      },
      front: async () => {
        asked.push("front");
        return true;
      },
      onStatus: () => () => {},
    };
    const core = {
      nativeRuns,
      games: { list: async () => listed.map(([, game]) => game) },
      assertProjectAllowed: (dir: string) => assertOwnedProject(gamesRoot, dir),
    } as unknown as Parameters<typeof registerNativeIpc>[1];
    const { handle, invoke } = registrar();
    registerNativeIpc(handle, core);
    const before = await readdir(base, { recursive: true });
    for (const channel of NATIVE_CHANNELS)
      for (const [label, game] of listed) {
        const reply = await invoke(channel, { project: game.name });
        assert.equal(reply.ok, false, `${channel}: ${label}`);
      }
    assert.deepEqual(asked, [], "the registry was never asked");
    assert.deepEqual(await readdir(base, { recursive: true }), before, "nothing was written");
  });
});

/**
 * The embed registrar over a library of one game (`pong-mac`, in a real folder) and a registry that
 * records what it is asked: its embedded run of `pong-mac` is `embedded` (or none); `embed`
 * answers the row's `embed()`, or a Ready embedded run.
 */
async function embedIpc(
  options: {
    fixture?: boolean;
    embedded?: NativeRunStatus | null;
    embed?: () => Promise<NativeRunStatus>;
    list?: (games: Array<{ name: string; dir: string }>) => Promise<Array<{ name: string; dir: string }>>;
  } = {},
) {
  const root = await tmpDir("studio-main-ipc-embed-");
  const game = { name: "pong-mac", dir: path.join(root, "pong-mac") };
  await mkdir(game.dir);
  const asked: Array<{ call: string; detail: unknown }> = [];
  const nativeRuns = {
    async embed(request: NativeEmbedRequest) {
      asked.push({ call: "embed", detail: { ...request, surface: { ...request.surface } } });
      if (options.embed) return options.embed();
      return nativeStatus(request.project, NativeRunState.Ready, { mode: NativeRunMode.Embedded });
    },
    async stop(runId: string) {
      asked.push({ call: "stop", detail: runId });
    },
    state(project: string, mode?: NativeRunMode) {
      asked.push({ call: "state", detail: [project, mode] });
      const ours = project === game.name && mode === NativeRunMode.Embedded;
      return ours ? (options.embedded ?? null) : null;
    },
    resize(project: string, surface: NativeSurfaceSize) {
      asked.push({ call: "resize", detail: [project, { ...surface }] });
      return true;
    },
    async input(project: string, actions: NativeInputAction[]) {
      asked.push({ call: "input", detail: [project, actions] });
      return true;
    },
    onStatus: () => () => {},
  };
  const core = {
    nativeRuns,
    games: { list: async () => (options.list ? options.list([game]) : [game]) },
    assertProjectAllowed: async () => {},
  } as unknown as Parameters<typeof registerNativeIpc>[1];
  const listeners = new Map<string, Listener>();
  const handle = createIpcHandle(
    { handle: (channel, listener) => void listeners.set(channel, listener) },
    { fixture: options.fixture === true, isStudioUi: () => true },
  );
  registerNativeIpc(handle, core, { now: () => Date.parse("2026-10-01T05:00:00.000Z") });
  const invoke = (channel: string, payload?: unknown) => {
    const listener = listeners.get(channel);
    assert.ok(listener, `${channel} is not registered`);
    return listener(studio, payload);
  };
  return { invoke, asked, root };
}

const EMBED_SIZE = { width: 640, height: 360, dpr: 2 };

describe("a C++ game's Mac build inside Live over IPC", () => {
  it("embed starts the game in Live at its canvas's device pixels and answers the run's status", async () => {
    const { invoke, asked } = await embedIpc();
    const reply = await invoke("studio:native.embed", { project: "pong-mac", size: EMBED_SIZE });
    assert.ok(reply.ok, JSON.stringify(reply));
    const status = reply.value as NativeRunStatus;
    assert.deepEqual([status.mode, status.state], [NativeRunMode.Embedded, NativeRunState.Ready]);
    assert.deepEqual(asked, [
      {
        call: "embed",
        detail: { project: "pong-mac", target: BuildTarget.Mac, surface: { width: 1280, height: 720, dpr: 2 } },
      },
      { call: "state", detail: ["pong-mac", NativeRunMode.Embedded] },
    ]);
    const huge = await embedIpc();
    await huge.invoke("studio:native.embed", { project: "pong-mac", size: { width: 4096, height: 2048, dpr: 4 } });
    const capped = ringSizeFor({ width: 4096, height: 2048, dpr: 4 });
    assert.deepEqual(huge.asked[0]?.detail, {
      project: "pong-mac",
      target: BuildTarget.Mac,
      surface: { ...capped, dpr: 4 },
    });
  });

  it("where Live cannot embed, embed answers a refused status with no run, and nothing runs", async () => {
    for (const refusal of [NativeRefusal.EmbedUnsupported, NativeRefusal.ElectronUntested]) {
      const { invoke } = await embedIpc({
        embed: async () => {
          throw new NativeError(refusal, "Live cannot show a Mac build here");
        },
      });
      const reply = await invoke("studio:native.embed", { project: "pong-mac", size: EMBED_SIZE });
      assert.ok(reply.ok, JSON.stringify(reply));
      const status = reply.value as NativeRunStatus;
      assert.deepEqual(
        [status.project, status.runId, status.mode, status.state, status.refusal, status.pid, status.target],
        ["pong-mac", NATIVE_NO_RUN_ID, NativeRunMode.Embedded, NativeRunState.Refused, refusal, null, BuildTarget.Mac],
      );
    }
  });

  it("unembed stops the game's embedded run; with none it answers false", async () => {
    const embedded = nativeStatus("pong-mac", NativeRunState.Ready, { mode: NativeRunMode.Embedded, runId: "run-7" });
    const { invoke, asked } = await embedIpc({ embedded });
    assert.deepEqual(await invoke("studio:native.unembed", { project: "pong-mac" }), { ok: true, value: true });
    assert.deepEqual(asked, [
      { call: "state", detail: ["pong-mac", NativeRunMode.Embedded] },
      { call: "stop", detail: "run-7" },
    ]);
    const idle = await embedIpc();
    assert.deepEqual(await idle.invoke("studio:native.unembed", { project: "pong-mac" }), { ok: true, value: false });
  });

  it("input reaches the embedded run as checked actions; resize as the capped ring size", async () => {
    const { invoke, asked } = await embedIpc();
    const actions = [
      { type: "click", x: 10, y: 20, px: true, extra: "dropped" },
      { type: "gamepad", index: 0, buttons: [1, 0], axes: [0.5, -0.5] },
      { type: "text", text: "héllo" },
    ];
    assert.deepEqual(await invoke("studio:native.input", { project: "pong-mac", actions }), { ok: true, value: true });
    assert.deepEqual(await invoke("studio:native.resize", { project: "pong-mac", size: EMBED_SIZE }), {
      ok: true,
      value: true,
    });
    const [input, resize] = asked;
    assert.ok(input?.call === "input" && Array.isArray(input.detail));
    const sent: unknown = input.detail[1];
    assert.ok(Array.isArray(sent));
    assert.deepEqual(sent[0], {
      type: "click",
      x: 10,
      y: 20,
      button: undefined,
      clicks: undefined,
      modifiers: undefined,
      px: true,
      stepMs: undefined,
    });
    assert.equal(sent.length, 3);
    assert.deepEqual(resize, { call: "resize", detail: ["pong-mac", { width: 1280, height: 720, dpr: 2 }] });
  });

  it("input and resize reach the game in the order they were sent, with no library listing per call", async () => {
    // A large library lists slower than a frame, and listings can finish out of order: a key's
    // up must never overtake its down.
    const pending: Array<() => void> = [];
    const { invoke, asked } = await embedIpc({
      list: (games) => new Promise((resolve) => pending.push(() => resolve(games))),
    });
    const sent = [
      invoke("studio:native.input", { project: "pong-mac", actions: [{ type: "down", keys: ["Space"] }] }),
      invoke("studio:native.resize", { project: "pong-mac", size: EMBED_SIZE }),
      invoke("studio:native.input", { project: "pong-mac", actions: [{ type: "up", keys: ["Space"] }] }),
    ];
    for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    const listings = pending.length;
    for (const resolve of pending.reverse()) resolve();
    await Promise.all(sent);
    assert.equal(listings, 0, "no call listed the library");
    assert.deepEqual(
      asked.map((entry) => {
        const [, detail] = entry.detail as [string, Array<{ type: string }> | object];
        return Array.isArray(detail) ? `${entry.call} ${detail[0]?.type}` : entry.call;
      }),
      ["input down", "resize", "input up"],
    );
  });

  it("refuses hostile payloads before the registry is asked, and writes nothing", async () => {
    const { invoke, asked, root } = await embedIpc({
      embedded: nativeStatus("pong-mac", NativeRunState.Ready, { mode: NativeRunMode.Embedded }),
    });
    const before = await readdir(root, { recursive: true });
    const tap = { type: "tap", keys: ["Space"] };
    const sized = (size: unknown) => ({ project: "pong-mac", size });
    const acting = (actions: unknown) => ({ project: "pong-mac", actions });
    const hostile: Array<[string, string, unknown]> = [
      ["studio:native.embed", "a NaN side", sized({ ...EMBED_SIZE, width: Number.NaN })],
      ["studio:native.embed", "a million pixels a side", sized({ ...EMBED_SIZE, width: 10 ** 6 })],
      ["studio:native.embed", "a dpr of 9", sized({ ...EMBED_SIZE, dpr: 9 })],
      ["studio:native.embed", "a fractional side", sized({ ...EMBED_SIZE, height: 360.5 })],
      ["studio:native.embed", "no size", { project: "pong-mac" }],
      ["studio:native.embed", "a size that is a list", sized([640, 360, 2])],
      ["studio:native.embed", "a path for a project", { project: "../x", size: EMBED_SIZE }],
      ["studio:native.embed", "a project that is no string", { project: 7, size: EMBED_SIZE }],
      ["studio:native.resize", "a NaN dpr", sized({ ...EMBED_SIZE, dpr: Number.NaN })],
      ["studio:native.resize", "a million pixels a side", sized({ ...EMBED_SIZE, height: 10 ** 6 })],
      ["studio:native.resize", "a dpr of 9", sized({ ...EMBED_SIZE, dpr: 9 })],
      ["studio:native.resize", "a path for a project", { project: "../x", size: EMBED_SIZE }],
      [
        "studio:native.input",
        "one action too many",
        acting(Array.from({ length: NATIVE_INPUT_ACTIONS_MAX + 1 }, () => tap)),
      ],
      ["studio:native.input", "an unknown action kind", acting([tap, { type: "teleport", x: 1 }])],
      [
        "studio:native.input",
        "a gamepad with 50 axes",
        acting([{ type: "gamepad", index: 0, buttons: [], axes: Array.from({ length: 50 }, () => 0) }]),
      ],
      [
        "studio:native.input",
        "a gamepad with one axis too many",
        acting([
          {
            type: "gamepad",
            index: 0,
            buttons: [],
            axes: Array.from({ length: NATIVE_GAMEPAD_AXES_MAX + 1 }, () => 0),
          },
        ]),
      ],
      ["studio:native.input", "a NaN position", acting([{ type: "move", x: Number.NaN, y: 1 }])],
      ["studio:native.input", "257 units of text", acting([{ type: "text", text: "x".repeat(257) }])],
      ["studio:native.input", "a fifth pad", acting([{ type: "gamepad", index: 4, buttons: [], axes: [] }])],
      ["studio:native.input", "actions that are no list", acting({ 0: tap })],
      ["studio:native.input", "a path for a project", { project: "../x", actions: [tap] }],
      ["studio:native.unembed", "a path for a project", { project: "../x" }],
      ["studio:native.unembed", "a project that is no string", { project: ["pong-mac"] }],
      ["studio:native.unembed", "no payload", undefined],
    ];
    for (const [channel, label, payload] of hostile) {
      const reply = await invoke(channel, payload);
      assert.equal(reply.ok, false, `${channel}: ${label}`);
    }
    assert.deepEqual(asked, [], "the registry was never asked: nothing spawned, no port called");
    assert.deepEqual(await readdir(root, { recursive: true }), before, "nothing was written");
  });

  it("the four embed channels run in a fixture profile: embedded play opens no desktop window", async () => {
    const { invoke } = await embedIpc({ fixture: true });
    for (const [channel, payload] of [
      ["studio:native.embed", { project: "pong-mac", size: EMBED_SIZE }],
      ["studio:native.unembed", { project: "pong-mac" }],
      ["studio:native.input", { project: "pong-mac", actions: [] }],
      ["studio:native.resize", { project: "pong-mac", size: EMBED_SIZE }],
    ] as const) {
      const reply = await invoke(channel, payload);
      assert.ok(reply.ok, `${channel}: ${JSON.stringify(reply)}`);
    }
  });
});

/**
 * A fake clock for the real registry and port: nothing fires until `advance` passes its time, and
 * every step lets the game's streams and promises settle.
 */
function manualClock() {
  let now = Date.parse("2026-10-01T05:00:00.000Z");
  let seq = 0;
  const due = new Map<number, { at: number; run: () => void }>();
  const timers: NativeTimers = {
    now: () => now,
    setTimeout: (run, ms) => {
      seq += 1;
      due.set(seq, { at: now + ms, run });
      return seq;
    },
    clearTimeout: (handle) => {
      if (typeof handle === "number") due.delete(handle);
    },
  };
  const settle = async () => {
    for (let round = 0; round < 10; round++) await nextTurn();
  };
  /** Settles until `ready` holds (the run's build, its folders and its spawn take real I/O). */
  const until = async (ready: () => boolean) => {
    for (let round = 0; round < 200 && !ready(); round++) await settle();
    assert.ok(ready(), "the run never got there");
  };
  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      await settle();
      const first = [...due.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!first) break;
      due.delete(first[0]);
      now = first[1].at;
      first[1].run();
    }
    now = until;
    await settle();
  };
  return { timers, settle, until, advance };
}

/**
 * A C++ game in memory that never says `ready`: it writes `lines` to stderr, then ends with `ends`
 * when the row calls `end`, or when it is killed.
 */
function silentGame(lines: readonly string[]) {
  const stderr = new PassThrough();
  let reap: (exit: { code: number | null; signal: NodeJS.Signals | null }) => void = () => {};
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
    reap = done;
  });
  const child: GameChild = {
    pid: 777_777,
    fd3: Duplex.from({ readable: new PassThrough(), writable: new PassThrough() }),
    stdout: new PassThrough(),
    stderr,
    exited,
    kill: (signal) => {
      if (signal === "SIGKILL") setImmediate(() => reap({ code: null, signal }));
    },
  };
  return {
    child,
    say: () => stderr.write(lines.map((line) => `${line}\n`).join("")),
    end: (exit: { code: number | null; signal: NodeJS.Signals | null }) => reap(exit),
  };
}

/**
 * The real registry and the real port under the native registrar, over a library of one game,
 * `pong-mac`. `prepare` waits for the row (`build`); `spawn` hands over the row's game. What the
 * registry announced is replayed into the renderer's native store, in order, before Play's answer.
 */
async function registryIpc(options: { build?: Promise<void>; game?: ReturnType<typeof silentGame> } = {}) {
  const root = await tmpDir("studio-main-ipc-native-registry-");
  const clock = manualClock();
  const announced: Array<{ status: NativeRunStatus } | { log: NativeLogBatch }> = [];
  const runs = new NativeRuns({
    root,
    timers: clock.timers,
    prepare: async (request, signal): Promise<PreparedRun> => {
      await options.build;
      signal.throwIfAborted();
      const runDir = path.join(root, request.runId);
      await mkdir(path.join(runDir, "state"), { recursive: true });
      return {
        runId: request.runId,
        runDir,
        exe: "pong",
        bundle: runDir,
        state: path.join(runDir, "state"),
        bundleId: "pong",
      };
    },
    spawn: async () => {
      if (!options.game) throw new Error("this row spawns no game");
      return options.game.child;
    },
    connect: (child, io) => new NativeGamePort({ ...io, child, encodeJpeg: async () => Buffer.alloc(0) }),
    emit: (event) => {
      if (event.type === UiEvent.NativeStatus) announced.push({ status: event.payload });
      if (event.type === UiEvent.NativeLog) announced.push({ log: event.payload });
    },
    sampleFootprint: async () => 1,
    descendants: async () => [],
    startedAt: async () => null,
    signal: () => {},
    log: () => {},
  });
  const core = {
    nativeRuns: runs,
    games: { list: async () => [{ name: "pong-mac", dir: root }] },
    assertProjectAllowed: async () => {},
  } as unknown as Parameters<typeof registerNativeIpc>[1];
  const { handle, invoke } = registrar();
  registerNativeIpc(handle, core, { now: clock.timers.now });
  /** The card's store after everything announced so far, then `answer` as Play's answer. */
  const card = (answer: NativeRunStatus | null) => {
    let state = nativeWatched(initialNative(), "pong-mac");
    for (const item of announced)
      state = "status" in item ? nativeStatusReceived(state, item.status) : nativeLogReceived(state, item.log);
    if (answer) state = nativeStatusReceived(state, answer);
    return nativeOf(state, "pong-mac");
  };
  return { runs, invoke, clock, announced, card };
}

describe("Play on Mac through the real registry: the card keeps how the run ended", () => {
  it("a game that crashes before it is ready: the answer is its run's, the card keeps Crashed and its stderr", async () => {
    const game = silentGame(["INFO: Initializing raylib 6.0", "Segmentation fault in InitWindow"]);
    const { runs, invoke, clock, card } = await registryIpc({ game });
    const replying = invoke("studio:native.run", { project: "pong-mac" });
    await clock.until(() => runs.portOf("pong-mac") !== null);
    game.say();
    await clock.settle();
    game.end({ code: null, signal: "SIGSEGV" });
    const reply = await replying;
    assert.ok(reply.ok, JSON.stringify(reply));
    const answer = reply.value as NativeRunStatus;
    const shown = card(answer);
    assert.equal(answer.runId, shown.status?.runId, "the answer is about the run the registry started");
    assert.deepEqual(
      [shown.status?.state, shown.status?.exit, shown.status?.refusal],
      [NativeRunState.Crashed, { code: null, signal: "SIGSEGV" }, null],
    );
    assert.deepEqual(shown.log, ["INFO: Initializing raylib 6.0", "Segmentation fault in InitWindow"]);
  });

  it("a start that already ended answers the run's own last status, exactly as it was announced", async () => {
    const game = silentGame(["Segmentation fault in InitWindow"]);
    const { runs, invoke, clock, announced } = await registryIpc({ game });
    const replying = invoke("studio:native.run", { project: "pong-mac" });
    await clock.until(() => runs.portOf("pong-mac") !== null);
    game.end({ code: 1, signal: null });
    const reply = await replying;
    assert.ok(reply.ok, JSON.stringify(reply));
    const last = announced.filter((item) => "status" in item).at(-1);
    assert.ok(last && "status" in last);
    assert.deepEqual(reply.value, last.status);
    assert.equal(last.status.state, NativeRunState.Crashed);
  });

  it("a game that never says ready is ended for it, and the card says so", async () => {
    const game = silentGame(["INFO: Initializing raylib 6.0"]);
    const { runs, invoke, clock, card } = await registryIpc({ game });
    const replying = invoke("studio:native.run", { project: "pong-mac" });
    await clock.until(() => runs.portOf("pong-mac") !== null);
    game.say();
    await clock.advance(NATIVE_READY_TIMEOUT_MS);
    const reply = await replying;
    assert.ok(reply.ok, JSON.stringify(reply));
    const shown = card(reply.value as NativeRunStatus);
    assert.deepEqual(
      [shown.status?.state, shown.status?.refusal, shown.status?.exit],
      [NativeRunState.Killed, NativeRefusal.ReadyTimeout, { code: null, signal: "SIGKILL" }],
    );
    assert.deepEqual(shown.log, ["INFO: Initializing raylib 6.0"]);
  });

  it("Stop while the Mac build runs: the answer is no error, and the card says Stopped", async () => {
    let finishBuild: () => void = () => {};
    const build = new Promise<void>((done) => {
      finishBuild = done;
    });
    const { runs, invoke, clock, announced, card } = await registryIpc({ build });
    const replying = invoke("studio:native.run", { project: "pong-mac" });
    await clock.until(() => runs.state("pong-mac") !== null);
    const building = announced.find((item) => "status" in item);
    assert.ok(building && "status" in building && building.status.state === NativeRunState.Building);
    const stopped = invoke("studio:native.stop", { project: "pong-mac" });
    finishBuild();
    assert.deepEqual(await stopped, { ok: true, value: true });
    const reply = await replying;
    assert.ok(reply.ok, `Stop is not an error: ${JSON.stringify(reply)}`);
    const answer = reply.value as NativeRunStatus;
    assert.deepEqual([answer.state, answer.runId], [NativeRunState.Stopped, building.status.runId]);
    assert.equal(card(answer).status?.state, NativeRunState.Stopped);
    assert.equal(runs.state("pong-mac"), null);
  });
});

describe("the native-game fixture's scripted registry", () => {
  /** The registry the fixture profile stands in, over the IPC a fixture profile registers, with what it announced. */
  async function fixtureRegistry() {
    const factory = fixtureNativeRuns(FixtureName.NativeGame);
    assert.ok(factory, "the native-game fixture stands a registry in");
    const emitted: UiEvent[] = [];
    let clock = Date.parse("2026-10-01T06:00:00.000Z");
    const timers: NativeTimers = {
      now: () => clock,
      setTimeout: () => null,
      clearTimeout: () => {},
    };
    const options = { root: "/nowhere", emit: (event: UiEvent) => emitted.push(event), timers };
    const registry = factory(options as unknown as Parameters<typeof factory>[0]);
    const root = await tmpDir("studio-main-ipc-native-fixture-");
    const games = FIXTURE_CPP_GAMES.map((game) => ({ name: game.name, dir: path.join(root, game.name) }));
    const core = {
      nativeRuns: registry,
      games: { list: async () => games },
      assertProjectAllowed: async () => {},
    } as unknown as Parameters<typeof registerNativeIpc>[1];
    const listeners = new Map<string, Listener>();
    const handle = createIpcHandle(
      { handle: (channel, listener) => void listeners.set(channel, listener) },
      { fixture: true, isStudioUi: () => true },
    );
    registerNativeIpc(handle, core);
    const invoke = (channel: string, payload?: unknown) => {
      const listener = listeners.get(channel);
      assert.ok(listener, channel);
      return listener(studio, payload);
    };
    const tick = (ms: number) => {
      clock += ms;
    };
    return { registry, invoke, emitted, tick };
  }

  it("is only the native-game fixture's", () => {
    assert.equal(fixtureNativeRuns(FixtureName.CppGame), undefined);
    assert.equal(fixtureNativeRuns(undefined), undefined);
  });

  it("pong-mac's window already runs; pong-cpp has none; no process, no port", async () => {
    const { registry, invoke } = await fixtureRegistry();
    const reply = await invoke("studio:native.state", { project: "pong-mac" });
    assert.ok(reply.ok, JSON.stringify(reply));
    const running = reply.value as NativeRunStatus;
    assert.deepEqual(
      [running.project, running.state, running.mode, running.target, running.owner],
      ["pong-mac", NativeRunState.Ready, NativeRunMode.Window, BuildTarget.Mac, null],
    );
    assert.deepEqual(await invoke("studio:native.state", { project: "pong-cpp" }), { ok: true, value: null });
    assert.equal(registry.portOf("pong-mac"), null);
    assert.equal(await registry.sweepOrphans(), 0);
  });

  it("Stop ends the window and announces it as the real registry does: stopping, then stopped", async () => {
    const { invoke, emitted, tick } = await fixtureRegistry();
    tick(1000);
    assert.deepEqual(await invoke("studio:native.stop", { project: "pong-mac" }), { ok: true, value: true });
    const states = emitted
      .filter((event) => event.type === UiEvent.NativeStatus)
      .map((event) => (event.payload as NativeRunStatus).state);
    assert.deepEqual(states.slice(-2), [NativeRunState.Stopping, NativeRunState.Stopped]);
    const stopped = emitted.at(-1)?.payload as NativeRunStatus;
    assert.deepEqual(
      [stopped.pid, stopped.exit, stopped.endedAt],
      [null, { code: 0, signal: null }, "2026-10-01T06:00:01.000Z"],
    );
    assert.deepEqual(await invoke("studio:native.state", { project: "pong-mac" }), { ok: true, value: null });
    assert.deepEqual(await invoke("studio:native.stop", { project: "pong-mac" }), { ok: true, value: false });
  });

  it("embeds a game in Live, scripted: a ready embedded run, and its size, input, resizes and sight said in its log", async () => {
    const { invoke, emitted, registry } = await fixtureRegistry();
    const reply = await invoke("studio:native.embed", { project: "pong-cpp", size: EMBED_SIZE });
    assert.ok(reply.ok, JSON.stringify(reply));
    const status = reply.value as NativeRunStatus;
    assert.deepEqual(
      [status.project, status.mode, status.state, status.target],
      ["pong-cpp", NativeRunMode.Embedded, NativeRunState.Ready, BuildTarget.Mac],
    );
    assert.equal(registry.state("pong-cpp", NativeRunMode.Embedded)?.runId, status.runId);
    const input = { project: "pong-cpp", actions: [{ type: "tap", keys: ["Space"] }] };
    assert.deepEqual(await invoke("studio:native.input", input), { ok: true, value: true });
    assert.deepEqual(await invoke("studio:native.resize", { project: "pong-cpp", size: EMBED_SIZE }), {
      ok: true,
      value: true,
    });
    registry.showEmbedded("pong-cpp", false);
    registry.showEmbedded("pong-cpp", true);
    const said = emitted
      .filter((event) => event.type === UiEvent.NativeLog)
      .flatMap((event) => (event.payload as NativeLogBatch).lines);
    assert.deepEqual(said, ["embed: 1280x720 @2", "input: tap", "resize: 1280x720 @2", "hidden", "shown"]);
    assert.deepEqual(await invoke("studio:native.unembed", { project: "pong-cpp" }), { ok: true, value: true });
    assert.equal(registry.state("pong-cpp", NativeRunMode.Embedded), null);
    assert.deepEqual(await invoke("studio:native.input", input), { ok: true, value: false }, "no run takes input");
    assert.deepEqual(await invoke("studio:native.resize", { project: "pong-cpp", size: EMBED_SIZE }), {
      ok: true,
      value: false,
    });
  });

  it("Play on Mac and Bring to front stay refused in the fixture profile, and nothing starts", async () => {
    const { registry, invoke, emitted } = await fixtureRegistry();
    const before = emitted.length;
    for (const channel of ["studio:native.run", "studio:native.front"]) {
      const reply = await invoke(channel, { project: "pong-mac" });
      assert.equal(reply.ok, false, channel);
    }
    assert.equal(emitted.length, before, "nothing changed");
    await assert.rejects(registry.start({ project: "pong-cpp", target: BuildTarget.Mac, mode: NativeRunMode.Window }));
    assert.equal(registry.state("pong-cpp"), null, "the fixture starts no game");
  });
});

it("storage is measured and freed for one game named as one, or for every game", async () => {
  const calls: string[] = [];
  const space = { bytes: { copies: 3, pictures: 2, history: 1 } };
  const freed = { freedBytes: 6, skipped: [] };
  const core = {
    storageSpace: async (project?: string) => {
      calls.push(`space ${project ?? "every game"}`);
      return space;
    },
    freeStorage: async (project?: string) => {
      calls.push(`free ${project ?? "every game"}`);
      return freed;
    },
  };
  const { handle, invoke } = registrar();
  registerStorageIpc(handle, { core });
  for (const payload of [{ project: 1 }, { project: null }, { project: "../x" }, { project: "" }, { project: "A b" }])
    for (const channel of ["studio:storage", "studio:storage.free"])
      assert.equal((await invoke(channel, payload)).ok, false, `${channel} ${JSON.stringify(payload)}`);
  assert.deepEqual(calls, [], "nothing was asked of the core");
  assert.deepEqual(await invoke("studio:storage", { project: "pond" }), { ok: true, value: space });
  assert.deepEqual(await invoke("studio:storage.free", { project: "pond" }), { ok: true, value: freed });
  assert.deepEqual(await invoke("studio:storage", {}), { ok: true, value: space });
  assert.deepEqual(await invoke("studio:storage.free", undefined), { ok: true, value: freed });
  assert.deepEqual(calls, ["space pond", "free pond", "space every game", "free every game"]);
});

/** The jobs registrar over a core that records each Stop and an `openExternal` that records each URL. */
function jobsRig() {
  const stops: string[] = [];
  const opened: string[] = [];
  const core = {
    stopJob: async (project: string, jobId: string) => {
      stops.push(`${project} ${jobId}`);
      return null;
    },
  };
  const { handle, invoke } = registrar();
  registerJobsIpc(handle, {
    core,
    openExternal: async (url: string) => {
      opened.push(url);
    },
  });
  return { stops, opened, invoke };
}

it("opening Privacy settings opens only the two panes it knows", async () => {
  const { opened, invoke } = jobsRig();
  for (const payload of [undefined, null, {}, { pane: "x" }, { pane: "" }, { pane: "screen?evil" }, { pane: {} }])
    assert.equal((await invoke("studio:app-look.open-settings", payload)).ok, false, JSON.stringify(payload));
  assert.deepEqual(opened, [], "nothing was opened");
  assert.deepEqual(await invoke("studio:app-look.open-settings", { pane: "screen" }), { ok: true, value: true });
  assert.deepEqual(await invoke("studio:app-look.open-settings", { pane: "accessibility" }), { ok: true, value: true });
  assert.deepEqual(opened, [
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  ]);
});

it("a job's Stop reaches the core only with a game and a job named as text", async () => {
  const { stops, invoke } = jobsRig();
  for (const payload of [undefined, null, {}, { project: "pond" }, { jobId: "j" }, { project: 1, jobId: "j" }])
    assert.equal((await invoke("studio:jobs.stop", payload)).ok, false, JSON.stringify(payload));
  assert.deepEqual(stops, [], "nothing was asked of the core");
  assert.deepEqual(await invoke("studio:jobs.stop", { project: "pond", jobId: "j" }), { ok: true, value: null });
  assert.deepEqual(stops, ["pond j"]);
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
    openRouterLogin: noSignIn,
  });
  assert.deepEqual(await invoke("studio:models.refresh", { provider: "opencode" }), { ok: true, value: true });
  assert.deepEqual(await invoke("studio:engines.recheck", { engine: "openrouter" }), { ok: true, value: true });
  assert.deepEqual(refreshed, ["opencode true", "openrouter true"]);
  assert.deepEqual(events, [{ type: "engines.changed", payload: {} }]);
});

/** A browser sign-in that is never started: the registrars under test do not reach it. */
const noSignIn: ModelsIpcDeps["openRouterLogin"] = {
  start: async () => {
    throw new Error("no browser sign-in in this test");
  },
  reopen: async () => false,
  cancel: () => false,
};

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
      openRouterLogin: noSignIn,
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

it("the browser sign-in hands its key to the engine, and only how it ended comes back", async () => {
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
    const calls: string[] = [];
    // The browser sign-in itself is `openrouter-login.test.ts`; here it returns with this key at once.
    const returning = (key: string): ModelsIpcDeps["openRouterLogin"] => ({
      start: async (saveKey) => {
        calls.push("start");
        const status = await saveKey(key);
        return status.code === "ready" ? { outcome: "connected" } : { outcome: "failed", error: status.detail };
      },
      reopen: async () => {
        calls.push("reopen");
        return true;
      },
      cancel: () => {
        calls.push("cancel");
        return true;
      },
    });
    const { handle, invoke } = registrar();
    let login = returning("sk-or-v1-refused-refused-refused");
    registerModelsIpc(handle, {
      core: { engines },
      subscription: () => null,
      pushUiEvent: (event) => events.push(event),
      openRouterLogin: {
        start: (saveKey) => login.start(saveKey),
        reopen: () => login.reopen(),
        cancel: () => login.cancel(),
      },
    });
    const refused = await invoke("studio:openrouter.signin");
    assert.equal(refused.ok && (refused.value as { outcome?: string }).outcome, "failed");
    assert.equal(await keys.read(), null, "a key OpenRouter refuses is not kept");
    login = returning(GOOD_KEY);
    const connected = await invoke("studio:openrouter.signin");
    assert.deepEqual(connected, { ok: true, value: { outcome: "connected" } });
    assert.equal(await keys.read(), GOOD_KEY);
    assert.deepEqual(await invoke("studio:openrouter.signin.reopen"), { ok: true, value: true });
    assert.deepEqual(await invoke("studio:openrouter.signin.cancel"), { ok: true, value: true });
    assert.deepEqual(calls, ["start", "start", "reopen", "cancel"]);
    assert.deepEqual(
      events.map((event) => event.type),
      ["engines.changed", "engines.changed"],
      "each sign-in that ends says the engines changed",
    );
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
  registerModelsIpc(handle, {
    core,
    subscription: () => null,
    pushUiEvent: (event) => events.push(event),
    openRouterLogin: noSignIn,
  });
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

describe("Play's share menu", () => {
  /** Play's channels with only Share… and game links live: every menu it pops is kept. */
  function shareRig(web: string, links = gameLinks(), here: NativeHost | null = null) {
    const { handle, invoke } = registrar();
    const shared: Array<[string, unknown]> = [];
    const unused = {} as unknown;
    registerPlayIpc(handle, {
      gallery: unused as PlayIpcDeps["gallery"],
      gameLinks: links,
      remix: async () => "",
      remixReady: async () => ({}),
      viewer: () => null,
      installs: () => null,
      here: () => here,
      sessions: () => null,
      reveal: () => {},
      people: unused as PlayIpcDeps["people"],
      creators: unused as PlayIpcDeps["creators"],
      credits: unused as PlayIpcDeps["credits"],
      manage: unused as PlayIpcDeps["manage"],
      web,
      share: (url, at) => shared.push([url, at]),
    });
    return { invoke, shared };
  }

  it("hands the page the game a genex:// link asked for, once", async () => {
    const links = gameLinks();
    const { invoke } = shareRig("https://genex.games", links);
    assert.deepEqual(await invoke("studio:play.take-game-link"), { ok: true, value: null });
    links.arrive("genex://game/iron-tide");
    assert.deepEqual(await invoke("studio:play.take-game-link"), { ok: true, value: "iron-tide" });
    assert.deepEqual(await invoke("studio:play.take-game-link"), { ok: true, value: null });
  });

  it("names this computer even where Genex installs no native game, so a page can say why", async () => {
    const windows: NativeHost = { platform: NativePlatform.Windows, arch: NativeArch.X64, osVersion: "10.0.26100" };
    const { invoke } = shareRig("https://genex.games", gameLinks(), windows);
    assert.deepEqual(await invoke("studio:play.installs"), {
      ok: true,
      value: { installed: [], progress: [], host: windows },
    });
  });

  it("pops for a page of the website Play links to, by the button that asked", async () => {
    const { invoke, shared } = shareRig("https://genex.games");
    const answer = await invoke("studio:play.share", {
      url: "https://genex.games/@rabneba/invite",
      at: { x: 10, y: 20 },
    });
    assert.equal(answer.ok, true);
    assert.deepEqual(shared, [["https://genex.games/@rabneba/invite", { x: 10, y: 20 }]]);
  });

  it("never pops for anything else", async () => {
    const { invoke, shared } = shareRig("http://localhost:5173");
    for (const url of [
      "https://genex.games/@rabneba",
      "http://localhost:5174/@rabneba",
      "http://user@localhost:5173/@rabneba",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "",
      7,
    ]) {
      const answer = await invoke("studio:play.share", { url });
      assert.equal(answer.ok, false, String(url));
    }
    assert.deepEqual(shared, []);
    await invoke("studio:play.share", { url: "http://localhost:5173/@rab", at: { x: -1, y: "top" } });
    assert.deepEqual(shared, [["http://localhost:5173/@rab", undefined]], "a point off the window is no point");
  });
});
