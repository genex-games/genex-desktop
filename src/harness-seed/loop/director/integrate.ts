import { goalDecision, GoalStatus } from "./goals.ts";
/**
 * Integration and the close: merging a worker's accepted commit into the integration branch
 * (with its health pass), and the one close both roads out of a run take — the director's own
 * `finish` and the harness's clock path — which lands the branch under one rule and writes the
 * report.
 */

import { GIT_TIMEOUT_MS } from "../config.ts";
import {
  commitAll,
  GIT,
  gitAt,
  gitlinks,
  headOf,
  isAncestor,
  LABEL_SHA_LENGTH,
  mergeNoFf,
  shortFailure,
  shortSha,
  unversionedNested,
} from "../git.ts";
import { HostMethod } from "../host-methods.ts";
import { Side } from "../judge.ts";
import { learningOn } from "../learning.ts";
import {
  closeRecord,
  flagRarelyMeasurable,
  learnedThisRun,
  readLedger,
  saveGameLessons,
  trimLedger,
} from "../ledger.ts";
import { unionMergeMain } from "../merge.ts";
import { skipOptimization } from "../optimization.ts";
import { EventKind, ExecutionStatus, JournalPhase, RunEvent, writeRunArtifact } from "../run-events.ts";
import { isCommit } from "../shell.ts";
import { CheckOrigin, loadCatalogue, recordCatalogueOutcomes, saveCatalogue } from "../spec.ts";
import { CLIP_DETAIL, CLIP_REASON } from "../text.ts";
import { minutes, SECOND_MS, sleep } from "../time.ts";
import { againstWords, NotLandedReason, observedFrom, VerdictPass, VerdictRule } from "../verdict.ts";
import { randomUUID } from "node:crypto";
import { demosNamedBy, dependentsOf, lookOf, lostRegistrations, lostWords, setupKey } from "../registry.ts";
import type { LostRegistration } from "../registry.ts";
import { list, slug, yes } from "./args.ts";
import { CLOSE_SETTLE_MS, timedWorkRemaining } from "./budgets.ts";
import { workerDigest } from "./digests.ts";
import { resolveByWorker, unresolvedOf } from "./conflict-worker.ts";
import { contractAloneOnStart } from "./contract-gate.ts";
import { setAsideStrays } from "./lead-session.ts";
import { LEAD_DIRTY, LEAD_FIX_NEXT, LEAD_SET_ASIDE } from "./lead-session-prompts.ts";
import type { SetAside } from "./lead-session.ts";
import { BuildTarget, WindowLease } from "./loop-run.ts";
import { LandingHow, landingWords } from "./rules.ts";
import { shipFinishLine } from "./art-direction-prompts.ts";
import type { LastJudge, LoopRun, Worker } from "./loop-run.ts";
import type { LastShip } from "./art-direction.ts";
import type { Evidence } from "../evidence.ts";
import type { AnyRecord, HarnessCtx } from "../../types/harness.d.ts";
import type { EventData } from "../../types/host-api.d.ts";

/**
 * This part serves a lead that is its chat's own session and writes nothing (one session): a run
 * seats one only when every part it depends on says so (lead-session.ts `servesLead`).
 */
export const SERVES_LEAD = true;

/** Which merge an `integration_merge` record is (the app's run graph reads it): never rename a value. */
const MergeStage = { Director: "director" } as const;

/** How many of a health pass's problems its card on the run's thread names. */
const HEALTH_CARD_PROBLEMS = 5;
/**
 * Demos a merge's health pass runs beyond the ones workers' checks name: none asked for (the
 * evidence pass still runs one, its floor). The close's own look runs every demo.
 */
const HEALTH_EXTRA_DEMOS = 0;

/** What `integrate wave=` may say: never rename a value. */
const WaveArg = { Close: "close" } as const;

/** The words of a wave and of a merge that lost a registration, to the lead and on the user's card. */
const WAVE_WORDS = {
  closed: (head: string) => `the wave closed on ${shortSha(head)}: running workers take it at their next round`,
  health: (known: boolean | undefined) => {
    if (known === true) return "ok";
    if (known === false) return "does not run — fix it before workers build on it";
    return "not looked at yet — judge integration";
  },
  lost: (words: string) => `the merged build ${words} — put it back before workers merge this head`,
  lostNext:
    "the merged build runs but lost what another worker depends on (health.problems) — put it back (your own commit, or a single worker) or re-plan the contract before anything else",
  lostPlain: "the merged build lost something another part of the build relies on; the lead is putting it back",
  thenClose: "; then integrate wave=close so running workers take the repair",
} as const;

/** Why `integrate` will not merge a worker, in the sentence the director reads. */
const INTEGRATE_REFUSAL = {
  noWorker: (id: unknown) => `no worker "${id}"`,
  noneNamed:
    "integrate needs worker= (one id, or ids comma-separated for a wave) or wave=close (running workers take the integration head now)",
  noCommit: (id: string) => `worker ${id} has no commit yet`,
  notACommit: (id: string) => `worker ${id}'s last commit is not a commit hash`,
  nothingNew: (id: string, commit: string) =>
    `worker ${id} has committed nothing beyond what it forked from (${shortSha(commit)}) — nothing to integrate`,
  alreadyIn: (id: string, commit: string) =>
    `worker ${id}'s commit ${shortSha(commit)} is already on the integration branch`,
  checkpoint: (error: unknown) =>
    `Asset checkpoint needs attention: ${error}. Preserve local assets; do not move them out of the game or replace them with remote URLs.`,
  dirty:
    "Your integration worktree has unrelated uncommitted edits. Host-delivered assets have been checkpointed. Resolve those edits before integrating; keep director notes in .studio/DIRECTOR.md, which the host already persists. Never move or delete assets to clear this check.",
} as const;

/** Why a close the user stopped landed nothing: the words the chat reads a stopped run by. */
const STOPPED_BY_USER = "stopped by the user";
/** Tries at writing a run's close, and the wait between them: without it the run reads as running. */
const CLOSE_APPEND_ATTEMPTS = 3;
const CLOSE_APPEND_RETRY_MS = SECOND_MS;

/** What a close that landed nothing says, and the code the verdict reads it by. */
function notLanded(reason: string, why: NotLandedReason): AnyRecord {
  return { ok: false, reason, why };
}

/** Why a run a lost provider paused lands nothing (`closeTheLoopRun` with `paused`). */
const PAUSED_UNLANDED = "the run paused on its provider; nothing is made live that nobody could check";

/** The starting point is not a run's work: said when the branch has nothing beyond it. */
const NOTHING_BEYOND_THE_START = "the integration branch has nothing beyond the starting point";

/** At most this many paths are named in a sentence about them. */
const PATHS_NAMED = 8;
/** The fewest characters of the user's own words that stand for their message (`userQuoted`). */
const MIN_USER_QUOTE_CHARS = 8;

/**
 * A file name or git's own words in a reason, with brackets for parentheses: the clock's close
 * quotes the reason in parentheses, and the card strips that clause by them.
 */
function unbracketed(text: unknown): string {
  return String(text).replaceAll("(", "[").replaceAll(")", "]");
}

/** Paths as the close names them: the first few, and how many more. */
function named(paths: readonly string[]): string {
  const more = paths.length > PATHS_NAMED ? ` and ${paths.length - PATHS_NAMED} more` : "";
  return `${unbracketed(paths.slice(0, PATHS_NAMED).join(", "))}${more}`;
}

/** A porcelain status line's path: the new name of a rename, without the quotes git adds. */
function changedPath(line: string): string {
  const rest = line.slice(3).trim();
  const renamed = rest.indexOf(" -> ");
  return (renamed >= 0 ? rest.slice(renamed + 4) : rest).replace(/^"(.*)"$/, "$1");
}

/**
 * Did git refuse the merge over these uncommitted paths? Its refusal lists each file it would have
 * written over on a line of its own, in any language; an untracked folder is one porcelain path
 * (`test-results/`) for the files git lists inside it. A hook, a held index lock or a timeout names
 * none of them, and is no uncommitted change's doing.
 */
function refusedOver(paths: readonly string[], error: string): boolean {
  const listed = error.split("\n").map((line) => line.trim());
  return paths.some((changed) =>
    listed.some((file) => file === changed || (changed.endsWith("/") && file.startsWith(changed))),
  );
}

/**
 * The landing's words about the game folder, to the lead (its `finish` answer, `run_status`) and on
 * the run's log. The same rule as `named`: no parentheses.
 */
const LANDING_WORDS = {
  uncommitted: (paths: readonly string[], ref: string) =>
    `git would not land this build over what is uncommitted in the game folder — ${named(paths)}. No worker did this: your own commands there or the user may have, so leave it as it is — tell the user what, and that Make it live in Builds, or land_build in this chat, lands this build from ${ref} once it is kept or undone`,
  leftInGame: (paths: readonly string[]) =>
    `the game folder still has uncommitted changes the landing left as they were — ${named(paths)}; they are not part of this build`,
} as const;

/** The console errors the merged workers' fork points already had: none of them is the merge's doing. */
function inheritedByAll(loopRun: LoopRun, workers: readonly Worker[]): string[] {
  const { consoleInheritedBy } = loopRun;
  if (workers.length === 1) return consoleInheritedBy(workers[0] as Worker);
  return [...new Set(workers.flatMap((each) => consoleInheritedBy(each)))];
}

/**
 * A look at the integration worktree that may not be skipped — a merge's health pass, the
 * close's last look: whether the build runs is not a question the run may leave open, so the
 * pass takes the user's window when there is nothing else (out loud, and gives it back).
 */
function lookAtIntegration(
  loopRun: LoopRun,
  {
    lease,
    label,
    scaffold,
    worker = null,
    workers = null,
    demos = null,
  }: {
    lease: WindowLease;
    label: string;
    scaffold?: boolean;
    worker?: Worker | null;
    /** The workers a wave merged: none of their fork points' errors is the merge's doing. */
    workers?: readonly Worker[] | null;
    /** A health pass inside a wave runs the demos workers' checks name, not every demo (the close does). */
    demos?: string[] | null;
  },
): Promise<Evidence> {
  const { consoleInheritedBy, integrationWorktree, patientEvidence, run, withLease } = loopRun;
  const inherited = workers?.length ? inheritedByAll(loopRun, workers) : consoleInheritedBy(worker);
  return withLease(
    lease,
    async (handle: string | null) =>
      patientEvidence(integrationWorktree, {
        handle,
        label,
        motion: 0,
        setup: run.setup ?? null,
        scaffold,
        inheritedConsole: inherited,
        ...(demos ? { maxDemos: HEALTH_EXTRA_DEMOS, requiredDemos: demos } : {}),
      }),
    { borrow: true },
  );
}

/**
 * What a look at a head found, where every later pass reads it: whether it loads, the console
 * errors it logs anyway (so the next pass over this head does not re-blame it), and its
 * `director/<label>/verdict.json`.
 */
async function recordHeadHealth(loopRun: LoopRun, head: string | null, label: string, health: Evidence): Promise<void> {
  const { errorsLogged, shotsOf, state, writeVerdict } = loopRun;
  state.healthByHead.set(head, health.ok === true);
  state.consoleByHead.set(head, errorsLogged(health));
  await writeVerdict(`director/${label}/verdict.json`, {
    head,
    ok: health.ok === true,
    problems: health.problems ?? [],
    warnings: health.warnings ?? [],
    consoleErrors: health.consoleErrors ?? [],
    attempts: health.attempts ?? 1,
    shots: shotsOf(health),
  });
}

// ── integration ──

/** The commit `integrate` would merge for this worker — or why there is nothing to merge. */
async function resolveWorkerCommit(
  loopRun: LoopRun,
  worker: Worker,
): Promise<{ commit: string; refusal?: undefined } | { refusal: string }> {
  const { ctx, integrationWorktree, workerCommit } = loopRun;
  const commit = await workerCommit(worker);
  if (!commit) return { refusal: INTEGRATE_REFUSAL.noCommit(worker.id) };
  if (!isCommit(commit)) return { refusal: INTEGRATE_REFUSAL.notACommit(worker.id) };
  if (commit === worker.from) return { refusal: INTEGRATE_REFUSAL.nothingNew(worker.id, commit) };
  if (await isAncestor(ctx, integrationWorktree, commit))
    return { refusal: INTEGRATE_REFUSAL.alreadyIn(worker.id, commit) };
  return { commit };
}

/** The integration worktree made ready for a merge: why it may not go ahead, and what was set aside for a lead. */
interface MergeReadiness {
  refusal: string | null;
  setAside: SetAside | null;
}

/**
 * The integration worktree, ready to take a merge: the host's delivered assets checkpointed, and
 * nothing else uncommitted in it. A director with its own hands clears what else is there itself;
 * for a lead, which writes nothing (one session), the studio sets it aside on a ref of the run
 * (lead-session.ts `setAsideStrays`) — so a game that builds in place never stops its merges.
 */
async function checkpointAssets(loopRun: LoopRun, label: string): Promise<MergeReadiness> {
  const { ctx, integrationWorktree, run } = loopRun;
  try {
    await ctx.call(HostMethod.AssetsCheckpoint, { project: run.project, runId: run.runId });
  } catch (error: any) {
    return { refusal: INTEGRATE_REFUSAL.checkpoint(error?.message ?? error), setAside: null };
  }
  if (loopRun.lead) return setAsideForLead(loopRun, label);
  const dirty = await gitAt(ctx, integrationWorktree, GIT.status, { label }).catch(() => "");
  return { refusal: dirty ? INTEGRATE_REFUSAL.dirty : null, setAside: null };
}

/** What no worker made in a lead's integration worktree, set aside — or why it could not be. */
async function setAsideForLead(loopRun: LoopRun, label: string): Promise<MergeReadiness> {
  try {
    return { refusal: null, setAside: await setAsideStrays(loopRun, label) };
  } catch (error: any) {
    return { refusal: LEAD_DIRTY(error?.message ?? error), setAside: null };
  }
}

/**
 * Merge the worker's commit into the integration worktree. A conflict on the FACET WIRING block
 * alone is union-merged; anything else is aborted and the conflicted files are named — for a
 * director to resolve by hand, or, when the lead writes nothing (one session), for a worker the
 * studio starts from the integration branch to resolve (conflict-worker.ts). On a clean merge the
 * new head is protected, journalled and put on the record.
 */
async function mergeWorker(
  loopRun: LoopRun,
  worker: Worker,
  commit: string,
  label: string,
): Promise<{ ok: true; union: boolean } | { ok: false; answer: string }> {
  const { appendRun, ctx, integrationWorktree, journal, note, ownShape, protectHead, run, shape, state } = loopRun;
  const previousHead = state.integrationHead;
  const merge = await mergeNoFf(ctx, integrationWorktree, commit, {
    message: `director ${run.runId}: integrate ${worker.id}`,
    noEdit: true,
    label,
    rpcErrors: "fail",
    failure: shortFailure,
    listConflicts: true,
    resolve: () =>
      unionMergeMain(
        (command) =>
          ctx.call(HostMethod.RunExec, {
            command,
            cwd: integrationWorktree,
            timeoutMs: GIT_TIMEOUT_MS.quick,
            label: `${label}:union`,
          }),
        {
          message: `director ${run.runId}: integrate ${worker.id} (union on FACET WIRING)`,
          main: shape.main,
          wiring: !ownShape,
        },
      ),
  });
  if (!merge.ok) {
    await appendRun(RunEvent.IntegrationMerge, {
      facetId: worker.id,
      commit,
      conflict: true,
      stage: MergeStage.Director,
      error: String(merge.error).slice(0, CLIP_REASON),
    });
    note(`integrate ${worker.id}: conflict in ${merge.conflicts.join(", ") || "unknown files"}`);
    if (loopRun.lead) return { ok: false, answer: await resolveByWorker(loopRun, worker, commit, merge.conflicts) };
    return {
      ok: false,
      answer: JSON.stringify({
        merged: false,
        conflict: merge.conflicts,
        how: `run \`git merge ${commit}\` in your worktree, resolve keeping both sides' work, then commit (\`git add -A\`, then \`git commit\`); then judge integration`,
      }),
    };
  }
  state.integrationHead = await headOf(ctx, integrationWorktree, { label });
  journal.director.integrationHead = state.integrationHead;
  markIntegrated(loopRun, worker);
  await protectHead(state.integrationHead);
  await appendRun(RunEvent.IntegrationMerge, {
    facetId: worker.id,
    commit,
    head: state.integrationHead,
    previousHead,
    operationId: randomUUID(),
    conflict: false,
    union: merge.union,
    stage: MergeStage.Director,
  });
  return { ok: true, union: merge.union };
}

/**
 * The health pass: does the integrated build run, on the requested state? The user's own game
 * may be a repository of its own inside the folder. When the studio was not allowed to version
 * it, this build carries none of the work done inside it — said on the health pass rather than
 * landing a build that silently contains nothing. The build runs; it is empty, and
 * only `git ls-tree` can see that (a gitlink is a path git does not walk). Answers the look, and
 * whether the build started at all.
 */
async function healthPass(
  loopRun: LoopRun,
  workers: readonly Worker[],
  label: string,
  previousHead: string | null,
): Promise<{ health: Evidence; started: boolean; lost: LostRegistration[] }> {
  const { nestedGit, nestedRepos, rememberEvidence, state } = loopRun;
  const head = state.integrationHead;
  const healthLabel = `health_${shortSha(head, LABEL_SHA_LENGTH)}`;
  const health = await lookAtIntegration(loopRun, {
    lease: WindowLease.Health,
    label: healthLabel,
    workers,
    demos: demosNamedBy(dependentsOf(state.facetSpecs)),
  });
  const started = health.ok === true;
  const unversioned = await unversionedNested((command) => nestedGit(command, label), nestedRepos);
  if (unversioned.length) {
    health.problems = [
      ...(health.problems ?? []),
      `${unversioned.map((rel) => `${rel}/`).join(", ")} is the user's own repository and this build carries nothing from inside it — no edit there can be integrated or made live`,
    ];
    health.ok = false;
  }
  const lost = lostByMerge(loopRun, health, workers, previousHead);
  if (lost.length) {
    health.problems = [...(health.problems ?? []), WAVE_WORDS.lost(lostWords(lost))];
    health.ok = false;
  }
  state.integrationHealthy = health.ok === true;
  // Kept with the setup it was taken under: the next merge compares state paths only with a look
  // like its own (lostByMerge).
  rememberEvidence(head, health, { setup: setupKey(loopRun.run.setup) });
  await recordHeadHealth(loopRun, head, healthLabel, health);
  return { health, started, lost };
}

/**
 * What the merge lost that a worker depends on: a camera, a demo or a probe the head before it
 * registered and the merged head does not (registry.ts). Only a build that runs is asked, and only
 * against a head this run has looked at; the cameras compared are the ones the page registered
 * (never the harness's own shots), and state paths only against a health pass under the same
 * setup. A single worker that drops its own registration is its own business; in a wave, one
 * merged worker can break another, so every worker's checks count.
 */
function lostByMerge(
  loopRun: LoopRun,
  health: Evidence,
  workers: readonly Worker[],
  previousHead: string | null,
): LostRegistration[] {
  const { run, state } = loopRun;
  const before = state.evidenceByHead.get(previousHead);
  if (health.ok !== true || !before) return [];
  const alike = before.setup === setupKey(run.setup);
  const merged = workers.length === 1 ? workers.map((worker) => worker.id) : [];
  return lostRegistrations({
    before: {
      cameras: before.registeredCameras ?? null,
      demos: before.demos,
      state: alike ? before.state : null,
      demoStates: alike ? before.demoStates : null,
    },
    after: lookOf(health),
    dependents: dependentsOf(state.facetSpecs, merged),
  });
}

/**
 * The health pass on the record, next to the merge: does the merged build run? The studio offers
 * the user a build to look at mid-run only once something has confirmed that it does.
 */
async function recordHealth(
  loopRun: LoopRun,
  workers: readonly Worker[],
  { health, started, lost }: { health: Evidence; started: boolean; lost: readonly LostRegistration[] },
): Promise<void> {
  const { appendRun, decision, note, recordVerdict, saveJournal, state } = loopRun;
  const head = state.integrationHead;
  const problems = (health.problems ?? []).join("; ");
  const last = workers.at(-1) as Worker;
  await appendRun(RunEvent.IntegrationHealth, {
    head,
    ok: health.ok === true,
    problems: (health.problems ?? []).slice(0, HEALTH_CARD_PROBLEMS),
  });
  await recordVerdict({
    pass: VerdictPass.Health,
    head,
    worker: last.id,
    ...observedFrom(health),
    // The same errors the look forgave: every merged worker's fork point's.
    consoleInherited: inheritedByAll(loopRun, workers),
    kept: health.ok === true,
    rule: health.ok === true ? VerdictRule.Starts : VerdictRule.DoesNotStart,
  });
  await saveJournal();
  const ids = workers.map((worker) => worker.id).join(", ");
  note(`integrated ${ids} → ${shortSha(head)}; health ${health.ok ? "ok" : `problems: ${problems}`}`);
  if (health.ok) return;
  await decision(
    `the integrated build ${shortSha(head)} did not pass its health pass: ${problems} — the director must fix it or judge it before it can land`,
    unhealthyPlain(started, lost),
  );
}

/** The user's sentence for a merge that failed its health pass: lost a registration, carries nothing, or does not start. */
function unhealthyPlain(started: boolean, lost: readonly LostRegistration[]): string {
  if (lost.length) return WAVE_WORDS.lostPlain;
  return started
    ? "the merged build carries nothing from the folder inside your game that keeps its own history; what was built there cannot be made live"
    : "the merged build did not start when it was checked; the lead is fixing it before it can go live";
}

/** What a build that does not run after a merge asks of the lead: its own repair, or a worker's (one session). */
function fixNext(loopRun: LoopRun): string {
  if (loopRun.lead) return LEAD_FIX_NEXT;
  return "the integrated build does not run — fix it in your worktree (git log shows what came in) before anything else";
}

/**
 * A worker whose kept work is now on the integration branch — and, for a conflict worker, the
 * worker whose work it merged — counts in the first wave the art director waits for (art-direction.ts).
 */
function markIntegrated(loopRun: LoopRun, worker: Worker): void {
  worker.integrated = true;
  const merged = worker.merging?.of ? loopRun.state.workers.get(worker.merging.of) : undefined;
  if (merged) merged.integrated = true;
}

/** What a merge asks of the lead next: look before building on it, put back what it lost, or repair it. */
function nextAfterMerge(loopRun: LoopRun, health: Evidence, lost: readonly LostRegistration[]): string {
  if (health.ok) return "judge or look at integration before you build on it";
  const repair = lost.length ? WAVE_WORDS.lostNext : fixNext(loopRun);
  // Running workers follow the last wave's head: a repair committed by hand reaches them when a wave closes.
  return loopRun.state.waveHead ? `${repair}${WAVE_WORDS.thenClose}` : repair;
}

/**
 * What `integrate` answers after a clean merge: the new head, its health, what was set aside, and
 * what to do next. `extra` (a wave's ids, what it lost) closes the answer; a single worker's merge
 * that lost nothing has none, and answers as it always did.
 */
function integrationAnswer(
  loopRun: LoopRun,
  health: Evidence,
  union: boolean,
  setAside: SetAside | null,
  { lost = [], extra = {} }: { lost?: readonly LostRegistration[]; extra?: AnyRecord } = {},
): string {
  const { ledgerLines, shotsOf, state } = loopRun;
  return JSON.stringify({
    merged: true,
    union,
    ...(setAside ? { setAside: LEAD_SET_ASIDE(setAside.ref, setAside.files) } : {}),
    head: shortSha(state.integrationHead),
    health: {
      ok: health.ok === true,
      problems: health.problems ?? [],
      warnings: health.warnings ?? [],
      requestedState: health.requestedState ?? null,
      shots: shotsOf(health),
    },
    // Defects a judge named for a worker that had already finished: nobody is building them,
    // so the integrated build is where they get fixed — by you, or by a new worker.
    ...(state.ledger.length ? { defectsNobodyOwns: ledgerLines() } : {}),
    next: nextAfterMerge(loopRun, health, lost),
    ...(lost.length ? { lost } : {}),
    ...extra,
  });
}

/** A healthy merge closes the wave: running loop workers take this head at their next round. */
function closeWaveIfHealthy(loopRun: LoopRun, health: Evidence): void {
  const { state } = loopRun;
  if (health.ok === true) state.waveHead = state.integrationHead;
}

/** `integrate wave=close`: running loop workers take the integration head as it stands now. */
async function closeWave(loopRun: LoopRun): Promise<string> {
  const { note, saveJournal, state } = loopRun;
  const head = state.integrationHead;
  state.waveHead = head;
  await saveJournal();
  if (head) note(WAVE_WORDS.closed(head));
  return JSON.stringify({
    wave: "closed",
    head: head ? shortSha(head) : null,
    health: WAVE_WORDS.health(state.healthByHead.get(head)),
  });
}

/** An answer with fields added: into its JSON when it is an object, else said after it. */
function withFields(answer: string, fields: AnyRecord): string {
  try {
    const parsed = JSON.parse(answer);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return JSON.stringify({ ...parsed, ...fields });
  } catch {
    // a sentence, not JSON
  }
  return JSON.stringify({ answer, ...fields });
}

/** One worker of a wave, merged — or why it was left out of the wave. */
async function takeIntoWave(
  loopRun: LoopRun,
  id: string,
  label: string,
): Promise<{ skipped: string } | { worker: Worker; merged: Awaited<ReturnType<typeof mergeWorker>> }> {
  const worker = loopRun.state.workers.get(slug(id));
  if (!worker) return { skipped: INTEGRATE_REFUSAL.noWorker(id) };
  const unresolved = unresolvedOf(worker);
  if (unresolved) return { skipped: unresolved };
  const resolved = await resolveWorkerCommit(loopRun, worker);
  if (resolved.refusal !== undefined) return { skipped: resolved.refusal };
  return { worker, merged: await mergeWorker(loopRun, worker, resolved.commit, `${label}:${worker.id}`) };
}

/**
 * A wave (`integrate worker=a,b,c`): each worker merged in order — one `integration_merge` each —
 * then ONE health pass over what they make together. The first conflict stops the wave where it is
 * and goes where a single worker's would; a worker with nothing to merge is left out and named.
 */
async function integrateWave(loopRun: LoopRun, ids: readonly string[]): Promise<string> {
  const { run, state } = loopRun;
  const label = `director:${run.runId}:integrate:wave`;
  const ready = await checkpointAssets(loopRun, label);
  if (ready.refusal) return ready.refusal;
  const previousHead = state.integrationHead;
  const merged: Worker[] = [];
  const skipped: Record<string, string> = {};
  let union = false;
  for (const [at, id] of ids.entries()) {
    const taken = await takeIntoWave(loopRun, id, label);
    if ("skipped" in taken) skipped[id] = taken.skipped;
    else if (!taken.merged.ok) {
      // What merged before the conflict is on the branch, and nobody has looked at it yet.
      if (merged.length) state.integrationHealthy = null;
      const wave = { merged: merged.map((worker) => worker.id), notTried: ids.slice(at + 1), skipped };
      return withFields(taken.merged.answer, { wave });
    } else {
      merged.push(taken.worker);
      union = union || taken.merged.union;
    }
  }
  if (!merged.length) return JSON.stringify({ merged: false, skipped });
  const pass = await healthPass(loopRun, merged, label, previousHead);
  closeWaveIfHealthy(loopRun, pass.health);
  await recordHealth(loopRun, merged, pass);
  const wave = { merged: merged.map((worker) => worker.id), ...(Object.keys(skipped).length ? { skipped } : {}) };
  return integrationAnswer(loopRun, pass.health, union, ready.setAside, { lost: pass.lost, extra: { wave } });
}

/** One worker's merge and its health pass: the answer `integrate` has always given. */
async function integrateOne(loopRun: LoopRun, args: AnyRecord): Promise<string> {
  const { run, state } = loopRun;
  const worker = state.workers.get(slug(args.worker));
  if (!worker) return INTEGRATE_REFUSAL.noWorker(args.worker);
  const label = `director:${run.runId}:integrate:${worker.id}`;
  // A conflict worker that left markers has nothing to merge, whatever its worktree's HEAD says.
  const unresolved = unresolvedOf(worker);
  if (unresolved) return unresolved;
  const resolved = await resolveWorkerCommit(loopRun, worker);
  if (resolved.refusal !== undefined) return resolved.refusal;
  const ready = await checkpointAssets(loopRun, label);
  if (ready.refusal) return ready.refusal;
  const previousHead = state.integrationHead;
  const merged = await mergeWorker(loopRun, worker, resolved.commit, label);
  if (!merged.ok) return merged.answer;
  const pass = await healthPass(loopRun, [worker], label, previousHead);
  closeWaveIfHealthy(loopRun, pass.health);
  await recordHealth(loopRun, [worker], pass);
  return integrationAnswer(loopRun, pass.health, merged.union, ready.setAside, { lost: pass.lost });
}

/**
 * `integrate`: one worker's accepted commit, or a wave of them (`worker=a,b,c`), merged into the
 * integration branch with one health pass. A healthy integrate closes the wave — running loop
 * workers take the integration branch once per wave, not after every commit — and `wave=close`
 * closes it by hand, after the lead's own commits (with or without workers to merge first).
 */
export async function integrate(loopRun: LoopRun, args: AnyRecord) {
  const closing =
    String(args.wave ?? "")
      .trim()
      .toLowerCase() === WaveArg.Close;
  const named = list(args.worker);
  // A worker named twice is merged once, where it was first named.
  const ids = named.filter((id, at) => named.findIndex((other) => slug(other) === slug(id)) === at);
  if (!ids.length) return closing ? closeWave(loopRun) : INTEGRATE_REFUSAL.noneNamed;
  const one = named.length === 1 ? args : { ...args, worker: ids[0] };
  const answer = ids.length > 1 ? await integrateWave(loopRun, ids) : await integrateOne(loopRun, one);
  if (!closing) return answer;
  return withFields(answer, { waveClosed: JSON.parse(await closeWave(loopRun)) });
}

// ── the close ──

/** Did a judge see `head` load? Such a judge passed it, whatever a later look races into. */
function judgeSawItLoad(judged: LastJudge | null, head: string | null): boolean {
  return Boolean(judged && judged.head === head && judged.ok);
}

/**
 * The close's judge of the build it is about to make live (tools.ts `judgeTheLanding`, beside the
 * judging it shares). A kept older tools.ts has none, and would ignore the bounds this judge needs,
 * so that close lands as it always did and says it did not judge.
 */
async function judgeForTheClose(loopRun: LoopRun, head: string | null): Promise<void> {
  const { judgeTheLanding, note } = loopRun;
  if (typeof judgeTheLanding === "function") return judgeTheLanding(head);
  note(`the close did not judge ${shortSha(head)}: this workspace keeps an older tools.ts without the close's judge`);
}

/**
 * The close's own look at the head the worktree stands on, its judge of that head, and the landing
 * they earn. The judge's word counts only for the head it looked at — the same sha this close
 * observed. On a resume it may be last session's, kept in the journal.
 */
async function landWhatRuns(loopRun: LoopRun): Promise<AnyRecord> {
  const { baseCommit, ctx, decision, integrationRef, landIntegration, state, syncHead } = loopRun;
  // Whatever the director committed last is the build this close is about — not the head
  // the last integrate happened to leave behind.
  const last = await syncHead();
  // The starting point alone is not a run's work: a run that only got its base built has
  // nothing beyond the starting point, and says so instead of landing an empty world. The
  // comparison is with the run's ORIGINAL base: a resumed session forks from last run's
  // head, and measuring against that hid every merge the first session had made. The module
  // contract written on the start alone is a document, not a build (contract-gate.ts).
  const atStart = !last || last === baseCommit || state.baseHeads.has(last) || contractAloneOnStart(loopRun, last);
  if (atStart) return notLanded(NOTHING_BEYOND_THE_START, NotLandedReason.NothingNew);
  // A director's own uncommitted edits become a commit before anybody looks, so the build the
  // close looks at and judges is the very commit it lands.
  const uncommitted = await commitFinalEdits(loopRun);
  if (uncommitted) return uncommitted;
  const head = await syncHead();
  const label = `close_${shortSha(head, LABEL_SHA_LENGTH)}`;
  const health = await lookAtIntegration(loopRun, {
    lease: WindowLease.Close,
    label,
    scaffold: state.baseHeads.has(head),
  });
  await recordHeadHealth(loopRun, head, label, health);
  const before = state.lastJudge;
  await judgeForTheClose(loopRun, head);
  // A Stop pressed while the close looked or judged is obeyed: nothing is made live.
  if (ctx.cancelled) return notLanded(STOPPED_BY_USER, NotLandedReason.Stopped);
  // A judge that saw this head load still speaks for it when the close's own judge raced the load.
  if (judgeSawItLoad(before, head) && !judgeSawItLoad(state.lastJudge, head)) state.lastJudge = before;
  // The judge's look may carry the landing, but what the landing claims is the close's own look.
  state.healthByHead.set(head, health.ok === true);
  const judged = judgeSawItLoad(state.lastJudge, head);
  if (health.ok === true || judged) return landIntegration(true);
  await decision(
    `the integration branch ${shortSha(head)} did not load at the close (${(health.problems ?? []).join("; ")}) and no judge had passed it — kept unlanded on ${integrationRef}`,
    "this build did not start when it was checked at the end, so it was not made live — you can still open and play it",
  );
  return notLanded(
    "the integrated build did not load at the close and no judge had passed it",
    NotLandedReason.DoesNotRun,
  );
}

/**
 * ONE close (M4.10). Both roads out of a run end here — the director's own `finish` and the
 * harness's clock path — and they end the same way: stop the workers, wait for them, look at
 * the head the worktree actually stands on, and land under one rule.
 *
 * THE RULE: the branch moved beyond the starting point AND (it loaded just now OR a judge
 * passed it on this same sha). Before that rule is read the close judges the head itself
 * (tools.ts `judgeTheLanding`), so no build is made live that no judge looked at, however the run
 * ended; a Stop before or during the close lands nothing. `finish land=yes` used to skip the
 * fresh look entirely and land whatever HEAD happened to be — so a director could hand the user
 * a build that does not start, while the tool's own description has always promised "when it is
 * healthy". The clock path already looked; now they are the same code and there is one thing to
 * be right about.
 *
 * `because` is a function of the landing, but the ladder it reads is computed by the CALLER
 * and closed over: everything this close knows about why the run ended is known before it
 * starts, and a `Date.now()` read after a 90-second settle would have told a different story.
 */
export async function closeTheLoopRun(
  loopRun: LoopRun,
  {
    land = true,
    stopWhy = "the build is over",
    settleMs = CLOSE_SETTLE_MS,
    because = null,
    summary = null,
    victory = false,
    paused = false,
  }: {
    land?: boolean;
    stopWhy?: string;
    settleMs?: number;
    because?: string | ((landed: AnyRecord) => string) | null;
    summary?: string | null;
    victory?: boolean;
    /** A lost provider paused the run: it lands nothing, and says so. */
    paused?: boolean;
  },
): Promise<AnyRecord> {
  const { closeRun, ctx, report, runningWorkers, settleWorkers, stopWorker } = loopRun;
  for (const worker of runningWorkers()) await stopWorker(worker, stopWhy, "finalization");
  await settleWorkers(settleMs);
  let landed: AnyRecord;
  if (ctx.cancelled) landed = notLanded(STOPPED_BY_USER, NotLandedReason.Stopped);
  else if (paused) landed = notLanded(PAUSED_UNLANDED, NotLandedReason.Paused);
  else if (!land) landed = notLanded("land=no", NotLandedReason.NotAsked);
  else landed = await landWhatRuns(loopRun);
  report.victory = victory === true && landed.ok === true;
  if (summary !== null) report.summary = summary;
  // A Stop is the run's reason whoever was closing it: the chat marks a stopped run by these words.
  if (landed.why === NotLandedReason.Stopped) report.stoppedBecause = STOPPED_BY_USER;
  else if (typeof because === "function") report.stoppedBecause = because(landed);
  else if (because) report.stoppedBecause = because;
  await closeRun(landed);
  return landed;
}

/** The art director's last look at the head the close stood on, when the run has the art director. */
function shipOnHead(loopRun: LoopRun): LastShip | null {
  return typeof loopRun.shipReviewOn === "function" ? loopRun.shipReviewOn(loopRun.state.integrationHead) : null;
}

/** What `finish` tells the director once the run is closed. */
function finishAnswer(loopRun: LoopRun, landed: AnyRecord): string {
  const { state } = loopRun;
  // Whether the art director would ship the head the close stood on: reported, never a veto.
  const ship = shipFinishLine(shipOnHead(loopRun));
  const end = "End your session now with a one-paragraph summary for the user";
  // The close judged the build after the lead's summary was written: what the landing may claim
  // is the lead's to pass on, and no more.
  const left = landed.leftInGame
    ? ` — ${LANDING_WORDS.leftInGame(landed.leftInGame)} — tell the user, and leave them as they are`
    : "";
  if (landed.ok)
    return `the run is closed — the integrated build ${shortSha(state.integrationHead)} is live in the game folder (${landed.line})${left}. ${end}; say what the landing may claim, in brackets above, and claim no more.${ship}`;
  const outcome = landed.reason ? ` — not landed: ${landed.reason}` : "";
  return `the run is closed${outcome}. ${end}.${ship}`;
}

/**
 * Did the user write `quote` in a message delivered into this run? The lead reads what they meant;
 * this only checks the words are theirs, as `plan`'s scope_instruction is checked (goals.ts).
 */
async function userQuoted(inbox: LoopRun["inbox"], quote: unknown): Promise<boolean> {
  const words = typeof quote === "string" ? quote.trim() : "";
  if (words.length < MIN_USER_QUOTE_CHARS) return false;
  const said = await inbox.steering(undefined, false);
  return said.some((text) => text.includes(words));
}

/**
 * Close the run with the lead's summary. A timed build spends its working time: only the user ends
 * it early — Finish, or their own words in a message to this run, which the lead quotes as
 * `user_asked` (golden-boot-glory: "don't run the build" was refused for 159 minutes).
 */
export async function finish(loopRun: LoopRun, args: AnyRecord) {
  const { closeTheLoopRun, ctx, inbox, run, softDeadline, state } = loopRun;
  if (state.finish) return "finish is already under way";
  const summary = String(args.summary ?? "").trim();
  if (!summary) return "finish needs a summary for the user";
  const userEnds = (await inbox.finishing()) || (await userQuoted(inbox, args.user_asked));
  if (!ctx.cancelled && timedWorkRemaining(run, softDeadline, Date.now(), userEnds)) {
    return `finish refused: ${minutes(softDeadline - Date.now())} working minutes remain in this timed build. Call run_status, plan and delegate the next concrete improvement, then test and integrate it. Keep working until the wrap-up window; do not idle or repeat finish. Only the user ends it early: when they asked you in a message to stop or finish now, call finish again with user_asked quoting their words exactly.`;
  }
  const land = yes(args.land, true);
  const victory = yes(args.victory, false);
  if (victory && state.goals && goalDecision(state.goals, state.integrationHead) !== GoalStatus.Passed) {
    return "finish cannot claim victory: required acceptance is not verified on the integrated revision. Run playtest goal=<id>, or finish with victory=no and explain the gaps.";
  }
  // A goal build's finish with no ship review on its head: the art director looks once first.
  const shipRefusal =
    land && typeof loopRun.shipFinishGate === "function" ? await loopRun.shipFinishGate(userEnds) : null;
  if (shipRefusal) return shipRefusal;
  state.finish = { summary, land, victory, at: Date.now() };
  ctx.setStatus(`run ${run.runId} · director finishing`);
  const landed = await closeTheLoopRun({
    land,
    stopWhy: "the build is wrapping up",
    because: "the director finished the run",
    summary,
    victory,
  });
  return finishAnswer(loopRun, landed);
}

/** What this run can honestly claim about the head it landed (`landingWords`, above). */
export function landingClaim(
  loopRun: LoopRun,
  head: string | null | undefined,
): { verified: boolean; how: LandingHow; line: string } {
  const { state } = loopRun;
  return landingWords({
    judged: state.lastJudge && state.lastJudge.head === head ? state.lastJudge : null,
    healthPassed: state.healthByHead.get(head) === true,
  });
}

/**
 * A repository of the user's own inside the game folder, which the fork holds as files (the
 * consent the Open Game sheet recorded) while the folder itself still holds it as a pointer.
 * Landing that is not a merge — the folder's own `.git` is renamed aside and the fork's
 * conversion commit joined as a second parent (`versionNestedForLanding`) — and it is the one
 * place the studio touches somebody else's version history, so it belongs to the user's own
 * button, not to the run. Git would refuse it here anyway, over
 * files it is not tracking; this says why in words the user can act on.
 */
async function nestedRefusal(loopRun: LoopRun): Promise<AnyRecord | null> {
  const { ctx, nestedGit, projectDir } = loopRun;
  const pointers = await gitlinks(ctx, projectDir, "HEAD", { timeoutMs: GIT_TIMEOUT_MS.slow });
  if (!pointers.length) return null;
  const stillPointers = await unversionedNested((command) => nestedGit(command), pointers);
  const carried = pointers.filter((rel) => !stillPointers.includes(rel));
  if (!carried.length) return null;
  return notLanded(
    `${carried.map((rel) => `${rel}/`).join(", ")} is the user's own repository inside the game folder and this build holds it as ordinary files — the studio may not add it to the game's own history from here; the user can make this build live from the outcome card`,
    NotLandedReason.NestedNotVersioned,
  );
}

/**
 * The director's own last edits, committed for it — uncommitted work would be lost with the
 * worktree. A commit that fails lands nothing: the head without those edits is not the build
 * the director finished. Answers the refusal, or null once the head holds everything.
 */
async function commitFinalEdits(loopRun: LoopRun): Promise<AnyRecord | null> {
  const { ctx, integrationWorktree, protectHead, run, state } = loopRun;
  const dirty = await gitAt(ctx, integrationWorktree, GIT.status).catch(() => "");
  if (!dirty) return null;
  const commitError = await commitAll(ctx, integrationWorktree, `director ${run.runId}: final edits`, {
    label: `director:${run.runId}:final-commit`,
  }).then(
    () => null,
    (err) => String(err?.message ?? err),
  );
  if (commitError !== null)
    return notLanded(
      `the director's last edits could not be committed: ${commitError.slice(0, CLIP_DETAIL)}`,
      NotLandedReason.FinalCommitFailed,
    );
  state.integrationHead = await headOf(ctx, integrationWorktree).catch(() => state.integrationHead);
  await protectHead(state.integrationHead);
  return null;
}

/** The item a merge under way in the game folder is named by among its uncommitted paths. */
const MERGE_UNDER_WAY = "a merge under way";

/**
 * What is uncommitted in the game folder as the landing meets it (`git status --porcelain`): each
 * path, and whether the folder is held — something staged or unmerged, or a merge of its own under
 * way even with nothing to show (`MERGE_HEAD`). Git merges into no held folder, and a failed
 * merge's `--abort` would undo that merge. A folder git cannot read answers nothing.
 */
async function gameFolderChanges(loopRun: LoopRun): Promise<{ paths: string[]; held: boolean }> {
  const { ctx, run } = loopRun;
  const label = `director:${run.runId}:land-status`;
  const at = { project: run.project };
  const status = await gitAt(ctx, at, GIT.status, { label }).catch(() => "");
  const lines = status.split("\n").filter((line) => line.trim());
  const paths = lines.map(changedPath);
  let merging = false;
  try {
    merging = (await gitAt(ctx, at, GIT.catFileExists("MERGE_HEAD", ""), { label })).trim() === "yes";
  } catch {}
  return {
    paths: merging ? [MERGE_UNDER_WAY, ...paths] : paths,
    held: merging || lines.some((line) => line[0] !== " " && line[0] !== "?"),
  };
}

/**
 * Land the integrated build in the game folder: one `--no-ff` merge, aborted on a conflict, and
 * never forced. This used to answer a conflict with `git reset --hard` onto the run's head — the
 * run overwriting commits nobody asked it to touch. Now the build stays on its ref, the close
 * says why, and "Make it live" lands it once the folder can take it (studio-core `landBuild`, which
 * refuses a folder with uncommitted changes). Those changes may be the user's or a lead's own
 * commands' (it runs in the game folder), so they are named, never blamed on anyone — only when
 * git's refusal names them: a hook or a held lock is not theirs to answer for. A held folder
 * (`gameFolderChanges`) is not merged into at all.
 */
export async function landIntegration(loopRun: LoopRun, land: boolean): Promise<AnyRecord> {
  const { baseCommit, ctx, integrationRef, landingClaim, note, projectDir, report, run, state, syncHead } = loopRun;
  if (!land) return notLanded("land=no", NotLandedReason.NotAsked);
  await syncHead();
  if (!isCommit(state.integrationHead) || state.integrationHead === baseCommit)
    return notLanded(NOTHING_BEYOND_THE_START, NotLandedReason.NothingNew);
  const nested = await nestedRefusal(loopRun);
  if (nested) return nested;
  const uncommitted = await commitFinalEdits(loopRun);
  if (uncommitted) return uncommitted;
  const changed = await gameFolderChanges(loopRun);
  if (changed.held)
    return notLanded(LANDING_WORDS.uncommitted(changed.paths, integrationRef), NotLandedReason.UncommittedChanges);
  const merge = await mergeNoFf(ctx, { project: run.project }, state.integrationHead, {
    message: `director ${run.runId}: integrated build`,
    label: `director:${run.runId}:land`,
    listConflicts: true,
  });
  if (!merge.ok) {
    // Git refused to write over uncommitted changes, or the build conflicts with commits made in
    // the folder since the run began (the merge was aborted: its conflicts were listed first).
    if (!merge.conflicts.length && refusedOver(changed.paths, merge.error))
      return notLanded(LANDING_WORDS.uncommitted(changed.paths, integrationRef), NotLandedReason.UncommittedChanges);
    return notLanded(
      `merge into the live folder conflicted with changes of your own: ${unbracketed(merge.error.slice(0, CLIP_DETAIL))}`,
      NotLandedReason.CouldNotLand,
    );
  }
  report.landed = true;
  report.deliveredHead = await headOf(ctx, projectDir).catch(() => null);
  report.integrationHead = state.integrationHead;
  await ctx.call(HostMethod.PreviewLoad, { project: run.project }).catch(() => {});
  if (changed.paths.length) note(LANDING_WORDS.leftInGame(changed.paths));
  return {
    ok: true,
    ...landingClaim(state.integrationHead),
    ...(changed.paths.length ? { leftInGame: changed.paths } : {}),
  };
}

/**
 * What the game keeps from this run: the lessons file the next run's briefs read, and the
 * check catalogue weighted by what could actually be measured. The catalogue side is what the
 * classic pipeline has always done at its close and the director never did — the lead's own
 * checks, with their thresholds, become reusable — plus the `rarelyMeasurable` flag, which is
 * how a check that has told nobody anything for three rounds stops being written again.
 */
export async function keepGameLessons(loopRun: LoopRun) {
  const { ctx, priorLedger, run, state, runLedger } = loopRun;
  const records = await trimLedger(
    ctx.workspace,
    run.project,
    await readLedger(ctx.workspace, run.project).catch(() => []),
  ).catch(() => []);
  const all = records.length ? records : [...priorLedger, ...runLedger];
  await saveGameLessons(ctx.workspace, run.project, all).catch(() => {});
  const catalogue = await loadCatalogue(ctx.workspace).catch(() => null);
  if (!catalogue) return;
  for (const worker of state.workers.values()) {
    if (worker.spec && worker.result?.board)
      recordCatalogueOutcomes(catalogue, worker.spec, worker.result.board, CheckOrigin.Director, {
        runId: run.runId,
        genres: run.genres ?? [],
        kind: run.game?.kind ?? null,
      });
  }
  flagRarelyMeasurable(catalogue, all);
  await saveCatalogue(ctx.workspace, catalogue).catch(() => {});
}

/**
 * One line the morning card can read: what happened to the build, and whether anybody judged
 * it better than what the user had. "It loaded" is not "it is better".
 */
function landingResult(landed: AnyRecord): AnyRecord {
  const line = landed.line ?? (landed.ok ? "made live, not judged better" : "nothing was made live");
  return { ...landed, verified: landed.verified === true, how: landed.how ?? LandingHow.NotLanded, line };
}

/**
 * The run as one outcome, and then what the game's whole ledger now amounts to. This runs on
 * every close — finish, the clock, a limit, a quit, a crash — and never asks a model: writing
 * down what happened is a record, not a self-change, so no switch gates it. The sentence is the
 * close verdict's, which says *why* nothing was made live rather than repeating that nothing was.
 * What the next run learns from it is kept only while the user lets Studio improve itself.
 */
async function keepTheRecord(loopRun: LoopRun, landed: AnyRecord, because: string): Promise<void> {
  const { ctx, keepGameLessons, ledgerFacts, remember, report, runLedger } = loopRun;
  await remember(closeRecord({ ...ledgerFacts(), landed: landed.ok === true, because }));
  await loopRun.ledgerWrites;
  if (await learningOn(ctx)) {
    report.learned = learnedThisRun(runLedger);
    await keepGameLessons();
  }
}

/** How a close describes the run: failed, paused (a resume picks it up) or completed. */
function executionStatusOf(report: AnyRecord, phase: string): ExecutionStatus {
  if (report.failure) return ExecutionStatus.Failed;
  if (phase === JournalPhase.Paused) return ExecutionStatus.Paused;
  return ExecutionStatus.Completed;
}

/** The close on the run's thread (`run_finished`, and `autopilot_paused` for a pause) and in its folder. */
async function announceClose(loopRun: LoopRun): Promise<void> {
  const { ctx, journal, report, run, threadId } = loopRun;
  const paused = journal.phase === JournalPhase.Paused;
  await appendClose(ctx, threadId, [
    { type: EventKind.Custom, event_type: RunEvent.RunFinished, payload: report },
    ...(paused
      ? [
          {
            type: EventKind.Custom,
            event_type: RunEvent.AutopilotPaused,
            payload: { runId: run.runId, project: run.project },
          },
        ]
      : []),
  ]).catch(() => {});
  await writeRunArtifact(ctx, run.runId, "report.json", report);
}

/**
 * A run's close, written to its thread — tried again when the log refuses it: a `run_finished`
 * that is never written leaves the run running for good, with nothing to Resume.
 * Throws the last refusal.
 */
export async function appendClose(ctx: HarnessCtx, threadId: string, batch: EventData[]): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await ctx.call(HostMethod.EventsAppend, { threadId, batch });
      return;
    } catch (err) {
      if (attempt >= CLOSE_APPEND_ATTEMPTS) throw err;
      await sleep(CLOSE_APPEND_RETRY_MS);
    }
  }
}

/** The provider loss (an engine limit, a lost sign-in, an outage) that paused the run, as its close reports it. */
function reportedLimit(limit: AnyRecord): AnyRecord {
  return {
    kind: limit.kind,
    message: String(limit.message ?? "").slice(0, CLIP_REASON),
    retryAfterMs: limit.retryAfterMs ?? null,
    // When it was hit: the host's auto-resume counts the reset from here, not from the close.
    ...(typeof limit.at === "number" ? { at: limit.at } : {}),
  };
}

export async function closeRun(loopRun: LoopRun, landed: AnyRecord): Promise<void> {
  const { baseCommit, ctx, integrationRef, journal, keepMemory, protectHead, recordVerdict, report, run, saveJournal } =
    loopRun;
  const { state, threadId } = loopRun;
  if (state.finished) return;
  state.finished = true;
  // The worktree goes in the teardown below; the memory file in it does not go with it.
  await keepMemory();
  report.integrationHead = state.integrationHead;
  report.baseCommit = baseCommit;
  report.integrationRef = integrationRef;
  // A resumed or reopened run adds to the record its earlier sessions closed with (setup.ts `loopRunReport`).
  const workers = Object.fromEntries([...state.workers.values()].map((w) => [w.id, workerDigest(w)]));
  report.workers = { ...report.workers, ...workers };
  report.notes = [...report.notes, ...(journal.director.notes ?? [])];
  report.landingResult = landingResult(landed);
  // Whether the art director would ship the head this close stands on: reported, never a veto.
  const shipReview = typeof loopRun.shipReport === "function" ? loopRun.shipReport() : null;
  if (shipReview) report.shipReview = shipReview;
  // The run's last verdict, in the same shape as every other: what became of the build, and
  // whether anybody preferred it. Emitted here rather than at each caller so a close by finish,
  // by the clock, by a limit, by a quit or by a crash all leave one.
  const closeVerdict = await recordVerdict({
    pass: VerdictPass.Close,
    head: state.integrationHead,
    against: landed.verified ? againstWords(BuildTarget.Live) : null,
    ok: state.healthByHead.get(state.integrationHead) ?? null,
    pick: landed.verified ? Side.Challenger : null,
    kept: landed.ok === true,
    rule: landed.ok ? VerdictRule.Landed : VerdictRule.NotLanded,
    landingLine: report.landingResult.line,
    notLanded: landed.why ?? null,
  });
  await keepTheRecord(loopRun, landed, closeVerdict.because);
  if (state.limit) report.limit = reportedLimit(state.limit);
  report.optimization = await skipOptimization(ctx, {
    threadId,
    run,
    reason: "Director runs finish without the optimization stage",
  }).catch(() => null);
  report.finishedAt = new Date().toISOString();
  // A run the user stopped, or one a lost provider cut short (a limit, a sign-in, an outage), is
  // paused: Resume picks it up at its integration head (kept reachable by the ref) once the user,
  // the limit or the provider allows.
  const pausedByStopOrLimit = !state.finish && (ctx.cancelled || Boolean(state.limit));
  const goalsBlocked = state.goals && goalDecision(state.goals, state.integrationHead) === GoalStatus.Blocked;
  journal.phase = pausedByStopOrLimit || goalsBlocked ? JournalPhase.Paused : JournalPhase.Done;
  report.executionStatus = executionStatusOf(report, journal.phase);
  journal.director.integrationHead = state.integrationHead;
  await protectHead(state.integrationHead);
  await saveJournal();
  await announceClose(loopRun);
}
