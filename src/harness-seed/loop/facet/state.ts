/**
 * The facet loop's state: what `runFacetLoop` works out once from its options, what a yielded
 * round hands back and a resumed one reads again (`RESUMABLE_FIELDS`), and one round's own state.
 */
import { CRITIC_PRINCIPLES, referenceStats } from "../judge.ts";
import { criticFor } from "../kinds.ts";
import { loadContractLessons, loadRecipes } from "../library.ts";
import { roleEngine, RoleKey, supportsSessions } from "../model-roles.ts";
import { runRef } from "../repo.ts";
import { isCommit } from "../shell.ts";
import { GIT, gitAt, updateRef } from "../git.ts";
import { GIT_TIMEOUT_MS, PAGE_SEED } from "../config.ts";
import { CheckOrigin, normalizeFacetSpec } from "../spec.ts";
import { appendRun as appendRunEvent, EventKind, RunEvent } from "../run-events.ts";
import { HostMethod } from "../host-methods.ts";
import { MINUTE_MS, sleepUnlessCancelled } from "../time.ts";
import { FACET_POLICY, loopStateOf, WIND_DOWN_MS } from "./policy.ts";
import type { FacetPolicy } from "./policy.ts";
import { stopsThisRound } from "./rules.ts";
import { finishStoppedRound } from "./stop.ts";
import type { AnyRecord, HarnessCtx, Run } from "../../types/harness.d.ts";
import type { FacetSpec } from "../spec.ts";
import type { Recipe } from "../library.ts";
import type { Scoreboard } from "../checks.ts";
import type { SpikeOutcome } from "../spike.ts";
import type { ExecAnswer, Trim } from "../git.ts";
import type { CarriedFix } from "./carried-fixes.ts";

/**
 * How the facet loop is started (`optionDefaults` documents each option): the run and its
 * threads, the facet's spec, the worktree and window it builds and looks in, its clock, and the
 * hooks its orchestrator (the director or the classic pipeline) listens on.
 */
export type FacetLoopOptions = AnyRecord;

/** What a facet loop is for: one part of the game, or the merged game (which runs every demo and always gets its play session). */
export const FacetRole = {
  Facet: "facet",
  Integration: "integration",
} as const;
export type FacetRole = (typeof FacetRole)[keyof typeof FacetRole];

/** The studio contract module a game carries beside its entry (`installStudio`). */
export const STUDIO_CONTRACT = "src/studio.js";

/** A preview lock that locks nothing: a pooled port needs none. */
export const NO_LOCK = async () => () => {};

/** How many rounds a facet plays when its orchestrator names no number. */
const DEFAULT_MAX_ITERATIONS = 24;
/** The most of a defect ledger handed over at the start (the integration facet's brief). */
const MAX_INITIAL_DEFECTS = 24;
/** The share of the facet's own clock that "enough time left" and the wind-down scale with. */
const CLOCK_SHARE = 0.1;
/** The shortest wind-down, however short the facet's clock. */
const MIN_WIND_DOWN_MS = MINUTE_MS;

/** The options, with every default the loop runs on. */
export interface FacetOptions {
  runThreadId: string;
  facetThreadId: string;
  run: Run;
  seed: number;
  worktree: string | null;
  handle: string | null;
  previewLock: () => Promise<() => void>;
  deadline: number;
  maxIterations: number;
  minIterationMs: number | null;
  steering: () => unknown[] | Promise<unknown[]>;
  finishRequested: (iterationsThisRound: number) => Promise<unknown>;
  ownsMain: boolean;
  shape: AnyRecord | null;
  ownShape: boolean;
  role: string;
  integration: AnyRecord | null;
  projectDir: string | null;
  extraReadRoots: string[];
  onIteration: ((record: AnyRecord) => void) | null;
  initialDefects: unknown[];
  softCap: number | null;
  shouldYield: (() => boolean) | null;
  resumeState: AnyRecord | null;
  facets: AnyRecord[] | null;
  routeDefect: ((facetId: string, check: AnyRecord) => unknown) | null;
  baseShots: AnyRecord[];
  baseConsole: unknown[];
  policy: FacetPolicy;
  onLoopState: ((state: AnyRecord) => void) | null;
  buildBlock: boolean;
  onProviderLost: ((lost: AnyRecord) => void) | null;
}

/** What `runFacetLoop` works out once from its options: the facet, its places, its engine, its clock. */
export interface FacetEnvironment extends FacetOptions {
  ctx: HarnessCtx;
  options: FacetLoopOptions;
  spec: FacetSpec & AnyRecord;
  facet: FacetSpec & AnyRecord;
  /** A plan whose planner wrote no checks is judged by taste (the v1 rule). */
  legacy: boolean;
  workdir: string | null;
  budgets: AnyRecord;
  game: AnyRecord | null;
  critic: string;
  facetSetup: AnyRecord | null;
  result: AnyRecord;
  references: AnyRecord[];
  lessons: string[];
  gitWhere: string | { project: string };
  gitOptions: AnyRecord & { label: string; timeoutMs: number; trim: Trim };
  git: (command: string) => Promise<string>;
  workerRef: string | null;
  keepReachable: (commit: string) => Promise<void>;
  appendRun: (eventType: string, payload: AnyRecord) => Promise<unknown>;
  publishIteration: (raw: AnyRecord) => Promise<void>;
  described: AnyRecord[];
  engineId: string;
  delegated: boolean;
  reviewEnabled: boolean;
  modelReview: boolean;
  budgetMs: number;
  hasTime: (ms: number) => boolean;
  windDownMs: number;
  sleepFor: (ms: number) => Promise<void>;
}

/** A streak of one repeated reason: how many rounds in a row it has stood. */
export interface ReasonStreak {
  reason: string | null;
  count: number;
}

/** What a yielded round hands back to the scheduler, so round two continues instead of restarting. */
export interface ResumableState {
  incumbentEvidence: AnyRecord | null;
  board: Scoreboard;
  biggestGap: string;
  gapHistory: AnyRecord[];
  defectList: string[];
  judgePasses: Record<string, number>;
  loseStreak: number;
  lastFailure: string | null;
  sessionId: string | null;
  mergedIntegration: string | null;
  failureStreaks: Record<string, number>;
  spiked: Set<string>;
  spikeRoots: string[];
  /** WP1d: the same unjudgeable cause twice ends the facet instead of a third blind build. */
  brokenStreak: ReasonStreak;
  /** WP2b/e: how often a vision check wobbled without settling. */
  wobbles: Record<string, number>;
  /** M3.2: how often a judge answered a failing question with a hedge — twice and it retires. */
  stucks: Record<string, number>;
  /** WP5: the same failure reason on consecutive judged iterations, and replans per check. */
  reasonStreaks: Record<string, ReasonStreak>;
  replans: Record<string, number>;
  pendingDrops: Record<string, number>;
  replanRequests: AnyRecord[];
  /** WP1e: the builder's HARNESS: flags, deduplicated across iterations. */
  seenFlags: Set<string>;
  flags: AnyRecord[];
  /** The builder's lessons this facet already logged as `facet_lessons`, so none is logged twice. */
  seenLessons: Set<string>;
  /** WP4e: last iteration's per-camera distances and pair images, for the brief and the prompt. */
  lastStyle: AnyRecord | null;
  lastPairs: AnyRecord[];
  /**
   * The move (§5): the structural change each iteration must carry once identity holds — the
   * next unclimbed milestone, else what the planner names. Polish-only accepted builds are
   * counted so the brief can escalate.
   */
  moves: AnyRecord[];
  milestonesDone: Set<string>;
  /** The director's rungs set aside after missing `RUNG_MISSES` judged rounds, and the misses counted so far. */
  milestonesSetAside: Set<string>;
  rungMisses: Record<string, number>;
  polishStreak: number;
  /**
   * The liveness critic's last card: its grow gaps (and its biggest) are move candidates — the
   * open rung's, or the move with nobody owning the ladder — its polish gaps join the ledger.
   */
  lastLiveness: AnyRecord | null;
  /**
   * How many critic cards in a row each principle has stayed short of convincing with a fix inside
   * the ask (facet/growth.ts): at `STUCK_PRINCIPLE_CARDS` it is stuck, and actionable at a 2.
   */
  principleStreaks: Record<string, number>;
  /**
   * The taste judge's newest big move for the facet (`{ what, why }`): the next step once the
   * director's ladder is climbed, and what the director reads about this part.
   */
  lastBigMove: AnyRecord | null;
  /**
   * The proposals beyond what the user asked for (scope.ts `isBeyondScope`) this worker has already
   * put to the user as a decision card, by their `what`: each is asked once, never built.
   */
  surfacedBeyond: string[];
  /** The judge's polish notes on the accepted build: optional, never a round's whole work. */
  polishList: string[];
  /** The judge's biggest gap and how many judged builds in a row it has stood: { text, count, checkId, losses }. */
  gapStreak: AnyRecord | null;
  /**
   * What this worker's own rounds cost, measured in two halves: the build turn, and everything
   * the verdict needs after it (evidence, the judge, the commit). Both are needed — a gate that
   * reserves only the build moves the cut from the build turn to the judge.
   */
  emaBuildMs: number | null;
  emaAfterMs: number | null;
  /**
   * M4.10: every judge-grown check this worker has retired, oldest first — the director reads the
   * difference between two looks, so the list has to survive a yielded round.
   */
  retiredChecks: string[];
  /**
   * What undone rounds had fixed (facet/carried-fixes.ts): every next brief says to carry those
   * fixes over until the accepted build passes them.
   */
  carriedFixes: CarriedFix[];
}

/** The rest of the loop's changing state: what every start of the loop begins again. */
export interface RoundCounters {
  /** The rollback anchor. Worktree mode: the detached HEAD it was created at. */
  incumbentCommit: string | null;
  /** Live mode: a game-scope snapshot, the gauntlet's own idiom. */
  incumbentSnapshot: AnyRecord | null;
  engineFailures: number;
  observationOutages: number;
  integrationNote: string | null;
  lastSpike: SpikeOutcome | null;
  recipes: Recipe[];
  currentMove: AnyRecord | null;
  currentFix: AnyRecord | null;
  fixedForRecord: boolean | null;
  /** Provider weather (outage.ts): a 529 is waited out, never counted as a broken build. */
  outageRetries: number;
  iterationsThisRound: number;
  circuitBreak: string | null;
  startIteration: number;
}

/**
 * The facet's state across rounds: its constants (ctx, run, the spec, the worktree, the clocks)
 * beside what every round changes (the incumbent, the board, the streaks, the gap).
 */
export interface FacetLoopState extends FacetEnvironment, ResumableState, RoundCounters {
  /** What the next round is expected to cost: this worker's own rounds, else the run's median. */
  roundEstimate: () => { runMs?: number | null; buildMs?: number | null; afterMs?: number | null };
  /** What the loop is doing, handed to whoever is watching (M4.10). */
  emitLoopState: (phase: string, round: number) => void;
  /** Has a stop landed here? Records the round as stopped when one has. */
  stoppedHere: (iteration: number, aborted?: boolean) => Promise<boolean>;
}
/** The facet's state, as the phases name it. */
export type FacetLoop = FacetLoopState;

/** One round's own state: its number and what its phases hand on to each other. */
export type FacetRound = AnyRecord & { iteration: number };

/** How a resumable field is carried across a yield: passed as it is, or copied as a list, a record or a set. */
const Carry = { Value: "value", List: "list", Record: "record", Set: "set" } as const;
type Carry = (typeof Carry)[keyof typeof Carry];

/**
 * The carries a field of type `T` may take, so a wrong one fails to compile: a set rides only as
 * a set, a list as a list or as it is, an object as a copied record or as it is, anything else as
 * it is.
 */
type CarryFor<T> = [NonNullable<T>] extends [ReadonlySet<unknown>]
  ? typeof Carry.Set
  : [NonNullable<T>] extends [readonly unknown[]]
    ? typeof Carry.List | typeof Carry.Value
    : [NonNullable<T>] extends [object]
      ? typeof Carry.Record | typeof Carry.Value
      : typeof Carry.Value;

/**
 * Every field a yielded round hands back, and how it is carried. The whole in-memory state rides
 * back to the scheduler (never into the journal — the evidence carries frames), so round two
 * continues the session instead of restarting it. A set rides as a list.
 */
export const RESUMABLE_FIELDS = {
  incumbentEvidence: Carry.Value,
  board: Carry.Record,
  biggestGap: Carry.Value,
  gapHistory: Carry.List,
  defectList: Carry.Value,
  judgePasses: Carry.Record,
  loseStreak: Carry.Value,
  lastFailure: Carry.Value,
  sessionId: Carry.Value,
  mergedIntegration: Carry.Value,
  failureStreaks: Carry.Record,
  spiked: Carry.Set,
  spikeRoots: Carry.List,
  brokenStreak: Carry.Value,
  wobbles: Carry.Record,
  stucks: Carry.Record,
  reasonStreaks: Carry.Record,
  replans: Carry.Record,
  pendingDrops: Carry.Record,
  replanRequests: Carry.List,
  seenFlags: Carry.Set,
  flags: Carry.List,
  seenLessons: Carry.Set,
  lastStyle: Carry.Value,
  lastPairs: Carry.Value,
  moves: Carry.List,
  milestonesDone: Carry.Set,
  milestonesSetAside: Carry.Set,
  rungMisses: Carry.Record,
  polishStreak: Carry.Value,
  lastLiveness: Carry.Value,
  principleStreaks: Carry.Record,
  lastBigMove: Carry.Value,
  surfacedBeyond: Carry.List,
  polishList: Carry.Value,
  gapStreak: Carry.Value,
  emaBuildMs: Carry.Value,
  emaAfterMs: Carry.Value,
  retiredChecks: Carry.List,
  carriedFixes: Carry.List,
} as const satisfies { [Field in keyof ResumableState]: CarryFor<ResumableState[Field]> };

/** The result's own fields a yielded round carries back beside the loop's. */
const RESUMABLE_RESULT_FIELDS = ["iterations", "attempts", "spikes", "demos", "judged"] as const;

/** A resumable field as a new start reads it back: copied the way it is carried, or its fresh value. */
function restoreField(carry: Carry, saved: unknown, fresh: unknown): unknown {
  if (carry === Carry.Set) return new Set((saved as Iterable<unknown> | null | undefined) ?? []);
  if (carry === Carry.Value) return saved ?? fresh;
  if (!saved) return fresh;
  return carry === Carry.List ? [...(saved as unknown[])] : { ...(saved as AnyRecord) };
}

/** What each resumable field is on a facet's first round. */
function freshResumable(facet: AnyRecord, initialDefects: unknown): ResumableState {
  return {
    incumbentEvidence: null,
    board: {},
    biggestGap: facet.intent ?? facet.brief,
    gapHistory: [],
    defectList: Array.isArray(initialDefects) ? initialDefects.filter(Boolean).slice(0, MAX_INITIAL_DEFECTS) : [],
    judgePasses: {},
    loseStreak: 0,
    lastFailure: null,
    sessionId: null,
    mergedIntegration: null,
    failureStreaks: {},
    spiked: new Set(),
    spikeRoots: [],
    brokenStreak: { reason: null, count: 0 },
    wobbles: {},
    stucks: {},
    reasonStreaks: {},
    replans: {},
    pendingDrops: {},
    replanRequests: [],
    seenFlags: new Set(),
    flags: [],
    seenLessons: new Set(),
    lastStyle: null,
    lastPairs: [],
    moves: [],
    milestonesDone: new Set(),
    milestonesSetAside: new Set(),
    rungMisses: {},
    polishStreak: 0,
    lastLiveness: null,
    principleStreaks: {},
    lastBigMove: null,
    surfacedBeyond: [],
    polishList: [],
    gapStreak: null,
    emaBuildMs: null,
    emaAfterMs: null,
    retiredChecks: [],
    carriedFixes: [],
  };
}

/** The resumable state a start of the loop begins from: the yielded round's, else a fresh facet's. */
export function restoreResumable(resumeState: AnyRecord | null, fresh: ResumableState): ResumableState {
  const restored: AnyRecord = {};
  for (const [field, carry] of Object.entries(RESUMABLE_FIELDS)) {
    restored[field] = restoreField(carry, resumeState?.[field], fresh[field as keyof ResumableState]);
  }
  return restored as ResumableState;
}

/** What a yielded round hands back: the result's own counts and the loop's resumable fields (sets as lists). */
export function resumeSnapshot(loop: FacetLoopState): AnyRecord {
  const snapshot: AnyRecord = {};
  for (const field of RESUMABLE_RESULT_FIELDS) snapshot[field] = loop.result[field];
  for (const [field, carry] of Object.entries(RESUMABLE_FIELDS)) {
    const value = loop[field as keyof ResumableState];
    snapshot[field] = carry === Carry.Set ? [...(value as Set<unknown>)] : value;
  }
  // The anchor rides back too; a resumed worktree reads its own HEAD again.
  snapshot.incumbentCommit = loop.incumbentCommit;
  return snapshot;
}

/** Every option the loop reads besides the four it always gets, and what it is when left out. */
function optionDefaults(): Omit<FacetOptions, "runThreadId" | "facetThreadId" | "run" | "deadline"> {
  return {
    seed: PAGE_SEED,
    worktree: null,
    handle: null,
    previewLock: NO_LOCK,
    maxIterations: DEFAULT_MAX_ITERATIONS,
    /**
     * What one round on this game has cost the run so far (the director's median), for a worker
     * that has not finished a round of its own yet. Null means nothing has been measured, and a
     * worker is never refused its first round on a guess.
     */
    minIterationMs: null,
    steering: () => [],
    /** Has anyone asked this facet to stop? `true`, or `{ by: "director"|"user", reason }`. */
    finishRequested: async () => false,
    ownsMain: true,
    /** The project's shape (game-workspace ProjectShape) and whether it is the game's own, not the template's. */
    shape: null,
    ownShape: false,
    /** "facet" or "integration" — the integration facet always gets the playtester. */
    role: FacetRole.Facet,
    /** Continuous integration hooks (worktree mode): head() → commit to merge in; accepted(commit). */
    integration: null,
    /** Live-mode folder (needed to write `.studio/BRIEF.md` and to diff); worktree mode uses the worktree. */
    projectDir: null,
    /** Extra read roots for the builder (the base commit's worktree, spike worktrees); the option is `extraReads`. */
    extraReadRoots: [],
    /** Called with every iteration record (minus nothing) — the orchestrator's report keeps them. */
    onIteration: null,
    /** A defect ledger produced before this facet started (the integration facet's brief). */
    initialDefects: [],
    /** Fair-share scheduling (WP6): yield after this many iterations when `shouldYield()` says others wait. */
    softCap: null,
    shouldYield: null,
    /** In-memory state from a yielded round — the session continues instead of restarting. */
    resumeState: null,
    /** Every facet's spec, for routing a defect to the facet that owns it (WP2d). */
    facets: null,
    /** `routeDefect(facetId, check)` — delivery to another facet, owned by the orchestrator. */
    routeDefect: null,
    /** The base build's shots, for the first brief's images (WP3d). */
    baseShots: [],
    /** Console errors the base already logs: a challenger is not broken for an error it inherited. */
    baseConsole: [],
    /**
     * The eight thresholds this worker runs on (M4.10). Defaulted, so the frozen classic
     * pipeline passes nothing and is byte-identical; a director may set them per worker.
     */
    policy: FACET_POLICY,
    /** Called with a LoopState at three points of every round — the director's window in. */
    onLoopState: null,
    /**
     * Whether the worker's first round is a build block (facet/build-block.ts): one long build
     * kept on the checks. The director asks it for a new part; the classic pipeline never does.
     */
    buildBlock: false,
    /** Called when a round starts waiting for a lost provider (facet/provider.ts) — the director's wake. */
    onProviderLost: null,
  };
}

/** The options with every default filled in: an option left out (undefined) takes its default, as a destructuring default would. */
export function readOptions(options: FacetLoopOptions): FacetOptions {
  const read: AnyRecord = {
    runThreadId: options.runThreadId,
    facetThreadId: options.facetThreadId,
    run: options.run,
    deadline: options.deadline,
  };
  const given: AnyRecord = { ...options, extraReadRoots: options.extraReads };
  for (const [key, fallback] of Object.entries(optionDefaults())) {
    read[key] = given[key] === undefined ? fallback : given[key];
  }
  return read as FacetOptions;
}

/** A new round's record of the facet, carrying a yielded round's counts forward. */
function freshResult(facet: AnyRecord, options: FacetOptions): AnyRecord {
  const { facetThreadId, worktree, resumeState } = options;
  return {
    facetId: facet.id,
    threadId: facetThreadId,
    worktree,
    iterations: resumeState?.iterations ?? 0,
    satisfied: false,
    stoppedBecause: "",
    biggest_gap: facet.intent ?? facet.brief,
    lastCommit: null,
    done: false,
    yielded: false,
    board: {},
    spec: facet,
    attempts: resumeState?.attempts ? [...resumeState.attempts] : [],
    spikes: resumeState?.spikes ? [...resumeState.spikes] : [],
    sessionId: null,
    demos: resumeState?.demos ? [...resumeState.demos] : [],
    judged: resumeState?.judged ?? 0,
  };
}

/**
 * Which critic reviews this part: the one its director named (`critic=screen` for a UI or HUD
 * part), else its game kind's. A HUD worker in a soccer game was otherwise asked why its
 * scoreboard did not feel like a real place.
 */
export function partCritic(spec: AnyRecord, game: AnyRecord | null): string {
  const named = typeof spec.critic === "string" && Object.hasOwn(CRITIC_PRINCIPLES, spec.critic);
  return named ? spec.critic : criticFor(game);
}

/** The facet's spec and what the loop derives from it and the run: the critic, the setup, where it works. */
function facetOf(options: FacetOptions, raw: FacetLoopOptions) {
  const { run, worktree, projectDir } = options;
  const spec = Array.isArray(raw.facet?.checks) ? raw.facet : normalizeFacetSpec(raw.facet ?? {}, 0);
  // What kind of game this is, and therefore which critic can answer it: a place a player walks
  // through, or a screen that has to read. Stamped on the run at launch (M4.4).
  const game = run.game ?? null;
  return {
    spec,
    facet: spec,
    // A plan whose planner wrote no checks is judged by taste (v1 rule); harness-owned checks
    // alone do not make it a scoreboard facet.
    legacy: spec.checks.filter((c: AnyRecord) => c.origin !== CheckOrigin.Harness).length === 0,
    workdir: worktree ?? projectDir,
    budgets: run.budgets ?? {},
    game,
    critic: partCritic(spec, game),
    // The state this facet is about: its own setup when the director gave it one, else the run's.
    facetSetup: spec.setup === undefined ? (run.setup ?? null) : spec.setup,
    result: freshResult(spec, options),
    references: referenceStats(run),
  };
}

/** Where this facet's git runs (its worktree, else the live folder) and how: its label, its clock, its error sentence. */
function gitPlace(ctx: HarnessCtx, facet: AnyRecord, options: FacetOptions) {
  const { run, worktree } = options;
  const gitWhere = worktree ? worktree : { project: run.project };
  const gitOptions = {
    label: `facet:${facet.id}:git`,
    timeoutMs: GIT_TIMEOUT_MS.quick,
    trim: "both" as Trim,
    failure: (exec: ExecAnswer & AnyRecord, command?: string) =>
      `git failed in facet ${facet.id}: ${command} — code=${exec.code}, signal=${exec.signal ?? "none"}, timedOut=${exec.timedOut ?? "unknown"}, durationMs=${exec.durationMs ?? "unknown"}; ${exec.stderr || exec.stdout || "no process output"}`,
  };
  /**
   * A worker's work, kept reachable. Its worktree is detached, so a commit that is never
   * integrated is unreferenced the moment the worktree is removed, and a report could name
   * accepted iterations "preserved as commit …" that nothing can find. One ref per worker, moved forward each
   * time: every earlier accepted build is an ancestor of the last one. Best-effort — a ref
   * that will not write must never cost the round.
   */
  const workerRef = worktree ? runRef(run.runId, "workers", facet.id) : null;
  return {
    gitWhere,
    gitOptions,
    /** One git command line (built by git.ts `GIT`) in this facet's place, with its options. */
    git: (command: string) => gitAt(ctx, gitWhere, command, gitOptions),
    workerRef,
    keepReachable: async (commit: string) => {
      if (!workerRef || !isCommit(commit)) return;
      await updateRef(ctx, gitWhere, workerRef, commit, gitOptions).catch(() => {});
    },
  };
}

/** How the facet's rounds reach the record: one custom event, and one round's record. */
function recorders(ctx: HarnessCtx, critic: string, options: FacetOptions) {
  const { runThreadId, onIteration } = options;
  return {
    appendRun: (eventType: string, payload: AnyRecord) => appendRunEvent(ctx, runThreadId, eventType, payload),
    /** One round on the record: the log is the record, the notify and the report are courtesies. */
    publishIteration: async (raw: AnyRecord) => {
      // Which critic judged this round rides on every record: a screen's score is not comparable
      // with a place's, and the feed has to say which question was asked.
      const record = { ...raw, critic };
      await ctx.call(HostMethod.EventsAppend, {
        threadId: runThreadId,
        batch: [{ type: EventKind.Custom, event_type: RunEvent.FacetIteration, payload: record }],
      });
      ctx.notify("autopilot.facet", record);
      if (typeof onIteration !== "function") return;
      try {
        onIteration(record);
      } catch {
        /* the report is a courtesy; the event log is the record */
      }
    },
  };
}

/** The rollback anchor. Worktree mode: the detached HEAD it was created at. Live mode: a game-scope snapshot, the gauntlet's own idiom. */
async function incumbentAnchor(
  ctx: HarnessCtx,
  env: { worktree: string | null; run: AnyRecord; facet: AnyRecord; git: (command: string) => Promise<string> },
) {
  const { worktree, run, facet, git } = env;
  if (worktree) return { incumbentCommit: await git(GIT.head), incumbentSnapshot: null };
  const incumbentSnapshot = await ctx.call(HostMethod.SnapshotCreate, {
    scope: "game",
    reason: `run ${run.runId} facet ${facet.id}: starting point`,
    project: run.project,
    healthy: false,
  });
  return { incumbentCommit: null, incumbentSnapshot };
}

/** The workers' engine and what it can do: a worker builds on it, and the whole loop speaks to it and no other. */
async function builderEngine(ctx: HarnessCtx, run: AnyRecord, budgets: AnyRecord) {
  const described = await ctx.call(HostMethod.EngineDescribe, {});
  // A worker builds on the workers' engine, which a cross-provider run puts on the other
  // subscription; the whole loop below speaks to that engine and no other.
  const engineId = roleEngine(run, RoleKey.Builder);
  const delegated = supportsSessions(described.find((e) => e.id === engineId));
  const reviewEnabled = budgets.review !== false;
  return {
    described,
    engineId,
    delegated,
    reviewEnabled,
    modelReview: reviewEnabled && delegated && budgets.modelReview !== false,
  };
}

/** The facet's clock: how long it had, whether a step still fits, and what a build turn holds back. */
function clock(ctx: HarnessCtx, deadline: number) {
  // "Enough time left" scales with the facet's own clock: ten minutes on a run, a slice of a
  // short run — a fixed floor silently disabled spikes and follow-ups on anything under an hour.
  const budgetMs = Math.max(1, deadline - Date.now());
  return {
    budgetMs,
    hasTime: (ms: number) => deadline - Date.now() > Math.min(ms, budgetMs * CLOCK_SHARE),
    // What a build turn holds back so the clock can be met with "finish cleanly" instead of a cut.
    // A slice of this facet's own clock, the same idiom: three fixed minutes is most of a short
    // worker's whole budget.
    windDownMs: Math.min(WIND_DOWN_MS, Math.max(MIN_WIND_DOWN_MS, Math.round(budgetMs * CLOCK_SHARE))),
    sleepFor: (ms: number) => sleepUnlessCancelled(ctx, ms),
  };
}

/**
 * What the loop is doing, handed to whoever is watching (M4.10). Wrapped: watching the loop
 * must never cost the round, so a listener that throws is a listener that saw nothing.
 */
function emitLoopState(loop: FacetLoopState, phase: string, round: number): void {
  try {
    const state = loopStateOf({
      phase,
      round,
      polishStreak: loop.polishStreak,
      loseStreak: loop.loseStreak,
      brokenStreak: loop.brokenStreak,
      fix: loop.currentFix,
      spec: loop.spec,
      retiredChecks: loop.retiredChecks,
      policy: loop.policy,
      emaBuildMs: loop.emaBuildMs,
      emaAfterMs: loop.emaAfterMs,
      minIterationMs: loop.minIterationMs,
    });
    loop.result.loopState = state;
    if (typeof loop.onLoopState === "function") loop.onLoopState(state);
  } catch {
    /* the watcher is a courtesy; the round is the work */
  }
}

/** Everything the rounds share: the facet's constants beside the counters and boards the rounds change. */
export async function createFacetLoopState(ctx: HarnessCtx, raw: FacetLoopOptions): Promise<FacetLoopState> {
  const options = readOptions(raw);
  const facetParts = facetOf(options, raw);
  const lessons = await loadContractLessons(ctx.workspace).catch(() => []);
  const gitParts = gitPlace(ctx, facetParts.facet, options);
  const anchor = await incumbentAnchor(ctx, { ...options, ...facetParts, ...gitParts });
  const engine = await builderEngine(ctx, options.run, facetParts.budgets);
  const resumed = restoreResumable(options.resumeState, freshResumable(facetParts.facet, options.initialDefects));
  const recipes = await loadRecipes(ctx.workspace).catch(() => []);
  /**
   * Has a stop landed here? The build turn is not the only place one can arrive: `engine.abort`
   * reaches only a live delegation, and a worker spends most of its round in review, evidence,
   * scoring and the judge with none. A round that ran on to its verdict was judged, lost, and
   * rolled back — and the `…-stopped` ref worker_stop names never existed.
   */
  const stoppedHere = async (iteration: number, aborted = false) => {
    const stop = stopsThisRound(await loop.finishRequested(loop.iterationsThisRound).catch(() => false), { aborted });
    return stop ? finishStoppedRound(loop, iteration, stop) : false;
  };
  const loop: FacetLoopState = {
    ctx,
    options: raw,
    ...options,
    ...facetParts,
    lessons,
    ...gitParts,
    ...recorders(ctx, facetParts.critic, options),
    ...anchor,
    ...engine,
    ...clock(ctx, options.deadline),
    ...resumed,
    engineFailures: 0,
    observationOutages: 0,
    integrationNote: null,
    lastSpike: null,
    recipes,
    currentMove: null,
    currentFix: null,
    fixedForRecord: null,
    outageRetries: 0,
    iterationsThisRound: 0,
    circuitBreak: null,
    startIteration: (options.resumeState?.iterations ?? 0) + 1,
    roundEstimate: () =>
      loop.emaBuildMs === null
        ? { runMs: loop.minIterationMs }
        : { buildMs: loop.emaBuildMs, afterMs: loop.emaAfterMs },
    emitLoopState: (phase, round) => emitLoopState(loop, phase, round),
    stoppedHere,
  };
  return loop;
}
