/**
 * The plan watcher as main runs it (§3.7, P4b): while Studio is open and the person's switch is on
 * (off by default), this Mac answers genex.games' plan-funded jobs with the person's own Claude
 * Code (or Codex, only behind its read-deny check), so a web game in any browser or a published
 * game in Play is answered on their plan. genex.games queues each call, keeps the ledger, the
 * limits, `waiting_for_plan`, Stop and the 24-hour life; this only works the queue.
 *
 * It drives `player-loop.ts` one pass at a time on injectable timers: passes claim nothing while
 * a build runs (the builder shares the plan), a nudge from a Play game polls at once, and a stop
 * hands any row in flight straight back. The Genex player credential (`player-sign-in.ts`) lives
 * in the secret store; genex.games refusing it ends the sign-in and forgets it, and its version
 * floor stops the watcher until the app is updated. Settings reads `view()`; the IPC module is
 * `main/ipc/plan-watcher.ts`. Logs carry ids, codes and timings only.
 */
import path from "node:path";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { isPlainRecord } from "../../shared/game-ai.ts";
import {
  AiWatcherProblem,
  AiWatcherRunner,
  AiWatcherSignIn,
  AiWatcherState,
  type AiWatcherView,
} from "../../shared/game-ai-watcher.ts";
import type { ProviderUsage } from "../../shared/provider-usage.ts";
import { atomicWriteText, readRegularFile } from "../../substrate/fsx.ts";
import type { ApiKeyStore } from "../../substrate/provider-keys.ts";
import { createPlayerClient } from "./player-api.ts";
import {
  type PassResult,
  type WatcherRunners,
  type WatcherSession,
  WatcherStop,
  type WatcherStopInfo,
  createWatcherSession,
} from "./player-loop.ts";
import {
  type RunnerInstall,
  type RunnerProbeResult,
  type RunnerSandboxFactory,
  probeRunner,
  runJob,
  runnerInstall,
} from "./player-runner.ts";
import {
  type PendingSignIn,
  type PlayerCredential,
  SignInPoll,
  pollPlayerSignIn,
  readPlayerCredential,
  startPlayerSignIn,
  writePlayerCredential,
} from "./player-sign-in.ts";
import type { GameAiPlanWatcher } from "./types.ts";

/** How long after Studio starts the first pass runs: the app's own start comes first. */
const START_DELAY_MS = 10 * SECOND_MS;
/** How long a passed probe is trusted before the CLI is checked again. */
const PROBE_TRUST_MS = 30 * MINUTE_MS;
/** The most of the switch file that is read. */
const SETTINGS_MAX_BYTES = 4096;
/** The most of `genex player`'s state file that is read. */
const CLI_STATE_MAX_BYTES = 64 * 1024;
/** `genex player` counts as answering when it beat this recently (genex.games' own online window is 90 s). */
const CLI_FRESH_MS = 3 * MINUTE_MS;
/** The switch file's shape version. */
const SETTINGS_VERSION = 1;
/** A watcher id as genex.games issues them. */
const WATCHER_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Timers the watcher runs on; a test holds them. */
export interface WatcherTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Real timers that never keep the app alive on their own. */
export const REAL_WATCHER_TIMERS: WatcherTimers = {
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** What the watcher runs on; every part is replaceable in a test. */
export interface PlanWatcherDeps {
  /** Play's API origin, which the player credential is bound to. */
  api: string;
  /** Play's website, which the sign-in's approval page must be a page of. */
  web: string;
  /** The app's version, which every genex.games call reports. */
  version: string;
  /** `process.platform`, as the heartbeat reports it. */
  platform: string;
  /** This Mac's name on genex.games' watcher list. */
  label: string;
  /** The person's home folder, which every job's box denies reading. */
  home: string;
  /** The studio's environment, for a CLI whose discovery named none of its own; filtered for each CLI (`runnerEnv`). */
  env: Readonly<Record<string, string | undefined>>;
  /** The secret holding the player credential (`GENEX_PLAYER_CREDENTIAL_SECRET`). */
  credential: ApiKeyStore;
  /** The switch and the watcher's id: `userData/game-ai/watcher.json`. */
  stateFile: string;
  /** Where each job's own folder is made. */
  tmpRoot: string;
  /** A folder inside the home folder the probe's canary is written to. */
  canaryDir: string;
  sandbox: RunnerSandboxFactory;
  /** The CLI as this Mac has it installed, with the environment it was found with (its toolchain's PATH), or null. */
  findCli(runner: AiWatcherRunner): Promise<FoundCli | null>;
  /** Whether Codex is signed in to a ChatGPT plan outside any box (to tell "held" from "not set up"). */
  codexSignedIn(): Promise<boolean>;
  /** A plan's windows, as Settings → Usage reads them. */
  planUsage(runner: AiWatcherRunner): Promise<ProviderUsage | null>;
  /** Settings' keep-for-building share. */
  keepForBuildingPercent(): Promise<number>;
  /** Whether `genex player` also answers on this Mac. */
  cliWatcher(): Promise<boolean>;
  /** Open the sign-in's approval page in the person's browser. */
  openSignIn(url: string): Promise<void>;
  /** The view changed: Settings reads it again. */
  notify(): void;
  log(line: string): void;
  clock: { now(): number };
  timers: WatcherTimers;
  fetch: typeof fetch;
  random(): number;
}

/** A CLI as discovery found it. */
export interface FoundCli {
  binary: string;
  env: Readonly<Record<string, string | undefined>>;
}

/** The switch file as the watcher writes it. */
interface WatcherSettings {
  enabled: boolean;
  watcherId: string | null;
}

/** A probe's result and when it was taken. */
interface Probe {
  result: RunnerProbeResult;
  at: number;
}

/** Everything the watcher holds between calls. */
interface WatcherCore {
  deps: PlanWatcherDeps;
  settings: WatcherSettings;
  loaded: Promise<void> | null;
  started: boolean;
  building: boolean;
  credential: PlayerCredential | null;
  /** genex.games refused the credential: sign in again. */
  ended: boolean;
  /** genex.games no longer serves this version. */
  fatal: WatcherStopInfo | null;
  session: WatcherSession | null;
  passes: number;
  timer: unknown;
  running: Promise<void> | null;
  controller: AbortController | null;
  pending: PendingSignIn | null;
  pollTimer: unknown;
  polling: Promise<void> | null;
  probes: Map<string, Probe>;
  /** Each advertised CLI's own environment, from its discovery. */
  cliEnv: Map<AiWatcherRunner, Readonly<Record<string, string | undefined>>>;
  /** The last view Settings was told about, to notify on change only. */
  told: string;
}

// ── the switch file ──────────────────────────────────────────────────────────────────────────

/** The switch file, or the defaults (off, no id) when it is missing or is not one the watcher wrote. */
async function readSettings(file: string): Promise<WatcherSettings> {
  const off: WatcherSettings = { enabled: false, watcherId: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse((await readRegularFile(file, SETTINGS_MAX_BYTES)).toString("utf8"));
  } catch {
    return off;
  }
  if (!isPlainRecord(parsed) || parsed.v !== SETTINGS_VERSION || typeof parsed.enabled !== "boolean") return off;
  const id = parsed.watcherId;
  return { enabled: parsed.enabled, watcherId: typeof id === "string" && WATCHER_ID_RE.test(id) ? id : null };
}

async function saveSettings(core: WatcherCore): Promise<void> {
  const { enabled, watcherId } = core.settings;
  await atomicWriteText(core.deps.stateFile, JSON.stringify({ v: SETTINGS_VERSION, enabled, watcherId }), {
    mode: 0o600,
  });
}

/** The switch file and the credential, read once. A locked secret store reads as signed out. */
function load(core: WatcherCore): Promise<void> {
  core.loaded ??= (async () => {
    core.settings = await readSettings(core.deps.stateFile);
    const raw = await core.deps.credential.read().catch(() => null);
    core.credential = readPlayerCredential(raw, core.deps.api, core.deps.clock.now());
  })();
  return core.loaded;
}

// ── the CLIs this Mac answers with ───────────────────────────────────────────────────────────

/** A CLI's probe, trusted for a while once it passed; a failed one is taken again at the next refresh. */
async function probed(
  core: WatcherCore,
  install: RunnerInstall,
  env: Readonly<Record<string, string | undefined>>,
): Promise<RunnerProbeResult> {
  const key = `${install.runner}\u0000${install.binary}`;
  const now = core.deps.clock.now();
  const kept = core.probes.get(key);
  if (kept?.result.ok && now - kept.at < PROBE_TRUST_MS) return kept.result;
  const { deps } = core;
  const result = await probeRunner(install, {
    sandbox: deps.sandbox,
    tmpRoot: deps.tmpRoot,
    home: deps.home,
    parentEnv: env,
    canaryDir: deps.canaryDir,
  });
  core.probes.set(key, { result, at: now });
  if (!result.ok) deps.log(`player: ${install.runner} not advertised (${result.failure})`);
  return result;
}

/** The CLIs that passed their probe; Codex signed in but failing its check is held, never advertised. */
async function detectRunners(core: WatcherCore): Promise<WatcherRunners> {
  const installs: RunnerInstall[] = [];
  let codexHeld = false;
  for (const runner of [AiWatcherRunner.Claude, AiWatcherRunner.Codex]) {
    const found = await core.deps.findCli(runner).catch(() => null);
    if (!found) continue;
    const install = await runnerInstall(runner, found.binary, found.env, core.deps.home);
    core.cliEnv.set(runner, found.env);
    if ((await probed(core, install, found.env)).ok) installs.push(install);
    else if (runner === AiWatcherRunner.Codex) codexHeld = await core.deps.codexSignedIn().catch(() => false);
  }
  return { installs, codexHeld };
}

/** A loop session for the signed-in credential. */
function newSession(core: WatcherCore, credential: PlayerCredential): WatcherSession {
  const { deps } = core;
  const client = createPlayerClient({
    api: credential.api,
    token: credential.token,
    version: deps.version,
    fetch: deps.fetch,
  });
  return createWatcherSession({
    client,
    clock: deps.clock,
    platform: deps.platform,
    label: deps.label,
    watcherId: core.settings.watcherId,
    runners: () => detectRunners(core),
    runJob: (job, run) =>
      runJob(job, {
        ...run,
        sandbox: deps.sandbox,
        tmpRoot: deps.tmpRoot,
        home: deps.home,
        parentEnv: core.cliEnv.get(run.install.runner) ?? deps.env,
      }),
    planUsage: (runner) => deps.planUsage(runner),
    keepForBuildingPercent: () => deps.keepForBuildingPercent(),
    log: (line) => deps.log(line),
    repeat: (ms, fn) => repeatOn(deps.timers, ms, fn),
    random: () => deps.random(),
  });
}

/** Call `fn` every `ms` on `timers` until the returned cancel runs. */
function repeatOn(timers: WatcherTimers, ms: number, fn: () => void): () => void {
  let handle: unknown = null;
  let live = true;
  const arm = (): void => {
    handle = timers.setTimeout(() => {
      if (!live) return;
      fn();
      arm();
    }, ms);
  };
  arm();
  return () => {
    live = false;
    timers.clearTimeout(handle);
  };
}

// ── the passes ───────────────────────────────────────────────────────────────────────────────

/** Whether passes run: started, switched on, signed in, and served by genex.games. */
const active = (core: WatcherCore): boolean =>
  core.started && core.settings.enabled && core.credential !== null && core.fatal === null;

function clearTimer(core: WatcherCore): void {
  if (core.timer === null) return;
  core.deps.timers.clearTimeout(core.timer);
  core.timer = null;
}

function schedule(core: WatcherCore, ms: number): void {
  clearTimer(core);
  if (!active(core)) return;
  core.timer = core.deps.timers.setTimeout(() => {
    core.timer = null;
    kick(core);
  }, ms);
}

/** Run a pass now, unless one is running or passes do not run. */
function kick(core: WatcherCore): void {
  if (!active(core) || core.running) return;
  clearTimer(core);
  core.running = runPass(core).finally(() => {
    core.running = null;
  });
}

async function runPass(core: WatcherCore): Promise<void> {
  const credential = core.credential;
  if (!credential) return;
  core.session ??= newSession(core, credential);
  const session = core.session;
  const controller = new AbortController();
  core.controller = controller;
  let result: PassResult;
  try {
    result = await session.pass({ claim: !core.building, signal: controller.signal });
  } catch (error) {
    core.deps.log(`player: pass failed (${error instanceof Error ? error.name : "error"})`);
    result = { worked: false, sleepMs: MINUTE_MS, stop: null };
  } finally {
    core.controller = null;
  }
  core.passes += 1;
  await afterPass(core, session, result);
}

/** Keep the watcher's id, act on a stop, tell Settings, and schedule the next pass. */
async function afterPass(core: WatcherCore, session: WatcherSession, result: PassResult): Promise<void> {
  const id = session.snapshot().watcherId;
  if (id && id !== core.settings.watcherId) {
    core.settings.watcherId = id;
    await saveSettings(core).catch(() => core.deps.log("player: the watcher id could not be kept"));
  }
  if (result.stop?.kind === WatcherStop.AuthRefused) await forget(core, true);
  else if (result.stop) core.fatal = result.stop;
  if (result.stop) core.deps.log(`player: stopped (${result.stop.kind})`);
  await tell(core);
  // A stop above already made passes inactive, so nothing is scheduled after it.
  if (core.session === session) schedule(core, result.sleepMs);
}

/** Stop passes: no next one, and the one running hands its row back. */
async function halt(core: WatcherCore): Promise<void> {
  clearTimer(core);
  core.controller?.abort();
  await core.running;
}

/** Forget the credential: signed out, or (`refused`) ended by genex.games. */
async function forget(core: WatcherCore, refused: boolean): Promise<void> {
  core.credential = null;
  core.session = null;
  core.ended = refused;
  await core.deps.credential.clear().catch(() => core.deps.log("player: the credential could not be removed"));
}

// ── the sign-in ──────────────────────────────────────────────────────────────────────────────

const signInDeps = (core: WatcherCore) => ({ api: core.deps.api, web: core.deps.web, fetch: core.deps.fetch });

function clearPoll(core: WatcherCore): void {
  if (core.pollTimer === null) return;
  core.deps.timers.clearTimeout(core.pollTimer);
  core.pollTimer = null;
}

function schedulePoll(core: WatcherCore): void {
  const pending = core.pending;
  if (!pending) return;
  core.pollTimer = core.deps.timers.setTimeout(() => {
    core.pollTimer = null;
    core.polling = pollOnce(core).finally(() => {
      core.polling = null;
    });
  }, pending.intervalMs);
}

/** Ask once whether the browser approved; an approval stores the credential and starts passes. */
async function pollOnce(core: WatcherCore): Promise<void> {
  const asked = core.pending;
  if (!asked) return;
  const answer = await pollPlayerSignIn(signInDeps(core), asked, core.deps.clock.now());
  // Cancelled or replaced meanwhile: this answer is nobody's.
  if (core.pending !== asked) return;
  if (answer.poll === SignInPoll.Pending) {
    schedulePoll(core);
    return;
  }
  core.pending = null;
  if (answer.poll === SignInPoll.Approved) {
    await core.deps.credential.write(writePlayerCredential(answer.credential));
    Object.assign(core, { credential: answer.credential, ended: false, fatal: null, session: null });
    core.deps.log("player: signed in");
  }
  await tell(core);
  kick(core);
}

async function signIn(core: WatcherCore): Promise<void> {
  await load(core);
  if (core.credential || core.pending) return;
  const pending = await startPlayerSignIn(signInDeps(core), core.deps.label, core.deps.clock.now());
  core.pending = pending;
  core.ended = false;
  schedulePoll(core);
  await core.deps.openSignIn(pending.verifyUrl);
}

// ── the view ─────────────────────────────────────────────────────────────────────────────────

function stateOf(core: WatcherCore): AiWatcherState {
  if (!core.started || !core.settings.enabled) return AiWatcherState.Off;
  if (!core.credential) return AiWatcherState.SignedOut;
  if (core.building) return AiWatcherState.Yielding;
  return core.session?.snapshot().resting ? AiWatcherState.Resting : AiWatcherState.Online;
}

function problemOf(core: WatcherCore): AiWatcherProblem | null {
  if (core.fatal) return AiWatcherProblem.UpdateRequired;
  if (!core.started || !core.settings.enabled || !core.credential) return null;
  const snapshot = core.session?.snapshot();
  if (snapshot?.unreachable) return AiWatcherProblem.Unreachable;
  return core.passes > 0 && snapshot?.runners.length === 0 ? AiWatcherProblem.NoRunner : null;
}

function signInOf(core: WatcherCore): AiWatcherSignIn {
  if (core.pending) return AiWatcherSignIn.SigningIn;
  if (core.credential) return AiWatcherSignIn.SignedIn;
  return core.ended ? AiWatcherSignIn.Ended : AiWatcherSignIn.SignedOut;
}

/** What Settings shows. */
async function viewOf(core: WatcherCore): Promise<AiWatcherView> {
  await load(core);
  const snapshot = core.session?.snapshot() ?? null;
  return {
    enabled: core.settings.enabled,
    state: stateOf(core),
    runners: snapshot?.runners ?? [],
    codexHeld: snapshot?.codexHeld ?? false,
    resetsAt: snapshot?.resting?.resetsAt ?? null,
    problem: problemOf(core),
    signIn: signInOf(core),
    code: core.pending?.userCode ?? null,
    cliAlso: await core.deps.cliWatcher().catch(() => false),
    lastAnsweredAt: snapshot?.lastAnsweredAt ?? null,
  };
}

/** Tell Settings when what it shows changed. */
async function tell(core: WatcherCore): Promise<void> {
  const shown = JSON.stringify(await viewOf(core));
  if (shown === core.told) return;
  core.told = shown;
  core.deps.notify();
}

// ── the watcher ──────────────────────────────────────────────────────────────────────────────

/** The plan watcher over `deps`. */
export function createPlanWatcher(deps: PlanWatcherDeps) {
  const core: WatcherCore = {
    deps,
    settings: { enabled: false, watcherId: null },
    loaded: null,
    started: false,
    building: false,
    credential: null,
    ended: false,
    fatal: null,
    session: null,
    passes: 0,
    timer: null,
    running: null,
    controller: null,
    pending: null,
    pollTimer: null,
    polling: null,
    probes: new Map(),
    cliEnv: new Map(),
    told: "",
  };
  const view = () => viewOf(core);

  return {
    state: () => {
      const snapshot = core.session?.snapshot();
      return { state: stateOf(core), runners: snapshot?.runners ?? [], resetsAt: snapshot?.resting?.resetsAt ?? null };
    },
    start: async () => {
      await load(core);
      core.started = true;
      schedule(core, START_DELAY_MS);
    },
    stop: async () => {
      core.started = false;
      clearPoll(core);
      await halt(core);
      // A later start reads the switch and the credential again.
      core.loaded = null;
    },
    nudge: () => kick(core),
    building: (on: boolean) => {
      core.building = on;
      void tell(core);
      if (!on) kick(core);
    },
    view,
    /** The person's switch: on starts passes, off stops them and hands back any row in flight. */
    setEnabled: async (enabled: boolean): Promise<AiWatcherView> => {
      await load(core);
      core.settings.enabled = enabled;
      await saveSettings(core);
      if (enabled) {
        core.fatal = null;
        kick(core);
      } else await halt(core);
      await tell(core);
      return view();
    },
    /** Start the Genex player sign-in in the browser; joins one already waiting. */
    signIn: async (): Promise<AiWatcherView> => {
      await signIn(core);
      await tell(core);
      return view();
    },
    cancelSignIn: async (): Promise<AiWatcherView> => {
      core.pending = null;
      clearPoll(core);
      await tell(core);
      return view();
    },
    /** Forget the player credential on this Mac; passes stop and any row in flight goes back. */
    signOut: async (): Promise<AiWatcherView> => {
      core.pending = null;
      clearPoll(core);
      await halt(core);
      await forget(core, false);
      await tell(core);
      return view();
    },
    /** Resolves once no pass and no sign-in poll is running. */
    idle: async (): Promise<void> => {
      while (core.running || core.polling) await Promise.allSettled([core.running, core.polling]);
    },
  } satisfies GameAiPlanWatcher & Record<string, unknown>;
}

/** The plan watcher as `createPlanWatcher` makes it. */
export type PlanWatcher = ReturnType<typeof createPlanWatcher>;

// ── genex player on the same Mac ─────────────────────────────────────────────────────────────

/** Whether a process with this id is running here. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it runs, as another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether `genex player` also answers on this Mac: its state file (`~/.genex/player-state.json`,
 * never its credential file beside it) names a running process that beat recently. The file is
 * read as hostile input: bounded, never through a link, its pid a plain process id.
 */
export async function readCliWatcherState(home: string, now: number): Promise<boolean> {
  let parsed: unknown;
  try {
    const bytes = await readRegularFile(path.join(home, ".genex", "player-state.json"), CLI_STATE_MAX_BYTES);
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return false;
  }
  if (!isPlainRecord(parsed) || parsed.v !== 1) return false;
  const { pid, lastHeartbeatAt } = parsed;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 1) return false;
  const beat = typeof lastHeartbeatAt === "string" ? Date.parse(lastHeartbeatAt) : Number.NaN;
  return Number.isFinite(beat) && now - beat <= CLI_FRESH_MS && beat <= now + CLI_FRESH_MS && alive(pid);
}
