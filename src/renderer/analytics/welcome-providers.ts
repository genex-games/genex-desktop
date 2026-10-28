/**
 * The providers' lifecycles as analytics pairs them: a press, then the sign-in, install or download
 * it started, each ending once. Pure decisions over two memories — the presses the app's surfaces
 * write (`providerMemory`, one per window) and what the observer has already seen of main's streams
 * (`StreamPairing`, fresh for each start). Ids, model names and addresses stay in memory, never in
 * what leaves: every property is an engine id, a typed state, a switch, a count or a duration.
 */
import { ClaudeLoginProblem, type ClaudeLoginState, isClaudeLoginActive } from "../../shared/claude-login.ts";
import {
  type CliInstallJob,
  CliInstallOperation,
  CliInstallPhase,
  CliInstallRefusal,
} from "../../shared/cli-install.ts";
import { CodexLoginProblem, type CodexLoginState, isCodexLoginActive } from "../../shared/codex-login.ts";
import { CodingCliState } from "../../shared/coding-cli.ts";
import { MINUTE_MS } from "../../shared/duration.ts";
import { type EngineDescriptor, EngineStatusCode, EngineStatusReason } from "../../shared/engine-descriptor.ts";
import type { FoundLocalServer, LocalServerConnectResult } from "../../shared/local-server.ts";
import { ModelCatalogState } from "../../shared/model-catalog.ts";
import type { StudioErrorCode } from "../../shared/error-codes.ts";
import { errorCodeIn } from "../../shared/errors.ts";
import {
  InstallPhase,
  type ModelInstallJob,
  ModelInstallProblem,
  ModelPullProblem,
} from "../../shared/model-install.ts";
import { OpenRouterSignInProblem } from "../../shared/openrouter-login.ts";
import { EngineId } from "../../shared/providers.ts";
import type { HardwareReport, LocalModelChoice, StudioApi } from "../../shared/studio-api.ts";
import { type TerminalEvent, TerminalKind, type TerminalSession } from "../../shared/terminal.ts";
import type { ModelPullProgress } from "../../shared/ui-events.ts";
import { OpenCodeRowState } from "../panels/opencode-row.ts";
import type {
  DownloadFinishedProperties,
  ProviderStatusProperties,
  RecheckReturnedProperties,
  SignInFinishedProperties,
  SignInPhaseProperties,
  SignInProblem,
  WelcomeEvent,
  WelcomeEventProperties,
} from "./events/welcome.ts";
import { elapsedMs, oneOf } from "./properties.ts";
import {
  DownloadOutcome,
  DownloadSource,
  engineRef,
  ProviderAction,
  type ProviderRowFace,
  type ProviderSurface,
  ramBucket,
  SignInHelper,
  SignInMethod,
  SignInOutcome,
  sizeBucket,
} from "./welcome-vocabulary.ts";

/** How long a press is credited with what it starts: a sign-in or an install answers well within it. */
export const CLICK_CREDIT_MS = MINUTE_MS;

/** A step of Claude Code's or Codex's sign-in. */
export type LoginPhase = ClaudeLoginState["phase"] | CodexLoginState["phase"];
/** Why Add from Ollama found nothing, as main types it. */
export type OllamaLookupReason = Extract<Awaited<ReturnType<StudioApi["lookupModel"]>>, { ok: false }>["reason"];

/** The login steps read here; the streams type them as unions with no vocabulary yet (plan P2). */
const LOGIN_PHASE = {
  Terminal: "terminal",
  Connected: "connected",
  Failed: "failed",
  Cancelled: "cancelled",
} as const satisfies Record<string, LoginPhase>;
/** Codex's device-code sign-in. */
const DEVICE_LOGIN = "device" satisfies CodexLoginState["method"];
/** A terminal session that has ended. */
const TERMINAL_EXITED = "exited" satisfies TerminalSession["phase"];

/** How each ended login step ends the sign-in. */
const LOGIN_ENDS: Partial<Record<LoginPhase, SignInOutcome>> = {
  [LOGIN_PHASE.Connected]: SignInOutcome.Connected,
  [LOGIN_PHASE.Failed]: SignInOutcome.Failed,
  [LOGIN_PHASE.Cancelled]: SignInOutcome.Cancelled,
};

/** The CLIs that sign in in their own terminal, by the terminal's kind. */
const TERMINAL_SIGN_INS: Partial<Record<TerminalKind, EngineId>> = {
  [TerminalKind.OpenCodeLogin]: EngineId.OpenCode,
  [TerminalKind.GrokLogin]: EngineId.Grok,
  [TerminalKind.CursorLogin]: EngineId.Cursor,
};

/** How each provider's sign-in starts. */
const SIGN_IN_METHODS: Partial<Record<string, SignInMethod>> = {
  [EngineId.ClaudeCode]: SignInMethod.Piped,
  [EngineId.Codex]: SignInMethod.Browser,
  [EngineId.OpenRouter]: SignInMethod.Browser,
  [EngineId.OpenCode]: SignInMethod.TerminalTui,
  [EngineId.Grok]: SignInMethod.TerminalTui,
  [EngineId.Cursor]: SignInMethod.TerminalTui,
};

/** How a download that did not finish ended, by the installer's last phase. */
const DOWNLOAD_STOPS: Partial<Record<InstallPhase, DownloadOutcome>> = {
  [InstallPhase.Cancelled]: DownloadOutcome.Cancelled,
  [InstallPhase.Interrupted]: DownloadOutcome.Interrupted,
};

/** A press on a provider's button. */
export interface Click {
  surface: ProviderSurface;
  action: ProviderAction | null;
  at: number;
}

/** A sign-in under way, from its press or its first step. */
export interface SignInAttempt {
  surface: ProviderSurface | null;
  method: SignInMethod;
  startedAt: number;
  phase: LoginPhase | null;
  usedCodeBox: boolean;
  fellBackToTerminal: boolean;
  /** Cancel was pressed on a CLI's own terminal sign-in. */
  cancelRequested: boolean;
}

/** A local model's download, from its press to its end. */
export interface DownloadAttempt {
  surface: ProviderSurface;
  engine: EngineId;
  startedAt: number;
  percent: number;
  phase: InstallPhase | null;
  /** The phase a managed install failed in, as its job said. */
  failedPhase: InstallPhase | null;
  /** Why it failed, as its job or its pull said. */
  problem: ModelInstallProblem | ModelPullProblem | null;
  /** The screen it started on closed while it ran. */
  left: boolean;
}

/** A CLI looked for again after the person came back to the window. */
export interface RecheckPending {
  engine: string;
  surface: ProviderSurface;
  before: CodingCliState | null;
}

/** What the app's surfaces wrote: presses, the sign-ins and downloads they started, rechecks, the welcome's end. */
export interface ProviderMemory {
  clicks: Map<string, Click>;
  signIns: Map<string, SignInAttempt>;
  /** By model id, which never leaves. */
  downloads: Map<string, DownloadAttempt>;
  rechecks: RecheckPending[];
  welcomeEndedAt: number | null;
}

/** An empty memory. */
export function createProviderMemory(): ProviderMemory {
  return { clicks: new Map(), signIns: new Map(), downloads: new Map(), rechecks: [], welcomeEndedAt: null };
}

/** The window's memory, written by the surfaces and read by the observer. */
export const providerMemory = createProviderMemory();

/** What the observer has seen of main's streams, so each step is told once. */
export interface StreamPairing {
  loginRevisions: Map<string, number>;
  loginPhases: Map<string, LoginPhase>;
  cliJobs: Map<string, { startedAt: string; surface: ProviderSurface | null; button: ProviderAction | null }>;
  cliTold: Set<string>;
  terminalsEnded: Set<string>;
}

/** An empty pairing. */
export function createStreamPairing(): StreamPairing {
  return {
    loginRevisions: new Map(),
    loginPhases: new Map(),
    cliJobs: new Map(),
    cliTold: new Set(),
    terminalsEnded: new Set(),
  };
}

type Props<E extends keyof WelcomeEventProperties> = WelcomeEventProperties[E];

/** Remember a press on `engine`'s button and say what it was. */
export function providerPressed(
  memory: ProviderMemory,
  press: { engine: string; action: ProviderAction; surface: ProviderSurface },
  now: number,
): Props<typeof WelcomeEvent.ProviderActionClicked> {
  memory.clicks.set(press.engine, { surface: press.surface, action: press.action, at: now });
  return { engine: engineRef(press.engine), action: press.action, surface: press.surface };
}

/** The press credited with what `engine` starts now: the last one, if recent. */
export function creditedClick(memory: ProviderMemory, engine: string, now: number): Click | null {
  const click = memory.clicks.get(engine);
  return click && now - click.at <= CLICK_CREDIT_MS ? click : null;
}

/** The method a provider's sign-in starts with. */
export const signInMethod = (engine: string): SignInMethod => SIGN_IN_METHODS[engine] ?? SignInMethod.Browser;

/** A sign-in was asked for: say whether it started, and follow it when it did. */
export function signInStarted(
  memory: ProviderMemory,
  start: { engine: string; started: boolean; missingCli: boolean },
  now: number,
): Props<typeof WelcomeEvent.ProviderSignInStarted> {
  const surface = creditedClick(memory, start.engine, now)?.surface ?? null;
  const method = signInMethod(start.engine);
  if (start.started) memory.signIns.set(start.engine, newAttempt(surface, method, now));
  return {
    engine: engineRef(start.engine),
    surface,
    method,
    started: start.started,
    missing_cli: start.missingCli,
  };
}

function newAttempt(surface: ProviderSurface | null, method: SignInMethod, now: number): SignInAttempt {
  return {
    surface,
    method,
    startedAt: now,
    phase: null,
    usedCodeBox: false,
    fellBackToTerminal: false,
    cancelRequested: false,
  };
}

/** A help beside a sign-in was used; the code box marks the sign-in as one that needed it. */
export function signInHelperUsed(
  memory: ProviderMemory,
  use: {
    engine: string;
    helper: SignInHelper;
    surface?: ProviderSurface;
    accepted?: boolean;
    phase?: LoginPhase;
    /** Why a submitted code was refused, as its failure's code. */
    code?: StudioErrorCode | null;
  },
  now: number,
): Props<typeof WelcomeEvent.ProviderSignInHelperUsed> {
  const attempt = memory.signIns.get(use.engine);
  const codeBox = use.helper === SignInHelper.CodeBoxOpened || use.helper === SignInHelper.CodeSubmitted;
  if (attempt && codeBox) attempt.usedCodeBox = true;
  const surface = use.surface ?? creditedClick(memory, use.engine, now)?.surface ?? attempt?.surface ?? null;
  // A retry starts a sign-in of its own, credited where the first one was pressed.
  if (surface && use.helper === SignInHelper.Retried) memory.clicks.set(use.engine, { surface, action: null, at: now });
  const accepted = use.accepted === undefined ? {} : { accepted: use.accepted };
  const refused = use.code ? { code: use.code } : {};
  const phase = use.phase ?? attempt?.phase ?? null;
  return { engine: engineRef(use.engine), helper: use.helper, surface, ...accepted, ...refused, phase };
}

/** A sign-in's problem, when it is one of the providers' own words for it: never free text. */
export const signInProblem = (value: unknown): SignInProblem | null =>
  oneOf(ClaudeLoginProblem, value) ?? oneOf(CodexLoginProblem, value) ?? oneOf(OpenRouterSignInProblem, value);

/** A sign-in that settles in one call (OpenRouter's browser sign-in) ended; a failure may say why. */
export function signInSettled(
  memory: ProviderMemory,
  end: { engine: string; outcome: SignInOutcome; problem?: unknown },
  now: number,
): SignInFinishedProperties {
  const attempt = memory.signIns.get(end.engine) ?? null;
  memory.signIns.delete(end.engine);
  const problem = end.outcome === SignInOutcome.Failed ? signInProblem(end.problem) : null;
  return loginEnded(end.engine, end.outcome, attempt, now, problem);
}

/** A provider row's face, as a visit first shows it. */
export function rowViewed(row: {
  engine: string;
  face: ProviderRowFace;
  surface: ProviderSurface;
  cliState: CodingCliState | null | undefined;
}): Props<typeof WelcomeEvent.ProviderRowViewed> {
  return { engine: engineRef(row.engine), row: row.face, surface: row.surface, cli_state: row.cliState ?? null };
}

/** Cancel was pressed on a CLI's own terminal sign-in: its exit is a cancel, not a failure. */
export function terminalSignInCancelled(memory: ProviderMemory, engine: string): void {
  const attempt = memory.signIns.get(engine);
  if (attempt) attempt.cancelRequested = true;
}

/** One login stream's news: the step it moved to, or how it ended. */
export interface LoginReport {
  phase?: SignInPhaseProperties;
  finished?: SignInFinishedProperties;
}

/** A Claude Code or Codex sign-in state, as its stream sends it. */
export type LoginUpdate =
  | { engine: typeof EngineId.ClaudeCode; state: ClaudeLoginState }
  | { engine: typeof EngineId.Codex; state: CodexLoginState };

const loginActive = (update: LoginUpdate): boolean =>
  update.engine === EngineId.Codex ? isCodexLoginActive(update.state) : isClaudeLoginActive(update.state);

/** Is this state news: newer than the last one seen, and on another step? */
function freshStep(pairing: StreamPairing, engine: string, state: { revision: number; phase: LoginPhase }): boolean {
  const seen = pairing.loginRevisions.get(engine);
  if (seen !== undefined && state.revision <= seen) return false;
  pairing.loginRevisions.set(engine, state.revision);
  const before = pairing.loginPhases.get(engine);
  pairing.loginPhases.set(engine, state.phase);
  return before !== state.phase;
}

/**
 * A sign-in stream's state: a new active step is told with the time since the sign-in started; an
 * ended one ends the sign-in, once. A state already seen, or the same step again, says nothing.
 */
export function loginSeen(
  memory: ProviderMemory,
  pairing: StreamPairing,
  update: LoginUpdate,
  now: number,
): LoginReport {
  const { engine, state } = update;
  if (!freshStep(pairing, engine, state)) return {};
  if (loginActive(update)) return { phase: stepTaken(memory, update, now) };
  const outcome = LOGIN_ENDS[state.phase];
  const attempt = memory.signIns.get(engine);
  // An end with no press and no step seen before it is an old sign-in's, not news.
  if (!outcome || !attempt) return {};
  memory.signIns.delete(engine);
  const problem = outcome === SignInOutcome.Failed ? signInProblem(state.problem) : null;
  return { finished: loginEnded(engine, outcome, attempt, now, problem) };
}

function stepTaken(memory: ProviderMemory, update: LoginUpdate, now: number): SignInPhaseProperties {
  const { engine, state } = update;
  let attempt = memory.signIns.get(engine);
  if (!attempt) {
    attempt = newAttempt(creditedClick(memory, engine, now)?.surface ?? null, signInMethod(engine), now);
    memory.signIns.set(engine, attempt);
  }
  if (update.engine === EngineId.Codex && update.state.method === DEVICE_LOGIN) attempt.method = SignInMethod.Device;
  if (state.phase === LOGIN_PHASE.Terminal) attempt.fellBackToTerminal = true;
  attempt.phase = state.phase;
  return {
    engine: engineRef(engine),
    phase: state.phase,
    method: attempt.method,
    ms_since_start: elapsedMs(attempt.startedAt, now),
  };
}

function loginEnded(
  engine: string,
  outcome: SignInOutcome,
  attempt: SignInAttempt | null,
  now: number,
  problem: SignInProblem | null = null,
): SignInFinishedProperties {
  return {
    engine: engineRef(engine),
    outcome,
    problem,
    method: attempt?.method ?? signInMethod(engine),
    phase_at_end: attempt?.phase ?? null,
    duration_ms: attempt ? elapsedMs(attempt.startedAt, now) : null,
    surface: attempt?.surface ?? null,
    used_code_box: attempt?.usedCodeBox ?? false,
    fell_back_to_terminal: attempt?.fellBackToTerminal ?? false,
  };
}

/**
 * A terminal event: a CLI's own sign-in terminal that exited ends its sign-in, once — cancelled
 * when Cancel was pressed, connected when the CLI exited cleanly, failed otherwise.
 */
export function terminalSeen(
  memory: ProviderMemory,
  pairing: StreamPairing,
  event: TerminalEvent,
  now: number,
): SignInFinishedProperties | null {
  if (event.type !== "session") return null;
  const { session } = event;
  const engine = TERMINAL_SIGN_INS[session.kind];
  if (!engine || session.phase !== TERMINAL_EXITED || pairing.terminalsEnded.has(session.id)) return null;
  pairing.terminalsEnded.add(session.id);
  const attempt = memory.signIns.get(engine) ?? null;
  memory.signIns.delete(engine);
  const exitCode = session.exitCode ?? null;
  const outcome = terminalOutcome(attempt, exitCode);
  return {
    ...loginEnded(engine, outcome, attempt, now),
    method: SignInMethod.TerminalTui,
    exit_code: exitCode,
  };
}

function terminalOutcome(attempt: SignInAttempt | null, exitCode: number | null): SignInOutcome {
  if (attempt?.cancelRequested) return SignInOutcome.Cancelled;
  return exitCode === 0 ? SignInOutcome.Connected : SignInOutcome.Failed;
}

/** One CLI install event's news: the job started, ended, or both. */
export interface CliInstallReport {
  started?: Props<typeof WelcomeEvent.CliInstallStarted>;
  finished?: Props<typeof WelcomeEvent.CliInstallFinished>;
}

/** How long a job ran, from main's own stamps; null when one is missing or unreadable. */
function jobDuration(job: CliInstallJob): number | null {
  const from = Date.parse(job.startedAt);
  const to = job.finishedAt ? Date.parse(job.finishedAt) : Number.NaN;
  return Number.isFinite(from) && Number.isFinite(to) ? elapsedMs(from, to) : null;
}

/**
 * An install job's report: its start once and its end once, each credited to the press that
 * started it (the button: Update and Install both run the installer).
 */
export function cliInstallSeen(
  memory: ProviderMemory,
  pairing: StreamPairing,
  job: CliInstallJob,
  now: number,
): CliInstallReport {
  const known = pairing.cliJobs.get(job.provider);
  const record = known?.startedAt === job.startedAt ? known : creditJob(memory, job, now);
  pairing.cliJobs.set(job.provider, record);
  const base = {
    provider: engineRef(job.provider),
    operation: job.operation ?? CliInstallOperation.Install,
    surface: record.surface,
    button: record.button,
  };
  const step = job.phase === CliInstallPhase.Installing ? "started" : "finished";
  const key = `${job.provider}\n${job.startedAt}\n${step}`;
  if (pairing.cliTold.has(key)) return {};
  pairing.cliTold.add(key);
  if (job.phase === CliInstallPhase.Installing) return { started: base };
  return {
    finished: { ...base, phase: job.phase, problem: job.problem ?? null, duration_ms: jobDuration(job) },
  };
}

function creditJob(memory: ProviderMemory, job: CliInstallJob, now: number) {
  const click = creditedClick(memory, job.provider, now);
  return { startedAt: job.startedAt, surface: click?.surface ?? null, button: click?.action ?? null };
}

/** An install or update refused before it started, by the refusal's code (null when the call itself failed). */
export function cliInstallRefused(
  memory: ProviderMemory,
  refusal: { provider: string; operation: CliInstallOperation; error: unknown },
  now: number,
): Props<typeof WelcomeEvent.CliInstallRefused> {
  return {
    provider: engineRef(refusal.provider),
    operation: refusal.operation,
    surface: creditedClick(memory, refusal.provider, now)?.surface ?? null,
    code: errorCodeIn(CliInstallRefusal, refusal.error),
  };
}

/** What a status change compares: the status, the CLI, and whether the model list is unavailable. */
function engineFacts(engine: EngineDescriptor | undefined) {
  return {
    status: engine?.status.code ?? null,
    reason: oneOf(EngineStatusReason, engine?.status.reason),
    cli: engine?.account?.cli.state ?? null,
    unlisted: engine?.catalog?.state === ModelCatalogState.Unavailable,
  };
}

function statusChange(
  id: string,
  before: EngineDescriptor | undefined,
  after: EngineDescriptor | undefined,
  duringWelcome: boolean,
): ProviderStatusProperties | null {
  const was = engineFacts(before);
  const is = engineFacts(after);
  const same =
    was.status === is.status && was.reason === is.reason && was.cli === is.cli && was.unlisted === is.unlisted;
  if (same) return null;
  return {
    engine: engineRef(id),
    from: was.status,
    to: is.status,
    reason: is.reason,
    cli_state: is.cli,
    catalog_state: after?.catalog?.state ?? null,
    catalog_problem: after?.catalog?.problem?.code ?? null,
    login_source: after?.account?.source ?? null,
    during_welcome: duringWelcome,
  };
}

/**
 * Every engine whose status, CLI or model list's availability changed between two lists. The first
 * list a window reads is where it starts, not news.
 */
export function engineChanges(
  before: readonly EngineDescriptor[],
  after: readonly EngineDescriptor[],
  duringWelcome: boolean,
): ProviderStatusProperties[] {
  if (before.length === 0 || before === after) return [];
  const ids = [...new Set([...before, ...after].map((engine) => engine.id))];
  return ids.flatMap((id) => {
    const change = statusChange(
      id,
      before.find((engine) => engine.id === id),
      after.find((engine) => engine.id === id),
      duringWelcome,
    );
    return change ? [change] : [];
  });
}

/** The person came back to the window and a missing CLI is looked for again: told on the next engines list. */
export function recheckOnReturn(memory: ProviderMemory, pending: RecheckPending): void {
  memory.rechecks = [...memory.rechecks.filter((recheck) => recheck.engine !== pending.engine), pending];
}

/** The rechecks a new engines list answers, each told once. */
export function rechecksResolved(
  memory: ProviderMemory,
  list: readonly EngineDescriptor[],
): RecheckReturnedProperties[] {
  const answered = memory.rechecks.filter((recheck) => list.some((engine) => engine.id === recheck.engine));
  if (answered.length === 0) return [];
  memory.rechecks = memory.rechecks.filter((recheck) => !answered.includes(recheck));
  return answered.map((recheck) => {
    const after = list.find((engine) => engine.id === recheck.engine)?.account?.cli.state ?? null;
    return {
      engine: engineRef(recheck.engine),
      surface: recheck.surface,
      cli_state_before: recheck.before,
      cli_state_after: after,
      found_after: after === CodingCliState.Ready,
    };
  });
}

/** Is a signed-in CLI one Genex could not start (its model list never loaded), with no check running? */
export function signedInNotStarting(engine: Pick<EngineDescriptor, "status" | "catalog"> | undefined): boolean {
  if (engine?.status.code !== EngineStatusCode.Ready) return false;
  return engine.catalog?.state === ModelCatalogState.Unavailable && !engine.catalog.refreshing;
}

/** A signed-in CLI that could not start, as a surface shows it. */
export function notStartingShown(
  engine: Pick<EngineDescriptor, "id" | "catalog">,
  surface: ProviderSurface,
): Props<typeof WelcomeEvent.ProviderSignedInNotStarting> {
  return { engine: engineRef(engine.id), catalog_problem: engine.catalog?.problem?.code ?? null, surface };
}

/** The local engine a catalog model runs on: Bonsai's own, else Ollama. */
export const localEngine = (engine: string | undefined): EngineId =>
  engine === EngineId.Bonsai ? EngineId.Bonsai : EngineId.Ollama;

/** The model a recommendation calls Best fit, or its first pick. */
function bestPick(report: HardwareReport): LocalModelChoice | null {
  const { picks, defaultModel } = report.recommendation;
  return picks.find((pick) => pick.model === defaultModel) ?? picks[0] ?? null;
}

/** This Mac examined for local models: its memory's bucket, whether anything fits, and on which engine. */
export function hardwareChecked(
  surface: ProviderSurface,
  report: HardwareReport | null,
  durationMs: number,
): Props<typeof WelcomeEvent.LocalHardwareChecked> {
  const pick = report ? bestPick(report) : null;
  return {
    surface,
    ram_gb_bucket: report ? ramBucket(report.hardware.ramGb) : null,
    has_fit: pick !== null,
    best_fit_engine: pick ? localEngine(pick.engine) : null,
    duration_ms: durationMs,
    failed: report === null,
  };
}

/** Where a catalog model sits in the recommendation: Best fit, another pick, or under More models. */
export function downloadSource(report: HardwareReport | null, model: string): DownloadSource {
  const recommendation = report?.recommendation;
  if (recommendation?.defaultModel === model) return DownloadSource.BestFit;
  if (recommendation?.picks.some((pick) => pick.model === model)) return DownloadSource.Pick;
  if (recommendation?.more.some((pick) => pick.model === model)) return DownloadSource.More;
  return DownloadSource.OllamaLookup;
}

/** A download's start, as its press describes it; the model id stays in memory only. */
export interface DownloadStart {
  model: string;
  surface: ProviderSurface;
  engine: string | undefined;
  source: DownloadSource;
  resumed: boolean;
  sizeGb: number | null;
  /** Ollama's engine as the press saw it; undefined for a Bonsai model. */
  ollama?: Pick<EngineDescriptor, "status"> | undefined;
}

/** A download was pressed: follow it, and say what it is. */
export function downloadStarted(
  memory: ProviderMemory,
  start: DownloadStart,
  now: number,
): Props<typeof WelcomeEvent.LocalModelDownloadStarted> {
  const engine = localEngine(start.engine);
  memory.downloads.set(start.model, {
    surface: start.surface,
    engine,
    startedAt: now,
    percent: 0,
    phase: null,
    failedPhase: null,
    problem: null,
    left: false,
  });
  const ollamaRunning = engine === EngineId.Ollama ? start.ollama?.status.code === EngineStatusCode.Ready : null;
  return {
    surface: start.surface,
    engine,
    source: start.source,
    resumed: start.resumed,
    size_bucket: start.sizeGb === null ? null : sizeBucket(start.sizeGb),
    ollama_running: ollamaRunning,
  };
}

const share = (completed: number | undefined, total: number | undefined): number | null =>
  total ? Math.min(100, Math.max(0, Math.round(((completed ?? 0) / total) * 100))) : null;

/** A Bonsai install job's report: its phase and how far it got. */
export function downloadJobSeen(memory: ProviderMemory, job: ModelInstallJob): void {
  const attempt = memory.downloads.get(job.model);
  if (!attempt) return;
  attempt.phase = job.phase;
  attempt.percent = share(job.completed, job.total) ?? attempt.percent;
  attempt.failedPhase = oneOf(InstallPhase, job.failedPhase) ?? attempt.failedPhase;
  attempt.problem = oneOf(ModelInstallProblem, job.problem) ?? attempt.problem;
}

/** A pull's progress: how far it got, and why it failed when it says. */
export function downloadPullSeen(memory: ProviderMemory, pull: { model: string; progress: ModelPullProgress }): void {
  const attempt = memory.downloads.get(pull.model);
  if (!attempt) return;
  attempt.percent = share(pull.progress.completed, pull.progress.total) ?? attempt.percent;
  const { problem } = pull.progress;
  attempt.problem = oneOf(ModelInstallProblem, problem) ?? oneOf(ModelPullProblem, problem) ?? attempt.problem;
}

/** Why a download's call failed, by its code: a managed install's problem or a pull's. */
function downloadProblem(error: unknown): ModelInstallProblem | ModelPullProblem | null {
  return errorCodeIn(ModelInstallProblem, error) ?? errorCodeIn(ModelPullProblem, error);
}

/** The screen a download started on closed while it ran. */
export function downloadsLeft(memory: ProviderMemory, surface: ProviderSurface): void {
  for (const attempt of memory.downloads.values()) if (attempt.surface === surface) attempt.left = true;
}

/**
 * A download's press settled: ready when it resolved, else how the installer last said it stopped
 * (cancelled, interrupted) or failed. Null for a download this window never saw start.
 */
export function downloadFinished(
  memory: ProviderMemory,
  end: { model: string; ok: boolean; ollama: Pick<EngineDescriptor, "status"> | undefined; error?: unknown },
  now: number,
): DownloadFinishedProperties | null {
  const attempt = memory.downloads.get(end.model);
  if (!attempt) return null;
  memory.downloads.delete(end.model);
  const stopped = attempt.phase ? DOWNLOAD_STOPS[attempt.phase] : undefined;
  const outcome = end.ok ? DownloadOutcome.Ready : (stopped ?? DownloadOutcome.Failed);
  const needsOllama =
    !end.ok && attempt.engine === EngineId.Ollama && end.ollama?.status.code === EngineStatusCode.NotRunning;
  return {
    engine: attempt.engine,
    surface: attempt.surface,
    outcome,
    percent_at_end: end.ok ? 100 : attempt.percent,
    failed_phase: outcome === DownloadOutcome.Failed ? attempt.failedPhase : null,
    problem: outcome === DownloadOutcome.Failed ? (attempt.problem ?? downloadProblem(end.error)) : null,
    duration_ms: elapsedMs(attempt.startedAt, now),
    needs_ollama: needsOllama,
    left_screen_while_downloading: attempt.left,
  };
}

/** Add from Ollama's answer: found and whether it fits, or why not; never the name looked up. */
export function ollamaLookedUp(
  lookup: Awaited<ReturnType<StudioApi["lookupModel"]>> | null,
): Props<typeof WelcomeEvent.OllamaModelLookedUp> {
  if (!lookup) return { ok: false, reason: null, fits: null, size_bucket: null };
  if (!lookup.ok) return { ok: false, reason: lookup.reason, fits: null, size_bucket: null };
  return { ok: true, reason: null, fits: lookup.fits, size_bucket: sizeBucket(lookup.sizeGb) };
}

/** The servers found on this computer: how many, which software, how many want a key. */
export function localServersFound(servers: readonly FoundLocalServer[]): Props<typeof WelcomeEvent.LocalServerFound> {
  const kinds = [...new Set(servers.flatMap((server) => (server.kind ? [server.kind] : [])))].sort();
  return { count: servers.length, kinds, needs_key_count: servers.filter((server) => server.needsKey).length };
}

/** A local server's Connect answered, or failed to (`result` null): never its address or key. */
export function localServerConnected(
  attempt: { via: Props<typeof WelcomeEvent.LocalServerConnectFinished>["via"]; hasKey: boolean },
  result: LocalServerConnectResult | null,
  durationMs: number,
): Props<typeof WelcomeEvent.LocalServerConnectFinished> {
  const refusal = result && !result.ok ? result : null;
  return {
    via: attempt.via,
    has_key: attempt.hasKey,
    ok: result?.ok === true,
    problem: refusal?.problem ?? null,
    kind: refusal?.kind ?? null,
    duration_ms: durationMs,
  };
}

/** What a CLI row's install button is: Update for a CLI too old to run, else Install. */
export const cliInstallAction = (row: OpenCodeRowState): ProviderAction =>
  row === OpenCodeRowState.Outdated ? ProviderAction.Update : ProviderAction.Install;

/** What a CLI row's recheck is: Try again when it did not answer, Check connection once it runs, else Check again. */
export function cliRecheckAction(row: OpenCodeRowState): ProviderAction {
  if (row === OpenCodeRowState.Unreachable) return ProviderAction.TryAgain;
  const runs = row === OpenCodeRowState.FreeOnly || row === OpenCodeRowState.Connected;
  return runs ? ProviderAction.CheckConnection : ProviderAction.Recheck;
}
