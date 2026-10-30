/**
 * A web game's Loop: the health check of its integration branch (after a worker's work is merged in,
 * and before it lands), the lead's `finish`, and the one close every road out of a run takes — the
 * lead's finish and the harness's clock — which lands the branch in the game folder when it passes
 * its health check, and writes the report.
 */
import { commitAll, GIT, gitAt, gitlinks, headOf, mergeNoFf, shortSha, unversionedNested } from "../git.ts";
import { checkHealth, type HealthCheck, healthLine } from "../health-check.ts";
import { HostMethod } from "../host-methods.ts";
import { EventKind, ExecutionStatus, JournalPhase, RunEvent, writeRunArtifact } from "../run-events.ts";
import { isCommit } from "../shell.ts";
import { CLIP_DETAIL, CLIP_REASON } from "../text.ts";
import { GIT_TIMEOUT_MS } from "../config.ts";
import { SECOND_MS, sleep } from "../time.ts";
import { NotLandedReason, VerdictPass, VerdictRule } from "../verdict.ts";
import { closeRunPool } from "../workers/run-pool.ts";
import { StopWhy } from "../finish-contract.ts";
import { yes } from "./args.ts";
import { closeUnderWay, holdFinish, latchClose, releaseFinish } from "./close-latch.ts";
import { LandingHow, landingWords } from "./rules.ts";
import { userQuoted } from "./wrap-up.ts";
import type { LoopRun } from "./loop-run.ts";
import type { AnyRecord, HarnessCtx } from "../../types/harness.d.ts";
import type { EventData } from "../../types/host-api.d.ts";

/** This part serves a lead that is its chat's own session (lead-session.ts `servesLead`). */
export const SERVES_LEAD = true;

/** How many of a health check's problems its card on the run's thread names. */
const HEALTH_CARD_PROBLEMS = 5;
/** Why a close the user stopped landed nothing: the words the chat reads a stopped run by. */
const STOPPED_BY_USER = "stopped by the user";
/** Tries at writing a run's close, and the wait between them: without it the run reads as running. */
const CLOSE_APPEND_ATTEMPTS = 3;
const CLOSE_APPEND_RETRY_MS = SECOND_MS;
/** At most this many paths are named in a sentence about them. */
const PATHS_NAMED = 8;
/** Why a run a lost provider paused lands nothing. */
const PAUSED_UNLANDED = "the run paused on its provider; nothing is made live that nobody could check";
/** The starting point is not a run's work: said when the branch has nothing beyond it. */
const NOTHING_BEYOND_THE_START = "the integration branch has nothing beyond the starting point";

/** What `finish` and the landing tell the lead. */
const FINISH_WORDS = {
  needsSummary: "finish needs a summary for the user",
  underWay: "finish is already under way",
  unhealthy: (check: HealthCheck) =>
    `Not finished: the build fails its health check, so it would not be made live. ${healthLine(check)} Fix it and call finish again — or call finish land=no to close without landing.`,
  closed: (head: string | null, line: string) =>
    `The Loop is closed — the integrated build ${shortSha(head ?? "")} is live in the game folder (${line}). End your turn with a one-paragraph summary for the user.`,
  closedUnlanded: (reason: string | null) =>
    `The Loop is closed${reason ? ` — not landed: ${reason}` : ""}. End your turn with a one-paragraph summary for the user.`,
  uncommitted: (paths: readonly string[], ref: string) =>
    `git would not land this build over what is uncommitted in the game folder — ${named(paths)}. Leave it as it is and tell the user: Make it live in Builds lands this build from ${ref} once that is kept or undone`,
  leftInGame: (paths: readonly string[]) =>
    `the game folder still has uncommitted changes the landing left as they were — ${named(paths)}; they are not part of this build`,
  conflict: (error: string) => `merge into the live folder conflicted with changes of your own: ${unbracketed(error)}`,
  nestedLost: (paths: readonly string[]) =>
    `${paths.map((rel) => `${rel}/`).join(", ")} is the user's own repository and this build carries nothing from inside it — no edit there can be integrated or made live; vendor its sources into the game (without .git), committed`,
  nestedCarried: (paths: readonly string[]) =>
    `${paths.map((rel) => `${rel}/`).join(", ")} is the user's own repository inside the game folder and this build holds it as ordinary files — the studio may not add it to the game's own history from here; the user can make this build live from the outcome card`,
  finalCommit: (error: string) => `the lead's last edits could not be committed: ${error}`,
  doesNotRun: (check: HealthCheck) =>
    `the integrated build failed its health check at the close (${check.problems.join("; ")})`,
} as const;

/** What a close that landed nothing says, and the code the verdict reads it by. */
function notLanded(reason: string, why: NotLandedReason): AnyRecord {
  return { ok: false, reason, why };
}

/** A file name or git's own words in a reason, with brackets for parentheses (the card strips a parenthesised clause). */
function unbracketed(text: unknown): string {
  return String(text).replaceAll("(", "[").replaceAll(")", "]").slice(0, CLIP_DETAIL);
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

/** Did git refuse the merge over these uncommitted paths (its refusal lists each file on a line of its own)? */
function refusedOver(paths: readonly string[], error: string): boolean {
  const listed = error.split("\n").map((line) => line.trim());
  return paths.some((changed) =>
    listed.some((file) => file === changed || (changed.endsWith("/") && file.startsWith(changed))),
  );
}

// ── the health check ──

/**
 * The lead's own uncommitted edits in the integration worktree, committed: the build a check looks
 * at, and the close lands, is the commit the worktree stands on. Answers why it could not, or null.
 */
async function commitLeadWork(loopRun: LoopRun): Promise<string | null> {
  const { ctx, integrationWorktree, run, state } = loopRun;
  const dirty = await gitAt(ctx, integrationWorktree, GIT.status).catch(() => "");
  if (!dirty) return null;
  const label = `director:${run.runId}:final-commit`;
  const error = await commitAll(ctx, integrationWorktree, `lead ${run.runId}: work so far`, { label }).then(
    () => null,
    (err) => String(err?.message ?? err).slice(0, CLIP_DETAIL),
  );
  if (error !== null) return error;
  state.integrationHead = await headOf(ctx, integrationWorktree).catch(() => state.integrationHead);
  await loopRun.protectHead(state.integrationHead);
  return null;
}

/**
 * The one health check of the integration head: the page loads, logs no uncaught error, and its
 * screenshot is not blank. On the run's record (`integration_health`, a verdict) and on the run.
 */
export async function checkIntegration(loopRun: LoopRun, label: string): Promise<HealthCheck> {
  const { ctx, integrationWorktree, run, state } = loopRun;
  await commitLeadWork(loopRun);
  const head = await loopRun.syncHead();
  const looked = await checkHealth(
    ctx,
    {
      project: run.project,
      root: integrationWorktree,
      runId: run.runId,
      label: `director/${label}_${shortSha(head ?? "")}`,
    },
    { sleep: loopRun.sleep },
  );
  const check = withNestedLoss(looked, await nestedLost(loopRun, label));
  state.healthByHead.set(head, check);
  state.integrationHealthy = check.ok;
  await loopRun.appendRun(RunEvent.IntegrationHealth, {
    head,
    ok: check.ok,
    problems: check.problems.slice(0, HEALTH_CARD_PROBLEMS),
  });
  await loopRun.recordVerdict({
    pass: VerdictPass.Health,
    head,
    kept: check.ok,
    rule: check.ok ? VerdictRule.Starts : VerdictRule.DoesNotStart,
  });
  await loopRun.saveJournal();
  return check;
}

/**
 * The user's own repositories inside the game folder that this head still holds as pointers: every
 * edit inside one is invisible to the merge, the landing and the user. git does not walk into a
 * gitlink path, so only this says so.
 */
async function nestedLost(loopRun: LoopRun, label: string): Promise<string[]> {
  const nested = loopRun.nestedRepos ?? [];
  if (!nested.length) return [];
  return unversionedNested((command) => loopRun.nestedGit(command, `director:${label}:nested`), nested);
}

/** A health check with the nested repositories the build carries nothing from added as a problem. */
function withNestedLoss(check: HealthCheck, lost: readonly string[]): HealthCheck {
  if (!lost.length) return check;
  return { ...check, ok: false, problems: [...check.problems, FINISH_WORDS.nestedLost(lost)] };
}

/** What the lead hears once a worker's copy is merged into the integration worktree: the merged build's health check. */
export async function afterMerge(loopRun: LoopRun, record: AnyRecord): Promise<string> {
  const check = await checkIntegration(loopRun, `merge_${String(record.id ?? "worker")}`);
  return healthLine(check);
}

// ── the finish ──

/**
 * Close the run with the lead's summary: the health check first, and a build that fails it is not
 * made live — the lead hears what is wrong and goes on, unless it closes without landing (`land=no`)
 * or the user asked to finish (the close then lands nothing that fails it). `victory=yes` is the
 * lead's word that the goal is reached; nobody else has to agree.
 */
export async function finish(loopRun: LoopRun, args: AnyRecord) {
  const { state } = loopRun;
  if (state.finish || closeUnderWay(state) || !holdFinish(state)) return FINISH_WORDS.underWay;
  try {
    return await finishHeld(loopRun, args);
  } finally {
    releaseFinish(state);
  }
}

/** `finish` once it holds the run's finish (above). */
async function finishHeld(loopRun: LoopRun, args: AnyRecord): Promise<string> {
  const { inbox, state } = loopRun;
  const summary = String(args.summary ?? "").trim();
  if (!summary) return FINISH_WORDS.needsSummary;
  const finishing = await inbox.finishing().catch(() => false);
  const userEnds = finishing || (await userQuoted(inbox, args.user_asked));
  const land = yes(args.land, true);
  const victory = yes(args.victory, false) && !finishing;
  if (land && !userEnds) {
    const check = await checkIntegration(loopRun, "finish");
    if (!check.ok && !check.unchecked) return FINISH_WORDS.unhealthy(check);
  }
  if (state.finish || closeUnderWay(state)) return FINISH_WORDS.underWay;
  state.finish = { summary, land, victory, at: Date.now() };
  const landed = await loopRun.closeTheLoopRun({
    land,
    because: "the lead finished the run",
    summary,
    victory,
    ...(pastItsCap(loopRun) ? { ended: StopWhy.Time } : {}),
  });
  return landed.ok
    ? FINISH_WORDS.closed(state.integrationHead, String(landed.line ?? ""))
    : FINISH_WORDS.closedUnlanded(landed.reason ?? null);
}

/** Whether a finish comes once the run's hours are spent, against the run's own clock. */
function pastItsCap(loopRun: LoopRun): boolean {
  const cap = loopRun.clock?.softDeadline ?? loopRun.softDeadline;
  return Number.isFinite(cap) && Date.now() >= cap;
}

// ── the close ──

/** How a close goes: see `closeTheLoopRun`. */
export interface CloseOptions {
  land?: boolean;
  because?: string | ((landed: AnyRecord) => string) | null;
  summary?: string | null;
  victory?: boolean;
  /** A lost provider paused the run: it lands nothing, and says so. */
  paused?: boolean;
  /** Why the run stops short of its goal, for its result card. */
  ended?: StopWhy;
}

/**
 * ONE close. Both roads out of a run end here — the lead's `finish` and the harness's clock — and
 * they end the same way: the workers stop (their copies' work kept on the run's refs), the head the
 * worktree stands on is checked, and it lands only when it passes its health check. A Stop before or
 * during the close lands nothing. A run closes once (close-latch.ts).
 */
export function closeTheLoopRun(loopRun: LoopRun, options: CloseOptions): Promise<AnyRecord> {
  return latchClose(loopRun.state, () => closeOnce(loopRun, options));
}

/** The close itself (`closeTheLoopRun`). */
async function closeOnce(loopRun: LoopRun, options: CloseOptions): Promise<AnyRecord> {
  const { land = true, because = null, summary = null, victory = false, paused = false, ended } = options;
  const { ctx, report, run } = loopRun;
  if (ended) loopRun.state.endedWhy = ended;
  await closeRunPool(run.runId);
  let landed: AnyRecord;
  if (ctx.cancelled) landed = notLanded(STOPPED_BY_USER, NotLandedReason.Stopped);
  else if (paused) landed = notLanded(PAUSED_UNLANDED, NotLandedReason.Paused);
  else if (!land) landed = notLanded("land=no", NotLandedReason.NotAsked);
  else landed = await landWhatRuns(loopRun);
  report.victory = victory === true && landed.ok === true;
  if (summary !== null) report.summary = summary;
  if (landed.why === NotLandedReason.Stopped) report.stoppedBecause = STOPPED_BY_USER;
  else if (typeof because === "function") report.stoppedBecause = because(landed);
  else if (because) report.stoppedBecause = because;
  await loopRun.closeRun(landed);
  return landed;
}

/** The close's own health check of the head, and the landing it earns. */
async function landWhatRuns(loopRun: LoopRun): Promise<AnyRecord> {
  const { baseCommit, ctx, state } = loopRun;
  const last = await loopRun.syncHead();
  const dirty = await gitAt(ctx, loopRun.integrationWorktree, GIT.status).catch(() => "");
  if ((!last || last === baseCommit) && !dirty) return notLanded(NOTHING_BEYOND_THE_START, NotLandedReason.NothingNew);
  const committed = await commitLeadWork(loopRun);
  if (committed) return notLanded(FINISH_WORDS.finalCommit(committed), NotLandedReason.FinalCommitFailed);
  const head = state.integrationHead;
  const known = state.healthByHead.get(head);
  const check = known ?? (await checkIntegration(loopRun, "close"));
  if (ctx.cancelled) return notLanded(STOPPED_BY_USER, NotLandedReason.Stopped);
  if (check.ok) return loopRun.landIntegration(true);
  await loopRun.decision(
    `the integration branch ${shortSha(head ?? "")} failed its health check at the close (${check.problems.join("; ")}) — kept unlanded on ${loopRun.integrationRef}`,
    "this build failed its health check at the end, so it was not made live — you can still open and play it",
  );
  return notLanded(FINISH_WORDS.doesNotRun(check), NotLandedReason.DoesNotRun);
}

/**
 * What is uncommitted in the game folder as the landing meets it: each path, and whether the folder
 * is held — something staged or unmerged, or a merge of its own under way. Git merges into no held folder.
 */
async function gameFolderChanges(loopRun: LoopRun): Promise<{ paths: string[]; held: boolean }> {
  const { ctx, run } = loopRun;
  const label = `director:${run.runId}:land-status`;
  const at = { project: run.project };
  const status = await gitAt(ctx, at, GIT.status, { label }).catch(() => "");
  const lines = status.split("\n").filter((line) => line.trim());
  let merging = false;
  try {
    merging = (await gitAt(ctx, at, GIT.catFileExists("MERGE_HEAD", ""), { label })).trim() === "yes";
  } catch {}
  return {
    paths: lines.map(changedPath),
    held: merging || lines.some((line) => line[0] !== " " && line[0] !== "?"),
  };
}

/** What this run can honestly claim about the head it landed: that it passed its health check. */
export function landingClaim(loopRun: LoopRun, head: string | null | undefined) {
  return landingWords({ healthPassed: loopRun.state.healthByHead.get(head)?.ok === true });
}

/**
 * Land the integrated build in the game folder: one `--no-ff` merge, aborted on a conflict, never
 * forced. A conflict or uncommitted changes there leave the build on its ref, and the close says why.
 */
export async function landIntegration(loopRun: LoopRun, land: boolean): Promise<AnyRecord> {
  const { baseCommit, ctx, integrationRef, projectDir, report, run, state } = loopRun;
  if (!land) return notLanded("land=no", NotLandedReason.NotAsked);
  await loopRun.syncHead();
  if (!isCommit(state.integrationHead) || state.integrationHead === baseCommit)
    return notLanded(NOTHING_BEYOND_THE_START, NotLandedReason.NothingNew);
  const nested = await nestedRefusal(loopRun);
  if (nested) return nested;
  const changed = await gameFolderChanges(loopRun);
  if (changed.held)
    return notLanded(FINISH_WORDS.uncommitted(changed.paths, integrationRef), NotLandedReason.UncommittedChanges);
  const merge = await mergeNoFf(ctx, { project: run.project }, state.integrationHead, {
    message: `Loop ${run.runId}: integrated build`,
    label: `director:${run.runId}:land`,
    listConflicts: true,
  });
  if (!merge.ok) {
    if (!merge.conflicts.length && refusedOver(changed.paths, merge.error))
      return notLanded(FINISH_WORDS.uncommitted(changed.paths, integrationRef), NotLandedReason.UncommittedChanges);
    return notLanded(FINISH_WORDS.conflict(merge.error), NotLandedReason.CouldNotLand);
  }
  report.landed = true;
  report.deliveredHead = await headOf(ctx, projectDir).catch(() => null);
  report.integrationHead = state.integrationHead;
  await loopRun.reloadLive();
  if (changed.paths.length) loopRun.note(FINISH_WORDS.leftInGame(changed.paths));
  return {
    ok: true,
    ...landingClaim(loopRun, state.integrationHead),
    ...(changed.paths.length ? { leftInGame: changed.paths } : {}),
  };
}

/**
 * A repository of the user's own inside the game folder, which the build holds as files while the
 * folder itself still holds it as a pointer. Landing that would touch somebody else's version
 * history, so it is the user's own button (the outcome card), never the run's.
 */
async function nestedRefusal(loopRun: LoopRun): Promise<AnyRecord | null> {
  const { ctx, projectDir } = loopRun;
  const pointers = await gitlinks(ctx, projectDir, "HEAD", { timeoutMs: GIT_TIMEOUT_MS.slow }).catch(() => []);
  if (!pointers.length) return null;
  const stillPointers = await unversionedNested((command) => loopRun.nestedGit(command), pointers);
  const carried = pointers.filter((rel) => !stillPointers.includes(rel));
  if (!carried.length) return null;
  return notLanded(FINISH_WORDS.nestedCarried(carried), NotLandedReason.NestedNotVersioned);
}

/** One line the result card can read: what happened to the build. */
function landingResult(landed: AnyRecord): AnyRecord {
  const line = landed.line ?? (landed.ok ? "made live" : "nothing was made live");
  return { ...landed, verified: false, how: landed.how ?? LandingHow.NotLanded, line };
}

/**
 * How the run ended, in its journal and report: paused or done. A run whose landing the user's Stop
 * refused, or one a lost provider cut short before a finish, is paused: Resume picks it up at its
 * integration head (kept reachable by the ref).
 */
export function endedAs(loopRun: LoopRun, landed: AnyRecord): void {
  const { journal, report, state } = loopRun;
  const paused = landed.why === NotLandedReason.Stopped || (!state.finish && Boolean(state.limit));
  journal.phase = paused ? JournalPhase.Paused : JournalPhase.Done;
  if (report.failure) report.executionStatus = ExecutionStatus.Failed;
  else report.executionStatus = paused ? ExecutionStatus.Paused : ExecutionStatus.Completed;
}

/** The close on the run's thread (`run_finished`, and `autopilot_paused` for a pause) and in its folder. */
async function announceClose(loopRun: LoopRun): Promise<void> {
  const { ctx, journal, report, run, threadId } = loopRun;
  const paused = journal.phase === JournalPhase.Paused;
  const pause = {
    type: EventKind.Custom,
    event_type: RunEvent.AutopilotPaused,
    payload: { runId: run.runId, project: run.project },
  };
  await appendClose(ctx, threadId, [
    { type: EventKind.Custom, event_type: RunEvent.RunFinished, payload: report },
    ...(paused ? [pause] : []),
  ]).catch(() => {});
  await writeRunArtifact(ctx, run.runId, "report.json", report);
}

/** A run's close, written to its thread — tried again when the log refuses it. Throws the last refusal. */
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

/** The provider loss that paused the run, as its close reports it. */
function reportedLimit(limit: AnyRecord): AnyRecord {
  return {
    kind: limit.kind,
    message: String(limit.message ?? "").slice(0, CLIP_REASON),
    retryAfterMs: limit.retryAfterMs ?? null,
    ...(typeof limit.at === "number" ? { at: limit.at } : {}),
  };
}

/** The run's close: its report and journal, its verdict, and its record on the thread. Once. */
export async function closeRun(loopRun: LoopRun, landed: AnyRecord): Promise<void> {
  const { baseCommit, integrationRef, journal, report, state } = loopRun;
  if (state.finished) return;
  state.finished = true;
  report.integrationHead = state.integrationHead;
  report.baseCommit = baseCommit;
  report.integrationRef = integrationRef;
  report.notes = [...(report.notes ?? []), ...(journal.director.notes ?? [])];
  report.landingResult = landingResult(landed);
  await loopRun.recordVerdict({
    pass: VerdictPass.Close,
    head: state.integrationHead,
    kept: landed.ok === true,
    rule: landed.ok ? VerdictRule.Landed : VerdictRule.NotLanded,
    landingLine: report.landingResult.line,
    notLanded: landed.why ?? null,
  });
  if (state.limit) report.limit = reportedLimit(state.limit);
  report.finishedAt = new Date().toISOString();
  endedAs(loopRun, landed);
  journal.director.integrationHead = state.integrationHead;
  await loopRun.protectHead(state.integrationHead);
  await loopRun.saveJournal();
  await announceClose(loopRun);
}
