/**
 * The M3 full prober (§8.2, D8): the quick probe's boot, idle baseline, entrance and input bursts,
 * then directions, acknowledgement, a late second look for a start control, the interact verb, the
 * look sweep, the seeded 300 s soak and the phone pass, and every `ProbeRow`. Same machine-wide lock
 * (Rule 11), same renderer fallback and detection, same guards, same frame rules (Rule 18) as the
 * quick probe, whose phases it reuses.
 *
 * QUICK OR FULL IS A TYPE. `FullProbeResult` says `quick: false` and carries the soak it ran;
 * `ProbeResult` is the union a grading pipeline holds, `promotable` is the one question `baseline
 * promote` and `check` ask of it, and `rowProbeOf` writes either into the ledger's `RowProbe`. A
 * quick grade can never be promoted: its `soakMs` pin is `unavailable(probe-skipped)`.
 */
import fs from "node:fs";
import path from "node:path";
import {
  consoleErrors,
  detectedMode,
  type PlayObservation,
  playPhases,
  postEntranceBaseline,
  type ProbeRun,
  type QuickProbeDeps,
  SUMMARY_BYTES,
  takeSnapshot,
  withProbePage,
  writeSummaries,
} from "../grade/quick-probe.ts";
import type { EvidenceRefs, FullProbeOptions, FullProbeResult, ProbeResult, RunFullProbe } from "../grade/types.ts";
import { type RowProbe, unavailable } from "../ledger/types.ts";
import { EntranceVia, ProbePhase, ServedVia, UnavailableReason } from "../vocabulary.ts";
import { fpsMedian, type ProbeBrowser, rafOf } from "./driver.ts";
import { probeInitSource } from "./instrument.ts";
import { AckVerb, verbPhase } from "./phases/ack.ts";
import type { PageBaseline } from "./phases/baseline.ts";
import { bootPhase, bootVerdict } from "./phases/boot.ts";
import { DRAG_SHARE_X, DRAG_SHARE_Y, directionsPhase, dragBurst } from "./phases/directions.ts";
import { entrancePhase } from "./phases/entrance.ts";
import {
  clickVerb,
  directionsDeps,
  dragDeps,
  dragVerb,
  keyVerb,
  lookDeps,
  soakDeps,
  verbDeps,
} from "./phases/full-deps.ts";
import { captureSentence, type FullPhaseContext, fullContext, logEvent, pull } from "./phases/full-context.ts";
import { type FullObservation, fullRows } from "./phases/full-rows.ts";
import { FPS_FLOOR, SPEC_ERROR_WINDOW_MS } from "./phases/health.ts";
import { INTERACT_KEYS } from "./phases/interact.ts";
import { lookPhase, skippedLook } from "./phases/look.ts";
import { mobileNotRun, mobilePhase } from "./phases/mobile.ts";
import { lastSampleT } from "./phases/series.ts";
import { DEFAULT_SOAK_SEED, soakPhase, soakWindows, SPEC_SOAK_MS } from "./phases/soak.ts";
import { stillnessThreshold } from "./phases/soak-rows.ts";
import { ACK_WINDOW_MS } from "./phases/verbs.ts";
import { budgetSentence, isUnresponsive, planSoak, probeBudgetMs, shouldRunLook } from "./probe-budget.ts";
import { evidenceFrames, type QuickObservation, quickGameplay } from "./quick-rows.ts";
import { PROBER_VERSION } from "./types.ts";
import { cameraSanity, gateFor, isScored, type JudgeEvidenceVerdict, judgeEvidence } from "./verdicts.ts";

/** What the probe writes inside the evidence folder, beside the quick probe's console and network summaries. */
export const FULL_SCORECARD_FILE = "full-probe.json";
export const TIMELINE_FILE = "timeline.jsonl";

// The full prober's contract types live beside the quick probe's in `grade/types.ts`.
export type { FullProbeOptions, FullProbeResult, ProbeResult, RunFullProbe } from "../grade/types.ts";

/** Whether a result came from the full prober. */
export function isFullProbe(result: ProbeResult): result is FullProbeResult {
  return result.quick === false;
}

/** Whether a grade may feed `baseline promote` and `check`: never a quick one. */
export function promotable(result: ProbeResult): boolean {
  return isFullProbe(result);
}

/** The ledger's `probe` section for either result; a quick grade's soak pin is `unavailable`. */
export function rowProbeOf(result: ProbeResult): RowProbe {
  return {
    l1Gate: result.l1Gate,
    l2Gate: result.l2Gate,
    rows: result.rows,
    firstRenderMs: result.firstRenderMs,
    fpsMedian: result.fpsMedian,
    consoleErrors: result.consoleErrors,
    soakMs: isFullProbe(result) ? result.soakMs : unavailable(UnavailableReason.ProbeSkipped),
    quick: result.quick,
  };
}

/** What the probe reads from outside; each has a real default (the quick probe's own). */
export type FullProbeDeps = QuickProbeDeps;

/** One full probe's run: the quick probe's run state, the full phases' context, the browser and the URL (for the phone pass). */
interface FullRun extends ProbeRun {
  ctx: FullPhaseContext;
  browser: ProbeBrowser;
  url: string;
}

/** What the quick probe's phases observed on the way in. */
type Entered = PlayObservation;

/** The quick probe's way in (idle baseline, entrance, post-entrance baseline, input bursts), logged. */
async function enter(run: FullRun): Promise<Entered> {
  const entered = await playPhases(run);
  const { verdict } = entered.entrance;
  logEvent(run.ctx, ProbePhase.Entrance, "entrance", { by: verdict.by, confirmed: verdict.confirmed });
  return entered;
}

/**
 * A SECOND CHANCE AT THE ENTRANCE, on the same signals, after directions and ack: a loading screen
 * can outlast the first search, and a finished game must not score 1/8 behind a start card the
 * first look ran too early to see. When it gets the probe in, the post-entrance baseline is taken now
 * and applies from the interact phase on.
 */
async function lateEntrance(run: FullRun, entered: Entered): Promise<void> {
  if (entered.entrance.verdict.confirmed) return;
  const late = await entrancePhase(run.ctx, entered.idleMoved);
  if (late.snapshot) run.snapshots.push(late.snapshot);
  logEvent(run.ctx, ProbePhase.Ack, "entrance.late", { by: late.verdict.by, confirmed: late.verdict.confirmed });
  if (!late.verdict.confirmed) return;
  entered.entrance = late;
  entered.postBaseline = await postEntranceBaseline(run.ctx, entered.cursor);
}

/** The baseline current now: the post-entrance one when usable, else the pre-gesture one. */
function currentBaseline(entered: Entered): PageBaseline {
  return entered.postBaseline?.usable ? entered.postBaseline : entered.preBaseline;
}

/** Directions, drag, ack, the late entrance and interact: every phase between the bursts and the look. */
async function verbsAndDirections(run: FullRun, entered: Entered, ackWindowMs: number) {
  const { ctx } = run;
  const directions = await directionsPhase(directionsDeps(ctx));
  const drag = await dragBurst(dragDeps(ctx));
  await takeSnapshot(run);
  const { width, height } = ctx.page.viewport();
  const baseline = () => currentBaseline(entered);
  const ack = await verbPhase(verbDeps(ctx, ProbePhase.Ack, baseline, ackWindowMs), [
    { verb: AckVerb.Space, send: keyVerb(ctx, ProbePhase.Ack, AckVerb.Space) },
    { verb: AckVerb.MouseLeft, send: clickVerb(ctx, ProbePhase.Ack) },
    {
      verb: AckVerb.MouseDrag,
      send: dragVerb(ctx, ProbePhase.Ack, Math.floor(width * DRAG_SHARE_X), Math.floor(height * DRAG_SHARE_Y)),
    },
  ]);
  await takeSnapshot(run);
  await lateEntrance(run, entered);
  const interact = await verbPhase(
    verbDeps(ctx, ProbePhase.Interact, baseline, ackWindowMs),
    INTERACT_KEYS.map((key) => ({ verb: key, send: keyVerb(ctx, ProbePhase.Interact, key) })),
  );
  return { directions, drag, ack, interact };
}

/** The resolved knobs of one run. */
interface Plan {
  soakMs: number;
  seed: number;
  budgetMs: number;
  ackWindowMs: number;
}

/** The look sweep (when the budget holds it), then the seeded soak (shortened when it must be). */
async function lookAndSoak(run: FullRun, entered: Entered, plan: Plan) {
  const { ctx } = run;
  const budgetLeft = () => plan.budgetMs - ctx.page.elapsedMs();
  const lookPlan = shouldRunLook(budgetLeft(), plan.soakMs, isUnresponsive(ctx.resp));
  const look = lookPlan.run ? await lookPhase(lookDeps(ctx)) : skippedLook(lookPlan.why ?? "the budget");
  const soakPlan = planSoak(budgetLeft(), plan.soakMs);
  const soakBaseline = currentBaseline(entered);
  await pull(ctx);
  const fromT = lastSampleT(ctx.series) ?? 0;
  logEvent(ctx, ProbePhase.Soak, "soak.start", { soakMs: soakPlan.soakMs, shortenedByMs: soakPlan.shortenedByMs });
  const soak = await soakPhase(soakDeps(ctx), soakPlan.soakMs, plan.seed);
  await pull(ctx);
  const toT = lastSampleT(ctx.series) ?? fromT;
  const windows = soakWindows(ctx.series.samples, fromT, toT, stillnessThreshold(soakBaseline));
  await takeSnapshot(run);
  return { look, soak, soakBaseline, windows, shortenedWhy: soakPlan.why };
}

/** The quick probe's observation of this run, for the quick rows and the evidence rule. */
function quickObservation(
  run: FullRun,
  boot: Awaited<ReturnType<typeof bootPhase>>,
  entered: Entered | null,
  options: FullProbeOptions,
): QuickObservation {
  const events = run.ctx.page.events();
  return {
    gameOrigin: run.ctx.gameOrigin,
    endAtMs: run.ctx.page.elapsedMs(),
    noErrorsMs: SPEC_ERROR_WINDOW_MS,
    firstRenderMs: boot.firstRenderMs,
    boot: bootVerdict(boot, events, options.firstDrawTimeoutMs),
    events,
    snapshots: run.snapshots,
    entrance: entered?.entrance ?? null,
    idleMoved: entered?.idleMoved ?? null,
    stillMoved: entered?.stillMoved ?? null,
    preBaseline: entered?.preBaseline ?? null,
    postBaseline: entered?.postBaseline ?? null,
    bursts: entered?.bursts ?? [],
    frames: run.ctx.frames.frames,
  };
}

/** Run every phase and return what the rows read. */
async function observe(run: FullRun, options: FullProbeOptions, plan: Plan): Promise<FullObservation> {
  const { ctx } = run;
  const boot = await bootPhase(ctx, options.firstDrawTimeoutMs);
  const entered = boot.firstRenderMs === null ? null : await enter(run);
  const verbs = entered ? await verbsAndDirections(run, entered, plan.ackWindowMs) : null;
  const later = entered ? await lookAndSoak(run, entered, plan) : null;
  await takeSnapshot(run);
  const mobile =
    options.mobile === false
      ? mobileNotRun("the phone pass was disabled for this probe")
      : await mobilePhase(run.browser, run.url, probeInitSource(), {
          sleep: ctx.sleep,
          evidenceDir: options.evidenceDir,
        });
  return {
    quick: quickObservation(run, boot, entered, options),
    rendererMode: detectedMode(run),
    directions: verbs?.directions ?? null,
    drag: verbs?.drag ?? null,
    ack: verbs?.ack ?? null,
    interact: verbs?.interact ?? null,
    look: later?.look ?? skippedLook("the canvas never drew"),
    soak: later?.soak ?? null,
    soakWindows: later?.windows ?? { windows: 0, withChange: 0, resolutionMs: null },
    soakBaseline: later?.soakBaseline ?? null,
    soakShortenedWhy: later?.shortenedWhy ?? null,
    samples: ctx.series.samples,
    rms: ctx.series.rms,
    mobile,
    darkPhaseReview: options.darkPhaseReview,
    ackWindowMs: plan.ackWindowMs,
    fpsFloor: options.fpsFloor ?? FPS_FLOOR,
  };
}

/** Whether the witnessed frames are worth judging; the page→run offset is unmeasured, so the phase clause decides. */
function evidenceVerdict(o: FullObservation, gameplay: { reached: boolean; why: string }): JudgeEvidenceVerdict {
  const last = o.quick.snapshots.length ? o.quick.snapshots[o.quick.snapshots.length - 1] : null;
  return judgeEvidence({
    frames: o.quick.frames.map((f) => f.record),
    firstRafPageMs: rafOf(last).firstT,
    firstRenderRunMs: o.quick.firstRenderMs,
    pageToRunOffsetMs: null,
    gameplayReached: gameplay,
    cameraSanity: cameraSanity(last?.camera?.samples ?? []),
  });
}

/** What the run's own machinery changed, for a reader of the scorecard: never a verdict on the game. */
function runNotes(run: FullRun, plan: Plan, o: FullObservation): string[] {
  const { ctx } = run;
  const soakPlannedMs = o.soak?.plannedMs ?? 0;
  const budget = budgetSentence({
    budgetMs: plan.budgetMs,
    usedMs: ctx.page.elapsedMs(),
    soakPlannedMs,
    soakShortenedByMs: o.soak ? plan.soakMs - soakPlannedMs : 0,
    lookSkippedWhy: o.look.ran || !o.soak ? null : o.look.note,
    responsiveness: { reads: ctx.resp.reads, timeouts: ctx.resp.timeouts, unresponsiveAtMs: ctx.resp.unresponsiveAtMs },
  });
  const pointer =
    ctx.pointerSkips > 0
      ? `${ctx.pointerSkips} hover move(s) were skipped: the page has no mouse, so drags went out as synthetic pointer events.`
      : null;
  return [captureSentence(ctx), budget, pointer].filter((n): n is string => n !== null);
}

/** Rows, gates, evidence and the scorecard written beside them. */
function fullResult(run: FullRun, options: FullProbeOptions, plan: Plan, o: FullObservation): FullProbeResult {
  const checks = fullRows(o);
  const gate = gateFor(checks);
  const dir = options.evidenceDir;
  const summaries = writeSummaries(dir, o.quick.events);
  const frames = evidenceFrames(o.quick);
  const evidence: EvidenceRefs = {
    gameOrigin: o.quick.gameOrigin,
    frames: frames.map((f) => f.ref),
    consoleSummaryPath: summaries.console,
    networkSummaryPath: summaries.network,
    videoPath: null,
    summaryBytes: SUMMARY_BYTES,
  };
  const last = o.quick.snapshots.length ? o.quick.snapshots[o.quick.snapshots.length - 1] : null;
  const scorecardPath = path.join(dir, FULL_SCORECARD_FILE);
  const result: FullProbeResult = {
    rows: Object.fromEntries(checks.map((c) => [c.id, c.result])),
    l1Gate: gate.l1,
    l2Gate: gate.l2,
    l3Gate: gate.l3,
    scored: isScored(gate),
    entrance: o.quick.entrance?.verdict.by ?? EntranceVia.None,
    firstRenderMs: o.quick.firstRenderMs,
    fpsMedian: fpsMedian(rafOf(last)),
    consoleErrors: consoleErrors(o.quick.events),
    rendererMode: o.rendererMode,
    servedVia: options.servedVia ?? ServedVia.AsIs,
    evidence,
    proberVersion: PROBER_VERSION,
    noErrorsMs: SPEC_ERROR_WINDOW_MS,
    quick: false,
    checks,
    soakMs: plan.soakMs,
    soakRanMs: o.soak?.ranMs ?? null,
    seed: plan.seed,
    judgeEvidence: evidenceVerdict(o, quickGameplay(o.quick)),
    scorecardPath,
  };
  const notes = runNotes(run, plan, o);
  const scorecard = {
    ...result,
    look: o.look,
    soak: o.soak,
    mobile: o.mobile,
    frames: o.quick.frames.map((f) => f.record),
    notes,
  };
  fs.writeFileSync(scorecardPath, `${JSON.stringify(scorecard, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, TIMELINE_FILE), run.ctx.timeline.map((t) => JSON.stringify(t)).join("\n"));
  return result;
}

/** Run the full probe over a served page (`RunFullProbe`). */
export async function runFullProbe(
  url: string,
  options: FullProbeOptions,
  deps: FullProbeDeps = {},
): Promise<FullProbeResult> {
  const soakMs = options.soakMs ?? SPEC_SOAK_MS;
  const plan: Plan = {
    soakMs,
    seed: options.seed ?? DEFAULT_SOAK_SEED,
    budgetMs: options.budgetMs ?? probeBudgetMs(soakMs),
    ackWindowMs: options.ackWindowMs ?? ACK_WINDOW_MS,
  };
  return withProbePage(url, options, deps, async ({ browser, launched, ctx }) => {
    const run: FullRun = { ctx: fullContext(ctx), browser, launched, snapshots: [], url };
    return fullResult(run, options, plan, await observe(run, options, plan));
  });
}

/** Contract binding for the campaign. */
export const fullProbe: RunFullProbe = (url, options) => runFullProbe(url, options);
