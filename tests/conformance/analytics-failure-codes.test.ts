/**
 * Usage analytics, phase 2 (plan §5 P1–P3): a failure says why with a typed code. A refusal main
 * names crosses IPC as its code (`IpcResult.code`), each provider's sign-in, install and download
 * says why it failed, and a chat's sends, turns, plans and compactions say how. Every code is a
 * value of one of the app's vocabularies: words, a path, a Node code or an id never reach a property.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn, type SpawnOptions } from "node:child_process";
import { describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createCliInstalls } from "../../src/main/cli-install.ts";
import { ClaudeLoginController } from "../../src/main/claude-login.ts";
import { CodexLoginController } from "../../src/main/codex-login.ts";
import { createIpcHandle, type IpcResult, type IpcSender } from "../../src/main/ipc-handle.ts";
import { createOpenRouterLogin } from "../../src/main/openrouter-login.ts";
import { PlanReviewController } from "../../src/main/plan-review.ts";
import { createStudioBridge } from "../../src/preload/studio-bridge.ts";
import { ClaudeLoginProblem, ClaudeLoginRefusal, type ClaudeLoginState } from "../../src/shared/claude-login.ts";
import { CliInstallOperation, CliInstallRefusal } from "../../src/shared/cli-install.ts";
import { CodexLoginProblem } from "../../src/shared/codex-login.ts";
import { type PlanReview, PlanReviewState, SendFailure, SendRefusal } from "../../src/shared/composer.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import {
  type EngineDescriptor,
  EngineKind,
  EngineStatusCode,
  EngineStatusReason,
} from "../../src/shared/engine-descriptor.ts";
import { EngineFailureKind, turnFailure } from "../../src/shared/engine-requests.ts";
import { studioErrorVocabularies } from "../../src/shared/error-codes.ts";
import { CodedError, errorCode, errorCodeIn } from "../../src/shared/errors.ts";
import { type EventData, type EventEnvelope, EventKind } from "../../src/shared/event-log.ts";
import {
  InstallPhase,
  type ModelInstallJob,
  ModelInstallProblem,
  ModelPullProblem,
} from "../../src/shared/model-install.ts";
import { OpenRouterSignInOutcome, OpenRouterSignInProblem } from "../../src/shared/openrouter-login.ts";
import { ModeSwitchFailure } from "../../src/shared/permissions.ts";
import { EngineId } from "../../src/shared/providers.ts";
import { UiEvent } from "../../src/shared/ui-events.ts";
import { installProblem } from "../../src/substrate/bonsai/runtime.ts";
import { EngineError } from "../../src/substrate/engines/types.ts";
import { createChatMemory } from "../../src/renderer/analytics/chat-memory.ts";
import { chatObservers, retryAfterBucket, type SendEvent } from "../../src/renderer/analytics/chat-observe.ts";
import { RetryAfterBucket, SendFailStage, TurnStatus } from "../../src/renderer/analytics/chat-vocabulary.ts";
import { ChatEvent } from "../../src/renderer/analytics/events/chat.ts";
import { errorToastsShown } from "../../src/renderer/analytics/events/launch.ts";
import type { EventProperties } from "../../src/renderer/analytics/properties.ts";
import {
  cliInstallRefused,
  createProviderMemory,
  createStreamPairing,
  downloadFinished,
  downloadJobSeen,
  downloadPullSeen,
  downloadStarted,
  engineChanges,
  loginSeen,
  signInHelperUsed,
  signInSettled,
} from "../../src/renderer/analytics/welcome-providers.ts";
import {
  DownloadOutcome,
  DownloadSource,
  ProviderSurface,
  SignInHelper,
  SignInOutcome,
} from "../../src/renderer/analytics/welcome-vocabulary.ts";
import { createToastsStore, notifyProblem, ToastTone } from "../../src/renderer/state/toasts.ts";
import { assertClean, HOSTILE, HOSTILE_THREAD, HOSTILE_THROWS } from "../helpers/failure-codes.ts";
import { tmpDir } from "../helpers/tmp.ts";

const T0 = Date.parse("2026-10-27T10:00:00.000Z");
const THREAD = HOSTILE_THREAD;

describe("phase 2 analytics: a failure's code crosses IPC", () => {
  it("errorCode reads a coded failure's code and nothing else", () => {
    assert.equal(errorCode(new CodedError(CliInstallRefusal.Busy, "Wait for active work")), CliInstallRefusal.Busy);
    assert.equal(
      errorCode(Object.assign(new Error("cannot switch"), { code: ModeSwitchFailure.AutoUnavailable })),
      ModeSwitchFailure.AutoUnavailable,
      "an error that already carries a vocabulary's code needs no new class",
    );
    for (const [label, thrown] of HOSTILE_THROWS) assert.equal(errorCode(thrown), null, label);
    const codes = studioErrorVocabularies().flatMap((vocabulary) => Object.values(vocabulary));
    assert.equal(new Set(codes).size, codes.length, "no two vocabularies share a code, so a code alone says which");
    const rewinding = new CodedError(SendFailure.Rewinding, "Wait for the rewind");
    assert.equal(errorCodeIn(SendFailure, rewinding), SendFailure.Rewinding);
    assert.equal(errorCodeIn(CliInstallRefusal, rewinding), null, "a code of another vocabulary is not this one's");
  });

  it("main answers a coded failure with its code, and any other failure without one", async () => {
    const listeners = new Map<string, (event: IpcSender, payload: unknown) => Promise<IpcResult>>();
    const handle = createIpcHandle(
      { handle: (channel, listener) => listeners.set(channel, listener) },
      { fixture: false, isStudioUi: () => true },
    );
    let thrown: unknown = null;
    handle("studio:cli-install.start", () => {
      throw thrown;
    });
    const invoke = listeners.get("studio:cli-install.start");
    assert.ok(invoke);
    const sender = { sender: "studio", senderFrame: "main-frame" };
    thrown = new CodedError(CliInstallRefusal.Busy, "Wait for active work to finish before updating.");
    assert.deepEqual(await invoke(sender, { provider: EngineId.Codex }), {
      ok: false,
      error: "Wait for active work to finish before updating.",
      code: CliInstallRefusal.Busy,
    });
    for (const [label, hostile] of HOSTILE_THROWS) {
      thrown = hostile;
      const result = await invoke(sender, { provider: EngineId.Codex });
      assert.equal(result.ok, false, label);
      assert.ok(!("code" in result), `${label} crosses with no code`);
    }
  });

  it("the preload rejects with the code main sent, and drops any value that is not a code", async () => {
    let answer: unknown = null;
    const bridge = createStudioBridge({ invoke: async () => answer, on: () => undefined, off: () => undefined });
    answer = { ok: false, error: "Wait for active work to finish before updating.", code: CliInstallRefusal.Busy };
    await assert.rejects(bridge.cliInstall(EngineId.Codex), (err: unknown) => {
      assert.ok(err instanceof CodedError);
      assert.equal(errorCode(err), CliInstallRefusal.Busy);
      assert.equal(err.message, "Wait for active work to finish before updating.");
      return true;
    });
    for (const code of ["/Users/alice/Secret Game", "ENOENT", "Your usage limit resets at 5pm", 7, null]) {
      answer = { ok: false, error: "failed", code };
      await assert.rejects(bridge.cliInstall(EngineId.Codex), (err: unknown) => {
        assert.equal(errorCode(err), null, String(code));
        assert.ok(!(err instanceof CodedError), `${String(code)} is no code`);
        return true;
      });
    }
  });

  it("an error toast keeps its failure's code, and error_toast_shown counts it by code and screen", () => {
    const toasts = createToastsStore(() => undefined);
    const before = toasts.getState();
    notifyProblem(toasts.notify)(new CodedError(SendFailure.HarnessNotRunning, "harness is not running"));
    toasts.notify("Saved", ToastTone.Ok);
    notifyProblem(toasts.notify)(new Error("ENOENT: /Users/alice/Secret Game"));
    assert.equal(toasts.getState().items[0]?.code, SendFailure.HarnessNotRunning);
    assert.deepEqual(errorToastsShown(before, toasts.getState(), "/game/chat"), [
      { code: SendFailure.HarnessNotRunning, screen: "/game/chat" },
      { code: null, screen: "/game/chat" },
    ]);
    // A toast whose code was never one of the app's (a later caller passing words) still counts, with none.
    const forged = JSON.parse(
      '{"items":[{"id":9,"text":"x","tone":"err","code":"/Users/alice/Secret Game"}],"lastId":9}',
    );
    const shown = errorToastsShown({ lastId: 8 }, forged, "/home");
    assert.deepEqual(shown, [{ code: null, screen: "/home" }]);
  });
});

describe("phase 2 analytics: providers say why", () => {
  it("a CLI install refused before it starts says which refusal", () => {
    const installs = createCliInstalls({
      install: async () => ({ ok: true }),
      update: async () => ({ ok: true }),
      busy: () => true,
      found: async () => true,
      pushUiEvent: () => undefined,
      log: () => undefined,
    });
    assert.throws(
      () => installs.start("/Users/alice/bin/claude"),
      (err: unknown) => errorCode(err) === CliInstallRefusal.UnknownProvider,
    );
    assert.throws(
      () => installs.start(EngineId.Codex, CliInstallOperation.Update),
      (err: unknown) => errorCode(err) === CliInstallRefusal.Busy,
    );
    const memory = createProviderMemory();
    const refused = (error: unknown) =>
      cliInstallRefused(memory, { provider: EngineId.Codex, operation: CliInstallOperation.Update, error }, T0);
    assert.equal(refused(new CodedError(CliInstallRefusal.Busy, "Wait")).code, CliInstallRefusal.Busy);
    assert.equal(
      refused(new CodedError(SendFailure.Other, "x")).code,
      null,
      "another vocabulary's code is not a refusal",
    );
    for (const [label, thrown] of HOSTILE_THROWS) {
      assert.equal(refused(thrown).code, null, label);
      assertClean(label, refused(thrown));
    }
  });

  it("a Claude sign-in names its failure, and refuses a request from its card with a code", async () => {
    const failedWith = async (deps: Partial<ConstructorParameters<typeof ClaudeLoginController>[0]>) => {
      const controller = new ClaudeLoginController({
        findBinary: async () => "/bundled/claude",
        openExternal: async () => undefined,
        onState: () => undefined,
        onConnected: async () => undefined,
        graceMs: 5_000,
        ...deps,
      });
      await controller.start(null);
      return controller;
    };
    const quietCli = ((_file: string, _args: string[], options: SpawnOptions): ChildProcess =>
      spawn(process.execPath, ["-e", "process.exit(0)"], options)) as typeof spawn;

    assert.equal(
      (await failedWith({ findBinary: async () => null })).snapshot().problem,
      ClaudeLoginProblem.MissingCli,
    );
    const unresolved = await failedWith({
      resolveCli: async () => {
        throw new Error("EACCES: permission denied, open '/Users/alice/.claude.json'");
      },
    });
    assert.equal(unresolved.snapshot().problem, ClaudeLoginProblem.CliUnresolved);
    // A CLI that says nothing on a pipe is handed to the embedded terminal: none to hand it to,
    // one that cannot open, the CLI failing in it, or the CLI gone by then.
    const handedOver: ReadonlyArray<[string, Partial<ConstructorParameters<typeof ClaudeLoginController>[0]>, string]> =
      [
        ["no terminal", {}, ClaudeLoginProblem.TerminalFailed],
        [
          "a terminal that cannot open",
          {
            terminal: async () => {
              throw new Error("pty");
            },
          },
          ClaudeLoginProblem.TerminalFailed,
        ],
        [
          "the CLI failing there",
          { terminal: async () => ({ started: false, error: "x" }) },
          ClaudeLoginProblem.CliFailed,
        ],
        [
          "the CLI gone",
          { terminal: async () => ({ started: false, missingCli: true, error: "x" }) },
          ClaudeLoginProblem.MissingCli,
        ],
      ];
    for (const [label, deps, problem] of handedOver) {
      const controller = await failedWith({ spawn: quietCli, ...deps });
      assert.equal(controller.snapshot().phase, "failed", label);
      assert.equal(controller.snapshot().problem, problem, label);
    }

    const idle = await failedWith({ findBinary: async () => null });
    await assert.rejects(
      idle.submitCode("abcdef123"),
      (err: unknown) => errorCode(err) === ClaudeLoginRefusal.NoCodeWaiting,
    );
    await assert.rejects(idle.openBrowser(), (err: unknown) => errorCode(err) === ClaudeLoginRefusal.NoLink);
  });

  it("a Codex sign-in names its failure", async () => {
    const home = await tmpDir("analytics-codex-");
    const exiting = (code: number) =>
      ((_file: string, _args: string[], options: SpawnOptions): ChildProcess =>
        spawn(process.execPath, ["-e", `process.exit(${code})`], options)) as typeof spawn;
    const failedWith = async (deps: Partial<ConstructorParameters<typeof CodexLoginController>[0]>) => {
      const controller = new CodexLoginController({
        findBinary: async () => "/bundled/codex",
        openExternal: async () => undefined,
        onState: () => undefined,
        onConnected: async () => undefined,
        ...deps,
      });
      await controller.start(home);
      for (let tries = 0; controller.snapshot().phase !== "failed"; tries++) {
        assert.ok(tries < 500, "the sign-in fails");
        await delay(10);
      }
      return controller.snapshot().problem;
    };
    const status = (method: "chatgpt" | "api_key" | undefined, loggedIn: boolean) => async () => ({
      loggedIn,
      ...(method ? { method } : {}),
      detail: "Logged in using an API key - /Users/alice/.codex",
    });
    assert.equal(await failedWith({ findBinary: async () => null }), CodexLoginProblem.MissingCli);
    assert.equal(await failedWith({ spawn: exiting(1) }), CodexLoginProblem.NotFinished);
    assert.equal(
      await failedWith({ spawn: exiting(0), probe: status("api_key", true) }),
      CodexLoginProblem.ApiKeyLogin,
    );
    assert.equal(
      await failedWith({ spawn: exiting(0), probe: status(undefined, false) }),
      CodexLoginProblem.NotVerified,
    );
  });

  it("an OpenRouter browser sign-in names its failure", async () => {
    const saveKey = async () => ({ code: EngineStatusCode.Ready, detail: "saved" });
    const noBrowser = createOpenRouterLogin({
      openExternal: async () => {
        throw new Error("no browser");
      },
    });
    assert.deepEqual(await noBrowser.start(saveKey), {
      outcome: OpenRouterSignInOutcome.Failed,
      error: "Couldn't open your browser. Paste a key instead.",
      problem: OpenRouterSignInProblem.NoBrowser,
    });
    const slow = createOpenRouterLogin({ openExternal: async () => undefined, timeoutMs: 20 });
    const expired = await slow.start(saveKey);
    assert.equal(
      expired.outcome === OpenRouterSignInOutcome.Failed && expired.problem,
      OpenRouterSignInProblem.Expired,
    );

    // The browser comes back: declined, or with a code whose key OpenRouter does not accept.
    const answered = async (query: (state: string) => string, refused: boolean) => {
      let page = "";
      const login = createOpenRouterLogin({
        openExternal: async (url) => {
          page = String(url);
        },
        fetch: async () => new Response(JSON.stringify({ key: "sk-or-v1-0123456789abcdef" })),
      });
      const ended = login.start(async () =>
        refused
          ? { code: EngineStatusCode.NeedsLogin, detail: "OpenRouter did not accept the saved API key." }
          : { code: EngineStatusCode.Ready, detail: "saved" },
      );
      for (let tries = 0; !page; tries++) {
        assert.ok(tries < 200, "the page opens");
        await delay(5);
      }
      const auth = new URL(page);
      const callback = new URL(String(auth.searchParams.get("callback_url")));
      await (await fetch(`${callback.href}?${query(String(auth.searchParams.get("state")))}`)).text();
      return ended;
    };
    const declined = await answered(() => "error=access_denied", false);
    assert.equal(
      declined.outcome === OpenRouterSignInOutcome.Failed && declined.problem,
      OpenRouterSignInProblem.Denied,
    );
    const keyRefused = await answered((state) => `code=abc123&state=${state}`, true);
    assert.equal(
      keyRefused.outcome === OpenRouterSignInOutcome.Failed && keyRefused.problem,
      OpenRouterSignInProblem.KeyRefused,
    );
  });

  it("a model install that fails says why: its refusal's code, else what failing in its phase means", () => {
    const network = new Error("socket hang up while fetching /Users/alice/Library/bonsai.gguf");
    const table: ReadonlyArray<[unknown, InstallPhase | undefined, ModelInstallProblem]> = [
      [
        new CodedError(ModelInstallProblem.NeedsMemory, "Bonsai requires at least 16 GiB"),
        InstallPhase.Preflight,
        ModelInstallProblem.NeedsMemory,
      ],
      [
        new CodedError(ModelInstallProblem.NotEnoughSpace, "Not enough space"),
        InstallPhase.Preflight,
        ModelInstallProblem.NotEnoughSpace,
      ],
      [
        new CodedError(ModelInstallProblem.UnsafeArchive, "Unsafe"),
        InstallPhase.Extracting,
        ModelInstallProblem.UnsafeArchive,
      ],
      [network, InstallPhase.Downloading, ModelInstallProblem.Download],
      [network, InstallPhase.Verifying, ModelInstallProblem.Download],
      [network, InstallPhase.Extracting, ModelInstallProblem.Extract],
      [network, InstallPhase.Starting, ModelInstallProblem.Startup],
      [network, InstallPhase.Preflight, ModelInstallProblem.Other],
      [network, undefined, ModelInstallProblem.Other],
      [
        Object.assign(new Error("x"), { code: "/Users/alice/Secret Game" }),
        InstallPhase.Downloading,
        ModelInstallProblem.Download,
      ],
      [new CodedError(SendFailure.Other, "x"), InstallPhase.Starting, ModelInstallProblem.Startup],
    ];
    for (const [err, phase, problem] of table) assert.equal(installProblem(err, phase), problem, `${phase}`);
  });

  it("a sign-in's end, a refused code, an engine's status and a download carry their typed why", () => {
    const memory = createProviderMemory();
    const pairing = createStreamPairing();
    const claude = (revision: number, phase: ClaudeLoginState["phase"], problem?: unknown): ClaudeLoginState =>
      JSON.parse(JSON.stringify({ revision, phase, hasBrowserUrl: false, error: HOSTILE[0], problem }));
    loginSeen(memory, pairing, { engine: EngineId.ClaudeCode, state: claude(1, "starting") }, T0);
    const failed = loginSeen(
      memory,
      pairing,
      { engine: EngineId.ClaudeCode, state: claude(2, "failed", ClaudeLoginProblem.TimedOut) },
      T0 + 1000,
    ).finished;
    assert.equal(failed?.problem, ClaudeLoginProblem.TimedOut);
    loginSeen(memory, pairing, { engine: EngineId.ClaudeCode, state: claude(3, "starting") }, T0);
    const forged = loginSeen(
      memory,
      pairing,
      { engine: EngineId.ClaudeCode, state: claude(4, "failed", "/Users/alice/Secret Game") },
      T0,
    ).finished;
    assert.equal(forged?.problem, null, "a problem that is not one of the provider's words is none");
    assert.equal(
      signInSettled(
        memory,
        { engine: EngineId.OpenRouter, outcome: SignInOutcome.Failed, problem: OpenRouterSignInProblem.Denied },
        T0,
      ).problem,
      OpenRouterSignInProblem.Denied,
    );
    assert.equal(
      signInSettled(
        memory,
        { engine: EngineId.OpenRouter, outcome: SignInOutcome.Connected, problem: OpenRouterSignInProblem.Denied },
        T0,
      ).problem,
      null,
      "a sign-in that connected failed for no reason",
    );
    const code = signInHelperUsed(
      memory,
      {
        engine: EngineId.ClaudeCode,
        helper: SignInHelper.CodeSubmitted,
        accepted: false,
        code: ClaudeLoginRefusal.NotACode,
      },
      T0,
    );
    assert.equal(code.code, ClaudeLoginRefusal.NotACode);

    const engine = (reason: unknown): EngineDescriptor =>
      JSON.parse(
        JSON.stringify({
          id: EngineId.Codex,
          label: "Codex",
          kind: EngineKind.Delegated,
          status: { code: EngineStatusCode.NeedsLogin, detail: "Invalid API key · Please run /login", reason },
        }),
      );
    const [apiKey] = engineChanges(
      [engine(EngineStatusReason.NotSignedIn)],
      [engine(EngineStatusReason.ApiKeyLogin)],
      false,
    );
    assert.equal(apiKey?.reason, EngineStatusReason.ApiKeyLogin, "a new reason under the same status is news");
    const [forgedReason] = engineChanges([engine(EngineStatusReason.NotSignedIn)], [engine(HOSTILE[6])], false);
    assert.equal(forgedReason?.reason, null);

    const job = (model: string, overrides: Partial<ModelInstallJob>): ModelInstallJob => ({
      id: "job-1",
      model,
      phase: InstallPhase.Failed,
      completed: 1,
      total: 4,
      location: "/Users/alice/Library/Bonsai",
      updatedAt: new Date(T0).toISOString(),
      error: HOSTILE[0],
      active: false,
      ...overrides,
    });
    const start = (model: string, engineId: string) =>
      downloadStarted(
        memory,
        {
          model,
          engine: engineId,
          surface: ProviderSurface.Settings,
          source: DownloadSource.Pick,
          sizeGb: 4,
          resumed: false,
          ollama: undefined,
        },
        T0,
      );
    start("bonsai-a", EngineId.Bonsai);
    downloadJobSeen(
      memory,
      job("bonsai-a", { failedPhase: InstallPhase.Starting, problem: ModelInstallProblem.Startup }),
    );
    const bonsai = downloadFinished(memory, { model: "bonsai-a", ok: false, ollama: undefined }, T0 + 5000);
    assert.equal(bonsai?.outcome, DownloadOutcome.Failed);
    assert.equal(bonsai?.failed_phase, InstallPhase.Starting);
    assert.equal(bonsai?.problem, ModelInstallProblem.Startup);
    start("gemma4:12b", EngineId.Ollama);
    const pulled = downloadFinished(
      memory,
      {
        model: "gemma4:12b",
        ok: false,
        ollama: undefined,
        error: new CodedError(ModelPullProblem.Unavailable, "Ollama isn't running at http://10.0.0.7:11434"),
      },
      T0,
    );
    assert.equal(pulled?.problem, ModelPullProblem.Unavailable, "an Ollama pull says why by its rejection's code");
    start("bonsai-b", EngineId.Bonsai);
    downloadJobSeen(memory, JSON.parse(JSON.stringify(job("bonsai-b", { failedPhase: HOSTILE[0] as InstallPhase }))));
    downloadPullSeen(memory, {
      model: "bonsai-b",
      progress: { status: "error", error: HOSTILE[2], problem: HOSTILE[5] as ModelPullProblem },
    });
    const forgedDownload = downloadFinished(
      memory,
      { model: "bonsai-b", ok: false, ollama: undefined, error: new Error(HOSTILE[3]) },
      T0,
    );
    assert.equal(forgedDownload?.failed_phase, null);
    assert.equal(forgedDownload?.problem, null);
    for (const properties of [failed, forged, code, apiKey, forgedReason, bonsai, pulled, forgedDownload])
      if (properties) assertClean("a provider's event", properties);
  });
});

/** A log record in the test's chat. */
let serial = 0;
function record(data: EventData, at: number): EventEnvelope {
  serial += 1;
  return {
    id: `ev-${String(serial).padStart(6, "0")}`,
    thread_id: THREAD,
    session_id: null,
    turn_id: null,
    created_at: new Date(at).toISOString(),
    data,
  };
}
const custom = (event_type: string, payload: unknown, at: number): EventEnvelope =>
  record({ type: EventKind.Custom, event_type, payload }, at);

/** The chat's observers over a fresh memory, with what they send kept. */
function hearing() {
  const sent: Array<{ event: string; properties: EventProperties }> = [];
  const send: SendEvent = (event, properties) => {
    sent.push({ event, properties });
  };
  const observers = chatObservers(createChatMemory(), () => T0, send);
  return {
    sent,
    log: (event: EventEnvelope): void => observers.log?.(event),
    ui: (event: UiEvent): void => observers.ui?.(event),
    of: (event: string) => sent.filter((one) => one.event === event).map((one) => one.properties),
  };
}

describe("phase 2 analytics: a chat says how it failed", () => {
  it("a send that reached no chat fails with its typed code, and a chat error never carries words", async () => {
    // Main's send, through its real IPC handler: the rewind's refusal keeps its code, anything else is `other`.
    const { registerThreadsIpc } = await import("../../src/main/ipc/threads.ts");
    const pushed: UiEvent[] = [];
    let thrown: unknown = null;
    const listeners = new Map<string, (event: IpcSender, payload: unknown) => Promise<IpcResult>>();
    const handle = createIpcHandle(
      { handle: (channel, listener) => listeners.set(channel, listener) },
      { fixture: false, isStudioUi: () => true },
    );
    const core = {
      mainThread: "thread-main",
      sendUserMessage: async () => {
        throw thrown;
      },
    };
    const deps = {
      core,
      pushUiEvent: (event: UiEvent) => pushed.push(event),
      appendErrorDurably: async () => undefined,
      smokeReads: null,
    } as unknown as Parameters<typeof registerThreadsIpc>[1];
    registerThreadsIpc(handle, deps);
    const send = listeners.get("studio:send");
    assert.ok(send);
    const sender = { sender: "studio", senderFrame: "main-frame" };
    thrown = new CodedError(SendFailure.Rewinding, "Wait for the rewind to finish, then send it again.");
    const rewinding = await send(sender, { text: "make it rain", thread: THREAD });
    assert.equal(rewinding.ok === false && rewinding.code, SendFailure.Rewinding);
    thrown = Object.assign(new Error("ENOENT: /Users/alice/Secret Game"), { code: "ENOENT" });
    const other = await send(sender, { text: "make it rain", thread: THREAD });
    assert.equal(other.ok === false && other.code, SendFailure.Other);
    assert.deepEqual(
      pushed.map((event) => (event.type === UiEvent.ChatError ? event.payload.failure : null)),
      [SendFailure.Rewinding, SendFailure.Other],
    );

    // The renderer: a refusal main announces is counted; a failure's own event is counted where it was sent.
    const heard = hearing();
    heard.ui({
      type: UiEvent.ChatError,
      payload: { threadId: THREAD, message: HOSTILE[7], refusal: SendRefusal.LoopOutdated },
    });
    heard.ui({
      type: UiEvent.ChatError,
      payload: { threadId: THREAD, message: HOSTILE[7], failure: SendFailure.Other },
    });
    heard.ui(JSON.parse(JSON.stringify({ type: UiEvent.ChatError, payload: { message: "x", refusal: HOSTILE[0] } })));
    assert.deepEqual(heard.of(ChatEvent.MessageSendFailed), [
      { stage: SendFailStage.Refused, code: SendRefusal.LoopOutdated },
    ]);
  });

  it("a delegated turn's failure and limit reach its end, its message and its event", async () => {
    // Main notes the chat's engine failure while its turn is open; the turn's end records it once.
    const { TurnFactory } = await import("../../src/substrate/turns.ts");
    const { EventStore } = await import("../../src/substrate/event-store.ts");
    const store = await EventStore.open(await tmpDir("analytics-turns-"), "studio");
    const turns = new TurnFactory(store);
    const thread = await store.createThread();
    turns.noteFailure(thread, turnFailure(EngineFailureKind.Auth));
    await turns.beginTurn(thread);
    assert.equal(turns.takeFailure(thread), undefined, "a failure noted before the turn began is not this turn's");
    turns.noteFailure(thread, turnFailure(EngineFailureKind.UsageLimit, 3 * 60 * 60 * 1000));
    assert.deepEqual(turns.takeFailure(thread), {
      failure: EngineFailureKind.UsageLimit,
      limit: { kind: EngineFailureKind.UsageLimit, retryAfterMs: 3 * 60 * 60 * 1000 },
    });
    assert.equal(turns.takeFailure(thread), undefined, "taken once");
    assert.deepEqual(turnFailure(EngineFailureKind.Auth), { failure: EngineFailureKind.Auth });

    const heard = hearing();
    heard.log(record({ type: EventKind.TurnStarted, metadata: { engine: EngineId.ClaudeCode } }, T0));
    heard.log(
      record(
        {
          type: EventKind.TurnEnded,
          status: TurnStatus.Ok,
          metadata: {
            outcome: "engine_limited",
            ...turnFailure(EngineFailureKind.UsageLimit, 3 * 60 * 60 * 1000),
          },
        },
        T0 + 4000,
      ),
    );
    heard.log(custom(CustomEvent.CoordinatorMessageHandled, { messageId: "msg-1", failed: true }, T0 + 4100));
    const [turn] = heard.of(ChatEvent.ChatTurnEnded);
    assert.equal(turn?.failure_kind, EngineFailureKind.UsageLimit);
    assert.equal(turn?.limit_kind, EngineFailureKind.UsageLimit);
    assert.equal(turn?.retry_after_bucket, RetryAfterBucket.Day);
    assert.deepEqual(heard.of(ChatEvent.MessageAnswerFailed), [
      { engine: "none", failure_kind: EngineFailureKind.UsageLimit },
    ]);

    // Hostile metadata: words or a path where a kind or a limit goes reads as none.
    const forged = hearing();
    forged.log(record({ type: EventKind.TurnStarted, metadata: { engine: EngineId.Codex } }, T0));
    forged.log(
      record(
        {
          type: EventKind.TurnEnded,
          status: TurnStatus.Error,
          metadata: { failure: HOSTILE[5], limit: { kind: HOSTILE[0], retryAfterMs: HOSTILE[1] } },
        },
        T0 + 10,
      ),
    );
    const [clean] = forged.of(ChatEvent.ChatTurnEnded);
    assert.ok(clean);
    assert.equal(clean.failure_kind, undefined);
    assert.equal(clean.limit_kind, undefined);
    for (const { event, properties } of [...heard.sent, ...forged.sent]) assertClean(event, properties);
  });

  it("a wait is bucketed, never sent as it was said", () => {
    assert.equal(retryAfterBucket(30_000), RetryAfterBucket.Minute);
    assert.equal(retryAfterBucket(20 * 60_000), RetryAfterBucket.Hour);
    assert.equal(retryAfterBucket(5 * 60 * 60_000), RetryAfterBucket.Day);
    assert.equal(retryAfterBucket(3 * 24 * 60 * 60_000), RetryAfterBucket.Longer);
  });

  it("a plan that could not be written keeps its failure kind, and plan_review_changed says it", async () => {
    const saved: PlanReview[] = [];
    const review = new PlanReviewController({
      load: async () => null,
      save: async (_thread, next) => {
        saved.push(next);
      },
      generate: async () => {
        throw new EngineError(EngineFailureKind.Auth, EngineId.ClaudeCode, "Invalid API key · Please run /login");
      },
      dispatch: async () => undefined,
    });
    await review.request(THREAD, "plan a rainy city", {});
    const failed = saved.at(-1);
    assert.equal(failed?.state, PlanReviewState.Failed);
    assert.equal(failed?.failure, EngineFailureKind.Auth);
    const unknown = new PlanReviewController({
      load: async () => null,
      save: async (_thread, next) => {
        saved.push(next);
      },
      generate: async () => "",
      dispatch: async () => undefined,
    });
    await unknown.request(THREAD, "plan a rainy city", {});
    assert.equal(saved.at(-1)?.failure, EngineFailureKind.Other, "a failure that names no kind is other");

    const heard = hearing();
    assert.ok(failed);
    const { options: _options, ...written } = failed;
    heard.log(custom(CustomEvent.PlanReview, { ...written, state: PlanReviewState.Generating }, T0));
    heard.log(custom(CustomEvent.PlanReview, written, T0 + 1000));
    heard.log(
      custom(
        CustomEvent.PlanReview,
        { ...written, id: "review-2", state: PlanReviewState.Failed, failure: HOSTILE[6] },
        T0 + 2000,
      ),
    );
    const [planFailed, forged] = heard.of(ChatEvent.PlanReviewChanged);
    assert.equal(planFailed?.failure_kind, EngineFailureKind.Auth);
    assert.equal(forged?.failure_kind, undefined);
    for (const { event, properties } of heard.sent) assertClean(event, properties);
  });

  it("the harness records how a summary's engine failed beside its words, and only a kind it knows", async () => {
    const { compactThread } = await import("../../src/harness-seed/loop/compact.ts");
    const failedRecord = async (thrown: unknown) => {
      const appended: Array<{ event_type?: string; payload?: Record<string, unknown> }> = [];
      const history = Array.from({ length: 20 }, (_, i) => ({
        id: `01${String(i).padStart(2, "0")}`,
        data: { type: "messages", messages: [{ role: i % 2 ? "assistant" : "user", content: `message ${i}` }] },
      }));
      const ctx = {
        call: async (method: string, params: { batch?: typeof appended }) => {
          if (method === "events.list") return history;
          if (method === "engine.complete") throw thrown;
          if (method === "events.append") appended.push(...(params.batch ?? []));
          return { latestEventId: "x" };
        },
        notify: () => undefined,
      };
      await assert.rejects(compactThread(ctx as never, { threadId: THREAD, force: true, contextWindow: 8_192 }));
      return appended.find((event) => event.event_type === CustomEvent.CompactionFailed)?.payload;
    };
    const overflow = await failedRecord(
      Object.assign(new Error("prompt is too long: /Users/alice/Secret Game"), {
        kind: EngineFailureKind.ContextOverflow,
      }),
    );
    assert.equal(overflow?.failure, EngineFailureKind.ContextOverflow);
    const words = await failedRecord(Object.assign(new Error("x"), { kind: "Your usage limit resets at 5pm" }));
    assert.ok(words && !("failure" in words), "a kind the harness does not know is left out");
  });

  it("a compaction that failed says how its engine failed", () => {
    const heard = hearing();
    heard.log(
      custom(
        CustomEvent.CompactionFailed,
        { engine: EngineId.Ollama, error: HOSTILE[7], failure: EngineFailureKind.ContextOverflow },
        T0,
      ),
    );
    heard.log(
      custom(CustomEvent.CompactionFailed, { engine: EngineId.Ollama, error: HOSTILE[7], failure: HOSTILE[0] }, T0),
    );
    const [overflow, forged] = heard.of(ChatEvent.ChatContextCompacted);
    assert.equal(overflow?.failure_kind, EngineFailureKind.ContextOverflow);
    assert.equal(forged?.failure_kind, undefined);
    for (const { event, properties } of heard.sent) assertClean(event, properties);
  });
});
