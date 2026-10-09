/**
 * THE LOOK PHASE, a measurement and not a tour: eight ~45° yaw steps with a capture at each, a short
 * forward leg, a second sweep. A soak alone can keep the player inside a few units of ground at
 * uncorrelated headings, and the judge then cannot see what exists past them.
 *
 * CLOSED LOOP. The camera is read before and after every step and the achieved yaw recorded;
 * `reached` is whether any sweep turned the heading past `MIN_LOOK_YAW_DEG`. The input is synthetic
 * pointer deltas on the lock element (else the largest canvas, as a drag), because a CDP move is
 * viewport-bounded and its return trip yaws straight back. When those move nothing the real mouse's
 * ±200 px wobble is tried and recorded as the fallback; a page with no mouse records that it had none.
 * With no readable camera at all `reached` is `null`.
 *
 * THREE EXCLUSIONS, each closing a named false pass: its frames are out of the exposure sample
 * (`selectExposureFrames`), it never touches an input burst (it has no access to one), and it ends
 * with a settle and a series pull, so the soak's start sample postdates every sweep. It takes no RNG.
 */
import { SECOND_MS } from "../../../../src/shared/duration.ts";
import type { LoggedFrame } from "../frame-log.ts";
import type { CameraSample } from "../instrument.ts";
import type { LookTarget } from "../start-control.ts";
import { headingStepDeg, headingSweepDeg, MIN_LOOK_YAW_DEG } from "../verdicts.ts";
import { headingOf } from "./camera.ts";
import type { ProbeMouse } from "./full-context.ts";
import type { VerbSend } from "./verbs.ts";

/** One yaw step: ~44° at the vendored FollowCamera's default aim sensitivity; the camera says what it did. */
export const LOOK_STEP_PX = 336;
export const LOOK_EVENTS_PER_STEP = 8;
export const LOOK_STEPS = 8;
/** The pause between a step's events, so a per-frame delta reader sees several. */
export const LOOK_EVENT_MS = 40;
/** How long a step settles before the camera is read: ~3x the FollowCamera's smooth time. */
export const LOOK_SETTLE_MS = 350;
/** The CDP fallback's wobble about the viewport centre, and its steps per leg. */
export const LOOK_CDP_WOBBLE_PX = 200;
export const LOOK_CDP_STEPS = 8;
/** The forward leg between the two sweeps, and the pauses around it and at the end. */
export const LOOK_FORWARD_KEY = "KeyW";
export const LOOK_FORWARD_HOLD_MS = 1.5 * SECOND_MS;
export const LOOK_FORWARD_SETTLE_MS = 300;
export const LOOK_END_SETTLE_MS = 600;

/** Which mechanism delivered look input. */
export const LookMechanism = {
  Synthetic: "synthetic",
  Cdp: "cdp",
} as const;
export type LookMechanism = (typeof LookMechanism)[keyof typeof LookMechanism];

/** Where a synthetic dispatch landed, as `dispatchLookDeltasInPage` answers it. */
export const LookTargetKind = {
  Lock: "lock",
  Canvas: "canvas",
  None: "none",
} as const satisfies Record<string, LookTarget>;

/** One step as measured. */
export interface LookStep {
  sweep: number;
  step: number;
  mechanism: LookMechanism;
  dxPx: number;
  events: number;
  target: LookTarget | null;
  headingBeforeDeg: number | null;
  headingAfterDeg: number | null;
  achievedDeg: number | null;
  frame: string | null;
}

/** What the look phase measured. */
export interface LookMeasurement {
  ran: boolean;
  steps: LookStep[];
  sweeps: Array<{ sweep: number; mechanism: LookMechanism; sweepDeg: number | null; steps: number }>;
  fallback: { tried: boolean; sweepDeg: number | null; reached: boolean | null; heldButton: boolean } | null;
  forwardLeg: { key: string; sent: boolean; heldMs: number; refusedWhy: string | null } | null;
  reached: boolean | null;
  deliveredBy: LookMechanism | null;
  framesCaptured: number;
  /** PAGE-clock ms of the last sampler reading when the phase ended: the soak starts after it. */
  endedPageMs: number | null;
  note: string;
}

/** What the look phase needs from the browser. */
export interface LookDeps {
  viewport: { width: number; height: number };
  /** One synthetic pointermove + mousemove pair on the lock element, else the largest canvas. */
  dispatch: (
    dx: number,
    dy: number,
    drag: { offsetX: number; offsetY: number; phase: "start" | "move" | "end" },
  ) => Promise<{ target: LookTarget; dispatched: number } | null>;
  /** The real mouse, when the page has one; without it there is no fallback to try. */
  mouse: ProbeMouse | null;
  readCamera: () => Promise<CameraSample | null>;
  capture: (label: string) => Promise<LoggedFrame | null>;
  /** A key through the focus guard. */
  press: (key: string, holdMs: number) => Promise<VerbSend>;
  sleep: (ms: number) => Promise<void>;
  pullSeries: () => Promise<unknown>;
  lastSamplePageT: () => number | null;
  log: (event: string, detail?: unknown) => void;
}

/** A look phase that did not run, and why. */
export function skippedLook(why: string): LookMeasurement {
  return {
    ran: false,
    steps: [],
    sweeps: [],
    fallback: null,
    forwardLeg: null,
    reached: null,
    deliveredBy: null,
    framesCaptured: 0,
    endedPageMs: null,
    note: `skipped: ${why}`,
  };
}

interface LookRun {
  deps: LookDeps;
  steps: LookStep[];
  anyHeading: boolean;
  frames: number;
}

const heading = async (run: LookRun) => headingOf(await run.deps.readCamera());
const centre = (deps: LookDeps) => ({
  x: Math.floor(deps.viewport.width / 2),
  y: Math.floor(deps.viewport.height / 2),
});

/** Which part of a step's drag an event is. */
function eventPhase(i: number): "start" | "move" | "end" {
  if (i === 0) return "start";
  return i === LOOK_EVENTS_PER_STEP - 1 ? "end" : "move";
}

/**
 * A game that never took a pointer lock reads look input from a DRAG, so a CDP leg on one holds the
 * button. Decided from what the page already answered, and it fails closed: before any step has
 * reported, nothing is pressed.
 */
async function pressForDrag(run: LookRun): Promise<boolean> {
  const sawLock = run.steps.some((s) => s.target === LookTargetKind.Lock);
  const sawCanvas = run.steps.some((s) => s.target === LookTargetKind.Canvas);
  if (sawLock || !sawCanvas || !run.deps.mouse) return false;
  await run.deps.mouse.down();
  return true;
}

/** The input half of a synthetic step: a drag inside one step, the coordinate advancing every event. */
async function syntheticStep(run: LookRun): Promise<{ events: number; target: LookTarget | null; dxPx: number }> {
  const per = Math.round(LOOK_STEP_PX / LOOK_EVENTS_PER_STEP);
  let events = 0;
  let target: LookTarget | null = null;
  for (let i = 0; i < LOOK_EVENTS_PER_STEP; i++) {
    const answered = await run.deps.dispatch(per, 0, { offsetX: per * (i + 1), offsetY: 0, phase: eventPhase(i) });
    if (answered) {
      events += answered.dispatched;
      target = answered.target;
    }
    await run.deps.sleep(LOOK_EVENT_MS);
  }
  return { events, target, dxPx: per * LOOK_EVENTS_PER_STEP };
}

/** The input half of a CDP step: one leg out from the centre, as a drag on a game with no lock. */
async function cdpStep(run: LookRun, sign: number): Promise<{ events: number; target: null; dxPx: number }> {
  const mouse = run.deps.mouse;
  if (!mouse) return { events: 0, target: null, dxPx: 0 };
  const c = centre(run.deps);
  await mouse.move(c.x, c.y, 1);
  const held = await pressForDrag(run);
  const ok = await mouse.move(c.x + sign * LOOK_CDP_WOBBLE_PX, c.y, LOOK_CDP_STEPS);
  if (held) await mouse.up();
  return { events: ok ? LOOK_CDP_STEPS : 0, target: null, dxPx: sign * LOOK_CDP_WOBBLE_PX };
}

async function oneStep(run: LookRun, sweep: number, step: number, mechanism: LookMechanism): Promise<LookStep> {
  const before = await heading(run);
  // CDP legs alternate, since the cursor cannot leave the viewport; synthetic steps all turn one way.
  const sign = step % 2 ? 1 : -1;
  const input = mechanism === LookMechanism.Cdp ? await cdpStep(run, sign) : await syntheticStep(run);
  await run.deps.sleep(LOOK_SETTLE_MS);
  const after = await heading(run);
  if (before !== null || after !== null) run.anyHeading = true;
  const shot = await run.deps.capture(`sweep${sweep}-step${step}`);
  if (shot) run.frames++;
  const achievedDeg = before !== null && after !== null ? headingStepDeg(before, after) : null;
  const rec: LookStep = {
    sweep,
    step,
    mechanism,
    ...input,
    headingBeforeDeg: before,
    headingAfterDeg: after,
    achievedDeg,
    frame: shot?.record.file ?? null,
  };
  run.steps.push(rec);
  run.deps.log("look.step", rec);
  return rec;
}

async function runSweep(run: LookRun, sweep: number, mechanism: LookMechanism, out: LookMeasurement) {
  const list: LookStep[] = [];
  for (let i = 1; i <= LOOK_STEPS; i++) list.push(await oneStep(run, sweep, i, mechanism));
  const sweepDeg = headingSweepDeg(list.flatMap((s) => [s.headingBeforeDeg, s.headingAfterDeg]));
  out.sweeps.push({ sweep, mechanism, sweepDeg, steps: list.length });
  run.deps.log("look.sweep", { sweep, mechanism, sweepDeg });
  return sweepDeg;
}

/** The CDP ±200 px wobble, one continuous press across both legs on a game that never locked. */
async function cdpFallback(run: LookRun): Promise<NonNullable<LookMeasurement["fallback"]>> {
  const mouse = run.deps.mouse;
  if (!mouse) return { tried: false, sweepDeg: null, reached: null, heldButton: false };
  const c = centre(run.deps);
  const before = await heading(run);
  await mouse.move(c.x, c.y, 1);
  const held = await pressForDrag(run);
  await mouse.move(c.x + LOOK_CDP_WOBBLE_PX, c.y, LOOK_CDP_STEPS);
  await run.deps.sleep(LOOK_SETTLE_MS);
  const mid = await heading(run);
  await mouse.move(c.x - LOOK_CDP_WOBBLE_PX, c.y, LOOK_CDP_STEPS * 2);
  await run.deps.sleep(LOOK_SETTLE_MS);
  const after = await heading(run);
  if (held) await mouse.up();
  await mouse.move(c.x, c.y, LOOK_CDP_STEPS);
  if (before !== null || mid !== null || after !== null) run.anyHeading = true;
  const sweepDeg = headingSweepDeg([before, mid, after]);
  const reached = sweepDeg === null ? null : sweepDeg > MIN_LOOK_YAW_DEG;
  const fallback = { tried: true, sweepDeg, reached, heldButton: held };
  run.deps.log("look.fallback", fallback);
  return fallback;
}

/** The forward leg between the sweeps, through the focus guard like every other key. */
async function forwardLeg(run: LookRun): Promise<NonNullable<LookMeasurement["forwardLeg"]>> {
  const sent = await run.deps.press(LOOK_FORWARD_KEY, LOOK_FORWARD_HOLD_MS);
  await run.deps.sleep(LOOK_FORWARD_SETTLE_MS);
  return {
    key: LOOK_FORWARD_KEY,
    sent: sent.sent,
    heldMs: sent.sent ? LOOK_FORWARD_HOLD_MS : 0,
    refusedWhy: sent.reason,
  };
}

const past = (deg: number | null) => deg !== null && deg > MIN_LOOK_YAW_DEG;
const degrees = (deg: number | null | undefined) =>
  deg === null || deg === undefined ? "no reading" : `${deg.toFixed(1)}°`;

/** The phase's one sentence. */
export function lookNote(
  m: Pick<LookMeasurement, "sweeps" | "fallback" | "deliveredBy" | "steps">,
  anyHeading: boolean,
) {
  const s1 = degrees(m.sweeps[0]?.sweepDeg);
  const s2 = degrees(m.sweeps[1]?.sweepDeg);
  if (!anyHeading) {
    return "No camera heading could be read at any step, so whether the look input reached the game is unmeasured; the frames were still captured.";
  }
  if (m.deliveredBy === LookMechanism.Synthetic) {
    return `The synthetic pointermove/mousemove deltas turned the camera (sweep 1: ${s1}, sweep 2: ${s2}).`;
  }
  const held = m.fallback?.heldButton ? ", sent as a drag with the button held" : "";
  if (m.deliveredBy === LookMechanism.Cdp) {
    return `The synthetic events moved nothing (sweep 1: ${s1}); the CDP ±${LOOK_CDP_WOBBLE_PX}px wobble${held} did (${degrees(m.fallback?.sweepDeg)}), and sweep 2 used it (${s2}).`;
  }
  const dragShaped =
    m.steps.some((s) => s.target === LookTargetKind.Canvas) && !m.steps.some((s) => s.target === LookTargetKind.Lock);
  const drags = dragShaped ? "The game never took a pointer lock, so the synthetic steps went out as drags. " : "";
  const fallback = m.fallback?.tried
    ? `the CDP wobble (${degrees(m.fallback.sweepDeg)})`
    : "a CDP wobble (the page has no mouse to send one)";
  return `${drags}Neither the synthetic events (sweep 1: ${s1}, sweep 2: ${s2}) nor ${fallback} turned the heading past ${MIN_LOOK_YAW_DEG}°: the look input did not reach the game, and the frames under this phase are one heading throughout.`;
}

/** Run the look phase. */
export async function lookPhase(deps: LookDeps): Promise<LookMeasurement> {
  const run: LookRun = { deps, steps: [], anyHeading: false, frames: 0 };
  const out: LookMeasurement = { ...skippedLook(""), ran: true, steps: run.steps };
  const s1 = await runSweep(run, 1, LookMechanism.Synthetic, out);
  if (past(s1)) out.deliveredBy = LookMechanism.Synthetic;
  let mechanism: LookMechanism = LookMechanism.Synthetic;
  if (out.deliveredBy === null) {
    out.fallback = await cdpFallback(run);
    if (out.fallback.reached) {
      out.deliveredBy = LookMechanism.Cdp;
      mechanism = LookMechanism.Cdp;
    }
  }
  out.forwardLeg = await forwardLeg(run);
  const s2 = await runSweep(run, 2, mechanism, out);
  if (out.deliveredBy === null && past(s2)) out.deliveredBy = mechanism;
  // Settle, then pull: the soak reads its start from the newest sample, after every sweep diff.
  await deps.sleep(LOOK_END_SETTLE_MS);
  await deps.pullSeries();
  out.endedPageMs = deps.lastSamplePageT();
  out.reached = run.anyHeading ? out.deliveredBy !== null : null;
  out.framesCaptured = run.frames;
  out.note = lookNote(out, run.anyHeading);
  return out;
}
