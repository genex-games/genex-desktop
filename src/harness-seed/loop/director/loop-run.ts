import type { GoalLedger } from "./goals.ts";
/**
 * The director's run as one explicit object, and the functions of it every part shares (the
 * plain helpers, which need no run, are in rules.ts).
 *
 * `runDirector` used to be a single 2,300-line function whose sixty closures shared its locals
 * by capture. The run is now a plain object (`prepareLoopRun` in setup.ts builds it): the run,
 * its clock, the integration worktree, `state` (the workers, the heads, the log), the journal
 * and the report — and every function of the run takes it as its first argument. `bindLoopRun`
 * puts each of them on the object as well, so a function can reach the others it calls through
 * the same object it reads its data from.
 *
 * The counters that change for the whole run (`logSeq`, `waitSeq`, `ledgerWrites`, `memoryKept`,
 * `toolCalls`) live on the object and are read and written there, never copied out.
 */

import { GIT_TIMEOUT_MS, PAGE_SEED } from "../config.ts";
import { gatherEvidence, patientEvidence as lookPatiently, withLease as leaseWindow } from "../evidence.ts";
import { headOf, shortSha, updateRef } from "../git.ts";
import { HostMethod } from "../host-methods.ts";
import { appendLedger, rarelyMeasurable } from "../ledger.ts";
import { isRunning } from "../outcomes.ts";
import {
  appendRun as appendRunEvent,
  RunEvent,
  RunMode,
  saveJournal as saveRunJournal,
  writeRunArtifact,
} from "../run-events.ts";
import type { FactRef } from "../folder-facts.ts";
import { isCommit } from "../shell.ts";
import { isTruncatedState, statePathsNamedByChecks } from "../state-shape.ts";
import { verdictRecord } from "../verdict.ts";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { slug, withoutFrames } from "./args.ts";
import { medianMinutes } from "./budgets.ts";
import { journalText, recordLoopRun } from "./journal.ts";
import { directorMemoryKeep } from "./memory.ts";
import { plainly } from "./rules.ts";
import type { AnyRecord, HarnessCtx, Run } from "../../types/harness.d.ts";
import type { HarnessResult, ProjectShape } from "../../types/host-api.d.ts";
import type { Evidence, GatherOptions, Shot } from "../evidence.ts";
import type { LedgerRecord } from "../ledger.ts";
import type { EngineLimit } from "../outage.ts";
import type { WorkerMode, WorkerState } from "../outcomes.ts";
import type { RunInbox } from "../run-inbox.ts";
import type { FacetSpec } from "../spec.ts";
import type { RoundRecord } from "./digests.ts";
import type { LoopRunClock, PriorWorker } from "./journal.ts";
import type { ConflictMerge } from "./conflict-worker.ts";
import type { LoopRunContract } from "./contract-gate.ts";
import type { LeadSeat } from "./lead-session.ts";
import type { ShelvedDefect } from "./rules.ts";
import type { NoteKind } from "./wake-schedule.ts";
import type * as artDirectionFunctions from "./art-direction.ts";
import type { LastShip } from "./art-direction.ts";
import type * as integrateFunctions from "./integrate.ts";
import type * as loopRunFunctions from "./loop-run.ts";
import type * as setupFunctions from "./setup.ts";
import type * as toolFunctions from "./tools.ts";
import type * as workerFunctions from "./workers.ts";

/**
 * This part serves a lead that is its chat's own session and writes nothing (one session): a run
 * seats one only when every part it depends on says so (lead-session.ts `servesLead`).
 */
export const SERVES_LEAD = true;

/**
 * One builder of the run: startWorker (workers.ts) makes the record (`newWorkerRecord`), opens
 * its worktree and its thread, and only then puts it on `state.workers`; its run fills the rest
 * in, and the journal keeps it.
 */
export interface Worker {
  id: string;
  /** Stable request outcome advanced by this worker. */
  goal?: string;
  title: string;
  mode: WorkerMode;
  brief: string;
  owns: string[];
  ownsMain: boolean;
  cameras: string[];
  identity: string[];
  setup: AnyRecord | null;
  /** The commit it forked from. */
  from: string | null;
  replaces: string | null;
  baseConsole: string[];
  worktree: string;
  handle: string | null;
  threadId: string;
  startedAt: number;
  endedAt: number | null;
  deadline: number;
  state: WorkerState;
  stopRequested: boolean;
  stopWhy: string | null;
  iterationsCap: number | undefined;
  steering: string[];
  iterations: RoundRecord[];
  roundMs: number[];
  lastIterationAt: number | null;
  monitor: AnyRecord | null;
  result: AnyRecord | null;
  lastCommit: string | null;
  /** The commit its last accepted round left, while it builds (`keepRound`): what the journal names. */
  lastAccepted?: string | null;
  summary: string;
  error: string | null;
  spec: FacetSpec | null;
  problems: string[];
  unsatisfiable: AnyRecord[];
  stateKeys: string[] | null;
  notVerified: string | null;
  rarelyMeasurable: AnyRecord[];
  policy: AnyRecord;
  policyOverrides: AnyRecord;
  loop: AnyRecord | null;
  settled: boolean;
  settle: Promise<unknown>;
  resolveSettle: () => void;
  /** Its run, once launched (`launchWorker`). */
  promise?: Promise<unknown>;
  /** The engine limit that ended its session, when one did (`noteWorkerLimit`). */
  limit?: AnyRecord;
  /** A conflict worker's merge (conflict-worker.ts): opened in its worktree before its session. */
  merging?: ConflictMerge | null;
  /**
   * Its kept work has been merged into the integration branch at least once (integrate.ts): the
   * art director's first regular look waits for every building worker's (art-direction.ts).
   */
  integrated?: boolean;
}

/** The game's shape (`gameAtStart`, setup.ts): the host's, or the template's page and entry when it names none. */
export type LoopRunShape = Pick<ProjectShape, "entry" | "main" | "build"> & Partial<ProjectShape>;

/** A worker being started: its worktree and its thread are not open yet (`startWorker`). */
export type StartingWorker = Omit<Worker, "worktree" | "threadId"> & {
  worktree: string | null;
  threadId: string | null;
};

/** The last judge on the integration branch (see `loopRunState`). */
export interface LastJudge extends AnyRecord {
  head?: string | null;
  ok?: boolean;
  pick?: string | null;
  /** The vision judge's yes or no to the question asked, when one was. */
  answer?: boolean | null;
  boardAllPass?: boolean;
  /** The close's own judge of the build it made live (integrate.ts `judgeTheLanding`), not a lead's. */
  final?: boolean;
}

/** The workers' engine's limit, when the workers run on the other subscription (`noteWorkerLimit`). */
export interface WorkerLimit extends EngineLimit {
  engine: string;
  worker: string;
}

/** One line of the run's log (`note`). */
export interface LoopRunLogEntry {
  at: number;
  seq: number;
  text: string;
  /** What it is about, when it was written outside the lead's own turn (wake-schedule.ts decides what wakes it). */
  kind?: NoteKind;
}

/** What a commit reported when last looked at (`rememberEvidence`): a worker's checks are dry-run against it. */
export interface HeadEvidence {
  state: AnyRecord;
  demoStates: AnyRecord | null;
  demos: string[] | null;
  /** The cameras photographed (the harness's `default` always among them), not what the page registers. */
  cameras: string[];
  /** The cameras the page itself registered, when the look could tell (`Evidence.registeredCameras`). */
  registeredCameras?: string[] | null;
  /**
   * The setup the look was taken under (registry.ts `setupKey`), when the caller said: only a look
   * under the same setup can tell which state paths a merge lost (integrate.ts).
   */
  setup?: string;
}

/** The run's `state` (`loopRunState`, setup.ts): the workers, the heads, the log — everything that changes for the whole run. */
export interface LoopRunState {
  goals?: GoalLedger;
  run: Run;
  threadId: string;
  projectDir: string;
  shape: LoopRunShape;
  ownShape: boolean;
  baseCommit: string | null;
  integrationWorktree: string;
  integrationHead: string | null;
  /**
   * The head the last wave closed on (integrate.ts): what running loop workers merge, so they take
   * the integration branch once per wave and not after every commit. Absent until a wave closes.
   */
  waveHead?: string | null;
  /** The module contract loop workers are held to (contract-gate.ts), once committed. */
  contract?: LoopRunContract | null;
  /** Why the last contract could not be committed, until one is. */
  contractError?: string | null;
  /** How many loop workers were refused for want of a contract or a vision (contract-gate.ts `contractBeforeFork`). */
  contractRefusals?: number;
  /** The lead gave no vision through its refusals: loop workers start without one (contract-gate.ts). */
  visionWaived?: boolean;
  /**
   * A run resumed from a journal written before the contract gate (journal.ts `restoreLoopRun`): its
   * loop workers start as they always did until its lead commits a contract.
   */
  contractLegacy?: boolean;
  integrationHealthy: boolean | null;
  healthByHead: Map<string | null | undefined, boolean>;
  consoleByHead: Map<string | null | undefined, string[]>;
  evidenceByHead: Map<string | null | undefined, HeadEvidence>;
  baseHeads: Set<string | null | undefined>;
  fromScratch: boolean;
  startConsole: string[];
  lastJudge: LastJudge | null;
  /** The provider loss that pauses the run — an engine limit, a lost sign-in, an outage the lead could not wait out. */
  limit: EngineLimit | null;
  workerLimit: WorkerLimit | null;
  workers: Map<string, Worker>;
  plan: AnyRecord | null;
  planReviewUntil: number | null;
  planSaidFrom: number;
  planGo: boolean;
  facetSpecs: FacetSpec[];
  ledger: ShelvedDefect[];
  monitor: Promise<unknown> | null;
  log: LoopRunLogEntry[];
  finish: AnyRecord | null;
  finished: boolean;
  startEvidence: Evidence | null;
  judges: number;
  plays: number;
  softDeadline: number;
  finalDeadline: number;
  /**
   * The end number of the run's last job end the lead has had (`jobs.list`, loop/jobs/watch.ts):
   * the journal keeps it, so a restart reads on from there. Absent: none read yet.
   */
  jobsCursor?: number;
  /** The art director's last word on the integration branch (art-direction.ts); absent until it looks. */
  lastShip?: LastShip | null;
  /** A goal build's finish was turned back once for the art director's defects: never again. */
  shipFinishRefused?: boolean;
}

/**
 * What the run knows (`prepareLoopRun`, setup.ts): the run and its clock, the game's shape and
 * ledger, the starting point and the integration worktree, `state`, the journal and the report,
 * and the counters that change for the whole run.
 */
export interface LoopRunData {
  ctx: HarnessCtx;
  threadId: string;
  run: Run;
  resume: boolean;
  inbox: RunInbox;
  started: number;
  softDeadline: number;
  finalDeadline: number;
  /**
   * The run's own clock (journal.ts `loopRunClock`), which the journal keeps and a Resume goes on
   * with. A wrap-up that starts early moves `softDeadline`, never this. Absent on a run a kept
   * older setup.ts made.
   */
  clock?: LoopRunClock;
  priorJournal: AnyRecord | null;
  /** The workers the journal named when this run resumed: from before the pause, none of them running (journal.ts). */
  priorWorkers?: PriorWorker[];
  memoryRestored: boolean;
  ownShape: boolean;
  shape: LoopRunShape;
  /** What the game's folder holds once it is ready (`game.list`'s `facts`); absent on a run a kept older setup.ts made. */
  gameFacts?: FactRef[];
  capacity: HarnessResult<"preview.capacity"> | null;
  contractMissing: boolean;
  gameKind: string;
  priorLedger: LedgerRecord[];
  gameLessons: string[];
  report: AnyRecord;
  projectDir: string;
  baseCommit: string | null;
  forkCommit: string | null;
  integrationWorktree: string;
  integrationRef: string;
  memoryFile: string;
  /** The last memory this session kept (`keepMemory`), so an unchanged file is not kept again. */
  memoryKept: string | null;
  nestedRepos: string[];
  state: LoopRunState;
  journal: AnyRecord;
  startEvidence: Evidence | null;
  pooledWindows: boolean;
  logSeq: number;
  waitSeq: number;
  runLedger: LedgerRecord[];
  ledgerWrites: Promise<unknown>;
  toolCalls: number;
  /**
   * The director's tool calls under way (tools.ts `handler`): a turn inside one is never cut short
   * for the chat (wake.ts), or the lead would never get the call's answer. Absent under a kept
   * tools.ts from before live chat.
   */
  toolsInFlight?: number;
  /**
   * The wake loop drives the lead's session (wake.ts sets it as it starts): the parts it calls
   * tell it to end its turn. Absent — the long turn, or a kept director.ts from before the wake
   * loop, whose run names no loop — they answer with the long turn's words.
   */
  waking?: boolean;
  /**
   * The lead rests between turns (wake.ts sets it): a round that lands then reaches the journal
   * with the wake it causes — or with the news the loop saves when that wake is held — not with a
   * save of its own (workers.ts `keepRound`).
   */
  resting?: boolean;
  /**
   * A waking run's lead (one session, lead-session.ts): its chat's own session, in the game
   * folder, writing nothing while the build runs — workers do, a conflict goes to a worker of its
   * own (conflict-worker.ts), and no `.studio/DIRECTOR.md` is kept. Absent — the long turn, a kept
   * older director.ts — the director works in the integration worktree with its own hands.
   */
  lead?: LeadSeat | null;
  /** The log's sequence number the journal's last save holds (`saveJournal`): news up to it is on the journal. */
  journaledSeq?: number;
  /** The journal as its last save wrote it (journal.ts `journalText`): a save that would write the same again is not made. */
  journalSaved?: string | null;
}

/** A function of the run as the run carries it: bound, so the run itself is already given. */
type Bound<F> = F extends (loopRun: never, ...args: infer A) => infer R ? (...args: A) => R : never;
/** The names of a module's functions, as `bindLoopRun` binds them (a constant such as `SERVES_LEAD` is not one). */
type FunctionKey<M> = { [K in keyof M]: M[K] extends (...args: never[]) => unknown ? K : never }[keyof M];
/** Every function of one of the director's modules, bound to the run (`bindLoopRun`). */
type BoundModule<M> = { readonly [K in Exclude<FunctionKey<M>, "bindLoopRun" | "prepareLoopRun">]: Bound<M[K]> };
/**
 * The art director's functions of the run (art-direction.ts): absent on a run bound without it
 * (a kept older director.ts), so a caller checks that one is there before it calls it.
 */
type ArtDirectionParts = Partial<
  BoundModule<
    Pick<
      typeof artDirectionFunctions,
      | "artDirectionPass"
      | "finishMarkAt"
      | "firstWaveIn"
      | "shipLookAfter"
      | "shipLookAt"
      | "shipLookPass"
      | "shipOwed"
      | "shipFinishGate"
      | "shipReport"
      | "shipReviewOn"
      | "takeShelvedShipDefects"
    >
  >
>;

/**
 * The run: its data, and every function of the director's modules bound to it by bindLoopRun,
 * so a function reaches the others it calls through the same object it reads its data from.
 */
export interface LoopRun
  extends LoopRunData,
    BoundModule<typeof loopRunFunctions>,
    BoundModule<typeof workerFunctions>,
    BoundModule<typeof toolFunctions>,
    BoundModule<typeof integrateFunctions>,
    BoundModule<typeof setupFunctions>,
    ArtDirectionParts {
  /**
   * Generic, so written out (`Bound` would fix its `T` to unknown). A pass that may borrow a
   * window always gets one, so only a pass that may not can be told there is none.
   */
  withLease<T>(label: WindowLease, fn: (handle: string | null) => Promise<T>, options: { borrow: true }): Promise<T>;
  withLease<T>(
    label: WindowLease,
    fn: (handle: string | null) => Promise<T>,
    options?: { borrow?: boolean },
  ): Promise<T | { noWindow: string }>;
}

/**
 * The window leases the lead's own passes take (evidence.ts `withLease`): the label a pool
 * window is acquired under. Never rename a value.
 */
export const WindowLease = {
  Base: "director-base",
  Contract: "director-contract",
  Health: "director-health",
  Close: "director-close",
  Judge: "director-judge",
  Playtest: "director-playtest",
} as const;
export type WindowLease = (typeof WindowLease)[keyof typeof WindowLease];

/**
 * The builds a director names by word rather than by worker id: the integration branch (its own
 * worktree) and the live folder the user sees. Worker ids may not take these names.
 */
export const BuildTarget = {
  Integration: "integration",
  Live: "live",
} as const;
export type BuildTarget = (typeof BuildTarget)[keyof typeof BuildTarget];

/** The part functions that make a run rather than act on one: never bound to it. */
const UNBOUND_FUNCTIONS = new Set(["bindLoopRun", "prepareLoopRun"]);

/** The run's log keeps this many lines; the waker and `wait` read them by sequence number, not by index. */
const MAX_LOOP_RUN_LOG = 400;
/** The report keeps this many verdicts, the most recent. */
const MAX_REPORT_VERDICTS = 200;
/** How many times a pass looks at a build whose load raced the window (`patientEvidence`). */
const PATIENT_LOOKS = 3;

/** One custom event on the run's thread, stamped with the run (run-events.ts: a failed write is logged, never thrown). */
export function appendRun(loopRun: LoopRun, event_type: RunEvent, payload: AnyRecord): Promise<unknown> {
  const { ctx, run, threadId } = loopRun;
  return appendRunEvent(ctx, threadId, event_type, payload, { runId: run.runId });
}

/**
 * A decision card. `text` (and `decision`, its older name) is the record — shas, worker ids,
 * the engine's own words. `plain` is the one sentence the chat shows someone who is not
 * reading git; every card the director writes carries one, so the owner never reads
 * `run_fixture123456`, `attempt/shine/3-stopped` or a rate-limit error.
 */
export function decision(loopRun: LoopRun, text: string, plain?: string | null): Promise<unknown> {
  const { appendRun } = loopRun;
  return appendRun(RunEvent.AutopilotDecision, {
    decision: text,
    text,
    plain: plainly(plain ?? text),
    at: new Date().toISOString(),
  });
}

export async function protectHead(loopRun: LoopRun, head: string | null | undefined): Promise<void> {
  const { ctx, integrationRef, run } = loopRun;
  if (!isCommit(head)) return;
  await updateRef(ctx, { project: run.project }, integrationRef, head, {
    label: `director:${run.runId}:protect`,
  }).catch(() => {});
}

export async function keepMemory(loopRun: LoopRun) {
  const { ctx, lead, memoryFile, note, run, threadId } = loopRun;
  // A lead that is its chat's own session keeps no memory file: the journal and its digests carry the run.
  if (lead) return;
  const raw = await readFile(memoryFile, "utf8").catch(() => null);
  if (raw === null) return;
  // Clamped on the way out, so the artifact the next session restores from is already the
  // size a session can afford; the pre-clamp size is logged so the number can be set from
  // what runs actually write rather than from a guess — once per change, never once per
  // tool call (see directorMemoryKeep).
  const kept = directorMemoryKeep(raw, loopRun.memoryKept);
  if (!kept.changed) return;
  if (kept.note) note(kept.note);
  const text = kept.text;
  loopRun.memoryKept = text;
  await ctx
    .call(HostMethod.ArtifactWrite, {
      threadId,
      artifactId: `director_memory_${run.runId}`,
      value: { text, at: new Date().toISOString() },
    })
    .catch(() => {});
  await writeRunArtifact(ctx, run.runId, "director/DIRECTOR.md", text);
}

/**
 * Save the run's journal, with the run's record on it (journal.ts `recordLoopRun`): what a Resume
 * goes on from. The store keeps every version it is given and a fork copies them all, so a save
 * that would write what the last one wrote (the count of worked time aside) is not made.
 */
export async function saveJournal(loopRun: LoopRun): Promise<number | void> {
  const { ctx, journal, run, threadId } = loopRun;
  recordLoopRun(loopRun);
  const seq = loopRun.logSeq;
  const text = journalText(journal);
  // Saves overlap (a round's, a wake's): the log a slower one holds is never taken for a newer one's.
  const heldUpTo = () => {
    loopRun.journaledSeq = Math.max(loopRun.journaledSeq ?? 0, seq);
  };
  if (text !== null && text === loopRun.journalSaved) {
    heldUpTo();
    return;
  }
  loopRun.journalSaved = text;
  const version = await saveRunJournal(ctx, threadId, run.runId, journal);
  if (version !== undefined) heldUpTo();
  // A write that failed is owed again by the next save, however little changed.
  else if (loopRun.journalSaved === text) loopRun.journalSaved = null;
  return version;
}

/**
 * What a commit reported, kept for the next worker's dry run. Every pass the harness makes
 * (the fork gate, a health pass, a judge) already gathers it; nothing extra is captured, and
 * a commit nobody has looked at simply has no entry.
 */
export function rememberEvidence(
  loopRun: LoopRun,
  commit: string | null | undefined,
  evidence: Evidence | null | undefined,
  { setup }: { setup?: string } = {},
): void {
  const { state } = loopRun;
  if (!commit || evidence?.ok !== true) return;
  if (!evidence.state || evidence.state.__missing) return;
  // A state an older studio could only cut as text says nothing about what the build reports:
  // a dry run against it would call every path unsatisfiable.
  if (isTruncatedState(evidence.state)) return;
  state.evidenceByHead.set(commit, {
    // What the page registered, and the setup the look was taken under: what a merge's health
    // pass compares with (integrate.ts), only when there is one.
    ...(Array.isArray(evidence.registeredCameras) ? { registeredCameras: evidence.registeredCameras.map(String) } : {}),
    ...(setup === undefined ? {} : { setup }),
    state: evidence.state,
    demoStates: evidence.demoStates ?? null,
    demos: Array.isArray(evidence.registeredDemos) ? evidence.registeredDemos : null,
    // `demo:x`, `eye:y` and `user:view` are the harness's own frames, not registered cameras.
    cameras: [
      ...new Set(
        (evidence.shots ?? [])
          .map((s: Shot) => s.camera)
          .filter((c: unknown) => typeof c === "string" && !c.includes(":")),
      ),
    ],
  });
}

/** git in the integration worktree for a question an empty answer settles (`unversionedNested`). */
export function nestedGit(loopRun: LoopRun, command: string, label?: string | null): Promise<string> {
  const { ctx, integrationWorktree } = loopRun;
  return ctx
    .call(HostMethod.RunExec, {
      command,
      cwd: integrationWorktree,
      timeoutMs: GIT_TIMEOUT_MS.quick,
      ...(label ? { label } : {}),
    })
    .then((r: { stdout?: string }) => String(r.stdout ?? ""))
    .catch(() => "");
}

/**
 * A line in the run's log (`logSeq`, see prepareLoopRun): what wakes a resting lead (wake.ts) and
 * what its next digest — or a `wait` — answers with. `kind` says what a line written outside the
 * lead's own turn is about; the waker decides by it, never by the words.
 */
export function note(loopRun: LoopRun, text: string, kind?: NoteKind): void {
  const { state } = loopRun;
  loopRun.logSeq += 1;
  state.log.push({ at: Date.now(), seq: loopRun.logSeq, text, ...(kind ? { kind } : {}) });
  if (state.log.length > MAX_LOOP_RUN_LOG) state.log.shift();
}

/** Every line the lead has not been told yet (the waker's digest or `wait`), including ones that arrived between. */
export function notesSince(loopRun: LoopRun, seq: number): LoopRunLogEntry[] {
  const { state } = loopRun;
  return state.log.filter((entry) => (entry.seq ?? 0) > seq);
}

/** What every ledger record of this run carries. */
export function ledgerFacts(loopRun: LoopRun) {
  const { gameKind, run } = loopRun;
  return { runId: run.runId, mode: RunMode.Director, game: run.project, gameKind };
}

/**
 * An outcome on the game's own ledger, chained behind the last one so five rounds finishing in
 * the same second land as five lines, in order (`ledgerWrites`, see prepareLoopRun).
 */
export function remember(loopRun: LoopRun, record: LedgerRecord): Promise<unknown> {
  const { ctx, run, runLedger } = loopRun;
  runLedger.push(record);
  loopRun.ledgerWrites = loopRun.ledgerWrites
    .then(() => appendLedger(ctx.workspace, run.project, record))
    .catch(() => {});
  return loopRun.ledgerWrites;
}

/** Checks this kind of game has never been able to measure — the dry run warns about them. */
export function neverMeasured(loopRun: LoopRun) {
  const { gameKind, priorLedger, runLedger } = loopRun;
  return rarelyMeasurable([...priorLedger, ...runLedger], { kind: gameKind });
}

/** What the integration worktree actually stands on right now — the one source of truth. */
export function currentHead(loopRun: LoopRun) {
  const { ctx, integrationWorktree, run } = loopRun;
  return headOf(ctx, integrationWorktree, { label: `director:${run.runId}:head` });
}

/**
 * The director edits in its worktree and commits with its own hands; `integrationHead` used
 * to move only on integrate, so a director commit made the judge, the health pass, the close
 * and the merge disagree about which build they were talking about (a judged fix the close
 * then left unreachable). Every tool call starts here: whatever HEAD says is the
 * integration head, it is protected by the ref, written to the journal, and named to the
 * director so it knows the studio saw what it did.
 */
export async function syncHead(loopRun: LoopRun) {
  const { appendRun, currentHead, journal, note, protectHead, saveJournal, state } = loopRun;
  const head = await currentHead().catch(() => null);
  if (!head || head === state.integrationHead) return state.integrationHead;
  state.integrationHead = head;
  journal.director.integrationHead = head;
  await protectHead(head);
  await saveJournal();
  await appendRun(RunEvent.DirectorProgress, { head });
  note(`you committed ${shortSha(head)} — it is now the integration head`);
  return head;
}

export function resolveRoot(
  loopRun: LoopRun,
  target: unknown,
):
  | { root: string; label: string; worker?: Worker; error?: undefined }
  | { error: string; root?: undefined; label?: undefined; worker?: undefined } {
  const { integrationWorktree, projectDir, state } = loopRun;
  const t = String(target ?? BuildTarget.Integration).trim() || BuildTarget.Integration;
  if (t === BuildTarget.Integration) return { root: integrationWorktree, label: BuildTarget.Integration };
  if (t === BuildTarget.Live) return { root: projectDir, label: BuildTarget.Live };
  const worker = state.workers.get(slug(t));
  if (worker?.worktree) return { root: worker.worktree, label: worker.id, worker };
  const besideTheRun = path.isAbsolute(t) && path.resolve(t).startsWith(path.dirname(integrationWorktree) + path.sep);
  if (besideTheRun) return { root: path.resolve(t), label: t };
  const started = [...state.workers.keys()].join(", ") || "none started";
  return {
    error: `no build called "${t}" — targets are integration, live, or a worker id (${started})`,
  };
}

/** The workers still running. */
export function runningWorkers(loopRun: LoopRun) {
  const { state } = loopRun;
  return [...state.workers.values()].filter((w: Worker) => isRunning(w));
}

/** Every round this run has finished, whichever worker ran it. */
export function runRoundMs(loopRun: LoopRun) {
  const { state } = loopRun;
  return [...state.workers.values()].flatMap((w: Worker) => w.roundMs ?? []);
}

export function runRoundMinutes(loopRun: LoopRun) {
  const { runRoundMs } = loopRun;
  return medianMinutes(runRoundMs());
}

/** The same in milliseconds, for the loop's own start gate. */
export function medianRoundMs(loopRun: LoopRun) {
  const { runRoundMs } = loopRun;
  const sorted = runRoundMs().sort((a: number, b: number) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
}

/** The run's ledger of defects nobody is building any more, oldest first, in words. */
export function ledgerLines(loopRun: LoopRun) {
  const { state } = loopRun;
  return state.ledger.map(
    (d: AnyRecord) => `${d.text} — worker ${d.owner}'s, named while judging ${d.from}; nobody is building it`,
  );
}

/**
 * A window to look through (evidence.ts `withLease`): a judge or a playtest can wait and is told
 * no window is free; a pass that cannot be skipped looks through the studio's stand-in.
 */
export function withLease<T>(
  loopRun: LoopRun,
  label: WindowLease,
  fn: (handle: string | null) => Promise<T>,
  { borrow = false }: { borrow?: boolean } = {},
): Promise<T | { noWindow: string }> {
  const { ctx, pooledWindows } = loopRun;
  return leaseWindow(ctx, label, fn, { borrow, pooled: pooledWindows });
}

/**
 * One look at a build. Two things every pass here needs and none of them had until now: the
 * console errors the build INHERITED (an error it did not introduce is not its fault — one
 * shader line in a base nobody owned cost four first-round iterations, every judge of a run
 * and its landing), and the base exemption for this run's own starting point (a scaffold is
 * allowed to be blank; a game is not).
 *
 * `scaffold` reaches gauntlet as its base pass — iterationId "base" is the stage's name
 * there, not this pass's label, and the frames still land under `director/<label>`.
 */
export async function evidenceOf(
  loopRun: LoopRun,
  root: string,
  {
    handle,
    label,
    cameras = null,
    setup,
    motion = 6,
    scaffold = false,
    inheritedConsole = [],
    keepPaths = boardStatePaths(loopRun),
    viewport = null,
    maxDemos = Infinity,
    requiredDemos = [],
    challenge = false,
  }: {
    handle?: string | null;
    label: string;
    cameras?: string[] | null;
    setup?: AnyRecord | null;
    motion?: number;
    scaffold?: boolean;
    inheritedConsole?: string[];
    /** The state paths the boards read, cut last (default: every running worker's probes). */
    keepPaths?: string[];
    /** Look at this size (the art director's 1600×900): the leased window only. */
    viewport?: { width: number; height: number } | null;
    /**
     * Demos beyond `requiredDemos` this look runs: every one, unless a pass says otherwise — a
     * health pass inside a wave runs the demos workers' checks name (integrate.ts).
     */
    maxDemos?: number;
    requiredDemos?: string[];
    /** Race the throttle-only bot after the demos (evidence.ts): the art director's whole-game look. */
    challenge?: boolean;
  },
): Promise<Evidence> {
  const { ctx, run } = loopRun;
  return gatherEvidence(ctx, {
    keepPaths,
    ...(viewport ? { viewport } : {}),
    run,
    iterationId: scaffold ? "base" : label,
    seed: PAGE_SEED,
    ...(handle ? { handle } : {}),
    root,
    labelPrefix: `director/${label}`,
    cameras,
    eyes: true,
    motion,
    audio: true,
    maxDemos,
    ...(requiredDemos.length ? { requiredDemos } : {}),
    ...(challenge ? { challenge } : {}),
    setup: setup === undefined ? run.setup : setup,
    scaffold,
    inheritedConsole,
  });
}

/**
 * The state paths every worker's board reads (`statePathsNamedByChecks`): a look at a build the
 * workers share — integration's health, the close, a judge — asks the studio to cut them last, so
 * a probe is read from a bounded state and never finds its path cut away.
 */
function boardStatePaths(loopRun: LoopRun): string[] {
  const checks = [...(loopRun.state?.workers?.values() ?? [])].flatMap((worker) => worker.spec?.checks ?? []);
  return statePathsNamedByChecks(checks);
}

/** Every distinct console error a build logged — the baseline the next pass forgives, not the five a prompt shows. */
export function errorsLogged(_loopRun: LoopRun, evidence: Evidence | null | undefined): string[] {
  return evidence?.consoleBaseline ?? evidence?.consoleErrors ?? [];
}

/** What a build is not to blame for: the run's starting errors, plus a worker's own fork point's. */
export function consoleInheritedBy(loopRun: LoopRun, worker: Worker | null = null): string[] {
  const { state } = loopRun;
  return [...new Set([...(state.startConsole ?? []), ...(worker?.baseConsole ?? [])])];
}

// A load that raced the window (no __studio yet, a capture before the first frame) is not a
// broken build: look again before saying so, or a health pass fails builds the judge finds fine
// seconds later (evidence.ts `loadRaced` decides what a race is).
export async function patientEvidence(
  loopRun: LoopRun,
  root: string,
  options: Omit<GatherOptions, "run"> & { label: string; [option: string]: unknown },
): Promise<Evidence> {
  const { ctx, evidenceOf, note } = loopRun;
  const evidence = await lookPatiently(ctx, () => evidenceOf(root, options), {
    attempts: PATIENT_LOOKS,
    onRace: (raced: Evidence) =>
      note(`${options.label}: the window raced the load (${raced.problems[0]}) — looking again`),
  });
  // Only a patient look given no attempts comes back empty, and this one always has some.
  if (!evidence) throw new Error(`${options.label}: no look was taken`);
  return evidence;
}

export function writeVerdict(loopRun: LoopRun, name: string, value: unknown): Promise<unknown> {
  const { ctx, run } = loopRun;
  return writeRunArtifact(ctx, run.runId, name, withoutFrames(value));
}

/**
 * Every build this run judges gets the same record, on the same event path as `director_worker`.
 * Before this, the lead's four passes wrote `verdict.json` files and in-memory notes that no
 * screen could read, so the app's build box showed boilerplate about a run instead of what the
 * last look at the build actually found.
 */
export async function recordVerdict(loopRun: LoopRun, fields: Parameters<typeof verdictRecord>[0]) {
  const { appendRun, report } = loopRun;
  const record = verdictRecord(fields);
  report.verdicts.push(record);
  if (report.verdicts.length > MAX_REPORT_VERDICTS) report.verdicts.shift();
  await appendRun(RunEvent.DirectorVerdict, record);
  return record;
}

export function shotsOf(_loopRun: LoopRun, evidence: Evidence | null | undefined): AnyRecord[] {
  return (evidence?.shots ?? []).map((s: Shot) => ({
    camera: s.camera,
    path: s.path,
    ...(s.stats
      ? {
          litFraction: Number(s.stats.litFraction?.toFixed?.(2) ?? s.stats.litFraction),
          meanLuma: Math.round(s.stats.meanLuma ?? 0),
        }
      : {}),
  }));
}

/** A worker's last commit: the one its loop accepted, or whatever its worktree stands on. */
export async function workerCommit(loopRun: LoopRun, worker: Worker): Promise<string | null> {
  const { ctx } = loopRun;
  if (worker.lastCommit) return worker.lastCommit;
  // A worker still building stands on whatever its round has just committed — an attempt the
  // judge may yet reject — so only what it accepted is its work until it ends: the
  // commit its last accepted round left (`lastAccepted`). `lastCommit` alone is set only when a
  // worker ends, and would tell the lead "no commit yet" about workers with accepted rounds.
  if (isRunning(worker)) return worker.lastAccepted ?? null;
  if (!worker.worktree) return null;
  return headOf(ctx, worker.worktree).catch(() => null);
}

/**
 * Put every function of the run on the object, bound to it, so a function destructures the
 * ones it calls from the run it was handed. `modules` are the director's module namespaces.
 */
export function bindLoopRun(
  data: Pick<LoopRunData, "ctx" | "threadId" | "run" | "resume">,
  modules: ReadonlyArray<Record<string, unknown>>,
): LoopRun {
  // The one place the run is assembled: its functions are attached here, and prepareLoopRun
  // (setup.ts) assigns the rest of its data before any function reads it.
  const loopRun = data as LoopRun;
  const slots = loopRun as unknown as Record<string, unknown>;
  for (const module of modules) {
    for (const [name, fn] of Object.entries(module)) {
      if (typeof fn !== "function" || UNBOUND_FUNCTIONS.has(name)) continue;
      slots[name] = (...args: unknown[]) => fn(loopRun, ...args);
    }
  }
  return loopRun;
}
