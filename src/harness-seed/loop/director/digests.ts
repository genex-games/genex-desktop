/**
 * What the director reads about its workers: one round as the report keeps it, one worker in
 * full (`run_status`, `worker_status`) or in a line (`wait`), its loop as a digest, and the
 * transitions in that loop worth waking for. Pure, with no run of their own.
 */
import { summarizeScoreboard } from "../checks.ts";
import { FACET_POLICY, ITERATION_HEADROOM } from "../facet-loop.ts";
import { isRunning } from "../outcomes.ts";
import { shortSha } from "../git.ts";
import { CLIP_DETAIL, CLIP_QUOTE, clip } from "../text.ts";
import { minutes } from "../time.ts";
import { VerdictSource } from "../verdict.ts";
import { medianMinutes } from "./budgets.ts";
import { Side } from "../judge.ts";
import { FacetStage, isFinishing } from "../facet/stage.ts";
import { isBeyondScope } from "../scope.ts";
import type { AnyRecord } from "../../types/harness.d.ts";
// Type-only: erased at runtime, so this module still imports no part of the run.
import type { Worker } from "./loop-run.ts";

/** How many entries of a list a digest shows before it says how many more there are. */
const DIGEST_ENTRIES = 6;
/** How much of a check's reason, a move, a stop reason a digest carries. */
const DIGEST_REASON = 160;
const DIGEST_MOVE = 300;
const DIGEST_STOPPED = 200;
/** How much of a reviewer's proposal a digest carries. */
const DIGEST_IDEA = 220;
/** How a reviewer's proposal beyond the ask is labelled in a digest: the user's call, not a rung. */
const BEYOND_ASK_IDEA = "reviewer, outside the ask (the user decides; never a rung)";
/** A round's defects, frames and board results the report keeps. */
const ROUND_DEFECTS = 8;
const ROUND_SHOTS = 8;
const ROUND_RESULTS = 40;
/** The judge-grown checks a loop digest names as retired (the most recent). */
const RETIRED_SHOWN = 12;

/** Like `clip`, but nothing stays null rather than becoming an empty string. */
const clipOrNull = (value: unknown, max: number): string | null =>
  value === null || value === undefined ? null : String(value).slice(0, max);

/** A round's move, as the facet loop records it. */
interface RoundMove {
  what?: string;
  source?: string | null;
  mandatory?: boolean;
  delivered?: boolean | null;
  note?: string | null;
}

/** The record, as the facet loop's round writes it. */
export interface RoundRecord {
  iteration?: number;
  winner?: string | null;
  satisfied?: boolean;
  reason?: string;
  biggest_gap?: string;
  defects?: string[];
  verdictSource?: string | null;
  scoreboard?: {
    flips?: string[];
    regressions?: string[];
    results?: unknown[];
    passing?: number;
    total?: number;
  } | null;
  verdict?: { because?: string } | null;
  move?: RoundMove | null;
  /** The taste judge's one big move for the part this round. */
  bigMove?: { what?: string; why?: string; scope?: string } | null;
  /** The liveness critic's card: the principle that would change the feel most, and its fix. */
  liveness?: { biggest?: string | null; biggestFix?: string | null } | null;
  /** What the round's reviewers proposed next, once the round is digested (`iterationDigest`). */
  ideas?: string[];
  shots?: Array<{ path?: string } | string>;
}

/**
 * What the round was asked to build and whether it arrived (M3.3). A move the harness named for
 * itself no longer costs the round when it is missing, so this is how the director learns that
 * the ladder is drifting — and steers, with worker_steer move=.
 */
function moveDigest(move: RoundMove | null | undefined): AnyRecord | null {
  if (!move?.what) return null;
  return {
    what: clip(move.what, CLIP_DETAIL),
    source: move.source ?? null,
    mandatory: move.mandatory === true,
    delivered: move.delivered ?? null,
    note: move.note ?? null,
  };
}

/**
 * What the round's reviewers propose for the part next: the taste judge's big move and the
 * liveness critic's biggest fix, one line each, or none: a lead that never hears them steers its
 * workers one defect at a time.
 */
function roundIdeas(record: RoundRecord): string[] {
  const ideas: string[] = [];
  const bigMove = record.bigMove?.what;
  // A step beyond the ask is the user's decision (the worker already put it to them): the lead
  // reads it labelled, so it is never promoted to the next rung.
  const who = isBeyondScope(record.bigMove) ? BEYOND_ASK_IDEA : "reviewer";
  if (bigMove) ideas.push(`${who}: ${clip(bigMove, DIGEST_IDEA)}`);
  const critic = record.liveness?.biggestFix;
  if (critic) ideas.push(`critic (${record.liveness?.biggest ?? "feel"}): ${clip(critic, DIGEST_IDEA)}`);
  return ideas;
}

/**
 * What the run's report keeps of one worker round.
 *
 * The first run's report dropped `verdictSource` and the scoreboard on every one of its
 * twenty-one rounds, so `report.json` — the only durable record of a run — could say a round
 * was lost but never how it was judged or what it measured. They are kept now, beside the
 * round's own verdict record; the frames are not (the report is read, not looked at).
 */
export function iterationDigest(record: RoundRecord) {
  // A round nobody judged is neither won nor lost. It says so, so the notes, the report and the
  // status digest all stop counting it as a defeat.
  const stopped = record.verdictSource === VerdictSource.Stopped;
  const board = record.scoreboard ?? null;
  return {
    iteration: record.iteration,
    won: record.winner === Side.Challenger,
    stopped,
    satisfied: record.satisfied === true,
    reason: record.reason ?? "",
    biggestGap: record.biggest_gap ?? "",
    defects: (record.defects ?? []).slice(0, ROUND_DEFECTS),
    flips: board?.flips ?? [],
    regressions: board?.regressions ?? [],
    verdictSource: record.verdictSource ?? null,
    scoreboard: board ? { ...board, results: (board.results ?? []).slice(0, ROUND_RESULTS) } : null,
    verdict: record.verdict ?? null,
    move: moveDigest(record.move),
    ideas: roundIdeas(record),
    shots: (record.shots ?? [])
      .map((s) => (typeof s === "string" ? s : s?.path))
      .filter(Boolean)
      .slice(0, ROUND_SHOTS),
  };
}

/** The first few entries of a board list, each reason clipped, and how many more there are. */
function boundEntries(list: unknown): { shown: AnyRecord[]; more: number } {
  const all = Array.isArray(list) ? list : [];
  return {
    shown: all.slice(0, DIGEST_ENTRIES).map((e: AnyRecord) => ({ ...e, reason: clipOrNull(e.reason, DIGEST_REASON) })),
    more: Math.max(0, all.length - DIGEST_ENTRIES),
  };
}

/**
 * A worker's board, bounded. `run_status` carries every worker's whole board, and a run with
 * six workers and forty checks each spent a quarter of its turns re-reading them. The counts,
 * `identityAllPass` and the first few failing checks are what a decision is made on; the rest
 * is a number, and `worker_status` still answers with all of it.
 */
export function clampBoard(board: AnyRecord | null | undefined): AnyRecord | null {
  if (!board) return null;
  const failing = boundEntries(board.failing);
  const unmeasured = boundEntries(board.unmeasuredChecks);
  return {
    ...board,
    failing: failing.shown,
    ...(failing.more ? { failingNotShown: failing.more } : {}),
    unmeasuredChecks: unmeasured.shown,
    ...(unmeasured.more ? { unmeasuredNotShown: unmeasured.more } : {}),
  };
}

/** The gap a loop has been told to fix, as a digest carries it. */
function fixDigest(fix: AnyRecord): AnyRecord {
  return {
    what: clipOrNull(fix.what, DIGEST_REASON),
    rounds: fix.streak ?? 0,
    ...(fix.mandatory ? { mandatory: true } : {}),
    ...(fix.losses ? { losses: fix.losses } : {}),
  };
}

/**
 * The loop a worker is in, as a director reads it (M4.10) — everything zero, empty or the
 * harness's own default left out, so a quiet worker costs three fields and a busy one says why.
 */
export function loopDigest(loop: AnyRecord | null | undefined): AnyRecord | null {
  if (!loop) return null;
  const policy = loop.policy ?? FACET_POLICY;
  const judge = loop.judgeChecks ?? {};
  const digest: AnyRecord = {
    round: loop.round,
    phase: loop.phase,
    judgeChecks: `${judge.live ?? 0}/${judge.max ?? policy.maxJudgeChecks}`,
  };
  if (loop.polishStreak) digest.polishStreak = loop.polishStreak;
  if (loop.loseStreak) digest.loseStreak = loop.loseStreak;
  if (loop.brokenStreak?.count)
    digest.brokenStreak = `${loop.brokenStreak.count}/${policy.brokenStreakLimit} — ${clipOrNull(loop.brokenStreak.reason, DIGEST_REASON)}`;
  if (loop.fix) digest.fix = fixDigest(loop.fix);
  if (judge.retired?.length) digest.retiredChecks = judge.retired.slice(-RETIRED_SHOWN);
  if (loop.estimateMs) digest.roundEstimateMinutes = minutes(loop.estimateMs);
  return digest;
}

/** A build nobody could judge, one more than the last look saw: the sentence, or null. */
function brokenStreakNote(id: string, was: AnyRecord | null, now: AnyRecord, policy: AnyRecord): string | null {
  const broken = now.brokenStreak?.count ?? 0;
  if (!(broken > (was?.brokenStreak?.count ?? 0) && broken > 0)) return null;
  const left = Math.max(0, policy.brokenStreakLimit - broken);
  return `worker ${id}: an unjudgeable build (${clipOrNull(now.brokenStreak.reason, CLIP_QUOTE)}) — ${left ? `${left} more with the same cause and it stops` : "that is the limit; it stops rather than build a third"}`;
}

/**
 * A gap that has just become mandatory: keyed on what the fix IS and whether it is mandatory —
 * the same gap becoming mandatory is a new fact, and a mandatory streak that merely grows is not.
 */
function mandatoryFixNote(id: string, was: AnyRecord | null, now: AnyRecord): string | null {
  const newlyMandatory = was?.fix?.what !== now.fix?.what || was?.fix?.mandatory !== true;
  if (!now.fix?.mandatory || !newlyMandatory) return null;
  return `worker ${id}: the judge has named the same gap ${now.fix.streak} rounds running and it is now mandatory — a build that leaves it loses: "${clipOrNull(now.fix.what, CLIP_QUOTE)}"`;
}

/** A board that has just filled up with judge-grown questions. */
function judgeChecksFullNote(id: string, was: AnyRecord | null, now: AnyRecord, policy: AnyRecord): string | null {
  const live = now.judgeChecks?.live ?? 0;
  const max = now.judgeChecks?.max ?? policy.maxJudgeChecks;
  if (!(live >= max && (was?.judgeChecks?.live ?? 0) < max)) return null;
  return `worker ${id}: its board carries the most judge-grown questions it may (${live}/${max}) — a new defect now waits for one to retire`;
}

/**
 * Judge-grown checks retired since the last look. The id-set difference, not the length: the
 * list is sliced, so two retirements after the slice starts biting would look like none at all.
 */
function retiredChecksNote(id: string, was: AnyRecord | null, now: AnyRecord): string | null {
  const said = new Set(was?.judgeChecks?.retired ?? []);
  const fresh = (now.judgeChecks?.retired ?? []).filter((checkId: string) => !said.has(checkId));
  if (!fresh.length) return null;
  const retired = fresh.length === 1 ? "a judge-grown check has" : `${fresh.length} judge-grown checks have`;
  return `worker ${id}: ${retired} retired (${fresh.slice(0, DIGEST_ENTRIES).join(", ")})`;
}

/**
 * A polish streak that has just reached the point where the next brief makes the move mandatory.
 * Never for a worker whose streak cannot escalate (`escalates: false` — a director-owned or a
 * finishing one); a loop state from before the field keeps the old note.
 */
function polishStreakNote(id: string, was: AnyRecord | null, now: AnyRecord, policy: AnyRecord): string | null {
  if (now.escalates === false) return null;
  if (!(now.polishStreak >= policy.polishStreakEscalate && now.polishStreak > (was?.polishStreak ?? 0))) return null;
  return `worker ${id}: ${now.polishStreak} accepted builds in a row only polished — the next brief makes the move mandatory`;
}

/**
 * What changed in a worker's loop that a director would want waking for. Only transitions, most
 * urgent first, one per look — and every sentence opens `worker <id>:` so `wait worker=<id>`
 * matches on it the way the monitor's notes already do.
 */
export function loopNote(
  id: string,
  before: AnyRecord | null | undefined,
  now: AnyRecord | null | undefined,
): string | null {
  if (!now) return null;
  const policy = now.policy ?? FACET_POLICY;
  const was = before ?? null;
  return (
    brokenStreakNote(id, was, now, policy) ??
    mandatoryFixNote(id, was, now) ??
    judgeChecksFullNote(id, was, now, policy) ??
    retiredChecksNote(id, was, now) ??
    polishStreakNote(id, was, now, policy)
  );
}

/** The last move a round was asked for, and what became of it — the ladder, seen from here. */
const lastMove = (w: Worker): AnyRecord | null =>
  [...w.iterations].reverse().find((i: AnyRecord) => i.move?.what)?.move ?? null;

/** What the studio saw last time it looked into the worktree mid-turn (the monitor). */
function monitorFields(monitor: AnyRecord | null | undefined): AnyRecord {
  if (!monitor) return {};
  return {
    minutesInRound: monitor.minutesInRound,
    filesChanged: monitor.files.length,
    ...(monitor.violations.length ? { violations: monitor.violations.slice(0, DIGEST_ENTRIES) } : {}),
    ...(monitor.look ? { lastLook: monitor.look } : {}),
  };
}

/** What a worker's rounds have come to: how many, how many kept or stopped, and what one costs. */
function roundFields(w: Worker): AnyRecord {
  const stoppedRounds = w.iterations.filter((i: AnyRecord) => i.stopped).length;
  const iterationMinutes = medianMinutes(w.roundMs);
  return {
    iterations: w.iterations.length,
    accepted: w.iterations.filter((i: AnyRecord) => i.won).length,
    ...(stoppedRounds ? { stoppedRounds } : {}),
    // What a round of this worker's has cost, so the director can size the next one from data.
    ...(iterationMinutes === null ? {} : { iterationMinutes }),
  };
}

/**
 * Where its loop stands, and how many whole rounds its budget still holds. The divisor is
 * ITERATION_HEADROOM's, not the bare estimate: the loop refuses to START a round without that
 * headroom, and telling a director it has a round the worker will refuse is worse than saying
 * nothing at all.
 */
function loopFields(w: Worker, now: number): AnyRecord {
  const loop = loopDigest(w.loop);
  const estimateMs = isRunning(w) ? w.loop?.estimateMs : null;
  return {
    ...(loop ? { loop } : {}),
    ...(estimateMs
      ? { roundsLeft: Math.max(0, Math.floor((w.deadline - now) / (estimateMs * ITERATION_HEADROOM))) }
      : {}),
    // Only what this worker was started with — the defaults are on `run_status` once.
    ...(w.policyOverrides && Object.keys(w.policyOverrides).length ? { policy: w.policyOverrides } : {}),
  };
}

/** Why a worker stopped, in the words it was given: its loop's, the director's, or its error. */
const stopReasonOf = (w: Worker): string | null => w.result?.stoppedBecause ?? w.stopWhy ?? w.error ?? null;

/** The board a worker's last result carries, bounded — or null before it has one. */
function boardOf(w: Worker): AnyRecord | null {
  if (!w.result?.board || !w.result?.spec) return null;
  return clampBoard(summarizeScoreboard(w.result.board, w.result.spec));
}

/** One worker in full: what `run_status` and `worker_status` answer with. */
export function workerDigest(w: Worker, now = Date.now()): AnyRecord {
  const move = lastMove(w);
  return {
    id: w.id,
    title: w.title,
    mode: w.mode,
    state: w.state,
    minutesRunning: minutes((w.endedAt ?? now) - w.startedAt),
    minutesLeft: isRunning(w) ? minutes(w.deadline - now) : 0,
    // Only a finishing worker says its stage: polish is its work, and it takes no move.
    ...(isFinishing(w.spec) ? { stage: FacetStage.Finish } : {}),
    ...roundFields(w),
    lastCommit: w.lastCommit ? shortSha(w.lastCommit) : null,
    board: boardOf(w),
    move: move ? { ...move, what: clipOrNull(move.what, DIGEST_MOVE) } : null,
    ...loopFields(w, now),
    ...monitorFields(w.monitor),
    stoppedBecause: clipOrNull(stopReasonOf(w), DIGEST_STOPPED),
    worktree: w.worktree,
  };
}

/**
 * One worker in a line, for `wait`. The whole status blob — every worker's board, the window
 * pool, the screen strip — on every wait would swell the director's turns to hundreds of
 * thousands of tokens. What a waiting director needs is what changed; `run_status` is one call away for the rest.
 */
export function waitDigest(w: Worker, now = Date.now()): AnyRecord {
  const board = [...w.iterations].reverse().find((i: AnyRecord) => i.scoreboard)?.scoreboard ?? null;
  const running = isRunning(w);
  const because = running ? null : stopReasonOf(w);
  return {
    id: w.id,
    state: w.state,
    ...(running ? { minutesLeft: minutes(w.deadline - now), round: w.iterations.length + 1 } : {}),
    accepted: w.iterations.filter((i: AnyRecord) => i.won).length,
    ...(board ? { passing: `${board.passing}/${board.total}` } : {}),
    // One line of the loop, and only the one a waiting director must act on: a gap the brief has
    // made mandatory. `wait` is called dozens of times a run; the rest is on `run_status`.
    ...(w.loop?.fix?.mandatory ? { mandatoryFix: clipOrNull(w.loop.fix.what, DIGEST_REASON) } : {}),
    ...monitorFields(w.monitor),
    ...(because ? { stoppedBecause: String(because).slice(0, DIGEST_STOPPED) } : {}),
  };
}
