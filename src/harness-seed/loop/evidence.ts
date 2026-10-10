/**
 * Evidence — how the harness looks at a build.
 *
 * One pass (`gatherEvidence`): load the build, wait for it to say it is up, replay the requested
 * state, prove the studio owns the clock, drive the game's own controls, photograph every camera
 * and the player's eyes, run its demos, and read the state, the console and the GPU. Every mode
 * uses it — the classic gauntlet, the pipeline's base and facets, a spike, the director's judge,
 * health and close passes.
 *
 * Around the pass: the one classifier of why a pass came back unjudgeable (the camera, the clock,
 * or the build), the patience that follows from it (`withObservationPatience`, `patientEvidence`),
 * and the preview windows a look is taken through (`acquireWindow`, `withLease`).
 *
 * This moved here out of gauntlet.ts and director.ts; gauntlet.ts still exports every name it
 * exported, so a harness file the in-app agent edited before the move keeps its imports.
 */
import { applyPlayScript } from "./play-script.ts";
// A namespace, not named imports: a seed upgrade may keep an older kinds.ts the agent edited, which
// has no `cruiseFor` or `startKeysFor`, and a missing named import would stop this file loading.
import * as kinds from "./kinds.ts";
// A namespace too: routes.ts is newer than an evidence.ts a workspace may keep, and this pass
// replays the run's routes only when it is there.
import * as routes from "./routes.ts";
import { LOAD_RACE_RETRY_MS, OBSERVATION_RETRY_MS, RACE_RETRY_MS, WINDOW_RETRIES_MS } from "./config.ts";
import { HostMethod } from "./host-methods.ts";
import { PageMethod } from "./page-contract.ts";
import { PreviewConsoleSource, PreviewGone } from "./preview-gone.ts";
import { isElidedStub, isKeepPath, isTruncatedState, stateCutOf } from "./state-shape.ts";
import { clip } from "./text.ts";
import { MINUTE_MS, SECOND_MS, sleep } from "./time.ts";
import { isRecord } from "./json.ts";
import { DEFAULT_CAMERA } from "./cameras.ts";
import { CORNER_CAMERA, isPassFrame } from "./pass-frames.ts";
import type { AnyRecord, HarnessCtx, Run } from "../types/harness.d.ts";
import type { CheckEvidence } from "./checks.ts";

/** One photographed frame: the camera, where the file is, its pixels and the surface it came off. */
export interface Shot {
  camera: string;
  path?: string | null;
  bytes?: number;
  base64?: string;
  stats?: AnyRecord | null;
  surface?: string;
  registered?: boolean;
  [field: string]: unknown;
}

/**
 * What an evidence pass gathered: whether the build is judgeable (`ok`), what makes it not
 * (`problems`), what a judge and the next builder should know anyway (`warnings`), and every
 * reading — frames, state, demos, console, readiness, the clock proof.
 */
export interface Evidence extends CheckEvidence {
  ok: boolean;
  problems: string[];
  warnings: string[];
  shots: Shot[];
  consoleErrors: string[];
  readyAfterMs?: number | null;
  attempts?: number;
  /** Whether the drive started in play — only for a game that reports `state().flow`. */
  play?: PlayReach;
  /** The OS killed the window (memory pressure), so its problems are the machine's, not the build's. Only when true. */
  machineKilled?: boolean;
  /** The cameras the game registers (`__studio.cameras()`), whatever the pass photographed; null when it never said. */
  registeredCameras?: string[] | null;
  /** Whether the game's racing line steered the held throttle — only for a drive that held one. */
  drive?: { steered: boolean };
  /** The racer's turn-in the drive photographed (`drive:corner`), or why there is none — only for a kind with corners. */
  corner?: { seen: boolean; atMs?: number; turnDegPerSecond?: number; unreadable?: boolean };
  /** The throttle-only bot's race — only when the pass was asked to race it. */
  challenge?: AnyRecord;
  // biome-ignore lint/suspicious/noExplicitAny: every other reading of the pass, read by name where it is used.
  [field: string]: any;
}

/** How a pass took the game into play (`PlayReach.via`): it already was, `begin()`, start keys, waiting, or not at all. */
export const PlayVia = {
  Boot: "boot",
  Begin: "begin",
  Keys: "keys",
  Wait: "wait",
  /** The setup said `begin: false`: the worker that owns the front-end is judged on it. */
  Kept: "kept",
} as const;
export type PlayVia = (typeof PlayVia)[keyof typeof PlayVia];

/** Whether the drive of a game with a front-end started in play, and how it got there. */
export interface PlayReach {
  declared: true;
  reached: boolean;
  phase: string | null;
  via: PlayVia;
  /** Simulated milliseconds stepped after `begin()` (or the keys) before play. */
  ms: number;
}

/** What one evidence pass is asked to look at, and how. */
export interface GatherOptions {
  run: Run;
  iterationId?: string | number;
  seed?: number;
  handle?: string | null;
  root?: string | null;
  labelPrefix?: string | null;
  cameras?: string[] | null;
  entry?: string;
  eyes?: boolean;
  motion?: number;
  audio?: boolean;
  maxDemos?: number;
  requiredDemos?: string[];
  /**
   * The demos the build this one is compared with registers: under the cap, a demo this build
   * added runs before the ones the other already showed.
   */
  knownDemos?: string[] | null;
  /** Race the throttle-only bot after the demos (`raceThrottleBot`): a board carries `throttle-bot-loses`, or a ship look. */
  challenge?: boolean;
  userView?: boolean;
  scaffold?: boolean;
  setup?: AnyRecord | null;
  inheritedConsole?: string[];
  /** The state paths the board reads (`statePathsNamedByChecks`): the studio cuts them last. */
  keepPaths?: string[];
  /** Look at this size: a leased window is sized before it loads (`preview.viewport`), never the live view. */
  viewport?: { width: number; height: number } | null;
}

/** The pass's own state, phase to phase: its arguments, then what each phase found. */
interface Look extends GatherOptions {
  ctx: HarnessCtx;
  // Set by gatherEvidence's own defaults.
  eyes: boolean;
  motion: number;
  audio: boolean;
  maxDemos: number;
  requiredDemos: string[];
  knownDemos: string[] | null;
  challenge: boolean;
  userView: boolean;
  scaffold: boolean;
  inheritedConsole: string[];
  keepPaths: string[];
  // biome-ignore lint/suspicious/noExplicitAny: each phase adds the readings the phases after it read.
  [field: string]: any;
}

/** A phase ends the pass by answering its result, or hands on by answering nothing. */
type LookEnd = { value: Evidence } | undefined | void;

/** How the studio's proof of its own clock came out. */
export interface StepProof {
  ok: boolean;
  code: string;
  reason: string;
  frames: number;
  drawCalls: number;
  ms: number;
  canvas: boolean;
  simulatedMs: number | null;
  idle: number;
  askedFrames: number;
  idleLoop: boolean;
  note: string;
}

/** Above this fraction of differing pixels, the user's page and the canvas are two pictures. */
const USER_VIEW_MISMATCH = 0.02;
/** Below this lit fraction on every camera, a build renders effectively black. */
const BLACK_LIT_FRACTION = 0.005;
/** A page that takes longer than this to say it is ready is warned about: every pass pays that boot. */
const SLOW_BOOT_MS = 5 * SECOND_MS;
/** How long a setup waits for the game to settle after its actions: 400 ms unless it says, never over ten seconds. */
const SETUP_SETTLE_MS = 400;
const SETUP_SETTLE_MAX_MS = 10 * SECOND_MS;
/** The most keys a setup's gesture presses, and the most input actions it replays. */
const MAX_GESTURE_KEYS = 4;
const MAX_SETUP_ACTIONS = 24;
/** The clock proof steps twice, this long each. */
const PROOF_STEPS = 2;
const PROOF_STEP_MS = 320;
/** The drive: this many steps of this long (about thirty simulated seconds), motion frames spread over them. */
const DRIVE_STEPS = 29;
const DRIVE_STEP_MS = 960;
const LAST_DRIVE_STEP = DRIVE_STEPS - 1;
/** Reaching play: the clock steps this long between reads of `flow.playing`, for at most this long. */
const PLAY_WAIT_STEP_MS = 240;
const PLAY_WAIT_MAX_MS = 12 * SECOND_MS;
/** How much of what `__studio.begin()` answered when it refused a warning quotes. */
const BEGIN_REASON_CHARS = 160;
/**
 * The demos a look runs beyond the ones checks name, unless its caller says otherwise: enough that
 * a demo a builder registers to show its move is photographed and judged.
 */
const DEMOS_PER_LOOK = 12;
/**
 * The drive's corner (`drive:corner`): steps before this one are the controls' own swerve and the
 * line taking the car back; a heading turning faster than this (radians per second, about 20°/s)
 * is a corner, not a lane change.
 */
const CORNER_SETTLE_STEPS = 3;
const CORNER_TURN_RAD_PER_S = 0.35;
const DEGREES_PER_RADIAN = 180 / Math.PI;
/**
 * The throttle-only bot's race (`raceThrottleBot`): stepped this long at a time, for at most this
 * much racing, enough for a race of several laps. The time keeps it affordable: about a minute
 * of a page's own stepping at most, and only when a board carries the check or a ship look asks.
 */
const CHALLENGE_STEP_MS = 5 * SECOND_MS;
const CHALLENGE_MAX_MS = 6 * MINUTE_MS;
/** The state paths the bot's race is read by: kept whole when the state is over the studio's budget. */
const RACE_PATHS = ["race.position", "race.finished"];
/** Why the throttle-only bot did not race: the words a probe's reason and a judge read. */
const MESSAGE = {
  botNoRace: "the game reports no race.position in state() — there is no race to win",
  botNoThrottle: "this kind of game has no throttle to hold",
  botNoPlay: "the race never reached play after begin()",
} as const;
/** A pass without a spec photographs at most this many cameras. */
const MAX_CAMERAS = 6;
/** The harness's own viewpoints, asked of a game that declares fewer than two. */
const FLOOR_CAMERAS = [DEFAULT_CAMERA, "close", "wide"];
/** The player's-eye cameras a pass photographs when the game has them. */
const EYE_CAMERAS = ["eye:spawn", "eye:here", "eye:down"];
/** How many of the page's UI entries a warning names. */
const MAX_UI_ENTRIES = 6;
/** What the answer keeps of the console and the GPU: the last few errors for a prompt, and the baseline. */
const PROMPT_CONSOLE_ERRORS = 5;
/** How many inherited console errors a pass's warning quotes, and how much of each. */
const INHERITED_ERRORS_QUOTED = 2;
const INHERITED_ERROR_CHARS = 160;
const MAX_CONSOLE_BASELINE = 200;
const MAX_GPU_ERRORS = 16;

/** The sentence this pass pushes when the page carries no contract at all. Exported because the
 * race classifier is built from it: a sentence two files re-type is a sentence that drifts. */
export const MISSING_CONTRACT = "window.__studio is missing — the build cannot be judged";

/** The sentence a pass pushes when the window's renderer went away, whoever's doing it was. */
const RENDERER_CRASHED = "the renderer crashed";

/** The sentence a pass with no frame owes its reader; also an observation problem. */
const NO_FRAME = /^no camera produced a frame/;

/**
 * Every way a look can come back unjudgeable without the build being at fault, in one table —
 * each sentence once, with what it can mean. There used to be two lists: the classic pass's
 * observation problems and the director's load race, each a copy of the other's first four lines.
 *
 *  - `observation`: a blind camera — a capture that raced the compositor, failed outright, or
 *    found no display surface. Duplicate-frame problems are deliberately NOT here: captures are
 *    page-rendered fresh per call, so identical frames across cameras indict the build's camera
 *    wiring — treating them as an outage once held a finished panelka build "unjudged" until
 *    teardown deleted it.
 *  - `race`: the page was photographed before it finished coming up. Only the missing contract
 *    qualifies, exactly as worded, and only while readiness itself went unmeasured (see
 *    `classifyEvidenceFailure`). "evidence pass failed" is deliberately absent: it is the
 *    catch-all for a dead preview, and it must cost its iteration rather than be retried three
 *    times against the same corpse.
 *  - `load`: what the director's patient pass looks again for — a load that raced the window (no
 *    __studio yet, a capture before the first frame) is not a broken build: the judge finds such a
 *    build fine seconds later. A pass that took no frame at all has never been one of these.
 */
/** What one problem can mean (`EVIDENCE_FAILURES`). */
const ProblemMeaning = {
  Observation: "observation",
  Race: "race",
  Load: "load",
} as const;
type ProblemMeaning = (typeof ProblemMeaning)[keyof typeof ProblemMeaning];

/** Why a look is not judgeable (`classifyEvidenceFailure`): nothing, the camera, the clock, or the build. */
export const EvidenceFailure = {
  None: "none",
  Observation: "observation",
  Race: "race",
  Build: "build",
} as const;
export type EvidenceFailure = (typeof EvidenceFailure)[keyof typeof EvidenceFailure];

const EVIDENCE_FAILURES: ReadonlyArray<{ match: RegExp; means: readonly ProblemMeaning[] }> = [
  { match: /^screenshot\(.+\) failed/, means: [ProblemMeaning.Observation, ProblemMeaning.Load] },
  { match: /could not be attached/, means: [ProblemMeaning.Observation, ProblemMeaning.Load] },
  { match: /no compositor/i, means: [ProblemMeaning.Observation, ProblemMeaning.Load] },
  { match: /display surface/i, means: [ProblemMeaning.Observation, ProblemMeaning.Load] },
  { match: NO_FRAME, means: [ProblemMeaning.Observation] },
  { match: new RegExp(`^${MISSING_CONTRACT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), means: [ProblemMeaning.Race] },
  { match: /__studio is missing/, means: [ProblemMeaning.Load] },
  { match: /could not drive the game/, means: [ProblemMeaning.Load] },
];

/** Does every problem mean `kind`? An empty list means nothing. */
function allMean(problems: readonly unknown[] | null | undefined, kind: ProblemMeaning): boolean {
  const list = (problems ?? []).map((problem) => String(problem));
  return (
    list.length > 0 &&
    list.every((problem) =>
      EVIDENCE_FAILURES.some((failure) => failure.means.includes(kind) && failure.match.test(problem)),
    )
  );
}

/**
 * Why this evidence is not judgeable: nothing, the camera, the clock, or the build.
 *
 *  - `observation`: every problem is a blind camera. Retry, and never execute the challenger.
 *  - `race`: the page had not finished coming up when it was looked at, and nothing measured
 *    when it did. A short retry, because a slow boot is not a defect.
 *  - `build`: everything else, including a missing contract on a page whose boot WAS measured.
 *
 * `machineKilled` is the window's own typed word (`preview.status` `gone`), never read off a
 * sentence: when the OS killed the renderer for memory, the crash and what a dead window cannot
 * answer (no drive, no frame, no contract) are the machine's, and the look is an outage.
 */
export function classifyEvidenceFailure(
  problems: readonly unknown[] | null | undefined,
  { readyAfterMs = null, machineKilled = false }: { readyAfterMs?: number | null; machineKilled?: boolean } = {},
): EvidenceFailure {
  if (!(problems ?? []).length) return EvidenceFailure.None;
  if (allMean(problems, ProblemMeaning.Observation)) return EvidenceFailure.Observation;
  if (machineKilled && deadWindowOnly(problems)) return EvidenceFailure.Observation;
  if (readyAfterMs === null && allMean(problems, ProblemMeaning.Race)) return EvidenceFailure.Race;
  return EvidenceFailure.Build;
}

/** Is every problem the crash itself, or something a dead window could not answer (a blind camera, a lost drive or contract)? */
function deadWindowOnly(problems: readonly unknown[] | null | undefined): boolean {
  const rest = (problems ?? []).map((problem) => String(problem)).filter((problem) => problem !== RENDERER_CRASHED);
  const deadWindowMeanings: readonly ProblemMeaning[] = [ProblemMeaning.Observation, ProblemMeaning.Load];
  return rest.every((problem) =>
    EVIDENCE_FAILURES.some(
      (failure) => failure.means.some((means) => deadWindowMeanings.includes(means)) && failure.match.test(problem),
    ),
  );
}

/** Did the OS kill this window (`preview.status` `gone`), rather than the build crash it? */
function killedByMachine(status: { gone?: unknown } | null | undefined): boolean {
  return status?.gone === PreviewGone.Killed || status?.gone === PreviewGone.Oom;
}

/**
 * True when every evidence problem lives in the observation layer and none indict the build
 * itself (crash, load error, missing contract, console errors, all-black frames). Only then may
 * "not judgeable" mean "keep it": a blind camera must never execute a finished build.
 */
export function observationOnlyFailure(problems: readonly unknown[] | null | undefined): boolean {
  return classifyEvidenceFailure(problems) === EvidenceFailure.Observation;
}

/** Did the load race the window — every problem one a second look a few seconds later can settle? */
export function loadRaced(problems: readonly unknown[] | null | undefined): boolean {
  return allMean(problems, ProblemMeaning.Load);
}

/**
 * Evidence with patience for a blind camera. An occluded window (covered, on another Space,
 * display asleep) fails every capture for minutes and then recovers; a broken build does not.
 * Observation-only failures retry on a backoff instead of instantly indicting the challenger —
 * one such outage cost a run all three first-iteration builds, including a finished 77-mesh
 * building destroyed by the rollback that followed.
 *
 * A RACE has its own, much shorter backoff: a page that was still coming up needs seconds, not
 * a minute. `raceDelays: []` turns that off entirely, which is what the classic run passes.
 */
export async function withObservationPatience<
  E extends { ok?: boolean; problems: readonly unknown[]; readyAfterMs?: number | null; machineKilled?: boolean },
>(
  ctx: { readonly cancelled: boolean; setStatus?: (status: string) => void },
  gatherOnce: () => Promise<E>,
  {
    deadline = Infinity,
    delays = OBSERVATION_RETRY_MS,
    raceDelays = RACE_RETRY_MS,
    onRetry = null,
  }: {
    deadline?: number;
    delays?: readonly number[] | null;
    raceDelays?: readonly number[] | null;
    onRetry?: ((kind: string, evidence: E, delay: number) => void) | null;
  } = {},
): Promise<E> {
  let evidence = await gatherOnce();
  const left: Record<string, number[]> = {
    [EvidenceFailure.Observation]: [...(delays ?? [])],
    [EvidenceFailure.Race]: [...(raceDelays ?? [])],
  };
  for (;;) {
    if (evidence.ok) return evidence;
    const kind = classifyEvidenceFailure(evidence.problems, {
      readyAfterMs: evidence.readyAfterMs ?? null,
      machineKilled: evidence.machineKilled === true,
    });
    const delay = left[kind]?.shift();
    if (delay === undefined) return evidence;
    if (ctx.cancelled || Date.now() + delay > deadline) return evidence;
    ctx.setStatus?.(
      `${kind === EvidenceFailure.Race ? "the page was not up yet" : "observation outage"} — retrying evidence in ${Math.round(delay / SECOND_MS)}s (${evidence.problems[0]})`,
    );
    onRetry?.(kind, evidence, delay);
    await sleep(delay);
    evidence = await gatherOnce();
  }
}

/** What replaying a setup did: whether anything ran, whether the state was reached, and why not. */
interface SetupOutcome {
  applied: boolean;
  reached: boolean | null;
  reason: string;
  error: string | null;
}

/**
 * The knock first: a suspended AudioContext cannot resume, a pointer cannot lock and a title
 * screen waiting on a click cannot be walked past without a trusted gesture — and start() before
 * it would resume a game that is still on its first screen.
 */
async function knock(ctx: HarnessCtx, gesture: unknown, h: { handle?: string }): Promise<void> {
  const g: AnyRecord = gesture === true ? {} : (gesture as AnyRecord);
  await ctx
    .call(HostMethod.PreviewGesture, {
      ...(Number.isFinite(g?.x) ? { x: Number(g.x) } : {}),
      ...(Number.isFinite(g?.y) ? { y: Number(g.y) } : {}),
      ...(Array.isArray(g?.keys) && g.keys.length ? { keys: g.keys.map(String).slice(0, MAX_GESTURE_KEYS) } : {}),
      ...h,
    })
    .catch(() => null);
}

/** Run the setup's demo; the sentence to keep when it did not run, or null. */
async function runSetupDemo(ctx: HarnessCtx, demo: unknown, h: { handle?: string }): Promise<string | null> {
  const ran = (await ctx
    .call(HostMethod.PreviewCall, { method: PageMethod.Demo, arg: demo, ...h })
    .catch((err) => ({ ok: false, reason: String(err?.message ?? err) }))) as AnyRecord | null;
  if (isRecord(ran) && ran.ok === false) return `demo "${demo}" did not run: ${ran.reason ?? "unknown"}`;
  return null;
}

/** Whether the verify probe over `__studio.state()` says the requested state was reached, and why not. */
async function verifySetup(
  ctx: HarnessCtx,
  setup: AnyRecord,
  h: { handle?: string },
): Promise<{ reached: boolean | null; reason: string }> {
  const { verify } = setup;
  // The verified path is kept whole: an over-budget state is cut largest-first, and the value
  // this probe reads must not be the part that went.
  const keep = isKeepPath(verify.path) ? { keep: [verify.path] } : {};
  const state = (await ctx.call(HostMethod.PreviewState, { ...h, ...keep }).catch(() => null)) as AnyRecord | null;
  const value = lookupState(state, verify.path);
  // An older studio cut an over-budget state to a string: nothing in it can be read, which is not
  // the same as a state that was read and is wrong.
  if (isTruncatedState(state))
    return { reached: null, reason: "the game's state is unreadable: state() came back cut to a string" };
  const usable = state && typeof state === "object" && !state.__missing;
  if (!usable) return { reached: null, reason: "the game's state is unreadable" };
  // A studio that could not keep the path left a stub on it: unmeasured, not wrong.
  if (elidedAlong(state, verify.path))
    return { reached: null, reason: `${verify.path} was cut out of an over-budget state() — unmeasured` };
  const note = setup.note ? ` (${setup.note})` : "";
  if ("equals" in verify) {
    const reached = value === verify.equals || String(value) === String(verify.equals);
    const expected = `${verify.path} is ${JSON.stringify(value)} — expected ${JSON.stringify(verify.equals)}${note}`;
    return { reached, reason: reached ? "" : expected };
  }
  const reached = verify.truthy ? Boolean(value) : value !== undefined;
  return { reached, reason: reached ? "" : `${verify.path} is ${JSON.stringify(value)}${note}` };
}

/**
 * Replay the run's setup on a loaded port: the demo or the input actions the scout wrote,
 * then the verify probe over `__studio.state()`. Never throws — a wrong state is a warning
 * the judge and the next builder read, not a voided challenger.
 */
export async function applySetup(
  ctx: HarnessCtx,
  setup: AnyRecord | null | undefined,
  h: { handle?: string } = {},
): Promise<SetupOutcome> {
  const out: SetupOutcome = { applied: false, reached: null, reason: "", error: null };
  if (!setup || typeof setup !== "object" || !replaysSomething(setup)) return out;
  try {
    if (setup.gesture) {
      await knock(ctx, setup.gesture, h);
      out.applied = true;
    }
    await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Start, ...h }).catch(() => null);
    if (setup.demo) {
      const failed = await runSetupDemo(ctx, setup.demo, h);
      if (failed) out.error = failed;
      out.applied = true;
    }
    if (Array.isArray(setup.actions) && setup.actions.length) {
      await ctx.call(HostMethod.PreviewInput, { actions: setup.actions.slice(0, MAX_SETUP_ACTIONS), ...h });
      out.applied = true;
    }
    await sleep(Math.min(SETUP_SETTLE_MAX_MS, Number(setup.settleMs) || SETUP_SETTLE_MS));
    if (setup.verify?.path) Object.assign(out, await verifySetup(ctx, setup, h));
  } catch (err: any) {
    out.error = String(err?.message ?? err);
  }
  return out;
}

/**
 * Whether a setup replays anything on the page. `{ begin: false }` alone (the worker that owns the
 * front-end) only says what the pass must not skip, and is not a script to replay and settle after.
 */
function replaysSomething(setup: AnyRecord): boolean {
  const acts = Array.isArray(setup.actions) && setup.actions.length > 0;
  return Boolean(setup.gesture || setup.demo || setup.verify?.path || acts);
}

/** Whether the studio left an elision stub anywhere on `path` (the value itself or one of its parents). */
function elidedAlong(state: unknown, path: string): boolean {
  let current: unknown = state;
  for (const key of String(path).split(".")) {
    if (!isRecord(current)) return false;
    current = current[key];
    if (isElidedStub(current)) return true;
  }
  return false;
}

function lookupState(state: unknown, path: string): unknown {
  let current: any = state;
  for (const key of String(path).split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * Console errors as evidence problems: only the errors this build introduced void it. An error
 * the incumbent (or the base) already logged rides along as a warning the builder still reads.
 */
export function consoleProblems(
  consoleErrors: ReadonlyArray<{ message?: unknown }> | null | undefined,
  inheritedConsole: readonly unknown[] | null = [],
): { problems: string[]; warnings: string[] } {
  const inherited = new Set((inheritedConsole ?? []).map((m) => String(m)));
  const fresh = (consoleErrors ?? []).filter((entry) => !inherited.has(String(entry.message)));
  const carried = (consoleErrors ?? []).length - fresh.length;
  return {
    problems: fresh.length ? [`${fresh.length} console error(s)`] : [],
    warnings: carried
      ? [
          `${carried} console error(s) inherited from the build this one started from — not this build's fault, but somebody's: ${(
            consoleErrors ?? []
          )
            .filter((entry) => inherited.has(String(entry.message)))
            .slice(0, INHERITED_ERRORS_QUOTED)
            .map((entry) => clip(String(entry.message), INHERITED_ERROR_CHARS))
            .join(" | ")}`,
        ]
      : [],
  };
}

/**
 * What a step must move, read page-side in one expression.
 *
 * `steppedFrames`, not `frames`: the wall-mode pump advances `frames` on a visible window
 * whether or not the page has a loop of its own, so comparing `frames` would prove nothing.
 */
export const STEP_WITNESS = `(() => {
  /* studio step witness */
  try {
    var clock = window.__studioClock;
    if (!clock || typeof clock.stats !== "function") return null;
    var stats = clock.stats() || {};
    var simulatedMs = null;
    try {
      var state = window.__studio && typeof window.__studio.state === "function" ? window.__studio.state() : null;
      if (state && typeof state.simulatedMs === "number") simulatedMs = state.simulatedMs;
    } catch (err) { simulatedMs = null; }
    return {
      steppedFrames: Number(stats.steppedFrames) || 0,
      drawCalls: Number(stats.drawCalls) || 0,
      now: Number(stats.now) || 0,
      canvas: !!(typeof document !== "undefined" && document.querySelector("canvas")),
      simulatedMs: simulatedMs
    };
  } catch (err) {
    return null;
  }
})()`;

/**
 * Prove the studio drives the game before anything it drives is believed.
 *
 * Two steps, not one: a single delta can be satisfied by a wall-clock frame that happened to
 * land between two reads. Both must move the page's own stepped-frame counter, its draw counter
 * and its clock — otherwise the pass that follows measures a page running itself, and every
 * "before/after" number in it is noise.
 */
export async function proveStep(ctx: HarnessCtx, h: { handle?: string } = {}, ms = 320): Promise<StepProof> {
  const samples = [await readWitness(ctx, h)];
  // The step answers, not only the witness: the shim counts the stepped frames that found no
  // animation callback at all (`idle`), and that is the difference between a game riding the
  // studio's clock and a game the studio merely stepped past.
  let idle = 0;
  let asked = 0;
  for (let i = 0; i < PROOF_STEPS; i++) {
    const answer = (await ctx.call(HostMethod.PreviewCall, {
      method: PageMethod.Step,
      arg: ms,
      ...h,
    })) as AnyRecord | null;
    if (answer && typeof answer === "object") {
      if (typeof answer.idle === "number") idle += answer.idle;
      if (typeof answer.frames === "number") asked += answer.frames;
    }
    samples.push(await readWitness(ctx, h));
  }
  const out: StepProof = {
    ok: false,
    code: "no-clock",
    reason: "",
    frames: 0,
    drawCalls: 0,
    ms: 0,
    canvas: samples.some((sample) => sample?.canvas === true),
    simulatedMs: null,
    idle,
    askedFrames: asked,
    idleLoop: false,
    note: "",
  };
  const read = samples.filter((sample): sample is AnyRecord => sample !== null);
  if (read.length !== samples.length) {
    out.reason = "the page has no studio clock (the shim did not load)";
    return out;
  }
  return weighSteps(out, read);
}

/** One read of the step witness: the page's own counters, or null when the shim is not there. */
async function readWitness(ctx: HarnessCtx, h: { handle?: string }): Promise<AnyRecord | null> {
  try {
    const answer = (await ctx.call(HostMethod.PreviewEvaluate, { expression: STEP_WITNESS, ...h })) as AnyRecord | null;
    if (!isRecord(answer) || typeof answer.steppedFrames !== "number") return null;
    return answer;
  } catch {
    return null;
  }
}

/** What the witness samples prove: frames of the page's own, something drawn, and a clock that moved. */
function weighSteps(out: StepProof, samples: AnyRecord[]): StepProof {
  const first = samples[0];
  const last = samples[samples.length - 1];
  out.frames = last.steppedFrames - first.steppedFrames;
  out.drawCalls = last.drawCalls - first.drawCalls;
  out.ms = last.now - first.now;
  out.simulatedMs = typeof last.simulatedMs === "number" ? last.simulatedMs : null;
  if (!samples.every((sample, index) => index === 0 || sample.steppedFrames > samples[index - 1].steppedFrames)) {
    out.code = "no-frame";
    out.reason =
      "the studio stepped the clock and the page ran no frame of its own — the game does not ride the studio's clock";
    return out;
  }
  if (!(out.drawCalls > 0)) {
    out.code = "no-draw";
    out.reason = "frames ran but nothing was drawn";
    return out;
  }
  if (!(out.ms > 0)) {
    out.code = "flat-clock";
    out.reason = "the studio clock did not advance across two steps — the page's time is not the studio's";
    return out;
  }
  out.ok = true;
  out.code = "ok";
  // Frames moved and something was drawn, but every stepped frame found no animation callback:
  // the game draws from somewhere else (a timer, an input handler, a render on demand). That is
  // a real game and not a failure, so it is a note — but the frame counts below are the studio's
  // and not the game's, and the honest answer says so instead of charging them to its loop.
  if (out.askedFrames > 0 && out.idle >= out.askedFrames) {
    out.idleLoop = true;
    out.note =
      "the studio stepped the clock and the game ran no animation frame of its own — it draws from somewhere else, so the frame counts are the studio's rather than the game's loop";
  }
  return out;
}

/**
 * The empty-scene exemption, as one expression a test can run under `node:vm`.
 *
 * It censuses every scene the hook says was rendered (a menu → level machine renders two, and
 * the content may be in either), duck-types the scene and the camera rather than trusting a
 * three.js flag, and accepts a WebGPU backend everywhere `isWebGLRenderer` was once the gate.
 */
export const EMPTY_SCENE_PROBE = `(() => {
  try {
    var s = window.__studio;
    var i = s && typeof s.inspect === "function" ? s.inspect() : null;
    if (!i || typeof i !== "object") return false;
    var r = i.renderer;
    var backend = !!r && (r.isWebGLRenderer === true || (!!r.backend && (r.backend.isWebGPUBackend === true || r.backend.isWebGLBackend === true)));
    var c = i.camera;
    var camera = !!c && (c.isCamera === true || (!!c.projectionMatrix && !!c.matrixWorld));
    if (!backend || !camera) return false;
    var scenes = Array.isArray(i.scenes) && i.scenes.length ? i.scenes : (i.scene ? [i.scene] : []);
    if (!scenes.length) return false;
    var count = 0;
    for (var n = 0; n < scenes.length; n++) {
      var scene = scenes[n];
      if (!scene || (scene.isScene !== true && !Array.isArray(scene.children))) return false;
      var stack = (scene.children || []).slice();
      var guard = 0;
      while (stack.length && guard++ < 2048) {
        var o = stack.pop();
        if (!o) continue;
        if (o.isMesh || o.isLine || o.isPoints || o.isSprite) count++;
        if (Array.isArray(o.children)) for (var k = 0; k < o.children.length; k++) stack.push(o.children[k]);
      }
    }
    var state = s.state();
    var hud = state && state.hud;
    return count === 0 && !(hud && hud.items && hud.items.length) && !(hud && hud.crosshair) && !(hud && hud.flash);
  } catch (err) {
    return false;
  }
})()`;

/** The camera pose, read only for the empty-scene stage where pixels cannot prove placement. */
const CAMERA_POSE_PROBE = `(() => {
  const c = window.__studio.inspect().camera;
  c.updateMatrixWorld(true);
  const values = [...c.matrixWorld.elements, ...c.projectionMatrix.elements];
  return values.every(Number.isFinite) ? JSON.stringify(values) : null;
})()`;

/**
 * Which surface a frame was actually PHOTOGRAPHED on, as the port reports it — not the one the
 * capture asked for. A canvas read that declines (no canvas, nothing drew, a painted page
 * background) is answered by the compositor, and a page capture the compositor refuses is
 * answered off the canvas; a shot that says neither is read as the surface we asked for.
 */
function photographed(shot: { surface?: unknown } | null | undefined, asked = "canvas"): string {
  return shot?.surface === "page" || shot?.surface === "canvas" ? shot.surface : asked;
}

/**
 * Deterministic playthrough + screenshots at every named camera + structural probes.
 *
 * Exported for the Autopilot facet loop, which probes a worktree (`root`) through a pooled
 * observation port (`handle`) and files its shots under its own label (`labelPrefix`). With
 * none of those set, this is byte-for-byte the gauntlet's own evidence pass on the live view.
 */
export async function gatherEvidence(
  ctx: HarnessCtx,
  {
    run,
    iterationId,
    seed,
    handle,
    root,
    labelPrefix,
    cameras = null,
    entry,
    eyes = true,
    motion = 0,
    audio = true,
    maxDemos = DEMOS_PER_LOOK,
    requiredDemos = [],
    knownDemos = null,
    challenge = false,
    userView = true,
    scaffold = false,
    setup = undefined,
    inheritedConsole = [],
    keepPaths = [],
    viewport = null,
  }: GatherOptions,
): Promise<Evidence> {
  const kept = Array.isArray(keepPaths) ? keepPaths.map(String) : [];
  // The pass's own state, phase to phase: its arguments, then what each phase found for the
  // phases after it.
  const look: Look = {
    ctx,
    run,
    iterationId,
    seed,
    handle,
    root,
    labelPrefix,
    cameras,
    entry,
    eyes,
    motion,
    audio,
    maxDemos,
    requiredDemos,
    knownDemos: Array.isArray(knownDemos) ? knownDemos.map(String) : null,
    challenge: challenge === true,
    userView,
    scaffold,
    setup,
    inheritedConsole,
    // The bot's race is read by its position and finish: cut last, like the board's own paths.
    keepPaths: challenge === true ? [...new Set([...kept, ...RACE_PATHS])] : kept,
    viewport,
  };
  for (const phase of LOOK_OPENING) {
    const done = await phase(look);
    if (done) return done.value;
  }
  // Everything from here to the last read touches the page. The finally hands the game back
  // running, so a crashed harness never leaves a dead page on the user's stage.
  try {
    for (const phase of LOOK_PHASES) {
      const done = await phase(look);
      if (done) return done.value;
    }
  } finally {
    await handBack(look);
  }
  // Unreachable: the last phase (reportLook) always answers.
  return undefined as never;
}

/**
 * However this pass ends, the game is handed back running. A run that crashed here used to
 * leave the user's own stage frozen on a paused frame until they reloaded it. The live view (a
 * pass with no window of its own) is the user's stage: a pass that took the game past its title
 * puts it back on its first screen before it lets it run, rather than mid-race.
 */
async function handBack(look: Look): Promise<void> {
  const { ctx, h } = look;
  // The bot's race ends wherever it ended — a results screen, mid-race at the time limit.
  const raced = look.challengeRace?.ran === true;
  const movedPastFrontEnd = raced || look.play?.via === PlayVia.Begin || look.play?.via === PlayVia.Keys;
  if (movedPastFrontEnd && !look.handle)
    await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Seed, arg: look.seed, ...h }).catch(() => {});
  await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Start, ...h }).catch(() => {});
}

/** `preview.state`'s params for this pass: its window, and the paths its board reads, cut last. */
function stateParams(look: Look): { handle?: string; keep?: string[] } {
  return look.keepPaths.length ? { ...look.h, keep: look.keepPaths } : { ...look.h };
}

/**
 * The evidence pass before it touches the page's clock: load, readiness, status, the requested
 * state and the eye cameras. A phase answers `{ value }` to end the pass with that result, or
 * nothing to hand on.
 */
const LOOK_OPENING: Array<(look: Look) => Promise<LookEnd>> = [loadPage, reachRequestedState];

/**
 * The evidence pass on the page itself, in order, inside the `finally` that hands the game back
 * running.
 */
const LOOK_PHASES: Array<(look: Look) => Promise<LookEnd>> = [
  proveAndDrive,
  inspectEmptyScene,
  readSurfaces,
  photographCameras,
  photographUserView,
  runDemos,
  runChallenge,
  weighFrames,
  replayKeptRoutes,
  readLateStatus,
  readConsole,
  reportLook,
];

/** The sentence a page that measured itself not ready owes the judge, worded by case. */
function notReadyProblem(ready: AnyRecord): string {
  const reason = ready.reason ? `: ${ready.reason}` : "";
  if (ready.timedOut)
    return `the page never reported itself ready within ${((ready.budgetMs ?? 0) / SECOND_MS).toFixed(1)} s${reason}`;
  if (ready.phase === "failed") return `the page reported itself failed: ${ready.reason ?? "no reason given"}`;
  return `the page is not ready (${ready.phase ?? "unknown"})${reason}`;
}

/**
 * (2) ready: the page says when it is up, and the studio believes it rather than sleeping. A
 * not-ready-but-not-timed-out page used to skip the drive block (where the missing-contract
 * sentence lives), take one frame and come back ok: true. Every `ready === false` the page
 * actually measured is a problem, worded by case.
 */
async function readReadiness(look: Look): Promise<void> {
  const { ctx, h, problems, warnings } = look;
  look.ready = null;
  look.readyAfterMs = null;
  look.bootedFor = true;
  try {
    const answer = await ctx.call(HostMethod.PreviewReady, { ...h });
    if (isRecord(answer) && typeof answer.ready === "boolean") look.ready = answer;
  } catch {
    /* an older studio has no preview.ready; readiness is simply unmeasured */
  }
  const { ready } = look;
  if (!ready) return;
  if (ready.via === "shim" && Number.isFinite(ready.pageMs)) look.readyAfterMs = ready.pageMs;
  // `via: "none"` is a page the studio cannot reach at all — unmeasured, not failed.
  if (ready.ready === false && ready.via !== "none") {
    look.bootedFor = false;
    problems.push(notReadyProblem(ready));
  }
  if (look.readyAfterMs !== null && look.readyAfterMs > SLOW_BOOT_MS) {
    warnings.push(
      `the page took ${(look.readyAfterMs / SECOND_MS).toFixed(1)} s to report itself ready — every pass of the run pays that boot`,
    );
  }
}

/** (1) load, (2) ready and (3) status: read on a settled page, not on one still loading. */
async function loadPage(look: Look): Promise<LookEnd> {
  const { ctx, entry, handle, iterationId, labelPrefix, root, run, scaffold, setup } = look;
  // The state to look at: a worker's own (one map per worker on a big game), else the run's.
  look.requestedSetup = setup === undefined ? run.setup : setup;
  const h = handle ? { handle } : {};
  look.h = h;
  look.prefix = labelPrefix ?? `iter_${iterationId}`;
  const problems: string[] = [];
  look.problems = problems;
  // Defects worth telling the judge and the next builder about, but not worth voiding an
  // otherwise judgeable challenger over.
  look.warnings = [];
  // The base pass of a shared scaffold is the one place a dead clock or a dead contract must
  // stop the run; a later iteration warns, so one regression never voids a whole run.
  look.baseStage = scaffold === true && iterationId === "base";

  await sizeWindow(look);

  // ── (1) load ──
  if (root || entry)
    await ctx.call(HostMethod.PreviewLoad, {
      project: run.project,
      ...(root ? { root } : {}),
      ...(entry ? { entry } : {}),
      ...h,
    });
  else await ctx.call(HostMethod.PreviewReload, { ...h });

  // ── (2) ready ──
  await readReadiness(look);

  // ── (3) status: read on a settled page, not on one still loading ──
  const status = await ctx.call(HostMethod.PreviewStatus, { ...h });
  look.status = status;
  // The OS reclaiming memory kills a window whatever it runs: a typed flag the classifier reads,
  // so a build is not rolled back for the machine's pressure (`classifyEvidenceFailure`).
  look.machineKilled = killedByMachine(status);
  if (status.loadError) problems.push(status.loadError);
  if (status.crashed) problems.push(RENDERER_CRASHED);
}

/**
 * (0) size: a look asked at another size (the art director's 1600×900) resizes its leased window
 * before the load, so the page lays itself out at that size; the live view is the user's and is
 * never resized. A window the host will not size is judged at its own size, with a warning.
 */
async function sizeWindow(look: Look): Promise<void> {
  const { ctx, handle, viewport, warnings } = look;
  if (!handle || !viewport) return;
  try {
    await ctx.call(HostMethod.PreviewViewport, { handle, width: viewport.width, height: viewport.height });
  } catch (err: any) {
    warnings.push(
      `the window could not be sized to ${viewport.width}×${viewport.height} (${err?.message ?? err}) — it was judged at its own size`,
    );
  }
}

/** (4) setup, the player-eye cameras the game has, and the readings the page phases fill. */
async function reachRequestedState(look: Look): Promise<LookEnd> {
  const { ctx, eyes, h, prefix, requestedSetup, run, status, warnings } = look;
  // ── (4) setup: the requested state — the scout's setup script,
  // replayed before anyone looks: the gesture, then start, then the map picker opened, the map
  // chosen, and a probe that says it landed. A build judged on the boot screen while the brief
  // was about another map cost a whole run. Replayed AFTER the readiness poll, because the scout
  // recorded it on a booted page: at 0 ms the same click lands on empty space.
  look.requestedState = null;
  const pageCameUp = look.bootedFor && !status.loadError && !status.crashed;
  if (requestedSetup && pageCameUp) {
    look.requestedState = await applySetup(ctx, requestedSetup, { ...h });
    if (look.requestedState.reached === false)
      warnings.push(`requested state not reached: ${look.requestedState.reason}`);
    if (look.requestedState.error) warnings.push(`setup script failed: ${look.requestedState.error}`);
  }

  // Harness-owned player-eye cameras (v2 contract): present when the game passed `camera` and
  // `player()` into installStudio. A board game has no eye worth photographing, so it is not
  // asked; a game that declares no kind is looked at exactly as before.
  look.eyeNames = [];
  const looksThroughEyes = eyes && look.bootedFor && kinds.wantsEyeCameras(run?.game);
  if (looksThroughEyes) {
    try {
      const declared = await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Eyes, ...h });
      if (Array.isArray(declared)) look.eyeNames = declared.map(String).filter((name) => name.startsWith("eye:"));
    } catch {
      look.eyeNames = [];
    }
  }
  const motionFrames: AnyRecord[] = [];
  look.motionFrames = motionFrames;
  const motionCamera = look.eyeNames.includes("eye:here") ? "eye:here" : null;
  look.motionCamera = motionCamera;
  const takeMotionFrame = async (index: number): Promise<void> => {
    if (motionCamera)
      await ctx.call(HostMethod.PreviewCall, { method: PageMethod.DebugCamera, arg: motionCamera, ...h });
    const shot = await ctx.call(HostMethod.PreviewScreenshot, {
      runId: run.runId,
      label: `${prefix}/motion/m${String(index).padStart(2, "0")}`,
      surface: "canvas",
      ...h,
    });
    motionFrames.push({
      index,
      camera: motionCamera ?? "current",
      path: shot.path,
      bytes: shot.bytes,
      base64: shot.base64,
      stats: shot.stats ?? null,
      surface: photographed(shot),
    });
  };
  look.takeMotionFrame = takeMotionFrame;

  look.state = null;
  look.stateEarly = null;
  look.play = null;
  look.audioProbe = null;
  look.clockProof = {
    ok: null,
    frames: 0,
    drawCalls: 0,
    ms: 0,
    reason: "readiness never got far enough to step the clock",
  };
  // The base stage's no-draw sentence, held until inspection says whether the scene is empty.
  look.noDrawPending = null;
}

/**
 * Where a failed clock proof goes. A page with no canvas at all is the DOM-first-screen shape the
 * readiness ladder exists for: frames without draws there is a warning, never a verdict. The shim
 * not loading is not a fact about the game: nothing measured below can be believed on any stage,
 * so it is a problem on a challenger exactly as on the base.
 *
 * An empty shared base draws nothing because there is nothing in it. That is the one stage where
 * blankness is allowed, and the exemption is settled by inspection a few steps below
 * (emptyScene) — so the no-draw verdict waits for it rather than failing the scaffold every run.
 */
function weighClockFailure(look: Look, proof: StepProof): void {
  const { baseStage, problems, warnings } = look;
  const soft = proof.code === "no-draw" && proof.canvas === false;
  const drawsLater = baseStage && proof.code === "no-draw" && !soft;
  if (proof.code === "no-clock") problems.push(proof.reason);
  else if (drawsLater) look.noDrawPending = proof.reason;
  else if (baseStage && !soft) problems.push(proof.reason);
  else warnings.push(proof.reason);
}

/** (5) prove: seed and pause first, then prove the studio owns the clock. */
async function proveClock(look: Look): Promise<void> {
  const { ctx, h, seed, warnings } = look;
  await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Seed, arg: seed, ...h });
  await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Pause, ...h });
  const proof = await proveStep(ctx, h, PROOF_STEP_MS);
  look.clockProof = {
    ok: proof.ok,
    frames: proof.frames,
    drawCalls: proof.drawCalls,
    ms: proof.ms,
    reason: proof.reason,
    idle: proof.idle,
    idleLoop: proof.idleLoop,
  };
  if (proof.ok && proof.idleLoop) warnings.push(proof.note);
  if (!proof.ok) weighClockFailure(look, proof);
}

/**
 * (6) the opening sample. Two samples, ~30 simulated seconds apart: the first run judged on 5
 * uneventful seconds, where every build's numbers look identical. The judge needs to see what
 * MOVED. The early sample is taken BEFORE the scripted controls, so `delta('player.yaw')` and
 * `delta('player.x')` measure what the controls did — the first v2 run took it after them and
 * every probe delta measured drift. The two proving steps sit before it, so the early sample is
 * the same distance into the simulation for every build.
 */
async function sampleOpening(look: Look): Promise<void> {
  const { ctx, h } = look;
  await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Step, arg: DRIVE_STEP_MS, ...h });
  look.stateEarly = await ctx.call(HostMethod.PreviewState, stateParams(look));
}

/** `state().flow` as the harness reads it: whether the game is in play, and the phase it names. */
function flowOf(state: unknown): { playing: boolean; phase: string | null } | null {
  const flow = isRecord(state) ? state.flow : null;
  if (!isRecord(flow) || typeof flow.playing !== "boolean") return null;
  return { playing: flow.playing, phase: typeof flow.phase === "string" ? flow.phase : null };
}

/** What the pass records of the front-end: always declared, reached only when `flow.playing`. */
function playReach(flow: { playing: boolean; phase: string | null }, via: PlayVia, ms: number): PlayReach {
  return { declared: true, reached: flow.playing, phase: flow.phase, via, ms };
}

/**
 * (6a) play. A game with a title, menu or countdown reports `state().flow`, and the drive must
 * start in play: otherwise every throttle lands in the countdown `seed()` just restarted and the
 * judges rate a standing car. Read off the opening sample, so a game that
 * reports no flow, or is in play already, is driven call for call as before. Stepped, never slept;
 * a game that does not get there is a warning, never a voided challenger.
 */
async function reachPlay(look: Look): Promise<void> {
  const flow = flowOf(look.stateEarly);
  if (!flow) return;
  if (flow.playing) {
    look.play = playReach(flow, PlayVia.Boot, 0);
    return;
  }
  // The worker that owns the front-end is judged on its menu, not past it.
  if (look.requestedSetup?.begin === false) {
    look.play = playReach(flow, PlayVia.Kept, 0);
    return;
  }
  const via = await enterPlay(look);
  const { state, ms } = await waitForPlay(look);
  // The early sample is the state the controls start from: in play, after the countdown.
  look.stateEarly = state;
  look.play = playReach(flowOf(state) ?? flow, via, ms);
  if (!look.play.reached) look.warnings.push(outsidePlay(look.play, startKeysOf(look.run?.game), look.beginRefusal));
}

/** `__studio.begin()`, or the declared start keys when the page has none; how the pass asked. */
async function enterPlay(look: Look): Promise<PlayVia> {
  const { ctx, h, run } = look;
  const began = await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Begin, ...h }).catch(() => null);
  if (isRecord(began) && began.ok === true) return PlayVia.Begin;
  // What the page answered, quoted in the warning: a config.begin that threw is not a missing one.
  look.beginRefusal =
    isRecord(began) && typeof began.reason === "string" ? clip(began.reason, BEGIN_REASON_CHARS) : null;
  const keys = startKeysOf(run?.game);
  if (!keys.length) return PlayVia.Wait;
  await applyPlayScript(ctx, [{ type: "tap", keys }], { clock: "step", runId: run.runId, ...h });
  return PlayVia.Keys;
}

/** Step the clock until the game says it is in play, or the wait runs out: the last state, and how long. */
async function waitForPlay(look: Look): Promise<{ state: unknown; ms: number }> {
  const { ctx, h } = look;
  let ms = 0;
  let state = await ctx.call(HostMethod.PreviewState, stateParams(look));
  while (flowOf(state)?.playing !== true && ms < PLAY_WAIT_MAX_MS) {
    await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Step, arg: PLAY_WAIT_STEP_MS, ...h });
    ms += PLAY_WAIT_STEP_MS;
    state = await ctx.call(HostMethod.PreviewState, stateParams(look));
  }
  return { state, ms };
}

/**
 * What a judge and the next builder are told when the drive started outside play. `refusal` is
 * what `__studio.begin()` answered when it would not begin, quoted as the page said it.
 */
function outsidePlay(play: PlayReach, keys: string[], refusal: string | null = null): string {
  const seconds = PLAY_WAIT_MAX_MS / SECOND_MS;
  const refused = refusal ? `__studio.begin() answered "${refusal}"` : "the game has no __studio.begin()";
  const keysFailed = `the start keys (${keys.join("/")}) did not bring the game to flow.playing within ${seconds} s`;
  const asked =
    play.via === PlayVia.Keys
      ? `${refusal ? `${refused}; ` : ""}${keysFailed}`
      : `__studio.begin() did not bring the game to flow.playing within ${seconds} s`;
  const why =
    play.via === PlayVia.Wait
      ? `${refused} and no declared start keys, and did not reach flow.playing on its own within ${seconds} s`
      : asked;
  return `the drive began outside play (flow.phase "${play.phase ?? "unknown"}") — ${why}; the scripted controls landed in the front-end`;
}

/** The declared start keys, from a kinds.ts that may predate them. */
function startKeysOf(game: AnyRecord | null | undefined): string[] {
  return typeof kinds.startKeysFor === "function" ? kinds.startKeysFor(game) : [];
}

/** The keys this kind cruises on through the drive, from a kinds.ts that may predate them. */
function cruiseOf(game: AnyRecord | null | undefined): string[] {
  return typeof kinds.cruiseFor === "function" ? kinds.cruiseFor(game) : [];
}

/** The throttle the bot holds, whatever script the plan wrote, from a kinds.ts that may predate it. */
function throttleOf(game: AnyRecord | null | undefined): string[] {
  return typeof kinds.throttleFor === "function" ? kinds.throttleFor(game) : [];
}

/** Whether the drive of this kind watches for a corner, from a kinds.ts that may predate it. */
function cornersOf(game: AnyRecord | null | undefined): boolean {
  return typeof kinds.cornersFor === "function" ? kinds.cornersFor(game) : false;
}

/**
 * The racing-line assist on or off (`__studio.assist`, the template's `config.steer`): whether the
 * game's own line steers now. A game without one answers that it has none, and an older studio.js
 * has no such verb at all: either way the drive is today's — the throttle held, nothing steering.
 */
async function steerByLine(look: Look, on: boolean): Promise<boolean> {
  const { ctx, h } = look;
  const answer = await ctx
    .call(HostMethod.PreviewCall, { method: PageMethod.Assist, arg: { steer: on }, ...h })
    .catch(() => null);
  return isRecord(answer) && answer.ok === true && answer.steer === true;
}

/**
 * The controls the drive presses. A kept front-end (`setup.begin === false`) is pressed by
 * nothing: the kind's exercise would start a title that takes any key on its throttle, and a
 * script the game declared is written for play, so its first Enter would start it too. The
 * worker building that title is judged on it, not on the countdown behind it; the clock still runs.
 */
function driveScriptOf(look: Look): unknown {
  return look.play?.via === PlayVia.Kept ? [] : kinds.playScriptFor(look.run?.game);
}

/**
 * (6b) drive: the game's OWN controls every iteration so feel/play are judged on play, not idle
 * time — and so a board game is clicked rather than walked. A racer or a craft then holds its
 * throttle through the rest of the drive (`cruise`), released before the cameras: a racer
 * photographed after thirty seconds of coasting is a parked car. Both sides of every comparison
 * get the same inputs.
 *
 * The cruise steers by the game's own racing line when it has one (`config.steer`): a held
 * throttle that nothing steers ends the drive with the car against a wall. A racer's drive also
 * watches its heading for a corner to photograph (`watchCorner`).
 */
async function driveGame(look: Look): Promise<void> {
  const { ctx, h, run } = look;
  await applyPlayScript(ctx, driveScriptOf(look), { clock: "step", runId: run.runId, ...h });
  // A menu is never held on the throttle: the front-end's own worker, or a game that never got into play.
  const onMenu = Boolean(look.play && !look.play.reached);
  const cruise = onMenu ? [] : cruiseOf(run?.game);
  look.cornerWatch = !onMenu && cornersOf(run?.game) ? newCornerWatch() : null;
  if (cruise.length) {
    await ctx.call(HostMethod.PreviewInput, { actions: [{ type: "down", keys: cruise }], ...h });
    look.drive = { steered: await steerByLine(look, true) };
  }
  try {
    await stepThroughDrive(look);
  } finally {
    await releaseCruise(look, cruise);
  }
  look.corner = cornerReport(look);
}

/** Let go of the cruise: the line's steering, then the throttle. */
async function releaseCruise(look: Look, cruise: string[]): Promise<void> {
  if (!cruise.length) return;
  if (look.drive?.steered) await steerByLine(look, false);
  await look.ctx.call(HostMethod.PreviewInput, { actions: [{ type: "up", keys: cruise }], ...look.h }).catch(() => {});
}

/**
 * The drive's steps, with the motion strip: a few frames spread over them, from the player's eye
 * — feel is judged from motion, not from two JSON snapshots.
 */
async function stepThroughDrive(look: Look): Promise<void> {
  const { ctx, h, motion, motionFrames, takeMotionFrame } = look;
  const motionAt = new Set<number>();
  if (motion > 0)
    for (let k = 0; k < motion; k++) motionAt.add(Math.round((k * LAST_DRIVE_STEP) / Math.max(1, motion - 1)));
  for (let i = 0; i < DRIVE_STEPS; i++) {
    if (motionAt.has(i)) {
      try {
        await takeMotionFrame(motionFrames.length + 1);
      } catch {
        /* a lost motion frame is a thinner strip, never a voided challenger */
      }
    }
    await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Step, arg: DRIVE_STEP_MS, ...h });
    await watchCorner(look, i);
  }
}

// ── the drive's corner ─────────────────────────────────────────────────────────────────────

/**
 * The player's heading, read page-side after a drive step: `state().player.yaw` in radians, or
 * null when the game reports none. One small answer, not the whole state over the wire.
 */
const CORNER_PROBE = `(() => {
  /* studio corner probe */
  try {
    var s = window.__studio;
    var state = s && typeof s.state === "function" ? s.state() : null;
    var player = state && state.player;
    var yaw = player ? player.yaw : null;
    return { yaw: typeof yaw === "number" && isFinite(yaw) ? yaw : null };
  } catch (err) {
    return null;
  }
})()`;

/** What the drive has seen of a racer's heading so far, and the corner once it photographed one. */
interface CornerWatch {
  /** The heading after the last step, radians; null before the first read. */
  yaw: number | null;
  /** The fastest turn seen after the settle, radians per second. */
  maxTurn: number;
  /** The first read answered nothing: the game reports no heading, and the drive stops asking. */
  unreadable: boolean;
  /** The turn-in the drive photographed: when, and how fast the heading was turning. */
  corner: { atMs: number; turn: number } | null;
}

const newCornerWatch = (): CornerWatch => ({ yaw: null, maxTurn: 0, unreadable: false, corner: null });

/** The heading the probe read, or null when the game reports none. */
async function readHeading(look: Look): Promise<number | null> {
  const { ctx, h } = look;
  const answer = await ctx.call(HostMethod.PreviewEvaluate, { expression: CORNER_PROBE, ...h }).catch(() => null);
  const yaw = isRecord(answer) ? answer.yaw : null;
  return typeof yaw === "number" && Number.isFinite(yaw) ? yaw : null;
}

/** The signed change from one heading to the next, wrapped to a half turn either way. */
const headingChange = (from: number, to: number): number => Math.atan2(Math.sin(to - from), Math.cos(to - from));

/**
 * After drive step `step`: read the heading, and when it is turning like a corner (and the controls'
 * own swerve is behind), photograph the turn-in once — what the corner warnings, the braking and
 * the line look like, which the frame wherever the drive ended almost never shows.
 */
async function watchCorner(look: Look, step: number): Promise<void> {
  const watch: CornerWatch | null = look.cornerWatch;
  if (!watch || watch.unreadable || watch.corner) return;
  const yaw = await readHeading(look);
  if (yaw === null) {
    watch.unreadable = watch.yaw === null;
    return;
  }
  const previous = watch.yaw;
  watch.yaw = yaw;
  if (previous === null || step < CORNER_SETTLE_STEPS) return;
  const turn = Math.abs(headingChange(previous, yaw)) / (DRIVE_STEP_MS / SECOND_MS);
  watch.maxTurn = Math.max(watch.maxTurn, turn);
  if (turn < CORNER_TURN_RAD_PER_S) return;
  watch.corner = { atMs: (step + 1) * DRIVE_STEP_MS, turn };
  await photographCorner(look);
}

/** The turn-in as the game renders it, filed as `drive:corner`; a lost frame is a thinner look, never a failure. */
async function photographCorner(look: Look): Promise<void> {
  const { ctx, h, prefix, run } = look;
  try {
    // A motion frame may have left the lens on the player's eye: the corner is the game's own view.
    if (look.motionCamera)
      await ctx.call(HostMethod.PreviewCall, { method: PageMethod.DebugCamera, arg: DEFAULT_CAMERA, ...h });
    const shot = await ctx.call(HostMethod.PreviewScreenshot, {
      runId: run.runId,
      label: `${prefix}/screenshots/drive-corner`,
      surface: "canvas",
      ...h,
    });
    look.cornerShot = {
      camera: CORNER_CAMERA,
      path: shot.path,
      bytes: shot.bytes,
      base64: shot.base64,
      stats: shot.stats ?? null,
      surface: photographed(shot),
    };
  } catch {
    look.cornerShot = null;
  }
}

/** What the drive says of corners (`evidence.corner`): the turn-in it photographed, the fastest turn it saw, or that it could not tell. */
function cornerReport(look: Look): AnyRecord | null {
  const watch: CornerWatch | null = look.cornerWatch;
  if (!watch) return null;
  if (watch.unreadable) return { seen: false, unreadable: true };
  const { corner } = watch;
  if (!corner || !look.cornerShot)
    return { seen: false, turnDegPerSecond: Math.round(watch.maxTurn * DEGREES_PER_RADIAN) };
  return { seen: true, atMs: corner.atMs, turnDegPerSecond: Math.round(corner.turn * DEGREES_PER_RADIAN) };
}

/**
 * What the studio's bound did to the state, said once: a bounded state names what it cut (a
 * check reading into a stub is unmeasured), and an older studio's string cut left nothing to read.
 */
function sayStateCut(look: Look): void {
  const { state, warnings } = look;
  const cut = stateCutOf(state);
  if (cut) {
    const paths = cut.paths.length ? cut.paths.join(", ") : "its largest values";
    warnings.push(
      `__studio.state() is ${cut.chars.toLocaleString("en-US")} chars, over what the studio reads whole, so it cut ${paths} to stubs — a check that reads into them is unmeasured; keep long lists out of state()`,
    );
    return;
  }
  if (!isTruncatedState(state)) return;
  const chars = Number(state.length);
  const size = Number.isFinite(chars) ? `${chars.toLocaleString("en-US")} chars` : "over budget";
  warnings.push(
    `__studio.state() is ${size} and came back cut to a string — nothing in it could be read; report less in state()`,
  );
}

/** The state the drive left, what it says is wrong with the page, and what the game sounds like. */
async function readDrivenState(look: Look): Promise<void> {
  const { audio, ctx, h, problems } = look;
  look.state = await ctx.call(HostMethod.PreviewState, stateParams(look));
  if (look.state?.__missing) problems.push(MISSING_CONTRACT);
  if (look.state?.error) problems.push(`runtime error: ${look.state.error.message}`);
  sayStateCut(look);
  if (!audio || look.state?.__missing) return;
  try {
    const probe = (await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Audio, ...h })) as AnyRecord | null;
    if (isRecord(probe) && !probe.__missing) look.audioProbe = probe;
  } catch {
    look.audioProbe = null;
  }
}

/** (5) prove the studio owns the clock, (6) sample it, reach play, then drive the game's own controls. */
async function proveAndDrive(look: Look): Promise<LookEnd> {
  if (!look.bootedFor) return;
  try {
    await proveClock(look);
    await sampleOpening(look);
    await reachPlay(look);
    await driveGame(look);
    await readDrivenState(look);
  } catch (err: any) {
    look.problems.push(`could not drive the game: ${err?.message ?? err}`);
  }
}

/** Whether an empty shared base is empty by inspection, and the base's held no-draw sentence. */
async function inspectEmptyScene(look: Look): Promise<LookEnd> {
  const { baseStage, ctx, h, problems, warnings } = look;
  // An empty shared base is infrastructure, not a finished game. Only this harness-owned
  // stage may accept empty pixels, and only when inspection proves no content exists.
  // A game's self-reported phase/drawCalls cannot turn off challenger health checks.
  look.emptyScene = false;
  if (baseStage) {
    try {
      look.emptyScene = (await ctx.call(HostMethod.PreviewEvaluate, { expression: EMPTY_SCENE_PROBE, ...h })) === true;
    } catch {
      /* missing inspection never exempts a broken build */
    }
  }
  // A base that drew nothing: a scaffold with nothing in it is infrastructure and passes with a
  // warning; a base that has content and still drew nothing is broken and says so.
  if (look.noDrawPending) {
    if (look.emptyScene) warnings.push(look.noDrawPending);
    else problems.push(look.noDrawPending);
    look.noDrawPending = null;
  }
}

/** (7) surfaces: asked once, after the setup and before the cameras. */
async function readSurfaces(look: Look): Promise<LookEnd> {
  const { ctx, h } = look;
  // ── (7) surfaces: asked once, after the setup and before the cameras ──
  // The CAMERA frames stay canvas-sourced whatever this says: their stats feed the pixel
  // checks, the blank-build guard and style distance, and grading a DOM menu as if it were
  // the game defeats an identity-weight check class for exactly the games this serves.
  look.pageUi = null;
  if (look.bootedFor) {
    try {
      const probe = (await ctx.call(HostMethod.PreviewPageUi, { ...h })) as AnyRecord | null;
      if (isRecord(probe) && Array.isArray(probe.entries)) look.pageUi = probe;
    } catch {
      /* an older studio cannot see outside the canvas; nothing downstream depends on it */
    }
  }
  const uiEntries = (look.pageUi?.entries ?? []).map(String);
  look.uiEntries = uiEntries;
  const uiCoverage = Number.isFinite(look.pageUi?.coverage) ? Number(look.pageUi.coverage) : null;
  look.uiCoverage = uiCoverage;
  const uiPrimary = look.pageUi ? look.pageUi.uiPrimary === true || (uiCoverage !== null && uiCoverage >= 0.25) : false;
  look.uiPrimary = uiPrimary;
}

/** A shot the camera could not give: it is not registered, and the sentence says what is. */
type MissingShot = Shot & { missing?: boolean; reason?: string };

/**
 * Only a viewpoint the GAME declares is censused for placement: the floor's own guesses
 * answering from one frozen pose is the harness asking twice, not a base that never placed its
 * cameras.
 */
async function recordCameraPose(look: Look, camera: string): Promise<void> {
  const { cameraPoses, ctx, h, problems } = look;
  try {
    const pose = await ctx.call(HostMethod.PreviewEvaluate, { expression: CAMERA_POSE_PROBE, ...h });
    if (typeof pose === "string") cameraPoses.set(camera, pose);
    else problems.push(`camera(${camera}) has no valid transform`);
  } catch {
    problems.push(`camera(${camera}) cannot be inspected`);
  }
}

/** Point the page at `camera` and photograph it — or answer that it is not registered. */
async function takeShot(
  look: Look,
  camera: string,
  label: string,
  { anyway = false, floor = false }: { anyway?: boolean; floor?: boolean } = {},
): Promise<MissingShot> {
  const { askedFor, ctx, h, prefix, run } = look;
  const placed = (await ctx.call(HostMethod.PreviewCall, {
    method: PageMethod.DebugCamera,
    arg: camera,
    ...h,
  })) as AnyRecord | null;
  const unregistered = isRecord(placed) && placed.ok === false;
  if (unregistered && !anyway) {
    const available = (placed.available ?? []).join(", ") || "none";
    return {
      camera,
      missing: true,
      reason: placed.reason ?? `camera "${camera}" is not registered (available: ${available})`,
    };
  }
  askedFor.push(camera);
  if (look.emptyScene && !floor) await recordCameraPose(look, camera);
  const shot = await ctx.call(HostMethod.PreviewScreenshot, {
    runId: run.runId,
    label: `${prefix}/screenshots/${label}`,
    surface: "canvas",
    ...h,
  });
  // The surface the port says it PHOTOGRAPHED, not the one we asked for: a canvas read that
  // declined is answered by the compositor, and the dead-debugCamera guard below is written
  // to forgive exactly that. Hardcoding "canvas" here made that guard unreachable.
  return {
    camera,
    path: shot.path,
    bytes: shot.bytes,
    base64: shot.base64,
    stats: shot.stats ?? null,
    surface: photographed(shot),
    registered: !unregistered,
  };
}

/** The cameras the game registers (`__studio.cameras()`), or null for a game predating cameras(). */
async function registeredCameraNames(look: Look): Promise<string[] | null> {
  const { ctx, h } = look;
  try {
    const answer = await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Cameras, ...h });
    return Array.isArray(answer) ? answer.map(String) : null;
  } catch {
    return null;
  }
}

/** Add `name` to the cameras to photograph, once. */
function addCamera(names: string[], name: string): void {
  if (!names.includes(name)) names.push(name);
}

/**
 * Without a spec: "default" plus whatever the game declares, capped so the judge is not flooded
 * — with a FLOOR, because the template registers ONE camera and the classic trio has always
 * been the harness's, not the game's: a game declaring fewer than two viewpoints is still asked
 * for close and wide, and an unregistered one of those is skipped silently.
 */
async function declaredCameraNames(look: Look, cameraNames: string[], floorCameras: Set<string>): Promise<void> {
  cameraNames.push(DEFAULT_CAMERA);
  look.declaredCameras = await registeredCameraNames(look);
  const declared: string[] = look.declaredCameras ?? [];
  for (const name of declared)
    if (!cameraNames.includes(name) && cameraNames.length < MAX_CAMERAS) cameraNames.push(name);
  // "default" above is the HARNESS asking for the view the page renders. A game that names
  // its own cameras and none of them "default" declares one viewpoint fewer than the count
  // suggests, and its two identical frames are one view photographed twice — not a dead
  // debugCamera. Floor it, the way close and wide are floored.
  if (declared.length > 0 && !declared.includes(DEFAULT_CAMERA)) floorCameras.add(DEFAULT_CAMERA);
  if (declared.length >= 2) return;
  for (const name of FLOOR_CAMERAS) {
    if (!cameraNames.includes(name) && cameraNames.length < MAX_CAMERAS) {
      cameraNames.push(name);
      floorCameras.add(name);
    }
  }
}

/**
 * Which cameras to photograph. With a spec, exactly the cameras the facet names (default first)
 * plus the eye cameras; without one, the game's own with a floor (`declaredCameraNames`). A page
 * that never booted gets one frame: 30 step round trips against it is the endless hold, and a
 * human still sees whatever the page drew.
 */
async function chooseCameras(look: Look): Promise<void> {
  const { cameras } = look;
  const cameraNames: string[] = [];
  look.cameraNames = cameraNames;
  // ONE binding, populated on BOTH branches: the "registered: …" half of every sentence below
  // was a ReferenceError against a block-scoped shadow before this milestone.
  look.declaredCameras = null;
  const floorCameras = new Set<string>();
  look.floorCameras = floorCameras;
  const wantEyes = look.eyeNames.filter((name: string) => EYE_CAMERAS.includes(name));
  look.wantEyes = wantEyes;
  // What the game registers, recorded whichever cameras are photographed: a camera another facet
  // depends on that a build deleted is a regression, and only this list can show it.
  look.registeredCameras = null;
  if (!look.bootedFor) cameraNames.push(DEFAULT_CAMERA);
  else if (Array.isArray(cameras) && cameras.length > 0) {
    // A facet's camera that is a demo's end or the drive's corner is a frame the pass takes on its
    // own, never a viewpoint to ask debugCamera for (nor one "not registered in config.cameras").
    const viewpoints = cameras.map(String).filter((name) => !isPassFrame(name));
    for (const name of [DEFAULT_CAMERA, ...viewpoints]) addCamera(cameraNames, name);
    for (const name of wantEyes) addCamera(cameraNames, name);
    look.registeredCameras = await registeredCameraNames(look);
  } else {
    await declaredCameraNames(look, cameraNames, floorCameras);
    for (const name of wantEyes) addCamera(cameraNames, name);
    look.registeredCameras = look.declaredCameras;
  }
  // The viewpoints the GAME claims to have: the floor's guesses are not among them, so an
  // identical frame from a camera nobody declared is not evidence of dead wiring.
  look.declaredViewpoints = cameraNames.filter((name) => !name.startsWith("eye:") && !floorCameras.has(name));
}

/**
 * One camera's frame, kept on `shots`. A capture that raced the compositor returns the previous
 * camera's pixels: one retake settles the race; only a shot identical after the retake counts as
 * a dead debugCamera. A "default" the game never registered is noted on the look.
 */
async function shootCamera(look: Look, camera: string): Promise<void> {
  const { floorCameras, missingCameras, shots } = look;
  const label = camera.replace(/[^a-z0-9-_]+/gi, "-");
  // A game that registers no "default" is still photographed on the view it renders — the
  // whole point of this milestone — instead of three frames of one frozen viewpoint.
  const options = { anyway: camera === DEFAULT_CAMERA, floor: floorCameras.has(camera) };
  let shot = await takeShot(look, camera, label, options);
  if (shot.missing) {
    // A spec camera the build never registered is a defect for the builder, not a stale
    // duplicate for the judge: skip the frame and say so. A floor camera nobody asked for is
    // skipped silently, and eye cameras only exist on v2.
    if (!camera.startsWith("eye:") && !floorCameras.has(camera)) missingCameras.push(camera);
    return;
  }
  if (camera === DEFAULT_CAMERA && shot.registered === false) look.registeredDefault = false;
  if (shot.base64 && shots.some((other: Shot) => other.base64 === shot.base64)) {
    shot = await takeShot(look, camera, label, options);
    if (shot.missing) return;
  }
  shots.push(shot);
}

/** What the camera census owes the builder: a missing "default", and cameras named but never registered. */
function cameraWarnings(look: Look): void {
  const { cameras, missingCameras, problems, scaffold, warnings } = look;
  if (!look.registeredDefault) {
    warnings.push(
      `this game registers no "default" camera (registered: ${(look.declaredCameras ?? []).join(", ") || "none"}) — every frame is the view the game itself renders`,
    );
  }
  if (!missingCameras.length) return;
  const namesCameras = Array.isArray(cameras) && cameras.length > 0;
  if (scaffold && namesCameras) problems.push(`shared base is missing required cameras: ${missingCameras.join(", ")}`);
  warnings.push(
    `cameras named by the facet but not registered in config.cameras: ${missingCameras.join(", ")} — register them in main.js`,
  );
}

/** The cameras: the facet's own or the game's, with a floor, and what is missing. */
async function photographCameras(look: Look): Promise<LookEnd> {
  const { problems } = look;
  look.cameraPoses = new Map<string, string>();
  look.shots = [] as Shot[];
  look.askedFor = [] as string[];
  await chooseCameras(look);
  look.missingCameras = [] as string[];
  look.registeredDefault = true;
  for (const camera of look.cameraNames) {
    try {
      await shootCamera(look, camera);
    } catch (err: any) {
      problems.push(`screenshot(${camera}) failed: ${err?.message ?? err}`);
    }
  }
  cameraWarnings(look);
}

/** The fraction of pixels the page frame and the default camera's canvas frame differ by, or null when nobody could tell. */
async function userViewDiff(look: Look, shot: AnyRecord): Promise<number | null> {
  const { ctx, h, prefix, run, shots } = look;
  const canvasShot = shots.find((s: Shot) => s.camera === DEFAULT_CAMERA);
  if (!canvasShot?.path || !shot.path) return null;
  const diff = await ctx
    .call(HostMethod.PreviewDiff, {
      runId: run.runId,
      a: shot.path,
      b: canvasShot.path,
      label: `${prefix}/diff_user-view`,
      ...h,
    })
    .catch(() => null);
  const measured = isRecord(diff) && diff.compared > 0 && Number.isFinite(diff.diffFraction);
  return measured ? diff.diffFraction : null;
}

/** What the user's-eye frame tells the judge: UI outside the canvas, or a page that differs from it. */
function userViewWarning(uiEntries: string[], diffFraction: number | null): string | null {
  if (uiEntries.length > 0)
    return `this game paints UI outside the canvas (${uiEntries.slice(0, MAX_UI_ENTRIES).join(", ")}) — user:view shows it, the canvas frames do not`;
  if (diffFraction !== null && diffFraction > USER_VIEW_MISMATCH)
    return `the page the user sees differs from the canvas capture on the default camera (${(diffFraction * 100).toFixed(1)}% of pixels) — the page shows UI the canvas does not (DOM HUD, overlays); compare user:view with default`;
  return null;
}

/** The compositor's picture of the page on the default camera, kept when it shows something the canvas does not. */
async function photographPage(look: Look, pageLabel: string): Promise<void> {
  const { ctx, h, run, uiEntries, warnings } = look;
  await ctx.call(HostMethod.PreviewCall, { method: PageMethod.DebugCamera, arg: DEFAULT_CAMERA, ...h });
  const shot = await ctx.call(HostMethod.PreviewScreenshot, {
    runId: run.runId,
    label: pageLabel,
    page: true,
    surface: "page",
    ...h,
  });
  if (!shot?.base64) return;
  const candidate = {
    camera: "user:view",
    path: shot.path,
    bytes: shot.bytes,
    base64: shot.base64,
    stats: shot.stats ?? null,
    surface: photographed(shot, "page"),
  };
  const diffFraction = await userViewDiff(look, shot);
  // Kept when the probe found UI, when the pictures differ, or when nobody could tell;
  // dropped only when the probe found nothing AND a computed diff is under the threshold.
  const differs = diffFraction === null || diffFraction > USER_VIEW_MISMATCH;
  if (uiEntries.length > 0 || differs) look.userViewShot = candidate;
  const warning = userViewWarning(uiEntries, diffFraction);
  if (warning) warnings.push(warning);
}

/**
 * A compositor that cannot give the page frame still owes the judge a picture: retake it off the
 * canvas rather than leaving the label with no pixels behind it.
 */
async function photographPageOffCanvas(look: Look, pageLabel: string): Promise<void> {
  const { ctx, h, run } = look;
  try {
    const fallback = await ctx.call(HostMethod.PreviewScreenshot, {
      runId: run.runId,
      label: pageLabel,
      surface: "canvas",
      ...h,
    });
    if (fallback?.base64)
      look.userViewShot = {
        camera: "user:view",
        path: fallback.path,
        bytes: fallback.bytes,
        base64: fallback.base64,
        stats: fallback.stats ?? null,
        surface: photographed(fallback),
      };
  } catch {
    /* no frame at all: a warning already says why, and no problem is owed */
  }
}

/**
 * The user's-eye frame: the compositor's picture with every DOM element on it, on the default
 * camera. The canvas capture is the judge's picture for good reasons (it works occluded); this
 * one exists so a HUD painted into the DOM — invisible to every canvas shot — can be seen once,
 * and so a game whose UI IS the page is not judged blind.
 */
async function photographUserView(look: Look): Promise<LookEnd> {
  const { prefix, userView, warnings } = look;
  look.userViewShot = null;
  if (!userView || !look.bootedFor) return;
  const pageLabel = `${prefix}/screenshots/user-view`;
  try {
    await photographPage(look, pageLabel);
  } catch (err: any) {
    warnings.push(`user:view capture unavailable: ${err?.message ?? err}`);
    await photographPageOffCanvas(look, pageLabel);
  }
}

/** The most demos beyond the check-named ones a look with this cap runs: one at the least. */
const demoBudget = (maxDemos: number): number => (Number.isFinite(maxDemos) ? Math.max(1, maxDemos) : Infinity);

/**
 * Which demos run, in order, and which the cap leaves out. Every demo a check names runs, always;
 * the cap applies only to the unreferenced remainder, and in it a demo the compared build does not
 * register (`known`) comes first — a builder registers a demo to show its move. A cap that silently
 * dropped check-named demos made the harness report "ADS never engages" for a feature it never
 * looked at, and one that drops the newest judges a builder's move without its frame.
 */
function demosToRun(
  registered: string[],
  requiredDemos: readonly unknown[] | null | undefined,
  maxDemos: number,
  known: readonly string[] | null = null,
): { toRun: string[]; skipped: string[] } {
  const required = new Set((requiredDemos ?? []).map(String));
  const shown = known === null ? null : new Set(known);
  const added = (n: string): boolean => shown !== null && !shown.has(n);
  const rest = registered.filter((n: string) => !required.has(n));
  const ordered: string[] = [
    ...registered.filter((n: string) => required.has(n)),
    ...rest.filter(added),
    ...rest.filter((n: string) => !added(n)),
  ];
  const budget = demoBudget(maxDemos);
  const toRun: string[] = [];
  const skipped: string[] = [];
  let extra = 0;
  for (const name of ordered) {
    if (required.has(name)) toRun.push(name);
    else if (extra < budget) {
      toRun.push(name);
      extra++;
    } else skipped.push(name);
  }
  return { toRun, skipped };
}

/**
 * The state as a demo left it. The `state` sample above was taken before any demo ran, so a
 * number a demo drives (a crash test's kept speed) reads zero there; a probe scoped to this demo
 * is answered from this snapshot instead.
 */
async function demoEndState(look: Look, name: string): Promise<void> {
  const { ctx, demoStates } = look;
  try {
    const after = (await ctx.call(HostMethod.PreviewState, stateParams(look))) as AnyRecord | null;
    if (isRecord(after) && !after.__missing) demoStates[name] = after;
  } catch {
    /* a lost snapshot leaves the probe unmeasured, never failed */
  }
}

/** One demo: run it, and when it ran, keep the state it left and photograph its end frame as it stands. */
async function runDemo(look: Look, name: string): Promise<void> {
  const { ctx, demoShots, demos, h, prefix, run } = look;
  try {
    demos[name] = (await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Demo, arg: name, ...h })) as AnyRecord;
    if (demos[name]?.ok !== true) return;
    await demoEndState(look, name);
    const label = `demo_${name.replace(/[^a-z0-9-_]+/gi, "-")}`;
    const shot = await ctx.call(HostMethod.PreviewScreenshot, {
      runId: run.runId,
      label: `${prefix}/screenshots/${label}`,
      surface: "canvas",
      ...h,
    });
    demoShots.push({
      camera: `demo:${name}`,
      path: shot.path,
      bytes: shot.bytes,
      base64: shot.base64,
      stats: shot.stats ?? null,
      surface: photographed(shot),
    });
  } catch (err: any) {
    demos[name] = { ok: false, error: String(err?.message ?? err) };
  }
}

/**
 * The game's scripted demos, each photographed at its own end state. Behavioural facets are
 * invisible to the generic playthrough (a sit-on-a-bench beat that the scripted WASD walk never
 * reaches judged "pixel-identical" for six iterations), so any scripted demos the game declares
 * run now — after the main shots, because a demo moves the game to its own end state. Each
 * demo's result is data for the judge and its end frame is photographed as it stands (no camera
 * switch: the demo composes its own view).
 */
async function runDemos(look: Look): Promise<LookEnd> {
  const { ctx, h, knownDemos, maxDemos, requiredDemos } = look;
  look.demos = {} as Record<string, AnyRecord>;
  look.demoStates = {} as Record<string, AnyRecord>;
  look.demoShots = [] as Shot[];
  look.registeredDemos = null;
  const skippedDemos: string[] = [];
  look.skippedDemos = skippedDemos;
  look.demoCap = null;
  if (!look.bootedFor) return;
  try {
    const names = await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Demos, ...h });
    if (!Array.isArray(names)) return;
    look.registeredDemos = names.map(String);
    const { toRun, skipped } = demosToRun(look.registeredDemos, requiredDemos, maxDemos, knownDemos);
    skippedDemos.push(...skipped);
    // The cap that left them out, for the judge's line and the builder's next prompt: the harness's
    // limit, never a defect of the build (so not a warning a judge may name as the gap).
    if (skipped.length) look.demoCap = demoBudget(maxDemos);
    for (const name of toRun) await runDemo(look, name);
  } catch {
    /* a game predating the demo contract simply has none */
  }
}

/**
 * The throttle-only bot's race (`throttle-bot-loses`), after the demos because it moves the game
 * to wherever the race ends. Asked for by a board that carries the check, or a ship look; a race
 * that throws is a reading the pass could not take, never a voided challenger.
 */
async function runChallenge(look: Look): Promise<LookEnd> {
  look.challengeRace = null;
  if (!look.challenge || !look.bootedFor) return;
  look.challengeRace = await raceThrottleBot(look).catch((err: unknown) => ({
    ran: false,
    reason: `the race could not be driven: ${(err as Error)?.message ?? err}`,
  }));
}

/** The race block a game reports in `state()`, when it reports a position to win. */
function raceOf(state: unknown): AnyRecord | null {
  const race = isRecord(state) ? state.race : null;
  return isRecord(race) && typeof race.position === "number" ? race : null;
}

/**
 * A bot that holds the throttle, lets the game's racing line steer when it has one, and never
 * brakes, from the game's first screen through its race: a race it wins is no challenge. Stepped in
 * `CHALLENGE_STEP_MS` until the game says the race is finished or `CHALLENGE_MAX_MS` of racing
 * have passed; the state it ends on is what `throttle-bot-loses` reads.
 */
async function raceThrottleBot(look: Look): Promise<AnyRecord> {
  const { ctx, h, run, seed } = look;
  if (!raceOf(look.state)) return { ran: false, reason: MESSAGE.botNoRace };
  const throttle = throttleOf(run?.game);
  if (!throttle.length) return { ran: false, reason: MESSAGE.botNoThrottle };
  await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Seed, arg: seed, ...h });
  await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Pause, ...h });
  const early = await startRace(look);
  if (!early) return { ran: false, reason: MESSAGE.botNoPlay };
  await ctx.call(HostMethod.PreviewInput, { actions: [{ type: "down", keys: throttle }], ...h });
  const steered = await steerByLine(look, true);
  try {
    const { state, ms } = await driveRace(look);
    const race = raceOf(state);
    return {
      ran: true,
      state,
      early,
      simulatedMs: ms,
      finished: race?.finished === true,
      position: race?.position ?? null,
      steered,
    };
  } finally {
    if (steered) await steerByLine(look, false);
    await ctx.call(HostMethod.PreviewInput, { actions: [{ type: "up", keys: throttle }], ...h }).catch(() => {});
  }
}

/** Into the race from the game's first screen, the way the drive gets into play: its state there, or null when it never got there. */
async function startRace(look: Look): Promise<unknown> {
  const { ctx } = look;
  const first = await ctx.call(HostMethod.PreviewState, stateParams(look));
  const flow = flowOf(first);
  if (!flow || flow.playing) return first;
  await enterPlay(look);
  const { state } = await waitForPlay(look);
  return flowOf(state)?.playing === true ? state : null;
}

/** Step the race until it is finished or the bot's time is up: the last state, and the racing it took. */
async function driveRace(look: Look): Promise<{ state: unknown; ms: number }> {
  const { ctx, h } = look;
  let ms = 0;
  let state: unknown = null;
  while (ms < CHALLENGE_MAX_MS) {
    await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Step, arg: CHALLENGE_STEP_MS, ...h });
    ms += CHALLENGE_STEP_MS;
    state = await ctx.call(HostMethod.PreviewState, stateParams(look));
    if (raceOf(state)?.finished === true) break;
  }
  return { state, ms };
}

/**
 * Whose count is this? The facade delegates `capture()` to the game, so a frame the page
 * labelled `game` — and the draw count beside it — is the build's claim about itself, not the
 * studio's read of the canvas. A verdict is only made on the studio's own reads.
 */
const claimedByGame = (shot: Shot): boolean => shot.stats?.provenance === "game";

/**
 * A frame that drew nothing is not evidence of blankness — it is evidence of no frame. It leaves
 * the blankness census and says so; but if EVERY frame drew nothing, dropping them all would
 * silently delete the verdict, so that is the verdict. Answers the frames the census counts.
 */
function weighDraws(look: Look): Shot[] {
  const { problems, shots, warnings } = look;
  const counted = shots.filter((shot: Shot) => shot.stats);
  look.counted = counted;
  const zeroDraw = counted.filter((shot: Shot) => shot.stats?.drawCalls === 0);
  look.zeroDraw = zeroDraw;
  look.claimed = claimedByGame;
  if (counted.length > 0 && zeroDraw.length === counted.length) {
    // An empty shared base draws nothing because there is nothing in it — the same exemption
    // the no-draw proof above waits for. Anywhere else it is the verdict.
    if (look.emptyScene) warnings.push("the game drew nothing for any camera");
    else if (zeroDraw.every(claimedByGame))
      warnings.push(
        "no camera frame reported a draw, and every frame is the game's own picture rather than the studio's read of the canvas — the count is the build's claim about itself, not a verdict",
      );
    else problems.push("the game drew nothing for any camera");
    return counted;
  }
  if (!zeroDraw.length) return counted;
  warnings.push(
    `${zeroDraw.length} camera frame(s) drew nothing (${zeroDraw.map((shot: Shot) => shot.camera).join(", ")}) — those frames are not evidence of blankness`,
  );
  return counted.filter((shot: Shot) => shot.stats?.drawCalls !== 0);
}

/**
 * The pictures themselves can lie to a vision judge (it politely describes a black JPEG), so the
 * pixel counts are the verdict on blankness — but only when every camera agrees: one dark angle
 * is composition, three is a build that renders nothing.
 */
function weighBlackness(look: Look, statBearing: Shot[]): void {
  const blackEverywhere =
    statBearing.length > 0 &&
    statBearing.every((shot: Shot) => shot.stats?.canvas && shot.stats.litFraction < BLACK_LIT_FRACTION);
  if (!look.emptyScene && blackEverywhere)
    look.problems.push("every camera renders effectively black (<0.5% pixels above luma 8)");
}

/** When every camera returned the same frame: an overlay, a dead camera contract, a stale picture, or one viewpoint. */
function sameFrameEverywhere(look: Look): void {
  const { canvasSourced, declaredViewpoints, problems, uiEntries, uiPrimary, warnings } = look;
  if (uiPrimary) {
    warnings.push(
      `a full-screen overlay covers the game (${uiEntries.slice(0, MAX_UI_ENTRIES).join(", ") || "the page"}) — every camera frame is the same picture behind it; judge user:view`,
    );
  } else if (declaredViewpoints.length > 1 && canvasSourced) {
    problems.push("every camera returned the same frame — debugCamera switches nothing, the cameras contract is dead");
  } else if (declaredViewpoints.length > 1) {
    warnings.push(
      "every camera returned the same frame, but the frames came off the compositor and not the canvas — the picture may be stale rather than the camera wiring dead",
    );
  } else {
    warnings.push("this build declares one viewpoint — identical frames are its design, not a dead debugCamera");
  }
}

/**
 * Different cameras returning byte-identical frames is one view wearing several labels — but
 * only when the game declares more than one viewpoint and the frames came off the canvas. A game
 * with one camera is photographed three times by the floor, and identical frames there are its
 * design; a full-screen overlay is a different sentence again.
 */
function weighDuplicates(look: Look): void {
  const { declaredViewpoints, shots, warnings } = look;
  const withPixels = shots.filter((shot: Shot) => shot.base64);
  look.withPixels = withPixels;
  look.canvasSourced = shots.every((shot: Shot) => shot.surface !== "page");
  const duplicate = shots.find((shot: Shot, index: number) =>
    shots.slice(0, index).some((other: Shot) => other.base64 && other.base64 === shot.base64),
  );
  look.duplicate = duplicate;
  if (look.emptyScene) return;
  const allSame = withPixels.length > 1 && withPixels.every((shot: Shot) => shot.base64 === withPixels[0].base64);
  if (allSame) sameFrameEverywhere(look);
  else if (duplicate && declaredViewpoints.length > 1)
    warnings.push(
      `the ${duplicate.camera} camera returned the same frame as another camera — each named camera must frame a distinct view; fix the camera wiring in main.js`,
    );
}

/** An empty shared base: its cameras must at least be placed apart, and nothing visual has been validated. */
function weighEmptyBase(look: Look): void {
  const { cameraPoses, problems, warnings } = look;
  if (!look.emptyScene) return;
  if (cameraPoses.size > 1 && new Set(cameraPoses.values()).size === 1)
    problems.push("every camera has the same transform — shared-base camera placement is not implemented");
  warnings.push(
    "Empty shared base: runtime and camera placement checked; no visual content or gameplay has been validated.",
  );
}

/** Frames that drew nothing, blank pixels on every camera, and one view wearing several labels. */
async function weighFrames(look: Look): Promise<LookEnd> {
  weighBlackness(look, weighDraws(look));
  weighDuplicates(look);
  weighEmptyBase(look);
}

/**
 * (8b) the run's kept routes (routes.ts), replayed on this build after every photograph is taken —
 * a replay reloads the page in the host's own computer session and moves it — and only on a leased
 * window, never the user's own view. A deterministic route that no longer reaches its goal is a
 * failed check naming the step; every divergence is a warning the judge and the next builder read.
 */
async function replayKeptRoutes(look: Look): Promise<LookEnd> {
  const { ctx, entry, handle, iterationId, labelPrefix, prefix, problems, root, run, warnings } = look;
  if (typeof routes.replayRoutes !== "function" || !handle || problems.length > 0) return;
  const iteration = typeof iterationId === "number" ? iterationId : undefined;
  try {
    const replayed = await routes.replayRoutes(ctx, {
      run,
      root,
      handle,
      labelPrefix: labelPrefix ?? prefix,
      ...(entry ? { entry } : {}),
      ...(iteration === undefined ? {} : { iteration }),
    });
    if (!replayed) return;
    look.routeReplays = replayed;
    warnings.push(...replayed.notes);
  } catch (err: any) {
    warnings.push(`the run's routes could not be replayed: ${err?.message ?? err}`);
  }
}

/**
 * (9) the window again, at the end of the pass. The OS kills a window at its memory peak (the
 * drive, the cameras, the demos), not at the load, and the status read there said nothing of it:
 * a kill mid-pass would have left every failure after it on the build.
 */
async function readLateStatus(look: Look): Promise<LookEnd> {
  const { ctx, h, problems } = look;
  const late = (await ctx.call(HostMethod.PreviewStatus, { ...h }).catch(() => null)) as AnyRecord | null;
  if (!isRecord(late)) return;
  look.machineKilled = look.machineKilled === true || killedByMachine(late);
  if (late.crashed && !problems.includes(RENDERER_CRASHED)) problems.push(RENDERER_CRASHED);
}

/** Is this console line the page's own, rather than the studio's note that the window went away? */
function loggedByPage(entry: { source?: unknown }): boolean {
  return entry.source !== PreviewConsoleSource.WindowGone;
}

/** The console against what the page inherited, and the GPU's own errors. */
async function readConsole(look: Look): Promise<LookEnd> {
  const { ctx, h, inheritedConsole, problems, warnings } = look;
  const consoleEntries = await ctx.call(HostMethod.PreviewConsole, { sinceMs: 0, ...h });
  look.consoleEntries = consoleEntries;
  const consoleErrors = consoleEntries.filter((entry) => entry.level === "error");
  look.consoleErrors = consoleErrors;
  // The studio's own line about a dead window is not an error the build logged: the crash itself
  // is read off the window's status, typed, and the kill is the machine's when it says so.
  const consoleVerdict = consoleProblems(consoleErrors.filter(loggedByPage), inheritedConsole);
  look.consoleVerdict = consoleVerdict;
  problems.push(...consoleVerdict.problems);
  warnings.push(...consoleVerdict.warnings);

  look.gpuErrors = [];
  try {
    const answered = await ctx.call(HostMethod.PreviewGpuErrors, { ...h });
    look.gpuErrors = Array.isArray(answered) ? answered : [];
  } catch {
    look.gpuErrors = [];
  }
}

/**
 * What the page-side capture said about the judged frame. Who took it, and by which rungs: a
 * `game` provenance means the numbers are the build's own report and not the studio's read of
 * the canvas.
 */
function judgedCanvas(judged: Shot | null): AnyRecord | null {
  const stats = judged?.stats;
  if (!stats) return null;
  return {
    source: stats.source ?? null,
    composited: stats.composited ?? null,
    drawCalls: Number.isFinite(stats.drawCalls) ? stats.drawCalls : null,
    reason: stats.captureReason ?? null,
    kind: stats.kind ?? null,
    provenance: stats.provenance ?? null,
    ladder: Array.isArray(stats.ladder) ? stats.ladder : null,
  };
}

/**
 * "The build does not run: " must never end in a colon: a pass that took no frame owes the
 * reader the sentence saying so, with both halves of the camera story in it.
 */
function sayNoFrame(look: Look): void {
  const { askedFor, problems, shots } = look;
  if (shots.length > 0 || problems.some((problem: unknown) => NO_FRAME.test(String(problem)))) return;
  problems.push(
    `no camera produced a frame (asked for: ${askedFor.join(", ") || "none"}; registered: ${(look.declaredCameras ?? []).join(", ") || "none"})`,
  );
}

/** What the drive measured beyond the frames, each only when it was measured at all. */
function drivenReadings(look: Look): AnyRecord {
  return {
    ...(look.drive ? { drive: look.drive } : {}),
    ...(look.corner ? { corner: look.corner } : {}),
    ...(look.challengeRace ? { challenge: look.challengeRace } : {}),
  };
}

/** The pass's answer, never a bare colon. */
async function reportLook(look: Look): Promise<LookEnd> {
  const { consoleErrors, demoShots, demoStates, demos, missingCameras, motionFrames, problems, shots } = look;
  const { skippedDemos, uiCoverage, uiEntries, uiPrimary, warnings } = look;
  sayNoFrame(look);
  const judged = shots.find((shot: Shot) => shot.camera === DEFAULT_CAMERA) ?? shots[0] ?? null;
  look.judged = judged;
  return {
    value: {
      requestedState: look.requestedState,
      ok: problems.length === 0 && shots.length > 0,
      emptyScene: look.emptyScene,
      problems,
      warnings,
      // Demo end-frames and the drive's corner join the evidence after the honesty guards — a demo
      // that legitimately ends on a frame matching a camera shot must not read as a dead debugCamera.
      shots: [
        ...shots,
        ...(look.cornerShot ? [look.cornerShot] : []),
        ...demoShots,
        ...(look.userViewShot ? [look.userViewShot] : []),
      ],
      demos: Object.keys(demos).length ? demos : null,
      // The state each demo left behind, for probes scoped to a demo.
      demoStates: Object.keys(demoStates).length ? demoStates : null,
      // What the game declares vs what the cap left out — so a check can tell "not registered"
      // (the builder's defect) from "not run" (nobody looked).
      registeredDemos: look.registeredDemos,
      registeredCameras: look.registeredCameras ?? null,
      skippedDemos,
      // How many unnamed demos the look ran at most — only when it left some out.
      ...(look.demoCap ? { demoCap: look.demoCap } : {}),
      state: look.state,
      stateEarly: look.stateEarly,
      // The last five, for a judge and a builder to read in a prompt...
      consoleErrors: consoleErrors.slice(-PROMPT_CONSOLE_ERRORS).map((entry: AnyRecord) => entry.message),
      // ...and every distinct message, for the next build's baseline. An error inherited from the
      // build this one forked from must be recognisable when the next pass looks: a baseline of
      // five forgives the wrong ones, and one unforgiven shader line once voided four iterations,
      // every judge of a run and its landing.
      consoleBaseline: [...new Set(consoleErrors.map((entry: AnyRecord) => String(entry.message)))].slice(
        0,
        MAX_CONSOLE_BASELINE,
      ),
      gpuErrors: look.gpuErrors.slice(0, MAX_GPU_ERRORS),
      // v2 evidence: the motion strip (feel), the audio probe, which eye cameras exist, and
      // which spec cameras the build failed to register.
      motion: motionFrames,
      audio: look.audioProbe,
      eyes: look.eyeNames,
      missingCameras,
      // M4 evidence: when the page came up, what the readiness poll answered, what the two
      // proving steps moved, which surface the judged frames came off, what the page paints
      // outside its canvas, and what the page-side capture said about the frame it gave back.
      readyAfterMs: look.readyAfterMs,
      ready: look.ready,
      clock: look.clockProof,
      surface: judged?.surface ?? "canvas",
      pageUi: look.pageUi ? { entries: uiEntries, coverage: uiCoverage, primary: uiPrimary } : null,
      canvas: judgedCanvas(judged),
      // Only when there is something to say, so a game with no front-end, on a window nobody
      // killed, reports exactly what it always did.
      ...(look.play ? { play: look.play } : {}),
      ...(look.machineKilled ? { machineKilled: true } : {}),
      // The drive's readings: whether the racing line steered it, the corner it photographed, and
      // the throttle-only bot's race (judge-facts.ts words each one; `throttle-bot-loses` reads the race).
      ...drivenReadings(look),
      // The run's kept routes replayed on this build: only when it keeps any.
      ...(look.routeReplays ? { routes: look.routeReplays } : {}),
    },
  };
}

// ── windows: the preview a look is taken through ─────────────────────────────────────────────

/**
 * Ask for a window, then ask again: a worker holds one for a look, not for a round. The pool has
 * no queue — `preview.acquire` throws the instant every window is leased — so a few asks a few
 * seconds apart usually find one. Null when there is none, or when this studio has no pool at all
 * (`pooled: false`: its only window is the live one, and there is nothing to wait for).
 */
export async function acquireWindow(
  ctx: HarnessCtx,
  label: string,
  { pooled = true, retriesMs = WINDOW_RETRIES_MS }: { pooled?: boolean; retriesMs?: readonly number[] } = {},
): Promise<string | null> {
  if (!pooled) return null;
  for (let attempt = 0; ; attempt++) {
    const lease = await ctx.call(HostMethod.PreviewAcquire, { label }).catch(() => null);
    if (lease?.handle) return lease.handle;
    if (attempt >= retriesMs.length || ctx.cancelled) return null;
    await sleep(retriesMs[attempt]);
  }
}

/**
 * A window to look through — or, for a pass that can wait, none.
 *
 * A judge or a playtest is the director's own choice and can be made a minute later: when every
 * pooled window is leased it is told so (`{ noWindow }`), the same answer `worker_start` gives. A
 * pass that cannot be skipped — the health of a merge just made, the contract, the starting
 * point, the close — passes `borrow: true` and looks through the window a call that names none
 * reaches: the studio's own stand-in, never the user's Live, which only they change. In a studio
 * with no pool at all (`pooled: false`) that window is the live view, as it always was.
 */
export async function withLease<T>(
  ctx: HarnessCtx,
  label: string,
  fn: (handle: string | null) => Promise<T>,
  {
    borrow = false,
    pooled = true,
    retriesMs = WINDOW_RETRIES_MS,
  }: {
    borrow?: boolean;
    pooled?: boolean;
    retriesMs?: readonly number[];
  } = {},
): Promise<T | { noWindow: string }> {
  const handle = await acquireWindow(ctx, label, { pooled, retriesMs });
  const noneFree = !handle && pooled;
  if (noneFree && !borrow) return noWindowFree(ctx);
  try {
    return await fn(handle);
  } finally {
    if (handle) await ctx.call(HostMethod.PreviewRelease, { handle }).catch(() => {});
  }
}

/** What a pass that can wait is told when every window is leased. */
async function noWindowFree(ctx: HarnessCtx): Promise<{ noWindow: string }> {
  const cap = await ctx.call(HostMethod.PreviewCapacity, {}).catch(() => null);
  const inUse = cap?.max ? ` (${cap.inUse}/${cap.max} in use)` : "";
  return {
    noWindow: `no window free${inUse} — every window is a worker's right now; wait for one to finish or stop one, then ask again`,
  };
}

/**
 * A look that is allowed to look again when the load raced the window (`loadRaced`), or when the
 * OS killed the window under memory pressure (`machineKilled`). `look` makes one pass; a pass that
 * throws is a failed pass, never a thrown run. `onRace` hears each race before the next look.
 * The answer carries how many looks it was allowed (`attempts`). A `viewport` sizes the leased
 * window (`handle`) once, before the first look; the live view is never sized.
 */
export async function patientEvidence(
  ctx: { readonly cancelled?: boolean; call?: HarnessCtx["call"] },
  look: () => Promise<Evidence>,
  {
    attempts = 3,
    delayMs = LOAD_RACE_RETRY_MS,
    onRace = null,
    handle = null,
    viewport = null,
  }: {
    attempts?: number;
    delayMs?: number;
    onRace?: ((evidence: Evidence) => void) | null;
    handle?: string | null;
    viewport?: { width: number; height: number } | null;
  } = {},
): Promise<Evidence | null> {
  if (handle && viewport && typeof ctx.call === "function")
    await ctx
      .call(HostMethod.PreviewViewport, { handle, width: viewport.width, height: viewport.height })
      .catch(() => null);
  let evidence: Evidence | null = null;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(delayMs);
    evidence = await look().catch(
      (err): Evidence => ({
        ok: false,
        problems: [String(err?.message ?? err)],
        warnings: [],
        shots: [],
        consoleErrors: [],
      }),
    );
    if (evidence.ok || ctx.cancelled) break;
    const killed =
      evidence.machineKilled === true &&
      classifyEvidenceFailure(evidence.problems, { machineKilled: true }) === EvidenceFailure.Observation;
    if (!loadRaced(evidence.problems) && !killed) break;
    if (!killed) onRace?.(evidence);
  }
  if (evidence) evidence.attempts = attempts;
  return evidence;
}
