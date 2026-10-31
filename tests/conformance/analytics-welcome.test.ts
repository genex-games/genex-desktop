/**
 * Usage analytics for the welcome and the model providers: the journey through the welcome's
 * screens, the presses on a provider and what each one started (a sign-in, an install, a download),
 * each ending once and credited to the surface that was pressed, and engines changing state. Every
 * property is an engine id, a typed state, a switch, a count, a bucket or a duration from the clock
 * the caller hands in — never a path, an address, an account, a model name or an id.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PostHog } from "posthog-js";
import { createStore } from "zustand/vanilla";
import type { ClaudeLoginState } from "../../src/shared/claude-login.ts";
import {
  type CliInstallJob,
  CliInstallOperation,
  CliInstallPhase,
  CliInstallProblem,
} from "../../src/shared/cli-install.ts";
import type { CodexLoginState } from "../../src/shared/codex-login.ts";
import { CodingCliState } from "../../src/shared/coding-cli.ts";
import { type EngineDescriptor, EngineKind, EngineStatusCode } from "../../src/shared/engine-descriptor.ts";
import { LocalServerKind, LocalServerProblem } from "../../src/shared/local-server.ts";
import { ModelCatalogProblemCode, ModelCatalogState } from "../../src/shared/model-catalog.ts";
import { InstallPhase, type ModelInstallJob } from "../../src/shared/model-install.ts";
import { EngineId } from "../../src/shared/providers.ts";
import type { HardwareReport, LocalModelChoice } from "../../src/shared/studio-api.ts";
import { type TerminalEvent, TerminalKind, type TerminalSession } from "../../src/shared/terminal.ts";
import { UiEvent } from "../../src/shared/ui-events.ts";
import { startAnalytics } from "../../src/renderer/analytics/client.ts";
import { createWelcomeObservers, WelcomeEvent } from "../../src/renderer/analytics/events/welcome.ts";
import { CharsBucket } from "../../src/renderer/analytics/properties.ts";
import {
  connectModelClicked,
  connectScreenViewed,
  connectViewName,
  filmInteraction,
  freeModelChoice,
  journeyMoved,
  promoClosed,
  promoConnectFinished,
  promoOutcome,
  promoShown,
  startJourney,
  welcomeFinished,
  welcomeNext,
  welcomeShown,
} from "../../src/renderer/analytics/welcome-flow.ts";
import {
  CLICK_CREDIT_MS,
  cliInstallAction,
  cliInstallSeen,
  cliRecheckAction,
  createProviderMemory,
  createStreamPairing,
  creditedClick,
  downloadFinished,
  downloadJobSeen,
  downloadPullSeen,
  downloadSource,
  downloadStarted,
  downloadsLeft,
  engineChanges,
  hardwareChecked,
  localServerConnected,
  localServersFound,
  loginSeen,
  notStartingShown,
  ollamaLookedUp,
  providerPressed,
  recheckOnReturn,
  rechecksResolved,
  rowViewed,
  signedInNotStarting,
  signInHelperUsed,
  signInSettled,
  signInStarted,
  terminalSeen,
  terminalSignInCancelled,
} from "../../src/renderer/analytics/welcome-providers.ts";
import {
  DownloadOutcome,
  DownloadSource,
  engineRef,
  FilmAction,
  FreeModelChoice,
  LocalServerVia,
  OTHER_ENGINE,
  PromoCloseVia,
  ProviderAction,
  ProviderSurface,
  RamBucket,
  ramBucket,
  SignInHelper,
  SignInMethod,
  SignInOutcome,
  SizeBucket,
  sizeBucket,
  SubscriptionRowFace,
  WelcomeExit,
} from "../../src/renderer/analytics/welcome-vocabulary.ts";
import { PromoPhase } from "../../src/renderer/genex-promo.ts";
import {
  ConnectAction,
  type ConnectView,
  ConnectViewKind,
  WelcomeScreen,
} from "../../src/renderer/onboarding/state.ts";
import { OpenCodeRowState } from "../../src/renderer/panels/opencode-row.ts";
import { Room } from "../../src/renderer/state/threads.ts";
import type { Studio } from "../../src/renderer/state/studio.ts";

const T0 = 1_700_000_000_000;

function engine(id: string, patch: Partial<EngineDescriptor> = {}): EngineDescriptor {
  return {
    id,
    label: id,
    kind: EngineKind.Delegated,
    status: { code: EngineStatusCode.Ready, detail: "" },
    models: [],
    defaultModel: null,
    ...patch,
  };
}

function withCli(id: string, state: CodingCliState, code: EngineStatusCode = EngineStatusCode.NeedsLogin) {
  return engine(id, {
    status: { code, detail: "" },
    account: { source: "none", afterSignOut: "signed-out", cli: { state } },
  });
}

const claude = (revision: number, phase: ClaudeLoginState["phase"]): ClaudeLoginState => ({
  revision,
  phase,
  hasBrowserUrl: false,
});

const codex = (revision: number, phase: CodexLoginState["phase"], method: CodexLoginState["method"] = "browser") => ({
  revision,
  visible: true,
  phase,
  method,
  lines: [],
  hasBrowserUrl: false,
});

function session(patch: Partial<TerminalSession> & Pick<TerminalSession, "id">): TerminalEvent {
  return { type: "session", session: { title: "", kind: TerminalKind.OpenCodeLogin, phase: "running", ...patch } };
}

function job(patch: Partial<CliInstallJob> = {}): CliInstallJob {
  return {
    provider: EngineId.ClaudeCode,
    phase: CliInstallPhase.Installing,
    startedAt: "2026-10-27T10:00:00.000Z",
    ...patch,
  };
}

function choice(model: string, patch: Partial<LocalModelChoice> = {}): LocalModelChoice {
  return {
    model,
    name: model,
    sizeGb: 4.2,
    tools: true,
    vision: false,
    about: "",
    fits: true,
    needGb: 5,
    needsRamGb: null,
    reason: "",
    ...patch,
  };
}

function hardware(patch: Partial<HardwareReport["recommendation"]> = {}, ramGb = 18): HardwareReport {
  return {
    hardware: { cpu: "Apple M3", ramGb, usableModelGb: 12 },
    recommendation: {
      tier: { label: "", expectation: "" },
      defaultModel: "bonsai-8b",
      picks: [choice("bonsai-8b", { engine: EngineId.Bonsai }), choice("qwen3:8b")],
      more: [choice("qwen3:32b", { fits: false })],
      ...patch,
    },
  };
}

describe("usage analytics: the welcome's journey", () => {
  it("says whether a welcome resumes one left unfinished, naming only the welcome's own screens", () => {
    assert.deepEqual(welcomeShown(true), { reduced_motion: true });
    assert.deepEqual(welcomeShown(false, null), { reduced_motion: false, resumed: false, last_screen_before: null });
    assert.deepEqual(welcomeShown(false, WelcomeScreen.Local), {
      reduced_motion: false,
      resumed: true,
      last_screen_before: WelcomeScreen.Local,
    });
    assert.deepEqual(welcomeShown(false, "/Users/ada/secret"), {
      reduced_motion: false,
      resumed: true,
      last_screen_before: null,
    });
  });

  it("tells each move to another screen once, with the time spent on the one before", () => {
    const start = startJourney(T0);
    assert.equal(journeyMoved(start, { to: WelcomeScreen.Welcome, back: false }, T0 + 50).viewed, null);
    const toConnect = journeyMoved(start, { to: WelcomeScreen.Connect, back: false }, T0 + 12_000);
    assert.deepEqual(toConnect.viewed, {
      screen: WelcomeScreen.Connect,
      from: WelcomeScreen.Welcome,
      back: false,
      ms_on_previous: 12_000,
    });
    const toLocal = journeyMoved(toConnect.journey, { to: WelcomeScreen.Local, back: false }, T0 + 15_000);
    const back = journeyMoved(toLocal.journey, { to: WelcomeScreen.Connect, back: true }, T0 + 19_500);
    assert.deepEqual(back.viewed, {
      screen: WelcomeScreen.Connect,
      from: WelcomeScreen.Local,
      back: true,
      ms_on_previous: 4_500,
    });
    assert.deepEqual(back.journey.visited, [WelcomeScreen.Welcome, WelcomeScreen.Connect, WelcomeScreen.Local]);
    assert.equal(journeyMoved(start, { to: WelcomeScreen.Connect, back: false }, T0 - 5).viewed?.ms_on_previous, 0);
  });

  it("tells Next with the time on the welcome and the film seen, an idea only by its length", () => {
    const back = journeyMoved(startJourney(T0), { to: WelcomeScreen.Welcome, back: true }, T0);
    const film = { beatReached: 1, loops: 3, ideaLength: 57 };
    assert.deepEqual(welcomeNext(back.journey, film, T0 + 61_000), {
      ms_on_welcome: 61_000,
      beat_reached: 1,
      film_loops: 3,
      idea_written: true,
      idea_chars_bucket: CharsBucket.Medium,
    });
    assert.equal(welcomeNext(startJourney(T0), { beatReached: 0, loops: 0, ideaLength: 0 }, T0).idea_written, false);
    assert.deepEqual(filmInteraction(FilmAction.IdeaSent, 0, 12), {
      action: FilmAction.IdeaSent,
      beat: 0,
      idea_chars_bucket: CharsBucket.Short,
    });
    assert.deepEqual(filmInteraction(FilmAction.StepJump, 1), { action: FilmAction.StepJump, beat: 1 });
  });

  it("tells how the welcome ended: the way out, the time in it, the screens seen and what was ready", () => {
    const moved = journeyMoved(startJourney(T0), { to: WelcomeScreen.Connect, back: false }, T0 + 1_000);
    const end = {
      exit: WelcomeExit.Skip,
      engines: [engine(EngineId.Codex), engine(EngineId.Bonsai), withCli(EngineId.ClaudeCode, CodingCliState.Ready)],
      anyReady: true,
      ideaCarried: false,
      freeModel: FreeModelChoice.None,
      readyFailed: false,
    };
    assert.deepEqual(welcomeFinished(moved.journey, end, T0 + 90_000), {
      exit: WelcomeExit.Skip,
      screen: WelcomeScreen.Connect,
      ms_in_welcome: 90_000,
      screens_visited: 2,
      engines_ready: [EngineId.Bonsai, EngineId.Codex],
      any_ready: true,
      idea_carried: false,
      free_model: FreeModelChoice.None,
      ready_failed: false,
    });
    assert.equal(freeModelChoice(null, "opencode/default"), FreeModelChoice.None);
    assert.equal(freeModelChoice({ picked: "opencode/default" }, "opencode/default"), FreeModelChoice.Default);
    assert.equal(freeModelChoice({ picked: "opencode/big-pickle" }, "opencode/default"), FreeModelChoice.Picked);
  });

  it("names Connect's buttons as they stood on arrival, and the CLIs behind them", () => {
    const install: ConnectView = { kind: ConnectViewKind.Action, action: ConnectAction.Install, label: "Set up" };
    const busy: ConnectView = { kind: ConnectViewKind.Busy, label: "Finish in your browser", cancel: true };
    assert.equal(connectViewName(install), ConnectAction.Install);
    assert.equal(connectViewName(busy), ConnectViewKind.Busy);
    assert.equal(connectViewName({ kind: ConnectViewKind.Code }), ConnectViewKind.Code);
    const engines = [withCli(EngineId.ClaudeCode, CodingCliState.Missing), engine(EngineId.Ollama)];
    assert.deepEqual(connectScreenViewed({ [EngineId.ClaudeCode]: install, [EngineId.Codex]: busy }, engines, true), {
      claude_view: ConnectAction.Install,
      codex_view: ConnectViewKind.Busy,
      claude_cli_state: CodingCliState.Missing,
      codex_cli_state: null,
      engines_ready: [EngineId.Ollama],
      any_ready: true,
    });
  });
});

describe("usage analytics: presses and the sign-ins they start", () => {
  it("credits what a press starts to its surface for a minute, and no longer", () => {
    const memory = createProviderMemory();
    const press = { engine: EngineId.Codex, action: ProviderAction.Connect, surface: ProviderSurface.Onboarding };
    assert.deepEqual(providerPressed(memory, press, T0), {
      engine: EngineId.Codex,
      action: ProviderAction.Connect,
      surface: ProviderSurface.Onboarding,
    });
    assert.equal(creditedClick(memory, EngineId.Codex, T0 + CLICK_CREDIT_MS)?.surface, ProviderSurface.Onboarding);
    assert.equal(creditedClick(memory, EngineId.Codex, T0 + CLICK_CREDIT_MS + 1), null);
    assert.equal(creditedClick(memory, EngineId.ClaudeCode, T0), null);
  });

  it("follows a Claude Code sign-in step by step and ends it once, with the helps it needed", () => {
    const memory = createProviderMemory();
    const pairing = createStreamPairing();
    const surface = ProviderSurface.Settings;
    providerPressed(memory, { engine: EngineId.ClaudeCode, action: ProviderAction.SignIn, surface }, T0);
    assert.deepEqual(
      signInStarted(memory, { engine: EngineId.ClaudeCode, started: true, missingCli: false }, T0 + 10),
      {
        engine: EngineId.ClaudeCode,
        surface,
        method: SignInMethod.Piped,
        started: true,
        missing_cli: false,
      },
    );
    const see = (revision: number, phase: ClaudeLoginState["phase"], at: number) =>
      loginSeen(memory, pairing, { engine: EngineId.ClaudeCode, state: claude(revision, phase) }, at);
    assert.deepEqual(see(1, "starting", T0 + 100).phase, {
      engine: EngineId.ClaudeCode,
      phase: "starting",
      method: SignInMethod.Piped,
      ms_since_start: 90,
    });
    assert.deepEqual(see(2, "starting", T0 + 200), {}, "the same step again says nothing");
    assert.deepEqual(see(1, "browser", T0 + 300), {}, "an older state says nothing");
    see(3, "code", T0 + 60_000);
    signInHelperUsed(memory, { engine: EngineId.ClaudeCode, helper: SignInHelper.CodeBoxOpened }, T0 + 61_000);
    see(4, "terminal", T0 + 62_000);
    const ended = see(5, "connected", T0 + 70_010);
    assert.deepEqual(ended.finished, {
      engine: EngineId.ClaudeCode,
      outcome: SignInOutcome.Connected,
      problem: null,
      method: SignInMethod.Piped,
      phase_at_end: "terminal",
      duration_ms: 70_000,
      surface,
      used_code_box: true,
      fell_back_to_terminal: true,
    });
    assert.deepEqual(see(6, "failed", T0 + 80_000), {}, "an end with no sign-in under way is an old one's");
  });

  it("follows a Codex sign-in that switched to a device code, credited to the press that started it", () => {
    const memory = createProviderMemory();
    const pairing = createStreamPairing();
    providerPressed(
      memory,
      { engine: EngineId.Codex, action: ProviderAction.Connect, surface: ProviderSurface.Onboarding },
      T0,
    );
    const see = (state: CodexLoginState, at: number) =>
      loginSeen(memory, pairing, { engine: EngineId.Codex, state }, at);
    assert.equal(see(codex(1, "starting"), T0 + 5).phase?.method, SignInMethod.Browser);
    assert.equal(see(codex(2, "waiting", "device"), T0 + 10).phase?.method, SignInMethod.Device);
    const ended = see(codex(3, "cancelled", "device"), T0 + 200_005);
    assert.equal(ended.finished?.outcome, SignInOutcome.Cancelled);
    assert.equal(ended.finished?.surface, ProviderSurface.Onboarding);
    assert.equal(ended.finished?.duration_ms, 200_000);
    assert.equal(ended.finished?.phase_at_end, "waiting");
  });

  it("does not follow a sign-in that never started", () => {
    const memory = createProviderMemory();
    const refused = signInStarted(memory, { engine: EngineId.ClaudeCode, started: false, missingCli: true }, T0);
    assert.equal(refused.missing_cli, true);
    assert.equal(refused.surface, null);
    assert.equal(memory.signIns.size, 0);
  });

  it("ends a CLI's terminal sign-in once: connected on a clean exit, cancelled after Cancel, failed otherwise", () => {
    const memory = createProviderMemory();
    const pairing = createStreamPairing();
    signInStarted(memory, { engine: EngineId.OpenCode, started: true, missingCli: false }, T0);
    assert.equal(terminalSeen(memory, pairing, session({ id: "t1" }), T0 + 5), null, "still running");
    const clean = terminalSeen(memory, pairing, session({ id: "t1", phase: "exited", exitCode: 0 }), T0 + 40_000);
    assert.equal(clean?.outcome, SignInOutcome.Connected);
    assert.equal(clean?.method, SignInMethod.TerminalTui);
    assert.equal(clean?.duration_ms, 40_000);
    assert.equal(clean?.exit_code, 0);
    assert.equal(terminalSeen(memory, pairing, session({ id: "t1", phase: "exited", exitCode: 0 }), T0), null);

    signInStarted(memory, { engine: EngineId.Grok, started: true, missingCli: false }, T0);
    terminalSignInCancelled(memory, EngineId.Grok);
    const grok = session({ id: "t2", kind: TerminalKind.GrokLogin, phase: "exited", exitCode: 130 });
    assert.equal(terminalSeen(memory, pairing, grok, T0 + 1)?.outcome, SignInOutcome.Cancelled);

    const cursor = session({ id: "t3", kind: TerminalKind.CursorLogin, phase: "exited", exitCode: 1 });
    const failed = terminalSeen(memory, pairing, cursor, T0 + 1);
    assert.equal(failed?.outcome, SignInOutcome.Failed);
    assert.equal(failed?.duration_ms, null, "a sign-in this window never saw start has no duration");

    const shell = session({ id: "t4", kind: TerminalKind.Shell, phase: "exited", exitCode: 0 });
    assert.equal(terminalSeen(memory, pairing, shell, T0), null, "only sign-in terminals count");
  });

  it("ends a sign-in that settles in one call with its own outcome", () => {
    const memory = createProviderMemory();
    providerPressed(
      memory,
      { engine: EngineId.OpenRouter, action: ProviderAction.Connect, surface: ProviderSurface.Onboarding },
      T0,
    );
    signInStarted(memory, { engine: EngineId.OpenRouter, started: true, missingCli: false }, T0);
    const ended = signInSettled(memory, { engine: EngineId.OpenRouter, outcome: SignInOutcome.Failed }, T0 + 600_000);
    assert.equal(ended.method, SignInMethod.Browser);
    assert.equal(ended.surface, ProviderSurface.Onboarding);
    assert.equal(ended.duration_ms, 600_000);
    assert.equal(memory.signIns.size, 0);
  });

  it("tells a submitted code with whether it was taken, and the step it was on", () => {
    const memory = createProviderMemory();
    const pairing = createStreamPairing();
    signInStarted(memory, { engine: EngineId.ClaudeCode, started: true, missingCli: false }, T0);
    loginSeen(memory, pairing, { engine: EngineId.ClaudeCode, state: claude(1, "code") }, T0 + 1);
    const use = { engine: EngineId.ClaudeCode, helper: SignInHelper.CodeSubmitted, accepted: false };
    assert.deepEqual(signInHelperUsed(memory, use, T0 + 2), {
      engine: EngineId.ClaudeCode,
      helper: SignInHelper.CodeSubmitted,
      surface: null,
      accepted: false,
      phase: "code",
    });
    const dismissed = { engine: EngineId.Codex, helper: SignInHelper.PanelDismissed, phase: "connected" as const };
    assert.equal(signInHelperUsed(memory, dismissed, T0).phase, "connected");
  });
});

describe("usage analytics: CLI installs and engines", () => {
  it("tells an install's start and end once each, credited to the button pressed", () => {
    const memory = createProviderMemory();
    const pairing = createStreamPairing();
    providerPressed(
      memory,
      { engine: EngineId.ClaudeCode, action: ProviderAction.Update, surface: ProviderSurface.Settings },
      T0,
    );
    const started = cliInstallSeen(memory, pairing, job(), T0 + 100);
    assert.deepEqual(started, {
      started: {
        provider: EngineId.ClaudeCode,
        operation: CliInstallOperation.Install,
        surface: ProviderSurface.Settings,
        button: ProviderAction.Update,
      },
    });
    assert.deepEqual(cliInstallSeen(memory, pairing, job(), T0 + 200), {}, "the same news again says nothing");
    const failed = job({
      phase: CliInstallPhase.Failed,
      problem: CliInstallProblem.TimedOut,
      finishedAt: "2026-10-27T10:10:00.000Z",
    });
    // Long after the press, the end is still the press's.
    assert.deepEqual(cliInstallSeen(memory, pairing, failed, T0 + 10 * CLICK_CREDIT_MS).finished, {
      provider: EngineId.ClaudeCode,
      operation: CliInstallOperation.Install,
      surface: ProviderSurface.Settings,
      button: ProviderAction.Update,
      phase: CliInstallPhase.Failed,
      problem: CliInstallProblem.TimedOut,
      duration_ms: 600_000,
    });
    assert.deepEqual(cliInstallSeen(memory, pairing, failed, T0), {});
    const unstamped = job({ startedAt: "garbled", phase: CliInstallPhase.Installed, provider: EngineId.Codex });
    const late = cliInstallSeen(memory, pairing, unstamped, T0 + 10 * CLICK_CREDIT_MS).finished;
    assert.equal(late?.duration_ms, null);
    assert.equal(late?.surface, null, "a job no recent press started is credited to none");
  });

  it("tells each engine whose status, CLI or model list changed, from the second list on", () => {
    const before = [
      engine(EngineId.ClaudeCode),
      withCli(EngineId.Codex, CodingCliState.Missing, EngineStatusCode.NotInstalled),
      engine(EngineId.Ollama, { catalog: { state: ModelCatalogState.Loading, revision: 1, refreshing: true } }),
      engine(EngineId.Bonsai),
    ];
    assert.deepEqual(engineChanges([], before, true), [], "the first list is where a window starts");
    const after = [
      engine(EngineId.ClaudeCode, { status: { code: EngineStatusCode.NeedsLogin, detail: "expired" } }),
      withCli(EngineId.Codex, CodingCliState.Ready),
      engine(EngineId.Ollama, { catalog: { state: ModelCatalogState.Ready, revision: 2, refreshing: false } }),
    ];
    assert.deepEqual(engineChanges(before, after, false), [
      {
        engine: EngineId.ClaudeCode,
        from: EngineStatusCode.Ready,
        to: EngineStatusCode.NeedsLogin,
        reason: null,
        cli_state: null,
        catalog_state: null,
        catalog_problem: null,
        login_source: null,
        during_welcome: false,
      },
      {
        engine: EngineId.Codex,
        from: EngineStatusCode.NotInstalled,
        to: EngineStatusCode.NeedsLogin,
        reason: null,
        cli_state: CodingCliState.Ready,
        catalog_state: null,
        catalog_problem: null,
        login_source: "none",
        during_welcome: false,
      },
      {
        engine: EngineId.Bonsai,
        from: EngineStatusCode.Ready,
        to: null,
        reason: null,
        cli_state: null,
        catalog_state: null,
        catalog_problem: null,
        login_source: null,
        during_welcome: false,
      },
    ]);
    const catalog = {
      state: ModelCatalogState.Unavailable,
      revision: 3,
      refreshing: false,
      problem: { code: ModelCatalogProblemCode.Timeout, message: "/Users/ada/.claude timed out" },
    };
    const unlisted = engine(EngineId.ClaudeCode, { catalog });
    const change = engineChanges([engine(EngineId.ClaudeCode)], [unlisted], true);
    assert.equal(change[0]?.catalog_problem, ModelCatalogProblemCode.Timeout);
    assert.equal(signedInNotStarting(unlisted), true);
    assert.equal(signedInNotStarting({ ...unlisted, catalog: { ...catalog, refreshing: true } }), false);
    assert.deepEqual(notStartingShown(unlisted, ProviderSurface.Onboarding), {
      engine: EngineId.ClaudeCode,
      catalog_problem: ModelCatalogProblemCode.Timeout,
      surface: ProviderSurface.Onboarding,
    });
  });

  it("answers a recheck on coming back with the next engines list that has that engine", () => {
    const memory = createProviderMemory();
    const surface = ProviderSurface.Onboarding;
    recheckOnReturn(memory, { engine: EngineId.Codex, before: CodingCliState.Missing, surface });
    assert.deepEqual(rechecksResolved(memory, [engine(EngineId.ClaudeCode)]), []);
    assert.deepEqual(rechecksResolved(memory, [withCli(EngineId.Codex, CodingCliState.Ready)]), [
      {
        engine: EngineId.Codex,
        surface,
        cli_state_before: CodingCliState.Missing,
        cli_state_after: CodingCliState.Ready,
        found_after: true,
      },
    ]);
    assert.deepEqual(rechecksResolved(memory, [withCli(EngineId.Codex, CodingCliState.Ready)]), [], "told once");
  });

  it("names a CLI row's buttons by the face they stand on", () => {
    assert.equal(cliInstallAction(OpenCodeRowState.Outdated), ProviderAction.Update);
    assert.equal(cliInstallAction(OpenCodeRowState.NotInstalled), ProviderAction.Install);
    assert.equal(cliRecheckAction(OpenCodeRowState.Unreachable), ProviderAction.TryAgain);
    assert.equal(cliRecheckAction(OpenCodeRowState.Connected), ProviderAction.CheckConnection);
    assert.equal(cliRecheckAction(OpenCodeRowState.NotInstalled), ProviderAction.Recheck);
    assert.deepEqual(
      rowViewed({
        engine: EngineId.Codex,
        face: SubscriptionRowFace.NeedsNode,
        surface: ProviderSurface.Settings,
        cliState: CodingCliState.MissingRuntime,
      }),
      {
        engine: EngineId.Codex,
        row: SubscriptionRowFace.NeedsNode,
        surface: ProviderSurface.Settings,
        cli_state: CodingCliState.MissingRuntime,
      },
    );
  });
});

describe("usage analytics: local models and servers", () => {
  it("tells this Mac's check by buckets, and where the Best fit runs", () => {
    assert.deepEqual(hardwareChecked(ProviderSurface.Onboarding, hardware(), 850), {
      surface: ProviderSurface.Onboarding,
      ram_gb_bucket: RamBucket.UpTo24,
      has_fit: true,
      best_fit_engine: EngineId.Bonsai,
      duration_ms: 850,
      failed: false,
    });
    const ollamaFirst = hardware({ defaultModel: null, picks: [choice("qwen3:8b")] }, 8);
    assert.equal(hardwareChecked(ProviderSurface.Settings, ollamaFirst, 1).best_fit_engine, EngineId.Ollama);
    assert.equal(hardwareChecked(ProviderSurface.Settings, ollamaFirst, 1).ram_gb_bucket, RamBucket.UpTo8);
    assert.deepEqual(hardwareChecked(ProviderSurface.Settings, null, 30_000), {
      surface: ProviderSurface.Settings,
      ram_gb_bucket: null,
      has_fit: false,
      best_fit_engine: null,
      duration_ms: 30_000,
      failed: true,
    });
    assert.equal(downloadSource(hardware(), "bonsai-8b"), DownloadSource.BestFit);
    assert.equal(downloadSource(hardware(), "qwen3:8b"), DownloadSource.Pick);
    assert.equal(downloadSource(hardware(), "qwen3:32b"), DownloadSource.More);
    assert.equal(downloadSource(hardware(), "my-own:tag"), DownloadSource.OllamaLookup);
  });

  it("follows a download from its press to its end, with how far it got and whether its screen was left", () => {
    const memory = createProviderMemory();
    const start = {
      model: "bonsai-8b",
      surface: ProviderSurface.Onboarding,
      engine: EngineId.Bonsai,
      source: DownloadSource.BestFit,
      resumed: false,
      sizeGb: 4.2,
    };
    assert.deepEqual(downloadStarted(memory, start, T0), {
      surface: ProviderSurface.Onboarding,
      engine: EngineId.Bonsai,
      source: DownloadSource.BestFit,
      resumed: false,
      size_bucket: SizeBucket.Medium,
      ollama_running: null,
    });
    const progress: ModelInstallJob = {
      id: "job-1",
      model: "bonsai-8b",
      phase: InstallPhase.Downloading,
      completed: 41,
      total: 100,
      location: "/Users/ada/Library/Bonsai",
      updatedAt: "",
      active: true,
    };
    downloadJobSeen(memory, progress);
    downloadsLeft(memory, ProviderSurface.Onboarding);
    downloadJobSeen(memory, { ...progress, phase: InstallPhase.Cancelled, completed: 43, active: false });
    assert.deepEqual(downloadFinished(memory, { model: "bonsai-8b", ok: false, ollama: undefined }, T0 + 95_000), {
      engine: EngineId.Bonsai,
      surface: ProviderSurface.Onboarding,
      outcome: DownloadOutcome.Cancelled,
      percent_at_end: 43,
      failed_phase: null,
      problem: null,
      duration_ms: 95_000,
      needs_ollama: false,
      left_screen_while_downloading: true,
    });
    assert.equal(downloadFinished(memory, { model: "bonsai-8b", ok: true, ollama: undefined }, T0), null, "told once");
  });

  it("tells an Ollama download that failed for want of Ollama, and one that finished", () => {
    const memory = createProviderMemory();
    const notRunning = engine(EngineId.Ollama, { status: { code: EngineStatusCode.NotRunning, detail: "" } });
    const start = {
      model: "qwen3:8b",
      surface: ProviderSurface.Settings,
      engine: undefined,
      source: DownloadSource.Pick,
      resumed: true,
      sizeGb: 0.6,
      ollama: notRunning,
    };
    const told = downloadStarted(memory, start, T0);
    assert.equal(told.ollama_running, false);
    assert.equal(told.size_bucket, SizeBucket.Small);
    downloadPullSeen(memory, { model: "qwen3:8b", progress: { status: "pulling", completed: 1, total: 4 } });
    const failed = downloadFinished(memory, { model: "qwen3:8b", ok: false, ollama: notRunning }, T0 + 2_000);
    assert.equal(failed?.outcome, DownloadOutcome.Failed);
    assert.equal(failed?.needs_ollama, true);
    assert.equal(failed?.percent_at_end, 25);
    downloadStarted(memory, { ...start, ollama: engine(EngineId.Ollama) }, T0);
    const ready = downloadFinished(memory, { model: "qwen3:8b", ok: true, ollama: undefined }, T0 + 1);
    assert.equal(ready?.outcome, DownloadOutcome.Ready);
    assert.equal(ready?.percent_at_end, 100);
  });

  it("tells a lookup, servers found and a server's Connect by their typed answers only", () => {
    assert.deepEqual(ollamaLookedUp({ ok: false, reason: "not_found", id: "secret:tag" }), {
      ok: false,
      reason: "not_found",
      fits: null,
      size_bucket: null,
    });
    const found = { ok: true as const, id: "qwen3.5:9b", sizeGb: 6.1, fits: true, needGb: 7, needsRamGb: null };
    assert.deepEqual(ollamaLookedUp(found), { ok: true, reason: null, fits: true, size_bucket: SizeBucket.Large });
    assert.deepEqual(ollamaLookedUp(null), { ok: false, reason: null, fits: null, size_bucket: null });
    const servers = [
      { url: "http://192.168.1.20:5000/v1", kind: LocalServerKind.TabbyApi, needsKey: true, models: 0 },
      { url: "http://127.0.0.1:1234/v1", kind: LocalServerKind.LmStudio, needsKey: false, models: 3 },
      { url: "http://127.0.0.1:8080/v1", kind: LocalServerKind.LmStudio, needsKey: false, models: 1 },
      { url: "http://127.0.0.1:9000/v1", kind: null, needsKey: false, models: 1 },
    ];
    assert.deepEqual(localServersFound(servers), {
      count: 4,
      kinds: [LocalServerKind.LmStudio, LocalServerKind.TabbyApi],
      needs_key_count: 1,
    });
    const refusal = { ok: false as const, problem: LocalServerProblem.NeedsKey, kind: LocalServerKind.TabbyApi };
    assert.deepEqual(localServerConnected({ via: LocalServerVia.Found, hasKey: false }, refusal, 420), {
      via: LocalServerVia.Found,
      has_key: false,
      ok: false,
      problem: LocalServerProblem.NeedsKey,
      kind: LocalServerKind.TabbyApi,
      duration_ms: 420,
    });
    const saved = { ok: true as const, status: { code: EngineStatusCode.Ready, detail: "TabbyAPI at 10.0.0.2" } };
    assert.equal(localServerConnected({ via: LocalServerVia.Typed, hasKey: true }, saved, 1).ok, true);
    assert.equal(localServerConnected({ via: LocalServerVia.SavedKey, hasKey: true }, null, 1).ok, false);
  });

  it("buckets sizes and memory, and names only the app's own engines", () => {
    assert.equal(sizeBucket(0.4), SizeBucket.Small);
    assert.equal(sizeBucket(19.9), SizeBucket.Large);
    assert.equal(sizeBucket(70), SizeBucket.Huge);
    assert.equal(ramBucket(36), RamBucket.UpTo64);
    assert.equal(ramBucket(512), RamBucket.More);
    assert.equal(engineRef(EngineId.Cursor), EngineId.Cursor);
    assert.equal(engineRef("my-fork"), OTHER_ENGINE);
    assert.equal(engineRef(undefined), OTHER_ENGINE);
  });
});

describe("usage analytics: the Genex promo and Connect AI model", () => {
  it("times the card from the welcome's end, its sign-in from the press, and its stay from its rise", () => {
    assert.deepEqual(promoShown({ atHome: true, account: "locked", welcomeEndedAt: T0 }, T0 + 2_700), {
      at_home: true,
      account: "locked",
      ms_since_welcome: 2_700,
    });
    assert.equal(promoShown({ atHome: false, account: undefined, welcomeEndedAt: null }, T0).ms_since_welcome, null);
    assert.equal(promoOutcome(PromoPhase.Connected), SignInOutcome.Connected);
    assert.equal(promoOutcome(PromoPhase.Failed), SignInOutcome.Failed);
    assert.equal(promoOutcome(PromoPhase.Waiting), null);
    const attempt = { outcome: SignInOutcome.Connected, retry: true, sawSignIn: true, startedAt: T0 };
    assert.deepEqual(promoConnectFinished(attempt, T0 + 31_000), {
      outcome: SignInOutcome.Connected,
      retry: true,
      saw_sign_in: true,
      duration_ms: 31_000,
    });
    const card = { phase: PromoPhase.Offer, via: PromoCloseVia.Escape, learnMore: true, shownAt: T0 };
    assert.deepEqual(promoClosed(card, T0 + 4_000), {
      phase: PromoPhase.Offer,
      via: PromoCloseVia.Escape,
      learn_more: true,
      ms_visible: 4_000,
    });
  });

  it("tells Connect AI model by whether a blocked send lit it, and the room it sits in", () => {
    assert.deepEqual(connectModelClicked(true, Room.Build), { nudged: true, room: Room.Build });
  });
});

/** Every value a property holds, flattened to strings, so nothing written by a person can hide in one. */
function leaves(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap(leaves);
  if (typeof value === "object") return Object.values(value).flatMap(leaves);
  return [String(value)];
}

describe("usage analytics: nothing a person wrote or owns leaves", () => {
  const HOSTILE = [
    "/Users/ada/Projects/secret-game",
    "C:\\Users\\ada\\AppData",
    "file:///Users/ada/x.png#y",
    "ada.lovelace@example.com",
    "http://192.168.1.20:5000/v1",
    "sk-or-v1-abc123",
    "OPENAI_API_KEY",
    "WXYZ-1234",
    "my-secret-model:latest",
    "Ada's MacBook Pro",
  ];
  const memory = createProviderMemory();
  const pairing = createStreamPairing();
  const hostileEngine = engine(HOSTILE[0], {
    label: HOSTILE[3],
    status: { code: EngineStatusCode.Error, detail: `${HOSTILE[3]} at ${HOSTILE[4]}`, remedy: HOSTILE[1] },
    account: {
      source: "env",
      variable: HOSTILE[6],
      afterSignOut: "terminal",
      cli: { state: "ready", path: HOSTILE[0] },
    },
    server: { url: HOSTILE[4], kind: null, hasKey: true },
    models: [{ id: HOSTILE[8], label: HOSTILE[9], contextWindow: 1, supportsTools: true, supportsVision: false }],
  });
  const cases: ReadonlyArray<[string, () => unknown]> = [
    [
      "a press on an engine with a hostile id",
      () =>
        providerPressed(
          memory,
          { engine: HOSTILE[0], action: ProviderAction.SignIn, surface: ProviderSurface.Settings },
          T0,
        ),
    ],
    [
      "a sign-in whose stream carries English and an email",
      () => {
        signInStarted(memory, { engine: EngineId.ClaudeCode, started: true, missingCli: false }, T0);
        const state = { ...claude(1, "failed"), error: `${HOSTILE[3]} could not sign in at ${HOSTILE[0]}` };
        return loginSeen(memory, pairing, { engine: EngineId.ClaudeCode, state }, T0 + 1);
      },
    ],
    [
      "a Codex sign-in with its console lines and device code",
      () => {
        const state = { ...codex(1, "waiting", "device"), lines: [HOSTILE[3], HOSTILE[0]], deviceCode: HOSTILE[7] };
        return loginSeen(memory, pairing, { engine: EngineId.Codex, state }, T0);
      },
    ],
    [
      "a sign-in terminal with its title, command and output",
      () =>
        terminalSeen(
          memory,
          pairing,
          session({
            id: HOSTILE[2],
            title: HOSTILE[9],
            project: HOSTILE[0],
            command: `cat ${HOSTILE[1]}`,
            output: [HOSTILE[5]],
            error: HOSTILE[3],
            phase: "exited",
            exitCode: 0,
          }),
          T0,
        ),
    ],
    [
      "engines with names, addresses, variables and paths",
      () => engineChanges([engine(EngineId.Codex)], [hostileEngine], true),
    ],
    [
      "Connect's arrival over hostile engines",
      () =>
        connectScreenViewed(
          {
            [EngineId.ClaudeCode]: { kind: ConnectViewKind.On, label: HOSTILE[3] },
            [EngineId.Codex]: { kind: ConnectViewKind.Code },
          },
          [hostileEngine, engine(EngineId.ClaudeCode, { label: HOSTILE[9] })],
          true,
        ),
    ],
    [
      "a welcome's end over hostile engines",
      () =>
        welcomeFinished(
          startJourney(T0),
          {
            exit: WelcomeExit.Start,
            engines: [engine(HOSTILE[8]), hostileEngine],
            anyReady: true,
            ideaCarried: true,
            freeModel: FreeModelChoice.Picked,
            readyFailed: false,
          },
          T0,
        ),
    ],
    ["an idea the person wrote, by its length only", () => filmInteraction(FilmAction.IdeaSent, 0, HOSTILE[9].length)],
    [
      "this Mac's name in its CPU line",
      () =>
        hardwareChecked(
          ProviderSurface.Settings,
          { ...hardware(), hardware: { cpu: HOSTILE[9], ramGb: 16, usableModelGb: 9 } },
          1,
        ),
    ],
    [
      "a download of a model named by the person",
      () => {
        const start = {
          model: HOSTILE[8],
          surface: ProviderSurface.Settings,
          engine: HOSTILE[0],
          source: DownloadSource.OllamaLookup,
          resumed: false,
          sizeGb: 3,
          ollama: hostileEngine,
        };
        const started = downloadStarted(memory, start, T0);
        downloadPullSeen(memory, {
          model: HOSTILE[8],
          progress: { status: HOSTILE[0], digest: HOSTILE[5], error: HOSTILE[3] },
        });
        return [started, downloadFinished(memory, { model: HOSTILE[8], ok: false, ollama: hostileEngine }, T0 + 1)];
      },
    ],
    [
      "an Ollama lookup that echoes the tag and an error",
      () => ollamaLookedUp({ ok: false, reason: "unavailable", id: HOSTILE[8], error: `${HOSTILE[4]} refused` }),
    ],
    [
      "servers found on the network",
      () => localServersFound([{ url: HOSTILE[4], kind: LocalServerKind.Vllm, needsKey: true, models: 2 }]),
    ],
    [
      "a server's refusal",
      () =>
        localServerConnected(
          { via: LocalServerVia.Typed, hasKey: true },
          { ok: false, problem: LocalServerProblem.NotLocal },
          1,
        ),
    ],
    [
      "an install job whose start stamp is a path",
      () => cliInstallSeen(memory, pairing, job({ provider: EngineId.Codex, startedAt: HOSTILE[0] }), T0),
    ],
    [
      "a recheck on an engine with a hostile id",
      () => {
        recheckOnReturn(memory, { engine: HOSTILE[0], before: null, surface: ProviderSurface.Settings });
        return rechecksResolved(memory, [hostileEngine]);
      },
    ],
    [
      "a signed-in CLI that would not start, with a path in its problem",
      () =>
        notStartingShown(
          engine(HOSTILE[0], {
            catalog: {
              state: ModelCatalogState.Unavailable,
              revision: 1,
              refreshing: false,
              problem: { code: ModelCatalogProblemCode.Provider, message: HOSTILE[0] },
            },
          }),
          ProviderSurface.Settings,
        ),
    ],
    [
      "a sign-in that settled in one call on a hostile engine",
      () => signInSettled(memory, { engine: HOSTILE[4], outcome: SignInOutcome.Failed }, T0),
    ],
  ];
  for (const [name, run] of cases)
    it(`keeps ${name} out of what leaves`, () => {
      const values = leaves(run());
      for (const hostile of HOSTILE)
        for (const value of values) assert.ok(!value.includes(hostile), `"${hostile}" leaked as "${value}"`);
    });
});

describe("usage analytics: what the welcome's observers hear", () => {
  it("sends installs, sign-ins and engine changes heard once from main, never from the hooks that show them", async () => {
    const captured: Array<{ name: string; properties: Record<string, unknown> }> = [];
    const posthog = {
      init: () => undefined,
      has_opted_out_capturing: () => false,
      opt_in_capturing: () => undefined,
      register: () => undefined,
      startSessionRecording: () => undefined,
      stopSessionRecording: () => undefined,
      capture: (name: string, properties: Record<string, unknown>) => captured.push({ name, properties }),
    } as unknown as PostHog;
    await startAnalytics({ key: "phc_test", host: "https://eu.i.posthog.com" }, { replay: false }, async () => ({
      posthog,
    }));
    captured.length = 0;

    let clock = T0;
    const listeners = {
      claude: [] as Array<(s: ClaudeLoginState) => void>,
      codex: [],
      terminal: [] as Array<(e: TerminalEvent) => void>,
    };
    const engines = createStore<{ list: EngineDescriptor[] }>()(() => ({ list: [] }));
    const app = {
      api: {
        onClaudeLogin: (listen: (s: ClaudeLoginState) => void) => {
          listeners.claude.push(listen);
          return () => undefined;
        },
        onCodexLogin: () => () => undefined,
        onTerminal: (listen: (e: TerminalEvent) => void) => {
          listeners.terminal.push(listen);
          return () => undefined;
        },
      },
      engines,
      session: { getState: () => ({ welcoming: true }) },
    } as unknown as Studio;
    const observers = createWelcomeObservers(() => clock);
    const stop = observers.start?.(app);

    observers.ui?.({ type: UiEvent.CliInstall, payload: job({ provider: EngineId.Codex }) });
    observers.ui?.({ type: UiEvent.CliInstall, payload: job({ provider: EngineId.Codex }) });
    clock = T0 + 5;
    for (const listen of listeners.claude) listen(claude(1, "browser"));
    engines.setState({
      list: [engine(EngineId.ClaudeCode, { status: { code: EngineStatusCode.NeedsLogin, detail: "" } })],
    });
    engines.setState({ list: [engine(EngineId.ClaudeCode)] });
    for (const listen of listeners.terminal) listen(session({ id: "s", phase: "exited", exitCode: 0 }));
    stop?.();

    assert.deepEqual(
      captured.map((event) => event.name),
      [
        WelcomeEvent.CliInstallStarted,
        WelcomeEvent.ProviderSignInPhaseChanged,
        WelcomeEvent.ProviderStatusChanged,
        WelcomeEvent.ProviderSignInFinished,
      ],
    );
    assert.equal(captured[2]?.properties.during_welcome, true);
    assert.equal(captured[2]?.properties.to, EngineStatusCode.Ready);
  });
});
