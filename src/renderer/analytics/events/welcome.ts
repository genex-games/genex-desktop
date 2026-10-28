/** The welcome, Connect and the model providers (plan §1.3): where a first launch gets stuck before a model is ready. */
import type { ClaudeLoginProblem, ClaudeLoginState } from "../../../shared/claude-login.ts";
import type {
  CliInstallOperation,
  CliInstallPhase,
  CliInstallProblem,
  CliInstallRefusal,
} from "../../../shared/cli-install.ts";
import type { CodexLoginProblem, CodexLoginState } from "../../../shared/codex-login.ts";
import type { CodingCliState } from "../../../shared/coding-cli.ts";
import type { EngineStatusCode, EngineStatusReason, LoginSource } from "../../../shared/engine-descriptor.ts";
import type { StudioErrorCode } from "../../../shared/error-codes.ts";
import type { LocalServerKind, LocalServerProblem } from "../../../shared/local-server.ts";
import type { ModelCatalogProblemCode, ModelCatalogState } from "../../../shared/model-catalog.ts";
import type { InstallPhase, ModelInstallProblem, ModelPullProblem } from "../../../shared/model-install.ts";
import type { OpenRouterSignInProblem } from "../../../shared/openrouter-login.ts";
import { EngineId } from "../../../shared/providers.ts";
import { UiEvent } from "../../../shared/ui-events.ts";
import type { PromoAccount, PromoPhase } from "../../genex-promo.ts";
import type { ConnectViewName } from "../welcome-flow.ts";
import type { WelcomeScreen } from "../../onboarding/state.ts";
import type { Room } from "../../state/threads.ts";
import type { Studio } from "../../state/studio.ts";
import { guarded, track } from "../client.ts";
import type { AreaObservers } from "../observers.ts";
import type { CharsBucket } from "../properties.ts";
import {
  cliInstallSeen,
  createStreamPairing,
  downloadJobSeen,
  downloadPullSeen,
  engineChanges,
  type LoginPhase,
  type LoginReport,
  loginSeen,
  type OllamaLookupReason,
  providerMemory,
  rechecksResolved,
  type StreamPairing,
  terminalSeen,
} from "../welcome-providers.ts";
import type {
  AccountAction,
  DownloadOutcome,
  DownloadSource,
  EngineRef,
  FilmAction,
  FreeModelChoice,
  LocalServerVia,
  PromoCloseVia,
  ProviderAction,
  ProviderRowFace,
  ProviderSurface,
  RamBucket,
  SignInHelper,
  SignInMethod,
  SignInOutcome,
  SizeBucket,
  WelcomeExit,
} from "../welcome-vocabulary.ts";

export const WelcomeEvent = {
  WelcomeShown: "welcome_shown",
  WelcomeScreenViewed: "welcome_screen_viewed",
  WelcomeFilmInteracted: "welcome_film_interacted",
  WelcomeNextClicked: "welcome_next_clicked",
  ConnectScreenViewed: "connect_screen_viewed",
  WelcomeFinished: "welcome_finished",
  ProviderActionClicked: "provider_action_clicked",
  ProviderActionFailed: "provider_action_failed",
  CliInstallStarted: "cli_install_started",
  CliInstallFinished: "cli_install_finished",
  CliInstallRefused: "cli_install_refused",
  CliRecheckReturned: "cli_recheck_returned",
  ProviderSignInStarted: "provider_sign_in_started",
  ProviderSignInPhaseChanged: "provider_sign_in_phase_changed",
  ProviderSignInHelperUsed: "provider_sign_in_helper_used",
  ProviderSignInFinished: "provider_sign_in_finished",
  ProviderKeyChecked: "provider_key_checked",
  ProviderSignedInNotStarting: "provider_signed_in_not_starting",
  ProviderStatusChanged: "provider_status_changed",
  ProviderRowViewed: "provider_row_viewed",
  ProviderAccountChanged: "provider_account_changed",
  OpencodeFreeModelPicked: "opencode_free_model_picked",
  LocalHardwareChecked: "local_hardware_checked",
  LocalModelDownloadStarted: "local_model_download_started",
  LocalModelDownloadFinished: "local_model_download_finished",
  OllamaInstallClicked: "ollama_install_clicked",
  OllamaModelLookedUp: "ollama_model_looked_up",
  LocalModelDeleted: "local_model_deleted",
  LocalServerFound: "local_server_found",
  LocalServerConnectFinished: "local_server_connect_finished",
  ConnectModelClicked: "connect_model_clicked",
  GenexPromoShown: "genex_promo_shown",
  GenexPromoConnectFinished: "genex_promo_connect_finished",
  GenexPromoClosed: "genex_promo_closed",
} as const;

/** A press on a provider's button, wherever it stands. */
type ProviderPress = { engine: EngineRef; action: ProviderAction; surface: ProviderSurface };

/** Why a sign-in failed, as its provider's stream or call said. */
export type SignInProblem = ClaudeLoginProblem | CodexLoginProblem | OpenRouterSignInProblem;

/** A sign-in's end; a CLI that signs in in its own terminal adds how that terminal exited. */
export type SignInFinishedProperties = {
  engine: EngineRef;
  outcome: SignInOutcome;
  /** Why it failed; null when it did not, or the provider did not say. */
  problem: SignInProblem | null;
  method: SignInMethod;
  /** The last step the sign-in was on before it ended. */
  phase_at_end: LoginPhase | null;
  duration_ms: number | null;
  surface: ProviderSurface | null;
  used_code_box: boolean;
  fell_back_to_terminal: boolean;
  exit_code?: number | null;
};

/** A sign-in moving on to its next step. */
export type SignInPhaseProperties = {
  engine: EngineRef;
  phase: LoginPhase;
  method: SignInMethod;
  ms_since_start: number;
};

/** One CLI install job: provider, operation and the press credited with it. */
type CliJobProperties = {
  provider: EngineRef;
  operation: CliInstallOperation;
  surface: ProviderSurface | null;
  /** The button pressed: Update and Install both run the installer, so the job alone cannot tell. */
  button: ProviderAction | null;
};

/** An engine's status, CLI or model list changed. */
export type ProviderStatusProperties = {
  engine: EngineRef;
  from: EngineStatusCode | null;
  to: EngineStatusCode | null;
  /** Why the engine is not ready now, when it says. */
  reason: EngineStatusReason | null;
  cli_state: CodingCliState | null;
  catalog_state: ModelCatalogState | null;
  catalog_problem: ModelCatalogProblemCode | null;
  login_source: LoginSource | null;
  during_welcome: boolean;
};

/** A CLI looked for again after the person came back from installing it by hand. */
export type RecheckReturnedProperties = {
  engine: EngineRef;
  surface: ProviderSurface;
  cli_state_before: CodingCliState | null;
  cli_state_after: CodingCliState | null;
  found_after: boolean;
};

/** A local model's download ending. */
export type DownloadFinishedProperties = {
  engine: EngineRef;
  surface: ProviderSurface;
  outcome: DownloadOutcome;
  percent_at_end: number;
  /** For a failed managed install: the phase it failed in. */
  failed_phase: InstallPhase | null;
  /** For a failed download: why, as its install or pull said. */
  problem: ModelInstallProblem | ModelPullProblem | null;
  duration_ms: number;
  needs_ollama: boolean;
  left_screen_while_downloading: boolean;
};

export type WelcomeEventProperties = {
  [WelcomeEvent.WelcomeShown]: {
    reduced_motion: boolean;
    /** A welcome started on this profile earlier and never finished. */
    resumed?: boolean;
    last_screen_before?: WelcomeScreen | null;
  };
  [WelcomeEvent.WelcomeScreenViewed]: {
    screen: WelcomeScreen;
    from: WelcomeScreen;
    back: boolean;
    ms_on_previous: number;
  };
  [WelcomeEvent.WelcomeFilmInteracted]: {
    action: FilmAction;
    beat: number;
    idea_chars_bucket?: CharsBucket;
  };
  [WelcomeEvent.WelcomeNextClicked]: {
    ms_on_welcome: number;
    beat_reached: number;
    film_loops: number;
    idea_written: boolean;
    idea_chars_bucket: CharsBucket;
  };
  [WelcomeEvent.ConnectScreenViewed]: {
    claude_view: ConnectViewName;
    codex_view: ConnectViewName;
    claude_cli_state: CodingCliState | null;
    codex_cli_state: CodingCliState | null;
    engines_ready: readonly string[];
    any_ready: boolean;
  };
  [WelcomeEvent.WelcomeFinished]: {
    exit: WelcomeExit;
    screen: WelcomeScreen;
    ms_in_welcome: number;
    screens_visited: number;
    engines_ready: readonly string[];
    any_ready: boolean;
    idea_carried: boolean;
    free_model: FreeModelChoice;
    /** What waits behind the welcome failed to open (the welcome ended all the same). */
    ready_failed: boolean;
  };
  [WelcomeEvent.ProviderActionClicked]: ProviderPress;
  /** Refused at once, by the failure's code; null when it had none. */
  [WelcomeEvent.ProviderActionFailed]: ProviderPress & { code: StudioErrorCode | null };
  [WelcomeEvent.CliInstallStarted]: CliJobProperties;
  [WelcomeEvent.CliInstallFinished]: CliJobProperties & {
    phase: CliInstallPhase;
    problem: CliInstallProblem | null;
    duration_ms: number | null;
  };
  /** Refused before it started, by the refusal's code; null when the call itself failed. */
  [WelcomeEvent.CliInstallRefused]: {
    provider: EngineRef;
    operation: CliInstallOperation;
    surface: ProviderSurface | null;
    code: CliInstallRefusal | null;
  };
  [WelcomeEvent.CliRecheckReturned]: RecheckReturnedProperties;
  [WelcomeEvent.ProviderSignInStarted]: {
    engine: EngineRef;
    surface: ProviderSurface | null;
    method: SignInMethod;
    started: boolean;
    missing_cli: boolean;
  };
  [WelcomeEvent.ProviderSignInPhaseChanged]: SignInPhaseProperties;
  [WelcomeEvent.ProviderSignInHelperUsed]: {
    engine: EngineRef;
    helper: SignInHelper;
    surface: ProviderSurface | null;
    /** For a submitted code: whether the sign-in took it. */
    accepted?: boolean;
    /** For a refused code: why, as the refusal's code. */
    code?: StudioErrorCode;
    phase: LoginPhase | null;
  };
  [WelcomeEvent.ProviderSignInFinished]: SignInFinishedProperties;
  [WelcomeEvent.ProviderKeyChecked]: {
    engine: EngineRef;
    /** The status the key left the engine in; null when checking it failed. */
    result: EngineStatusCode | null;
    duration_ms: number;
    surface: ProviderSurface;
  };
  [WelcomeEvent.ProviderSignedInNotStarting]: {
    engine: EngineRef;
    catalog_problem: ModelCatalogProblemCode | null;
    surface: ProviderSurface;
  };
  [WelcomeEvent.ProviderStatusChanged]: ProviderStatusProperties;
  [WelcomeEvent.ProviderRowViewed]: {
    engine: EngineRef;
    row: ProviderRowFace;
    surface: ProviderSurface;
    cli_state: CodingCliState | null;
  };
  [WelcomeEvent.ProviderAccountChanged]: {
    engine: EngineRef;
    action: AccountAction;
    ok: boolean;
  };
  [WelcomeEvent.OpencodeFreeModelPicked]: {
    is_default: boolean;
    options_count: number;
  };
  [WelcomeEvent.LocalHardwareChecked]: {
    surface: ProviderSurface;
    ram_gb_bucket: RamBucket | null;
    has_fit: boolean;
    best_fit_engine: EngineRef | null;
    duration_ms: number;
    failed: boolean;
  };
  [WelcomeEvent.LocalModelDownloadStarted]: {
    surface: ProviderSurface;
    engine: EngineRef;
    source: DownloadSource;
    resumed: boolean;
    size_bucket: SizeBucket | null;
    /** For an Ollama model: whether Ollama answered when it started. */
    ollama_running: boolean | null;
  };
  [WelcomeEvent.LocalModelDownloadFinished]: DownloadFinishedProperties;
  [WelcomeEvent.OllamaInstallClicked]: { surface: ProviderSurface };
  [WelcomeEvent.OllamaModelLookedUp]: {
    ok: boolean;
    /** Why the lookup found nothing; null when it found the model or the call failed. */
    reason: OllamaLookupReason | null;
    fits: boolean | null;
    size_bucket: SizeBucket | null;
  };
  [WelcomeEvent.LocalModelDeleted]: { engine: EngineRef; ok: boolean };
  [WelcomeEvent.LocalServerFound]: {
    count: number;
    kinds: readonly LocalServerKind[];
    needs_key_count: number;
  };
  [WelcomeEvent.LocalServerConnectFinished]: {
    via: LocalServerVia;
    has_key: boolean;
    ok: boolean;
    problem: LocalServerProblem | null;
    kind: LocalServerKind | null;
    duration_ms: number;
  };
  [WelcomeEvent.ConnectModelClicked]: { nudged: boolean; room: Room };
  [WelcomeEvent.GenexPromoShown]: {
    at_home: boolean;
    account: NonNullable<PromoAccount> | null;
    ms_since_welcome: number | null;
  };
  [WelcomeEvent.GenexPromoConnectFinished]: {
    outcome: SignInOutcome;
    retry: boolean;
    saw_sign_in: boolean;
    duration_ms: number;
  };
  [WelcomeEvent.GenexPromoClosed]: {
    phase: PromoPhase;
    via: PromoCloseVia;
    learn_more: boolean;
    ms_visible: number;
  };
};

/** One login stream's report, sent as its event. */
function sendLogin(report: LoginReport): void {
  if (report.phase) track(WelcomeEvent.ProviderSignInPhaseChanged, report.phase);
  if (report.finished) track(WelcomeEvent.ProviderSignInFinished, report.finished);
}

/** The sign-in streams and the engines, each subscribed once here, never in the hooks that show them. */
function startStreams(app: Studio, pairing: StreamPairing, now: () => number): () => void {
  const offClaude = app.api.onClaudeLogin(
    guarded((state: ClaudeLoginState) =>
      sendLogin(loginSeen(providerMemory, pairing, { engine: EngineId.ClaudeCode, state }, now())),
    ),
  );
  const offCodex = app.api.onCodexLogin(
    guarded((state: CodexLoginState) =>
      sendLogin(loginSeen(providerMemory, pairing, { engine: EngineId.Codex, state }, now())),
    ),
  );
  const offTerminal = app.api.onTerminal(
    guarded((event) => {
      const finished = terminalSeen(providerMemory, pairing, event, now());
      if (finished) track(WelcomeEvent.ProviderSignInFinished, finished);
    }),
  );
  const offEngines = app.engines.subscribe(
    guarded((state, before) => {
      const welcoming = app.session.getState().welcoming;
      for (const change of engineChanges(before.list, state.list, welcoming))
        track(WelcomeEvent.ProviderStatusChanged, change);
      for (const recheck of rechecksResolved(providerMemory, state.list))
        track(WelcomeEvent.CliRecheckReturned, recheck);
    }),
  );
  return () => {
    offClaude();
    offCodex();
    offTerminal();
    offEngines();
  };
}

/** What this area hears: CLI installs and download progress from main's events, sign-ins and engines from their streams. */
export function createWelcomeObservers(now: () => number = Date.now): AreaObservers {
  const pairing = createStreamPairing();
  return {
    ui(event) {
      if (event.type === UiEvent.CliInstall) {
        const report = cliInstallSeen(providerMemory, pairing, event.payload, now());
        if (report.started) track(WelcomeEvent.CliInstallStarted, report.started);
        if (report.finished) track(WelcomeEvent.CliInstallFinished, report.finished);
        return;
      }
      if (event.type === UiEvent.ModelInstall) downloadJobSeen(providerMemory, event.payload);
      else if (event.type === UiEvent.ModelPull) downloadPullSeen(providerMemory, event.payload);
    },
    start: (app) => startStreams(app, pairing, now),
  };
}
